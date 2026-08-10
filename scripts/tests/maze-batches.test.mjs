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
import { footingTransforms, candlePlacements } from '../../src/worlds/maze/MazeFoliage.js';
import { releasePrefabs } from '../../src/worlds/maze/MazeMeshes.js';
import { buildMazeMaterials } from '../../src/worlds/maze/MazeMaterials.js';
import {
  MazeBatches, BATCH_FAMILIES, BATCH_PER_DISTRICT_MAX, RESIDENCY_RADIUS,
  worstCaseResidency, worstCaseInstances, batchCapacity,
} from '../../src/worlds/maze/MazeBatches.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** One stub material per batched kind, so every family can stand up headless. */
function stubMaterials() {
  const m = {};
  for (const fam of Object.values(BATCH_FAMILIES)) {
    for (const k of fam.kinds) m[k] = { isMaterial: true };
  }
  return m;
}

/** Real district descriptors, restricted to the kinds the batches own. */
function descsFor(cells, dx, dz, level = 0) {
  const batched = new Set(Object.values(BATCH_FAMILIES).flatMap((f) => f.kinds));
  return districtColliders(cells, dx, dz, level).filter((d) => batched.has(d.kind));
}

test('the batch reserves worst-case capacity from the residency radius, not a literal', () => {
  /* MazeCanopy's own lesson, in its docstring: a pool sized by a hand-written
   * number silently starves the day the radius changes. Every family's
   * capacity must be the residency worst case DERIVED, and the constructed
   * THREE.BatchedMesh must actually honour it - a derivation the constructor
   * ignores is a comment, not a bound. */
  assert.equal(batchCapacity('hedge'), worstCaseInstances('hedge', RESIDENCY_RADIUS));

  /* 5x5 on the player's own level plus a 3x3 ring on each adjacent level -
   * the exact worst case `MazeChunks.updateResidency` can build. */
  assert.equal(worstCaseResidency(RESIDENCY_RADIUS), 43);

  const b = new MazeBatches({ materials: stubMaterials(), group: new THREE.Group() });
  for (const family of Object.keys(BATCH_FAMILIES)) {
    assert.equal(batchCapacity(family), worstCaseInstances(family, RESIDENCY_RADIUS),
      `${family}: batchCapacity is not the residency-derived worst case`);
    assert.equal(b.batchFor(family).maxInstanceCount, batchCapacity(family),
      `${family}: the constructed batch does not honour the derived capacity`);
  }
  b.disposeAll();
  releasePrefabs();
});

test('dropping a district releases exactly its own instances', () => {
  const { cells } = generateTopology(2026, { levels: 1 });
  const group = new THREE.Group();
  const b = new MazeBatches({ materials: stubMaterials(), group });

  const KEY_A = districtIndex(3, 3, 0);
  const KEY_B = districtIndex(4, 3, 0);
  b.add(KEY_A, descsFor(cells, 3, 3));
  const after = b.instanceCount();
  assert.ok(after > 0, 'district A put nothing in the batches - the test is checking nothing');
  b.add(KEY_B, descsFor(cells, 4, 3));
  assert.ok(b.instanceCount() > after, 'district B added nothing');
  b.drop(KEY_B);
  assert.equal(b.instanceCount(), after, 'dropping B did not return B exactly');

  /* And when the last district goes, the batches leave the scene with it, so
   * "nothing resident" still means "nothing in the group" - the invariant the
   * MazeChunks leak test has always held over the scene graph. */
  b.drop(KEY_A);
  assert.equal(b.instanceCount(), 0);
  assert.equal(group.children.length, 0, 'an empty batch stayed in the scene');
  b.disposeAll();
  releasePrefabs();
});

test('geometries are added once and never deleted', async () => {
  /* The whole reason this design cannot fragment: `deleteGeometry` frees a
   * hole in the middle of the packed vertex buffer, holes force `optimize()`,
   * and `optimize()` is a rebuild by another name. A batch whose geometry
   * buffer is append-only cannot need any of that machinery. */
  const src = await readFile(path.join(root, 'src/worlds/maze/MazeBatches.js'), 'utf8');
  assert.ok(!/deleteGeometry/.test(src),
    'a geometry is being deleted from a batch - that is the fragmentation path this design exists to avoid');
});

test('instance matrices carry translation only', async () => {
  /* Same contract `buildBoxInstances` is held to in maze-prefabs.test.mjs, for
   * the same reason: the extents live in the prefab, and a scale would stretch
   * an authored bevel and turn the fit contract into a per-instance question. */
  const src = await readFile(path.join(root, 'src/worlds/maze/MazeBatches.js'), 'utf8');
  assert.ok(!/\.compose\(/.test(src),
    'MazeBatches composes a matrix - compose takes a scale, and the extents belong to the geometry');
  assert.ok(/makeTranslation\(/.test(src), 'the instance matrix is not a pure translation');
});

test('the baked per-district maxima cover a real topology', () => {
  /* `worstCaseInstances` multiplies a BAKED per-district maximum out to the
   * residency worst case, because re-measuring the whole 20x20x4 grid at boot
   * would cost most of a second the player pays on every entry. Baked numbers
   * rot, so this test re-derives them from a real seed - including the
   * footing, plate and candle boxes MazeChunks synthesises alongside the
   * collider descriptors - and fails if the world has outgrown the bake.
   * The constants were measured over seeds 1, 7, 42, 2026 and 77771; this
   * re-measures one seed per run to keep the suite affordable. */
  const seed = 2026;
  const t = generateTopology(seed);
  const graph = buildDistrictGraph(seed);
  const dOf = (idx) => {
    const c = cellCoords(idx);
    return districtIndex(Math.floor(c.x / MAZE.DISTRICT), Math.floor(c.z / MAZE.DISTRICT), c.level);
  };
  const puzzles = puzzleCells(seed, graph, dOf(t.entranceCell), dOf(t.centreCell));
  const familyOf = {};
  for (const [name, fam] of Object.entries(BATCH_FAMILIES)) {
    for (const k of fam.kinds) familyOf[k] = name;
  }

  const measured = {};
  for (let level = 0; level < MAZE.LEVELS; level++) {
    for (let dz = 0; dz < MAZE.DISTRICTS; dz++) {
      for (let dx = 0; dx < MAZE.DISTRICTS; dx++) {
        const descs = districtColliders(t.cells, dx, dz, level, puzzles);
        const counts = {};
        for (const d of descs) {
          const fam = familyOf[d.kind];
          if (fam) counts[fam] = (counts[fam] ?? 0) + 1;
        }
        counts.footing = (counts.footing ?? 0) + footingTransforms(descs).length;
        counts.candle = (counts.candle ?? 0)
          + candlePlacements(descs, districtIndex(dx, dz, level)).length;
        counts.plate = (counts.plate ?? 0)
          + descs.filter((d) => d.kind === 'slideWall' && d.plate).length;
        for (const [fam, n] of Object.entries(counts)) {
          measured[fam] = Math.max(measured[fam] ?? 0, n);
        }
      }
    }
  }

  for (const [fam, n] of Object.entries(measured)) {
    assert.ok(n <= BATCH_PER_DISTRICT_MAX[fam],
      `${fam}: a district emitted ${n} instances, baked maximum ${BATCH_PER_DISTRICT_MAX[fam]} - `
      + 're-measure and raise the constant in MazeBatches.js');
  }
});

test('every kind in a family shares one material object', () => {
  /* A BatchedMesh draws with exactly one material, so a family whose kinds
   * held different materials would silently repaint all but the first. Today
   * that only concerns `stone` - MazeMaterials aliases shaftWall to the stair
   * material on purpose - and this pins the aliasing the batch relies on. */
  const mats = buildMazeMaterials();
  for (const [name, fam] of Object.entries(BATCH_FAMILIES)) {
    for (const kind of fam.kinds) {
      assert.equal(mats[kind], mats[fam.kinds[0]],
        `family '${name}': kind '${kind}' has its own material - it cannot share this batch`);
    }
  }
});

test('residency churn neither leaks instances nor reallocates the batch', () => {
  /* The headless sibling of the browser gate "renderer.info.memory.geometries
   * is flat across a district cycle": a batch that reallocated on churn would
   * show there and nowhere else, and the only thing that can force a
   * reallocation is outgrowing a buffer - so the capacity must be stable and
   * the instance count must return to zero however many times a district
   * cycles. */
  const { cells } = generateTopology(2026, { levels: 1 });
  const group = new THREE.Group();
  const b = new MazeBatches({ materials: stubMaterials(), group });
  const key = districtIndex(6, 6, 0);
  const descs = descsFor(cells, 6, 6);
  b.add(key, descs);
  const capacity = b.batchFor('hedge').maxInstanceCount;
  const one = b.instanceCount();
  for (let i = 0; i < 30; i++) {
    b.drop(key);
    b.add(key, descs);
  }
  assert.equal(b.instanceCount(), one, 'instances leaked across the cycle');
  assert.equal(b.batchFor('hedge').maxInstanceCount, capacity, 'the batch was reallocated');
  b.drop(key);
  assert.equal(b.instanceCount(), 0);
  assert.equal(group.children.length, 0, 'a batch outstayed its last instance');
  b.disposeAll();
  releasePrefabs();
});

test('RESIDENCY_RADIUS agrees with the radius MazeWorld actually streams with', async () => {
  /* The capacity derivation is only worth anything if it is derived from the
   * radius the world really uses. MazeWorld owns its own constant (this module
   * cannot import MazeWorld - it drags in the whole world file), so the two
   * are held together textually, the same way the repo pins other cross-file
   * facts it cannot import. */
  const src = await readFile(path.join(root, 'src/worlds/MazeWorld.js'), 'utf8');
  const m = src.match(/const RESIDENCY_RADIUS = (\d+)/);
  assert.ok(m, 'MazeWorld no longer declares RESIDENCY_RADIUS - update this test and MazeBatches');
  assert.equal(Number(m[1]), RESIDENCY_RADIUS,
    'MazeWorld streams with a different radius than the batches reserve for');
});
