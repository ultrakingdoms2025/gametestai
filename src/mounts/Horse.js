import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { sweep, blob } from '../gfx/Organic.js';
import { COLLISION_LAYER } from '../physics/Physics.js';
import { applyLivery, MOUNT_STATS } from './Livery.js';

/**
 * HORSE - the ground mount.
 *
 * ── What makes a horse different from the other three mounts ──────────────
 * The hoverboard, the car and the dragon are all *vehicles*: they have a
 * throttle, they hold whatever speed you ask for, and they turn at a rate the
 * player sets. A horse is an animal, and three things follow from that:
 *
 *   1. **It has gaits, not a speed dial.** Halt, walk, trot, canter, gallop -
 *      discrete bands with their own footfall pattern, and the animation is
 *      driven by which band you are in rather than by a single blend. That is
 *      what stops it looking like a sofa sliding across the ground.
 *   2. **It leans into turns and cannot pivot.** Steering rate falls off with
 *      speed, so a gallop commits you to a line. Turning a galloping horse on
 *      the spot is the single most common way a mount stops reading as an
 *      animal.
 *   3. **It follows the ground closely.** No suspension, no hover: the hooves
 *      are on the terrain, and the body pitches with the slope it is on.
 *
 * ── Legs ──────────────────────────────────────────────────────────────────
 * Four legs on phase offsets, and the offsets change with the gait, because
 * that *is* the difference between a trot and a gallop. A trot is diagonal
 * pairs in antiphase; a gallop is a four-beat rotary with a moment of
 * suspension. Getting those two patterns right is most of what sells it, and
 * neither costs anything beyond a different phase table.
 *
 * ── Build ─────────────────────────────────────────────────────────────────
 * Everything static is merged into one geometry per material, and only the
 * parts that must articulate - four legs, neck, head, tail - stay separate.
 * That keeps a horse at about eight draw calls rather than forty.
 */

const TAU = Math.PI * 2;
const clamp = THREE.MathUtils.clamp;
const damp = THREE.MathUtils.damp;

/* Scratch, one block per method. */
const _hs1 = new THREE.Vector3();   // getSeat
const _gp1 = new THREE.Vector3();   // ground probe
const _gp2 = new THREE.Vector3();
const _mv1 = new THREE.Vector3();   // fixedUpdate

/** Withers height - the rider sits a little behind and above it. */
const BODY_Y = 1.42;
/** Distance from the shoulder to the hip. */
const BARREL = 1.34;
/** Half the track between left and right legs. */
const TRACK = 0.34;

/** Gait bands, in metres per second. */
/**
 * Gait bands. `stride` is the ground covered by one *complete* cycle of all
 * four legs, so speed / stride is the cycle rate that drives both the legs and
 * the hoofbeats.
 *
 * These were originally 2.1 / 3.0 / 2.5 / 2.2, which has a gallop taking a
 * shorter stride than a trot - backwards, and short enough that the animal ran
 * at seven cycles a second. Real horses manage about two and a half. The legs
 * blurred, and once the hooves were given a voice it came out as twenty-eight
 * beats a second: not a gallop, a sewing machine. A horse lengthens its stride
 * as it speeds up, which is most of where the extra speed comes from.
 */
const GAITS = [
  { name: 'halt', max: 0.2, stride: 0, lift: 0, bob: 0 },
  { name: 'walk', max: 2.6, stride: 2.6, lift: 0.17, bob: 0.035 },
  { name: 'trot', max: 6.4, stride: 4.4, lift: 0.28, bob: 0.075 },
  { name: 'canter', max: 10.5, stride: 5.6, lift: 0.36, bob: 0.13 },
  { name: 'gallop', max: Infinity, stride: 6.8, lift: 0.44, bob: 0.2 },
];

/**
 * Leg phase offsets per gait, in turns, ordered [FL, FR, HL, HR].
 *
 * These are the real footfall patterns and they are the whole reason the gaits
 * read differently: a walk is an even four-beat, a trot is diagonal pairs
 * exactly out of phase, and a gallop is a rotary sequence with the hind pair
 * landing close together and a moment of suspension after them.
 */
const PHASE = {
  halt: [0, 0, 0, 0],
  walk: [0, 0.5, 0.25, 0.75],
  trot: [0, 0.5, 0.5, 0],
  canter: [0, 0.15, 0.55, 0.7],
  gallop: [0, 0.12, 0.5, 0.62],
};

const MAX_SPEED = 15.5;
const GALLOP_SPEED = 15.5;
const CRUISE_SPEED = 8.4;
const ACCEL = 7.0;
const BRAKE = 11.0;
/** Steering, radians per second, at a standstill and at full gallop. */
const TURN_SLOW = 2.5;
const TURN_FAST = 0.85;
/** How far the horse can step up without being blocked. */
const STEP_UP = 0.75;
const GRAVITY = -22;
const JUMP_V = 7.6;

/**
 * A rounded box, which is every part of this animal.
 *
 * Nothing on a horse has a sharp edge on it. Built from plain boxes the model
 * reads as a bench with a box for a head however well it is animated, because
 * the silhouette is all straight lines meeting at right angles - and the
 * silhouette is the whole of what you see of a mount you are sitting on top of.
 * The round is generous, a fifth of the smallest dimension, so slim parts like
 * cannon bones come out genuinely cylindrical rather than merely eased.
 */
function box(w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
  const r = Math.min(w, h, d) * 0.2;
  const g = r > 0.012
    ? new RoundedBoxGeometry(w, h, d, 2, r)
    : new THREE.BoxGeometry(w, h, d);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

/** A tapered box: `w2`/`d2` are the far-end width and depth. Wedges and limbs. */
function taper(w, h, d, w2, d2, x, y, z, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d, 1, 1, 1);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    // 0 at the bottom of the box, 1 at the top; scale the section by height.
    const t = pos.getY(i) / h + 0.5;
    const sx = THREE.MathUtils.lerp(1, w2 / w, t);
    const sz = THREE.MathUtils.lerp(1, d2 / d, t);
    pos.setX(i, pos.getX(i) * sx);
    pos.setZ(i, pos.getZ(i) * sz);
  }
  g.computeVertexNormals();
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

function merge(list) {
  const clean = list.map((g) => (g.index ? g.toNonIndexed() : g));
  const m = mergeGeometries(clean, false);
  for (const g of clean) g.dispose();
  return m;
}

export class Horse {
  /** Colour slots the F10 menu offers. `defaultColor` = factory swatch. */
  static CUSTOM_SLOTS = Object.freeze([
    Object.freeze({ id: 'coat', label: 'Coat', finish: false, defaultColor: 0x8a6242, palette: 'natural' }),
    Object.freeze({ id: 'saddle', label: 'Saddle & tack', finish: true, defaultColor: 0x6d4522, palette: 'paint' }),
  ]);
  static STATS = MOUNT_STATS.horse;

  /**
   * @param {{scene:THREE.Scene, engine:any, physics:any, bus:any, materials:any,
   *          camera:THREE.PerspectiveCamera}} ctx
   */
  constructor({ scene, engine, physics, bus, materials, camera }) {
    this.id = 'horse';
    this.displayName = 'HORSE';
    /** Seated astride, like the dragon - not standing, like the board. */
    this.riderPose = 'ride';
    /** Spawned this far in front of the player. */
    this.spawnDistance = 3.4;

    this.scene = scene;
    this.engine = engine;
    this.physics = physics;
    this.bus = bus;
    this.materials = materials;
    this.camera = camera;

    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.heading = 0;
    this.speed = 0;
    this._vy = 0;
    this._grounded = true;
    this._groundY = 0;
    this._pitch = 0;
    this._roll = 0;
    this._gait = GAITS[0];
    this._stridePhase = 0;
    this._alive = false;
    this._ridden = false;
    this._spawnT = 1;
    this._despawnT = -1;
    this._time = 0;
    this._headBob = 0;

    this._powerMul = 1;
    this._accelMul = 1;
    this._shieldTier = 0;
    this._livery = null;
    this._slotMats = null;

    this._owned = [];
    this._build();
  }

  /* ------------------------------------------------------------------ */
  /* Build                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * A surface for this animal.
   *
   * `surface` names a key in the shared PBR library, which bakes an albedo, a
   * normal and a packed ORM map for it. Everything here used to be a flat
   * `MeshStandardMaterial` with a colour and nothing else - and a flat colour
   * with no normal map is why a model can be as dense as you like and still
   * read as shaded plastic. Geometry gives you the silhouette; the maps are
   * what make it look like a material.
   *
   * The library instance is cloned and tinted, so the coat colour still comes
   * from here while the grain comes from the bake, and every clone shares the
   * same GPU texture storage.
   */
  _mat(color, opts = {}) {
    const { surface = null, ...rest } = opts;
    if (surface && this.materials?.get) {
      try {
        const base = this.materials.get(surface);
        if (base) {
          const m = base.clone();
          m.color = new THREE.Color(color);
          if (rest.roughness !== undefined) m.roughness = rest.roughness;
          if (rest.metalness !== undefined) m.metalness = rest.metalness;
          this._owned.push(m);
          return m;
        }
      } catch { /* fall through to the flat material below */ }
    }
    const m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      roughness: rest.roughness ?? 0.78,
      metalness: rest.metalness ?? 0.05,
      ...rest,
    });
    this._owned.push(m);
    return m;
  }

  _build() {
    this.root = new THREE.Group();
    this.root.name = 'mount:horse';

    // A single tilt node under the root carries pitch and roll, so the legs
    // (which hang off the body) inherit the body's attitude for free.
    this.tilt = new THREE.Group();
    this.root.add(this.tilt);

    // The coat and the hair carry the fur bake; hooves are keratin, so they
    // stay smooth and take only a slight grain from it.
    /* The tiling is anisotropic on purpose.
     *
     * A swept surface's UVs run 0..1 once around the ring and 0..1 along the
     * whole length, so a single tile would stretch one hair across the entire
     * animal. Repeating more around the body than along it also lines the
     * grain up with the way a coat actually lies - down and back. */
    const coat = this._mat(0x8a6242, { surface: 'hide.fur:6,10' });
    const dark = this._mat(0x3a2a1e, { roughness: 0.42, metalness: 0.06 });
    const hair = this._mat(0x2a1d13, { surface: 'hide.fur:3,7', roughness: 0.95 });
    const tack = this._mat(0x6d4522, { roughness: 0.6, metalness: 0.15 });
    const metal = this._mat(0xb9a06a, { roughness: 0.35, metalness: 0.9 });
    this._slotMats = { coat: [coat], saddle: [tack] };

    /* ---- barrel, chest, hindquarters: one merged body ----
     *
     * Seven masses rather than four, and none of them the same size. A horse
     * is deepest at the girth just behind the shoulder and narrowest at the
     * flank in front of the hip, and the topline dips between the withers and
     * the croup. Built as one even slab - which is what this was - it reads as
     * a bench, and no amount of leg animation fixes a bench. */
    /* One continuous surface, not a pile of boxes.
     *
     * The barrel is a single ellipse swept from the point of the shoulder back
     * to the dock of the tail, its section changing along the way: deepest at
     * the girth just behind the elbow, drawn in at the flank, swelling again
     * over the haunch. The topline is carried by the y of each station, so the
     * withers stand proud and the back dips to the croup - the line that says
     * "horse" at any distance. The two blobs on top of it are the shoulder and
     * hip, which genuinely are lumps rather than part of the sweep. */
    const B = BARREL;
    const body = merge([
      sweep([
        { y: BODY_Y + 0.06, z: -B * 0.62, rx: 0.20, ry: 0.24 },   // point of shoulder
        { y: BODY_Y + 0.02, z: -B * 0.50, rx: 0.34, ry: 0.40 },
        { y: BODY_Y - 0.02, z: -B * 0.30, rx: 0.43, ry: 0.48 },   // girth, deepest
        { y: BODY_Y - 0.01, z: -B * 0.08, rx: 0.44, ry: 0.47 },
        { y: BODY_Y + 0.02, z: B * 0.14, rx: 0.40, ry: 0.42 },    // flank, tucked up
        { y: BODY_Y + 0.06, z: B * 0.34, rx: 0.44, ry: 0.46 },
        { y: BODY_Y + 0.10, z: B * 0.52, rx: 0.42, ry: 0.44 },    // over the hip
        { y: BODY_Y + 0.16, z: B * 0.66, rx: 0.28, ry: 0.30 },    // croup falling away
        { y: BODY_Y + 0.18, z: B * 0.76, rx: 0.14, ry: 0.16 },    // dock
      ], 20),
      /* Muscle bulges, sunk into the barrel rather than sitting on it.
       *
       * At their first size these reached 0.60 from the centreline against a
       * barrel half-width of 0.43, so they stood clear of the body as two pairs
       * of balls stuck to its sides. A shoulder is a swelling *of* the surface;
       * anything that breaks the silhouette by more than a few centimetres is a
       * tumour. Sized and placed to finish flush. */
      /* Flush with the barrel, and longer than they are wide.
       *
       * Sized down once already and still wrong: at 0.28 out plus a 0.17 radius
       * they finished 2 cm proud of a barrel half-width of 0.43, and because a
       * sphere has a round silhouette of its own that read as four balls stuck
       * to the sides rather than as muscle. They now stop exactly at the
       * surface, and are stretched along the body - a shoulder and a haunch are
       * broad flat masses running fore-and-aft, not lumps. */
      blob(0.16, 0.19, 0.32, -0.27, BODY_Y + 0.05, -B * 0.34, 12),  // shoulder
      blob(0.16, 0.19, 0.32, 0.27, BODY_Y + 0.05, -B * 0.34, 12),
      blob(0.18, 0.21, 0.34, -0.26, BODY_Y + 0.09, B * 0.40, 12),   // hip
      blob(0.18, 0.21, 0.34, 0.26, BODY_Y + 0.09, B * 0.40, 12),
      // Withers: the ridge the saddle sits behind.
      blob(0.13, 0.15, 0.26, 0, BODY_Y + 0.34, -B * 0.38, 10),
    ]);
    this._owned.push(body);
    const bodyMesh = new THREE.Mesh(body, coat);
    bodyMesh.castShadow = true;
    bodyMesh.receiveShadow = true;
    this.tilt.add(bodyMesh);

    /* ---- neck + head, on their own pivot so they can nod ---- */
    this.neck = new THREE.Group();
    this.neck.position.set(0, BODY_Y + 0.3, -BARREL * 0.55);
    this.tilt.add(this.neck);
    /* Tapered, and thicker front-to-back than side-to-side.
     *
     * A horse's neck is a deep blade, wide where it leaves the chest and
     * narrowing to the throatlatch, and it is far deeper than it is broad. A
     * uniform box gave it the cross-section of a plank. */
    /* Note the sign: -0.42, leaning the neck *forward*.
     *
     * This was +0.42, which under rotateX tips the top of the neck toward +Z -
     * backwards, over the saddle - while the head is anchored forward at
     * z = -0.62. The two ends were 60 cm apart and the head hung in the air
     * unattached, which is most of why the animal read as a box with a box
     * stuck on it. Worked through, the neck's top with the sign corrected lands
     * at (0, 0.98, -0.62), which is where the head already was. */
    /* Shorter and much deeper than the first attempt, which reached 1.3 m above
     * the withers on a 0.3 m section and came out a llama. A horse's neck is
     * about as long as its head and roughly twice as deep as it is wide. */
    /* Swept up and forward from the chest to the poll.
     *
     * Stations carry both the curve and the section, so the neck leaves the
     * body wide and shallow, narrows through the middle and arrives at the
     * throatlatch as a deep, narrow blade - which is the shape that reads as a
     * neck rather than as a pipe. The base station is deliberately fat so it
     * buries itself inside the chest and needs no separate blending mass. */
    const neckGeo = sweep([
      { y: -0.16, z: 0.20, rx: 0.40, ry: 0.38 },   // buried in the chest
      { y: 0.10, z: 0.02, rx: 0.31, ry: 0.36 },
      { y: 0.38, z: -0.16, rx: 0.25, ry: 0.34 },
      { y: 0.62, z: -0.34, rx: 0.21, ry: 0.30 },
      { y: 0.80, z: -0.50, rx: 0.17, ry: 0.24 },   // throatlatch
    ], 18, { capStart: false });
    this._owned.push(neckGeo);
    const neckMesh = new THREE.Mesh(neckGeo, coat);
    neckMesh.castShadow = true;
    this.neck.add(neckMesh);

    // Sits on the neck's actual top, worked out from the two tapers above
    // rather than guessed - which is how it came to be floating 60 cm clear.
    this.head = new THREE.Group();
    this.head.position.set(0, 0.85, -0.56);
    this.neck.add(this.head);
    /* Swept from the poll down the face to the nose.
     *
     * A horse's head is a long wedge with one distinctive feature: it is wide
     * and deep at the jaw and then falls away sharply to a fine muzzle, with
     * the cheek as a separate lump on the side. Getting that step right is what
     * stops it reading as a dog. */
    const headGeo = merge([
      sweep([
        { y: 0.10, z: 0.06, rx: 0.14, ry: 0.15 },   // poll
        { y: 0.04, z: -0.10, rx: 0.16, ry: 0.19 },  // forehead
        { y: -0.06, z: -0.30, rx: 0.14, ry: 0.17 },
        { y: -0.16, z: -0.48, rx: 0.11, ry: 0.13 },
        { y: -0.25, z: -0.63, rx: 0.10, ry: 0.11 },  // muzzle
        { y: -0.30, z: -0.72, rx: 0.09, ry: 0.09 },  // nose
      ], 16),
      blob(0.15, 0.14, 0.16, -0.06, -0.06, -0.24, 10),   // cheek
      blob(0.15, 0.14, 0.16, 0.06, -0.06, -0.24, 10),
    ]);
    this._owned.push(headGeo);
    const headMesh = new THREE.Mesh(headGeo, coat);
    headMesh.castShadow = true;
    this.head.add(headMesh);
    // Bridle, so it reads as tacked up rather than wild.
    const bridle = new THREE.Mesh(box(0.32, 0.05, 0.05, 0, -0.02, -0.3), tack);
    this.head.add(bridle);

    /* Ears on their own pivots rather than merged into the skull.
     *
     * Two extra nodes, and they carry more of the animal's state than any other
     * part of it: pinned flat at the gallop, forward and flicking at rest. A
     * horse whose ears never move is a statue of a horse, however well its legs
     * are animated. */
    this.ears = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.1, 0.14, 0.04);
      const geo = box(0.07, 0.18, 0.07, 0, 0.09, 0);
      this._owned.push(geo);
      pivot.add(new THREE.Mesh(geo, coat));
      this.head.add(pivot);
      this.ears.push(pivot);
    }

    /* Mane, as a row of locks laid along the crest.
     *
     * It has to be built from the neck's own station list rather than placed by
     * eye: when the neck became a swept surface the old two-box mane stayed
     * where the boxes used to be, which put it over the horse's face. Sampling
     * the same curve means it can never drift off the crest again, whatever the
     * neck is reshaped into next.
     *
     * Separate locks rather than one slab, because the gaps between them are
     * what read as hair. */
    this.mane = new THREE.Group();
    this.mane.position.set(0, 0, 0);
    this.neck.add(this.mane);
    const crest = [
      { y: 0.02, z: 0.10, r: 0.34 },
      { y: 0.26, z: -0.06, r: 0.30 },
      { y: 0.48, z: -0.22, r: 0.27 },
      { y: 0.66, z: -0.38, r: 0.23 },
      { y: 0.80, z: -0.50, r: 0.19 },
    ];
    /* Short, and laid *on* the crest.
     *
     * The first version gave every lock a 36 cm fall from a crest that is only
     * 80 cm long, so the five of them merged into a single dark sheet a metre
     * square standing off the neck - from the side it read as a wing. A mane
     * lies against the neck; it is a fringe, not a cape. */
    const locks = [];
    for (let i = 0; i < crest.length; i++) {
      const c = crest[i];
      const len = 0.17 - i * 0.012;
      locks.push(sweep([
        { x: 0, y: c.y + c.r * 0.95, z: c.z - 0.02, rx: 0.05, ry: 0.045 },
        { x: 0, y: c.y + c.r * 0.80, z: c.z + len * 0.6, rx: 0.062, ry: 0.04 },
        { x: 0, y: c.y + c.r * 0.55, z: c.z + len, rx: 0.04, ry: 0.026 },
      ], 8));
    }
    const maneGeo = merge(locks);
    this._owned.push(maneGeo);
    this.mane.add(new THREE.Mesh(maneGeo, hair));

    /* ---- saddle + stirrups ---- */
    const saddleGeo = merge([
      box(0.72, 0.16, 0.72, 0, BODY_Y + 0.47, 0.02),
      box(0.5, 0.22, 0.12, 0, BODY_Y + 0.58, -0.3),   // pommel
      box(0.56, 0.2, 0.12, 0, BODY_Y + 0.56, 0.34),   // cantle
    ]);
    this._owned.push(saddleGeo);
    const saddle = new THREE.Mesh(saddleGeo, tack);
    saddle.castShadow = true;
    this.tilt.add(saddle);
    for (const sx of [-0.46, 0.46]) {
      const st = new THREE.Mesh(box(0.06, 0.42, 0.06, sx, BODY_Y + 0.18, 0.04), metal);
      this.tilt.add(st);
      const tread = new THREE.Mesh(box(0.18, 0.05, 0.14, sx, BODY_Y - 0.04, 0.04), metal);
      this.tilt.add(tread);
    }

    /* ---- rider anchor ---- */
    this.riderAnchor = new THREE.Object3D();
    this.riderAnchor.position.set(0, BODY_Y + 0.62, 0.02);
    this.tilt.add(this.riderAnchor);
    /** Where the rider's boots go, so the mount rider IK has a target. */
    this.footAnchors = [];
    for (const sx of [-0.5, 0.5]) {
      const f = new THREE.Object3D();
      f.position.set(sx, BODY_Y - 0.02, 0.04);
      this.tilt.add(f);
      this.footAnchors.push(f);
    }
    /* Where the rider's hands go: on the reins, just ahead of the withers.
     *
     * `MountManager._poseSeated` solves the arms by IK onto `getGripWorld`, and
     * gives up entirely if the mount does not offer one - which is why the
     * rider sat on this horse with both arms straight out to the sides. Two
     * anchors is the whole fix. */
    this.reinAnchors = [];
    for (const sx of [-0.22, 0.22]) {
      const g = new THREE.Object3D();
      g.position.set(sx, BODY_Y + 0.5, -BARREL * 0.44);
      this.tilt.add(g);
      this.reinAnchors.push(g);
    }

    /* ---- tail ---- */
    this.tail = new THREE.Group();
    this.tail.position.set(0, BODY_Y + 0.3, BARREL * 0.62);
    this.tilt.add(this.tail);
    // A hanging rope of hair, thickest a third of the way down.
    const tailGeo = sweep([
      { y: 0, z: 0, rx: 0.09, ry: 0.09 },
      { y: -0.22, z: 0.08, rx: 0.12, ry: 0.11 },
      { y: -0.48, z: 0.14, rx: 0.10, ry: 0.09 },
      { y: -0.72, z: 0.17, rx: 0.06, ry: 0.055 },
    ], 12, { capStart: false });
    this._owned.push(tailGeo);
    this.tail.add(new THREE.Mesh(tailGeo, hair));

    /* ---- legs ---- *
     * Order is [front-left, front-right, hind-left, hind-right] to match the
     * phase tables. Each is a two-segment chain so the knee can actually fold;
     * a single rigid leg swinging from the shoulder reads as a table being
     * dragged. */
    this.legs = [];
    const legSpec = [
      { x: -TRACK, z: -BARREL * 0.36, front: true },
      { x: TRACK, z: -BARREL * 0.36, front: true },
      { x: -TRACK, z: BARREL * 0.38, front: false },
      { x: TRACK, z: BARREL * 0.38, front: false },
    ];
    for (const spec of legSpec) {
      const hipY = BODY_Y - (spec.front ? 0.16 : 0.1);
      const upper = new THREE.Group();
      upper.position.set(spec.x, hipY, spec.z);
      this.tilt.add(upper);
      /* Heavy at the top, fine at the bottom.
       *
       * Almost all of a horse's leg muscle is in the forearm and gaskin, and
       * below the knee there is essentially only bone and tendon - the cannon
       * is barely thicker than a wrist. Even-width boxes gave it four table
       * legs. The hind pair carries a stifle mass at the top, which is what
       * makes hindquarters read as the end that does the pushing. */
      const upperGeo = spec.front
        ? sweep([
          { y: 0.02, z: 0, rx: 0.19, ry: 0.21 },
          { y: -0.16, z: 0, rx: 0.16, ry: 0.18 },
          { y: -0.40, z: 0, rx: 0.125, ry: 0.14 },
          { y: -0.62, z: 0, rx: 0.090, ry: 0.096 },     // into the knee
        ], 12, { capStart: false })
        : merge([
          sweep([
            { y: 0.04, z: 0.02, rx: 0.20, ry: 0.23 },   // gaskin, the pushing muscle
            { y: -0.14, z: 0.03, rx: 0.18, ry: 0.21 },
            { y: -0.38, z: 0.01, rx: 0.135, ry: 0.155 },
            { y: -0.62, z: 0, rx: 0.090, ry: 0.096 },     // into the hock
          ], 12, { capStart: false }),
          blob(0.15, 0.17, 0.15, 0, -0.10, 0.08, 10),   // stifle
        ]);
      this._owned.push(upperGeo);
      const upperMesh = new THREE.Mesh(upperGeo, coat);
      upperMesh.castShadow = true;
      upper.add(upperMesh);

      const lower = new THREE.Group();
      lower.position.set(0, -0.62, 0);
      upper.add(lower);
      const lowerGeo = merge([
        /* The joint is a station on the cannon, not a ball stuck on top of it.
         *
         * It used to be a separate blob sitting inside the forearm's capped
         * end, which meant a 0.10 dome, then a 0.085 sphere, then a 0.082
         * cannon emerging from underneath - three radii inside four
         * centimetres, read as a knobbly ball on a stick. A carpus really is
         * wider than the cannon below it, but it is continuous with the limb,
         * and it is flatter front-to-back than it is across. */
        sweep([
          { y: 0.03, z: 0, rx: 0.088, ry: 0.094 },    // knee / hock
          { y: -0.09, z: 0, rx: 0.078, ry: 0.086 },
          { y: -0.30, z: 0, rx: 0.066, ry: 0.076 },   // cannon: bone and tendon only
          { y: -0.52, z: 0, rx: 0.064, ry: 0.074 },
          { y: -0.60, z: 0.005, rx: 0.074, ry: 0.080 },  // fetlock
          { y: -0.70, z: 0.03, rx: 0.062, ry: 0.066 },   // pastern, sloped forward
        ], 12, { capStart: false }),
      ]);
      this._owned.push(lowerGeo);
      const lowerMesh = new THREE.Mesh(lowerGeo, coat);
      lowerMesh.castShadow = true;
      lower.add(lowerMesh);
      // Hoof: flared outward toward the ground, like a real one.
      const hoofGeo = sweep([
        { y: -0.72, z: 0.03, rx: 0.068, ry: 0.072 },
        { y: -0.80, z: 0.035, rx: 0.090, ry: 0.096 },
        { y: -0.855, z: 0.04, rx: 0.100, ry: 0.107 },
      ], 12, { capStart: false });
      this._owned.push(hoofGeo);
      lower.add(new THREE.Mesh(hoofGeo, dark));

      this.legs.push({ upper, lower, front: spec.front, prevT: 0 });
    }

    this.root.visible = false;
    this.applyCustomization(this._livery);
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  get alive() {
    return this._alive;
  }

  setVisible(v) {
    this.root.visible = v;
  }

  spawn(position, yaw) {
    this.position.copy(position);
    /* Local, but not as local as it was.
     *
     * A cast from the sky finds whatever roof happens to be overhead and spawns
     * the horse on top of it, so this stays a short probe. It started 1.8 m up,
     * though, and the horse appears several metres in front of the rider - on
     * the mesa's shoulder that is easily a step higher than the rider is
     * standing on. The probe passed under the real surface, found nothing,
     * fell back to the rider's own height and buried the animal two metres
     * inside the slope, where it could not move at all. Three metres clears
     * every step in this world and is still well under any roof. */
    const g = this.physics.groundHeight(position.x, position.z, position.y + 3.0, 14);
    this._groundY = g === null ? position.y : g;
    this.position.y = this._groundY;
    this.heading = yaw;
    this.velocity.set(0, 0, 0);
    this.speed = 0;
    this._vy = 0;
    this._pitch = 0;
    this._roll = 0;
    this._grounded = true;
    this._spawnT = 0;
    this._despawnT = -1;
    this._alive = true;
    this.root.position.copy(this.position);
    this.root.rotation.y = yaw;
    if (!this.root.parent) this.scene.add(this.root);
    this.setVisible(true);
    this.bus?.emit('mount:summoned', { id: this.id, position: this.position.clone() });
  }

  despawn() {
    if (!this._alive || this._despawnT >= 0) return;
    this._despawnT = 0;
  }

  kill() {
    this._alive = false;
    this._ridden = false;
    this._despawnT = -1;
    this._spawnT = 1;
    this.setVisible(false);
    this.root.removeFromParent();
  }

  onMount() {
    this._ridden = true;
  }

  onDismount() {
    this._ridden = false;
  }

  /**
   * Any time the horse has its feet on the ground.
   *
   * A ground mount has no landing sequence to run, but the method still has to
   * exist: {@link MountManager.dismount} reads `canDismount?.()`, and an absent
   * method returns `undefined`, which it cannot tell apart from "not safe yet".
   * Without this, stepping off a horse standing still needs two presses of F.
   *
   * Refusing mid-jump is deliberate and costs the player nothing - gravity ends
   * the jump within a second and the manager completes the dismount itself.
   */
  canDismount() {
    return this._grounded;
  }

  /** Pull up. There is nowhere to land from, so this only sheds speed. */
  requestLanding() {
    this.speed *= 0.35;
  }

  /* ------------------------------------------------------------------ */
  /* Simulation                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * @param {number} dt
   * @param {number} elapsed
   * @param {{throttle:number, strafe:number, yaw:number, boost:boolean, up:number}|null} ctrl
   */
  fixedUpdate(dt, elapsed, ctrl) {
    if (!this._alive) return;
    this._time += dt;

    if (this._spawnT < 1) this._spawnT = Math.min(1, this._spawnT + dt * 1.6);
    if (this._despawnT >= 0) {
      this._despawnT += dt * 1.8;
      if (this._despawnT >= 1) { this.kill(); return; }
    }

    const ridden = !!ctrl;
    const throttle = ridden ? clamp(ctrl.throttle, -1, 1) : 0;
    const steer = ridden ? -clamp(ctrl.strafe, -1, 1) : 0;
    const gallop = ridden && !!ctrl.boost && throttle > 0.1;

    /* ---- gait target ------------------------------------------------- */
    let target = 0;
    if (throttle > 0.05) target = (gallop ? GALLOP_SPEED : CRUISE_SPEED * throttle) * this._powerMul;
    else if (throttle < -0.05) target = CRUISE_SPEED * 0.28 * throttle;  // rein back

    const rate = target > this.speed ? ACCEL * this._accelMul : BRAKE;
    this.speed = damp(this.speed, target, rate * 0.35, dt);
    if (Math.abs(this.speed) < 0.05) this.speed = 0;
    this.speed = clamp(this.speed, -4, MAX_SPEED * this._powerMul);

    /* ---- steering ---------------------------------------------------- *
     * Rate falls off with speed. A horse that can pivot at a gallop stops
     * being a horse - the commitment to a line is most of what riding one
     * feels like. */
    const sp01 = clamp(Math.abs(this.speed) / MAX_SPEED, 0, 1);
    const turnRate = THREE.MathUtils.lerp(TURN_SLOW, TURN_FAST, sp01);
    if (steer !== 0 && (Math.abs(this.speed) > 0.15 || !gallop)) {
      this.heading += steer * turnRate * dt;
    }
    // Lean into the turn, proportional to how fast we are going round it.
    const leanTarget = -steer * sp01 * 0.22;
    this._roll = damp(this._roll, leanTarget, 6, dt);
    // Smoothed, and kept for the frame update: the head and shoulders carry the
    // turn as much as the roll does, and they must not snap when the key does.
    this._turnRate = damp(this._turnRate ?? 0, steer, 5, dt);

    /* ---- jump -------------------------------------------------------- */
    if (ridden && ctrl.up > 0.5 && this._grounded) {
      this._vy = JUMP_V;
      this._grounded = false;
      this.bus?.emit('mount:jump', { id: this.id });
    }

    /* ---- integrate --------------------------------------------------- */
    const fx = -Math.sin(this.heading);
    const fz = -Math.cos(this.heading);
    _mv1.set(fx * this.speed, 0, fz * this.speed);
    this.position.x += _mv1.x * dt;
    this.position.z += _mv1.z * dt;

    this._vy += GRAVITY * dt;
    this.position.y += this._vy * dt;

    /* ---- ground follow ----------------------------------------------- *
     * Probed from above the current position so a step up is caught, and the
     * body pitches to the slope it is standing on. */
    _gp1.set(this.position.x, this.position.y + STEP_UP + 0.4, this.position.z);
    let g = this.physics.groundHeight(_gp1.x, _gp1.z, _gp1.y, STEP_UP + 4.5);
    /* Buried-horse recovery.
     *
     * The probe above starts barely a metre over the horse and casts downward,
     * so once the animal is *under* a surface it can never see it again - the
     * ground it needs to climb back onto is above where the ray begins. Any
     * such horse is stuck for good, which is exactly what happened on the mesa
     * shoulder. When the near probe finds nothing, look again from well
     * overhead and step back up onto whatever is there. Only runs in the case
     * that was previously unrecoverable, so it costs nothing in normal riding. */
    if (g === null) {
      const top = this.position.y + 26;
      const far = this.physics.groundHeight(_gp1.x, _gp1.z, top, 34);
      if (far !== null && far > this.position.y) {
        this.position.y = far;
        this._vy = 0;
        this._grounded = true;
        g = far;
      }
    }
    if (g !== null && this.position.y <= g + 0.02) {
      this.position.y = g;
      this._vy = 0;
      this._grounded = true;
    } else if (g !== null && this.position.y - g < 0.35 && this._vy <= 0) {
      this.position.y = g;
      this._vy = 0;
      this._grounded = true;
    } else {
      this._grounded = false;
    }
    this._groundY = g ?? this._groundY;

    // Pitch to the slope: sample a little ahead and behind.
    const ahead = this.physics.groundHeight(
      this.position.x + fx * 0.9, this.position.z + fz * 0.9, this.position.y + 2, 5
    );
    const behind = this.physics.groundHeight(
      this.position.x - fx * 0.9, this.position.z - fz * 0.9, this.position.y + 2, 5
    );
    if (ahead !== null && behind !== null) {
      const slope = Math.atan2(ahead - behind, 1.8);
      this._pitch = damp(this._pitch, -slope, 7, dt);
    }

    /* ---- blocked ahead ------------------------------------------------ *
     * One forward ray at chest height. A horse cannot walk through a wall, and
     * a full capsule resolve is more than this needs - stopping dead is the
     * correct and readable failure. */
    if (Math.abs(this.speed) > 0.2) {
      _gp2.set(fx * Math.sign(this.speed), 0, fz * Math.sign(this.speed));
      _gp1.set(this.position.x, this.position.y + 1.0, this.position.z);
      const hit = this.physics.raycast(_gp1, _gp2, 1.25, COLLISION_LAYER.WORLD);
      if (hit && Math.abs(hit.normal?.y ?? 0) < 0.6) {
        this.position.x -= _mv1.x * dt;
        this.position.z -= _mv1.z * dt;
        this.speed *= 0.25;
      }
    }

    this.velocity.set(_mv1.x, this._vy, _mv1.z);

    /* ---- gait selection + stride phase -------------------------------- */
    const abs = Math.abs(this.speed);
    let gait = GAITS[0];
    for (const gt of GAITS) { gait = gt; if (abs <= gt.max) break; }
    this._gait = gait;
    if (gait.stride > 0) {
      // Phase advances with distance travelled, not with time, so the hooves
      // do not skate when the horse changes speed.
      this._stridePhase = (this._stridePhase + (abs * dt) / gait.stride) % 1;
    }
    void elapsed;
  }

  /* ------------------------------------------------------------------ */
  /* Pose                                                                */
  /* ------------------------------------------------------------------ */

  update(dt) {
    if (!this._alive) return;
    const s = this._spawnT * (this._despawnT >= 0 ? 1 - this._despawnT : 1);
    this.root.position.copy(this.position);
    this.root.rotation.y = this.heading;
    this.root.scale.setScalar(Math.max(0.01, s));
    this.tilt.rotation.set(this._pitch, 0, this._roll);

    const gait = this._gait;
    const phase = this._stridePhase;
    const table = PHASE[gait.name] ?? PHASE.walk;

    for (let i = 0; i < this.legs.length; i++) {
      const leg = this.legs[i];
      const t = (phase + table[i]) % 1;
      // Swing phase over the first 40% of the cycle, stance for the rest -
      // that asymmetry is what makes a leg look like it is pushing off rather
      // than pedalling.
      let swing;
      let lift;
      if (t < 0.4) {
        const u = t / 0.4;
        swing = Math.sin(u * Math.PI) * (leg.front ? 0.85 : 0.7);
        lift = Math.sin(u * Math.PI) * gait.lift;
      } else {
        const u = (t - 0.4) / 0.6;
        swing = -Math.sin(u * Math.PI) * (leg.front ? 0.5 : 0.62);
        lift = 0;
      }
      leg.upper.rotation.x = swing;
      // The knee folds only on the way through, and only forwards.
      leg.lower.rotation.x = -Math.max(0, swing) * (leg.front ? 0.8 : 1.05);
      leg.upper.position.y = (leg.front ? BODY_Y - 0.16 : BODY_Y - 0.1) + lift * 0.12;

      /* The instant this hoof touches down.
       *
       * t = 0.4 is where the swing ends and the stance begins, which is by
       * definition the moment the foot is on the ground. Taking the sound from
       * the same phase table that placed the leg is the only way four hooves
       * land audibly in the pattern they visibly land in - a timer would drift
       * out of step with the gait within a couple of strides, and a trot that
       * sounds like a canter is worse than no sound at all. */
      const landed = leg.prevT < 0.4 && t >= 0.4;
      leg.prevT = t;
      if (landed && this._grounded && Math.abs(this.speed) > 0.4) {
        this.bus?.emit('mount:footfall', {
          id: this.id,
          position: this.position,
          hard: clamp(Math.abs(this.speed) / MAX_SPEED, 0.15, 1),
        });
      }
    }

    // Body bob, twice a stride, and the head nods against it - a horse's head
    // moves in opposition to its body, which is the tell that it is alive.
    const bob = Math.sin(phase * TAU * 2) * gait.bob;
    this.tilt.position.y = bob;
    this._headBob = damp(this._headBob, Math.sin(phase * TAU) * gait.bob * 2.2, 10, dt);
    this.neck.rotation.x = -0.06 + this._headBob;
    this.head.rotation.x = 0.1 - this._headBob * 0.6;

    // Tail streams with speed and swings gently at rest.
    const sp01 = clamp(Math.abs(this.speed) / MAX_SPEED, 0, 1);
    this.tail.rotation.x = -0.15 - sp01 * 0.55;
    this.tail.rotation.z = Math.sin(this._time * 2.2) * (0.12 - sp01 * 0.08);

    /* ---- the parts that separate a gallop from a fast walk -------------- *
     *
     * Leg timing alone reads as one animation played at different rates. What
     * actually distinguishes the gaits to the eye is the whole animal changing
     * shape: a galloping horse flattens out and reaches with its neck, a halted
     * one stands up and looks around. All of it is driven off the same speed and
     * stride phase, so nothing can fall out of sync with the legs. */

    // Neck lowers and extends into the gallop, rises at the halt.
    const reach = sp01 * sp01;
    this.neck.rotation.x = -0.06 + this._headBob + reach * 0.42;
    this.head.rotation.x = 0.1 - this._headBob * 0.6 - reach * 0.3;

    // Body flexes along its length twice a stride, strongest at the gallop -
    // this is the bunch-and-extend that makes the animal look like it is
    // driving off its hind legs rather than being pushed along.
    this.tilt.rotation.x = this._pitch + Math.sin(phase * TAU * 2) * gait.bob * 0.5 * (0.3 + reach);

    // Lean into the turn. A horse banks a little and, more visibly, carries its
    // head to the inside of the corner.
    const lean = clamp(this._turnRate ?? 0, -1, 1);
    this.tilt.rotation.z = this._roll - lean * 0.16 * sp01;
    this.neck.rotation.y = damp(this.neck.rotation.y ?? 0, -lean * 0.3, 6, dt);

    /* Ears, which cost two rotations and do more for "alive" than anything else
     * here: swivelled back flat at the gallop, forward and flicking at rest. */
    if (this.ears) {
      const flick = Math.sin(this._time * 3.1) * Math.sin(this._time * 1.3);
      for (let i = 0; i < this.ears.length; i++) {
        const side = i === 0 ? -1 : 1;
        this.ears[i].rotation.x = -reach * 0.9 + (1 - sp01) * flick * 0.18;
        this.ears[i].rotation.z = side * (0.12 + reach * 0.35);
      }
    }

    // Mane lifts and streams behind at speed.
    if (this.mane) {
      this.mane.rotation.x = -0.1 - sp01 * 0.7 + Math.sin(phase * TAU * 2) * 0.12 * sp01;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Queries used by MountManager                                        */
  /* ------------------------------------------------------------------ */

  getSeat(out) {
    this.root.position.copy(this.position);
    this.root.rotation.y = this.heading;
    this.tilt.rotation.set(this._pitch, 0, this._roll);
    this.root.updateMatrixWorld(true);
    return out.setFromMatrixPosition(this.riderAnchor.matrixWorld);
  }

  /**
   * World position of a stirrup, so the rider's foot IK has somewhere to go.
   * @param {number} side -1 left, +1 right
   * @param {THREE.Vector3} out
   * @param {number} [lift] metres up the mount's own axis
   */
  getFootWorld(side, out, lift = 0) {
    const a = this.footAnchors[side < 0 ? 0 : 1];
    this.root.updateWorldMatrix(true, true);
    out.setFromMatrixPosition(a.matrixWorld);
    if (lift) out.y += lift;
    return out;
  }

  /** Stirrup for the rider's foot IK. @returns {boolean} */
  getStirrupWorld(side, out) {
    this.getFootWorld(side, out);
    return true;
  }

  /** Rein position for the rider's hand IK. @returns {boolean} */
  getGripWorld(side, out) {
    const a = this.reinAnchors[side < 0 ? 0 : 1];
    if (!a) return false;
    this.root.updateWorldMatrix(true, true);
    out.setFromMatrixPosition(a.matrixWorld);
    return true;
  }

  /** 0..1 how hard the animal is working, for the rider's forward lean. */
  get boost01() {
    return this._gait.name === 'gallop' ? 1 : this._gait.name === 'canter' ? 0.5 : 0;
  }

  /** The body's vertical bob, so the rider absorbs it instead of being welded on. */
  get flap01() {
    return Math.sin(this._stridePhase * Math.PI * 4) * 0.5 + 0.5;
  }

  /**
   * Where the rider ends up when they step off. Beside the horse, on the
   * ground - `MountManager` resolves the capsule from here, so it only has to
   * be approximately right, not guaranteed clear.
   * @param {THREE.Vector3} out
   */
  dismountPoint(out) {
    const rx = Math.cos(this.heading);
    const rz = -Math.sin(this.heading);
    return out.set(
      this.position.x + rx * 1.35,
      this._groundY + 0.05,
      this.position.z + rz * 1.35
    );
  }

  /** 0..1 speed, for camera FOV kick and audio. */
  get speed01() {
    return clamp(Math.abs(this.speed) / MAX_SPEED, 0, 1);
  }

  get bankRoll() {
    return this._roll;
  }

  get bankPitch() {
    return this._pitch;
  }

  get airborne() {
    return !this._grounded;
  }

  get boostActive() {
    return this._gait.name === 'gallop';
  }

  /** Current gait name, for the HUD. */
  get gait() {
    return this._gait.name;
  }

  get fovKick() {
    return this.speed01 * 0.16;
  }

  applyCustomization(livery) {
    this._livery = livery && typeof livery === 'object' ? livery : {};
    if (!this._slotMats) return;
    applyLivery(this._livery, this.constructor.CUSTOM_SLOTS, this._slotMats);
  }

  /** Same ladder as Car: +12% top speed and +10% acceleration per tier; shield stored. */
  applyPowers({ strength = 0, shield = 0, power = 0 } = {}) {
    this._powerMul = 1 + Math.max(0, power) * 0.12;
    this._accelMul = 1 + Math.max(0, strength) * 0.10;
    this._shieldTier = Math.max(0, shield);
  }

  get shieldTier() {
    return this._shieldTier;
  }

  dispose() {
    this.kill();
    for (const o of this._owned) o.dispose?.();
    this._owned.length = 0;
    this._slotMats = null;
  }
}

export default Horse;
