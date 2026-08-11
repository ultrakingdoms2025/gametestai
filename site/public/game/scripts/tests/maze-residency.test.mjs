import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAZE, DISTRICT_SPAN, districtIndex, districtCoords,
  districtAtWorld, neighbourhoodKeys,
} from '../../src/worlds/maze/MazeTopology.js';

test('DISTRICT_SPAN is a district edge in metres', () => {
  assert.equal(DISTRICT_SPAN, MAZE.DISTRICT * MAZE.CELL);
  assert.equal(DISTRICT_SPAN, 120);
});

test('districtAtWorld maps a position to its district', () => {
  // Derived from the geometry rule: cell = round(x / CELL), district = floor(cell / DISTRICT).
  // The district boundary crosses where Math.round(x / CELL) changes district value.
  assert.equal(districtAtWorld(0, 0, 0), districtIndex(0, 0, 0));
  assert.equal(districtAtWorld(116, 0, 0), districtIndex(0, 0, 0));
  assert.equal(districtAtWorld(117, 0, 0), districtIndex(1, 0, 0));
  assert.equal(districtAtWorld(236, 0, 0), districtIndex(1, 0, 0));
  assert.equal(districtAtWorld(237, 0, 0), districtIndex(2, 0, 0));
});

test('districtAtWorld clamps rather than going out of bounds', () => {
  // The forecourt sits in negative z, outside the grid; it must not produce a
  // negative index or the residency set would silently be empty there.
  assert.equal(districtAtWorld(1260, -40, 0), districtIndex(10, 0, 0));
  assert.equal(districtAtWorld(-500, -500, 0), districtIndex(0, 0, 0));
  const last = MAZE.DISTRICTS - 1;
  assert.equal(districtAtWorld(99999, 99999, 0), districtIndex(last, last, 0));
});

test('neighbourhoodKeys returns the 5x5 block for radius 2 in open ground', () => {
  const keys = neighbourhoodKeys(districtIndex(10, 10, 0), 2);
  assert.equal(keys.length, 25);
  for (const k of keys) {
    const c = districtCoords(k);
    assert.equal(c.level, 0);
    assert.ok(Math.abs(c.dx - 10) <= 2 && Math.abs(c.dz - 10) <= 2);
  }
  assert.ok(keys.includes(districtIndex(10, 10, 0)), 'centre must be resident');
});

test('neighbourhoodKeys clips at the grid edge', () => {
  const keys = neighbourhoodKeys(districtIndex(0, 0, 0), 2);
  assert.equal(keys.length, 9, 'a corner sees only 3x3');
  for (const k of keys) {
    const c = districtCoords(k);
    assert.ok(c.dx >= 0 && c.dz >= 0 && c.dx <= 2 && c.dz <= 2);
  }
});

test('neighbourhoodKeys is sorted and duplicate-free', () => {
  const keys = neighbourhoodKeys(districtIndex(5, 7, 0), 2);
  assert.deepEqual(keys, [...keys].sort((a, b) => a - b));
  assert.equal(new Set(keys).size, keys.length);
});

test('neighbourhoodKeys stays on its own level', () => {
  const keys = neighbourhoodKeys(districtIndex(10, 10, 2), 2);
  for (const k of keys) assert.equal(districtCoords(k).level, 2);
});

test('districtAtWorld agrees with the geometry about who owns a point', () => {
  // The grid's own rule: cell = round(x / CELL), clamped to [0, CELLS), district = floor(cell / DISTRICT).
  // Anything else drifts at district boundaries, where residency decisions happen.
  const geo = (v) => {
    const cell = Math.min(MAZE.CELLS - 1, Math.max(0, Math.round(v / MAZE.CELL)));
    return Math.min(MAZE.DISTRICTS - 1, Math.max(0, Math.floor(cell / MAZE.DISTRICT)));
  };
  for (let x = 0; x < MAZE.CELLS * MAZE.CELL; x += 1) {
    assert.equal(districtCoords(districtAtWorld(x, 60, 0)).dx, geo(x), `x=${x}`);
  }
  for (let z = 0; z < MAZE.CELLS * MAZE.CELL; z += 1) {
    assert.equal(districtCoords(districtAtWorld(1260, z, 0)).dz, geo(z), `z=${z}`);
  }
});
