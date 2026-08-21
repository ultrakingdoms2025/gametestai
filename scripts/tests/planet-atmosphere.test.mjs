import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { rig, goto, settle } from './_flightrig.mjs';

const { VOLCANIC } = await import('../../src/worlds/planets/Volcanic.js');
const { CONFIG } = await import('../../src/core/Config.js');

/**
 * THE AIR ON A PLANET: does the sky stay where a sky is, and is there any
 * depth in front of it?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  TWO DEFECTS, BOTH FOUND BY LOOKING AND BOTH MEASURABLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. THE DOME DID NOT FOLLOW THE CAMERA. `gfx/Sky.js` re-centres its dome on
 *    `params.camera` every frame - that is the only thing that makes a dome
 *    read as infinitely far away - and `SpaceWorld` passes it.
 *    `PlanetWorld._buildSky` could not: `definePlanet` rejects class instances,
 *    so a live camera cannot be a field of a frozen descriptor, and nobody
 *    added it afterwards. Measured: moving the camera 990 m moved the space
 *    dome 707.11 m and moved the planet's 0.00. The dome is 1,600 m in radius,
 *    a legal walk to the corner of the playfield is 566 m, and
 *    `sky.material.fog === false` so nothing hid the swing.
 *
 * 2. THE SURFACE WAS ONE FLAT BROWN WASH. `fog.far` was 760 on a map whose
 *    diagonal is 1,131 m, and the fog colour was the same hue as the ground
 *    bands under it; `ambient.intensity` was 1.05, which flattened whatever
 *    form was left. Whole-frame luminance from 190 m up: mean 28.7, max 112,
 *    median 29, p90 38 - the entire planet inside a 9-luma band, on a world
 *    that from orbit is the best-looking thing in the build.
 *
 * Both are asserted here against the built world rather than against the
 * descriptor alone, because the descriptor is the input and the dome, the fog
 * and the lights are the output.
 */

const HALF = VOLCANIC.half;
/** The furthest two points in the playfield can be from each other. */
const DIAGONAL = Math.hypot(HALF * 2, HALF * 2);

test('the planet sky dome rides the camera, the way the space one does', async () => {
  const r = await rig();
  await goto(r, 'cinder');
  const world = r.wm.active;
  const sky = world._sky;
  assert.ok(sky?.mesh, 'the volcanic world built no sky dome at all');

  /* The mechanism, first: the dome only moves because `createSky` was handed a
   * camera. Asserting the movement alone would pass for a dome that happened
   * to be parented to something that moves. */
  assert.equal(sky.mesh.parent, world.group, 'the dome is not on the world group');

  const start = sky.mesh.position.clone();
  r.camera.position.set(340, 60, -290);
  r.camera.updateMatrixWorld(true);
  world.update(1 / 60, 1);
  const moved = sky.mesh.position.distanceTo(start);
  const want = r.camera.position.distanceTo(start);
  console.log(`  camera moved ${want.toFixed(2)} m, dome moved ${moved.toFixed(2)} m`);
  /* FLOOR: the dome must arrive AT the camera, not merely lean toward it. */
  assert.ok(sky.mesh.position.distanceTo(r.camera.position) < 0.01,
    `the dome is ${sky.mesh.position.distanceTo(r.camera.position).toFixed(2)} m from the camera after a frame`);
  /* And the move has to be a real one, or a camera that started on top of the
   * dome would satisfy the line above with nothing implemented. */
  assert.ok(moved > 100, `the dome moved ${moved.toFixed(2)} m for a ${want.toFixed(2)} m camera move`);

  /* THE CONSEQUENCE, stated as the angle it costs. A dome pinned at the origin
   * while the player walks to the corner of the playfield swings its horizon
   * by `atan(walk / radius)`, and there is no fog on the dome to hide it. */
  const radius = sky.mesh.geometry?.parameters?.radius ?? Math.max(1500, HALF * 4);
  const swing = THREE.MathUtils.radToDeg(Math.atan2(DIAGONAL / 2, radius));
  console.log(`  a pinned dome of radius ${radius} would swing ${swing.toFixed(1)} deg over a corner walk`);
  assert.ok(swing > 5, 'the dome is so large that pinning it would not be visible - re-read this case');
  assert.equal(sky.mesh.material.fog, false, 'the dome is fogged, which would have hidden all of this');
});

test('Cinder has air in front of its horizon, and a terminator on its slopes', async () => {
  const sky = VOLCANIC.sky;

  /* ── FOG ──────────────────────────────────────────────────────────────
   * FLOOR: the fog has to reach the far corner of the playfield, or the far
   * half of the map is one flat colour and there is no horizon at all. That is
   * what 760 on a 1,131 m diagonal bought.
   *
   * CEILING: it must NOT reach past the camera's far plane. The terrain mesh
   * ends at +/-400 and fog is what hides the edge of it; fog that finishes
   * beyond `CONFIG.render.far` leaves geometry popping at the clip instead. */
  console.log(`  playfield diagonal ${DIAGONAL.toFixed(0)} m, fog ${sky.fog.near}..${sky.fog.far} m, `
    + `camera far ${CONFIG.render.far} m`);
  assert.ok(sky.fog.far >= DIAGONAL,
    `floor: fog ends at ${sky.fog.far} m on a ${DIAGONAL.toFixed(0)} m diagonal - the far half of the map is paint`);
  assert.ok(sky.fog.far < CONFIG.render.far,
    `ceiling: fog ends at ${sky.fog.far} m past the ${CONFIG.render.far} m far plane - terrain pops at the clip`);

  /* THE FOG MUST NOT BE THE GROUND. Matching the ground hue is what removed
   * the horizon: at 0x5e2c1c the haze and the basalt bands under it were the
   * same colour, so there was nothing for the caldera to stand against. A dust
   * sky is lighter and greyer than the rock it is made of, and both halves of
   * that are asserted. */
  const fog = new THREE.Color(sky.fog.color);
  const hsl = { h: 0, s: 0, l: 0 };
  fog.getHSL(hsl);
  let groundL = 0;
  let groundS = 0;
  for (const b of VOLCANIC.palette.bands) {
    const c = new THREE.Color(b.color);
    const g = { h: 0, s: 0, l: 0 };
    c.getHSL(g);
    groundL += g.l / VOLCANIC.palette.bands.length;
    groundS += g.s / VOLCANIC.palette.bands.length;
  }
  console.log(`  fog L ${hsl.l.toFixed(3)} S ${hsl.s.toFixed(3)} against ground L `
    + `${groundL.toFixed(3)} S ${groundS.toFixed(3)}`);
  assert.ok(hsl.l > groundL + 0.03,
    `the haze (L ${hsl.l.toFixed(3)}) is no lighter than the ground it hangs over (L ${groundL.toFixed(3)})`);
  assert.ok(hsl.s < groundS + 0.02,
    `the haze (S ${hsl.s.toFixed(3)}) is more saturated than the rock (S ${groundS.toFixed(3)}) - dust is greyer`);

  /* ── THE GROUND IS NOT ONE COLOUR ─────────────────────────────────────
   *
   * A tester who landed here and walked it wrote: "One flat salmon-brown hue,
   * no rock, no ash, no vents, no heat, no shadows."
   *
   * The table it describes had six bands whose HUE spanned 20 to 27 degrees
   * and whose SATURATION spanned 20 to 26 points - six shades of one colour.
   * The value structure was doing real work, which is why the caldera reads as
   * a silhouette, but value alone is a black-and-white photograph of a
   * volcano, and nothing in this file could tell the difference.
   *
   * Two floors, both measured off the descriptor rather than written down:
   *
   *   HUE SPREAD. The widest gap between any two bands, on the circle. It was
   *   7 degrees; the floor is 40, which no accidental palette clears and any
   *   deliberate one does easily.
   *
   *   SATURATION SPREAD. Ash, oxidised ash and bare basalt are not equally
   *   colourful, and a table where they are is a tinted greyscale. It was 6
   *   points; the floor is 15.
   *
   * These sit UNDER the two fog assertions above on purpose: the fog rules cap
   * the MEAN lightness and saturation, and a table can satisfy both of those
   * while still being one colour - which is exactly what the old one did.
   */
  const hues = [];
  const sats = [];
  for (const b of VOLCANIC.palette.bands) {
    const g = { h: 0, s: 0, l: 0 };
    new THREE.Color(b.color).getHSL(g);
    /* A band with no chroma has no meaningful hue - `getHSL` reports 0, which
     * would read as "red" and inflate the spread. Only coloured bands vote. */
    if (g.s > 0.02) hues.push(g.h * 360);
    sats.push(g.s * 100);
  }
  assert.ok(hues.length >= 2,
    `only ${hues.length} of the ${VOLCANIC.palette.bands.length} bands have any chroma at all`);
  let hueSpread = 0;
  for (const a of hues) {
    for (const b of hues) {
      const d = Math.abs(a - b);
      hueSpread = Math.max(hueSpread, Math.min(d, 360 - d));
    }
  }
  const satSpread = Math.max(...sats) - Math.min(...sats);
  console.log(`  ground palette: hue spread ${hueSpread.toFixed(0)} deg, saturation spread ${satSpread.toFixed(0)} pts`);
  assert.ok(hueSpread >= 40,
    `floor: 40 deg of hue across the ground bands. achieved: ${hueSpread.toFixed(0)} - the ` +
    'surface is one colour at six brightnesses, which is what "a flat salmon-brown field" is');
  assert.ok(satSpread >= 15,
    `floor: 15 points of saturation across the ground bands. achieved: ${satSpread.toFixed(0)} - ` +
    'ash, oxidised ash and bare basalt are not equally colourful');

  /* ── LIGHT ────────────────────────────────────────────────────────────
   * A terminator needs the KEY to beat the FILL. At ambient 1.05 against a sun
   * of 4.2 the ratio was 0.25, and every slope on the planet shaded within a
   * few luma of every other. Bounce off a lava lake is real, so the fill is
   * still high for a single-sun world - but a face turned away from the sun
   * has to be a different value from one facing it. */
  const ratio = sky.ambient.intensity / sky.sun.intensity;
  console.log(`  ambient ${sky.ambient.intensity} / sun ${sky.sun.intensity} = ${ratio.toFixed(3)}`);
  assert.ok(ratio <= 0.12,
    `floor: fill/key is ${ratio.toFixed(3)}; over 0.12 there is no terminator on any slope`);
  /* CEILING: it is a volcanic world with a lava lake in it, and a fill of zero
   * would put the unlit side into pure black - which is the "big dark room"
   * this world exists not to be. */
  assert.ok(sky.ambient.intensity >= 0.3,
    `ceiling: an ambient of ${sky.ambient.intensity} puts the shadow side of every rock into black`);
});

test('the landing pads are wayfinding, not the brightest thing on the planet', async () => {
  /* Measured from 190 m up, the two pad rings were the only high-chroma
   * objects in a 921,600-pixel frame whose maximum was 112 - a cyan doughnut
   * on a volcanic world, reading as a UI overlay lying on the terrain. The
   * emissive came off the big ring entirely and the small one moved into the
   * world's own amber.
   */
  const r = await rig();
  await goto(r, 'cinder');
  const world = r.wm.active;
  const rings = [];
  world.group.traverse((o) => {
    if (o.isMesh && o.geometry?.type === 'RingGeometry' && o.material?.name?.includes('padmark')) {
      rings.push(o);
    }
  });
  assert.ok(rings.length >= 4, `only ${rings.length} pad rings found - the probe is blind`);

  const outer = rings.filter((o) => !o.material.name.endsWith('.inner'));
  const inner = rings.filter((o) => o.material.name.endsWith('.inner'));
  assert.ok(outer.length >= 2 && inner.length >= 2,
    `expected an outer and an inner ring per pad; got ${outer.length} / ${inner.length}`);

  for (const o of outer) {
    const e = o.material.emissive;
    assert.ok(!e || (e.r + e.g + e.b) * (o.material.emissiveIntensity ?? 1) < 1e-6,
      `the ${o.material.name} ring still emits - it is paint, and it was the brightest object on the planet`);
  }
  /* The inner ring keeps a light, because a pad has to be findable in the
   * dark - but it must be in the world's palette rather than in cyan. A hue
   * test rather than an exact colour: the point is that it belongs here. */
  for (const o of inner) {
    const hsl = { h: 0, s: 0, l: 0 };
    o.material.emissive.getHSL(hsl);
    const deg = hsl.h * 360;
    console.log(`  ${o.material.name} emissive hue ${deg.toFixed(0)} deg at ${o.material.emissiveIntensity}`);
    assert.ok(deg < 60 || deg > 330,
      `the inner pad ring glows at hue ${deg.toFixed(0)} - a volcanic world's palette is amber, not cyan`);
    assert.ok(o.material.emissiveIntensity <= 0.6,
      `the inner ring is at ${o.material.emissiveIntensity} - it is wayfinding, not a light source`);
  }
  await settle();
});
