import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import {
  ensureCreditSchema,
  ensureOpeningBalance,
  applyReportedEvent,
} from './creditLedger';

/**
 * What the server does with what the browser reports.
 *
 * The claim being tested is narrow and worth stating exactly: the client says
 * WHAT happened, and for everything the server can price, the amount it claimed
 * is thrown away. For the handful of sources the server cannot price -- a mixed
 * ore hold, a contract's own reward -- the claim is honoured but BOUNDED, which
 * is weaker and is not pretended otherwise.
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

/** Distinct from the other DB suites so parallel files cannot collide. */
const PLAYER = '00000000-0000-4000-8000-000000000003';

suite('reported credit events (integration)', () => {
  let db: Client;

  const balance = async (): Promise<number> => {
    const r = await db.query('SELECT credit_balance FROM players WHERE id = $1', [PLAYER]);
    return Number(r.rows[0]?.credit_balance ?? -1);
  };
  const rows = async () => {
    const r = await db.query(
      'SELECT kind, detail, delta FROM credit_events WHERE player_id = $1 ORDER BY created_at, id',
      [PLAYER]
    );
    return r.rows;
  };

  beforeAll(async () => {
    db = new Client({ connectionString: URL_!, ssl: { rejectUnauthorized: false } });
    await db.connect();
    const which = await db.query('SELECT current_database() AS db');
    if (which.rows[0].db !== 'aether_test') {
      throw new Error(`refusing to run against "${which.rows[0].db}" — expected aether_test`);
    }
    // TEXT id: production's shape. See creditLedger.test.ts.
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
      `INSERT INTO players (id, credit_balance) VALUES ($1, 1000)
       ON CONFLICT (id) DO UPDATE SET credit_balance = 1000`,
      [PLAYER]
    );
  });

  it('pays its own price for a kill, whatever the client claimed', async () => {
    // The single most important assertion in the phase.
    const r = await applyReportedEvent(db, PLAYER, { key: 'k1', reason: 'kill', delta: 999_999 });
    expect(r.applied).toBe(true);
    expect(r.delta).toBe(5);
    expect(await balance()).toBe(1005);
  });

  it('pays its own price for relics, viewpoints and mazes', async () => {
    const cases: Array<[string, number]> = [
      ['relic', 120],
      ['relic-set', 500],
      ['viewpoint', 150],
      ['maze-centre', 100],
      ['maze-token', 6],
    ];
    let expected = 1000;
    for (const [reason, price] of cases) {
      const r = await applyReportedEvent(db, PLAYER, { key: `p-${reason}`, reason, delta: 1 });
      expect(r.applied, reason).toBe(true);
      expect(r.delta, reason).toBe(price);
      expected += price;
    }
    expect(await balance()).toBe(expected);
  });

  it('honours a declared amount the server cannot price', async () => {
    // An ore hold is a mixed cargo. The server has no table for it, so it takes
    // the number and bounds it -- and says so rather than pretending otherwise.
    const r = await applyReportedEvent(db, PLAYER, { key: 'ore1', reason: 'ore', delta: 12_500 });
    expect(r.applied).toBe(true);
    expect(r.delta).toBe(12_500);
    expect(await balance()).toBe(13_500);
  });

  it('refuses an absurd declared amount instead of truncating it', async () => {
    // Truncating would pay a wrong number and leave no trace it was wrong.
    const r = await applyReportedEvent(db, PLAYER, { key: 'ore2', reason: 'ore', delta: 900_000_000 });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('too_large');
    expect(await balance()).toBe(1000);
    expect(await rows()).toHaveLength(0);
  });

  it('refuses a reason it has never heard of, and writes nothing', async () => {
    const r = await applyReportedEvent(db, PLAYER, { key: 'x1', reason: 'jackpot', delta: 50 });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('unknown_source');
    expect(await balance()).toBe(1000);
    expect(await rows()).toHaveLength(0);
  });

  it('refuses the admin cheat by name', async () => {
    const r = await applyReportedEvent(db, PLAYER, { key: 'c1', reason: 'cheat', delta: 5000 });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('refused');
    expect(await balance()).toBe(1000);
  });

  it('refuses a reported quest reward, because the server already paid it', async () => {
    // completeQuestEngagement grants from quests.reward_credits and the client
    // mirrors the returned balance. Honouring this would pay twice.
    const r = await applyReportedEvent(db, PLAYER, { key: 'q1', reason: 'quest', delta: 250 });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('refused');
    expect(await balance()).toBe(1000);
  });

  /* THESE THREE USED TO DRIVE 'market' DEBITS, AND WERE CHANGED DELIBERATELY.
   *
   * A negative `market` delta is no longer a spend the browser prices — it is a
   * catalogue purchase, priced from `cost_buy` on the named row, and refused
   * outright when no row is named (`marketplaceBuyContract.test.ts` owns that
   * behaviour). What these three are actually about — sign decides direction, a
   * debit is recorded as a spend, an overdraw is refused — is unchanged, so they
   * now drive `inventory`, which is the game's OTHER debit and the only one left
   * that the server bounds rather than prices (`Inventory.js:156,249`, spending
   * the virtual `credits` item; no goods come off a catalogue row, so there is
   * nothing to price it from). */
  it('debits on a negative delta and records it as a spend', async () => {
    const r = await applyReportedEvent(db, PLAYER, { key: 's1', reason: 'inventory', delta: -400 });
    expect(r.applied).toBe(true);
    expect(r.delta).toBe(-400);
    expect(await balance()).toBe(600);
    const [row] = await rows();
    expect(row.kind).toBe('spend');
    expect(row.detail).toBe('inventory');
  });

  it('reads direction from the sign, not the tag', async () => {
    // 'market' is used by the game for BOTH selling (add) and buying (spend), so
    // a tag-based rule would get one of them backwards. It still holds, and it
    // now discriminates harder: the positive one is a bounded `sell`, the
    // negative one is not a sell at all but a purchase the server prices.
    const buy = await applyReportedEvent(db, PLAYER, { key: 'm-buy', reason: 'market', delta: -300 });
    const sell = await applyReportedEvent(db, PLAYER, { key: 'm-sell', reason: 'market', delta: 250 });
    expect(buy.applied, 'a buy with no item named must not be paid at the browser price').toBe(false);
    expect(buy.reason).toBe('unpriced_purchase');
    expect(sell.applied).toBe(true);
    expect(await balance()).toBe(1250);
    expect((await rows()).map((r) => r.kind)).toEqual(['sell']);
  });

  it('refuses a spend the balance cannot cover', async () => {
    const r = await applyReportedEvent(db, PLAYER, { key: 's2', reason: 'inventory', delta: -5000 });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('insufficient');
    expect(await balance()).toBe(1000);
  });

  it('applies a repeated key exactly once', async () => {
    const first = await applyReportedEvent(db, PLAYER, { key: 'dup', reason: 'kill', delta: 5 });
    const second = await applyReportedEvent(db, PLAYER, { key: 'dup', reason: 'kill', delta: 5 });
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.reason).toBe('duplicate');
    expect(await balance()).toBe(1005);
  });

  it('survives the replay a closed tab causes', async () => {
    // pagehide beacons the queue and cannot know whether it landed, so the next
    // boot sends the same keys again. That has to be free.
    const batch = [
      { key: 'b1', reason: 'kill', delta: 5 },
      { key: 'b2', reason: 'relic', delta: 120 },
      { key: 'b3', reason: 'ore', delta: 900 },
    ];
    for (const e of batch) await applyReportedEvent(db, PLAYER, e);
    const afterFirst = await balance();
    for (const e of batch) await applyReportedEvent(db, PLAYER, e);
    expect(await balance()).toBe(afterFirst);
    expect(afterFirst).toBe(1000 + 5 + 120 + 900);
  });

  describe('opening balance', () => {
    it('records the total the ledger inherited, once', async () => {
      await ensureOpeningBalance(db, PLAYER);
      await ensureOpeningBalance(db, PLAYER);
      const migration = (await rows()).filter((r) => r.kind === 'migration');
      expect(migration).toHaveLength(1);
      expect(Number(migration[0].delta)).toBe(1000);
      // It records; it must not GRANT.
      expect(await balance()).toBe(1000);
    });

    it('leaves the ledger self-consistent from its first entry', async () => {
      await ensureOpeningBalance(db, PLAYER);
      await applyReportedEvent(db, PLAYER, { key: 'after', reason: 'kill', delta: 5 });
      const r = await db.query(
        'SELECT delta, balance_after FROM credit_events WHERE player_id = $1 ORDER BY created_at, id',
        [PLAYER]
      );
      let running = 0;
      for (const row of r.rows) {
        running += Number(row.delta);
        expect(Number(row.balance_after)).toBe(running);
      }
      expect(running).toBe(await balance());
    });
  });
});
