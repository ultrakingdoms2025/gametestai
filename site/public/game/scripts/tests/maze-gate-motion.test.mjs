/**
 * The one-way gate moves, and cannot carry anyone.
 *
 * A gate's top sweeps the whole 0.45-5.0 m band on its way up, standing in
 * open corridor with no sealed shaft to earn the band exemption. If it could
 * rise under a player it would deliver them onto a hedge - Phase 2c measured
 * exactly that at 14.000 m when the same invariant was removed from the lift
 * door, and two of that phase's interlock tests were GREEN while proving
 * nothing until mutation testing found them. So the third test here is the one
 * that matters, and its red has been observed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Physics } from '../../src/physics/Physics.js';
import {
  MAZE, DIR, generateTopology, buildDistrictGraph, cellIndex, cellCoords,
  districtIndex, isOpen,
} from '../../src/worlds/maze/MazeTopology.js';
import { puzzleCells, PUZZLE } from '../../src/worlds/maze/MazePuzzles.js';
import { cellToWorld } from '../../src/worlds/maze/MazeColliders.js';
import { MazeChunks, CHUNK_MESH_KINDS } from '../../src/worlds/maze/MazeChunks.js';

const DT = 1 / 60;

function fakeGroup() { return { add() {}, remove() {} }; }
function fakeMaterials() {
  const m = {};
  for (const k of CHUNK_MESH_KINDS) m[k] = { isMaterial: true };
  m.footing = { isMaterial: true };
  m.foliage = { isMaterial: true };
  return m;
}

/** A district holding a real gate, with both its halves resident. */
function residentGate(seeds = [1, 42, 2026, 77771]) {
  for (const seed of seeds) {
    const t = generateTopology(seed);
    const graph = buildDistrictGraph(seed);
    const dOf = (idx) => {
      const c = cellCoords(idx);
      return districtIndex(Math.floor(c.x / MAZE.DISTRICT), Math.floor(c.z / MAZE.DISTRICT), c.level);
    };
    const map = puzzleCells(seed, graph, dOf(t.entranceCell), dOf(t.centreCell));
    for (const [cell, p] of map) {
      if (p.kind !== PUZZLE.GATE) continue;
      const c = cellCoords(cell);
      const world = { physics: new Physics(null), colliders: [] };
      const chunks = new MazeChunks({
        world, cells: t.cells, group: fakeGroup(), materials: fakeMaterials(), puzzles: map,
      });
      chunks.ensure(districtIndex(Math.floor(c.x / MAZE.DISTRICT), Math.floor(c.z / MAZE.DISTRICT), c.level));
      const g = chunks.liveGates().find((r) => r.cell === cell);
      if (g) return { seed, t, chunks, world, g, c };
    }
  }
  throw new Error('no resident gate found');
}

test('a gate registers with a collider, open, and knowing its forward direction', () => {
  const { g } = residentGate();
  assert.ok(g.collider, 'no collider paired with the gate');
  assert.ok([DIR.N, DIR.E, DIR.S, DIR.W].includes(g.dir), `gate has no forward direction: ${g.dir}`);
  assert.equal(g.shut, false, 'a gate starts shut - it is meant to stand open until passed');
  assert.ok(g.openY < g.closedY, 'open is not below closed');
});

test('a gate shuts once the player crosses it FORWARD, and not before', () => {
  const { g, chunks } = residentGate();
  const c = g.collider;
  const axisX = g.dir === DIR.E || g.dir === DIR.W;
  const sign = (g.dir === DIR.E || g.dir === DIR.S) ? 1 : -1;
  const at = (d) => (axisX
    ? { x: c.center.x + d * sign, y: g.closedY - c.halfExtents.y, z: c.center.z + 4 }
    : { x: c.center.x + 4, y: g.closedY - c.halfExtents.y, z: c.center.z + d * sign });

  // Approach from behind, several frames, without crossing.
  for (let i = 0; i < 30; i++) chunks.stepGates(DT, at(-2));
  assert.equal(g.shut, false, 'the gate shut before the player crossed it');

  // Cross.
  for (let i = 0; i < 30; i++) chunks.stepGates(DT, at(2));
  assert.equal(g.shut, true, 'the gate did not shut after the player crossed it forward');
});

test('a gate does NOT shut when the player only crosses it backward', () => {
  /* A gate is a committal in one direction. Shutting on a backward crossing
   * would strand a player behind a door they had just walked out of - which
   * the placement rule exists to make impossible and this keeps honest. */
  const { g, chunks } = residentGate();
  const c = g.collider;
  const axisX = g.dir === DIR.E || g.dir === DIR.W;
  const sign = (g.dir === DIR.E || g.dir === DIR.S) ? 1 : -1;
  const at = (d) => (axisX
    ? { x: c.center.x + d * sign, y: g.closedY - c.halfExtents.y, z: c.center.z + 4 }
    : { x: c.center.x + 4, y: g.closedY - c.halfExtents.y, z: c.center.z + d * sign });

  for (let i = 0; i < 30; i++) chunks.stepGates(DT, at(2));    // start in front
  g.shut = false;                                              // ignore the arrival
  for (let i = 0; i < 30; i++) chunks.stepGates(DT, at(-2));   // walk back through
  assert.equal(g.shut, false, 'the gate shut on a backward crossing');
});

test('THE GATE INTERLOCK: a gate does not move while someone stands in it', () => {
  const { g, chunks } = residentGate();
  const c = g.collider;
  g.shut = true;                                               // it wants to close
  const inGate = { x: c.center.x, y: g.closedY - c.halfExtents.y, z: c.center.z };
  const before = g.y;
  for (let i = 0; i < 240; i++) chunks.stepGates(DT, inGate);
  assert.equal(g.y, before,
    `the gate rose ${(g.y - before).toFixed(3)}m with someone standing in it - it would carry them onto a hedge`);
});

test('the gate interlock is not vacuous: step aside and the same gate closes', () => {
  const { g, chunks } = residentGate();
  const c = g.collider;
  g.shut = true;
  const away = { x: c.center.x + 40, y: g.closedY - c.halfExtents.y, z: c.center.z + 40 };
  for (let i = 0; i < 300; i++) chunks.stepGates(DT, away);
  assert.ok(Math.abs(g.y - g.closedY) < 1e-3,
    `the gate never closed even with nobody in it (${g.y.toFixed(3)} of ${g.closedY.toFixed(3)}) - `
    + 'so the test above proves nothing');
});

test('a gate never rises above the hop band ceiling', () => {
  /* Closed, its top must sit exactly ON HEDGE_HEIGHT - the same position the
   * guard rails and the lift door occupy - never inside the band. */
  const { g, c, chunks } = residentGate();
  const col = g.collider;
  g.shut = true;
  const away = { x: col.center.x + 40, y: 0, z: col.center.z + 40 };
  for (let i = 0; i < 300; i++) chunks.stepGates(DT, away);
  const floorY = cellToWorld(c.x, c.z, c.level).y;
  const top = g.y + col.halfExtents.y - floorY;
  assert.ok(Math.abs(top - MAZE.HEDGE_HEIGHT) < 1e-6,
    `a closed gate tops out at ${top.toFixed(3)}m, not at the ${MAZE.HEDGE_HEIGHT}m band ceiling`);
});

test('a dropped district takes its gates with it', () => {
  const { chunks, c } = residentGate();
  const key = districtIndex(Math.floor(c.x / MAZE.DISTRICT), Math.floor(c.z / MAZE.DISTRICT), c.level);
  assert.ok(chunks.gateCount() > 0, 'no gates registered to begin with');
  chunks.drop(key);
  assert.equal(chunks.gateCount(), 0, 'a gate survived its district being evicted');
});
