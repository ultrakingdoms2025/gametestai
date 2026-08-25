import * as THREE from 'three';

/**
 * The sphere a skinned character is culled against.
 *
 * ── The measurement this exists for ───────────────────────────────────────
 *
 * `THREE.Frustum.intersectsObject` reads `object.boundingSphere` when the
 * object defines one and `object.geometry.boundingSphere` when it does not.
 * `SkinnedMesh` defines one — initialised to `null` — so the frustum culler
 * takes the object branch, finds `null`, and calls
 * `SkinnedMesh.computeBoundingSphere()`, which **CPU-skins every vertex of the
 * body**: four bone lookups, four `Matrix4` multiplies and a
 * `Sphere.expandByPoint` per vertex.
 *
 * Nothing ever invalidates the result, so it is paid exactly once per
 * `SkinnedMesh` — and a world crossing builds a whole new cast, so it is paid
 * once per character per crossing, on the frame that receives the world.
 * Measured on the production bundle (`frame-gaps.mjs --frames`), on the frame
 * the station arrives on:
 *
 * ```
 *   x.skinBound   123.6 ms   x27      SkinnedMesh.computeBoundingSphere
 *   x.frustum     123.9 ms   x4574    Frustum.intersectsObject
 *   postfx        141.6 ms   x1
 *   the gap       233.3 ms
 * ```
 *
 * Twenty-seven characters, 4.6 ms each, and it is 88% of the whole rendered
 * frame. On every other frame in the same run the identical 4,145 frustum tests
 * cost **0.4 ms**, because by then every sphere is cached.
 *
 * ── Why the answer is already in the geometry ─────────────────────────────
 *
 * `mergeParts` in `npc/Humanoid.js` computes the body's bind-pose sphere and
 * then pads it — with a comment that names this exact job:
 *
 *   > Animation moves vertices outside the bind pose; pad so frustum culling
 *   > and shadow bounds do not pop limbs away at the edge of the screen.
 *
 * That value has always been there and the culler has never read it, because
 * `SkinnedMesh` shadows `geometry.boundingSphere` with its own. Handing it over
 * is not a new approximation: what ships today is the skinned sphere of ONE
 * arbitrary pose — whichever pose the character happened to hold on its first
 * rendered frame — frozen for the character's life. A padded bind-pose sphere
 * is the same kind of value and a strictly larger one, so it can only ever keep
 * something on screen that the current sphere would have culled, never the
 * reverse. Culling is the only thing that reads it besides
 * `SkinnedMesh.raycast`, where a larger sphere means more candidate triangles
 * tested and never a missed hit.
 *
 * `scripts/tests/skin-bounds.test.mjs` pins the rule; `frame-gaps.mjs --frames`
 * reports `skinBounds`, which walks every live character in a real world and
 * checks the assigned sphere still contains the one three would compute — after
 * the cast has been animating, not at spawn.
 */

/**
 * Extra radius on top of the geometry's own sphere.
 *
 * `mergeParts` already pads the bind-pose sphere by 1.5 for animation, so this
 * is not that judgement made twice - it is the headroom the containment test
 * MEASURED as missing. On a rig carrying vertices at every bone of the real
 * humanoid spec, the worst pose in `skin-bounds.test.mjs` - a thigh at 86
 * degrees, which is a side splits and not a gait - escapes a 1.5-padded sphere
 * by 2.7%. 1.15 clears that by four times over.
 *
 * It is nearly free in the only direction it can be wrong: a larger sphere can
 * only keep a character on screen that a smaller one would have culled, and it
 * changes nothing at all except within one sphere-radius of the frustum plane.
 */
export const SKIN_BOUND_PAD = 1.15;

/**
 * Give a `SkinnedMesh` the bind-pose bound its geometry already carries, so the
 * frustum culler never has to skin the body on the CPU to find one.
 *
 * Safe to call on anything: a mesh with no geometry, or a geometry that cannot
 * produce a sphere, is left exactly as it was and three's own lazy path still
 * applies. Returns whether a bound was installed, so a caller that cares can
 * assert it rather than hope.
 *
 * @param {THREE.SkinnedMesh|THREE.Mesh} mesh
 * @param {number} [pad] multiplier on the radius; defaults to `SKIN_BOUND_PAD`
 * @returns {boolean}
 */
export function useBindPoseBounds(mesh, pad = SKIN_BOUND_PAD) {
  const geo = mesh?.geometry;
  if (!geo) return false;
  if (!geo.boundingSphere) geo.computeBoundingSphere?.();
  const src = geo.boundingSphere;
  if (!src || !Number.isFinite(src.radius) || src.radius < 0) return false;
  mesh.boundingSphere = new THREE.Sphere(src.center.clone(), src.radius * pad);
  return true;
}
