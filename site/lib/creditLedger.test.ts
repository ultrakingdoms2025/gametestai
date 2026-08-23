import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { ensureCreditSchema, applyCreditEvent, spendCredits } from './creditLedger';

/**
 * The ledger, against a real Postgres.
 *
 * These tests exist because the two properties that matter cannot be proved any
 * other way. Idempotency is a UNIQUE constraint and concurrency safety is row
 * locking — a mock would assert only that I wrote down what I already believed.
 *
 * They run against `aether_test`, a SEPARATE database on the same Neon project:
 * separate rather than a schema, and separate rather than a branch, so a
 * mistaken statement here cannot reach a real player. `beforeAll` refuses to run
 * anywhere else. Nothing in this file ever connects to `neondb`.
 *
 * With POSTGRES_TEST_URL absent the suite skips rather than fails, so CI — which
 * has no database and should not have one — stays green.
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

/** Fixed and obviously synthetic. Never a real player id. */
const PLAYER = '00000000-0000-4000-8000-000000000001';

suite('creditLedger (integration)', () => {
  let db: Client;

  async function balance(): Promise<number> {
    const r = await db.query('SELECT credit_balance FROM players WHERE id = $1', [PLAYER]);
    return Number(r.rows[0]?.credit_balance ?? -1);
  }

  beforeAll(async () => {
    db = new Client({ connectionString: URL_!, ssl: { rejectUnauthorized: false } });
    await db.connect();

    // Refuse to run anywhere but the test database. A misconfigured URL pointing
    // at neondb would otherwise create tables in production.
    const which = await db.query('SELECT current_database() AS db');
    if (which.rows[0].db !== 'aether_test') {
      throw new Error(`refusing to run against "${which.rows[0].db}" — expected aether_test`);
    }

    // A minimal stand-in for the real players table: only the column the ledger
    // touches. The ledger must not depend on anything else about it.
    //
    // `id` is TEXT because PRODUCTION's is TEXT (admin/lib/db.ts:130), holding
    // UUID-shaped strings from randomUUID(). This started as UUID, which made
    // every test below pass against a schema production does not have: the real
    // ensureCreditSchema throws "foreign key constraint
    // credit_events_player_id_fkey cannot be implemented" against a TEXT id, so
    // the ledger could never have been created on production. A stand-in that
    // does not match production is not a stand-in, it is a second system that
    // agrees with you.
    await db.query(`
      CREATE TABLE IF NOT EXISTS players (
        id             TEXT PRIMARY KEY,
        credit_balance INTEGER NOT NULL DEFAULT 0,
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await ensureCreditSchema(db);
  });

  afterAll(async () => {
    if (db) await db.end();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM credit_events WHERE player_id = $1', [PLAYER]);
    await db.query(
      `INSERT INTO players (id, credit_balance) VALUES ($1, 100)
       ON CONFLICT (id) DO UPDATE SET credit_balance = 100`,
      [PLAYER]
    );
  });

  it('pays a priced event and returns the authoritative balance', async () => {
    const r = await applyCreditEvent(db, PLAYER, { kind: 'kill', eventKey: 'k-1' });
    expect(r.applied).toBe(true);
    expect(r.delta).toBe(5);
    expect(r.balance).toBe(105);
    expect(await balance()).toBe(105);
  });

  it('pays exactly once for a repeated event key', async () => {
    const first = await applyCreditEvent(db, PLAYER, { kind: 'kill', eventKey: 'dup' });
    const second = await applyCreditEvent(db, PLAYER, { kind: 'kill', eventKey: 'dup' });

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.reason).toBe('duplicate');
    expect(await balance()).toBe(105);
  });

  it('pays once when the same key arrives concurrently', async () => {
    // The case a check-then-act would lose, and the reason dedup is a constraint
    // rather than a Set in a process that would not survive two lambdas.
    const conns = await Promise.all(
      [0, 1, 2, 3, 4].map(async () => {
        const c = new Client({ connectionString: URL_!, ssl: { rejectUnauthorized: false } });
        await c.connect();
        return c;
      })
    );
    try {
      const results = await Promise.all(
        conns.map((c) => applyCreditEvent(c, PLAYER, { kind: 'kill', eventKey: 'race-1' }))
      );
      expect(results.filter((r) => r.applied)).toHaveLength(1);
      expect(await balance()).toBe(105);
    } finally {
      await Promise.all(conns.map((c) => c.end()));
    }
  });

  it('refuses an unrecognised kind without touching the balance', async () => {
    const r = await applyCreditEvent(db, PLAYER, { kind: 'jackpot' as never, eventKey: 'j-1' });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('unknown_kind');
    expect(await balance()).toBe(100);
  });

  it('refuses the admin cheat kind', async () => {
    const r = await applyCreditEvent(db, PLAYER, { kind: 'cheat' as never, eventKey: 'c-1' });
    expect(r.applied).toBe(false);
    expect(await balance()).toBe(100);
  });

  it('records the balance after, so the ledger is self-checking', async () => {
    await applyCreditEvent(db, PLAYER, { kind: 'kill', eventKey: 'b-1' });
    await applyCreditEvent(db, PLAYER, { kind: 'kill', eventKey: 'b-2' });
    const rows = await db.query(
      'SELECT delta, balance_after FROM credit_events WHERE player_id = $1 ORDER BY created_at, id',
      [PLAYER]
    );
    expect(rows.rows.map((r) => Number(r.balance_after))).toEqual([105, 110]);
  });

  it('stops paying once the cap for a kind is reached, and says so', async () => {
    const cap = 400; // capFor('kill').maxEvents
    const values = Array.from({ length: cap }, (_, i) => `($1,'cap-${i}','kill',NULL,0,100)`).join(',');
    await db.query(
      `INSERT INTO credit_events (player_id, event_key, kind, detail, delta, balance_after) VALUES ${values}`,
      [PLAYER]
    );

    const r = await applyCreditEvent(db, PLAYER, { kind: 'kill', eventKey: 'over-cap' });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('capped');
    expect(await balance()).toBe(100);

    // The attempt is recorded rather than hidden.
    const logged = await db.query(
      "SELECT delta FROM credit_events WHERE player_id = $1 AND event_key = 'over-cap'",
      [PLAYER]
    );
    expect(logged.rows).toHaveLength(1);
    expect(Number(logged.rows[0].delta)).toBe(0);
  });

  describe('spendCredits', () => {
    it('debits when the balance covers it', async () => {
      const r = await spendCredits(db, PLAYER, { cost: 30, detail: 'item:lantern', eventKey: 's-1' });
      expect(r.applied).toBe(true);
      expect(r.balance).toBe(70);
      expect(await balance()).toBe(70);
    });

    it('refuses to overdraw', async () => {
      const r = await spendCredits(db, PLAYER, { cost: 500, detail: 'item:ship', eventKey: 's-2' });
      expect(r.applied).toBe(false);
      expect(r.reason).toBe('insufficient');
      expect(await balance()).toBe(100);
    });

    it('cannot double-spend under concurrency', async () => {
      // Two purchases of 60 against a balance of 100. Exactly one may win and the
      // balance may never go negative. This is the property marketplaceDb has
      // never had, because it has no purchase transaction at all.
      const conns = await Promise.all(
        [0, 1].map(async () => {
          const c = new Client({ connectionString: URL_!, ssl: { rejectUnauthorized: false } });
          await c.connect();
          return c;
        })
      );
      try {
        const results = await Promise.all(
          conns.map((c, i) =>
            spendCredits(c, PLAYER, { cost: 60, detail: 'item:x', eventKey: `spend-${i}` })
          )
        );
        expect(results.filter((r) => r.applied)).toHaveLength(1);
        expect(await balance()).toBe(40);
      } finally {
        await Promise.all(conns.map((c) => c.end()));
      }
    });

    it('refuses a non-positive or non-integer cost', async () => {
      for (const cost of [0, -5, 1.5, NaN, Infinity]) {
        const r = await spendCredits(db, PLAYER, {
          cost,
          detail: 'item:x',
          eventKey: `bad-${String(cost)}`,
        });
        expect(r.applied).toBe(false);
      }
      expect(await balance()).toBe(100);
    });
  });
});
