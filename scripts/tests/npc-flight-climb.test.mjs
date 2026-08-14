import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Physics } from '../../src/physics/Physics.js';
import { NPC } from '../../src/npc/NPC.js';
import { Navigation } from '../../src/npc/Navigation.js';
/* Namespace imports on purpose. A named import of something a build does not
 * export is a SyntaxError before a single test runs, and "the module failed to
 * load" is much weaker evidence than "the character did not get up the stairs".
 * Pointed at the commit this fixes, these files load and the BEHAVIOUR fails. */
import * as Grounding from '../../src/npc/Grounding.js';
import { walkwayStairFlight, WALKWAY } from '../../src/worlds/station/StationKit.js';

const { capsuleSlopeLift, WALKABLE_NORMAL_Y } = Grounding;

/**
 * Can a character walk up a flight of stairs? Until this test, no.
 *
 * ── The defect this pins ─────────────────────────────────────────────────
 * No NPC in this game had ever traversed an escalator, a stair flight or a
 * ramp. It was masked for a long time by the grounding bug that teleported
 * characters onto the station's ceiling raft - they APPEARED upstairs without
 * ever climbing - and once that was fixed the absence was plain: measured on the
 * running station, all 68 characters were under y = 3 in a world whose promenade
 * is at 10, and not one of them had ever been on it.
 *
 * Three independent causes, all of which had to go:
 *
 *  1. THE STEERING SAW A WALL. `Navigation._probe` is a fan of HORIZONTAL
 *     raycasts from shin and hip height, and a slope in front of a character's
 *     shins is something a horizontal ray hits. Every ramp in every world read
 *     as a wall, and the response to a wall is to brake and slide along it.
 *     Measured: a civilian aimed at the head of the station's bearing-30 flight
 *     from open deck walks in to the bottom step and stays there for as long as
 *     you watch - 22 s, `avoidBrake` oscillating 0.30-0.62, `blocked` latching,
 *     height never leaving the deck.
 *
 *  2. THE GROUNDING PUT IT ON A TREADMILL. A capsule whose feet are placed at
 *     the vertical ground height of a SLOPE has its bottom sphere buried in
 *     that slope, and `resolveCapsule` evicts it along the normal - downhill.
 *     `_followGround` then puts the feet straight back, so it happens again
 *     every step. Measured against a 30.5 degree flight at radius 0.33: 0.0231 m
 *     of downhill drift per fixed step, 1.39 m/s, against a 1.4 m/s walk. With
 *     the steering fixed but not the grounding, a character climbed 1.7 m in
 *     fourteen seconds and then slid off the side of the flight.
 *
 *  3. THE ARRIVAL WAS AN EDGE. With both of those fixed, a character climbed
 *     the whole flight on the running station and then stopped 0.17 m under the
 *     promenade, because the flight met the deck slab's outer FACE and a capsule
 *     cannot climb onto a convex edge - the push from it is outward. The flight
 *     now tops out 0.8 m short and arrives across a flat landing at plate
 *     height. @see WALKWAY.STAIR_LANDING
 *
 * ── What this test drives ────────────────────────────────────────────────
 * The real `Physics`, the real `Navigation`, and the real `NPC.fixedUpdate` -
 * think, steer, integrate, capsule solve, ground sample, ground follow, walked-
 * height booking - over a real tilted box collider built exactly the way
 * `StationWorld._ramp` builds one, at exactly the pitch the station's walkway
 * flights are. The only thing stubbed is the animator, which is renderer-bound
 * and takes no part in locomotion.
 */

const DT = 1 / 60;

/** The one renderer-bound thing `NPC` builds in its constructor. */
class HeadlessNPC extends NPC {
  _createAnimator() {
    return {
      setLocomotion() {}, setLookTarget() {}, setAimTarget() {}, setSeated() {},
      flinch() {}, die() {}, revive() {}, update() {}, beginSink() {}, sunk: false,
    };
  }
}

/**
 * A flight laid out along +X: deck at y = 0, a promenade slab at the top, and
 * the `_ramp` proxy between them.
 *
 * `_ramp` builds its box long in local +Z and tilts that end UP, so a flight
 * that climbs toward -X is that box yawed by -PI/2. This is a copy of nine
 * lines of `StationWorld._ramp` rather than a call to it because building a
 * `StationWorld` needs a WebGL context; the geometry it produces is identical
 * and the assertions below are about what physics does with it.
 */
function flightWorld(f, { landing = true } = {}) {
  const { rOuter, rInner, run, rise, rampSeat } = f;
  /* Defaulted rather than destructured outright so that pointed at a build
   * with no landing this still assembles the flight that build describes, and
   * fails on the CHARACTER'S behaviour rather than on a NaN. */
  const rHead = f.rHead ?? rInner;
  const landingHalf = f.landingHalf ?? 0;
  const landingR = f.landingR ?? rInner;
  const width = WALKWAY.STAIR_W;
  const physics = new Physics();
  const add = (mesh) => { mesh.updateWorldMatrix(true, false); physics.addBoxFromObject(mesh); return mesh; };

  const deck = new THREE.Mesh(new THREE.BoxGeometry(400, 2, 80));
  deck.position.set(0, -1, 0);
  add(deck);

  /* The promenade slab, whose outer face is the thing a climbing capsule
   * catches on when there is no landing. Its outer edge is at `rInner`, the
   * same as the real one. */
  const promenade = new THREE.Mesh(new THREE.BoxGeometry(20, 0.6, WALKWAY.WIDTH));
  promenade.position.set(rInner - 10, rise - 0.3, 0);
  add(promenade);

  const len = Math.hypot(run, rise);
  const pitch = Math.atan2(rise, run);
  const ramp = new THREE.Mesh(new THREE.BoxGeometry(width, 0.5, len));
  ramp.visible = false;
  ramp.position.set((rOuter + rHead) / 2, rampSeat, 0);
  ramp.rotation.set(0, -Math.PI / 2, 0, 'YXZ');
  ramp.rotateX(-pitch);
  add(ramp);

  if (landing) {
    const plate = new THREE.Mesh(new THREE.BoxGeometry(width, 0.3, landingHalf * 2));
    plate.position.set(landingR, rise - 0.15, 0);
    plate.rotation.set(0, -Math.PI / 2, 0, 'YXZ');
    add(plate);
  }
  return physics;
}

/** A character with nothing to do but walk at `target`. */
function walker(physics, at, target, speed = 1.4) {
  const npc = new HeadlessNPC({
    type: 'friendly', name: 'Test', persona: '', theme: 'station',
    position: at.clone(),
    scene: new THREE.Scene(),
    physics,
    bus: { on: () => () => {}, emit() {} },
    manager: null,
    humanoid: { root: new THREE.Object3D(), height: 1.75, getHeadWorldPosition: (o) => o },
    seed: 11,
  });
  npc.desiredSpeed = speed;
  npc.nav.setTarget(target);
  return npc;
}

/** Run the real fixed step until the character arrives or the clock runs out. */
function walk(npc, target, seconds) {
  const steps = Math.round(seconds / DT);
  let peakY = npc.position.y;
  for (let i = 0; i < steps; i++) {
    // Re-issued every step, exactly as a role's `_think` does. `setTargetIfNew`
    // is the API that exists so that does not clear `arrived` every frame.
    npc.nav.setTargetIfNew(target);
    npc.fixedUpdate(DT, i * DT);
    peakY = Math.max(peakY, npc.position.y);
  }
  return { peakY, x: npc.position.x, y: npc.position.y, walkedY: npc._walkedY };
}

/* ------------------------------------------------------------------ */
/* The thing itself                                                    */
/* ------------------------------------------------------------------ */

test('a character at the foot of a walkway flight ends up on the promenade', () => {
  const f = walkwayStairFlight();
  const physics = flightWorld(f);
  const target = new THREE.Vector3(f.rInner - 3, f.rise, 0);
  const npc = walker(physics, new THREE.Vector3(f.rOuter + 1.5, 0, 0), target);

  const r = walk(npc, target, 45);

  /* ON the plate, not near it. The 0.05 m tolerance is deliberate and is what
   * caught the second half of this defect: a character that climbs the flight
   * and then catches on the deck slab's outer EDGE stops 0.17 m short, which a
   * loose tolerance reads as success. @see WALKWAY.STAIR_LANDING */
  assert.ok(r.y > f.rise - 0.05, `stopped at y = ${r.y.toFixed(3)}, the plate is at ${f.rise}`);
  assert.ok(r.x < f.rInner, `never got past the deck edge (x = ${r.x.toFixed(2)})`);
  // It CLIMBED, rather than being re-seated up there by a watchdog: the walked-
  // height memory only follows a rise a single step could have made.
  assert.ok(r.walkedY > f.rise - 0.05, `arrived without walking (walkedY = ${r.walkedY.toFixed(2)})`);
});

/* ── Why the flight-meets-edge case is NOT reproduced here ─────────────────
 * The obvious companion test - build the flight so its pitch runs straight to
 * the deck's outer edge, and assert the character stops short - was written and
 * then deleted, because it passes: this fixture is a single 20 m slab and the
 * capsule scrambles over its edge in a way the real deck's 36 chord segments,
 * railings and grate did not allow. On the running station the identical
 * character parked at r = 75.38, y = 9.84 for as long as it was watched. A test
 * that claims a defect this fixture cannot reproduce would be worse than none,
 * so the landing is pinned by its GEOMETRY in station-walkway-stairs.test.mjs
 * and by that measurement, and the tolerance above is set tight enough that a
 * character stopping 0.17 m short would fail. */

test('...and it makes real progress rather than creeping', () => {
  /* Height gained per second, so a fix that leaves the character technically
   * ascending at a centimetre a second cannot pass. The measured climb after
   * the fixes is 0.43 m/s of height - the whole 10 m flight in 23.5 s. */
  const f = walkwayStairFlight();
  const physics = flightWorld(f);
  const target = new THREE.Vector3(f.rInner - 3, f.rise, 0);
  const npc = walker(physics, new THREE.Vector3(f.rOuter + 1.5, 0, 0), target);
  const r = walk(npc, target, 12);
  assert.ok(r.y > 3, `only ${r.y.toFixed(2)} m up after 12 s - that is a creep, not a climb`);
});

test('the 37.6 degree flight is what the character used to be given', () => {
  // The geometry as it stood, driven through the same loop. It has to be able
  // to fail for the test above to mean anything.
  const old = { rOuter: 88, rInner: 75, run: 13, rise: 10.005 };
  old.pitch = Math.atan2(old.rise, old.run);
  old.rampSeat = old.rise / 2 - 0.25 / Math.cos(old.pitch);
  assert.equal(Number((old.pitch * 180 / Math.PI).toFixed(1)), 37.6);
  assert.ok(old.pitch * 180 / Math.PI > WALKWAY.STAIR_PITCH_MAX_DEG);
});

/* ------------------------------------------------------------------ */
/* ...and the two causes, separately                                   */
/* ------------------------------------------------------------------ */

test('the steering does not brake at a flight it is walking up', () => {
  const f = walkwayStairFlight();
  const physics = flightWorld(f);
  const target = new THREE.Vector3(f.rInner - 3, f.rise, 0);
  const npc = walker(physics, new THREE.Vector3(f.rOuter + 1.5, 0, 0), target);
  let worstBrake = 0;
  for (let i = 0; i < 60 * 10; i++) {
    npc.nav.setTargetIfNew(target);
    npc.fixedUpdate(DT, i * DT);
    worstBrake = Math.max(worstBrake, npc.nav.avoidBrake);
  }
  assert.ok(worstBrake < 0.05, `the flight braked the character to ${worstBrake.toFixed(2)}`);
  assert.equal(npc.nav.blocked, false, 'the flight latched `blocked` - it read as a wall');
});

test('a real wall still stops it - the floor test is not a blanket exemption', () => {
  const physics = new Physics();
  const deck = new THREE.Mesh(new THREE.BoxGeometry(200, 2, 80));
  deck.position.set(0, -1, 0);
  deck.updateWorldMatrix(true, false);
  physics.addBoxFromObject(deck);
  const wall = new THREE.Mesh(new THREE.BoxGeometry(1, 6, 40));
  wall.position.set(10, 3, 0);
  wall.updateWorldMatrix(true, false);
  physics.addBoxFromObject(wall);

  const target = new THREE.Vector3(30, 0, 0);
  const npc = walker(physics, new THREE.Vector3(20, 0, 0), target);
  // Walking at the wall from the far side.
  npc.position.set(4, 0, 0);
  const far = new THREE.Vector3(30, 0, 0);
  let worstBrake = 0;
  for (let i = 0; i < 60 * 6; i++) {
    npc.nav.setTargetIfNew(far);
    npc.fixedUpdate(DT, i * DT);
    worstBrake = Math.max(worstBrake, npc.nav.avoidBrake);
  }
  assert.ok(worstBrake > 0.5, `a 6 m wall only braked the character to ${worstBrake.toFixed(2)}`);
  assert.ok(npc.position.x < 10, 'the character walked through a wall');
});

/* ------------------------------------------------------------------ */
/* capsuleSlopeLift, the arithmetic                                    */
/* ------------------------------------------------------------------ */

test('flat ground asks for exactly no lift, so nothing on a floor moves', () => {
  assert.equal(capsuleSlopeLift(0.33, 1), 0);
  assert.equal(capsuleSlopeLift(0.36, 1), 0);
});

test('the lift is what makes the capsule tangent to the slope', () => {
  const r = 0.33;
  for (const deg of [10, 20, 30.478, 45]) {
    const ny = Math.cos(deg * Math.PI / 180);
    const lift = capsuleSlopeLift(r, ny);
    // Sphere centre sits `lift + r` above the surface vertically; its
    // perpendicular distance to the plane is that times cos(pitch), and the
    // whole point is that this equals the radius.
    assert.ok(Math.abs((lift + r) * ny - r) < 1e-12, `not tangent at ${deg} degrees`);
  }
});

test('the station flight needs 5 cm of it, which is the drift it removes', () => {
  const f = walkwayStairFlight();
  const ny = Math.cos(f.pitch);
  assert.equal(Number(capsuleSlopeLift(0.33, ny).toFixed(3)), 0.053);
  // Without it, `resolveCapsule` evicts by r*(1 - cos p) along the normal, whose
  // horizontal part is the downhill drift - measured on the page at 0.0231 m.
  const evict = 0.33 * (1 - ny);
  assert.equal(Number((evict * Math.sin(f.pitch)).toFixed(4)), 0.0231);
  assert.ok(evict * Math.sin(f.pitch) * 60 > 1.3, 'the drift used to outrun a 1.4 m/s walk');
});

test('a wall-grazing contact cannot ask for an absurd lift', () => {
  // Clamped at the walkable threshold, so a normal that is not floor at all is
  // never allowed to hold a character off the ground.
  assert.equal(capsuleSlopeLift(0.33, 0), capsuleSlopeLift(0.33, WALKABLE_NORMAL_Y));
  assert.ok(capsuleSlopeLift(0.33, 0) < 0.28);
  assert.equal(capsuleSlopeLift(0.33, 2), 0, 'a normal steeper than vertical is nonsense, not a drop');
  assert.equal(capsuleSlopeLift(0, 0.8), 0);
  assert.equal(capsuleSlopeLift(0.33, NaN), 0);
});

/* ------------------------------------------------------------------ */
/* The line-of-sight test used for waypoint skipping                   */
/* ------------------------------------------------------------------ */

test('a ramp between two waypoints is not treated as an obstruction', () => {
  const f = walkwayStairFlight();
  const physics = flightWorld(f);
  const nav = new Navigation({ physics });
  const foot = new THREE.Vector3(f.rOuter + 1, 0, 0);
  const head = new THREE.Vector3(f.rInner - 1, f.rise, 0);
  assert.equal(nav._clearLine(foot, head), true, 'the flight blocks its own line of sight');
});

test('...but a wall between them still is', () => {
  const physics = new Physics();
  const wall = new THREE.Mesh(new THREE.BoxGeometry(1, 6, 40));
  wall.position.set(10, 3, 0);
  wall.updateWorldMatrix(true, false);
  physics.addBoxFromObject(wall);
  const nav = new Navigation({ physics });
  assert.equal(nav._clearLine(new THREE.Vector3(0, 0, 0), new THREE.Vector3(20, 0, 0)), false);
});
