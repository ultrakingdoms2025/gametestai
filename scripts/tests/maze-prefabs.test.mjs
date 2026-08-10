import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAZE, generateTopology } from '../../src/worlds/maze/MazeTopology.js';
import { districtColliders, forecourtColliders, cellToWorld } from '../../src/worlds/maze/MazeColliders.js';
import { footingTransforms } from '../../src/worlds/maze/MazeFoliage.js';
import { CHUNK_MESH_KINDS } from '../../src/worlds/maze/MazeChunks.js';
import {
  prefabFor, extentClass, PREFAB_BUDGET, groupByExtentClass,
  prefabCount, releasePrefabs, isPrefab,
} from '../../src/worlds/maze/MazeMeshes.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The world-scan seeds are capped independently of MAZE_SEEDS, and on purpose.
 * What these tests measure is the generator's VOCABULARY OF SIZES, not any
 * particular maze: seven seeds produced 113-135 classes and the spread was
 * flat, so the hundredth seed buys nothing that the third did not while
 * costing another 400 ms of full-world scanning. The gates that genuinely
 * need a thousand seeds - solvability, enclosure - are elsewhere and stay
 * uncapped.
 */
const WORLD_SEEDS = Math.min(Number(process.env.MAZE_SEEDS ?? 3), 6);

test('THE FIT CONTRACT: a prefab never leaves its own collider box', () => {
  /* This one assertion is why Phase 6 does not have to re-run the enclosure
   * proof, the anti-ladder band scan or the containment flood fill. A visual
   * that is a SUBSET of its descriptor cannot create a standable surface the
   * headless gates never saw. A visual that overhangs - a stair nosing built
   * proud of its tread, say - is a surface the player's eye trusts and the
   * physics denies, and it is also a surface no gate has ever measured. */
  const { cells } = generateTopology(2026);
  const EPS = 1e-6;
  for (const d of districtColliders(cells, 3, 3, 0)) {
    if (!CHUNK_MESH_KINDS.includes(d.kind)) continue;
    for (const lod of [0, 1, 2]) {
      const g = prefabFor({ kind: d.kind, hx: d.hx, hy: d.hy, hz: d.hz, lod });
      g.computeBoundingBox();
      const b = g.boundingBox;
      assert.ok(b.min.x >= -d.hx - EPS && b.max.x <= d.hx + EPS
             && b.min.y >= -d.hy - EPS && b.max.y <= d.hy + EPS
             && b.min.z >= -d.hz - EPS && b.max.z <= d.hz + EPS,
        `prefab ${d.kind}@lod${lod} overhangs its descriptor box`);
    }
  }
});

test('THE FIT CONTRACT holds for every descriptor the world can emit, not one district', () => {
  /* The test above is the plan's, and one district on one level is a window
   * things can land outside of - the same argument maze-enclosure.test.mjs and
   * maze-render-coverage.test.mjs both make for scanning the whole grid. The
   * kinds that only exist inside a shaft (stair, shaftWall, lift, liftDoor,
   * tunnel) and the puzzle kinds (gate, slideWall) are rare enough that a
   * 3x3-district sample can easily contain none of them, and those are exactly
   * the kinds whose extents are least uniform. The forecourt is scanned too:
   * it is authored rather than carved, it draws through the same registry, and
   * nothing else in the suite would notice if it stopped fitting. */
  const EPS = 1e-6;
  const seen = new Set();
  /* Free ride on a scan that is already walking every district: the registry
   * the browser actually fills holds the DRESSING classes too - a stone
   * footing per hedge, a pressure plate, a candle - and `PREFAB_BUDGET` claims
   * to bound the whole cache, not just the part descriptors contribute. A
   * separate test for it would mean a second full-world walk for one number. */
  const registry = new Set();
  for (let s = 0; s < WORLD_SEEDS; s++) {
    const seed = 2026 + s * 7919;
    const { cells } = generateTopology(seed);
    const check = (d) => {
      const g = prefabFor({ kind: d.kind, hx: d.hx, hy: d.hy, hz: d.hz, lod: 0 });
      g.computeBoundingBox();
      const b = g.boundingBox;
      assert.ok(b.min.x >= -d.hx - EPS && b.max.x <= d.hx + EPS
             && b.min.y >= -d.hy - EPS && b.max.y <= d.hy + EPS
             && b.min.z >= -d.hz - EPS && b.max.z <= d.hz + EPS,
        `prefab ${d.kind} (${d.hx}, ${d.hy}, ${d.hz}) overhangs its descriptor box on seed ${seed}`);
      seen.add(d.kind);
      registry.add(`${d.kind}:${extentClass(d.hx, d.hy, d.hz)}`);
    };
    for (let level = 0; level < MAZE.LEVELS; level++) {
      for (let dz = 0; dz < MAZE.DISTRICTS; dz++) {
        for (let dx = 0; dx < MAZE.DISTRICTS; dx++) {
          const descs = districtColliders(cells, dx, dz, level);
          for (const d of descs) check(d);
          for (const f of footingTransforms(descs)) {
            registry.add(`footing:${extentClass(f.hx, f.hy, f.hz)}`);
          }
        }
      }
      for (const d of forecourtColliders(cellToWorld(10, 0, 0).x, level)) check(d);
    }
  }
  assert.ok(registry.size <= PREFAB_BUDGET,
    `the registry would hold ${registry.size} geometries after walking the whole world on `
    + `${WORLD_SEEDS} seed(s), budget ${PREFAB_BUDGET}`);
  /* If the scan silently stopped covering the rare kinds, the assertions above
   * would pass by never running against them. */
  for (const kind of ['hedge', 'floor', 'stair', 'shaftWall', 'tunnel', 'lift', 'liftDoor']) {
    assert.ok(seen.has(kind), `the world scan never produced a '${kind}' descriptor to check`);
  }
});

test('the registry caches by extent CLASS, so geometry count does not grow with the world', () => {
  /* Naively caching per descriptor would allocate one BufferGeometry per hedge
   * segment - ~20,000 at full residency - and `renderer.info.memory.geometries`
   * would climb every time a district streamed in. The maze has very few
   * distinct box sizes; the registry has to exploit that or it is not a
   * registry, it is a leak. */
  const { cells } = generateTopology(2026);
  const classes = new Set();
  for (let dz = 0; dz < 4; dz++) {
    for (let dx = 0; dx < 4; dx++) {
      for (const d of districtColliders(cells, dx, dz, 0)) {
        classes.add(`${d.kind}:${extentClass(d.hx, d.hy, d.hz)}`);
      }
    }
  }
  assert.ok(classes.size <= PREFAB_BUDGET,
    `${classes.size} distinct (kind, extent) classes across 16 districts, budget ${PREFAB_BUDGET} - `
    + 'either a descriptor gained a continuously-varying extent, or the quantiser is too fine');
});

test('the class count is bounded by a district, not by the size of the world', () => {
  /* The test above passes on 16 districts of one level with about ten classes,
   * which is far too much headroom to detect the failure it names. This is the
   * measurement that actually binds the budget, and the shape it looks for is
   * the important part.
   *
   * The reassuring answer - "no descriptor has a continuously-varying extent" -
   * is not available here, because `floor` does: a district holding a shaft is
   * cut into spans of whatever length the shaft leaves, and 105 of the 135
   * classes in a whole world are floor spans. What makes the cache bounded
   * anyway is that those spans come from a single 21-cell district's layout
   * rules, so the vocabulary is finite and the extra districts mostly repeat
   * it. Measured: quadrupling the district count from 400 to 1600 multiplies
   * the class count by 1.02 to 1.36 across seeds, against the 4.0 that a cache
   * growing with the world would give. The gap between 1.36 and 4.0 is what is
   * being asserted, and it is deliberately not asserted as an equality -
   * saturation is not quite complete at 400 districts on every seed, and a
   * gate that fails on an unlucky seed is a gate that gets deleted.
   *
   * The absolute bound is the second assertion and the one the registry
   * actually lives inside. */
  const { cells } = generateTopology(2026);
  const scan = (n) => {
    const c = new Set();
    for (let level = 0; level < MAZE.LEVELS; level++) {
      for (let dz = 0; dz < n; dz++) {
        for (let dx = 0; dx < n; dx++) {
          for (const d of districtColliders(cells, dx, dz, level)) {
            c.add(`${d.kind}:${extentClass(d.hx, d.hy, d.hz)}`);
          }
        }
      }
    }
    return c.size;
  };
  const quarter = scan(Math.floor(MAZE.DISTRICTS / 2));
  const full = scan(MAZE.DISTRICTS);
  assert.ok(full < quarter * 2,
    `${quarter} classes over a quarter of the districts and ${full} over all of them - four times `
    + 'the world is bringing something close to four times the geometry, so the cache is growing '
    + 'with the world rather than with the vocabulary of sizes a district can produce');
  assert.ok(full <= PREFAB_BUDGET,
    `${full} classes across the whole world, budget ${PREFAB_BUDGET}`);
});

test('the quantiser only ever shrinks, and by less than a millimetre', () => {
  /* The fit contract is upheld by ROUNDING DOWN, and rounding down is only
   * acceptable because the amount is imperceptible. Both halves are asserted
   * here: rounding to nearest would gain 2.5 mm on a stair tread's half-height
   * (0.1875 -> 0.19) and hand the player a ledge the physics does not have,
   * and a coarse quantum would open a visible crack between abutting hedges
   * with the void showing through on the upper levels. */
  const { cells } = generateTopology(2026);
  let worst = 0;
  for (let level = 0; level < MAZE.LEVELS; level++) {
    for (let dz = 0; dz < 6; dz++) {
      for (let dx = 0; dx < 6; dx++) {
        for (const d of districtColliders(cells, dx, dz, level)) {
          const g = prefabFor({ kind: d.kind, hx: d.hx, hy: d.hy, hz: d.hz, lod: 0 });
          g.computeBoundingBox();
          const b = g.boundingBox;
          worst = Math.max(worst, d.hx - b.max.x, d.hy - b.max.y, d.hz - b.max.z);
        }
      }
    }
  }
  assert.ok(worst >= 0, `a prefab is LARGER than its descriptor by ${-worst} m`);
  assert.ok(worst < 1e-3 + 1e-9,
    `the quantiser shrinks a prefab by up to ${(worst * 1000).toFixed(3)} mm - abutting surfaces `
    + 'will show a gap');
});

test('a run of one extent class stays one mesh; only mixed sizes split', () => {
  /* An InstancedMesh has one geometry, so the moment extents moved out of the
   * instance matrix, "one mesh per kind" became "one mesh per (kind, extent
   * class)". That costs draw calls, so it must cost them only where it has to:
   * the overwhelmingly common district, whose hedges are two orientations and
   * whose floor is a single slab, must not fragment further than that. */
  const same = [
    { kind: 'hedge', hx: 0.6, hy: 2.5, hz: 3 },
    { kind: 'hedge', hx: 0.6, hy: 2.5, hz: 3 },
  ];
  const runs = groupByExtentClass(same);
  assert.equal(runs.length, 1, 'two identical boxes were split into two meshes');
  assert.equal(runs[0].descs, same, 'a single-class run should hand back the caller array untouched');

  const mixed = groupByExtentClass([...same, { kind: 'hedge', hx: 3, hy: 2.5, hz: 0.6 }]);
  assert.equal(mixed.length, 2, 'two orientations of hedge must not share one geometry');
  assert.equal(mixed.reduce((n, r) => n + r.descs.length, 0), 3, 'grouping lost or duplicated a descriptor');

  /* Floating-point spelling must not fragment a run. This is the whole reason
   * the quantiser exists: the same 1.4 m slab arrives spelled differently from
   * two districts because its extent is a difference of accumulated positions. */
  const noisy = groupByExtentClass([
    { kind: 'floor', hx: 1.3999999999999773, hy: 0.5, hz: 63 },
    { kind: 'floor', hx: 1.4000000000000057, hy: 0.5, hz: 63 },
  ]);
  assert.equal(noisy.length, 1,
    'two spellings of the same extent produced two geometries - the quantiser is not filtering noise');

  assert.deepEqual(groupByExtentClass([]), [], 'an empty run should produce no meshes');
});

test('the registry hands back the SAME geometry, and knows which are its own', () => {
  /* The property the whole streaming story rests on. If this returned an equal
   * geometry rather than the same one, nothing in the browser would look
   * different and `renderer.info.memory.geometries` would climb for the rest of
   * the session. `isPrefab` is the other half: it is how a district evicting a
   * mesh knows not to free a buffer its neighbours are drawing from. */
  const a = prefabFor({ kind: 'hedge', hx: 0.6, hy: 2.5, hz: 3, lod: 0 });
  const b = prefabFor({ kind: 'hedge', hx: 0.6, hy: 2.5, hz: 3, lod: 0 });
  assert.equal(a, b, 'the registry rebuilt a geometry it had already cached');
  assert.ok(isPrefab(a), 'the registry does not recognise its own geometry');
  assert.notEqual(a, prefabFor({ kind: 'hedge', hx: 3, hy: 2.5, hz: 0.6, lod: 0 }),
    'two orientations of hedge share one geometry - one of them is drawn at the wrong size');
  assert.notEqual(a, prefabFor({ kind: 'floor', hx: 0.6, hy: 2.5, hz: 3, lod: 0 }),
    'two kinds share one geometry - neither can ever grow a profile of its own');
});

test('releasing the registry empties it, so a re-roll does not inherit the last seed', () => {
  /* This world re-rolls its seed on every entry and a new seed cuts its floors
   * into differently-sized spans. Without a release at teardown the cache gains
   * a few dozen geometries per visit for as long as the session lasts, which is
   * the leak this task exists to NOT introduce. */
  prefabFor({ kind: 'floor', hx: 12.345, hy: 0.5, hz: 63, lod: 0 });
  assert.ok(prefabCount() > 0, 'nothing was cached to release');
  releasePrefabs();
  assert.equal(prefabCount(), 0, 'releasePrefabs left geometries in the cache');
  const fresh = prefabFor({ kind: 'floor', hx: 12.345, hy: 0.5, hz: 63, lod: 0 });
  assert.ok(isPrefab(fresh), 'the registry did not re-adopt a geometry after release');
});

test('MazeChunks builds no geometry of its own on the descriptor path', async () => {
  /* Sibling of the material tripwire in maze-lighting.test.mjs, and there for
   * the same reason: the registry owns geometry lifetime now, and a
   * BufferGeometry allocated per chunk is the same class of bug a material
   * allocated per chunk was.
   *
   * Scoped to `buildBoxInstances` - the one function every collider descriptor
   * passes through - rather than the whole file, because the file legitimately
   * still builds three geometries that no descriptor ever reaches: the sprig
   * box behind foliage and ivy, and the cylinder and disc of a shaft's daylight
   * column. Those are dressing, they are per district by nature, and they are
   * disposed with the district that made them. Checking the whole file would
   * mean either dragging dressing into the registry for no benefit or deleting
   * the test the first time it fired, and a tripwire nobody can leave armed is
   * worse than no tripwire. */
  const src = await readFile(path.join(root, 'src/worlds/maze/MazeChunks.js'), 'utf8');
  const start = src.indexOf('export function buildBoxInstances');
  assert.ok(start > 0, 'buildBoxInstances is gone - this test is checking nothing');
  const body = src.slice(start);
  assert.ok(!/new THREE\.\w*Geometry\(/.test(body),
    'buildBoxInstances constructs a geometry directly - prefabs come from MazeMeshes.js');
  assert.ok(/geometryFor\(/.test(body),
    'buildBoxInstances no longer takes its geometry from the registry callback');
});

test('the instance matrix carries no scale', async () => {
  /* The other half of the fit contract, and the half a bounding-box assertion
   * cannot see: a prefab that fits its box perfectly is still wrong if the
   * matrix then stretches it. Textual, because the alternative is standing up a
   * renderer to read back an instance matrix, and this is the property that has
   * to hold in the source for every kind at once. */
  const src = await readFile(path.join(root, 'src/worlds/maze/MazeChunks.js'), 'utf8');
  const start = src.indexOf('export function buildBoxInstances');
  const body = src.slice(start);
  assert.ok(!/\.compose\(/.test(body),
    'buildBoxInstances composes a matrix again - compose takes a scale, and the extents belong '
    + 'to the geometry now');
  assert.ok(/makeTranslation\(/.test(body), 'the instance matrix is not a pure translation');
});
