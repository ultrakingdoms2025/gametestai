import * as THREE from 'three';
import { COLLISION_LAYER } from '../physics/Physics.js';

/**
 * Procedural character animation. There are no clips: every pose is computed
 * from velocity, heading and world contact each frame.
 *
 * The load-bearing idea is that legs are driven by inverse kinematics from foot
 * *targets* rather than by rotating joints on a timer. Stride length is derived
 * from speed, so a planted foot holds still in world space while the body moves
 * over it. That single property is what separates animation that reads as real
 * from animation that reads as a demo.
 *
 * Everything is solved in "rig space" - the character's own frame at canonical
 * scale - so the maths never has to care about the instance height scale or the
 * NPC's world transform.
 */

/* Scratch: this file runs 16+ times per frame, so it allocates nothing. */
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _v6 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _e1 = new THREE.Euler();
const _down = new THREE.Vector3(0, -1, 0);
const _up = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3(0, 0, -1);

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Frame-rate independent exponential approach. */
const approach = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const wrapPi = (a) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

/**
 * Build the rotation that takes a bone from its rest orientation to one whose
 * primary axis points along `dir` with `ref` resolving the twist.
 */
function basisQuat(dir, ref, restDir, restRef, out) {
  _v4.crossVectors(ref, dir);
  if (_v4.lengthSq() < 1e-10) _v4.crossVectors(_up, dir);
  if (_v4.lengthSq() < 1e-10) _v4.set(1, 0, 0);
  _v4.normalize();
  _v5.crossVectors(dir, _v4).normalize();
  _m1.makeBasis(_v4, _v5, dir);

  _v4.crossVectors(restRef, restDir);
  if (_v4.lengthSq() < 1e-10) _v4.crossVectors(_up, restDir);
  if (_v4.lengthSq() < 1e-10) _v4.set(1, 0, 0);
  _v4.normalize();
  _v5.crossVectors(restDir, _v4).normalize();
  _m2.makeBasis(_v4, _v5, restDir);
  _m2.transpose(); // orthonormal, so transpose is the inverse

  _m1.multiply(_m2);
  return out.setFromRotationMatrix(_m1);
}

/**
 * Analytic two-bone IK. Returns the knee/elbow position in `outJoint`; the
 * caller turns that into bone rotations.
 */
function solveTwoBone(root, target, l1, l2, pole, outJoint) {
  _v1.subVectors(target, root);
  let d = _v1.length();
  const min = Math.abs(l1 - l2) + 1e-4;
  const max = l1 + l2 - 1e-4;
  if (d < 1e-5) {
    _v1.set(0, -1, 0);
    d = 1e-5;
  }
  _v1.multiplyScalar(1 / d);
  d = clamp(d, min, max);
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  // Project the pole vector perpendicular to the chain to place the joint.
  _v2.copy(pole).addScaledVector(_v1, -pole.dot(_v1));
  if (_v2.lengthSq() < 1e-8) {
    _v2.crossVectors(_v1, _up);
    if (_v2.lengthSq() < 1e-8) _v2.set(0, 0, -1);
  }
  _v2.normalize();
  outJoint.copy(root).addScaledVector(_v1, a).addScaledVector(_v2, h);
  return _v2; // the bend-plane reference, reused by the caller for twist
}

/**
 * Held standing poses, authored as bone eulers per side.
 *
 * `sgn` is +1 on the right, -1 on the left; z on the arm bones swings the limb
 * outboard, so mirroring is a multiply rather than a second table. `chest` and
 * `hip` are small torso adjustments that sell the weight distribution.
 */
const POSTURES = {
  crossed: {
    chest: 0.05,
    hip: 0.35,
    clavicle: (s) => [0.03, 0, -0.16 * s],
    upperArm: (s) => [0.62, 0.22 * s, -0.34 * s],
    foreArm: () => [1.86, 0, 0],
    hand: (s) => [0.1, -0.25 * s, -0.2 * s],
  },
  hips: {
    chest: -0.02,
    hip: 0.55,
    clavicle: (s) => [0.02, 0, -0.1 * s],
    upperArm: (s) => [0.16, -0.1 * s, 0.5 * s],
    foreArm: () => [1.72, 0, 0],
    hand: (s) => [0.22, 0.4 * s, 0.3 * s],
  },
  pocket: {
    chest: 0.03,
    hip: 0.5,
    clavicle: (s) => [0.0, 0, -0.05 * s],
    upperArm: (s) => [-0.14, 0, 0.06 * s],
    foreArm: () => [0.42, 0, 0],
    hand: (s) => [0.2, 0.12 * s, -0.1 * s],
  },
  lean: {
    chest: -0.09,
    hip: 0.9,
    clavicle: (s) => [0.02, 0, -0.1 * s],
    upperArm: (s) => [0.24, 0.08 * s, 0.12 * s],
    foreArm: () => [0.66, 0, 0],
    hand: (s) => [0.1, 0, -0.14 * s],
  },
  // Skaters and bench-sitters: knees folded, forearms resting on them.
  squat: {
    chest: 0.22,
    hip: 0.15,
    crouch: 1,
    clavicle: (s) => [0.04, 0, -0.14 * s],
    upperArm: (s) => [0.46, 0.16 * s, 0.2 * s],
    foreArm: () => [1.15, 0, 0],
    hand: (s) => [0.15, 0.1 * s, -0.1 * s],
  },
};

export class NPCAnimator {
  /**
   * @param {{ humanoid:any, physics:any, seed?:number }} ctx
   */
  constructor({ humanoid, physics, seed = 1 }) {
    this.h = humanoid;
    this.physics = physics;
    this.P = humanoid.P;
    this.scale = humanoid.heightScale;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    this._rnd = rnd;

    const spec = humanoid.spec;
    this.spec = spec;
    this.bones = humanoid.boneList;
    this.byName = humanoid.bones;

    // Flat parallel arrays for the manual forward-kinematics pass.
    this._parent = new Int16Array(spec.length);
    this._rest = [];
    this._fkPos = [];
    this._fkQuat = [];
    this._index = new Map();
    for (let i = 0; i < spec.length; i++) {
      this._index.set(spec[i].name, i);
      this._parent[i] = spec[i].parent ? this._index.get(spec[i].parent) : -1;
      this._rest.push(this.bones[i].position.clone());
      this._fkPos.push(new THREE.Vector3());
      this._fkQuat.push(new THREE.Quaternion());
    }

    const seg = (name) => {
      const d = spec.find((s) => s.name === name);
      return Math.hypot(d.tail[0] - d.pos[0], d.tail[1] - d.pos[1], d.tail[2] - d.pos[2]);
    };
    const dir = (name, out) => {
      const d = spec.find((s) => s.name === name);
      return out.set(d.tail[0] - d.pos[0], d.tail[1] - d.pos[1], d.tail[2] - d.pos[2]).normalize();
    };
    this.thighLen = seg('thighR');
    this.calfLen = seg('calfR');
    this.legLen = this.thighLen + this.calfLen;
    this.upperArmLen = seg('upperArmR');
    this.foreArmLen = seg('foreArmR');
    this.restThigh = dir('thighR', new THREE.Vector3());
    this.restCalf = dir('calfR', new THREE.Vector3());
    this.restFoot = dir('footR', new THREE.Vector3());
    this.restUpperArm = { R: dir('upperArmR', new THREE.Vector3()), L: dir('upperArmL', new THREE.Vector3()) };
    this.restForeArm = { R: dir('foreArmR', new THREE.Vector3()), L: dir('foreArmL', new THREE.Vector3()) };

    // --- animation state -------------------------------------------
    this.phase = rnd();
    this.speed = 0;
    this.turnRate = 0;
    this.moveBlend = 0;
    this.runBlend = 0;
    this.crouch = 0;
    this.pelvisY = this.P.pelvisY;
    this.pelvisSway = 0;
    this.groundOffset = 0;

    this.lookTarget = null;
    this.aimTarget = null;
    this.aimWeight = 0;
    this._aimWant = 0;
    this.headYaw = 0;
    this.headPitch = 0;

    this.breathPhase = rnd() * 6.28;
    this.idleShift = 0;
    this.idleShiftTarget = rnd() < 0.5 ? -1 : 1;
    this.idleShiftTimer = 2 + rnd() * 5;
    this.glanceYaw = 0;
    this.glanceTimer = 1 + rnd() * 5;
    this.handTwitch = rnd() * 6.28;

    this.blinkTimer = 1 + rnd() * 4;
    this.blink = 0;
    this._blinking = 0;

    this.postureKind = 'none';
    this.posturePose = null;
    this.postureWeight = 0;
    this.gestureWeight = 0;
    this._gesturePhase = rnd() * 6.28;

    this.flinchX = 0;
    this.flinchZ = 0;
    this.flinchVX = 0;
    this.flinchVZ = 0;
    this.staggerT = 0;
    this.staggerDir = new THREE.Vector3();

    this.dead = false;
    this.deathT = 0;
    this.deathFall = 0;
    this.deathAxis = new THREE.Vector3(1, 0, 0);
    this.sinking = false;
    this.sink = 0;
    this._deathTargets = null;

    // Foot state, index 0 = right, 1 = left.
    this.feet = [0, 1].map((i) => ({
      side: i === 0 ? 1 : -1,
      name: i === 0 ? 'R' : 'L',
      groundY: 0,
      groundValid: false,
      normal: new THREE.Vector3(0, 1, 0),
      target: new THREE.Vector3(),
      local: new THREE.Vector3(),
      probeTimer: i * 0.008,
      fwd: 0,
      lift: 0,
      roll: 0,
    }));

    this._invRoot = new THREE.Matrix4();
    this._tmpMat = new THREE.Matrix4();
    this._tmpPos = new THREE.Vector3();
    this._chestYawApplied = 0;
    // Dedicated vectors for the aim solver: the shared scratch is consumed by
    // solveTwoBone, which would otherwise clobber values across both arms.
    this._aimDir = new THREE.Vector3();
    this._aimRight = new THREE.Vector3();
    this._aimTargetRig = new THREE.Vector3();
    this._handTarget = new THREE.Vector3();
    this._pole = new THREE.Vector3();
    this._bendRef = new THREE.Vector3();
    this._eyeLocal = new THREE.Vector3();
  }

  /* ---------------------------------------------------------------- */
  /* Inputs                                                            */
  /* ---------------------------------------------------------------- */

  /** @param {number} speed metres/second along the ground. */
  setLocomotion(speed, turnRate) {
    this.speed = speed;
    this.turnRate = turnRate;
  }

  /** World position the head and eyes track, or null to face forward. */
  setLookTarget(v) {
    this.lookTarget = v;
  }

  /** World position the weapon points at. Enables the upper-body aim layer. */
  setAimTarget(v) {
    this.aimTarget = v;
    this._aimWant = v ? 1 : 0;
  }

  setAiming(on) {
    this._aimWant = on ? 1 : 0;
  }

  /**
   * Standing posture layer.
   *
   * A crowd of characters all hanging their arms at their sides reads as a
   * shop-window display, so idle NPCs get a held pose: folded arms, hands on
   * hips, a thumb hooked in a pocket, or a hip-shot lean. The layer only has
   * authority while the character is standing - it fades out the moment they
   * start walking, and the aim layer always wins over it.
   *
   * @param {'none'|'crossed'|'hips'|'pocket'|'lean'|'squat'} kind
   */
  setPosture(kind) {
    if (kind === this.postureKind) return;
    this.postureKind = kind ?? 'none';
    this.posturePose = POSTURES[this.postureKind] ?? null;
  }

  /** Conversational hand movement while talking. */
  setGesturing(on) {
    this._gestureWant = on ? 1 : 0;
  }

  /** Directional hit reaction. `heavy` also throws in a stagger. */
  flinch(dirWorld, heavy = false) {
    if (this.dead) return;
    _v1.copy(dirWorld).transformDirection(this._invRoot4());
    const k = heavy ? 26 : 12;
    this.flinchVZ += -_v1.z * k * 0.09;
    this.flinchVX += _v1.x * k * 0.09;
    if (heavy) {
      this.staggerT = 1;
      this.staggerDir.copy(_v1).setY(0).normalize();
    }
  }

  _invRoot4() {
    this.h.root.updateMatrixWorld(true);
    return this._tmpMat.copy(this.h.root.matrixWorld).invert();
  }

  /** Begin the collapse. Idempotent. */
  die(dirWorld, isHeadshot = false) {
    if (this.dead) return;
    this.dead = true;
    this.deathT = 0;
    this.deathFall = 0;
    this.sink = 0;
    this.sinking = false;

    // Fall away from the shot, with a random bias so bodies never stack alike.
    const inv = this._invRoot4();
    _v1.copy(dirWorld ?? _fwd).transformDirection(inv).setY(0);
    if (_v1.lengthSq() < 1e-6) _v1.set(0, 0, -1);
    _v1.normalize();
    const jitter = (this._rnd() - 0.5) * 0.9;
    _e1.set(0, jitter, 0);
    _q1.setFromEuler(_e1);
    _v1.applyQuaternion(_q1);
    // Topple axis is horizontal and perpendicular to the fall direction.
    this.deathAxis.crossVectors(_up, _v1).normalize();
    this.deathFallLimit = 1.42 + this._rnd() * 0.16;

    // Limp target pose: joints go slack with a little randomness.
    const t = {};
    const r = () => (this._rnd() - 0.5) * 2;
    t.pelvis = new THREE.Euler(0.1 * r(), 0.2 * r(), 0.14 * r());
    t.spine01 = new THREE.Euler(0.12 + 0.1 * r(), 0.1 * r(), 0.1 * r());
    t.spine02 = new THREE.Euler(0.1 + 0.1 * r(), 0.12 * r(), 0.12 * r());
    t.spine03 = new THREE.Euler(0.08 + 0.1 * r(), 0.14 * r(), 0.1 * r());
    t.neck = new THREE.Euler(isHeadshot ? -0.5 : 0.22 + 0.2 * r(), 0.2 * r(), 0.18 * r());
    t.head = new THREE.Euler(isHeadshot ? -0.35 : 0.2 + 0.2 * r(), 0.3 * r(), 0.2 * r());
    for (const s of ['R', 'L']) {
      const sgn = s === 'R' ? 1 : -1;
      t[`clavicle${s}`] = new THREE.Euler(0.05 * r(), 0, -0.12 * sgn);
      t[`upperArm${s}`] = new THREE.Euler(-0.5 - this._rnd() * 0.8, 0.3 * r(), -0.5 * sgn + 0.3 * r());
      t[`foreArm${s}`] = new THREE.Euler(0.5 + this._rnd() * 0.9, 0.2 * r(), 0);
      t[`hand${s}`] = new THREE.Euler(0.2 * r(), 0.2 * r(), 0.3 * r());
      t[`thigh${s}`] = new THREE.Euler(-0.3 - this._rnd() * 0.7, 0.2 * r(), 0.25 * sgn * this._rnd());
      t[`calf${s}`] = new THREE.Euler(0.7 + this._rnd() * 1.1, 0.1 * r(), 0);
      t[`foot${s}`] = new THREE.Euler(-0.3 + 0.3 * r(), 0.2 * r(), 0.2 * r());
      t[`toe${s}`] = new THREE.Euler(0.1 * r(), 0, 0);
    }
    this._deathTargets = {};
    for (const k in t) this._deathTargets[k] = new THREE.Quaternion().setFromEuler(t[k]);
    this._deathVel = new Float32Array(this.bones.length);
    for (let i = 0; i < this.bones.length; i++) this._deathVel[i] = 0.4 + this._rnd() * 1.2;
  }

  /** Start fading the corpse away (a sink, so shared materials stay shared). */
  beginSink() {
    if (!this.dead) return;
    this.sinking = true;
  }

  get sunk() {
    return this.sink >= 1;
  }

  /** Reset to a living idle - used by respawn so instances can be recycled. */
  revive() {
    this.dead = false;
    this.sinking = false;
    this.sink = 0;
    this.deathT = 0;
    this.deathFall = 0;
    this.h.rig.position.set(0, 0, 0);
    this.h.rig.quaternion.identity();
    this.h.root.visible = true;
    this.flinchX = this.flinchZ = this.flinchVX = this.flinchVZ = 0;
    this.staggerT = 0;
    for (const b of this.bones) b.quaternion.identity();
    this.byName.get('pelvis').position.set(0, this.P.pelvisY, 0);
  }

  /* ---------------------------------------------------------------- */
  /* Main update                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * @param {number} dt
   * @param {number} elapsed
   * @param {{ik?:boolean, detail?:boolean}} [lod]
   */
  update(dt, elapsed, lod = {}) {
    const h = this.h;
    h.root.updateMatrixWorld(true);
    this._invRoot.copy(h.root.matrixWorld).invert();

    if (this.dead) {
      this._updateDeath(dt);
      return;
    }

    this._updateBlend(dt);
    this._updateIdle(dt, elapsed);
    this._updateFlinch(dt);
    this._poseSpine(dt, elapsed);
    this._runFK();
    if (this.aimWeight > 0.001 && this.aimTarget) this._poseAimArms();
    this._poseLegs(dt, lod.ik !== false);
    this._poseHead(dt);
    if (lod.detail !== false) this._poseEyes(dt);
  }

  _updateBlend(dt) {
    const s = this.speed;
    this.runBlend = approach(this.runBlend, smoothstep(2.2, 3.6, s), 8, dt);
    this.moveBlend = approach(this.moveBlend, smoothstep(0.1, 0.85, s), 12, dt);
    this.aimWeight = approach(this.aimWeight, this._aimWant, 7, dt);
    this.postureWeight = approach(this.postureWeight, this.posturePose ? 1 : 0, 3.2, dt);
    this.gestureWeight = approach(this.gestureWeight, this._gestureWant ?? 0, 2.6, dt);
    if (this.gestureWeight > 0.001) this._gesturePhase += dt * 2.35;
    const postureCrouch =
      (this.posturePose?.crouch ?? 0) * this.postureWeight * (1 - this.moveBlend);
    this.crouch = approach(this.crouch, Math.max(this.crouchTarget ?? 0, postureCrouch), 5.5, dt);

    // Stride length grows with speed; cycle time follows, so feet never slide.
    const L0 = lerp(0.56, 1.02, this.runBlend);
    const k = lerp(0.235, 0.36, this.runBlend);
    this.strideLen = L0 + k * s;
    let cycle = this.strideLen / Math.max(s, 0.001);
    // Stationary turning still needs a cadence for the shuffle steps.
    const turning = Math.abs(this.turnRate) > 0.6 && s < 0.5;
    if (!Number.isFinite(cycle) || cycle > 1.7) cycle = turning ? 0.85 : 1.7;
    this.cycleTime = clamp(cycle, 0.3, 1.7);
    this.turning = turning ? clamp(Math.abs(this.turnRate) / 2.2, 0, 1) : 0;
    if (this.moveBlend > 0.02 || this.turning > 0.02) {
      this.phase = (this.phase + dt / this.cycleTime) % 1;
    }
    this.duty = lerp(0.62, 0.37, this.runBlend);
  }

  _updateIdle(dt, elapsed) {
    const idle = 1 - this.moveBlend;
    this.breathPhase += dt * (1.05 + this.runBlend * 1.6 + this.speed * 0.12);
    this.breath = Math.sin(this.breathPhase);

    this.idleShiftTimer -= dt;
    if (this.idleShiftTimer <= 0) {
      this.idleShiftTarget = this._rnd() < 0.5 ? -1 : 1;
      this.idleShiftTimer = 3.5 + this._rnd() * 6;
    }
    this.idleShift = approach(this.idleShift, this.idleShiftTarget * idle, 1.1, dt);

    this.glanceTimer -= dt;
    if (this.glanceTimer <= 0) {
      this.glanceTarget = (this._rnd() - 0.5) * 1.25 * idle;
      this.glanceTimer = 2.5 + this._rnd() * 6;
    }
    this.glanceYaw = approach(this.glanceYaw, this.glanceTarget ?? 0, 2.2, dt);
    this.handTwitch += dt * 0.9;
    void elapsed;
  }

  _updateFlinch(dt) {
    // Critically-ish damped spring so hits punch and then settle.
    const k = 210;
    const c = 19;
    this.flinchVX += (-k * this.flinchX - c * this.flinchVX) * dt;
    this.flinchVZ += (-k * this.flinchZ - c * this.flinchVZ) * dt;
    this.flinchX += this.flinchVX * dt;
    this.flinchZ += this.flinchVZ * dt;
    if (this.staggerT > 0) this.staggerT = Math.max(0, this.staggerT - dt / 0.75);
  }

  /* --- spine, pelvis, arms ---------------------------------------- */

  _poseSpine(dt, elapsed) {
    const P = this.P;
    const B = this.byName;
    const mb = this.moveBlend;
    const rb = this.runBlend;
    const idle = 1 - mb;
    const ph = this.phase * Math.PI * 2;

    // Pelvis: bob twice a cycle, sway once, plus the idle weight shift.
    // A held posture parks more weight over one leg than a neutral idle does.
    const postureK = this.postureWeight * idle;
    const hipK = 1 + (this.posturePose?.hip ?? 0) * postureK;
    const bobAmp = lerp(0.014, 0.052, rb) * mb;
    const swayAmp = lerp(0.024, 0.013, rb) * mb;
    const bob = Math.cos(ph * 2) * bobAmp;
    const sway = Math.sin(ph) * swayAmp + this.idleShift * 0.028 * hipK;
    this.pelvisSway = sway;
    this.pelvisBob = bob;

    const stagger = this.staggerT * this.staggerT;
    const pelvis = B.get('pelvis');
    pelvis.position.set(
      sway + this.staggerDir.x * stagger * 0.1,
      P.pelvisY + this.groundOffset + bob - this.crouch * 0.24 - stagger * 0.09,
      this.staggerDir.z * stagger * 0.1
    );

    const lean = lerp(0.015, 0.19, rb) * mb + this.flinchZ * 0.35;
    const twist = Math.sin(ph) * 0.075 * mb;
    const pelvicDrop = Math.sin(ph + Math.PI * 0.5) * 0.055 * mb + this.idleShift * 0.05 * hipK;

    _e1.set(lean * 0.25, twist * 0.5, pelvicDrop + this.flinchX * 0.25 - this.turnRate * 0.06);
    pelvis.quaternion.setFromEuler(_e1);

    const breatheIdle = this.breath * idle;
    _e1.set(
      lean * 0.3 + this.flinchZ * 0.5 + breatheIdle * 0.011,
      -twist * 0.5,
      -pelvicDrop * 0.35 + this.flinchX * 0.4
    );
    B.get('spine01').quaternion.setFromEuler(_e1);
    _e1.set(lean * 0.28 + this.flinchZ * 0.55 + breatheIdle * 0.014, -twist * 0.7, this.flinchX * 0.3);
    B.get('spine02').quaternion.setFromEuler(_e1);

    // Chest counter-rotates against the hips; the aim layer overrides its yaw.
    let chestYaw = -twist * 1.35;
    let chestPitch = lean * 0.2 + this.flinchZ * 0.5 + (this.posturePose?.chest ?? 0) * postureK;
    if (this.aimWeight > 0.001 && this.aimTarget) {
      _v1.copy(this.aimTarget).applyMatrix4(this._invRoot);
      _v1.y -= P.chestY;
      const wantYaw = clamp(Math.atan2(-_v1.x, -_v1.z), -0.7, 0.7);
      const wantPitch = clamp(-Math.atan2(_v1.y, Math.hypot(_v1.x, _v1.z)), -0.55, 0.55);
      chestYaw = lerp(chestYaw, wantYaw * 0.55, this.aimWeight);
      chestPitch = lerp(chestPitch, wantPitch * 0.5, this.aimWeight);
    }
    _e1.set(chestPitch + breatheIdle * 0.016, chestYaw, this.flinchX * 0.25);
    B.get('spine03').quaternion.setFromEuler(_e1);
    this._chestYawApplied = chestYaw;

    // --- arms: opposed swing, elbow flexion grows with speed --------
    const swingGain = lerp(0.42, 0.95, rb) * mb;
    const halfStride = (this.strideLen * this.duty) / 2;
    for (const foot of this.feet) {
      const u = (this.phase + (foot.side > 0 ? 0 : 0.5)) % 1;
      foot.phaseU = u;
      const d = this.duty;
      if (u < d) {
        const s = u / d;
        foot.fwd = halfStride * (1 - 2 * s);
        foot.lift = 0;
        foot.stance = 1;
        foot.stanceT = s;
      } else {
        const s = (u - d) / (1 - d);
        const ease = s * s * (3 - 2 * s) + 0.07 * Math.sin(Math.PI * s);
        foot.fwd = -halfStride + 2 * halfStride * ease;
        foot.lift = lerp(0.05, 0.15, rb) * Math.pow(Math.sin(Math.PI * s), 1.25) * mb;
        foot.stance = 0;
        foot.stanceT = s;
      }
      if (this.turning > 0.02 && mb < 0.3) {
        // Shuffle: pick the feet up and yaw them into the new heading.
        const t = (this.phase + (foot.side > 0 ? 0 : 0.5)) % 1;
        foot.lift = Math.max(foot.lift, 0.032 * this.turning * Math.max(0, Math.sin(t * Math.PI * 2)));
        foot.turnYaw = -Math.sign(this.turnRate) * 0.3 * this.turning * (t < 0.5 ? 1 : -1);
      } else {
        foot.turnYaw = 0;
      }
    }

    const twitch = Math.sin(this.handTwitch * 2.3) * 0.05 * idle;
    // The held pose only has authority while standing, and never fights the aim
    // layer - a character who is waving or shooting is not also folding its arms.
    const pw = this.postureWeight * idle * (1 - this.aimWeight);
    const pose = this.posturePose;
    // Conversational hand movement: a slow asymmetric swing on the leading arm.
    const gw = this.gestureWeight * idle * (1 - this.aimWeight);
    const gA = Math.sin(this._gesturePhase) * gw;
    const gB = Math.sin(this._gesturePhase * 1.7 + 1.1) * gw;

    for (const s of ['R', 'L']) {
      const sgn = s === 'R' ? 1 : -1;
      const opposite = this.feet[s === 'R' ? 1 : 0];
      const swing = (opposite.fwd / Math.max(halfStride, 1e-4)) * swingGain;
      const shoulderRise = this.breath * idle * 0.012;
      const lead = s === 'R' ? 1 : 0.45;

      let cx = 0.02 + shoulderRise;
      let cy = 0;
      let cz = (-0.06 - shoulderRise * 2) * sgn;
      const outward = (0.05 + 0.09 * this.runBlend * mb + this.idleShift * 0.02 * sgn) * sgn;
      let ux = swing * 0.85;
      let uy = swing * 0.12 * sgn;
      let uz = outward;
      let fx = 0.18 + lerp(0.08, 0.95, rb) * mb + Math.abs(swing) * 0.18;
      let fy = 0;
      let hx = twitch * (s === 'R' ? 1 : -0.7);
      let hy = 0;
      let hz = -0.12 * sgn + twitch;

      if (pose && pw > 0.001) {
        const c = pose.clavicle(sgn);
        const u = pose.upperArm(sgn);
        const f = pose.foreArm(sgn);
        const h = pose.hand(sgn);
        cx = lerp(cx, c[0], pw); cy = lerp(cy, c[1], pw); cz = lerp(cz, c[2], pw);
        ux = lerp(ux, u[0], pw); uy = lerp(uy, u[1], pw); uz = lerp(uz, u[2], pw);
        fx = lerp(fx, f[0], pw); fy = lerp(fy, f[1], pw);
        hx = lerp(hx, h[0], pw); hy = lerp(hy, h[1], pw); hz = lerp(hz, h[2], pw);
      }
      if (gw > 0.001) {
        ux += (0.34 + gA * 0.3) * lead;
        uz += gB * 0.22 * sgn * lead;
        fx += (0.55 + gA * 0.45) * lead;
        hy += gB * 0.3 * sgn * lead;
      }

      _e1.set(cx, cy, cz);
      this.byName.get(`clavicle${s}`).quaternion.setFromEuler(_e1);
      _e1.set(ux, uy, uz);
      this.byName.get(`upperArm${s}`).quaternion.setFromEuler(_e1);
      _e1.set(fx, fy, 0);
      this.byName.get(`foreArm${s}`).quaternion.setFromEuler(_e1);
      _e1.set(hx, hy, hz);
      this.byName.get(`hand${s}`).quaternion.setFromEuler(_e1);
    }
    void dt;
    void elapsed;
  }

  /** Manual forward kinematics into rig space - cheaper than a matrix pass. */
  _runFK() {
    const bones = this.bones;
    for (let i = 0; i < bones.length; i++) {
      const p = this._parent[i];
      if (p < 0) {
        this._fkQuat[i].copy(bones[i].quaternion);
        this._fkPos[i].copy(bones[i].position);
      } else {
        this._fkQuat[i].copy(this._fkQuat[p]).multiply(bones[i].quaternion);
        this._fkPos[i].copy(this._rest[i]).applyQuaternion(this._fkQuat[p]).add(this._fkPos[p]);
      }
    }
  }

  _idx(name) {
    return this._index.get(name);
  }

  /** Convert a rig-space orientation into the bone's local rotation. */
  _setBoneFromRig(name, rigQuat) {
    const i = this._idx(name);
    const p = this._parent[i];
    const bone = this.bones[i];
    if (p < 0) bone.quaternion.copy(rigQuat);
    else bone.quaternion.copy(_q3.copy(this._fkQuat[p]).invert()).multiply(rigQuat);
    // Keep the cached chain in sync for anything solved further down.
    if (p < 0) this._fkQuat[i].copy(bone.quaternion);
    else this._fkQuat[i].copy(this._fkQuat[p]).multiply(bone.quaternion);
    return bone;
  }

  /* --- upper-body aim --------------------------------------------- */

  /**
   * Point the weapon at the target with both arms while the legs keep running
   * their own cycle. Solved as two-bone IK on hand targets derived from the aim
   * direction, then blended against the FK swing pose.
   */
  _poseAimArms() {
    const chest = this._fkPos[this._idx('spine03')];
    this._aimTargetRig.copy(this.aimTarget).applyMatrix4(this._invRoot);
    const aimDir = this._aimDir.subVectors(this._aimTargetRig, chest);
    aimDir.y -= 0.16;
    if (aimDir.lengthSq() < 1e-6) return;
    aimDir.normalize();
    const right = this._aimRight.crossVectors(aimDir, _up);
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();

    for (const s of ['R', 'L']) {
      const sgn = s === 'R' ? 1 : -1;
      const ui = this._idx(`upperArm${s}`);
      const fi = this._idx(`foreArm${s}`);
      const shoulder = this._fkPos[ui];
      // The right hand grips at the shoulder, the left supports further down
      // the barrel - a readable two-handed rifle stance.
      const reach = s === 'R' ? 0.2 : 0.44;
      const lateral = s === 'R' ? 0.115 : 0.02;
      const target = this._handTarget
        .copy(chest)
        .addScaledVector(aimDir, reach)
        .addScaledVector(right, lateral);
      target.y = chest.y + 0.16 + aimDir.y * reach;

      const pole = this._pole.set(sgn * 0.55, -0.85, 0.25).normalize();
      const joint = this._tmpPos;
      this._bendRef.copy(solveTwoBone(shoulder, target, this.upperArmLen, this.foreArmLen, pole, joint));

      _v3.subVectors(joint, shoulder).normalize();
      basisQuat(_v3, this._bendRef, this.restUpperArm[s], _fwd, _q1);
      _v3.subVectors(target, joint).normalize();
      basisQuat(_v3, this._bendRef, this.restForeArm[s], _fwd, _q2);

      const upper = this.bones[ui];
      const fore = this.bones[fi];
      const parentQ = this._fkQuat[this._parent[ui]];
      _q3.copy(parentQ).invert().multiply(_q1);
      upper.quaternion.slerp(_q3, this.aimWeight);
      this._fkQuat[ui].copy(parentQ).multiply(upper.quaternion);
      _q3.copy(this._fkQuat[ui]).invert().multiply(_q2);
      fore.quaternion.slerp(_q3, this.aimWeight);
      this._fkQuat[fi].copy(this._fkQuat[ui]).multiply(fore.quaternion);
    }
    // Wrists straighten onto the weapon.
    _e1.set(0.1, 0, -0.18);
    _q3.setFromEuler(_e1);
    this.bones[this._idx('handR')].quaternion.slerp(_q3, this.aimWeight * 0.85);
    _e1.set(0.1, 0, 0.24);
    _q3.setFromEuler(_e1);
    this.bones[this._idx('handL')].quaternion.slerp(_q3, this.aimWeight * 0.85);
  }

  /* --- legs -------------------------------------------------------- */

  _poseLegs(dt, useIK) {
    const P = this.P;
    const root = this.h.root;
    const scale = this.scale;
    const rootY = root.matrixWorld.elements[13];

    // 1. Foot targets in rig space, then ground probes in world space.
    for (const foot of this.feet) {
      const base = foot.local;
      base.set(
        P.legSideX * foot.side - this.runBlend * 0.022 * foot.side * this.moveBlend,
        P.ankleY + foot.lift,
        0.006 - foot.fwd
      );
      if (this.moveBlend < 0.35) {
        // Idle stance: the unloaded leg drifts back and out a touch.
        const unloaded = this.idleShift * foot.side < 0 ? 1 : 0;
        base.z += unloaded * 0.045 * (1 - this.moveBlend);
        base.x += unloaded * 0.012 * foot.side * (1 - this.moveBlend);
      }

      foot.probeTimer -= dt;
      if (useIK && foot.probeTimer <= 0) {
        foot.probeTimer = 0.05 + this._rnd() * 0.02;
        _v1.copy(base).applyMatrix4(root.matrixWorld);
        _v1.y += 0.55 * scale;
        const hit = this.physics?.raycast(_v1, _down, 1.5 * scale, COLLISION_LAYER.WORLD);
        if (hit) {
          foot.groundY = hit.point.y;
          foot.normal.copy(hit.normal);
          foot.groundValid = true;
        } else {
          foot.groundValid = false;
        }
      }

      if (useIK && foot.groundValid) {
        // Ground height expressed in rig units relative to the character root.
        const localGround = (foot.groundY - rootY) / scale;
        foot.rigGround = approach(foot.rigGround ?? localGround, localGround, 16, dt);
        base.y = foot.rigGround + P.ankleY + foot.lift;
      } else {
        foot.rigGround = 0;
      }
    }

    // 2. Pelvis height: follow the lower foot, then drop further if a leg
    //    would otherwise hyperextend on a slope or stair.
    const lowest = Math.min(this.feet[0].rigGround ?? 0, this.feet[1].rigGround ?? 0);
    this.groundOffset = approach(this.groundOffset, lowest, 11, dt);
    const pelvis = this.byName.get('pelvis');
    pelvis.position.y = P.pelvisY + this.groundOffset + this.pelvisBob - this.crouch * 0.24 - this.staggerT * this.staggerT * 0.09;
    this._runFK();

    let drop = 0;
    for (const foot of this.feet) {
      const hip = this._fkPos[this._idx(`thigh${foot.name}`)];
      const dist = hip.distanceTo(foot.local);
      const maxLen = this.legLen * 0.985;
      if (dist > maxLen) drop = Math.max(drop, dist - maxLen);
    }
    if (drop > 0.0005) {
      pelvis.position.y -= Math.min(drop, 0.3);
      this._runFK();
    }

    // 3. Two-bone IK per leg plus a foot roll that matches the gait.
    const poleBase = _v6;
    for (const foot of this.feet) {
      const hip = this._fkPos[this._idx(`thigh${foot.name}`)];
      poleBase.set(foot.side * 0.16, -0.15, -1).normalize();
      const joint = this._tmpPos;
      const bend = solveTwoBone(hip, foot.local, this.thighLen, this.calfLen, poleBase, joint);
      _v1.subVectors(joint, hip).normalize();
      basisQuat(_v1, bend, this.restThigh, _fwd, _q1);
      this._setBoneFromRig(`thigh${foot.name}`, _q1);
      _v1.subVectors(foot.local, joint).normalize();
      basisQuat(_v1, bend, this.restCalf, _fwd, _q2);
      this._setBoneFromRig(`calf${foot.name}`, _q2);

      // Heel strike -> roll through -> toe off.
      let pitch;
      if (foot.stance) {
        const s = foot.stanceT;
        pitch = -0.22 * Math.pow(1 - Math.min(1, s / 0.22), 2) + 0.5 * Math.pow(Math.max(0, s - 0.72) / 0.28, 2);
      } else {
        pitch = 0.35 * Math.pow(1 - foot.stanceT, 2) - 0.16 * foot.stanceT;
      }
      pitch *= this.moveBlend;

      let normalPitch = 0;
      let normalRoll = 0;
      if (useIK && foot.groundValid && foot.stance) {
        _v2.copy(foot.normal).transformDirection(this._invRoot).normalize();
        normalPitch = Math.asin(clamp(-_v2.z, -0.6, 0.6));
        normalRoll = Math.asin(clamp(_v2.x, -0.6, 0.6));
      }
      _e1.set(pitch + normalPitch, foot.turnYaw, -normalRoll);
      _q3.setFromEuler(_e1);
      // Foot orientation is authored relative to the character, not the calf.
      _q1.copy(this._fkQuat[this._idx(`calf${foot.name}`)]).invert().multiply(_q3);
      this.bones[this._idx(`foot${foot.name}`)].quaternion.copy(_q1);

      const toe = foot.stance ? Math.max(0, (foot.stanceT - 0.68) / 0.32) * 0.6 : 0;
      _e1.set(-toe * this.moveBlend, 0, 0);
      this.bones[this._idx(`toe${foot.name}`)].quaternion.setFromEuler(_e1);
    }
  }

  /* --- head, eyes -------------------------------------------------- */

  _poseHead(dt) {
    let wantYaw = this.glanceYaw;
    let wantPitch = 0;
    const src = this.aimTarget && this.aimWeight > 0.4 ? this.aimTarget : this.lookTarget;
    if (src) {
      _v1.copy(src).applyMatrix4(this._invRoot);
      _v1.y -= this.P.headY + 0.1;
      const yaw = Math.atan2(-_v1.x, -_v1.z);
      // Sign. A bone rotated by +x about its local X maps forward (0,0,-1) to
      // (0, sin x, -cos x) - positive is *up*. The pitch here was negated, so
      // every NPC tilted its head away from whatever it was tracking: stand
      // below one and it stares at the ceiling, stand above it and it studies
      // the floor. Measured directly (target 3 m above the head produced
      // head.rotation.x = -0.36) before changing it.
      const pitch = Math.atan2(_v1.y, Math.hypot(_v1.x, _v1.z));
      // Only track what the neck can plausibly reach.
      if (Math.abs(yaw) < 1.9) {
        wantYaw = clamp(yaw, -1.35, 1.35);
        wantPitch = clamp(pitch, -0.55, 0.5);
      }
    }
    this.headYaw = approach(this.headYaw, wantYaw, 7, dt);
    this.headPitch = approach(this.headPitch, wantPitch, 7, dt);

    // Chest already carries part of the aim; the rest splits neck/head.
    const chestYaw = this._chestYawApplied ?? 0;
    const y = this.headYaw - chestYaw;
    const stabilise = -this.pelvisBob * 2.2 * this.moveBlend;
    _e1.set(this.headPitch * 0.4 - this.flinchZ * 0.5, y * 0.38, -this.flinchX * 0.4 + this.pelvisSway * -0.5);
    this.byName.get('neck').quaternion.setFromEuler(_e1);
    _e1.set(
      this.headPitch * 0.6 + stabilise - this.flinchZ * 0.7,
      y * 0.62,
      -this.flinchX * 0.5
    );
    this.byName.get('head').quaternion.setFromEuler(_e1);
    // Refresh the two bones we just changed so the eye solver sees this frame.
    for (const name of ['neck', 'head']) {
      const i = this._idx(name);
      const p = this._parent[i];
      this._fkQuat[i].copy(this._fkQuat[p]).multiply(this.bones[i].quaternion);
      this._fkPos[i].copy(this._rest[i]).applyQuaternion(this._fkQuat[p]).add(this._fkPos[p]);
    }
  }

  _poseEyes(dt) {
    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0 && this._blinking <= 0) {
      this._blinking = 0.14;
      this.blinkTimer = 2.2 + this._rnd() * 4.5;
    }
    if (this._blinking > 0) {
      this._blinking -= dt;
      const t = clamp(1 - this._blinking / 0.14, 0, 1);
      this.blink = Math.sin(t * Math.PI);
    } else {
      this.blink = approach(this.blink, 0, 20, dt);
    }

    const target = this.aimTarget ?? this.lookTarget;
    const hi = this._idx('head');
    for (const eye of this.h.eyes) {
      if (target) {
        // Head-local space comes straight from the FK pass - no matrix walk.
        _v1.copy(target).applyMatrix4(this._invRoot).sub(this._fkPos[hi]);
        _q2.copy(this._fkQuat[hi]).invert();
        _v1.applyQuaternion(_q2).sub(eye.pivot.position);
        const yaw = clamp(Math.atan2(-_v1.x, -_v1.z), -0.5, 0.5);
        // Same inverted sign as the head solver had - the eyes were rolling the
        // opposite way to the thing they were supposed to be looking at.
        const pitch = clamp(Math.atan2(_v1.y, Math.hypot(_v1.x, _v1.z)), -0.35, 0.35);
        _e1.set(pitch, yaw, 0);
        eye.pivot.quaternion.slerp(_q1.setFromEuler(_e1), 1 - Math.exp(-14 * dt));
      } else {
        eye.pivot.quaternion.slerp(_q1.identity(), 1 - Math.exp(-6 * dt));
      }
      // The upper lid rests across the top of the iris on a real face; parking
      // it clear of the eyeball is what makes a character look startled.
      // headPitch is positive when the head is raised, so a raised head opens
      // the lid and a lowered one hoods it.
      const lidBase = 0.19 - this.headPitch * 0.12;
      eye.lidUpper.rotation.x = lidBase + this.blink * 0.92;
      eye.lidLower.rotation.x = -0.06 - this.blink * 0.28;
    }
  }

  /* --- death ------------------------------------------------------- */

  _updateDeath(dt) {
    this.deathT += dt;
    const B = this.byName;

    // Topple: a spring-driven rotation about a horizontal axis through the feet.
    const limit = this.deathFallLimit ?? 1.5;
    const accel = 9.0 * Math.sin(clamp(this.deathFall, 0, Math.PI * 0.5)) + 1.6;
    this.deathVel = (this.deathVel ?? 0.4) + accel * dt;
    this.deathFall += this.deathVel * dt;
    if (this.deathFall > limit) {
      // Ground contact: bleed off the momentum with a small bounce.
      this.deathFall = limit;
      this.deathVel *= -0.22;
      if (Math.abs(this.deathVel) < 0.35) this.deathVel = 0;
    }
    _q1.setFromAxisAngle(this.deathAxis, this.deathFall);
    this.h.rig.quaternion.copy(_q1);
    // Lift so the torso rests on the surface instead of intersecting it.
    this.h.rig.position.y = 0.13 * Math.sin(clamp(this.deathFall / limit, 0, 1) * Math.PI * 0.5);

    // Joints go slack at their own rates, which is what makes a fall read as
    // a body rather than a rotating statue.
    const targets = this._deathTargets;
    for (let i = 0; i < this.bones.length; i++) {
      const name = this.spec[i].name;
      const t = targets[name];
      if (!t) continue;
      const rate = this._deathVel[i] * 3.4;
      this.bones[i].quaternion.slerp(t, 1 - Math.exp(-rate * dt));
    }
    const pelvis = B.get('pelvis');
    pelvis.position.y = approach(pelvis.position.y, this.P.pelvisY * 0.82, 4.5, dt);
    pelvis.position.x = approach(pelvis.position.x, 0, 5, dt);
    pelvis.position.z = approach(pelvis.position.z, 0, 5, dt);

    for (const eye of this.h.eyes) {
      eye.lidUpper.rotation.x = 0.12 + 0.8 * clamp(this.deathT * 1.6, 0, 1);
      eye.lidLower.rotation.x = -0.06 - 0.22 * clamp(this.deathT * 1.6, 0, 1);
    }

    if (this.sinking && this.sink < 1) {
      this.sink = Math.min(1, this.sink + dt / 2.2);
      this.h.rig.position.y = 0.13 - this.sink * 2.1;
      if (this.sink >= 1) this.h.root.visible = false;
    }
  }
}
