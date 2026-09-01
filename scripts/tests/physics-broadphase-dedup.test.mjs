import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { rig, goto, domHarness } from './_flightrig.mjs';

domHarness();
const { COLLISION_LAYER } = await import('../../src/physics/Physics.js');

/**
 * THE BROADPHASE DEDUP WAS TWO `Set`s A CALL. IT IS NOW A STAMP.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT CHANGED, AND WHAT MUST NOT HAVE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `query()` allocated `new Set()` on every call and `raycast()` allocated a
 * second one, plus a candidates array and a `Vector3`. Both run thousands of
 * times per world build and dozens of times per simulation step - a single
 * world crossing makes 12,256 `raycast` calls. All of that is now a monotonic
 * integer stamp on the collider plus two reused buffers.
 *
 * The stamp is a different MECHANISM for the same QUESTION, so the only thing
 * worth asserting is that the answers did not move. And a comparison against a
 * `Set`-based re-implementation would only prove the two agree with each other,
 * which is the trap this repository keeps paying for - a checker that
 * re-derives the rule is a second copy of it that can be wrong on its own.
 *
 * So both halves are checked against a BRUTE FORCE that shares no code with
 * the broadphase at all:
 *
 *   `query`   must return every collider whose bounding sphere overlaps the
 *             query sphere, with no id twice.
 *   `raycast` must return exactly what testing every collider in the world
 *             returns - same collider, same distance.
 *
 * The second is the strong one. A dedup that dropped a candidate would still
 * look plausible in a count and would show up here as a missed hit; one that
 * kept a duplicate would double-test a collider and give the same answer, so
 * the no-duplicates assertion in the first half is what covers that.
 *
 * Driven against a REAL built world (`dock`, 729 colliders, ~750 ms to build)
 * rather than a synthetic grid, because the case the stamp has to get right is
 * a collider straddling several cells - `_insertToGrid` puts one in every cell
 * its footprint touches, and a hand-made fixture would not have any.
 */

const R = await rig();
await goto(R, 'dock');
const physics = R.physics;

/** Deterministic, so a failure is reproducible and a pass is not luck. */
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('the broadphase returns every overlapping collider, once each', () => {
  const rnd = mulberry32(0x51ed270b);
  const grid = physics._grid;
  /* Every collider the grid holds, gathered without going through `query` -
   * the flat truth the stamp is filtering. */
  const all = new Set();
  for (const list of grid.values()) for (const c of list) all.add(c);
  assert.ok(all.size > 200, `the dock registered only ${all.size} grid colliders - the probe is blind`);

  const centre = new THREE.Vector3();
  let checked = 0;
  let everMultiCell = 0;
  for (let i = 0; i < 400; i++) {
    centre.set((rnd() - 0.5) * 340, (rnd() - 0.2) * 40, (rnd() - 0.5) * 340);
    const radius = 0.5 + rnd() * 30;

    const got = physics.query(centre, radius).slice();
    /* No id twice. A stamp that failed to mark would show up here and nowhere
     * else - a duplicate costs correctness nothing and performance everything,
     * which is exactly the kind of regression that survives. */
    assert.equal(new Set(got).size, got.length,
      `query returned a duplicate at radius ${radius.toFixed(1)}`);

    /* And it must not have LOST one. Brute force over the same grid contents,
     * by the same bounding-sphere rule the grid is built to approximate:
     * anything whose sphere reaches inside the query sphere and which the grid
     * can see has to come back. Heightfields are excluded - `query` matches
     * those by footprint, outside the grid, by design. */
    const want = [];
    for (const c of all) {
      if (c.isHeightfield || c.sampleHeight) continue;
      const d = Math.hypot(c.center.x - centre.x, c.center.y - centre.y, c.center.z - centre.z);
      /* The grid is a plan-space structure: it indexes by XZ cell and takes no
       * account of Y, so a query only ever misses on the XZ footprint. Compare
       * on the plan distance for the same reason. */
      const dxz = Math.hypot(c.center.x - centre.x, c.center.z - centre.z);
      if (dxz + 1e-6 < radius + c.boundingRadius && d < 1e9) want.push(c);
    }
    const gotSet = new Set(got);
    for (const c of want) {
      /* A collider whose sphere reaches the query sphere in plan MUST be in a
       * cell the query swept, because `_insertToGrid` inserts by footprint. */
      const cells = Math.ceil((c.boundingRadius * 2) / physics.cellSize);
      if (cells > 64) continue; // a world-sized collider is the heightfield case
      assert.ok(gotSet.has(c),
        `query missed a collider ${Math.hypot(c.center.x - centre.x, c.center.z - centre.z).toFixed(1)} m away `
        + `(r ${c.boundingRadius.toFixed(1)}) at query radius ${radius.toFixed(1)}`);
    }
    if (got.length) checked++;
    const minX = Math.floor((centre.x - radius) / physics.cellSize);
    const maxX = Math.floor((centre.x + radius) / physics.cellSize);
    if (maxX > minX) everMultiCell++;
  }
  assert.ok(checked > 40, `only ${checked} of 400 queries found anything - the probe is not aimed at the world`);
  /* The single-cell fast path and the stamped path are DIFFERENT CODE, so the
   * run has to have exercised both or half the change is untested. */
  assert.ok(everMultiCell > 100, 'no multi-cell query in the sample - the stamped path never ran');
});

test('a single-cell query takes the fast path and still cannot return a duplicate', () => {
  /* `gatherRadius` is 0 for a vertical ray, which is every ground probe, every
   * foot-IK probe and every `surfaceStack` walk in the game. A zero-radius
   * query touches exactly one cell, and one cell's list cannot contain a
   * duplicate - which is why that case skips the filter entirely. */
  const rnd = mulberry32(0x2f9a11c3);
  const at = new THREE.Vector3();
  let found = 0;
  for (let i = 0; i < 300; i++) {
    at.set((rnd() - 0.5) * 340, 4, (rnd() - 0.5) * 340);
    const got = physics.query(at, 0).slice();
    assert.equal(new Set(got).size, got.length, 'a single-cell query returned a duplicate');
    /* And the WHOLE cell, not most of it. Checked directly against the grid
     * bucket rather than through anything the query shares code with: a fast
     * path that dropped an entry would answer plausibly here and only show up
     * as a missed hit somewhere far away. */
    const key = physics._cellKey(
      Math.floor(at.x / physics.cellSize), Math.floor(at.z / physics.cellSize)
    );
    const bucket = physics._grid.get(key) ?? [];
    const gotSet = new Set(got);
    for (const c of bucket) {
      assert.ok(gotSet.has(c), 'a zero-radius query left a collider out of its own cell');
    }
    if (got.length) found++;
  }
  assert.ok(found > 30, `only ${found} of 300 zero-radius queries hit a cell with anything in it`);
});

test('a ray returns exactly what testing every collider returns', () => {
  /* THE STRONG ASSERTION. The reference shares no code with the broadphase:
   * it walks every collider the world registered and calls the same per-
   * collider test the marcher calls, so a candidate the gather DROPPED shows
   * up as a hit the reference found and the ray did not. */
  const rnd = mulberry32(0x7c4d2ee1);
  const from = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const colliders = physics.colliders;
  assert.ok(colliders.length > 200, `the dock registered ${colliders.length} colliders`);

  let hits = 0;
  let verticals = 0;
  for (let i = 0; i < 500; i++) {
    /* Half the rays are vertical, deliberately: that is the case with
     * `gatherRadius = 0` and `steps = 0`, and it is the one the change treats
     * specially. Skewing the sample towards it is not cheating, it is aiming
     * at the branch. */
    const vertical = i % 2 === 0;
    from.set((rnd() - 0.5) * 320, vertical ? 120 : 2 + rnd() * 20, (rnd() - 0.5) * 320);
    if (vertical) { dir.set(0, -1, 0); verticals++; } else {
      dir.set(rnd() - 0.5, (rnd() - 0.5) * 0.4, rnd() - 0.5).normalize();
    }
    const maxDist = vertical ? 400 : 60;

    const got = physics.raycast(from, dir, maxDist, COLLISION_LAYER.ALL);

    let best = null;
    let bestDist = maxDist;
    for (const c of colliders) {
      if ((c.layer & COLLISION_LAYER.ALL) === 0) continue;
      const hit = physics._raycastCollider(c, from, dir, bestDist);
      if (hit && hit.distance < bestDist) { bestDist = hit.distance; best = c; }
    }

    if (best === null) {
      assert.equal(got, null,
        `the broadphase found a hit at ${got?.distance?.toFixed(3)} m that a full sweep does not`);
      continue;
    }
    assert.ok(got, `the broadphase MISSED a hit a full sweep found at ${bestDist.toFixed(3)} m `
      + `(from ${from.x.toFixed(1)},${from.y.toFixed(1)},${from.z.toFixed(1)} dir ${dir.x.toFixed(2)},${dir.y.toFixed(2)},${dir.z.toFixed(2)})`);
    assert.ok(Math.abs(got.distance - bestDist) < 1e-6,
      `the broadphase answered ${got.distance.toFixed(6)} m where a full sweep answers ${bestDist.toFixed(6)} m`);
    hits++;
  }
  assert.ok(hits > 80, `only ${hits} of 500 rays hit anything - the probe is not aimed at the world`);
  assert.equal(verticals, 250);
});

test('two rays in a row do not contaminate each other through the shared buffers', () => {
  /* `raycast` reuses one candidates array and one probe vector across calls
   * now. If either leaked, the second of two rays would see the first one's
   * candidates - so the same ray fired twice, with an unrelated one between
   * them, has to give the identical answer. */
  const from = new THREE.Vector3(40, 60, -20);
  const down = new THREE.Vector3(0, -1, 0);
  const away = new THREE.Vector3(1, 0, 0.3).normalize();

  const a = physics.raycast(from, down, 200);
  physics.raycast(new THREE.Vector3(-300, 3, 300), away, 400);
  const b = physics.raycast(from, down, 200);

  assert.equal(a === null, b === null, 'the same ray answered differently either side of another');
  if (a) {
    assert.equal(a.collider, b.collider, 'the same ray hit a different collider the second time');
    assert.ok(Math.abs(a.distance - b.distance) < 1e-9);
  }
});
