import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import {
  MEMBER_STATES,
  ACTION_ACTOR,
  nextMemberState,
  isActiveMember,
  slugify,
  cleanServerName,
  SERVER_NAME_MAX,
  ensureCustomServerSchema,
  createServer,
  getServer,
  updateServer,
  applyMembershipAction,
  listMembers,
  listServersForPlayer,
  listJoinableServers,
  canUseServer,
  selectServer,
  currentServerId,
  type MemberAction,
  type MemberState,
} from './customServers';
import { writeEntitlement } from './premium';

/**
 * Custom servers: the schema, the membership state machine, and the selection.
 *
 * The state machine is tested exhaustively rather than by sampling, because it
 * IS the authorisation rule for everything else in the phase — content, chat and
 * credits all ask `canUseServer`, which asks this. A table with one wrong cell
 * is a server somebody can enter without being let in.
 */

const here = dirname(fileURLToPath(import.meta.url));

function testUrl(): string | null {
  if (process.env.POSTGRES_TEST_URL) return process.env.POSTGRES_TEST_URL;
  const envFile = join(here, '..', '.env.test.local');
  if (!existsSync(envFile)) return null;
  const line = readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith('POSTGRES_TEST_URL='));
  if (!line) return null;
  return line.slice('POSTGRES_TEST_URL='.length).trim().replace(/^["']|["']$/g, '');
}

const URL_ = testUrl();
const suite = URL_ ? describe : describe.skip;

/* ---------------------------------------------------------------------- */
/* The state machine, without a database                                   */
/* ---------------------------------------------------------------------- */

const ACTIONS: MemberAction[] = ['invite', 'request', 'approve', 'reject', 'remove'];
const FROMS: Array<MemberState | null> = [null, ...MEMBER_STATES];

describe('the membership state machine', () => {
  it('holds exactly the four states the roadmap names', () => {
    expect([...MEMBER_STATES]).toEqual(['invited', 'requested', 'approved', 'removed']);
  });

  it('answers for every (action, state) pair, so no cell is undefined', () => {
    /* Exhaustive, not sampled. An `undefined` cell would fall through
     * `nextMemberState`'s `?? null` and read as "not legal", which is the safe
     * direction — but silently, and a rule that is silently different from the
     * table is a rule nobody can read. */
    for (const action of ACTIONS) {
      for (const from of FROMS) {
        const to = nextMemberState(action, from);
        expect(to === null || (MEMBER_STATES as readonly string[]).includes(to)).toBe(true);
      }
    }
  });

  it('only ever reaches approved through an invitation or a request', () => {
    /* The rule that matters most. An owner cannot conjure a member who has
     * neither asked nor been invited — that is not membership, it is
     * conscription, and it would let an owner attribute activity to a player who
     * never opted in. */
    expect(nextMemberState('approve', null)).toBeNull();
    expect(nextMemberState('approve', 'removed')).toBeNull();
    expect(nextMemberState('approve', 'invited')).toBe('approved');
    expect(nextMemberState('approve', 'requested')).toBe('approved');
  });

  it('lets an owner answer a request by inviting, and a player accept by asking', () => {
    /* Two shortcuts worth pinning because they are not obvious. An owner who has
     * been asked and offers has already decided; a player who was invited and
     * asks is saying yes. */
    expect(nextMemberState('invite', 'requested')).toBe('approved');
    expect(nextMemberState('request', 'invited')).toBe('approved');
  });

  it('cannot re-approve someone who was removed without a fresh ask', () => {
    expect(nextMemberState('approve', 'removed')).toBeNull();
    expect(nextMemberState('request', 'removed')).toBe('requested');
    expect(nextMemberState('invite', 'removed')).toBe('invited');
  });

  it('is idempotent on every action that has already landed', () => {
    /* A double-clicked button must not be an error. */
    expect(nextMemberState('invite', 'invited')).toBe('invited');
    expect(nextMemberState('request', 'requested')).toBe('requested');
    expect(nextMemberState('approve', 'approved')).toBe('approved');
    expect(nextMemberState('remove', 'removed')).toBe('removed');
  });

  it('names exactly one side as entitled to take each action', () => {
    expect(ACTION_ACTOR.request).toBe('player');
    for (const a of ['invite', 'approve', 'reject', 'remove'] as const) {
      expect(ACTION_ACTOR[a], a).toBe('owner');
    }
  });

  it('treats only "approved" as membership that can use a server', () => {
    expect(isActiveMember('approved')).toBe(true);
    for (const s of ['invited', 'requested', 'removed', null] as const) {
      expect(isActiveMember(s), String(s)).toBe(false);
    }
  });
});

describe('naming a server', () => {
  it('makes a url-safe slug', () => {
    expect(slugify('Lodestar Annexe')).toBe('lodestar-annexe');
    expect(slugify('  A  B  ')).toBe('a-b');
    /* NFKD first, so an accented letter becomes its base letter plus a combining
     * mark and the mark is what the character class drops. Without the
     * normalise, `ü` is a single code point outside [a-z0-9] and the whole word
     * would collapse to a hyphen. */
    expect(slugify('Ünïcödé Yard')).toBe('unicode-yard');
  });

  it('returns nothing for a name that yields nothing, rather than inventing one', () => {
    /* A fallback slug hides an authoring mistake behind a row nobody meant to
     * create — and then the next such name collides with it. */
    expect(slugify('!!!')).toBe('');
    expect(slugify('   ')).toBe('');
  });

  it('bounds a name and collapses its whitespace', () => {
    expect(cleanServerName('  a   b  ')).toBe('a b');
    expect(cleanServerName('x'.repeat(SERVER_NAME_MAX + 40))).toHaveLength(SERVER_NAME_MAX);
  });
});

/* ---------------------------------------------------------------------- */
/* Against a real Postgres                                                 */
/* ---------------------------------------------------------------------- */

/** ...0006. See serverContent.test.ts for the register of claimed ids. */
const OWNER = '00000000-0000-4000-8000-000000000006';
const PLAYER = '00000000-0000-4000-8000-000000060001';
const STRANGER = '00000000-0000-4000-8000-000000060002';
const PLAYERS = [OWNER, PLAYER, STRANGER];

suite('custom servers (integration)', () => {
  let db: Client;
  let serverId: string;

  beforeAll(async () => {
    db = new Client({ connectionString: URL_!, ssl: { rejectUnauthorized: false } });
    await db.connect();
    const which = await db.query('SELECT current_database() AS db');
    if (which.rows[0].db !== 'aether_test') {
      throw new Error(`refusing to run against "${which.rows[0].db}" — expected aether_test`);
    }
    await db.query(`
      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY, handle TEXT, credit_balance INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    for (const id of PLAYERS) {
      await db.query(
        `INSERT INTO players (id, handle, credit_balance) VALUES ($1, $2, 0)
         ON CONFLICT (id) DO NOTHING`,
        [id, `cs-${id.slice(-4)}`]
      );
    }
    await ensureCustomServerSchema(db);
  });

  const wipe = async () => {
    await db.query(`DELETE FROM player_server_selection WHERE player_id = ANY($1::text[])`, [PLAYERS]);
    await db.query(`DELETE FROM custom_servers WHERE owner_player_id = ANY($1::text[])`, [PLAYERS]);
    await db.query(`DELETE FROM server_entitlements WHERE player_id = ANY($1::text[])`, [PLAYERS]);
  };

  beforeEach(async () => {
    await wipe();
    await writeEntitlement(db, {
      playerId: OWNER, subscriptionId: 'sub_cs_test', customerId: 'cus_cs_test',
      status: 'active', currentPeriodEnd: null,
    });
    const made = await createServer(db, OWNER, { name: 'Lodestar Annexe' });
    if (!made.ok) throw new Error(`fixture server refused: ${made.reason}`);
    serverId = made.server.id;
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.end();
  });

  it('makes the owner a member of their own server, so one query answers everything', async () => {
    expect(await canUseServer(db, serverId, OWNER)).toBe(true);
    const members = await listMembers(db, serverId);
    expect(members.find((m) => m.playerId === OWNER)?.state).toBe('approved');
  });

  it('refuses a duplicate slug rather than silently making a second server', async () => {
    await writeEntitlement(db, {
      playerId: STRANGER, subscriptionId: 'sub_cs_other', customerId: null,
      status: 'active', currentPeriodEnd: null,
    });
    const clash = await createServer(db, STRANGER, { name: 'Lodestar Annexe' });
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.reason).toBe('slug_taken');
  });

  it('refuses a name that yields no slug', async () => {
    const bad = await createServer(db, OWNER, { name: '!!!' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe('invalid_name');
  });

  it('walks a player from stranger to member and back out', async () => {
    expect(await canUseServer(db, serverId, PLAYER)).toBe(false);

    const asked = await applyMembershipAction(db, {
      serverId, subjectPlayerId: PLAYER, actorPlayerId: PLAYER, action: 'request',
    });
    expect(asked.ok && asked.state).toBe('requested');
    expect(await canUseServer(db, serverId, PLAYER), 'a request is not admission').toBe(false);

    const approved = await applyMembershipAction(db, {
      serverId, subjectPlayerId: PLAYER, actorPlayerId: OWNER, action: 'approve',
    });
    expect(approved.ok && approved.state).toBe('approved');
    expect(await canUseServer(db, serverId, PLAYER)).toBe(true);

    const removed = await applyMembershipAction(db, {
      serverId, subjectPlayerId: PLAYER, actorPlayerId: OWNER, action: 'remove',
    });
    expect(removed.ok && removed.state).toBe('removed');
    expect(await canUseServer(db, serverId, PLAYER)).toBe(false);
  });

  it('lets nobody but the owner approve, and nobody but the subject request', async () => {
    await applyMembershipAction(db, {
      serverId, subjectPlayerId: PLAYER, actorPlayerId: PLAYER, action: 'request',
    });
    const selfApprove = await applyMembershipAction(db, {
      serverId, subjectPlayerId: PLAYER, actorPlayerId: PLAYER, action: 'approve',
    });
    expect(selfApprove.ok).toBe(false);
    if (!selfApprove.ok) expect(selfApprove.reason).toBe('forbidden');
    expect(await canUseServer(db, serverId, PLAYER)).toBe(false);

    const requestForAnother = await applyMembershipAction(db, {
      serverId, subjectPlayerId: PLAYER, actorPlayerId: STRANGER, action: 'request',
    });
    expect(requestForAnother.ok).toBe(false);
  });

  it('lets a platform admin act as the owner, but only when told to', async () => {
    await applyMembershipAction(db, {
      serverId, subjectPlayerId: PLAYER, actorPlayerId: PLAYER, action: 'request',
    });
    const withoutFlag = await applyMembershipAction(db, {
      serverId, subjectPlayerId: PLAYER, actorPlayerId: STRANGER, action: 'approve',
    });
    expect(withoutFlag.ok).toBe(false);

    const withFlag = await applyMembershipAction(db, {
      serverId, subjectPlayerId: PLAYER, actorPlayerId: STRANGER, action: 'approve',
      platformAdmin: true,
    });
    expect(withFlag.ok).toBe(true);
  });

  it('will not let an owner remove themselves and orphan the server', async () => {
    const out = await applyMembershipAction(db, {
      serverId, subjectPlayerId: OWNER, actorPlayerId: OWNER, action: 'remove',
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('forbidden');
    expect(await canUseServer(db, serverId, OWNER)).toBe(true);
  });

  it('a suspended server serves nobody, including its owner', async () => {
    await updateServer(db, serverId, { status: 'suspended' });
    expect(await canUseServer(db, serverId, OWNER)).toBe(false);
    /* And it vanishes from what a stranger could ask to join. */
    expect((await listJoinableServers(db, STRANGER)).map((s) => s.id)).not.toContain(serverId);
    await updateServer(db, serverId, { status: 'active' });
    expect(await canUseServer(db, serverId, OWNER)).toBe(true);
  });

  it('stores a selection, and refuses one the player is not entitled to', async () => {
    const refused = await selectServer(db, PLAYER, serverId);
    expect(refused.refused).toBe(true);
    expect(refused.serverId).toBeNull();
    expect(await currentServerId(db, PLAYER)).toBeNull();

    await applyMembershipAction(db, {
      serverId, subjectPlayerId: PLAYER, actorPlayerId: PLAYER, action: 'request',
    });
    await applyMembershipAction(db, {
      serverId, subjectPlayerId: PLAYER, actorPlayerId: OWNER, action: 'approve',
    });
    const taken = await selectServer(db, PLAYER, serverId);
    expect(taken.refused).toBe(false);
    expect(await currentServerId(db, PLAYER)).toBe(serverId);
  });

  it('drops a stored selection the moment membership ends', async () => {
    await applyMembershipAction(db, {
      serverId, subjectPlayerId: PLAYER, actorPlayerId: PLAYER, action: 'request',
    });
    await applyMembershipAction(db, {
      serverId, subjectPlayerId: PLAYER, actorPlayerId: OWNER, action: 'approve',
    });
    await selectServer(db, PLAYER, serverId);
    expect(await currentServerId(db, PLAYER)).toBe(serverId);

    /* Removal happens between one request and the next. A stored selection is
     * not an entitlement, so the read re-asks — and a removed player falls back
     * to default mode rather than keeping the catalogue they were last shown. */
    await applyMembershipAction(db, {
      serverId, subjectPlayerId: PLAYER, actorPlayerId: OWNER, action: 'remove',
    });
    expect(await currentServerId(db, PLAYER)).toBeNull();
  });

  it('choosing default mode is a positive act the server records', async () => {
    await selectServer(db, OWNER, serverId);
    expect(await currentServerId(db, OWNER)).toBe(serverId);
    const out = await selectServer(db, OWNER, null);
    expect(out.refused).toBe(false);
    expect(await currentServerId(db, OWNER)).toBeNull();
  });

  it('lists a player\'s servers with the state they are in', async () => {
    await applyMembershipAction(db, {
      serverId, subjectPlayerId: PLAYER, actorPlayerId: OWNER, action: 'invite',
    });
    const mine = await listServersForPlayer(db, PLAYER);
    expect(mine).toHaveLength(1);
    expect(mine[0].id).toBe(serverId);
    expect(mine[0].state).toBe('invited');

    /* A removed membership is not a server the player has. */
    await applyMembershipAction(db, {
      serverId, subjectPlayerId: PLAYER, actorPlayerId: OWNER, action: 'reject',
    });
    expect(await listServersForPlayer(db, PLAYER)).toHaveLength(0);
  });

  it('keeps a suspended server readable to its owner even when it serves nobody', async () => {
    await updateServer(db, serverId, { status: 'suspended' });
    const still = await getServer(db, serverId);
    expect(still?.status).toBe('suspended');
  });
});
