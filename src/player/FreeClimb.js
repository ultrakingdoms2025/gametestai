import * as THREE from 'three';
import { CONFIG } from '../core/Config.js';
import { COLLISION_LAYER } from '../physics/Physics.js';

/**
 * Sustained wall climbing - the "go up anything" half of the parkour set.
 *
 * ── How this differs from `Climb.js`, and why both exist ──────────────────
 * `Climb` is a *mantle*: a discrete, scripted hoist over a ledge between 1 and
 * 2.4 m, which begins and ends on solid ground. It is the right model for
 * vaulting a wall in the medieval world and it should stay exactly as it is.
 *
 * This is the other thing entirely: a *state* the player enters and lives in,
 * where gravity is off, the capsule is pinned a few centimetres off a vertical
 * face, and the movement keys move them across that face for as long as their
 * arms hold out. A 46 m tower is not a taller mantle; it is a different verb.
 *
 * The two are deliberately chained rather than merged. Free-climbing to the top
 * of a wall ends by handing off to `Climb.tryStart`, because getting *over* the
 * lip is exactly the scripted hoist `Climb` already does well, and duplicating
 * it here would give the game two subtly different ways to end a climb.
 *
 * ── Attaching ─────────────────────────────────────────────────────────────
 * Space, held, while facing a wall within reach. That key is already jump,
 * swim-up and mantle, and every one of those reads as "up" - so the player is
 * never asked to learn a new verb, only to hold the one they know while
 * touching a wall. It also means a running jump into a facade grabs it, which
 * is the single most important interaction in a world like the citadel.
 *
 * ── Why the probe is a fan and not a ray ──────────────────────────────────
 * A single forward ray falls off the moment the wall turns a corner, changes
 * plane behind a pilaster, or the player drifts a few degrees while moving
 * sideways. Three rays at slightly different yaws keep contact around convex
 * detail, and the *shallowest* hit wins so the climber follows the outermost
 * surface rather than diving into a recess.
 */

const P = CONFIG.player;
const damp = THREE.MathUtils.damp;

/**
 * Capsule radius, taken from config rather than from the player instance.
 *
 * `Player` does not expose a `radius` property - it reads `CONFIG.player.radius`
 * internally - so `player.radius` is `undefined`, and `undefined + REACH` is
 * `NaN`. A raycast with a `NaN` max distance returns null every time, which is
 * a silent and total failure: the probe simply never found a wall, anywhere,
 * and the whole mechanic did nothing while looking perfectly correct.
 */
const PLAYER_RADIUS = P.radius;

/** How far past the capsule the grip probe reaches. */
const REACH = 0.62;
/** A surface flatter than this is a ramp the walk code already handles. */
const WALL_NORMAL_Y = 0.5;
/** Gap held between the capsule surface and the wall while clinging. */
const SKIN = 0.06;
/** Metres per second up, across, and down a face. */
const SPEED_UP = 2.05;
const SPEED_SIDE = 2.35;
const SPEED_DOWN = 3.1;
/** Stamina per second while gripping, and the extra for actually ascending. */
const DRAIN_HOLD = 5.5;
const DRAIN_UP = 9.5;
/** Push-off velocity when leaping backwards off a wall. */
const KICK_BACK = 5.2;
const KICK_UP = 4.6;
/** Probe fan half-angle. */
const FAN = 0.26;
/** How far above the grip point to look for the top of the wall. */
const LIP_PROBE = 0.55;
/** Refuse to re-attach for this long after letting go, or Space re-grabs instantly. */
const REGRIP_LOCKOUT = 0.35;

/* Scratch. Each function owns its own - see the note in physics/Physics.js. */
const _pbOrigin = new THREE.Vector3();
const _pbDir = new THREE.Vector3();
const _pbBest = new THREE.Vector3();
const _pbNormal = new THREE.Vector3();
const _mvUp = new THREE.Vector3();
const _mvRight = new THREE.Vector3();
const _mvDelta = new THREE.Vector3();
const _mvTarget = new THREE.Vector3();

export class FreeClimb {
  /**
   * @param {{player:any, physics:any, bus:any, input:any}} ctx
   */
  constructor({ player, physics, bus, input }) {
    this.player = player;
    this.physics = physics;
    this.bus = bus;
    this.input = input;

    this._active = false;
    /** Outward normal of the face being held. */
    this.normal = new THREE.Vector3(0, 0, 1);
    /** World point the hands are on. */
    this.grip = new THREE.Vector3();
    /** True while a wall is in reach, whether or not we are on it. Drives the HUD. */
    this.candidate = false;

    this._lockout = 0;
    this._time = 0;
    /**
     * Whether Space was already down last step.
     *
     * Initialised true and re-armed on every attach, because you get here *by*
     * holding Space - so an uninitialised flag reads the hold that grabbed the
     * wall as a fresh press and kicks straight back off it. That was the whole
     * of the "climbs a metre, drops, re-grabs, climbs a metre" stutter.
     */
    this._jumpHeld = true;
    /** Smoothed lean, so the avatar does not snap flat against the wall. */
    this._hug = 0;
    /** Set when the probe loses the wall above: the cue to mantle. */
    this._atLip = false;
  }

  /** @returns {boolean} */
  get active() {
    return this._active;
  }

  /** 0..1 hug weight, for the avatar pose. */
  get hug() {
    return this._hug;
  }

  /* ------------------------------------------------------------------ */
  /* Probing                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Look for a climbable face in front of the player.
   *
   * @param {number} atHeight metres above the feet to probe from
   * @returns {boolean} true when `_pbBest`/`_pbNormal` hold a valid grip
   */
  _probe(atHeight) {
    const p = this.player;
    const yaw = p.yaw;
    let found = false;
    let bestDist = Infinity;

    for (let i = -1; i <= 1; i++) {
      const a = yaw + i * FAN;
      _pbDir.set(-Math.sin(a), 0, -Math.cos(a));
      _pbOrigin.copy(p.position);
      _pbOrigin.y += atHeight;
      const hit = this.physics.raycast(
        _pbOrigin, _pbDir, PLAYER_RADIUS + REACH, COLLISION_LAYER.WORLD
      );
      if (!hit) continue;
      const n = hit.normal;
      if (!n || Math.abs(n.y) > WALL_NORMAL_Y) continue;
      // Shallowest wins: around a pilaster or a buttress the climber should
      // follow the face that sticks out, not dive into the recess beside it.
      if (hit.distance >= bestDist) continue;
      bestDist = hit.distance;
      _pbBest.copy(hit.point);
      _pbNormal.set(n.x, 0, n.z).normalize();
      found = true;
    }
    return found;
  }

  /**
   * Cheap "is there a wall to grab" test for the HUD prompt and for the
   * attach check. Runs at chest height, which is where a hand would go.
   */
  poll() {
    if (this._active) {
      this.candidate = true;
      return true;
    }
    this.candidate = this._lockout <= 0 && this._probe(P.eyeHeight * 0.72);
    return this.candidate;
  }

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Try to grab the wall in front.
   * @returns {boolean} true if now climbing
   */
  tryAttach() {
    if (this._active || this._lockout > 0) return false;
    const p = this.player;
    if (p.isDead) return false;
    const stam = p.stamina;
    if (stam && stam.exhausted) return false;
    if (!this._probe(P.eyeHeight * 0.72)) return false;

    this._active = true;
    this._atLip = false;
    // Space is down right now - that is how we got here. Re-arm so the hold is
    // not mistaken for a press on the first step.
    this._jumpHeld = true;
    this.normal.copy(_pbNormal);
    this.grip.copy(_pbBest);
    // Pin to the face immediately, so there is no frame where the capsule is
    // still travelling toward the wall it has already grabbed.
    this._pin();
    p.velocity.set(0, 0, 0);
    this.bus?.emit('player:climb', { state: 'grab', position: p.position.clone() });
    return true;
  }

  /** Let go. `kick` pushes off backwards, as when leaping from a wall. */
  release({ kick = false, lockout = REGRIP_LOCKOUT } = {}) {
    if (!this._active) return;
    this._active = false;
    this._atLip = false;
    this._lockout = lockout;
    const p = this.player;
    if (kick) {
      p.velocity.x = this.normal.x * KICK_BACK;
      p.velocity.z = this.normal.z * KICK_BACK;
      p.velocity.y = KICK_UP;
      this.bus?.emit('player:climb', { state: 'kick', position: p.position.clone() });
    } else {
      this.bus?.emit('player:climb', { state: 'release', position: p.position.clone() });
    }
  }

  cancel() {
    if (this._active) this.release({ lockout: 0 });
    this._lockout = 0;
  }

  /** Hold the capsule a constant gap off the face it is gripping. */
  _pin() {
    const p = this.player;
    _mvTarget.copy(this.grip).addScaledVector(this.normal, PLAYER_RADIUS + SKIN);
    p.position.x = _mvTarget.x;
    p.position.z = _mvTarget.z;
  }

  /* ------------------------------------------------------------------ */
  /* Frame                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Drive the climb. Returns true while it owns the player's movement, in
   * which case the caller must not run its own gravity or collision.
   *
   * @param {number} dt
   * @param {number} elapsed
   * @returns {boolean}
   */
  fixedUpdate(dt, elapsed) {
    if (this._lockout > 0) this._lockout -= dt;
    if (!this._active) {
      this._hug = damp(this._hug, 0, 10, dt);
      return false;
    }

    const p = this.player;
    const s = this.input?.state ?? { forward: 0, right: 0, jump: false, crouch: false };
    const stam = p.stamina;

    if (p.isDead) {
      this.release({ lockout: 0 });
      return false;
    }

    this._time += dt;
    this._hug = damp(this._hug, 1, 12, dt);

    /* ---- let go ----------------------------------------------------- */
    // Crouch is the deliberate "drop off" - it is the only input here that
    // cannot be confused with trying to move.
    if (s.crouch) {
      this.release();
      return false;
    }
    if (stam && stam.exhausted) {
      this.bus?.emit('hud:notify', { text: 'Grip failed', tone: 'warn' });
      this.release();
      return false;
    }

    /* ---- move across the face --------------------------------------- */
    // The wall's own basis: up is world up (a vertical face has no roll), and
    // right is the horizontal perpendicular to its normal.
    _mvUp.set(0, 1, 0);
    _mvRight.crossVectors(_mvUp, this.normal).normalize();

    const up = s.forward;      // W climbs, S descends
    const side = s.right;
    const climbing = up > 0.01;
    const vUp = up > 0 ? up * SPEED_UP : up * SPEED_DOWN;

    _mvDelta.set(0, 0, 0);
    _mvDelta.addScaledVector(_mvUp, vUp * dt);
    _mvDelta.addScaledVector(_mvRight, side * SPEED_SIDE * dt);

    _mvTarget.copy(p.position).add(_mvDelta);

    /* ---- stamina ----------------------------------------------------- */
    if (stam) {
      const rate = DRAIN_HOLD + (climbing ? DRAIN_UP : 0);
      stam.drain(rate * dt, 'climb');
    }

    /* ---- re-probe from where we want to be --------------------------- */
    // Probing from the *target* rather than the current position is what lets
    // the climber follow a face around a corner: if the wall is still there at
    // the new spot the move is legal, and if it is not we have not moved yet.
    p.position.copy(_mvTarget);
    const stillOnWall = this._probe(P.eyeHeight * 0.72);

    if (stillOnWall) {
      this.normal.copy(_pbNormal);
      this.grip.copy(_pbBest);
      this._pin();
    } else {
      /* No wall at the new height. Either we have climbed over the top - the
       * good case, and the whole point of the mechanic - or we have run off the
       * side. Tell them apart by looking slightly *below*: if the wall is still
       * there down there, we crested it. */
      p.position.copy(_mvTarget);
      const below = this._probe(P.eyeHeight * 0.72 - LIP_PROBE);
      if (below && up > 0.01) {
        this._atLip = true;
        this.normal.copy(_pbNormal);
        this.grip.copy(_pbBest);
        this._pin();
      } else {
        // Ran out of wall sideways or downward: let go where we are.
        p.position.copy(_mvTarget).sub(_mvDelta);
        this.release({ lockout: 0.12 });
        return false;
      }
    }

    /* ---- top out ------------------------------------------------------ */
    if (this._atLip && up > 0.01) {
      // Hand the last metre to the scripted hoist. It has already proven the
      // landing is clear, which a free climb never checks for itself.
      const climb = p.climb;
      if (climb && climb.tryStart(elapsed, { fromWall: true })) {
        this._active = false;
        this._atLip = false;
        this._lockout = 0.2;
        return false;
      }
    }

    /* ---- jump off ----------------------------------------------------- */
    // Rising edge only: Space is *held* to stay on the wall, so a press has to
    // be distinguished from the hold that got us here.
    if (s.jump && !this._jumpHeld) {
      // Up against the wall if there is still wall above, otherwise kick off.
      this.release({ kick: true });
      this._jumpHeld = true;
      return false;
    }
    this._jumpHeld = !!s.jump;

    p.velocity.set(0, 0, 0);
    return true;
  }

  dispose() {
    this._active = false;
  }
}

export default FreeClimb;
