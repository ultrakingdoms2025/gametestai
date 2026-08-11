import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Physics } from '../../src/physics/Physics.js';
import {
  MAZE, DIR, generateTopology, cellCoords, cellIndex, isOpen,
  carveEntranceCorridor, reachableCount, districtAtWorld, districtCoords, neighbourhoodKeys, DISTRICT_SPAN,
} from '../../src/worlds/maze/MazeTopology.js';
import {
  districtColliders, cellToWorld, forecourtColliders, FORECOURT_PORTAL_Z,
} from '../../src/worlds/maze/MazeColliders.js';
import { MazeWorld } from '../../src/worlds/MazeWorld.js';

/** Build a MazeWorld headlessly. The ctx needs a player: update() steers residency from it. */
async function buildMazeWorld() {
  const physics = new Physics(null);
  const world = new MazeWorld({
    scene: new THREE.Scene(),
    engine: null,
    physics,
    bus: null,
    materials: null,
    player: { position: new THREE.Vector3() },
  });
  await world.build(() => {});
  return { world, physics };
}

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

test('a freshly built maze streams rather than building everything', async () => {
  const { world, physics } = await buildMazeWorld();   // existing helper in this file
  assert.ok(world.chunks, 'MazeWorld exposes no chunk manager');
  const resident = world.chunks.residentKeys().length;
  assert.ok(resident > 0 && resident <= 25, `resident districts out of range: ${resident}`);
  // Phase 1 registered ~161,000 colliders. Streaming must be a fraction of that.
  assert.ok(physics.colliders.length < 40000,
    `still building the whole level: ${physics.colliders.length} colliders`);
});

test('the forecourt is visible, not just solid', async () => {
  /* The forecourt needs meshes as well as colliders. Streaming the districts
   * makes it tempting to drop the instancing along with the district loop,
   * which leaves the player arriving in a void enclosed by invisible walls. */
  const { world } = await buildMazeWorld();
  const names = [];
  world.group.traverse((o) => { if (o.isInstancedMesh) names.push(o.name); });
  assert.ok(names.some((n) => /forecourt/.test(n)), `no forecourt meshes: ${names.join(', ')}`);
});

test('the forecourt survives streaming', async () => {
  const { world, physics } = await buildMazeWorld();
  // Walk far away, then check the arrival point still has floor - the forecourt
  // is authored geometry outside the district grid and must never be evicted.
  world.update(0.016);
  const spec = world.portalSpecs[0];
  const arrivalZ = spec.position.z + 2.6;
  world.chunks.updateResidency(10 * DISTRICT_SPAN, 0, 10 * DISTRICT_SPAN, 2);
  assert.notEqual(
    physics.groundHeight(spec.position.x, arrivalZ, 5, 12), null,
    'the forecourt was evicted',
  );
});

test('walking the maze keeps residency bounded', async () => {
  const { world, physics } = await buildMazeWorld();
  const p = world.ctx.player.position;
  let peak = 0;
  for (let i = 0; i < 15; i++) {
    p.set((2 + i) * DISTRICT_SPAN * 0.7, 0.05, (2 + i) * DISTRICT_SPAN * 0.5);
    world.update(0.016);
    peak = Math.max(peak, world.chunks.residentKeys().length);
  }
  // 25 on the player's own level (radius 2) + 9 on the level-1 ring (radius 1).
  assert.ok(peak <= 34, `residency peaked at ${peak}`);
  assert.ok(physics.colliders.length < 40000, `collider count grew to ${physics.colliders.length}`);
});

test('the maze is four levels and every one is reachable', async () => {
  const { world } = await buildMazeWorld();
  const t = { cells: world.cells };
  // Every level must be carved, i.e. some cell on it has an open passage.
  for (let lv = 0; lv < MAZE.LEVELS; lv++) {
    let any = false;
    for (let i = lv * MAZE.LEVEL_CELLS; i < (lv + 1) * MAZE.LEVEL_CELLS; i += 97) {
      if (t.cells[i] !== 0) { any = true; break; }
    }
    assert.ok(any, `level ${lv} was never carved`);
  }
  assert.equal(reachableCount(world.cells, world.entranceCell), MAZE.TOTAL_CELLS);
});

test('residency spans the level above and below', async () => {
  const { world } = await buildMazeWorld();
  const p = world.ctx.player.position;
  // Stand on level 1.
  p.set(1260, MAZE.LEVEL_HEIGHT, 600);
  world.update(0.016);
  const levels = new Set(world.chunks.residentKeys().map((k) => districtCoords(k).level));
  assert.ok(levels.has(1), 'the player\'s own level is not resident');
  assert.ok(levels.has(0) || levels.has(2), 'no adjacent level is resident');
});

test('residency stays bounded across levels', async () => {
  const { world, physics } = await buildMazeWorld();
  const p = world.ctx.player.position;
  let peak = 0;
  for (let i = 0; i < 12; i++) {
    p.set(300 + i * 140, (i % MAZE.LEVELS) * MAZE.LEVEL_HEIGHT, 300 + i * 110);
    world.update(0.016);
    peak = Math.max(peak, world.chunks.residentKeys().length);
  }
  // 25 on the player's level + a smaller ring on each neighbour.
  assert.ok(peak <= 45, `residency peaked at ${peak}`);
  assert.ok(physics.colliders.length < 60000, `colliders grew to ${physics.colliders.length}`);
});
