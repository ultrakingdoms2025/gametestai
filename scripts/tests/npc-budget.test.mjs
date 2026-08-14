import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as THREE from 'three';

import { NPCManager } from '../../src/npc/NPCManager.js';
import { Navigation } from '../../src/npc/Navigation.js';
import { MedievalWorld } from '../../src/worlds/MedievalWorld.js';
import { PLOTS, SETTLEMENTS } from '../../src/worlds/medieval/Settlements.js';
import { FRIENDLY_BUDGET, HOSTILE_BUDGET, BEAST_BUDGET } from '../../src/worlds/medieval/Inhabitants.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

/**
 * THE NPC BUDGET, AND THE MEASUREMENTS BEHIND IT.
 *
 * The vale grew from 400 m to 900 m and from one settlement to fourteen, and
 * the character budget did not move: `NPCManager.maxNPCs` is 72. The decision
 * taken was NOT to raise it but to stream by distance, and a decision like that
 * is worth nothing unless the numbers behind it are reproducible - so they are
 * reproduced here rather than written into a commit message.
 *
 * Two kinds of test, and they are deliberately different in strength:
 *
 *   SCALING gates are best-of-N with `hrtime`, asserting a RATIO or a generous
 *   ceiling rather than an absolute time, because "noise only ever adds time,
 *   so the minimum is the closest single statistic to the true per-call cost".
 *   They catch an accidental O(n^3), not a 20% regression.
 *
 *   This used to cite `physics-remove.test.mjs` as the source of that idiom.
 *   That file has since ABANDONED it: its ratio gate failed in a full-suite
 *   run while passing 3/3 in isolation, because the two halves of a ratio are
 *   timed in different contention windows and a lucky small paired with an
 *   unlucky large clears the threshold with nothing wrong. It counts scanned
 *   array entries now. The gates here carry the same exposure - the ratios at
 *   least share a window, but `at200 < 200` is an absolute wall-clock ceiling
 *   and is the one that will go first. If any of them flakes, count work
 *   rather than widening the threshold.
 *
 *   GEOMETRY gates are exact. How much of a flat roster is beyond render range
 *   is arithmetic, not timing, and it is the number the whole decision rests on.
 */

const DT = 1 / 60;

/** The `npc-sim-lod.test.mjs` stub, plus what `_separateBodies` reads. */
function stubNPC(x, z, seed = 0) {
  return {
    seed,
    position: new THREE.Vector3(x, 0, z),
    height: 1.8,
    root: { visible: true },
    animator: { sunk: false },
    humanoid: { mesh: { castShadow: true }, hairMesh: null },
    lod: { distance: 0, ik: true, detail: true, rate: 1, visible: true, shadow: true, sim: 1 },
    _simAccum: 0,
    _simPhase: seed & 7,
    isDead: false,
    seat: null,
    personalSpace: undefined,
    velocity: new THREE.Vector3(),
    fixedUpdate() {},
  };
}

/** Minimum of `reps` runs. See the note above on why the minimum. */
function best(fn, reps = 5) {
  let m = Infinity;
  for (let r = 0; r < reps; r++) {
    const t = process.hrtime.bigint();
    fn();
    const d = Number(process.hrtime.bigint() - t) / 1e6;
    if (d < m) m = d;
  }
  return m;
}

/* ------------------------------------------------------------------ */
/* What the sweeps actually cost                                       */
/* ------------------------------------------------------------------ */

test('_separateBodies is quadratic, and still trivial at three times the budget', () => {
  /* Recorded here because it is the cost everyone assumes is the reason, and
   * it is not. Measured on this machine, crowd packed into a 40 m square:
   *     n= 24  0.8 us/step      n=100  11.9 us/step
   *     n= 44  2.5 us/step      n=140  24.1 us/step
   *     n= 72  6.3 us/step      n=200  55.6 us/step
   * 55.6 us per fixed step at 200 characters is 3.3 ms per SECOND of wall
   * clock, i.e. 0.06 ms per frame. */
  const run = (n) => {
    const npcs = [];
    for (let i = 0; i < n; i++) npcs.push(stubNPC((i % 10) * 4 - 20, ((i / 10) | 0) * 4 - 20, i));
    const ctx = { _npcs: npcs };
    return best(() => { for (let s = 0; s < 1000; s++) NPCManager.prototype._separateBodies.call(ctx); });
  };
  const at72 = run(72);
  const at200 = run(200);
  // Quadratic: 200 is 7.7x the pairs of 72. Anything worse than 15x is a new
  // term in the loop, not noise.
  assert.ok(at200 / Math.max(at72, 1e-6) < 15,
    `_separateBodies went from ${at72.toFixed(2)} ms to ${at200.toFixed(2)} ms - worse than quadratic`);
  // The absolute claim, generously: 1000 steps of 200 characters under 200 ms.
  assert.ok(at200 < 200, `${at200.toFixed(1)} ms for 1000 steps at n=200`);
});

test('_updateLOD is linear and free at any budget under consideration', () => {
  const run = (n) => {
    const npcs = [];
    for (let i = 0; i < n; i++) npcs.push(stubNPC((i * 137) % 900 - 450, (i * 211) % 900 - 450, i));
    const ctx = { _npcs: npcs, engine: null, player: { position: new THREE.Vector3(0, 0, 0) } };
    return best(() => { for (let s = 0; s < 1000; s++) NPCManager.prototype._updateLOD.call(ctx); });
  };
  const at24 = run(24);
  const at200 = run(200);
  // Linear in n: 8.3x the characters must not cost more than 20x.
  assert.ok(at200 / Math.max(at24, 1e-6) < 20,
    `_updateLOD is superlinear: ${at24.toFixed(2)} -> ${at200.toFixed(2)} ms`);
});

test("Navigation's neighbour separation walks the WHOLE population, and it is nanoseconds", () => {
  /* `NPC._steer` passes `manager.npcs` entire into `Navigation.update`, so the
   * steering separation is a second O(n^2) that the `_separateBodies`
   * docstrings do not account for. Measured at about 3 ns per neighbour:
   *     n=24 0.161 us · n=72 0.311 us · n=200 0.759 us per agent-step. */
  const physics = { raycast: () => null, groundHeight: () => 0, containsPoint: () => false };
  const run = (n) => {
    const npcs = [];
    for (let i = 0; i < n; i++) npcs.push(stubNPC((i % 12) * 2.5 - 15, ((i / 12) | 0) * 2.5 - 15, i));
    const nav = new Navigation({ physics });
    nav.target.set(30, 0, 30);
    nav.hasTarget = true;
    const pos = new THREE.Vector3(0, 0, 0);
    const fwd = new THREE.Vector3(0, 0, -1);
    return best(() => { for (let s = 0; s < 20000; s++) nav.update(DT, pos, 3, fwd, npcs); });
  };
  const at24 = run(24);
  const at200 = run(200);
  assert.ok(at200 > at24, 'the neighbour loop is being optimised away; the measurement is meaningless');
  // Per agent-step at 200 neighbours, in microseconds. Generous ceiling.
  assert.ok((at200 * 1000) / 20000 < 5,
    `${((at200 * 1000) / 20000).toFixed(2)} us per agent-step at 200 neighbours`);
});

/* ------------------------------------------------------------------ */
/* The number the decision rests on                                    */
/* ------------------------------------------------------------------ */

/** The vale, built as far as it can be built without a renderer. */
function valeWithPopulation() {
  const w = new MedievalWorld({});
  w._buildRoadPaths();
  for (const p of PLOTS) {
    w._footprints.push({ x: p[0], z: p[1], hx: p[3] / 2 + 1.4, hz: p[4] / 2 + 1.4, r: p[2] });
  }
  w.enterables = [];
  w._buildInhabitants();
  return w;
}

const vale = valeWithPopulation();

test('THE MEASUREMENT: most of a flat roster would be beyond the range it is drawn at', () => {
  const src = read('src/npc/NPCManager.js');
  const RENDER_OUT = Number(/const RENDER_OUT = (\d+);/.exec(src)?.[1]);
  assert.equal(RENDER_OUT, 135, 'the render band moved; this measurement is about that number');

  const res = vale._population;
  /* A wolf site is a pack, so a flat roster costs four bodies for one spec.
   * Counting sites would flatter the streamed version. */
  const bodies = [
    ...res.people.map((e) => e.spec.position),
    ...res.beasts.flatMap((e) => Array(4).fill(e.spec.position)),
  ];
  assert.ok(bodies.length > 60, `only ${bodies.length} bodies planned`);

  /* Sampled where a player actually stands: the spawn, every settlement centre
   * and the midpoint of every arterial road. */
  const spots = [
    { x: vale.playerSpawn.x, z: vale.playerSpawn.z },
    ...SETTLEMENTS.map((s) => ({ x: s.centre.x, z: s.centre.z })),
    ...(vale._roadPaths ?? []).map((r) => {
      const p = r.pts[(r.pts.length / 2) | 0];
      return { x: p[0], z: p[1] };
    }),
  ];
  let far = 0;
  let all = 0;
  let peak = 0;
  for (const s of spots) {
    for (const p of bodies) {
      const d = Math.hypot(p.x - s.x, p.z - s.z);
      all++;
      if (d >= RENDER_OUT) far++;
    }
    peak = Math.max(peak, bodies.filter((p) => Math.hypot(p.x - s.x, p.z - s.z) < res.spawnRadius).length);
  }
  const share = far / all;
  assert.ok(share > 0.6,
    `only ${(share * 100).toFixed(1)}% of a flat roster is beyond ${RENDER_OUT} m - `
    + 'streaming is not buying what it claims to buy');

  /* And the other half of the argument: the streamed live cast has to be able
   * to cover the busiest place a player can stand. */
  assert.ok(peak > res.maxLive * 0.7,
    `peak demand is only ${peak} bodies against a cap of ${res.maxLive} - the cap is oversized`);
});

test('a flat roster does not fit in the ceiling at all, so "raise the cap" is a doubling', () => {
  const src = read('src/npc/NPCManager.js');
  const maxNPCs = Number(/this\.maxNPCs = (\d+);/.exec(src)?.[1]);
  assert.equal(maxNPCs, 72);
  const res = vale._population;
  const flat = res.people.length + res.beasts.length * 4;
  const authored = vale.npcSpawns.length;
  assert.ok(flat + authored > maxNPCs,
    `flat roster ${flat} + authored ${authored} fits inside ${maxNPCs}; streaming may be unnecessary`);
});

/* ------------------------------------------------------------------ */
/* The budget arithmetic holds                                         */
/* ------------------------------------------------------------------ */

test('the vale publishes budgets, and their worst case fits inside maxNPCs', () => {
  assert.equal(vale.hostileBudget, HOSTILE_BUDGET);
  assert.equal(vale.friendlyBudget, FRIENDLY_BUDGET);
  assert.equal(vale.beastBudget, BEAST_BUDGET);

  const src = read('src/npc/NPCManager.js');
  const maxNPCs = Number(/this\.maxNPCs = (\d+);/.exec(src)?.[1]);
  const beastCeiling = Number(/const BEAST_CEILING = (\d+);/.exec(src)?.[1]);
  const hostileCeiling = Number(/const HOSTILE_CEILING = (\d+);/.exec(src)?.[1]);
  const crowdReserve = Number(/const CROWD_RESERVE = crowdAllowed \? (\d+)/.exec(src)?.[1]);
  assert.ok(Number.isFinite(maxNPCs) && Number.isFinite(beastCeiling));

  const res = vale._population;
  /* Everything `spawnForWorld` builds, plus everything the streamer may add.
   *   friendlyBudget   caps the authored friendlies AND the hub crowd together
   *   hostileBudget    the bandit patrols
   *   maxLive          streamed civilians
   *   maxLiveBeasts    streamed animals
   * The questmaster is spawned outside the friendly count, so it is one more. */
  const worst = FRIENDLY_BUDGET + 1 + HOSTILE_BUDGET + res.maxLive + res.maxLiveBeasts;
  assert.ok(worst <= maxNPCs,
    `worst case ${worst} exceeds maxNPCs ${maxNPCs}: `
    + `friendly ${FRIENDLY_BUDGET} + questmaster + hostile ${HOSTILE_BUDGET} `
    + `+ streamed ${res.maxLive} + beasts ${res.maxLiveBeasts}`);
  // And with room left for whatever a merge adds.
  assert.ok(maxNPCs - worst >= 5, `only ${maxNPCs - worst} slots spare for a merge`);

  assert.ok(HOSTILE_BUDGET <= hostileCeiling);
  assert.ok(res.maxLiveBeasts <= beastCeiling,
    'the streamed beast cap is above the engine\'s own ceiling');
  assert.ok(FRIENDLY_BUDGET > crowdReserve,
    'the friendly budget is below the crowd reserve; the authored cast would be squeezed out');
});

test('the crowd filler still gets enough slots to make the market square read', () => {
  /* `spawnForWorld`: authoredCap = min(authored, friendlyBudget - CROWD_RESERVE),
   * then `_populateHubs` is handed `friendlyBudget - friendlyCount`. With 12
   * authored plus a lorekeeper that is what is left for the square. */
  const authored = vale.npcSpawns.filter((s) => s.type !== 'hostile' && s.type !== 'beast').length;
  const crowd = FRIENDLY_BUDGET - (authored + 1);
  assert.ok(crowd >= 6, `only ${crowd} slots left for the hub crowd`);
  assert.ok(authored >= 12, 'the hand-authored cast shrank');
});

test('the vale still authors exactly the hostiles it has routes for', () => {
  const hostiles = vale.npcSpawns.filter((s) => s.type === 'hostile');
  assert.equal(hostiles.length, HOSTILE_BUDGET,
    'the bandit routes and the hostile budget have drifted apart');
  for (const h of hostiles) assert.ok(h.patrol?.length >= 3, 'a bandit has no route');
});

test('no beast is authored into npcSpawns - every one of them streams', () => {
  assert.equal(vale.npcSpawns.filter((s) => s.type === 'beast').length, 0);
  assert.equal(vale.beastBudget, 0);
  assert.ok(vale._population.beasts.length > 0, 'the vale has no wildlife at all');
});

/* ------------------------------------------------------------------ */
/* Streamed characters are not second-class                            */
/* ------------------------------------------------------------------ */

test('spawnOne carries the dressing that makes a merchant a merchant', () => {
  /* Without this a streamed vendor opens the whole catalogue, its stall is
   * unlettered, and a streamed reeve has no quest board - all silently. */
  const src = read('src/npc/NPCManager.js');
  const body = /spawnOne\(spec\) \{[\s\S]*?\n  \}/.exec(src)?.[0] ?? '';
  for (const field of ['signLines', 'vendorCategories', 'vendorTitle', 'isQuestManager']) {
    assert.ok(body.includes(field), `spawnOne drops "${field}" on the floor`);
  }
  assert.ok(body.includes("spec.type === 'hostile'"),
    'spawnOne now accepts hostiles; the residency assumes it does not');
});

test('every streamed spec is the shape spawnOne reads', () => {
  for (const e of vale._population.people) {
    const s = e.spec;
    assert.ok(s.position instanceof THREE.Vector3, 'a spec has no position vector');
    assert.equal(s.type, 'friendly');
    assert.ok(typeof s.name === 'string' && s.name.length > 0);
    assert.ok(typeof s.persona === 'string' && s.persona.length > 40, `${s.name} has a thin persona`);
    assert.ok(typeof s.role === 'string');
    assert.ok(Number.isFinite(s.yaw));
    for (const p of s.patrol ?? []) assert.ok(p instanceof THREE.Vector3);
    if (s.vendorCategories) assert.ok(Array.isArray(s.vendorCategories) && s.vendorCategories.length);
  }
  for (const e of vale._population.beasts) {
    assert.ok(e.spec.position instanceof THREE.Vector3);
    assert.ok(['wolf', 'bear'].includes(e.spec.species));
  }
});

/* ------------------------------------------------------------------ */
/* The world integration                                               */
/* ------------------------------------------------------------------ */

test('nobody the world plans stands inside a building or on a road', () => {
  /* Asked of the WORLD's own tests, not of a re-derivation: `_isOpenGround`
   * is what the vegetation scatter uses, so a civilian stands exactly where
   * the world was already willing to grow a bush. Travellers are exempt from
   * the road rule and only from that one - being on the verge is their job. */
  for (const e of vale._population.people) {
    const p = e.spec.position;
    assert.equal(vale._inFootprint(p.x, p.z, 0.4), false,
      `${e.spec.name} stands inside a building at ${p.x | 0},${p.z | 0}`);
    assert.ok(vale._inPlayfield(p.x, p.z, 4), `${e.spec.name} is off the playfield`);
    if (e.spec.role !== 'wanderer' || e.spec.settlement) {
      assert.ok(vale._isOpenGround(p.x, p.z, 0.6),
        `${e.spec.name} at ${p.x | 0},${p.z | 0} is not on open ground`);
    }
  }
});

test('every planned character stands on the world\'s own ground height', () => {
  for (const e of vale._population.people) {
    const p = e.spec.position;
    assert.ok(Math.abs(p.y - vale._height(p.x, p.z)) < 1e-9,
      `${e.spec.name} is ${(p.y - vale._height(p.x, p.z)).toFixed(2)} m off the ground`);
  }
  for (const e of vale._population.beasts) {
    const p = e.spec.position;
    assert.ok(Math.abs(p.y - vale._height(p.x, p.z)) < 1e-9, 'a pack home is off the ground');
  }
});

test('no beast site is on a road the world actually built', () => {
  /* `_roadDist` reads the real spline network, including any road a later
   * branch adds - which is the point. The clearance is checked against the
   * species reach, not a constant. */
  for (const e of vale._population.beasts) {
    const p = e.spec.position;
    assert.ok(vale._roadDist(p.x, p.z) > e.spec.territory,
      `a ${e.spec.species} can roam onto a road (${vale._roadDist(p.x, p.z).toFixed(0)} m away, `
      + `territory ${e.spec.territory})`);
  }
});

test('the vale publishes its treasure to the hooks the systems already read', () => {
  assert.ok(Array.isArray(vale._roofs) && vale._roofs.length > 60,
    `_roofs holds ${vale._roofs?.length ?? 0} sites; Relics has nothing authored to use`);
  for (const r of vale._roofs) {
    assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z));
    assert.ok(Math.abs(r.y - vale._height(r.x, r.z)) < 1e-9, 'an authored relic is off the ground');
  }
  const spots = vale.enterables.reduce((n, e) => n + (e.collectibleSpots?.length ?? 0), 0);
  assert.ok(spots >= 12, `only ${spots} streamed collectable spots were added`);
  for (const e of vale.enterables) {
    assert.ok(typeof e.label === 'string' && e.label.length, 'an enterable has no label to tag with');
    assert.ok(Array.isArray(e.doors), 'Interiors iterates e.doors; it must be an array or absent');
  }
});

test('the residency is registered for teardown, so a world swap releases its cast', () => {
  assert.ok(vale._owned.includes(vale._population),
    'the residency is not in _owned; its characters would outlive the world');
  assert.equal(typeof vale._population.dispose, 'function');
});

test('same seed, same world population - twice over', () => {
  const a = valeWithPopulation();
  const b = valeWithPopulation();
  const key = (w) => w._population.people
    .map((e) => `${e.spec.name}|${e.spec.position.x.toFixed(4)}|${e.spec.position.z.toFixed(4)}`).join('\n');
  assert.equal(key(a), key(b));
  const bkey = (w) => w._population.beasts
    .map((e) => `${e.spec.species}|${e.spec.position.x.toFixed(4)}|${e.spec.position.z.toFixed(4)}`).join('\n');
  assert.equal(bkey(a), bkey(b));
  assert.deepEqual(a._roofs, b._roofs);
  assert.deepEqual(
    a.enterables.map((e) => e.label),
    b.enterables.map((e) => e.label),
  );
});

test('populating the vale is not a noticeable share of the build', () => {
  /* It runs once, inside `_buildGateAndSpawns`, and the build already yields
   * to the browser between steps - but a flood fill over 900 x 900 m and a
   * 3,249-point lattice search are the sort of thing that quietly becomes two
   * seconds. Generous ceiling: this catches an accidental quadratic, not a
   * 20% regression. */
  const ms = best(() => { valeWithPopulation(); }, 3);
  assert.ok(ms < 2000, `populating the vale took ${ms.toFixed(0)} ms`);
});
