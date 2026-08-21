import * as THREE from 'three';
import { CONFIG } from '../core/Config.js';
import { COLLISION_LAYER } from '../physics/Physics.js';

/**
 * Ledge detection and the mantle that follows it.
 *
 * The design constraint that shapes everything here is **not stealing the
 * jump**. `Space` is already the most-pressed key in the game, so a mantle can
 * only ever fire when the probe has proven all four of these at once:
 *
 *   1. There is a near-vertical surface within arm's reach in front (a *wall*,
 *      not a ramp - the normal must be within ~65 degrees of horizontal).
 *   2. Its top edge is above what a jump would clear anyway, and below 2.4 m.
 *      `CONFIG.player.stepHeight` handles kerbs and stair treads and the jump
 *      handles the next 0.9 m; the mantle only exists above that, which is why
 *      it never triggers on the castle stairs or the skate-park transitions.
 *   3. The top is flat enough to stand on (normal.y > 0.7).
 *   4. A full-height capsule dropped on the landing spot does not get shoved.
 *      That is the real test for "clear standing room" - a raycast alone says
 *      nothing about a bollard 20 cm to the side.
 *
 * The hoist itself is two eased phases (up, then in), not a teleport: the
 * player's eye rises over ~0.4 s, the body tucks, the arms reach and pull, and
 * only then does the capsule move forward onto the ledge. Collision is skipped
 * *during* those phases because the destination has already been proven clear -
 * resolving mid-hoist would eject the capsule out of the wall it is climbing.
 */

const P = CONFIG.player;
const clamp = THREE.MathUtils.clamp;
const damp = THREE.MathUtils.damp;
const smootherstep = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** How far past the capsule the wall probe reaches. */
const REACH = 0.55;
/**
 * Lowest ledge worth a mantle from solid ground, AT THIS GAME'S OWN GRAVITY.
 *
 * Jump apex is v^2/2g = 6.4^2/44 = 0.93 m, so anything below this is already
 * reachable and a mantle would only feel like the game taking the controls.
 *
 * ── Why that sentence needed a world attached to it ───────────────────────
 * It was written when 0.93 m was the apex EVERYWHERE. Ten planets publish a
 * surface gravity now and the apex goes as `r^(-1/3)`, so on Tessera it is
 * 1.668 m - and the constant, left absolute, would have mantled every ledge
 * between 1.0 m and 1.67 m on a moon where a hop clears all of them. The
 * mantle would not have BROKEN there; it takes priority over the jump, so it
 * would quietly have taken the controls for the exact case the sentence above
 * says it must not - and the justification, not the code, is what would have
 * been wrong, which is the harder defect to find.
 *
 * So the constant stays what it is and the SENTENCE is what is implemented:
 * "above what a jump already clears", scaled by the ratio of this world's apex
 * to the default one. It is a literal 1.0 on every world that publishes no
 * gravity, and 0.990 m on Verdigris, which is what a planet at 1.03 g deserves.
 * @see ./Player.js `jumpApex` and the per-world gravity design block
 */
const MIN_RISE_GROUND = 1.0;
/** In water there is no jump, so a swimmer may haul out over a much lower lip. */
const MIN_RISE_WATER = 0.25;
const MAX_RISE = 2.4;
/**
 * The apex the ratio above is measured against - `v^2/2g` at the config's own
 * numbers, i.e. the 0.93 m the sentence quotes, computed rather than retyped so
 * the two can never drift.
 */
const DEFAULT_APEX = (P.jumpVelocity * P.jumpVelocity) / (2 * -P.gravity);
/**
 * ...and the hard ceiling on where that scaling may put the floor.
 *
 * `MAX_RISE` does NOT scale - it is how far a pair of arms reaches, not how
 * hard the world pulls - so a floor that scales without a ceiling eventually
 * crosses it, and `minRise >= MAX_RISE` is not a narrow band, it is the verb
 * DELETED, silently, with no log and no error. `worldGravityRatio` clamps at
 * 0.01, which puts the unclamped floor at 4.64 m: nearly twice MAX_RISE.
 *
 * 2.0 m is a clear step below MAX_RISE so a band always survives, and it does
 * not bind on any planet in the game - the lightest, Tessera at 1.62 m/s²,
 * asks for 1.823 m. It is a rail against a descriptor typo, on the same terms
 * as the ratio clamp itself, and not a tuning knob.
 */
const MIN_RISE_CEILING = 2.0;
/** Heights the wall probe samples, relative to the feet. */
const WALL_PROBE_H = [0.45, 0.95, 1.45];
/** A surface this far from vertical is a ramp the movement code already climbs. */
const WALL_NORMAL_Y = 0.42;
/** A top face must be at least this flat to be standable. */
const TOP_NORMAL_Y = 0.7;
/** How far in from the edge the player is placed. */
const LAND_INSET = 0.42;
/** Re-probe every N fixed steps while idle, so the HUD prompt stays live cheaply. */
const PROBE_INTERVAL = 4;
/** Hard ceiling on a hoist, in case something moves under us mid-climb. */
const MAX_DURATION = 1.6;

/* Scratch. Each function owns its own - see the note in physics/Physics.js. */
const _prOrigin = new THREE.Vector3();
const _prDir = new THREE.Vector3();
const _prDown = new THREE.Vector3(0, -1, 0);
const _prUp = new THREE.Vector3(0, 1, 0);
const _prCap = new THREE.Vector3();
const _clStart = new THREE.Vector3();
const _clLand = new THREE.Vector3();
const _poseQ = new THREE.Quaternion();
const _poseE = new THREE.Euler();

export class Climb {
  /**
   * @param {{ player: import('./Player.js').Player,
   *           physics: import('../physics/Physics.js').Physics,
   *           bus: import('../core/EventBus.js').EventBus,
   *           input: import('../core/Input.js').Input }} ctx
   */
  constructor({ player, physics, bus, input }) {
    this.player = player;
    this.physics = physics;
    this.bus = bus;
    this.input = input;

    this._active = false;
    this._t = 0;
    this._upTime = 0.34;
    this._fwdTime = 0.24;
    this._topY = 0;
    this._fromWater = false;
    this._pullX = 0;
    this._pullZ = 0;

    /** Cached probe result, refreshed on a timer so the HUD can show a prompt. */
    this._candidate = null;
    this._probeTick = 0;

    /* --- pose state ------------------------------------------------ */
    this._poseWeight = 0;
    this._poseApplied = false;
  }

  /* ================================================================ */
  /* Accessors                                                         */
  /* ================================================================ */

  get active() {
    return this._active;
  }

  /**
   * The ledge the player is currently facing, or null.
   * @returns {{ topY: number, rise: number, landX: number, landZ: number }|null}
   */
  get candidate() {
    return this._candidate;
  }

  /** Progress through the hoist, 0..1. */
  get progress() {
    return this._active ? clamp(this._t / (this._upTime + this._fwdTime), 0, 1) : 0;
  }

  /* ================================================================ */
  /* Detection                                                         */
  /* ================================================================ */

  /**
   * Refresh the cached ledge candidate. Cheap enough to run at 15 Hz, which is
   * all a UI prompt needs.
   * @param {boolean} inWater
   */
  poll(inWater) {
    if (this._active) return;
    if (++this._probeTick % PROBE_INTERVAL) return;
    this._candidate = this._probe(inWater);
  }

  /**
   * Attempt a mantle. Called on a fresh `Space` press *before* the jump is
   * resolved, so a found ledge consumes the press and a miss falls through to
   * an ordinary jump.
   *
   * @param {number} elapsed
   * @param {{ inWater?: boolean }} [opts]
   * @returns {boolean} true when a hoist started
   */
  tryStart(elapsed, { inWater = false, fromWall = false } = {}) {
    if (this._active || this.player.isDead) return false;

    // Always re-probe on the press: the cached one can be up to four steps old
    // and the player may have turned since.
    const cand = this._probe(inWater, fromWall);
    this._candidate = cand;
    if (!cand) return false;

    const stam = this.player.stamina;
    if (stam) {
      // Hauling out of water is a survival action and is never gated - a
      // drowning player who cannot climb out is a soft lock. Dry-land mantles
      // cost the full amount and refuse if it is not there, which is what
      // stops a wall being climbed indefinitely.
      if (inWater) stam.drain(Math.min(stam.value, P.climbStaminaCost * 0.35), 'climb-water');
      // A free climb has been paying for itself continuously all the way up the
      // face; charging the full standing-mantle cost again at the lip would
      // routinely fail the topout and drop the player off a tower they had
      // already climbed, which is the worst possible moment to run out.
      else if (fromWall) stam.drain(Math.min(stam.value, P.climbStaminaCost * 0.25), 'climb-wall');
      else if (!stam.spend(P.climbStaminaCost, 'climb')) {
        this.bus?.emit('hud:notify', { text: 'Too exhausted to climb', tone: 'warn' });
        return false;
      }
    }

    const p = this.player;
    _clStart.copy(p.position);
    _clLand.set(cand.landX, cand.topY, cand.landZ);
    this._topY = cand.topY;
    this._fromWater = inWater;
    this._t = 0;
    // Taller ledges take longer, so the hoist reads as effort rather than as a
    // fixed-length canned move.
    this._upTime = 0.26 + clamp(cand.rise, 0, MAX_RISE) * 0.1;
    this._fwdTime = 0.22;
    this._active = true;
    // Pull toward the wall during the rise: hands on the edge, chest against it.
    this._pullX = (cand.wallX - _clStart.x) * 0.22;
    this._pullZ = (cand.wallZ - _clStart.z) * 0.22;

    p.velocity.set(0, 0, 0);
    this.bus?.emit('player:climb', { climbing: true, rise: cand.rise, fromWater: inWater });
    void elapsed;
    return true;
  }

  /**
   * `MIN_RISE_GROUND` on the world the player is standing on.
   *
   * Reads the apex off `Player`, which resolved it once on `world:changed`,
   * rather than recomputing the exponent here - see the note on
   * {@link Player#jumpScale}. On a world that publishes no gravity `jumpApex`
   * is the same expression as `DEFAULT_APEX` over the same config constants, so
   * the quotient is exactly 1 and the product is exactly `MIN_RISE_GROUND`.
   *
   * `DEFAULT_APEX` is a positive config constant, so this cannot divide by
   * zero; `jumpApex` is finite because the ratio behind it is clamped; and the
   * ceiling bounds the result whatever arrives. @see MIN_RISE_CEILING
   */
  _minRiseGround() {
    const apex = this.player?.jumpApex;
    if (!Number.isFinite(apex) || apex <= 0) return MIN_RISE_GROUND;
    const scaled = MIN_RISE_GROUND * (apex / DEFAULT_APEX);
    return scaled > MIN_RISE_CEILING ? MIN_RISE_CEILING : scaled;
  }

  /**
   * Look for a mantle-able ledge in front of the player.
   * @returns {{topY:number, rise:number, landX:number, landZ:number,
   *            wallX:number, wallZ:number}|null}
   */
  _probe(inWater, fromWall = false) {
    const p = this.player;
    const pos = p.position;
    const phys = this.physics;
    const fx = -Math.sin(p.yaw);
    const fz = -Math.cos(p.yaw);
    _prDir.set(fx, 0, fz);

    /* A free climb tops out with its hands already on the lip, so the rise left
     * to cover is centimetres rather than the metre a standing mantle needs. The
     * ground minimum exists to stop the game taking the controls for something a
     * jump would clear - it does not apply to someone already hanging off the
     * wall. See player/FreeClimb.js. */
    const minRise = (inWater || fromWall) ? MIN_RISE_WATER : this._minRiseGround();
    const reach = P.radius + REACH;

    /* ---- 1. a wall in front ------------------------------------------ */
    let wallX = 0;
    let wallZ = 0;
    let found = false;
    for (let i = 0; i < WALL_PROBE_H.length; i++) {
      const h = WALL_PROBE_H[i];
      // Probing below the ledge top is pointless; skip samples above it.
      _prOrigin.set(pos.x, pos.y + h, pos.z);
      const hit = phys.raycast(_prOrigin, _prDir, reach, COLLISION_LAYER.WORLD);
      if (!hit) continue;
      if (Math.abs(hit.normal.y) > WALL_NORMAL_Y) continue; // a ramp, not a wall
      wallX = hit.point.x;
      wallZ = hit.point.z;
      found = true;
      break;
    }
    if (!found) return null;

    /* ---- 2. its top edge --------------------------------------------- */
    // Probe from just inside the far face, straight down. Starting above
    // MAX_RISE means an overhanging wall returns a top that fails the range
    // test rather than a false positive at head height.
    const inX = wallX + fx * 0.14;
    const inZ = wallZ + fz * 0.14;
    _prOrigin.set(inX, pos.y + MAX_RISE + 0.45, inZ);
    const top = phys.raycast(_prOrigin, _prDown, MAX_RISE + 1.6, COLLISION_LAYER.WORLD);
    if (!top || top.normal.y < TOP_NORMAL_Y) return null;

    const topY = top.point.y;
    const rise = topY - pos.y;
    if (rise < minRise || rise > MAX_RISE) return null;

    /* ---- 3. headroom over the ledge ----------------------------------- */
    const landX = wallX + fx * (P.radius + LAND_INSET);
    const landZ = wallZ + fz * (P.radius + LAND_INSET);
    _prOrigin.set(landX, topY + 0.12, landZ);
    if (phys.raycast(_prOrigin, _prUp, P.height - 0.2, COLLISION_LAYER.WORLD)) return null;

    /* ---- 4. real standing room ---------------------------------------- */
    // Seat the test capsule a hair *inside* the top face so the solver ejects
    // it upward and reports ground, exactly as `_move` does for a stair tread.
    _prCap.set(landX, topY - 0.03, landZ);
    const res = phys.resolveCapsule(_prCap, P.radius, P.height);
    if (!res.grounded) return null;
    if (Math.hypot(_prCap.x - landX, _prCap.z - landZ) > 0.2) return null;
    if (_prCap.y > topY + 0.3 || _prCap.y < topY - 0.35) return null;

    return { topY: _prCap.y, rise: _prCap.y - pos.y, landX: _prCap.x, landZ: _prCap.z, wallX, wallZ };
  }

  /* ================================================================ */
  /* The hoist                                                         */
  /* ================================================================ */

  /**
   * Drive an in-flight mantle. The Player calls this instead of its own
   * movement integration while `active` is true.
   *
   * @param {number} dt
   * @param {number} elapsed
   * @returns {boolean} true while the hoist still owns movement
   */
  fixedUpdate(dt, elapsed) {
    if (!this._active) return false;
    const p = this.player;
    if (p.isDead) {
      this._finish(false);
      return false;
    }

    this._t += dt;
    const total = this._upTime + this._fwdTime;
    const pos = p.position;

    if (this._t < this._upTime) {
      /* ---- phase 1: rise, hands to the edge ------------------------- */
      const k = smootherstep(clamp(this._t / this._upTime, 0, 1));
      // A little overshoot above the lip is what sells the effort; the forward
      // phase settles back onto it.
      pos.y = THREE.MathUtils.lerp(_clStart.y, this._topY + 0.1, k);
      pos.x = _clStart.x + this._pullX * k;
      pos.z = _clStart.z + this._pullZ * k;
      // Tuck: the capsule (and therefore the avatar) crouches into the pull.
      p.setClimbStance(0.55 + 0.45 * (1 - k), dt);
    } else {
      /* ---- phase 2: swing the body over the lip --------------------- */
      const k = smootherstep(clamp((this._t - this._upTime) / this._fwdTime, 0, 1));
      const fromX = _clStart.x + this._pullX;
      const fromZ = _clStart.z + this._pullZ;
      pos.x = THREE.MathUtils.lerp(fromX, _clLand.x, k);
      pos.z = THREE.MathUtils.lerp(fromZ, _clLand.z, k);
      pos.y = THREE.MathUtils.lerp(this._topY + 0.1, this._topY + 0.02, k);
      p.setClimbStance(0.55 + 0.45 * k, dt);
    }

    p.velocity.set(0, 0, 0);

    if (this._t >= total || this._t > MAX_DURATION) {
      this._finish(true);
    }
    void elapsed;
    return true;
  }

  _finish(landed) {
    this._active = false;
    this._candidate = null;
    const p = this.player;
    if (landed) {
      // One honest resolve at the end: everything up to here trusted the probe.
      const res = this.physics.resolveCapsule(p.position, P.radius, P.height);
      p.setClimbLanding(res);
      // A gentle forward carry so the player walks off the mantle rather than
      // stopping dead on the lip.
      p.velocity.set(-Math.sin(p.yaw) * 1.4, 0, -Math.cos(p.yaw) * 1.4);
    }
    this.bus?.emit('player:climb', { climbing: false });
  }

  /** Force the climb off (world change, mount, death). */
  cancel() {
    if (!this._active) return;
    this._active = false;
    this._candidate = null;
    this.bus?.emit('player:climb', { climbing: false });
  }

  /* ================================================================ */
  /* Pose                                                              */
  /* ================================================================ */

  /**
   * Reach, pull, swing. Written from the Player's late frame callback, after
   * `PlayerAvatar` has posed the skeleton - see the note in `Swim.js`.
   *
   * @param {number} dt
   * @param {number} elapsed
   */
  applyPose(dt, elapsed) {
    const humanoid = this.player.avatar?.humanoid;
    if (!humanoid) return;

    this._poseWeight = damp(this._poseWeight, this._active ? 1 : 0, 12, dt);
    if (this._poseWeight < 0.002) {
      this._poseApplied = false;
      return;
    }
    this._poseApplied = true;

    const w = this._poseWeight;
    const total = this._upTime + this._fwdTime;
    const t = clamp(this._t / Math.max(total, 1e-3), 0, 1);
    const upT = this._upTime / Math.max(total, 1e-3);
    // 0 while reaching, 1 once the body is coming over the lip.
    const over = clamp((t - upT) / Math.max(1 - upT, 1e-3), 0, 1);
    const reach = 1 - over;

    const B = humanoid.bones;
    const set = (name, x, y, z, weight = w) => {
      const bone = B.get(name);
      if (!bone) return;
      _poseE.set(x, y, z);
      _poseQ.setFromEuler(_poseE);
      bone.quaternion.slerp(_poseQ, weight);
    };

    // Arms overhead on the reach (PI is straight up), driving down to a press
    // as the body clears the edge.
    const armX = 2.75 * reach + 0.85 * over;
    const elbow = 0.25 + reach * 0.85;
    for (const side of [1, -1]) {
      const s = side > 0 ? 'R' : 'L';
      set(`clavicle${s}`, 0, 0, -0.2 * side * reach);
      set(`upperArm${s}`, armX, 0, side * (0.18 + reach * 0.22));
      set(`foreArm${s}`, elbow, 0, side * 0.1);
      set(`hand${s}`, -0.25 * reach, 0, 0);
    }

    // Legs tuck under on the pull, then plant forward on the step-over.
    const tuck = reach * 1.15 + over * 0.25;
    for (const side of [1, -1]) {
      const s = side > 0 ? 'R' : 'L';
      const lead = side > 0 ? 1 : 0.45;
      set(`thigh${s}`, tuck * lead, 0, side * 0.08);
      set(`calf${s}`, -tuck * 1.35 * lead - 0.15, 0, 0);
      set(`foot${s}`, 0.3 * reach, 0, 0);
    }

    // Chest into the wall on the reach, upright as the player stands up.
    const lean = 0.42 * reach + 0.12 * over;
    set('spine01', lean * 0.34, 0, 0);
    set('spine02', lean * 0.34, 0, 0);
    set('spine03', lean * 0.3, 0, 0);
    set('neck', -lean * 0.45, 0, 0);
    set('head', -lean * 0.5, 0, 0);

    void elapsed;
  }
}
