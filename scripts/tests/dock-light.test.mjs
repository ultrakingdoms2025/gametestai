import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/**
 * THE LODESTAR YARD RENDERED BLACK, AND IT WAS NOT A LIGHTING PROBLEM.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THIS FILE IS FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The yard shipped built, green and invisible: every framing in
 * `Harness.VIEWS.dock` came back at roughly 3% luminance, and thirteen of the
 * twenty-five came back as a FLAT field with a maximum pixel of 18/255 - no
 * geometry in the frame at all, from a camera fifteen metres off a ship's hull.
 * Three separate things were wrong, and only one of them was light:
 *
 *  1. FOUR BOXES WITH A `tile` OF 0.  `dock/Hulls.js` called `ShipBuild.box`
 *     with a tenth argument, meaning a rotation - a raking jack strut, an
 *     access panel off its hinge, a canted knee, a ramp stringer. `box` has no
 *     rotation triple; its ninth argument is `tile`. So the rotation landed in
 *     the texel density and the tilt was dropped.
 *
 *     `boxUV` divides each face's size by `tile`, so a `tile` of 0 gives
 *     `Infinity` where the unit uv is 1 and NaN where it is 0. The box ships
 *     with NaN texture coordinates and every fragment it draws is NaN.
 *
 *     A NaN fragment is not a bad pixel, it is a BAD FRAME. `UnrealBloomPass`
 *     high-passes the image, blurs it through five mip levels and composites
 *     the pyramid back additively - all weighted sums, and a weighted sum
 *     containing NaN is NaN. Measured at `gantry-crossing`: NINETEEN NaN
 *     pixels took the whole 921,600-pixel frame from a mean luminance of 18.99
 *     to 4.08. At `datum`, the one framing with no offending geometry on
 *     screen, bloom on and bloom off measured 16.90 and 16.85 - which is why
 *     some views looked merely dark and others looked empty.
 *
 *     THIS IS WHY FLOODING AMBIENT DID NOTHING. Ambient 0.22 -> 6.0, a factor
 *     of twenty-seven, moved the frame's mean by 0.07. There was no image left
 *     to brighten. Three rounds of lighting work would have found nothing.
 *
 *  2. A 2.7% SURFACE.  Rendering the yard's own geometry under the yard's own
 *     lights twice - once with its materials and once with a neutral white
 *     `MeshStandardMaterial` - and taking the ratio of mean frame luminance
 *     gives the world's reflectance as rendered, independent of how bright the
 *     lamps are. The yard returned 0.053-0.071 against the station's
 *     0.229-0.430. Ablation at `berth-b1`, direct render, mean luma 0-255:
 *     as authored 4.68, every `map` removed 32.91, every `color` set to white
 *     8.67, neutral white material 77.75. See `YardTextures.ALBEDO_GAMMA`.
 *
 *  3. ONE LAMP PER 3,483 m².  Eight practicals in a 27,864 m² shed, on the
 *     mistaken belief that `RIG_BUDGET.point` caps the number a world may
 *     AUTHOR. It caps the number that are ever LIVE; every light the yard
 *     builds is a `LightRig` source, switched off the instant `build()`
 *     returns. See `DockWorld._buildLights`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  AND THE ONE THING THAT WAS NOT WRONG
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The recorded lesson from the medieval expansion says: when a room reads dark,
 * measure floor illuminance and look for room-spanning geometry overhead,
 * because the two rooms reported as too dark were receiving MORE light than the
 * controls (5.17 / 4.59 against 3.10 / 3.29) and the real cause was boarding
 * slabs nobody had looked for. That probe is the third test below and it came
 * back CLEAN for this world: the first surface over 258 of 272 floor points is
 * the roof plate at 25.9 m, and the fourteen exceptions are a tarp, a hull and
 * three columns - real objects a player walks around. The lesson still earned
 * its place: it is why the ablation went looking for something between the lamp
 * and the eye rather than reaching for the intensity sliders, and what it found
 * was NaN rather than a slab.
 *
 * Every number in this file was measured on this tree and can be reproduced:
 * the headless ones by running it, the rendered ones with the dev harness at
 * `?dev=1&world=dock` and `HARNESS.view(name)`.
 */

function harness() {
  if (globalThis.__dockLightHarness) return;
  globalThis.__dockLightHarness = true;
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
const { ShipBuild } = await import('../../src/worlds/dock/ShipKit.js');
const { ALBEDO_GAMMA, albedoLift } = await import('../../src/worlds/dock/YardTextures.js');
const PLAN = await import('../../src/worlds/dock/YardPlan.js');
const { YARD_X, YARD_Z0, YARD_Z1, GANTRY_X, GANTRY_Y, GANTRY_Z0, GANTRY_Z1, ROOF_Y, BERTHS } = PLAN;
const { HULLS } = await import('../../src/worlds/dock/HullPlan.js');

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

/** Rec.709 luminance of a THREE.Color, which is already linear. */
const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

const UP = new THREE.Vector3(0, 1, 0);
const _L = new THREE.Vector3();

/**
 * Irradiance at a surface point with a given normal, in three's own units.
 *
 * `getDistanceAttenuation` in the standard shader is
 * `1 / d^decay` windowed by `saturate(1 - (d/cutoff)^4)^2`, and the diffuse
 * term multiplies it by `dot(N, L)`.
 *
 * ── THE NORMAL IS AN ARGUMENT NOW, AND THAT IS THE DEFECT THIS FILE MISSED ──
 * It used to be `(L.pos.y - p.y) / d`, i.e. N pinned to +Y, with the comment
 * "a floor's normal is +Y". Every probe in this file routes through here, and
 * every probe in this file therefore measured FLOORS: the 10 m bay grid, both
 * catwalk runs and the per-compartment floors. The suite was 7/7 green while
 * the four hulls were the darkest objects in their own framings, because a
 * hull flank is VERTICAL and every practical in the yard hung directly over
 * it. Measured with this function before the fix, mean over each flank's whole
 * area against the same hull's top deck:
 *
 *                 -X flank   +X flank   top deck
 *     kestrel        0.079      0.047      0.520
 *     dray           0.187      0.152      0.354
 *     pike           0.098      0.110      0.460
 *     bastion        0.151      0.062      0.320
 *
 * - every flank at or under the bay floor's own median of 0.161, which this
 * file reports as its achievement. After the berth flank brackets: 0.241 to
 * 0.421, with the fourth test below standing over it.
 *
 * @param {THREE.Vector3} [n] surface normal; defaults to +Y, which is a floor.
 */
function illuminanceAt(lights, p, n = UP) {
  let e = 0;
  for (const L of lights) {
    const d = L.pos.distanceTo(p);
    if (d < 1e-3 || (L.distance > 0 && d > L.distance)) continue;
    const ndotl = _L.copy(L.pos).sub(p).dot(n) / (d * n.length());
    if (ndotl <= 0) continue;
    let window = 1;
    if (L.distance > 0) {
      const t = Math.min(1, (d / L.distance) ** 4);
      window = Math.max(0, 1 - t) ** 2;
    }
    e += L.intensity * L.lum * (1 / d ** L.decay) * window * ndotl;
  }
  return e;
}

function pointSources(world) {
  const out = [];
  world.group.traverse((o) => {
    if (!o.isPointLight && !o.isSpotLight) return;
    out.push({
      pos: o.getWorldPosition(new THREE.Vector3()),
      intensity: o.intensity, lum: lum(o.color),
      distance: o.distance ?? 0, decay: o.decay ?? 2,
    });
  });
  return out;
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/* ====================================================================== */

test('nothing in the yard ships a non-finite vertex attribute', async () => {
  /* THE BLOCKER. One NaN uv is one NaN fragment is - through the bloom
   * pyramid - a black frame, so the tolerance here is zero and has to be.
   *
   * Positions and normals are checked beside the uvs because they are the same
   * class of failure with the same amplification: `normalize(vec3(0.0))` is
   * NaN, and a zero-length normal in a merged batch would black out the world
   * exactly as the zero `tile` did. */
  const { world } = await built();
  const bad = [];
  world.group.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    const uv = g.attributes.uv, pos = g.attributes.position, nrm = g.attributes.normal;
    let nanUV = 0, nanPos = 0, badN = 0;
    if (uv) for (let i = 0; i < uv.count; i++) if (!Number.isFinite(uv.getX(i)) || !Number.isFinite(uv.getY(i))) nanUV++;
    if (pos) for (let i = 0; i < pos.count; i++) {
      if (!Number.isFinite(pos.getX(i)) || !Number.isFinite(pos.getY(i)) || !Number.isFinite(pos.getZ(i))) nanPos++;
    }
    if (nrm) for (let i = 0; i < nrm.count; i++) {
      const L = Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
      if (!Number.isFinite(L) || L < 1e-4) badN++;
    }
    if (nanUV || nanPos || badN) bad.push(`${o.name || o.type}: ${nanUV} NaN uv, ${nanPos} NaN position, ${badN} zero/NaN normal`);
  });
  assert.deepEqual(bad, [],
    'a non-finite vertex attribute reaches the shader as a NaN fragment, and one NaN fragment '
    + 'is smeared over the entire frame by the bloom pyramid. Nineteen of them measured 4.08 mean '
    + `luma against 18.99 with bloom off.\n  ${bad.join('\n  ')}`);
});

test('a box cannot be built with a tile that divides by zero', async () => {
  /* The guard, tested through the public surface rather than by reading the
   * constant. `box` is called with a rotation in `tile`'s place at four sites
   * in one file; the fifth occurrence must throw at build time instead of
   * shipping NaN uvs into the frame. */
  const { world, physics } = await built();
  const b = new ShipBuild({
    batch: { localAt() {} }, interior: { localAt() {} },
    physics, track: (c) => c, group: new THREE.Group(), x: 0, y: 0, z: 0, yaw: 0,
  });
  for (const tile of [0, -0.5, NaN, Infinity]) {
    assert.throws(() => b.box('trim', 1, 1, 1, 0, 0, 0, 0, tile), /tile must be a positive number/,
      `ShipBuild.box accepted tile=${tile}`);
    assert.throws(() => b.ibox('trim', 1, 1, 1, 0, 0, 0, 0, tile), /tile must be a positive number/,
      `ShipBuild.ibox accepted tile=${tile}`);
    assert.throws(() => b.rbox('trim', 1, 1, 1, 0, 0, 0, 0, 0, 0.5, tile), /tile must be a positive number/,
      `ShipBuild.rbox accepted tile=${tile}`);
  }
  // ...and the legitimate call still works, or the guard is just a wall.
  assert.doesNotThrow(() => b.box('trim', 1, 1, 1, 0, 0, 0, 0, 2));
  assert.doesNotThrow(() => b.rbox('trim', 1, 1, 1, 0, 0, 0, 0, 0, 0.5, 1));
  assert.ok(world, 'world built');
});

test('the assembly floor is lit, and so are the catwalks', async () => {
  /* Analytic floor illuminance on a 10 m grid over the whole bay and an 8 m
   * grid along both catwalk runs, against the same probe run over the
   * station's hub deck, which measured a median of 0.40.
   *
   * MEASURED ON THIS TREE:
   *                         min    p10   median    p90     max    mean
   *   yard floor, was      0.000  0.000   0.005   0.055   0.563   0.020
   *   yard catwalks, was   0.000  0.000   0.000   0.000   0.000   0.000
   *   yard floor, now      0.099  0.124   0.161   0.259   1.030   0.186
   *   yard catwalks, now   0.081  0.152   0.611   0.617   0.617   0.448
   *   station hub deck     0.000  0.000   0.271   2.672  10.827   0.912
   *
   * 237 of the 272 floor points were under 0.05 and both catwalk runs read
   * exactly zero. The floors below sit under the measurement with room for art
   * direction to move and far above anything eight lamps could give.
   *
   * The MINIMUM matters more than the median here. A median says the lamps are
   * bright; a minimum says there is no square of floor between them that a
   * player can stand on and see nothing. */
  const { world } = await built();
  const lights = pointSources(world);
  assert.ok(lights.length >= 40,
    `only ${lights.length} point sources in a 27,864 m2 shed - `
    + 'RIG_BUDGET caps LIVE lights, not authored ones; the station has 222');

  const floor = [];
  for (let x = -80; x <= 80; x += 10) for (let z = -100; z <= 55; z += 10) {
    floor.push(illuminanceAt(lights, new THREE.Vector3(x, 0, z)));
  }
  assert.ok(floor.length > 200, 'the floor grid is too coarse to mean anything');
  assert.ok(Math.min(...floor) >= 0.07,
    `floor: 0.07 minimum. achieved: ${Math.min(...floor).toFixed(3)} - there is a square of `
    + 'assembly floor with effectively no light on it');
  assert.ok(median(floor) >= 0.13,
    `floor: 0.13 median (the station's hub deck measures 0.271). achieved: ${median(floor).toFixed(3)}`);

  const walk = [];
  for (const x of [-GANTRY_X + 0.6, GANTRY_X - 0.6]) {
    for (let z = GANTRY_Z0; z <= GANTRY_Z1; z += 8) walk.push(illuminanceAt(lights, new THREE.Vector3(x, GANTRY_Y, z)));
  }
  assert.ok(median(walk) >= 0.40,
    `catwalk: 0.40 median. achieved: ${median(walk).toFixed(3)} - the bay grid hangs 11 m inboard `
    + 'and 1 m above the deck, so it arrives at 5 degrees off the walking surface and lights nothing');
  assert.ok(Math.min(...walk) >= 0.05,
    `catwalk: 0.05 minimum. achieved: ${Math.min(...walk).toFixed(3)} - the brackets are further `
    + 'apart than their pools are wide and there is unlit walkway between them');
});

test('the piers are lit end to end, and they are the hardest lighting in the world', async () => {
  /* ═══════════════════════════════════════════════════════════════════════
   * A pier deck is the worst case this world has and it is worth saying why.
   *
   * Inside the bay a lamp at 9 m throws a cone at the floor and the light that
   * misses the floor hits a wall, a hull, a catwalk soffit or the roof, and
   * some of it comes back — not as GI, this renderer has none, but as lit
   * surfaces in the same frame, which is what stops the space between the
   * pools reading as black. Out on a pier the ONLY thing in frame is 6.8 m of
   * deck: everything a lamp makes that misses it is gone into vacuum, and
   * there is no second surface anywhere in the shot.
   *
   * So the pier lamps are hung at 4.4 m instead of 9, on 13 m centres down the
   * spine and at four corners of each pad, and the deck carries a continuous
   * ungraded emissive edge bead which is what actually reads at 240 m. This
   * probes the walking centreline of every spine and a 4 m grid over every
   * pad, at deck level, with an upward normal.
   *
   * MEASURED ON THIS TREE, 324 stations:
   *                   min    p10   median    p90     max
   *   pier decks     0.134  0.318   0.701   1.154   2.332
   *
   * against the assembly floor's own 0.099 minimum and 0.161 median, which is
   * the number the bay was signed off on. The piers are four times the shed at
   * the median and they have to be.
   *
   * MUTATIONS, all run. At 13 m spine centres and two lamps per pad edge the
   * minimum was 0.042. Four stations per edge took it to 0.067 and cost 18
   * sources inside 20 m of the Pike against `dock-interiors`' density guard of
   * 16 - the two constraints pull opposite ways, which is the whole difficulty
   * of lighting a deck with nothing behind it. What carries it is fewer lamps
   * placed further apart: two per edge at 0.68 of the half-depth (over 20 m
   * between them on every pad but the two short ones), one at each END of the
   * pad set a spine half-width off the centreline so it is not a post standing
   * in the walking lane, and 34 cd / 40 m of reach. At 0.45 of the half-depth
   * instead the minimum falls back to 0.135; at the pre-offset 30 cd it is
   * 0.119, which is under this floor.
   * ═══════════════════════════════════════════════════════════════════════ */
  const { world } = await built();
  const lights = pointSources(world);
  const e = [];
  for (const p of PLAN.PIERS) {
    const pad = PLAN.pierPad(p);
    for (let z = PLAN.MOUTH_Z; z >= pad.z0; z -= 2) e.push(illuminanceAt(lights, new THREE.Vector3(p.x, 0, z)));
    for (let x = -p.hw + 2; x <= p.hw - 2; x += 4) {
      for (let z = pad.z0 - 2; z >= pad.z1 + 2; z -= 4) {
        e.push(illuminanceAt(lights, new THREE.Vector3(p.x + x, 0, z)));
      }
    }
  }
  assert.ok(e.length > 200, `only ${e.length} pier stations - the grid is too coarse to mean anything`);
  assert.ok(Math.min(...e) >= 0.12,
    `floor: 0.12 minimum on a pier deck, against the assembly floor's 0.099. achieved: `
    + `${Math.min(...e).toFixed(3)} - there is a stretch of pier over open vacuum with no light on it`);
  assert.ok(median(e) >= 0.40,
    `floor: 0.40 median on the piers, against the assembly floor's 0.161. achieved: ${median(e).toFixed(3)}`);
});

test('every compartment a player can walk into has a lit floor', async () => {
  /* Per enterable, off the DESCRIPTOR's own declared lights and every other
   * source in the world, at the compartment's own floor height - so a hold
   * whose lamp was deleted fails here even though the yard around it is bright.
   *
   * Measured, worst compartment first: the floor under the dimmest declared
   * fitting in the yard puts 1.66 on it. */
  const { world } = await built();
  const lights = pointSources(world);
  for (const e of world.enterables) {
    if (!e.doors?.length && !e.lifts?.length) continue;   // the trench stash has neither
    const y = e.floorY ?? 0;
    const o = e.origin ?? new THREE.Vector3(e.x ?? 0, y, e.z ?? 0);
    const at = illuminanceAt(lights, new THREE.Vector3(o.x, y, o.z));
    assert.ok(at >= 1.0,
      `floor: 1.0 in a compartment. achieved: ${at.toFixed(2)} at the centre of ${e.label}`);
  }
});

test('every hull flank is lit, not just the deck on top of it', async () => {
  /* THE PROBE THIS FILE DID NOT HAVE, and the reason it did not have it is one
   * line: `illuminanceAt` pinned N to +Y, so seven green assertions all
   * measured floors while the subjects of eight of the world's framings were
   * darker than their own backgrounds.
   *
   * A flank point's normal is the hull's local +/-X carried through the
   * berth's yaw. The sample runs the plated section's whole length and height,
   * which is the silhouette a player reads from the shed floor.
   *
   * MEASURED ON THIS TREE, mean over each flank:
   *              -X flank   +X flank   top deck   (top deck for scale, N = +Y)
   *   kestrel      0.421      0.389      0.679
   *   dray         0.257      0.265      0.293
   *   pike         0.350      0.362      0.593
   *   bastion      0.241      0.255      0.308
   *
   * Before the berth flank brackets the same eight numbers were 0.047-0.187
   * against top decks of 0.293-0.679, i.e. every hull was lit like a floor
   * plan. The floor below is the yard floor's own median, because a ship that
   * is dimmer than the concrete it stands on cannot read as a ship. */
  const { world } = await built();
  const lights = pointSources(world);
  const floor = [];
  for (let x = -80; x <= 80; x += 10) for (let z = -100; z <= 55; z += 10) {
    floor.push(illuminanceAt(lights, new THREE.Vector3(x, 0, z)));
  }
  const floorMedian = median(floor);
  assert.ok(floorMedian > 0.1, `the floor probe itself reads ${floorMedian.toFixed(3)}`);

  const worst = [];
  for (const berth of BERTHS) {
    const H = HULLS[berth.id];
    const c = Math.cos(berth.yaw), sn = Math.sin(berth.yaw);
    // Local +X maps to world (cos yaw, -sin yaw): `GeoBatch.localAt`.
    const at = (lx, ly, lz) => new THREE.Vector3(
      berth.x + lx * c + lz * sn, berth.cradleTop + ly, berth.z - lx * sn + lz * c);
    for (const sg of [-1, 1]) {
      const n = new THREE.Vector3(sg * c, 0, -sg * sn);
      const v = [];
      for (let z = H.lower.z0 + 1; z <= H.lower.z1 - 1; z += 1.5) {
        for (let y = H.lower.y0 + 0.5; y <= H.ledge.y - 0.3; y += 0.6) {
          v.push(illuminanceAt(lights, at(sg * (H.lower.hw + 0.02), y, z), n));
        }
      }
      assert.ok(v.length >= 10, `${berth.id}: only ${v.length} flank samples`);
      worst.push([`${berth.id} ${sg > 0 ? '+X' : '-X'}`, v.reduce((a, b) => a + b, 0) / v.length]);
    }
  }
  worst.sort((a, b) => a[1] - b[1]);
  assert.ok(worst[0][1] >= 0.20,
    `flank: 0.20 mean, and the yard floor's own median is ${floorMedian.toFixed(3)}. `
    + `achieved: ${worst[0][1].toFixed(3)} on the ${worst[0][0]} flank - every practical over `
    + 'that berth is hanging on the ship centreline and a vertical surface gets dot(N, L) ~ 0');
  assert.ok(worst[0][1] >= floorMedian,
    `the ${worst[0][0]} flank reads ${worst[0][1].toFixed(3)} against a floor median of `
    + `${floorMedian.toFixed(3)} - the ship is darker than the concrete it stands on`);
});

test('nothing spans the bay between the lamps and the floor', async () => {
  /* THE RECORDED PROBE, ported from the medieval expansion. Two rooms reported
   * as too dark were AHEAD of the controls on floor illuminance (5.17 and 4.59
   * against 3.10 and 3.29) and the cause was room-spanning boarding slabs
   * overhead that nobody had raycast for. So before any lamp in this world is
   * touched, this asserts what is actually over the floor.
   *
   * It came back clean and stays here as the guard. The median first surface
   * over the assembly floor is the roof soffit at 25.95 m; 95% of the bay has
   * six metres of clear height over it and the rest is the high-bay fittings at
   * nine. Only 14 of 272 points meet anything under four metres and every one
   * is a real object with a footprint - a tarp over the spares, the kestrel's
   * flank, three stanchions, the bastion's glow strip - not a slab spanning a
   * room. Seven are under 2.2 m, which is the number to watch: that is a
   * player's head height, and a slab through the bay would put dozens there. */
  const { world } = await built();
  const meshes = [];
  world.group.traverse((o) => { if (o.isMesh && o.visible) meshes.push(o); });
  const rc = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, 1, 0), 0.05, 60);
  const heights = [];
  let lowHeadroom = 0;
  const offenders = [];
  for (let x = -80; x <= 80; x += 10) {
    for (let z = -100; z <= 55; z += 10) {
      rc.set(new THREE.Vector3(x, 0.05, z), new THREE.Vector3(0, 1, 0));
      const hit = rc.intersectObjects(meshes, false)[0];
      const h = hit ? hit.distance : Infinity;
      heights.push(h);
      if (h < 2.2) { lowHeadroom++; offenders.push(`(${x},${z}) @ ${h.toFixed(1)}m ${hit.object.name || hit.object.type}`); }
    }
  }
  /* 6 m, not 20: the high-bay fittings hang at 9 m over a fifth of the floor
   * by design and a 20 m test would just be counting lamps. Six metres is the
   * height below which something is in the SPACE rather than over it. */
  const clear = heights.filter((h) => h > 6).length;
  assert.ok(clear / heights.length >= 0.9,
    `only ${(100 * clear / heights.length).toFixed(0)}% of the assembly floor has 6 m of clear height `
    + 'over it - something is spanning the bay below the catwalks');
  assert.ok(lowHeadroom <= 10,
    `${lowHeadroom} points on the assembly floor have a surface under 2.2 m over them, which is a `
    + `slab through the middle of the bay rather than a prop to walk round:\n  ${offenders.join('\n  ')}`);
  const med = median(heights.filter((h) => Number.isFinite(h)));
  assert.ok(med > ROOF_Y - 2 && med < ROOF_Y,
    `the median first surface over the floor is ${med.toFixed(1)} m; the roof soffit is just under `
    + `${ROOF_Y} m and should be what most of the bay sees`);
});

test('the albedo set reflects enough light to be lit at all', async () => {
  /* The painted canvases cannot be measured under `node --test` - the stub 2D
   * context returns zeros from `getImageData` - so this asserts the transfer
   * and the tints, which are what a future edit would move.
   *
   * The plate values the eight painters are authored around, run through the
   * transfer, and what they are worth in the LINEAR space where albedo is
   * multiplied. sRGB 0x23 (the floor's deck plate) was 1.9% reflectance, which
   * is darker than charcoal and is why no lamp could reach it. */
  const srgbToLinear = (v) => { const u = v / 255; return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4; };

  assert.ok(ALBEDO_GAMMA > 0 && ALBEDO_GAMMA < 1,
    'ALBEDO_GAMMA must lift the mid-tones; at or above 1 it darkens them');
  // The transfer must be an identity at both ends, or it is an exposure change
  // dressed up as a calibration and the oil blooms and the chalk both move.
  assert.equal(albedoLift(0), 0, 'the transfer must leave black alone');
  assert.equal(albedoLift(255), 255, 'the transfer must leave white alone');

  for (const [name, authored, floorLinear] of [
    ['floor deck plate', 0x23, 0.09],
    ['hull/wall plate', 0x33, 0.14],
    ['structural steel', 0x3d, 0.17],
  ]) {
    const before = srgbToLinear(authored);
    const after = srgbToLinear(albedoLift(authored));
    assert.ok(after >= floorLinear,
      `${name}: authored sRGB 0x${authored.toString(16)} is ${(100 * before).toFixed(1)}% reflectance; `
      + `after the transfer it is ${(100 * after).toFixed(1)}% and the floor is ${(100 * floorLinear).toFixed(0)}%. `
      + 'A surface under 5% cannot be lit by any lamp - the whole yard measured 0.061 of a white '
      + "reference against the station's 0.253");
  }

  /* And the tints, which multiply the maps. `M.grate` is the darkest tinted
   * structural surface in the yard and it is every catwalk, stair tread and
   * trench cover in it. */
  const { world } = await built();
  const tinted = [];
  world.group.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!m || !m.map || !m.color) continue;
      if (m.emissive && lum(m.emissive) > 0.02) continue;   // emissive props carry their own value
      tinted.push({ name: o.name || o.type, l: lum(m.color) });
    }
  });
  assert.ok(tinted.length >= 10, `only ${tinted.length} tinted mapped materials found - the walk is broken`);
  const worst = tinted.reduce((a, b) => (b.l < a.l ? b : a));
  assert.ok(worst.l >= 0.10,
    `the darkest mapped tint in the yard is ${worst.l.toFixed(3)} linear on ${worst.name}. `
    + 'A tint multiplies the map, and both were darkened in sRGB for the same reason, which is '
    + 'how the world reached 2.7% effective reflectance');
});

test('the environment block is the one the grade preset is calibrated against', async () => {
  /* `GRADE_PRESETS.dock` picks its bloom threshold (2.40) against this world's
   * measured linear luminance, and `PostFX` selects the preset by world id. Re-
   * measured after the albedo and lamp work: at five framings the 99th
   * percentile of scene-linear luminance is 0.67-0.87 and between 0.01% and
   * 0.11% of pixels clear 2.40, so the threshold still sits above the lit plate
   * and catches only the fittings. Changing anything below invalidates that.
   *
   * `exposure` is asserted because it is the one control that scales the whole
   * frame after tone mapping, and an exposure change is what a screenshot makes
   * you want to reach for when the real cause is elsewhere. */
  /* ── Re-pinned for the open bay ──────────────────────────────────────
   * 1.20, not 1.0. The yard is a hangar open to vacuum now and the verdict on
   * the closed version was that it was too dark even after a lighting pass
   * that took the framings from a minimum of 9.7 to 17.0.
   *
   * MEASURED IN A BROWSER, all 35 framings — the 25 in `Harness.VIEWS.dock`
   * and 10 more on the piers — reading the real framebuffer back with
   * `gl.readPixels` after the composite, Rec.709 luma, weapon viewmodel and
   * player avatar hidden, and 50 frames of settle so `LightRig` has finished
   * re-scoring its 12 slots (at 8 frames it has not, and the same framing
   * varies by 3 to 25 between runs — that is how `office-inside` measured 21
   * and 48 an hour apart):
   *
   *                min    p25   median   max    mean of means
   *   framings    23.9   27.0    30.9   52.4        32.8
   *
   * The minimum is `mouth-from-space` — a framing taken from out on the piers
   * looking back at the bay, three quarters of which is correctly empty sky.
   * The darkest framing INSIDE the yard is `crane-cab` at 24.1.
   *
   * Exposure is the smallest of the three levers that got it there and it is
   * pinned here BECAUSE it is the one a screenshot makes you want to reach for
   * when the real cause is elsewhere: the work was done by the lamps (the bay
   * grid at 31 cd / 52 m, pier lamps on 8.5 m centres) and by the pier deck
   * material, which was `grate` at metalness 0.62 against a starfield probe
   * and rendered black. */
  const { world } = await built();
  const env = world.environment;
  assert.equal(env.exposure, 1.20, 'the dock renders at exposure 1.20');
  assert.ok(env.ambientIntensity + env.hemiIntensity < 1.0,
    `ambient ${env.ambientIntensity} + hemi ${env.hemiIntensity} >= 1.0; `
    + 'flat fill is the one control that erases the pools of sodium this world is for');
  assert.ok(env.ambientIntensity > 0 && env.hemiIntensity > 0, 'the fill lights are not switched off');
  assert.ok(env.sunIntensity > 0, 'the high-bay key is not switched off');
  assert.ok(env.fogNear > 20 && env.fogFar > env.fogNear + 100,
    `fog ${env.fogNear}..${env.fogFar} would haze the near field of a 172 m shed`);
  assert.ok(env.bloom === null,
    'bloom belongs to GRADE_PRESETS.dock, whose threshold is in linear-HDR units; '
    + 'a value here would be in the wrong units and would be merged on top');
  assert.ok(env.envMap, 'the yard publishes no reflection probe, so scene.environment keeps whichever '
    + 'world ran last - see _buildLights');
  assert.ok(env.envMapIntensity > 0, 'envMapIntensity 0 leaves twenty metal materials with no ambient specular');
});
