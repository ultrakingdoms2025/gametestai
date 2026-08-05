import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../core/Config.js';
import { anchorLight } from '../gfx/LightAnchor.js';
// Cycle-safe: `ViewArm` imports this module's geometry helpers, which are
// hoisted function declarations, and neither module touches the other at
// evaluation time - only inside a constructor.
import { ViewArm } from '../weapons/ViewArm.js';

/**
 * The VK-7 "Ripper" first-person viewmodel.
 *
 * ── Why the viewmodel never clips through walls ────────────────────────────
 * A second render pass is not available to us: `PostFX` owns the composer and
 * renders `engine.scene` with `engine.camera`, so anything parked on a private
 * camera layer would simply never be drawn. Clearing the depth buffer mid-frame
 * is equally unsafe - the AO pass in the post chain runs its own depth prepass
 * over the same scene graph, and a `clearDepth()` sentinel would wipe the world
 * depth out from under it.
 *
 * Instead every viewmodel material carries a two-line vertex patch that squashes
 * its NDC depth into the nearest 0.05% of the depth range. The gun therefore:
 *   - always wins the depth test against world geometry (opaque *and* alpha),
 *   - still self-occludes correctly, because relative ordering is preserved,
 *   - is immune to near-plane clipping, because the rewritten z can never fall
 *     outside [-w, w].
 * Shadow maps and the AO depth prepass are unaffected: the viewmodel never
 * casts shadows (so it is skipped by the shadow render list) and the AO pass
 * substitutes its own override material.
 *
 * Everything is generated in code - geometry from chamfered primitives, all
 * texture channels from canvas2d noise fields. No assets, no loaders.
 */

/* ------------------------------------------------------------------ */
/* Module-scope scratch - nothing below allocates in a per-frame path. */
/* ------------------------------------------------------------------ */
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m4 = new THREE.Matrix4();
const _eul = new THREE.Euler();
const _col = new THREE.Color();

export const DEG = Math.PI / 180;
const damp = THREE.MathUtils.damp;
const clamp = THREE.MathUtils.clamp;
const ZERO2 = Object.freeze({ x: 0, y: 0 });

/* ------------------------------------------------------------------ */
/* Procedural texture generation                                       */
/* ------------------------------------------------------------------ */

/** Deterministic 2D hash in [0,1). Cheap, and good enough for surface noise. */
export function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothNoise(x, y, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  // Quintic fade keeps the derivative continuous, so the derived normal map
  // does not show lattice creases.
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbm(x, y, seed, octaves, lacunarity = 2.03, gain = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    sum += smoothNoise(fx, fy, seed + i * 71) * amp;
    norm += amp;
    amp *= gain;
    fx *= lacunarity;
    fy *= lacunarity;
  }
  return sum / norm;
}

export function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}

export function finishTexture(tex, renderer, srgb, repeat) {
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = renderer?.capabilities?.getMaxAnisotropy?.() ?? 4;
  // DataTexture defaults to no mipmaps + nearest filtering, which shimmers
  // badly on an object that occupies a third of the screen.
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Sobel a height field into a tangent-space normal map. */
export function heightToNormal(height, size, strength, renderer) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = height[y * size + ((x - 1 + size) % size)];
      const r = height[y * size + ((x + 1) % size)];
      const u = height[((y - 1 + size) % size) * size + x];
      const d = height[((y + 1) % size) * size + x];
      let nx = (l - r) * strength;
      let ny = (u - d) * strength;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= inv;
      ny *= inv;
      const i = (y * size + x) * 4;
      data[i] = (nx * 0.5 + 0.5) * 255;
      data[i + 1] = (ny * 0.5 + 0.5) * 255;
      data[i + 2] = (inv * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  return finishTexture(tex, renderer, false, 1);
}

/**
 * Machined, phosphate-finished metal: micro grain, stretched tool marks, sparse
 * deep scratches that expose bright bare steel, and matching roughness.
 *
 * Feature frequencies are deliberately low. A viewmodel primitive is only a few
 * centimetres across yet still carries a full 0..1 UV chart, so a texture built
 * from per-texel noise resolves into a speckled knit at arm's length instead of
 * reading as metal. Everything here works at the scale of a machining pass, and
 * the derived normal map is kept shallow so the surface stays flat under the
 * specular highlight.
 */
export function makeMetalMaps(renderer, size, seed, opts = {}) {
  const baseR = opts.r ?? 0.30;
  const baseG = opts.g ?? 0.31;
  const baseB = opts.b ?? 0.34;
  const baseRough = opts.roughness ?? 0.42;

  const albedo = makeCanvas(size);
  const actx = albedo.getContext('2d');
  const aimg = actx.createImageData(size, size);
  const rough = makeCanvas(size);
  const rctx = rough.getContext('2d');
  const rimg = rctx.createImageData(size, size);
  const height = new Float32Array(size * size);

  // Scratches are evaluated analytically so the same feature lands in albedo,
  // roughness and the height field that becomes the normal map.
  const scratches = [];
  const scratchCount = opts.scratches ?? 26;
  for (let i = 0; i < scratchCount; i++) {
    const a = hash2(i, 11, seed) * Math.PI;
    scratches.push({
      x: hash2(i, 3, seed) * size,
      y: hash2(i, 7, seed) * size,
      dx: Math.cos(a),
      dy: Math.sin(a) * 0.25,
      len: 12 + hash2(i, 13, seed) * size * 0.5,
      w: 0.6 + hash2(i, 17, seed) * 1.5,
      depth: 0.25 + hash2(i, 19, seed) * 0.75,
    });
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;

      const grain = fbm(u * 24, v * 24, seed, 3);
      const tool = fbm(u * 3, v * 26, seed + 500, 2); // anisotropic machining
      const blotch = fbm(u * 3.5, v * 3.5, seed + 900, 3);

      let h = grain * 0.18 + tool * 0.22 + blotch * 0.6;

      let scratchMask = 0;
      for (let s = 0; s < scratches.length; s++) {
        const sc = scratches[s];
        const px = x - sc.x;
        const py = y - sc.y;
        const t = px * sc.dx + py * sc.dy;
        if (t < 0 || t > sc.len) continue;
        const perp = Math.abs(px * -sc.dy + py * sc.dx);
        if (perp > sc.w) continue;
        const f = (1 - perp / sc.w) * sc.depth;
        if (f > scratchMask) scratchMask = f;
      }
      h -= scratchMask * 0.45;
      height[y * size + x] = h;

      // Albedo variance stays inside ±12%: machined steel is an even value, and
      // the eye reads any more than that as dirt or noise.
      const shade = 0.9 + (blotch - 0.5) * 0.2 + (grain - 0.5) * 0.06;
      const wear = scratchMask * 0.4;
      const i = (y * size + x) * 4;
      aimg.data[i] = Math.min(255, (baseR * shade + wear * 0.42) * 255);
      aimg.data[i + 1] = Math.min(255, (baseG * shade + wear * 0.42) * 255);
      aimg.data[i + 2] = Math.min(255, (baseB * shade + wear * 0.44) * 255);
      aimg.data[i + 3] = 255;

      const rg = clamp(
        baseRough + (blotch - 0.5) * 0.16 + (tool - 0.5) * 0.08 - scratchMask * 0.22,
        0.05,
        1
      );
      rimg.data[i] = rg * 255;
      rimg.data[i + 1] = rg * 255;
      rimg.data[i + 2] = rg * 255;
      rimg.data[i + 3] = 255;
    }
  }
  actx.putImageData(aimg, 0, 0);
  rctx.putImageData(rimg, 0, 0);

  return {
    map: finishTexture(new THREE.CanvasTexture(albedo), renderer, true, opts.repeat ?? 1),
    roughnessMap: finishTexture(new THREE.CanvasTexture(rough), renderer, false, opts.repeat ?? 1),
    normalMap: heightToNormal(height, size, opts.normalStrength ?? 2.2, renderer),
  };
}

/** Moulded polymer: pebble stipple, matte in the recesses, sheen on the domes. */
export function makePolymerMaps(renderer, size, seed, tint = { r: 0.24, g: 0.25, b: 0.28 }) {
  const albedo = makeCanvas(size);
  const actx = albedo.getContext('2d');
  const aimg = actx.createImageData(size, size);
  const rough = makeCanvas(size);
  const rctx = rough.getContext('2d');
  const rimg = rctx.createImageData(size, size);
  const height = new Float32Array(size * size);

  // A moulded stipple is a ~1.5 mm feature. Nine cells across a chart that maps
  // to a 4 cm grip lands in the right ballpark; anything finer aliases.
  const cell = 9;
  const cellSize = size / cell;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const cx = Math.floor(x / cellSize);
      const cy = Math.floor(y / cellSize);
      let best = 4;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const gx = cx + ox;
          const gy = cy + oy;
          const px = (gx + hash2(gx, gy, seed)) * cellSize;
          const py = (gy + hash2(gx, gy, seed + 31)) * cellSize;
          const dx = (px - x) / cellSize;
          const dy = (py - y) / cellSize;
          const d = dx * dx + dy * dy;
          if (d < best) best = d;
        }
      }
      const pebble = 1 - Math.min(1, Math.sqrt(best) * 1.9);
      const grain = fbm(u * 6, v * 6, seed + 77, 3);
      const h = pebble * 0.7 + grain * 0.3;
      height[y * size + x] = h;

      const shade = 0.88 + (h - 0.5) * 0.24;
      const i = (y * size + x) * 4;
      aimg.data[i] = Math.min(255, tint.r * shade * 255);
      aimg.data[i + 1] = Math.min(255, tint.g * shade * 255);
      aimg.data[i + 2] = Math.min(255, tint.b * shade * 255);
      aimg.data[i + 3] = 255;

      const rg = clamp(0.82 - pebble * 0.16 + (grain - 0.5) * 0.06, 0.2, 1);
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
    normalMap: heightToNormal(height, size, 3.2, renderer),
  };
}

/** Radial star-burst for the muzzle flash billboard. */
function makeFlashTexture(renderer) {
  const size = 256;
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  const cx = size / 2;

  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createRadialGradient(cx, cx, 0, cx, cx, size * 0.3);
  g.addColorStop(0, 'rgba(255,255,250,1)');
  g.addColorStop(0.35, 'rgba(255,214,140,0.85)');
  g.addColorStop(1, 'rgba(255,120,20,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + 0.2;
    const len = size * (0.2 + hash2(i, 5, 3) * 0.28);
    const wid = size * (0.02 + hash2(i, 9, 3) * 0.045);
    ctx.save();
    ctx.translate(cx, cx);
    ctx.rotate(a);
    const pg = ctx.createLinearGradient(0, 0, len, 0);
    pg.addColorStop(0, 'rgba(255,246,214,0.95)');
    pg.addColorStop(0.5, 'rgba(255,170,60,0.45)');
    pg.addColorStop(1, 'rgba(255,90,10,0)');
    ctx.fillStyle = pg;
    ctx.beginPath();
    ctx.moveTo(0, -wid);
    ctx.lineTo(len, 0);
    ctx.lineTo(0, wid);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  return finishTexture(new THREE.CanvasTexture(c), renderer, true, 1);
}

/** Soft turbulent puff for muzzle smoke. */
function makeSmokeTexture(renderer) {
  const size = 128;
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x / size - 0.5) * 2;
      const dy = (y / size - 0.5) * 2;
      const d = Math.sqrt(dx * dx + dy * dy);
      const n = fbm((x / size) * 5, (y / size) * 5, 404, 4);
      const a = Math.max(0, 1 - d) * (0.35 + n * 0.9);
      const i = (y * size + x) * 4;
      img.data[i] = 214;
      img.data[i + 1] = 216;
      img.data[i + 2] = 222;
      img.data[i + 3] = Math.min(255, a * a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return finishTexture(new THREE.CanvasTexture(c), renderer, true, 1);
}

/** Collimated red-dot reticle: hot core, halo, faint ranging ring. */
function makeReticleTexture(renderer) {
  const size = 128;
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'lighter';
  const cx = size / 2;
  const g = ctx.createRadialGradient(cx, cx, 0, cx, cx, size * 0.11);
  g.addColorStop(0, 'rgba(255,240,235,1)');
  g.addColorStop(0.3, 'rgba(255,60,42,1)');
  g.addColorStop(1, 'rgba(255,20,8,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(255,48,30,0.4)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.arc(cx, cx, size * 0.33, 0, Math.PI * 2);
  ctx.stroke();
  return finishTexture(new THREE.CanvasTexture(c), renderer, true, 1);
}

/* ------------------------------------------------------------------ */
/* Animation maths - hoisted so the per-frame path allocates nothing.  */
/* ------------------------------------------------------------------ */

/** Damped spring toward a 2D target, integrated semi-implicitly. */
export function spring2(cur, vel, target, k, c, dt) {
  vel.x += (target.x - cur.x) * k * dt - vel.x * c * dt;
  vel.y += (target.y - cur.y) * k * dt - vel.y * c * dt;
  cur.x += vel.x * dt;
  cur.y += vel.y * dt;
}

/** Damped spring back to the origin for a 3D offset. */
export function spring3(cur, vel, k, c, dt) {
  vel.x += -cur.x * k * dt - vel.x * c * dt;
  vel.y += -cur.y * k * dt - vel.y * c * dt;
  vel.z += -cur.z * k * dt - vel.z * c * dt;
  cur.addScaledVector(vel, dt);
}

export const sstep = (a, b, x) => {
  const u = clamp((x - a) / (b - a), 0, 1);
  return u * u * (3 - 2 * u);
};

/** 0 -> 1 -> 0 across [a,b]; the backbone of the reload timeline. */
export const pulse = (a, b, x) => {
  const mid = (a + b) * 0.5;
  return sstep(a, mid, x) * (1 - sstep(mid, b, x));
};

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                    */
/* ------------------------------------------------------------------ */

/** Strip anything `mergeGeometries` cannot reconcile, and de-index. */
export function prep(geo) {
  let g = geo;
  if (geo.index) {
    g = geo.toNonIndexed();
    geo.dispose();
  }
  for (const key of Object.keys(g.attributes)) {
    if (key !== 'position' && key !== 'normal' && key !== 'uv') g.deleteAttribute(key);
  }
  return g;
}

/**
 * Drop a primitive into a per-material bucket. Every box here is chamfered -
 * a raw `BoxGeometry` edge reads as programmer art the moment a specular
 * highlight runs along it.
 */
export function place(bucket, geo, x, y, z, rx = 0, ry = 0, rz = 0) {
  const g = prep(geo);
  _eul.set(rx, ry, rz, 'XYZ');
  _q1.setFromEuler(_eul);
  _v1.set(x, y, z);
  _v2.set(1, 1, 1);
  _m4.compose(_v1, _q1, _v2);
  g.applyMatrix4(_m4);
  bucket.push(g);
  return g;
}

export const chamfer = (w, h, d, r = 0.005, seg = 1) =>
  new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2.05, h / 2.05, d / 2.05));

/** Cylinder whose axis runs along Z - the barrel axis of this model. */
export function tubeZ(rTop, rBot, len, seg = 14, open = false) {
  const g = new THREE.CylinderGeometry(rTop, rBot, len, seg, 1, open);
  g.rotateX(Math.PI / 2);
  return g;
}

/** Torus lying in the XY plane, i.e. a ring around the Z (barrel) axis. */
export const ringZ = (radius, thickness, seg = 8, tubular = 20, arc = Math.PI * 2) =>
  new THREE.TorusGeometry(radius, thickness, seg, tubular, arc);

export function mergeBucket(bucket) {
  if (bucket.length === 0) return null;
  const merged = mergeGeometries(bucket, false);
  for (const g of bucket) g.dispose();
  bucket.length = 0;
  if (merged) {
    merged.computeBoundingSphere();
    merged.computeBoundingBox();
  }
  return merged;
}

/* ------------------------------------------------------------------ */
/* Viewmodel depth patch                                               */
/* ------------------------------------------------------------------ */

const VM_DEPTH_CHUNK = `#include <project_vertex>
	{
		// Viewmodel depth compression - see this file's header for the rationale.
		float vmW = max( gl_Position.w, 1e-6 );
		float vmNdc = clamp( gl_Position.z / vmW, -1.0, 1.0 );
		gl_Position.z = ( -1.0 + ( vmNdc + 1.0 ) * 0.00025 ) * vmW;
	}`;

/** Make a material draw inside the near depth slice reserved for the viewmodel. */
export function patchViewmodelDepth(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', VM_DEPTH_CHUNK);
  };
  // Without a distinct cache key three would hand back the unpatched program.
  material.customProgramCacheKey = () => 'aether-viewmodel-depth';
  return material;
}

/* ------------------------------------------------------------------ */

const SPEC = CONFIG.weapon.machinegun;

/** Optical axis of the red-dot in model space; ADS aligns this to screen centre. */
const SIGHT_AXIS_Y = 0.158;
const MUZZLE_Z = -0.598;
const PORT_POS = new THREE.Vector3(0.042, 0.088, -0.045);

/**
 * Uniform scale applied to the model *inside* the pose rig.
 *
 * The weapon is modelled at true size (~0.87 m muzzle to butt pad). Held where
 * a real carbine sits - butt at the shoulder, receiver ~40 cm from the eye -
 * its rear third lands within 15 cm of the near plane and a 75-degree frustum
 * magnifies it until the forearm alone fills the corner of the frame.
 *
 * Scaling the model rather than the rig is the knob that matters: a uniform
 * scale on `root` would be a no-op (both the offset and the geometry would
 * scale, leaving every x/z ratio - and therefore every screen coordinate -
 * unchanged), whereas scaling only the geometry pulls the near extremities away
 * from the eye and shrinks the whole silhouette to the ~22% of frame a
 * first-person weapon should occupy.
 */
export const VM_SCALE = 0.62;

// Lower-right ready pose: the butt stock and firing forearm leave the frame at
// the bottom-right corner, the receiver sits below the crosshair and the muzzle
// rakes back toward screen centre-left.
const HIP_POS = new THREE.Vector3(0.285, -0.215, -0.5);
// Seventeen degrees of yaw plus a slight nose-down pitch and cant turns the
// weapon into profile, so it reads as an object rather than a foreshortened
// tube seen down its own bore.
const HIP_ROT = new THREE.Vector3(-0.075, 0.3, 0.11);
// ADS puts the optical axis exactly on the screen centre. The Z distance is a
// compromise: closer makes the aperture read bigger, but pulls the butt stock
// back toward (and eventually behind) the eye.
const ADS_POS = new THREE.Vector3(0, -SIGHT_AXIS_Y * VM_SCALE, -0.42);
const ADS_ROT = new THREE.Vector3(0, 0, 0);
const LOW_POS = new THREE.Vector3(0.325, -0.315, -0.46);
const LOW_ROT = new THREE.Vector3(-0.42, 0.44, -0.32);

/**
 * Shoulders in view space - the fixed ends of the two solved forearms.
 *
 * Below and behind the eye and outboard of it, which is where shoulders are
 * relative to a head. Both forearms therefore leave the bottom corners of the
 * frame whatever the weapon is doing, including a reload, where the left hand
 * travels a long way from where its arm was modelled.
 */
const RIGHT_SHOULDER = new THREE.Vector3(0.28, -0.44, 0.12);
const LEFT_SHOULDER = new THREE.Vector3(-0.3, -0.44, 0.12);

const CASING_COUNT = 26;
const SMOKE_COUNT = 10;

export class Weapon {
  /**
   * @param {{ scene: THREE.Scene, camera: THREE.PerspectiveCamera,
   *           bus: import('../core/EventBus.js').EventBus, materials: any,
   *           engine: import('../core/Engine.js').Engine, input: any }} ctx
   */
  constructor({ scene, camera, bus, materials, engine, input }) {
    this.scene = scene;
    this.camera = camera;
    this.bus = bus;
    this.materials = materials;
    this.engine = engine;
    this.input = input;
    this.renderer = engine?.renderer ?? null;
    this.name = SPEC.name;

    /* ---- ammunition and fire control ---- */
    this._magazine = SPEC.magazine;
    this._ammo = SPEC.magazine;
    this._reserve = SPEC.reserve;
    this._shotInterval = 60 / SPEC.rpm;
    this._lastShot = -999;
    this._lastDryClick = -999;
    this._reloading = false;
    this._reloadStart = 0;
    this._reloadDuration = SPEC.reloadTime;
    this._enabled = true;

    /* ---- accuracy ---- */
    this._spread = SPEC.spreadBase;
    this._moveSpread = 0;

    /* ---- animation state, all spring/decay driven and frame-rate independent ---- */
    this._time = 0;
    this._aim = 0;
    this._aimTarget = 0;
    this._lowered = 0;
    this._loweredTarget = 0;
    this._bobPhase = 0;
    this._bobWeight = 0;
    this._moveSpeed = 0;
    this._grounded = true;
    this._groundY = 0;
    this._referenceFov = CONFIG.render.fov;

    this._swayPos = new THREE.Vector2();
    this._swayVel = new THREE.Vector2();
    this._swayTarget = new THREE.Vector2();

    this._recoilPos = new THREE.Vector3();
    this._recoilPosVel = new THREE.Vector3();
    this._recoilRot = new THREE.Vector3();
    this._recoilRotVel = new THREE.Vector3();

    /** Camera kick in radians; Player reads this through getRecoilOffset(). */
    this._camKick = { x: 0, y: 0 };
    this._camKickVel = { x: 0, y: 0 };

    this._boltT = 0;
    this._boltCycle = Math.min(this._shotInterval * 0.92, 0.075);
    this._heat = 0;
    this._flashT = 0;
    this._flashRoll = 0;
    this._flashScale = 1;
    this._dryT = 0;

    /**
     * Draw animation, 1 immediately after `onSelect()` and decaying to 0. The
     * loadout can hand control to any weapon at any moment, so the equip dip is
     * a decay rather than a timeline - interrupting it mid-swap is harmless.
     */
    this._equipT = 0;
    /**
     * Guard against being driven twice in one frame. `Player` still calls
     * `update()` on whatever `player.weapon` resolves to, and `Loadout` calls it
     * on the active weapon; running the springs twice would double every rate.
     */
    this._lastUpdateAt = -1;

    this._disposables = [];

    this._buildMaterials();
    this._buildModel();
    this._buildEffects();
    this._buildCasingPool();
    this._buildSmokePool();

    // `Engine` never parents its camera to the scene, and the renderer only
    // traverses scene descendants - so a camera-attached viewmodel would be
    // silently culled. Adding the camera is inert for everything else: it has
    // no geometry, and PostFX still receives it as an explicit argument.
    if (!this.camera.parent) this.scene.add(this.camera);
    this.camera.add(this.root);
    this._emitAmmo();
  }

  /* ================================================================ */
  /* Materials                                                         */
  /* ================================================================ */

  _buildMaterials() {
    const r = this.renderer;

    // A metal's base colour is its specular tint, not a diffuse albedo - a value
    // down at 0.15 turns steel into charcoal. Blued gunmetal sits around 0.45.
    const steel = makeMetalMaps(r, 512, 17, {
      r: 0.46,
      g: 0.48,
      b: 0.53,
      roughness: 0.4,
      scratches: 22,
      repeat: 1,
    });
    const polymer = makePolymerMaps(r, 256, 91);
    const brass = makeMetalMaps(r, 128, 55, {
      r: 0.62,
      g: 0.45,
      b: 0.16,
      roughness: 0.3,
      scratches: 6,
      repeat: 1,
      normalStrength: 1.6,
    });
    this._maps = { steel, polymer, brass };

    /** Blued receiver steel - the bulk of the weapon. */
    this.matBody = patchViewmodelDepth(
      new THREE.MeshStandardMaterial({
        name: 'weapon.gunmetal',
        color: new THREE.Color(0x8f96a2),
        map: steel.map,
        normalMap: steel.normalMap,
        roughnessMap: steel.roughnessMap,
        metalness: 0.92,
        roughness: 1,
        normalScale: new THREE.Vector2(0.32, 0.32),
        envMapIntensity: 1.15,
      })
    );

    /** Barrel and shroud carry the heat emissive, so they need their own instance. */
    this.matBarrel = patchViewmodelDepth(
      new THREE.MeshStandardMaterial({
        name: 'weapon.barrel',
        color: new THREE.Color(0x6e747f),
        map: steel.map,
        normalMap: steel.normalMap,
        roughnessMap: steel.roughnessMap,
        metalness: 0.95,
        roughness: 1,
        normalScale: new THREE.Vector2(0.4, 0.4),
        emissive: new THREE.Color(0x000000),
        emissiveIntensity: 1,
        envMapIntensity: 1.3,
      })
    );

    /** Moulded polymer furniture: grips, butt pad, magazine body. */
    this.matPolymer = patchViewmodelDepth(
      new THREE.MeshStandardMaterial({
        name: 'weapon.polymer',
        color: new THREE.Color(0x656b74),
        map: polymer.map,
        normalMap: polymer.normalMap,
        roughnessMap: polymer.roughnessMap,
        metalness: 0.04,
        roughness: 1,
        normalScale: new THREE.Vector2(0.45, 0.45),
      })
    );

    /** Faction accent: anodised amber with a faint self-glow so it reads in shade. */
    this.matAccent = patchViewmodelDepth(
      new THREE.MeshStandardMaterial({
        name: 'weapon.accent',
        color: new THREE.Color(0xc9711b),
        map: steel.map,
        normalMap: steel.normalMap,
        roughnessMap: steel.roughnessMap,
        metalness: 0.7,
        roughness: 1,
        normalScale: new THREE.Vector2(0.32, 0.32),
        // Kept low: the accent should glint, not glow like a light source.
        emissive: new THREE.Color(0.28, 0.095, 0.015),
        emissiveIntensity: 0.55,
        envMapIntensity: 1.1,
      })
    );

    this.matGlove = patchViewmodelDepth(
      new THREE.MeshStandardMaterial({
        name: 'weapon.glove',
        // Tactical glove: desaturated leather brown, so the hands read as hands
        // against the cool grey of the receiver rather than as more gun.
        color: new THREE.Color(0x7d6a5a),
        map: polymer.map,
        normalMap: polymer.normalMap,
        roughnessMap: polymer.roughnessMap,
        metalness: 0.03,
        roughness: 1,
        normalScale: new THREE.Vector2(0.35, 0.35),
      })
    );

    this.matGlass = patchViewmodelDepth(
      new THREE.MeshStandardMaterial({
        name: 'weapon.sightglass',
        color: new THREE.Color(0x123039),
        metalness: 0.1,
        roughness: 0.05,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
        side: THREE.DoubleSide,
        envMapIntensity: 2.5,
      })
    );

    this.matBrass = new THREE.MeshStandardMaterial({
      name: 'weapon.brass',
      color: new THREE.Color(0xd8a24a),
      map: brass.map,
      normalMap: brass.normalMap,
      roughnessMap: brass.roughnessMap,
      metalness: 1,
      roughness: 1,
      envMapIntensity: 1.4,
    });

    for (const m of [
      this.matBody,
      this.matBarrel,
      this.matPolymer,
      this.matAccent,
      this.matGlove,
      this.matGlass,
      this.matBrass,
    ]) {
      this._disposables.push(m);
    }
    for (const set of [steel, polymer, brass]) {
      this._disposables.push(set.map, set.normalMap, set.roughnessMap);
    }

    this.materials?.register?.('weapon.gunmetal', this.matBody);
    this.materials?.register?.('weapon.polymer', this.matPolymer);
    this.materials?.register?.('weapon.accent', this.matAccent);
    this.materials?.register?.('weapon.brass', this.matBrass);
  }

  /* ================================================================ */
  /* Model                                                             */
  /* ================================================================ */

  /**
   * Build the weapon out of chamfered primitives, then merge everything that
   * does not animate into one mesh per material. The finished viewmodel is
   * ~13 draw calls including the hands and the sight glass.
   */
  _buildModel() {
    /** Attached to the camera; carries the ADS/hip/sprint pose. */
    this.root = new THREE.Group();
    this.root.name = 'viewmodel';
    this.root.matrixAutoUpdate = true;

    /** Child of root; carries recoil, sway and bob so the pose stays readable. */
    this._model = new THREE.Group();
    this._model.name = 'viewmodel:model';
    this._model.scale.setScalar(VM_SCALE);
    this.root.add(this._model);

    const body = [];
    const barrel = [];
    const poly = [];
    const accent = [];
    const glove = [];

    this._buildReceiver(body, accent);
    this._buildRail(body, accent);
    this._buildBarrelGroup(barrel, body, accent);
    this._buildFurniture(poly, body, accent);
    this._buildStock(body, poly, accent);
    this._buildSight(body, accent);

    // Hands. The right hand is welded to the pistol grip; the left rides the
    // foregrip but detaches during the reload to fetch the magazine.
    const rightWrist = new THREE.Vector3();
    this._buildHand(glove, accent, 1, {
      x: 0.0,
      y: -0.086,
      z: 0.05,
      pitch: 0.34,
      gripHalf: 0.021,
      wristOut: rightWrist,
    });

    this._staticMeshes = [];
    const addMerged = (bucket, material, name) => {
      const geo = mergeBucket(bucket);
      if (!geo) return null;
      const mesh = new THREE.Mesh(geo, material);
      mesh.name = `viewmodel:${name}`;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 100;
      this._model.add(mesh);
      this._staticMeshes.push(mesh);
      return mesh;
    };

    addMerged(body, this.matBody, 'body');
    this._barrelMesh = addMerged(barrel, this.matBarrel, 'barrel');
    addMerged(poly, this.matPolymer, 'polymer');
    addMerged(accent, this.matAccent, 'accent');
    addMerged(glove, this.matGlove, 'hand-right');

    this._buildMagazine();
    this._buildBolt();
    this._buildLeftHand();

    // Forearms, solved rather than baked. The right one hangs off the model
    // (the firing hand never leaves the grip); the left hangs off `_leftHand`,
    // which the reload drives away from the foregrip - so its elbow now stays
    // put while the hand goes to the magazine, instead of the whole arm
    // swinging with it.
    this._rightWrist = new THREE.Object3D();
    this._rightWrist.position.copy(rightWrist);
    this._model.add(this._rightWrist);

    this._rightArm = new ViewArm({
      parent: this.root,
      wrist: this._rightWrist,
      anchor: RIGHT_SHOULDER,
      sleeve: this.matGlove,
      band: this.matAccent,
      wristRadius: 0.016,
      taper: 1.55,
      minEyeDistance: 0.34,
      name: 'viewmodel:arm-right',
    });
    this._leftArm = new ViewArm({
      parent: this.root,
      wrist: this._leftWrist,
      anchor: LEFT_SHOULDER,
      sleeve: this.matGlove,
      band: this.matAccent,
      wristRadius: 0.016,
      taper: 1.55,
      minEyeDistance: 0.34,
      name: 'viewmodel:arm-left',
    });
  }

  _buildReceiver(body, accent) {
    // Lower receiver + magwell.
    place(body, chamfer(0.07, 0.1, 0.3, 0.011, 2), 0, 0.012, -0.055);
    place(body, chamfer(0.058, 0.05, 0.078, 0.009, 2), 0, -0.05, -0.018);
    // Upper receiver / bolt housing.
    place(body, chamfer(0.062, 0.05, 0.272, 0.013, 2), 0, 0.078, -0.065);
    // Rear plate and buffer housing.
    place(body, chamfer(0.072, 0.098, 0.024, 0.007, 2), 0, 0.014, 0.098);
    place(body, chamfer(0.05, 0.052, 0.06, 0.012, 2), 0, 0.045, 0.12);

    // Ejection port: a raised surround with a recessed, darker interior wall.
    place(body, chamfer(0.007, 0.042, 0.108, 0.003), 0.0335, 0.086, -0.045);
    place(body, chamfer(0.004, 0.03, 0.086, 0.001), 0.0295, 0.086, -0.045);
    // Brass deflector behind the port.
    place(body, chamfer(0.018, 0.03, 0.02, 0.006), 0.036, 0.093, 0.016, 0, 0, -0.5);
    // Dust-cover hinge pin.
    place(body, tubeZ(0.0035, 0.0035, 0.1, 8), 0.037, 0.066, -0.045);

    // Left-side controls: fire selector and bolt catch.
    place(body, new THREE.CylinderGeometry(0.011, 0.011, 0.008, 12).rotateZ(Math.PI / 2), -0.037, -0.01, 0.03);
    place(accent, chamfer(0.008, 0.01, 0.028, 0.003), -0.043, -0.01, 0.022, 0, 0, 0.25);
    place(body, chamfer(0.007, 0.018, 0.03, 0.003), -0.036, 0.04, -0.038);

    // Machined lightening cuts along both flanks.
    for (let i = 0; i < 3; i++) {
      const z = -0.14 + i * 0.055;
      place(accent, chamfer(0.004, 0.012, 0.04, 0.0015), 0.036, 0.032, z);
      place(accent, chamfer(0.004, 0.012, 0.04, 0.0015), -0.036, 0.032, z);
    }
    // Ammo-counter strip on the left flank.
    place(accent, chamfer(0.004, 0.016, 0.05, 0.0015), -0.0365, 0.005, 0.015);

    // Trigger group.
    const guard = ringZ(0.03, 0.0045, 6, 20, Math.PI * 1.25);
    guard.rotateZ(Math.PI * 0.9);
    guard.rotateY(Math.PI / 2);
    place(body, guard, 0, -0.028, -0.006);
    place(body, chamfer(0.009, 0.03, 0.012, 0.003), 0, -0.032, -0.006, 0.16);
    // Trigger-guard tie-in so it does not float.
    place(body, chamfer(0.01, 0.014, 0.016, 0.003), 0, -0.048, -0.03);
  }

  _buildRail(body, accent) {
    // Picatinny top rail: base bar plus discrete cross-slots.
    place(body, chamfer(0.026, 0.014, 0.31, 0.003), 0, 0.107, -0.11);
    for (let i = 0; i < 16; i++) {
      const z = -0.255 + i * 0.019;
      place(body, chamfer(0.029, 0.008, 0.0065, 0.0015), 0, 0.1145, z);
    }
    // Side rail sections at the handguard.
    place(accent, chamfer(0.008, 0.014, 0.09, 0.002), 0.031, 0.03, -0.26);
    place(accent, chamfer(0.008, 0.014, 0.09, 0.002), -0.031, 0.03, -0.26);
  }

  _buildBarrelGroup(barrel, body, accent) {
    // Barrel proper, tapering forward.
    place(barrel, tubeZ(0.0135, 0.0165, 0.45, 18), 0, 0, -0.295);
    place(barrel, tubeZ(0.02, 0.02, 0.03, 18), 0, 0, -0.1);

    // Vented heat shroud: inner tube visible through the gaps between six ribs
    // and four bracing rings. Modelled rather than faked with an alpha texture.
    place(barrel, tubeZ(0.0245, 0.0245, 0.235, 18, true), 0, 0, -0.325);
    for (let i = 0; i < 4; i++) {
      place(barrel, ringZ(0.0335, 0.0055, 6, 22), 0, 0, -0.215 - i * 0.072);
    }
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.26;
      place(
        barrel,
        chamfer(0.0095, 0.009, 0.232, 0.002),
        Math.sin(a) * 0.0335,
        Math.cos(a) * 0.0335,
        -0.325,
        0,
        0,
        -a
      );
    }

    // Gas block and gas tube.
    place(barrel, chamfer(0.032, 0.04, 0.055, 0.006, 2), 0, 0.026, -0.462);
    place(barrel, tubeZ(0.005, 0.005, 0.12, 8), 0, 0.03, -0.4);
    place(accent, chamfer(0.026, 0.008, 0.012, 0.002), 0, 0.048, -0.462);

    // Muzzle brake with three compensator ports and a crowned tip.
    place(barrel, tubeZ(0.024, 0.021, 0.066, 16), 0, 0, -0.555);
    for (let i = 0; i < 3; i++) {
      place(barrel, chamfer(0.054, 0.008, 0.009, 0.002), 0, 0, -0.535 - i * 0.018);
    }
    place(accent, ringZ(0.0215, 0.0035, 6, 18), 0, 0, -0.5885);
    // Front sling loop.
    const loop = ringZ(0.011, 0.003, 6, 14);
    loop.rotateY(Math.PI / 2);
    place(body, loop, -0.032, -0.028, -0.235);
  }

  _buildFurniture(poly, body, accent) {
    // Angled foregrip.
    place(poly, chamfer(0.036, 0.108, 0.048, 0.012, 2), 0, -0.078, -0.3, -0.2);
    place(poly, chamfer(0.042, 0.02, 0.052, 0.008, 2), 0, -0.132, -0.288, -0.2);
    for (let i = 0; i < 3; i++) {
      const g = ringZ(0.019, 0.0035, 5, 14);
      g.rotateX(Math.PI / 2);
      place(poly, g, 0, -0.055 - i * 0.026, -0.295 - i * 0.006, -0.2);
    }
    // Handguard collar tying the foregrip into the shroud.
    place(body, chamfer(0.05, 0.05, 0.03, 0.008, 2), 0, -0.03, -0.235);

    // Pistol grip with palm swell and finger grooves.
    place(poly, chamfer(0.04, 0.125, 0.058, 0.014, 2), 0, -0.088, 0.05, 0.34);
    place(poly, chamfer(0.046, 0.05, 0.05, 0.02, 2), 0, -0.07, 0.062, 0.34);
    place(accent, chamfer(0.044, 0.012, 0.05, 0.004), 0, -0.148, 0.072, 0.34);
    for (let i = 0; i < 3; i++) {
      const g = ringZ(0.021, 0.0035, 5, 14);
      g.rotateX(Math.PI / 2);
      place(poly, g, 0, -0.07 - i * 0.026, 0.041 - i * 0.009, 0.34);
    }
  }

  _buildStock(body, poly, accent) {
    // Twin-tube skeleton stock.
    for (const sx of [-1, 1]) {
      place(body, tubeZ(0.0105, 0.0105, 0.17, 10), sx * 0.024, 0.032, 0.175);
    }
    place(body, chamfer(0.072, 0.018, 0.02, 0.005), 0, 0.032, 0.245);
    place(body, chamfer(0.05, 0.05, 0.022, 0.007), 0, 0.032, 0.115);

    // Cheek riser and recoil pad.
    place(poly, chamfer(0.034, 0.028, 0.12, 0.009, 2), 0, 0.088, 0.175);
    place(poly, chamfer(0.054, 0.118, 0.03, 0.01, 2), 0, 0.018, 0.256, -0.06);
    place(accent, chamfer(0.05, 0.014, 0.014, 0.004), 0, -0.036, 0.252, -0.06);

    // Rear sling loop.
    const loop = ringZ(0.011, 0.003, 6, 14);
    loop.rotateY(Math.PI / 2);
    place(body, loop, -0.03, 0.005, 0.105);
  }

  /**
   * Combat optic. The housing is four bars around an open aperture rather than
   * a solid block - a closed box would occlude the lens and the reticle, which
   * is the whole point of the sight.
   */
  _buildSight(body, accent) {
    const y = SIGHT_AXIS_Y;
    const outW = 0.07;
    const outH = 0.066;
    const bar = 0.011;
    const depth = 0.075;
    const z = -0.124;

    // Riser tying the optic to the rail.
    place(body, chamfer(0.036, 0.028, 0.052, 0.005, 2), 0, 0.12, -0.115);

    // Aperture frame.
    place(body, chamfer(outW, bar, depth, 0.004, 2), 0, y + (outH - bar) * 0.5, z);
    place(body, chamfer(outW, bar, depth, 0.004, 2), 0, y - (outH - bar) * 0.5, z);
    place(body, chamfer(bar, outH - bar * 2, depth, 0.004, 2), (outW - bar) * 0.5, y, z);
    place(body, chamfer(bar, outH - bar * 2, depth, 0.004, 2), -(outW - bar) * 0.5, y, z);

    // Elevation and windage turrets.
    place(body, new THREE.CylinderGeometry(0.0095, 0.0095, 0.016, 12), 0, y + 0.04, z);
    place(
      body,
      new THREE.CylinderGeometry(0.0095, 0.0095, 0.016, 12).rotateZ(Math.PI / 2),
      0.042,
      y,
      z
    );
    // Emitter housing hanging inside the top bar - a red dot needs a source.
    place(accent, chamfer(0.012, 0.008, 0.016, 0.002), 0, y + 0.021, z - 0.024);

    // Objective hood and rear ocular ring.
    place(accent, ringZ(0.0255, 0.0035, 6, 24), 0, y, z - depth * 0.5 - 0.002);
    place(body, ringZ(0.0245, 0.003, 6, 24), 0, y, z + depth * 0.5 + 0.002);

    /** Tinted objective lens; drawn after the frame so its coating reads. */
    const glass = new THREE.Mesh(new THREE.CircleGeometry(0.0225, 28), this.matGlass);
    glass.position.set(0, y, z - depth * 0.5 + 0.004);
    glass.renderOrder = 110;
    glass.castShadow = false;
    glass.frustumCulled = false;
    this._model.add(glass);
    this._glass = glass;
    this._disposables.push(glass.geometry);
  }

  /**
   * A gloved, lightly armoured hand. Built as loose primitives rather than a
   * skinned mesh - at viewmodel scale the silhouette is what sells it, and a
   * badly deformed realistic hand looks far worse than a stylised gauntlet.
   */
  _buildHand(outGlove, outPlate, side, cfg) {
    const g = cfg.gripHalf;
    // Local buckets: the whole hand is baked into the grip frame at the end, so
    // it must not share a bucket with parts that are already in model space.
    const glove = [];
    const plate = [];
    const px = (v) => side * v;

    // Palm and back-of-hand armour.
    place(glove, chamfer(0.026, 0.09, 0.064, 0.014, 2), px(g + 0.014), 0.006, 0.004);
    place(plate, chamfer(0.014, 0.056, 0.05, 0.009, 2), px(g + 0.03), 0.024, -0.002);
    place(plate, chamfer(0.016, 0.022, 0.03, 0.006), px(g + 0.03), 0.058, 0.024);

    // Four fingers curling around the front of the grip.
    for (let i = 0; i < 4; i++) {
      const y = 0.032 - i * 0.023;
      const rad = 0.0098 - i * 0.0008;
      const a = new THREE.CylinderGeometry(rad, rad * 0.96, 0.046, 8).rotateZ(Math.PI / 2);
      place(glove, a, px(g * 0.25), y, -(g + 0.016));
      const b = new THREE.CylinderGeometry(rad * 0.94, rad * 0.85, 0.032, 8).rotateZ(Math.PI / 2);
      place(glove, b, px(-(g * 0.55)), y - 0.004, -(g + 0.007), 0, px(0.6));
      // Knuckle caps.
      place(plate, chamfer(0.012, 0.014, 0.014, 0.005), px(g + 0.018), y + 0.002, -(g + 0.012));
    }

    // Thumb crossing the rear of the grip.
    const thumb = new THREE.CylinderGeometry(0.0105, 0.0095, 0.05, 8).rotateZ(Math.PI / 2);
    place(glove, thumb, px(g * 0.2), 0.03, g + 0.015, 0, px(-0.35));

    // Cuff only. The forearm itself is no longer baked here: it is solved every
    // frame from a fixed shoulder anchor (see `ViewArm`), so the elbow stays
    // where a shoulder is instead of rotating rigidly with the weapon. The
    // baked version was posed for the hip stance and had to be, since it could
    // not move independently; the left arm in particular then swung with the
    // magazine during a reload, which is the one animation where the hand
    // demonstrably leaves the gun.
    const ARM = 2.0; // radians about X: down (-Y) and back (+Z) from the wrist
    place(
      glove,
      new THREE.CylinderGeometry(0.034, 0.031, 0.06, 14),
      px(g + 0.02),
      0.04,
      0.062,
      ARM
    );
    place(plate, chamfer(0.048, 0.02, 0.052, 0.008, 2), px(g + 0.033), 0.05, 0.055, ARM);

    // Bake the whole hand into the grip's frame, then hand it to the caller.
    const m = new THREE.Matrix4().compose(
      _v1.set(cfg.x, cfg.y, cfg.z),
      _q1.setFromEuler(_eul.set(cfg.pitch, 0, 0, 'XYZ')),
      _v2.set(1, 1, 1)
    );

    // Where the solved forearm starts. Just past the cuff, along the same
    // down-and-back axis the cuff is rotated to, then carried through `m` so
    // the caller gets it in model space - the geometry itself is merged away,
    // so this is the only surviving record of where the wrist ended up.
    if (cfg.wristOut) {
      cfg.wristOut
        .set(px(g + 0.024), 0.04 + Math.cos(ARM) * 0.03, 0.062 + Math.sin(ARM) * 0.03)
        .applyMatrix4(m);
    }
    for (const geo of glove) {
      geo.applyMatrix4(m);
      outGlove.push(geo);
    }
    for (const geo of plate) {
      geo.applyMatrix4(m);
      outPlate.push(geo);
    }
  }

  /** Left hand lives on its own pivot so the reload can pull it off the grip. */
  _buildLeftHand() {
    const glove = [];
    const plate = [];
    const wrist = new THREE.Vector3();
    this._buildHand(glove, plate, -1, {
      x: 0,
      y: -0.078,
      z: -0.3,
      pitch: -0.2,
      gripHalf: 0.02,
      wristOut: wrist,
    });

    this._leftHand = new THREE.Group();
    this._leftHand.name = 'viewmodel:hand-left';
    this._model.add(this._leftHand);

    // Child of the pivot, so it travels with the hand through the reload.
    this._leftWrist = new THREE.Object3D();
    this._leftWrist.position.copy(wrist);
    this._leftHand.add(this._leftWrist);

    for (const [bucket, mat, name] of [
      [glove, this.matGlove, 'glove'],
      [plate, this.matAccent, 'plate'],
    ]) {
      const geo = mergeBucket(bucket);
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `viewmodel:hand-left-${name}`;
      mesh.castShadow = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 100;
      this._leftHand.add(mesh);
    }
  }

  /** Detachable magazine on its own pivot for the reload animation. */
  _buildMagazine() {
    const poly = [];
    const accent = [];

    place(poly, chamfer(0.05, 0.072, 0.032, 0.007, 2), 0, -0.036, 0);
    place(poly, chamfer(0.049, 0.072, 0.032, 0.007, 2), 0, -0.102, 0.011, -0.17);
    place(poly, chamfer(0.047, 0.058, 0.032, 0.007, 2), 0, -0.164, 0.032, -0.34);
    place(accent, chamfer(0.054, 0.013, 0.038, 0.004), 0, -0.196, 0.043, -0.34);
    // Translucent-look witness strip.
    place(accent, chamfer(0.005, 0.088, 0.012, 0.002), 0.0245, -0.09, 0.008, -0.17);
    place(accent, chamfer(0.005, 0.088, 0.012, 0.002), -0.0245, -0.09, 0.008, -0.17);

    this._magPivot = new THREE.Group();
    this._magPivot.name = 'viewmodel:magazine';
    this._magPivot.position.set(0, -0.048, -0.012);
    this._model.add(this._magPivot);

    for (const [bucket, mat] of [
      [poly, this.matPolymer],
      [accent, this.matAccent],
    ]) {
      const geo = mergeBucket(bucket);
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 100;
      this._magPivot.add(mesh);
    }
  }

  /** Reciprocating bolt carrier plus the charging handle that rides with it. */
  _buildBolt() {
    const body = [];
    place(body, chamfer(0.05, 0.03, 0.09, 0.006, 2), 0, 0, 0);
    place(body, chamfer(0.03, 0.016, 0.018, 0.004), 0, 0.02, -0.05);
    const geo = mergeBucket(body);
    this._bolt = new THREE.Mesh(geo, this.matBody);
    this._bolt.name = 'viewmodel:bolt';
    this._bolt.position.set(0, 0.082, -0.06);
    this._bolt.castShadow = false;
    this._bolt.frustumCulled = false;
    this._bolt.renderOrder = 99; // behind the receiver walls
    this._model.add(this._bolt);

    const ch = [];
    const chAccent = [];
    place(ch, chamfer(0.034, 0.013, 0.05, 0.004), -0.012, 0, 0);
    place(chAccent, chamfer(0.016, 0.03, 0.034, 0.006, 2), -0.032, 0, 0.006);
    this._chargeHandle = new THREE.Group();
    this._chargeHandle.name = 'viewmodel:charging-handle';
    this._chargeHandle.position.set(-0.038, 0.09, -0.02);
    this._model.add(this._chargeHandle);
    for (const [bucket, mat] of [
      [ch, this.matBody],
      [chAccent, this.matAccent],
    ]) {
      const g = mergeBucket(bucket);
      if (!g) continue;
      const mesh = new THREE.Mesh(g, mat);
      mesh.castShadow = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 100;
      this._chargeHandle.add(mesh);
    }
  }

  /* ================================================================ */
  /* Effects                                                           */
  /* ================================================================ */

  _buildEffects() {
    const r = this.renderer;

    /* --- red-dot reticle ------------------------------------------ */
    const reticleTex = makeReticleTexture(r);
    this._reticleMat = patchViewmodelDepth(
      new THREE.MeshBasicMaterial({
        map: reticleTex,
        transparent: true,
        blending: THREE.AdditiveBlending,
        // Depth-tested (so the housing occludes it when the weapon is canted)
        // but never depth-writing. World geometry can never win, because the
        // depth patch puts the whole viewmodel in the near slice.
        depthTest: true,
        depthWrite: false,
        toneMapped: false,
        opacity: 0.9,
      })
    );
    this._reticle = new THREE.Mesh(new THREE.PlaneGeometry(0.042, 0.042), this._reticleMat);
    this._reticle.position.set(0, SIGHT_AXIS_Y, -0.1555);
    this._reticle.renderOrder = 130;
    this._reticle.frustumCulled = false;
    this._model.add(this._reticle);
    this._disposables.push(reticleTex, this._reticleMat, this._reticle.geometry);

    /* --- muzzle flash --------------------------------------------- */
    const flashTex = makeFlashTexture(r);
    this._flashMat = patchViewmodelDepth(
      new THREE.MeshBasicMaterial({
        map: flashTex,
        color: new THREE.Color(1, 0.86, 0.62),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        opacity: 0,
      })
    );
    this._flashGroup = new THREE.Group();
    this._flashGroup.position.set(0, 0, MUZZLE_Z - 0.02);
    this._flashGroup.visible = false;
    this._model.add(this._flashGroup);

    // Camera-facing burst plus a forward-raked fan, so the flash has volume
    // instead of reading as a sticker on the muzzle.
    const face = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.42), this._flashMat);
    face.renderOrder = 140;
    face.frustumCulled = false;
    const fan = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.34), this._flashMat);
    fan.rotation.x = Math.PI / 2;
    fan.position.z = -0.06;
    fan.renderOrder = 140;
    fan.frustumCulled = false;
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.026, 1), this._flashMat);
    core.renderOrder = 141;
    core.frustumCulled = false;
    this._flashGroup.add(face, fan, core);
    this._flashFace = face;
    this._disposables.push(flashTex, this._flashMat, face.geometry, fan.geometry, core.geometry);

    /**
     * Brief point light so the flash actually lights the room.
     *
     * It is NOT added to `_model`: `setVisible(false)` hides `root`, and a
     * light under a hidden ancestor is skipped by `projectObject`, which drops
     * the renderer's point-light count and recompiles every program in the
     * scene. Measured: switching off the machine gun in the sports world
     * rebuilt 71 programs and froze the next frame for 24 s. The light is
     * pinned to the always-visible fill rig instead and follows a muzzle
     * anchor - see gfx/LightAnchor.js.
     */
    this._flashLight = new THREE.PointLight(0xffb066, 0, 9, 2);
    this._flashLight.castShadow = false;

    /* --- viewmodel fill rig ---------------------------------------- */
    // Two very short-range lights keep the weapon readable in dark interiors
    // without noticeably lighting the world (decay 2, distance ~1.5 m). The
    // gloves are the reason they are not weaker still: a dielectric surface in
    // a metal-heavy silhouette needs a diffuse source or it reads as more gun.
    this._lightRig = new THREE.Group();
    this._lightRig.name = 'viewmodel:lights';
    const key = new THREE.PointLight(0xc5d8ff, 1.1, 1.5, 2);
    key.position.set(0.42, 0.3, 0.12);
    const rim = new THREE.PointLight(0xffb583, 0.6, 1.3, 2);
    rim.position.set(-0.35, -0.12, -0.55);
    key.castShadow = false;
    rim.castShadow = false;
    key.userData.baseIntensity = key.intensity;
    rim.userData.baseIntensity = rim.intensity;
    this._rigLights = [key, rim];
    this._lightRig.add(key, rim);
    this.camera.add(this._lightRig);

    // Muzzle flash light lives in the rig, tracks an anchor at the muzzle.
    this._flashAnchored = anchorLight(
      this._flashLight, this._lightRig, this._model, { x: 0, y: 0, z: MUZZLE_Z }
    );
  }

  /**
   * Shell casings live in world space so they keep their momentum when the
   * player turns. One InstancedMesh, no allocation after construction.
   */
  _buildCasingPool() {
    const parts = [];
    place(parts, tubeZ(0.0044, 0.0049, 0.023, 8), 0, 0, 0);
    place(parts, ringZ(0.0049, 0.0012, 5, 10), 0, 0, 0.0115);
    const geo = mergeBucket(parts);

    this._casings = new THREE.InstancedMesh(geo, this.matBrass, CASING_COUNT);
    this._casings.name = 'weapon:casings';
    this._casings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._casings.frustumCulled = false;
    this._casings.castShadow = false;
    this._casings.receiveShadow = false;
    this._casingState = {
      pos: new Float32Array(CASING_COUNT * 3),
      vel: new Float32Array(CASING_COUNT * 3),
      spin: new Float32Array(CASING_COUNT * 3),
      quat: new Float32Array(CASING_COUNT * 4),
      life: new Float32Array(CASING_COUNT),
      ground: new Float32Array(CASING_COUNT),
      next: 0,
      active: 0,
    };
    // Park every instance at zero scale until it is fired.
    _m4.makeScale(0, 0, 0);
    for (let i = 0; i < CASING_COUNT; i++) this._casings.setMatrixAt(i, _m4);
    this._casings.instanceMatrix.needsUpdate = true;
    this.scene.add(this._casings);
    this._disposables.push(geo);
  }

  _buildSmokePool() {
    const tex = makeSmokeTexture(this.renderer);
    this._smokeGeo = new THREE.PlaneGeometry(1, 1);
    this._smoke = [];
    for (let i = 0; i < SMOKE_COUNT; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        opacity: 0,
        color: new THREE.Color(0.6, 0.6, 0.64),
      });
      const mesh = new THREE.Mesh(this._smokeGeo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 5;
      mesh.userData.vel = new THREE.Vector3();
      mesh.userData.life = 0;
      mesh.userData.maxLife = 1;
      mesh.userData.size = 0.1;
      this.scene.add(mesh);
      this._smoke.push(mesh);
      this._disposables.push(mat);
    }
    this._smokeNext = 0;
    this._disposables.push(tex, this._smokeGeo);
  }

  /* ================================================================ */
  /* Per-frame                                                         */
  /* ================================================================ */

  /**
   * Context supplied by Player once per frame. Keeping this one call means the
   * weapon never has to reach back into the player or the input layer.
   * @param {{ referenceFov:number, moveSpeed:number, grounded:boolean,
   *           lookDeltaX:number, lookDeltaY:number, groundY:number,
   *           velocity:THREE.Vector3, bobPhase:number, bobWeight:number }} ctx
   */
  setViewContext(ctx) {
    this._referenceFov = ctx.referenceFov;
    this._moveSpeed = ctx.moveSpeed;
    this._grounded = ctx.grounded;
    this._groundY = ctx.groundY;
    this._bobPhase = ctx.bobPhase;
    this._bobWeight = ctx.bobWeight;
    this._playerVelocity = ctx.velocity;
    // Sway trails the look input; feeding angular velocity (not raw delta)
    // keeps the feel identical at 60 and 144 Hz.
    const dt = Math.max(ctx.dt ?? 1 / 60, 1e-4);
    this._swayTarget.set(
      clamp((-ctx.lookDeltaX / dt) * 0.011, -0.075, 0.075),
      clamp((ctx.lookDeltaY / dt) * 0.009, -0.06, 0.06)
    );
  }

  /** Aim-down-sights toggle. */
  setAim(on) {
    this._aimTarget = on ? 1 : 0;
  }

  /** Stow the weapon (sprinting, dead, chatting). */
  setLowered(on) {
    this._loweredTarget = on ? 1 : 0;
  }

  setEnabled(on) {
    this._enabled = on;
  }

  /**
   * Show/hide the whole viewmodel - used by the screenshot harness and by the
   * loadout when this weapon is stowed.
   *
   * The fill rig is dimmed rather than hidden: flipping a light's `visible` flag
   * changes the renderer's light count, which invalidates and recompiles every
   * program in the scene. That is a visible hitch on every weapon switch, and a
   * zero-intensity light costs a few ALU ops instead.
   */
  setVisible(on) {
    this.root.visible = on;
    for (const l of this._rigLights) l.intensity = on ? l.userData.baseIntensity : 0;
    // The muzzle light is parented to the camera rig, so hiding `root` no
    // longer hides it - darken it explicitly or a stowed gun keeps glowing.
    if (!on) {
      this._flashT = 0;
      this._flashLight.intensity = 0;
    }
  }

  update(dt, elapsed) {
    this._time = elapsed;
    if (dt <= 0) return;
    // See `_lastUpdateAt`: idempotent per engine frame.
    if (elapsed === this._lastUpdateAt) return;
    this._lastUpdateAt = elapsed;

    this._equipT = Math.max(0, this._equipT - dt * 3.4);

    let reloadT = -1;
    if (this._reloading) {
      reloadT = (elapsed - this._reloadStart) / this._reloadDuration;
      if (reloadT >= 1) {
        this._finishReload();
        reloadT = -1;
      }
    }

    // Cone of fire tightens back toward the base value.
    this._spread = Math.max(SPEC.spreadBase, this._spread - SPEC.spreadRecovery * dt);
    this._moveSpread = (this._moveSpeed / 9) * 0.012 + (this._grounded ? 0 : 0.016);

    this._heat = Math.max(0, this._heat - dt * 0.2);
    this._applyHeat(elapsed);

    this._aim = damp(this._aim, this._reloading ? 0 : this._aimTarget, 13, dt);
    this._lowered = damp(this._lowered, this._reloading ? 0 : this._loweredTarget, 9, dt);

    if (this._boltT > 0) this._boltT = Math.max(0, this._boltT - dt / this._boltCycle);
    this._dryT = Math.max(0, this._dryT - dt * 7);

    this._integrateSprings(dt);
    this._updatePose(elapsed, reloadT);
    this._updateFlash(dt);
    this._updateCasings(dt);
    this._updateSmoke(dt);
  }

  /** Critically-ish damped springs. dt is capped so a hitch cannot detonate them. */
  _integrateSprings(dtRaw) {
    const dt = Math.min(dtRaw, 1 / 40);
    spring2(this._swayPos, this._swayVel, this._swayTarget, 110, 15, dt);
    spring2(this._camKick, this._camKickVel, ZERO2, 78, 12.5, dt);
    spring3(this._recoilPos, this._recoilPosVel, 210, 22, dt);
    spring3(this._recoilRot, this._recoilRotVel, 230, 21, dt);
  }

  _applyHeat(elapsed) {
    const h = this._heat;
    if (h <= 0.001) {
      if (this.matBarrel.emissiveIntensity !== 0) {
        this.matBarrel.emissiveIntensity = 0;
        this.matBarrel.emissive.setRGB(0, 0, 0);
      }
      return;
    }
    // Blackbody-ish ramp: deep red first, only reaching orange under sustained fire.
    _col.setRGB(h * h * 1.5, h * h * h * 0.38, h * h * h * h * 0.09);
    this.matBarrel.emissive.copy(_col);
    // Fine flicker sells convected heat without reading as a strobe.
    this.matBarrel.emissiveIntensity = h * h * 2.3 * (0.92 + Math.sin(elapsed * 27.3) * 0.08);
  }

  _updatePose(elapsed, reloadT) {
    const aim = this._aim;
    const low = this._lowered * (1 - aim);

    // Base pose: hip -> ADS, with the sprint stow layered on top.
    _v1.copy(HIP_POS).lerp(ADS_POS, aim);
    _v2.copy(HIP_ROT).lerp(ADS_ROT, aim);
    _v1.lerp(LOW_POS, low);
    _v2.lerp(LOW_ROT, low);

    // Sway and bob are suppressed while aiming so the dot stays usable.
    const anim = 1 - aim * 0.78;

    // Every positional offset below is authored in model units and accumulated
    // separately, so it can be scaled by VM_SCALE alongside the geometry. Angles
    // need no such treatment - they are scale invariant.
    _v3.set(0, 0, 0);

    // Idle breathing: two out-of-phase sines so the loop never reads as a loop.
    const idle = (1 - this._bobWeight) * anim;
    _v3.x += Math.sin(elapsed * 0.9) * 0.0035 * idle;
    _v3.y += (Math.sin(elapsed * 1.31) * 0.0045 + Math.sin(elapsed * 2.7) * 0.0012) * idle;
    _v2.z += Math.sin(elapsed * 0.77) * 0.012 * idle;
    _v2.x += Math.sin(elapsed * 1.13) * 0.008 * idle;

    // Walk / run bob, driven by the player's travelled distance.
    const bw = this._bobWeight * anim;
    if (bw > 0.001) {
      const p = this._bobPhase;
      _v3.x += Math.cos(p) * 0.016 * bw;
      _v3.y += Math.sin(p * 2) * 0.011 * bw;
      _v3.z += Math.sin(p * 2 + 1.1) * 0.006 * bw;
      _v2.z += Math.cos(p) * 0.05 * bw;
      _v2.x += Math.sin(p * 2) * 0.022 * bw;
    }

    // Mouse lag.
    _v3.x += this._swayPos.x * 0.09 * anim;
    _v3.y += this._swayPos.y * 0.07 * anim;
    _v2.y += this._swayPos.x * 0.9 * anim;
    _v2.x += this._swayPos.y * 0.7 * anim;
    _v2.z += this._swayPos.x * 0.5 * anim;

    // Recoil.
    _v3.add(this._recoilPos);
    _v2.x += this._recoilRot.x;
    _v2.y += this._recoilRot.y;
    _v2.z += this._recoilRot.z;

    // Dry-fire twitch.
    if (this._dryT > 0) {
      _v3.z += this._dryT * 0.004;
      _v2.x += this._dryT * 0.02;
    }

    // Draw-in: the weapon swings up from below the frame after a switch.
    if (this._equipT > 0) {
      const e = this._equipT * this._equipT;
      _v3.y -= e * 0.36;
      _v3.z += e * 0.12;
      _v2.x -= e * 0.85;
      _v2.z += e * 0.45;
    }

    if (reloadT >= 0) this._applyReloadPose(reloadT, _v3, _v2);
    else this._restIdleParts();

    _v1.addScaledVector(_v3, VM_SCALE);
    this._model.position.copy(_v1);
    this._model.rotation.set(_v2.x, _v2.y, _v2.z, 'XYZ');

    // Viewmodel FOV compensation. Screen position of a point is
    // (x / (-z * tan(fov/2))), so scaling only X and Y by tan(cur)/tan(ref)
    // reproduces the reference FOV exactly while the camera keeps its own.
    const r = Math.tan(this.camera.fov * 0.5 * DEG) / Math.tan(this._referenceFov * 0.5 * DEG);
    this.root.scale.set(r, r, 1);

    // Reticle brightens and tightens as the sight comes up.
    this._reticleMat.opacity = 0.55 + aim * 0.45;
    const rs = 1 - aim * 0.25;
    this._reticle.scale.set(rs, rs, 1);

    // Arms last: they read the matrices everything above just wrote, and they
    // must see the final `root` scale.
    //
    // The shoulders draw together as the weapon comes up to the eye, because
    // that is what shouldering a rifle does - the support elbow tucks under the
    // receiver and the firing elbow comes in off the ribs. Holding them apart
    // through ADS leaves the forearms splayed as if the gun were still at the
    // hip.
    this._rightArm.anchor.copy(RIGHT_SHOULDER);
    this._leftArm.anchor.copy(LEFT_SHOULDER);
    this._rightArm.anchor.x -= aim * 0.05;
    this._leftArm.anchor.x += aim * 0.09;
    this._rightArm.solve();
    this._leftArm.solve();
  }

  /** Bolt and charging handle when not reloading: one cycle per shot. */
  _restIdleParts() {
    const p = 1 - this._boltT; // 0 at the instant of firing, 1 when closed
    let back;
    if (p < 0.4) back = p / 0.4;
    else back = 1 - (p - 0.4) / 0.6;
    back = this._boltT > 0 ? back : 0;
    this._bolt.position.z = -0.06 + back * 0.055;
    this._chargeHandle.position.z = -0.02 + back * 0.055;
    this._magPivot.position.set(0, -0.048, -0.012);
    this._magPivot.rotation.x = 0;
    this._leftHand.position.set(0, 0, 0);
    this._leftHand.rotation.set(0, 0, 0);
  }

  /**
   * Full reload timeline: cant the weapon inboard, drop the magazine, bring a
   * fresh one up, seat it with a tap, then cycle the charging handle.
   */
  _applyReloadPose(t, pos, rot) {
    const cant = pulse(0.02, 0.98, t);
    rot.z += cant * 0.52;
    rot.x += cant * 0.22;
    rot.y -= cant * 0.3;
    pos.y -= cant * 0.055;
    pos.x -= cant * 0.022;
    pos.z += cant * 0.05;

    // Magazine out, then a fresh one in.
    const out = sstep(0.1, 0.34, t);
    const back = sstep(0.56, 0.76, t);
    const drop = t < 0.5 ? out : 1 - back;
    const tap = pulse(0.76, 0.85, t);
    this._magPivot.position.set(0, -0.048 - drop * 0.34 + tap * 0.012, -0.012 + drop * 0.05);
    this._magPivot.rotation.x = -drop * 0.55;
    // The whole weapon absorbs the seating tap.
    pos.y -= tap * 0.008;
    rot.x -= tap * 0.05;

    // Support hand leaves the foregrip to service the magazine.
    const lh = pulse(0.06, 0.82, t);
    this._leftHand.position.set(-lh * 0.055, -lh * 0.17, lh * 0.11);
    this._leftHand.rotation.set(lh * 0.5, lh * 0.25, 0);

    // Charging handle: snapped back, released forward under spring pressure.
    let ch = 0;
    if (t > 0.86) {
      const u = clamp((t - 0.86) / 0.11, 0, 1);
      ch = u < 0.45 ? u / 0.45 : Math.max(0, 1 - (u - 0.45) / 0.4);
    }
    this._chargeHandle.position.z = -0.02 + ch * 0.075;
    this._bolt.position.z = -0.06 + ch * 0.055;
    rot.x -= ch * 0.035;
  }

  _updateFlash(dt) {
    if (this._flashT <= 0) {
      if (this._flashGroup.visible) {
        this._flashGroup.visible = false;
        this._flashLight.intensity = 0;
      }
      return;
    }
    this._flashT = Math.max(0, this._flashT - dt * 26);
    const f = this._flashT;
    // Sharp attack, fast decay - a flash that lingers reads as a fireball.
    const curve = f * f;
    this._flashMat.opacity = curve;
    const s = this._flashScale * (0.55 + f * 0.75);
    this._flashGroup.scale.set(s, s, s);
    this._flashGroup.rotation.z = this._flashRoll;
    this._flashLight.intensity = curve * 26;
    if (this._flashT <= 0) {
      this._flashGroup.visible = false;
      this._flashLight.intensity = 0;
    }
    // The light hangs off the camera, not the model, so it has to be walked
    // onto the muzzle whenever it is actually lit.
    this._flashAnchored?.sync();
  }

  _updateCasings(dt) {
    const st = this._casingState;
    if (st.active === 0) return;
    const { pos, vel, spin, quat, life, ground } = st;
    let live = 0;

    for (let i = 0; i < CASING_COUNT; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      const i3 = i * 3;
      const i4 = i * 4;

      vel[i3 + 1] -= 11.5 * dt;
      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;

      // Bounce on the floor plane cached at ejection time.
      if (pos[i3 + 1] < ground[i] + 0.006) {
        pos[i3 + 1] = ground[i] + 0.006;
        if (vel[i3 + 1] < -0.25) {
          vel[i3 + 1] *= -0.34;
          vel[i3] *= 0.62;
          vel[i3 + 2] *= 0.62;
          spin[i3] *= 0.5;
          spin[i3 + 1] *= 0.5;
          spin[i3 + 2] *= 0.5;
        } else {
          vel[i3] *= 0.86;
          vel[i3 + 1] = 0;
          vel[i3 + 2] *= 0.86;
          spin[i3] *= 0.8;
          spin[i3 + 1] *= 0.8;
          spin[i3 + 2] *= 0.8;
        }
      }

      _q1.set(quat[i4], quat[i4 + 1], quat[i4 + 2], quat[i4 + 3]);
      _v1.set(spin[i3] * dt, spin[i3 + 1] * dt, spin[i3 + 2] * dt);
      _eul.set(_v1.x, _v1.y, _v1.z, 'XYZ');
      _q2.setFromEuler(_eul);
      _q1.multiply(_q2).normalize();
      quat[i4] = _q1.x;
      quat[i4 + 1] = _q1.y;
      quat[i4 + 2] = _q1.z;
      quat[i4 + 3] = _q1.w;

      // Shrink out over the last half second rather than popping.
      const s = life[i] < 0.5 ? Math.max(0, life[i] / 0.5) : 1;
      _v2.set(pos[i3], pos[i3 + 1], pos[i3 + 2]);
      _v3.set(s, s, s);
      _m4.compose(_v2, _q1, _v3);
      this._casings.setMatrixAt(i, _m4);
      if (life[i] > 0) live++;
      else {
        _m4.makeScale(0, 0, 0);
        this._casings.setMatrixAt(i, _m4);
      }
    }
    st.active = live;
    this._casings.instanceMatrix.needsUpdate = true;
  }

  _updateSmoke(dt) {
    for (let i = 0; i < this._smoke.length; i++) {
      const m = this._smoke[i];
      if (!m.visible) continue;
      const ud = m.userData;
      ud.life -= dt;
      if (ud.life <= 0) {
        m.visible = false;
        continue;
      }
      ud.vel.multiplyScalar(1 - 1.4 * dt);
      ud.vel.y += 0.35 * dt;
      m.position.addScaledVector(ud.vel, dt);
      const u = 1 - ud.life / ud.maxLife;
      const s = ud.size * (0.5 + u * 2.1);
      m.scale.set(s, s, s);
      m.material.opacity = Math.sin(Math.min(1, u * 1.6) * Math.PI) * 0.32;
      // Cheap billboard: the puffs are radially symmetric, so copying the
      // camera's world orientation and adding roll is enough.
      this.camera.getWorldQuaternion(m.quaternion);
      m.rotateZ(ud.roll + u * ud.spin);
    }
  }

  /* ================================================================ */
  /* Fire control                                                      */
  /* ================================================================ */

  /**
   * Attempt to fire. Enforces the RPM gate, consumes ammunition and emits
   * `weapon:fired`. Damage resolution belongs to the combat system.
   * @param {number} elapsed - engine time in seconds
   * @returns {boolean} true if a round left the barrel
   */
  tryFire(elapsed) {
    this._time = elapsed;
    if (!this._enabled || this._reloading) return false;
    if (elapsed - this._lastShot < this._shotInterval) return false;

    if (this._ammo <= 0) {
      if (elapsed - this._lastDryClick > 0.32) {
        this._lastDryClick = elapsed;
        this._dryT = 1;
        this.bus.emit('weapon:dry', { reserve: this._reserve });
        if (this._reserve > 0) this.reload(elapsed);
      }
      return false;
    }

    this._lastShot = elapsed;
    this._ammo--;

    this._boltT = 1;
    this._flashT = 1;
    this._flashRoll = Math.random() * Math.PI * 2;
    this._flashScale = 0.8 + Math.random() * 0.5;
    this._flashGroup.visible = true;
    this._heat = Math.min(1, this._heat + 0.052);

    this.addRecoil();
    this._spread = Math.min(SPEC.spreadMax, this._spread + SPEC.spreadPerShot);

    // World-space transforms must be current: the camera pose was written this
    // frame but three only refreshes matrices at render time.
    this._model.updateWorldMatrix(true, false);
    this._ejectCasing();
    if ((this._ammo & 1) === 0) this._puffSmoke();

    const origin = this.camera.getWorldPosition(new THREE.Vector3());
    const direction = this.camera.getWorldDirection(new THREE.Vector3());
    const muzzle = this._model.localToWorld(new THREE.Vector3(0, 0, MUZZLE_Z));

    this.bus.emit('weapon:fired', {
      origin,
      direction,
      spread: this.spread,
      ammo: this._ammo,
      // Extras for VFX; the contract only requires the four fields above.
      muzzle,
      damage: SPEC.damage,
      range: SPEC.range,
      headshotMultiplier: SPEC.headshotMultiplier,
      weaponId: 'machinegun',
      // Combat resolves this event as a hitscan round. Projectile weapons never
      // raise `weapon:fired`, but flagging it explicitly means a future one
      // cannot accidentally be resolved twice.
      hitscan: true,
    });
    this._emitAmmo();

    if (this._ammo === 0 && this._reserve > 0) this.reload(elapsed);
    return true;
  }

  /** Begin a reload. No-op when already full, already reloading, or dry. */
  reload(elapsed = this._time) {
    if (this._reloading || !this._enabled) return false;
    if (this._ammo >= this._magazine || this._reserve <= 0) return false;
    this._reloading = true;
    this._reloadStart = elapsed;
    this._reloadDuration = SPEC.reloadTime;
    this.bus.emit('weapon:reload-start', { duration: this._reloadDuration });
    return true;
  }

  _finishReload() {
    const needed = this._magazine - this._ammo;
    const take = Math.min(needed, this._reserve);
    this._ammo += take;
    this._reserve -= take;
    this._reloading = false;
    this._spread = SPEC.spreadBase;
    this.bus.emit('weapon:reload-end', { ammo: this._ammo, reserve: this._reserve });
    this._emitAmmo();
  }

  /** Restore a full loadout - used on respawn. */
  resupply() {
    this._ammo = this._magazine;
    this._reserve = SPEC.reserve;
    this._reloading = false;
    this._spread = SPEC.spreadBase;
    this._heat = 0;
    this._emitAmmo();
  }

  _emitAmmo() {
    this.bus.emit('weapon:ammo', {
      ammo: this._ammo,
      reserve: this._reserve,
      magazine: this._magazine,
    });
  }

  /** Kick the springs. Visual kick and camera kick share one impulse. */
  addRecoil() {
    const scale = 1 - this._aim * 0.34;
    const rand = Math.random() - 0.5;

    this._camKickVel.y += SPEC.recoilVertical * DEG * 30 * scale * (0.85 + Math.random() * 0.3);
    this._camKickVel.x += SPEC.recoilHorizontal * DEG * 30 * scale * rand * 2;

    this._recoilPosVel.z += 0.95 * scale;
    this._recoilPosVel.y += 0.3 * scale;
    this._recoilPosVel.x += rand * 0.24 * scale;

    this._recoilRotVel.x += 3.4 * scale; // muzzle rise
    this._recoilRotVel.y += rand * 1.3 * scale;
    this._recoilRotVel.z += rand * 2.1 * scale;
  }

  /**
   * Current camera kick in radians. Live object - do not retain.
   * @returns {{x:number, y:number}} x = yaw, y = pitch
   */
  getRecoilOffset() {
    return this._camKick;
  }

  _ejectCasing() {
    const st = this._casingState;
    let i = st.next;
    // Prefer a dead slot; otherwise recycle the oldest.
    for (let n = 0; n < CASING_COUNT; n++) {
      const c = (st.next + n) % CASING_COUNT;
      if (st.life[c] <= 0) {
        i = c;
        break;
      }
      i = st.next;
    }
    st.next = (i + 1) % CASING_COUNT;

    this._model.localToWorld(_v1.copy(PORT_POS));
    this.camera.matrixWorld.extractBasis(_v2, _v3, _v4); // right, up, backward

    const i3 = i * 3;
    const i4 = i * 4;
    st.pos[i3] = _v1.x;
    st.pos[i3 + 1] = _v1.y;
    st.pos[i3 + 2] = _v1.z;

    const sx = 2.3 + Math.random() * 1.1;
    const sy = 1.5 + Math.random() * 0.7;
    const sz = 0.2 + Math.random() * 0.5;
    const pv = this._playerVelocity;
    st.vel[i3] = _v2.x * sx + _v3.x * sy + _v4.x * sz + (pv ? pv.x : 0);
    st.vel[i3 + 1] = _v2.y * sx + _v3.y * sy + _v4.y * sz + (pv ? pv.y : 0);
    st.vel[i3 + 2] = _v2.z * sx + _v3.z * sy + _v4.z * sz + (pv ? pv.z : 0);

    st.spin[i3] = (Math.random() - 0.5) * 34;
    st.spin[i3 + 1] = (Math.random() - 0.5) * 26;
    st.spin[i3 + 2] = (Math.random() - 0.5) * 30;

    _q1.setFromEuler(_eul.set(Math.random() * 3, Math.random() * 3, Math.random() * 3, 'XYZ'));
    st.quat[i4] = _q1.x;
    st.quat[i4 + 1] = _q1.y;
    st.quat[i4 + 2] = _q1.z;
    st.quat[i4 + 3] = _q1.w;

    st.life[i] = 3.4;
    st.ground[i] = this._groundY;
    st.active++;
  }

  _puffSmoke() {
    const m = this._smoke[this._smokeNext];
    this._smokeNext = (this._smokeNext + 1) % this._smoke.length;

    this._model.localToWorld(_v1.set(0, 0, MUZZLE_Z - 0.03));
    this.camera.matrixWorld.extractBasis(_v2, _v3, _v4);

    m.position.copy(_v1);
    m.userData.vel
      .set(0, 0, 0)
      .addScaledVector(_v4, -(0.9 + Math.random() * 0.5))
      .addScaledVector(_v3, 0.25 + Math.random() * 0.3)
      .addScaledVector(_v2, (Math.random() - 0.5) * 0.4);
    if (this._playerVelocity) m.userData.vel.addScaledVector(this._playerVelocity, 0.6);
    m.userData.maxLife = 0.75 + Math.random() * 0.45;
    m.userData.life = m.userData.maxLife;
    m.userData.size = 0.09 + Math.random() * 0.05;
    m.userData.spin = (Math.random() - 0.5) * 1.6;
    m.userData.roll = Math.random() * Math.PI * 2;
    m.visible = true;
  }

  /* ================================================================ */
  /* Shared weapon interface (CONTRACTS-V2 §3.2)                       */
  /* ================================================================ */

  /** Stable identifier used by the loadout, the HUD and save games. */
  get id() {
    return 'machinegun';
  }

  /** Icon hint for the HUD's procedurally drawn slot strip. */
  get icon() {
    return 'rifle';
  }

  /** Accent colour the HUD may tint this weapon's slot with. */
  get accent() {
    return '#ff9d3c';
  }

  /** Hitscan weapon: never charges. Present so the loadout can poll uniformly. */
  get chargeLevel() {
    return 0;
  }

  /** Ammunition model, for a HUD that renders magazines and pools differently. */
  get ammoKind() {
    return 'magazine';
  }

  /** No-op: the machine gun is fully automatic, so the release carries nothing. */
  releaseFire() {
    return false;
  }

  /** Raised by the loadout. Plays the draw animation and refreshes the HUD. */
  onSelect() {
    this._enabled = true;
    this._equipT = 1;
    this._lowered = 1;
    this._loweredTarget = 0;
    this.setVisible(true);
    this._emitAmmo();
  }

  /** Stowed by the loadout. Cancels any in-flight aim and hides the model. */
  onDeselect() {
    this._aimTarget = 0;
    this._aim = 0;
    this._dryT = 0;
    this._flashT = 0;
    this._flashGroup.visible = false;
    this._flashLight.intensity = 0;
    this.setVisible(false);
  }

  /* ================================================================ */
  /* Accessors                                                         */
  /* ================================================================ */

  get ammo() {
    return this._ammo;
  }

  get reserve() {
    return this._reserve;
  }

  get magazine() {
    return this._magazine;
  }

  get isReloading() {
    return this._reloading;
  }

  /** Reload completion in 0..1, or 0 when idle. */
  get reloadProgress() {
    if (!this._reloading) return 0;
    return clamp((this._time - this._reloadStart) / this._reloadDuration, 0, 1);
  }

  /** Effective cone half-angle in radians, including stance and movement. */
  get spread() {
    return this._spread * (1 - this._aim * 0.62) + this._moveSpread * (1 - this._aim * 0.5);
  }

  /** ADS blend 0..1 - Player uses this to drive the FOV. */
  get aimProgress() {
    return this._aim;
  }

  get heat() {
    return this._heat;
  }

  dispose() {
    this.root.removeFromParent();
    this._lightRig?.removeFromParent();
    this._casings?.removeFromParent();
    this._casings?.dispose();
    for (const m of this._smoke ?? []) m.removeFromParent();

    this.root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    for (const d of this._disposables) d?.dispose?.();
    this._disposables.length = 0;
  }
}
