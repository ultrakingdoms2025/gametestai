import { CONFIG } from '../core/Config.js';

/**
 * Stamina pool: the shared currency of sprinting, swimming and climbing.
 *
 * The model is deliberately the familiar one - drain while exerting, a short
 * grace period, then a fast refill - because anything cleverer reads as the
 * game fighting the player. Two details do the heavy lifting for feel:
 *
 *   - **Exhaustion latches.** Hitting zero does not just gate sprint for one
 *     frame; it stays gated until the pool is back above `RECOVER_FRACTION`.
 *     Without that latch a player holding Shift at zero gets one sprinting
 *     frame per regen tick, which is a visible speed stutter.
 *   - **Emission is throttled.** The HUD bar is driven by `stamina:changed`,
 *     and a 60 Hz event with a 0.03 delta is pure noise; it fires on a
 *     meaningful move or a state change, and always on the boundaries.
 *
 * There is exactly one purchased modifier on the pool - the stamina draughts,
 * which scale what an exertion costs for a while. It is ONE field applied in
 * ONE place (`drain`, the funnel every exertion reaches the pool through) and
 * cleared in one place (`fixedUpdate`), because a pool with two ways to change
 * a cost is a pool nobody can predict. See `setDrainScale` for why a second
 * draught extends rather than stacks, and `drain` for why a scale of zero does
 * not touch `_lastDrainAt`.
 *
 * The pool is ticked by `Player.fixedUpdate` (it is not in `main.js`'s fixed
 * update list) and is re-entrancy safe, so an orchestrator that also ticks it
 * costs nothing.
 */

/* CONFIG is owned by nobody in particular and edited by several agents at once,
 * so the keys this system needs are defaulted in rather than assumed. An
 * explicit value in Config.js always wins. */
const P = CONFIG.player;
if (P.maxStamina === undefined) P.maxStamina = 100;
if (P.staminaRegenDelay === undefined) P.staminaRegenDelay = 0.9;
if (P.staminaRegenRate === undefined) P.staminaRegenRate = 24;
if (P.sprintStaminaDrain === undefined) P.sprintStaminaDrain = 15;
if (P.swimStaminaDrain === undefined) P.swimStaminaDrain = 2.4;
if (P.swimSprintStaminaDrain === undefined) P.swimSprintStaminaDrain = 7;
if (P.climbStaminaCost === undefined) P.climbStaminaCost = 18;

/** Fraction of the pool that must return before sprint is re-enabled. */
const RECOVER_FRACTION = 0.22;
/** Smallest change worth telling the HUD about. */
const EMIT_EPSILON = 0.4;

/**
 * The stock drain scale, and the strongest a draught may ever make it.
 *
 * `DRAIN_SCALE_NONE` is 1 - every exertion costs exactly what its caller says -
 * and it is the value the field is parked back at when a draught expires.
 * `DRAIN_SCALE_FLOOR` is 0, because the top rung of the draught ladder really
 * does pause the drain outright; the ladder's own note in `ItemUse._effectFor`
 * is where that decision is argued and where its duration is derived.
 *
 * Named rather than inlined because three places compare against them - the
 * setter's validation, the expiry in `fixedUpdate` and the getter's contract -
 * and a bare 1 in three places is three chances to disagree about what "off"
 * means.
 */
const DRAIN_SCALE_NONE = 1;
const DRAIN_SCALE_FLOOR = 0;

export class Stamina {
  /**
   * @param {{ bus: import('../core/EventBus.js').EventBus,
   *           player?: import('../player/Player.js').Player,
   *           engine?: import('../core/Engine.js').Engine,
   *           max?: number }} ctx
   */
  constructor({ bus, player = null, engine = null, max = P.maxStamina } = {}) {
    this.bus = bus ?? null;
    this.player = player ?? null;
    /**
     * READ FOR ONE THING ONLY: `_buffNow`, the play clock a stamina draught's
     * deadline is dated against. Nothing else in this file touches it, and a
     * pool built without one still ticks, drains and regenerates exactly as it
     * always has. @see _buffNow
     */
    this.engine = engine ?? null;

    this._max = max;
    this._value = max;
    this._exhausted = false;
    this._lastDrainAt = -999;
    this._elapsed = 0;
    this._tickedAt = -1;
    this._emitted = max;
    this._emittedExhausted = false;
    /**
     * What a draught is doing to every exertion in the game right now.
     *
     * 1 while nothing is running. `drain()` multiplies by it and `spend()`
     * measures affordability against it, which is the whole of the mechanism -
     * see the note over `drain` for why there is exactly one multiply and why
     * it is in that method rather than at the eight call sites.
     */
    this._drainScale = DRAIN_SCALE_NONE;
    /** Seconds of `engine.simElapsed`. @see _buffNow */
    this._drainScaleUntil = 0;
    /** Reason string of the most recent drain, for debugging and the HUD. */
    this.lastReason = null;

    // The Player builds a fallback pool if the orchestrator has not wired one
    // yet; whichever instance is constructed last is the one that counts.
    if (this.player) this.player.stamina = this;

    this._offs = [];
    if (this.bus) {
      // A respawn must not leave the player gasping on the floor.
      this._offs.push(this.bus.on('player:respawned', () => this.reset()));
      this._offs.push(this.bus.on('player:spawned', () => this.reset()));
    }
    this._emit(true);
  }

  /* ================================================================ */
  /* Accessors                                                         */
  /* ================================================================ */

  /** Current stamina, 0..max. */
  get value() {
    return this._value;
  }

  get max() {
    return this._max;
  }

  /** 0..1, for a bar. */
  get normalized() {
    return this._max > 0 ? this._value / this._max : 0;
  }

  /** True from the moment the pool empties until it has recovered a fifth. */
  get exhausted() {
    return this._exhausted;
  }

  /** Sprint gate. Player reads this every fixed step. */
  get canSprint() {
    return !this._exhausted && this._value > 0;
  }

  /** Seconds since the last drain. */
  get restedFor() {
    return this._elapsed - this._lastDrainAt;
  }

  /**
   * What every exertion is currently multiplied by. 1 while nothing is running.
   *
   * The raw field rather than a deadline comparison, exactly as
   * `SpaceCombat.spreadBolts` is and for the same reason: `fixedUpdate` is the
   * ONE place that decides a draught has ended. A getter that re-derived it
   * here would be a second opinion about the same fact, and the two would
   * disagree on any frame where one had been read and the other had not.
   *
   * @returns {number} 0..1
   */
  get drainScale() {
    return this._drainScale;
  }

  /**
   * THE BUFF CLOCK: seconds of gameplay.
   *
   * `Player._buffNow` byte for byte, and NOT `Combat._buffNow` - the difference
   * is the fallback and it matters. `Combat` has no elapsed of its own, so it
   * falls back to 0; this class does, and a draught dated against a `?? 0`
   * fallback in a build with no engine would be a deadline of `0 + 30` read
   * against a now of `0`, which never passes. So an unwired pool keeps the
   * behaviour it has always had rather than latching a buff on forever.
   *
   * `engine.simElapsed` is PLAY time: it stops while the inventory sheet the
   * draught was drunk from holds gameplay, which is the whole reason every
   * timed consumable in this game dates against it. `fixedUpdate`'s `elapsed`
   * is `engine.elapsed`, which does NOT stop - the pool's own regen delay is
   * fine on it because a paused game is not exerting either, but a purchased
   * thirty seconds measured on it would drain while the player read their bag.
   *
   * @returns {number} seconds
   */
  _buffNow() {
    return this.engine?.simElapsed ?? this._elapsed;
  }

  /* ================================================================ */
  /* Mutation                                                          */
  /* ================================================================ */

  /**
   * Spend stamina. Always takes what is there, even if that is not enough.
   *
   * ── THE ONE PLACE A DRAUGHT IS APPLIED ────────────────────────────────────
   *
   * `_drainScale` is multiplied in HERE and nowhere else, because this method
   * is the single funnel every exertion in the game goes through. Traced
   * rather than assumed, at the time the scale was added: the sprint
   * (`Player.fixedUpdate`), the swim and the swim sprint (`Swim.js`), the
   * eagle's wingbeat (`mounts/Eagle.js`), the free climb's hold and haul
   * (`FreeClimb.js`), the water and wall mantles (`Climb.js`), the ladder
   * mantle and the leap (`Climb.js`, `Parkour.js`) all reach the pool through
   * `drain` or through `spend`, and `spend` is four lines below and calls
   * `drain`. Eight callers, one multiply.
   *
   * Scaling at the call sites instead would have been eight copies of one
   * balance decision in six files, and the first one anybody forgot would be a
   * draught that silently did not cover climbing - which is one of the two
   * things stamina is actually FOR.
   *
   * ── A SCALE OF ZERO IS NOT A DRAIN OF ZERO ────────────────────────────────
   *
   * It is NO DRAIN AT ALL, and the difference is `_lastDrainAt`. Writing that
   * field suppresses regeneration for `staminaRegenDelay`, so a player holding
   * Shift under the top draught would be pinned at whatever the pool held when
   * they drank it - never losing, never recovering, for the whole duration.
   * That is not "the drain is paused", it is "the pool is frozen", and the item
   * says the former. Returning early leaves the pool refilling under a sprint,
   * which is what an exertion that costs nothing should look like.
   *
   * @param {number} amount cost BEFORE any draught is applied
   * @param {string} [reason]
   * @returns {number} what the pool actually lost
   */
  drain(amount, reason = 'exertion') {
    if (!(amount > 0)) return 0;
    const want = amount * this._drainScale;
    if (!(want > 0)) return 0;
    const applied = Math.min(this._value, want);
    this._value -= applied;
    this._lastDrainAt = this._elapsed;
    this.lastReason = reason;
    if (this._value <= 0.0001) {
      this._value = 0;
      this._exhausted = true;
    }
    return applied;
  }

  /**
   * Atomic spend for a discrete action (a mantle). Nothing is taken unless the
   * whole cost is available.
   *
   * THE AFFORDABILITY TEST IS AGAINST THE SCALED COST, and `drain` below is
   * still handed the RAW one - it applies the scale itself. Testing the raw
   * cost here would have been the funnel leaking: under a draught that pauses
   * the drain outright, a mantle costing 18 would still have been refused at 10
   * stamina while a sprint at the same moment cost nothing, and the player
   * would read that as the draught being broken rather than as two code paths
   * disagreeing. One scale, asked the same question twice.
   *
   * @returns {boolean} true when the cost was paid
   */
  spend(amount, reason = 'action') {
    if (!(amount > 0)) return true;
    if (this._value < amount * this._drainScale) return false;
    this.drain(amount, reason);
    return true;
  }

  /**
   * Run a stamina draught: scale every exertion for `duration` seconds.
   *
   * Shaped on `Player.boostSpeed` and `SpaceCombat.setGunSpread` deliberately,
   * down to the refusals and to what a second charge does. A non-positive or
   * non-finite duration is not an effect; a scale outside `[0, 1)` is not one
   * either, because 1 is the stock rate (an "effect" that grants what the
   * player already has) and anything above it would sell the player a
   * PENALTY through a path that only ever gets called by an item they paid for.
   *
   * ── A SECOND DRAUGHT EXTENDS, IT DOES NOT STACK ───────────────────────────
   * `Math.min` on the scale and `Math.max` on the deadline, which is
   * `boostSpeed`'s `Math.max`/`Math.max` read for a number where SMALLER is
   * stronger. So the better of the two scales runs for the longer of the two
   * windows, and `ActiveEffects.start` - one entry per kind, deadline forward
   * only - draws exactly one chip over it. A weak draught drunk under a strong
   * one is therefore never wasted: it buys time at the strong rate, which is
   * more than it promised, not less.
   *
   * @param {number} scale 0..1, what an exertion is multiplied by
   * @param {number} duration seconds of play time
   * @returns {boolean} false if nothing was applied
   */
  setDrainScale(scale, duration) {
    if (!(duration > 0) || !Number.isFinite(duration)) return false;
    /* `typeof` BEFORE the range test, and it is not belt-and-braces: `Number()`
     * turns `null` into 0 and `''` into 0, and 0 is the STRONGEST legal scale
     * here. A caller that passed a missing argument would be granted the top
     * rung of the ladder for free. */
    if (typeof scale !== 'number' || !Number.isFinite(scale)) return false;
    if (scale < DRAIN_SCALE_FLOOR || scale >= DRAIN_SCALE_NONE) return false;
    const s = scale;
    this._drainScale = Math.min(this._drainScale, s);
    this._drainScaleUntil = Math.max(this._drainScaleUntil, this._buffNow() + duration);
    return true;
  }

  /** Give stamina back (a pickup, a cheat, a debug key). */
  add(amount) {
    if (!(amount > 0)) return 0;
    const applied = Math.min(amount, this._max - this._value);
    this._value += applied;
    if (this._value >= this._max * RECOVER_FRACTION) this._exhausted = false;
    return applied;
  }

  /** Block regeneration until the next call to `drain`, e.g. while drowning. */
  suppressRegen(seconds = 0.35) {
    this._lastDrainAt = Math.max(this._lastDrainAt, this._elapsed - P.staminaRegenDelay + seconds);
  }

  /**
   * Full pool, no exhaustion latch.
   *
   * DELIBERATELY DOES NOT CLEAR A RUNNING DRAUGHT, and that is a decision about
   * two different things sharing one class. This method is wired to
   * `player:respawned` and `player:spawned`, and what it is for is the POOL -
   * the number a corpse should not get up holding at zero. A draught is a
   * purchased modifier dated on the play clock, and nothing about dying makes
   * the thirty seconds the player paid for stop being thirty seconds.
   *
   * That also keeps `ActiveEffects.ENDED_BY_RESPAWN` honest: that list is
   * required to name exactly what a respawn really ends, so `stamina` is
   * absent from it precisely because this line is absent from here. The two
   * must move together or the chip on screen starts lying, which is the one
   * failure the ledger exists to prevent.
   */
  reset() {
    this._value = this._max;
    this._exhausted = false;
    this._lastDrainAt = -999;
    this._emit(true);
  }

  /* ================================================================ */
  /* Tick                                                              */
  /* ================================================================ */

  /**
   * @param {number} dt fixed timestep, seconds
   * @param {number} elapsed engine time, seconds
   */
  fixedUpdate(dt, elapsed) {
    // Driven by Player; guard so an orchestrator ticking it as well is free.
    if (elapsed === this._tickedAt) return;
    this._tickedAt = elapsed;
    this._elapsed = elapsed;

    /* The draught's expiry, and the ONE place it happens - exactly as
     * `Combat.update` is for the damage boost and `SpaceCombat.update` is for
     * the gun fan. Before the regen below rather than after, so the last step
     * of a draught and the first step without one can never both be true of
     * the same `drain` call.
     *
     * `_buffNow()` and not `elapsed`: the deadline was written in play seconds
     * and has to be read in them. @see _buffNow */
    if (this._drainScale !== DRAIN_SCALE_NONE && this._buffNow() >= this._drainScaleUntil) {
      this._drainScale = DRAIN_SCALE_NONE;
    }

    if (this._value < this._max && elapsed - this._lastDrainAt >= P.staminaRegenDelay) {
      this._value = Math.min(this._max, this._value + P.staminaRegenRate * dt);
    }
    if (this._exhausted && this._value >= this._max * RECOVER_FRACTION) this._exhausted = false;

    this._emit(false);
  }

  _emit(force) {
    const moved = Math.abs(this._value - this._emitted) >= EMIT_EPSILON;
    const edge = this._value <= 0 || this._value >= this._max;
    const stateChanged = this._exhausted !== this._emittedExhausted;
    if (!force && !stateChanged && !(moved || (edge && this._emitted !== this._value))) return;
    this._emitted = this._value;
    this._emittedExhausted = this._exhausted;
    this.bus?.emit('stamina:changed', {
      stamina: this._value,
      max: this._max,
      exhausted: this._exhausted,
    });
  }

  serialize() {
    return { v: Math.round(this._value * 10) / 10, m: this._max };
  }

  deserialize(data) {
    if (!data) return;
    if (Number.isFinite(data.m)) this._max = data.m;
    if (Number.isFinite(data.v)) this._value = Math.max(0, Math.min(this._max, data.v));
    this._exhausted = this._value <= 0;
    this._emit(true);
  }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
    if (this.player?.stamina === this) this.player.stamina = null;
  }
}
