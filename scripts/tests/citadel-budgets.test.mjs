/**
 * THE FIVE BUDGETS, MEASURED OFF A REAL BUILD.  Design 5.4 C2-C5, design 6 R11.
 *
 * Every number here comes from building the world headless with its real
 * physics and then counting - never from `renderer.info`, because
 * `src/dev/WorldTriangles.js` records frame totals moving 10-13% between loads
 * of an identical framing and two agents lost an afternoon each to that.
 *
 * Every assertion is a FLOOR with the floor, the achieved value and a ceiling
 * printed next to it, and the ceiling is an ablation wherever one can be
 * computed rather than a round number that sounds generous. A "not worse than
 * before" assertion with no floor is how this project once shipped a world with
 * zero reachable wildlife and 29 green tests.
 *
 * ── What was measured, before and after ────────────────────────────────────
 *
 * RE-RUN, not remembered. Every figure in the right-hand column was correct at
 * the Extent stage and none of them was touched when Regions, Caves and the
 * ring framings landed - so the header of the file whose thesis is "every
 * number is measured" was three stages stale. These are this file's own
 * printed values on the current tree.
 *
 *                              HALF 200, shipped     HALF 450, this drop
 *   world triangles               306-324k                  484,520
 *   scene meshes / draws                48                      136
 *   worst bounding sphere           282.9 m                  126.9 m
 *   triangles culled, worst mesa       0.0%                    17.9%
 *   triangles culled, souk alley       0.0%                    36.7%
 *   triangles culled, worst ring          -                     4.4%
 *   resident geometry              28.59 MB                 43.34 MB
 *   colliders                        ~3,500                    3,883
 *   broadphase cells                  5,776                    3,742
 *   worst owned build slice           192 ms                   16.7 ms
 *
 * The resident figure is post-LOD and counts everything the world holds, not
 * only what is in the scene graph: 36.75 MB of drawn geometry plus 6.60 MB of
 * `lo` copies and other off-graph geometry. It is the number that exposed TWO
 * real ownership bugs, one from each side. First the total came out BELOW the
 * scene graph, because `Batch.flush` left its merged districts owned by a
 * `Batch` that was disposed on the next line. Then it came out 7.77 MB too
 * HIGH, because `_splitDistricts` left every split parent on the ownership list
 * after `splitMesh` had detached and disposed it - `dispose()` frees the GPU
 * buffer and nothing else, so 15% of what this file called resident was three
 * dead typed arrays. Both halves are asserted now.
 *
 * The slice figure is wall clock and moves with the machine; it is the only
 * number here that is not deterministic, which is why C5 asserts the collider
 * count between yields as well.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/**
 * Install the least DOM and WebGL a world build touches.
 *
 * Copied rather than imported. `citadel-reach.test.mjs` exports the same
 * harness, but importing it also RUNS its eighteen tests inside this file's
 * process and reports them as this file's - which makes a failure here read as
 * a failure there. `citadel-districts.test.mjs` carries its own for the same
 * reason. Every stub returns the SHAPE the caller needs and never a plausible
 * value, so a world that came to depend on a pixel it painted reads zero rather
 * than something that looks like a texture.
 */
function harness() {
  if (globalThis.__citadelBudgetsHarness) return;
  globalThis.__citadelBudgetsHarness = true;

  class Img {
    constructor(a, b, c) {
      if (typeof a === 'number') {
        this.width = a; this.height = b;
        this.data = new Uint8ClampedArray(a * b * 4);
      } else {
        this.data = a; this.width = b; this.height = c ?? 1;
      }
    }
  }
  const gradient = { addColorStop() {} };
  const context2d = (canvas) => {
    const real = {
      canvas,
      createImageData: (w, h) => new Img(Math.max(1, w | 0), Math.max(1, (h ?? w) | 0)),
      getImageData: (x, y, w, h) => new Img(Math.max(1, w | 0), Math.max(1, h | 0)),
      createLinearGradient: () => gradient,
      createRadialGradient: () => gradient,
      createConicGradient: () => gradient,
      createPattern: () => null,
      measureText: () => ({ width: 8 }),
      getLineDash: () => [],
    };
    return new Proxy(real, { get: (o, k) => (k in o ? o[k] : () => undefined), set: () => true });
  };
  globalThis.ImageData = Img;
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  globalThis.document = {
    createElement(tag) {
      const c = { width: 1, height: 1, style: {}, tagName: tag };
      c.getContext = () => context2d(c);
      return c;
    },
    createElementNS(_ns, tag) { return this.createElement(tag); },
  };
  globalThis.window = globalThis;
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return context2d(this); }
  };
  const dead = () => ({ texture: null, dispose() {} });
  THREE.PMREMGenerator.prototype.fromEquirectangular = dead;
  THREE.PMREMGenerator.prototype.fromScene = dead;
  THREE.PMREMGenerator.prototype.compileEquirectangularShader = () => {};
}


harness();
const { Physics } = await import('../../src/physics/Physics.js');
const { CitadelWorld, CITADEL_LAYOUT } = await import('../../src/worlds/CitadelWorld.js');
const {
  districtStats, splitDistricts, triangleCount, geometryBytes, bandCanFire, sourceSphere,
  MAX_DISTRICT_RADIUS,
} = await import('../../src/worlds/citadel/Districts.js');
const { SURFACE } = await import('../../src/worlds/lod/DistanceLod.js');
const { HALF } = await import('../../src/worlds/terrain/CitadelHeight.js');
const { VIEWS } = await import('../../src/dev/Harness.js');
const { walkWorldTriangles } = await import('../../src/dev/WorldTriangles.js');

/* ------------------------------------------------------------------ */
/* The budgets, from design 5.4                                        */
/* ------------------------------------------------------------------ */

const BUDGET = {
  bytes: 90 * 1048576,   // C2
  sphere: MAX_DISTRICT_RADIUS, // C3
  colliders: 20000,      // C4
  cells: 12000,          // C4
  sliceMs: 24,           // C5
};

/** Quote floor / achieved / ceiling, the way the rest of the citadel suite does. */
function floorCheck(what, floor, achieved, ceiling, note = '') {
  console.log(`  ${what.padEnd(48)} floor ${String(floor).padStart(9)} | achieved `
    + `${String(achieved).padStart(9)} | ceiling ${String(ceiling).padStart(9)} ${note}`);
}

/* ------------------------------------------------------------------ */
/* One build, shared, with its slice timings recorded                  */
/* ------------------------------------------------------------------ */

/**
 * Build Citadel and time every span between yields.
 *
 * `report` and `report.slice` are BOTH counted, because in `WorldManager` they
 * are one relay sharing one 24 ms clock (`:230-277`) - a phase boundary yields
 * exactly as a mid-phase slice does. And `last` is stamped AFTER the yield
 * resolves rather than before it: stamping it before folds the timer's own
 * latency into the next span and inflates every measurement by however long
 * `setTimeout(0)` actually took, which on this runner is 1-15 ms and would have
 * made the build look like it missed the budget forty times over.
 */
async function buildTimed() {
  const physics = new Physics();
  const renderer = {
    capabilities: { getMaxAnisotropy: () => 4, isWebGL2: true },
    initTexture() {}, getContext: () => ({}),
    getRenderTarget: () => null, setRenderTarget() {}, render() {}, clear() {},
  };
  const scene = new THREE.Scene();
  const mats = new Map();
  const world = new CitadelWorld({
    physics,
    scene,
    bus: { on: () => () => {}, emit() {} },
    engine: { renderer, onFrameUpdate: () => () => {}, onResize: () => () => {} },
    materials: {
      get: (k) => {
        if (!mats.has(k)) { const m = new THREE.MeshStandardMaterial(); m.name = String(k); mats.set(k, m); }
        return mats.get(k);
      },
      dispose() {},
    },
  });
  world.physics = physics;

  /* Colliders registered, counted at every yield. This is the DETERMINISTIC
   * half of the C5 measurement and the half that is asserted; see the test for
   * why the wall clock is only printed. */
  let registered = 0;
  for (const m of ['addBox', 'addRotatedBox', 'addSphere', 'addMesh', 'addHeightfield']) {
    const fn = physics[m];
    if (typeof fn !== 'function') continue;
    physics[m] = function counted(...a) { registered++; return fn.apply(this, a); };
  }

  const spans = [];
  let last = performance.now();
  let lastCount = 0;
  const mark = (f, label) => {
    spans.push({
      ms: performance.now() - last,
      colliders: registered - lastCount,
      label: label ?? '(unlabelled)',
    });
    lastCount = registered;
    return new Promise((r) => setTimeout(() => { last = performance.now(); r(); }, 0));
  };
  const report = (f, label) => mark(f, label);
  report.slice = mark;
  await world.build(report);
  spans.push({ ms: performance.now() - last, colliders: registered - lastCount, label: '(tail)' });
  world.group.visible = true;
  return { world, physics, spans };
}

let _built = null;
async function built() {
  if (!_built) _built = await buildTimed();
  return _built;
}

/** The seven positioned harness framings, and the six a player can stand at. */
const FRAMINGS = VIEWS.citadel.filter((v) => Array.isArray(v.pos));
const _cam = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 2000);
const _look = new THREE.Vector3();
function place(v) {
  _cam.fov = v.fov ?? 75;
  _cam.position.fromArray(v.pos);
  _cam.lookAt(_look.fromArray(v.look));
  _cam.updateProjectionMatrix();
  _cam.updateMatrixWorld(true);
  return _cam;
}

/* ================================================================== */
/* C2 - memory                                                         */
/* ================================================================== */

test('FLOOR: C2 - resident geometry fits inside 90 MB, LOD copies included', async () => {
  const { world } = await built();
  const stats = districtStats(world.group);

  /* The scene graph is only half the bill. `DistanceLod` holds a second `lo`
   * buffer per registration and swaps it onto the mesh, and design 5.4 C3 says
   * plainly that C2 and C3 pull against each other - so the budget is read
   * against the POST-LOD residency. `world._owned` is the world's own ownership
   * list and holds every geometry it will dispose, including the lo copies and
   * the terrain tiles' lo, so it is the honest total. */
  const seen = new Set();
  let owned = 0;
  const take = (g) => {
    if (!g?.isBufferGeometry || seen.has(g)) return;
    seen.add(g);
    owned += geometryBytes(g);
  };
  world.group.traverse((o) => { if (o.isMesh) take(o.geometry); });
  for (const e of world._lod.entries) { take(e.hi); take(e.lo); }
  for (const g of world._owned) take(g);

  /* floor    <= 90 MB, design 5.4 C2's budget for the 5x world
   * achieved  33.36 MB
   * ceiling   143 MB - C2's own quote for a naive 5x, and 28.59 MB is what the
   *           400 m world cost, so the whole expansion is +4.77 MB */
  assert.ok(owned <= BUDGET.bytes,
    `resident geometry is ${(owned / 1048576).toFixed(2)} MB; floor 90 MB`);
  floorCheck('C2  resident geometry, MB', 90, (owned / 1048576).toFixed(2), 143,
    '(ceiling = C2\'s quote for a naive 5x)');
  console.log(`    scene graph ${(stats.bytes / 1048576).toFixed(2)} MB, `
    + `LOD and off-graph copies ${((owned - stats.bytes) / 1048576).toFixed(2)} MB`);

  /* Everything the world will draw has to be something the world will free.
   * `Batch.flush` puts its merged geometry on the BATCH's ownership list and
   * every builder calls `B.dispose()` on the next line, which fires the dispose
   * event on a geometry that is live in the scene and drops the only reference
   * to it - so a district survived `CitadelWorld.dispose` and its buffers were
   * never freed. The symptom was this total coming out SMALLER than the scene
   * graph, which is how it was found. */
  const held = new Set(world._owned);
  const unowned = [];
  world.group.traverse((o) => {
    if (o.isMesh && !held.has(o.geometry)) unowned.push(o.name);
  });
  assert.deepEqual(unowned, [],
    `geometry in the scene that the world will never dispose: ${unowned.join(', ')}`);

  /* AND THE CONVERSE, which is the half that was missing and the half that
   * shipped a defect.
   *
   * "Every scene geometry is owned" cannot see a geometry the world owns and
   * nothing draws. `_emit` pushed each MERGED district onto `_owned`;
   * `_splitDistricts` then handed it to `splitMesh`, which detaches the parent
   * and calls `geometry.dispose()`. That frees the GPU buffer and leaves the
   * typed arrays alive for as long as `_owned` holds them - which was for ever.
   * Three parents survived that way: `cliff:stone.castle` 6.85 MB,
   * `cliff:dirt.ground` 0.47 MB, `props:roof.tile` 0.45 MB, 7.77 MB of a
   * 51.29 MB total reported as resident. The number above was 15% dead.
   *
   * ABLATION: restore the missing splice in `_splitDistricts` and this list
   * comes back with exactly those three. */
  const live = new Set();
  world.group.traverse((o) => { if (o.geometry) live.add(o.geometry); });
  for (const e of world._lod.entries) { if (e.hi) live.add(e.hi); if (e.lo) live.add(e.lo); }
  for (const b of world._banners ?? []) if (b.geo) live.add(b.geo);
  const orphaned = [];
  let orphanBytes = 0;
  for (const g of new Set(world._owned)) {
    if (!g?.isBufferGeometry || live.has(g)) continue;
    orphaned.push(`${g.name || '(unnamed)'} ${triangleCount(g)} tris `
      + `${(geometryBytes(g) / 1048576).toFixed(2)} MB`);
    orphanBytes += geometryBytes(g);
  }
  assert.deepEqual(orphaned, [],
    `${(orphanBytes / 1048576).toFixed(2)} MB the world holds and nothing draws: ${orphaned.join(', ')}`);

  /* The bevel switch is what makes the number this small, and it is worth
   * pinning: `RoundedBoxGeometry` is 108 triangles against a plain box's 12,
   * and `BEVEL_MIN` is the size below which a box does not get rounded. */
  const src = (await import('node:fs')).readFileSync(
    new URL('../../src/worlds/CitadelWorld.js', import.meta.url), 'utf8');
  assert.ok(/^const BEVEL_MIN = 0\.55;$/m.test(src),
    'BEVEL_MIN moved - C2\'s 9x geometry ratio is decided by it and the budget above was measured at 0.55');
});

/* ================================================================== */
/* C3 - the spatial split, and what it buys                            */
/* ================================================================== */

test('FLOOR: C3 - every district is inside the 130 m bounding sphere', async () => {
  const { world } = await built();
  const stats = districtStats(world.group, BUDGET.sphere);

  /* floor    zero meshes at or over 130 m
   * achieved  0; the worst is the curtain wall at 126.9 m
   * ceiling   282.9 m at HALF 200 and 636.8 m here, which is what the world
   *           measured with no split at all */
  assert.deepEqual(stats.over.map((m) => m.name), [],
    `districts over the ${BUDGET.sphere} m ceiling: `
    + stats.over.map((m) => `${m.name} r${m.geometry.boundingSphere.radius.toFixed(1)}`).join(', '));
  assert.ok(stats.worstRadius < BUDGET.sphere,
    `worst district sphere is ${stats.worstRadius.toFixed(1)} m`);
  floorCheck('C3  worst district sphere, m', BUDGET.sphere, stats.worstRadius.toFixed(1), 636.8,
    `(${stats.worstName})`);

  /* Instanced fields are reported separately by `districtStats` and are NOT
   * exempt here. `citadel:tree.crown` was 71,176 triangles - 22.9% of the whole
   * world - behind a 160.9 m sphere in a single `InstancedMesh`, which no
   * splitter can touch: an instanced field is divided by being BUILT as several
   * fields. `_buildTrees` now buckets by quadrant, and if that is ever undone
   * this is the assertion that says so. */
  for (const f of stats.instanced) {
    assert.ok(f.radius < BUDGET.sphere,
      `instanced field ${f.name} has a ${f.radius.toFixed(1)} m sphere and ${f.triangles} triangles - `
      + 'quadrant bucketing has been undone in _buildTrees');
  }
  const worstField = Math.max(...stats.instanced.map((f) => f.radius));
  const biggestField = Math.max(...stats.instanced.map((f) => f.triangles));
  floorCheck('C3  worst instanced field sphere, m', BUDGET.sphere, worstField.toFixed(1), 160.9,
    '(ceiling = one un-bucketed palm field)');
  floorCheck('C3  biggest instanced field, triangles', 40000, biggestField, 71176);
  assert.ok(biggestField < 40000,
    `the largest instanced field is still ${biggestField} triangles`);
});

test('FLOOR: C3 - the frustum now has something to reject, from every framing', async () => {
  const { world } = await built();
  const total = districtStats(world.group).meshes;
  const rows = FRAMINGS.map((v) => {
    const r = walkWorldTriangles(world.group, place(v), { breakdown: false });
    return { name: v.name, drawn: r.triangles, culled: r.culledTriangles };
  });
  console.log('\n    framing              submitted     culled   culled%');
  for (const r of rows) {
    console.log(`    ${r.name.padEnd(18)} ${String(r.drawn).padStart(9)} ${String(r.culled).padStart(10)}`
      + `   ${(100 * r.culled / (r.drawn + r.culled)).toFixed(1)}%`);
  }
  const share = (r) => r.culled / (r.drawn + r.culled);
  const ground = rows.filter((r, i) => !FRAMINGS[i].aerial && !FRAMINGS[i].ring);
  const aerial = rows.filter((r, i) => FRAMINGS[i].aerial);
  const ring = rows.filter((r, i) => FRAMINGS[i].ring);
  const worstGround = Math.min(...ground.map(share));
  const worstAerial = Math.min(...aerial.map(share));
  const worstRing = Math.min(...ring.map(share));

  /* This is design 5.4 C3's headline defect, inverted into a floor: "0 of 48
   * objects culled from every measured vantage".
   *
   * Split by framing kind, and each lower floor is a measurement with a reason
   * rather than a convenience. `desert-overview` stands at (-150, 76, 176)
   * looking across the whole map, so most of the world is genuinely inside its
   * frustum and there is nothing there for culling to reject. A world that
   * rejected a third of its triangles from an aerial overview would be one
   * that was hiding things the player can see.
   *
   * ── THE RING, AND WHY IT HAS ITS OWN FLOOR ─────────────────────────────
   *
   * This assertion was only ever made where it already passed. `FRAMINGS` is
   * `VIEWS.citadel`, and until the five `ring: true` entries landed every one
   * of them stood on the mesa - the one part of the map Drop Three did not
   * change. Measured from the outer ring, the spread is enormous and it is a
   * property of WHICH WAY YOU LOOK, not of the split:
   *
   *   caravanserai-mast    95.1%      looking into the outpost
   *   ashfall-ward         91.0%      looking across the scar
   *   undercliff-terrace   72.9%      looking along the shoulder
   *   deepworks-rim        10.0%      looking back up at the mesa
   *   eyrie-summit          4.4%      looking back at the citadel, 312 m out
   *
   * An inward ring framing culls better than anything on the mesa. A long view
   * home culls almost nothing, because at 300 m nearly the whole world fits
   * inside a 72-degree frustum - that is geometry, not a regression, and a 10%
   * floor applied to it would be a floor that fails for being true. So the ring
   * gets 4%, derived from what the worst of the five measures, and the number
   * that matters out there is printed rather than floored: the honest reading
   * is that from the Eyrie the frustum buys nothing and the `lo` swap is what
   * pays the bill.
   *
   * GROUND framings on the mesa - the five a player can stand at
   *   floor    >= 10% of the world's triangles rejected
   *   achieved  12.2% (gate-approach) to 32.7% (souk-alley)
   *   ceiling   0.0% - all of them on the shipped 400 m world
   * RING framings - the five in the outer regions
   *   floor    >= 4%
   *   achieved  4.4% (eyrie-summit) to 95.1% (caravanserai-mast)
   *   ceiling   0.0% - the unsplit world
   * AERIAL
   *   floor    >= 5%
   *   achieved  8.7%
   *   ceiling   0.0% */
  assert.ok(ring.length >= 5,
    `only ${ring.length} ring framings - the outer regions have lost their vantages and this `
    + 'floor is back to being asserted only where it passes');
  assert.ok(worstGround >= 0.10,
    `the worst mesa framing culls only ${(100 * worstGround).toFixed(1)}%; floor 10%`);
  assert.ok(worstAerial >= 0.05,
    `the aerial framing culls only ${(100 * worstAerial).toFixed(1)}%; floor 5%`);
  assert.ok(worstRing >= 0.04,
    `the worst ring framing culls only ${(100 * worstRing).toFixed(1)}%; floor 4%`);
  floorCheck('C3  triangles culled, worst mesa framing, %', 10, (100 * worstGround).toFixed(1), 0.0,
    '(ceiling = the world before the split, which culled nothing)');
  floorCheck('C3  triangles culled, worst ring framing, %', 4, (100 * worstRing).toFixed(1), 0.0,
    '(the long view home from the Eyrie; an inward ring framing culls 95.1%)');
  floorCheck('C3  triangles culled, aerial framing, %', 5, (100 * worstAerial).toFixed(1), 0.0);
  floorCheck('C3  draw calls', 150, total, 48, '(ceiling = the unsplit world, which culls nothing)');
  assert.ok(total <= 150,
    `${total} draw calls; the ceiling medieval-towns.test.mjs:607 ships is 150`);
});

test('the world splits itself to exactly what splitDistricts would produce', async () => {
  /* `CitadelWorld._splitDistricts` is `splitDistricts` with a yield between
   * meshes, and that is a claim, not a comment: the ordering rule it reproduces
   * is what keeps any single mesh inside C5's slice budget, and a reproduction
   * that drifted would be a partition nothing tests.
   *
   * Compared as multisets of (triangle count, sphere radius) rather than by
   * name, because the leaf names carry a visit index that a different traversal
   * order would renumber without changing the partition at all. */
  const { world } = await built();
  const shipped = [];
  world.group.traverse((o) => {
    if (o.isMesh && !o.isInstancedMesh && o.frustumCulled !== false
      && !o.name.startsWith('citadel:terrain')) shipped.push(o);
  });

  /* Rebuild an unsplit world and run the library function over it. */
  const physics = new Physics();
  const scene = new THREE.Scene();
  const mats = new Map();
  const plain = new CitadelWorld({
    physics,
    scene,
    bus: { on: () => () => {}, emit() {} },
    engine: {
      renderer: {
        capabilities: { getMaxAnisotropy: () => 4, isWebGL2: true },
        initTexture() {}, getContext: () => ({}),
        getRenderTarget: () => null, setRenderTarget() {}, render() {}, clear() {},
      },
      onFrameUpdate: () => () => {},
      onResize: () => () => {},
    },
    materials: {
      get: (k) => {
        if (!mats.has(k)) { const m = new THREE.MeshStandardMaterial(); m.name = String(k); mats.set(k, m); }
        return mats.get(k);
      },
      dispose() {},
    },
  });
  plain.physics = physics;
  plain._splitDistricts = async () => {};
  plain._registerLod = () => ({ registered: 0, skipped: 0, loBytes: 0, reasons: [] });
  await plain.build(() => {});
  const all = [];
  plain.group.traverse((o) => { if (o.isMesh) all.push(o); });
  splitDistricts(all, { maxRadius: MAX_DISTRICT_RADIUS, minLeaf: 24 });
  const library = [];
  plain.group.traverse((o) => {
    if (o.isMesh && !o.isInstancedMesh && o.frustumCulled !== false
      && !o.name.startsWith('citadel:terrain')) library.push(o);
  });

  const key = (m) => {
    if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
    return `${triangleCount(m.geometry)}:${m.geometry.boundingSphere.radius.toFixed(4)}`;
  };
  const a = shipped.map(key).sort();
  const b = library.map(key).sort();
  assert.equal(a.length, b.length,
    `the world produced ${a.length} district buckets, splitDistricts ${b.length}`);
  assert.deepEqual(a, b, 'the sliced split is not the same partition as splitDistricts');
  console.log(`    ${a.length} district buckets, identical to splitDistricts by (triangles, radius)`);
  plain.dispose();
});

test('FLOOR: no LOD band is registered that no camera can ever cross', async () => {
  /* A band whose threshold is further away than a camera can get is not a weak
   * optimisation, it is dead code that reads as a working one - and the only
   * symptom is a resident `lo` buffer and a frame cost nobody can explain.
   * `citadel/Districts.js:bandCanFire` exists to refuse them; this asserts the
   * world actually asks.
   *
   * The ground is where it bites. `citadel/TerrainDetail.js` measures each tile
   * its own swap distance and 11 of the 36 come out beyond anything a camera
   * can reach. Registering those 11 anyway would look identical from every
   * counter in this file: same triangles, same draws, same worst sphere, +11 lo
   * buffers, and a band that never fires.
   *
   * REACH IS THE CORNER, NOT THE HALF-EDGE, and getting that wrong cost two
   * live bands. The camera locus is a 900 m SQUARE, so its furthest point from
   * the origin is `HALF * sqrt(2)` = 636.4 m; the world and this test both said
   * `HALF`, understating every reach by 186 m, and `citadel:terrain:2,5`
   * (swapNear 795.1 m, furthest 726 m at HALF and 912 m at the corner) and
   * `citadel:terrain:4,5` (833.2 m, 781 vs 967) were refused a band they can in
   * fact cross. Conservative, so nothing popped - and wrong.
   *
   * floor    zero registered bands that cannot fire
   * achieved  0; 25 of 36 terrain tiles registered, 11 refused
   * ceiling   36 - registering every tile, which is what dropping the
   *           `bandCanFire` gate in `_buildTerrain` produces */
  const { world } = await built();
  const swaps = world._terrainSwap;
  assert.equal(swaps.length, 36, `${swaps.length} terrain tiles, expected 36`);

  const registered = new Set();
  for (const e of world._lod.entries) {
    if (e.lo && e.object?.name?.startsWith('citadel:terrain')) registered.add(e.object.name);
  }
  /* RECOMPUTED, not read off `_terrainSwap.live`.
   *
   * The first version of this test compared the registrations against the
   * world's own `live` flag, and a mutation that hard-coded that flag to `true`
   * walked straight through it: both sides moved together and 36 registrations
   * matched 36 claims. A test that asks a thing whether it did the right thing
   * is not a test. `bandCanFire` is the same predicate the world is supposed to
   * be calling, applied here to the mesh actually in the scene. */
  const meshes = new Map();
  world.group.traverse((o) => { if (o.isMesh) meshes.set(o.name, o); });
  const canFire = new Map();
  for (const t of swaps) {
    const m = meshes.get(t.name);
    assert.ok(m, `${t.name} is recorded as a terrain tile but is not in the scene`);
    canFire.set(t.name, bandCanFire(sourceSphere(m), t.swapNear, SURFACE, HALF * Math.SQRT2));
  }
  const live = swaps.filter((t) => canFire.get(t.name));
  assert.ok(live.length < swaps.length,
    'every tile can fire - the ring relief has gone and this test proves nothing');
  assert.equal(registered.size, live.length,
    `${registered.size} terrain tiles carry a lo band but only ${live.length} can fire`);
  for (const t of swaps) {
    assert.equal(registered.has(t.name), canFire.get(t.name),
      `${t.name}: swap at ${t.swapNear.toFixed(0)} m ${canFire.get(t.name) ? 'can' : 'cannot'} fire `
      + `but ${registered.has(t.name) ? 'is' : 'is not'} registered`);
  }
  floorCheck('terrain tiles with a live, registered lo band', 18, live.length, 36,
    '(ceiling = registering all 36, 11 of them dead)');

  /* And the district side: `registerDistricts` reports every band it refused
   * rather than throwing, so the report is what has to be checked. */
  const rep = world._lodReport;
  assert.ok(rep, 'the world no longer keeps its LOD registration report');
  assert.deepEqual(rep.reasons, [], `bands refused on the districts: ${rep.reasons.join('; ')}`);
  assert.ok(rep.registered > 0, 'no district was registered with the LOD at all');
  assert.ok(rep.loBytes > 0, 'no district lo geometry was built - the swap band is doing nothing');
  console.log(`    districts: ${rep.registered} registered, ${rep.skipped} skipped, `
    + `${(rep.loBytes / 1048576).toFixed(2)} MB of lo`);
});

/* ================================================================== */
/* C4 - the broadphase                                                 */
/* ================================================================== */

test('FLOOR: C4 - one collider no longer owns the whole broadphase', async () => {
  const { physics } = await built();
  const cells = physics._grid.size;
  let entries = 0;
  let worst = { n: 0, c: null };
  for (const list of physics._grid.values()) entries += list.length;
  for (const c of physics.colliders) {
    if (c.type === 'heightfield') continue;
    const r = c.boundingRadius;
    const span = Math.ceil((2 * r) / physics.cellSize) + 1;
    if (span * span > worst.n) worst = { n: span * span, c };
  }

  /* floor    <= 20,000 colliders and <= 12,000 broadphase cells
   * achieved  3,883 and 3,742
   * ceiling   28,900 cells - the desert floor box alone at this extent, which
   *           is what the world would have had if C4 had been ignored, and
   *           5,776 (every cell it had) at the old one */
  assert.ok(physics.colliders.length <= BUDGET.colliders,
    `${physics.colliders.length} colliders; floor ${BUDGET.colliders}`);
  assert.ok(cells <= BUDGET.cells, `${cells} broadphase cells; floor ${BUDGET.cells}`);
  floorCheck('C4  colliders', BUDGET.colliders, physics.colliders.length, 3500,
    '(ceiling = the ~3,500 the 400 m world registered)');
  floorCheck('C4  broadphase cells', BUDGET.cells, cells, 28900,
    '(ceiling = the desert floor box on its own)');
  console.log(`    ${entries} cell entries, ${physics.heightfields.length} heightfield(s) held out of the grid`);

  /* No single collider may claim more than 1% of the grid. This is the
   * assertion that actually catches C4's failure shape rather than its
   * symptom: the count came out fine at HALF 200 too, and the world was still
   * handing every query one collider that covered the map. */
  const share = worst.n / cells;
  /* floor    no box collider may claim more than 100 cells, nor more than 5%
   *          of the grid - whichever binds first
   * achieved  81 cells, 2.4%: a 42.7 m rim segment
   * ceiling   28,900 cells and 100% of the grid - the desert floor box, which
   *           was handed to every query in the world */
  assert.ok(worst.n <= 100,
    `one collider spans ${worst.n} cells (radius ${worst.c.boundingRadius.toFixed(1)} m)`);
  assert.ok(share <= 0.05,
    `one collider spans ${(100 * share).toFixed(1)}% of the grid `
    + `(radius ${worst.c.boundingRadius.toFixed(1)} m)`);
  floorCheck('C4  worst single collider, cells', 100, worst.n, 28900,
    '(ceiling = the desert floor box)');
  floorCheck('C4  worst single collider, % of the grid', 5.0, (100 * share).toFixed(2), 100.0);

  /* And the heightfield is still outside the grid, which is the escape hatch
   * `Physics.js:418-429` publishes and the reason this is a one-collider fix
   * rather than an architecture change. */
  assert.equal(physics.heightfields.length, 1, 'the terrain is no longer a heightfield collider');
  assert.ok(!physics.colliders.some((c) => c.type !== 'heightfield' && c.boundingRadius > 200),
    'a map-spanning box collider is back in the broadphase');
});

/* ================================================================== */
/* C5 - the build is sliced                                            */
/* ================================================================== */

test('FLOOR: C5 - no build slice this world owns carries more than a frame of work', async () => {
  const { spans, world } = await built();
  const sorted = spans.slice().sort((a, b) => b.ms - a.ms);
  const byWork = spans.slice().sort((a, b) => b.colliders - a.colliders);

  /* ── COUNTED, NOT TIMED, and that is a fix rather than a preference ───────
   *
   * This gate asserted `slice.ms <= 24` and passed 7/7 in isolation while
   * failing in a full `npm test`: a 24-way parallel `node --test` measured the
   * same souk slice at 30.3 ms that measures 16.8 ms alone.
   * `medieval-spatial-index.test.mjs:442-470` sets the reason out at length and
   * `station-build-slicing.test.mjs` reaches the same conclusion from the other
   * side - it asserts the SOURCE of every phase over 100 ms takes a breathe,
   * and counts yields rather than milliseconds.
   *
   * So what is asserted is the quantity the budget is actually about: how much
   * WORK sits between two yields. Colliders registered is the right proxy for
   * this world - the souk's 192 ms was ~5,500 boxes and ~2,500 colliders
   * emitted in one synchronous pass, the two scale together, and the count is
   * identical on every machine and every run.
   *
   * The conversion is measured, not assumed: this build registers 3,883
   * colliders in ~260 ms of warm wall clock, so 12 colliders per millisecond,
   * and a 24 ms budget is ~290 colliders. The floor below is 250, tightened
   * from that rather than rounded up from it.
   *
   * floor    <= 250 colliders between any two yields
   * achieved  see below; the souk's eight-building stride is the binding one
   * ceiling   2,500 - `_buildSouk` unsliced, which is what shipped */
  const worstWork = byWork[0];
  console.log(`\n    ${spans.length} slices; worst by work:`);
  for (const sp of byWork.slice(0, 5)) {
    console.log(`      ${String(sp.colliders).padStart(5)} colliders  ${sp.ms.toFixed(1).padStart(7)} ms  ${sp.label}`);
  }
  assert.ok(worstWork.colliders <= 250,
    `one slice registered ${worstWork.colliders} colliders in "${worstWork.label}"; floor 250`);
  floorCheck('C5  colliders between two yields', 250, worstWork.colliders, 2500,
    '(ceiling = _buildSouk unsliced)');

  /* The slicing has to be REAL, not one yield per phase: eight phases would
   * give eight slices and still contain a 192 ms block. */
  assert.ok(spans.length >= 40,
    `only ${spans.length} slices - the phases are yielding at their boundaries and nowhere else`);
  floorCheck('C5  slices in the build', 40, spans.length, 8, '(ceiling = one per phase)');

  /* Every long loop in the build actually calls it. Source-level, following
   * `station-build-slicing.test.mjs`: a `breathe` parameter that is threaded
   * through and never invoked is the failure this catches, and it is invisible
   * to any count of anything. */
  const src = (await import('node:fs')).readFileSync(
    new URL('../../src/worlds/CitadelWorld.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const body = (signature) => {
    const from = src.indexOf(signature);
    assert.notEqual(from, -1, `${signature} is gone - the slicing went with it`);
    const rest = src.slice(from + signature.length);
    const next = rest.search(/\n {2}(?:async )?[_a-zA-Z]\w*\(/);
    return next === -1 ? rest : rest.slice(0, next);
  };
  for (const signature of [
    'async _buildTerrain(breathe = noBreath) {',
    'async _buildCurtainWall(breathe = noBreath) {',
    'async _buildSouk(breathe = noBreath) {',
    'async _buildCitadel(breathe = noBreath) {',
    'async _buildDressing(breathe = noBreath) {',
    'async _buildTrees(breathe = noBreath) {',
    'async _buildProps(breathe = noBreath) {',
    'async _splitDistricts(breathe) {',
  ]) {
    const b = body(signature);
    assert.ok(/await breathe\(\)/.test(b),
      `${signature} takes a breathe and never calls it`);
  }
  /* And the relay is the one `WorldManager` publishes, or none of this happens
   * in the game: `report.slice` returns immediately unless the engine is
   * running, which is what keeps the boot from paying for it. */
  assert.ok(/const slice = onProgress\?\.slice;/.test(src),
    'build no longer takes its slicer from report.slice');
  assert.ok(/const breathe = \(f, label\) => \(slice \? \(\) => slice\(f, label\) : noBreath\);/.test(src),
    'the per-phase breathe is gone');

  /* ── The wall clock, printed and not asserted ─────────────────────────────
   *
   * Worth knowing, and no longer load-bearing. Measured alone on this machine:
   * worst owned slice 16.7 ms against the 24 ms budget, whole build ~1.6 s of
   * which most is the 224 `setTimeout(0)` round trips this probe inserts. The
   * terrain SAMPLE JOB is excluded from "owned" by position: `genPool.run` puts
   * it on a generation worker in the browser (`GenPool.js:44-58`) and only runs
   * it inline when `Worker` is undefined, which is exactly this harness. */
  const boundary = spans.findIndex((sp) => sp.label === 'Raising the mesa');
  const mesa = boundary + 1;
  assert.equal(spans[mesa]?.label, 'Raising the mesa',
    'the terrain phase no longer opens with the sample job - re-derive the exclusion');
  const owned = spans.filter((_, i) => i !== mesa);
  const worstMs = Math.max(...owned.map((sp) => sp.ms));
  console.log(`    worst owned slice ${worstMs.toFixed(1)} ms (budget ${BUDGET.sliceMs}); `
    + `terrain sample job ${spans[mesa].ms.toFixed(1)} ms inline here, off-thread in the browser`);
  for (const sp of sorted.slice(0, 3)) console.log(`      ${sp.ms.toFixed(1).padStart(7)} ms  ${sp.label}`);
  void world;
});

/* ================================================================== */
/* What the world publishes for the scatter systems                    */
/* ================================================================== */

test('FLOOR: contentBounds is the authored content, and the relic budget follows it', async () => {
  const { world } = await built();
  assert.equal(world.bounds.min.x, -CITADEL_LAYOUT.half);
  assert.equal(world.bounds.max.x, CITADEL_LAYOUT.half);

  /* ── The box grew with the ring, and it had to ─────────────────────────
   *
   * This test shipped asserting `contentBounds === the protected core`, which
   * was right for a drop that authored NOTHING outside it. `_buildRegions` now
   * puts six regions in the ring, so the box is the union of the core and every
   * region's own measured AABB. Two properties have to survive that:
   *
   *   it still CONTAINS the protected core, so nothing on the mesa is ever
   *   outside the box the objective systems budget over; and
   *   it is still strictly INSIDE `bounds`, because the corners of this map
   *   are sand and darting relics into them is what the box exists to stop.
   *
   * Read off the regions themselves rather than off a literal, so authoring a
   * seventh region moves the assertion instead of breaking it. */
  const core = CITADEL_LAYOUT.coreHalf;
  assert.ok(world.contentBounds.min.x <= -core && world.contentBounds.max.x >= core,
    'contentBounds no longer contains the protected core in x');
  assert.ok(world.contentBounds.min.z <= -core && world.contentBounds.max.z >= core,
    'contentBounds no longer contains the protected core in z');
  assert.ok(world.contentBounds.min.x > world.bounds.min.x
    && world.contentBounds.max.x < world.bounds.max.x
    && world.contentBounds.min.z > world.bounds.min.z
    && world.contentBounds.max.z < world.bounds.max.z,
    'contentBounds has reached the rim - it is `bounds` with extra steps');

  assert.ok(Array.isArray(world.regions) && world.regions.length === 6,
    `the world publishes ${world.regions?.length} regions, not 6`);
  for (const r of world.regions) {
    assert.ok(world.contentBounds.min.x <= r.aabb.min.x + 1e-6
      && world.contentBounds.max.x >= r.aabb.max.x - 1e-6
      && world.contentBounds.min.z <= r.aabb.min.z + 1e-6
      && world.contentBounds.max.z >= r.aabb.max.z - 1e-6,
      `region "${r.id}" is outside contentBounds - its relics would never be budgeted for`);
  }

  /* `Relics._onWorld`'s area law, reproduced here so the consequence is visible
   * without running the placer. C1's predicted failure was reading it off
   * `bounds`: 110 relics with the surplus darted into open desert, where
   * MIN_PROMINENCE 2.5 cannot be met because flat sand is never 2.5 m above the
   * flat sand round it. That failure is unchanged in kind; what moved is that
   * the ring now HAS content, so the honest box is bigger and the honest budget
   * is bigger with it - and every one of the 109 sites lands on a deck the ring
   * published (`citadel-regions.test.mjs` proves that, and proves each is in
   * the reachable component).
   *
   * floor    the box must ask for fewer relics than `bounds` would
   * achieved  109 from contentBounds, 110 from bounds
   * ceiling   110 - the MAX_PER_WORLD cap */
  const budget = (b) => {
    const extent = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) - 44; // 2 x EDGE_INSET
    return Math.round(30 * Math.max(1, Math.min(110 / 30, (extent / 400) ** 2)));
  };
  assert.ok(budget(world.contentBounds) < budget(world.bounds),
    'contentBounds now budgets exactly what `bounds` would - it has stopped doing anything');
  floorCheck('relics asked for, from contentBounds', 110, budget(world.contentBounds),
    budget(world.bounds), '(ceiling = the same law read off `bounds`)');

  /* Both systems read it through the same optional chain, so a world that
   * publishes nothing is unchanged. Checked at the source, because the fallback
   * is what makes this safe for the other four worlds. */
  const fs = await import('node:fs');
  for (const f of ['../../src/systems/Relics.js', '../../src/systems/Caches.js']) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(/world\.contentBounds \?\? world\.bounds/.test(src),
      `${f} no longer falls back to world.bounds`);
  }
});
