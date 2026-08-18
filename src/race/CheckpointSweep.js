/**
 * The swept ordered-checkpoint test, in one place.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * `RaceManager._advance` has been the only correct implementation of "did this
 * body pass the checkpoint it was supposed to pass" in the repo, and it was
 * welded to the race: it read `this.track`, `this.lapCount`, `this.clock` and
 * `this.dragonRace`, mutated the racer entry's cursor and emitted `race:lap`
 * and `race:ring` in the same thirty lines. Anything else that wanted the same
 * guarantees had to copy it, and two modules already had - `TrackRace` and
 * `SkiRun` each carried a byte-identical `segDistSq` under a "copied from
 * RaceManager.js:140" comment. A third copy is a third place for the tunnelling
 * bug to come back, so BOTH copies were deleted when this file landed and both
 * modules import {@link segDistSq} from here. That is the whole claim, and it
 * is now true: `grep -c segDistSq` finds one definition in the repo.
 *
 * So the *decision* - cursor bookkeeping, lap arithmetic, events - stays with
 * each caller, and only the *test* lives here. It is pure: no `this`, no
 * allocation, no events. Callers keep their own `_px/_pz` and update them
 * exactly where they always did.
 *
 * ── What the test buys, restated from RaceManager's header ──────────────────
 *
 *  - **Anti-tunnel.** The checkpoint is tested against the SEGMENT travelled
 *    this step, not against its end point. At 34 m/s a fixed step covers
 *    0.57 m, so a point test would be safe today - and would silently become a
 *    tunnelling bug the first time somebody widened the step or added a faster
 *    mount. On a rooftop the same trap is worse, not better: a leap crosses
 *    11.6 m/s horizontally and lands in one step.
 *  - **Anti-reverse and anti-shortcut.** Not this file's job, but this file is
 *    what makes them possible: only ONE checkpoint is ever offered to this
 *    function per body per step - the one under the caller's cursor - so every
 *    other checkpoint in the world is inert. Reversing over the line does
 *    nothing because the cursor has already moved on; cutting the infield does
 *    nothing because the skipped checkpoints were never armed.
 *  - **The y gate.** A generous vertical band rejects a bridge crossing over a
 *    line it is not part of, without demanding that the world get checkpoint
 *    heights exactly right. A checkpoint may carry its own `yGate`; when it
 *    does not, the caller supplies the fallback, because what "generous" means
 *    is a property of the contest (14 m for a car race, `radius * 0.9` for a
 *    dragon ring the player must fly through, a couple of metres for a rooftop
 *    where the deck below is a different route).
 *
 * @see ./RaceManager.js `_advance`
 * @see ../minigames/RooftopTrial.js `_advance`
 * @see ../../scripts/tests/race-checkpoint-sweep.test.mjs
 */

/**
 * Squared distance from point `p` to the segment `a`->`b`, in XZ.
 *
 * @param {number} ax
 * @param {number} az
 * @param {number} bx
 * @param {number} bz
 * @param {number} px
 * @param {number} pz
 * @returns {number}
 */
export function segDistSq(ax, az, bx, bz, px, pz) {
  const ex = bx - ax;
  const ez = bz - az;
  const e2 = ex * ex + ez * ez;
  let t = e2 > 1e-9 ? ((px - ax) * ex + (pz - az) * ez) / e2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + ex * t);
  const dz = pz - (az + ez * t);
  return dx * dx + dz * dz;
}

/**
 * Did the step from (`prevX`,`prevZ`) to (`x`,`z`) at height `y` sweep through
 * `cp`?
 *
 * The caller owns `prevX/prevZ` and must go on updating them on EVERY step,
 * including the steps this returns false on - a swept test whose tail only
 * advances on a hit degenerates into a test against the whole run.
 *
 * @param {number} prevX previous step's x
 * @param {number} prevZ previous step's z
 * @param {number} x this step's x
 * @param {number} z this step's z
 * @param {number|undefined} y this step's y; `undefined` passes the gate
 * @param {{x:number, z:number, y:number, radius:number, yGate?:number}} cp
 * @param {number} fallbackYGate used when the checkpoint names no `yGate`
 * @returns {boolean}
 */
export function sweptPass(prevX, prevZ, x, z, y, cp, fallbackYGate) {
  const d2 = segDistSq(prevX, prevZ, x, z, cp.x, cp.z);
  if (d2 > cp.radius * cp.radius) return false;
  const yGap = Math.abs((y ?? cp.y) - cp.y);
  const gate = cp.yGate > 0 ? cp.yGate : fallbackYGate;
  return yGap <= gate;
}
