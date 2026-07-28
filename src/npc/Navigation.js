import * as THREE from 'three';
import { COLLISION_LAYER } from '../physics/Physics.js';

/**
 * Per-agent steering.
 *
 * There is no navmesh in this game - worlds are generated procedurally and a
 * baked graph would go stale the moment a world changed. Instead every agent
 * runs seek/arrive against a target, then subtracts what it can see with a fan
 * of probe raycasts and pushes away from its neighbours. A stuck detector
 * catches the cases steering alone cannot solve and re-targets.
 *
 * `update()` returns a desired velocity in world space; the NPC integrates it
 * and lets `physics.resolveCapsule` do the final wall correction.
 *
 * ---------------------------------------------------------------------------
 * Wall avoidance is a *deflection*, never a reversal.
 *
 * This is the whole reason the characters used to vibrate against props. The
 * probe fan is staggered - one raycast per agent per frame, round-robin over
 * five directions - so the raw hit strengths are a sawtooth: the probe that
 * refreshed this frame jumps to its true value while the other four keep
 * decaying. When that sawtooth was fed straight into the steering output at a
 * gain *larger than the seek term* (`maxSpeed * 1.35`), the sum flipped sign
 * every time the sawtooth crossed the balance point, and the character shuffled
 * forward and back several times a second. Measured before this rewrite: 65
 * direction reversals and 53 turn reversals in 8 seconds, over 2.8 m travelled,
 * with no neighbour anywhere near - so it was never separation-vs-avoidance
 * fighting, it was avoidance fighting itself.
 *
 * Two things stop it now, and both matter:
 *
 *  1. The raw probe response is split into a *brake* (how much forward speed to
 *     give up) and a *slide* (which way along the wall to go), both low-passed
 *     over time so a single probe refresh can never step the output.
 *  2. The final desired velocity is clamped so its component along the seek
 *     direction is never negative. Avoidance can slow an agent to a standstill
 *     and push it sideways; it cannot drive it backwards. Backing out is the
 *     stuck detector's job, on a timescale a viewer reads as a decision rather
 *     than as a glitch.
 *
 * The slide direction is also latched per probe, because near a head-on
 * approach `perpendicular . forward` sits on top of zero and the raw sign
 * chatters between left and right every frame.
 * ---------------------------------------------------------------------------
 */

/**
 * Module scratch, one set per function.
 *
 * Shared scratch across functions has cost this project multi-day bugs twice
 * (see the _rc/_ct/_gh/_cp notes in physics/Physics.js). `_probe` is called
 * from the middle of `update`, and `_clearLine` is called from `_advancePath`
 * and from outside the class, so there is no ordering argument that makes
 * sharing safe here.
 */

/** update() owns these exclusively. */
const _upSeek = new THREE.Vector3();
const _upSeekDir = new THREE.Vector3();
const _upSep = new THREE.Vector3();
const _upDelta = new THREE.Vector3();
const _upSide = new THREE.Vector3();

/** _probe() owns these exclusively. */
const _pbOrigin = new THREE.Vector3();
const _pbDir = new THREE.Vector3();
const _pbSlide = new THREE.Vector3();
const _pbLateral = new THREE.Vector3();
const _pbPush = new THREE.Vector3();

/** _clearLine() owns these exclusively. */
const _clOrigin = new THREE.Vector3();
const _clDir = new THREE.Vector3();

/** _trackStuck() owns this exclusively. */
const _tsDelta = new THREE.Vector3();

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Probe fan: angle from forward (radians) and reach multiplier. */
const PROBES = [
  { angle: 0, reach: 1.0, weight: 1.0 },
  { angle: 0.42, reach: 0.85, weight: 0.75 },
  { angle: -0.42, reach: 0.85, weight: 0.75 },
  { angle: 1.05, reach: 0.5, weight: 0.45 },
  { angle: -1.05, reach: 0.5, weight: 0.45 },
];

/**
 * How fast the smoothed avoidance response tracks the raw probe response.
 * Slow enough to swallow the round-robin sawtooth (one probe refreshes every
 * five frames), fast enough that an agent still turns before it reaches a wall.
 */
const AVOID_TRACK = 9;
/** Per-second decay of a stale probe hit that has not been refreshed. */
const PROBE_DECAY = 1.2;
/** `blocked` latches on above this... */
const BLOCKED_ON = 0.72;
/** ...and only releases below this, so the flag itself cannot chatter. */
const BLOCKED_OFF = 0.42;
/**
 * How far `perpendicular . forward` has to swing before a latched slide
 * direction is allowed to flip. Zero here is exactly the head-on case, which is
 * where the raw sign chatters.
 */
const SLIDE_FLIP_DEADBAND = 0.35;
/**
 * Once an agent is genuinely in contact with something, commit to the side it
 * chose for this long before any probe is allowed to pick the other one.
 *
 * Sliding along a wall is a limit cycle waiting to happen: the agent turns to
 * face the way it is actually travelling, that rotates the probe fan off the
 * wall, the brake releases, the seek pulls it back into the wall and it turns
 * again. Committing to a side for half a second turns that cycle into a walk
 * along the wall, which is what it should have looked like all along.
 */
const SLIDE_LOCK_TIME = 0.55;
/** Contact strength that counts as "committed", for the lock above. */
const SLIDE_LOCK_ENTER = 0.15;

export class Navigation {
  /**
   * @param {{ physics:any, radius?:number, probeRange?:number, seed?:number }} ctx
   */
  constructor({ physics, radius = 0.36, probeRange = 2.6, seed = 1 }) {
    this.physics = physics;
    this.radius = radius;
    this.probeRange = probeRange;

    this.target = new THREE.Vector3();
    this.hasTarget = false;
    /** @type {THREE.Vector3[]} */
    this.path = [];
    this.pathIndex = 0;

    this.arriveRadius = 0.55;
    this.slowRadius = 2.4;
    this.separationRange = 1.35;

    this.desired = new THREE.Vector3();
    /**
     * Composite avoidance, kept for telemetry and for anything outside that
     * reads it. The steering itself uses the decomposed pair below.
     */
    this.avoidance = new THREE.Vector3();
    /** Smoothed slide direction along the wall (unit, XZ). */
    this.avoidLateral = new THREE.Vector3();
    /** Smoothed push directly off the wall face (unit-ish, XZ). */
    this.avoidPush = new THREE.Vector3();
    /** Smoothed 0..1 "how much forward speed to give up". */
    this.avoidBrake = 0;
    this.arrived = false;
    this.blocked = false;

    // Stuck detection: compare travelled distance against intended distance.
    this._last = new THREE.Vector3();
    this._lastValid = false;
    this._accum = 0;
    this._window = 0;
    this._intended = 0;
    this.isStuck = false;
    this.stuckCount = 0;
    this._detourTimer = 0;
    this._detourSign = 1;

    let s = seed >>> 0 || 7;
    this._rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    this._probePhase = Math.floor(this._rnd() * PROBES.length);
    this._probeHits = new Float32Array(PROBES.length);
    this._probeNormals = PROBES.map(() => new THREE.Vector3());
    /** Latched slide side per probe: -1 or +1, 0 while the probe is clear. */
    this._slideSign = new Int8Array(PROBES.length);
    /** While > 0 no probe may change the side it is sliding to. */
    this._slideLock = 0;
  }

  /** Steer directly at a point. Clears any waypoint path. */
  setTarget(v) {
    this.target.copy(v);
    this.hasTarget = true;
    this.path.length = 0;
    this.pathIndex = 0;
    this.arrived = false;
  }

  /**
   * Steer at a point, but do nothing at all if that is already the target.
   *
   * Behaviour code that re-issues the same destination every frame - "walk back
   * to your post", "close on the player" - was clearing `arrived` on every
   * fixed step, so an agent standing on its target could never latch as having
   * got there and kept re-accelerating into it. Callers that genuinely want a
   * fresh target every frame still use `setTarget`.
   *
   * @param {THREE.Vector3} v
   * @param {number} [epsilon] treat targets closer than this as the same target
   * @returns {boolean} true if the target actually changed
   */
  setTargetIfNew(v, epsilon = 0.2) {
    if (this.hasTarget && this.path.length === 0 && this.target.distanceToSquared(v) < epsilon * epsilon) {
      return false;
    }
    this.setTarget(v);
    return true;
  }

  /** Follow a waypoint list, smoothed by line-of-sight string pulling. */
  setPath(points) {
    this.path = points ? points.map((p) => p.clone()) : [];
    this.pathIndex = 0;
    this.hasTarget = this.path.length > 0;
    if (this.hasTarget) this.target.copy(this.path[0]);
    this.arrived = false;
  }

  clear() {
    this.hasTarget = false;
    this.path.length = 0;
    this.arrived = true;
    this.desired.set(0, 0, 0);
  }

  get currentTarget() {
    return this.target;
  }

  /** True while the agent has somewhere to be. */
  get active() {
    return this.hasTarget && !this.arrived;
  }

  /**
   * Advance along a waypoint path, skipping ahead to the furthest waypoint the
   * agent can actually see. That is what turns a chain of corners into a
   * smooth diagonal instead of a series of hard turns.
   */
  _advancePath(position) {
    if (this.path.length === 0) return;
    let best = this.pathIndex;
    const limit = Math.min(this.path.length - 1, this.pathIndex + 3);
    for (let i = limit; i > this.pathIndex; i--) {
      if (this._clearLine(position, this.path[i])) {
        best = i;
        break;
      }
    }
    this.pathIndex = best;
    const wp = this.path[this.pathIndex];
    if (position.distanceToSquared(wp) < 1.1 * 1.1) {
      if (this.pathIndex < this.path.length - 1) this.pathIndex++;
    }
    this.target.copy(this.path[this.pathIndex]);
  }

  _clearLine(from, to) {
    _clDir.subVectors(to, from);
    _clDir.y = 0;
    const dist = _clDir.length();
    if (dist < 0.05) return true;
    _clDir.multiplyScalar(1 / dist);
    _clOrigin.set(from.x, from.y + 1.0, from.z);
    const hit = this.physics.raycast(_clOrigin, _clDir, dist, COLLISION_LAYER.WORLD);
    return !hit;
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3} position feet position
   * @param {number} maxSpeed
   * @param {THREE.Vector3} forward current facing (normalised, XZ)
   * @param {Array<{position:THREE.Vector3, isDead:boolean}>} neighbours
   * @returns {THREE.Vector3} desired velocity (reused - copy if you keep it)
   */
  update(dt, position, maxSpeed, forward, neighbours) {
    this.desired.set(0, 0, 0);
    if (!this.hasTarget) {
      // Keep decaying the avoidance state even when idle, so a character that
      // stops next to a wall does not carry a stale brake into its next walk.
      this._relax(dt);
      this._trackStuck(dt, position, 0);
      return this.desired;
    }

    this._advancePath(position);

    // --- seek / arrive ---------------------------------------------
    _upSeek.subVectors(this.target, position);
    _upSeek.y = 0;
    const dist = _upSeek.length();
    this.distanceToTarget = dist;
    if (dist < this.arriveRadius) {
      if (this.path.length === 0 || this.pathIndex >= this.path.length - 1) {
        // `arrived` latches until a new target is set. That is deliberate
        // hysteresis: a character nudged half a metre off its destination by a
        // neighbour must not re-accelerate into it.
        this.arrived = true;
        this._relax(dt);
        this._trackStuck(dt, position, 0);
        return this.desired;
      }
    }
    const speed = maxSpeed * clamp(dist / this.slowRadius, 0.25, 1);
    if (dist > 1e-4) _upSeek.multiplyScalar(speed / dist);
    this.desired.copy(_upSeek);
    // The seek direction is the reference the avoidance clamp works against, so
    // it has to be captured before anything else touches `desired`.
    const seekLen = _upSeek.length();
    if (seekLen > 1e-5) _upSeekDir.copy(_upSeek).multiplyScalar(1 / seekLen);
    else _upSeekDir.copy(forward);

    // --- wall avoidance --------------------------------------------
    // Deflect and brake. Never reverse - see the module header.
    this._probe(position, forward, dt);
    const brake = this.avoidBrake;
    if (brake > 0.001) {
      // Give up forward speed rather than steering through the wall.
      this.desired.multiplyScalar(1 - 0.9 * brake);
      // Slide along the face, and lean off it just enough to open a gap.
      this.desired.addScaledVector(this.avoidLateral, maxSpeed * 1.15 * brake);
      this.desired.addScaledVector(this.avoidPush, maxSpeed * 0.5 * brake);
    }

    // --- neighbour separation --------------------------------------
    // Steering separation only opens up personal space while an agent is
    // actually going somewhere. Bodies that are genuinely interpenetrating are
    // pulled apart positionally by NPCManager._separateBodies, which is a
    // constraint rather than a force and therefore cannot oscillate.
    if (neighbours) {
      _upSep.set(0, 0, 0);
      let n = 0;
      for (const other of neighbours) {
        if (other.isDead) continue;
        _upDelta.subVectors(position, other.position);
        _upDelta.y = 0;
        const d2 = _upDelta.lengthSq();
        if (d2 > this.separationRange * this.separationRange || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        // Inverse falloff: contact pushes hard, near-misses barely register.
        _upSep.addScaledVector(_upDelta, (this.separationRange - d) / (d * this.separationRange));
        n++;
      }
      if (n > 0) this.desired.addScaledVector(_upSep, maxSpeed * 0.9);
    }

    // --- detour after being stuck -----------------------------------
    if (this._detourTimer > 0) {
      this._detourTimer -= dt;
      // Perpendicular to the *seek* direction, not to the composite output.
      // Taking it off the composite fed the detour back into itself and made
      // the agent spiral instead of stepping cleanly around the obstruction.
      _upSide.set(-_upSeekDir.z, 0, _upSeekDir.x);
      this.desired.addScaledVector(_upSide, maxSpeed * 0.85 * this._detourSign);
    }

    // --- no-reversal clamp ------------------------------------------
    // Everything above may slow the agent, stop it, or push it sideways. None
    // of it is allowed to send it back the way it came: that is the oscillation
    // the player was seeing. A detour is exempt, because walking out and around
    // is exactly what a detour is for.
    if (this._detourTimer <= 0) {
      const along = this.desired.dot(_upSeekDir);
      if (along < 0) this.desired.addScaledVector(_upSeekDir, -along);
    }

    const len = this.desired.length();
    if (len > maxSpeed) this.desired.multiplyScalar(maxSpeed / len);

    // Stuck is measured against what the agent *wanted* - the seek speed - not
    // against the braked output. Feeding it the post-avoidance speed made the
    // detector self-defeating: the harder an agent was jammed against a prop,
    // the more avoidance braked it, the lower its "intended" distance, and the
    // less likely it became to ever be declared stuck. So it never re-targeted,
    // and stood there grinding instead. This is the case the player described
    // as "gets stuck at an object and starts glitching".
    this._trackStuck(dt, position, seekLen);
    return this.desired;
  }

  /**
   * Fan of raycasts ahead of the agent. Probes are staggered across frames -
   * one per frame per agent - so sixteen NPCs cost sixteen rays, not eighty.
   *
   * The raw fan is then reduced to a smoothed (lateral, push, brake) triple.
   * Smoothing is what makes the staggering invisible: without it the output
   * steps every time the round-robin comes back around.
   */
  _probe(position, forward, dt) {
    const reach = this.probeRange;
    _pbOrigin.set(position.x, position.y + 0.95, position.z);
    const fx = forward.x;
    const fz = forward.z;

    this._probePhase = (this._probePhase + 1) % PROBES.length;
    const i = this._probePhase;
    const p = PROBES[i];
    const cos = Math.cos(p.angle);
    const sin = Math.sin(p.angle);
    _pbDir.set(fx * cos - fz * sin, 0, fx * sin + fz * cos).normalize();
    const len = reach * p.reach;
    const hit = this.physics.raycast(_pbOrigin, _pbDir, len, COLLISION_LAYER.WORLD);
    if (hit) {
      this._probeHits[i] = 1 - hit.distance / len;
      this._probeNormals[i].copy(hit.normal);
      this._probeNormals[i].y = 0;
      if (this._probeNormals[i].lengthSq() < 1e-6) this._probeNormals[i].set(-_pbDir.x, 0, -_pbDir.z);
      this._probeNormals[i].normalize();
    } else {
      this._probeHits[i] = 0;
      if (this._slideLock <= 0) this._slideSign[i] = 0;
    }

    // Also probe low, where railings and kerbs live, on alternate frames.
    if (i === 0) {
      _pbOrigin.y = position.y + 0.32;
      _pbDir.set(fx, 0, fz);
      const low = this.physics.raycast(_pbOrigin, _pbDir, reach * 0.7, COLLISION_LAYER.WORLD);
      if (low) this._probeHits[0] = Math.max(this._probeHits[0], 1 - low.distance / (reach * 0.7));
    }

    this._slideLock = Math.max(0, this._slideLock - dt);

    _pbLateral.set(0, 0, 0);
    _pbPush.set(0, 0, 0);
    let strongest = 0;
    let weightSum = 0;
    for (let k = 0; k < PROBES.length; k++) {
      const h = this._probeHits[k];
      if (h <= 0) {
        if (this._slideLock <= 0) this._slideSign[k] = 0;
        continue;
      }
      if (h > strongest) strongest = h;
      const n = this._probeNormals[k];
      // Slide along the wall rather than bouncing off it. The side is latched:
      // on a head-on approach `perpendicular . forward` sits on zero and the
      // raw sign flips every frame, which is a left/right shimmy on screen.
      _pbSlide.set(-n.z, 0, n.x);
      const bias = _pbSlide.x * forward.x + _pbSlide.z * forward.z;
      let sign = this._slideSign[k];
      if (sign === 0) sign = bias >= 0 ? 1 : -1;
      else if (this._slideLock <= 0 && bias * sign < -SLIDE_FLIP_DEADBAND) sign = -sign;
      this._slideSign[k] = sign;

      const w = h * PROBES[k].weight;
      _pbLateral.addScaledVector(_pbSlide, w * sign);
      _pbPush.addScaledVector(n, w);
      weightSum += w;
      // Decay so a stale hit does not steer forever. Only probes that were not
      // refreshed this frame decay, so the freshest reading is never discounted
      // the instant it arrives.
      if (k !== i) this._probeHits[k] = Math.max(0, h - dt * PROBE_DECAY);
    }

    // Normalise to directions, then low-pass. Direction and magnitude are
    // smoothed separately so a probe dropping out cannot swing the heading.
    if (weightSum > 1e-5) {
      if (_pbLateral.lengthSq() > 1e-8) _pbLateral.normalize();
      if (_pbPush.lengthSq() > 1e-8) _pbPush.normalize();
    }
    const k = 1 - Math.exp(-AVOID_TRACK * dt);
    this.avoidLateral.lerp(_pbLateral, k);
    this.avoidPush.lerp(_pbPush, k);
    this.avoidBrake += (Math.min(1, strongest) - this.avoidBrake) * k;
    if (this.avoidBrake < 0.002) this.avoidBrake = 0;
    // Real contact: commit to the side we picked long enough to actually get
    // past whatever we are touching.
    if (strongest > SLIDE_LOCK_ENTER) this._slideLock = SLIDE_LOCK_TIME;

    // Kept in sync for telemetry and for anything outside that reads it.
    this.avoidance
      .copy(this.avoidLateral)
      .addScaledVector(this.avoidPush, 0.5)
      .multiplyScalar(this.avoidBrake);

    this.blocked = this.blocked ? strongest > BLOCKED_OFF : strongest > BLOCKED_ON;
  }

  /** Bleed the avoidance state away while the agent is not seeking anything. */
  _relax(dt) {
    const k = 1 - Math.exp(-AVOID_TRACK * dt);
    this.avoidBrake -= this.avoidBrake * k;
    if (this.avoidBrake < 0.002) this.avoidBrake = 0;
    this.avoidance.multiplyScalar(1 - k);
    if (this._detourTimer > 0) this._detourTimer -= dt;
    if (this.blocked && this.avoidBrake === 0) this.blocked = false;
  }

  _trackStuck(dt, position, desiredSpeed) {
    if (!this._lastValid) {
      // Seeding `_last` from the origin made the first window report a hundred
      // metres of travel, which suppressed stuck detection for the first second
      // of every character's life.
      this._last.copy(position);
      this._lastValid = true;
    }
    this._window += dt;
    _tsDelta.subVectors(position, this._last);
    _tsDelta.y = 0;
    this._accum += _tsDelta.length();
    this._last.copy(position);
    this._intended += desiredSpeed * dt;
    if (this._window < 1.1) return;
    const wanted = this._intended;
    this.isStuck = wanted > 0.5 && this._accum < wanted * 0.28;
    if (this.isStuck) {
      this.stuckCount++;
      // Do not re-arm a detour that is already running: re-rolling the sign
      // every time the window closes is how a "step around it" turns into a
      // twitch on the spot.
      if (this._detourTimer <= 0) {
        this._detourTimer = 0.9 + this._rnd() * 0.8;
        this._detourSign = this._rnd() < 0.5 ? -1 : 1;
      }
    } else {
      this.stuckCount = 0;
    }
    this._window = 0;
    this._accum = 0;
    this._intended = 0;
  }

  /** Called by the NPC when it accepts a re-target so the flag does not latch. */
  acknowledgeStuck() {
    this.isStuck = false;
    // The window has to restart too. Leaving a part-filled window in place made
    // the next evaluation fire early against a fraction of the intended
    // distance, so an agent that had just been given a fresh target could be
    // declared stuck again a few frames later.
    this._window = 0;
    this._accum = 0;
    this._intended = 0;
  }
}
