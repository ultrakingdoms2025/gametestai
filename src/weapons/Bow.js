import * as THREE from 'three';
import {
  patchViewmodelDepth, makeMetalMaps, makePolymerMaps, makeCanvas, finishTexture,
  heightToNormal, chamfer, place, mergeBucket, tubeZ, ringZ, spring3, sstep, fbm, DEG,
} from '../player/Weapon.js';
import { CONFIG } from '../core/Config.js';
import { COLLISION_LAYER } from '../physics/Physics.js';
import { ViewArm } from './ViewArm.js';

/**
 * The "Longspine" recurve bow.
 *
 * ── Why the limbs are a bone chain ─────────────────────────────────────────
 * A bow that does not flex is a prop. Each limb here is three nested pivots, so
 * drawing the string rotates every joint a little and the limb bends along a
 * genuine curve rather than hinging at the riser. The string is then *derived*
 * from where the limb tips actually ended up - two cylinders re-oriented and
 * re-scaled each frame between the tips and the nock point - which means the
 * string can never drift off the tips no matter how the draw is animated.
 *
 * Damage, arrow speed and the flatness of the arc all scale with draw, so a
 * snap shot is a weak lob and a full draw is a flat, lethal bolt. Arrows are
 * real projectiles: they fall under gravity, rotate to face their velocity and
 * stick into whatever stops them.
 *
 * Shares `Weapon.js`'s viewmodel depth patch and geometry helpers, so the bow
 * lives in the same near-depth slice as the machine gun and never clips a wall.
 */

/* ------------------------------------------------------------------ */
/* Scratch - one set per concern.                                      */
/* ------------------------------------------------------------------ */
/* pose composition */
const _po1 = new THREE.Vector3();
const _po2 = new THREE.Vector3();
const _po3 = new THREE.Vector3();
/* string solve */
const _st1 = new THREE.Vector3();
const _st2 = new THREE.Vector3();
const _st3 = new THREE.Vector3();
const _stq = new THREE.Quaternion();
/* firing */
const _fi1 = new THREE.Vector3();
const _fi2 = new THREE.Vector3();
const _fi3 = new THREE.Vector3();
const _fi4 = new THREE.Vector3();

const AXIS_Y = new THREE.Vector3(0, 1, 0);
const clamp = THREE.MathUtils.clamp;
const damp = THREE.MathUtils.damp;

const SPEC = Object.assign(
  {
    name: 'Longspine',
    quiver: 12,
    reserve: 48,
    /** Seconds from rest to full draw. */
    drawTime: 0.92,
    /** Below this the archer has not committed; releasing simply relaxes. */
    minDraw: 0.16,
    /** Seconds to pull a fresh arrow from the quiver and nock it. */
    nockTime: 0.7,
    /** Refill the quiver from the reserve. */
    restockTime: 1.7,
    damageMin: 26,
    damageMax: 102,
    speedMin: 40,
    speedMax: 88,
    /** Arrows are heavy: a real arc, not a bullet with a hint of droop. */
    gravity: -11.5,
    /** Holding full draw is tiring - the archer starts to shake and then sags. */
    holdTime: 3.2,
  },
  CONFIG.weapon?.bow ?? {}
);

/**
 * Uniform scale inside the pose rig, as `VM_SCALE` is for the machine gun.
 *
 * The modelled bow is ~1.1 m tip to tip. At the rifle's 0.62 it spans twice the
 * screen height at arm's length and both limbs leave the frame, which hides the
 * flex that is the whole point of the model. 0.44 puts the bow at roughly half
 * the frame height, so the limbs, the string and the nocked arrow are all
 * visible at once.
 */
const BOW_SCALE = 0.44;

/* Poses. The riser sits left of centre so the shaft rides just under the
 * crosshair; drawing brings the whole bow up onto the eye line. */
const HIP_POS = new THREE.Vector3(0.135, -0.2, -0.62);
const HIP_ROT = new THREE.Vector3(0.06, 0.14, 0.14);
// Measured, not guessed: at this offset the nocked arrowhead projects to
// roughly (-0.05, -0.06) in NDC, i.e. just under the crosshair, so the shaft
// visibly points where the shot is going.
const DRAW_POS = new THREE.Vector3(-0.033, -0.011, -0.6);
const DRAW_ROT = new THREE.Vector3(0.0, 0.0, 0.02);
const LOW_POS = new THREE.Vector3(0.1, -0.44, -0.58);
const LOW_ROT = new THREE.Vector3(-0.5, 0.62, -0.42);

/**
 * Shoulders, in view space - the fixed ends of the two solved forearms.
 *
 * An archer's bow arm is the *front* arm, so its shoulder sits inboard and
 * barely below the eye line; the string arm is the rear one and drops further
 * away. Both are behind the eye (+Z), which is what carries the forearms out of
 * the bottom corners rather than across the middle of the frame.
 */
const BOW_SHOULDER = new THREE.Vector3(-0.26, -0.46, 0.04);
const STRING_SHOULDER = new THREE.Vector3(0.32, -0.44, 0.06);
/**
 * Where the string elbow ends up at full draw.
 *
 * Out to the side and level with the hand rather than behind it - the archer's
 * flared elbow. This is not decoration: at full draw the string hand is at the
 * cheek, barely 40 cm from the eye, so an elbow left back at the shoulder
 * leaves no room for a forearm at all and the drawing hand hangs on the string
 * attached to nothing. The elbow has to come round to the side, which is also
 * exactly what a real draw does, because that is the only place a forearm can
 * be when the hand is that close to the face.
 */
const STRING_ELBOW_DRAWN = new THREE.Vector3(0.5, -0.36, -0.38);

/** Limb geometry: three segments per limb, each this long. */
const SEG_LEN = 0.155;
/** Static recurve shape, radians per joint (upper limb; lower is mirrored). */
const RECURVE = [0.2, 0.1, -0.34];
/** Extra bend per joint at full draw. */
const FLEX = [0.2, 0.26, 0.3];
/** Brace height: how far behind the riser the string sits at rest. */
const BRACE_Z = 0.085;
/** How far the nock travels back at full draw. */
const DRAW_LENGTH = 0.34;

/* ------------------------------------------------------------------ */
/* Textures                                                            */
/* ------------------------------------------------------------------ */

/**
 * Yew-like bow wood: long straight grain with a few darker growth rings and
 * scattered figure. Strongly anisotropic - grain that runs the wrong way across
 * a limb is the fastest way to make a wooden object look plastic.
 */
function makeWoodMaps(renderer, size, seed, tint) {
  const albedo = makeCanvas(size);
  const actx = albedo.getContext('2d');
  const aimg = actx.createImageData(size, size);
  const rough = makeCanvas(size);
  const rctx = rough.getContext('2d');
  const rimg = rctx.createImageData(size, size);
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      // Grain runs along V (the limb's long axis), so the noise is stretched
      // ~30:1 in that direction.
      const wobble = fbm(u * 2.2, v * 0.4, seed + 31, 3) * 0.16;
      const rings = Math.abs(Math.sin((u * 13 + wobble * 9) * Math.PI));
      const fibre = fbm(u * 90, v * 3.4, seed, 3);
      const figure = fbm(u * 5, v * 2, seed + 700, 3);

      const dark = Math.pow(1 - rings, 3.2) * 0.55 + fibre * 0.2 + figure * 0.18;
      height[y * size + x] = 1 - dark * 0.7;

      const shade = 1 - dark * 0.62;
      const i = (y * size + x) * 4;
      aimg.data[i] = Math.min(255, tint.r * shade * 255);
      aimg.data[i + 1] = Math.min(255, tint.g * shade * 255);
      aimg.data[i + 2] = Math.min(255, tint.b * shade * 255);
      aimg.data[i + 3] = 255;

      // Late wood is denser and takes a polish; early wood stays matte.
      const rg = clamp(0.62 - (1 - dark) * 0.18 + fibre * 0.1, 0.18, 1);
      rimg.data[i] = rg * 255;
      rimg.data[i + 1] = rg * 255;
      rimg.data[i + 2] = rg * 255;
      rimg.data[i + 3] = 255;
    }
  }
  actx.putImageData(aimg, 0, 0);
  rctx.putImageData(rimg, 0, 0);

  return {
    map: finishTexture(new THREE.CanvasTexture(albedo), renderer, true, 1),
    roughnessMap: finishTexture(new THREE.CanvasTexture(rough), renderer, false, 1),
    normalMap: heightToNormal(height, size, 1.6, renderer),
  };
}

/** Twisted linen bowstring: helical strands, so it reads as cord not wire. */
function makeStringMaps(renderer) {
  const size = 128;
  const albedo = makeCanvas(size);
  const ctx = albedo.getContext('2d');
  const img = ctx.createImageData(size, size);
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      // 14 strands twisting once every eighth of the length.
      const strand = Math.abs(Math.sin((u * 14 + v * 8) * Math.PI));
      const fuzz = fbm(u * 40, v * 40, 88, 2);
      const h = strand * 0.8 + fuzz * 0.2;
      height[y * size + x] = h;
      const s = 0.62 + h * 0.38;
      const i = (y * size + x) * 4;
      img.data[i] = 236 * s;
      img.data[i + 1] = 228 * s;
      img.data[i + 2] = 202 * s;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return {
    map: finishTexture(new THREE.CanvasTexture(albedo), renderer, true, 1),
    normalMap: heightToNormal(height, size, 3, renderer),
  };
}

/* ------------------------------------------------------------------ */

export class BowWeapon {
  /**
   * @param {{scene:THREE.Scene, camera:THREE.PerspectiveCamera, bus:any,
   *          materials:any, engine:any, input:any, physics:any,
   *          projectiles:any, player:any, aimDirection?:(out:THREE.Vector3)=>THREE.Vector3}} ctx
   */
  constructor({ scene, camera, bus, materials, engine, input, physics, projectiles, player, aimDirection }) {
    this.scene = scene;
    this.camera = camera;
    this.bus = bus;
    this.materials = materials;
    this.engine = engine;
    this.input = input;
    this.physics = physics;
    this.projectiles = projectiles;
    this.player = player;
    this.renderer = engine?.renderer ?? null;
    this._aimDirection = aimDirection ?? ((out) => this.camera.getWorldDirection(out));
    this.name = SPEC.name;

    /* ---- ammunition and fire control ---- */
    this._quiver = SPEC.quiver;
    this._reserve = SPEC.reserve;
    this._nocked = true;
    this._nockT = 0;
    this._restockT = 0;
    this._draw = 0;
    this._drawing = false;
    this._holdTime = 0;
    this._lastChargeEmit = -1;
    this._lastShot = -999;
    this._enabled = true;
    this._dryT = 0;
    this._loose = 0;

    /* ---- animation ---- */
    this._time = 0;
    this._lastUpdateAt = -1;
    this._aim = 0;
    this._aimTarget = 0;
    this._lowered = 0;
    this._loweredTarget = 0;
    this._equipT = 0;
    this._bobPhase = 0;
    this._bobWeight = 0;
    this._moveSpeed = 0;
    this._grounded = true;
    this._referenceFov = CONFIG.render.fov;

    this._swayPos = new THREE.Vector2();
    this._swayVel = new THREE.Vector2();
    this._swayTarget = new THREE.Vector2();
    this._recoilPos = new THREE.Vector3();
    this._recoilPosVel = new THREE.Vector3();
    this._recoilRot = new THREE.Vector3();
    this._recoilRotVel = new THREE.Vector3();
    this._camKick = { x: 0, y: 0 };
    this._camKickVel = { x: 0, y: 0 };

    this._disposables = [];

    this._buildMaterials();
    this._buildModel();
    this._buildLights();

    if (!this.camera.parent) this.scene.add(this.camera);
    this.camera.add(this.root);
    this.setVisible(false);
  }

  /* ================================================================ */
  /* Materials                                                         */
  /* ================================================================ */

  _buildMaterials() {
    const r = this.renderer;
    const wood = makeWoodMaps(r, 512, 404, { r: 0.52, g: 0.34, b: 0.17 });
    const horn = makeWoodMaps(r, 256, 909, { r: 0.19, g: 0.14, b: 0.11 });
    const leather = makePolymerMaps(r, 256, 55, { r: 0.26, g: 0.16, b: 0.11 });
    // Glove leather gets its own chart rather than a lighter tint over the
    // grip's. The tint is baked into the albedo, so a `color` multiply can only
    // ever take it further down - the hands and arms cannot be lifted out of
    // near-black without a lighter map to start from.
    const glove = makePolymerMaps(r, 256, 4801, { r: 0.68, g: 0.58, b: 0.47 });
    const steel = makeMetalMaps(r, 256, 313, {
      r: 0.44, g: 0.45, b: 0.48, roughness: 0.38, scratches: 16, repeat: 1,
    });
    const cord = makeStringMaps(r);
    this._maps = { wood, horn, leather, glove, steel, cord };

    this.matWood = patchViewmodelDepth(new THREE.MeshStandardMaterial({
      name: 'bow.wood',
      color: new THREE.Color(0xc79a5e),
      map: wood.map,
      normalMap: wood.normalMap,
      roughnessMap: wood.roughnessMap,
      metalness: 0.02,
      roughness: 1,
      normalScale: new THREE.Vector2(0.55, 0.55),
    }));

    // Horn belly laminate: the dark strip a composite bow is built around, and
    // the visual break that stops the limb reading as one extruded stick.
    this.matHorn = patchViewmodelDepth(new THREE.MeshStandardMaterial({
      name: 'bow.horn',
      color: new THREE.Color(0x4a3a30),
      map: horn.map,
      normalMap: horn.normalMap,
      roughnessMap: horn.roughnessMap,
      metalness: 0.04,
      roughness: 1,
      normalScale: new THREE.Vector2(0.45, 0.45),
    }));

    this.matLeather = patchViewmodelDepth(new THREE.MeshStandardMaterial({
      name: 'bow.leather',
      color: new THREE.Color(0x6a4a34),
      map: leather.map,
      normalMap: leather.normalMap,
      roughnessMap: leather.roughnessMap,
      metalness: 0.03,
      roughness: 1,
      normalScale: new THREE.Vector2(0.5, 0.5),
    }));

    /**
     * Glove and forearm leather.
     *
     * A separate, much lighter material than `matLeather`, which is the grip
     * wrap. The hands and arms used to share the grip's 0x6a4a34 and the fill
     * rig puts very little on them - they are below the key light and side-on
     * to the rim - so they rendered as near-black shapes. Two dark shapes at
     * the bottom of the frame read as holes, not as arms, which is most of why
     * the hands looked like they were floating rather than attached to a body.
     * Skin and glove leather are also simply lighter than a sweat-darkened grip.
     */
    this.matGlove = patchViewmodelDepth(new THREE.MeshStandardMaterial({
      name: 'bow.glove',
      color: new THREE.Color(0xa89880),
      map: glove.map,
      normalMap: glove.normalMap,
      roughnessMap: glove.roughnessMap,
      metalness: 0.03,
      roughness: 1,
      normalScale: new THREE.Vector2(0.4, 0.4),
    }));

    this.matSteel = patchViewmodelDepth(new THREE.MeshStandardMaterial({
      name: 'bow.steel',
      color: new THREE.Color(0x9aa2ae),
      map: steel.map,
      normalMap: steel.normalMap,
      roughnessMap: steel.roughnessMap,
      metalness: 0.92,
      roughness: 1,
      normalScale: new THREE.Vector2(0.32, 0.32),
      envMapIntensity: 1.2,
    }));

    this.matString = patchViewmodelDepth(new THREE.MeshStandardMaterial({
      name: 'bow.string',
      color: new THREE.Color(0xd9d2b8),
      map: cord.map,
      normalMap: cord.normalMap,
      metalness: 0,
      roughness: 0.72,
      normalScale: new THREE.Vector2(0.8, 0.8),
    }));

    this.matFeather = patchViewmodelDepth(new THREE.MeshStandardMaterial({
      name: 'bow.fletching',
      color: new THREE.Color(0xb8523a),
      roughness: 0.86,
      metalness: 0,
      side: THREE.DoubleSide,
    }));

    for (const m of [
      this.matWood, this.matHorn, this.matLeather, this.matGlove,
      this.matSteel, this.matString, this.matFeather,
    ]) this._disposables.push(m);
    for (const set of [wood, horn, leather, glove, steel]) {
      this._disposables.push(set.map, set.normalMap, set.roughnessMap);
    }
    this._disposables.push(cord.map, cord.normalMap);

    this.materials?.register?.('bow.wood', this.matWood);
    this.materials?.register?.('bow.string', this.matString);
  }

  /* ================================================================ */
  /* Model                                                             */
  /* ================================================================ */

  _buildModel() {
    this.root = new THREE.Group();
    this.root.name = 'viewmodel:bow';

    this._model = new THREE.Group();
    this._model.name = 'viewmodel:bow:model';
    this._model.scale.setScalar(BOW_SCALE);
    this.root.add(this._model);

    // The bow is yawed inside the model so the player sees it three-quarters on
    // rather than edge-on, which would reduce it to a vertical line.
    this._bow = new THREE.Group();
    this._bow.name = 'viewmodel:bow:frame';
    this._model.add(this._bow);

    this._buildRiser();
    this._buildLimb(1);
    this._buildLimb(-1);
    this._buildString();
    this._buildArrow();
    this._buildHands();
  }

  /** Riser: grip, arrow shelf, sight window and the limb pockets. */
  _buildRiser() {
    const wood = [];
    const leather = [];
    const steel = [];

    // Deep-sectioned handle with a narrow throat where the hand sits.
    place(wood, chamfer(0.05, 0.13, 0.062, 0.016, 3), 0, -0.03, 0.008);
    place(wood, chamfer(0.044, 0.075, 0.05, 0.014, 3), 0, 0.055, 0.004);
    place(wood, chamfer(0.044, 0.06, 0.05, 0.014, 3), 0, -0.115, 0.006);

    // Sight window: cut in above the grip by adding two flanking uprights
    // rather than by boolean subtraction, which we have no CSG for.
    place(wood, chamfer(0.02, 0.075, 0.05, 0.01, 2), -0.014, 0.055, 0.004);

    // Arrow shelf and the strike plate the shaft rides on.
    place(wood, chamfer(0.052, 0.012, 0.036, 0.005), 0.006, 0.021, -0.012);
    place(leather, chamfer(0.03, 0.006, 0.03, 0.003), 0.012, 0.028, -0.014);

    // Grip wrap: three leather bands over the throat.
    for (let i = 0; i < 3; i++) {
      const g = ringZ(0.031, 0.006, 6, 18);
      g.rotateY(Math.PI / 2);
      place(leather, g, 0, -0.048 - i * 0.03, 0.008, 0, 0, Math.PI / 2);
    }

    // Limb pockets: steel shoes that the limbs socket into.
    for (const sy of [1, -1]) {
      place(steel, chamfer(0.036, 0.03, 0.05, 0.008, 2), 0, sy * 0.098, 0.004);
      place(steel, chamfer(0.042, 0.008, 0.014, 0.003), 0, sy * 0.112, 0.004);
    }

    // Small sight pin on the window side.
    place(steel, tubeZ(0.0022, 0.0022, 0.034, 6), 0.028, 0.078, -0.01, 0, Math.PI / 2, 0);
    place(steel, chamfer(0.006, 0.006, 0.006, 0.002), 0.044, 0.078, -0.01);

    const add = (bucket, mat, name) => {
      const geo = mergeBucket(bucket);
      if (!geo) return;
      this._disposables.push(geo);
      const m = new THREE.Mesh(geo, mat);
      m.name = `viewmodel:bow:${name}`;
      m.castShadow = false;
      m.frustumCulled = false;
      m.renderOrder = 100;
      this._bow.add(m);
    };
    add(wood, this.matWood, 'riser');
    add(leather, this.matLeather, 'grip');
    add(steel, this.matSteel, 'furniture');
  }

  /**
   * One limb as a chain of three pivots.
   *
   * Each joint carries a static recurve angle plus a flex angle that grows with
   * the draw, so the limb bows along its whole length. The tip pivot is exposed
   * as `_upperTip`/`_lowerTip` and is what the string solve reads.
   *
   * @param {number} side +1 upper limb, -1 lower limb
   */
  _buildLimb(side) {
    const root = new THREE.Group();
    root.position.set(0, side * 0.108, 0.004);
    this._bow.add(root);

    const joints = [];
    let parent = root;
    for (let i = 0; i < 3; i++) {
      const joint = new THREE.Group();
      // Every joint after the first starts at the end of the previous segment.
      if (i > 0) joint.position.set(0, side * SEG_LEN, 0);
      parent.add(joint);
      joints.push(joint);

      const wood = [];
      const horn = [];
      // Taper: a limb that does not narrow toward the tip cannot be believed.
      const w0 = 0.038 - i * 0.008;
      const w1 = 0.038 - (i + 1) * 0.008;
      const d0 = 0.019 - i * 0.004;
      const d1 = 0.019 - (i + 1) * 0.004;
      const seg = new THREE.CylinderGeometry(w1 * 0.5, w0 * 0.5, SEG_LEN, 4, 1);
      // Four sides, rotated 45 degrees, gives the flattened rectangular section
      // a real limb has - a round tube reads as a stick.
      seg.rotateY(Math.PI / 4);
      seg.scale(1.32, 1, (d0 + d1) / (w0 + w1) * 1.32);
      place(wood, seg, 0, side * SEG_LEN * 0.5, 0);

      // Horn laminate along the belly (the archer's side, +Z).
      place(horn, chamfer(w0 * 0.72, SEG_LEN * 0.98, 0.005, 0.002), 0, side * SEG_LEN * 0.5, d0 * 0.5 + 0.001);
      // Sinew backing on the outside face.
      place(horn, chamfer(w0 * 0.5, SEG_LEN * 0.98, 0.0035, 0.0015), 0, side * SEG_LEN * 0.5, -(d0 * 0.5) - 0.001);

      for (const [bucket, mat] of [[wood, this.matWood], [horn, this.matHorn]]) {
        const geo = mergeBucket(bucket);
        if (!geo) continue;
        this._disposables.push(geo);
        const m = new THREE.Mesh(geo, mat);
        m.castShadow = false;
        m.frustumCulled = false;
        m.renderOrder = 100;
        joint.add(m);
      }
      parent = joint;
    }

    // Tip: the string groove and a horn nock overlay.
    const tip = new THREE.Group();
    tip.position.set(0, side * SEG_LEN, 0);
    parent.add(tip);
    const nockBucket = [];
    place(nockBucket, chamfer(0.016, 0.03, 0.013, 0.004, 2), 0, side * 0.012, 0.001);
    place(nockBucket, ringZ(0.008, 0.0028, 5, 12), 0, side * 0.022, 0.004, 0, Math.PI / 2, 0);
    const geo = mergeBucket(nockBucket);
    this._disposables.push(geo);
    const nockMesh = new THREE.Mesh(geo, this.matHorn);
    nockMesh.castShadow = false;
    nockMesh.frustumCulled = false;
    nockMesh.renderOrder = 100;
    tip.add(nockMesh);

    // The string attaches a little above the last joint, at the groove.
    const anchor = new THREE.Object3D();
    anchor.position.set(0, side * 0.024, 0.004);
    tip.add(anchor);

    if (side > 0) {
      this._upperJoints = joints;
      this._upperAnchor = anchor;
    } else {
      this._lowerJoints = joints;
      this._lowerAnchor = anchor;
    }
  }

  /**
   * Two string segments plus a serving. Both are unit cylinders along +Y that
   * are re-posed every frame from the solved tip and nock positions, so the
   * string is always exactly on the limbs however they flex.
   */
  _buildString() {
    const geo = new THREE.CylinderGeometry(0.0022, 0.0022, 1, 6, 1);
    // Origin at the base so a Y scale grows the cylinder from one end.
    geo.translate(0, 0.5, 0);
    this._disposables.push(geo);

    this._stringUpper = new THREE.Mesh(geo, this.matString);
    this._stringLower = new THREE.Mesh(geo, this.matString);
    for (const s of [this._stringUpper, this._stringLower]) {
      s.castShadow = false;
      s.frustumCulled = false;
      s.renderOrder = 101;
      this._bow.add(s);
    }

    // Centre serving: the thicker wrap the arrow nocks onto. Rides the nock.
    this._nockPoint = new THREE.Group();
    this._bow.add(this._nockPoint);
    const servingGeo = new THREE.CylinderGeometry(0.0042, 0.0042, 0.05, 8);
    this._disposables.push(servingGeo);
    const serving = new THREE.Mesh(servingGeo, this.matLeather);
    serving.castShadow = false;
    serving.frustumCulled = false;
    serving.renderOrder = 102;
    this._nockPoint.add(serving);
  }

  /** The nocked arrow, parented to the nock point so it travels with the draw. */
  _buildArrow() {
    this._arrow = new THREE.Group();
    this._arrow.name = 'viewmodel:bow:arrow';
    this._nockPoint.add(this._arrow);

    const shaftGeo = new THREE.CylinderGeometry(0.0048, 0.0056, 0.62, 8);
    shaftGeo.rotateX(Math.PI / 2);
    shaftGeo.translate(0, 0, -0.29);
    this._disposables.push(shaftGeo);
    const shaft = new THREE.Mesh(shaftGeo, this.matWood);
    shaft.castShadow = false;
    shaft.frustumCulled = false;
    shaft.renderOrder = 101;
    this._arrow.add(shaft);

    const steel = [];
    // Bodkin head, four-sided so it catches a highlight rather than reading as
    // a smooth cone.
    const head = new THREE.ConeGeometry(0.0125, 0.07, 4);
    head.rotateX(-Math.PI / 2);
    place(steel, head, 0, 0, -0.625, 0, Math.PI * 0.25, 0);
    place(steel, tubeZ(0.0078, 0.0064, 0.024, 8), 0, 0, -0.578);
    const steelGeo = mergeBucket(steel);
    this._disposables.push(steelGeo);
    const headMesh = new THREE.Mesh(steelGeo, this.matSteel);
    headMesh.castShadow = false;
    headMesh.frustumCulled = false;
    headMesh.renderOrder = 101;
    this._arrow.add(headMesh);

    // Three fletches at 120 degrees.
    const fl = [];
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const f = new THREE.PlaneGeometry(0.026, 0.1);
      f.rotateY(Math.PI / 2);
      f.translate(0.016, 0, 0);
      f.rotateZ(a);
      f.translate(0, 0, -0.056);
      fl.push(f);
    }
    const flGeo = mergeBucket(fl);
    this._disposables.push(flGeo);
    const fletch = new THREE.Mesh(flGeo, this.matFeather);
    fletch.castShadow = false;
    fletch.frustumCulled = false;
    fletch.renderOrder = 101;
    this._arrow.add(fletch);

    // Nock: sits on the serving, so it is at the arrow group's origin.
    const nk = [];
    place(nk, tubeZ(0.0072, 0.0062, 0.026, 8), 0, 0, -0.006);
    const nkGeo = mergeBucket(nk);
    this._disposables.push(nkGeo);
    const nock = new THREE.Mesh(nkGeo, this.matHorn);
    nock.castShadow = false;
    nock.frustumCulled = false;
    nock.renderOrder = 101;
    this._arrow.add(nock);
  }

  /**
   * Bow hand (static, on the grip) and string hand (rides the nock).
   *
   * Loose primitives, matching the machine gun's approach: at viewmodel scale
   * the silhouette is what sells a hand, and a badly deformed realistic one
   * looks far worse than a stylised glove.
   */
  _buildHands() {
    /* --- bow hand: wraps the riser throat from the outboard side --- */
    const bowGlove = [];
    place(bowGlove, chamfer(0.042, 0.095, 0.07, 0.018, 2), -0.038, -0.052, 0.006);
    for (let i = 0; i < 4; i++) {
      const y = -0.018 - i * 0.025;
      const rad = 0.0116 - i * 0.0009;
      const f = new THREE.CylinderGeometry(rad, rad * 0.94, 0.062, 8);
      f.rotateZ(Math.PI / 2);
      place(bowGlove, f, -0.012, y, -0.03);
      const f2 = new THREE.CylinderGeometry(rad * 0.92, rad * 0.84, 0.04, 8);
      f2.rotateZ(Math.PI / 2);
      place(bowGlove, f2, 0.016, y - 0.003, -0.034, 0, 0.55, 0);
    }
    // Thumb across the back of the grip.
    const thumb = new THREE.CylinderGeometry(0.0124, 0.011, 0.056, 8);
    thumb.rotateZ(Math.PI / 2);
    place(bowGlove, thumb, -0.018, -0.014, 0.04, 0, -0.4, 0);

    const bowGeo = mergeBucket(bowGlove);
    this._disposables.push(bowGeo);
    const bowHand = new THREE.Mesh(bowGeo, this.matGlove);
    bowHand.name = 'viewmodel:bow:hand-bow';
    bowHand.castShadow = false;
    bowHand.frustumCulled = false;
    bowHand.renderOrder = 100;
    this._bow.add(bowHand);

    // Heel of the bow hand, where the forearm takes over.
    this._bowWrist = new THREE.Object3D();
    this._bowWrist.name = 'viewmodel:bow:wrist-bow';
    this._bowWrist.position.set(-0.05, -0.098, 0.024);
    this._bow.add(this._bowWrist);

    /* --- string hand: three fingers hooked on the serving --- */
    this._stringHand = new THREE.Group();
    this._stringHand.name = 'viewmodel:bow:hand-string';
    this._nockPoint.add(this._stringHand);

    const drawGlove = [];
    // Back of hand, angled as if the knuckles face the archer's cheek.
    place(drawGlove, chamfer(0.042, 0.08, 0.062, 0.016, 2), 0.034, -0.006, 0.032, 0.3, 0, 0);
    // Index above the nock, middle and ring below - a proper three-finger draw.
    for (let i = 0; i < 3; i++) {
      const y = i === 0 ? 0.021 : -0.015 - (i - 1) * 0.023;
      const rad = 0.0116 - i * 0.0007;
      const f = new THREE.CylinderGeometry(rad, rad * 0.94, 0.056, 8);
      f.rotateZ(Math.PI / 2);
      place(drawGlove, f, 0.02, y, 0.006);
      const hook = new THREE.CylinderGeometry(rad * 0.9, rad * 0.8, 0.034, 8);
      place(drawGlove, hook, -0.001, y + (i === 0 ? -0.009 : 0.009), 0.006);
    }
    place(drawGlove, chamfer(0.028, 0.024, 0.03, 0.008), 0.048, -0.032, 0.04, 0.3, 0, 0);

    const drawGeo = mergeBucket(drawGlove);
    this._disposables.push(drawGeo);
    const drawHand = new THREE.Mesh(drawGeo, this.matGlove);
    drawHand.castShadow = false;
    drawHand.frustumCulled = false;
    drawHand.renderOrder = 100;
    this._stringHand.add(drawHand);

    this._stringWrist = new THREE.Object3D();
    this._stringWrist.name = 'viewmodel:bow:wrist-string';
    this._stringWrist.position.set(0.062, -0.03, 0.056);
    this._stringHand.add(this._stringWrist);

    /* --- the two forearms, solved back to the shoulders --- */
    // Neither arm is baked any more. The old pair were cylinders rotated 2.0 rad
    // about X inside the *bow's* frame, so the bow's own yaw swung them until
    // they pointed at the camera and drew as two dark logs lying across the
    // middle of the screen at full draw - hands that appeared to float rather
    // than to come from a body. Anchoring them to fixed shoulders makes both
    // arms leave the bottom corners of the frame in every pose, and the string
    // arm's elbow now flares outward as the draw takes it back, for free.
    this._bowArm = new ViewArm({
      parent: this.root,
      wrist: this._bowWrist,
      anchor: BOW_SHOULDER,
      sleeve: this.matGlove,
      band: this.matSteel,
      wristRadius: 0.014,
      taper: 1.55,
      minEyeDistance: 0.34,
      name: 'viewmodel:bow:arm-bow',
    });
    this._stringArm = new ViewArm({
      parent: this.root,
      wrist: this._stringWrist,
      anchor: STRING_SHOULDER,
      sleeve: this.matGlove,
      band: this.matSteel,
      wristRadius: 0.014,
      taper: 1.55,
      minEyeDistance: 0.34,
      name: 'viewmodel:bow:arm-string',
    });
  }

  _buildLights() {
    this._lightRig = new THREE.Group();
    const key = new THREE.PointLight(0xd8e2ff, 1.1, 1.6, 2);
    key.position.set(-0.42, 0.3, 0.1);
    const rim = new THREE.PointLight(0xffc79a, 0.55, 1.3, 2);
    rim.position.set(0.32, -0.12, -0.5);
    key.castShadow = false;
    rim.castShadow = false;
    key.userData.baseIntensity = key.intensity;
    rim.userData.baseIntensity = rim.intensity;
    this._rigLights = [key, rim];
    this._lightRig.add(key, rim);
    this.camera.add(this._lightRig);
  }

  /* ================================================================ */
  /* Driving                                                           */
  /* ================================================================ */

  setViewContext(ctx) {
    this._referenceFov = ctx.referenceFov;
    this._moveSpeed = ctx.moveSpeed;
    this._grounded = ctx.grounded;
    this._bobPhase = ctx.bobPhase;
    this._bobWeight = ctx.bobWeight;
    const dt = Math.max(ctx.dt ?? 1 / 60, 1e-4);
    this._swayTarget.set(
      clamp((-ctx.lookDeltaX / dt) * 0.012, -0.08, 0.08),
      clamp((ctx.lookDeltaY / dt) * 0.01, -0.065, 0.065)
    );
  }

  setAim(on) { this._aimTarget = on ? 1 : 0; }
  setLowered(on) { this._loweredTarget = on ? 1 : 0; }

  setEnabled(on) {
    this._enabled = on;
    if (!on) this._relax();
  }

  setVisible(on) {
    this.root.visible = on;
    for (const l of this._rigLights) l.intensity = on ? l.userData.baseIntensity : 0;
  }

  update(dt, elapsed) {
    this._time = elapsed;
    if (dt <= 0) return;
    if (elapsed === this._lastUpdateAt) return;
    this._lastUpdateAt = elapsed;

    this._equipT = Math.max(0, this._equipT - dt * 3.4);
    this._dryT = Math.max(0, this._dryT - dt * 7);
    this._loose = Math.max(0, this._loose - dt * 7);

    /* ---- restock: pull a fresh handful of arrows out of the reserve ---- */
    if (this._restockT > 0) {
      this._restockT = Math.max(0, this._restockT - dt);
      if (this._restockT === 0) this._finishRestock();
    }

    /* ---- nocking a fresh arrow after a shot ---- */
    if (!this._nocked && this._nockT > 0) {
      this._nockT = Math.max(0, this._nockT - dt);
      if (this._nockT === 0 && this._quiver > 0) this._nocked = true;
    }

    /* ---- draw ---- */
    if (this._drawing && this._nocked) {
      this._draw = Math.min(1, this._draw + dt / SPEC.drawTime);
      if (this._draw >= 1) this._holdTime += dt;
    } else {
      // Letting down is faster than drawing; a slow relax feels like a bug.
      this._draw = damp(this._draw, 0, 13, dt);
      if (this._draw < 0.004) this._draw = 0;
      this._holdTime = 0;
    }
    this._emitCharge();

    this._aim = damp(this._aim, this._aimTarget, 12, dt);
    // Restocking overrides the sprint stow: the arms are busy either way, but
    // the restock animation needs the bow up where it can be seen.
    this._lowered = damp(this._lowered, this._restockT > 0 ? 0 : this._loweredTarget, 9, dt);

    this._integrateSprings(dt);
    this._updatePose(elapsed);
    this._updateLimbs();
    this._solveString();
    this._solveArms();
  }

  /**
   * Aim both forearms, and lean the string shoulder back with the draw.
   *
   * The lean is the difference between an arm that pulls and one that merely
   * holds: a real draw is made with the back, so the rear shoulder travels
   * several centimetres away from the target while the bow shoulder stays put.
   * Without it the string hand slides back along a forearm whose elbow never
   * moves, which reads as the hand sliding off the arm.
   *
   * The string arm follows the string hand's visibility - while an arrow is
   * being nocked there is no hand on the string, so there is no forearm reaching
   * for it either.
   */
  _solveArms() {
    this._bowArm.solve();

    const shown = this._stringHand.visible;
    this._stringArm.setVisible(shown);
    if (!shown) return;

    this._stringArm.anchor.lerpVectors(STRING_SHOULDER, STRING_ELBOW_DRAWN, this._draw);
    this._stringArm.solve();
  }

  _integrateSprings(dtRaw) {
    const dt = Math.min(dtRaw, 1 / 40);
    this._swayVel.x += (this._swayTarget.x - this._swayPos.x) * 105 * dt - this._swayVel.x * 15 * dt;
    this._swayVel.y += (this._swayTarget.y - this._swayPos.y) * 105 * dt - this._swayVel.y * 15 * dt;
    this._swayPos.x += this._swayVel.x * dt;
    this._swayPos.y += this._swayVel.y * dt;

    this._camKickVel.x += -this._camKick.x * 74 * dt - this._camKickVel.x * 12 * dt;
    this._camKickVel.y += -this._camKick.y * 74 * dt - this._camKickVel.y * 12 * dt;
    this._camKick.x += this._camKickVel.x * dt;
    this._camKick.y += this._camKickVel.y * dt;

    spring3(this._recoilPos, this._recoilPosVel, 170, 20, dt);
    spring3(this._recoilRot, this._recoilRotVel, 190, 19, dt);
  }

  _updatePose(elapsed) {
    // A drawn bow is an aimed bow: the draw blends the pose as strongly as RMB.
    const aim = Math.max(this._aim, this._draw);
    const low = this._lowered * (1 - aim);

    _po1.copy(HIP_POS).lerp(DRAW_POS, aim);
    _po2.copy(HIP_ROT).lerp(DRAW_ROT, aim);
    _po1.lerp(LOW_POS, low);
    _po2.lerp(LOW_ROT, low);

    const anim = 1 - aim * 0.72;
    _po3.set(0, 0, 0);

    const idle = (1 - this._bobWeight) * anim;
    _po3.x += Math.sin(elapsed * 0.83) * 0.004 * idle;
    _po3.y += (Math.sin(elapsed * 1.21) * 0.005 + Math.sin(elapsed * 2.4) * 0.0013) * idle;
    _po2.z += Math.sin(elapsed * 0.69) * 0.014 * idle;
    _po2.x += Math.sin(elapsed * 1.07) * 0.009 * idle;

    const bw = this._bobWeight * anim;
    if (bw > 0.001) {
      const p = this._bobPhase;
      _po3.x += Math.cos(p) * 0.017 * bw;
      _po3.y += Math.sin(p * 2) * 0.012 * bw;
      _po3.z += Math.sin(p * 2 + 1.1) * 0.006 * bw;
      _po2.z += Math.cos(p) * 0.052 * bw;
      _po2.x += Math.sin(p * 2) * 0.024 * bw;
    }

    _po3.x += this._swayPos.x * 0.095 * anim;
    _po3.y += this._swayPos.y * 0.075 * anim;
    _po2.y += this._swayPos.x * 0.95 * anim;
    _po2.x += this._swayPos.y * 0.72 * anim;
    _po2.z += this._swayPos.x * 0.5 * anim;

    // Holding a full draw is tiring: the shake grows, and the archer starts to
    // let down once past `holdTime`.
    if (this._holdTime > 0) {
      const fatigue = clamp(this._holdTime / SPEC.holdTime, 0, 1);
      const shake = fatigue * 0.0055;
      _po3.x += Math.sin(elapsed * 23.7) * shake;
      _po3.y += Math.sin(elapsed * 31.1) * shake;
      _po2.z += Math.sin(elapsed * 18.3) * fatigue * 0.02;
    }

    // The loose: the bow leaps forward out of the hand as the limbs unload.
    if (this._loose > 0) {
      const l = this._loose * this._loose;
      _po3.z -= l * 0.03;
      _po2.x += l * 0.1;
    }

    _po3.add(this._recoilPos);
    _po2.x += this._recoilRot.x;
    _po2.y += this._recoilRot.y;
    _po2.z += this._recoilRot.z;

    if (this._dryT > 0) _po2.z += this._dryT * 0.05;

    // Reaching for the quiver over the shoulder.
    if (this._restockT > 0) {
      const t = 1 - this._restockT / SPEC.restockTime;
      const reach = sstep(0, 0.45, t) * (1 - sstep(0.55, 1, t));
      _po3.y -= reach * 0.19;
      _po3.x -= reach * 0.07;
      _po2.z += reach * 0.6;
      _po2.x -= reach * 0.35;
    }

    if (this._equipT > 0) {
      const e = this._equipT * this._equipT;
      _po3.y -= e * 0.34;
      _po2.x -= e * 0.75;
      _po2.z -= e * 0.5;
    }

    _po1.addScaledVector(_po3, BOW_SCALE);
    this._model.position.copy(_po1);
    this._model.rotation.set(_po2.x, _po2.y, _po2.z, 'XYZ');

    // Yaw the bow itself out of profile, straightening as the shot is aimed.
    //
    // This used to be 0.46 falling to 0.10, which stacked with the hip pose's
    // own yaw to put the bow - and therefore the nocked arrow, which is fixed to
    // the bow's plane - 44 degrees off the view axis at rest. The arrow read as
    // a stick lying diagonally across the screen pointing nowhere near the
    // crosshair. 0.2 still shows the bow three-quarters on rather than as a bare
    // vertical line, and by full draw the shaft is within a degree of the axis
    // the arrow will actually fly down.
    this._bow.rotation.y = 0.2 - aim * 0.185;
    this._bow.rotation.z = 0.1 - aim * 0.08;

    const r = Math.tan(this.camera.fov * 0.5 * DEG) / Math.tan(this._referenceFov * 0.5 * DEG);
    this.root.scale.set(r, r, 1);
  }

  /**
   * Flex the limbs and slide the nock point.
   *
   * The nock rides straight back along +Z; the limb joints each take their
   * static recurve angle plus a share of the flex, which is what produces a
   * curve instead of a hinge.
   */
  _updateLimbs() {
    const d = this._draw;
    // Draw weight rises faster than the draw itself - the classic stacking
    // curve - so the last third of the pull visibly bends the limbs hardest.
    const flex = Math.pow(d, 0.78);

    for (let i = 0; i < 3; i++) {
      this._upperJoints[i].rotation.x = RECURVE[i] + FLEX[i] * flex;
      this._lowerJoints[i].rotation.x = -(RECURVE[i] + FLEX[i] * flex);
    }

    // Nock travel. On release the string overshoots forward past brace height
    // and rings back - that snap is most of what makes a bow feel powerful.
    const snap = this._loose > 0 ? -Math.sin(this._loose * Math.PI * 3.2) * this._loose * 0.05 : 0;
    this._nockPoint.position.set(0, 0.024, BRACE_Z + d * DRAW_LENGTH + snap);

    // The arrow is only on the string while one is nocked.
    this._arrow.visible = this._nocked && this._restockT <= 0;
    this._stringHand.visible = this._nocked && this._restockT <= 0;
    // The string hand only closes on the serving once the draw begins.
    this._stringHand.position.z = (1 - Math.min(1, d * 4)) * 0.02;
  }

  /**
   * Re-pose the two string segments between the (now flexed) limb tips and the
   * nock point. Derived, never animated by hand - so the string is always
   * exactly on the nocks.
   */
  _solveString() {
    this._upperAnchor.updateWorldMatrix(true, false);
    this._lowerAnchor.updateWorldMatrix(true, false);
    this._nockPoint.updateWorldMatrix(true, false);

    _st3.copy(this._nockPoint.position);

    for (const [anchor, mesh] of [
      [this._upperAnchor, this._stringUpper],
      [this._lowerAnchor, this._stringLower],
    ]) {
      _st1.setFromMatrixPosition(anchor.matrixWorld);
      this._bow.worldToLocal(_st1);
      _st2.subVectors(_st3, _st1);
      const len = _st2.length();
      if (len < 1e-5) continue;
      _st2.multiplyScalar(1 / len);
      mesh.position.copy(_st1);
      _stq.setFromUnitVectors(AXIS_Y, _st2);
      mesh.quaternion.copy(_stq);
      mesh.scale.set(1, len, 1);
    }
  }

  /* ================================================================ */
  /* Fire control                                                      */
  /* ================================================================ */

  /**
   * Begin drawing. Returns true on the frame the draw starts.
   * @param {number} elapsed engine time in seconds
   */
  tryFire(elapsed) {
    this._time = elapsed;
    if (!this._enabled || this._drawing) return false;
    if (this._restockT > 0) return false;

    if (!this._nocked) {
      // Still nocking; nothing to do but wait it out.
      if (this._quiver <= 0 && this._nockT <= 0) {
        this._dryT = 1;
        this.bus.emit('weapon:dry', { reserve: this._reserve, id: 'bow' });
        if (this._reserve > 0) this.reload();
      }
      return false;
    }

    this._drawing = true;
    return true;
  }

  /**
   * Loose the arrow. A draw under `minDraw` is treated as a change of mind and
   * simply relaxes - shooting an arrow two metres would only ever be an
   * accident.
   * @returns {boolean} true if an arrow left the bow
   */
  releaseFire() {
    if (!this._drawing) return false;
    this._drawing = false;

    const draw = this._draw;
    if (!this._nocked || draw < SPEC.minDraw) {
      this._relax();
      return false;
    }

    this._quiver = Math.max(0, this._quiver - 1);
    this._nocked = false;
    this._nockT = SPEC.nockTime;
    this._loose = 1;
    this._draw = 0;
    this._holdTime = 0;
    this._lastShot = this._time;
    this._emitCharge(true);

    const t = draw;
    const damage = SPEC.damageMin + (SPEC.damageMax - SPEC.damageMin) * t;
    const speed = SPEC.speedMin + (SPEC.speedMax - SPEC.speedMin) * t;
    this._launch(damage, speed);

    this._addRecoil(0.35 + t * 0.5);
    this.bus.emit('camera:shake', { amount: 0.03 + t * 0.05, duration: 0.12 });
    this._emitAmmo();

    if (this._quiver <= 0 && this._reserve > 0) this.reload();
    return true;
  }

  _launch(damage, speed) {
    this._aimDirection(_fi1).normalize();

    // Launch from the arrowhead, so the shaft is seen to leave the bow.
    this._arrow.updateWorldMatrix(true, false);
    _fi2.set(0, 0, -0.62);
    _fi2.applyMatrix4(this._arrow.matrixWorld);
    this.camera.getWorldPosition(_fi3);

    // Never start the arrow on the far side of a wall the player is hugging.
    _fi4.subVectors(_fi2, _fi3);
    const reach = _fi4.length();
    if (reach > 1e-4) {
      _fi4.multiplyScalar(1 / reach);
      const hit = this.physics?.raycast?.(_fi3, _fi4, reach, COLLISION_LAYER.WORLD);
      if (hit) _fi2.copy(_fi3).addScaledVector(_fi4, Math.max(0.05, hit.distance - 0.1));
    }

    this.projectiles?.spawn?.({
      kind: 'arrow',
      origin: _fi2,
      direction: _fi1,
      speed,
      damage,
      gravity: SPEC.gravity,
      radius: 0.04,
      aoe: 0,
      owner: this.player,
      life: 8,
    });
  }

  _relax() {
    this._drawing = false;
    this._holdTime = 0;
    this._emitCharge(true);
  }

  _emitCharge(force = false) {
    const c = this._drawing ? this._draw : 0;
    if (!force && Math.abs(c - this._lastChargeEmit) < 0.01) return;
    this._lastChargeEmit = c;
    this.bus.emit('weapon:charging', { id: 'bow', charge01: c });
  }

  _addRecoil(power) {
    const rand = Math.random() - 0.5;
    // A bow has no recoil to speak of; what it has is the limbs unloading, so
    // the kick is small, forward, and mostly rotational.
    this._camKickVel.y += 0.32 * power;
    this._camKickVel.x += rand * 0.2 * power;
    this._recoilPosVel.z -= 0.4 * power;
    this._recoilRotVel.x += 1.3 * power;
    this._recoilRotVel.z += rand * 0.9 * power;
  }

  /** Restock the quiver from the reserve. */
  reload() {
    if (this._restockT > 0) return false;
    if (this._quiver >= SPEC.quiver || this._reserve <= 0) return false;
    this._relax();
    this._draw = 0;
    this._restockT = SPEC.restockTime;
    this.bus.emit('weapon:reload-start', { duration: SPEC.restockTime, id: 'bow' });
    return true;
  }

  _finishRestock() {
    const need = SPEC.quiver - this._quiver;
    const take = Math.min(need, this._reserve);
    this._quiver += take;
    this._reserve -= take;
    if (this._quiver > 0) {
      this._nocked = true;
      this._nockT = 0;
    }
    this.bus.emit('weapon:reload-end', { ammo: this._quiver, reserve: this._reserve, id: 'bow' });
    this._emitAmmo();
  }

  resupply() {
    this._quiver = SPEC.quiver;
    this._reserve = SPEC.reserve;
    this._restockT = 0;
    this._nockT = 0;
    this._nocked = true;
    this._relax();
    this._draw = 0;
  }

  _emitAmmo() {
    this.bus.emit('weapon:ammo', {
      ammo: this._quiver, reserve: this._reserve, magazine: SPEC.quiver, id: 'bow',
    });
  }

  /* ================================================================ */
  /* Shared weapon interface                                           */
  /* ================================================================ */

  get id() { return 'bow'; }
  get icon() { return 'bow'; }
  get accent() { return '#8fd66a'; }
  get ammoKind() { return 'quiver'; }

  get ammo() { return this._quiver; }
  get reserve() { return this._reserve; }
  get magazine() { return SPEC.quiver; }
  get isReloading() { return this._restockT > 0; }
  get reloadProgress() { return this._restockT > 0 ? 1 - this._restockT / SPEC.restockTime : 0; }
  get chargeLevel() { return this._drawing ? this._draw : 0; }
  /** A full draw is steady; a snap shot scatters. */
  get spread() { return 0.02 * (1 - this._draw); }

  /** Drawing tightens the view, exactly as the contract asks. */
  get aimProgress() { return Math.max(this._aim, this._draw * 0.55); }

  getRecoilOffset() { return this._camKick; }

  addRecoil() { this._addRecoil(1); }

  onSelect() {
    this._enabled = true;
    this._equipT = 1;
    this._lowered = 1;
    this._loweredTarget = 0;
    this.setVisible(true);
    this._emitAmmo();
  }

  onDeselect() {
    this._relax();
    this._draw = 0;
    this._aim = 0;
    this._aimTarget = 0;
    this.setVisible(false);
  }

  serialize() {
    return { quiver: this._quiver, reserve: this._reserve };
  }

  deserialize(data) {
    if (!data) return;
    if (Number.isFinite(data.quiver)) this._quiver = clamp(data.quiver, 0, SPEC.quiver);
    if (Number.isFinite(data.reserve)) this._reserve = Math.max(0, data.reserve);
    this._nocked = this._quiver > 0;
    this._emitAmmo();
  }

  dispose() {
    this._bowArm?.dispose();
    this._stringArm?.dispose();
    this.root.removeFromParent();
    this._lightRig?.removeFromParent();
    for (const d of this._disposables) d?.dispose?.();
    this._disposables.length = 0;
  }
}

export default BowWeapon;
