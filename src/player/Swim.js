import * as THREE from 'three';
import { CONFIG } from '../core/Config.js';

/**
 * Swimming.
 *
 * Owned by `Player`, which hands movement over whenever this module reports
 * itself active. Three problems had to be solved and they are worth stating,
 * because the naive version of each is what makes water feel bad:
 *
 * ## 1. The edge must not oscillate
 *
 * The obvious entry test - "are my feet under the surface?" - is unstable by
 * construction: the moment you start swimming, buoyancy lifts you to the
 * waterline, your feet come up, and the test says get out again. So the state
 * is driven by *bed depth* (`surfaceY - groundY`), which is a property of the
 * place rather than of the swimmer, with 0.3 m of hysteresis between entering
 * and leaving. Wading out of a river now simply stops being swimming when the
 * bed rises, once, cleanly.
 *
 * ## 2. The floor is real
 *
 * `physics.resolveCapsule` still runs every step, so you cannot swim through
 * the pool wall or sink into the river bed. In shallowing water the bed pushes
 * the feet up, which is what makes the depth test and the visual agree.
 *
 * ## 3. The body has to look like it is swimming
 *
 * `PlayerAvatar` is owned by another agent and cannot be edited, but it drives
 * the shared `NPCAnimator`, whose bone locals are identity at rest. So the pose
 * is written *after* the avatar has updated, from a late frame callback the
 * Player installs, by rotating the humanoid's inner `rig` node into a prone
 * attitude and slerping a crawl cycle onto the limb bones. Same trick the death
 * animation uses, applied one layer further out.
 */

const P = CONFIG.player;
const clamp = THREE.MathUtils.clamp;
const damp = THREE.MathUtils.damp;
const approach = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

/** Bed depth at which swimming starts, and the shallower one at which it stops. */
const ENTER_DEPTH = 1.3;
const EXIT_DEPTH = 1.0;
/** Feet must be this far under the surface before a wade becomes a swim. */
const ENTER_SUBMERSION = 0.55;
/** How far below the surface the feet float at rest. Puts the eye just clear of it. */
const FLOAT_DEPTH = 1.47;
/** Ceiling on the feet while ascending: you cannot launch out of water. */
const RISE_LIMIT = 1.06;

const SWIM_SPEED = 2.2;
const SWIM_SPRINT = 3.15;
const SWIM_ACCEL = 7.5;
const RISE_SPEED = 2.1;
const DIVE_SPEED = 2.4;
/**
 * Vertical spring toward the waterline, and its terminal speeds.
 *
 * NO GRAVITY TERM, and after the per-world gravity pass there is still none.
 * Not an oversight and not laziness - it is unreachable. `PlanetWorld` sets
 * `swim: false` in its rules for all ten planets (a sea there is flown to, not
 * swum in), and `Player` gates this module on `allows(world, 'swim')`, so the
 * only worlds this code ever runs in are the hand-built ones, every one of
 * which publishes no gravity and therefore has a ratio of exactly 1. There is
 * nothing for a gravity term to multiply.
 *
 * It would also have almost nothing to say if it were reachable: the two low-g
 * bodies, Tessera at 1.62 and Lathe at 1.90, publish `liquid: null` - neither
 * has anything liquid on it - and the six planets that DO have a sea run 7.80
 * to 10.10 m/s², i.e. 0.80 to 1.03 g. Physically a buoyant restoring force
 * scales with g, so the correction over that whole span is a few per cent of a
 * spring whose job is to stop a documented oscillation at the waterline. The
 * risk of destabilising that is larger than the fidelity gained.
 *
 * If a planet is ever authored with `swim: true`, THIS is the block to revisit,
 * and the honest scaling is `BUOY_UP_MAX`/`BUOY_DOWN_MAX` as terminal speeds
 * (√r under quadratic drag), not `BUOYANCY`, which is a 1/s rate.
 * @see ../worlds/PlanetWorld.js `rules`
 */
const BUOYANCY = 2.8;
const BUOY_UP_MAX = 1.7;
const BUOY_DOWN_MAX = 1.4;
/** Surface bob, only applied while floating without vertical input. */
const BOB_AMP = 0.05;
const BOB_FREQ = 1.35;

/** Seconds of air, and the damage rate once it is gone. */
const MAX_OXYGEN = 14;
const DROWN_DPS = 9;

/* Scratch. Each function owns its own - see the note in physics/Physics.js. */
const _swWish = new THREE.Vector3();
const _swFwd = new THREE.Vector3();
const _poseAxis = new THREE.Vector3(1, 0, 0);
const _poseQ = new THREE.Quaternion();
const _poseE = new THREE.Euler();

export class Swim {
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

    /** @type {import('../systems/WaterVolumes.js').WaterVolumes|null} */
    this.water = null;

    this._active = false;
    this._surfaceY = 0;
    this._bedY = 0;
    this._depth = 0;
    this._submersion = 0;
    this._oxygen = MAX_OXYGEN;
    this._drownCarry = 0;
    this._bobPhase = 0;
    this._enteredAt = -999;
    this._emittedDepth = -999;

    /* --- pose state ------------------------------------------------ */
    this._poseWeight = 0;
    this._strokePhase = 0;
    this._prone = 0;
    this._poseApplied = false;
  }

  /* ================================================================ */
  /* Accessors                                                         */
  /* ================================================================ */

  get active() {
    return this._active;
  }

  /** Metres of water over the player's feet. */
  get depth() {
    return this._depth;
  }

  /** Water surface height at the player, valid while active. */
  get surfaceY() {
    return this._surfaceY;
  }

  /** True while the eyes are under the surface. */
  get submerged() {
    return this._active && this.player.position.y + P.eyeHeight < this._surfaceY;
  }

  get oxygen() {
    return this._oxygen;
  }

  get maxOxygen() {
    return MAX_OXYGEN;
  }

  /** Blend weight of the swim pose, 0..1. Non-zero briefly after leaving water. */
  get poseWeight() {
    return this._poseWeight;
  }

  /** @param {import('../systems/WaterVolumes.js').WaterVolumes|null} volumes */
  setVolumes(volumes) {
    this.water = volumes ?? null;
  }

  /* ================================================================ */
  /* Simulation                                                        */
  /* ================================================================ */

  /**
   * Decide whether we are in water and, if so, integrate the swim.
   *
   * @param {number} dt fixed timestep, seconds
   * @param {number} elapsed engine time, seconds
   * @returns {boolean} true when this module owns the player's movement
   */
  fixedUpdate(dt, elapsed) {
    const p = this.player;
    const water = this.water;

    if (!water || p.isDead) {
      this._setActive(false, elapsed);
      this._recoverOxygen(dt);
      return false;
    }

    const pos = p.position;
    const surfaceY = water.surfaceYAt(pos.x, pos.z);

    // Above the water plane (a bridge, the pool deck) or nowhere near water.
    if (surfaceY === null || pos.y > surfaceY + 0.02) {
      this._setActive(false, elapsed);
      this._recoverOxygen(dt);
      return false;
    }

    // Only now is a raycast justified: the bed is what decides whether this is
    // wading or swimming, and it is the one query neither box nor plane knows.
    const bed = this.physics.groundHeight(pos.x, pos.z, surfaceY + 0.35, 14);
    this._surfaceY = surfaceY;
    this._bedY = bed === null ? surfaceY - 12 : bed;
    const bedDepth = surfaceY - this._bedY;
    this._submersion = surfaceY - pos.y;
    this._depth = this._submersion;

    if (!this._active) {
      if (bedDepth > ENTER_DEPTH && this._submersion > ENTER_SUBMERSION) {
        this._setActive(true, elapsed);
      } else {
        this._recoverOxygen(dt);
        return false;
      }
    } else if (bedDepth < EXIT_DEPTH || this._submersion < 0.2) {
      this._setActive(false, elapsed);
      this._recoverOxygen(dt);
      return false;
    }

    this._integrate(dt, elapsed);
    this._breathe(dt, elapsed);
    this._publishDepth();
    return true;
  }

  /** Water physics: drag-dominated horizontal motion, a buoyancy spring on Y. */
  _integrate(dt, elapsed) {
    const p = this.player;
    const s = this.input.state;
    const v = p.velocity;
    const pos = p.position;
    const stam = p.stamina;

    // Stance never applies in water; keep the capsule and the HUD honest.
    p.setStanceWet(dt);

    /* ---- wish direction --------------------------------------------
     * Full 3D, taken from the look vector rather than the yaw plane, so
     * looking down and holding W dives. That is the convention every swimmer
     * in every shooter uses and players reach for it immediately. */
    const cp = Math.cos(p.pitch);
    _swFwd.set(-Math.sin(p.yaw) * cp, Math.sin(p.pitch), -Math.cos(p.yaw) * cp);
    const rightX = Math.cos(p.yaw);
    const rightZ = -Math.sin(p.yaw);

    _swWish.set(
      _swFwd.x * s.forward + rightX * s.right,
      _swFwd.y * s.forward,
      _swFwd.z * s.forward + rightZ * s.right
    );
    const wishLen = _swWish.length();
    if (wishLen > 1e-4) _swWish.multiplyScalar(1 / wishLen);

    const exhausted = stam ? stam.exhausted : false;
    const sprinting = !!s.sprint && wishLen > 0.1 && !exhausted;
    let speed = sprinting ? SWIM_SPRINT : SWIM_SPEED;
    /* Body-locomotion buffs apply in water as on land. Ground movement takes
     * the boost (Player._accelerate), air control refuses it WITH a comment
     * explaining why - water had neither the boost nor a reason, which read
     * as oversight, and it matters now that the Lido swim challenge is a race
     * a speed consumable should legitimately help with. Vehicles stay
     * unaffected: mounts have their own purchasable power tier. Measured
     * before this line: 3s of held-W swim moved 6.32m plain vs 6.36m at x1.5
     * (no effect); after: the ratio tracks the multiplier. */
    speed *= this.player?.speedMultiplier ?? 1;
    if (exhausted) speed *= 0.55;
    if (wishLen < 1e-4) speed = 0;

    // Horizontal: exponential approach *is* the damping. Water has no friction
    // model worth simulating, and this gives the heavy, unhurried feel asked for.
    const targetX = _swWish.x * speed;
    const targetZ = _swWish.z * speed;
    v.x = approach(v.x, targetX, SWIM_ACCEL, dt);
    v.z = approach(v.z, targetZ, SWIM_ACCEL, dt);

    /* ---- vertical ---------------------------------------------------- */
    const wantUp = !!s.jump;
    const wantDown = !!s.crouch;
    const swimY = _swWish.y * speed;
    let targetY;

    if (exhausted) {
      // Out of stamina: the player sinks. Deliberately slow, so it reads as
      // failing rather than as a bug, and there is time to reach the bank.
      targetY = -0.85;
      this._bobPhase = 0;
    } else if (wantUp) {
      const headroom = this._surfaceY - RISE_LIMIT - pos.y;
      targetY = RISE_SPEED * clamp(headroom / 0.25, 0, 1) + Math.max(0, swimY);
    } else if (wantDown) {
      targetY = -DIVE_SPEED + Math.min(0, swimY);
    } else if (Math.abs(swimY) > 0.05) {
      // Swimming along the look vector; buoyancy only trims the result.
      targetY = swimY;
    } else {
      this._bobPhase += dt * BOB_FREQ;
      const bob = Math.sin(this._bobPhase * Math.PI * 2) * BOB_AMP;
      const rest = this._surfaceY - FLOAT_DEPTH + bob;
      targetY = clamp((rest - pos.y) * BUOYANCY, -BUOY_DOWN_MAX, BUOY_UP_MAX);
    }
    v.y = approach(v.y, targetY, 6.5, dt);

    /* ---- integrate + collide ------------------------------------------ */
    pos.addScaledVector(v, dt);
    const res = this.physics.resolveCapsule(pos, P.radius, P.height);
    p.setSwimContact(res);

    // Never allow a swimmer to be pushed above the water by the solver and then
    // be counted as still swimming next step; the state test handles the rest.
    if (pos.y > this._surfaceY) pos.y = this._surfaceY;

    /* ---- stamina ------------------------------------------------------- */
    if (stam) {
      const rate = sprinting ? P.swimSprintStaminaDrain : P.swimStaminaDrain;
      stam.drain(rate * dt, sprinting ? 'swim-sprint' : 'swim');
    }
    void elapsed;
  }

  /** Oxygen, and the damage that follows running out of it. */
  _breathe(dt, elapsed) {
    const p = this.player;
    const under = p.position.y + P.eyeHeight < this._surfaceY - 0.02;
    if (!under) {
      this._recoverOxygen(dt);
      return;
    }
    this._oxygen = Math.max(0, this._oxygen - dt);
    if (this._oxygen > 0) return;

    this._drownCarry += DROWN_DPS * dt;
    if (this._drownCarry >= 1) {
      const whole = Math.floor(this._drownCarry);
      this._drownCarry -= whole;
      p.applyDamage(whole, null, 'drowning');
      this.bus?.emit('player:drowning', { oxygen: 0, health: p.health });
    }
    void elapsed;
  }

  _recoverOxygen(dt) {
    if (this._oxygen >= MAX_OXYGEN) return;
    // Surfacing refills three times faster than it drains: gasping for twelve
    // seconds after a dive is not a mechanic anyone enjoys.
    this._oxygen = Math.min(MAX_OXYGEN, this._oxygen + dt * 3);
    this._drownCarry = 0;
  }

  _setActive(on, elapsed) {
    if (on === this._active) return;
    this._active = on;
    if (on) {
      this._enteredAt = elapsed;
      this._bobPhase = 0;
      // Entering kills the fall so a jump into a river does not spear the
      // player into the bed at terminal velocity.
      const v = this.player.velocity;
      v.y = Math.max(v.y, -3.2);
      v.x *= 0.55;
      v.z *= 0.55;
    } else {
      this._depth = 0;
    }
    this.bus?.emit('player:swim', { swimming: on, depth: this._depth });
    this._emittedDepth = this._depth;
  }

  _publishDepth() {
    if (Math.abs(this._depth - this._emittedDepth) < 0.3) return;
    this._emittedDepth = this._depth;
    this.bus?.emit('player:swim', { swimming: true, depth: this._depth });
  }

  /** Force the swim state off (world change, mount, death). */
  cancel() {
    if (this._active) {
      this._active = false;
      this._depth = 0;
      this.bus?.emit('player:swim', { swimming: false, depth: 0 });
    }
    this._oxygen = MAX_OXYGEN;
  }

  /* ================================================================ */
  /* Pose                                                              */
  /* ================================================================ */

  /**
   * Lay the avatar out in the water. Runs from the Player's late frame
   * callback, i.e. after `PlayerAvatar.update` has already posed the skeleton,
   * so everything written here is the final word for the frame.
   *
   * @param {number} dt
   * @param {number} elapsed
   */
  applyPose(dt, elapsed) {
    const avatar = this.player.avatar;
    const humanoid = avatar?.humanoid;
    if (!humanoid) return;

    /* Stow the gun in the water (user request, verbatim: "remove gun when
     * swimming"). Same three-owner visibility problem the tennis racket
     * documents: the carried carbine is re-shown by wardrobe rebuilds and the
     * first-person viewmodel is re-asserted every frame by its owners - so
     * while swimming both are overridden HERE, per frame, which wins because
     * applyPose runs from Player._installLatePose, after those owners. On
     * exit the carried flag is restored once and the viewmodel's owners
     * re-assert themselves the very next frame. */
    if (this._active) {
      if (!this._weaponStowed) {
        this._weaponStowed = true;
        this._weaponWasVisible = avatar?._weapon?.visible ?? null;
      }
      if (avatar?._weapon) avatar._weapon.visible = false;
      this.player.weapon?.setVisible?.(false);
    } else if (this._weaponStowed) {
      this._weaponStowed = false;
      if (avatar?._weapon && this._weaponWasVisible !== null) {
        avatar._weapon.visible = this._weaponWasVisible;
      }
    }

    this._poseWeight = damp(this._poseWeight, this._active ? 1 : 0, 9, dt);
    if (this._poseWeight < 0.002) {
      if (this._poseApplied) {
        // Hand the rig back exactly as we found it, or the body stays tilted
        // on dry land and the death animation inherits the offset.
        humanoid.rig.quaternion.identity();
        humanoid.rig.position.y = 0;
        this._poseApplied = false;
        this._prone = 0;
      }
      return;
    }
    this._poseApplied = true;

    const p = this.player;
    const v = p.velocity;
    const planar = Math.hypot(v.x, v.z);
    const w = this._poseWeight;

    // Prone while making way, upright while treading water: the same read a
    // real swimmer gives, and it keeps the head clear when idle.
    const moving = clamp(planar / SWIM_SPEED, 0, 1);
    const dive = clamp(-v.y / DIVE_SPEED, 0, 1);
    const proneTarget = 0.30 + moving * 0.95 + dive * 0.28;
    this._prone = damp(this._prone, proneTarget, 5, dt);
    const tilt = this._prone * w;

    // Negative X about the feet takes the head from up (+Y) to forward (-Z).
    humanoid.rig.quaternion.setFromAxisAngle(_poseAxis, -tilt);
    // Re-float the body: the rotation pivots on the feet, so without this lift
    // a prone swimmer's chest ends up a metre under their own ankles.
    humanoid.rig.position.y = Math.sin(tilt) * 0.72 * w;

    // Stroke rate follows effort, with a slow idle scull so a stationary
    // swimmer is never a mannequin floating on its face.
    this._strokePhase += dt * (0.85 + moving * 1.55);
    const ph = this._strokePhase * Math.PI * 2;
    const B = humanoid.bones;

    const set = (name, x, y, z, weight = w) => {
      const bone = B.get(name);
      if (!bone) return;
      _poseE.set(x, y, z);
      _poseQ.setFromEuler(_poseE);
      bone.quaternion.slerp(_poseQ, weight);
    };

    /* ---- arms: alternating crawl -------------------------------------
     * Positive X on an upper arm swings it forward; PI puts it overhead. The
     * two sides run half a cycle apart, and the recovery half of each stroke
     * (arm out of the water) bends the elbow more than the pull. */
    for (const side of [1, -1]) {
      const s = side > 0 ? 'R' : 'L';
      const phase = ph + (side > 0 ? 0 : Math.PI);
      const swing = Math.sin(phase);
      const arm = 1.45 + swing * 1.35;
      const recovery = clamp(swing, 0, 1);
      set(`clavicle${s}`, 0, 0, -0.12 * side * (0.4 + recovery * 0.6));
      set(`upperArm${s}`, arm, 0, side * (0.32 + recovery * 0.3));
      set(`foreArm${s}`, 0.35 + recovery * 0.75, 0, side * 0.12);
      set(`hand${s}`, 0.1, 0, 0);
    }

    /* ---- legs: flutter kick ------------------------------------------- */
    const kick = Math.sin(ph * 1.6);
    for (const side of [1, -1]) {
      const s = side > 0 ? 'R' : 'L';
      const k = side > 0 ? kick : -kick;
      const amp = 0.24 + moving * 0.26;
      set(`thigh${s}`, k * amp + 0.06, 0, side * 0.05);
      set(`calf${s}`, -Math.max(0, k) * amp * 1.9 - 0.12, 0, 0);
      set(`foot${s}`, 0.42 + k * 0.18, 0, 0);
    }

    /* ---- spine and head ------------------------------------------------
     * Arching back against the prone tilt is what lifts the face out of the
     * water; without it a swimming player is face-down and reads as a corpse. */
    const lift = tilt * 0.42;
    set('spine01', -lift * 0.32, 0, 0);
    set('spine02', -lift * 0.34, 0, 0);
    set('spine03', -lift * 0.34, 0, 0);
    set('neck', -lift * 0.5, 0, 0);
    set('head', -lift * 0.55, 0, 0);

    void elapsed;
  }
}
