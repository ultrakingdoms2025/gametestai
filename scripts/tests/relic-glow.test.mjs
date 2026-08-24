import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { Relics, glowFalloff, glowScale } from '../../src/systems/Relics.js';
import { hazeAdditive } from '../../src/systems/Loot.js';

/**
 * The relic halo is a GLOW and not a card.
 *
 * ── The defect ────────────────────────────────────────────────────────────
 * `relics:glow` was a `PlaneGeometry` with a flat additive colour and no map.
 * Every texel of the quad was as bright as its middle, so what a player saw
 * was a bright SQUARE with a hard boundary: obvious walking up to one, and
 * with bloom disabled a landscape scattered with plain white rectangles. The
 * expansion did not cause it - it is shared, and there are ~470 of these at
 * 2.2 to 9.5 m across the five worlds - but it put a hundred collectables in
 * front of the player, which is what made it everybody's problem.
 *
 * ── What is asserted ──────────────────────────────────────────────────────
 * The falloff, as a pure function, and then the material that carries it. The
 * function is where the "no visible edge" property actually lives: it has to
 * reach zero at the rim of the quad and stay there, because a ramp that still
 * had a few percent left at d = 1 would put a faint square back into bloom -
 * the same defect, quieter.
 *
 * The cost is asserted too, and deliberately: this is one `InstancedMesh` of
 * `MAX_PER_WORLD` sharing one material, and the fix must not have turned it
 * into a per-instance material or a custom shader program. Those are the two
 * ways a soft halo gets expensive, and neither is visible in a screenshot.
 */

test('the halo falls to nothing before the edge of its own quad', () => {
  assert.equal(glowFalloff(0), 1, 'the core of the halo is not at full strength');

  /* Zero AT the rim and beyond it. `d` is in half-widths, so the edge of the
   * quad is 1 and its corners are 1.414 - and the corners are what read as a
   * square first, because they are the only part of a circle-shaped glow that
   * a rectangle has and a light does not. */
  assert.equal(glowFalloff(1), 0, 'the halo is still lit at the edge of its quad');
  assert.equal(glowFalloff(Math.SQRT2), 0, 'the halo is still lit in the CORNERS of its quad');
  assert.equal(glowFalloff(4), 0);

  // Never increases: a ramp with a bump in it reads as a ring, not a glow.
  let prev = Infinity;
  for (let d = 0; d <= 1.6; d += 0.005) {
    const v = glowFalloff(d);
    assert.ok(v <= prev + 1e-12, `the falloff rises again at d = ${d.toFixed(3)}`);
    assert.ok(v >= 0 && v <= 1, `the falloff is ${v} at d = ${d.toFixed(3)}`);
    prev = v;
  }

  /* And it is a RAMP rather than a disc with a hard rim, which is the thing
   * that would pass every assertion above and still look like a card with the
   * corners taken off. Sampled across the middle of the tail. */
  assert.ok(glowFalloff(0.5) > 0.35 && glowFalloff(0.5) < 0.9,
    `halfway out the halo is at ${glowFalloff(0.5).toFixed(2)} - that is a rim, not a falloff`);
  assert.ok(glowFalloff(0.85) < 0.25, 'the tail of the halo is still bright at 85% of the way out');
  // A saturated core, or the relic stops being the brightest thing in frame.
  assert.equal(glowFalloff(0.15), 1);
});

test('the halo material carries the falloff, and still costs one draw', () => {
  // The scene is the only thing `Relics` touches at construction.
  const added = [];
  const relics = new Relics({ scene: { add: (o) => added.push(o) } });

  const glow = relics.glow;
  assert.ok(glow.isInstancedMesh, 'the halo is no longer one instanced mesh');
  assert.equal(glow.name, 'relics:glow');
  assert.ok(added.includes(glow) && added.includes(relics.mesh),
    'the relic meshes were not added to the scene');
  // Two meshes, two materials, whatever the relic count is.
  assert.equal(added.length, 2, `${added.length} objects added - a mesh per relic is not affordable`);

  const mat = glow.material;
  assert.ok(mat.map, 'the halo material has no map - it is a flat card again');
  assert.equal(mat.blending, THREE.AdditiveBlending);
  assert.equal(mat.depthWrite, false);
  /* `toneMapped: false` is pinned, but NOT for the reason this line used to
   * give ("an HDR halo that is tone mapped is just a white square"). On the
   * shipped path the flag does nothing at all: three 0.185.1 only applies
   * in-shader tone mapping when the render target is null
   * (`WebGLPrograms.getParameters`), and `PostFX` renders the scene into a
   * HalfFloat composer target with ACES applied later by `OutputPass`. The
   * flag bites on exactly one path - `PostFX` disabled, `renderer.render`
   * straight to the canvas - where it WOULD clip this HDR colour to a flat
   * white square. So it is pinned as a known-latent property rather than as a
   * live defence, and the next person to reach for it should read
   * `docs/superpowers/specs/2026-08-23-orb-hunt-design.md` section 3.1 first. */
  assert.equal(mat.toneMapped, false, 'the halo stopped opting out of tone mapping');

  /* NO PRIVATE PROGRAM - which is a different claim from "no program".
   *
   * This assertion used to read `onBeforeCompile === stock.onBeforeCompile`,
   * i.e. the material patches no shader at all, and its stated reason was that
   * writing the FALLOFF RAMP in GLSL would have cost a forked program for one
   * quad type. That reason still stands and the ramp is still a texture.
   *
   * What changed is that the halo now also has to obey the scene's haze, and
   * the project has exactly one patch for that - `hazeAdditive`, shared with
   * `Loot`'s three additive layers and matching the hand-written rule in
   * `Projectiles` and `VFX`. So the guarantee worth pinning is not "stock", it
   * is "THE SHARED ONE": same function object, same cache key, so no matter
   * how many systems adopt the law the program cache still sees one entry.
   * That is strictly stronger than the old assertion, which would have passed
   * for a private copy of the same six lines. */
  const shared = hazeAdditive(new THREE.MeshBasicMaterial());
  assert.equal(typeof mat.onBeforeCompile, 'function',
    'the halo has no additive-haze patch - it will not recede with distance');
  assert.equal(mat.onBeforeCompile, shared.onBeforeCompile,
    'the halo has its OWN haze patch closure instead of the shared one');
  assert.equal(mat.customProgramCacheKey(), shared.customProgramCacheKey(),
    'the halo has its own program cache key - the cache will split');
  shared.dispose();

  /* The law itself, applied to a stub shader, because "fog: true" on its own
   * makes this WORSE and a flag assertion cannot tell the difference.
   *
   * Three's stock `<fog_fragment>` mixes toward `fogColor`. On an additive
   * quad that means a fully fogged relic ADDS haze colour at full strength -
   * a brighter dot at 880 m than at 88 m, which is the defect upside down.
   * The patch has to MULTIPLY toward zero. */
  assert.equal(mat.fog, true, 'the halo opts out of the scene fog - this is the orb defect');
  const stub = { fragmentShader: 'void main(){ #include <fog_fragment> }' };
  mat.onBeforeCompile(stub);
  assert.ok(!/mix\s*\(/.test(stub.fragmentShader),
    'the halo MIXES toward fogColor - a fogged additive quad paints haze colour, not nothing');
  assert.match(stub.fragmentShader, /\*=\s*1\.0\s*-\s*fogFactor/,
    'the halo does not multiply itself down by the fog factor');

  /* The texture, sampled where it matters: full in the middle, nothing in the
   * corner. This is the same claim as the first test, made against the bytes
   * that actually reach the GPU. */
  const { data, width: n } = mat.map.image;
  const alphaAt = (u, v) => data[((Math.min(n - 1, (v * n) | 0) * n) + Math.min(n - 1, (u * n) | 0)) * 4 + 3];
  assert.equal(alphaAt(0.5, 0.5), 255, 'the middle of the halo texture is not opaque');
  assert.equal(alphaAt(0, 0), 0, 'the corner of the halo texture is lit - that is the visible square');
  assert.equal(alphaAt(0.999, 0.999), 0);
  // The mid-edges too: those are the four sides of the square that was visible.
  assert.ok(alphaAt(0.5, 0) <= 1 && alphaAt(0, 0.5) <= 1 && alphaAt(0.999, 0.5) <= 1,
    'the halo texture reaches its own edge still lit - that is the boundary of the card');
  // ...and the ramp exists in between rather than being a hard-edged disc.
  const mid = alphaAt(0.5, 0.25);
  assert.ok(mid > 20 && mid < 240, `the halo texture goes ${mid} a quarter of the way out - no ramp`);

  relics.dispose();
});

/* ══════════════════════════════════════════════════════════════════════════
 * THE HALO'S SIZE, which is a different defect in the same quad
 *
 * ── What was wrong ────────────────────────────────────────────────────────
 * `min(2.6, 0.5 + d * 0.045) * 1.7`. The `d * 0.045` half is an APPARENT-size
 * law: a quad that grows in step with its range covers a constant number of
 * pixels. Adding it to 0.5 leaves 0.85 m of quad that does not, so the closer
 * a player got the bigger the halo grew on screen - quad width 99 px at
 * 46.67 m, 124 px at 20 m, 174 px at 9.4 m, 523 px at 2 m, in a 1600 px frame
 * at the default 75 degree fov. Two relics on adjacent Caravanserai roofs at 8.2 m and 9.6 m
 * (`output/cv-caravan-desert.jpeg`) measure 110 px and 101 px across at half
 * power with a 60 px flat top, against 9 px at half power for the same halo on
 * a souk roof 300 m away, and read as two white blobs rather than as relics.
 *
 * ── What is asserted ──────────────────────────────────────────────────────
 * The law as a pure function, because that is where the property lives and it
 * needs no GPU. Three claims carry the fix and each one can fail on its own:
 * the apparent size is CONSTANT through the band where it used to run away;
 * the far half of the curve did not move at all; and the quad is never wider
 * than it was before at any range, which is what makes this a reduction rather
 * than a re-author of a thing that already reads correctly at distance.
 */

/** The law as it shipped, kept here as the thing being ruled out. */
const oldGlowScale = (d) => Math.min(2.6, 0.5 + d * 0.045) * 1.7;

/** Pixels per radian in a 1600 px frame at the game's default 75 degree fov. */
const PX_PER_RAD = 800 / Math.tan((75 * Math.PI) / 360);

/** Where `glowFalloff` crosses half strength, in half-widths. Scanned, not
 *  asserted from memory, so the two functions are tied to each other. */
const HALF_POWER = (() => {
  let d = 0;
  for (let t = 0; t <= 1; t += 1e-5) if (glowFalloff(t) >= 0.5) d = t;
  return d;
})();

test('the halo holds one apparent size instead of running away up close', () => {
  /* 8.97 m is where the 0.5 m floor lets go and 46.67 m is where the 2.6 m
   * ceiling takes over. Between them the quad grows exactly in step with its
   * range, which is the definition of holding still on screen. */
  const arc = glowScale(20) / 20;
  for (let d = 9.0; d <= 46.6; d += 0.1) {
    assert.ok(Math.abs(glowScale(d) / d - arc) < 1e-9,
      `the halo subtends ${(glowScale(d) / d).toFixed(5)} at ${d.toFixed(1)} m`
      + ` against ${arc.toFixed(5)} at 20 m - it is still range-dependent`);
  }
  // And that one size is the size it already had at the top of the ramp.
  assert.ok(Math.abs(arc - 4.42 / 46.67) < 1e-6,
    `the held size is ${(arc * 1000).toFixed(2)} mrad, not the 94.7 mrad it had at 46.67 m`);
});

test('nothing beyond 46.67 m moved, because nothing out there was wrong', () => {
  /* The halos on the souk roofs in `output/citadel-baseline-town.jpeg` are
   * this same quad at 100-300 m and they read correctly. A fix that touched
   * them would be a re-author. */
  for (const d of [46.67, 50, 60, 100, 180, 300, 900]) {
    assert.equal(glowScale(d), oldGlowScale(d),
      `the halo at ${d} m changed size - the far half of the curve was not the defect`);
  }
  assert.ok(Math.abs(glowScale(300) - 4.42) < 1e-9, 'the far ceiling is no longer 2.6 m of quad');
});

test('the halo is never wider than it used to be, at any range', () => {
  for (let d = 0.05; d <= 600; d += 0.05) {
    assert.ok(glowScale(d) <= oldGlowScale(d) + 1e-12,
      `the halo is ${glowScale(d).toFixed(3)} m at ${d.toFixed(2)} m,`
      + ` wider than the ${oldGlowScale(d).toFixed(3)} m it was`);
  }
  // Monotone: a halo that shrank as it receded would read as a light going out.
  let prev = -Infinity;
  for (let d = 0; d <= 600; d += 0.05) {
    const w = glowScale(d);
    assert.ok(w >= prev - 1e-12, `the halo shrinks with range at ${d.toFixed(2)} m`);
    prev = w;
  }
});

test('the two Caravanserai blobs come back under the size the rest of the world reads at', () => {
  /* The two in the screenshot, solved out of their measured half-power widths
   * (101 px and 110 px at 1600 px / 75 deg) against the shipped law. */
  for (const [d, wasPx] of [[9.61, 101], [8.24, 110]]) {
    const wasFwhm = HALF_POWER * oldGlowScale(d) * PX_PER_RAD / d;
    assert.ok(Math.abs(wasFwhm - wasPx) < 3,
      `the old law puts a relic at ${d} m at ${wasFwhm.toFixed(0)} px, not the`
      + ` ${wasPx} px measured in output/cv-caravan-desert.jpeg`);
    const nowFwhm = HALF_POWER * glowScale(d) * PX_PER_RAD / d;
    assert.ok(nowFwhm < 65,
      `the blob at ${d} m is still ${nowFwhm.toFixed(0)} px across at half power`);
  }
  // Not so far the other way that a relic stops being findable.
  assert.ok(HALF_POWER * glowScale(9.61) * PX_PER_RAD / 9.61 > 40,
    'the halo at 9.6 m is now too small to be the thing a player spots');
});

test('the halo always covers the relic inside it', () => {
  /* `OctahedronGeometry(0.32)` - 0.64 m across. A quad narrower than that
   * would leave the gem sticking out of its own glow when you walk up to it,
   * which is what a naive apparent-size law does at close range. */
  for (const d of [0, 0.5, 1, 2, 5, 8.96, 9, 40, 300]) {
    assert.ok(glowScale(d) > 0.64,
      `the halo is ${glowScale(d).toFixed(3)} m at ${d} m - narrower than the 0.64 m relic`);
  }
  assert.equal(glowScale(0), 0.85, 'the near floor is not 0.5 m of quad');
});

/**
 * THE RADIANCE CEILING.
 *
 * `orb-hunt` proved this material is what five branches were chasing, and fixed
 * its fog. The fog fix left `medieval/hills-vista` with four orbs and citadel
 * untouched, because what remained was RADIANCE: a 4.42 m additive quad at
 * linear 2.88, against bloom thresholds of 1.30 (medieval) to 1.80 (dock). It
 * clipped every channel and answered cream, so the relic lost the colour that
 * says what it is.
 *
 * Two things are asserted, and the SECOND is the one that matters. Capping the
 * level is easy to get right and easy to undo; holding the HUE while capping it
 * is the part a future edit would quietly break, by dimming one channel and
 * changing what a collectible looks like.
 *
 * The ceiling is enforced by construction in `Relics.js` — `glowColour()`
 * derives the colour from the authored hue rather than storing it — so this
 * test is a floor under the construction, not the only thing holding the line.
 */
test('the halo cannot out-radiate the bloom threshold, and keeps its hue doing it', () => {
  const relics = new Relics({ scene: { add: () => {} } });
  const mat = relics.glow.material;
  assert.ok(mat, 'the glow material must exist to be measured');

  const { r: cr, g: cg, b: cb } = mat.color;
  const peak = Math.max(cr, cg, cb) * mat.opacity;

  assert.ok(peak <= 1.6 + 1e-9,
    `the halo peaks at ${peak.toFixed(4)} after opacity; the ceiling is 1.6, which is the ` +
    `coincident-sum ceiling Loot.js already pins. Above it the quad clips every channel ` +
    `through a bloom threshold of 1.30-1.80 and answers cream.`);

  /* The authored hue is 3.2 : 1.9 : 0.7. Ratios, not values: the level is
   * allowed to move and the colour is not. Dimming one channel to get under the
   * ceiling would pass the assertion above and change what a relic looks like,
   * which is a gameplay signal, not a look. */
  assert.ok(cr > 0, 'the red channel must carry the hue');
  assert.ok(Math.abs(cg / cr - 1.9 / 3.2) < 1e-6,
    `green/red is ${(cg / cr).toFixed(6)}, authored ${(1.9 / 3.2).toFixed(6)} — the hue moved`);
  assert.ok(Math.abs(cb / cr - 0.7 / 3.2) < 1e-6,
    `blue/red is ${(cb / cr).toFixed(6)}, authored ${(0.7 / 3.2).toFixed(6)} — the hue moved`);

  /* And it must still be worth seeing. Cutting a collectible until it stops
   * being findable would satisfy every assertion above. */
  assert.ok(Math.max(cr, cg, cb) > 1.0,
    'the halo must still be brighter than white paper, or the relic stops being a beacon');
});
