import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Physics } from '../../src/physics/Physics.js';
import { MAZE, districtIndex, districtCoords, DISTRICT_SPAN } from '../../src/worlds/maze/MazeTopology.js';
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

/* ------------------------------------------------------------------------ */
/* Pooling: one InstancedMesh, not one per district.                        */
/*                                                                            */
/* A first pass allocated a fresh single-instance InstancedMesh per resident */
/* district - 289 draw calls to draw 289 quads at radius 8. These tests      */
/* cover the pooled replacement: a single MAX_CANOPY-capacity mesh with a    */
/* packed slot allocator (`_resident` / `_slotDistrict` in MazeCanopy.js).   */
/* They reach into those "private" fields directly, the same way            */
/* maze-chunks.test.mjs reaches into MazeChunks' `_resident` - there is no   */
/* enforced privacy in this codebase, and the whole point here is to verify  */
/* the allocator's own bookkeeping, not just what it exposes.               */
/* ------------------------------------------------------------------------ */

test('exactly one InstancedMesh serves every resident district', () => {
  const { group, canopy } = harness();
  canopy.update(10 * DISTRICT_SPAN, 10 * DISTRICT_SPAN, 0);
  let meshCount = 0;
  group.traverse((o) => { if (o.isInstancedMesh) meshCount++; });
  assert.equal(meshCount, 1, `expected one pooled mesh, found ${meshCount}`);
  assert.ok(canopy.residentKeys().length > 25, 'sanity: still covering a real neighbourhood');
});

test('mesh.count matches the resident count exactly after a long walk', () => {
  const { canopy } = harness();
  for (let i = 0; i < 30; i++) {
    canopy.update(i * 0.6 * DISTRICT_SPAN, i * 0.4 * DISTRICT_SPAN, 0);
  }
  assert.equal(canopy._mesh.count, canopy.residentKeys().length);
});

test('every live district\'s matrix sits at its mapped slot with the right world position', () => {
  const { canopy } = harness();
  canopy.update(10 * DISTRICT_SPAN, 10 * DISTRICT_SPAN, 0);
  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  for (const key of canopy.residentKeys()) {
    const slot = canopy._resident.get(key);
    assert.equal(canopy._slotDistrict[slot], key, 'slot table disagrees with the resident map');
    canopy._mesh.getMatrixAt(slot, m);
    pos.setFromMatrixPosition(m);
    const { dx, dz, level } = districtCoords(key);
    assert.equal(pos.x, dx * DISTRICT_SPAN + DISTRICT_SPAN / 2);
    assert.equal(pos.z, dz * DISTRICT_SPAN + DISTRICT_SPAN / 2);
    assert.equal(pos.y, level * MAZE.LEVEL_HEIGHT + MAZE.HEDGE_HEIGHT);
  }
});

test('the slot allocator stays consistent through a churny add/drop pattern', () => {
  const { canopy } = harness();
  // 60 unique district keys, unrelated to any real neighbourhood shape - the
  // point is to drive _add/_drop with an exact, arbitrary pattern rather than
  // one shaped by neighbourhoodKeys.
  const pool = [];
  for (let dz = 0; dz < 3; dz++) {
    for (let dx = 0; dx < 20; dx++) pool.push(districtIndex(dx, dz, 0));
  }

  function checkConsistency() {
    const mesh = canopy._mesh;
    assert.equal(mesh.count, canopy._resident.size, 'mesh.count must equal the live district count');
    for (let slot = 0; slot < mesh.count; slot++) {
      const key = canopy._slotDistrict[slot];
      assert.notEqual(key, null, `slot ${slot} is below count but holds no district`);
      assert.equal(canopy._resident.get(key), slot, 'resident map disagrees with the slot table');
    }
    for (const [key, slot] of canopy._resident) {
      assert.ok(slot < mesh.count, `district ${key} claims slot ${slot}, at or beyond count ${mesh.count}`);
    }
  }

  let cursor = 0;
  const active = [];
  function add(n) {
    for (let i = 0; i < n; i++) {
      const key = pool[cursor++];
      canopy._add(key);
      active.push(key);
    }
    checkConsistency();
  }
  function dropSome(n) {
    // Deterministic pseudo-random pick, so a failure reproduces exactly.
    for (let i = 0; i < n && active.length > 0; i++) {
      const idx = (i * 7 + 3) % active.length;
      canopy._drop(active.splice(idx, 1)[0]);
    }
    checkConsistency();
  }

  add(20);
  dropSome(10);
  add(15);
  dropSome(20);
  checkConsistency();
  assert.equal(canopy._mesh.count, active.length);
});

test('disposeAll frees the single pooled mesh and empties the slot map', () => {
  const { group, canopy } = harness();
  canopy.update(10 * DISTRICT_SPAN, 10 * DISTRICT_SPAN, 0);
  let meshCount = 0;
  group.traverse((o) => { if (o.isInstancedMesh) meshCount++; });
  assert.equal(meshCount, 1);

  canopy.disposeAll();
  assert.equal(group.children.length, 0);
  assert.deepEqual(canopy.residentKeys(), []);
  assert.equal(canopy._resident.size, 0);
});
