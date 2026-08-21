import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { rig, goto, settle } from './_flightrig.mjs';

const { PLANETS, VOLCANIC } = await import('../../src/worlds/planets/index.js');
const { HEIGHT_FIELDS } = await import('../../src/worlds/terrain/index.js');
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
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT IS CHECKED ON ONE PLANET AND WHAT IS CHECKED ON TEN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Defect 1 and the pad rings below are properties of `PlanetWorld`, not of a
 * descriptor: `_buildSky` hands `params.camera` to `createSky` before it looks
 * at `sky.kind`, and `Sky.js`'s `update` re-centres on that camera in a branch
 * that is identical for `daylight`, `alpine` and `space`. The pad ring colours
 * are two literal `MeshStandardMaterial`s in `PlanetWorld._buildLandingSites`,
 * shared by every planet. Running either of those ten times would re-test one
 * code path ten times and cost ten world builds to do it. They stay on Cinder,
 * and they say so.
 *
 * Defect 2 is the opposite: fog, palette and light levels are pure descriptor
 * data, ten different authors wrote ten of them, and NINE of those were written
 * after this file was. So that case iterates `PLANETS` - the registry, not a
 * list, so an eleventh planet is covered the day it is registered rather than
 * the day somebody remembers this file.
 */

/** Every planet the game registers, in registry order. */
const ALL = Object.values(PLANETS);

/** The furthest two points in a playfield can be from each other. */
const diagonalOf = (P) => Math.hypot(P.half * 2, P.half * 2);

const HALF = VOLCANIC.half;
const DIAGONAL = diagonalOf(VOLCANIC);

/**
 * The box a camera on a planet is allowed to be in, SCRAPED from the world that
 * builds it rather than typed here.
 *
 * `PlanetWorld` sets `this.bounds` to `(-half, -60, -half) .. (half, 260, half)`
 * and that box is what clamps the player and the ship. The airless fog case
 * below needs it to answer "how far can ground be from a legal viewpoint", and
 * a second hand-written copy of those two numbers is exactly the arrangement
 * that let the station's flight ceiling sit above its own glass. If the shape
 * of that line changes this throws instead of quietly measuring the old world.
 */
const CAMERA_Y = (() => {
  const src = readFileSync(new URL('../../src/worlds/PlanetWorld.js', import.meta.url), 'utf8');
  const m = src.match(/new THREE\.Vector3\(\s*-P\.half,\s*(-?[\d.]+),\s*-P\.half\s*\)[\s\S]{0,120}?new THREE\.Vector3\(\s*P\.half,\s*(-?[\d.]+),\s*P\.half\s*\)/);
  assert.ok(m, 'could not find PlanetWorld\'s `this.bounds` Box3 - the airless fog case below is measuring nothing');
  return { min: Number(m[1]), max: Number(m[2]) };
})();

/** Linear-space HSL, the way `three` reports it in the working colour space. */
function hsl(hex) {
  const g = { h: 0, s: 0, l: 0 };
  new THREE.Color(hex).getHSL(g);
  return g;
}

/** The mean lightness and saturation of a palette's ground bands. */
function groundMean(P) {
  let l = 0;
  let s = 0;
  for (const b of P.palette.bands) {
    const g = hsl(b.color);
    l += g.l / P.palette.bands.length;
    s += g.s / P.palette.bands.length;
  }
  return { l, s };
}

/**
 * The widest gap on the hue circle between any two bands that have chroma, and
 * the saturation range across all of them.
 *
 * A band with no chroma has no meaningful hue - `getHSL` reports 0, which would
 * read as "red" and inflate the spread. Only coloured bands vote on hue.
 */
function paletteSpread(P) {
  const hues = [];
  const sats = [];
  for (const b of P.palette.bands) {
    const g = hsl(b.color);
    if (g.s > 0.02) hues.push(g.h * 360);
    sats.push(g.s * 100);
  }
  let hue = 0;
  for (const a of hues) {
    for (const b of hues) {
      const d = Math.abs(a - b);
      hue = Math.max(hue, Math.min(d, 360 - d));
    }
  }
  return { hue, sat: Math.max(...sats) - Math.min(...sats), chroma: hues.length };
}

/** Terrain min/max over the build grid. Only wanted for the airless worlds. */
function terrainRange(P) {
  const H = HEIGHT_FIELDS.planet(P.terrain);
  const step = (P.half * 2) / P.seg;
  let lo = Infinity;
  let hi = -Infinity;
  for (let j = 0; j <= P.seg; j++) {
    const z = -P.half + j * step;
    for (let i = 0; i <= P.seg; i++) {
      const y = H(-P.half + i * step, z);
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
  }
  return { lo, hi };
}

/** True where the sky is vacuum: no haze, and `fog` is a fade to the starfield. */
const isAirless = (P) => (P.sky.kind ?? 'daylight') === 'space';

test('the planet sky dome rides the camera, the way the space one does', async () => {
  /* CINDER ONLY, deliberately. `PlanetWorld._buildSky` sets `params.camera`
   * before it reads `sky.kind`, and `Sky.js`'s `update` re-centres on it in one
   * branch shared by `daylight`, `alpine` and `space`. A second planet here
   * would build a second world to walk the same three lines. */
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

test('every planet has air in front of its horizon, or a vacuum that says so', async () => {
  /* ── FOG REACHES THE CORNER ───────────────────────────────────────────
   * FLOOR, EVERY PLANET: the fog has to reach the far corner of the
   * playfield, or the far half of the map is one flat colour and there is no
   * horizon at all. That is what 760 on a 1,131 m diagonal bought on Cinder.
   *
   * CEILING, THE WORLDS WITH AIR: it must NOT reach past the camera's far
   * plane. The terrain mesh ends at +/-half and fog is what hides the edge of
   * it; fog that finishes beyond `CONFIG.render.far` leaves geometry popping
   * at the clip instead.
   *
   * ⚠ THE CEILING DOES NOT APPLY TO A VACUUM, AND IT MUST NOT BE MADE TO.
   *
   * Tessera's fog `far` is 3,960 and Lathe's is 3,620, both about 4x their own
   * diagonal, and both are deliberate: in vacuum there is no haze, so a fog
   * short enough to hide the map edge would be visible AS fog - a grey soup on
   * an airless moonlet. The authored answer is a very long fade tinted to the
   * black sky, with `terrain.rim` dropping the edge away so the world dissolves
   * into the starfield. Rewriting those two numbers to satisfy a rule written
   * for dust would undo the thing the rule exists to protect.
   *
   * So the ceiling is replaced, for those worlds, by the property the render
   * far plane is actually there for: NO GROUND MAY BE FURTHER FROM A LEGAL
   * CAMERA THAN THE FAR PLANE. That is checkable exactly - `PlanetWorld` clamps
   * the camera into a box, the terrain is a grid over the same footprint, so
   * the worst case is one corner of the box against the opposite corner of the
   * mesh - and it is the statement a long fog has to be safe against. */
  console.log('   FOG, against each planet\'s own playfield diagonal:');
  console.log('     planet      air?      diagonal   fog near..far     far/diag   camera far   worst ground');
  for (const P of ALL) {
    const D = diagonalOf(P);
    const air = !isAirless(P);
    let worst = null;
    if (!air) {
      const { lo, hi } = terrainRange(P);
      /* Worst case over the whole legal camera box: a camera in one corner at
       * one extreme of its Y clamp, ground in the opposite corner at the other
       * extreme of the terrain's own range. */
      const dy = Math.max(CAMERA_Y.max - lo, hi - CAMERA_Y.min);
      worst = Math.hypot(D, dy);
    }
    console.log(`     ${P.id.padEnd(11)} ${(air ? 'air' : 'VACUUM').padEnd(9)} ${D.toFixed(0).padStart(6)} m   `
      + `${String(P.sky.fog.near).padStart(4)}..${String(P.sky.fog.far).padEnd(6)} `
      + `${(P.sky.fog.far / D).toFixed(2).padStart(7)}x   ${String(CONFIG.render.far).padStart(6)} m`
      + (worst === null ? '' : `   ${worst.toFixed(0).padStart(6)} m`));

    assert.ok(P.sky.fog.far >= D,
      `${P.id}: fog ends at ${P.sky.fog.far} m on a ${D.toFixed(0)} m diagonal - the far half of the map is paint`);

    if (air) {
      assert.ok(P.sky.fog.far < CONFIG.render.far,
        `${P.id}: fog ends at ${P.sky.fog.far} m, past the ${CONFIG.render.far} m far plane - terrain pops at the clip`);
    } else {
      /* The airless branch, and all three halves of it are asserted rather
       * than assumed: the fog is LONG (or it is haze after all), the ground is
       * inside the far plane (or the long fog is hiding a clip), and the rim
       * is doing the work the fog is not. */
      assert.ok(P.sky.fog.far >= D * 3,
        `${P.id} is airless but its fog ends at ${P.sky.fog.far} m, only ${(P.sky.fog.far / D).toFixed(1)}x its diagonal`
        + ' - that is a haze, and in vacuum a visible haze is worse than none');
      assert.ok(worst < CONFIG.render.far,
        `${P.id}: ground can be ${worst.toFixed(0)} m from a legal camera and the far plane is ${CONFIG.render.far} m`
        + ' - the long airless fog is covering for geometry that clips');
      assert.ok((P.terrain.rim?.drop ?? 0) > 0,
        `${P.id} is airless with no \`terrain.rim\` drop - nothing takes the map edge away and the fog cannot`);
    }
  }

  /* ── THE FOG MUST NOT BE THE GROUND ───────────────────────────────────
   * Matching the ground hue is what removed Cinder's horizon: at 0x5e2c1c the
   * haze and the basalt bands under it were the same colour, so there was
   * nothing for the caldera to stand against. Measured in linear space off
   * each descriptor's OWN bands.
   *
   * A dust sky is lighter and greyer than the rock it is made of, and both
   * halves of that are asserted - for the worlds that have dust.
   *
   * ⚠ VACUUM AGAIN. Tessera's fog is #05070e and Lathe's is #0b0c0f: they are
   * the SKY, not a haze, and they are far DARKER than the ground rather than
   * lighter. Asserting "lighter" there would be asserting that an airless
   * moonlet has weather. What has to be true instead is the property the rule
   * was always for - the fog is separated from the ground so there is a
   * horizon - plus the thing that makes the separation deliberate rather than
   * a typo: the fog is the colour of the sky the map edge dissolves into.
   * Measured: |fog - background| is 0.002 on Tessera and 0.003 on Lathe,
   * against 0.13 to 0.95 for the eight worlds with air. */
  console.log('   FOG AGAINST THE GROUND IT HANGS OVER (linear space):');
  console.log('     planet      fog L   fog S   ground L  ground S   dL      dS      |fog-sky|');
  for (const P of ALL) {
    const f = hsl(P.sky.fog.color);
    const g = groundMean(P);
    const fogC = new THREE.Color(P.sky.fog.color);
    const skyC = new THREE.Color(P.sky.background ?? 0x101010);
    const toSky = Math.hypot(fogC.r - skyC.r, fogC.g - skyC.g, fogC.b - skyC.b);
    console.log(`     ${P.id.padEnd(11)} ${f.l.toFixed(3)}   ${f.s.toFixed(3)}   ${g.l.toFixed(3)}     ${g.s.toFixed(3)}`
      + `      ${(f.l - g.l >= 0 ? '+' : '')}${(f.l - g.l).toFixed(3)}  ${(f.s - g.s >= 0 ? '+' : '')}${(f.s - g.s).toFixed(3)}   ${toSky.toFixed(3)}`);

    if (!isAirless(P)) {
      assert.ok(f.l > g.l + 0.03,
        `${P.id}: the haze (L ${f.l.toFixed(3)}) is no lighter than the ground it hangs over (L ${g.l.toFixed(3)})`);
      assert.ok(f.s < g.s + 0.02,
        `${P.id}: the haze (S ${f.s.toFixed(3)}) is more saturated than the rock (S ${g.s.toFixed(3)}) - dust is greyer`);
    } else {
      assert.ok(g.l > f.l + 0.03,
        `${P.id} is airless, so its fog is the black sky and the ground must stand LIGHT against it:`
        + ` fog L ${f.l.toFixed(3)} against ground L ${g.l.toFixed(3)}`);
      assert.ok(toSky < 0.05,
        `${P.id}'s fog is ${toSky.toFixed(3)} away from its own sky background - an airless fog that is not the`
        + ' colour of the sky is a grey band across the starfield, which is the soup the long `far` exists to avoid');
    }
  }

  /* ── THE GROUND IS NOT ONE COLOUR ─────────────────────────────────────
   *
   * A tester who landed on Cinder and walked it wrote: "One flat salmon-brown
   * hue, no rock, no ash, no vents, no heat, no shadows."
   *
   * The table it describes had six bands whose HUE spanned 20 to 27 degrees
   * and whose SATURATION spanned 20 to 26 points - six shades of one colour.
   * The value structure was doing real work, which is why the caldera reads as
   * a silhouette, but value alone is a black-and-white photograph of a
   * volcano, and nothing in this file could tell the difference.
   *
   * Two floors, both measured off each descriptor rather than written down,
   * and both applying to all ten:
   *
   *   HUE SPREAD. The widest gap between any two bands, on the circle. Cinder's
   *   was 7 degrees; the floor is 40, which no accidental palette clears and
   *   any deliberate one does easily.
   *
   *   SATURATION SPREAD. Ash, oxidised ash and bare basalt are not equally
   *   colourful, and a table where they are is a tinted greyscale. Cinder's
   *   was 6 points; the floor is 15.
   *
   * The floors stay well under what is achieved, on purpose: a floor set at the
   * measurement is a change detector and this is a design constraint. What
   * catches a SHRINKING palette before it becomes a failure is the table
   * printed below, which is why the min and max across the registry are printed
   * with it.
   *
   * These sit UNDER the two fog rules above deliberately: those cap the MEAN
   * lightness and saturation, and a table can satisfy both while still being
   * one colour - which is exactly what Cinder's old one did. */
  console.log('   GROUND PALETTE (floors: 40 deg of hue, 15 points of saturation):');
  const spreads = [];
  for (const P of ALL) {
    const s = paletteSpread(P);
    spreads.push({ id: P.id, ...s });
    console.log(`     ${P.id.padEnd(11)} ${String(P.palette.bands.length).padStart(2)} bands`
      + ` (${String(s.chroma).padStart(2)} with chroma)   hue spread ${s.hue.toFixed(0).padStart(3)} deg`
      + `   saturation spread ${s.sat.toFixed(0).padStart(3)} pts`);
    assert.ok(s.chroma >= 2, `${P.id}: only ${s.chroma} of ${P.palette.bands.length} bands have any chroma at all`);
    assert.ok(s.hue >= 40,
      `${P.id}: floor 40 deg of hue across the ground bands, achieved ${s.hue.toFixed(0)} - the surface is one`
      + ' colour at several brightnesses, which is what "a flat salmon-brown field" is');
    assert.ok(s.sat >= 15,
      `${P.id}: floor 15 points of saturation across the ground bands, achieved ${s.sat.toFixed(0)}`
      + ' - ash, oxidised ash and bare basalt are not equally colourful');
  }
  const narrowestHue = spreads.reduce((a, b) => (b.hue < a.hue ? b : a));
  const narrowestSat = spreads.reduce((a, b) => (b.sat < a.sat ? b : a));
  console.log(`     narrowest palette in the registry: hue ${narrowestHue.id} ${narrowestHue.hue.toFixed(0)} deg,`
    + ` saturation ${narrowestSat.id} ${narrowestSat.sat.toFixed(0)} pts`
    + `   (widest: ${Math.max(...spreads.map((s) => s.hue)).toFixed(0)} deg, ${Math.max(...spreads.map((s) => s.sat)).toFixed(0)} pts)`);

  /* ── LIGHT ────────────────────────────────────────────────────────────
   * A terminator needs the KEY to beat the FILL. At ambient 1.05 against a sun
   * of 4.2 the ratio was 0.25, and every slope on Cinder shaded within a few
   * luma of every other. The fill/key ceiling applies to all ten: a world
   * where the ambient is a quarter of the sun has no terminator whatever it is
   * made of.
   *
   * The FLOOR under the ambient does not. On Cinder it is there because there
   * is a lava lake in the frame and bounce off it is real - a fill of zero
   * would put the unlit side into pure black, which is the "big dark room"
   * that world exists not to be. On an airless moonlet the unlit side IS pure
   * black; the brief's own description of Tessera is "overlapping crater rims
   * and shadows with nothing in them", and Tessera runs an ambient of 0.11
   * against a sun of 7.6 for exactly that. Reported for the vacuum worlds,
   * asserted for the ones with air. */
  console.log('   LIGHT (ceiling: fill/key <= 0.12 everywhere; floor: ambient >= 0.3 where there is air to scatter it):');
  for (const P of ALL) {
    const ratio = P.sky.ambient.intensity / P.sky.sun.intensity;
    console.log(`     ${P.id.padEnd(11)} ${isAirless(P) ? 'VACUUM' : 'air   '}  ambient ${String(P.sky.ambient.intensity).padStart(4)}`
      + ` / sun ${String(P.sky.sun.intensity).padStart(4)} = ${ratio.toFixed(3)}`);
    assert.ok(ratio <= 0.12,
      `${P.id}: fill/key is ${ratio.toFixed(3)}; over 0.12 there is no terminator on any slope`);
    if (!isAirless(P)) {
      assert.ok(P.sky.ambient.intensity >= 0.3,
        `${P.id}: an ambient of ${P.sky.ambient.intensity} under an atmosphere puts the shadow side of every rock`
        + ' into black - air scatters, and a world that has it should look like it does');
    }
  }
});

test('the landing pads are wayfinding, not the brightest thing on the planet', async () => {
  /* CINDER ONLY, deliberately. The two ring materials are literal
   * `MeshStandardMaterial`s in `PlanetWorld._buildLandingSites` - colour
   * 0xb9a893 with no emissive on the outer, emissive 0xffb060 at 0.5 on the
   * inner - shared unchanged by all ten planets. The amber hue window below is
   * therefore a fact about that constant, not about a volcanic palette, and
   * checking it on ten worlds would check one literal ten times.
   *
   * Measured from 190 m up, the two pad rings were the only high-chroma
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
