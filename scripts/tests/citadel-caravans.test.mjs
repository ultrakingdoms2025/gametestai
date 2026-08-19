import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import {
  corridors, caravanContent, evaluateFloors, floorCheck, f, i5,
  FLOORS, LONG_WALK_M, RECOGNITION, RENDER_IN, REFERENCE_TRAINS, WALK,
} from './citadel-traffic-kit.mjs';
import { CitadelTraffic, CARAVAN_ROADS } from '../../src/worlds/citadel/Caravans.js';
import { beastDef } from '../../src/npc/BeastSpecies.js';

const CAMEL_PACK_MAX = beastDef('camel').packMax;

/**
 * THE FLOORS THE CARAVANS AND THE OASES HAVE TO CLEAR.
 *
 * ── This file is RED on purpose, and it is red for exactly one reason ─────
 *
 * The Citadel is 900 m across with six regions round a central mesa, and the
 * flats between them contain nothing at all. Not "not much": the corridor model
 * in `citadel-traffic.test.mjs` finds 160 places the world publishes to some
 * system or other - relics, caches, viewpoints, trial venues, cave mouths,
 * region anchors, the spawn, the portal - and **not one of them stands in the
 * open flats.** 51.0% of the map is more than 30 m from anything that was
 * built, 33.9% more than 50 m, and the emptiest flat point in the world stands
 * 152.8 m from the nearest collider.
 *
 * The player walked it and said: *"it desperately needs npc's in the new areas.
 * In the large open areas between objects/villages/caves we should have npc's
 * leading wandering the areas with herds of camels and maybe 1 or 2 oasis
 * areas"*.
 *
 * Every gate below is therefore a FLOOR on ENCOUNTER, and every one of them
 * reads zero today. They are written before the placement rather than after it,
 * so that the placement has a target it can measure itself against instead of a
 * review it has to pass.
 *
 * ── The defect these five gates exist to prevent ──────────────────────────
 *
 * The medieval expansion added ten wolf and bear packs. Every link worked -
 * spawns returned bodies at all ten sites, zero refusals, well-formed specs,
 * residency ticking, 29 of 29 assertions green - and the player said *"i do not
 * see any wolves or bears in the forest areas."*
 *
 * The suite could not have caught it. All 29 assertions were "not closer than",
 * and **a world with no reachable wildlife in it satisfies every one of them.**
 * Median pack-to-road was 210 m. The nearest pack stood 317 m from the player
 * spawn. Three of ten ever came within render range of a road.
 *
 * Four things were learned in the seven rounds it took to fix, and all four
 * are load-bearing here:
 *
 *   A CLEARANCE SUITE CANNOT DETECT ABSENCE. So there is not one clearance in
 *   this file. Five floors, each with its achieved value and an ablation
 *   ceiling printed beside it.
 *
 *   DRAWN IS NOT SEEN. A five-wolf pack drawn with 38 m of margin was three
 *   pixels of 1,024,000. Every radius here is the measured 15 m RECOGNITION
 *   distance, never the 125 m render gate - which covers 69 times the area and
 *   would let a placement satisfy all five gates with specks on the horizon.
 *
 *   THE METRIC WAS WRONG THREE TIMES BEFORE IT WAS RIGHT. Visibility at range
 *   is unwinnable. What is measured is whether the content ARRIVES where the
 *   player is, and for the caravans - which move - it is measured against the
 *   caravan's own cycle rather than as a distance.
 *
 *   A SAFETY RULE CAN WORK PERFECTLY AGAINST ITS OWN BRIEF. Medieval had a
 *   clearance holding predators away from the roads, written so predators could
 *   not see travellers, while the brief asked for predators that attack you.
 *   Nobody noticed for the whole build. **Here the trap is inverted, and it is
 *   the likelier mistake.** Camels are not predators. They belong ON the travel
 *   corridors. Any rule in the placement that reads like a clearance - "keep
 *   caravans N metres from the player's path", "spread the oases evenly" - is
 *   this feature's version of that defect, and it will produce a world that
 *   passes a review and fails the player.
 *
 * ── How to make this file green ───────────────────────────────────────────
 *
 * Publish the content on the world. `caravanContent` in the kit reads three
 * shapes and documents all three; the shortest path is
 *
 *     world.caravanRoutes = [{ id, points: [{x,y,z}, ...], trains, animals }]
 *     world.oases         = [{ id, x, y, z, r, herd }]
 *
 * and a placement built entirely out of `npcSpawns` descriptors tagged
 * `camel` / `caravan` / `drover` / `herd` measures too, as herds of one.
 *
 * The ranked sites to put them on are printed by
 * `citadel-traffic.test.mjs` - THE RANKED SITES and THE ROUTE CATALOGUE. The
 * reference placement those floors were calibrated against is two caravan roads
 * carrying three eight-animal trains each plus two eight-camel oases: 64
 * animals, which scores 53.1 / 5.74 / 26.1 / 71.6 / 74.7 against these five
 * gates. THE FLOORS ARE REACHABLE in that same file proves it by running these
 * exact five gates over that exact placement and watching all five go green, so
 * a red here means the content is missing and never that the gate is impossible.
 */

/* ------------------------------------------------------------------ */
/* What the world publishes today                                      */
/* ------------------------------------------------------------------ */

let _rows = null;
async function gates() {
  if (_rows) return _rows;
  const C = await corridors();
  const content = caravanContent(C.world);
  const rows = evaluateFloors(content, {
    inter: C.inter, spawnJourneys: C.spawnJourneys, field: C.field, ceilings: C.ceilings,
  });
  _rows = { C, content, rows, by: Object.fromEntries(rows.map((r) => [r.key, r])) };
  return _rows;
}

test('WHAT IS OUT THERE: the caravan and oasis content the world publishes', async () => {
  const { C, content } = await gates();
  console.log('\n  read off the built world through the published contract:');
  console.log(`    world.caravanRoutes   ${i5(content.routes.length)} routes`);
  console.log(`    world.oases           ${i5(content.declaredOases.length)} oases`);
  console.log(`    npcSpawns tagged      ${i5(content.statics.length)} standing camels / drovers`);
  for (const r of content.routes) console.log(`      road  ${r.trains} x ${r.animals}  ${r.id}`);
  for (const o of content.declaredOases) console.log(`      oasis ${o.herd} camels r ${o.r} m at (${o.x | 0}, ${o.z | 0})`);
  const animals = content.routes.reduce((a, r) => a + r.trains * r.animals, 0)
    + content.oases.reduce((a, o) => a + o.herd, 0);
  console.log(`    ${animals} animals in a 900 m world, against ${C.inter.length} inter-region journeys`);

  /* The one assertion in this file that is about EXISTENCE rather than
   * encounter, and it is here so the first failure a reader sees names the
   * cause instead of a percentage. The four gates below are the ones that
   * matter; this one just says the cupboard is bare. */
  assert.ok(content.routes.length > 0 || content.oases.length > 0,
    'the Citadel publishes no caravan routes, no oases and no camel spawns. The six regions are '
    + 'built and reachable and the 810,000 m2 between them is empty: 51.0% of the map is more than '
    + '30 m from anything built, and not one of the 160 places this world publishes stands in the '
    + 'open flats. See THE RANKED SITES in citadel-traffic.test.mjs for where to put them');
});

/* ------------------------------------------------------------------ */
/* The five floors                                                     */
/* ------------------------------------------------------------------ */

test('FLOOR: inter-region journeys that MEET a caravan', async () => {
  const { by, C } = await gates();
  const r = by.caravanShare;

  /* WHY THIS IS A SHARE OF JOURNEYS AND NOT A COUNT OF CARAVANS.
   *
   * A count is what the medieval build asserted and passed with: ten packs
   * placed is ten packs placed whether or not anybody ever walks past one. What
   * a player experiences is a fraction - of the times they cross this world,
   * how often does something happen - and the only honest denominator is the
   * set of journeys they would plausibly make. That set is derived rather than
   * guessed: shortest walkable paths over the real reach graph between every
   * pair of the 160 places the world publishes, restricted here to the 8,384
   * that start and end in DIFFERENT parts of the map, because those are the
   * ones that cross the flats the player was complaining about.
   *
   * The numerator is measured over the caravan's own CYCLE, not as a distance.
   * A train is 32 m of animals on a route that may be 1,400 m round, so where
   * it happens to be when the player sets off decides everything; the metric is
   * the exact measure of the phases at which the two meet.
   *
   * THE SPACING OF THE FLOOR. One road with three trains reaches 32.9%. Two
   * well-chosen roads reach 53.1%. The floor is 40%, deliberately between them:
   * a single caravan cannot satisfy the player's sentence and two can.
   */
  floorCheck(r.label, r.floor, r.achieved, r.ceiling,
    `ceiling = all ${C.cat.routes.length} candidate roads carrying ${REFERENCE_TRAINS} trains at once`);
});

test('FLOOR: camels seen at recognition range, per inter-region journey', async () => {
  const { by } = await gates();
  const r = by.camelsMet;

  /* THE PLAYER ASKED FOR HERDS, NOT FOR A CAMEL.
   *
   * "herds of camels" is a claim about how many animals are in front of you at
   * once, and a share-of-journeys gate cannot see the difference between one
   * animal and twelve. So this one counts DISTINCT animals passed within the
   * 15 m recognition radius, averaged over the caravan phase, with each animal
   * given its own 4 m slot of the train and its own phase interval. The union
   * of those intervals is exactly the whole-train interval the gate above uses,
   * so the two can never disagree about whether an encounter happened - only
   * about how much of one it was.
   *
   * The ceiling is the same placement with the TIMING CONSTRAINT ABLATED: the
   * count at the single luckiest phase. That is a real ablation of a real
   * constraint rather than an invented bound, and it moves with the placement,
   * so it keeps meaning something after the content changes.
   */
  floorCheck(r.label, r.floor, r.achieved, r.ceiling, r.note);
});

test('FLOOR: inter-region journeys that meet an OASIS herd', async () => {
  const { by } = await gates();
  const r = by.oasisShare;

  /* "MAYBE 1 OR 2 OASIS AREAS", MEASURED.
   *
   * An oasis is static, so there is no phase and no probability - either the
   * walk goes past the water or it does not. The encounter radius is the
   * recognition distance plus the oasis radius, because a herd standing at an
   * 18 m watering ground is met from 33 m of its centre; the herd is laid on a
   * golden-angle spiral inside that radius so the answer does not depend on
   * every camel being at the same distance from the path.
   *
   * The best single site in the OPEN FLATS is met by 15.8% of inter-region
   * journeys, and the best pair by 28.4%. The floor is 20%: one oasis cannot
   * make it and two sited by measurement can, which is the same shape as the
   * caravan floor and for the same reason.
   *
   * The ceiling is an ablation of the content budget: every one of the 1,417
   * legal flats cells holding an oasis at once reaches 81.2%, so nineteen
   * journeys in a hundred cross the flats without passing anywhere an oasis
   * could legally be put. That is a fact about the map and not about the
   * placement, and it is why this floor is 20 and not 60.
   */
  floorCheck(r.label, r.floor, r.achieved, r.ceiling, r.note);
});

test('FLOOR: journeys from the player spawn that meet any camel', async () => {
  const { by, C } = await gates();
  const r = by.spawnAnyShare;

  /* THE MEDIEVAL DEFECT AS A SINGLE NUMBER.
   *
   * Its nearest wolf pack stood 317 m from the player spawn. Nothing in a
   * 29-assertion suite noticed, because nothing in it was about the spawn. The
   * first minute of a session is the one the player judges the world on, and
   * every session in this world starts at (0, 14.3, 104) with the souk stepping
   * up to the great tower in front of them.
   *
   * So this gate is the same encounter metric over the 153 journeys that begin
   * or end at the spawn - caravans by phase, oases outright, the two combined
   * as independent misses because a route's phase is its own free variable at
   * world load. The reference placement reaches 71.6% here, largely because one
   * of its two roads starts at the spawn; a placement that puts its content
   * only out on the ring will fail this and pass the others.
   */
  floorCheck(r.label, r.floor, r.achieved, r.ceiling,
    `${C.spawnJourneys.length} journeys touch the spawn`);
});

test('FLOOR: inter-region walks with no long stretch of nothing in them', async () => {
  const { by } = await gates();
  const r = by.shortWalkShare;

  /* THE COMPLAINT ITSELF, TURNED INTO A GATE.
   *
   * "In the large open areas between objects/villages/caves" is not about being
   * met by a caravan; it is about the walk. Measured every 2 m along every
   * inter-region journey, the longest run with nothing within recognition is a
   * median of 108 m and a p90 of 272 m - four and a half minutes of walking on
   * the worst of them, at 4.6 m/s, past nothing at all.
   *
   * This is the only one of the five that is not zero today: 63.3% of walks
   * already have no 150 m stretch of nothing in them. Emptiness is a matter of
   * degree where encounter is a matter of absence, and the floor of 72% is
   * therefore a demand for a real improvement on a real baseline rather than a
   * demand that something exist.
   *
   * CARAVANS ARE DELIBERATELY NOT COUNTED HERE. A thing that is only sometimes
   * there cannot be relied upon to fill a stretch, and this measurement is
   * about what the walk is like at its WORST. Only the oases count - which
   * makes this gate, in practice, the one that decides where the two oases go
   * rather than how many camels are on the road.
   */
  floorCheck(r.label, r.floor, r.achieved, r.ceiling,
    `baseline 63.3% with nothing placed; a stretch is ${LONG_WALK_M} m without anything within ${RECOGNITION} m`);
});


/* ------------------------------------------------------------------ */
/* The sixth floor: the same encounter, with the live budget applied   */
/* ------------------------------------------------------------------ */

/**
 * A body-counting stand-in for `NPCManager`, with the manager's own clamp.
 *
 * The five floors above score DECLARATIONS - `world.caravanRoutes` and
 * `world.oases` - and a declaration is exactly the kind of thing this project
 * has shipped and been wrong about. Nothing in them can see
 * `CitadelTraffic.maxLiveBeasts`, and the world declares 109 camels against a
 * live budget of twelve. Measured before the budget was made to re-allocate,
 * the cap cost 12.9 points of caravan share and 2.93 camels a journey - 44% of
 * the number the gate above prints - and every one of the five stayed green.
 */
class CountingManager {
  constructor() { this.live = new Set(); }

  owns(npc) { return this.live.has(npc); }

  despawn(npc) { this.live.delete(npc); }

  spawnOne() { return null; }

  spawnBeastGroup(spec, budget) {
    /* `min(asked, budget, def.packMax)` - the manager's own line. */
    const n = Math.max(0, Math.min(spec.count, budget, CAMEL_PACK_MAX));
    const made = [];
    for (let i = 0; i < n; i++) {
      const b = { kind: 'beast', home: spec.position.clone() };
      this.live.add(b);
      made.push(b);
    }
    return made;
  }
}

/** A traffic instance over the world's own published roads and herds. */
function liveRig(world, cap) {
  const mgr = new CountingManager();
  const roads = world.caravanRoutes.map((r, i) => ({
    ...CARAVAN_ROADS[i],
    waypoints: r.points.map((p) => new THREE.Vector3(p.x, p.y, p.z)),
  }));
  const camps = world.oases.map((o) => ({
    id: o.id, label: o.label, herd: o.herd, r: o.r, keeper: null,
    position: new THREE.Vector3(o.x, o.y, o.z),
  }));
  return new CitadelTraffic({
    npcManager: () => mgr, physics: world.physics,
    roads, camps, wanderers: [], maxLive: 0, maxLiveBeasts: cap,
  });
}

/**
 * Walk a sample of the inter-region journeys with the streaming machinery
 * running, and count the BODIES that came within recognition range.
 *
 * Every animal counted here is one `spawnBeastGroup` actually made, standing at
 * the anchor `driveHerds` actually gave it, under the budget the game actually
 * runs. The player walks at `WALK`, the traffic is stepped at the same 1/4 s
 * everywhere, and the caravans dead-reckon from the world's own seeded phases -
 * so the caravan phase averages over the sample rather than over an integral.
 */
function walkSample(world, sample, cap) {
  const pop = liveRig(world, cap);
  const DT = 0.25;
  const STEP = WALK * DT;
  let metCaravan = 0;
  let metHerd = 0;
  let camels = 0;
  const seen = new Set();
  for (const j of sample) {
    const poly = j.poly;
    let hitCaravan = false;
    let hitHerd = false;
    seen.clear();
    for (let i = 2; i < poly.length; i += 2) {
      const ax = poly[i - 2];
      const az = poly[i - 1];
      const bx = poly[i];
      const bz = poly[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      const steps = Math.max(1, Math.ceil(len / STEP));
      for (let k = 0; k < steps; k++) {
        const u = (k + 1) / steps;
        const x = ax + (bx - ax) * u;
        const z = az + (bz - az) * u;
        pop.update(x, z, DT);
        for (const t of pop.trains) {
          for (const b of t.camels) {
            if (seen.has(b)) continue;
            if (Math.hypot(b.home.x - x, b.home.z - z) > RECOGNITION) continue;
            seen.add(b); camels++; hitCaravan = true;
          }
        }
        for (const cmp of pop.camps) {
          for (const b of cmp.bodies) {
            if (seen.has(b)) continue;
            if (Math.hypot(b.home.x - x, b.home.z - z) > RECOGNITION) continue;
            seen.add(b); camels++; hitHerd = true;
          }
        }
      }
    }
    if (hitCaravan) metCaravan++;
    if (hitHerd) metHerd++;
  }
  const n = sample.length;
  return {
    caravan: (metCaravan / n) * 100,
    herd: (metHerd / n) * 100,
    camels: camels / n,
    refused: pop.stats.refused,
    evicted: pop.stats.evicted,
  };
}

let _live = null;
async function liveGate() {
  if (_live) return _live;
  const C = await corridors();
  /* Every 34th inter-region journey, which is 247 of the 8,384 - enough that
   * the caravan phase averages out and cheap enough to run twice. Taken by
   * stride rather than at random so the sample is the same on every machine. */
  const every = Math.max(1, Math.floor(C.inter.length / 240));
  const sample = C.inter.filter((_, i) => i % every === 0);
  const capped = walkSample(C.world, sample, C.world._population.maxLiveBeasts);
  const uncapped = walkSample(C.world, sample, 10000);
  _live = { C, sample, capped, uncapped };
  return _live;
}

test('FLOOR: what a walker MEETS once the live animal budget is applied', async () => {
  const { C, sample, capped, uncapped } = await liveGate();
  const cap = C.world._population.maxLiveBeasts;

  console.log(`\n  ${sample.length} inter-region journeys walked at ${WALK} m/s with the real streaming code,`);
  console.log('  counting bodies that came within recognition range:');
  console.log('                                          budget of ' + String(cap).padStart(2)
    + '   budget ablated');
  console.log(`    journeys meeting a caravan (%)           ${f(capped.caravan, 1).padStart(9)}`
    + `   ${f(uncapped.caravan, 1).padStart(9)}`);
  console.log(`    journeys meeting a static herd (%)       ${f(capped.herd, 1).padStart(9)}`
    + `   ${f(uncapped.herd, 1).padStart(9)}`);
  console.log(`    camels met at ${RECOGNITION} m per journey         ${f(capped.camels, 2).padStart(9)}`
    + `   ${f(uncapped.camels, 2).padStart(9)}`);
  console.log(`    refusals / evictions                     ${i5(capped.refused)} / ${i5(capped.evicted)}`);

  /* THE ABSOLUTE FLOORS, restated over bodies rather than over declarations.
   * They are the same two numbers the declared gates use, because a placement
   * that meets them on paper and not in the world has not met them. */
  floorCheck('LIVE  journeys meeting a caravan (%)', FLOORS.caravanShare * 100,
    Math.round(capped.caravan * 10) / 10, Math.round(uncapped.caravan * 10) / 10,
    '(ceiling = the same walk with the animal budget ablated)');
  floorCheck(`LIVE  camels met at ${RECOGNITION} m per journey`, FLOORS.camelsMet,
    Math.round(capped.camels * 100) / 100, Math.round(uncapped.camels * 100) / 100,
    '(ceiling = the same walk with the animal budget ablated)');

  assert.ok(capped.caravan >= FLOORS.caravanShare * 100,
    `${capped.caravan.toFixed(1)}% of journeys meet a caravan BODY against a floor of ${FLOORS.caravanShare * 100}%`);
  assert.ok(capped.camels >= FLOORS.camelsMet,
    `${capped.camels.toFixed(2)} camel bodies met per journey against a floor of ${FLOORS.camelsMet}`);

  /* AND THE BUDGET MAY NOT EAT THE PLACEMENT.
   *
   * This is the assertion the five declared gates cannot make and the one the
   * defect lived behind. The live animal budget is oversubscribed 79.8% of the
   * time on the shipped roads - 23.5 declared camels sit inside the 175 m
   * stream radius on average against a cap of 12 - so what the player meets is
   * decided by how the budget is SPENT, not by how much content was declared.
   * Handed out nearest-first at acquire and never re-allocated, it delivered
   * 3.75 camels a journey against the 6.68 the same placement can reach: the
   * declaration was 44% fiction. With the furthest herd evicted for a nearer
   * one and short herds topped up when room frees, the same cap delivers 96%.
   *
   * The floor is 85%, between those two, so neither the old behaviour nor a
   * future regression to it can pass, and it is a RATIO rather than an
   * absolute so it keeps meaning something if the placement changes.
   */
  const delivered = capped.camels / uncapped.camels;
  floorCheck('LIVE  share of the placement the budget delivers (%)', 85,
    Math.round(delivered * 1000) / 10, 100, '(ceiling = an unbounded budget, by definition)');
  assert.ok(delivered >= 0.85,
    `the live budget delivers ${(delivered * 100).toFixed(1)}% of the camels this placement can reach `
    + `(${capped.camels.toFixed(2)} of ${uncapped.camels.toFixed(2)} a journey). The five gates above score the `
    + 'declaration and cannot see this at all: they read 109 camels in a world that can hold twelve');

  /* The ablation has to be an ablation. If the cap never binds on this sample
   * the ratio is 1.0 for the wrong reason. */
  assert.ok(capped.refused > 0,
    'the animal budget was never refused on this sample, so the capped and ablated columns are the same '
    + 'measurement twice and the ratio above proves nothing');
  assert.ok(uncapped.camels > capped.camels,
    'ablating the budget met no more camels than keeping it, so the ceiling is not a ceiling');
});

/* ------------------------------------------------------------------ */
/* And the guard on the gates themselves                               */
/* ------------------------------------------------------------------ */

test('THE GATES ARE ABOUT ENCOUNTER, not about placement', async () => {
  const { rows, C } = await gates();

  /* Every floor has to be strictly below its own ablation ceiling, or it is
   * unpassable and the next author will delete it rather than meet it. This is
   * the medieval "ceiling of 10% on a number the rule capped at 3.4%" defect
   * caught from the other side, and it is asserted here so it fails on the day
   * somebody raises a floor rather than on the day somebody tries to meet one.
   */
  console.log('');
  for (const r of rows) {
    /* Against the PLACEMENT-INDEPENDENT ceiling, not the one printed beside the
     * achieved value. Four of the five ablate the content budget over the whole
     * map and so mean something on an empty world; `camelsMet` cannot, and gets
     * the reference placement's luckiest phase instead - see the kit. Using the
     * per-placement ceiling here would have this test report "the gate is a
     * wall" on precisely the world the gate was written for. */
    const ceiling = r.key === 'camelsMet' ? C.ceilings.camelsMet : r.ceiling;
    console.log(`    ${r.label.padEnd(52)} floor ${String(r.floor).padStart(6)} < ceiling ${String(Math.round(ceiling * 10) / 10).padStart(6)}`);
    assert.ok(r.floor < ceiling,
      `"${r.label}" has a floor of ${r.floor} against an ablation ceiling of ${ceiling}: no `
      + 'placement of any size could satisfy it, so it is not a gate, it is a wall');
  }

  /* And none of them may be satisfiable by content that is merely DRAWN. If a
   * gate would pass at the render radius but fails at the recognition radius,
   * it is measuring pixels and not encounters. Nothing here is allowed to use
   * `RENDER_IN`; this asserts the constant is only ever quoted. */
  assert.ok(RENDER_IN / RECOGNITION > 8,
    'the render gate and the recognition distance have converged - re-read the reasoning in the '
    + 'kit header, because the argument for measuring at 15 m assumed they had not');
  assert.equal(FLOORS.caravanShare > 0 && FLOORS.oasisShare > 0, true, 'a floor was zeroed out');
});
