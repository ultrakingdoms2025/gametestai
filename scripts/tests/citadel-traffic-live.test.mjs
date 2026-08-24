import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/**
 * THE CARAVANS AS THEY ACTUALLY RUN, not as they are declared.
 *
 * ── What this file is for, and what it deliberately does not repeat ───────
 *
 * `citadel-caravans.test.mjs` holds five floors on ENCOUNTER and they are all
 * green: 60.7% of inter-region journeys meet a caravan, 6.83 camels are met on
 * an average crossing, 41.3% meet a static herd, 76.3% of spawn journeys meet
 * something, 81.5% of walks have no 150 m of nothing in them. Every one of
 * those numbers is computed from what `CitadelWorld` DECLARES on
 * `caravanRoutes` and `oases`.
 *
 * **A declaration is exactly the kind of thing this project has shipped before
 * and been wrong about.** The medieval expansion declared ten wildlife packs,
 * every spawn returned bodies, 29 of 29 assertions passed, and the player said
 * he could not see an animal. So the question this file asks is the other one:
 * is there anything behind the declaration, does it move, does it move where
 * the declaration says, and does it cost what it was budgeted to cost.
 *
 * Six properties, in the order they can fail:
 *
 *   1. EVERY DECLARED ANIMAL HAS A ROSTER ENTRY, AND NO HERD IS OVER packMax.
 *      109 are declared and 109 are rostered; a herd count in a contract that
 *      no spec answers to - or one the species cap will silently cut - is the
 *      medieval defect in miniature, and this drop shipped the second kind
 *      once (eight-animal trains against a camel packMax of 7).
 *   2. THE CARAVANS MOVE, at the declared speed, along the declared road, and
 *      over the whole of it. Ablated by running the same driver at dt = 0.
 *   3. THE HERD FOLLOWS ITS DROVER, because `BeastPack` steers nothing and the
 *      only lever this feature has is `home`. Measured on the real anchors.
 *   4. IT STREAMS, and the cap binds on the FURTHEST candidate. Ablated by
 *      parking a player in the corner of the map and finding nothing resident.
 *   5. NOTHING IN A CARAVAN CAN ATTACK. Ablated against the wolf row.
 *   6. IT HOLDS ITS BUDGET, quoted before and after off the build's own report.
 *
 * MUTATION REPORT: 43 of 43 assertion sites individually inverted and confirmed
 * red, one at a time, with the whole file re-run against each. The first sweep
 * read 41 of 42 and the survivor is documented at the case that produced it -
 * a well-herd ablation guarded by `if (camp)` on a camp that the animal cap
 * meant was never resident, so the assertion never executed. Nothing here is a
 * "not worse than before" check and nothing here is a clearance.
 */

/* ------------------------------------------------------------------ */
/* The world, built once                                               */
/* ------------------------------------------------------------------ */

const { buildCitadel, f, i5 } = await import('./citadel-reach-kit.mjs');
const Caravans = await import('../../src/worlds/citadel/Caravans.js');
const {
  CitadelTraffic, CARAVAN_SPEED, TRAIN_GAP, TRAIN_ROAM_SPEED, TRAIN_TERRITORY,
  DROVER_LEASH, DROVER_STALL, EVICT_MARGIN, CARAVAN_ROADS, WELL_SITES,
  roadArcs, roadLength, pointAtArc, cycleArc, projectOnRoad,
} = Caravans;
const { beastDef, isPredator } = await import('../../src/npc/BeastSpecies.js');
const { MAX_DISTRICT_RADIUS, districtStats } = await import('../../src/worlds/citadel/Districts.js');
const { resolveSurfaceY } = await import('../../src/npc/Grounding.js');

/** The threat colour `Minimap` paints a hostile contact in. @see Minimap:618 */
const HOSTILE_RED = '#ff3d55';
const { NPCManager } = await import('../../src/npc/NPCManager.js');
const { EventBus } = await import('../../src/core/EventBus.js');

let _built = null;
function built() {
  _built ??= buildCitadel();
  return _built;
}

/**
 * A rig on the REAL `NPCManager`, with real `BeastNPC` bodies that walk.
 *
 * Everything else in this file runs on {@link StubManager}, deliberately and
 * for the reason its own docstring gives. But a stub cannot answer the one
 * question the medieval expansion got wrong: its camels are plain objects with
 * a `home` vector and no locomotion, so a test written against it measures the
 * ANCHORS and reports success when no animal ever reached one. That is the
 * declaration/reality gap in its original form, and three of the defects this
 * file now covers - the anchors on souk roofs, the animals that could not keep
 * up with their own train, and the herd scattered onto the oasis masonry - were
 * all invisible to it.
 *
 * Cheap enough to be ordinary: the world is already built, and 180 s of real
 * simulation over a resident train costs about a second.
 */
function liveManager(world) {
  const mgr = new NPCManager({
    scene: world.group ?? { add() {}, remove() {} },
    engine: null,
    physics: world.physics,
    bus: new EventBus(),
    materials: null,
    player: { position: new THREE.Vector3() },
  });
  mgr.worldId = 'citadel';
  return mgr;
}

/** Drive one traffic instance and the manager behind it for `seconds`. */
function drive(pop, mgr, seconds, at) {
  const DT = 1 / 60;
  let elapsed = 0;
  for (let i = 0; i < seconds * 60; i++) {
    const p = at(i * DT);
    mgr.player.position.set(p.x, p.y ?? 0, p.z);
    pop.update(p.x, p.z, DT);
    elapsed += DT;
    /* BOTH loops. `fixedUpdate` alone never ticks the respawn queue or the
     * animators, and a probe that drives only it reports animals that never
     * move for reasons that have nothing to do with the code under test. */
    mgr.fixedUpdate(DT, elapsed);
    mgr.update(DT, elapsed);
  }
}

/** Metres from `(x, z)` to the nearest point of a road polyline. */
function distToRoad(points, x, z) {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    let u = len2 > 1e-9 ? ((x - a.x) * dx + (z - a.z) * dz) / len2 : 0;
    if (u < 0) u = 0; else if (u > 1) u = 1;
    const d = Math.hypot(x - (a.x + dx * u), z - (a.z + dz * u));
    if (d < best) best = d;
  }
  return best;
}

/**
 * An `NPCManager` stand-in with the same four methods `CitadelTraffic` uses.
 *
 * A stub and not the real manager, deliberately, and the line is the same one
 * `medieval/Residency.js` draws: what is measured here is the STREAMING
 * DECISION - which specs are asked for, in what order, and how many are
 * refused - and that decision is arithmetic over positions. It never touches a
 * mesh, a material or a scene. The real manager is exercised by
 * `npc-routes.test.mjs`, which builds all seven worlds and puts every spec this
 * file rosters through `NPCManager._snapToGround`'s own grounding function.
 *
 * `owns` returns false for anything this stub has released, which is what makes
 * the "manager destroyed the cast behind your back" path testable: that hazard
 * is why `CitadelTraffic` re-checks every held reference on every sync instead
 * of trusting it, and it is what once left a maze with no wanderers in it.
 */
class StubManager {
  constructor(opts = {}) {
    this.live = new Set();
    this.spawnedPeople = 0;
    this.spawnedBeasts = 0;
    this.despawned = 0;
    /** Refuse everything, to test the "spawn returned null" path. */
    this.refuse = opts.refuse ?? false;
    /** Peak live counts, which is what a budget is actually about. */
    this.peakPeople = 0;
    this.peakBeasts = 0;
  }

  owns(npc) { return this.live.has(npc); }

  despawn(npc) {
    if (!this.live.delete(npc)) return;
    this.despawned++;
  }

  spawnOne(spec) {
    if (this.refuse) return null;
    const npc = { kind: 'person', spec, position: spec.position.clone() };
    this.live.add(npc);
    this.spawnedPeople++;
    this._peak();
    return npc;
  }

  spawnBeastGroup(spec, budget) {
    if (this.refuse) return [];
    /* `min(asked, budget, def.packMax)` - the manager's own line, and the third
     * term is not decoration. The first version of this stub clamped on `count`
     * and `budget` only, so it reported eight animals arriving from a train the
     * real manager would have cut to seven: the world declared 72 caravan
     * camels to the encounter gate and would have stood 63 in the desert. A
     * stand-in that is more generous than the thing it stands in for is a
     * stand-in that hides exactly the defect it was built to catch. */
    const n = Math.max(0, Math.min(spec.count, budget, beastDef(spec.species).packMax));
    const made = [];
    for (let i = 0; i < n; i++) {
      const b = {
        kind: 'beast',
        species: spec.species,
        territory: spec.territory,
        position: spec.position.clone(),
        /* The real `BeastNPC` clones `ctx.home` per animal, so each body gets
         * its OWN vector - which is the whole reason `driveHerds` has to write
         * to every one of them rather than to a shared anchor. */
        home: spec.position.clone(),
      };
      this.live.add(b);
      made.push(b);
    }
    this.spawnedBeasts += made.length;
    this._peak();
    return made;
  }

  _peak() {
    let p = 0;
    let b = 0;
    for (const n of this.live) { if (n.kind === 'beast') b++; else p++; }
    if (p > this.peakPeople) this.peakPeople = p;
    if (b > this.peakBeasts) this.peakBeasts = b;
  }
}

/** A fresh traffic instance over the world's own roads, wired to a stub. */
function trafficRig(world, mgr, opts = {}) {
  const roads = world.caravanRoutes.map((r, i) => ({
    ...CARAVAN_ROADS[i],
    waypoints: r.points.map((p) => new THREE.Vector3(p.x, p.y, p.z)),
  }));
  const camps = world.oases.map((o) => ({
    id: o.id,
    label: o.label,
    position: new THREE.Vector3(o.x, o.y, o.z),
    herd: o.herd,
    r: o.r,
    keeper: null,
  }));
  return new CitadelTraffic({
    npcManager: () => mgr,
    physics: world.physics,
    roads,
    camps,
    wanderers: [],
    ...opts,
  });
}

/* ================================================================== */
/* 1. Every declared animal has something behind it                    */
/* ================================================================== */

test('THE CONTRACT: every declared camel has a roster entry that will spawn it', async () => {
  const { world } = await built();
  const pop = world._population;
  assert.ok(pop, 'the citadel published no streamed population at all');

  /* What the ENCOUNTER GATES read, computed here the same way
   * `caravanContent` computes it, so the two cannot drift. */
  let declared = 0;
  for (const r of world.caravanRoutes) declared += r.trains * r.animals;
  for (const o of world.oases) declared += o.herd;

  /* And what the WORLD will actually put bodies on the ground for. */
  const rostered = pop.declaredAnimals;

  console.log('\n  what the contract says, and what is behind it:');
  console.log(`    caravan roads         ${i5(world.caravanRoutes.length)}`);
  for (const r of world.caravanRoutes) {
    console.log(`      ${r.id.padEnd(18)} ${r.trains} x ${r.animals} over ${f(r.length, 1)} m of road, ${r.points.length} waypoints`);
  }
  console.log(`    static herds          ${i5(world.oases.length)}`
    + `  (${world.oases.filter((o) => o.kind === 'oasis').length} oases, ${world.oases.filter((o) => o.kind === 'well').length} wells)`);
  console.log(`    animals declared      ${i5(declared)}`);
  console.log(`    animals rostered      ${i5(rostered)}`);
  console.log(`    roster entries        ${i5(pop.rosterSize)}  (${pop.trains.length} trains, ${pop.camps.length} herds, ${pop.folk.length} travellers)`);
  console.log(`    authored rounds       ${i5(pop.people.length)}  audited by npc-routes.test.mjs`);

  /* THE ASSERTION THAT WOULD HAVE CAUGHT THE MEDIEVAL DEFECT AT DECLARATION
   * TIME. A gate that scores `world.oases` and a world that spawns nothing at
   * those oases both pass every encounter floor there is; the two numbers being
   * equal is the only thing that connects them. This file's first draft
   * declared `herd: 8` on both oases and rostered no herd for either - 16
   * animals in a contract with nothing behind them - and this is what said so.
   */
  assert.equal(rostered, declared,
    `the world declares ${declared} camels to the encounter measurement and rosters ${rostered}: `
    + `${Math.abs(declared - rostered)} of them are a number in a contract with no body behind it`);
  /* AND NO HERD MAY BE BIGGER THAN THE SPECIES ALLOWS.
   *
   * `spawnBeastGroup` computes `min(asked, budget, def.packMax)`, so a declared
   * herd over the cap is a herd that reports more animals to the encounter gate
   * than the world ever builds - the same class of lie as a herd with no roster
   * entry, and invisible to the equality above because both sides read the
   * declaration. This drop shipped it once: eight-animal trains against a camel
   * `packMax` of 7, which would have been 72 declared and 63 standing. */
  const cap = beastDef('camel').packMax;
  for (const r of world.caravanRoutes) {
    assert.ok(r.animals <= cap,
      `${r.id} declares ${r.animals} animals a train against a camel packMax of ${cap}: `
      + `spawnBeastGroup would build ${cap} and the gate would be told ${r.animals}`);
  }
  for (const o of world.oases) {
    assert.ok(o.herd <= cap,
      `${o.id} declares a herd of ${o.herd} against a camel packMax of ${cap}`);
  }

  assert.ok(declared >= 100,
    `only ${declared} camels declared in a 900 x 900 m world; the reference placement the five `
    + 'floors were calibrated on is 64 and this placement is meant to exceed it');

  /* And the roads are the same roads twice over rather than two copies that can
   * drift: every drover's patrol IS the published polyline. */
  for (const t of pop.trains) {
    const pub = world.caravanRoutes.find((r) => r.id === t.road.id);
    assert.ok(pub, `train on unpublished road ${t.road.id}`);
    assert.equal(t.spec.patrol.length, pub.points.length,
      `${t.road.id}: the drover walks ${t.spec.patrol.length} waypoints and the contract publishes ${pub.points.length}`);
    for (let i = 0; i < pub.points.length; i++) {
      assert.ok(Math.hypot(t.spec.patrol[i].x - pub.points[i].x, t.spec.patrol[i].z - pub.points[i].z) < 1e-9,
        `${t.road.id}: drover waypoint ${i} is not the published one`);
    }
  }
});

/* ================================================================== */
/* 2. The caravans move                                                */
/* ================================================================== */

test('THE CARAVANS MOVE, at the declared pace and along the declared road', async () => {
  const { world } = await built();
  const mgr = new StubManager();
  const pop = trafficRig(world, mgr);

  /* Driven with NO player anywhere near, so nothing is ever resident and the
   * leash can never engage: this measures the dead reckoning on its own, which
   * is the thing the encounter phase is computed from. */
  const DT = 1 / 60;
  /* Twenty-five minutes, and the number is the longest cycle in the world
   * rather than a round figure: the Long Haul is 769 m one way, so its
   * out-and-back cycle is 1,538 m and a caravan at 1.15 m/s takes 1,337 s to
   * walk it once. Ten minutes measures 52.6% of that road and says nothing
   * about the other half. */
  const STEPS = 60 * 1500;
  const start = pop.trains.map((t) => t.arc);
  const off = new THREE.Vector3();
  let worstOffRoad = 0;
  const seen = pop.trains.map(() => ({ lo: Infinity, hi: -Infinity }));
  for (let s = 0; s < STEPS; s++) {
    pop.update(-448, -448, DT);
    for (let i = 0; i < pop.trains.length; i++) {
      const t = pop.trains[i];
      pop.headOf(t, off);
      const d = distToRoad(t.road.points, off.x, off.z);
      if (d > worstOffRoad) worstOffRoad = d;
      const a = cycleArc(t.arc, t.road.length);
      if (a < seen[i].lo) seen[i].lo = a;
      if (a > seen[i].hi) seen[i].hi = a;
    }
  }

  /* Distance travelled along the CYCLE, unwrapped: every train should have made
   * good `CARAVAN_SPEED * t` metres of road. */
  const wanted = CARAVAN_SPEED * STEPS * DT;
  let worstPace = 0;
  for (let i = 0; i < pop.trains.length; i++) {
    const t = pop.trains[i];
    const laps = Math.round((wanted - (t.arc - start[i])) / t.cycle);
    const went = (t.arc - start[i]) + laps * t.cycle;
    worstPace = Math.max(worstPace, Math.abs(went - wanted));
  }

  /* Coverage: over ten minutes the shortest cycle is walked several times over
   * and the longest (the 769 m Long Haul, so a 1,538 m cycle) is walked once,
   * so every train should have swept most of its own road. */
  let worstCoverage = 1;
  for (let i = 0; i < pop.trains.length; i++) {
    const frac = (seen[i].hi - seen[i].lo) / pop.trains[i].road.length;
    if (frac < worstCoverage) worstCoverage = frac;
  }

  console.log(`\n  ${((STEPS * DT) / 60) | 0} minutes of dead reckoning, nine trains, no player within 400 m:`);
  console.log(`    metres of road each train should have made good   ${f(wanted, 1)}`);
  console.log(`    worst error against that                          ${f(worstPace, 6)} m`);
  console.log(`    worst distance of any train head off its road     ${f(worstOffRoad, 9)} m`);
  console.log(`    least of its own road any train swept             ${f(worstCoverage * 100, 1)} %`);

  assert.ok(worstPace < 1e-3,
    `a train made good ${worstPace.toFixed(4)} m more or less than ${CARAVAN_SPEED} m/s over 600 s`);
  assert.ok(worstOffRoad < 1e-6,
    `a train head stood ${worstOffRoad.toFixed(6)} m off its own road - the position is meant to BE a point on it`);
  assert.ok(worstCoverage > 0.95,
    `a train only swept ${(worstCoverage * 100).toFixed(1)}% of its own road in twenty-five minutes - a caravan `
    + 'that stays at one end of the road is a static prop with extra arithmetic');

  /* ABLATION. The same driver with no time passing moves nothing, which is what
   * says the motion above came from the clock and not from the sampler. */
  const still = trafficRig(world, new StubManager());
  const before = still.trains.map((t) => t.arc);
  for (let s = 0; s < 600; s++) still.update(-448, -448, 0);
  const moved = still.trains.reduce((m, t, i) => Math.max(m, Math.abs(t.arc - before[i])), 0);
  assert.equal(moved, 0, `with dt = 0 the caravans moved ${moved} m, so the motion is not coming from the clock`);
});

/* ================================================================== */
/* 3. The herd follows                                                 */
/* ================================================================== */

test('THE HERD FOLLOWS: every camel is put back in its slot in the train', async () => {
  const { world } = await built();
  const mgr = new StubManager();
  const pop = trafficRig(world, mgr, { maxLiveBeasts: 8, maxLive: 2 });

  /* Stand the player on the head of the first train so it streams in. */
  const at = new THREE.Vector3();
  const train = pop.trains[0];
  pop.headOf(train, at);
  pop.sync(at.x, at.z);
  assert.ok(train.camels.length > 0, 'no camels arrived with a player standing on the caravan');

  const n = train.camels.length;
  /* Slot spacing, measured on the anchors the real `BeastNPC.home` is set to
   * rather than on the arithmetic that produced them. */
  const gaps = [];
  let headGap = 0;
  const probe = new THREE.Vector3();
  const spacingOf = () => {
    pop.headOf(train, probe);
    headGap = Math.hypot(train.camels[0].home.x - probe.x, train.camels[0].home.z - probe.z);
    gaps.length = 0;
    for (let i = 1; i < n; i++) {
      gaps.push(Math.hypot(
        train.camels[i].home.x - train.camels[i - 1].home.x,
        train.camels[i].home.z - train.camels[i - 1].home.z
      ));
    }
  };
  spacingOf();
  const worstGap = gaps.reduce((m, g) => Math.max(m, Math.abs(g - TRAIN_GAP)), 0);

  /* Now walk the caravan on and check the anchors came with it. */
  const first = train.camels.map((b) => ({ x: b.home.x, z: b.home.z }));
  for (let s = 0; s < 60 * 40; s++) pop.update(at.x, at.z, 1 / 60);
  let leastMoved = Infinity;
  let worstOffRoad = 0;
  for (let i = 0; i < n; i++) {
    const b = train.camels[i];
    leastMoved = Math.min(leastMoved, Math.hypot(b.home.x - first[i].x, b.home.z - first[i].z));
    worstOffRoad = Math.max(worstOffRoad, distToRoad(train.road.points, b.home.x, b.home.z));
  }

  console.log('\n  one eight-animal train, streamed in and walked for forty seconds:');
  console.log(`    animals in the train                     ${i5(n)}`);
  console.log(`    head of train to first animal            ${f(headGap, 2)} m  (TRAIN_GAP ${TRAIN_GAP})`);
  console.log(`    worst slot spacing error                 ${f(worstGap, 4)} m`);
  console.log(`    least any animal's anchor moved          ${f(leastMoved, 2)} m`);
  console.log(`    worst anchor distance off the road       ${f(worstOffRoad, 6)} m`);

  assert.equal(n, CARAVAN_ROADS[0].animals,
    `the train streamed in ${n} animals against ${CARAVAN_ROADS[0].animals} declared`);
  assert.ok(worstGap < 1e-6,
    `animal slots are ${worstGap.toFixed(4)} m off the ${TRAIN_GAP} m the encounter measurement counts them at`);
  assert.ok(worstOffRoad < 1e-6,
    `an animal was anchored ${worstOffRoad.toFixed(4)} m off the road`);
  /* The caravan is leashed to a resident drover, so forty seconds of walking is
   * not forty seconds times 1.15 m/s - but it cannot be zero either, and zero
   * is exactly what a herd whose `home` is written once at spawn would give. */
  assert.ok(leastMoved > 5,
    `after forty seconds the least-moved anchor had gone ${leastMoved.toFixed(2)} m: the herd is not `
    + 'following the caravan, it is standing where it was spawned');

  /* ABLATION: a herd at a WELL has no road and must not move at all, which is
   * what says the motion above is the ROAD driving it rather than the sync
   * touching `home` on every pass.
   *
   * Driven on its OWN rig standing at a chosen well, and the quota below is why:
   * the first draft reached for whichever camp happened to be resident beside
   * the caravan and guarded it with `if (camp)`. On the shipped placement none
   * ever was - the eight-animal train fills the cap - so the assertion never
   * executed, and a mutation sweep over this file found it as the one survivor
   * of 42. A dead assertion is a comment that costs a test run. */
  const wellSite = world.oases.find((o) => o.kind === 'well');
  const still = new CitadelTraffic({
    npcManager: () => new StubManager(),
    physics: world.physics,
    roads: [],
    camps: [{
      id: wellSite.id, label: wellSite.label, herd: wellSite.herd, r: wellSite.r, keeper: null,
      position: new THREE.Vector3(wellSite.x, wellSite.y, wellSite.z),
    }],
    maxLiveBeasts: 8,
    maxLive: 0,
  });
  still.sync(wellSite.x, wellSite.z);
  const herd = still.camps[0].bodies;
  assert.equal(herd.length, wellSite.herd,
    `the well herd streamed in ${herd.length} of ${wellSite.herd} animals - the ablation has nothing to measure`);
  const home0 = herd.map((b) => ({ x: b.home.x, z: b.home.z }));
  for (let s = 0; s < 60 * 40; s++) still.update(wellSite.x, wellSite.z, 1 / 60);
  const drift = herd.reduce((mx, b, i) => Math.max(mx, Math.hypot(b.home.x - home0[i].x, b.home.z - home0[i].z)), 0);
  assert.equal(drift, 0,
    `a standing well herd drifted ${drift.toFixed(2)} m over forty seconds - only caravans are meant to walk`);
});


/* ================================================================== */
/* 3b. The herd follows WITH LEGS                                      */
/* ================================================================== */

test('THE HERD KEEPS UP: a caravan camel can out-walk its own anchor', async () => {
  const { world } = await built();
  const mgr = liveManager(world);
  const pop = trafficRig(world, mgr);

  /* The Long Haul's second train: 769 m of open desert at y 0.16, the one road
   * in the world where nothing can get between an animal and its slot, so what
   * is measured here is the animal's pace and not the terrain. */
  const train = pop.trains.find((t) => t.road.id === 'north-desert' && t.index === 1);
  const head = new THREE.Vector3();
  pop.headOf(train, head);
  pop.sync(head.x, head.z);
  assert.equal(train.camels.length, CARAVAN_ROADS[2].animals,
    `the train streamed in ${train.camels.length} real bodies of ${CARAVAN_ROADS[2].animals}`);

  const slotError = () => {
    const d = train.camels.map((b) => Math.hypot(b.position.x - b.home.x, b.position.z - b.home.z));
    d.sort((a, b) => a - b);
    return { med: d[d.length >> 1], max: d[d.length - 1] };
  };
  const startedAt = slotError();
  /* Three minutes, following the head. The defect this catches is MONOTONE -
   * the error could only grow, because the animal's top speed WAS its anchor's
   * - so what is asserted is that it shrinks instead. */
  let travelled = 0;
  const before = new THREE.Vector3();
  for (let i = 0; i < 180 * 60; i++) {
    pop.headOf(train, head);
    before.copy(train.camels[0].position);
    mgr.player.position.copy(head);
    pop.update(head.x, head.z, 1 / 60);
    mgr.fixedUpdate(1 / 60, i / 60);
    mgr.update(1 / 60, i / 60);
    travelled += Math.hypot(train.camels[0].position.x - before.x, train.camels[0].position.z - before.z);
  }
  const ended = slotError();
  const madeGood = travelled / 180;

  console.log('\n  one real train, real bodies, followed for 180 s:');
  console.log(`    animals                                  ${i5(train.camels.length)}`);
  console.log(`    slot error at t=0                        ${f(startedAt.med, 1)} m median, ${f(startedAt.max, 1)} m worst`);
  console.log(`    slot error at t=180                      ${f(ended.med, 1)} m median, ${f(ended.max, 1)} m worst`);
  console.log(`    ground the lead animal made good         ${f(madeGood, 2)} m/s  (caravan ${CARAVAN_SPEED}, roamSpeed ${TRAIN_ROAM_SPEED})`);

  /* THE DECLARATION HAS TO BE REACHABLE AT ALL. `driveHerds` walks `home`
   * along the road at CARAVAN_SPEED and `BeastNPC._roam` steers at
   * `def.roamSpeed`; if the second is not strictly greater than the first the
   * animal cannot close a gap it has already opened, whatever else is true. */
  assert.ok(TRAIN_ROAM_SPEED > CARAVAN_SPEED,
    `a caravan camel may walk at ${TRAIN_ROAM_SPEED} m/s and its own slot moves at ${CARAVAN_SPEED} m/s: `
    + 'the animal cannot catch up with the position the contract says it is in');
  /* And the override has to have REACHED the body. `_createBeast` copies it
   * onto a fresh `def`; reading it off the shared species row would be reading
   * the very thing the override exists to avoid touching. */
  for (const b of train.camels) {
    assert.equal(b.def.roamSpeed, TRAIN_ROAM_SPEED,
      `a caravan camel is walking at the species pace ${b.def.roamSpeed}, so the override never arrived`);
    assert.equal(b.def.territory, TRAIN_TERRITORY, 'the territory override never arrived either');
  }
  assert.equal(beastDef('camel').roamSpeed, CARAVAN_SPEED,
    'the species row itself was mutated - every wild camel in the game has just been re-tuned');

  assert.ok(ended.med < startedAt.med,
    `slot error went ${startedAt.med.toFixed(1)} m -> ${ended.med.toFixed(1)} m over three minutes: the animals `
    + 'are losing ground on their own train, which is the defect this case exists for');
  assert.ok(ended.max < 25,
    `the worst animal ended ${ended.max.toFixed(1)} m from its slot in a ${TRAIN_GAP * CARAVAN_ROADS[2].animals} m `
    + 'train - what the player meets is a straggle, not a caravan');
  assert.ok(madeGood > CARAVAN_SPEED * 0.8,
    `the lead animal made good ${madeGood.toFixed(2)} m/s against a caravan at ${CARAVAN_SPEED}`);

  /* ABLATION: the same 180 s with the species pace put back. That override is
   * the whole of the fix, so without it the error has to grow instead. */
  const slow = liveManager(world);
  const slowPop = trafficRig(world, slow);
  const slowTrain = slowPop.trains.find((t) => t.road.id === 'north-desert' && t.index === 1);
  slowTrain.beastSpec.roamSpeed = beastDef('camel').roamSpeed;
  const h2 = new THREE.Vector3();
  slowPop.headOf(slowTrain, h2);
  slowPop.sync(h2.x, h2.z);
  for (let i = 0; i < 180 * 60; i++) {
    slowPop.headOf(slowTrain, h2);
    slow.player.position.copy(h2);
    slowPop.update(h2.x, h2.z, 1 / 60);
    slow.fixedUpdate(1 / 60, i / 60);
    slow.update(1 / 60, i / 60);
  }
  const slowD = slowTrain.camels.map((b) => Math.hypot(b.position.x - b.home.x, b.position.z - b.home.z));
  slowD.sort((a, b) => a - b);
  const slowMed = slowD[slowD.length >> 1];
  console.log(`    ablation, roamSpeed back to ${beastDef('camel').roamSpeed}:      ${f(slowMed, 1)} m median at t=180`);
  assert.ok(slowMed > ended.med * 2,
    `with the override removed the slot error is ${slowMed.toFixed(1)} m against ${ended.med.toFixed(1)} m with it - `
    + 'the override is not what is holding the train together, so this case proves nothing');
});

/* ================================================================== */
/* 3c. The anchors are on the road, not on the roofs above it          */
/* ================================================================== */

test('THE ANCHORS ARE ON THE ROAD: driveHerds resolves the surface, it does not probe down', async () => {
  const { world } = await built();
  const mgr = new StubManager();
  const pop = trafficRig(world, mgr, { maxLiveBeasts: 8, maxLive: 0 });
  const train = pop.trains.find((t) => t.road.id === 'mesa-spine');
  const probe = new THREE.Vector3();
  const head = new THREE.Vector3();
  pop.headOf(train, head);
  pop.sync(head.x, head.z);
  assert.ok(train.camels.length > 0, 'no camels arrived, so there are no anchors to audit');

  /* THE ABLATION FIRST, because without it this case is vacuous. `groundHeight`
   * returns the first surface below the TOP of its probe window, so on the mesa
   * it answers a souk roof where the road is; `resolveSurfaceY` picks the
   * surface nearest the hint. If the two never disagreed on this road there
   * would be nothing here to get wrong. */
  const arcs = train.road.arcs;
  const total = arcs[arcs.length - 1];
  let worstGap = 0;
  let worstAt = null;
  for (let s = 0; s <= total; s += 1) {
    pointAtArc(train.road.points, arcs, s, probe);
    const down = world.physics.groundHeight(probe.x, probe.z, probe.y + 6, 14);
    const near = resolveSurfaceY(world.physics, probe.x, probe.z, probe.y);
    const gap = (down ?? probe.y) - (near ?? probe.y);
    if (Math.abs(gap) > Math.abs(worstGap)) { worstGap = gap; worstAt = [probe.x, probe.z, near, down]; }
  }
  assert.ok(worstGap > 3,
    `the two ground probes agree to ${worstGap.toFixed(2)} m everywhere on the mesa road, so this case `
    + 'cannot tell them apart and proves nothing');

  /* Now walk the whole cycle and check every anchor the herd is ever given. */
  let worstLift = 0;
  let liftAt = null;
  let checked = 0;
  for (let a = 0; a < train.cycle; a += 3) {
    train.arc = a;
    pop.driveHerds();
    for (const b of train.camels) {
      const near = resolveSurfaceY(world.physics, b.home.x, b.home.z, b.home.y);
      if (near === null) continue;
      checked++;
      const lift = Math.abs(b.home.y - near);
      if (lift > worstLift) { worstLift = lift; liftAt = [b.home.x, b.home.y, b.home.z, near]; }
    }
  }

  console.log('\n  one mesa-spine train walked round its whole cycle:');
  console.log(`    worst disagreement between the two probes ${f(worstGap, 2)} m at `
    + `(${worstAt[0].toFixed(0)}, ${worstAt[1].toFixed(0)}) - surface ${f(worstAt[2], 2)}, probe-down ${f(worstAt[3], 2)}`);
  console.log(`    herd anchors checked                      ${i5(checked)}`);
  console.log(`    worst anchor off the resolved surface     ${f(worstLift, 3)} m`);

  assert.ok(checked > 500, `only ${checked} anchors sampled - the sweep is not covering the cycle`);
  assert.ok(worstLift < 0.01,
    `a camel's home stood ${worstLift.toFixed(2)} m off the surface at `
    + `(${liftAt?.[0].toFixed(0)}, ${liftAt?.[2].toFixed(0)}) - a home on a roof is permanently outside the `
    + 'territory, so _roam re-targets every step, _wanderNear probes from the roof, nav._clearLine rejects '
    + 'all six candidates and the animal stops dead');
});

/* ================================================================== */
/* 3d. The train does not telescope onto the end of its road           */
/* ================================================================== */

test('THE TRAIN IS A LINE at every phase, including the ends of the road', async () => {
  const { world } = await built();
  const mgr = new StubManager();
  const pop = trafficRig(world, mgr, { maxLiveBeasts: 8, maxLive: 0 });
  const train = pop.trains.find((t) => t.road.id === 'mesa-spine');
  const head = new THREE.Vector3();
  pop.headOf(train, head);
  pop.sync(head.x, head.z);
  assert.ok(train.camels.length > 1, 'no train arrived, so there is no line to measure');

  /**
   * How many animals share a single anchor, and how much road the whole train
   * covers, at one phase.
   *
   * Both are needed. Near an end of the road a train genuinely doubles back on
   * itself - an out-and-back cycle is one line walked twice - so the tail folds
   * onto the outbound side and animals pair up, two to a point. That is the
   * geometry and it is fine. What is not fine is the whole train collapsing,
   * which is what clamping every slot at arc 0 did.
   */
  const layout = () => {
    const at = new Map();
    for (const b of train.camels) {
      const k = `${b.home.x.toFixed(2)},${b.home.z.toFixed(2)}`;
      at.set(k, (at.get(k) ?? 0) + 1);
    }
    let span = 0;
    for (let i = 0; i < train.camels.length; i++) {
      for (let j = i + 1; j < train.camels.length; j++) {
        span = Math.max(span, Math.hypot(
          train.camels[i].home.x - train.camels[j].home.x,
          train.camels[i].home.z - train.camels[j].home.z
        ));
      }
    }
    return { mult: Math.max(...at.values()), span };
  };

  let worstMult = 0;
  let multArc = 0;
  let worstSpan = Infinity;
  let spanArc = 0;
  let worstSpacing = 0;
  const nose = TRAIN_GAP * (train.camels.length + 1);
  for (let a = 0; a < train.cycle; a += 1) {
    train.arc = a;
    pop.driveHerds();
    const l = layout();
    if (l.mult > worstMult) { worstMult = l.mult; multArc = a; }
    if (l.span < worstSpan) { worstSpan = l.span; spanArc = a; }
    /* Away from the fold the line has to be a LINE with the encounter gate's
     * own 4 m slot in it. Two details, both of which the first draft got wrong.
     *
     * Inside one train length of either end the fold makes consecutive slots
     * coincide on purpose, so the claim is only made where it means something.
     *
     * And it is measured ALONG THE ROAD, by projecting each anchor back onto
     * the polyline, rather than as a straight line between anchors. The mesa
     * road turns through a right angle at (-30, -30) and again at (-36, -60);
     * a 4 m step of ARC across a corner is a chord of as little as 3.26 m,
     * which is the corner and not the layout. Chord-measured, this same sweep
     * reads 0.74 m of "error" on a train that is exactly 4.000 m per slot. */
    if (a > nose && a < train.road.length - nose) {
      for (let i = 1; i < train.camels.length; i++) {
        const back = projectOnRoad(train.road.points, train.road.arcs,
          train.camels[i].home.x, train.camels[i].home.z);
        const front = projectOnRoad(train.road.points, train.road.arcs,
          train.camels[i - 1].home.x, train.camels[i - 1].home.z);
        const err = Math.abs((front - back) - TRAIN_GAP);
        if (err > worstSpacing) worstSpacing = err;
      }
    }
  }

  /* THE ABLATION, computed here rather than remembered: the clamp this
   * replaced, `s < 0 ? 0 : s`, at the phase where it was worst. Arc 0 is the
   * outbound end of the cycle and `world.playerSpawn` is two metres from it, so
   * a session could begin inside the pile. */
  train.arc = 0;
  pop.driveHerds();
  const clamped = new Set();
  const probe = new THREE.Vector3();
  for (let i = 0; i < train.camels.length; i++) {
    const sArc = 0 - (i + 1) * TRAIN_GAP;
    pointAtArc(train.road.points, train.road.arcs, sArc < 0 ? 0 : sArc, probe);
    clamped.add(`${probe.x.toFixed(2)},${probe.z.toFixed(2)}`);
  }
  const spawn = world.playerSpawn;
  const nearest = Math.min(...train.camels.map((b) => Math.hypot(b.home.x - spawn.x, b.home.z - spawn.z)));

  console.log('\n  a mesa-spine train sampled at every metre of its cycle:');
  console.log(`    most animals ever sharing one anchor      ${i5(worstMult)} of ${train.camels.length}  (at arc ${multArc})`);
  console.log(`    smallest footprint the train ever has     ${f(worstSpan, 2)} m  (at arc ${spanArc}, nominal ${TRAIN_GAP * (train.camels.length - 1)})`);
  console.log(`    worst slot spacing away from the fold     ${f(worstSpacing, 4)} m of arc  (TRAIN_GAP ${TRAIN_GAP})`);
  console.log(`    at arc 0, nearest anchor to player spawn  ${f(nearest, 2)} m`);
  console.log(`    ablation - the old clamp at arc 0:        ${clamped.size} distinct anchors of ${train.camels.length}`);

  assert.equal(clamped.size, 1,
    'the clamp this replaced does not collapse the train at arc 0, so this case is measuring something else');
  assert.ok(worstMult <= 2,
    `at arc ${multArc}, ${worstMult} of this train's ${train.camels.length} animals stand on one anchor. Near an `
    + 'end of the road the tail folds onto the outbound side and pairs up, which is what an out-and-back '
    + 'cycle looks like; more than a pair means the slots are being clamped to the endpoint instead');
  assert.ok(worstSpan > 10,
    `the train shrinks to ${worstSpan.toFixed(2)} m of road at arc ${spanArc} - a caravan that telescopes into a `
    + 'point is a pile of camels, and at arc 0 that point is 2 m from the player spawn');
  assert.ok(worstSpacing < 1e-6,
    `slot spacing is ${worstSpacing.toFixed(4)} m of arc off ${TRAIN_GAP} m somewhere along the open road - `
    + 'the encounter gate counts each animal in its own 4 m slot, so the slots have to be that far apart');
});

/* ================================================================== */
/* 4b. The leash corrects; it never latches                            */
/* ================================================================== */

test('THE LEASH: a dead drover is not an anchor, and his caravan walks on', async () => {
  const { world } = await built();
  const mgr = new StubManager();
  const pop = trafficRig(world, mgr, { maxLiveBeasts: 0, maxLive: 4 });
  const train = pop.trains[0];
  const head = new THREE.Vector3();
  pop.headOf(train, head);
  pop.sync(head.x, head.z);
  assert.ok(train.npc, 'no drover streamed in, so there is nothing to kill');

  /* Put him a whole leash and a half behind, ON the road, so what is under test
   * is his state and not where he is standing. */
  const L = train.road.length;
  train.arc = Math.min(L - 1, 120);
  const behind = new THREE.Vector3();
  pointAtArc(train.road.points, train.road.arcs, train.arc - DROVER_LEASH * 1.5, behind);
  train.npc.position.copy(behind);

  assert.equal(pop._leashed(train), true,
    'a living drover a leash and a half behind his caravan does not hold it - the assertion below is vacuous');

  train.npc.isDead = true;
  assert.equal(pop._leashed(train), false,
    'a DEAD drover still holds his caravan. `_updateRespawns` walks the hostile roster only, so a friendly '
    + 'never comes back, and the release pass only drops a reference the manager has stopped owning: the '
    + 'corpse stays a valid anchor for as long as the player stands near it, and the caravan and its seven '
    + 'camels stand still for as long as he watches');

  /* Driven: two minutes with the corpse where it fell. */
  const before = train.arc;
  for (let i = 0; i < 120 * 60; i++) pop.update(head.x, head.z, 1 / 60);
  const wanted = CARAVAN_SPEED * 120;
  const went = train.arc - before + (train.arc < before ? train.cycle : 0);
  console.log('\n  the drover shot dead, then two minutes with the player on the caravan:');
  console.log(`    metres of road the caravan should make good  ${f(wanted, 1)}`);
  console.log(`    metres it actually made good                 ${f(went, 1)}`);
  assert.ok(went > wanted * 0.95,
    `the caravan made good ${went.toFixed(1)} m of ${wanted.toFixed(1)} with its drover dead beside it`);
});

test('THE LEASH: it is measured on the leg the caravan is on, both ways round', async () => {
  const { world } = await built();
  const mgr = new StubManager();
  const pop = trafficRig(world, mgr, { maxLiveBeasts: 0, maxLive: 4 });
  const train = pop.trains[0];
  const head = new THREE.Vector3();
  pop.headOf(train, head);
  pop.sync(head.x, head.z);
  assert.ok(train.npc, 'no drover streamed in');

  const at = new THREE.Vector3();
  const put = (oneWayArc) => {
    pointAtArc(train.road.points, train.road.arcs, oneWayArc, at);
    train.npc.position.copy(at);
  };

  /* OUTBOUND. The train is at one-way arc 150 walking out, so a drover at 100
   * is fifty metres behind it and one at 170 is twenty ahead. */
  train.arc = 150;
  put(100);
  assert.equal(pop._leashed(train), true, 'outbound, a drover 50 m behind does not hold the caravan');
  put(170);
  assert.equal(pop._leashed(train), false, 'outbound, a drover 20 m AHEAD is holding the caravan back');

  /* RETURN. The same train at cycle position `2L - 150` is in the same PLACE
   * walking the other way, so now the drover at one-way 200 is the one behind.
   * This is the case a folded-arc test could never fire on: measured on the
   * shipped placement before the fix, a return-leg drover ended 505.8 m from
   * his own caravan against a declared 25 m leash, and three of the nine
   * trains start on that leg. */
  train.arc = train.cycle - 150;
  put(200);
  assert.equal(pop._leashed(train), true,
    'on the return leg a drover 50 m behind does not hold the caravan - the leash is folding the arc and so '
    + 'cannot tell which way either of them is walking');
  put(130);
  assert.equal(pop._leashed(train), false, 'on the return leg a drover 20 m ahead is holding the caravan back');

  /* AND THE DROVER IS TURNED ROUND TO MATCH. `NPC.routeAhead` reverses an open
   * patrol at each end on its own schedule; `patrolDir` is the one field it
   * reads before it decides. */
  train.arc = 150;
  pop.driveHerds();
  assert.equal(train.npc.patrolDir, 1, 'outbound, the drover is set to walk his route backwards');
  train.arc = train.cycle - 150;
  pop.driveHerds();
  assert.equal(train.npc.patrolDir, -1,
    'on the return leg the drover is still set to walk outbound - for half of every cycle he and his animals '
    + 'would walk in opposite directions');
  console.log('\n  the leash fires on the leg the caravan is on, and the drover faces the same way.');
});

test('THE LEASH: a caravan can never be held for longer than DROVER_STALL', async () => {
  const { world } = await built();
  const mgr = new StubManager();
  const pop = trafficRig(world, mgr, { maxLiveBeasts: 0, maxLive: 4 });
  const train = pop.trains[0];
  const head = new THREE.Vector3();
  pop.headOf(train, head);
  pop.sync(head.x, head.z);
  assert.ok(train.npc, 'no drover streamed in');

  /* A drover who never moves: wedged on geometry, shoved off the road, or just
   * slower than his own caravan. Before this bound existed that was a
   * permanent stop - measured at 249 s of standing still in a 300 s run. */
  const L = train.road.length;
  train.arc = Math.min(L - 1, 120);
  const parked = new THREE.Vector3();
  pointAtArc(train.road.points, train.road.arcs, 0, parked);
  train.npc.position.copy(parked);

  const before = train.arc;
  let held = 0;
  for (let i = 0; i < 120 * 60; i++) {
    const was = train.arc;
    pop.update(head.x, head.z, 1 / 60);
    if (train.arc === was) held++;
  }
  const stoppedFor = held / 60;
  const went = train.arc - before + (train.arc < before ? train.cycle : 0);

  console.log('\n  a drover parked at the start of the road, two minutes:');
  console.log(`    seconds the caravan stood still           ${f(stoppedFor, 1)}  (DROVER_STALL ${DROVER_STALL})`);
  console.log(`    metres it still made good                 ${f(went, 1)} of ${f(CARAVAN_SPEED * 120, 1)}`);

  assert.ok(stoppedFor <= DROVER_STALL + 0.5,
    `the caravan stood still for ${stoppedFor.toFixed(1)} s waiting for a drover who never moved`);
  assert.ok(went > CARAVAN_SPEED * 120 * 0.85,
    `the caravan made good only ${went.toFixed(1)} m in two minutes with a stuck drover`);
  assert.ok(pop.stats.leashed > 0, 'the leash never engaged at all, so this case proves nothing');
});

/* ================================================================== */
/* 4c. The budget is re-allocated, not handed out once                 */
/* ================================================================== */

test('A HERD THAT ARRIVES SHORT IS TOPPED UP when room frees', async () => {
  const { world } = await built();
  const mgr = new StubManager();
  /* Two well herds of four and room for five. The nearer one arrives whole and
   * the further one arrives with ONE animal - which is what the player meets,
   * and which both encounter gates score as a herd of four. */
  const a = { id: 'near', label: 'near', herd: 4, r: 9.9, keeper: null, position: new THREE.Vector3(0, 0, 0) };
  const b = { id: 'far', label: 'far', herd: 4, r: 9.9, keeper: null, position: new THREE.Vector3(0, 0, 150) };
  const pop = new CitadelTraffic({
    npcManager: () => mgr, physics: world.physics,
    roads: [], camps: [a, b], maxLiveBeasts: 5, maxLive: 0,
  });

  pop.sync(0, 20);
  const near = pop.camps[0];
  const far = pop.camps[1];
  assert.equal(near.bodies.length, 4, 'the nearer herd did not arrive whole, so the fixture is wrong');
  assert.equal(far.bodies.length, 1,
    `the further herd arrived with ${far.bodies.length} against a budget of one - the fixture is wrong`);

  /* Now walk on so the NEAR herd passes its 220 m release radius while the far
   * one stays resident and inside the 175 m stream radius. That is the state
   * the defect lived in: budget has freed up, the short herd is still standing
   * there with its one animal, and nothing ever gives it the other three.
   *
   * Walking somewhere that releases BOTH herds would not test this at all - it
   * would test re-acquisition, which always worked. That version of this case
   * passed with the defect fully re-introduced, and the defect-reintroduction
   * sweep is what found it. */
  pop.sync(0, 300);
  assert.equal(near.bodies.length, 0, 'the near herd was not released, so no budget freed up');
  assert.ok(far.bodies.length > 0,
    'the far herd was released too, so this case is measuring re-acquisition and not a top-up');

  console.log('\n  two four-camel herds and room for five:');
  console.log(`    the far herd arrived with                ${i5(1)} of ${i5(far.beastSpec.count)}`);
  console.log(`    after the near herd released it holds    ${i5(far.bodies.length)}`);

  assert.equal(far.bodies.length, 4,
    `the short herd still holds ${far.bodies.length} of ${far.beastSpec.count} animals after the budget freed up. `
    + 'The acquire pass skipped any group that already had a body, so a herd that arrived short stayed short '
    + 'until the whole group despawned - measured on the shipped placement as 443 observations of a caravan '
    + 'of one camel');
});

test('THE NEAREST HERD TAKES THE BUDGET off a further one that already has it', async () => {
  const { world } = await built();
  const a = { id: 'a', label: 'a', herd: 4, r: 9.9, keeper: null, position: new THREE.Vector3(0, 0, 0) };
  const b = { id: 'b', label: 'b', herd: 4, r: 9.9, keeper: null, position: new THREE.Vector3(0, 0, 120) };
  /* ONE manager per rig, closed over. A fresh `StubManager` per call would
   * report `owns() === false` for every body it did not make, and the release
   * pass would quietly drop the whole cast on the next sync - which looks
   * exactly like an eviction and is not one. */
  const make = () => {
    const mgr = new StubManager();
    return new CitadelTraffic({
      npcManager: () => mgr, physics: world.physics,
      roads: [], camps: [a, b], maxLiveBeasts: 4, maxLive: 0,
    });
  };

  const pop = make();
  pop.sync(0, 10);
  assert.equal(pop.camps[0].bodies.length, 4, 'herd A did not take the whole budget, so the fixture is wrong');

  /* Walk to B. A is 110 m away - still inside the 220 m release radius, so
   * nothing releases it - and B is 10 m away with nothing. Before this, the
   * budget was handed out at ACQUIRE and never re-allocated: A held its four
   * animals until the player walked 220 m from it, and the herd the player was
   * standing in the middle of got none. Measured on the shipped placement, at
   * the moment a group came within recognition range with no body of its own,
   * the furthest animal still holding budget was a median 165 m away. */
  pop.sync(0, 110);
  console.log('\n  two four-camel herds 120 m apart, room for four, player walking from A to B:');
  console.log(`    herd A, now 110 m behind, holds          ${i5(pop.camps[0].bodies.length)}`);
  console.log(`    herd B, now 10 m away, holds             ${i5(pop.camps[1].bodies.length)}`);
  console.log(`    animals evicted                          ${i5(pop.stats.evicted)}`);
  assert.equal(pop.camps[1].bodies.length, 4,
    `the herd the player is standing in holds ${pop.camps[1].bodies.length} animals while one 110 m behind holds four`);
  assert.equal(pop.camps[0].bodies.length, 0, 'both herds are resident at once, so the cap is not the cap');
  assert.ok(pop.stats.evicted >= 4, 'nothing was evicted, so the animals arrived some other way');

  /* ABLATION: the margin. A player halfway between two herds must not trade
   * them back and forth every sync, so a candidate only takes budget when it
   * is EVICT_MARGIN nearer. At (0, 65) B is 55 m away and A is 65: ten metres
   * of advantage against a margin of forty. */
  const steady = make();
  steady.sync(0, 10);
  steady.sync(0, 65);
  console.log(`    ablation, B only 10 m nearer: A holds ${steady.camps[0].bodies.length}, `
    + `B holds ${steady.camps[1].bodies.length}, ${steady.stats.evicted} evicted`);
  assert.equal(steady.stats.evicted, 0,
    `a herd was evicted for one only 10 m nearer, against a margin of ${EVICT_MARGIN} m - a player standing `
    + 'between two herds would watch them swap every 0.4 s');
});

/* ================================================================== */
/* 4d. The oasis herd stands on the desert, not on the tank            */
/* ================================================================== */

test('THE OASIS HERD IS ON THE GROUND, not scattered over the masonry', async () => {
  const { world } = await built();
  const oases = world.oases.filter((o) => o.kind === 'oasis');
  assert.equal(oases.length, 2, 'the world did not build two oases, so there is nothing to audit');

  /* Real bodies from the real manager, over thirty seeds, because
   * `spawnBeastGroup` scatters at `spread * (0.4 + rnd * 0.6)` and one seed
   * says nothing about where the herd lands. */
  const count = (spreadOf) => {
    let bodies = 0;
    let inTank = 0;
    let worstLift = 0;
    for (let seed = 0; seed < 30; seed++) {
      const mgr = liveManager(world);
      mgr._seedCounter = seed * 97;
      for (const o of oases) {
        const anchorG = world.physics.groundHeight(o.x, o.z, o.y + 6, 20) ?? o.y;
        const made = mgr.spawnBeastGroup({
          position: new THREE.Vector3(o.x, o.y, o.z),
          type: 'beast', species: 'camel', name: `${o.label} camel`,
          count: o.herd, territory: 14, spread: spreadOf(o),
        }, 14);
        for (const b of made) {
          bodies++;
          if (Math.hypot(b.position.x - o.tank.x, b.position.z - o.tank.z) <= o.tank.r) inTank++;
          const lift = b.position.y - anchorG;
          if (lift > worstLift) worstLift = lift;
        }
        for (const b of made) mgr.despawn(b);
      }
    }
    return { bodies, inTank, worstLift };
  };

  const shipped = count((o) => o.r);
  console.log('\n  30 seeds x 2 oasis herds, real bodies on the real world:');
  console.log(`    published herd radius                    ${f(oases[0].r, 1)} m   (tank half-width ${f(oases[0].tank.r, 1)} m)`);
  console.log(`    bodies spawned                           ${i5(shipped.bodies)}`);
  console.log(`    standing inside the tank footprint       ${i5(shipped.inTank)}`);
  console.log(`    worst body above its anchor's ground     ${f(shipped.worstLift, 2)} m`);

  assert.ok(shipped.bodies >= 400, `only ${shipped.bodies} bodies spawned - the sweep is not sweeping`);
  assert.equal(shipped.inTank, 0,
    `${shipped.inTank} of ${shipped.bodies} oasis camels stand inside the tank footprint. The herd anchor is `
    + 'settled on grade OUTSIDE the tank and then the group is scattered by its published radius, so that '
    + 'radius has to be the clear ground the sweep found and not the tank half-width');
  assert.ok(shipped.worstLift < 4.5,
    `a camel stood ${shipped.worstLift.toFixed(2)} m above the herd anchor's own ground - that is masonry, `
    + 'not desert');

  /* ABLATION: the tank's own half-width, which is what shipped first. */
  const wide = count((o) => o.tank.r);
  console.log(`    ablation at the tank half-width:         ${wide.inTank} of ${wide.bodies} inside the tank, `
    + `worst ${f(wide.worstLift, 2)} m up`);
  assert.ok(wide.inTank > shipped.inTank,
    'spawning the herd at the tank half-width puts no more animals on the masonry than the shipped radius '
    + 'does, so the radius is not what decides it and this case proves nothing');
});

/* ================================================================== */
/* 4. It streams, and the cap binds on the furthest                    */
/* ================================================================== */

test('IT STREAMS: content arrives where the player is and is released when they leave', async () => {
  const { world } = await built();
  const mgr = new StubManager();
  const pop = trafficRig(world, mgr, { maxLiveBeasts: 12, maxLive: 10 });

  /* Walk the whole mesa road at a walking pace, which is the journey every
   * session begins with. */
  const road = pop.roads[0];
  const arcs = roadArcs(road.points);
  const total = arcs[arcs.length - 1];
  const here = new THREE.Vector3();
  const DT = 1 / 60;
  let steps = 0;
  let metWithCamels = 0;
  let maxBeasts = 0;
  let maxPeople = 0;
  for (let s = 0; s <= total; s += 4.6 * 0.5) {
    pointAtArc(road.points, arcs, s, here);
    for (let k = 0; k < 30; k++) { pop.update(here.x, here.z, DT); steps++; }
    const b = pop.liveBeastCount();
    const p = pop.liveCount();
    if (b > 0) metWithCamels++;
    if (b > maxBeasts) maxBeasts = b;
    if (p > maxPeople) maxPeople = p;
  }
  const sampled = Math.ceil(total / (4.6 * 0.5)) + 1;

  /* And then leave: the far corner of the map is 600 m from anything on the
   * mesa road, which is well past the 220 m release radius. */
  for (let k = 0; k < 600; k++) pop.update(-448, 448, DT);

  console.log('\n  one walk of the mesa road, 0.5 s of simulation every 2.3 m:');
  console.log(`    positions sampled                        ${i5(sampled)}`);
  console.log(`    positions with a camel already resident  ${i5(metWithCamels)}  ${f((metWithCamels / sampled) * 100, 1)} %`);
  console.log(`    peak live animals                        ${i5(maxBeasts)}  cap ${pop.maxLiveBeasts}`);
  console.log(`    peak live humans                         ${i5(maxPeople)}  cap ${pop.maxLive}`);
  console.log(`    spawned / despawned                      ${i5(pop.stats.spawned)} / ${i5(pop.stats.despawned)}`);
  console.log(`    live after walking to the far corner     ${i5(pop.liveBeastCount())} animals, ${i5(pop.liveCount())} humans`);

  assert.ok(maxBeasts > 0, 'walking the whole mesa road never brought a single camel into the world');
  assert.ok(maxBeasts <= pop.maxLiveBeasts,
    `${maxBeasts} live animals against a cap of ${pop.maxLiveBeasts} - the budget is not a budget`);
  assert.ok(maxPeople <= pop.maxLive,
    `${maxPeople} live humans against a cap of ${pop.maxLive}`);
  assert.equal(pop.liveBeastCount(), 0,
    'animals are still resident with the player 600 m away - nothing is being released');
  assert.equal(pop.liveCount(), 0, 'humans are still resident with the player 600 m away');

  /* ABLATION: the same rig, never moved off the empty corner of the map, has
   * nothing at all - so the arrivals above are the player's position deciding
   * them and not the clock. */
  const empty = trafficRig(world, new StubManager());
  for (let k = 0; k < 60 * 120; k++) empty.update(-448, 448, DT);
  assert.equal(empty.liveBeastCount(), 0,
    'content streamed in for a player standing in the empty corner of the map');
  assert.ok(empty.stats.syncs > 100, 'the ablation never actually ran a sync, so it proves nothing');
});

test('THE CAP BINDS ON THE FURTHEST CANDIDATE, never on the last one written', async () => {
  const { world } = await built();
  /* Room for ONE four-camel herd, and two well herds inside the stream radius.
   * `spawnForWorld` in this situation keeps whichever was authored first;
   * this has to keep whichever is nearest. */
  const near = world.oases.find((o) => o.kind === 'well');
  const others = world.oases.filter((o) => o !== near);
  let far = null;
  let bestD = Infinity;
  for (const o of others) {
    const d = Math.hypot(o.x - near.x, o.z - near.z);
    if (d < bestD) { bestD = d; far = o; }
  }

  const mgr = new StubManager();
  const pop = new CitadelTraffic({
    npcManager: () => mgr,
    physics: world.physics,
    roads: [],
    camps: [far, near].map((o) => ({
      id: o.id, label: o.label, herd: o.herd, r: o.r, keeper: null,
      position: new THREE.Vector3(o.x, o.y, o.z),
    })),
    maxLiveBeasts: 4,
    maxLive: 0,
  });
  /* Stand three quarters of the way toward the near one, so both are inside the
   * 175 m stream radius and one is unambiguously closer. */
  const px = near.x + (far.x - near.x) * 0.15;
  const pz = near.z + (far.z - near.z) * 0.15;
  const dNear = Math.hypot(px - near.x, pz - near.z);
  const dFar = Math.hypot(px - far.x, pz - far.z);
  pop.sync(px, pz);

  const liveIds = pop.camps.filter((c) => c.bodies.length).map((c) => c.site.id);
  console.log('\n  two herds inside the stream radius, room for one:');
  console.log(`    nearer  ${near.id.padEnd(16)} ${f(dNear, 0)} m`);
  console.log(`    further ${far.id.padEnd(16)} ${f(dFar, 0)} m`);
  console.log(`    written first in the roster: ${far.id}`);
  console.log(`    spawned: ${liveIds.join(', ') || '(nothing)'}`);

  assert.ok(dNear < dFar, 'the fixture did not actually put one herd nearer than the other');
  assert.ok(dFar < pop.spawnRadius, 'the further herd is outside the stream radius, so the cap never binds');
  assert.deepEqual(liveIds, [near.id],
    `the cap kept ${liveIds.join(', ')} - it is meant to keep the nearest candidate, and the further `
    + 'one was written first in the roster precisely so a first-come rule would fail here');
  assert.ok(pop.stats.refused > 0, 'nothing was refused, so the cap did not bind and this proves nothing');
});

/* ================================================================== */
/* 5. Nothing in a caravan can attack                                  */
/* ================================================================== */

test('NOTHING IN A CARAVAN CAN ATTACK THE PLAYER', async () => {
  const { world } = await built();
  const pop = world._population;

  const species = new Set();
  for (const t of pop.trains) species.add(t.beastSpec.species);
  for (const c of pop.camps) species.add(c.beastSpec.species);

  const camel = beastDef('camel');
  const wolf = beastDef('wolf');
  console.log('\n  every animal this feature puts in the world:');
  console.log(`    species                ${[...species].join(', ')}`);
  console.log(`    camel  predator ${String(isPredator(camel)).padEnd(6)} reach ${f(camel.reach, 2)}  fov ${camel.fovDegrees}  courage ${camel.courage}`);
  console.log(`    wolf   predator ${String(isPredator(wolf)).padEnd(6)} reach ${f(wolf.reach, 2)}  fov ${wolf.fovDegrees}  courage ${wolf.courage}`);

  assert.deepEqual([...species], ['camel'],
    `this feature spawns ${[...species].join(', ')}; the brief is a caravan, and nothing in a caravan `
    + 'may attack the player');
  /* The three independent locks the camel row carries, asserted here because a
   * caravan is where they matter: `_beginAttack` has one call site and it is
   * gated on `dist <= def.reach + this.radius`, which with a negative reach can
   * never be true. @see scripts/tests/camel.test.mjs for the driven proof. */
  assert.ok(camel.reach + camel.bodyRadius < 0,
    `a camel's attack gate reads dist <= ${(camel.reach + camel.bodyRadius).toFixed(2)}, which is satisfiable`);
  assert.equal(isPredator(camel), false, 'the camel row reads as a predator');

  /* ABLATION. The same three properties on the wolf row, so "the camel cannot
   * attack" is a statement about the camel and not about the assertions. */
  assert.ok(wolf.reach + wolf.bodyRadius > 0, 'the wolf cannot reach either, so the gate above means nothing');
  assert.equal(isPredator(wolf), true, 'the wolf row does not read as a predator, so the check is vacuous');
});


/* ================================================================== */
/* 5b. Nor is it a threat, a bounty, a quest kill or a body to search  */
/* ================================================================== */

/**
 * A 2D context that remembers what colour each fill was made in.
 *
 * Everything the minimap asks for that is not recorded here is a no-op, which
 * is enough: what is under test is one predicate and the colour it chooses.
 */
function recorderCtx() {
  const grad = { addColorStop() {} };
  const real = {
    fills: [],
    fillStyle: null,
    createRadialGradient: () => grad,
    createLinearGradient: () => grad,
    createConicGradient: () => grad,
    measureText: () => ({ width: 8 }),
    getLineDash: () => [],
    fillRect() { if (typeof real.fillStyle === 'string') real.fills.push(real.fillStyle); },
    fill() { if (typeof real.fillStyle === 'string') real.fills.push(real.fillStyle); },
  };
  return new Proxy(real, {
    get: (o, k) => (k in o ? o[k] : () => undefined),
    set: (o, k, v) => { o[k] = v; return true; },
  });
}

/** An NPC as the rest of the game sees one. */
function fakeBeast(predator) {
  return {
    id: predator ? 'w1' : 'c1',
    type: 'hostile',
    isBeast: true,
    isDead: false,
    isVendor: false,
    height: 2.2,
    def: { predator },
    position: new THREE.Vector3(6, 0, 4),
  };
}

test('A CAMEL IS NOT A THREAT, A BOUNTY, A QUEST KILL OR A BODY TO SEARCH', async () => {
  /* `BeastNPC` files every animal as `type: 'hostile'` deliberately - it is
   * what buys the respawn queue, the alert propagation and the kill tracking -
   * and its own comment says the code that genuinely cares reads `isBeast` and
   * the species row. Four places cared and none of them read it, so the drop
   * put twelve red threat contacts on the desert minimap and made a 220 HP
   * animal that cannot fight back and respawns in 22 s into a contract, quest
   * and loot farm. Each of the four is asserted against a camel AND against a
   * wolf, so what is being tested is the predicate and not the guard. */
  const camel = fakeBeast(false);
  const wolf = fakeBeast(true);
  assert.equal(isPredator(beastDef('camel')), false, 'the camel row is not the non-predator here');
  assert.equal(isPredator(beastDef('wolf')), true, 'the wolf row is not the predator here');

  /* ---- 1. THE MINIMAP, which is what the player sees first -------------- */
  globalThis.Path2D ??= class { moveTo() {} lineTo() {} closePath() {} };
  const { Minimap } = await import('../../src/ui/Minimap.js');
  const paint = (npc) => {
    const ctx = recorderCtx();
    const canvas = { width: 0, height: 0, style: {}, getContext: () => ctx };
    const map = new Minimap({
      canvas,
      player: { position: new THREE.Vector3(0, 0, 0), yaw: 0 },
      worldManager: null,
      npcManager: { npcs: [npc] },
      portals: null,
    });
    map.update(1 / 60, 0);
    return ctx.fills.filter((c) => c === HOSTILE_RED).length;
  };
  const camelDiamonds = paint(camel);
  const wolfDiamonds = paint(wolf);
  console.log('\n  the same body, drawn on the minimap:');
  console.log(`    camel -> hostile diamonds  ${i5(camelDiamonds)}`);
  console.log(`    wolf  -> hostile diamonds  ${i5(wolfDiamonds)}`);
  assert.ok(wolfDiamonds > 0,
    `a wolf drew ${wolfDiamonds} threat markers - the minimap is not painting hostiles at all, so the camel `
    + 'result below means nothing');
  assert.equal(camelDiamonds, 0,
    `a camel drew ${camelDiamonds} glowing ${HOSTILE_RED} threat diamonds. Measured on the desert roads: 20 live `
    + 'hostiles near the player and 12 of them camels, so the map read as an ambush where there was a herd');

  /* ---- 2. CONTRACTS: "clear N hostiles" ---------------------------------- */
  const { Contracts } = await import('../../src/systems/Contracts.js');
  const bounty = (npc) => {
    const c = Object.create(Contracts.prototype);
    c.list = [{ state: 'active', kind: 'bounty', have: 0, need: 5 }];
    c._announce = () => {};
    c._onKill({ npc });
    return c.list[0].have;
  };
  console.log(`    camel -> bounty progress   ${i5(bounty(camel))}`);
  console.log(`    wolf  -> bounty progress   ${i5(bounty(wolf))}`);
  assert.equal(bounty(wolf), 1, 'a wolf kill does not advance a bounty, so the camel result means nothing');
  assert.equal(bounty(camel), 0,
    'a camel kill advances "Clear N hostiles from Sunspire Citadel". A camel has 220 HP, cannot fight back '
    + 'by three independent locks and respawns 22 s later, so any wayside well is an unbounded bounty farm');

  /* ---- 3. QUEST STEPS: an untargeted "kill N" ---------------------------- */
  const { QuestSystem } = await import('../../src/systems/QuestSystem.js');
  const questKills = (npc) => {
    const q = Object.create(QuestSystem.prototype);
    let n = 0;
    q._advanceSteps = () => { n++; };
    q._onKill({ npc });
    return n;
  };
  console.log(`    camel -> quest step passes ${i5(questKills(camel))}`);
  console.log(`    wolf  -> quest step passes ${i5(questKills(wolf))}`);
  assert.ok(questKills(wolf) > 0, 'a wolf kill advances no quest step, so the camel result means nothing');
  assert.equal(questKills(camel), 0,
    '`_matchesStepTarget` returns true for a step with no target at all, so an untargeted "kill N" step '
    + 'advanced on the camels');

  /* ---- 4. LOOT: the garrison's drop table -------------------------------- */
  const { Loot } = await import('../../src/systems/Loot.js');
  const drops = (npc) => {
    const l = Object.create(Loot.prototype);
    let n = 0;
    l._dropFor = () => { n++; };
    l._onNPCKilled({ npc, byPlayer: true });
    return n;
  };
  console.log(`    camel -> loot drops        ${i5(drops(camel))}`);
  console.log(`    wolf  -> loot drops        ${i5(drops(wolf))}`);
  assert.equal(drops(wolf), 1, 'a wolf drops nothing either, so the camel result means nothing');
  assert.equal(drops(camel), 0,
    "a camel drops off the citadel GARRISON's table - 2-6 crown coins at 0.44 and 6-16 broadhead arrows at "
    + '0.66, plus guaranteed credits - which with a 22 s respawn is a coin and arrow farm as well as being '
    + 'six to sixteen arrows carried by a camel');
});

/* ================================================================== */
/* 6. The budget                                                       */
/* ================================================================== */

test('THE BUDGET: what the traffic costs, before and after', async () => {
  const { world, physics } = await built();
  const t = world.traffic;
  assert.ok(t, 'the world built no traffic report');

  /* `districtStats` and not a traverse of my own, and the difference matters:
   * it skips anything with `frustumCulled === false` - the sky dome rides with
   * the camera and is 900 m across - and it reports instanced fields
   * separately, because a palm field's sphere is a different kind of claim
   * from a district's. This is the same call `citadel-budgets.test.mjs` makes,
   * so the two files cannot disagree about what the worst mesh is. */
  world.group.updateMatrixWorld(true);
  const stats = districtStats(world.group, MAX_DISTRICT_RADIUS);
  const meshes = stats.meshes;
  const triangles = stats.triangles;
  const worstSphere = stats.worstRadius;
  const worstField = stats.instanced.reduce((m, x) => Math.max(m, x.radius), 0);

  const oasisColliders = t.oases.reduce((n, o) => n + o.colliders, 0);
  const wellColliders = t.wells.reduce((n, w) => n + w.colliders, 0);
  const added = oasisColliders + wellColliders;

  /* The BEFORE column by subtraction from the world as it stands, never from a
   * number remembered off an older build: every mesh this drop emitted is named
   * `oasis:*` or `wells*`, and every collider it registered is in
   * `traffic.colliders`, so the delta is measured rather than quoted. */
  let ownMeshes = 0;
  let ownTriangles = 0;
  world.group.traverse((o) => {
    if (!o.isMesh || !/^(oasis:|wells)/.test(o.name ?? '')) return;
    ownMeshes++;
    const g = o.geometry;
    ownTriangles += ((g.index ? g.index.count : g.attributes.position.count) / 3)
      * (o.isInstancedMesh ? o.count : 1);
  });
  const row = (label, before, after) => console.log(
    `    ${label.padEnd(22)}${String(before).padStart(9)}${String(after).padStart(11)}${String(after - before).padStart(11)}`
  );
  console.log('\n  the citadel before this drop, and after it (delta measured, not remembered):');
  console.log('                             before      after      delta');
  row('colliders', physics.colliders.length - added, physics.colliders.length);
  row('triangles', triangles - ownTriangles, triangles);
  row('scene meshes', meshes - ownMeshes, meshes);
  console.log(`    worst mesh sphere, m              ${String(worstSphere.toFixed(1)).padStart(11)}   ceiling ${MAX_DISTRICT_RADIUS}`);
  console.log(`    worst instanced sphere, m         ${String(worstField.toFixed(1)).padStart(11)}   ceiling ${MAX_DISTRICT_RADIUS}`);
  console.log(`    triangles per draw call           ${String(Math.round(triangles / meshes)).padStart(11)}   floor 1733 (medieval)`);
  console.log('  and where it went:');
  for (const o of t.oases) {
    console.log(`    oasis ${o.id.padEnd(14)} ${String(o.colliders).padStart(4)} colliders  ${String(o.triangles).padStart(6)} tri  `
      + `${o.draws} draws  ${f(o.ms, 1)} ms  relief ${f(o.relief, 3)} m  lift ${f(o.lift, 2)} m`);
  }
  console.log(`    ${t.wells.length} wells         ${String(wellColliders).padStart(4)} colliders  `
    + `${t.wells.reduce((n, w) => n + w.boxes, 0)} boxes into the world's own material buckets`);
  console.log(`    roster                  ${t.roster} entries, ${t.declaredAnimals} animals, none of it resident until the player is near it`);

  /* C4's own ceiling, restated here because this drop is what moves it. */
  assert.ok(physics.colliders.length <= 20000,
    `${physics.colliders.length} colliders against the C4 budget of 20,000`);
  /* C3. A mesh with a sphere over the ceiling is a mesh the frustum can never
   * reject, and eight wells spread over 900 m in one batch would be exactly
   * that if `_splitDistricts` were not doing its job. */
  assert.ok(worstSphere < MAX_DISTRICT_RADIUS,
    `worst mesh sphere is ${worstSphere.toFixed(1)} m against the ${MAX_DISTRICT_RADIUS} m ceiling`);

  /* Both oases have to have been BUILT. A refusal is legal - the kit returns a
   * reason rather than throwing - but it is a finding, and the player asked for
   * "1 or 2 oasis areas" so zero of them is not a placement. */
  assert.equal(t.refusedOases.length, 0,
    `oases refused: ${t.refusedOases.map((r) => `${r.id} (${r.reason})`).join('; ')}`);
  assert.equal(t.oases.length, 2, `${t.oases.length} oases built, the brief asked for 1 or 2`);
  assert.equal(t.wells.length, WELL_SITES.length,
    `${t.wells.length} of ${WELL_SITES.length} wayside wells were built`);

  /* And the roster is the point of the whole design: 109 animals declared and a
   * live cap of twelve. At the manager's own measured 30-50 us per character
   * per frame, twelve animals is 0.36-0.60 ms - and a flat roster of 109 would
   * be 3.3-5.5 ms against a 5.5 ms frame. */
  assert.ok(world._population.maxLiveBeasts <= 14,
    `the live animal cap is ${world._population.maxLiveBeasts}, over NPCManager's own BEAST_CEILING of 14`);
  assert.ok(t.declaredAnimals / world._population.maxLiveBeasts >= 5,
    `only ${(t.declaredAnimals / world._population.maxLiveBeasts).toFixed(1)}x more animals are declared than can `
    + 'be live at once - if the roster is that close to the cap there is no reason to be streaming at all');

  /* THE WHOLE STREAMED CAST, NOT HALF OF IT.
   *
   * `maxLiveBeasts` carries a frame-time justification in its own docstring;
   * `maxLive` carried only a head count, and the only gate on it was
   * `maxPeople <= pop.maxLive` in the streaming case above, which the code
   * enforces and is therefore a tautology rather than a bound. Driven on the
   * real 33-entry roster the human cap does bind - it pins at 10 for the last
   * third of a walk down the mesa road - so the humans are a real and unpriced
   * third of the cost.
   *
   * The ceiling is derived here rather than declared: the frame this world
   * runs at is 5.5 ms (150 fps, measured), and the streamed traffic is allowed
   * a quarter of it. At the project's own upper bound of 50 us a character
   * that is 27 bodies. Both caps are asserted against the SUM so neither can
   * be raised without the other one noticing. */
  const FRAME_MS = 5.5;
  const US_PER_BODY = 50;
  const SHARE = 0.25;
  const streamed = world._population.maxLive + world._population.maxLiveBeasts;
  const worstMs = (streamed * US_PER_BODY) / 1000;
  const ceilingBodies = Math.floor((FRAME_MS * SHARE * 1000) / US_PER_BODY);
  console.log(`    streamed cast, worst case  ${world._population.maxLive} humans + ${world._population.maxLiveBeasts} animals = `
    + `${streamed} bodies, ${f(worstMs, 2)} ms of a ${FRAME_MS} ms frame  (ceiling ${ceilingBodies} bodies)`);
  assert.ok(streamed <= ceilingBodies,
    `the streamed cast is ${streamed} bodies - ${world._population.maxLive} humans and `
    + `${world._population.maxLiveBeasts} animals - which is ${worstMs.toFixed(2)} ms of a ${FRAME_MS} ms frame at `
    + `${US_PER_BODY} us a character, over the ${SHARE * 100}% of the frame this feature is allowed. The animal `
    + 'cap is priced in its own docstring and the human cap was not; both have to be paid for out of the '
    + 'same frame');
});

test('THE FRAME COST: advancing nine caravans every frame is free', async () => {
  const { world } = await built();
  const mgr = new StubManager();
  const pop = trafficRig(world, mgr, { maxLiveBeasts: 12, maxLive: 10 });

  /* Stand on a caravan so the expensive path - a full sync with twelve animals
   * resident - is the one being timed, then hold still, which is what the
   * throttle exists for and the common case in play. */
  const at = new THREE.Vector3();
  pop.headOf(pop.trains[0], at);
  pop.sync(at.x, at.z);
  const resident = pop.liveBeastCount();

  const N = 60 * 600;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) pop.update(at.x, at.z, 1 / 60);
  const ms = performance.now() - t0;
  const us = (ms * 1000) / N;
  const syncs = pop.stats.syncs;

  /* ═══════════════════════════════════════════════════════════════════════
   *  COUNTED, NOT TIMED - THE SECOND FLAKE IN THIS SUITE, FOUND THE SAME WAY
   * ═══════════════════════════════════════════════════════════════════════
   *
   * This asserted `us < 30` on a wall-clock window, and it is one of the
   * eleven wall-clock assertions the note in `citadel-caves.test.mjs` counted.
   * Measured on this machine, 24 logical cores:
   *
   *     idle          3.67 us/frame against a 30 us ceiling  (8.2x margin)
   *     32 burners    RED 1 of 8 runs of this file
   *
   * An 8x margin and it still went, which is the point: contention here
   * inflated the number by more than eight times, and a ceiling that survived
   * that would have to be about 250 us - past the 30-50 us a single resident
   * character costs, which is the whole comparison the gate is making. A time
   * ceiling here cannot be both safe and meaningful. Same conclusion, same
   * remedy, and the fourth file in this repo to reach it: `citadel-caves`,
   * `citadel-budgets`, `physics-remove` and `npc-budget` (whose
   * `_separateBodies` gate was the OTHER half of Phase 12's red run).
   *
   * ── WHAT IS COUNTED, AND WHY IT IS THE WHOLE COST ──────────────────────
   *
   * A frame of `CitadelTraffic.update` does exactly two things that scale: it
   * projects each drover onto his own road to test the leash
   * (`projectOnRoad`, which walks that road's points), and every 0.4 s it runs
   * a full `sync`, which walks them again. Both land on `road.points`, so
   * counting index reads on those arrays counts both - exactly, on every
   * machine, in one number.
   *
   * Measured on the built world (3 roads of 11/13/15 points, 9 trains, 4 with
   * a live drover): 20,780 reads over 240 frames carrying 10 syncs, and
   * 2,078 over the next 24 frames carrying 1. 86.58 reads per frame.
   *
   * `road.arcs` is deliberately NOT wrapped: it is a `Float64Array` and a
   * Proxy over a TypedArray breaks `.length` (`Method get
   * TypedArray.prototype.length called on incompatible receiver`). `points` is
   * a plain array and every walk touches both, so one is enough to count them.
   *
   * ── THE CEILING, CONVERTED FROM THE ONE THE DESIGN ACTUALLY MAKES ──────
   *
   * The claim is unchanged: the bookkeeping for every caravan in the world
   * must cost less than ONE of the animals it is bookkeeping for, which the
   * manager's own ablation prices at 30-50 us. The conversion is measured:
   * 3.67 us buys 86.58 reads, so 42 ns a read, so 30 us is 708 reads. 700 is
   * that, and it preserves the 8.1x margin the time ceiling had.
   *
   *   achieved   105.49 reads per frame, over the 2,400 frames counted below,
   *              identical on two runs
   *   ceiling    700  (= the 30 us a resident character costs)
   *
   * ── ABLATION, BOTH WAYS ────────────────────────────────────────────────
   * Nine extra `_leashed` projections per train per frame - a per-body leash
   * test where a per-train one belongs - reads 1,032.58 a frame and fails
   * this. Removing the 0.4 s throttle so `sync` runs every frame reads only
   * 164.83 and does NOT: like the time ceiling it replaces, this is a
   * generous order-of-magnitude gate rather than a 20% one, and the throttle
   * regression is the sync COUNT below, which caught that ablation at
   * 36,001 syncs in 36,000 frames. Two gates, two failure modes, and neither
   * of them is a clock.
   *
   * The microseconds are still measured and still printed. They are just not
   * asserted, exactly as `citadel-caves.test.mjs` prints its cave milliseconds.
   */
  const M = 2400;
  let reads = 0;
  const roads = new Set();
  for (const t of pop.trains) {
    if (roads.has(t.road)) continue;
    roads.add(t.road);
    t.road.points = new Proxy(t.road.points, {
      get(target, key, recv) {
        if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) reads++;
        return Reflect.get(target, key, recv);
      },
    });
  }
  const syncsBefore = pop.stats.syncs;
  for (let i = 0; i < M; i++) pop.update(at.x, at.z, 1 / 60);
  const perFrame = reads / M;

  console.log('\n  ten minutes of frames with a caravan standing on the player:');
  console.log(`    animals resident                     ${i5(resident)}`);
  console.log(`    per frame, whole update              ${f(us, 3)} us   - printed, not asserted`);
  console.log(`    syncs run in ${N} frames         ${i5(syncs)}  (throttle is 0.4 s or 8 m)`);
  console.log(`    road points read per frame           ${f(perFrame, 2)}  over ${M} more frames`
    + ` carrying ${pop.stats.syncs - syncsBefore} syncs`);

  assert.ok(perFrame <= 700,
    `the whole traffic update reads ${perFrame.toFixed(1)} road points a frame, which converts to more `
    + 'than the 30-50 us a single resident character costs - the bookkeeping is more expensive than the '
    + 'content it is bookkeeping for');
  /* And the throttle really is throttling: 36,000 frames of standing still is
   * 600 s, so 1,500 syncs at 0.4 s. */
  assert.ok(syncs < N / 20,
    `${syncs} syncs in ${N} frames - the 0.4 s throttle is not holding, so the sort and the want lists `
    + 'are running every frame');
});
