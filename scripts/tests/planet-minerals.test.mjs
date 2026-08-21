import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build as esbuild } from 'esbuild';

import {
  definePlanet, MINERAL_RARITY, HOLD_UNITS_PER_SIZE, holdUnitsFor,
} from '../../src/worlds/planets/PlanetDescriptor.js';
import { PLANETS } from '../../src/worlds/planets/index.js';
import { ITEMS, itemDef, itemIconSVG, WORLD_MARKETS } from '../../src/systems/ItemDefs.js';
import { ItemUseSystem } from '../../src/systems/ItemUse.js';
import { CONFIG } from '../../src/core/Config.js';
import { MINE_TIME } from '../../src/systems/Mining.js';
import { boostTopSpeed } from '../../src/ships/Flight.js';
import { holdCapacity, SHIP_BASE_STATS } from '../../src/ships/ShipStats.js';
import { BIAS_PER_POINT } from '../../src/ships/Ship.js';
import { BODY_BY_ID, DOCK_ANCHOR } from '../../src/worlds/space/Bodies.js';

/**
 * THE MINERAL TABLE: A LADDER, A REGISTRATION CHAIN, AND A WALK.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THREE FAILURES, AND THIS FILE IS ONE BLOCK FOR EACH
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. **"Rare" is a word.** A mineral table can say `rarity: 'exotic'` over an
 *    ore worth less than the common one, that there are more of, lying on the
 *    flat two metres from the ramp. No renderer would notice. `definePlanet`
 *    refuses all four now, and block 1 DRIVES every refusal - a validator
 *    nobody has watched throw is a validator nobody knows works.
 *
 * 2. **An item that is registered and unreachable.** The nine-step chain in
 *    `dock-economy.test.mjs` is the model: an `ITEMS` row, an `ItemUse` effect,
 *    a guard, an application, a catalogue row, a registered action, a grant
 *    that resolves, a category a counter carries. Ore adds a tenth trap of its
 *    own: `InventoryUI.js:331` only draws a Use button for `consumable` and
 *    `skin`, so an ore with an `ItemUse` case and `kind: 'trinket'` is an
 *    effect no player can fire. Asserted here in BOTH directions.
 *
 * 3. **Ore nobody can walk to, or nobody would.** `planet-reach.test.mjs`
 *    already proves every node is reachable. This file asks the next question:
 *    whether the walk is worth making. It floods the real colliders, walks a
 *    nearest-neighbour tour of each seam at `CONFIG.player.walkSpeed`, flies
 *    the hold home at the hull's own boost cap, and reports credits per minute
 *    door to door. The rarity ladder has to show up in that number or it is
 *    decoration.
 *
 * Nothing below hard-codes an expected measurement. Every number a case
 * asserts is read out of a source table or derived from another measurement in
 * the same run, and the floors are stated as floor / achieved / ceiling with
 * the ceiling taken by ablation.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  BLOCK 5 RUNS ON ALL TEN PLANETS, AND HERE IS WHAT THAT COSTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Block 5 builds a REAL `PlanetWorld` with real physics and floods it. That was
 * written for one planet; there are ten now, and the honest question was whether
 * to run it ten times or to subset it. Measured, on the machine this was written
 * on, before deciding:
 *
 *   build one world, and its walk lattice                     170-600 ms
 *   the SAME lattice, flooded from each of its three pads      ~100 ms
 *   the SAME lattice, one flood PER NODE for the seam tours    2.0-6.5 s
 *
 * over 933 ore nodes and 47 seams on ten planets. Two runs on a machine with
 * other work on it: 4.4 s / 39.6 s and 13.5 s / 72.1 s for the cheap gates and
 * the economy, so 48 to 88 s for this file against the 8 s it cost when Cinder
 * was the only planet. The tour is the expensive half by a factor of five to
 * ten, and it is the half that cannot be reused between seams: a
 * nearest-neighbour tour needs the distance from every node to every other, and
 * that is one relaxation of a 160,000-cell lattice per node.
 *
 * IT RUNS ALL TEN. There is no rotation, no sample and no cap, because a gate
 * that quietly covers two planets while its name says ten is worse than no gate:
 * the project's own rule is no silent caps, and the cheapest way to obey it is
 * to not have a cap. A minute or so is what ten worlds cost, and the timings
 * are printed - a `[planet] world built in ... ms` line each, and a total for
 * the tours at the end - so the day it stops being affordable is a day somebody
 * can see rather than infer.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT GENERALISES AND WHAT IS ABOUT CINDER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "The rare tier costs more to reach" is a rule about every planet. "The rare
 * tier has the longest median march" is a rule about CINDER, and generalising
 * it naively breaks on five of the ten:
 *
 *   sirocco    chalcanth  rare      median 392 m   vs cassiterite uncommon 571 m
 *   shoal      polymetal  rare      median 170 m   vs abyssite    exotic   286 m
 *   verdigris  sporecryst rare      median 118 m   vs resin       uncommon 427 m
 *   lathe      tychite    rare      median 230 m   vs aurichalc   exotic   557 m
 *   carnelian  carnelite  rare      median 344 m   vs hematite    uncommon 392 m
 *
 * Sirocco's chalcanth is the clearest: it sits 392 m out at the median while an
 * UNCOMMON ore sits at 571 m, because chalcanth's cost is finding and descending
 * a canyon stair and cassiterite's cost is a long flat walk. That is a different
 * design, not a defect, and a gate that called it one would be telling nine
 * authors to make their planets more like the first one.
 *
 * So the generalised version asks what the rule is FOR - the rare tier costs
 * more - and measures the cost the way each planet actually charges it: from
 * THE PAD THE PLAYER ARRIVES AT, and for the rarest tier, not at all from
 * there. Cinder's own march and its 4x nearest-node ratio keep their case,
 * named as Cinder's.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

/* ================================================================== */
/* 1. THE SCHEMA REFUSES EVERY WAY A RARITY LADDER CAN BE A LIE       */
/* ================================================================== */

/** A two-tier planet that passes, so each case below can break exactly one thing. */
function ladder(over = []) {
  const rows = [
    {
      id: 'mud', item: 'mud', name: 'Mud', rarity: 'common', terrain: 'plain', place: 'The Flat',
      color: 1, unitValue: 5, size: 1.9, count: 30, spacing: 10, region: { shape: 'field' },
    },
    {
      id: 'spark', item: 'spark', name: 'Spark', rarity: 'uncommon', terrain: 'crater', place: 'The Pit',
      color: 2, unitValue: 40, size: 0.6, count: 8, spacing: 10, region: { shape: 'disc', x: 0, z: 0, r: 40 },
    },
  ].map((r, i) => ({ ...r, ...(over[i] ?? {}) }));
  return {
    id: 'probe', name: 'Probe', half: 200, seg: 64, gravity: 9,
    terrain: { seed: 1, baseY: 0, landforms: [{ kind: 'pad', x: 0, z: 0, r: 20 }] },
    palette: { material: 'dirt.ground', tile: 4, bands: [{ upTo: 0, color: 0x111111 }, { upTo: 50, color: 0x222222 }] },
    sky: { kind: 'daylight' },
    minerals: rows,
    landing: [{ id: 'a', name: 'A', x: 0, z: 0, r: 20, primary: true }],
  };
}

test('the mineral schema accepts a well-formed ladder and derives what it must not be told', () => {
  const p = definePlanet(ladder());
  const [mud, spark] = p.minerals;
  /* `credits` is the product and nothing else. `holdUnitsFor(1.9)` is 3 and
   * `holdUnitsFor(0.6)` is 1, so a lump of mud eats three times the hold of a
   * spark and is worth an eighth as much - which is the decision that pricing
   * per cubic metre exists to create. */
  assert.equal(mud.hold, 3);
  assert.equal(spark.hold, 1);
  assert.deepEqual([...mud.credits], [Math.round(5 * 3 * 0.75), Math.round(5 * 3 * 1.25)]);
  assert.deepEqual([...spark.credits], [Math.round(40 * 0.75), Math.round(40 * 1.25)]);
  assert.ok(Object.isFrozen(mud), 'a mineral record is handed out mutable');
});

test('the schema refuses every way "rare" can be a word rather than a fact', () => {
  const refuses = (over, why, pattern) => {
    assert.throws(() => definePlanet(ladder(over)), pattern, `ACCEPTED: ${why}`);
  };

  refuses([{ item: undefined }], 'an ore with no ITEMS row named', /must name the ITEMS row/);
  refuses([{ rarity: 'legendary' }], 'a rarity outside the ladder', /rarity "legendary" unknown/);
  refuses([{ terrain: 'lava_lake' }], 'a terrain outside the vocabulary', /terrain "lava_lake" unknown/);
  refuses([{ place: undefined }], 'a seam with no named feature to be in', /must name the feature/);
  refuses([{ credits: [1, 2] }], 'a hand-written credits range beside the price it should come from', /credits is DERIVED/);
  refuses([{ unitValue: 0 }], 'an ore worth nothing per cubic metre', /unitValue must be positive/);
  refuses([{ spread: 0.9 }], 'a value spread wider than the value', /spread must be 0\.\.0\.5/);

  // The five ladder rules, each broken on its own.
  refuses([{}, { unitValue: 4 }], 'an uncommon ore cheaper than the common one', /is not worth more than/);
  refuses([{}, { count: 31 }], 'more nodes of the uncommon ore than of the common one', /that is not rarity, that is a name/);
  refuses([{ rarity: 'uncommon' }, { rarity: 'exotic' }], 'a ladder with no bottom rung', /has no ladder, only a top/);
  refuses([{}, { rarity: 'exotic' }], 'a ladder that skips its middle rung', /skips from "common" to "exotic"/);
  refuses([{}, { terrain: 'plain' }], 'the rarest ore lying on the flat', /is in terrain 'plain'/);
  refuses([{}, { region: { shape: 'field' } }], 'the rarest ore scattered over the whole map', /scatters over the whole playfield/);

  /* And the one case that must NOT be refused: a planet with a single grade of
   * ore makes no claim about rarity, so it is allowed to be all-common and all
   * on the flat. Without this the rule above would refuse the honest case in
   * order to catch the dishonest one. */
  const flat = ladder();
  flat.minerals = [flat.minerals[0]];
  assert.doesNotThrow(() => definePlanet(flat), 'a one-grade planet was refused for having no ladder to climb');
});

/* ================================================================== */
/* 2. THE HOLD ARITHMETIC IS THE SHIP'S, NOT A SECOND COPY OF IT      */
/* ================================================================== */

test('the descriptor prices a node against the volume the ship actually charges for it', () => {
  /* `HOLD_UNITS_PER_SIZE` is the second copy of a constant whose first copy is
   * inside `Piloting.stow`, and nothing in either module compares them. Same
   * arrangement as `WORLD_MARKETS.dock` against `WORLD_PRICE_MULTIPLIERS.dock`,
   * and the same fix: scrape the other one. */
  const src = read('src/ships/Piloting.js');
  const at = src.indexOf('  stow(node) {');
  assert.ok(at > 0, 'Piloting.stow is gone or renamed - this scrape is dead');
  const m = /Math\.max\(1, Math\.round\(\(node\.size \?\? 1\) \* ([\d.]+)\)\)/.exec(src.slice(at, at + 900));
  assert.ok(m, 'the size-to-volume line in Piloting.stow has changed shape - this scrape is dead');
  assert.equal(Number(m[1]), HOLD_UNITS_PER_SIZE,
    `the ship charges size * ${m[1]} m3 and the descriptor prices against size * ${HOLD_UNITS_PER_SIZE}`);

  for (const planet of Object.values(PLANETS)) {
    for (const min of planet.minerals) {
      assert.equal(min.hold, holdUnitsFor(min.size), `${planet.id}/${min.id} hold`);
      const mid = min.unitValue * min.hold;
      assert.equal(min.credits[0], Math.round(mid * (1 - min.spread)), `${min.id} credits lo`);
      assert.equal(min.credits[1], Math.round(mid * (1 + min.spread)), `${min.id} credits hi`);
      assert.ok(min.credits[0] >= 1, `${min.id} can roll a worthless node`);
    }
  }
});

/* ================================================================== */
/* 3. EVERY ELEMENT, EVERY LINK OF THE CHAIN                          */
/* ================================================================== */

test('every element on every planet is registered end to end', () => {
  console.log('   REGISTRATION CHAIN, per element:');
  for (const planet of Object.values(PLANETS)) {
    for (const min of planet.minerals) {
      // 1. The ITEMS row. Without it the ore has a price and nothing to hang it on.
      const def = itemDef(min.item);
      assert.ok(def, `${planet.id}/${min.id}: no ITEMS row for "${min.item}"`);
      // 2. One price, in one place.
      assert.equal(min.unitValue, def.value,
        `${min.id}: the descriptor says ${min.unitValue} cr/m3 and ITEMS says ${def.value} - two copies of one price`);
      // 3. The fields the panels read. A missing icon key falls through to
      //    `unknown` silently, which is a question mark in the bag.
      assert.ok(def.name && def.short && def.desc, `${min.item}: an incomplete ITEMS row`);
      assert.ok(Number.isFinite(def.stack) && def.stack >= 1, `${min.item}: stack ${def.stack}`);
      const svg = itemIconSVG(min.item);
      assert.ok(/^<svg /.test(svg), `${min.item}: no icon markup`);
      assert.ok(!/M16 20 v-2 q3 -1 3 -3.5/.test(svg),
        `${min.item}: icon "${def.icon}" has no renderer, so it fell through to the question mark`);

      /* 4. THE USE BUTTON, BOTH WAYS ROUND.
       *
       * `InventoryUI.js:331` gates Use on `kind === 'consumable' || 'skin'`.
       * An ore with an `ItemUse` case and any other kind is an effect that
       * exists, is registered, and cannot be fired; an ore that IS a consumable
       * with no case is a Use button that returns `unsupported`. Neither is
       * visible without asking. */
      const effect = new ItemUseSystem({})._effectFor(min.item);
      const usable = def.kind === 'consumable' || def.kind === 'skin';
      assert.equal(!!effect, usable, effect
        ? `${min.item} has an ItemUse effect but kind "${def.kind}", so InventoryUI draws no Use button for it`
        : `${min.item} is kind "${def.kind}", so InventoryUI draws a Use button, and ItemUse has no case for it`);

      console.log(`     ${(`${planet.id}/${min.id}`).padEnd(20)} ${min.rarity.padEnd(9)} ${min.terrain.padEnd(11)}`
        + ` -> ITEMS.${min.item} (${def.kind}, ${def.value} cr/m3, stack ${def.stack})`
        + `  use: ${effect ? effect.type : 'none - cargo'}`);
    }
  }
});

test('the one ore with a use in the hand applies it, and refuses before it consumes', () => {
  /* Ferro-basalt is a lodestone, so it routes to the loot-magnet effect that
   * already exists rather than to one invented for it. The half that matters
   * is the refusal: `_canApply` is asked BEFORE `consumeFromBag`, so an unwired
   * `Loot` must leave the rock in the bag. The recorded cost of getting that
   * backwards is the unit destroyed for nothing. */
  const calls = [];
  const bag = {
    n: 1,
    consumeFromBag(id, q) { if (id !== 'ferrobasalt' || this.n < q) return false; this.n -= q; return true; },
  };
  const use = new ItemUseSystem({
    bus: { emit: (t, p) => calls.push([t, p]) },
    player: {},
    inventory: bag,
    loot: { setMagnet: (d, r) => { calls.push(['magnet', { d, r }]); return true; } },
  });
  const res = use.use('ferrobasalt');
  assert.ok(res.ok, `use() refused a lodestone with a live Loot: ${res.reason}`);
  assert.equal(bag.n, 0, 'the lodestone was applied and not consumed');
  const magnet = calls.find((c) => c[0] === 'magnet');
  assert.ok(magnet, 'nothing reached Loot.setMagnet - the effect fired into the air');
  assert.ok(magnet[1].d > 0 && magnet[1].r > 0, 'a zero-length or zero-range magnet');
  const toast = calls.find((c) => c[0] === 'hud:notify');
  assert.match(toast[1].text, /Lodestone/, 'the toast does not name the thing the player just used');

  // Unwired Loot: refused, and the rock is still there.
  const bag2 = { n: 1, consumeFromBag() { this.n--; return true; } };
  const res2 = new ItemUseSystem({ bus: { emit() {} }, player: {}, inventory: bag2 }).use('ferrobasalt');
  assert.equal(res2.ok, false, 'an unwired Loot accepted the use');
  assert.equal(bag2.n, 1, 'an unwired Loot ATE the lodestone');

  // Loot present but refusing (a magnet already running): same answer.
  const bag3 = { n: 1, consumeFromBag() { this.n--; return true; } };
  const res3 = new ItemUseSystem({
    bus: { emit() {} }, player: {}, inventory: bag3, loot: { setMagnet: () => false },
  }).use('ferrobasalt');
  assert.equal(res3.ok, false, 'a Loot that refused the magnet still reported a use');

  /* And the rock must be WEAKER than the article a counter sells, or the shop
   * row below is a worse deal in every dimension and nobody would buy one. */
  const rock = new ItemUseSystem({})._effectFor('ferrobasalt');
  const rune = new ItemUseSystem({})._effectFor('loot_magnet_30s');
  assert.ok(rock.duration < rune.duration && rock.range < rune.range,
    `a rock off the ground (${rock.duration}s/${rock.range}m) is not weaker than the Vacuum Rune (${rune.duration}s/${rune.range}m)`);
  console.log(`   lodestone ${rock.duration}s at ${rock.range} m against the Vacuum Rune's ${rune.duration}s at ${rune.range} m`);
});

/* ================================================================== */
/* 4. THE COUNTER: ONE ROW, AND NOT SIX                               */
/* ================================================================== */

const stubServerDeps = {
  name: 'stub-server-deps',
  setup(b) {
    b.onResolve({ filter: /^@vercel\/postgres$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export const sql = () => { throw new Error("no database in a unit test"); };',
      loader: 'js',
    }));
  },
};
let _catalog = null;
function catalog() {
  return (_catalog ??= esbuild({
    entryPoints: [path.join(ROOT, 'site/lib/marketplaceCatalog.ts')],
    bundle: true, write: false, format: 'esm', platform: 'node', target: 'node22',
    logLevel: 'silent', resolveExtensions: ['.ts', '.tsx', '.js'],
    plugins: [stubServerDeps],
  }).then((r) => import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`)));
}

/**
 * `Marketplace._purchaseGrant`, borrowed off the prototype.
 *
 * Constructing a `Marketplace` binds a keyboard listener to `window`, which in
 * this process is `globalThis` and has no `addEventListener`. The method reads
 * only its argument, so borrowing it drives the real resolver without booting
 * a shop. Same arrangement as `dock-economy.test.mjs`.
 */
async function purchaseGrant() {
  const { Marketplace } = await import('../../src/systems/Marketplace.js');
  const fn = Marketplace.prototype._purchaseGrant;
  assert.equal(typeof fn, 'function', '_purchaseGrant is gone: the resolver this test drives no longer exists');
  return (row) => fn.call({}, row);
}

test('the lodestone is buyable for real, and buying one never undercuts digging one', async () => {
  const { BASE_ITEMS, MARKETPLACE_ACTIONS } = await catalog();
  const row = BASE_ITEMS.find((r) => r.source_key === 'ore_lodestone');
  assert.ok(row, 'no BASE_ITEMS row: the effect exists and nobody sells it');
  assert.ok(MARKETPLACE_ACTIONS.some((a) => a.id === row.game_action),
    `game_action ${row.game_action} is in no MARKETPLACE_ACTIONS row: the seed normaliser rejects it`);
  assert.equal(row.category, 'tools', 'a counter has to carry the category or the row is unshowable');
  assert.deepEqual([...row.worlds], ['dock'], 'the yard is the only place that refines Cinder ore');

  /* The step whose recorded failure is a perfect-looking row that grants null.
   * Driven with the `:<world>` suffix the seeder stamps on, because that suffix
   * is what once made every consumable resolve to nothing. */
  const grant = (await purchaseGrant())({ source_key: 'ore_lodestone:dock', action_config: row.action_config });
  assert.deepEqual(grant, { itemId: 'ferrobasalt', qty: 1 },
    'the lodestone resolves to no bag grant: the purchase returns unsupported and takes nothing');

  const min = PLANETS.cinder.minerals.find((m) => m.id === 'ferrobasalt');
  assert.ok(row.cost_buy > min.credits[1],
    `the counter sells a lodestone for ${row.cost_buy} and the dearest node of it is worth ${min.credits[1]} - the shop undercuts the mine`);
  assert.ok(row.cost_buy > ITEMS.loot_magnet_30s.value,
    'a weaker effect is cheaper than the Vacuum Rune, so the rune is now unsellable');
  assert.ok(row.cost_buy > row.cost_sell, 'buy -> sell -> buy prints credits');
  console.log(`   lodestone ${row.cost_buy} cr at a counter, ${min.credits[0]}-${min.credits[1]} cr out of the ground`);
});

test('the cargo ores are sold BY the player and never TO them', async () => {
  /* A `BASE_ITEMS` row is the BUY side. An iridite row there would let a pilot
   * buy the thing the entire mining loop exists to obtain, off a counter,
   * without ever flying to Cinder - a refund on the loop rather than a
   * catalogue entry. */
  const { BASE_ITEMS } = await catalog();
  const sold = new Set(BASE_ITEMS.map((r) => r.action_config?.item_id).filter(Boolean));
  for (const min of PLANETS.cinder.minerals) {
    const usable = itemDef(min.item).kind === 'consumable';
    assert.equal(sold.has(min.item), usable, usable
      ? `${min.item} has a use in the hand and no counter sells one`
      : `${min.item} is hold cargo and a counter sells it - the mine is refunded`);
  }
});

test('a regional price signal exists only where a price path reads it', () => {
  /* Mined ore never touches the bag: `Mining.mine` hands the node to
   * `Piloting.stow` and `Piloting._dock` sells the whole hold at face value.
   * So a `WORLD_MARKETS.*.itemBuy` row on a cargo ore is a multiplier nothing
   * multiplies - the `MARKETPLACE_CONSUMABLE_ITEMS` defect in different
   * clothes. Only the ore that reaches a bag gets one. */
  const signalled = new Set();
  for (const market of Object.values(WORLD_MARKETS)) {
    for (const id of Object.keys(market.itemBuy ?? {})) signalled.add(id);
  }
  for (const min of PLANETS.cinder.minerals) {
    if (itemDef(min.item).kind === 'consumable') continue;
    assert.ok(!signalled.has(min.item),
      `${min.item} carries a regional price multiplier and never reaches a bag for one to apply to`);
  }
  assert.ok(signalled.has('ferrobasalt'),
    'the one ore that does reach a bag has no regional price, so carrying it anywhere is the same');
});

/* ================================================================== */
/* 5. THE WALK, AND WHAT IT PAYS                                      */
/* ================================================================== */

/* The lattice. Same envelope as `planet-reach.test.mjs` - 2.0 m pitch, 38 deg
 * continuous, 0.45 m step-up, 3.0 m drop, no jump and no mantle - but this one
 * carries DISTANCE, because the question here is not whether a body can get
 * there, it is how long it takes and what it is paid for going. */
const PITCH = 2.0;
const MAX_SLOPE_TAN = Math.tan((38 * Math.PI) / 180);
const MAX_RISE = PITCH * MAX_SLOPE_TAN;
const STEP_UP = 0.45;
const DROP_MAX = 3.0;
const HEADROOM = 1.9;
const ARRIVE = 3.2;

function harness(THREE) {
  if (globalThis.__mineralHarness) return;
  globalThis.__mineralHarness = true;
  class Img {
    constructor(a, b, c) {
      if (typeof a === 'number') { this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4); }
      else { this.data = a; this.width = b; this.height = c ?? 1; }
    }
  }
  const gradient = { addColorStop() {} };
  const context2d = (canvas) => new Proxy({
    canvas,
    createImageData: (w, h) => new Img(Math.max(1, w | 0), Math.max(1, (h ?? w) | 0)),
    getImageData: (x, y, w, h) => new Img(Math.max(1, w | 0), Math.max(1, h | 0)),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createConicGradient: () => gradient,
    createPattern: () => null,
    measureText: () => ({ width: 8 }),
    getLineDash: () => [],
  }, { get: (o, k) => (k in o ? o[k] : () => undefined), set: () => true });
  globalThis.ImageData ??= Img;
  globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(Date.now()), 0);
  globalThis.document ??= {
    createElement(tag) { const c = { width: 1, height: 1, style: {}, tagName: tag }; c.getContext = () => context2d(c); return c; },
    createElementNS(_ns, tag) { return this.createElement(tag); },
  };
  globalThis.window ??= globalThis;
  globalThis.OffscreenCanvas ??= class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return context2d(this); } };
  const dead = () => ({ texture: null, dispose() {} });
  THREE.PMREMGenerator.prototype.fromEquirectangular = dead;
  THREE.PMREMGenerator.prototype.fromScene = dead;
  THREE.PMREMGenerator.prototype.compileEquirectangularShader = () => {};
}

/** Every planet the game registers, in registry order. */
const ALL = Object.values(PLANETS);

const _worlds = new Map();
/**
 * One real world per planet, built once. `PLANETS.cinder` by default so the
 * Cinder-only cases below read the way they always did.
 */
async function world_(planet = PLANETS.cinder) {
  if (_worlds.has(planet.id)) return _worlds.get(planet.id);
  const THREE = await import('three');
  harness(THREE);
  const { Physics, COLLISION_LAYER } = await import('../../src/physics/Physics.js');
  const { PlanetWorld } = await import('../../src/worlds/PlanetWorld.js');
  const { polyDist } = await import('../../src/worlds/planets/Placement.js');
  const physics = new Physics();
  const Cls = PlanetWorld.of(planet);
  const built = new Cls({
    physics,
    scene: new THREE.Scene(),
    bus: { on: () => () => {}, emit() {} },
    engine: {
      renderer: {
        capabilities: { getMaxAnisotropy: () => 4, isWebGL2: true },
        initTexture() {}, getContext: () => ({}),
        getRenderTarget: () => null, setRenderTarget() {}, render() {}, clear() {},
      },
      camera: new THREE.PerspectiveCamera(), onFrameUpdate: () => () => {}, onResize: () => () => {},
    },
    materials: { get: () => new THREE.MeshStandardMaterial(), dispose() {} },
  });
  built.physics = physics;
  await built.build(() => {});
  const out = { world: built, physics, COLLISION_LAYER, polyDist };
  _worlds.set(planet.id, out);
  return out;
}

/** Every solid world box, indexed on XZ. Straight out of `physics.colliders`. */
function boxIndex(physics, COLLISION_LAYER) {
  const cell = 8;
  const grid = new Map();
  for (const c of physics.colliders) {
    if (!c.solid) continue;
    if ((c.layer & COLLISION_LAYER.WORLD) === 0) continue;
    if (c.type !== 'box') continue;
    const m = c.matrix.elements;
    const b = {
      x: m[12], y: m[13], z: m[14],
      ax: Math.abs(m[0]) * c.halfExtents.x + Math.abs(m[4]) * c.halfExtents.y + Math.abs(m[8]) * c.halfExtents.z,
      ay: Math.abs(m[1]) * c.halfExtents.x + Math.abs(m[5]) * c.halfExtents.y + Math.abs(m[9]) * c.halfExtents.z,
      az: Math.abs(m[2]) * c.halfExtents.x + Math.abs(m[6]) * c.halfExtents.y + Math.abs(m[10]) * c.halfExtents.z,
    };
    const x0 = Math.floor((b.x - b.ax) / cell); const x1 = Math.floor((b.x + b.ax) / cell);
    const z0 = Math.floor((b.z - b.az) / cell); const z1 = Math.floor((b.z + b.az) / cell);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = ((cx + 4096) << 13) | (cz + 4096);
        let list = grid.get(k);
        if (!list) grid.set(k, (list = []));
        list.push(b);
      }
    }
  }
  return (x, z, groundY) => {
    const k = ((Math.floor(x / cell) + 4096) << 13) | (Math.floor(z / cell) + 4096);
    const list = grid.get(k);
    if (!list) return false;
    for (const b of list) {
      if (Math.abs(x - b.x) > b.ax || Math.abs(z - b.z) > b.az) continue;
      if (b.y + b.ay <= groundY + STEP_UP) continue;
      if (b.y - b.ay >= groundY + HEADROOM) continue;
      return true;
    }
    return false;
  };
}

/**
 * One walk lattice, many floods.
 *
 * `planet-reach` rebuilds its mask per flood because it runs four of them. A
 * nearest-neighbour tour runs one flood PER NODE - 119 of them on Cinder - so
 * the standing-room mask is built once and only the distance field is refilled.
 */
function lattice({ ground, blocked, lava, half }) {
  const n = Math.floor((half * 2) / PITCH) + 1;
  const at = (i, j) => j * n + i;
  const ok = new Uint8Array(n * n);
  const y = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const z = -half + j * PITCH;
    for (let i = 0; i < n; i++) {
      const x = -half + i * PITCH;
      const g = ground(x, z);
      if (!Number.isFinite(g)) continue;
      y[at(i, j)] = g;
      if (lava(x, z, g)) continue;
      if (blocked(x, z, g)) continue;
      const gx = ground(x + PITCH * 0.5, z); const gnx = ground(x - PITCH * 0.5, z);
      const gz = ground(x, z + PITCH * 0.5); const gnz = ground(x, z - PITCH * 0.5);
      if (![gx, gnx, gz, gnz].every(Number.isFinite)) continue;
      if (Math.hypot((gx - gnx) / PITCH, (gz - gnz) / PITCH) > MAX_SLOPE_TAN) continue;
      ok[at(i, j)] = 1;
    }
  }
  /* Float64, NOT Float32, AND THIS IS A BUG THAT WAS ALREADY HERE.
   *
   * The relaxation below accepts an improvement of more than 1e-6 m and then
   * STORES it. In a `Float32Array` a distance of about 1 km has a ULP of 6e-5,
   * so an improvement between 1e-6 and 6e-5 passes the test and rounds away in
   * the store: `dist[kk]` does not move, the node is queued again, the same
   * edge relaxes again, and the queue grows without bound. On Cinder the graph
   * never triggered it. On Sallow it does immediately - `q.push` throws
   * `RangeError: Invalid array length` - which is what running this on a second
   * planet found. Float64 carries the 1e-6 threshold with fifteen digits to
   * spare and the loop terminates. */
  const dist = new Float64Array(n * n);
  const cellsNear = (x, z) => {
    const i0 = Math.round((x + half) / PITCH); const j0 = Math.round((z + half) / PITCH);
    const r = Math.ceil(ARRIVE / PITCH); const out = [];
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        const a = i0 + di; const b = j0 + dj;
        if (a < 0 || b < 0 || a >= n || b >= n || !ok[at(a, b)]) continue;
        if (Math.hypot(a * PITCH - half - x, b * PITCH - half - z) > ARRIVE) continue;
        out.push(at(a, b));
      }
    }
    return out;
  };
  return {
    /** Seed at (x,z) and relax; the field stays valid until the next call. */
    from(x, z) {
      dist.fill(Infinity);
      const q = [];
      for (const k of cellsNear(x, z)) { dist[k] = 0; q.push(k); }
      let head = 0;
      while (head < q.length) {
        const k = q[head++];
        const i = k % n; const j = (k - i) / n;
        const here = y[k]; const d0 = dist[k];
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const a = i + di; const b = j + dj;
          if (a < 0 || b < 0 || a >= n || b >= n) continue;
          const kk = at(a, b);
          if (!ok[kk]) continue;
          const dh = y[kk] - here;
          if (dh > 0 && dh > MAX_RISE && dh > STEP_UP) continue;
          if (dh < -DROP_MAX) continue;
          const step = Math.hypot(PITCH, dh);
          if (d0 + step < dist[kk] - 1e-6) { dist[kk] = d0 + step; q.push(kk); }
        }
      }
      return this;
    },
    /** Walking metres from the last seed to (x,z), or Infinity. */
    to(x, z) {
      let best = Infinity;
      for (const k of cellsNear(x, z)) if (dist[k] < best) best = dist[k];
      return best;
    },
  };
}

const _walk = new Map();
/**
 * One walk lattice per planet, with the standing-room mask built once.
 *
 * Timed and printed: this is the expensive half of block 5 and the header says
 * what it costs. A nearest-neighbour tour runs one flood PER NODE, so the mask
 * is built once and only the distance field is refilled.
 */
async function walkGraph(planet = PLANETS.cinder) {
  if (_walk.has(planet.id)) return _walk.get(planet.id);
  const t0 = Date.now();
  const { world, physics, COLLISION_LAYER, polyDist } = await world_(planet);
  const tBuild = Date.now() - t0;
  const field = physics.heightfields[0];
  const blocked = boxIndex(physics, COLLISION_LAYER);
  const bodies = world.planet.liquid?.bodies ?? [];
  const lava = (x, z, y) => {
    for (const b of bodies) {
      if (b.shape === 'disc') { if (Math.hypot(x - b.x, z - b.z) <= b.r && y < b.y + 0.6) return true; }
      else if (polyDist(x, z, b.pts) <= b.width * 0.5 && y < Math.max(b.y0, b.y1) + 0.6) return true;
    }
    return false;
  };
  const t1 = Date.now();
  const L = lattice({ ground: (x, z) => field.sampleHeight(x, z), blocked, lava, half: world.planet.half });
  console.log(`   [${planet.id}] world built in ${tBuild} ms, walk lattice in ${Date.now() - t1} ms,`
    + ` ${world.mineralNodes.length} ore nodes, ${world.landingSites.length} pads`);
  const out = { world, blocked, lava, L };
  _walk.set(planet.id, out);
  return out;
}

/**
 * Nearest-pad and from-the-primary-pad walking distances for one planet.
 *
 * `nearest` is the distance to each node from whichever pad is closest to it.
 * `fromPrimary` is the distance from the pad the player ARRIVES at, which is a
 * different question and the one the rarity ladder is actually priced in.
 */
async function distances(planet) {
  const { world, L } = await walkGraph(planet);
  const primary = world.landingSites.find((site) => site.primary);
  const nearest = new Map();
  for (const site of world.landingSites) {
    L.from(site.position.x, site.position.z);
    for (const nd of world.mineralNodes) {
      const d = L.to(nd.position.x, nd.position.z);
      const cur = nearest.get(nd);
      if (!cur || d < cur.d) nearest.set(nd, { d, pad: site.id });
    }
  }
  L.from(primary.position.x, primary.position.z);
  const fromPrimary = new Map();
  for (const nd of world.mineralNodes) fromPrimary.set(nd, L.to(nd.position.x, nd.position.z));
  const rows = [];
  for (const min of world.planet.minerals) {
    const nodes = world.mineralNodes.filter((nd) => nd.type === min.id);
    const ds = nodes.map((nd) => nearest.get(nd).d).sort((a, b) => a - b);
    const pd = nodes.map((nd) => fromPrimary.get(nd)).sort((a, b) => a - b);
    rows.push({
      min,
      nodes,
      ds,
      pd,
      lost: ds.filter((d) => !(d < Infinity)).length,
      pads: new Set(nodes.map((nd) => nearest.get(nd).pad)),
      onPrimary: pd.filter((d) => d < Infinity).length,
      median: ds[Math.floor(ds.length / 2)],
    });
  }
  return { world, L, primary, rows };
}

test('on every planet the rare tier costs more to reach than the common one', async () => {
  /* ALL TEN. `planet-reach.test.mjs` already proves every node is reachable.
   * This case asks the next question - what does reaching it COST - and it asks
   * it in the units each planet actually charges in.
   *
   * ── WHY THIS IS NOT "THE RARE TIER IS FURTHER AWAY" ──────────────────────
   *
   * Because on five of the ten planets it is not, and they are right. Sirocco's
   * chalcanth sits at a 392 m median while its UNCOMMON cassiterite sits at
   * 571 m: chalcanth is down a canyon stair and cassiterite is a long flat
   * walk, and the canyon is the more expensive of the two. Distance is one way
   * a planet can charge for an ore and it is not the only one.
   *
   * What IS true of all ten, and is what the rule was always for:
   *
   *   1. NOTHING IS LOST. Every node is reachable from some pad, on foot, with
   *      no jump and no mantle.
   *   2. THE EXOTIC SEAM IS NOT ON THE DOORSTEP. Zero of its nodes reachable
   *      from the primary pad AT ANY DISTANCE. It is not a longer walk, it is a
   *      second landing: you fly to its own pad and start again. Ten out of ten
   *      planets are authored this way.
   *   3. FROM THE PAD THE PLAYER ARRIVES AT, THE RARE SEAM IS FURTHER THAN THE
   *      COMMON ONE. Measured from the PRIMARY pad specifically rather than
   *      from the nearest, because "nearest pad" flatters an ore that has a pad
   *      of its own - Verdigris's sporecryst is 64 m from Sumphead and 525 m
   *      from Greenspan, and the second number is the one a player pays on
   *      arrival. Floor 1.5x, and the tightest planet in the registry is Lathe
   *      at 1.9x. */
  const lost = [];
  const freeExotic = [];
  const cheapRare = [];
  console.log('   THE WALK, ON EVERY PLANET (floor: nothing lost; exotic 0-from-primary; rare >= 1.5x common from the primary)');
  for (const planet of ALL) {
    const { primary, rows } = await distances(planet);
    const commonFromPrimary = Math.min(...rows.filter((r) => r.min.rarity === 'common').map((r) => r.pd[0]));
    for (const r of rows) {
      const fp = r.pd[0] < Infinity ? `${r.pd[0].toFixed(0)} m` : 'UNREACHABLE';
      console.log(`     ${planet.id.padEnd(11)} ${r.min.id.padEnd(12)} ${r.min.rarity.padEnd(9)} ${r.min.terrain.padEnd(11)}`
        + ` ${r.nodes.length - r.lost}/${String(r.nodes.length).padEnd(3)}`
        + `  nearest pad: min ${r.ds[0].toFixed(0).padStart(4)} m, median ${r.median.toFixed(0).padStart(4)} m,`
        + ` max ${r.ds[r.ds.length - 1].toFixed(0).padStart(4)} m`
        + `   from ${primary.id}: ${fp.padStart(11)}, ${r.onPrimary}/${r.nodes.length} nodes`
        + `   via ${[...r.pads].join(', ')}`);
      if (r.lost) lost.push(`${planet.id}/${r.min.id}: ${r.lost} nodes nothing can walk to`);
      if (r.min.rarity === 'exotic' && r.onPrimary !== 0) {
        freeExotic.push(`${planet.id}/${r.min.id}: ${r.onPrimary} of ${r.nodes.length} exotic nodes can be walked to from`
          + ` ${primary.id}, the pad you arrive at - the exotic tier costs no second landing`);
      }
      if (r.min.rarity === 'rare') {
        const ratio = r.pd[0] / commonFromPrimary;
        console.log(`     ${' '.repeat(11)} ${r.min.id} from ${primary.id}: ${r.pd[0].toFixed(0)} m against`
          + ` ${commonFromPrimary.toFixed(0)} m for the nearest common ore = floor 1.5x, achieved ${ratio.toFixed(1)}x`);
        if (!(ratio >= 1.5)) {
          cheapRare.push(`${planet.id}/${r.min.id}: ${r.pd[0].toFixed(0)} m from ${primary.id} against`
            + ` ${commonFromPrimary.toFixed(0)} m for the nearest common ore - only ${ratio.toFixed(1)}x, so the rare`
            + ' tier is on the doorstep of the pad the player arrives at');
        }
      }
    }
  }
  assert.deepEqual(lost, [], 'ore nothing can walk to is ore that does not exist');
  assert.deepEqual(freeExotic, [], 'the exotic tier is a second landing, not a longer walk');
  assert.deepEqual(cheapRare, [], 'the rare tier has to cost something measured from where the player lands');
});

test('CINDER: the rare tier is the longest march on the planet, and the exotic is off it', async () => {
  /* CINDER ONLY, and both halves of it are why.
   *
   * (a) THE 4x NEAREST-NODE RATIO. Rheniite's nearest node is 326 m from a pad
   *     against 48 m for the nearest common ore, 6.8x. Measured against the
   *     NEAREST pad rather than the primary, which is a stricter thing to ask
   *     and only Cinder, Tessera, Vitrine, Carnelian, Sallow and Cathedra
   *     clear it - Verdigris's sporecryst is 1.1x by that measure, because it
   *     has a pad of its own 64 m away. The registry-wide version of this claim
   *     is the from-the-primary-pad ratio in the case above.
   *
   * (b) THE LONGEST MARCH. Rheniite's median walk is longer than every other
   *     ore's on Cinder. Five of the ten planets invert that deliberately and
   *     the header lists them; it is a fact about a rift that runs the length
   *     of one map, not a rule.
   *
   * Nearest and not median for (a), because median is an artefact of how wide a
   * region is - tephra's `field` region spreads it over the whole plain and
   * drags its median to 521 m, when in practice you pick up the one 52 m from
   * the ramp and never walk to the far ones. */
  const { rows } = await distances(PLANETS.cinder);
  const commonNearest = Math.min(...rows.filter((r) => r.min.rarity === 'common').map((r) => r.ds[0]));
  const NEAREST_FLOOR = 4;
  for (const r of rows.filter((x) => x.min.rarity === 'rare' || x.min.rarity === 'exotic')) {
    const ratio = r.ds[0] / commonNearest;
    console.log(`     ${r.min.rarity.padEnd(9)} ${r.min.id.padEnd(10)} nearest node ${r.ds[0].toFixed(0)} m against`
      + ` ${commonNearest.toFixed(0)} m for the nearest common ore = floor ${NEAREST_FLOOR.toFixed(1)}x,`
      + ` achieved ${ratio.toFixed(1)}x`);
    assert.ok(ratio >= NEAREST_FLOOR,
      `${r.min.id}'s nearest node is ${r.ds[0].toFixed(0)} m from a pad and the nearest common ore is`
      + ` ${commonNearest.toFixed(0)} m - only ${ratio.toFixed(1)}x`);
  }
  const rare = rows.find((r) => r.min.rarity === 'rare');
  const worst = rows.filter((r) => r.min.rarity !== 'rare').reduce((a, b) => (b.median > a.median ? b : a));
  console.log(`     rare      ${rare.min.id.padEnd(10)} median walk ${rare.median.toFixed(0)} m`
    + `  - floor ${worst.median.toFixed(0)} m (the next longest, ${worst.min.id}), achieved ${rare.median.toFixed(0)} m`);
  assert.ok(rare.median > worst.median,
    `${rare.min.id}'s median walk is ${rare.median.toFixed(0)} m and ${worst.min.id}'s is ${worst.median.toFixed(0)} m`
    + ' - the rare tier is not the longest march on Cinder');
});

test('CEILING BY ABLATION: the rare ore is held where it is by one road and one channel', async () => {
  /* CINDER ONLY: it names Cinder's spiral road, Cinder's iridite and Cinder's
   * rheniite. Its registry-wide sibling is the exotic-tier measurement above -
   * 0 of N from the primary pad on all ten planets - which is the same claim
   * made by measurement rather than by deletion.
   *
   * The case above can only go red if something is actually gating the rare
   * ore, and on an open plain nothing would be. So: delete the spiral road and
   * re-flood. Iridite must go to ZERO, which proves the road is the route. And
   * rheniite must NOT, because its two ends hang off two different pads - a
   * rare ore behind a single point of failure is one edit from unreachable, and
   * this is the case that would notice. */
  const { world, blocked, lava } = await walkGraph(PLANETS.cinder);
  const { HEIGHT_FIELDS } = await import('../../src/worlds/terrain/index.js');
  const P = world.planet;
  const rim = P.landing.find((s) => s.id === 'rimhold');
  const spiral = P.terrain.landforms.find((f) => f.kind === 'ramp'
    && Math.hypot(f.pts[0][0] - rim.x, f.pts[0][1] - rim.z) < 1e-6);
  assert.ok(spiral, 'could not find the spiral road to ablate - this case no longer measures what it says');
  const ablated = HEIGHT_FIELDS.planet({ ...P.terrain, landforms: P.terrain.landforms.filter((f) => f !== spiral) });
  const L2 = lattice({ ground: ablated, blocked, lava, half: P.half });

  const after = new Set();
  for (const s of world.landingSites) {
    L2.from(s.position.x, s.position.z);
    for (const nd of world.mineralNodes) if (L2.to(nd.position.x, nd.position.z) < Infinity) after.add(nd);
  }
  const tally = (type) => {
    const all = world.mineralNodes.filter((nd) => nd.type === type);
    return { total: all.length, after: all.filter((nd) => after.has(nd)).length };
  };
  const ir = tally('iridite');
  const rh = tally('rheniite');
  console.log(`     iridite  floor ${ir.total}/${ir.total}, achieved ${ir.total}/${ir.total}, ceiling by ablation (no spiral road) ${ir.after}/${ir.total}`);
  console.log(`     rheniite floor ${rh.total}/${rh.total}, achieved ${rh.total}/${rh.total}, ceiling by ablation (no spiral road) ${rh.after}/${rh.total}`);
  assert.equal(ir.after, 0, 'the caldera floor is reachable without the spiral road - the road is not the route');
  assert.ok(rh.after > 0 && rh.after < rh.total,
    `rheniite went ${rh.after}/${rh.total} under ablation: it is either behind the same single road as iridite, or behind nothing at all`);
});

/**
 * One planet's mining economy, door to door: land, walk the seam on the real
 * walk graph, walk back, fly home, and price the hold.
 *
 * This is the expensive part of the file - one flood PER NODE for the
 * nearest-neighbour tour - and its cost is timed and printed per planet.
 */
async function economy(planet) {
  const { world, L } = await walkGraph(planet);
  const P = world.planet;
  const WALK = CONFIG.player.walkSpeed;
  /* The hulls, with their own numbers rather than a quoted pair. `powerMul` is
   * `Ship.applyPowers`' formula for a stock hull with no tiers bought. */
  const hulls = ['kestrel', 'dray'].map((id) => ({
    id,
    hold: holdCapacity(id),
    boost: boostTopSpeed(1 + (SHIP_BASE_STATS[id].power ?? 0) * BIAS_PER_POINT),
  }));
  const body = BODY_BY_ID[P.id];
  assert.ok(body, `${P.id} has no body in Bodies.js - a planet with no place in the system cannot be flown to`);
  /* Handoff sphere to handoff sphere: the stretch of the trip that is holding W
   * with nothing to do. A FLOOR on the flight and not the flight - it counts no
   * turn, no descent, no landing and no walk to the ramp. */
  const cruise = Math.hypot(...body.position.map((v, i) => v - DOCK_ANCHOR.position[i]))
    - body.handoff - DOCK_ANCHOR.handoff;

  const t0 = Date.now();
  const rows = [];
  for (const min of P.minerals) {
    const nodes = world.mineralNodes.filter((nd) => nd.type === min.id);
    // The pad a miner would pick: most of this seam reachable, then nearest.
    let pad = null;
    let bestScore = -Infinity;
    for (const site of world.landingSites) {
      L.from(site.position.x, site.position.z);
      const ds = nodes.map((nd) => L.to(nd.position.x, nd.position.z)).filter((d) => d < Infinity);
      const score = ds.length * 1e7 - ds.reduce((a, b) => a + b, 0);
      if (score > bestScore) { bestScore = score; pad = site; }
    }
    // Nearest-neighbour tour from that pad, over the real walk graph.
    L.from(pad.position.x, pad.position.z);
    const left = new Set(nodes.filter((nd) => L.to(nd.position.x, nd.position.z) < Infinity));
    const steps = [];
    let tour = 0;
    let credits = 0;
    let vol = 0;
    while (left.size) {
      let best = null;
      let bestD = Infinity;
      for (const nd of left) { const d = L.to(nd.position.x, nd.position.z); if (d < bestD) { bestD = d; best = nd; } }
      if (!best || !(bestD < Infinity)) break;
      tour += bestD; credits += best.credits; vol += holdUnitsFor(best.size ?? 1);
      left.delete(best);
      L.from(best.position.x, best.position.z);
      steps.push({ n: steps.length + 1, tour, credits, vol, home: L.to(pad.position.x, pad.position.z) });
    }
    const trips = hulls.map((h) => {
      const e = [...steps].reverse().find((q) => q.vol <= h.hold);
      if (!e) return { id: h.id, cr: 0, sec: Infinity, rate: 0, n: 0, vol: 0 };
      const sec = (e.tour + e.home) / WALK + e.n * MINE_TIME + 2 * (cruise / h.boost);
      return { id: h.id, cr: e.credits, sec, rate: e.credits / (sec / 60), n: e.n, vol: e.vol };
    });
    rows.push({ min, pad, steps, trips });
  }
  return { world, P, hulls, cruise, rows, ms: Date.now() - t0 };
}

test('credits per minute climbs with rarity on every planet, once the hold and the flight are counted', async () => {
  /* ALL TEN, and the header records what that costs and why there is no subset.
   *
   * ── THE FLOORS, AND WHY THEY ARE NOT "EVERY STEP ASCENDS" ────────────────
   *
   * Cinder's own case asserts that each adjacent row of its mineral table pays
   * more than the one above it wherever the rarity steps up, and it keeps that
   * assertion below because Cinder is the reference table. Across the registry
   * two of those steps are not strict:
   *
   *   lathe   rare tychite 237.28 cr/min   ->   exotic aurichalc 236.98 cr/min
   *
   * a shortfall of 0.13%, and it is a hull arithmetic outcome rather than a
   * ladder that does not pay: a Kestrel fills its 10 m3 on ten tychite worth
   * 3,602 cr in 911 s, or on six aurichalc worth 4,150 cr in 1,051 s. The
   * exotic pays MORE PER TRIP and the same per minute, because the walk to it
   * is 140 s longer. Pinning that to a strict inequality would be pinning two
   * hull stats and a road length.
   *
   * So the registry-wide floors are the two claims that survive:
   *
   *   THE TIERS ASCEND UP TO RARE. Each tier's best rate beats the tier below,
   *   for common -> uncommon -> rare. Achieved: the tightest is Lathe at
   *   13.6 -> 62.5 -> 237.3.
   *
   *   THE LADDER PAYS AT ALL. The exotic tier earns at least 10x the common
   *   one. Achieved 15x (Sallow) to 37x (Cinder).
   *
   * Every adjacent-row inversion is PRINTED for every planet, with both rates,
   * so a ladder that stops paying is visible in the log the run it happens. */
  const stepFail = [];
  const spreadFail = [];
  let totalMs = 0;
  for (const planet of ALL) {
    const { P, hulls, cruise, rows, ms } = await economy(planet);
    totalMs += ms;
    console.log(`   ${P.name.toUpperCase()} - yard to ${P.id}, handoff to handoff: ${(cruise / 1000).toFixed(2)} km`
      + `   (tour measured in ${(ms / 1000).toFixed(1)} s)`);
    for (const h of hulls) {
      console.log(`     ${h.id.padEnd(8)} hold ${String(h.hold).padStart(2)} m3, boost ${h.boost} m/s,`
        + ` cruise leg ${(cruise / h.boost).toFixed(0)} s each way`);
    }
    console.log('     element      rarity     cr/m3  seam    kestrel 10 m3               dray 40 m3');
    for (const r of rows) {
      const [k, d] = r.trips;
      console.log(`     ${r.min.id.padEnd(12)} ${r.min.rarity.padEnd(9)} ${String(r.min.unitValue).padStart(5)}`
        + ` ${String(r.steps[r.steps.length - 1]?.credits ?? 0).padStart(5)}cr`
        + `   ${String(k.n).padStart(2)} nodes ${String(k.cr).padStart(4)} cr in ${k.sec.toFixed(0).padStart(4)} s = ${k.rate.toFixed(0).padStart(3)}/min`
        + `   ${String(d.n).padStart(2)} nodes ${String(d.cr).padStart(4)} cr in ${d.sec.toFixed(0).padStart(4)} s = ${d.rate.toFixed(0).padStart(3)}/min`);
    }

    /* Adjacent-row check: printed for every planet, asserted for Cinder. */
    const kestrel = rows.map((r) => ({ rarity: r.min.rarity, id: r.min.id, rate: r.trips[0].rate }));
    const inversions = [];
    for (let i = 1; i < kestrel.length; i++) {
      const a = kestrel[i - 1];
      const b = kestrel[i];
      if (MINERAL_RARITY.indexOf(b.rarity) <= MINERAL_RARITY.indexOf(a.rarity)) continue;
      if (!(b.rate > a.rate)) {
        inversions.push(`${b.rarity} ${b.id} ${b.rate.toFixed(2)}/min <= ${a.rarity} ${a.id} ${a.rate.toFixed(2)}/min`);
      }
    }
    console.log(`     kestrel adjacent-row ladder: ${inversions.length ? `INVERTS at ${inversions.join('; ')}` : 'ascends at every rarity step'}`);
    if (P.id === 'cinder') {
      assert.deepEqual(inversions, [],
        'Cinder is the reference mineral table and its ladder has to pay at every step');
    }

    /* Tier best rates: the registry-wide floors. */
    const byTier = new Map();
    for (const r of rows) {
      const t = MINERAL_RARITY.indexOf(r.min.rarity);
      byTier.set(t, Math.max(byTier.get(t) ?? 0, r.trips[0].rate));
    }
    const tiers = [...byTier.entries()].sort((a, b) => a[0] - b[0]);
    console.log('     kestrel by tier: '
      + tiers.map(([t, rate]) => `${MINERAL_RARITY[t]} ${rate.toFixed(0)}`).join('  ->  ')
      + `   exotic/common ${(tiers[tiers.length - 1][1] / tiers[0][1]).toFixed(1)}x (floor 10x)`);
    for (let i = 1; i < tiers.length; i++) {
      /* Up to `rare` only - see the docblock for the Lathe rare/exotic tie. */
      if (MINERAL_RARITY[tiers[i][0]] === 'exotic') continue;
      if (!(tiers[i][1] > tiers[i - 1][1])) {
        stepFail.push(`${P.id}: ${MINERAL_RARITY[tiers[i][0]]} pays ${tiers[i][1].toFixed(0)} cr/min against`
          + ` ${tiers[i - 1][1].toFixed(0)} for ${MINERAL_RARITY[tiers[i - 1][0]]} - the ladder does not pay`);
      }
    }
    const spread = tiers[tiers.length - 1][1] / tiers[0][1];
    if (!(spread >= 10)) {
      spreadFail.push(`${P.id}: the exotic tier pays ${spread.toFixed(1)}x the common one`
        + ' - the payoff for a second landing is inside the noise of a common seam');
    }

    /* And the honest note, measured rather than asserted.
     *
     * The Dray's column is NOT monotone, and that is a property worth keeping
     * rather than a failure worth tuning away: 40 m3 rewards a dense seam under
     * a landing pad more than a scarce one at the end of a march. Rheniite has
     * nine reachable nodes at one cubic metre each, so a bulk hauler flies 40 m3
     * of hold to Cinder and brings back nine - and earns less doing it than it
     * would on ferro-basalt, which has eighteen nodes inside 66 m of its own
     * landing pad.
     *
     * Printed and not asserted: pinning it would pin an accident of two hull
     * stats, and the thing that must hold is the Kestrel floor above. */
    const dray = new Map(rows.map((r) => [r.min.id, r.trips[1]]));
    const drayInv = [];
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1].min;
      const b = rows[i].min;
      if (MINERAL_RARITY.indexOf(b.rarity) <= MINERAL_RARITY.indexOf(a.rarity)) continue;
      if (dray.get(b.id).rate <= dray.get(a.id).rate) {
        drayInv.push(`${b.id} ${dray.get(b.id).rate.toFixed(0)}/min <= ${a.id} ${dray.get(a.id).rate.toFixed(0)}/min`);
      }
    }
    console.log(`     note: the Dray inverts the ladder at ${drayInv.length ? drayInv.join('; ') : 'nothing'}`
      + ' - a 40 m3 hold is paid by seam DENSITY, and a dense seam under a pad beats a scarce one at the end of a march.');
    console.log(`     what a Dray actually leaves with: ${rows.map((r) => `${r.min.id} ${r.trips[1].vol}/${hulls[1].hold} m3`).join(', ')}`);
  }
  console.log(`   the nearest-neighbour tours cost ${(totalMs / 1000).toFixed(1)} s across ${ALL.length} planets`
    + ' - every planet measured, nothing sampled and nothing capped');
  assert.deepEqual(stepFail, [], 'the rarity ladder has to pay more per minute at every tier up to rare');
  assert.deepEqual(spreadFail, [], 'the exotic tier is the payoff for a second landing and has to look like one');
});
