import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/**
 * THE RULE THAT DECIDES WHERE A CONTEST'S POINTS MAY STAND.
 *
 * `VenueGround` is small and it is the only thing between a published venue and
 * this repo's signature defect - content that was BUILT and cannot be REACHED.
 * Three failures it exists to stop, each of them silent in production:
 *
 *  1. **No floor.** A point inside a wall or over a hole settles nowhere. Left
 *     at its authored `y` it would be an arrival the player can never make.
 *  2. **No headroom.** A point under a stair flight or a walkway HAS floor, and
 *     a downward ray is perfectly happy with it. Only an upward ray knows a
 *     capsule cannot stand there.
 *  3. **A pedestal.** The top of a packing crate has floor AND headroom, and
 *     the station's hub deck carries 2,226 solid ones. Two of the first six
 *     relay masts settled onto props at 5.45 m and 0.72 m over a 0.08 m deck.
 *     Only the neighbours can tell a crate from a floor.
 *
 * Driven against the real `Physics` with real box colliders rather than a stub,
 * because the thing under test is a conversation between three raycasts and the
 * collider set - which a stub would let me get wrong in exactly the direction
 * that ships.
 */

const { Physics, COLLISION_LAYER } = await import('../../src/physics/Physics.js');
const { settlePoints, discFor, STAND_HEADROOM, WALK_RING_R, WALK_STEP_UP } =
  await import('../../src/minigames/VenueGround.js');

/** A solid axis-aligned box, centred, with the given half extents. */
function box(physics, cx, cy, cz, hx, hy, hz) {
  return physics.addBox(cx, cy, cz, hx, hy, hz, { layer: COLLISION_LAYER.WORLD, solid: true });
}

/** A world with a 200 x 200 m floor slab at y = 0. */
function floorWorld() {
  const physics = new Physics();
  box(physics, 0, -1, 0, 100, 1, 100);
  return physics;
}

const OPT = { from: 60, depth: 120, lift: 0.05 };

test('a point over open floor settles onto it, lifted by exactly `lift`', () => {
  const physics = floorWorld();
  const { points, dropped } = settlePoints(physics, [{ id: 'a', label: 'A', x: 10, z: -4 }], OPT);
  assert.equal(dropped.length, 0);
  assert.equal(points.length, 1);
  assert.equal(points[0].id, 'a');
  assert.equal(points[0].label, 'A');
  assert.ok(Math.abs(points[0].y - 0.05) < 1e-6, `settled at ${points[0].y}, not 0.05`);
});

test('a point with no floor under it is dropped, and says so', () => {
  const physics = floorWorld();
  const { points, dropped } = settlePoints(physics, [{ id: 'void', x: 400, z: 400 }], OPT);
  assert.equal(points.length, 0);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].why, /no floor/);
});

test('a point under a low soffit is dropped — floor is not the same as room to stand', () => {
  const physics = floorWorld();
  // A slab whose underside is 1.2 m over the floor: a capsule does not fit.
  box(physics, 20, 1.35, 0, 4, 0.15, 4);
  /* Probed from BENEATH the slab, which is the real case: the station's
   * promenade probe starts below the dome for exactly this reason. A probe
   * started above it would find the slab's TOP and settle a point on the roof -
   * a different (and also real) failure, covered by the envelope test below. */
  const under = { from: 1.0, depth: 10, lift: 0.05 };
  const { points, dropped } = settlePoints(physics, [
    { id: 'under', x: 20, z: 0 },
    { id: 'clear', x: 40, z: 0 },
  ], under);
  assert.deepEqual(points.map((p) => p.id), ['clear']);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].why, /headroom/);
  assert.ok(STAND_HEADROOM >= 1.75, 'the capsule is 1.75 m; the clause has to clear it');
});

test('a point on the top of a crate is dropped — the neighbours are what tell them apart', () => {
  /* THE STATION DEFECT, reproduced. The crate top has floor and unlimited sky:
   * only the ring says it is not a place a body can be. */
  const physics = floorWorld();
  box(physics, -30, 2.7, 0, 1.0, 2.7, 1.0);      // a 5.4 m tall crate, 2 m across
  const { points, dropped } = settlePoints(physics, [{ id: 'crate', x: -30, z: 0 }], OPT);
  assert.equal(points.length, 0, 'the crate top was accepted as a venue point');
  assert.match(dropped[0].why, /pedestal/);

  // ..and the same probe on the floor beside it is fine.
  const beside = settlePoints(physics, [{ id: 'beside', x: -30 + WALK_RING_R * 3, z: 0 }], OPT);
  assert.equal(beside.points.length, 1);
});

test('a broad platform is NOT a pedestal — the rule measures walkability, not height', () => {
  /* The rule must not be "reject anything raised": a promenade deck 10 m up is
   * exactly where one of the station's venues lives. What disqualifies a point
   * is having nothing walkable NEXT to it. */
  const physics = floorWorld();
  box(physics, 60, 5, 60, 20, 5, 20);            // a 40 m square platform, 10 m up
  const { points, dropped } = settlePoints(physics, [{ id: 'plat', x: 60, z: 60 }], OPT);
  assert.equal(dropped.length, 0, `a 40 m platform was called a pedestal: ${dropped[0]?.why}`);
  assert.ok(Math.abs(points[0].y - 10.05) < 1e-6);
});

test('a kerb inside the step-up passes, and the same block twice as tall does not', () => {
  /* Both blocks are the same 2 m square - narrower than the 1.2 m walk ring, so
   * the neighbours are on the floor in both cases - and the ONLY difference is
   * height. That is the property, isolated: the rule measures the step a body
   * would have to take, not whether the point is raised at all. */
  const physics = floorWorld();
  const kerbTop = WALK_STEP_UP * 0.5;
  const ledgeTop = WALK_STEP_UP * 2.0;
  box(physics, 60, kerbTop / 2, 0, 1.0, kerbTop / 2, 1.0);
  box(physics, -60, ledgeTop / 2, 0, 1.0, ledgeTop / 2, 1.0);
  const s = settlePoints(physics, [{ id: 'kerb', x: 60, z: 0 }, { id: 'ledge', x: -60, z: 0 }], OPT);
  assert.deepEqual(s.points.map((p) => p.id), ['kerb']);
  assert.equal(s.dropped.length, 1);
  assert.match(s.dropped[0].why, /pedestal/);
  assert.ok(WALK_RING_R > 1.0, 'the ring has to fall OFF a 2 m block or this test proves nothing');
});

test('the walk-on rule can be turned off for a venue that means to stand on a platform', () => {
  const physics = floorWorld();
  box(physics, -30, 2.7, 0, 1.0, 2.7, 1.0);
  const s = settlePoints(physics, [{ id: 'crate', x: -30, z: 0 }], { ...OPT, quorum: 0 });
  assert.equal(s.points.length, 1);
});

test('the probe envelope is honoured — a shallow probe cannot find a deep floor', () => {
  /* The envelope is not a detail. A probe started at the default 200 m inside
   * the station finds the DOME ROOF and settles every point forty metres in the
   * air; a promenade probe deep enough to reach the concourse settles a missed
   * mast ten metres below the walkway. Both are the same bug and both are
   * invisible without this. */
  const physics = floorWorld();
  const shallow = settlePoints(physics, [{ id: 'a', x: 0, z: 0 }], { from: 60, depth: 30 });
  assert.equal(shallow.points.length, 0, 'a 30 m probe from 60 m up found a floor at 0');
  const right = settlePoints(physics, [{ id: 'a', x: 0, z: 0 }], { from: 60, depth: 61 });
  assert.equal(right.points.length, 1);
});

test('a malformed plan is dropped rather than thrown on', () => {
  const physics = floorWorld();
  const s = settlePoints(physics, [
    { id: 'nan', x: NaN, z: 0 },
    { id: 'missing', z: 0 },
    null,
    { id: 'ok', x: 0, z: 0 },
  ], OPT);
  assert.deepEqual(s.points.map((p) => p.id), ['ok']);
  assert.equal(s.dropped.length, 3);
  assert.deepEqual(settlePoints(physics, null, OPT), { points: [], dropped: [] });
  assert.deepEqual(settlePoints(null, [{ id: 'a', x: 0, z: 0 }], OPT).points, []);
});

/* ================================================================== */
/* discFor                                                             */
/* ================================================================== */

test('the disc holds every point it was measured from, plus the margin', () => {
  const pts = [
    { x: 0, y: 0, z: 0 }, { x: 40, y: 0, z: 0 }, { x: 0, y: 0, z: -60 }, { x: -20, y: 3, z: 10 },
  ];
  const d = discFor(pts, { margin: 10, band: 4 });
  for (const p of pts) {
    const planar = Math.hypot(p.x - d.centre.x, p.z - d.centre.z);
    assert.ok(planar <= d.radius - 10 + 1e-9,
      `(${p.x}, ${p.z}) is ${planar.toFixed(2)} m out of a ${d.radius.toFixed(2)} m disc`);
    assert.ok(Math.abs(p.y - d.centre.y) <= d.yTolerance,
      `(${p.x}, ${p.z}) at y ${p.y} is outside the ${d.yTolerance} m band`);
  }
  assert.ok(d.radius > 0);
});

test('the band grows with the spread of the route, so a climb is not clipped', () => {
  const flat = discFor([{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }], { band: 4 });
  const climb = discFor([{ x: 0, y: 0, z: 0 }, { x: 10, y: 20, z: 0 }], { band: 4 });
  assert.equal(flat.yTolerance, 4);
  assert.equal(climb.yTolerance, 14, 'a 20 m climb was not reflected in the height band');
});

test('an empty point list yields no disc rather than a NaN one', () => {
  assert.equal(discFor([]), null);
  assert.equal(discFor(null), null);
  assert.equal(discFor([{ x: 'over there', y: 0, z: 0 }]), null);
});
