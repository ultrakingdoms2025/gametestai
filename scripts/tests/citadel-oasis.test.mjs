import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/**
 * CAN A PLAYER SWIM IN THE OASIS, AND CAN THEY GET BACK OUT?
 *
 * ── The defect this file exists to not repeat ─────────────────────────────
 *
 * The medieval world's wildlife pass shipped 29 green tests and a player who
 * reported "i do not see any wolves or bears in the forest areas". Every
 * assertion in that suite was a "not closer than": a world with zero reachable
 * wildlife satisfied all of them. So every number here is a FLOOR, quoted
 * floor / achieved / ceiling, and the ceiling is taken by ABLATION - the
 * probe that proves the world is green is made to go red in the same process,
 * against a deliberately broken version of the same thing.
 *
 * ── DRAWN is not SWUM ─────────────────────────────────────────────────────
 *
 * The same pass also proved a five-wolf pack "drawn with 38 m of margin" that
 * was three pixels of 1,024,000. The equivalent trap here is a pool that
 * exists, holds water, registers volumes, passes a clearance audit, and cannot
 * be climbed out of. So the central case does not measure geometry at all: it
 * constructs the REAL `Player`, hands it the REAL `WaterVolumes` scanned off
 * the REAL built mesh, and drives it with `forward` held - the dumbest input a
 * player has - from the middle of the pool until it is standing on dry ground.
 * Anything less is an assumption.
 *
 * ── Emitted is not present ────────────────────────────────────────────────
 *
 * Every geometric claim is made against `physics.colliders` of a fully built
 * Citadel AFTER the oases are added to it, through `Caves.SolidField`, which
 * has never heard of an oasis plan.
 *
 * ── DRAWN AND SWUM is not LOOKED AT ───────────────────────────────────────
 *
 * Every case below section 4 was green, and the oasis was a rectangle of flat
 * saturated blue on a stepped grey ziggurat in the middle of a desert. Not one
 * assertion in this file had anything to say about it, because every one of
 * them was about whether the thing WORKS. A pool you cannot look at is a pool
 * nobody walks to, which is the same failure as a pool you cannot climb out
 * of, arriving by a different road.
 *
 * So section 4b measures the FORM: that the bank is sand rather than pool
 * lining, that the waterline is not a rectangle, that the water is tinted and
 * faded by its own depth, and that the sand which the irregular waterline
 * makes necessary actually covers what it leaves dry. Each one is pinned to a
 * number a photograph would have argued about.
 *
 * ── Mutation report ───────────────────────────────────────────────────────
 *
 * Seventeen mutations of the KIT (not of the assertions) were applied one at a
 * time and the whole suite re-run against each: delete the beach, bury the bed,
 * push the furniture onto the walkway, rename the water material, halve the
 * pool depth, stop using the host batch, coarsen the placement lattice, delete
 * the feather courses, move the deep collectible onto dry land, cut the palms,
 * widen the water over the crest, publish no caches, delete the reeds, publish
 * no NPC pitches, and move three of the controller thresholds this file is
 * written against. **17 of 17 went red.**
 *
 * Four of them went red only after the case that caught them was rewritten,
 * and each rewrite is recorded at the case: the water discovery had a
 * redundant channel hiding a dead one; the draw-call case was measuring a
 * batch it had supplied itself; the walkway ablation was a bearing sweep too
 * coarse to hit a 2 m object; and the lattice-drift case agreed with any pitch
 * you like until it was made to measure ground that is not flat.
 *
 * The form pass added ten more, each aimed at the case that claims to catch
 * it: key the rings on the old `depth > 0` boolean again; flatten the shore
 * function (twice - once against the outline, once against the strand); give
 * every sand lobe a collider; drop the water's alpha channel; flatten the
 * opacity ramp; emit no sand bars; seat a lobe on the HIGHEST surface under it
 * instead of the lowest; drop the ghost clamp; and put the library's pool blue
 * back. **10 of 10 went red.** Every assertion added in this pass was also
 * reversed one at a time and the case re-run: **32 of 32 went red.**
 *
 * TWO of the ten found real defects rather than confirming a guard, and both
 * are recorded in the kit: seating a lobe on the lowest surface under it is
 * correct and buries 29% of the sand unless the placement keeps each lobe
 * inside its own annulus, and the physics-side ghost probe read 2.30 m on a
 * 0.28 m lobe because it cast its ray from under the masonry.
 *
 * ── Cost ──────────────────────────────────────────────────────────────────
 * One shared Citadel build (~0.5 s) plus two oases and two site searches;
 * the whole file runs in about 6 s.
 */

/* ================================================================== */
/* A world, without a browser                                          */
/* ================================================================== */

/**
 * The least DOM and WebGL a Citadel build touches.
 *
 * Copied from `citadel-caves.test.mjs:harness`, which copied it from
 * `citadel-reach.test.mjs`, which copied it from `npc-routes.test.mjs`.
 * Copied rather than imported ON PURPOSE: importing another test module
 * registers ITS tests in this process, and this file would silently start
 * running the caves suite every time it ran.
 */
function harness() {
  if (globalThis.__citadelOasisHarness) return;
  globalThis.__citadelOasisHarness = true;

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

const Oasis = await import('../../src/worlds/citadel/Oasis.js');
const { SolidField } = await import('../../src/worlds/citadel/Caves.js');
const { Physics } = await import('../../src/physics/Physics.js');
const { WaterVolumes } = await import('../../src/systems/WaterVolumes.js');
const { Player } = await import('../../src/player/Player.js');
const { CONFIG } = await import('../../src/core/Config.js');
const Height = await import('../../src/worlds/terrain/CitadelHeight.js');

const {
  /* `citadelOases` and `findOasisSite` are no longer imported here: the search
   * they drive now runs inside `CitadelWorld._buildTraffic` and this suite
   * audits its result. The kit still exports both and
   * `citadel-traffic-live.test.mjs` covers the world's use of them. */
  oasisPlan, oasisProfile, settleOasis, auditVacancy,
  auditShoreline, auditGrounded, auditDressing, buildOases, solidCost, triangleCount,
  palmGeometry, ringSurface, shoreInset, shoreRadius, waterShade, ringAt, depthAt,
  POOL_DEPTH, FLOAT_DEPTH, SWIM_ENTER_DEPTH, SWIM_EXIT_DEPTH, STEP_MAX,
  MIN_DIVE, MAX_RELIEF, CAPSULE_R, GHOST_MAX, SHORE_INSET, WATER_SEGMENTS,
} = Oasis;

/**
 * THE BROADPHASE, read out of the grid the physics actually built.
 *
 * `_grid` is private and this is the only place in the suite that opens it.
 * The alternative is to re-derive the cell mapping here, which is a second
 * opinion about the thing being measured - and `Oasis.COLLIDER_SEG_M` is a
 * whole essay about a number that came out of this map.
 */
function worstBroadphaseCell(physics) {
  let count = 0;
  let key = null;
  let cells = 0;
  let entries = 0;
  for (const [k, list] of physics._grid) {
    cells++;
    entries += list.length;
    if (list.length > count) { count = list.length; key = k; }
  }
  const cs = physics.cellSize;
  const x = key === null ? 0 : (((key >> 13) & 0x1fff) - 2048) * cs;
  const z = key === null ? 0 : ((key & 0x1fff) - 2048) * cs;
  return { count, cells, entries, x, z };
}

/**
 * What the worst cell WOULD be if every dressing lobe carried a collider.
 *
 * The counterfactual, computed with `Physics._gridRange`'s own rule - a box
 * goes into the grid on its BOUNDING SPHERE, radius `|halfExtents|` - so it is
 * the same arithmetic the real insertion runs, applied to boxes that were
 * never inserted. This is the ablation on the claim that the sand is free.
 */
function broadphaseWithDressing(physics, oases) {
  const cs = physics.cellSize;
  /** @type {Map<number, number>} */
  const counts = new Map();
  for (const [k, list] of physics._grid) counts.set(k, list.length);
  let added = 0;
  for (const o of oases) {
    const { plan } = o;
    const cos = Math.cos(plan.yaw);
    const sin = Math.sin(plan.yaw);
    for (const dr of o.dressing) {
      const x = plan.x + dr.lx * cos + dr.lz * sin;
      const z = plan.z - dr.lx * sin + dr.lz * cos;
      const r = Math.hypot(dr.w * 0.5, dr.h * 0.5, dr.d * 0.5);
      const minX = Math.floor((x - r) / cs);
      const maxX = Math.floor((x + r) / cs);
      const minZ = Math.floor((z - r) / cs);
      const maxZ = Math.floor((z + r) / cs);
      for (let cx = minX; cx <= maxX; cx++) {
        for (let cz = minZ; cz <= maxZ; cz++) {
          const k = ((cx + 2048) << 13) | (cz + 2048);
          counts.set(k, (counts.get(k) ?? 0) + 1);
          added++;
        }
      }
    }
  }
  let worst = 0;
  for (const n of counts.values()) if (n > worst) worst = n;
  return { worst, added };
}

/** Is a local point inside a dressing lobe's footprint? Plan-local, XZ only. */
function inLobe(dr, lx, lz) {
  const dx = lx - dr.lx;
  const dz = lz - dr.lz;
  const bx = dx * Math.cos(dr.rot) - dz * Math.sin(dr.rot);
  const bz = dx * Math.sin(dr.rot) + dz * Math.cos(dr.rot);
  return Math.abs(bx) <= dr.w * 0.5 && Math.abs(bz) <= dr.d * 0.5;
}

const DT = 1 / 60;
/** Drop at which fall damage first appears. `citadel-reach-kit.mjs`. */
const FALL_DAMAGE_M = 7.5;

/** floor / achieved / ceiling, printed so a regression is readable, not just red. */
function floorCheck(label, floor, achieved, ceiling, note = '') {
  const ok = achieved >= floor;
  console.info(
    `  ${ok ? 'PASS' : 'FAIL'} ${label.padEnd(46)}`
    + ` floor ${String(floor).padStart(8)} | achieved ${String(achieved).padStart(8)}`
    + ` | ceiling ${String(ceiling).padStart(8)}${note ? `  ${note}` : ''}`
  );
  assert.ok(ok, `${label}: ${achieved} is under the floor of ${floor}`);
}

/* ================================================================== */
/* The world, and the two oases in it. Built once.                     */
/* ================================================================== */

let _built = null;
function built() {
  if (_built) return _built;
  _built = (async () => {
    const { CitadelWorld } = await import('../../src/worlds/CitadelWorld.js');
    const physics = new Physics();
    const renderer = {
      capabilities: { getMaxAnisotropy: () => 4, isWebGL2: true },
      initTexture() {}, getContext: () => ({}),
      getRenderTarget: () => null, setRenderTarget() {}, render() {}, clear() {},
    };
    const scene = new THREE.Scene();
    const world = new CitadelWorld({
      physics, scene,
      bus: { on: () => () => {}, emit() {} },
      engine: { renderer, onFrameUpdate: () => () => {}, onResize: () => () => {} },
      materials: { get: () => new THREE.MeshStandardMaterial(), dispose() {} },
    });
    world.physics = physics;
    const t0 = performance.now();
    await world.build(() => {});
    const worldMs = performance.now() - t0;
    world.group.updateMatrixWorld(true);

    /* ── THIS SUITE NOW AUDITS THE OASES THE WORLD SHIPS ─────────────────
     *
     * It used to build its own pair on top of a finished world, and it cannot
     * any more: `CitadelWorld._buildTraffic` builds them itself, and the
     * kit's own siting is doing its job when it refuses the ground they stand
     * on - `findOasisSite` reported "no viable oasis site near palm-well" for
     * exactly the right reason, which is that there is already an oasis there.
     *
     * That is a better arrangement than the one it replaces and it is the
     * arrangement this file's header always described: what is measured below
     * - the swim in and out, the shoreline, the promenade, the draw calls, the
     * grounding - is measured on the tanks the player will actually walk into,
     * not on a second pair built beside them. Everything that cannot be
     * recovered from the scene graph is published by the world on
     * `traffic.oasis`, and the two things a stand-in used to provide are:
     *
     *   `preField`  the collider set BEFORE the oases, reconstructed by
     *               subtracting the colliders the world says they registered.
     *               A `SolidField` that could see the tank would let the
     *               vacancy audit pass by finding the oasis's own masonry.
     *   `hostBuckets`  what `Batch.box` received, recorded in the world's own
     *               `ctx.box` shim with the same bevel rule the batch applies.
     *               If the kit ever stops emitting through `ctx.box` the bucket
     *               count collapses to zero and the cost case fails, exactly as
     *               it did with the stand-in.
     */
    const T = world.traffic?.oasis;
    assert.ok(T, 'the world published no oasis audit surface - see CitadelWorld._buildTraffic');
    assert.equal(world.traffic.refusedOases.length, 0,
      `the world refused an oasis: ${world.traffic.refusedOases.map((r) => `${r.id} (${r.reason})`).join('; ')}`);
    const { sites, hostBuckets, baseColliders, searchMs, buildMs } = T;
    const kit = { oases: T.parts };
    const group = world.group;

    const ownColliders = new Set(T.colliders);
    const preField = new SolidField(physics.colliders.filter((c) => !ownColliders.has(c)));
    // The FINAL collider set, after everything.
    const field = new SolidField(physics.colliders);

    /* The REAL discovery path: `WaterVolumes` scanning the real meshes for
     * material names it recognises. Nothing here tells it where the water is. */
    const water = new WaterVolumes({});
    water.rebuildFromWorld({ id: 'citadel', group: world.group, rules: {} }, true);

    return {
      world, physics, scene, group, kit, sites, field, preField, water,
      worldMs, searchMs, buildMs, baseColliders, hostBuckets,
    };
  })();
  return _built;
}

/* ================================================================== */
/* 1. The premise: there is nowhere to sink a pool                     */
/* ================================================================== */

test('the flats have no natural hollow to sink a pool into', () => {
  /* The measurement the whole design rests on. If the desert had bowls the
   * right answer would be to use one, and every terrace below would be
   * unjustified scenery. So it is re-derived here rather than quoted.
   *
   * A "bowl" is the rim of a 12 m ring standing above the ground inside it. */
  const { citadelHeight, CITADEL_LANDFORMS } = Height;
  const inLandform = (x, z) => CITADEL_LANDFORMS.some((l) =>
    x >= l.aabb.x0 - 20 && x <= l.aabb.x1 + 20 && z >= l.aabb.z0 - 20 && z <= l.aabb.z1 + 20);

  let best = -Infinity;
  let bestAt = null;
  let samples = 0;
  let sum = 0;
  for (let x = -430; x <= 430; x += 5) {
    for (let z = -430; z <= 430; z += 5) {
      const r = Math.hypot(x, z);
      if (r < 200 || r > 430 || inLandform(x, z)) continue;
      let rimMin = Infinity;
      let lo = citadelHeight(x, z);
      for (let a = 0; a < 16; a++) {
        const t = (a / 16) * Math.PI * 2;
        rimMin = Math.min(rimMin, citadelHeight(x + Math.cos(t) * 12, z + Math.sin(t) * 12));
        lo = Math.min(lo, citadelHeight(x + Math.cos(t) * 5, z + Math.sin(t) * 5));
      }
      const bowl = rimMin - lo;
      samples++;
      sum += bowl;
      if (bowl > best) { best = bowl; bestAt = { x, z }; }
    }
  }
  console.info(`  flats: ${samples} centres, deepest bowl ${best.toFixed(3)} m at`
    + ` (${bestAt.x}, ${bestAt.z}), mean ${(sum / samples).toFixed(3)} m`);
  floorCheck('candidate centres scanned', 4000, samples, samples);
  /* The claim, and it is an upper bound rather than a floor: nothing out there
   * is deep enough to hold a swim. `POOL_DEPTH` is 2.45 m and `SWIM_ENTER_DEPTH`
   * is 1.3; the desert offers 0.19. */
  assert.ok(best < SWIM_ENTER_DEPTH * 0.25,
    `the flats have a ${best.toFixed(2)} m bowl - re-examine whether the tank is still needed`);
  assert.ok(sum / samples < 0,
    'the mean "bowl" is positive - the flats are dished, not domed, and the design should change');
});

/* ================================================================== */
/* 2. The plan, on its own                                             */
/* ================================================================== */

test('every riser is justified against the controller that has to climb it', () => {
  const plan = oasisPlan({ id: 'unit', x: 0, z: 0, bedY: 0 });
  const a = auditShoreline(plan);
  console.info(`  swim band ${a.swimBand.from.toFixed(2)} -> ${a.swimBand.to.toFixed(2)} m deep,`
    + ` ${a.swimBand.risers} risers, worst ${a.worstSwimRiser.toFixed(2)} m,`
    + ` weakest eviction ${(a.liftFraction * 100).toFixed(0)}% upward`);
  assert.deepEqual(a.notes, []);

  /* The swim band exists at all. A profile that jumped straight from "still
   * swimming" to dry land would have no band and this would read zero, which
   * is the shape of the bug rather than the absence of one. */
  floorCheck('risers inside the swim band', 3, a.swimBand.risers, a.swimBand.risers);
  /* Every one of them is climbable by eviction alone. Ceiling by construction:
   * a riser of CAPSULE_R (0.35) evicts exactly sideways and is a wall. */
  floorCheck('weakest upward eviction, %', 40,
    Math.round(a.liftFraction * 100), 100, `riser ${a.worstSwimRiser} m of ${CAPSULE_R} m`);
  // And the dry side stays inside the walking controller's step.
  assert.ok(a.worstDryRiser < STEP_MAX,
    `dry riser ${a.worstDryRiser} at ${a.worstDryAt} is not under the ${STEP_MAX} m step-up`);

  /* NOT A CLIFF. The tallest drop off any dry surface in the whole tank,
   * against the height at which falling starts to hurt. */
  console.info(`  tallest dry drop ${a.worstDryDrop.toFixed(2)} m vs ${FALL_DAMAGE_M} m to bruise`);
  assert.ok(a.worstDryDrop < STEP_MAX,
    `a ${a.worstDryDrop} m drop is a fall, not a step`);

  /* The pool is deep enough to be a pool: a swim needs 1.3 m and a sunken
   * cache needs 1.6 m of it. */
  assert.ok(POOL_DEPTH > SWIM_ENTER_DEPTH + 0.5, 'the deep floor is not comfortably swimmable');
  assert.ok(POOL_DEPTH > MIN_DIVE, 'nothing in this pool is deep enough for a sunken cache');
});

test('the riser audit can see a wall (ablation)', () => {
  /* THE ABLATION. A profile audit that cannot detect the exact defect it was
   * written for is decoration. Replace the beach with a single 0.40 m step -
   * the shape the first draft of this kit had - and the audit must refuse it. */
  const plan = oasisPlan({ id: 'unit', x: 0, z: 0, bedY: 0 });
  const broken = {
    ...plan,
    rings: plan.rings.map((r) => (
      r.id === 'b1' ? { ...r, rise: 0.40, top: r.top + 0.25, depth: r.depth - 0.25 } : r
    )),
  };
  const a = auditShoreline(broken);
  assert.ok(!a.ok, 'a 0.40 m riser inside the swim band passed the shoreline audit');
  assert.ok(a.liftFraction < 0, 'the eviction direction did not turn downward');
  console.info(`  ablation: ${a.notes.join(' / ')}`);
});

/* ================================================================== */
/* 3. Placement against the real terrain                               */
/* ================================================================== */

test('both oases are level, empty, on the sheet and out in the flats', async () => {
  const b = await built();
  console.info(`  build ${b.worldMs.toFixed(0)} ms world, ${b.searchMs.toFixed(0)} ms search,`
    + ` ${b.buildMs.toFixed(0)} ms oases`);
  for (const s of b.sites) {
    const p = s.plan;
    const r = Math.hypot(p.x, p.z);
    console.info(`  ${p.id.padEnd(12)} (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) r=${r.toFixed(0)}`
      + ` yaw ${p.yaw.toFixed(2)} relief ${s.profile.relief.toFixed(3)} m`
      + ` grade ${s.grade.toFixed(2)} water ${p.waterY.toFixed(2)}`
      + ` (+${s.lift.toFixed(2)} over grade) ${s.distance.toFixed(0)} m from its anchor`);
    assert.equal(s.profile.covered, 1, `${p.id} is not fully on the terrain sheet`);
    assert.ok(s.profile.relief <= MAX_RELIEF,
      `${p.id} relief ${s.profile.relief} exceeds ${MAX_RELIEF}`);
    /* IN THE FLATS. The player's words were "the large open areas between
     * objects/villages/caves", so the claim is not "far from the origin" - it
     * is "not inside anything that already exists". Measured against every
     * authored landform's own AABB. */
    let nearest = Infinity;
    let nearestId = null;
    for (const l of Height.CITADEL_LANDFORMS) {
      const dx = Math.max(l.aabb.x0 - p.x, 0, p.x - l.aabb.x1);
      const dz = Math.max(l.aabb.z0 - p.z, 0, p.z - l.aabb.z1);
      const d = Math.hypot(dx, dz);
      if (d < nearest) { nearest = d; nearestId = l.id; }
    }
    assert.ok(r > Height.INNER_KEEP, `${p.id} is inside the inner keep at r=${r.toFixed(0)}`);
    assert.ok(r < Height.HALF - 40, `${p.id} is on the world edge at r=${r.toFixed(0)}`);
    /* 15 m clear of a landform's AABB, and the bar is 15 rather than 50
     * because an AABB is a generous bounding box round a shape, not the shape:
     * `karst-massif`'s spans its whole `reach`, most of which is open sand.
     * The claim being made is "not built inside a region", and the vacancy
     * audit above is what actually enforces it - this is the weaker, cheaper
     * statement that the oasis reads as its own place. */
    floorCheck(`${p.id} metres clear of the nearest landform AABB`, 15,
      Math.round(nearest), Math.round(nearest), `(${nearestId})`);

    /* THE TWO LATTICES AGREE. `PROFILE_STEP` exists because a coarse probe
     * stepped over a ridge and approved a site that measured 0.39 m of relief
     * when it was re-measured; the constant is shared so that cannot recur,
     * and this is the assertion that would notice if somebody unshared it.
     *
     * Checked on the SITE and on twelve neighbours 40 m out, and the
     * neighbours are the half that bites. The site itself sits on a flat pan
     * by construction, so on its own it agrees with any pitch you like -
     * mutation-testing `PROFILE_STEP` to 12 m left the suite green until the
     * ring was added. Agreement is a property of the lattice, and it has to be
     * measured where the ground is doing something. */
    const fine = oasisProfile(p, b.field, 0.4);
    let drift = Math.abs(fine.relief - s.profile.relief);
    let driftAt = 'the site';
    for (let k = 0; k < 12; k++) {
      const th = (k / 12) * Math.PI * 2;
      const probe = oasisPlan({
        id: 'probe', x: p.x + Math.cos(th) * 40, z: p.z + Math.sin(th) * 40, bedY: 0,
      });
      const coarse = oasisProfile(probe, b.field, Oasis.PROFILE_STEP);
      const sharp = oasisProfile(probe, b.field, 0.4);
      if (!coarse.covered || !sharp.covered) continue;
      const d = Math.abs(sharp.relief - coarse.relief);
      if (d > drift) { drift = d; driftAt = `${((th * 180) / Math.PI) | 0} deg, 40 m out`; }
    }
    console.info(`  ${p.id.padEnd(12)} relief at ${Oasis.PROFILE_STEP} m`
      + ` ${s.profile.relief.toFixed(3)} vs at 0.4 m ${fine.relief.toFixed(3)};`
      + ` worst lattice drift over the site and 12 neighbours`
      + ` ${drift.toFixed(3)} m (${driftAt})`);
    /* The bound is not a round number, it is the SLACK: `MAX_RELIEF` is an
     * acceptance test run at `PROFILE_STEP`, and what stands behind it is the
     * feather's physical reach. Whatever the lattice under-reports has to fit
     * in the gap between the two, or a site this suite calls level is a site
     * whose bank does not come down to the sand. Measured on the built world
     * the worst drift is 0.238 m against 0.400 m of slack. */
    const slack = Oasis.FEATHER_COURSES * Oasis.FEATHER_RISE - MAX_RELIEF;
    assert.ok(drift < slack,
      `${p.id}: the ${Oasis.PROFILE_STEP} m placement lattice and a 0.4 m probe`
      + ` disagree by ${drift.toFixed(3)} m at ${driftAt}, which is more than the`
      + ` ${slack.toFixed(2)} m of slack under MAX_RELIEF`);
    assert.ok(fine.relief <= MAX_RELIEF + slack,
      `${p.id}: re-measured at 0.4 m the relief is ${fine.relief.toFixed(3)},`
      + ` over ${MAX_RELIEF} + ${slack.toFixed(2)} of slack`);
    // Nothing else was standing here. Measured on the PRE-oasis collider set.
    const vac = auditVacancy(p, b.preField);
    assert.equal(vac.occupied, 0,
      `${p.id} was built on top of ${vac.occupied} occupied samples, first at`
      + ` ${vac.worstAt && `${vac.worstAt.x.toFixed(0)}, ${vac.worstAt.z.toFixed(0)}`}`);
  }
  // Two oases, not one with a wall down the middle.
  const [a, c] = b.sites;
  const apart = Math.hypot(a.plan.x - c.plan.x, a.plan.z - c.plan.z);
  floorCheck('metres between the two oases', 140, Math.round(apart), Math.round(apart));
});

test('the tank stands on the ground: nothing pierced, nothing floating', async () => {
  const b = await built();
  for (const o of b.kit.oases) {
    const g = auditGrounded(o.plan, b.field, 1.0);
    console.info(`  ${o.plan.id.padEnd(12)} ${g.samples} samples,`
      + ` pierced ${g.pierced} (worst ${g.worstPierce.toFixed(3)} m),`
      + ` floating ${g.floating} (worst ${g.worstFloat.toFixed(3)} m)`);
    floorCheck(`${o.plan.id} grounding samples`, 1000, g.samples, g.samples);
    assert.equal(g.pierced, 0, `${o.plan.id}: terrain rises through a shelf`);
    assert.equal(g.floating, 0, `${o.plan.id}: a course hangs over the ground`);
  }
});

test('the grounding audit can see a buried tank (ablation)', async () => {
  const b = await built();
  const p = b.kit.oases[0].plan;
  /* Sink the whole plan into the sand. 2.5 m, and not the 1 m this started at:
   * the apron carries eleven courses precisely so the bank can bury itself
   * where the ground is high, so at 1 m the entire drop was absorbed by that
   * and the audit was right to stay quiet. The failure being probed is a
   * BASIN under the desert - the one `Caves.liftToClear` exists to prevent -
   * and the ablation has to reach it. */
  const drop = 2.5;
  const sunk = {
    ...p,
    baseY: p.baseY - drop,
    rings: p.rings.map((r) => ({ ...r, top: r.top - drop })),
  };
  const g = auditGrounded(sunk, b.field, 2.0);
  console.info(`  ablation: sunk ${drop} m -> ${g.pierced}/${g.samples} samples pierced,`
    + ` worst ${g.worstPierce.toFixed(2)} m of terrain over a shelf`
    + ` (${g.buried} apron samples buried, which is allowed)`);
  assert.ok(g.pierced > 0, `a tank sunk ${drop} m into the desert read as grounded`);
  assert.ok(!g.ok, 'the audit reported ok on a buried tank');
});

/* ================================================================== */
/* 4. The water is discovered by the real scanner                      */
/* ================================================================== */

test('WaterVolumes finds both pools without being told where they are', async () => {
  const b = await built();
  const report = b.water.describe();
  console.info(`  ${report.surfaces.length} surfaces, ${report.volumes} volumes:`
    + ` ${report.surfaces.map((s) => `${s.name}@${s.surfaceY.toFixed(2)} ${Math.round(s.area)}m2`).join(' | ')}`);
  floorCheck('water surfaces discovered', 2, report.surfaces.length, report.surfaces.length);
  floorCheck('swimmable volumes', 8, report.volumes, report.volumes);

  /* BOTH channels, independently.
   *
   * `WaterVolumes.isWaterSurface` accepts a mesh whose MATERIAL name reads as
   * water OR whose OBJECT name does, and the oasis satisfies both - the mesh
   * is `oasis:<id>:water` and the material is the library's `water.pool`.
   * Mutation-testing found that redundancy hiding a real defect: swapping the
   * material for `stone.cobble` left the suite green, because the mesh name
   * alone carried the discovery. Either one is enough for the game and neither
   * one on its own is enough for this suite, so both are pinned. */
  const WATERISH = /water|pool|lake|pond|moat|river|lagoon/i;
  const NOT_WATER = /tile|coping|deck|kerb|curb|glow|light|caustic|decal|splash|ripple|sign|rope|ladder|foam|spray|puddle/i;
  for (const o of b.kit.oases) {
    const mesh = o.water.mesh;
    const mname = mesh.material?.name ?? '';
    console.info(`  ${o.plan.id.padEnd(12)} mesh "${mesh.name}" material "${mname}"`);
    assert.ok(WATERISH.test(mname) && !NOT_WATER.test(mname),
      `the water material is named "${mname}" - WaterVolumes would not recognise it`);
    assert.ok(WATERISH.test(mesh.name) && !NOT_WATER.test(mesh.name),
      `the water mesh is named "${mesh.name}" - WaterVolumes would not recognise it`);
    assert.equal(mesh.castShadow, false, 'the water plane casts a shadow');
  }

  for (const o of b.kit.oases) {
    const p = o.plan;
    // Dead centre, at the surface.
    const y = b.water.surfaceYAt(p.x, p.z);
    assert.ok(y !== null, `${p.id}: no water over its own centre`);
    assert.ok(Math.abs(y - p.waterY) < 0.05,
      `${p.id}: surface reported ${y}, plan says ${p.waterY}`);
    /* ...and the crest is DRY. Not "no volume overlaps it" - `WaterVolumes`
     * decomposes on an 8 m axis-aligned lattice and the pool is rotated, so
     * its cell boxes necessarily overshoot a rotated rectangle's corners.
     * The property that matters to a player is the one `Swim.fixedUpdate`
     * actually tests: standing on the crest, is the ground above the water
     * plane? Sampled all the way round the promenade. */
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const ex = Math.cos(a);
      const ez = Math.sin(a);
      const crest = p.rings.find((r) => r.id === 'crest');
      const k = 1 / Math.max(Math.abs(ex) / (crest.ihx + 0.6), Math.abs(ez) / (crest.ihz + 0.6));
      const lx = ex * k;
      const lz = ez * k;
      const wx = p.x + lx * Math.cos(p.yaw) + lz * Math.sin(p.yaw);
      const wz = p.z - lx * Math.sin(p.yaw) + lz * Math.cos(p.yaw);
      const surf = b.water.surfaceYAt(wx, wz);
      if (surf === null) continue;
      const ground = b.physics.groundHeight(wx, wz, p.crestY + 0.3, 6);
      assert.ok(ground !== null && ground > surf + 0.02,
        `${p.id}: the crest at bearing ${(a * 57.3) | 0} deg is under water`
        + ` (ground ${ground}, surface ${surf})`);
    }
    // The bed under the centre is the floor slab, and it is deep.
    const bed = b.physics.groundHeight(p.x, p.z, p.waterY + 0.5, 20);
    assert.ok(bed !== null, `${p.id}: no bed under the water`);
    const depth = p.waterY - bed;
    console.info(`  ${p.id.padEnd(12)} centre depth ${depth.toFixed(2)} m`
      + ` (swim needs ${SWIM_ENTER_DEPTH}, a sunken cache needs ${MIN_DIVE})`);
    floorCheck(`${p.id} centre depth x100`, Math.round(SWIM_ENTER_DEPTH * 100) + 50,
      Math.round(depth * 100), Math.round(POOL_DEPTH * 100));
  }
});

/* ================================================================== */
/* 4b. THE FORM: it has to read as an oasis, not as a tank             */
/* ================================================================== */

/**
 * The four cases below exist because the tank passed every case above it in
 * this file and still looked wrong: a rectangle of flat blue on a stepped grey
 * ziggurat in the middle of a desert. Everything a screenshot shows and no
 * assertion here caught is a hole in this suite, so each one is pinned to a
 * number that a photograph would have argued about.
 */

test('the bank is sand, and the boolean that made it a pool lining is gone', () => {
  /* THE DEFECT, restated as a test.
   *
   * Every ring used to be keyed on `r.depth > 0`. On an apron course `depth`
   * is a fiction - the depth the water WOULD have if the tank had no walls -
   * so the first apron course, which is dry ground on the desert side of a
   * wall, tested true and came out in cobblestone in the pool-lining tints.
   * All fifteen of them did. That is the grey ziggurat.
   *
   * The pin: `a1` and `c2` have the SAME `depth` by construction, 0.15 m, and
   * one of them is a bank and the other is a strand under water. If they ever
   * agree about their surface again, the bug is back.
   */
  const plan = oasisPlan({ id: 'unit', x: 0, z: 0, bedY: 0 });
  const a1 = plan.rings.find((r) => r.id === 'a1');
  const c2 = plan.rings.find((r) => r.id === 'c2');
  assert.ok(Math.abs(a1.depth - c2.depth) < 1e-9,
    `a1 and c2 no longer share a depth (${a1.depth} vs ${c2.depth}) - re-derive this case`);
  const sa = ringSurface(a1);
  const sc = ringSurface(c2);
  console.info(`  a1 (bank, depth ${a1.depth.toFixed(2)}) -> ${sa.key} #${sa.tint.toString(16)}`
    + ` | c2 (strand, depth ${c2.depth.toFixed(2)}) -> ${sc.key} #${sc.tint.toString(16)}`);
  assert.notEqual(sa.tint, sc.tint,
    'the bank and the strand are painted the same, on the same fictional depth');

  /* And no part of the tank is stone any more except the two things somebody
   * built. `stone.cobble` on a terrace course is the failure being ruled out. */
  for (const r of plan.rings) {
    const surf = ringSurface(r);
    assert.equal(surf.key, 'dirt.ground',
      `ring ${r.id} is keyed to "${surf.key}" - a terrace course is ground, not masonry`);
  }

  /* The bank washes OUT into the desert as it descends: the outermost course
   * has to be closer to the sand beside it than the innermost is. `DESERT` is
   * derived in the kit from the terrain's own colour over the same material. */
  const inner = ringSurface(plan.rings.find((r) => r.id === 'a1')).tint;
  const outer = ringSurface(plan.rings.find((r) => r.id === 'a7')).tint;
  const lum = (h) => ((h >> 16) & 255) + ((h >> 8) & 255) + (h & 255);
  console.info(`  bank ramp: a1 #${inner.toString(16)} (${lum(inner)}) ->`
    + ` a7 #${outer.toString(16)} (${lum(outer)})`);
  assert.ok(lum(outer) > lum(inner),
    'the bank does not lighten toward the desert - it will read as a plinth');
});

test('the pool is not a rectangle', async () => {
  /* Measured on the BUILT geometry, not on the plan: the outer ring of the
   * water mesh, in the tank's own frame, against the rectangle it used to be.
   *
   * The number is the perpendicular offset from that rectangle's nearest face,
   * and the claim is its RANGE - a pool inset by a constant is still a
   * rectangle, just a smaller one.
   */
  const b = await built();
  for (const o of b.kit.oases) {
    const p = o.plan;
    const g = o.water.mesh.geometry;
    const pos = g.attributes.position;
    let lo = Infinity;
    let hi = -Infinity;
    // The outer ring is the last `WATER_SEGMENTS` vertices.
    for (let i = pos.count - WATER_SEGMENTS; i < pos.count; i++) {
      const lx = Math.abs(pos.getX(i));
      const lz = Math.abs(pos.getZ(i));
      // Perpendicular gap to whichever face this vertex belongs to.
      const gap = Math.min(p.water.hx - lx, p.water.hz - lz);
      if (gap < lo) lo = gap;
      if (gap > hi) hi = gap;
    }
    const wander = hi - lo;
    console.info(`  ${p.id.padEnd(12)} waterline stands ${lo.toFixed(2)}..${hi.toFixed(2)} m`
      + ` inside the ${(p.water.hx * 2).toFixed(1)} x ${(p.water.hz * 2).toFixed(1)} m rectangle`
      + ` - it wanders ${wander.toFixed(2)} m`);
    /* FLOOR 1.00 m, and the ablation below is why it is not lower: a pool
     * inset by a CONSTANT still measures 0.27 m on this probe, because the
     * rectangle fit runs a bearing into a corner rather than into a face. So a
     * metre is roughly four times the noise floor, and it is a metre of
     * shoreline the player watches move as they walk round. The ceiling is
     * `SHORE_INSET`: the most the sand behind it can follow without breaking
     * the ghost bound. */
    floorCheck(`${p.id} waterline wander, cm`, 100, Math.round(wander * 100),
      Math.round(SHORE_INSET * 100));
    assert.ok(hi <= SHORE_INSET + 0.01,
      `the waterline pulls back ${hi.toFixed(2)} m, past the ${SHORE_INSET} m the sand can fill`);
  }

  /* ABLATION. The same measurement against a plan whose shore function is
   * flat - i.e. a rectangle, pulled in by a constant, which is what this
   * replaced. It must come out at the probe's own noise floor and nowhere
   * near the shipped pools. */
  const flat = oasisPlan({ id: 'flat', x: 0, z: 0, bedY: 0 });
  flat.shore = new Float64Array(15);   // every amplitude zero
  let flo = Infinity;
  let fhi = -Infinity;
  for (let i = 0; i < 360; i++) {
    const t = (i / 360) * Math.PI * 2;
    const r = shoreRadius(flat, t);
    const gap = Math.min(flat.water.hx - Math.abs(Math.cos(t) * r),
      flat.water.hz - Math.abs(Math.sin(t) * r));
    flo = Math.min(flo, gap);
    fhi = Math.max(fhi, gap);
  }
  console.info(`  ablation: a constant inset "wanders" ${(fhi - flo).toFixed(3)} m`
    + ' - the rectangle-fit artefact at the corners, and the probe\'s noise floor');
  assert.ok(fhi - flo < 0.4,
    `a constant inset reads ${(fhi - flo).toFixed(2)} m of wander - the probe cannot`
    + ' tell an irregular pool from a smaller rectangle');
});

test('the water is depth-tinted and fades out at the shore', async () => {
  const b = await built();
  for (const o of b.kit.oases) {
    const g = o.water.mesh.geometry;
    const col = g.attributes.color;
    /* FOUR components. Three renders opaque: three.js only compiles vertex
     * alpha when `color.itemSize === 4`, which is a silent failure and the
     * exact trap this shoreline fade would fall into. */
    assert.equal(col.itemSize, 4,
      'the water carries RGB and not RGBA - the shoreline fade is not compiled');
    const mat = o.water.mesh.material;
    assert.equal(mat.vertexColors, true, 'the water material ignores its own vertex colours');
    assert.equal(mat.transparent, true, 'the water material is opaque - nothing fades');

    let aLo = 1;
    let aHi = 0;
    let shallow = null;
    let deep = null;
    const pos = g.attributes.position;
    for (let i = 0; i < col.count; i++) {
      const a = col.getW(i);
      if (a < aLo) aLo = a;
      if (a > aHi) aHi = a;
      const d = depthAt(o.plan, pos.getX(i), pos.getZ(i));
      if (!shallow || d < shallow.d) shallow = { d, r: col.getX(i), g: col.getY(i), b: col.getZ(i) };
      if (!deep || d > deep.d) deep = { d, r: col.getX(i), g: col.getY(i), b: col.getZ(i) };
    }
    const lum = (c) => c.r + c.g + c.b;
    console.info(`  ${o.plan.id.padEnd(12)} alpha ${aLo.toFixed(2)}..${aHi.toFixed(2)},`
      + ` shallow ${shallow.d.toFixed(2)} m luma ${lum(shallow).toFixed(2)}`
      + ` -> deep ${deep.d.toFixed(2)} m luma ${lum(deep).toFixed(2)}`);
    /* See-through at the strand. The whole point of the fade is that the sand
     * under the edge shows through it, so the rim has to be well under half. */
    assert.ok(aLo <= 0.35, `the shallowest water is ${aLo.toFixed(2)} opaque - the shore is a hard line`);
    assert.ok(aHi >= 0.85, `the deepest water is only ${aHi.toFixed(2)} opaque - the pool has no body`);
    // And it is DEPTH that drives it, not noise: the deep end is darker.
    assert.ok(lum(deep) < lum(shallow) * 0.7,
      'the deep water is not appreciably darker than the shallows');
  }

  /* ABLATION. The ramp itself, at the two ends of the range it is written for.
   * A `waterShade` that returned one colour would satisfy every "is there a
   * colour attribute" check above and none of these. */
  const a = waterShade(0.15, [0, 0, 0, 0]).slice();
  const c = waterShade(POOL_DEPTH, [0, 0, 0, 0]).slice();
  console.info(`  ablation: shade at 0.15 m [${a.map((v) => v.toFixed(2)).join(', ')}]`
    + ` vs at ${POOL_DEPTH} m [${c.map((v) => v.toFixed(2)).join(', ')}]`);
  assert.ok(c[3] - a[3] > 0.4, 'the depth ramp barely moves the opacity');
  assert.ok(a[1] > c[1] + 0.2, 'the shallows are not lighter in green than the deep floor');
});

test('the ripple has something to sample: the water carries a uv, and the maps that read it', async () => {
  /* THE REGRESSION THE REWRITE INTRODUCED AND THIS FILE COULD NOT SEE.
   *
   * The old water was a `PlaneGeometry`, which carries a `uv` for nothing. The
   * fan that replaced it wrote `position`, `color` and the index and stopped -
   * and a bound texture with no `uv` does not fail, it samples the constant
   * generic attribute (0, 0). One texel, for all 568 m2 of pool, moving as one
   * sheet under `MaterialLibrary._animate`. That is the exact artefact the
   * recipe's SECOND counter-scrolling normal layer exists to prevent, so the
   * whole stated reason for reusing `water.pool` was gone and every case in
   * this file stayed green.
   *
   * Two halves, and the defect needs both to be visible:
   *
   *   1. the shipped geometry has a `uv` that spans more than one tile. An
   *      attribute of the right shape full of zeros is the same single texel;
   *   2. the material still HAS maps that read it - asserted against the REAL
   *      `MaterialLibrary`, because `built()` stubs the library with a bare
   *      `MeshStandardMaterial` and a stub with no maps cannot lose any.
   */
  const b = await built();
  let worst = Infinity;
  for (const o of b.kit.oases) {
    const g = o.water.mesh.geometry;
    const uv = g.attributes.uv;
    assert.ok(uv, `${o.plan.id}: the water plane has no uv - the ripple normal map has one texel`);
    assert.equal(uv.itemSize, 2, 'the water uv is not a 2-component attribute');
    assert.equal(uv.count, g.attributes.position.count, 'the water uv does not cover every vertex');
    let uLo = Infinity; let uHi = -Infinity; let vLo = Infinity; let vHi = -Infinity;
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i); const v = uv.getY(i);
      if (u < uLo) uLo = u; if (u > uHi) uHi = u;
      if (v < vLo) vLo = v; if (v > vHi) vHi = v;
    }
    const tiles = Math.min(uHi - uLo, vHi - vLo);
    console.info(`  ${o.plan.id.padEnd(12)} uv spans ${(uHi - uLo).toFixed(2)} x ${(vHi - vLo).toFixed(2)} tiles`);
    worst = Math.min(worst, tiles);
  }
  /* Floor 4 tiles. The pools are 24.4 x 21.4 m across the rectangle and the
   * recipe is authored for 4 m a tile, so the honest value is ~5; a uv that is
   * present, correctly shaped and all one value scores 0. */
  floorCheck('the water uv spans, in tiles', 4, worst.toFixed(2), 5.35,
    '(ceiling = the pool rectangle / tileMeters)');

  /* And the maps are still bound. `map` is the one that had to go - it is the
   * library's chlorinated blue mottle - and the three that read `uv` for the
   * ripple are the reason the geometry has to carry one at all. */
  const { MaterialLibrary } = await import('../../src/gfx/Materials.js');
  const renderer = {
    capabilities: { getMaxAnisotropy: () => 4, isWebGL2: true },
    initTexture() {}, getContext: () => ({}),
    getRenderTarget: () => null, setRenderTarget() {}, render() {}, clear() {},
  };
  const lib = new MaterialLibrary(renderer);
  const base = lib.get('water.pool');
  assert.equal(base.userData.tileMeters, Oasis.WATER_TILE_METRES,
    `the library authors water.pool for ${base.userData.tileMeters} m a tile and the water `
    + `geometry divides by ${Oasis.WATER_TILE_METRES} - the ripple is at the wrong scale`);
  const m = Oasis.oasisWaterMaterial({ mat: (k) => lib.get(k).clone() });
  assert.equal(m.map, null, 'the library\'s chlorinated blue mottle is still on the pool');
  assert.ok(m.normalMap, 'the ripple normal map is gone - nothing on this surface moves');
  assert.ok(m.clearcoatNormalMap,
    'the second, counter-scrolling normal layer is gone - the ripple is one sliding sheet');
  assert.ok(m.roughnessMap, 'the water lost its roughness map');
  // The scroll is on the TEXTURE, which the clone shares, so it reaches this
  // material. That sharing is the entire argument for reusing the recipe.
  assert.equal(m.normalMap, base.normalMap, 'the clone re-baked the normal map - the scroll cannot reach it');
  assert.ok(lib._animated.length > 0, 'nothing in the library animates - water.pool lost its scroll');
  const before = base.normalMap.offset.x;
  lib.update(1.0);
  assert.notEqual(base.normalMap.offset.x, before, 'the ripple offset does not move under update()');
  lib.dispose();
});

test('every metre of exposed strand is sand, not a dry gutter under the plane', async () => {
  /* THE FAILURE THE SHORE FUNCTION COULD HAVE INTRODUCED.
   *
   * The waterline pulls back by up to `SHORE_INSET`; what it leaves behind is
   * shelf standing BELOW the plane, which reads as water held up by nothing -
   * strictly worse than the rectangle. The sand bars are generated from the
   * same function so that cannot happen, and this is the proof: walk the
   * annulus between the waterline and the crest and ask whether a dressing
   * lobe standing at or above strand level covers every point of it.
   */
  const b = await built();
  for (const o of b.kit.oases) {
    const p = o.plan;
    const crest = p.rings.find((r) => r.id === 'crest');
    const strand = p.rings.find((r) => r.id === 'c2');
    let checked = 0;
    let bare = 0;
    let worstAt = null;
    for (let i = 0; i < 720; i++) {
      const t = (i / 720) * Math.PI * 2;
      const ex = Math.cos(t);
      const ez = Math.sin(t);
      const rOut = 1 / Math.max(Math.abs(ex) / crest.ihx, Math.abs(ez) / crest.ihz);
      const rIn = shoreRadius(p, t);
      if (rOut - rIn < 0.12) continue;
      for (let k = 0.1; k < rOut - rIn; k += 0.15) {
        const lx = ex * (rIn + k);
        const lz = ez * (rIn + k);
        checked++;
        let covered = false;
        for (const dr of o.dressing) {
          if (dr.top < strand.top - 0.02) continue;
          if (inLobe(dr, lx, lz)) { covered = true; break; }
        }
        if (!covered) {
          bare++;
          if (!worstAt) worstAt = `(${lx.toFixed(1)}, ${lz.toFixed(1)})`;
        }
      }
    }
    console.info(`  ${p.id.padEnd(12)} ${checked} probes across the exposed strand,`
      + ` ${bare} bare${worstAt ? ` (first at ${worstAt})` : ''}`);
    floorCheck(`${p.id} strand probes taken`, 1500, checked, checked);
    assert.equal(bare, 0,
      `${p.id}: ${bare} of ${checked} points of exposed strand are not filled -`
      + ` the water plane ends over dry ground at ${worstAt}`);
  }

  /* ABLATION. The same sweep with the sand bars taken away. It has to find the
   * gutter, or it is a sweep over ground that was never at risk. */
  const o = b.kit.oases[0];
  const p = o.plan;
  const strand = p.rings.find((r) => r.id === 'c2');
  const crest = p.rings.find((r) => r.id === 'crest');
  const withoutBars = o.dressing.filter((dr) => dr.top < strand.top - 0.02);
  let bare = 0;
  let checked = 0;
  for (let i = 0; i < 720; i++) {
    const t = (i / 720) * Math.PI * 2;
    const ex = Math.cos(t);
    const ez = Math.sin(t);
    const rOut = 1 / Math.max(Math.abs(ex) / crest.ihx, Math.abs(ez) / crest.ihz);
    const rIn = shoreRadius(p, t);
    if (rOut - rIn < 0.12) continue;
    for (let k = 0.1; k < rOut - rIn; k += 0.15) {
      checked++;
      if (!withoutBars.some((dr) => inLobe(dr, ex * (rIn + k), ez * (rIn + k)))) bare++;
    }
  }
  console.info(`  ablation: with the bars removed, ${bare} of ${checked} strand probes are bare`);
  assert.ok(bare > checked * 0.8,
    'removing every sand bar left the strand covered - the sweep is not measuring them');
});

/* ================================================================== */
/* 4c. What the sand cost, which has to be nothing                     */
/* ================================================================== */

test('no dressed sand stands higher than one bank course', async () => {
  /* THE DRESSING RULE. The sand is visual only, so the price is that a player
   * can walk through it, and the bound is that the tallest thing they can walk
   * through is one course - the step they were taking anyway.
   */
  const b = await built();
  for (const o of b.kit.oases) {
    const a = auditDressing(o.plan, o.dressing);
    console.info(`  ${o.plan.id.padEnd(12)} ${a.count} lobes, worst ghost`
      + ` ${a.worstGhost.toFixed(3)} m of ${GHOST_MAX} at ${a.worstAt},`
      + ` ${a.bevelled} bevelled`);
    floorCheck(`${o.plan.id} sand lobes`, 200, a.count, a.count);
    assert.ok(a.ok, `${o.plan.id}: a lobe stands ${a.worstGhost.toFixed(2)} m over the ground`
      + ` under it, past the ${GHOST_MAX} m bound, at ${a.worstAt}`);
    /* And every one of them is under `BEVEL_MIN` on its smallest side, which
     * is what keeps the sand at 12 triangles a lobe instead of 108. */
    assert.equal(a.bevelled, 0,
      `${o.plan.id}: ${a.bevelled} lobes are big enough for Batch.box to bevel - 9x the cost`);

    /* THE SAME NUMBER, ASKED OF THE PHYSICS INSTEAD OF THE PLAN.
     *
     * `auditDressing` calls the kit's own `dressFloor`, and `dress` clamps
     * against that same function - so on its own the audit can only ever
     * agree with itself, and a `dressFloor` that returned the highest surface
     * under a lobe instead of the lowest would sail through it. This asks the
     * REAL collider set what is under each lobe and measures the ghost against
     * that, which is the same "emitted is not present" rule the rest of this
     * file runs on. Probed from just above the lobe's own top, so the ray
     * cannot start inside the shade roof or a palm.
     */
    let physWorst = -Infinity;
    let physAt = null;
    let probed = 0;
    const cos = Math.cos(o.plan.yaw);
    const sin = Math.sin(o.plan.yaw);
    for (const dr of o.dressing) {
      const x = o.plan.x + dr.lx * cos + dr.lz * sin;
      const z = o.plan.z - dr.lx * sin + dr.lz * cos;
      /* FROM THE CREST DOWN, not from the lobe's own top.
       *
       * A lobe seated below the tread it overlaps - which the kit allows, and
       * which its own note at the corner wedges explains - starts a ray from
       * its top UNDER the masonry, and the ray then runs to the desert and
       * reports a 2.30 m ghost on a 0.28 m lobe. That is a broken probe, not a
       * broken lobe. Started at the crest the ray meets the tank first, and
       * 0.30 m over it is the same offset `the tank cannot be fallen into`
       * uses to pass under the shade roof and the well curb. */
      const ground = b.physics.groundHeight(x, z, o.plan.crestY + 0.3, 12);
      if (ground === null) continue;
      probed++;
      const ghost = dr.top - ground;
      if (ghost > physWorst) {
        physWorst = ghost;
        physAt = `${dr.key} at (${dr.lx.toFixed(1)}, ${dr.lz.toFixed(1)})`;
      }
    }
    console.info(`  ${o.plan.id.padEnd(12)} against the real colliders: ${probed} lobes probed,`
      + ` worst ghost ${physWorst.toFixed(3)} m at ${physAt}`);
    floorCheck(`${o.plan.id} lobes probed against physics`, 200, probed, o.dressing.length);
    /* The same bound, plus a centimetre for the ray landing on a bevelled
     * course edge rather than on its flat top. */
    assert.ok(physWorst <= GHOST_MAX + 0.01,
      `${o.plan.id}: the collider set says a lobe stands ${physWorst.toFixed(2)} m over the`
      + ` ground under it - past the ${GHOST_MAX} m bound - at ${physAt}`);
  }

  /* ABLATION. Raise one lobe by a course and a half. The audit must refuse it,
   * and it must name the lobe rather than just going red. */
  const o = b.kit.oases[0];
  const broken = o.dressing.map((dr, i) => (i === 3 ? { ...dr, top: dr.top + 0.6 } : dr));
  const bad = auditDressing(o.plan, broken);
  console.info(`  ablation: one lobe raised 0.60 m -> worst ghost ${bad.worstGhost.toFixed(2)} m`
    + ` at ${bad.worstAt}, ok=${bad.ok}`);
  assert.ok(!bad.ok, 'a lobe standing 0.6 m over its own ground passed the dressing audit');
});

test('the sand costs nothing in the broadphase, and it would if it were solid', async () => {
  /* THE MEASUREMENT THIS WHOLE SECTION IS BUILT AROUND.
   *
   * `Oasis.COLLIDER_SEG_M` records that the worst broadphase cell in the world
   * is 63, at (-312, -96), which is the SAND-MIRROR'S WEST BANK - the exact
   * ground the dressing wants to pile sand on - and that getting it there from
   * 97 cost 200 extra colliders. So the sand registers none, and this asserts
   * both halves: the real number, and what it would have been.
   */
  const b = await built();
  const real = worstBroadphaseCell(b.physics);
  const counter = broadphaseWithDressing(b.physics, b.kit.oases);
  const lobes = b.kit.oases.reduce((n, o) => n + o.dressing.length, 0);
  console.info(`  worst cell ${real.count} at (${real.x}, ${real.z}),`
    + ` ${real.cells} cells, ${real.entries} entries, ${b.physics.colliders.length} colliders`);
  console.info(`  counterfactual: ${lobes} sand lobes as colliders would add`
    + ` ${counter.added} grid entries and take the worst cell to ${counter.worst}`);

  /* The ceiling `COLLIDER_SEG_M` bought, restated where a regression would be
   * read rather than inferred. */
  assert.ok(real.count <= 63,
    `the worst broadphase cell is ${real.count} against the 63 the collider split bought`);
  /* And the counterfactual is doing work: if solid sand cost nothing either,
   * this case proves nothing about the choice not to make it solid. */
  assert.ok(counter.worst > real.count,
    `solid sand would leave the worst cell at ${counter.worst} - this case is measuring nothing`);

  /* The sand is not there, physically. Sampled at each lobe's own centre, one
   * centimetre under its own top - which is above the course it stands on by
   * construction, so anything solid there is a collider the kit registered for
   * a lobe. */
  let solid = 0;
  let outside = 0;
  let solidAt = null;
  for (const o of b.kit.oases) {
    const cos = Math.cos(o.plan.yaw);
    const sin = Math.sin(o.plan.yaw);
    for (const dr of o.dressing) {
      /* Lobes on the tank only. The toe drift stands OUTSIDE the footprint on
       * desert this file never levelled, and it is sunk into it on purpose -
       * `containsPoint` there is answering about the heightfield, not about a
       * collider the kit registered, and four of them read solid for exactly
       * that reason. `ringAt` is the discriminator. */
      if (!ringAt(o.plan, dr.lx, dr.lz)) { outside++; continue; }
      const under = Oasis.surfaceAt(o.plan, dr.lx, dr.lz);
      // Only meaningful where the lobe's top clears the ground it sits on.
      if (dr.top - under < 0.06) continue;
      const x = o.plan.x + dr.lx * cos + dr.lz * sin;
      const z = o.plan.z - dr.lx * sin + dr.lz * cos;
      if (b.physics.containsPoint(new THREE.Vector3(x, dr.top - 0.01, z))) {
        solid++;
        if (!solidAt) solidAt = `${o.plan.id} ${dr.key} at (${dr.lx.toFixed(1)}, ${dr.lz.toFixed(1)})`;
      }
    }
  }
  console.info(`  ${solid} of ${lobes - outside} lobes on the tank read as solid to the`
    + ` physics (${outside} toe drifts skipped: they are buried in the desert)`
    + `${solidAt ? ` - first ${solidAt}` : ''}`);
  floorCheck('lobes the solidity probe could test', 400, lobes - outside, lobes);
  assert.equal(solid, 0,
    `${solid} sand lobes registered a collider - see the dressing rule in Oasis.js`);
});

/* ================================================================== */
/* 5. THE PROOF: the real player, in and out                           */
/* ================================================================== */

/** A real `Player` on the real physics, with the real water handed to its `Swim`. */
function makePlayer(physics, water, yaw = 0) {
  const input = {
    state: {
      forward: 0, right: 0, jump: false, sprint: false, crouch: false, fire: false,
      aim: false, reload: false, interact: false, lookX: 0, lookY: 0, wheel: 0,
    },
  };
  const player = new Player({
    scene: new THREE.Scene(), engine: {}, physics,
    bus: { on: () => () => {}, emit() {} }, materials: {}, input,
    camera: new THREE.PerspectiveCamera(),
  });
  player.setYaw(yaw);
  player.swim.setVolumes(water);
  // Stamina must not be the thing that decides this: an exhausted swimmer
  // sinks by design, and the question here is the SHAPE of the pool.
  if (player.stamina) player.stamina.value = player.stamina.max ?? 100;
  return { player, input };
}

/** Place the capsule and let the solver settle it. */
function place(player, x, y, z, steps = 60) {
  player._position.set(x, y, z);
  player._velocity.set(0, 0, 0);
  for (let i = 0; i < steps; i++) player.fixedUpdate(DT, i * DT);
  return player;
}

/**
 * Hold an input and report the run.
 * @returns {{steps:number, swamSteps:number, path:number, endedSwimming:boolean,
 *            minY:number, maxY:number, drowned:boolean, health:number}}
 */
function drive(player, input, seconds, state = {}, stopWhen = null) {
  Object.assign(input.state, { forward: 0, right: 0, jump: false, sprint: false, crouch: false }, state);
  const n = Math.round(seconds / DT);
  let swamSteps = 0;
  let path = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  let px = player.position.x;
  let pz = player.position.z;
  let stoppedAt = -1;
  let i = 0;
  for (; i < n; i++) {
    player.fixedUpdate(DT, 100 + i * DT);
    if (player.isSwimming) swamSteps++;
    path += Math.hypot(player.position.x - px, player.position.z - pz);
    px = player.position.x;
    pz = player.position.z;
    minY = Math.min(minY, player.position.y);
    maxY = Math.max(maxY, player.position.y);
    /* Stop the instant the goal is met.
     *
     * Not cosmetic. Held for the full twenty seconds, a player who HAS got out
     * carries on walking - over the crest, down the outer bank and onto the
     * desert, which by construction is 2.57 m BELOW the waterline. The first
     * version of this case then failed them for "still under the waterline",
     * which is the exact opposite of what had happened. The question is
     * whether they got out, so the run ends when they are out. */
    if (stopWhen && stopWhen(player)) { stoppedAt = i + 1; break; }
  }
  return {
    steps: i, swamSteps, path, endedSwimming: player.isSwimming,
    stoppedAt, seconds: i * DT,
    minY, maxY, drowned: player.health < 100, health: player.health,
  };
}

test('the pool can be swum: wading in from the crest starts a swim', async () => {
  const b = await built();
  const o = b.kit.oases[0];
  const p = o.plan;

  /* Stand on the crest walkway at the oasis's local -X and face the water.
   *
   * `toWorld` maps local +X onto the world direction (cos yaw, -sin yaw); the
   * player's facing at yaw t is (-sin t, -cos t); equating them gives
   * t = yaw - PI/2. Getting that sign wrong was the first version of this
   * case, and it walked the player backwards into the shade shelter's wall,
   * where it stood for twelve seconds reporting a perfectly true 1.2 m.
   *
   * Offset 3 m along local +Z so the start is on clear walkway rather than
   * inside the shelter, which is centred on local -X. */
  const cos = Math.cos(p.yaw);
  const sin = Math.sin(p.yaw);
  const startLx = -(p.water.hx + 0.65);
  const startLz = 3.0;
  const sx = p.x + startLx * cos + startLz * sin;
  const sz = p.z - startLx * sin + startLz * cos;
  const { player, input } = makePlayer(b.physics, b.water, p.yaw - Math.PI / 2);
  place(player, sx, p.crestY + 1.0, sz);

  const startY = player.position.y;
  assert.ok(Math.abs(startY - p.crestY) < 0.35,
    `did not land on the crest: y=${startY.toFixed(2)} vs ${p.crestY.toFixed(2)}`);
  assert.equal(player.isSwimming, false, 'standing on the dry crest already counts as swimming');

  const run = drive(player, input, 12, { forward: 1 });
  const travelled = Math.hypot(player.position.x - sx, player.position.z - sz);
  console.info(`  waded ${travelled.toFixed(1)} m in ${(run.steps * DT).toFixed(0)} s,`
    + ` swimming on ${run.swamSteps}/${run.steps} steps,`
    + ` ended at y=${player.position.y.toFixed(2)} (water ${p.waterY.toFixed(2)})`);

  /* THE FLOOR. Not "did not fall", not "is near water": the swim controller
   * took over, which is the only evidence the pool is a pool. Ceiling is the
   * whole run, which would mean it engaged on the first step - impossible from
   * dry land, so the achieved number sits strictly between. */
  floorCheck('steps spent swimming, walking in', 120, run.swamSteps, run.steps);
  assert.ok(!run.drowned, `the player drowned wading in (health ${run.health})`);
});

test('the pool can be swum OUT of by holding forward, and nothing else', async () => {
  const b = await built();
  /* Both oases. One of them working is a coincidence; the kit's claim is about
   * the profile, and the profile is shared. */
  for (const o of b.kit.oases) {
    const p = o.plan;
    /* Four bearings out of the middle of the pool, because the tank is
     * rectangular and the long axis and the short axis are different swims.
     * `dir` is the local direction the player faces; facing is -Z at yaw 0. */
    /* `toWorld` maps local +X to (cos yaw, -sin yaw) and local +Z to
     * (sin yaw, cos yaw); the player faces (-sin t, -cos t). Solving each
     * gives the four yaws below - derived, not guessed, because a sign error
     * here turns "cannot get out" into "walked the wrong way". */
    const bearings = [
      { name: '+x', yaw: p.yaw - Math.PI / 2 },
      { name: '-x', yaw: p.yaw + Math.PI / 2 },
      { name: '+z', yaw: p.yaw + Math.PI },
      { name: '-z', yaw: p.yaw },
    ];
    for (const bg of bearings) {
      const { player, input } = makePlayer(b.physics, b.water, bg.yaw);
      // Dropped in the middle, at the surface. Let buoyancy settle them first.
      place(player, p.x, p.waterY - 0.2, p.z, 90);
      assert.ok(player.isSwimming,
        `${p.id} ${bg.name}: dropped in the middle of the pool and did not start swimming`);
      const feet0 = player.position.y;

      /* Hold forward. No jump - the water mantle at `Climb.js:159` is a real
       * exit and a real player would use it, but a pool that NEEDS it is a
       * pool with a wall round it, and the point of the beach is that it does
       * not. Level pitch, so `Swim`'s look-driven vertical wish is exactly
       * zero and buoyancy alone owns Y: this is the least helpful input the
       * controller accepts. */
      /* OUT means: not swimming, standing on something, and standing at crest
       * height - the crest is the only dry surface inside the tank. */
      const out = (pl) => !pl.isSwimming && pl.grounded && pl.position.y >= p.crestY - 0.2;
      const run = drive(player, input, 20, { forward: 1 }, out);

      const y = player.position.y;
      console.info(`  ${p.id.padEnd(12)} ${bg.name}: out in ${run.seconds.toFixed(1)} s`
        + ` (${run.swamSteps} of ${run.steps} steps swimming), path ${run.path.toFixed(1)} m,`
        + ` feet ${feet0.toFixed(2)} -> ${y.toFixed(2)}`
        + ` (water ${p.waterY.toFixed(2)}, crest ${p.crestY.toFixed(2)})`);

      assert.ok(run.stoppedAt > 0,
        `${p.id} ${bg.name}: 20 s of holding forward and never reached the crest -`
        + ` SOFT LOCK. Ended y=${y.toFixed(2)}, swimming=${run.endedSwimming},`
        + ` grounded=${player.grounded}, ${run.path.toFixed(1)} m of path`);
      assert.ok(!run.drowned, `${p.id} ${bg.name}: drowned on the way out (health ${run.health})`);
      /* And it took a real swim to get there, rather than the drop-in having
       * landed them in the shallows. Oxygen is 14 s; nothing here is close. */
      floorCheck(`${p.id} ${bg.name} steps spent swimming`, 30, run.swamSteps, run.steps,
        `out in ${run.seconds.toFixed(1)} s`);
    }
  }
});

test('the swim-out probe can detect a walled pool (ablation)', async () => {
  /* THE CEILING ON THE PROOF ABOVE. If the driver reports success against a
   * pool that is provably inescapable, it proves nothing about the one that
   * is not. So: the same oasis, built standalone on flat ground, with the
   * beach replaced by the 0.40 m step the first draft had. Same driver, same
   * input, and it must fail.
   */
  const physics = new Physics();
  // Flat desert.
  const N = 64;
  const heights = new Float32Array(N * N);
  physics.addHeightfield({
    heights, nx: N, nz: N, originX: -120, originZ: -120, stepX: 240 / (N - 1),
  });
  const field = new SolidField(physics.colliders);

  const settled = settleOasis({ id: 'walled', label: 'Walled', x: 0, z: 0, yaw: 0 }, field);
  assert.ok(settled.viable, settled.reasons.join('; '));

  /* Collapse b1..b4 into ONE 0.60 m riser, i.e. delete the beach. The water
   * level, the deep floor and the crest are untouched, so this is the same
   * pool with a wall where the shallows were. */
  const p = settled.plan;
  const kept = p.rings.filter((r) => !['b1', 'b2', 'b3'].includes(r.id));
  const walled = {
    ...p,
    rings: kept.map((r) => (r.id === 'b4'
      ? { ...r, rise: 0.60, ihx: 8.0, ihz: 6.5 }
      : r)),
  };

  const group = new THREE.Group();
  buildOases({ physics, group, palms: 0, reeds: 0 }, [walled]);
  group.updateMatrixWorld(true);
  const water = new WaterVolumes({});
  water.rebuildFromWorld({ id: 'walled', group, rules: {} }, true);
  assert.ok(water.volumes.length > 0, 'the ablation pool has no water in it');

  const { player, input } = makePlayer(physics, water, Math.PI / 2);
  place(player, 0, p.waterY - 0.2, 0, 90);
  assert.ok(player.isSwimming, 'the ablation pool is not deep enough to swim in');
  const run = drive(player, input, 20, { forward: 1 });
  console.info(`  ablation: swam ${run.swamSteps}/${run.steps} steps,`
    + ` ended y=${player.position.y.toFixed(2)} vs water ${p.waterY.toFixed(2)},`
    + ` swimming=${run.endedSwimming}`);
  assert.ok(run.endedSwimming || player.position.y < p.waterY,
    'the driver walked out of a pool with a 0.60 m wall round it -'
    + ' it is not measuring what it claims to measure');
});

test('the tank cannot be fallen into from the desert', async () => {
  const b = await built();
  const o = b.kit.oases[0];
  const p = o.plan;
  /* Walk at the oasis from outside on sixteen bearings and record the worst
   * single-step drop. The failure this rules out is an outer bank that is a
   * revetment WALL rather than a flight of courses - which is what a birka
   * looks like if the apron is left off - and a player who walks off it.
   *
   * Three details are load-bearing and the first version of this case had all
   * three wrong. The traverse runs in the tank's LOCAL frame, so it follows
   * the courses however the plan is turned. It STOPS at the waterline: past
   * there the risers are pool bed, and a 0.45 m shelf you are swimming over is
   * not a ledge. And the probe starts 0.30 m over the crest rather than 6 m,
   * so it passes UNDER the well curb and the shade roof and reports the
   * ground rather than the furniture. */
  const crest = p.rings.find((r) => r.id === 'crest');
  let worstDrop = 0;
  let worstAt = 'nowhere';
  let worstRise = 0;
  let riseAt = 'nowhere';
  let bareWorst = 0;
  let foreign = 0;
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const ex = Math.cos(a);
    const ez = Math.sin(a);
    /* From 1.2 m outside the tank's own footprint, so the desert-onto-bank
     * step is measured and nothing further out is. Sampled to +6 m the worst
     * reading was 0.70 m at 38.0 m on the diagonal - 2.1 m clear of anything
     * this kit built, i.e. the CITADEL's own ground. The bare control below
     * makes that visible instead of quietly attributing it to the oasis. */
    const foot = 1 / Math.max(Math.abs(ex) / p.hx, Math.abs(ez) / p.hz);
    /* Offset, and stepped by a number that shares no factor with the treads.
     * At a round 0.2 m pitch many samples land EXACTLY on the shared face
     * between two courses - the treads are 0.9 and 0.6 - and a downward ray on
     * a shared face falls between both boxes and reports the terrain 0.95 m
     * below. That read as a hole in the bank on four bearings. A capsule of
     * radius 0.35 cannot fall through a zero-width seam; the probe could. */
    const outer = foot + 1.17;
    const inner = 1 / Math.max(Math.abs(ex) / crest.ihx, Math.abs(ez) / crest.ihz);
    let prev = null;
    let bare = null;
    for (let s = outer; s > inner; s -= 0.13) {
      const lx = ex * s;
      const lz = ez * s;
      const x = p.x + lx * Math.cos(p.yaw) + lz * Math.sin(p.yaw);
      const z = p.z - lx * Math.sin(p.yaw) + lz * Math.cos(p.yaw);
      const h = b.physics.groundHeight(x, z, p.crestY + 0.3, 8);
      const g = b.field.terrainAt(x, z);
      /* Is what the ray found the tank, or the desert, or SOMEBODY ELSE'S
       * geometry? The first two are this claim; the third is not. Reading
       * everything the ray hit reported a 1.16 m drop 27.0 m out - a Citadel
       * prop standing 0.1 m beyond the footprint, which the vacancy audit
       * correctly allows and which this case would have blamed on the bank.
       *
       * Matching the height against ANY course top was the first fix and it
       * was not enough: the prop stood at 1.16 m and the fifth apron course
       * happens to top out at 1.12 m, seven metres away. So the ring is looked
       * up by POSITION - which annulus is this sample standing in - and the
       * height has to match THAT course, or the terrain. */
      const ring = p.rings.find((r) => (
        Math.abs(lx) <= r.hx && Math.abs(lz) <= r.hz
        && (r.kind === 'floor' || Math.abs(lx) >= r.ihx || Math.abs(lz) >= r.ihz)
      ));
      const known = h !== null && (
        (g !== null && Math.abs(h - g) < 0.05)
        || (ring !== undefined && Math.abs(h - ring.top) < 0.05)
      );
      if (known) {
        if (prev !== null && prev - h > worstDrop) {
          worstDrop = prev - h;
          worstAt = `${((a * 180) / Math.PI) | 0} deg, ${s.toFixed(1)} m out,`
            + ` ${prev.toFixed(2)} -> ${h.toFixed(2)}`;
        }
        /* And the same profile read the other way. Walking IN, the bank only
         * ever rises, so `worstDrop` is near zero and on its own it is the
         * weaker half of the claim: the number that decides whether a player
         * can get ON to the tank at all is the RISE, and the number that
         * decides whether walking off it hurts is the same rise as a drop. */
        if (prev !== null && h - prev > worstRise) {
          worstRise = h - prev;
          riseAt = `${((a * 180) / Math.PI) | 0} deg, ${s.toFixed(1)} m out,`
            + ` ${prev.toFixed(2)} -> ${h.toFixed(2)}`;
        }
        prev = h;
      } else {
        foreign++;
        prev = null;
      }
      // The control: the same line on the terrain the tank was put on.
      if (g !== null) {
        if (bare !== null && bare - g > bareWorst) bareWorst = bare - g;
        bare = g;
      } else bare = null;
    }
  }
  console.info(`  over 16 inbound traverses: worst step-DOWN ${worstDrop.toFixed(2)} m`
    + ` (${worstAt}), worst step-UP ${worstRise.toFixed(2)} m (${riseAt});`
    + ` bare desert over the same lines ${bareWorst.toFixed(2)} m;`
    + ` ${foreign} samples skipped as somebody else's geometry`
    + `  [step-up ${STEP_MAX}, bruise at ${FALL_DAMAGE_M}]`);
  /* The bar is the walking step-up itself: a drop at or under it is
   * reversible - the player simply steps back up the way they came - and the
   * whole tank is two orders of magnitude under the height at which a fall
   * costs health. */
  assert.ok(worstDrop <= STEP_MAX + 0.01,
    `a ${worstDrop.toFixed(2)} m drop on the way in is a ledge, not a bank`);
  assert.ok(worstRise <= STEP_MAX + 0.01,
    `a ${worstRise.toFixed(2)} m riser at ${riseAt} is a wall, not a bank -`
    + ` the player cannot walk onto the oasis from that bearing`);
});

/* ================================================================== */
/* 6. What the world can wire up                                       */
/* ================================================================== */

test('the crest promenade is walkable all the way round', async () => {
  /* THE CASE THAT CAUGHT THE WELL HEAD.
   *
   * The swim-out driver walked a player out of the pool and straight into the
   * well curb, which at the 2.40 m crest tread this kit was first drawn with
   * overhung the water by 0.16 m and blocked the only way off the strand. The
   * furniture band exists because of that, and this is the ratchet: the
   * walkway between the waterline and anything built on the rim must be clear
   * at every bearing.
   *
   * Sampled with `containsPoint` at knee, chest and head height rather than
   * with the capsule solver, so a near miss is still a pass and a real
   * obstruction cannot be quietly resolved away.
   */
  const b = await built();
  for (const o of b.kit.oases) {
    const p = o.plan;
    const crest = p.rings.find((r) => r.id === 'crest');
    // The line a player hugging the pool would take: capsule radius plus a
    // little, outside the water's edge.
    const walk = 0.65;
    let blocked = 0;
    let worstAt = null;
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      const ex = Math.cos(a);
      const ez = Math.sin(a);
      const k = 1 / Math.max(Math.abs(ex) / (crest.ihx + walk), Math.abs(ez) / (crest.ihz + walk));
      const lx = ex * k;
      const lz = ez * k;
      const x = p.x + lx * Math.cos(p.yaw) + lz * Math.sin(p.yaw);
      const z = p.z - lx * Math.sin(p.yaw) + lz * Math.cos(p.yaw);
      for (const dy of [0.4, 1.0, 1.6]) {
        if (b.physics.containsPoint(new THREE.Vector3(x, p.crestY + dy, z))) {
          blocked++;
          if (!worstAt) worstAt = `${((a * 180) / Math.PI) | 0} deg at ${dy} m up`;
          break;
        }
      }
    }
    console.info(`  ${p.id.padEnd(12)} walkway ${blocked}/72 bearings blocked`
      + `${worstAt ? ` (first at ${worstAt})` : ''}`);
    assert.equal(blocked, 0, `${p.id}: the promenade is blocked at ${worstAt}`);
  }
});

test('the walkway probe can see the furniture it was written for (ablation)', async () => {
  /* The same sweep taken out onto the furniture line, where the well head and
   * the shelter stand. It has to find them, or the case above is measuring
   * empty air and would pass on a rim with nothing built on it at all. */
  const b = await built();
  const p = b.kit.oases[0].plan;
  const crest = p.rings.find((r) => r.id === 'crest');
  const furnX = crest.hx - 1.25;
  const furnZ = crest.hz - 1.25;
  const world = (lx, lz, dy) => new THREE.Vector3(
    p.x + lx * Math.cos(p.yaw) + lz * Math.sin(p.yaw),
    p.crestY + dy,
    p.z - lx * Math.sin(p.yaw) + lz * Math.cos(p.yaw)
  );
  /* Named parts at known local coordinates rather than a bearing sweep, and
   * the sweep was tried first: the furniture is four objects a metre or two
   * across on a 100 m perimeter, so uniform bearings hit them three times out
   * of seventy-two whether the probe works or not. Three is not evidence. */
  const parts = [
    { name: 'well curb', at: world(furnX + 0.62, 0, 0.3) },
    { name: 'shelter post', at: world(-furnX + 0.85, 1.45, 1.0) },
    { name: 'shelter wall', at: world(-furnX - 1.02, 0, 1.0) },
    { name: 'fire ring', at: world(0.62, furnZ, 0.11) },
  ];
  for (const part of parts) {
    assert.ok(b.physics.containsPoint(part.at),
      `containsPoint says the ${part.name} is not there - the walkway probe is blind`);
  }
  console.info(`  ablation: all ${parts.length} named furniture parts read as solid`
    + ` (${parts.map((x) => x.name).join(', ')})`);
});

test('the oasis publishes an enterable, caches, a pitch and somewhere to rest', async () => {
  const b = await built();
  for (const o of b.kit.oases) {
    const e = o.enterable;
    // The doorless shape `Interiors` streams collectibles off, same as a cave.
    assert.ok(Array.isArray(e.doors) && e.doors.length === 0, 'the shelter is not doorless');
    floorCheck(`${o.plan.id} collectible spots`, 3,
      e.collectibleSpots.length, e.collectibleSpots.length);
    for (const s of e.collectibleSpots) {
      assert.ok(s.position?.isVector3, 'a collectible spot is not a Vector3');
      /* Reachable, not decorative: every spot stands on something solid, in
       * air, inside the footprint. A spot inside masonry is a pickup nobody
       * can take and the streaming loop has no way to notice. */
      const ground = b.physics.groundHeight(s.position.x, s.position.z, s.position.y + 3, 12);
      assert.ok(ground !== null, 'a collectible spot has no floor under it');
      assert.ok(!b.physics.containsPoint(s.position),
        `a collectible spot at (${s.position.x.toFixed(1)}, ${s.position.y.toFixed(1)},`
        + ` ${s.position.z.toFixed(1)}) is inside solid geometry`);
    }
    // The rare one is on the bed, under real water. That is the reason to dive.
    const deep = e.collectibleSpots.find((s) => s.tier === 'rare');
    const surf = b.water.surfaceYAt(deep.position.x, deep.position.z);
    assert.ok(surf !== null && surf - deep.position.y > MIN_DIVE,
      'the rare spot is not under a divable depth of water');

    floorCheck(`${o.plan.id} cache sites`, 1, o.cacheSites.length, o.cacheSites.length);
    floorCheck(`${o.plan.id} npc pitches`, 2, o.npcSpawns.length, o.npcSpawns.length);
    floorCheck(`${o.plan.id} rest spots`, 2, o.restSpots.length, o.restSpots.length);
    // Every published position is on the ground the kit says it is on.
    /* Probed from just above the published height, not from 4 m up: the shade
     * shelter has a roof at crest + 2.66 m and a downward ray started over it
     * reports the THATCH as the floor, which is how the first version of this
     * case decided the water seller was standing 2.94 m underground. */
    for (const n of o.npcSpawns) {
      const g = b.physics.groundHeight(n.position.x, n.position.z, n.position.y + 0.4, 8);
      assert.ok(g !== null && Math.abs(g - n.position.y) < 0.6,
        `${n.name} is published ${g === null ? 'over nothing'
          : `${(n.position.y - g).toFixed(2)} m off the floor`}`);
      assert.ok(!b.physics.containsPoint(
        new THREE.Vector3(n.position.x, n.position.y + 0.9, n.position.z)),
      `${n.name} is published inside solid geometry`);
    }
  }
});

test('the oasis is what finally makes a sunken cache possible in the Citadel', async () => {
  /* `Caches._findSunken` has always placed ZERO here - the log reads "0 sunken,
   * 9 high" - for one reason: `Citadel has no water`. That is a comment in
   * `Caches.js`, and it stops being true the moment this kit lands. Measured
   * through the real search rather than asserted, because the search has its
   * own rules (`MIN_DIVE`, and 22 m between sites). */
  const b = await built();
  const rnd = (() => { let s = 12345; return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); })();
  const vols = b.water.volumes;
  let found = 0;
  const seen = [];
  for (let t = 0; t < 400 && found < 3; t++) {
    const v = vols[Math.floor(rnd() * vols.length)];
    const x = v.box.min.x + rnd() * (v.box.max.x - v.box.min.x);
    const z = v.box.min.z + rnd() * (v.box.max.z - v.box.min.z);
    const surface = b.water.surfaceYAt(x, z);
    if (surface === null) continue;
    const bed = b.physics.groundHeight(x, z, surface + 1.0, 40);
    if (bed === null || surface - bed < MIN_DIVE) continue;
    if (seen.some((s) => Math.hypot(s.x - x, s.z - z) < 22)) continue;
    seen.push({ x, z });
    found++;
  }
  console.info(`  ${found} sunken cache sites reachable in ${vols.length} volumes`
    + ` (Caches wants 3, at >= ${MIN_DIVE} m deep and 22 m apart)`);
  /* THE CEILING IS THE WORLD WITHOUT THIS KIT, and it is zero: run the same
   * search against no volumes at all, which is exactly what `Caches` saw in
   * the Citadel before today. The floor is 2 rather than the 3 `Caches` asks
   * for, and the reason is arithmetic rather than a shortfall: the deepest
   * part of one pool is 14 x 11 m and `_findSunken` keeps sites 22 m apart,
   * so one pool can hold exactly one. Two oases, two sites. A third would need
   * a third oasis or a longer tank. */
  floorCheck('sunken cache sites the Citadel can now hold', 2, found, 3,
    'was 0 before the oases: Caches.js says so in its own comment');
  assert.ok(found <= b.kit.oases.length,
    'more sunken sites than there are pools - the 22 m rule is not being applied');
});

/* ================================================================== */
/* 7. Cost                                                             */
/* ================================================================== */

test('one oasis costs three draw calls of its own, and seven more in the host batch', async () => {
  const b = await built();
  const world = b.world;
  const worldTris = (() => {
    let t = 0;
    world.group.traverse((m) => {
      if (!m.isMesh) return;
      const per = triangleCount(m.geometry);
      t += m.isInstancedMesh ? per * m.count : per;
    });
    return t;
  })();

  let totalDraws = 0;
  let totalTris = 0;
  for (const o of b.kit.oases) {
    const c = o.cost;
    console.info(`  ${o.plan.id.padEnd(12)} ${c.boxes} boxes`
      + ` (${c.bevelled} bevelled, ${c.plain} plain, ${c.dressed} of them sand`
      + ` = ${c.dressedTriangles} tri) = ${c.triangles} tri merged into the host batch`
      + ` + water ${o.water.triangles} + ${o.palms.count} palms ${o.palms.triangles}`
      + ` = ${c.submitted} submitted, ${c.draws} own draw calls,`
      + ` ${o.colliders.length} colliders, ${o.water.area.toFixed(0)} m2 of water`);
    totalDraws += c.draws;
    totalTris += c.submitted;
    /* Zero extra draw calls for the masonry is the whole reason `buildOasis`
     * takes the host's `Batch.box`. `draws` counts only what the kit adds on
     * its own: the water plane and the two instanced palm fields. */
    /* THREE, and the three are the water plane and the two instanced palm
     * fields. Zero for the masonry is the whole reason `buildOasis` takes the
     * host's `Batch.box`; if it ever stops using it, `buildOasis` falls back to
     * a private `OasisBatch`, flushes six meshes of its own, and this reads 9.
     * That is not hypothetical - it is what this case read before the host
     * stand-in above existed. */
    assert.equal(c.draws, 3,
      `${o.plan.id} adds ${c.draws} draw calls - the terraces are not merging into the host batch`);
    /* The structure itself. The palms are counted separately because they are
     * a dial (`ctx.palms`) and the tank is not.
     *
     * 15,500 and 32,000, RAISED from 12,500 and 29,000 when the sand landed,
     * and both are re-derived rather than nudged. The tank's own masonry did
     * not change - the terraces are the same boxes in different tints - and
     * the increase is the dressing, which is broken out below so the two can
     * never be confused again. Measured on the shipped tanks:
     *
     *                 masonry   of that, sand   submitted
     *   palm-well      13,008       2,760        29,000
     *   sand-mirror    14,160       2,724        30,152
     *
     * The two differ by 1,152 for a reason that predates this and is not the
     * sand - their sand is within 40 triangles of each other. The sand-mirror
     * sits on 0.835 m of relief against the palm-well's 0.302, so its rings
     * run deeper, more of them clear `BEVEL_MIN` on their smallest side, and a
     * bevelled box is nine boxes' worth of triangles. The ceilings are set 6-9%
     * over the worse of the two, which is the margin they carried before. */
    assert.ok(c.triangles < 15500,
      `${o.plan.id}'s masonry is ${c.triangles} triangles`);
    assert.ok(c.submitted < 32000,
      `${o.plan.id} submits ${c.submitted} triangles`);
    /* THE SAND, priced separately, and the floor is what stops it being
     * quietly deleted the next time somebody is short of triangles. Every
     * lobe is a 12-triangle plain box by construction - see the dressing
     * rule - so this is the lobe count times twelve and nothing else. */
    floorCheck(`${o.plan.id} sand triangles`, 2400, c.dressedTriangles, c.triangles);
    assert.equal(c.dressedTriangles, c.dressed * 12,
      `${o.plan.id}: ${c.dressed} sand lobes cost ${c.dressedTriangles} triangles,`
      + ' which is not 12 each - something in the dressing is being bevelled');
    // The palm fields are frustum-cullable, which the world's own are not.
    for (const m of o.palms.meshes) {
      const r = m.boundingSphere?.radius ?? Infinity;
      assert.ok(r < 40, `${m.name} has a ${r.toFixed(1)} m sphere - it will never be culled`);
    }
  }
  /* What the host batch received - and it is the OTHER HALF OF THE BILL, which
   * this case used to get wrong.
   *
   * It used to argue that a key `CitadelWorld` already flushes elsewhere costs
   * nothing, because the geometry "rides into a mesh that exists whether or not
   * there is an oasis". That is true of a host that merges the oasis into its
   * world-wide buckets. `CitadelWorld` does not: it opens a `Batch` PER OASIS
   * and flushes it as `oasis:<id>:<key>` (`CitadelWorld.js:4569`), for the
   * measured reason that the two sites are 210 m apart and one shared mesh
   * comes back from the district splitter as many more leaves than two. So in
   * this world every DISTINCT KEY a tank touches is one more mesh and one more
   * draw call, whether or not the key is used anywhere else.
   *
   * That is not theory. The art pass added a seventh key, `dirt.ground`, and
   * the built world went from 164 scene meshes to 166: exactly
   * `oasis:palm-well:dirt.ground` and `oasis:sand-mirror:dirt.ground`. TWO
   * things emit it - the bank repainted off `stone.cobble`/`plaster.wall` (186
   * boxes over the two tanks) and the sand dressing (431) - so it survives the
   * removal of either, and neither looks like a draw call from where it is
   * written: one is a tint change and the other is dressing that deliberately
   * costs no colliders. Nothing here or in `citadel-budgets` could see it,
   * because both counted only what the KIT emits.
   *
   * So the COUNT is what prices the draw calls and the count is what is
   * asserted. `CITADEL_KEYS` stays, demoted to what it can honestly say: which
   * of these keys the Citadel paints anywhere else, which is worth knowing when
   * the oasis palette is being chosen and is not a draw-call argument. */
  const CITADEL_KEYS = new Set([
    'stone.castle', 'stone.cobble', 'plaster.wall', 'wood.beam', 'wood.plank',
    'thatch.roof', 'roof.tile', 'dirt.ground', 'fabric.banner',
  ]);
  const fresh = [];
  for (const [key, rec] of b.hostBuckets) {
    console.info(`  host bucket ${key.padEnd(14)} ${String(rec.boxes).padStart(4)} boxes,`
      + ` ${rec.bevelled} bevelled${CITADEL_KEYS.has(key) ? '' : '   <- the Citadel paints nothing else with this'}`);
    if (!CITADEL_KEYS.has(key)) fresh.push(key);
  }
  floorCheck('material buckets the tank merges into', 4, b.hostBuckets.size, 7,
    '(ceiling = one mesh per key, per oasis, in this host)');
  assert.deepEqual(fresh, ['grass.field'],
    `the oases paint with materials the Citadel uses nowhere else: ${fresh.join(', ')}`);
  /* SEVEN keys, so seven host meshes per oasis on top of the kit's three, and
   * the world reports exactly that. Held as equality in both directions: this
   * is a draw-call bill and a key added by accident is the way it grows. */
  assert.equal(b.hostBuckets.size, 7,
    `the tanks paint with ${b.hostBuckets.size} materials, so each one costs `
    + `${b.hostBuckets.size} host meshes and not the 7 the cost notes are written against`);
  for (const p of b.world.traffic.oases) {
    assert.equal(p.hostMeshes, b.hostBuckets.size,
      `${p.id} flushed ${p.hostMeshes} host meshes for ${b.hostBuckets.size} keys - the two `
      + 'have come apart, so the bucket count no longer prices the draw calls');
    assert.equal(p.draws, p.kitDraws + p.hostMeshes,
      `${p.id}'s reported ${p.draws} draw calls are not its ${p.kitDraws} kit meshes `
      + `plus its ${p.hostMeshes} host meshes`);
  }

  const pct = (totalTris / worldTris) * 100;
  const hostDraws = b.world.traffic.oases.reduce((a, o) => a + o.hostMeshes, 0);
  console.info(`  two oases: ${totalTris} triangles on a ${worldTris} triangle world`
    + ` (+${pct.toFixed(1)}%), ${totalDraws} kit draw calls + ${hostDraws} host meshes,`
    + ` ${b.physics.colliders.length - b.baseColliders} colliders on ${b.baseColliders}`);
  /* Most of that is palms, and palms are what an oasis IS. The world already
   * spends 46 of them; these are the dial `ctx.palms` turns. */
  assert.ok(pct < 16, `the oases are ${pct.toFixed(1)}% of the world's triangles`);
  assert.ok(b.buildMs < 400, `building two oases took ${b.buildMs.toFixed(0)} ms`);
});

test('the cost report counts a bevel, not a box (ablation)', () => {
  /* `solidCost` exists because a private `OasisBatch` never bevels and the
   * host's `Batch.box` bevels almost everything the tank emits - a factor of
   * nine. A cost function that cannot tell them apart is a cost function that
   * under-reports by 89%. */
  const big = solidCost([{ w: 4, h: 2, d: 0.9 }]);
  const thin = solidCost([{ w: 4, h: 2, d: 0.06 }]);
  assert.equal(big.triangles, 108, 'a 0.9 m tread was not counted as bevelled');
  assert.equal(thin.triangles, 12, 'a 6 cm reed was counted as bevelled');
  assert.equal(solidCost([]).triangles, 0);
});

test('the palm is the world\'s palm, and one geometry serves both oases', async () => {
  const b = await built();
  const [a, c] = b.kit.oases;
  assert.equal(a.palms.trunk, c.palms.trunk, 'the two oases hold separate palm trunks');
  assert.equal(a.palms.crown, c.palms.crown, 'the two oases hold separate palm crowns');
  const own = palmGeometry();
  /* Same recipe as `CitadelWorld._buildTrees`: 10 trunk sections swept at 12
   * radial, 22 fronds of 9 stations at 4 radial, 3 date blobs. Pinned by
   * triangle count, which is what changes the moment somebody edits one copy
   * and not the other. */
  console.info(`  palm: trunk ${triangleCount(own.trunk)} tri,`
    + ` crown ${triangleCount(own.crown)} tri, ${a.palms.count} per oasis`);
  assert.equal(triangleCount(own.trunk), triangleCount(a.palms.trunk));
  assert.equal(triangleCount(own.crown), triangleCount(a.palms.crown));
  floorCheck('palms on the rim of one oasis', 6, a.palms.count, Oasis.PALM_COUNT);
});
