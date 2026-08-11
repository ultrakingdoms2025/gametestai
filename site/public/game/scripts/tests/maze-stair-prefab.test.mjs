import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAZE, generateTopology, cellIndex, isOpen, DIR, connectorAt } from '../../src/worlds/maze/MazeTopology.js';
import { stairColliders, TREAD_HALF, SHAFT_STEPS } from '../../src/worlds/maze/MazeShafts.js';
import { treadProfile, quantiseExtent } from '../../src/worlds/maze/MazeProfiles.js';
import { prefabFor } from '../../src/worlds/maze/MazeMeshes.js';

/** Triangles in a prefab, indexed or not. */
function triCount(g) {
  return (g.index ? g.index.count : g.attributes.position.count) / 3;
}

/**
 * Every distinct extent the 'stair' kind actually ships: the treads and the
 * landing slab, taken from a real staircase rather than written as literals,
 * so these tests measure the shapes the player sees and cannot drift from
 * `MazeShafts.js`. The scan below finds the first cell whose UP link builds a
 * stair (not a lift, not a tunnel) on the pinned seed.
 */
function realStairDescriptors(seed = 2026) {
  const { cells } = generateTopology(seed);
  for (let level = 0; level < MAZE.LEVELS; level++) {
    for (let z = 0; z < MAZE.CELLS; z++) {
      for (let x = 0; x < MAZE.CELLS; x++) {
        if (!isOpen(cells, cellIndex(x, z, level), DIR.UP)) continue;
        if (connectorAt(cells, x, z, level) !== 'stair') continue;
        const stairs = stairColliders(cells, x, z, level).filter((d) => d.kind === 'stair');
        if (stairs.length) return stairs;
      }
    }
  }
  throw new Error('no staircase found on the pinned seed - the scan is broken, not the world');
}

test('a stair tread has a walking surface, a riser and a nosing', () => {
  const p = treadProfile({ hx: TREAD_HALF, hy: 0.1875, hz: TREAD_HALF });
  assert.ok(p.riser.setback > 0, 'no riser setback - the stair is still a stack of slabs');
  assert.ok(p.nosing.radius > 0, 'no nosing - the tread edge is a hard 90 degrees');
  /* The nosing projects over the RISER, never over the descriptor box. See the
   * fit contract in maze-prefabs.test.mjs: a visual you can see and cannot
   * stand on is worse than the box it replaced. */
  assert.ok(p.nosing.radius <= p.riser.setback + 1e-9,
    'the nosing reaches past the riser it is supposed to overhang');
});

test('the stair prefab is worth its triangles and no more', () => {
  const g = prefabFor({ kind: 'stair', hx: 0.5, hy: 0.1875, hz: 0.5, lod: 0 });
  const tris = triCount(g);
  assert.ok(tris > 40, `${tris} triangles - that is still a box with opinions`);
  assert.ok(tris <= 260, `${tris} triangles per tread; 23 per shaft is the budget line`);
});

test('a distant tread degrades to the box it always was', () => {
  const near = prefabFor({ kind: 'stair', hx: 0.5, hy: 0.1875, hz: 0.5, lod: 0 });
  const far  = prefabFor({ kind: 'stair', hx: 0.5, hy: 0.1875, hz: 0.5, lod: 2 });
  assert.ok(triCount(far) < triCount(near) / 4, 'LOD2 is not meaningfully cheaper than LOD0');
});

test('LOD never gets more expensive as it recedes', () => {
  /* Task 7 will pick a level per district from distance alone, so the only
   * property it can rely on is monotonicity. LOD1 is deliberately the plain
   * box today (a stair lives inside a walled shaft and is either walked on at
   * LOD0 range or occluded), and this holds whether or not that changes. */
  const tris = [0, 1, 2].map((lod) =>
    triCount(prefabFor({ kind: 'stair', hx: 0.5, hy: 0.1875, hz: 0.5, lod })));
  assert.ok(tris[0] >= tris[1] && tris[1] >= tris[2],
    `triangles per LOD run ${tris.join(', ')} - a farther tread costs more than a nearer one`);
});

test('THE FIT CONTRACT at the extents a real staircase actually emits', () => {
  /* maze-prefabs.test.mjs proves the contract world-wide at LOD0 and across
   * LODs for one district that may hold no shaft at all. The stair is the one
   * kind gaining real shape in this task, so its exact extents - treads AND
   * the landing - are pinned here at every LOD, from descriptors a real
   * staircase emitted. */
  const EPS = 1e-6;
  const descs = realStairDescriptors();
  assert.equal(descs.length, SHAFT_STEPS, 'a staircase is 23 treads and a landing');
  for (const d of descs) {
    for (const lod of [0, 1, 2]) {
      const g = prefabFor({ kind: 'stair', hx: d.hx, hy: d.hy, hz: d.hz, lod });
      g.computeBoundingBox();
      const b = g.boundingBox;
      assert.ok(b.min.x >= -d.hx - EPS && b.max.x <= d.hx + EPS
             && b.min.y >= -d.hy - EPS && b.max.y <= d.hy + EPS
             && b.min.z >= -d.hz - EPS && b.max.z <= d.hz + EPS,
        `stair prefab (${d.hx}, ${d.hy}, ${d.hz})@lod${lod} overhangs its descriptor box`);
    }
  }
});

test('the walking surface sits exactly on top of the box, spanning the full footprint', () => {
  /* The tread's top IS the standable surface the physics box provides. A slab
   * authored even a few millimetres below the box top would float the player's
   * feet above the visual on every one of the 92 treads a resident set draws;
   * a slab that stopped short of the box sides would open gaps where
   * consecutive treads of the spiral overlap. Both are checked against the
   * QUANTISED extents, which are what the prefab is honestly built to. */
  const d = { hx: TREAD_HALF, hy: 0.1875, hz: TREAD_HALF };
  const g = prefabFor({ kind: 'stair', ...d, lod: 0 });
  g.computeBoundingBox();
  const b = g.boundingBox;
  /* Positions are Float32, so exactness means "to within one float32 ULP of
   * these magnitudes", not 1e-9. A micron is far below anything the renderer
   * or the player can resolve and far above the rounding. */
  const EPS = 1e-6;
  assert.ok(Math.abs(b.max.y - quantiseExtent(d.hy)) < EPS,
    'the walking surface is not flush with the top of the collider box');
  assert.ok(Math.abs(b.max.x - quantiseExtent(d.hx)) < EPS
         && Math.abs(b.max.z - quantiseExtent(d.hz)) < EPS,
    'the tread slab does not reach the box sides - overlapping treads will show gaps');
  /* And the profile is symmetric in plan. The descriptor carries no
   * orientation - the spiral turns 45 degrees per step - so the same treatment
   * must face every direction a climber can look from. */
  assert.ok(Math.abs(b.min.x + b.max.x) < EPS && Math.abs(b.min.z + b.max.z) < EPS,
    'the tread profile is lopsided in plan, but no descriptor says which way it faces');
});

test('the landing degrades to a slab, not a tread with nosings on all four sides', () => {
  /* The landing is the same `stair` kind at wider extents, flush with level
   * N+1's floor on its inner edges. A riser setback there would open a slit
   * between the landing and the floor it is supposed to meet seamlessly, and
   * a nosing would put a step edge where a climber is meant to read
   * "continuous floor". The profile decides from proportion alone. */
  const landing = realStairDescriptors().reduce((a, d) => (d.hx > a.hx ? d : a));
  assert.ok(landing.hx > TREAD_HALF, 'the landing scan found only treads');
  const p = treadProfile({ hx: landing.hx, hy: landing.hy, hz: landing.hz });
  assert.equal(p.riser.setback, 0, 'the landing grew a riser setback - a slit against the floor');
  assert.equal(p.nosing.radius, 0, 'the landing grew a nosing on edges that abut the floor');
  const g = prefabFor({ kind: 'stair', hx: landing.hx, hy: landing.hy, hz: landing.hz, lod: 0 });
  assert.ok(triCount(g) <= 32,
    `${triCount(g)} triangles for a flat landing slab - the tread profile is leaking onto it`);
});

test('the tread prefab carries normals and UVs, ready for the surfacing task', () => {
  /* Task 5 hangs albedo/normal/ORM maps on the stair material. A prefab
   * without UVs would make that a silent no-op on the one kind this task
   * reshaped, and computeVertexNormals is what makes the bulnose read as a
   * curve rather than a facet strip. */
  const g = prefabFor({ kind: 'stair', hx: 0.5, hy: 0.1875, hz: 0.5, lod: 0 });
  assert.ok(g.attributes.normal, 'no normal attribute - the bulnose cannot catch light');
  assert.ok(g.attributes.uv, 'no uv attribute - Task 5 has nothing to map onto');
});
