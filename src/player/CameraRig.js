import * as THREE from 'three';
import { COLLISION_LAYER } from '../physics/Physics.js';

/**
 * First / third-person camera authority.
 *
 * First person is deliberately a *pass-through*: `Player._applyCamera` still
 * owns the eye transform exactly as it always has (bob, step smoothing, landing
 * dip, strafe roll, recoil), and this class touches nothing. That is the whole
 * reason the existing feel survives the addition of a third-person mode.
 *
 * Third person replaces the eye transform with a spring-arm boom: a pivot at the
 * player's shoulder, an over-the-shoulder lateral offset, and a boom that trails
 * backwards along the look direction. The boom length is swept against the world
 * every frame with a five-ray probe (a cheap stand-in for a sphere cast, which
 * `Physics` does not offer) and is *asymmetrically* damped - it snaps inward
 * when something intrudes and eases back out afterwards. Cameras that ease in at
 * the same rate they ease out clip through door frames on the way past.
 *
 * The rig is also the authority on **where the player is aiming**. In third
 * person the muzzle is roughly a metre from the camera and half a metre to one
 * side, so firing along the camera's forward vector lands the shot well off the
 * crosshair at close range. The fix is two-stage and lives here:
 *
 *   1. `_updateAim()` casts from the camera through screen centre and records
 *      the first world/NPC surface as `aimPoint` (or a far point on a miss).
 *   2. `correctShotEvent()` rewrites the `weapon:fired` payload so the shot
 *      starts at the avatar's real muzzle and points at `aimPoint`.
 *
 * `Player` installs the `weapon:fired` interceptor from its own constructor,
 * which runs before `CombatSystem`'s, so the corrected payload is what Combat
 * resolves. First person is left completely untouched by step 2.
 */

/* Module-scope scratch. Each function owns its own vectors - two aliasing bugs
   in Physics.js cost this project days, and a camera that shares scratch with
   its own collision sweep is exactly that shape of bug. */
const _cpPivot = new THREE.Vector3();
const _cpFwd = new THREE.Vector3();
const _cpRight = new THREE.Vector3();
const _cpUp = new THREE.Vector3();
const _cpWant = new THREE.Vector3();
const _cpDir = new THREE.Vector3();
/* Sweep-only. `_composeThird` still needs its own values while these are live. */
const _swPerpA = new THREE.Vector3();
const _swPerpB = new THREE.Vector3();
const _swOrigin = new THREE.Vector3();
/* Aim-only. */
const _amOrigin = new THREE.Vector3();
const _amDir = new THREE.Vector3();
/* Shot-only. `_shOrigin`/`_shDirScratch` exist so the public one-output helpers
   can call resolveShot() without borrowing the caller's vector. */
const _shMuzzle = new THREE.Vector3();
const _shOrigin = new THREE.Vector3();
const _shDirScratch = new THREE.Vector3();

const _WORLD_UP = new THREE.Vector3(0, 1, 0);
const _ZERO_KICK = { x: 0, y: 0 };

const damp = THREE.MathUtils.damp;
const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;

const FIRST = 'first';
const THIRD = 'third';

const MAX_PITCH = 89 * (Math.PI / 180);

/**
 * Boom geometry, in metres. `lateral` is positive to the player's right, which
 * is the shoulder the (right-handed) viewmodel already fires from.
 */
const BOOM = {
  distance: 3.05,
  aimDistance: 1.45,
  lateral: 0.55,
  aimLateral: 0.45,
  height: 0.18,
  aimHeight: 0.1,
  /** Pivot sits just below the eye so the boom clears the crown on look-up. */
  pivotDrop: 0.12,
  /** Radius of the virtual sphere the boom sweeps with. */
  probe: 0.26,
  /** Backed off the surface so the near plane never pokes through. */
  margin: 0.16,
  /**
   * The boom is allowed to collapse essentially onto the pivot.
   *
   * A 0.42 m floor measured -0.056 m of clearance in the station's tightest
   * alley: the camera had nowhere left to go and pushed through the wall. The
   * answer is not a bigger margin - it is letting the arm close completely and
   * having `PlayerAvatar` drop to shadow-only below `AVATAR_FADE_LENGTH`, so the
   * player never sees the inside of their own head on the way in.
   */
  minLength: 0.12,
};

/** Below this boom length the body is hidden - the camera is inside it. */
export const AVATAR_FADE_LENGTH = 0.62;

/** Pull-in and push-out rates. Fast in, slow out - see the class comment. */
const BOOM_IN_RATE = 34;
const BOOM_OUT_RATE = 4.2;

/** How far the crosshair ray reaches before it gives up and returns a far point. */
const AIM_RANGE = 320;
/** Below this muzzle-to-target distance the parallax correction is worse than none. */
const MIN_AIM_DISTANCE = 0.75;

export class CameraRig {
  /**
   * @param {{ engine: import('../core/Engine.js').Engine,
   *           camera: THREE.PerspectiveCamera,
   *           player: import('./Player.js').Player,
   *           input: import('../core/Input.js').Input,
   *           bus: import('../core/EventBus.js').EventBus,
   *           physics: import('../physics/Physics.js').Physics,
   *           npcManager?: any }} ctx
   */
  constructor({ engine, camera, player, input, bus, physics, npcManager = null }) {
    this.engine = engine;
    this.camera = camera ?? engine?.camera;
    this.player = player;
    this.input = input;
    this.bus = bus;
    this.physics = physics;
    this._npcManager = npcManager;

    this._mode = FIRST;
    /** Current boom length in metres; damped toward the obstruction-clamped target. */
    this._length = BOOM.distance;
    this._distanceScale = 1;
    /** Mount framing, damped toward the target so mount/dismount is not a cut. */
    this._mountScale = 1;
    this._mountScaleTarget = 1;
    this._mountLift = 0;
    this._mountLiftTarget = 0;
    /** How much of the requested boom the sweep is actually granting, 0..1. */
    this._boomFrac = 1;

    /** Live world point the crosshair is over. Read by PlayerAvatar and by shots. */
    this.aimPoint = new THREE.Vector3(0, 1.6, -AIM_RANGE);
    this.aimDistance = AIM_RANGE;
    /** The NPC under the crosshair this frame, or null. Handy for the HUD later. */
    this.aimNPC = null;

    this._lastFrame = -1;
    this._tailInstalled = false;

    // Self-registration: `main.js` constructs the rig with the player it belongs
    // to, and Player has to be able to drive it from `update()` (the contract
    // says the rig runs *after* movement resolves) without main.js wiring a
    // second reference back the other way.
    if (player) player.cameraRig = this;
  }

  /* ================================================================ */
  /* Contract accessors                                                */
  /* ================================================================ */

  /** @returns {'first'|'third'} */
  get mode() {
    return this._mode;
  }

  get isThird() {
    return this._mode === THIRD;
  }

  /** Current boom length in metres (0 in first person). */
  get boomLength() {
    return this._mode === THIRD ? this._length : 0;
  }

  /**
   * Switch camera mode. Emits `camera:mode` only on an actual change.
   * @param {'first'|'third'} mode
   */
  setMode(mode) {
    const next = mode === THIRD ? THIRD : FIRST;
    if (next === this._mode) return;
    this._mode = next;
    if (next === THIRD) {
      // Grow the boom out of the head rather than teleporting behind the player,
      // which reads as a cut and loses the player's sense of where they are.
      this._length = BOOM.minLength;
    }
    this.bus?.emit('camera:mode', { mode: next });
  }

  toggle() {
    this.setMode(this._mode === THIRD ? FIRST : THIRD);
  }

  /**
   * Multiplier on the boom length. Mounts pull the camera back so a dragon fits
   * in frame; 1 is the on-foot default.
   */
  setDistanceScale(k) {
    this._distanceScale = clamp(k ?? 1, 0.4, 6);
  }

  /**
   * Framing for a large mount.
   *
   * Two knobs, because pulling back alone is not enough: a boom that only grows
   * longer stays level with the animal's spine and the ground disappears behind
   * it. Raising the pivot as well is what puts the world back under the mount
   * and lets the silhouette read against it.
   *
   * Both are damped rather than applied as a cut, and the collision sweep is
   * untouched - a longer boom is simply a longer boom to clamp.
   *
   * @param {number} scale multiplier on the boom length; 1 is on foot
   * @param {number} lift  metres to raise the boom pivot by
   */
  setMountFraming(scale, lift = 0) {
    this._mountScaleTarget = clamp(scale ?? 1, 0.4, 6);
    this._mountLiftTarget = clamp(lift ?? 0, 0, 6);
  }

  /** Collapse the spring instantly - used after a teleport so the boom does not lerp across the world. */
  snap() {
    this._length = this._targetLength();
  }

  /* ================================================================ */
  /* Frame update                                                      */
  /* ================================================================ */

  /**
   * Compose the camera and refresh the aim point.
   *
   * Idempotent per rendered frame: `Player.update` calls this once movement has
   * resolved, and `main.js` also lists it in the frame order. Whichever runs
   * first wins and the second call is a no-op, so both wirings are correct.
   *
   * @param {number} dt
   * @param {number} elapsed
   */
  update(dt, elapsed) {
    const frame = this.engine?.frame;
    if (frame !== undefined && frame === this._lastFrame) return;
    this._lastFrame = frame ?? -1;

    this._installTail();
    this._pollToggle();

    // Damped here rather than in `_composeThird`, which only runs in third
    // person: dismounting in first person would otherwise leave a ten-metre
    // boom stored, and the next `V` press would swing the camera out to a
    // dragon's framing with no dragon under it.
    this._mountScale = damp(this._mountScale, this._mountScaleTarget, 3.2, dt);
    this._mountLift = damp(this._mountLift, this._mountLiftTarget, 3.2, dt);

    // The corpse keeps the boom: a death cam that snaps back to the eye is
    // worse than one that watches the body fall.
    const player = this.player;
    if (this._mode === THIRD && player && !player._harnessFrozen) this._composeThird(dt);

    this._updateAim();
    void elapsed;
  }

  /**
   * Register a *tail* frame updater the first time we run.
   *
   * The first-person viewmodel has to be hidden in third person or it hangs in
   * mid-air at the far end of the boom, but `Loadout` re-asserts the
   * viewmodel's visibility every frame and the published frame order runs it
   * *after* the camera rig. Registering from inside the frame loop appends this
   * callback to the end of the engine's updater set, so it lands after every
   * updater that already existed - including Loadout's.
   *
   * This is a safety net, not the design: `Loadout` hiding the viewmodel itself
   * when `player.isThirdPerson` is the cleaner fix and is flagged for that
   * agent. Both being true is harmless.
   */
  _installTail() {
    if (this._tailInstalled || !this.engine?.onFrameUpdate) return;
    this._tailInstalled = true;
    this._offTail = this.engine.onFrameUpdate(() => {
      if (this._mode !== THIRD) return;
      const w = this.player?.weapon;
      if (w && !this.player._harnessFrozen) w.setVisible?.(false);
    });
  }

  _pollToggle() {
    const input = this.input;
    if (!input || input.textCaptured) return;
    // `pressed()` is edge-triggered and cleared at end of frame, so the frame
    // guard above is what stops a double toggle when both callers run.
    if (input.pressed('KeyV')) this.toggle();
  }

  /** Boom length the geometry asks for before any obstruction is considered. */
  _targetLength() {
    const aim = clamp(this.player?.aimProgress ?? 0, 0, 1);
    return lerp(BOOM.distance, BOOM.aimDistance, aim) * this._distanceScale * this._mountScale;
  }

  /* ---------------------------------------------------------------- */
  /* Third-person composition                                          */
  /* ---------------------------------------------------------------- */

  _composeThird(dt) {
    const cam = this.camera;
    const p = this.player;
    const yaw = p.yaw;
    const pitch = p.pitch;
    const cp = Math.cos(pitch);

    // Characters face -Z at yaw 0, so this matches Player.forward exactly - and
    // it has to, because the crosshair ray is cast along the camera's forward.
    _cpFwd.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
    _cpRight.set(Math.cos(yaw), 0, -Math.sin(yaw));
    _cpUp.crossVectors(_cpRight, _cpFwd).normalize();

    const aim = clamp(p.aimProgress ?? 0, 0, 1);
    const lateral = lerp(BOOM.lateral, BOOM.aimLateral, aim);
    const height = lerp(BOOM.height, BOOM.aimHeight, aim);

    // Sweep origin is the body centre line, *not* the offset shoulder: a player
    // pressed against a wall has their shoulder inside it, and a sweep that
    // starts inside geometry reports no hit and lets the camera through.
    // The mount lift rides the *achieved* boom fraction, not the requested one.
    // Raising the pivot by two and a half metres is right when the arm is fully
    // extended behind a dragon; indoors, where the sweep collapses the arm to a
    // couple of metres, the same lift parks the camera inside the animal's back.
    // Last frame's fraction is used because the sweep needs the pivot first.
    _cpPivot.set(
      p.position.x,
      p.position.y + p.eyeHeight - p.stepSmoothing - BOOM.pivotDrop + p.viewDip * 0.4 +
        this._mountLift * (this._boomFrac ?? 1),
      p.position.z
    );

    const target = this._targetLength();
    _cpWant
      .copy(_cpPivot)
      .addScaledVector(_cpRight, lateral)
      .addScaledVector(_cpUp, height)
      .addScaledVector(_cpFwd, -target);

    _cpDir.subVectors(_cpWant, _cpPivot);
    const wantLen = _cpDir.length();
    if (wantLen < 1e-4) return;
    _cpDir.multiplyScalar(1 / wantLen);

    const allowed = this._sweep(_cpPivot, _cpDir, wantLen);

    // Asymmetric spring: obstruction wins immediately, recovery is gentle.
    const rate = allowed < this._length ? BOOM_IN_RATE : BOOM_OUT_RATE;
    this._length = damp(this._length, allowed, rate, dt);
    this._length = clamp(this._length, BOOM.minLength, wantLen);
    this._boomFrac = damp(this._boomFrac ?? 1, clamp(this._length / wantLen, 0, 1), 8, dt);

    cam.position.copy(_cpPivot).addScaledVector(_cpDir, this._length);

    const kick = p.weapon?.getRecoilOffset?.() ?? _ZERO_KICK;
    cam.rotation.set(
      clamp(pitch + kick.y, -MAX_PITCH - 0.2, MAX_PITCH + 0.2),
      yaw + kick.x,
      0,
      'YXZ'
    );
    cam.updateMatrixWorld(true);
  }

  /**
   * Five-ray stand-in for a sphere cast along the boom.
   *
   * `Physics` exposes rays only, so the boom is probed down its axis plus four
   * offsets on the perpendicular plane at the probe radius. That catches wall
   * corners and railing uprights that a single centre ray slides straight past,
   * which is the failure everyone actually sees: the camera clipping a door
   * jamb it "missed" by 20 cm.
   *
   * @returns {number} the longest boom length that stays clear, in metres
   */
  _sweep(origin, dir, maxLen) {
    // Any horizontal-ish vector will do for the first perpendicular; the world
    // up degenerates only when the boom is exactly vertical.
    _swPerpA.crossVectors(dir, _WORLD_UP);
    if (_swPerpA.lengthSq() < 1e-6) _swPerpA.set(1, 0, 0);
    _swPerpA.normalize();
    _swPerpB.crossVectors(dir, _swPerpA).normalize();

    const r = BOOM.probe;
    let best = maxLen;

    for (let i = 0; i < 5; i++) {
      _swOrigin.copy(origin);
      if (i === 1) _swOrigin.addScaledVector(_swPerpA, r);
      else if (i === 2) _swOrigin.addScaledVector(_swPerpA, -r);
      else if (i === 3) _swOrigin.addScaledVector(_swPerpB, r);
      else if (i === 4) _swOrigin.addScaledVector(_swPerpB, -r);

      const hit = this.physics?.raycast(_swOrigin, dir, best + BOOM.margin, COLLISION_LAYER.WORLD);
      if (hit) {
        const len = hit.distance - BOOM.margin;
        if (len < best) best = len;
      }
    }
    return Math.max(BOOM.minLength, best);
  }

  /* ---------------------------------------------------------------- */
  /* Aim resolution                                                    */
  /* ---------------------------------------------------------------- */

  /** Resolved lazily: `main.js` builds the rig without an NPC manager reference. */
  get npcManager() {
    if (!this._npcManager) {
      this._npcManager = globalThis.GAME?.npcManager ?? null;
    }
    return this._npcManager;
  }

  /**
   * Cast from the camera through screen centre and record what the crosshair is
   * over. Screen centre *is* the camera's forward axis for a symmetric
   * projection, so this needs no unprojection.
   */
  _updateAim() {
    const cam = this.camera;
    if (!cam) return;
    cam.updateMatrixWorld(true);
    cam.getWorldPosition(_amOrigin);
    cam.getWorldDirection(_amDir);

    let dist = AIM_RANGE;
    let npc = null;

    const npcHit = this.npcManager?.raycastNPCs?.(_amOrigin, _amDir, AIM_RANGE) ?? null;
    if (npcHit) {
      const d = Number.isFinite(npcHit.distance)
        ? npcHit.distance
        : _amOrigin.distanceTo(npcHit.point);
      if (d < dist) {
        dist = d;
        npc = npcHit.npc ?? null;
      }
    }

    // World last, clamped to the NPC distance: cover has to win over the body
    // standing behind it, and this is the same ordering Combat resolves with.
    const worldHit = this.physics?.raycast(_amOrigin, _amDir, dist, COLLISION_LAYER.WORLD);
    if (worldHit) {
      dist = worldHit.distance;
      npc = null;
    }

    this.aimDistance = dist;
    this.aimNPC = npc;
    this.aimPoint.copy(_amOrigin).addScaledVector(_amDir, dist);
  }

  /**
   * Where the player's next shot starts and which way it travels.
   *
   * First person returns the camera line unchanged - that is the behaviour the
   * whole game was tuned against and it stays byte-identical. Third person
   * returns the avatar's real muzzle pointed at `aimPoint`, which is what makes
   * the impact land on the crosshair rather than half a metre to its left.
   *
   * @param {THREE.Vector3} outOrigin
   * @param {THREE.Vector3} outDirection
   * @returns {boolean} true if the shot was corrected for third-person parallax
   */
  resolveShot(outOrigin, outDirection) {
    const cam = this.camera;
    if (this._mode !== THIRD) {
      cam.getWorldPosition(outOrigin);
      cam.getWorldDirection(outDirection);
      return false;
    }

    const muzzle = this.player?.avatar?.getMuzzleWorld?.(_shMuzzle) ?? null;
    if (muzzle) {
      outOrigin.copy(muzzle);
    } else {
      // No avatar yet (or it is mid-rebuild): fall back to a plausible shoulder.
      const p = this.player;
      outOrigin.set(p.position.x, p.position.y + p.eyeHeight - 0.12, p.position.z);
      outOrigin.x += Math.cos(p.yaw) * 0.2;
      outOrigin.z += -Math.sin(p.yaw) * 0.2;
    }

    outDirection.subVectors(this.aimPoint, outOrigin);
    const len = outDirection.length();
    if (len < MIN_AIM_DISTANCE) {
      // Target is inside the muzzle's own personal space; the parallax
      // correction would swing wildly, so shoot along the camera instead.
      cam.getWorldDirection(outDirection);
      return false;
    }
    outDirection.multiplyScalar(1 / len);
    return true;
  }

  /**
   * Direction a shot should travel, without needing the origin.
   *
   * `Loadout` calls this so each weapon can aim without knowing which camera
   * mode is live. In first person it is the camera's forward axis, unchanged.
   *
   * @param {THREE.Vector3} out
   * @returns {THREE.Vector3} `out`, normalised
   */
  getAimDirection(out) {
    if (this._mode !== THIRD) {
      this.camera.getWorldDirection(out);
      return out.normalize();
    }
    this.resolveShot(_shOrigin, out);
    return out;
  }

  /**
   * World point the crosshair is over. Copied out, because `aimPoint` is a live
   * reference the rig rewrites every frame.
   * @param {THREE.Vector3} out
   */
  getAimPoint(out) {
    return out.copy(this.aimPoint);
  }

  /**
   * Muzzle position a third-person shot should start from, or null in first
   * person (where the camera *is* the origin).
   * @param {THREE.Vector3} out
   */
  getShotOrigin(out) {
    if (this._mode !== THIRD) return this.camera.getWorldPosition(out);
    this.resolveShot(out, _shDirScratch);
    return out;
  }

  /**
   * Rewrite a `weapon:fired` payload in place so downstream consumers resolve
   * the shot from the muzzle toward the crosshair.
   *
   * Mutation rather than a re-emit is deliberate: `weapon:fired` is consumed by
   * Combat, the HUD and the NPC alert system, and any of them seeing the shot
   * twice would double the tracer, the hitmarker and the noise event.
   *
   * @param {{origin:THREE.Vector3, direction:THREE.Vector3, muzzle?:THREE.Vector3}} evt
   */
  correctShotEvent(evt) {
    if (this._mode !== THIRD) return;
    if (!evt?.origin?.isVector3 || !evt?.direction?.isVector3) return;
    const corrected = this.resolveShot(evt.origin, evt.direction);
    if (corrected && evt.muzzle?.isVector3) evt.muzzle.copy(evt.origin);
  }

  dispose() {
    this._offTail?.();
    this._offTail = null;
    if (this.player?.cameraRig === this) this.player.cameraRig = null;
  }
}
