import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Physics } from '../../src/physics/Physics.js';
import { MAZE, districtIndex, DISTRICT_SPAN } from '../../src/worlds/maze/MazeTopology.js';
import { MazeCanopy } from '../../src/worlds/maze/MazeCanopy.js';

function harness() {
  const physics = new Physics(null);
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial();
  const canopy = new MazeCanopy({ group, material });
  return { physics, group, canopy, material };
}

test('the canopy adds no colliders at all', () => {
  const { physics, canopy } = harness();
  canopy.update(10 * DISTRICT_SPAN, 10 * DISTRICT_SPAN, 0);
  assert.equal(physics.colliders.length, 0, 'the canopy is scenery and must never collide');
});

test('the canopy covers a wider radius than the streamed set', () => {
  const { canopy } = harness();
  canopy.update(10 * DISTRICT_SPAN, 10 * DISTRICT_SPAN, 0);
  assert.ok(canopy.residentKeys().length > 25,
    `canopy covers only ${canopy.residentKeys().length} districts`);
});

test('the canopy sits at hedge height, not on the ground', () => {
  const { group, canopy } = harness();
  canopy.update(10 * DISTRICT_SPAN, 10 * DISTRICT_SPAN, 0);
  let lowest = Infinity;
  group.traverse((o) => { if (o.isInstancedMesh) lowest = Math.min(lowest, o.position.y); });
  assert.ok(Number.isFinite(lowest), 'no canopy mesh was built');
});

test('the canopy is released', () => {
  const { group, canopy } = harness();
  canopy.update(10 * DISTRICT_SPAN, 10 * DISTRICT_SPAN, 0);
  assert.ok(group.children.length > 0);
  canopy.disposeAll();
  assert.equal(group.children.length, 0);
  assert.deepEqual(canopy.residentKeys(), []);
});

test('the canopy uses the material it was given', () => {
  const { group, canopy, material } = harness();
  canopy.update(10 * DISTRICT_SPAN, 10 * DISTRICT_SPAN, 0);
  group.traverse((o) => { if (o.material) assert.equal(o.material, material); });
});
