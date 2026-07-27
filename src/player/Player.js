import * as THREE from 'three';
import { CONFIG } from '../core/Config.js';
import { COLLISION_LAYER } from '../physics/Physics.js';
import { Weapon } from './Weapon.js';

/**
 * First-person player controller.
 *
 * Movement is acceleration-based in the Source lineage: friction is applied
 * first, then a projected acceleration toward the wish direction. That model is
 * what makes a shooter feel crisp - you reach top speed in a few frames, stop
 * dead when you release the keys, and keep useful air control without the
 * floatiness of a velocity lerp.
 *
 * Simulation runs on the engine's fixed 60 Hz step (`fixedUpdate`); everything
 * that must not be quantised to that rate - mouse look, camera composition,
 * viewmodel animation - runs per rendered frame (`update`).
 *
 * `position` is the FEET. Collision is delegated entirely to
 * `physics.resolveCapsule`; this class only decides where it *wants* to be.
 */

/* Module-scope scratch. Nothing in the per-frame path allocates. */
const _v1 = new THREE.Vector3();
const _prev = new THREE.Vector3();
const _step = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
const _up = new THREE.Vector3(0, 1, 0);

const P = CONFIG.player;
const damp = THREE.MathUtils.damp;
const clamp = THREE.MathUtils.clamp;

const STAND_HEIGHT = P.height;
const CROUCH_HEIGHT = P.height * 0.58;
const STAND_EYE = P.eyeHeight;
const CROUCH_EYE = P.eyeHeight * 0.55;

const MAX_PITCH = 89 * (Math.PI / 180);
/** Below this speed friction is applied at a constant rate, which is what kills the slide. */
const STOP_SPEED = 1.1;
const COYOTE_TIME = 0.12;
const JUMP_BUFFER = 0.12;
/** Metres of travel per complete two-step bob cycle. */
const STRIDE = 1.55;
const RESPAWN_DELAY = 3.2;
const SPAWN_INVULN = 2.5;

export class Player {
  /**
   * @param {{ scene: THREE.Scene, engine: import('../core/Engine.js').Engine,
   *           physics: import('../physics/Physics.js').Physics,
   *           bus: import('../core/EventBus.js').EventBus, materials: any,
   *           input: import('../core/Input.js').Input,
   *           camera: THREE.PerspectiveCamera }} ctx
   */
  constructor({ scene, engine, physics, bus, materials, input, camera }) {
    this.scene = scene;
    this.engine = engine;
    this.physics = physics;
    this.bus = bus;
    this.materials = materials;
    this.input = input;
    this.camera = camera;

    /* ---- kinematics ---- */
    this._position = new THREE.Vector3(0, 2, 0);
    this._velocity = new THREE.Vector3();
    this._yaw = 0;
    this._pitch = 0;
    this._grounded = false;
    this._wasGrounded = false;
    this._groundNormal = new THREE.Vector3(0, 1, 0);
    this._coyote = 0;
    this._jumpBuffer = 0;
    this._jumpHeld = false;
    this._capsuleHeight = STAND_HEIGHT;
    this._eyeHeight = STAND_EYE;
    this._crouching = false;
    this._sprinting = false;

    /* ---- view feel ---- */
    this._stepSmooth = 0;
    this._bobDist = 0;
    this._bobPhase = 0;
    this._bobWeight = 0;
    this._footAccum = 0;
    this._footIndex = 0;
    this._dip = 0;
    this._dipVel = 0;
    this._roll = 0;
    this._fov = CONFIG.render.fov;
    this._lastLookX = 0;
    this._lastLookY = 0;

    /* ---- health ---- */
    this._maxHealth = P.maxHealth;
    this._health = P.maxHealth;
    this._dead = false;
    this._lastDamageAt = -999;
    this._invulnUntil = 0;
    this._deathAt = 0;
    this._regenCarry = 0;
    this._elapsed = 0;

    /* ---- spawn anchor ---- */
    this._spawnPosition = this._position.clone();
    this._spawnYaw = 0;

    /** Set by the screenshot harness to hand camera control over. */
    this._harnessFrozen = false;
    this._frozenApplied = false;

    /* ---- external drivers ---- */
    /**
     * Set true by `MountManager` while a mount owns the player's movement.
     * Contract: CONTRACTS-V2.md 3.3. While it is set this class integrates
     * nothing - the mount writes `position` (and optionally `yaw`) directly -
     * but the capsule is still resolved so you cannot ride through a wall.
     * @type {boolean}
     */
    this.movementOverride = false;
    /** Let a mount opt out of the capsule resolve (free flight well clear of geometry). */
    this.movementOverrideCollide = true;
    /** Let a mount own yaw/pitch entirely instead of taking mouse-look from here. */
    this.movementOverrideLook = true;

    /** @type {import('./CameraRig.js').CameraRig|null} set by CameraRig's constructor. */
    this.cameraRig = null;

    /**
     * Set by main.js once the weapon Loadout exists. Its presence transfers
     * ownership of the viewmodel and fire input away from `_driveWeapon`.
     */
    this.loadout = null;
    /** @type {import('./PlayerAvatar.js').PlayerAvatar|null} set by PlayerAvatar's constructor. */
    this.avatar = null;

    /** Engine time of the last shot. The avatar uses it to hold an aim pose. */
    this._lastFiredAt = -999;

    // Combat resolves hits, but the player owns the health model and the weapon.
    this._weapon = new Weapon({ scene, camera, bus, materials, engine, input });

    // Third-person parallax correction.
    //
    // ORDERING IS LOAD-BEARING: this subscription must be registered before
    // CombatSystem's so that Combat resolves the corrected origin/direction.
    // `main.js` constructs the Player before the CombatSystem and EventBus
    // dispatches in subscription order, which is what makes that true. The
    // payload is rewritten in place rather than re-emitted because a second
    // `weapon:fired` would double the tracer, the HUD kick and the NPC alert.
    // Anything that would rather resolve the shot itself can call
    // `player.resolveShot(origin, direction)` and skip this path entirely.
    this._offFired = bus.on('weapon:fired', (evt) => {
      this._lastFiredAt = this._elapsed;
      this.cameraRig?.correctShotEvent(evt);
    });

    this.camera.rotation.order = 'YXZ';
    this._applyCamera(0);
  }

  /* ================================================================ */
  /* Accessors (contract)                                              */
  /* ================================================================ */

  /** Live reference to the feet position. Do not retain a copy. */
  get position() {
    return this._position;
  }

  get yaw() {
    return this._yaw;
  }

  get pitch() {
    return this._pitch;
  }

  get health() {
    return this._health;
  }

  get maxHealth() {
    return this._maxHealth;
  }

  get isDead() {
    return this._dead;
  }

  get weapon() {
    return this._weapon;
  }

  get velocity() {
    return this._velocity;
  }

  get grounded() {
    return this._grounded;
  }

  get isCrouching() {
    return this._crouching;
  }

  get isSprinting() {
    return this._sprinting;
  }

  /** True while respawn invulnerability is active. */
  get isInvulnerable() {
    return this._elapsed < this._invulnUntil;
  }

  /** Eye position in world space. A fresh vector each call, per the contract. */
  get eyePosition() {
    return new THREE.Vector3(
      this._position.x,
      this._position.y + this._eyeHeight,
      this._position.z
    );
  }

  /** Look direction including pitch. Fresh vector each call. */
  get forward() {
    const cp = Math.cos(this._pitch);
    return new THREE.Vector3(
      -Math.sin(this._yaw) * cp,
      Math.sin(this._pitch),
      -Math.cos(this._yaw) * cp
    );
  }

  /* ---- view state, read by CameraRig and PlayerAvatar ------------- */

  /** Current (smoothed) eye height above the feet, in metres. */
  get eyeHeight() {
    return this._eyeHeight;
  }

  /** Current (smoothed) capsule height. Shrinks on crouch. */
  get capsuleHeight() {
    return this._capsuleHeight;
  }

  /** Residual stair-step absorption the camera is still paying off. */
  get stepSmoothing() {
    return this._stepSmooth;
  }

  /** Landing-dip spring offset, negative while absorbing an impact. */
  get viewDip() {
    return this._dip;
  }

  /** Strafe roll in radians. */
  get viewRoll() {
    return this._roll;
  }

  get bobPhase() {
    return this._bobPhase;
  }

  get bobWeight() {
    return this._bobWeight;
  }

  /** Stance blend, 0 standing to 1 fully crouched. Follows the capsule, so it is smooth. */
  get crouchAmount() {
    return clamp((STAND_HEIGHT - this._capsuleHeight) / (STAND_HEIGHT - CROUCH_HEIGHT), 0, 1);
  }

  /** True while the aim (RMB) input is held and usable. */
  get isAiming() {
    return !this._dead && !this.input.textCaptured && !!this.input.state.aim;
  }

  /** ADS blend, 0..1, sourced from the weapon so FOV and boom agree. */
  get aimProgress() {
    return this._weapon?.aimProgress ?? 0;
  }

  /** Engine time of the last shot fired. */
  get lastFiredAt() {
    return this._lastFiredAt;
  }

  get isThirdPerson() {
    return this.cameraRig?.isThird ?? false;
  }

  /** World point the crosshair is over, or null before the rig exists. */
  get aimPoint() {
    return this.cameraRig?.aimPoint ?? null;
  }

  /** Yaw setter for mounts, which own orientation while `movementOverride` is set. */
  setYaw(y) {
    this._yaw = y;
  }

  setPitch(p) {
    this._pitch = clamp(p, -MAX_PITCH, MAX_PITCH);
  }

  /**
   * Where the player's next shot starts and which way it travels.
   *
   * First person is the camera line, unchanged. Third person is the avatar's
   * muzzle aimed at whatever the crosshair is over. Weapons that emit their own
   * `weapon:fired` should call this rather than reading the camera directly.
   *
   * @param {THREE.Vector3} outOrigin
   * @param {THREE.Vector3} outDirection
   * @returns {boolean} true if the shot was corrected for third-person parallax
   */
  resolveShot(outOrigin, outDirection) {
    if (this.cameraRig) return this.cameraRig.resolveShot(outOrigin, outDirection);
    this.camera.getWorldPosition(outOrigin);
    this.camera.getWorldDirection(outDirection);
    return false;
  }

  /* ================================================================ */
  /* Fixed-rate simulation                                             */
  /* ================================================================ */

  /**
   * Deterministic movement step. Runs at 60 Hz regardless of frame rate.
   * @param {number} dt fixed timestep in seconds
   * @param {number} elapsed engine time in seconds
   */
  fixedUpdate(dt, elapsed) {
    this._elapsed = elapsed;
    this._tickHealth(dt, elapsed);

    if (this._dead) {
      // Corpses still fall, so the camera settles on the floor rather than
      // hanging in mid-air.
      this._velocity.x = damp(this._velocity.x, 0, 6, dt);
      this._velocity.z = damp(this._velocity.z, 0, 6, dt);
      this._velocity.y += P.gravity * dt;
      this._position.addScaledVector(this._velocity, dt);
      this.physics.resolveCapsule(this._position, P.radius, CROUCH_HEIGHT);
      if (elapsed - this._deathAt > RESPAWN_DELAY) this.respawn();
      return;
    }

    // A mount owns movement: it has already written `position` (and possibly
    // `velocity` and `yaw`) this step. We contribute only the collision resolve,
    // so a rider still cannot pass through a wall, and the stance/bob state that
    // the avatar and the HUD read.
    if (this.movementOverride) {
      this._crouching = false;
      this._sprinting = false;
      this._capsuleHeight = damp(this._capsuleHeight, STAND_HEIGHT, 16, dt);
      if (this.movementOverrideCollide) {
        const res = this.physics.resolveCapsule(this._position, P.radius, this._capsuleHeight);
        this._wasGrounded = this._grounded;
        this._grounded = res.grounded;
        this._groundNormal.copy(res.groundNormal);
      }
      this._coyote = 0;
      this._jumpBuffer = 0;
      this._jumpHeld = !!this.input.state.jump;
      this._bobWeight = damp(this._bobWeight, 0, 9, dt);
      return;
    }

    const s = this.input.state;

    /* ---- stance ---------------------------------------------------- */
    const wantsCrouch = s.crouch;
    // Never stand up into a ceiling.
    if (!wantsCrouch && this._crouching && !this._hasHeadroom(STAND_HEIGHT)) {
      this._crouching = true;
    } else {
      this._crouching = wantsCrouch;
    }
    const targetHeight = this._crouching ? CROUCH_HEIGHT : STAND_HEIGHT;
    this._capsuleHeight = damp(this._capsuleHeight, targetHeight, 16, dt);

    /* ---- wish direction -------------------------------------------- */
    const sinY = Math.sin(this._yaw);
    const cosY = Math.cos(this._yaw);
    // Facing is -Z at yaw 0.
    const fwdX = -sinY;
    const fwdZ = -cosY;
    const rightX = cosY;
    const rightZ = -sinY;

    let wishX = fwdX * s.forward + rightX * s.right;
    let wishZ = fwdZ * s.forward + rightZ * s.right;
    const wishLen = Math.hypot(wishX, wishZ);
    if (wishLen > 1e-5) {
      wishX /= wishLen;
      wishZ /= wishLen;
    }

    const aiming = !!s.aim;
    this._sprinting =
      !!s.sprint && !aiming && !this._crouching && s.forward > 0 && wishLen > 0.1 && this._grounded;

    let wishSpeed = this._crouching ? P.crouchSpeed : this._sprinting ? P.sprintSpeed : P.walkSpeed;
    if (aiming && !this._crouching) wishSpeed *= 0.62;
    if (wishLen < 1e-5) wishSpeed = 0;

    /* ---- acceleration ---------------------------------------------- */
    if (this._grounded) {
      this._applyFriction(dt);
      this._accelerate(wishX, wishZ, wishSpeed, P.acceleration, dt);
    } else {
      // Air control: same projection, far less authority.
      this._accelerate(wishX, wishZ, wishSpeed, P.airAcceleration, dt);
    }

    /* ---- jump: coyote time + input buffering ------------------------ */
    this._coyote = this._grounded ? COYOTE_TIME : Math.max(0, this._coyote - dt);
    if (s.jump && !this._jumpHeld) this._jumpBuffer = JUMP_BUFFER;
    else this._jumpBuffer = Math.max(0, this._jumpBuffer - dt);
    this._jumpHeld = !!s.jump;

    if (this._jumpBuffer > 0 && this._coyote > 0) {
      this._velocity.y = P.jumpVelocity;
      this._jumpBuffer = 0;
      this._coyote = 0;
      this._grounded = false;
      this.bus.emit('player:jumped', { position: this._position });
    } else if (this._grounded && this._velocity.y <= 0) {
      // Small downward bias keeps contact when running down ramps and stairs.
      this._velocity.y = -2.2;
    }

    if (!this._grounded) this._velocity.y += P.gravity * dt;
    // Terminal velocity - stops the solver from tunnelling on long drops.
    if (this._velocity.y < -60) this._velocity.y = -60;

    /* ---- integrate + collide ---------------------------------------- */
    this._move(dt);

    /* ---- bob + footsteps -------------------------------------------- */
    const speed = Math.hypot(this._velocity.x, this._velocity.z);
    const moving = this._grounded && speed > 0.6;
    this._bobWeight = damp(this._bobWeight, moving ? 1 : 0, 9, dt);
    if (moving) {
      const travelled = speed * dt;
      this._bobDist += travelled;
      this._bobPhase = (this._bobDist / STRIDE) * Math.PI * 2;
      this._footAccum += travelled;
      if (this._footAccum >= STRIDE * 0.5) {
        this._footAccum -= STRIDE * 0.5;
        this._emitFootstep(speed);
      }
    }
  }

  /** Source-style friction: constant deceleration below STOP_SPEED, so no slide. */
  _applyFriction(dt) {
    const vx = this._velocity.x;
    const vz = this._velocity.z;
    const speed = Math.hypot(vx, vz);
    if (speed < 1e-4) {
      this._velocity.x = 0;
      this._velocity.z = 0;
      return;
    }
    const control = Math.max(speed, STOP_SPEED);
    const newSpeed = Math.max(0, speed - control * P.friction * dt);
    const k = newSpeed / speed;
    this._velocity.x = vx * k;
    this._velocity.z = vz * k;
  }

  /**
   * Accelerate toward `wish`, but only by the component we are missing. This is
   * what gives air-strafing its feel and prevents diagonal over-speed.
   */
  _accelerate(wishX, wishZ, wishSpeed, accel, dt) {
    if (wishSpeed <= 0) return;
    const current = this._velocity.x * wishX + this._velocity.z * wishZ;
    const add = wishSpeed - current;
    if (add <= 0) return;
    const gain = Math.min(accel * dt, add);
    this._velocity.x += wishX * gain;
    this._velocity.z += wishZ * gain;
  }

  /**
   * Integrate and resolve, retrying blocked horizontal motion as a step-up.
   * Kerbs and staircases must never stop the player dead.
   */
  _move(dt) {
    const radius = P.radius;
    const h = this._capsuleHeight;

    _prev.copy(this._position);
    const wantX = this._velocity.x * dt;
    const wantZ = this._velocity.z * dt;
    const expectedY = this._position.y + this._velocity.y * dt;

    this._position.set(_prev.x + wantX, expectedY, _prev.z + wantZ);
    let res = this.physics.resolveCapsule(this._position, radius, h);

    const wanted = Math.hypot(wantX, wantZ);
    const gotX = this._position.x - _prev.x;
    const gotZ = this._position.z - _prev.z;
    const got = Math.hypot(gotX, gotZ);

    // Blocked, and we have ground (or coyote) to push off: probe a step.
    if (wanted > 1e-4 && got < wanted * 0.86 && (this._grounded || this._coyote > 0)) {
      // 1. Lift by the step height and make sure the raised capsule fits.
      _step.set(_prev.x, _prev.y + P.stepHeight, _prev.z);
      this.physics.resolveCapsule(_step, radius, h);
      const liftedY = _step.y;

      // 2. Retry the same horizontal motion from up there.
      _step.x += wantX;
      _step.z += wantZ;
      this.physics.resolveCapsule(_step, radius, h);
      const got2 = Math.hypot(_step.x - _prev.x, _step.z - _prev.z);

      if (got2 > got + 0.002 && Math.abs(_step.y - liftedY) < 0.02) {
        // 3. Find the tread by raycast rather than by dropping the capsule.
        //    Dropping it would bury the capsule in the riser, and a solver
        //    ejects along its shallowest axis - which would shove us straight
        //    back off the step. Probe ahead of the capsule axis, because the
        //    axis itself is still held a full radius short of the riser.
        const lead = (radius + 0.01) / wanted;
        const probeX = _step.x + wantX * lead;
        const probeZ = _step.z + wantZ * lead;
        const treadY = this.physics.groundHeight(
          probeX,
          probeZ,
          _step.y + 0.05,
          P.stepHeight + 0.7
        );
        if (treadY !== null && treadY <= _prev.y + P.stepHeight + 0.01 && treadY > _prev.y - 0.06) {
          // Seat slightly inside the tread so the solver reports us grounded.
          _step.y = treadY - 0.01;
          const landed = this.physics.resolveCapsule(_step, radius, h);
          if (Math.hypot(_step.x - _prev.x, _step.z - _prev.z) > got + 0.002) {
            const rise = _step.y - this._position.y;
            this._position.copy(_step);
            res = landed;
            res.grounded = true;
            // Absorb the instantaneous lift in the camera so stairs feel smooth.
            if (rise > 0) this._stepSmooth = Math.min(P.stepHeight * 1.3, this._stepSmooth + rise);
          }
        }
      }
    }

    this._wasGrounded = this._grounded;
    this._grounded = res.grounded;
    this._groundNormal.copy(res.groundNormal);

    if (this._grounded) {
      // Threshold sits above the ground-stick bias (-2.2) so stair treads and
      // ramp crests never register as landings.
      if (!this._wasGrounded && this._velocity.y < -3.0) this._land(-this._velocity.y);
      if (this._velocity.y < 0) this._velocity.y = 0;
    } else if (this._velocity.y > 0 && this._position.y < expectedY - 0.001) {
      // Cracked our head on a ceiling.
      this._velocity.y = 0;
    }
  }

  _land(fallSpeed) {
    // Dip proportional to impact, capped so a long fall cannot black out the
    // view. Motion sickness is a failure state: 0.42 m is the hard ceiling.
    this._dipVel -= Math.min(1.35, Math.max(0, fallSpeed - 2.6) * 0.062);
    this.bus.emit('player:landed', { speed: fallSpeed, position: this._position });
    this._emitFootstep(fallSpeed, true);
  }

  /** Raycast up from the feet to see whether we can extend to `height`. */
  _hasHeadroom(height) {
    _v1.set(this._position.x, this._position.y + 0.15, this._position.z);
    const hit = this.physics.raycast(_v1, _up, height - 0.15, COLLISION_LAYER.WORLD);
    return !hit;
  }

  /**
   * Footsteps carry a surface guess so audio/VFX can vary. Colliders may tag
   * themselves via `userData.material` / `.surface`; anything untagged reports
   * 'default'.
   */
  _emitFootstep(speed, isLanding = false) {
    _v1.set(this._position.x, this._position.y + 0.25, this._position.z);
    const hit = this.physics.raycast(_v1, _down, 0.8, COLLISION_LAYER.WORLD);
    const ud = hit?.collider?.userData;
    const material = ud?.material ?? ud?.surface ?? ud?.type ?? 'default';
    this._footIndex ^= 1;
    this.bus.emit('player:footstep', {
      position: this._position,
      material,
      speed,
      sprinting: this._sprinting,
      crouching: this._crouching,
      foot: this._footIndex ? 'left' : 'right',
      landing: isLanding,
    });
  }

  /* ================================================================ */
  /* Health                                                            */
  /* ================================================================ */

  _tickHealth(dt, elapsed) {
    if (this._dead || this._health >= this._maxHealth) return;
    if (elapsed - this._lastDamageAt < P.healthRegenDelay) return;
    this._regenCarry += P.healthRegenRate * dt;
    if (this._regenCarry >= 1) {
      const whole = Math.floor(this._regenCarry);
      this._regenCarry -= whole;
      this.heal(whole);
    }
  }

  /**
   * Apply damage. Ignored while dead or invulnerable.
   * @returns {number} damage actually applied
   */
  applyDamage(amount, sourcePosition = null, sourceId = null) {
    if (this._dead || amount <= 0) return 0;
    if (this._elapsed < this._invulnUntil) return 0;

    const applied = Math.min(this._health, amount);
    this._health -= applied;
    this._lastDamageAt = this._elapsed;
    this._regenCarry = 0;

    this.bus.emit('player:damaged', {
      amount: applied,
      health: this._health,
      maxHealth: this._maxHealth,
      sourcePosition,
    });

    if (this._health <= 0) this._die(sourceId);
    return applied;
  }

  heal(amount) {
    if (this._dead || amount <= 0) return 0;
    const applied = Math.min(amount, this._maxHealth - this._health);
    if (applied <= 0) return 0;
    this._health += applied;
    this.bus.emit('player:healed', {
      amount: applied,
      health: this._health,
      maxHealth: this._maxHealth,
    });
    return applied;
  }

  _die(killerId) {
    this._dead = true;
    this._health = 0;
    this._deathAt = this._elapsed;
    this._velocity.set(0, this._velocity.y, 0);
    this._weapon.setEnabled(false);
    this._weapon.setAim(false);
    this.bus.emit('player:died', { killerId: killerId ?? null });
  }

  /** Restore the player at the last spawn anchor with brief invulnerability. */
  respawn() {
    this._dead = false;
    this._health = this._maxHealth;
    this._regenCarry = 0;
    this._lastDamageAt = -999;
    this._invulnUntil = this._elapsed + SPAWN_INVULN;
    this._velocity.set(0, 0, 0);
    this._dip = 0;
    this._dipVel = 0;
    this._stepSmooth = 0;
    this._weapon.setEnabled(true);
    this._weapon.resupply();
    this.teleport(this._spawnPosition, this._spawnYaw, { anchor: false });
    this.bus.emit('player:respawned', {});
  }

  /**
   * Move the player instantly. The destination becomes the respawn anchor
   * unless `opts.anchor === false`.
   * @param {THREE.Vector3} position feet position
   * @param {number} [yaw] radians
   */
  teleport(position, yaw = this._yaw, opts = {}) {
    this._position.copy(position);
    this._yaw = yaw;
    this._pitch = 0;
    this._velocity.set(0, 0, 0);
    this._coyote = 0;
    this._jumpBuffer = 0;
    this._stepSmooth = 0;
    this._dip = 0;
    this._dipVel = 0;
    this._bobWeight = 0;
    this._footAccum = 0;
    // Settle out of anything we landed inside.
    const res = this.physics.resolveCapsule(this._position, P.radius, this._capsuleHeight);
    this._grounded = res.grounded;
    this._wasGrounded = res.grounded;

    if (opts.anchor !== false) {
      this._spawnPosition.copy(this._position);
      this._spawnYaw = yaw;
    }
    this._applyCamera(0);
    // Collapse the third-person spring: without this the boom would sweep
    // across the entire world between the old position and the new one.
    this.cameraRig?.snap();
    this.bus.emit('player:spawned', { position: this._position });
  }

  /* ================================================================ */
  /* Per-frame view + weapon                                           */
  /* ================================================================ */

  /**
   * Mouse look, camera composition and viewmodel drive. Runs every rendered
   * frame so look latency is never quantised to the physics rate.
   */
  update(dt, elapsed) {
    this._elapsed = elapsed;

    const look = this.input.consumeLook();
    const lookOwned = this.movementOverride && !this.movementOverrideLook;
    if (!this._harnessFrozen && !this._dead && !lookOwned) {
      this._yaw -= look.dx;
      this._pitch = clamp(this._pitch - look.dy, -MAX_PITCH, MAX_PITCH);
    }
    this._lastLookX = look.dx;
    this._lastLookY = look.dy;

    // View springs.
    this._stepSmooth = damp(this._stepSmooth, 0, 13, dt);
    this._tickDip(dt);
    this._eyeHeight = damp(
      this._eyeHeight,
      this._dead ? 0.32 : this._crouching ? CROUCH_EYE : STAND_EYE,
      14,
      dt
    );

    const s = this.input.state;
    const speed = Math.hypot(this._velocity.x, this._velocity.z);

    // Subtle strafe roll - a couple of degrees, tied to lateral input.
    const rollTarget = this._dead
      ? 0.55
      : -s.right * 0.021 * clamp(speed / P.walkSpeed, 0, 1.2);
    this._roll = damp(this._roll, rollTarget, 7, dt);

    this._driveWeapon(dt, elapsed, speed);
    this._applyFov(dt);
    // In third person the rig owns the transform outright, so composing the eye
    // pose first would be wasted work overwritten a line later.
    if (!this.isThirdPerson) this._applyCamera(dt);
    // Contract 3.1: the rig runs after movement has resolved. It is idempotent
    // per frame, so main.js listing it in the frame order as well is harmless.
    this.cameraRig?.update(dt, elapsed);
  }

  _tickDip(dt) {
    // Critically damped spring back to neutral.
    const k = 150;
    const c = 17;
    const step = Math.min(dt, 1 / 40);
    this._dipVel += (-this._dip * k - this._dipVel * c) * step;
    this._dip += this._dipVel * step;
    this._dip = clamp(this._dip, -0.42, 0.12);
  }

  _driveWeapon(dt, elapsed, speed) {
    // A Loadout, once attached, owns everything in the player's hands - including
    // this machine gun, which it adopts rather than rebuilding. Driving the weapon
    // from here as well would double the fire rate and fight over the viewmodel
    // pose every frame, so this method stands down entirely.
    if (this.loadout) return;

    const w = this._weapon;
    const s = this.input.state;
    const usable = !this._dead && !this.input.textCaptured;

    // The viewmodel is a first-person object composed against the eye. In third
    // person the avatar carries a real weapon in its hand instead, so the
    // viewmodel is hidden outright rather than left floating at the boom pivot.
    w.setVisible(!this._harnessFrozen && !this.isThirdPerson);
    if (this._harnessFrozen) return;

    w.setAim(usable && !!s.aim);
    w.setLowered(!usable || this._sprinting);
    w.setEnabled(usable);

    w.setViewContext({
      referenceFov: this._referenceFov(),
      moveSpeed: speed,
      grounded: this._grounded,
      groundY: this._position.y,
      lookDeltaX: this._lastLookX,
      lookDeltaY: this._lastLookY,
      velocity: this._velocity,
      bobPhase: this._bobPhase,
      bobWeight: this._bobWeight,
      dt,
    });

    if (usable) {
      if (s.fire) w.tryFire(elapsed);
      if (this.input.pressed('KeyR')) w.reload(elapsed);
    }

    w.update(dt, elapsed);
  }

  /** FOV the viewmodel should be composed at, i.e. excluding the sprint kick. */
  _referenceFov() {
    const base = CONFIG.render.fov;
    return THREE.MathUtils.lerp(base, base * 0.7, this._weapon.aimProgress);
  }

  _applyFov(dt) {
    if (this._harnessFrozen) return;
    const base = CONFIG.render.fov;
    const aim = this._weapon.aimProgress;
    // Sprint widens the frame; ADS overrides it and pulls in.
    const hSpeed = Math.hypot(this._velocity.x, this._velocity.z);
    const sprintKick = this._sprinting ? 6.5 * clamp(hSpeed / P.sprintSpeed, 0, 1) : 0;
    const target = THREE.MathUtils.lerp(base + sprintKick, base * 0.7, aim);
    const next = damp(this._fov, target, 9, dt);
    if (Math.abs(next - this._fov) > 0.005) {
      this._fov = next;
      this.camera.fov = next;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Compose eye transform: stance, step smoothing, bob, landing dip, recoil. */
  _applyCamera(dt) {
    if (this._harnessFrozen) {
      this._frozenApplied = true;
      return;
    }
    const cam = this.camera;

    // Head bob in view space: vertical at twice the lateral frequency.
    const amp = P.bobAmplitude * this._bobWeight;
    const p = this._bobPhase;
    const bobY = Math.sin(p * 2) * amp;
    const bobX = Math.cos(p) * amp * 0.72;
    const bobRoll = Math.sin(p) * 0.006 * this._bobWeight;

    const sinY = Math.sin(this._yaw);
    const cosY = Math.cos(this._yaw);
    const rightX = cosY;
    const rightZ = -sinY;

    cam.position.set(
      this._position.x + rightX * bobX,
      this._position.y + this._eyeHeight - this._stepSmooth + bobY + this._dip,
      this._position.z + rightZ * bobX
    );

    const kick = this._weapon.getRecoilOffset();
    // Landing dip also pitches the view down slightly - the head nods forward.
    const dipPitch = this._dip * 0.35;
    cam.rotation.set(
      clamp(this._pitch + kick.y + dipPitch, -MAX_PITCH - 0.2, MAX_PITCH + 0.2),
      this._yaw + kick.x,
      this._roll + bobRoll,
      'YXZ'
    );
  }

  dispose() {
    this._offFired?.();
    this._offFired = null;
    this._weapon.dispose();
  }
}
