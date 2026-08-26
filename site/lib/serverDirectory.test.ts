import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import {
  ensureCustomServerSchema,
  createServer,
  updateServer,
  applyMembershipAction,
  listServersDirectory,
  searchInvitablePlayers,
  touchPresence,
  MEMBER_SEARCH_LIMIT,
  MEMBER_SEARCH_MIN_QUERY,
  PRESENCE_WINDOW_SECONDS,
} from './customServers';
import { writeEntitlement } from './premium';

/**
 * The launch directory and the invite search, against a real Postgres.
 *
 * Both are COUNT/EXISTS shapes over live tables — exactly the kind of claim a
 * recording fake cannot settle — so this suite skips without a database, the
 * way `customServers.test.ts` does. The route-level guarantees (owner gate,
 * 401s, no email in the payload) are pinned without a database in
 * `serverRouteGuards.test.ts`.
 *
 * The database is SHARED with the other integration suites running in
 * parallel, so no assertion here counts the whole directory — every claim is
 * about this suite's own rows, found by id.
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

/** ...000a. See serverContent.test.ts for the register of claimed id blocks. */
const OWNER = '00000000-0000-4000-8000-00000000000a';
const APPROVED = '00000000-0000-4000-8000-0000000a0001';
const INVITED = '00000000-0000-4000-8000-0000000a0002';
const REQUESTED = '00000000-0000-4000-8000-0000000a0003';
const REMOVED = '00000000-0000-4000-8000-0000000a0004';
const STRANGER = '00000000-0000-4000-8000-0000000a0005';
/* A dozen more, for the LIMIT claim. */
const PACK = Array.from({ length: 12 }, (_, i) =>
  `00000000-0000-4000-8000-0000000a10${String(i + 1).padStart(2, '0')}`
);

const HANDLES: Record<string, string> = {
  [OWNER]: 'dirsearch-owner',
  [APPROVED]: 'dirsearch-approved',
  [INVITED]: 'dirsearch-invited',
  [REQUESTED]: 'dirsearch-requested',
  [REMOVED]: 'dirsearch-removed',
  [STRANGER]: 'dirsearch-stranger',
};
/* `zpack`, so the dozen sort AFTER the named actors: the roster-exclusion
 * test searches `dirsearch-` and reads the first page, and a pack that sorted
 * first would push `-removed` and `-stranger` off it. */
for (const [i, id] of PACK.entries()) HANDLES[id] = `dirsearch-zpack-${String(i + 1).padStart(2, '0')}`;

const PLAYERS = Object.keys(HANDLES);

suite('the launch directory and the invite search (integration)', () => {
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
         ON CONFLICT (id) DO UPDATE SET handle = EXCLUDED.handle`,
        [id, HANDLES[id]]
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
      playerId: OWNER, subscriptionId: 'sub_dir_test', customerId: 'cus_dir_test',
      status: 'active', currentPeriodEnd: null,
    });
    const made = await createServer(db, OWNER, { name: 'Directory Annexe' });
    if (!made.ok) throw new Error(`fixture server refused: ${made.reason}`);
    serverId = made.server.id;

    /* One member in each state, moved there through the real verbs. */
    const act = async (action: 'invite' | 'request' | 'approve' | 'reject', subject: string, actor: string) => {
      const out = await applyMembershipAction(db, {
        serverId, subjectPlayerId: subject, actorPlayerId: actor, action,
      });
      if (!out.ok) throw new Error(`fixture ${action} refused: ${out.reason}`);
    };
    await act('invite', APPROVED, OWNER);
    await act('request', APPROVED, APPROVED);   // accept → approved
    await act('invite', INVITED, OWNER);        // → invited
    await act('request', REQUESTED, REQUESTED); // → requested
    await act('request', REMOVED, REMOVED);
    await act('reject', REMOVED, OWNER);        // → removed
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.end();
  });

  const row = async (asPlayer: string) =>
    (await listServersDirectory(db, asPlayer)).find((r) => r.id === serverId);

  /* ------------------------------------------------------------------ */
  /* The directory                                                       */
  /* ------------------------------------------------------------------ */

  it('counts approved members only — invited, requested and removed are not members', async () => {
    const r = await row(STRANGER);
    expect(r).toBeDefined();
    expect(r!.members).toBe(2); // the owner and APPROVED
  });

  it('counts online from presence inside the window, approved members only', async () => {
    /* Inside the window, approved → counts. */
    await touchPresence(db, serverId, OWNER);
    /* Inside the window but NOT approved → must not count; a heartbeat is not
     * membership. */
    await touchPresence(db, serverId, INVITED);
    /* Approved but OUTSIDE the window → must not count; gone is gone. */
    await db.query(
      `INSERT INTO server_presence (server_id, player_id, last_seen)
       VALUES ($1, $2, NOW() - ($3 || ' seconds')::interval)
       ON CONFLICT (server_id, player_id) DO UPDATE SET last_seen = EXCLUDED.last_seen`,
      [serverId, APPROVED, String(PRESENCE_WINDOW_SECONDS + 60)]
    );

    const r = await row(STRANGER);
    expect(r!.online).toBe(1);
    expect(r!.members).toBe(2);

    /* And the moment the stale member heartbeats again, the count follows. */
    await touchPresence(db, serverId, APPROVED);
    expect((await row(STRANGER))!.online).toBe(2);
  });

  it('reports the caller their own standing, and a removed row as none', async () => {
    expect((await row(APPROVED))!.callerState).toBe('approved');
    expect((await row(INVITED))!.callerState).toBe('invited');
    expect((await row(REQUESTED))!.callerState).toBe('requested');
    expect((await row(STRANGER))!.callerState).toBeNull();
    /* `removed` reads as null: the one legal verb from `removed` is `request`,
     * which is the no-row verb, so the modal owes them the same button — and
     * nothing else about that history. */
    expect((await row(REMOVED))!.callerState).toBeNull();
    expect((await row(OWNER))!.callerState).toBe('approved');
  });

  it('does not list a suspended server — a dead door is not offered', async () => {
    await updateServer(db, serverId, { status: 'suspended' });
    for (const caller of [OWNER, APPROVED, STRANGER]) {
      expect(await row(caller)).toBeUndefined();
    }
  });

  /* ------------------------------------------------------------------ */
  /* The invite search                                                   */
  /* ------------------------------------------------------------------ */

  const handles = async (q: string) =>
    (await searchInvitablePlayers(db, serverId, q)).map((p) => p.handle);

  it('matches on handle, case-insensitively, anywhere in the name', async () => {
    expect(await handles('DIRSEARCH-STRAN')).toEqual(['dirsearch-stranger']);
    expect(await handles('rsearch-strang')).toEqual(['dirsearch-stranger']);
  });

  it('excludes the live roster, and keeps removed players invitable', async () => {
    const got = await searchInvitablePlayers(db, serverId, 'dirsearch-');
    const found = got.map((p) => p.handle);
    /* invited / requested / approved / the owner: inviting them is a no-op or
     * the approve button's job. */
    for (const excluded of ['dirsearch-owner', 'dirsearch-approved', 'dirsearch-invited', 'dirsearch-requested']) {
      expect(found, excluded).not.toContain(excluded);
    }
    /* `invite` from `removed` lands on `invited` in the transition table — a
     * search that hid them would strand a member ejected in error. */
    expect(found).toContain('dirsearch-removed');
    expect(found).toContain('dirsearch-stranger');
  });

  it('serves handles and player ids and NOTHING else — no email has a path out', async () => {
    const got = await searchInvitablePlayers(db, serverId, 'dirsearch-stranger');
    expect(got).toHaveLength(1);
    expect(Object.keys(got[0]).sort()).toEqual(['handle', 'playerId']);
    expect(got[0].playerId).toBe(STRANGER);
  });

  it('refuses a short query with silence, not with a broad answer', async () => {
    expect(await searchInvitablePlayers(db, serverId, 'd')).toEqual([]);
    expect(await searchInvitablePlayers(db, serverId, '  d  ')).toEqual([]);
    expect(MEMBER_SEARCH_MIN_QUERY).toBe(2);
  });

  it('is bounded: a page of candidates, never an export', async () => {
    const got = await searchInvitablePlayers(db, serverId, 'dirsearch-zpack');
    expect(got).toHaveLength(MEMBER_SEARCH_LIMIT); // 12 seeded, 10 served
  });

  it('treats LIKE wildcards as text, not as wildcards', async () => {
    /* Negative control first: the search does find things. */
    expect((await handles('dirsearch-stranger')).length).toBe(1);
    /* Unescaped, `dirsearch%` would match every handle this suite seeded and
     * `dirsearch_stranger` would match the stranger through the `_` wildcard.
     * Escaped, both are literals nobody's handle contains. */
    expect(await handles('dirsearch%')).toEqual([]);
    expect(await handles('dirsearch_stranger')).toEqual([]);
  });
});
