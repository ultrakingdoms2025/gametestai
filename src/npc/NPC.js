import * as THREE from 'three';
import { CONFIG } from '../core/Config.js';
import { NPCAnimator } from './NPCAnimator.js';
import { Navigation } from './Navigation.js';
import {
  auditStanding, resolveSurfaceY,
  reachableRise, walkedHeight, isStranded, reseatY, capsuleSlopeLift,
} from './Grounding.js';

/**
 * Base character actor: body, brain-agnostic locomotion, health and damage.
 *
 * Subclasses implement `_think()` - the state machine - and never touch the
 * transform directly; they set a movement intent and this class integrates it
 * against the physics world so no NPC can ever end up inside geometry.
 *
 * ── Bodies that are not people ────────────────────────────────────────────
 * Everything below the state machine - the ground probe, the walked-height
 * memory, the stranding watchdog, the capsule integrator, the banked-`dt`
 * contract with `NPCManager`'s simulation bands - is about a CHARACTER, not
 * about a biped, and none of it wants to know how many legs that character has.
 * Only two things did:
 *
 *   - the BODY, which has always come in as `ctx.humanoid` and so was never a
 *     problem;
 *   - the ANIMATOR, which this constructor used to build inline as an
 *     `NPCAnimator` and which now comes from {@link NPC#_createAnimator}.
 *
 * `NPCAnimator` cannot drive a quadruped - `this.feet` is two elements long,
 * the phase relation between them is a hard-coded antiphase, and every bone is
 * looked up by biped name - so `BeastNPC` overrides that one method and gets
 * everything else here for free. That is the whole seam, and it is deliberately
 * one method wide: the alternative was a second copy of this class that would
 * have had to be kept in step with all of the above forever.
 */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

/** Probe start height above the feet. Deep enough to climb back out of a mesh. */
const GROUND_PROBE_UP = 0.95;
/** How far below the feet a floor still counts as "the floor I am walking on". */
const GROUND_PROBE_DROP = 2.6;
/** Gap that gets closed rather than fallen through. Bigger than any step. */
const GROUND_STICK = 0.34;
/**
 * How far above the resolved floor a character has to be, for long enough,
 * before the watchdog treats it as stranded rather than as falling. Well clear
 * of stairs, slopes and the normal jitter of a stale ground sample.
 */
const HOVER_LIMIT = 1.5;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrapPi = (a) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

let _nextId = 1;

export class NPC {
  /**
   * @param {{ id?:string, type:'friendly'|'hostile'|'beast', name:string, persona:string,
   *           position:THREE.Vector3, patrol?:THREE.Vector3[], theme:string,
   *           scene:THREE.Scene, physics:any, bus:any, manager:any,
   *           humanoid:any, seed?:number, radius?:number }} ctx
   */
  constructor(ctx) {
    this.id = ctx.id ?? `npc-${_nextId++}`;
    this.type = ctx.type;
    this.name = ctx.name;
    this.persona = ctx.persona ?? '';
    this.theme = ctx.theme ?? 'station';
    this.scene = ctx.scene;
    this.physics = ctx.physics;
    this.bus = ctx.bus;
    this.manager = ctx.manager;
    this.seed = ctx.seed ?? ((Math.random() * 1e9) | 0);

    this.humanoid = ctx.humanoid;
    this.root = this.humanoid.root;
    this.root.position.copy(ctx.position);
    this.spawnPoint = ctx.position.clone();
    this.sign = null;
    /** @type {THREE.Vector3[]} */
    this.patrol = (ctx.patrol ?? []).map((p) => p.clone());
    this.patrolIndex = 0;

    this.animator = this._createAnimator(ctx);
    this.nav = new Navigation({ physics: this.physics, seed: this.seed ^ 0x5f3a });

    this.height = this.humanoid.height;
    /**
     * Collision capsule radius. 0.33 m is a person; a bear is not, and its
     * shoulders end up in the walls if it is asked to be one.
     */
    this.radius = ctx.radius ?? 0.33;
    this.eyeHeight = this.height * 0.92;

    this.maxHealth = CONFIG.npc.maxHealth;
    this.health = this.maxHealth;
    this.isDead = false;
    this.deathTime = 0;
    this.sinceDamage = 999;
    this.lastDamageSource = null;

    this.velocity = new THREE.Vector3();
    this.grounded = false;
    this.yaw = ctx.yaw ?? 0;
    this.targetYaw = this.yaw;
    this.turnRate = 0;
    this.moveSpeed = 0;
    this.desiredSpeed = CONFIG.npc.walkSpeed;
    this.wantsToMove = false;
    /** Latched "I am moving fast enough to steer my facing" - see `_steer`. */
    this._facingMove = false;

    /**
     * Set by NPCManager every frame; drives animation cost.
     *
     * `shadow` starts true because that is how the meshes are built (see
     * HumanoidFactory), and the manager only writes `castShadow` when this flag
     * changes - so a false start here would leave a near character casting with
     * the flag claiming it does not.
     */
    this.lod = { distance: 0, ik: true, detail: true, rate: 1, visible: true, shadow: true, sim: 1 };
    this._animAccum = 0;
    /**
     * Fixed-step time owed to this character because its simulation is banded.
     *
     * `lod.sim` is a divisor, not an off switch: a character in the 1-in-4 band
     * is still simulated, just on every fourth step and with those four steps'
     * worth of `dt` handed to it in one go - so it walks the same distance in
     * the same wall-clock second as one at full rate. The debt lives on the
     * character rather than in the manager so a promotion across a band edge
     * always pays out exactly what that character banked, and a recycled body
     * can never inherit somebody else's.
     */
    this._simAccum = 0;
    /**
     * Which step of an 8-step cycle this character's banded simulation lands on.
     *
     * Without it every demoted character ticks on the same step and the saving
     * turns into a sawtooth: seven cheap steps and one that costs more than the
     * unbanded frame did. Derived from the seed so it is stable across a
     * respawn and deterministic for a given world.
     */
    this._simPhase = (this.seed >>> 0) & 7;

    // Ground following. `resolveCapsule` alone cannot keep a capsule on top of a
    // triangle-soup collider: the closest point on a large mesh is often *above*
    // the capsule, so the depenetration push points down and the character sinks
    // straight through the surface. A short downward probe under the feet is the
    // authority on where the floor is; the capsule solver keeps handling walls.
    this._groundY = null;
    this._groundTimer = 0;
    this._groundX = Infinity;
    this._groundZ = Infinity;
    this._airTime = 0;
    /** Y of the last ground normal `resolveCapsule` reported. @see _followGround */
    this._groundNormalY = 1;
    /**
     * The height this character actually WALKED to. @see walkedHeight
     *
     * Everything that re-seats a character reads this rather than the spawn
     * point, and that is the whole of the fix for characters ending up on the
     * station ceiling. The spawn point is a poor reference in both directions:
     * a civilian who has legitimately climbed to a tower's fourth floor still
     * reports a spawn height of 0 and would be dragged back down by any rule
     * keyed to it, while a character whose spawn was itself resolved onto a
     * ceiling member reports that ceiling and would be pinned there forever.
     *
     * This tracks the climb instead - it follows a character up a staircase,
     * a ramp, an escalator or a lift step by step, and refuses to follow a jump
     * no step could have made.
     */
    this._walkedY = ctx.position.y;

    this._lookTarget = null;
    this._headPos = new THREE.Vector3();
    this.state = 'IDLE';
    this.stateTime = 0;

    /**
     * What this character is for. Friendlies get a real role (vendor, guard,
     * loiterer, spectator, wanderer); hostiles are always 'hostile'. Other
     * systems - the Marketplace especially - key off this rather than off name
     * pattern-matching, so it is set on the base class where everyone can see it.
     */
    this.role = ctx.role ?? (ctx.type === 'hostile' ? 'hostile' : 'wanderer');
    /** Marketplace opens next to anything reporting this. */
    this.isVendor = false;
    /** Only friendlies are ever chat targets; hostiles shoot, they do not talk. */
    this.conversational = ctx.type !== 'hostile';

    /** Seat surface this character is sitting on, or null. */
    this.seat = null;
    /** Water volumes for this world; injected by NPCManager. @see setWater */
    this.water = null;
    /** Long-run grounding watchdog: seconds with no floor under the feet. */
    this._noFloorTime = 0;

    let s = this.seed >>> 0 || 3;
    this.rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };

    this.root.rotation.y = this.yaw;
    this.scene.add(this.root);
    if (Array.isArray(ctx.signLines) && ctx.signLines.length) this.setSignLines(ctx.signLines);

    // Settle onto the floor before the first frame is ever drawn.
    this._sampleGround(0, true);
    this._followGround(1);
    this._walkedY = this.position.y;
  }

  /**
   * Build the animator that poses this character's body.
   *
   * The one hook a non-humanoid character overrides. Called from the
   * constructor, so an override may only read what has already been assigned
   * above it - `humanoid`, `physics`, `seed`, `bus` - and must not touch
   * anything the subclass sets in its own constructor body.
   *
   * @param {object} ctx the constructor context, so an override can reach
   *   fields (a species, say) that the base class has no opinion about
   * @returns {any} anything presenting the animator surface `NPC` drives:
   *   setLocomotion / setLookTarget / setAimTarget / setSeated / flinch / die /
   *   revive / update, plus `sunk` and `beginSink` for the respawn queue.
   */
  _createAnimator(ctx) {
    void ctx;
    return new NPCAnimator({ humanoid: this.humanoid, physics: this.physics, seed: this.seed });
  }

  /** Live reference to the feet position. Do not mutate from outside. */
  get position() {
    return this.root.position;
  }

  /** World-space eye/head point, refreshed on demand. */
  get headPosition() {
    return this.humanoid.getHeadWorldPosition(this._headPos);
  }

  get forward() {
    return _v3.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  /**
   * Sit this character on the surface it is standing on.
   *
   * The root stays where it is - on the seat - so every gameplay query (chat
   * range, the hit capsule, the headshot sphere, the contact shadow) keeps
   * working with no special case. Only the animator changes what it does with
   * the legs.
   *
   * @param {boolean} on
   * @param {number} [seatHeight] drop from the seat surface to the floor
   */
  setSeated(on, seatHeight = 0.45) {
    if (on) {
      this.seat = { y: this.position.y, height: seatHeight };
      this.animator.setSeated(true, seatHeight);
    } else {
      this.seat = null;
      this.animator.setSeated(false);
    }
    this.seated = !!on;
  }

  setState(next) {
    if (this.state === next) return;
    this.prevState = this.state;
    this.state = next;
    this.stateTime = 0;
    this.onStateEnter?.(next);
  }

  /* ---------------------------------------------------------------- */
  /* Damage                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Apply damage. `amount` is already final - the combat system owns falloff
   * and the headshot multiplier - so this only books the number, plays the
   * reaction and flips to dead. Emitting `npc:damaged` / `npc:killed` is the
   * combat system's job, which is why nothing is emitted here.
   *
   * @returns {{applied:number, health:number, killed:boolean}}
   */
  applyDamage(amount, isHeadshot = false, source = null) {
    if (this.isDead || !(amount > 0)) {
      return { applied: 0, health: this.health, killed: false };
    }
    const applied = Math.min(amount, this.health);
    this.health -= applied;
    this.sinceDamage = 0;
    this.lastDamageSource = source;

    const from = source?.position ?? source;
    if (from && from.isVector3) _v1.subVectors(this.position, from).normalize();
    else _v1.copy(this.forward).negate();

    const killed = this.health <= 0.0001;
    if (killed) {
      this.die(source, isHeadshot, _v1);
    } else {
      this.animator.flinch(_v1, isHeadshot || applied >= 30);
      this.onDamaged?.(applied, isHeadshot, source);
    }
    return { applied, health: this.health, killed };
  }

  heal(amount) {
    if (this.isDead) return;
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  /**
   * Kill immediately. Safe to call from the combat system; idempotent.
   * @param {*} source
   * @param {boolean} isHeadshot
   * @param {THREE.Vector3} [impactDir] direction the force travelled
   */
  die(source = null, isHeadshot = false, impactDir = null) {
    if (this.isDead) return;
    this.isDead = true;
    this.health = 0;
    this.deathTime = 0;
    this.velocity.set(0, 0, 0);
    this.nav.clear();
    this.animator.setAimTarget(null);
    this.animator.setLookTarget(null);
    this.animator.die(impactDir ?? this.forward.clone().negate(), isHeadshot);
    this.setState('DEAD');
    this.onDied?.(source, isHeadshot);
  }

  /** Put a recycled NPC back into play at `position`. */
  respawn(position) {
    this.root.position.copy(position);
    this.root.visible = true;
    this.health = this.maxHealth;
    this.isDead = false;
    this.deathTime = 0;
    this.velocity.set(0, 0, 0);
    this.animator.revive();
    this.nav.clear();
    this._airTime = 0;
    this._sampleGround(0, true);
    this._followGround(1);
    // A respawn is an authoritative placement: wherever it put this character
    // is, by definition, where it now belongs.
    this._walkedY = this.position.y;
    this.setState('IDLE');
    this.onRespawned?.();
  }

  /* ---------------------------------------------------------------- */
  /* Simulation                                                        */
  /* ---------------------------------------------------------------- */

  fixedUpdate(dt, elapsed) {
    this.stateTime += dt;
    this.sinceDamage += dt;
    if (this.isDead) {
      this.deathTime += dt;
      this._integrateDead(dt);
      return;
    }
    this._think(dt, elapsed);
    this._steer(dt);
    this._integrate(dt);
  }

  /** Subclasses override. */
  _think(_dt, _elapsed) {}

  _steer(dt) {
    const nav = this.nav;
    const neighbours = this.manager?.npcs;
    const desired = nav.update(dt, this.position, this.desiredSpeed, this.forward, neighbours);
    this.wantsToMove = desired.lengthSq() > 0.02;

    // Accelerate toward the steering output rather than snapping to it, so
    // direction changes have weight.
    const accel = this.grounded ? 14 : 4;
    _v1.set(desired.x - this.velocity.x, 0, desired.z - this.velocity.z);
    const mag = _v1.length();
    if (mag > 1e-5) {
      const step = Math.min(mag, accel * dt);
      this.velocity.x += (_v1.x / mag) * step;
      this.velocity.z += (_v1.z / mag) * step;
    }
    if (!this.wantsToMove) {
      const damp = Math.exp(-11 * dt);
      this.velocity.x *= damp;
      this.velocity.z *= damp;
    }

    // Facing: follow the movement direction unless something has overridden it.
    //
    // The speed gate is hysteretic. A single threshold sat right on top of the
    // speed a character squeezing past an obstacle actually travels at, so the
    // facing target switched on and off from step to step and the body twitched
    // between "turn to face where I am going" and "hold the last bearing".
    // Start turning at 0.3 m/s, keep turning down to 0.18 m/s.
    if (this.faceOverride) {
      _v2.subVectors(this.faceOverride, this.position);
      if (_v2.lengthSq() > 1e-4) this.targetYaw = Math.atan2(-_v2.x, -_v2.z);
      this._facingMove = false;
    } else {
      const planar = this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z;
      this._facingMove = this._facingMove ? planar > 0.032 : planar > 0.09;
      if (this._facingMove) this.targetYaw = Math.atan2(-this.velocity.x, -this.velocity.z);
    }
    const delta = wrapPi(this.targetYaw - this.yaw);
    const maxTurn = (this.wantsToMove ? 5.5 : 3.4) * dt;
    const applied = clamp(delta, -maxTurn, maxTurn);
    this.yaw += applied;
    this.turnRate = applied / Math.max(dt, 1e-4);
    this.root.rotation.y = this.yaw;
  }

  /**
   * Refresh the cached floor height under the feet.
   *
   * Throttled by both time and travelled distance: a character standing still
   * costs one ray every third of a second, and even a sprinting one costs well
   * under the fixed-step rate. Probing from hip height means a character that
   * has sunk into a mesh still finds the surface it should be standing on.
   *
   * ── On a SLOPE the throttle is tighter, and it has to be ────────────────
   * The staleness a throttle buys is a height error, and on flat ground the
   * height does not change between samples so the error is zero. On a 30 degree
   * flight, 0.12 m of travel is 0.07 m of height: the character is that far
   * INTO the ramp by the time the sample refreshes, `resolveCapsule` evicts it
   * along the normal, and the horizontal half of that eviction is downhill. It
   * is the same treadmill `capsuleSlopeLift` exists to stop, arriving through
   * the sampler instead. Measured, a character climbing the station's walkway
   * flight makes 0.67 m/s against a 1.4 m/s walk on the 0.12 m throttle.
   *
   * Only characters actually standing on something pitched pay for it, which
   * anywhere in these worlds is a handful at a time.
   *
   * @param {number} dt
   * @param {boolean} [force] ignore the throttle (spawn, respawn, teleport)
   */
  _sampleGround(dt, force = false) {
    this._groundTimer -= dt;
    const moved =
      Math.abs(this.position.x - this._groundX) + Math.abs(this.position.z - this._groundZ);
    const onSlope = this._groundNormalY < 0.995;
    if (!force && this._groundTimer > 0 && moved < (onSlope ? 0.03 : 0.12)) return;
    // Distant characters do not need per-step accuracy; nobody can see the
    // difference at 45 m and the ray cost scales with the crowd.
    this._groundTimer = this.lod.distance > 45 ? 0.3 : (onSlope ? 0.02 : 0.08);
    this._groundX = this.position.x;
    this._groundZ = this.position.z;
    const up = GROUND_PROBE_UP;
    this._groundY = this.physics.groundHeight(
      this.position.x,
      this.position.z,
      this.position.y + up,
      up + GROUND_PROBE_DROP
    );
  }

  /**
   * Keep the feet on the surface. Never allow a character below the floor, and
   * pull one that is hovering a few centimetres above it back down so triangle
   * meshes read as solid ground rather than as a trampoline.
   */
  _followGround(dt) {
    /* Where the FEET go, which on a slope is not the ground height.
     *
     * A capsule seated with its feet exactly on a pitched surface has its
     * bottom sphere buried in that surface, `resolveCapsule` evicts it along
     * the normal, and the horizontal half of that eviction points downhill -
     * every step, forever, because this method puts the feet straight back.
     * Measured on the station's walkway flight that was 1.39 m/s of downhill
     * drift against a 1.4 m/s walk, which is why no character in this game had
     * ever climbed a ramp. @see capsuleSlopeLift - it returns exactly zero on
     * flat ground, so nothing standing on a floor is affected. */
    const g = this._groundY;
    this.groundY = g;
    if (g === null) return false;
    const seat = g + capsuleSlopeLift(this.radius, this._groundNormalY);
    const dy = this.position.y - seat;
    if (dy < -0.004) {
      // Below the surface: this is never acceptable, correct it outright.
      this.position.y = seat;
      if (this.velocity.y < 0) this.velocity.y = 0;
      this.grounded = true;
      return true;
    }
    if (dy < GROUND_STICK && this.velocity.y <= 0.05) {
      // Settle onto the surface instead of snapping, so a stale sample taken a
      // few centimetres back along a slope does not read as a bounce.
      this.position.y += (seat - this.position.y) * Math.min(1, 22 * dt);
      if (this.position.y - seat < 0.01) this.position.y = seat;
      this.velocity.y = 0;
      this.grounded = true;
      return true;
    }
    return false;
  }

  _integrate(dt) {
    // A seated character is furniture-bound: it does not steer, so it does not
    // need the capsule solver, and it must not have it. A bench is a narrow
    // collider and the nearest point on it from a capsule sitting on top is
    // often a side face, so depenetration would quietly shove sitters off their
    // own seats. Pinning the transform is both cheaper and correct.
    if (this.seat) {
      this._integrateSeated(dt);
      return;
    }
    this.velocity.y += CONFIG.player.gravity * dt;
    if (this.velocity.y < -40) this.velocity.y = -40;
    this.position.addScaledVector(this.velocity, dt);

    const res = this.physics.resolveCapsule(this.position, this.radius, this.height * 0.92);
    this.grounded = res.grounded;
    /* The pitch of whatever is underfoot, remembered for `_followGround`.
     *
     * The solver only reports a normal on the steps where it actually PUSHES,
     * and once `_followGround` has seated the capsule tangent to a slope there
     * is nothing left to push - so the reading arrives every other step or so
     * on a ramp and not at all on a floor. Holding the last one outright would
     * hover a character 5 cm above the deck it stepped out onto; taking the
     * absence as flat would make the seat flicker and halve the climb. So it
     * decays back to flat over about an eighth of a second, which is short
     * enough to be invisible on a floor and long enough to bridge the gaps on
     * a flight. */
    if (res.grounded) this._groundNormalY = res.groundNormal.y;
    else this._groundNormalY += (1 - this._groundNormalY) * Math.min(1, 8 * dt);
    if (res.grounded && this.velocity.y < 0) this.velocity.y = 0;

    this._sampleGround(dt);
    this._followGround(dt);

    // A character with no floor under it for a couple of seconds has been
    // authored over a hole. Rather than fall forever, find the nearest real
    // surface and stand on it.
    //
    // The surface has to be chosen relative to where the character *is*, not
    // top-down. `groundHeightOrFallback` returns the topmost surface in the
    // column, which under a station gantry or a keep roof is the roof - so the
    // old recovery path could take a civilian who stepped off a kerb and stand
    // them on a rooftop 24 m up, which is precisely the "NPC in the wrong
    // place" the player was seeing.
    if (this.grounded) {
      this._airTime = 0;
      this._noFloorTime = 0;
    } else {
      this._airTime += dt;
      if (this._groundY === null) this._noFloorTime += dt;
      else this._noFloorTime = 0;
      if (this._airTime > 1.5) {
        const y = resolveSurfaceY(this.physics, this.position.x, this.position.z, this.position.y);
        /* Clamped for the same reason the watchdog's placements are: a recovery
         * may put a character back on the ground, and may not promote it to a
         * height it never climbed to. `y` is resolved against where the
         * character IS - see the note above, that part is deliberate - and the
         * clamp is applied to the placement, not to the search. */
        const seat = reseatY(this._walkedY, this.position.y, y) ?? (y === null ? this.spawnPoint.y : null);
        if (seat !== null) {
          this.position.y = seat;
          this.velocity.set(0, 0, 0);
          this._airTime = 0;
          this._sampleGround(dt, true);
        }
      }
    }

    // Anything that falls out of the world goes back to its spawn instead of
    // dropping forever.
    if (this.position.y < -60) {
      this.position.copy(this.spawnPoint);
      this.velocity.set(0, 0, 0);
      this._sampleGround(dt, true);
      this._walkedY = this.position.y;
    }
    this._noteWalked(dt);
    this.moveSpeed = Math.hypot(this.velocity.x, this.velocity.z);
  }

  /**
   * Book this step's height against what walking could have achieved.
   *
   * Only ever called for a grounded character: a height reached in mid-air is
   * not a height anybody stood at, and following it would let a character bank
   * the top of an arc it was only passing through.
   *
   * @param {number} dt the step just integrated
   */
  _noteWalked(dt) {
    if (!this.grounded) return;
    this._walkedY = walkedHeight(this._walkedY, this.position.y, reachableRise(dt, GROUND_PROBE_UP));
  }

  /** Hold a seated character on its seat. */
  _integrateSeated(dt) {
    this.velocity.set(0, 0, 0);
    this.moveSpeed = 0;
    this.grounded = true;
    this._airTime = 0;
    this.groundY = this.seat.y;
    // Re-sample occasionally so a seat that turns out not to be there (world
    // rebuilt under us) still resolves through the watchdog.
    this._sampleGround(dt);
    if (Math.abs(this.position.y - this.seat.y) > 0.002) {
      this.position.y += (this.seat.y - this.position.y) * Math.min(1, 12 * dt);
    }
    this._noteWalked(dt);
  }

  _integrateDead(dt) {
    this.velocity.y += CONFIG.player.gravity * dt;
    this.velocity.x *= Math.exp(-6 * dt);
    this.velocity.z *= Math.exp(-6 * dt);
    this.position.addScaledVector(this.velocity, dt);
    const res = this.physics.resolveCapsule(this.position, this.radius, this.height * 0.5);
    if (res.grounded && this.velocity.y < 0) this.velocity.y = 0;
    this.grounded = res.grounded;
    // A corpse on a ramp is the same capsule on the same slope. @see _followGround
    if (res.grounded) this._groundNormalY = res.groundNormal.y;
    else this._groundNormalY += (1 - this._groundNormalY) * Math.min(1, 8 * dt);
    this._sampleGround(dt);
    // Corpses sink through mesh terrain just as easily as the living do.
    this._followGround(dt);
    this.moveSpeed = 0;
  }

  /**
   * Grounding watchdog, called by the manager on a slow round-robin.
   *
   * Steering, depenetration and the ground probe between them are enough
   * 99.9% of the time; this is the backstop for the remaining case, where a
   * character has ended up inside, under, or on top of geometry that its own
   * short probe cannot see out of. It re-resolves the surface stack at the
   * character's column and moves it onto the walkable surface nearest the
   * height it last walked to - never more than `STRAND_LIMIT` above that.
   *
   * @returns {boolean} true if the character had to be corrected
   */
  /**
   * Adopt the active world's water volumes. Steering reads them through
   * `nav.water`; the manager's watchdog reads them directly.
   * @param {any} water
   */
  setWater(water) {
    this.water = water || null;
    if (this.nav) this.nav.water = this.water;
  }

  auditGrounding(force = false) {
    if (this.isDead) return false;
    /* The hint is what this character WALKED to, not where it was spawned.
     *
     * ── The defect this fixes ────────────────────────────────────────────────
     * Every "NPC on the station ceiling" arrived here, in one fixed step, from
     * the deck. `resolveSurfaceY` walked the column from the top of the world
     * and ran out of stack budget in the hub's ceiling raft - nine to twelve
     * members deep - before it ever reached the deck, so the nearest walkable
     * surface to a hint of 0 was a ceiling member at 55 or 62 m, and the line
     * below faithfully teleported the character onto it. Measured from a live
     * run: Marta Vale 0 -> 62.00 in one step, Rogue Security Unit 0 -> 54.97,
     * Hask Merrow 0.22 -> 10.45, all with the capsule solver contributing
     * exactly zero (its largest single vertical push over 75 s across 68
     * characters was 0.64 m).
     *
     * `Grounding.js` now anchors that search near the hint, which is the actual
     * repair. The hint change and the clamp below are what stop a resolver that
     * is wrong again from ever being able to express it as a 62 m teleport. */
    const hint = this.seat ? this.seat.y : this._walkedY;
    const audit = auditStanding(this.physics, this.position, hint);
    /* Standing somewhere no step could have reached is a fault in its own
     * right, and one the checks below cannot see: such a character IS grounded
     * and IS flush with the surface it is standing on, so it reads as perfectly
     * healthy and would live on the ceiling forever. */
    const stranded = isStranded(this._walkedY, this.position.y);
    // Falling is not a fault; leave anything that is mid-air to the integrator.
    // The spawn sweep passes `force` because a character has not been
    // integrated yet at that point and would otherwise look airborne.
    if (!stranded && (audit.ok || (!force && !this.grounded && this._airTime < 1.2))) return false;
    if (audit.surfaceY === null) {
      // No floor anywhere in this column at all: back to the spawn point.
      this.position.copy(this.spawnPoint);
      this.velocity.set(0, 0, 0);
      this._sampleGround(0, true);
      this._followGround(1);
      this._walkedY = this.position.y;
      return true;
    }
    /* Where a correction is allowed to put this character.
     *
     * The spawn sweep is exempt: `force` means an authored spawn is being
     * resolved onto real geometry for the first time, the author's height is
     * the only intent there is, and `_walkedY` is still just a copy of it. Once
     * the character is alive and walking, `_walkedY` is evidence and the clamp
     * applies. */
    const target = force
      ? audit.surfaceY
      : reseatY(this._walkedY, this.position.y, audit.surfaceY);
    if (target === null) return false;
    if (stranded) {
      this.position.y = target;
      this.velocity.set(0, 0, 0);
      this._noFloorTime = 0;
      this._airTime = 0;
      this._sampleGround(0, true);
      this._followGround(1);
      this._walkedY = this.position.y;
      if (this.seat) this.seat.y = this.position.y;
      return true;
    }
    /* Hovering, not just sinking.
     *
     * This used to return here for any negative drop, so the watchdog could
     * only ever pull a character *up* out of geometry and never *down* out of
     * the air - it relied entirely on gravity, which does nothing for anyone
     * whose `grounded` flag is stale or who is standing on a mesh with no
     * collider. Measured in the medieval world: one civilian 13 m over the
     * terrain that the watchdog had no way to see as wrong.
     *
     * The threshold is deliberately far outside the asymmetric tolerance in
     * `auditStanding` - a metre and a half is unambiguous, where half a metre
     * would fight the integrator on stairs and slopes. */
    if (audit.drop < -HOVER_LIMIT && (force || this._airTime > 1.2)) {
      this.position.y = target;
      this.velocity.set(0, 0, 0);
      this._noFloorTime = 0;
      this._airTime = 0;
      this._sampleGround(0, true);
      this._followGround(1);
      this._walkedY = this.position.y;
      if (this.seat) this.seat.y = this.position.y;
      return true;
    }
    // Only correct a genuine sink. Standing slightly proud of a stale sample is
    // normal and correcting it every pass would make characters twitch.
    if (audit.drop < 0.35) return false;
    this.position.y = target;
    this.velocity.y = 0;
    this._noFloorTime = 0;
    this._airTime = 0;
    this._sampleGround(0, true);
    this._followGround(1);
    this._walkedY = this.position.y;
    if (this.seat) this.seat.y = this.position.y;
    return true;
  }

  /** Frame-rate animation update. `lod` is filled in by the manager. */
  update(dt, elapsed) {
    const lod = this.lod;
    // One accumulate per call. The off-screen branch used to add `dt` and then
    // fall through to a second `+= dt`, so a hidden character banked time at
    // twice the rate and posed against a `useDt` that had never elapsed.
    this._animAccum += dt;
    if (!lod.visible && !this.isDead && this._animAccum < 0.2) {
      // Off-screen and distant: keep the state machine running, skip the pose.
      return;
    }
    const step = 1 / (60 * lod.rate);
    if (lod.rate < 1 && this._animAccum < step) return;
    const useDt = Math.min(this._animAccum, 0.25);
    this._animAccum = 0;

    this.animator.setLocomotion(this.moveSpeed, this.turnRate);
    this.animator.setLookTarget(this._lookTarget);
    this.animator.update(useDt, elapsed, lod);
    this.humanoid.setDetailVisible(lod.detail);
  }

  _attachSign(lines) {
    this.signLines = Array.isArray(lines) ? lines.slice(0, 2) : null;
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 160;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(8, 12, 18, 0.72)';
    ctx.fillRect(18, 18, 476, 124);
    ctx.strokeStyle = 'rgba(112, 211, 255, 0.9)';
    ctx.lineWidth = 6;
    ctx.strokeRect(18, 18, 476, 124);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.fillRect(30, 30, 452, 10);
    ctx.fillStyle = '#eaf8ff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 48px sans-serif';
    ctx.fillText(String(lines[0] ?? ''), 256, lines.length > 1 ? 62 : 80);
    if (lines.length > 1) {
      ctx.font = '500 24px sans-serif';
      ctx.fillStyle = 'rgba(234, 248, 255, 0.82)';
      ctx.fillText(String(lines[1] ?? ''), 256, 108);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.position.set(0, this.height + 0.95, 0);
    sprite.scale.set(2.6, 0.82, 1);
    sprite.renderOrder = 20;
    this.root.add(sprite);
    this.sign = sprite;
  }

  setSignLines(lines) {
    if (this.sign) {
      this.sign.material?.map?.dispose?.();
      this.sign.material?.dispose?.();
      this.sign.removeFromParent();
      this.sign = null;
    }
    if (Array.isArray(lines) && lines.length) this._attachSign(lines);
  }

  dispose() {
    if (this.sign) {
      this.sign.material?.map?.dispose?.();
      this.sign.material?.dispose?.();
      this.sign.removeFromParent();
      this.sign = null;
    }
    this.humanoid.dispose();
  }
}

export { clamp, wrapPi };
