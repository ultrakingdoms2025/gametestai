import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAZE, DIR, OPPOSITE, STEP,
  hash32, mulberry32, cellIndex, cellCoords, isOpen,
  districtIndex, districtCoords, edgeKey, buildDistrictGraph, isEdgeOpen,
} from '../../src/worlds/maze/MazeTopology.js';

test('constants match the spec', () => {
  assert.equal(MAZE.CELL, 6.0);
  assert.equal(MAZE.CORRIDOR, 4.8);
  assert.equal(MAZE.HEDGE_THICK, 1.2);
  assert.equal(MAZE.HEDGE_HEIGHT, 5.0);
  assert.equal(MAZE.DISTRICT, 20);
  assert.equal(MAZE.DISTRICTS, 20);
  assert.equal(MAZE.LEVELS, 4);
  // Corridor plus hedge must equal exactly one cell pitch, or the grid drifts.
  assert.equal(MAZE.CORRIDOR + MAZE.HEDGE_THICK, MAZE.CELL);
  assert.equal(MAZE.CELLS, MAZE.DISTRICT * MAZE.DISTRICTS);
  assert.equal(MAZE.LEVEL_CELLS, MAZE.CELLS * MAZE.CELLS);
  assert.equal(MAZE.TOTAL_CELLS, MAZE.LEVEL_CELLS * MAZE.LEVELS);
  assert.equal(MAZE.TOTAL_CELLS, 640000);
});

test('direction bits are distinct and opposites pair up', () => {
  const all = [DIR.N, DIR.E, DIR.S, DIR.W, DIR.UP, DIR.DOWN];
  assert.equal(new Set(all).size, 6);
  for (const d of all) assert.equal(OPPOSITE[OPPOSITE[d]], d);
  assert.equal(OPPOSITE[DIR.N], DIR.S);
  assert.equal(OPPOSITE[DIR.E], DIR.W);
  assert.equal(OPPOSITE[DIR.UP], DIR.DOWN);
});

test('N is -z and S is +z, E is +x and W is -x', () => {
  assert.deepEqual(STEP[DIR.N], [0, -1]);
  assert.deepEqual(STEP[DIR.S], [0, 1]);
  assert.deepEqual(STEP[DIR.E], [1, 0]);
  assert.deepEqual(STEP[DIR.W], [-1, 0]);
});

test('hash32 is deterministic, order-sensitive and unsigned', () => {
  assert.equal(hash32(1, 2, 3), hash32(1, 2, 3));
  assert.notEqual(hash32(1, 2, 3), hash32(3, 2, 1));
  for (let i = 0; i < 500; i++) {
    const h = hash32(i, i * 7, 99);
    assert.ok(h >= 0 && h <= 0xffffffff, `hash out of range: ${h}`);
    assert.ok(Number.isInteger(h));
  }
});

test('mulberry32 is deterministic and stays in [0,1)', () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  for (let i = 0; i < 200; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1, `rng out of range: ${v}`);
  }
});

test('mulberry32 is reasonably uniform', () => {
  const rng = mulberry32(999);
  const buckets = new Array(10).fill(0);
  for (let i = 0; i < 100000; i++) buckets[Math.floor(rng() * 10)]++;
  // 10k expected per bucket; allow +-15%.
  for (const b of buckets) assert.ok(b > 8500 && b < 11500, `skewed bucket: ${b}`);
});

test('cellIndex and cellCoords round-trip', () => {
  const cases = [
    { x: 0, z: 0, level: 0 },
    { x: 399, z: 399, level: 3 },
    { x: 17, z: 240, level: 2 },
  ];
  for (const c of cases) {
    const i = cellIndex(c.x, c.z, c.level);
    assert.ok(i >= 0 && i < MAZE.TOTAL_CELLS);
    assert.deepEqual(cellCoords(i), c);
  }
});

test('cellIndex is unique across a whole level', () => {
  const seen = new Set();
  for (let z = 0; z < MAZE.CELLS; z++) {
    for (let x = 0; x < MAZE.CELLS; x++) seen.add(cellIndex(x, z, 0));
  }
  assert.equal(seen.size, MAZE.LEVEL_CELLS);
});

test('isOpen reads passage bits', () => {
  const cells = new Uint8Array(4);
  cells[1] = DIR.N | DIR.W;
  assert.equal(isOpen(cells, 1, DIR.N), true);
  assert.equal(isOpen(cells, 1, DIR.W), true);
  assert.equal(isOpen(cells, 1, DIR.E), false);
  assert.equal(isOpen(cells, 0, DIR.N), false);
});

const TOTAL_DISTRICTS = MAZE.DISTRICTS * MAZE.DISTRICTS * MAZE.LEVELS; // 1600

test('districtIndex round-trips and is unique', () => {
  const seen = new Set();
  for (let level = 0; level < MAZE.LEVELS; level++) {
    for (let dz = 0; dz < MAZE.DISTRICTS; dz++) {
      for (let dx = 0; dx < MAZE.DISTRICTS; dx++) {
        const i = districtIndex(dx, dz, level);
        seen.add(i);
        assert.deepEqual(districtCoords(i), { dx, dz, level });
      }
    }
  }
  assert.equal(seen.size, TOTAL_DISTRICTS);
});

test('edgeKey is canonical regardless of argument order', () => {
  assert.equal(edgeKey(5, 9), edgeKey(9, 5));
  assert.notEqual(edgeKey(5, 9), edgeKey(5, 10));
});

test('the district graph connects every district', () => {
  const graph = buildDistrictGraph(4242);
  // Flood fill the open edges from district 0 and demand we reach all 1600.
  const seen = new Uint8Array(TOTAL_DISTRICTS);
  const stack = [0];
  seen[0] = 1;
  let reached = 1;
  while (stack.length) {
    const cur = stack.pop();
    const { dx, dz, level } = districtCoords(cur);
    const neighbours = [
      [dx, dz - 1, level], [dx + 1, dz, level],
      [dx, dz + 1, level], [dx - 1, dz, level],
      [dx, dz, level - 1], [dx, dz, level + 1],
    ];
    for (const [nx, nz, nl] of neighbours) {
      if (nx < 0 || nz < 0 || nl < 0) continue;
      if (nx >= MAZE.DISTRICTS || nz >= MAZE.DISTRICTS || nl >= MAZE.LEVELS) continue;
      const n = districtIndex(nx, nz, nl);
      if (seen[n]) continue;
      if (!isEdgeOpen(graph, cur, n)) continue;
      seen[n] = 1;
      reached++;
      stack.push(n);
    }
  }
  assert.equal(reached, TOTAL_DISTRICTS, 'district graph is disconnected');
});

test('the graph is mostly a tree, with roughly 10% extra edges', () => {
  const graph = buildDistrictGraph(7);
  assert.equal(graph.treeEdges, TOTAL_DISTRICTS - 1, 'spanning tree must have n-1 edges');
  // ~10% of the *remaining* candidate edges. Loose bounds - this is a
  // character check, not an exact count.
  assert.ok(graph.extraEdges > 100, `too few loops: ${graph.extraEdges}`);
  assert.ok(graph.extraEdges < 700, `too many loops: ${graph.extraEdges}`);
});

test('entrance is fixed and centre is on a seed-chosen level', () => {
  const levels = new Set();
  for (let s = 0; s < 200; s++) {
    const g = buildDistrictGraph(s);
    assert.deepEqual(g.entrance, { dx: 10, dz: 0, level: 0 });
    assert.equal(g.centre.dx, 10);
    assert.equal(g.centre.dz, 10);
    levels.add(g.centre.level);
  }
  // The player must not be able to learn which level the prize is on.
  assert.ok(levels.size >= 3, `centre level barely varies: ${[...levels]}`);
});

test('the same seed always builds the same graph', () => {
  const a = buildDistrictGraph(31337);
  const b = buildDistrictGraph(31337);
  assert.deepEqual([...a.open].sort(), [...b.open].sort());
  const c = buildDistrictGraph(31338);
  assert.notDeepEqual([...a.open].sort(), [...c.open].sort());
});
