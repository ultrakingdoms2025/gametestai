import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { NPCAnimator } from '../npc/NPCAnimator.js';

/**
 * A VISIBLE kinematic competitor: the body a minigame's pace logic wears.
 *
 * ── What this is ─────────────────────────────────────────────────────────────
 *
 * The swim challenge and the ski run both race the player against a *paced
 * distance* — a number advancing on a tuned curve (`_rivalDist`). The headers
 * of both modules promised "when a swimming NPC exists, `_rivalDist` becomes
 * the thing that drives it and nothing else changes". This is that body. It
 * owns NO pace logic and NO collider: the game module computes the distance
 * exactly as before and calls `place()` every fixed step, so the RIVAL gap on
 * the HUD and the body in the world can never disagree — they are the same
 * number.
 *
 * `race/RacerAI.js` is the precedent for the trade: a rival has to arrive at
 * the right place at the right speed and be beatable; it does not need a
 * suspension, a capsule or a brain. One skinned humanoid, three poses, zero
 * physics resolutions per step.
 *
 * ── The body ─────────────────────────────────────────────────────────────────
 *
 * The same runtime-lofted skinned humanoid every NPC wears, built by the SAME
 * `HumanoidFactory` (handed in by the caller — see `create`). The factory is
 * REQUIRED rather than constructed here as a fallback: a fresh factory means a
 * fresh `CharacterAssets`, fresh materials, and a shader compile stall on
 * first draw (the station-overhaul lesson: compile() doesn't block, DRAWING
 * does). A caller with no factory gets `null` and races the readout alone,
 * which is exactly the pre-body behaviour — measured, verified, shippable.
 *
 * ── The poses ────────────────────────────────────────────────────────────────
 *
 *  - 'swim'  — the front-crawl bone math from `player/Swim.js applyPose`
 *              (prone rig tilt + stroke cycle) at weight 1, driven by
 *              `setSpeedForAnim` instead of the player's velocity.
 *  - 'board' — the euler stance from MountManager's POSE.hover (the fallback
 *              board silhouette; the live `_poseBoard` solver needs a real
 *              mount's binding anchors, which a ghost has none of), plus a
 *              simple two-box board mesh underfoot.
 *  - 'run'   — the real `NPCAnimator` run cycle via `setLocomotion` + `update`.
 *              Foot IK probes the world when a physics handle is supplied
 *              (NPCAnimator already optional-chains `physics?.raycast`).
 *
 * Poses are applied from `update(dt)`, which the OWNING game module calls
 * from an `engine.onFrameUpdate` hook registered at match start — insertion
 * order puts it after NPCManager's and the avatar's updaters, so these bone
 * writes are the frame's final word (the Player._installLatePose argument,
 * one system over). Nothing here reads input, so the endFrame()/pressed()
 * trap cannot apply.
 *
 * ── Disposal ─────────────────────────────────────────────────────────────────
 *
 * `dispose()` removes the root from the scene, hands the humanoid's cached
 * geometry holds back through `Humanoid.dispose()` (the ref-counted contract
 * — a ghost must never free a buffer a live NPC is drawing), and frees only
 * what this module itself created: the board mesh and the tint-cloned
 * materials. Idempotent, because the game modules dispose on win/lose AND the
 * manager disposes on teardown.
 */

/* Scratch, per the physics/Physics.js convention: this module owns its own. */
const _gAxisX = new THREE.Vector3(1, 0, 0);
const _gEuler = new THREE.Euler();

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const damp = THREE.MathUtils.damp;
const wrapPi = (a) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

/** The player's cruise, from player/Swim.js SWIM_SPEED: normalises effort. */
const SWIM_CRUISE = 2.2;

/**
 * Board stance, restated from MountManager's POSE.hover (module-private
 * there, so it cannot be imported). Bone-space radians over an arms-down
 * rest; rootRot's Y is the sideways STANCE_YAW (-1.28) that puts the feet
 * across the deck, regular stance.
 */
const BOARD_STANCE = {
  root: [-0.10, -0.15, 0],
  rootRot: [-0.10, -1.28, 0],
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
};

export class GhostCompetitor {
  /**
   * Build a ghost, or null when it cannot be built — a missing factory or a
   * throwing body loft must degrade to "no body", never to a failed contest.
   *
   * @param {{ scene?:THREE.Object3D, group?:THREE.Object3D, physics?:any,
   *           factory?:any, name?:string, tint?:number, seed?:number,
   *           theme?:string }} ctx `group` (preferred) or `scene` hosts the
   *   body; `factory` is a HumanoidFactory (share the NPC manager's — see the
   *   header); `tint` marks the rival with an emissive accent on CLONED
   *   materials, never the shared ones.
   * @returns {GhostCompetitor|null}
   */
  static create(ctx = {}) {
    const host = ctx.group ?? ctx.scene ?? null;
    if (!host || typeof host.add !== 'function') return null;
    if (!ctx.factory || typeof ctx.factory.create !== 'function') return null;
    try {
      return new GhostCompetitor(ctx);
    } catch (err) {
      console.warn('[ghost] competitor body failed to build:', err?.message ?? err);
      return null;
    }
  }

  /** Use `GhostCompetitor.create` — the constructor throws on a bad loft. */
  constructor({ scene, group, physics, factory, name, tint, seed, theme } = {}) {
    this._host = group ?? scene;
    this.physics = physics ?? null;
    this.name = name ?? 'the pacesetter';

    this.humanoid = factory.create({
      seed: Number.isFinite(seed) ? seed : 1237,
      theme: theme ?? 'sports',
    });
    this.root = this.humanoid.root;
    this.root.name = `minigame:ghost:${this.name}`;

    /** @type {THREE.Material[]} tint clones this module owns and must free */
    this._tintMats = [];
    if (tint != null) this._applyTint(tint);

    this.pose = null;
    this._speed = 0;
    this._yaw = 0;
    this._targetYaw = 0;
    this._t = 0;
    /* swim state (mirrors Swim.js's) */
    this._prone = 0;
    this._strokePhase = 0;
    /* run state */
    this._animator = null;
    /* board prop */
    this._board = null;
    this._disposed = false;

    this._host.add(this.root);
  }

  /* ================================================================ */
  /* Driving surface — everything a game module calls                  */
  /* ================================================================ */

  /**
   * Choose what this competitor is doing. Switching resets the rig and every
   * bone to rest first, so a pose never inherits another's residue — the same
   * hygiene `NPCAnimator.revive` performs for the same reason.
   * @param {'swim'|'board'|'run'} kind
   */
  setPose(kind) {
    if (this._disposed || kind === this.pose) return;
    this._resetBody();
    this.pose = kind === 'swim' || kind === 'board' || kind === 'run' ? kind : null;
    if (this.pose === 'board') this._buildBoard();
    else this._removeBoard();
  }

  /**
   * Position the body. Called every fixed step by the owning game with the
   * EXACT position its pace logic computed — this method smooths nothing, so
   * the readout and the body cannot drift apart.
   * @param {{x:number,y:number,z:number}} pos world feet position
   * @param {number} heading world yaw, radians; forward is (-sin, 0, -cos)
   */
  place(pos, heading) {
    if (this._disposed || !pos) return;
    this.root.position.set(pos.x, pos.y, pos.z);
    if (Number.isFinite(heading)) this._targetYaw = heading;
  }

  /**
   * How fast the body should LOOK like it is moving, in m/s. Cosmetic only:
   * stroke rate, prone blend, run cycle. Position comes from `place` alone.
   * @param {number} v
   */
  setSpeedForAnim(v) {
    this._speed = Number.isFinite(v) && v > 0 ? v : 0;
  }

  /**
   * Animate. Call at frame rate from an `engine.onFrameUpdate` hook the game
   * registers at match start (never from a boot-registered hook — see header).
   * @param {number} dt
   * @param {number} [elapsed]
   */
  update(dt, elapsed) {
    if (this._disposed || !this.pose) return;
    this._t += dt;
    const t = Number.isFinite(elapsed) ? elapsed : this._t;

    // The heading eases so a turn at a pool wall reads as a turn, but the
    // POSITION is always exactly where place() put it.
    const d = wrapPi(this._targetYaw - this._yaw);
    this._yaw = wrapPi(this._yaw + d * (1 - Math.exp(-8 * dt)));
    this.root.rotation.y = this._yaw;

    if (this.pose === 'swim') this._poseSwim(dt);
    else if (this.pose === 'board') this._poseBoard(dt, t);
    else this._poseRun(dt, t);
  }

  /** Remove the body and free ONLY what this module created. Idempotent. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._removeBoard();
    this.root.removeFromParent();
    // Ref-counted geometry holds go back; shared materials stay shared.
    try {
      this.humanoid.dispose?.();
    } catch {
      /* a body the factory already reclaimed is not an error */
    }
    for (const m of this._tintMats) m.dispose?.();
    this._tintMats.length = 0;
    this._animator = null;
  }

  /* ================================================================ */
  /* Poses                                                             */
  /* ================================================================ */

  /** Rest everything the poses touch. */
  _resetBody() {
    const h = this.humanoid;
    h.rig?.quaternion?.identity?.();
    h.rig?.position?.set?.(0, 0, 0);
    h.rig?.rotation && (h.rig.rotation.order = 'XYZ');
    const bones = h.bones;
    if (bones?.forEach) bones.forEach((b) => b.quaternion?.identity?.());
    this._prone = 0;
    this._strokePhase = 0;
  }

  /** Bone euler write, weight 1: with no animator underneath, a set IS the pose. */
  _set(name, x, y, z) {
    const bone = this.humanoid.bones?.get?.(name);
    if (!bone) return;
    _gEuler.set(x, y, z);
    bone.quaternion.setFromEuler(_gEuler);
  }

  /**
   * Front crawl — the bone math of `Swim.js applyPose` at weight 1, with
   * `_speed` standing in for the player's planar velocity. Kept numerically
   * in step with that file on purpose: the two swimmers share a pool, and a
   * rival stroking differently from the player would read as a different
   * mechanic, not a different athlete.
   */
  _poseSwim(dt) {
    const h = this.humanoid;
    const moving = clamp(this._speed / SWIM_CRUISE, 0, 1);
    const proneTarget = 0.30 + moving * 0.95;
    this._prone = damp(this._prone, proneTarget, 5, dt);
    const tilt = this._prone;

    // Negative X about the feet takes the head from up (+Y) to forward (-Z);
    // the lift re-floats the chest, because the rotation pivots on the feet.
    h.rig.quaternion.setFromAxisAngle(_gAxisX, -tilt);
    h.rig.position.y = Math.sin(tilt) * 0.72;

    this._strokePhase += dt * (0.85 + moving * 1.55);
    const ph = this._strokePhase * Math.PI * 2;

    for (const side of [1, -1]) {
      const s = side > 0 ? 'R' : 'L';
      const phase = ph + (side > 0 ? 0 : Math.PI);
      const swing = Math.sin(phase);
      const arm = 1.45 + swing * 1.35;
      const recovery = clamp(swing, 0, 1);
      this._set(`clavicle${s}`, 0, 0, -0.12 * side * (0.4 + recovery * 0.6));
      this._set(`upperArm${s}`, arm, 0, side * (0.32 + recovery * 0.3));
      this._set(`foreArm${s}`, 0.35 + recovery * 0.75, 0, side * 0.12);
      this._set(`hand${s}`, 0.1, 0, 0);
    }

    const kick = Math.sin(ph * 1.6);
    for (const side of [1, -1]) {
      const s = side > 0 ? 'R' : 'L';
      const k = side > 0 ? kick : -kick;
      const amp = 0.24 + moving * 0.26;
      this._set(`thigh${s}`, k * amp + 0.06, 0, side * 0.05);
      this._set(`calf${s}`, -Math.max(0, k) * amp * 1.9 - 0.12, 0, 0);
      this._set(`foot${s}`, 0.42 + k * 0.18, 0, 0);
    }

    // Arch against the prone tilt: lifts the face out of the water.
    const lift = tilt * 0.42;
    this._set('spine01', -lift * 0.32, 0, 0);
    this._set('spine02', -lift * 0.34, 0, 0);
    this._set('spine03', -lift * 0.34, 0, 0);
    this._set('neck', -lift * 0.5, 0, 0);
    this._set('head', -lift * 0.55, 0, 0);
  }

  /** The board stance, plus a hover bob so a waiting rider is not a statue. */
  _poseBoard(dt, t) {
    const h = this.humanoid;
    const p = BOARD_STANCE;
    // Speed presses the crouch a shade deeper, as riding does.
    const crouch = clamp01(this._speed / 10) * 0.05;
    h.rig.position.set(p.root[0], p.root[1] - crouch + Math.sin(t * 2.1) * 0.012, p.root[2]);
    h.rig.rotation.order = 'XYZ';
    h.rig.rotation.set(p.rootRot[0], p.rootRot[1], p.rootRot[2]);
    for (const name in p.bones) {
      const b = h.bones?.get?.(name);
      if (!b) continue;
      const e = p.bones[name];
      b.rotation.set(e[0], e[1], e[2]);
    }
    if (this._board) this._board.position.y = Math.sin(t * 2.1) * 0.012;
    void dt;
  }

  /** The real run cycle: NPCAnimator drives every bone, foot IK included. */
  _poseRun(dt, elapsed) {
    if (!this._animator) {
      try {
        this._animator = new NPCAnimator({
          humanoid: this.humanoid,
          physics: this.physics,
          seed: 97,
        });
      } catch (err) {
        // A stub humanoid (tests) cannot carry the animator; stand still.
        console.warn('[ghost] run animator unavailable:', err?.message ?? err);
        this.pose = null;
        return;
      }
    }
    this._animator.setLocomotion(this._speed, 0);
    this._animator.update(dt, elapsed, { ik: !!this.physics });
  }

  /* ================================================================ */
  /* Props and paint                                                   */
  /* ================================================================ */

  /**
   * Two merged boxes under the feet: a deck and a nose kick. Child of the
   * ROOT, not the rig — the rig is turned sideways into the stance, and the
   * board must stay aligned with travel. Proportions match Hoverboard's
   * DECK_LENGTH/DECK_WIDTH so the two boards read as the same class of thing.
   */
  _buildBoard() {
    if (this._board) return;
    const deck = new THREE.BoxGeometry(0.46, 0.08, 1.5);
    deck.translate(0, -0.22, 0.08);
    const kick = new THREE.BoxGeometry(0.4, 0.06, 0.4);
    kick.rotateX(-0.42);
    kick.translate(0, -0.16, -0.78);
    const geo = mergeGeometries([deck, kick]);
    deck.dispose();
    kick.dispose();
    const mat = new THREE.MeshStandardMaterial({ color: 0x23303c, roughness: 0.5, metalness: 0.25 });
    this._board = new THREE.Mesh(geo, mat);
    this._board.castShadow = false;
    this._board.receiveShadow = false;
    this.root.add(this._board);
  }

  _removeBoard() {
    if (!this._board) return;
    this._board.removeFromParent();
    this._board.geometry?.dispose?.();
    this._board.material?.dispose?.();
    this._board = null;
  }

  /**
   * Mark the rival with an emissive accent on CLONED materials. Cloning is
   * mandatory — the originals are shared through CharacterAssets and painting
   * them would recolour every NPC drawing them. A clone keeps the identical
   * shader configuration, so it reuses the already-compiled program (the
   * RacerAI livery argument) and costs no stall.
   * @param {number} tint
   */
  _applyTint(tint) {
    const clones = new Map();
    this.root.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const remap = (m) => {
        if (!m || !m.isMaterial) return m;
        let c = clones.get(m);
        if (!c) {
          c = m.clone();
          if (c.emissive) {
            c.emissive.set(tint);
            c.emissiveIntensity = Math.max(c.emissiveIntensity ?? 0, 0.16);
          }
          clones.set(m, c);
          this._tintMats.push(c);
        }
        return c;
      };
      o.material = Array.isArray(o.material) ? o.material.map(remap) : remap(o.material);
    });
  }
}

export default GhostCompetitor;
