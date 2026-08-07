import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Physics } from '../../src/physics/Physics.js';
import {
  MAZE, DIR, generateTopology, cellCoords, cellIndex, isOpen,
  carveEntranceCorridor, reachableCount,
} from '../../src/worlds/maze/MazeTopology.js';
import {
  districtColliders, cellToWorld, forecourtColliders, FORECOURT_PORTAL_Z,
} from '../../src/worlds/maze/MazeColliders.js';

/*
 * Regression coverage for the entrance/forecourt fix: the entrance cell
 * (x=210, z=10 - ten cells inside district (10,0), not on its edge) was
 * unreachable from outside the grid, and the return portal stood one cell
 * north of it, which put the arrival point WorldManager.arrivalFor computes
 * squarely inside the hedge that closed passage put there. See
 * MazeTopology.carveEntranceCorridor and MazeColliders.forecourtColliders.
 */

test('carveEntranceCorridor opens a straight, unbroken path from the boundary to the entrance', () => {
  const t = generateTopology(2026, { levels: 1 });
  const e = cellCoords(t.entranceCell);
  carveEntranceCorridor(t.cells, e);

  // The boundary cell's own north face is breached, so the corridor actually
  // opens onto the forecourt rather than terminating at the outer wall.
  assert.ok(
    isOpen(t.cells, cellIndex(e.x, 0, e.level), DIR.N),
    'boundary wall was not breached',
  );

  // Every consecutive pair up the column is connected both ways.
  for (let z = 1; z <= e.z; z++) {
    const hereIdx = cellIndex(e.x, z, e.level);
    const prevIdx = cellIndex(e.x, z - 1, e.level);
    assert.ok(isOpen(t.cells, hereIdx, DIR.N), `cell (${e.x},${z}) not open north`);
    assert.ok(isOpen(t.cells, prevIdx, DIR.S), `cell (${e.x},${z - 1}) not open south`);
  }
});

test('carving the entrance corridor cannot reduce reachability', () => {
  // Opening passage bits can only ever add connectivity, never remove it - so
  // the reachable count from the entrance must be exactly the same before and
  // after, and (since the maze is already one connected component by
  // construction - see "every cell on a generated level is reachable from the
  // entrance" in maze-solvable.test.mjs) that count is the whole level.
  const seed = 2026;
  const before = generateTopology(seed, { levels: 1 });
  const beforeCount = reachableCount(before.cells, before.entranceCell);

  const after = generateTopology(seed, { levels: 1 });
  const e = cellCoords(after.entranceCell);
  carveEntranceCorridor(after.cells, e);
  const afterCount = reachableCount(after.cells, after.entranceCell);

  assert.equal(
    beforeCount, MAZE.LEVEL_CELLS,
    `pre-carve reachable count was ${beforeCount}, expected the full level (${MAZE.LEVEL_CELLS})`,
  );
  assert.equal(
    afterCount, MAZE.LEVEL_CELLS,
    `post-carve reachable count was ${afterCount}, expected the full level (${MAZE.LEVEL_CELLS})`,
  );
});

test('a player arriving through the return portal does not land inside a collider', () => {
  // Build the maze's colliders exactly as MazeWorld.build() does for the
  // districts around the entrance: carve the corridor first, then emit
  // district colliders plus the forecourt.
  const seed = 12345;
  const topo = generateTopology(seed, { levels: 1 });
  const e = cellCoords(topo.entranceCell);
  carveEntranceCorridor(topo.cells, e);
  const ew = cellToWorld(e.x, e.z, e.level);

  const physics = new Physics(null);
  // The entrance district and its immediate row/column neighbours - enough to
  // cover anything the forecourt seam or the corridor's side hedges could
  // reach. Full-level containment and seam coverage are already proven by
  // maze-containment.test.mjs; this test only needs the entrance's own
  // geometry.
  for (let dz = 0; dz < 2; dz++) {
    for (let dx = 9; dx <= 11; dx++) {
      for (const d of districtColliders(topo.cells, dx, dz, 0)) {
        physics.addBox(d.cx, d.cy, d.cz, d.hx, d.hy, d.hz);
      }
    }
  }
  for (const d of forecourtColliders(ew.x, e.level)) {
    physics.addBox(d.cx, d.cy, d.cz, d.hx, d.hy, d.hz);
  }

  // The portal spec MazeWorld.build() authors: centred in the forecourt,
  // rotationY 0.
  const portalPos = new THREE.Vector3(ew.x, ew.y, FORECOURT_PORTAL_Z);
  const rotationY = 0;

  // Exactly WorldManager.arrivalFor's arithmetic for a portal arrival:
  // position + 2.6m along (sin(rotY), cos(rotY)).
  const nx = Math.sin(rotationY);
  const nz = Math.cos(rotationY);
  const offset = 2.6;
  const arrival = new THREE.Vector3(
    portalPos.x + nx * offset,
    portalPos.y,
    portalPos.z + nz * offset,
  );

  const ground = physics.groundHeight(arrival.x, arrival.z, arrival.y + 1.2, 12);
  assert.notEqual(ground, null, 'no floor beneath the arrival point');

  // Checked at foot and head height - the capsule occupies roughly 0 to
  // 1.75m above the floor it is standing on.
  const feet = new THREE.Vector3(arrival.x, ground + 0.05, arrival.z);
  const head = new THREE.Vector3(arrival.x, ground + 1.6, arrival.z);
  assert.equal(physics.containsPoint(feet), false, 'arrival point (feet) is inside a collider');
  assert.equal(physics.containsPoint(head), false, 'arrival point (head) is inside a collider');
});
