/**
 * Press-and-hold timer for the inventory's "hold to use" gesture.
 *
 * The rule is: hover a usable bag item, press and hold the primary button for
 * three seconds, and the item is used. Release early and nothing happens; a
 * plain click keeps meaning "move the stack across". This class holds the
 * timing so it can be tested against a fake clock; `InventoryUI` owns the DOM,
 * the pointer events, and the requestAnimationFrame loop that calls `advance`.
 *
 * Every method takes `now` in milliseconds from the caller (performance.now()
 * in the browser) rather than reading a clock, for the same reason.
 */

/** How long the button has to stay down before the item is used. */
export const HOLD_TO_USE_MS = 3000;

/**
 * A press released after this long is an abandoned hold, not a click. Without
 * this, changing your mind one second into a hold would move the stack across
 * on release - the very action the hold was there to keep separate.
 */
export const HOLD_ABORT_SWALLOW_MS = 350;

export class HoldToUse {
  /**
   * @param {{ duration?: number, swallowAfter?: number }} [opts]
   */
  constructor({ duration = HOLD_TO_USE_MS, swallowAfter = HOLD_ABORT_SWALLOW_MS } = {}) {
    this.duration = duration;
    this.swallowAfter = swallowAfter;
    /** @type {string|null} identity of the cell being held (zone:id) */
    this.key = null;
    this._start = 0;
    /**
     * Set when a hold either completed or ran long enough to count as
     * abandoned. The pointer is still down at that moment, so the `click` the
     * browser fires on release must be ignored; `swallowClick` is how the
     * click handler asks.
     */
    this._swallowClick = false;
  }

  get active() {
    return this.key !== null;
  }

  /**
   * Start timing a press on `key`.
   * @param {string} key
   * @param {number} now
   */
  begin(key, now) {
    this.key = key;
    this._start = now;
    this._swallowClick = false;
  }

  /**
   * Advance the clock. Returns the state to draw, and `fired: true` exactly
   * once, on the call that crosses the duration - the hold ends on that call.
   *
   * @param {number} now
   * @returns {{ progress: number, remaining: number, seconds: number, fired: boolean }}
   */
  advance(now) {
    if (!this.active) return { progress: 0, remaining: 0, seconds: 0, fired: false };
    const elapsed = Math.max(0, now - this._start);
    const progress = Math.min(1, elapsed / this.duration);
    const remaining = Math.max(0, this.duration - elapsed);
    // The number the player reads: 3, 2, 1 - never 0 while still counting.
    const seconds = Math.max(1, Math.ceil(remaining / 1000));
    if (progress >= 1) {
      this.key = null;
      this._swallowClick = true;
      return { progress: 1, remaining: 0, seconds: 0, fired: true };
    }
    return { progress, remaining, seconds, fired: false };
  }

  /**
   * End the hold without firing (release, pointer left the cell, a drag
   * started, the grid redrew). A hold that had run past `swallowAfter` marks
   * the following click as one to ignore.
   * @param {number} now
   */
  cancel(now) {
    if (!this.active) return;
    const elapsed = Math.max(0, now - this._start);
    this.key = null;
    if (elapsed >= this.swallowAfter) this._swallowClick = true;
  }

  /**
   * Asked by the click handler: should this click be dropped? The flag is
   * cleared when the pointer is released (see `release`), not here, because a
   * fired hold may redraw the grid before the click arrives, in which case no
   * click reaches the cell at all and there would be nothing to clear it.
   */
  get swallowClick() {
    return this._swallowClick;
  }

  /** The pointer came up. Whatever swallow was armed has done its job. */
  release() {
    this._swallowClick = false;
  }
}
