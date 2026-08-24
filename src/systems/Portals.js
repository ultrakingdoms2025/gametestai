import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CONFIG } from '../core/Config.js';
import { buildMatchingSlots } from '../gfx/LightRig.js';
import {
  planPreviewWarm,
  chunkUnits,
  runSliced,
  immediateScheduler,
} from '../gfx/PreviewWarm.js';

/**
 * AETHER NEXUS gateways.
 *
 * A portal is four things stacked on top of each other:
 *
 *  1. An ornate arch whose *style matches the destination world*, so the gateway
 *     itself advertises where it goes before you can see through it.
 *  2. A shader event horizon - domain-warped fbm in polar space flowing inward,
 *     multi-layer parallax so it reads as a tunnel rather than a decal, fresnel
 *     rim, chromatic separation at the edge and a caustic shimmer.
 *  3. A live render of the destination world composited underneath that swirl,
 *     drawn into a render target from a camera standing at the arrival point.
 *     Refreshed every 6th frame and only inside 40 m, which keeps a full second
 *     scene render down to roughly a tenth of a frame's cost.
 *  4. GPU particles (motes spiralling inward, embers rising off the plinth),
 *     animated entirely in the vertex shader so the CPU never touches them.
 *
 * Everything is generated procedurally: no textures, meshes or fonts are loaded.
 */

/* ------------------------------------------------------------------ */
/* Module scratch - never allocate in a per-frame path.                */
/* ------------------------------------------------------------------ */
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();
const _col = new THREE.Color();
const _dir = new THREE.Vector3();

const PLINTH_TOP = 0.42;
const DISC_R = CONFIG.portal.radius;
const DISC_Y = PLINTH_TOP + DISC_R * 0.94;
const ARCH_R = DISC_R + 0.36;

/**
 * Height of the event horizon's centre above a portal's spec position, and its
 * radius.
 *
 * Exported because worlds build their own framing around a gateway - the
 * station wraps one in a machined iris and two concentric rings - and that
 * framing has to be concentric with the aperture it is framing. The station had
 * its surround hard-coded at 2.45 while the disc sat at spec + 2.68, so the two
 * were nearly three metres apart: the rings hugged the floor while the portal
 * itself floated above them, which is what made a gateway read as though only
 * its top half existed. Importing the number is the only way the two stay
 * together when either moves.
 */
export const PORTAL_DISC_OFFSET_Y = DISC_Y;
export const PORTAL_DISC_RADIUS = DISC_R;
/** Dais tiers, base first. `top` is the walkable height of each step. */
const PLINTH_TIERS = [
  { r: 4.15, top: 0.14 },
  { r: 3.72, top: 0.28 },
  { r: 3.30, top: PLINTH_TOP },
];
/** Prompt radius: activationRange is measured from the disc, not the centre. */
const NEAR_RANGE = CONFIG.portal.activationRange + DISC_R + 1.4;
const PREVIEW_RANGE = 40;
const PREVIEW_INTERVAL = 6;

/**
 * Camera layer the time-sliced preview warm draws on, and nothing else ever
 * uses. Channel 31 rather than 1 so that a future feature reaching for "the
 * first spare layer" cannot silently join the warm's draws.
 * @see _drawPreviewSlice
 */
const WARM_LAYER = 31;

/**
 * Distinct shader programs drawn per idle callback by the sliced warm.
 *
 * One, because this is the number that bounds the worst case. A first draw of a
 * program whose link has resolved costs about half a millisecond; a first draw
 * of one that has not costs about 163 ms, and the hold below exists to make the
 * second case rare rather than impossible. One per callback is what keeps the
 * rare case a frame instead of a freeze.
 * @see ../gfx/PreviewWarm.js
 */
const WARM_UNITS_PER_SLICE = 1;

/**
 * Programs whose links are *issued* per idle callback.
 *
 * Issuing is much cheaper than drawing but it is not free: ANGLE translates
 * GLSL to HLSL inside `glCompileShader`, synchronously, so one `compile()` over
 * a whole destination measured 377 ms and 929 ms on two runs of the sports
 * gateway - the largest thing left in the warm once the draws were spread. Four
 * at a time keeps that under a frame or two while costing a quarter of the
 * callbacks a per-program pass would.
 */
const WARM_UNITS_PER_COMPILE = 4;

/**
 * Milliseconds the draws hold off after `compile()` has issued their links,
 * when the driver cannot be asked whether it has finished them.
 *
 * `compile()` does not wait for a link; drawing does. Given a gap the driver
 * resolves them off the main thread and the draws cost nothing, and the size of
 * the gap decides the whole result. Measured on the medieval gateway, same
 * session, same 48 slices, only this constant changed:
 *
 *     hold        blocking total     worst slice
 *        0 ms          4424 ms          1574 ms
 *     8000 ms           166 ms            29 ms
 *
 * Nothing is idle during the hold - the game runs at frame rate, the gateway
 * simply keeps its stabilising disc a few seconds longer. What it costs is the
 * tail of the background settle, and that is the trade: a longer settle nobody
 * can see against a 1.5 s freeze they can.
 *
 * A fixed guess is only the fallback, because it is wrong in both directions:
 * eight seconds is dead time when the driver finished in one, and not enough
 * when the machine is loaded - measured while walking, single slices still cost
 * 3.0 s and 3.5 s through an 8 s hold. Where the driver can be asked,
 * `_previewLinksResolved` replaces the guess with the answer.
 */
const WARM_SETTLE_MS = 8000;

/**
 * Ceiling on the hold when the driver *can* be asked. Only a backstop against a
 * program that never reports ready; the normal release is the answer itself,
 * which usually comes in well under a second.
 */
const WARM_SETTLE_CAP_MS = 30000;

/**
 * Ceiling on the post-swap shader warmup, milliseconds. Generous, because the
 * white-out is already holding for the world build and a compile that runs long
 * is still far better than the freeze it replaces - but finite, so a driver
 * that never reports completion cannot strand the player mid-transition.
 */
const PORTAL_WARM_BUDGET_MS = 8000;

/**
 * Gateway spill lights held permanently in the scene. Must be >= the most
 * portals any single world declares (currently two, in the station); spare
 * entries idle at intensity 0 and cost nothing but a few ALU ops.
 */
const PORTAL_LIGHT_POOL = 4;

/* --- walk-through detection ---------------------------------------- */
/** Aperture the chest must be inside for a plane crossing to count as entry. */
const ENTRY_R2 = DISC_R * DISC_R * 0.86;
/** The player must clear this (or step a stride off the plane) to re-arm. */
const REARM_R2 = DISC_R * DISC_R * 1.55;
const REARM_DEPTH = 1.15;
/**
 * How high above the feet the crossing test is taken. `fixedUpdate` below uses
 * this literal; it is named here so a checker cannot drift from it.
 */
const CHEST_RISE = 0.95;

/**
 * Where a body standing at `feet` sits relative to a gateway's aperture.
 *
 * ── WHY THIS IS EXPORTED ─────────────────────────────────────────────────
 * A review framing that stands behind a gateway, inside its silhouette, is not
 * a framing of that world: `Harness._vantage` pins the player at the camera,
 * the pin is a plane-side crossing, `fixedUpdate` below fires `enter`, and the
 * shot is of somewhere else. `VIEWS.sports`' `entrance-portal` did exactly
 * that and its row reported 3.1 M triangles of the STATION as sports'.
 *
 * `scripts/tests/harness-framings.test.mjs` checks every framing against this,
 * and it calls THIS function rather than re-deriving the arithmetic, because a
 * checker that re-derives is a second copy that can be wrong on its own. The
 * numbers below - the disc offset, the normal, the aperture, the chest rise -
 * are the ones `fixedUpdate` uses, and there is only one of each.
 *
 * @param {{position:{x:number,y:number,z:number}, rotationY:number}} spec a
 *   world's `portalSpecs` row.
 * @param {number[]} feet world position of the standing body's FEET.
 * @returns {{side:number, depth:number, radius:number, insideAperture:boolean,
 *   wouldCross:boolean}} `side` +1 is the near (world) side of the disc;
 *   `wouldCross` means a body appearing here is on the far side AND inside the
 *   aperture, which is the state that fires an entry.
 */
export function portalAperture(spec, feet) {
  const rot = spec.rotationY ?? 0;
  const nx = Math.sin(rot);
  const nz = Math.cos(rot);
  const rx = Math.cos(rot);
  const rz = -Math.sin(rot);
  const dx = feet[0] - spec.position.x;
  const dy = (feet[1] + CHEST_RISE) - (spec.position.y + DISC_Y);
  const dz = feet[2] - spec.position.z;
  const w = dx * nx + dz * nz;
  const u = dx * rx + dz * rz;
  const rad2 = u * u + dy * dy;
  const insideAperture = rad2 < ENTRY_R2;
  return {
    side: w >= 0 ? 1 : -1,
    depth: w,
    radius: Math.sqrt(rad2),
    insideAperture,
    wouldCross: w < 0 && insideAperture,
  };
}

/** The aperture radius a chest must be inside for a crossing to count. */
export const PORTAL_ENTRY_RADIUS = Math.sqrt(ENTRY_R2);
/**
 * Grace period after a world swap. `WorldManager.activate` drops the player a
 * couple of metres in front of the return gateway and the capsule then settles
 * onto the dais over the next few fixed steps; without this window that settle
 * can read as a crossing and fire the player straight back where they came from.
 */
const ARM_DELAY = 0.9;

/**
 * Ceiling for the event horizon's emission, in linear scene-referred units.
 * The disc is composited *before* bloom, so an uncapped shader turns the whole
 * gateway into a white lozenge the moment a world's bloom threshold drops. The
 * knee below is asymptotic to this value: the rim still clears every world's
 * threshold and glows, while the throat and the destination window stay in the
 * midtones where structure survives.
 */
const EMISSIVE_CAP = 2.05;

/* ------------------------------------------------------------------ */
/* Procedural texture generation                                       */
/* ------------------------------------------------------------------ */

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}

/**
 * Cheap 2D value noise + fbm, used to paint every surface map.
 * Integer bit-mixing rather than the usual sin() hash: this runs a few million
 * times per texture and sin() dominated the generation cost.
 */
function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return a * (1 - ux) * (1 - uy) + b * ux * (1 - uy) + c * (1 - ux) * uy + d * ux * uy;
}
function fbm2(x, y, octaves, seed) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * vnoise(x, y, seed + i * 17);
    norm += amp;
    x *= 2.03;
    y *= 2.01;
    amp *= 0.52;
  }
  return sum / norm;
}

/**
 * Paint a tiling albedo canvas by blending two colours with fbm, then let the
 * caller stamp structure (mortar courses, panel seams, chevrons) on top.
 */
function paintBase(canvas, opts) {
  const size = canvas.width;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(size, size);
  const data = img.data;
  const [r0, g0, b0] = opts.base;
  const [r1, g1, b1] = opts.tint;
  const scale = opts.scale ?? 5;
  const oct = opts.octaves ?? 5;
  const seed = opts.seed ?? 1;
  const contrast = opts.contrast ?? 1;
  const streak = opts.streak ?? 0;
  const grain = opts.grain ?? 0.05;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * scale;
      const v = (y / size) * scale;
      let n = fbm2(u, v, oct, seed);
      if (streak > 0) {
        // Brushed metal: stretch the noise hard along one axis.
        n = n * (1 - streak) + fbm2(u * 26, v * 0.6, 3, seed + 9) * streak;
      }
      n = Math.min(1, Math.max(0, (n - 0.5) * contrast + 0.5));
      const g = (hash2(x, y, seed + 3) - 0.5) * grain;
      const i = (y * size + x) * 4;
      data[i] = Math.min(255, Math.max(0, (r0 + (r1 - r0) * n + g * 255) | 0));
      data[i + 1] = Math.min(255, Math.max(0, (g0 + (g1 - g0) * n + g * 255) | 0));
      data[i + 2] = Math.min(255, Math.max(0, (b0 + (b1 - b0) * n + g * 255) | 0));
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return ctx;
}

/** Sobel a canvas' luminance into a tangent-space normal map canvas. */
function normalFromCanvas(src, strength) {
  const size = src.width;
  const sctx = src.getContext('2d', { willReadFrequently: true });
  const s = sctx.getImageData(0, 0, size, size).data;
  const out = makeCanvas(size);
  const octx = out.getContext('2d');
  const img = octx.createImageData(size, size);
  const d = img.data;

  // Precompute luminance once; the sobel taps it nine times per pixel.
  const L = new Float32Array(size * size);
  for (let i = 0, p = 0; i < L.length; i++, p += 4) {
    L[i] = (s[p] * 0.299 + s[p + 1] * 0.587 + s[p + 2] * 0.114) / 255;
  }
  const mask = size - 1;
  const isPow2 = (size & mask) === 0;
  const lum = isPow2
    ? (x, y) => L[((y & mask) * size) | (x & mask)]
    : (x, y) => L[(((y % size) + size) % size) * size + (((x % size) + size) % size)];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx =
        lum(x - 1, y - 1) + 2 * lum(x - 1, y) + lum(x - 1, y + 1) -
        (lum(x + 1, y - 1) + 2 * lum(x + 1, y) + lum(x + 1, y + 1));
      const dy =
        lum(x - 1, y - 1) + 2 * lum(x, y - 1) + lum(x + 1, y - 1) -
        (lum(x - 1, y + 1) + 2 * lum(x, y + 1) + lum(x + 1, y + 1));
      let nx = dx * strength;
      let ny = dy * strength;
      const nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv;
      ny *= inv;
      const i = (y * size + x) * 4;
      d[i] = ((nx * 0.5 + 0.5) * 255) | 0;
      d[i + 1] = ((ny * 0.5 + 0.5) * 255) | 0;
      d[i + 2] = ((nz * inv * 0.5 + 0.5) * 255) | 0;
      d[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

/** Remap a canvas' luminance into a roughness range, with a little breakup. */
function roughnessFromCanvas(src, lo, hi, invert) {
  const size = src.width;
  const s = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, size, size).data;
  const out = makeCanvas(size);
  const octx = out.getContext('2d');
  const img = octx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let l = (s[i] * 0.299 + s[i + 1] * 0.587 + s[i + 2] * 0.114) / 255;
      if (invert) l = 1 - l;
      const n = vnoise((x / size) * 24, (y / size) * 24, 55) * 0.14 - 0.07;
      const r = Math.min(1, Math.max(0, lo + (hi - lo) * l + n));
      const v = (r * 255) | 0;
      d[i] = v;
      d[i + 1] = v;
      d[i + 2] = v;
      d[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                    */
/* ------------------------------------------------------------------ */

/**
 * A single arch block (voussoir): an annular sector centred on +X, extruded
 * with a real bevel so the edges catch a highlight.
 */
function arcBlockGeometry(inner, outer, halfAngle, depth, bevel = 0.025) {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, outer, -halfAngle, halfAngle, false);
  shape.absarc(0, 0, inner, halfAngle, -halfAngle, true);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: 0,
    bevelSegments: 1,
    curveSegments: 5,
    steps: 1,
  });
  geo.translate(0, 0, -depth * 0.5);
  geo.computeVertexNormals();
  return geo;
}

/** Chamfered slab profile extruded along Z - used for lintels and plates. */
function chamferPlateGeometry(w, h, depth, chamfer = 0.06) {
  const hw = w * 0.5;
  const hh = h * 0.5;
  const s = new THREE.Shape();
  s.moveTo(-hw + chamfer, -hh);
  s.lineTo(hw - chamfer, -hh);
  s.lineTo(hw, -hh + chamfer);
  s.lineTo(hw, hh - chamfer);
  s.lineTo(hw - chamfer, hh);
  s.lineTo(-hw + chamfer, hh);
  s.lineTo(-hw, hh - chamfer);
  s.lineTo(-hw, -hh + chamfer);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, {
    depth,
    bevelEnabled: true,
    bevelThickness: 0.02,
    bevelSize: 0.02,
    bevelSegments: 1,
    steps: 1,
  });
  geo.translate(0, 0, -depth * 0.5);
  geo.computeVertexNormals();
  return geo;
}

/* ------------------------------------------------------------------ */
/* Shaders                                                             */
/* ------------------------------------------------------------------ */

const NOISE_GLSL = /* glsl */ `
float h21(vec2 p){ p = fract(p * vec2(123.34, 345.45)); p += dot(p, p + 34.345); return fract(p.x * p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = h21(i), b = h21(i + vec2(1.0,0.0)), c = h21(i + vec2(0.0,1.0)), d = h21(i + vec2(1.0,1.0));
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
}
float fbm(vec2 p){
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); n += a; p = p * 2.07 + vec2(1.7, 9.2); a *= 0.52; }
  return s / n;
}`;

const HORIZON_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const HORIZON_FRAG = /* glsl */ `
precision highp float;
uniform float uTime;
uniform float uHasPreview;
uniform float uStability;
uniform float uIntensity;
uniform float uPreviewScale;
uniform float uPreviewExposure;
uniform float uPreviewGain;
uniform float uCap;
uniform vec3 uAccent;
uniform vec3 uAccentHot;
uniform vec3 uRight;
uniform vec3 uUpAxis;
uniform vec3 uNormalAxis;
uniform sampler2D uPreview;
varying vec2 vUv;
varying vec3 vWorld;
${NOISE_GLSL}

/**
 * Value ordering, brightest last, is the whole point of this shader:
 *
 *   throat (darkest)  <  destination window  <  swirl  <  iris  <  rim lip
 *
 * A gateway is a hole punched into somewhere else. If the centre is the
 * brightest thing on screen it reads as a lamp, every internal feature is
 * crushed by bloom and there is nothing for a camera to frame. So the core is
 * held down deliberately, the destination render is the mid-tone subject, and
 * only the outer lip is allowed near the clipping point.
 */
void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float r = length(p);
  if (r > 1.0) discard;
  vec2 dir = r > 0.0001 ? p / r : vec2(0.0, 1.0);
  float ang = atan(p.y, p.x);

  // View direction expressed in the disc's own tangent frame. Drives both the
  // fresnel and the parallax, and is what stops this reading as a flat decal.
  vec3 V = normalize(cameraPosition - vWorld);
  float facing = clamp(abs(dot(V, uNormalAxis)), 0.0, 1.0);
  vec2 par = vec2(dot(V, uRight), dot(V, uUpAxis)) / (facing + 0.18);

  // Polar tunnel coordinates: 1/r pushes detail toward the centre, and the
  // swirl angle grows with depth so the whole field spirals inward.
  float rr = max(r, 0.075);
  float depth = 0.62 / rr;
  float swirl = uTime * 0.42 + depth * 0.85;
  float cs = cos(swirl), sn = sin(swirl);
  vec2 rd = vec2(dir.x * cs - dir.y * sn, dir.x * sn + dir.y * cs);

  // Three parallax layers accumulated back-to-front = tunnel depth.
  float acc = 0.0;
  float wsum = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float layer = 0.10 + fi * 0.17;
    vec2 tp = rd * (depth - uTime * 0.55 + fi * 0.55) + par * layer * (1.0 - r * 0.45);
    // Domain warp keeps the plasma from ever looking like plain fbm.
    vec2 w = vec2(fbm(tp * 1.3 + uTime * 0.11), fbm(tp * 1.3 + vec2(4.7, 2.3) - uTime * 0.09));
    float fl = fbm(tp + w * 1.9 + fi * 3.7);
    float weight = 1.0 / (1.0 + fi * 1.35);
    acc += fl * weight;
    wsum += weight;
  }
  float f = acc / wsum;
  f = pow(clamp(f, 0.0, 1.0), 1.35);

  /* Live destination preview, sampled as a window with parallax + chromatic
   * edge.
   *
   * The parallax vector is divided by the facing term, so it grows without
   * bound as the aperture is viewed off-axis - and it then slides the sample
   * window clean off the render target. Every sample past the edge clamps to
   * the same border texel, so instead of a destination the player got one flat
   * pale band. That
   * is what made a gateway read as "only half there" when stood in front of and
   * looked slightly across, which is exactly how you approach one on foot.
   *
   * Two guards. The offset is bounded, so the window stays on the target while
   * keeping the depth cue that makes this read as a hole rather than a decal.
   * And whatever still escapes fades into the plasma rather than repeating a
   * border texel, so the worst case is "the swirl hides the far side" - which
   * the effect does deliberately anyway - instead of a grey hole. */
  vec2 parBounded = par / (1.0 + length(par) * 0.55);
  vec2 base = p * uPreviewScale;
  base += parBounded * 0.085 * (1.0 - r * r);
  base += (f - 0.5) * 0.045 * (0.35 + r);
  vec2 ca = dir * (0.005 + pow(r, 3.0) * 0.030);
  vec2 puv = 0.5 + base;
  vec2 fade = smoothstep(vec2(0.0), vec2(0.05), puv) *
              (1.0 - smoothstep(vec2(0.95), vec2(1.0), puv));
  float inWindow = fade.x * fade.y;
  vec3 prev;
  prev.r = texture2D(uPreview, clamp(puv + ca, 0.002, 0.998)).r;
  prev.g = texture2D(uPreview, clamp(puv, 0.002, 0.998)).g;
  prev.b = texture2D(uPreview, clamp(puv - ca, 0.002, 0.998)).b;
  // The target holds raw linear HDR: a golden-hour sun disc in it measures two
  // orders of magnitude above the grass under it. Lift the whole image, then
  // knee it, so the destination's midtones become legible without its sky
  // punching a second white hole through the middle of the gateway.
  prev *= uPreviewExposure * uPreviewGain;
  prev = prev / (1.0 + prev * 0.62);
  // Push the destination's own colour. Compressed HDR desaturates toward white,
  // and a white window is indistinguishable from the plasma in front of it -
  // the green of a field or the cyan of a hull is what identifies the exit.
  prev = mix(vec3(dot(prev, vec3(0.2126, 0.7152, 0.0722))), prev, 1.35);

  float rim  = smoothstep(0.60, 1.0, r);
  float fres = pow(1.0 - facing, 2.6);
  float lip  = smoothstep(0.945, 1.0, r);

  // Radial falloff toward the throat. Also gates how much light the window is
  // allowed to give back, so the far world dims into the tunnel mouth.
  float throat = mix(0.16, 1.0, smoothstep(0.08, 0.96, r));

  vec3 plasma = mix(uAccent * 0.12, uAccentHot * 0.30, f) + pow(f, 5.0) * uAccentHot * 0.38;
  plasma *= throat;

  // The swirl veils the window in streaks: thicker plasma hides more of the far
  // side, so the destination breathes in and out rather than sitting there flat.
  float win = uHasPreview * uStability * (1.0 - smoothstep(0.58, 0.95, r));
  float show = clamp(win * (0.96 - 0.20 * f) * inWindow, 0.0, 0.97);
  vec3 col = mix(plasma, prev * (0.74 + 0.36 * throat), show);

  // Readable machinery: twelve aperture blades riding just inside the rim and
  // two hairline iris rings. These are the hard edges the eye locks onto - they
  // are what turns a smear of noise into something with a centre and a scale.
  // Kept short and thin; long spokes read as a lens flare, not an aperture.
  float blade = abs(sin(ang * 12.0 - uTime * 0.22));
  float iris  = smoothstep(0.91, 1.0, blade) *
                smoothstep(0.68, 0.74, r) * (1.0 - smoothstep(0.84, 0.92, r));
  float ring1 = exp(-pow((r - 0.375) * 86.0, 2.0));
  float ring2 = exp(-pow((r - 0.585) * 66.0, 2.0));
  col += uAccentHot * (iris * 0.42 + ring1 * 0.24 + ring2 * 0.18) * (0.55 + 0.45 * uStability);

  // Caustic shimmer skating across the surface.
  float caus = pow(abs(sin(f * 11.0 + uTime * 2.1 + depth * 0.6)), 10.0);
  col += uAccentHot * caus * (0.18 + 0.26 * r) * 0.38;

  // Rim: fresnel glow plus a hard chromatic lip right at the event horizon.
  col += uAccentHot * (rim * rim * 0.78 + fres * 0.40);
  col += uAccentHot * lip * 1.00;
  // A darker gutter just inside the lip. Without it the disc bleeds into the
  // arch and the frame loses its inner silhouette against the glow.
  col *= 1.0 - 0.42 * smoothstep(0.78, 0.92, r) * (1.0 - smoothstep(0.92, 1.0, r));

  // STABILISING: the gateway has no destination yet, so it tears and rolls.
  float unstable = 1.0 - uStability;
  if (unstable > 0.001) {
    float band = fract(vUv.y * 5.0 - uTime * 0.9);
    float tear = step(0.86, band) * (0.5 + 0.5 * sin(uTime * 47.0));
    col = mix(col, col.brg * 1.4 + vec3(0.15), unstable * tear);
    col *= 1.0 - unstable * 0.30 * (0.5 + 0.5 * sin(uTime * 23.0 + r * 12.0));
  }

  col *= uIntensity;

  // Soft ceiling, applied last so the proximity surge cannot punch through it.
  // Reinhard rather than a clamp: a hard clamp flattens the rim into a solid
  // ring, this keeps a gradient all the way up to the asymptote.
  col = col / (1.0 + col / uCap);

  /* Opaque across the face, feathered only at the rim.
   *
   * The mid-band used to sit at 0.82, which reads as a slightly glassy horizon
   * on an empty backdrop and as a window onto the architecture behind it
   * everywhere else. The two portals on the Z axis have a clear backdrop by
   * design - the skyline builder refuses to place anything on a gateway
   * sightline - but the pair on the X axis look straight at the promenade loop
   * 32 m behind them, so the walkway deck cut a hard horizontal bar across the
   * event horizon with its signage legible through the swirl, and the disc read
   * as two different fields above and below it.
   *
   * Only the stability fade stays translucent: a portal that has not formed yet
   * *should* be see-through, because it is not a surface yet. */
  float alpha = 1.0 - smoothstep(0.93, 1.0, r);
  alpha = clamp(alpha + rim * 0.25 + lip, 0.0, 1.0);
  alpha *= mix(0.75, 1.0, uStability);

  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const HALO_VERT = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const HALO_FRAG = /* glsl */ `
precision mediump float;
uniform vec3 uAccent;
uniform float uTime;
uniform float uIntensity;
varying vec2 vUv;
void main(){
  vec2 p = (vUv - 0.5) * 2.0;
  float r = length(p);
  float a = atan(p.y, p.x);
  // Hollow: the disc already owns everything inside r=0.62, and stacking the
  // halo on top of it was a big part of why the gateway read as one flat blob.
  float glow = exp(-pow(max(r - 0.60, 0.0) * 5.2, 2.0)) * smoothstep(0.50, 0.62, r);
  float flick = 0.86 + 0.14 * sin(a * 9.0 + uTime * 2.3) * sin(uTime * 1.7);
  gl_FragColor = vec4(uAccent * glow * flick * uIntensity * 0.55, glow * 0.8);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const MOTE_VERT = /* glsl */ `
attribute vec4 aSeed;   // angle0, radius0, speed, size
attribute float aPhase;
uniform float uTime;
uniform float uSeed;
uniform float uRadius;
uniform float uBoost;
varying float vAlpha;
varying float vHeat;
void main() {
  float life = fract(uTime * aSeed.z + aPhase + uSeed);
  float e = pow(life, 2.3);                        // accelerate hard into the throat
  float r = mix(aSeed.y, 0.015, e) * uRadius;
  float ang = aSeed.x + uSeed * 6.283 + life * (4.5 + aSeed.z * 9.0) + uTime * 0.3;
  float z = sin(life * 3.14159) * 0.30 * (1.0 - e);
  vec4 mv = modelViewMatrix * vec4(cos(ang) * r, sin(ang) * r, z, 1.0);
  gl_Position = projectionMatrix * mv;
  float px = aSeed.w * (1.0 - e * 0.5) * uBoost;
  // Hard ceiling on the sprite size: unclamped, a mote standing five metres off
  // the disc covered a tenth of it and the destination window disappeared
  // behind a snowstorm. Motes are garnish; they must never be the subject.
  gl_PointSize = clamp(px * (150.0 / max(-mv.z, 0.25)), 1.0, 13.0);
  vAlpha = smoothstep(0.0, 0.10, life) * (1.0 - smoothstep(0.80, 1.0, life));
  vHeat = e;
}`;

const MOTE_FRAG = /* glsl */ `
precision mediump float;
uniform vec3 uAccent;
uniform vec3 uAccentHot;
varying float vAlpha;
varying float vHeat;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5) discard;
  float core = exp(-d * d * 26.0);
  vec3 col = mix(uAccent, uAccentHot, vHeat) + vec3(core * 0.30);
  gl_FragColor = vec4(col * (0.30 + vHeat * 0.85), core * vAlpha * 0.75);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const EMBER_VERT = /* glsl */ `
attribute vec4 aSeed;   // x0, z0, speed, size
attribute float aPhase;
uniform float uTime;
uniform float uSeed;
uniform float uHeight;
varying float vAlpha;
void main() {
  float life = fract(uTime * aSeed.z * 0.35 + aPhase + uSeed);
  float y = life * uHeight;
  float sway = sin(life * 7.0 + aSeed.x * 9.0 + uTime * 0.8) * 0.28 * life;
  vec4 mv = modelViewMatrix * vec4(aSeed.x + sway, y, aSeed.y + sway * 0.6, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSeed.w * (120.0 / max(-mv.z, 0.25)) * (1.0 - life * 0.5), 1.0, 10.0);
  vAlpha = smoothstep(0.0, 0.08, life) * (1.0 - smoothstep(0.45, 1.0, life));
}`;

const EMBER_FRAG = /* glsl */ `
precision mediump float;
uniform vec3 uAccent;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5) discard;
  float core = exp(-d * d * 20.0);
  gl_FragColor = vec4(uAccent * (0.35 + core * 0.55), core * vAlpha * 0.7);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const WARP_VERT = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const WARP_FRAG = /* glsl */ `
precision highp float;
uniform float uTime;
uniform float uProgress;   // 0..1 collapse
uniform float uFlash;      // 0..1 white-out
uniform float uRing;       // shockwave radius, <0 = inactive
uniform float uAspect;
uniform vec3 uAccent;
varying vec2 vUv;
${NOISE_GLSL}

void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  p.x *= uAspect;
  float r = length(p);
  float a = atan(p.y, p.x);

  // Radial streaks racing toward the centre.
  float streak = vnoise(vec2(a * 13.0, -r * 5.5 + uTime * 7.0));
  streak = pow(streak, 3.0) * smoothstep(0.05, 1.1, r);
  float turb = fbm(vec2(a * 4.0, r * 3.0 - uTime * 2.2));

  float warp = uProgress * uProgress;
  vec3 col = uAccent * (streak * 2.6 + turb * 0.55) * warp;

  // Tunnel vignette collapsing inward. smoothstep edges must stay ascending -
  // a reversed pair is undefined in GLSL ES and blows out on some drivers.
  float edge = max(0.08, 1.35 - warp * 1.25);
  float vig = 1.0 - smoothstep(edge * 0.45, edge, r);
  float alpha = warp * (0.30 + 0.70 * (1.0 - vig)) + streak * warp * 0.55;

  // Expanding shockwave on the way out.
  if (uRing >= 0.0) {
    float ring = exp(-pow((r - uRing) * 7.0, 2.0));
    col += (uAccent * 1.5 + vec3(0.9)) * ring * 1.6;
    alpha += ring * 0.85;
  }

  col += vec3(1.0, 0.985, 0.97) * uFlash * 2.2;
  alpha = clamp(alpha + uFlash, 0.0, 1.0);

  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/* ------------------------------------------------------------------ */
/* PortalSystem                                                        */
/* ------------------------------------------------------------------ */

export class PortalSystem {
  /**
   * @param {{ scene: THREE.Scene, engine: any, physics: any, bus: any,
   *           materials: any, input?: any, player: any, worldManager: any }} ctx
   */
  constructor({ scene, engine, physics, bus, materials, input, player, worldManager, npcManager }) {
    this.scene = scene;
    this.engine = engine;
    this.renderer = engine.renderer;
    this.physics = physics;
    this.bus = bus;
    this.materials = materials;
    this.input = input ?? null;
    this.player = player;
    this.worldManager = worldManager;
    this.npcManager = npcManager ?? null;

    this._maxAniso = this.renderer.capabilities?.getMaxAnisotropy?.() ?? 4;

    /**
     * Gateway spill lights, pooled.
     *
     * These used to be created per portal and parented to the portal root, so
     * the scene's point-light count followed however many gateways the current
     * world happened to have - two in the station, one in the medieval world.
     * Three keys its shader program cache on light counts, so that alone meant
     * no program could ever be shared between worlds, and it silently defeated
     * the destination pre-compile: everything queued for the destination was
     * keyed to the *departure* world's portal count and thrown away on arrival.
     *
     * A fixed pool that is added to the scene once and never removed makes the
     * count constant. Unused entries idle at intensity 0, which costs a few ALU
     * ops and, unlike `visible = false`, does not change the count.
     */
    this._portalLights = [];
    for (let i = 0; i < PORTAL_LIGHT_POOL; i++) {
      const l = new THREE.PointLight(0x4de3ff, 0, 18, 1.8);
      l.castShadow = false;
      l.name = `portal:spill:${i}`;
      this.scene.add(l);
      this._portalLights.push(l);
    }

    /** @type {any[]} */
    this._portals = [];
    this._worldId = null;
    this._near = null;
    this._frame = 0;
    this._transition = null;
    /** engine.elapsed before which no walk-through entry may register. */
    this._armAt = 0;

    /** Shared, style-independent resources. Survive clear(); freed in dispose(). */
    this._kits = new Map();
    this._texCache = new Map();
    this._signCache = new Map();
    this._discGeo = new THREE.CircleGeometry(DISC_R, 96);
    this._haloGeo = new THREE.RingGeometry(DISC_R * 0.9, DISC_R * 1.72, 96, 1);
    this._moteGeo = this._buildMoteGeometry(520);
    this._emberGeo = this._buildEmberGeometry(180);

    this._buildPreviewRig();
    this._buildWarpOverlay();
  }

  /** @returns {any[]} live portals: `{ position, target, label, accent, mesh, ... }` */
  get portals() {
    return this._portals;
  }

  /** The portal the player is currently standing at, or null. */
  get nearPortal() {
    return this._near;
  }

  /**
   * Light the nearest gateway up for `seconds`, and hand it back.
   *
   * The Gatefinder consumable promised, in the catalogue and in `ItemDefs`, to
   * *highlight* the nearest portal; all it ever did was print the destination
   * name to the HUD, which is a hint, not a highlight. This is the highlight:
   * `update()` reads `_pingUntil` and drives the disc, halo, motes and spill
   * light off a pulse for as long as it holds.
   *
   * Extends rather than replaces - a second charge on an already-lit gateway
   * must not cut the first one short, so the deadline only ever moves forward.
   *
   * @param {number} seconds
   * @param {{x:number,y:number,z:number}} [from] Origin to measure from;
   *   defaults to the player.
   * @returns {any|null} the portal that was lit, or null if there are none.
   */
  pingNearest(seconds, from) {
    const origin = from ?? this.player?.position ?? null;
    if (!origin || this._portals.length === 0) return null;
    let best = null;
    let bestD2 = Infinity;
    for (const p of this._portals) {
      if (!p?.position) continue;
      const dx = p.position.x - origin.x;
      const dy = p.position.y - origin.y;
      const dz = p.position.z - origin.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = p;
      }
    }
    if (!best) return null;
    const now = this.engine?.elapsed ?? 0;
    const hold = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    best._pingUntil = Math.max(best._pingUntil ?? 0, now + hold);
    this.bus?.emit('portal:ping', {
      portal: best,
      target: best.target,
      id: best.id ?? best.target,
      label: best.label ?? null,
      seconds: hold,
      until: best._pingUntil,
    });
    return best;
  }

  /** True while a world transition is playing. */
  get isTransitioning() {
    return this._transition !== null;
  }

  /* ---------------------------------------------------------------- */
  /* Build                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Instantiate every portal declared by a world. Called by WorldManager right
   * after the world becomes active (and after physics has been rebuilt, so the
   * plinth colliders registered here survive).
   * @param {import('../worlds/World.js').World} world
   */
  buildForWorld(world) {
    this.clear();
    if (!world) return;
    this._worldId = world.id;
    // Nothing may auto-enter until the player has settled wherever activation
    // just put them - see ARM_DELAY.
    this._armAt = (this.engine?.elapsed ?? 0) + ARM_DELAY;
    const specs = world.portalSpecs ?? [];
    for (let i = 0; i < specs.length; i++) {
      try {
        this._portals.push(this._createPortal(specs[i], i));
      } catch (err) {
        console.error('[Portals] failed to build portal', specs[i], err);
      }
    }
  }

  _createPortal(spec, index) {
    const target = spec.target;
    const accent = new THREE.Color(spec.accent ?? 0x4de3ff);
    const accentHot = accent.clone().lerp(new THREE.Color(0xffffff), 0.55);
    const rotationY = spec.rotationY ?? 0;

    const root = new THREE.Group();
    root.name = `portal:${target}`;
    root.position.copy(spec.position);
    root.rotation.y = rotationY;

    // --- frame, styled after the destination -------------------------
    const kit = this._kit(target, spec.style);
    const frame = kit.template.clone(true);
    this._retintAccents(frame, accent);
    // Gateways are emissive energy structures whose arch shadows are barely
    // legible against their own glow, yet re-rendering every frame's shadow map
    // pays for each frame mesh of every always-visible portal. In the station
    // hub (four permanent gateways) that measured 102 shadow draw calls (~6% of
    // the frame) for no visible ground shadow. Cast off, receive on.
    frame.traverse((o) => { if (o.isMesh) o.castShadow = false; });
    root.add(frame);

    // --- event horizon ----------------------------------------------
    const right = new THREE.Vector3(Math.cos(rotationY), 0, -Math.sin(rotationY));
    const up = new THREE.Vector3(0, 1, 0);
    const normal = new THREE.Vector3(Math.sin(rotationY), 0, Math.cos(rotationY));

    const discMat = new THREE.ShaderMaterial({
      vertexShader: HORIZON_VERT,
      fragmentShader: HORIZON_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uHasPreview: { value: 0 },
        uStability: { value: 0.25 },
        uIntensity: { value: 1 },
        /* 0.47, not 0.52. At 0.52 the window spans 0.5 +/- 0.52, so the aperture
         * edges sampled outside the render target before any parallax was even
         * added. Under half keeps the whole disc on the target with headroom for
         * the offsets stacked on top of it. */
        uPreviewScale: { value: 0.47 },
        uPreviewExposure: { value: 1 },
        // The preview target holds raw linear scene values with no exposure or
        // tone map applied, which lands a lit exterior around 0.1-0.5 - far too
        // dim to survive next to the swirl. This lifts it into the midtones.
        uPreviewGain: { value: 3.6 },
        uCap: { value: EMISSIVE_CAP },
        uAccent: { value: accent.clone() },
        uAccentHot: { value: accentHot },
        uRight: { value: right },
        uUpAxis: { value: up },
        uNormalAxis: { value: normal },
        uPreview: { value: null },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: true,
    });
    const disc = new THREE.Mesh(this._discGeo, discMat);
    disc.position.set(0, DISC_Y, 0);
    disc.renderOrder = 3;
    disc.frustumCulled = false;
    root.add(disc);

    const haloMat = new THREE.ShaderMaterial({
      vertexShader: HALO_VERT,
      fragmentShader: HALO_FRAG,
      uniforms: {
        uAccent: { value: accentHot.clone() },
        uTime: { value: 0 },
        uIntensity: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const halo = new THREE.Mesh(this._haloGeo, haloMat);
    halo.position.set(0, DISC_Y, -0.02);
    halo.renderOrder = 2;
    halo.frustumCulled = false;
    root.add(halo);

    // --- particles ---------------------------------------------------
    const moteMat = new THREE.ShaderMaterial({
      vertexShader: MOTE_VERT,
      fragmentShader: MOTE_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uSeed: { value: index * 0.37 },
        uRadius: { value: DISC_R * 1.25 },
        uBoost: { value: 1 },
        uAccent: { value: accent.clone() },
        uAccentHot: { value: accentHot.clone() },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const motes = new THREE.Points(this._moteGeo, moteMat);
    motes.position.set(0, DISC_Y, 0);
    motes.renderOrder = 4;
    root.add(motes);

    const emberMat = new THREE.ShaderMaterial({
      vertexShader: EMBER_VERT,
      fragmentShader: EMBER_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uSeed: { value: index * 0.61 },
        uHeight: { value: 4.2 },
        uAccent: { value: accentHot.clone() },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const embers = new THREE.Points(this._emberGeo, emberMat);
    embers.position.set(0, PLINTH_TOP, 0);
    embers.renderOrder = 4;
    root.add(embers);

    // --- light spill -------------------------------------------------
    // Decay is slightly under the physical 2.0 so the spill reaches the plaza
    // floor instead of dying inside the arch. Kept modest on purpose: the disc
    // is capped now, so a 20-candela spill would out-shine the thing casting it
    // and blow the dais out to white in front of the gateway.
    // Borrowed from the permanent pool, not created here, and positioned in
    // world space because it deliberately does not hang off `root` - see
    // `_portalLights`. Gateways never move, so this is set once.
    const light = this._portalLights[index] ?? null;
    if (light) {
      light.color.copy(accent);
      light.distance = 18;
      light.decay = 1.8;
      light.position.set(0, DISC_Y, 0.35).applyEuler(root.rotation).add(root.position);
    }

    // --- destination sign --------------------------------------------
    const name = this.worldManager?.displayNameOf?.(target) ?? spec.label ?? target;
    const sign = this._buildSign(name, 'GATEWAY', accent);
    sign.position.set(0, DISC_Y + ARCH_R + 0.72, 0);
    root.add(sign);

    this.scene.add(root);

    /* --- collision: walkable plinth, solid jambs ----------------------
     *
     * ── The launch aperture has NONE of it ────────────────────────────────
     * A blast-door aperture is flush with the deck it stands in: no dais, no
     * processional steps, no jambs. Skipping the plinth is only safe because
     * the DECK is solid there and `arrivalFor` snaps an arriving body onto
     * whatever the ground probe finds - `buildForWorld` runs after the physics
     * rebuild and before the player is placed for exactly that reason
     * (`WorldManager.js:371-378`), and the plinth is normally the ground under
     * the arrival point. `dock-launch.test.mjs` asserts the deck is solid
     * under both ends of this pair, which is the assertion that makes the
     * omission safe rather than lucky.
     *
     * The dais is round, so each tier is approximated by two boxes 45 degrees
     * apart - an octagon within ~4% of the visible silhouette. */
    const colliders = [];
    const flush = kit.style === 'launch';
    for (const tier of flush ? [] : PLINTH_TIERS) {
      const h = tier.r * 0.96;
      _v1.set(spec.position.x, spec.position.y + tier.top * 0.5, spec.position.z);
      _v2.set(h, tier.top * 0.5, h);
      for (const twist of [0, Math.PI / 4]) {
        colliders.push(
          this.physics.addRotatedBox(_v1, _v2, rotationY + twist, {
            userData: { portal: target },
          })
        );
      }
    }
    // Front approach steps get their own colliders, otherwise the player walks
    // straight through the visible stair and pops up onto the dais.
    const sinY = Math.sin(rotationY);
    const cosY = Math.cos(rotationY);
    for (let s = 0; flush ? false : s < 3; s++) {
      const tier = PLINTH_TIERS[s];
      const zL = tier.r + 0.47 - s * 0.02;
      _v1.set(
        spec.position.x + sinY * zL,
        spec.position.y + tier.top * 0.5,
        spec.position.z + cosY * zL
      );
      colliders.push(
        this.physics.addRotatedBox(_v1, _v2.set(1.7 - s * 0.2, tier.top * 0.5, 0.31), rotationY, {
          userData: { portal: target },
        })
      );
    }

    const jambHalfH = (DISC_Y - PLINTH_TOP) * 0.5;
    for (const sx of flush ? [] : [-1, 1]) {
      const ox = sx * ARCH_R;
      _v1.set(
        spec.position.x + Math.cos(rotationY) * ox,
        spec.position.y + PLINTH_TOP + jambHalfH,
        spec.position.z - Math.sin(rotationY) * ox
      );
      colliders.push(
        this.physics.addRotatedBox(_v1, _v3.set(0.42, jambHalfH, 0.42), rotationY, {
          userData: { portal: target },
        })
      );
    }

    const portal = {
      id: `${this._worldId}->${target}`,
      worldId: this._worldId,
      target,
      label: spec.label ?? `Gateway to ${name}`,
      targetName: name,
      accent,
      position: spec.position.clone(),
      rotationY,
      normal,
      right,
      /** World-space centre of the event horizon; used for entry tests. */
      discPosition: new THREE.Vector3(
        spec.position.x,
        spec.position.y + DISC_Y,
        spec.position.z
      ),
      root,
      mesh: disc,
      discMat,
      haloMat,
      moteMat,
      emberMat,
      light,
      sign,
      colliders,
      rt: null,
      previewCam: null,
      previewPhase: index % PREVIEW_INTERVAL,
      ready: false,
      announced: false,
      previewFailed: false,
      /** Set once the destination has been rendered at least one time. */
      _primed: false,
      /**
       * True while `warmPreviews` still has slices to draw for this gateway.
       * The 10 Hz preview in `update()` is held off until it clears - drawing
       * the destination before the warm has linked it IS the multi-second
       * freeze the warm exists to remove.
       */
      _warmPending: false,
      state: 'stabilising',
      /** Walk-through entry is disabled until the player is clear of the disc. */
      _armed: false,
      _side: 0,
      _lightPhase: index * 1.7,
      _proximity: 0,
      /** engine.elapsed until which `pingNearest` keeps this gateway lit. */
      _pingUntil: 0,
      /** True while that hold is running. Read by anything drawing the world. */
      pinged: false,
    };
    return portal;
  }

  /**
   * Swap accent-tagged materials for ones tinted to this portal's colour, so a
   * single shared arch template can serve gateways of any hue.
   */
  _retintAccents(group, accent) {
    const hex = accent.getHexString();
    const key = `accent:${hex}`;
    let mat = this._texCache.get(key);
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({
        color: accent.clone().multiplyScalar(0.35),
        emissive: accent.clone(),
        // Status lenses read as lenses at ~2; above that they fuse into one
        // bloomed bar and the ring stops having countable lights on it.
        emissiveIntensity: 2.1,
        roughness: 0.35,
        metalness: 0.1,
      });
      this._texCache.set(key, mat);
    }

    const runeKey = `rune:${hex}`;
    let runeMat = this._texCache.get(runeKey);

    group.traverse((o) => {
      if (!o.isMesh) return;
      if (o.userData.accent) {
        o.material = mat;
      } else if (o.userData.runeBand) {
        if (!runeMat) {
          runeMat = new THREE.MeshBasicMaterial({
            map: this._runeTexture(),
            color: accent.clone().lerp(new THREE.Color(0xffffff), 0.35),
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            side: THREE.DoubleSide,
          });
          this._texCache.set(runeKey, runeMat);
        }
        o.material = runeMat;
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /* Style kits                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Build (once) the shared arch template + materials for a destination style.
   *
   * ── Why a spec may name its own style ─────────────────────────────────────
   * This branched only on `target`, which is right while every portal in the
   * game is a ceremonial gateway on a plaza. The launch portal at Lodestar
   * Yard is not: it is an aperture in a blast door at the end of a working
   * bay, and left to the default it would grow an alloy arch with three
   * processional approach steps, two jambs and a stepped dais in the middle of
   * a hangar floor. Worse, the two legs of that pair could not agree - the
   * outbound names `space` and the inbound names `dock`, so a target-only
   * branch would have to name both, and the next world with a plain gateway to
   * the yard would silently inherit the blast door.
   *
   * So a world may declare `style` on the spec itself, and only the styles
   * this file knows are honoured. Everything with no opinion behaves exactly
   * as it did.
   */
  _kit(target, wanted = null) {
    // The citadel borrows the medieval arch: it is cut stone with a keystone,
    // which is what a gateway into a fortress town should be. Anything
    // unrecognised still falls back to the station's alloy frame.
    const style = wanted === 'launch' ? 'launch'
      : target === 'medieval' || target === 'citadel' ? 'medieval'
        : target === 'sports' ? 'sports'
          : 'station';
    let kit = this._kits.get(style);
    if (kit) return kit;
    kit = { style, template: new THREE.Group(), disposables: [] };
    if (style === 'medieval') this._buildMedievalArch(kit);
    else if (style === 'sports') this._buildSportsArch(kit);
    else if (style === 'launch') this._buildLaunchAperture(kit);
    else this._buildStationArch(kit);
    // Emissive trim and fake volumetrics must not write to the shadow map or
    // they punch black holes in the light spill they are meant to sell.
    kit.template.traverse((o) => {
      if (!o.isMesh) return;
      const solid = o.userData.noShadow !== true;
      o.castShadow = solid;
      o.receiveShadow = solid;
    });
    this._kits.set(style, kit);
    return kit;
  }

  /** Cached PBR set. `spec` describes the noise field; `stamp` draws structure. */
  _surface(key, spec) {
    let mat = this._texCache.get(key);
    if (mat) return mat;
    const size = spec.size ?? 512;
    const albedo = makeCanvas(size);
    const ctx = paintBase(albedo, spec);
    spec.stamp?.(ctx, size);

    const map = new THREE.CanvasTexture(albedo);
    map.colorSpace = THREE.SRGBColorSpace;
    const normalMap = new THREE.CanvasTexture(normalFromCanvas(albedo, spec.bump ?? 2.4));
    const roughnessMap = new THREE.CanvasTexture(
      roughnessFromCanvas(albedo, spec.roughLo ?? 0.35, spec.roughHi ?? 0.9, spec.roughInvert)
    );
    for (const t of [map, normalMap, roughnessMap]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = this._maxAniso;
      t.repeat.set(spec.repeat ?? 1, spec.repeat ?? 1);
    }
    normalMap.colorSpace = THREE.NoColorSpace;
    roughnessMap.colorSpace = THREE.NoColorSpace;

    mat = new THREE.MeshStandardMaterial({
      map,
      normalMap,
      roughnessMap,
      normalScale: new THREE.Vector2(spec.normalScale ?? 1, spec.normalScale ?? 1),
      metalness: spec.metalness ?? 0,
      roughness: 1,
      color: spec.color ?? 0xffffff,
      envMapIntensity: spec.envMapIntensity ?? 1,
    });
    this._texCache.set(key, mat);
    return mat;
  }

  /* ---- STATION: machined alloy ring, status lights, hazard chevrons ---- */

  _buildStationArch(kit) {
    const g = kit.template;
    const alloy = this._surface('alloy', {
      base: [96, 104, 116],
      tint: [176, 186, 198],
      scale: 3,
      octaves: 4,
      streak: 0.55,
      contrast: 1.25,
      grain: 0.03,
      metalness: 0.95,
      roughLo: 0.22,
      roughHi: 0.52,
      bump: 1.6,
      repeat: 2,
      stamp: (ctx, s) => {
        // Machined panel seams + micro fasteners.
        ctx.strokeStyle = 'rgba(30,36,44,0.75)';
        ctx.lineWidth = Math.max(1, s / 340);
        for (let i = 1; i < 4; i++) {
          ctx.beginPath();
          ctx.moveTo(0, (s * i) / 4);
          ctx.lineTo(s, (s * i) / 4);
          ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(228,236,244,0.16)';
        for (let i = 1; i < 4; i++) {
          ctx.beginPath();
          ctx.moveTo(0, (s * i) / 4 + 1.5);
          ctx.lineTo(s, (s * i) / 4 + 1.5);
          ctx.stroke();
        }
        ctx.fillStyle = 'rgba(24,28,34,0.6)';
        for (let i = 0; i < 48; i++) {
          const x = hash2(i, 3, 7) * s;
          const y = hash2(i, 9, 11) * s;
          ctx.beginPath();
          ctx.arc(x, y, s / 190, 0, Math.PI * 2);
          ctx.fill();
        }
      },
    });
    const deck = this._surface('deckplate', {
      base: [58, 64, 74],
      tint: [112, 122, 134],
      scale: 4,
      octaves: 5,
      contrast: 1.1,
      metalness: 0.8,
      roughLo: 0.4,
      roughHi: 0.82,
      bump: 3.2,
      repeat: 3,
      stamp: (ctx, s) => {
        ctx.strokeStyle = 'rgba(18,22,28,0.85)';
        ctx.lineWidth = Math.max(1.5, s / 150);
        for (let i = 0; i <= 4; i++) {
          ctx.beginPath();
          ctx.moveTo((s * i) / 4, 0);
          ctx.lineTo((s * i) / 4, s);
          ctx.moveTo(0, (s * i) / 4);
          ctx.lineTo(s, (s * i) / 4);
          ctx.stroke();
        }
        ctx.fillStyle = 'rgba(200,210,220,0.09)';
        for (let i = 0; i < 200; i++) {
          const x = hash2(i, 21, 5) * s;
          const y = hash2(i, 31, 13) * s;
          ctx.fillRect(x, y, s / 120, s / 120);
        }
      },
    });
    const hazard = this._surface('hazard', {
      base: [30, 30, 32],
      tint: [58, 58, 62],
      scale: 6,
      octaves: 3,
      metalness: 0.5,
      roughLo: 0.4,
      roughHi: 0.75,
      bump: 1.2,
      repeat: 1,
      stamp: (ctx, s) => {
        ctx.save();
        ctx.fillStyle = '#e8a819';
        ctx.translate(s / 2, s / 2);
        ctx.rotate(Math.PI / 4);
        for (let i = -6; i < 8; i++) ctx.fillRect(i * (s / 5), -s, s / 10, s * 2);
        ctx.restore();
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        for (let i = 0; i < 120; i++) {
          const x = hash2(i, 71, 3) * s;
          const y = hash2(i, 17, 29) * s;
          ctx.fillRect(x, y, s / 90, s / 90);
        }
      },
    });

    this._addPlinth(g, deck, alloy);

    // Machined ring: 8 radial segments gives a faceted, milled cross-section.
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(ARCH_R, 0.34, 8, 96, Math.PI),
      alloy
    );
    ring.position.y = DISC_Y;
    g.add(ring);
    kit.disposables.push(ring.geometry);

    const innerRing = new THREE.Mesh(
      new THREE.TorusGeometry(ARCH_R - 0.30, 0.10, 6, 80, Math.PI),
      alloy
    );
    innerRing.position.y = DISC_Y;
    g.add(innerRing);
    kit.disposables.push(innerRing.geometry);

    // Jambs with hazard-striped kick plates.
    for (const sx of [-1, 1]) {
      const post = new THREE.Mesh(new RoundedBoxGeometry(0.78, DISC_Y, 0.72, 2, 0.05), alloy);
      post.position.set(sx * ARCH_R, DISC_Y * 0.5, 0);
      g.add(post);
      kit.disposables.push(post.geometry);

      const kick = new THREE.Mesh(new RoundedBoxGeometry(0.86, 0.62, 0.80, 2, 0.04), hazard);
      kick.position.set(sx * ARCH_R, 0.86, 0);
      g.add(kick);
      kit.disposables.push(kick.geometry);

      const cap = new THREE.Mesh(new RoundedBoxGeometry(0.94, 0.20, 0.88, 2, 0.05), alloy);
      cap.position.set(sx * ARCH_R, DISC_Y - 0.06, 0);
      g.add(cap);
      kit.disposables.push(cap.geometry);

      // Conduit runs up the outside of each post.
      const conduit = new THREE.Mesh(
        new THREE.CylinderGeometry(0.055, 0.055, DISC_Y - 0.4, 8),
        alloy
      );
      conduit.position.set(sx * (ARCH_R + 0.44), DISC_Y * 0.5, 0.2);
      g.add(conduit);
      kit.disposables.push(conduit.geometry);
    }

    /* Impost band at the springing line - one block per pier, not one plate
     * across the opening.
     *
     * It used to be a single chamfered plate `ARCH_R * 2 + 0.6` wide sitting at
     * `DISC_Y`, which is architecturally where a springing course goes and
     * visually straight through the middle of the event horizon: `DISC_Y` is
     * the disc's *centre*, not its head. The result was an opaque bar bisecting
     * every portal, with the disc reading as two unrelated fields above and
     * below it. The band only ever belonged on the piers; the span between them
     * is the opening. */
    const impostW = ARCH_R + 0.3 - DISC_R;
    for (const sx of [-1, 1]) {
      const impost = new THREE.Mesh(chamferPlateGeometry(impostW, 0.34, 0.30), alloy);
      impost.position.set(sx * (DISC_R + impostW * 0.5), DISC_Y + 0.02, 0);
      g.add(impost);
      kit.disposables.push(impost.geometry);
    }

    // Status lights around the ring - accent tinted per portal at clone time.
    const lensGeo = new THREE.CylinderGeometry(0.075, 0.075, 0.09, 10);
    lensGeo.rotateX(Math.PI / 2);
    const lights = new THREE.InstancedMesh(lensGeo, this._placeholderAccent(), 44);
    lights.userData.accent = true;
    lights.userData.noShadow = true;
    let n = 0;
    for (let i = 0; i < 22; i++) {
      const t = (i + 0.5) / 22;
      const a = Math.PI * t;
      for (const zs of [1, -1]) {
        _v1.set(Math.cos(a) * (ARCH_R + 0.30), DISC_Y + Math.sin(a) * (ARCH_R + 0.30), zs * 0.30);
        _q1.setFromAxisAngle(_v3.set(0, 1, 0), zs > 0 ? 0 : Math.PI);
        _m1.compose(_v1, _q1, _v2.set(1, 1, 1));
        lights.setMatrixAt(n++, _m1);
      }
    }
    lights.count = n;
    lights.instanceMatrix.needsUpdate = true;
    lights.castShadow = false;
    g.add(lights);
    kit.disposables.push(lensGeo);
  }

  /* ---- LAUNCH: a blast-door aperture, flush with the deck ---------- */

  /**
   * The aperture in the blast door at the north end of Lodestar Yard.
   *
   * ── What this is NOT, and why that is the whole point ─────────────────────
   * Every other portal in the Nexus is a CEREMONIAL GATEWAY: an arch on a
   * stepped dais with two jambs and a processional approach, standing on a
   * plaza. That is right for a door between worlds that a civilisation built
   * to be walked through. It is completely wrong for the last thing a ship
   * passes before open space, and left alone `_kit`'s default would have put
   * one in the middle of a hangar floor - three steps up to a dais, an alloy
   * arch, and a set of status lights, ten metres from a sealed 34 m blast door
   * that already IS the way out.
   *
   * So: no arch, no steps, no jambs, no dais. A ring concentric with
   * `PORTAL_DISC_OFFSET_Y` - imported rather than remembered, which is exactly
   * why that constant is exported - a floor pool the ring stands out of, and
   * four hold-down clamps at the quadrants. The collider block skips the
   * plinth for this style, so the deck the yard already laid is the ground.
   *
   * It is built at 60-odd lines against the station arch's 130 because it is
   * the absence of things.
   */
  _buildLaunchAperture(kit) {
    const g = kit.template;
    const steel = this._surface('launchsteel', {
      base: [72, 78, 88],
      tint: [150, 160, 174],
      scale: 3,
      octaves: 4,
      streak: 0.4,
      contrast: 1.2,
      grain: 0.04,
      metalness: 0.9,
      roughLo: 0.3,
      roughHi: 0.62,
      bump: 2.0,
      repeat: 2,
      stamp: (ctx, sz) => {
        // Radial seam plates and a ring of countersunk bolts: an aperture is
        // machined, not carved.
        ctx.strokeStyle = 'rgba(24,30,38,0.8)';
        ctx.lineWidth = Math.max(1, sz / 300);
        for (let i = 0; i < 8; i++) {
          ctx.beginPath();
          ctx.moveTo((sz * i) / 8, 0);
          ctx.lineTo((sz * i) / 8, sz);
          ctx.stroke();
        }
        ctx.fillStyle = 'rgba(18,22,28,0.7)';
        for (let i = 0; i < 64; i++) {
          const x = hash2(i, 5, 3) * sz;
          const y = hash2(i, 11, 7) * sz;
          ctx.beginPath();
          ctx.arc(x, y, sz / 210, 0, Math.PI * 2);
          ctx.fill();
        }
      },
    });

    /* The aperture ring. Concentric with the event horizon, which is what the
     * exported offset is for: the station's own surround was hard-coded at
     * 2.45 while the disc sat at 2.68, and the two being three quarters of a
     * metre apart is what made a gateway read as though only its top half
     * existed. */
    const ring = new THREE.Mesh(new THREE.TorusGeometry(ARCH_R + 0.05, 0.30, 10, 64), steel);
    ring.position.y = DISC_Y;
    g.add(ring);
    kit.disposables.push(ring.geometry);

    // A second, thinner ring inboard, so the aperture has a lip to look into.
    const lip = new THREE.Mesh(new THREE.TorusGeometry(DISC_R + 0.06, 0.08, 8, 56), steel);
    lip.position.y = DISC_Y;
    g.add(lip);
    kit.disposables.push(lip.geometry);

    /* Four hold-down clamps at the quadrants, and nothing between them: the
     * ring is bolted to the deck, not standing on a plinth. */
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      const clamp = new THREE.Mesh(new RoundedBoxGeometry(0.52, 0.34, 0.62, 2, 0.04), steel);
      clamp.position.set(
        Math.cos(a) * (ARCH_R + 0.05),
        DISC_Y + Math.sin(a) * (ARCH_R + 0.05),
        0
      );
      clamp.rotation.z = a;
      g.add(clamp);
      kit.disposables.push(clamp.geometry);
    }

    /* The floor pool: a shallow recessed disc the aperture rises out of,
     * FLUSH, with a hazard ring painted round it. This is what replaces the
     * dais - the thing a player stands on is the yard's own deck. */
    const pool = new THREE.Mesh(new THREE.RingGeometry(0.6, ARCH_R + 0.9, 48, 1), steel);
    pool.rotation.x = -Math.PI / 2;
    pool.position.y = 0.012;
    pool.receiveShadow = true;
    g.add(pool);
    kit.disposables.push(pool.geometry);

    /* Status lights along the ring, accent-tinted per portal when cloned. A
     * blast door has these because a blast door is interlocked; they are the
     * one piece of ceremony an aperture is allowed. */
    const lensGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.1, 10);
    lensGeo.rotateX(Math.PI / 2);
    const lights = new THREE.InstancedMesh(lensGeo, this._placeholderAccent(), 40);
    lights.userData.accent = true;
    lights.userData.noShadow = true;
    let n = 0;
    for (let i = 0; i < 20; i++) {
      const a = (Math.PI * 2 * (i + 0.5)) / 20;
      for (const zs of [1, -1]) {
        _v1.set(Math.cos(a) * (ARCH_R + 0.38), DISC_Y + Math.sin(a) * (ARCH_R + 0.38), zs * 0.26);
        _q1.setFromAxisAngle(_v3.set(0, 1, 0), zs > 0 ? 0 : Math.PI);
        _m1.compose(_v1, _q1, _v2.set(1, 1, 1));
        lights.setMatrixAt(n++, _m1);
      }
    }
    lights.count = n;
    lights.instanceMatrix.needsUpdate = true;
    lights.castShadow = false;
    g.add(lights);
    kit.disposables.push(lensGeo);
  }

  /* ---- MEDIEVAL: carved voussoirs, iron banding, glowing runes ---- */

  _buildMedievalArch(kit) {
    const g = kit.template;
    const stone = this._surface('stone', {
      base: [96, 90, 80],
      tint: [176, 168, 152],
      scale: 4.5,
      octaves: 6,
      contrast: 1.35,
      grain: 0.07,
      metalness: 0,
      roughLo: 0.62,
      roughHi: 0.98,
      bump: 3.6,
      normalScale: 1.3,
      repeat: 1,
      stamp: (ctx, s) => {
        // Chisel tooling + pitting, then a dusting of moss in the recesses.
        ctx.strokeStyle = 'rgba(52,46,38,0.35)';
        ctx.lineWidth = Math.max(1, s / 420);
        for (let i = 0; i < 260; i++) {
          const x = hash2(i, 5, 2) * s;
          const y = hash2(i, 15, 8) * s;
          const a = hash2(i, 25, 4) * Math.PI;
          const l = s / 34 + hash2(i, 35, 6) * (s / 26);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
          ctx.stroke();
        }
        ctx.fillStyle = 'rgba(40,36,30,0.45)';
        for (let i = 0; i < 190; i++) {
          const x = hash2(i, 45, 9) * s;
          const y = hash2(i, 55, 12) * s;
          ctx.beginPath();
          ctx.arc(x, y, s / 400 + hash2(i, 65, 3) * (s / 200), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = 'rgba(86,104,54,0.20)';
        for (let i = 0; i < 70; i++) {
          const x = hash2(i, 75, 14) * s;
          const y = hash2(i, 85, 16) * s;
          ctx.beginPath();
          ctx.arc(x, y, s / 70 + hash2(i, 95, 18) * (s / 45), 0, Math.PI * 2);
          ctx.fill();
        }
      },
    });
    const cobble = this._surface('cobble', {
      base: [70, 66, 60],
      tint: [138, 130, 118],
      scale: 7,
      octaves: 5,
      contrast: 1.5,
      metalness: 0,
      roughLo: 0.7,
      roughHi: 1,
      bump: 4.5,
      repeat: 2,
      stamp: (ctx, s) => {
        ctx.strokeStyle = 'rgba(34,30,26,0.8)';
        ctx.lineWidth = Math.max(1.5, s / 140);
        const n = 7;
        for (let r = 0; r < n; r++) {
          const y = (s * r) / n;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(s, y);
          ctx.stroke();
          const off = (r % 2) * (s / (n * 2));
          for (let c = 0; c <= n; c++) {
            const x = (s * c) / n + off;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x, y + s / n);
            ctx.stroke();
          }
        }
      },
    });
    const iron = this._surface('iron', {
      base: [38, 36, 38],
      tint: [96, 88, 82],
      scale: 5,
      octaves: 4,
      contrast: 1.4,
      streak: 0.25,
      metalness: 0.9,
      roughLo: 0.42,
      roughHi: 0.86,
      bump: 2.6,
      repeat: 1,
      stamp: (ctx, s) => {
        ctx.fillStyle = 'rgba(122,72,34,0.30)';
        for (let i = 0; i < 90; i++) {
          const x = hash2(i, 3, 21) * s;
          const y = hash2(i, 13, 23) * s;
          ctx.beginPath();
          ctx.arc(x, y, s / 120 + hash2(i, 23, 25) * (s / 60), 0, Math.PI * 2);
          ctx.fill();
        }
      },
    });

    this._addPlinth(g, cobble, stone);

    // Voussoirs: 17 wedge blocks with per-block jitter so the arch reads hand-cut.
    const SEG = 17;
    const half = (Math.PI / SEG) * 0.47;
    const blockGeo = arcBlockGeometry(ARCH_R - 0.40, ARCH_R + 0.42, half, 0.86, 0.035);
    const voussoirs = new THREE.InstancedMesh(blockGeo, stone, SEG);
    for (let i = 0; i < SEG; i++) {
      const a = (Math.PI * (i + 0.5)) / SEG;
      const jitter = (hash2(i, 1, 2) - 0.5) * 0.05;
      _q1.setFromAxisAngle(_v3.set(0, 0, 1), a);
      _v1.set(0, DISC_Y, (hash2(i, 4, 3) - 0.5) * 0.03);
      _v2.set(1 + jitter, 1 + jitter, 1 + (hash2(i, 7, 5) - 0.5) * 0.12);
      _m1.compose(_v1, _q1, _v2);
      voussoirs.setMatrixAt(i, _m1);
    }
    voussoirs.instanceMatrix.needsUpdate = true;
    g.add(voussoirs);
    kit.disposables.push(blockGeo);

    // Keystone.
    const keyGeo = arcBlockGeometry(ARCH_R - 0.46, ARCH_R + 0.62, half * 1.5, 0.98, 0.04);
    const keystone = new THREE.Mesh(keyGeo, stone);
    keystone.position.y = DISC_Y;
    keystone.rotation.z = Math.PI / 2;
    g.add(keystone);
    kit.disposables.push(keyGeo);

    // Jamb stonework: alternating course widths.
    const jambGeo = new RoundedBoxGeometry(0.86, 0.46, 0.90, 2, 0.03);
    const courses = 6;
    const jambs = new THREE.InstancedMesh(jambGeo, stone, courses * 2);
    let n = 0;
    for (const sx of [-1, 1]) {
      for (let i = 0; i < courses; i++) {
        const wide = i % 2 === 0 ? 1.06 : 0.94;
        _v1.set(sx * ARCH_R, 0.30 + i * 0.44, 0);
        _q1.identity();
        _v2.set(wide, 1, wide);
        _m1.compose(_v1, _q1, _v2);
        jambs.setMatrixAt(n++, _m1);
      }
    }
    jambs.instanceMatrix.needsUpdate = true;
    g.add(jambs);
    kit.disposables.push(jambGeo);

    // Corbels where the arch springs from the jambs.
    for (const sx of [-1, 1]) {
      const corbel = new THREE.Mesh(chamferPlateGeometry(1.1, 0.30, 1.0, 0.12), stone);
      corbel.position.set(sx * ARCH_R, DISC_Y - 0.05, 0);
      g.add(corbel);
      kit.disposables.push(corbel.geometry);
    }

    // Iron straps banding the arch, with hammered rivets.
    const strapGeo = new RoundedBoxGeometry(0.13, 1.02, 0.11, 1, 0.03);
    const rivetGeo = new THREE.IcosahedronGeometry(0.055, 0);
    const STRAPS = 7;
    const straps = new THREE.InstancedMesh(strapGeo, iron, STRAPS * 2);
    const rivets = new THREE.InstancedMesh(rivetGeo, iron, STRAPS * 4);
    let si = 0;
    let ri = 0;
    for (let i = 0; i < STRAPS; i++) {
      const a = (Math.PI * (i + 0.5)) / STRAPS;
      for (const zs of [1, -1]) {
        _v1.set(Math.cos(a) * ARCH_R, DISC_Y + Math.sin(a) * ARCH_R, zs * 0.46);
        _q1.setFromAxisAngle(_v3.set(0, 0, 1), a - Math.PI / 2);
        _m1.compose(_v1, _q1, _v2.set(1, 1, 1));
        straps.setMatrixAt(si++, _m1);
        // A hammered rivet at each end of every strap.
        for (const e of [0.42, -0.42]) {
          const rr = ARCH_R + e;
          _v1.set(Math.cos(a) * rr, DISC_Y + Math.sin(a) * rr, zs * 0.52);
          _m1.compose(_v1, _q1, _v2.set(1, 1, 1));
          rivets.setMatrixAt(ri++, _m1);
        }
      }
    }
    straps.instanceMatrix.needsUpdate = true;
    rivets.instanceMatrix.needsUpdate = true;
    g.add(straps, rivets);
    kit.disposables.push(strapGeo, rivetGeo);

    // Carved rune band glowing on the inner face of the arch. The material here
    // is only a stand-in - _retintAccents swaps in a per-accent tinted copy.
    const runeMat = new THREE.MeshBasicMaterial({
      map: this._runeTexture(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    for (const zs of [1, -1]) {
      const band = new THREE.Mesh(
        new THREE.RingGeometry(ARCH_R - 0.38, ARCH_R + 0.40, 72, 1, 0, Math.PI),
        runeMat
      );
      band.position.set(0, DISC_Y, zs * 0.455);
      band.renderOrder = 2;
      band.userData.runeBand = true;
      band.userData.noShadow = true;
      g.add(band);
      kit.disposables.push(band.geometry);
    }
    kit.runeMat = runeMat;
  }

  /* ---- SPORTS: anodised gantry, lattice bracing, floodlights ---- */

  _buildSportsArch(kit) {
    const g = kit.template;
    const anodised = this._surface('anodised', {
      base: [30, 96, 148],
      tint: [96, 190, 236],
      scale: 3,
      octaves: 3,
      streak: 0.6,
      contrast: 1.15,
      grain: 0.02,
      metalness: 0.9,
      roughLo: 0.16,
      roughHi: 0.42,
      bump: 1.2,
      repeat: 2,
      stamp: (ctx, s) => {
        ctx.strokeStyle = 'rgba(255,255,255,0.14)';
        ctx.lineWidth = Math.max(1, s / 420);
        for (let i = 0; i < 40; i++) {
          const y = hash2(i, 2, 33) * s;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(s, y);
          ctx.stroke();
        }
      },
    });
    const composite = this._surface('composite', {
      base: [26, 28, 32],
      tint: [72, 78, 86],
      scale: 5,
      octaves: 3,
      contrast: 1.2,
      metalness: 0.35,
      roughLo: 0.28,
      roughHi: 0.6,
      bump: 2.2,
      repeat: 3,
      stamp: (ctx, s) => {
        // Carbon twill weave.
        const cell = s / 16;
        for (let y = 0; y < 16; y++) {
          for (let x = 0; x < 16; x++) {
            const light = (x + y) % 2 === 0;
            ctx.fillStyle = light ? 'rgba(150,158,170,0.20)' : 'rgba(10,12,16,0.35)';
            ctx.fillRect(x * cell, y * cell, cell, cell);
          }
        }
      },
    });
    const court = this._surface('courtdeck', {
      base: [24, 82, 68],
      tint: [46, 132, 108],
      scale: 6,
      octaves: 4,
      contrast: 1.1,
      grain: 0.06,
      metalness: 0,
      roughLo: 0.62,
      roughHi: 0.94,
      bump: 2.0,
      repeat: 2,
      stamp: (ctx, s) => {
        ctx.strokeStyle = 'rgba(248,250,252,0.92)';
        ctx.lineWidth = Math.max(3, s / 64);
        ctx.strokeRect(s * 0.08, s * 0.08, s * 0.84, s * 0.84);
        ctx.lineWidth = Math.max(2, s / 96);
        ctx.beginPath();
        ctx.moveTo(s * 0.5, s * 0.08);
        ctx.lineTo(s * 0.5, s * 0.92);
        ctx.stroke();
      },
    });

    this._addPlinth(g, court, anodised);

    // Twin tube arcs braced by a diagonal lattice.
    const outer = new THREE.Mesh(new THREE.TorusGeometry(ARCH_R + 0.16, 0.16, 12, 88, Math.PI), anodised);
    outer.position.y = DISC_Y;
    g.add(outer);
    kit.disposables.push(outer.geometry);

    const inner = new THREE.Mesh(new THREE.TorusGeometry(ARCH_R - 0.34, 0.13, 12, 88, Math.PI), anodised);
    inner.position.y = DISC_Y;
    g.add(inner);
    kit.disposables.push(inner.geometry);

    const barGeo = new THREE.CylinderGeometry(0.055, 0.055, 1, 7);
    const BARS = 24;
    const lattice = new THREE.InstancedMesh(barGeo, composite, BARS);
    const rOut = ARCH_R + 0.16;
    const rIn = ARCH_R - 0.34;
    for (let i = 0; i < BARS; i++) {
      const a0 = (Math.PI * i) / BARS;
      const a1 = (Math.PI * (i + 1)) / BARS;
      const zig = i % 2 === 0;
      _v1.set(Math.cos(a0) * (zig ? rIn : rOut), DISC_Y + Math.sin(a0) * (zig ? rIn : rOut), 0);
      _v2.set(Math.cos(a1) * (zig ? rOut : rIn), DISC_Y + Math.sin(a1) * (zig ? rOut : rIn), 0);
      _dir.subVectors(_v2, _v1);
      const len = _dir.length();
      _dir.normalize();
      _q1.setFromUnitVectors(_v3.set(0, 1, 0), _dir);
      _v1.lerp(_v2, 0.5);
      _m1.compose(_v1, _q1, _v3.set(1, len, 1));
      lattice.setMatrixAt(i, _m1);
    }
    lattice.instanceMatrix.needsUpdate = true;
    g.add(lattice);
    kit.disposables.push(barGeo);

    // Gantry legs: box-section posts with composite infill panels.
    for (const sx of [-1, 1]) {
      const post = new THREE.Mesh(new RoundedBoxGeometry(0.42, DISC_Y, 0.42, 2, 0.06), anodised);
      post.position.set(sx * (ARCH_R + 0.16), DISC_Y * 0.5, 0);
      g.add(post);
      kit.disposables.push(post.geometry);

      const post2 = new THREE.Mesh(new RoundedBoxGeometry(0.32, DISC_Y, 0.32, 2, 0.05), anodised);
      post2.position.set(sx * (ARCH_R - 0.34), DISC_Y * 0.5, 0);
      g.add(post2);
      kit.disposables.push(post2.geometry);

      const panel = new THREE.Mesh(chamferPlateGeometry(0.46, DISC_Y - 0.9, 0.10, 0.05), composite);
      panel.position.set(sx * (ARCH_R - 0.09), DISC_Y * 0.5, 0);
      panel.rotation.y = Math.PI / 2;
      g.add(panel);
      kit.disposables.push(panel.geometry);

      const foot = new THREE.Mesh(new RoundedBoxGeometry(1.0, 0.22, 0.9, 2, 0.05), anodised);
      foot.position.set(sx * (ARCH_R - 0.09), PLINTH_TOP + 0.11, 0);
      g.add(foot);
      kit.disposables.push(foot.geometry);
    }

    // Floodlight booms with emissive lenses and a faked beam cone.
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0xdfefff,
      transparent: true,
      opacity: 0.10,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    kit.beamMat = beamMat;
    for (const sx of [-1, 1]) {
      for (const t of [0.30, 0.62]) {
        const a = Math.PI * (sx > 0 ? t : 1 - t);
        const bx = Math.cos(a) * (ARCH_R + 0.55);
        const by = DISC_Y + Math.sin(a) * (ARCH_R + 0.55);

        const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.55, 8), anodised);
        boom.position.set(bx, by, 0.28);
        boom.rotation.x = Math.PI / 2;
        g.add(boom);
        kit.disposables.push(boom.geometry);

        const head = new THREE.Mesh(new RoundedBoxGeometry(0.46, 0.30, 0.20, 2, 0.04), composite);
        head.position.set(bx, by, 0.58);
        head.lookAt(0, DISC_Y, 2.4);
        g.add(head);
        kit.disposables.push(head.geometry);

        const lens = new THREE.Mesh(new THREE.PlaneGeometry(0.38, 0.23), this._placeholderAccent());
        lens.userData.accent = true;
        lens.userData.noShadow = true;
        lens.position.set(bx, by, 0.69);
        g.add(lens);
        kit.disposables.push(lens.geometry);

        const beam = new THREE.Mesh(new THREE.ConeGeometry(0.55, 2.6, 12, 1, true), beamMat);
        beam.position.set(bx * 0.72, by - 0.9, 1.15);
        beam.rotation.x = -Math.PI * 0.42;
        beam.userData.noShadow = true;
        g.add(beam);
        kit.disposables.push(beam.geometry);
      }
    }

    // Scoreboard-style header plate.
    const plate = new THREE.Mesh(chamferPlateGeometry(2.2, 0.46, 0.14, 0.06), composite);
    plate.position.set(0, DISC_Y + ARCH_R + 0.28, 0.12);
    g.add(plate);
    kit.disposables.push(plate.geometry);
  }

  /**
   * Stepped dais shared by every style; only the materials change.
   * Kept deliberately compact (4.3 m) so it nests inside whatever monumental
   * framing a world has already built around its gateway plaza.
   */
  _addPlinth(group, deckMat, trimMat) {
    for (let i = 0; i < PLINTH_TIERS.length; i++) {
      const t = PLINTH_TIERS[i];
      const geo = new THREE.CylinderGeometry(t.r, t.r + 0.14, 0.14, 32, 1);
      const m = new THREE.Mesh(geo, i % 2 === 0 ? trimMat : deckMat);
      m.position.y = t.top - 0.07;
      group.add(m);
    }
    // Processional steps projecting off the front so the approach reads as an
    // entrance rather than a plinth someone happened to leave a portal on.
    for (let i = 0; i < 3; i++) {
      const t = PLINTH_TIERS[i];
      const geo = new RoundedBoxGeometry(3.4 - i * 0.4, 0.14, 0.62, 1, 0.02);
      const step = new THREE.Mesh(geo, deckMat);
      step.position.set(0, t.top - 0.07, t.r + 0.47 - i * 0.02);
      group.add(step);
    }
    // Inset ring the disc appears to rise out of.
    const wellGeo = new THREE.RingGeometry(DISC_R * 0.55, DISC_R * 1.02, 48, 1);
    const well = new THREE.Mesh(wellGeo, trimMat);
    well.rotation.x = -Math.PI / 2;
    well.position.y = PLINTH_TOP + 0.005;
    well.receiveShadow = true;
    group.add(well);
  }

  /** Neutral stand-in swapped for the accent-tinted material when cloned. */
  _placeholderAccent() {
    let mat = this._texCache.get('accent:placeholder');
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({
        color: 0x222a33,
        emissive: 0x66ddff,
        emissiveIntensity: 2.5,
        roughness: 0.4,
      });
      this._texCache.set('accent:placeholder', mat);
    }
    return mat;
  }

  /** Radial band of carved rune glyphs, drawn straight into the ring's UV disc. */
  _runeTexture() {
    let tex = this._texCache.get('tex:runes');
    if (tex) return tex;
    const size = 512;
    const c = makeCanvas(size);
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    const cx = size / 2;
    const cy = size / 2;
    // RingGeometry maps uv = 0.5 + xy / (2 * outerRadius).
    const outer = ARCH_R + 0.40;
    const rMid = ((ARCH_R - 0.38 + ARCH_R + 0.40) * 0.5 / (2 * outer)) * size;
    ctx.strokeStyle = '#ffffff';
    ctx.lineCap = 'round';
    for (let i = 0; i < 34; i++) {
      const a = (Math.PI * (i + 0.5)) / 34;
      // Ring spans thetaStart 0..PI in geometry space; canvas Y is flipped.
      const gx = cx + Math.cos(a) * rMid;
      const gy = cy - Math.sin(a) * rMid;
      ctx.save();
      ctx.translate(gx, gy);
      ctx.rotate(-a + Math.PI / 2);
      ctx.lineWidth = 3.2;
      const strokes = 2 + Math.floor(hash2(i, 1, 4) * 3);
      ctx.beginPath();
      ctx.moveTo(0, -11);
      ctx.lineTo(0, 11);
      for (let s = 0; s < strokes; s++) {
        const y = -9 + hash2(i, s, 6) * 18;
        const dx = (hash2(i, s, 9) > 0.5 ? 1 : -1) * (4 + hash2(i, s, 11) * 5);
        const dy = (hash2(i, s, 13) - 0.5) * 9;
        ctx.moveTo(0, y);
        ctx.lineTo(dx, y + dy);
      }
      ctx.stroke();
      ctx.restore();
    }
    tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this._maxAniso;
    this._texCache.set('tex:runes', tex);
    return tex;
  }

  /** Holographic destination plate. Text is drawn with canvas2d - no font files. */
  _buildSign(name, label, accent) {
    const key = `sign:${name}:${accent.getHexString()}`;
    let mat = this._signCache.get(key);
    if (!mat) {
      const w = 1024;
      const h = 256;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      const hex = `#${accent.getHexString()}`;
      ctx.clearRect(0, 0, w, h);

      ctx.fillStyle = 'rgba(6,12,20,0.55)';
      ctx.beginPath();
      const inset = 24;
      ctx.moveTo(inset + 34, inset);
      ctx.lineTo(w - inset - 34, inset);
      ctx.lineTo(w - inset, inset + 40);
      ctx.lineTo(w - inset, h - inset);
      ctx.lineTo(inset, h - inset);
      ctx.lineTo(inset, inset + 40);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = hex;
      ctx.lineWidth = 3;
      ctx.stroke();

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = '600 34px "Rajdhani", "Chakra Petch", system-ui, sans-serif';
      ctx.fillText(String(label).toUpperCase(), w / 2, 74);

      ctx.shadowColor = hex;
      ctx.shadowBlur = 26;
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 84px "Chakra Petch", "Rajdhani", system-ui, sans-serif';
      ctx.fillText(String(name).toUpperCase(), w / 2, 152);
      ctx.shadowBlur = 0;

      ctx.fillStyle = hex;
      ctx.fillRect(w * 0.28, h - 56, w * 0.44, 5);

      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this._maxAniso;
      mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        /* ── FrontSide, AND IT HAS TO BE ──────────────────────────────────
         *
         * This was `DoubleSide`, and with two meshes that made every gateway
         * sign in the game draw its own mirror image on top of itself.
         *
         * The plate below is built twice - a `front`, and a `back` turned
         * through PI so its text reads the right way round from the other
         * side. `DoubleSide` then draws BOTH of them from BOTH sides, so each
         * view got the text plus a reversed copy of the text, summed by
         * `AdditiveBlending` at 2 cm apart. `art-space` measured the strip at
         * 9.3% asymmetric against 132% for a same-size control strip of wall,
         * which is what a letterform plus its own mirror looks like. Affects
         * at least citadel, dock, sports, space and medieval.
         *
         * Measured, per mesh and per side, before this was changed:
         *
         *   viewer in front   front mesh  +Z face   reads left-to-right
         *                     back  mesh  -Z face   reads MIRRORED
         *   viewer behind     front mesh  -Z face   reads MIRRORED
         *                     back  mesh  +Z face   reads left-to-right
         *
         * So exactly one of the two is right from either side, and the whole
         * defect is that the wrong one was drawn as well.
         *
         * ── AND DELETING THE BACK MESH IS NOT THE FIX ────────────────────
         * The obvious repair is to drop `back` and let `DoubleSide` serve the
         * reverse, and it does not work: the same measurement says the front
         * plate alone reads MIRRORED from behind, because a double-sided plane
         * shows its texture's +u axis to the viewer's LEFT when seen from its
         * -Z face. `back` is what makes a sign readable from behind at all,
         * and removing it would trade a mirrored overlay for mirrored text.
         *
         * `FrontSide` keeps both plates and draws each from its own side only:
         * one legible copy per side, no mirror, and half the fill - the two
         * additive plates used to rasterise on top of each other and the sign
         * was drawing at twice the brightness it was authored for.
         *
         * It does NOT save a draw call. Both meshes are still submitted;
         * back-face rejection happens in the rasteriser, not in
         * `projectObject`, so the render list is the same length either way.
         * The saving is fill rate. */
        side: THREE.FrontSide,
      });
      this._signCache.set(key, mat);
    }
    const geo = new THREE.PlaneGeometry(2.9, 0.72);
    const front = new THREE.Mesh(geo, mat);
    const back = new THREE.Mesh(geo, mat);
    back.rotation.y = Math.PI;
    back.position.z = -0.02;
    front.renderOrder = 5;
    back.renderOrder = 5;
    const group = new THREE.Group();
    group.add(front, back);
    // Both faces share one plane; remember it so clear() disposes it exactly once.
    group.userData.geometry = geo;
    return group;
  }

  /* ---------------------------------------------------------------- */
  /* Particle buffers                                                  */
  /* ---------------------------------------------------------------- */

  _buildMoteGeometry(count) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count * 4);
    const phase = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      seed[i * 4] = hash2(i, 1, 1) * Math.PI * 2;
      seed[i * 4 + 1] = 0.42 + hash2(i, 2, 2) * 0.72;
      seed[i * 4 + 2] = 0.10 + hash2(i, 3, 3) * 0.26;
      seed[i * 4 + 3] = 0.9 + hash2(i, 4, 4) * 2.6;
      phase[i] = hash2(i, 5, 5);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    // Positions are computed on the GPU, so cull against a hand-set volume.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), DISC_R * 2);
    return geo;
  }

  _buildEmberGeometry(count) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count * 4);
    const phase = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const a = hash2(i, 11, 1) * Math.PI * 2;
      const r = 1.3 + hash2(i, 12, 2) * 1.85;
      seed[i * 4] = Math.cos(a) * r;
      seed[i * 4 + 1] = Math.sin(a) * r;
      seed[i * 4 + 2] = 0.22 + hash2(i, 13, 3) * 0.5;
      seed[i * 4 + 3] = 0.7 + hash2(i, 14, 4) * 1.8;
      phase[i] = hash2(i, 15, 5);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 2, 0), 6);
    return geo;
  }

  /* ---------------------------------------------------------------- */
  /* Live destination preview                                          */
  /* ---------------------------------------------------------------- */

  _buildPreviewRig() {
    /* A dedicated scene the destination world is briefly re-parented into.
     *
     * The rig here has to be *count-identical* to the main scene's, not merely
     * similar. It used to be ambient + hemi + one directional, which was
     * described as "structurally identical to main.js's" and was not: the real
     * scene also carries the whole point/spot/shadow slot set. Light counts are
     * part of Three's program cache key, so every material this preview touched
     * compiled a second complete program set on the spot - roughly a second per
     * program on an ANGLE/D3D11 target, which is the multi-second hitch you feel
     * walking up to a gateway.
     *
     * `buildMatchingSlots` mints exactly the slots gfx/LightRig.js puts in the
     * main scene, all dark. The destination world's own lights are already
     * demoted to `visible = false` by the rig, so nothing it brings in changes
     * the counts either, and the preview shares programs with the live frame.
     */
    this._previewScene = new THREE.Scene();
    this._previewAmbient = new THREE.AmbientLight(0xffffff, 0.6);
    this._previewHemi = new THREE.HemisphereLight(0xffffff, 0x404040, 0.5);
    this._previewScene.add(this._previewAmbient, this._previewHemi);

    this._previewSlots = buildMatchingSlots(this._previewScene);
    // The preview's key light is one of the fill slots: the shadow slots stay
    // dark so they cost a cache-key entry and never a shadow pass.
    this._previewSun = this._previewSlots.dirFill[0];
    this._previewSunTarget = this._previewSun.target;

    this._previewFog = new THREE.Fog(0x000000, 10, 400);

    /* Put the whole rig on the warm layer as well as layer 0.
     *
     * `_drawPreviewSlice` renders with the camera moved to `WARM_LAYER` alone,
     * so that only the slice's own objects are drawn. `projectObject` gates
     * lights on that same test - a light off the camera's layers is never
     * pushed into the render state - and light *counts* are part of Three's
     * program cache key. Without this the sliced warm would link a zero-light
     * program set: 190 programs built, none of them the ones the live preview
     * goes on to ask for, and the freeze it exists to remove intact. */
    this._previewScene.traverse((o) => o.layers.enable(WARM_LAYER));
  }

  _ensurePreviewTarget(portal) {
    if (portal.rt) return portal.rt;
    portal.rt = new THREE.WebGLRenderTarget(512, 512, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      // Half float keeps the linear, un-tonemapped output intact so the window
      // matches what the world actually looks like once ACES is applied.
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    portal.rt.texture.wrapS = THREE.ClampToEdgeWrapping;
    portal.rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    portal.rt.texture.colorSpace = THREE.NoColorSpace;

    portal.previewCam = new THREE.PerspectiveCamera(70, 1, 0.2, 900);
    portal.discMat.uniforms.uPreview.value = portal.rt.texture;
    return portal.rt;
  }

  /**
   * Render the destination world into the portal's render target. Cheap because
   * it runs at 10 Hz, at 512x512, without shadows, and only within 40 m.
   */
  _renderPreview(portal, elapsed) {
    const ctx = this._configurePreview(portal, elapsed);
    if (!ctx) return;
    const parked = this._parkPreviewGroup(ctx.world.group);
    try {
      this._drawPreview(portal, ctx.cam);
    } finally {
      this._unparkPreviewGroup(parked);
    }
    portal.discMat.uniforms.uHasPreview.value = 1;
    portal.discMat.uniforms.uPreviewExposure.value = ctx.exposure;
  }

  /**
   * Point the preview camera and dress the preview scene in the destination's
   * environment, fog and light colours - everything `_renderPreview` does
   * except the draw.
   *
   * Split out because the *draw* is the expensive half and the time-sliced warm
   * has to perform it many times over many idle callbacks (see gfx/PreviewWarm.js).
   * Every one of the values set here is part of Three's program cache key, so a
   * slice that skipped this would link a program set the live preview never
   * asks for; it is cheap enough - light and colour copies, one cached arrival
   * transform - to redo per slice, which is what keeps a slice from having to
   * leave the scene graph mutated across a yield.
   *
   * @param {any} portal
   * @param {number} elapsed
   * @returns {null | { world: any, cam: THREE.PerspectiveCamera, exposure: number }}
   */
  _configurePreview(portal, elapsed) {
    const wm = this.worldManager;
    if (!wm?.isBuilt?.(portal.target)) return null;
    const world = wm.getWorld(portal.target);
    // Never preview the world we are standing in - it is already on screen and
    // re-parenting the live group mid-frame would be a very bad idea.
    if (!world || world === wm.active) return null;

    this._ensurePreviewTarget(portal);

    // The arrival transform is cached: it never moves for a given portal pair.
    if (!portal._camAnchor) {
      const arrival = wm.arrivalFor(portal.target, portal.worldId, { snapToGround: false });
      portal._camAnchor = { position: arrival.position, yaw: arrival.yaw };
    }
    const cam = portal.previewCam;
    const anchor = portal._camAnchor;
    // A slow sway keeps the window alive without looking like a spinning demo.
    const sway = Math.sin(elapsed * 0.21 + portal.previewPhase) * 0.11;
    cam.position.set(
      anchor.position.x,
      anchor.position.y + CONFIG.player.eyeHeight + Math.sin(elapsed * 0.33) * 0.06,
      anchor.position.z
    );
    cam.rotation.set(0, 0, 0);
    cam.rotation.order = 'YXZ';
    cam.rotation.y = anchor.yaw + sway;
    cam.rotation.x = -0.045;
    cam.updateMatrixWorld(true);

    const env = world.environment;
    this._previewAmbient.color.copy(env.ambientColor);
    this._previewAmbient.intensity = env.ambientIntensity;
    this._previewHemi.color.copy(env.skyColor ?? env.ambientColor);
    this._previewHemi.groundColor.copy(env.groundColor ?? env.fogColor);
    this._previewHemi.intensity = env.hemiIntensity ?? 0.4;
    this._previewSun.color.copy(env.sunColor);
    this._previewSun.intensity = env.sunIntensity;
    this._previewSun.position
      .copy(cam.position)
      .addScaledVector(env.sunDirection, 120);
    this._previewSunTarget.position.copy(cam.position);
    this._previewScene.background = env.background ?? null;
    this._previewScene.environment = env.envMap ?? null;
    this._previewScene.environmentIntensity = env.envMapIntensity ?? 1;
    /* THE DESTINATION'S OWN FOG, WHEN IT HAS ONE.
     *
     * `fogExp2` is in Three's program cache key. A world that installs its own
     * exponential fog on the live scene - see `World.sceneFog`, and sports is
     * the only one - therefore asks for a program set that a preview dressed
     * in a linear fog never builds. That warm then linked, held for, drew and
     * cached a set the game asks for nowhere except inside the gateway window,
     * and the arrival frame paid for the real one in full: measured on the
     * production bundle, 79 programs and a 28-42 s block on the frame the
     * player stepped through.
     *
     * Taking the world's own instance also makes the window a truer picture of
     * where it leads, which is what this method already says it is for. */
    const ownFog = world.sceneFog ?? null;
    if (ownFog) {
      this._previewScene.fog = ownFog;
    } else if (env.fogFar > 0) {
      this._previewFog.color.copy(env.fogColor);
      this._previewFog.near = env.fogNear;
      this._previewFog.far = env.fogFar;
      this._previewScene.fog = this._previewFog;
    } else {
      this._previewScene.fog = null;
    }

    this._primePreviewShadows(cam, portal.rt);

    return { world, cam, exposure: env.exposure ?? 1 };
  }

  /**
   * Re-parent a destination group into the preview scene, and hand back exactly
   * what is needed to put it back. Always paired with `_unparkPreviewGroup` in
   * a `finally`: a group left parked would vanish from its own world.
   *
   * @param {THREE.Object3D} group
   */
  _parkPreviewGroup(group) {
    const parked = { group, parent: group.parent, wasVisible: group.visible };
    group.visible = true;
    this._previewScene.add(group);
    return parked;
  }

  /** @param {{ group: THREE.Object3D, parent: THREE.Object3D|null, wasVisible: boolean }} parked */
  _unparkPreviewGroup(parked) {
    this._previewScene.remove(parked.group);
    parked.group.visible = parked.wasVisible;
    if (parked.parent) parked.parent.add(parked.group);
  }

  /** Draw the parked preview scene into the portal's target, shadows off. */
  _drawPreview(portal, cam) {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevShadowAuto = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false;
    r.setRenderTarget(portal.rt);
    try {
      r.render(this._previewScene, cam);
    } finally {
      r.setRenderTarget(prevTarget);
      r.shadowMap.autoUpdate = prevShadowAuto;
    }
  }

  /**
   * Draw *only* `slice` into the preview target, so one idle callback pays for
   * a handful of shader programs rather than the whole destination world.
   *
   * ── Why layers and not visibility ──────────────────────────────────────────
   * `projectObject` tests three things before it will draw: the object's own
   * `visible`, its layer against the camera's, and the frustum. Hiding the rest
   * of the world would mean walking thousands of nodes twice per slice and
   * leaving the destination's visibility flags mutated across a yield. A layer
   * inverts that: the camera moves to a channel nothing is on, and the slice's
   * few objects are lifted onto it for the length of one draw. The mutation is
   * `slice.length` integers, restored in a `finally`.
   *
   * The preview rig's lights are permanently on that channel too - see
   * `_buildPreviewRig`. `projectObject` layer-gates lights exactly as it gates
   * meshes, and a slice drawn with no lights reaching the render state would
   * resolve every material against zero-light counts: a different program cache
   * key, and therefore a warm of programs the live preview will never ask for.
   *
   * @param {any} portal
   * @param {THREE.Camera} cam
   * @param {any[]} slice
   */
  _drawPreviewSlice(portal, cam, slice) {
    const saved = [];
    for (const o of slice) {
      saved.push([o, o.frustumCulled, o.layers.mask]);
      // Cleared because the arrival camera's frustum is not the point here: a
      // program is warmed by being drawn, on or off screen.
      o.frustumCulled = false;
      o.layers.enable(WARM_LAYER);
    }
    const prevMask = cam.layers.mask;
    cam.layers.set(WARM_LAYER);
    try {
      this._drawPreview(portal, cam);
    } finally {
      cam.layers.mask = prevMask;
      for (const [o, frustumCulled, mask] of saved) {
        o.frustumCulled = frustumCulled;
        o.layers.mask = mask;
      }
    }
  }

  /**
   * Give the preview scene's parked shadow slots a real depth attachment, once.
   *
   * The slots from `buildMatchingSlots` declare `castShadow` so the preview
   * resolves shared materials to the same programs as the main scene (see
   * `_buildPreviewRig`). That raises `numDirLightShadows`, which puts a
   * `sampler2DShadow` in every fragment shader - and this render deliberately
   * turns the shadow pass off, so those samplers were left bound to the
   * renderer's default *colour* texture. Every draw then failed with
   * `GL_INVALID_OPERATION: Mismatch between texture format and sampler type`,
   * once per call, for as long as the player stood near a gateway.
   *
   * One shadow pass over the preview scene *before* the destination world is
   * parented into it fixes that permanently: the scene is empty but for the
   * lights, and the slots' frusta are 10 cm across, so it allocates the
   * attachments and draws nothing. `WebGLShadowMap` clears each light's
   * `needsUpdate` once it has rendered, so this never runs a second time.
   *
   * @param {THREE.Camera} cam
   * @param {THREE.WebGLRenderTarget} rt
   */
  _primePreviewShadows(cam, rt) {
    if (this._previewShadowsPrimed) return;
    this._previewShadowsPrimed = true;
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    try {
      r.setRenderTarget(rt);
      r.render(this._previewScene, cam);
    } catch (err) {
      console.warn('[Portals] preview shadow priming failed:', err);
    } finally {
      r.setRenderTarget(prevTarget);
    }
  }

  /**
   * Link the preview path's shader programs up front, instead of on the frame a
   * gateway first comes within `PREVIEW_RANGE`.
   *
   * ── Why the existing warm does not cover this ──────────────────────────────
   * `main.js`'s `warmWorld()` calls `compile(world.group, camera, engine.scene)`,
   * so the destination's materials are linked against the *live* scene: the
   * station's environment map, the station's fog, the canvas-bound render state.
   * The preview draws exactly the same materials into a 512² half-float target
   * with the *destination's* environment and fog instead. Three folds
   * `envMap`, `envMapCubeUVHeight`, `fog` and the bound render target into its
   * program cache key, so those are different keys and the pre-compile misses
   * them entirely. Measured: a traversal of the station linked 87 further
   * programs while walking, in seven multi-second freezes, 73% of the link time
   * under `_renderPreview`.
   *
   * ── Why one render is not enough ───────────────────────────────────────────
   * `render()` culls, so a single preview frame only links what the arrival
   * camera happens to be looking at - which is why the cost arrived in pieces
   * rather than all at the first gateway. The render happens first because it is
   * the *exact* live path (it primes the shadow attachments, allocates the
   * target and proves the key), then `compile()` with that same target still
   * bound broadens it to every material in the group, since `compile` collects
   * with `traverse` and does not cull.
   *
   * Synchronous `compile()`, not `compileAsync()`, for the reason documented on
   * `main.js`'s `prewarm()`: some driver stacks throw from compileAsync's
   * internal readiness polling, and this is optional work that must never be
   * able to abort a boot.
   *
   * Nothing here changes what renders per frame: the previews still only run at
   * 10 Hz inside 40 m. This just moves the one-time link cost off the walk.
   *
   * ── Why it is time-sliced, and what the slice is ───────────────────────────
   * Doing all of that in one go moved the freeze rather than removing it: it
   * runs from `scheduleBackgroundBuilds`, which is *after* `engine.start()`, so
   * the player is already walking around. Measured over a cold boot, the four
   * gateways cost 12.4 s, 15.3 s, 4.8 s and 3.3 s of dead main thread inside
   * the first minute.
   *
   * All of it is the render. `compile()` for the same four came to 43.9 ms in
   * total, because it issues `linkProgram` and never reads the result; three
   * reads `LINK_STATUS` on a program's first *use*. So the plan below is in
   * three parts, and the order is the whole trick:
   *
   *   1. issue the links, a few programs per idle callback;
   *   2. hold until the driver says it has resolved them;
   *   3. draw them, one program per idle callback.
   *
   * Measured over the first 90 s of a cold boot while walking a circuit of every
   * gateway, three runs before against five after: 30.7-36.2 s of blocking with
   * a 12.3-15.3 s worst single unit became 0.6-6.5 s with a 0.04-3.1 s worst
   * single unit. The background settle got *shorter* too, 84 s to 53-57 s,
   * because 35 s of it used to be dead main thread and is now overlapped with
   * frames.
   *
   * ── The invariant this must not break ──────────────────────────────────────
   * A gateway's preview must never be drawn un-warmed, because that draw is the
   * 14 s freeze in person. `_warmPending` holds `update()`'s 10 Hz preview off
   * the disc until the last slice lands - the gateway simply keeps its
   * stabilising look for a few seconds longer, which is a state it already has.
   * Nothing else in here mutates anything across a yield: each slice parks the
   * destination group in the preview scene, draws, and un-parks inside a
   * `finally`, so at every yield point the scene graph is exactly as it was.
   *
   * @param {{ target?: string, schedule?: (fn: () => void) => void }} [opts]
   *   `target` restricts to gateways pointing at one world - background builds
   *   warm each destination as it finishes. `schedule` is the yield: it is
   *   handed a callback and is expected to run it in a later task (main.js
   *   passes the same `requestIdleCallback` wrapper the background builds use).
   *   Without it every slice runs in one block, which is only ever what a test
   *   wants.
   * @returns {Promise<{ warmed: string[], skipped: string[], ms: number,
   *   programs: number, slices: number, reason: string }>}
   */
  /**
   * Suppress the live 10 Hz preview for every gateway pointing at `target`,
   * before anything has begun warming it.
   *
   * ── Why this cannot live inside `warmPreviews` ─────────────────────────────
   * `update()` derives `p.ready` from `worldManager.isBuilt(p.target)` every
   * frame, and its priming pass renders a preview on the *first* frame a
   * gateway is ready - deliberately, so the establishing frame of an approach
   * is not an empty window. That draw links the destination's entire preview
   * program set inside one gameplay frame, which is the freeze this whole file
   * spends three hundred lines avoiding.
   *
   * Nothing used to stand between "built" and "warming" because the background
   * chain's `warmWorld` was a single blocking `compile()` running in the same
   * task as the build's resolution: by the time a frame could run,
   * `warmPreviews` had already set `_warmPending`. That is an accident of
   * timing, not a guarantee, and the moment `warmWorld` was sliced it stopped
   * holding - measured, the priming pass landed in the new gap and cost a
   * single frame of 8,212 ms and 14,741 ms across two cold boots.
   *
   * So the claim is separated from the warm and taken by the caller as soon as
   * the destination exists. `releasePreviews` is the other half and belongs in
   * a `finally`: a gateway left claimed shows STABILISING forever.
   *
   * @param {string} target world id
   */
  holdPreviews(target) {
    for (const p of this._portals) if (!target || p.target === target) p._warmPending = true;
  }

  /**
   * Undo `holdPreviews`. Idempotent, and safe to call on a gateway the warm
   * already released itself.
   *
   * @param {string} target world id
   */
  releasePreviews(target) {
    for (const p of this._portals) if (!target || p.target === target) p._warmPending = false;
  }

  warmPreviews({ target = null, schedule = null } = {}) {
    const t0 = performance.now();
    const warmed = [];
    const skipped = [];
    const pending = [];
    const wm = this.worldManager;
    /** @type {Array<() => void>} Appended to as plans are built; see runSliced. */
    const steps = [];
    let slices = 0;
    // Yielding is what lets the driver resolve links in the background, so the
    // hold below only makes sense when there is a scheduler to yield to. Run
    // unpaced it would be a busy-wait and nothing more.
    const paced = typeof schedule === 'function';
    /** No draw before this - a backstop on the hold. */
    let drawsFrom = 0;
    /** Programs whose links the hold is waiting on, or null once released. */
    let awaitingLinks = null;

    for (const p of this._portals) {
      if (target && p.target !== target) continue;
      // A gateway whose destination has not been generated has nothing to warm:
      // its materials do not exist yet. That is the maze's permanent state in
      // the station - it is `static volatile = true`, so it is deliberately left
      // out of the background builds and re-rolls on entry, and its preview
      // never renders here either. See the note in main.js.
      if (!wm?.isBuilt?.(p.target)) { skipped.push(p.target); continue; }
      const world = wm.getWorld(p.target);
      if (!world?.group || world === wm.active) { skipped.push(p.target); continue; }
      warmed.push(p.target);
      pending.push(p);
      p._warmPending = true;
      steps.push(() => {
        // Configure first: the compile needs the render target and camera this
        // creates, and the environment, fog and light colours it sets are all
        // part of the key being warmed.
        const ctx = this._configurePreview(p, this.engine?.elapsed ?? 0);
        if (!ctx) return;
        const before = this.renderer.info.programs.length;
        const units = planPreviewWarm(world.group);
        const draws = chunkUnits(units, WARM_UNITS_PER_SLICE);
        slices += draws.length;

        // 1. Issue the links, a few programs per callback.
        for (const batch of chunkUnits(units, WARM_UNITS_PER_COMPILE)) {
          steps.push(() => this._compileWarmSlice(p, world, batch));
        }
        // 2. Broaden to the materials no *visible* object carries, which the
        //    plan cannot reach and a draw would never link. Cheap by now: every
        //    program a visible object needs already exists.
        steps.push(() => {
          const c = this._configurePreview(p, this.engine?.elapsed ?? 0);
          if (c) this._compilePreviewGroup(p, world.group);
          // Only hold if this actually queued something. A destination that
          // shares its whole program set with one already warmed - the citadel,
          // measured, adds none - has nothing for the driver to resolve and
          // would otherwise sit out the hold for no reason at all.
          const fresh = this.renderer.info.programs.slice(before);
          if (paced && fresh.length) {
            const ask = this._canAskDriver();
            awaitingLinks = ask ? fresh : null;
            drawsFrom = performance.now() + (ask ? WARM_SETTLE_CAP_MS : WARM_SETTLE_MS);
          }
        });
        // 3. Draw them, one program per callback. This is the half that waits
        //    on the link, and the hold above is what makes it stop waiting.
        for (const batch of draws) steps.push(() => this._drawWarmSlice(p, world, batch));
        steps.push(() => {
          // Everything is linked and drawn by now, so this is an ordinary frame
          // and it is what puts the destination in the window.
          this._renderPreview(p, this.engine?.elapsed ?? 0);
          p._warmPending = false;
        });
      });
    }

    const conclude = (reason) => {
      // Whatever happened - cancelled, failed, no scheduler - a gateway must
      // never be left with its preview permanently suppressed.
      for (const p of pending) p._warmPending = false;
      return {
        warmed,
        skipped,
        slices,
        reason,
        ms: Math.round(performance.now() - t0),
        programs: this.renderer.info.programs.length,
      };
    };

    return runSliced({
      steps,
      // No scheduler: run the whole plan in this task. Same total work, same
      // order, none of the spreading - which is what the sync callers want.
      schedule: typeof schedule === 'function' ? schedule : immediateScheduler(),
      // `clear()` empties `_portals`, so this covers teardown and world swaps.
      // Everything narrower - the destination being rebuilt, becoming active,
      // or the target being disposed - makes `_configurePreview` return null
      // and the remaining slices become no-ops.
      shouldStop: () => this._portals.length === 0,
      // Two holds. A warp is a few seconds and is waited out rather than
      // abandoning the warm and handing the freeze back to the player on the
      // far side; the other is the gap that lets the driver resolve the links
      // `compile()` just issued, released the moment it says it has.
      shouldPause: () => {
        if (this._transition) return true;
        if (performance.now() >= drawsFrom) return false;
        if (awaitingLinks && this._previewLinksResolved(awaitingLinks)) {
          awaitingLinks = null;
          drawsFrom = 0;
          return false;
        }
        return true;
      },
      // Comfortably over the hold, since the hold is a pause too.
      maxPauseMs: WARM_SETTLE_CAP_MS + 20000,
      onError: (err) => {
        // Never fatal: the cost simply reverts to being paid on approach.
        console.warn('[Portals] preview warm failed:', err);
      },
    }).then((res) => conclude(res.reason));
  }

  /**
   * Whether this driver can be asked if a link has finished, without waiting
   * for the answer. Feature-detected once.
   *
   * Without `KHR_parallel_shader_compile` three flags every program ready the
   * moment it is created, so `isReady()` would answer "yes" instantly and the
   * warm would draw into an unresolved link - exactly the stall it is avoiding.
   * The timed hold covers that case instead.
   */
  _canAskDriver() {
    if (this._parallelCompile === undefined) {
      try {
        this._parallelCompile =
          !!this.renderer.getContext?.().getExtension?.('KHR_parallel_shader_compile');
      } catch {
        this._parallelCompile = false;
      }
    }
    return this._parallelCompile;
  }

  /**
   * Has the driver finished linking `programs`? Asked without blocking.
   *
   * `WebGLProgram.isReady()` polls `COMPLETION_STATUS_KHR`, which is the entire
   * point of the extension: it answers now, where a draw - or any
   * `getProgramParameter(LINK_STATUS)` - waits for the link instead. Polling it
   * turns the fixed hold above into "wait exactly as long as this machine needs
   * today", which is the difference between a slice that costs 3.5 s under load
   * and one that costs nothing.
   *
   * ── This is not `compileAsync` ─────────────────────────────────────────────
   * That helper wraps the same poll in a promise it drives from a
   * `requestAnimationFrame` callback with no catch around it, so on some driver
   * stacks a failure there escapes as an uncaught rejection into the frame loop.
   * That is the documented reason this file links with the synchronous
   * `compile()` and will keep doing so. The poll itself carries none of that:
   * it is one call, driven by the warm's own idle chain, inside a try/catch -
   * and a throw here gives up on waiting rather than propagating, so the worst
   * case is the stall we already had.
   *
   * @param {any[]} programs
   * @returns {boolean}
   */
  _previewLinksResolved(programs) {
    try {
      for (const p of programs) {
        if (p?.isReady && p.isReady() === false) return false;
      }
    } catch (err) {
      console.warn('[Portals] link readiness probe failed; drawing anyway:', err);
      return true;
    }
    return true;
  }

  /**
   * Issue the links for one batch of the plan.
   *
   * `compile()` traverses whatever it is handed, so handing it a single mesh
   * compiles exactly that mesh's materials - against `_previewScene`'s lights,
   * fog and environment and the bound preview target, which is the key that
   * matters. Nothing is parked: `prepareMaterial` reads the object's flags and
   * the target scene, never a world transform.
   *
   * @param {any} portal
   * @param {any} world the world this batch was planned against
   * @param {any[]} batch
   */
  _compileWarmSlice(portal, world, batch) {
    const ctx = this._configurePreview(portal, this.engine?.elapsed ?? 0);
    if (!ctx || ctx.world !== world) return;
    for (const o of batch) this._compilePreviewGroup(portal, o);
  }

  /**
   * One slice of one gateway's warm: park the destination, draw the slice,
   * un-park. Re-validated every time, because arbitrary game time passes
   * between slices.
   *
   * @param {any} portal
   * @param {any} world the world this slice was planned against
   * @param {any[]} slice
   */
  _drawWarmSlice(portal, world, slice) {
    const ctx = this._configurePreview(portal, this.engine?.elapsed ?? 0);
    // A different world object under the same id means it was rebuilt while
    // this warm was yielded; the plan's objects belong to the old one.
    if (!ctx || ctx.world !== world) return;
    const parked = this._parkPreviewGroup(world.group);
    try {
      this._drawPreviewSlice(portal, ctx.cam, slice);
    } finally {
      this._unparkPreviewGroup(parked);
    }
  }

  /**
   * Compile every material under `root` against the preview scene, with the
   * preview's render target bound so the cache key matches.
   *
   * `root` is the whole destination group when the point is to broaden to
   * materials no visible object carries, and a single mesh when the point is to
   * issue one plan unit's links without paying for a world at a time -
   * `compile()` only ever traverses what it is given.
   *
   * `_configurePreview` must have run first: it is what allocates the target and
   * camera this reads, and what sets the preview scene's environment, fog and
   * light colours to this destination's - all of which are part of the key we
   * are trying to hit.
   *
   * This is the cheaper half of the warm: it issues a `linkProgram` per material
   * and never reads the result, where three reads `LINK_STATUS` on a program's
   * first *use* - which is a draw, and which is why the draws in `warmPreviews`
   * are what had to be sliced. Cheaper is not free, though. ANGLE translates
   * GLSL to HLSL inside `glCompileShader`, synchronously, so one call over a
   * whole un-warmed destination measured 377 ms and 929 ms on the sports
   * gateway. That is why the caller hands it a plan unit at a time and keeps
   * the whole-group call for the broadening pass, by which point every program
   * a visible object needs already exists.
   *
   * @param {any} portal
   * @param {THREE.Object3D} root the destination group, or one plan unit
   */
  _compilePreviewGroup(portal, root) {
    const r = this.renderer;
    if (!portal.rt || !portal.previewCam || typeof r.compile !== 'function') return;
    const prevTarget = r.getRenderTarget();
    const prevShadowAuto = r.shadowMap.autoUpdate;
    try {
      r.shadowMap.autoUpdate = false;
      r.setRenderTarget(portal.rt);
      r.compile(root, portal.previewCam, this._previewScene);
    } finally {
      r.setRenderTarget(prevTarget);
      r.shadowMap.autoUpdate = prevShadowAuto;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Transition overlay                                                */
  /* ---------------------------------------------------------------- */

  _buildWarpOverlay() {
    this._warpMat = new THREE.ShaderMaterial({
      vertexShader: WARP_VERT,
      fragmentShader: WARP_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uProgress: { value: 0 },
        uFlash: { value: 0 },
        uRing: { value: -1 },
        uAspect: { value: 1 },
        uAccent: { value: new THREE.Color(0x6ff0ff) },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: true,
    });
    this._warpMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this._warpMat);
    this._warpMesh.frustumCulled = false;
    this._warpMesh.renderOrder = 10000;
    this._warpMesh.visible = false;
  }

  /** Glue the overlay quad to the near plane of the live camera. */
  _positionWarpOverlay() {
    const cam = this.engine.camera;
    const d = Math.max(cam.near * 2.4, 0.2);
    const h = 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5) * d;
    const w = h * cam.aspect;
    cam.getWorldQuaternion(_q1);
    cam.getWorldPosition(_v1);
    this._warpMesh.quaternion.copy(_q1);
    this._warpMesh.position
      .copy(_v1)
      .addScaledVector(_dir.set(0, 0, -1).applyQuaternion(_q1), d);
    this._warpMesh.scale.set(w * 1.08, h * 1.08, 1);
    this._warpMat.uniforms.uAspect.value = cam.aspect;
  }

  /* ---------------------------------------------------------------- */
  /* Entry                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Begin a world transition through `portal`. Safe to call when the target is
   * not generated yet - the gateway shows STABILISING and the warp holds at
   * full white until the build lands.
   */
  /**
   * Begin a transition through the portal with this id, e.g. `dock->space`.
   *
   * Three lines, and they exist so a caller that is not a proximity trigger
   * has a door to knock on. The flight drop's cockpit seat is exactly that
   * caller: pressing E in a pilot's seat has to enter the launch portal, and
   * the launch portal is on the deck at the blast door rather than in the
   * cockpit (see `YardPlan.PORTAL_SPACE_Z` for the `arrivalFor` reason). The
   * alternative is a caller reaching into `_portals`, which is how a private
   * array becomes a public one by accident.
   *
   * @param {string} id `${worldId}->${target}`
   */
  enterById(id) {
    const rec = this._portals.find((p) => p.id === id);
    return rec ? this.enter(rec) : false;
  }

  enter(portal) {
    if (!portal || this._transition) return false;
    const wm = this.worldManager;
    if (!wm) return false;

    if (!wm.isBuilt(portal.target)) {
      portal.state = 'stabilising';
      this.bus.emit('hud:notify', {
        text: `Gateway to ${portal.targetName} is still stabilising…`,
        tone: 'warn',
      });
      /* Kick the build so the wait is as short as it can be, then transition
       * anyway: activate() awaits the same in-flight promise.
       *
       * Skipped for volatile worlds. `_updateTransition` below calls
       * `wm.activate()` once the transition is half done, and `activate()`
       * calls `build()` itself - so a volatile world (which regenerates on
       * every `build()` call; see WorldManager.build) would otherwise pay for
       * two full generation passes on its first entry instead of one: this
       * kicked build usually finishes before activate's own call runs, so
       * that call's `build()` disposes the fresh layout and generates a
       * second one rather than reusing it. */
      if (!wm.isVolatile?.(portal.target)) {
        wm.build(portal.target).catch((err) =>
          console.error('[Portals] destination build failed:', err)
        );
      }
    }

    const duration = CONFIG.portal.transitionDuration;
    this._transition = {
      portal,
      t: 0,
      duration,
      swapped: false,
      settled: false,
      pending: null,
    };
    this._warpMat.uniforms.uAccent.value.copy(portal.accent);
    this._warpMesh.visible = true;
    if (!this._warpMesh.parent) this.scene.add(this._warpMesh);
    this.input?.setEnabled?.(false);

    this.bus.emit('portal:entering', {
      from: this._worldId,
      to: portal.target,
      duration,
      target: portal.target,
      id: portal.id ?? portal.target,
      portal,
    });
    this.bus.emit('quest:activity', {
      type: 'interact',
      target: portal.id ?? portal.target,
      id: portal.id ?? portal.target,
      portal,
    });
    if (this._near) {
      this._near = null;
      this.bus.emit('portal:near', { portal: null });
    }
    return true;
  }

  /**
   * Compile the destination world's shaders while the warp is still white.
   *
   * A world the player has never stood in brings materials the renderer has
   * never seen, and it brings its own set of lights - and Three keys its
   * program cache on light counts, so arriving in a new world invalidates
   * everything at once. Measured before this existed: the first weapon switch
   * after a portal into the sports world built 71 programs and froze the frame
   * for 24 s.
   *
   * This has to run *after* `activate()`, not before. `compileAsync` collects
   * lights from the scene as it stands, so compiling the destination while the
   * departure world is still in the scene would key every program to the sum of
   * both light sets - the wrong key, and the work would be thrown away on the
   * next frame. Once the swap has happened, the light set is exactly the one
   * the player is about to render with.
   *
   * It does not lengthen the transition beyond what it already does for a slow
   * world build: `_updateTransition` holds at the white-out until `settled`,
   * the warp keeps animating throughout because `compileAsync` yields between
   * polls, and KHR_parallel_shader_compile keeps the driver work off the main
   * thread. The budget below caps a pathological compile so a stuck driver can
   * never strand the player in the white-out - the remainder simply compiles
   * lazily, exactly as it did before.
   */
  async _warmDestination() {
    const renderer = this.engine?.renderer;
    const camera = this.engine?.camera;
    if (!renderer?.compileAsync || !camera) return;
    const t0 = performance.now();
    const before = renderer.info.programs.length;
    try {
      await Promise.race([
        renderer.compileAsync(this.scene, camera),
        new Promise((r) => setTimeout(r, PORTAL_WARM_BUDGET_MS)),
      ]);
    } catch (err) {
      // A warmup failure must never strand a transition: fall back to the
      // lazy compile the renderer would have done anyway.
      console.warn('[Portals] destination warmup failed:', err);
      return;
    }

    // `compile()` only prepares each material's beauty program. The shadow
    // pass draws through the renderer's private `_depthMaterial` /
    // `_distanceMaterial`, which `compile` never sees, so those programs are
    // still built lazily - on the first real frame in the new world, which is
    // the frame the player would have felt. Two full frames here pay for them
    // (and for the PostFX chain, which is not part of the scene graph) while
    // the warp is still white.
    for (let i = 0; i < 2; i++) {
      try {
        if (this.engine.postfx) this.engine.postfx.render(1 / 60);
        else renderer.render(this.scene, camera);
      } catch { /* a warmup frame must never strand a transition */ }
      await new Promise((r) => requestAnimationFrame(r));
    }

    if (CONFIG.debug?.showStats) {
      console.info(
        `[Portals] destination warmup ${Math.round(performance.now() - t0)}ms, ` +
        `+${renderer.info.programs.length - before} programs`
      );
    }
  }

  _updateTransition(dt) {
    const tr = this._transition;
    const u = this._warpMat.uniforms;
    const half = tr.duration * 0.45;

    if (!tr.swapped) {
      tr.t += dt;
      if (tr.t >= half) {
        tr.swapped = true;
        const wm = this.worldManager;
        tr.pending = wm
          .activate(tr.portal.target, { fromPortal: tr.portal })
          .then(() => this._warmDestination())
          .catch((err) => {
            console.error('[Portals] world activation failed:', err);
          })
          .finally(() => {
            tr.settled = true;
          });
      }
    } else if (tr.settled) {
      tr.t += dt;
    }
    // While !settled we simply hold at the white-out, so a slow generation pass
    // never shows the player a half-built world.

    const p = Math.min(tr.t / tr.duration, 1);
    u.uTime.value = this.engine.elapsed;
    if (p < 0.45) {
      const k = p / 0.45;
      u.uProgress.value = k;
      u.uFlash.value = Math.pow(k, 3.2);
      u.uRing.value = -1;
    } else {
      const k = (p - 0.45) / 0.55;
      u.uProgress.value = Math.max(0, 1 - k * 1.25);
      u.uFlash.value = Math.max(0, 1 - k * 2.1);
      u.uRing.value = k * 1.7;
    }
    this._positionWarpOverlay();

    if (p >= 1 && tr.settled) {
      this._transition = null;
      this._warpMesh.visible = false;
      if (this._warpMesh.parent) this._warpMesh.parent.remove(this._warpMesh);
      u.uFlash.value = 0;
      u.uProgress.value = 0;
      u.uRing.value = -1;
      this.input?.setEnabled?.(true);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Frame updates                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * Walk-through detection. Runs on the fixed step so a fast player cannot
   * tunnel past the event horizon between two rendered frames.
   *
   * A crossing only counts while the portal is *armed*, and a portal only arms
   * once the player has been unambiguously outside its aperture. Arriving from
   * another world plants the player a couple of metres in front of the return
   * gateway, standing on its dais; without the arming gate the first capsule
   * settle or sidestep there registered as a crossing and threw the player
   * straight back through the portal they had just walked out of.
   */
  fixedUpdate(_dt, _elapsed) {
    if (this._transition || this._portals.length === 0) return;
    const feet = this.player?.position;
    if (!feet) return;
    const past = (this.engine?.elapsed ?? 0) >= this._armAt;

    for (let i = 0; i < this._portals.length; i++) {
      const p = this._portals[i];
      // Test the player's chest, which is what actually crosses the disc.
      _v1.set(feet.x, feet.y + CHEST_RISE, feet.z).sub(p.discPosition);
      const w = _v1.dot(p.normal);
      const side = w >= 0 ? 1 : -1;
      const u = _v1.dot(p.right);
      const v = _v1.y;
      const rad2 = u * u + v * v;

      if (!p._armed) {
        // Clear of the silhouette, or a full stride off the plane: either way
        // the next approach is a deliberate walk into the gateway.
        if (past && (rad2 > REARM_R2 || (w < 0 ? -w : w) > REARM_DEPTH)) p._armed = true;
        p._side = side;
        continue;
      }

      if (p._side !== 0 && side !== p._side && rad2 < ENTRY_R2 && p.ready) {
        p._side = side;
        p._armed = false;
        this.enter(p);
        return;
      }
      p._side = side;
    }
  }

  /**
   * Per-frame: shader time, proximity prompt, interaction, light pulse and the
   * throttled destination previews.
   */
  update(dt, elapsed) {
    this._frame++;

    if (this._transition) {
      this._updateTransition(dt);
    }

    if (this._portals.length === 0) return;

    const wm = this.worldManager;
    const playerPos = this.player?.position ?? null;
    // Previews are keyed off whichever of the player and the render camera is
    // closer. In play they are the same point; under a detached review camera
    // (or a spectator/free cam) they are not, and gating on the player alone
    // left the signature feature of the game switched off in exactly the shots
    // people judge it by.
    const camPos = this.engine.camera.getWorldPosition(_v2);
    let nearest = null;
    let nearestDist = Infinity;

    for (let i = 0; i < this._portals.length; i++) {
      const p = this._portals[i];
      const built = wm ? wm.isBuilt(p.target) : false;
      if (built !== p.ready) {
        p.ready = built;
        p.state = built ? 'online' : 'stabilising';
      }

      const dist = playerPos ? playerPos.distanceTo(p.position) : Infinity;
      const viewDist = Math.min(dist, camPos.distanceTo(p.position));
      // Smoothed proximity drives the surge in brightness as you walk up.
      const want = dist < 24 ? 1 - Math.min(dist / 24, 1) : 0;
      p._proximity += (want - p._proximity) * Math.min(1, dt * 4);

      // The Gatefinder highlight, added on top of proximity rather than in place
      // of it: a pinged gateway you are also standing next to must not get
      // *dimmer* than one you are only pointing at. 0 when not pinged, so every
      // term below collapses back to exactly the maths it had before.
      p.pinged = elapsed < p._pingUntil;
      const ping = p.pinged ? 0.5 + 0.5 * Math.sin(elapsed * 4.2) : 0;

      const stability = p.ready ? 1 : 0.18 + 0.1 * Math.sin(elapsed * 3.1 + i);
      const du = p.discMat.uniforms;
      du.uTime.value = elapsed;
      du.uStability.value += (stability - du.uStability.value) * Math.min(1, dt * 2.5);
      du.uIntensity.value = 1 + p._proximity * 0.55 + ping * 0.8;
      p.haloMat.uniforms.uTime.value = elapsed;
      p.haloMat.uniforms.uIntensity.value = (p.ready ? 1 : 0.45) * (1 + p._proximity * 0.9 + ping * 1.6);
      p.moteMat.uniforms.uTime.value = elapsed;
      p.moteMat.uniforms.uBoost.value = 1 + p._proximity * 0.7 + ping * 0.9;
      p.emberMat.uniforms.uTime.value = elapsed;

      // Light spill: a slow pulse plus a fast flicker so it never looks static.
      const pulse =
        0.82 +
        0.18 * Math.sin(elapsed * 1.7 + p._lightPhase) +
        0.06 * Math.sin(elapsed * 11.3 + p._lightPhase);
      // Base candela matches the constructor: the spill has to read on the dais
      // without pushing the stone past the world's bloom threshold, which is
      // what turned the whole plinth into an amber flare in review round one.
      if (p.light) p.light.intensity = (p.ready ? 8.5 : 3.5) * pulse * (1 + p._proximity * 0.6 + ping * 1.1);

      p.sign.position.y = DISC_Y + ARCH_R + 0.72 + Math.sin(elapsed * 0.9 + i) * 0.05;

      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = p;
      }

      if (
        p.ready &&
        !p.previewFailed &&
        // Never draw a destination the sliced warm has not finished linking:
        // that draw is the 14 s freeze. The disc keeps its stabilising look for
        // the few seconds the warm still needs. See `warmPreviews`.
        !p._warmPending &&
        viewDist < PREVIEW_RANGE &&
        // Prime once on the frame the gateway comes into range, then settle into
        // the 10 Hz cadence. Without the priming pass the establishing frame of
        // every approach shows an empty window. `_primed` bounds it to a single
        // extra render per build - never a per-frame full scene pass.
        ((this._frame + p.previewPhase) % PREVIEW_INTERVAL === 0 || !p._primed)
      ) {
        p._primed = true;
        try {
          this._renderPreview(p, elapsed);
        } catch (err) {
          // One bad frame must not turn into a per-frame exception storm.
          console.error('[Portals] preview render failed:', err);
          p.previewFailed = true;
        }
      }

      if (p.ready && !p.announced && dist < PREVIEW_RANGE) {
        p.announced = true;
        this.bus.emit('hud:notify', {
          text: `Gateway to ${p.targetName} online`,
          tone: 'lore',
        });
      }
    }

    // Proximity prompt.
    const candidate = nearest && nearestDist <= NEAR_RANGE ? nearest : null;
    if (candidate !== this._near) {
      this._near = candidate;
      this.bus.emit('portal:near', { portal: candidate });
    }

    // Interact. `pressed()` is edge-triggered and cleared by Input.endFrame(),
    // which runs after every frame updater, so this is the right place to poll.
    if (
      this._near &&
      !this._transition &&
      this.input?.pressed?.('KeyE') &&
      !this.npcManager?.chatNpc?.isLorekeeper &&
      !this.input.textCaptured
    ) {
      this.enter(this._near);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Teardown                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Remove every portal. Called by WorldManager *before* `physics.clear()`, so
   * the plinth colliders registered in `_createPortal` go away with them.
   */
  clear() {
    for (const p of this._portals) {
      this.scene.remove(p.root);
      p.rt?.dispose();
      p.discMat.dispose();
      p.haloMat.dispose();
      p.moteMat.dispose();
      p.emberMat.dispose();
      // The spill light is pooled and outlives the portal - hand it back dark
      // rather than disposing it, or the count would drop on every world swap.
      if (p.light) p.light.intensity = 0;
      // The sign material is cached and shared; only the plane is per-portal.
      p.sign.userData.geometry?.dispose();
      p.rt = null;
      p.previewCam = null;
      p.colliders.length = 0;
    }
    this._portals.length = 0;
    if (this._near) {
      this._near = null;
      this.bus.emit('portal:near', { portal: null });
    }
  }

  /** Full teardown: also frees the shared style kits and textures. */
  dispose() {
    this.clear();
    for (const l of this._portalLights) {
      l.removeFromParent();
      l.dispose?.();
    }
    this._portalLights.length = 0;
    if (this._transition) {
      this._transition = null;
      this.input?.setEnabled?.(true);
    }
    if (this._warpMesh.parent) this._warpMesh.parent.remove(this._warpMesh);
    this._warpMesh.geometry.dispose();
    this._warpMat.dispose();
    this._discGeo.dispose();
    this._haloGeo.dispose();
    this._moteGeo.dispose();
    this._emberGeo.dispose();

    // Geometries and textures are shared aggressively, so dispose through a set
    // rather than risk double-freeing a resource two kits both reference.
    const freed = new Set();
    const free = (res) => {
      if (!res || freed.has(res)) return;
      freed.add(res);
      res.dispose?.();
    };

    for (const kit of this._kits.values()) {
      kit.template.traverse((o) => {
        if (o.isMesh) free(o.geometry);
      });
      for (const geo of kit.disposables) free(geo);
      free(kit.runeMat);
      free(kit.beamMat);
    }
    this._kits.clear();

    for (const entry of this._texCache.values()) {
      if (entry.isMaterial) {
        free(entry.map);
        free(entry.normalMap);
        free(entry.roughnessMap);
      }
      free(entry);
    }
    this._texCache.clear();

    for (const mat of this._signCache.values()) {
      mat.map?.dispose();
      mat.dispose();
    }
    this._signCache.clear();
  }
}
