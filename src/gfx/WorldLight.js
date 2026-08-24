import * as THREE from 'three';

/**
 * The only way a world file is allowed to make a light.
 *
 * ── What these do, and it is one line ─────────────────────────────────────
 * They construct exactly the `THREE` light the caller asked for and then set
 * `visible = false` on it before returning. Nothing else. The argument lists
 * are `THREE`'s own, in `THREE`'s order, so `new THREE.PointLight(a, b, c, d)`
 * becomes `pointLight(a, b, c, d)` and nothing about the light changes.
 *
 * ── Why that one line is worth a module ───────────────────────────────────
 * Three keys its shader program cache on the light counts - `numPointLights`,
 * `numSpotLights`, `numDirLights` and their three shadow siblings all go into
 * `getProgramCacheKey`, and the GLSL preprocessor UNROLLS the lighting loops
 * against them. So a frame drawn with a different count shares no program with
 * the frame before it, and every material on screen is re-linked in one
 * blocking frame. Measured on this project through ANGLE/D3D11: the arrival
 * frame at sports was linking 90 programs of which 79 differed from an
 * existing key only in a scene field, and `getProgramInfoLog` - the link wait -
 * was 96% of a 30-second stall.
 *
 * `gfx/LightRig.js` is the answer to that: a fixed pool of slots added once at
 * boot, every other light in the game demoted to a `visible = false` SOURCE
 * and copied into a slot per frame, so the counts never move for the life of
 * the session. The rig hides what it finds - but it finds it on its next walk,
 * and **the frame between `new THREE.PointLight(...)` and that walk is a frame
 * in which the light counts.** One such frame is a full recompile.
 *
 * `citadel/Caves.js` and `maze/MazeChunks.js` learned this the hard way and
 * create their torches, candles and lanterns hidden, saying so in a comment
 * each. Sixty other sites across eleven world files did not. Rather than sixty
 * hand-edits - sixty chances to miss one, and a sixty-first the next time a
 * world is added - the construction itself moved here, and
 * `scripts/tests/world-light-visibility.test.mjs` forbids `new THREE.*Light(`
 * anywhere under `src/worlds/`.
 *
 * ── Why hiding a source costs nothing ─────────────────────────────────────
 * `LightRig._walk` deliberately ignores a light's OWN `visible` flag when
 * deciding whether to claim it - "the rig is what set it to false" - and only
 * skips lights under a hidden ANCESTOR. So a light born hidden is still
 * scanned, still scored, still copied into a slot, and still lights the scene
 * exactly as it did. The only difference is the frames before the rig's first
 * walk, which is the whole point.
 *
 * Everything else about the light is untouched: position, colour, intensity,
 * distance, decay, `castShadow`, `shadow.*` and `target` are the caller's, and
 * whatever owns the light goes on animating it none the wiser.
 *
 * ── What this is NOT for ──────────────────────────────────────────────────
 * Rig slots. `LightRig.buildMatchingSlots` mints the pool lights and they must
 * stay visible - they are the ones the counts are made of. They are marked
 * with `userData.__rigSlot` and the rig skips them; nothing here touches them.
 *
 * @see gfx/LightRig.js for the pool, the scoring and the measured budget.
 * @see gfx/LightAnchor.js for the other half - keeping a light's count constant
 *   while it moves like a child of something that gets hidden.
 */

/** Set once so a reader of a heap snapshot knows why a world light is dark. */
function born(light) {
  /* `projectObject` returns at `WebGLRenderer.js:1833` before `pushLight`, so
   * this - and not intensity, and not `castShadow` - is what keeps the light
   * out of the program cache key. See the module docblock. */
  light.visible = false;
  return light;
}

/**
 * A point light that is a `LightRig` source from the instant it exists.
 *
 * @param {THREE.ColorRepresentation} [color]
 * @param {number} [intensity]
 * @param {number} [distance] 0 means no cutoff, which is what `RIG_BUDGET`
 *   sizing assumes you do not do: an uncut light scores everywhere.
 * @param {number} [decay]
 * @returns {THREE.PointLight} `visible === false`
 */
export function pointLight(color, intensity, distance, decay) {
  return born(new THREE.PointLight(color, intensity, distance, decay));
}

/**
 * A spot light that is a `LightRig` source from the instant it exists.
 *
 * Its `target` is an ordinary `Object3D` the caller still has to place and
 * parent, exactly as before - the rig copies the target's world position onto
 * the slot's own target each frame.
 *
 * @param {THREE.ColorRepresentation} [color]
 * @param {number} [intensity]
 * @param {number} [distance]
 * @param {number} [angle]
 * @param {number} [penumbra]
 * @param {number} [decay]
 * @returns {THREE.SpotLight} `visible === false`
 */
export function spotLight(color, intensity, distance, angle, penumbra, decay) {
  return born(new THREE.SpotLight(color, intensity, distance, angle, penumbra, decay));
}

/**
 * A directional light that is a `LightRig` source from the instant it exists.
 *
 * Directionals are not distance-attenuated, so the rig does not score them: it
 * sorts by intensity and fills `RIG_BUDGET.dirShadow` (slot 0 is the caller's
 * sun) and `RIG_BUDGET.dirFill`. A world that sets `castShadow` here gets the
 * one assignable shadow slot, and the rig warns rather than silently dropping
 * a second one.
 *
 * @param {THREE.ColorRepresentation} [color]
 * @param {number} [intensity]
 * @returns {THREE.DirectionalLight} `visible === false`
 */
export function dirLight(color, intensity) {
  return born(new THREE.DirectionalLight(color, intensity));
}

export default { pointLight, spotLight, dirLight };
