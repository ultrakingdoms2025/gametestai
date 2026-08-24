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
 * ── WHAT THIS DOES TO ANYONE MEASURING WHILE IT IS IN FORCE ────────────────
 * While a rehearsal is up, EVERY object in the roots handed to it is visible
 * and `frustumCulled === false`. That is the point for the renderer and it is
 * poison for an instrument: `dev/WorldTriangles.js` treats `frustumCulled ===
 * false` as "the renderer draws this regardless", so the whole world counts as
 * in front of the camera. Measured on the sports world in the real harness:
 * 768,782 triangles across 225 drawn objects with 109 culled became 783,008
 * across 334 with 0 culled, and nothing said so.
 *
 * `boot()` in main.js activates the world - which is all `Harness.ready()` used
 * to wait for - and only THEN runs `prewarm()`, which ends in `rehearse()`,
 * which calls this. Measured on a cold headless boot: `ready()` returned at
 * 95.9 s and the game was not playable until 172.0 s, with this force-draw up
 * at 140 s, squarely inside the harness's first framings. So the flag below is
 * not a curiosity - it is how an instrument knows its numbers are about a
 * different picture. @see ../dev/Harness.js `ready`, `stats`.
 *
 * @see ../main.js `rehearse`
 */

/**
 * How many force-draws are currently up. Read it before trusting any figure
 * that depends on visibility or frustum culling.
 */
let inForce = 0;

/** @returns {number} force-draws currently in effect; 0 means the scene is honest. */
export function rehearsalInForce() {
  return inForce;
}

/**
 * @param {Array<import('three').Object3D|null|undefined>} roots
 * @returns {() => {restored:number, leftAlone:number}} Restore. Always call it;
 *   it is idempotent, and it never overwrites a value written after the
 *   snapshot - see the note on the restore itself.
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
  inForce++;
  let restored = false;
  return () => {
    if (restored) return { restored: 0, leftAlone: 0 };
    restored = true;
    inForce = Math.max(0, inForce - 1);
    let put = 0;
    let leftAlone = 0;
    /* ── THE RESTORE PUTS BACK WHAT IT CHANGED, NOT WHAT IT REMEMBERS ──────
     *
     * This used to be an exact replay of the snapshot, and being exact was the
     * bug. The snapshot is taken at one moment and replayed seconds later; the
     * window between them is long (38.6 s of rehearsal, measured) and it is
     * not private. Anything that hid an object inside that window - the review
     * harness's `--ablate`, a world's own LOD, a system parking a subtree -
     * had its write silently reverted to the pre-snapshot `true`.
     *
     * That cost four Phase 9 branches their ablation evidence: `--ablate`
     * reported "2 mesh(es) hidden", the restore put them back, and the
     * measurement afterwards was of an unablated world inside a table where
     * every other number was real.
     *
     * So: only put a value back where the CURRENT value is still the one this
     * call wrote. A later writer wins, which is the only defensible rule for a
     * bracket around a window you do not own. `leftAlone` counts the times
     * that mattered, so a caller can say so out loud rather than guess.
     *
     * Reverse order so a node recorded twice - which `seen` already prevents,
     * but cheaply - ends on its earliest observed value. */
    for (let i = saved.length - 1; i >= 0; i--) {
      const [o, visible, frustumCulled] = saved[i];
      if (o.visible === true) { o.visible = visible; put++; } else leftAlone++;
      if (o.frustumCulled === false) o.frustumCulled = frustumCulled;
    }
    return { restored: put, leftAlone };
  };
}
