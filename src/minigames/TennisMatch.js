import * as THREE from 'three';
import { CONFIG } from '../core/Config.js';
import { createRacket } from './RacketProp.js';

/**
 * The Meridian tennis match.
 *
 * ── Abstracted, but not faked ────────────────────────────────────────────────
 *
 * There is no ball physics here and never will be: nothing in this game
 * bounces, Rapier is imported by nothing, and the court's net has no collider
 * (posts only - see SportsWorld._buildNet). What the contest keeps real is the
 * half the player can feel: they stand on a real baseline on a real slab, they
 * can walk, and the opponent is a real NPC - Deborah Quint-Halloway, whose
 * persona has promised this challenge since the day she spawned - visibly
 * taking her end, chasing the ball's line and swinging when she returns.
 *
 * The ball itself is cosmetic-kinematic: one sphere carried along a parabolic
 * arc between sides over ~1.6-2.1 s. The arc's endpoints are at chest height
 * and its apex clears the 1.07 m net by a metre, so the flight reads as a
 * rally without a single collision being solved. It is deliberately NOT the
 * hopper balls' 0.033 m: at regulation size the user could not track it from
 * 20 m away (their words), so it is doubled to TUNING.BALL_RADIUS, unlit
 * (MeshBasicMaterial - full-bright tennis yellow at any sun angle), and towed
 * by a short pooled comet trail of fading follower spheres (`_trail`,
 * updated at frame rate with zero per-frame allocation).
 *
 * ── The rally is a timing game ───────────────────────────────────────────────
 *
 * Ball arcs in -> a window opens over the last (1 - WINDOW_OPEN) of the flight
 * -> the player presses the swing key inside it to return. One press per ball:
 * a press before the window is a committed early swing and loses the point when
 * the ball lands, which is what stops the window being a button to hold.
 * Deborah returns with a probability that starts high and decays per exchange -
 * rallies end naturally - and a small, HARD-CAPPED chance of a winner
 * (`rivalOdds`, cap 0.15) so every rally stays winnable.
 *
 * ── The swing key is F ───────────────────────────────────────────────────────
 *
 * Measured against src/core/Input.js: E is the manager's own start/quit key,
 * Space is jump, T is chat, LMB is `state.fire` (level-triggered, consumed by
 * the loadout - and gunfire makes every friendly flee, which would send the
 * opponent sprinting off her own court). `pressed('KeyF')` is edge-triggered,
 * rebind-aware ("the key dismount is on"), and its only other consumer is
 * MountManager.dismount, which guards itself on `this._active` - a player who
 * is mounted is not mid-rally on a baseline. `pressed` does not consume, so
 * reading it here breaks nobody; this module only reads it while a ball is
 * actually arcing toward the player (`_frame`), never otherwise.
 *
 * Presses are LATCHED on the frame tick and consumed on the fixed tick, for
 * the reason MinigameManager.update documents: `Input.pressed` is cleared by
 * `input.endFrame()`, and a fixed step runs zero or two times in a frame, so a
 * press read only from `fixedUpdate` is dropped on every zero-step frame.
 *
 * ── Deborah is borrowed, and given back ──────────────────────────────────────
 *
 * Her `FriendlyNPC._think` state machine would fight external control - `_idle`
 * clears `_lookTarget` and issues wander targets every few seconds - so the
 * integration spec adds a three-line `_minigameLock` early-return to `_think`.
 * This module sets the lock, drives her through the public actor surface
 * (`nav.setTarget`, `desiredSpeed`, `faceOverride`, `_lookTarget` - the same
 * fields her own brain writes), and releases everything in `dispose`. Until
 * the lock lands in the engine she still plays, just distractedly: her brain
 * re-targets over ours every few seconds, and nothing breaks.
 *
 * Her swing is a one-shot arm arc written straight onto her humanoid bones
 * from an `engine.onFrameUpdate` callback registered while the match runs.
 * Registration order is the whole trick, the same one Player._installLatePose
 * documents: Engine iterates its updater Set in insertion order, this callback
 * is registered at match start - long after NPCManager's - so it lands after
 * her animator has posed her and the swing is the frame's final word.
 *
 * ── Cleanup has to be self-service ───────────────────────────────────────────
 *
 * MinigameManager._teardown calls `dispose()` on an abort, a quit, a world
 * change and a death - but a match that FINISHES is only ever `reset()`, which
 * nulls the module without disposing it. A swim has nothing to leak; this has
 * a mesh in the scene, a frame callback and a locked NPC. So `_win`/`_lose`
 * dispose this module themselves before returning the outcome, and `dispose`
 * is idempotent so the manager's own teardown path stays safe.
 *
 * ── The racket, and where the gun went ───────────────────────────────────────
 *
 * A carbine on a baseline is wrong, so for the duration of the match the
 * firearm is stowed and a racket prop (`RacketProp.js`) hangs on the same
 * `weaponMount` the carbine normally occupies - the mount is a child of the
 * right hand bone, so the swing poses carry it for free, on the player and on
 * Deborah alike. Three visibilities are managed, each by its own rule:
 *
 *   - the avatar's carried carbine (`avatar._weapon`): hidden at equip and
 *     re-hidden every frame from `_frame`, because `setPreview` and
 *     `_rebuildBody` both write that flag mid-match (the F2 wardrobe does
 *     both); the pre-match value is restored on dispose.
 *   - the first-person viewmodel (`player.weapon.setVisible`): overridden to
 *     hidden every frame from `_frame`, which works for the same reason the
 *     swing key must be `held()` - this hook registered late, so it runs
 *     AFTER `Player._driveWeapon` and `Loadout.update` have asserted their
 *     own per-frame visibility, and the last write before render wins. On
 *     dispose those owners re-assert next frame, so restoration is theirs.
 *   - the racket itself: attached through `avatar._editMaterials` so its
 *     materials join the avatar's shadow-only bookkeeping - otherwise first
 *     person would show a disembodied racket floating over an invisible
 *     body. `_frame` re-attaches it if the wardrobe swapped the humanoid.
 */

/** Game id. This is the handle a quest step names - see MinigameManager._finish. */
export const TENNIS_GAME_ID = 'tennis_match';

/**
 * The measured court, from SportsWorld._buildCourts: slab x 102.85..121.15,
 * z 7.7..44.3, net at (112, 26) spanning 12.8 m along X, painted baselines
 * 23.77/2 = 11.885 m either side of the net. The playable singles half-width
 * is 8.23/2. South (+Z, toward the plaza) is the player's end.
 */
export const COURT = {
  cx: 112,
  netZ: 26,
  baseS: 37.9,
  baseN: 14.1,
  halfW: 4.115,
};

/** Every number a test asserts a bound on, in one exported place. */
export const TUNING = {
  /**
   * Seconds one crossing of the net takes, jittered per ball.
   * Was 1.2-1.6; slowed ~30% because the user could not track the ball. At
   * 22.9 m baseline to baseline this is ~11-14 m/s - still brisk, now legible.
   */
  FLIGHT_MIN_S: 1.6,
  FLIGHT_MAX_S: 2.1,
  /** Metres of extra apex over the 1.0 m contact height. Min clears the net x2. */
  ARC_MIN: 1.2,
  ARC_MAX: 1.8,
  /**
   * Fraction of the incoming flight at which the swing window opens.
   * Was 0.62 (0.46-0.61 s of window); now 0.45, which is 0.55 of the flight =
   * 0.88-1.16 s at the new flight times - roughly twice the old window. The
   * number is anchored to the court, not taste: the incoming ball crosses the
   * net at u ~= 0.50 of its flight (net z 26, flights 14.1..14.5 -> 37.4), so
   * anything <= 0.50 means "press F about when it crosses the net" is always
   * inside the window, which is the instruction a first-time player infers.
   */
  WINDOW_OPEN: 0.45,
  /**
   * Deborah's return probability: RETURN_START * RETURN_DECAY^exchange.
   * Decay was 0.9; 0.86 resolves rallies a touch sooner - she now misses more
   * often than not by her 5th return (0.95 * 0.86^5 = 0.45) instead of her
   * 7th, so a player who keeps making the window is paid within ~5 exchanges.
   */
  RETURN_START: 0.95,
  RETURN_DECAY: 0.86,
  RETURN_FLOOR: 0.25,
  /** Her winner chance: base + growth * exchange, HARD-CAPPED at WINNER_CAP. */
  WINNER_BASE: 0.05,
  WINNER_PER_EXCHANGE: 0.015,
  WINNER_CAP: 0.15,
  /** Seconds of a one-shot swing, player and Deborah alike. */
  SWING_S: 0.45,
  SERVE_PAUSE_S: 1.1,
  POINT_PAUSE_S: 1.6,
  /** Seconds Deborah gets to reach her baseline before play starts anyway. */
  WALKON_MAX_S: 8,
  /** Whole-match safety net. Generous: a full three-setter fits twice over. */
  TIME_LIMIT_S: 420,
  /**
   * Ball radius, metres. Regulation is ~0.033 (the hopper balls' size) and at
   * that size the user reported losing the ball completely, so the match ball
   * is doubled - a readability prop, not a simulation.
   */
  BALL_RADIUS: 0.065,
  /** Trail follower spheres. Pooled at construction; zero allocation per frame. */
  TRAIL_COUNT: 5,
  /** Opacity of the first follower; the rest fade linearly toward zero. */
  TRAIL_OPACITY: 0.42,
  /**
   * Follower chase rate (per second, applied as lerp(k = dt * rate)). Each
   * sphere chases the one ahead, so at ~12.5 m/s of ball speed the first
   * follower trails by speed/rate ~= 0.8 m and the comet spans ~2.5 m -
   * enough to read direction at 20 m without smearing across the court.
   */
  TRAIL_TIGHTNESS: 16,
};

/** Height the arc's endpoints sit at - a chest-high contact, not a bounce. */
const CONTACT_Y = 1.0;
/** The hopper balls' 0xd7f23a tennis yellow, kept for continuity - but see
 *  TUNING.BALL_RADIUS for why the match ball is twice their size. */
const BALL_COLOUR = 0xd7f23a;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * Deborah's odds for one exchange of one rally. Pure, so the test suite can
 * sweep it: the winner chance must never exceed the cap, at any rally length,
 * because a rally the player cannot win is the one design rule this contest
 * was given.
 *
 * @param {number} exchange 0-based count of returns she has already made this rally
 * @returns {{pReturn:number, pWinner:number}}
 */
export function rivalOdds(exchange) {
  const e = Math.max(0, Number(exchange) || 0);
  const pReturn = Math.max(
    TUNING.RETURN_FLOOR,
    TUNING.RETURN_START * Math.pow(TUNING.RETURN_DECAY, e)
  );
  const pWinner = Math.min(
    TUNING.WINNER_CAP,
    TUNING.WINNER_BASE + TUNING.WINNER_PER_EXCHANGE * e
  );
  return { pReturn, pWinner };
}

export const POINT_NAMES = ['0', '15', '30', '40'];

/**
 * Real tennis scoring, kept pure so the tests can drive every transition
 * without a court: 0/15/30/40 within a game, deuce -> advantage -> win by two,
 * and the match is best of three GAMES (the user's spec, in those words) -
 * first to two games takes it.
 */
export class TennisScore {
  /** @param {number} gamesToWin first-to; 2 is best-of-three */
  constructor(gamesToWin = 2) {
    this.gamesToWin = gamesToWin;
    this.gamesP = 0;
    this.gamesD = 0;
    this.ptsP = 0;
    this.ptsD = 0;
  }

  /** 1-based game currently being played (or just decided). */
  get gameNumber() {
    return Math.min(this.gamesP + this.gamesD + 1, this.gamesToWin * 2 - 1);
  }

  /** 'player' | 'rival' | null */
  get matchWinner() {
    if (this.gamesP >= this.gamesToWin) return 'player';
    if (this.gamesD >= this.gamesToWin) return 'rival';
    return null;
  }

  /**
   * Award one point.
   * @param {'player'|'rival'} who
   * @returns {'player'|'rival'|null} the game winner, if this point closed one
   */
  pointTo(who) {
    if (this.matchWinner) return null;
    if (who === 'player') this.ptsP += 1;
    else this.ptsD += 1;
    let game = null;
    if (this.ptsP >= 4 && this.ptsP - this.ptsD >= 2) game = 'player';
    else if (this.ptsD >= 4 && this.ptsD - this.ptsP >= 2) game = 'rival';
    if (game) {
      if (game === 'player') this.gamesP += 1;
      else this.gamesD += 1;
      this.ptsP = 0;
      this.ptsD = 0;
    }
    return game;
  }

  /** '30-40', '40-40', 'A-40', '40-A' - player's score first, as the server calls it. */
  pointsText() {
    const p = this.ptsP;
    const d = this.ptsD;
    if (p >= 3 && d >= 3) {
      if (p === d) return '40-40';
      return p > d ? 'A-40' : '40-A';
    }
    return `${POINT_NAMES[Math.min(p, 3)]}-${POINT_NAMES[Math.min(d, 3)]}`;
  }

  gamesText() {
    return `${this.gamesP}-${this.gamesD}`;
  }
}

/* Scratch, per the convention in physics/Physics.js: each module owns its own.
 * Only one match runs at a time (the manager enforces it), so module scope is
 * per-instance in practice. */
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

export class TennisMatch {
  /**
   * @param {object} venue validated descriptor from MinigameManager
   * @param {{player:any, bus:any, input:any, npcs?:any, engine?:any, rng?:()=>number}} ctx
   *   `npcs` (the NPCManager) and `engine` arrive from the registerGame closure
   *   in main.js - the manager itself hands over only player/bus/input, and it
   *   must never learn what an NPC is. `rng` is injectable for the tests.
   */
  constructor(venue, { player, bus, input, npcs, engine, rng } = {}) {
    this.id = TENNIS_GAME_ID;
    this.venue = venue;
    this.player = player ?? null;
    this.bus = bus ?? null;
    this.input = input ?? null;
    this.engine = engine ?? player?.engine ?? null;
    this.scene = player?.scene ?? null;
    this.rng = typeof rng === 'function' ? rng : Math.random;

    const c = venue?.config ?? {};
    const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    this.cx = num(c.centreX, COURT.cx);
    this.netZ = num(c.netZ, COURT.netZ);
    this.baseS = num(c.baselineS, COURT.baseS);
    this.baseN = num(c.baselineN, COURT.baseN);
    this.halfW = num(c.halfWidth, COURT.halfW);
    this.rivalName = venue?.rival?.name ?? 'Deborah Quint-Halloway';

    this.score = new TennisScore(2);
    /** Phase: walkon -> (serve -> toPlayer/toNpc -> point)* until the match ends. */
    this._phase = 'walkon';
    this._timer = 0;
    this.clock = 0;
    /** The live arc, or null between rallies. See `_beginFlight`. */
    this._flight = null;
    /** Returns Deborah has made THIS rally - the decay input of `rivalOdds`. */
    this._herReturns = 0;
    this._rallyShots = 0;
    this.longestRally = 0;
    this.pointsWon = 0;
    this.pointsLost = 0;
    /** One swing per incoming ball; an early press commits it. */
    this._swungThisBall = false;
    this._committedEarly = false;
    this._swingQueued = false;
    /** Previous held-state of the swing key; see the edge-detect in _frame. */
    this._fWasDown = false;
    this._playerSwingAt = -Infinity;
    this._npcSwingAt = -Infinity;
    /** @type {{to:'player'|'rival', why:string}|null} last point, for tests and the HUD. */
    this.lastPoint = null;
    this._finished = false;
    this._disposed = false;

    /* ---- the opponent ---------------------------------------------- */
    this.npc =
      npcs?.friendlies?.find?.((n) => n && !n.isDead && n.name === this.rivalName) ?? null;
    this._npcPrev = null;
    this._navV = new THREE.Vector3();
    this._lookV = new THREE.Vector3();
    this._lockNpc();

    /* ---- the player, onto their baseline --------------------------- */
    /* Placed at start rather than asked to walk there: the countdown is the
     * "take your ends" beat, and a contest that begins with the player at the
     * net or on the wrong side is one the venue set up wrong. `teleport` is
     * the same call RaceManager grids the player with; the bare-position
     * fallback is for harnesses that build a plain `{position}` player. */
    const px = this.cx;
    const pz = this.baseS + 0.6;
    if (typeof this.player?.teleport === 'function') {
      // Yaw 0 faces -Z, which from the south baseline is straight up the court.
      this.player.teleport(new THREE.Vector3(px, 0.2, pz), 0);
    } else if (this.player?.position) {
      this.player.position.x = px;
      this.player.position.y = 0.2;
      this.player.position.z = pz;
    }

    /* ---- the ball --------------------------------------------------- */
    this._ballPos = new THREE.Vector3(this.cx, CONTACT_Y, this.baseN);
    this._ball = null;
    /** @type {THREE.Mesh[]} pooled trail followers; see TUNING.TRAIL_*. */
    this._trail = [];
    if (this.scene) {
      // Unlit on purpose: MeshBasicMaterial ignores the sun, so the ball is
      // full-bright tennis yellow from every angle - the emissive-tinted
      // standard material it replaces still went muddy against the far court.
      const mat = new THREE.MeshBasicMaterial({ color: BALL_COLOUR });
      this._ball = new THREE.Mesh(new THREE.SphereGeometry(TUNING.BALL_RADIUS, 10, 8), mat);
      this._ball.castShadow = false;
      this._ball.receiveShadow = false;
      this._ball.visible = false;
      this.scene.add(this._ball);

      /* Motion trail: TRAIL_COUNT followers sharing the ball's geometry, each
       * with its own fading material (opacity is per-material in three). All
       * of it is allocated here, once - the per-frame update in _updateTrail
       * only writes positions and visibility flags. */
      for (let i = 0; i < TUNING.TRAIL_COUNT; i++) {
        const tmat = new THREE.MeshBasicMaterial({
          color: BALL_COLOUR,
          transparent: true,
          opacity: TUNING.TRAIL_OPACITY * (1 - i / TUNING.TRAIL_COUNT),
          depthWrite: false,
        });
        const m = new THREE.Mesh(this._ball.geometry, tmat);
        m.castShadow = false;
        m.receiveShadow = false;
        m.visible = false;
        m.scale.setScalar(1 - 0.13 * (i + 1));
        this.scene.add(m);
        this._trail.push(m);
      }
    }

    /* ---- racket out, carbine away ----------------------------------- */
    this._playerRacket = null;
    this._npcRacket = null;
    this._prevCarbineVisible = null;
    this._equipProps();

    /* ---- the late-frame hook ---------------------------------------- */
    /* Two jobs: latch the swing key at frame rate (see the header), and write
     * Deborah's swing AFTER her animator has posed her - registered now, so
     * insertion order puts it behind NPCManager's own updaters. */
    this._offFrame = this.engine?.onFrameUpdate?.((dt) => this._frame(dt)) ?? null;
  }

  /** Seconds of "take your ends". Read by the manager. */
  get countdown() {
    return 5.0;
  }

  /** Seconds since the player's swing began; drives TennisPose's one-shot. */
  get playerSwingAge() {
    return this.clock - this._playerSwingAt;
  }

  /** True while a press would return the incoming ball. */
  get windowOpen() {
    const f = this._flight;
    return (
      this._phase === 'toPlayer' &&
      !!f &&
      !f.winner &&
      !this._swungThisBall &&
      f.t / f.T >= TUNING.WINDOW_OPEN
    );
  }

  /** Called the instant the countdown expires. */
  begin() {
    this.clock = 0;
    this._phase = 'walkon';
  }

  /* ================================================================ */
  /* Simulation                                                        */
  /* ================================================================ */

  /**
   * One fixed step.
   * @param {number} dt
   * @returns {object|null} an outcome once the match is over, else null
   */
  fixedUpdate(dt) {
    if (this._finished) return null;
    this.clock += dt;
    if (this.clock >= TUNING.TIME_LIMIT_S) return this._lose('time');

    this._driveNpc();

    switch (this._phase) {
      case 'walkon': {
        /* Play starts when she is on her mark - or after WALKON_MAX_S, so a
         * blocked path (or a harness with no NPC at all) can never wedge the
         * contest in a phase with no exit. */
        if (!this.npc || this._npcAtBaseline() || this.clock >= TUNING.WALKON_MAX_S) {
          this._phase = 'serve';
          this._timer = TUNING.SERVE_PAUSE_S;
          this._event('off', 'PLAY');
        }
        return null;
      }
      case 'serve': {
        this._timer -= dt;
        if (this._timer <= 0) this._launchServe();
        return null;
      }
      case 'toPlayer':
        return this._tickToPlayer(dt);
      case 'toNpc':
        return this._tickToNpc(dt);
      case 'point': {
        this._timer -= dt;
        if (this._timer > 0) return null;
        // The match verdict is read AFTER the point beat, so the last point of
        // the match gets its moment on screen before the result card takes over.
        const winner = this.score.matchWinner;
        if (winner === 'player') return this._win();
        if (winner === 'rival') return this._lose('rival');
        this._phase = 'serve';
        this._timer = TUNING.SERVE_PAUSE_S;
        return null;
      }
      default:
        return null;
    }
  }

  /** The ball inbound: window, swing, return or point. */
  _tickToPlayer(dt) {
    /* No engine hook (a bare test harness) means no frame-rate latch, so the
     * fixed step polls the key itself. Never both paths at once: with a hook
     * the latch already saw this press, and `pressed` does not consume, so the
     * double read would only set an already-set flag. */
    if (!this._offFrame && this.input?.pressed?.('KeyF')) this._swingQueued = true;

    const f = this._flight;
    f.t += dt;
    const u = Math.min(1, f.t / f.T);
    this._placeBall(f, u);

    if (this._swingQueued) {
      this._swingQueued = false;
      if (!this._swungThisBall) {
        this._swungThisBall = true;
        this._playerSwingAt = this.clock;
        if (!f.winner && u >= TUNING.WINDOW_OPEN) {
          // Clean return, struck from where the ball actually is.
          this._rallyShots += 1;
          const tx = clamp(
            this.cx + (this.rng() - 0.5) * 2 * (this.halfW - 0.4),
            this.cx - this.halfW,
            this.cx + this.halfW
          );
          this._beginFlight(false, this._ballPos.x, this._ballPos.z, tx, this.baseN + 0.4, false);
          return null;
        }
        // Before the window: a committed whiff. The ball is still coming.
        this._committedEarly = u < TUNING.WINDOW_OPEN;
      }
    }

    if (u >= 1) {
      const why = f.winner ? 'winner' : this._committedEarly ? 'early' : 'miss';
      this._pointTo('rival', why);
    }
    return null;
  }

  /** The ball outbound: Deborah misses, returns, or hits her capped winner. */
  _tickToNpc(dt) {
    const f = this._flight;
    f.t += dt;
    const u = Math.min(1, f.t / f.T);
    this._placeBall(f, u);
    if (u < 1) return null;

    const { pReturn, pWinner } = rivalOdds(this._herReturns);
    if (this.rng() > pReturn) {
      this._pointTo('player', 'rival_miss');
      return null;
    }
    this._herReturns += 1;
    this._rallyShots += 1;
    this._npcSwingAt = this.clock;
    const winner = this.rng() < pWinner;
    const px = clamp(this.player?.position?.x ?? this.cx, this.cx - this.halfW, this.cx + this.halfW);
    let tx;
    if (winner) {
      // The far corner from wherever the player is standing. Cosmetic - what
      // makes it unreturnable is that no window opens, not the geometry.
      const side = px >= this.cx ? -1 : 1;
      tx = this.cx + side * (this.halfW - 0.25);
    } else {
      // Aimed near the player, so real movement matters to the eye without
      // ever gating the return - the return is the timing window alone.
      tx = clamp(px + (this.rng() - 0.5) * 6, this.cx - this.halfW, this.cx + this.halfW);
    }
    this._beginFlight(true, this._ballPos.x, this._ballPos.z, tx, this.baseS - 0.5, winner);
    return null;
  }

  /* ================================================================ */
  /* Rally plumbing                                                    */
  /* ================================================================ */

  /** Serve, alternating ends by game. A player-serve is cosmetic-automatic. */
  _launchServe() {
    this._herReturns = 0;
    this._rallyShots = 1;
    const rivalServes = (this.score.gamesP + this.score.gamesD) % 2 === 0;
    if (rivalServes) {
      const sx = clamp(this.npc?.position?.x ?? this.cx, this.cx - this.halfW, this.cx + this.halfW);
      const px = clamp(this.player?.position?.x ?? this.cx, this.cx - this.halfW, this.cx + this.halfW);
      this._npcSwingAt = this.clock;
      const tx = clamp(px + (this.rng() - 0.5) * 4, this.cx - this.halfW, this.cx + this.halfW);
      this._beginFlight(true, sx, this.baseN, tx, this.baseS - 0.5, false);
    } else {
      /* The player's serve asks for no input: the one mechanic this contest
       * teaches is the return window, and a serve toss that could be fluffed
       * would be a second mechanic with no depth behind it. The swing pose
       * still plays, so the serve is theirs to see. */
      const px = clamp(this.player?.position?.x ?? this.cx, this.cx - this.halfW, this.cx + this.halfW);
      this._playerSwingAt = this.clock;
      const tx = clamp(this.cx + (this.rng() - 0.5) * 2 * (this.halfW - 0.4), this.cx - this.halfW, this.cx + this.halfW);
      this._beginFlight(false, px, this.baseS, tx, this.baseN + 0.4, false);
    }
  }

  /**
   * Start one crossing. Duration and apex are jittered per ball so the rally
   * has rhythm; the parabola is evaluated in `_placeBall`, nothing integrates.
   */
  _beginFlight(toPlayer, ax, az, bx, bz, winner) {
    const T = TUNING.FLIGHT_MIN_S + this.rng() * (TUNING.FLIGHT_MAX_S - TUNING.FLIGHT_MIN_S);
    const h = TUNING.ARC_MIN + this.rng() * (TUNING.ARC_MAX - TUNING.ARC_MIN);
    this._flight = { toPlayer, winner: !!winner, t: 0, T, h, ax, az, bx, bz };
    this._swungThisBall = false;
    this._committedEarly = false;
    this._swingQueued = false;
    this._phase = toPlayer ? 'toPlayer' : 'toNpc';
    if (this._ball) this._ball.visible = true;
    // Gather the comet onto the strike point, so a serve - which teleports the
    // ball to the server - never drags a streak across the whole court.
    for (const m of this._trail) m.position.set(ax, CONTACT_Y, az);
  }

  /** Chest-to-chest parabola: endpoints at CONTACT_Y, apex h above them. */
  _placeBall(f, u) {
    this._ballPos.set(
      f.ax + (f.bx - f.ax) * u,
      CONTACT_Y + f.h * 4 * u * (1 - u),
      f.az + (f.bz - f.az) * u
    );
    if (this._ball) this._ball.position.copy(this._ballPos);
  }

  /**
   * Award a point, bank the rally, and hold the beat. The match verdict is
   * NOT read here - see the 'point' case in fixedUpdate.
   * @param {'player'|'rival'} who
   * @param {'miss'|'early'|'winner'|'rival_miss'} why
   */
  _pointTo(who, why) {
    this.lastPoint = { to: who, why };
    if (who === 'player') this.pointsWon += 1;
    else this.pointsLost += 1;
    this.longestRally = Math.max(this.longestRally, this._rallyShots);
    const game = this.score.pointTo(who);
    this._flight = null;
    if (this._ball) this._ball.visible = false;
    this._phase = 'point';
    this._timer = TUNING.POINT_PAUSE_S + (game ? 0.8 : 0);

    const texts = {
      miss: 'MISSED — POINT DEBORAH',
      early: 'SWUNG EARLY — POINT DEBORAH',
      winner: 'WINNER — DEBORAH',
      rival_miss: 'DEBORAH NETS IT — POINT YOU',
    };
    this._event('split', game
      ? `GAME ${game === 'player' ? 'YOU' : 'DEBORAH'} — ${this.score.gamesText()}`
      : `${texts[why] ?? 'POINT'} · ${this.score.pointsText()}`);
  }

  /* ================================================================ */
  /* Props: rackets out, carbine away                                  */
  /* ================================================================ */

  /**
   * Stow the firearm and hand out the rackets. See the header for the three
   * visibility rules; this is the equip half, run once from the constructor
   * (so the racket is in hand for the "take your ends" countdown).
   */
  _equipProps() {
    const avatar = this.player?.avatar ?? null;
    if (avatar?.humanoid?.weaponMount) {
      this._playerRacket = createRacket();
      this._attachPlayerRacket(avatar);
      if (avatar._weapon) {
        // Remembered, not assumed: restore-to-what-it-was, not restore-to-true,
        // so a match started from a state that hides the gun stays coherent.
        this._prevCarbineVisible = avatar._weapon.visible;
        avatar._weapon.visible = false;
      }
    }
    // The first-person viewmodel is re-asserted visible every frame by its
    // owners; _holdProps overrides it every frame for the same reason. This
    // first hide just covers the frames before our hook first runs.
    this.player?.weapon?.setVisible?.(false);

    if (this.npc?.humanoid?.weaponMount) {
      this._npcRacket = createRacket();
      this.npc.humanoid.weaponMount.add(this._npcRacket.object);
    }
  }

  /**
   * Parent the player's racket, routed through `_editMaterials` where the real
   * avatar provides it: that lifts the first-person shadow-only state, adds
   * the racket, and re-collects the material list with the racket's materials
   * in it - so first person silences the racket along with the body instead
   * of drawing it disembodied. Harness players without that method just get a
   * plain add.
   * @param {any} avatar
   */
  _attachPlayerRacket(avatar) {
    const mount = avatar?.humanoid?.weaponMount;
    const racket = this._playerRacket;
    if (!mount || !racket) return;
    if (typeof avatar._editMaterials === 'function') {
      avatar._editMaterials(() => mount.add(racket.object));
    } else {
      mount.add(racket.object);
    }
  }

  /**
   * Per-frame prop discipline, from `_frame` (which runs after every system
   * that re-asserts weapon visibility - registration order again):
   *   - keep the viewmodel and the carried carbine hidden, undoing whatever
   *     `Loadout.update`, `Player._driveWeapon`, `setPreview` or a wardrobe
   *     `_rebuildBody` did earlier this frame;
   *   - re-attach the racket if the wardrobe swapped the humanoid out from
   *     under it. `Humanoid.dispose` frees only its OWN cached body resources
   *     and removes its root from the scene (measured, Humanoid.js:4569), so
   *     the racket rides out of the scene intact and unowned; moving the same
   *     object onto the new hand is both the fix and the leak-proofing.
   */
  _holdProps() {
    this.player?.weapon?.setVisible?.(false);
    const avatar = this.player?.avatar ?? null;
    if (!avatar) return;
    if (avatar._weapon?.visible) avatar._weapon.visible = false;
    const mount = avatar.humanoid?.weaponMount;
    if (this._playerRacket && mount && this._playerRacket.object.parent !== mount) {
      this._attachPlayerRacket(avatar);
    }
  }

  /** The dispose half: rackets away, firearm back exactly as found. */
  _unequipProps() {
    const avatar = this.player?.avatar ?? null;
    if (this._playerRacket) {
      const racket = this._playerRacket;
      this._playerRacket = null;
      if (avatar && typeof avatar._editMaterials === 'function' && racket.object.parent) {
        // Through _editMaterials again, so the avatar's material bookkeeping
        // drops the racket's materials as cleanly as it adopted them.
        avatar._editMaterials(() => racket.dispose());
      } else {
        racket.dispose();
      }
    }
    if (this._npcRacket) {
      this._npcRacket.dispose();
      this._npcRacket = null;
    }
    if (avatar?._weapon) {
      // The stored value when there is one; otherwise the avatar's own rule
      // (visible unless previewing) - covers a weapon built mid-match by a
      // wardrobe rebuild after an equip that found none to remember.
      avatar._weapon.visible = this._prevCarbineVisible ?? (avatar.previewing !== true);
    }
    this._prevCarbineVisible = null;
    // Match Player._driveWeapon's own rule for this frame; its per-frame
    // assert takes over from the next frame regardless.
    this.player?.weapon?.setVisible?.(
      this.player?._harnessFrozen !== true && this.player?.isThirdPerson !== true
    );
  }

  /* ================================================================ */
  /* Deborah                                                           */
  /* ================================================================ */

  /**
   * Borrow her. The lock is the three-line `_think` early-return from the
   * integration spec; everything else is the same actor surface her own brain
   * drives, so `NPC._steer`/`_integrate` keep doing the walking and no bone or
   * transform is ever written from here (her swing goes through `_frame`).
   */
  _lockNpc() {
    const npc = this.npc;
    if (!npc) return;
    this._npcPrev = { desiredSpeed: npc.desiredSpeed };
    npc._minigameLock = true;
    // Let go of whatever the idle life was doing mid-sentence.
    npc.talkPartner = null;
    npc.talkTimer = 0;
    npc.nav?.clear?.();
    // Set off for the baseline NOW: the countdown is her walk-on, and the
    // manager does not tick this module until play begins.
    npc.desiredSpeed = CONFIG?.npc?.runSpeed ?? 4.4;
    this._navV.set(this.cx, npc.position?.y ?? 0, this.baseN);
    npc.nav?.setTarget?.(this._navV);
  }

  /** Give her back exactly as found: patrol, pace, gaze and all. */
  _releaseNpc() {
    const npc = this.npc;
    if (!npc) return;
    npc._minigameLock = false;
    if (this._npcPrev) npc.desiredSpeed = this._npcPrev.desiredSpeed;
    npc.faceOverride = null;
    npc._lookTarget = null;
    npc.nav?.clear?.();
    // IDLE hands control back to FriendlyNPC._idle, whose wander pick resumes
    // her authored patrol - the same reset her own FLEE recovery uses.
    npc.setState?.('IDLE');
  }

  /** Per fixed step: where she runs, and what she watches. */
  _driveNpc() {
    const npc = this.npc;
    if (!npc || npc.isDead) return;
    /* FLEE outranks the match, in both directions: FriendlyNPC._think
     * dispatches FLEE before it honours the lock, and this module stops
     * writing her nav and gaze while she is scared - otherwise the per-step
     * baseline target would keep `nav.active` true and _flee's retarget
     * branch could never steer her away. When her own recovery resolves to
     * IDLE, the lock (still set) stands her brain down and the drive resumes. */
    if (npc.state === 'FLEE') return;
    // Re-asserted every step: a save-load or a scripted event could clear it.
    npc._minigameLock = true;

    if (this._phase === 'walkon') {
      npc.desiredSpeed = CONFIG?.npc?.runSpeed ?? 4.4;
      this._navV.set(this.cx, npc.position?.y ?? 0, this.baseN);
      if (npc.nav?.setTargetIfNew) npc.nav.setTargetIfNew(this._navV, 0.5);
      else npc.nav?.setTarget?.(this._navV);
      npc.faceOverride = null;
      npc._lookTarget = null;
      return;
    }

    // Rallying: shuffle along her baseline toward the ball's landing x when it
    // is coming to her, recover to centre otherwise.
    npc.desiredSpeed = (CONFIG?.npc?.walkSpeed ?? 1.5) * 1.4;
    const f = this._flight;
    const tx =
      f && this._phase === 'toNpc'
        ? clamp(f.bx, this.cx - this.halfW, this.cx + this.halfW)
        : this.cx;
    this._navV.set(tx, npc.position?.y ?? 0, this.baseN);
    if (npc.nav?.setTargetIfNew) npc.nav.setTargetIfNew(this._navV, 0.5);
    else npc.nav?.setTarget?.(this._navV);

    // Eyes on the ball while it flies; on the player between points.
    if (f && (this._phase === 'toPlayer' || this._phase === 'toNpc')) {
      this._lookV.copy(this._ballPos);
    } else {
      const p = this.player?.position;
      this._lookV.set(p?.x ?? this.cx, (p?.y ?? 0) + 1.6, p?.z ?? this.baseS);
    }
    npc._lookTarget = this._lookV;
    npc.faceOverride = this._lookV;
  }

  /* ================================================================ */
  /* Frame tick: key latch + her late swing pose                       */
  /* ================================================================ */

  _frame(dt) {
    if (this._disposed || this._finished) return;
    /* The one place the swing key is read at frame rate, and ONLY while a ball
     * is inbound - F means dismount everywhere else in the game.
     *
     * Edge-detected from the HELD state, not `pressed()`. This callback is
     * registered at match start, so it runs AFTER the frame callback main.js
     * registered at boot - whose last act is `input.endFrame()`, which clears
     * the pressed set. `pressed()` is therefore always false here, by
     * construction. The unit tests never caught it because the bare harness
     * has no engine hook and takes the fixed-tick poll path instead.
     * Measured in-browser before the fix: 44 in-window presses, 0 returns.
     *
     * Holding F still cannot cheat the window: the phase gate makes the edge
     * fire at the instant the ball turns inbound, which is a pre-window press
     * and commits the whiff exactly as the anti-hold design intends. */
    const fDown = this._phase === 'toPlayer' && !!this.input?.held?.('KeyF');
    if (fDown && !this._fWasDown) this._swingQueued = true;
    this._fWasDown = fDown;
    this._holdProps();
    this._updateTrail(dt);
    this._poseNpcSwing(dt);
  }

  /**
   * Frame-rate comet: each follower chases the one ahead of it (the first
   * chases the ball), which needs no history buffer and allocates nothing.
   * Runs at frame rate rather than fixed rate so the fade is smooth at any
   * display rate; snapped to the strike point in `_beginFlight`.
   */
  _updateTrail(dt) {
    if (!this._trail.length) return;
    const live = !!this._flight && !!this._ball?.visible;
    const k = Math.min(1, dt * TUNING.TRAIL_TIGHTNESS);
    let ahead = this._ballPos;
    for (const m of this._trail) {
      if (m.visible !== live) m.visible = live;
      m.position.lerp(ahead, k);
      ahead = m.position;
    }
  }

  /**
   * Deborah's one-shot forehand, written over her animator's pose - this
   * callback registered after NPCManager's, so it runs later (see header).
   * Mirror of the player's arc in TennisPose.js, same envelope, her bones.
   */
  _poseNpcSwing() {
    const B = this.npc?.humanoid?.bones;
    if (!B?.get) return;
    const age = this.clock - this._npcSwingAt;
    if (!(age >= 0) || age >= TUNING.SWING_S) return;
    const t = age / TUNING.SWING_S;
    const w = Math.pow(Math.sin(Math.PI * t), 0.65);
    // -1 full wind-up -> +1 full follow-through; wind-up takes the first third.
    const s = t < 0.32 ? -(t / 0.32) : -1 + ((t - 0.32) / 0.68) * 2;
    const set = (name, x, y, z, weight = w) => {
      const bone = B.get(name);
      if (!bone) return;
      _e.set(x, y, z);
      _q.setFromEuler(_e);
      bone.quaternion.slerp(_q, weight);
    };
    set('clavicleR', 0, 0, -0.18 - 0.1 * s);
    set('upperArmR', 0.85 + 1.05 * s, 0, 0.6 - 0.3 * s);
    set('foreArmR', 0.7 - 0.45 * Math.max(0, s), 0, 0.12);
    set('handR', 0.12, 0, -0.15 * s);
    set('upperArmL', 0.35 - 0.25 * s, 0, -0.35);
    set('spine02', 0.05, -0.24 * s, 0);
    set('spine03', 0.05, -0.2 * s, 0);
    set('head', -0.08, 0.22 * s, 0);
  }

  _npcAtBaseline() {
    const p = this.npc?.position;
    if (!p) return false;
    return Math.abs(p.z - this.baseN) < 2.5 && Math.abs(p.x - this.cx) < this.halfW + 2.5;
  }

  _event(kind, text) {
    this.bus?.emit('minigame:event', { gameId: this.id, kind, text });
  }

  /* ================================================================ */
  /* Outcome and teardown                                              */
  /* ================================================================ */

  _win() {
    this._finished = true;
    const games = this.score.gamesText();
    const detail = this._detail();
    // Self-clean on a FINISH: the manager only disposes on aborts (see header).
    this.dispose();
    return {
      won: true,
      place: 1,
      total: 2,
      score: games,
      scoreLabel: `${games} games`,
      rivalName: this.rivalName,
      detail,
    };
  }

  /** @param {'rival'|'time'} why */
  _lose(why) {
    this._finished = true;
    const games = this.score.gamesText();
    const detail = this._detail();
    detail.reason = why;
    this.dispose();
    return {
      won: false,
      place: 2,
      total: 2,
      score: games,
      scoreLabel: why === 'time' ? 'Timed out' : `${games} games`,
      rivalName: this.rivalName,
      detail,
    };
  }

  _detail() {
    return {
      games: this.score.gamesText(),
      pointsWon: this.pointsWon,
      pointsLost: this.pointsLost,
      longestRally: this.longestRally,
    };
  }

  /**
   * Idempotent, and called from three places on purpose: the manager's
   * teardown (abort/quit/world change/death), and this module's own win/lose,
   * because a finished match is `reset()`, never disposed, by the manager.
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._offFrame) {
      try {
        this._offFrame();
      } catch {
        /* engine already gone */
      }
      this._offFrame = null;
    }
    if (this._ball) {
      this._ball.parent?.remove(this._ball);
      // The trail shares this geometry, so one dispose covers all six meshes.
      this._ball.geometry?.dispose?.();
      this._ball.material?.dispose?.();
      this._ball = null;
    }
    for (const m of this._trail) {
      m.parent?.remove(m);
      m.material?.dispose?.();
    }
    this._trail.length = 0;
    this._unequipProps();
    this._releaseNpc();
  }

  /* ================================================================ */
  /* Readout                                                           */
  /* ================================================================ */

  /**
   * Live rows for the generic minigame HUD - 'GAME 2 · 30-40' style, per the
   * spec. The progress bar doubles as the timing meter: it fills with the
   * incoming flight and the rival marker sits at the point the window opens,
   * so "swing past the notch" is legible with zero new UI.
   */
  snapshot() {
    const f = this._flight;
    const incoming = this._phase === 'toPlayer' && f ? Math.min(1, f.t / f.T) : 0;
    const g = this.score;
    const rows = [
      { k: 'SCORE', v: `GAME ${g.gameNumber} · ${g.pointsText()}` },
      {
        k: 'GAMES',
        v: g.gamesText(),
        tone: g.gamesP > g.gamesD ? 'good' : g.gamesD > g.gamesP ? 'warn' : null,
      },
      { k: 'RALLY', v: `${this._rallyShots} shot${this._rallyShots === 1 ? '' : 's'}`, dim: true },
    ];
    let banner = null;
    if (this._phase === 'walkon') banner = 'DEBORAH IS TAKING HER END';
    else if (this.windowOpen) banner = 'SWING — PRESS F';
    else if (this._phase === 'toPlayer' && f?.winner) banner = 'SHE FOUND THE CORNER';
    else if (this._phase === 'toPlayer' && this._swungThisBall && this._committedEarly) banner = 'TOO EARLY';
    return {
      rows,
      progress: incoming,
      rivalProgress: this._phase === 'toPlayer' ? TUNING.WINDOW_OPEN : 0,
      banner,
      subtitle: `best of 3 games · vs ${this.rivalName} · F swings`,
    };
  }
}

/**
 * Factory registered against the `tennis` venue kind.
 * @param {object} venue
 * @param {{player:any, bus:any, input:any, npcs?:any, engine?:any, rng?:()=>number}} ctx
 */
export function createTennisMatch(venue, ctx) {
  return new TennisMatch(venue, ctx);
}

export default TennisMatch;
