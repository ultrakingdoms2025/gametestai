/**
 * The mount wheel's aiming arithmetic, with no DOM and no stylesheet.
 *
 * ── Why this is its own file ──────────────────────────────────────────────
 *
 * `MountWheel.js` imports `mountwheel.css`, which Node cannot load, so nothing
 * in it can be reached by a test. That was tolerable while the only delta
 * source was `mousemove`. It stopped being tolerable when a second source
 * arrived: the wheel integrates `movementX/Y`, which is a **pointer-lock**
 * quantity that a touch device never produces, so the roster opened on a phone
 * and then could not be aimed at all - six mounts on screen and no way to pick
 * one.
 *
 * The gesture is identical; only the delta's provenance changes. So the
 * arithmetic moved here, where both feeders call the same function and a gate
 * can watch it, rather than being duplicated into a touch branch that would
 * drift from the mouse one. Same file split as `MountMenuLogic` and
 * `MazeMapLayout`, for the same reason.
 *
 * The three constants are the ones a player has learned by feel. They are not
 * re-tuned for touch: a thumb needs the dead zone MORE than a mouse does, since
 * an incidental tap would otherwise commit a mount.
 */

/**
 * Vector length below which no sector is chosen.
 *
 * "A hand that has not moved does not pick the sector the mouse drifted a pixel
 * towards" - and a resting thumb drifts further than a resting hand.
 */
export const AIM_DEAD_ZONE = 26;

/**
 * Ceiling on the integrated vector. Without it a long sweep leaves the vector
 * so large that coming back takes as long as it went out.
 */
export const AIM_CLAMP = 220;

/** Length at which the needle reads as fully committed. */
export const AIM_FULL = 120;

/**
 * Fold a delta into the running aim vector and resolve it to a sector.
 *
 * @param {number} vx running x, before this delta
 * @param {number} vy running y, before this delta
 * @param {number} dx this delta's x
 * @param {number} dy this delta's y
 * @param {number} sectors how many wedges the ring has
 * @returns {{vx:number, vy:number, sel:number, angle:number, reach:number, moved:boolean}}
 *   `sel` is -1 inside the dead zone; `angle` is measured with -PI/2 at twelve
 *   o'clock to match the layout; `reach` is 0 at the dead zone's edge.
 */
export function integrateAim(vx, vy, dx, dy, sectors) {
  let x = vx + (Number.isFinite(dx) ? dx : 0);
  let y = vy + (Number.isFinite(dy) ? dy : 0);
  const len = Math.hypot(x, y);

  if (len < AIM_DEAD_ZONE) {
    // Deliberately un-clamped and not `moved`: nothing has been aimed at yet,
    // so there is nothing to remember and nothing to shorten.
    return { vx: x, vy: y, sel: -1, angle: 0, reach: 0, moved: false };
  }

  if (len > AIM_CLAMP) {
    x *= AIM_CLAMP / len;
    y *= AIM_CLAMP / len;
  }

  let a = Math.atan2(y, x) + Math.PI / 2;
  if (a < 0) a += Math.PI * 2;

  return {
    vx: x,
    vy: y,
    sel: Math.round((a / (Math.PI * 2)) * sectors) % sectors,
    angle: a,
    reach: (Math.min(len, AIM_CLAMP) - AIM_DEAD_ZONE) / (AIM_FULL - AIM_DEAD_ZONE),
    moved: true,
  };
}
