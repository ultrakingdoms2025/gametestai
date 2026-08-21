import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';

/**
 * DOES THE FRUSTUM HAVE ANYTHING TO CULL? THE CITADEL, MEASURED.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * `CitadelWorld` merges by MATERIAL at build time. `Batch.flush` returns one
 * mesh per material key per district, and a district is a whole concentric ring
 * of the town, so `cliff:stone.castle` is a single 54,432-triangle mesh with a
 * 186.8 m bounding sphere and `citadel:terrain` is one 636.8 m sheet. Measured
 * against the seven positioned `Harness.VIEWS.citadel` framings, the world
 * submits 305-316k triangles from EVERY one of them - a 29 m alley with a wall
 * 2.9 m away costs 99.0% of what the aerial overview costs. The frustum test is
 * working perfectly; there is simply nothing for it to cull.
 *
 * `src/worlds/citadel/Districts.js` splits those merged meshes by SPACE. This
 * file is the proof that it does, and - equally - the proof of what that costs,
 * because a split is not free: every leaf is a draw call from every camera for
 * ever, and the triangles it saves are saved only from the cameras that happen
 * not to see it.
 *
 * ── Every assertion is a FLOOR ────────────────────────────────────────────
 *
 * Quoted floor / achieved / ceiling, with the ceiling computed by ABLATION -
 * the same world measured with the split switched off - so a regression shows
 * up as a number sliding toward its floor rather than a boolean flipping. A
 * "not worse than before" assertion with no floor is how this project once
 * shipped a world with zero reachable wildlife and 29 green tests.
 *
 * ── What is deliberately NOT here ─────────────────────────────────────────
 *
 * The 5x extent. Drop Three has not been built, so any number about it is
 * modelled rather than measured and does not belong in a test that claims to
 * measure. The model, its assumptions and the measured crossover are in
 * `Districts.js`'s header; what this file pins is the property that has to hold
 * at both extents, and the cost at the one that exists.
 *
 * ── Cost ──────────────────────────────────────────────────────────────────
 *
 * Two headless world builds, ~340 ms each, shared by every test through
 * `worlds()`. The build template is `citadel-reach.test.mjs:157-240`.
 */

/* ================================================================== */
/* A world, built without a browser                                    */
/* ================================================================== */

/**
 * Install the least DOM and WebGL a world build touches.
 *
 * Lifted from `citadel-reach.test.mjs`: every stub returns the SHAPE the caller
 * needs and never a plausible value, so a world that came to depend on a pixel
 * it painted reads zero rather than something that looks like a texture.
 * Nothing here is used by a bounding sphere, and bounding spheres are most of
 * what this file measures.
 */
function harness() {
  if (globalThis.__citadelDistrictsHarness) return;
  globalThis.__citadelDistrictsHarness = true;

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

const ROOT = new URL('../../', import.meta.url);
const {
  splitGeometry, splitMesh, splitDistricts, districtStats, lowDetail,
  registerDistricts, bandCanFire, subPixelDistance, triangleCount, geometryBytes,
  sourceSphere,
  MAX_DISTRICT_RADIUS, MIN_LEAF_TRIANGLES,
} = await import('../../src/worlds/citadel/Districts.js');
const { DistanceLod, CENTRE, SURFACE } = await import('../../src/worlds/lod/DistanceLod.js');
const { VIEWS } = await import('../../src/dev/Harness.js');
const { walkWorldTriangles } = await import('../../src/dev/WorldTriangles.js');

/**
 * Build Citadel with its real materials.
 *
 * `split: false` builds the world this module was WRITTEN AGAINST, and it is
 * needed because `CitadelWorld` now applies the fix itself: `build` ends with
 * `_splitDistricts` and `_registerLod`, so a plain build hands back a world
 * that is already partitioned and the "before" half of every measurement below
 * would be measuring the "after". Stubbing the two methods is deliberately
 * cruder than a build flag - production code should not carry a switch that
 * exists for a test - and the guards in the tests themselves (`the unsplit
 * world's worst sphere is only ... m`) are what caught the handover.
 */
async function buildCitadel({ split = true } = {}) {
  const { CitadelWorld } = await import('../../src/worlds/CitadelWorld.js');
  const { Physics } = await import('../../src/physics/Physics.js');
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
        if (!mats.has(k)) {
          const m = new THREE.MeshStandardMaterial();
          m.name = String(k);
          mats.set(k, m);
        }
        return mats.get(k);
      },
      dispose() {},
    },
  });
  world.physics = physics;
  if (!split) {
    world._splitDistricts = async () => {};
    world._registerLod = () => ({ registered: 0, skipped: 0, loBytes: 0, reasons: [] });
  }
  await world.build(() => {});
  /* A backgrounded world is hidden, and `walkWorldTriangles` mirrors
   * `WebGLRenderer.projectObject`: an invisible root takes its whole subtree
   * with it and every count comes out zero. Forgetting this reads as "the
   * frustum culls everything", which is the exact opposite of the finding. */
  world.group.visible = true;
  return world;
}

/* One virgin world and one split world, built once. */
let _worlds = null;
async function worlds() {
  if (_worlds) return _worlds;
  const virgin = await buildCitadel({ split: false });
  /* The split world is the SHIPPED one - `CitadelWorld.build` runs
   * `_splitDistricts` itself now, through `splitMesh` in the same ascending
   * order with a yield between meshes so the pass fits design 5.4 C5's 24 ms
   * slice budget. Calling `splitDistricts` here as well would be splitting an
   * already-split world, which is a no-op that proves nothing; the equivalence
   * of the two paths is asserted in `citadel-budgets.test.mjs`. */
  const split = await buildCitadel();
  _worlds = { virgin, split };
  return _worlds;
}

/* ================================================================== */
/* Framings and probes                                                 */
/* ================================================================== */

/**
 * The framings, taken from `Harness.VIEWS.citadel` rather than invented.
 *
 * Every one of them was placed by probing the real geometry - the alley is a
 * measured 29.3 m of unbroken line of sight between two named souk rings, the
 * roof framing stands on a real ring-5 deck - and a framing that points at
 * empty ground makes a culling measurement worthless. `tower-top` is
 * `computed: true` and has no position to stand at, so it is not among them.
 */
const FRAMINGS = VIEWS.citadel.filter((v) => Array.isArray(v.pos));

/** The six a player can stand at; `desert-overview` is aerial and sees all. */
const GROUND_FRAMINGS = FRAMINGS.filter((v) => !v.aerial);

/**
 * The framings on the MESA, which is what every claim in this file is about.
 *
 * `Harness.VIEWS.citadel` grew five `ring: true` vantages in the outer regions,
 * and they are not interchangeable with these. Every argument this module makes
 * - a merged district is map-spanning, the unsplit world culls nothing, SURFACE
 * almost never demotes - is an argument about standing INSIDE the town, where
 * every merged sphere contains the camera. Measured from a ring terrace the
 * same merged world culls 98.5% and the hide band fires on 34 districts, which
 * is not a counter-example to any of it: it is a camera 300 m outside every
 * sphere in question. Scoped here rather than averaged away, so the ring keeps
 * its own floors in `citadel-budgets.test.mjs` and this file keeps its subject.
 */
const MESA_FRAMINGS = FRAMINGS.filter((v) => !v.aerial && !v.ring);

const _cam = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 2000);
const _look = new THREE.Vector3();

/** Put the shared camera on one framing. */
function place(v) {
  _cam.fov = v.fov ?? 75;
  _cam.position.fromArray(v.pos);
  _cam.lookAt(_look.fromArray(v.look));
  _cam.updateProjectionMatrix();
  _cam.updateMatrixWorld(true);
  return _cam;
}

/**
 * Triangles the camera would submit, deterministically, FROM THE DISTRICTS.
 *
 * The ground is held out, and that is the difference between measuring this
 * module and measuring the world. `CitadelWorld` slices its terrain into 150 m
 * tiles (`medieval/TerrainTiles.js`) before this module ever sees it, so the
 * ground culls by itself in the unsplit world too - which would put a large,
 * identical, already-culling number on BOTH sides of every ratio below and
 * quietly drag each one toward 100%. Measured: leaving the ground in takes the
 * tightest framing from 85.7% to 90.7% and the mean from 93.4% to 95.3%, and
 * leaving the palm fields in as well makes the UNSPLIT column cull 10.5% of its
 * own triangles - at which point the 100% ceiling this file quotes is simply
 * false. `walkWorldTriangles` mirrors `WebGLRenderer.projectObject`, so an
 * invisible mesh is skipped exactly as the renderer would skip it.
 */
function submitted(group, v) {
  return withoutTerrain(group, () => walkWorldTriangles(group, place(v), { breakdown: false }).triangles);
}

/**
 * Run `fn` with everything that is not a district hidden, then put it back.
 *
 * Terrain tiles and instanced fields, and the same test applies to both:
 * `CitadelWorld` partitions each of them ITSELF, by a mechanism this module
 * does not own and cannot own - the ground by `medieval/TerrainTiles.js`, the
 * date palms by being BUILT as four quadrant fields rather than one, which is
 * `MedievalWorld`'s answer too and is an authoring decision, not surgery on a
 * mesh. Both therefore cull identically in the unsplit world and the split one.
 * Left in, they put a large, already-culling, identical number on both sides of
 * every ratio below - which drags each one toward 100% and, worse, makes the
 * "before" column cull 10.5% of its own triangles, so the 100% ceiling this
 * test quotes stops being true. `lodTargets` holds the instanced fields out for
 * exactly this reason and says so; this is the same exclusion applied to the
 * triangle counts.
 */
function withoutTerrain(group, fn) {
  const hidden = [];
  group.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    /* The ground, the instanced fields AND the outer ring's six regions.
     *
     * The ring joined this list for exactly the reason the terrain did: it
     * arrives ALREADY SPLIT, so an identical, already-culling number sits in
     * both columns and drags the ratio toward 1, and what is left of this
     * module's own contribution disappears into it. `CitadelWorld._buildRegions`
     * merges one batch per region and the six are up to 700 m apart, so each
     * comes out as two to six meshes with a 45-90 m sphere - under the 130 m
     * ceiling before `splitDistricts` is handed anything. Measured: with the
     * regions in, the UNSPLIT world culls 19.6% of its own triangles from a
     * street framing, which is not a ceiling of 100% and not this module's
     * doing either way.
     *
     * The two caves are held out for the identical reason and by the identical
     * mechanism: `_buildCaves` merges one batch each, 350 m apart, so they too
     * arrive under the ceiling. `citadel-regions.test.mjs` owns the ring's own
     * culling ledger. This file measures the mesa's districts, which is what it
     * splits. */
    /* The caravan drop's oases and wells join the list on the same terms as the
     * ring and the caves: `_buildTraffic` merges one batch per oasis and one for
     * all eight wells, and what comes back out of the splitter there is leaves
     * of 20-40 m scattered over the flats. Left in, the UNSPLIT world culls
     * 10.7% of its own triangles from a street framing - which is not a ceiling
     * of 100% and, again, is not this module's doing either way. */
    if (o.name.startsWith('citadel:terrain') || o.name.startsWith('region:')
      || o.name.startsWith('cave:') || o.name.startsWith('oasis:')
      || o.name.startsWith('wells') || o.isInstancedMesh) {
      o.visible = false;
      hidden.push(o);
    }
  });
  try {
    return fn();
  } finally {
    for (const o of hidden) o.visible = true;
  }
}

/**
 * An order-independent 64-bit digest of a triangle soup.
 *
 * Commutative on purpose: the partition is allowed to reorder triangles - that
 * is most of what it does - and is not allowed to lose, duplicate or alter one.
 * Summing a per-triangle hash makes the first legal and the other three
 * detectable. Every attribute is folded in, not just position, because a
 * partition that dropped the colour attribute would leave the shape perfect and
 * the town black.
 */
function soupDigest(root) {
  let lo = 0;
  let hi = 0;
  let count = 0;
  root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh) return;
    const g = o.geometry;
    const keys = Object.keys(g.attributes).sort();
    const idx = g.index?.array ?? null;
    const tris = triangleCount(g);
    for (let t = 0; t < tris; t++) {
      /* FNV-1a over the triangle's three corners, all attributes, in corner
       * order. Quantised to 1e-4 m so a legal float re-rounding cannot ring the
       * alarm, which is far finer than any geometry in this world. */
      let h = 2166136261;
      for (let c = 0; c < 3; c++) {
        const v = idx ? idx[t * 3 + c] : t * 3 + c;
        for (const k of keys) {
          const a = g.attributes[k];
          for (let i = 0; i < a.itemSize; i++) {
            const q = Math.round(a.array[v * a.itemSize + i] * 1e4) | 0;
            h ^= q & 0xff; h = Math.imul(h, 16777619);
            h ^= (q >>> 8) & 0xff; h = Math.imul(h, 16777619);
            h ^= (q >>> 16) & 0xff; h = Math.imul(h, 16777619);
            h ^= (q >>> 24) & 0xff; h = Math.imul(h, 16777619);
          }
        }
      }
      /* Both accumulators must be COMMUTATIVE or this stops being a multiset
       * digest and becomes an order digest, which the partition is entitled to
       * change. Two independent sums, the second over a re-mixed hash, so a
       * pair of triangles cannot swap values and cancel. */
      lo = (lo + (h >>> 0)) % 0x100000000;
      hi = (hi + (Math.imul(h ^ 0x5bf03635, 0x9e3779b1) >>> 0)) % 0x100000000;
      count++;
    }
  });
  return `${count}:${(lo >>> 0).toString(16)}:${(hi >>> 0).toString(16)}`;
}

/* ================================================================== */
/* 1. The partition                                                    */
/* ================================================================== */

test('the split moves every triangle and loses none', async () => {
  const { virgin, split } = await worlds();
  const a = soupDigest(virgin.group);
  const b = soupDigest(split.group);
  /* If this is ever red, nothing else in the file means anything: a partition
   * that drops geometry can make every culling number below look wonderful. */
  assert.equal(b, a, 'the split world is not the same triangle soup as the unsplit one');

  const before = districtStats(virgin.group);
  const after = districtStats(split.group);
  assert.equal(after.triangles, before.triangles,
    `${before.triangles} triangles became ${after.triangles}`);
  console.log(`\n    soup ${a} preserved across ${before.meshes} -> ${after.meshes} meshes`);
});

test('the buckets are under the ceiling Medieval already ships', async () => {
  const { virgin, split } = await worlds();
  const before = districtStats(virgin.group);
  const after = districtStats(split.group);

  /* ── The claim is about triangles, not about mesh count ────────────────
   *
   * `medieval-towns.test.mjs:583-584` asserts `worst < 130` over every mesh,
   * and Medieval can, because that assertion runs over `_buildTowns()` alone -
   * five dense town districts and no ground. Citadel's group contains its own
   * ground, and ground is the case a triangle-budgeted splitter cannot always
   * reach: `cliff:dirt.ground` is 3,708 triangles spread over a 560 m ring at
   * HALF 200, so bringing its last two leaves under the ceiling means emitting
   * leaves of 24 triangles - two boxes, given a draw call of their own.
   *
   * So what is asserted is what the split actually guarantees, said precisely:
   * essentially all of the world's geometry is inside the ceiling, and the
   * remainder is only there because the floor stopped the recursion, not
   * because it failed.
   *
   * floor    >= 99.5% of splittable triangles in buckets under 130 m
   * achieved  100.00% at HALF 450; 99.93% at HALF 200 (2 leaves, 232 triangles)
   * ceiling   74.2% - the same world with the split off, where the cliff, the
   *           terrain, the dirt ring and the props are all over it */
  const overTris = after.over.reduce((a, m) => a + triangleCount(m.geometry), 0);
  const splittable = after.triangles;
  const inside = 1 - overTris / splittable;
  assert.ok(inside >= 0.995,
    `${(100 * inside).toFixed(2)}% of triangles are in buckets under ${MAX_DISTRICT_RADIUS} m; `
    + `floor 99.5%. Over: ${after.over.map((m) => `${m.name} (${triangleCount(m.geometry)})`).join(', ')}`);

  /* And every bucket left over the ceiling has to be one the FLOOR stopped -
   * anything bigger means the recursion gave up for some other reason, which
   * is a bug and not a trade. */
  for (const m of after.over) {
    assert.ok(triangleCount(m.geometry) < MIN_LEAF_TRIANGLES * 2,
      `${m.name} is ${after.worstRadius.toFixed(1)} m with ${triangleCount(m.geometry)} triangles - `
      + `over the ceiling and over the floor, so nothing stopped the split but it stopped`);
  }

  /* The ablation, asserted rather than assumed: if the unsplit world's worst
   * sphere ever came in near the ceiling by itself, the numbers above would be
   * measuring a world that never needed this module. */
  assert.ok(before.worstRadius > MAX_DISTRICT_RADIUS * 2,
    `the unsplit world's worst sphere is only ${before.worstRadius.toFixed(1)} m - `
    + 'this test can no longer tell a working split from an absent one');
  assert.ok(after.worstRadius < before.worstRadius * 0.6,
    `worst sphere only came down ${before.worstRadius.toFixed(1)} -> ${after.worstRadius.toFixed(1)} m`);

  const beforeOverTris = before.over.reduce((a, m) => a + triangleCount(m.geometry), 0);
  console.log(`    worst bounding sphere ${before.worstRadius.toFixed(1)} m -> ${after.worstRadius.toFixed(1)} m `
    + `(${after.worstName}); triangles inside the ceiling `
    + `${(100 * (1 - beforeOverTris / before.triangles)).toFixed(2)}% -> ${(100 * inside).toFixed(2)}%`);
  if (after.instanced.length) {
    console.log('    instanced fields, out of this module\'s reach and reported not dropped: '
      + after.instanced.map((f) => `${f.name} r${f.radius.toFixed(0)} ${f.triangles}t`).join(', '));
  }
});

test('the split costs no resident bytes, because it is a partition', async () => {
  const { virgin, split } = await worlds();
  const before = districtStats(virgin.group);
  const after = districtStats(split.group);
  /* floor    no increase at all; the same vertices are redistributed
   * achieved  27.40 -> 27.33 MB, a 0.07 MB REFUND (the terrain's index drops
   *           to 16 bits once each bucket fits inside 65,536 vertices)
   * ceiling   a naive implementation that de-indexed the terrain would have
   *           taken it from 0.60 MB to 1.75 MB */
  assert.ok(after.bytes <= before.bytes,
    `resident geometry grew ${(before.bytes / 1048576).toFixed(2)} -> ${(after.bytes / 1048576).toFixed(2)} MB`);
  console.log(`    resident ${(before.bytes / 1048576).toFixed(2)} MB -> ${(after.bytes / 1048576).toFixed(2)} MB`);
});

test('the same input splits to the same bytes, twice', async () => {
  /* Everything downstream of a build in this project is pinned by digest for
   * one reason: a `Math.random`, a `Map` iteration order or a comparator that
   * ties would all pass every other test in this file and fail exactly once, in
   * a screenshot comparison two months from now, on a build nobody can
   * reproduce. `splitGeometry` sorts on a STRICT total order (axis coordinate,
   * then triangle id) precisely so this can be asserted. */
  const world = await buildCitadel({ split: false });
  let source = null;
  world.group.traverse((o) => {
    if (o.isMesh && o.name === 'cliff:stone.castle') source = o.geometry;
  });
  assert.ok(source, 'cliff:stone.castle has gone - re-point this test at another big district');

  const digest = (parts) => parts.map((g) => {
    const p = g.attributes.position.array;
    let h = 2166136261;
    for (let i = 0; i < p.length; i++) {
      const q = Math.round(p[i] * 1e4) | 0;
      h ^= q & 0xffff; h = Math.imul(h, 16777619);
      h ^= (q >>> 16) & 0xffff; h = Math.imul(h, 16777619);
    }
    return `${p.length}/${(h >>> 0).toString(16)}`;
  }).join(',');

  const a = digest(splitGeometry(source));
  const b = digest(splitGeometry(source));
  assert.equal(b, a, 'two splits of one geometry disagree');
  assert.ok(a.split(',').length > 1, 'the district did not split at all - this test proves nothing');
  console.log(`    ${a.split(',').length} buckets, identical across two runs`);
});

test('a geometry that cannot be split is returned, not recursed on', async () => {
  /* The stop this exercises is the one that would hang a build. Two triangles
   * 400 m across whose centroids coincide on every axis: the bucket is far over
   * the ceiling, the longest axis cannot separate them, and a splitter that
   * trusted "radius too big, therefore cut" would cut for ever. The honest
   * answer is to hand the caller a bucket over the ceiling and let
   * `districtStats` report it. */
  const g = new THREE.BufferGeometry();
  const P = [];
  for (let i = 0; i < 8; i++) {
    /* Both triangles are 900 m across and both have their centroid exactly at
     * the origin, on every axis. */
    P.push(-300, 0, -300, 300, 0, -300, 0, 0, 600);
    P.push(300, 0, 300, -300, 0, 300, 0, 0, -600);
  }
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3));
  const parts = splitGeometry(g, { maxRadius: 10, minLeaf: 1 });
  assert.equal(parts.length, 1, 'a degenerate geometry was cut anyway');
  assert.equal(parts[0], g, 'the input should come back by identity when nothing was split');
});

test('a mesh that opts out of frustum culling is left whole', async () => {
  const { split } = await worlds();
  /* The sky dome is 2,976 triangles on a 900 m sphere with `frustumCulled =
   * false`, because it is drawn from everywhere by design. Splitting it would
   * add draw calls to make a promise the renderer has been told to ignore. */
  const sky = [];
  split.group.traverse((o) => { if (o.isMesh && o.frustumCulled === false) sky.push(o); });
  assert.ok(sky.length > 0, 'no frustum-culling opt-out left in the world - re-point this test');
  for (const m of sky) {
    assert.ok(!m.name.includes('#'),
      `${m.name} was split despite frustumCulled === false`);
  }
  console.log(`    left whole: ${sky.map((m) => m.name).join(', ')}`);
});

/* ================================================================== */
/* 2. What the split buys, and what it costs                           */
/* ================================================================== */

test('the frustum has something to cull from a street', async () => {
  const { virgin, split } = await worlds();
  const rows = FRAMINGS.map((v) => {
    const before = submitted(virgin.group, v);
    const after = submitted(split.group, v);
    return { name: v.name, before, after, pct: after / before };
  });
  console.log('\n    framing              before     after    pct');
  for (const r of rows) {
    console.log(`    ${r.name.padEnd(18)} ${String(r.before).padStart(7)} ${String(r.after).padStart(9)}  ${(100 * r.pct).toFixed(1)}%`);
  }

  const best = Math.min(...rows.map((r) => r.pct));
  const mean = rows.reduce((a, r) => a + r.after, 0) / rows.reduce((a, r) => a + r.before, 0);

  /* ── The ledger shrank, and where it went is the point ─────────────────
   *
   * This test shipped quoting 85.6% best / 92.2% mean at HALF 450, and both
   * numbers had the TERRAIN in them: the ground was one mesh with a 636 m
   * sphere in the "before" column and ~30 buckets in the "after", which is the
   * single largest culling win a spatial split can produce anywhere in this
   * world. `CitadelWorld` now slices the ground into 150 m tiles itself, before
   * this module is handed anything, so that win has moved out of this module's
   * ledger and into the world's - and `submitted` holds the terrain out of both
   * columns rather than letting an identical, already-culling number sit on
   * each side and drag the ratio to 1.
   *
   * What is left here is the districts alone, which is what this module
   * actually does, and it is a smaller and more honest number.
   *
   * floor    the tightest framing must submit <= 90% of what it did unsplit
   * achieved  85.6% (ward-centre: 202,204 -> 173,018); souk-alley 85.7%
   * ceiling   100.0% - the ablation, which is what every framing measured
   *           before this module existed */
  assert.ok(best <= 0.90,
    `the best framing still submits ${(100 * best).toFixed(1)}% of the unsplit world; floor 90%`);
  /* floor    the mean across all seven framings <= 95%
   * achieved  93.4% (204,161 -> 190,751)
   * ceiling   100.0% */
  assert.ok(mean <= 0.95,
    `mean submitted is ${(100 * mean).toFixed(1)}% of unsplit; floor 95%`);

  /* The ablation, asserted rather than assumed: if the unsplit world ever
   * starts culling on its own, every percentage above is measuring something
   * other than this module. */
  const unsplitCulled = MESA_FRAMINGS.map((v) => withoutTerrain(virgin.group, () => {
    const r = walkWorldTriangles(virgin.group, place(v), { breakdown: false });
    return r.culledTriangles / (r.triangles + r.culledTriangles);
  }));
  assert.ok(Math.max(...unsplitCulled) < 0.05,
    `the unsplit world already culls ${(100 * Math.max(...unsplitCulled)).toFixed(1)}% of its triangles `
    + '- the ceiling this test quotes is no longer 100%');
});

test('the split stays inside the draw-call budget this project ships', async () => {
  const { virgin, split } = await worlds();
  const before = districtStats(virgin.group);
  const after = districtStats(split.group);

  /* floor    <= 175 draw calls for the whole 900 m world
   * achieved  164
   * ceiling   48 - the unsplit world, which is the cheapest possible and also
   *           the one that culls nothing
   *
   * WHY 175 AND NOT THE 150 THIS SHIPPED WITH. 150 came from
   * `medieval-towns.test.mjs:607`, where it bounds FIVE TOWNS at ~177k
   * triangles and ~116 draws - a subset of a world rather than a world. The
   * caravan drop is where the borrowed number bound on content instead of on
   * cost: two oases (nine meshes each - six masonry buckets, a water plane and
   * two instanced palm fields) and eight wayside wells take the Citadel from
   * 136 to 164 for 56,648 triangles of content in the flats the player reported
   * as empty. `citadel-budgets.test.mjs` carries the same ceiling and pairs it
   * with a floor on TRIANGLES PER DRAW CALL, which is the bound that actually
   * catches fifty meshes of nothing: medieval ships 1,733 per draw and the
   * Citadel is at 3,300. */
  assert.ok(after.meshes <= 175,
    `${after.meshes} draw calls after the split; floor 175, unsplit ${before.meshes}`);

  /* The rate the split buys triangles at, said out loud next to the rate this
   * project already pays. Medieval ships 150 draws against 260k triangles and
   * measures ~116 against ~177k: 1,500-1,700 triangles per draw call. The split
   * buys at 508-614 today, which is BELOW that rate, and is why the module
   * header carries the modelled 5x figure (1,999) and the crossover next to it.
   * The split is landed today because it is what makes `DistanceLod` work at
   * all, not because the draw-call arithmetic pays on its own.
   * Asserted only as a sanity floor - a rate near zero means the split has
   * stopped removing anything and is pure draw-call cost. */
  const meanBefore = FRAMINGS.reduce((a, v) => a + submitted(virgin.group, v), 0) / FRAMINGS.length;
  const meanAfter = FRAMINGS.reduce((a, v) => a + submitted(split.group, v), 0) / FRAMINGS.length;
  const rate = (meanBefore - meanAfter) / (after.meshes - before.meshes);
  assert.ok(rate > 200,
    `the split buys ${rate.toFixed(0)} triangles per added draw call; floor 200`);
  console.log(`    ${before.meshes} -> ${after.meshes} draws, `
    + `${Math.round(meanBefore)} -> ${Math.round(meanAfter)} mean triangles, `
    + `${rate.toFixed(0)} triangles saved per added draw call`);
});

test('the biggest district is split before the cheap ones warm the code up', async () => {
  /* Not tidiness. `splitDistricts` works in ascending triangle order because
   * measured cold, one mesh at a time, the first district through pays for
   * compiling `sphereOfRange`, `select` and `buildSub`:
   *
   *   world order      cliff 32.5 ms, terrain 21.7 ms
   *   smallest first   cliff 18.2 ms, terrain 13.2 ms
   *
   * against design 5.4's 24 ms slice budget. Warm, both converge (cliff 12.1
   * ms). The ORDER is what is asserted, because a wall-clock assertion on a
   * shared runner is a flake generator; the timings are printed. */
  const world = await buildCitadel({ split: false });
  const all = [];
  world.group.traverse((o) => { if (o.isMesh) all.push(o); });
  const t0 = performance.now();
  splitDistricts(all);
  const ms = performance.now() - t0;

  /* The order is observable in the graph: `splitMesh` removes the parent and
   * appends its leaves, so the leaves appear in visit order. */
  const leafFirstIndex = new Map();
  let i = 0;
  for (const child of world.group.children) {
    if (child.isMesh && child.name.includes('#')) {
      const district = child.name.split('#')[0];
      if (!leafFirstIndex.has(district)) leafFirstIndex.set(district, i);
    }
    i++;
  }
  const sizes = new Map(all.map((m) => [m.name, triangleCount(m.geometry)]));
  const visited = [...leafFirstIndex.entries()].sort((a, b) => a[1] - b[1]).map(([n]) => n);
  assert.ok(visited.length >= 3, `only ${visited.length} districts split - this test proves nothing`);
  for (let k = 1; k < visited.length; k++) {
    assert.ok(sizes.get(visited[k - 1]) <= sizes.get(visited[k]),
      `${visited[k - 1]} (${sizes.get(visited[k - 1])} tris) was split before `
      + `${visited[k]} (${sizes.get(visited[k])} tris) - the ascending order is gone`);
  }
  console.log(`    split ${visited.length} districts in ascending size, whole world in ${ms.toFixed(0)} ms`);
});

/* ================================================================== */
/* 3. Split FIRST, then DistanceLod                                    */
/* ================================================================== */

/**
 * The district meshes, which is what this module makes and what it registers.
 *
 * `frustumCulled === false` is out because the sky is drawn from everywhere by
 * design. `InstancedMesh` is out because Citadel's date palms are two instanced
 * fields, not districts - `DistanceLod` handles them perfectly well and
 * `registerDistricts` reads their OBJECT sphere for exactly that reason, but
 * measuring the split's effect with them mixed in measures something else.
 */
function lodTargets(root) {
  const out = [];
  root.traverse((o) => {
    if (!o.isMesh || o.frustumCulled === false || o.isInstancedMesh) return;
    /* Terrain tiles are out for the same reason the instanced fields are: they
     * are not districts and this module did not make them. `CitadelWorld` slices
     * the ground with `medieval/TerrainTiles.js` and gives each tile its own
     * measured `lo` band (`citadel/TerrainDetail.js`), because on that content a
     * single global swap distance is worth 637 m. Counting 127,000 regular-grid
     * terrain triangles - none of which an AREA filter can drop, since every
     * quad is 7 m2 - as "lo geometry this module failed to reduce" measures the
     * ground's LOD and calls it the split's. */
    if (o.name.startsWith('citadel:terrain')) return;
    /* And the ring, for the same reason it is held out of the culling ledger:
     * `_buildRegions` merges one batch per region, so its meshes were never
     * candidates for this module's split and counting them as buckets it
     * produced measures the AUTHORING and calls it the splitter. */
    if (o.name.startsWith('region:') || o.name.startsWith('cave:')) return;
    /* And the caravan drop's oases and wayside wells, for the third time and
     * the same reason. `_buildTraffic` merges one batch per oasis and one for
     * the eight wells; the wells land 70-450 m apart, so what comes out of
     * `_splitDistricts` there is five leaves under 40 m across each - already
     * bucketed, and never a candidate for the mesa split this module is about.
     * Left in, they took the "merged world hides nothing" ablation from 0 to
     * 14, which is not the merged mesa becoming cullable, it is fourteen
     * pre-split meshes joining the count. */
    if (o.name.startsWith('oasis:') || o.name.startsWith('wells')) return;
    out.push(o);
  });
  return out;
}

/** How many of `meshes` a plain hide band puts away, per framing. */
function hiddenPerFraming(root, meshes, threshold, measure) {
  const lod = new DistanceLod();
  for (const m of meshes) lod.add(m, { hideBeyond: threshold, measure });
  const counts = FRAMINGS.map((v) => {
    lod.update(place(v));
    let n = 0;
    for (const m of meshes) if (!m.visible) n++;
    return n;
  });
  lod.clear();
  return counts;
}

test('DistanceLod on merged districts is inert - which is why the split comes first', async () => {
  const { virgin, split } = await worlds();
  const merged = lodTargets(virgin.group);
  const buckets = lodTargets(split.group);

  /* Two district-radii: a district is fully drawn while the camera is within
   * one more radius of its own edge. Not a tuned number - it is the ceiling
   * this module already ships, doubled - and the claim below was checked to
   * hold across a wide band around it (260, 293, 450 and 585 all measured). */
  const T = MAX_DISTRICT_RADIUS * 2;
  /* Mesa framings only. A ring vantage stands 300 m outside every merged
   * sphere in the town, so the band fires on 34 of them from
   * `caravanserai-mast` - which is true, and is not what "the merged districts
   * are map-spanning" is a claim about. See `MESA_FRAMINGS`. */
  const groundIdx = FRAMINGS.map((v, i) => (v.aerial || v.ring ? -1 : i)).filter((i) => i >= 0);
  const mergedHidden = hiddenPerFraming(virgin.group, merged, T, CENTRE);
  const bucketHidden = hiddenPerFraming(split.group, buckets, T, CENTRE);

  console.log(`\n    hideBeyond ${T}, CENTRE, per framing (${FRAMINGS.map((v) => v.name).join(', ')})`);
  console.log(`    merged  ${merged.length} meshes: ${mergedHidden.join(' ')}`);
  console.log(`    split   ${buckets.length} meshes: ${bucketHidden.join(' ')}`);

  /* This is design 5.4 U9's correction, measured. `DistanceLod`'s own header
   * says it "never merges or re-buckets anything"; Citadel's merged districts
   * are 103-637 m spheres all centred near the origin, so from every framing a
   * player can stand at, the band never fires on any of them. It is not a weak
   * optimisation on merged geometry, it is an absent one.
   *
   * floor    zero merged districts hidden from any GROUND framing
   * achieved  0 at all six
   * ceiling   n/a - this is the "before", and it is exactly zero */
  for (const i of groundIdx) {
    assert.equal(mergedHidden[i], 0,
      `${FRAMINGS[i].name}: the merged world hid ${mergedHidden[i]} districts - `
      + 'the districts are no longer map-spanning and this test is measuring something else');
  }
  /* floor    at least one bucket hidden from EVERY ground framing, and at
   *          least 15 across the six
   * achieved  1-32 each; 19 across the six at HALF 200, 173 at HALF 450
   * ceiling   0 - the ablation, which is the merged row directly above */
  const total = groundIdx.reduce((a, i) => a + bucketHidden[i], 0);
  for (const i of groundIdx) {
    assert.ok(bucketHidden[i] >= 1,
      `${FRAMINGS[i].name}: 0 of ${buckets.length} buckets hidden; floor 1`);
    assert.ok(bucketHidden[i] < buckets.length,
      `${FRAMINGS[i].name}: the band hid the entire world`);
  }
  assert.ok(total >= 15,
    `only ${total} buckets hidden across the six ground framings; floor 15`);
});

test('CENTRE fires where SURFACE does not, on district-sized spheres', async () => {
  const { split } = await worlds();
  const buckets = lodTargets(split.group);
  const T = MAX_DISTRICT_RADIUS * 2;
  const centre = hiddenPerFraming(split.group, buckets, T, CENTRE);
  const surface = hiddenPerFraming(split.group, buckets, T, SURFACE);
  console.log(`\n    threshold ${T}   CENTRE ${centre.join(' ')}`);
  console.log(`                  SURFACE ${surface.join(' ')}`);

  /* `station/Tower.js:1032-1049` makes this argument for one building: SURFACE
   * measures to the nearest point, so a bucket of radius r only demotes once
   * the camera is threshold + r from its centre, and on a large bucket that
   * window is most of the map.
   *
   * Split by framing kind, the same distinction the previous test draws, and
   * for a sharper reason than tidiness: from the AERIAL framing both measures
   * fire on nearly everything, so their ratio is compressed toward 1 by
   * saturation rather than by any property of the measures. One floor across
   * both hides the strong result inside the weak one.
   *
   * GROUND framings - the six a player can stand at
   *   floor    CENTRE hides at least 2x what SURFACE hides, or SURFACE hides
   *            nothing at all and CENTRE hides something
   *   achieved  8/4, 6/2, 9/3, 9/3, 2/0, 2/0 - so 2.0x, 3.0x, 3.0x, 3.0x and
   *            twice "SURFACE is inert here and CENTRE is not"
   *   ceiling   unbounded; on the UNSPLIT world both are 0 at all six, which
   *            is the previous test
   *
   * AERIAL - the ablation for the ratio itself
   *   floor    CENTRE >= SURFACE, i.e. the domination never inverts
   *   achieved  20 v 16
   *
   * The ground floors moved UP from the single 1.3x this test shipped with,
   * and the reason the aerial number moved down is `DISTRICT_MIN_LEAF` going
   * 108 -> 24 in `CitadelWorld`: the two measures differ by exactly the
   * bucket's radius, so a finer partition converges them by construction. That
   * is what C3's ceiling bought - 0 buckets over 130 m instead of 2 - and it is
   * paid out of the aerial ratio, not the ground ones. */
  /* The ring vantages join the aerial one under the weaker rule, and for the
   * same measured reason: from 300 m outside the town both measures fire on
   * nearly everything (`caravanserai-mast` reads CENTRE 54 against SURFACE 51),
   * so their ratio is compressed toward 1 by saturation rather than by any
   * property of the measures. What still has to hold out there is that the
   * domination never inverts. */
  const aerial = new Set(FRAMINGS.map((v, i) => (v.aerial || v.ring ? i : -1)).filter((i) => i >= 0));
  for (let i = 0; i < FRAMINGS.length; i++) {
    if (aerial.has(i)) {
      assert.ok(centre[i] >= surface[i],
        `${FRAMINGS[i].name}: CENTRE ${centre[i]} hid FEWER than SURFACE ${surface[i]}`);
      continue;
    }
    assert.ok(centre[i] >= surface[i] * 2 || (surface[i] === 0 && centre[i] > 0),
      `${FRAMINGS[i].name}: CENTRE ${centre[i]} vs SURFACE ${surface[i]}; floor 2x`);
  }
  assert.ok(centre.some((c) => c > 0), 'neither measure fired anywhere - nothing was compared');
});

test('a nearest-point band is a centre band shifted by the radius, exactly', async () => {
  /* `registerDistricts` takes `swapNearest` as a nearest-point distance and
   * converts it to a CENTRE threshold per mesh, so that one entry can carry a
   * whole-district hide band and a per-triangle swap band without two measures.
   * The conversion is only legitimate if the two are the same statement, so it
   * is proved here rather than asserted in a comment.
   *
   * The exception is float rounding at the band edge: `(d - r) > T` and
   * `d > (T + r)` are the same real number and not the same double. Every
   * disagreement therefore has to sit within a hair of the threshold, and that
   * is what is checked - a disagreement anywhere else is a real bug. */
  const { split } = await worlds();
  const buckets = lodTargets(split.group);
  const T = 120;
  const a = new DistanceLod();
  const b = new DistanceLod();
  for (const m of buckets) {
    a.add(m, { hideBeyond: T, measure: SURFACE });
    b.add(m, { hideBeyond: T + sourceSphere(m).radius, measure: CENTRE });
  }
  let compared = 0;
  let disagreed = 0;
  let worstMargin = Infinity;
  const camPos = new THREE.Vector3();
  for (const v of FRAMINGS) {
    const cam = place(v);
    cam.getWorldPosition(camPos);
    a.update(cam);
    const sa = buckets.map((m) => m.visible);
    a.clear();
    b.update(cam);
    const sb = buckets.map((m) => m.visible);
    b.clear();
    for (let i = 0; i < buckets.length; i++) {
      compared++;
      if (sa[i] === sb[i]) continue;
      disagreed++;
      const s = sourceSphere(buckets[i]);
      const margin = Math.abs((camPos.distanceTo(s.center) - s.radius) - T);
      if (margin < worstMargin) worstMargin = margin;
      assert.ok(margin < 1e-3,
        `${buckets[i].name} disagrees ${margin.toFixed(6)} m from the threshold - not rounding`);
    }
  }
  /* floor    <= 0.5% of comparisons may disagree, and only at the edge
   * achieved  0 of 483 (HALF 200) and 0 of 637 (HALF 450) - no bucket in this
   *           world happens to sit on a band edge, so the rounding slack the
   *           floor allows is not currently used
   * ceiling   a genuinely different measure disagrees on tens of percent: the
   *           same comparison between CENTRE(T) and SURFACE(T) is 30-50% */
  assert.ok(disagreed / compared <= 0.005,
    `${disagreed} of ${compared} states disagree (${(100 * disagreed / compared).toFixed(2)}%); floor 0.5%`);
  console.log(`    ${disagreed}/${compared} disagreements, all within `
    + `${Number.isFinite(worstMargin) ? worstMargin.toExponential(1) : '0'} m of the band edge`);
});

test('a band no camera can ever cross is refused, not registered', async () => {
  const { split } = await worlds();
  const buckets = lodTargets(split.group);
  const { HALF } = await import('../../src/worlds/terrain/CitadelHeight.js');

  /* The failure this catches is silent and expensive: a threshold beyond
   * anything the camera can reach reads as a working optimisation and costs a
   * per-frame distance test for ever. `station/Tower.js:1032-1049` works the
   * same sum by hand and calls the SURFACE version of it "a true statement
   * about the sphere and a useless one about the building".
   *
   * Reach is `HALF * sqrt(2)` and NOT `HALF`: the playfield is a 900 m SQUARE,
   * so the furthest a camera stands from the origin is the corner, not the
   * half-edge. Writing `HALF` here (and at both of the world's own call sites)
   * understated every reach by 186 m and refused two live terrain bands. The
   * furthest a camera gets from a sphere centred at c is reach + |c|, so a
   * threshold past that is dead by construction. */
  const reachable = buckets.map((m) => sourceSphere(m).center.length() + HALF * Math.SQRT2);
  const nearest = Math.min(...reachable);
  const furthest = Math.max(...reachable);

  const live = registerDistricts(new DistanceLod(), buckets, { hideBeyond: nearest - 1 });
  const dead = registerDistricts(new DistanceLod(), buckets, { hideBeyond: furthest + 1 });

  assert.equal(live.registered, buckets.length,
    `a threshold inside every bucket's reach registered only ${live.registered} of ${buckets.length}`);
  assert.equal(dead.registered, 0,
    `${dead.registered} registrations survived a threshold ${(furthest + 1).toFixed(0)} m `
    + `beyond the furthest reachable ${furthest.toFixed(0)} m`);
  assert.equal(dead.reasons.length, buckets.length,
    'a refused band must say which mesh and why');

  /* And the predicate itself, on a sphere with no world around it. */
  const s = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 100);
  assert.equal(bandCanFire(s, 150, CENTRE, 200), true);
  assert.equal(bandCanFire(s, 250, CENTRE, 200), false);
  /* The same threshold under SURFACE is 100 m further out, and dies sooner. */
  assert.equal(bandCanFire(s, 150, SURFACE, 200), false);
  assert.equal(bandCanFire(s, 99, SURFACE, 200), true);
  assert.equal(bandCanFire(s, Infinity, CENTRE, 200), true, 'a disabled band is not a dead one');
  console.log(`    ${live.registered}/${buckets.length} live at ${(nearest - 1).toFixed(0)} m, `
    + `0/${buckets.length} at ${(furthest + 1).toFixed(0)} m`);
});

/* ================================================================== */
/* 4. Low detail, and the memory it costs                              */
/* ================================================================== */

test('the lo geometry drops the rounding and keeps the shape', async () => {
  const { split } = await worlds();
  let hi = 0;
  let lo = 0;
  let hiBytes = 0;
  let loBytes = 0;
  for (const m of lodTargets(split.group)) {
    hi += triangleCount(m.geometry);
    hiBytes += geometryBytes(m.geometry);
    const r = lowDetail(m.geometry, { minArea: 0.35 });
    if (!r) { lo += triangleCount(m.geometry); continue; }
    lo += r.kept;
    loBytes += geometryBytes(r.geometry);
    r.geometry.dispose();
  }
  /* `Batch.box` rounds every box whose smallest dimension clears BEVEL_MIN with
   * a RoundedBoxGeometry: 108 triangles where a plain box is 12, and 96 of the
   * 108 are bevel strips a few centimetres across. An area filter separates the
   * shape from the rounding without needing to know which triangle came from
   * which box, which merged soup cannot tell you.
   *
   * floor    the lo must be <= 45% of the hi, or it is not worth a second
   *          resident buffer
   * achieved  30.1% (230,050 -> 69,148)
   * ceiling   100% - no swap at all */
  assert.ok(lo / hi <= 0.45,
    `lo keeps ${(100 * lo / hi).toFixed(1)}% of the triangles; floor 45%`);
  /* floor    <= 25% of the hi's bytes
   * achieved  19.5% (5.30 MB on 27.13 MB)
   * ceiling   100% - a lo that dropped nothing */
  assert.ok(loBytes / hiBytes <= 0.25,
    `lo costs ${(100 * loBytes / hiBytes).toFixed(1)}% of the hi's bytes; floor 25%`);
  console.log(`\n    lo at minArea 0.35: ${hi} -> ${lo} triangles (${(100 * lo / hi).toFixed(1)}%), `
    + `+${(loBytes / 1048576).toFixed(2)} MB on ${(hiBytes / 1048576).toFixed(2)} MB`);
});

test('the swap distance is where the slit it opens is sub-pixel', async () => {
  /* Dropping a bevel strip leaves a slit exactly BEVEL wide where two faces no
   * longer meet, and a slit shows background through a solid box. So the swap
   * band is not chosen for triangle count, it is chosen for pixels, and the
   * source of BEVEL is checked rather than remembered - a bevel widened in
   * CitadelWorld.js would silently invalidate the distance below. */
  const src = readFileSync(new URL('src/worlds/CitadelWorld.js', ROOT), 'utf8');
  const m = /^const BEVEL = ([0-9.]+);$/m.exec(src);
  assert.ok(m, 'CitadelWorld no longer declares `const BEVEL = ...` - re-derive the swap distance');
  const bevel = Number(m[1]);
  assert.equal(bevel, 0.075, `BEVEL is ${bevel} now, not the 0.075 this distance was computed from`);

  const d = subPixelDistance(bevel);
  /* At CONFIG.render.fov 75 over a 1080-line reference, one pixel subtends
   * d * 0.001421 m, so 0.075 m disappears at 52.8 m. */
  assert.ok(Math.abs(d - 52.8) < 0.2, `sub-pixel distance came out ${d.toFixed(1)} m, expected 52.8`);

  /* And the arithmetic is right in both directions, so a change of fov or
   * reference height moves it the way it should. */
  assert.ok(subPixelDistance(bevel, 60) > d, 'a narrower fov must push the distance further out');
  assert.ok(subPixelDistance(bevel, 75, 2160) > d, 'more pixels must push the distance further out');
  console.log(`    BEVEL ${bevel} m is sub-pixel beyond ${d.toFixed(1)} m at fov 75 / 1080 lines`);
});

test('post-LOD residency, not pre-LOD, is what fits the budget', async () => {
  const { split } = await worlds();
  const buckets = lodTargets(split.group);
  const lod = new DistanceLod();
  /* The swap band alone, no hide band. A hide band's yield depends on where the
   * threshold is put relative to the world's own size, which moves with HALF;
   * the swap band's does not, because `swapNearest` is derived from a pixel. */
  const rep = registerDistricts(lod, buckets, {
    swapNearest: subPixelDistance(0.075),
    lo: (g) => lowDetail(g, { minArea: 0.35 })?.geometry ?? null,
  });
  const stats = districtStats(split.group);
  const resident = stats.bytes + rep.loBytes;

  const framings = FRAMINGS.map((v) => withoutTerrain(split.group, () => {
    lod.update(place(v));
    return walkWorldTriangles(split.group, _cam, { breakdown: false }).triangles;
  }));
  lod.clear();

  /* Design 5.4 C2 and C3 pull against each other and the budget has to be read
   * against the post-LOD number: the split costs nothing, but every `lo` is a
   * second resident buffer.
   *
   * floor    <= 90 MB, design 5.4 C2's budget for the 5x world
   * achieved  32.62 MB (27.33 split + 5.30 of lo)
   * ceiling   naive 5x is quoted at 143 MB in C2 */
  assert.ok(resident <= 90 * 1048576,
    `post-LOD residency is ${(resident / 1048576).toFixed(2)} MB; floor 90 MB`);
  assert.ok(rep.loBytes > 0, 'no lo geometry was built - this test is measuring the split alone');

  /* And it has to buy something, or the bytes are pure loss.
   *
   * The shape of the win is the point, not just its size: the LOD saves most at
   * the aerial overview and least in the alley, which is the exact mirror of
   * what the split does. They are not two goes at the same optimisation - the
   * split is the near-view cull and the band is the long-view one, and a world
   * that ships only one of them is uncovered at the other end.
   *
   * floor    mean submitted <= 92% of the split-only world, and the best
   *          framing <= 70%
   * achieved  84.2% mean; 52% at desert-overview, 94% at souk-alley
   * ceiling   100% - the split-only world, which is the ablation */
  const splitOnly = FRAMINGS.map((v) => submitted(split.group, v));
  const mean = framings.reduce((a, b) => a + b, 0) / splitOnly.reduce((a, b) => a + b, 0);
  const best = Math.min(...framings.map((t, i) => t / splitOnly[i]));
  assert.ok(mean <= 0.92, `LOD left ${(100 * mean).toFixed(1)}% of the split world; floor 92%`);
  assert.ok(best <= 0.70, `the best framing kept ${(100 * best).toFixed(1)}%; floor 70%`);
  for (let i = 0; i < FRAMINGS.length; i++) {
    assert.ok(framings[i] <= splitOnly[i],
      `${FRAMINGS[i].name}: LOD ADDED triangles, ${splitOnly[i]} -> ${framings[i]}`);
  }
  console.log(`\n    split ${(stats.bytes / 1048576).toFixed(2)} MB + lo ${(rep.loBytes / 1048576).toFixed(2)} MB `
    + `= ${(resident / 1048576).toFixed(2)} MB resident`);
  console.log('    framing              split   +LOD    pct');
  FRAMINGS.forEach((v, i) => {
    console.log(`    ${v.name.padEnd(18)} ${String(splitOnly[i]).padStart(7)} ${String(framings[i]).padStart(6)}  ${(100 * framings[i] / splitOnly[i]).toFixed(1)}%`);
  });
});

/* ================================================================== */
/* 5. The two rules this module was written under                      */
/* ================================================================== */

test('the maze BatchedMesh machinery has not been ported into a static world', async () => {
  /* Design 7 puts this out of scope and the reason is recorded in
   * `MazeBatches.js`: the maze needed multi-draw because it STREAMS. A static
   * world merges by material at build time and splits by space, and a
   * `BatchedMesh` appearing in this module would mean somebody had reached for
   * the streaming answer to a static problem. Cheap to check, and the check is
   * the only thing standing between a reader and reinventing it. */
  const src = readFileSync(new URL('src/worlds/citadel/Districts.js', ROOT), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/BatchedMesh\s*\(/.test(code), 'Districts.js constructs a BatchedMesh');
  assert.ok(!/new\s+THREE\.BatchedMesh/.test(code), 'Districts.js constructs a BatchedMesh');
  /* And it must not quietly merge the thing it was written to split. */
  assert.ok(!/mergeGeometries/.test(code),
    'Districts.js merges geometry - it exists to split it');
});

test('the constants are the ones this project already ships', async () => {
  /* MAX_DISTRICT_RADIUS is not a number somebody liked. It is the assertion
   * `medieval-towns.test.mjs` ships verbatim over its own districts, and the
   * point of reusing it is that "under the ceiling" means the same thing in
   * both worlds. If Medieval moves it, this has to move with it or the claim
   * quietly becomes two different claims. */
  const src = readFileSync(new URL('scripts/tests/medieval-towns.test.mjs', ROOT), 'utf8');
  const m = /assert\.ok\(worst < (\d+),/.exec(src);
  assert.ok(m, 'medieval-towns.test.mjs no longer asserts a `worst < N` bounding sphere');
  assert.equal(Number(m[1]), MAX_DISTRICT_RADIUS,
    `Medieval ships ${m[1]} m and this module uses ${MAX_DISTRICT_RADIUS} m`);

  const draws = /assert\.ok\(draws < (\d+),/.exec(src);
  assert.ok(draws, 'medieval-towns.test.mjs no longer asserts a draw-call ceiling');
  assert.ok(Number(draws[1]) >= 150,
    `Medieval's draw ceiling moved to ${draws[1]} - the budget quoted above is stale`);

  assert.ok(MIN_LEAF_TRIANGLES < 1500,
    `MIN_LEAF_TRIANGLES is ${MIN_LEAF_TRIANGLES}; at 1,500 the ground sheets stop `
    + 'splitting and nine buckets stay over the ceiling - see the constant\'s own header');
});
