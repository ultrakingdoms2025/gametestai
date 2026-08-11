/**
 * The sliding hedge wall, its plate, and the mesh that has to follow.
 *
 * Two independent things are proven here.
 *
 * THE INTERLOCK. A wall's top travels the whole 0.45-5.0 m band in open
 * corridor, with no sealed shaft to earn the anti-ladder exemption, so a wall
 * that could close under a standing player would carry them onto a hedge -
 * Phase 2c measured exactly that at 14.000 m when the same invariant was
 * removed from the lift door. The wall shares `stepGates` with the one-way
 * gate precisely so there is one implementation of that guard.
 *
 * THE MESH FOLLOWS THE COLLIDER. Measured in the browser before this file
 * existed: a lift car's collider rode the full 8.700 m to its landing while
 * its mesh sat at 0.150. Gates had no mesh at all. Both looked correct
 * standing still, which is why neither was caught by anything written up to
 * that point.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Physics } from '../../src/physics/Physics.js';
import {
  MAZE, DIR, generateTopology, buildDistrictGraph, cellCoords, districtIndex, isOpen, cellIndex,
} from '../../src/worlds/maze/MazeTopology.js';
import { puzzleCells, PUZZLE } from '../../src/worlds/maze/MazePuzzles.js';
import { PLATE_HALF_HEIGHT, slidingWallColliders } from '../../src/worlds/maze/MazeShafts.js';
import { cellToWorld } from '../../src/worlds/maze/MazeColliders.js';
import { MazeChunks, CHUNK_MESH_KINDS } from '../../src/worlds/maze/MazeChunks.js';

const DT = 1 / 60;

function fakeGroup() { return { add() {}, remove() {} }; }
function fakeMaterials() {
  const m = {};
  for (const k of CHUNK_MESH_KINDS) m[k] = { isMaterial: true };
  for (const k of ['footing', 'foliage', 'candle', 'plate']) m[k] = { isMaterial: true };
  return m;
}

/** A district holding a real sliding wall, resident. */
function residentWall(seeds = [1, 42, 2026, 77771, 5, 9]) {
  for (const seed of seeds) {
    const t = generateTopology(seed);
    const graph = buildDistrictGraph(seed);
    const dOf = (idx) => {
      const c = cellCoords(idx);
      return districtIndex(Math.floor(c.x / MAZE.DISTRICT), Math.floor(c.z / MAZE.DISTRICT), c.level);
    };
    const map = puzzleCells(seed, graph, dOf(t.entranceCell), dOf(t.centreCell));
    for (const [cell, p] of map) {
      if (p.kind !== PUZZLE.SLIDE) continue;
      const c = cellCoords(cell);
      const world = { physics: new Physics(null), colliders: [] };
      const chunks = new MazeChunks({
        world, cells: t.cells, group: fakeGroup(), materials: fakeMaterials(), puzzles: map,
      });
      chunks.ensure(districtIndex(Math.floor(c.x / MAZE.DISTRICT), Math.floor(c.z / MAZE.DISTRICT), c.level));
      const g = chunks.liveGates().find((r) => r.cell === cell);
      if (g) return { seed, t, chunks, g, c, map };
    }
  }
  throw new Error('no resident sliding wall found');
}

test('a sliding wall rests SHUT, blocking its doorway', () => {
  /* The inversion that makes it a wall rather than a gate. One that started
   * open would be a decoration on a corridor you can already walk down. */
  const { g } = residentWall();
  assert.ok(g.collider, 'no collider paired with the wall');
  assert.equal(g.slide, true, 'not registered as a sliding wall');
  assert.equal(g.shut, true, 'a sliding wall started open');
  assert.ok(Math.abs(g.y - g.closedY) < 1e-6, `it rests at ${g.y}, not at its closed height`);
  assert.ok(g.openY < g.closedY, 'open is not below closed');
});

test('a closed wall tops out ON the band ceiling, never inside it', () => {
  const { g, c } = residentWall();
  const floorY = cellToWorld(c.x, c.z, c.level).y;
  const top = g.y + g.collider.halfExtents.y - floorY;
  assert.ok(Math.abs(top - MAZE.HEDGE_HEIGHT) < 1e-6,
    `a shut wall tops out at ${top.toFixed(3)}m, not at the ${MAZE.HEDGE_HEIGHT}m band ceiling`);
});

test('the plate sits on a straight, open run back from the wall', () => {
  /* "A pressure plate opens a wall elsewhere IN SIGHT" - and line of sight in
   * a hedge maze is a straight corridor and nothing else. Walking the run here
   * rather than trusting the placement is the point: an off-by-one in the
   * direction would put the plate inside a hedge, where it is unreachable and
   * reads as a wall that simply never opens. */
  const { t, g, c } = residentWall();
  const back = g.dir === DIR.E ? DIR.W : g.dir === DIR.W ? DIR.E
    : g.dir === DIR.S ? DIR.N : DIR.S;
  const dx = g.dir === DIR.E ? 1 : g.dir === DIR.W ? -1 : 0;
  const dz = g.dir === DIR.S ? 1 : g.dir === DIR.N ? -1 : 0;

  let px = c.x, pz = c.z;
  for (let step = 0; step < 64; step++) {
    const here = cellIndex(px, pz, c.level);
    if (here === g.plate.cell) break;
    assert.ok(isOpen(t.cells, here, back),
      `the run from the wall to its plate is blocked at cell ${px},${pz}`);
    px -= dx; pz -= dz;
  }
  assert.equal(cellIndex(px, pz, c.level), g.plate.cell, 'never reached the plate walking back');

  const w = cellToWorld(px, pz, c.level);
  assert.ok(Math.abs(g.plate.x - w.x) < 1e-6 && Math.abs(g.plate.z - w.z) < 1e-6,
    'the plate is not at the cell the straight run ends at');
  assert.ok(Math.abs(g.plate.y - (w.y + PLATE_HALF_HEIGHT)) < 1e-6,
    `the plate sits at ${g.plate.y}, not flush with its own floor`);
  assert.ok(g.plate.y - w.y < MAZE.STEP_HEIGHT,
    'a plate taller than the auto-step is a kerb, not a plate');
});

test('no wall is built with its plate close enough to be an automatic door', () => {
  /* Measured over 2,323 candidates across twelve seeds: the straight run back
   * from a doorway is zero cells 46% of the time, because a hedge maze turns
   * constantly and most doorways are corners. A plate in the doorway cell is
   * three metres from its wall - walk up, you are already on the trigger, it
   * opens. Those are dropped rather than built, which is why this sweeps every
   * candidate instead of checking the first wall it finds: the bar has to hold
   * for all of them or it is not a bar. */
  let built = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const t = generateTopology(seed);
    const graph = buildDistrictGraph(seed);
    const dOf = (idx) => {
      const c = cellCoords(idx);
      return districtIndex(Math.floor(c.x / MAZE.DISTRICT), Math.floor(c.z / MAZE.DISTRICT), c.level);
    };
    const map = puzzleCells(seed, graph, dOf(t.entranceCell), dOf(t.centreCell));
    for (const [cell, p] of map) {
      if (p.kind !== PUZZLE.SLIDE) continue;
      const c = cellCoords(cell);
      const [d] = slidingWallColliders(t.cells, c.x, c.z, c.level, p.dir);
      if (!d) continue;                 // dropped by the bar, which is the point
      built++;
      const gap = Math.hypot(d.plate.x - d.cx, d.plate.z - d.cz);
      assert.ok(gap >= MAZE.CELL + MAZE.CELL / 2 - 1e-6,
        `seed ${seed}: a wall stands ${gap.toFixed(1)}m from its own plate - that is a door, not a puzzle`);
    }
  }
  assert.ok(built > 300,
    `only ${built} walls survived the bar across six seeds - it is rejecting nearly everything`);
});

test('standing on the plate opens the wall, and it STAYS open', () => {
  /* Latching, not hold-to-open. A plate that shuts the wall again when you
   * step off is a door that needs two people, and there is only ever one. */
  const { g, chunks } = residentWall();
  const onPlate = { x: g.plate.x, y: g.plate.y, z: g.plate.z };
  for (let i = 0; i < 400; i++) chunks.stepGates(DT, onPlate);
  assert.ok(Math.abs(g.y - g.openY) < 1e-3,
    `the wall is at ${g.y.toFixed(3)} of an open ${g.openY.toFixed(3)} after standing on its plate`);

  const away = { x: g.plate.x + 60, y: g.plate.y, z: g.plate.z + 60 };
  for (let i = 0; i < 400; i++) chunks.stepGates(DT, away);
  assert.ok(Math.abs(g.y - g.openY) < 1e-3,
    'the wall closed again once the player stepped off - nobody alone can pass that');
});

test('the wall does NOT open for someone who never finds the plate', () => {
  /* Without this the test above proves only that time passes. */
  const { g, chunks } = residentWall();
  const c = g.collider;
  const nearWall = { x: c.center.x + 3, y: g.closedY - c.halfExtents.y, z: c.center.z + 3 };
  for (let i = 0; i < 600; i++) chunks.stepGates(DT, nearWall);
  assert.ok(Math.abs(g.y - g.closedY) < 1e-6,
    `the wall opened without its plate being touched (${g.y} vs ${g.closedY})`);
});

test('THE WALL INTERLOCK: it does not move while someone stands in it', () => {
  const { g, chunks } = residentWall();
  const c = g.collider;
  /* Drive it open first, then ask it to shut with someone in the doorway -
   * closing is the direction that would carry a rider up onto a hedge. */
  g.shut = false;
  const away = { x: c.center.x + 60, y: 0, z: c.center.z + 60 };
  for (let i = 0; i < 400; i++) chunks.stepGates(DT, away);
  assert.ok(Math.abs(g.y - g.openY) < 1e-3, 'the wall never opened - the setup failed');

  g.shut = true;
  const inWall = { x: c.center.x, y: g.openY + c.halfExtents.y, z: c.center.z };
  const before = g.y;
  for (let i = 0; i < 400; i++) chunks.stepGates(DT, inWall);
  assert.equal(g.y, before,
    `the wall rose ${(g.y - before).toFixed(3)}m with someone standing in it - `
    + 'it would carry them onto a hedge');
});

test('the wall interlock is not vacuous: step aside and the same wall shuts', () => {
  const { g, chunks } = residentWall();
  const c = g.collider;
  g.shut = false;
  const away = { x: c.center.x + 60, y: 0, z: c.center.z + 60 };
  for (let i = 0; i < 400; i++) chunks.stepGates(DT, away);
  g.shut = true;
  for (let i = 0; i < 400; i++) chunks.stepGates(DT, away);
  assert.ok(Math.abs(g.y - g.closedY) < 1e-3,
    `the wall never shut with nobody in it (${g.y.toFixed(3)} of ${g.closedY.toFixed(3)}) - `
    + 'so the test above proves nothing');
});

test('a dropped district takes its sliding walls with it', () => {
  const { chunks, c } = residentWall();
  const key = districtIndex(Math.floor(c.x / MAZE.DISTRICT), Math.floor(c.z / MAZE.DISTRICT), c.level);
  assert.ok(chunks.gateCount() > 0, 'no walls registered to begin with');
  chunks.drop(key);
  assert.equal(chunks.gateCount(), 0, 'a sliding wall survived its district being evicted');
});

test('every moving kind is a kind that gets drawn', () => {
  /* A gate was a solid, invisible wall across a corridor for an entire phase,
   * because `CHUNK_MESH_KINDS` never listed it and nothing said it must. */
  for (const kind of ['lift', 'liftDoor', 'gate', 'slideWall']) {
    assert.ok(CHUNK_MESH_KINDS.includes(kind),
      `${kind} moves but is never turned into a mesh - it would be an invisible solid`);
  }
});

test('THE MESH GATE: a moving wall carries its drawn box with it', () => {
  /* The measured failure: collider at 8.850, mesh at 0.150. `stepGates` and
   * `stepLifts` moved the physics box and nothing else, so every moving part
   * in the maze was a solid that stayed where it was drawn.
   *
   * The stand-in below records what the sync writes. Real three is not
   * importable in this tier, and the thing under test is that the mesh is
   * driven to the collider's new Y - not how a Matrix4 stores it. */
  const { g, chunks } = residentWall();
  const seen = [];
  /* A plain Array, because `THREE.Matrix4.elements` is one - a typed array
   * here would give the stand-in a `.set` the real thing does not have. */
  const m = new Array(16).fill(0);
  m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
  m[13] = g.y;
  g.mesh = {
    getMatrixAt(i, out) { for (let k = 0; k < 16; k++) out.elements[k] = m[k]; },
    setMatrixAt(i, out) {
      for (let k = 0; k < 16; k++) m[k] = out.elements[k];
      seen.push(out.elements[13]);
    },
    instanceMatrix: { needsUpdate: false },
  };
  g.index = 0;

  g.shut = false;
  const away = { x: g.collider.center.x + 60, y: 0, z: g.collider.center.z + 60 };
  for (let i = 0; i < 400; i++) chunks.stepGates(DT, away);

  assert.ok(seen.length > 0, 'the wall moved its collider without ever touching its mesh');
  assert.ok(Math.abs(seen[seen.length - 1] - g.y) < 1e-6,
    `the mesh ended at ${seen[seen.length - 1]} while the collider ended at ${g.y}`);
  assert.ok(Math.abs(g.collider.center.y - g.y) < 1e-6,
    'the collider and the record disagree, so the comparison above means nothing');
});
