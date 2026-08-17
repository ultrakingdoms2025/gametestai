import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeSurface, fbm01, clamp01, smoothstep } from '../gfx/Textures.js';
import { anchorLight } from '../gfx/LightAnchor.js';
import { applyLivery, MOUNT_STATS, normColor } from './Livery.js';

/**
 * The hoverboard mount.
 *
 * A hover vehicle is a suspension problem, not a movement problem: the board
 * samples the ground at its four corners, springs its ride height toward the
 * average, and derives pitch and roll from the difference between the corners.
 * That single decision is what makes it read as *following terrain* - it banks
 * over kerbs, noses up ramps and floats off crests without a single scripted
 * animation.
 *
 * Everything else is damping. Heading chases the look direction at a limited
 * rate, roll chases the turn rate, pitch chases the slope plus acceleration,
 * and the deck bobs on its own spring. Nothing snaps, which is the entire brief.
 *
 * Board space: +X right, +Y up, -Z forward (the house convention).
 */

/* ---- module scratch. Each block is private to one function - two aliasing */
/* bugs in this project came from sharing them, so they are never reused. ---- */
const _fu1 = new THREE.Vector3(); // fixedUpdate
const _fu2 = new THREE.Vector3();
const _fu3 = new THREE.Vector3();
const _sc1 = new THREE.Vector3(); // _resolveCollision
const _sc2 = new THREE.Vector3();
const _st1 = new THREE.Vector3(); // getSeat
const _pt1 = new THREE.Vector3(); // ParticlePool.update
const _pt2 = new THREE.Quaternion();
const _pt3 = new THREE.Vector3();
const _pm = new THREE.Matrix4();
/** Never mutated. Collapsing a dead particle must not clobber the billboard */
/** quaternion the live ones are still being written with. */
const _identityQuat = new THREE.Quaternion();
const _sl1 = new THREE.Vector3(); // SpeedLines.update
const _sl2 = new THREE.Quaternion();
const _sl3 = new THREE.Vector3();
const _slm = new THREE.Matrix4();
const _tr1 = new THREE.Vector3(); // _emitTrail
const _tr2 = new THREE.Vector3();

const damp = THREE.MathUtils.damp;
const clamp = THREE.MathUtils.clamp;

const HOVER_HEIGHT = 0.42;
const DECK_LENGTH = 1.66;
const DECK_WIDTH = 0.46;
const CRUISE_SPEED = 14;
const BOOST_SPEED = 24;
const REVERSE_SPEED = 4.5;
/** Capsule used to keep the board out of walls. Wider than the player so the */
/** deck itself cannot poke through geometry the rider clears. */
const RIDE_RADIUS = 0.52;
const RIDE_HEIGHT = 1.8;
const GRAVITY = -21;
/**
 * Binding footprints, in deck space.
 *
 * `BINDING_Z` is half the stance width - the two bindings sit fore and aft of
 * the deck centre, so the rider's feet end up ACROSS the board with the leading
 * foot toward the nose (-Z), which is the whole point of a board stance.
 * `BINDING_Y` is the top of the deck at that station: extrusion depth 0.05 plus
 * the 0.016 bevel plus the nose/tail kick, with a couple of millimetres of
 * boot sole on top.
 */
const BINDING_Z = 0.28;
const BINDING_Y = 0.078;

/* ================================================================== */
/* Shared mount VFX (also used by Dragon.js)                           */
/* ================================================================== */

/**
 * A pooled billboard particle system. One InstancedMesh, one additive draw
 * call, zero allocation after construction - `spawn` writes into a free slot
 * and `update` integrates every live slot in place.
 */
export class ParticlePool {
  /**
   * @param {THREE.Scene} scene
   * @param {number} count pool size
   * @param {{color?:number, size?:number, texture?:THREE.Texture}} [opts]
   */
  constructor(scene, count, opts = {}) {
    this.scene = scene;
    this.count = count;
    this._texture = opts.texture ?? makeSoftDiscTexture();
    this._ownsTexture = !opts.texture;
    this.material = new THREE.MeshBasicMaterial({
      map: this._texture,
      color: opts.color ?? 0xffffff,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, count);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.renderOrder = 6;

    this._pos = new Float32Array(count * 3);
    this._vel = new Float32Array(count * 3);
    this._life = new Float32Array(count);
    this._maxLife = new Float32Array(count);
    this._size = new Float32Array(count);
    this._tint = new Float32Array(count * 3);
    this._drag = opts.drag ?? 2.2;
    this._gravity = opts.gravity ?? 0;
    this._cursor = 0;
    this._live = 0;

    // Everything starts collapsed so an unused pool draws nothing visible.
    for (let i = 0; i < count; i++) this._writeMatrix(i, 0, 0, 0, 0, null);
    scene.add(this.mesh);
  }

  /**
   * Emit one particle. Silently recycles the oldest slot when the pool is full,
   * which is the right failure mode for cosmetic VFX.
   */
  spawn(px, py, pz, vx, vy, vz, life, size, r = 1, g = 1, b = 1) {
    const i = this._cursor;
    this._cursor = (this._cursor + 1) % this.count;
    const i3 = i * 3;
    this._pos[i3] = px; this._pos[i3 + 1] = py; this._pos[i3 + 2] = pz;
    this._vel[i3] = vx; this._vel[i3 + 1] = vy; this._vel[i3 + 2] = vz;
    this._tint[i3] = r; this._tint[i3 + 1] = g; this._tint[i3 + 2] = b;
    this._life[i] = life;
    this._maxLife[i] = life;
    this._size[i] = size;
    this._live++;
  }

  /** @param {number} dt @param {THREE.Camera} camera billboards face this */
  update(dt, camera) {
    if (this._live <= 0) return;
    camera.getWorldQuaternion(_pt2);
    const dragK = Math.exp(-this._drag * dt);
    let live = 0;

    for (let i = 0; i < this.count; i++) {
      const l = this._life[i];
      if (l <= 0) continue;
      const nl = l - dt;
      const i3 = i * 3;
      if (nl <= 0) {
        this._life[i] = 0;
        this._writeMatrix(i, 0, 0, 0, 0, null);
        continue;
      }
      this._life[i] = nl;
      live++;

      this._vel[i3] *= dragK;
      this._vel[i3 + 1] = this._vel[i3 + 1] * dragK + this._gravity * dt;
      this._vel[i3 + 2] *= dragK;
      this._pos[i3] += this._vel[i3] * dt;
      this._pos[i3 + 1] += this._vel[i3 + 1] * dt;
      this._pos[i3 + 2] += this._vel[i3 + 2] * dt;

      const t = nl / this._maxLife[i];
      // Grow as they die, fade on a curve that keeps the core hot for longer
      // than a linear ramp - additive sprites read as smoke otherwise.
      const scale = this._size[i] * (1.6 - t * 0.6);
      const fade = t * t * (3 - 2 * t);
      this._writeMatrix(i, this._pos[i3], this._pos[i3 + 1], this._pos[i3 + 2], scale, _pt2);
      const c = this.mesh.instanceColor.array;
      c[i3] = this._tint[i3] * fade;
      c[i3 + 1] = this._tint[i3 + 1] * fade;
      c[i3 + 2] = this._tint[i3 + 2] * fade;
    }

    this._live = live;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
  }

  _writeMatrix(i, x, y, z, scale, quat) {
    _pt1.set(x, y, z);
    _pt3.set(scale, scale, scale);
    _pm.compose(_pt1, quat ?? _identityQuat, _pt3);
    this.mesh.setMatrixAt(i, _pm);
    if (scale === 0) {
      const c = this.mesh.instanceColor.array;
      c[i * 3] = 0; c[i * 3 + 1] = 0; c[i * 3 + 2] = 0;
    }
  }

  clear() {
    for (let i = 0; i < this.count; i++) {
      this._life[i] = 0;
      this._writeMatrix(i, 0, 0, 0, 0, null);
    }
    this._live = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
  }

  setVisible(v) {
    this.mesh.visible = v;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
    if (this._ownsTexture) this._texture.dispose();
  }
}

/**
 * Radial speed streaks composited in view space.
 *
 * They are placed by pre-multiplying the camera's world matrix, so the quads
 * live in front of the lens without the camera ever needing to be part of the
 * scene graph, and each streak is rolled about the view axis so it points away
 * from screen centre - the classic rush cue, and far cheaper than a post pass.
 */
export class SpeedLines {
  constructor(scene, count = 56, color = 0xbfefff) {
    this.count = count;
    this._texture = makeStreakTexture();
    this.material = new THREE.MeshBasicMaterial({
      map: this._texture,
      color,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, count);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.renderOrder = 20;
    this.mesh.visible = false;
    scene.add(this.mesh);

    this._angle = new Float32Array(count);
    this._radius = new Float32Array(count);
    this._depth = new Float32Array(count);
    this._speed = new Float32Array(count);
    for (let i = 0; i < count; i++) this._reset(i, true);
    this.intensity = 0;
  }

  _reset(i, initial = false) {
    this._angle[i] = Math.random() * Math.PI * 2;
    this._radius[i] = initial ? 0.12 + Math.random() * 1.4 : 0.06 + Math.random() * 0.16;
    this._depth[i] = -1.1 - Math.random() * 2.4;
    this._speed[i] = 2.4 + Math.random() * 2.6;
  }

  /**
   * @param {number} dt
   * @param {THREE.Camera} camera
   * @param {number} intensity 0..1, drives count-on-screen and brightness
   */
  update(dt, camera, intensity) {
    this.intensity = damp(this.intensity, clamp01(intensity), 8, dt);
    if (this.intensity < 0.01) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    const colors = this.mesh.instanceColor.array;

    for (let i = 0; i < this.count; i++) {
      // Streaks accelerate as they leave the centre, which is what a real
      // radial blur does and what sells the speed.
      this._radius[i] += this._speed[i] * this._radius[i] * dt * (0.6 + this.intensity);
      if (this._radius[i] > 2.9) this._reset(i);

      const a = this._angle[i];
      const r = this._radius[i];
      const len = 0.1 + r * 0.24;
      _sl1.set(Math.cos(a) * r, Math.sin(a) * r, this._depth[i]);
      _sl2.setFromAxisAngle(FORWARD_AXIS, a);
      _sl3.set(len, 0.012 + r * 0.004, 1);
      _slm.compose(_sl1, _sl2, _sl3);
      _slm.premultiply(camera.matrixWorld);
      this.mesh.setMatrixAt(i, _slm);

      // Fade in from the centre and out at the rim so nothing pops.
      const edge = smoothstep(0.12, 0.55, r) * (1 - smoothstep(2.1, 2.9, r));
      const k = edge * this.intensity;
      colors[i * 3] = k;
      colors[i * 3 + 1] = k;
      colors[i * 3 + 2] = k;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this._texture.dispose();
  }
}

const FORWARD_AXIS = new THREE.Vector3(0, 0, 1);

/**
 * Wrap an RGBA buffer as a smoothly filtered sprite texture.
 *
 * The falloff is written into RGB *as well as* alpha. That is deliberate
 * belt-and-braces for additive sprites: the RGB copy means the quad fades to
 * black at its edges even if a downstream pass ever ignores or accumulates the
 * alpha channel, which is exactly the failure that turns a soft spark into a
 * visible grey rectangle in a composited HDR pipeline.
 */
function spriteTexture(data, w, h) {
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** Soft radial falloff used by every additive sprite in the mounts package. */
export function makeSoftDiscTexture(size = 64) {
  const data = new Uint8Array(size * size * 4);
  const c = (size - 1) * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c) / c;
      // Squared falloff with a hot core reads as a spark rather than a blob.
      const a = clamp01(1 - d);
      const v = a * a * (0.35 + 0.65 * a);
      const b = (v * 255) | 0;
      const i = (y * size + x) * 4;
      data[i] = b; data[i + 1] = b; data[i + 2] = b;
      data[i + 3] = b;
    }
  }
  return spriteTexture(data, size, size);
}

/** A horizontally tapered streak, brightest in the middle. */
function makeStreakTexture(w = 64, h = 8) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const fy = 1 - Math.abs((y + 0.5) / h - 0.5) * 2;
    for (let x = 0; x < w; x++) {
      const fx = Math.sin(((x + 0.5) / w) * Math.PI);
      const v = clamp01(fx * fx * fy * fy);
      const b = (v * 255) | 0;
      const i = (y * w + x) * 4;
      data[i] = b; data[i + 1] = b; data[i + 2] = b;
      data[i + 3] = b;
    }
  }
  return spriteTexture(data, w, h);
}

/** Radial gradient used for the ground glow and the spawn shockwave. */
export function makeGlowTexture(size = 128, power = 2.2, ring = 0) {
  const data = new Uint8Array(size * size * 4);
  const c = (size - 1) * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c) / c;
      let v = Math.pow(clamp01(1 - d), power);
      if (ring > 0) {
        // Annulus: a bright rim with a hollow middle, for shockwaves.
        v = clamp01(1 - Math.abs(d - ring) / (1 - ring + 0.001)) ** 3;
      }
      const b = (v * 255) | 0;
      const i = (y * size + x) * 4;
      data[i] = b; data[i + 1] = b; data[i + 2] = b;
      data[i + 3] = b;
    }
  }
  return spriteTexture(data, size, size);
}

/* ================================================================== */
/* Materials                                                           */
/* ================================================================== */

/**
 * Grip tape: coarse mineral grit over a matte rubber base.
 *
 * An earlier pass put tread chevrons in here. The deck's UVs come from the
 * extrusion's shape coordinates, so any low-frequency pattern is stretched
 * along the board and reads as long white streaks rather than a graphic - grit
 * is the only thing at this frequency that survives that mapping.
 */
function shadeGrip(u, v, out) {
  const grit = fbm01(u, v, 190, 190, 3, 17);
  const coarse = fbm01(u, v, 34, 34, 3, 91);
  const clump = fbm01(u, v, 9, 9, 2, 5);
  const base = 0.022 + grit * 0.055 + coarse * 0.016 + clump * 0.01;
  // Sharp specks: real grip tape is crushed mineral, so a few grains catch the
  // light much harder than the matrix around them.
  const speck = grit > 0.78 ? (grit - 0.78) * 3.2 : 0;
  out.r = base + speck * 0.10;
  out.g = base + speck * 0.11;
  out.b = base + speck * 0.13;
  out.h = 0.3 + grit * 0.7;
  out.rough = 0.98 - speck * 0.35;
  out.metal = 0.02 + speck * 0.1;
  out.ao = 0.68 + grit * 0.32;
}

/** Woven carbon shell: 2x2 twill with a clearcoat sheen. */
function shadeCarbon(u, v, out) {
  const cells = 26;
  const fx = u * cells;
  const fy = v * cells;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const over = ((ix + Math.floor(iy / 2)) & 1) === 0;
  const t = over ? fy - iy : fx - ix;
  const ridge = Math.sin(t * Math.PI);
  const fibre = fbm01(u * 3, v * 3, 220, 220, 2, 5);
  const shade = 0.028 + ridge * 0.05 + fibre * 0.012;
  out.r = shade * 0.92;
  out.g = shade * 0.98;
  out.b = shade * 1.14;
  out.h = 0.4 + ridge * 0.6;
  out.rough = 0.20 + (1 - ridge) * 0.16;
  out.metal = 0.55;
  out.ao = 0.78 + ridge * 0.22;
}

/** Brushed alloy for the chassis, trucks and nacelles. */
function shadeAlloy(u, v, out) {
  const brush = fbm01(u, v * 0.06, 40, 500, 3, 33);
  const grain = fbm01(u, v, 300, 12, 2, 71);
  const base = 0.30 + brush * 0.16 + grain * 0.05;
  out.r = base * 1.0;
  out.g = base * 1.03;
  out.b = base * 1.1;
  out.h = 0.45 + grain * 0.55;
  out.rough = 0.26 + brush * 0.2;
  out.metal = 0.95;
  out.ao = 0.85 + grain * 0.15;
}

/** Build (once) and publish the board's materials into the shared library. */
function ensureMaterials(materials) {
  if (!materials.has('mount.grip')) {
    materials.register('mount.grip', standardFromBake(256, shadeGrip, 1.5, { repeat: 2 }));
  }
  if (!materials.has('mount.carbon')) {
    const m = standardFromBake(256, shadeCarbon, 1.1, { repeat: 2 });
    m.envMapIntensity = 1.4;
    materials.register('mount.carbon', m);
  }
  if (!materials.has('mount.alloy')) {
    const m = standardFromBake(256, shadeAlloy, 0.8, { repeat: 1 });
    m.envMapIntensity = 1.5;
    materials.register('mount.alloy', m);
  }
}

/**
 * Bake a PBR set and wire it up exactly the way MaterialLibrary._standard does,
 * so mount surfaces sit in the same lighting response as the worlds.
 */
export function standardFromBake(size, shade, normalStrength, opts = {}) {
  const s = bakeSurface(size, shade, {
    normalStrength,
    name: opts.name ?? 'mount',
    emissive: !!opts.emissive,
  });
  const rep = opts.repeat ?? 1;
  if (rep !== 1) {
    for (const t of s.textures) t.repeat.set(rep, opts.repeatY ?? rep);
  }
  const m = new THREE.MeshStandardMaterial({
    color: opts.color ?? 0xffffff,
    map: s.map,
    normalMap: s.normalMap,
    roughnessMap: s.ormMap,
    metalnessMap: s.ormMap,
    aoMap: s.ormMap,
    roughness: 1,
    metalness: 1,
    envMapIntensity: opts.envMapIntensity ?? 1,
    side: opts.side ?? THREE.FrontSide,
    transparent: !!opts.transparent,
    opacity: opts.opacity ?? 1,
    dithering: true,
  });
  if (s.emissiveMap) {
    m.emissiveMap = s.emissiveMap;
    m.emissive = new THREE.Color(opts.emissive ?? 0xffffff);
    m.emissiveIntensity = opts.emissiveIntensity ?? 1;
  }
  return m;
}

/* ================================================================== */
/* Geometry                                                            */
/* ================================================================== */

/** Rounded, pointed-nose deck outline in the XY plane (Y = board length). */
function deckShape(halfW, halfL) {
  const s = new THREE.Shape();
  const tipL = halfL;
  const shoulder = halfL * 0.62;
  s.moveTo(0, tipL);
  s.bezierCurveTo(halfW * 0.72, tipL * 0.96, halfW, shoulder + 0.1, halfW, shoulder * 0.4);
  s.lineTo(halfW, -shoulder * 0.4);
  s.bezierCurveTo(halfW, -shoulder - 0.1, halfW * 0.72, -tipL * 0.96, 0, -tipL);
  s.bezierCurveTo(-halfW * 0.72, -tipL * 0.96, -halfW, -shoulder - 0.1, -halfW, -shoulder * 0.4);
  s.lineTo(-halfW, shoulder * 0.4);
  s.bezierCurveTo(-halfW, shoulder + 0.1, -halfW * 0.72, tipL * 0.96, 0, tipL);
  return s;
}

/**
 * Extrude the deck outline, lay it flat and sculpt it: kicked nose and tail,
 * concave between the feet. Flat extrusions look like cardboard; the double
 * curvature is what makes it read as a board.
 */
function buildDeckGeometry() {
  const halfW = DECK_WIDTH * 0.5;
  const halfL = DECK_LENGTH * 0.5;
  const geo = new THREE.ExtrudeGeometry(deckShape(halfW, halfL), {
    depth: 0.05,
    bevelEnabled: true,
    bevelThickness: 0.016,
    bevelSize: 0.014,
    bevelOffset: 0,
    bevelSegments: 2,
    curveSegments: 16,
  });
  geo.rotateX(-Math.PI / 2); // shape +Y -> world -Z, extrusion -> +Y
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const tz = clamp(z / halfL, -1, 1);
    const tx = clamp(x / halfW, -1, 1);
    // Nose (-Z) kicks harder than the tail, as on a real directional board.
    const kick = tz < 0 ? 0.14 * tz * tz : 0.10 * tz * tz;
    const concave = 0.016 * tx * tx;
    pos.setY(i, y + kick + concave);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** The glowing lip that runs the full perimeter, inset just under the deck. */
function buildTrimGeometry() {
  const halfW = DECK_WIDTH * 0.5;
  const halfL = DECK_LENGTH * 0.5;
  const geo = new THREE.ExtrudeGeometry(deckShape(halfW * 1.035, halfL * 1.012), {
    depth: 0.022,
    bevelEnabled: false,
    curveSegments: 16,
  });
  geo.rotateX(-Math.PI / 2);
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const tz = clamp(z / halfL, -1, 1);
    const tx = clamp(x / halfW, -1, 1);
    pos.setY(i, pos.getY(i) + (tz < 0 ? 0.14 * tz * tz : 0.10 * tz * tz) + 0.016 * tx * tx - 0.03);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** Chassis, nacelles, bindings and nozzle housings, merged into one draw. */
function buildChassisGeometry() {
  const parts = [];
  const push = (g, x, y, z, rx = 0, ry = 0, rz = 0) => {
    if (rx) g.rotateX(rx);
    if (ry) g.rotateY(ry);
    if (rz) g.rotateZ(rz);
    g.translate(x, y, z);
    parts.push(g);
  };

  // Spine beam under the deck.
  push(new THREE.BoxGeometry(0.13, 0.05, DECK_LENGTH * 0.74), 0, -0.055, 0);

  // Two thruster nacelles running fore-aft.
  for (const side of [-1, 1]) {
    const body = new THREE.CylinderGeometry(0.075, 0.062, 0.62, 14, 1, true);
    push(body, side * 0.145, -0.075, 0.02, Math.PI / 2);
    const cap = new THREE.SphereGeometry(0.075, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    push(cap, side * 0.145, -0.075, -0.31, -Math.PI / 2);
    // Intake fairing over the front of each nacelle.
    const fair = new THREE.CylinderGeometry(0.085, 0.05, 0.16, 14, 1, true);
    push(fair, side * 0.145, -0.07, -0.24, Math.PI / 2);
  }

  // Corner nozzle housings.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const g = new THREE.CylinderGeometry(0.062, 0.048, 0.075, 12);
      push(g, sx * 0.145, -0.085, sz * 0.56);
    }
  }

  // Low-profile bindings the rider's boots sit inside.
  for (const sz of [-1, 1]) {
    const heel = new THREE.TorusGeometry(0.11, 0.016, 6, 14, Math.PI);
    push(heel, 0, 0.045, sz * 0.31, 0, sz > 0 ? 0 : Math.PI);
    const strap = new THREE.BoxGeometry(0.2, 0.022, 0.05);
    push(strap, 0, 0.062, sz * 0.22);
  }

  return mergeGeometries(parts, false);
}

/** Emissive discs under each nozzle plus the two rear thruster mouths. */
function buildEmitterGeometry() {
  const parts = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const g = new THREE.CircleGeometry(0.045, 14);
      g.rotateX(Math.PI / 2); // face down
      g.translate(sx * 0.145, -0.121, sz * 0.56);
      parts.push(g);
    }
  }
  for (const side of [-1, 1]) {
    const g = new THREE.CircleGeometry(0.055, 14);
    g.translate(side * 0.145, -0.075, 0.331);
    parts.push(g);
  }
  return mergeGeometries(parts, false);
}

/* ================================================================== */
/* Hoverboard                                                          */
/* ================================================================== */

export class Hoverboard {
  /** Colour slots the F10 menu offers. `defaultColor` = factory swatch. */
  static CUSTOM_SLOTS = Object.freeze([
    Object.freeze({ id: 'deck', label: 'Deck', finish: true, defaultColor: 0x2c2f36, palette: 'paint' }),
    Object.freeze({ id: 'glow', label: 'Underglow', finish: false, defaultColor: 0x7ff2ff, palette: 'glow' }),
  ]);
  static STATS = MOUNT_STATS.hoverboard;

  /**
   * @param {{scene:THREE.Scene, engine:any, physics:any, bus:any, materials:any,
   *          camera:THREE.PerspectiveCamera}} ctx
   */
  constructor({ scene, engine, physics, bus, materials, camera }) {
    this.id = 'hoverboard';
    this.displayName = 'HOVERBOARD';
    this.scene = scene;
    this.engine = engine;
    this.physics = physics;
    this.bus = bus;
    this.materials = materials;
    this.camera = camera;

    ensureMaterials(materials);

    /* ---- kinematics ---- */
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.heading = 0;
    this.speed = 0;
    this._vy = 0;
    this._pitch = 0;
    this._roll = 0;
    this._pitchTarget = 0;
    this._rollTarget = 0;
    this._groundY = 0;
    this._groundValid = false;
    this._airborne = false;
    this._boost = 0;
    this._boostActive = false;
    this._bob = 0;
    this._lean = 0;
    this._turnRate = 0;
    /** Suspension load, -1 (weightless) .. 1 (compressed). Drives knee absorb. */
    this._susp = 0;
    this._trailAccum = 0;
    this._ridden = false;
    this._spawnT = 1;
    this._despawnT = -1;
    this._alive = false;

    this._powerMul = 1;
    this._accelMul = 1;
    this._shieldTier = 0;
    this._livery = null;
    this._slotMats = null;
    /**
     * Emitter tint the per-frame ramp starts from.
     *
     * `setRGB` with no colour-space argument writes the renderer's WORKING
     * space, which is exactly what the stock hard-coded ramp used to write.
     * The same numbers through `setHex`/`new Color(0x7ff2ff)` would be decoded
     * sRGB -> linear and land on a visibly different cyan, so stock has to be
     * restored this way rather than from a hex constant.
     */
    this._glowBase = new THREE.Color().setRGB(0.42, 0.86, 1);

    this._buildModel();

    this._trail = new ParticlePool(scene, 96, { color: 0x66e8ff, drag: 1.6, gravity: 1.2 });
    this._sparks = new ParticlePool(scene, 48, { color: 0xffd08a, drag: 0.9, gravity: -6 });
    this._speedLines = new SpeedLines(scene, 56, 0xcdf3ff);
    this.setVisible(false);
  }

  /* ---------------------------------------------------------------- */
  /* Model                                                             */
  /* ---------------------------------------------------------------- */

  _buildModel() {
    const M = this.materials;
    this.root = new THREE.Group();
    this.root.name = 'hoverboard';

    // tilt carries pitch/roll; bobber carries the hover spring, so the two
    // never fight for the same transform.
    this.tilt = new THREE.Group();
    this.bobber = new THREE.Group();
    this.root.add(this.tilt);
    this.tilt.add(this.bobber);

    this._geo = {};
    this._gripMat = M.get('mount.grip').clone();
    this._carbonMat = M.get('mount.carbon').clone();
    // A clone, so the underglow slot can tint it without repainting every other
    // cyan strip in the world. The library drives the ORIGINAL's emissive pulse
    // from its own `_animate` list (Materials.js:1830) and a clone is not on that
    // list, so this trim sits at a steady emissiveIntensity - accepted: the
    // board's own boost ramp is the light show here, not a 6% breathe.
    this._trimMat = M.get('emissive.cyan').clone();
    const gripMat = this._gripMat;
    const carbonMat = this._carbonMat;
    const alloyMat = M.get('mount.alloy');
    const trimMat = this._trimMat;

    this._geo.deck = buildDeckGeometry();
    const deck = new THREE.Mesh(this._geo.deck, [gripMat, carbonMat]);
    // ExtrudeGeometry emits group 0 = caps, group 1 = walls; grip on top, weave
    // on the rails is exactly the split a real deck has.
    deck.castShadow = true;
    deck.receiveShadow = true;
    this.bobber.add(deck);

    this._geo.trim = buildTrimGeometry();
    const trim = new THREE.Mesh(this._geo.trim, trimMat);
    trim.castShadow = false;
    this.bobber.add(trim);

    this._geo.chassis = buildChassisGeometry();
    const chassis = new THREE.Mesh(this._geo.chassis, alloyMat);
    chassis.castShadow = true;
    this.bobber.add(chassis);

    this._geo.emitters = buildEmitterGeometry();
    this._emitterMat = new THREE.MeshBasicMaterial({
      color: 0x7ff2ff,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this._emitters = new THREE.Mesh(this._geo.emitters, this._emitterMat);
    this._emitters.renderOrder = 4;
    this.bobber.add(this._emitters);

    // Thruster flare cones behind the nacelles, scaled by boost. The cone is
    // laid tip-aft with its mouth on the origin, so scaling Z stretches the
    // plume backwards out of the nozzle instead of growing in both directions.
    this._geo.flare = new THREE.ConeGeometry(0.072, 0.5, 12, 1, true);
    this._geo.flare.rotateX(Math.PI / 2);
    this._geo.flare.translate(0, 0, 0.25);
    this._flareMat = new THREE.MeshBasicMaterial({
      color: 0x9fe8ff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this._flares = [];
    for (const side of [-1, 1]) {
      const f = new THREE.Mesh(this._geo.flare, this._flareMat);
      f.position.set(side * 0.145, -0.075, 0.33);
      f.renderOrder = 5;
      this.bobber.add(f);
      this._flares.push(f);
    }

    // Ground glow. Lives on the root (not the tilt) so it stays flat on the
    // floor while the deck banks over it.
    this._glowTex = makeGlowTexture(128, 2.4);
    this._glowMat = new THREE.MeshBasicMaterial({
      map: this._glowTex,
      color: 0x5fd8ff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this._geo.glow = new THREE.PlaneGeometry(2.6, 2.6);
    this._geo.glow.rotateX(-Math.PI / 2);
    this._glow = new THREE.Mesh(this._geo.glow, this._glowMat);
    this._glow.renderOrder = 3;
    this.root.add(this._glow);

    this._slotMats = {
      deck: [this._gripMat, this._carbonMat],
      glow: [{ mat: this._trimMat, emissive: true }, this._flareMat, this._glowMat],
    };
    this.applyCustomization(this._livery);

    // Under-deck fill light: cheap, but it is what makes the board look like it
    // is actually pushing light onto the ground it hovers over.
    //
    // It does NOT hang off `bobber`. `root` is removed from the scene on
    // `kill()` and hidden by `setVisible(false)`, and either one stops the
    // renderer counting a light beneath it - which changes `numPointLights`
    // and recompiles every program in the scene. Measured on this build: a
    // first dismount in the sports world rebuilt 79 programs and froze the
    // next frame for 28 s. The light therefore lives in a group that is added
    // to the scene at construction and never leaves, and follows an anchor on
    // the bobber instead. Same pattern the car already uses for its headlight.
    this._lightGroup = new THREE.Group();
    this._lightGroup.name = 'hoverboard-lights';
    this.scene.add(this._lightGroup);
    this._light = new THREE.PointLight(0x58d7ff, 0, 6, 2);
    this._light.castShadow = false;
    /** Factory tint, restored when the Underglow slot carries no colour. */
    this._lightFactory = this._light.color.clone();
    this._anchoredLight = anchorLight(
      this._light, this._lightGroup, this.bobber, { x: 0, y: -0.25, z: 0 }
    );

    // Rider platform hangs off `tilt`, not `bobber`: the bobber is scaled by the
    // materialisation animation and a scaled anchor would scale the rider too.
    // It still carries the deck's idle bob, so the rider's feet ride the hover
    // spring with the board rather than hanging in a fixed plane above it.
    this.riderPlatform = new THREE.Group();
    this.riderPlatform.name = 'hoverboard-rider-platform';
    this.tilt.add(this.riderPlatform);

    this.riderAnchor = new THREE.Object3D();
    this.riderAnchor.position.set(0, 0.06, 0);
    this.riderPlatform.add(this.riderAnchor);

    /**
     * Sole rest points inside the bindings. The rider solves its feet onto
     * these, exactly as the dragon's rider solves onto the stirrup irons - so
     * the stance follows the deck instead of being keyframed to match one
     * particular set of binding coordinates.
     *
     * Index 0 is the tail binding (the rider's back foot, `side > 0`), index 1
     * the nose binding (the leading foot). Same numeric-side convention the
     * dragon and the car already use.
     */
    this.footAnchors = [];
    for (const sz of [1, -1]) {
      const a = new THREE.Object3D();
      a.position.set(0, BINDING_Y, sz * BINDING_Z);
      this.riderPlatform.add(a);
      this.footAnchors.push(a);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  get alive() {
    return this._alive;
  }

  setVisible(v) {
    this.root.visible = v;
    this._trail.setVisible(v);
    this._sparks.setVisible(v);
    // The under-deck light is not a child of `root` any more (see the build),
    // so it has to be darkened by hand rather than hidden with the board.
    if (!v) this._light.intensity = 0;
  }

  /**
   * Place the board and start the materialisation animation.
   * @param {THREE.Vector3} position feet-height point to spawn over
   * @param {number} yaw radians
   */
  spawn(position, yaw) {
    this.position.copy(position);
    // Probe locally, from just above the requested point. A long cast from the
    // sky finds whatever roof, gantry or floodlight happens to be overhead and
    // spawns the board on top of it.
    const g = this.physics.groundHeight(position.x, position.z, position.y + 1.6, 10);
    this._groundY = g === null ? position.y : g;
    this._groundValid = g !== null;
    this.position.y = g + HOVER_HEIGHT;
    this.heading = yaw;
    this.velocity.set(0, 0, 0);
    this.speed = 0;
    this._vy = 0;
    this._pitch = 0;
    this._roll = 0;
    this._boost = 0;
    this._susp = 0;
    this._spawnT = 0;
    this._despawnT = -1;
    this._alive = true;
    this.root.position.copy(this.position);
    this.root.rotation.y = yaw;
    if (!this.root.parent) this.scene.add(this.root);
    this.setVisible(true);
    this._trail.clear();
    this._sparks.clear();

    // A ring of sparks kicked outward sells the arrival without a single asset.
    for (let i = 0; i < 34; i++) {
      const a = (i / 34) * Math.PI * 2;
      this._sparks.spawn(
        this.position.x + Math.cos(a) * 0.4,
        this.position.y - 0.1,
        this.position.z + Math.sin(a) * 0.4,
        Math.cos(a) * 2.6, 2.2 + Math.random() * 2.4, Math.sin(a) * 2.6,
        0.55 + Math.random() * 0.35, 0.16, 0.65, 0.92, 1
      );
    }
  }

  /** Begin the despawn dissolve. `alive` clears once it finishes. */
  despawn() {
    if (!this._alive || this._despawnT >= 0) return;
    this._despawnT = 0;
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2;
      this._sparks.spawn(
        this.position.x + Math.cos(a) * 0.3,
        this.position.y + Math.random() * 0.2,
        this.position.z + Math.sin(a) * 0.3,
        Math.cos(a) * 1.4, 1.6 + Math.random() * 1.6, Math.sin(a) * 1.4,
        0.5, 0.14, 0.5, 0.86, 1
      );
    }
  }

  /** Remove immediately, no animation. Used when the world changes under us. */
  kill() {
    this._alive = false;
    this._ridden = false;
    this._despawnT = -1;
    this._spawnT = 1;
    this.setVisible(false);
    this._trail.clear();
    this._sparks.clear();
    this._speedLines.update(0.016, this.camera, 0);
    this.root.removeFromParent();
  }

  onMount() {
    this._ridden = true;
  }

  onDismount() {
    this._ridden = false;
    this._boost = 0;
    this._boostActive = false;
  }

  /* ---------------------------------------------------------------- */
  /* Simulation                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * @param {number} dt fixed step
   * @param {number} elapsed
   * @param {{throttle:number, strafe:number, yaw:number, boost:boolean}|null} ctrl
   *        null while parked
   */
  fixedUpdate(dt, elapsed, ctrl) {
    if (!this._alive) return;

    const ridden = !!ctrl;
    const throttle = ridden ? ctrl.throttle : 0;
    const strafe = ridden ? ctrl.strafe : 0;
    const boost = ridden && !!ctrl.boost && throttle > 0;

    /* ---- heading: chase the look direction at a limited rate ---- */
    if (ridden) {
      // Carving with A/D biases the target heading, which is what makes the
      // board feel like it has edges rather than a steering wheel.
      const carve = -strafe * 0.55;
      let target = ctrl.yaw + carve;
      let diff = ((target - this.heading + Math.PI) % (Math.PI * 2)) - Math.PI;
      if (diff < -Math.PI) diff += Math.PI * 2;
      // Turn authority falls off with speed: fast means committed.
      const grip = 1 - clamp01(this.speed / (BOOST_SPEED * 1.35)) * 0.45;
      const maxRate = 3.1 * grip;
      const rate = clamp(diff * 6.5, -maxRate, maxRate);
      this.heading += rate * dt;
      this._turnRate = damp(this._turnRate, rate, 10, dt);
    } else {
      this._turnRate = damp(this._turnRate, 0, 6, dt);
    }

    /* ---- speed ---- */
    this._boost = damp(this._boost, boost ? 1 : 0, boost ? 4.5 : 3, dt);
    this._boostActive = boost;
    let targetSpeed = 0;
    if (throttle > 0) targetSpeed = THREE.MathUtils.lerp(CRUISE_SPEED, BOOST_SPEED, this._boost) * this._powerMul;
    else if (throttle < 0) targetSpeed = -REVERSE_SPEED;
    // Asymmetric response: quick to spool up, quicker to shed speed on the
    // brake, and a long lazy coast when the rider lets go.
    const accel = throttle === 0 ? 3.4 : targetSpeed > this.speed ? (9.5 + this._boost * 7) * this._accelMul : 12;
    this.speed = damp(this.speed, targetSpeed, accel * 0.45, dt);
    if (Math.abs(this.speed) < 0.02) this.speed = 0;

    const fx = -Math.sin(this.heading);
    const fz = -Math.cos(this.heading);
    this.velocity.set(fx * this.speed, this._vy, fz * this.speed);

    /* ---- terrain sampling at the four corners ---- */
    const halfL = DECK_LENGTH * 0.5;
    const halfW = DECK_WIDTH * 0.5 + 0.06;
    const rx = Math.cos(this.heading);
    const rz = -Math.sin(this.heading);
    let sum = 0;
    let hits = 0;
    let front = 0;
    let back = 0;
    let left = 0;
    let right = 0;
    for (let i = 0; i < 4; i++) {
      const sz = i < 2 ? -1 : 1;
      const sx = i % 2 === 0 ? -1 : 1;
      const px = this.position.x + fx * halfL * -sz + rx * halfW * sx;
      const pz = this.position.z + fz * halfL * -sz + rz * halfW * sx;
      const h = this.physics.groundHeight(px, pz, this.position.y + 1.6, 9);
      const y = h === null ? this._groundY - 3 : h;
      if (h !== null) hits++;
      sum += y;
      if (sz < 0) front += y * 0.5; else back += y * 0.5;
      if (sx < 0) left += y * 0.5; else right += y * 0.5;
    }
    const avg = sum * 0.25;
    this._groundValid = hits > 0;
    if (hits > 0) this._groundY = avg;

    /* ---- ride height spring ---- */
    const targetY = this._groundY + HOVER_HEIGHT;
    const diffY = targetY - this.position.y;
    if (diffY < -1.1) {
      // The floor fell away - a ramp lip or a ledge. Let it fly.
      this._airborne = true;
      this._vy += GRAVITY * dt;
      // Weightless: the rider's legs extend under the board rather than folding.
      this._susp = damp(this._susp, -0.85, 7, dt);
    } else {
      if (this._airborne && this._vy < -6) this._onLanding(-this._vy);
      this._airborne = false;
      // Critically damped-ish suspension. Stiff enough to hold a kerb, soft
      // enough that the rider is never punched upward.
      const susp = diffY * 62 - this._vy * 12;
      this._vy += susp * dt;
      this._vy = clamp(this._vy, -14, 9);
      // The same spring acceleration the deck feels IS the load the rider's
      // knees have to swallow, so the absorb signal is taken straight off it
      // rather than re-derived from a second, subtly different filter.
      this._susp = damp(this._susp, clamp(susp / 42, -1, 1), 13, dt);
    }
    this.position.y += this._vy * dt;
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;

    /* ---- keep out of walls ---- */
    this._resolveCollision();

    /* ---- attitude targets ---- */
    const slopePitch = Math.atan2(front - back, DECK_LENGTH) * 0.9;
    const slopeRoll = Math.atan2(right - left, DECK_WIDTH + 0.12) * 0.35;
    // Bank into the turn, plus a rider-weight lean from the strafe axis.
    const bank = clamp(this._turnRate * clamp01(this.speed / CRUISE_SPEED) * 0.42, -0.62, 0.62);
    this._lean = damp(this._lean, ridden ? -strafe * 0.16 : 0, 6, dt);
    this._rollTarget = bank + slopeRoll + this._lean;
    // Nose lifts under acceleration and drops under braking.
    const accelPitch = clamp((targetSpeed - this.speed) * 0.012, -0.12, 0.16);
    this._pitchTarget = -slopePitch - accelPitch + (this._airborne ? 0.05 : 0);

    this._pitch = damp(this._pitch, this._pitchTarget, 7.5, dt);
    this._roll = damp(this._roll, this._rollTarget, 8.5, dt);
  }

  /**
   * Push the ride capsule out of any geometry it entered and kill the velocity
   * component that took it there, so the board scrapes along walls instead of
   * sticking or tunnelling.
   */
  _resolveCollision() {
    _sc1.set(this.position.x, this.position.y - HOVER_HEIGHT + 0.08, this.position.z);
    _sc2.copy(_sc1);
    this.physics.resolveCapsule(_sc1, RIDE_RADIUS, RIDE_HEIGHT);
    const dx = _sc1.x - _sc2.x;
    const dz = _sc1.z - _sc2.z;
    const dy = _sc1.y - _sc2.y;
    const lenSq = dx * dx + dz * dz;
    if (lenSq > 1e-8) {
      const len = Math.sqrt(lenSq);
      const nx = dx / len;
      const nz = dz / len;
      const into = this.velocity.x * nx + this.velocity.z * nz;
      if (into < 0) {
        this.velocity.x -= nx * into;
        this.velocity.z -= nz * into;
        // Scrubbing a wall costs speed - it should feel like a mistake.
        this.speed *= 0.86;
      }
      this.position.x += dx;
      this.position.z += dz;
    }
    // Only accept upward corrections; a downward one is the solver squeezing
    // us out of a ceiling and would fight the hover spring.
    if (dy > 0.001) {
      this.position.y += dy;
      if (this._vy < 0) this._vy = 0;
    }
  }

  _onLanding(speed) {
    const n = Math.min(14, 4 + speed);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      this._sparks.spawn(
        this.position.x + Math.cos(a) * 0.3,
        this.position.y - HOVER_HEIGHT + 0.04,
        this.position.z + Math.sin(a) * 0.3,
        Math.cos(a) * 2.4, 1.4 + Math.random(), Math.sin(a) * 2.4,
        0.35, 0.12, 1, 0.8, 0.45
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Presentation                                                      */
  /* ---------------------------------------------------------------- */

  update(dt, elapsed) {
    if (!this._alive) {
      // Keep draining the pools so a despawn does not freeze sprites in mid-air.
      this._trail.update(dt, this.camera);
      this._sparks.update(dt, this.camera);
      this._speedLines.update(dt, this.camera, 0);
      return;
    }

    /* ---- spawn / despawn envelopes ---- */
    if (this._spawnT < 1) this._spawnT = Math.min(1, this._spawnT + dt * 1.9);
    if (this._despawnT >= 0) {
      this._despawnT += dt * 2.4;
      if (this._despawnT >= 1) {
        this._alive = false;
        this.setVisible(false);
        this.root.removeFromParent();
        return;
      }
    }
    const materialise = this._despawnT >= 0 ? 1 - this._despawnT : this._spawnT;
    const ease = materialise * materialise * (3 - 2 * materialise);

    this.root.position.copy(this.position);
    this.root.rotation.y = this.heading;
    this.tilt.rotation.set(this._pitch, 0, this._roll);
    // Assemble upward out of nothing, and sink back into it on dismissal.
    this.bobber.position.y = (1 - ease) * -0.55;
    this.bobber.scale.set(0.35 + ease * 0.65, 0.2 + ease * 0.8, 0.35 + ease * 0.65);

    /* ---- idle bob and thruster shimmer ---- */
    this._bob = Math.sin(elapsed * 2.3) * 0.018 + Math.sin(elapsed * 5.7) * 0.006;
    this.bobber.position.y += this._bob * (this._ridden ? 0.5 : 1);
    // The rider platform takes the bob but not the materialisation offset or
    // scale, so the feet stay welded to the bindings while the board assembles.
    this.riderPlatform.position.y = this._bob * (this._ridden ? 0.5 : 1);

    const sp01 = clamp01(Math.abs(this.speed) / BOOST_SPEED);
    const heat = 0.35 + sp01 * 0.65 + this._boost * 0.5;
    this._emitterMat.opacity = (0.35 + heat * 0.55) * ease;
    // Boost heats the emitter by lifting red only - the stock ramp exactly, and
    // a custom glow gets the same heat rather than being washed toward white.
    this._emitterMat.color.copy(this._glowBase);
    this._emitterMat.color.r = Math.min(1, this._emitterMat.color.r + this._boost * 0.55);

    const flare = clamp01(this._boost * 1.1 - 0.02) * ease;
    this._flareMat.opacity = flare * 0.6;
    for (const f of this._flares) {
      const wob = 1 + Math.sin(elapsed * 40 + f.position.x * 30) * 0.14;
      f.scale.set(0.8 + flare * 0.35, 0.8 + flare * 0.35, (0.35 + flare * 1.5) * wob);
      f.visible = flare > 0.01;
    }

    this._light.intensity = (2.2 + sp01 * 2 + this._boost * 6) * ease;
    this._light.distance = 5 + this._boost * 4;
    // Parented to the scene, not the board: walk it back under the deck.
    this._anchoredLight.sync();

    /* ---- ground glow tracks the floor, not the deck ---- */
    const gy = this._groundY + 0.035;
    this._glow.position.set(0, gy - this.position.y, 0);
    const alt = clamp01(1 - (this.position.y - this._groundY - HOVER_HEIGHT) / 2.5);
    this._glowMat.opacity = (0.28 + sp01 * 0.3 + this._boost * 0.42) * alt * ease;
    const gs = 1 + sp01 * 0.35 + this._boost * 0.45;
    this._glow.scale.set(gs, 1, gs * (1 + sp01 * 0.5));

    /* ---- trail ---- */
    if (this._alive && this._despawnT < 0) this._emitTrail(dt, sp01);
    this._trail.update(dt, this.camera);
    this._sparks.update(dt, this.camera);

    // Speed lines only when the rider is actually moving fast enough to earn
    // them; they are a boost cue, not a decoration.
    const rush = this._ridden ? clamp01((Math.abs(this.speed) - CRUISE_SPEED * 0.85) / (BOOST_SPEED - CRUISE_SPEED * 0.85)) : 0;
    this._speedLines.update(dt, this.camera, rush * (0.18 + this._boost * 0.42));
  }

  _emitTrail(dt, sp01) {
    const rate = 12 + sp01 * 55 + this._boost * 70;
    this._trailAccum += rate * dt;
    const n = Math.floor(this._trailAccum);
    if (n <= 0) return;
    this._trailAccum -= n;

    const fx = -Math.sin(this.heading);
    const fz = -Math.cos(this.heading);
    const rx = Math.cos(this.heading);
    const rz = -Math.sin(this.heading);
    for (let i = 0; i < n && i < 6; i++) {
      const side = Math.random() < 0.5 ? -0.145 : 0.145;
      _tr1.set(
        this.position.x - fx * 0.34 + rx * side,
        this.position.y - 0.1 - Math.random() * 0.06,
        this.position.z - fz * 0.34 + rz * side
      );
      const back = 2.5 + this._boost * 9;
      _tr2.set(
        -fx * back + (Math.random() - 0.5) * 1.2,
        -0.6 - Math.random() * 0.9,
        -fz * back + (Math.random() - 0.5) * 1.2
      );
      const hot = this._boost;
      this._trail.spawn(
        _tr1.x, _tr1.y, _tr1.z, _tr2.x, _tr2.y, _tr2.z,
        0.3 + Math.random() * 0.26,
        0.085 + Math.random() * 0.07 + hot * 0.07,
        0.35 + hot * 0.6, 0.85 + hot * 0.15, 1
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Queries used by MountManager                                      */
  /* ---------------------------------------------------------------- */

  /**
   * World position the rider's FEET should occupy. Syncs the transform first so
   * this is valid from `fixedUpdate`, before the frame update composes visuals.
   */
  getSeat(out) {
    this.root.position.copy(this.position);
    this.root.rotation.y = this.heading;
    this.tilt.rotation.set(this._pitch, 0, this._roll);
    this.root.updateMatrixWorld(true);
    return out.setFromMatrixPosition(this.riderAnchor.matrixWorld);
  }

  /**
   * World position of a binding's sole rest, optionally lifted along the deck's
   * own up axis.
   *
   * The lift exists because the rider's IK targets its ANKLE, not its sole, and
   * only the caller knows how tall the ankle of the figure it built is. Doing
   * the offset here - inside the anchor's matrix - means it follows the deck
   * through pitch and roll for free, which a world-space `+ y` could not.
   *
   * @param {number} side +1 back foot (tail binding), -1 leading foot (nose)
   * @param {THREE.Vector3} out
   * @param {number} [lift] metres above the sole rest, in deck space
   */
  getFootWorld(side, out, lift = 0) {
    const o = this.footAnchors?.[side > 0 ? 0 : 1];
    if (!o) return null;
    o.updateWorldMatrix(true, false);
    return out.set(0, lift, 0).applyMatrix4(o.matrixWorld);
  }

  /**
   * The same binding, as an offset from `riderAnchor` in deck space. Both are
   * children of the same platform, so this is exact and constant - the rider
   * uses it to work out how far it has to crouch for its legs to reach.
   * @param {number} side +1 back foot, -1 leading foot
   * @param {THREE.Vector3} out
   */
  getFootLocal(side, out) {
    const o = this.footAnchors?.[side > 0 ? 0 : 1];
    if (!o) return null;
    return out.copy(o.position).sub(this.riderAnchor.position);
  }

  /** Signed carve, -1..1. Positive is a left/heel-side turn. */
  get carve01() {
    return clamp(this._turnRate / 2.4 + this._lean * 2.2, -1, 1);
  }

  /** Deck bank angle in radians - the rider leans with it. */
  get bankRoll() {
    return this._roll;
  }

  /** Suspension load, -1 weightless .. 1 compressed. */
  get suspension() {
    return this._susp;
  }

  get airborne() {
    return this._airborne;
  }

  /** Extra FOV degrees the camera should take on, for the boost rush. */
  get fovKick() {
    return this._boost * 9 + clamp01(Math.abs(this.speed) / BOOST_SPEED) * 3.5;
  }

  get boostActive() {
    return this._boostActive;
  }

  get speed01() {
    return clamp01(Math.abs(this.speed) / BOOST_SPEED);
  }

  get boost01() {
    return this._boost;
  }

  /**
   * Speed as the held mount voice is allowed to see it - see Dragon.voiceSpeed
   * for the measured drift this exists to stop. Every visual cue on the board
   * is a `clamp01(|speed| / BOOST_SPEED)`, so the audio ceiling has to be the
   * same one or a Power tier runs the loop faster than the thrusters look.
   */
  get voiceSpeed() {
    return Math.min(Math.abs(this.speed), BOOST_SPEED);
  }

  /** Ground clearance in metres, used by the dismount placement. */
  get altitude() {
    return this.position.y - this._groundY;
  }

  get groundY() {
    return this._groundY;
  }

  canDismount() {
    return this.altitude < 2.2;
  }

  /** Where to stand the player when they step off. */
  dismountPoint(out) {
    const rx = Math.cos(this.heading);
    const rz = -Math.sin(this.heading);
    return out.set(
      this.position.x + rx * 0.9,
      this._groundY + 0.05,
      this.position.z + rz * 0.9
    );
  }

  applyCustomization(livery) {
    this._livery = livery && typeof livery === 'object' ? livery : {};
    if (!this._slotMats) return;
    applyLivery(this._livery, this.constructor.CUSTOM_SLOTS, this._slotMats);
    // The emitter is re-tinted every frame from this base (see the update loop).
    const glow = normColor(this._livery.glow?.color);
    if (glow == null) this._glowBase.setRGB(0.42, 0.86, 1);
    else this._glowBase.setHex(glow);
    // The under-deck fill light carries the same colour, so a custom underglow
    // actually reaches the ground. Uniform write only - never a relink.
    // Guarded: the first call comes from _buildModel, before the light exists.
    if (this._light) this._light.color.copy(glow == null ? this._lightFactory : this._glowBase);
  }

  applyPowers({ strength = 0, shield = 0, power = 0 } = {}) {
    this._powerMul = 1 + Math.max(0, power) * 0.12;
    this._accelMul = 1 + Math.max(0, strength) * 0.10;
    this._shieldTier = Math.max(0, shield);
  }

  get shieldTier() {
    return this._shieldTier;
  }

  dispose() {
    this.root.removeFromParent();
    this._lightGroup.removeFromParent();
    this._light.dispose?.();
    for (const key in this._geo) this._geo[key].dispose();
    this._emitterMat?.dispose();
    this._flareMat?.dispose();
    this._glowMat?.dispose();
    this._glowTex?.dispose();
    this._trail?.dispose();
    this._sparks?.dispose();
    this._speedLines?.dispose();
    this._gripMat?.dispose();
    this._carbonMat?.dispose();
    this._trimMat?.dispose();
    this._slotMats = null;
  }
}
