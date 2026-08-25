import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { addRim, THEME_RIM } from '../../src/npc/Humanoid.js';

/* Why this file exists.
 *
 * `addRim` injects a fresnel rim and a two-colour fill into a standard
 * material. Its `customProgramCacheKey` used to fold the rim colour, strength,
 * falloff and forward term into the key:
 *
 *     rim3|16765608|0.31|4|0.62|16763052
 *
 * under the note "without a distinct cache key three would reuse the first
 * compiled program for every rim colour". It would, and that is right, because
 * it is the SAME PROGRAM: every one of those values is a uniform and nothing in
 * the injected GLSL is interpolated.
 *
 * What the per-tuple key bought was a fresh link of byte-identical shader
 * source for every distinct rim tuple. Six tuples exist in a cast (six
 * `addRim` call sites, each with its own strength multiplier and falloff), and
 * a crossing rebuilds the cast, so arriving in a world whose rim palette had
 * not been seen linked six programs on the frame the player arrives on.
 * Measured on the production bundle with `frame-gaps.mjs --cache-keys`, six of
 * the seven programs dock's first entry linked and six of medieval's seven
 * differed from a program that already existed in `customProgramCacheKey` and
 * in NOTHING else, and dock's arrival frame spent 9,459 ms inside
 * `renderBufferDirect` waiting for them.
 *
 * ── The property the collapse rests on ────────────────────────────────────
 *
 * A shared cache key is only safe while the SOURCE is identical. Three looks a
 * program up by key alone (`WebGLPrograms.acquireProgram` compares
 * `preexistingProgram.cacheKey === cacheKey` and returns the first match), so
 * two materials that produce different GLSL under one key silently share the
 * first one's shader - a wrong picture, not a slow one.
 *
 * So this file does not test the key. It tests the two facts that make one key
 * correct, and a change that breaks either fails here:
 *
 *   1. two rims differing in EVERY value produce byte-identical vertex and
 *      fragment source, and
 *   2. they still carry different uniform values, because three clones the
 *      uniforms per material before `onBeforeCompile` sees them.
 *
 * Interpolate a colour into the injected GLSL and (1) fails. Hoist a uniform
 * to a module-level object shared between materials and (2) fails.
 */

/** What three hands `onBeforeCompile`: the source, plus a uniforms bag. */
function compileShader(mat) {
  const shader = {
    vertexShader: '#include <common>\nvoid main() {}',
    fragmentShader: '#include <common>\n#include <lights_fragment_end>\n#include <opaque_fragment>',
    uniforms: {},
    defines: {},
  };
  mat.onBeforeCompile(shader, null);
  return shader;
}

/* Two rims that share nothing: different hue, different strength, different
 * falloff, different forward term, and different entries in the fill table. */
const A = () => addRim(new THREE.MeshStandardMaterial(), THEME_RIM.station.hex,
  THEME_RIM.station.strength, 4.0, { forward: 0.62, forwardHex: 0xffc8ac });
const B = () => addRim(new THREE.MeshStandardMaterial(), THEME_RIM.medieval.hex,
  THEME_RIM.medieval.strength * 0.45, 2.4);

test('two different rims compile byte-identical GLSL', () => {
  const a = compileShader(A());
  const b = compileShader(B());
  assert.equal(a.fragmentShader, b.fragmentShader,
    'the rim injects a VALUE into its shader source, so one cache key now gives two materials '
    + 'one shader - put the varying part back into customProgramCacheKey');
  assert.equal(a.vertexShader, b.vertexShader, 'the rim varies its vertex source per configuration');
});

test('the injected source is not empty - an anchor that stopped matching would also be identical', () => {
  const a = compileShader(A());
  assert.match(a.fragmentShader, /uRimColor/, 'the rim uniform declaration never landed');
  assert.match(a.fragmentShader, /uFillFwdK/, 'the fill uniform declaration never landed');
  assert.match(a.fragmentShader, /outgoingLight \+= uRimColor/, 'the rim term never landed');
  assert.match(a.fragmentShader, /irradiance \+= fillC/, 'the fill term never landed');
});

test('the uniforms are per material, which is what makes one program safe', () => {
  const a = compileShader(A());
  const b = compileShader(B());
  assert.notEqual(a.uniforms.uRimColor, b.uniforms.uRimColor,
    'two materials share one uRimColor object - every character would wear the same rim');
  assert.equal(a.uniforms.uRimColor.value.getHex(), THEME_RIM.station.hex);
  assert.equal(b.uniforms.uRimColor.value.getHex(), THEME_RIM.medieval.hex);
  assert.equal(a.uniforms.uRimStrength.value, THEME_RIM.station.strength);
  assert.notEqual(a.uniforms.uRimPower.value, b.uniforms.uRimPower.value);
  assert.notEqual(a.uniforms.uFillFwdK.value, b.uniforms.uFillFwdK.value);
  assert.notEqual(a.uniforms.uFillSky.value.getHex(), b.uniforms.uFillSky.value.getHex(),
    'both rims resolved to the same fill entry, so this pair proves nothing about the fill');
});

test('every rim keys to one program, and it is not the default key', () => {
  const a = A();
  const b = B();
  assert.equal(a.customProgramCacheKey(), b.customProgramCacheKey(),
    'a rim value is back in the cache key: every world links a fresh set of identical shaders');
  assert.equal(a.customProgramCacheKey(), 'rim3');
  /* three's default returns `onBeforeCompile.toString()`. Removing the key
   * rather than pinning it would key every rim material on the whole function
   * source, which is the same program count with a longer string. */
  const bare = new THREE.MeshStandardMaterial();
  assert.notEqual(a.customProgramCacheKey(), bare.customProgramCacheKey(),
    'a rim material and a plain one now share a cache key');
});

test('nothing else in the cast folds a per-world value into a program cache key', async () => {
  /* The same defect, looked for once rather than found again in a year. A
   * template literal in a `customProgramCacheKey` is a program per distinct
   * value; that is correct only when the same value is also baked into the
   * shader source. The character files are the ones a crossing rebuilds. */
  for (const file of ['src/npc/Humanoid.js', 'src/npc/NPC.js']) {
    const src = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
    for (const line of src.split('\n')) {
      if (!line.includes('customProgramCacheKey')) continue;
      assert.ok(!/customProgramCacheKey\s*=\s*\(\)\s*=>\s*`[^`]*\$\{/.test(line),
        `${file}: a character program cache key interpolates a value: ${line.trim()}\n`
        + '  A cast is rebuilt on every crossing, so each distinct value is a program linked on\n'
        + '  the arrival frame. Only do this if the value is also IN the shader source.');
    }
  }
});
