import * as THREE from 'three';
import { CONFIG } from '../core/Config.js';

/**
 * Stuck detection and recovery.
 *
 * Three failure modes actually happen in this game and each needs its own
 * detector, because they look nothing like each other from the outside:
 *
 * 1. **Wedged.** The player is holding a movement key, the capsule solver is
 *    ejecting them every single frame, and they travel nowhere. Note the
 *    penetration term: simply "not moving while pushing" is what walking into a
 *    wall looks like, and auto-teleporting someone who leans on a wall for two
 *    seconds would be far worse than the bug we are fixing.
 * 2. **Buried.** No input needed - the solver cannot converge, so a second
 *    `resolveCapsule` on an already-resolved position still shifts it. That is a
 *    direct, cheap read of "you are inside geometry".
 * 3. **Void.** Below the world bounds, or falling for longer than any legitimate
 *    drop in any of the three worlds.
 *
 * Recovery is a ladder, cheapest first, and every rung is *verified* before it
 * is committed: a fix that drops the player into a different wall is not a fix.
 * The last rung (the world spawn) is committed unconditionally, because there is
 * nothing below it and a guaranteed answer beats a correct one that fails.
 *
 * Yaw is preserved throughout. Being spun to face a new direction on recovery
 * is disorienting and reads as a second bug.
 */

/* Module scratch. Each helper owns its own vectors - two aliasing bugs from a
 * shared pool have already cost this project days (see Physics.js). */
const _probe = new THREE.Vector3();
const _probeOut = new THREE.Vector3();
const _cand = new THREE.Vector3();
const _support = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _spawn = new THREE.Vector3();

const P = CONFIG.player;

/** Metres of travel that proves the player is not wedged. */
const MOVE_EPSILON = 0.15;
/** Seconds of "input applied, nowhere reached, still penetrating" before we act. */
const WEDGE_TIME = 1.5;
/** Seconds of unconverged capsule penetration before we act. */
const BURIED_TIME = 1.5;
/**
 * Solver displacement on an already-resolved position that counts as
 * penetration. Generous on purpose: after `Player._move` a healthy capsule
 * probes at ~0, so anything past a few centimetres is genuinely embedded, and a
 * false positive here teleports someone who was playing normally.
 */
const PENETRATION_EPSILON = 0.06;
/** Seconds of continuous falling before we assume the floor is gone. */
const FALL_TIME = 6.0;
/** Metres below the world's own lower bound that counts as "out of the world". */
const VOID_MARGIN = 25;
/** Minimum gap between automatic recoveries, so a bad spot cannot loop. */
const AUTO_COOLDOWN = 4.0;
/** Debounce between the window key handler and the input-polled path. */
const KEY_DEBOUNCE_MS = 300;

/** Upward nudges tried by rung 1, in metres. */
const NUDGES = [0.25, 0.55, 1.0, 1.8, 3.0];
/** Ring radii tried by rung 2, in metres. */
const RINGS = [1.6, 2.8, 4.5, 7, 10, 15, 22];
/** Samples per ring. Enough angular resolution to find a doorway. */
const RING_SAMPLES = 12;

export class UnstuckSystem {
  /**
   * @param {{ bus: import('../core/EventBus.js').EventBus,
   *           player: any,
   *           physics: import('../physics/Physics.js').Physics,
   *           worldManager: any,
   *           input?: import('../core/Input.js').Input }} ctx
   */
  constructor({ bus, player, physics, worldManager, input }) {
    this.bus = bus;
    this.player = player;
    this.physics = physics;
    this.worldManager = worldManager;
    this.input = input ?? null;

    /* ---- wedge detector ---- */
    this._anchor = new THREE.Vector3().copy(player?.position ?? _spawn.set(0, 0, 0));
    this._wedgeTime = 0;
    /* ---- penetration detector ---- */
    this._buriedTime = 0;
    this._penetration = 0;
    /* ---- fall detector ---- */
    this._fallTime = 0;

    this._stuck = false;
    this._lastUnstuckAt = -999;
    this._lastKeyAt = -1e9;
    this._elapsed = 0;
    /** Automatic recovery can be turned off; `K` is unaffected either way. */
    this._autoDetect = true;

    /**
     * K is bound at the window, not polled from `Input`, because it has to work
     * in states where gameplay input is deliberately dead: pointer unlocked,
     * pause overlay up, `input.setEnabled(false)`. The polled path in
     * `fixedUpdate` stays as a redundant second route and shares the debounce.
     */
    this._onKeyDown = (e) => {
      if (e.code !== 'KeyK') return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if (this._typing()) return;
      e.preventDefault();
      this._keyUnstuck('manual');
    };
    window.addEventListener('keydown', this._onKeyDown, true);
  }

  /* ================================================================ */
  /* Contract surface                                                  */
  /* ================================================================ */

  /** True while the detectors believe the player cannot free themselves. */
  get isStuck() {
    return this._stuck;
  }

  /** Metres the capsule solver had to eject the player on the last check. */
  get penetration() {
    return this._penetration;
  }

  /** Enable/disable automatic recovery. `K` keeps working regardless. */
  setAutoDetect(on) {
    this._autoDetect = !!on;
  }

  /**
   * Detection tick. Runs after the player has moved and resolved, so the
   * penetration probe reads the *settled* position - which is exactly what makes
   * it a reliable "you are inside something" signal rather than noise.
   *
   * @param {number} dt fixed timestep, seconds
   * @param {number} elapsed engine time, seconds
   */
  fixedUpdate(dt, elapsed) {
    this._elapsed = elapsed;
    const player = this.player;
    if (!player || !this.physics) return;

    // Redundant manual path; the window handler normally gets there first and
    // the debounce swallows this one.
    if (this.input?.pressed?.('KeyK') && !this._typing()) this._keyUnstuck('manual');

    const pos = player.position;
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
      /* NaN position is unrecoverable by any nudge - go straight to spawn.
       *
       * This called `this._teleportToSpawn(...)`, which has never existed on
       * this class: the method is `_spawnFallback()`, and it returns a target
       * rather than moving anyone, so the move needs `_commit` too. The result
       * was that the one path meant to rescue a player from a NaN position
       * threw instead, every fixed step, forever - a crash loop in the
       * recovery code, reachable by any NaN position. Found while streaming a
       * 2.4 km maze, where falling into an unbuilt district is exactly how a
       * position goes NaN. */
      const target = this._spawnFallback();
      this._commit(target.position, Number.isFinite(this.player.yaw) ? this.player.yaw : 0);
      this._resetDetectors(this.player.position);
      this._stuck = false;
      this.bus?.emit('player:unstuck', {
        to: target.position.clone(),
        reason: 'invalid-position',
        method: target.method,
        label: target.label,
      });
      return;
    }

    // Detection is suspended while another system owns movement (mounts) or the
    // player is not really playing. K still works in all of those states.
    const suspended =
      player.isDead === true ||
      player.movementOverride === true ||
      player._harnessFrozen === true ||
      this.input?.textCaptured === true;

    if (suspended) {
      this._resetDetectors(pos);
      return;
    }

    this._penetration = this._measurePenetration(pos);
    const outOfWorld = this._isOutOfWorld(pos);
    const grounded = player.grounded === true;
    const moved = pos.distanceTo(this._anchor);

    /* ---- 1. wedged: pushing, penetrating, going nowhere ---------------- */
    const s = this.input?.state;
    const inputMag = s ? Math.hypot(s.forward ?? 0, s.right ?? 0) : 0;
    const pushing = inputMag > 0.1;
    if (moved > MOVE_EPSILON) {
      this._anchor.copy(pos);
      this._wedgeTime = 0;
    } else if (pushing && (this._penetration > PENETRATION_EPSILON || !grounded)) {
      this._wedgeTime += dt;
    } else {
      // Leaning on a wall while grounded is normal play, not a wedge.
      this._wedgeTime = Math.max(0, this._wedgeTime - dt * 2);
    }

    /* ---- 2. buried: solver never converges ----------------------------- */
    if (this._penetration > PENETRATION_EPSILON) this._buriedTime += dt;
    else this._buriedTime = 0;

    /* ---- 3. void: falling forever, or below the map -------------------- */
    if (!grounded && (player.velocity?.y ?? 0) < -0.5) this._fallTime += dt;
    else this._fallTime = 0;

    const wedged = this._wedgeTime >= WEDGE_TIME;
    const buried = this._buriedTime >= BURIED_TIME;
    const fell = this._fallTime >= FALL_TIME || outOfWorld;

    // `isStuck` leads the trigger so the HUD can offer "[K] Unstuck" before we
    // take the decision away from the player.
    this._stuck =
      wedged ||
      buried ||
      fell ||
      this._wedgeTime >= WEDGE_TIME * 0.6 ||
      this._buriedTime >= BURIED_TIME * 0.6;

    if (!(wedged || buried || fell)) return;
    if (!this._autoDetect) return;
    if (elapsed - this._lastUnstuckAt < AUTO_COOLDOWN) return;

    this.unstuck(fell ? (outOfWorld ? 'out-of-world' : 'falling') : buried ? 'penetration' : 'wedged');
  }

  /**
   * Recover the player. Always succeeds - the final rung is unconditional.
   *
   * @param {string} [reason] surfaced on `player:unstuck`
   * @returns {boolean} true when the player was moved
   */
  unstuck(reason = 'manual') {
    const player = this.player;
    if (!player || !player.position) return false;

    _from.copy(player.position);
    const yaw = Number.isFinite(player.yaw) ? player.yaw : 0;

    const target =
      this._tryNudgeUp(_from) ?? this._tryRingSearch(_from) ?? this._spawnFallback();

    _to.copy(target.position);
    this._commit(_to, yaw);

    this._lastUnstuckAt = this._elapsed;
    this._resetDetectors(player.position);
    this._stuck = false;

    this.bus?.emit('player:unstuck', {
      from: _from.clone(),
      to: _to.clone(),
      reason,
      method: target.method,
    });
    this.bus?.emit('hud:notify', {
      text: `Position reset  •  ${target.label}`,
      tone: 'warn',
    });
    return true;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown, true);
  }

  /* ================================================================ */
  /* Resolution ladder                                                 */
  /* ================================================================ */

  /**
   * Rung 1 - straight up. Fixes the overwhelmingly common case (feet inside a
   * floor or a kerb) for the price of a handful of capsule probes, and keeps the
   * player exactly where they were in plan view.
   */
  _tryNudgeUp(from) {
    for (const lift of NUDGES) {
      _cand.set(from.x, from.y + lift, from.z);
      if (this._isClear(_cand) && this._hasSupportBelow(_cand, lift + 4)) {
        return { position: _cand.clone(), method: 'nudge', label: 'clear of geometry' };
      }
    }
    return null;
  }

  /**
   * Rung 2 - widening ring of clear standing spots.
   *
   * The first clear hit is deliberately not taken as the answer. Someone wedged
   * in a wall at street level has the roof two metres above them, and "clear"
   * is perfectly true of the roof - it just swaps being stuck for being
   * stranded. Candidates are therefore scored on horizontal distance plus a
   * doubled weight on vertical displacement; the search returns early the
   * moment it finds a spot on the player's own floor, and otherwise keeps the
   * cheapest thing it saw.
   */
  _tryRingSearch(from) {
    let best = null;
    let bestCost = Infinity;
    let bestRadius = 0;

    for (const radius of RINGS) {
      // Rotate each ring off the last so successive rings do not resample the
      // same bearings, which is how a doorway between two spokes gets missed.
      const phase = (radius * 0.7) % (Math.PI * 2);
      for (let i = 0; i < RING_SAMPLES; i++) {
        const a = phase + (i / RING_SAMPLES) * Math.PI * 2;
        const x = from.x + Math.cos(a) * radius;
        const z = from.z + Math.sin(a) * radius;

        // NaN fallback is the "no floor here" signal; the search radius is kept
        // small so a sample over a void does not pay for 16 extra ring casts.
        const groundY = this.physics.groundHeightOrFallback(x, z, Number.NaN, 1.2);
        if (!Number.isFinite(groundY)) continue;
        const rise = Math.abs(groundY - from.y);
        // Never "rescue" the player onto a distant roof or down a shaft.
        if (rise > 24) continue;

        const cost = radius + rise * 2;
        // Cheap rejects before the two probes, which are the expensive part.
        if (cost >= bestCost) continue;

        _cand.set(x, groundY + 0.06, z);
        if (!this._isClear(_cand) || !this._hasSupportBelow(_cand, 1.2)) continue;

        best = _cand.clone();
        bestCost = cost;
        bestRadius = radius;
        // Same floor, close by - nothing further out can beat this.
        if (rise <= 1.5) break;
      }
      if (best && bestCost <= bestRadius + 3) break;
    }

    if (!best) return null;
    return {
      position: best,
      method: 'ring',
      label: `moved ${Math.max(1, Math.round(bestRadius))} m to clear ground`,
    };
  }

  /** Rung 3 - the authored spawn. Committed whether or not it probes clear. */
  _spawnFallback() {
    const world = this.worldManager?.active;
    const spawn = world?.playerSpawn;
    if (spawn && Number.isFinite(spawn.x)) _spawn.copy(spawn);
    else _spawn.set(0, 2, 0);

    const groundY = this.physics.groundHeightOrFallback(_spawn.x, _spawn.z, _spawn.y, 3);
    if (Number.isFinite(groundY)) _spawn.y = groundY + 0.06;

    // One last nudge attempt from the spawn itself: if the spawn dais has been
    // rebuilt under someone, lifting is still cheaper than shipping them inside it.
    for (const lift of NUDGES) {
      _cand.set(_spawn.x, _spawn.y + lift, _spawn.z);
      if (this._isClear(_cand)) {
        return { position: _cand.clone(), method: 'spawn', label: 'returned to spawn' };
      }
    }
    return { position: _spawn.clone(), method: 'spawn', label: 'returned to spawn' };
  }

  /** Move the player, preserving yaw, and settle the capsule at the destination. */
  _commit(position, yaw) {
    const player = this.player;
    try {
      if (typeof player.teleport === 'function') {
        player.teleport(position, yaw);
      } else {
        player.position.copy(position);
      }
    } catch (err) {
      console.error('[Unstuck] teleport failed, writing position directly:', err);
      try {
        player.position.copy(position);
      } catch {
        /* nothing left to try */
      }
    }
    // Kill residual fall velocity so a rescue from a long drop does not simply
    // punch the player back through the floor on the next step.
    const v = player.velocity;
    if (v && typeof v.set === 'function') v.set(0, 0, 0);
  }

  /* ================================================================ */
  /* Probes                                                            */
  /* ================================================================ */

  /** Capsule height to test with. Mirrors the player's current stance. */
  _capsuleHeight() {
    const h = this.player?._capsuleHeight;
    return Number.isFinite(h) && h > 0.4 ? h : P.height;
  }

  /**
   * How far the solver still wants to move an already-settled position. On solid
   * ground this is ~0; inside geometry the solver cannot converge in its four
   * iterations and this stays large every frame.
   */
  _measurePenetration(position) {
    _probe.copy(position);
    try {
      this.physics.resolveCapsule(_probe, P.radius, this._capsuleHeight());
    } catch (err) {
      console.warn('[Unstuck] penetration probe failed:', err);
      return 0;
    }
    return _probe.distanceTo(position);
  }

  /**
   * A candidate is clear when the solver barely touches it. Uses its own scratch
   * vector: `_probe` is live inside `_measurePenetration` in the same tick.
   */
  _isClear(position) {
    _probeOut.copy(position);
    try {
      this.physics.resolveCapsule(_probeOut, P.radius, this._capsuleHeight());
    } catch (err) {
      console.warn('[Unstuck] clearance probe failed:', err);
      return false;
    }
    return _probeOut.distanceTo(position) < 0.08;
  }

  /**
   * Reject candidates hanging over nothing. `_isClear` alone happily approves a
   * point in mid-air over the void, which would turn a rescue into a fall.
   */
  _hasSupportBelow(position, maxDrop) {
    _support.set(position.x, position.y + 0.1, position.z);
    try {
      return this.physics.raycast(_support, _down, maxDrop + 0.1) !== null;
    } catch (err) {
      console.warn('[Unstuck] support probe failed:', err);
      return false;
    }
  }

  /* ================================================================ */
  /* Internals                                                         */
  /* ================================================================ */

  _isOutOfWorld(position) {
    const bounds = this.worldManager?.active?.bounds;
    const floor = Number.isFinite(bounds?.min?.y) ? bounds.min.y : -100;
    return position.y < floor - VOID_MARGIN;
  }

  _resetDetectors(position) {
    if (position) this._anchor.copy(position);
    this._wedgeTime = 0;
    this._buriedTime = 0;
    this._fallTime = 0;
    this._penetration = 0;
    this._stuck = false;
  }

  /** True while a text field (chat box, dev console overlay) owns the keyboard. */
  _typing() {
    if (this.input?.textCaptured) return true;
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
  }

  /** Shared entry point for both manual routes, with a debounce between them. */
  _keyUnstuck(reason) {
    const now = performance.now();
    if (now - this._lastKeyAt < KEY_DEBOUNCE_MS) return;
    this._lastKeyAt = now;
    this.unstuck(reason);
  }
}
