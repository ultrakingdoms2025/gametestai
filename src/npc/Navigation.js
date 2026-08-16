import * as THREE from 'three';
import { COLLISION_LAYER } from '../physics/Physics.js';
import { waterDepthAt, isDeepWater, WADE_DEPTH, WALKABLE_NORMAL_Y } from './Grounding.js';

/**
 * Per-agent steering.
 *
 * There is no navmesh in this game - worlds are generated procedurally and a
 * baked graph would go stale the moment a world changed. Instead every agent
 * runs seek/arrive against a target, then subtracts what it can see with a fan
 * of probe raycasts and pushes away from its neighbours. A stuck detector
 * catches the cases steering alone cannot solve and re-targets.
 *
 * The target may be a point (`setTarget`) or an ordered route (`setPath`). A
 * route is walked IN ORDER, corner to corner - it is the authored answer to
 * "where may this character walk", and the one thing that lets a character go
 * somewhere the steering could not have found on its own: up a stair flight,
 * round a walkway, along a road. @see _advancePath for what that costs and for
 * the shortcut that used to undo it.
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

/** _waterAvoid() owns these exclusively. */
const _waSample = new THREE.Vector3();
const _waAway = new THREE.Vector3();

/**
 * Where to sample for water, as (forward, lateral) metres from the agent.
 *
 * Sampled one per frame round-robin, exactly like the wall probe fan and for
 * the same reason: a character near the river would otherwise pay three
 * raycasts every frame for a question whose answer changes slowly.
 *
 * The lateral pair matters as much as the forward one - a character walking
 * *along* a bank needs to know which side the water is on to slide away from
 * it, and a purely forward probe reads clear right up until it steps in.
 */
const WATER_PROBES = [
  [2.2, 0], [3.6, 0], [1.6, 1.4], [1.6, -1.4], [0, 1.8], [0, -1.8],
];

/** How fast the smoothed water response tracks the raw samples. */
const WATER_TRACK = 6;
/** Per-second decay when no probe has found water. */
const WATER_DECAY = 1.5;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * Is this probe hit a walking surface rather than something to steer around?
 *
 * ── The defect this closes ───────────────────────────────────────────────
 * Nothing in this game ever climbed a flight of stairs, an escalator or a ramp,
 * and this is why. The probe fan is a fan of HORIZONTAL raycasts from shin and
 * hip height, and a slope in front of a character's shins is a solid surface a
 * horizontal ray runs into - so every ramp in every world read to the steering
 * as a wall, and the response to a wall is to brake and slide along it. Measured
 * on the station: a civilian steered at the head of the walkway flight at
 * bearing 30, starting from open deck, walks in to the bottom step and stays
 * there - 22 s with `avoidBrake` oscillating between 0.30 and 0.62, `blocked`
 * latching on and off, and its height never leaving the deck. It was sliding
 * along the foot of the stair exactly as designed. The crowd's whole population
 * sat under y = 3 in a world whose promenade is at 10.
 *
 * A surface whose normal points up is floor. The threshold is the one
 * `Grounding` already uses to decide what a character may stand on, so "the
 * steering will walk at it" and "the grounding will hold it up" are the same
 * question answered by the same number - which is the property that stops this
 * becoming a second, disagreeing definition of walkable.
 *
 * Steep faces are unaffected: a wall's normal has `y` near zero, and a slope too
 * steep to stand on still brakes, which is what should happen to a character
 * about to walk into a cliff.
 *
 * Every caller here hands this a RAYCAST hit, whose normal is the true face
 * normal, so the threshold means here exactly what it says: 56.6 degrees. That
 * is worth knowing because the same constant does NOT mean 56.6 degrees where
 * it is compared against `resolveCapsule`'s contact normals - those diverge
 * past ~44 degrees, which is what really sets the player's walkable ceiling.
 * Keep raycast normals and solver normals apart when reasoning about this.
 * @see ./Grounding.js `WALKABLE_NORMAL_Y`
 */
function isFloorHit(hit) {
  return (hit?.normal?.y ?? 0) >= WALKABLE_NORMAL_Y;
}

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
    /**
     * Where the current leg started: the previous waypoint, or the position the
     * agent was standing at when the path was handed over. @see _advancePath
     */
    this._legStart = new THREE.Vector3();
    this._legStartValid = false;

    this.arriveRadius = 0.55;
    this.slowRadius = 2.4;
    /**
     * How close counts as having turned a corner.
     *
     * This is the whole of the corner rounding a route gets: a waypoint is
     * "reached" inside this radius, so the agent starts its turn this far out
     * rather than walking into the corner and pivoting on the spot. Any larger
     * and it is a shortcut - on a 4 m catwalk a 2 m radius is the outside edge.
     */
    this.waypointRadius = 1.1;
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
    /**
     * Water volumes for the active world, injected by NPCManager. Null in
     * worlds that have none, which turns every water test below into one
     * comparison and nothing else.
     */
    this.water = null;
    /** Smoothed 0..1 "how much of the way into deep water am I heading". */
    this._waterBrake = 0;
    /** Round-robin cursor over WATER_PROBES, one sample per agent per frame. */
    this._waterPhase = 0;
    /** Last direction that pointed away from water, latched like a slide side. */
    this._waterAway = new THREE.Vector3();

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
    this._legStartValid = false;
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

  /**
   * Walk an ordered waypoint list, in order, corner to corner.
   *
   * This is the route follower. The contract is deliberately narrow and it is
   * worth stating outright, because the thing it replaced looked like one:
   *
   *   - Waypoints are visited in the order given. None is ever skipped.
   *   - The agent steers at ONE waypoint at a time, so the only ground it is
   *     ever asked to cross is the ground between two CONSECUTIVE waypoints -
   *     which is the ground the route's author chose.
   *   - Avoidance still applies on top, unchanged. A route is where to go, not
   *     a promise that nothing is in the way.
   *
   * It is not a planner. It cannot get a character from an arbitrary place to
   * an arbitrary place, and nothing here builds a graph or a navmesh - see the
   * module header for why this game does not have one. Getting BACK to a route
   * after being knocked off it is the caller's problem; `NPC.routeAhead` solves
   * it by re-entering at the nearest waypoint.
   */
  setPath(points) {
    let list = points ? points.map((p) => p.clone()) : [];
    /* Authored patrol routes predate the water volumes, and some of them ford
     * the river. Dropping the wet waypoints here rather than at each call site
     * covers every route in the game at once - which is what was still putting
     * one hostile out of its depth after the destination and line checks had
     * caught everyone else.
     *
     * If a route is wet end to end it is kept as authored: a patrol that goes
     * nowhere is a worse bug than a patrol that gets its feet wet, and the
     * steering term will still lean the agent away from the deepest part. */
    if (this.water && list.length > 1) {
      // At the waypoint's OWN height, so a route that crosses a bridge keeps
      // its deck legs. @see Grounding.waterDepthAt
      const dry = list.filter((p) => !this.isDeepWaterAt(p.x, p.z, p.y));
      if (dry.length > 1) list = dry;
    }
    this.path = list;
    this.pathIndex = 0;
    // The first leg runs from wherever the agent is standing, which `update`
    // knows and this does not. Captured on the first step. @see _advancePath
    this._legStartValid = false;
    this.hasTarget = this.path.length > 0;
    if (this.hasTarget) this.target.copy(this.path[0]);
    this.arrived = false;
  }

  clear() {
    this.hasTarget = false;
    this.path.length = 0;
    this.pathIndex = 0;
    this._legStartValid = false;
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
   * Advance to the next waypoint, and only ever to the NEXT one.
   *
   * ── What this replaced, and why it had to go ─────────────────────────────
   * This used to string-pull: it looked up to three waypoints ahead and jumped
   * to the furthest one `_clearLine` said it could see, "to turn a chain of
   * corners into a smooth diagonal". The smoothing is real. The line test is
   * not: `_clearLine` is a single HORIZONTAL raycast at hip height, so it
   * reports "clear" for a shortcut across a drop, off a ledge, over a stairwell
   * or through a river - none of which put anything solid in front of a hip.
   * Measured on a 4 m L-shaped catwalk over a 20 m void, with the shortcut
   * across the inside of the elbow being 25 m of open air: `_clearLine` returns
   * true, and the character spends 2,270 of 7,200 fixed steps below the deck.
   * The station's promenade routes were authored as single-bearing corridors
   * specifically so that no pair of waypoints could produce a line that leaves
   * the walkway - a workaround for exactly this.
   *
   * So the smoothing is gone and the corner rounding that survives is
   * `waypointRadius`, which is bounded and local. The agent walks the ground
   * its route was authored over, and nothing else.
   *
   * ── Correct when a step is eight frames long ─────────────────────────────
   * `NPCManager` bands the simulation: a demoted character is stepped every
   * Nth frame with N frames' worth of `dt` at once, so one call to this can
   * follow a metre and a half of travel. Two things make that safe.
   *
   *  1. A waypoint counts as reached when the agent is inside `waypointRadius`
   *     of it OR has passed the plane through it perpendicular to the leg it
   *     arrived on. The radius alone is a band, and a long step can jump clean
   *     over a band - after which the seek turns the character round and walks
   *     it back, which is the ping-pong this half exists to stop.
   *  2. It LOOPS. A single long step can consume more than one waypoint on a
   *     route with short legs, and advancing one per call would leave the
   *     character chasing a corner it is already past.
   *
   * The loop is bounded by the path length: each iteration re-tests against
   * that waypoint's own leg, so a route that doubles back stops the loop dead
   * (the agent has not passed the reversed leg's end) rather than unwinding.
   */
  _advancePath(position) {
    const path = this.path;
    const last = path.length - 1;
    if (last < 0) return;
    if (!this._legStartValid) {
      this._legStart.copy(position);
      this._legStartValid = true;
    }
    let guard = path.length;
    while (guard-- > 0 && this.pathIndex < last && this._reachedWaypoint(position, this.pathIndex)) {
      this._legStart.copy(path[this.pathIndex]);
      this.pathIndex++;
    }
    this.target.copy(path[this.pathIndex]);
  }

  /**
   * Is the agent at, or past, waypoint `i`?
   *
   * XZ only - a route up a stair flight has waypoints 10 m apart vertically and
   * a character on the third step of it is not "far from" the one at the top in
   * any sense the steering cares about.
   */
  _reachedWaypoint(position, i) {
    const wp = this.path[i];
    const dx = position.x - wp.x;
    const dz = position.z - wp.z;
    if (dx * dx + dz * dz < this.waypointRadius * this.waypointRadius) return true;
    // Past the plane through the waypoint, normal along the leg we came in on.
    // Only the SIGN of the projection matters, and dividing by a positive leg
    // length cannot change a sign - so this is the plane test with the square
    // root taken out of it, which is worth doing in something that runs once
    // per path-following character per step.
    const lx = wp.x - this._legStart.x;
    const lz = wp.z - this._legStart.z;
    // A zero-length leg has no plane. Duplicate waypoints do happen in authored
    // routes; the radius test above is the whole answer for them.
    if (lx * lx + lz * lz < 1e-8) return false;
    return dx * lx + dz * lz >= 0;
  }

  /**
   * Is the straight line from `from` to `to` free of walls?
   *
   * NOT a walkability test, and callers must not read it as one - see the note
   * on `_advancePath`, which used to. It is one horizontal raycast at hip
   * height, so it sees walls, props and cliff faces, and it is blind to
   * everything under the agent's feet: a drop, a ledge, a stairwell, a river.
   * It is the right question for "is there something in the way of this walk",
   * and the wrong one for "may I cut this corner".
   */
  _clearLine(from, to) {
    _clDir.subVectors(to, from);
    _clDir.y = 0;
    const dist = _clDir.length();
    if (dist < 0.05) return true;
    _clDir.multiplyScalar(1 / dist);
    _clOrigin.set(from.x, from.y + 1.0, from.z);
    const hit = this.physics.raycast(_clOrigin, _clDir, dist, COLLISION_LAYER.WORLD);
    // A floor is not an obstruction, and a ramp is a floor. @see isFloorHit
    return !hit || isFloorHit(hit);
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
    const finalLeg = this.path.length === 0 || this.pathIndex >= this.path.length - 1;
    if (dist < this.arriveRadius && finalLeg) {
      // `arrived` latches until a new target is set. That is deliberate
      // hysteresis: a character nudged half a metre off its destination by a
      // neighbour must not re-accelerate into it.
      this.arrived = true;
      this._relax(dt);
      this._trackStuck(dt, position, 0);
      return this.desired;
    }
    /* Slow down for the DESTINATION, not for every corner on the way to it.
     *
     * The arrive term used to apply to whatever `target` currently held, which
     * on a path is the next waypoint - so a character walking a six-point round
     * decelerated to a quarter speed six times and read as marching between
     * cones rather than walking a route. Overshooting a corner is what the
     * plane test in `_advancePath` is for; it does not need to be prevented by
     * crawling into it. */
    const speed = finalLeg ? maxSpeed * clamp(dist / this.slowRadius, 0.25, 1) : maxSpeed;
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

    // --- water avoidance -------------------------------------------
    // Applied after the wall term and before separation, so a character pinned
    // between a wall and the river still gets pushed along the bank rather than
    // into it. Deliberately stronger than wall avoidance: walking into a wall
    // looks clumsy, walking into a river looks broken.
    this._waterAvoid(position, dt);
    if (this._waterBrake > 0.001) {
      const wb = this._waterBrake;
      this.desired.multiplyScalar(1 - 0.95 * wb);
      this.desired.addScaledVector(this._waterAway, maxSpeed * 1.4 * wb);
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
    // is exactly what a detour is for - and so is water, because the one case
    // where reversing *is* the right answer is a target on the far bank. Left
    // clamped, the agent would keep leaning into the river for as long as it
    // held that target, which is the behaviour this whole term exists to stop.
    if (this._detourTimer <= 0 && this._waterBrake < 0.25) {
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
    const raw = this.physics.raycast(_pbOrigin, _pbDir, len, COLLISION_LAYER.WORLD);
    // A ramp, a stair flight or a hillside is somewhere to walk, not something
    // to steer around. @see isFloorHit
    const hit = raw && isFloorHit(raw) ? null : raw;
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
      // The low probe is the one a ramp fools hardest - the foot of a 30 degree
      // flight is 0.55 m in front of a character's shins - so it gets the same
      // floor test the fan does.
      if (low && !isFloorHit(low)) {
        this._probeHits[0] = Math.max(this._probeHits[0], 1 - low.distance / (reach * 0.7));
      }
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
    this._waterBrake -= this._waterBrake * (1 - Math.exp(-WATER_DECAY * dt));
    if (this._waterBrake < 0.002) this._waterBrake = 0;
    if (this._detourTimer > 0) this._detourTimer -= dt;
    if (this.blocked && this.avoidBrake === 0) this.blocked = false;
  }

  /**
   * Is the column at (x, z) too deep to walk into?
   *
   * Public because destination pickers need the same answer steering does -
   * a wander target chosen in the middle of the river would have the agent
   * grinding against the bank until the stuck detector re-rolled it.
   *
   * `probeY` is the height of whatever will be STANDING there, and it is what
   * makes a bridge deck readable - see `Grounding.waterDepthAt`. Callers that
   * are picking a spot on the ground have no such height and pass none, which
   * is the conservative answer.
   *
   * @param {number} x
   * @param {number} z
   * @param {number} [probeY]
   * @returns {boolean}
   */
  isDeepWaterAt(x, z, probeY) {
    return this.water ? isDeepWater(this.physics, this.water, x, z, probeY) : false;
  }

  /**
   * Can the agent walk the straight line from `from` to `to` without swimming?
   *
   * Rejecting wet *destinations* is not enough on its own, and the measurement
   * says so: with only that check three medieval characters still spent 4-18%
   * of their time out of their depth, because a perfectly dry spot on the far
   * bank is a perfectly valid destination and the direct route to it goes
   * through the river. Steering then fought the seek all the way across.
   *
   * Sampled rather than swept - a couple of metres of stride is finer than any
   * water body in these worlds is narrow - and capped, so a long route costs a
   * bounded number of probes. Away from water each one is a hash miss.
   *
   * Every sample is probed at the HIGHER of the two endpoints, not at an
   * interpolated height, and that is the difference between a bridge being a
   * route and a bridge being a wall. A deck is flat and both its approaches are
   * below it, so an interpolated probe passes UNDER the planks for most of the
   * span and reads the riverbed - which is the same deck-blindness
   * `Grounding.waterDepthAt` exists to fix, reintroduced one level up. Taking
   * the maximum cannot invent a crossing: the ray still has to hit real
   * geometry above the waterline at each sample, so a line that leaves the
   * deck and goes over open water is refused exactly as before.
   *
   * @param {THREE.Vector3} from
   * @param {THREE.Vector3} to
   * @param {number} [step] metres between samples
   * @returns {boolean}
   */
  waterFreeLine(from, to, step = 2.5) {
    if (!this.water) return true;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const probeY = Math.max(from.y ?? -Infinity, to.y ?? -Infinity);
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-3) return !this.isDeepWaterAt(to.x, to.z, probeY);
    const n = Math.min(14, Math.max(1, Math.ceil(dist / step)));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      if (this.isDeepWaterAt(from.x + dx * t, from.z + dz * t, probeY)) return false;
    }
    return true;
  }

  /**
   * Sample for deep water around the agent and build a push away from it.
   *
   * One sample per frame, round-robin over {@link WATER_PROBES}, smoothed the
   * same way the wall fan is - so the response is continuous even though the
   * evidence arrives one point at a time. `waterDepthAt` costs a hash lookup
   * away from water, so agents nowhere near the river pay almost nothing.
   *
   * ── THE THIRD PLACE THE DECK HAD TO BE MADE VISIBLE ────────────────────
   * Refusing wet destinations and wet routes is not enough on its own, because
   * this term does not consult either: it probes the ground around the agent
   * directly. Measured in a live session with the fix in the other two places
   * and not this one, four wolves standing ON the Aldern deck at y = 4.4 with
   * clear line of sight, one of them holding the pack's attack slot and asking
   * for `chargeSpeed` 7.6: `_waterBrake` read 0.67 and the animal was moving at
   * 2.27 m/s. They crossed thirteen metres of bridge in twelve seconds and
   * never landed a blow. The brake was reading the riverbed 5 m under the
   * planks they were standing on.
   *
   * So the probe is taken at the AGENT's own height. It cannot invent dry land
   * - the ray still has to hit geometry above the waterline at that column -
   * and something already in the river has its feet at or below the surface, so
   * its answer is unchanged. @see Grounding.waterDepthAt
   */
  _waterAvoid(position, dt) {
    if (!this.water) {
      if (this._waterBrake > 0) {
        this._waterBrake -= this._waterBrake * (1 - Math.exp(-WATER_DECAY * dt));
        if (this._waterBrake < 0.002) this._waterBrake = 0;
      }
      return;
    }

    this._waterPhase = (this._waterPhase + 1) % WATER_PROBES.length;
    const [ahead, lateral] = WATER_PROBES[this._waterPhase];
    // Probe in the direction of travel, not of facing: an agent being pushed
    // sideways by separation can enter the water without ever facing it.
    const dir = this.desired.lengthSq() > 1e-4 ? this.desired : null;
    let fx = 0;
    let fz = 1;
    if (dir) {
      const l = Math.hypot(dir.x, dir.z);
      if (l > 1e-4) { fx = dir.x / l; fz = dir.z / l; }
    }
    _waSample.set(
      position.x + fx * ahead - fz * lateral,
      position.y,
      position.z + fz * ahead + fx * lateral
    );

    const depth = waterDepthAt(this.physics, this.water, _waSample.x, _waSample.z, position.y);
    const k = 1 - Math.exp(-WATER_TRACK * dt);
    if (depth > WADE_DEPTH) {
      // Ramp over the half-metre past wading depth so a shelving bank produces
      // a lean rather than a wall.
      const raw = clamp((depth - WADE_DEPTH) / 0.5, 0, 1);
      _waAway.set(position.x - _waSample.x, 0, position.z - _waSample.z);
      const l = _waAway.length();
      if (l > 1e-4) {
        _waAway.multiplyScalar(1 / l);
        // Blend rather than replace: successive probes around a bend should
        // average into "away from the river", not snap between sample points.
        this._waterAway.lerp(_waAway, k).normalize();
      }
      this._waterBrake += (raw - this._waterBrake) * k;
    } else {
      this._waterBrake -= this._waterBrake * (1 - Math.exp(-WATER_DECAY * dt));
      if (this._waterBrake < 0.002) this._waterBrake = 0;
    }
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
