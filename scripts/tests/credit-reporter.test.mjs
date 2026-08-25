import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Economy } from '../../src/systems/Economy.js';
import { CreditReporter } from '../../src/systems/CreditReporter.js';

/**
 * THE REPORTER THAT MAKES THE SERVER THE OWNER OF THE BALANCE.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS FILE EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `/api/game/state` used to accept a `credits` number from the browser and
 * write it to the account. The replacement is: the client reports what
 * happened, and the server prices it. This file tests the client half.
 *
 * Two of these cases are here because the obvious implementation gets them
 * wrong, and both failures are silent:
 *
 *   1. Filtering on the reason TAG rather than the operation. `QuestSystem`
 *      completes a quest with `economy.set(next, 'quest')` -- writing the
 *      server's own absolute balance back into the mirror -- and uses the same
 *      'quest' tag for a reward `add`. A tag filter reports the player's entire
 *      net worth as freshly earned credits.
 *
 *   2. Overwriting the mirror from a response while events are still queued.
 *      Mid-flush the local number is legitimately AHEAD of the server, and
 *      adopting the server's answer there takes credits off the player's HUD
 *      and puts them back a second later.
 */

/** The smallest bus that satisfies Economy and CreditReporter. */
function makeBus() {
  const handlers = new Map();
  return {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(fn);
      return () => handlers.get(name)?.delete(fn);
    },
    emit(name, payload) {
      for (const fn of handlers.get(name) ?? []) fn(payload);
    },
  };
}

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

/** A fetch stand-in that records what it was sent and replies with a balance. */
function makeFetch(balance = 0, { fail = false } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (fail) throw new Error('offline');
    return { ok: true, json: async () => ({ balance }) };
  };
  fn.calls = calls;
  return fn;
}

function setup({ balance = 0, fail = false, storage } = {}) {
  const bus = makeBus();
  const economy = new Economy({ bus, credits: 100 });
  const fetchImpl = makeFetch(balance, { fail });
  const reporter = new CreditReporter({
    bus,
    economy,
    storage: storage ?? makeStorage(),
    fetch: fetchImpl,
  });
  return { bus, economy, reporter, fetchImpl };
}

test('queues nothing until an account is known', () => {
  const { economy, reporter } = setup();
  economy.add(50, 'kill');
  assert.equal(reporter.pending, 0, 'a signed-out player keeps credits locally, as before');
});

test('queues an earn and a spend once started', () => {
  const { economy, reporter } = setup();
  reporter.start();
  economy.add(50, 'kill');
  economy.spend(20, 'market');
  assert.equal(reporter.pending, 2);
});

test('reports the sign of the change, so buying and selling are distinguishable', () => {
  const { economy, reporter } = setup();
  reporter.start();
  economy.add(30, 'market');   // selling an item back
  economy.spend(80, 'market'); // buying one
  const deltas = reporter._queue.map((e) => e.delta);
  assert.deepEqual(deltas, [30, -80]);
});

/* ══════════════════════════════════════════════════════════════════════════
 *  WHICH ROW WAS BOUGHT
 *
 *  A marketplace debit is a CATALOGUE PURCHASE and the server prices it from
 *  `marketplace_items.cost_buy`. The event has to say which row, because
 *  `{key, reason, delta}` could not — and that is what let a 1,071-credit item
 *  be bought for 1 credit, driven live against production.
 *
 *  A purchase that arrives with no item id is REFUSED, not charged at the
 *  browser's number. So every place the id can be dropped between
 *  `Marketplace.buy` and the request body is a place where purchases silently
 *  stop being charged, and each one gets a test here rather than a scrape.
 * ══════════════════════════════════════════════════════════════════════════ */

test('carries the item id of a purchase all the way into the request body', async () => {
  const { economy, reporter, fetchImpl } = setup({ balance: 20 });
  reporter.start();
  economy.spend(80, 'market', { itemId: 'aa11bb22-cc33-4d44-8e55-ff6677889900' });
  await reporter.flush();
  const [event] = fetchImpl.calls[0].body.events;
  assert.equal(event.itemId, 'aa11bb22-cc33-4d44-8e55-ff6677889900');
  assert.equal(event.delta, -80);
});

test('carries a source_key reference too, for the offline catalogue', () => {
  // The bundled shop keys its rows `${source_key}:${world}` deliberately, so an
  // offline purchase and an online one name the same row. Accepting only a UUID
  // would make every offline purchase unresolvable, and therefore free.
  const { economy, reporter } = setup();
  reporter.start();
  economy.spend(40, 'market', { itemId: 'spell_velocity_25:station' });
  assert.equal(reporter._queue[0].itemId, 'spell_velocity_25:station');
});

test('a queued purchase survives a reload with its item id', () => {
  // The queue is durable precisely because a crash must not cost the player.
  // A restored purchase that lost its item id is one the server will refuse.
  const storage = makeStorage();
  const first = setup({ storage });
  first.reporter.start();
  first.economy.spend(80, 'market', { itemId: 'aa11bb22-cc33-4d44-8e55-ff6677889900' });

  const second = setup({ storage });
  assert.equal(second.reporter.pending, 1);
  assert.equal(second.reporter._queue[0].itemId, 'aa11bb22-cc33-4d44-8e55-ff6677889900');
});

test('puts no item id on anything that is not a purchase', () => {
  // `credits:changed` is the funnel for all 22 credit sources. A field that
  // appeared on every event would be one more thing for the server to ignore.
  const { economy, reporter } = setup();
  reporter.start();
  economy.add(5, 'kill');
  economy.add(30, 'market');
  economy.spend(10, 'inventory');
  for (const e of reporter._queue) {
    assert.equal('itemId' in e, false, `${e.reason} carried an itemId`);
  }
});

test('NEVER reports a set, whatever it is tagged', () => {
  // The defect this guards: QuestSystem writes the server's absolute balance
  // with economy.set(next, 'quest'), and a reason-based filter would report the
  // whole balance as earnings. The operation is the honest discriminator.
  const { economy, reporter } = setup();
  reporter.start();
  economy.set(9000, 'quest');
  economy.set(50, 'account-sync');
  economy.set(60, 'load');
  assert.equal(reporter.pending, 0);
});

test('gives every event a distinct key', () => {
  const { economy, reporter } = setup();
  reporter.start();
  for (let i = 0; i < 25; i++) economy.add(5, 'kill');
  const keys = new Set(reporter._queue.map((e) => e.key));
  assert.equal(keys.size, 25, 'a repeated key would be refused as a duplicate and go unpaid');
});

test('sends the queue and drops exactly what was acknowledged', async () => {
  const { economy, reporter, fetchImpl } = setup({ balance: 155 });
  reporter.start();
  economy.add(50, 'kill');
  economy.add(5, 'loot');
  await reporter.flush();

  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].body.events.length, 2);
  assert.equal(reporter.pending, 0);
});

test('adopts the server balance once the queue has drained', async () => {
  const { economy, reporter } = setup({ balance: 155 });
  reporter.start();
  economy.add(50, 'kill');
  await reporter.flush();
  assert.equal(economy.credits, 155, 'the server owns the number');
});

test('does NOT adopt the server balance while events are still queued', async () => {
  // Mid-flush the local number is legitimately ahead: the player has earned
  // things the server has not been told about. Adopting here would visibly take
  // credits away and hand them back on the next tick.
  const bus = makeBus();
  const economy = new Economy({ bus, credits: 100 });
  const storage = makeStorage();
  let reporter;
  const fetchImpl = async (_url, init) => {
    JSON.parse(init.body);
    // A kill lands while the request is in flight.
    economy.add(5, 'kill');
    return { ok: true, json: async () => ({ balance: 150 }) };
  };
  reporter = new CreditReporter({ bus, economy, storage, fetch: fetchImpl });
  reporter.start();
  economy.add(50, 'kill');
  const before = economy.credits;
  await reporter.flush();

  assert.equal(reporter.pending, 1, 'the in-flight earning is still queued');
  assert.equal(economy.credits, before + 5, 'the mirror kept the local total');
  assert.notEqual(economy.credits, 150);
});

test('keeps the queue when the request fails, and re-sends the same keys', async () => {
  const { economy, reporter, fetchImpl } = setup({ fail: true });
  reporter.start();
  economy.add(50, 'kill');
  const keyBefore = reporter._queue[0].key;

  await reporter.flush();
  assert.equal(reporter.pending, 1, 'a lost request must not cost the player the earning');
  assert.equal(reporter._queue[0].key, keyBefore, 'a fresh key would be paid a second time');
  assert.equal(fetchImpl.calls.length, 1);
});

test('a queue survives a reload, keys and all', () => {
  // The closed-tab case. sendBeacon cannot confirm delivery, so the queue is
  // deliberately left behind and re-sent; dedup is what makes that free.
  const storage = makeStorage();
  const first = setup({ storage });
  first.reporter.start();
  first.economy.add(50, 'kill');
  first.economy.add(120, 'relic');
  const keys = first.reporter._queue.map((e) => e.key);

  // A new boot against the same storage.
  const second = setup({ storage });
  assert.deepEqual(second.reporter._queue.map((e) => e.key), keys);
  assert.equal(second.reporter.pending, 2);
});

test('a corrupt stored queue does not break the boot', () => {
  const storage = makeStorage();
  storage.setItem('aether:credit-queue:v1', '{not json');
  const { reporter } = setup({ storage });
  assert.equal(reporter.pending, 0);
});

test('stops growing rather than queueing without limit', () => {
  const { economy, reporter } = setup();
  reporter.start();
  for (let i = 0; i < 2100; i++) economy.add(1, 'kill');
  assert.ok(reporter.pending <= 2000, `queue grew to ${reporter.pending}`);
});
