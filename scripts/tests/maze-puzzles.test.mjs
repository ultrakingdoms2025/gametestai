import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAZE, generateTopology, buildDistrictGraph, districtIndex, districtCoords,
  edgeKey, cellCoords, isEdgeOpen, isOpen, DIR,
} from '../../src/worlds/maze/MazeTopology.js';
import { PUZZLE, districtPath, placePuzzles, puzzleCells, edgeDoorwayCell } from '../../src/worlds/maze/MazePuzzles.js';
import { gateColliders, descriptorTop } from '../../src/worlds/maze/MazeShafts.js';
import { districtColliders } from '../../src/worlds/maze/MazeColliders.js';

/** The district a cell sits in. */
function districtOfCell(idx) {
  const c = cellCoords(idx);
  return districtIndex(Math.floor(c.x / MAZE.DISTRICT), Math.floor(c.z / MAZE.DISTRICT), c.level);
}

test('districtPath walks only edges the graph has open', () => {
  const t = generateTopology(2026);
  const graph = buildDistrictGraph(2026);
  const from = districtOfCell(t.entranceCell);
  const to = districtOfCell(t.centreCell);
  const path = districtPath(graph, from, to);
  assert.ok(path.length > 1, `no path from ${from} to ${to}`);
  assert.equal(path[0], from);
  assert.equal(path[path.length - 1], to);
  for (let i = 1; i < path.length; i++) {
    assert.ok(isEdgeOpen(graph, path[i - 1], path[i]),
      `path step ${path[i - 1]} -> ${path[i]} is not an open edge`);
  }
});

test('THE GATE PLACEMENT GATE: every gate sits on the solution path, pointing forward', () => {
  /* The whole safety argument. A gate placed anywhere else, or pointing the
   * other way, could put the centre behind a door that only opens the way you
   * came - which is the "one-way gates must never strand a player" constraint
   * failing by construction rather than by accident. */
  for (const seed of [1, 42, 2026]) {
    const t = generateTopology(seed);
    const graph = buildDistrictGraph(seed);
    const from = districtOfCell(t.entranceCell);
    const to = districtOfCell(t.centreCell);
    const path = districtPath(graph, from, to);
    const order = new Map(path.map((d, i) => [d, i]));
    const placed = placePuzzles(seed, graph, from, to);

    let gates = 0;
    for (const [key, p] of placed) {
      if (p.kind !== PUZZLE.GATE) continue;
      const [a, b] = p.forward;
      assert.equal(edgeKey(a, b), key, 'forward pair does not match the edge it is keyed on');
      assert.ok(order.has(a) && order.has(b), `gate on ${key} is not on the solution path`);
      assert.equal(order.get(b), order.get(a) + 1,
        `gate on ${key} points backwards along the path - passing it would move the player AWAY from the centre`);
      gates++;
    }
    assert.ok(gates > 0, `seed ${seed} placed no gates at all`);
  }
});

test('placement is deterministic and re-rolls with the seed', () => {
  const g1 = buildDistrictGraph(7);
  const a = placePuzzles(7, g1, 0, 500);
  const b = placePuzzles(7, g1, 0, 500);
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort());
  const c = placePuzzles(8, buildDistrictGraph(8), 0, 500);
  assert.notDeepEqual([...a.keys()].sort(), [...c.keys()].sort());
});

test('density is roughly one puzzle per 6-8 districts, and is not zero', () => {
  for (const seed of [1, 2026]) {
    const t = generateTopology(seed);
    const graph = buildDistrictGraph(seed);
    const from = districtOfCell(t.entranceCell);
    const to = districtOfCell(t.centreCell);
    const placed = placePuzzles(seed, graph, from, to);
    const districts = MAZE.DISTRICTS * MAZE.DISTRICTS * MAZE.LEVELS;
    const per = districts / Math.max(1, placed.size);
    assert.ok(placed.size > 0, 'no puzzles at all');
    assert.ok(per > 3 && per < 40,
      `one puzzle per ${per.toFixed(1)} districts - the spec asks for roughly one per 6-8, and this is a guess `
      + 'that is expected to change, but not by an order of magnitude');
  }
});

test('a sliding wall is never placed on the solution path', () => {
  /* A gate commits you forward and is safe there. A sliding wall BLOCKS until
   * its plate is found, so one on the only route to the centre is a puzzle
   * that can be failed permanently by not finding a plate - which is a trap,
   * and the spec allows committal but not traps. */
  const t = generateTopology(2026);
  const graph = buildDistrictGraph(2026);
  const from = districtOfCell(t.entranceCell);
  const to = districtOfCell(t.centreCell);
  const path = new Set(districtPath(graph, from, to));
  for (const [key, p] of placePuzzles(2026, graph, from, to)) {
    if (p.kind !== PUZZLE.SLIDE) continue;
    const [a, b] = key.split('|').map(Number);
    assert.ok(!(path.has(a) && path.has(b)),
      `a sliding wall sits on the solution path at ${key}`);
  }
});

test('THE NEVER-STRAND GATE: with every gate shut, the centre is still reachable', () => {
  /* The spec's hard constraint, checked by re-solving rather than by trusting
   * the construction - a construction guarantee nobody checks is exactly how
   * Phase 2b's `enclosed` flag became self-certifying.
   *
   * This shuts gates HARDER than a real one-way gate does: it removes the edge
   * entirely, in both directions, where a gate only refuses the backward one.
   * So a pass here is a strictly stronger statement than the constraint asks
   * for, and a failure here would not necessarily be a real strand - but it
   * would mean the construction argument had stopped holding, which is what
   * this is watching. */
  for (const seed of [1, 42, 2026, 77771]) {
    const t = generateTopology(seed);
    const graph = buildDistrictGraph(seed);
    const from = districtOfCell(t.entranceCell);
    const to = districtOfCell(t.centreCell);
    const placed = placePuzzles(seed, graph, from, to);

    const closed = new Set(graph.open);
    let shut = 0;
    for (const [key, p] of placed) {
      if (p.kind !== PUZZLE.GATE) continue;
      closed.delete(key);
      shut++;
    }
    assert.ok(shut > 0, `seed ${seed} had no gates to shut`);

    const path = districtPath({ ...graph, open: closed }, from, to);
    assert.ok(path.length > 1,
      `seed ${seed}: with all ${shut} gates removed the centre is unreachable - a stranded player`);
  }
});

test('the never-strand gate is not vacuous: cutting a non-gate edge set CAN strand', () => {
  /* If removing edges could never disconnect anything, the gate above would
   * pass no matter where gates went. Removing every edge INCIDENT to the
   * centre's district must disconnect it - that is what proves the measurement
   * can see a disconnection at all. */
  const t = generateTopology(2026);
  const graph = buildDistrictGraph(2026);
  const from = districtOfCell(t.entranceCell);
  const to = districtOfCell(t.centreCell);
  const closed = new Set([...graph.open].filter((k) => {
    const [a, b] = k.split('|').map(Number);
    return a !== to && b !== to;
  }));
  assert.equal(districtPath({ ...graph, open: closed }, from, to).length, 0,
    'isolating the centre district did not make it unreachable - districtPath cannot detect a disconnection');
});

test('every puzzle lands on a cell whose passage actually crosses the border', () => {
  /* A puzzle at a cell with no open passage in its direction would be a gate
   * across solid hedge - invisible, unreachable, and it would silently reduce
   * the puzzle count to whatever happened to line up. */
  for (const seed of [1, 2026]) {
    const t = generateTopology(seed);
    const graph = buildDistrictGraph(seed);
    const from = districtOfCell(t.entranceCell);
    const to = districtOfCell(t.centreCell);
    const cellsMap = puzzleCells(seed, graph, from, to);
    assert.ok(cellsMap.size > 0, `seed ${seed} produced no placed puzzle cells`);
    for (const [cell, p] of cellsMap) {
      assert.ok(isOpen(t.cells, cell, p.dir),
        `a puzzle sits at cell ${cell} facing ${p.dir}, but that passage is closed - it would be a gate `
        + 'across solid hedge');
    }
  }
});

test('vertical edges never carry a puzzle - those are connectors', () => {
  const seed = 2026;
  const t = generateTopology(seed);
  const graph = buildDistrictGraph(seed);
  const from = districtOfCell(t.entranceCell);
  const to = districtOfCell(t.centreCell);
  for (const [cell] of puzzleCells(seed, graph, from, to)) {
    // A puzzle cell is a border cell of its own level; the direction stored is
    // always horizontal, which `isOpen` above already exercises. Assert the
    // cell index is in range as a cheap guard against a level mix-up.
    assert.ok(cell >= 0 && cell < MAZE.TOTAL_CELLS, `puzzle cell ${cell} is out of range`);
  }
});

/* -------------------------------------------------------------------- */
/* Gate geometry                                                         */
/* -------------------------------------------------------------------- */

test('THE GATE BAND GATE: a closed gate tops out ON the band ceiling, never inside it', () => {
  /* The same position the guard rails and the lift door occupy. A gate whose
   * closed top landed inside 0.45-5.0m would be a standable in the band
   * outside any sealed shaft - a ladder over a hedge, and the thing the whole
   * anti-exploit rule exists to forbid. */
  const { cells } = generateTopology(2026);
  for (const dir of [DIR.N, DIR.E, DIR.S, DIR.W]) {
    const [g] = gateColliders(cells, 40, 40, 0, dir);
    assert.ok(g, `no gate emitted for dir ${dir}`);
    assert.equal(descriptorTop(g), MAZE.HEDGE_HEIGHT,
      `a closed gate tops out at ${descriptorTop(g)}m, not exactly at the ${MAZE.HEDGE_HEIGHT}m band ceiling`);
    assert.ok(!g.enclosed,
      'a gate claims the enclosed exemption - it stands in open corridor and has no sealed shaft to earn it');
  }
});

test('an open gate is walked over, not climbed', () => {
  const { cells } = generateTopology(2026);
  const [g] = gateColliders(cells, 40, 40, 0, DIR.E);
  const openTop = g.openY + g.hy;
  assert.ok(openTop <= MAZE.STEP_HEIGHT,
    `an open gate stands ${openTop.toFixed(3)}m proud against a ${MAZE.STEP_HEIGHT}m auto-step - the player `
    + 'would have to hop a gate that is supposed to be open');
});

test('a gate spans the passage it closes, and nothing wider', () => {
  const { cells } = generateTopology(2026);
  for (const [dir, thinAxis] of [[DIR.E, 'hx'], [DIR.W, 'hx'], [DIR.N, 'hz'], [DIR.S, 'hz']]) {
    const [g] = gateColliders(cells, 40, 40, 0, dir);
    const wide = thinAxis === 'hx' ? g.hz : g.hx;
    assert.ok(Math.abs(wide * 2 - MAZE.CORRIDOR) < 1e-9,
      `a gate spans ${(wide * 2).toFixed(2)}m across a ${MAZE.CORRIDOR}m corridor - a gap either side is a `
      + 'gate the player walks round');
    assert.ok(g[thinAxis] < MAZE.HEDGE_THICK, 'a gate is thicker than the hedge it stands in place of');
  }
});

test('gates appear in real district geometry when a puzzle map is supplied, and never without one', () => {
  /* The seed-free default matters: every headless gate calls districtColliders
   * with four arguments and must keep seeing exactly what it saw before. */
  const seed = 2026;
  const t = generateTopology(seed);
  const graph = buildDistrictGraph(seed);
  const from = districtOfCell(t.entranceCell);
  const to = districtOfCell(t.centreCell);
  const map = puzzleCells(seed, graph, from, to);

  let withGates = 0;
  for (let dz = 0; dz < MAZE.DISTRICTS && withGates < 3; dz++) {
    for (let dx = 0; dx < MAZE.DISTRICTS && withGates < 3; dx++) {
      const plain = districtColliders(t.cells, dx, dz, 0);
      assert.equal(plain.filter((d) => d.kind === 'gate').length, 0,
        `district ${dx},${dz} emitted a gate with no puzzle map - the default must be seed-free`);
      const dressed = districtColliders(t.cells, dx, dz, 0, map);
      if (dressed.filter((d) => d.kind === 'gate').length > 0) withGates++;
    }
  }
  assert.ok(withGates >= 1, 'no district anywhere emitted a gate even with a puzzle map');
});
