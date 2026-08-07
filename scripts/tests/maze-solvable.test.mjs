import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAZE, generateTopology, solve, reachableCount, cellCoords,
} from '../../src/worlds/maze/MazeTopology.js';

const SEEDS = Number(process.env.MAZE_SEEDS ?? 200);
const FULL_GATE_SEEDS = 1000;

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

test(`THE GATE: entrance reaches centre for ${SEEDS} consecutive seeds${SEEDS < FULL_GATE_SEEDS ? ` (full gate requires MAZE_SEEDS=${FULL_GATE_SEEDS})` : ''}`, () => {
  for (let seed = 0; seed < SEEDS; seed++) {
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
  for (let seed = 0; seed < Math.max(40, Math.ceil(SEEDS * 0.2)); seed++) {
    const t = generateTopology(seed, { levels: 1 });
    assert.ok(solve(t.cells, t.entranceCell, t.centreCell), `seed ${seed} unsolvable`);
    assert.equal(reachableCount(t.cells, t.entranceCell), MAZE.LEVEL_CELLS);
  }
});

test('two-level generation is still fully solvable', () => {
  for (let seed = 0; seed < Math.max(20, Math.ceil(SEEDS * 0.1)); seed++) {
    const t = generateTopology(seed, { levels: 2 });
    assert.ok(solve(t.cells, t.entranceCell, t.centreCell), `seed ${seed} unsolvable`);
    assert.equal(reachableCount(t.cells, t.entranceCell), MAZE.LEVEL_CELLS * 2);
  }
});

test('limited-level generation includes loops and route choice', () => {
  const t1 = generateTopology(42, { levels: 1 });
  const t2 = generateTopology(42, { levels: 2 });
  // Single-level maze should have more than 399 edges (399 are tree edges for 400 districts)
  const minEdgesPerLevel = 400 - 1; // minimum spanning tree edges
  const expectedExtraEdgesPerLevel = Math.floor(minEdgesPerLevel * 0.1); // roughly 10% extra
  assert.ok(t1.graph.open.size > minEdgesPerLevel, `single-level graph has no extra edges: ${t1.graph.open.size} <= ${minEdgesPerLevel}`);
  assert.ok(t2.graph.open.size > minEdgesPerLevel * 2, `two-level graph too sparse: ${t2.graph.open.size} <= ${minEdgesPerLevel * 2}`);
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
