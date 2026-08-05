import * as THREE from 'three';

/**
 * Procedural texture toolkit.
 *
 * The game ships zero binary assets, so every albedo / normal / roughness map in
 * AETHER NEXUS is synthesised here at boot. Two rules drive the design:
 *
 * 1. **Everything tiles exactly.** All noise primitives are *periodic*: the
 *    integer lattice they hash is wrapped modulo the octave period, so
 *    `f(u + 1, v) === f(u, v)` for free. Domain warping composes periodic
 *    fields, so warped noise stays periodic too. That means no mirrored
 *    blending hacks and no visible seam at any repeat count.
 * 2. **One pass per surface.** `bakeSurface()` evaluates a single shading
 *    callback per texel and emits albedo, height, and a packed ORM map together.
 *    Generating three maps from three separate noise walks would triple the boot
 *    cost for identical output.
 *
 * Conventions:
 * - Albedo channels are authored directly in **sRGB 0..1** (the texture is
 *   tagged `SRGBColorSpace`, the GPU does the decode).
 * - Data maps (normal / ORM / height) are `NoColorSpace`.
 * - ORM packing is the glTF convention: **R = AO, G = roughness, B = metalness**,
 *   so a single texture can be wired to `aoMap`, `roughnessMap` and
 *   `metalnessMap` at once — one sampler, one upload, three channels.
 * - Every texture produced here has `flipY = false` so canvas-sourced and
 *   data-sourced maps share one orientation: **array row 0 is v = 0**.
 */

/* ------------------------------------------------------------------ */
/* Renderer-dependent defaults                                         */
/* ------------------------------------------------------------------ */

let _maxAnisotropy = 8;

/**
 * Bind the toolkit to a renderer so generated textures pick up the hardware's
 * maximum anisotropy. Safe to call more than once.
 * @param {THREE.WebGLRenderer} renderer
 */
export function configureTextures(renderer) {
  if (renderer?.capabilities?.getMaxAnisotropy) {
    _maxAnisotropy = Math.max(1, renderer.capabilities.getMaxAnisotropy());
  }
  return _maxAnisotropy;
}

/** @returns {number} anisotropy applied to generated textures. */
export function getMaxAnisotropy() {
  return _maxAnisotropy;
}

/* ------------------------------------------------------------------ */
/* Small maths helpers (module scope - no per-texel allocation)        */
/* ------------------------------------------------------------------ */

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const mix = (a, b, t) => a + (b - a) * t;

export function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-9));
  return t * t * (3 - 2 * t);
}

/** Quintic fade - C2 continuous, which keeps Sobel-derived normals free of banding. */
function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function wrapi(i, period) {
  const m = i % period;
  return m < 0 ? m + period : m;
}

/** 32-bit integer hash. Deterministic across machines (Math.imul is exact). */
function hash2i(x, y, seed) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Deterministic 0..1 hash of an integer lattice point. */
export function hash2D(x, y, seed = 0) {
  return hash2i(x, y, seed) / 4294967296;
}

/** Seeded PRNG (Mulberry32) for one-off placement decisions. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Periodic noise suite                                                */
/* ------------------------------------------------------------------ */

// Precomputed unit gradients. Trig per corner would dominate the bake cost.
const GRAD_COUNT = 256;
const GRAD_X = new Float32Array(GRAD_COUNT);
const GRAD_Y = new Float32Array(GRAD_COUNT);
for (let i = 0; i < GRAD_COUNT; i++) {
  const a = (i / GRAD_COUNT) * Math.PI * 2;
  GRAD_X[i] = Math.cos(a);
  GRAD_Y[i] = Math.sin(a);
}

/**
 * Periodic value noise. Cheaper than the gradient variant and better suited to
 * blotchy features (grime, damp patches) where you want plateaus, not ridges.
 * @returns {number} 0..1
 */
export function valueNoise2D(x, y, periodX, periodY = periodX, seed = 0) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = fade(x - xi);
  const v = fade(y - yi);
  const x0 = wrapi(xi, periodX);
  const x1 = wrapi(xi + 1, periodX);
  const y0 = wrapi(yi, periodY);
  const y1 = wrapi(yi + 1, periodY);
  const n00 = hash2D(x0, y0, seed);
  const n10 = hash2D(x1, y0, seed);
  const n01 = hash2D(x0, y1, seed);
  const n11 = hash2D(x1, y1, seed);
  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  return a + (b - a) * v;
}

/**
 * Periodic gradient (Perlin) noise with independent X/Y periods so a single
 * call can produce anisotropic features - brushed metal, wood grain, rain
 * streaks - without a second noise type.
 * @returns {number} roughly -1..1
 */
export function perlin2D(x, y, periodX, periodY = periodX, seed = 0) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = fade(xf);
  const v = fade(yf);
  const x0 = wrapi(xi, periodX);
  const x1 = wrapi(xi + 1, periodX);
  const y0 = wrapi(yi, periodY);
  const y1 = wrapi(yi + 1, periodY);

  const g00 = hash2i(x0, y0, seed) & 255;
  const g10 = hash2i(x1, y0, seed) & 255;
  const g01 = hash2i(x0, y1, seed) & 255;
  const g11 = hash2i(x1, y1, seed) & 255;

  const n00 = GRAD_X[g00] * xf + GRAD_Y[g00] * yf;
  const n10 = GRAD_X[g10] * (xf - 1) + GRAD_Y[g10] * yf;
  const n01 = GRAD_X[g01] * xf + GRAD_Y[g01] * (yf - 1);
  const n11 = GRAD_X[g11] * (xf - 1) + GRAD_Y[g11] * (yf - 1);

  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  return (a + (b - a) * v) * 1.4142;
}

/**
 * Fractal brownian motion over periodic Perlin noise.
 *
 * `u`/`v` are unit texture coordinates; frequencies are in tiles-per-texture and
 * are rounded to integers so every octave's period divides the tile exactly.
 * With `lacunarity = 2` all octave periods stay integral, which is what keeps
 * the result seamless.
 *
 * @returns {number} roughly -1..1
 */
export function fbm2D(u, v, freqX, freqY = freqX, octaves = 4, seed = 0, gain = 0.5, lacunarity = 2) {
  let fx = Math.max(1, Math.round(freqX));
  let fy = Math.max(1, Math.round(freqY));
  let amp = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += perlin2D(u * fx, v * fy, fx, fy, seed + i * 1013) * amp;
    norm += amp;
    amp *= gain;
    fx *= lacunarity;
    fy *= lacunarity;
  }
  return sum / (norm || 1);
}

/** FBM remapped to 0..1 - the form most shading code actually wants. */
export function fbm01(u, v, freqX, freqY = freqX, octaves = 4, seed = 0, gain = 0.5) {
  return fbm2D(u, v, freqX, freqY, octaves, seed, gain) * 0.5 + 0.5;
}

/**
 * Ridged multifractal. Sharp creases: rock strata, cracks, scratches, wood grain.
 * @returns {number} 0..1, peaking at 1 on the ridge lines
 */
export function ridgedFbm2D(u, v, freqX, freqY = freqX, octaves = 4, seed = 0, gain = 0.5, lacunarity = 2) {
  let fx = Math.max(1, Math.round(freqX));
  let fy = Math.max(1, Math.round(freqY));
  let amp = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(perlin2D(u * fx, v * fy, fx, fy, seed + i * 7919));
    n *= n;
    sum += n * amp;
    norm += amp;
    amp *= gain;
    fx *= lacunarity;
    fy *= lacunarity;
  }
  return sum / (norm || 1);
}

/**
 * Worley / cellular noise results, written in place to avoid per-texel garbage.
 * `[0]` = F1 distance, `[1]` = F2 distance, `[2]` = 0..1 hash id of the nearest
 * cell (use it for per-stone / per-tile colour variation).
 * @type {Float32Array}
 */
export const WORLEY = new Float32Array(3);

/**
 * Periodic Worley noise. Cell indices are wrapped before hashing but distances
 * use the unwrapped position, so features cross the tile border intact.
 *
 * @param {number} u unit texture coordinate
 * @param {number} v unit texture coordinate
 * @param {number} cellsX cells across the tile (integer)
 * @param {number} cellsY cells down the tile (integer)
 * @param {number} seed
 * @param {number} jitter 0 = perfect grid, 1 = fully scattered
 * @returns {number} F1 distance in cell units (also see {@link WORLEY})
 */
export function worley2D(u, v, cellsX, cellsY = cellsX, seed = 0, jitter = 1) {
  const cx = Math.max(1, Math.round(cellsX));
  const cy = Math.max(1, Math.round(cellsY));
  const x = u * cx;
  const y = v * cy;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let f1 = 1e9;
  let f2 = 1e9;
  let id = 0;

  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const gx = ix + i;
      const gy = iy + j;
      const h = hash2i(wrapi(gx, cx), wrapi(gy, cy), seed);
      const jx = ((h & 1023) / 1023 - 0.5) * jitter;
      const jy = (((h >>> 10) & 1023) / 1023 - 0.5) * jitter;
      const dx = gx + 0.5 + jx - x;
      const dy = gy + 0.5 + jy - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = ((h >>> 20) & 4095) / 4095;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  WORLEY[0] = f1;
  WORLEY[1] = f2;
  WORLEY[2] = id;
  return f1;
}

/**
 * Domain-warp offsets, written in place. Warping a periodic field by another
 * periodic field keeps the result periodic, so warped surfaces still tile.
 * @type {Float32Array}
 */
export const WARP = new Float32Array(2);

/**
 * Offset a coordinate pair by two decorrelated FBM fields.
 * @returns {Float32Array} `[warpedU, warpedV]` - see {@link WARP}
 */
export function domainWarp2D(u, v, frequency = 3, amount = 0.08, seed = 0, octaves = 3) {
  WARP[0] = u + fbm2D(u, v, frequency, frequency, octaves, seed) * amount;
  WARP[1] = v + fbm2D(u, v, frequency, frequency, octaves, seed + 5501) * amount;
  return WARP;
}

/* ------------------------------------------------------------------ */
/* Canvas plumbing                                                     */
/* ------------------------------------------------------------------ */

/**
 * OffscreenCanvas when the browser has it (keeps the bake off the DOM), with a
 * plain canvas fallback for older Safari.
 * @returns {OffscreenCanvas|HTMLCanvasElement}
 */
export function createCanvas(width, height = width) {
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      return new OffscreenCanvas(width, height);
    } catch {
      /* fall through to the DOM canvas */
    }
  }
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

/**
 * Apply the house texture defaults: seamless wrapping, mipmaps, anisotropy.
 * @param {THREE.Texture} tex
 */
export function applyTextureDefaults(tex, { colorSpace = THREE.NoColorSpace, repeat = 1, repeatY, anisotropy, name } = {}) {
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = colorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = anisotropy ?? _maxAnisotropy;
  tex.repeat.set(repeat, repeatY ?? repeat);
  // Uniform orientation across canvas- and data-sourced maps: row 0 is v = 0.
  tex.flipY = false;
  if (name) tex.name = name;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Wrap an RGBA byte buffer as a texture.
 * @param {Uint8Array} data
 */
export function textureFromRGBA(data, size, opts = {}) {
  const tex = new THREE.DataTexture(data, size, opts.height ?? size, THREE.RGBAFormat, THREE.UnsignedByteType);
  return applyTextureDefaults(tex, opts);
}

/**
 * Draw into an offscreen canvas and hand back a texture. Worlds use this for
 * signage, decals and painted markings where 2D vector drawing beats noise.
 * @param {number} width
 * @param {number} height
 * @param {(ctx:CanvasRenderingContext2D, w:number, h:number)=>void} draw
 */
export function makeCanvasTexture(width, height, draw, opts = {}) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  draw(ctx, width, height);
  const tex = new THREE.CanvasTexture(canvas);
  return applyTextureDefaults(tex, { colorSpace: THREE.SRGBColorSpace, ...opts });
}

/** Yield to the compositor so a loading bar can actually animate mid-bake. */
export function yieldFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/* ------------------------------------------------------------------ */
/* Height -> normal                                                    */
/* ------------------------------------------------------------------ */

/**
 * Sobel-filtered height-to-normal conversion, tangent space, OpenGL handedness.
 *
 * three.js builds its tangent frame from UV derivatives, so `+G` must tilt the
 * normal toward `+v`: a surface rising in `+v` therefore encodes `-dh/dv`.
 * Sampling wraps at the borders, so the normal map tiles as cleanly as the
 * height field it came from.
 *
 * @param {Float32Array} height square height field, 0..1
 * @param {number} size edge length in texels
 * @param {{strength?:number, repeat?:number, name?:string}} [opts]
 * @returns {THREE.DataTexture} RGB = XYZ remapped to 0..1, A = 255
 */
export function makeNormalFromHeight(height, size, opts = {}) {
  const { strength = 1, repeat = 1 } = opts;
  const data = new Uint8Array(size * size * 4);
  // Sobel's one-sided weight sum is 4; the resolution term keeps a given
  // `strength` looking the same whether the map is baked at 256 or 1024.
  const k = strength * 0.25 * (size / 256);

  for (let y = 0; y < size; y++) {
    const ym = (y === 0 ? size - 1 : y - 1) * size;
    const yc = y * size;
    const yp = (y === size - 1 ? 0 : y + 1) * size;
    for (let x = 0; x < size; x++) {
      const xm = x === 0 ? size - 1 : x - 1;
      const xp = x === size - 1 ? 0 : x + 1;

      const h00 = height[ym + xm];
      const h10 = height[ym + x];
      const h20 = height[ym + xp];
      const h01 = height[yc + xm];
      const h21 = height[yc + xp];
      const h02 = height[yp + xm];
      const h12 = height[yp + x];
      const h22 = height[yp + xp];

      const gx = (h20 + 2 * h21 + h22) - (h00 + 2 * h01 + h02);
      const gy = (h02 + 2 * h12 + h22) - (h00 + 2 * h10 + h20);

      const nx = -gx * k;
      const ny = -gy * k;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const o = (yc + x) * 4;
      data[o] = (nx * inv * 0.5 + 0.5) * 255;
      data[o + 1] = (ny * inv * 0.5 + 0.5) * 255;
      data[o + 2] = (inv * 0.5 + 0.5) * 255;
      data[o + 3] = 255;
    }
  }
  return textureFromRGBA(data, size, { colorSpace: THREE.NoColorSpace, repeat, name: opts.name });
}

/* ------------------------------------------------------------------ */
/* Surface baking                                                      */
/* ------------------------------------------------------------------ */

/**
 * Scratch texel written by a {@link bakeSurface} shading callback.
 * Reused across every texel - never retain a reference to it.
 */
const TEXEL = {
  /** albedo, sRGB 0..1 */ r: 0.5, g: 0.5, b: 0.5,
  /** alpha 0..1, only sampled when `alpha: true` */ a: 1,
  /** height 0..1, drives the normal map */ h: 0.5,
  /** ambient occlusion 0..1 */ ao: 1,
  /** roughness 0..1 */ rough: 0.8,
  /** metalness 0..1 */ metal: 0,
  /** emissive, linear 0..1, only sampled when `emissive: true` */ er: 0, eg: 0, eb: 0,
};

const toByte = (x) => (x <= 0 ? 0 : x >= 1 ? 255 : (x * 255 + 0.5) | 0);

/**
 * Evaluate a shading function once per texel and emit a complete PBR set.
 *
 * The callback writes into the shared {@link TEXEL} scratch object; running
 * albedo, height and ORM off one noise walk is roughly 3x faster than baking
 * each map separately, which is the difference between a 2 second boot and a
 * 6 second one.
 *
 * @param {number} size edge length (power of two)
 * @param {(u:number, v:number, out:typeof TEXEL, x:number, y:number)=>void} shade
 * @param {{normalStrength?:number, alpha?:boolean, emissive?:boolean,
 *          repeat?:number, name?:string}} [opts]
 * @returns {{map:THREE.DataTexture, normalMap:THREE.DataTexture,
 *            ormMap:THREE.DataTexture, emissiveMap:?THREE.DataTexture,
 *            height:Float32Array, size:number, textures:THREE.Texture[]}}
 */
export function bakeSurface(size, shade, opts = {}) {
  const { normalStrength = 1, alpha = false, emissive = false, repeat = 1, name = 'surface' } = opts;
  const px = size * size;
  const albedo = new Uint8Array(px * 4);
  const orm = new Uint8Array(px * 4);
  const height = new Float32Array(px);
  const emis = emissive ? new Uint8Array(px * 4) : null;
  const inv = 1 / size;

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) * inv;

      // Defaults are re-seeded every texel so a shader can write only what it cares about.
      TEXEL.r = 0.5; TEXEL.g = 0.5; TEXEL.b = 0.5; TEXEL.a = 1;
      TEXEL.h = 0.5; TEXEL.ao = 1; TEXEL.rough = 0.8; TEXEL.metal = 0;
      TEXEL.er = 0; TEXEL.eg = 0; TEXEL.eb = 0;

      shade(u, v, TEXEL, x, y);

      const i = y * size + x;
      const o = i * 4;
      albedo[o] = toByte(TEXEL.r);
      albedo[o + 1] = toByte(TEXEL.g);
      albedo[o + 2] = toByte(TEXEL.b);
      albedo[o + 3] = alpha ? toByte(TEXEL.a) : 255;
      orm[o] = toByte(TEXEL.ao);
      orm[o + 1] = toByte(TEXEL.rough);
      orm[o + 2] = toByte(TEXEL.metal);
      orm[o + 3] = 255;
      height[i] = TEXEL.h;
      if (emis) {
        emis[o] = toByte(TEXEL.er);
        emis[o + 1] = toByte(TEXEL.eg);
        emis[o + 2] = toByte(TEXEL.eb);
        emis[o + 3] = 255;
      }
    }
  }

  const map = textureFromRGBA(albedo, size, { colorSpace: THREE.SRGBColorSpace, repeat, name: `${name}.albedo` });
  const ormMap = textureFromRGBA(orm, size, { colorSpace: THREE.NoColorSpace, repeat, name: `${name}.orm` });
  const normalMap = makeNormalFromHeight(height, size, { strength: normalStrength, repeat, name: `${name}.normal` });
  const emissiveMap = emis
    ? textureFromRGBA(emis, size, { colorSpace: THREE.SRGBColorSpace, repeat, name: `${name}.emissive` })
    : null;

  const textures = [map, ormMap, normalMap];
  if (emissiveMap) textures.push(emissiveMap);
  return { map, normalMap, ormMap, emissiveMap, height, size, textures };
}

/* ------------------------------------------------------------------ */
/* Contract generators                                                 */
/* ------------------------------------------------------------------ */

/**
 * General-purpose noise texture. Handles FBM, ridged and cellular flavours plus
 * optional domain warping, ramped between two colours.
 *
 * @param {object} [o]
 * @param {number} [o.size=256]
 * @param {number} [o.frequency=8] base tiles-per-texture
 * @param {number} [o.frequencyY] independent vertical frequency (anisotropic noise)
 * @param {number} [o.octaves=4]
 * @param {number} [o.seed=1]
 * @param {number} [o.gain=0.5]
 * @param {number} [o.warp=0] domain-warp amount in uv units
 * @param {number} [o.warpFrequency=3]
 * @param {boolean} [o.ridged=false]
 * @param {number} [o.worleyCells=0] non-zero switches to cellular noise
 * @param {number} [o.contrast=1]
 * @param {number} [o.colorA=0x000000] colour at 0
 * @param {number} [o.colorB=0xffffff] colour at 1
 * @param {string} [o.colorSpace=THREE.SRGBColorSpace]
 * @param {number} [o.repeat=1]
 * @returns {THREE.DataTexture}
 */
export function makeNoiseTexture(o = {}) {
  const {
    size = 256, frequency = 8, frequencyY = frequency, octaves = 4, seed = 1, gain = 0.5,
    warp = 0, warpFrequency = 3, ridged = false, worleyCells = 0, contrast = 1,
    colorA = 0x000000, colorB = 0xffffff, colorSpace = THREE.SRGBColorSpace, repeat = 1,
  } = o;

  const ca = new THREE.Color(colorA);
  const cb = new THREE.Color(colorB);
  const data = new Uint8Array(size * size * 4);
  const inv = 1 / size;

  for (let y = 0; y < size; y++) {
    const v0 = (y + 0.5) * inv;
    for (let x = 0; x < size; x++) {
      const u0 = (x + 0.5) * inv;
      let u = u0;
      let v = v0;
      if (warp > 0) {
        domainWarp2D(u0, v0, warpFrequency, warp, seed + 331);
        u = WARP[0];
        v = WARP[1];
      }

      let n;
      if (worleyCells > 0) {
        worley2D(u, v, worleyCells, worleyCells, seed, 1);
        n = clamp01(WORLEY[0]);
      } else if (ridged) {
        n = ridgedFbm2D(u, v, frequency, frequencyY, octaves, seed, gain);
      } else {
        n = fbm2D(u, v, frequency, frequencyY, octaves, seed, gain) * 0.5 + 0.5;
      }
      n = clamp01((n - 0.5) * contrast + 0.5);

      const idx = (y * size + x) * 4;
      data[idx] = toByte(ca.r + (cb.r - ca.r) * n);
      data[idx + 1] = toByte(ca.g + (cb.g - ca.g) * n);
      data[idx + 2] = toByte(ca.b + (cb.b - ca.b) * n);
      data[idx + 3] = 255;
    }
  }
  return textureFromRGBA(data, size, { colorSpace, repeat, name: 'noise' });
}

/**
 * Seamless structural patterns. Everything is evaluated analytically per texel
 * with modular arithmetic, so the pattern wraps exactly at the tile border.
 *
 * @param {object} [o]
 * @param {'brick'|'ashlar'|'plank'|'checker'|'grid'|'diamond'|'hex'|'weave'|'dots'|'stripe'} [o.kind='brick']
 * @param {number} [o.size=256]
 * @param {number} [o.cols=4] cells across
 * @param {number} [o.rows=8] cells down
 * @param {number} [o.gap=0.06] joint width as a fraction of a cell
 * @param {number} [o.colorA=0x8a8a8a] cell colour
 * @param {number} [o.colorB=0x4a4a4a] joint / alternate colour
 * @param {number} [o.variation=0.12] per-cell brightness jitter
 * @param {number} [o.seed=1]
 * @param {number} [o.repeat=1]
 * @returns {THREE.DataTexture} sRGB albedo
 */
export function makeTilingPattern(o = {}) {
  const {
    kind = 'brick', size = 256, cols = 4, rows = 8, gap = 0.06,
    colorA = 0x8a8a8a, colorB = 0x4a4a4a, variation = 0.12, seed = 1,
    repeat = 1, colorSpace = THREE.SRGBColorSpace,
  } = o;

  const ca = new THREE.Color(colorA);
  const cb = new THREE.Color(colorB);
  const data = new Uint8Array(size * size * 4);
  const inv = 1 / size;

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) * inv;
      let t = 0; // 0 = cell body, 1 = joint / alternate
      let cellId = 0;

      switch (kind) {
        case 'brick':
        case 'ashlar': {
          const fv = v * rows;
          const row = Math.floor(fv);
          const cv = fv - row;
          // Half-brick offset on odd rows; the shift divides the tile evenly so it still wraps.
          const shift = (row & 1) * 0.5;
          const fu = (u * cols + shift);
          const col = Math.floor(fu);
          const cu = fu - col;
          cellId = hash2D(wrapi(col, cols), wrapi(row, rows), seed);
          const wobble = kind === 'ashlar' ? (cellId - 0.5) * gap * 0.6 : 0;
          const d = Math.min(Math.min(cu, 1 - cu), Math.min(cv, 1 - cv) * (cols / rows));
          t = 1 - smoothstep(gap * 0.5 + wobble, gap, d);
          break;
        }
        case 'plank': {
          const fv = v * rows;
          const row = Math.floor(fv);
          const cv = fv - row;
          // Stagger the butt joints so planks do not all end on the same line.
          const shift = hash2D(wrapi(row, rows), 3, seed) * 0.5;
          const fu = u * cols + shift;
          const col = Math.floor(fu);
          const cu = fu - col;
          cellId = hash2D(wrapi(col, cols), wrapi(row, rows), seed);
          const dv = Math.min(cv, 1 - cv);
          const du = Math.min(cu, 1 - cu);
          t = Math.max(1 - smoothstep(gap * 0.4, gap, dv), 1 - smoothstep(gap * 0.15, gap * 0.4, du));
          break;
        }
        case 'checker': {
          const cu = Math.floor(u * cols);
          const cv2 = Math.floor(v * rows);
          t = (cu + cv2) & 1;
          cellId = hash2D(cu, cv2, seed);
          break;
        }
        case 'grid': {
          const cu = u * cols - Math.floor(u * cols);
          const cv2 = v * rows - Math.floor(v * rows);
          const d = Math.min(Math.min(cu, 1 - cu), Math.min(cv2, 1 - cv2));
          t = 1 - smoothstep(gap * 0.5, gap, d);
          cellId = hash2D(Math.floor(u * cols), Math.floor(v * rows), seed);
          break;
        }
        case 'diamond': {
          const cu = u * cols - Math.floor(u * cols) - 0.5;
          const cv2 = v * rows - Math.floor(v * rows) - 0.5;
          t = smoothstep(0.34, 0.34 + gap, Math.abs(cu) + Math.abs(cv2));
          break;
        }
        case 'hex': {
          // Two offset rows of half-height cells approximate a hex packing cheaply.
          const fv = v * rows;
          const row = Math.floor(fv);
          const cv2 = fv - row;
          const fu = u * cols + (row & 1) * 0.5;
          const cu = fu - Math.floor(fu) - 0.5;
          const d = Math.max(Math.abs(cu) * 2, Math.abs(cv2 - 0.5) * 2 * 0.9 + Math.abs(cu));
          t = smoothstep(0.86, 0.86 + gap * 4, d);
          cellId = hash2D(Math.floor(fu), wrapi(row, rows), seed);
          break;
        }
        case 'weave': {
          const fu = u * cols;
          const fv = v * rows;
          const over = ((Math.floor(fu) + Math.floor(fv)) & 1) === 0;
          const cu = fu - Math.floor(fu) - 0.5;
          const cv2 = fv - Math.floor(fv) - 0.5;
          const s = over ? Math.abs(cv2) : Math.abs(cu);
          t = smoothstep(0.18, 0.5, s);
          break;
        }
        case 'dots': {
          worley2D(u, v, cols, rows, seed, 0.9);
          t = smoothstep(0.18, 0.32, WORLEY[0]);
          cellId = WORLEY[2];
          break;
        }
        case 'stripe':
        default: {
          const s = (u * cols + v * rows) % 1;
          t = smoothstep(0.45, 0.55, Math.abs(s - 0.5) * 2);
          break;
        }
      }

      const jitter = (cellId - 0.5) * variation;
      const idx = (y * size + x) * 4;
      data[idx] = toByte(mix(ca.r, cb.r, t) + jitter);
      data[idx + 1] = toByte(mix(ca.g, cb.g, t) + jitter);
      data[idx + 2] = toByte(mix(ca.b, cb.b, t) + jitter);
      data[idx + 3] = 255;
    }
  }
  return textureFromRGBA(data, size, { colorSpace, repeat, name: `pattern.${kind}` });
}

/**
 * Multi-stop gradient ramp. Drawn on a canvas because 2D gradients handle the
 * interpolation and dithering far more cheaply than hand-rolled per-texel code.
 *
 * With `flipY = false`, stop offset 0 lands at **v = 0**.
 *
 * @param {object} [o]
 * @param {number} [o.size=256]
 * @param {Array<[number, number]>} [o.stops] `[offset, 0xRRGGBB]` pairs
 * @param {'vertical'|'horizontal'|'radial'} [o.direction='vertical']
 * @param {number} [o.noise=0] dither amplitude that hides 8-bit banding
 * @returns {THREE.CanvasTexture}
 */
export function makeGradientTexture(o = {}) {
  const {
    size = 256, stops = [[0, 0x000000], [1, 0xffffff]], direction = 'vertical',
    noise = 0.006, repeat = 1, colorSpace = THREE.SRGBColorSpace, width,
  } = o;

  const w = width ?? (direction === 'vertical' ? 8 : size);
  const h = direction === 'vertical' ? size : direction === 'horizontal' ? 8 : size;
  const canvas = createCanvas(direction === 'radial' ? size : w, direction === 'radial' ? size : h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  let grad;
  if (direction === 'vertical') grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  else if (direction === 'horizontal') grad = ctx.createLinearGradient(0, 0, canvas.width, 0);
  else grad = ctx.createRadialGradient(canvas.width / 2, canvas.height / 2, 0, canvas.width / 2, canvas.height / 2, canvas.width / 2);

  const col = new THREE.Color();
  for (const [offset, hex] of stops) {
    col.set(hex);
    grad.addColorStop(clamp01(offset), `rgb(${Math.round(col.r * 255)},${Math.round(col.g * 255)},${Math.round(col.b * 255)})`);
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (noise > 0) {
    // A whisper of grain: 8-bit ramps band badly once bloom stretches them.
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    const rnd = mulberry32(0xa17e);
    const amp = noise * 255;
    for (let i = 0; i < d.length; i += 4) {
      const n = (rnd() - 0.5) * amp;
      d[i] += n;
      d[i + 1] += n;
      d[i + 2] += n;
    }
    ctx.putImageData(img, 0, 0);
  }

  const tex = new THREE.CanvasTexture(canvas);
  applyTextureDefaults(tex, { colorSpace, repeat, name: 'gradient' });
  if (direction !== 'radial') {
    // A ramp must not repeat across its own gradient axis or the ends hard-cut.
    tex.wrapS = direction === 'vertical' ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    tex.wrapT = direction === 'vertical' ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  }
  return tex;
}

/**
 * Packed occlusion / roughness / metalness map (R / G / B), the layout every
 * material in this project uses so one sampler feeds three inputs.
 *
 * @param {object} [o]
 * @param {number} [o.size=256]
 * @param {number} [o.roughness=0.7] mean roughness
 * @param {number} [o.variance=0.18] +/- roughness swing driven by noise
 * @param {number} [o.frequency=16]
 * @param {number} [o.octaves=3]
 * @param {number} [o.seed=1]
 * @param {number} [o.ao=1] mean ambient occlusion
 * @param {number} [o.aoVariance=0]
 * @param {number} [o.metalness=0]
 * @param {number} [o.metalVariance=0]
 * @returns {THREE.DataTexture}
 */
export function makeRoughnessMap(o = {}) {
  const {
    size = 256, roughness = 0.7, variance = 0.18, frequency = 16, frequencyY = frequency,
    octaves = 3, seed = 1, ao = 1, aoVariance = 0, aoFrequency = 6,
    metalness = 0, metalVariance = 0, repeat = 1,
  } = o;

  const data = new Uint8Array(size * size * 4);
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) * inv;
      const n = fbm2D(u, v, frequency, frequencyY, octaves, seed);
      const a = aoVariance > 0 ? fbm2D(u, v, aoFrequency, aoFrequency, 3, seed + 91) : 0;
      const m = metalVariance > 0 ? fbm2D(u, v, frequency, frequencyY, 2, seed + 173) : 0;
      const idx = (y * size + x) * 4;
      data[idx] = toByte(ao + a * aoVariance);
      data[idx + 1] = toByte(roughness + n * variance);
      data[idx + 2] = toByte(metalness + m * metalVariance);
      data[idx + 3] = 255;
    }
  }
  return textureFromRGBA(data, size, { colorSpace: THREE.NoColorSpace, repeat, name: 'orm' });
}

/**
 * High-frequency detail normal, layered over a base normal (or used alone on
 * surfaces whose macro shape comes from geometry).
 *
 * @param {object} [o]
 * @param {'grain'|'scratch'|'weave'|'ripple'|'pebble'|'brush'} [o.kind='grain']
 * @param {number} [o.size=256]
 * @param {number} [o.frequency=64]
 * @param {number} [o.octaves=3]
 * @param {number} [o.strength=1]
 * @param {number} [o.seed=1]
 * @returns {THREE.DataTexture}
 */
export function makeDetailNormal(o = {}) {
  const {
    kind = 'grain', size = 256, frequency = 64, frequencyY = frequency,
    octaves = 3, strength = 1, seed = 1, repeat = 1,
  } = o;

  const height = new Float32Array(size * size);
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) * inv;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) * inv;
      let h;
      switch (kind) {
        case 'scratch':
          h = Math.pow(ridgedFbm2D(u, v, frequency, Math.max(1, Math.round(frequency / 12)), octaves, seed), 6);
          break;
        case 'weave': {
          const fu = u * frequency;
          const fv = v * frequencyY;
          const over = ((Math.floor(fu) + Math.floor(fv)) & 1) === 0;
          const cu = fu - Math.floor(fu) - 0.5;
          const cv = fv - Math.floor(fv) - 0.5;
          const s = over ? cv : cu;
          h = Math.sqrt(Math.max(0, 0.25 - s * s)) * 2;
          break;
        }
        case 'ripple': {
          domainWarp2D(u, v, 3, 0.06, seed);
          h = fbm01(WARP[0], WARP[1], frequency, frequencyY, octaves, seed, 0.55);
          break;
        }
        case 'pebble':
          worley2D(u, v, frequency, frequencyY, seed, 0.95);
          h = smoothstep(0, 0.45, WORLEY[0]);
          break;
        case 'brush':
          h = fbm01(u, v, Math.max(1, Math.round(frequency / 24)), frequency * 6, 2, seed, 0.6);
          break;
        case 'grain':
        default:
          h = fbm01(u, v, frequency, frequencyY, octaves, seed, 0.55);
          break;
      }
      height[y * size + x] = h;
    }
  }
  return makeNormalFromHeight(height, size, { strength, repeat, name: `detail.${kind}` });
}
