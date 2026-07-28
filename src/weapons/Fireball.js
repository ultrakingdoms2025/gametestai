import * as THREE from 'three';
import {
  patchViewmodelDepth, makeMetalMaps, makePolymerMaps, makeCanvas, finishTexture,
  chamfer, place, mergeBucket, tubeZ, ringZ, spring3, sstep, fbm, DEG,
} from '../player/Weapon.js';
import { CONFIG } from '../core/Config.js';
import { COLLISION_LAYER } from '../physics/Physics.js';
import { anchorLight } from '../gfx/LightAnchor.js';

/**
 * The "Emberwright" pyromantic gauntlet.
 *
 * A charge weapon: hold fire and a caged plasma core spins up in the palm -
 * growing, brightening, dragging swirling energy inward and lighting the
 * gauntlet's rune channels - then release to launch it. Everything about the
 * charge is legible on the model itself, because a charge meter that only
 * exists in the HUD teaches the player to look away from the thing they are
 * aiming.
 *
 * Ammunition is a regenerating mana pool rather than magazines, metered on six
 * rune cells along the bracer. `reload()` is therefore a vent: it dumps the
 * charge and briefly boosts regeneration instead of swapping anything.
 *
 * Shares `Weapon.js`'s viewmodel depth patch, procedural material generators and
 * geometry helpers, so the gauntlet sits in the same near-depth slice as the
 * machine gun and can never clip through a wall.
 */

/* ------------------------------------------------------------------ */
/* Scratch - separate sets per concern, deliberately not shared.       */
/* ------------------------------------------------------------------ */
/* pose composition */
const _po1 = new THREE.Vector3();
const _po2 = new THREE.Vector3();
const _po3 = new THREE.Vector3();
/* firing / world-space queries */
const _fi1 = new THREE.Vector3();
const _fi2 = new THREE.Vector3();
const _fi3 = new THREE.Vector3();
const _fi4 = new THREE.Vector3();
/* swirl instancing */
const _sw1 = new THREE.Vector3();
const _swq = new THREE.Quaternion();
const _sws = new THREE.Vector3();
const _swm = new THREE.Matrix4();

const clamp = THREE.MathUtils.clamp;
const damp = THREE.MathUtils.damp;
const TAU = Math.PI * 2;

/** Tunables. Read from CONFIG when the orchestrator adds them, else these. */
const SPEC = Object.assign(
  {
    name: 'Emberwright',
    /** Mana pool and its regeneration, in units per second. */
    maxMana: 100,
    regen: 15,
    /** A vent pauses regeneration briefly, then over-regenerates. */
    ventTime: 1.15,
    ventRegen: 46,
    /** Seconds of held fire from minimum to maximum charge. */
    chargeTime: 1.15,
    /** Cost, damage, blast radius and muzzle velocity across the charge range. */
    costMin: 14,
    costMax: 34,
    damageMin: 44,
    damageMax: 118,
    aoeMin: 2.4,
    aoeMax: 5.2,
    speedMin: 34,
    speedMax: 54,
    /** Minimum time between launches, so a tap-spam cannot outrun the pool. */
    cooldown: 0.34,
  },
  CONFIG.weapon?.fireball ?? {}
);

/** Where the plasma core sits in model space; also the launch point. */
const CORE_POS = new THREE.Vector3(0, 0.086, -0.158);

/**
 * Uniform scale applied inside the pose rig, for the same reason the machine
 * gun has one (see `VM_SCALE` in Weapon.js) - but a different value.
 *
 * A gauntlet is a much shorter object than a carbine: its far end is the elbow,
 * only ~30 cm behind the wrist rather than 87 cm behind the muzzle. Held at the
 * rifle's 0.62 it reads as a doll's hand at the bottom of the frame; held at
 * 1.0 the elbow ends up within 10 cm of the eye and the forearm alone covers a
 * third of the screen. 0.78 is where the hand reads life-size and the elbow
 * still leaves the frame cleanly.
 */
const GAUNTLET_SCALE = 0.78;

/*
 * Poses, in the same convention as the machine gun: model units, -Z forward.
 *
 * The pitch is *positive*, which is the opposite of the machine gun's. The
 * gauntlet's far end is the elbow at +Z, and a positive rotation about X swings
 * +Z downward - so the forearm rakes down out of the bottom of the frame while
 * the hand and its core are carried up into it. A negative pitch (the machine
 * gun's convention, where the far end is the muzzle at -Z) does the reverse and
 * buries the core under the bottom edge.
 */
const HIP_POS = new THREE.Vector3(0.221, -0.181, -0.42);
const HIP_ROT = new THREE.Vector3(0.3, 0.42, 0.1);
const FOCUS_POS = new THREE.Vector3(0.128, -0.118, -0.39);
const FOCUS_ROT = new THREE.Vector3(0.24, 0.26, 0.03);
const LOW_POS = new THREE.Vector3(0.32, -0.44, -0.4);
const LOW_ROT = new THREE.Vector3(0.78, 0.7, -0.26);

const SWIRL_COUNT = 18;
const RUNE_CELLS = 6;

/* ------------------------------------------------------------------ */
/* Textures                                                            */
/* ------------------------------------------------------------------ */

/** Soft radial glow with a hot centre - the core's halo and the swirl motes. */
function makeGlowTexture(renderer) {
  const size = 128;
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'lighter';
  const h = size / 2;
  const g = ctx.createRadialGradient(h, h, 0, h, h, h);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.12, 'rgba(255,236,196,0.86)');
  g.addColorStop(0.36, 'rgba(255,150,52,0.32)');
  g.addColorStop(0.72, 'rgba(214,60,10,0.07)');
  g.addColorStop(1, 'rgba(160,20,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return finishTexture(new THREE.CanvasTexture(c), renderer, true, 1);
}

/**
 * Convecting plasma shell: a banded turbulence field. Wrapped on a sphere and
 * counter-rotated against the core, it reads as churning fire rather than as a
 * lit ball, which no amount of emissive alone achieves.
 */
function makePlasmaTexture(renderer) {
  const size = 256;
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      // Anisotropic: stretched around the equator so the bands read as flow.
      const n = fbm(u * 9, v * 3.4, 1301, 4);
      const m = fbm(u * 22 + n * 2.4, v * 9, 907, 3);
      const t = clamp(n * 0.62 + m * 0.55, 0, 1);
      const hot = Math.pow(t, 2.1);
      const i = (y * size + x) * 4;
      img.data[i] = Math.min(255, 90 + hot * 320);
      img.data[i + 1] = Math.min(255, 18 + hot * 210);
      img.data[i + 2] = Math.min(255, 4 + hot * 92);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return finishTexture(new THREE.CanvasTexture(c), renderer, true, 1);
}

/* ------------------------------------------------------------------ */

export class FireballWeapon {
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

    /**
     * The mount the player is riding, when it wants to own the fire origin.
     *
     * Casting from a dragon spawned the bolt at the rider's *hand*, roughly two
     * metres behind and above the skull, so it appeared out of nothing beside
     * the creature's neck. A mount that implements `getFireOrigin` claims the
     * spawn point instead; the hoverboard and car do not, because a rider on a
     * board really is throwing it by hand.
     *
     * Tracked over the bus rather than injected because Loadout - and every
     * weapon in it - is constructed before MountManager exists.
     * @type {{getFireOrigin?:Function, flashMaw?:Function}|null}
     */
    this._mount = null;
    this._mountOffs = [
      bus?.on('mount:mounted', (e) => {
        this._mount = typeof e?.mount?.getFireOrigin === 'function' ? e.mount : null;
      }),
      bus?.on('mount:dismounted', () => { this._mount = null; }),
    ].filter(Boolean);

    /* ---- resource + fire control ---- */
    this._mana = SPEC.maxMana;
    this._charge = 0;
    this._charging = false;
    this._lastShot = -999;
    this._lastCharging = false;
    this._lastChargeEmit = -1;
    this._venting = 0;
    this._enabled = true;
    this._dryT = 0;

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
    this._flashT = 0;
    this._glow = 0;

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
    this._buildCore();
    this._buildSwirl();
    this._buildRunes();
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

    // Dark arcane steel: a cool blue-grey so the orange core has something to
    // read against. Metal base colour is a specular tint, never a dark diffuse.
    const steel = makeMetalMaps(r, 512, 211, {
      r: 0.34, g: 0.37, b: 0.44, roughness: 0.46, scratches: 30, repeat: 1,
    });
    // Warm bronze for the cage and the rune channels' surround.
    const bronze = makeMetalMaps(r, 256, 613, {
      r: 0.62, g: 0.42, b: 0.19, roughness: 0.34, scratches: 12, repeat: 1, normalStrength: 1.8,
    });
    const leather = makePolymerMaps(r, 256, 77, { r: 0.20, g: 0.15, b: 0.12 });
    this._maps = { steel, bronze, leather };

    this.matPlate = patchViewmodelDepth(new THREE.MeshStandardMaterial({
      name: 'fireball.plate',
      color: new THREE.Color(0x7c8592),
      map: steel.map,
      normalMap: steel.normalMap,
      roughnessMap: steel.roughnessMap,
      metalness: 0.94,
      roughness: 1,
      normalScale: new THREE.Vector2(0.34, 0.34),
      envMapIntensity: 1.2,
    }));

    this.matBronze = patchViewmodelDepth(new THREE.MeshStandardMaterial({
      name: 'fireball.bronze',
      color: new THREE.Color(0xc08a3e),
      map: bronze.map,
      normalMap: bronze.normalMap,
      roughnessMap: bronze.roughnessMap,
      metalness: 0.9,
      roughness: 1,
      normalScale: new THREE.Vector2(0.4, 0.4),
      // Heated by the core: driven every frame from the charge level.
      emissive: new THREE.Color(0, 0, 0),
      emissiveIntensity: 1,
      envMapIntensity: 1.35,
    }));

    this.matLeather = patchViewmodelDepth(new THREE.MeshStandardMaterial({
      name: 'fireball.leather',
      color: new THREE.Color(0x59493c),
      map: leather.map,
      normalMap: leather.normalMap,
      roughnessMap: leather.roughnessMap,
      metalness: 0.03,
      roughness: 1,
      normalScale: new THREE.Vector2(0.5, 0.5),
    }));

    for (const m of [this.matPlate, this.matBronze, this.matLeather]) this._disposables.push(m);
    for (const set of [steel, bronze, leather]) {
      this._disposables.push(set.map, set.normalMap, set.roughnessMap);
    }

    this.materials?.register?.('fireball.plate', this.matPlate);
    this.materials?.register?.('fireball.bronze', this.matBronze);
  }

  /* ================================================================ */
  /* Model                                                             */
  /* ================================================================ */

  _buildModel() {
    this.root = new THREE.Group();
    this.root.name = 'viewmodel:fireball';

    this._model = new THREE.Group();
    this._model.name = 'viewmodel:fireball:model';
    this._model.scale.setScalar(GAUNTLET_SCALE);
    this.root.add(this._model);

    const plate = [];
    const bronze = [];
    const leather = [];

    this._buildBracer(plate, bronze, leather);
    this._buildHand(plate, bronze, leather);

    const addMerged = (bucket, material, name) => {
      const geo = mergeBucket(bucket);
      if (!geo) return null;
      this._disposables.push(geo);
      const mesh = new THREE.Mesh(geo, material);
      mesh.name = `viewmodel:fireball:${name}`;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 100;
      this._model.add(mesh);
      return mesh;
    };
    addMerged(plate, this.matPlate, 'plate');
    addMerged(bronze, this.matBronze, 'bronze');
    addMerged(leather, this.matLeather, 'leather');

    this._buildCage();
  }

  /** Forearm: layered lames over a leather sleeve, tapering to the wrist. */
  _buildBracer(plate, bronze, leather) {
    // Sleeve. Cone, not cylinder: an untapered forearm reads as a pipe.
    const sleeve = new THREE.CylinderGeometry(0.052, 0.062, 0.30, 16, 1, true);
    sleeve.rotateX(Math.PI / 2);
    place(leather, sleeve, 0, 0, 0.17);

    // Three overlapping lames, widely spaced. Four tight ones read as a ribbed
    // hose; leaving a clear band of leather between each plate is what makes
    // them read as armour over a sleeve.
    for (let i = 0; i < 3; i++) {
      const z = 0.06 + i * 0.095;
      const rad = 0.057 + i * 0.004;
      const lame = ringZ(rad, 0.013, 6, 20, Math.PI * 1.25);
      lame.rotateZ(Math.PI * 0.87);
      place(plate, lame, 0, 0, z);
      // Bronze rivet band on the leading edge of each lame.
      place(bronze, ringZ(rad + 0.005, 0.004, 5, 18, Math.PI * 1.1), 0, 0, z - 0.016, 0, 0, Math.PI * 0.95);
    }

    // Elbow cop.
    place(plate, chamfer(0.1, 0.085, 0.07, 0.02, 2), 0, 0.006, 0.288);
    place(bronze, chamfer(0.03, 0.03, 0.016, 0.006), 0, 0.05, 0.29);

    // Wrist cuff: the anchor everything on the hand hangs off.
    place(plate, ringZ(0.05, 0.0135, 8, 24), 0, 0, 0.012);
    place(bronze, ringZ(0.0555, 0.005, 6, 24), 0, 0, 0.012);

    // Rune channel: a recessed trough down the top of the forearm. The lit
    // cells that meter mana sit inside it (see `_buildRunes`).
    place(bronze, chamfer(0.028, 0.008, 0.235, 0.003), 0, 0.056, 0.16);
    place(plate, chamfer(0.036, 0.012, 0.245, 0.004), 0, 0.052, 0.16);

    // Two conduits carrying the channel around the wrist into the palm.
    for (const sx of [-1, 1]) {
      place(bronze, tubeZ(0.005, 0.005, 0.16, 8), sx * 0.036, 0.036, 0.09);
      place(bronze, tubeZ(0.0045, 0.0045, 0.075, 8), sx * 0.042, 0.014, -0.02, 0.35, 0, 0);
    }

    // Strap buckles on the underside.
    for (let i = 0; i < 2; i++) {
      place(bronze, chamfer(0.016, 0.012, 0.02, 0.004), 0.03, -0.05, 0.09 + i * 0.11, 0, 0, 0.5);
    }
  }

  /**
   * Hand: an armoured back plate, four fingers curled up into a cradle and a
   * thumb braced across the base of the core. Loose primitives rather than a
   * skinned mesh - at viewmodel scale the silhouette carries it, and a badly
   * deforming realistic hand looks far worse than a stylised gauntlet.
   */
  _buildHand(plate, bronze, leather) {
    // Back-of-hand plate, angled up so the palm faces forward-up at the core.
    place(plate, chamfer(0.082, 0.026, 0.1, 0.012, 2), 0, -0.012, -0.062, 0.22);
    place(bronze, chamfer(0.04, 0.01, 0.052, 0.005), 0, 0.006, -0.07, 0.22);
    // Palm: leather, and thicker than the back so the hand has volume.
    place(leather, chamfer(0.074, 0.03, 0.088, 0.014, 2), 0, -0.044, -0.058, 0.22);

    // Four fingers, each two segments, curling up and inward around the core.
    for (let i = 0; i < 4; i++) {
      const x = -0.03 + i * 0.02;
      const spread = (i - 1.5) * 0.16;
      const rad = 0.0105 - Math.abs(i - 1.5) * 0.0012;

      // Proximal phalanx: forward and up out of the knuckle.
      const p1 = new THREE.CylinderGeometry(rad, rad * 0.95, 0.052, 8);
      p1.rotateX(Math.PI / 2);
      place(leather, p1, x, -0.008, -0.128, -0.55, spread, 0);
      // Knuckle cap.
      place(plate, chamfer(0.017, 0.014, 0.016, 0.005), x, 0.006, -0.104, 0.1, spread, 0);

      // Distal phalanx: continues the curl so the fingertips point at the core.
      const p2 = new THREE.CylinderGeometry(rad * 0.9, rad * 0.8, 0.042, 8);
      p2.rotateX(Math.PI / 2);
      place(leather, p2, x + spread * 0.02, 0.026, -0.157, -1.35, spread, 0);
      place(bronze, chamfer(0.012, 0.009, 0.012, 0.004), x + spread * 0.024, 0.043, -0.171, -1.2, spread, 0);
    }

    // Thumb, crossing under the core from the inboard side.
    const th1 = new THREE.CylinderGeometry(0.0125, 0.0115, 0.05, 8);
    th1.rotateX(Math.PI / 2);
    place(leather, th1, -0.04, -0.038, -0.086, -0.35, 0.9, 0);
    const th2 = new THREE.CylinderGeometry(0.0112, 0.0098, 0.044, 8);
    th2.rotateX(Math.PI / 2);
    place(leather, th2, -0.058, -0.014, -0.116, -0.95, 0.75, 0);
    place(plate, chamfer(0.015, 0.013, 0.014, 0.005), -0.066, 0.004, -0.132, -0.9, 0.75, 0);
  }

  /**
   * Three containment claws rising from the knuckles around the core, on their
   * own pivot so they can iris inward as the charge builds.
   */
  _buildCage() {
    this._cage = new THREE.Group();
    this._cage.name = 'viewmodel:fireball:cage';
    this._cage.position.copy(CORE_POS);
    this._model.add(this._cage);

    const bucket = [];
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + 0.5;
      const arm = new THREE.Group();
      // Claw: a torus arc leaning over the core, tipped with a bronze finial.
      // Built in its own local frame so the set can iris together. Everything
      // goes through `place()` because `mergeGeometries` cannot reconcile an
      // indexed torus with a non-indexed rounded box.
      bucket.length = 0;
      const arc = ringZ(0.062, 0.0055, 5, 16, Math.PI * 0.55);
      arc.rotateZ(Math.PI * 0.72);
      arc.rotateY(Math.PI / 2);
      place(bucket, arc, 0, 0, 0);
      place(bucket, chamfer(0.011, 0.011, 0.024, 0.004), 0, 0.058, -0.026, 0.5);
      const geo = mergeBucket(bucket);
      this._disposables.push(geo);
      const mesh = new THREE.Mesh(geo, this.matBronze);
      mesh.castShadow = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 100;
      arm.add(mesh);
      arm.rotation.z = a;
      arm.userData.baseAngle = a;
      this._cage.add(arm);
    }
    this._cageArms = this._cage.children;
  }

  /* ================================================================ */
  /* Core, swirl and runes                                             */
  /* ================================================================ */

  _buildCore() {
    const r = this.renderer;
    this._core = new THREE.Group();
    this._core.name = 'viewmodel:fireball:core';
    this._core.position.copy(CORE_POS);
    this._model.add(this._core);

    // Inner core: an unlit white-hot ball. Colour components above 1 so bloom
    // treats it as an actual light source rather than a bright material.
    this._coreMat = patchViewmodelDepth(new THREE.MeshBasicMaterial({
      color: new THREE.Color(4.2, 2.0, 0.7),
      toneMapped: false,
      fog: false,
    }));
    const coreGeo = new THREE.IcosahedronGeometry(0.05, 3);
    this._coreMesh = new THREE.Mesh(coreGeo, this._coreMat);
    this._coreMesh.renderOrder = 120;
    this._coreMesh.frustumCulled = false;
    this._core.add(this._coreMesh);

    // Plasma shell: back faces only, so the churning texture wraps *behind* the
    // core and the two read as one volume instead of two nested balls.
    const plasmaTex = makePlasmaTexture(r);
    this._shellMat = patchViewmodelDepth(new THREE.MeshBasicMaterial({
      map: plasmaTex,
      color: new THREE.Color(1.4, 0.6, 0.22),
      transparent: true,
      opacity: 0.75,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.BackSide,
      toneMapped: false,
      fog: false,
    }));
    const shellGeo = new THREE.SphereGeometry(0.078, 24, 16);
    this._shellMesh = new THREE.Mesh(shellGeo, this._shellMat);
    this._shellMesh.renderOrder = 121;
    this._shellMesh.frustumCulled = false;
    this._core.add(this._shellMesh);

    // Halo billboard: the bloom the core throws into the air around it.
    const glowTex = makeGlowTexture(r);
    this._haloMat = patchViewmodelDepth(new THREE.MeshBasicMaterial({
      map: glowTex,
      color: new THREE.Color(1.6, 0.62, 0.2),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      opacity: 0.9,
    }));
    const haloGeo = new THREE.PlaneGeometry(0.46, 0.46);
    this._halo = new THREE.Mesh(haloGeo, this._haloMat);
    this._halo.renderOrder = 122;
    this._halo.frustumCulled = false;
    this._core.add(this._halo);

    this._glowTex = glowTex;
    this._disposables.push(
      coreGeo, shellGeo, haloGeo, plasmaTex, glowTex,
      this._coreMat, this._shellMat, this._haloMat
    );
  }

  /**
   * Motes of energy spiralling inward into the core. One InstancedMesh with a
   * per-instance colour, so the whole effect is a single draw call and fading a
   * mote is a colour change rather than a material change.
   */
  _buildSwirl() {
    this._swirlMat = patchViewmodelDepth(new THREE.MeshBasicMaterial({
      map: this._glowTex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      opacity: 1,
    }));
    const geo = new THREE.PlaneGeometry(1, 1);
    this._swirl = new THREE.InstancedMesh(geo, this._swirlMat, SWIRL_COUNT);
    this._swirl.name = 'viewmodel:fireball:swirl';
    this._swirl.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._swirl.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(SWIRL_COUNT * 3), 3
    );
    this._swirl.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this._swirl.frustumCulled = false;
    this._swirl.renderOrder = 123;
    this._swirl.position.copy(CORE_POS);
    this._model.add(this._swirl);

    // Per-mote phase offsets, fixed at build time so the spiral never re-rolls.
    this._swirlPhase = new Float32Array(SWIRL_COUNT);
    this._swirlTilt = new Float32Array(SWIRL_COUNT);
    this._swirlRate = new Float32Array(SWIRL_COUNT);
    for (let i = 0; i < SWIRL_COUNT; i++) {
      this._swirlPhase[i] = (i / SWIRL_COUNT) * TAU + Math.random() * 0.6;
      this._swirlTilt[i] = (Math.random() - 0.5) * 1.3;
      this._swirlRate[i] = 0.55 + Math.random() * 0.7;
    }
    this._disposables.push(geo, this._swirlMat);
  }

  /** Six rune cells in the bracer channel that meter the mana pool. */
  _buildRunes() {
    this._runeMat = patchViewmodelDepth(new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      opacity: 1,
    }));
    const geo = new THREE.PlaneGeometry(0.02, 0.028);
    geo.rotateX(-Math.PI / 2);
    this._runes = new THREE.InstancedMesh(geo, this._runeMat, RUNE_CELLS);
    this._runes.name = 'viewmodel:fireball:runes';
    this._runes.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(RUNE_CELLS * 3), 3
    );
    this._runes.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this._runes.frustumCulled = false;
    this._runes.renderOrder = 110;
    this._model.add(this._runes);

    for (let i = 0; i < RUNE_CELLS; i++) {
      // March up the forearm from the wrist toward the elbow.
      _sw1.set(0, 0.0615, 0.055 + i * 0.037);
      _swq.identity();
      _sws.set(1, 1, 1);
      _swm.compose(_sw1, _swq, _sws);
      this._runes.setMatrixAt(i, _swm);
      this._runes.instanceColor.setXYZ(i, 0, 0, 0);
    }
    this._runes.instanceMatrix.needsUpdate = true;
    this._disposables.push(geo, this._runeMat);
  }

  _buildLights() {
    // Core light: lights the gauntlet and, at full charge, the wall in front of
    // the player. It tracks the hand via an anchor rather than being parented
    // to `_model`, because `setVisible(false)` hides `root` and a light under a
    // hidden ancestor stops being counted by the renderer - which changes
    // `numPointLights` and recompiles every program in the scene. See
    // gfx/LightAnchor.js.
    this._coreLight = new THREE.PointLight(0xff7a26, 0, 6, 2);
    this._coreLight.castShadow = false;

    // Viewmodel fill: two very short-range lights so the gauntlet stays legible
    // in a dark interior without noticeably lighting the world.
    this._lightRig = new THREE.Group();
    const key = new THREE.PointLight(0xbcd0ff, 1.0, 1.5, 2);
    key.position.set(0.42, 0.3, 0.12);
    const rim = new THREE.PointLight(0xffa070, 0.55, 1.3, 2);
    rim.position.set(-0.35, -0.12, -0.55);
    key.castShadow = false;
    rim.castShadow = false;
    key.userData.baseIntensity = key.intensity;
    rim.userData.baseIntensity = rim.intensity;
    this._rigLights = [key, rim];
    this._lightRig.add(key, rim);
    this.camera.add(this._lightRig);

    this._coreAnchored = anchorLight(this._coreLight, this._lightRig, this._model, CORE_POS);
  }

  /* ================================================================ */
  /* Driving                                                           */
  /* ================================================================ */

  /** @see Weapon#setViewContext - identical contract. */
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
    if (!on) this._cancelCharge();
  }

  setVisible(on) {
    this.root.visible = on;
    // Dim rather than hide: flipping a light's `visible` flag changes the
    // renderer's light count and recompiles every program in the scene.
    for (const l of this._rigLights) l.intensity = on ? l.userData.baseIntensity : 0;
    if (!on) this._coreLight.intensity = 0;
  }

  update(dt, elapsed) {
    this._time = elapsed;
    if (dt <= 0) return;
    if (elapsed === this._lastUpdateAt) return;
    this._lastUpdateAt = elapsed;

    this._equipT = Math.max(0, this._equipT - dt * 3.4);
    this._dryT = Math.max(0, this._dryT - dt * 7);
    this._flashT = Math.max(0, this._flashT - dt * 5.5);

    /* ---- mana ---- */
    if (this._venting > 0) {
      this._venting = Math.max(0, this._venting - dt);
      this._mana = Math.min(SPEC.maxMana, this._mana + SPEC.ventRegen * dt);
    } else if (!this._charging) {
      this._mana = Math.min(SPEC.maxMana, this._mana + SPEC.regen * dt);
    }

    /* ---- charge ---- */
    if (this._charging) {
      this._charge = Math.min(1, this._charge + dt / SPEC.chargeTime);
      // Holding a charge burns the pool slowly, so it cannot be parked forever.
      this._mana = Math.max(0, this._mana - dt * 3.5);
      if (this._mana < SPEC.costMin * 0.5) this._cancelCharge();
    } else {
      this._charge = damp(this._charge, 0, 16, dt);
      if (this._charge < 0.002) this._charge = 0;
    }
    this._emitCharge();

    // Glow trails the charge so the core keeps blooming for a beat after a
    // release rather than snapping dark. It never reaches zero: the core idles
    // as a pilot light, which is what tells the player the gauntlet is armed.
    this._glow = damp(this._glow, this._charging ? 0.2 + this._charge * 0.8 : 0.16, 9, dt);

    this._aim = damp(this._aim, this._aimTarget, 12, dt);
    this._lowered = damp(this._lowered, this._loweredTarget, 9, dt);

    this._integrateSprings(dt);
    this._updatePose(elapsed);
    this._updateCore(dt, elapsed);
    this._updateSwirl(elapsed);
    this._updateRunes();
  }

  _integrateSprings(dtRaw) {
    const dt = Math.min(dtRaw, 1 / 40);
    // Sway: spring2 from Weapon.js operates on {x,y} pairs.
    this._swayVel.x += (this._swayTarget.x - this._swayPos.x) * 105 * dt - this._swayVel.x * 15 * dt;
    this._swayVel.y += (this._swayTarget.y - this._swayPos.y) * 105 * dt - this._swayVel.y * 15 * dt;
    this._swayPos.x += this._swayVel.x * dt;
    this._swayPos.y += this._swayVel.y * dt;

    this._camKickVel.x += -this._camKick.x * 70 * dt - this._camKickVel.x * 12 * dt;
    this._camKickVel.y += -this._camKick.y * 70 * dt - this._camKickVel.y * 12 * dt;
    this._camKick.x += this._camKickVel.x * dt;
    this._camKick.y += this._camKickVel.y * dt;

    spring3(this._recoilPos, this._recoilPosVel, 150, 19, dt);
    spring3(this._recoilRot, this._recoilRotVel, 170, 18, dt);
  }

  _updatePose(elapsed) {
    const aim = this._aim;
    const low = this._lowered * (1 - aim);
    const c = this._charge;

    _po1.copy(HIP_POS).lerp(FOCUS_POS, aim);
    _po2.copy(HIP_ROT).lerp(FOCUS_ROT, aim);
    _po1.lerp(LOW_POS, low);
    _po2.lerp(LOW_ROT, low);

    const anim = 1 - aim * 0.7;
    _po3.set(0, 0, 0);

    // Idle: the hand breathes and the wrist rolls very slightly.
    const idle = (1 - this._bobWeight) * anim;
    _po3.x += Math.sin(elapsed * 0.85) * 0.004 * idle;
    _po3.y += (Math.sin(elapsed * 1.27) * 0.005 + Math.sin(elapsed * 2.6) * 0.0014) * idle;
    _po2.z += Math.sin(elapsed * 0.71) * 0.015 * idle;
    _po2.x += Math.sin(elapsed * 1.09) * 0.01 * idle;

    // Walk bob.
    const bw = this._bobWeight * anim;
    if (bw > 0.001) {
      const p = this._bobPhase;
      _po3.x += Math.cos(p) * 0.018 * bw;
      _po3.y += Math.sin(p * 2) * 0.013 * bw;
      _po3.z += Math.sin(p * 2 + 1.1) * 0.007 * bw;
      _po2.z += Math.cos(p) * 0.055 * bw;
      _po2.x += Math.sin(p * 2) * 0.026 * bw;
    }

    // Mouse lag.
    _po3.x += this._swayPos.x * 0.1 * anim;
    _po3.y += this._swayPos.y * 0.08 * anim;
    _po2.y += this._swayPos.x * 1.0 * anim;
    _po2.x += this._swayPos.y * 0.75 * anim;
    _po2.z += this._swayPos.x * 0.55 * anim;

    // Charging: the arm extends and the palm rotates up to present the core,
    // with a rising tremor as the containment strains.
    if (c > 0.001) {
      const e = sstep(0, 1, c);
      _po3.z -= e * 0.075;
      _po3.y += e * 0.055;
      _po3.x -= e * 0.03;
      _po2.x -= e * 0.34;
      _po2.y -= e * 0.13;
      const tremor = e * e * 0.006;
      _po3.x += Math.sin(elapsed * 41) * tremor;
      _po3.y += Math.sin(elapsed * 53.7) * tremor;
    }

    _po3.add(this._recoilPos);
    _po2.x += this._recoilRot.x;
    _po2.y += this._recoilRot.y;
    _po2.z += this._recoilRot.z;

    if (this._dryT > 0) {
      _po3.z += this._dryT * 0.005;
      _po2.z += this._dryT * 0.04;
    }
    if (this._equipT > 0) {
      const e = this._equipT * this._equipT;
      _po3.y -= e * 0.34;
      _po2.x -= e * 0.8;
      _po2.z += e * 0.5;
    }

    _po1.addScaledVector(_po3, GAUNTLET_SCALE);
    this._model.position.copy(_po1);
    this._model.rotation.set(_po2.x, _po2.y, _po2.z, 'XYZ');

    // Same FOV compensation as the machine gun: scale X/Y by the tangent ratio
    // so the viewmodel is composed at the reference FOV whatever the camera does.
    const r = Math.tan(this.camera.fov * 0.5 * DEG) / Math.tan(this._referenceFov * 0.5 * DEG);
    this.root.scale.set(r, r, 1);
  }

  _updateCore(dt, elapsed) {
    const c = this._charge;
    const g = this._glow;
    const flash = this._flashT * this._flashT;

    // Core grows from a pilot light to a fist-sized sun.
    const beat = 1 + Math.sin(elapsed * (9 + c * 26)) * (0.05 + c * 0.09);
    const scale = (0.46 + c * 0.7) * beat + flash * 0.9;
    this._coreMesh.scale.setScalar(scale);
    this._shellMesh.scale.setScalar(scale * (1.02 + Math.sin(elapsed * 6.3) * 0.04));
    this._coreMesh.rotation.y = elapsed * 1.4;
    this._coreMesh.rotation.x = elapsed * 0.9;
    // Counter-rotate the shell so the two surfaces shear against each other.
    this._shellMesh.rotation.y = -elapsed * (0.7 + c * 2.6);
    this._shellMesh.rotation.z = elapsed * 0.42;

    const bright = 0.28 + g * 1.5 + flash * 2.4;
    this._coreMat.color.setRGB(1.6 * bright, 0.72 * bright, 0.26 * bright);
    this._shellMat.opacity = 0.34 + g * 0.55;
    this._haloMat.opacity = 0.2 + g * 0.75 + flash * 0.6;
    const halo = 0.6 + g * 1.5 + flash * 1.6;
    this._halo.scale.set(halo, halo, 1);

    // Rune channels and the cage heat up with the core.
    const heat = g * g;
    this.matBronze.emissive.setRGB(heat * 1.6, heat * 0.55, heat * 0.1);
    this.matBronze.emissiveIntensity = 0.3 + heat * 2.4;

    this._coreLight.color.setRGB(1, 0.48 + g * 0.12, 0.16);
    this._coreLight.distance = 3 + g * 7;
    this._coreLight.intensity = (0.6 + g * 11 + flash * 22) * (this.root.visible ? 1 : 0);
    // Lives on the camera rig now, so walk it onto the palm while it is lit.
    this._coreAnchored?.sync();

    // Cage irises inward and spins up as the charge builds.
    for (let i = 0; i < this._cageArms.length; i++) {
      const arm = this._cageArms[i];
      arm.rotation.z = arm.userData.baseAngle + elapsed * (0.35 + c * 3.4);
      arm.rotation.x = -c * 0.42;
      const s = 1 - c * 0.16;
      arm.scale.set(s, s, s);
    }
  }

  _updateSwirl(elapsed) {
    const c = this._charge;
    const g = this._glow;
    if (g < 0.01) {
      if (this._swirl.visible) this._swirl.visible = false;
      return;
    }
    this._swirl.visible = true;

    for (let i = 0; i < SWIRL_COUNT; i++) {
      // Each mote runs a sawtooth from the outside in, so the stream reads as
      // energy being *drawn* into the core rather than orbiting it.
      const t = (elapsed * this._swirlRate[i] * (0.6 + c * 1.9) + this._swirlPhase[i]) % 1;
      const inward = 1 - t;
      const radius = 0.02 + inward * inward * (0.1 + c * 0.13);
      const a = this._swirlPhase[i] + t * 9.5;
      const tilt = this._swirlTilt[i];
      _sw1.set(
        Math.cos(a) * radius,
        Math.sin(a) * radius * Math.cos(tilt) + Math.sin(t * Math.PI) * 0.012,
        Math.sin(a) * radius * Math.sin(tilt)
      );
      // The model's local axes are near enough to camera axes at these poses
      // that facing +Z is an effective billboard, and it costs nothing.
      _swq.identity();
      const s = (0.03 + c * 0.045) * (0.4 + inward * 0.9);
      _sws.set(s, s, s);
      _swm.compose(_sw1, _swq, _sws);
      this._swirl.setMatrixAt(i, _swm);

      // Brighten and whiten as the mote is consumed.
      const b = g * (0.25 + t * 1.5);
      this._swirl.instanceColor.setXYZ(i, b * 1.9, b * (0.5 + t * 0.5), b * 0.22);
    }
    this._swirl.instanceMatrix.needsUpdate = true;
    this._swirl.instanceColor.needsUpdate = true;
  }

  _updateRunes() {
    const filled = (this._mana / SPEC.maxMana) * RUNE_CELLS;
    for (let i = 0; i < RUNE_CELLS; i++) {
      // Partial fill on the boundary cell, so the meter is continuous rather
      // than stepping six times across the whole pool.
      const k = clamp(filled - i, 0, 1);
      const b = 0.05 + k * (1.5 + this._glow * 1.4);
      this._runes.instanceColor.setXYZ(i, b * 1.5, b * 0.55, b * 0.14);
    }
    this._runes.instanceColor.needsUpdate = true;
  }

  /* ================================================================ */
  /* Fire control                                                      */
  /* ================================================================ */

  /**
   * Begin (or continue) charging. Returns true on the frame the charge starts,
   * which is what a caller polling `input.state.fire` needs to see.
   * @param {number} elapsed engine time in seconds
   */
  tryFire(elapsed) {
    this._time = elapsed;
    if (!this._enabled || this._charging) return false;
    if (elapsed - this._lastShot < SPEC.cooldown) return false;

    if (this._mana < SPEC.costMin) {
      if (elapsed - this._lastShot > 0.3) {
        this._dryT = 1;
        this._lastShot = elapsed - SPEC.cooldown + 0.3;
        this.bus.emit('weapon:dry', { reserve: 0, id: 'fireball' });
      }
      return false;
    }

    this._charging = true;
    this._venting = 0;
    this._charge = 0;
    return true;
  }

  /**
   * Release the charge and launch. A tap still fires - at minimum power - so
   * the weapon never feels unresponsive.
   * @returns {boolean} true if a projectile left the hand
   */
  releaseFire() {
    if (!this._charging) return false;
    this._charging = false;

    const charge = this._charge;
    const cost = SPEC.costMin + (SPEC.costMax - SPEC.costMin) * charge;
    if (this._mana < cost * 0.6) {
      this._cancelCharge();
      this._dryT = 1;
      return false;
    }

    this._mana = Math.max(0, this._mana - cost);
    this._lastShot = this._time;
    this._flashT = 1;
    this._charge = 0;
    this._emitCharge(true);

    const t = charge;
    const damage = SPEC.damageMin + (SPEC.damageMax - SPEC.damageMin) * t;
    const aoe = SPEC.aoeMin + (SPEC.aoeMax - SPEC.aoeMin) * t;
    const speed = SPEC.speedMin + (SPEC.speedMax - SPEC.speedMin) * t;

    this._launch(damage, aoe, speed, 0.7 + t * 0.7);
    this._addRecoil(0.35 + t * 0.9);
    this.bus.emit('camera:shake', { amount: 0.05 + t * 0.13, duration: 0.16 });
    this.bus.emit('weapon:ammo', {
      ammo: Math.round(this._mana), reserve: 0, magazine: SPEC.maxMana, id: 'fireball',
    });
    return true;
  }

  _launch(damage, aoe, speed, scale) {
    // Aim from the camera (the crosshair), but launch from the core so the
    // projectile is seen to leave the hand. In third person the rig supplies a
    // corrected direction; the default is simply the camera's forward axis.
    this._aimDirection(_fi1).normalize();
    this._model.updateWorldMatrix(true, false);
    const mount = this._mount;
    if (mount) {
      // Breathed, not thrown: the mount owns the spawn point.
      mount.getFireOrigin(_fi2);
      mount.flashMaw?.(1);
    } else {
      this._model.localToWorld(_fi2.copy(CORE_POS));
      this.camera.getWorldPosition(_fi3);

      // If the hand is inside or beyond a wall (backed into a corner), pull the
      // spawn point back to the surface so the fireball never starts on the far
      // side of it. Skipped when a mount owns the origin: the muzzle is out at
      // the end of a dragon's neck, and a wall test from the camera to there
      // would clip the bolt back into the player on every close-quarters shot.
      _fi4.subVectors(_fi2, _fi3);
      const reach = _fi4.length();
      if (reach > 1e-4) {
        _fi4.multiplyScalar(1 / reach);
        const hit = this.physics?.raycast?.(_fi3, _fi4, reach, COLLISION_LAYER.WORLD);
        if (hit) _fi2.copy(_fi3).addScaledVector(_fi4, Math.max(0.05, hit.distance - 0.12));
      }
    }

    this.projectiles?.spawn?.({
      kind: 'fireball',
      origin: _fi2,
      direction: _fi1,
      speed,
      damage,
      gravity: -2.4, // a touch of droop; a perfectly flat bolt reads as a laser
      radius: 0.26 * scale,
      aoe,
      scale,
      owner: this.player,
      life: 5,
    });
  }

  _cancelCharge() {
    this._charging = false;
    this._charge = 0;
    this._emitCharge(true);
  }

  _emitCharge(force = false) {
    const c = this._charging ? this._charge : 0;
    // Rate-limited to meaningful changes: this fires every frame otherwise.
    if (!force && Math.abs(c - this._lastChargeEmit) < 0.01) return;
    this._lastChargeEmit = c;
    this.bus.emit('weapon:charging', { id: 'fireball', charge01: c });
  }

  _addRecoil(power) {
    const rand = Math.random() - 0.5;
    this._camKickVel.y += 0.9 * power;
    this._camKickVel.x += rand * 0.5 * power;
    this._recoilPosVel.z += 1.5 * power;
    this._recoilPosVel.y += 0.5 * power;
    this._recoilRotVel.x += 4.2 * power;
    this._recoilRotVel.z += rand * 2.4 * power;
  }

  /** Vent the conduits: dumps any charge and force-feeds the pool. */
  reload() {
    if (this._venting > 0 || this._mana >= SPEC.maxMana) return false;
    this._cancelCharge();
    this._venting = SPEC.ventTime;
    this.bus.emit('weapon:reload-start', { duration: SPEC.ventTime, id: 'fireball' });
    return true;
  }

  /** Restore the pool - used on respawn. */
  resupply() {
    this._mana = SPEC.maxMana;
    this._venting = 0;
    this._cancelCharge();
  }

  /* ================================================================ */
  /* Shared weapon interface                                           */
  /* ================================================================ */

  get id() { return 'fireball'; }
  get icon() { return 'flame'; }
  get accent() { return '#ff7a26'; }
  get ammoKind() { return 'mana'; }

  /** Whole mana points, so the HUD can print an integer. */
  get ammo() { return Math.round(this._mana); }
  get reserve() { return 0; }
  get magazine() { return SPEC.maxMana; }
  get isReloading() { return this._venting > 0; }
  get reloadProgress() { return this._venting > 0 ? 1 - this._venting / SPEC.ventTime : 0; }
  get chargeLevel() { return this._charging ? this._charge : 0; }
  /** 0..1 pool level, for a HUD that wants to draw a bar rather than a number. */
  get manaRatio() { return this._mana / SPEC.maxMana; }
  get spread() { return 0; }

  /** Charging tightens the view slightly, the same way aiming does. */
  get aimProgress() { return Math.max(this._aim, this._charge * 0.42); }

  getRecoilOffset() { return this._camKick; }

  addRecoil() { this._addRecoil(1); }

  onSelect() {
    this._enabled = true;
    this._equipT = 1;
    this._lowered = 1;
    this._loweredTarget = 0;
    this.setVisible(true);
    this.bus.emit('weapon:ammo', {
      ammo: Math.round(this._mana), reserve: 0, magazine: SPEC.maxMana, id: 'fireball',
    });
  }

  onDeselect() {
    this._cancelCharge();
    this._aim = 0;
    this._aimTarget = 0;
    this._glow = 0;
    this.setVisible(false);
  }

  dispose() {
    for (const off of this._mountOffs) off?.();
    this._mountOffs.length = 0;
    this._mount = null;
    this.root.removeFromParent();
    this._lightRig?.removeFromParent();
    this.root.traverse((o) => {
      if (o.isInstancedMesh) o.dispose();
    });
    for (const d of this._disposables) d?.dispose?.();
    this._disposables.length = 0;
  }

  /** Serialisable state, for SaveGame. */
  serialize() {
    return { mana: this._mana };
  }

  deserialize(data) {
    if (!data) return;
    if (Number.isFinite(data.mana)) this._mana = clamp(data.mana, 0, SPEC.maxMana);
  }
}

export default FireballWeapon;
