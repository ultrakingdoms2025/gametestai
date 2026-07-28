import * as THREE from 'three';
import {
  patchViewmodelDepth, makeMetalMaps, makePolymerMaps, makeCanvas, finishTexture,
  heightToNormal, chamfer, place, mergeBucket, tubeZ, ringZ, spring3, sstep, fbm, DEG,
} from '../player/Weapon.js';
import { CONFIG } from '../core/Config.js';
import { COLLISION_LAYER } from '../physics/Physics.js';
import { WEAPON_STATS } from '../systems/WeaponStats.js';

/**
 * The "Aetherbrand" arming sword.
 *
 * ── Why the blade is a lofted section rather than a flattened box ───────────
 * A sword read at viewmodel distance is almost entirely edge highlight: the eye
 * reads the shape from where the specular breaks along the bevel, the fuller and
 * the distal taper. A scaled box has exactly one break - the silhouette - and
 * looks like a ruler no matter how good the texture is. So the blade here is a
 * real lofted solid: a 20-point cross-section (edge bevel, flat shoulder, fuller
 * groove, mirrored) swept along 22 stations that taper in *both* width and
 * thickness, with the fuller fading out before the distal third exactly as a
 * forged blade's does. That is what produces the three separate highlight lines
 * running down the blade in a screenshot.
 *
 * ── Why the swing is a pose blend and not a keyframe track ──────────────────
 * The swing has to be interruptible - by a weapon switch, a death, a world
 * change, or the player letting go halfway - and it has to compose with the same
 * sway, bob and idle breathing every other viewmodel uses. A baked track cannot
 * do that. Instead the timeline drives two scalars: `w`, how much the swing pose
 * overrides the guard pose, and `s`, position along the arc. Everything else is
 * a lerp, so the swing can be blended out from any frame without a pop.
 *
 * Weight comes from three things that all cost nothing: the wind-up cocks *away*
 * before the arc (anticipation), the arc's ease decelerates into the
 * follow-through rather than stopping dead, and a connect applies ~60 ms of
 * hit-stop that slows the swing's own clock. Without the hit-stop the sword
 * passes through a body at the same speed it passes through air, and no amount
 * of particle work makes that feel like it hit something.
 *
 * ── Hit detection ──────────────────────────────────────────────────────────
 * An arc sweep, not a raycast. Each tick inside the damage window we know the
 * angular band the edge crossed since the previous tick, so a target is hit if
 * its bearing falls in that band, it is inside `range`, within `verticalReach`,
 * and there is line of sight. Testing the *band* rather than the instantaneous
 * angle is what makes the sweep frame-rate independent - a 250 fps frame covers
 * a two-degree band and a 30 fps frame covers twenty, and both hit the same
 * targets. Each NPC can only be entered into `_hitThisSwing` once.
 *
 * Shares `Weapon.js`'s viewmodel depth patch and geometry helpers, so the sword
 * lives in the same near-depth slice as the other three and never clips a wall.
 *
 * Lights: two very short-range fill lights are parented to the camera in the
 * constructor, matching the machine gun and the bow. They are never added or
 * removed after construction - `setVisible` drives their intensity to zero
 * instead - because changing the scene light count invalidates Three's whole
 * program cache and recompiles every material in view.
 */

/* ------------------------------------------------------------------ */
/* Scratch - one set per concern. Sharing these across concerns is how  */
/* this project lost two days to aliasing bugs; see Physics.js.         */
/* ------------------------------------------------------------------ */
/* pose composition */
const _po1 = new THREE.Vector3();
const _po2 = new THREE.Vector3();
const _po3 = new THREE.Vector3();
/* trail sampling */
const _tr1 = new THREE.Vector3();
const _tr2 = new THREE.Vector3();
/* melee sweep */
const _sw1 = new THREE.Vector3();
const _sw2 = new THREE.Vector3();
const _sw3 = new THREE.Vector3();
const _sw4 = new THREE.Vector3();
/* impact effects */
const _im1 = new THREE.Vector3();
const _im2 = new THREE.Vector3();
const _im3 = new THREE.Vector3();
const _im4 = new THREE.Vector3();

const clamp = THREE.MathUtils.clamp;
const damp = THREE.MathUtils.damp;

const SPEC = WEAPON_STATS.sword;

/**
 * Uniform scale inside the pose rig, as `VM_SCALE` is for the machine gun.
 *
 * The sword is modelled at true size: 1.02 m pommel to point. At the rifle's
 * 0.62 the blade is longer than the screen is tall and the point leaves the
 * frame during the guard pose, which hides the taper that is the whole reason
 * for the lofted section. 0.5 puts the point just inside the top-left corner at
 * guard and lets the full arc stay on screen through the swing.
 */
const SWORD_SCALE = 0.5;

/* Model space: the grip pivot is the origin and the blade runs along -Z, the
 * same convention as the machine gun's barrel, so the shared helpers apply. */
const GUARD_Z = -0.045;
const BLADE_Z0 = -0.052;
const BLADE_Z1 = -0.855;
const BLADE_HALF_W = 0.0245;
const BLADE_HALF_T = 0.0058;
/**
 * Sampled for the trail ribbon: the point, and a station part-way down the edge.
 *
 * The inner sample used to sit just past the guard, so the ribbon was as wide as
 * the blade is long - at 0.5 scale and a 75-degree frustum that is a sheet
 * covering a third of the screen, which is why the artefact read as a "big
 * triangle" rather than as a streak. A real edge trail is struck by the
 * percussion point outwards; taking the outer ~54% of the edge gives an arc with
 * a readable inner boundary instead of a wing.
 */
const TRAIL_INNER_FRAC = 0.46;
const TIP_LOCAL = new THREE.Vector3(0, 0, BLADE_Z1);
const TRAIL_INNER_LOCAL = new THREE.Vector3(
  0, 0, BLADE_Z1 + (BLADE_Z0 - BLADE_Z1) * TRAIL_INNER_FRAC
);

/* Poses, in the machine gun's convention: model units, -Z forward. A positive
 * rotation about X lifts the point; a positive rotation about Y swings it left. */
const REST_POS = new THREE.Vector3(0.285, -0.335, -0.5);
const REST_ROT = new THREE.Vector3(0.72, 0.26, 0.4);
/** RMB brings the sword into a high guard, blade vertical ahead of the eye. */
const GUARD_POS = new THREE.Vector3(0.145, -0.235, -0.44);
const GUARD_ROT = new THREE.Vector3(1.02, 0.1, 0.24);
const LOW_POS = new THREE.Vector3(0.35, -0.53, -0.46);
const LOW_ROT = new THREE.Vector3(0.2, 0.78, -0.36);
/** Base pose the swing lerps onto: the sword comes up in front of the face. */
const SWING_POS = new THREE.Vector3(0.055, -0.115, -0.45);
const SWING_ROT = new THREE.Vector3(0.16, 0, 0.08);

/* Arc extremes, radians. `dir` (+1 / -1) mirrors them so consecutive swings
 * alternate hand, which is what stops a held attack reading as a loop. */
const COCK_YAW = -1.02;
const END_YAW = 1.24;
const COCK_PITCH = 0.62;
const END_PITCH = -0.66;
const COCK_ROLL = -0.5;
const END_ROLL = 0.72;

/** Samples in the edge trail ribbon. 18 covers ~0.3 s of arc at 60 fps. */
const TRAIL_SAMPLES = 18;
/** Impact spark budget. Two overlapping hits never exhaust it. */
const SPARK_COUNT = 72;
/** Cap on distinct targets a single swing may cut. */
const MAX_SWING_HITS = 12;

/* ------------------------------------------------------------------ */
/* Textures                                                            */
/* ------------------------------------------------------------------ */

/**
 * Polished, hand-finished blade steel.
 *
 * Deliberately *not* the machine gun's phosphate finish: a blade is polished
 * along its length, so the tool marks run axially and the roughness variation is
 * very low. The pattern-weld ghosting is what keeps a near-mirror surface from
 * reading as untextured plastic when the environment behind it is flat.
 */
function makeBladeMaps(renderer, size, seed) {
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

      // Axial polish: high frequency across the blade, almost none along it.
      const polish = fbm(u * 46, v * 1.6, seed, 2);
      // Pattern-weld ghosting: broad chevrons folded along the length.
      const fold = fbm(u * 3.2 + Math.sin(v * 9.1) * 0.35, v * 5.5, seed + 311, 3);
      // A handful of use marks, kept faint - this is a maintained weapon.
      const nick = Math.max(0, fbm(u * 12, v * 30, seed + 707, 2) - 0.74) * 3.6;

      const h = polish * 0.1 + fold * 0.5 - nick * 0.4;
      height[y * size + x] = h;

      // Steel's base colour is its specular tint. 0.55 is bright polished steel;
      // anything under ~0.4 turns the blade into pewter under tone mapping.
      const shade = 0.94 + (fold - 0.5) * 0.13 + (polish - 0.5) * 0.05;
      const i = (y * size + x) * 4;
      aimg.data[i] = Math.min(255, 0.55 * shade * 255);
      aimg.data[i + 1] = Math.min(255, 0.565 * shade * 255);
      aimg.data[i + 2] = Math.min(255, 0.6 * shade * 255);
      aimg.data[i + 3] = 255;

      const rg = clamp(0.15 + (fold - 0.5) * 0.09 + nick * 0.3, 0.04, 0.7);
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
    // Shallow: a deep normal map on a mirror finish reads as hammered, not honed.
    normalMap: heightToNormal(height, size, 1.1, renderer),
  };
}

/** Soft additive dot for the impact sparks. */
function makeSparkTexture(renderer) {
  const size = 64;
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'lighter';
  const h = size / 2;
  const g = ctx.createRadialGradient(h, h, 0, h, h, h);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,226,168,0.8)');
  g.addColorStop(0.6, 'rgba(255,130,32,0.18)');
  g.addColorStop(1, 'rgba(180,40,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return finishTexture(new THREE.CanvasTexture(c), renderer, true, 1);
}

/**
 * Gradient used along the edge trail: hot white at the edge fading to a cool
 * aether blue at the trailing edge, so the ribbon reads as a light streak
 * rather than a flat quad.
 */
function makeTrailTexture(renderer) {
  const size = 64;
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.18, 'rgba(206,236,255,0.85)');
  g.addColorStop(0.55, 'rgba(96,170,255,0.32)');
  g.addColorStop(1, 'rgba(30,70,160,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return finishTexture(new THREE.CanvasTexture(c), renderer, true, 1);
}

/* ------------------------------------------------------------------ */
/* Blade geometry                                                      */
/* ------------------------------------------------------------------ */

/**
 * Cross-section of the blade, as fractions of half-width / half-thickness.
 *
 * Traversed once around the loop: right edge, up over the top face (bevel,
 * shoulder, fuller wall, fuller floor, mirrored), left edge, and back under the
 * bottom face. `f` marks a point whose height is modulated by the fuller depth,
 * so the same loop can describe a fullered section near the hilt and a plain
 * diamond section out at the point.
 */
const SECTION = [
  [1.0, 0.0, 0], [0.86, 0.62, 0], [0.66, 1.0, 0], [0.46, 1.0, 0],
  [0.34, 1.0, 1], [0.0, 0.94, 1], [-0.34, 1.0, 1],
  [-0.46, 1.0, 0], [-0.66, 1.0, 0], [-0.86, 0.62, 0],
  [-1.0, 0.0, 0],
  [-0.86, -0.62, 0], [-0.66, -1.0, 0], [-0.46, -1.0, 0],
  [-0.34, -1.0, 1], [0.0, -0.94, 1], [0.34, -1.0, 1],
  [0.46, -1.0, 0], [0.66, -1.0, 0], [0.86, -0.62, 0],
];

/**
 * Loft the blade.
 *
 * Exported because it is the one piece of this file with no DOM or WebGL
 * dependency, so it can be verified under Node - which is worth a great deal
 * for a routine that hand-builds an index buffer.
 *
 * @param {{halfWidth:number, halfThick:number, z0:number, z1:number,
 *          stations?:number, fullerDepth?:number, fullerEnd?:number,
 *          distal?:number}} opts
 * @returns {THREE.BufferGeometry}
 */
export function makeBladeGeometry(opts) {
  const {
    halfWidth, halfThick, z0, z1,
    stations = 22,
    // How far the groove sinks into the flat, as a fraction of half-thickness.
    fullerDepth = 0.46,
    // The fuller runs out here, in 0..1 along the blade.
    fullerEnd = 0.58,
    // Where the distal taper into the point begins.
    distal = 0.82,
  } = opts;

  const P = SECTION.length;
  const vertCount = stations * P + 2; // + tip apex + base centre
  const pos = new Float32Array(vertCount * 3);
  const uv = new Float32Array(vertCount * 2);

  const widthAt = (u) => {
    const base = 1 - 0.36 * u;
    if (u <= distal) return base;
    const k = (u - distal) / (1 - distal);
    return base * (1 - k * k * 0.96);
  };
  const thickAt = (u) => {
    const base = 1 - 0.44 * u;
    if (u <= distal) return base;
    const k = (u - distal) / (1 - distal);
    return base * (1 - k * 0.85);
  };

  for (let i = 0; i < stations; i++) {
    // Station spacing is biased toward the point so the distal taper is smooth;
    // a uniform spread facets visibly over the last 15 cm.
    const t = i / (stations - 1);
    const u = 1 - Math.pow(1 - t, 1.45);
    const z = z0 + (z1 - z0) * u;
    const w = halfWidth * widthAt(u);
    const th = halfThick * thickAt(u);
    // Fuller fades in over the first few centimetres (it starts at the ricasso,
    // not at the guard) and runs out before the distal taper.
    const fIn = sstep(0, 0.06, u);
    const fOut = 1 - sstep(fullerEnd * 0.72, fullerEnd, u);
    const fuller = fullerDepth * fIn * fOut;

    for (let j = 0; j < P; j++) {
      const [fx, fy, isFuller] = SECTION[j];
      const y = th * fy * (isFuller ? 1 - fuller : 1);
      const idx = (i * P + j) * 3;
      pos[idx] = w * fx;
      pos[idx + 1] = y;
      pos[idx + 2] = z;
      const uvIdx = (i * P + j) * 2;
      uv[uvIdx] = j / P;
      uv[uvIdx + 1] = u;
    }
  }

  const apex = stations * P;
  pos[apex * 3] = 0;
  pos[apex * 3 + 1] = 0;
  pos[apex * 3 + 2] = z1 + (z1 - z0) * 0.006;
  uv[apex * 2] = 0.5;
  uv[apex * 2 + 1] = 1;

  const baseC = apex + 1;
  pos[baseC * 3] = 0;
  pos[baseC * 3 + 1] = 0;
  pos[baseC * 3 + 2] = z0;
  uv[baseC * 2] = 0.5;
  uv[baseC * 2 + 1] = 0;

  const idx = [];
  for (let i = 0; i < stations - 1; i++) {
    for (let j = 0; j < P; j++) {
      const a = i * P + j;
      const b = i * P + ((j + 1) % P);
      const c = (i + 1) * P + j;
      const d = (i + 1) * P + ((j + 1) % P);
      idx.push(a, c, b, b, c, d);
    }
  }
  const last = (stations - 1) * P;
  for (let j = 0; j < P; j++) {
    idx.push(last + j, apex, last + ((j + 1) % P));
  }
  for (let j = 0; j < P; j++) {
    idx.push(j, ((j + 1) % P), baseC);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/* ------------------------------------------------------------------ */

export class SwordWeapon {
  /**
   * @param {{scene:THREE.Scene, camera:THREE.PerspectiveCamera, bus:any,
   *          materials:any, engine:any, input:any, physics:any, player:any,
   *          npcManager:any, combat?:any,
   *          aimDirection?:(out:THREE.Vector3)=>THREE.Vector3}} ctx
   */
  constructor({
    scene, camera, bus, materials, engine, input, physics,
    player, npcManager, combat, aimDirection,
  }) {
    this.scene = scene;
    this.camera = camera;
    this.bus = bus;
    this.materials = materials;
    this.engine = engine;
    this.input = input;
    this.physics = physics;
    this.player = player;
    this.npcManager = npcManager;
    this.combat = combat ?? null;
    this.renderer = engine?.renderer ?? null;
    this._aimDirection = aimDirection ?? ((out) => this.camera.getWorldDirection(out));
    this.name = 'Aetherbrand';

    /* ---- swing state ---- */
    /** -1 when idle, else 0..1 progress through `SPEC.swingTime`. */
    this._swingT = -1;
    /** +1 / -1: alternating hand, so a held attack does not read as a loop. */
    this._swingDir = 1;
    /** Targets already cut by the current swing. */
    this._hitThisSwing = [];
    this._hitCount = 0;
    /** Seconds of remaining hit-stop; slows the swing's own clock. */
    this._hitStop = 0;
    /** True once this swing has spent its single world-impact probe. */
    this._worldProbed = false;
    this._lastSwingEnd = -999;
    this._queued = false;
    this._enabled = true;
    this._time = 0;
    this._lastUpdateAt = -1;

    /* ---- animation ---- */
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
    this._offs = [];

    this._buildMaterials();
    this._buildModel();
    this._buildTrail();
    this._buildSparks();
    this._buildLights();

    // `Engine` never parents its camera to the scene and the renderer only
    // traverses scene descendants, so a camera-attached viewmodel would be
    // culled. Adding the camera is inert for everything else.
    if (!this.camera.parent) this.scene.add(this.camera);
    this.camera.add(this.root);
    this.setVisible(false);

    this._offs.push(this.bus.on('world:changing', () => {
      this._cancelSwing();
      this._clearSparks();
    }));
  }

  /* ================================================================ */
  /* Materials                                                         */
  /* ================================================================ */

  _buildMaterials() {
    const r = this.renderer;
    const blade = makeBladeMaps(r, 512, 6101);
    const fitting = makeMetalMaps(r, 256, 2207, {
      r: 0.34, g: 0.31, b: 0.27, roughness: 0.44, scratches: 18, repeat: 1,
    });
    const leather = makePolymerMaps(r, 256, 4409, { r: 0.19, g: 0.12, b: 0.09 });
    const cord = makePolymerMaps(r, 128, 771, { r: 0.31, g: 0.24, b: 0.16 });
    this._maps = { blade, fitting, leather, cord };

    /** Polished blade steel. Near-mirror, so it lives or dies on `envMapIntensity`. */
    this.matBlade = patchViewmodelDepth(new THREE.MeshStandardMaterial({
      name: 'sword.blade',
      color: new THREE.Color(0xd6dce6),
      map: blade.map,
      normalMap: blade.normalMap,
      roughnessMap: blade.roughnessMap,
      metalness: 1,
      roughness: 1,
      normalScale: new THREE.Vector2(0.22, 0.22),
      envMapIntensity: 1.9,
    }));

    /** Blackened iron furniture: guard, pommel, langets, ferrules. */
    this.matFitting = patchViewmodelDepth(new THREE.MeshStandardMaterial({
      name: 'sword.fitting',
      color: new THREE.Color(0x5c6068),
      map: fitting.map,
      normalMap: fitting.normalMap,
      roughnessMap: fitting.roughnessMap,
      metalness: 0.94,
      roughness: 1,
      normalScale: new THREE.Vector2(0.38, 0.38),
      envMapIntensity: 1.15,
    }));

    /** Grip core: oiled leather over wood. */
    this.matLeather = patchViewmodelDepth(new THREE.MeshStandardMaterial({
      name: 'sword.leather',
      color: new THREE.Color(0x54321f),
      map: leather.map,
      normalMap: leather.normalMap,
      roughnessMap: leather.roughnessMap,
      metalness: 0.02,
      roughness: 1,
      normalScale: new THREE.Vector2(0.55, 0.55),
    }));

    /** Risers: the twisted wire winding over the leather. */
    this.matCord = patchViewmodelDepth(new THREE.MeshStandardMaterial({
      name: 'sword.cord',
      color: new THREE.Color(0x9a8258),
      map: cord.map,
      normalMap: cord.normalMap,
      roughnessMap: cord.roughnessMap,
      metalness: 0.65,
      roughness: 1,
      normalScale: new THREE.Vector2(0.6, 0.6),
    }));

    /**
     * Aether inlay in the fuller and the pommel cap. Low emissive on purpose:
     * it should catch the eye as the blade turns, not act as a light source.
     */
    this.matInlay = patchViewmodelDepth(new THREE.MeshStandardMaterial({
      name: 'sword.inlay',
      color: new THREE.Color(0x2f6f9c),
      metalness: 0.7,
      roughness: 0.28,
      emissive: new THREE.Color(0.06, 0.3, 0.5),
      emissiveIntensity: 0.9,
      envMapIntensity: 1.3,
    }));

    this.matGlove = patchViewmodelDepth(new THREE.MeshStandardMaterial({
      name: 'sword.glove',
      color: new THREE.Color(0x7d6a5a),
      map: leather.map,
      normalMap: leather.normalMap,
      roughnessMap: leather.roughnessMap,
      metalness: 0.03,
      roughness: 1,
      normalScale: new THREE.Vector2(0.35, 0.35),
    }));

    for (const m of [
      this.matBlade, this.matFitting, this.matLeather,
      this.matCord, this.matInlay, this.matGlove,
    ]) this._disposables.push(m);
    for (const set of [blade, fitting, leather, cord]) {
      this._disposables.push(set.map, set.normalMap, set.roughnessMap);
    }

    this.materials?.register?.('sword.blade', this.matBlade);
    this.materials?.register?.('sword.fitting', this.matFitting);
  }

  /* ================================================================ */
  /* Model                                                             */
  /* ================================================================ */

  _buildModel() {
    /** Attached to the camera; carries the guard/swing/sprint pose. */
    this.root = new THREE.Group();
    this.root.name = 'viewmodel:sword';

    /** Child of root; carries the model scale, sway, bob and swing. */
    this._model = new THREE.Group();
    this._model.name = 'viewmodel:sword:model';
    this._model.scale.setScalar(SWORD_SCALE);
    this.root.add(this._model);

    const fitting = [];
    const leather = [];
    const cord = [];
    const inlay = [];
    const glove = [];

    this._buildBlade(inlay);
    this._buildGuard(fitting, inlay);
    this._buildGrip(leather, cord, fitting);
    this._buildPommel(fitting, inlay);
    this._buildHand(glove, fitting);

    const addMerged = (bucket, material, name) => {
      const geo = mergeBucket(bucket);
      if (!geo) return null;
      const mesh = new THREE.Mesh(geo, material);
      mesh.name = `viewmodel:sword:${name}`;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 100;
      this._model.add(mesh);
      this._disposables.push(geo);
      return mesh;
    };

    addMerged(fitting, this.matFitting, 'fitting');
    addMerged(leather, this.matLeather, 'grip');
    addMerged(cord, this.matCord, 'wire');
    addMerged(inlay, this.matInlay, 'inlay');
    addMerged(glove, this.matGlove, 'hand');
  }

  /** The lofted blade, plus the etched inlay sitting in the fuller. */
  _buildBlade(inlay) {
    const geo = makeBladeGeometry({
      halfWidth: BLADE_HALF_W,
      halfThick: BLADE_HALF_T,
      z0: BLADE_Z0,
      z1: BLADE_Z1,
    });
    const mesh = new THREE.Mesh(geo, this.matBlade);
    mesh.name = 'viewmodel:sword:blade';
    mesh.castShadow = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 100;
    this._model.add(mesh);
    this._blade = mesh;
    this._disposables.push(geo);

    // Runic inlay laid *into* the fuller on both flats. Short dashes rather than
    // a continuous line: a solid stripe reads as a decal, dashes read as
    // chiselled cells catching the light one at a time as the blade turns.
    const y = BLADE_HALF_T * 0.55;
    for (let i = 0; i < 7; i++) {
      const u = 0.08 + i * 0.062;
      const z = BLADE_Z0 + (BLADE_Z1 - BLADE_Z0) * u;
      const w = BLADE_HALF_W * (1 - 0.36 * u) * 0.34;
      const len = 0.026 - i * 0.001;
      for (const sy of [1, -1]) {
        place(inlay, chamfer(w * 2, 0.0016, len, 0.0006), 0, sy * y, z);
      }
    }
  }

  /**
   * Crossguard. The quillons are a tapered bar in the plane of the blade's
   * flats - the same axis as the blade's width - with a raised écusson where
   * they meet the ricasso and langets running a little way up the blade.
   */
  _buildGuard(fitting, inlay) {
    // Central block, thicker than the quillons so the guard has a waist.
    place(fitting, chamfer(0.052, 0.038, 0.05, 0.008, 2), 0, 0, GUARD_Z);

    // Quillons: three segments a side, each shorter and thinner, so they taper
    // and sweep very slightly forward toward the blade.
    for (const sx of [1, -1]) {
      place(fitting, chamfer(0.05, 0.03, 0.038, 0.008, 2), sx * 0.048, 0, GUARD_Z - 0.002);
      place(fitting, chamfer(0.044, 0.025, 0.033, 0.007, 2), sx * 0.09, 0, GUARD_Z - 0.006, 0, sx * 0.09);
      // Rounded terminal.
      const cap = new THREE.SphereGeometry(0.014, 12, 8);
      place(fitting, cap, sx * 0.114, 0, GUARD_Z - 0.009);
      // Langet: a tongue of metal gripping the ricasso.
      place(fitting, chamfer(0.012, 0.02, 0.05, 0.004), sx * 0.019, 0, GUARD_Z - 0.038);
    }

    // Écusson: the little inlaid boss on the face of the guard.
    for (const sy of [1, -1]) {
      const ring = ringZ(0.011, 0.0035, 6, 16);
      ring.rotateX(Math.PI / 2);
      place(fitting, ring, 0, sy * 0.019, GUARD_Z);
      place(inlay, new THREE.SphereGeometry(0.008, 12, 8), 0, sy * 0.019, GUARD_Z);
    }
  }

  /**
   * Grip: a leather-covered core with a swell in the middle, bound with a
   * twisted wire winding and finished with two ferrules.
   */
  _buildGrip(leather, cord, fitting) {
    const z0 = GUARD_Z + 0.024;
    const z1 = 0.115;
    const len = z1 - z0;

    // Core, waisted: three stacked tapers rather than one cylinder, so the hand
    // has something to register against.
    place(leather, tubeZ(0.0165, 0.0182, len * 0.36, 14), 0, 0, z0 + len * 0.18);
    place(leather, tubeZ(0.0182, 0.0176, len * 0.34, 14), 0, 0, z0 + len * 0.53);
    place(leather, tubeZ(0.0176, 0.0158, len * 0.34, 14), 0, 0, z0 + len * 0.83);

    // Ferrules at both ends of the winding.
    place(fitting, tubeZ(0.019, 0.019, 0.009, 16), 0, 0, z0 + 0.004);
    place(fitting, tubeZ(0.0175, 0.0175, 0.008, 16), 0, 0, z1 - 0.006);

    // Twisted wire winding: a torus per turn, canted so the turns read as a
    // helix instead of a stack of hoops.
    const turns = 15;
    for (let i = 0; i < turns; i++) {
      const t = (i + 0.5) / turns;
      const z = z0 + 0.012 + t * (len - 0.026);
      const rad = 0.0168 + Math.sin(t * Math.PI) * 0.0016;
      const ring = ringZ(rad, 0.0021, 5, 16);
      place(cord, ring, 0, 0, z, 0.13, 0.05, 0);
    }
  }

  /** Scent-stopper pommel with a peened tang button and an inlaid cap. */
  _buildPommel(fitting, inlay) {
    const z = 0.132;
    place(fitting, new THREE.SphereGeometry(0.026, 16, 12), 0, 0, z);
    place(fitting, tubeZ(0.0225, 0.019, 0.014, 16), 0, 0, z - 0.021);
    place(fitting, tubeZ(0.014, 0.019, 0.012, 16), 0, 0, z + 0.024);
    // Peened tang button - the detail that says this is assembled, not moulded.
    place(fitting, tubeZ(0.0075, 0.009, 0.008, 12), 0, 0, z + 0.033);
    for (const sy of [1, -1]) {
      place(inlay, new THREE.SphereGeometry(0.0085, 12, 8), 0, sy * 0.0235, z);
    }
  }

  /**
   * A gloved fist closed around the grip. Loose primitives rather than a skinned
   * mesh: at viewmodel scale the silhouette is what sells it, and a badly
   * deformed realistic hand looks far worse than a stylised gauntlet.
   */
  _buildHand(glove, plate) {
    const zc = 0.055; // hand centres on the upper third of the grip

    // Palm wrapping the grip, plus back-of-hand armour.
    place(glove, chamfer(0.05, 0.058, 0.082, 0.018, 2), -0.004, 0.004, zc);
    place(plate, chamfer(0.03, 0.016, 0.062, 0.006, 2), 0, 0.032, zc);

    // Four fingers curling round the front of the grip.
    for (let i = 0; i < 4; i++) {
      const z = zc - 0.03 + i * 0.021;
      const rad = 0.0102 - i * 0.0009;
      const a = new THREE.CylinderGeometry(rad, rad * 0.95, 0.05, 8).rotateZ(Math.PI / 2);
      place(glove, a, 0.004, -0.019, z);
      const b = new THREE.CylinderGeometry(rad * 0.92, rad * 0.84, 0.03, 8).rotateZ(Math.PI / 2);
      place(glove, b, -0.023, -0.012, z, 0, 0, 0.7);
      place(plate, chamfer(0.013, 0.013, 0.014, 0.005), 0.026, -0.008, z);
    }

    // Thumb laid along the grip toward the guard.
    const thumb = new THREE.CylinderGeometry(0.0108, 0.0096, 0.052, 8).rotateX(Math.PI / 2);
    place(glove, thumb, -0.012, 0.014, zc - 0.036, 0, 0.3, 0);

    // Cuff and forearm. The elbow belongs *below* the eye line, so the arm runs
    // down and back out of the bottom of the frame - raking it up toward the
    // shoulder parks its end cap in the middle of the screen.
    const ARM = 1.94;
    place(glove, new THREE.CylinderGeometry(0.036, 0.033, 0.062, 14), 0, 0.006, zc + 0.062, ARM);
    place(plate, chamfer(0.05, 0.022, 0.054, 0.008, 2), 0, 0.03, zc + 0.058, ARM);
    place(glove, new THREE.CylinderGeometry(0.034, 0.04, 0.3, 14), 0, -0.04, zc + 0.2, ARM);
  }

  /* ================================================================ */
  /* Edge trail                                                        */
  /* ================================================================ */

  /**
   * Ribbon along the swept edge.
   *
   * Built in the *root's* space rather than world space. The root is parented to
   * the camera, so a world-space ribbon would smear across the screen every time
   * the player turned - which is not what a sword trail is. In root space the
   * ribbon records only the blade's motion relative to the view, which is
   * exactly the arc the player is watching.
   *
   * ── The "big black triangle" ────────────────────────────────────────────────
   * Reported as opaque black wedges thrown off the blade mid-swing. The material
   * was never the cause: it is additive, and additive blending cannot darken
   * anything. The cause was the *ambient occlusion prepass*.
   *
   * `PostFX` runs a `GTAOPass`, and GTAO builds its own normal+depth G-buffer by
   * re-rendering the whole scene through `scene.overrideMaterial =
   * MeshNormalMaterial`. Its `_overrideVisibility()` only excludes points and
   * lines - every transparent *mesh* is drawn into that G-buffer at full
   * strength, blending and `depthWrite` ignored, because the override material
   * carries its own state. This ribbon is a screen-filling mesh 0.5 m from the
   * eye with no `normal` attribute, so it stamped a null normal over its whole
   * silhouette; GTAO integrated that to zero visibility and the blend pass
   * multiplied the frame by it. Hence a hard black shape in exactly the ribbon's
   * outline, moving with the swing.
   *
   * Two defences, because a G-buffer artefact is expensive to diagnose twice:
   *   1. `onBeforeRender` collapses the draw range to zero for any material that
   *      is not ours, so the ribbon never enters an override pass at all. A
   *      trail has no business in a G-buffer; the AO behind it should be the
   *      world's.
   *   2. The geometry carries a real `normal` attribute anyway. Root space is
   *      camera space, so a constant +Z faces the eye and is correct for every
   *      vertex - if defence 1 is ever bypassed the result is a benign
   *      unoccluded surface rather than a black hole.
   */
  _buildTrail() {
    const S = TRAIL_SAMPLES;
    this._trailPos = new Float32Array(S * 2 * 3);
    this._trailCol = new Float32Array(S * 2 * 3);
    this._trailUv = new Float32Array(S * 2 * 2);
    this._trailNrm = new Float32Array(S * 2 * 3);
    const idx = [];
    for (let i = 0; i < S - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    for (let i = 0; i < S; i++) {
      // v runs across the ribbon (edge -> trailing side) so the gradient texture
      // fades the inner edge out; u runs along it for completeness.
      this._trailUv[i * 4] = i / (S - 1);
      this._trailUv[i * 4 + 1] = 0.02;
      this._trailUv[i * 4 + 2] = i / (S - 1);
      this._trailUv[i * 4 + 3] = 0.98;
      // Root space is camera space: +Z is straight out of the screen.
      this._trailNrm[i * 6 + 2] = 1;
      this._trailNrm[i * 6 + 5] = 1;
    }

    const geo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(this._trailPos, 3);
    const colAttr = new THREE.BufferAttribute(this._trailCol, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    colAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', posAttr);
    geo.setAttribute('color', colAttr);
    geo.setAttribute('uv', new THREE.BufferAttribute(this._trailUv, 2));
    geo.setAttribute('normal', new THREE.BufferAttribute(this._trailNrm, 3));
    geo.setIndex(idx);
    // Nothing is drawn until a swing has written at least one real segment.
    geo.setDrawRange(0, 0);

    const tex = makeTrailTexture(this.renderer);
    this._trailMat = patchViewmodelDepth(new THREE.MeshBasicMaterial({
      name: 'sword.trail',
      map: tex,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      toneMapped: false,
      // A light streak is not in the fog; a fog mix would only ever grey it.
      fog: false,
      opacity: 0,
    }));

    this._trail = new THREE.Mesh(geo, this._trailMat);
    this._trail.name = 'viewmodel:sword:trail';
    this._trail.frustumCulled = false;
    this._trail.renderOrder = 120;
    this._trail.castShadow = false;
    this._trail.receiveShadow = false;
    this._trail.visible = false;

    /** Index count `_writeTrail` authorised; see the header for why this gate. */
    this._trailDraw = 0;
    this._trail.onBeforeRender = (renderer, scene, camera, geometry, material) => {
      geometry.setDrawRange(0, material === this._trailMat ? this._trailDraw : 0);
    };

    this.root.add(this._trail);

    this._trailGeo = geo;
    this._trailPosAttr = posAttr;
    this._trailColAttr = colAttr;
    /** Head of the ring buffer; samples are written newest-last on read. */
    this._trailHead = 0;
    this._trailFilled = 0;
    this._trailFade = 0;
    /** False until the ring has been stamped with a real blade position. */
    this._trailSeeded = false;
    this._trailTip = new Float32Array(S * 3);
    this._trailInner = new Float32Array(S * 3);
    this._disposables.push(geo, this._trailMat, tex);
  }

  /** Push the current edge position into the ring buffer. */
  _sampleTrail() {
    // The model matrix was written this frame but three only refreshes matrices
    // at render time, so compose it here rather than trusting matrixWorld.
    this._model.updateMatrix();
    _tr1.copy(TIP_LOCAL).applyMatrix4(this._model.matrix);
    _tr2.copy(TRAIL_INNER_LOCAL).applyMatrix4(this._model.matrix);

    // First sample after a reset: stamp *every* slot with the current edge. An
    // unwritten ribbon vertex sits at the root's origin - the player's own eye -
    // and any quad touching it is drawn from the blade back to the camera, which
    // is a triangle the size of the screen. Seeding costs 18 writes once per
    // swing and makes that state unreachable.
    if (!this._trailSeeded) {
      for (let i = 0; i < TRAIL_SAMPLES; i++) {
        this._trailTip[i * 3] = _tr1.x;
        this._trailTip[i * 3 + 1] = _tr1.y;
        this._trailTip[i * 3 + 2] = _tr1.z;
        this._trailInner[i * 3] = _tr2.x;
        this._trailInner[i * 3 + 1] = _tr2.y;
        this._trailInner[i * 3 + 2] = _tr2.z;
      }
      this._trailSeeded = true;
      this._trailHead = 0;
      this._trailFilled = 0;
    }

    const h = this._trailHead;
    this._trailTip[h * 3] = _tr1.x;
    this._trailTip[h * 3 + 1] = _tr1.y;
    this._trailTip[h * 3 + 2] = _tr1.z;
    this._trailInner[h * 3] = _tr2.x;
    this._trailInner[h * 3 + 1] = _tr2.y;
    this._trailInner[h * 3 + 2] = _tr2.z;
    this._trailHead = (h + 1) % TRAIL_SAMPLES;
    if (this._trailFilled < TRAIL_SAMPLES) this._trailFilled++;
  }

  /**
   * Rebuild the ribbon's vertex buffers from the ring buffer.
   *
   * Only the segments that hold two real samples are written, and the draw range
   * is set to exactly those - the tail of the buffer is never handed to the GPU,
   * filled or not.
   */
  _writeTrail() {
    const S = TRAIL_SAMPLES;
    const fade = this._trailFade;
    const filled = this._trailFilled;
    if (fade <= 0.002 || filled < 2) {
      this._trailDraw = 0;
      this._trailGeo.setDrawRange(0, 0);
      if (this._trail.visible) this._trail.visible = false;
      return;
    }
    this._trail.visible = true;
    this._trailMat.opacity = Math.min(1, fade);

    for (let i = 0; i < filled; i++) {
      // Oldest first.
      const src = (this._trailHead - filled + i + S * 2) % S;
      const k = i / (filled - 1); // 0 = oldest, 1 = newest

      const d = i * 6;
      this._trailPos[d] = this._trailTip[src * 3];
      this._trailPos[d + 1] = this._trailTip[src * 3 + 1];
      this._trailPos[d + 2] = this._trailTip[src * 3 + 2];
      this._trailPos[d + 3] = this._trailInner[src * 3];
      this._trailPos[d + 4] = this._trailInner[src * 3 + 1];
      this._trailPos[d + 5] = this._trailInner[src * 3 + 2];

      // Newest end is a hot white-blue; the tail cools and dies. A k^1.5 ramp
      // rather than k^2: squaring lit only the last few centimetres of arc, so
      // over a dark backdrop the streak read as a smudge behind the blade
      // instead of as a cut. Peak values run past 1 deliberately - the material
      // is `toneMapped: false`, so the excess is what the bloom pass blooms.
      const a = k * Math.sqrt(k) * fade;
      this._trailCol[d] = 1.0 * a;
      this._trailCol[d + 1] = 1.2 * a;
      this._trailCol[d + 2] = 1.5 * a;
      const b = a * 0.36;
      this._trailCol[d + 3] = 0.3 * b;
      this._trailCol[d + 4] = 0.6 * b;
      this._trailCol[d + 5] = 1.0 * b;
    }
    this._trailDraw = (filled - 1) * 6;
    this._trailGeo.setDrawRange(0, this._trailDraw);
    this._trailPosAttr.needsUpdate = true;
    this._trailColAttr.needsUpdate = true;
  }

  /**
   * Drop the ribbon entirely. Called on every path that ends a swing - a new
   * swing, a cancel, a weapon switch, a world change - so a ribbon can never
   * stretch from the end of one swing to the start of the next, and a holstered
   * sword can never bring a stale arc back with it.
   */
  _resetTrail() {
    // `CameraRig` calls `setVisible(false)` on every third-person frame, so this
    // is on a hot path. Nothing to clear is the common case.
    if (this._trailFilled === 0 && this._trailFade === 0
      && this._trailDraw === 0 && !this._trailSeeded) return;
    this._trailFilled = 0;
    this._trailHead = 0;
    this._trailFade = 0;
    this._trailSeeded = false;
    this._trailDraw = 0;
    this._trailGeo?.setDrawRange(0, 0);
    this._trail.visible = false;
  }

  /* ================================================================ */
  /* Impact sparks                                                     */
  /* ================================================================ */

  /**
   * Pooled world-space sparks. One `Points` draw call, one allocation at
   * construction, and dead particles are simply coloured black - under additive
   * blending that is invisible and costs less than editing the draw range.
   */
  _buildSparks() {
    const N = SPARK_COUNT;
    this._sparkPos = new Float32Array(N * 3);
    this._sparkCol = new Float32Array(N * 3);
    this._sparkVel = new Float32Array(N * 3);
    this._sparkLife = new Float32Array(N);
    this._sparkMax = new Float32Array(N);
    this._sparkNext = 0;
    this._sparkActive = 0;

    const geo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(this._sparkPos, 3);
    const colAttr = new THREE.BufferAttribute(this._sparkCol, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    colAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', posAttr);
    geo.setAttribute('color', colAttr);

    const tex = makeSparkTexture(this.renderer);
    const mat = new THREE.PointsMaterial({
      name: 'sword.sparks',
      map: tex,
      size: 0.075,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });

    this._sparks = new THREE.Points(geo, mat);
    this._sparks.name = 'sword:sparks';
    this._sparks.frustumCulled = false;
    this._sparks.renderOrder = 6;
    this.scene.add(this._sparks);

    this._sparkGeo = geo;
    this._sparkPosAttr = posAttr;
    this._sparkColAttr = colAttr;
    this._disposables.push(geo, mat, tex);
  }

  /**
   * Throw a burst of sparks from an impact.
   * @param {THREE.Vector3} point world-space contact point
   * @param {THREE.Vector3} normal surface normal (or the reverse of the blow)
   * @param {number} count particles
   * @param {number} hot 0..1 - 1 is steel-on-steel white, 0 is a dull red
   */
  _burstSparks(point, normal, count, hot) {
    const N = SPARK_COUNT;
    for (let n = 0; n < count; n++) {
      const i = this._sparkNext;
      this._sparkNext = (this._sparkNext + 1) % N;
      const i3 = i * 3;

      this._sparkPos[i3] = point.x;
      this._sparkPos[i3 + 1] = point.y;
      this._sparkPos[i3 + 2] = point.z;

      // Cone about the normal, widened so the spray fans rather than jetting.
      _im1.set(
        normal.x + (Math.random() - 0.5) * 1.5,
        normal.y + (Math.random() - 0.5) * 1.5,
        normal.z + (Math.random() - 0.5) * 1.5
      ).normalize();
      const speed = 2.2 + Math.random() * 4.6;
      this._sparkVel[i3] = _im1.x * speed;
      this._sparkVel[i3 + 1] = _im1.y * speed + 1.1;
      this._sparkVel[i3 + 2] = _im1.z * speed;

      const life = 0.22 + Math.random() * 0.34;
      this._sparkLife[i] = life;
      this._sparkMax[i] = life;

      const b = 0.6 + Math.random() * 0.9;
      this._sparkCol[i3] = b * (0.9 + hot * 0.6);
      this._sparkCol[i3 + 1] = b * (0.45 + hot * 0.45);
      this._sparkCol[i3 + 2] = b * (0.12 + hot * 0.42);
    }
    this._sparkActive = Math.min(N, this._sparkActive + count);
    this._sparkPosAttr.needsUpdate = true;
    this._sparkColAttr.needsUpdate = true;
  }

  _updateSparks(dt) {
    if (this._sparkActive <= 0) return;
    const N = SPARK_COUNT;
    let live = 0;
    for (let i = 0; i < N; i++) {
      if (this._sparkLife[i] <= 0) continue;
      this._sparkLife[i] -= dt;
      const i3 = i * 3;
      if (this._sparkLife[i] <= 0) {
        this._sparkCol[i3] = 0;
        this._sparkCol[i3 + 1] = 0;
        this._sparkCol[i3 + 2] = 0;
        continue;
      }
      // Ballistic with heavy air drag: a spark is a tiny hot fleck, so it sheds
      // speed fast and then falls almost straight down.
      const drag = 1 - Math.min(0.9, 5.2 * dt);
      this._sparkVel[i3] *= drag;
      this._sparkVel[i3 + 1] = this._sparkVel[i3 + 1] * drag - 14 * dt;
      this._sparkVel[i3 + 2] *= drag;
      this._sparkPos[i3] += this._sparkVel[i3] * dt;
      this._sparkPos[i3 + 1] += this._sparkVel[i3 + 1] * dt;
      this._sparkPos[i3 + 2] += this._sparkVel[i3 + 2] * dt;

      const k = this._sparkLife[i] / this._sparkMax[i];
      // Cooling ramp: white -> amber -> red as the fleck loses heat.
      const f = k * k;
      this._sparkCol[i3] = 1.6 * f;
      this._sparkCol[i3 + 1] = 0.85 * f * k;
      this._sparkCol[i3 + 2] = 0.35 * f * k * k;
      live++;
    }
    this._sparkActive = live;
    this._sparkPosAttr.needsUpdate = true;
    this._sparkColAttr.needsUpdate = true;
  }

  _clearSparks() {
    this._sparkLife.fill(0);
    this._sparkCol.fill(0);
    this._sparkActive = 0;
    this._sparkColAttr.needsUpdate = true;
  }

  /* ================================================================ */
  /* Lights                                                            */
  /* ================================================================ */

  /**
   * Two very short-range fill lights (decay 2, ~1.5 m) so a near-mirror blade
   * still reads in a dark interior. Added once, in the constructor, and only
   * ever dimmed - see this file's header for why the light *count* must not
   * change at runtime.
   */
  _buildLights() {
    this._lightRig = new THREE.Group();
    this._lightRig.name = 'viewmodel:sword:lights';
    const key = new THREE.PointLight(0xcfdcff, 1.15, 1.6, 2);
    key.position.set(0.4, 0.32, 0.1);
    const rim = new THREE.PointLight(0xffc08a, 0.6, 1.35, 2);
    rim.position.set(-0.36, -0.14, -0.55);
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
    if (!on) this._cancelSwing();
  }

  /**
   * Show or hide the whole viewmodel.
   *
   * `root.visible` is safe to toggle: the fill lights are parented to the
   * *camera*, not to `root`, precisely so that hiding the sword never hides a
   * light's ancestor and never changes the scene's light count. They are dimmed
   * to zero instead. Do not reparent them under `root`.
   */
  setVisible(on) {
    this.root.visible = on;
    // Holstering drops the ribbon outright, so it cannot reappear mid-fade the
    // next time the sword is drawn.
    if (!on) this._resetTrail();
    for (const l of this._rigLights) l.intensity = on ? l.userData.baseIntensity : 0;
  }

  /**
   * @param {number} dt frame seconds
   * @param {number} elapsed engine time
   */
  update(dt, elapsed) {
    this._time = elapsed;
    if (dt <= 0) return;
    // Idempotent per engine frame: Player and Loadout may both drive us.
    if (elapsed === this._lastUpdateAt) return;
    this._lastUpdateAt = elapsed;

    this._equipT = Math.max(0, this._equipT - dt * 3.4);
    this._aim = damp(this._aim, this._aimTarget, 12, dt);
    this._lowered = damp(this._lowered, this._swingT >= 0 ? 0 : this._loweredTarget, 9, dt);

    this._advanceSwing(dt, elapsed);
    this._integrateSprings(dt);
    this._updatePose(elapsed);

    // Trail sampling must follow the pose write: it reads the model matrix the
    // pose just produced.
    if (this._swingT >= 0) {
      this._sampleTrail();
      this._trailFade = Math.min(1, this._trailFade + dt * 12);
    } else if (this._trailFade > 0) {
      // Deliberately *not* sampling here. The blade is settling back to guard,
      // and feeding those frames into the ring dragged the ribbon off the arc
      // and back across the screen after every swing - a second, slower smear
      // on top of the one that was reported. Freeze the arc and let it die.
      this._trailFade = Math.max(0, this._trailFade - dt * 6.5);
    }
    this._writeTrail();
    this._updateSparks(dt);
  }

  _integrateSprings(dtRaw) {
    const dt = Math.min(dtRaw, 1 / 40);
    this._swayVel.x += (this._swayTarget.x - this._swayPos.x) * 100 * dt - this._swayVel.x * 15 * dt;
    this._swayVel.y += (this._swayTarget.y - this._swayPos.y) * 100 * dt - this._swayVel.y * 15 * dt;
    this._swayPos.x += this._swayVel.x * dt;
    this._swayPos.y += this._swayVel.y * dt;

    this._camKickVel.x += -this._camKick.x * 70 * dt - this._camKickVel.x * 12 * dt;
    this._camKickVel.y += -this._camKick.y * 70 * dt - this._camKickVel.y * 12 * dt;
    this._camKick.x += this._camKickVel.x * dt;
    this._camKick.y += this._camKickVel.y * dt;

    spring3(this._recoilPos, this._recoilPosVel, 160, 19, dt);
    spring3(this._recoilRot, this._recoilRotVel, 180, 18, dt);
  }

  /* ================================================================ */
  /* Pose                                                              */
  /* ================================================================ */

  _updatePose(elapsed) {
    const aim = this._aim;
    const low = this._lowered * (1 - aim);
    const swing = this._swingBlend();

    _po1.copy(REST_POS).lerp(GUARD_POS, aim);
    _po2.copy(REST_ROT).lerp(GUARD_ROT, aim);
    _po1.lerp(LOW_POS, low);
    _po2.lerp(LOW_ROT, low);
    // The swing overrides the stance entirely at its peak.
    _po1.lerp(SWING_POS, swing);
    _po2.lerp(SWING_ROT, swing);

    // Idle motion is suppressed while aiming or swinging.
    const anim = (1 - aim * 0.7) * (1 - swing);
    _po3.set(0, 0, 0);

    // Idle breathing: two out-of-phase sines so the loop never reads as a loop.
    // A sword is heavy, so the drift is slower and larger than the rifle's.
    const idle = (1 - this._bobWeight) * anim;
    _po3.x += Math.sin(elapsed * 0.71) * 0.005 * idle;
    _po3.y += (Math.sin(elapsed * 1.09) * 0.006 + Math.sin(elapsed * 2.2) * 0.0016) * idle;
    _po2.z += Math.sin(elapsed * 0.61) * 0.02 * idle;
    _po2.x += Math.sin(elapsed * 0.94) * 0.013 * idle;

    const bw = this._bobWeight * anim;
    if (bw > 0.001) {
      const p = this._bobPhase;
      _po3.x += Math.cos(p) * 0.02 * bw;
      _po3.y += Math.sin(p * 2) * 0.014 * bw;
      _po3.z += Math.sin(p * 2 + 1.1) * 0.007 * bw;
      _po2.z += Math.cos(p) * 0.07 * bw;
      _po2.x += Math.sin(p * 2) * 0.028 * bw;
    }

    // Mouse lag: a 1.2 kg object in one hand trails the view more than a rifle
    // braced against the shoulder does.
    _po3.x += this._swayPos.x * 0.115 * anim;
    _po3.y += this._swayPos.y * 0.09 * anim;
    _po2.y += this._swayPos.x * 1.1 * anim;
    _po2.x += this._swayPos.y * 0.8 * anim;
    _po2.z += this._swayPos.x * 0.6 * anim;

    if (swing > 0) this._applySwingPose(_po1, _po2, swing);

    _po3.add(this._recoilPos);
    _po2.x += this._recoilRot.x;
    _po2.y += this._recoilRot.y;
    _po2.z += this._recoilRot.z;

    // Draw-in: the sword sweeps up from below the frame after a switch.
    if (this._equipT > 0) {
      const e = this._equipT * this._equipT;
      _po3.y -= e * 0.4;
      _po3.x += e * 0.12;
      _po2.x -= e * 0.9;
      _po2.z += e * 0.6;
    }

    _po1.addScaledVector(_po3, SWORD_SCALE);
    this._model.position.copy(_po1);
    this._model.rotation.set(_po2.x, _po2.y, _po2.z, 'XYZ');

    // Viewmodel FOV compensation, as in Weapon.js: scaling only X and Y by
    // tan(cur)/tan(ref) reproduces the reference FOV while the camera keeps its own.
    const r = Math.tan(this.camera.fov * 0.5 * DEG) / Math.tan(this._referenceFov * 0.5 * DEG);
    this.root.scale.set(r, r, 1);
  }

  /**
   * How much of the swing pose is live, 0..1.
   *
   * Ramped in over the wind-up and out over the recovery so the swing can be
   * cancelled on any frame without a pop.
   */
  _swingBlend() {
    const t = this._swingT;
    if (t < 0) return 0;
    if (t < 0.18) return sstep(0, 0.18, t);
    if (t < 0.72) return 1;
    return 1 - sstep(0.72, 1, t);
  }

  /**
   * Add the arc itself on top of the blended base pose.
   *
   * `s` runs 0 (fully cocked) to 1 (follow-through complete) over the middle of
   * the timeline. Smoothstep gives the acceleration into the cut and the
   * deceleration out of it that make the blade feel like it has mass.
   */
  _applySwingPose(pos, rot, w) {
    const t = this._swingT;
    const u = clamp((t - 0.2) / 0.36, 0, 1);
    const s = u * u * (3 - 2 * u);
    const dir = this._swingDir;

    rot.y += dir * (COCK_YAW + (END_YAW - COCK_YAW) * s) * w;
    rot.x += (COCK_PITCH + (END_PITCH - COCK_PITCH) * s) * w;
    rot.z += dir * (COCK_ROLL + (END_ROLL - COCK_ROLL) * s) * w;

    // The hand travels with the blade: back and out on the wind-up, then across
    // and down through the cut. Without this the sword pivots on a fixed point
    // and reads as a windscreen wiper.
    pos.x += dir * (0.13 - 0.3 * s) * w * SWORD_SCALE;
    pos.y += (0.1 - 0.2 * s) * w * SWORD_SCALE;
    pos.z += (0.13 - 0.3 * s) * w * SWORD_SCALE;

    // Hit-stop reads as a jolt in the wrist, not just a pause.
    if (this._hitStop > 0) {
      const j = this._hitStop / 0.07;
      rot.z -= dir * j * 0.14;
      pos.z += j * 0.02;
    }
  }

  /* ================================================================ */
  /* Fire control                                                      */
  /* ================================================================ */

  /**
   * Start a swing, or queue one if the current swing is still in its committed
   * phase. Holding the button therefore chains attacks with alternating hands
   * rather than spamming the first frame of the animation.
   *
   * @param {number} elapsed engine time in seconds
   * @returns {boolean} true if a swing started this call
   */
  tryFire(elapsed) {
    this._time = elapsed;
    if (!this._enabled) return false;

    if (this._swingT >= 0) {
      // Late in the swing the input buffers into the next one.
      if (this._swingT > 0.55) this._queued = true;
      return false;
    }
    if (elapsed - this._lastSwingEnd < SPEC.cooldown) {
      this._queued = true;
      return false;
    }
    this._beginSwing();
    return true;
  }

  /** The sword is not a charged weapon; the release carries nothing. */
  releaseFire() {
    this._queued = false;
    return false;
  }

  /** No ammunition and nothing to reload. Present so the loadout can poll uniformly. */
  reload() {
    return false;
  }

  resupply() {
    this._cancelSwing();
  }

  _beginSwing() {
    this._swingT = 0;
    this._swingDir = -this._swingDir;
    this._hitCount = 0;
    this._worldProbed = false;
    this._hitStop = 0;
    this._queued = false;
    this._resetTrail();

    // A small wrist-led pull on the wind-up. The camera barely moves - a melee
    // weapon that shakes the view on every swing is exhausting.
    this._recoilPosVel.z -= 0.35;
    this._recoilRotVel.z += this._swingDir * 1.1;
    this._camKickVel.y += 0.09;

    this.bus.emit('weapon:swing', { id: 'sword', dir: this._swingDir });
    // Published for the HUD and telemetry. `hitscan:false` keeps Combat from
    // resolving it as a round - melee damage is applied by `_sweep`.
    this.camera.getWorldPosition(_sw1);
    this._aimDirection(_sw2);
    this.bus.emit('weapon:fired', {
      origin: _sw1.clone(),
      direction: _sw2.clone(),
      spread: 0,
      ammo: 0,
      weaponId: 'sword',
      hitscan: false,
    });
  }

  /**
   * Abandon the current swing and everything it owns.
   *
   * The trail reset belongs here rather than at each call site: every way a
   * swing can end without finishing - a weapon switch, `setEnabled(false)`, a
   * resupply, a world change - goes through this method, and a ribbon left
   * behind by any one of them would be drawn into the next swing.
   */
  _cancelSwing() {
    this._swingT = -1;
    this._queued = false;
    this._hitCount = 0;
    this._hitStop = 0;
    for (let i = 0; i < this._hitThisSwing.length; i++) this._hitThisSwing[i] = null;
    this._resetTrail();
  }

  /**
   * Advance the swing clock and run the sweep while inside the damage window.
   * @param {number} dt frame seconds
   * @param {number} elapsed engine time
   */
  _advanceSwing(dt, elapsed) {
    if (this._hitStop > 0) this._hitStop = Math.max(0, this._hitStop - dt);
    if (this._swingT < 0) {
      if (this._queued && elapsed - this._lastSwingEnd >= SPEC.cooldown) this._beginSwing();
      return;
    }

    const prev = this._swingT;
    // Hit-stop slows the swing's own clock rather than the game's. That is what
    // makes a connect feel like the blade met resistance.
    const rate = (this._hitStop > 0 ? 0.28 : 1) / Math.max(0.05, SPEC.swingTime);
    this._swingT = Math.min(1.0001, prev + dt * rate);

    if (this._swingT >= SPEC.strikeStart && prev <= SPEC.strikeEnd) {
      this._sweep(Math.max(prev, SPEC.strikeStart), Math.min(this._swingT, SPEC.strikeEnd));
    }

    if (this._swingT >= 1) {
      this._swingT = -1;
      this._lastSwingEnd = elapsed;
      for (let i = 0; i < this._hitThisSwing.length; i++) this._hitThisSwing[i] = null;
      this._hitCount = 0;
      // A queued input survives to the next tick, where the cooldown gate lets
      // it start the follow-up swing.
    }
  }

  /**
   * Blade bearing relative to the aim direction at timeline position `t`.
   * Positive is to the player's left, matching the model's +Y rotation.
   */
  _bearingAt(t) {
    const u = clamp((t - 0.2) / 0.36, 0, 1);
    const s = u * u * (3 - 2 * u);
    const half = SPEC.arc * 0.5 * DEG;
    return this._swingDir * (half - 2 * half * s);
  }

  /**
   * Cut everything in the angular band the edge crossed between `t0` and `t1`.
   *
   * @param {number} t0 timeline position at the previous tick
   * @param {number} t1 timeline position now
   */
  _sweep(t0, t1) {
    const player = this.player;
    const npcs = this.npcManager?.npcs;
    if (!player) return;

    const a0 = this._bearingAt(t0);
    const a1 = this._bearingAt(t1);
    // A margin either side covers the frame boundary and gives the arc a little
    // generosity, which players read as the weapon being responsive.
    const margin = 14 * DEG;
    const lo = Math.min(a0, a1) - margin;
    const hi = Math.max(a0, a1) + margin;

    // Horizontal aim basis. `right` is the player's right, so a target's bearing
    // is atan2(-right·d, forward·d): positive to the left, matching `_bearingAt`.
    this._aimDirection(_sw1);
    _sw1.y = 0;
    if (_sw1.lengthSq() < 1e-6) return;
    _sw1.normalize();
    _sw2.set(-_sw1.z, 0, _sw1.x); // right-hand perpendicular in XZ

    const feet = player.position;
    const range = SPEC.range;

    if (npcs) {
      for (let i = 0; i < npcs.length; i++) {
        const npc = npcs[i];
        if (!npc || npc.isDead) continue;
        if (this._alreadyHit(npc)) continue;

        _sw3.subVectors(npc.position, feet);
        const dy = _sw3.y;
        if (Math.abs(dy) > SPEC.verticalReach) continue;
        _sw3.y = 0;
        const flat = _sw3.length();
        const radius = npc.radius ?? 0.33;
        if (flat - radius > range) continue;

        if (flat > 0.35) {
          _sw3.multiplyScalar(1 / flat);
          const bearing = Math.atan2(-_sw2.dot(_sw3), _sw1.dot(_sw3));
          // A close target subtends a wide angle, so widen the band by the
          // target's own half-width - otherwise a body pressed against you can
          // sit "outside" a 100-degree arc.
          const subtend = Math.atan2(radius, Math.max(0.3, flat));
          if (bearing < lo - subtend || bearing > hi + subtend) continue;
        }
        // Inside 0.35 m the target is on top of the player: always connected.

        if (!this._hasLineOfSight(npc)) continue;
        this._cut(npc);
        if (this._hitCount >= MAX_SWING_HITS) break;
      }
    }

    // One world probe per swing, and only if nothing was cut *at any point* in
    // this swing - a blade that showers sparks off a wall it never touched
    // because a body was in the way reads as a bug.
    if (this._hitCount === 0 && !this._worldProbed
      && t1 >= (SPEC.strikeStart + SPEC.strikeEnd) * 0.5) {
      this._worldProbed = true;
      this._probeWorld(_sw1);
    }
  }

  _alreadyHit(npc) {
    for (let i = 0; i < this._hitCount; i++) {
      if (this._hitThisSwing[i] === npc) return true;
    }
    return false;
  }

  /**
   * Cheap occlusion test so a sword cannot cut through a wall. Cast from the
   * player's eye at the target's chest and stop short of the body.
   */
  _hasLineOfSight(npc) {
    const physics = this.physics;
    if (!physics?.raycast) return true;
    const player = this.player;
    _sw4.copy(player.position);
    _sw4.y += (player.height ?? CONFIG.player.height) * 0.72;

    _im1.copy(npc.position);
    _im1.y += (npc.height ?? 1.8) * 0.55;
    _im1.sub(_sw4);
    const dist = _im1.length();
    if (dist < 0.3) return true;
    _im1.multiplyScalar(1 / dist);
    const hit = physics.raycast(_sw4, _im1, dist - 0.28, COLLISION_LAYER.WORLD);
    return !hit;
  }

  /** Land a cut on one target: damage, sparks, hit-stop and feedback. */
  _cut(npc) {
    if (this._hitCount < MAX_SWING_HITS) {
      this._hitThisSwing[this._hitCount++] = npc;
    }

    const damage = SPEC.damage;
    // Contact point at chest height on the near side of the body, so the blood
    // and the sparks appear where the blade actually is.
    _im2.copy(npc.position);
    _im2.y += (npc.height ?? 1.8) * 0.58;
    _im3.subVectors(this.player.position, npc.position);
    _im3.y = 0;
    if (_im3.lengthSq() > 1e-6) _im3.normalize();
    else _im3.set(0, 0, 1);
    _im2.addScaledVector(_im3, (npc.radius ?? 0.33) * 0.85);

    let res = null;
    if (this.combat?.applyNPCDamage) {
      res = this.combat.applyNPCDamage(npc, damage, {
        isHeadshot: false,
        sourcePosition: _im2,
        weaponId: 'sword',
        byPlayer: true,
        // Damage is already in WEAPON_STATS units; do not rescale it again.
        statsApplied: true,
      });
    } else {
      // Combat should always be present, but a melee weapon that silently does
      // nothing is far worse than one that skips the VFX.
      try {
        npc.applyDamage?.(damage, false, this.player);
        this.bus.emit('npc:damaged', { npc, amount: damage, health: npc.health, isHeadshot: false, weaponId: 'sword' });
        if (npc.isDead) this.bus.emit('npc:killed', { npc, byPlayer: true, weaponId: 'sword' });
      } catch (err) {
        console.warn('[Sword] direct damage failed:', err);
      }
    }

    // `_im3` faces the player (that is where the spray should be seen from);
    // the blow itself travels the other way, and the exit splatter has to look
    // for a wall on *that* side or it paints the ground behind the swinger.
    _im4.copy(_im3).negate();
    this.combat?.bloodFX?.(_im2, _im3, _im4);
    this._burstSparks(_im2, _im3, 9, 0.25);

    this._hitStop = 0.07;
    this._recoilPosVel.z += 1.15;
    this._recoilRotVel.x += 1.9;
    this._recoilRotVel.z -= this._swingDir * 2.6;
    this._camKickVel.y += 0.55;
    this.bus.emit('camera:shake', { amount: 0.075, duration: 0.13 });
    this.bus.emit('combat:hitmarker', {
      isHeadshot: false,
      isKill: res?.killed === true || npc.isDead === true,
      damage,
      point: _im2.clone(),
    });
  }

  /** Ring the blade off whatever is in front of the player, if anything is. */
  _probeWorld(forward) {
    const physics = this.physics;
    if (!physics?.raycast) return;
    const player = this.player;
    _sw4.copy(player.position);
    _sw4.y += (player.height ?? CONFIG.player.height) * 0.62;
    const hit = physics.raycast(_sw4, forward, SPEC.range * 0.85, COLLISION_LAYER.WORLD);
    if (!hit) return;

    this._burstSparks(hit.point, hit.normal, 13, 1);
    this.combat?.impactFX?.(hit.point, hit.normal, hit.collider, 0.6, false);
    this._hitStop = 0.05;
    this._recoilPosVel.z += 0.9;
    this._recoilRotVel.x += 1.5;
    this.bus.emit('camera:shake', { amount: 0.05, duration: 0.1 });
  }

  /* ================================================================ */
  /* Shared weapon interface (CONTRACTS-V2 §3.2)                       */
  /* ================================================================ */

  get id() { return 'sword'; }
  get icon() { return 'sword'; }
  get accent() { return '#7fc8ff'; }
  /**
   * No ammunition at all. `ammoKind` is what the HUD should branch on to draw
   * a dash; the counters report 0 rather than `Infinity` so that anything doing
   * arithmetic on them (a fill ratio, a save file, JSON) stays well defined.
   */
  get ammoKind() { return 'none'; }

  get ammo() { return 0; }
  get reserve() { return 0; }
  get magazine() { return 0; }
  get isReloading() { return false; }
  get reloadProgress() { return 0; }
  get chargeLevel() { return 0; }
  /** Melee: there is no cone of fire. */
  get spread() { return 0; }
  /** Raising the sword to guard tightens the view a little, like the bow's draw. */
  get aimProgress() { return this._aim * 0.5; }
  /** 0..1 through the current swing, or 0 when idle. Exposed for the HUD. */
  get swingProgress() { return this._swingT < 0 ? 0 : this._swingT; }

  getRecoilOffset() { return this._camKick; }

  addRecoil() {
    this._recoilPosVel.z += 0.6;
    this._recoilRotVel.x += 1.2;
  }

  onSelect() {
    this._enabled = true;
    this._equipT = 1;
    this._lowered = 1;
    this._loweredTarget = 0;
    this._cancelSwing();
    this._resetTrail();
    this.setVisible(true);
    // Melee has no magazine; publish that so a stale ammo readout is replaced.
    this.bus.emit('weapon:ammo', { ammo: 0, reserve: 0, magazine: 0, id: 'sword' });
  }

  onDeselect() {
    this._cancelSwing();
    this._resetTrail();
    this._aim = 0;
    this._aimTarget = 0;
    this.setVisible(false);
  }

  /** Nothing persists: no ammunition, no charge, no cooldown worth saving. */
  serialize() { return {}; }

  deserialize() {}

  /** Late injection - `CombatSystem` is constructed after the loadout in main.js. */
  setCombat(combat) {
    this.combat = combat ?? this.combat;
  }

  dispose() {
    for (const off of this._offs) off();
    this._offs.length = 0;
    this.root.removeFromParent();
    this._lightRig?.removeFromParent();
    this._sparks?.removeFromParent();
    for (const d of this._disposables) d?.dispose?.();
    this._disposables.length = 0;
  }
}

export default SwordWeapon;
