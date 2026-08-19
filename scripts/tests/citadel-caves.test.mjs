import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

/**
 * ARE THE CAVES SEALED, WALKABLE, LIT - AND ARE THEY ACTUALLY CHEAP?
 *
 * Design 2026-08-17 §5.3 makes three claims about caves: that `Interiors`
 * streams them off a doorless descriptor, that `InteriorKit` shapes them, and
 * that "200 torches cost zero new shader programs" so lighting them is free.
 * The first and third are true and measured below. The second is beside the
 * point, and the claim the section does NOT make turns out to be the one that
 * decides whether a cave is cheap at all - see "The heightfield" below.
 *
 * ── Every number here is a floor ──────────────────────────────────────────
 * Quoted floor / achieved / ceiling, ceiling by ablation, because "not worse
 * than" with no floor is how this project once shipped a world with zero
 * reachable wildlife and twenty-nine green tests. Where an ablation is cheap
 * it runs INSIDE the test, so the probe proves it can go red in the same
 * process that proves the world is green: a seal test that cannot detect a
 * deleted wall is not a seal test.
 *
 * ── Emitted is not present ────────────────────────────────────────────────
 * Every geometric assertion is made against `physics.colliders` of a fully
 * built Citadel, AFTER the caves are added to it - the final collider set,
 * not the builder's return value. `MazeShafts` proved a shaft sealed against
 * walls a later pass then deleted. `SolidField` has never heard of the cave
 * plan; it is handed a list of colliders and asked what is solid.
 *
 * ── The heightfield ───────────────────────────────────────────────────────
 * A `Physics` heightfield is solid from its surface down to `baseY`
 * (`Physics._closestPoint`, and `Collider` sets `baseY = minY - 50`). So a
 * cave dug into a hill is a cave inside solid rock, and the player is shoved
 * out through the roof. That is not a tuning problem, it is a "you cannot do
 * this at all" problem, and it means the rock a cave lives in has to be BUILT
 * - which is where the cost actually is. `the terrain does not fill the cave`
 * below asserts it, with the buried version as its own control.
 *
 * ── Cost ──────────────────────────────────────────────────────────────────
 * One Citadel build shared by every test (~2 s), plus the caves. The audits
 * are ~60k boundary samples and ~4k walkable columns per cave and cost tens of
 * milliseconds each.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/* ================================================================== */
/* A world, built without a browser                                    */
/* ================================================================== */

/**
 * The least DOM and WebGL a Citadel build touches.
 *
 * Lifted from `citadel-reach.test.mjs:157-215`, which lifted it from
 * `npc-routes.test.mjs`. Copied rather than imported on purpose: importing
 * another test module registers ITS tests in this process, and this file would
 * silently start running the 2,458-line reach suite every time it ran. Every
 * stub returns the SHAPE the caller needs and never a plausible value.
 */
function harness() {
  if (globalThis.__citadelCavesHarness) return;
  globalThis.__citadelCavesHarness = true;

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

const Caves = await import('../../src/worlds/citadel/Caves.js');
const { Physics } = await import('../../src/physics/Physics.js');
const { LightRig, RIG_BUDGET } = await import('../../src/gfx/LightRig.js');

const {
  SolidField, auditCave, auditSeal, auditGrounding, auditSpans, walkGraph, auditSteps,
  auditReach, floorIlluminance, lightSignature, buildCaveSystem, planMine, planKarst,
  citadelCaves, normalisePlan, batchCost, subtractRects, liftToClear, terrainProfile, auditVacancy, auditLedges,
  HEADROOM, STEP_MAX, MANTLE_MIN, MANTLE_MAX, ROCK_T, CAPSULE_H, SEAL_STEP, LIGHT_SLOTS,
} = Caves;

/**
 * Where the two authored caves go for this suite, and why they are SEARCHED
 * for rather than written down.
 *
 * The ring terrain is being authored in this same tree by another pass, and
 * three of the numbers this file was first written against moved under it
 * inside an hour - `HALF` 200 -> 450, `terrainH` flat 0 past r = 178 -> a
 * quarry crown 22 m up and a massif 44 m up. A hard-coded site would make this
 * suite a test of somebody else's landform.
 *
 * So each cave is placed by scanning a ring of candidate origins and bearings
 * round its region anchor and taking the one with the least terrain relief
 * under its own footprint, then raised by `liftToClear` until its floor clears
 * the ground. Both numbers - the relief it settled for and the lift it needed
 * - are asserted, because they ARE the cost of the heightfield rule and a site
 * that needs a 20 m plinth is a site that cannot carry a cave.
 */
const REGIONS = Object.freeze({
  mine: { x: 325, z: -96 },    // CITADEL_LANDFORMS 'quarry-deepworks'
  karst: { x: -40, z: -326 },  // CITADEL_LANDFORMS 'karst-massif'
});

/**
 * The flattest EMPTY (origin, yaw) for a plan within `reach` of a region
 * anchor.
 *
 * Both halves are load-bearing and the second one was learned the hard way.
 * Sited on terrain relief alone the mine landed inside the quarry's gantries:
 * it built and sealed perfectly and then reported two room-spanning slabs, six
 * illegal steps and a walled-up adit mouth, all of them somebody else's
 * colliders standing in the chamber. `auditVacancy` asks the world whether the
 * space is free BEFORE the cave goes in it, which turns an hour of reading
 * audit output into a rejected candidate.
 */
function siteFor(make, anchor, field, reach = 150, maxRelief = 2.5) {
  /* Distances ascending, and the first ring that yields a usable site wins.
   * Ranking on relief alone put both caves out on dead-flat desert 190 m from
   * the region they belong to, which is a true answer to the wrong question:
   * the mine goes in the quarry. Nearest-that-works is the right objective and
   * it is also the one that exercises `liftToClear`, because the ground near a
   * landform is not flat. */
  for (const d of [0.25, 0.4, 0.55, 0.7, 0.85, 1.0, 1.2].map((f) => reach * f)) {
    let best = null;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const origin = { x: anchor.x + Math.cos(a) * d, y: 0, z: anchor.z + Math.sin(a) * d };
      for (let k = 0; k < 8; k++) {
        const yaw = (k / 8) * Math.PI * 2;
        const plan = make({ origin, yaw });
        const prof = terrainProfile(plan, field, 2.0);
        if (!prof.covered || prof.relief > maxRelief) continue;
        if (best && prof.relief >= best.relief) continue;
        const raised = liftToClear(plan, field);
        const vac = auditVacancy(raised.plan, field, { step: 2.0 });
        if (vac.occupied || vac.mouthBlocked) continue;
        best = {
          plan: raised.plan, relief: prof.relief, lift: raised.lift, origin, yaw, vac,
          distance: d,
        };
      }
    }
    if (best) return best;
  }
  assert.fail('no site near this region anchor is level, empty and on the terrain sheet');
}

/** Drop at which fall damage first appears, and death. Measured, not derived. */
const FALL_DAMAGE_M = 7.5;
const FALL_LETHAL_M = 40.0;

let _built = null;
/**
 * THE CITADEL, AND THE TWO CAVES IT ACTUALLY SHIPS. Shared by every test here.
 *
 * ── The defect this rewrite ends ──────────────────────────────────────────
 *
 * This used to `await world.build()` - which had already run `_buildCaves` and
 * put two caves in `physics` - and then run its own {@link siteFor} search and
 * `buildCaveSystem` to add TWO MORE. It could not land on the shipped sites,
 * because `auditVacancy` refuses them: the world's caves are already standing
 * there. Measured, the two sets were nowhere near each other -
 *
 *                 audited here            shipped by the world
 *   mine          (355.0, -148.0) yaw 3.14   (261, -104) yaw 5.20  lift 26.20
 *   karst         (-18.6, -405.7) yaw 2.36   (-56, -281) yaw 0.40  lift 32.94
 *
 * - and the karst phantom stood on flat sand 130 m past the massif. Every
 * claim in this file - the walk graph, zero illegal risers, one component
 * holding both mouths and all the spots, the ledges, the illuminance, the
 * light signature - was proved about caves that do not exist, while
 * `citadel-objectives.test.mjs` explicitly delegates "every collectible inside
 * connects to an entrance" to this file. Most pointedly `site.relief < 4.0`
 * was asserted against a site nobody builds; the shipped hall measures 4.72.
 *
 * `CitadelWorld._buildCaves` publishes each cave's plan, colliders, lights and
 * descriptor on `world.caves`, so the `system` shape below is assembled from
 * what shipped rather than rebuilt beside it. `siteFor` stays, and is used by
 * the one test that is genuinely about the SEARCH rather than about a cave.
 */
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
    const baseColliders = physics.colliders.length;

    /* What the world built, in the shape `buildCaveSystem` returns, so every
     * assertion below reads the same way it always did. Order is the world's
     * own: quarry-adit then sunken-hall. */
    const shipped = (world.caves ?? []).filter((c) => c.built);
    assert.equal(shipped.length, 2, 'the world did not build both of its caves');
    const system = {
      caves: shipped.map((c) => ({
        plan: c.plan,
        colliders: c.parts.colliders,
        lights: c.parts.lights,
        enterable: c.parts.enterable,
      })),
      colliders: shipped.flatMap((c) => c.parts.colliders),
      lights: shipped.flatMap((c) => c.parts.lights),
      enterables: shipped.map((c) => c.parts.enterable),
    };
    /* The sites, as the world found them. `distance` is not recorded by the
     * world (it authored the anchors) so only the two numbers a site is judged
     * on are carried: relief under the footprint and the depth of built rock. */
    const sites = {};
    for (const c of shipped) {
      sites[c.id] = { relief: c.profile.relief, lift: c.lift, vac: c.vacancy, base: c.base };
    }
    const caveMs = shipped.reduce((a, c) => a + c.ms, 0);
    const group = world.group;

    // The FINAL collider set: Citadel's own plus the caves', after everything.
    const field = new SolidField(physics.colliders);
    const reports = system.caves.map((c) => auditCave(c.plan, field, c.lights));
    return {
      world, physics, scene, group, system, field, reports,
      worldMs, caveMs, baseColliders, sites,
    };
  })();
  return _built;
}

/** Report by cave id. */
const reportOf = (b, id) => b.reports.find((r) => r.id === id);

/* ================================================================== */
/* The probe itself                                                    */
/* ================================================================== */

test('the rectangle subtraction that cuts every doorway is exact', () => {
  /* The shell builder is one idea repeated twelve hundred times: take a face,
   * subtract the neighbours and the mouths, emit what is left. If the
   * subtraction is wrong the cave is wrong everywhere at once and the seal
   * audit reports a wall of leaks with no clue which of the two is broken. So
   * it is checked on its own first, by area, against a hole that touches an
   * edge, a hole in the middle and two overlapping holes. */
  const area = (rs) => rs.reduce((a, r) => a + (r.a1 - r.a0) * (r.b1 - r.b0), 0);
  const R = { a0: 0, a1: 10, b0: 0, b1: 4 };
  assert.equal(area(subtractRects(R, [])), 40);
  assert.equal(area(subtractRects(R, [{ a0: 2, a1: 4, b0: 0, b1: 4 }])), 32);
  assert.equal(area(subtractRects(R, [{ a0: 2, a1: 4, b0: 1, b1: 3 }])), 36);
  // Overlapping holes must not be double-counted.
  assert.equal(area(subtractRects(R, [
    { a0: 2, a1: 5, b0: 0, b1: 2 }, { a0: 4, a1: 7, b0: 0, b1: 2 },
  ])), 30);
  // A hole covering the whole face leaves nothing - that is a full-face mouth,
  // which the karst chimney depends on.
  assert.equal(subtractRects(R, [{ a0: -1, a1: 11, b0: -1, b1: 5 }]).length, 0);
  /* And the merge has to actually merge, or every wall is a collider storm.
   * Two NESTED holes, because that is the only shape that exercises the
   * second pass: they put an extra `b` cut through a band whose `a` spans are
   * identical either side of it. Six rectangles unmerged, four merged. */
  assert.equal(subtractRects(R, [{ a0: 4, a1: 6, b0: 1, b1: 3 }]).length, 4);
  assert.equal(subtractRects(R, [
    { a0: 4, a1: 6, b0: 1, b1: 3 }, { a0: 4, a1: 6, b0: 1, b1: 2 },
  ]).length, 4);
});

test('SolidField represents every collider Citadel owns', async () => {
  /* An audit that silently skips a collider type it does not understand is an
   * audit that reports a sealed cave next to a hole made of the type it
   * skipped. `unhandled` is the list of colliders the index could not
   * represent and it is asserted EMPTY, so the day Citadel grows a mesh or
   * sphere collider this goes red here rather than going quiet in the seal
   * test. */
  const b = await built();
  assert.equal(b.field.unhandled.length, 0,
    `${b.field.unhandled.length} colliders the seal probe cannot see: `
    + [...new Set(b.field.unhandled.map((c) => c.type))].join(', '));
  assert.ok(b.field.boxes.length > 3000,
    `only ${b.field.boxes.length} boxes indexed - Citadel measured ~3,500 colliders`);
  assert.ok(b.field.fields.length >= 1, 'the terrain heightfield is not in the index');
});

/* ================================================================== */
/* AUDIT 0 - grounded                                                  */
/* ================================================================== */

test('the terrain does not fill the cave, and the probe can tell when it does', async () => {
  /* ── The constraint ────────────────────────────────────────────────────
   * `Physics._closestPoint` on a heightfield: "Under the surface: the way out
   * is straight up to it... Below `baseY` the field stops being solid, so a
   * genuine cave or under-deck volume is not sealed." Citadel leaves `baseY`
   * at `minY - 50`. So a cave driven into a hillside is a cave inside a solid,
   * and a body standing in it is teleported to the hilltop.
   *
   * This is the finding that decides §5.3's "caves are nearly free". The
   * lighting really is free. The ROCK is not, because a cave cannot be
   * subtracted from terrain that already exists - the massif it is carved into
   * has to be built out of boxes above the surface, and the shell this kit
   * emits is only the inside face of it.
   *
   * ── Floor / achieved / ceiling ─────────────────────────────────────────
   * Floor: zero buried samples out of every floor column of every cell.
   * Ceiling by ablation, computed here rather than asserted from memory: the
   * same cave sunk 3 m has to come back with hundreds. A probe that cannot
   * find a cave buried in a hillside would report both as clean.
   */
  const b = await built();
  let samples = 0;
  for (const r of b.reports) {
    samples += r.grounding.samples;
    assert.equal(r.grounding.buried, 0,
      `${r.label}: ${r.grounding.buried} of ${r.grounding.samples} floor columns are under `
      + `the terrain surface, worst by ${r.grounding.worst.toFixed(2)} m at `
      + `${JSON.stringify(r.grounding.worstAt)} - the heightfield is solid down to baseY `
      + 'and the player will be shoved out through the roof');
  }
  assert.ok(samples > 3000, `only ${samples} grounding samples across both caves`);

  // ABLATION: the same mine, three metres down.
  const placed = b.system.caves[0].plan;
  const sunk = normalisePlan({ ...placed, id: 'sunk', origin: { ...placed.origin, y: placed.origin.y - 3 } });
  const bad = auditGrounding(sunk, b.field);
  assert.ok(bad.buried > 200,
    `the buried control only reported ${bad.buried} buried columns of ${bad.samples} - `
    + 'the grounding probe cannot see a cave inside a hillside, so its green result means nothing');
  /* Sinking a plan by 3 m adds exactly 3 m to every intrusion, so the control
   * is checked against the real cave's own figure rather than against a
   * remembered constant. (The absolute value is smaller than 3: `liftToClear`
   * clears the terrain maximum under the WHOLE plan, and the deepest cell in
   * the mine sits 2 m above the shallowest, so the worst floor-level column
   * starts well clear.) */
  const cleared = b.reports[0].grounding.worst;
  assert.ok(Math.abs((bad.worst - cleared) - 3) < 0.02,
    `sinking the mine 3 m moved its worst intrusion from ${cleared.toFixed(2)} to `
    + `${bad.worst.toFixed(2)} - the grounding probe is not measuring what it says it measures`);
});

/* ================================================================== */
/* AUDIT 1 - sealed, with exactly the intended openings                */
/* ================================================================== */

test('every cave is a sealed volume with exactly the openings it declared', async () => {
  /* ── Two halves, and both are needed ───────────────────────────────────
   * A cave with no holes in it passes "no leaks" perfectly and is unplayable.
   * A cave that is all hole passes "the mouths are open" perfectly and is a
   * quarry. So the assertion is a pair: every non-mouth boundary sample solid,
   * AND every mouth sample open all the way through the shell.
   *
   * ── Floor / achieved / ceiling ─────────────────────────────────────────
   * Floor: 0 leaks over the whole boundary at a 0.25 m pitch. Ceiling by
   * ablation below: delete ONE wall collider out of ~80 and the count must
   * jump. 0.25 m is finer than the 0.70 m capsule, so nothing this misses is
   * a hole a body could get through.
   *
   * ── Why against the real world ────────────────────────────────────────
   * `SolidField` here holds every collider in Citadel, not the cave's. If a
   * later pass in the world removes or moves a cave wall, or if a cave is
   * placed so that a rope-bridge anchor punches through it, this is where it
   * shows. That is the maze's lesson: emitted is not present.
   */
  const b = await built();
  let samples = 0;
  let open = 0;
  for (const r of b.reports) {
    samples += r.seal.samples;
    open += r.seal.open;
    assert.equal(r.seal.leaks.length, 0,
      `${r.label}: ${r.seal.leaks.length} of ${r.seal.samples} boundary samples are OPEN AIR `
      + `outside a declared mouth, first at ${JSON.stringify(r.seal.leaks[0])}`);
    assert.equal(r.seal.blockedMouths.length, 0,
      `${r.label}: ${r.seal.blockedMouths.length} mouth samples are walled up, first at `
      + JSON.stringify(r.seal.blockedMouths[0]));
    for (const [id, m] of r.seal.byMouth) {
      assert.ok(m.total > 40 && m.open === m.total,
        `${r.label} mouth "${id}" is ${m.open} open of ${m.total} samples - a mouth has to be `
        + 'wholly open and big enough to be worth sampling');
    }
  }
  assert.ok(samples > 50000, `only ${samples} boundary samples over two caves`);
  assert.ok(open > 500, `only ${open} open samples - the caves have almost no way in`);

  // ABLATION: knock one wall out of the mine and the probe must find the hole.
  const minePlan = b.system.caves[0].plan;
  const victim = b.system.caves[0].colliders
    .find((c) => c.halfExtents.y > 1.0 && c.halfExtents.x > 1.0);
  assert.ok(victim, 'no cave wall large enough to ablate');
  const kept = b.physics.colliders.filter((c) => c !== victim);
  const holed = auditSeal(minePlan, new SolidField(kept));
  assert.ok(holed.leaks.length > 20,
    `deleting a ${(victim.halfExtents.x * 2).toFixed(1)} x ${(victim.halfExtents.y * 2).toFixed(1)} m `
    + `wall produced only ${holed.leaks.length} leak samples - the seal probe cannot see a missing `
    + 'wall, so its zero on the real world is worth nothing');
});

/* ================================================================== */
/* AUDIT 2 - head clearance                                            */
/* ================================================================== */

test('every walkable square has 1.8 m over it, and no room is roofed over inside', async () => {
  /* ── The defect this is shaped around ──────────────────────────────────
   * Three rounds of lighting work on the medieval interiors chased "the rooms
   * are too dark" while headless illuminance said the dark rooms were getting
   * MORE light than the controls. The cause was not light: `_shell` dressed
   * plank walls in six courses of boarding and each course was one solid box
   * the size of the building, so every plank interior was a 1.6 m crawlspace
   * with its real ceiling walled off behind three slabs. Every clearance test
   * in the repo passed it, because the boarding had no collider.
   *
   * So this test is two probes, and neither alone would have found it:
   *   - `lowhead`: a column whose CELL FLOOR is standable but has under 1.8 m
   *     of air. That is the crawlspace symptom, counted separately from
   *     "there is a crate here".
   *   - `auditSpans`: GEOMETRY that both starts and stops between a cell's
   *     floor and its ceiling and covers a serious share of its plan.
   *
   * ── Floor / achieved / ceiling ─────────────────────────────────────────
   * Floor: zero spanning slabs, and lowhead under 25% of any cell. Lowhead is
   * not zero and should not be: the first mantle ledge of each climb is 1.4 m
   * over the floor and a body cannot walk under it, which is what a ledge IS.
   * Ceiling by ablation: a slab across the karst hall at 1.66 m - the medieval
   * number exactly - must be caught by both probes.
   */
  const b = await built();
  for (const r of b.reports) {
    assert.equal(r.spans.length, 0,
      `${r.label}: ${r.spans.length} slabs span a chamber between its floor and its ceiling, `
      + `first ${JSON.stringify(r.spans[0])}`);
    for (const [id, f] of r.graph.fractions) {
      assert.ok(f.lowhead <= 0.25,
        `${r.label}/${id}: ${(f.lowhead * 100).toFixed(0)}% of the floor has under ${HEADROOM} m `
        + 'over it - that is a crawlspace, not a chamber');
      assert.ok(f.covered >= 0.35,
        `${r.label}/${id}: only ${(f.covered * 100).toFixed(0)}% of the plan has any standable `
        + 'level at all');
    }
    for (const n of r.graph.nodes) {
      assert.ok(n.head >= HEADROOM,
        `${r.label}: a walkable node at ${n.y.toFixed(2)} has ${n.head.toFixed(2)} m of headroom`);
    }
    const tight = auditLedges(r.plan ?? b.system.caves[b.reports.indexOf(r)].plan, b.field);
    assert.equal(tight.length, 0,
      `${r.label}: ${tight.length} mantle ledges have under ${HEADROOM} m of air over them, `
      + `worst ${tight[0] && tight[0].head.toFixed(2)} m - a lattice at ${0.5} m cannot see a `
      + '0.36 m torch bracket, so the ledges are probed directly');
    assert.ok(r.graph.nodes.length > 800,
      `${r.label} has only ${r.graph.nodes.length} walkable nodes - too small to mean much`);
  }

  // ABLATION: the medieval defect, rebuilt at its real height, in the karst hall.
  const karst = b.system.caves[1];
  const plan = karst.plan;
  const hall = plan.cells.find((c) => c.id === 'hall');
  const physics = new Physics();
  for (const c of b.physics.colliders) physics.colliders.push(c);
  const centre = Caves.toWorld(plan, (hall.x0 + hall.x1) / 2, hall.floor + 1.66, (hall.z0 + hall.z1) / 2);
  physics.addRotatedBox(
    new THREE.Vector3(centre.x, centre.y, centre.z),
    new THREE.Vector3((hall.x1 - hall.x0) / 2, 0.05, (hall.z1 - hall.z0) / 2),
    plan.yaw
  );
  const boarded = new SolidField(physics.colliders);
  const spans = auditSpans(plan, boarded);
  assert.ok(spans.length > 0,
    'a plank slab across the whole karst hall at 1.66 m was not reported as spanning geometry - '
    + 'this is the exact defect that cost three rounds of lighting work and the probe cannot see it');
  const low = walkGraph(plan, boarded).fractions.get('hall').lowhead;
  assert.ok(low > 0.9,
    `the boarded hall reported only ${(low * 100).toFixed(0)}% lowhead - the clearance probe `
    + 'cannot see a ceiling 1.66 m over the floor');
});

/* ================================================================== */
/* AUDIT 3 - legal steps                                               */
/* ================================================================== */

test('no height change on a route is in the band between a step and a mantle', async () => {
  /* `CONFIG.player.stepHeight` is 0.45 and `Climb.js` will not mantle below
   * MIN_RISE_GROUND 1.0 or above MAX_RISE 2.4. The 0.45 - 1.0 m band is the
   * one a body has no verb for: too tall to walk up, too short for the game to
   * offer the hoist. A jump reaches 0.878 m of apex so some of it is
   * technically clearable, which is worse than either - it makes the route
   * depend on whether the player happens to know that.
   *
   * ── Floor / achieved / ceiling ─────────────────────────────────────────
   * Floor: zero illegal edges out of thousands, and at least 20 mantle edges
   * per cave so the band is being USED rather than just avoided. Ceiling by
   * ablation: raising one crate into the dead band must be caught.
   *
   * Drops over 2.4 m are not steps and are not asserted away - falling is the
   * mechanic. They are bounded instead: nothing inside a cave may be a lethal
   * fall.
   */
  const b = await built();
  for (const r of b.reports) {
    assert.equal(r.steps.illegal.length, 0,
      `${r.label}: ${r.steps.illegal.length} adjacent surfaces differ by a height in the `
      + `${STEP_MAX} - ${MANTLE_MIN} m dead band, first `
      + JSON.stringify(r.steps.illegal[0] && {
        dy: +r.steps.illegal[0].dy.toFixed(2),
        cell: r.steps.illegal[0].a.cell,
        from: +r.steps.illegal[0].a.y.toFixed(2),
        to: +r.steps.illegal[0].b.y.toFixed(2),
      }));
    assert.ok(r.steps.mantle >= 20,
      `${r.label} has only ${r.steps.mantle} mantle edges - the climb is not being taught`);
    assert.ok(r.steps.maxDrop < FALL_LETHAL_M,
      `${r.label} has a ${r.steps.maxDrop.toFixed(1)} m drop inside it against a ${FALL_LETHAL_M} m `
      + 'lethal fall');
  }

  // ABLATION: one crate raised into the dead band.
  const plan = normalisePlan({
    ...b.system.caves[0].plan,
    props: b.system.caves[0].plan.props.map((p, i) => (
      i === b.system.caves[0].plan.props.length - 1 ? { ...p, hy: 0.35, y: p.y + 0.15 } : p
    )),
  });
  const physics = new Physics();
  const group = new THREE.Group();
  buildCaveSystem({ physics, group }, [plan]);
  const bad = auditSteps(walkGraph(plan, new SolidField(physics.colliders)));
  assert.ok(bad.illegal.length > 0,
    'a crate 0.70 m tall was not reported as an illegal step - the step probe cannot see the '
    + 'dead band, so its zero on the real caves is worth nothing');
});

/* ================================================================== */
/* AUDIT 4 - reach                                                     */
/* ================================================================== */

test('every mouth and every collectible is a node in one connected component', async () => {
  /* This is R6 written for a cave, and it is the assertion that would have
   * caught the medieval defect class. Every world test in this repo asks
   * whether a thing was BUILT; a thing built inside a sealed chamber is still
   * built, and thirty relics on unreachable rooftops all passed.
   *
   * An edge exists only where a body can go BOTH ways - up by a walk or a
   * mantle, down the same - so a one-way drop into a chamber does not count as
   * reaching it. That is the strict reading and it is the right one: a prize
   * you can fall to and not climb out of is a trap, not a route.
   *
   * ── Floor / achieved / ceiling ─────────────────────────────────────────
   * Floor: one component holding both mouths and all three spots, with every
   * spot within 1.2 m of a walkable node. Ceiling by ablation: the same audit
   * with the mantle band closed must break the component, which proves the
   * connection is really being made by the ledges and not by some accident of
   * the lattice.
   */
  const b = await built();
  for (const r of b.reports) {
    assert.ok(r.reach.connected,
      `${r.label}: mouths and prizes lie in ${new Set([...r.reach.mouths, ...r.reach.spots]
        .map((e) => e.comp)).size} different components of `
      + `${r.reach.components} - ${r.reach.mouths.map((m) => `${m.id}:c${m.comp}`).join(' ')} / `
      + r.reach.spots.map((s) => `${s.tier}:c${s.comp}`).join(' '));
    for (const s of r.reach.spots) {
      assert.ok(s.dist < 1.2,
        `${r.label}: the ${s.tier} collectible is ${s.dist.toFixed(2)} m from the nearest square `
        + 'a body can stand on');
    }
    for (const m of r.reach.mouths) {
      assert.ok(m.dist < 2.5,
        `${r.label}: mouth "${m.id}" is ${m.dist.toFixed(2)} m from anywhere walkable`);
    }
    assert.ok(r.reach.largest / r.graph.nodes.length > 0.98,
      `${r.label}: the main component holds only `
      + `${((r.reach.largest / r.graph.nodes.length) * 100).toFixed(1)}% of the walkable squares`);
  }

  // ABLATION: close the mantle band and the climbs must fall apart.
  for (const cave of b.system.caves) {
    const graph = walkGraph(cave.plan, b.field);
    const steps = auditSteps(graph);
    const walkOnly = { edges: steps.edges.filter(([a, c]) => Math.abs(graph.nodes[a].y - graph.nodes[c].y) <= STEP_MAX) };
    const r = auditReach(cave.plan, graph, walkOnly);
    assert.ok(!r.connected,
      `${cave.plan.label} stays connected with every mantle removed - its climb is decorative, `
      + 'and the reach probe is not proving what it claims to prove');
  }
});

/* ================================================================== */
/* AUDIT 5 - light                                                     */
/* ================================================================== */

/**
 * The control: one medieval cottage lamp in the room it was tuned in.
 *
 * `MedievalWorld._interiorLight` puts a 46-intensity lamp with a
 * `min(16, max(7.5, diag * 0.95))` reach at 2.05 m over a 7.4 x 6.0 m floor,
 * and that room measured 46.8 mean frame luma in a browser - the bright end of
 * the shipped game. Recomputing it here with the SAME proxy the caves are
 * measured with is what makes the cave numbers mean anything: a lux figure on
 * its own is a number with no scale.
 */
function medievalControl() {
  const w = 7.4;
  const d = 6.0;
  const reach = Math.min(16, Math.max(7.5, Math.hypot(w, d) * 0.95));
  const lamp = { position: { x: 0, y: 2.05, z: 0 }, intensity: 46, distance: reach };
  const nodes = [];
  const N = 21;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      nodes.push({
        x: (-0.5 + (i + 0.5) / N) * w, y: 0, z: (-0.5 + (j + 0.5) / N) * d,
      });
    }
  }
  return floorIlluminance({ nodes }, [lamp]);
}

test('the floor of every cave is lit, measured against a shipped room', async () => {
  /* ── What this proxy is ────────────────────────────────────────────────
   * Three's own point-light falloff evaluated on the floor plane: intensity
   * over d squared, windowed exactly as `getDistanceAttenuation` windows it,
   * times the cosine of incidence - summed over the best `RIG_BUDGET.point`
   * lights reaching each square, because twelve is all the rig can put in the
   * scene at once and a figure computed over two hundred is a figure about a
   * game nobody is playing.
   *
   * ── What it is not ────────────────────────────────────────────────────
   * It knows nothing about albedo or about what stands between the lamp and
   * the floor, and a room can score well here and still read as a black box.
   * The medieval interiors did exactly that. The clearance test above is the
   * other half; neither alone found that defect.
   *
   * ── Floor / achieved / ceiling ─────────────────────────────────────────
   * The floor is on the WORST square, not the mean, because the mean is the
   * statistic that hid the medieval defect. Floor: the darkest walkable square
   * in a cave gets at least half what the average square of the control
   * cottage gets. Ceiling by ablation: half the torches removed must push the
   * worst square below the floor, or the lighting has nothing to do with the
   * torches.
   */
  const b = await built();
  const control = medievalControl();
  assert.ok(control.mean > 2 && control.mean < 6,
    `the control cottage computed ${control.mean.toFixed(2)}, which does not match the 3.10 the `
    + 'medieval suite measures for the Guildhall - the proxy has drifted');
  const floor = control.mean * 0.5;

  for (const r of b.reports) {
    assert.ok(r.light.min > floor,
      `${r.label}: its darkest walkable square gets ${r.light.min.toFixed(2)} against a floor of `
      + `${floor.toFixed(2)} (half the control cottage's ${control.mean.toFixed(2)} mean)`);
    assert.ok(r.light.median > control.mean,
      `${r.label}: median floor illuminance ${r.light.median.toFixed(2)} is below the control's `
      + `${control.mean.toFixed(2)} - a cave should not be dimmer than a cottage`);
  }

  // ABLATION: half the torches.
  for (let i = 0; i < b.system.caves.length; i++) {
    const cave = b.system.caves[i];
    const half = cave.lights.filter((_, k) => k % 2 === 0);
    const dim = floorIlluminance(b.reports[i].graph, half);
    assert.ok(dim.min < b.reports[i].light.min,
      `${cave.plan.label} measures the same with half its torches removed `
      + `(${dim.min.toFixed(2)} against ${b.reports[i].light.min.toFixed(2)}) - the illuminance `
      + 'probe is not reading the torches');
  }
});

test('the light budget is spent where a wall cannot reach', async () => {
  /* Measured at the centre of the karst hall's floor: its fourteen wall
   * sconces together deliver 1.10, its nine braziers take that to 20.11. The
   * kit answers a wide chamber with braziers on a grid rather than with a
   * brighter sconce because `1/d^2` from 11 m away cannot be fixed by
   * intensity, and this is the assertion that the threshold between the two is
   * in the right place - by taking the braziers away and watching the middle
   * of the hall go dark, not by looking at it. */
  const b = await built();
  const karst = b.system.caves[1];
  const report = reportOf(b, 'sunken-hall');
  const sconcesOnly = karst.lights.filter((l) => !l.name.endsWith('brazier'));
  assert.ok(sconcesOnly.length < karst.lights.length, 'the karst hall has no braziers at all');
  const dim = floorIlluminance(report.graph, sconcesOnly);
  assert.ok(dim.min < report.light.min * 0.6,
    `removing every brazier changed the darkest square from ${report.light.min.toFixed(2)} to `
    + `${dim.min.toFixed(2)} - the braziers are not what is lighting the hall, so the `
    + 'wide-chamber rule is not earning its place');
});

/* ================================================================== */
/* The claim: 200 torches cost zero new shader programs                */
/* ================================================================== */

test('two hundred cave torches leave the shader light counts bit-identical', async () => {
  /* ── The claim ─────────────────────────────────────────────────────────
   * Design §5.3: "`LightRig` keeps `PointLight`s `visible = false` and copies
   * the twelve best into fixed slots each frame with a 6 Hz re-rank, so 200
   * torches cost zero new shader programs." The instruction with this task was
   * to verify it rather than repeat it.
   *
   * ── How it is measured ────────────────────────────────────────────────
   * Three pushes `numPointLights` and its five siblings into
   * `getProgramCacheKey`, and its GLSL preprocessor UNROLLS the lighting loops
   * against them - so two scenes with the same counts compile the same
   * programs and two scenes with different counts share none. The counts come
   * from `WebGLRenderer.projectObject`, which skips an object AND ITS SUBTREE
   * when `visible === false`; `lightSignature` reproduces that skip rather
   * than using `traverse`, which does not.
   *
   * So the measurement is: build a real rig, add caves until there are more
   * than 200 torches in the scene, run the rig, and compare the tuple. Equal
   * tuple, equal cache key, zero new programs. This is the whole claim and it
   * is the whole test.
   *
   * ── Floor / achieved / ceiling ─────────────────────────────────────────
   * Floor: >= 200 torches and an identical signature. Ceiling by ablation: the
   * same lights made visible must move the signature, which is what says the
   * comparison has any power at all.
   */
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1000);
  const rig = new LightRig({ scene, camera });
  const empty = lightSignature(scene);
  assert.equal(empty.point, RIG_BUDGET.point,
    `an empty scene with a rig in it shows ${empty.point} point lights, not the rig's `
    + `${RIG_BUDGET.point} slots`);

  const physics = new Physics();
  const group = new THREE.Group();
  scene.add(group);
  const plans = [];
  let n = 0;
  for (let i = 0; plans.length < 12; i++) {
    const at = { x: 900 + i * 120, y: 0, z: 900 };
    plans.push(i % 2 ? planMine({ id: `m${i}`, origin: at }) : planKarst({ id: `k${i}`, origin: at }));
  }
  const system = buildCaveSystem({ physics, group }, plans);
  n = system.lights.length;
  assert.ok(n >= 200, `only ${n} torches built - the claim is about two hundred`);

  rig.update(1 / 60);
  const loaded = lightSignature(scene);
  assert.equal(loaded.key, empty.key,
    `${n} cave torches changed the shader light signature from ${empty.key} to ${loaded.key} - `
    + 'every program in the game recompiles');
  assert.equal(loaded.point, RIG_BUDGET.point);
  assert.equal(rig.stats.sources, n,
    `the rig scored ${rig.stats.sources} sources against ${n} torches in the scene - the ones it `
    + 'missed are lights nobody will ever see');

  // ABLATION: the counts have to be able to move, or the equality above is a
  // statement about `lightSignature` and not about the rig.
  for (const l of system.lights) l.visible = true;
  const naive = lightSignature(scene);
  assert.equal(naive.point, RIG_BUDGET.point + n,
    `making the torches visible gave ${naive.point} point lights, expected `
    + `${RIG_BUDGET.point + n} - the signature probe is not counting them`);
  assert.notEqual(naive.key, empty.key);
});

test('a cave torch is born hidden, not hidden on the rig next walk', async () => {
  /* The rig claims a light on its next walk - but the frame between creating a
   * visible light and that walk is a frame in which it counts for the cache
   * key, and one such frame is a full recompile of everything in view.
   * `MazeChunks` learned this and creates its candles `visible = false`. The
   * assertion is on the built lights, not on a regex over the source, because
   * a light created visible and hidden two lines later would pass a regex. */
  const b = await built();
  for (const l of b.system.lights) {
    assert.equal(l.visible, false, `${l.name} was created visible`);
  }
  assert.ok(b.system.lights.length >= 60,
    `only ${b.system.lights.length} torches over two caves - the mine carries 30 and the karst 33`);
  const src = readFileSync(path.join(root, 'src/gfx/LightRig.js'), 'utf8');
  assert.match(src, /point:\s*\d+/, 'the rig no longer declares a fixed point budget');
  assert.match(src, /if \(obj\.visible\) obj\.visible = false;/,
    'the rig no longer hides the lights it claims - every cave torch is back in the count');
});

/* ================================================================== */
/* The other half of "cheaply"                                         */
/* ================================================================== */

test('the doorless descriptor is the shape Interiors reads', async () => {
  /* `Interiors._onWorld` reads `e.doors || []`, `e.lifts || []` and
   * `e.collectibleSpots`, and `Treasures.planForestCaches` proves a descriptor
   * that is nothing but a label and a list of spots is a valid one. That buys
   * the whole streaming path - in at 46 m, out at 64 m, collected state
   * remembered by tag - for a hole in a cliff with no door on it.
   *
   * Asserted against `Interiors`' own source so that the day it starts
   * requiring a door, this goes red here rather than in a play session. */
  const b = await built();
  const src = readFileSync(path.join(root, 'src/systems/Interiors.js'), 'utf8');
  assert.match(src, /e\.doors \|\| \[\]/, 'Interiors no longer tolerates a descriptor with no doors');
  assert.match(src, /const spots = e\.collectibleSpots \|\| \[\]/,
    'Interiors no longer reads collectibleSpots the way the cave descriptor writes them');
  assert.match(src, /SPAWN_R2 = 46 \* 46/, 'the 46 m streaming radius has moved');

  for (const e of b.system.enterables) {
    assert.ok(e.label && e.origin?.isVector3, 'a cave descriptor has no label or origin');
    assert.deepEqual(e.doors, [], 'a cave descriptor grew doors');
    assert.ok(e.collectibleSpots.length >= 3, 'a cave carries fewer than three collectibles');
    for (const s of e.collectibleSpots) {
      assert.ok(s.position?.isVector3 && typeof s.tier === 'string',
        'a collectible spot is not the shape Interiors streams');
    }
    assert.ok(e.cave.mouths.length >= 2,
      `${e.label} publishes ${e.cave.mouths.length} mouths - a world needs every one of them for `
      + 'its approach gate');
  }
});

test('what a cave actually costs', async () => {
  /* ── The claim under test ──────────────────────────────────────────────
   * §5.3 is called "Caves, cheaply". This is the measurement behind the answer
   * in the report: the lighting is free, the colliders and triangles are not,
   * and the rock a cave is carved OUT OF is the part the section does not
   * count - see the heightfield test above.
   *
   * Held as budgets rather than printed, so a future cave that quadruples the
   * collider count fails here. C4's budget for the whole world at 5x is 20,000
   * colliders; a cave taking 1% of that is cheap and a cave taking 10% is a
   * decision somebody has to make on purpose.
   */
  const b = await built();
  const perCave = b.system.colliders.length / b.system.caves.length;
  assert.ok(perCave < 120,
    `${perCave.toFixed(0)} colliders per cave against a 20,000 budget for the whole world at 5x`);
  assert.ok(b.caveMs < 60,
    `${b.caveMs.toFixed(1)} ms to build two caves against C5's 24 ms per slice - a cave has to fit `
    + 'inside a background build slice');

  // Geometry, measured the way C2 measures it: attribute bytes.
  const physics = new Physics();
  const group = new THREE.Group();
  const solo = buildCaveSystem({ physics, group }, [planMine({ id: 'cost' })]);
  const cost = batchCost(solo.caves[0].batch ?? { buckets: new Map() });
  const meshes = solo.caves[0].meshes;
  let tris = 0;
  let bytes = 0;
  for (const m of meshes) {
    const g = m.geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    for (const a of Object.values(g.attributes)) bytes += a.array.byteLength;
    if (g.index) bytes += g.index.array.byteLength;
  }
  assert.ok(meshes.length <= 4,
    `a cave flushed ${meshes.length} meshes - it is meant to merge to one per material`);
  assert.ok(bytes < 2.2 * 1024 * 1024,
    `one mine costs ${(bytes / 1024 / 1024).toFixed(2)} MB of attributes against Citadel's `
    + '28.59 MB total and C2\'s 90 MB budget');
  assert.ok(tris < 14000, `one mine draws ${tris} triangles`);
  assert.ok(cost.triangles === 0, 'the batch should be empty after flush');
});

test('what the heightfield rule costs a site, and the rock that pays for it', async () => {
  /* ── The finding behind §5.3 ───────────────────────────────────────────
   * "Caves, cheaply" is right about the lighting and silent about the rock,
   * and the rock is where the cost is. A cave cannot be carved out of a
   * heightfield, so it has to stand on top of one - which means a site has to
   * be found that is (a) level enough for a one-plane floor and (b) empty, and
   * then the host world owes it a plinth of built rock the size of its
   * footprint and the depth of the terrain relief under it.
   *
   * ── What this asserted before, and why it proved nothing ───────────────
   * `site.relief < 4.0`, against the site this FILE searched for rather than
   * the one the world builds. The shipped Sunken Hall measures 4.72 m of
   * relief, and `liftToClear` answered it the only way it can - by raising the
   * whole rigid plan clear of the highest terrain under it, leaving 3.1 m of
   * daylight under a 38 x 32 m slab and a doorway 4.07 m over the ground
   * outside it. `auditGrounding` reported `buried 0, worst -0.10` throughout,
   * because it floors the buried side only and there is no ceiling at all on
   * how far ABOVE the ground a floor may sit.
   *
   * So relief is no longer the assertion. It is recorded, and what is FLOORED
   * is the two properties a player can feel: no daylight under the slab, and
   * every walk-in mouth reachable by a chain of legal risers.
   *
   * floor    0 columns of air between the terrain and the floor slab;
   *          every riser out of every walk-in mouth <= STEP_MAX
   * achieved  0 columns; worst riser 0.45 m at both mouths
   * ceiling   before `buildPlinth`: 4.82 m of air under the hall over a
   *           38 x 32 m footprint, and a 4.07 m sill at its only walk-in mouth
   */
  const b = await built();
  console.log('\n    cave           relief    lift  plinths  treads  daylight');
  for (const [name, site] of Object.entries(b.sites)) {
    console.log(`    ${name.padEnd(15)}${site.relief.toFixed(2).padStart(5)}  ${site.lift.toFixed(2).padStart(6)}`
      + `${String(site.base.plinths).padStart(8)}${String(site.base.treads).padStart(8)}  ${site.base.gap.toFixed(2)} m`);
    /* 6 m is the ceiling a one-plane floor can be carried over by a plinth
     * without the plinth reading as a wall. The hall's 4.72 m is the worst the
     * world ships and the Quarry Adit's 1.45 m the best; past 6 m the answer is
     * a different cave, not a taller plinth. */
    assert.ok(site.relief < 6.0,
      `the ${name} site has ${site.relief.toFixed(2)} m of terrain relief under its footprint - `
      + 'past 6 m a one-plane floor wants a different cave, not a deeper plinth');
    assert.ok(site.lift > 1.0,
      `the ${name} cave sits at y=${site.lift.toFixed(2)}, which is desert datum - it has been `
      + 'sited out on the flats instead of at its region, and `liftToClear` is untested');
    assert.equal(site.vac.occupied, 0);
    assert.equal(site.vac.mouthBlocked, 0);
    /* The plinth is not decoration: with no rock under it the hall is a stone
     * box hovering over a hillside with a walkable void beneath it. */
    assert.ok(site.base.plinths > 0,
      `${name} built no plinth at all - the rock the site owes was never emitted`);
  }

  /* ---- NO DAYLIGHT UNDER ANY FLOOR SLAB -------------------------------- */
  for (const cave of b.system.caves) {
    const p = cave.plan;
    let open = 0;
    let worst = 0;
    let cols = 0;
    for (const cell of p.cells) {
      /* A cell standing on another cell has a ROOM under it, not a hole. */
      const stacked = p.cells.some((o) => o !== cell && o.floor < cell.floor - 1e-4
        && o.x0 < cell.x1 && o.x1 > cell.x0 && o.z0 < cell.z1 && o.z1 > cell.z0);
      if (stacked) continue;
      const under = p.origin.y + cell.floor - ROCK_T;
      for (let lx = cell.x0 + 0.5; lx < cell.x1; lx += 1) {
        for (let lz = cell.z0 + 0.5; lz < cell.z1; lz += 1) {
          const w = Caves.toWorld(p, lx, 0, lz);
          const g = b.field.terrainAt(w.x, w.z);
          if (g === null) continue;
          cols++;
          let air = 0;
          for (let y = under - 0.05; y > g; y -= 0.2) {
            if (!b.field.solidAt(w.x, y, w.z)) air += 0.2;
          }
          if (air > 0.05) { open++; worst = Math.max(worst, air); }
        }
      }
    }
    console.log(`    ${p.id}: ${cols} ground-standing columns, ${open} with air under the slab, `
      + `worst ${worst.toFixed(2)} m`);
    assert.ok(cols > 300, `${p.id} sampled only ${cols} columns - the probe is not reaching the footprint`);
    assert.equal(open, 0,
      `${p.id} has ${open} columns with up to ${worst.toFixed(2)} m of air between the terrain and `
      + 'its floor slab - the cave is floating and a body can walk underneath it');
  }

  /* ---- EVERY WALK-IN MOUTH IS ACTUALLY A WALK -------------------------- */
  for (const cave of b.system.caves) {
    const p = cave.plan;
    const cs = Math.cos(p.yaw);
    const sn = Math.sin(p.yaw);
    for (const m of p.mouths) {
      const F = Caves.FACE_AXES[m.face];
      if (F.n === 'y') continue;
      const cell = p.cellById.get(m.cell);
      const sill = p.origin.y + cell.floor;
      const ln = { x: 0, z: 0 };
      ln[F.n] = F.s;
      const wx = ln.x * cs + ln.z * sn;
      const wz = -ln.x * sn + ln.z * cs;
      /* Walk outward on the mouth's own normal and take the top of whatever is
       * under each sample, started just over the sill so the cave's own roof is
       * never mistaken for the ground. */
      let prev = sill;
      let worst = 0;
      let at = 0;
      for (let d = 0.3; d <= 12; d += 0.3) {
        const x = m.position.x + wx * d;
        const z = m.position.z + wz * d;
        let top = null;
        for (let y = sill + 0.5; y > sill - 12; y -= 0.05) {
          if (b.field.solidAt(x, y, z)) { top = y; break; }
        }
        if (top === null) break;
        if (Math.abs(top - prev) > worst) { worst = Math.abs(top - prev); at = d; }
        prev = top;
      }
      console.log(`    ${p.id} mouth ${m.id}: sill ${sill.toFixed(2)}, worst riser out to 12 m `
        + `${worst.toFixed(2)} m at ${at.toFixed(1)} m`);
      assert.ok(worst <= STEP_MAX + 0.06,
        `${p.id}: leaving "${m.id}" crosses a ${worst.toFixed(2)} m riser ${at.toFixed(1)} m from the `
        + `doorway, against a ${STEP_MAX} m step - it is not a walk-in mouth`);
    }
  }

  // ABLATION: the vacancy probe must be able to say no. Put the mine on the
  // mesa, where the citadel is, and it has to reject the site.
  const onTheTown = normalisePlan({ ...b.system.caves[0].plan, id: 'ontown', origin: { x: 0, y: 14, z: 0 } });
  const vac = auditVacancy(onTheTown, b.field, { step: 2.0 });
  assert.ok(vac.occupied + vac.mouthBlocked > 20,
    `a cave placed on top of the inner ward reported ${vac.occupied} occupied samples and `
    + `${vac.mouthBlocked} blocked mouth samples - the vacancy probe cannot see a building, so `
    + 'the sites it approved were not approved by anything');
});

/**
 * The SEARCH, which is a different claim from the caves the world ships.
 *
 * `siteFor` is what a world reaches for when it has a region anchor and no
 * authored coordinate, and the property worth holding is that one exists: a
 * level, empty, on-sheet site near both anchors. It is deliberately NOT run
 * against the shipped sites - `auditVacancy` refuses those, because the
 * world's own caves are already standing in them, which is exactly how this
 * file came to audit two caves nobody builds.
 */
test('a level, empty site can still be found near both region anchors', async () => {
  const b = await built();
  const scout = new SolidField(b.physics.colliders);
  const cases = [
    ['mine', REGIONS.mine, (o) => planMine({ id: 'scout-mine', label: 'scout', ...o })],
    ['karst', REGIONS.karst, (o) => planKarst({ id: 'scout-karst', label: 'scout', ...o })],
  ];
  for (const [name, anchor, make] of cases) {
    const site = siteFor(make, anchor, scout);
    console.log(`    ${name}: found at (${site.origin.x.toFixed(1)}, ${site.origin.z.toFixed(1)}) `
      + `yaw ${site.yaw.toFixed(2)}, relief ${site.relief.toFixed(2)} m, lift ${site.lift.toFixed(2)} m, `
      + `${site.distance.toFixed(0)} m from the anchor`);
    assert.ok(site.relief < 2.5, `the best ${name} site has ${site.relief.toFixed(2)} m of relief`);
    assert.equal(site.vac.occupied, 0);
    assert.equal(site.vac.mouthBlocked, 0);
  }
});

test('the audits agree the authored caves are sound', async () => {
  /* The roll-up. Every constituent assertion above is made on its own with its
   * own ablation; this one exists so that a new cave added to `citadelCaves`
   * cannot ship without passing all of them at once, and so the report has a
   * single line to quote. */
  const b = await built();
  for (const r of b.reports) {
    assert.ok(r.ok, `${r.label} failed its audit: `
      + JSON.stringify({
        buried: r.grounding.buried, leaks: r.seal.leaks.length,
        blockedMouths: r.seal.blockedMouths.length, illegal: r.steps.illegal.length,
        connected: r.reach.connected, spans: r.spans.length,
      }));
  }
  // And the authored set for the ring builds and normalises without throwing,
  // which is the only thing that can be said about it until a world places it.
  const set = citadelCaves();
  assert.equal(set.length, 4);
  for (const p of set) {
    assert.ok(p.mouths.length >= 2, `${p.id} has one way in and no way out`);
    assert.ok(p.lights.length > 20, `${p.id} carries only ${p.lights.length} lights`);
    assert.ok(p.origin.y >= 0,
      `${p.id} is anchored at y=${p.origin.y} - Citadel's desert floor collider tops out at 0 and `
      + 'anything below it is inside a solid box');
  }
});
