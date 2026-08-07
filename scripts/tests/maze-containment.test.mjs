import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Physics } from '../../src/physics/Physics.js';
import {
  MAZE, generateTopology, cellIndex, mulberry32,
} from '../../src/worlds/maze/MazeTopology.js';
import { districtColliders, cellToWorld } from '../../src/worlds/maze/MazeColliders.js';

const RADIUS = 0.35;      // CONFIG.player.radius
const HEIGHT = 1.75;      // CONFIG.player.height
const SPRINT = 8.2;       // CONFIG.player.sprintSpeed
const HOP = 0.93;         // jumpVelocity 6.4, gravity -22
const STEP = 1 / 60;      // fixed timestep

/** Build a physics world from a block of districts. */
function buildWorld(cells, dxs, dzs, level) {
  const p = new Physics(null);
  for (const dz of dzs) {
    for (const dx of dxs) {
      for (const d of districtColliders(cells, dx, dz, level)) {
        p.addBox(d.cx, d.cy, d.cz, d.hx, d.hy, d.hz);
      }
    }
  }
  return p;
}

/** Which cell a world position falls in. */
function cellAt(pos) {
  return {
    x: Math.round(pos.x / MAZE.CELL),
    z: Math.round(pos.z / MAZE.CELL),
  };
}

test('THE CONTAINMENT GATE: 50,000 escape attempts, zero escapes', () => {
  const t = generateTopology(2026, { levels: 1 });
  const dxs = [0, 1, 2];
  const dzs = [0, 1, 2];
  const physics = buildWorld(t.cells, dxs, dzs, 0);

  const rng = mulberry32(4242);
  const pos = new THREE.Vector3();
  const maxX = 3 * MAZE.DISTRICT * MAZE.CELL;
  let escapes = 0;
  let attempts = 0;

  // 500 launch points x 100 steps each = 50,000 resolved attempts.
  for (let launch = 0; launch < 500; launch++) {
    // Start standing in a random open cell inside the built block.
    const cx = Math.floor(rng() * (3 * MAZE.DISTRICT));
    const cz = Math.floor(rng() * (3 * MAZE.DISTRICT));
    const start = cellToWorld(cx, cz, 0);
    // Hop apex half the time, so the sweep includes airborne contact.
    const y = start.y + (rng() < 0.5 ? 0.05 : HOP);
    pos.set(start.x, y + 0.01, start.z);

    const angle = rng() * Math.PI * 2;
    const vx = Math.cos(angle) * SPRINT;
    const vz = Math.sin(angle) * SPRINT;

    for (let step = 0; step < 100; step++) {
      pos.x += vx * STEP;
      pos.z += vz * STEP;
      physics.resolveCapsule(pos, RADIUS, HEIGHT);
      attempts++;

      // Escape 1: pushed outside the built block entirely.
      if (pos.x < -MAZE.CELL || pos.z < -MAZE.CELL || pos.x > maxX || pos.z > maxX) {
        escapes++;
        break;
      }
      // Escape 2: ended up above hedge height, i.e. on top of the maze.
      if (pos.y > start.y + MAZE.HEDGE_HEIGHT) {
        escapes++;
        break;
      }
      // Escape 3: fell through the floor.
      if (pos.y < start.y - 2) {
        escapes++;
        break;
      }
    }
  }

  // Coverage and containment are two separate claims. A run that stopped early
  // because of an escape must not let a low attempt count go unnoticed, and an
  // escape must never be excused by having reached full coverage - so each is
  // asserted on its own rather than folded into one `||` that a nonzero escape
  // count could silently satisfy.
  assert.equal(attempts, 50000, `only ran ${attempts} attempts`);
  assert.equal(escapes, 0, `${escapes} escapes out of ${attempts} attempts`);
});

test('a capsule cannot squeeze through a hedge corner', () => {
  const t = generateTopology(7, { levels: 1 });
  const physics = buildWorld(t.cells, [0, 1], [0, 1], 0);
  const rng = mulberry32(11);
  const pos = new THREE.Vector3();

  for (let i = 0; i < 2000; i++) {
    // Aim diagonally at a cell corner - the classic gap in grid collision.
    const cx = 1 + Math.floor(rng() * 30);
    const cz = 1 + Math.floor(rng() * 30);
    const w = cellToWorld(cx, cz, 0);
    pos.set(w.x, w.y + 0.9, w.z);
    const corner = new THREE.Vector3(
      w.x + MAZE.CELL / 2,
      w.y,
      w.z + MAZE.CELL / 2,
    );
    const dir = corner.clone().sub(pos).setY(0).normalize();
    for (let s = 0; s < 40; s++) {
      pos.addScaledVector(dir, SPRINT * STEP);
      physics.resolveCapsule(pos, RADIUS, HEIGHT);
    }
    // Wherever it ends up, it must still be standing on the floor.
    const ground = physics.groundHeight(pos.x, pos.z, pos.y + 1.2, 12);
    assert.notEqual(ground, null, `no floor beneath ${pos.x},${pos.z}`);
  }
});

test('THE SEAM GATE: every district border has floor beneath it', () => {
  const t = generateTopology(1234, { levels: 1 });
  const physics = buildWorld(t.cells, [0, 1, 2], [0, 1, 2], 0);

  // Sample densely across the two internal borders of the 3x3 block.
  for (const borderCell of [MAZE.DISTRICT, MAZE.DISTRICT * 2]) {
    const bx = borderCell * MAZE.CELL - MAZE.CELL / 2;
    for (let z = 0; z < 3 * MAZE.DISTRICT * MAZE.CELL; z += 0.5) {
      const ground = physics.groundHeight(bx, z, 5, 12);
      assert.notEqual(ground, null, `hole at district seam x=${bx} z=${z}`);
    }
  }
});
