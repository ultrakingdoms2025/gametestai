import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import {
  ensureProgressSchema,
  readFirstReports,
  FIRST_REPORT_CLAIM,
  FIRST_REPORT_CAVEAT,
} from './progressLedger';
import { ensureCustomServerSchema } from './customServers';

/**
 * FIRST TO REPORT — and the whole test suite is really about that one word.
 *
 * `created_at` is the moment a row reached Postgres. `ProgressSync` batches, so
 * the gap between finding a relic and reporting it is unbounded and invisible
 * from the server's side. The query below therefore answers "who synced this
 * first", and the ONLY interesting way for this feature to fail is for somebody
 * — a route, a UI string, a future refactor — to start calling that "first to
 * find". It would read better, it would be more exciting, and it would be a
 * lie that a player who played offline for a week pays for.
 *
 * So the honesty is gated as hard as the SQL is: the claim string, the caveat,
 * the fact that the caveat travels in the response body rather than living in
 * whichever client renders it, and the absence of the stronger phrasing
 * anywhere in the source.
 *
 * The database half runs against `aether_test`, ...0019 player block.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

function read(...parts: string[]): string {
  return readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');
}

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

/* ====================================================================== */
/* 1. The claim, and the claim it is not                                   */
/* ====================================================================== */

describe('the claim this feature is allowed to make', () => {
  it('says REPORT, never FIND', () => {
    expect(FIRST_REPORT_CLAIM).toBe('first to report');
    expect(FIRST_REPORT_CLAIM).not.toMatch(/find|found|discover/i);
  });

  it('names the exact way an honest player can lose a claim they earned', () => {
    /* A caveat that says "approximate" teaches nothing. This one has to name
     * the mechanism — batching — and the person it costs. */
    expect(FIRST_REPORT_CAVEAT).toMatch(/SYNC/);
    expect(FIRST_REPORT_CAVEAT).toMatch(/batch/i);
    expect(FIRST_REPORT_CAVEAT).toMatch(/offline/i);
    expect(FIRST_REPORT_CAVEAT).toMatch(/not necessarily the first to make it/i);
  });

  it('writes the limitation into the source, beside the query', () => {
    const src = read('site', 'lib', 'progressLedger.ts');
    expect(src).toMatch(/created_at` is the moment the row reached Postgres/);
    expect(src).toMatch(/ProgressSync` batches/);
    /* And it says why there is no fix, so nobody spends a day looking for one:
     * a client-declared discovery time is a clock the player owns, which this
     * file refuses everywhere else. */
    expect(src).toMatch(/clock the player controls|clock the player owns/);
  });

  it('never claims first-to-find anywhere on the path to a player', () => {
    /* Swept rather than spot-checked, because the phrasing is the defect: the
     * stronger sentence is the one somebody writes by accident when they are
     * writing a nice UI string, and it is one word away from the true one. */
    for (const file of [
      ['site', 'lib', 'progressLedger.ts'],
      ['site', 'app', 'api', 'game', 'progress', 'route.ts'],
    ]) {
      /* COMMENTS STRIPPED FIRST, the same discipline `hud-source-checks.mjs`
       * records for the same reason: both of these files carry a note saying
       * why the stronger claim is refused, and a scan that read prose would
       * fail on the explanation of its own rule. It failed exactly that way the
       * first time it ran. What is scanned is the shipped STRING LITERALS —
       * the text a player can actually be shown. */
      const src = read(...file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      const literals = src.match(/'[^'\n]*'|"[^"\n]*"|`[^`\n]*`/g) ?? [];
      for (const lit of literals) {
        expect(lit, `${file.join('/')} ships a first-to-find claim: ${lit}`)
          .not.toMatch(/first to (find|discover)|first finder|discovered (it )?first/i);
      }
    }
  });
});

describe('the carrier', () => {
  it('puts the caveat in the response body, not only in a comment', () => {
    /* A client that shows these rows has the sentence in hand. One that invents
     * "first to find" had to ignore a field literally named `caveat`. */
    const route = read('site', 'app', 'api', 'game', 'progress', 'route.ts');
    /* COUNTED, not merely matched. There are two returns on this path — the
     * default-mode one and the real one — and a `toMatch` is satisfied by
     * either, so it would pass while the caveat had been dropped from the
     * response a player actually gets. Found by breaking exactly that. */
    expect((route.match(/caveat: FIRST_REPORT_CAVEAT/g) ?? []).length).toBe(2);
    expect((route.match(/claim: FIRST_REPORT_CLAIM/g) ?? []).length).toBe(2);
  });

  it('resolves the server from the stored selection, never from the query', () => {
    const route = read('site', 'app', 'api', 'game', 'progress', 'route.ts');
    expect(route).toMatch(/currentServerId\(client, playerId\)/);
    expect(route).not.toMatch(/searchParams\.get\('server'\)/);
  });

  it('keeps the plain GET byte-identical when no firsts are asked for', () => {
    /* Additive. `ProgressSync` calls this route on every boot and must see
     * exactly the shape it always saw. */
    const route = read('site', 'app', 'api', 'game', 'progress', 'route.ts');
    expect(route).toMatch(/if \(!firstsKind\) \{\s*\n\s*return NextResponse\.json\(\{ state: await readProgress\(client, playerId\) \}\);/);
  });

  it('keeps another member\'s internal id off the wire', () => {
    const route = read('site', 'app', 'api', 'game', 'progress', 'route.ts');
    expect(route).toMatch(/\.\.\.\(r\.self \? \{ playerId: r\.playerId \} : \{\}\)/);
  });

  it('indexes the query it added', () => {
    /* A `MIN(created_at)` per item key across every member's relics is a sort
     * of the whole table without this. */
    const src = read('site', 'lib', 'progressLedger.ts');
    expect(src).toMatch(
      /CREATE INDEX IF NOT EXISTS player_progress_items_first_idx\s*\n?\s*ON player_progress_items \(kind, scope, item_key, created_at\)/
    );
  });
});

/* ====================================================================== */
/* 2. Against a real Postgres                                              */
/* ====================================================================== */

/* The ...0019 block. Every lower block is claimed by another suite and vitest
 * runs these files in parallel against one database — see the note in
 * `serverTimeBoards.test.ts` for what a collision looks like from the outside. */
const OWNER = '00000000-0000-4000-8000-000000000019';
const EARLY = '00000000-0000-4000-8000-000000190001';
const LATE = '00000000-0000-4000-8000-000000190002';
const OUTSIDER = '00000000-0000-4000-8000-000000190003';
/** In `server_members` with `state = 'requested'`. A row, but not a member. */
const PENDING = '00000000-0000-4000-8000-000000190004';
const PLAYERS = [OWNER, EARLY, LATE, OUTSIDER, PENDING];
const SERVER = 'fr-test-server';
const SCOPE = 'fr-test-world';

suite('first reports (integration)', () => {
  let db: Client;

  const give = async (playerId: string, key: string, at: string) =>
    db.query(
      `INSERT INTO player_progress_items (player_id, kind, scope, item_key, created_at)
       VALUES ($1, 'relic', $2, $3, $4::timestamptz)
       ON CONFLICT (player_id, kind, scope, item_key) DO UPDATE SET created_at = EXCLUDED.created_at`,
      [playerId, SCOPE, key, at]
    );

  const firsts = (playerId = EARLY) =>
    readFirstReports(db, { serverId: SERVER, kind: 'relic', scope: SCOPE, playerId });

  beforeAll(async () => {
    db = new Client({ connectionString: URL_!, ssl: { rejectUnauthorized: false } });
    await db.connect();
    const which = await db.query('SELECT current_database() AS db');
    if (which.rows[0].db !== 'aether_test') {
      throw new Error(`refusing to run against "${which.rows[0].db}" — expected aether_test`);
    }
    await db.query(`
      CREATE TABLE IF NOT EXISTS players (
        id             TEXT PRIMARY KEY,
        handle         TEXT,
        credit_balance INTEGER NOT NULL DEFAULT 0,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS handle TEXT`);
    await ensureProgressSchema(db);
    await ensureCustomServerSchema(db);
  });

  afterAll(async () => {
    if (!db) return;
    await db.query('DELETE FROM player_progress_items WHERE scope = $1', [SCOPE]);
    await db.query('DELETE FROM server_members WHERE server_id = $1', [SERVER]);
    await db.query('DELETE FROM custom_servers WHERE id = $1', [SERVER]);
    await db.end();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM player_progress_items WHERE scope = $1', [SCOPE]);
    for (const id of PLAYERS) {
      await db.query(
        `INSERT INTO players (id, handle, credit_balance) VALUES ($1, $2, 0)
         ON CONFLICT (id) DO UPDATE SET handle = EXCLUDED.handle`,
        /* Suite-prefixed: `players.handle` is UNIQUE in this database and the
         * suites run in parallel. See the same note in serverTimeBoards. */
        [id, `fr-${id.slice(-6)}`]
      );
    }
    await db.query(
      `INSERT INTO custom_servers (id, owner_player_id, name, slug)
       VALUES ($1, $2, 'Firsts test', $1) ON CONFLICT (id) DO NOTHING`,
      [SERVER, OWNER]
    );
    await db.query('DELETE FROM server_members WHERE server_id = $1', [SERVER]);
    for (const [id, state] of [[OWNER, 'approved'], [EARLY, 'approved'], [LATE, 'approved'], [PENDING, 'requested']] as const) {
      await db.query(
        `INSERT INTO server_members (server_id, player_id, state) VALUES ($1, $2, $3)`,
        [SERVER, id, state]
      );
    }
  });

  it('answers the earliest report for each item, with who made it', async () => {
    await give(EARLY, 'relic-a', '2026-08-01T10:00:00Z');
    await give(LATE, 'relic-a', '2026-08-02T10:00:00Z');
    await give(LATE, 'relic-b', '2026-08-01T09:00:00Z');

    const rows = await firsts();
    expect(rows.map((r) => [r.itemKey, r.playerId])).toEqual([
      ['relic-a', EARLY],
      ['relic-b', LATE],
    ]);
    expect(rows[0].handle).toBe(`fr-${EARLY.slice(-6)}`);
    expect(rows[0].self).toBe(true);
    expect(rows[1].self).toBe(false);
  });

  it('never lets a non-member take a claim, however early', async () => {
    await give(OUTSIDER, 'relic-a', '2020-01-01T00:00:00Z');
    await give(EARLY, 'relic-a', '2026-08-01T10:00:00Z');
    const rows = await firsts();
    expect(rows.map((r) => r.playerId)).toEqual([EARLY]);
  });

  /* NOT PROVEN FAILABLE, and said so rather than left to look stronger than it
   * is. Removing `i.player_id` from the ORDER BY leaves this test passing:
   * Postgres happens to return the same row for this fixture on every run, so
   * the assertion cannot tell a GUARANTEED answer from an incidental one. What
   * the tie-break buys is that the answer stays the same as the table grows and
   * the plan changes, which no test at this size can observe. Kept because it
   * pins the documented winner; not counted as a gate on the ORDER BY. */
  it('breaks a same-timestamp tie the same way on every run', async () => {
    /* `NOW()` is the TRANSACTION start in Postgres, so a batch insert stamps
     * every row identically — two players syncing inside one transaction is
     * not exotic, it is the normal case for one player's whole payload, and
     * two players can genuinely land on the same instant. Without the
     * `player_id` tie-break the winner is whichever row the plan reached
     * first, which can differ between runs. */
    const SAME = '2026-08-01T10:00:00Z';
    await give(LATE, 'relic-a', SAME);
    await give(EARLY, 'relic-a', SAME);
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) seen.add((await firsts())[0].playerId);
    expect(seen.size).toBe(1);
    // The lower id wins, deterministically — `ORDER BY … , i.player_id`.
    expect([...seen][0]).toBe([EARLY, LATE].sort()[0]);
  });

  it('never lets a member who has only ASKED to join take a claim', async () => {
    /* `requested` is a row in `server_members`. A query that tested for the row
     * rather than the state would hand a private server's first-finds to
     * anyone who had ever knocked on the door.
     *
     * This case did not exist until the membership check was broken on purpose
     * to see whether anything noticed, and nothing did: the only non-member in
     * the suite was a player with no row at all, whom the JOIN excludes however
     * the state test is written. */
    await give(PENDING, 'relic-a', '2020-01-01T00:00:00Z');
    await give(EARLY, 'relic-a', '2026-08-01T10:00:00Z');
    const rows = await firsts();
    expect(rows.map((r) => r.playerId)).toEqual([EARLY]);
  });

  it('refuses a kind that is not a set, and one it has never heard of', async () => {
    /* The rows are SEEDED under both refused kinds, which is the whole point.
     * `player_progress_items.kind` is free text, so a value kind can have rows
     * in this table — and without the seeding, both assertions passed whether
     * the guard was there or not, because the query found nothing either way.
     *
     * `race` is a VALUE kind: its real home is `player_progress_values`, and a
     * first-report over it would be reading a table that is not where the data
     * lives. `nonsense` is not a kind at all. Both are refused at the door,
     * where it is visible, rather than answered with a misleading empty list. */
    await give(EARLY, 'relic-a', '2026-08-01T10:00:00Z');
    await db.query(
      `INSERT INTO player_progress_items (player_id, kind, scope, item_key, created_at)
       VALUES ($1, 'race', $2, 'vellum/standard', NOW()), ($1, 'nonsense', $2, 'x', NOW())
       ON CONFLICT DO NOTHING`,
      [EARLY, SCOPE]
    );
    expect(await readFirstReports(db, { serverId: SERVER, kind: 'race', scope: SCOPE, playerId: EARLY })).toEqual([]);
    expect(await readFirstReports(db, { serverId: SERVER, kind: 'nonsense', scope: SCOPE, playerId: EARLY })).toEqual([]);
    // ...and the set kind beside them still answers, so this is a refusal and
    // not a query that stopped working.
    expect((await firsts()).map((r) => r.itemKey)).toEqual(['relic-a']);
  });

  it('refuses an empty server rather than answering across every player', async () => {
    /* NOT PROVEN FAILABLE either, and for a reason worth writing down: an empty
     * `serverId` joins no rows in `server_members`, so the answer is [] whether
     * the early return is there or not. The guard is defence-in-depth against a
     * future query shape where an empty scope WOULD match, and this test asserts
     * the behaviour rather than the guard. Deleting the guard does not fail it.
     *
     * The failure the pair closes: a missing scope becoming a global
     * first-finder board that nobody asked for and no membership check guards. */
    await give(EARLY, 'relic-a', '2026-08-01T10:00:00Z');
    expect(await readFirstReports(db, { serverId: '', kind: 'relic', scope: SCOPE, playerId: EARLY })).toEqual([]);
    expect(await readFirstReports(db, { serverId: '   ', kind: 'relic', scope: SCOPE, playerId: EARLY })).toEqual([]);
  });

  it('reports the sync time it actually holds, so the caveat is checkable', async () => {
    await give(EARLY, 'relic-a', '2026-08-01T10:00:00Z');
    const rows = await firsts();
    expect(Date.parse(rows[0].reportedAt)).toBe(Date.parse('2026-08-01T10:00:00Z'));
  });
});
