import * as THREE from 'three';
import { CONFIG } from '../core/Config.js';
import { NPCAnimator } from './NPCAnimator.js';
import { Navigation } from './Navigation.js';

/**
 * Base character actor: body, brain-agnostic locomotion, health and damage.
 *
 * Subclasses implement `_think()` - the state machine - and never touch the
 * transform directly; they set a movement intent and this class integrates it
 * against the physics world so no NPC can ever end up inside geometry.
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

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrapPi = (a) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

let _nextId = 1;

export class NPC {
  /**
   * @param {{ id?:string, type:'friendly'|'hostile', name:string, persona:string,
   *           position:THREE.Vector3, patrol?:THREE.Vector3[], theme:string,
   *           scene:THREE.Scene, physics:any, bus:any, manager:any,
   *           humanoid:any, seed?:number }} ctx
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
    /** @type {THREE.Vector3[]} */
    this.patrol = (ctx.patrol ?? []).map((p) => p.clone());
    this.patrolIndex = 0;

    this.animator = new NPCAnimator({ humanoid: this.humanoid, physics: this.physics, seed: this.seed });
    this.nav = new Navigation({ physics: this.physics, seed: this.seed ^ 0x5f3a });

    this.height = this.humanoid.height;
    this.radius = 0.33;
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

    /** Set by NPCManager every frame; drives animation cost. */
    this.lod = { distance: 0, ik: true, detail: true, rate: 1, visible: true };
    this._animAccum = 0;

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

    this._lookTarget = null;
    this._headPos = new THREE.Vector3();
    this.state = 'IDLE';
    this.stateTime = 0;

    let s = this.seed >>> 0 || 3;
    this.rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };

    this.root.rotation.y = this.yaw;
    this.scene.add(this.root);

    // Settle onto the floor before the first frame is ever drawn.
    this._sampleGround(0, true);
    this._followGround(1);
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
    if (this.faceOverride) {
      _v2.subVectors(this.faceOverride, this.position);
      if (_v2.lengthSq() > 1e-4) this.targetYaw = Math.atan2(-_v2.x, -_v2.z);
    } else if (this.velocity.lengthSq() > 0.09) {
      this.targetYaw = Math.atan2(-this.velocity.x, -this.velocity.z);
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
   * @param {number} dt
   * @param {boolean} [force] ignore the throttle (spawn, respawn, teleport)
   */
  _sampleGround(dt, force = false) {
    this._groundTimer -= dt;
    const moved =
      Math.abs(this.position.x - this._groundX) + Math.abs(this.position.z - this._groundZ);
    if (!force && this._groundTimer > 0 && moved < 0.12) return;
    // Distant characters do not need per-step accuracy; nobody can see the
    // difference at 45 m and the ray cost scales with the crowd.
    this._groundTimer = this.lod.distance > 45 ? 0.3 : 0.08;
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
    const g = this._groundY;
    this.groundY = g;
    if (g === null) return false;
    const dy = this.position.y - g;
    if (dy < -0.004) {
      // Below the surface: this is never acceptable, correct it outright.
      this.position.y = g;
      if (this.velocity.y < 0) this.velocity.y = 0;
      this.grounded = true;
      return true;
    }
    if (dy < GROUND_STICK && this.velocity.y <= 0.05) {
      // Settle onto the surface instead of snapping, so a stale sample taken a
      // few centimetres back along a slope does not read as a bounce.
      this.position.y += (g - this.position.y) * Math.min(1, 22 * dt);
      if (this.position.y - g < 0.01) this.position.y = g;
      this.velocity.y = 0;
      this.grounded = true;
      return true;
    }
    return false;
  }

  _integrate(dt) {
    this.velocity.y += CONFIG.player.gravity * dt;
    if (this.velocity.y < -40) this.velocity.y = -40;
    this.position.addScaledVector(this.velocity, dt);

    const res = this.physics.resolveCapsule(this.position, this.radius, this.height * 0.92);
    this.grounded = res.grounded;
    if (res.grounded && this.velocity.y < 0) this.velocity.y = 0;

    this._sampleGround(dt);
    this._followGround(dt);

    // A character with no floor under it for a couple of seconds has been
    // authored over a hole. Rather than fall forever, find the nearest real
    // surface and stand on it.
    if (this.grounded) {
      this._airTime = 0;
    } else {
      this._airTime += dt;
      if (this._airTime > 1.5) {
        const y = this.physics.groundHeightOrFallback(
          this.position.x,
          this.position.z,
          this.spawnPoint.y
        );
        this.position.y = y;
        this.velocity.set(0, 0, 0);
        this._airTime = 0;
        this._sampleGround(dt, true);
      }
    }

    // Anything that falls out of the world goes back to its spawn instead of
    // dropping forever.
    if (this.position.y < -60) {
      this.position.copy(this.spawnPoint);
      this.velocity.set(0, 0, 0);
      this._sampleGround(dt, true);
    }
    this.moveSpeed = Math.hypot(this.velocity.x, this.velocity.z);
  }

  _integrateDead(dt) {
    this.velocity.y += CONFIG.player.gravity * dt;
    this.velocity.x *= Math.exp(-6 * dt);
    this.velocity.z *= Math.exp(-6 * dt);
    this.position.addScaledVector(this.velocity, dt);
    const res = this.physics.resolveCapsule(this.position, this.radius, this.height * 0.5);
    if (res.grounded && this.velocity.y < 0) this.velocity.y = 0;
    this.grounded = res.grounded;
    this._sampleGround(dt);
    // Corpses sink through mesh terrain just as easily as the living do.
    this._followGround(dt);
    this.moveSpeed = 0;
  }

  /** Frame-rate animation update. `lod` is filled in by the manager. */
  update(dt, elapsed) {
    const lod = this.lod;
    if (!lod.visible && !this.isDead) {
      // Off-screen and distant: keep the state machine running, skip the pose.
      this._animAccum += dt;
      if (this._animAccum < 0.2) return;
    }
    this._animAccum += dt;
    const step = 1 / (60 * lod.rate);
    if (lod.rate < 1 && this._animAccum < step) return;
    const useDt = Math.min(this._animAccum, 0.25);
    this._animAccum = 0;

    this.animator.setLocomotion(this.moveSpeed, this.turnRate);
    this.animator.setLookTarget(this._lookTarget);
    this.animator.update(useDt, elapsed, lod);
    this.humanoid.setDetailVisible(lod.detail);
  }

  dispose() {
    this.humanoid.dispose();
  }
}

export { clamp, wrapPi };
