/**
 * THE BAG GROWS, AND EVERY LINK OF THE CHAIN THAT GROWS IT.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT IS NEW
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A bag has always held 30 slots and nothing has ever changed that number.
 * Three catalogue rows now sell rigs that do - `bag_expand_5`, `_10` and `_15`
 * - and using one runs `Inventory.expandBag`, which raises `bagCapacity`
 * towards a hard ceiling of 60 and never lowers it.
 *
 * Five things have to hold for that to be a feature rather than a rumour, and
 * each is a section below:
 *
 *   1. THE MODEL. `expandBag` adds exactly what fits and reports exactly what
 *      it added, and the cap holds against any amount of repetition.
 *   2. THE USE. A rig at the cap is REFUSED AND KEPT (`_canApply` runs before
 *      `consumeFromBag`); a rig that overshoots grants the part that fits, is
 *      consumed, and says the true number out loud.
 *   3. THE SAVE. Capacity round-trips, a save written before any of this
 *      existed restores at 30 rather than at 0 or `undefined`, and a
 *      hand-edited one cannot mint slots.
 *   4. THE SHOP. Three rows on the server, three in the offline mirror, and a
 *      real `ITEMS` entry behind each `source_key`.
 *   5. THE BALANCE. Purchase-only - no drop table, no cache table, no supply
 *      contract - and priced so no buy-sell-buy loop prints credits.
 *
 * ── THE DEFECT THIS WORK FOUND ON THE WAY PAST ─────────────────────────────
 *
 * `Inventory.serialize()` has ALWAYS emitted `capacity`. `deserialize()` has
 * always ignored it, and re-accepted the saved rows against whatever capacity
 * the instance happened to hold - which for a freshly constructed `Inventory`
 * is 30. That was harmless while 30 was the only capacity there was, and would
 * have become "thirty slots of your kit vanish on load" the moment the first
 * player fitted a rig. Section 3 is where that is pinned.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

import { Inventory, BAG_CAPACITY, BAG_CAPACITY_MAX } from '../../src/systems/Inventory.js';
import { ItemUseSystem } from '../../src/systems/ItemUse.js';
import { Marketplace } from '../../src/systems/Marketplace.js';
import { OFFLINE_BASE_ITEMS, offlineCatalog } from '../../src/systems/MarketplaceOffline.js';
import { ITEMS, SELL_RATE, isItem, itemDef, itemIconSVG } from '../../src/systems/ItemDefs.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFile(path.join(root, rel), 'utf8');

/** The three rigs, smallest first. The order is load-bearing in section 5. */
const RIGS = ['bag_expand_5', 'bag_expand_10', 'bag_expand_15'];

/* The catalogue is TypeScript in the site and cannot be imported directly; the
 * house pattern for reaching it from a test is esbuild, exactly as
 * `mount-catalog.test.mjs` does. Memoised - the bundle is the slow part. */
let catalogPromise = null;
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

/** A bus that records what the player would have been told. */
function recorder() {
  const events = [];
  return {
    events,
    emit(name, payload) { events.push({ name, payload }); },
    on() { return () => {}; },
    /** Text of the last `hud:notify`, or null. */
    lastToast() {
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].name === 'hud:notify') return events[i].payload?.text ?? null;
      }
      return null;
    },
  };
}

/**
 * A real `Inventory` and a real `ItemUseSystem` over it.
 *
 * Empty bag by default (`starter: false`) so slot arithmetic is about the rig
 * and nothing else, and `ui: false` so the model never reaches for a DOM that
 * does not exist here.
 */
function rig({ starter = false } = {}) {
  const bus = recorder();
  const inventory = new Inventory({ bus, ui: false, starter });
  /* A player is required by `ItemUse.use` before the generic effect path is
   * reached, and a bag rig needs nothing from it - the same relationship
   * `nav_chart` has, which is why it goes down the same path. */
  const player = { health: 100, maxHealth: 100 };
  const itemUse = new ItemUseSystem({ bus, player, inventory });
  return { bus, inventory, itemUse };
}

/* ====================================================================== */
/* 1. The model                                                           */
/* ====================================================================== */

test('a fresh bag starts at the contract capacity, and knows its own ceiling', () => {
  const { inventory } = rig();
  assert.equal(BAG_CAPACITY, 30, 'CONTRACTS-V3 says a bag starts at 30 slots');
  assert.equal(BAG_CAPACITY_MAX, 60);
  assert.equal(inventory.bagCapacity, BAG_CAPACITY);
  assert.equal(inventory.bagCapacityMax, BAG_CAPACITY_MAX);
});

test('expandBag adds exactly the slots asked for, and no more', () => {
  const { inventory } = rig();
  assert.equal(inventory.expandBag(5), 5, 'the return value is what was added');
  assert.equal(inventory.bagCapacity, 35);
  assert.equal(inventory.expandBag(10), 10);
  assert.equal(inventory.bagCapacity, 45);
  assert.equal(inventory.expandBag(15), 15);
  assert.equal(inventory.bagCapacity, 60);
});

test('the extra slots are real: the bag accepts stacks it could not hold before', () => {
  /* The capacity number moving is not the feature - what the player bought is
   * room. `medkit` stacks 5, so eight full stacks is eight slots; a 30-slot bag
   * that is already 28 slots deep takes two of them and a 40-slot bag takes
   * all eight. Driven through the real `_accept` path rather than asserted on
   * `bagCapacity`, because `_roomFor` is what a pickup actually asks. */
  const { inventory } = rig();
  inventory.addToBag('bullet', 60 * 28); // 28 slots of 60-round stacks
  assert.equal(inventory.bagUsed, 28);
  assert.equal(inventory.addToBag('medkit', 40), 10, 'only two slots left, five to a stack');

  inventory.expandBag(10);
  assert.equal(inventory.addToBag('medkit', 40), 40, 'the ten bought slots take the rest');
  assert.equal(inventory.bagUsed, 38, '28 slots of rounds and fifty medkits, five to a stack');
  assert.equal(inventory.bagRoomFor('medkit'), 10, 'and the two free slots left are still two slots');
});

test('the cap holds against repetition, in one lump or in twenty', () => {
  const one = rig().inventory;
  assert.equal(one.expandBag(500), 30, 'a single absurd ask is clamped to what fits');
  assert.equal(one.bagCapacity, BAG_CAPACITY_MAX);
  assert.equal(one.expandBag(5), 0, 'and nothing lands at the cap');
  assert.equal(one.bagCapacity, BAG_CAPACITY_MAX);

  const many = rig().inventory;
  let added = 0;
  for (let i = 0; i < 20; i++) added += many.expandBag(5);
  assert.equal(added, 30, 'twenty +5 rigs deliver thirty slots between them, not a hundred');
  assert.equal(many.bagCapacity, BAG_CAPACITY_MAX);
});

test('expandBag refuses nonsense without moving the capacity', () => {
  const { inventory } = rig();
  for (const bad of [0, -5, NaN, Infinity, null, undefined, '10 slots', {}]) {
    assert.equal(inventory.expandBag(bad), 0, `expandBag(${String(bad)}) added slots`);
  }
  assert.equal(inventory.bagCapacity, BAG_CAPACITY);
  // A fractional ask floors rather than throwing a fraction of a slot into the grid.
  assert.equal(inventory.expandBag(5.9), 5);
  assert.equal(inventory.bagCapacity, 35);
});

test('growing the bag announces itself on the one event the panel already reads', () => {
  /* No dedicated capacity event, deliberately: the panel rebuilds its tick bar
   * inside `_render`, which runs on `inventory:changed` and again on `open()`.
   * A second event would be a second subscription driving the same redraw, and
   * the failure that shape produces is a bar that quietly stops agreeing with
   * the bag. So the assertion is that `inventory:changed` fires AND that it
   * carries the new capacity - which is what makes the extra event needless. */
  const { bus, inventory } = rig();
  bus.events.length = 0;
  inventory.expandBag(10);
  const changed = bus.events.filter((e) => e.name === 'inventory:changed');
  assert.equal(changed.length, 1, 'exactly one redraw request');
  assert.equal(changed[0].payload.bagCapacity, 40);
  assert.deepEqual(bus.events.map((e) => e.name), ['inventory:changed'],
    'no second, capacity-specific event to forget to subscribe to');
});

/* ====================================================================== */
/* 2. The use                                                             */
/* ====================================================================== */

test('every rig is a consumable with a bagSlots figure, so the hold ring is drawn', () => {
  /* `InventoryUI._hasUse` offers the three-second ring for `consumable`,
   * `skin` and `mountpower` only. A rig of any other kind would be an effect
   * with no way to reach it - the defect `laser_cell` is on record for. */
  for (const id of RIGS) {
    const def = itemDef(id);
    assert.ok(def, `${id}: no ITEMS row`);
    assert.equal(def.kind, 'consumable', `${id}: InventoryUI would draw no Use ring`);
    assert.equal(def.bagSlots, Number(id.split('_').pop()), `${id}: bagSlots disagrees with its own id`);
    assert.ok(def.stack * def.bagSlots === BAG_CAPACITY_MAX - BAG_CAPACITY,
      `${id}: a full stack should be exactly the ${BAG_CAPACITY_MAX - BAG_CAPACITY} slots it takes to reach the cap`);
  }
});

test('a rig has an icon of its own and never falls through to the question mark', () => {
  for (const id of RIGS) {
    const svg = itemIconSVG(id);
    assert.match(svg, /^<svg /, `${id}: no icon markup`);
    // The `unknown` renderer's question-mark path, the same signature
    // `planet-minerals.test.mjs` watches for.
    assert.doesNotMatch(svg, /M16 20 v-2 q3 -1 3 -3\.5/,
      `${id}: icon "${itemDef(id).icon}" has no renderer, so it drew the question mark`);
  }
});

test('using a rig grants its slots, consumes it, and reports the true number', () => {
  const { bus, inventory, itemUse } = rig();
  inventory.addToBag('bag_expand_10', 1);

  const res = itemUse.use('bag_expand_10');
  assert.equal(res.ok, true);
  assert.equal(res.amount, 10);
  assert.equal(inventory.bagCapacity, 40);
  assert.equal(inventory.bagCount('bag_expand_10'), 0, 'the rig was spent');
  assert.equal(bus.lastToast(), '+10 slots — your bag now holds 40.');
});

test('a rig used at the cap is REFUSED AND KEPT, and the toast names the ceiling', () => {
  /* The whole point of asking `_canApply` before `consumeFromBag`. A rig eaten
   * for nothing at 60/60 is this file's neighbouring failure - "the unit
   * destroyed for nothing" - applied to the most expensive item in the shop. */
  const { bus, inventory, itemUse } = rig();
  inventory.expandBag(30);
  assert.equal(inventory.bagCapacity, BAG_CAPACITY_MAX);
  inventory.addToBag('bag_expand_5', 2);

  const res = itemUse.use('bag_expand_5');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'bag-full', 'its own reason code, so main.js does not stack a second toast');
  assert.equal(inventory.bagCount('bag_expand_5'), 2, 'THE ITEM IS STILL IN THE BAG');
  assert.equal(inventory.bagCapacity, BAG_CAPACITY_MAX);
  assert.equal(bus.lastToast(), 'Your bag already holds the maximum of 60 slots — kept, not spent.');
});

test('an overshooting rig grants the part that fits, is consumed, and says so', () => {
  /* Bag at 55, player uses a +10. Refusing would leave them holding an item
   * they can never spend; granting five and reporting ten would be the game
   * lying about the only thing they bought. So: grant five, spend the rig, and
   * print five. */
  const { bus, inventory, itemUse } = rig();
  inventory.expandBag(25);
  assert.equal(inventory.bagCapacity, 55);
  inventory.addToBag('bag_expand_10', 1);

  const res = itemUse.use('bag_expand_10');
  assert.equal(res.ok, true);
  assert.equal(res.amount, 5, 'the report is what landed, not what the rig promised');
  assert.equal(res.capacity, BAG_CAPACITY_MAX);
  assert.equal(inventory.bagCount('bag_expand_10'), 0, 'a use that delivered real value spends the item');
  assert.equal(bus.lastToast(), '+5 slots — your bag is now at its maximum of 60.');
});

test('a rig landing exactly on the ceiling says ceiling, not a total about to stop moving', () => {
  const { bus, inventory, itemUse } = rig();
  inventory.expandBag(15);
  inventory.addToBag('bag_expand_15', 1);
  assert.equal(itemUse.use('bag_expand_15').ok, true);
  assert.equal(bus.lastToast(), '+15 slots — your bag is now at its maximum of 60.');
});

test('rigs used one after another walk the bag to the cap and then stop, item in hand', () => {
  const { inventory, itemUse } = rig();
  inventory.addToBag('bag_expand_10', 6); // stack 3, so two slots of them

  const seen = [];
  for (let i = 0; i < 6; i++) seen.push(itemUse.use('bag_expand_10'));

  assert.deepEqual(seen.map((r) => r.ok), [true, true, true, false, false, false]);
  assert.deepEqual(seen.filter((r) => r.ok).map((r) => r.amount), [10, 10, 10]);
  assert.equal(inventory.bagCapacity, BAG_CAPACITY_MAX);
  assert.equal(inventory.bagCount('bag_expand_10'), 3, 'the three that could not apply were kept');
  for (const r of seen.filter((x) => !x.ok)) assert.equal(r.reason, 'bag-full');
});

test('an inventory with no expandBag refuses the use rather than swallowing the rig', () => {
  /* The same guard `magnet` and `chart` make. `_apply` runs AFTER the consume,
   * so a collaborator that cannot take the effect has to be caught in
   * `_canApply` or the rig is destroyed by an `_apply` that returns null. */
  const bus = recorder();
  const bag = new Map([['bag_expand_5', 1]]);
  const inventory = {
    bagCapacity: 30,
    bagCount: (id) => bag.get(id) ?? 0,
    consumeFromBag(id, n) {
      const have = bag.get(id) ?? 0;
      if (have < n) return false;
      bag.set(id, have - n);
      return true;
    },
  };
  const itemUse = new ItemUseSystem({ bus, player: { health: 1, maxHealth: 2 }, inventory });
  const res = itemUse.use('bag_expand_5');
  assert.equal(res.ok, false);
  assert.equal(bag.get('bag_expand_5'), 1, 'the rig survived a system that could not apply it');
});

/* ====================================================================== */
/* 3. The save                                                            */
/* ====================================================================== */

test('capacity round-trips, and the rows come back with it', () => {
  const a = rig().inventory;
  a.expandBag(20);
  a.addToBag('bullet', 60 * 34); // 34 slots: more than a 30-slot bag could hold
  a.add('alloy_scrap', 4);
  assert.equal(a.bagCapacity, 50);
  assert.equal(a.bagUsed, 34);

  const snap = JSON.parse(JSON.stringify(a.serialize()));
  assert.equal(snap.capacity, 50, 'serialize has always emitted this field');

  const b = rig().inventory;
  assert.equal(b.deserialize(snap), true);
  assert.equal(b.bagCapacity, 50, 'capacity is restored BEFORE the rows are accepted');
  assert.equal(b.bagUsed, 34, 'and so nothing past slot 30 was silently dropped');
  assert.equal(b.bagCount('bullet'), 60 * 34);
  assert.equal(b.count('alloy_scrap'), 4);
});

test('THE DEFECT: a full 60-slot save loaded into a fresh bag keeps every slot', () => {
  /* Written as its own case because it is the failure the ordering fix exists
   * for, and because it is silent: `_accept` drops the overflow and raises
   * nothing - `inventory:full` comes from `add`/`moveToBag`, not from the
   * restore path. Before the fix this restored 30 of the 60 slots. */
  const a = rig().inventory;
  a.expandBag(30);
  a.addToBag('bullet', 60 * 60);
  assert.equal(a.bagUsed, 60);

  const b = rig().inventory;
  b.deserialize(a.serialize());
  assert.equal(b.bagCapacity, 60);
  assert.equal(b.bagUsed, 60, 'thirty slots of carried kit used to disappear here');
});

test('a save written before bag expansion existed restores at 30, never 0 or undefined', () => {
  /* Every save on every disk today is one of these. `capacity` absent entirely
   * is the pre-feature shape; the others are the ways a hand-edited or
   * half-written file can express "no answer". */
  for (const capacity of [undefined, null, 0, -12, NaN, 'thirty', {}, []]) {
    const inv = rig().inventory;
    const snap = { version: 1, store: [], bag: [['medkit', 3]] };
    if (capacity !== undefined) snap.capacity = capacity;
    assert.equal(inv.deserialize(snap), true);
    assert.equal(inv.bagCapacity, BAG_CAPACITY,
      `capacity ${JSON.stringify(capacity)} restored at ${inv.bagCapacity}`);
    assert.equal(inv.bagCount('medkit'), 3, 'and the rows still loaded');
  }
  // A save written at exactly 30 is the same answer by a different road.
  const inv = rig().inventory;
  inv.deserialize({ version: 1, capacity: 30, store: [], bag: [] });
  assert.equal(inv.bagCapacity, BAG_CAPACITY);
});

test('a hand-edited save cannot mint slots, and cannot shrink the bag below the start', () => {
  const big = rig().inventory;
  big.deserialize({ version: 1, capacity: 500, store: [], bag: [] });
  assert.equal(big.bagCapacity, BAG_CAPACITY_MAX, '500 slots would delete the shop');

  const huge = rig().inventory;
  huge.deserialize({ version: 1, capacity: Number.MAX_SAFE_INTEGER, store: [], bag: [] });
  assert.equal(huge.bagCapacity, BAG_CAPACITY_MAX);

  const small = rig().inventory;
  small.deserialize({ version: 1, capacity: 3, store: [], bag: [] });
  assert.equal(small.bagCapacity, BAG_CAPACITY, 'a bag smaller than the starter kit is not a bag');

  const grown = rig().inventory;
  grown.expandBag(30);
  grown.deserialize({ version: 1, capacity: 45, store: [], bag: [] });
  assert.equal(grown.bagCapacity, 45, 'the save decides, in both directions, within the legal range');
});

/* ====================================================================== */
/* 4. The shop                                                            */
/* ====================================================================== */

test('the server sells all three rigs, and every field of every row is sane', async () => {
  const { BASE_ITEMS, MARKETPLACE_ACTIONS, MARKETPLACE_CATEGORIES } = await loadCatalog();
  const actions = new Set(MARKETPLACE_ACTIONS.map((a) => a.id));

  for (const id of RIGS) {
    const row = BASE_ITEMS.find((r) => r.source_key === id);
    assert.ok(row, `no BASE_ITEMS row for ${id}: the item exists and nobody sells it`);
    assert.ok(actions.has(row.game_action),
      `${id}: game_action ${row.game_action} is in no MARKETPLACE_ACTIONS row, so the seed normaliser rejects it`);
    assert.ok(MARKETPLACE_CATEGORIES.includes(row.category), `${id}: category ${row.category}`);
    assert.equal(row.pricing_kind, 'fixed',
      `${id}: a permanent upgrade priced through the regional consumable multipliers means the correct play is always to fly to Meridian and buy the whole bag at 0.7`);
    assert.equal(row.worlds, undefined,
      `${id}: an allowlist would restrict a rucksack to some worlds and not others`);
    assert.equal(row.action_config.item_id, id, `${id}: the row grants something other than itself`);
    assert.ok(row.cost_buy > row.cost_sell, `${id}: buy ${row.cost_buy} <= sell ${row.cost_sell} prints credits`);
  }
});

test('every rig is stocked in every world that has a shop, at one price', async () => {
  const { buildMarketplaceSeedItems, MARKETPLACE_WORLDS } = await loadCatalog();
  const seeded = buildMarketplaceSeedItems();
  for (const id of RIGS) {
    const rows = seeded.filter((r) => r.source_key.startsWith(`${id}:`));
    assert.equal(rows.length, MARKETPLACE_WORLDS.length,
      `${id} is seeded into ${rows.length} of ${MARKETPLACE_WORLDS.length} worlds`);
    const prices = new Set(rows.map((r) => r.cost_buy));
    assert.equal(prices.size, 1,
      `${id} costs ${[...prices].join('/')} depending on where you stand - 'fixed' is what stops that`);
  }
});

test('the offline mirror carries the three rigs too, so a bag can be grown with the API down', () => {
  const bundled = new Map(OFFLINE_BASE_ITEMS.map((r) => [r.source_key, r]));
  for (const id of RIGS) {
    assert.ok(bundled.has(id), `${id} is on the server and not in the bundle`);
    assert.equal(bundled.get(id).action_config.item_id, id);
  }
  // And a real vendor in a real world actually shows them.
  const station = offlineCatalog('station');
  for (const id of RIGS) {
    const row = station.find((r) => r.source_key === id);
    assert.ok(row, `${id} is not on an offline station shelf`);
    assert.equal(row.id, `${id}:station`, 'the id is the seeder id, so offline and online name the same row');
  }
});

test('a runtime item stands behind every rig source_key, world suffix or not', () => {
  /* `Marketplace._purchaseGrant` is what a purchase actually resolves through,
   * and the key it is handed is world-stamped (`bag_expand_5:station`) because
   * `buildMarketplaceSeedItems` stamps it and nothing between the DB row and
   * the game strips it. Both shapes are driven here. */
  const grantOf = (row) => Marketplace.prototype._purchaseGrant.call({}, row);
  const bundled = new Map(OFFLINE_BASE_ITEMS.map((r) => [r.source_key, r]));

  for (const id of RIGS) {
    const base = bundled.get(id);
    for (const key of [id, `${id}:station`, `${id}:dock`]) {
      const grant = grantOf({ source_key: key, action_config: base.action_config });
      assert.ok(grant, `${key}: resolves to nothing, so the purchase returns 'unsupported'`);
      assert.ok(isItem(grant.itemId), `${key}: grants "${grant.itemId}", which is not an item`);
      assert.equal(grant.itemId, id);
      assert.equal(grant.qty, 1);
      assert.ok(itemDef(grant.itemId).bagSlots > 0, `${key}: the granted item expands nothing`);
    }
  }
});

/* ====================================================================== */
/* 5. The balance                                                         */
/* ====================================================================== */

test('the rigs are purchase-only: no drop table, no cache table, no supply contract', async () => {
  /* A DECISION, written down. `Loot._dropFor` and `Caches._contentsFor` roll
   * consumables by the handful; a permanent, irreversible capacity upgrade
   * falling off a guard hands the player the whole ladder for free and deletes
   * the sink these were authored to be. Asserted over the source of all three
   * tables rather than over a scrape of one, because the question is simply
   * "does this id appear in any of them". */
  for (const rel of ['src/systems/Loot.js', 'src/systems/Caches.js', 'src/systems/Contracts.js']) {
    const src = await read(rel);
    for (const id of RIGS) {
      assert.ok(!src.includes(id), `${rel} mentions ${id} - a rig that drops is a balance change nobody asked for`);
    }
    assert.ok(!src.includes('bag_expand'), `${rel} mentions bag_expand`);
  }
});

test('the price ladder rises faster than the slots do, and no loop prints credits', () => {
  const bundled = new Map(OFFLINE_BASE_ITEMS.map((r) => [r.source_key, r]));
  const rows = RIGS.map((id) => ({ id, row: bundled.get(id), def: ITEMS[id] }));

  // Ordered, and dearer per slot as the rig grows: the big rig sells time and
  // bag space, never a bulk discount on capacity.
  const perSlot = rows.map(({ row, def }) => row.cost_buy / def.bagSlots);
  assert.ok(perSlot[0] < perSlot[1] && perSlot[1] < perSlot[2],
    `per-slot prices ${perSlot.map((p) => p.toFixed(0)).join(' / ')} are not rising`);
  assert.ok(rows[2].row.cost_buy > 3 * rows[0].row.cost_buy,
    'three small rigs buy the same fifteen slots more cheaply than one large one, or the ladder is one row');

  // Dearer than every other hand-authored row, because slots outlast all of them.
  const dearestOther = Math.max(...OFFLINE_BASE_ITEMS
    .filter((r) => !RIGS.includes(r.source_key)).map((r) => r.cost_buy));
  assert.ok(rows[0].row.cost_buy > 400 && rows[0].row.cost_buy < dearestOther,
    'the entry rig should be a serious purchase and still not the dearest thing in the shop');
  assert.ok(rows[2].row.cost_buy > dearestOther,
    'the top rig should be the largest single decision at a counter');

  for (const { id, row, def } of rows) {
    // `sellValue` at its most generous regional multiplier is 1.45 (Sunspire's
    // consumable rate), which is what a buy-sell-buy loop would be paid.
    const sellBack = Math.max(1, Math.round(def.value * SELL_RATE)) * 1.45;
    assert.ok(row.cost_buy > sellBack * 5,
      `${id}: buy ${row.cost_buy} is within 5x of the ${sellBack.toFixed(0)} the game pays back for it`);
    assert.equal(row.cost_sell, Math.round(row.cost_buy * 0.4),
      `${id}: fixed rows sell back at 0.4x, like every other permanent grant`);
  }
});

/* ====================================================================== */
/* 6. The panel                                                           */
/* ====================================================================== */

test('the panel reads the capacity and never writes 30 into its own copy', async () => {
  /* Three places used to hardcode it, and each was a lie the moment a bag grew:
   * the tick bar built once in `_build`, the detail line, and the two full-bag
   * messages. A source scrape because this is DOM text and the house pattern
   * is not to pretend to drive a browser for it (see inventory-defects). */
  const js = await read('src/ui/InventoryUI.js');
  /* CODE ONLY. The comments below the class deliberately discuss the old "30
   * slots" wording and why it went, and a scrape that could not tell a comment
   * from a template literal would have made the explanation unwritable - which
   * is the shape of gate this repository has been bitten by before. */
  const body = js.slice(js.indexOf('export class InventoryUI'))
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.doesNotMatch(body, /30 slots/, 'the panel still writes "30 slots" somewhere');
  assert.doesNotMatch(body, /repeat\(30/, 'the tick bar still hardcodes its column count');
  assert.match(body, /syncCapTicks\(this\.capBar, this\.inventory\.bagCapacity\)/, 'the bar is not built from the live capacity');
  assert.match(body, /syncCapTicks\(this\.capBar, capacity\)/, 'the bar is not REBUILT on render, so it can only ever be right once');
  assert.match(body, /\$\{this\.inventory\.bagCapacity\} slots/, 'the detail line does not read the capacity');

  const css = await read('src/ui/inventory.css');
  assert.match(css, /\.inv-cap-bar\.dense \{[^}]*gap: 1px;/s,
    'sixty ticks at a 2px gutter on a phone is a row of gutters');
});

test('the SHOP panel rebuilds its tick bar too, being the panel that sells the rig', async () => {
  /* `MarketplaceUI` builds its own `.inv-cap-bar` and had the identical
   * once-only loop. It is the worse of the two to leave: a player who buys a
   * rig, fits it, and walks back to the counter would have read "45 / 60" over
   * thirty ticks, all lit, in the very panel that sold them the upgrade. One
   * shared `syncCapTicks` is what stops this being fixed in one file only. */
  const js = await read('src/ui/MarketplaceUI.js');
  assert.match(js, /import \{[^}]*syncCapTicks[^}]*\} from '\.\/InventoryUI\.js'/,
    'the shop draws its own bar with its own loop again');
  assert.match(js, /syncCapTicks\(this\.capBar, this\.inventory\?\.bagCapacity \?\? 30\)/);
  assert.match(js, /syncCapTicks\(this\.capBar, capacity\)/, 'the shop bar is built once and never rebuilt');
  assert.doesNotMatch(js, /for \(let i = 0; i < capacity; i\+\+\) this\.capBar\.appendChild/,
    'the one-off fill loop is back');
});

test('the contract still says a bag starts at 30, and now says where it can get to', async () => {
  const md = await read('CONTRACTS-V3.md');
  assert.match(md, /A bag starts at 30 slots/);
  assert.match(md, /ceiling of 60/);
});
