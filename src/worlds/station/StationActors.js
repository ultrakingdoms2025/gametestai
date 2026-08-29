import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32, uvScale } from './StationKit.js';
/* The map editor's opt-out. These eleven meshes are the world's whole fixed
 * population in one instanced buffer each: a remove of `StationActors:head`
 * would decapitate 1,887 people with a green row, and a move would translate
 * all of them and drag every collider inside a 1,235 m box, uncapped. They are
 * not objects an admin can mean to move. */
import { NOT_EDITABLE } from '../../systems/mapEditable.js';

/**
 * Multi-part instanced figures for the four outer zones.
 *
 * ── Why this exists alongside `StationWorld._buildCrowd` ────────────────────
 *
 * The plaza crowd is one *merged* mesh per variant: a whole body baked into a
 * single geometry, so a figure is a rigid object and the only animation
 * available is to move that object. That is exactly right for the hub, where
 * the job is scale and density at 20-100 m and a breathing, weight-shifting,
 * slowly-turning post is enough - and it costs six draw calls for 180 people.
 *
 * The zones ask a different question. A galley wants people *eating*, a gym
 * wants people *rowing*, an expansion site wants people *hammering*. None of
 * those read from a rigid mesh, because what identifies them is a limb moving
 * relative to a torso that is not moving. Bobbing a merged body faster does not
 * approximate a bicep curl; it just looks like a nervous statue.
 *
 * So: the same figure, cut at the joints. Each body part is its own
 * `InstancedMesh` and every part mesh is indexed *in parallel* - instance `i` of
 * `torso` and instance `i` of `calfL` belong to the same person - and each
 * part's geometry is authored so that its ORIGIN IS ITS PIVOT. An upper arm is
 * a capsule whose origin sits at the shoulder and which hangs down -Y; a thigh's
 * origin is the hip. Posing is then nothing more than a rotation about that
 * origin composed with the parent chain, evaluated on the CPU straight into the
 * instance matrix. No skinning, no bones, no morph targets, no per-frame
 * allocation, and eleven draw calls for every actor in every zone.
 *
 * The proportions are lifted from `_crowdBodyGeo` joint for joint - 1.75 m tall,
 * head centre at 1.66, shoulders at 1.40-1.44, hips at 0.95 - because a galley
 * worker standing next to a plaza commuter has to be the same species. The baked
 * vertex-colour value break (dark trousers, mid jacket, dark shoes) is carried
 * over for the same reason, and works for the same reason: `M.crowd` is built
 * with `vertexColors: true`, so the baked value multiplies the per-instance
 * garment colour and one draw call still yields a three-band figure instead of a
 * single-value pill.
 */

/* ------------------------------------------------------------------ */
/* Scratch - reused every call, never allocated in a hot path          */
/* ------------------------------------------------------------------ */

const _v1 = new THREE.Vector3();
const _scl = new THREE.Vector3(1, 1, 1);
const _ONE = new THREE.Vector3(1, 1, 1);   // never mutated
const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();
const _mat4 = new THREE.Matrix4();
const _col = new THREE.Color();

/* One matrix per level of the skeleton, plus a leaf. The chain is only three
 * deep (pelvis -> torso -> arm -> forearm), so four named matrices cover it and
 * nothing has to be pushed or popped. */
const _mRoot = new THREE.Matrix4();
const _mPelvis = new THREE.Matrix4();
/* All-zero, for hiding an actor. Composing this per call would allocate; it is
 * written to eleven instance slots at a time and never read back. */
const _mZero = new THREE.Matrix4().set(0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0);
const _mTorso = new THREE.Matrix4();
const _mLimb = new THREE.Matrix4();
const _mLeaf = new THREE.Matrix4();
const _mLocal = new THREE.Matrix4();

/* ------------------------------------------------------------------ */
/* Skeleton - one set of numbers, read by both the geometry and the    */
/* poser, so a joint can never drift away from the mesh hung on it     */
/* ------------------------------------------------------------------ */

const HIP_Y = 0.95;         // pelvis block origin, = the crowd's hip cylinder
const HIP_JOINT_Y = 0.90;   // where the thighs actually hinge
const HIP_X = 0.16;         // matches the crowd's leg spacing exactly
const THIGH_LEN = 0.45;
const CALF_LEN = 0.42;
const ANKLE_Y = 0.03;       // HIP_JOINT_Y - THIGH_LEN - CALF_LEN, feet on y = 0
const LEG_LEN = THIGH_LEN + CALF_LEN;

const TORSO_Y = 1.01;       // waist pivot: the torso leans about this
const SHOULDER_Y = 1.44;
const SHOULDER_X = 0.27;
const SHOULDER_Z = 0.01;
const UPPER_ARM = 0.28;
const FOREARM = 0.30;       // elbow to the centre of the hand
const NECK_Y = 1.48;        // head pivot, at the base of the neck

/* Local offsets, precomputed so the poser never does arithmetic on constants. */
const TORSO_OFF_Y = TORSO_Y - HIP_Y;
const HIP_OFF_Y = HIP_JOINT_Y - HIP_Y;      // negative: the sockets sit under the block
const HEAD_OFF_Y = NECK_Y - TORSO_Y;
const SHOULDER_OFF_Y = SHOULDER_Y - TORSO_Y;
/* The plaza crowd puts the chest capsule at world y = 1.20; the torso pivots at
 * the waist, so in torso-local space that is 0.19 up. */
const CHEST_OFF_Y = 1.20 - TORSO_Y;

/**
 * Seat height from an actor's `amount`.
 *
 * `amount` is a general-purpose magnitude whose default is 1, and 1 is a sane
 * multiplier but an absurd stool - so for the seated activities the default
 * value is coalesced to the 0.45 m bench the zones are built around. The one
 * cost is that exactly 1.000 m is not expressible; a bar stool wants 0.99.
 * Doing this in one function rather than at registration means `setActivity`
 * cannot reintroduce the metre-high chair by switching an actor to `sit`.
 */
function seatFrom(amount) {
  return (amount === 1 || !(amount > 0.05)) ? 0.45 : amount;
}

/* ------------------------------------------------------------------ */
/* Level of detail                                                     */
/* ------------------------------------------------------------------ */

/**
 * The plaza crowd amortises by touching a sixth of the roster per frame. That
 * is legitimate for a rigid figure whose whole animation is a 2 cm bob: five
 * stale frames on a 2 cm sine is invisible.
 *
 * It is not legitimate here. A hammer arm travelling 1.2 m in 0.3 s moves ~7 cm
 * per frame; freezing it for five frames and then jumping 35 cm reads as a
 * dropped frame, not as economy - and the *point* of these figures is the limb
 * motion, so the one thing that must never stutter is the thing round-robin
 * amortisation stutters.
 *
 * Distance is the right axis instead. Beyond ~70 m a limb is a couple of pixels
 * wide and a 30 Hz update is indistinguishable from 60; beyond ~140 m the whole
 * figure is a smudge and pose is irrelevant, so those actors are skipped
 * entirely and their matrices are left exactly as they were. That is why
 * `finish()` writes a full rest pose for everybody: an actor that is never once
 * inside the cull radius would otherwise render on the identity matrix, which
 * is not "invisible", it is a heap of body parts stacked at the world origin.
 */
const CULL_R2 = 140 * 140;
const HALF_RATE_R2 = 70 * 70;

/* ------------------------------------------------------------------ */
/* Activities                                                          */
/* ------------------------------------------------------------------ */

const ACT_STAND = 0;
const ACT_TALK = 1;
const ACT_SIT = 2;
const ACT_EAT = 3;
const ACT_QUEUE = 4;
const ACT_WALK = 5;
const ACT_RUN = 6;
const ACT_ROW = 7;
const ACT_CURL = 8;
const ACT_PRESS = 9;
const ACT_HAMMER = 10;
const ACT_CARRY = 11;
const ACT_LIFT = 12;

const ACTIVITY_ID = new Map([
  ['stand', ACT_STAND], ['talk', ACT_TALK], ['sit', ACT_SIT], ['eat', ACT_EAT],
  ['queue', ACT_QUEUE], ['walk', ACT_WALK], ['run', ACT_RUN], ['row', ACT_ROW],
  ['curl', ACT_CURL], ['press', ACT_PRESS], ['hammer', ACT_HAMMER],
  ['carry', ACT_CARRY], ['lift', ACT_LIFT],
]);

/* Warn once per unknown *name*, not once per actor. A zone builder that
 * mistypes an activity places it forty times, and forty identical console lines
 * bury whatever else the load was trying to tell you. */
const _warnedActivities = new Set();
function activityId(name) {
  const id = ACTIVITY_ID.get(name);
  if (id !== undefined) return id;
  if (!_warnedActivities.has(name)) {
    _warnedActivities.add(name);
    console.warn(`[StationActors] unknown activity "${name}" - falling back to "stand"`);
  }
  return ACT_STAND;
}

/* ------------------------------------------------------------------ */
/* Pose scratch                                                        */
/* ------------------------------------------------------------------ */

/* One pose, refilled per actor. Sides are indexed 0 = left (-X), 1 = right
 * (+X); `SIDE[k]` is the sign, so a splay or a stance offset is written once
 * and mirrored by multiplication rather than by a second branch. */
const SIDE = [-1, 1];
const _armRX = new Float32Array(2);
const _armRY = new Float32Array(2);
const _armRZ = new Float32Array(2);   // pre-mirrored: stored as the outward splay
const _elbow = new Float32Array(2);
const _hipRX = new Float32Array(2);
const _hipRZ = new Float32Array(2);
const _knee = new Float32Array(2);

const P = {
  /* Root offset in ACTOR-LOCAL space (forward is -Z, matching the crowd's
   * "figure faces -Z at yaw 0"), applied under the yaw so a rowing slide runs
   * along the machine whatever bearing the machine was placed on. */
  dx: 0, dy: 0, dz: 0,
  pelvisRX: 0, pelvisRY: 0, pelvisRZ: 0,
  torsoRX: 0, torsoRY: 0, torsoRZ: 0,
  headRX: 0, headRY: 0,
};

function resetPose() {
  P.dx = 0; P.dy = 0; P.dz = 0;
  P.pelvisRX = 0; P.pelvisRY = 0; P.pelvisRZ = 0;
  P.torsoRX = 0; P.torsoRY = 0; P.torsoRZ = 0;
  P.headRX = 0; P.headRY = 0;
  for (let k = 0; k < 2; k++) {
    _armRX[k] = 0; _armRY[k] = 0; _armRZ[k] = 0; _elbow[k] = 0;
    _hipRX[k] = 0; _hipRZ[k] = 0; _knee[k] = 0;
  }
}

/* ------------------------------------------------------------------ */
/* Small maths, all branch-cheap and allocation-free                   */
/* ------------------------------------------------------------------ */

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
/** Hermite ease on an already-normalised 0..1 input. */
function ease(x) { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); }
/** Positive fractional part - `%` alone returns negatives for negative phases. */
function fract(x) { const f = x % 1; return f < 0 ? f + 1 : f; }

/**
 * Two-link sagittal IK: put the ankle at (dy, dz) relative to the hip joint and
 * write the resulting hip and knee angles for side `k`.
 *
 * This is here because every planted-foot activity - sitting, rowing, squatting
 * - is really a statement about where the *feet* are, not about where the joints
 * are. Hand-authored joint angles for "sit on a 0.45 m stool" are wrong the
 * moment a zone uses a 0.66 m bench, and the failure mode is feet buried to the
 * ankle in the deck, which is the single most common way a placed figure gives
 * itself away. Solving from the foot target instead means one number - the seat
 * height - drives the whole leg and the shoes stay on the floor.
 *
 * Angle convention throughout: rotation about local X, positive swings the limb
 * FORWARD (toward -Z), which is the direction the figure faces. A human knee
 * therefore flexes negative.
 */
function ikLeg(k, dy, dz) {
  let ty = dy, tz = dz;
  // Not Math.hypot: it pays for overflow protection on numbers that are always
  // under a metre, and it runs for every seated actor every frame.
  let d = Math.sqrt(ty * ty + tz * tz);
  const maxD = LEG_LEN - 0.004;                        // never fully lock
  const minD = Math.abs(THIGH_LEN - CALF_LEN) + 0.02;  // never fold flat
  if (d < 1e-5) { ty = -minD; tz = 0; d = minD; }
  else if (d > maxD) { const s = maxD / d; ty *= s; tz *= s; d = maxD; }
  else if (d < minD) { const s = minD / d; ty *= s; tz *= s; d = minD; }
  // Direction of the hip->ankle line, measured from straight down (-Y).
  const aim = Math.atan2(-tz, -ty);
  const cosT = clamp((d * d + THIGH_LEN * THIGH_LEN - CALF_LEN * CALF_LEN) / (2 * d * THIGH_LEN), -1, 1);
  const cosK = clamp((THIGH_LEN * THIGH_LEN + CALF_LEN * CALF_LEN - d * d) / (2 * THIGH_LEN * CALF_LEN), -1, 1);
  // Thigh swings *ahead* of the aim line so the knee bulges forward, which is
  // the only one of the two IK solutions that is a leg rather than a flamingo.
  _hipRX[k] = aim + Math.acos(cosT);
  _knee[k] = -(Math.PI - Math.acos(cosK));
}

/** Compose `local` onto `parent` into `out`, without touching the heap. */
function chain(out, parent, ox, oy, oz, rx, ry, rz) {
  _euler.set(rx, ry, rz, 'YXZ');
  _quat.setFromEuler(_euler);
  _mLocal.compose(_v1.set(ox, oy, oz), _quat, _ONE);
  return out.multiplyMatrices(parent, _mLocal);
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

/**
 * Place one primitive into a part, bake its garment value, and take ownership.
 *
 * Identical in intent to `_crowdBodyGeo`'s local `put()`: `shade` is a flat
 * per-vertex value that multiplies the per-instance colour, so a single draw
 * call still carries dark trousers, a mid jacket and darker shoes rather than
 * one flat value. The one difference is that the offsets here are relative to
 * the part's PIVOT, not to the figure's feet.
 */
function put(parts, geo, x, y, z, shade, rz = 0, rx = 0, uv = 4) {
  uvScale(geo, uv, uv);
  _euler.set(rx, 0, rz, 'YXZ');
  _quat.setFromEuler(_euler);
  _mat4.compose(_v1.set(x, y, z), _quat, _scl.set(1, 1, 1));
  geo.applyMatrix4(_mat4);
  const n = geo.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    col[i * 3] = shade; col[i * 3 + 1] = shade; col[i * 3 + 2] = shade;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  parts.push(geo);
}

function mergeParts(parts) {
  const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
  if (parts.length > 1) for (const p of parts) p.dispose();
  merged.computeBoundingSphere();
  return merged;
}

/* ------------------------------------------------------------------ */
/* Palettes                                                            */
/* ------------------------------------------------------------------ */

/**
 * Garment palette, held to the same discipline as the plaza crowd's: every
 * entry pulled a quarter of the way to 0x2a2f36 and clamped under 0.35
 * saturation. The reasoning at `StationWorld._buildCrowd` applies verbatim -
 * high chroma is a storytelling resource that belongs to the portals, the hazard
 * language and the hero NPCs. A galley extra in a scarlet coat becomes the
 * highest-chroma object in the frame and steals the read from whatever the shot
 * was actually about.
 */
const PALETTE = [
  0x2c3743, 0x3a332e, 0x554438, 0x2f4441, 0x4b4d53,
  0x5a3f3f, 0x36404f, 0x504b41, 0x28313a, 0x554e59,
  0x3f4a52, 0x463d38,
];

/**
 * Hi-vis workwear, and a deliberate exception to everything above.
 *
 * A hard-hat area whose crew is dressed in the ambient palette is not a hard-hat
 * area, it is a group of commuters standing near some steel. Hi-vis is the one
 * garment in the world whose *entire function* is to be the highest-chroma thing
 * present, and reading it as such is the point - so the construction zone gets
 * saturated orange and yellow and nothing else does. It stays confined to the
 * torso mesh, which is exactly a vest: the trousers, arms and legs of a hi-vis
 * actor still come from `PALETTE`, so the chroma appears as a garment worn over
 * a muted person rather than as a person made of traffic cone.
 */
const HIVIZ = [0xff7a18, 0xffc21f, 0xf2620a, 0xffd447];

/** Narrow, unsaturated; the map and the lighting do the rest. */
const SKIN_TONES = [0xd8b394, 0xbe9070, 0x8d6448, 0x6b4630, 0xe6c6a8, 0xa07a5c];

/* ------------------------------------------------------------------ */

/**
 * A population of posable figures sharing eleven instanced draw calls.
 *
 * Usage is strictly: construct, `add()` every actor, `finish(parent)` once,
 * then `setCamera()` + `update()` from the world's frame loop.
 */
export class StationActors {
  /**
   * @param {object}  opts
   * @param {object}  opts.materials         the world's material table (`this.mat`)
   * @param {string} [opts.bodyMaterialKey]  garment material key, default 'crowd'
   * @param {string} [opts.skinMaterialKey]  head material key, default 'skin'
   * @param {number} [opts.seed]             deterministic rng seed
   */
  constructor({ materials, bodyMaterialKey = 'crowd', skinMaterialKey = 'skin', seed = 1 } = {}) {
    this.materials = materials;
    this.bodyMaterialKey = bodyMaterialKey;
    this.skinMaterialKey = skinMaterialKey;
    this._rng = mulberry32((seed >>> 0) || 1);

    /* Registration buffers. Plain arrays only until `finish()`, which packs
     * them into the flat typed arrays the frame loop reads - growth during
     * generation is free, growth during a frame is not. */
    this._reg = [];
    this._count = 0;
    this._built = false;

    /** @type {THREE.InstancedMesh[]} every part mesh, for the matrix upload. */
    this._meshes = [];
    /** @type {Object<string, THREE.BufferGeometry>} */
    this._geo = null;

    // Named handles, so the poser writes to a mesh instead of an array slot.
    this._mPelvis = null; this._mTorso = null; this._mHead = null;
    this._mUpperArm = [null, null];
    this._mForeArm = [null, null];
    this._mThigh = [null, null];
    this._mCalf = [null, null];

    /** @type {THREE.Vector3|null} set by `setCamera`; null disables LOD. */
    this._cam = null;
    this._frame = 0;
    this._clock = 0;
  }

  /** Number of registered actors. */
  get count() { return this._count; }

  /* ---------------------------------------------------------------- */
  /* Registration                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Register one actor.
   *
   * @param {object}  o
   * @param {number}  o.x                 world position; `y` is the FLOOR the
   * @param {number}  o.y                   actor stands on, even when seated
   * @param {number}  o.z
   * @param {number} [o.yaw]              0 faces -Z, matching the plaza crowd
   * @param {number} [o.scale]            1 is a 1.75 m figure
   * @param {string} [o.activity]         see the activity list on `_pose`
   * @param {number} [o.phase]            radians; null picks one from the seed.
   *   Pass it explicitly when two adjacent actors must NOT be in lockstep - a
   *   pair of `talk` figures gesturing in unison is the tell that gives an
   *   instanced crowd away, and it is the caller that knows which two are a pair
   * @param {number} [o.speed]            multiplies the activity's base rate
   * @param {number} [o.amount]           activity-specific magnitude: seat
   *   height in metres for `sit`/`eat`/`row` (the default 1 means 0.45 m - see
   *   `seatFrom`), squat depth multiplier for `lift`, ignored elsewhere
   * @param {number} [o.colour]           index into the garment palette, wrapped
   * @param {number} [o.skin]             index into the skin tone pool, wrapped
   * @param {string} [o.variant]          'hiviz' for a workwear vest
   * @returns {number} the actor's integer index, or -1 after `finish()`
   */
  add({
    x, y, z, yaw = 0, scale = 1, activity = 'stand', phase = null,
    speed = 1, amount = 1, colour = null, skin = null, variant = null,
  }) {
    if (this._built) {
      console.warn('[StationActors] add() after finish() - ignored');
      return -1;
    }
    const rng = this._rng;
    const i = this._count++;
    this._reg.push({
      x, y, z, yaw, scale,
      act: activityId(activity),
      phase: phase === null ? rng() * Math.PI * 2 : phase,
      speed, amount,
      colour: colour === null ? Math.floor(rng() * PALETTE.length) : colour,
      skin: skin === null ? Math.floor(rng() * SKIN_TONES.length) : skin,
      hiviz: variant === 'hiviz' ? 1 : 0,
      // Every figure gets a fixed, tiny asymmetry. A row of identically-posed
      // idlers is the same failure as a row of identical silhouettes.
      bias: (rng() - 0.5) * 2,
    });
    return i;
  }

  /** Move an actor after `finish()` - for actors the world walks along a path. */
  setPosition(i, x, y, z, yaw) {
    if (!this._built || i < 0 || i >= this._count) return;
    const o = i * 3;
    this._pos[o] = x; this._pos[o + 1] = y; this._pos[o + 2] = z;
    if (yaw !== undefined) this._yaw[i] = yaw;
  }

  /**
   * Change activity at runtime.
   *
   * `amount` is re-read by the new activity, so switching a standing figure to
   * `sit` without one leaves it on the 0.45 m default rather than on whatever
   * magnitude the previous activity happened to want.
   */
  setActivity(i, activity, { speed, amount } = {}) {
    if (i < 0 || i >= this._count) return;
    const act = activityId(activity);
    if (this._built) {
      this._act[i] = act;
      if (speed !== undefined) this._speed[i] = speed;
      if (amount !== undefined) this._amount[i] = amount;
    } else {
      const r = this._reg[i];
      r.act = act;
      if (speed !== undefined) r.speed = speed;
      if (amount !== undefined) r.amount = amount;
    }
  }

  /**
   * The world hands its camera position in each frame; `update()` uses it to
   * decide who is worth posing. Passing nothing (or never calling this) poses
   * everybody every frame, which is correct but is only affordable for small
   * rosters.
   *
   * @param {THREE.Vector3} cameraPosition kept by reference, not copied
   */
  setCamera(cameraPosition) { this._cam = cameraPosition || null; }

  /* ---------------------------------------------------------------- */
  /* Build                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Build the part meshes and add them to `parent`. Call once, after every
   * `add()`.
   */
  finish(parent) {
    if (this._built) { console.warn('[StationActors] finish() called twice'); return; }
    this._built = true;
    const n = this._count;
    if (!n) return;

    // Flat per-actor state. Everything the frame loop reads lives here, in the
    // order it reads it, and nothing else is allocated after this point.
    this._pos = new Float32Array(n * 3);
    this._yaw = new Float32Array(n);
    this._scale = new Float32Array(n);
    this._phase = new Float32Array(n);
    this._speed = new Float32Array(n);
    this._amount = new Float32Array(n);
    this._bias = new Float32Array(n);
    this._act = new Uint8Array(n);
    /** 1 while an actor is collapsed by the distance cull. See `update`. */
    this._hidden = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const r = this._reg[i];
      this._pos[i * 3] = r.x; this._pos[i * 3 + 1] = r.y; this._pos[i * 3 + 2] = r.z;
      this._yaw[i] = r.yaw;
      this._scale[i] = r.scale;
      this._phase[i] = r.phase;
      this._speed[i] = r.speed;
      this._amount[i] = r.amount;
      this._bias[i] = r.bias;
      this._act[i] = r.act;
    }

    const bodyMat = this.materials?.[this.bodyMaterialKey];
    const skinMat = this.materials?.[this.skinMaterialKey];
    if (!bodyMat || !skinMat) {
      console.warn('[StationActors] missing material - figures will not shade correctly');
    }

    /* One geometry per part *shape*: the two upper arms are the same capsule
     * about the same pivot and differ only by which side of the torso they hang
     * from, so left and right share the buffer and only the instance matrices
     * differ. Left and right still get their own mesh, though - that is what
     * keeps instance index == actor index on every one of the eleven meshes,
     * which in turn is what makes the colour upload and the distance skip
     * impossible to get subtly wrong. Four spare draw calls is a cheap price. */
    const G = this._geo = {
      pelvis: this._pelvisGeo(),
      torso: this._torsoGeo(),
      head: this._headGeo(),
      upperArm: this._upperArmGeo(),
      foreArm: this._foreArmGeo(),
      thigh: this._thighGeo(),
      calf: this._calfGeo(),
    };

    const mk = (geo, mat, name) => {
      const m = new THREE.InstancedMesh(geo, mat, n);
      m.name = `StationActors:${name}`;
      m.userData[NOT_EDITABLE] = true;
      /* No shadow casting, and the reason is measured rather than assumed.
       *
       * These eleven meshes hold every actor on the map - about 1,900 figures
       * once the zones were filled - and `frustumCulled` is false, so all of
       * them are submitted to every pass including the shadow map. That is
       * about 7.5 M triangles rendered a second time into a 3072 sq depth
       * buffer, and it was the single largest cost in the frame: switching it
       * off took street level from 34 to 52 fps and the galley court from 31 to
       * 37, with no other change.
       *
       * It costs nothing visually. The world's only shadow-casting light is the
       * plaza key, whose shadow camera is 160 m across and centred on the hub
       * (see `_buildLights`). Every actor is in an outer zone, half a kilometre
       * outside that box, so not one of them was ever casting a shadow anybody
       * could see - they were only being drawn into a depth buffer that would
       * discard them. `receiveShadow` stays on, which is the half that is
       * actually free.
       */
      m.castShadow = false;
      m.receiveShadow = true;
      // Instances span whole zones; a per-object frustum test could only ever
      // reject the one mesh that holds everybody, so it is never worth running.
      m.frustumCulled = false;
      parent.add(m);
      this._meshes.push(m);
      return m;
    };

    this._mPelvis = mk(G.pelvis, bodyMat, 'pelvis');
    this._mTorso = mk(G.torso, bodyMat, 'torso');
    this._mHead = mk(G.head, skinMat, 'head');
    for (let k = 0; k < 2; k++) {
      const s = k === 0 ? 'L' : 'R';
      this._mUpperArm[k] = mk(G.upperArm, bodyMat, `upperArm${s}`);
      this._mForeArm[k] = mk(G.foreArm, bodyMat, `foreArm${s}`);
      this._mThigh[k] = mk(G.thigh, bodyMat, `thigh${s}`);
      this._mCalf[k] = mk(G.calf, bodyMat, `calf${s}`);
    }

    /* Per-instance tint, exactly as `_buildCrowd` does it: garment colour on the
     * body parts, skin on the head, both multiplying the baked vertex value. The
     * torso is the one part that can disagree with the rest of the body, which
     * is what makes a vest a vest. */
    for (let i = 0; i < n; i++) {
      const r = this._reg[i];
      const garment = PALETTE[r.colour % PALETTE.length];
      _col.setHex(garment);
      this._mPelvis.setColorAt(i, _col);
      for (let k = 0; k < 2; k++) {
        this._mUpperArm[k].setColorAt(i, _col);
        this._mForeArm[k].setColorAt(i, _col);
        this._mThigh[k].setColorAt(i, _col);
        this._mCalf[k].setColorAt(i, _col);
      }
      _col.setHex(r.hiviz ? HIVIZ[(r.colour + i) % HIVIZ.length] : garment);
      this._mTorso.setColorAt(i, _col);
      _col.setHex(SKIN_TONES[r.skin % SKIN_TONES.length]);
      this._mHead.setColorAt(i, _col);
    }
    for (const m of this._meshes) if (m.instanceColor) m.instanceColor.needsUpdate = true;

    /* Rest pose for everybody, unconditionally. See the LOD note above: an
     * actor outside the cull radius is never posed by `update()`, and an
     * InstancedMesh instance that has never been written sits on the identity
     * matrix - eleven body parts interpenetrating at the world origin. */
    for (let i = 0; i < n; i++) this._poseActor(i, 0);
    for (const m of this._meshes) m.instanceMatrix.needsUpdate = true;

    // The registration records have been packed; drop them so a zone with a
    // thousand actors does not carry a thousand objects for the session.
    this._reg = null;
  }

  /* ---------------------------------------------------------------- */
  /* Part geometry - origin is the pivot, limbs extend down -Y          */
  /* ---------------------------------------------------------------- */

  /**
   * Hips. The root of the chain and, deliberately, the only part with any
   * girth below the waist: the thigh capsules' top caps sit inside this block
   * and fill the hip sockets from underneath, so a leg can swing to a full
   * stride without opening a hole where a person's hip should be.
   */
  _pelvisGeo() {
    const parts = [];
    put(parts, new THREE.CylinderGeometry(0.215, 0.185, 0.30, 10), 0, 0, 0, 0.86);
    return mergeParts(parts);
  }

  /** Chest + shoulder yoke, pivoting about the waist. */
  _torsoGeo() {
    const parts = [];
    // A tapered capsule reads as a coat at 40 m; a box reads as a crate.
    put(parts, new THREE.CapsuleGeometry(0.20, 0.44, 3, 10), 0, CHEST_OFF_Y, 0, 1.0);
    // Yoke: closes the gap that widely-set shoulders open across the top.
    put(parts, new THREE.CapsuleGeometry(0.09, 0.30, 2, 8), 0, SHOULDER_OFF_Y - 0.04, 0, 1.0, Math.PI / 2);
    return mergeParts(parts);
  }

  /**
   * Head and neck, pivoting at the base of the neck.
   *
   * No vertex colours here, matching `_crowdHeadGeo`: `M.skin` is built without
   * `vertexColors`, so a baked value would be silently ignored, and skin has its
   * own tint pool precisely so a navy jacket cannot produce a navy face.
   */
  _headGeo() {
    const parts = [];
    const neck = new THREE.CylinderGeometry(0.055, 0.07, 0.10, 8);
    neck.translate(0, 1.535 - NECK_Y, 0);
    parts.push(neck);
    const head = new THREE.SphereGeometry(0.105, 12, 10);
    head.scale(0.94, 1.12, 1.0);
    head.translate(0, 1.66 - NECK_Y, 0);
    parts.push(head);
    // A brow/jaw break so the head is not a perfect ball at close range.
    const jaw = new THREE.BoxGeometry(0.13, 0.07, 0.11);
    jaw.translate(0, 1.60 - NECK_Y, 0.03);
    parts.push(jaw);
    for (const p of parts) uvScale(p, 2, 2);
    return mergeParts(parts);
  }

  /** Shoulder to elbow. The upper cap rounds the shoulder, the lower the elbow. */
  _upperArmGeo() {
    const parts = [];
    put(parts, new THREE.CapsuleGeometry(0.062, UPPER_ARM, 2, 6), 0, -UPPER_ARM * 0.5, 0, 0.94);
    return mergeParts(parts);
  }

  /** Elbow to hand, hand included - a separate hand mesh would double the
   * per-frame matrix writes for something four pixels across. */
  _foreArmGeo() {
    const parts = [];
    put(parts, new THREE.CapsuleGeometry(0.056, FOREARM - 0.06, 2, 6), 0, -(FOREARM - 0.06) * 0.5, 0, 0.94);
    put(parts, new THREE.BoxGeometry(0.075, 0.11, 0.07), 0, -FOREARM + 0.01, 0, 0.80, 0, 0, 2);
    return mergeParts(parts);
  }

  /** Hip to knee. Trouser value, matching the crowd's 0.58. */
  _thighGeo() {
    const parts = [];
    put(parts, new THREE.CapsuleGeometry(0.085, THIGH_LEN, 2, 6), 0, -THIGH_LEN * 0.5, 0, 0.58);
    return mergeParts(parts);
  }

  /**
   * Knee to ankle, with the shoe baked on.
   *
   * The foot is not its own part because it never needs to rotate independently
   * of the shin at this distance - and skipping it saves two instanced meshes
   * and two matrix writes per actor per frame. The cost is a heel that lifts
   * with the shin in a deep squat, which is what a real heel does anyway.
   */
  _calfGeo() {
    const parts = [];
    put(parts, new THREE.CapsuleGeometry(0.072, CALF_LEN - 0.04, 2, 6), 0, -(CALF_LEN - 0.04) * 0.5, 0, 0.58);
    // Toe leads (-Z is forward), so the shoe reads as a shoe in silhouette.
    put(parts, new THREE.BoxGeometry(0.12, 0.07, 0.26), 0, -CALF_LEN + ANKLE_Y + 0.01, -0.04, 0.34);
    return mergeParts(parts);
  }

  /* ---------------------------------------------------------------- */
  /* Frame                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Pose every actor worth posing.
   *
   * Allocation-free by inspection: every vector, quaternion, euler and matrix
   * it touches is module scope, the pose is a fixed set of scalars and seven
   * two-element Float32Arrays, and `InstancedMesh.setMatrixAt` writes straight
   * into the existing instance buffer.
   *
   * @param {number} dt      seconds since the last frame
   * @param {number} elapsed world clock; if omitted, `dt` is accumulated
   */
  update(dt, elapsed) {
    if (!this._built || !this._count) return;
    const t = elapsed === undefined ? (this._clock += dt || 0) : elapsed;
    this._frame = (this._frame + 1) & 0xffff;
    const parity = this._frame & 1;
    const cam = this._cam;
    const pos = this._pos;
    let wrote = false;

    for (let i = 0; i < this._count; i++) {
      if (cam) {
        const dx = pos[i * 3] - cam.x;
        const dy = pos[i * 3 + 1] - cam.y;
        const dz = pos[i * 3 + 2] - cam.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        /* Out of range: collapse the figure instead of leaving it posed.
         *
         * Leaving the matrices alone was cheaper per frame and much more
         * expensive per pixel. The eleven part meshes hold every actor on the
         * map in one instanced buffer each, so they cannot be frustum-culled as
         * a group - their bounding sphere is the whole dome - and the renderer
         * was submitting all seven hundred and fifty figures, about 790,000
         * triangles, from every camera position on the station including ones
         * where four hundred of them were half a kilometre away behind a wall.
         *
         * A zero-scale matrix makes every triangle degenerate, so the raster
         * stage discards them before any fragment work. The transition is
         * one-shot in each direction - `_hidden` is what stops this writing
         * eleven matrices per distant actor per frame, which would have cost
         * more than it saved.
         */
        if (d2 > CULL_R2) {
          if (!this._hidden[i]) { this._hideActor(i); this._hidden[i] = 1; wrote = true; }
          continue;
        }
        if (this._hidden[i]) this._hidden[i] = 0;
        if (d2 > HALF_RATE_R2 && (i & 1) === parity) continue;
      }
      this._poseActor(i, t);
      wrote = true;
    }

    // `needsUpdate` re-uploads the whole instance buffer, so it is worth not
    // setting it on a frame where the player is nowhere near any of them.
    if (!wrote) return;
    for (let m = 0; m < this._meshes.length; m++) this._meshes[m].instanceMatrix.needsUpdate = true;
  }

  /**
   * Collapse actor `i` to nothing in every part mesh.
   *
   * A zeroed matrix, not a translation off-screen: an off-screen figure still
   * has its vertices transformed and its primitives clipped, where a degenerate
   * one is rejected at setup. Both beat rasterising it; this one is also
   * immune to somebody later pointing a camera at wherever "off-screen" was.
   */
  _hideActor(i) {
    for (let m = 0; m < this._meshes.length; m++) {
      this._meshes[m].setMatrixAt(i, _mZero);
    }
  }

  /**
   * Fill `P` and the joint arrays for actor `i`, then walk the chain into the
   * eleven instance matrices.
   */
  _poseActor(i, t) {
    this._pose(i, t);

    const o = i * 3;
    const s = this._scale[i];
    _euler.set(0, this._yaw[i], 0, 'YXZ');
    _quat.setFromEuler(_euler);
    _mRoot.compose(
      _v1.set(this._pos[o], this._pos[o + 1], this._pos[o + 2]),
      _quat,
      _scl.set(s, s, s)
    );

    // The root offset rides under the yaw, so a rowing slide or a queue shuffle
    // runs along the actor's own forward axis rather than along world -Z.
    chain(_mPelvis, _mRoot, P.dx, HIP_Y + P.dy, P.dz, P.pelvisRX, P.pelvisRY, P.pelvisRZ);
    this._mPelvis.setMatrixAt(i, _mPelvis);

    chain(_mTorso, _mPelvis, 0, TORSO_OFF_Y, 0, P.torsoRX, P.torsoRY, P.torsoRZ);
    this._mTorso.setMatrixAt(i, _mTorso);

    chain(_mLeaf, _mTorso, 0, HEAD_OFF_Y, 0, P.headRX, P.headRY, 0);
    this._mHead.setMatrixAt(i, _mLeaf);

    for (let k = 0; k < 2; k++) {
      const sg = SIDE[k];
      chain(_mLimb, _mTorso, sg * SHOULDER_X, SHOULDER_OFF_Y, SHOULDER_Z,
        _armRX[k], _armRY[k] * sg, _armRZ[k] * sg);
      this._mUpperArm[k].setMatrixAt(i, _mLimb);
      chain(_mLeaf, _mLimb, 0, -UPPER_ARM, 0, _elbow[k], 0, 0);
      this._mForeArm[k].setMatrixAt(i, _mLeaf);

      chain(_mLimb, _mPelvis, sg * HIP_X, HIP_OFF_Y, 0, _hipRX[k], 0, _hipRZ[k] * sg);
      this._mThigh[k].setMatrixAt(i, _mLimb);
      chain(_mLeaf, _mLimb, 0, -THIGH_LEN, 0, _knee[k], 0, 0);
      this._mCalf[k].setMatrixAt(i, _mLeaf);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Activities                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Evaluate one activity into the shared pose.
   *
   *   stand   idle - breathing, weight shift, slow look-around. The baseline,
   *           and the fallback for anything unrecognised.
   *   talk    stand plus hand gestures, driven off `phase` so a pair of
   *           adjacent actors alternate instead of miming in unison.
   *   sit     seated; `amount` is the seat height, hips land on y + that,
   *           and the legs are solved so the shoes stay on y.
   *   eat     sit plus one forearm cycling to the mouth and back.
   *   queue   stand plus a shuffle forward every few seconds, then a settle.
   *   walk    gait in place; the caller translates via `setPosition`.
   *   run     faster stride, higher knee, forward lean; does not translate.
   *   row     seated, arms and torso driving, and the whole actor sliding
   *           0.55 m fore/aft along its own Z - the slide is what sells it.
   *   curl    standing bicep curl, upper arms pinned to the ribs.
   *   press   standing overhead press, both arms locking out above the head.
   *   hammer  one arm raising and striking down at ~1.6 Hz, torso leaning in.
   *   carry   forearms held forward and level around a box, plus a trudge sway.
   *   lift    squat and stand, dropping ~0.3 m, arms down and forward.
   */
  _pose(i, tRaw) {
    resetPose();
    const ph = this._phase[i];
    const sp = this._speed[i];
    const amt = this._amount[i];
    const bias = this._bias[i];
    const t = tRaw + ph;

    switch (this._act[i]) {
      case ACT_TALK: this._poseTalk(t, ph, bias); break;
      case ACT_SIT: this._poseSit(t, bias, amt, 0); break;
      case ACT_EAT: this._poseSit(t, bias, amt, sp > 0 ? sp : 1); break;
      case ACT_QUEUE: this._poseQueue(t, bias); break;
      case ACT_WALK: this._poseGait(t, sp, false); break;
      case ACT_RUN: this._poseGait(t, sp, true); break;
      case ACT_ROW: this._poseRow(t, sp, amt); break;
      case ACT_CURL: this._poseCurl(t, sp); break;
      case ACT_PRESS: this._posePress(t, sp); break;
      case ACT_HAMMER: this._poseHammer(t, sp, bias); break;
      case ACT_CARRY: this._poseCarry(t, sp); break;
      case ACT_LIFT: this._poseLift(t, sp, amt); break;
      default: this._poseStand(t, bias); break;
    }
  }

  /**
   * Idle.
   *
   * Three uncorrelated rates - breath at 1.7 Hz, weight shift at 0.07 Hz, gaze
   * at 0.03 Hz - so the loop never resolves into an obvious period. A figure
   * with one sine on it reads as a metronome the moment there are two of them.
   */
  _poseStand(t, bias) {
    const breath = Math.sin(t * 1.7);
    const shift = Math.sin(t * 0.43);
    P.dy = breath * 0.012;
    P.dx = shift * 0.022;
    P.pelvisRZ = shift * 0.035;
    P.torsoRZ = -shift * 0.02;
    P.torsoRX = breath * 0.012;
    P.torsoRY = Math.sin(t * 0.19) * 0.10;
    P.headRY = Math.sin(t * 0.21 + bias) * 0.45;
    P.headRX = Math.sin(t * 0.17) * 0.07 - 0.02;

    for (let k = 0; k < 2; k++) {
      const sg = SIDE[k];
      _armRX[k] = Math.sin(t * 0.6 + k * 2.1) * 0.05 - shift * 0.06 * sg;
      _armRZ[k] = 0.11 + shift * 0.02 * sg;
      _elbow[k] = 0.14 + Math.sin(t * 0.55 + k) * 0.04;
      // A split, slightly asymmetric stance - the same reasoning as the plaza
      // crowd's fore/aft leg offset: it keeps light through the silhouette.
      _hipRX[k] = (k === 0 ? -0.05 : 0.06) + bias * 0.04 - shift * 0.02 * sg;
      _hipRZ[k] = 0.03;
      _knee[k] = -0.05 - Math.max(0, shift * sg) * 0.06;
    }
  }

  /** Idle plus gesture. `phase` is what keeps a conversing pair out of sync. */
  _poseTalk(t, ph, bias) {
    this._poseStand(t, bias);
    // Which hand leads is decided by the phase the caller passed, so two actors
    // handed opposing phases also get opposing gestures.
    const lead = fract(ph / (Math.PI * 2)) < 0.5 ? 1 : 0;
    const g = Math.sin(t * 2.3);
    const g2 = Math.sin(t * 1.55 + 0.8);
    _armRX[lead] = 0.55 + g * 0.30;
    _armRZ[lead] = 0.26 + g2 * 0.10;
    _elbow[lead] = 1.25 + g * 0.55;
    // The off hand does a fraction of the same thing rather than hanging dead.
    const off = 1 - lead;
    _armRX[off] += 0.14 + g2 * 0.10;
    _elbow[off] += 0.30 + g2 * 0.18;
    P.torsoRY += g2 * 0.07;
    P.headRY = g2 * 0.16 + (lead ? -0.1 : 0.1);
    P.headRX = -0.03 + g * 0.05;
  }

  /**
   * Seated, with the legs solved from the seat height rather than authored.
   *
   * `eatSpeed > 0` adds the eating cycle on the right arm: a forearm lifting to
   * the mouth, a short hold, then back to the table. The hold matters - a
   * continuous sine reads as waving, not as eating.
   */
  _poseSit(t, bias, seatHeight, eatSpeed) {
    const seat = seatFrom(seatHeight);
    const breath = Math.sin(t * 1.6);
    P.dy = seat - HIP_Y + breath * 0.006;
    P.torsoRX = -0.10 + breath * 0.012;
    P.torsoRY = Math.sin(t * 0.23) * 0.09;
    P.headRY = Math.sin(t * 0.26 + bias) * 0.30;
    P.headRX = 0.06;

    // Ankle target relative to the hip joint: on the floor, half a metre out.
    const hipY = seat + HIP_OFF_Y;
    for (let k = 0; k < 2; k++) {
      ikLeg(k, ANKLE_Y - hipY, -0.46 + SIDE[k] * bias * 0.03);
      _hipRZ[k] = 0.06;
      _armRX[k] = 0.42;
      _armRZ[k] = 0.15;
      _elbow[k] = 0.62 + Math.sin(t * 0.5 + k) * 0.05;
    }

    if (eatSpeed > 0) {
      /* Lift-hold-lower. `u` spends roughly a third of the cycle near 1, which
       * is the mouthful; the overdriven sine is what buys the hold without a
       * keyframe table. */
      const u = clamp(Math.sin(t * 1.15 * eatSpeed) * 1.6, -1, 1) * 0.5 + 0.5;
      _armRX[1] = 0.40 + u * 0.42;
      _armRZ[1] = 0.15 - u * 0.09;
      _elbow[1] = 0.60 + u * 1.75;
      P.headRX = 0.06 + u * 0.10;
      P.torsoRX = -0.10 + u * 0.14;
    }
  }

  /**
   * Queueing.
   *
   * A quick shuffle forward, then a slow drift back as the line closes up
   * behind. The return leg is deliberate: an actor that only ever advances
   * walks out of its own queue in about a minute, and nothing in this system
   * repositions it. Net displacement over a cycle is therefore zero, and the
   * read - a body that lurches 9 cm and settles - is the same.
   */
  _poseQueue(t, bias) {
    this._poseStand(t * 0.75, bias);
    const q = fract(t * 0.21);
    const lurch = q < 0.12 ? ease(q / 0.12) : 1 - ease((q - 0.12) / 0.88);
    P.dz = -0.085 * lurch;
    P.torsoRX += 0.06 * lurch;
    P.dy -= 0.012 * lurch;
    // The trailing foot comes up a little as the weight transfers forward.
    const k = bias > 0 ? 1 : 0;
    _hipRX[k] += 0.16 * lurch;
    _knee[k] -= 0.28 * lurch;
    _armRX[k] -= 0.10 * lurch;
    _armRX[1 - k] += 0.10 * lurch;
  }

  /**
   * Walk or run, in place.
   *
   * Legs are hand-authored here rather than solved by `ikLeg`, because a gait's
   * defining feature is the swing leg being *off* the floor - solving to a
   * planted foot would be solving away the animation. The stance foot rises a
   * few centimetres at the extremes of the stride, which is the classic sliding
   * artefact; the pelvis drop below hides most of it, and at the distances these
   * are seen the alternative (foot-planted IK with a moving root) is not worth
   * its cost.
   */
  _poseGait(t, speed, run) {
    const w = t * Math.PI * 2 * (run ? 1.55 : 0.95) * (speed > 0 ? speed : 1);
    const swing = run ? 0.82 : 0.52;
    const kneeAmp = run ? 1.45 : 0.80;
    const sw = Math.sin(w);
    const cw = Math.cos(w * 2);

    // Pelvis is highest at mid-stance, when the supporting leg is straight.
    P.dy = (run ? -0.06 : -0.028) * (1 - cw) * 0.5 + (run ? 0.035 : 0) * Math.max(0, cw);
    P.dx = Math.sin(w) * (run ? 0.02 : 0.03);
    P.pelvisRY = sw * (run ? 0.10 : 0.07);
    P.pelvisRZ = -sw * 0.04;
    // Torso counter-rotates against the pelvis; without it a walk reads as a
    // marching toy, because a real spine unwinds what the hips do.
    P.torsoRY = -sw * (run ? 0.16 : 0.11);
    P.torsoRX = run ? 0.22 : 0.05;
    P.headRX = run ? -0.14 : -0.02;

    for (let k = 0; k < 2; k++) {
      const p = w + (k === 0 ? 0 : Math.PI);
      const sp2 = Math.sin(p);
      _hipRX[k] = sp2 * swing;
      _knee[k] = -(0.10 + kneeAmp * Math.max(0, Math.sin(p + 1.15)));
      _hipRZ[k] = 0.03;
      // Arms swing against the legs. Contralateral, or it looks like a puppet.
      _armRX[k] = -sp2 * (run ? 0.70 : 0.42);
      _armRZ[k] = run ? 0.16 : 0.12;
      _elbow[k] = run ? 1.35 + Math.max(0, -sp2) * 0.35 : 0.28 + Math.max(0, -sp2) * 0.35;
    }
  }

  /**
   * Rowing machine.
   *
   * Everything else here is a limb cycle over a fixed root. This one moves the
   * root, because a rowing seat really does slide half a metre down its rail and
   * that translation - not the arms - is what identifies the machine from across
   * a gym. With the seat sliding, the feet have to stay on the footplate, so the
   * legs are solved by IK to a fixed target in front of the actor and the whole
   * drive falls out of it: knees to the chest at the catch, legs straight at the
   * finish, for free.
   */
  _poseRow(t, speed, seatHeight) {
    const seat = seatFrom(seatHeight);
    // 0 = catch (seat forward, folded), 1 = finish (seat back, laid out).
    const u = 0.5 - 0.5 * Math.cos(t * Math.PI * 2 * 0.40 * (speed > 0 ? speed : 1));
    const slide = (u - 0.5) * 0.55;
    P.dy = seat - HIP_Y;
    P.dz = slide;

    const hipY = seat + HIP_OFF_Y;
    const FOOT_Z = -0.57;      // footplate, in front of the rail's mid point
    const FOOT_Y = seat - 0.17; // plates sit a little below the seat
    for (let k = 0; k < 2; k++) {
      ikLeg(k, FOOT_Y - hipY, FOOT_Z - slide);
      _hipRZ[k] = 0.11;
      // Catch: arms reached out, elbows straight. Finish: handle at the ribs.
      _armRX[k] = 1.05 - u * 0.92;
      _armRZ[k] = 0.14 + u * 0.16;
      _elbow[k] = 0.10 + u * 1.95;
    }
    // Torso rocks from a forward shin-hug to a lay-back over the hips.
    P.torsoRX = 0.34 - u * 0.80;
    P.headRX = -0.10 + u * 0.16;
  }

  /** Bicep curl: upper arms pinned to the ribs, forearms doing all the work. */
  _poseCurl(t, speed) {
    const u = 0.5 - 0.5 * Math.cos(t * Math.PI * 2 * 0.55 * (speed > 0 ? speed : 1));
    this._braceLegs(0.04);
    for (let k = 0; k < 2; k++) {
      // Pinned, not welded: the elbow drifts a couple of degrees as it fatigues,
      // which is the difference between a lifter and a mannequin.
      _armRX[k] = 0.04 + u * 0.14;
      _armRZ[k] = 0.055;
      _elbow[k] = 0.22 + u * 2.05;
    }
    P.torsoRX = -0.03 - u * 0.06;
    P.dy = -0.012 * u;
    P.headRX = 0.05 * u;
  }

  /** Overhead press: both arms extending straight up, then back to the rack. */
  _posePress(t, speed) {
    const u = 0.5 - 0.5 * Math.cos(t * Math.PI * 2 * 0.46 * (speed > 0 ? speed : 1));
    this._braceLegs(0.09 - u * 0.06);
    for (let k = 0; k < 2; k++) {
      // 1.15 rad is elbows-down at the rack; 2.95 is very nearly vertical, with
      // enough forward tilt that the hands stay visible from in front.
      _armRX[k] = 1.15 + u * 1.80;
      _armRZ[k] = 0.30 - u * 0.17;
      _elbow[k] = 2.10 - u * 2.00;
    }
    P.torsoRX = -0.05 * u;
    P.headRX = -0.10 * u;
    P.dy = -0.02 + u * 0.025;
  }

  /**
   * Hammering.
   *
   * The wave is deliberately asymmetric - roughly 0.45 s to raise and 0.17 s to
   * strike - because a symmetric sine reads as waving. The strike is the whole
   * event, and it has to be the fast part.
   */
  _poseHammer(t, speed, bias) {
    // 1.6 strikes per second, so `q` is the position within one blow.
    const q = fract(t * 1.6 * (speed > 0 ? speed : 1));
    const u = q < 0.72 ? ease(q / 0.72) : 1 - ease((q - 0.72) / 0.28);   // 1 = raised
    const k = bias > 0 ? 1 : 0;   // which hand holds the hammer
    const o = 1 - k;
    this._braceLegs(0.12);
    // 0.55 forward-down at the strike, back over the shoulder at -1.75.
    _armRX[k] = 0.55 - u * 2.30;
    _armRZ[k] = 0.14 + u * 0.16;
    _elbow[k] = 0.18 + u * 1.30;
    // Off hand steadies the work rather than hanging.
    _armRX[o] = 0.36;
    _armRZ[o] = 0.20;
    _elbow[o] = 0.95;
    // Lean into the blow: the body follows the hammer down.
    P.torsoRX = 0.09 + (1 - u) * 0.17;
    P.torsoRY = SIDE[k] * -0.10 * u;
    P.headRX = 0.14 + (1 - u) * 0.10;
    P.dy = -0.02 * (1 - u);
  }

  /**
   * Carrying a box: forearms forward and level, weight on the heels, and a slow
   * trudge sway. The forearm angle is the tell - a level forearm implies
   * something resting on it, and nothing else in the set does that.
   */
  _poseCarry(t, speed) {
    const w = t * 1.05 * (speed > 0 ? speed : 1);
    const sway = Math.sin(w);
    this._braceLegs(0.05);
    for (let k = 0; k < 2; k++) {
      // 0.85 at the shoulder + 0.80 at the elbow puts the forearm within a few
      // degrees of horizontal; the pair together bracket a box.
      _armRX[k] = 0.85;
      _armRZ[k] = 0.22;
      _elbow[k] = 0.80;
      _hipRX[k] += Math.sin(w + (k === 0 ? 0 : Math.PI)) * 0.10;
      _knee[k] -= 0.06 + Math.max(0, Math.sin(w + (k === 0 ? 0 : Math.PI))) * 0.10;
    }
    // Leaning back against the load, which is what a real carry looks like.
    P.torsoRX = -0.09;
    P.dx = sway * 0.035;
    P.dy = -0.015 + Math.sin(w * 2) * 0.018;
    P.pelvisRZ = sway * 0.05;
    P.torsoRZ = -sway * 0.03;
    P.headRX = 0.05;
  }

  /**
   * Squat and stand.
   *
   * The inverse of `sit`: there the root height was given and the legs were
   * solved from it; here the leg angles are given and the root height is solved
   * from *them*, by measuring how far the folded leg actually reaches. Doing it
   * the obvious way round - drop the root 0.3 m and bend the knees by a
   * hand-picked amount - puts the feet through the deck the moment `amount`
   * changes.
   */
  _poseLift(t, speed, amount) {
    const u = 0.5 - 0.5 * Math.cos(t * Math.PI * 2 * 0.34 * (speed > 0 ? speed : 1));
    const depth = 0.30 * (amount > 0 ? amount : 1) * u;
    const hipY = HIP_JOINT_Y - depth;
    for (let k = 0; k < 2; k++) {
      // Feet planted, slightly forward and apart, so the knees track outward.
      ikLeg(k, ANKLE_Y - hipY, -0.06);
      _hipRZ[k] = 0.05 + u * 0.16;
    }
    P.dy = -depth;
    P.torsoRX = u * 0.55;
    P.headRX = -u * 0.42;
    for (let k = 0; k < 2; k++) {
      _armRX[k] = 0.22 + u * 0.88;
      _armRZ[k] = 0.13 + u * 0.06;
      _elbow[k] = 0.16 + u * 0.34;
    }
  }

  /** Near-straight legs with a token bend - the base for the standing rigs. */
  _braceLegs(bend) {
    for (let k = 0; k < 2; k++) {
      _hipRX[k] = bend * 0.5;
      _hipRZ[k] = 0.05;
      _knee[k] = -bend;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Teardown                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Free the part geometries. The materials belong to the world's material
   * table and are disposed by `StationWorld.dispose`; disposing them here would
   * take the plaza crowd's garments down with the galley's.
   */
  dispose() {
    for (const m of this._meshes) {
      m.parent?.remove(m);
      m.dispose?.();
    }
    this._meshes.length = 0;
    if (this._geo) {
      // Left and right share a buffer, so dedupe or the second dispose is a
      // double free on an already-released GPU resource.
      const seen = new Set();
      for (const key in this._geo) {
        const g = this._geo[key];
        if (!g || seen.has(g)) continue;
        seen.add(g);
        g.dispose();
      }
      this._geo = null;
    }
    this._mPelvis = this._mTorso = this._mHead = null;
    this._mUpperArm[0] = this._mUpperArm[1] = null;
    this._mForeArm[0] = this._mForeArm[1] = null;
    this._mThigh[0] = this._mThigh[1] = null;
    this._mCalf[0] = this._mCalf[1] = null;
    this._pos = this._yaw = this._scale = this._hidden = null;
    this._phase = this._speed = this._amount = this._bias = null;
    this._act = null;
    this._cam = null;
    this._reg = null;
  }
}

/** Palettes, exposed so a zone can pin two actors to the same garment. */
StationActors.PALETTE = PALETTE;
StationActors.HIVIZ = HIVIZ;
StationActors.SKIN_TONES = SKIN_TONES;
/** Activity names this system understands, in id order. */
StationActors.ACTIVITIES = Array.from(ACTIVITY_ID.keys());
