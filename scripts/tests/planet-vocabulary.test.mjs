import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';

const { PLANETS, LATHE, TESSERA } = await import('../../src/worlds/planets/index.js');
const { RING_OPENING_DEG } = await import('../../src/worlds/planets/Lathe.js');
const { definePlanet } = await import('../../src/worlds/planets/PlanetDescriptor.js');
const { regionDepth, inRegion, mulberry32 } = await import('../../src/worlds/planets/Placement.js');
const { SPACE_BODIES, BODY_BY_ID, STAR_DIRECTION } = await import('../../src/worlds/space/Bodies.js');
const { createSky } = await import('../../src/gfx/Sky.js');

/**
 * TWO PIECES OF VOCABULARY THAT DID NOT EXIST, AND THE TWO PLANETS THAT WERE
 * VISIBLY POORER FOR IT.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  1. THE SKY COULD NOT DRAW A RING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Sky.js`'s `space` shader drew a shaded planet disc - terminator, limb,
 * sunset band, banded cloud deck, polar caps - and no rings at any radius.
 * Lathe is a shepherd moon whose ENTIRE reason to exist is that you land, look
 * up, and Ceraunus fills the sky; its author measured the whole framing (21.27
 * degrees of angular radius, 41.95 of elevation, due south) and then had to
 * write "read this plainly: the rings are NOT in this world's sky".
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  2. THE PALETTE COULD NOT SAY "HERE"
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `palette` coloured ground by ABSOLUTE HEIGHT, plus a slope override and one
 * global mottle - three functions of the whole map. Three authors hit the same
 * wall independently: Tessera's ejecta rays are albedo and had to be built as
 * corridors of bright chips; Lathe's young crater could not have a bright floor
 * without giving one to every contour at that height; Carnelian's gorge terrace
 * and Dust Table share a band because they are four metres apart in height.
 *
 * `palette.patch` is a list of { region, color, ... } over the SAME placement
 * language the props and the minerals use.
 *
 * Everything below is derivation and geometry, checked without a browser. What
 * the screenshots show is a separate question and `.probe/shoot-vocab.mjs`
 * takes them - this file cannot and does not judge how anything looks.
 */

const SKY_SRC = readFileSync(new URL('../../src/gfx/Sky.js', import.meta.url), 'utf8');
const D2R = Math.PI / 180;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (v) => Math.hypot(v[0], v[1], v[2]);
const unit = (v) => { const l = norm(v); return [v[0] / l, v[1] / l, v[2] / l]; };

/** Linear-light Rec. 709 luma of an sRGB hex, which is what the eye ranks by. */
function luma(hex) {
  const c = new THREE.Color();
  c.setHex(hex, THREE.SRGBColorSpace);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/* ==================================================================== *
 * THE RING TERM                                                        *
 * ==================================================================== */

test('the space sky exposes a ring system, and it is OFF for every world that has none', () => {
  const sky = createSky('space', {});
  const u = sky.material.uniforms;
  for (const name of ['uRingNormal', 'uRingRadii', 'uRingColor', 'uRingDensity', 'uRingBrightness']) {
    assert.ok(u[name], `the space shader has no ${name} uniform`);
  }
  /* THE SWITCH. Nine of the ten planets ship no rings and `ringsLive()` is
   * false for all of them, so `rings()` returns on its first line and nothing
   * about their frames changes. A default of anything but zero would have been
   * a silent change to nine worlds. */
  assert.equal(u.uRingDensity.value, 0, 'rings default to ON - every ringless world just grew a ring system');
  assert.ok(u.uRingRadii.value.isVector4, 'uRingRadii must be a Vector4 (inner, outer, gapInner, gapOuter)');
  sky.dispose();
});

test('ring radii that are not (finite, inner < outer) are refused rather than reaching the shader', () => {
  /* A NaN in a ring radius reaches `ringProfile`, then the composite, then
   * `UnrealBloomPass`, where nineteen bad pixels once blacked out a
   * 921,600-pixel frame in this repository. Caught with a name attached. */
  const warned = [];
  const real = console.warn;
  console.warn = (m) => warned.push(String(m));
  try {
    for (const bad of [[1, 1, 1, 1], [2, 1, 1, 1], [NaN, 2, 1, 1], [1, Infinity, 1, 1], [1, 2, 3], 'rings', null]) {
      const sky = createSky('space', { ringRadii: bad, ringDensity: 0.5 });
      const v = sky.material.uniforms.uRingRadii.value;
      assert.ok([v.x, v.y, v.z, v.w].every(Number.isFinite),
        `ringRadii ${JSON.stringify(bad)} produced a non-finite uniform`);
      assert.ok(v.y > v.x, `ringRadii ${JSON.stringify(bad)} left outer <= inner`);
      sky.dispose();
    }
  } finally { console.warn = real; }
  assert.equal(warned.length, 7, `${warned.length} of 7 bad ring records warned; the rest were swallowed silently`);
});

test('a zero ring normal disables the term instead of dividing by zero', () => {
  const sky = createSky('space', { ringNormal: [0, 0, 0], ringDensity: 0.6 });
  const n = sky.material.uniforms.uRingNormal.value;
  assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.z),
    'normalising a zero vector produced NaN in a uniform');
  assert.equal(n.length(), 0, 'a degenerate normal must stay degenerate so ringsLive() can reject it');
  assert.match(SKY_SRC, /bool ringsLive\(\)\s*\{[\s\S]*?length\(uRingNormal\)\s*>\s*0\.5/,
    'nothing in the shader rejects a degenerate ring normal');
  sky.dispose();
});

test('every division in the ring shader has a guarded denominator', () => {
  /* THE ONE CLASS OF DEFECT THIS FEATURE CAN INTRODUCE. A ring shader
   * intersects a plane, which means it divides by a dot product, and a dot
   * product is zero for every ray parallel to that plane - a whole great circle
   * of the sky, every frame. This reads the ring block out of the shader source
   * and requires each `/` to be followed by a literal, a guard call, or a name
   * the block has already clamped.
   *
   * It is a structural check and it is deliberately strict: the alternative is
   * a second implementation of the same maths in JavaScript, which would be a
   * second thing to keep in step. */
  const start = SKY_SRC.indexOf('float ringProfile(vec3 rel)');
  const end = SKY_SRC.indexOf('// Shaded planet disc');
  assert.ok(start > 0 && end > start, 'the ring block has moved or gone');
  /* Comments out first. A block comment opens with a slash and the prose inside
   * it is full of them, so scanning the raw text finds a "division" in every
   * sentence and the check would pass by drowning. */
  const block = SKY_SRC.slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');

  /* The three ways a denominator in this block is allowed to be safe:
   *   max(/clamp(   floored at the call site;
   *   a literal     cannot be zero;
   *   mu / mu0      clamped to >= 0.015 two lines above their use;
   *   nd            the function has already RETURNED for abs(nd) < 1e-5, which
   *                 is the honest guard for this one - there is no ring to draw
   *                 along a ray parallel to the plane, so clamping would invent
   *                 a hit rather than avoid a NaN. Asserted separately below. */
  const GUARDED = new Set(['mu', 'mu0', 'nd']);
  const bad = [];
  for (const m of block.matchAll(/\/\s*(max\(|clamp\(|[A-Za-z_][A-Za-z0-9_.]*|\d[\d.]*)/g)) {
    const d = m[1];
    if (d === 'max(' || d === 'clamp(') continue;
    if (/^\d/.test(d)) continue;
    if (GUARDED.has(d)) continue;
    bad.push(d);
  }
  assert.deepEqual(bad, [], `unguarded denominators in the ring shader: ${bad.join(', ')}`);

  /* And the two rejections that are not divisions: a ray parallel to the plane,
   * and a hit behind the viewer. */
  assert.match(block, /abs\(nd\)\s*<\s*1e-5/, 'a ray parallel to the ring plane is not rejected');
  assert.match(block, /t\s*<=\s*0\.0/, 'a ring hit behind the viewer is not rejected');
});

test('the ring shadow on the planet is gated and guarded too', () => {
  const i = SKY_SRC.indexOf('THE RINGS\' SHADOW ON THE PLANET');
  assert.ok(i > 0, 'the rings cast no shadow on the planet');
  const block = SKY_SRC.slice(i, i + 1400);
  assert.match(block, /if \(ringsLive\(\)\)/, 'the shadow is not gated on the ring term being live');
  assert.match(block, /abs\(sn\)\s*>\s*1e-4/, 'a star lying in the ring plane divides by zero');
});

/* ==================================================================== *
 * LATHE: THE RINGS ARE DERIVED, AND THE ORBIT STAYED IN THE PLANE      *
 * ==================================================================== */

test("Lathe's ring record is read off Ceraunus rather than typed next to it", () => {
  const ring = BODY_BY_ID.ceraunus.ring;
  const p = LATHE.sky.params;
  assert.deepEqual(p.ringRadii, [ring.inner, ring.outer, ring.gap[0], ring.gap[1]],
    'the ring radii in the sky have parted company with the body they belong to');
  assert.equal(p.ringColor, ring.tint, 'the ring tint is a second copy');
  assert.equal(p.ringDensity, ring.density, 'the ring density is a second copy');
  assert.ok(p.ringRadii.every(Number.isFinite), 'a ring radius is not finite');
});

test("the ring normal is Ceraunus's spin axis expressed in Lathe's own frame", () => {
  const n = LATHE.sky.params.ringNormal;
  assert.ok(Math.abs(norm(n) - 1) < 1e-4, `ringNormal is not a unit vector (|n| = ${norm(n)})`);
  /* A ring plane is a body's equator, so the normal must be the spin axis - and
   * the ONLY thing a frame change may do to a unit vector is rotate it. The
   * check that it really is the same vector is the angle it makes with the
   * direction to the planet, which is frame-independent: 90 degrees minus the
   * ring opening. */
  const pd = LATHE.sky.params.planetDirection;
  const opening = Math.asin(Math.abs(dot(unit(pd), n))) / D2R;
  assert.ok(Math.abs(opening - RING_OPENING_DEG) < 1e-3,
    `the published opening (${RING_OPENING_DEG}) disagrees with the vectors (${opening.toFixed(3)})`);
});

test('THE INCLINATION DECISION: Lathe stays in the ring plane, and here is what that costs and buys', () => {
  /* This test exists to make the decision RE-VERIFIABLE rather than to make it
   * permanent. Inclining Lathe's orbit would open the rings up - and it would
   * move the moon, which moves four things `Bodies.js` documents and three test
   * files enforce. Every one of them is re-measured here, so an author who does
   * incline it finds out in one place what they have to re-solve.
   *
   * The measurement that decided it is the last block: edge-on from 2.76 body
   * radii is not a hairline, because the near arm is a foreground object. */
  const C = BODY_BY_ID.ceraunus;
  const L = BODY_BY_ID.lathe;
  const axis = unit(C.axis);
  const rel = [L.position[0] - C.position[0], L.position[1] - C.position[1], L.position[2] - C.position[2]];

  // 1. IN THE PLANE. This is the claim the whole world is built on.
  const outOfPlane = Math.abs(dot(rel, axis));
  assert.ok(outOfPlane < 1, `Lathe's centre is ${outOfPlane.toFixed(1)} m out of the ring plane; it is not a shepherd any more`);

  // 2. SURFACES MORE THAN 2*(rA + rB) APART - the painter-ordering rule.
  const sep = norm(rel);
  assert.ok(sep > 2 * (C.radius + L.radius),
    `Ceraunus and Lathe are ${(sep / 1000).toFixed(1)} km apart against a required ${(2 * (C.radius + L.radius) / 1000).toFixed(1)}`);

  // 3. A DISC RATHER THAN A STAR from the dock: >= 0.02 of screen height.
  const FOV = 75;
  const frac = (r, d) => (2 * Math.atan(r / d)) / (FOV * D2R);
  const fromDock = norm(L.position);
  assert.ok(frac(L.radius, fromDock) >= 0.02,
    `Lathe is ${frac(L.radius, fromDock).toFixed(4)} of screen height from the dock`);

  // 4. FRONT-LIT: dot(bearing, STAR_DIRECTION) < 0.35.
  assert.ok(dot(unit(L.position), STAR_DIRECTION) < 0.35, 'Lathe is back-lit from the dock');

  // 5. THE SATELLITE EXEMPTION still applies and is still not a hole.
  assert.equal(L.orbits, 'ceraunus', 'Lathe no longer declares its primary');
  const sepDeg = Math.acos(Math.min(1, dot(unit(L.position), unit(C.position)))) / D2R;
  assert.ok(sepDeg > 8, `Lathe is ${sepDeg.toFixed(1)} deg from Ceraunus; it can never be framed alone`);
  for (const b of SPACE_BODIES) {
    if (b.id === 'lathe' || b.id === 'ceraunus') continue;
    const d = Math.acos(Math.min(1, dot(unit(L.position), unit(b.position)))) / D2R;
    assert.ok(d > 25, `Lathe is only ${d.toFixed(1)} deg from ${b.name} in the sky`);
  }

  /* 6. AND WHAT EDGE-ON ACTUALLY LOOKS LIKE. The eye stands on the surface at
   *    46 degrees of colatitude from the sub-Ceraunus point, which lifts it
   *    3.74 km above the ring plane at 104.7 km from the centre - an opening of
   *    2.05 degrees. The ansae are asin(R/d) from the planet's centre and the
   *    near arm's depression below it is atan(h / (rho - R)), which is the term
   *    that makes this a band rather than a thread. */
  const eyeDist = C.radius / Math.sin(LATHE.sky.params.planetAngularRadius);
  const h = eyeDist * Math.sin(RING_OPENING_DEG * D2R);
  const rho = Math.sqrt(eyeDist * eyeDist - h * h);
  const ansa = (mult) => Math.asin(Math.min(1, (mult * C.radius) / eyeDist)) / D2R;
  const nearArm = (mult) => Math.atan2(h, rho - mult * C.radius) / D2R;

  assert.ok(Math.abs(RING_OPENING_DEG - 2.05) < 0.05, `the opening angle has moved to ${RING_OPENING_DEG}`);
  assert.ok(ansa(2.28) > 50, `the outer ansa is only ${ansa(2.28).toFixed(1)} deg from the planet's centre`);
  assert.ok(ansa(2.28) * 2 > 100, 'the ring system no longer spans a hundred degrees of sky');
  const bandWidth = nearArm(2.28) - nearArm(1.42);
  assert.ok(bandWidth > 5,
    `the near arm crosses the sky as a ${bandWidth.toFixed(1)}-degree band; under 5 it really would be a thread`);

  console.log(`   edge-on at ${RING_OPENING_DEG} deg: ansae ${ansa(1.42).toFixed(1)}-${ansa(2.28).toFixed(1)} deg `
    + `(${(ansa(2.28) * 2).toFixed(0)} deg of sky), near arm ${nearArm(1.42).toFixed(1)}-${nearArm(2.28).toFixed(1)} deg `
    + `below the centre - a ${bandWidth.toFixed(1)} deg band across a ${(LATHE.sky.params.planetAngularRadius / D2R * 2).toFixed(1)} deg disc`);
});

test('the rings are lit, and the shader is told which face is turned toward the player', () => {
  /* If the star were on the far side of the ring plane the player would be
   * looking at an UNLIT face, which the shader draws as transmission and which
   * is nearly black at this slant. It is not, and the margin is worth pinning:
   * the star stands 6.3 degrees above the plane and the eye 2.0, both on the
   * same side, which is what puts the mu0/(mu0+mu) term at 0.75. */
  const n = LATHE.sky.params.ringNormal;
  const sun = unit(LATHE.sky.params.sunDirection);
  const pd = unit(LATHE.sky.params.planetDirection);
  const sunSide = dot(sun, n);
  const eyeSide = -dot(pd, n);      // the eye's own height above the plane, in the sky frame
  assert.ok(sunSide * eyeSide > 0, 'the star and the player are on opposite faces of the rings');
  const mu0 = Math.abs(sunSide);
  const mu = Math.abs(eyeSide);
  const refl = mu0 / (mu0 + mu);
  assert.ok(refl > 0.6, `the slant-path reflectance is only ${refl.toFixed(2)} - the rings will read as a smear`);
  console.log(`   star ${(Math.asin(mu0) / D2R).toFixed(2)} deg over the ring plane, eye ${(Math.asin(mu) / D2R).toFixed(2)}`
    + ` -> mu0/(mu0+mu) = ${refl.toFixed(3)}`);
});

test('the ring is under the bloom threshold, so it glows rather than flaring', () => {
  /* The space grade thresholds at 1.60 linear. A rim over that stops reading as
   * a surface and starts reading as a lens flare - the reason Vitrine's
   * atmoStrength is 0.9 and Cinder's 0.85. The brightest a ring pixel can be is
   * its tint times the reflectance times the brightness knob. */
  const p = LATHE.sky.params;
  const c = new THREE.Color().setHex(p.ringColor, THREE.SRGBColorSpace);
  const peak = Math.max(c.r, c.g, c.b) * p.ringBrightness;   // refl <= 1 by construction
  assert.ok(peak < 1.60, `the rings peak at ${peak.toFixed(2)} linear against a 1.60 bloom threshold`);
  console.log(`   ring peak ${peak.toFixed(2)} linear (threshold 1.60)`);
});

/* ==================================================================== *
 * palette.patch - the schema                                           *
 * ==================================================================== */

/** The smallest descriptor `definePlanet` will accept, plus whatever is passed. */
function draft(palette) {
  return {
    id: 'probe', name: 'Probe', half: 100, seg: 32, gravity: 5,
    terrain: { seed: 1, baseY: 0, landforms: [{ kind: 'pad', x: 0, z: 0, r: 10 }] },
    palette: { material: 'rock.neutral', tile: 4, bands: [{ upTo: 0, color: 0x111111 }, { upTo: 10, color: 0x222222 }], ...palette },
    minerals: [{ id: 'ore', item: 'iron_ore', name: 'Ore', rarity: 'common', terrain: 'plain', place: 'The Flat', unitValue: 1, size: 1, count: 4, region: { shape: 'field' } }],
    landing: [{ id: 'pad', name: 'Pad', x: 0, z: 0, r: 10, primary: true }],
  };
}

test('palette.patch validates, defaults and freezes', () => {
  const P = definePlanet(draft({
    patch: [{ region: { shape: 'disc', x: 0, z: 0, r: 20, yMax: 4 }, color: 0xffffff }],
  }));
  const q = P.palette.patch[0];
  assert.equal(q.strength, 1, 'strength did not default to 1');
  assert.equal(q.feather, 0, 'feather did not default to 0');
  assert.equal(q.grain, 0, 'grain did not default to 0');
  assert.equal(q.grainScale, 24, 'grainScale did not default');
  assert.equal(q.id, 'patch0', 'an unnamed patch got no positional id');
  assert.ok(Object.isFrozen(q) && Object.isFrozen(q.region), 'a patch record is mutable');
  assert.equal(q.region.yMax, 4, 'the region filters were dropped on the way through');
  /* Absent means an empty list, not undefined: `_terrainColors` walks it. */
  assert.deepEqual(definePlanet(draft({})).palette.patch, [], 'a planet with no patches has no patch array');
});

test('palette.patch refuses every way a patch can be meaningless', () => {
  const refuses = (palette, why) => assert.throws(() => definePlanet(draft(palette)), /PlanetDescriptor/, why);
  refuses({ patch: {} }, 'a patch table that is not an array');
  refuses({ patch: [{ color: 0xffffff }] }, 'a patch with no region');
  refuses({ patch: [{ region: { shape: 'blob' }, color: 1 }] }, 'a region shape nobody implements');
  refuses({ patch: [{ region: { shape: 'disc', x: 0, z: 0, r: NaN }, color: 1 }] }, 'a NaN radius');
  refuses({ patch: [{ region: { shape: 'field' } }] }, 'a patch with no colour');
  refuses({ patch: [{ region: { shape: 'field' }, color: 1, strength: 0 }] }, 'a patch that changes nothing');
  refuses({ patch: [{ region: { shape: 'field' }, color: 1, strength: 1.4 }] }, 'a strength past 1');
  refuses({ patch: [{ region: { shape: 'field' }, color: 1, feather: -3 }] }, 'a negative feather');
  refuses({ patch: [{ region: { shape: 'field' }, color: 1, grain: 2 }] }, 'a grain past 1');
  refuses({ patch: [{ region: { shape: 'field' }, color: 1, grainScale: 0 }] }, 'a grain scale that divides by zero');
  refuses({ patch: [{ region: { shape: 'corridor', pts: [[0, 0]], width: 4 }, color: 1 }] }, 'a corridor of one point');
});

/* ==================================================================== *
 * regionDepth - one predicate, two consumers                           *
 * ==================================================================== */

test('regionDepth thresholded at zero IS inRegion, for every shape', () => {
  /* The patch term needs a DISTANCE (it feathers) and the scatter needs a
   * BOOLEAN. Two implementations of "is this point in this corridor" would be
   * two things to keep in step, and the first time somebody adjusted a width
   * the bright streak and the chips lying on it would part company. So the
   * boolean is the distance thresholded, and this is the proof. */
  const shapes = [
    { shape: 'disc', x: 10, z: -4, r: 30 },
    { shape: 'disc', x: 10, z: -4, r: 30, rInner: 12 },
    { shape: 'annulus', x: -6, z: 8, r0: 10, r1: 26 },
    { shape: 'rect', x0: 40, z0: -20, x1: -10, z1: 25 },
    { shape: 'corridor', pts: [[-40, -40], [0, 10], [45, 12]], width: 9 },
    { shape: 'corridor', pts: [[-40, -40], [0, 10], [45, 12]], width: 9, widthInner: 3 },
    { shape: 'field' },
  ];
  const rnd = mulberry32(20260821);
  let inside = 0;
  for (const s of shapes) {
    for (let i = 0; i < 4000; i++) {
      const x = (rnd() - 0.5) * 160;
      const z = (rnd() - 0.5) * 160;
      const d = regionDepth(s, x, z);
      assert.ok(Number.isFinite(d) || d === Infinity, `${s.shape} gave a depth of ${d}`);
      assert.equal(d >= 0, inRegion(s, x, z), `${s.shape} disagrees with itself at (${x.toFixed(1)}, ${z.toFixed(1)})`);
      if (d >= 0) inside++;
    }
  }
  assert.ok(inside > 2000, 'the sample never landed inside anything - the test is proving nothing');
});

test('a solid disc has no inner edge to feather away from', () => {
  /* The trap the signed distance introduces: min(r - d, d - rInner) with an
   * absent rInner is min(r - d, d), which is ZERO at the centre - so a
   * feathered patch over a solid disc would fade out in its own middle. */
  const solid = { shape: 'disc', x: 0, z: 0, r: 50 };
  assert.equal(regionDepth(solid, 0, 0), 50, 'a solid disc reports no depth at its centre');
  const holed = { shape: 'disc', x: 0, z: 0, r: 50, rInner: 20 };
  assert.equal(regionDepth(holed, 0, 0), -20, 'a disc with a hole is inside its own hole');
  const lane = { shape: 'corridor', pts: [[0, 0], [100, 0]], width: 10 };
  assert.equal(regionDepth(lane, 50, 0), 10, 'a solid corridor reports no depth on its centre line');
});

/* ==================================================================== *
 * The two planets that use it                                          *
 * ==================================================================== */

test('Tessera paints its rays through the SAME region records the chips are scattered in', () => {
  /* The anti-drift claim, checked by object identity rather than by comparing
   * numbers: a copied width would still pass a value comparison on the day it
   * was copied and fail silently the day one of the two was edited. */
  const props = new Map(TESSERA.props.map((p) => [p.id, p.region]));
  const patch = new Map(TESSERA.palette.patch.map((q) => [q.id, q.region]));
  for (const [propId, patchId] of [['ray_ne', 'ray_ne_albedo'], ['ray_s', 'ray_s_albedo']]) {
    const a = props.get(propId);
    const b = patch.get(patchId);
    assert.ok(a && b, `${propId}/${patchId} is missing`);
    assert.equal(a.width, b.width, `${patchId} has drifted from ${propId} in width`);
    assert.deepEqual(a.pts, b.pts, `${patchId} has drifted from ${propId} in its polyline`);
  }
  /* The cores are narrower on purpose, and they must still start on the same
   * line - a ray that starts anywhere but the crater is a streak of gravel. */
  for (const [full, core] of [['ray_ne_albedo', 'ray_ne_core'], ['ray_s_albedo', 'ray_s_core']]) {
    assert.deepEqual(patch.get(core).pts[0], patch.get(full).pts[0],
      `${core} does not begin where ${full} does`);
    assert.ok(patch.get(core).width < patch.get(full).width, `${core} is not narrower than ${full}`);
  }
});

test("Lathe paints its rays down the SAME polylines the ejecta ridges follow", () => {
  const ridges = LATHE.terrain.landforms.filter((f) => f.kind === 'ridge');
  const rays = LATHE.palette.patch.filter((q) => /^newfall_ray_\d+$/.test(q.id));
  assert.equal(rays.length, 6, `six ejecta rays, ${rays.length} painted`);
  assert.ok(ridges.length >= 6, 'the ejecta ridges have gone');
  for (const r of rays) {
    assert.ok(ridges.some((f) => JSON.stringify(f.pts) === JSON.stringify(r.region.pts)),
      `${r.id} runs down a line no ridge follows`);
  }
});

test('every patch is bright enough against the ground it lies on to be worth drawing', () => {
  /* A record nobody can see is a record that will be deleted by the next author
   * who reads the file, and the FIRST pass of this feature shipped exactly
   * that: Lathe's young crater came out DARKER than the plain round it, because
   * the colours were copied off the debris tints without measuring what they
   * would sit against. Both halves are checked:
   *
   *   1. against the BAND under the patch, which is what it replaces;
   *   2. against the brightest band the map reaches at plain level, which is
   *      what the eye compares it to across a hundred metres of ground.
   *
   * Rule 2 is the one that catches the defect and it is stated as a floor on
   * the patch COLOUR rather than on the result, because the result depends on
   * the noise. */
  /* The SAME lerp `_terrainColors` runs, because the ground between two bands
   * is a blend and comparing against a band endpoint would be comparing against
   * a colour that is only on one contour line. */
  const groundAt = (bands, y) => {
    let i = 0;
    while (i < bands.length - 1 && y > bands[i].upTo) i++;
    const lo = bands[Math.max(0, i - 1)];
    const hi = bands[i];
    const span = hi.upTo - (i > 0 ? lo.upTo : hi.upTo - 1);
    const f = i > 0 ? Math.max(0, Math.min(1, (y - lo.upTo) / (span || 1))) : 1;
    const a = new THREE.Color().setHex(lo.color, THREE.SRGBColorSpace);
    const b = new THREE.Color().setHex(hi.color, THREE.SRGBColorSpace);
    const c = a.lerp(b, f);
    return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  };
  const rows = [];
  for (const P of Object.values(PLANETS)) {
    const patches = P.palette.patch ?? [];
    if (!patches.length) continue;
    const bands = P.palette.bands;
    for (const q of patches) {
      /* Where the patch's ground IS: its own height ceiling if it declares one,
       * otherwise the datum the whole map is quoted against. Falling back to the
       * top of the band table would compare a ray lying on a plain against the
       * colour of the highest crest on the planet. */
      const y = Number.isFinite(q.region.yMax) ? q.region.yMax : P.terrain.baseY;
      const under = groundAt(bands, y);
      const mine = luma(q.color);
      rows.push(`${P.id}/${q.id.padEnd(18)} ${mine.toFixed(3)} vs ground ${under.toFixed(3)} at y ${y}`);
      /* 0.05 of linear luma, not more: an ejecta BLANKET is meant to be a wash
       * and Lathe's is deliberately about +7% over the plain. The floor this
       * catches is the one below which a record is invisible and will be
       * deleted by the next author who reads the file. */
      assert.ok(Math.abs(mine - under) > 0.05,
        `${P.id}/${q.id} is ${mine.toFixed(3)} linear against ground of ${under.toFixed(3)} - nobody will see it`);
    }
  }
  assert.ok(rows.length >= 18, `only ${rows.length} patches across the registry`);
  console.log('   ' + rows.join('\n   '));
});

test("Newfall's floor is brighter than the plain it is a hole in - the defect the transect caught", () => {
  /* MEASURED on the built field, walking due south out of Newfall's centre, in
   * linear luma: floor 0.40, inner wall 0.11, rim crest 0.48, plain 0.55-0.62.
   * The plain there stands at y 33-38 rather than the y 24 the band table calls
   * the plain, because the crater's own ejecta and its six ray ridges lift it.
   *
   * A young crater whose floor is darker than the ground round it does not read
   * as young, whatever the comment above it says. The floor colour therefore
   * has to beat the band at y 34, not the band at y 8 that it replaces. */
  const bands = LATHE.palette.bands;
  const at = (y) => { let i = 0; while (i < bands.length - 1 && y > bands[i].upTo) i++; return luma(bands[i].color); };
  const plain = at(34);
  const floor = LATHE.palette.patch.find((q) => q.id === 'newfall_floor');
  assert.ok(floor, 'Newfall has no floor patch');
  assert.ok(luma(floor.color) > plain,
    `the floor patch is ${luma(floor.color).toFixed(3)} against a plain of ${plain.toFixed(3)}`);
  assert.ok(floor.strength >= 0.7,
    `at strength ${floor.strength} the floor never gets near its own colour`);
  for (const id of ['newfall_ray_0', 'newfall_ray_0_core']) {
    const r = LATHE.palette.patch.find((q) => q.id === id);
    assert.ok(luma(r.color) > plain, `${id} is darker than the plain it crosses`);
  }
  console.log(`   plain ${plain.toFixed(3)} | floor ${luma(floor.color).toFixed(3)}`
    + ` | ray ${luma(LATHE.palette.patch.find((q) => q.id === 'newfall_ray_0').color).toFixed(3)}`);
});

test("Tessera's rays stay below the Pale Bench, which is supposed to be the bright thing", () => {
  /* The world's own value structure, stated in its palette header: the
   * anorthosite bench is "the one thing on the surface that is not a hole or
   * the rubble from one". A ray brighter than the bench would take that away,
   * so the ceiling is checked as well as the floor. */
  const bands = TESSERA.palette.bands;
  const at = (y) => { let i = 0; while (i < bands.length - 1 && y > bands[i].upTo) i++; return luma(bands[i].color); };
  const bench = at(62);
  const plain = at(26);
  for (const q of TESSERA.palette.patch) {
    assert.ok(luma(q.color) > plain + 0.10, `${q.id} is not brighter than the plain it crosses`);
    assert.ok(luma(q.color) <= bench, `${q.id} out-shines the Pale Bench (${luma(q.color).toFixed(3)} vs ${bench.toFixed(3)})`);
  }
  console.log(`   plain ${plain.toFixed(3)} < rays `
    + TESSERA.palette.patch.map((q) => luma(q.color).toFixed(3)).join('/') + ` <= bench ${bench.toFixed(3)}`);
});

test('nothing in either palette carries a value the vertex buffer cannot hold', () => {
  for (const P of Object.values(PLANETS)) {
    for (const q of P.palette.patch ?? []) {
      assert.ok(Number.isInteger(q.color) && q.color >= 0 && q.color <= 0xffffff,
        `${P.id}/${q.id} colour ${q.color} is not a 24-bit hex`);
      for (const k of ['strength', 'feather', 'grain', 'grainScale']) {
        assert.ok(Number.isFinite(q[k]), `${P.id}/${q.id}.${k} is ${q[k]}`);
      }
      for (const [k, v] of Object.entries(q.region)) {
        if (k === 'shape') continue;
        if (k === 'pts') { for (const pt of v) assert.ok(pt.every(Number.isFinite), `${P.id}/${q.id} has a non-finite point`); continue; }
        assert.ok(Number.isFinite(v), `${P.id}/${q.id}.region.${k} is ${v}`);
      }
    }
  }
});
