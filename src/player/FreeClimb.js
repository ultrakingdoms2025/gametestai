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

/* ---- pose tuning ---------------------------------------------------- */
/**
 * Metres of travel per full reach cycle.
 *
 * A climber's reach is roughly their arm span, and cycling faster than the body
 * actually moves is what makes procedural climbing read as scrabbling. At
 * {@link SPEED_UP} this is a shade over one reach per second.
 */
const STRIDE = 1.9;
/** Seconds the catch, push-off and fumble poses stay up after the event. */
const GRAB_POSE_TIME = 0.32;
const KICK_POSE_TIME = 0.42;
const SLIP_POSE_TIME = 0.75;

/** Pose scratch. The late-pose pass runs every frame; none of it allocates. */
const _poseE = new THREE.Euler();
const _poseQ = new THREE.Quaternion();

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
/**
 * Stamina per second while gripping, and the extra for actually ascending.
 *
 * These were 5.5 and 9.5, which is 15/s against a bar of 100: six and a half
 * seconds of climbing, and at {@link SPEED_UP} that is **13.7 metres**. The
 * minarets in this world are 30 m, the great tower is 46 m, and the mesa cliff
 * is 14 m. Every one of them dropped the player off somewhere around halfway,
 * every time, with no way to recover - because holding on drained too, so
 * stopping for a breather only ran the bar down slower.
 *
 * Climbing is the thing that costs now, and simply hanging costs nothing at
 * all: a climber locked off on good holds can stay there. That turns the bar
 * into a budget for *movement* rather than a countdown to falling off, makes
 * the ledges this world is banded with into real rest points, and means any
 * height is reachable given the patience to pause on the way.
 */
const DRAIN_HOLD = 1.6;
const DRAIN_UP = 5.4;
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

    /* ---- pose state (see `applyPose`) -------------------------------- */
    /** Blend of the whole climb pose against whatever the avatar did otherwise. */
    this._poseWeight = 0;
    /**
     * Distance climbed along the face, in metres, used as the phase of the
     * reach cycle. Driving the limbs from *distance* rather than from elapsed
     * time is what keeps a hand planted while the body is still: hold still on
     * a wall and the cycle holds still with you.
     */
    this._cycle = 0;
    /** Smoothed climb / traverse rates, so the pose does not snap on keypress. */
    this._rateUp = 0;
    this._rateSide = 0;
    /** Countdown timers for the three transient poses, in seconds. */
    this._grabT = 0;
    this._kickT = 0;
    this._slipT = 0;
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
    // Catch pose: arms absorb the arrival before the cling settles.
    this._grabT = GRAB_POSE_TIME;
    this._kickT = 0;
    this._slipT = 0;
    this._cycle = 0;
    this._rateUp = 0;
    this._rateSide = 0;
    this.bus?.emit('player:climb', { state: 'grab', position: p.position.clone() });
    return true;
  }

  /**
   * Let go. `kick` pushes off backwards, as when leaping from a wall.
   * `slip` marks the exit as an involuntary one - a failed grip rather than a
   * decision - which the pose reads to flail instead of push.
   */
  release({ kick = false, slip = false, lockout = REGRIP_LOCKOUT } = {}) {
    if (!this._active) return;
    this._active = false;
    this._atLip = false;
    this._lockout = lockout;
    const p = this.player;
    if (kick) {
      p.velocity.x = this.normal.x * KICK_BACK;
      p.velocity.z = this.normal.z * KICK_BACK;
      p.velocity.y = KICK_UP;
      this._kickT = KICK_POSE_TIME;
      this.bus?.emit('player:climb', { state: 'kick', position: p.position.clone() });
    } else {
      if (slip) this._slipT = SLIP_POSE_TIME;
      this.bus?.emit('player:climb', { state: slip ? 'slip' : 'release', position: p.position.clone() });
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
      this.release({ slip: true });
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

    /* Advance the reach cycle by how far the body actually travelled, not by
     * elapsed time: a climber who stops moving stops reaching, and the hand
     * that was on the wall stays on the wall. Lateral movement counts for less
     * than vertical because a traverse is a shuffle, not a haul. */
    const vSide = side * SPEED_SIDE;
    this._cycle += (Math.abs(vUp) + Math.abs(vSide) * 0.7) * dt;
    this._rateUp = damp(this._rateUp, vUp / SPEED_UP, 9, dt);
    this._rateSide = damp(this._rateSide, side, 9, dt);

    _mvTarget.copy(p.position).add(_mvDelta);

    /* ---- stamina ----------------------------------------------------- */
    /* Only movement costs. Hanging perfectly still is free, and free means the
     * regen delay actually elapses - draining a trickle would hold the timer
     * open forever and there would be no way to rest on a face at all. */
    const moving = climbing || Math.abs(side) > 0.01 || up < -0.01;
    if (stam && moving) {
      stam.drain((DRAIN_HOLD + (climbing ? DRAIN_UP : 0)) * dt, 'climb');
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

  /* ------------------------------------------------------------------ */
  /* Pose                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Pose the avatar for the wall.
   *
   * Runs in the late-pose pass (see `Player._installLatePose`), after
   * `PlayerAvatar` has written its locomotion pose, because otherwise the
   * avatar's own walk cycle would overwrite every bone this touches.
   *
   * Five things are drawn here, and they are all one continuous pose rather
   * than five clips, so there is nothing to blend between and nothing to get
   * caught halfway through:
   *
   *   - **cling**      the resting shape: both hands high on the face, hips in,
   *                    knees folded under, weight on the legs.
   *   - **climb**      an alternating reach driven by `_cycle`. Opposite limbs
   *                    lead - right hand with left foot - because that is how a
   *                    body stays balanced on a vertical face, and because two
   *                    hands moving together reads as a puppet.
   *   - **traverse**   the same cycle biased sideways, leading with the arm on
   *                    the side of travel.
   *   - **kick-off**   a short push: legs extend into the wall, arms sweep down
   *                    and back as the body leaves it.
   *   - **slip**       the involuntary exit: arms fly up and open, grabbing at
   *                    nothing, legs trailing.
   *
   * The transients outlive `_active`, which is the point - a pose that vanished
   * the instant the player let go would never be seen at all.
   */
  applyPose(dt, elapsed) {
    const humanoid = this.player.avatar?.humanoid;
    if (!humanoid) return;

    this._grabT = Math.max(0, this._grabT - dt);
    this._kickT = Math.max(0, this._kickT - dt);
    this._slipT = Math.max(0, this._slipT - dt);

    const transient = this._kickT > 0 || this._slipT > 0;
    // Let go of the pose quickly on a kick, slowly on a slip: a push-off is
    // over the moment you leave, a fumble hangs in the air.
    const want = this._active || transient ? 1 : 0;
    const rate = this._active ? 14 : this._slipT > 0 ? 5 : 9;
    this._poseWeight = damp(this._poseWeight, want, rate, dt);
    if (this._poseWeight < 0.002) return;

    const w = this._poseWeight;
    const B = humanoid.bones;
    const set = (name, x, y, z, weight = w) => {
      const bone = B.get(name);
      if (!bone) return;
      _poseE.set(x, y, z);
      _poseQ.setFromEuler(_poseE);
      bone.quaternion.slerp(_poseQ, weight);
    };

    const kick = this._kickT / KICK_POSE_TIME;
    const slip = this._slipT / SLIP_POSE_TIME;
    const grab = this._grabT / GRAB_POSE_TIME;
    // How much of the frame is the ordinary on-wall pose.
    const onWall = Math.max(0, 1 - Math.max(kick, slip));

    /* ---- the reach cycle -------------------------------------------- */
    // One full reach per STRIDE metres of travel. `beat` is +1 when the right
    // side leads and -1 when the left does.
    const beat = Math.sin((this._cycle / STRIDE) * Math.PI * 2);
    const effort = Math.min(1, Math.abs(this._rateUp) + Math.abs(this._rateSide) * 0.8);
    const lateral = this._rateSide;

    // Arms: high on the face, alternating. A grab spikes both arms up together,
    // which is what catching a wall actually looks like.
    const armBase = 2.24 + grab * 0.30;
    const armSwing = 0.46 * effort;
    // Legs: folded under, alternating opposite the arms.
    const thighBase = 0.62 - grab * 0.18;
    const legSwing = 0.34 * effort;

    for (const side of [1, -1]) {
      const s = side > 0 ? 'R' : 'L';
      const lead = side > 0 ? beat : -beat;
      // Reaching arm goes higher and straighter; the planted one stays bent.
      const armX = armBase + lead * armSwing;
      const elbow = 0.62 - lead * 0.30 * effort;
      // Lateral travel opens the leading arm out along the face.
      const armZ = side * (0.30 + Math.max(0, lateral * side) * 0.34);

      const kickArmX = -0.55 - kick * 0.35;
      const slipArmX = 2.95;

      set(`clavicle${s}`, 0, 0, -0.16 * side * onWall);
      set(
        `upperArm${s}`,
        armX * onWall + kickArmX * kick + slipArmX * slip,
        0,
        armZ * onWall + side * (0.55 * slip + 0.22 * kick)
      );
      set(`foreArm${s}`, (elbow * onWall) + 0.15 * kick + 0.30 * slip, 0, side * 0.08);
      set(`hand${s}`, -0.30 * onWall, 0, 0);

      // Legs mirror the arms so opposite limbs lead.
      const thighX = thighBase - lead * legSwing;
      const kickThighX = -0.30 - kick * 0.25;   // drive back into the wall
      const slipThighX = 0.28;
      set(
        `thigh${s}`,
        thighX * onWall + kickThighX * kick + slipThighX * slip,
        0,
        side * 0.16 * onWall
      );
      const calfX = -(1.02 + lead * 0.34 * effort);
      set(`calf${s}`, calfX * onWall - 0.18 * kick - 0.55 * slip, 0, 0);
      set(`foot${s}`, 0.34 * onWall + 0.30 * kick, 0, 0);
    }

    /* ---- torso ------------------------------------------------------- */
    // `_hug` is the smoothed approach to the wall, so the chest presses in as
    // the climb settles rather than snapping flat on contact.
    const hug = this._hug * onWall;
    const lean = 0.30 * hug - 0.34 * kick + 0.16 * slip;
    // A traverse turns the shoulders toward the direction of travel.
    const twist = lateral * 0.22 * onWall;
    set('spine01', lean * 0.36, twist * 0.5, 0);
    set('spine02', lean * 0.34, twist * 0.7, 0);
    set('spine03', lean * 0.30, twist, 0);
    // Look up the wall while climbing, back over the shoulder when pushing off.
    set('neck', (-0.34 * hug - 0.18 * Math.max(0, this._rateUp)) + 0.42 * kick, 0, 0);
    set('head', -0.20 * hug + 0.30 * kick + 0.24 * slip, 0, 0);
  }

  dispose() {
    this._active = false;
  }
}

export default FreeClimb;
