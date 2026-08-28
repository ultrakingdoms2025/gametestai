// scripts/tests/physics-collider-aabb.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Physics, Collider } from '../../src/physics/Physics.js';

/**
 * THE WORLD AABB OF A COLLIDER, PER TYPE.
 *
 * THE CLAIM: `Physics.colliderAabb` answers the axis-aligned world box of a
 * box (centre ± |R|·h, the expansion Unstuck._solidIndex inlines), a sphere
 * (centre ± r), a mesh chunk (its `bounds`) and a heightfield (its footprint
 * from minY to maxY), into a caller's Box3.
 *
 * Not a stub: every collider is registered through the real add* path and
 * the rotated case is checked against √2, which a centre-only answer or an
 * unrotated half-extent answer both get wrong.
 */

const r3 = (a) => a.map((n) => Math.round(n * 1000) / 1000);

test('an axis-aligned box is centre ± half-extents', () => {
  const p = new Physics(null);
  const b = p.colliderAabb(p.addBox(10, 2, -5, 1, 2, 3));
  assert.deepEqual(r3(b.min.toArray()), [9, 0, -8]);
  assert.deepEqual(r3(b.max.toArray()), [11, 4, -2]);
});

test('a unit box rotated 45° about Y widens to √2 on x and z and keeps y', () => {
  const p = new Physics(null);
  const c = p.addRotatedBox(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 1), Math.PI / 4);
  const b = p.colliderAabb(c);
  assert.deepEqual(r3(b.min.toArray()), r3([-Math.SQRT2, -1, -Math.SQRT2]));
  assert.deepEqual(r3(b.max.toArray()), r3([Math.SQRT2, 1, Math.SQRT2]));
});

test('a sphere is centre ± radius', () => {
  const p = new Physics(null);
  const b = p.colliderAabb(p.add(new Collider('sphere', { center: new THREE.Vector3(1, 2, 3), radius: 0.5 })));
  assert.deepEqual(r3(b.min.toArray()), [0.5, 1.5, 2.5]);
  assert.deepEqual(r3(b.max.toArray()), [1.5, 2.5, 3.5]);
});

test('a mesh chunk is its bounds; a heightfield is its footprint between minY and maxY', () => {
  const p = new Physics(null);
  const mesh = p.colliderAabb(p.addTriangleSoup(new Float32Array([0, 0, 0, 2, 0, 0, 0, 3, 0])));
  assert.deepEqual(r3(mesh.min.toArray()), [0, 0, 0]);
  assert.deepEqual(r3(mesh.max.toArray()), [2, 3, 0]);
  const field = p.colliderAabb(p.addHeightfield({ heights: new Float32Array(4).fill(1), nx: 2, nz: 2, originX: 5, originZ: 7, stepX: 3 }));
  assert.deepEqual(r3(field.min.toArray()), [5, 1, 7]);
  assert.deepEqual(r3(field.max.toArray()), [8, 1, 10]);
});

test('writes into the box it is given and returns it; nothing gives an empty box', () => {
  const p = new Physics(null);
  const out = new THREE.Box3();
  assert.equal(p.colliderAabb(p.addBox(0, 0, 0, 1, 1, 1), out), out);
  assert.equal(out.isEmpty(), false);
  assert.equal(p.colliderAabb(null, out), out);
  assert.equal(out.isEmpty(), true);
});
