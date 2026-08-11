import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import {
  MAZE, generateTopology, buildDistrictGraph, cellCoords, districtIndex,
} from '../../src/worlds/maze/MazeTopology.js';
import { districtColliders } from '../../src/worlds/maze/MazeColliders.js';
import { puzzleCells } from '../../src/worlds/maze/MazePuzzles.js';
import {
  LOD0_RANGE, LOD1_RANGE, lodFor,
} from '../../src/worlds/maze/MazeProfiles.js';
import { prefabFor, releasePrefabs } from '../../src/worlds/maze/MazeMeshes.js';
import { MazeBatches, BATCH_FAMILIES } from '../../src/worlds/maze/MazeBatches.js';
import { MazeChunks, districtLodDistance } from '../../src/worlds/maze/MazeChunks.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Task 7's gate: the LOD bands, the per-instance geometry-id swap, and the
 * triangle budget they exist to hold.
 *
 * The load-bearing fact throughout: an LOD change is a GEOMETRY-ID WRITE on
 * an instance that never moves, never leaves its batch and never comes back
 * as a new id. Remove-and-re-add was the alternative and it is the allocator
 * churn the whole append-only batch design exists to avoid.
 */

/** One stub material per batched kind, so the batches stand up headless. */
function stubMaterials() {
  const m = {};
  for (const fam of Object.values(BATCH_FAMILIES)) {
    for (const k of fam.kinds) m[k] = { isMaterial: true };
  }
  return m;
}

/** Real descriptors for one district, restricted to the batched kinds. */
function descsFor(cells, dx, dz, level = 0) {
  const batched = new Set(Object.values(BATCH_FAMILIES).flatMap((f) => f.kinds));
  return districtColliders(cells, dx, dz, level).filter((d) => batched.has(d.kind));
}

test('the LOD bands are derived from the triangle budget, not chosen', () => {
  /* Every band boundary here is a number the budget table in the plan
   * produced. If a band moves, the budget moves with it, and the test that
   * fails should be this one rather than a frame counter three weeks later. */
  assert.equal(lodFor(0), 0);
  assert.equal(lodFor(LOD0_RANGE - 0.01), 0);
  assert.equal(lodFor(LOD0_RANGE + 0.01), 1);
  assert.equal(lodFor(LOD1_RANGE + 0.01), 2);
  assert.equal(LOD0_RANGE, 25);
  assert.equal(LOD1_RANGE, 80);
});

test('district distance is nearest-point, so the district underfoot can never demote itself', () => {
  /* Centre distance inverts the bands: a district is 120 m square, so its own
   * centre is up to ~85 m from a player in its corner - past LOD1_RANGE - and
   * the geometry at arm's length would render as the far box. Nearest-point
   * errs only toward MORE detail, which is triangles spent, never detail
   * lost; the budget test below prices exactly this rule. */
  const key = districtIndex(10, 10, 0);
  const span = MAZE.DISTRICT * MAZE.CELL;
  // Standing inside the district, at its corner: distance 0, not ~85.
  assert.equal(districtLodDistance(10 * span + 1, 1, 10 * span + 1, key), 0);
  // Two districts away: a full district's span clear of its near edge.
  const far = districtIndex(12, 10, 0);
  assert.ok(districtLodDistance(10 * span + 1, 1, 10 * span + 1, far) >= span,
    'a district two across measures closer than one full span');
  // The ring district directly above: the level gap, through the roof.
  const above = districtIndex(10, 10, 1);
  const d = districtLodDistance(10 * span + 1, 1, 10 * span + 1, above);
  assert.ok(d > 0 && d <= MAZE.LEVEL_HEIGHT,
    `the district overhead measures ${d} m - expected the Y gap to its hedge band`);
});

/**
 * A MazeChunks against stub physics, streaming REAL districts through the
 * REAL residency-and-LOD path. This is deliberately the production code
 * rather than a re-derivation: the budget below is priced by the same
 * `updateResidency` -> `districtLodDistance` -> `lodFor` -> `setLod` chain
 * the browser runs, so the test cannot drift from the shipped bands.
 */
function chunksFor(seed) {
  const t = generateTopology(seed);
  const graph = buildDistrictGraph(seed);
  const dOf = (idx) => {
    const c = cellCoords(idx);
    return districtIndex(Math.floor(c.x / MAZE.DISTRICT), Math.floor(c.z / MAZE.DISTRICT), c.level);
  };
  const puzzles = puzzleCells(seed, graph, dOf(t.entranceCell), dOf(t.centreCell));
  const world = {
    physics: { addBox: () => ({}), remove: () => {}, setBoxColliderY: () => {} },
    colliders: [],
  };
  const group = new THREE.Group();
  const chunks = new MazeChunks({ world, cells: t.cells, group, materials: stubMaterials(), puzzles });
  return { chunks, group };
}

/** Camera-pass triangles for everything the maze streams: batches + movers. */
function streamedTriangles(chunks, group) {
  let n = chunks.batches.submittedTriangles();
  group.traverse((o) => {
    if (o.isInstancedMesh) n += (o.geometry.index.count / 3) * o.count;
  });
  return n;
}

test('the resident set stays inside the triangle budget at every band', () => {
  /* Counted from prefab triangle counts and real descriptor counts - no
   * renderer needed, which is the same reason the collision gates are
   * headless. What is counted is the streamed set's submission to one camera
   * pass; the browser's `renderer.info.render.triangles` sits above it by
   * the shadow passes (~3.6x on the shadow-casting families, measured at
   * Task 4) and the non-streamed dressing (canopy, sprigs, forecourt), and
   * the browser protocol in the ledger records that number against the same
   * two positions. What this gate holds, per commit and per seed, is the
   * part the bands govern: a widened band, a bevelled far tier or a fattened
   * prefab all land here first. */
  const { chunks, group } = chunksFor(2026);

  // Ground, mid-map: 5x5 own level + a 3x3 ring above = 34 districts.
  chunks.updateResidency(1200, 0, 1200, 2);
  const ground = streamedTriangles(chunks, group);

  // The tower worst case the whole phase measures against: 43 districts.
  chunks.updateResidency(1200, 18.05, 1200, 2);
  const tower = streamedTriangles(chunks, group);

  assert.ok(ground <= 3.5e6, `${(ground / 1e6).toFixed(2)} M triangles at ground level, budget 3.5 M`);
  assert.ok(tower <= 5.0e6, `${(tower / 1e6).toFixed(2)} M triangles from a tower, budget 5.0 M`);

  /* And the sharper pair of properties the coarse ceilings would never feel:
   *
   * 1. The bands are LOAD-BEARING. Forcing every resident district to LOD0
   *    (what deleting the updateResidency wiring would render) must cost
   *    meaningfully more than the banded set, or the swap has quietly become
   *    a no-op - a hedge whose far tier grew its bevel back, say. Task 4
   *    measured the all-LOD0 world at 8.56 M browser triangles; headless and
   *    single-pass, the same shape shows as roughly 2x. */
  for (const key of chunks.residentKeys()) chunks.batches.setLod(key, 0);
  const allNear = streamedTriangles(chunks, group);
  assert.ok(allNear > tower * 1.5,
    `all-LOD0 is ${(allNear / 1e6).toFixed(2)} M against ${(tower / 1e6).toFixed(2)} M banded - `
    + 'the far tier is no cheaper than the near one, so the swap is buying nothing');

  /* 2. Re-running the residency update RESTORES the banded figure exactly -
   *    the headless face of the browser no-thrash check (two samples 5 s
   *    apart, standing still, identical). */
  chunks.updateResidency(1200, 18.05, 1200, 2);
  assert.equal(streamedTriangles(chunks, group), tower,
    'the same position does not reproduce the same triangle count - the bands are not deterministic');

  chunks.disposeAll();
  releasePrefabs();
});

test('a district changing band does not change its instance count', () => {
  /* An LOD swap must be a geometry-id write. If instances are removed and
   * re-added the allocator churns, and churn is what fragments a batch. */
  const { cells } = generateTopology(2026, { levels: 1 });
  const group = new THREE.Group();
  const b = new MazeBatches({ materials: stubMaterials(), group });
  const key = districtIndex(6, 6, 0);
  b.add(key, descsFor(cells, 6, 6));
  const n = b.instanceCount();
  const near = b.submittedTriangles();
  b.setLod(key, 1);
  assert.equal(b.instanceCount(), n);
  b.setLod(key, 2);
  assert.equal(b.instanceCount(), n);
  /* The swap must also DO something: the far tier submits fewer triangles
   * (44 -> 12 per bevelled box), or the id write went nowhere. */
  const far = b.submittedTriangles();
  assert.ok(far < near / 2,
    `far tier submits ${far} triangles against ${near} near - the geometry ids did not move`);
  b.setLod(key, 0);
  assert.equal(b.submittedTriangles(), near, 'a round trip through the bands is not lossless');
  assert.equal(b.instanceCount(), n);
  b.disposeAll();
  releasePrefabs();
});

test('setLod reaches the multi-draw list - the 0.185.1 flag pin', () => {
  /* Measured against the installed three, not memory: `setGeometryIdAt` is a
   * bare integer write that does NOT raise `_visibilityChanged`, and with
   * culling and sorting off `onBeforeRender` early-outs on that flag - so a
   * swap that forgot to raise it would render every instance at its
   * stream-in tier forever, silently. Both directions are pinned: that
   * setLod raises the flag, and that three still needs it raised. If the
   * second assertion ever fails, three fixed it upstream and setLod's manual
   * raise is redundant but harmless - delete that half of this test. */
  const { cells } = generateTopology(2026, { levels: 1 });
  const group = new THREE.Group();
  const b = new MazeBatches({ materials: stubMaterials(), group });
  const key = districtIndex(6, 6, 0);
  b.add(key, descsFor(cells, 6, 6));
  const batch = b.batchFor('hedge');
  assert.ok('_visibilityChanged' in batch,
    'three no longer has _visibilityChanged - re-read BatchedMesh.onBeforeRender and rework setLod');

  batch._visibilityChanged = false;
  batch.setGeometryIdAt(0, batch.getGeometryIdAt(0));
  assert.equal(batch._visibilityChanged, false,
    'three now raises the flag in setGeometryIdAt itself - the manual raise in setLod is redundant');

  b.setLod(key, 2);
  assert.equal(batch._visibilityChanged, true,
    'setLod left the draw list stale - the swap would never render');

  /* And the early-out: re-applying the same band writes nothing, which is
   * what makes calling setLod per residency update affordable. */
  batch._visibilityChanged = false;
  b.setLod(key, 2);
  assert.equal(batch._visibilityChanged, false, 'an unchanged band still touched the batch');
  b.disposeAll();
  releasePrefabs();
});

test('per-instance frustum culling is on for exactly the families the measurement chose', () => {
  /* MEASURED 2026-08-10 at the tower worst case (numbers on the module note
   * in MazeBatches.js): culling the two instance-heavy families is the
   * difference between 5.34 M triangles (over budget) and 3.11 M (under);
   * culling the five small ones as well was SLOWER, because the per-pass CPU
   * walk outweighs their triangles. This pins the flag to the measurement so
   * neither a helpful "turn it all on" nor a helpful "turn it all off" can
   * land without re-measuring. */
  const group = new THREE.Group();
  const b = new MazeBatches({ materials: stubMaterials(), group });
  for (const family of Object.keys(BATCH_FAMILIES)) {
    const expected = family === 'hedge' || family === 'footing';
    assert.equal(b.batchFor(family).perObjectFrustumCulled, expected,
      `family '${family}': perObjectFrustumCulled disagrees with the recorded measurement`);
    assert.equal(b.batchFor(family).frustumCulled, false,
      `family '${family}': whole-object culling is on - its stale bounding sphere will cull on-screen batches`);
  }
  b.disposeAll();
  releasePrefabs();
});

test('equivalent LODs share one geometry object, so the batch registers no duplicates', () => {
  /* MazeBatches keys addGeometry on geometry IDENTITY. Two separate-but-
   * identical boxes for lod 1 and lod 2 would double every family's geometry
   * reservations for nothing drawn - the collapse lives in MazeMeshes'
   * geometryLod and this is its contract. */
  const ext = { hx: 0.6, hy: 2.5, hz: 3 };
  for (const kind of ['hedge', 'floor', 'shaftWall', 'gate', 'slideWall', 'footing', 'stair']) {
    assert.equal(prefabFor({ kind, ...ext, lod: 1 }), prefabFor({ kind, ...ext, lod: 2 }),
      `${kind}: lod 1 and lod 2 are two objects for one box`);
    assert.notEqual(prefabFor({ kind, ...ext, lod: 0 }), prefabFor({ kind, ...ext, lod: 1 }),
      `${kind}: the near tier collapsed into the far one - the authored detail is unreachable`);
  }
  for (const kind of ['tunnel', 'plate', 'candle']) {
    assert.equal(prefabFor({ kind, ...ext, lod: 0 }), prefabFor({ kind, ...ext, lod: 2 }),
      `${kind}: a kind with no authored near tier built two identical boxes`);
  }
  releasePrefabs();
});

test('updateResidency owns the band evaluation - per district, one definition', async () => {
  /* Textual, like the repo's other cross-file pins: the swap is only safe
   * against thrash and only priced by the budget test if the residency
   * update is the ONE caller and lodFor the ONE band rule. */
  const src = await readFile(path.join(root, 'src/worlds/maze/MazeChunks.js'), 'utf8');
  assert.ok(/setLod\(key, lodFor\(districtLodDistance\(/.test(src),
    'updateResidency no longer drives the LOD swap through lodFor(districtLodDistance(...))');
  assert.match(src, /import \{ lodFor \} from '\.\/MazeProfiles\.js'/,
    'the bands are not being read from their one definition in MazeProfiles.js');
});
