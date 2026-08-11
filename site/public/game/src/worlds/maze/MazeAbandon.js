/**
 * Hold-to-abandon, as pure timing.
 *
 * The spec's hard constraint is that a player four kilometres deep must never
 * be stranded, and that the control must not be fumbled mid-run - hence a HOLD
 * rather than a press. A press can be hit by accident; a two-second hold
 * cannot.
 *
 * Kept free of input, DOM and the world so the timing can be asserted in
 * milliseconds under `node --test` rather than by holding a key in a browser
 * and watching. The world drives it; `main.js` acts on it.
 */

/** Seconds the key must be held. Two, per the spec. */
export const ABANDON_HOLD_S = 2.0;

export class AbandonHold {
  /** @param {number} [seconds] */
  constructor(seconds = ABANDON_HOLD_S) {
    this.seconds = seconds;
    this._t = 0;
    this._fired = false;
  }

  /**
   * Advance one frame.
   *
   * @param {number} dt seconds
   * @param {boolean} held is the key down this frame
   * @returns {{progress: number, fired: boolean}} `fired` is true on exactly
   *   the frame the hold completes and never again while the key stays down -
   *   otherwise a held key would fire sixty times a second, and "abandon the
   *   run" is not something to do sixty times.
   */
  update(dt, held) {
    if (!held) {
      /* A release resets completely rather than decaying, so a fumble costs
       * nothing and cannot be topped up by a later tap. */
      this._t = 0;
      this._fired = false;
      return { progress: 0, fired: false };
    }
    this._t += dt;
    const progress = Math.min(1, this._t / this.seconds);
    const fired = progress >= 1 && !this._fired;
    if (fired) this._fired = true;
    return { progress, fired };
  }
}
