import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as THREE from 'three';

import {
  measure, floorCheck, CLIMB_SUSTAIN_M,
} from './citadel-reach-kit.mjs';

/**
 * THE OBJECTIVE LAYER, MEASURED AGAINST THE WORLD IT IS SUPPOSED TO COVER.
 *
 * ── The defect class ──────────────────────────────────────────────────────
 *
 * `citadel-reach.test.mjs` answers R1 and R6 for relics and caches: is every
 * site a node in the component the player is standing in. That is the medieval
 * defect - content built where nobody goes - and it is caught.
 *
 * It is not the only way an objective layer can be wrong on a map that grew
 * five times. The three this file exists for were all live before it, all
 * green under every other test in the repo, and none of them is visible from
 * inside the system that has it:
 *
 *  1. **Everything reachable, all of it in one place.** `Relics` walked a
 *     shuffled list of authored anchors straight through, which spends the
 *     budget in proportion to how many DECKS a district happens to have: 64 of
 *     109 relics inside the old mesa, 12% of the map, and THREE in the Eyrie.
 *     Every one of the 109 passed R6.
 *  2. **A uniform dart over a box that is mostly scenery.** `Caches._findHigh`
 *     darts at `contentBounds`; nine darts put SEVEN caches on the old mesa,
 *     two on the aqueduct and none at all in the other five regions. The log
 *     read "0 sunken, 9 high" and every one of the nine was a real high place.
 *  3. **A menu with fewer rows than the world has content.** `main.js` splices
 *     `Viewpoints.hubItems()` in at boot with no argument, so `MAX_TRAVEL_ROWS`
 *     is the hard ceiling on fast-travel anchors. It was 8. The world publishes
 *     TEN viewpoints, so the last two - Ashfall and the Eyrie, the two longest
 *     climbs out there - synchronised, paid their prize, revealed their
 *     district and then had nowhere in the menu to be travelled to.
 *
 * All three are the same shape: a NUMBER that was right for a 264 m circle and
 * is silently wrong for an 806 m one, with nothing anywhere comparing the
 * objective layer to the geography. Every floor below is that comparison, and
 * every one is quoted floor / achieved / ceiling with the ceiling measured.
 *
 * ── Cost ──────────────────────────────────────────────────────────────────
 *
 * One headless citadel build and one `ReachGraph`, shared with
 * `citadel-reach.test.mjs` through the kit's memoised `measure()`.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const { Relics } = await import('../../src/systems/Relics.js');
const { Caches } = await import('../../src/systems/Caches.js');
const { Viewpoints, MAX_TRAVEL_ROWS } = await import('../../src/systems/Viewpoints.js');
const { CITADEL_QUESTS } = await import('../../admin/lib/quests/citadel.mjs');
const vocab = await import('../quest-vocab.mjs');
/**
 * The TERRAIN datum, and it has to be this function rather than a physics cast.
 *
 * R7 asks whether an objective is genuinely elevated, which means elevated
 * above the GROUND - and `physics.groundHeight` at an objective's own column
 * answers with the deck the objective is standing on, so every reading comes
 * back 0.0 and the invariant passes or fails on nothing. `CitadelWorld
 * ._groundAt` is no good either: it is still `terrainH(hypot(x, z))`, purely
 * radial, and it returns 0 for everything past r = 178 - which is all six
 * outer regions. `citadelHeight` is the function the regions were BUILT
 * against (`RegionSite.ground`), so it is the only datum that can disagree
 * with them.
 */
const { citadelHeight } = await import('../../src/worlds/terrain/CitadelHeight.js');

/** The six outer regions, by id, in build order. */
const RING = ['caravanserai', 'undercliff', 'deepworks', 'aqueduct', 'ashfall', 'eyrie'];

/**
 * Which district a world point stands in.
 *
 * The region AABBs come off the build report, so this is the world's own
 * account of where it put things rather than a table of boxes kept in a test.
 * The 6 m slack is the reach lattice's own pitch: an objective on the lip of a
 * region's outermost deck can sit a metre outside the box the deck centres
 * make, and calling that "sand" would understate every region by a deck or two.
 */
function districtOf(world, x, z) {
  for (const r of world.regions ?? []) {
    if (x >= r.aabb.min.x - 6 && x <= r.aabb.max.x + 6
      && z >= r.aabb.min.z - 6 && z <= r.aabb.max.z + 6) return r.id;
  }
  return Math.hypot(x, z) <= 200 ? 'mesa' : 'sand';
}

/** Count by key, as a plain object. */
function tally(list, key) {
  const out = {};
  for (const item of list) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/**
 * Every point at which a body can WALK INTO an enterable.
 *
 * The reach graph is a graph of decks, and a deck is the top of a column. It
 * therefore cannot see the inside of anything: ask it for the node under a
 * collectible standing on a souk house's floor and it answers the ROOF, or
 * nothing at all. That is not a defect in the graph, it is what "the outdoor
 * network" means - and it is exactly why R6 for an interior collectible has to
 * be asked in two halves.
 *
 * Half one is here: the entrances. A door's own position, plus any cave mouth
 * on a VERTICAL face. A `+y` mouth is deliberately excluded and it is not an
 * oversight - the Sunken Hall's `sinkhole` is a hole in the roof of a chimney,
 * a shaft you drop through and climb back out of, and there is no deck at its
 * coordinates by construction. Counting it as an entrance that failed would
 * have reported a working cave as broken; counting it as one that passed would
 * have needed the graph to invent a pad in mid-air.
 *
 * Half two - that every collectible inside connects to an entrance - belongs
 * to whoever owns the inside. `citadel-caves.test.mjs` proves it for the two
 * caves over their real walk graph; `InteriorKit` builds the four souk houses
 * with a single room and its own stair.
 */
function entrances(e) {
  const out = [];
  for (const d of e.doors ?? []) {
    if (d.position) out.push({ id: d.id ?? 'door', kind: 'door', position: d.position });
  }
  for (const m of e.cave?.mouths ?? []) {
    if (m.face === '+y' || m.face === '-y') continue;
    out.push({ id: m.id, kind: 'mouth', position: m.position });
  }
  return out;
}

/** The real placers, run against the real world, with their reports. */
let _placed = null;
async function placed() {
  if (_placed) return _placed;
  const { world, physics } = await measure();
  const relics = new Relics({
    scene: new THREE.Scene(), physics, player: null, bus: null,
    economy: null, worldManager: null,
  });
  relics._onWorld('citadel', world);
  const caches = new Caches({
    bus: null, physics, player: null,
    loot: { spawn: () => ({ active: true }) },
    worldManager: { active: world }, waterVolumes: null,
  });
  caches._onWorld('citadel', world);
  _placed = { relics, caches };
  return _placed;
}

/* ====================================================================== */
/* 1. Relics                                                              */
/* ====================================================================== */

/**
 * FLOOR. Every relic comes from an authored anchor, and no district is starved.
 *
 * Two halves, and the first is the one the design brief names: `Relics`'
 * fallback is a random dart filtered by `MIN_PROMINENCE` 2.5 measured at r = 4,
 * which is an ARCHITECTURAL test that flat ground cannot pass by construction.
 * Three quarters of this world is flat sand. So a world that publishes too few
 * authored anchors does not fail loudly - it places what it can, logs
 * "n/n hidden", and the HUD counter becomes the count it managed. The split is
 * therefore recorded by the placer (`Relics.placement`) and floored here,
 * rather than being inferred from the fact that the sites all look fine.
 *
 * The second half is the one no reachability test can see. 109 relics all
 * inside the reachable component, 64 of them in 12% of the map, is a world
 * where the collection is an argument for never leaving the mesa.
 */
test('FLOOR: every relic is authored, and every district of the map holds some', async () => {
  const { world } = await measure();
  const { relics } = await placed();
  const p = relics.placement;

  console.log(`    want ${p.want}  placed ${p.placed}  authored ${p.authored}  darted ${p.darted}`
    + `  candidates ${p.candidates}  districts ${Object.keys(p.districts).length}`);
  const byRegion = tally(relics.sites, (s) => districtOf(world, s.pos.x, s.pos.z));
  for (const k of Object.keys(byRegion).sort()) console.log(`      ${k.padEnd(14)} ${byRegion[k]}`);

  /* The dart loop is not the source. The ceiling is the ablation: with the
   * authored channel removed entirely, `MIN_PROMINENCE` over this world's
   * contentBounds places a handful and gives up - which is the failure mode
   * this floor exists to make impossible. */
  floorCheck('relic sites placed', 109, p.placed, p.want);
  floorCheck('relic sites from an authored anchor', 109, p.authored, p.placed);
  assert.equal(p.darted, 0,
    `${p.darted} relics came from the dart loop - the world is not publishing enough places`);
  assert.ok(p.candidates >= p.want * 3,
    `only ${p.candidates} authored anchors for ${p.want} relics - no slack for MIN_APART`);

  /* Seven souk rings, the mesa core and six regions: fourteen districts, and
   * the round-robin deal is what stops any of them being starved.
   *
   * BOTH SIDES, and the ceiling is the half that was missing. Re-measured
   * against the straight-walk loop this deal replaced - same seed, same anchor
   * list, same MIN_APART - the fourteen buckets ran 3 to 15:
   *
   *   ring:6 15 / undercliff 13 / core 10 / ring:4 10 / deepworks 10 /
   *   ring:5 9 / ring:3 8 / ashfall 7 / caravanserai 6 / aqueduct 6 /
   *   ring:2 5 / ring:0 4 / ring:1 3 / EYRIE 3
   *
   * A floor alone passes on that distribution for eleven of the fourteen; it
   * is the 15 that says the deal is not happening. Flooring the thinnest and
   * ceilinging the fattest is what makes "an even deal" an assertion rather
   * than a description. */
  assert.equal(Object.keys(p.districts).length, 14,
    'the world stopped tagging its decks by ring and region');
  const perDistrict = Object.values(p.districts);
  floorCheck('relics in the thinnest district', 6, Math.min(...perDistrict), 8,
    '(ceiling = an even 109/14 deal)');
  const fattest = Math.max(...perDistrict);
  console.log(`      fattest district ${fattest}  (straight walk: 15)`);
  assert.ok(fattest <= 8,
    `one district holds ${fattest} of the ${p.placed} relics against an even deal of 8 - the `
    + 'round-robin is not dealing, it is walking the shuffled list');

  for (const id of RING) {
    floorCheck(`relics in the ${id}`, 6, byRegion[id] ?? 0, 8);
  }
  /* THE MESA'S AGGREGATE SHARE IS NOT WHAT THE DEAL MOVED, and this floor
   * should not be read as if it were. The mesa is eight of the fourteen
   * buckets, so it is dealt 8/14 of the budget by construction: measured, the
   * straight walk put 64 relics here and the round-robin puts 63. One. What
   * moved is the spread inside the totals (see the ceiling above). Cycling
   * over seven buckets instead - six regions plus one composite mesa - would
   * take this to about 16, which is below the 30 the mesa held before the map
   * was ever expanded; `Relics.js` records why that trade was refused. */
  floorCheck('relics still on the mesa', 40, byRegion.mesa ?? 0, 109);
  assert.equal(byRegion.sand ?? 0, 0, 'a relic was hidden in open desert');
});

/* ====================================================================== */
/* 2. Caches                                                              */
/* ====================================================================== */

/**
 * FLOOR. Every region of the ring holds a high cache, and every nomination
 * passed the same predicate a dart has to pass.
 *
 * `CitadelWorld.cacheSites` nominates six places; `Caches._onWorld` re-runs
 * `_highAt` on each one against the real colliders and REFUSES anything that
 * no longer stands proud of what is round it. That refusal path is the whole
 * value of the authored channel - a hint about where to look is safe, a list
 * that is trusted is how a cache ends up inside a terrace somebody built later.
 * So this floors the accepted count, not the nominated one.
 */
test('FLOOR: every region of the outer ring holds a high cache', async () => {
  const { world, graph, uf, main, reach } = await measure();
  const { caches } = await placed();
  const p = caches.placement;

  const rows = caches.sites.map((s) => {
    const id = graph.nodeFor(s.pos.x, s.pos.z, s.pos.y + 0.5);
    return {
      kind: s.kind,
      region: districtOf(world, s.pos.x, s.pos.z),
      authored: !!s.authored,
      y: s.pos.y,
      main: id !== undefined && uf.find(id) === main,
      reach: id !== undefined && !!reach.seen[id],
    };
  });
  console.log(`    nominated ${p.nominated}  accepted ${p.authored}  darted ${p.darted}  want ${p.want}`);
  for (const r of rows) {
    console.log(`      ${r.region.padEnd(14)} y ${r.y.toFixed(1).padStart(5)}  ${r.authored ? 'authored' : 'darted  '}  R1 ${r.main}  forward ${r.reach}`);
  }

  assert.equal(p.nominated, 6, 'the world nominates one high place per outer region');
  floorCheck('nominated sites the predicate accepted', 6, p.authored, 6,
    '(a refusal means a nominated place stopped being a high place)');
  floorCheck('high caches placed', 9, p.placed, p.want);

  const byRegion = tally(rows, (r) => r.region);
  for (const id of RING) {
    assert.ok((byRegion[id] ?? 0) >= 1,
      `the ${id} holds no cache - nine uniform darts put seven of nine on the mesa`);
  }
  floorCheck('regions of the ring holding a cache', 6,
    RING.filter((id) => (byRegion[id] ?? 0) >= 1).length, 6);
  /* R6, for this class: a cache nobody can stand on is not a destination. */
  floorCheck('R6  cache sites forward-reachable from spawn', rows.length,
    rows.filter((r) => r.reach).length, rows.length);
  assert.equal(rows.filter((r) => r.main).length, rows.length);

  /* ── THE AUTHORED CHANNEL CANNOT OUTSPEND THE AREA LAW ─────────────────
   *
   * `placed <= want` is trivially true today (6 nominations, 9 wanted) and so
   * it proves nothing on its own. The guard it is standing in for was
   * `this.sites.length >= PER_WORLD.sunken + highWanted`, which reserves three
   * slots for sunken caches whether any were placed or not - and Citadel has no
   * water, so it places zero and the authored loop had `sunken + highWanted`
   * slots to spend instead of `highWanted`.
   *
   * POSITIVE CONTROL, because the live world cannot reach the overrun: run the
   * real placer against the real colliders with a `contentBounds` shrunk to the
   * 400 m base extent, which is what `highWanted` is calibrated on. That asks
   * for 3 high caches; the world still nominates 6, every one of which passes
   * `_highAt` against real geometry. With the sunken slots wrongly in the sum
   * the loop accepts all six; counting high sites it accepts three. */
  const { Caches: C } = await import('../../src/systems/Caches.js');
  const squeezed = new C({
    bus: null, physics: (await measure()).physics, player: null,
    loot: { spawn: () => ({ active: true }) },
    worldManager: { active: world }, waterVolumes: null,
  });
  const base = new THREE.Box3(
    new THREE.Vector3(-200, world.contentBounds.min.y, -200),
    new THREE.Vector3(200, world.contentBounds.max.y, 200)
  );
  squeezed._onWorld('citadel', new Proxy(world, {
    get: (o, k) => (k === 'contentBounds' ? base : o[k]),
  }));
  const q = squeezed.placement;
  console.log(`    squeezed to the 400 m base box: want ${q.want}, nominated ${q.nominated}, `
    + `authored ${q.authored}, placed ${q.placed}`);
  assert.ok(q.want < p.want, 'the squeezed box did not shrink the budget - the control is inert');
  assert.ok(q.placed <= q.want,
    `the authored channel placed ${q.placed} high caches against a budget of ${q.want} - the `
    + 'sunken slots are being counted into the high budget again');
});

/* ====================================================================== */
/* 3. The caves                                                           */
/* ====================================================================== */

/**
 * FLOOR. R6 for the caves: their contents are reachable AND exitable.
 *
 * `citadel-caves.test.mjs` proves the inside of each cave - every mouth and
 * every collectible in one connected walk component, no riser between a step
 * and a mantle, sealed against the collider set. What it cannot ask is whether
 * a player standing at the gate can ever GET to a mouth, because that question
 * is about the other 800 m of the world.
 *
 * So this is the join: every declared mouth resolves to a node in the
 * component that contains the spawn AND is forward-reachable from it, and the
 * collectible spots `Interiors` will stream in stand inside the cave that
 * publishes them. Exitability rides on the two together - the spots connect to
 * a mouth (proved next door) and the mouth connects to the world (proved here),
 * so the route in is the route out.
 */
test('FLOOR: both caves are reachable from spawn, and their collectibles are content', async () => {
  const { world, graph, uf, main, reach } = await measure();
  const caves = (world.enterables ?? []).filter((e) => e.cave);
  assert.equal(caves.length, 2, 'the Quarry Adit and the Sunken Hall are the two built caves');

  let doors = 0;
  let doorsOnNet = 0;
  let shafts = 0;
  let spots = 0;
  for (const e of caves) {
    let onNetHere = 0;
    for (const m of e.cave.mouths) {
      const walkIn = m.face !== '+y' && m.face !== '-y';
      if (!walkIn) { shafts++; }
      const id = graph.nodeFor(m.position.x, m.position.z, m.position.y + 0.5);
      const ok = id !== undefined && uf.find(id) === main && !!reach.seen[id];
      if (walkIn) { doors++; if (ok) { doorsOnNet++; onNetHere++; } }
      console.log(`    ${String(e.label).padEnd(16)} ${walkIn ? 'mouth ' : 'shaft '}${String(m.id).padEnd(10)} (${m.position.x.toFixed(1)}, ${m.position.y.toFixed(1)}, ${m.position.z.toFixed(1)})  face ${String(m.face).padEnd(2)}  R1 ${ok}`);
    }
    assert.ok(onNetHere >= 1,
      `${e.label} has no walk-in mouth on the network - the only way in is a drop`);
    for (const s of e.collectibleSpots) {
      spots++;
      assert.ok(Number.isFinite(s.position.x) && Number.isFinite(s.position.y),
        `${e.label}: a collectible spot with no position`);
      assert.ok(['common', 'rare', 'prize'].includes(s.tier),
        `${e.label}: tier "${s.tier}" is not one Interiors can stock`);
    }
    console.log(`    ${String(e.label).padEnd(16)} ${e.collectibleSpots.length} collectible spots, ${e.cave.mouths.length} mouths, region ${districtOf(world, e.origin.x, e.origin.z)}`);
  }

  floorCheck('walk-in cave mouths on the network the player is on', doors, doorsOnNet, doors);
  floorCheck('authored cave collectibles', 6, spots, 6);
  /* Reported, not floored: a roof shaft is a way in that the deck graph cannot
   * represent, and pinning a number to it would pin the graph's blind spot. */
  console.log(`    ${doorsOnNet}/${doors} walk-in mouths on the network, plus ${shafts} roof shafts`);
  /* Two mouths apiece is not decoration: a single-mouth cave is a cul-de-sac,
   * and the one thing this world's caves cannot do is be dug out of. */
  for (const e of caves) {
    assert.ok(e.cave.mouths.length >= 2, `${e.label} has one way in and out`);
  }
});

/**
 * FLOOR. Every authored collectible spot stands in open air.
 *
 * ── The defect this was written for ───────────────────────────────────────
 * `Interiors._streamSpots` spawns a pickup at the published position with
 * `snap: false` - it does not look for the floor and it does not look for a
 * wall. So a spot inside a solid is a collectible that is simply not there,
 * and every reachability assertion in this file passes: the ROOM is reachable,
 * and the graph resolves the spot's column, not its point.
 *
 * `_buildDressing` scattered 34 crates on a bare polar dart with no clearance
 * test - the only prop loop in the world that skipped `_openSpot`. One landed
 * at (23.60, 42.19) inside the Spice Merchants House, its collider spanning
 * y 14.00 to 15.00, over that house's spot at y 14.72. 1 of the world's 10
 * authored spots, invisible from the room it was advertised in.
 *
 * floor    0 of 10 spots inside a solid
 * achieved  0
 * ceiling   1 - what the unchecked crate dart shipped
 */
test('FLOOR: no authored collectible spot is buried inside a collider', async () => {
  const { world, idx } = await measure();
  const buried = [];
  let total = 0;
  for (const e of world.enterables ?? []) {
    for (const s of e.collectibleSpots ?? []) {
      total++;
      /* The column, not a ray: a ray from above stops at the first surface and
       * says nothing about whether the point below it is inside anything. */
      const col = idx.column(s.position.x, s.position.z);
      const inside = col.filter((iv) => s.position.y > iv.bot + 1e-6 && s.position.y < iv.top - 1e-6);
      if (inside.length) {
        buried.push(`${e.label} (${s.position.x.toFixed(2)}, ${s.position.y.toFixed(2)}, `
          + `${s.position.z.toFixed(2)}) inside ${inside.map((iv) => `[${iv.bot.toFixed(2)}, ${iv.top.toFixed(2)}]`).join(' ')}`);
      }
    }
  }
  console.log(`    authored collectible spots ${total}, buried ${buried.length}`);
  assert.ok(total >= 10, `only ${total} authored collectible spots - the enterables stopped publishing`);
  assert.deepEqual(buried, [],
    `a pickup spawns inside a solid and cannot be seen or reached:\n      ${buried.join('\n      ')}`);
});

/* ====================================================================== */
/* 4. The trial catalogue                                                 */
/* ====================================================================== */

/**
 * FLOOR. The venue ids in SOURCE are exactly the venues the world publishes.
 *
 * This is not tidiness, it is the only thing holding the quest content up.
 * `scripts/quest-vocab.mjs` decides whether a quest step's target exists by
 * scraping venue ids out of source with `/\.minigameVenues\s*=\s*\[/` and
 * walking the object literals inside the brackets. `CitadelWorld` used to
 * publish every trial with `.push({...})` from inside two methods, so the
 * vocabulary listed four venues for `sports` and NONE for `citadel`, and any
 * quest step naming a citadel trial was rejected as an invented target - which
 * is why the outer ring had no quests at all.
 *
 * The catalogue is a literal now and the build FILLS it. That makes a new way
 * to be wrong: a source literal the runtime never resolves, which the
 * vocabulary would go on offering to quest authors for ever. `_pruneVenues`
 * deletes those, and this asserts the two lists are identical - so a route
 * that stops resolving fails here rather than becoming a lie in a scraper.
 */
test('FLOOR: the trial catalogue in source is exactly the list the world publishes', async () => {
  const { world } = await measure();
  const src = read('src/worlds/CitadelWorld.js');

  /* The scraper's own regex and bracket walk, deliberately duplicated rather
   * than imported: what is being pinned is that CitadelWorld stays readable BY
   * THAT REGEX, so a test that called the scraper's helper would still pass if
   * the helper were rewritten to be cleverer than the shipped one. */
  const inSource = [];
  let found = 0;
  for (const m of src.matchAll(/\.minigameVenues\s*=\s*\[/g)) {
    found++;
    const from = src.indexOf('[', m.index);
    let depth = 0;
    let close = -1;
    for (let i = from; i < src.length; i++) {
      if (src[i] === '[') depth++;
      else if (src[i] === ']') { depth--; if (depth === 0) { close = i; break; } }
    }
    if (close < 0) continue;
    /* EVERY occurrence, unioned - not the first. `quest-vocab` uses
     * `matchAll` here and this test used `search`, so it read the
     * constructor's `this.minigameVenues = []` and reported that the world
     * publishes nothing. A ruler that disagrees with the tool it is checking
     * is worse than no ruler. */
    for (const q of src.slice(from + 1, close).matchAll(/\bid:\s*'([a-z0-9_]+)'/g)) inSource.push(q[1]);
  }
  assert.ok(found >= 1, 'CitadelWorld no longer assigns minigameVenues as an array literal');
  const published = world.minigameVenues.map((v) => v.id);
  console.log(`    source ${inSource.length}: ${inSource.join(', ')}`);
  console.log(`    published ${published.length}: ${published.join(', ')}`);

  assert.deepEqual([...published].sort(), [...inSource].sort(),
    'a catalogued trial never resolved a route, or a route published an uncatalogued trial');
  floorCheck('trials the quest vocabulary can see', 7, inSource.length, 7);

  // And the vocabulary really does see them, through its own code path.
  const seen = vocab.VOCAB.minigames.venuesByWorld.citadel.map((v) => v.id).sort();
  assert.deepEqual(seen, [...inSource].sort(),
    'quest-vocab cannot read the catalogue - every citadel trial step would be rejected');

  for (const v of world.minigameVenues) {
    assert.ok(v.config && v.centre, `${v.id} was published without a route`);
    assert.equal(v.requires, 'parkour', `${v.id}: a parkour contest needs the parkour rule`);
  }
});

/* ====================================================================== */
/* 5. Quests                                                              */
/* ====================================================================== */

/**
 * FLOOR. The outer ring's quests name the outer ring.
 *
 * `quest-content.test.mjs` already asks whether every target resolves. It
 * cannot ask the question this drop is about: whether the new geography has
 * any objective a quest can witness at all. The ring holds no NPC, no vendor,
 * no portal and no hostile, so `talk`, `interact`, `purchase` and `kill` have
 * nothing to name out there and `survive` and `collect` are world-scoped. A
 * `minigame` step naming a venue id is the ONLY step in the vocabulary that
 * can tell the Undercliff from the inner ward, and this floors the fact that
 * the ring quests are built out of them and that every id they name is a venue
 * standing in a region rather than on the mesa.
 */
test('FLOOR: the ring quests name trials that stand in the ring', async () => {
  const { world } = await measure();
  const ring = CITADEL_QUESTS.filter((q) => q.n >= 131);
  const byId = new Map(world.minigameVenues.map((v) => [v.id, v]));

  floorCheck('quests authored for the outer ring', 5, ring.length, 5);

  const named = new Set();
  for (const q of ring) {
    const steps = q.steps.filter((s) => s.type === 'minigame');
    assert.ok(steps.length >= 1,
      `quest ${q.n} "${q.line}" has no minigame step - nothing in it can witness the ring`);
    for (const s of steps) {
      const r = vocab.resolveTarget('minigame', s.target, { world: 'citadel' });
      assert.equal(r.ok, true, `quest ${q.n} step ${s.order}: "${s.target}" - ${r.detail}`);
      if (byId.has(s.target)) named.add(s.target);
    }
    /* No two steps in one quest may share a type AND a target AND a world:
     * `_advanceSteps` walks every step on each event and both would advance. */
    const keys = q.steps.map((s) => `${s.type}|${s.target}|${s.world}`);
    assert.equal(new Set(keys).size, keys.length,
      `quest ${q.n} has two steps that one action would advance together`);
  }

  const regions = [...named].map((id) => {
    const v = byId.get(id);
    return { id, region: districtOf(world, v.centre.x, v.centre.z) };
  });
  for (const r of regions) console.log(`    ${r.id.padEnd(26)} ${r.region}`);
  const inRing = regions.filter((r) => RING.includes(r.region)).length;
  floorCheck('named trials that stand in the ring', 4, inRing, 4,
    '(ceiling = the four region trials; the mesa three are named only by the capstone)');

  /* The capstone is the one quest that asks for a WIN, and `rooftop_trial_won`
   * is the only outcome-gated spelling there is - a venue id is a whole-token
   * subrun of its own `_won` composite and would complete on a loss. If that
   * ever stops resolving, the capstone silently becomes "play three trials". */
  const cap = CITADEL_QUESTS.find((q) => q.n === 135);
  const win = cap.steps.find((s) => s.type === 'minigame');
  assert.equal(win.target, 'rooftop_trial_won');
  assert.equal(vocab.resolveTarget('minigame', win.target, { world: 'citadel' }).matched.kind,
    'minigame-outcome', 'the capstone stopped being outcome-gated');
});

/* ====================================================================== */
/* 6. Viewpoints                                                          */
/* ====================================================================== */

/**
 * FLOOR. The pause hub has a row for every anchor the world can produce.
 *
 * `main.js:509` splices `viewpoints.hubItems()` into the hub at boot with no
 * argument, and the hub is built ONCE, so `MAX_TRAVEL_ROWS` is a hard ceiling
 * on how many synchronised viewpoints a player can ever travel to. At 8 with
 * ten published, the two that fell off the bottom were Ashfall and the Eyrie:
 * the longest climbs in the world, paying a prize and a map reveal and then
 * offering no way back.
 *
 * The floor is against the REAL published count and not against the constant,
 * because a floor pinned to the constant is satisfied by the constant.
 */
test('FLOOR: every viewpoint the world publishes can be travelled to', async () => {
  const { world } = await measure();
  const bus = {
    handlers: new Map(),
    on(t, fn) { (this.handlers.get(t) ?? this.handlers.set(t, new Set()).get(t)).add(fn); return () => {}; },
    emit(t, p) { for (const fn of this.handlers.get(t) ?? []) fn(p); },
  };
  const player = { position: { x: 0, y: 0, z: 0 }, teleport(v) { Object.assign(this.position, v); } };
  const vps = new Viewpoints({ bus, player });
  bus.emit('world:changed', { id: 'citadel', world });

  for (const v of vps.list) {
    player.position.x = v.x; player.position.y = v.y; player.position.z = v.z;
    vps.update(1 / 60);
  }
  const rows = vps.hubItems();
  const visible = rows.filter((r) => r.visible()).length;
  console.log(`    ${world.viewpoints.length} published, ${vps.anchors.length} anchors, `
    + `${MAX_TRAVEL_ROWS} hub rows, ${visible} of them visible`);

  floorCheck('hub travel rows against published viewpoints',
    world.viewpoints.length, MAX_TRAVEL_ROWS, world.viewpoints.length + 4,
    '(ceiling = headroom for one more region; the floor is the world, not the constant)');
  assert.equal(visible, vps.anchors.length,
    `${vps.anchors.length - visible} synchronised viewpoints have no row in the pause hub`);
  // Every row must actually travel, not merely be visible.
  for (let i = 0; i < visible; i++) {
    player.position.x = 0; player.position.y = 0; player.position.z = 0;
    assert.equal(rows[i].run(), true, `travel row ${i + 1} did nothing`);
    const a = vps.anchors[i];
    assert.ok(Math.hypot(player.position.x - a.x, player.position.z - a.z) < 0.01,
      `travel row ${i + 1} put the player somewhere other than "${a.name}"`);
  }
});

/**
 * FLOOR. Every viewpoint is climbable on one stamina bar.
 *
 * R5. One bar sustains 29.3 m of continuous ascent (`CLIMB_SUSTAIN_M`, driven
 * off the real `Stamina` drain rather than computed), and the ring's five
 * viewpoints stand 31.8 to 63.7 m up. None of them is one face: the towers
 * taper a storey at a time, the Eyrie has a 26-tread pilgrim helix cut round
 * the peak, and every one has a stair off its own region's ground. What is
 * floored here is that the world PUBLISHES the intermediate surfaces - the
 * deck below each viewpoint is never more than one bar down - because a
 * viewpoint whose last unbroken face is 30 m is a viewpoint nobody arrives at
 * with any stamina left, which is the state the Eyrie's first cut shipped in.
 */
test('FLOOR: no viewpoint needs more than one stamina bar of unbroken ascent', async () => {
  const { world, idx } = await measure();
  const worst = [];
  for (const v of world.viewpoints) {
    /* The highest published deck strictly below this one within 24 m - a
     * balcony ring, a lower storey, a ledge or a terrace. `_roofs` and
     * `_towers` are the world's own account of where a body can stand. */
    let below = -Infinity;
    for (const r of [...world._roofs, ...world._towers]) {
      const a = r.anchor ?? r;
      if (a.y >= v.y - 0.2) continue;
      if (Math.hypot(a.x - v.x, a.z - v.z) > 24) continue;
      if (a.y > below) below = a.y;
    }
    const ground = idx.deckAt(v.x, v.z, { below: v.y - 0.5 });
    const floorY = Math.max(below, ground ? ground.y : -Infinity);
    const climb = v.y - floorY;
    worst.push({ id: v.id, y: v.y, from: floorY, climb });
  }
  worst.sort((a, b) => b.climb - a.climb);
  for (const w of worst) {
    console.log(`    ${w.id.padEnd(20)} deck ${w.y.toFixed(1).padStart(5)}  last surface below ${w.from.toFixed(1).padStart(5)}  unbroken ${w.climb.toFixed(2)} m`);
  }
  floorCheck('R5  slack under one stamina bar, m', 0,
    CLIMB_SUSTAIN_M - worst[0].climb, CLIMB_SUSTAIN_M,
    `(worst is "${worst[0].id}" at ${worst[0].climb.toFixed(2)} m of ${CLIMB_SUSTAIN_M})`);
  for (const w of worst) {
    assert.ok(w.climb <= CLIMB_SUSTAIN_M,
      `"${w.id}" needs ${w.climb.toFixed(1)} m of unbroken ascent against a ${CLIMB_SUSTAIN_M} m bar`);
  }
});

/* ====================================================================== */
/* 7. R6 and R7 over every class at once                                  */
/* ====================================================================== */

/**
 * FLOOR. R6, asked of the WHOLE objective layer and reported per region.
 *
 * The design's R6 names five classes - relic site, cache, collectible spot,
 * quest target and trial venue - and until this test three of the five had
 * nobody asking. The table it prints is the answer to "what is out there and
 * can it be got to", district by district, which is the thing a 900 m map
 * makes impossible to hold in your head.
 *
 * R7 rides along: a floor on the share of ring objectives that are genuinely
 * ELEVATED, measured against the terrain under each one rather than against a
 * single world datum - the ring spans 7.8 m of quarry floor to 63.7 m of karst
 * summit and a fixed height would call the whole Deepworks a basement.
 */
test('FLOOR: R6 - every objective of every class is a node in the reachable component', async () => {
  const { world, graph, uf, main, reach } = await measure();
  const { relics, caches } = await placed();

  const rows = [];
  const add = (cls, label, x, y, z) => {
    const id = graph.nodeFor(x, z, y + 0.5);
    rows.push({
      cls,
      label,
      region: districtOf(world, x, z),
      main: id !== undefined && uf.find(id) === main,
      reach: id !== undefined && !!reach.seen[id],
      above: y - citadelHeight(x, z),
      resolved: id !== undefined,
    });
  };

  for (const s of relics.sites) add('relic', 'relic', s.pos.x, s.pos.y, s.pos.z);
  for (const s of caches.sites) add('cache', s.kind, s.pos.x, s.pos.y, s.pos.z);
  /* An interior collectible is scored at its ENTRANCE, never at its own
   * coordinates. See `entrances` above: the reach graph is a graph of decks
   * and cannot see inside anything, so asking it for the node under a spot on
   * a souk house floor answers the roof, or nothing at all. Ten collectibles
   * scored where they stand reported three in R1 and seven unreachable, in a
   * world where every one of them is picked up by walking through a door. */
  for (const e of world.enterables ?? []) {
    const ways = entrances(e);
    assert.ok(ways.length >= 1, `"${e.label}" publishes collectibles and no way in`);
    const best = ways.map((w) => ({ w, id: graph.nodeFor(w.position.x, w.position.z, w.position.y + 0.5) }))
      .find(({ id }) => id !== undefined && uf.find(id) === main && !!reach.seen[id]) ?? { w: ways[0] };
    for (const s of e.collectibleSpots ?? []) {
      add('collectible', e.label, best.w.position.x, best.w.position.y, best.w.position.z);
      // ..but the spot's OWN region is what the table should report.
      rows[rows.length - 1].region = districtOf(world, s.position.x, s.position.z);
      rows[rows.length - 1].above = 0;
    }
  }
  for (const v of world.viewpoints) add('viewpoint', v.id, v.x, v.y, v.z);
  for (const v of world.minigameVenues) {
    for (const c of v.config.checkpoints) add('checkpoint', v.id, c.x, c.y, c.z);
  }
  /* Quest targets. Every citadel quest names one of these four authored
   * civilians, Aldric Storne (planted beside the gate by `_spawnQuestManagers`
   * rather than authored in `npcSpawns`, so his post is read off the world's
   * own player spawn) or the single portal. A quest step aimed at somebody
   * standing somewhere the player cannot walk is the medieval defect wearing a
   * name badge. */
  for (const n of world.npcSpawns ?? []) {
    if (n.type === 'hostile') continue;
    add('quest-npc', n.name ?? 'crowd', n.position.x, n.position.y, n.position.z);
  }
  for (const s of world.portalSpecs ?? []) {
    add('portal', s.target, s.position.x, s.position.y, s.position.z);
  }
  add('spawn', 'player spawn', world.playerSpawn.x, world.playerSpawn.y, world.playerSpawn.z);

  /* ---- the table ------------------------------------------------------ */
  const classes = [...new Set(rows.map((r) => r.cls))];
  const districts = ['mesa', ...RING, 'sand'];
  const head = `    ${'class'.padEnd(12)}${districts.map((d) => d.slice(0, 8).padStart(9)).join('')}${'total'.padStart(9)}${'in R1'.padStart(8)}`;
  console.log(head);
  for (const cls of classes) {
    const mine = rows.filter((r) => r.cls === cls);
    const cells = districts.map((d) => String(mine.filter((r) => r.region === d).length).padStart(9)).join('');
    console.log(`    ${cls.padEnd(12)}${cells}${String(mine.length).padStart(9)}${String(mine.filter((r) => r.main).length).padStart(8)}`);
  }

  const unreached = rows.filter((r) => !r.main);
  for (const u of unreached) {
    console.log(`    UNREACHED  ${u.cls} "${u.label}" in ${u.region}${u.resolved ? '' : ' (no node at all)'}`);
  }

  floorCheck('R6  objectives in the reachable component', rows.length,
    rows.filter((r) => r.main).length, rows.length);
  floorCheck('R6  objectives forward-reachable from spawn', rows.length,
    rows.filter((r) => r.reach).length, rows.length);
  assert.equal(unreached.length, 0,
    `${unreached.length} objectives are not on the network the player is on`);
  assert.equal(rows.filter((r) => r.region === 'sand' && r.cls !== 'collectible').length, 0,
    'an objective other than a cave collectible stands in open desert');

  /* ---- R7 ------------------------------------------------------------- */
  /* Measured against the terrain under each objective, not against a datum.
   * Cave collectibles are excluded and that is the honest read: a cave floor
   * is BELOW the rock around it by construction, and counting it as "not
   * elevated" would make the caves an argument against building any. */
  const ring = rows.filter((r) => RING.includes(r.region) && r.cls !== 'collectible');
  const elevated = ring.filter((r) => r.above > 3).length;
  console.log(`    R7: ${elevated}/${ring.length} ring objectives more than 3 m over their own ground`);
  floorCheck('R7  ring objectives genuinely elevated, %', 75,
    (elevated / ring.length) * 100, 100,
    '(ceiling = every one of them off the ground)');
});
