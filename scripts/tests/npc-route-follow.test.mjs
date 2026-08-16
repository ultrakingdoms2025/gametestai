import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Physics } from '../../src/physics/Physics.js';
import { NPC } from '../../src/npc/NPC.js';
import { FriendlyNPC } from '../../src/npc/FriendlyNPC.js';
import { StationWorld } from '../../src/worlds/StationWorld.js';
import { LOOP_R, WALKWAY } from '../../src/worlds/station/StationKit.js';

/**
 * Do characters follow a route, or do they cut across whatever is between two
 * of its waypoints? Until this file, the second one.
 *
 * ── The defect this pins ─────────────────────────────────────────────────
 * There were two halves and both had to go.
 *
 *  1. `FriendlyNPC._pickWanderTarget` picked ONE waypoint "one or two ahead at
 *     random" and steered straight at it, having first cleared the path with
 *     `setTarget`. Skipping a waypoint means walking a line the route's author
 *     never drew, and the modular wrap at the end of an open route means the
 *     line from the far end all the way back to the start.
 *
 *  2. `Navigation._advancePath` string-pulled: it jumped to the furthest of the
 *     next three waypoints that `_clearLine` said it could see. `_clearLine` is
 *     ONE HORIZONTAL RAYCAST at hip height. It cannot see a drop, a ledge, a
 *     stairwell or a river, which are precisely the things a route exists to
 *     keep a character away from, and it reports 25 m of open air over a void
 *     as clear - which is asserted below, so that the fix is measured against a
 *     defect this suite can still demonstrate.
 *
 * Measured on the L-shaped catwalk fixture here, before: the character spent
 * 2,270 of 7,200 fixed steps below the deck, bottoming out on the floor of the
 * void 20 m down. After: zero.
 *
 * ── What this drives ─────────────────────────────────────────────────────
 * The real `Physics`, the real `Navigation` and the real `NPC.fixedUpdate`,
 * over real box colliders - the same shape of harness as
 * `npc-flight-climb.test.mjs`, and for the same reason: the interesting
 * failures are in the interaction between steering, grounding and the capsule
 * solver, and a stub of any of them would hide them.
 */

const DT = 1 / 60;

/** The one renderer-bound thing `NPC` builds in its constructor. */
const ANIMATOR_STUB = {
  setLocomotion() {}, setLookTarget() {}, setAimTarget() {}, setSeated() {},
  setPosture() {}, setGesturing() {}, setAiming() {},
  flinch() {}, die() {}, revive() {}, update() {}, beginSink() {}, sunk: false,
  crouchTarget: 0,
};
class HeadlessNPC extends NPC {
  _createAnimator() { return ANIMATOR_STUB; }
}
class HeadlessFriendly extends FriendlyNPC {
  _createAnimator() { return ANIMATOR_STUB; }
}

function spawn(Cls, physics, at, patrol = []) {
  return new Cls({
    type: 'friendly', name: 'Test', persona: '', theme: 'station',
    position: at.clone(), patrol,
    scene: new THREE.Scene(),
    physics,
    bus: { on: () => () => {}, emit() {} },
    manager: { npcs: [], friendlies: [], player: null, findSocialPartner: () => null },
    humanoid: { root: new THREE.Object3D(), height: 1.75, getHeadWorldPosition: (o) => o },
    seed: 11,
  });
}

/**
 * `NPCManager.fixedUpdate`'s sim banding, reproduced exactly.
 *
 * `lod.sim` is a divisor with banked `dt`: a demoted character is stepped on
 * every Nth frame and handed the N frames' worth of time it banked, all at
 * once. A route follower that is only correct at N = 1 is not correct.
 *
 * @param {NPC} npc
 * @param {number} every the divisor, `lod.sim`
 * @param {number} seconds of wall clock, not of steps
 * @param {(npc:NPC)=>void} [sample] called once per WALL-CLOCK frame
 */
function runBanded(npc, every, seconds, sample) {
  const frames = Math.round(seconds / DT);
  let accum = 0;
  for (let s = 1; s <= frames; s++) {
    if (every > 1) {
      accum += DT;
      if ((s % every) !== 0) { sample?.(npc); continue; }
    }
    const owed = every > 1 ? accum : accum + DT;
    accum = 0;
    npc.fixedUpdate(Math.min(owed, 0.4), s * DT);
    sample?.(npc);
  }
}

/* ------------------------------------------------------------------ */
/* Fixture: an L-shaped catwalk over a void                            */
/* ------------------------------------------------------------------ */

/**
 * Two 4 m wide arms meeting at the origin, deck top at y = 0, and a floor 20 m
 * below. Cutting the inside of the elbow is a fall, and there is NOTHING solid
 * in the way of the shortcut - which is the case a raycast line test cannot
 * answer and a route follower does not have to.
 */
function elbowWorld() {
  const physics = new Physics();
  const add = (m) => { m.updateWorldMatrix(true, false); physics.addBoxFromObject(m); };
  const armX = new THREE.Mesh(new THREE.BoxGeometry(40, 0.6, 4));
  armX.position.set(20, -0.3, 0);
  add(armX);
  const armZ = new THREE.Mesh(new THREE.BoxGeometry(4, 0.6, 40));
  armZ.position.set(0, -0.3, 20);
  add(armZ);
  const floor = new THREE.Mesh(new THREE.BoxGeometry(400, 1, 400));
  floor.position.set(0, -20.5, 0);
  add(floor);
  return physics;
}

/** Far enough back from waypoint 0 that the walk to it is a leg like any other. */
const ELBOW_START = new THREE.Vector3(38, 0, 0);
const ELBOW_ROUTE = [
  new THREE.Vector3(34, 0, 0),
  new THREE.Vector3(18, 0, 0),
  new THREE.Vector3(0, 0, 0),      // the corner
  new THREE.Vector3(0, 0, 18),
  new THREE.Vector3(0, 0, 34),
];

/** Is (x, z) over one of the two arms? The arms are 4 m wide, so +-2 m. */
const onElbowDeck = (x, z) =>
  (z >= -2 && z <= 2 && x >= -2 && x <= 40) || (x >= -2 && x <= 2 && z >= -2 && z <= 40);

/* ------------------------------------------------------------------ */
/* The headline                                                        */
/* ------------------------------------------------------------------ */

test('a route is walked in order, and the corner is not cut across the void', () => {
  const physics = elbowWorld();
  const npc = spawn(HeadlessNPC, physics, ELBOW_START);
  npc.nav.setPath(ELBOW_ROUTE);

  const seen = [];
  let offDeck = 0;
  let lowest = 0;
  runBanded(npc, 1, 60, (n) => {
    if (seen[seen.length - 1] !== n.nav.pathIndex) seen.push(n.nav.pathIndex);
    lowest = Math.min(lowest, n.position.y);
    if (!onElbowDeck(n.position.x, n.position.z)) offDeck++;
  });

  assert.deepEqual(seen, [0, 1, 2, 3, 4], 'the route was not walked waypoint by waypoint');
  assert.equal(npc.nav.arrived, true, 'it never got to the far end');
  assert.equal(offDeck, 0, `${offDeck} fixed steps spent off the catwalk`);
  assert.ok(lowest > -0.1, `it fell to y = ${lowest.toFixed(2)}`);
});

test('...and the line test that used to authorise the shortcut still says "clear"', () => {
  /* Without this the test above could pass because the shortcut happens to be
   * blocked, rather than because the follower no longer takes shortcuts. The
   * inside of the elbow is 25 m of open air and `_clearLine` cannot tell. */
  const physics = elbowWorld();
  const npc = spawn(HeadlessNPC, physics, ELBOW_ROUTE[1]);
  assert.equal(
    npc.nav._clearLine(new THREE.Vector3(18, 0, 0), new THREE.Vector3(0, 0, 18)),
    true,
    'the fixture no longer demonstrates the defect'
  );
});

test('every waypoint is actually reached, not merely passed', () => {
  const physics = elbowWorld();
  const npc = spawn(HeadlessNPC, physics, ELBOW_START);
  npc.nav.setPath(ELBOW_ROUTE);
  const closest = ELBOW_ROUTE.map(() => Infinity);
  runBanded(npc, 1, 60, (n) => {
    for (let i = 0; i < ELBOW_ROUTE.length; i++) {
      closest[i] = Math.min(closest[i], Math.hypot(
        ELBOW_ROUTE[i].x - n.position.x, ELBOW_ROUTE[i].z - n.position.z));
    }
  });
  for (let i = 0; i < closest.length; i++) {
    assert.ok(closest[i] <= npc.nav.waypointRadius + 0.05,
      `waypoint ${i} was only approached to ${closest[i].toFixed(2)} m`);
  }
});

/* ------------------------------------------------------------------ */
/* ...at every simulation rate the LOD hands out                       */
/* ------------------------------------------------------------------ */

test('the route is followed identically at lod.sim 1, 2, 4 and 8', () => {
  /* The single most likely way to get a route follower wrong. A demoted
   * character steps once every N frames with N frames of `dt` in one go, so it
   * can cover 1.5 m between two evaluations of "have I reached this waypoint".
   * A pure radius test is a BAND, and a long enough step jumps clean over a
   * band - after which the seek turns the character round and walks it back.
   * @see Navigation._reachedWaypoint for the plane test that closes it. */
  const results = [];
  for (const every of [1, 2, 4, 8]) {
    const physics = elbowWorld();
    const npc = spawn(HeadlessNPC, physics, ELBOW_START);
    npc.lod.sim = every;
    npc.nav.setPath(ELBOW_ROUTE);

    const seen = [];
    let offDeck = 0;
    let lowest = 0;
    let backwards = 0;
    let prev = 0;
    runBanded(npc, every, 60, (n) => {
      if (n.nav.pathIndex < prev) backwards++;
      prev = n.nav.pathIndex;
      if (seen[seen.length - 1] !== n.nav.pathIndex) seen.push(n.nav.pathIndex);
      lowest = Math.min(lowest, n.position.y);
      if (!onElbowDeck(n.position.x, n.position.z)) offDeck++;
    });
    results.push({ every, seen, offDeck, lowest, backwards, arrived: npc.nav.arrived });
  }

  for (const r of results) {
    assert.deepEqual(r.seen, [0, 1, 2, 3, 4],
      `lod.sim ${r.every} walked ${r.seen.join(',')} rather than the route`);
    assert.equal(r.backwards, 0, `lod.sim ${r.every} went back to an earlier waypoint`);
    assert.equal(r.offDeck, 0, `lod.sim ${r.every} spent ${r.offDeck} steps off the catwalk`);
    assert.ok(r.lowest > -0.1, `lod.sim ${r.every} fell to y = ${r.lowest.toFixed(2)}`);
    assert.equal(r.arrived, true, `lod.sim ${r.every} never finished the route`);
  }
});

test('one long step may consume more than one waypoint', () => {
  /* The reason `_advancePath` loops rather than advancing once per call. At
   * `lod.sim` 8 a running character covers 0.6 m per step and `SIM_MAX_STEP`
   * allows 0.4 s - and a route with 0.5 m legs (a route round a stall, a route
   * along a row of seats) has more than one waypoint inside that. Driven
   * directly here because no LOD band produces it reliably. */
  const physics = elbowWorld();
  const npc = spawn(HeadlessNPC, physics, new THREE.Vector3(20, 0, 0));
  const fine = [];
  for (let x = 19.5; x >= 12; x -= 0.5) fine.push(new THREE.Vector3(x, 0, 0));
  npc.nav.setPath(fine);
  npc.nav.update(DT, npc.position, 1.4, npc.forward, null);
  const before = npc.nav.pathIndex;
  // Teleport 4 m along the route, as a single 0.4 s step at run speed would.
  npc.position.set(15.6, 0, 0);
  npc.nav.update(0.4, npc.position, 4.5, npc.forward, null);
  assert.ok(npc.nav.pathIndex - before >= 7,
    `advanced ${npc.nav.pathIndex - before} waypoints over 4 m of a 0.5 m route`);
  assert.ok(npc.nav.pathIndex < fine.length, 'it ran off the end of the route');
});

test('a route that doubles back stops the advance dead at the reversal', () => {
  /* The bound on the loop above. A plane test says "past this corner"; on a
   * route that turns 180 degrees the agent standing at the previous waypoint is
   * emphatically NOT past the next one, so the loop must stop there rather than
   * unwinding the whole route in one call. */
  const physics = elbowWorld();
  const npc = spawn(HeadlessNPC, physics, new THREE.Vector3(20, 0, 0));
  npc.nav.setPath([
    new THREE.Vector3(14, 0, 0),
    new THREE.Vector3(20, 0, 0),   // back the way it came
    new THREE.Vector3(14, 0, 0),
  ]);
  npc.position.set(14, 0, 0);
  npc.nav.update(DT, npc.position, 1.4, npc.forward, null);
  assert.equal(npc.nav.pathIndex, 1, 'the reversal was unwound instead of walked');
});

/* ------------------------------------------------------------------ */
/* NPC.routeAhead - which waypoints, and which way round               */
/* ------------------------------------------------------------------ */

test('a closed round keeps going round; an open one turns around', () => {
  const physics = elbowWorld();
  const square = [
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 0, 0),
    new THREE.Vector3(10, 0, 10), new THREE.Vector3(0, 0, 10),
  ];
  const closed = spawn(HeadlessNPC, physics, square[0], square);
  // Standing on waypoint 0, three legs ahead: 1, 2, 3. Then 0, 1, 2 - it wraps,
  // because the leg from the last corner back to the first is a leg like any
  // other in a square.
  assert.deepEqual(closed.routeAhead(3).map((v) => square.findIndex((s) => s.equals(v))), [1, 2, 3]);
  closed.position.copy(square[3]);
  assert.deepEqual(closed.routeAhead(3).map((v) => square.findIndex((s) => s.equals(v))), [0, 1, 2]);

  const line = [
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 0, 0),
    new THREE.Vector3(20, 0, 0), new THREE.Vector3(30, 0, 0),
  ];
  const open = spawn(HeadlessNPC, physics, line[0], line);
  assert.deepEqual(open.routeAhead(3).map((v) => line.findIndex((s) => s.equals(v))), [1, 2, 3]);
  // At the far end it reverses rather than striking out for waypoint 0, which
  // on a line is 30 m back across everything between.
  open.position.copy(line[3]);
  assert.deepEqual(open.routeAhead(3).map((v) => line.findIndex((s) => s.equals(v))), [2, 1, 0]);
  open.position.copy(line[0]);
  assert.deepEqual(open.routeAhead(2).map((v) => line.findIndex((s) => s.equals(v))), [1, 2]);
});

test('a round is rejoined at the nearest waypoint, wherever the character ended up', () => {
  /* Rounds are interrupted constantly - a greeting, a scare, a stroll - and a
   * stored cursor that kept counting while the character stood somewhere else
   * sends it striking out across the world for a waypoint it never walked to. */
  const physics = elbowWorld();
  const square = [
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 0, 0),
    new THREE.Vector3(10, 0, 10), new THREE.Vector3(0, 0, 10),
  ];
  const npc = spawn(HeadlessNPC, physics, square[0], square);
  npc.routeAhead(3);                       // cursor is now at waypoint 3
  npc.position.set(10.4, 0, 0.3);          // ...but the character is at waypoint 1
  assert.deepEqual(npc.routeAhead(1).map((v) => square.findIndex((s) => s.equals(v))), [2]);
});

test('a one-point or empty route is not a crash', () => {
  const physics = elbowWorld();
  assert.deepEqual(spawn(HeadlessNPC, physics, new THREE.Vector3()).routeAhead(3), []);
  const one = [new THREE.Vector3(3, 0, 4)];
  assert.deepEqual(spawn(HeadlessNPC, physics, new THREE.Vector3(), one).routeAhead(3), one);
});

/* ------------------------------------------------------------------ */
/* The civilian actually uses it                                       */
/* ------------------------------------------------------------------ */

test('a civilian with a round walks it rather than cutting across the elbow', () => {
  /* The whole state machine, not just the follower: idle timers, wander
   * stints, posture, the lot. `_pickWanderTarget` used to clear the path and
   * steer at one waypoint; if it ever does again, this character goes over the
   * side. */
  const physics = elbowWorld();
  const npc = spawn(HeadlessFriendly, physics, ELBOW_START, ELBOW_ROUTE);
  let offDeck = 0;
  let lowest = 0;
  let walked = 0;
  let prev = npc.position.clone();
  runBanded(npc, 1, 180, (n) => {
    lowest = Math.min(lowest, n.position.y);
    if (!onElbowDeck(n.position.x, n.position.z)) offDeck++;
    walked += Math.hypot(n.position.x - prev.x, n.position.z - prev.z);
    prev.copy(n.position);
  });
  assert.ok(walked > 60, `only walked ${walked.toFixed(0)} m in three minutes - it is not doing its round`);
  assert.equal(offDeck, 0, `${offDeck} of 10800 steps off the catwalk`);
  assert.ok(lowest > -0.1, `it fell to y = ${lowest.toFixed(2)}`);
});

test('a civilian part-way round does not abandon it to free-roam home', () => {
  /* ── The defect this pins ──────────────────────────────────────────────
   * Found on the running station, not here. `_pickWanderTarget` rolls a 35%
   * chance of picking a free-roam destination within `homeRadius` of the SPAWN
   * point instead of continuing the round - which is fine for a villager
   * milling about outside their door, and is a decision to walk home from
   * wherever it has got to for anything on a real round. Ceri Bardo climbed
   * 5.9 m of the bearing-30 flight, rolled the 35%, and walked back down. Over
   * five minutes of the running world she never completed a circuit.
   *
   * Driven as a distribution rather than as one roll, because the old
   * behaviour was probabilistic: out of 200 re-picks from part-way round, the
   * old code took free roam about 70 times and the new code takes it none. */
  const physics = elbowWorld();
  const npc = spawn(HeadlessFriendly, physics, ELBOW_START, ELBOW_ROUTE);
  let freeRoam = 0;
  for (let i = 0; i < 200; i++) {
    // Standing at waypoint 3, which is three legs into the round.
    npc.position.copy(ELBOW_ROUTE[3]);
    npc.nav.clear();
    npc._pickWanderTarget();
    if (npc.nav.path.length === 0) freeRoam++;
  }
  assert.equal(freeRoam, 0, `${freeRoam} of 200 re-picks abandoned the round part-way`);

  // ...and back at the head of the round, free roam is still on the table.
  let atHead = 0;
  for (let i = 0; i < 200; i++) {
    npc.position.copy(ELBOW_ROUTE[0]);
    npc.nav.clear();
    npc._pickWanderTarget();
    if (npc.nav.path.length === 0) atHead++;
  }
  assert.ok(atHead > 20 && atHead < 120,
    `${atHead} of 200 picks free-roamed from the head of the round; the 35% roll is gone`);
});

/* ------------------------------------------------------------------ */
/* The station's promenade rounds are real loops now                   */
/* ------------------------------------------------------------------ */

/** The authored cast, without a renderer. `_fillSpawns` is pure arithmetic. */
function stationSpawns() {
  const w = new StationWorld({});
  w._fillSpawns();
  return w.npcSpawns;
}

test('the promenade rounds are no longer single-bearing corridors', () => {
  /* They were authored as corridors - every waypoint within two degrees of one
   * stair flight, inside the 5.4 m opening cut in the outer railing - because
   * with no route follower any straight line between two arbitrary points on a
   * 72 m ring leaves the ring. That constraint is what this whole change buys
   * back, so it is asserted as gone rather than described as gone. */
  const spawns = stationSpawns();
  const bearingSpread = (patrol) => {
    const degs = patrol.map((p) => (Math.atan2(p.z, p.x) * 180) / Math.PI);
    let lo = Infinity;
    let hi = -Infinity;
    for (const d of degs) { lo = Math.min(lo, d); hi = Math.max(hi, d); }
    return hi - lo;
  };
  const ceri = spawns.find((s) => s.name === 'Ceri Bardo');
  const osman = spawns.find((s) => s.name === 'Osman Reyes');
  assert.ok(ceri && osman, 'the promenade cast is gone');
  assert.ok(bearingSpread(ceri.patrol) > 300,
    `Ceri's round spans only ${bearingSpread(ceri.patrol).toFixed(0)} degrees of the ring`);
  assert.ok(bearingSpread(osman.patrol) > 150,
    `Osman's round spans only ${bearingSpread(osman.patrol).toFixed(0)} degrees of the ring`);
});

test('...and every leg of them stays between the promenade railings', () => {
  /* The property the corridor was a proxy for, stated directly: sample every
   * leg that runs along the deck and check the whole line is on the walkway.
   * The railings stand `RAIL_INSET` inside the deck edges, so the walkable band
   * is LOOP_R +- (WIDTH/2 - RAIL_INSET); a 0.33 m capsule needs its centre
   * clear of them by its radius. */
  const half = WALKWAY.WIDTH / 2 - WALKWAY.RAIL_INSET - 0.33;
  const spawns = stationSpawns();
  for (const name of ['Ceri Bardo', 'Osman Reyes']) {
    const patrol = spawns.find((s) => s.name === name).patrol;
    // Legs on the deck: both ends up at walkway height.
    let worst = 0;
    let legs = 0;
    for (let i = 1; i < patrol.length; i++) {
      const a = patrol[i - 1];
      const b = patrol[i];
      if (a.y < 5 || b.y < 5) continue;
      legs++;
      for (let t = 0; t <= 1.0001; t += 0.02) {
        const x = a.x + (b.x - a.x) * t;
        const z = a.z + (b.z - a.z) * t;
        worst = Math.max(worst, Math.abs(Math.hypot(x, z) - LOOP_R));
      }
    }
    assert.ok(legs >= 12, `${name} has only ${legs} legs on the deck`);
    assert.ok(worst < half,
      `${name} walks ${worst.toFixed(2)} m off the promenade centreline; the rail is at ${half.toFixed(2)}`);
  }
});

test('Ceri circles the ring and Osman walks between two flights and back', () => {
  const spawns = stationSpawns();
  const ceri = spawns.find((s) => s.name === 'Ceri Bardo').patrol;
  const osman = spawns.find((s) => s.name === 'Osman Reyes').patrol;

  /* Closed and open, as `NPC.routeAhead` measures it: a round is closed when
   * joining its ends adds no leg longer than one it already has. Ceri comes
   * back down the flight she went up, so her ends meet; Osman comes down the
   * other one, 186 m away. */
  const longestLeg = (p) => {
    let m = 0;
    for (let i = 1; i < p.length; i++) m = Math.max(m, p[i - 1].distanceTo(p[i]));
    return m;
  };
  assert.ok(ceri[0].distanceTo(ceri[ceri.length - 1]) <= longestLeg(ceri), 'Ceri\'s round is open');
  assert.ok(osman[0].distanceTo(osman[osman.length - 1]) > longestLeg(osman) * 3, 'Osman\'s round is closed');

  // Both climb: a round with no waypoint on the walkway is not a promenade round.
  for (const [name, p] of [['Ceri', ceri], ['Osman', osman]]) {
    assert.ok(p.some((v) => v.y > 9), `${name} never goes up`);
    assert.ok(p.some((v) => v.y < 1), `${name} never comes down`);
  }
  // And they use different flights.
  const flightsOf = (p) => new Set(p.filter((v) => v.y < 1)
    .map((v) => Math.round(((Math.atan2(v.z, v.x) * 180) / Math.PI + 360) % 360)));
  assert.deepEqual([...flightsOf(ceri)], [30]);
  assert.deepEqual([...flightsOf(osman)].sort((a, b) => a - b), [30, 210]);
});

/* ------------------------------------------------------------------ */
/* Cost                                                                */
/* ------------------------------------------------------------------ */

test('following a route is cheaper than string-pulling it was', () => {
  /* `_advancePath` used to spend up to three raycasts per character per step
   * on the line-of-sight skip-ahead. It now spends none: the plane test is
   * eight multiplies.
   *
   * COUNTED, NOT TIMED. This was `us < 12` on a best-of-five `hrtime`, and it
   * failed a full-suite run at 12.36 us while passing in isolation - an
   * absolute wall-clock ceiling on a 24-way parallel test runner is a
   * statement about the machine, not about the route follower. What the
   * comment above actually claims is a COUNT, so that is what is asserted:
   * the raycasts a route walk spends, per character per fixed step. The
   * grounding probe is one per character per step and is not what changed;
   * anything above that is `_advancePath` reaching for a line test again. */
  const physics = elbowWorld();
  let rays = 0;
  const realRaycast = physics.raycast.bind(physics);
  physics.raycast = (...a) => { rays++; return realRaycast(...a); };
  const manager = { npcs: [], friendlies: [], player: null, findSocialPartner: () => null };
  const npcs = [];
  for (let i = 0; i < 24; i++) {
    const n = spawn(HeadlessFriendly, physics, new THREE.Vector3(30 - i * 0.9, 0, 0), ELBOW_ROUTE);
    n.manager = manager;
    npcs.push(n);
    manager.npcs.push(n);
    manager.friendlies.push(n);
  }
  for (let s = 0; s < 600; s++) for (const n of npcs) n.fixedUpdate(DT, s * DT);

  const STEPS = 1500;
  rays = 0;
  for (let s = 0; s < STEPS; s++) for (const n of npcs) n.fixedUpdate(DT, s * DT);
  const per = rays / (STEPS * npcs.length);
  /* Measured on this fixture, and exactly reproducible run to run: 48,411
   * raycasts over 36,000 character-steps, 1.345 each. Those are the grounding
   * and step-up probes every character pays whether it is on a route or not;
   * the route walk itself adds none. The ceiling is 2, which leaves room for
   * the grounding probes to move and still rejects the string-puller this
   * replaced - three line tests per character per step would land above 4.
   *
   * TWO-SIDED, because a ceiling on a counter nobody increments is not a
   * measurement. `rays` is collected through a monkey-patch on
   * `physics.raycast`; if a character ever caches a bound reference, or the
   * grounding probe moves to a different entry point, the count silently goes
   * to zero and a route follower doing anything at all would pass. The floor is
   * 0.5 against the 1.345 the grounding probes cost. */
  assert.ok(per > 0.5,
    `only ${per.toFixed(3)} raycasts per character per fixed step (${rays} over `
    + `${STEPS * npcs.length}) - the probes are no longer going through physics.raycast, so the `
    + 'ceiling below is counting nothing');
  assert.ok(per < 2,
    `${per.toFixed(3)} raycasts per character per fixed step on a route (${rays} over `
    + `${STEPS * npcs.length} character-steps) - the route follower is casting rays again`);
});
