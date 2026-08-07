import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAZE, generateTopology, solve, reachableCount, cellCoords,
} from '../../src/worlds/maze/MazeTopology.js';

test('a generated maze has the expected shape', () => {
  const t = generateTopology(1);
  assert.equal(t.cells.length, MAZE.TOTAL_CELLS);
  assert.equal(t.seed, 1);
  assert.ok(t.entranceCell >= 0 && t.entranceCell < MAZE.TOTAL_CELLS);
  assert.ok(t.centreCell >= 0 && t.centreCell < MAZE.TOTAL_CELLS);
});

test('every cell on a generated level is reachable from the entrance', () => {
  const t = generateTopology(2026);
  // The whole maze is one connected component: spanning tree over districts,
  // perfect maze within each. Anything less means a player can be walled into
  // a pocket, or a prize can be placed somewhere nobody can stand.
  assert.equal(reachableCount(t.cells, t.entranceCell), MAZE.TOTAL_CELLS);
});

test('THE GATE: entrance reaches centre for 1000 consecutive seeds', () => {
  for (let seed = 0; seed < 1000; seed++) {
    const t = generateTopology(seed);
    const path = solve(t.cells, t.entranceCell, t.centreCell);
    assert.ok(path, `seed ${seed} is unsolvable`);
    assert.equal(path[0], t.entranceCell);
    assert.equal(path[path.length - 1], t.centreCell);
  }
});

test('the forced route is long enough to be worth the walk', () => {
  let total = 0;
  const runs = 40;
  for (let seed = 0; seed < runs; seed++) {
    const t = generateTopology(seed);
    total += solve(t.cells, t.entranceCell, t.centreCell).length;
  }
  const meanCells = total / runs;
  const meanMetres = meanCells * MAZE.CELL;
  // The spec claims a 4-8km forced route. Assert the floor generously; this is
  // a regression guard against a change that quietly shortens the maze, not a
  // precise measurement.
  assert.ok(meanMetres > 1500, `forced route too short: ${Math.round(meanMetres)}m`);
});

test('different seeds produce genuinely different mazes', () => {
  const a = generateTopology(11);
  const b = generateTopology(12);
  let differing = 0;
  for (let i = 0; i < MAZE.TOTAL_CELLS; i++) if (a.cells[i] !== b.cells[i]) differing++;
  const ratio = differing / MAZE.TOTAL_CELLS;
  assert.ok(ratio > 0.5, `mazes too similar: only ${Math.round(ratio * 100)}% of cells differ`);
});

test('the same seed reproduces the maze exactly', () => {
  assert.deepEqual(generateTopology(77).cells, generateTopology(77).cells);
});

test('levels option limits generation to the requested levels', () => {
  const t = generateTopology(5, { levels: 1 });
  assert.equal(cellCoords(t.entranceCell).level, 0);
  assert.equal(cellCoords(t.centreCell).level, 0);
  // Nothing above level 0 should be carved.
  for (let i = MAZE.LEVEL_CELLS; i < MAZE.TOTAL_CELLS; i++) {
    assert.equal(t.cells[i], 0, `carved above level 0 at index ${i}`);
  }
});

test('single-level generation is still fully solvable', () => {
  for (let seed = 0; seed < 200; seed++) {
    const t = generateTopology(seed, { levels: 1 });
    assert.ok(solve(t.cells, t.entranceCell, t.centreCell), `seed ${seed} unsolvable`);
    assert.equal(reachableCount(t.cells, t.entranceCell), MAZE.LEVEL_CELLS);
  }
});

test('generation is fast enough for a sub-3-second entry', () => {
  const t0 = process.hrtime.bigint();
  generateTopology(4242);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  // The spec budgets ~300ms for topology inside a 3s entry. Node is not the
  // browser, so allow generous headroom - this catches an accidental O(n^2),
  // not a 20% regression.
  assert.ok(ms < 2000, `topology took ${Math.round(ms)}ms`);
});
