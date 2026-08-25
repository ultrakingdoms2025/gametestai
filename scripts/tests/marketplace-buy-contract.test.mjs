import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Marketplace } from '../../src/systems/Marketplace.js';

/**
 * EVERY BUY SAYS WHICH ROW IT BOUGHT.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS FILE EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `/api/game/credits` used to take a marketplace debit at the number the
 * browser sent. Driven live against the signed-in surface:
 *
 *   POST /api/game/credits {"events":[{"reason":"market","delta":-1}]}
 *     200 applied:true delta:-1    <- a 1,071-credit item, bought for 1 credit
 *
 * The server holds the catalogue row and could always have priced it. What it
 * could not do was tell WHICH row: `{key, reason, delta}` carries no item. So
 * the contract now carries one, and a marketplace debit with no item named is
 * REFUSED rather than charged at the browser's price.
 *
 * That makes this client half load-bearing in a way it was not before. Every
 * debit in `Marketplace.buy` must pass the catalogue id through
 * `Economy.spend`'s third argument, and there are THREE of them — a mount
 * power, a cosmetic, and a bagged grant — on three separate early-returning
 * branches. Miss one and that branch's purchases stop being charged at all,
 * silently, with no error anywhere: the server refuses the event, the client
 * drops it, and the player keeps both the item and the credits.
 *
 * A source scrape covers this too (`site/lib/marketplaceBuyContract.test.ts`),
 * but a scrape only sees that an identifier is in the argument list. These
 * exercise the real method on all three branches and read what `spend` was
 * actually handed.
 */

/** Records what `Economy.spend` was called with, and always succeeds. */
function spy(credits = 100_000) {
  const calls = [];
  return {
    calls,
    economy: {
      credits,
      spend(amount, reason, meta) {
        calls.push({ amount, reason, meta });
        return true;
      },
      add() { return credits; },
    },
  };
}

/** A Marketplace with just enough around it for `buy` to reach a spend. */
function shop(catalogRow, extra = {}) {
  const s = spy();
  const m = Object.create(Marketplace.prototype);
  Object.assign(m, {
    economy: s.economy,
    inventory: {
      roomFor: () => 30,
      totalCount: () => 0,
      count: () => 0,
      bagCount: () => 0,
      acquire: (_id, qty) => ({ taken: qty }),
    },
    cosmetics: { has: () => false },
    mounts: null,
    bus: { emit() {} },
    ui: null,
    _catalog: [catalogRow],
    ...extra,
  });
  return { m, calls: s.calls };
}

const GRANT_ROW = {
  id: 'aa11bb22-cc33-4d44-8e55-ff6677889900',
  source_key: 'pack_rifle:station',
  name: 'Rifle ammo pack',
  quantity: null,
  cost_buy: 1071,
  action_config: { effect: 'grant_item', item_id: 'ammo_rifle', amount: 30 },
};

const COSMETIC_ROW = {
  id: 'bb11bb22-cc33-4d44-8e55-ff6677889901',
  source_key: 'cosmetic_char_aurora:station',
  name: 'Aurora',
  quantity: null,
  cost_buy: 400,
  action_config: { effect: 'unlock_cosmetic', kind: 'character', cosmetic_id: 'char_aurora' },
};

const POWER_ROW = {
  id: 'cc11bb22-cc33-4d44-8e55-ff6677889902',
  source_key: null,
  name: 'Dragon fire I',
  quantity: null,
  cost_buy: 900,
  action_config: { effect: 'grant_mount_power', mount: 'dragon', power: 'fire', tier: 1 },
};

test('a bagged grant tells the server which catalogue row it bought', () => {
  const { m, calls } = shop(GRANT_ROW);
  const res = m.buy(GRANT_ROW.id);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reason, 'market');
  assert.equal(calls[0].meta?.itemId, GRANT_ROW.id);
});

test('a cosmetic unlock does too — a separate branch that returns early', () => {
  const { m, calls } = shop(COSMETIC_ROW, { cosmetics: { has: () => false, unlock() {} } });
  const res = m.buy(COSMETIC_ROW.id);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(calls[0].meta?.itemId, COSMETIC_ROW.id);
});

test('and a mount power — the third branch, and the one with no source_key', () => {
  // Owner-authored and mount rows carry `source_key: null`, so the row ID is the
  // only reference the server can resolve for them.
  const mounts = { hasPower: () => false, powerTier: () => 0, grantPower() {} };
  const { m, calls } = shop(POWER_ROW, { mounts });
  const res = m.buy(POWER_ROW.id);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(calls[0].meta?.itemId, POWER_ROW.id);
});

test('an OFFLINE row is referenced by the source key the seeder wrote', () => {
  /* `MarketplaceOffline` keys its rows `${source_key}:${world}` on purpose, so
   * "an offline purchase and an online one name the same row". The id it hands
   * `buy` is therefore the DB's `source_key`, and the server resolves it as one.
   * Without that, every purchase made while the API was down would resolve to
   * nothing and be refused — which is to say, would be free. */
  const offline = { ...GRANT_ROW, id: 'pack_rifle:station', offline: true };
  const { m, calls } = shop(offline);
  const res = m.buy('pack_rifle:station');
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(calls[0].meta?.itemId, 'pack_rifle:station');
});

test('a refused buy spends nothing, so it names nothing either', () => {
  // The guard that must not regress while adding an argument to every spend.
  const { m, calls } = shop({ ...GRANT_ROW, quantity: 0 });
  const res = m.buy(GRANT_ROW.id);
  assert.equal(res.ok, false);
  assert.equal(calls.length, 0);
});
