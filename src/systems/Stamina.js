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

export class Stamina {
  /**
   * @param {{ bus: import('../core/EventBus.js').EventBus,
   *           player?: import('../player/Player.js').Player,
   *           max?: number }} ctx
   */
  constructor({ bus, player = null, max = P.maxStamina } = {}) {
    this.bus = bus ?? null;
    this.player = player ?? null;

    this._max = max;
    this._value = max;
    this._exhausted = false;
    this._lastDrainAt = -999;
    this._elapsed = 0;
    this._tickedAt = -1;
    this._emitted = max;
    this._emittedExhausted = false;
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

  /* ================================================================ */
  /* Mutation                                                          */
  /* ================================================================ */

  /**
   * Spend stamina. Always takes what is there, even if that is not enough.
   * @param {number} amount
   * @param {string} [reason]
   */
  drain(amount, reason = 'exertion') {
    if (!(amount > 0)) return 0;
    const applied = Math.min(this._value, amount);
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
   * @returns {boolean} true when the cost was paid
   */
  spend(amount, reason = 'action') {
    if (!(amount > 0)) return true;
    if (this._value < amount) return false;
    this.drain(amount, reason);
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

  /** Full pool, no exhaustion latch. */
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
