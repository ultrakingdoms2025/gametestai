import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAZE, DIR, OPPOSITE, STEP,
  hash32, mulberry32, cellIndex, cellCoords, isOpen,
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
