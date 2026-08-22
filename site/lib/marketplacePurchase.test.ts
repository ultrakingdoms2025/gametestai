import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { ensureCreditSchema } from './creditLedger';
import { purchaseMarketplaceItem } from './marketplaceDb';

/**
 * Buying, against a real Postgres.
 *
 * Buying was client-side arithmetic: the browser picked the price, decided it
 * could afford it, and the server wrote back whatever balance the browser then
 * claimed. The properties that replace it are all database properties — a row
 * lock, a UNIQUE constraint, a transaction boundary — and none of them can be
 * demonstrated against a mock, which would only agree with whatever I wrote.
 *
 * Runs against `aether_test`, and `beforeAll` refuses to run anywhere else.
 * The stand-in tables below mirror the PRODUCTION column types on purpose:
 * `players.id` and `purchases.player_id` are TEXT (admin/lib/db.ts), and a
 * stand-in that quietly uses nicer types is how a ledger got written that could
 * never have been created on production.
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

/** Distinct from the ledger suite's player, so the two files cannot collide. */
const PLAYER = '00000000-0000-4000-8000-000000000002';

const LIMITED = '11111111-1111-4111-8111-111111111101';
const UNLIMITED = '11111111-1111-4111-8111-111111111102';
const INACTIVE = '11111111-1111-4111-8111-111111111103';
const FREE = '11111111-1111-4111-8111-111111111104';
const OTHER = '11111111-1111-4111-8111-111111111105';

suite('marketplace purchase (integration)', () => {
  let db: Client;

  const balance = async (): Promise<number> => {
    const r = await db.query('SELECT credit_balance FROM players WHERE id = $1', [PLAYER]);
    return Number(r.rows[0]?.credit_balance ?? -1);
  };
  const stockOf = async (id: string): Promise<number | null> => {
    const r = await db.query('SELECT quantity FROM marketplace_items WHERE id = $1', [id]);
    return r.rows[0]?.quantity == null ? null : Number(r.rows[0].quantity);
  };
  const events = async (): Promise<number> => {
    const r = await db.query('SELECT COUNT(*)::int n FROM credit_events WHERE player_id = $1', [PLAYER]);
    return Number(r.rows[0].n);
  };
  const sales = async (): Promise<number> => {
    const r = await db.query('SELECT COUNT(*)::int n FROM purchases WHERE player_id = $1', [PLAYER]);
    return Number(r.rows[0].n);
  };

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
        credit_balance INTEGER NOT NULL DEFAULT 0,
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await ensureCreditSchema(db);

    // Mirrors marketplace_items in ensureMarketplaceSchema, column for column.
    await db.query(`
      CREATE TABLE IF NOT EXISTS marketplace_items (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_key    TEXT UNIQUE,
        name          TEXT NOT NULL,
        description   TEXT NOT NULL,
        category      TEXT NOT NULL,
        image         TEXT NOT NULL DEFAULT '',
        game_action   TEXT NOT NULL,
        action_config JSONB NOT NULL DEFAULT '{}'::jsonb,
        quantity      INTEGER,
        cost_buy      INTEGER NOT NULL,
        cost_sell     INTEGER NOT NULL,
        world_name    TEXT NOT NULL,
        is_active     BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order    INTEGER NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // Mirrors purchases in admin/lib/db.ts:223 — player_id is TEXT there.
    await db.query(`
      CREATE TABLE IF NOT EXISTS purchases (
        id                TEXT PRIMARY KEY,
        player_id         TEXT REFERENCES players(id),
        stripe_intent_enc TEXT,
        amount_cents      INTEGER NOT NULL,
        currency          TEXT NOT NULL DEFAULT 'usd',
        type              TEXT NOT NULL,
        credits_amount    INTEGER,
        status            TEXT NOT NULL DEFAULT 'completed',
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  });

  afterAll(async () => {
    if (db) await db.end();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM purchases WHERE player_id = $1', [PLAYER]);
    await db.query('DELETE FROM credit_events WHERE player_id = $1', [PLAYER]);
    await db.query(
      `INSERT INTO players (id, credit_balance) VALUES ($1, 100)
       ON CONFLICT (id) DO UPDATE SET credit_balance = 100`,
      [PLAYER]
    );
    const seed = [
      [LIMITED, 'limited', 'Ion Lantern', 60, 1, true],
      [UNLIMITED, 'unlimited', 'Ration Pack', 30, null, true],
      [INACTIVE, 'inactive', 'Withdrawn Crate', 10, 5, false],
      [FREE, 'free', 'Mispriced Relic', 0, 5, true],
      [OTHER, 'other', 'Signal Torch', 60, 5, true],
    ] as const;
    for (const [id, key, name, cost, qty, active] of seed) {
      await db.query(
        `INSERT INTO marketplace_items
           (id, source_key, name, description, category, game_action, quantity,
            cost_buy, cost_sell, world_name, is_active)
         VALUES ($1, $2, $3, 'test row', 'tools', 'grant_item', $4, $5, 1, 'station', $6)
         ON CONFLICT (id) DO UPDATE
           SET quantity = EXCLUDED.quantity,
               cost_buy = EXCLUDED.cost_buy,
               is_active = EXCLUDED.is_active`,
        [id, key, name, qty, cost, active]
      );
    }
  });

  it('prices the sale from the database, not from the caller', async () => {
    // The request names an item and nothing else. There is no field in which a
    // price could be smuggled — which is the whole point of the shape.
    const r = await purchaseMarketplaceItem(db, PLAYER, { itemId: UNLIMITED, eventKey: 'p-1' });
    expect(r.applied).toBe(true);
    expect(r.cost).toBe(30);
    expect(r.balance).toBe(70);
    expect(await balance()).toBe(70);
    expect(r.item?.name).toBe('Ration Pack');
  });

  it('ignores a price the caller tries to smuggle in', async () => {
    const hostile = { itemId: UNLIMITED, eventKey: 'p-2', cost: 1, credits: 1, delta: 1 };
    const r = await purchaseMarketplaceItem(db, PLAYER, hostile);
    expect(r.cost).toBe(30);
    expect(await balance()).toBe(70);
  });

  it('decrements limited stock and leaves unlimited stock alone', async () => {
    const r = await purchaseMarketplaceItem(db, PLAYER, { itemId: LIMITED, eventKey: 'p-3' });
    expect(r.applied).toBe(true);
    expect(r.stock).toBe(0);
    expect(await stockOf(LIMITED)).toBe(0);

    const u = await purchaseMarketplaceItem(db, PLAYER, { itemId: UNLIMITED, eventKey: 'p-4' });
    expect(u.stock).toBeNull();
    expect(await stockOf(UNLIMITED)).toBeNull();
  });

  it('refuses to overdraw, and writes nothing at all', async () => {
    await db.query('UPDATE players SET credit_balance = 10 WHERE id = $1', [PLAYER]);
    const r = await purchaseMarketplaceItem(db, PLAYER, { itemId: LIMITED, eventKey: 'p-5' });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('insufficient');
    expect(await balance()).toBe(10);
    expect(await stockOf(LIMITED)).toBe(1);
    expect(await events()).toBe(0);
    expect(await sales()).toBe(0);
  });

  it('refuses an inactive item', async () => {
    const r = await purchaseMarketplaceItem(db, PLAYER, { itemId: INACTIVE, eventKey: 'p-6' });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('inactive');
    expect(await balance()).toBe(100);
    expect(await stockOf(INACTIVE)).toBe(5);
  });

  it('refuses a zero-priced row rather than giving the stock away', async () => {
    // A free item would skip the balance check entirely and still consume stock.
    const r = await purchaseMarketplaceItem(db, PLAYER, { itemId: FREE, eventKey: 'p-7' });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('invalid');
    expect(await stockOf(FREE)).toBe(5);
    expect(await events()).toBe(0);
  });

  it('refuses an out-of-stock item', async () => {
    await db.query('UPDATE marketplace_items SET quantity = 0 WHERE id = $1', [LIMITED]);
    const r = await purchaseMarketplaceItem(db, PLAYER, { itemId: LIMITED, eventKey: 'p-8' });
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('stock');
    expect(await balance()).toBe(100);
  });

  it('answers not_found for an unknown or malformed id instead of throwing', async () => {
    // A non-UUID reaching Postgres raises "invalid input syntax for type uuid",
    // which would 500 the route rather than refuse the request.
    for (const bad of ['not-a-uuid', '', '11111111-1111-4111-8111-1111111119ff']) {
      const r = await purchaseMarketplaceItem(db, PLAYER, { itemId: bad, eventKey: `nf-${bad}` });
      expect(r.applied).toBe(false);
      expect(r.reason).toBe('not_found');
    }
    expect(await balance()).toBe(100);
  });

  it('records the sale in purchases, in the same transaction as the money', async () => {
    await purchaseMarketplaceItem(db, PLAYER, { itemId: LIMITED, eventKey: 'p-9' });
    const r = await db.query(
      'SELECT type, amount_cents, credits_amount, status FROM purchases WHERE player_id = $1',
      [PLAYER]
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].type).toBe('market_buy');
    expect(Number(r.rows[0].amount_cents)).toBe(0);
    expect(Number(r.rows[0].credits_amount)).toBe(60);
  });

  it('writes a ledger row carrying the item and a negative delta', async () => {
    await purchaseMarketplaceItem(db, PLAYER, { itemId: LIMITED, eventKey: 'p-10' });
    const r = await db.query(
      'SELECT kind, detail, delta, balance_after FROM credit_events WHERE player_id = $1',
      [PLAYER]
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].kind).toBe('purchase');
    expect(r.rows[0].detail).toBe('item:limited');
    expect(Number(r.rows[0].delta)).toBe(-60);
    expect(Number(r.rows[0].balance_after)).toBe(40);
  });

  it('charges once for a repeated event key, and decrements stock once', async () => {
    const first = await purchaseMarketplaceItem(db, PLAYER, { itemId: LIMITED, eventKey: 'dup' });
    const second = await purchaseMarketplaceItem(db, PLAYER, { itemId: LIMITED, eventKey: 'dup' });

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(await balance()).toBe(40);
    expect(await stockOf(LIMITED)).toBe(0);
    expect(await events()).toBe(1);
    expect(await sales()).toBe(1);
  });

  it('tells a retry it already succeeded, rather than that it cannot afford it', async () => {
    // The trap: after the first purchase the balance is 40 and the item costs
    // 60, so a retry that is simply re-evaluated answers `insufficient` — the
    // client shows a failure for an item the player already owns and was already
    // charged for. The prior-event check exists for exactly this.
    await purchaseMarketplaceItem(db, PLAYER, { itemId: LIMITED, eventKey: 'retry' });
    expect(await balance()).toBe(40);

    const retry = await purchaseMarketplaceItem(db, PLAYER, { itemId: LIMITED, eventKey: 'retry' });
    expect(retry.reason).toBe('duplicate');
    expect(retry.reason).not.toBe('insufficient');
    expect(retry.cost).toBe(60);
    expect(retry.balance).toBe(40);
  });

  it('cannot oversell the last unit under concurrency', async () => {
    await db.query('UPDATE players SET credit_balance = 1000 WHERE id = $1', [PLAYER]);
    const conns = await Promise.all(
      [0, 1, 2].map(async () => {
        const c = new Client({ connectionString: URL_!, ssl: { rejectUnauthorized: false } });
        await c.connect();
        return c;
      })
    );
    try {
      const results = await Promise.all(
        conns.map((c, i) =>
          purchaseMarketplaceItem(c, PLAYER, { itemId: LIMITED, eventKey: `race-stock-${i}` })
        )
      );
      expect(results.filter((r) => r.applied)).toHaveLength(1);
      expect(await stockOf(LIMITED)).toBe(0);
      expect(await balance()).toBe(940);
    } finally {
      await Promise.all(conns.map((c) => c.end()));
    }
  });

  it('cannot double-spend across two DIFFERENT items', async () => {
    // The case the PLAYER row lock exists for, and the one the same-item test
    // cannot see: buying one item takes that item's row lock, which serialises
    // two buyers of the SAME item all by itself. Two different items share no
    // item lock, so the only thing standing between the player and a negative
    // balance is `SELECT credit_balance ... FOR UPDATE`. Verified by removing
    // that lock: this test fails and the same-item one still passes.
    const conns = await Promise.all(
      [0, 1].map(async () => {
        const c = new Client({ connectionString: URL_!, ssl: { rejectUnauthorized: false } });
        await c.connect();
        return c;
      })
    );
    try {
      const results = await Promise.all([
        purchaseMarketplaceItem(conns[0], PLAYER, { itemId: LIMITED, eventKey: 'x-a' }),
        purchaseMarketplaceItem(conns[1], PLAYER, { itemId: OTHER, eventKey: 'x-b' }),
      ]);
      expect(results.filter((r) => r.applied)).toHaveLength(1);
      expect(await balance()).toBe(40);
    } finally {
      await Promise.all(conns.map((c) => c.end()));
    }
  });

  it('cannot double-spend a balance that covers only one of them', async () => {
    // Two purchases of 60 against 100. Exactly one may win and the balance may
    // never go negative. Stock is raised so the BALANCE is the only constraint.
    await db.query('UPDATE marketplace_items SET quantity = 5 WHERE id = $1', [LIMITED]);
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
          purchaseMarketplaceItem(c, PLAYER, { itemId: LIMITED, eventKey: `race-cr-${i}` })
        )
      );
      expect(results.filter((r) => r.applied)).toHaveLength(1);
      expect(await balance()).toBe(40);
      expect(await stockOf(LIMITED)).toBe(4);
      expect(await sales()).toBe(1);
    } finally {
      await Promise.all(conns.map((c) => c.end()));
    }
  });
});
