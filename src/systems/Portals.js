import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CONFIG } from '../core/Config.js';

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

  // Live destination preview, sampled as a window with parallax + chromatic edge.
  vec2 base = p * uPreviewScale;
  base += par * 0.085 * (1.0 - r * r);
  base += (f - 0.5) * 0.045 * (0.35 + r);
  vec2 ca = dir * (0.005 + pow(r, 3.0) * 0.030);
  vec3 prev;
  prev.r = texture2D(uPreview, clamp(0.5 + base + ca, 0.002, 0.998)).r;
  prev.g = texture2D(uPreview, clamp(0.5 + base, 0.002, 0.998)).g;
  prev.b = texture2D(uPreview, clamp(0.5 + base - ca, 0.002, 0.998)).b;
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
  float show = clamp(win * (0.96 - 0.20 * f), 0.0, 0.97);
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

  float alpha = 1.0 - smoothstep(0.93, 1.0, r);
  alpha *= mix(0.82, 1.0, 1.0 - smoothstep(0.30, 0.92, r));
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
  constructor({ scene, engine, physics, bus, materials, input, player, worldManager }) {
    this.scene = scene;
    this.engine = engine;
    this.renderer = engine.renderer;
    this.physics = physics;
    this.bus = bus;
    this.materials = materials;
    this.input = input ?? null;
    this.player = player;
    this.worldManager = worldManager;

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
    const kit = this._kit(target);
    const frame = kit.template.clone(true);
    this._retintAccents(frame, accent);
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
        uPreviewScale: { value: 0.52 },
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

    // --- collision: walkable plinth, solid jambs ----------------------
    // The dais is round, so each tier is approximated by two boxes 45 degrees
    // apart - an octagon that stays within ~4% of the visible silhouette.
    const colliders = [];
    for (const tier of PLINTH_TIERS) {
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
    for (let s = 0; s < 3; s++) {
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
    for (const sx of [-1, 1]) {
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
      state: 'stabilising',
      /** Walk-through entry is disabled until the player is clear of the disc. */
      _armed: false,
      _side: 0,
      _lightPhase: index * 1.7,
      _proximity: 0,
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

  /** Build (once) the shared arch template + materials for a destination style. */
  _kit(target) {
    const style = target === 'medieval' || target === 'sports' ? target : 'station';
    let kit = this._kits.get(style);
    if (kit) return kit;
    kit = { style, template: new THREE.Group(), disposables: [] };
    if (style === 'medieval') this._buildMedievalArch(kit);
    else if (style === 'sports') this._buildSportsArch(kit);
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

    // Lintel plate spanning the springing line.
    const lintel = new THREE.Mesh(chamferPlateGeometry(ARCH_R * 2 + 0.6, 0.34, 0.30), alloy);
    lintel.position.set(0, DISC_Y + 0.02, 0);
    g.add(lintel);
    kit.disposables.push(lintel.geometry);

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
        side: THREE.DoubleSide,
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
    // A dedicated scene the destination world is briefly re-parented into. Its
    // light rig is structurally identical to main.js's (ambient + hemi + one
    // directional) so shared materials resolve to the same shader program and
    // nothing recompiles when we bounce between scenes.
    this._previewScene = new THREE.Scene();
    this._previewAmbient = new THREE.AmbientLight(0xffffff, 0.6);
    this._previewHemi = new THREE.HemisphereLight(0xffffff, 0x404040, 0.5);
    this._previewSun = new THREE.DirectionalLight(0xffffff, 2);
    this._previewSun.castShadow = false; // a second shadow pass is not worth it
    this._previewSunTarget = new THREE.Object3D();
    this._previewSun.target = this._previewSunTarget;
    this._previewScene.add(
      this._previewAmbient,
      this._previewHemi,
      this._previewSun,
      this._previewSunTarget
    );
    this._previewFog = new THREE.Fog(0x000000, 10, 400);
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
    const wm = this.worldManager;
    if (!wm?.isBuilt?.(portal.target)) return;
    const world = wm.getWorld(portal.target);
    // Never preview the world we are standing in - it is already on screen and
    // re-parenting the live group mid-frame would be a very bad idea.
    if (!world || world === wm.active) return;

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
    if (env.fogFar > 0) {
      this._previewFog.color.copy(env.fogColor);
      this._previewFog.near = env.fogNear;
      this._previewFog.far = env.fogFar;
      this._previewScene.fog = this._previewFog;
    } else {
      this._previewScene.fog = null;
    }

    const group = world.group;
    const parent = group.parent;
    const wasVisible = group.visible;
    group.visible = true;
    this._previewScene.add(group);

    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevShadowAuto = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false;
    r.setRenderTarget(portal.rt);
    r.render(this._previewScene, cam);
    r.setRenderTarget(prevTarget);
    r.shadowMap.autoUpdate = prevShadowAuto;

    this._previewScene.remove(group);
    group.visible = wasVisible;
    if (parent) parent.add(group);

    portal.discMat.uniforms.uHasPreview.value = 1;
    portal.discMat.uniforms.uPreviewExposure.value = env.exposure ?? 1;
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
      // Kick the build so the wait is as short as it can be, then transition
      // anyway: activate() awaits the same in-flight promise.
      wm.build(portal.target).catch((err) =>
        console.error('[Portals] destination build failed:', err)
      );
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
      _v1.set(feet.x, feet.y + 0.95, feet.z).sub(p.discPosition);
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

      const stability = p.ready ? 1 : 0.18 + 0.1 * Math.sin(elapsed * 3.1 + i);
      const du = p.discMat.uniforms;
      du.uTime.value = elapsed;
      du.uStability.value += (stability - du.uStability.value) * Math.min(1, dt * 2.5);
      du.uIntensity.value = 1 + p._proximity * 0.55;
      p.haloMat.uniforms.uTime.value = elapsed;
      p.haloMat.uniforms.uIntensity.value = (p.ready ? 1 : 0.45) * (1 + p._proximity * 0.9);
      p.moteMat.uniforms.uTime.value = elapsed;
      p.moteMat.uniforms.uBoost.value = 1 + p._proximity * 0.7;
      p.emberMat.uniforms.uTime.value = elapsed;

      // Light spill: a slow pulse plus a fast flicker so it never looks static.
      const pulse =
        0.82 +
        0.18 * Math.sin(elapsed * 1.7 + p._lightPhase) +
        0.06 * Math.sin(elapsed * 11.3 + p._lightPhase);
      // Base candela matches the constructor: the spill has to read on the dais
      // without pushing the stone past the world's bloom threshold, which is
      // what turned the whole plinth into an amber flare in review round one.
      if (p.light) p.light.intensity = (p.ready ? 8.5 : 3.5) * pulse * (1 + p._proximity * 0.6);

      p.sign.position.y = DISC_Y + ARCH_R + 0.72 + Math.sin(elapsed * 0.9 + i) * 0.05;

      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = p;
      }

      if (
        p.ready &&
        !p.previewFailed &&
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
