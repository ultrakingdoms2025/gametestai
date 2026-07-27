import * as THREE from 'three';
import { Hoverboard } from './Hoverboard.js';
import { Dragon } from './Dragon.js';
import { HumanoidFactory } from '../npc/Humanoid.js';

/**
 * Mount ownership and the mounted movement authority.
 *
 * While a mount is active this class *owns the player's position*. The player
 * controller is told to stand down via `player.movementOverride`, the mount
 * simulates itself against the same `physics` the player uses - so a mount can
 * no more pass through a wall than a player can - and the seat position is
 * written back onto the player every fixed step.
 *
 * The position is re-asserted once more in the frame update. That is deliberate
 * belt-and-braces: if `movementOverride` is ever ignored (it is implemented by
 * a different module), the worst case becomes one frame of camera lag rather
 * than the rider sliding off the mount.
 *
 * Keys are read in `update`, not `fixedUpdate`, because `input.pressed()` is
 * edge-triggered per *frame* - a fixed step can run twice or not at all in a
 * given frame, which would double- or drop-fire a toggle.
 */

/* ---- module scratch, one private block per function ---- */
const _fu1 = new THREE.Vector3(); // fixedUpdate seat
const _dm1 = new THREE.Vector3(); // _dismount placement
const _sp1 = new THREE.Vector3(); // summon placement
const _up1 = new THREE.Vector3(); // update re-assert
/* IK-only. Nothing outside `_solveIK` may borrow these. */
const _ikTarget = new THREE.Vector3();
const _ikT = new THREE.Vector3();
const _ikU = new THREE.Vector3();
const _ikP = new THREE.Vector3();
const _ikD1 = new THREE.Vector3();
const _ikD2 = new THREE.Vector3();
const _ikR1 = new THREE.Vector3();
const _ikR2 = new THREE.Vector3();
const _ikQ1 = new THREE.Quaternion();
const _ikQ2 = new THREE.Quaternion();
const _ikQ3 = new THREE.Quaternion();

const damp = THREE.MathUtils.damp;
const clamp = THREE.MathUtils.clamp;

/** Rider poses, in bone-space radians. Rest pose is arms-down, legs straight. */
const POSE = {
  hover: {
    root: [0, -0.12, 0],
    rootRot: [0.06, 0.62, 0],
    bones: {
      pelvis: [0.06, 0, 0],
      spine01: [0.05, -0.12, 0],
      spine02: [0.04, -0.14, 0.02],
      spine03: [0.02, -0.12, 0],
      neck: [-0.06, 0.2, 0],
      head: [-0.05, 0.22, 0],
      thighR: [0.34, 0.1, -0.16],
      calfR: [-0.72, 0, 0],
      footR: [0.36, 0, 0],
      thighL: [0.4, -0.1, 0.2],
      calfL: [-0.8, 0, 0],
      footL: [0.42, 0, 0],
      clavicleR: [0, 0, 0.12],
      upperArmR: [-0.25, 0.1, 0.95],
      foreArmR: [-0.35, 0, 0.25],
      clavicleL: [0, 0, -0.12],
      upperArmL: [-0.3, -0.1, -1.05],
      foreArmL: [-0.4, 0, -0.3],
    },
  },
  ride: {
    root: [0, 0, 0],
    rootRot: [0, 0, 0],
    bones: {
      pelvis: [-0.12, 0, 0],
      spine01: [0.08, 0, 0],
      spine02: [0.07, 0, 0],
      spine03: [0.05, 0, 0],
      neck: [-0.08, 0, 0],
      head: [-0.06, 0, 0],
      thighR: [1.28, 0, -0.34],
      calfR: [-1.18, 0, 0],
      footR: [0.5, 0, 0],
      thighL: [1.28, 0, 0.34],
      calfL: [-1.18, 0, 0],
      footL: [0.5, 0, 0],
      clavicleR: [0, 0, 0.05],
      upperArmR: [0.95, 0.18, 0.32],
      foreArmR: [0.42, 0.2, 0],
      clavicleL: [0, 0, -0.05],
      upperArmL: [0.95, -0.18, -0.32],
      foreArmL: [0.42, -0.2, 0],
    },
  },
};

export class MountManager {
  /**
   * @param {{scene:THREE.Scene, engine:any, physics:any, bus:any, materials:any,
   *          input:any, player:any, camera:THREE.PerspectiveCamera,
   *          cameraRig?:any, avatar?:any, npcManager?:any}} ctx
   */
  constructor({
    scene, engine, physics, bus, materials, input,
    player, camera, cameraRig, avatar, npcManager, humanoidFactory,
  }) {
    this.scene = scene;
    this.engine = engine;
    this.physics = physics;
    this.bus = bus;
    this.materials = materials;
    this.input = input;
    this.player = player;
    this.camera = camera;
    this.cameraRig = cameraRig ?? null;
    this.avatar = avatar ?? null;
    this.npcManager = npcManager ?? null;
    this._externalFactory = humanoidFactory ?? null;

    /** @type {Map<string, Hoverboard|Dragon>} */
    this._mounts = new Map();
    this._active = null;
    this._prevCameraMode = null;
    this._fovKick = 0;
    this._lastBoost = false;
    this._landingFor = null;
    this._unlocked = new Set(['hoverboard', 'dragon']);

    /** Reused control block - the mount API takes it every fixed step. */
    this._ctrl = { throttle: 0, strafe: 0, yaw: 0, pitch: 0, up: 0, boost: false };
    /**
     * Dev/test override. Set fields on this object (see `?dev=1` harness use)
     * to drive a mount without pointer lock; null fields fall through to input.
     * @type {null|{throttle?:number, strafe?:number, up?:number, boost?:boolean, yaw?:number, pitch?:number}}
     */
    this.debugControl = null;

    this._rider = null;
    this._riderPose = null;
    /** Hip height of the rider proxy - how far it drops onto a saddle anchor. */
    this._riderDrop = 0.99;
    this._lean = 0;
    this._rollLean = 0;
    /** Parent-space rotation of the last solved chain's middle bone. */
    this._ikTipFrame = new THREE.Quaternion();

    // Mounts are bound to the world they were summoned in; a portal jump has to
    // take them away or they are left floating at stale coordinates.
    this._onWorldChanging = () => this.clear();
    bus.on('world:changing', this._onWorldChanging);
  }

  /* ================================================================ */
  /* Contract API                                                      */
  /* ================================================================ */

  /** @returns {Hoverboard|Dragon|null} */
  get active() {
    return this._active;
  }

  get mounted() {
    return this._active !== null;
  }

  /** Ids the player is allowed to summon. */
  get unlocked() {
    return [...this._unlocked];
  }

  /**
   * Summon a mount, or - if that mount is the one currently being ridden -
   * dismiss it. Summoning while riding something else swaps cleanly.
   * @param {'hoverboard'|'dragon'} id
   * @returns {boolean} true if a mount is being ridden afterwards
   */
  summon(id) {
    if (!this._unlocked.has(id)) return false;
    const existing = this._mounts.get(id);

    if (existing && this._active === existing) {
      this._dismount({ reason: 'dismissed' });
      existing.despawn();
      this.bus.emit('hud:notify', { text: `${existing.displayName} dismissed`, tone: 'info' });
      return false;
    }

    if (this._active) this._dismount({ reason: 'swap' });

    // Instances are kept for the session and re-spawned: rebuilding a dragon's
    // geometry on every summon would cost a visible hitch for nothing.
    let mount = existing;
    if (!mount) {
      mount = this._create(id);
      if (!mount) return false;
      this._mounts.set(id, mount);
    }
    if (!mount.alive) {
      this._placeSpawn(_sp1);
      mount.spawn(_sp1, this.player.yaw);
      this.bus.emit('mount:summoned', { id });
    }
    this._mount(mount);
    return true;
  }

  /**
   * Step off the active mount. Airborne on the dragon this instead asks it to
   * land, and the dismount completes on touchdown - dropping the player from
   * 200 m would be a bug report, not a feature.
   */
  dismount() {
    if (!this._active) return false;
    const m = this._active;
    if (!m.canDismount?.()) {
      if (this._landingFor === m) {
        // Second press: the player insists. Let them off where they are.
        this._dismount({ reason: 'forced' });
        return true;
      }
      m.requestLanding?.();
      this._landingFor = m;
      this.bus.emit('hud:notify', { text: 'Landing - [F] again to jump off', tone: 'warn' });
      return false;
    }
    this._dismount({ reason: 'dismount' });
    return true;
  }

  /** Despawn everything and hand movement back. Used on world change. */
  clear() {
    if (this._active) this._dismount({ reason: 'world', silent: true });
    // Instant, not animated: a fading mount must not survive into the world the
    // portal is already loading.
    for (const m of this._mounts.values()) m.kill();
  }

  /* ================================================================ */
  /* Frame + fixed updates                                             */
  /* ================================================================ */

  /**
   * Runs BEFORE `player.fixedUpdate` (see CONTRACTS-V2 §4), so the seat we
   * write here is what the player controller sees this step.
   */
  fixedUpdate(dt, elapsed) {
    for (const m of this._mounts.values()) {
      if (!m.alive) continue;
      const ridden = m === this._active;
      m.fixedUpdate(dt, elapsed, ridden ? this._gatherControls() : null);
    }

    const m = this._active;
    if (!m) return;

    // The dragon completes a requested landing by itself; finish the dismount
    // the moment it is safe.
    if (this._landingFor === m && m.canDismount?.()) {
      this._dismount({ reason: 'landed' });
      return;
    }

    this._applySeat(m);

    const boost = !!m.boostActive;
    if (boost !== this._lastBoost) {
      this._lastBoost = boost;
      this.bus.emit('mount:boost', { id: m.id, active: boost });
    }
  }

  /** Per-frame: keys, presentation, rider pose and the boost FOV kick. */
  update(dt, elapsed) {
    this._readKeys();

    for (const m of this._mounts.values()) m.update(dt, elapsed);

    const m = this._active;
    if (m) {
      // Re-assert the seat after the player's own frame update, so a stale
      // movementOverride can never visibly detach the rider from the mount.
      this._applySeat(m, _up1);
      this._poseRider(dt, m);
    }

    this._applyFovKick(dt, m);
  }

  /**
   * Add the boost FOV kick on top of whatever the player controller composed.
   *
   * The player only writes `camera.fov` when its own damped value actually
   * moves, so a naive `fov += kick` compounds every frame it holds still. The
   * fix is to remember the exact value we last wrote: if nobody has touched the
   * camera since, our stored base is still the truth; if the fov changed, the
   * player wrote a new base and we adopt it.
   */
  _applyFovKick(dt, mount) {
    const target = mount ? mount.fovKick : 0;
    this._fovKick = damp(this._fovKick, target, 6, dt);

    const observed = this.camera.fov;
    if (this._lastWrittenFov === undefined || Math.abs(observed - this._lastWrittenFov) > 1e-6) {
      this._baseFov = observed;
    }
    if (this._fovKick <= 0.01) {
      if (this._lastWrittenFov !== undefined) {
        // Hand the lens back exactly as we found it.
        this.camera.fov = this._baseFov;
        this.camera.updateProjectionMatrix();
        this._lastWrittenFov = undefined;
      }
      return;
    }
    const next = this._baseFov + this._fovKick;
    this.camera.fov = next;
    this._lastWrittenFov = next;
    this.camera.updateProjectionMatrix();
  }

  /* ================================================================ */
  /* Internals                                                         */
  /* ================================================================ */

  _create(id) {
    const ctx = {
      scene: this.scene,
      engine: this.engine,
      physics: this.physics,
      bus: this.bus,
      materials: this.materials,
      camera: this.camera,
    };
    if (id === 'hoverboard') return new Hoverboard(ctx);
    if (id === 'dragon') return new Dragon(ctx);
    return null;
  }

  _readKeys() {
    const input = this.input;
    if (!input || input.textCaptured) return;
    if (input.pressed('KeyH')) this.summon('hoverboard');
    else if (input.pressed('KeyG')) this.summon('dragon');
    else if (input.pressed('KeyF') && this._active) this.dismount();
  }

  /** Assemble this step's control block from input + look direction. */
  _gatherControls() {
    const c = this._ctrl;
    const s = this.input?.state;
    c.throttle = s ? s.forward : 0;
    c.strafe = s ? s.right : 0;
    c.yaw = this.player.yaw;
    c.pitch = this.player.pitch ?? 0;
    // Ctrl-as-descend rides on the crouch axis: the shared Input drops raw
    // ControlLeft keydowns (they arrive with ctrlKey set, which it treats as a
    // browser shortcut), and crouch already covers both Ctrl and C.
    c.up = (s && s.jump ? 1 : 0) - (s && s.crouch ? 1 : 0);
    c.boost = !!(s && s.sprint);

    const d = this.debugControl;
    if (d) {
      if (d.throttle !== undefined) c.throttle = d.throttle;
      if (d.strafe !== undefined) c.strafe = d.strafe;
      if (d.up !== undefined) c.up = d.up;
      if (d.boost !== undefined) c.boost = d.boost;
      if (d.yaw !== undefined) c.yaw = d.yaw;
      if (d.pitch !== undefined) c.pitch = d.pitch;
    }
    return c;
  }

  /** Somewhere clear, a couple of metres in front of the player. */
  _placeSpawn(out) {
    const p = this.player.position;
    const yaw = this.player.yaw;
    const dist = 2.6;
    out.set(p.x - Math.sin(yaw) * dist, p.y, p.z - Math.cos(yaw) * dist);
    // Probe from the player's own feet height, so a mount summoned indoors or
    // under a gantry lands on the floor the player is standing on.
    const g = this.physics.groundHeight(out.x, out.z, p.y + 1.2, 6);
    out.y = g === null ? p.y : g;
    return out;
  }

  _mount(mount) {
    this._active = mount;
    this._landingFor = null;
    this.player.movementOverride = true;
    this.player.velocity.set(0, 0, 0);

    const rig = this._rig();
    if (rig) {
      this._prevCameraMode = rig.mode ?? null;
      rig.setMode?.('third');
      // A dragon is ten metres of animal: the on-foot boom frames its shoulder
      // blades and nothing else. The mount asks for the framing it needs and
      // the hoverboard, which asks for nothing, stays exactly as punchy as it is.
      const hint = mount.cameraHint ?? null;
      rig.setMountFraming?.(hint?.scale ?? 1, hint?.lift ?? 0);
    }
    this._showAvatar(false);
    mount.onMount?.(this.player);
    this._applySeat(mount);
    this._ensureRider(mount);
    this.bus.emit('mount:mounted', { id: mount.id });
    this.bus.emit('hud:notify', { text: `${mount.displayName} engaged`, tone: 'info' });
  }

  _dismount({ reason = 'dismount', silent = false } = {}) {
    const m = this._active;
    if (!m) return;
    this._active = null;
    this._landingFor = null;
    this._lastBoost = false;
    m.onDismount?.();

    if (!silent) {
      // Step off to the side of the mount, settled onto the floor. Written
      // straight into the live position rather than through `teleport`, which
      // would zero the player's pitch and re-emit `player:spawned`.
      m.dismountPoint(_dm1);
      this.physics.resolveCapsule(_dm1, 0.35, 1.75);
      this.player.position.copy(_dm1);
      this.player.velocity.set(0, 0, 0);
    }
    this.player.movementOverride = false;

    const rig = this._rig();
    rig?.setMountFraming?.(1, 0);
    if (rig && this._prevCameraMode && this._prevCameraMode !== rig.mode) {
      rig.setMode?.(this._prevCameraMode);
    }
    this._prevCameraMode = null;
    this._showAvatar(true);
    this._detachRider();

    this.bus.emit('mount:dismounted', { id: m.id, reason });
  }

  /** Write the mount's seat onto the player, resolving against the world. */
  _applySeat(mount, scratch = _fu1) {
    mount.getSeat(scratch);
    this.player.position.copy(scratch);
    // The player's own capsule still has to fit: this is what stops a mount
    // from posting the rider through a ceiling or a wall.
    this.physics.resolveCapsule(this.player.position, 0.35, 1.55);
    this.player.velocity.copy(mount.velocity);
  }

  /* ---------------- camera rig / avatar ---------------- */

  _rig() {
    return this.cameraRig ?? this.player?.cameraRig ?? globalThis.GAME?.cameraRig ?? null;
  }

  _findAvatar() {
    return this.avatar ?? this.player?.avatar ?? globalThis.GAME?.avatar ?? null;
  }

  _showAvatar(visible) {
    const a = this._findAvatar();
    // The avatar's own animator drives a locomotion cycle from player velocity,
    // which at 24 m/s would be a sprint animation on a stationary pair of feet.
    // Hiding it and posing our own rider is the only version of this that can
    // look right without reaching into a module we do not own.
    a?.setVisible?.(visible);
  }

  /* ---------------- rider proxy ---------------- */

  _factory() {
    if (this._externalFactory) return this._externalFactory;
    const shared = this.npcManager?.factory ?? globalThis.GAME?.npcManager?.factory;
    if (shared) return shared;
    if (!this._ownFactory) {
      this._ownFactory = new HumanoidFactory({ renderer: this.engine?.renderer });
    }
    return this._ownFactory;
  }

  /**
   * Build the ridden figure once, lazily. It reuses the NPC humanoid factory so
   * the rider is the same quality of character as everyone else in the world,
   * and shares its baked textures.
   */
  _ensureRider(mount) {
    if (!this._rider) {
      try {
        const factory = this._factory();
        this._rider = factory.create({
          seed: 20260726,
          theme: 'station',
          variant: 'rig',
          height: 1.78,
          build: 1,
          hairStyle: 'short',
        });
        this._rider.root.traverse((o) => {
          if (o.isMesh || o.isSkinnedMesh) {
            o.castShadow = true;
            o.receiveShadow = true;
          }
        });
      } catch (err) {
        // A missing rider must never take the mount down with it.
        console.warn('[mounts] rider proxy unavailable:', err?.message ?? err);
        this._rider = null;
        return;
      }
    }
    mount.riderAnchor.add(this._rider.root);
    this._riderPose = mount.id === 'dragon' ? 'ride' : 'hover';

    // The humanoid's origin is the soles of its feet, but a saddle anchor marks
    // where the *pelvis* goes. Without this the whole figure hangs a hip height
    // above the tack - which is precisely the "floating rider" the seat pose was
    // blamed for: the bones were posed correctly all along, the body was simply
    // parked in mid-air where nothing it could reach was under it.
    const pelvis = this._rider.bones.get('pelvis');
    this._riderDrop = pelvis ? pelvis.position.y * (this._rider.heightScale ?? 1) : 0.99;
    mount.setRiderDrop?.(this._riderDrop);

    this._applyPose(this._riderPose, 1);
    this._lean = 0;
  }

  _detachRider() {
    this._rider?.root.removeFromParent();
    this._riderPose = null;
  }

  /** Blend the rider toward the pose for this mount, plus live lean. */
  _poseRider(dt, mount) {
    const r = this._rider;
    if (!r || !this._riderPose) return;
    if (this._riderPose === 'ride') {
      this._poseSeated(dt, mount);
      return;
    }
    const pose = POSE[this._riderPose];
    const root = r.root;
    root.position.set(pose.root[0], pose.root[1], pose.root[2]);
    root.rotation.set(pose.rootRot[0], pose.rootRot[1], pose.rootRot[2]);

    const speed01 = mount.speed01 ?? 0;
    const boost = mount.boost01 ?? 0;
    // Crouch deeper and tuck forward the faster the board goes.
    root.position.y = pose.root[1] - speed01 * 0.1 - boost * 0.06;
    root.rotation.x = pose.rootRot[0] + speed01 * 0.16 + boost * 0.12;
    const arm = 0.95 + speed01 * 0.25;
    this._setBone('upperArmR', -0.25, 0.1, arm);
    this._setBone('upperArmL', -0.3, -0.1, -arm - 0.1);
    this._setBone('calfR', -0.72 - speed01 * 0.22, 0, 0);
    this._setBone('calfL', -0.8 - speed01 * 0.22, 0, 0);
    void dt;
  }

  /**
   * Seat the rider in the dragon's harness.
   *
   * The torso is keyframed, but the limbs are *solved*: the feet are placed into
   * the stirrup irons and the hands onto the grab bar by two-bone IK against
   * the world positions the harness reports. That is the difference between a
   * pose that happens to line up with one saddle and a rider that stays in the
   * tack when the saddle moves - and the saddle moves constantly, because the
   * whole harness rides the body group that breathes, banks and recoils against
   * every wingbeat.
   *
   * @param {number} dt
   * @param {import('./Dragon.js').Dragon} mount
   */
  _poseSeated(dt, mount) {
    const r = this._rider;
    const root = r.root;
    const speed01 = mount.speed01 ?? 0;
    const boost = mount.boost01 ?? 0;
    const flap = mount.flap01 ?? 0;
    const roll = mount.bankRoll ?? 0;

    this._lean = damp(this._lean ?? 0, speed01 * 0.24 + boost * 0.26, 4, dt);
    this._rollLean = damp(this._rollLean ?? 0, clamp(roll, -0.85, 0.85), 4.5, dt);
    const lean = this._lean;
    const rl = this._rollLean;

    // Sit *down* onto the saddle, and let the legs take the wingbeat: a rider
    // welded to the seat reads as a decal, one that absorbs a couple of
    // centimetres reads as weight.
    root.position.set(0, -this._riderDrop + flap * 0.024, 0);
    root.rotation.set(0, 0, 0);

    /* ---- torso: forward over the withers, leaning into the bank ---- */
    this._setBone('pelvis', -0.10 + lean * 0.12, 0, 0);
    this._setBone('spine01', 0.10 + lean * 0.22 - flap * 0.02, rl * 0.05, -rl * 0.11);
    this._setBone('spine02', 0.09 + lean * 0.28 - flap * 0.025, rl * 0.06, -rl * 0.13);
    this._setBone('spine03', 0.06 + lean * 0.18, rl * 0.04, -rl * 0.08);
    this._setBone('neck', -0.12 - lean * 0.24, -rl * 0.06, rl * 0.09);
    this._setBone('head', -0.06 - lean * 0.14, -rl * 0.14, rl * 0.11);
    this._setBone('clavicleR', 0, 0, 0.07 + lean * 0.05);
    this._setBone('clavicleL', 0, 0, -0.07 - lean * 0.05);

    // Bone world matrices have to be current before anything is solved against
    // a world-space target, and the whole chain above the rider (harness, body,
    // bank, dragon root) may have moved this frame.
    root.updateWorldMatrix(true, true);

    /* ---- legs into the stirrups ---- */
    for (const side of [1, -1]) {
      const s = side > 0 ? 'R' : 'L';
      if (!mount.getStirrupWorld?.(side, _ikTarget)) {
        this._applyPose('ride', 1);
        break;
      }
      if (this._solveIK(`thigh${s}`, `calf${s}`, `foot${s}`, _ikTarget, side, -0.45, -0.35)) {
        // Toe forward and a shade up - a heel-down stirrup seat.
        this._aimTip(`foot${s}`, `toe${s}`, side * 0.12, -0.34 - lean * 0.1, -1);
      }
    }

    /* ---- hands onto the grab bar ---- */
    for (const side of [1, -1]) {
      const s = side > 0 ? 'R' : 'L';
      if (!mount.getGripWorld?.(side, _ikTarget)) break;
      if (this._solveIK(`upperArm${s}`, `foreArm${s}`, `hand${s}`, _ikTarget, side * 0.8, -0.5, 0.8)) {
        // The hand closes over the bar rather than continuing the forearm.
        this._setBone(`hand${s}`, 0.34, 0, side * -0.22);
      }
    }
  }

  /**
   * Analytic two-bone IK, written straight onto the bone quaternions.
   *
   * The skeleton has no per-bone orientation - every bone inherits the character
   * frame and its rest direction is simply the offset of its child - so the
   * solve is expressed entirely in rest-direction terms and works unchanged for
   * a leg (rest -Y) and an arm (rest -Y with an outward X component).
   *
   * `pole` names the side the joint bends toward, in the root bone's parent
   * space. It is what stops a knee from inverting through the saddle.
   *
   * @returns {boolean} true if the chain was solved
   */
  _solveIK(rootName, midName, tipName, targetWorld, poleX, poleY, poleZ) {
    const R = this._rider;
    const rootB = R.bones.get(rootName);
    const midB = R.bones.get(midName);
    const tipB = R.bones.get(tipName);
    if (!rootB || !midB || !tipB || !rootB.parent) return false;

    const parent = rootB.parent;
    parent.updateWorldMatrix(true, false);
    _ikT.copy(targetWorld);
    parent.worldToLocal(_ikT);
    _ikT.sub(rootB.position);

    const L1 = midB.position.length();
    const L2 = tipB.position.length();
    const d = _ikT.length();
    if (d < 1e-4 || L1 < 1e-5 || L2 < 1e-5) return false;
    _ikU.copy(_ikT).multiplyScalar(1 / d);
    // Clamped reach: an unreachable target must straighten the limb, not make
    // the law of cosines return NaN and blank the character.
    const dc = clamp(d, Math.abs(L1 - L2) + 1e-3, (L1 + L2) * 0.998);

    _ikP.set(poleX, poleY, poleZ);
    _ikP.addScaledVector(_ikU, -_ikP.dot(_ikU));
    if (_ikP.lengthSq() < 1e-8) {
      _ikP.set(-_ikU.y, _ikU.x, 0);
      if (_ikP.lengthSq() < 1e-8) _ikP.set(1, 0, 0);
    }
    _ikP.normalize();

    const cosB = clamp((L1 * L1 + dc * dc - L2 * L2) / (2 * L1 * dc), -1, 1);
    const b = Math.acos(cosB);
    _ikD1.copy(_ikU).multiplyScalar(Math.cos(b)).addScaledVector(_ikP, Math.sin(b));
    _ikD2.copy(_ikU).multiplyScalar(dc).addScaledVector(_ikD1, -L1);
    if (_ikD2.lengthSq() < 1e-10) return false;
    _ikD2.normalize();

    _ikR1.copy(midB.position).normalize();
    _ikR2.copy(tipB.position).normalize();
    _ikQ1.setFromUnitVectors(_ikR1, _ikD1);
    _ikQ2.setFromUnitVectors(_ikR2, _ikD2);
    rootB.quaternion.copy(_ikQ1);
    midB.quaternion.copy(_ikQ3.copy(_ikQ1).invert().multiply(_ikQ2));
    // Kept so `_aimTip` can express a tip direction in the same parent space.
    this._ikTipFrame.copy(_ikQ2);
    return true;
  }

  /**
   * Point a solved chain's tip bone along a direction given in the IK root's
   * parent space - used to set the foot angle in the stirrup.
   */
  _aimTip(tipName, childName, dx, dy, dz) {
    const tip = this._rider.bones.get(tipName);
    const child = this._rider.bones.get(childName);
    if (!tip || !child) return;
    _ikR1.copy(child.position);
    if (_ikR1.lengthSq() < 1e-8) return;
    _ikR1.normalize();
    _ikD1.set(dx, dy, dz).normalize();
    _ikQ1.setFromUnitVectors(_ikR1, _ikD1);
    tip.quaternion.copy(_ikQ3.copy(this._ikTipFrame).invert().multiply(_ikQ1));
  }

  _applyPose(name, weight) {
    const r = this._rider;
    if (!r) return;
    const pose = POSE[name];
    for (const boneName in pose.bones) {
      const b = r.bones.get(boneName);
      if (!b) continue;
      const t = pose.bones[boneName];
      b.rotation.set(t[0] * weight, t[1] * weight, t[2] * weight);
    }
  }

  _setBone(name, x, y, z) {
    const b = this._rider?.bones.get(name);
    if (b) b.rotation.set(x, y, z);
  }

  /* ================================================================ */
  /* Persistence (used by SaveGame)                                    */
  /* ================================================================ */

  serialize() {
    return {
      unlocked: [...this._unlocked],
      active: this._active?.id ?? null,
    };
  }

  deserialize(data) {
    if (!data) return;
    if (Array.isArray(data.unlocked) && data.unlocked.length) {
      this._unlocked = new Set(data.unlocked.filter((id) => id === 'hoverboard' || id === 'dragon'));
    }
    // Deferred: the world a save restores has to be live before a mount can be
    // placed in it, so the caller finishes this with `restorePending()`.
    if (data.active && this._unlocked.has(data.active)) this._restore = data.active;
  }

  /** Complete a deferred restore once a world is live. */
  restorePending() {
    if (!this._restore) return;
    const id = this._restore;
    this._restore = null;
    this.summon(id);
  }

  dispose() {
    this.bus.off?.('world:changing', this._onWorldChanging);
    if (this._active) this._dismount({ reason: 'dispose', silent: true });
    for (const m of this._mounts.values()) m.dispose();
    this._mounts.clear();
    this._detachRider();
    this._rider?.dispose?.();
    this._rider = null;
    this._ownFactory?.dispose?.();
    this._ownFactory = null;
  }
}
