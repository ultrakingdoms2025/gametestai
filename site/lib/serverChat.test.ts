import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { makeFakeDb, flat } from './fakeDb';
import { CHAT_BODY_MAX, cleanChatBody, sendChat, readChat } from './serverChat';
import { ensureCustomServerSchema, applyMembershipAction, touchPresence, listActivePlayers } from './customServers';

/**
 * Scoped chat (7e): direct messages to selected active players, and a
 * server-wide shout.
 *
 * ── Why polled HTTP and not sockets ───────────────────────────────────────
 *
 * D2 removed the shared live instance, so there is no process holding a
 * connection for two players to be attached to. Vercel functions do not hold one
 * either. Polling against Postgres is therefore not a compromise here; it is the
 * only delivery mechanism the architecture leaves, and it is sufficient because
 * chat is the only thing being delivered.
 *
 * ── The rule this file has to hold ────────────────────────────────────────
 *
 * A direct message is readable by exactly two people. The visibility test is a
 * WHERE clause on the read and there is no second path to a message row, so
 * "who can see this" has one answer written once.
 *
 * Membership is re-checked on every send and every read rather than trusted from
 * a caller. An owner can remove a member between one poll and the next, and a
 * removed member who keeps polling must stop receiving — which they do, because
 * the read itself asks.
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

const SERVER = 'server-chat-test';

describe('chat message hygiene', () => {
  it('trims, collapses control characters and bounds the length', () => {
    expect(cleanChatBody('  hello  ')).toBe('hello');
    expect(cleanChatBody('a\u0000b\u0007c'), 'a control byte becomes a space, never nothing').toBe('a b c');
    expect(cleanChatBody('a\nb')).toBe('a b');
    expect(cleanChatBody('x'.repeat(CHAT_BODY_MAX + 50))).toHaveLength(CHAT_BODY_MAX);
    expect(cleanChatBody('   ')).toBe('');
  });

  it('refuses an empty message before it reaches the database', async () => {
    const db = makeFakeDb();
    const out = await sendChat(db, SERVER, 'p1', { body: '   ' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('empty');
    expect(db.log).toHaveLength(0);
  });

  it('asks about membership before it writes anything', async () => {
    /* The fake answers nothing, so every membership lookup comes back empty and
     * the send must refuse. A send that wrote first and checked afterwards would
     * leave the row behind, which is the failure this asserts against. */
    const db = makeFakeDb();
    const out = await sendChat(db, SERVER, 'p1', { body: 'hello' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('forbidden');
    expect(db.matching('INSERT INTO server_chat_messages')).toHaveLength(0);
  });

  it('reads with the recipient test in the query, not in a filter afterwards', () => {
    const src = readFileSync(join(here, 'serverChat.ts'), 'utf8').replace(/\r\n/g, '\n');
    /* The READ query, not the rate-limit count that also selects from this
     * table. Picked out by the clause only the read has. */
    const select = (src.match(/SELECT[\s\S]*?FROM server_chat_messages[\s\S]*?`/g) ?? [])
      .find((q) => q.includes('ORDER BY')) ?? '';
    expect(flat(select)).toContain('to_player_id IS NULL');
    expect(flat(select)).toContain('server_id = $');
    /* Postgres does the visibility test. A row a caller may not see is never
     * returned to JavaScript, so no later `.filter()` can be the thing that was
     * forgotten. */
    expect(src).not.toMatch(/rows\s*\.\s*filter/);
  });
});

/* ---------------------------------------------------------------------- */
/* Against a real Postgres                                                 */
/* ---------------------------------------------------------------------- */

/** ...0009. See serverContent.test.ts for the register of claimed ids. */
const OWNER = '00000000-0000-4000-8000-000000000009';
const MEMBER = '00000000-0000-4000-8000-000000090001';
const OUTSIDER = '00000000-0000-4000-8000-000000090002';
const PLAYERS = [OWNER, MEMBER, OUTSIDER];

suite('scoped chat (integration)', () => {
  let db: Client;

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
        [id, `chat-${id.slice(-4)}`]
      );
    }
    await ensureCustomServerSchema(db);
  });

  const reset = async () => {
    await db.query(`DELETE FROM server_chat_messages WHERE server_id = $1`, [SERVER]);
    await db.query(`DELETE FROM server_presence WHERE server_id = $1`, [SERVER]);
    await db.query(`DELETE FROM server_members WHERE server_id = $1`, [SERVER]);
    await db.query(`DELETE FROM custom_servers WHERE id = $1`, [SERVER]);
    await db.query(
      `INSERT INTO custom_servers (id, owner_player_id, name, slug)
       VALUES ($1, $2, 'Chat test', 'server-chat-test')`,
      [SERVER, OWNER]
    );
    await db.query(
      `INSERT INTO server_members (server_id, player_id, state) VALUES ($1, $2, 'approved')`,
      [SERVER, OWNER]
    );
    await applyMembershipAction(db, {
      serverId: SERVER, subjectPlayerId: MEMBER, actorPlayerId: OWNER, action: 'invite',
    });
    await applyMembershipAction(db, {
      serverId: SERVER, subjectPlayerId: MEMBER, actorPlayerId: OWNER, action: 'approve',
    });
  };

  beforeEach(reset);

  afterAll(async () => {
    if (!db) return;
    await db.query(`DELETE FROM server_chat_messages WHERE server_id = $1`, [SERVER]);
    await db.query(`DELETE FROM server_presence WHERE server_id = $1`, [SERVER]);
    await db.query(`DELETE FROM custom_servers WHERE id = $1`, [SERVER]);
    await db.end();
  });

  const bodies = async (playerId: string) =>
    (await readChat(db, SERVER, playerId, { sinceId: 0, limit: 50 })).messages.map((m) => m.body);

  it('a shout reaches every approved member', async () => {
    const sent = await sendChat(db, SERVER, OWNER, { body: 'yard open' });
    expect(sent.ok).toBe(true);
    expect(await bodies(MEMBER)).toEqual(['yard open']);
    expect(await bodies(OWNER)).toEqual(['yard open']);
  });

  it('a direct message reaches exactly two people', async () => {
    await sendChat(db, SERVER, OWNER, { body: 'just you', toPlayerId: MEMBER });
    expect(await bodies(OWNER)).toEqual(['just you']);
    expect(await bodies(MEMBER)).toEqual(['just you']);

    /* A third approved member sees nothing of it. Added here rather than in the
     * fixture so the shout tests above are not accidentally asserting on a
     * quieter server than they think. */
    await applyMembershipAction(db, {
      serverId: SERVER, subjectPlayerId: OUTSIDER, actorPlayerId: OWNER, action: 'invite',
    });
    await applyMembershipAction(db, {
      serverId: SERVER, subjectPlayerId: OUTSIDER, actorPlayerId: OWNER, action: 'approve',
    });
    expect(await bodies(OUTSIDER)).toEqual([]);
  });

  it('a non-member can neither send nor read', async () => {
    await sendChat(db, SERVER, OWNER, { body: 'members only' });
    const out = await sendChat(db, SERVER, OUTSIDER, { body: 'let me in' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('forbidden');
    const read = await readChat(db, SERVER, OUTSIDER, { sinceId: 0, limit: 50 });
    expect(read.forbidden).toBe(true);
    expect(read.messages).toEqual([]);
  });

  it('a removed member stops receiving, without any message being deleted', async () => {
    await sendChat(db, SERVER, OWNER, { body: 'before' });
    expect(await bodies(MEMBER)).toEqual(['before']);

    await applyMembershipAction(db, {
      serverId: SERVER, subjectPlayerId: MEMBER, actorPlayerId: OWNER, action: 'remove',
    });
    const read = await readChat(db, SERVER, MEMBER, { sinceId: 0, limit: 50 });
    expect(read.forbidden).toBe(true);

    /* The owner's own history is intact: removal is an access change, not a
     * retraction of what was said. */
    expect(await bodies(OWNER)).toEqual(['before']);
  });

  it('refuses a direct message to somebody who is not in the server', async () => {
    const out = await sendChat(db, SERVER, OWNER, { body: 'psst', toPlayerId: OUTSIDER });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('no_recipient');
    expect(await bodies(OWNER)).toEqual([]);
  });

  it('polls forward from a cursor, so a client re-reads nothing', async () => {
    await sendChat(db, SERVER, OWNER, { body: 'one' });
    const first = await readChat(db, SERVER, MEMBER, { sinceId: 0, limit: 50 });
    expect(first.messages.map((m) => m.body)).toEqual(['one']);
    expect(first.cursor).toBeGreaterThan(0);

    const idle = await readChat(db, SERVER, MEMBER, { sinceId: first.cursor, limit: 50 });
    expect(idle.messages).toEqual([]);
    expect(idle.cursor).toBe(first.cursor);

    await sendChat(db, SERVER, MEMBER, { body: 'two' });
    const next = await readChat(db, SERVER, MEMBER, { sinceId: first.cursor, limit: 50 });
    expect(next.messages.map((m) => m.body)).toEqual(['two']);
  });

  it('names who is addressable right now, and only approved members', async () => {
    await touchPresence(db, SERVER, OWNER);
    await touchPresence(db, SERVER, MEMBER);
    await touchPresence(db, SERVER, OUTSIDER); // never approved
    const active = (await listActivePlayers(db, SERVER)).map((p) => p.playerId).sort();
    expect(active).toEqual([OWNER, MEMBER].sort());
  });
});
