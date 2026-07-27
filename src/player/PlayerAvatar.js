import * as THREE from 'three';
import { COLLISION_LAYER } from '../physics/Physics.js';
import { HumanoidFactory } from '../npc/Humanoid.js';
import { NPCAnimator } from '../npc/NPCAnimator.js';
import { AVATAR_FADE_LENGTH } from './CameraRig.js';

/**
 * The player's body.
 *
 * Built from the same `HumanoidFactory` and driven by the same `NPCAnimator` as
 * every NPC, so the character behind the camera is made of exactly the same
 * stuff as the ones in front of it - same skinning, same foot IK, same aim
 * layer. Locomotion is derived from `player.velocity`, `player.grounded` and the
 * stance blend rather than from an animation state machine, because that is what
 * the animator was designed to consume.
 *
 * ## First person: shadow-only rendering
 *
 * The requirement is that the body must not be visible around the camera but
 * must still cast a shadow, and the obvious levers both fail:
 *
 *   - `object.visible = false` removes the object from the shadow map too
 *     (`WebGLShadowMap.renderObject` returns immediately on it).
 *   - Moving the body to a private layer fails for the same reason: the shadow
 *     pass tests `object.layers` against the **view** camera, not the light.
 *
 * What works is to keep the object visible and switch its materials to write
 * nothing: `colorWrite = false` plus `depthWrite = false`. The shadow pass does
 * not use the material's colour state - it swaps in a depth material - so the
 * full-body shadow is unaffected, while the beauty pass renders the mesh and
 * discards every fragment.
 *
 * There is one trap in that, and it is why `allowOverride` is in here too:
 * `GTAOPass` renders a normal/depth prepass through `scene.overrideMaterial`,
 * which would replace our silenced material with its own and paint the inside
 * of the player's own head into the AO buffer - a dark blob over the entire
 * screen. `material.allowOverride = false` exempts the body from that pass.
 *
 * The avatar therefore owns a *private* `HumanoidFactory`, not the NPC one:
 * `CharacterAssets` caches materials by colour and hands the same instance to
 * every NPC that shares a skin tone, so toggling `colorWrite` on a shared
 * material would blank out half the crowd.
 */

/* Scratch. Each function owns its own, per the house rule. */
const _upBody = new THREE.Vector3();
const _clrOrigin = new THREE.Vector3();
const _clrDown = new THREE.Vector3(0, -1, 0);
const _mzOut = new THREE.Vector3();
const _dthDir = new THREE.Vector3();
const _airEuler = new THREE.Euler();
const _airQuat = new THREE.Quaternion();

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrapPi = (a) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};
const approach = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

/**
 * Crouch depth in animator units.
 *
 * The animator's crouch term drops the pelvis 0.24 m per unit before its leg IK
 * and hyperextension compensation claw some of it back - measured, 2.29 units
 * bought 0.376 m of pelvis. The player's capsule loses 0.73 m of eye height on
 * crouch, so a value of 1 leaves the body standing upright inside a crouched
 * collider. 3.0 puts the pelvis at ~0.49 m and the crown near 1.05 m, which is a
 * real squat that still resolves cleanly through the IK.
 */
const CROUCH_DEPTH = 3.0;
/** Extra crouch spike absorbed on landing, scaled by impact speed. */
const LAND_ABSORB = 0.085;

/**
 * Feet-to-floor gap beyond which the body is treated as airborne.
 *
 * `player.grounded` alone is not trustworthy enough to drive a jump pose: it
 * flickers over collider seams, and the unstuck system nudges the capsule
 * upward, which measured as 0.88 airborne while the player was standing
 * perfectly still - legs tucked, arms out, a starfish. Real clearance under the
 * feet cannot lie about that, and it costs one raycast a frame.
 */
const AIR_CLEARANCE = 0.32;
/** How far down the clearance probe looks before declaring open air. */
const AIR_PROBE = 3.0;

/** Turn rates, radians/second. Aiming locks the body to the camera. */
const TURN_AIM = 18;
const TURN_MOVE = 11;
const TURN_IDLE = 4.5;
/** Idle dead zone: the body does not chase small camera turns while standing. */
const TURN_DEADZONE = 0.6;

/** Barrel tip in the weapon prop's local frame (end of the muzzle brake). */
const MUZZLE_Z = -0.79;

/**
 * Seating of the carbine in the right hand.
 *
 * Measured, not guessed. `HostileNPC`'s numbers are authored for a rifle carried
 * at the side and put the barrel through the top of the head once the aim IK
 * raises the arms - the tip sat 2.16 m above the feet on the first run. These
 * were solved in-engine from the hand's world basis while the aim layer was at
 * full weight: align the prop's -Z with the aim direction and roll it so the
 * optic faces world up. The roll is ~166 degrees because the hand bone's rest
 * frame is close to inverted about the grip axis.
 */
const HAND_ROT = [-0.06, 0.03, 2.9];
/** Places the grip, not the model origin, in the palm. */
const HAND_POS = [-0.015, -0.056, -0.046];

export class PlayerAvatar {
  /**
   * @param {{ scene: THREE.Scene, engine: import('../core/Engine.js').Engine,
   *           materials: any, player: import('./Player.js').Player,
   *           bus: import('../core/EventBus.js').EventBus,
   *           physics?: import('../physics/Physics.js').Physics,
   *           seed?: number }} ctx
   */
  constructor({ scene, engine, materials, player, bus, physics = null, seed = 0x5ea71 }) {
    this.scene = scene;
    this.engine = engine;
    this.materials = materials;
    this.player = player;
    this.bus = bus;
    this.physics = physics ?? player?.physics ?? null;

    this.factory = new HumanoidFactory({ renderer: engine?.renderer });

    // A fixed seed: the player is one specific person across every session and
    // every world, not a fresh random crowd member on each boot.
    this.humanoid = this.factory.create({
      seed,
      theme: 'station',
      variant: 'eva',
      palette: 0,
      height: 1.78,
      build: 1,
      frame: 1,
      shoulderScale: 1.05,
      hairStyle: 'crop',
      faceId: 2,
    });

    this._root = this.humanoid.root;
    this._root.name = 'player.avatar';
    this._root.position.copy(player?.position ?? _upBody.set(0, 0, 0));
    scene.add(this._root);

    this.animator = new NPCAnimator({ humanoid: this.humanoid, physics: this.physics, seed: 11 });

    this._weapon = this._buildWeapon();

    /* --- render-state bookkeeping --------------------------------- */
    /** @type {THREE.Material[]} */
    this._materials = [];
    this._depthWrite = [];
    this._collectMaterials();
    this._shadowOnly = false;
    this._visible = true;

    /* --- animation state ------------------------------------------ */
    this._bodyYaw = player?.yaw ?? 0;
    this._turnRate = 0;
    this._airWeight = 0;
    this._landAbsorb = 0;
    this._dead = false;
    /** Mounts set this false and drive `root` themselves. */
    this.followPlayer = true;
    this._ridePose = 'none';

    this._offs = [];
    if (bus) {
      this._offs.push(
        bus.on('player:landed', ({ speed }) => {
          this._landAbsorb = Math.min(1.15, Math.max(0, (speed ?? 0) - 2.4) * LAND_ABSORB);
        })
      );
      this._offs.push(bus.on('player:respawned', () => this._revive()));
      this._offs.push(bus.on('player:spawned', () => this._snap()));
    }

    if (player) player.avatar = this;
    this._snap();
  }

  /* ================================================================ */
  /* Contract accessors                                                */
  /* ================================================================ */

  /** @returns {THREE.Object3D} */
  get root() {
    return this._root;
  }

  /** Hard show/hide. Independent of the first-person shadow-only state. */
  setVisible(v) {
    this._visible = !!v;
    this._root.visible = this._visible;
  }

  get visible() {
    return this._visible;
  }

  /**
   * World-space barrel tip. This is the origin `CameraRig` fires third-person
   * shots from, so it has to be the real prop, not an estimate.
   * @param {THREE.Vector3} out
   * @returns {THREE.Vector3|null}
   */
  getMuzzleWorld(out) {
    if (!this._weapon) return null;
    this._weapon.updateWorldMatrix(true, false);
    return out.set(0, 0.006, MUZZLE_Z).applyMatrix4(this._weapon.matrixWorld);
  }

  /**
   * Ride pose for the mount system.
   * @param {'none'|'board'|'saddle'} kind
   */
  setRidePose(kind) {
    this._ridePose = kind ?? 'none';
    // Both poses are expressed through the animator's crouch term, which
    // re-solves the leg IK to keep the feet planted rather than fighting it.
    // 'board' is a loose athletic stance; 'saddle' is a deep seat.
    this.animator.setPosture(kind === 'saddle' ? 'squat' : 'none');
  }

  /* ================================================================ */
  /* Build                                                             */
  /* ================================================================ */

  /**
   * Compact carbine matching the VK-7 viewmodel's silhouette, parented to the
   * right hand so the animator's aim IK carries it. Hand-merged for the same
   * reason `HostileNPC` does it - six primitives is not worth an addon import.
   */
  _buildWeapon() {
    const assets = this.factory.assets;
    if (!assets) return null;

    const parts = [];
    const push = (geo, x, y, z, rx = 0) => {
      if (rx) geo.rotateX(rx);
      geo.translate(x, y, z);
      parts.push(geo);
    };
    push(new THREE.BoxGeometry(0.055, 0.082, 0.38), 0, 0, -0.07); // receiver
    push(new THREE.BoxGeometry(0.04, 0.056, 0.32), 0, -0.004, -0.38); // handguard
    push(new THREE.CylinderGeometry(0.013, 0.011, 0.3, 8), 0, 0.008, -0.62, Math.PI / 2); // barrel
    push(new THREE.CylinderGeometry(0.021, 0.018, 0.07, 8), 0, 0.008, -0.755, Math.PI / 2); // brake
    push(new THREE.BoxGeometry(0.046, 0.115, 0.115), 0, -0.082, -0.03); // magazine
    push(new THREE.BoxGeometry(0.05, 0.09, 0.22), 0, -0.014, 0.21); // stock
    push(new THREE.BoxGeometry(0.032, 0.06, 0.14), 0, 0.062, -0.06); // optic rail + sight
    push(new THREE.BoxGeometry(0.03, 0.075, 0.05), 0, -0.07, 0.05); // pistol grip

    let vTotal = 0;
    let iTotal = 0;
    for (const p of parts) {
      vTotal += p.getAttribute('position').count;
      iTotal += p.getIndex().count;
    }
    const pos = new Float32Array(vTotal * 3);
    const nrm = new Float32Array(vTotal * 3);
    const uv = new Float32Array(vTotal * 2);
    const idx = new Uint16Array(iTotal);
    let vo = 0;
    let io = 0;
    for (const p of parts) {
      const pp = p.getAttribute('position');
      pos.set(pp.array, vo * 3);
      nrm.set(p.getAttribute('normal').array, vo * 3);
      uv.set(p.getAttribute('uv').array, vo * 2);
      const pi = p.getIndex();
      for (let i = 0; i < pi.count; i++) idx[io + i] = pi.getX(i) + vo;
      vo += pp.count;
      io += pi.count;
      p.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    this._weaponGeo = geo;

    const mesh = new THREE.Mesh(geo, assets.metal(0x33383f, 'panel', 0.38));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.set(HAND_POS[0], HAND_POS[1], HAND_POS[2]);
    mesh.rotation.set(HAND_ROT[0], HAND_ROT[1], HAND_ROT[2]);
    this.humanoid.weaponMount.add(mesh);
    return mesh;
  }

  /** Every material in the avatar subtree, so render state can be flipped as one. */
  _collectMaterials() {
    const seen = new Set();
    this._root.traverse((o) => {
      const m = o.material;
      if (!m) return;
      const list = Array.isArray(m) ? m : [m];
      for (const mat of list) {
        if (!mat || seen.has(mat)) continue;
        seen.add(mat);
        this._materials.push(mat);
        this._depthWrite.push(mat.depthWrite);
      }
    });
  }

  /**
   * Silence the body in the beauty and AO passes while leaving the shadow pass
   * untouched. See the class comment for why this is the only combination that
   * both hides the mannequin and keeps the shadow.
   */
  _setShadowOnly(on) {
    if (on === this._shadowOnly) return;
    this._shadowOnly = on;
    for (let i = 0; i < this._materials.length; i++) {
      const m = this._materials[i];
      m.colorWrite = !on;
      m.depthWrite = on ? false : this._depthWrite[i];
      m.allowOverride = !on;
    }
  }

  /* ================================================================ */
  /* Frame update                                                      */
  /* ================================================================ */

  /**
   * @param {number} dt
   * @param {number} elapsed
   */
  update(dt, elapsed) {
    const p = this.player;
    if (!p || !this._visible) return;

    const rig = p.cameraRig;
    const third = rig ? rig.isThird : false;
    // A boom crushed against a wall puts the camera inside the body, so the
    // body drops to shadow-only there too - the same mechanism that hides it in
    // first person, reused rather than duplicated.
    const crushed = third && rig.boomLength < AVATAR_FADE_LENGTH;
    // The harness detaches the camera to frame the world, so the body is always
    // shown for a screenshot regardless of mode - otherwise every third-person
    // review shot would be of an invisible player.
    this._setShadowOnly((!third || crushed) && !p._harnessFrozen);

    if (this.followPlayer) {
      this._root.position.copy(p.position);
      this._driveYaw(dt, elapsed);
    }

    if (p.isDead) {
      this._enterDeath();
    } else if (this._dead) {
      this._revive();
    }

    if (!this._dead) this._driveLocomotion(dt, elapsed, third, rig);

    this.animator.update(dt, elapsed, {
      // Foot IK grounds the feet to whatever is under them. In the air that is
      // the floor several metres below, and the animator would drag the pelvis
      // all the way down to it, so IK is off while airborne - and always while
      // riding, because a rider's feet belong to the mount, not the terrain.
      ik: this._airWeight < 0.3 && !p.movementOverride,
      detail: third,
    });
    this.humanoid.setDetailVisible(third);

    if (!this._dead && !p.movementOverride && this._airWeight > 0.002) this._applyAirPose();
  }

  /**
   * Body facing.
   *
   * Aiming locks the torso to the camera - that is what makes a third-person
   * shooter's crosshair believable. Free movement instead turns the body into
   * the direction of travel, because the animator has one forward-facing gait
   * and no strafe set: a body locked forward while walking sideways slides its
   * feet, which reads worse than a character who simply turns.
   */
  _driveYaw(dt, elapsed) {
    const p = this.player;
    const vx = p.velocity.x;
    const vz = p.velocity.z;
    const speed = Math.hypot(vx, vz);
    const moving = speed > 0.6 && p.grounded;
    const aiming = p.isAiming || elapsed - p.lastFiredAt < 1.1;

    let want;
    let rate;
    if (aiming) {
      want = p.yaw;
      rate = TURN_AIM;
    } else if (moving) {
      want = Math.atan2(-vx, -vz);
      rate = TURN_MOVE;
    } else {
      want = p.yaw;
      rate = TURN_IDLE;
    }

    let delta = wrapPi(want - this._bodyYaw);
    // Standing still, small camera turns are a glance, not a turn-in-place.
    if (!aiming && !moving && Math.abs(delta) < TURN_DEADZONE) delta = 0;

    const maxTurn = rate * dt;
    const applied = clamp(delta, -maxTurn, maxTurn);
    this._bodyYaw = wrapPi(this._bodyYaw + applied);
    this._turnRate = applied / Math.max(dt, 1e-4);
    this._root.rotation.y = this._bodyYaw;
  }

  _driveLocomotion(dt, elapsed, third, rig) {
    const p = this.player;
    const a = this.animator;
    const speed = Math.hypot(p.velocity.x, p.velocity.z);
    // A rider is neither grounded nor falling as far as the body is concerned:
    // the mount holds them up. Treating the hoverboard's permanent hover as
    // free-fall spread the arms into a starfish, which is what this guards.
    const ridden = p.movementOverride;
    const grounded = (p.grounded || ridden || !this._hasAirGap()) && !this._dead;

    this._airWeight = approach(this._airWeight, grounded ? 0 : 1, grounded ? 14 : 7, dt);
    this._landAbsorb = approach(this._landAbsorb, 0, 7, dt);

    // Feet must not cycle in mid-air, and a rider's feet are planted on a board.
    a.setLocomotion(ridden ? 0 : grounded ? speed : speed * (1 - this._airWeight), this._turnRate);
    const rideCrouch = ridden ? (this._ridePose === 'saddle' ? 2.4 : 0.85) : 0;
    a.crouchTarget = Math.max(p.crouchAmount * CROUCH_DEPTH, rideCrouch) + this._landAbsorb;

    // Aim layer: the arms hold the carbine on the crosshair whenever the weapon
    // is up. Sprinting and free-fall drop it so the arms swing again.
    const lowered = (p.isSprinting && !ridden) || this._airWeight > 0.72;
    const target = rig?.aimPoint ?? null;
    a.setAimTarget(lowered ? null : target);
    a.setLookTarget(target);
    void third;
    void elapsed;
  }

  /**
   * Is there real open air under the feet?
   *
   * The corroborating half of the airborne test - see `AIR_CLEARANCE`. Starts
   * the ray slightly above the feet so a capsule seated a millimetre inside the
   * floor still finds it.
   *
   * @returns {boolean} true when the floor is further away than a step
   */
  _hasAirGap() {
    const phys = this.physics;
    if (!phys) return true;
    const p = this.player.position;
    _clrOrigin.set(p.x, p.y + 0.12, p.z);
    const hit = phys.raycast(_clrOrigin, _clrDown, AIR_PROBE, COLLISION_LAYER.WORLD);
    if (!hit) return true;
    return hit.distance - 0.12 > AIR_CLEARANCE;
  }

  /**
   * Additive airborne pose.
   *
   * Layered on top of the animator's own output rather than fed into it, because
   * `NPCAnimator` has no jump - NPCs never leave the ground. Thigh +X swings the
   * knee forward, calf -X folds the shin back, so the pair reads as a tuck on
   * the way up and a reach on the way down.
   */
  _applyAirPose() {
    const w = this._airWeight;
    const vy = this.player.velocity.y;
    // +1 at the top of a jump, -1 in a fall.
    const rise = clamp(vy / 6, -1, 1);
    const tuck = (0.42 + 0.5 * Math.max(0, rise) - 0.28 * Math.max(0, -rise)) * w;

    const B = this.humanoid.bones;
    const add = (name, x, z = 0) => {
      const bone = B.get(name);
      if (!bone) return;
      _airEuler.set(x, 0, z);
      _airQuat.setFromEuler(_airEuler);
      bone.quaternion.multiply(_airQuat);
    };

    // Asymmetric: a split stance reads as a person, a symmetric one as a doll.
    add('thighR', tuck * 1.05, 0.06 * w);
    add('thighL', tuck * 0.6, -0.06 * w);
    add('calfR', -tuck * 1.25);
    add('calfL', -tuck * 0.7);
    add('footR', tuck * 0.5);
    add('footL', tuck * 0.35);
    // Arms only counter-balance when they are not holding an aim pose.
    const free = 1 - this.animator.aimWeight;
    if (free > 0.01) {
      add('upperArmR', -0.35 * w * free, 0.3 * w * free);
      add('upperArmL', -0.35 * w * free, -0.3 * w * free);
    }
  }

  /* ================================================================ */
  /* Death / respawn                                                   */
  /* ================================================================ */

  _enterDeath() {
    if (this._dead) return;
    this._dead = true;
    const p = this.player;
    _dthDir.set(-Math.sin(p.yaw), 0, -Math.cos(p.yaw));
    this.animator.setAimTarget(null);
    this.animator.setLookTarget(null);
    this.animator.die(_dthDir, false);
  }

  _revive() {
    if (!this._dead && !this.animator.dead) return;
    this._dead = false;
    this.animator.revive();
    this._airWeight = 0;
    this._landAbsorb = 0;
    this._snap();
  }

  /** Park the body on the player without a frame of interpolation. */
  _snap() {
    const p = this.player;
    if (!p) return;
    this._root.position.copy(p.position);
    this._bodyYaw = p.yaw;
    this._turnRate = 0;
    this._root.rotation.y = this._bodyYaw;
    this._root.updateMatrixWorld(true);
  }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
    if (this.player?.avatar === this) this.player.avatar = null;
    this._weapon?.removeFromParent();
    this._weaponGeo?.dispose();
    this.humanoid.dispose();
    // The factory is private to the avatar, so its CharacterAssets go with it.
    this.factory.dispose();
  }
}
