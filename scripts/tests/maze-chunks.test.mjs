import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Physics } from '../../src/physics/Physics.js';
import { MAZE, generateTopology, districtIndex } from '../../src/worlds/maze/MazeTopology.js';
import { MazeChunks } from '../../src/worlds/maze/MazeChunks.js';

function harness(seed = 2026) {
  const t = generateTopology(seed, { levels: 1 });
  const physics = new Physics(null);
  const group = new THREE.Group();
  // Stand in for the World: MazeChunks reads `physics` and `colliders` off it
  // on every call, because WorldManager swaps them mid-build.
  const world = { physics, colliders: [] };
  const materials = {
    hedge: new THREE.MeshStandardMaterial(),
    floor: new THREE.MeshStandardMaterial(),
  };
  const chunks = new MazeChunks({ world, cells: t.cells, group, materials });
  return { t, physics, group, world, colliders: world.colliders, chunks, materials };
}

test('chunks follow the world when its physics instance is swapped', () => {
  /* WorldManager builds a world against a scratch Physics and restores the real
   * one afterwards. A MazeChunks that captured `physics` in its constructor
   * would keep streaming into the discarded scratch world, and every district
   * loaded after arrival would be walk-through-able. */
  const { chunks, world } = harness();
  chunks.ensure(districtIndex(1, 1, 0));
  const scratch = world.physics;
  assert.ok(scratch.colliders.length > 0);

  const live = new Physics(null);
  world.physics = live;                       // the swap WorldManager performs
  chunks.ensure(districtIndex(2, 1, 0));

  assert.ok(live.colliders.length > 0, 'new chunk did not reach the live physics world');
  assert.equal(scratch.colliders.length, chunks._resident.get(districtIndex(1, 1, 0)).colliders.length,
    'the old chunk should still be accounted for in the scratch world');
});

test('ensure builds a district exactly once', () => {
  const { physics, chunks } = harness();
  const key = districtIndex(3, 4, 0);
  chunks.ensure(key);
  const after = physics.colliders.length;
  assert.ok(after > 0, 'no colliders registered');
  chunks.ensure(key);
  assert.equal(physics.colliders.length, after, 'second ensure rebuilt the district');
  assert.deepEqual(chunks.residentKeys(), [key]);
});

test('drop releases every collider and mesh it added', () => {
  const { physics, group, colliders, chunks } = harness();
  const key = districtIndex(3, 4, 0);
  chunks.ensure(key);
  assert.ok(physics.colliders.length > 0);
  assert.equal(colliders.length, physics.colliders.length, 'world array out of step');
  chunks.drop(key);
  assert.equal(physics.colliders.length, 0, 'colliders leaked');
  assert.equal(colliders.length, 0, 'world collider array leaked');
  assert.equal(group.children.length, 0, 'meshes leaked');
  assert.deepEqual(chunks.residentKeys(), []);
  assert.equal(physics._grid.size, 0, 'broadphase buckets leaked');
});

test('dropping an absent district is a no-op', () => {
  const { physics, chunks } = harness();
  chunks.drop(districtIndex(9, 9, 0));
  assert.equal(physics.colliders.length, 0);
});

test('add and drop repeatedly does not leak', () => {
  const { physics, group, colliders, chunks } = harness();
  const key = districtIndex(6, 6, 0);
  for (let i = 0; i < 50; i++) { chunks.ensure(key); chunks.drop(key); }
  assert.equal(physics.colliders.length, 0);
  assert.equal(colliders.length, 0);
  assert.equal(group.children.length, 0);
  assert.equal(physics._grid.size, 0);
});

test('chunks share the world material set rather than allocating their own', () => {
  const { group, chunks, materials } = harness();
  chunks.ensure(districtIndex(1, 1, 0));
  chunks.ensure(districtIndex(2, 1, 0));
  const used = new Set();
  group.traverse((o) => { if (o.material) used.add(o.material); });
  for (const m of used) {
    assert.ok(m === materials.hedge || m === materials.floor,
      'a chunk allocated its own material');
  }
});

test('a resident district is solid and has floor', () => {
  const { physics, chunks } = harness();
  chunks.ensure(districtIndex(2, 2, 0));
  // Centre of that district, in world metres.
  const x = (2 * MAZE.DISTRICT + 10) * MAZE.CELL;
  const z = (2 * MAZE.DISTRICT + 10) * MAZE.CELL;
  assert.notEqual(physics.groundHeight(x, z, 5, 12), null, 'no floor in a resident district');
});

test('a dropped district has no floor left behind', () => {
  const { physics, chunks } = harness();
  const key = districtIndex(2, 2, 0);
  chunks.ensure(key);
  const x = (2 * MAZE.DISTRICT + 10) * MAZE.CELL;
  const z = (2 * MAZE.DISTRICT + 10) * MAZE.CELL;
  chunks.drop(key);
  assert.equal(physics.groundHeight(x, z, 5, 12), null, 'floor survived the drop');
});

test('disposeAll clears everything', () => {
  const { physics, group, colliders, chunks } = harness();
  for (const k of [districtIndex(0,0,0), districtIndex(1,0,0), districtIndex(0,1,0)]) chunks.ensure(k);
  chunks.disposeAll();
  assert.equal(physics.colliders.length, 0);
  assert.equal(colliders.length, 0);
  assert.equal(group.children.length, 0);
  assert.deepEqual(chunks.residentKeys(), []);
});
