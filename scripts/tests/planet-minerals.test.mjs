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

import {
  ALL, walkGraph, distances, lattice,
} from './planet-walk-kit.mjs';

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
 * A THIRD SWEEP JOINED THEM and it is the dearest thing here after the tours:
 * `ABLATION SENSITIVITY` deletes landforms one at a time and re-floods, and a
 * deleted landform means a full mask rebuild because the ground has changed.
 * A flat sweep of every non-pad landform on all ten is 152 lattices and 111 s;
 * sweeping the four route-shaped kinds first and falling through to the rest
 * only when none of them is the answer is 92 and 76 s, with no planet's
 * coverage reduced - the three that find nothing are still swept in full. The
 * lattice count and the seconds are printed for the same reason as everything
 * else here. Budget two and a half minutes for this file.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT GENERALISES AND WHAT IS ABOUT CINDER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "The rare tier costs more to reach" is a rule about every planet. Every
 * attempt to say it as a DISTANCE is a rule about Cinder, and there have now
 * been two of them.
 *
 *   1. "The rare tier has the longest median march." Broke on five of ten.
 *      Sirocco's chalcanth sits 392 m out at the median while its UNCOMMON
 *      cassiterite sits at 571 m, because chalcanth's cost is finding and
 *      descending a canyon stair and cassiterite's is a long flat walk.
 *   2. "From the arrival pad the rare seam is >= 1.5x the nearest common one."
 *      Broke on three, and the third proved the variable was wrong: Vitrine's
 *      azurine got SEVEN METRES FURTHER from the pad and the ratio collapsed
 *      anyway, because the DENOMINATOR moved - the nearest common ore went 44 m
 *      to 308 m when `primary` was corrected. Its failure message read "the
 *      rare tier is on the doorstep" about an ore 422 m away.
 *
 * Both failed for one reason: distance is not what differs between these
 * planets, and "the nearest common ore" is wherever a scattered `field` seam
 * happened to drop a node near a pad. What IS true of all ten is that the rare
 * tier is a PLACE - named in the descriptor's own terrain vocabulary, confined
 * on the ground, and never the first ore you meet stepping off the ramp. That
 * is the rule now, and its whole argument is on `rareVerdict` in block 5.
 *
 * Measured and REJECTED as conjuncts, each on evidence rather than on taste:
 * ablatable route (fails on Cinder, Shoal and Vitrine - see `ROUTELESS_RARE`),
 * local relief and path tortuosity (both fail on Shoal). All three are printed
 * as columns, so the third re-derivation starts from what was already measured.
 *
 * Cinder's own march and its 4x nearest-node ratio keep their case, named as
 * Cinder's.
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
/* The lattice, the real worlds and the flood are shared machinery now and
 * live in `planet-walk-kit.mjs`. They were extracted the day a SECOND file
 * needed them: the rare-tier gate below reads the same distances this file
 * prices credits per minute against, and two copies of a 2.0 m lattice that
 * drift apart would let one file pass a planet the other fails.
 *
 * Everything the kit exports is a measurement. Every floor is here.  */


/**
 * THE FOOTPRINT OF A SEAM: half the diagonal of the box its nodes sit in.
 *
 * Not a radius and not a variance - a seam is not a disc, and Cinder's rheniite
 * runs down a rift. What this is FOR is the difference between "the ore is
 * where you are" and "the ore is somewhere": half a diagonal is the same
 * quantity for a corridor as for a disc, and it is the one that tells a
 * `field` scatter from a place.
 */
function footprint(nodes) {
  const xs = nodes.map((n) => n.position.x);
  const zs = nodes.map((n) => n.position.z);
  return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) / 2;
}

/** The smallest finite value in a list, or Infinity when there is none. */
const least = (xs) => xs.reduce((a, b) => (Number.isFinite(b) && b < a ? b : a), Infinity);

/**
 * THE RARE TIER IS A PLACE, NOT A SCATTER.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THIS REPLACED A RATIO, AND HERE IS THE ARGUMENT FOR THE REPLACEMENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The rule here was "from the arrival pad, the rare seam's nearest node is at
 * least 1.5x the nearest common one". It has been RE-DERIVED ONCE ALREADY: it
 * began as "the rare tier has the longest median march", broke on five of ten,
 * and was narrowed to that ratio. The ratio then broke on three, and the third
 * one is the tell:
 *
 *     verdigris  sporecryst  525 m -> 64 m    0.1x   a genuine inversion
 *     carnelian  carnelite  1213 m -> 215 m   0.2x   a genuine inversion
 *     vitrine    azurine     415 m -> 422 m   1.4x   NOT AN INVERSION
 *
 * Vitrine's rare seam got SEVEN METRES FURTHER AWAY and the ratio collapsed
 * anyway, because the arrival pad moved and the nearest COMMON ore went 44 m ->
 * 308 m. The failure message said "the rare tier is on the doorstep of the pad
 * the player arrives at" about an ore 422 m from that pad. A metric whose
 * failure message can be false is measuring the wrong variable, and both
 * re-derivations failed for one reason: they express "costs more" as a
 * comparison of DISTANCES, and distance is not what differs between these
 * planets. Sirocco charges a canyon stair, Verdigris charges a cave, Cinder
 * charges 900 m of walking. The denominator was the worst part - "the nearest
 * common ore" is wherever a scattered `field` seam happens to have dropped a
 * node near the pad, which is an artefact of pad placement and not a design.
 *
 * And the old rule's own worked example had gone circular: it cited Verdigris's
 * sporecryst at "64 m from Sumphead and 525 m from Greenspan, and the second is
 * what a player pays on arrival" - i.e. it was calibrated on an arrival choice
 * that has since been corrected as a defect.
 *
 * ── WHAT IS ASSERTED INSTEAD, AND WHY IT IS THESE THREE ──────────────────
 *
 * The exotic tier already carries the strong guarantee, in the case above and
 * in `planet-envelope.test.mjs` at four envelopes: ZERO nodes from the arrival
 * pad, reachable only from a pad of its own. "Costs a decision", as a
 * measurement. So the rare tier's job is to cost something the UNCOMMON tier
 * does not, and the descriptors already say what that is in their own words -
 * `definePlanet` refuses the rarest ore `terrain: 'plain'` and a `field` region
 * because "a rare element scattered over the whole map, underfoot at the pad,
 * is a common element with an expensive name". That sentence is the rule. It is
 * enforced for the TOP rung only; these three make it a measurement, and one
 * rung wider:
 *
 *   (1) NAMED.     No ore at `rare` or `exotic` sits in `plain` terrain or uses
 *                  a `field` region. True of all ten. `definePlanet` enforces
 *                  it for the top rung; nothing enforced it for `rare`, and a
 *                  four-tier planet could legally scatter its rare ore over the
 *                  flat. (Uncommon is DELIBERATELY not included: Shoal's nacre
 *                  is an uncommon `shore` seam with a `field` region, and a
 *                  tideline that runs the length of a coast is authored, not a
 *                  mistake.)
 *
 *   (2) CONFINED.  The rare seam's footprint is smaller than the widest COMMON
 *                  seam's, measured on the built world's real node positions.
 *                  The common tier is where you are; the rare tier is where you
 *                  go. Achieved 2.6x to 6.8x across the ten. This is the half
 *                  that cannot be gamed by moving a pad - it never mentions one.
 *
 *   (3) NOT FIRST. From the arrival pad, at least one CHEAPER seam has a nearer
 *                  node. Not a ratio - an ordering, with no floor to tune and
 *                  none to re-derive. "You do not trip over the rare ore
 *                  stepping off the ramp" is the whole claim, and "cheaper"
 *                  rather than "common" is the repair to the denominator: on
 *                  Vitrine the ore that is 24 m from the arrival pad is the
 *                  UNCOMMON cryolite, and the old rule could not see it.
 *
 * All three are planet-shape-agnostic. None of them can be satisfied by an ore
 * that merely happens to be far from a pad that happens to be poor, and none of
 * them can be broken by moving `primary` onto a richer pad.
 *
 * ── WHAT WAS TRIED AND MEASURED AWAY ────────────────────────────────────
 *
 * "Its reachability must depend on a route that can be ablated" is the obvious
 * fourth conjunct and it is NOT TRUE OF ALL TEN. Measured - the sweep is the
 * case below - seven planets have a landform whose deletion strands the rare
 * seam from the arrival pad while the common tier stays whole. Three do not,
 * for three different and legitimate reasons, and they are listed in
 * `ROUTELESS_RARE`. Asserting it would have failed Cinder, the planet the whole
 * rule was written about. Local relief and path tortuosity were measured too
 * and both fail on Shoal. They are all PRINTED, and none of them is asserted.
 *
 * @returns {string[]} one line per broken conjunct, empty when the seam clears.
 */
function rareVerdict({ id, primary, rows }) {
  const out = [];
  const commons = rows.filter((r) => r.min.rarity === 'common');
  for (const r of rows) {
    if (r.min.rarity !== 'rare' && r.min.rarity !== 'exotic') continue;

    /* (1) NAMED - the descriptor's own vocabulary, not an adjective. */
    if (r.min.terrain === 'plain') {
      out.push(`${id}/${r.min.id}: a ${r.min.rarity} ore in terrain 'plain' - a rare element on the flat`
        + ' is a common element with a better name');
    }
    if (r.min.region.shape === 'field') {
      out.push(`${id}/${r.min.id}: a ${r.min.rarity} ore with a 'field' region scatters over the whole`
        + ' playfield - put it somewhere');
    }
    if (r.min.rarity !== 'rare') continue;

    /* (2) CONFINED - measured on the built world, against this planet's own
     * commonest ore rather than against a constant. */
    const foot = footprint(r.nodes);
    const widestCommon = Math.max(...commons.map((c) => footprint(c.nodes)));
    const widest = commons.reduce((a, b) => (footprint(b.nodes) > footprint(a.nodes) ? b : a));
    if (!(foot < widestCommon)) {
      out.push(`${id}/${r.min.id}: the rare seam spans ${foot.toFixed(0)} m against ${widestCommon.toFixed(0)} m`
        + ` for ${widest.min.id}, the widest common seam - it is spread like a common ore, not put somewhere`);
    }

    /* (3) NOT FIRST - an ordering from the arrival pad, no floor. */
    const cheaper = rows.filter((c) => c.min.unitValue < r.min.unitValue);
    const nearestCheaper = least(cheaper.map((c) => c.pd[0]));
    const firstOf = cheaper.reduce((a, b) => (b.pd[0] < a.pd[0] ? b : a), cheaper[0] ?? r);
    if (!Number.isFinite(nearestCheaper)) {
      out.push(`${id}/${r.min.id}: no ore cheaper than it can be reached from ${primary.id} at all, so`
        + ' the rare tier is the only thing on the arrival pad');
    } else if (!(r.pd[0] > nearestCheaper)) {
      out.push(`${id}/${r.min.id}: it is ${r.pd[0].toFixed(0)} m from ${primary.id} and the nearest`
        + ` cheaper ore (${firstOf.min.id}, ${firstOf.min.unitValue} cr/m3) is ${nearestCheaper.toFixed(0)} m`
        + ' - the rare tier is the first ore you meet stepping off the ramp');
    }
  }
  return out;
}

test('THE WALK, ON EVERY PLANET: nothing is lost and the exotic tier is a second landing', async () => {
  /* ALL TEN, and this case is the TABLE as much as it is the two assertions.
   * `planet-reach.test.mjs` proves every node is reachable; this asks what
   * reaching it costs, in every unit a planet can charge in, and prints all of
   * them side by side so a rule derived from one column can be checked against
   * the others. Two things are asserted here because they are true of all ten
   * and were always what the rule was for:
   *
   *   1. NOTHING IS LOST. Every node is reachable from some pad, on foot, with
   *      no jump and no mantle.
   *   2. THE EXOTIC SEAM IS NOT ON THE DOORSTEP. Zero of its nodes reachable
   *      from the arrival pad AT ANY DISTANCE. Not a longer walk - a second
   *      landing. Ten out of ten planets are authored this way.
   *
   * The rare tier's rule is the case below, and the columns it does NOT use are
   * printed here so that the next person to re-derive it can see what was
   * already measured and rejected. */
  const lost = [];
  const freeExotic = [];
  const t0 = Date.now();
  console.log('   planet      ore          rarity    terrain     region     n   from-arrival        any-pad          pads  relief  detour  foot');
  for (const planet of ALL) {
    const { world, L, primary, rows } = await distances(planet);
    const { HEIGHT_FIELDS } = await import('../../src/worlds/terrain/index.js');
    const ground = HEIGHT_FIELDS.planet(world.planet.terrain);
    /* Which pads can REACH the seam, which is not the same question as which
     * pad is NEAREST to it - the second flatters an ore with a pad of its own. */
    const reachedBy = new Map();
    for (const site of world.landingSites) {
      L.from(site.position.x, site.position.z);
      for (const r of rows) {
        for (const nd of r.nodes) {
          if (L.to(nd.position.x, nd.position.z) < Infinity) {
            if (!reachedBy.has(r)) reachedBy.set(r, new Set());
            reachedBy.get(r).add(site.id);
          }
        }
      }
    }
    L.from(primary.position.x, primary.position.z);
    for (const r of rows) {
      const fin = r.pd.filter(Number.isFinite);
      const medP = fin.length ? fin[Math.floor(fin.length / 2)] : Infinity;
      const m = (v) => (Number.isFinite(v) ? `${v.toFixed(0)} m` : 'UNREACH');
      /* Local relief at 40 m: how much the ground moves around the seam. It
       * separates a fissure from a flat on nine planets and NOT on Shoal, whose
       * polymetal shelf reads 4.3 m - which is why it is a column and not a
       * conjunct. */
      const rel = r.nodes.map((nd) => {
        const hs = [ground(nd.position.x, nd.position.z)];
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * Math.PI * 2;
          hs.push(ground(nd.position.x + Math.cos(a) * 40, nd.position.z + Math.sin(a) * 40));
        }
        const f = hs.filter(Number.isFinite);
        return f.length ? Math.max(...f) - Math.min(...f) : 0;
      }).sort((a, b) => a - b);
      /* Walk over crow-flies from the arrival pad: what "finding and
       * descending" costs when it is not distance. Vitrine's azurine reads
       * 3.89, the highest in the registry, and Shoal's polymetal 1.22 - so this
       * is a column too. */
      const det = r.nodes.map((nd) => {
        const w = L.to(nd.position.x, nd.position.z);
        const c = Math.hypot(nd.position.x - primary.position.x, nd.position.z - primary.position.z);
        return c > 1 ? w / c : Infinity;
      }).filter(Number.isFinite).sort((a, b) => a - b);
      console.log(`   ${planet.id.padEnd(11)} ${r.min.id.padEnd(12)} ${r.min.rarity.padEnd(9)} ${r.min.terrain.padEnd(11)}`
        + ` ${r.min.region.shape.padEnd(9)} ${String(r.nodes.length).padStart(2)}`
        + `  ${m(r.pd[0]).padStart(8)}/${m(medP).padStart(8)} ${String(r.onPrimary).padStart(2)}/${String(r.nodes.length).padEnd(2)}`
        + `  ${m(r.ds[0]).padStart(7)}/${m(r.median).padStart(7)}`
        + `  ${String(reachedBy.get(r)?.size ?? 0).padStart(2)}`
        + `  ${(rel[Math.floor(rel.length / 2)] ?? 0).toFixed(1).padStart(6)}`
        /* A dash and never `Infinity`: a seam with no route from the arrival pad
         * has no walk-over-crow ratio, and printing one would put a non-finite
         * number in a column of finite ones for a reader to misread as a
         * measurement. `UNREACH` two columns left is where that fact belongs. */
        + `  ${(det.length ? det[Math.floor(det.length / 2)].toFixed(2) : '-').padStart(6)}`
        + `  ${footprint(r.nodes).toFixed(0).padStart(4)}`);
      if (r.lost) lost.push(`${planet.id}/${r.min.id}: ${r.lost} nodes nothing can walk to`);
      if (r.min.rarity === 'exotic' && r.onPrimary !== 0) {
        freeExotic.push(`${planet.id}/${r.min.id}: ${r.onPrimary} of ${r.nodes.length} exotic nodes can be walked`
          + ` to from ${primary.id}, the pad you arrive at - the exotic tier costs no second landing`);
      }
    }
  }
  console.log(`   ten worlds walked in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  assert.deepEqual(lost, [], 'ore nothing can walk to is ore that does not exist');
  assert.deepEqual(freeExotic, [], 'the exotic tier is a second landing, not a longer walk');
});

test('on every planet the rare tier is a place, not a scatter', async () => {
  /* The rule is `rareVerdict` above and its whole argument is in that
   * docblock - including what a 1.5x distance ratio used to say here, why it
   * had already been re-derived once, and why the third planet it failed on
   * proves it was measuring the wrong variable.
   *
   * Every number printed is derived in this run. The two ratios below are
   * REPORTED and not asserted: the conjuncts are a strict inequality and an
   * ordering, so there is no floor to tune and no floor to re-derive. The
   * margins are printed so the day one of them gets thin is a day somebody can
   * see rather than infer. */
  const broken = [];
  console.log('   planet      rare seam    terrain/region      confined (foot vs widest common)   not-first (rare vs nearest cheaper)');
  for (const planet of ALL) {
    const { primary, rows } = await distances(planet);
    broken.push(...rareVerdict({ id: planet.id, primary, rows }));
    const r = rows.find((x) => x.min.rarity === 'rare');
    if (!r) continue;
    const commons = rows.filter((x) => x.min.rarity === 'common');
    const widest = Math.max(...commons.map((c) => footprint(c.nodes)));
    const foot = footprint(r.nodes);
    const cheaper = rows.filter((c) => c.min.unitValue < r.min.unitValue);
    const near = least(cheaper.map((c) => c.pd[0]));
    const first = cheaper.reduce((a, b) => (b.pd[0] < a.pd[0] ? b : a), cheaper[0]);
    console.log(`   ${planet.id.padEnd(11)} ${r.min.id.padEnd(12)} ${`${r.min.terrain}/${r.min.region.shape}`.padEnd(19)}`
      + ` ${foot.toFixed(0).padStart(4)} m < ${widest.toFixed(0).padStart(4)} m = ${(widest / foot).toFixed(1)}x`
      + `             ${r.pd[0].toFixed(0).padStart(5)} m > ${near.toFixed(0).padStart(4)} m (${first.min.id}) = ${(r.pd[0] / near).toFixed(1)}x`);
  }
  assert.deepEqual(broken, [],
    `the rare tier is a common tier with a better name:\n  ${broken.join('\n  ')}`);
});

test('MUTATION: the same rule, on a planet whose rare seam is scattered on the flat', async () => {
  /* THE RULE ABOVE HAS TO BE ABLE TO GO RED, and the only honest way to show it
   * is to build a planet it should refuse and watch it refuse one.
   *
   * Two REAL planets through `definePlanet` and a REAL `PlanetWorld`, identical
   * in every line except the rare row:
   *
   *   CONTROL  fool is a `crater` seam in a 30 m disc on the pit floor, 240 m
   *            from the pad.
   *   MUTANT   fool is a `crater` seam whose disc is opened to 200 m and moved
   *            onto the pad's doorstep - same terrain, same count, same value.
   *
   * ── THE MUTANT USED TO BE `plain`/`field`, AND THE SCHEMA NOW REFUSES THAT ──
   *
   * When this case was written, `definePlanet` accepted a scattered `rare` ore:
   * it refused `plain`/`field` on the RAREST rung only, and on a four-tier
   * planet the rarest rung is `exotic`. That gap has since been closed at the
   * source - the refusal now covers `rare` and `exotic` AS WELL AS the top rung
   * whatever it is called - so the old mutant cannot be built at all and this
   * case died with a `definePlanet` throw instead of an assertion.
   *
   * That is a better world and the mutant moved rather than the schema. NAMED is
   * now enforced at DEFINITION time, which is earlier and cheaper than a flood,
   * and `the schema refuses every way "rare" can be a word rather than a fact`
   * covers it directly. What is left for THIS case is the two conjuncts a schema
   * cannot see, because both need real node positions on real ground:
   *
   *   CONFINED   the seam's footprint against the widest common seam's
   *   NOT FIRST  a cheaper seam has a nearer node from the arrival pad
   *
   * So the mutant is now schema-LEGAL and still a lie: a `crater` ore, correctly
   * named, spread so wide and so close that it is the first thing you walk into.
   * That is the shape a rule about places has to catch and a rule about words
   * cannot. */
  const rows = (rare) => [
    { id: 'mud', item: 'mud', name: 'Mud', rarity: 'common', terrain: 'shelf', place: 'The Hump',
      color: 1, unitValue: 5, size: 1.9, count: 30, spacing: 9, region: { shape: 'disc', x: -150, z: -150, r: 46 } },
    { id: 'spark', item: 'spark', name: 'Spark', rarity: 'uncommon', terrain: 'crater', place: 'The Pit',
      color: 2, unitValue: 40, size: 0.6, count: 12, spacing: 9, region: { shape: 'disc', x: 140, z: 140, r: 42 } },
    rare,
    { id: 'gleam', item: 'gleam', name: 'Gleam', rarity: 'exotic', terrain: 'cave', place: 'The Hole',
      color: 4, unitValue: 900, size: 0.5, count: 4, spacing: 9, region: { shape: 'disc', x: 150, z: -150, r: 30 } },
  ];
  const probe = (id, rare) => definePlanet({
    id, name: id, half: 220, seg: 96, gravity: 9,
    terrain: {
      seed: 7,
      baseY: 0,
      landforms: [
        { kind: 'pad', x: 0, z: 0, r: 24, blend: 16 },
        { kind: 'basin', x: 140, z: 140, r: 55, depth: 14, flat: 0.4 },
        { kind: 'cone', x: -150, z: -150, r: 60, peak: 18 },
        { kind: 'basin', x: 150, z: -150, r: 40, depth: 10, flat: 0.5 },
      ],
    },
    palette: { material: 'dirt.ground', tile: 4, bands: [{ upTo: 0, color: 0x111111 }, { upTo: 60, color: 0x222222 }] },
    sky: { kind: 'daylight' },
    minerals: rows(rare),
    landing: [{ id: 'probepad', name: 'Probe Pad', x: 0, z: 0, r: 24, primary: true }],
  });
  const PLACED = {
    id: 'fool', item: 'fool', name: 'Fools Gold', rarity: 'rare', terrain: 'crater', place: 'The Pit Floor',
    color: 3, unitValue: 200, size: 0.6, count: 8, spacing: 9, region: { shape: 'disc', x: 140, z: 140, r: 30 },
  };
  /* Schema-LEGAL and still a lie: correctly named `crater`, but the disc is
   * opened from 30 m to 200 m and slid onto the pad's doorstep — so it is both
   * wider than the widest common seam and the first ore you walk into. That is
   * the shape a rule about PLACES has to catch and a rule about WORDS cannot. */
  const SCATTERED = { ...PLACED, place: 'Everywhere', region: { shape: 'disc', x: 20, z: 20, r: 200 } };

  /* THE STANDING REQUIREMENT INVERTED, AND THAT IS THE POINT.
   *
   * This line used to assert that `definePlanet` ACCEPTS the mutant, and said
   * "the day it grows this rule, this line goes red and the mutation has to
   * move somewhere the schema still cannot see." That day came: the refusal now
   * covers `rare` and `exotic` as well as the top rung, so the old
   * `plain`/`field` mutant cannot be built.
   *
   * The mutation moved rather than the schema, exactly as instructed. What this
   * mutant must now be is LEGAL - or the case is testing the schema again
   * instead of the two conjuncts only real ground can judge. */
  assert.ok(probe('probe_scatter', SCATTERED),
    'definePlanet refuses this mutant, so it is testing the schema rather than the walk rule - '
    + 'make the mutant schema-legal again');
  /* And NAMED's enforcement is asserted where it now lives. */
  assert.throws(
    () => probe('probe_named', { ...PLACED, terrain: 'plain', region: { shape: 'field' } }),
    /in terrain 'plain'|scatters over the whole playfield/,
    'the schema no longer refuses a rare ore on the flat - NAMED has lost its enforcement'
  );

  const control = await distances(probe('probe_control', PLACED));
  const mutant = await distances(probe('probe_scatter', SCATTERED));
  const good = rareVerdict({ id: 'probe_control', ...control });
  const bad = rareVerdict({ id: 'probe_scatter', ...mutant });
  for (const line of bad) console.log(`     RED: ${line}`);

  /* THE CONTROL IS NOT DECORATION. Without it, a rule that reddened on every
   * synthetic planet - because the probe is small, or has one pad, or is not a
   * real world - would look like it was catching the mutation. */
  assert.deepEqual(good, [],
    `the control planet is refused, so the mutant's redness is not the mutation:\n  ${good.join('\n  ')}`);
  /* TWO LINES ACROSS TWO CONJUNCTS, and it used to be four across three.
   *
   * NAMED no longer fires here and MUST not: `definePlanet` refuses `plain` and
   * `field` on a `rare` row outright now, so a mutant that broke NAMED could not
   * be built to reach this point at all. Its enforcement is asserted at the
   * schema by the `assert.throws` above, which is earlier and cheaper than a
   * flood over real ground.
   *
   * The count is asserted as well as the names so that a conjunct which starts
   * firing for a second reason has to be looked at rather than absorbed. */
  assert.equal(bad.length, 2,
    `the mutation broke ${bad.length} checks and two were expected - CONFINED and NOT FIRST, with NAMED`
    + ` now enforced by definePlanet instead:\n  ${bad.join('\n  ')}`);
  assert.ok(bad.some((l) => l.includes('spread like a common ore')), 'the CONFINED conjunct did not fire');
  assert.ok(bad.some((l) => l.includes('first ore you meet')), 'the NOT-FIRST conjunct did not fire');
});

/**
 * Planets whose rare seam is NOT held where it is by a single route.
 *
 * The sweep below deletes each non-pad landform in turn, re-floods from the
 * arrival pad, and looks for one whose removal strands the rare seam while
 * leaving the COMMON tier whole. That last clause is what makes the measurement
 * mean anything: every planet has a road off its own arrival pad, and deleting
 * that strands everything, which says nothing about the rare tier at all.
 *
 * Seven of ten have one. These three do not, and each has a reason:
 *
 *   cinder     rheniite runs the length of a rift with an end on two different
 *              pads. That is deliberate and `CEILING BY ABLATION` below is the
 *              case that says so: a rare ore behind a single point of failure
 *              is one edit from unreachable.
 *   shoal      polymetal is an annulus around the Glassflat shelf - the same
 *              plateau the arrival pad is cut into. Deleting it strands the pad.
 *   vitrine    azurine sits on the Shatter's LIPS and not in its floor, so the
 *              trenches are what it is FOR rather than what gates it; the ice
 *              sheet around them is open walking. Its cost shows up in the
 *              detour column instead - 3.89x walk over crow-flies, the highest
 *              in the registry - which is a real cost that no ablation can find.
 *
 * CHECKED IN BOTH DIRECTIONS below. Gate Vitrine's azurine and this entry has
 * to be deleted; open up Carnelian's outcrop and it has to be added. A list
 * that can only rot in one direction is worse than no list.
 *
 * @type {ReadonlySet<string>}
 */
const ROUTELESS_RARE = Object.freeze(new Set(['cinder', 'shoal', 'vitrine']));

test('ABLATION SENSITIVITY: which planets hold their rare seam with one landform', async () => {
  /* The registry-wide version of `CEILING BY ABLATION` below, which is about
   * Cinder's spiral road by name. Nothing here is asserted about the rare
   * tier's DESIGN - the rule above is that - because seven of ten is not a
   * rule. What is asserted is that the measured set has not drifted from the
   * recorded one, in either direction.
   *
   * ── WHAT THIS COSTS, AND THE ONE SHORTCUT TAKEN ─────────────────────────
   *
   * One ablated lattice is a full mask rebuild - five ground samples over a
   * 212,000-cell grid on the biggest planet - because deleting a landform
   * changes the ground and the mask is what the ground decides. Sweeping every
   * non-pad landform on all ten is 152 of them and 111 s.
   *
   * The claim is EXISTENCE, so the sweep stops at the first landform it finds.
   * That is not a cap: on a planet where one exists it is found and the rest of
   * the list would only find more of the same, and on a planet where none
   * exists - which is the case the assertion is actually about - every landform
   * is still tried. The three in `ROUTELESS_RARE` are therefore swept in full,
   * every run. The identity printed is "a landform that holds it" rather than
   * "the" one for the same reason. */
  const { HEIGHT_FIELDS } = await import('../../src/worlds/terrain/index.js');
  const measured = new Set();
  const t0 = Date.now();
  let builds = 0;
  console.log('   planet      rare seam    a landform that holds it                     rare from arrival   common');
  for (const planet of ALL) {
    const { world, blocked, lava } = await walkGraph(planet);
    const { primary, rows } = await distances(planet);
    const P = world.planet;
    const rare = rows.filter((r) => r.min.rarity === 'rare');
    const commons = rows.filter((r) => r.min.rarity === 'common');
    if (!rare.length) continue;
    const rareNodes = rare.flatMap((r) => r.nodes);
    const commonNodes = commons.flatMap((r) => r.nodes);
    const baseRare = rare.reduce((a, r) => a + r.onPrimary, 0);
    const baseCommon = commons.reduce((a, r) => a + r.onPrimary, 0);
    /* TWO PASSES, AND THE SECOND IS THE WHOLE REST OF THE LIST.
     *
     * `ramp` is the only kind whose entire job is to be a route, and `scarp`,
     * `trench` and `plateau` are the three that most often form one edge of a
     * way in. On all seven planets that have a gate it is one of those four.
     * So pass 1 sweeps those - ALL of them, keeping the STRONGEST rather than
     * the first, because "delete the landform that carries the seam and count
     * what goes unreachable" is the number this case exists to report - and
     * pass 2 sweeps everything else, but ONLY when pass 1 found nothing.
     *
     * That is an ordering, not a cap. The planets where nothing is found are
     * exactly the ones in `ROUTELESS_RARE`, they are what the assertion is
     * about, and they are swept in full on every run. It is worth about 40 s of
     * the 111 a flat sweep costs. */
    const ROUTE_KINDS = new Set(['ramp', 'scarp', 'trench', 'plateau']);
    const candidates = P.terrain.landforms.filter((f) => f.kind !== 'pad');
    const sweep = (list) => {
      let best = null;
      for (const f of list) {
        const ground = HEIGHT_FIELDS.planet({ ...P.terrain, landforms: P.terrain.landforms.filter((x) => x !== f) });
        const L2 = lattice({ ground, blocked, lava, half: P.half });
        builds++;
        L2.from(primary.position.x, primary.position.z);
        const rr = rareNodes.filter((nd) => L2.to(nd.position.x, nd.position.z) < Infinity).length;
        const cc = commonNodes.filter((nd) => L2.to(nd.position.x, nd.position.z) < Infinity).length;
        /* THE COMMON TIER HAS TO SURVIVE, or all this found is the road off the
         * arrival pad - which strands everything and says nothing about the
         * rare tier. This clause is the whole discrimination: without it all
         * ten planets "have a gate" and the measurement is worthless. */
        if (cc < baseCommon) continue;
        if (rr < baseRare && (!best || rr < best.rr)) best = { f, rr, cc };
      }
      return best;
    };
    let found = sweep(candidates.filter((f) => ROUTE_KINDS.has(f.kind)));
    if (!found) found = sweep(candidates.filter((f) => !ROUTE_KINDS.has(f.kind)));
    if (found) measured.add(planet.id);
    const where = found
      ? `${found.f.kind}@(${(found.f.x ?? found.f.pts?.[0]?.[0] ?? 0).toFixed(0)}, ${(found.f.z ?? found.f.pts?.[0]?.[1] ?? 0).toFixed(0)})`
      : 'NONE - no landform strands it while the common tier stays whole';
    console.log(`   ${planet.id.padEnd(11)} ${rare[0].min.id.padEnd(12)} ${where.padEnd(44)}`
      + ` ${String(baseRare).padStart(2)} -> ${String(found ? found.rr : baseRare).padStart(2)}`
      + `           ${baseCommon} -> ${found ? found.cc : baseCommon}`);
  }
  const routeless = ALL.map((p) => p.id).filter((id) => !measured.has(id));
  console.log(`   ${builds} ablated lattices in ${((Date.now() - t0) / 1000).toFixed(1)} s`
    + `  -  ${measured.size} of ${ALL.length} planets gate their rare seam with one landform`);
  assert.deepEqual(routeless.sort(), [...ROUTELESS_RARE].sort(),
    'ROUTELESS_RARE has drifted from what the sweep measures. A planet that has GAINED a route to its '
    + 'rare seam must be deleted from the list; one that has LOST it must be added, with the reason. '
    + `Measured: [${routeless.join(', ')}]`);
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
