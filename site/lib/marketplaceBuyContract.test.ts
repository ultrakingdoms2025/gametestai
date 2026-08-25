import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { makeFakeDb } from './fakeDb';
import { resolveReportedEvent, CATALOGUE_PURCHASE_REASONS } from './creditPricing';
import { applyReportedEvent, ensureCreditSchema, ensureOpeningBalance } from './creditLedger';
import { purchaseMarketplaceItem } from './marketplaceDb';

/**
 * A MARKETPLACE BUY IS PRICED BY THE CATALOGUE, NOT BY THE BUYER.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEFECT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `/api/game/credits` takes `{events:[{key, reason, delta}]}` and its docblock
 * states the intent exactly — "the browser reports what happened, never what it
 * is worth". It held for the flat-priced kinds. It did not hold for buying:
 * `market` mapped to `sell`, `sell` is in `DECLARED_KINDS`, and a NEGATIVE
 * delta became a generic `spend` taken at face value. Driven live, signed in:
 *
 *   POST /api/game/credits {"events":[{"key":"…","reason":"market","delta":-1}]}
 *     200 applied:true delta:-1     <- a 1,071-credit item, bought for 1 credit
 *
 * The argument the code gave for trusting a debit — "nobody forges a spend in
 * their own favour" — is wrong in exactly this one place. UNDERSTATING a
 * purchase price IS forging a spend in your own favour, because the goods are
 * granted by the client and only the price travels.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE HARD PART, AND THE DESTINATION THAT ALREADY EXISTED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `{key, reason, delta}` carries no item, so the server had nothing to look
 * `cost_buy` up by even though it holds the row. The contract now carries the
 * purchase: a marketplace debit names `itemId`.
 *
 * The thing it names it TO was already written. `purchaseMarketplaceItem` is
 * transactional, price-authoritative, stock-decrementing and ledger-backed, with
 * a full integration suite — and had zero callers outside that suite. Someone
 * built the right thing and never wired it. This wires it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT AN OLD CLIENT GETS: REFUSED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A bundle that predates this sends no `itemId` and is refused
 * (`unpriced_purchase`); nothing is written and the balance does not move.
 *
 * The alternative — fall back to the reported number when no item is named — is
 * not a compatibility measure, it is the defect with a condition in front of it.
 * Anyone who wanted the old behaviour would omit the field, and a fallback an
 * attacker selects is not a fallback. The refusal fails toward NOT TAKING A
 * PLAYER'S CREDITS, which is the recoverable direction; a debit at a forged
 * price is not. It is also bounded: the site serves a content-hashed bundle, so
 * a stale one survives a reload.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THIS DOES NOT CLAIM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * SELLING is still bounded and not priced — `PER_EVENT_MAX.sell` at 500,000
 * against a largest legitimate stack of ~1,736. See the note on `DECLARED_KINDS`
 * for the three things pricing a sale would need, and why only two of them are
 * cheap. And a modified client can still take goods without reporting anything
 * at all; the bag is client-side. What is closed is that the endpoint no longer
 * OFFERS a purchase priced by the buyer.
 */

const here = dirname(fileURLToPath(import.meta.url));
const source = (...parts: string[]) =>
  readFileSync(join(here, ...parts), 'utf8').replace(/\r\n/g, '\n');

/* Comments stripped before matching: a sibling gate in this branch failed on the
 * FIXED tree because the comment explaining the fix quoted the code it replaced. */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const ITEM_UUID = '22222222-2222-4222-8222-222222222201';
const SOURCE_KEY = 'buy-contract-offline:station';
const PRICE = 1071; // the survey's item, to the credit

/* ---------------------------------------------------------------------- */
/* What the pricing module decides, with no database anywhere              */
/* ---------------------------------------------------------------------- */

describe('a marketplace debit resolves to a purchase, never to a price', () => {
  it('discards the reported amount entirely when an item is named', () => {
    for (const delta of [-1, -1071, -999_999]) {
      const r = resolveReportedEvent('market', delta, ITEM_UUID);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.kind).toBe('purchase');
      expect(r.itemRef).toBe(ITEM_UUID);
      expect(r.amount, 'the browser has named a price and the server kept it').toBeNull();
    }
  });

  it('refuses a marketplace debit that names nothing', () => {
    for (const ref of [undefined, null, '', '   ', 42, {}]) {
      const r = resolveReportedEvent('market', -1, ref);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe('unpriced_purchase');
    }
  });

  it('refuses it under the refund tag too, which is the one-word bypass', () => {
    /* `market-refund` is only ever a CREDIT in the game, so a negative one is
     * nonsense — but if it were left out of the set, "name your own purchase
     * price" would still work by changing one word in the request. */
    expect(CATALOGUE_PURCHASE_REASONS.has('market-refund')).toBe(true);
    const r = resolveReportedEvent('market-refund', -900, undefined);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('unpriced_purchase');
  });

  it('leaves SELLING exactly where it was: declared, and bounded', () => {
    const sell = resolveReportedEvent('market', 250);
    expect(sell.ok).toBe(true);
    if (!sell.ok) return;
    expect(sell.kind).toBe('sell');
    expect(sell.amount, 'selling is still the number the client sent').toBe(250);
    expect(sell.itemRef).toBeUndefined();

    const absurd = resolveReportedEvent('market', 500_001);
    expect(absurd.ok).toBe(false);
    if (absurd.ok) return;
    expect(absurd.reason).toBe('too_large');
  });

  it('leaves the game\'s other debit alone — it buys nothing off a row', () => {
    // Inventory.js:156,249 spend the virtual `credits` item. No catalogue row is
    // involved, so there is nothing to price it from.
    const r = resolveReportedEvent('inventory', -400);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe('spend');
    expect(r.amount).toBe(400);
  });
});

/* ---------------------------------------------------------------------- */
/* What the ledger does with it, still with no database                    */
/* ---------------------------------------------------------------------- */

describe('the ledger hands a purchase to the catalogue, or refuses it', () => {
  const balanceRow = () => [{ credit_balance: 500 }];

  it('refuses when the caller wired no purchase route — it never falls back', () => {
    /* FAILS CLOSED. A caller that has not wired the marketplace cannot
     * accidentally get the old behaviour; it gets a refusal. */
    return (async () => {
      const db = makeFakeDb(() => balanceRow());
      const r = await applyReportedEvent(db, 'p1', {
        key: 'k1', reason: 'market', delta: -1, itemId: ITEM_UUID,
      });
      expect(r.applied).toBe(false);
      expect(r.reason).toBe('unpriced_purchase');
      expect(db.matching('INSERT INTO credit_events')).toEqual([]);
      expect(db.matching('UPDATE players')).toEqual([]);
    })();
  });

  it('passes the item and the event key through, and nothing else', async () => {
    const seen: unknown[] = [];
    const db = makeFakeDb(() => balanceRow());
    const r = await applyReportedEvent(
      db,
      'p1',
      { key: 'k2', reason: 'market', delta: -1, itemId: ITEM_UUID },
      {
        buyCatalogueItem: async (req) => {
          seen.push(req);
          return { applied: true, delta: -PRICE, balance: 500 - PRICE, reason: 'ok' as const };
        },
      }
    );
    /* The handler is given the item and the key. There is no `delta` on that
     * object, and no way to reach one: this is the seam where a browser's price
     * would have to enter, and it is closed by the shape of the argument. */
    expect(seen).toEqual([{ itemRef: ITEM_UUID, eventKey: 'k2' }]);
    expect(r.applied).toBe(true);
    expect(r.delta, "the server's price, not the browser's").toBe(-PRICE);
  });

  it('does not route a SELL through the catalogue', async () => {
    let called = false;
    const db = makeFakeDb((sql) =>
      sql.startsWith('INSERT INTO credit_events') ? [{ id: 'e1' }] : balanceRow()
    );
    await applyReportedEvent(
      db, 'p1', { key: 'k3', reason: 'market', delta: 250 },
      { buyCatalogueItem: async () => { called = true; throw new Error('unreachable'); } }
    );
    expect(called).toBe(false);
  });
});

/* ---------------------------------------------------------------------- */
/* The wiring, read out of the source                                      */
/* ---------------------------------------------------------------------- */

describe('the contract is wired end to end', () => {
  it('the credits route hands the catalogue in, scoped by the server', () => {
    const route = codeOnly(source('..', 'app', 'api', 'game', 'credits', 'route.ts'));
    expect(route).toContain('buyCatalogueItem');
    expect(route).toContain('purchaseMarketplaceItem');
    expect(route, 'the scope must come from the session, never the request body')
      .toContain('currentServer(playerId)');
    expect(route.includes('serverId: scope')).toBe(true);
    /* And the item id has to survive the route's own re-typing of the body,
     * which rebuilds the event field by field. */
    expect(/itemId/.test(route)).toBe(true);
    /* AND IT HAS TO BE HANDED IN. Defining the handler is not wiring it: this
     * assertion was added after ablating the argument at the call site and
     * watching all eighteen tests in this file still pass, because everything
     * above was still true of a route that never passed it. `applyReportedEvent`
     * fails closed, so an unwired route refuses every purchase — no player is
     * overcharged, and no player can buy anything. */
    expect(
      /applyReportedEvent\([\s\S]{0,800}?\bhandlers\b/.test(route),
      'the route defines a purchase handler and never passes it to applyReportedEvent'
    ).toBe(true);
  });

  it('every marketplace spend in the game says which row it bought', () => {
    /* The game client half. `Economy.spend` is the only funnel, so a buy that
     * forgets the third argument is a buy the server refuses to price — silent,
     * and only visible as "my purchases are free". */
    const mk = codeOnly(source('..', '..', 'src', 'systems', 'Marketplace.js'));
    const spends = mk.match(/\.spend\([^)]*'market'[^)]*\)/g) ?? [];
    expect(spends.length, 'no market spend found — re-read this test').toBeGreaterThanOrEqual(3);
    for (const call of spends) {
      expect(call, `${call} does not pass the item id`).toMatch(/'market',\s*[A-Za-z_$][\w$]*/);
    }
    expect(mk).toContain('const buyMeta = { itemId:');
  });

  it('Economy carries it onto the event and CreditReporter into the queue', () => {
    const eco = codeOnly(source('..', '..', 'src', 'systems', 'Economy.js'));
    expect(eco).toMatch(/spend\(amount, reason = 'unknown', meta/);
    expect(eco).toContain("_emit(-cost, reason, 'spend', meta)");
    expect(eco).toContain('event.itemId = meta.itemId');

    const rep = codeOnly(source('..', '..', 'src', 'systems', 'CreditReporter.js'));
    expect(rep, 'the reporter drops the item id and every purchase stops being charged')
      .toContain('itemId');
    /* And out of the DURABLE queue as well as into it: the queue survives a
     * crash on purpose, and a restored purchase with no item id is a purchase
     * the server will refuse.
     *
     * Anchored on the METHOD, not on `_restore()` — the constructor's
     * `this._restore();` call comes first in the file, and slicing from there
     * swept in `_onChanged` and made this assertion pass with the restore path
     * ablated. Caught by ablating it. */
    const at = /\n\s{2}_restore\(\)\s*\{/.exec(rep);
    expect(at, 'the _restore method moved — re-read this test').toBeTruthy();
    const restore = rep.slice(at!.index, rep.indexOf('\n  schedule(', at!.index));
    expect(restore.length, 'the slice found no method body').toBeGreaterThan(50);
    expect(restore).toContain('itemId');
  });
});

/* ---------------------------------------------------------------------- */
/* The consequence, against a real Postgres                                */
/* ---------------------------------------------------------------------- */

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

/* ...0012. Its own player id, and CHECKED against the register in
 * `questLedger.test.ts` rather than guessed — this file first took ...0009,
 * which `serverChat.test.ts` owns, and broke four of its tests in the full run
 * while passing alone. */
const PLAYER = '00000000-0000-4000-8000-000000000012';

suite('a 1,071-credit item costs 1,071 credits (integration)', () => {
  let db: Client;

  const balance = async (): Promise<number> => {
    const r = await db.query('SELECT credit_balance FROM players WHERE id = $1', [PLAYER]);
    return Number(r.rows[0]?.credit_balance ?? -1);
  };
  const ledger = async () => {
    const r = await db.query<{ kind: string; detail: string; delta: number }>(
      'SELECT kind, detail, delta FROM credit_events WHERE player_id = $1 ORDER BY created_at, id',
      [PLAYER]
    );
    return r.rows.map((x) => ({ ...x, delta: Number(x.delta) }));
  };
  const sales = async (): Promise<number> => {
    const r = await db.query('SELECT COUNT(*)::int n FROM purchases WHERE player_id = $1', [PLAYER]);
    return Number(r.rows[0].n);
  };
  const stockOf = async (id: string): Promise<number | null> => {
    const r = await db.query('SELECT quantity FROM marketplace_items WHERE id = $1', [id]);
    return r.rows[0]?.quantity == null ? null : Number(r.rows[0].quantity);
  };

  /** The route's handler, verbatim in shape: the catalogue prices the buy. */
  const handlers = {
    buyCatalogueItem: async ({ itemRef, eventKey }: { itemRef: string; eventKey: string }) => {
      const r = await purchaseMarketplaceItem(db, PLAYER, { itemId: itemRef, eventKey });
      return { applied: r.applied, delta: r.applied ? -r.cost : 0, balance: r.balance, reason: r.reason };
    },
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
        id TEXT PRIMARY KEY, credit_balance INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await ensureCreditSchema(db);
    await db.query(`
      CREATE TABLE IF NOT EXISTS marketplace_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), source_key TEXT UNIQUE,
        name TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL,
        image TEXT NOT NULL DEFAULT '', game_action TEXT NOT NULL,
        action_config JSONB NOT NULL DEFAULT '{}'::jsonb, quantity INTEGER,
        cost_buy INTEGER NOT NULL, cost_sell INTEGER NOT NULL, world_name TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE, sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await db.query('ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS server_id TEXT').catch(() => {});
    await db.query(`
      CREATE TABLE IF NOT EXISTS purchases (
        id TEXT PRIMARY KEY, player_id TEXT REFERENCES players(id),
        stripe_intent_enc TEXT, amount_cents INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'usd', type TEXT NOT NULL,
        credits_amount INTEGER, status TEXT NOT NULL DEFAULT 'completed',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  });

  afterAll(async () => {
    if (!db) return;
    await db.query('DELETE FROM purchases WHERE player_id = $1', [PLAYER]).catch(() => {});
    await db.query('DELETE FROM credit_events WHERE player_id = $1', [PLAYER]).catch(() => {});
    await db.query('DELETE FROM players WHERE id = $1', [PLAYER]).catch(() => {});
    await db.query('DELETE FROM marketplace_items WHERE id = $1', [ITEM_UUID]).catch(() => {});
    await db.end();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM purchases WHERE player_id = $1', [PLAYER]);
    await db.query('DELETE FROM credit_events WHERE player_id = $1', [PLAYER]);
    await db.query(
      `INSERT INTO players (id, credit_balance) VALUES ($1, 5000)
       ON CONFLICT (id) DO UPDATE SET credit_balance = 5000`,
      [PLAYER]
    );
    await db.query(
      `INSERT INTO marketplace_items
         (id, source_key, name, description, category, game_action, action_config,
          quantity, cost_buy, cost_sell, world_name, is_active, server_id)
       VALUES ($1, $2, 'Dragonfire Lance', 'the survey bought this', 'weapons',
               'ship_part', '{}'::jsonb, 3, $3, 100, 'station', TRUE, NULL)
       ON CONFLICT (id) DO UPDATE
         SET quantity = 3, cost_buy = EXCLUDED.cost_buy, is_active = TRUE, server_id = NULL`,
      [ITEM_UUID, SOURCE_KEY, PRICE]
    );
    await ensureOpeningBalance(db, PLAYER);
  });

  it('charges 1,071 for the item the client claimed cost 1', async () => {
    /* The survey's request, to the field. Only `delta` differs from the truth,
     * which is the whole exploit. */
    const r = await applyReportedEvent(
      db, PLAYER,
      { key: 'survey-buy-dragonfire', reason: 'market', delta: -1, itemId: ITEM_UUID },
      handlers
    );
    expect(r.applied).toBe(true);
    expect(r.delta, 'the browser named 1 credit and got charged 1 credit').toBe(-PRICE);
    expect(await balance()).toBe(5000 - PRICE);

    const rows = await ledger();
    const buy = rows.filter((x) => x.kind === 'purchase');
    expect(buy.length).toBe(1);
    expect(buy[0].delta).toBe(-PRICE);
    expect(buy[0].detail, 'the ledger row says which item').toBe(`item:${SOURCE_KEY}`);
  });

  it('moves the stock and records the sale, in the same breath as the money', async () => {
    expect(await stockOf(ITEM_UUID)).toBe(3);
    await applyReportedEvent(
      db, PLAYER, { key: 'b-stock', reason: 'market', delta: -1, itemId: ITEM_UUID }, handlers
    );
    expect(await stockOf(ITEM_UUID), 'stock was never decremented before this').toBe(2);
    expect(await sales(), 'no sale record existed for a game purchase before this').toBe(1);
  });

  it('resolves the OFFLINE catalogue reference too, at the same price', async () => {
    /* The bundled shop keys its rows `${source_key}:${world}`, which IS the
     * seeded `source_key`. Accepting only the UUID would have made every offline
     * purchase unresolvable and therefore free. */
    const r = await applyReportedEvent(
      db, PLAYER, { key: 'b-offline', reason: 'market', delta: -1, itemId: SOURCE_KEY }, handlers
    );
    expect(r.applied).toBe(true);
    expect(r.delta).toBe(-PRICE);
    expect(await balance()).toBe(5000 - PRICE);
  });

  it('refuses, and writes nothing, when the event names no item', async () => {
    const r = await applyReportedEvent(
      db, PLAYER, { key: 'b-none', reason: 'market', delta: -1 }, handlers
    );
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('unpriced_purchase');
    expect(await balance()).toBe(5000);
    expect((await ledger()).filter((x) => x.kind !== 'migration')).toEqual([]);
    expect(await sales()).toBe(0);
  });

  it('charges once when the durable queue re-sends the same purchase', async () => {
    /* `CreditReporter` deliberately does not clear its queue on `pagehide`,
     * because `sendBeacon` cannot report success — so a replay is the NORMAL
     * case, not an attack. */
    const first = await applyReportedEvent(
      db, PLAYER, { key: 'b-replay', reason: 'market', delta: -1, itemId: ITEM_UUID }, handlers
    );
    const again = await applyReportedEvent(
      db, PLAYER, { key: 'b-replay', reason: 'market', delta: -1, itemId: ITEM_UUID }, handlers
    );
    expect(first.applied).toBe(true);
    expect(again.applied).toBe(false);
    expect(again.reason).toBe('duplicate');
    expect(await balance()).toBe(5000 - PRICE);
    expect(await stockOf(ITEM_UUID)).toBe(2);
    expect(await sales()).toBe(1);
  });

  it('refuses an unaffordable buy without touching the stock', async () => {
    await db.query('UPDATE players SET credit_balance = 10 WHERE id = $1', [PLAYER]);
    const r = await applyReportedEvent(
      db, PLAYER, { key: 'b-poor', reason: 'market', delta: -1, itemId: ITEM_UUID }, handlers
    );
    expect(r.applied).toBe(false);
    expect(r.reason).toBe('insufficient');
    expect(await balance()).toBe(10);
    expect(await stockOf(ITEM_UUID)).toBe(3);
  });

  it('a sale is still honoured at the number the client sent, and said so', async () => {
    /* Selling is NOT fixed by this change and this test exists to say so out
     * loud rather than leave the omission looking like an oversight. */
    const r = await applyReportedEvent(
      db, PLAYER, { key: 'b-sell', reason: 'market', delta: 1736 }, handlers
    );
    expect(r.applied).toBe(true);
    expect(r.delta).toBe(1736);
    expect((await ledger()).some((x) => x.kind === 'sell')).toBe(true);
  });
});
