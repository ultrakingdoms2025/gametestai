import * as THREE from 'three';
import { CONFIG } from '../core/Config.js';

/**
 * Stuck detection and recovery.
 *
 * FOUR failure modes actually happen in this game and each needs its own
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
 * 4. **MAROONED.** Standing on perfectly good ground with nowhere to go. The
 *    body is not in the world's way and the world is not in the body's; the
 *    TERRAIN is simply a wall in every direction. See below.
 *
 * Recovery is a ladder, cheapest first, and every rung is *verified* before it
 * is committed: a fix that drops the player into a different wall is not a fix.
 * The last rung (the world spawn) is committed unconditionally, because there is
 * nothing below it and a guaranteed answer beats a correct one that fails.
 *
 * Yaw is preserved throughout. Being spun to face a new direction on recovery
 * is disorienting and reads as a second bug.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY MODE 4 EXISTS, AND WHY THE KEY USED TO LIE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Measured on Cinder, in a real boot: land on the Rimhold Shelf pad at
 * (9, 108.5, -185), walk off the rim in any of four directions, sprint back for
 * 40 seconds, and the climb stalls at y 62-66 - between 37 and 61 m short of the
 * pad, every time. The ship is up there. There is no way back to it.
 *
 * Press K at that spot and the OLD ladder moved the player 1 cm -
 * (21.54, 63.09, -222.40) to (21.55, 63.05, -222.41) - and displayed
 * "Position reset - clear of geometry". That is `_tryNudgeUp` succeeding on rung
 * one: the player is standing on valid ground, so a 0.25 m lift probes clear and
 * has support under it, the rung "works", and the ladder never reaches the ring
 * search or the spawn. The rescue key reported a fix it had not made, which is
 * worse than no rescue key: it takes the player's last idea away from them.
 *
 * Two changes close it, and the first is the important one.
 *
 * **The nudge is only offered when there is something to nudge OUT OF.** It is
 * gated on `_isEmbedded` - real solver penetration - rather than run
 * unconditionally. A rung whose success condition is satisfied by standing on a
 * floor is not a rung, it is a rubber stamp, and it was stamping every call.
 *
 * **A body that is not embedded and cannot walk anywhere gets a RIDE, and is
 * told so in as many words.** `_recall` returns a real destination - the pad the
 * ship was last set down on, else the nearest landing site, else the world
 * spawn - and the message names it and the distance. `_walkRouteExists` floods
 * the world's own height field first so the message can tell the truth about
 * WHICH of the two situations the player is in.
 *
 * ── The manual key asks before it moves you ───────────────────────────────
 * Automatic recovery (fallen out of the world, buried, wedged) still commits
 * immediately: those states are not playable and there is nothing to consent
 * to. A manual K press on solid ground is different - the honest answer is
 * sometimes "you are not stuck", and a key that silently teleports a player who
 * pressed it out of curiosity is a fast-travel button nobody asked for on a
 * planet whose whole content is the walk. So the first press REPORTS, naming
 * the destination and whether a walking route to it exists, and a second press
 * inside {@link CONFIRM_WINDOW} takes the ride. Both messages are true.
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
const _lift = new THREE.Vector3();

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
/**
 * Seconds a manual "press K again and I will move you" offer stays open.
 *
 * Long enough to read the line and decide, short enough that a stray K minutes
 * later is a fresh question rather than a confirmation of a forgotten one.
 */
const CONFIRM_WINDOW = 8.0;
/**
 * Seconds an offer must have been standing before a press can confirm it.
 *
 * ONE PHYSICAL PRESS CAN REACH `_keyUnstuck` TWICE. There are two manual routes
 * by design - a window `keydown` listener that works while gameplay input is
 * dead, and a redundant poll of `Input.pressed` in `fixedUpdate` - and
 * {@link KEY_DEBOUNCE_MS} is what normally swallows the second. Measured in a
 * browser at 17 fps under software rendering, it does not always: a single tap
 * produced an offer AND its own confirmation, which turns a key that asks into
 * a key that acts. This is the guard that makes the question real, and it is in
 * ENGINE time rather than wall time so it cannot be outrun by a slow frame.
 */
const CONFIRM_ARM = 0.4;
/** Metres the player may drift between the offer and the confirmation. Walk away
 *  from the spot you asked about and the answer is about somewhere else. */
const CONFIRM_DRIFT = 6;

/* ================================================================== */
/* The walk probe                                                      */
/* ================================================================== */
/**
 * THE ENVELOPE THE ESCAPE PROBE WALKS IN, and it is deliberately the one
 * `scripts/tests/planet-reach.test.mjs` measures a planet with. Two probes that
 * answer "can a body walk there?" with different numbers are two probes that
 * will eventually disagree about a world nobody has changed.
 *
 * The PITCH is the one difference: 5 m rather than the test's 2 m, because this
 * one runs on a key press inside a frame. At 5 m a 12.5 deg authored road gains
 * 1.11 m per step, well inside `PROBE_MAX_RISE` 3.91, so the continuous-slope
 * branch still carries every road in the game; and the local-slope filter is
 * evaluated over half a pitch, so a 60 deg face is still not standing room.
 */
const PROBE_PITCH = 5;
const PROBE_SLOPE_TAN = Math.tan((38 * Math.PI) / 180);
const PROBE_MAX_RISE = PROBE_PITCH * PROBE_SLOPE_TAN;
/** `CONFIG.player.stepHeight`: a discrete riser a walk absorbs whole. */
const PROBE_STEP_UP = 0.45;
/** The tallest drop a route may use. Under the damage threshold, as the test's. */
const PROBE_DROP_MAX = 3.0;
/** Hard ceiling on lattice nodes visited, so a huge map cannot stall a frame. */
const PROBE_BUDGET = 40000;
/** How near the flood has to get to a destination to have arrived. */
const PROBE_ARRIVE = 8;

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

    /* ---- the marooned offer ---- */
    /** Engine time the "press K again" offer was made, or -Infinity. */
    this._offerAt = -Infinity;
    /** The destination that offer named, so the second press honours the first. */
    this._offerTo = null;
    /** The world and the spot it was made about. An offer is about a PLACE, and
     *  a confirmation that arrives on another planet is not a confirmation. */
    this._offerWorld = null;
    this._offerFrom = new THREE.Vector3();

    /**
     * WHERE THE SHIP IS, so a rescue puts the player back beside it.
     *
     * Read off the bus rather than from `Piloting`, which this system is not
     * given and should not be: the two have no other business with each other,
     * and a constructor argument for one string is a coupling that outlives its
     * reason. `pilot:landed` already carries the site, and the site id is enough
     * - the pad's position comes from the world, which is the only thing
     * entitled to say where its own pads are.
     */
    this._shipWorld = null;
    this._shipSite = null;
    this._offBus = [];
    const on = (evt, fn) => {
      const off = bus?.on?.(evt, fn);
      if (typeof off === 'function') this._offBus.push(off);
    };
    on('pilot:landed', (e) => {
      this._shipWorld = e?.world ?? null;
      this._shipSite = e?.site?.id ?? null;
    });
    /* Off the ground, or back in the hull: the pad is no longer where the ship
     * is, and a stale answer here would strand the player at an empty circle. */
    on('pilot:liftoff', () => { this._shipWorld = null; this._shipSite = null; });
    on('pilot:launched', () => { this._shipWorld = null; this._shipSite = null; });

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
   * ── THE RUNGS ARE GATED ON WHAT IS ACTUALLY WRONG ─────────────────────────
   * The nudge is offered only to a body the solver is fighting, and the ring
   * search only to one that is embedded or has nothing under it. Running them
   * unconditionally is what let a player standing on open ground be "rescued"
   * by 1 cm and told it had worked - see the design block at the top.
   *
   * @param {string} [reason] surfaced on `player:unstuck`
   * @returns {boolean} true when the player was moved
   */
  unstuck(reason = 'manual') {
    const player = this.player;
    if (!player || !player.position) return false;

    _from.copy(player.position);
    const yaw = Number.isFinite(player.yaw) ? player.yaw : 0;

    const embedded = this._isEmbedded(_from);
    const footing = this._hasSupportBelow(_from, 1.4);

    let target = null;
    if (embedded) target = this._tryNudgeUp(_from);
    if (!target && (embedded || !footing)) target = this._tryRingSearch(_from);
    if (!target) target = this._recall(_from) ?? this._spawnFallback();

    _to.copy(target.position);
    this._commit(_to, yaw);

    this._lastUnstuckAt = this._elapsed;
    this._offerAt = -Infinity;
    this._offerTo = null;
    this._offerWorld = null;
    this._resetDetectors(player.position);
    this._stuck = false;

    this.bus?.emit('player:unstuck', {
      from: _from.clone(),
      to: _to.clone(),
      reason,
      method: target.method,
      label: target.label,
    });
    this.bus?.emit('hud:notify', {
      /* The verb matches the rung. "Position reset" over a 1 cm nudge and over a
       * 300 m ride is the same sentence for two different events, and the player
       * cannot tell from it which one happened. */
      text: target.headline ?? `Position reset  •  ${target.label}`,
      tone: 'warn',
    });
    return true;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown, true);
    for (const off of this._offBus) {
      try { off(); } catch { /* a bus that has gone is a bus we are done with */ }
    }
    this._offBus.length = 0;
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

        /* CAST FROM THE PLAYER'S OWN STOREY, not from the sky. A ring sample
         * asked at y 400 answers with the first surface it meets, which under a
         * roof is the roof - the same defect that put a body on top of the
         * Lodestar Yard's hangar. Starting 2.5 m over the player's head finds
         * the floor they are on and nothing above it. The sky query stays as the
         * fallback for a player who is genuinely in mid-air over open ground.
         *
         * NaN is the "no floor here" signal; the search radius is kept small so
         * a sample over a void does not pay for 16 extra ring casts. */
        const near = this.physics.groundHeight(x, z, from.y + 2.5, 60);
        const groundY = Number.isFinite(near)
          ? near
          : this.physics.groundHeightOrFallback(x, z, Number.NaN, 1.2);
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

  /**
   * Rung 3 - A RIDE TO SOMEWHERE THAT MATTERS.
   *
   * This is the rung the marooned case needs and the one the ladder never had.
   * The player is not stuck IN anything; they are stuck ON something, and the
   * only help that helps is a destination. In order:
   *
   *   1. the pad the ship was last set down on, if it is on this world - the
   *      player's problem is almost always "I cannot get back to my ship", and
   *      any other pad solves the geometry while leaving the problem;
   *   2. the nearest recovery point the world publishes;
   *   3. nothing, and the caller falls through to the spawn.
   *
   * The label names the place and the distance, because "you have been moved"
   * without either is the same information as "something happened".
   */
  _recall(from) {
    const world = this.worldManager?.active;
    const points = this._recoveryPoints(world);
    if (!points.length) return null;

    let best = null;
    let bestD = Infinity;
    const shipHere = this._shipSite && this._shipWorld && this._shipWorld === world?.id;
    for (const p of points) {
      if (shipHere && p.id === this._shipSite) { best = p; bestD = from.distanceTo(p.position); break; }
      const d = from.distanceTo(p.position);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (!best) return null;

    _cand.copy(best.position);
    const groundY = this._groundOnStorey(_cand.x, _cand.z, _cand.y);
    if (Number.isFinite(groundY)) _cand.y = groundY + 0.35;
    /* Lift out of anything standing on the pad - a mooring post, a hull - the
     * same way the spawn rung does, and for the same reason.
     *
     * `_lift` and not `_probeOut`: `_isClear` copies its argument INTO
     * `_probeOut` and then measures the distance back to it, so handing it
     * `_probeOut` makes it measure a vector against itself, which is zero, which
     * is "clear" - every time, everywhere, including inside a wall. That is the
     * aliasing bug this file's scratch-pool note is about. */
    for (const lift of NUDGES) {
      _lift.set(_cand.x, _cand.y + lift, _cand.z);
      if (this._isClear(_lift)) { _cand.copy(_lift); break; }
    }
    const km = bestD >= 1000 ? `${(bestD / 1000).toFixed(1)} km` : `${Math.round(bestD)} m`;
    const mine = shipHere && best.id === this._shipSite;
    return {
      position: _cand.clone(),
      method: 'recall',
      label: `carried ${km} to ${best.name}${mine ? ', where your ship is' : ''}`,
      headline: `Recovered ${km} to ${best.name}${mine ? '  •  your ship is here' : ''}`,
    };
  }

  /**
   * Where a world says a stranded body may be put down, best first.
   *
   * A world may publish `recoveryPoints()` itself. Everything else is derived
   * rather than required, so a world written before this existed still has an
   * answer: landing pads if it has them, the authored spawn otherwise.
   */
  _recoveryPoints(world) {
    if (typeof world?.recoveryPoints === 'function') {
      try {
        const list = world.recoveryPoints();
        if (Array.isArray(list) && list.length) return list;
      } catch (err) {
        console.warn('[Unstuck] world.recoveryPoints() failed:', err);
      }
    }
    const sites = world?.landingSites;
    if (Array.isArray(sites) && sites.length) {
      return sites.map((s) => ({
        id: s.id,
        name: s.name ?? s.id,
        /* Off the centre marker by the same fraction of the radius `PlanetWorld`
         * spawns at, so a recall lands where an arrival lands rather than under
         * whatever is parked on the middle of the disc. */
        position: new THREE.Vector3(
          s.position.x,
          s.position.y + 0.4,
          s.position.z + (s.radius ?? 0) * 0.45
        ),
      }));
    }
    const spawn = world?.playerSpawn;
    if (spawn && Number.isFinite(spawn.x)) {
      return [{ id: 'spawn', name: 'the arrival point', position: spawn.clone() }];
    }
    return [];
  }

  /**
   * GROUND HEIGHT ON THE STOREY THE POINT IS ALREADY ON.
   *
   * `groundHeightOrFallback` casts from y 400 and returns the FIRST thing it
   * hits, which inside a roofed world is the roof. Measured in the Lodestar
   * Yard: the authored spawn is (0, 0.3, 46), the shed's roof plate is a real
   * collider at y 26.8 over the whole of it, and a recovery that asked for "the
   * ground at the spawn" was answered with the roof - so a player who fell out
   * of the bay mouth was set down 26 m in the air on top of the hangar, walked
   * to the roof cut, and fell through it for 69 damage.
   *
   * An authored point already knows which floor it is on. Cast from just above
   * it and only far enough to find that floor; the sky query stays as the
   * fallback for a point authored in mid-air.
   */
  _groundOnStorey(x, z, y) {
    const near = this.physics?.groundHeight?.(x, z, y + 3, 40);
    if (Number.isFinite(near)) return near;
    const far = this.physics?.groundHeightOrFallback?.(x, z, y, 3);
    return Number.isFinite(far) ? far : y;
  }

  /** Rung 4 - the authored spawn. Committed whether or not it probes clear. */
  _spawnFallback() {
    const world = this.worldManager?.active;
    const spawn = world?.playerSpawn;
    if (spawn && Number.isFinite(spawn.x)) _spawn.copy(spawn);
    else _spawn.set(0, 2, 0);

    const groundY = this._groundOnStorey(_spawn.x, _spawn.z, _spawn.y);
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

  /** True when the solver is still fighting this position: real penetration. */
  _isEmbedded(position) {
    return this._measurePenetration(position) > PENETRATION_EPSILON;
  }

  /**
   * EVERY SOLID BOX IN THE WORLD, ON AN XZ GRID, so the escape probe can see
   * fences.
   *
   * Built the way `planet-reach`'s `boxIndex` is - each collider read by its
   * AXIS-ALIGNED bounds, which is exact for the square shore posts and a
   * conservative over-estimate for anything turned. Over-estimating an obstacle
   * makes the probe say "no route" more readily, and "no route" is the answer
   * that offers the player a ride: erring that way costs a rescue nobody needed,
   * not a player left standing in the sea being told to walk home.
   *
   * Cached on the collider array's identity and length, because a world change
   * replaces the array wholesale and a build appends to it. Rebuilding 4,500
   * entries is a millisecond and it only happens on a key press.
   */
  _solidIndex() {
    const list = this.physics?.colliders;
    if (!Array.isArray(list) || !list.length) return () => false;
    if (this._indexOf === list && this._indexLen === list.length && this._index) return this._index;

    const CELL = 8;
    const grid = new Map();
    for (const c of list) {
      if (!c.solid || c.type !== 'box') continue;
      const m = c.matrix?.elements;
      if (!m) continue;
      const b = {
        x: m[12], y: m[13], z: m[14],
        ax: Math.abs(m[0]) * c.halfExtents.x + Math.abs(m[4]) * c.halfExtents.y + Math.abs(m[8]) * c.halfExtents.z,
        ay: Math.abs(m[1]) * c.halfExtents.x + Math.abs(m[5]) * c.halfExtents.y + Math.abs(m[9]) * c.halfExtents.z,
        az: Math.abs(m[2]) * c.halfExtents.x + Math.abs(m[6]) * c.halfExtents.y + Math.abs(m[10]) * c.halfExtents.z,
      };
      if (!Number.isFinite(b.x) || !Number.isFinite(b.ax)) continue;
      for (let cx = Math.floor((b.x - b.ax) / CELL); cx <= Math.floor((b.x + b.ax) / CELL); cx++) {
        for (let cz = Math.floor((b.z - b.az) / CELL); cz <= Math.floor((b.z + b.az) / CELL); cz++) {
          const k = `${cx},${cz}`;
          let bucket = grid.get(k);
          if (!bucket) grid.set(k, (bucket = []));
          bucket.push(b);
        }
      }
    }
    const headroom = this._capsuleHeight() + 0.15;
    const fn = (x, z, groundY) => {
      const bucket = grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`);
      if (!bucket) return false;
      for (const b of bucket) {
        if (Math.abs(x - b.x) > b.ax || Math.abs(z - b.z) > b.az) continue;
        // A kerb the walk steps over, or a beam it walks under, is not a wall.
        if (b.y + b.ay <= groundY + PROBE_STEP_UP) continue;
        if (b.y - b.ay >= groundY + headroom) continue;
        return true;
      }
      return false;
    };
    this._indexOf = list;
    this._indexLen = list.length;
    this._index = fn;
    return fn;
  }

  /**
   * CAN THIS BODY WALK TO ANY OF THESE PLACES?
   *
   * A coarse flood over the world's own height field, four-connected, with the
   * envelope `planet-reach` measures planets with. It answers the one question
   * the old ladder never asked and the one the message has to be true about: "I
   * am fine where I am, but can I get anywhere?"
   *
   * IT SEES THE BOXES TOO, and it has to. The first version walked the height
   * field alone, and driven on Shoal it told a player standing on the sea bed
   * 20 m outside a 3.9 m shore fence that "there IS a walking route from here" -
   * which is exactly the kind of confident wrong answer this whole change exists
   * to stop. `_solidIndex` grids the world's own solid boxes on the same rule
   * the reach probes use: a box is an obstacle when its top stands over step
   * height and its underside is below head height.
   *
   * Returns `null` when the world has no height field to walk on at all - the
   * yard, the station, the maze - so the caller can say it does not know rather
   * than guess.
   *
   * @param {THREE.Vector3} from
   * @param {Array<{position: THREE.Vector3}>} targets
   * @returns {boolean|null}
   */
  _walkRouteExists(from, targets) {
    const phys = this.physics;
    if (typeof phys?.terrainHeight !== 'function') return null;
    if (!targets?.length) return null;
    if (!Number.isFinite(phys.terrainHeight(from.x, from.z))) return null;

    const bounds = this.worldManager?.active?.bounds;
    const minX = Number.isFinite(bounds?.min?.x) ? bounds.min.x : from.x - 500;
    const maxX = Number.isFinite(bounds?.max?.x) ? bounds.max.x : from.x + 500;
    const minZ = Number.isFinite(bounds?.min?.z) ? bounds.min.z : from.z - 500;
    const maxZ = Number.isFinite(bounds?.max?.z) ? bounds.max.z : from.z + 500;

    const nx = Math.max(2, Math.min(400, Math.ceil((maxX - minX) / PROBE_PITCH) + 1));
    const nz = Math.max(2, Math.min(400, Math.ceil((maxZ - minZ) / PROBE_PITCH) + 1));
    const at = (i, j) => j * nx + i;
    const wx = (i) => minX + i * PROBE_PITCH;
    const wz = (j) => minZ + j * PROBE_PITCH;
    const idx = (x, z) => [
      Math.round((x - minX) / PROBE_PITCH),
      Math.round((z - minZ) / PROBE_PITCH),
    ];

    /* Lazily evaluated: a flood that stops at the first target never pays for
     * the far side of the map, and the whole point of this running on a key
     * press is that it costs one frame at worst. 0 unknown, 1 no, 2 yes. */
    const solid = this._solidIndex();
    const state = new Uint8Array(nx * nz);
    const height = new Float32Array(nx * nz);
    let spent = 0;
    const standable = (i, j) => {
      const k = at(i, j);
      if (state[k]) return state[k] === 2;
      spent++;
      const x = wx(i);
      const z = wz(j);
      const g = phys.terrainHeight(x, z);
      if (!Number.isFinite(g)) { state[k] = 1; return false; }
      height[k] = g;
      if (solid(x, z, g)) { state[k] = 1; return false; }
      const h = PROBE_PITCH * 0.5;
      const a = phys.terrainHeight(x + h, z);
      const b = phys.terrainHeight(x - h, z);
      const c = phys.terrainHeight(x, z + h);
      const d = phys.terrainHeight(x, z - h);
      if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || !Number.isFinite(d)) {
        state[k] = 1;
        return false;
      }
      const slope = Math.hypot((a - b) / PROBE_PITCH, (c - d) / PROBE_PITCH);
      state[k] = slope > PROBE_SLOPE_TAN ? 1 : 2;
      return state[k] === 2;
    };

    const goals = [];
    for (const t of targets) {
      const [i, j] = idx(t.position.x, t.position.z);
      if (i < 0 || j < 0 || i >= nx || j >= nz) continue;
      goals.push([i, j]);
    }
    if (!goals.length) return null;

    const [si, sj] = idx(from.x, from.z);
    if (si < 0 || sj < 0 || si >= nx || sj >= nz) return null;
    /* The body is standing somewhere, so the node under it is standing room by
     * observation even where the lattice disagrees - which it does on a shelf
     * narrower than the pitch. Seed it regardless. */
    standable(si, sj);
    const seen = new Uint8Array(nx * nz);
    seen[at(si, sj)] = 1;
    height[at(si, sj)] = Number.isFinite(height[at(si, sj)]) && state[at(si, sj)] === 2
      ? height[at(si, sj)]
      : from.y;
    const stack = [si, sj];
    const reach = Math.ceil(PROBE_ARRIVE / PROBE_PITCH);

    while (stack.length) {
      const j = stack.pop();
      const i = stack.pop();
      for (const [gi, gj] of goals) {
        if (Math.abs(gi - i) <= reach && Math.abs(gj - j) <= reach) return true;
      }
      if (spent > PROBE_BUDGET) return null;
      const here = height[at(i, j)];
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = i + di;
        const b = j + dj;
        if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
        const k = at(a, b);
        if (seen[k]) continue;
        if (!standable(a, b)) { seen[k] = 1; continue; }
        const rise = height[k] - here;
        if (rise > PROBE_MAX_RISE && rise > PROBE_STEP_UP) { continue; }
        if (rise < -PROBE_DROP_MAX) { continue; }
        /* THE EDGE IS TESTED, NOT ONLY THE NODES, and this is the difference
         * between seeing a fence and stepping over it. The lattice pitch is 5 m
         * and a shore post is 2.2 m across: a step from a node on the bank to a
         * node in the sea can pass clean through the wall between them without
         * either end being blocked. Measured on Shoal - a body on the sea bed 20
         * m outside a 3.9 m fence was told "there IS a walking route from here".
         * Three samples along the edge leave a 1.25 m hole at worst, which is
         * narrower than anything in this game that is meant to stop a body. */
        let fenced = false;
        for (const t of [0.25, 0.5, 0.75]) {
          const mx = wx(i) + (wx(a) - wx(i)) * t;
          const mz = wz(j) + (wz(b) - wz(j)) * t;
          if (solid(mx, mz, Math.max(here, height[k]))) { fenced = true; break; }
        }
        if (fenced) continue;
        seen[k] = 1;
        stack.push(a, b);
      }
    }
    return false;
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

  /**
   * Is the body outside the world?
   *
   * Two ways, and the second one exists because closing the first opened it.
   *
   * ── 1. BELOW THE WORLD'S OWN LOWER BOUND ─────────────────────────────────
   * `bounds.min.y - VOID_MARGIN`. This is the falling-for-ever case and it is
   * what this method has always been.
   *
   * ── 2. STANDING ON THE BACKSTOP, WHICH IS NOT THE SAME AS BEING SAVED ────
   * Every planet now carries a flat backstop height field 6 m under its deepest
   * terrain (`PlanetWorld._buildFloor`), so a body that gets under the terrain
   * lands on something instead of falling until the void catch notices. That is
   * the right fix for the fall and it CANNOT be the end of the story: the
   * backstop is an invisible plane 1,260 m across with nothing on it, outside
   * the playfield, and a body standing on it is grounded, not penetrating and
   * comfortably above `bounds.min.y` - so every detector in this file reads
   * "playing normally".
   *
   * MEASURED, in a real boot, after the backstop landed. Walk off the edge of
   * Verdigris at (438, 40, 0):
   *
   *     t 2.3 s   lands on the backstop at y -6.2, 45.7 m/s, 100 damage
   *     t 2.3 s to 21.6 s   y -6.2, hp 100, grounded, NOTHING HAPPENS
   *
   * Twenty seconds of standing on a grey plane under the map with no rescue
   * offered and no [K] prompt, because nothing was detectably wrong. On Cinder
   * the same walk survived only by accident: the fall there is long enough to
   * be lethal, so the death respawn cleaned it up.
   *
   * `census.floor.top` is the backstop's own published height. 1.5 m of
   * tolerance catches a body standing on it; the nearest REAL ground is 6 m
   * above it by construction (`FLOOR_DROP`), so there is 4.5 m of clearance
   * before this could ever fire on a body that is genuinely somewhere.
   */
  _isOutOfWorld(position) {
    const world = this.worldManager?.active;
    const backstop = world?.census?.floor?.top;
    if (Number.isFinite(backstop) && position.y < backstop + 1.5) return true;
    const bounds = world?.bounds;
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

  /**
   * Shared entry point for both manual routes, with a debounce between them.
   *
   * THE KEY TELLS THE TRUTH, and that is the whole of this method. Three cases,
   * three different true things to say:
   *
   *   embedded / no footing   something is genuinely wrong: fix it and say what
   *                           was done. No confirmation - there is nothing to
   *                           consent to when you are inside a wall.
   *   standing, offer open    the player has read the offer and pressed again.
   *                           Take the ride.
   *   standing, no offer      REPORT. Name the destination, name the distance,
   *                           and say whether a walk would get there - then
   *                           leave the decision with the player for
   *                           {@link CONFIRM_WINDOW} seconds.
   *
   * What it must never do is what it used to: move the player one centimetre and
   * announce a fix.
   */
  _keyUnstuck(reason) {
    const now = performance.now();
    if (now - this._lastKeyAt < KEY_DEBOUNCE_MS) return;
    this._lastKeyAt = now;

    const player = this.player;
    const pos = player?.position;
    if (!pos || !Number.isFinite(pos.x)) { this.unstuck(reason); return; }

    if (this._isEmbedded(pos) || !this._hasSupportBelow(pos, 1.4)) {
      this.unstuck(reason);
      return;
    }

    const world = this.worldManager?.active;
    const age = this._elapsed - this._offerAt;
    if (
      this._offerTo
      && age >= CONFIRM_ARM && age <= CONFIRM_WINDOW
      && this._offerWorld === (world?.id ?? null)
      && pos.distanceTo(this._offerFrom) <= CONFIRM_DRIFT
    ) {
      this.unstuck('marooned');
      return;
    }

    const points = this._recoveryPoints(world);
    if (!points.length) {
      this.bus?.emit('hud:notify', {
        text: 'Not stuck  •  nothing is holding you, and this world publishes nowhere to be moved to',
        tone: 'warn',
      });
      return;
    }

    const target = this._recall(pos);
    const route = this._walkRouteExists(pos, points);
    this._offerAt = this._elapsed;
    this._offerTo = target ?? points[0];
    this._offerWorld = world?.id ?? null;
    this._offerFrom.copy(pos);

    const where = target?.label?.replace(/^carried /, '') ?? 'the arrival point';
    const verdict = route === false
      ? 'No walking route out of here.'
      : route === true
        ? 'There IS a walking route from here.'
        : 'Cannot tell from here whether a walk would get you out.';
    this.bus?.emit('hud:notify', {
      text: `Nothing is holding you - a nudge would do nothing.  ${verdict}`
        + `  Press K again to be ${where}.`,
      tone: 'warn',
    });
    this.bus?.emit('player:unstuck-offer', {
      at: pos.clone(),
      to: this._offerTo?.position?.clone?.() ?? null,
      route,
      window: CONFIRM_WINDOW,
    });
  }
}
