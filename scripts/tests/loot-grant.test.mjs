import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as LootMod from '../../src/systems/Loot.js';

/**
 * A PICKUP THAT GRANTS A MOUNT POWER.
 *
 * The map editor can place a marketplace mount upgrade in a world. Its pickup
 * holds a GRANT - `{ grant: { effect, mount, power, tier, name }, qty: 1 }` -
 * where every other pickup holds an item id, and collecting it must do
 * exactly what buying the row does: emit `mount:power:buy`, which main.js
 * already routes to `MountManager.grantPower` and persists locally and
 * remotely. Nothing new listens; the purchase path is the grant path.
 *
 * `Loot`'s constructor paints canvas textures and cannot run under Node, so
 * the decision is a module function `collectEntry` that `_collect` calls
 * once per entry, and the label and accent are `labelFor` / `accentFor`.
 * These are the tests those functions failed before they existed.
 */

const GRANT = { effect: 'grant_mount_power', mount: 'bicycle', power: 'power', tier: 3, name: 'Bicycle Speed III' };

function makeBus() {
  const emitted = [];
  return { emitted, emit: (name, payload) => emitted.push({ name, payload }) };
}

/** An inventory that records every call, so "never touched" is an assertion and not a hope. */
function makeInventory() {
  const calls = [];
  return { calls, acquire: (itemId, qty) => (calls.push({ itemId, qty }), { taken: qty, dropped: 0 }) };
}

test('the pure parts are exported: collectEntry, labelFor, accentFor, grantLabel', () => {
  for (const name of ['collectEntry', 'labelFor', 'accentFor', 'grantLabel']) {
    assert.equal(typeof LootMod[name], 'function', `Loot.js does not export ${name}`);
  }
});

test('collecting a grant emits exactly the purchase event, at no cost and with no catalogue row, and counts as taken', () => {
  const bus = makeBus();
  const inventory = makeInventory();
  const pickup = { tag: 'overlay:p5' };
  const out = LootMod.collectEntry({ grant: GRANT, qty: 1 }, { bus, inventory, economy: null, fromCache: false, pickup });

  assert.deepEqual(out, { taken: true, left: null });
  const buys = bus.emitted.filter((e) => e.name === 'mount:power:buy');
  assert.equal(buys.length, 1, 'one purchase event, exactly');
  assert.deepEqual(buys[0].payload, { mount: 'bicycle', power: 'power', tier: 3, catalogId: null, cost: 0 });
  const collected = bus.emitted.filter((e) => e.name === 'loot:collected');
  assert.equal(collected.length, 1, 'the canonical pickup event, once');
  assert.equal(collected[0].payload.pickup, pickup);
  assert.equal(collected[0].payload.fromCache, false);
  assert.deepEqual(collected[0].payload.grant, GRANT);
  assert.equal(collected[0].payload.qty, 1);
  assert.ok(bus.emitted.some((e) => e.name === 'hud:notify' && /Bicycle Speed III/.test(e.payload.text)), 'the HUD names what was granted');
  assert.deepEqual(inventory.calls, [], 'a grant is not stock: the inventory is never asked');
});

test('the item branches are unchanged: credits go to the economy, an item to the inventory, and what will not fit is left', () => {
  const bus = makeBus();
  const added = [];
  const economy = { add: (qty, reason) => added.push({ qty, reason }) };
  assert.deepEqual(LootMod.collectEntry({ itemId: 'credits', qty: 7 }, { bus, economy, inventory: null, fromCache: true, pickup: null }), { taken: true, left: null });
  assert.deepEqual(added, [{ qty: 7, reason: 'loot' }]);
  assert.deepEqual(bus.emitted.map((e) => e.name), ['loot:collected']);
  assert.equal(bus.emitted[0].payload.fromCache, true);

  const inventory = { acquire: () => ({ taken: 2, dropped: 3, toStore: 0 }) };
  const out = LootMod.collectEntry({ itemId: 'bullet', qty: 5 }, { bus: makeBus(), economy, inventory, fromCache: false, pickup: null });
  assert.deepEqual(out, { taken: true, left: { itemId: 'bullet', qty: 3 } });

  const none = LootMod.collectEntry({ itemId: 'bullet', qty: 5 }, { bus: makeBus(), economy, inventory: { acquire: () => ({ taken: 0, dropped: 5 }) }, fromCache: false, pickup: null });
  assert.deepEqual(none, { taken: false, left: { itemId: 'bullet', qty: 5 } });
  assert.deepEqual(LootMod.collectEntry({ itemId: 'bullet', qty: 5 }, { bus: makeBus(), economy, inventory: null, fromCache: false, pickup: null }), { taken: false, left: { itemId: 'bullet', qty: 5 } });
});

test('a grant is labelled by its catalogue name, or by mount, stat and roman tier when it has none', () => {
  assert.equal(LootMod.grantLabel(GRANT), 'Bicycle Speed III');
  assert.equal(LootMod.grantLabel({ effect: 'grant_mount_power', mount: 'bicycle', power: 'power', tier: 3 }), 'Bicycle Speed III');
  assert.equal(LootMod.grantLabel({ effect: 'grant_mount_power', mount: 'dragon', power: 'fire', tier: 1 }), 'Dragon Fire I');
  assert.equal(LootMod.grantLabel({ effect: 'grant_mount_power', mount: 'horse', power: 'strength', tier: 2, name: '' }), 'Horse Acceleration II');
  // A pickup's label: a grant carries no count, an item still does.
  assert.equal(LootMod.labelFor([{ grant: GRANT, qty: 1 }]), 'Bicycle Speed III');
  assert.equal(LootMod.labelFor([{ itemId: 'bullet', qty: 60 }, { grant: GRANT, qty: 1 }]), '60 RND · Bicycle Speed III');
});

test('a grant takes the consumable accent, and never outranks a skin or a trinket in a mixed pickup', () => {
  assert.equal(LootMod.accentFor([{ grant: GRANT, qty: 1 }]), 'consumable');
  assert.equal(LootMod.accentFor([{ itemId: 'bullet', qty: 60 }, { grant: GRANT, qty: 1 }]), 'consumable');
  assert.equal(LootMod.accentFor([{ itemId: 'nexus_shard', qty: 1 }, { grant: GRANT, qty: 1 }]), 'trinket');
  assert.equal(LootMod.accentFor([{ itemId: 'credits', qty: 4 }]), 'currency');
});
