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
 * ── Cost ──────────────────────────────────────────────────────────────────
 * One shared Citadel build (~0.5 s) plus two oases and two site searches;
 * the whole file runs in about 5 s.
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
  auditShoreline, auditGrounded, buildOases, solidCost, triangleCount,
  palmGeometry,
  POOL_DEPTH, FLOAT_DEPTH, SWIM_ENTER_DEPTH, SWIM_EXIT_DEPTH, STEP_MAX,
  MIN_DIVE, MAX_RELIEF, CAPSULE_R,
} = Oasis;

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

test('one oasis costs three draw calls of its own and merges the rest', async () => {
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
      + ` (${c.bevelled} bevelled, ${c.plain} plain) = ${c.triangles} tri merged into the host batch`
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
     * a dial (`ctx.palms`) and the tank is not. */
    assert.ok(c.triangles < 12500,
      `${o.plan.id}'s masonry is ${c.triangles} triangles`);
    assert.ok(c.submitted < 29000,
      `${o.plan.id} submits ${c.submitted} triangles`);
    // The palm fields are frustum-cullable, which the world's own are not.
    for (const m of o.palms.meshes) {
      const r = m.boundingSphere?.radius ?? Infinity;
      assert.ok(r < 40, `${m.name} has a ${r.toFixed(1)} m sphere - it will never be culled`);
    }
  }
  /* What the host batch received, and it is the other half of the draw-call
   * claim: every key here is a bucket `CitadelWorld` ALREADY flushes -
   * `stone.cobble`, `plaster.wall`, `wood.beam`, `wood.plank` and
   * `thatch.roof` all appear in its own `B.box` calls - so the merged geometry
   * rides into a mesh that exists whether or not there is an oasis.
   * `grass.field` is the one exception and it is named rather than hidden. */
  const CITADEL_KEYS = new Set([
    'stone.castle', 'stone.cobble', 'plaster.wall', 'wood.beam', 'wood.plank',
    'thatch.roof', 'roof.tile', 'dirt.ground', 'fabric.banner',
  ]);
  const fresh = [];
  for (const [key, rec] of b.hostBuckets) {
    console.info(`  host bucket ${key.padEnd(14)} ${String(rec.boxes).padStart(4)} boxes,`
      + ` ${rec.bevelled} bevelled${CITADEL_KEYS.has(key) ? '' : '   <- NEW bucket in this world'}`);
    if (!CITADEL_KEYS.has(key)) fresh.push(key);
  }
  floorCheck('material buckets the tank merges into', 4, b.hostBuckets.size, b.hostBuckets.size);
  assert.deepEqual(fresh, ['grass.field'],
    `the oases introduce ${fresh.length} new material buckets: ${fresh.join(', ')}`);

  const pct = (totalTris / worldTris) * 100;
  console.info(`  two oases: ${totalTris} triangles on a ${worldTris} triangle world`
    + ` (+${pct.toFixed(1)}%), ${totalDraws} own draw calls + 1 shared bucket,`
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
