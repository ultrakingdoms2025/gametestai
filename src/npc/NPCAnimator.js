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

/** The world-space fall direction, `die()` only. */
const _dv1 = new THREE.Vector3();
/**
 * How far from the feet the head ends up once the body has toppled.
 *
 * Measured, not assumed: driving the real `_updateDeath` to rest puts a point
 * 1.5 m up the standing body 1.48-1.50 m out from the feet. That is the column
 * whose ground decides whether the corpse lies on the floor or inside it.
 */
const DEATH_REACH = 1.45;
/**
 * How far the topple may be cut back on rising ground.
 *
 * 0.55 rad is 31.5 degrees off vertical - a body slumped against a steep bank,
 * which is the most a fall should ever be allowed to read as. Past that it
 * stops looking like a corpse and starts looking like somebody standing up, so
 * a slope steeper than about 50 degrees gets a body lying partly in it rather
 * than a body on its feet. That is the better of the two wrong pictures.
 */
const DEATH_MIN_FALL = 0.55;
/** Just shy of flat, so a body on falling ground lies down rather than hangs. */
const DEATH_MAX_FALL = 1.62;
// `_poseSeatedLegs` owns these exclusively: it calls solveTwoBone and
// basisQuat, both of which consume _v1.._v6 and _q1.._q3 internally, so reusing
// the shared scratch here would silently corrupt the second leg it solves.
const _seatFoot = new THREE.Vector3();
const _seatPole = new THREE.Vector3();
const _seatJoint = new THREE.Vector3();
const _seatDir = new THREE.Vector3();
const _seatBend = new THREE.Vector3();
const _seatQ = new THREE.Quaternion();
const _seatE = new THREE.Euler();

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
 * RAISING THE CARBINE, and the singularity the raise is routed around.
 *
 * The raised aim pose and the sprint-amplitude arm swing are very nearly
 * ANTIPODAL at the elbow: measured on the shipped code with a per-frame
 * quaternion probe, the two forearm endpoints of the crossfade slerp sit 177
 * to 180 degrees apart (about 128 of direction, the rest twist - the IK
 * layer's basisQuat resolves twist from the bend plane, the FK layer from
 * authored eulers). A slerp between two rotations 180 degrees apart is
 * genuinely ambiguous - which great circle it takes is the sign of a dot
 * product - and because the FK endpoint oscillates with the gait, that sign
 * FLIPS mid-blend: the forearm jumped 122-173 degrees in one frame at a blend
 * weight of ~0.37-0.56, on raising AND lowering. The player steps around the
 * whole crossfade (sprint keeps aimWeight at 1 and drops the muzzle target -
 * see PlayerAvatar's STOW_AHEAD), but an NPC's weight genuinely has to travel
 * 0 to 1, so here the crossfade itself is made safe.
 *
 * The route: below this weight the aim layer arms itself against an anchor
 * pose that IS the FK swing re-expressed by the solver - hand target on the
 * FK wrist, bend pole on the FK elbow, twist reference from the FK basis -
 * which reproduces it EXACTLY, so arming moves nothing whatever the gait is
 * doing. Above it the layer holds FULL authority and the hand targets sweep
 * from the live FK hands up onto the weapon on an arc around the shoulder -
 * a target-space path, which is continuous, and the honest animation: the
 * hands leave the run swing and carry the weapon up, still riding what
 * remains of the swing on the way. The slerp endpoints are far apart only
 * when the blend parameter is 1, where slerp is a copy and a great-circle
 * swap costs nothing. Hemisphere correction alone cannot fix
 * this (THREE's slerp already takes the short arc - the endpoints are REALLY
 * antipodal), and measurement, not fashion, ruled out the low-ready waypoint:
 * the hand-target construction pins the hands at chest height whatever the
 * aim direction, so a "lowered" target never comes near the running swing and
 * the 172-degree flip survived it (seed 1234, lowering, weight 0.44).
 *
 * The raise fraction has its own clock (AIM_RAISE_RATE) rather than being a
 * pure function of the weight: on lowering, `approach` decays the weight
 * multiplicatively - 1 to 0.35 in nine frames - and a sweep slaved to that
 * covered its ~270 degrees of combined travel at 80-90 degrees a frame.
 * Measured, and no shaping function can fix it: any raise-of-weight curve
 * that still reaches 0 rides the same nine frames. Writing `aimWeight`
 * DIRECTLY (PlayerAvatar's respawn park - "parked, not ramped") snaps the
 * raise with it, so a body spawned aiming is already holding the weapon up.
 */
const AIM_RAISE_START = 0.35;
/** How fast the hand targets sweep between the swing and the hold, 1/s. */
const AIM_RAISE_RATE = 2.0;

/* ------------------------------------------------------------------ */
/* Hands: grip, off hand and the melee track                           */
/* ------------------------------------------------------------------ */

/**
 * FINGER_DRIVER - how a hand closes on something.
 *
 * `Humanoid` gives each hand two driver bones, `fingers` and `thumb`, and
 * carries the axis to rotate them about on the bone spec itself (`def.axis`,
 * built by `handFrame`). A positive angle closes; zero is the bind pose, which
 * is now an OPEN hand. Before this existed the closure was baked into the
 * vertices, so every character in the game held every object with the same
 * permanently half-open hook and a weapon was simply pushed into it.
 *
 * The pairs below are [fingers, thumb], radians. They are targets, not poses:
 * `_poseHands` approaches them at GRIP_RATE, so a weapon switch closes and
 * reopens the hand over about a fifth of a second instead of snapping.
 *
 * The ceiling is deliberate. At ~1.05 rad the knuckle has folded 60 degrees
 * and the fingertips sit 7 cm clear of the palm slab, so the hand reads as a
 * closed fist without a rigid digit driving through the palm it is folding
 * onto - which is the price of one driver instead of three per digit.
 * @see FINGERS in Humanoid.js
 */
export const GRIPS = Object.freeze({
  /** Flat, fingers extended - a salute, a push, a held-out palm. */
  open: [0.05, 0.02],
  /** Nothing in the hand. The bind pose's old baked hook, restored honestly. */
  relaxed: [0.42, 0.10],
  fist: [1.05, 0.42],
  /** A pistol grip or a rifle's: fingers round a 30 mm section, thumb over. */
  grip: [0.80, 0.34],
  /** A sword hilt or a staff shaft - a fatter section, held harder. */
  hilt: [0.92, 0.30],
  /** Support hand under a handguard: open enough to be a rest, not a clamp. */
  fore: [0.62, 0.26],
  /** The bow hand. A riser is held, not squeezed, or the shot pulls. */
  riser: [0.70, 0.22],
  /** The string hand: two fingers hooked, thumb clear. */
  draw: [0.98, 0.14],
});

/** How fast a hand opens or closes onto a new grip, nepers/second. */
const GRIP_RATE = 11;

/**
 * What the arms do when nothing is in the hand.
 *
 * Shaped exactly like the resolved hold a weapon publishes (@see
 * NPCWeapons.weaponHold), so `_poseAimArms` has one code path and no null
 * checks scattered through it.
 */
const EMPTY_HOLD = Object.freeze({
  hands: 1,
  /* A MIRROR of the right hand, not zero. Zero would be the same offsets on
   * both sides, which puts the two fists at the identical point - the pose an
   * empty-handed character got the instant the prop was hidden (the character
   * preview does exactly that). Doubling the right hand's lateral back across
   * the centreline gives the symmetric guard an unarmed body should have. */
  along: 0,
  lateral: -0.23,
  drop: 0.06,
  right: 'relaxed',
  left: 'relaxed',
  wristR: [0.1, 0, -0.18],
  wristL: [0.1, 0, 0.24],
});

/**
 * THE OFF HAND USED TO GRIP AIR.
 *
 * The left hand's target was a hardcoded 0.44 m from the chest along the aim
 * direction, for every weapon. That number is not arbitrary and it is not
 * wrong - it is 36% of the way down a RIFLE's handguard, which is where a
 * support hand belongs. It was wrong for everything else: a pistol's muzzle is
 * 0.169 m from its grip (`WEAPON_MOUNTS`), the right hand grips at 0.20 m, so
 * 0.44 m put the left hand 7 cm past the end of the barrel, closing on nothing
 * at all. A staff is 1.08 m long and got the same 0.44.
 *
 * So the off hand is now derived from the weapon's own mount data, which each
 * model already publishes, and the constants below are only the RIGHT hand's -
 * the one thing that genuinely does not vary, because the grip is where the
 * prop is parented.
 */
const HAND_REACH = 0.2;
const HAND_LATERAL = 0.115;
/** Hand height above the chest bone at the aim hold, metres. */
const HAND_RISE = 0.16;
/** How fast the off hand travels between two weapons' holds, nepers/second. */
const HOLD_RATE = 9;

/**
 * A MELEE SWING IS A TARGET TRACK, NOT A NEW LAYER.
 *
 * `Sword` already emits `weapon:swing`, and until now the only listener in the
 * codebase played a sound: in third person the blade was swung by a body
 * standing perfectly still. The arc here rides the machinery that is already
 * present - the two-bone solver and the hand target it aims at - by displacing
 * the RIGHT hand's target through a wind-up and a cut. Nothing about the
 * blend, the twist routing or the pole vector changes, so the swing cannot
 * reintroduce the crossfade singularity AIM_RAISE_START exists to avoid: the
 * layer holds full authority throughout and only the point it is reaching for
 * moves, which is the same discipline the sprint stow uses.
 *
 * The timeline matches `Sword`'s own: wind-up to 0.2, the cut from 0.2 to
 * 0.56, recovery after. `SWING_TIME` is `WEAPON_STATS.sword.swingTime`,
 * duplicated rather than imported because the animator must not depend on the
 * weapon module - an NPC brawler swings too and has no `WeaponStats` entry.
 */
const SWING_TIME = 0.72;
/** Wind-up: up, back and across, in (right, up, aim) metres. */
const SWING_WIND = [0.24, 0.30, -0.18];
/** The end of the cut: down, forward and across to the far side. */
const SWING_CUT = [-0.34, -0.20, 0.20];
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

// `_twistRef` owns these three; nothing else in the aim solve may touch them.
const _twA = new THREE.Vector3();
const _twB = new THREE.Vector3();
const _twC = new THREE.Vector3();

/**
 * Constant-angular-rate blend between two unit vectors, in place in `a`.
 * The aim layer sweeps each wrist through ~120 degrees around the shoulder; a
 * plain nlerp more than doubles the angular rate at the middle of an arc that
 * wide (the interpolant cuts the chord and gets renormalised), and that
 * amplification alone was a third of the sweep's worst frame. Falls back to
 * the chord when the pair is too straight or too antipodal to define a plane.
 */
function slerpDir(a, b, t) {
  const d = clamp(a.dot(b), -1, 1);
  const ang = Math.acos(d);
  const sa = Math.sin(ang);
  if (sa > 1e-4 && ang < Math.PI - 0.05) {
    a.multiplyScalar(Math.sin((1 - t) * ang) / sa).addScaledVector(b, Math.sin(t * ang) / sa);
    return a;
  }
  a.multiplyScalar(1 - t).addScaledVector(b, t);
  if (a.lengthSq() < 1e-6) a.copy(b);
  else a.normalize();
  return a;
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
  // Sitting on a bench: hands resting on the thighs, shoulders relaxed back.
  // The leg half of the pose is solved geometrically in `_poseSeatedLegs`,
  // because a seat's height varies and hard-coded knee angles would leave a
  // character hovering over a low bench or kneeling on a tall one.
  sit: {
    chest: 0.06,
    hip: 0.05,
    clavicle: (s) => [0.01, 0, -0.06 * s],
    upperArm: (s) => [0.52, 0.1 * s, 0.28 * s],
    foreArm: () => [0.72, 0, 0],
    hand: (s) => [0.28, 0.06 * s, -0.12 * s],
  },
  // Sitting with the forearms on the knees, leaning in - the other half of the
  // bench read, so two seated characters side by side are not the same statue.
  sitLean: {
    chest: 0.3,
    hip: 0.04,
    clavicle: (s) => [0.05, 0, -0.16 * s],
    upperArm: (s) => [0.74, 0.16 * s, 0.24 * s],
    foreArm: () => [1.05, 0, 0],
    hand: (s) => [0.2, 0.12 * s, -0.14 * s],
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
    /* The rest-frame vector that plays basisQuat's `ref` role for a bone: feed
     * basisQuat `q * twistRef(restDir)` as the ref alongside direction
     * `q * restDir` and it returns exactly `q` - rotation distributes over the
     * cross products, so the whole basis reproduces. This is how the aim layer
     * hands the solver the FK pose's own twist convention (@see AIM_RAISE_START).
     * Mirrors basisQuat's rest-side construction, fallbacks included. */
    const twistRef = (restDir) => {
      const a1 = new THREE.Vector3().crossVectors(_fwd, restDir);
      if (a1.lengthSq() < 1e-10) a1.crossVectors(_up, restDir);
      if (a1.lengthSq() < 1e-10) a1.set(1, 0, 0);
      a1.normalize();
      return new THREE.Vector3().crossVectors(restDir, a1).normalize();
    };
    this.twistRefUpperArm = { R: twistRef(this.restUpperArm.R), L: twistRef(this.restUpperArm.L) };
    this.twistRefForeArm = { R: twistRef(this.restForeArm.R), L: twistRef(this.restForeArm.L) };

    /* ── Landmarks come off the BONE TABLE, not off the archetype ──────────
     *
     * `makeProportions` describes a canonical 1.78 m person; `buildSkeletonSpec`
     * is what a character is actually built and skinned to, and for the ape
     * body plan the two are deliberately different heights - the hips sit 24 cm
     * lower on a rig whose crown is only 6 cm lower.
     *
     * Every one of these was `this.P.<field>` and every one of them is still
     * exactly equal to it for a person - pinned to the bit by "reading
     * landmarks off the rig gives a person exactly what the archetype did" in
     * npc-ape-proportions.test.mjs. Reading them from the rig is simply the
     * honest source: the solver drives bones, so it should measure bones. */
    const at = (name) => spec.find((s) => s.name === name).pos;
    this.P = {
      ...this.P,
      pelvisY: at('pelvis')[1],
      hipY: at('thighR')[1],
      chestY: at('spine03')[1],
      headY: at('head')[1],
      ankleY: at('footR')[1],
      legSideX: at('thighR')[0],
    };

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
    this._aimWeight = 0;
    this._aimRaise = 0;
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

    /* --- hands ------------------------------------------------------
     * Resolved once: the driver bone indices and the axis each rotates
     * about, straight off the bone spec. `null` on a rig built before the
     * finger bones existed (or a stub one in a test), and every hand path
     * below is a no-op in that case rather than a crash. @see FINGER_DRIVER */
    this._hands = null;
    const fi = this._index.get('fingersR');
    if (fi !== undefined && spec[fi].axis) {
      const ax = (n) => {
        const d = spec[this._index.get(n)];
        return new THREE.Vector3(d.axis[0], d.axis[1], d.axis[2]);
      };
      this._hands = {
        R: { f: this._index.get('fingersR'), t: this._index.get('thumbR'), a: ax('fingersR') },
        L: { f: this._index.get('fingersL'), t: this._index.get('thumbL'), a: ax('fingersL') },
      };
    }
    /** Live curl angles, [fingers, thumb] per side. @see GRIPS */
    this._curl = { R: [0, 0], L: [0, 0] };
    this._curlSeeded = false;
    /** The resolved hold published by whatever is in the right hand. */
    this._hold = EMPTY_HOLD;
    /** Damped off-hand offsets, so a weapon switch sweeps instead of jumping. */
    this._off = { along: 0, lateral: 0, drop: 0 };
    this._offSeeded = false;
    this._wristR = EMPTY_HOLD.wristR.slice();
    this._wristL = EMPTY_HOLD.wristL.slice();
    /** Melee arc: -1 when idle, else seconds into the swing. @see SWING_TIME */
    this._swingT = -1;
    this._swingDir = 1;

    this.blinkTimer = 1 + rnd() * 4;
    this.blink = 0;
    this._blinking = 0;

    this.postureKind = 'none';
    this.posturePose = null;
    this.postureWeight = 0;
    this.gestureWeight = 0;
    this._gesturePhase = rnd() * 6.28;

    // Seated state. `seatHeight` is the drop from the seat surface to the floor
    // the feet rest on, which is what lets one solver serve a 0.38 m bench and a
    // 0.62 m planter rim without either looking wrong.
    this.seated = false;
    this.seatHeight = 0.45;
    this.seatWeight = 0;
    this._seatSwayPhase = rnd() * 6.28;

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
    // Per-bone unwrapped twist azimuth for the aim raise; null = re-anchor.
    // @see _twistRef
    this._twistPhi = { uR: null, uL: null, fR: null, fL: null };
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
   * Blend authority of the aim layer, 0..1. Reads exactly as it always has.
   * WRITING it is the parking gesture (PlayerAvatar's respawn snap - "parked,
   * not ramped"): a write to either end also parks the raise fraction there,
   * so a body spawned at weight 1 is already holding the weapon up rather
   * than spending half a second sweeping into the hold. Mid-band writes leave
   * the raise to its own clock. @see AIM_RAISE_RATE
   */
  get aimWeight() {
    return this._aimWeight;
  }

  set aimWeight(v) {
    this._aimWeight = v;
    if (v >= 0.999) this._aimRaise = 1;
    else if (v <= 0.001) this._aimRaise = 0;
  }

  /**
   * Start a melee arc on the right arm.
   *
   * Idempotent within a swing on purpose: a second call restarts the track, so
   * a combo re-triggers the arc rather than queueing one. It rides the aim
   * layer, so it is visible exactly when the arms are up - which for the
   * player is always (`PlayerAvatar` parks `aimWeight` at 1 against a live
   * target) and for an NPC brawler is whenever it has closed to its target.
   *
   * @param {number} [dir] +1 cuts right-to-left, -1 left-to-right, matching
   *   the `dir` field on `Sword`'s `weapon:swing` event.
   * @see SWING_TIME
   */
  meleeSwing(dir = 1) {
    this._swingT = 0;
    this._swingDir = dir < 0 ? -1 : 1;
  }

  /** True while a melee arc is in flight. */
  get swinging() {
    return this._swingT >= 0;
  }

  /**
   * The hold published by whatever is actually in the right hand.
   *
   * Read off the prop rather than told to us, because the two callers that
   * own weapons - `HostileNPC` and `PlayerAvatar` - already parent the model
   * to `humanoid.weaponMount` and already know which one is showing.
   * `HostileNPC` in particular prebuilds every model it could ever draw and
   * switches with a `visible` flip, so the visible child IS the weapon and
   * anything else would be a second copy of that state to keep in step.
   *
   * @returns {typeof EMPTY_HOLD}
   */
  _readHold() {
    const kids = this.h.weaponMount?.children;
    if (kids) {
      for (let i = kids.length - 1; i >= 0; i--) {
        const k = kids[i];
        if (k.visible && k.userData?.hold) return k.userData.hold;
      }
    }
    return EMPTY_HOLD;
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
   * @param {'none'|'crossed'|'hips'|'pocket'|'lean'|'squat'|'sit'|'sitLean'} kind
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

  /**
   * Sit the character down on a surface `seatHeight` metres above the floor.
   *
   * The character root stays on the seat surface, so gameplay - the capsule,
   * the headshot sphere, chat range, the contact shadow - needs no special
   * case. Only the legs change: they are solved down and forward to the floor
   * instead of being driven by the walk cycle, and the foot ground probes are
   * skipped because a seated character's feet are not carrying it.
   *
   * @param {boolean} on
   * @param {number} [seatHeight] metres from the seat surface down to the floor
   */
  setSeated(on, seatHeight) {
    this.seated = !!on;
    if (Number.isFinite(seatHeight)) this.seatHeight = clamp(seatHeight, 0.28, 0.72);
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

  /**
   * How far the body may topple here, given what it would be toppling ONTO.
   *
   * ── The defect ────────────────────────────────────────────────────────────
   * Reported live: "if i kill them near stairs, they fall down behind the
   * stairs". `_updateDeath` topples the whole rig about a horizontal axis
   * through the FEET and makes no collision query of any kind - the animator's
   * only raycast is in `_poseLegs`, and `update()` returns straight after
   * `_updateDeath`, so on a corpse it is unreachable. The single concession to
   * the ground is a flat +0.13 m lift.
   *
   * Measured by driving the real `_updateDeath` to rest: the topple settles at
   * 81-90 degrees in 0.80 s and the head ends 1.48-1.50 m out from the feet,
   * having dropped 1.15-1.38 m. On flat ground the 0.13 m is right. On a
   * flight it is not - the tread 1.45 m along is over a metre HIGHER - so the
   * body ends about a metre inside the staircase. And it is the ordinary shot
   * that does it: `applyDamage` builds the impact direction as
   * (npc.position - source.position), so a target standing ABOVE the player
   * always topples INTO the flight.
   *
   * ── Why the ANGLE and not the direction ──────────────────────────────────
   * Turning the fall to find flat ground was written first and measured wrong.
   * A staircase has no flat bearing: across the flight is off the side and a
   * 1.6 m drop, down-flight is a metre below, and the 45 degree compromise it
   * actually chose still landed the head 0.80 m inside the steps. A body on
   * stairs does not need a flat spot - it needs to lie ALONG the slope.
   *
   * So the direction is left exactly as the shot implied, and the fall stops
   * where the body meets the surface instead. The slope over one body length
   * is atan(rise / reach), which for the two flights this game builds is 39-42
   * degrees - not the 62 an earlier draft got by reaching for asin. Ninety
   * degrees minus that is a body sprawled up the steps, which is what it
   * should look like.
   *
   * Falling ground widens the limit rather than narrowing it, capped just shy
   * of flat, so a body toppling down-flight lies flatter instead of hanging.
   */
  _deathFallLimit(dirWorld, base) {
    const phys = this.physics;
    if (!phys?.groundHeight) return base;
    this.h.root.updateMatrixWorld(true);
    const m = this.h.root.matrixWorld.elements;
    const fx = m[12], fy = m[13], fz = m[14];
    const g = phys.groundHeight(fx + dirWorld.x * DEATH_REACH, fz + dirWorld.z * DEATH_REACH, fy + 3, 7);
    // No floor within the probe at all - an edge. Leave the fall alone; a body
    // draped over a drop is the animation working, not a burial.
    if (g == null) return base;
    const slope = Math.atan2(g - fy, DEATH_REACH);
    return clamp(base - slope, DEATH_MIN_FALL, DEATH_MAX_FALL);
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
    _dv1.copy(dirWorld ?? _fwd).setY(0);
    if (_dv1.lengthSq() < 1e-6) _dv1.set(0, 0, -1);
    _dv1.normalize();
    const jitter = (this._rnd() - 0.5) * 0.9;
    _e1.set(0, jitter, 0);
    _q1.setFromEuler(_e1);
    _dv1.applyQuaternion(_q1);

    // Into the rig's frame, which is where the topple is applied.
    _v1.copy(_dv1).transformDirection(this._invRoot4()).setY(0);
    if (_v1.lengthSq() < 1e-6) _v1.set(0, 0, -1);
    _v1.normalize();
    // Topple axis is horizontal and perpendicular to the fall direction.
    this.deathAxis.crossVectors(_up, _v1).normalize();
    // Stop where the body meets the ground it is falling onto, which on flat
    // ground is exactly where it always stopped. @see _deathFallLimit
    this.deathFallLimit = this._deathFallLimit(_dv1, 1.42 + this._rnd() * 0.16);

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
    // The hands were just flattened along with everything else, so the grip is
    // re-seeded rather than ramped: a recycled body comes back already holding
    // its weapon. @see _poseHands
    this._curlSeeded = false;
    this._swingT = -1;
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
    this._poseHands(dt);
    this._runFK();
    if (this.aimWeight > 0.001 && this.aimTarget) this._poseAimArms();
    if (this.seated || this.seatWeight > 0.02) this._poseSeatedLegs(dt);
    else this._poseLegs(dt, lod.ik !== false);
    this._poseHead(dt);
    if (lod.detail !== false) this._poseEyes(dt);
  }

  _updateBlend(dt) {
    const s = this.speed;
    this.runBlend = approach(this.runBlend, smoothstep(2.2, 3.6, s), 8, dt);
    this.moveBlend = approach(this.moveBlend, smoothstep(0.1, 0.85, s), 12, dt);
    this.aimWeight = approach(this.aimWeight, this._aimWant, 7, dt);
    // The raise sweep runs on its own clock; the weight only tells it where
    // to go. Rate-limited, not approached: a linear sweep has no fast head to
    // outrun the arms and no long tail to hang the weapon halfway. @see
    // AIM_RAISE_RATE for why it cannot simply be a function of the weight.
    const raiseWant = smoothstep(AIM_RAISE_START, 1, this._aimWeight);
    const cap = AIM_RAISE_RATE * dt;
    this._aimRaise += clamp(raiseWant - this._aimRaise, -cap, cap);

    /* The hold, and the off hand's travel between two of them.
     *
     * Damped on the OFFSETS, which are the target's coordinates, and never on
     * the arm's rotation - the same rule AIM_RAISE_START is built on. Two
     * holds can put the off hand a long way apart (0.24 m up a rifle's
     * handguard versus hanging at the hip beside a pistol) and slerping the
     * shoulder between those two poses is the antipodal configuration this
     * file spent a whole crossfade rewrite escaping. Moving the point instead
     * keeps the solver at full authority and sweeps the arm as one piece.
     *
     * The first frame SNAPS: a body spawned holding a rifle is already holding
     * it, exactly as `aimWeight`'s setter parks the raise. @see EMPTY_HOLD */
    const hold = this._readHold();
    this._hold = hold;
    const off = this._off;
    // Written out rather than run through a helper: this file allocates
    // nothing per frame, and a closure is an allocation. @see the scratch
    // block at the top.
    const holdK = this._offSeeded ? 1 - Math.exp(-HOLD_RATE * dt) : 1;
    this._offSeeded = true;
    off.along += (hold.along - off.along) * holdK;
    off.lateral += (hold.lateral - off.lateral) * holdK;
    off.drop += (hold.drop - off.drop) * holdK;
    for (let i = 0; i < 3; i++) {
      this._wristR[i] += (hold.wristR[i] - this._wristR[i]) * holdK;
      this._wristL[i] += (hold.wristL[i] - this._wristL[i]) * holdK;
    }
    if (this._swingT >= 0) {
      this._swingT += dt;
      if (this._swingT >= SWING_TIME) this._swingT = -1;
    }
    this.postureWeight = approach(this.postureWeight, this.posturePose ? 1 : 0, 3.2, dt);
    // Sitting down and standing up are both fast; the ramp exists so neither is
    // a single-frame pop, not to animate a deliberate movement.
    this.seatWeight = approach(this.seatWeight, this.seated ? 1 : 0, 4.5, dt);
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
   * The twist reference the aim solve hands basisQuat for one bone during a
   * raise: the FK pose's own reference, swung about the bone direction toward
   * the bend-plane reference by `raise`.
   *
   * Interpolated as an AZIMUTH about `dir`, not as a free 3D vector. Both
   * references lean well out of the plane perpendicular to the bone (the
   * bend ref sits within 25 degrees of the bone axis itself on the ape rig),
   * and the great-circle path between two such vectors passes close to the
   * axis - where its projection, the only part basisQuat reads, whips through
   * half a turn in a couple of frames. Measured before this existed: 50.9
   * degrees of forearm in one frame on the ape's left arm, mid-raise.
   *
   * The azimuth is unwrapped against the previous frame (`_twistPhi`)
   * because the two conventions sit near 180 degrees apart on some rigs,
   * where "the short way round" is ambiguous and gait noise flipped it
   * mid-sweep. The anchor is dropped (null) whenever the sweep is parked, so
   * a fresh raise starts from the honest shortest path; a stale branch can
   * only survive across the raise<->hold boundary, where `raise` is within a
   * hair of 1 and every branch lands on the same vector.
   */
  _twistRef(key, fkRef, bendRef, dir, raise) {
    _twA.copy(fkRef).addScaledVector(dir, -fkRef.dot(dir));
    _twB.copy(bendRef).addScaledVector(dir, -bendRef.dot(dir));
    const la = _twA.lengthSq();
    const lb = _twB.lengthSq();
    if (la < 1e-8) {
      this._twistPhi[key] = null;
      return lb < 1e-8 ? bendRef : _twB.multiplyScalar(1 / Math.sqrt(lb));
    }
    _twA.multiplyScalar(1 / Math.sqrt(la));
    if (lb < 1e-8) {
      this._twistPhi[key] = null;
      return _twA;
    }
    _twB.multiplyScalar(1 / Math.sqrt(lb));
    // Signed azimuth from the FK reference to the bend reference, about dir.
    _twC.crossVectors(_twA, _twB);
    let phi = Math.atan2(_twC.dot(dir), clamp(_twA.dot(_twB), -1, 1));
    const prev = this._twistPhi[key];
    if (raise > 0 && prev !== null) {
      while (phi - prev > Math.PI) phi -= Math.PI * 2;
      while (phi - prev < -Math.PI) phi += Math.PI * 2;
    }
    this._twistPhi[key] = raise > 0 ? phi : null;
    const th = phi * raise;
    _twC.crossVectors(dir, _twA);
    return _twA.multiplyScalar(Math.cos(th)).addScaledVector(_twC, Math.sin(th));
  }

  /**
   * Close each hand onto whatever it is holding.
   *
   * Two bones a hand, one scalar each, absolute (not additive): nothing else
   * writes these bones, so there is nothing to blend against. The whole cost
   * is four `setFromAxisAngle` calls and four `approach`es per character.
   *
   * Measured on this machine, node 22, one aiming character at 60 Hz over
   * 40 000 updates: `update` is 7.31 us, of which this is 0.201 us (2.7%), and
   * the four extra bones add 0.037 us to `_runFK` (which runs at 0.009 us a
   * bone). 0.24 us a character - under 4 us a frame for a sixteen-strong
   * crowd, against a 16.7 ms budget. That is the price of the whole feature.
   *
   * The OFF hand only takes the weapon's grip once the weapon is actually up
   * there. A rifle carried at the side has one hand on it; the support hand
   * arrives with the raise, and `_aimRaise` is exactly the fraction that
   * already describes that journey.
   *
   * @see FINGER_DRIVER @see GRIPS
   */
  _poseHands(dt) {
    const H = this._hands;
    if (!H) return;
    const hold = this._hold;
    const onWeapon = hold.hands === 2 && this._aimRaise > 0.5;
    const seed = !this._curlSeeded;
    this._curlSeeded = true;
    for (const s of ['R', 'L']) {
      const want = GRIPS[s === 'R' ? hold.right : onWeapon ? hold.left : 'relaxed'] ?? GRIPS.relaxed;
      const c = this._curl[s];
      c[0] = seed ? want[0] : approach(c[0], want[0], GRIP_RATE, dt);
      c[1] = seed ? want[1] : approach(c[1], want[1], GRIP_RATE, dt);
      const h = H[s];
      this.bones[h.f].quaternion.setFromAxisAngle(h.a, c[0]);
      this.bones[h.t].quaternion.setFromAxisAngle(h.a, c[1]);
    }
  }

  /**
   * Displace the right hand's target through the melee arc, in place.
   *
   * Wind-up and cut are two overlapping envelopes rather than one waypoint
   * path, so the hand never stops at the top of the swing - a hand that
   * arrives, pauses and leaves reads as two animations, which is what a
   * key-framed waypoint gives you for free. @see SWING_TIME
   */
  _applySwing(target, aimDir, right) {
    const t = this._swingT / SWING_TIME;
    // Peaks at the top of the wind-up, gone by the end of the cut.
    const w = smoothstep(0, 0.2, t) * (1 - smoothstep(0.2, 0.56, t));
    // Rises through the cut, decays through the recovery.
    const c = smoothstep(0.2, 0.56, t) * (1 - smoothstep(0.62, 1, t));
    /* `dir` is +1 for a cut that ENDS on the player's left (Sword's bearing
     * runs +half -> -half, positive left), so the hand winds up on the left
     * and finishes on the right: the lateral term is negated, the vertical
     * and forward ones are not. */
    const sgn = -this._swingDir;
    target.addScaledVector(right, sgn * (SWING_WIND[0] * w + SWING_CUT[0] * c));
    target.y += SWING_WIND[1] * w + SWING_CUT[1] * c;
    target.addScaledVector(aimDir, SWING_WIND[2] * w + SWING_CUT[2] * c);
  }

  /**
   * Point the weapon at the target with both arms while the legs keep running
   * their own cycle. Solved as two-bone IK on hand targets derived from the aim
   * direction, then blended against the FK swing pose.
   *
   * The crossfade is ROUTED, not straight - see AIM_RAISE_START. `blend` is
   * how much authority the IK layer has (saturates at AIM_RAISE_START);
   * `raise` is how far up the weapon is (0 = hands still on the FK swing,
   * 1 = the aim hold). At aimWeight 1 both are 1 and the pose is exactly the
   * pre-routing aim pose, so a parked weight (the player) is untouched.
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

    const raise = this._aimRaise;
    // Full authority the moment the hands leave the swing: a mid-strength
    // slerp against a mid-raise pose is exactly the ambiguous configuration
    // this routing exists to avoid. While the raise is parked at 0 the anchor
    // IS the FK pose, so the ramp below moves nothing and only arms the layer.
    const blend = raise > 0 ? 1 : smoothstep(0, AIM_RAISE_START, this.aimWeight);

    for (const s of ['R', 'L']) {
      const sgn = s === 'R' ? 1 : -1;
      const ui = this._idx(`upperArm${s}`);
      const fi = this._idx(`foreArm${s}`);
      const shoulder = this._fkPos[ui];
      /* The right hand grips where the prop is parented; the left goes
       * wherever the weapon in that hand says its off hand belongs - somewhere
       * along grip -> muzzle for a two-hander, out and down as a counterweight
       * for anything held in one. @see HAND_REACH */
      const off = this._off;
      const reach = s === 'R' ? HAND_REACH : HAND_REACH + off.along;
      const lateral = s === 'R' ? HAND_LATERAL : HAND_LATERAL + off.lateral;
      const target = this._handTarget
        .copy(chest)
        .addScaledVector(aimDir, reach)
        .addScaledVector(right, lateral);
      target.y = chest.y + HAND_RISE + aimDir.y * reach - (s === 'R' ? 0 : off.drop);
      if (s === 'R' && this._swingT >= 0) this._applySwing(target, aimDir, right);

      const pole = this._pole.set(sgn * 0.55, -0.85, 0.25).normalize();
      if (raise < 1) {
        // On the way up (or down) the target rides the LIVE FK hand, and the
        // bend plane rides the LIVE FK elbow - both read before this arm's
        // chain is overwritten, so they are this frame's swing. With both
        // anchored, the solve at raise 0 reproduces the swing pose's own
        // joint, and the only endpoint gap left for the blend to cross is the
        // twist convention, carried by the refs below. The wrist sweeps on an
        // ARC around the shoulder rather than a chord between the two points:
        // the chord passes close to the elbow and the forearm direction whips
        // through the close pass - 37 degrees in a frame on the long-armed
        // ape rig, measured - where the arc keeps a steady angular rate. It
        // is also the honest path: hands come up around the shoulder, they do
        // not cut through the torso.
        _v1.subVectors(target, shoulder);
        _v2.subVectors(this._fkPos[this._idx(`hand${s}`)], shoulder);
        const lHold = _v1.length() || 1e-6;
        const lSwing = _v2.length() || 1e-6;
        _v1.multiplyScalar(1 / lHold);
        _v2.multiplyScalar(1 / lSwing);
        slerpDir(_v2, _v1, raise);
        target.copy(shoulder).addScaledVector(_v2, lerp(lSwing, lHold, raise));
        _v3.subVectors(this._fkPos[fi], shoulder); // FK elbow, in rig space
        if (_v3.lengthSq() > 1e-8) pole.lerp(_v3.normalize(), 1 - raise);
        if (pole.lengthSq() > 1e-8) pole.normalize();
        else pole.set(sgn * 0.55, -0.85, 0.25).normalize();
      }
      const joint = this._tmpPos;
      this._bendRef.copy(solveTwoBone(shoulder, target, this.upperArmLen, this.foreArmLen, pole, joint));

      /* The twist convention rides the raise the same way the targets do.
       * basisQuat resolves a bone's roll from its `ref` argument; the bend
       * plane's ref and the FK pose's own ref sit up to ~175 degrees apart
       * around the forearm, and that gap was the larger half of the antipodal
       * pair. Handing the solver the FK pose's ref at raise 0 makes the solve
       * reproduce the FK pose EXACTLY - swing (target and pole above) and
       * twist (here) - so the blend below has nothing to jump across, and
       * `_twistRef` swings one ref onto the other continuously. `_fkQuat`
       * still holds this frame's pure FK for both bones: the loop only
       * overwrites them after this point. */
      _v3.subVectors(joint, shoulder).normalize();
      let ref = this._bendRef;
      if (raise < 1) {
        _v1.copy(this.twistRefUpperArm[s]).applyQuaternion(this._fkQuat[ui]);
        ref = this._twistRef(s === 'R' ? 'uR' : 'uL', _v1, this._bendRef, _v3, raise);
      }
      basisQuat(_v3, ref, this.restUpperArm[s], _fwd, _q1);
      _v3.subVectors(target, joint).normalize();
      ref = this._bendRef;
      if (raise < 1) {
        _v1.copy(this.twistRefForeArm[s]).applyQuaternion(this._fkQuat[fi]);
        ref = this._twistRef(s === 'R' ? 'fR' : 'fL', _v1, this._bendRef, _v3, raise);
      }
      basisQuat(_v3, ref, this.restForeArm[s], _fwd, _q2);

      const upper = this.bones[ui];
      const fore = this.bones[fi];
      const parentQ = this._fkQuat[this._parent[ui]];
      _q3.copy(parentQ).invert().multiply(_q1);
      upper.quaternion.slerp(_q3, blend);
      this._fkQuat[ui].copy(parentQ).multiply(upper.quaternion);
      _q3.copy(this._fkQuat[ui]).invert().multiply(_q2);
      fore.quaternion.slerp(_q3, blend);
      this._fkQuat[fi].copy(this._fkQuat[ui]).multiply(fore.quaternion);
    }
    /* Wrists roll onto the weapon. These ride the raw weight, exactly as they
     * always did: their two endpoints are only 6-9 degrees apart, so the
     * weight's own continuous ramp was never part of the singularity.
     *
     * They used to be two literals for every weapon, which is the same defect
     * as the off hand's 0.44 one joint further out: a bow's draw hand and a
     * rifle's support hand do not hold the wrist the same way. The angles now
     * come from the hold, damped alongside the off-hand offsets. */
    const wr = this._wristR;
    const wl = this._wristL;
    _e1.set(wr[0], wr[1], wr[2]);
    _q3.setFromEuler(_e1);
    this.bones[this._idx('handR')].quaternion.slerp(_q3, this.aimWeight * 0.85);
    _e1.set(wl[0], wl[1], wl[2]);
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

  /* --- seated ------------------------------------------------------ */

  /*
   * Dedicated scratch for the seated solver. `_poseLegs` and `solveTwoBone`
   * between them consume _v1.._v6 and _q1.._q3; sharing any of those here is
   * exactly the aliasing bug the module header warns about, so the seated pose
   * owns its own vectors outright.
   */

  /**
   * Sit the legs down instead of walking them.
   *
   * The character root is on the seat surface, so the hips only have to drop to
   * just above it, the knees go forward, and the feet reach down to the floor
   * `seatHeight` below. Solving the ankle position geometrically rather than
   * hard-coding joint angles is what lets the same code sit a figure on a
   * 0.38 m bench slat and on a 0.6 m planter rim.
   *
   * The upper body is untouched - breathing, the posture layer, gestures, the
   * head and eye tracking all keep running, which is the whole point: a seated
   * character still has to look alive from the waist up.
   */
  _poseSeatedLegs(dt) {
    const P = this.P;
    const w = this.seatWeight;
    const pelvis = this.byName.get('pelvis');

    // Slow weight shift on the seat, plus the breathing already in pelvisBob.
    this._seatSwayPhase += dt * 0.55;
    const sway = Math.sin(this._seatSwayPhase) * 0.014 + this.idleShift * 0.012;
    const seatHipY = 0.09 + (P.pelvisY - P.hipY);
    pelvis.position.set(
      lerp(this.pelvisSway, sway, w),
      lerp(P.pelvisY + this.groundOffset + this.pelvisBob, seatHipY + this.pelvisBob * 0.4, w),
      lerp(0, -0.035, w)
    );
    this._runFK();

    const floorY = P.ankleY - this.seatHeight;
    for (const foot of this.feet) {
      const hipIdx = this._idx(`thigh${foot.name}`);
      const hip = this._fkPos[hipIdx];
      // Feet a little wider than the hips and set forward of the knee, which is
      // how people actually sit; dead-vertical shins read as a mannequin.
      const seatX = P.legSideX * foot.side * 1.25 + foot.side * 0.012 * Math.sin(this._seatSwayPhase * 0.7);
      const seatZ = -0.30 - this.seatHeight * 0.12;
      _seatFoot.set(
        lerp(P.legSideX * foot.side, seatX, w),
        lerp(P.ankleY, floorY, w),
        lerp(0.006, seatZ, w)
      );

      // Knee pole forward and slightly up: the knee is the leading point of a
      // seated leg, and a pole pointing anywhere else folds the shin backwards.
      _seatPole.set(foot.side * 0.1, 0.32, -1).normalize();
      const bend = solveTwoBone(hip, _seatFoot, this.thighLen, this.calfLen, _seatPole, _seatJoint);
      _seatBend.copy(bend);

      _seatDir.subVectors(_seatJoint, hip).normalize();
      basisQuat(_seatDir, _seatBend, this.restThigh, _fwd, _seatQ);
      this._setBoneFromRig(`thigh${foot.name}`, _seatQ);
      _seatDir.subVectors(_seatFoot, _seatJoint).normalize();
      basisQuat(_seatDir, _seatBend, this.restCalf, _fwd, _seatQ);
      this._setBoneFromRig(`calf${foot.name}`, _seatQ);

      // Foot flat on the floor: rig-space identity is the rest orientation,
      // which is a level foot by construction.
      _seatQ.identity();
      this._setBoneFromRig(`foot${foot.name}`, _seatQ);
      _seatE.set(0, 0, 0);
      this.bones[this._idx(`toe${foot.name}`)].quaternion.setFromEuler(_seatE);

      foot.groundValid = false;
      foot.rigGround = 0;
      foot.lift = 0;
      foot.fwd = 0;
    }
    this.groundOffset = 0;
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
