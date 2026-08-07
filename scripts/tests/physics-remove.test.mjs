import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Physics } from '../../src/physics/Physics.js';

test('remove drops a collider from the array', () => {
  const p = new Physics(null);
  const a = p.addBox(0, 0, 0, 1, 1, 1);
  const b = p.addBox(50, 0, 0, 1, 1, 1);
  assert.equal(p.remove(a), true);
  assert.equal(p.colliders.length, 1);
  assert.equal(p.colliders[0], b);
});

test('remove returns false for a collider that was never added', () => {
  const p = new Physics(null);
  const a = p.addBox(0, 0, 0, 1, 1, 1);
  p.remove(a);
  assert.equal(p.remove(a), false);
});

test('a removed collider no longer blocks a capsule', () => {
  const p = new Physics(null);
  p.addBox(0, -0.5, 0, 40, 0.5, 40);          // floor
  const wall = p.addBox(3, 2.5, 0, 0.6, 2.5, 20); // wall at x=3

  const pos = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < 120; i++) { pos.x += 8.2 / 60; p.resolveCapsule(pos, 0.35, 1.75); }
  assert.ok(pos.x < 2.5, `wall did not stop the capsule: x=${pos.x}`);

  p.remove(wall);
  const pos2 = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < 120; i++) { pos2.x += 8.2 / 60; p.resolveCapsule(pos2, 0.35, 1.75); }
  assert.ok(pos2.x > 5, `removed wall still blocks: x=${pos2.x}`);
});

test('a removed collider no longer answers queries', () => {
  const p = new Physics(null);
  const box = p.addBox(0, 0, 0, 2, 2, 2);
  assert.ok(p.query(new THREE.Vector3(0, 0, 0), 5).includes(box));
  p.remove(box);
  assert.ok(!p.query(new THREE.Vector3(0, 0, 0), 5).includes(box));
});

test('removing one collider leaves its grid-cell neighbours intact', () => {
  const p = new Physics(null);
  // Both land in overlapping broadphase cells (cellSize is 12).
  const a = p.addBox(0, 0, 0, 2, 2, 2);
  const b = p.addBox(3, 0, 0, 2, 2, 2);
  p.remove(a);
  const hits = p.query(new THREE.Vector3(3, 0, 0), 5);
  assert.ok(hits.includes(b), 'neighbour was collaterally removed');
  assert.ok(!hits.includes(a));
});

test('remove handles heightfields', () => {
  const p = new Physics(null);
  const hf = p.addHeightfield({
    heights: new Float32Array(16), nx: 4, nz: 4,
    originX: 0, originZ: 0, stepX: 1,
  });
  assert.equal(p.heightfields.length, 1);
  assert.equal(p.remove(hf), true);
  assert.equal(p.heightfields.length, 0);
  assert.equal(p.colliders.length, 0);
});

test('add then remove repeatedly does not leak grid entries', () => {
  const p = new Physics(null);
  for (let i = 0; i < 500; i++) {
    const c = p.addBox(0, 0, 0, 1, 1, 1);
    p.remove(c);
  }
  assert.equal(p.colliders.length, 0);
  assert.equal(p.query(new THREE.Vector3(0, 0, 0), 5).length, 0);
  // Every emptied bucket must be dropped, or the grid grows without bound.
  assert.equal(p._grid.size, 0, `leaked ${p._grid.size} grid buckets`);
});

test('remove is not linear in collider count', () => {
  /* Chunk eviction calls remove() ~400 times per district against an array of
   * ~10,000. At O(n) that dominates the frame; the maze's four-level phase
   * multiplies it. This asserts the shape of the curve, not a wall-clock
   * budget, so it does not go flaky on a slow machine.
   *
   * 2,000 vs 64,000 is 32x the work. A linear (indexOf/splice) removal pays
   * for that quadratically - roughly 32*32 = 1,024x - because both the scan
   * to find the collider and the shift to close the gap grow with array
   * size. An O(1) map-lookup-and-swap removal pays only for 32x more calls,
   * which measures at roughly 30-60x once JIT/GC noise is folded in. 200
   * sits well inside the gap between those two regimes: comfortably above
   * the O(1) ceiling so a slow machine or a stray GC pause doesn't flake the
   * test, but more than 5x below the quadratic floor, so a real regression -
   * an accidental O(log n) creeping in, or a scan on one branch - still gets
   * caught decisively rather than sneaking under a threshold tuned so tight
   * it was really just asserting today's exact timing. */
  const time = (n) => {
    const p = new Physics(null);
    const made = [];
    for (let i = 0; i < n; i++) made.push(p.addBox(i * 3, 0, 0, 1, 1, 1));
    const t0 = process.hrtime.bigint();
    for (const c of made) p.remove(c);
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  // Minimum of 3 trials: noise (GC, JIT warmup, OS scheduling) only ever
  // adds time, so the minimum is the closest single statistic to the true
  // per-call cost.
  const minOf3 = (n) => Math.min(time(n), time(n), time(n));
  minOf3(2000); // warm
  const small = Math.max(minOf3(2000), 0.01);
  const large = minOf3(64000);
  assert.ok(large / small < 200,
    `remove looks super-linear: 2000 took ${small.toFixed(1)}ms, 64000 took ${large.toFixed(1)}ms`);
});

test('remove still works when the collider is the last one', () => {
  const p = new Physics(null);
  const a = p.addBox(0, 0, 0, 1, 1, 1);
  const b = p.addBox(50, 0, 0, 1, 1, 1);
  assert.equal(p.remove(b), true);
  assert.equal(p.colliders.length, 1);
  assert.equal(p.colliders[0], a);
  assert.equal(p.remove(a), true);
  assert.equal(p.colliders.length, 0);
});

test('removing every collider in a shuffled order leaves nothing behind', () => {
  const p = new Physics(null);
  const made = [];
  for (let i = 0; i < 500; i++) made.push(p.addBox((i % 25) * 7, 0, Math.floor(i / 25) * 7, 1, 1, 1));
  // Deterministic shuffle.
  for (let i = made.length - 1; i > 0; i--) {
    const j = (i * 7919) % (i + 1);
    [made[i], made[j]] = [made[j], made[i]];
  }
  for (const c of made) assert.equal(p.remove(c), true, 'a collider went missing mid-teardown');
  assert.equal(p.colliders.length, 0);
  assert.equal(p._grid.size, 0);
});

test('clear resets the index as well as the array', () => {
  const p = new Physics(null);
  const a = p.addBox(0, 0, 0, 1, 1, 1);
  p.clear();
  assert.equal(p.colliders.length, 0);
  // A stale index entry would make this remove() corrupt the fresh array.
  assert.equal(p.remove(a), false);
  const b = p.addBox(0, 0, 0, 1, 1, 1);
  assert.equal(p.colliders.length, 1);
  assert.equal(p.remove(b), true);
  assert.equal(p.colliders.length, 0);
});
