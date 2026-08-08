/**
 * Phase 2c Task 6 - the lift moves, and cannot take the player with it.
 *
 * Two interlocks carry the whole safety argument, and each has a negative
 * here that was confirmed red before the guard was trusted:
 *
 *   THE DOOR NEVER MOVES WHILE ITS FOOTPRINT IS OCCUPIED - or it is a ladder.
 *     A door's top sweeps the entire 0.45-5.0 m band on level N+1's floor,
 *     OUTSIDE the sealed shaft. Task 4 measured an unguarded one carrying a
 *     rider to exactly 14.000 m, the hedge top.
 *
 *   THE CAR NEVER LEAVES THE LANDING UNLESS THE DOOR IS SHUT - or it is a pit.
 *     Task 5 measured the doorless walk-off at 8.700 m on real geometry.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Physics } from '../../src/physics/Physics.js';
import {
  MAZE, generateTopology, cellIndex, isOpen, DIR, connectorAt, cellToWorld,
  districtIndex, districtCoords,
} from '../../src/worlds/maze/MazeTopology.js';
import { districtColliders } from '../../src/worlds/maze/MazeColliders.js';
import { MazeChunks, CHUNK_MESH_KINDS } from '../../src/worlds/maze/MazeChunks.js';

const RADIUS = 0.35, HEIGHT = 1.75, DT = 1 / 60;

/**
 * Where a player STANDS to be in a lift's doorway.
 *
 * `doorClosedY`/`doorOpenY` are collider CENTRE heights, not floor heights,
 * and confusing the two is what made the first draft of the pit-interlock
 * test place its player 2.275 m below the landing - outside the doorway
 * entirely, so the door was free to close and the interlock looked broken
 * when it was working. The landing floor is the door's own underside.
 */
function doorwayStand(rec) {
  return {
    x: rec.door.center.x,
    y: rec.doorClosedY - rec.door.halfExtents.y,
    z: rec.door.center.z,
  };
}

/** The minimum THREE-shaped surface MazeChunks touches. */
function fakeGroup() {
  return { add() {}, remove() {} };
}
function fakeMaterials() {
  const m = {};
  for (const k of CHUNK_MESH_KINDS) m[k] = { isMaterial: true };
  return m;
}
function newChunks(cells) {
  const world = { physics: new Physics(null), colliders: [] };
  return { world, chunks: new MazeChunks({ world, cells, group: fakeGroup(), materials: fakeMaterials() }) };
}

/** A district (and level) holding a real lift, searched across seeds. */
function findLiftDistrict(seeds = [1, 7, 42, 2026]) {
  for (const seed of seeds) {
    const t = generateTopology(seed);
    for (let level = 0; level < MAZE.LEVELS - 1; level++) {
      for (let dz = 0; dz < MAZE.DISTRICTS; dz++) {
        for (let dx = 0; dx < MAZE.DISTRICTS; dx++) {
          for (let lz = 0; lz < MAZE.DISTRICT; lz++) {
            for (let lx = 0; lx < MAZE.DISTRICT; lx++) {
              const x = dx * MAZE.DISTRICT + lx, z = dz * MAZE.DISTRICT + lz;
              if (!isOpen(t.cells, cellIndex(x, z, level), DIR.UP)) continue;
              if (connectorAt(t.cells, x, z, level) !== 'lift') continue;
              return { t, seed, dx, dz, level, x, z };
            }
          }
        }
      }
    }
  }
  throw new Error('no lift found');
}

/** Bring both halves of one lift resident and return its record. */
function residentLift() {
  const f = findLiftDistrict();
  const { chunks, world } = newChunks(f.t.cells);
  chunks.ensure(districtIndex(f.dx, f.dz, f.level));
  chunks.ensure(districtIndex(f.dx, f.dz, f.level + 1));
  const rec = chunks.liveLifts().find((r) => r.cell === cellIndex(f.x, f.z, f.level));
  assert.ok(rec, 'the lift did not register');
  return { ...f, chunks, world, rec };
}

test('both halves of a lift find each other even though different districts emit them', () => {
  const { rec, level, x, z } = residentLift();
  assert.ok(rec.car, 'no car registered');
  assert.ok(rec.door, 'no door registered - the car and the door are emitted by different districts, '
    + 'and the registry is keyed on the connector cell precisely so they still pair up');
  assert.notEqual(rec.carKey, rec.doorKey, 'car and door should come from different district keys');
  const floorY = cellToWorld(x, z, level).y;
  assert.ok(Math.abs(rec.carUpY + rec.car.halfExtents.y - (floorY + MAZE.LEVEL_HEIGHT)) < 1e-6,
    'the car does not dock flush with the landing');
});

test('a capsule standing on the car is carried the full level', () => {
  const { chunks, world, rec, x, z, level } = residentLift();
  const floorY = cellToWorld(x, z, level).y;
  const p = world.physics;
  const pos = new THREE.Vector3(rec.car.center.x, rec.carY + rec.car.halfExtents.y + 0.02, rec.car.center.z);

  for (let s = 0; s < 2400; s++) {
    chunks.stepLifts(DT, pos);
    pos.y -= 0.06;                       // gravity; the rising car pushes back
    const res = p.resolveCapsule(pos, RADIUS, HEIGHT);
    if (res.grounded && Math.abs(rec.carY - rec.carUpY) < 1e-4) break;
  }
  // eslint-disable-next-line no-console
  console.log(`[lift ride] rider ${(pos.y - floorY).toFixed(3)}m above the shaft floor, car at ${(rec.carY - floorY).toFixed(3)}m`);
  assert.ok(Math.abs(pos.y - (floorY + MAZE.LEVEL_HEIGHT)) < 0.05,
    `the rider ended ${(pos.y - floorY).toFixed(3)}m up, not at the ${MAZE.LEVEL_HEIGHT}m landing`);
});

test('THE DOOR INTERLOCK: the door does not move while a capsule stands in it', () => {
  const { chunks, rec } = residentLift();
  // Dock the car AND have it mean to stay, so the door wants to open - then
  // stand in the doorway.
  rec.carY = rec.carUpY;
  rec.wantUp = true;
  const inDoorway = doorwayStand(rec);
  const before = rec.doorY;
  for (let s = 0; s < 600; s++) chunks.stepLifts(DT, inDoorway);
  assert.equal(rec.doorY, before, `the door moved ${(rec.doorY - before).toFixed(4)}m with someone standing in it`);
});

test('the door interlock is not vacuous: step aside and the same door opens', () => {
  const { chunks, rec } = residentLift();
  rec.carY = rec.carUpY;
  rec.wantUp = true;
  const before = rec.doorY;
  const away = { ...doorwayStand(rec), x: rec.door.center.x + 8, z: rec.door.center.z + 8 };
  for (let s = 0; s < 600; s++) chunks.stepLifts(DT, away);
  assert.ok(rec.doorY < before - 0.5,
    `the door only moved ${(before - rec.doorY).toFixed(3)}m with nobody in it - if it cannot open at all, `
    + 'the test above proves nothing');
  assert.ok(Math.abs(rec.doorY - rec.doorOpenY) < 1e-3, 'the door did not reach its open position');
});

/**
 * Silence the call logic for a test.
 *
 * `_callLift` re-decides `wantUp` every frame from where the player is
 * standing, and with a single player that makes the pit interlock's trigger
 * condition hard to reach honestly: a player in the top doorway is also a
 * player calling the car UP, so the car never wants to leave and the test
 * passes without the guard ever being consulted. Both of these tests were
 * MEASURED passing with `mayMove = true` before this stub was added.
 *
 * Stubbing the decision and asserting the gate is the right split: `_callLift`
 * says where the lift should go, the interlocks say whether it may move, and
 * this file is about the latter.
 */
function withoutCallLogic(chunks) {
  chunks._callLift = () => {};
  return chunks;
}

test('THE PIT INTERLOCK: the car cannot leave the landing while the door is open', () => {
  const { chunks, rec } = residentLift();
  withoutCallLogic(chunks);
  // Car docked at the landing, door standing open, and the car asked to leave.
  rec.carY = rec.carUpY;
  rec.doorY = rec.doorOpenY;
  rec.wantUp = false;
  // Someone in the doorway holds the door open, so it can never shut.
  const inDoorway = doorwayStand(rec);
  for (let s = 0; s < 600; s++) chunks.stepLifts(DT, inDoorway);
  assert.ok(Math.abs(rec.doorY - rec.doorOpenY) < 1e-3,
    'the door moved while occupied - this test is about the car, but it depends on the door staying put');
  assert.ok(Math.abs(rec.carY - rec.carUpY) < 1e-3,
    `the car dropped ${(rec.carUpY - rec.carY).toFixed(3)}m away from the landing while the door stood open - `
    + 'that is the nine-metre pit Task 4 measured at exactly 9.000m');
});

test('the pit interlock is not vacuous: with the doorway clear, the door shuts and the car then leaves', () => {
  const { chunks, rec } = residentLift();
  withoutCallLogic(chunks);
  rec.carY = rec.carUpY;
  rec.doorY = rec.doorOpenY;
  rec.wantUp = false;
  const away = { ...doorwayStand(rec), x: rec.door.center.x + 8, z: rec.door.center.z + 8 };
  for (let s = 0; s < 1800; s++) chunks.stepLifts(DT, away);
  assert.ok(Math.abs(rec.doorY - rec.doorClosedY) < 1e-3, 'the door never shut');
  assert.ok(Math.abs(rec.carY - rec.carDownY) < 1e-3,
    `the car ended at ${rec.carY.toFixed(3)} rather than its down rest ${rec.carDownY.toFixed(3)} - `
    + 'if it can never leave at all, the interlock test above proves nothing');
});

test('the call logic itself: standing on the car sends it to the other end, standing in the doorway does not', () => {
  /* The split the stub above relies on. Standing in the open doorway must NOT
   * read as riding - it did once, because the riding test inflated the
   * player's footprint by the capsule radius and the doorway sits 0.1 m
   * outside the well. That made the car's target flip the moment someone
   * stepped up to it, and it masked the door interlock completely. */
  const { chunks, rec } = residentLift();
  rec.carY = rec.carDownY;
  rec.wantUp = false;
  chunks._callLift(rec, { x: rec.car.center.x, y: rec.carDownY + rec.car.halfExtents.y, z: rec.car.center.z });
  assert.equal(rec.wantUp, true, 'standing on a car at the bottom should send it up');

  rec.carY = rec.carUpY;
  rec.wantUp = true;
  chunks._callLift(rec, doorwayStand(rec));
  assert.equal(rec.wantUp, true,
    'standing in the doorway of a docked car must not read as riding it - the player is beside the lift, not on it');
});

test('a dropped district leaves no lift behind, over mixed churn', () => {
  const f = findLiftDistrict();
  const { chunks, world } = newChunks(f.t.cells);
  const keys = [];
  for (let ddz = -1; ddz <= 1; ddz++) {
    for (let ddx = -1; ddx <= 1; ddx++) {
      for (const lv of [f.level, f.level + 1]) {
        const dx = f.dx + ddx, dz = f.dz + ddz;
        if (dx < 0 || dz < 0 || dx >= MAZE.DISTRICTS || dz >= MAZE.DISTRICTS) continue;
        keys.push(districtIndex(dx, dz, lv));
      }
    }
  }

  for (let op = 0; op < 80; op++) {
    const key = keys[op % keys.length];
    if (op % 3 === 2) chunks.drop(key); else chunks.ensure(key);

    // Every registered half must belong to a district that is still resident,
    // and its collider must still be in the physics world.
    const resident = new Set(chunks.residentKeys());
    for (const rec of chunks.liveLifts()) {
      assert.ok(rec.car || rec.door, `op ${op}: a lift record survived with neither half`);
      if (rec.car) {
        assert.ok(resident.has(rec.carKey), `op ${op}: a car is registered from an evicted district`);
        assert.ok(world.physics.colliders.includes(rec.car), `op ${op}: a registered car is not in physics`);
      }
      if (rec.door) {
        assert.ok(resident.has(rec.doorKey), `op ${op}: a door is registered from an evicted district`);
        assert.ok(world.physics.colliders.includes(rec.door), `op ${op}: a registered door is not in physics`);
      }
    }
  }

  // And a full teardown must leave nothing at all.
  chunks.disposeAll();
  assert.equal(chunks.liftCount(), 0, 'disposeAll left lifts registered');
  assert.equal(world.colliders.length, 0, 'disposeAll left colliders in the world array');
});

test('stepLifts is a no-op with no lifts resident, and safe with no player', () => {
  const { chunks } = newChunks(generateTopology(3).cells);
  assert.equal(chunks.stepLifts(DT, null), 0);
  const { chunks: c2, rec } = residentLift();
  // No player at all: the door should still be free to settle to its resting
  // state, and nothing should throw.
  rec.carY = rec.carDownY;
  for (let s = 0; s < 300; s++) c2.stepLifts(DT, null);
  assert.ok(Math.abs(rec.doorY - rec.doorClosedY) < 1e-3,
    'with no player and the car down, the door should rest closed');
});
