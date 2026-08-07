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
