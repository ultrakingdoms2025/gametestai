import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { ensureProgressSchema, mergeProgress, readProgress, KINDS } from './progressLedger';

/**
 * The progress ledger, against a real Postgres.
 *
 * The properties that matter here are convergence properties, and they live in
 * constraints rather than in code: the union is `ON CONFLICT DO NOTHING` on a
 * UNIQUE index, and the numeric merge is `DO UPDATE SET value = LEAST(...)` on
 * the same one. A mock would assert only that I wrote down what I already
 * believed.
 *
 * The three that get their own tests are commutativity, idempotence and
 * never-subtracts, because those three together are what let this sync run with
 * NO DEVICE CLOCK. If any of them breaks, the fallback is last-write-wins on
 * clocks that disagree, which is the data loss this ledger exists to prevent.
 *
 * Same isolation as `creditLedger.test.ts`: `aether_test`, a SEPARATE database,
 * with `beforeAll` refusing to run anywhere else. Skips when POSTGRES_TEST_URL
 * is absent so CI stays green without a database.
 */

function testUrl(): string | null {
  if (process.env.POSTGRES_TEST_URL) return process.env.POSTGRES_TEST_URL;
  const here = dirname(fileURLToPath(import.meta.url));
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

/**
 * Fixed and obviously synthetic. Never a real player id.
 *
 * ...0004, and the number matters: vitest runs test FILES in parallel against
 * this one shared database. ...0001 is creditLedger's, ...0002 is
 * marketplacePurchase's, ...0003 is creditReport's. Borrowing an id already in
 * use makes this file's `beforeEach` reset another suite's fixture mid-run, and
 * the failures land over there rather than here.
 */
const PLAYER = '00000000-0000-4000-8000-000000000004';

suite('progressLedger (integration)', () => {
  let db: Client;

  const relics = (keys: string[], world = 'citadel') => ({
    items: [{ kind: 'relic', scope: world, keys }],
  });

  const found = async (world = 'citadel') =>
    (await readProgress(db, PLAYER)).items.relic?.[world] ?? [];

  beforeAll(async () => {
    db = new Client({ connectionString: URL_!, ssl: { rejectUnauthorized: false } });
    await db.connect();

    const which = await db.query('SELECT current_database() AS db');
    if (which.rows[0].db !== 'aether_test') {
      throw new Error(`refusing to run against "${which.rows[0].db}" — expected aether_test`);
    }

    // `id` TEXT, because production's is TEXT. See creditLedger.test.ts for the
    // full reasoning: a UUID stand-in makes every test pass against a schema
    // production could not create.
    await db.query(`
      CREATE TABLE IF NOT EXISTS players (
        id             TEXT PRIMARY KEY,
        credit_balance INTEGER NOT NULL DEFAULT 0,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await ensureProgressSchema(db);
  });

  afterAll(async () => {
    /* Only this ledger's own rows. The synthetic player stays: other suites in
     * this database reference the same id from `purchases`, and deleting it
     * trips that foreign key -- which is the test teardown failing, not the
     * ledger. Leaving one synthetic row in a throwaway database costs nothing.
     */
    await db?.query('DELETE FROM player_progress_items WHERE player_id = $1', [PLAYER]);
    await db?.query('DELETE FROM player_progress_values WHERE player_id = $1', [PLAYER]);
    await db?.end();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM player_progress_items WHERE player_id = $1', [PLAYER]);
    await db.query('DELETE FROM player_progress_values WHERE player_id = $1', [PLAYER]);
    await db.query(
      `INSERT INTO players (id, credit_balance) VALUES ($1, 0)
       ON CONFLICT (id) DO UPDATE SET credit_balance = 0`,
      [PLAYER]
    );
  });

  /* ------------------------------------------------------------------ */
  /* The union                                                           */
  /* ------------------------------------------------------------------ */

  it('two devices with disjoint finds converge to the union', async () => {
    await mergeProgress(db, PLAYER, relics(['0:0', '40:0']));
    await mergeProgress(db, PLAYER, relics(['60:0', '100:0']));

    expect((await found()).sort()).toEqual(['0:0', '100:0', '40:0', '60:0'].sort());
  });

  it('the union is commutative, so the sync order cannot matter', async () => {
    await mergeProgress(db, PLAYER, relics(['a', 'b']));
    await mergeProgress(db, PLAYER, relics(['c']));
    const forwards = (await found()).sort();

    await db.query('DELETE FROM player_progress_items WHERE player_id = $1', [PLAYER]);
    await mergeProgress(db, PLAYER, relics(['c']));
    await mergeProgress(db, PLAYER, relics(['a', 'b']));

    expect((await found()).sort()).toEqual(forwards);
  });

  it('replaying a payload changes nothing and reports nothing changed', async () => {
    const first = await mergeProgress(db, PLAYER, relics(['0:0', '40:0']));
    expect(first.changed).toBe(2);

    const again = await mergeProgress(db, PLAYER, relics(['0:0', '40:0']));
    expect(again.changed).toBe(0);
    expect(await found()).toHaveLength(2);
  });

  it('a payload that omits what the server holds does not delete it', async () => {
    /* The inference that makes last-write-wins destroy data: a device that has
     * not seen a relic is not a device reporting it was lost. */
    await mergeProgress(db, PLAYER, relics(['0:0', '40:0', '60:0']));
    await mergeProgress(db, PLAYER, relics(['0:0']));

    expect(await found()).toHaveLength(3);
  });

  it('scopes are independent, so one world cannot overwrite another', async () => {
    await mergeProgress(db, PLAYER, relics(['0:0'], 'citadel'));
    await mergeProgress(db, PLAYER, relics(['0:0'], 'medieval'));

    expect(await found('citadel')).toEqual(['0:0']);
    expect(await found('medieval')).toEqual(['0:0']);
  });

  /* ------------------------------------------------------------------ */
  /* The numeric merge                                                   */
  /* ------------------------------------------------------------------ */

  it('a best time only ever improves', async () => {
    const trial = (value: number) => ({
      values: [{ kind: 'trial', scope: 'citadel', key: 'rooftop', value }],
    });
    await mergeProgress(db, PLAYER, trial(42_000));
    await mergeProgress(db, PLAYER, trial(58_000));   // a worse run elsewhere

    const state = await readProgress(db, PLAYER);
    expect(state.values.trial.citadel.rooftop).toBe(42_000);

    await mergeProgress(db, PLAYER, trial(37_500));
    expect((await readProgress(db, PLAYER)).values.trial.citadel.rooftop).toBe(37_500);
  });

  it('a counter takes the larger of the two devices', async () => {
    const kills = (value: number) => ({ values: [{ kind: 'kills', key: 'raider', value }] });
    await mergeProgress(db, PLAYER, kills(30));
    await mergeProgress(db, PLAYER, kills(12));

    expect((await readProgress(db, PLAYER)).values.kills[''].raider).toBe(30);
  });

  it('a losing value reports as unchanged, so a replay is not mistaken for progress', async () => {
    const kills = (value: number) => ({ values: [{ kind: 'kills', key: 'raider', value }] });
    await mergeProgress(db, PLAYER, kills(30));
    const worse = await mergeProgress(db, PLAYER, kills(12));

    expect(worse.changed).toBe(0);
  });

  /* ------------------------------------------------------------------ */
  /* What the client is not allowed to decide                            */
  /* ------------------------------------------------------------------ */

  it('an unknown kind is refused, not stored', async () => {
    const res = await mergeProgress(db, PLAYER, {
      items: [{ kind: 'credits', scope: '', keys: ['9999999'] }],
    });

    expect(res.rejected).toContain('credits');
    expect(res.changed).toBe(0);
    expect(res.state.items.credits).toBeUndefined();
  });

  it('a client cannot send a set kind as a value, or the reverse', async () => {
    /* The merge rule is looked up from KINDS, never taken from the request. A
     * client that could ask for GREATEST on a lap time would own the
     * leaderboard. */
    const res = await mergeProgress(db, PLAYER, {
      values: [{ kind: 'relic', scope: 'citadel', key: '0:0', value: 1 }],
      items: [{ kind: 'trial', scope: 'citadel', keys: ['rooftop'] }],
    });

    expect(res.rejected.sort()).toEqual(['relic', 'trial']);
    expect(res.changed).toBe(0);
  });

  it('every declared kind has a shape, and trial is the only min', () => {
    const mins = Object.entries(KINDS)
      .filter(([, spec]) => spec.shape === 'value' && spec.mode === 'min')
      .map(([kind]) => kind);
    expect(mins).toEqual(['trial']);

    for (const [kind, spec] of Object.entries(KINDS)) {
      expect(['set', 'value'], `${kind} has no valid shape`).toContain(spec.shape);
    }
  });

  it('an over-long key is dropped rather than stored', async () => {
    const res = await mergeProgress(db, PLAYER, relics(['x'.repeat(200), '0:0']));
    expect(res.changed).toBe(1);
    expect(await found()).toEqual(['0:0']);
  });

  /* ------------------------------------------------------------------ */
  /* Concurrency                                                         */
  /* ------------------------------------------------------------------ */

  it('two simultaneous merges of the same key produce one row', async () => {
    /* The UNIQUE index, not a check-then-act. Two lambdas would not share a Set.
     * This is the assertion a mock cannot make. */
    const other = new Client({ connectionString: URL_!, ssl: { rejectUnauthorized: false } });
    await other.connect();
    try {
      await Promise.all([
        mergeProgress(db, PLAYER, relics(['0:0'])),
        mergeProgress(other, PLAYER, relics(['0:0'])),
      ]);
      expect(await found()).toEqual(['0:0']);
    } finally {
      await other.end();
    }
  });
});
