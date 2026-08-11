import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAZE, DIR, STEP, HORIZONTAL, cellIndex, isOpen,
  districtIndex, buildDistrictGraph, isEdgeOpen,
  doorwayOffset, carveDistrict,
} from '../../src/worlds/maze/MazeTopology.js';

/** Flood fill within one district's 20x20 block; returns cells reached. */
function fillWithinDistrict(cells, dx, dz, level) {
  const x0 = dx * MAZE.DISTRICT;
  const z0 = dz * MAZE.DISTRICT;
  const seen = new Set();
  const start = cellIndex(x0, z0, level);
  const stack = [[x0, z0]];
  seen.add(start);
  while (stack.length) {
    const [x, z] = stack.pop();
    const idx = cellIndex(x, z, level);
    for (const dir of HORIZONTAL) {
      if (!isOpen(cells, idx, dir)) continue;
      const [sx, sz] = STEP[dir];
      const nx = x + sx;
      const nz = z + sz;
      // stay inside this district
      if (nx < x0 || nz < z0 || nx >= x0 + MAZE.DISTRICT || nz >= z0 + MAZE.DISTRICT) continue;
      const n = cellIndex(nx, nz, level);
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push([nx, nz]);
    }
  }
  return seen.size;
}

test('doorwayOffset agrees regardless of argument order', () => {
  for (let i = 0; i < 100; i++) {
    const a = 17 + i;
    const b = 400 + i;
    assert.equal(doorwayOffset(5, a, b, 20), doorwayOffset(5, b, a, 20));
  }
});

test('doorwayOffset stays inside the span', () => {
  for (let i = 0; i < 500; i++) {
    const o = doorwayOffset(9, i, i + 1, MAZE.DISTRICT);
    assert.ok(o >= 0 && o < MAZE.DISTRICT, `offset out of range: ${o}`);
  }
});

test('a carved district is internally fully connected', () => {
  const graph = buildDistrictGraph(1234);
  const cells = new Uint8Array(MAZE.TOTAL_CELLS);
  carveDistrict(1234, graph, 3, 4, 0, cells);
  assert.equal(
    fillWithinDistrict(cells, 3, 4, 0),
    MAZE.DISTRICT * MAZE.DISTRICT,
    'district has unreachable cells',
  );
});

test('carving a district writes no cell outside it', () => {
  const graph = buildDistrictGraph(88);
  const cells = new Uint8Array(MAZE.TOTAL_CELLS);
  carveDistrict(88, graph, 5, 5, 0, cells);
  for (let z = 0; z < MAZE.CELLS; z++) {
    for (let x = 0; x < MAZE.CELLS; x++) {
      const inside = x >= 100 && x < 120 && z >= 100 && z < 120;
      if (inside) continue;
      assert.equal(cells[cellIndex(x, z, 0)], 0, `wrote outside district at ${x},${z}`);
    }
  }
});

test('neighbouring districts open the same doorway from both sides', () => {
  const seed = 555;
  const graph = buildDistrictGraph(seed);
  const cells = new Uint8Array(MAZE.TOTAL_CELLS);

  // Find an open east-west district edge on level 0.
  let found = null;
  for (let dz = 0; dz < MAZE.DISTRICTS && !found; dz++) {
    for (let dx = 0; dx < MAZE.DISTRICTS - 1; dx++) {
      const a = districtIndex(dx, dz, 0);
      const b = districtIndex(dx + 1, dz, 0);
      if (isEdgeOpen(graph, a, b)) { found = { dx, dz }; break; }
    }
  }
  assert.ok(found, 'no open east-west edge on level 0');

  carveDistrict(seed, graph, found.dx, found.dz, 0, cells);
  carveDistrict(seed, graph, found.dx + 1, found.dz, 0, cells);

  const border = found.dx * MAZE.DISTRICT + MAZE.DISTRICT - 1; // last column of left district
  let pairs = 0;
  for (let z = found.dz * MAZE.DISTRICT; z < found.dz * MAZE.DISTRICT + MAZE.DISTRICT; z++) {
    const left = cellIndex(border, z, 0);
    const right = cellIndex(border + 1, z, 0);
    const lOpen = isOpen(cells, left, DIR.E);
    const rOpen = isOpen(cells, right, DIR.W);
    assert.equal(lOpen, rOpen, `border disagrees at z=${z}`);
    if (lOpen) pairs++;
  }
  assert.equal(pairs, 1, `expected exactly one doorway, got ${pairs}`);
});

test('a closed district edge leaves a solid border', () => {
  const seed = 202;
  const graph = buildDistrictGraph(seed);
  const cells = new Uint8Array(MAZE.TOTAL_CELLS);

  let found = null;
  for (let dz = 0; dz < MAZE.DISTRICTS && !found; dz++) {
    for (let dx = 0; dx < MAZE.DISTRICTS - 1; dx++) {
      const a = districtIndex(dx, dz, 0);
      const b = districtIndex(dx + 1, dz, 0);
      if (!isEdgeOpen(graph, a, b)) { found = { dx, dz }; break; }
    }
  }
  assert.ok(found, 'no closed east-west edge on level 0');

  carveDistrict(seed, graph, found.dx, found.dz, 0, cells);
  const border = found.dx * MAZE.DISTRICT + MAZE.DISTRICT - 1;
  for (let z = found.dz * MAZE.DISTRICT; z < found.dz * MAZE.DISTRICT + MAZE.DISTRICT; z++) {
    assert.equal(isOpen(cells, cellIndex(border, z, 0), DIR.E), false, `leak at z=${z}`);
  }
});

test('carving is deterministic for a seed', () => {
  const g = buildDistrictGraph(64);
  const a = new Uint8Array(MAZE.TOTAL_CELLS);
  const b = new Uint8Array(MAZE.TOTAL_CELLS);
  carveDistrict(64, g, 2, 2, 0, a);
  carveDistrict(64, g, 2, 2, 0, b);
  assert.deepEqual(a, b);
});
