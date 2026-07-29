import * as THREE from 'three';
import { Hoverboard } from './Hoverboard.js';
import { Dragon } from './Dragon.js';
import { Car } from './Car.js';
import { Horse } from './Horse.js';
import { Eagle } from './Eagle.js';
import { characterCreateParams, applyCharacterColors } from '../player/PlayerAvatar.js';
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
/* `_poseBoard` only. */
const _bdTarget = new THREE.Vector3();
const _bdLocal = new THREE.Vector3();

const damp = THREE.MathUtils.damp;
const clamp = THREE.MathUtils.clamp;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Board stance geometry, in deck space.
 *
 * A board is ridden SIDEWAYS. `STANCE_YAW` turns the rider off the board's
 * forward axis until the feet lie across the deck: -PI/2 would be dead
 * perpendicular, and this sits a little open of that so the hips are already
 * carrying some of the twist toward the nose. Regular stance - the LEFT foot
 * leads, into the nose binding - which is what falls out of a negative yaw:
 * the character's left hip ends up over the nose and its right over the tail.
 *
 * `TOE_*` are the binding angles, measured in deck space from the toe edge
 * (+X) toward the nose (-Z): the leading foot is toed out ~18 degrees, the back
 * foot sits a shade the other way. Real bindings are set exactly like this.
 */
const STANCE_YAW = -1.28;
const FRONT_TOE_X = 0.951;
const FRONT_TOE_Z = -0.309;
const BACK_TOE_X = 0.999;
const BACK_TOE_Z = 0.052;

/** Rider poses, in bone-space radians. Rest pose is arms-down, legs straight. */
const POSE = {
  /**
   * Board stance. Fallback silhouette ONLY - `_poseBoard` solves the feet onto
   * the deck bindings and drives every one of these values live. It is kept so
   * a board that reports no binding anchors still reads as a rider rather than
   * the arms-out T-pose this used to be: the old values were a standing figure
   * with a 35-degree turn and near-horizontal arms, which is exactly what was
   * reported.
   */
  hover: {
    root: [-0.10, -0.15, 0],
    rootRot: [-0.10, STANCE_YAW, 0],
    bones: {
      pelvis: [-0.10, 0, 0],
      spine01: [-0.10, 0.10, 0],
      spine02: [-0.09, 0.10, 0],
      spine03: [-0.06, 0.08, 0],
      neck: [0.20, 0.34, 0],
      head: [0.12, 0.50, 0],
      thighR: [0.66, 0.34, -0.30],
      calfR: [-1.06, 0, 0],
      footR: [0.44, 0, 0],
      thighL: [0.66, -0.34, 0.30],
      calfL: [-1.06, 0, 0],
      footL: [0.44, 0, 0],
      clavicleR: [0, 0, 0.10],
      upperArmR: [-0.18, 0.05, 0.62],
      foreArmR: [0.45, 0.10, 0.22],
      clavicleL: [0, 0, -0.10],
      upperArmL: [0.34, -0.05, -0.66],
      foreArmL: [0.40, -0.10, -0.26],
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
  /**
   * Behind the wheel. Legs forward into the footwell rather than astride,
   * elbows dropped, torso upright against a bucket seat back. This is only the
   * fallback silhouette - the limbs are solved onto the pedals and the wheel
   * rim, exactly as the dragon's are solved onto its stirrups and grab bar.
   */
  drive: {
    root: [0, 0, 0],
    rootRot: [0, 0, 0],
    bones: {
      pelvis: [-0.06, 0, 0],
      spine01: [0.05, 0, 0],
      spine02: [0.04, 0, 0],
      spine03: [0.03, 0, 0],
      neck: [-0.05, 0, 0],
      head: [-0.04, 0, 0],
      thighR: [1.42, 0, -0.14],
      calfR: [-0.92, 0, 0],
      footR: [0.36, 0, 0],
      thighL: [1.42, 0, 0.14],
      calfL: [-0.92, 0, 0],
      footL: [0.36, 0, 0],
      clavicleR: [0, 0, 0.06],
      upperArmR: [1.05, 0.14, 0.30],
      foreArmR: [0.5, 0.22, 0],
      clavicleL: [0, 0, -0.06],
      upperArmL: [1.05, -0.14, -0.30],
      foreArmL: [0.5, -0.22, 0],
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

    /** @type {Map<string, Hoverboard|Dragon|Car>} */
    this._mounts = new Map();
    this._active = null;
    this._prevCameraMode = null;
    this._fovKick = 0;
    this._lastBoost = false;
    this._landingFor = null;
    this._unlocked = new Set(['hoverboard', 'dragon', 'car', 'horse', 'eagle']);

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
    /**
     * Board-stance measurements, taken off the rider that was actually built
     * (see `_measureRider`). Defaults are the 1.78 m proxy, so a rider whose
     * bones could not be read still crouches to a sane depth.
     */
    this._boardHipY = 0.97;
    this._boardHipX = 0.097;
    this._boardAnkleY = 0.10;
    this._boardLegLen = 0.87;
    this._boardSquat = 0;
    this._boardYaw = 0;
    /** Parent-space rotation of the last solved chain's middle bone. */
    this._ikTipFrame = new THREE.Quaternion();

    // Mounts are bound to the world they were summoned in; a portal jump has to
    // take them away or they are left floating at stale coordinates.
    this._onWorldChanging = () => this.clear();
    bus.on('world:changing', this._onWorldChanging);

    // Whoever the player decides to be, the figure on the mount is the same
    // person. Rebuilt lazily on the next mount rather than on every slider move.
    this._onCharacterChanged = () => this.invalidateRider();
    bus.on('character:changed', this._onCharacterChanged);
  }

  /* ================================================================ */
  /* Contract API                                                      */
  /* ================================================================ */

  /**
   * The player's chosen character, or null before one exists. Read through the
   * avatar so there is a single source of truth for who the player looks like.
   */
  _characterConfig() {
    return (
      this.avatar?.characterConfig ??
      this.player?.avatar?.characterConfig ??
      globalThis.GAME?.avatar?.characterConfig ??
      null
    );
  }

  /**
   * Drop the cached rider so it is rebuilt from the new config on the next
   * mount. Rebuilding immediately would pay for a skinned character every time
   * a colour slider moves.
   */
  invalidateRider() {
    const r = this._rider;
    if (!r) return;
    if (this._active) return; // mid-ride: leave the figure alone until dismount
    try { r.root?.parent?.remove(r.root); r.dispose?.(); } catch { /* non-fatal */ }
    this._rider = null;
  }

  /** @returns {Hoverboard|Dragon|Car|null} */
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
   * @param {'hoverboard'|'dragon'|'car'} id
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
      this._placeSpawn(_sp1, mount);
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
    if (id === 'car') return new Car(ctx);
    // The eagle needs the player: beating its wings costs stamina, and stamina
    // lives on the player rather than on the mount.
    if (id === 'horse') return new Horse(ctx);
    if (id === 'eagle') return new Eagle({ ...ctx, player: this.player });
    return null;
  }

  /**
   * Build every mount and the rider proxy up front, without spawning or
   * mounting anything.
   *
   * A dragon costs ~235 ms of geometry to construct and, far worse, its
   * materials only compile the first time they reach the renderer - which was
   * happening mid-game on the first `G` press and stalling the frame for
   * seconds. Constructing here and parking each root in the scene (hidden) lets
   * the boot-time `compileAsync` see the materials and pay that cost behind the
   * loading screen instead.
   *
   * The car has a second reason to be here: its headlight is a real light, and
   * Three keys its shader program cache on light *counts*. The car creates that
   * light in its constructor and never removes it, so building the car behind
   * the loading screen is what keeps the count constant for the rest of the
   * session. Skip it here and the first `J` press pays a full recompile.
   *
   * @param {string[]} ids Mount ids to build.
   * @returns {THREE.Object3D[]} Roots that were parked, for the caller to unpark.
   */
  prebuild(ids = ['hoverboard', 'dragon', 'car', 'horse', 'eagle']) {
    const parked = [];
    for (const id of ids) {
      if (this._mounts.has(id)) continue;
      let mount = null;
      try {
        mount = this._create(id);
      } catch (err) {
        console.warn(`[mounts] prebuild of "${id}" failed:`, err?.message ?? err);
        continue;
      }
      if (!mount) continue;
      this._mounts.set(id, mount);
      try {
        this._ensureRider(mount);
      } catch { /* rider is optional - never block the prebuild on it */ }
      const root = mount.root ?? mount.mesh;
      if (root && !root.parent) {
        root.visible = false;
        this.scene.add(root);
        parked.push(root);
      }
    }
    return parked;
  }

  /**
   * Remove roots parked by `prebuild` once their shaders are compiled.
   *
   * The warmup does not merely render the parked mounts - it summons and
   * dismounts each one, which leaves them *alive*. `summon` only calls `spawn`
   * on a mount that is not alive, so an alive mount whose root has just been
   * pulled out of the scene would be mounted invisible, at stale coordinates,
   * on the player's first real press. Killing them here returns every mount to
   * the state a cold boot would have left it in.
   */
  unpark(roots) {
    for (const m of this._mounts.values()) {
      if (m !== this._active && m.alive) m.kill();
    }
    for (const r of roots ?? []) {
      if (r?.parent === this.scene) this.scene.remove(r);
    }
  }

  _readKeys() {
    const input = this.input;
    if (!input || input.textCaptured) return;
    if (input.pressed('KeyH')) this.summon('hoverboard');
    else if (input.pressed('KeyG')) this.summon('dragon');
    else if (input.pressed('KeyJ')) this.summon('car');
    else if (input.pressed('KeyX')) this.summon('horse');
    /* Z, not C. C is hold-to-crouch, so binding the eagle to it meant every
     * crouch summoned or dismissed a bird - and worse, made C unusable as the
     * crouch key that composes with movement, which is the only one that does.
     * Z sits next to X, which is the horse. */
    else if (input.pressed('KeyZ')) this.summon('eagle');
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

  /**
   * Somewhere clear, in front of the player. The distance is the mount's to
   * choose: a hoverboard drops at the player's feet, a 4.3 m car cannot.
   */
  _placeSpawn(out, mount = null) {
    const p = this.player.position;
    const yaw = this.player.yaw;
    const dist = mount?.spawnDistance ?? 2.6;
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
    // The mount itself rides along: a weapon that needs to fire from the
    // creature rather than from the rider's hand has no other way to reach it,
    // and Loadout is built before MountManager so it cannot be injected.
    this.bus.emit('mount:mounted', { id: mount.id, mount });
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
        // The rider is the player, so it has to be built from whatever the
        // character menu chose - otherwise mounting turned you back into the
        // default man. `characterCreateParams` is the same translation
        // `PlayerAvatar` uses, so the two figures cannot drift apart.
        const cfg = this._characterConfig();
        this._rider = factory.create(
          cfg ? characterCreateParams(cfg) : {
            seed: 20260726, theme: 'station', variant: 'rig',
            height: 1.78, build: 1, hairStyle: 'short',
          }
        );
        if (cfg) {
          try {
            applyCharacterColors(this._rider, factory.assets ?? this._assets, cfg);
          } catch (err) {
            console.warn('[mounts] rider colours unavailable:', err?.message ?? err);
          }
        }
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
    this._riderPose = mount.riderPose ?? (mount.id === 'dragon' ? 'ride' : 'hover');

    // The humanoid's origin is the soles of its feet, but a saddle anchor marks
    // where the *pelvis* goes. Without this the whole figure hangs a hip height
    // above the tack - which is precisely the "floating rider" the seat pose was
    // blamed for: the bones were posed correctly all along, the body was simply
    // parked in mid-air where nothing it could reach was under it.
    const pelvis = this._rider.bones.get('pelvis');
    this._riderDrop = pelvis ? pelvis.position.y * (this._rider.heightScale ?? 1) : 0.99;
    mount.setRiderDrop?.(this._riderDrop);
    this._measureRider();

    this._applyPose(this._riderPose, 1);
    this._lean = 0;
    this._rollLean = 0;
    this._boardSquat = 0;
  }

  /**
   * Measure the rider's leg once, so the board stance can be *derived* instead
   * of guessed.
   *
   * Bone positions are in unscaled character units and the root carries
   * `heightScale`, so everything is scaled here into the metres the mount
   * anchors are expressed in. Knowing the hip height, the hip offset, the ankle
   * height and the total leg length is enough to solve the exact crouch depth
   * at which a given pair of bindings is reachable - which is why changing the
   * rider's height, or the board's stance width, needs no re-tuning.
   */
  _measureRider() {
    const r = this._rider;
    if (!r) return;
    const s = r.heightScale ?? 1;
    const pelvis = r.bones.get('pelvis');
    const thigh = r.bones.get('thighR');
    const calf = r.bones.get('calfR');
    const foot = r.bones.get('footR');
    if (!pelvis || !thigh || !calf || !foot) return;
    this._boardHipY = (pelvis.position.y + thigh.position.y) * s;
    this._boardHipX = Math.abs(thigh.position.x) * s;
    this._boardAnkleY =
      (pelvis.position.y + thigh.position.y + calf.position.y + foot.position.y) * s;
    this._boardLegLen = (calf.position.length() + foot.position.length()) * s;
  }

  _detachRider() {
    const root = this._rider?.root;
    if (root) {
      root.removeFromParent();
      // `_poseBoard` switches the root to YXZ; hand it back the way every other
      // consumer of this proxy expects to find it.
      root.rotation.order = 'XYZ';
    }
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
    if (this._riderPose === 'drive') {
      this._poseDriver(dt, mount);
      return;
    }
    if (this._riderPose === 'hover') {
      this._poseBoard(dt, mount);
      return;
    }
    const pose = POSE[this._riderPose];
    const root = r.root;
    root.position.set(pose.root[0], pose.root[1], pose.root[2]);
    root.rotation.set(pose.rootRot[0], pose.rootRot[1], pose.rootRot[2]);
    void dt;
    void mount;
  }

  /**
   * Ride the hoverboard.
   *
   * Same architecture as `_poseSeated`: torso keyframed, legs *solved*. The
   * feet are placed into the deck's two bindings by two-bone IK against the
   * world positions the board reports through `getFootWorld`, so the stance
   * survives the deck pitching over a kerb, banking into a carve and bobbing on
   * its hover spring - none of which a keyframed pose can follow.
   *
   * The three things that make it read as riding rather than standing:
   *
   * 1. The rider is turned SIDEWAYS (`STANCE_YAW`) so the feet lie across the
   *    board, leading foot into the nose binding, and the twist back toward the
   *    direction of travel is spent up the spine and neck - hips least, head
   *    most, exactly as a real rider carries it.
   * 2. The crouch is not a number: the ride height is *derived* from where the
   *    bindings are, so the legs are always folded to the depth that actually
   *    reaches them. Deepen the squat and the whole body drops onto the deck
   *    with the feet still planted.
   * 3. Everything moves. Carve, boost, speed and the board's own suspension
   *    load each push the crouch, the lean and the arms.
   *
   * @param {number} dt
   * @param {import('./Hoverboard.js').Hoverboard} mount
   */
  _poseBoard(dt, mount) {
    const r = this._rider;
    const root = r.root;

    const speed01 = mount.speed01 ?? 0;
    const boost = mount.boost01 ?? 0;
    const carve = clamp(mount.carve01 ?? 0, -1, 1);
    const susp = clamp(mount.suspension ?? 0, -1, 1);

    /* ---- damped ride signals ---- */
    this._lean = damp(this._lean ?? 0, clamp01(speed01 * 0.55 + boost * 0.45), 3.5, dt);
    this._rollLean = damp(this._rollLean ?? 0, carve, 6, dt);
    // Bumps are swallowed fast and released slowly - that asymmetry is what
    // reads as absorbing rather than bouncing.
    const squatTarget = clamp01(
      speed01 * 0.30 + boost * 0.40 + Math.abs(carve) * 0.34 + susp * 0.45
    );
    const prev = this._boardSquat ?? 0;
    this._boardSquat = damp(prev, squatTarget, squatTarget > prev ? 14 : 5, dt);

    const lean = this._lean;
    const cv = this._rollLean;
    const squat = this._boardSquat;

    /* ---- stance: sideways on the deck, opening toward travel with speed ---- */
    const yaw = STANCE_YAW + lean * 0.13 + cv * 0.08;
    // Positive root X leans the figure BACK (the character's up tilts toward
    // +Z). A heel-side carve is ridden sitting back over the heels; speed and
    // boost tuck it the other way, forward over the nose.
    const pitch = -0.08 + cv * 0.22 - lean * 0.20 - squat * 0.07;
    // YXZ, not the default XYZ: the yaw has to be the OUTER rotation or the
    // lean and roll end up applied about the deck's axes instead of the
    // rider's own, and a sideways figure would tip toward the nose when it was
    // asked to tip toward its toes.
    root.rotation.order = 'YXZ';
    root.rotation.set(pitch, yaw, -cv * 0.06);
    this._boardYaw = yaw;

    /* ---- ride height: crouch until the legs reach the bindings ---- */
    // Weight moves onto the edge being carved.
    const rootX = -cv * 0.035;
    const reach = clamp(0.86 - squat * 0.22, 0.55, 0.95);
    let rootY = -(this._riderDrop ?? 0.99) * 0.15;
    if (mount.getFootLocal?.(1, _bdLocal)) {
      // Hip of the back leg, in deck space, with the stance yaw applied.
      const hx = rootX + this._boardHipX * Math.cos(yaw);
      const hz = -this._boardHipX * Math.sin(yaw);
      const dx = hx - _bdLocal.x;
      const dz = hz - _bdLocal.z;
      const d = this._boardLegLen * reach;
      // Never square-root a negative: an over-wide stance just straightens the
      // leg instead of blanking the character.
      const vert = Math.sqrt(Math.max(0.0025, d * d - dx * dx - dz * dz));
      rootY = _bdLocal.y + this._boardAnkleY + vert - this._boardHipY;
    }
    root.position.set(rootX, rootY, 0);

    /* ---- torso: folded forward, twisted toward the nose, weight on an edge ---- */
    const twist = 0.13 + lean * 0.06;
    this._setBone('pelvis', -0.09 - lean * 0.04 + cv * 0.05, 0, cv * 0.05);
    this._setBone('spine01', -0.10 - lean * 0.08, twist, cv * 0.07);
    this._setBone('spine02', -0.09 - lean * 0.08, twist, cv * 0.08);
    this._setBone('spine03', -0.06 - lean * 0.05, twist * 0.8, cv * 0.05);
    this._setBone('clavicleR', 0, 0, 0.10 + lean * 0.05);
    this._setBone('clavicleL', 0, 0, -0.10 - lean * 0.05);

    // Look down the board, not across it: whatever twist the spine has not
    // already spent is paid off by the neck and head, so the rider is always
    // watching where it is going however far the hips are turned.
    const spineTwist = twist * 2.8;
    const rem = clamp(-0.14 - (yaw + spineTwist), -1.0, 1.0);
    // How far the spine and root together folded forward - the neck and head
    // pay it back so the gaze stays level however deep the tuck goes.
    const tuck = -(0.25 + lean * 0.21) + pitch;
    this._setBone('neck', -tuck * 0.55 + cv * 0.05, rem * 0.42, -cv * 0.06);
    this._setBone('head', -tuck * 0.45 - 0.04, rem * 0.58, -cv * 0.09);

    /* ---- arms: out and forward for balance, counter-rotating into carves ---- */
    // The leading (left) arm reaches over the nose, the trailing arm sits back
    // over the tail, and the pair swap as the board is turned - that counter
    // swing is most of what sells a carve.
    const spread = 0.64 + lean * 0.10 + squat * 0.14;
    this._setBone('upperArmR', -0.16 - cv * 0.32 - lean * 0.08, 0.05, spread);
    this._setBone('foreArmR', 0.62 + squat * 0.20, 0.14, 0.24);
    this._setBone('handR', 0.14, 0, -0.10);
    this._setBone('upperArmL', 0.40 + cv * 0.32 + lean * 0.12, -0.05, -spread - 0.05);
    this._setBone('foreArmL', 0.56 + squat * 0.20, -0.14, -0.28);
    this._setBone('handL', 0.14, 0, 0.10);

    // Bone world matrices have to be current before anything is solved against
    // a world-space target, and the deck under the rider moved this frame.
    root.updateWorldMatrix(true, true);

    /* ---- feet into the bindings ---- */
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    for (const side of [1, -1]) {
      const s = side > 0 ? 'R' : 'L';
      if (!mount.getFootWorld?.(side, _bdTarget, this._boardAnkleY)) {
        this._applyPose('hover', 1);
        break;
      }
      // Knees forward over the toes and slightly apart. Without the pole a deep
      // board crouch is free to fold the knee backwards through the deck.
      if (this._solveIK(`thigh${s}`, `calf${s}`, `foot${s}`, _bdTarget, side * 0.30, 0.20, -1)) {
        // Binding angles are a property of the BOARD, so they are stated in
        // deck space and rotated back through the stance yaw - that is what
        // keeps the boots planted while the torso twists over them.
        const bx = side > 0 ? BACK_TOE_X : FRONT_TOE_X;
        const bz = side > 0 ? BACK_TOE_Z : FRONT_TOE_Z;
        const dx = bx * cy - bz * sy;
        const dz = bx * sy + bz * cy;
        // Sole flat on the deck: cancel the body's own forward lean out of the
        // toe direction, or the boots pitch with the chest.
        this._aimTip(`foot${s}`, `toe${s}`, dx, pitch * dz - 0.04, dz);
      }
    }
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
   * Seat the rider behind the wheel.
   *
   * Structurally identical to `_poseSeated`: torso keyframed, limbs *solved*.
   * The car reports its pedal ankle rests through `getStirrupWorld` and its
   * steering wheel grips through `getGripWorld` for exactly this reason - the
   * grips are parented to the rim, so turning the wheel drags the hands round
   * with it instead of leaving them hanging in the air where the rim used to
   * be. A keyframed driving pose cannot do that, and it is the difference
   * between a driver and a mannequin.
   *
   * @param {number} dt
   * @param {import('./Car.js').Car} mount
   */
  _poseDriver(dt, mount) {
    const r = this._rider;
    const root = r.root;
    const accel = mount.accel01 ?? 0;
    const speed01 = mount.speed01 ?? 0;
    const roll = mount.bankRoll ?? 0;

    // Brace against the seat under power, forward against the belts under
    // brakes, and lean into the corner the body is already rolling out of.
    this._lean = damp(this._lean ?? 0, -accel * 0.16 + speed01 * 0.05, 5, dt);
    this._rollLean = damp(this._rollLean ?? 0, clamp(roll, -0.4, 0.4), 5, dt);
    const lean = this._lean;
    const rl = this._rollLean;

    root.position.set(0, -this._riderDrop, 0);
    root.rotation.set(0, 0, 0);

    /* ---- torso: upright in the bucket, weight moving with the car ---- */
    this._setBone('pelvis', -0.06 + lean * 0.08, 0, 0);
    this._setBone('spine01', 0.05 + lean * 0.16, rl * 0.06, -rl * 0.10);
    this._setBone('spine02', 0.04 + lean * 0.18, rl * 0.07, -rl * 0.12);
    this._setBone('spine03', 0.03 + lean * 0.12, rl * 0.05, -rl * 0.07);
    this._setBone('neck', -0.06 - lean * 0.16, -rl * 0.08, rl * 0.08);
    this._setBone('head', -0.03 - lean * 0.10, -rl * 0.18, rl * 0.10);
    this._setBone('clavicleR', 0, 0, 0.06 + lean * 0.04);
    this._setBone('clavicleL', 0, 0, -0.06 - lean * 0.04);

    // Everything above the rider - cabin, body roll, chassis pitch - may have
    // moved this frame, and a world-space solve needs current matrices.
    root.updateWorldMatrix(true, true);

    /* ---- feet onto the pedals ---- */
    for (const side of [1, -1]) {
      const s = side > 0 ? 'R' : 'L';
      if (!mount.getStirrupWorld?.(side, _ikTarget)) {
        this._applyPose('drive', 1);
        break;
      }
      // Knees up and forward: the pole is what stops a seated leg solving with
      // the joint bent backwards through the seat base.
      if (this._solveIK(`thigh${s}`, `calf${s}`, `foot${s}`, _ikTarget, side * 0.16, 0.85, -0.5)) {
        this._aimTip(`foot${s}`, `toe${s}`, side * 0.05, -0.55, -0.84);
      }
    }

    /* ---- hands onto the wheel rim ---- */
    for (const side of [1, -1]) {
      const s = side > 0 ? 'R' : 'L';
      if (!mount.getGripWorld?.(side, _ikTarget)) break;
      if (this._solveIK(`upperArm${s}`, `foreArm${s}`, `hand${s}`, _ikTarget, side * 0.9, -0.75, 0.55)) {
        // The hand closes over the rim rather than continuing the forearm.
        this._setBone(`hand${s}`, 0.30, 0, side * -0.28);
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
      const known = new Set(['hoverboard', 'dragon', 'car', 'horse', 'eagle']);
      this._unlocked = new Set(data.unlocked.filter((id) => known.has(id)));
      // A save written before a mount existed must not lock it away for good.
      // This is the same reason the car was force-added when it landed, and it
      // now generalises rather than needing a line per mount.
      for (const id of known) this._unlocked.add(id);
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
