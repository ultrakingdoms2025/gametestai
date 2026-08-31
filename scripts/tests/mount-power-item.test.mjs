import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

import {
  ITEMS, itemDef, isItem, SELL_RATE, MOUNT_POWER_TIERS,
  mountPowerItemId, mountPowerFromItem, mountPowerName,
} from '../../src/systems/ItemDefs.js';
import { MOUNT_STATS } from '../../src/mounts/Livery.js';
import { Inventory } from '../../src/systems/Inventory.js';
import { ItemUseSystem } from '../../src/systems/ItemUse.js';
import { Marketplace } from '../../src/systems/Marketplace.js';
import * as LootMod from '../../src/systems/Loot.js';
import { MapOverlay } from '../../src/systems/MapOverlay.js';

/**
 * A PLACED MOUNT UPGRADE IS A THING YOU CARRY.
 *
 * The defect: `Loot.collectEntry`'s grant branch emitted `mount:power:buy` and
 * returned `taken: true` without ever calling `inventory.acquire`. A mount
 * upgrade placed with the map editor played the collect flourish, toasted
 * `+Bicycle Speed I`, and wrote no inventory row - reported as "it shows I
 * picked them up, but the inventory does not show them so I cannot use them".
 *
 * The fix follows the mount-skin precedent exactly: one generated bag item per
 * mount power tier, `ItemUse` applies it and consumes only on success, and the
 * pickup is stock like every other. This file is the contract for all of it,
 * including the exploit the fix could easily have opened - an upgrade that no
 * longer applies itself is an upgrade the owner check cannot see, so the
 * pickup would respawn on every world build and farm without limit.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let catalogPromise = null;
/** The site's TypeScript catalogue, bundled the way mount-catalog.test.mjs does. */
function loadCatalog() {
  if (!catalogPromise) {
    catalogPromise = build({
      entryPoints: [path.join(root, 'site/lib/marketplaceCatalog.ts')],
      bundle: true, write: false, format: 'esm', platform: 'node', target: 'node22', logLevel: 'silent',
      resolveExtensions: ['.ts', '.js'],
    }).then((r) => import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`));
  }
  return catalogPromise;
}

function makeBus() {
  const emitted = [];
  return {
    emitted,
    emit: (name, payload) => emitted.push({ name, payload }),
    // MapOverlay and Inventory both subscribe; the handlers are kept so a test
    // can fire `game:started` by hand.
    handlers: new Map(),
    on(name, fn) {
      const list = this.handlers.get(name) ?? [];
      list.push(fn);
      this.handlers.set(name, list);
      return () => {};
    },
    fire(name, payload) {
      for (const fn of this.handlers.get(name) ?? []) fn(payload);
    },
  };
}

/** A bare `Inventory` with no starter kit and no DOM, so counts are exactly what a test put in. */
function makeInventory() {
  return new Inventory({ bus: makeBus(), ui: false, starter: false });
}

/**
 * The mount ledger reads `ItemUse` needs, over the REAL `MOUNT_STATS` table,
 * plus a writable record of what `grantPower` was asked to do - so "consumed
 * exactly one unit AND fitted exactly one tier" is two assertions, not one.
 *
 * `off` is the switch record: `{ [mount]: { [power]: true } }`, answered
 * through `isPowerEnabled` exactly as `MountManager` answers it - anything not
 * explicitly switched off is on.
 */
function makeMounts(owned = {}, off = {}) {
  const granted = [];
  return {
    granted,
    sellsPower: (mount, power) => (MOUNT_STATS[mount] ? MOUNT_STATS[mount].includes(power) : true),
    getPowers: (mount) => ({ ...(owned[mount] ?? {}) }),
    isPowerEnabled: (mount, power) => !off[mount]?.[power],
    grantPower: (mount, power, tier) => {
      granted.push({ mount, power, tier });
      const bag = owned[mount] || (owned[mount] = {});
      bag[power] = Math.max(bag[power] || 0, tier);
    },
    owned,
    off,
  };
}

/* ====================================================================== */
/* 1. One item per catalogued mount power                                 */
/* ====================================================================== */

test('there is one bag item for every mount power tier the game declares', () => {
  let expected = 0;
  for (const mount of Object.keys(MOUNT_STATS)) {
    for (const power of MOUNT_STATS[mount]) {
      for (let tier = 1; tier <= MOUNT_POWER_TIERS; tier++) {
        expected++;
        const id = mountPowerItemId(mount, power, tier);
        const def = itemDef(id);
        assert.ok(def, `no item for ${mount}/${power}/${tier}`);
        assert.equal(def.kind, 'mountpower');
        // A tier is not a quantity: two of one upgrade is not twice as fast.
        assert.equal(def.stack, 1, `${id} must occupy one slot per unit`);
        assert.ok(def.value > 0, `${id} has no value`);
        assert.equal(def.icon, 'mountpower');
        assert.ok(def.desc && def.desc.length > 20, `${id} has no description worth reading`);
        assert.deepEqual(mountPowerFromItem(id), { mount, power, tier });
      }
    }
  }
  const generated = Object.keys(ITEMS).filter((id) => ITEMS[id].kind === 'mountpower');
  assert.equal(generated.length, expected, 'no mount power item without a stat behind it');
});

test('every catalogue grant_mount_power row resolves to an item that exists', async () => {
  const { BASE_ITEMS } = await loadCatalog();
  const rows = BASE_ITEMS.filter((r) => r.action_config?.effect === 'grant_mount_power');
  assert.ok(rows.length >= 57, `expected the full mount ladder, got ${rows.length}`);
  for (const r of rows) {
    const { mount, power, tier } = r.action_config;
    const id = mountPowerItemId(mount, power, tier);
    assert.ok(isItem(id), `${r.source_key}: nothing in the bag can hold ${mount} ${power} ${tier}`);
    assert.equal(itemDef(id).kind, 'mountpower');
  }
});

test('an upgrade is worth far less than the shop charges, and no vendor will take it anyway', async () => {
  const { BASE_ITEMS } = await loadCatalog();
  const rows = BASE_ITEMS.filter((r) => r.action_config?.effect === 'grant_mount_power');
  for (const r of rows) {
    const { mount, power, tier } = r.action_config;
    const def = itemDef(mountPowerItemId(mount, power, tier));
    // The same buy->sell->buy rule the skin rows are held to: a placed pickup
    // that can be sold back for near its shop price is an arbitrage.
    const sellBack = def.value * SELL_RATE;
    assert.ok(r.cost_buy >= sellBack * 3, `${r.source_key}: cost_buy ${r.cost_buy} < 3x sell-back ${sellBack}`);
    // And the door is shut regardless: no vendor buys a mount upgrade back.
    assert.equal(def.noSell, true, `${def.id} must not be sellable`);
  }
});

test('the ground and the bag call an upgrade the same thing', () => {
  // `Loot.grantLabel` falls back to `mountPowerName`, so the toast on
  // collection and the row in the bag cannot drift apart.
  for (const [mount, powers] of Object.entries(MOUNT_STATS)) {
    for (const power of powers) {
      for (let tier = 1; tier <= MOUNT_POWER_TIERS; tier++) {
        const label = LootMod.grantLabel({ effect: 'grant_mount_power', mount, power, tier });
        assert.equal(label, mountPowerName(mount, power, tier));
        assert.equal(label, itemDef(mountPowerItemId(mount, power, tier)).name);
      }
    }
  }
  assert.equal(mountPowerName('bicycle', 'power', 3), 'Bicycle Speed III');
  assert.equal(mountPowerName('horse', 'strength', 2), 'Horse Acceleration II');
});

test('a mount upgrade is offered the hold-to-use gesture, exactly as a skin is', async () => {
  /* Read as source because `InventoryUI` paints DOM and cannot be built here.
   * The gate is `_hasUse(def)`, which decides which rows get the hold ring and
   * the Use button; a kind it does not name is a row the player can carry and
   * never spend, which is the reported defect one step further along. */
  const src = await import('node:fs/promises').then((fs) => fs.readFile(path.join(root, 'src/ui/InventoryUI.js'), 'utf8'));
  const body = /_hasUse\(def\)\s*\{([^}]*)\}/.exec(src);
  assert.ok(body, 'InventoryUI._hasUse is not where this test expects it');
  assert.match(body[1], /mountpower/, 'InventoryUI._hasUse does not know the kind, so no ring and no Use button');
  assert.match(body[1], /skin/, 'and the skin precedent it copies is still there');
});

/* ====================================================================== */
/* 2. A placed grant produces an inventory row                            */
/* ====================================================================== */

test('collecting a placed grant writes a real inventory row', () => {
  const inventory = makeInventory();
  const bus = makeBus();
  const grant = { effect: 'grant_mount_power', mount: 'bicycle', power: 'power', tier: 1, name: 'Bicycle Speed I' };
  const out = LootMod.collectEntry({ grant, qty: 1 }, { bus, inventory, economy: null, fromCache: false, pickup: null });

  assert.equal(out.taken, true);
  assert.equal(out.left, null);
  assert.equal(inventory.totalCount(mountPowerItemId('bicycle', 'power', 1)), 1, 'the row the player reported missing');
  assert.equal(
    bus.emitted.filter((e) => e.name === 'mount:power:buy').length, 0,
    'the power is NOT granted on collection any more',
  );
});

test('a full bag leaves the pickup in the world', () => {
  const inventory = makeInventory();
  // Fill every one of the 30 bag slots and all 60 store slots with distinct
  // single-slot stacks, so `acquire` has nowhere at all to put the upgrade.
  const singles = Object.keys(ITEMS).filter((id) => ITEMS[id].stack === 1 && !ITEMS[id].virtual);
  assert.ok(singles.length >= 90, 'not enough one-slot items to fill both containers');
  for (const id of singles.slice(0, 90)) inventory.acquire(id, 1);
  assert.equal(inventory.roomFor('mountpower_bicycle_power_2'), 0, 'the bag and the store are both full');

  const grant = { effect: 'grant_mount_power', mount: 'bicycle', power: 'power', tier: 2, name: 'Bicycle Speed II' };
  const out = LootMod.collectEntry({ grant, qty: 1 }, { bus: makeBus(), inventory, economy: null, fromCache: false, pickup: null });

  assert.equal(out.taken, false, 'nothing was accepted, so nothing was taken');
  assert.deepEqual(out.left, { grant, qty: 1 }, 'the upgrade stays on the ground, still a grant');
});

/* ====================================================================== */
/* 3. Applying it                                                         */
/* ====================================================================== */

test('using a mount upgrade consumes exactly one unit and emits the purchase event', () => {
  const bus = makeBus();
  const inventory = makeInventory();
  const mounts = makeMounts();
  const id = mountPowerItemId('dragon', 'fire', 2);
  inventory.addToBag(id, 1);

  const itemUse = new ItemUseSystem({ bus, inventory, mounts });
  const res = itemUse.use(id);

  assert.equal(res.ok, true);
  assert.equal(inventory.totalCount(id), 0, 'exactly the one unit, spent');
  const buys = bus.emitted.filter((e) => e.name === 'mount:power:buy');
  assert.equal(buys.length, 1);
  assert.deepEqual(buys[0].payload, { mount: 'dragon', power: 'fire', tier: 2, catalogId: null, cost: 0 });
  assert.ok(bus.emitted.some((e) => e.name === 'inventory:item-used' && e.payload.itemId === id));
  assert.ok(bus.emitted.some((e) => e.name === 'hud:notify' && /Dragon Fire II/.test(e.payload.text)));
});

test('a mount upgrade never reaches the generic consumable path, so it needs no player', () => {
  // `use()` returns `unavailable` for everything below the skin dispatch when
  // `player` is missing. A mount upgrade is dispatched above that line.
  const inventory = makeInventory();
  const id = mountPowerItemId('horse', 'shield', 1);
  inventory.addToBag(id, 1);
  const itemUse = new ItemUseSystem({ bus: makeBus(), inventory, mounts: makeMounts(), player: null });
  assert.equal(itemUse.use(id).ok, true);
});

test('an upgrade the rider already runs is REFUSED and kept, not spent for nothing', () => {
  const bus = makeBus();
  const inventory = makeInventory();
  const mounts = makeMounts({ bicycle: { power: 3 } });
  const id = mountPowerItemId('bicycle', 'power', 2);
  inventory.addToBag(id, 1);

  const res = new ItemUseSystem({ bus, inventory, mounts }).use(id);

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'owned');
  assert.equal(inventory.totalCount(id), 1, 'the kit is still in the bag');
  assert.equal(mounts.granted.length, 0);
  const warn = bus.emitted.find((e) => e.name === 'hud:notify');
  assert.ok(warn, 'a refusal that says nothing is indistinguishable from a broken button');
  assert.equal(warn.payload.tone, 'warn');
  assert.match(warn.payload.text, /already runs this fitting at tier 3/);
});

test('an upgrade the rider owns but has SWITCHED OFF is refused, kept, and says where the switch is', () => {
  /* The refusal a player actually hits once fittings became switchable: they
   * turned Speed off, watched the mount go back to stock, and reached for the
   * spare kit in their bag to put it back. Told only "already runs this
   * fitting", they would conclude the kit was broken. And the kit must NOT be
   * spent on flipping a switch they can flip for free.
   */
  const bus = makeBus();
  const inventory = makeInventory();
  const mounts = makeMounts({ bicycle: { power: 3 } }, { bicycle: { power: true } });
  const id = mountPowerItemId('bicycle', 'power', 2);
  inventory.addToBag(id, 1);

  const res = new ItemUseSystem({ bus, inventory, mounts }).use(id);

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'owned');
  assert.equal(inventory.totalCount(id), 1, 'still refused, still kept');
  assert.equal(mounts.granted.length, 0);
  assert.deepEqual(mounts.off.bicycle, { power: true }, 'and it did NOT quietly switch itself back on');
  const warn = bus.emitted.find((e) => e.name === 'hud:notify');
  assert.equal(warn.payload.tone, 'warn');
  assert.match(warn.payload.text, /switched OFF/);
  assert.match(warn.payload.text, /Customise mount/, 'the message has to say where the switch lives');
  assert.match(warn.payload.text, /tier 3/, 'and still name the tier they own');
});

test('an unwired mount ledger refuses the use and leaves the kit in the bag', () => {
  const inventory = makeInventory();
  const id = mountPowerItemId('car', 'shield', 1);
  inventory.addToBag(id, 1);
  const res = new ItemUseSystem({ bus: makeBus(), inventory, mounts: null }).use(id);
  assert.equal(res.ok, false);
  assert.equal(inventory.totalCount(id), 1);
});

test('a stat the mount does not sell is refused before the consume', () => {
  // Reachable only through a stale save or a rename - the generated items come
  // from MOUNT_STATS - but `grantPower` DROPS such a grant silently, so
  // consuming for it would destroy the kit for nothing.
  const inventory = makeInventory();
  const mounts = makeMounts();
  const id = mountPowerItemId('dragon', 'fire', 1);
  inventory.addToBag(id, 1);
  mounts.sellsPower = () => false;
  const res = new ItemUseSystem({ bus: makeBus(), inventory, mounts }).use(id);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'wrong-mount');
  assert.equal(inventory.totalCount(id), 1);
});

/* ====================================================================== */
/* 4. The anti-farming guard                                              */
/* ====================================================================== */

test('holding the upgrade counts as owning it, so the placement does not respawn', () => {
  const inventory = makeInventory();
  const mounts = makeMounts();
  const overlay = new MapOverlay({ bus: null, mounts, inventory, fetch: null });
  const grant = { effect: 'grant_mount_power', mount: 'bicycle', power: 'power', tier: 3 };

  assert.equal(overlay._ownsGrant(grant), false, 'nothing owned and nothing carried: the pickup belongs there');

  // Collect it. No power is granted - it is only a bag row - and that is
  // exactly the state in which the pickup used to come back for ever.
  LootMod.collectEntry({ grant, qty: 1 }, { bus: makeBus(), inventory, economy: null, fromCache: false, pickup: null });
  assert.deepEqual(mounts.getPowers('bicycle'), {}, 'collecting grants no power');
  assert.equal(overlay._ownsGrant(grant), true, 'carrying it is owning it');

  /* Fit it. `ItemUse` EMITS `mount:power:buy` rather than calling
   * `grantPower` itself - the same event a merchant purchase sends, which
   * main.js routes to the ledger and to both persists - so the bus has to be
   * wired here the way main.js wires it, or the tier never lands. */
  const useBus = makeBus();
  useBus.emit = (name, payload) => {
    useBus.emitted.push({ name, payload });
    if (name === 'mount:power:buy') mounts.grantPower(payload.mount || 'car', payload.power, payload.tier);
  };
  new ItemUseSystem({ bus: useBus, inventory, mounts }).use(mountPowerItemId('bicycle', 'power', 3));
  assert.equal(inventory.totalCount(mountPowerItemId('bicycle', 'power', 3)), 0, 'the kit is spent');
  assert.deepEqual(mounts.getPowers('bicycle'), { power: 3 }, 'and the tier is on the mount');
  assert.equal(overlay._ownsGrant(grant), true, 'fitted is owning it too');
  overlay.dispose();
});

test('the store counts as well as the bag, and a different tier does not', () => {
  const inventory = makeInventory();
  const overlay = new MapOverlay({ bus: null, mounts: makeMounts(), inventory, fetch: null });
  const tier2 = { effect: 'grant_mount_power', mount: 'horse', power: 'shield', tier: 2 };

  inventory.add(mountPowerItemId('horse', 'shield', 2), 1); // straight to the store
  assert.equal(overlay._ownsGrant(tier2), true, 'tidied away is not un-collected');
  assert.equal(
    overlay._ownsGrant({ ...tier2, tier: 3 }), false,
    'holding tier II says nothing about a tier III placement',
  );
  overlay.dispose();
});

test('the apply-time fast path and the game:started sweep agree, because both ask _ownsGrant', () => {
  const inventory = makeInventory();
  const mounts = makeMounts();
  const bus = makeBus();
  const overlay = new MapOverlay({ bus, mounts, inventory, fetch: null });
  const grant = { effect: 'grant_mount_power', mount: 'eagle', power: 'power', tier: 1 };

  // Stand in for what `_applyPlace` did on the entry world, before the save
  // was restored: the pickup was spawned because nothing was owned yet.
  const pickup = { active: true, contents: [{ grant, qty: 1 }] };
  const despawned = [];
  overlay.loot = { despawn: (p) => (despawned.push(p), true) };
  overlay._placed.push(pickup);

  // Now the save lands, carrying the upgrade in the bag, and the sweep runs.
  inventory.addToBag(mountPowerItemId('eagle', 'power', 1), 1);
  bus.fire('game:started');

  assert.deepEqual(despawned, [pickup], 'a second copy of a thing already carried is taken away');
  assert.equal(overlay._placed.length, 0);
  overlay.dispose();
});

test('a mount upgrade cannot be sold, so the pickup cannot be turned into a credit loop', () => {
  const inventory = makeInventory();
  const economy = { credits: 0, add(n) { this.credits += n; } };
  const id = mountPowerItemId('hoverboard', 'strength', 3);
  inventory.addToBag(id, 1);
  inventory.addToBag('medkit', 1);

  const market = new Marketplace({ bus: makeBus(), economy, inventory, ui: false });
  const ids = market.sellables.map((r) => r.id);
  assert.ok(!ids.includes(id), 'a vendor must not list a mount upgrade');
  assert.ok(ids.includes('medkit'), 'ordinary stock is still sellable');

  const res = market.sell(id, 1);
  assert.equal(res.ok, false, 'and must refuse one offered directly');
  assert.equal(economy.credits, 0);
  assert.equal(inventory.totalCount(id), 1);
  market.dispose?.();
});
