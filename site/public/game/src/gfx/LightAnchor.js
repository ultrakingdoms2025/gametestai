import * as THREE from 'three';

/**
 * Keep a light's *count* constant while letting it move like a child of
 * something that gets hidden or unparented.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * Three keys its shader program cache on light counts: `numDirLights`,
 * `numPointLights` and `numSpotLights` are pushed into the program cache key
 * (see `getProgramCacheKey` in three.module.js). The moment a count changes,
 * every material the renderer meets needs a *different* program, so the whole
 * visible set is recompiled in one frame.
 *
 * Two things change that count, and only one of them is obvious:
 *
 *   1. Adding or removing a light from the scene graph.
 *   2. Hiding *any ancestor* of a light. `WebGLRenderer.projectObject` starts
 *      with `if ( object.visible === false ) return;` and only then calls
 *      `currentRenderState.pushLight( object )` - so a light under a hidden
 *      group is never pushed, and the count drops exactly as if it had been
 *      removed. Verified in three 0.185.1.
 *
 * What does *not* change the count is intensity: `WebGLLights.setup` increments
 * `pointLength` / `directionalLength` / `spotLength` for every light it is
 * handed, without ever consulting `light.intensity`. A zero-intensity light is
 * therefore free of recompiles and costs only a few ALU ops per fragment.
 *
 * ── What this class does ──────────────────────────────────────────────────
 * The light is parented once to a `container` that is always in the scene and
 * always `visible`, and never moves between parents again. An empty
 * `THREE.Object3D` - the *anchor* - takes the light's old place in the model
 * hierarchy, where it costs nothing (it is not a light and not a mesh, so
 * `projectObject` ignores it entirely) but still receives a world matrix from
 * the normal scene-graph update, because `updateMatrixWorld` traverses
 * regardless of visibility.
 *
 * `sync()` then copies the anchor's world position into the container's local
 * space, so the light lands exactly where it used to sit while the count stays
 * pinned for the whole session.
 *
 * The sync is skipped while the light is dark: a light at intensity 0 affects
 * nothing, so its position does not matter, and every call site drives
 * intensity to 0 when the thing it belongs to is hidden.
 */

const _p = new THREE.Vector3();

export class AnchoredLight {
  /**
   * @param {THREE.Light} light  The light to pin. Reparented to `container`.
   * @param {THREE.Object3D} container Always-visible, always-in-scene parent.
   * @param {THREE.Object3D} anchor Empty placed where the light should appear.
   */
  constructor(light, container, anchor) {
    this.light = light;
    this.container = container;
    this.anchor = anchor;
    light.position.set(0, 0, 0);
    container.add(light);
  }

  /**
   * Move the light onto its anchor. Cheap enough to call every frame; a no-op
   * while the light is dark, which is the common case.
   */
  sync() {
    if (this.light.intensity <= 0) return;
    _p.setFromMatrixPosition(this.anchor.matrixWorld);
    this.container.worldToLocal(_p);
    this.light.position.copy(_p);
  }
}

/**
 * Convenience: build the anchor in `parent` at `position`, and pin `light` to
 * `container`.
 *
 * @param {THREE.Light} light
 * @param {THREE.Object3D} container always-visible parent for the light
 * @param {THREE.Object3D} parent where the light used to be added
 * @param {THREE.Vector3|{x:number,y:number,z:number}} [position] its old local position
 * @returns {AnchoredLight}
 */
export function anchorLight(light, container, parent, position) {
  const anchor = new THREE.Object3D();
  anchor.name = `${light.name || 'light'}:anchor`;
  if (position) anchor.position.set(position.x, position.y, position.z);
  parent.add(anchor);
  return new AnchoredLight(light, container, anchor);
}
