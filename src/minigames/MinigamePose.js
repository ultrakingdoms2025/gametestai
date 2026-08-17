import * as THREE from 'three';
import { MINIGAME_STATE } from './MinigameManager.js';

/**
 * The two poses a contest needs: the set position, and the finish.
 *
 * ── Why this is a fourth late-pose module and not an animation ───────────────
 *
 * There are no animation clips in this project and no mixer. `Humanoid.js`
 * builds a 26-bone skeleton and `NPCAnimator` computes every pose procedurally,
 * frame by frame, so a new animation is a function that writes bone rotations -
 * see `player/Swim.js applyPose`, which this file follows line for line.
 *
 * ── Why it cannot run from `update()` ────────────────────────────────────────
 *
 * `PlayerAvatar.update()` rewrites every bone each frame and runs after the
 * player in main.js's frame order, so anything written from a normal update is
 * silently thrown away. `Player._installLatePose` registers a frame callback
 * that lands AFTER the avatar has posed, and this is the fourth module in it,
 * behind swim, free-climb and mantle - last, so on the frames where it has
 * weight it is the final word.
 *
 * ── Sharing the rig with Swim ────────────────────────────────────────────────
 *
 * `Swim.applyPose` owns `humanoid.rig` while it has weight: it rotates the
 * whole body prone and lifts it back off its own ankles. Fighting it would make
 * a swimmer twitch, and stealing the rig would leave the body tilted on dry
 * land, because whoever writes it is responsible for putting it back.
 *
 * So the rule is: this module writes the rig ONLY when the swim pose has no
 * weight, and restores it itself when its own weight goes. In the water it
 * writes bones alone - which is exactly right for a finish, because punching
 * the air at the wall is a thing a prone swimmer does without standing up.
 */

const damp = THREE.MathUtils.damp;
const clamp = THREE.MathUtils.clamp;

/** Seconds the finish pose holds before releasing back to normal movement. */
const FINISH_HOLD_S = 4.0;
/** Below this, Swim owns the rig and this module leaves it alone. */
const SWIM_RIG_EPS = 0.02;

/* Scratch, per the convention in physics/Physics.js: each module owns its own. */
const _axis = new THREE.Vector3(1, 0, 0);
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

export class MinigamePose {
  /**
   * @param {{ player:any, minigames:import('./MinigameManager.js').MinigameManager }} ctx
   */
  constructor({ player, minigames }) {
    this.player = player ?? null;
    this.minigames = minigames ?? null;

    this._weight = 0;
    this._applied = false;
    this._rigApplied = false;
    this._rigTilt = 0;
    this._phase = 0;
    /** Seconds since the contest finished; drives the hold on the finish pose. */
    this._sinceFinish = 0;
    this._lastState = MINIGAME_STATE.IDLE;
    /** 1 for a win, -1 for a loss, 0 when there is nothing to react to. */
    this._verdict = 0;
  }

  /**
   * @param {number} dt
   * @param {number} elapsed
   */
  applyPose(dt, elapsed) {
    const mg = this.minigames;
    const avatar = this.player?.avatar;
    const humanoid = avatar?.humanoid;
    if (!humanoid) return;

    const state = mg?.state ?? MINIGAME_STATE.IDLE;
    if (state !== this._lastState) {
      if (state === MINIGAME_STATE.FINISHED) {
        this._sinceFinish = 0;
        this._verdict = mg?.result?.won ? 1 : -1;
      } else {
        // Any other transition - including an abort straight out of PLAYING -
        // means there is no result to react to, so the hold ends immediately.
        this._verdict = 0;
      }
      this._lastState = state;
    }
    if (state === MINIGAME_STATE.FINISHED) this._sinceFinish += dt;

    /* The swim pose's own blend weight, not "is the player swimming": it decays
     * over about a fifth of a second after leaving the water, and taking the rig
     * back before it has finished handing it over is what would snap the body
     * upright mid-stroke. */
    const swimWeight = this.player?.swim?.poseWeight ?? 0;

    const set = state === MINIGAME_STATE.COUNTDOWN && swimWeight < SWIM_RIG_EPS;
    const finish = state === MINIGAME_STATE.FINISHED
      && this._verdict !== 0
      && this._sinceFinish < FINISH_HOLD_S;

    const target = set || finish ? 1 : 0;
    this._weight = damp(this._weight, target, 8, dt);

    if (this._weight < 0.002) {
      if (this._applied) {
        this._releaseRig(humanoid, swimWeight);
        this._applied = false;
        this._phase = 0;
      }
      return;
    }
    this._applied = true;

    const B = humanoid.bones;
    const w = this._weight;
    const setBone = (name, x, y, z, weight = w) => {
      const bone = B.get(name);
      if (!bone) return;
      _e.set(x, y, z);
      _q.setFromEuler(_e);
      bone.quaternion.slerp(_q, weight);
    };

    if (set) this._poseSet(humanoid, setBone, w, dt, elapsed);
    else this._poseFinish(humanoid, setBone, w, dt, elapsed, swimWeight);
  }

  /**
   * "Take your marks": folded at the hips, arms swept back, eyes down the lane.
   *
   * Not a starting-block dive - the player is standing on the deck wherever
   * they happened to accept, and a pose that assumes a block would put them
   * balanced on thin air. This is the crouch that reads as *about to go* from
   * any footing.
   */
  _poseSet(humanoid, set, w, dt) {
    // A shallow forward fold, taken on the rig so the whole body leans rather
    // than the spine alone bending, which is what makes a crouch read as
    // loaded rather than slumped.
    this._takeRig(humanoid, 0.42 * w, -0.10 * w, dt);

    // Arms back and straight, the way a swimmer holds them before the gun.
    for (const side of [1, -1]) {
      const s = side > 0 ? 'R' : 'L';
      set(`clavicle${s}`, 0, 0, -0.10 * side);
      set(`upperArm${s}`, -0.62, 0, side * 0.14);
      set(`foreArm${s}`, 0.18, 0, 0);
      set(`hand${s}`, 0.05, 0, 0);
    }

    // Knees loaded, weight forward over the toes.
    for (const side of [1, -1]) {
      const s = side > 0 ? 'R' : 'L';
      set(`thigh${s}`, 0.34, 0, side * 0.06);
      set(`calf${s}`, -0.72, 0, 0);
      set(`foot${s}`, 0.30, 0, 0);
    }

    // Head up against the fold, so the lane is in view rather than the tiles.
    set('spine01', 0.10, 0, 0);
    set('spine02', 0.08, 0, 0);
    set('spine03', 0.06, 0, 0);
    set('neck', -0.30, 0, 0);
    set('head', -0.34, 0, 0);
  }

  /**
   * The finish: both arms up for a win, folded over the lane rope for a loss.
   *
   * In the water the rig is Swim's, so this writes bones only and the body
   * stays prone - a swimmer punching the air at the wall, which is the correct
   * reading. On dry land it takes the rig and stands the body up.
   */
  _poseFinish(humanoid, set, w, dt, elapsed, swimWeight) {
    const win = this._verdict > 0;
    if (swimWeight < SWIM_RIG_EPS) {
      this._takeRig(humanoid, win ? -0.10 * w : 0.34 * w, 0, dt);
    } else {
      /* Swim owns the rig this frame. Drop the claim WITHOUT writing to it:
       * `_releaseRig` restores identity, and Swim has already written the prone
       * attitude for this frame, so restoring here would flatten the swimmer
       * out for exactly as long as the finish pose held. Swim puts the rig back
       * itself when it releases - that is its documented contract. */
      this._rigApplied = false;
      this._rigTilt = 0;
    }

    // A slow breathing sway, so the hold is not a freeze-frame.
    this._phase += dt * (win ? 1.5 : 0.8);
    const sway = Math.sin(this._phase * Math.PI * 2) * (win ? 0.16 : 0.06);

    if (win) {
      for (const side of [1, -1]) {
        const s = side > 0 ? 'R' : 'L';
        set(`clavicle${s}`, 0, 0, -0.30 * side);
        // PI puts an upper arm overhead; a little under it, splayed, with the
        // two sides half a beat apart so it is a celebration and not a salute.
        set(`upperArm${s}`, 2.55 + sway * side, 0, side * 0.55);
        set(`foreArm${s}`, 0.45 - sway * 0.5, 0, side * 0.2);
        set(`hand${s}`, -0.25, 0, 0);
      }
      set('spine01', -0.12, 0, 0);
      set('spine02', -0.12, 0, 0);
      set('spine03', -0.10, 0, 0);
      set('neck', -0.22, 0, 0);
      set('head', -0.28, 0, 0);
    } else {
      for (const side of [1, -1]) {
        const s = side > 0 ? 'R' : 'L';
        set(`clavicle${s}`, 0, 0, 0.06 * side);
        set(`upperArm${s}`, 0.55 + sway, 0, side * 0.22);
        set(`foreArm${s}`, 0.95, 0, side * 0.1);
        set(`hand${s}`, 0.1, 0, 0);
      }
      set('spine01', 0.16, 0, 0);
      set('spine02', 0.16, 0, 0);
      set('spine03', 0.14, 0, 0);
      set('neck', 0.26, 0, 0);
      set('head', 0.30, 0, 0);
    }

    const legW = clamp(w * 0.7, 0, 1);
    for (const side of [1, -1]) {
      const s = side > 0 ? 'R' : 'L';
      set(`thigh${s}`, 0.08 + (side > 0 ? sway : -sway) * 0.4, 0, side * 0.05, legW);
      set(`calf${s}`, -0.16, 0, 0, legW);
    }
  }

  /**
   * Rotate the body about its feet and lift it back off its own ankles.
   *
   * Same correction `Swim.applyPose` applies for the same reason: the rig
   * pivots at the feet, so a forward fold with no lift buries the chest below
   * the ground the character is standing on.
   *
   * @param {any} humanoid
   * @param {number} tilt radians about +X; positive folds forward
   * @param {number} lift extra metres on top of the pivot correction
   * @param {number} dt
   */
  _takeRig(humanoid, tilt, lift, dt) {
    const t = damp(this._rigTilt ?? 0, tilt, 10, dt);
    this._rigTilt = t;
    humanoid.rig.quaternion.setFromAxisAngle(_axis, -t);
    humanoid.rig.position.y = Math.sin(Math.abs(t)) * 0.34 + lift;
    this._rigApplied = true;
  }

  /**
   * Hand the rig back exactly as it was found.
   *
   * Refused while the swim pose has weight: Swim writes the rig every frame it
   * is active and restores it itself, so resetting it here would undo this
   * frame's prone attitude rather than clean anything up.
   *
   * @param {any} humanoid
   * @param {number} swimWeight
   */
  _releaseRig(humanoid, swimWeight = 0) {
    if (!this._rigApplied) return;
    this._rigApplied = false;
    this._rigTilt = 0;
    if (swimWeight >= SWIM_RIG_EPS) return;
    humanoid.rig.quaternion.identity();
    humanoid.rig.position.y = 0;
  }
}

export default MinigamePose;
