import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/**
 * THE COMPARTMENTS ARE NOT FULL OF THE STRUCTURE THAT DESCRIBES THEM.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE FULL-PLAN-BOX FAMILY, AND WHY IT IS THE YARD'S TURN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is the fourth occurrence of one defect. Medieval plank courses,
 * medieval string courses, medieval bressumers and the station tower's string
 * course were all authored the same way: a member that ought to be four short
 * pieces, one per wall, written instead as ONE box the size of the whole plan.
 * On a shed it is invisible. Inside a room it is a slab of boarding hanging
 * through the middle of it, and it accounted for 251 of 407 z-fighting hits
 * and one sealed atrium.
 *
 * It is now the yard's turn twice over. The site office has a course of
 * pigeonholes and a lamp gantry; the four ships the next stage hangs on these
 * cradles are made of NOTHING BUT the members that trigger it - frames,
 * stringers, deck beams and cable trays.
 *
 * ── Why a headroom probe cannot find it ───────────────────────────────────
 * The medieval headroom test correctly reported 2.85 m of clear height above a
 * room you could not see across, because these members HAVE NO COLLIDERS and
 * a headroom test probes colliders. So this measures GEOMETRY: every drawn
 * part inside an interior, flagged when its footprint covers half the room AND
 * it sits between the floor and the ceiling without being the ceiling.
 *
 * ── And why the light half is here too ────────────────────────────────────
 * "Neither alone would have found the defect." The two medieval rooms reported
 * as too dark were AHEAD of the controls on floor illuminance - 5.17 and 4.59
 * against 3.10 and 3.29 - while measuring 28.0 and 23.4 mean luma, and the
 * GEOMETRY fix alone took them to 50.9 and 41.7 with no change to any light in
 * the game. What was between the lamp and the floor was the defect. So the
 * declared-lighting half is asserted here beside the clearance half, off the
 * DESCRIPTOR rather than by walking the scene - "a stray point light forty
 * metres away in the street would satisfy a proximity test while lighting
 * nothing".
 *
 * The second half of the second half - mean frame luma rendered inside each
 * space - needs a real renderer and is not available under `node --test`. It
 * is the dev harness's job (`VIEWS.dock` publishes `office-inside` for exactly
 * this) and is recorded here as the measurement this file does NOT take.
 */

function harness() {
  if (globalThis.__dockInteriorsHarness) return;
  globalThis.__dockInteriorsHarness = true;
  class Img {
    constructor(a, b, c) {
      if (typeof a === 'number') { this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4); }
      else { this.data = a; this.width = b; this.height = c ?? 1; }
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
    createElement(tag) { const c = { width: 1, height: 1, style: {}, tagName: tag }; c.getContext = () => context2d(c); return c; },
    createElementNS(_ns, tag) { return this.createElement(tag); },
  };
  globalThis.window = globalThis;
  globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return context2d(this); } };
  const dead = () => ({ texture: null, dispose() {} });
  THREE.PMREMGenerator.prototype.fromEquirectangular = dead;
  THREE.PMREMGenerator.prototype.fromScene = dead;
  THREE.PMREMGenerator.prototype.compileEquirectangularShader = () => {};
}

harness();
const { Physics } = await import('../../src/physics/Physics.js');
const { DockWorld } = await import('../../src/worlds/DockWorld.js');
const { OFFICE, APRON_Z } = await import('../../src/worlds/dock/YardPlan.js');
const { RIG_BUDGET } = await import('../../src/gfx/LightRig.js');

let _built = null;
async function built() {
  if (_built) return _built;
  const physics = new Physics();
  const world = new DockWorld({
    physics,
    scene: new THREE.Scene(),
    bus: { on: () => () => {}, emit() {} },
    engine: {
      renderer: {
        capabilities: { getMaxAnisotropy: () => 4, isWebGL2: true },
        initTexture() {}, getContext: () => ({}),
        getRenderTarget: () => null, setRenderTarget() {}, render() {}, clear() {},
      },
      onFrameUpdate: () => () => {}, onResize: () => () => {},
    },
    /* `getEnvMap` returns a MARKER rather than a texture: the reflection probe
     * is a real PMREM bake in the browser and there is no renderer here, but
     * whether the world asks for one at all - and for which mood - is exactly
     * the thing that was silently missing. See the last test in this file. */
    materials: {
      get: () => new THREE.MeshStandardMaterial(),
      getEnvMap: (mood) => ({ __probe: mood }),
      dispose() {},
    },
  });
  world.physics = physics;
  await world.build(() => {});
  world.group.updateMatrixWorld(true);
  _built = { world, physics };
  return _built;
}

/**
 * Every drawn triangle inside a box, as world-space AABBs of contiguous runs.
 *
 * The interiors are MERGED - one mesh per material key per batch - so there is
 * no per-part object left to measure once the batch has flushed. Walking the
 * merged buffer and clustering triangles by contiguity recovers the parts:
 * `GeoBatch` appends each part's geometry whole, so a run of consecutive
 * triangles that never jumps in space IS a part. That is exactly what makes
 * the medieval version of this test work on a merged world.
 */
function partsInside(root, box) {
  const parts = [];
  const v = new THREE.Vector3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh) return;
    const geo = o.geometry;
    const pos = geo?.attributes?.position;
    if (!pos) return;
    const idx = geo.index;
    const count = idx ? idx.count : pos.count;
    let cur = null;
    for (let i = 0; i < count; i += 3) {
      const tri = new THREE.Box3();
      for (let k = 0; k < 3; k++) {
        const vi = idx ? idx.getX(i + k) : i + k;
        v.fromBufferAttribute(pos, vi).applyMatrix4(o.matrixWorld);
        tri.expandByPoint(v);
      }
      if (!box.intersectsBox(tri)) { cur = null; continue; }
      /* A new part starts wherever this triangle does not touch the run so
       * far. 0.2 m of slack, because a box's six faces share edges but a
       * SEPARATE member in the same merge does not. */
      if (cur && cur.box.distanceToPoint(tri.min) < 0.2 && cur.box.distanceToPoint(tri.max) < 0.2) {
        cur.box.union(tri);
      } else {
        cur = { box: tri.clone() };
        parts.push(cur);
      }
    }
  });
  return parts.map((p) => p.box);
}

/* ====================================================================== */

test('the probe sees the office, and the office is where the plan says', async () => {
  /* THE GUARD. A part-finder that stopped finding parts would report zero
   * offenders and this file would go green by measuring nothing. */
  const { world } = await built();
  const office = world.enterables.find((e) => e.label === 'yard-office');
  assert.ok(office, 'no site office');
  const box = new THREE.Box3(
    new THREE.Vector3(OFFICE.x - OFFICE.w / 2, 0, OFFICE.z - OFFICE.d / 2),
    new THREE.Vector3(OFFICE.x + OFFICE.w / 2, OFFICE.h, OFFICE.z + OFFICE.d / 2)
  );
  const parts = partsInside(world.group, box);
  assert.ok(parts.length >= 8,
    `only ${parts.length} drawn parts inside the site office - the part finder has stopped working`);
  assert.ok(office.floorY > 0 && office.ceilY > 2.4, 'the office publishes no floor or ceiling height');
});

test('nothing spans the office and hangs in the middle of it', async () => {
  /* The rule, ported from `medieval-approach.test.mjs:595-668`. A part is an
   * offender when ALL FOUR hold:
   *
   *   foot >= area * 0.5      it covers half the room in plan
   *   maxY > floorY + 0.15    it is not the floor
   *   minY < ceilY - 0.06     it is not the ceiling
   *   maxY < ceilY            ...and this last clause is what exempts the
   *                           SHELL, which spans the plan and carries on up
   *
   * Without that fourth clause the roof slab and every wall would be flagged,
   * and a test that flags the building it is measuring gets deleted rather
   * than fixed. The medieval run found 130 slabs. */
  const { world } = await built();
  const office = world.enterables.find((e) => e.label === 'yard-office');
  const floorY = office.floorY;
  const ceilY = office.ceilY;
  const box = new THREE.Box3(
    new THREE.Vector3(OFFICE.x - OFFICE.w / 2 + 0.3, floorY, OFFICE.z - OFFICE.d / 2 + 0.3),
    new THREE.Vector3(OFFICE.x + OFFICE.w / 2 - 0.3, ceilY, OFFICE.z + OFFICE.d / 2 - 0.3)
  );
  const area = (OFFICE.w - 0.6) * (OFFICE.d - 0.6);
  const offenders = [];
  let widest = 0;
  for (const p of partsInside(world.group, box)) {
    const w = Math.min(p.max.x, box.max.x) - Math.max(p.min.x, box.min.x);
    const d = Math.min(p.max.z, box.max.z) - Math.max(p.min.z, box.min.z);
    const foot = Math.max(0, w) * Math.max(0, d);
    widest = Math.max(widest, foot / area);
    if (foot < area * 0.5) continue;
    if (p.max.y <= floorY + 0.15) continue;
    if (p.min.y >= ceilY - 0.06) continue;
    if (p.max.y >= ceilY) continue;
    offenders.push(`a part ${w.toFixed(1)} x ${d.toFixed(1)} m spanning ${(foot / area * 100) | 0}% of the plan, `
      + `from y ${p.min.y.toFixed(2)} to ${p.max.y.toFixed(2)}, in a room whose floor is ${floorY} and ceiling ${ceilY}`);
  }
  assert.deepEqual(offenders, [],
    `${offenders.length} full-plan members hanging inside the site office:\n  ` + offenders.join('\n  '));
  /* Quoted rather than merely asserted, so the margin is visible: the widest
   * thing between the floor and the ceiling covers this fraction of the plan,
   * and the rule fires at 0.50. */
  assert.ok(widest < 0.5,
    `floor: nothing over 50% of the plan. achieved: the widest interior member covers ${(widest * 100).toFixed(1)}%`);
});

test('a body can see across the office at head height', async () => {
  /* The complement of the rule above, and the thing the rule is a proxy for.
   * Fire rays across the room at eye height and demand they arrive: the
   * medieval version of this failed because the first thing over a head was
   * plank at 1.66 m in a room with a 2.85 m ceiling. */
  const { world } = await built();
  const EYE = 1.62;
  const parts = partsInside(world.group, new THREE.Box3(
    new THREE.Vector3(OFFICE.x - OFFICE.w / 2 + 0.35, EYE - 0.25, OFFICE.z - OFFICE.d / 2 + 0.35),
    new THREE.Vector3(OFFICE.x + OFFICE.w / 2 - 0.35, EYE + 0.25, OFFICE.z + OFFICE.d / 2 - 0.35)
  ));
  /* Anything at eye height is allowed to exist - a shelf, a plan chest, a
   * drawing board - so what is measured is how much of the PLAN it occupies.
   * A room whose eye-height band is a third full is furnished; one that is
   * three quarters full is boarded up. */
  let occupied = 0;
  for (const p of parts) occupied += (p.max.x - p.min.x) * (p.max.z - p.min.z);
  const area = (OFFICE.w - 0.7) * (OFFICE.d - 0.7);
  const frac = occupied / area;
  assert.ok(frac < 0.35,
    `floor: under 35% of the plan blocked at eye height. achieved: ${(frac * 100).toFixed(1)}% `
    + `(${parts.length} parts in the 1.37-1.87 m band)`);
});

test('every interior declares its own lighting, and the lamp is over the floor', async () => {
  /* Asserted off the DESCRIPTOR and not by walking the scene, for the reason
   * `medieval-approach.test.mjs:396-399` records: "a stray point light forty
   * metres away in the street would satisfy a proximity test while lighting
   * nothing". A room's lighting is a thing the room CLAIMS, and the claim is
   * what a later change has to keep. */
  const { world } = await built();
  const office = world.enterables.find((e) => e.label === 'yard-office');
  assert.ok(Array.isArray(office.lights) && office.lights.length >= 1,
    'the site office declares no lighting at all');
  let illum = 0;
  for (const l of office.lights) {
    assert.ok(Math.abs(l.x - OFFICE.x) < OFFICE.w / 2 && Math.abs(l.z - OFFICE.z) < OFFICE.d / 2,
      `a declared office light at (${l.x}, ${l.z}) is outside the office`);
    assert.ok(l.y > 1.8 && l.y < OFFICE.h, `a declared office light at y ${l.y} is not on the ceiling`);
    // Inverse-square at the floor directly under it, which is the brightest
    // point in the room and therefore the least generous test of the claim.
    const h = l.y - office.floorY;
    illum += l.intensity / (h * h);
  }
  assert.ok(illum >= 3.3,
    `floor: 3.3 (the medieval controls measured 3.10 and 3.29 and were the acceptable ones). `
    + `achieved: ${illum.toFixed(2)} at the office floor`);

  /* And the light is REAL as well as declared: there is an actual PointLight
   * in the world group at the declared position, it does not cast shadows -
   * `RIG_BUDGET` has two shadowed directional slots for the whole game - and
   * the emissive luminaire that gives it a visible cause is there too. A
   * declared light with no light is a claim; a light with no luminaire is a
   * glow with no cause. */
  const lights = [];
  world.group.traverse((o) => { if (o.isPointLight) lights.push(o); });
  /* ── The budget is DENSITY, not a headcount, and that is a re-measurement ──
   * The design wrote "<= 10 motivated practicals". Drop one shipped 9 and the
   * three fitted hulls need 7 more, because a walk-in hold with no lamp of its
   * own is lit by ambient and reads as a cave.
   *
   * What actually costs is the SLOT count, which is baked into every shader in
   * the game: `RIG_BUDGET.point` is unchanged at 12, and 16 lights measured
   * 1567 ms of compile against 12's 1224 and 8's 889. The authored count is not
   * that number. `LightRig` scores every source by attenuation at the camera
   * and keeps the best twelve — the station authors 65 and only 7 reach the
   * player at its spawn, which is the densest lighting in the game.
   *
   * So the assertion that keeps the shader cost honest is a LOCAL one: no more
   * than eight sources within 20 m of any other, which is the radius over which
   * they compete for the same twelve slots. 20 m rather than the largest
   * `distance` (14 m) so a lamp just outside its own falloff still counts. */
  /* THE HEADCOUNT CAP IS GONE, and its removal is the point of the paragraph
   * above rather than a relaxation of it. Capping the authored count at 18 was
   * the same misreading of `RIG_BUDGET` a second time, and it cost the yard its
   * floor: eight bay practicals over 27,864 m2 measured a MEDIAN floor
   * illuminance of 0.005 with 237 of 272 sample points under 0.05, against the
   * station's hub deck at 0.271 from 222 authored sources. See
   * `dock-light.test.mjs`, which measures the floor rather than counting the
   * lamps over it. What survives here is the local density rule, which is the
   * one that maps onto the twelve slots the shaders actually pay for. */
  /* ── AND THE BALL COUNT IS GONE TOO, FOR THE SAME REASON AND WITH THE SAME
   *    KIND OF EVIDENCE ──────────────────────────────────────────────────
   * It was "no more than eight sources within 20 m of any other". That is a
   * PROXY for the thing the slots actually cost, and it is a bad one: it
   * counts a 26 cd high-bay pendant 19 m away the same as a 13 cd washer
   * 1.5 m off the bulkhead you are looking at. It was also unsatisfiable by
   * anything that fixes what the yard shipped with — the Dray is 28 m with
   * three lit compartments standing under a 24 m lamp grid, so its own three
   * deckhead lamps plus one berth lamp plus three bay lamps is seven before a
   * single flank bracket or wall washer exists.
   *
   * What the twelve slots actually cost is the irradiance carried by the
   * sources that DO NOT get one. `LightRig._score` ranks every source by its
   * attenuation at the camera and keeps the best `RIG_BUDGET.point`, so the
   * loss at a point is the tail of that ranking — which is measurable exactly,
   * in the same units and with the same falloff the standard shader uses.
   *
   * Measured over 335 probes on this tree — every enterable at eye height,
   * every framing in `VIEWS.dock`, and a 10 m floor grid over the whole bay —
   * the worst point loses **2.83%** of its irradiance beyond the twelfth
   * source, and it is a square of open floor at (10, -60) whose tail is
   * high-bay pendants 25-40 m away. Every compartment interior loses under
   * 0.01%: inside a hull the hull's own fittings are the twelve.
   *
   * The ball count survives only as a cheap authoring guard against somebody
   * stacking a hundred lamps in one room, at the density this world actually
   * builds (13, at the Dray) plus headroom. */
  assert.ok(lights.length >= 1,
    'the yard authors no point lights at all');
  const SLOTS = RIG_BUDGET.point;
  const lum709 = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const src = lights.map((l) => ({
    p: l.getWorldPosition(new THREE.Vector3()),
    i: l.intensity * lum709(l.color), d: l.distance ?? 0, k: l.decay ?? 2,
  }));
  const lostAt = (p) => {
    const c = [];
    for (const s of src) {
      const d = s.p.distanceTo(p);
      if (d < 1e-3 || (s.d > 0 && d > s.d)) continue;
      let w = 1;
      if (s.d > 0) { const t = Math.min(1, (d / s.d) ** 4); w = Math.max(0, 1 - t) ** 2; }
      c.push(s.i * (1 / d ** s.k) * w);
    }
    c.sort((a, b) => b - a);
    const tot = c.reduce((a, b) => a + b, 0);
    if (tot <= 0) return 0;
    return (100 * c.slice(SLOTS).reduce((a, b) => a + b, 0)) / tot;
  };
  const probes = [];
  for (const e of world.enterables) {
    const o = e.origin ?? new THREE.Vector3(e.x ?? 0, 0, e.z ?? 0);
    probes.push([`inside ${e.label}`, new THREE.Vector3(o.x, (e.floorY ?? 0) + 1.6, o.z)]);
  }
  for (let x = -90; x <= 90; x += 10) {
    for (let z = -100; z <= 55; z += 10) probes.push([`floor ${x},${z}`, new THREE.Vector3(x, 1.6, z)]);
  }
  assert.ok(probes.length > 300, `only ${probes.length} probes - the grid is too coarse to mean anything`);
  let worst = ['', 0];
  for (const [label, p] of probes) { const v = lostAt(p); if (v > worst[1]) worst = [label, v]; }
  assert.ok(worst[1] <= 4.0,
    `ceiling: 4% of the irradiance at any probe may fall outside the ${SLOTS} rig slots. `
    + `achieved: ${worst[1].toFixed(2)}% at ${worst[0]} - the rig will drop a source that is `
    + 'actually lighting something, and it will read as a lamp going out as the camera moves');
  let densest = 0;
  for (const a of lights) {
    let n = 0;
    for (const b of lights) if (a.position.distanceTo(b.position) <= 20) n++;
    densest = Math.max(densest, n);
  }
  assert.ok(densest <= 16,
    `ceiling: 16 sources within 20 m as an authoring guard - the measured density of this `
    + `world is 13, at the Dray. achieved: ${densest} (of ${lights.length} authored). `
    + 'The rule that matters is the slot-loss one above, not this one');
  for (const l of lights) {
    assert.equal(l.castShadow, false,
      'an authored practical casts shadows - the rig has two shadowed slots for the entire game');
  }
  const near = lights.find((l) => Math.abs(l.position.x - OFFICE.x) < 1.5 && Math.abs(l.position.z - OFFICE.z) < 1.5);
  assert.ok(near, 'the site office declares a light and the world builds none there');

  /* Every enterable in the world makes the same claim the office does, and the
   * world honours it. Written as a loop over `world.enterables` rather than
   * against the office alone, because the three fitted hulls are enterables
   * too and a hull whose hold declares no lamp is a 9 m room lit by ambient. */
  for (const e of world.enterables) {
    if (!e.doors?.length && !e.lifts?.length) continue;   // the trench stash has neither
    assert.ok(Array.isArray(e.lights) && e.lights.length >= 1,
      `${e.label} can be entered and declares no lighting at all`);
    let lit = 0;
    for (const l of e.lights) {
      const h = l.y - (l.floorY ?? e.floorY ?? 0);
      assert.ok(h > 0.8, `${e.label}: a declared light sits ${h.toFixed(2)} m over its own floor`);
      /* PER LIGHT as well as in total. Compartments get one fitting each, so a
       * sum lets a bright hold carry a dark cockpit - and the two medieval
       * rooms that measured 28.0 and 23.4 mean luma were AHEAD of the controls
       * on total floor illuminance while being the dark ones. */
      const own = l.intensity / (h * h);
      assert.ok(own >= 1.5,
        `floor: 1.5 per fitting. achieved: a declared light in ${e.label} puts ${own.toFixed(2)} on the floor under it`);
      lit += own;
      const real = lights.find((p) => p.position.distanceTo(new THREE.Vector3(l.x, l.y, l.z)) < 0.05);
      assert.ok(real, `${e.label} declares a light at (${l.x.toFixed(1)}, ${l.y.toFixed(1)}, ${l.z.toFixed(1)}) and the world builds none there`);
    }
    assert.ok(lit >= 3.3,
      `floor: 3.3 (the medieval controls measured 3.10 and 3.29 and were the acceptable rooms). `
      + `achieved: ${lit.toFixed(2)} at ${e.label}'s floor`);
  }

  /* Every practical is hung at 9 m or is an interior lamp - never at 5 m.
   * `StationWorld.js:9731`: 1050 cd at 5 m is eight times the bloom
   * threshold, and a bay of those is a frame of white discs.
   *
   * ── AND THE HEIGHT IS A PROXY FOR THE INTENSITY, SO SAY BOTH ─────────────
   * What blows out is `intensity`, not `y`: the sentence this rule is quoting
   * says "1050 cd at 5 m". A bare height test therefore bans the one fitting a
   * yard actually needs at hull height - a bracket aimed sideways across a
   * flank - while permitting a 1050 cd bare bulb at 9 m. The yard's own
   * catwalk brackets have been 12 cd at 10.5 m since drop one and read as
   * fittings rather than discs, so `LOW_CD` is set just over them: a practical
   * below the bay may hang low only if it is no brighter than the fitting this
   * world already proved at eye level. The berth flank brackets
   * (`DockWorld._buildLights`) are 14 cd at 5.5 m, which is 0.075 of the 1050
   * the warning is about. */
  /* ── ...AND THE PIERS HAVE NO ROOF TO HANG ANYTHING FROM ─────────────────
   * A flat `LOW_CD` was the right shape of rule for a shed: everything in
   * there hangs off a truss at 9 m, and the exceptions were two brackets. Five
   * piers running out into vacuum cannot obey it at all. There is nothing over
   * a pier to hang a lamp from, so a pier lamp stands on a 4.9 m post — and at
   * 16 cd a post lamp delivers 0.66 to the deck under it against a bay lamp's
   * 0.38, which sounds fine and is not: nothing else on a pier is lit, so
   * every candela that misses the 6.8 m walkway is gone into space and there
   * is no second surface in the shot.
   *
   * So the rule is stated in the units the warning it quotes is actually in.
   * `StationWorld.js:9731` is about BLOWOUT — "1050 cd at 5 m is eight times
   * the bloom threshold" — and what blows out is the illuminance a fitting
   * puts on the surface under it, `intensity / y^2`. Measured across this
   * world: bay lamp 31 cd at 9 m = 0.38; berth flank bracket 14 at 5.5 = 0.46;
   * catwalk bracket 12 at 2.5 m over its own deck = 1.92; pier lamp 30 at 4.4
   * = 1.55. The station's warning case is 1050 at 5 m = 42.
   *
   * `LOW_E` is 2.0 - just over the catwalk bracket, which this world has shipped
   * since drop one and which reads as a fitting rather than as a disc. The old
   * `LOW_CD` clause stays as an alternative so nothing that passed before this
   * fails now. */
  const LOW_CD = 16;
  const LOW_E = 2.0;
  const interiors = world.enterables.filter((e) => Array.isArray(e.lights) && e.lights.length);
  for (const l of lights) {
    const inInterior = interiors.some((e) =>
      e.lights.some((d) => l.position.distanceTo(new THREE.Vector3(d.x, d.y, d.z)) < 0.05));
    const inTrench = l.position.y < 0;
    const e = l.intensity / Math.max(0.25, l.position.y * l.position.y);
    assert.ok(inInterior || inTrench || l.position.y >= 8.5 || l.intensity <= LOW_CD || e <= LOW_E,
      `a bay practical hangs at y ${l.position.y.toFixed(2)} at ${l.intensity} cd - that is `
      + `${e.toFixed(2)} on the deck under it against a ceiling of ${LOW_E} (the catwalk bracket, `
      + `1.92, is the brightest this world has shipped low). The yard's own lamps are at 9 m for a `
      + 'reason, and this one is neither high, dim, in the trench, nor inside a declared interior');
  }
});

test('the interior is LOD-banded and its colliders are not', async () => {
  /* `station/Tower.js:501-521`, re-decided rather than inherited. The
   * station's "no LOD outside interiors" is a reasoned trade for one
   * continuous deck; a yard of walk-in hulls is the tower case, and the site
   * office is the first of them.
   *
   * COLLIDERS ARE NEVER SPLIT, and that is the half that matters: a player
   * walking in must never fall through a floor that has not faded up yet,
   * because the floor was never the thing being faded. */
  const { world, physics } = await built();
  assert.ok(world._lod, 'the yard has no DistanceLod');
  assert.ok(world._lod.entries.length >= 1,
    'nothing is registered with the LOD - the office fit-out is drawn from across the yard');
  for (const e of world._lod.entries) {
    assert.ok(e.object?.isMesh, 'a non-mesh is registered with the distance LOD');
  }
  /* The office floor is solid whatever the LOD is doing, and this is asserted
   * on the office's OWN collider rather than on the ground height.
   *
   * `groundHeight` was the obvious probe and it is the wrong one: the office
   * stands on the apron pad, which is also solid and also 0.1 m proud of the
   * deck, so deleting the office floor entirely left the probe reading a
   * plausible number off the pad underneath. A mutation run caught it - the
   * assertion measured the ground under the building rather than the
   * building's floor. What has to exist is a collider whose top IS the
   * interior deck. */
  const { world: w2 } = await built();
  const office = w2.enterables.find((e) => e.label === 'yard-office');
  const floor = physics.colliders.filter((c) => c && c.type === 'box'
    && Math.abs(c.matrix.elements[12] - OFFICE.x) < 0.4
    && Math.abs(c.matrix.elements[14] - OFFICE.z) < 0.4
    && Math.abs((c.matrix.elements[13] + c.halfExtents.y) - office.floorY) < 0.03
    && c.halfExtents.x > OFFICE.w / 2 - 0.5);
  assert.equal(floor.length, 1,
    `${floor.length} colliders top out at the office's own floor height of ${office.floorY} - `
    + "the fit-out and the floor have been LOD'd together, or the floor was never collided");
  // ...and it is not coplanar with the apron pad it stands on, which is a
  // z-fight, not a floor.
  const under = new Physics();
  for (const c of physics.colliders) if (c) under.add(c);
  const outside = under.groundHeight(OFFICE.x + OFFICE.w, OFFICE.z, 3, 8);
  assert.ok(outside !== null && office.floorY - outside > 0.05,
    `the office floor is ${(office.floorY - outside).toFixed(3)} m over the pad it stands on - `
    + 'two opaque surfaces in one plane is a z-fight');
  assert.ok(office.floorY - outside < 0.45,
    'the office floor is a step the player has to climb rather than walk over');

  /* And the DRAWN floor is where the collided one is.
   *
   * The two are written on adjacent lines and are trivially easy to move
   * apart, and the failure is the worst-looking kind: a floor you stand a
   * hand's width above or sink a hand's width into. Measured against the
   * merged geometry, because that is the thing the player sees. */
  const slab = partsInside(w2.group, new THREE.Box3(
    new THREE.Vector3(OFFICE.x - 1.5, office.floorY - 0.5, OFFICE.z - 1.5),
    new THREE.Vector3(OFFICE.x + 1.5, office.floorY + 0.02, OFFICE.z + 1.5)
  ));
  const top = Math.max(-Infinity, ...slab.map((p) => p.max.y));
  assert.ok(Math.abs(top - office.floorY) < 0.03,
    `the office is DRAWN with its floor at ${top.toFixed(3)} and COLLIDED at ${office.floorY} - `
    + 'a player standing in it is either floating or sunk');
});

/* ================================================================== */
/* Drawn where it can be SEEN                                          */
/* ================================================================== */

test('the office windows are holes in the wall, not glass inside it', async () => {
  /* The defect this was written for, measured before the fix: the two side
   * walls were unbroken slabs at `o.z ± (hd - T/2)`, occupying z 36.500-36.720
   * and 43.280-43.500 over the full 0-3.2 m height, and the glazing was drawn
   * at `o.z ± (hd - T*0.4)` - z 36.588 and 43.412, i.e. 88 mm INSIDE opaque
   * plating. Eight sightlines from the office at eye height came back blocked
   * at 3.28-4.64 m, every one but the doorway. The world's one proved
   * enterable was a windowless box whose own comment said it was "lit and
   * legible from the yard", and both window rails were buried with it.
   *
   * The instrument is a ray rather than a collider test, because the claim is
   * about what a player SEES: from the yard, and from the desk inside, the
   * first thing on the line through the window has to be glass. */
  const { world } = await built();
  const ray = new THREE.Raycaster();
  ray.near = 0;
  ray.far = 14;
  const hd = OFFICE.d / 2;
  const looks = [];
  for (const s of [-1, 1]) {
    // From the yard, in.
    looks.push([`from the yard at z ${(OFFICE.z + s * 6).toFixed(0)}`,
      new THREE.Vector3(OFFICE.x, 1.9, OFFICE.z + s * 6), new THREE.Vector3(0, 0, -s)]);
    // From the office, out.
    looks.push([`from the desk toward ${s > 0 ? '+z' : '-z'}`,
      new THREE.Vector3(OFFICE.x, 1.9, OFFICE.z), new THREE.Vector3(0, 0, s)]);
  }
  const blocked = [];
  for (const [label, from, dir] of looks) {
    ray.set(from, dir);
    const hit = ray.intersectObject(world.group, true).find((h) => h.object.visible);
    if (!hit) { blocked.push(`${label}: nothing at all on the line - the window is not drawn`); continue; }
    if (!/glass/.test(hit.object.name)) {
      blocked.push(`${label}: the first thing on the line is ${hit.object.name} at ${hit.distance.toFixed(2)} m`);
    }
  }
  assert.deepEqual(blocked, [],
    `${blocked.length} of ${looks.length} sightlines through the office windows are blocked:\n  ` + blocked.join('\n  '));

  /* ...and the opening is GLAZED, not open. A 3.4 x 1.4 m hole with a 1.2 m
   * sill is a second, unintended way into the one interior this drop proves,
   * so the pane carries a collider of its own and the wall stays sealed. */
  const { physics } = await built();
  for (const s of [-1, 1]) {
    const z = OFFICE.z + s * (hd - 0.11);
    const solid = physics.colliders.filter((c) => c.solid
      && Math.abs(c.matrix.elements[14] - z) < 0.2
      && Math.abs(c.matrix.elements[12] - OFFICE.x) < 0.2
      && c.matrix.elements[13] - c.halfExtents.y < 1.9
      && c.matrix.elements[13] + c.halfExtents.y > 1.9);
    assert.ok(solid.length > 0,
      `the office window at z ${z.toFixed(2)} has no collider at head height - it is a doorway, not a window`);
  }
});

test('every floor marking is struck on the ground it is actually lying on', async () => {
  /* The apron is a REAL 0.12 m pad, not an overlay, and this is the defect it
   * caused: every marking in `_buildFloor` was authored at deck level, so for
   * the 27 m between the kerb and the gateway the keel line (paint top 0.030),
   * its brass inlay (0.065) and the chalk grid were INSIDE the concrete
   * (0.120). The player arrives at z 49.4 facing down a keel line whose first
   * 27 m of 160 do not exist - and it is the first thing the world's own
   * comment says the apron mouth frames.
   *
   * Asserted on the drawn vertices rather than on a description: `yard:paint`
   * samples the deck's maps and belongs south of the kerb, `yard:paintApron`
   * samples the concrete's and belongs north of it and above the pad. */
  const { world } = await built();
  const meshes = [];
  world.group.traverse((o) => { if (o.isMesh && !o.isInstancedMesh) meshes.push(o); });
  const deck = meshes.find((m) => m.name === 'yard:paint');
  const apron = meshes.find((m) => m.name === 'yard:paintApron');
  assert.ok(deck, 'the yard draws no floor markings at all');
  assert.ok(apron, 'the yard draws no markings on the apron - the keel line stops at the kerb');

  const count = (mesh, pred) => {
    const p = mesh.geometry.attributes.position;
    let bad = 0;
    for (let i = 0; i < p.count; i++) if (pred(p.getX(i), p.getY(i), p.getZ(i))) bad++;
    return { bad, total: p.count };
  };
  const north = count(deck, (x, y, z) => z > APRON_Z + 0.001);
  assert.equal(north.bad, 0,
    `${north.bad} of ${north.total} deck-marking vertices are north of the kerb at z ${APRON_Z}, `
    + `i.e. under 120 mm of concrete`);
  const wrong = count(apron, (x, y, z) => z < APRON_Z - 0.001 || y < 0.12);
  assert.equal(wrong.bad, 0,
    `${wrong.bad} of ${wrong.total} apron-marking vertices are off the pad or below its 0.12 m top face`);
  assert.ok(apron.geometry.attributes.position.count >= 24,
    `only ${apron.geometry.attributes.position.count} vertices of marking on the apron - the keel line, `
    + 'the two chalk lines at z 40 and 52 and their chainage ticks are more than that');

  /* The brass inlay is geometry rather than paint, and it is the same trap:
   * measured at deck level its top face was 0.065, under a 0.120 pad. */
  const brass = meshes.find((m) => m.name === 'yard:emCyan');
  assert.ok(brass, 'the keel line has lost its brass inlay');
  const p = brass.geometry.attributes.position;
  let sunk = 0;
  for (let i = 0; i < p.count; i++) {
    if (p.getZ(i) > APRON_Z + 0.001 && p.getY(i) < 0.12 && Math.abs(p.getX(i)) < 4) sunk++;
  }
  assert.equal(sunk, 0, `${sunk} brass-inlay vertices on the apron sit below the pad they are meant to be set into`);
});

test('the yard asks its material library for a reflection probe', async () => {
  /* `main.js:1964` is `if (env.envMap !== undefined) scene.environment = env.envMap;`
   * - so a world that never sets it does not get "no reflections", it gets
   * WHICHEVER WORLD RAN LAST. This world authors twenty materials around
   * `envMapIntensity` 0.75, up to `M.glass` at 2.0 with clearcoat, which is
   * almost entirely image-based: booting `?world=dock` left `scene.environment`
   * null and collapsed the glass to a flat dark sheet, while arriving from the
   * concourse lit a cold shipyard with the station's baked cyan-and-amber
   * probe. Which one you got depended on the route you took.
   *
   * The stub above returns a marker rather than a texture, so what is asserted
   * is that the world ASKS, and asks for the mood it means. */
  const { world } = await built();
  assert.ok(world.environment.envMap, 'the yard publishes no envMap - its metals are lit by the last world');
  assert.equal(world.environment.envMap.__probe, 'space',
    'the shed has a roof and a starfield past the blast door; a daylight probe indoors reads as a hole in the wall');
  /* 1.05, and this is the third value it has had. 0.75 -> 0.85 was the note
   * below; 0.85 -> 1.05 is the yard's darkness pass.
   *
   * Half of this world is OUTSIDE — five piers and three hulls standing in
   * vacuum with a real starfield behind them — and out there the probe is the
   * only ambient specular any metal gets. Inside the bay it is still a shed
   * with a roof over most of it, which is why 0.85 was a nudge rather than
   * the 1.0 an open world would take.
   *
   * What moved it past 1.0 is measurement rather than taste. Mean frame
   * luminance over the framings a player actually stands in was 31-43 out of
   * 255 and the verdict was "a big dark room" — the player's own second
   * rejection of this world, verbatim. The hulls and the bay walls are the
   * darkest large surfaces in it and they are `MeshStandardMaterial`, so the
   * environment is what separates a plated flank from a silhouette. It is one
   * of three levers taken; `exposure` is deliberately NOT one of them, and
   * `dock-light.test.mjs` records why. */
  assert.equal(world.environment.envMapIntensity, 1.05);
});

/* ══════════════════════════════════════════════════════════════════════════ */
/*  THE SHIP COMPARTMENTS ARE WORTH WALKING INTO                              */
/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * EIGHT ROOMS THAT SAY WHAT THEY ARE FOR.
 *
 * The compartments were proved reachable before any of them was furnished:
 * `dock-hulls.test.mjs` walks into all eight and back out of all eight, and
 * nothing below is allowed to cost that. What is asserted here is the other
 * half — that a fit-out went in, that it went in WHERE it was meant to, and
 * that it did not do any of the four things this project has shipped before:
 *
 *  1. a member the size of the room hanging under its own ceiling
 *     (four occurrences, most recently the station tower's string course)
 *  2. a room that is dark for a reason that is not lighting
 *     (the two medieval rooms that measured AHEAD of the controls on floor
 *     illuminance while reading 28.0 and 23.4 mean luma)
 *  3. furniture built across the entrance of the building it is inside
 *     (MedievalWorld's ore benches, in their own building's doorway)
 *  4. a fitting that invents a standable surface nothing can reach
 *
 * The rules live in `ShipKit.js`; these are the measurements that keep them.
 */

const HULL = await import('../../src/worlds/dock/HullPlan.js');
const PLAN = await import('../../src/worlds/dock/YardPlan.js');
const KIT = await import('../../src/worlds/dock/ShipKit.js');
const { GeoBatch } = await import('../../src/worlds/station/StationKit.js');
const { SHIP_TINTS } = await import('../../src/ships/ShipStats.js');
const HULLS_SRC = await import('../../src/worlds/dock/Hulls.js');

/** `dock-reach.test.mjs`'s numbers, quoted rather than re-chosen. */
const HEADROOM = 1.9;
const STEP_UP = 0.45;

/** Local (ship frame) -> world, matching `GeoBatch.localAt` and `ShipBuild.P`. */
function P(berth, lx, ly, lz) {
  const c = Math.cos(berth.yaw), s = Math.sin(berth.yaw);
  return new THREE.Vector3(
    berth.x + lx * c + lz * s,
    berth.cradleTop + ly,
    berth.z - lx * s + lz * c
  );
}

/** Every fitted compartment, with the berth and hull it belongs to. */
function compartments() {
  const out = [];
  for (const b of PLAN.BERTHS) {
    for (const r of HULL.HULLS[b.id].rooms ?? []) out.push({ ship: b.id, berth: b, room: r });
  }
  return out;
}

/**
 * Rebuild every fitted hull on its OWN frame at `yaw = 0`.
 *
 * `dock-hulls.test.mjs` gives the reason: the AABB of a yawed box is not the
 * box, and at the Dray's 0.20 rad a 9 m hold measures 10.6 m across in world
 * axes, so every member in it gains a fictitious 18% of footprint. Everything
 * that measures GEOMETRY here measures it flat.
 *
 * @param {boolean} fit whether to run the fit-out - `false` gives the bare hull
 *   the differential in the hatch test needs
 */
async function buildHulls(fit) {
  const { world } = await built();
  const builders = {
    kestrel: HULLS_SRC.buildKestrel,
    dray: HULLS_SRC.buildDray,
    pike: HULLS_SRC.buildPike,
  };
  const out = {};
  for (const id of HULL.WALKABLE) {
    const physics = new Physics();
    const { mats } = KIT.shipMaterials(world.mat, SHIP_TINTS[id]);
    const ext = new GeoBatch(), int = new GeoBatch();
    const loose = new THREE.Group();
    const b = new KIT.ShipBuild({
      batch: ext, interior: int, physics, track: (c) => c, group: loose,
      x: 0, y: 0, z: 0, yaw: 0,
    });
    const berth = PLAN.BERTHS.find((x) => x.id === id);
    const built1 = builders[id](b, 1, berth.cradleTop, mats);
    const hullParts = b.iparts.length;
    const hullColliders = b.colliders.length;
    const stats = fit ? KIT.fitOut(b, built1.rooms) : { placed: 0, refused: 0, unknown: [] };
    const root = new THREE.Group();
    ext.flush(root, mats, `flat-${id}`, {});
    int.flush(root, mats, `flat-${id}-in`, {});
    root.add(loose);
    root.updateMatrixWorld(true);
    out[id] = { b, out: built1, root, stats, hullParts, hullColliders, physics, H: HULL.HULLS[id] };
  }
  return out;
}

/**
 * The same three hulls with the fit-out NOT run, so a differential can say what
 * this pass added rather than what the yard contains.
 */
let _bare = null;
async function bare() {
  if (_bare) return _bare;
  _bare = await buildHulls(false);
  return _bare;
}

let _flat = null;
async function flat() {
  if (_flat) return _flat;
  _flat = await buildHulls(true);
  return _flat;
}

test('the fit-out ran on every compartment, and knows what it refused', async () => {
  /* THE GUARD ON EVERY OTHER TEST BELOW. A fit-out that silently stopped
   * running would leave eight boxes with ceiling heights and every clearance
   * assertion in this file would go green by measuring nothing.
   *
   * The numbers are what the current build produces, quoted as FLOORS rather
   * than as equalities so the exteriors can be reshaped underneath: what has to
   * hold is that each hull got a substantial fit-out and that no compartment
   * type went unrecognised. */
  const f = await flat();
  const table = [];
  for (const id of HULL.WALKABLE) {
    const { stats, b, hullParts } = f[id];
    table.push(`${id}: ${stats.placed} placed / ${stats.refused} refused, `
      + `${b.iparts.length - hullParts} parts added to ${hullParts} the hull drew`);
    assert.deepEqual(stats.unknown, [],
      `${id} publishes compartment types the fit-out does not know: ${stats.unknown.join(', ')} `
      + '- a new room id is a room with nothing in it');
    assert.ok(stats.placed >= 15,
      `${id}: only ${stats.placed} fittings placed. floor: 15`);
    /* And REFUSALS are bounded too, because "it did not fit" is how a fit-out
     * quietly becomes no fit-out. Half is the ceiling: a bank of instrument
     * bays sweeping a bulkhead is MEANT to refuse the columns a nav station or
     * a crawl hatch already occupies, and on the Pike that is most of one
     * bulkhead. Past half, something has moved and the fittings are chasing it. */
    assert.ok(stats.refused < stats.placed * 2,
      `${id}: ${stats.refused} fittings refused against ${stats.placed} placed - `
      + 'the fit-out is being crowded out rather than fitting around');
  }
  assert.ok(true, table.join(' | '));
  // Every compartment carries a real share of it, measured in the room itself.
  for (const c of compartments()) {
    if (!f[c.ship]) continue;
    const box = new THREE.Box3(
      new THREE.Vector3(-c.room.hw, c.room.floorY, c.room.z0),
      new THREE.Vector3(c.room.hw, c.room.ceilY, c.room.z1)
    );
    const inside = f[c.ship].b.iparts.filter((p) =>
      p.cx !== undefined && box.containsPoint(new THREE.Vector3(p.cx, p.cy, p.cz)));
    assert.ok(inside.length >= 12,
      `${c.ship}/${c.room.id} holds only ${inside.length} drawn parts. floor: 12 - `
      + 'a compartment with less than that in it is a box with a ceiling height');
  }
});

test('nothing the fit-out builds stands in a doorway, a stair or a lift shaft', async () => {
  /* THE ORE-BENCH RULE. `MedievalWorld` shipped a building whose own benches
   * stood across its own entrance: from the street the door was a door, and the
   * room behind it could not be entered. Nothing caught it, because no test knew
   * what a doorway was.
   *
   * `ShipBuild` publishes one now — every `wallX`, `wallZ`, `hatch`, `flight`
   * and `lift` reserves the volume a body needs at the moment the opening is
   * cut. The keep-out is the body: `P.radius 0.35` gives 0.95 m of approach
   * (0.60 through a crouch hole) and 0.35 m past each jamb, plus the quarter
   * disc a hatch leaf sweeps about its own hinge.
   *
   * ── Measured against the FIT-OUT's parts, not the hull's ─────────────────
   * The hulls line their own compartments with panels that run the full length
   * of the room, and a lining panel crossing a hatch approach is a wall, not an
   * obstruction. What this file owns is what the second pass added, and that is
   * what is checked: 16 ways across three hulls against every part built after
   * the hull builder returned.
   */
  const f = await flat();
  const offenders = [];
  let ways = 0, checked = 0, fittings = 0;
  for (const id of HULL.WALKABLE) {
    const { b, hullParts } = f[id];
    ways += b.ways.length;
    /* CHOSEN footprints only. A footprint this pass picked is one it answers
     * for. The trim it bolts onto a mass the hull already placed is not: two of
     * the Dray's seven ore crates stand inside its own cargo-lift shaft and its
     * own cargo doorway, and lashing straps wrapped round those crates are in
     * the way because the crates are — which is a finding about `Hulls.js` and
     * not about this pass. `dress` marks those `bolted` instead. */
    const mine = b.iparts.slice(hullParts).filter((p) => p.chosen);
    fittings += mine.length;
    for (const w of b.ways) {
      for (const p of mine) {
        checked++;
        const ox = Math.min(p.x1, w.x1) - Math.max(p.x0, w.x0);
        const oy = Math.min(p.y1, w.y1) - Math.max(p.y0, w.y0);
        const oz = Math.min(p.z1, w.z1) - Math.max(p.z0, w.z0);
        if (ox <= 0.02 || oy <= 0.02 || oz <= 0.02) continue;
        offenders.push(`${id}: a fitting at (${p.cx.toFixed(2)}, ${p.cy.toFixed(2)}, ${p.cz.toFixed(2)}) `
          + `stands ${ox.toFixed(2)} x ${oy.toFixed(2)} x ${oz.toFixed(2)} m inside a reserved way`);
      }
    }
  }
  assert.deepEqual(offenders.slice(0, 10), [],
    `${offenders.length} fittings stand in a doorway, a flight or a lift shaft:\n  `
    + offenders.slice(0, 10).join('\n  '));
  assert.ok(ways >= 12,
    `only ${ways} reserved ways across three hulls - the openings have stopped publishing them, `
    + 'and a rule with nothing to check is a rule that passes');
  assert.ok(fittings >= 120 && checked > 1200,
    `${fittings} fitted parts over ${checked} part/way pairs - too few to be measuring anything`);
});

test('a fitting hangs its trim on the mass that is actually there', async () => {
  /* The other half of "nothing is built through what is already there".
   *
   * Every hull draws its own seats, bunks and machinery as single boxes, and the
   * fit-out finds them with `partIn` and dresses them rather than building a
   * second set 30 mm in front — which would be the z-fight family that put 251
   * of 407 hits into the medieval world. So: no two DRAWN parts in any
   * compartment may interpenetrate by more than a hand's width in all three
   * axes at once.
   *
   * 0.06 m rather than zero, because trim is MEANT to touch what it is bolted
   * to: a cushion sits in its pan, a strap wraps a crate, a headrest sits on a
   * back. What is being caught is a box inside a box. */
  const f = await flat();
  const BURY = 0.06;
  const worst = [];
  for (const c of compartments()) {
    if (!f[c.ship]) continue;
    const { b } = f[c.ship];
    const box = new THREE.Box3(
      new THREE.Vector3(-c.room.hw, c.room.floorY, c.room.z0),
      new THREE.Vector3(c.room.hw, c.room.ceilY, c.room.z1)
    );
    const parts = b.iparts.filter((p) =>
      p.cx !== undefined && box.containsPoint(new THREE.Vector3(p.cx, p.cy, p.cz)));
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        const a = parts[i], q = parts[j];
        const ox = Math.min(a.x1, q.x1) - Math.max(a.x0, q.x0);
        const oy = Math.min(a.y1, q.y1) - Math.max(a.y0, q.y0);
        const oz = Math.min(a.z1, q.z1) - Math.max(a.z0, q.z0);
        const bury = Math.min(ox, oy, oz);
        if (bury <= BURY) continue;
        /* A part wholly inside another is not a bury, it is a lining: the hull's
         * own panel lines and relief studs are drawn ON its plating on purpose,
         * and both of those are in the EXTERIOR batch anyway. What is measured
         * here is the smaller part's own size, so a 0.05 m strap crossing a
         * 1.0 m crate reports 0.05 and passes. */
        const small = Math.min(
          Math.min(a.x1 - a.x0, a.y1 - a.y0, a.z1 - a.z0),
          Math.min(q.x1 - q.x0, q.y1 - q.y0, q.z1 - q.z0)
        );
        if (bury <= small + 1e-6) continue;
        worst.push(`${c.ship}/${c.room.id}: two parts share a ${bury.toFixed(2)} m block `
          + `at (${a.cx.toFixed(2)}, ${a.cy.toFixed(2)}, ${a.cz.toFixed(2)})`);
      }
    }
  }
  assert.deepEqual(worst.slice(0, 8), [],
    `${worst.length} pairs of drawn parts are buried in each other:\n  ` + worst.slice(0, 8).join('\n  '));
});

test('raycast up from every walkable point and the first thing over a head is the deckhead', async () => {
  /* THE FULL-PLAN-BOX RULE, measured from underneath instead of in plan.
   *
   * `dock-hulls.test.mjs` catches a member that covers half a compartment in
   * plan. This catches the version that does not: the medieval Marcher Hall's
   * boarding was plank at 1.66 m in a room whose real ceiling was 2.85, and the
   * headroom test missed it because those members carry no collider. So this
   * fires a ray up from every point of a 0.5 m lattice over every compartment
   * floor, against the DRAWN geometry, colliders or not.
   *
   * ── Standing on it and walking under it are different questions ──────────
   * A bench, a rack, a crate and a console all interrupt a ray fired from the
   * deck, and none of them is a low ceiling — they are floor a body does not
   * stand on. So each lattice point is sorted first:
   *
   *   first hit under `floorY + 1.0`   the point is OCCUPIED by a fitting
   *   otherwise                        the point is STANDABLE, and what is over
   *                                    it has to be over a head
   *
   * and both halves are asserted, because a fit-out can fail either way: a
   * soffit over open deck is the medieval defect, and a compartment that is 80%
   * furniture is a room you cannot walk into, which is the same defect wearing
   * the other hat.
   */
  const f = await flat();
  const ray = new THREE.Raycaster();
  ray.near = 0.01;
  const up = new THREE.Vector3(0, 1, 0);
  const from = new THREE.Vector3();
  const probe = new THREE.Vector3();
  const report = [];
  for (const c of compartments()) {
    if (!f[c.ship]) continue;
    const { root } = f[c.ship];
    const meshes = [];
    root.traverse((o) => { if (o.isMesh && !o.isInstancedMesh) meshes.push(o); });
    const r = c.room;
    const clear = r.ceilY - r.floorY;
    /* Eye is a stance, not a constant: the Pike's gun bay is 1.50 m clear and
     * crouch-only BY DESIGN, so a standing probe in there would measure a
     * ceiling that is correctly in the way. */
    const stand = clear >= HEADROOM ? 1.62 : 0.9;
    let pts = 0, occupied = 0, roofed = 0, worst = Infinity, worstAt = '';
    for (let lx = -r.hw + 0.4; lx <= r.hw - 0.4; lx += 0.5) {
      for (let lz = r.z0 + 0.4; lz <= r.z1 - 0.4; lz += 0.5) {
        from.set(lx, r.floorY + 0.05, lz);
        ray.set(from, up);
        ray.far = clear + 0.5;
        const hits = ray.intersectObjects(meshes, false);
        pts++;
        const first = hits.length ? hits[0].distance + 0.05 : clear;
        /* 1.0 m, and it is a stance rather than a taste: below waist height a
         * body walks round the thing, above it a body walks under it. The
         * engine room has a 0.56 m oil drum and a 0.92 m bench in it, and a
         * sample beside either rays up into an overhang that is furniture. */
        if (first < 1.0) { occupied++; continue; }
        /* ...and 'inside a fitting' as well as 'beside one'. Every material in
         * this world is FrontSide, so an upward ray started inside the Dray's
         * powerplant passes straight through its own top face and reports the
         * cooling fins over it as a 1.62 m ceiling in a 2.60 m room. Asked of
         * the COLLIDERS instead, which is the question a body would ask. */
        probe.set(lx, r.floorY + 0.9, lz);
        if (f[c.ship].physics.containsPoint(probe)) { occupied++; continue; }
        if (first < stand + 0.08) {
          roofed++;
          if (first < worst) { worst = first; worstAt = `(${lx.toFixed(1)}, ${lz.toFixed(1)})`; }
        }
      }
    }
    const standable = pts - occupied;
    const frac = standable ? roofed / standable : 1;
    report.push(`${c.ship}/${r.id} ${standable}/${pts} standable, ${(frac * 100).toFixed(0)}% roofed low`);
    assert.ok(standable >= pts * 0.45,
      `${c.ship}/${r.id}: only ${standable} of ${pts} floor points are open deck - `
      + 'the fit-out has filled the compartment rather than furnished it. floor: 45%');
    assert.ok(frac <= 0.15,
      `${c.ship}/${r.id}: ${(frac * 100).toFixed(0)}% of its ${standable} standable points are roofed below `
      + `${stand.toFixed(2)} m (lowest ${worst === Infinity ? 'n/a' : worst.toFixed(2)} m at ${worstAt}, `
      + `declared clear height ${clear.toFixed(2)} m). ceiling: 15%`);
  }
  /* Quoted rather than merely asserted, so the margin is visible. The medieval
   * version of this failed at 1.66 m under a 2.85 m ceiling. */
  assert.ok(report.length >= 8, `only ${report.length} compartments probed: ${report.join(' | ')}`);
});

test('no fitting invents a standable surface a body cannot reach', async () => {
  /* WHY MOST OF THE FIT-OUT IS SOLID AND SOME OF IT IS NOT.
   *
   * `dock-hulls.test.mjs`'s "no hull hides a room nothing can walk to" samples
   * every hull's volume and demands that each standable surface is a declared
   * compartment floor or on the round trip. A surface is standable when it
   * carries `HEADROOM = 1.9` m of clear air, so a COLLIDED fitting whose top
   * lands between `floorY + 0.40` and `ceilY - 1.9` is a platform in mid-room
   * that a 0.45 m step cannot reach: an orphan, and a correct failure there.
   *
   * Two of the eight compartments have such a band at all — the Dray's hold
   * (3.40 m clear, band 1.40-2.50) and its engine room (2.60 m, 1.40-1.70).
   * The other six are 1.90-2.10 m clear, where the band is empty and everything
   * may be solid. Asserted here against the colliders the FIT-OUT registered,
   * which the other file would only reach as an orphan several hundred samples
   * later and could not name.
   */
  const f = await flat();
  const offenders = [];
  let solids = 0, banded = 0;
  for (const c of compartments()) {
    if (!f[c.ship]) continue;
    const r = c.room;
    const lo = r.floorY + 0.40, hi = r.ceilY - HEADROOM;
    if (hi > lo) banded++;
    /* The fit-out's own colliders: `ShipBuild.colliders` in registration order,
     * so everything past the mark the hull left is this pass's. */
    for (const col of f[c.ship].b.colliders.slice(f[c.ship].hullColliders)) {
      if (!col || col.type !== 'box') continue;
      const m = col.matrix.elements;
      const cx = m[12], cy = m[13], cz = m[14];
      if (Math.abs(cx) > r.hw || cz < r.z0 || cz > r.z1) continue;
      if (cy < r.floorY - 0.2 || cy > r.ceilY) continue;
      solids++;
      const top = cy + col.halfExtents.y;
      if (top <= lo || top >= hi) continue;
      offenders.push(`${c.ship}/${r.id}: a fitted collider tops out at ${top.toFixed(2)} - `
        + `between ${lo.toFixed(2)} (still the deck) and ${hi.toFixed(2)} (too low to stand on), `
        + `so it is a ${(top - r.floorY).toFixed(2)} m step nothing can climb`);
    }
  }
  assert.deepEqual(offenders.slice(0, 8), [],
    `${offenders.length} collided fittings invent an unreachable surface:\n  `
    + offenders.slice(0, 8).join('\n  '));
  assert.ok(solids >= 20,
    `only ${solids} fitted colliders inside the eight compartments - the fit-out is drawn and not `
    + 'collided, which is the "a detail the player can see and not grab would be a lie" defect');
  assert.ok(banded >= 2,
    `${banded} compartments have a standable band at all - the Dray's hold and engine room are two, `
    + 'and a rule with nothing to check is a rule that passes');
});

test('every compartment is lit at its own floor, per fitting and in total', async () => {
  /* THE HALF THAT IS NOT GEOMETRY, and the reason it is beside the half that
   * is: "neither alone would have found the defect". The two medieval rooms
   * reported as too dark measured 5.17 and 4.59 at the floor against controls
   * of 3.10 and 3.29 - they were AHEAD - and the fix was a slab overhead. So a
   * furnished compartment has to keep BOTH: nothing between the lamp and the
   * floor, and a lamp.
   *
   * Analytic, evaluated exactly as the standard shader does: `intensity / d^2`
   * windowed by `saturate(1 - (d/cutoff)^4)^2`, sampled on the compartment's own
   * floor rather than only under the fitting.
   */
  const { world } = await built();
  const rows = [];
  for (const c of compartments()) {
    const e = world.enterables.find((x) => x.label === `ship-${c.ship}`);
    if (!e) continue;
    const r = c.room;
    const lights = e.lights ?? [];
    let min = Infinity, sum = 0, n = 0;
    for (let lx = -r.hw + 0.5; lx <= r.hw - 0.5; lx += 0.6) {
      for (let lz = r.z0 + 0.5; lz <= r.z1 - 0.5; lz += 0.6) {
        const at = P(c.berth, lx, r.floorY, lz);
        let lit = 0;
        for (const l of lights) {
          const dx = l.x - at.x, dy = l.y - at.y, dz = l.z - at.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          const d = Math.sqrt(d2);
          if (d < 1e-3) continue;
          const cutoff = l.distance || 0;
          let win = 1;
          if (cutoff > 0) {
            const t = Math.min(1, (d / cutoff) ** 4);
            win = (1 - t) ** 2;
          }
          // The floor's normal is up, so `dot(N, L)` is the light's height over it.
          const ndl = Math.max(0, dy / d);
          lit += (l.intensity / d2) * win * ndl;
        }
        min = Math.min(min, lit);
        sum += lit;
        n++;
      }
    }
    const mean = n ? sum / n : 0;
    rows.push(`${c.ship}/${r.id} min ${min.toFixed(2)} mean ${mean.toFixed(2)}`);
    /* The floor is the MEDIEVAL CONTROLS' number, 3.10 and 3.29, which were the
     * rooms nobody complained about - taken at the darkest point of the
     * compartment rather than under the fitting, which is where the medieval
     * measurement went wrong. */
    assert.ok(min >= 0.35,
      `${c.ship}/${r.id}: its darkest floor point receives ${min.toFixed(3)}. floor: 0.35`);
    assert.ok(mean >= 1.2,
      `${c.ship}/${r.id}: mean floor illuminance ${mean.toFixed(2)} over ${n} points. floor: 1.2`);
  }
  assert.ok(rows.length >= 8, `only ${rows.length} compartments measured: ${rows.join(' | ')}`);
});

test('a cockpit has instruments, a hold has cargo gear, a cabin has a berth', async () => {
  /* WITHOUT A LABEL, which is the whole brief. What makes a compartment read as
   * what it is for is not a nameplate, it is the fittings — so this asserts the
   * fittings, by the one property a merged world still carries: which MATERIAL
   * each part went into, and how much of it there is inside the room.
   *
   * Measured off the flushed buffers rather than off the fit-out's own book-
   * keeping, because a fit-out that recorded a console and drew nothing would
   * satisfy its own records exactly. The INTERIOR batch only: the hull's
   * plating, deck slabs and bulkheads are all in the exterior one, so counting
   * both would let a compartment pass on the strength of the walls round it.
   *
   * The floors are the current build's numbers taken down by about a third, so
   * the exteriors can be re-proportioned underneath without this going red for
   * a 10% change — and a fitting class disappearing entirely cannot pass.
   * Measured: kestrel cabin lit 92 / body 480 / accent 216 / tarp 66;
   * kestrel cockpit lit 972 / body 2424; dray hold gear 1940 / body 1804;
   * dray engine accent 512 / body 2248; dray cockpit lit 840 / body 1468;
   * pike entry body 396 / accent 148; pike cockpit lit 528 / body 958;
   * pike gunbay accent 100 / lit 132.
   */
  const f = await flat();
  /* What each compartment type has to be able to show for itself, as groups
   * rather than single keys: 'lit' is the instrumentation (three emissives),
   * 'body' is the casings and fabric (steel and dark steel), and the rest are
   * the ones that carry a specific meaning — canvas for soft goods, the livery
   * accent for handles, rails, straps and pipework. */
  const want = {
    cockpit: { lit: 350, body: 650 },
    cabin: { tarp: 45, body: 320, accent: 140 },
    hold: { gear: 1200, body: 1200 },
    engine: { accent: 350, body: 1500 },
    entry: { body: 260, accent: 100 },
    gunbay: { accent: 65, lit: 85 },
  };
  const v = new THREE.Vector3();
  const misses = [];
  const rows = [];
  for (const c of compartments()) {
    if (!f[c.ship]) continue;
    const r = c.room;
    const box = new THREE.Box3(
      new THREE.Vector3(-r.hw - 0.1, r.floorY, r.z0),
      new THREE.Vector3(r.hw + 0.1, r.ceilY, r.z1)
    );
    const tally = new Map();
    f[c.ship].root.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh) return;
      const m = /-in:(.+)$/.exec(o.name || '');
      if (!m) return;
      const pos = o.geometry?.attributes?.position;
      const idx = o.geometry?.index;
      if (!pos) return;
      const count = idx ? idx.count : pos.count;
      let tris = 0;
      for (let i = 0; i < count; i += 3) {
        const vi = idx ? idx.getX(i) : i;
        v.fromBufferAttribute(pos, vi).applyMatrix4(o.matrixWorld);
        if (box.containsPoint(v)) tris++;
      }
      tally.set(m[1], (tally.get(m[1]) ?? 0) + tris);
    });
    const k = (...ks) => ks.reduce((a, key) => a + (tally.get(key) ?? 0), 0);
    const got = {
      lit: k('glow', 'warn', 'danger'),
      body: k('trim', 'dark'),
      accent: k('accent'),
      tarp: k('tarp'),
      gear: k('accent', 'tarp'),
    };
    rows.push(`${c.ship}/${r.id} lit ${got.lit} body ${got.body} accent ${got.accent} tarp ${got.tarp}`);
    for (const [group, floor] of Object.entries(want[r.id] ?? {})) {
      if (got[group] < floor) {
        misses.push(`${c.ship}/${r.id}: ${got[group]} '${group}' triangles, floor ${floor} `
          + `(has ${[...tally].filter(([, n]) => n).map(([key, n]) => `${key} ${n}`).join(', ') || 'nothing'})`);
      }
    }
  }
  assert.deepEqual(misses, [],
    `${misses.length} compartments do not carry the fittings their type calls for:\n  ` + misses.join('\n  '));
  assert.ok(rows.length >= 8, rows.join(' | '));
});

test('the fit-out puts nothing new between a hatch and the room behind it', async () => {
  /* The ore-bench rule, measured with a RAY rather than with the bookkeeping —
   * which is the point of having both. Every part goes into `iparts` on its way
   * into the batch, so the way test above measures the fit-out against its own
   * records; this one measures the merged buffers, and a fitting drawn by some
   * path that forgot to record itself shows up here and nowhere else.
   *
   * ── DIFFERENTIAL, and that is a finding rather than a convenience ────────
   * Fired at the finished hull alone, this test fails on geometry that was
   * already there: the Kestrel lines both flanks of its compartment with a
   * panel that runs the full length of the deck INCLUDING across its own
   * boarding hatch, so the first thing on the line straight in through that
   * hatch is lining at 0.12 m — measured, and unchanged by anything in this
   * file. The Pike's entry bay likewise carries the hull's own fold-down bench
   * 0.80 m inside its threshold.
   *
   * So each hull is built twice, with the fit-out and without, and what is
   * asserted is the DIFFERENCE: no ray may find anything nearer the threshold
   * than the bare hull already put there. That isolates this pass exactly, and
   * it leaves the two pre-existing numbers on the record instead of hiding
   * them behind a threshold chosen to pass.
   */
  const f = await flat();
  const b0 = await bare();
  const UP = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3();
  const from = new THREE.Vector3();

  const scan = (build) => {
    const ray = new THREE.Raycaster();
    ray.near = 0.01;
    const meshes = [];
    build.root.traverse((o) => { if (o.isMesh && !o.isInstancedMesh) meshes.push(o); });
    const out = [];
    for (const d of build.b.doors) {
      /* `d.position` is world, and this hull was built at the origin with
       * `yaw = 0`, so it is already in the hull's own frame. */
      const inward = new THREE.Vector3(-d.position.x, 0, -d.position.z);
      if (inward.lengthSq() < 1e-6) continue;
      inward.normalize();
      for (const off of [-0.18, 0, 0.18]) {
        for (const eye of [0.9, 1.5]) {
          dir.copy(inward).applyAxisAngle(UP, off);
          from.set(d.position.x, d.position.y + eye - 1.0, d.position.z);
          ray.set(from, dir);
          ray.far = 0.95;                      // the approach `hatch` reserves
          const hit = ray.intersectObjects(meshes, false)[0];
          out.push({ id: `${d.id}@${off.toFixed(2)}/${eye}`, d: hit ? hit.distance : Infinity, what: hit?.object?.name ?? '' });
        }
      }
    }
    return out;
  };

  const worse = [];
  const note = [];
  let looks = 0;
  for (const id of HULL.WALKABLE) {
    const withFit = scan(f[id]);
    const without = scan(b0[id]);
    assert.equal(withFit.length, without.length, `${id}: the two builds disagree on how many hatches it has`);
    for (let i = 0; i < withFit.length; i++) {
      looks++;
      const a = withFit[i], z = without[i];
      if (Number.isFinite(z.d)) note.push(`${id}/${z.id}: the bare hull already puts ${z.what} ${z.d.toFixed(2)} m in`);
      if (a.d < z.d - 0.01) {
        worse.push(`${id}/${a.id}: the fit-out puts ${a.what} ${a.d.toFixed(2)} m inside the threshold, `
          + `where the bare hull's nearest was ${Number.isFinite(z.d) ? `${z.d.toFixed(2)} m` : 'nothing at all'}`);
      }
    }
  }
  assert.deepEqual(worse, [],
    `${worse.length} of ${looks} sightlines through a hatch approach are worse with the fit-out in:\n  `
    + worse.join('\n  '));
  assert.ok(looks >= 18, `only ${looks} hatch sightlines fired across three hulls`);
  /* Quoted, not asserted: what the hulls themselves already stand in their own
   * doorways, so it is on the record for whoever owns `Hulls.js`. */
  assert.ok(true, note.join(' | '));
});

test('the fit-out costs no new draw calls and stays inside the triangle budget', async () => {
  /* The cheapest way to make a room look furnished is a new material, and the
   * yard is measured at a ceiling of 140 meshes in `dock-hulls.test.mjs`: one
   * merged mesh per material key per batch, so a fit-out that reaches for a
   * fifth emissive is three more draw calls for three ships.
   *
   * That is why the annunciators cycle three keys and not four, and why the
   * lift-out deck panels are drawn in the deck's `trim` rather than in its
   * `deckg`: 143 measured, 139 after both.
   */
  const { world } = await built();
  let meshes = 0, interior = 0, tris = 0;
  const keys = new Set();
  world.group.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    const m = /^ship-(\w+)-in:(.+)$/.exec(o.name || '');
    if (!m) return;
    interior++;
    keys.add(m[2]);
    const g = o.geometry;
    tris += (g?.index ? g.index.count : (g?.attributes?.position?.count ?? 0)) / 3;
  });
  /* Tracks `dock-hulls`' own ceiling, which moved to 156 when the yard grew a
   * sky: a starfield, three bodies and their limb haloes, a ring, the
   * containment-field scrim and the pier edge-light bucket. */
  assert.ok(meshes <= 156,
    `${meshes} meshes in the world group against dock-hulls' ceiling of 156`);
  assert.ok(interior >= 18 && interior <= 30,
    `${interior} interior meshes across three fitted hulls - one merged mesh per material key per hull`);
  assert.ok(keys.size <= 10,
    `the fit-out reaches for ${keys.size} material keys (${[...keys].join(', ')}); `
    + 'each one is a draw call in every hull that uses it. ceiling: 10');
  assert.ok(tris > 13000,
    `only ${Math.round(tris)} triangles of interior across three hulls - the fit-out did not land`);
  assert.ok(tris < 120000,
    `ceiling: 120k triangles of ship interior. achieved: ${Math.round(tris)}`);
});

/* ====================================================================== */
/* THREE THINGS THE SUITE COULD NOT SEE, AND ONE ROOT CAUSE EACH           */
/* ====================================================================== */

/**
 * World transform of a point in a hull's own frame.
 *
 * Local +X maps to world `(cos yaw, -sin yaw)` and local +Z to
 * `(sin yaw, cos yaw)` — `GeoBatch.localAt`. `y 0` is the cradle's bearing face.
 */
function shipPoint(berth, lx, ly, lz) {
  const c = Math.cos(berth.yaw), s = Math.sin(berth.yaw);
  return new THREE.Vector3(
    berth.x + lx * c + lz * s, berth.cradleTop + ly, berth.z - lx * s + lz * c);
}

/** Every drawn mesh in the world, minus the invisible ramp proxies. */
function drawnMeshes(world) {
  const out = [];
  world.group.traverse((o) => { if (o.isMesh && o.visible && o.name !== 'ramp-proxy') out.push(o); });
  return out;
}

test('a boarding hatch opens into the compartment and not onto a panel', async () => {
  /* WHAT THIS EXISTS FOR. The Kestrel's lining ran the full 6.7 m of its
   * compartment with no hole in it, so its boarding hatch opened onto an
   * unbroken panel 0.10 m inboard of the plating: 180 of 180 lattice samples
   * blocked. The Pike's first systems rack stood in the same place on its own
   * flank: 64 of 154 blocked at 0.24 m. Both are DRAWN-ONLY parts, so the
   * player boarded by walking through a wall, which is worse than being
   * stopped by it.
   *
   * Nothing in this suite could see either. `plated(..., { opening })` cuts the
   * PLATING and nothing else in the hull knows the hatch exists; the aperture
   * test at :1109 is differential by construction - it compares a fitted hull
   * against a bare one, so a blockage that lives in the hull can never fail it;
   * and `dock-hulls`' hatch test only checks that the prompt is in range.
   *
   * The lattice starts 0.30 m over the sill and stops 0.20 m under the lintel,
   * because a doorway's own sill and head are not obstructions - sampling to
   * the edge picks up the Dray's 2.6 m cargo door sill on 36 of 720 rays and
   * says nothing. Between those it is ALL of the doorway, and all of it has to
   * be clear: measured on this tree, kestrel 0/156, dray 0/648, pike 0/143.
   */
  const { world } = await built();
  const meshes = drawnMeshes(world);
  const rc = new THREE.Raycaster();
  const bad = [];
  for (const id of HULL.WALKABLE) {
    const H = HULL.HULLS[id];
    const berth = PLAN.BERTHS.find((b) => b.id === id);
    const sg = HULL.boardSide(berth);
    let blocked = 0, tot = 0; const names = new Set();
    for (let dy = 0.30; dy <= H.hatch.h - 0.20; dy += 0.12) {
      for (let dz = -H.hatch.w / 2 + 0.08; dz <= H.hatch.w / 2 - 0.08; dz += 0.08) {
        tot++;
        // From just inboard of the plating's inner face, straight into the room.
        const sx = sg * (H.lower.hw - HULL.SKIN + 0.08);
        const from = shipPoint(berth, sx, H.deck.y + dy, H.hatch.lz + dz);
        const to = shipPoint(berth, sx - sg * 1.0, H.deck.y + dy, H.hatch.lz + dz);
        rc.set(from, to.sub(from).normalize());
        rc.near = 0.005; rc.far = 1.3;
        // The door leaves themselves are allowed to be in their own doorway.
        const hit = rc.intersectObjects(meshes, false)
          .find((h) => !/hatchleaf|:door/i.test(h.object.name));
        if (hit) { blocked++; names.add(hit.object.name + ' at ' + hit.distance.toFixed(2) + ' m'); }
      }
    }
    assert.ok(tot >= 100, `${id}: only ${tot} aperture samples - the lattice is too coarse`);
    if (blocked) {
      bad.push(`${id}: ${blocked}/${tot} of the boarding aperture is blocked by `
        + `[${[...names].join(', ')}]`);
    }
  }
  assert.deepEqual(bad, [],
    'a boarding hatch opens onto geometry. A drawn-only obstruction is not a soft lock, it is '
    + 'worse: the player walks through it and the world reads as unbuilt.\n  ' + bad.join('\n  '));
});

test('no exterior member is drawn through the volume a body walks in', async () => {
  /* THE RULE THAT WOULD HAVE FIRED. `ShipKit.course` draws four members - two
   * flanks and two transverse ends `(hw - inset) * 2` wide on the centreline.
   * On a full-length course the ends are buried in the bow and stern caps; on
   * the Kestrel's mid course, inset 3.2 m at each end, they landed inside the
   * cabin - a 4.28 m beam across the room's whole 4.16 m breadth at local
   * y 1.39-1.61, 0.63 m above the sole, with no collider under it. Raycast up
   * from the cabin sole on a 0.2 m grid, 42 of 256 points met it.
   *
   * `dock-hulls`' full-plan-box rule fires at 50% of plan footprint and this
   * was 7.5%. `ShipBuild.put` does not call `_occupy` - only `iput` does - so
   * `fits()` was blind to every exterior member, which is also why the fit-out
   * laid the Kestrel's bunk bedding inside the same box.
   *
   * The band is the body's own sweep and not the room's clear height, because
   * a deckhead is legitimately allowed to hang below a declared `ceilY`: the
   * Dray's engine room carries structure at local y 3.48 under a 3.60 ceiling
   * and the Pike's gun bay at 1.88 under 2.20, and neither is in anybody's
   * way. What is in the way is anything between 0.20 m over the sole - under
   * that it is a floor, a sill or a lift car - and the top of the capsule that
   * compartment is declared for: 1.75 m standing, 1.015 m crouching, from
   * `dock-reach`. Measured on this tree: zero points, in all eight
   * compartments.
   */
  const { world } = await built();
  const rc = new THREE.Raycaster();
  /* A flight's treads ARE inside the walking envelope of the room it stands in,
   * and legitimately so: the Dray's hold carries the five treads up to its
   * cockpit at local y 1.39, 1.65, 1.91 and 2.17 over a sole at 1.00, which is
   * 4.9% of the hold's plan. A stair is something you stand ON, so the samples
   * over one are skipped - by the flight's OWN collision proxy footprint,
   * because that is the one record that cannot disagree with where the treads
   * were drawn. */
  const flightXZ = [];
  world.group.traverse((o) => {
    if (o.isMesh && o.name === 'ramp-proxy') flightXZ.push(new THREE.Box3().setFromObject(o));
  });
  assert.ok(flightXZ.length >= 6, `only ${flightXZ.length} ramp proxies to exempt`);
  const onAFlight = (p) => flightXZ.some((b) =>
    p.x >= b.min.x - 0.15 && p.x <= b.max.x + 0.15 && p.z >= b.min.z - 0.15 && p.z <= b.max.z + 0.15);
  const bad = [];
  for (const id of HULL.WALKABLE) {
    const H = HULL.HULLS[id];
    const berth = PLAN.BERTHS.find((b) => b.id === id);
    /* The hull's OWN exterior batch: the fit-out is a separate batch and is
     * policed by the `fits()` rules above. */
    const ext = drawnMeshes(world).filter((o) => o.name.startsWith(`ship-${id}:`));
    assert.ok(ext.length >= 3, `${id}: only ${ext.length} exterior meshes - the hull did not build`);
    for (const r of H.rooms) {
      const capsule = (r.ceilY - r.floorY) >= HEADROOM ? 1.75 : 1.015;
      let hits = 0, tot = 0, lowest = Infinity; const names = new Set();
      for (let x = -r.hw + 0.12; x <= r.hw - 0.12; x += 0.2) {
        for (let z = r.z0 + 0.12; z <= r.z1 - 0.12; z += 0.2) {
          const o = shipPoint(berth, x, r.floorY + 0.20, z);
          if (onAFlight(o)) continue;
          tot++;
          rc.set(o, new THREE.Vector3(0, 1, 0));
          rc.near = 0.01; rc.far = capsule - 0.20;
          const h = rc.intersectObjects(ext, false)[0];
          if (!h) continue;
          hits++;
          const ly = h.point.y - berth.cradleTop;
          lowest = Math.min(lowest, ly);
          names.add(h.object.name + ' at local y ' + ly.toFixed(2));
        }
      }
      assert.ok(tot >= 90, `${id}/${r.id}: only ${tot} floor samples`);
      if (hits) {
        bad.push(`${id}/${r.id}: ${hits} of ${tot} floor points `
          + `(${((100 * hits) / tot).toFixed(1)}%) have exterior geometry inside the ${capsule} m `
          + `walking envelope, lowest at local y ${lowest.toFixed(2)} over a sole at ${r.floorY} `
          + `- [${[...names].join(', ')}]`);
      }
    }
  }
  assert.deepEqual(bad, [],
    'an exterior member is drawn through a room a player stands in.\n  ' + bad.join('\n  '));
});

test('a flight does not hang its collision proxy into the room underneath', async () => {
  /* `ShipKit.flight` collides a flight as ONE rotated box whose TOP face is the
   * slope, which puts its underside `thickness / cos(pitch)` = 0.55 m below the
   * treads. A deck plate is `DECK_T` = 0.16 m thick, so a flight standing on
   * one hangs 0.39 m through it into whatever is below.
   *
   * The Dray's companionway did exactly that over its cockpit: proxy-clipped
   * clear height 1.76 m minimum with 11.5% of the floor under 1.9, against a
   * compartment that declares 2.10 and a standing capsule of 1.75 - and it hung
   * over the cockpit's own doorway, where `stair` arrives at z 2.8 and
   * `cockpitArch` is at 3.1. `ShipKit.solidHere` sizes the unreachable-platform
   * band off `ceilY - 1.9`, so the fit-out believed 2.10 the whole time.
   *
   * The tolerance is 4% of plan rather than zero because ONE case is legitimate
   * and measured: the Dray's cargo ramp comes up through its own cargo doorway,
   * which puts its proxy over 2.8% of the hold's floor at the threshold. Every
   * other compartment measures 0.0%.
   */
  const { world } = await built();
  const proxies = [];
  world.group.traverse((o) => { if (o.isMesh && o.name === 'ramp-proxy') proxies.push(o); });
  assert.ok(proxies.length >= 6, `only ${proxies.length} ramp proxies - the flights did not build`);
  const rc = new THREE.Raycaster();
  const bad = [];
  for (const id of HULL.WALKABLE) {
    const H = HULL.HULLS[id];
    const berth = PLAN.BERTHS.find((b) => b.id === id);
    for (const r of H.rooms) {
      const declared = r.ceilY - r.floorY;
      const need = Math.min(declared, HEADROOM);
      let under = 0, tot = 0, min = declared;
      for (let x = -r.hw + 0.1; x <= r.hw - 0.1; x += 0.2) {
        for (let z = r.z0 + 0.1; z <= r.z1 - 0.1; z += 0.2) {
          tot++;
          const o = shipPoint(berth, x, r.floorY, z);
          rc.set(o, new THREE.Vector3(0, 1, 0));
          rc.near = 0.02; rc.far = declared + 4;
          const h = rc.intersectObjects(proxies, false)[0];
          const clear = Math.min(h ? h.distance : declared, declared);
          min = Math.min(min, clear);
          if (clear < need - 1e-6) under++;
        }
      }
      assert.ok(tot >= 90, `${id}/${r.id}: only ${tot} floor samples`);
      const pct = (100 * under) / tot;
      if (pct > 4) {
        bad.push(`${id}/${r.id}: ${pct.toFixed(1)}% of the floor is under ${need} m of clear air `
          + `(minimum ${min.toFixed(2)}) against a declared ${declared.toFixed(2)}`);
      }
    }
  }
  assert.deepEqual(bad, [],
    'a flight proxy hangs through a deck plate into the compartment below, and the room goes on '
    + 'declaring the height it no longer has.\n  ' + bad.join('\n  '));
});
