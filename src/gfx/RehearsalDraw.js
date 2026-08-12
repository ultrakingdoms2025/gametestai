/**
 * Force a subtree into the renderer for a frame, then put it back exactly.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * `renderer.compile()` is only half of a shader warm. It walks `object.material`
 * and issues `linkProgram` for everything it finds, but three reads the link
 * result on a program's *first use*, not at compile time - so a program that is
 * compiled and never drawn still costs its full stall on the frame it is
 * finally drawn. Compiling issues the link; drawing is what waits for it. Both
 * have to happen behind the loading screen or neither is worth anything.
 *
 * Drawing goes through `projectObject`, which drops an object whose own
 * `visible` is false, whose *ancestor* is hidden, or which is outside the
 * frustum - of the camera and of every shadow camera. Clearing all three for a
 * couple of frames is far more reliable than posing each subsystem into a state
 * where it happens to draw: a bow's string is hidden until the bow is drawn, a
 * sword's trail until it is swung, and no amount of `setVisible(true)` on the
 * weapon reaches either.
 *
 * ── The one thing it must not touch ────────────────────────────────────────
 * Lights. Three folds the light *counts* into every program's cache key, so a
 * single stray light reaching the renderer would invalidate the whole program
 * set this exists to build - the failure that once cost this project a 63 s
 * freeze on first bow draw. Lights are skipped here, and the caller is expected
 * to run `LightRig.update()` before each rehearsal frame to re-hide anything a
 * newly-visible ancestor has exposed.
 *
 * @see ../main.js `rehearse`
 */

/**
 * @param {Array<import('three').Object3D|null|undefined>} roots
 * @returns {() => void} Restore. Always call it; it is exact and idempotent.
 */
export function forceDrawable(roots) {
  /** @type {Array<[import('three').Object3D, boolean, boolean]>} */
  const saved = [];
  /** Guards against a root that is an ancestor of another root. */
  const seen = new Set();
  for (const root of roots ?? []) {
    if (!root?.traverse) continue;
    try {
      root.traverse((o) => {
        // Never lights: their count is the shader program cache key.
        if (o.isLight) return;
        if (seen.has(o)) return;
        seen.add(o);
        if (o.visible === true && o.frustumCulled === false) return;
        saved.push([o, o.visible, o.frustumCulled]);
        o.visible = true;
        o.frustumCulled = false;
      });
    } catch {
      // One unwalkable subtree must not cost the warm every other subtree.
    }
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    // Reverse order so a node recorded twice - which `seen` already prevents,
    // but cheaply - ends on its earliest observed value.
    for (let i = saved.length - 1; i >= 0; i--) {
      const [o, visible, frustumCulled] = saved[i];
      o.visible = visible;
      o.frustumCulled = frustumCulled;
    }
  };
}
