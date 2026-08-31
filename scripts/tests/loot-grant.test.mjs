import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as LootMod from '../../src/systems/Loot.js';
import { mountPowerItemId } from '../../src/systems/ItemDefs.js';

/**
 * A PICKUP THAT GRANTS A MOUNT POWER.
 *
 * The map editor can place a marketplace mount upgrade in a world. Its pickup
 * holds a GRANT - `{ grant: { effect, mount, power, tier, name }, qty: 1 }` -
 * where every other pickup holds an item id.
 *
 * WHAT CHANGED, and why some of these assertions are the reverse of the ones
 * that stood here: collecting a grant used to emit `mount:power:buy` on the
 * spot and never call `inventory.acquire`, so the upgrade applied itself and
 * the bag stayed empty. The player's report was "it shows I picked them up,
 * but the inventory does not show them so I cannot use them". A grant now
 * lands as a `mountpower` bag item which the player fits from the inventory
 * panel (`ItemUse._useMountPower`); that is where `mount:power:buy` is emitted
 * now, and the pickup is stock like every other - a full bag leaves it lying
 * there.
 *
 * `Loot`'s constructor paints canvas textures and cannot run under Node, so
 * the decision is a module function `collectEntry` that `_collect` calls
 * once per entry, and the label and accent are `labelFor` / `accentFor`.
 * These are the tests those functions failed before they existed.
 */

const GRANT = { effect: 'grant_mount_power', mount: 'bicycle', power: 'power', tier: 3, name: 'Bicycle Speed III' };
const GRANT_ITEM = mountPowerItemId('bicycle', 'power', 3);

function makeBus() {
  const emitted = [];
  return { emitted, emit: (name, payload) => emitted.push({ name, payload }) };
}

/** An inventory that records every call, so "was asked, and for what" is an assertion. */
function makeInventory(result = null) {
  const calls = [];
  return {
    calls,
    acquire: (itemId, qty) => (calls.push({ itemId, qty }), result ?? { taken: qty, toBag: qty, toStore: 0, dropped: 0 }),
  };
}

test('the pure parts are exported: collectEntry, labelFor, accentFor, grantLabel', () => {
  for (const name of ['collectEntry', 'labelFor', 'accentFor', 'grantLabel']) {
    assert.equal(typeof LootMod[name], 'function', `Loot.js does not export ${name}`);
  }
});

test('collecting a grant puts a row in the bag and does NOT fit the upgrade', () => {
  const bus = makeBus();
  const inventory = makeInventory();
  const pickup = { tag: 'overlay:p5' };
  const out = LootMod.collectEntry({ grant: GRANT, qty: 1 }, { bus, inventory, economy: null, fromCache: false, pickup });

  assert.deepEqual(out, { taken: true, left: null });
  assert.deepEqual(inventory.calls, [{ itemId: GRANT_ITEM, qty: 1 }], 'exactly one unit of the upgrade item');
  assert.equal(
    bus.emitted.filter((e) => e.name === 'mount:power:buy').length, 0,
    'a pickup must not fit the upgrade; the player does that from the bag',
  );
  const collected = bus.emitted.filter((e) => e.name === 'loot:collected');
  assert.equal(collected.length, 1, 'the canonical pickup event, once');
  assert.equal(collected[0].payload.pickup, pickup);
  assert.equal(collected[0].payload.fromCache, false);
  assert.equal(collected[0].payload.itemId, null, 'null, so HUD.js lets the grant name itself');
  assert.deepEqual(collected[0].payload.grant, GRANT);
  assert.equal(collected[0].payload.qty, 1);
  assert.ok(bus.emitted.some((e) => e.name === 'hud:notify' && /Bicycle Speed III/.test(e.payload.text)), 'the HUD names what was collected');
});

test('a full bag leaves the upgrade on the ground, still shaped as a grant, and reports nothing taken', () => {
  const bus = makeBus();
  const inventory = makeInventory({ taken: 0, toBag: 0, toStore: 0, dropped: 1 });
  const out = LootMod.collectEntry({ grant: GRANT, qty: 1 }, { bus, inventory, economy: null, fromCache: false, pickup: null });

  assert.deepEqual(out, { taken: false, left: { grant: GRANT, qty: 1 } });
  assert.equal(bus.emitted.length, 0, 'nothing was collected, so nothing is announced');

  // The remainder must still read as a grant, or the pickup left behind would
  // relabel itself and MapOverlay._sweepOwned would stop recognising it.
  assert.equal(LootMod.labelFor([out.left]), 'Bicycle Speed III');
  assert.equal(LootMod.accentFor([out.left]), 'mountpower');
});

test('an inventory that is not wired refuses the grant rather than swallowing it', () => {
  const out = LootMod.collectEntry({ grant: GRANT, qty: 1 }, { bus: makeBus(), inventory: null, economy: null, fromCache: false, pickup: null });
  assert.deepEqual(out, { taken: false, left: { grant: GRANT, qty: 1 } });
});

test('an overflow into the store is taken, and says so', () => {
  const bus = makeBus();
  const inventory = makeInventory({ taken: 1, toBag: 0, toStore: 1, dropped: 0 });
  const out = LootMod.collectEntry({ grant: GRANT, qty: 1 }, { bus, inventory, economy: null, fromCache: false, pickup: null });
  assert.deepEqual(out, { taken: true, left: null });
  assert.ok(bus.emitted.some((e) => e.name === 'hud:notify' && /\(store\)/.test(e.payload.text)));
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

test('a grant takes the accent of the item it yields, and outranks everything but a skin', () => {
  // It used to read `consumable`, which was true while collecting one applied
  // a power on the spot. It yields a `mountpower` row now, and the pickup on
  // the floor has to be the colour of the thing that lands in the bag.
  assert.equal(LootMod.accentFor([{ grant: GRANT, qty: 1 }]), 'mountpower');
  assert.equal(LootMod.accentFor([{ itemId: 'bullet', qty: 60 }, { grant: GRANT, qty: 1 }]), 'mountpower');
  assert.equal(LootMod.accentFor([{ itemId: 'nexus_shard', qty: 1 }, { grant: GRANT, qty: 1 }]), 'mountpower');
  assert.equal(LootMod.accentFor([{ itemId: 'credits', qty: 4 }]), 'currency');
});
