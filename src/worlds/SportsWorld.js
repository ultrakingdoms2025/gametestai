import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { World } from './World.js';
import { Collider, COLLISION_LAYER } from '../physics/Physics.js';

/**
 * SPORTS COMPLEX - "Meridian Athletic Grounds".
 *
 * A 400x400 m open-air sports park under hard midday light. Everything here is
 * generated procedurally: concrete is a signed-distance heightfield, snow is a
 * radial mound, court markings are drawn 1:1 into canvases so the proportions
 * are actually correct, and all of the skateable surfaces are baked into
 * chunked triangle-mesh colliders so the player can drop into the bowl.
 *
 * Two collision strategies are used deliberately:
 *   - smooth swept surfaces (bowl, half pipe, snake run, quarter pipes, piste)
 *     become chunked triangle soups. Chunking matters: Physics brute-forces
 *     every triangle in a collider, so one 60k-tri mesh would stall the solver.
 *     ~5 m chunks keep the broadphase useful and the per-tick triangle count in
 *     the hundreds.
 *   - hard-edged furniture (ledges, funboxes, stairs, rails, pool walls) uses
 *     oriented boxes, which give crisp vertical faces a heightfield cannot.
 */

/* ------------------------------------------------------------------ */
/* Module-scope scratch - never allocate in a loop or a frame handler.  */
/* ------------------------------------------------------------------ */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _e1 = new THREE.Euler();
const _s1 = new THREE.Vector3(1, 1, 1);
const _m1 = new THREE.Matrix4();
const _color = new THREE.Color();
/** Eight camera-frustum corners, reused by the shadow-fitting rig. */
const _corners = [];
for (let i = 0; i < 8; i++) _corners.push(new THREE.Vector3());

const DEG = Math.PI / 180;
const UNIT_Z = new THREE.Vector3(0, 0, 1);

/* ------------------------------------------------------------------ */
/* Math + noise                                                        */
/* ------------------------------------------------------------------ */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * (3 - 2 * t);
}

/** Deterministic 32-bit hash -> [0,1). Used for every "random" placement. */
function hash2i(x, y, seed) {
  let n = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 1274126177;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/**
 * Jittered-grid cellular field, returned as a per-cell random value in [0,1)
 * with soft borders.
 *
 * A poured slab is not one material: it is a set of bays, each screeded on a
 * different day by a different gang, and adjacent bays differ in value by
 * 8-12%. No fBm reproduces that - fBm is band-limited and continuous, and what
 * makes concrete read as concrete at 60 m is *discontinuity* on a 10-15 m
 * module. This is the only term in the stack that has a hard edge in it, which
 * is exactly why 7,500 m2 of pad reads as a car park without it.
 *
 * @param {number} border metres of soft blend either side of a cell boundary.
 */
function cellValue(x, z, size, seed, border = 0.35) {
  const gx = Math.floor(x / size);
  const gz = Math.floor(z / size);
  let best = Infinity;
  let second = Infinity;
  let bestV = 0;
  let secondV = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = gx + i;
      const cz = gz + j;
      const jx = (cx + 0.15 + hash2i(cx, cz, seed) * 0.7) * size;
      const jz = (cz + 0.15 + hash2i(cx, cz, seed + 91) * 0.7) * size;
      const d = Math.hypot(x - jx, z - jz);
      const v = hash2i(cx, cz, seed + 313);
      if (d < best) {
        second = best; secondV = bestV;
        best = d; bestV = v;
      } else if (d < second) {
        second = d; secondV = v;
      }
    }
  }
  // The F2-F1 gap is a distance-to-boundary estimate; feathering on it is what
  // keeps the seam from aliasing into a hard polygonal net at grazing angles.
  const t = clamp01((second - best) / (border * 2));
  return lerp((bestV + secondV) * 0.5, bestV, t * t * (3 - 2 * t));
}

/** Small deterministic PRNG so a rebuild always produces the same park. */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Tileable value noise. The lattice coordinates wrap on `period`, which is what
 * keeps every generated texture seamless when it repeats across a court.
 */
function tileNoise(x, y, period, seed) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const wx0 = ((x0 % period) + period) % period;
  const wy0 = ((y0 % period) + period) % period;
  const wx1 = (wx0 + 1) % period;
  const wy1 = (wy0 + 1) % period;
  const a = hash2i(wx0, wy0, seed);
  const b = hash2i(wx1, wy0, seed);
  const c = hash2i(wx0, wy1, seed);
  const d = hash2i(wx1, wy1, seed);
  const top = a + (b - a) * sx;
  const bot = c + (d - c) * sx;
  return top + (bot - top) * sy;
}

/** Seamless fBm over the unit square. `base` must be an integer lattice size. */
function fbm(u, v, base, octaves, seed) {
  let amp = 0.5;
  let sum = 0;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * tileNoise(u * base * f, v * base * f, base * f, seed + o * 137);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/* ------------------------------------------------------------------ */
/* Canvas + texture helpers                                            */
/* ------------------------------------------------------------------ */

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Fill a canvas from a per-pixel callback returning [r,g,b] in 0..255.
 * Faster than thousands of tiny fillRect calls and gives us noise for free.
 */
function paintPixels(canvas, fn) {
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(canvas.width, canvas.height);
  const d = img.data;
  const w = canvas.width;
  const h = canvas.height;
  const out = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      fn(x / w, y / h, out, x, y);
      const i = (y * w + x) * 4;
      d[i] = out[0];
      d[i + 1] = out[1];
      d[i + 2] = out[2];
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Row-chunked async twin of {@link paintPixels}: yields through `breathe`
 * every `rows` scanlines so a multi-megapixel canvas (the 2048x1024 sky) does
 * not land as one multi-hundred-millisecond block during a background build.
 */
async function paintPixelsAsync(canvas, fn, breathe, rows = 64) {
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(canvas.width, canvas.height);
  const d = img.data;
  const w = canvas.width;
  const h = canvas.height;
  const out = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      fn(x / w, y / h, out, x, y);
      const i = (y * w + x) * 4;
      d[i] = out[0];
      d[i + 1] = out[1];
      d[i + 2] = out[2];
      d[i + 3] = 255;
    }
    if ((y & (rows - 1)) === 0 && breathe) await breathe();
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function normalFromHeight(canvas, strength = 2.0) {
  const w = canvas.width;
  const h = canvas.height;
  const src = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const data = new Uint8Array(w * h * 4);
  const at = (x, y) => src[((((y % h) + h) % h) * w + (((x % w) + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = at(x - 1, y);
      const r = at(x + 1, y);
      const u = at(x, y - 1);
      const d = at(x, y + 1);
      let nx = (l - r) * strength;
      let ny = (u - d) * strength;
      const nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv;
      ny *= inv;
      const i = (y * w + x) * 4;
      data[i] = (nx * 0.5 + 0.5) * 255;
      data[i + 1] = (ny * 0.5 + 0.5) * 255;
      data[i + 2] = nz * inv * 255;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Build a coverage-preserving mip chain for an alpha-tested mask.
 *
 * A box filter preserves the MEAN of a mask, not the fraction of texels that
 * survive an alpha test - and for a mask that is mostly one value those two
 * things diverge violently. Chain-link is ~85% open, so box-filtering it drives
 * every texel toward the same low-ish average: below a high threshold the wires
 * disappear, above a low threshold every texel passes and the fence becomes a
 * solid sheet. Both failure modes were visible in this world at different
 * thresholds.
 *
 * Castano's fix: after downsampling, bisect a per-level scale `k` such that
 * `mean(alpha * k > threshold)` matches the level-0 coverage. The mask then
 * thins out with distance the way the real object does.
 *
 * @param {HTMLCanvasElement} canvas grayscale mask; the red channel is the alpha.
 * @param {number} threshold the `alphaTest` the material will use.
 * @returns {THREE.DataTexture} with `mipmaps` populated and `generateMipmaps` off.
 */
function makeCoverageMips(canvas, threshold = 0.5) {
  const w0 = canvas.width;
  const h0 = canvas.height;
  const src = canvas.getContext('2d').getImageData(0, 0, w0, h0).data;

  /** Level 0 alpha in 0..1, plus its coverage ratio. */
  let level = new Float32Array(w0 * h0);
  let covered = 0;
  for (let i = 0; i < level.length; i++) {
    level[i] = src[i * 4] / 255;
    if (level[i] > threshold) covered++;
  }
  const targetCoverage = covered / level.length;

  const pack = (a, w, h) => {
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < a.length; i++) {
      const v = clamp(Math.round(a[i] * 255), 0, 255);
      data[i * 4] = v;
      data[i * 4 + 1] = v;
      data[i * 4 + 2] = v;
      data[i * 4 + 3] = v;
    }
    return { data, width: w, height: h };
  };

  const mipmaps = [pack(level, w0, h0)];
  let w = w0;
  let h = h0;
  while (w > 1 || h > 1) {
    const nw = Math.max(1, w >> 1);
    const nh = Math.max(1, h >> 1);
    const next = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const x0 = Math.min(x * 2, w - 1);
        const x1 = Math.min(x * 2 + 1, w - 1);
        const y0 = Math.min(y * 2, h - 1);
        const y1 = Math.min(y * 2 + 1, h - 1);
        next[y * nw + x] =
          (level[y0 * w + x0] + level[y0 * w + x1] + level[y1 * w + x0] + level[y1 * w + x1]) * 0.25;
      }
    }
    // Bisect the scale that restores the level-0 coverage ratio. Ten iterations
    // lands within 0.1% and this runs a dozen times at load, not per frame.
    let lo = 0.0;
    let hi = 24.0;
    let k = 1.0;
    for (let it = 0; it < 12; it++) {
      k = (lo + hi) * 0.5;
      let c = 0;
      for (let i = 0; i < next.length; i++) if (next[i] * k > threshold) c++;
      if (c / next.length < targetCoverage) lo = k;
      else hi = k;
    }
    for (let i = 0; i < next.length; i++) next[i] = Math.min(1, next[i] * k);
    mipmaps.push(pack(next, nw, nh));
    level = next;
    w = nw;
    h = nh;
  }

  const tex = new THREE.DataTexture(mipmaps[0].data, w0, h0, THREE.RGBAFormat);
  tex.mipmaps = mipmaps;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                    */
/* ------------------------------------------------------------------ */

/** In-place transform of a geometry, used before merging. */
function xform(geo, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _e1.set(rx, ry, rz);
  _q1.setFromEuler(_e1);
  _s1.set(sx, sy, sz);
  _v1.set(x, y, z);
  _m1.compose(_v1, _q1, _s1);
  geo.applyMatrix4(_m1);
  return geo;
}

/**
 * Give a geometry a neutral white `color` attribute.
 *
 * This is load-bearing, not cosmetic. `InstancedMesh.setColorAt()` writes an
 * `instanceColor` attribute, but three's `color_fragment` chunk only multiplies
 * `vColor` into the albedo when USE_COLOR is defined - and USE_COLOR comes from
 * `material.vertexColors`, not from the presence of instanceColor. So an
 * instanced mesh that tints via setColorAt needs `vertexColors: true`... at
 * which point `color_vertex` compiles `vColor *= color`, and a geometry with no
 * `color` attribute falls back to the generic vertex attribute default of
 * (0,0,0) and renders black.
 *
 * Both halves are required. Missing the first is why the crowd, the bleacher
 * seats, the lane ropes and the car park all rendered as unpigmented white.
 */
function whiteColor(geo) {
  const n = geo.getAttribute('position').count;
  const c = new Float32Array(n * 3).fill(1);
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo;
}

/** A thin box spanning two world points - the primitive every rail and net strand uses. */
function strut(ax, ay, az, bx, by, bz, thickness) {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-4;
  const geo = new THREE.BoxGeometry(thickness, thickness, len);
  _v1.set(0, 0, 1);
  _v2.set(dx / len, dy / len, dz / len);
  _q1.setFromUnitVectors(_v1, _v2);
  _s1.set(1, 1, 1);
  _v1.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  _m1.compose(_v1, _q1, _s1);
  geo.applyMatrix4(_m1);
  return geo;
}

/**
 * Force a near-horizontal indexed triangle soup to be front-facing *upward*.
 *
 * This is not cosmetic. `ribbon()` and `_fan()` both emit their triangles as
 * (left_i, left_i+1, right_i), and with the ribbon normal defined as the
 * tangent rotated -90 degrees about +Y that winding evaluates to a face normal
 * of -Y: every path, verge, gravel shoulder, pool coping and - most visibly -
 * the entire 400 m running track was being back-face culled and had never once
 * rendered. Summing the cross-product's Y over the whole soup and flipping if
 * it comes out negative fixes both helpers at the source and stays correct if
 * either one is ever re-authored with the opposite winding.
 */
function orientUp(geo) {
  const idx = geo.getIndex();
  if (!idx) return geo;
  const a = idx.array;
  const p = geo.getAttribute('position').array;
  let sum = 0;
  for (let i = 0; i + 2 < a.length; i += 3) {
    const i0 = a[i] * 3;
    const i1 = a[i + 1] * 3;
    const i2 = a[i + 2] * 3;
    const e1x = p[i1] - p[i0];
    const e1z = p[i1 + 2] - p[i0 + 2];
    const e2x = p[i2] - p[i0];
    const e2z = p[i2 + 2] - p[i0 + 2];
    sum += e1z * e2x - e1x * e2z; // Y component of e1 x e2
  }
  if (sum < 0) {
    for (let i = 0; i + 2 < a.length; i += 3) {
      const t = a[i + 1];
      a[i + 1] = a[i + 2];
      a[i + 2] = t;
    }
    idx.needsUpdate = true;
    geo.computeVertexNormals();
  }
  return geo;
}

/**
 * Flat ribbon along a 2D polyline. Used for paths, the running track and the
 * pool coping. `uAcross` maps 0..1 across the width so lane textures line up.
 */
function ribbon(points, halfWidth, y, closed, vScale = 0.25) {
  const yAt = typeof y === 'function' ? y : () => y;
  const n = points.length;
  // A closed ribbon repeats its first section so the V coordinate never has to
  // wrap inside a quad - otherwise the seam quad crushes the whole texture.
  const list = closed ? points.concat([points[0]]) : points;
  const count = list.length;
  const pos = new Float32Array(count * 2 * 3);
  const uv = new Float32Array(count * 2 * 2);
  const nrm = new Float32Array(count * 2 * 3);
  let dist = 0;
  for (let i = 0; i < count; i++) {
    const p = list[i];
    const prev = points[(i - 1 + n) % n];
    const next = points[(i + 1) % n];
    let tx = next[0] - prev[0];
    let tz = next[1] - prev[1];
    if (!closed && i === 0) {
      tx = points[1][0] - p[0];
      tz = points[1][1] - p[1];
    } else if (!closed && i === n - 1) {
      tx = p[0] - points[n - 2][0];
      tz = p[1] - points[n - 2][1];
    }
    const tl = Math.hypot(tx, tz) || 1;
    const nx = -tz / tl;
    const nz = tx / tl;
    if (i > 0) dist += Math.hypot(p[0] - list[i - 1][0], p[1] - list[i - 1][1]);
    const a = i * 6;
    const lx = p[0] - nx * halfWidth;
    const lz = p[1] - nz * halfWidth;
    const rx = p[0] + nx * halfWidth;
    const rz = p[1] + nz * halfWidth;
    pos[a] = lx;
    pos[a + 1] = yAt(lx, lz);
    pos[a + 2] = lz;
    pos[a + 3] = rx;
    pos[a + 4] = yAt(rx, rz);
    pos[a + 5] = rz;
    nrm[a + 1] = 1;
    nrm[a + 4] = 1;
    const b = i * 4;
    uv[b] = 0;
    uv[b + 1] = dist * vScale;
    uv[b + 2] = 1;
    uv[b + 3] = dist * vScale;
  }
  const segs = count - 1;
  const idx = new Uint32Array(segs * 6);
  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    const b = (i + 1) * 2;
    idx[i * 6] = a;
    idx[i * 6 + 1] = b;
    idx[i * 6 + 2] = a + 1;
    idx[i * 6 + 3] = b;
    idx[i * 6 + 4] = b + 1;
    idx[i * 6 + 5] = a + 1;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  orientUp(geo);
  geo.computeBoundingSphere();
  return geo;
}

/** Centreline of a 400 m-style oval: two straights joined by semicircles. */
function ovalPath(cx, cz, straightLen, radius, arcSegs = 40, straightSegs = 14) {
  const pts = [];
  const hs = straightLen / 2;
  for (let i = 0; i <= arcSegs; i++) {
    const a = -Math.PI / 2 + (i / arcSegs) * Math.PI;
    pts.push([cx + hs + Math.cos(a) * radius, cz + Math.sin(a) * radius]);
  }
  for (let i = 1; i < straightSegs; i++) {
    pts.push([cx + hs - (i / straightSegs) * straightLen, cz + radius]);
  }
  for (let i = 0; i <= arcSegs; i++) {
    const a = Math.PI / 2 + (i / arcSegs) * Math.PI;
    pts.push([cx - hs + Math.cos(a) * radius, cz + Math.sin(a) * radius]);
  }
  for (let i = 1; i < straightSegs; i++) {
    pts.push([cx - hs + (i / straightSegs) * straightLen, cz - radius]);
  }
  return pts;
}

/**
 * Shared GLSL: 2D value noise, sampled in *world* metres.
 *
 * Every tiling ground texture in this world mips to a single averaged colour
 * somewhere between 80 and 150 m, which is exactly the band that makes a 400 m
 * site read as untextured vertex colour. A world-space macro term has no tile
 * period at all, so it survives every mip level and keeps albedo variation
 * alive out to the horizon. It also gives us cloud shadows for four more
 * instructions, which is the cheapest large-scale value composition there is.
 */
const SITE_NOISE_GLSL = `
  float aeHash( vec2 p ) {
    p = fract( p * vec2( 234.34, 435.345 ) );
    p += dot( p, p + 34.23 );
    return fract( p.x * p.y );
  }
  float aeNoise( vec2 p ) {
    vec2 i = floor( p );
    vec2 f = fract( p );
    vec2 u = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( aeHash( i ), aeHash( i + vec2( 1.0, 0.0 ) ), u.x ),
                mix( aeHash( i + vec2( 0.0, 1.0 ) ), aeHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
  }
`;

/**
 * Rewrite a geometry's UVs as a world-metre box projection.
 *
 * `BoxGeometry` gives every face a 0..1 UV regardless of its size, so a 42 m
 * bleacher front stretches its concrete tile 42:1 and renders as horizontal
 * smear bands. Projecting on the dominant axis of each face normal at a fixed
 * metres-per-tile rate makes texel density uniform across every box in a merged
 * batch. Call it *before* the geometry is merged, while its transform is baked.
 */
function boxProjectUV(geo, metresPerTile = 2.0) {
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  if (!pos || !nrm) return geo;
  const uv = new Float32Array(pos.count * 2);
  const inv = 1 / metresPerTile;
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nrm.getX(i));
    const ny = Math.abs(nrm.getY(i));
    const nz = Math.abs(nrm.getZ(i));
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    let u;
    let v;
    if (ny >= nx && ny >= nz) { u = x; v = z; }
    else if (nx >= nz) { u = z; v = y; }
    else { u = x; v = y; }
    uv[i * 2] = u * inv;
    uv[i * 2 + 1] = v * inv;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

const yieldFrame = () =>
  new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });

/* ------------------------------------------------------------------ */
/* Zone layout                                                         */
/* ------------------------------------------------------------------ */

/** Skate pad footprint. Local u = x + 125, v = z. Deck sits 10 cm proud of grass. */
const PAD = { x0: -125, z0: 0, x1: -25, z1: 75, base: 0.1 };
/** Ski mound footprint (feathers to zero at its own edges). */
const SKI = { x0: -129, z0: -201, x1: 4, z1: -71, top: 52 };
/** Snow line, rock band and scree band, in metres of elevation on the mound. */
const SNOW_LINE = 31;
const ROCK_LINE = 15;
const SCREE_LINE = 5.5;
/** Pool complex footprint - deck and basin are boxes, so the ground tiles here are removed. */
const POOL = { x0: 25, z0: 100, x1: 75, z1: 125 };
/** Running track centre. 84.39 m straights, 36.5 m inner radius, 8 x 1.22 m lanes. */
const TRACK = { cx: 105, cz: -100, straight: 84.39, inner: 36.5, lanes: 8, laneW: 1.22 };

/* ------------------------------------------------------------------ */
/* Skate park surface field                                            */
/* ------------------------------------------------------------------ */

/* Kidney bowl = union of two overlapping discs. The union is star-shaped about
 * any point in their intersection, which is what lets us trace the coping line
 * by radial bisection later on. */
const BOWL_A = { u: 30, v: 40, r: 13.0 };
const BOWL_B = { u: 48, v: 34, r: 9.5 };
const BOWL_SEED = { u: 40, v: 36.5 };

/** Positive inside the kidney, negative outside; magnitude ~ distance to the lip. */
function bowlInset(u, v) {
  const a = BOWL_A.r - Math.hypot(u - BOWL_A.u, v - BOWL_A.v);
  const b = BOWL_B.r - Math.hypot(u - BOWL_B.u, v - BOWL_B.v);
  return a > b ? a : b;
}

/** Deep end to the west, shallow end under the smaller lobe. */
function bowlDepth(u) {
  return lerp(3.4, 2.0, clamp01((u - 30) / 18));
}

/**
 * Quarter-circle transition profile. `d` is distance in from the coping,
 * `R` the transition radius. y(0) = 0 with a vertical tangent (true coping),
 * y(R) = -R with a horizontal tangent (flat bottom).
 */
function transition(d, R) {
  const t = d > R ? R : d;
  const k = t - R;
  return -Math.sqrt(Math.max(0, R * R - k * k));
}

const HALFPIPE = { u0: 64, u1: 92, vc: 16, flat: 4.0, R: 2.6 };
const SNAKE = { u0: 56, u1: 98, flat: 1.8, R: 2.0 };
const QP = { u0: 4, u1: 54, v0: 62, R: 3.0 };
const PUMP = { cu: 79, cv: 37.5, a: 15, b: 7 };

function snakeCentre(u) {
  return 61 + 7 * Math.sin((u - SNAKE.u0) * 0.19);
}

/**
 * Height of the concrete, in pad-local coordinates. Feature footprints are laid
 * out so they never overlap, which means the contributions simply sum and the
 * whole park stays C1 continuous where it matters.
 */
function padLocalHeight(u, v) {
  let y = 0;

  // Kidney bowl.
  const d = bowlInset(u, v);
  if (d > 0) y += transition(d, bowlDepth(u));

  // Half pipe (in-ground mini ramp) with rolled-in ends.
  if (u > HALFPIPE.u0 && u < HALFPIPE.u1) {
    const t = Math.abs(v - HALFPIPE.vc);
    const lim = HALFPIPE.flat + HALFPIPE.R;
    if (t < lim) {
      const ease = smoothstep(0, 3.5, Math.min(u - HALFPIPE.u0, HALFPIPE.u1 - u));
      const dd = t <= HALFPIPE.flat ? HALFPIPE.R : lim - t;
      y += transition(dd, HALFPIPE.R) * ease;
    }
  }

  // Serpentine snake run.
  if (u > SNAKE.u0 && u < SNAKE.u1) {
    const t = Math.abs(v - snakeCentre(u));
    const lim = SNAKE.flat + SNAKE.R;
    if (t < lim) {
      const ease = smoothstep(0, 4, Math.min(u - SNAKE.u0, SNAKE.u1 - u));
      const dd = t <= SNAKE.flat ? SNAKE.R : lim - t;
      y += transition(dd, SNAKE.R) * ease;
    }
  }

  // North quarter-pipe wall: curve up to a deck, then a mellow bank back down.
  if (u > QP.u0 && u < QP.u1 && v > QP.v0) {
    const lat = smoothstep(QP.u0, QP.u0 + 6, u) * (1 - smoothstep(QP.u1 - 6, QP.u1, u));
    if (lat > 0) {
      let h;
      const s = v - QP.v0;
      if (s <= QP.R) h = QP.R - Math.sqrt(Math.max(0, QP.R * QP.R - s * s));
      else if (v <= 70) h = QP.R;
      else h = QP.R * (1 - smoothstep(70, 75, v));
      y += h * lat;
    }
  }

  // Pump track: rollers plus a banked outer wall, on an elliptical loop.
  const ex = (u - PUMP.cu) / PUMP.a;
  const ez = (v - PUMP.cv) / PUMP.b;
  const e = Math.hypot(ex, ez);
  if (e > 0.5 && e < 1.1) {
    const m = smoothstep(0.52, 0.68, e) * (1 - smoothstep(0.94, 1.08, e));
    if (m > 0) {
      const th = Math.atan2(ez, ex);
      const rollers = 0.5 * (0.5 + 0.5 * Math.cos(th * 10));
      const berm = 0.8 * smoothstep(0.8, 1.0, e);
      y += m * (rollers + berm);
    }
  }

  // Troweled undulation - concrete is never dead flat and the specular tells.
  y += (fbm(u / 100, v / 75, 4, 3, 91) - 0.5) * 0.05;
  return y;
}

/** World-space concrete height. Returns PAD.base outside the pad footprint. */
function padHeight(x, z) {
  return PAD.base + padLocalHeight(x - PAD.x0, z - PAD.z0);
}

/* ------------------------------------------------------------------ */
/* Site terrain                                                        */
/* ------------------------------------------------------------------ */

/**
 * Built pads are cut into the terrain rather than sitting on it. Each rect is
 * levelled to y=0 and feathered out over FLAT_FEATHER metres, which produces
 * readable cut-and-fill banks around every facility instead of a tabletop.
 */
const FLAT_ZONES = [
  [PAD.x0 - 2, PAD.z0 - 2, PAD.x1 + 2, PAD.z1 + 4],
  [SKI.x0, SKI.z0 - 4, SKI.x1, SKI.z1 + 4],
  [POOL.x0 - 9, POOL.z0 - 5, POOL.x1 + 2, POOL.z1 + 3],
  // Tightened to the actual built footprints + ~2 m. The courts enclosure runs
  // 64..126 x 4..48 and the 400 m track's outer lane reaches 16.5..193.5 x
  // -146..-54, so neither of these can shrink much further without putting a
  // camber through a playing surface - but every metre they give back is a
  // metre the mid-frequency terrain band gets to move.
  [63, 3, 127, 49],
  [15, -149, 195, -51],
  [-30, 120, 30, 182],
  [-66, 126, -26, 152],
  [86, 130, 170, 194],
  [-62, -78, -30, -45],
];
// Wider than the old 17 m because the base octave now carries twice the
// amplitude: a bank has to stay under ~22 deg or the player cannot walk out of
// the cut, and slope = amplitude / feather.
const FLAT_FEATHER = 22;

function flatMask(x, z) {
  let m = 0;
  for (let i = 0; i < FLAT_ZONES.length; i++) {
    const r = FLAT_ZONES[i];
    const d = Math.min(Math.min(x - r[0], r[2] - x), Math.min(z - r[1], r[3] - z));
    const k = smoothstep(-FLAT_FEATHER, 0, d);
    if (k > m) m = k;
  }
  return m;
}

/** Axis-aligned gaussian ridge/hollow. Slope peaks at A*sqrt(2)/sigma*e^-0.5. */
function gaussBand(t, centre, sigma) {
  const k = (t - centre) / sigma;
  return Math.exp(-k * k);
}

/**
 * Two authored landforms the player physically crests on the way in.
 *
 * Procedural fBm alone gives amplitude but no *intent* - nothing is ever
 * between the player and where they are going. These two are placed on the
 * spawn-to-skatepark and spawn-to-courts desire lines specifically so the
 * approach has a horizon that rises, breaks, and reveals.
 */
function landforms(x, z) {
  let h = 0;
  // Grassy berm ridge running east-west across the avenue between the plaza and
  // the skate pad.
  //
  // Centred at z = 92 with a 26 m sigma, not at 106 with 22. At the tighter
  // spacing the crest reached 6 m only 14 m out from the plaza edge, which is a
  // 23-degree wall directly across the spawn sightline - it hid the entire park
  // rather than revealing it. Pushed back and flattened, the same 7 m of relief
  // subtends about 7 degrees from the spawn: a landform you read and then crest,
  // with the tower and the mountain still legible over the top of it.
  h += 7.0 * gaussBand(z, 92, 26) *
    smoothstep(-152, -118, x) * (1 - smoothstep(46, 74, x));
  // Bowl-shaped hollow west of the courts, on the plaza-to-track spur. The path
  // network runs straight through it, so the route dips out of sight and back.
  const dx = (x - 44) / 30;
  const dz = (z - 22) / 26;
  h -= 6.2 * Math.exp(-(dx * dx + dz * dz));
  return h;
}

/**
 * Ground elevation for the whole site. A long-wavelength base octave carries
 * the valley form, a 37 m band gives the mid-ground a silhouette at 30-80 m,
 * two authored landforms give the approach an actual crest, and a perimeter
 * ridge climbs past the play boundary so the horizon is a landform rather than
 * the raw edge of a plane.
 */
function parkHeight(x, z) {
  const m = flatMask(x, z);
  if (m >= 0.999) return 0;
  const u = (x + 260) / 520;
  const v = (z + 260) / 520;
  // Base octave at lattice 4 (~130 m wavelength) rather than 6: twice the
  // amplitude at a gentler grade, so the valley reads without becoming a
  // staircase of unclimbable banks.
  let h = (fbm(u, v, 4, 3, 401) - 0.5) * 18.0;
  h += (fbm(u, v, 14, 2, 413) - 0.5) * 4.6;
  h += (fbm(u, v, 34, 2, 409) - 0.5) * 1.3;
  h += landforms(x, z);
  const r = Math.max(Math.abs(x), Math.abs(z)) / 200;
  h += smoothstep(0.6, 1.0, r) * 8.0;
  if (r > 1) h += (r - 1) * 62 + fbm(u, v, 11, 2, 417) * (r - 1) * 40;
  return h * (1 - m);
}

/* ------------------------------------------------------------------ */
/* Ski mound surface field                                             */
/* ------------------------------------------------------------------ */

const KICKER = { x: -38, z: -132, w: 7, len: 11, h: 2.4 };
/** Fall-line centres of the three groomed corridors. */
const PISTE_LANES = [-96, -62, -32];

/**
 * Snow height. A longitudinal cosine profile (~23 deg average pitch) modulated
 * by a lateral falloff whose width grows with altitude, so the flanks stay
 * plausible instead of becoming a 40 m cliff at the tree line.
 */
function skiHeight(x, z) {
  const fz = 0.5 - 0.5 * Math.cos(Math.PI * clamp01((-72 - z) / 126));
  if (fz <= 0.0005) return 0;
  const edge = Math.min(x - SKI.x0, SKI.x1 - x);
  if (edge <= 0) return 0;
  const width = 12 + 38 * fz;
  const fx = smoothstep(0, width, edge);
  let h = SKI.top * fz * fx;
  if (h < 0.02) return h;

  // Rolling terrain, then a mogul field on the skier's left of the fall line.
  h += (fbm((x + 130) / 140, (z + 205) / 135, 3, 3, 17) - 0.5) * 3.2 * fx;
  // Cross-slope undulation. Without it the mound is a dome and the eye has
  // nothing to read the curvature against once the snow blows out.
  h += (fbm((x + 150) / 78, (z + 215) / 78, 6, 3, 23) - 0.5) * 1.6 * fx;

  // Three groomed corridors with banked outside edges: the piste structure is
  // what turns the silhouette from a meringue into a mountain.
  for (let i = 0; i < 3; i++) {
    const w = 9 + i * 1.6;
    const c = PISTE_LANES[i] + Math.sin((z + 200) * 0.034 + i) * 5.5;
    const t = Math.abs(x - c) / w;
    if (t > 1.8) continue;
    const dip = -1.45 * (1 - smoothstep(0.55, 1.05, t));
    const berm = 1.05 * Math.exp(-((t - 1.18) * (t - 1.18)) / 0.05);
    h += (dip + berm) * fx * fz;
  }
  const mogulMask =
    smoothstep(-108, -98, x) * (1 - smoothstep(-76, -66, x)) *
    smoothstep(-168, -158, z) * (1 - smoothstep(-116, -104, z));
  if (mogulMask > 0) {
    h += mogulMask * 0.5 * Math.cos((x + 3) * 1.15) * Math.cos((z + 7) * 1.15) + mogulMask * 0.5;
  }

  // Terrain-park kicker: smooth run-in, sharp lip.
  const kx = Math.abs(x - KICKER.x);
  if (kx < KICKER.w && z > KICKER.z && z < KICKER.z + KICKER.len) {
    const along = (z - KICKER.z) / KICKER.len;
    const lat = 1 - smoothstep(KICKER.w - 3.5, KICKER.w, kx);
    // Skiers travel toward +z, so the ramp climbs and then breaks at the lip.
    h += KICKER.h * lat * Math.pow(along, 1.7);
  }
  return h;
}

/* ------------------------------------------------------------------ */
/* World                                                               */
/* ------------------------------------------------------------------ */

export class SportsWorld extends World {
  static id = 'sports';
  static displayName = 'Meridian Athletic Grounds';

  constructor(ctx) {
    super(ctx);

    /** @type {Map<string, THREE.Texture>} */
    this._textures = new Map();
    /** @type {Map<string, THREE.Material>} */
    this._materials = new Map();
    /** Animated bits polled from update(); kept as plain fields to avoid lookups. */
    this._water = null;
    this._chairs = null;
    this._chairCount = 0;
    this._chairSpan = 1;
    this._chairPath = null;
    this._banners = [];
    this._laneRopes = null;
    this._envRT = null;
    this._rng = makeRng(0x5107);
    /**
     * One shared uniform object handed to every `_siteShader` material, so the
     * drifting cloud shadows across the lawn, the concrete and the snow all
     * agree and the whole site costs a single scalar write per frame.
     */
    this._shaderTime = { value: 0 };

    this.bounds = new THREE.Box3(
      new THREE.Vector3(-200, -6, -200),
      new THREE.Vector3(200, 70, 200)
    );

    // Lighting intent: ONE warm raking key at 16.5 deg elevation, a genuinely
    // weak cool bounce from below-and-behind, and a separate warm rim 160 deg
    // round in azimuth. Sun-to-shadow ratio at the ground is held near 6:1 by
    // starving the ambient/hemi/probe terms - the previous rig had the sky
    // probe alone lifting every shadow back to within a stop of the key, which
    // is what made every frame read as flat unlit albedo.
    Object.assign(this.environment, {
      background: new THREE.Color(0x74aee2),
      // Sampled from the horizon band of the sky canvas so the aerial
      // perspective joins the dome instead of banding against it.
      fogColor: new THREE.Color(0xc4d6e4),
      fogNear: 60,
      fogFar: 900,
      exposure: 0.94,
      ambientColor: new THREE.Color(0x8fa9cc),
      ambientIntensity: 0.030,
      skyColor: new THREE.Color(0x8fbde8),
      // Ground bounce warmed off olive and onto the concrete that actually
      // surrounds every hero surface here. 0.27, up from 0.19: at 0.19 the
      // bowl throat, the underside of the bleacher deck and every north-facing
      // wall sat below 3% luma, so a third of the frame carried no readable
      // detail at all - a starved fill is not the same thing as a strong key.
      // 0.27 against a 7.5 key at 14 deg still leaves a ~7:1 ground ratio,
      // which is the stated intent, but the shadow side now has somewhere to
      // live above pure black.
      groundColor: new THREE.Color(0x6a6055),
      hemiIntensity: 0.27,
      sunColor: new THREE.Color(0xffe4bc),
      sunIntensity: 7.5,
      // 14.1 deg elevation, raking in from the west. Every establishing view in
      // this world looks roughly down -Z, so a sun on the -X axis throws its
      // shadows straight across frame instead of hiding them behind their own
      // casters, and at this elevation every vertical face gets a terminator.
      // Lower than the old 16.5 because the pad now carries four 16 m masts and
      // a west fence line whose shadows have to REACH across 100 m of concrete:
      // shadow length is h/tan(elev), so 16.5 -> 14.1 deg takes a mast's throw
      // from 54 m to 64 m and puts the far tip past the pad's east kerb.
      sunDirection: new THREE.Vector3(-0.900, 0.2436, 0.3606).normalize(),
      // The probe now only has to keep metal from reading black. Per-material
      // envMapIntensity on the concrete / grass / foliage families is pulled to
      // 0.35-0.5 on top of this.
      envMapIntensity: 0.20,
      bloom: { strength: 0.30, radius: 0.62, threshold: 0.90 },
      grade: {
        saturation: 1.04,
        // 1.35, and the lift pulled to black. Nothing in either hero frame was
        // reaching below ~18% luma, so the histogram had no floor at all and
        // every surface sat in the same compressed mid-band. A raked 16.5-deg
        // key needs somewhere for its shadow side to go.
        contrast: 1.30,
        // 0x090e15, not 0x010305. Pulling the lift to black gave the histogram
        // a floor at 0.4% and then `contrast` crushed everything under it: the
        // bowl's vertical wall, the tree line and the foreground field all
        // landed in the same undifferentiated near-black with no readable
        // gradient. A 4-5% floor is what a real print looks like and it is
        // where the bowl's curvature becomes legible again.
        lift: new THREE.Color(0x090e15),
        gain: new THREE.Color(0xfff4e4),
        vignette: 0.32,
        temperature: 0.06,
        // >1 pushes the GTAO blend above the neutral default. The bowl throat,
        // the underside of the bleacher deck and the kerb/shoulder junctions
        // all need contact darkening that no vertex term can deliver at this
        // tessellation, and the pad's baked AO has deliberately been clamped to
        // a 26% ceiling to make room for it.
        // Pulled back to 1.12 now the pad bakes a real 0.56-floor concavity
        // term of its own: a 1.35 GTAO multiplier stacked on top of that was
        // compounding occlusion onto regions that were already the darkest
        // thing in the frame, which is how the bowl throat lost its curvature.
        ao: 1.12,
      },
    });

    // Exponential-squared aerial perspective. main.js only ever authors a
    // linear THREE.Fog from `environment.fogNear/fogFar`, and linear fog with a
    // 900 m far plane does nothing at the 200-400 m where this site actually
    // needs to lose contrast. We install this one on the scene ourselves while
    // the world is on screen; applyEnvironment() restores a linear fog on the
    // way out because FogExp2 is not an instanceof THREE.Fog.
    // 0.0014, down from 0.0024. Squared-exponential fog reaches 43% opacity at
    // 400 m at the old density, which is roughly a stop and a half of contrast
    // removed from the ski mound, the track and every backdrop ridge - i.e.
    // from everything that was supposed to be giving the site depth. At 0.0014
    // the same 400 m loses 21%: still clearly aerial perspective, but the
    // midday key survives to the horizon and forms keep their volume.
    // 0.0026, up from 0.0014. The old density reached only ~12% at 250 m, so
    // the whole 60-400 m band - which is 70% of every establishing frame - had
    // no depth cue at all and then stepped hard into the baked haze on the
    // backdrop rings. At 0.0026 the same 250 m loses 36% and 450 m loses 66%,
    // which is a monotonic ramp that actually joins the backdrop instead of
    // colliding with it. The saturation-loss term in `_siteShader` carries the
    // other half of the aerial perspective, so forms keep their volume rather
    // than simply being painted out.
    this._fog = new THREE.FogExp2(0xc4d6e4, 0.0026);

    /** Scene sun borrowed from the engine rig; re-aimed every frame. @type {THREE.DirectionalLight|null} */
    this._sun = null;
    this._sunBasis = new THREE.Quaternion();
    this._sunBasisInv = new THREE.Quaternion();
    /*
     * TWO CASCADES.
     *
     * A single 150 m ortho on a site with 400 m sightlines meant everything
     * past the near ring was simply unshadowed: no tree shadows on the lawn, no
     * mast shadows, nothing from the ski mound, and the stated 6:1 key-to-shadow
     * ratio was invisible in every wide shot.
     *
     * Cascade 0 is the engine's own sun, refit to the camera every frame at
     * 55 m / 4096 (~3 cm per texel) - that is the cascade that has to carry
     * contact shadows at a fence post and a bin.
     *
     * Cascade 1 is a second directional light we own, with a FIXED ortho box
     * centred on the world origin covering the entire site. Because the box
     * never moves and the casters are all static, its shadow map is rendered
     * exactly once per activation (`shadow.autoUpdate = false`) and costs
     * nothing per frame thereafter. 520 m across 2048 texels is ~25 cm, which
     * is coarse for a coping edge and completely fine for the 40 m shadow a
     * 12 m tree throws at this sun elevation.
     *
     * The key energy is split between the two so both cascades genuinely
     * darken: inside 55 m a fragment is in both frusta and loses the whole key,
     * beyond it only cascade 1 applies and the shadow keeps ~68% of its
     * density - which happens to fall off in the same direction aerial
     * perspective does, so it reads as distance rather than as a bug.
     */
    this._shadowRange = 55;
    this._shadowMapSize = 4096;
    // Radius of a sphere enclosing the whole play area (+/-200 m plus the
    // 52 m ski mound). It has to be a SPHERE fit, not the site half-extent: at
    // a 16.5-degree sun the ground projects into light space stretched by
    // 1/sin(16.5) = 3.5x along the azimuth, so an ortho sized to the footprint
    // would clip most of the site out of its own shadow map.
    this._farShadowRange = 300;
    this._farShadowMapSize = 2048;
    /** @type {THREE.DirectionalLight|null} */
    this._farSun = null;
    this._farShadowDirty = true;
    this._keySplitNear = 0.32;
    this._detachSunRig = null;
    /** Shadow settings borrowed from the engine rig, restored on deactivate. */
    this._sunRestore = null;
  }

  /**
   * Build the whole complex. Stages are ordered cheapest-first so the loading
   * bar moves early, and every stage yields a frame so the browser can paint.
   */
  async build(onProgress) {
    this._lastBreath = performance.now();
    const stage = async (p, label, fn) => {
      onProgress?.(p, label);
      await yieldFrame();
      this._lastBreath = performance.now();
      await fn.call(this);
    };

    await stage(0.02, 'Mixing concrete', () => this._buildTextures());
    await stage(0.16, 'Raising the sky', () => this._buildSky());
    await stage(0.24, 'Mowing the grass', () => this._buildGround());
    await stage(0.34, 'Pouring the bowl', () => this._buildSkatePark());
    await stage(0.50, 'Making snow', () => this._buildSkiZone());
    await stage(0.62, 'Chalking the track', () => this._buildTrack());
    await stage(0.70, 'Stringing the nets', () => this._buildCourts());
    await stage(0.78, 'Filling the pool', () => this._buildPool());
    await stage(0.85, 'Opening the clubhouse', () => this._buildStructures());
    await stage(0.93, 'Planting trees', () => this._buildLandscaping());
    await stage(0.98, 'Unlocking the gates', () => this._buildSpawns());
    this._installSunRig();
    onProgress?.(1, 'Ready to play');

    this.group.matrixAutoUpdate = false;
    this.group.updateMatrixWorld(true);
    // Worlds can be built in the background while another one is on screen, so
    // stay hidden until WorldManager calls onActivate().
    //
    // Scene membership is WorldManager's, not ours: it adds the group in
    // `_activate` and removes it in the swap. Adding it here left a world the
    // player has never visited parked in the live scene, hidden but still
    // traversed every frame - and its lights still visible to anything that
    // walks the scene looking for them.
    this.group.visible = this.active;
  }

  /* ---------------------------------------------------------------- */
  /* Small shared helpers                                              */
  /* ---------------------------------------------------------------- */

  /** Wrap a canvas as a texture with the project's colour-space rules. */
  _tex(canvas, { srgb = true, repeat = 1, repeatY = null, key = null } = {}) {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat, repeatY ?? repeat);
    tex.anisotropy = this.engine.renderer.capabilities.getMaxAnisotropy();
    tex.needsUpdate = true;
    if (key) this._textures.set(key, tex);
    return tex;
  }

  _registerTex(key, tex) {
    tex.anisotropy = this.engine.renderer.capabilities.getMaxAnisotropy();
    this._textures.set(key, tex);
    return tex;
  }

  _mat(key, material) {
    this._materials.set(key, material);
    return material;
  }

  /**
   * Cooperative yield for the background build. Time-gated so it can be called
   * every canvas/loop iteration cheaply: it only actually gives the frame back
   * to the renderer when more than `budgetMs` has elapsed since the last yield,
   * which keeps any single synchronous slice under ~one frame.
   */
  async _breathe(budgetMs = 6) {
    const now = performance.now();
    if (now - (this._lastBreath || 0) > budgetMs) {
      await yieldFrame();
      this._lastBreath = performance.now();
    }
  }

  /**
   * One shader injection point for every large site surface.
   *
   * All of these effects have to live in the same `onBeforeCompile` because a
   * material only gets one, and the grass alone needs four of them. Composing
   * them here also means the whole ground plane - lawn, concrete, tarmac,
   * gravel, snow, court acrylic - shares one macro-variation field and one
   * cloud-shadow field, so the surfaces agree with each other instead of each
   * inventing its own break-up.
   *
   * @param {THREE.Material} material must not already own `onBeforeCompile`.
   * @param {object} opts
   * @param {THREE.Texture} [opts.overlay] 1:1 site "art pass" texture; needs a `uvOverlay` attribute.
   * @param {boolean} [opts.polish] wheel-polish response on up-facing surfaces (skate concrete).
   * @param {number} [opts.flattenFar] metres at which the tangent normal is fully flattened.
   * @param {number} [opts.macro] 0..1 strength of the world-space albedo macro variation.
   * @param {number} [opts.dry] 0..1 strength of the warm dry-patch lobe on top of the macro term.
   * @param {number} [opts.clouds] 0..1 strength of drifting cloud shadow.
   * @param {number} [opts.desat] 0..1 strength of aerial saturation loss with depth.
   * @param {boolean} [opts.detile] two-tap decorrelated albedo, kills a visible tile repeat.
   * @param {boolean} [opts.specAA] NDF-filtering roughness widening for sub-pixel metal.
   */
  _siteShader(material, {
    overlay = null,
    polish = false,
    flattenFar = 0,
    macro = 0,
    dry = 0,
    clouds = 0,
    desat = 0,
    detile = false,
    specAA = false,
    // Endpoints of the macro tint ramp. The defaults are turf (cool damp green
    // -> warm dry green); snow and concrete need their own, because a lawn ramp
    // on a snowfield reads as algae.
    macroCool = [0.86, 0.91, 0.84],
    macroWarm = [1.15, 1.09, 1.05],
  } = {}) {
    const needWorld = macro > 0 || clouds > 0 || detile;
    const timeUniform = this._shaderTime;
    const F = (n) => n.toFixed(3);

    material.onBeforeCompile = (shader) => {
      if (overlay) shader.uniforms.uOverlay = { value: overlay };
      if (clouds > 0) shader.uniforms.uAeTime = timeUniform;

      /* ---- vertex ---- */
      let vHead = '#include <common>';
      let vBody = '#include <begin_vertex>';
      if (overlay) {
        vHead += '\nattribute vec2 uvOverlay;\nvarying vec2 vOverlayUv;';
        vBody += '\nvOverlayUv = uvOverlay;';
      }
      if (needWorld) {
        vHead += '\nvarying vec3 vAeWorld;';
        vBody += '\nvAeWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;';
      }
      if (overlay || needWorld) {
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', vHead)
          .replace('#include <begin_vertex>', vBody);
      }

      /* ---- fragment head ---- */
      let fHead = '#include <common>';
      if (overlay) fHead += '\nuniform sampler2D uOverlay;\nvarying vec2 vOverlayUv;';
      if (clouds > 0) fHead += '\nuniform float uAeTime;';
      if (needWorld) fHead += `\nvarying vec3 vAeWorld;\n${SITE_NOISE_GLSL}`;
      if (fHead !== '#include <common>') {
        shader.fragmentShader = shader.fragmentShader.replace('#include <common>', fHead);
      }

      /* ---- albedo stage ---- */
      let mapBody = '#include <map_fragment>';
      if (detile) {
        /*
         * Detail-tile decorrelation.
         *
         * The gravel verge shows its 1.5 m tile repeating in a line you can
         * count down the whole run - the classic single-scale tiling tell, and
         * no amount of macro tinting hides a repeat you can count. Sampling the
         * same albedo a second time at 7.3x scale rotated 31 degrees and
         * blending the two under a low-frequency world-space mask destroys the
         * period for the cost of one extra fetch.
         */
        mapBody = `
        #ifdef USE_MAP
        {
          vec2 aeUvB = mat2( 0.857, -0.515, 0.515, 0.857 ) * vMapUv * 7.3 + 3.17;
          float aeMix = smoothstep( 0.38, 0.62, aeNoise( vAeWorld.xz * 0.055 ) );
          diffuseColor *= mix( texture2D( map, vMapUv ), texture2D( map, aeUvB ), aeMix );
        }
        #endif`;
      }
      if (overlay) {
        mapBody +=
          '\nvec4 aetherOv = texture2D( uOverlay, vOverlayUv );' +
          '\ndiffuseColor.rgb = mix( diffuseColor.rgb, aetherOv.rgb, aetherOv.a );';
      }
      if (macro > 0) {
        /*
         * Three octaves at 240 / 90 / 34 m. None of them has a tile period, so
         * unlike the tiling albedo they do not collapse to one averaged colour
         * in the mip chain - which is precisely why the mid- and far-ground read
         * as flat paint without this. +/-17% value with a hue swing between a
         * cool damp green and a warm dry one, plus a separate ochre dry lobe.
         */
        mapBody += `
        {
          vec2 aeP = vAeWorld.xz;
          float aeN = aeNoise( aeP * 0.00417 ) * 0.44
                    + aeNoise( aeP * 0.01111 + 13.7 ) * 0.26
                    + aeNoise( aeP * 0.02941 + 5.13 ) * 0.18
                    + aeNoise( aeP * 0.07140 + 21.9 ) * 0.12;
          aeN = clamp( aeN, 0.0, 1.0 );
          vec3 aeTint = mix( vec3( ${F(macroCool[0])}, ${F(macroCool[1])}, ${F(macroCool[2])} ),
                             vec3( ${F(macroWarm[0])}, ${F(macroWarm[1])}, ${F(macroWarm[2])} ), aeN );
          diffuseColor.rgb *= mix( vec3( 1.0 ), aeTint, ${F(macro)} );
          float aeDry = smoothstep( 0.56, 0.86, aeN );
          diffuseColor.rgb = mix( diffuseColor.rgb,
            diffuseColor.rgb * vec3( 1.22, 1.10, 0.78 ), aeDry * ${F(dry)} );
        }`;
      }
      if (clouds > 0) {
        // ~230 m cloud cells drifting at ~3 m/s. Multiplied into albedo rather
        // than into the key: it is one instruction instead of a second shadow
        // pass, and on a site whose whole mid-band is one value it is the
        // cheapest large-scale composition available.
        mapBody += `
        {
          vec2 aeC = vAeWorld.xz * 0.00435 + uAeTime * vec2( 0.0131, 0.0062 );
          float aeCl = aeNoise( aeC ) * 0.66 + aeNoise( aeC * 2.3 + 7.31 ) * 0.34;
          diffuseColor.rgb *= mix( 1.0, mix( 0.71, 1.05, smoothstep( 0.33, 0.63, aeCl ) ), ${F(clouds)} );
        }`;
      }
      if (mapBody !== '#include <map_fragment>') {
        shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', mapBody);
      }

      if (polish) {
        // Wheel polish. Every transition in a bowl is ridden thousands of times
        // and ends up noticeably smoother and ~12% darker than the flat, which
        // is most of what tells a viewer which surfaces are skated. Injected
        // after <normal_fragment_maps> because `normal` does not exist yet at
        // <roughnessmap_fragment>.
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
          {
            float aeUp = clamp( transformDirectionByInverseViewMatrix( normal, viewMatrix ).y, 0.0, 1.0 );
            float aeFlat = smoothstep( 0.50, 0.94, aeUp );
            roughnessFactor = mix( 0.34, roughnessFactor, aeFlat );
            diffuseColor.rgb *= mix( 0.88, 1.0, aeFlat );
          }`
        );
      }

      if (specAA) {
        /*
         * Specular antialiasing (Toksvig / NDF filtering).
         *
         * Every thin galvanised element in this world - fence top rails, stand
         * bracing, floodlight masts, handrails - is 1-2 px wide past 40 m, and a
         * 0.92-metalness lobe on a sub-pixel cylinder produces highlight crawl
         * that MSAA cannot touch, because it is a shading-frequency problem
         * rather than a coverage problem. Widening roughness by the screen-space
         * variance of the shading normal is the standard fix and is what makes
         * the top rail stop breaking into a dashed white line.
         */
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
          {
            vec3 aeNdx = dFdx( normal );
            vec3 aeNdy = dFdy( normal );
            float aeVar = max( dot( aeNdx, aeNdx ), dot( aeNdy, aeNdy ) );
            roughnessFactor = min( 1.0, sqrt( roughnessFactor * roughnessFactor + 0.55 * aeVar ) );
          }`
        );
      }

      if (flattenFar > 0) {
        /*
         * Distance flatten.
         *
         * A tiling tangent-space normal map is a lie the moment its features
         * drop below a screen pixel: the mip chain averages the *texel* but
         * every fetch still perturbs the shading normal by a full-amplitude
         * random vector, so a 400 m lawn turns into per-pixel salt-and-pepper
         * that neither MSAA nor SMAA can touch (both work on coverage and on
         * edges, and this is neither). Lerping the perturbed normal back to the
         * interpolated geometric normal over `flattenFar` metres costs three
         * instructions and is the difference between a hillside reading as turf
         * and reading as television static. Note this only ever touches the
         * NORMAL - the macro albedo term above deliberately runs at full
         * strength to the horizon, because flat normals at distance are correct
         * and flat albedo never is.
         */
        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <normal_fragment_begin>',
            '#include <normal_fragment_begin>\n vec3 aeGeoNormal = normal;'
          )
          .replace(
            '#include <normal_fragment_maps>',
            `#include <normal_fragment_maps>
            {
              float aeFar = smoothstep( ${(flattenFar * 0.3).toFixed(1)}, ${flattenFar.toFixed(1)}, length( vViewPosition ) );
              normal = normalize( mix( normal, aeGeoNormal, aeFar ) );
            }`
          );
      }

      if (desat > 0) {
        /*
         * Aerial perspective is not only a fog blend.
         *
         * Blending toward a single haze colour keeps distant hills at full
         * chroma right up until the blend dominates, which is what produced a
         * vivid mid-ground and a washed far ridge with a hard step between
         * them. Losing saturation *before* the fog mix makes the ramp monotonic
         * across the whole 60-450 m band.
         */
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <fog_fragment>',
          `{
            float aeD = clamp( length( vViewPosition ) / 620.0, 0.0, 1.0 );
            float aeLum = dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
            gl_FragColor.rgb = mix( gl_FragColor.rgb, vec3( aeLum ), aeD * ${F(0.5 * desat)} );
          }
          #include <fog_fragment>`
        );
      }
    };

    const cacheKey =
      `aether-site|o${overlay ? 1 : 0}|p${polish ? 1 : 0}|f${flattenFar}` +
      `|m${macro}|d${dry}|c${clouds}|s${desat}|t${detile ? 1 : 0}|a${specAA ? 1 : 0}` +
      `|k${macroCool.join(',')}|w${macroWarm.join(',')}`;
    material.customProgramCacheKey = () => cacheKey;
    return material;
  }

  /**
   * Blend a single non-repeating "art pass" texture over a tiling material.
   * Large surfaces (100 m of concrete, 400 m of grass) read as wallpaper
   * without one, so this is where graffiti, wear paths and puddles live.
   * The mesh must carry a `uvOverlay` attribute in 0..1 across the surface.
   */
  _applyOverlay(material, overlayTex, opts = {}) {
    return this._siteShader(material, { ...opts, overlay: overlayTex });
  }

  /**
   * Fade a tiling normal map back to the geometric normal with distance.
   *
   * Any tangent-space detail whose features fall below a screen pixel stops
   * being detail and becomes a moire generator: at 100 m the running track's
   * 12 cm rubber grain was beating against the pixel grid and rendering the
   * whole oval as woven brickwork. Anisotropic filtering cannot help - it
   * filters the *fetch*, and the artefact is in the shading response to the
   * fetched vector.
   *
   * @param {THREE.Material} material must not already own `onBeforeCompile`.
   * @param {number} far metres at which the surface is fully flat.
   * @param {object} [extra] any further `_siteShader` options.
   */
  _flattenFar(material, far, extra = {}) {
    return this._siteShader(material, { ...extra, flattenFar: far });
  }

  /**
   * Cheap two-sided leaf transmission.
   *
   * Real canopies are the brightest thing in a backlit frame because sunlight
   * passes *through* the leaf. `MeshPhysicalMaterial.transmission` would do it
   * properly but costs a transmission render target per frame, which this world
   * cannot afford at 150 trees. Instead: a forward-scatter lobe keyed on the
   * view-vs-sun angle plus a wrap term that lets the shadow side of the canopy
   * pick up a fraction of the key. Both are added to indirect diffuse after the
   * standard lighting, so they never break energy conservation badly enough to
   * matter and they cost four instructions.
   */
  _wrapLight(material) {
    const sun = this.environment.sunDirection;
    // Scaled by sunIntensity / PI, not by the sun *colour* alone.
    //
    // This is the whole ballgame. three's directional light contributes
    // `lightColour * intensity * dot(N,L)` through BRDF_Lambert (which carries
    // the 1/PI), so a transmission term expressed in bare colour units is ~20x
    // too weak to be visible next to a key at intensity 6.9. Leaf cards have
    // radial normals decoupled from their winding, so roughly half of every
    // canopy shell has dot(N,L) <= 0 and gets nothing at all from the key -
    // with an under-scaled wrap term those cards rendered as hard black quads.
    const env = this.environment;
    const tint = env.sunColor.clone().multiplyScalar(env.sunIntensity / Math.PI);
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uSunDir = { value: sun };
      shader.uniforms.uSunTint = { value: tint };
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform vec3 uSunDir;\nuniform vec3 uSunTint;'
        )
        .replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
          {
            vec3 aeWN = transformDirectionByInverseViewMatrix( normal, viewMatrix );
            vec3 aeV  = transformDirectionByInverseViewMatrix( normalize( vViewPosition ), viewMatrix );
            // Backlit: the sun sits behind the leaf from the camera's side.
            float aeBack = clamp( dot( -aeV, uSunDir ), 0.0, 1.0 );
            float aeNL   = dot( aeWN, uSunDir );
            // Transmission proper: a leaf card whose normal points AWAY from the
            // sun is exactly the card the sun is shining through. Without this
            // term the far half of every canopy shell renders near-black, since
            // the ambient and hemi fills are deliberately starved to 0.04/0.15
            // to keep the key readable.
            float aeTrans = clamp( -aeNL, 0.0, 1.0 );
            float aeWrap  = clamp( aeNL * 0.5 + 0.5, 0.0, 1.0 );
            // A fully sun-facing-away card lands at ~0.9x diffuse, which is
            // roughly two thirds of what the same card gets when front-lit -
            // about right for a leaf. The aeBack lobe is the backlit glow on
            // top of that.
            reflectedLight.indirectDiffuse += diffuseColor.rgb * uSunTint *
              ( pow( aeBack, 3.0 ) * 0.55 + aeTrans * 0.34 + aeWrap * 0.14 + 0.11 );
          }`
        );
    };
    material.customProgramCacheKey = () => 'aether-sports-wrap';
    return material;
  }

  /**
   * A shell of alpha-tested leaf cards around a canopy lobe.
   *
   * `count` quads are scattered on a sphere of `radius`, each drawing one of the
   * four clusters in the leaf atlas, each rotated arbitrarily. Normals are
   * overridden to the outward radial direction rather than the quad's own facet
   * normal: individually-shaded quads read as a pile of flapping cards, radial
   * normals read as one soft leafy mass while the alpha cut does the silhouette
   * work. Vertex colour carries the same vertical occlusion ramp the blobs use,
   * so the underside of a canopy is already in shade before any light lands.
   */
  /** One quad UV-mapped onto a random cell of the 2x2 leaf-cluster atlas. */
  _cardQuad(w, h, rng) {
    const g = new THREE.PlaneGeometry(w, h, 1, 1);
    const uv = g.getAttribute('uv');
    const cell = (rng() * 4) | 0;
    const ox = (cell & 1) * 0.5;
    const oy = (cell >> 1) * 0.5;
    for (let k = 0; k < uv.count; k++) {
      uv.setXY(k, ox + uv.getX(k) * 0.5, oy + uv.getY(k) * 0.5);
    }
    return g;
  }

  /**
   * Merge card quads and give them radial normals + a vertical occlusion ramp.
   * `centre` is the pivot the normals radiate from (the lobe centre for a
   * broadleaf, a point on the trunk axis for a conifer whorl).
   */
  _finishCards(geos, centre) {
    const geo = mergeGeometries(geos);
    for (const g of geos) g.dispose();
    const pos = geo.getAttribute('position');
    const src = geo.getAttribute('normal');
    const nrm = new Float32Array(pos.count * 3);
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) - centre[0];
      const y = pos.getY(i) - centre[1];
      const z = pos.getZ(i) - centre[2];
      const len = Math.hypot(x, y, z) || 1;
      /*
       * Dome-biased normals.
       *
       * A card's own facet normal is decoupled from its winding, so with
       * `side: DoubleSide` roughly half of a porous canopy shell ends up with
       * `dot(N, sunDir) < 0` - and with the fill deliberately starved to keep
       * the key readable, that half rendered as hard black quads.
       *
       * Weighting the radial direction at 0.45 against a fixed +Y at 0.86 caps
       * the horizontal component at ~0.43, which with this world's 16.5-degree
       * sun keeps `dot(N, L)` above about -0.19 in the very worst orientation -
       * comfortably inside what the transmission term below can carry - while
       * still giving the canopy a 4-5:1 lit-to-shaded range so it reads as a
       * mass rather than as a flat decal.
       */
      const rx = x / len;
      const ry = y / len;
      const rz = z / len;
      // A little of the quad's own facing, sign-matched to the radial direction,
      // so the shell is not one uniform dome shade.
      let gx = src.getX(i);
      let gy = src.getY(i);
      let gz = src.getZ(i);
      if (gx * rx + gy * ry + gz * rz < 0) { gx = -gx; gy = -gy; gz = -gz; }
      let nx = rx * 0.45 + gx * 0.12;
      let ny = ry * 0.45 + gy * 0.12 + 0.86;
      let nz = rz * 0.45 + gz * 0.12;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nrm[i * 3] = nx / nl;
      nrm[i * 3 + 1] = ny / nl;
      nrm[i * 3 + 2] = nz / nl;
      const ao = 0.50 + 0.50 * clamp01((y / len) * 0.5 + 0.64);
      col[i * 3] = ao;
      col[i * 3 + 1] = ao;
      col[i * 3 + 2] = ao * 0.97;
    }
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return geo;
  }

  _leafCards(radius, seed, count) {
    const rng = makeRng(seed);
    const geos = [];
    for (let i = 0; i < count; i++) {
      // 0.5-0.95 of the lobe radius. At the previous 0.92-1.72 a single card on
      // the oak's main lobe was over five metres across - bigger than the whole
      // canopy it was supposed to be breaking up.
      const size = radius * (0.50 + rng() * 0.45);
      const g = this._cardQuad(size, size, rng);
      // Uniform direction on the sphere, pushed out toward the lobe surface so
      // the cards break the arc rather than sitting inside it.
      const th = rng() * Math.PI * 2;
      const ph = Math.acos(1 - 2 * rng());
      const sp = Math.sin(ph);
      const d = radius * (0.52 + rng() * 0.5);
      xform(
        g,
        sp * Math.cos(th) * d,
        Math.cos(ph) * d * 0.86,
        sp * Math.sin(th) * d,
        (rng() - 0.5) * 2.4,
        rng() * Math.PI * 2,
        (rng() - 0.5) * 2.4
      );
      geos.push(g);
    }
    return this._finishCards(geos, [0, 0, 0]);
  }

  /**
   * Drooping branch cards arranged in whorls up a conifer.
   *
   * A ConeGeometry silhouette is a perfect triangle - the single most obvious
   * "primitive" read in a treeline. Six whorls of tangential, downward-tilted
   * cards give the profile the stepped, ragged edge a spruce actually has.
   */
  _coniferCards(seed) {
    const rng = makeRng(seed);
    const geos = [];
    const whorls = [
      [2.7, 3.1, 18], [2.35, 4.3, 16], [1.95, 5.4, 14],
      [1.5, 6.5, 12], [1.1, 7.6, 9], [0.7, 8.6, 6],
    ];
    for (const [rad, hy, n] of whorls) {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rng() * 0.8;
        const g = this._cardQuad(rad * 0.95, rad * 0.68, rng);
        xform(
          g,
          Math.cos(a) * rad * 0.72,
          hy + (rng() - 0.5) * 0.5,
          Math.sin(a) * rad * 0.72,
          -0.45 + rng() * 0.35, // droop
          -a + Math.PI / 2,
          (rng() - 0.5) * 0.5
        );
        geos.push(g);
      }
    }
    return this._finishCards(geos, [0, 5.2, 0]);
  }

  /** Add a mesh to the world with sensible shadow defaults. */
  _add(mesh, cast = true, receive = true) {
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    this.group.add(mesh);
    return mesh;
  }

  /** Add a mesh and register its oriented bounding box as a collider. */
  _solid(mesh, opts = {}) {
    this._add(mesh, opts.castShadow ?? true, opts.receiveShadow ?? true);
    this.track(this.physics.addBoxFromObject(mesh, { userData: opts.userData }));
    return mesh;
  }

  _box(w, h, d, mat, x, y, z, ry = 0) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.rotation.y = ry;
    return m;
  }

  /**
   * Tessellate a height function into a renderable mesh. `uvScale` is in
   * texture repeats per metre; `uvOverlay` spans 0..1 across the patch.
   *
   * `holes` are world-space [x0,z0,x1,z1] rects. A quad is dropped only when it
   * lies *entirely* inside a hole, so the lawn always tucks a cell or two under
   * the slab that replaces it and no daylight can show through the seam. This
   * is what lets the skate bowl and the pool basin exist at all: both cut below
   * the lawn plane, and an unbroken ground sheet would simply draw over them.
   */
  _heightMesh(
    fn, x0, z0, x1, z1, res, material, uvScale, colorFn = null, holes = null, arcUV = false
  ) {
    const nx = Math.max(1, Math.round((x1 - x0) / res));
    const nz = Math.max(1, Math.round((z1 - z0) / res));
    const vw = nx + 1;
    const vh = nz + 1;
    const pos = new Float32Array(vw * vh * 3);
    const uv = new Float32Array(vw * vh * 2);
    const ov = new Float32Array(vw * vh * 2);
    const col = colorFn ? new Float32Array(vw * vh * 3) : null;
    const rgb = [1, 1, 1];
    for (let j = 0; j < vh; j++) {
      for (let i = 0; i < vw; i++) {
        const fx = i / nx;
        const fz = j / nz;
        const x = x0 + fx * (x1 - x0);
        const z = z0 + fz * (z1 - z0);
        const k = j * vw + i;
        const y = fn(x, z);
        pos[k * 3] = x;
        pos[k * 3 + 1] = y;
        pos[k * 3 + 2] = z;
        uv[k * 2] = (x - x0) * uvScale;
        uv[k * 2 + 1] = (z - z0) * uvScale;
        ov[k * 2] = fx;
        ov[k * 2 + 1] = fz;
        if (col) {
          colorFn(x, z, y, rgb);
          col[k * 3] = rgb[0];
          col[k * 3 + 1] = rgb[1];
          col[k * 3 + 2] = rgb[2];
        }
      }
    }

    /*
     * Arc-length parameterisation.
     *
     * The planar UV above is metres-of-*plan*, not metres-of-*surface*. On a
     * 50-degree bowl transition or a 30-degree hillside that compresses the
     * texture by 1/cos(theta) in one axis only - which is exactly the vertical
     * streaking that reads as an over-driven normal map, and exactly the
     * squashed mowing bands running up the far hills. Accumulating true 3D
     * distance along each row and column costs one extra pass at build time and
     * removes both artifacts without a triplanar shader.
     */
    if (arcUV) {
      const uArc = new Float32Array(vw * vh);
      const vArc = new Float32Array(vw * vh);
      const rowTotal = new Float32Array(vh);
      const colTotal = new Float32Array(vw);
      for (let j = 0; j < vh; j++) {
        let acc = 0;
        for (let i = 1; i < vw; i++) {
          const a = (j * vw + i - 1) * 3;
          const b = (j * vw + i) * 3;
          const dx = pos[b] - pos[a];
          const dy = pos[b + 1] - pos[a + 1];
          const dz = pos[b + 2] - pos[a + 2];
          acc += Math.sqrt(dx * dx + dy * dy + dz * dz);
          uArc[j * vw + i] = acc;
        }
        rowTotal[j] = acc || 1;
      }
      for (let i = 0; i < vw; i++) {
        let acc = 0;
        for (let j = 1; j < vh; j++) {
          const a = ((j - 1) * vw + i) * 3;
          const b = (j * vw + i) * 3;
          const dx = pos[b] - pos[a];
          const dy = pos[b + 1] - pos[a + 1];
          const dz = pos[b + 2] - pos[a + 2];
          acc += Math.sqrt(dx * dx + dy * dy + dz * dz);
          vArc[j * vw + i] = acc;
        }
        colTotal[i] = acc || 1;
      }
      for (let j = 0; j < vh; j++) {
        for (let i = 0; i < vw; i++) {
          const k = j * vw + i;
          uv[k * 2] = uArc[k] * uvScale;
          uv[k * 2 + 1] = vArc[k] * uvScale;
          ov[k * 2] = uArc[k] / rowTotal[j];
          ov[k * 2 + 1] = vArc[k] / colTotal[i];
        }
      }
    }
    const idx = new Uint32Array(nx * nz * 6);
    let p = 0;
    const dx = (x1 - x0) / nx;
    const dz = (z1 - z0) / nz;
    for (let j = 0; j < nz; j++) {
      const za = z0 + j * dz;
      const zb = za + dz;
      for (let i = 0; i < nx; i++) {
        if (holes) {
          const xa = x0 + i * dx;
          const xb = xa + dx;
          let inside = false;
          for (let h = 0; h < holes.length; h++) {
            const r = holes[h];
            if (xa >= r[0] && xb <= r[2] && za >= r[1] && zb <= r[3]) { inside = true; break; }
          }
          if (inside) continue;
        }
        const a = j * vw + i;
        const b = a + 1;
        const c = a + vw;
        const d = c + 1;
        idx[p++] = a;
        idx[p++] = c;
        idx[p++] = d;
        idx[p++] = a;
        idx[p++] = d;
        idx[p++] = b;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('uvOverlay', new THREE.BufferAttribute(ov, 2));
    if (col) geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(p === idx.length ? idx : idx.subarray(0, p), 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, material);
    return mesh;
  }

  /**
   * Bake a height function into many small triangle-soup colliders.
   *
   * Physics tests every triangle of a collider it broadphases, so the chunk
   * size - not the triangle count - is what keeps this cheap. ~5 m chunks mean
   * a capsule only ever considers a few hundred triangles per iteration.
   */
  _addHeightCollision(fn, x0, z0, x1, z1, res, chunkSize) {
    const per = Math.max(1, Math.round(chunkSize / res));
    const nx = Math.ceil((x1 - x0) / res);
    const nz = Math.ceil((z1 - z0) / res);
    const cx = Math.ceil(nx / per);
    const cz = Math.ceil(nz / per);
    for (let a = 0; a < cx; a++) {
      for (let b = 0; b < cz; b++) {
        const i0 = a * per;
        const i1 = Math.min(nx, i0 + per);
        const j0 = b * per;
        const j1 = Math.min(nz, j0 + per);
        const w = i1 - i0;
        const d = j1 - j0;
        if (w <= 0 || d <= 0) continue;
        const positions = new Float32Array(w * d * 18);
        let p = 0;
        for (let j = j0; j < j1; j++) {
          const za = z0 + j * res;
          const zb = Math.min(z1, za + res);
          for (let i = i0; i < i1; i++) {
            const xa = x0 + i * res;
            const xb = Math.min(x1, xa + res);
            const y00 = fn(xa, za);
            const y10 = fn(xb, za);
            const y01 = fn(xa, zb);
            const y11 = fn(xb, zb);
            positions[p++] = xa; positions[p++] = y00; positions[p++] = za;
            positions[p++] = xa; positions[p++] = y01; positions[p++] = zb;
            positions[p++] = xb; positions[p++] = y11; positions[p++] = zb;
            positions[p++] = xa; positions[p++] = y00; positions[p++] = za;
            positions[p++] = xb; positions[p++] = y11; positions[p++] = zb;
            positions[p++] = xb; positions[p++] = y10; positions[p++] = za;
          }
        }
        this.track(
          this.physics.add(new Collider('mesh', { positions, layer: COLLISION_LAYER.WORLD }))
        );
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Per-frame animation                                               */
  /* ---------------------------------------------------------------- */

  /**
   * Animated world elements only: pool surface, the chairlift, lane ropes and
   * banner sway. No allocation - everything reuses module scratch.
   */
  update(dt, elapsed) {
    if (this._water) this._water.material.uniforms.uTime.value = elapsed;
    // Drives the cloud-shadow drift shared by every ground surface.
    this._shaderTime.value = elapsed;

    if (this._chairs && this._chairPath) {
      const path = this._chairPath;
      const n = this._chairCount;
      const speed = 0.021;
      for (let i = 0; i < n; i++) {
        let t = ((elapsed * speed + i / n) % 1 + 1) % 1;
        // Out on the near cable, back on the far one.
        const outbound = t < 0.5;
        const s = outbound ? t * 2 : (1 - t) * 2;
        const lateral = outbound ? -1.5 : 1.5;
        path.sample(s, _v1);
        const sway = Math.sin(elapsed * 1.7 + i * 1.3) * 0.06;
        _e1.set(sway, 0, Math.sin(elapsed * 1.1 + i * 0.7) * 0.05);
        _q1.setFromEuler(_e1);
        _s1.set(1, 1, 1);
        _v2.set(_v1.x + lateral, _v1.y - 2.15, _v1.z);
        _m1.compose(_v2, _q1, _s1);
        this._chairs.setMatrixAt(i, _m1);
      }
      this._chairs.instanceMatrix.needsUpdate = true;
    }

    for (let i = 0; i < this._banners.length; i++) {
      const b = this._banners[i];
      b.rotation.z = Math.sin(elapsed * 1.3 + b.userData.phase) * 0.045;
      b.scale.x = 1 + Math.sin(elapsed * 2.1 + b.userData.phase) * 0.02;
    }

  }

  /* ---------------------------------------------------------------- */
  /* Sun and shadow rig                                                */
  /* ---------------------------------------------------------------- */

  /**
   * Take over the engine's directional light while this world is on screen.
   *
   * The shared rig in main.js anchors the shadow frustum to the *player* with a
   * 60 m half-extent. Any establishing or detached camera therefore looks at
   * geometry that is nowhere near the ortho box, and nothing in frame casts a
   * shadow at all. We register a frame updater *after* that one - engine frame
   * updaters run in insertion order and main.js registers at module scope, so
   * this always gets the last word - and refit the box to the active camera.
   */
  _installSunRig() {
    // By name, not by "first shadow-casting directional": the scene also holds
    // the light rig's spare shadow slot (gfx/LightRig.js), and grabbing that one
    // would drive a light this world does not own. Falls back to the old search
    // so a rig-less scene still works.
    let sun = this.scene.getObjectByName('sun');
    if (!sun?.isDirectionalLight) {
      sun = null;
      this.scene.traverse((o) => {
        if (!sun && o.isDirectionalLight && o.castShadow && !o.userData.__rigSlot) sun = o;
      });
    }
    this._sun = sun;

    const d = this.environment.sunDirection;
    this._sunBasis.setFromUnitVectors(UNIT_Z, d);
    this._sunBasisInv.copy(this._sunBasis).invert();

    if (sun) {
      this._sunRestore = {
        size: sun.shadow.mapSize.x,
        bias: sun.shadow.bias,
        normalBias: sun.shadow.normalBias,
        intensity: sun.intensity,
      };
      // normalBias 0.02, not 0.07.
      //
      // normalBias offsets the *lookup* along the surface normal in world
      // metres, so at 0.07 every contact shadow was being pushed 7 cm off the
      // geometry that cast it - which is exactly the peter-panning visible
      // under the bleacher, and why nothing in the frame had a junction with
      // the ground. The near cascade is now ~3 cm/texel, so 2 cm is enough to
      // suppress acne and the depth bias picks up the rest.
      sun.shadow.bias = -0.0006;
      sun.shadow.normalBias = 0.02;
      sun.shadow.blurSamples = 12;
    }

    // Cascade 1: fixed box over the whole site, rendered once. See the note on
    // `_farShadowRange` in the constructor.
    const farRadius = this._farShadowRange;
    const far = new THREE.DirectionalLight(
      this.environment.sunColor,
      this.environment.sunIntensity * (1 - this._keySplitNear)
    );
    far.castShadow = true;
    far.position.copy(d).multiplyScalar(farRadius + 240);
    far.target.position.set(0, 0, 0);
    far.shadow.mapSize.set(this._farShadowMapSize, this._farShadowMapSize);
    far.shadow.bias = -0.0011;
    far.shadow.normalBias = 0.12;
    far.shadow.blurSamples = 8;
    {
      const sc = far.shadow.camera;
      sc.left = -farRadius;
      sc.right = farRadius;
      sc.top = farRadius;
      sc.bottom = -farRadius;
      sc.near = 1;
      // The ski mound tops out at 52 m and the sun rakes at 16.5 deg, so the
      // depth range has to reach a long way behind the box to catch it.
      sc.far = farRadius * 2 + 480;
      sc.updateProjectionMatrix();
    }
    far.shadow.autoUpdate = false;
    far.shadow.needsUpdate = true;
    this._farSun = far;
    this.group.add(far.target);
    this.group.add(far);

    // Three-light rig. Both of these are parked 4 km out so their direction is
    // effectively constant across the whole 400 m site - no per-frame re-aim,
    // no allocation, and the terminator never swings as the player walks.
    const az = Math.atan2(d.z, d.x);
    const place = (light, azimuth, elevationDeg, dist = 4000) => {
      const ce = Math.cos(elevationDeg * DEG);
      light.position.set(
        Math.cos(azimuth) * ce * dist,
        Math.sin(elevationDeg * DEG) * dist,
        Math.sin(azimuth) * ce * dist
      );
      light.castShadow = false;
      this.group.add(light.target);
      this.group.add(light);
    };

    // Bounce: directly opposite the sun at *negative* elevation, so it reads as
    // light coming back up off the ground rather than as a second key. At 0.42
    // and +140 m it was doing exactly that and cancelling the terminator.
    const bounce = new THREE.DirectionalLight(0x9fc4e8, 0.12);
    place(bounce, az + Math.PI, -25);

    // Rim: warm, 160 deg round in azimuth from the key at a shallow +8 deg, so
    // vertical silhouettes - masts, fence posts, tree trunks, the bowl coping -
    // separate from whatever is behind them.
    const rim = new THREE.DirectionalLight(0xffe8c4, 0.5);
    place(rim, az + 160 * DEG, 8);

    this._detachSunRig = this.engine.onFrameUpdate(() => this._updateSunRig());
  }

  /**
   * Resize the shared shadow map only while this world is on screen, and hand
   * it back untouched on the way out - the other two worlds should not pay for
   * a 4k map they never asked for.
   */
  _setShadowMapSize(size) {
    const sun = this._sun;
    if (!sun || sun.shadow.mapSize.x === size) return;
    sun.shadow.mapSize.set(size, size);
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
  }

  onActivate() {
    super.onActivate();
    this._setShadowMapSize(this._shadowMapSize);
    this._farShadowDirty = true;
  }

  onDeactivate() {
    super.onDeactivate();
    // Hand the scene fog back; WorldManager's applyEnvironment will re-author a
    // linear one for whichever world comes next.
    if (this.scene.fog === this._fog) this.scene.fog = null;
    if (this._sunRestore) {
      this._setShadowMapSize(this._sunRestore.size);
      if (this._sun) {
        this._sun.shadow.bias = this._sunRestore.bias;
        this._sun.shadow.normalBias = this._sunRestore.normalBias;
        this._sun.intensity = this._sunRestore.intensity;
      }
    }
  }

  /** Refit the shadow ortho to the camera frustum. Zero allocation. */
  _updateSunRig() {
    if (!this.active) return;
    // main.js re-authors a linear THREE.Fog on every world:changed and its
    // handler runs before ours, so claim the scene fog back here rather than
    // fighting over listener order. One identity compare per frame.
    if (this.scene.fog !== this._fog) this.scene.fog = this._fog;
    const sun = this._sun;
    if (!sun) return;
    // main.js re-applies environment.sunIntensity on world:changed, so the
    // cascade split has to be re-asserted here rather than set once. One
    // compare per frame.
    const nearKey = this.environment.sunIntensity * this._keySplitNear;
    if (sun.intensity !== nearKey) sun.intensity = nearKey;
    if (this._farShadowDirty && this._farSun) {
      // The world's group is hidden while it builds, and a shadow map rendered
      // then would contain nothing. Re-arm on the first frame we are actually
      // on screen; after that the box is static and so is the map.
      this._farSun.shadow.needsUpdate = true;
      this._farShadowDirty = false;
    }
    const cam = this.engine.camera;
    const d = this.environment.sunDirection;

    const far = Math.min(this._shadowRange, cam.far);
    const near = cam.near;
    const tan = Math.tan(cam.fov * 0.5 * DEG);
    _v1.set(0, 0, -1).applyQuaternion(cam.quaternion);
    _v2.set(1, 0, 0).applyQuaternion(cam.quaternion);
    _v3.set(0, 1, 0).applyQuaternion(cam.quaternion);
    let k = 0;
    for (let di = 0; di < 2; di++) {
      const dist = di === 0 ? near : far;
      const hh = tan * dist;
      const hw = hh * cam.aspect;
      for (let ci = 0; ci < 4; ci++) {
        _corners[k++]
          .copy(cam.position)
          .addScaledVector(_v1, dist)
          .addScaledVector(_v2, (ci & 1 ? 1 : -1) * hw)
          .addScaledVector(_v3, (ci & 2 ? 1 : -1) * hh);
      }
    }

    // Sphere fit rather than an AABB fit: it is rotation invariant, so the box
    // never resizes as the player turns and shadow edges do not crawl.
    _v4.set(0, 0, 0);
    for (let i = 0; i < 8; i++) _v4.add(_corners[i]);
    _v4.multiplyScalar(0.125);
    let radius = 0;
    for (let i = 0; i < 8; i++) {
      const dd = _v4.distanceTo(_corners[i]);
      if (dd > radius) radius = dd;
    }
    radius = Math.max(24, Math.ceil(radius));

    // Snap the centre to the shadow texel grid in light space, or the whole map
    // shimmers by a texel every time the camera moves a centimetre.
    const texel = (radius * 2) / this._shadowMapSize;
    _v4.applyQuaternion(this._sunBasisInv);
    _v4.x = Math.round(_v4.x / texel) * texel;
    _v4.y = Math.round(_v4.y / texel) * texel;
    _v4.applyQuaternion(this._sunBasis);

    sun.position.copy(_v4).addScaledVector(d, radius + 140);
    sun.target.position.copy(_v4);
    sun.target.updateMatrixWorld();

    const sc = sun.shadow.camera;
    sc.left = -radius;
    sc.right = radius;
    sc.top = radius;
    sc.bottom = -radius;
    sc.near = 1;
    sc.far = radius * 2 + 280;
    sc.updateProjectionMatrix();
  }

  dispose() {
    this._detachSunRig?.();
    this._detachSunRig = null;
    this._sun = null;
    this._farSun?.shadow.map?.dispose();
    this._farSun?.dispose?.();
    this._farSun = null;
    for (const t of this._textures.values()) t.dispose();
    this._textures.clear();
    for (const m of this._materials.values()) m.dispose();
    this._materials.clear();
    this._envRT?.dispose();
    this._envRT = null;
    this._water = null;
    this._chairs = null;
    this._banners.length = 0;
    super.dispose();
  }

  /* ---------------------------------------------------------------- */
  /* Procedural material library                                       */
  /* ---------------------------------------------------------------- */

  /** Assemble a standard PBR material from albedo / height / roughness canvases. */
  _pbr(key, albedo, height, rough, opts = {}) {
    const repeat = opts.repeat ?? 1;
    const repeatY = opts.repeatY ?? repeat;
    const map = this._tex(albedo, { srgb: true, repeat, repeatY, key: `${key}.map` });
    const mat = new THREE.MeshStandardMaterial({
      map,
      roughness: opts.roughness ?? 1,
      metalness: opts.metalness ?? 0,
      color: opts.color ?? 0xffffff,
      side: opts.side ?? THREE.FrontSide,
    });
    if (height) {
      const nrm = this._registerTex(`${key}.normal`, normalFromHeight(height, opts.bump ?? 2.2));
      nrm.repeat.set(repeat, repeatY);
      mat.normalMap = nrm;
      mat.normalScale = new THREE.Vector2(opts.normalScale ?? 1, opts.normalScale ?? 1);
    }
    if (rough) {
      const rt = this._tex(rough, { srgb: false, repeat, repeatY, key: `${key}.rough` });
      mat.roughnessMap = rt;
    }
    if (opts.clamp) {
      map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
      if (mat.normalMap) mat.normalMap.wrapS = mat.normalMap.wrapT = THREE.ClampToEdgeWrapping;
      if (mat.roughnessMap)
        mat.roughnessMap.wrapS = mat.roughnessMap.wrapT = THREE.ClampToEdgeWrapping;
    }
    mat.envMapIntensity = opts.envMapIntensity ?? 1;
    return this._mat(key, mat);
  }

  /**
   * Painted and anodised metals - railings, frames, goalposts, plant.
   *
   * These were flat colours, deliberately: painted steel has no pattern and no
   * grain, so an albedo map would have been inventing detail that is not there.
   * That reasoning is right about the albedo and wrong about the rest. A real
   * painted rail carries orange peel, drag marks from the gun and the odd
   * scratch, and every one of those lives in the *highlight* - so without them
   * a rail returns one uniform specular blob and reads as plastic. It was 131
   * meshes and 287k triangles of the stuff in this world.
   *
   * `paint.enamel` supplies exactly that and nothing else: its albedo is
   * near-white, so the colour asked for here still decides the colour, and its
   * roughness and metalness are written near 1 so the scalars below still
   * decide the finish - just with a few percent of variation across the
   * surface rather than none.
   *
   * Falls back to the old flat material if the library has not got the surface,
   * because a world that fails to build is worse than one that looks flat.
   */
  _metal(key, color, roughness, metalness = 1, extra = {}) {
    let mat = null;
    try {
      const base = this.materials?.get?.('paint.enamel');
      if (base) {
        mat = base.clone();
        mat.color = new THREE.Color(color);
        mat.roughness = roughness;
        mat.metalness = metalness;
        mat.envMapIntensity = 1.15;
        Object.assign(mat, extra);
      }
    } catch { mat = null; }
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({
        color, roughness, metalness, envMapIntensity: 1.15, ...extra,
      });
    }
    return this._mat(key, mat);
  }

  async _buildTextures() {
    /* ---------------- skate concrete ---------------- */
    // 8 m tile: expansion joints land on a 2 m grid, which is what a real slab
    // pour looks like and gives the eye a scale reference inside the bowl.
    const cA = makeCanvas(512, 512);
    paintPixels(cA, (u, v, out) => {
      const grain = fbm(u, v, 24, 4, 3);
      const blotch = fbm(u, v, 4, 3, 11);
      // Base lifted from 128 to 146: the vertex AO and the raking key both
      // multiply into this, and at 128 the pad bottomed out before either had
      // anything left to say.
      let l = 146 + (grain - 0.5) * 24 + (blotch - 0.5) * 26;
      // Pour panels: an 8 m-ish patchwork offset from the saw-cut grid, so the
      // slab reads as poured in bays rather than as one continuous casting.
      l *= 0.96 + fbm(u + 0.31, v + 0.17, 3, 1, 47) * 0.085;
      // Troweled arcs: broad low-frequency swirl in the surface paste.
      l += Math.sin(u * 11.0 + blotch * 9) * 4.5;
      out[0] = l * 1.005;
      out[1] = l;
      out[2] = l * 1.03;
    });
    const ca = cA.getContext('2d');
    ca.globalAlpha = 1;
    // Expansion joints on a 4 m module (the tile is 8 m of world). A 1 m grid -
    // which is what the old repeat-2 tiling produced - reads as tiling, not as
    // a saw-cut pattern.
    // Softer than a black line. With the pad now carrying arc-length UVs the
    // joint grid drifts slightly row to row across 100 m of slab, so it reads as
    // settlement cracking rather than as a saw-cut grid - which is welcome
    // construction history, but only at a plausible value.
    ca.strokeStyle = 'rgba(78,78,82,0.5)';
    ca.lineWidth = 3;
    for (let i = 0; i <= 2; i++) {
      const p = (i / 2) * 512;
      ca.beginPath(); ca.moveTo(p, 0); ca.lineTo(p, 512); ca.stroke();
      ca.beginPath(); ca.moveTo(0, p); ca.lineTo(512, p); ca.stroke();
    }
    ca.strokeStyle = 'rgba(196,196,202,0.32)';
    ca.lineWidth = 1.5;
    for (let i = 0; i <= 2; i++) {
      const p = (i / 2) * 512 + 3;
      ca.beginPath(); ca.moveTo(p, 0); ca.lineTo(p, 512); ca.stroke();
      ca.beginPath(); ca.moveTo(0, p); ca.lineTo(512, p); ca.stroke();
    }
    // Stain blobs at 2-6 m: rain shadow, oil, algae in the shaded corners.
    {
      const sr = makeRng(313);
      for (let i = 0; i < 7; i++) {
        const x = sr() * 512;
        const y = sr() * 512;
        const r = 60 + sr() * 130;
        const g = ca.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(58,58,54,${0.10 + sr() * 0.10})`);
        g.addColorStop(1, 'rgba(58,58,54,0)');
        ca.fillStyle = g;
        ca.beginPath(); ca.arc(x, y, r, 0, Math.PI * 2); ca.fill();
      }
    }
    // Truck scuffs and slide marks.
    // The tile is 8 m of world, so a 60 px stroke is a 1 m skid. Shorter,
    // fainter and denser than before - at repeat 1 the old marks scaled up into
    // metre-long black gouges that read as cracked concrete.
    const rngC = makeRng(7);
    for (let i = 0; i < 150; i++) {
      ca.strokeStyle = `rgba(${28 + rngC() * 40},${26 + rngC() * 36},${30 + rngC() * 40},${0.06 + rngC() * 0.11})`;
      ca.lineWidth = 1 + rngC() * 2;
      ca.beginPath();
      const x = rngC() * 512;
      const y = rngC() * 512;
      const a = rngC() * Math.PI;
      const l = 6 + rngC() * 26;
      ca.moveTo(x, y);
      ca.quadraticCurveTo(x + Math.cos(a) * l * 0.5 + 6, y + Math.sin(a) * l * 0.5 - 6, x + Math.cos(a) * l, y + Math.sin(a) * l);
      ca.stroke();
    }
    await this._breathe();
    const cH = makeCanvas(512, 512);
    paintPixels(cH, (u, v, out) => {
      const g = fbm(u, v, 48, 4, 3) * 190 + fbm(u, v, 8, 2, 5) * 60;
      out[0] = out[1] = out[2] = g;
    });
    const ch = cH.getContext('2d');
    ch.strokeStyle = 'rgba(64,64,64,1)';
    ch.lineWidth = 3;
    for (let i = 0; i <= 2; i++) {
      const p = (i / 2) * 512;
      ch.beginPath(); ch.moveTo(p, 0); ch.lineTo(p, 512); ch.stroke();
      ch.beginPath(); ch.moveTo(0, p); ch.lineTo(512, p); ch.stroke();
    }
    const cR = makeCanvas(256, 256);
    paintPixels(cR, (u, v, out) => {
      // Wheel-polished lanes against dull float finish. Driven off the same
      // low-frequency field as the albedo blotching so the sheen tracks the
      // colour variation instead of floating independently of it.
      const g = 178 + (fbm(u, v, 6, 3, 13) - 0.5) * 150 + (fbm(u, v, 32, 2, 19) - 0.5) * 44;
      out[0] = out[1] = out[2] = clamp(g, 92, 240);
    });
    // The pad mesh's UVs are metres/8, so `repeat` counts tiles per 8 m. 1 puts
    // the saw-cut grid on a 4 m module (the canvas draws two joints per tile),
    // which is a real slab bay rather than the 1 m checker the old repeat-2
    // produced.
    this._pbr('concrete.pad', cA, cH, cR, {
      repeat: 1,
      repeatY: 1,
      // normalScale/bump are deliberately low. The pad's UVs run along the
      // surface (see `_heightMesh(..., arcUV)`), but any residual stretch on the
      // 50-degree bowl transitions is amplified by a strong height field - which
      // is exactly what produced the vertical streaking down the walls.
      roughness: 0.94,
      normalScale: 0.62,
      bump: 0.9,
      envMapIntensity: 0.4,
    });
    // Detail normal at 4x the albedo rate: the fine aggregate the low-frequency
    // normal can no longer carry, at a frequency that never stretches visibly.
    this._materials.get('concrete.pad').normalMap.repeat.set(4, 4);
    // Concavity AO is baked into the pad mesh's vertex colours.
    this._materials.get('concrete.pad').vertexColors = true;

    /* ---------------- pad art pass (graffiti + wear) ---------------- */
    // 2048x1536 over the 100x75 m pad is ~20 px/m, three times the old density.
    // Tags are authored at 2-4.5 m so they read as tags rather than as 8 m
    // scribbles, on a two-accent script (warm orange / cool teal) plus outline.
    const OW = 2048;
    const OH = 1536;
    await this._breathe();
    const ov = makeCanvas(OW, OH);
    const oc = ov.getContext('2d');
    oc.clearRect(0, 0, OW, OH);
    const tagRng = makeRng(4242);
    const tagHues = [24, 32, 186, 194, 14];
    const tagSpots = [];
    // Cluster tags onto the bowl lip, the half-pipe flat and the west wall.
    for (const [cx, cy, spread, count] of [
      [700, 780, 210, 7], [880, 700, 170, 5], [1590, 330, 190, 5],
      [1600, 800, 160, 4], [1280, 1240, 200, 5], [260, 1400, 150, 3],
    ]) {
      for (let i = 0; i < count; i++) {
        tagSpots.push([
          cx + (tagRng() - 0.5) * spread * 2,
          cy + (tagRng() - 0.5) * spread,
          45 + tagRng() * 45,
          (tagRng() - 0.5) * 2,
        ]);
      }
    }
    // Hard-edged marker art rather than soft gradients: a flat fill, a second
    // flat accent, then a black keyline drawn *last* at full opacity. Blurry
    // low-contrast smears were reading as spilled paint; line work is what
    // makes a tag read as a tag at 30 m.
    for (const [x, y, s, rot] of tagSpots) {
      oc.save();
      oc.translate(x, y);
      oc.rotate(rot * 0.35);
      const hue = tagHues[(tagRng() * tagHues.length) | 0];
      // One shared skeleton for all three passes, so the keyline actually
      // registers on the fill instead of wandering off it.
      const strokes = 5 + ((tagRng() * 4) | 0);
      const pts = [[-s * 0.5, 0]];
      for (let k = 0; k < strokes; k++) {
        pts.push([-s * 0.5 + ((k + 1) * s) / strokes, (tagRng() - 0.5) * s * 0.62]);
      }
      const trace = () => {
        oc.beginPath();
        oc.moveTo(pts[0][0], pts[0][1]);
        for (let k = 1; k < pts.length; k++) {
          const a = pts[k - 1];
          const b = pts[k];
          oc.bezierCurveTo(a[0] + 5, a[1] - s * 0.34, b[0] - 5, b[1] + s * 0.3, b[0], b[1]);
        }
      };
      oc.lineCap = 'round';
      oc.lineJoin = 'round';
      // Drop shadow / halo first.
      oc.globalAlpha = 0.16;
      oc.strokeStyle = 'rgba(12,10,16,1)';
      oc.lineWidth = 11;
      oc.save();
      oc.translate(3, 4);
      trace();
      oc.stroke();
      oc.restore();
      // Flat body.
      oc.globalAlpha = 0.86;
      oc.strokeStyle = `hsl(${hue},76%,52%)`;
      oc.lineWidth = 9;
      trace();
      oc.stroke();
      // Flat highlight down one side of the body.
      oc.globalAlpha = 0.8;
      oc.strokeStyle = `hsl(${(hue + 26) % 360},84%,66%)`;
      oc.lineWidth = 3.4;
      oc.save();
      oc.translate(-1.6, -2.2);
      trace();
      oc.stroke();
      oc.restore();
      // Keyline: full opacity, thin, hard.
      oc.globalAlpha = 0.95;
      oc.strokeStyle = 'rgba(14,12,18,1)';
      oc.lineWidth = 1.6;
      trace();
      oc.stroke();
      oc.restore();
    }
    // Dirt, damp corners and skid haze so the concrete is not uniformly clean,
    // drawn over the paint so wear eats into the tags.
    oc.globalAlpha = 1;
    for (let i = 0; i < 320; i++) {
      const x = tagRng() * OW;
      const y = tagRng() * OH;
      const r = 36 + tagRng() * 260;
      const g = oc.createRadialGradient(x, y, 0, x, y, r);
      const dark = tagRng() > 0.35;
      g.addColorStop(0, dark ? 'rgba(46,48,50,0.28)' : 'rgba(210,212,214,0.24)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      oc.fillStyle = g;
      oc.beginPath();
      oc.arc(x, y, r, 0, Math.PI * 2);
      oc.fill();
    }
    // Accumulated grit in a ~1.5 m band along every slab edge, plus a broad
    // pour-panel value shift at ~8 m offset from the saw-cut grid. Both are
    // world-anchored, which is why they live here and not in the tiling albedo.
    {
      const PPM = OW / (PAD.x1 - PAD.x0); // ~20 px per metre
      const grit = oc.createLinearGradient(0, 0, PPM * 2.4, 0);
      grit.addColorStop(0, 'rgba(44,46,48,0.34)');
      grit.addColorStop(1, 'rgba(44,46,48,0)');
      oc.fillStyle = grit;
      oc.fillRect(0, 0, PPM * 2.4, OH);
      oc.save();
      oc.translate(OW, 0);
      oc.scale(-1, 1);
      oc.fillStyle = grit;
      oc.fillRect(0, 0, PPM * 2.4, OH);
      oc.restore();
      const gritV = oc.createLinearGradient(0, 0, 0, PPM * 2.4);
      gritV.addColorStop(0, 'rgba(44,46,48,0.34)');
      gritV.addColorStop(1, 'rgba(44,46,48,0)');
      oc.fillStyle = gritV;
      oc.fillRect(0, 0, OW, PPM * 2.4);
      oc.save();
      oc.translate(0, OH);
      oc.scale(1, -1);
      oc.fillStyle = gritV;
      oc.fillRect(0, 0, OW, PPM * 2.4);
      oc.restore();

      // Wear paths: the lines skaters actually push along, bleached and polished.
      oc.lineCap = 'round';
      for (const path of [
        [[120, 1180], [430, 1080], [700, 940], [980, 880], [1300, 900]],
        [[1500, 1400], [1560, 1100], [1620, 800], [1700, 520], [1820, 300]],
        [[300, 300], [640, 360], [1000, 340], [1400, 300]],
      ]) {
        oc.strokeStyle = 'rgba(206,204,196,0.20)';
        oc.lineWidth = 54;
        oc.beginPath();
        oc.moveTo(path[0][0], path[0][1]);
        for (let k = 1; k < path.length; k++) oc.lineTo(path[k][0], path[k][1]);
        oc.stroke();
      }
    }
    /*
     * PAINT.
     *
     * Everything above this point is dirt, and dirt is monochrome. 7,500 m2 of
     * grey concrete with no applied graphics has no colour anchor and no scale
     * reference anywhere east of the stair set - a player standing out there is
     * in an undifferentiated field. Real municipal parks are covered in paint:
     * a perimeter safety line, bay numbers, a sponsor roundel, hatched run-outs.
     * It is also the cheapest possible content for a region that currently
     * carries none, because it costs zero draw calls.
     *
     * The canvas is flipY'd on upload, so pad-local metres map as
     * px = u * PPM and py = OH - v * PPM.
     */
    {
      const PPM = OW / (PAD.x1 - PAD.x0); // 20.48 px per metre
      const PX = (u) => u * PPM;
      const PY = (v) => OH - v * PPM;
      oc.save();
      oc.lineCap = 'butt';
      oc.lineJoin = 'miter';

      // --- perimeter safety stripe, 0.22 m wide, 1.0 m in from the kerb ---
      // Painted twice: a soft under-halo (paint bleeds into open aggregate) and
      // a hard core. A single hard stroke reads as a decal laid on top.
      for (const [w, a] of [[0.42, 0.16], [0.22, 0.82]]) {
        oc.strokeStyle = `rgba(226,182,42,${a})`;
        oc.lineWidth = w * PPM;
        oc.strokeRect(PX(1.0), PY(74.0), PX(98.0) - PX(1.0), PY(1.0) - PY(74.0));
      }
      // Worn through in the places boards and feet actually cross it.
      oc.globalCompositeOperation = 'destination-out';
      for (const [u, v, r] of [[10, 1.2, 3.4], [34, 1.1, 2.2], [63, 1.0, 2.8], [1.1, 40, 3.0], [98.9, 30, 2.4], [50, 73.9, 3.2]]) {
        const g = oc.createRadialGradient(PX(u), PY(v), 0, PX(u), PY(v), r * PPM);
        g.addColorStop(0, 'rgba(0,0,0,0.9)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        oc.fillStyle = g;
        oc.beginPath();
        oc.arc(PX(u), PY(v), r * PPM, 0, Math.PI * 2);
        oc.fill();
      }
      oc.globalCompositeOperation = 'source-over';

      // --- bay numerals: 2.6 m stencil figures, deliberately in the east half
      // where there was previously nothing at all to look at ---
      oc.textAlign = 'center';
      oc.textBaseline = 'middle';
      for (const [u, v, txt, rot] of [
        [46, 52, '1', -0.18], [58, 46, '2', 0.12], [88, 48, '3', -0.08], [92, 12, '4', 1.55],
      ]) {
        oc.save();
        oc.translate(PX(u), PY(v));
        oc.rotate(rot);
        oc.font = `900 ${Math.round(2.6 * PPM)}px "Chakra Petch", system-ui, sans-serif`;
        oc.globalAlpha = 0.62;
        oc.fillStyle = '#e8e6de';
        oc.fillText(txt, 0, 0);
        oc.globalAlpha = 0.5;
        oc.lineWidth = 0.05 * PPM;
        oc.strokeStyle = '#25272b';
        oc.strokeText(txt, 0, 0);
        oc.restore();
      }
      oc.globalAlpha = 1;

      // --- sponsor roundel on the far east flat: 6.4 m across, one saturated
      // colour event in a quadrant that is otherwise pure grey ---
      {
        const cx = PX(95);
        const cy = PY(26);
        const R = 3.2 * PPM;
        oc.globalAlpha = 0.7;
        oc.fillStyle = '#1d5f74';
        oc.beginPath(); oc.arc(cx, cy, R, 0, Math.PI * 2); oc.fill();
        oc.globalAlpha = 0.86;
        oc.fillStyle = '#e6ecec';
        oc.beginPath(); oc.arc(cx, cy, R * 0.74, 0, Math.PI * 2); oc.fill();
        oc.fillStyle = '#c2452a';
        oc.beginPath(); oc.arc(cx, cy, R * 0.42, 0, Math.PI * 2); oc.fill();
        oc.save();
        oc.translate(cx, cy);
        oc.rotate(-0.35);
        oc.fillStyle = '#12333d';
        oc.font = `800 ${Math.round(0.62 * PPM)}px "Chakra Petch", system-ui, sans-serif`;
        oc.fillText('MERIDIAN', 0, -R * 0.58);
        oc.fillText('SKATE', 0, R * 0.6);
        oc.restore();
        // Half the roundel ground off by four seasons of wheels.
        oc.globalCompositeOperation = 'destination-out';
        const wg = oc.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
        wg.addColorStop(0, 'rgba(0,0,0,0)');
        wg.addColorStop(0.55, 'rgba(0,0,0,0.15)');
        wg.addColorStop(1, 'rgba(0,0,0,0.75)');
        oc.fillStyle = wg;
        oc.beginPath(); oc.arc(cx, cy, R, 0, Math.PI * 2); oc.fill();
        oc.globalCompositeOperation = 'source-over';
      }
      oc.globalAlpha = 1;

      // --- hatched run-out bands off the quarter-pipe and the stair landing ---
      oc.lineCap = 'butt';
      for (const [u0, v0, u1, v1, hue] of [[30, 57, 46, 60.5, '#c85a24'], [64, 25.5, 82, 28.5, '#2f7f8c']]) {
        oc.save();
        oc.beginPath();
        oc.rect(PX(u0), PY(v1), PX(u1) - PX(u0), PY(v0) - PY(v1));
        oc.clip();
        oc.strokeStyle = hue;
        oc.globalAlpha = 0.42;
        oc.lineWidth = 0.24 * PPM;
        for (let s = -30; s < 60; s++) {
          const x = PX(u0) + s * 0.9 * PPM;
          oc.beginPath();
          oc.moveTo(x, PY(v0));
          oc.lineTo(x + (PY(v0) - PY(v1)), PY(v1));
          oc.stroke();
        }
        oc.restore();
      }
      oc.globalAlpha = 1;

      // --- skid arcs where every session starts: the gate and the bowl drop-in ---
      oc.lineCap = 'round';
      const skid = makeRng(6161);
      for (const [cu, cv, r0] of [[10, 5, 4.5], [31, 27, 5.5], [78, 16, 5.0], [93, 27, 4.0]]) {
        for (let i = 0; i < 9; i++) {
          const a0 = skid() * 6.28318;
          const sw = 0.5 + skid() * 1.1;
          const r = r0 * (0.45 + skid() * 0.8);
          oc.strokeStyle = `rgba(28,28,30,${0.10 + skid() * 0.14})`;
          oc.lineWidth = (0.05 + skid() * 0.07) * PPM;
          oc.beginPath();
          oc.arc(PX(cu), PY(cv), r * PPM, a0, a0 + sw);
          oc.stroke();
        }
      }
      oc.restore();
    }
    const padOverlay = this._tex(ov, { srgb: true, key: 'pad.overlay' });
    padOverlay.wrapS = padOverlay.wrapT = THREE.ClampToEdgeWrapping;
    this._applyOverlay(this._materials.get('concrete.pad'), padOverlay, {
      polish: true,
      // 0.42, up from 0.24, and on a CONCRETE ramp rather than the turf one it
      // was silently inheriting - a green-to-ochre macro tint on 7,500 m2 of
      // grey slab is both wrong in hue and far too weak in value. Cool damp
      // paste against warm sun-bleached patina, +/-9%.
      macro: 0.42,
      macroCool: [0.895, 0.915, 0.945],
      macroWarm: [1.085, 1.060, 1.015],
      clouds: 0.80,
      desat: 0.85,
    });

    /* ---------------- grass ---------------- */
    await this._breathe();
    const gA = makeCanvas(512, 512);
    paintPixels(gA, (u, v, out) => {
      // Two blade octaves: the fine one gives breakup inside the first few
      // metres, the coarse one gives clump structure at mid distance.
      const blades = fbm(u, v, 64, 3, 23);
      // Third octave pulled from 160 to 112 and its weight halved. At a 6 m
      // tile the old lattice put features at 3.7 cm, which is far below one
      // screen pixel past ~40 m: it contributed nothing but per-pixel noise,
      // and that noise is what made every hillside in the mid-ground read as
      // television static rather than as turf.
      const fine = fbm(u, v, 112, 2, 41);
      const clumps = fbm(u, v, 8, 4, 29);
      // NO mowing nap here. It used to live in this tiling canvas, which meant
      // it inherited the planar UV and ran unbroken up 30-degree hillsides 200 m
      // from any maintained lawn - the loudest texture-projection tell in the
      // world. The stripes now live only in the 1:1 site overlay, clipped to the
      // rectangles that are actually mown.
      // Luma pulled ~11%: the previous base sat around 0.36 linear, which is
      // above real turf (0.18-0.25) and is why the lawn clipped toward plastic
      // under a 6.9 key. It cannot go the whole way down, because the macro,
      // dry-lobe and cloud-shadow terms in `_siteShader` all multiply on top of
      // it - stacking a 26% cut under those took the mid-ground to mud.
      const g = 88 + blades * 39 + fine * 8 + clumps * 25;
      // Mown ryegrass, not hay.
      //
      // The previous mix (R = 0.72g, G = 0.86g) put red within 16% of green,
      // which in sRGB is a khaki - and 400 m of khaki reads as a drought-killed
      // paddock, not as the maintained turf of an athletics ground. Real cut
      // sports turf sits near (70, 112, 48): green dominant by better than 1.5x
      // over red, with blue low enough to keep it out of the teals. The clump
      // octave still drifts the warm channels so the field is not one flat hue.
      // Saturation dropped from ~0.62 to ~0.44 and 5% blue added into the
      // shadowed (darker) end. Kelly green at 0.62 is a felt colour, and at
      // 50-60% of frame area it was reading the whole build as untextured.
      const shade = clamp01(1 - g / 150);
      out[0] = g * 0.62 + clumps * 13;
      out[1] = g * 0.88;
      out[2] = g * (0.42 + shade * 0.10) + blades * 8;
    });
    const gH = makeCanvas(256, 256);
    paintPixels(gH, (u, v, out) => {
      const g = fbm(u, v, 60, 3, 23) * 170 + fbm(u, v, 10, 2, 31) * 45 + fbm(u, v, 128, 2, 41) * 40;
      out[0] = out[1] = out[2] = g;
    });
    const gR = makeCanvas(128, 128);
    paintPixels(gR, (u, v, out) => {
      const g = 215 + (fbm(u, v, 16, 2, 37) - 0.5) * 60;
      out[0] = out[1] = out[2] = g;
    });
    // NOTE ON UV SCALE. The meshes that use this material already carry UVs in
    // metres/12 (_heightMesh uvScale, _fan). Setting `repeat` to a site-sized
    // number here multiplies on top of that, which is what produced a 36 cm
    // albedo tile across a 520 m lawn: every blade, clump and mowing detail
    // aliased to a single averaged colour, so the field read as flat paint.
    // `repeat` is therefore a *tiles per 12 m* figure from here on.
    this._pbr('grass.field', gA, gH, gR, {
      repeat: 2, // 6 m albedo tile
      roughness: 1,
      // Softened from 1.1/1.4. A tangent-space normal at this frequency has no
      // mip chain that can average it honestly, so past ~50 m it was purely a
      // per-pixel shading noise generator. The distance flatten installed by
      // _applyOverlay finishes the job; this just lowers the near-field
      // amplitude so the two agree.
      normalScale: 0.85,
      bump: 1.15,
      envMapIntensity: 0.45,
    });
    // Detail normal repeats far more often than the albedo, which stops the
    // 6 m tile from reading as a checkerboard at grazing angles.
    this._materials.get('grass.field').normalMap.repeat.set(12 / 2.2, 12 / 2.2);

    await this._breathe();
    const gOv = makeCanvas(1536, 1536);
    const goc = gOv.getContext('2d');
    goc.clearRect(0, 0, 1536, 1536);
    const gr = makeRng(99);

    /*
     * Macro variation, first pass.
     *
     * A single 6 m tile stretched over 520 m of lawn is wallpaper no matter how
     * good the tile is - the eye locks onto the repeat within one second. This
     * canvas is stretched once across the whole site, so a low-frequency value
     * and hue field painted here breaks the repeat everywhere at zero runtime
     * cost. ~16% value swing, hue drifting toward yellow-ochre in the dry
     * patches and toward blue-green in the damp hollows.
     */
    {
      const MW = 192;
      const img = goc.createImageData(MW, MW);
      const d = img.data;
      for (let y = 0; y < MW; y++) {
        for (let x = 0; x < MW; x++) {
          const u = x / MW;
          const v = y / MW;
          const macro = fbm(u, v, 5, 3, 881);
          const patch = fbm(u, v, 11, 2, 887);
          const dry = clamp01((macro - 0.52) * 2.0);
          const damp = clamp01((0.5 - macro) * 1.8);
          const i = (y * MW + x) * 4;
          // Dry: warm ochre. Damp: deep blue-green. Alpha carries the strength.
          //
          // Both stops used to sit around (150,148,86) - a khaki that, at up to
          // 32% coverage, dragged the whole lawn off green regardless of what
          // the tiling albedo did. The stops are now a *pair* either side of
          // turf green rather than a single yellow, and the coverage is roughly
          // a third lower, so this reads as irrigation variation instead of as
          // a dust layer over the site.
          d[i] = 116 + dry * 58 - damp * 50;
          d[i + 1] = 140 + dry * 24 - damp * 24;
          d[i + 2] = 60 + dry * 24 - damp * 8;
          d[i + 3] = (0.05 + dry * 0.09 + damp * 0.09 + patch * 0.03) * 255;
        }
      }
      const tmp = makeCanvas(MW, MW);
      tmp.getContext('2d').putImageData(img, 0, 0);
      goc.imageSmoothingEnabled = true;
      goc.drawImage(tmp, 0, 0, 1536, 1536);
    }
    // Mowing stripes live here, not in the tiling albedo: this canvas is
    // stretched once across the whole 400 m site, so the bands are finite,
    // rotate per area and stop where the lawn stops.
    // The overlay now spans the FULL +/-260 m terrain extent, not +/-200 m.
    // Clamping it at 200 m meant the outer 60 m ring of every hillside - which
    // is most of the horizon in a wide shot - received no macro variation at
    // all and read as raw vertex colour.
    const OVR = 260;
    const M = 1536 / (OVR * 2);
    for (const [x0, z0, x1, z1, ang, band] of [
      [-30, 118, 30, 184, 0, 5.5],
      [62, 2, 128, 50, Math.PI / 2, 4.0],
      [16, -148, 194, -52, 0, 6.5],
      [-124, 78, -26, 118, Math.PI / 2, 5.0],
      // The two big connective lawns - pool-to-courts and plaza-to-tower. Both
      // are crossed on foot constantly and both were unbroken green.
      [22, 52, 118, 116, 22 * DEG, 5.2],
      [-24, 30, 46, 96, -14 * DEG, 4.6],
    ]) {
      goc.save();
      goc.beginPath();
      goc.rect((x0 + OVR) * M, (z0 + OVR) * M, (x1 - x0) * M, (z1 - z0) * M);
      goc.clip();
      goc.translate(((x0 + x1) / 2 + OVR) * M, ((z0 + z1) / 2 + OVR) * M);
      // Two stripe octaves. The second runs at 3.7x the band width rotated 31
      // degrees off the first, which destroys the regular interval the eye was
      // locking onto and reads as the previous cut still showing through.
      for (const [pass, mul, rot, alpha] of [[0, 1, 0, 1], [1, 3.7, 31 * DEG, 0.45]]) {
        goc.save();
        goc.rotate(ang + rot);
        const span = Math.hypot(x1 - x0, z1 - z0) * M;
        const bw = band * mul * M;
        const n = Math.ceil(span / bw) + 2;
        for (let i = -n; i <= n; i++) {
          // Strengthened ~50%. Cut-direction striping is the single most
          // recognisable signature of maintained sports turf, and at 0.10 it
          // was invisible on anything the camera was not standing on.
          goc.fillStyle = i % 2
            ? `rgba(226,236,196,${0.15 * alpha})`
            : `rgba(26,44,16,${0.17 * alpha})`;
          goc.beginPath();
          // A slight sinusoidal wobble on the boundary: mower lines are never
          // laser straight and the eye reads a perfect edge as a texture bug.
          const y0 = i * bw;
          const wob = 3.5 + pass * 5;
          goc.moveTo(-span, y0);
          for (let s = -span; s <= span; s += 24) {
            goc.lineTo(s, y0 + Math.sin(s * 0.012 + pass) * wob);
          }
          for (let s = span; s >= -span; s -= 24) {
            goc.lineTo(s, y0 + bw + Math.sin(s * 0.012 + pass) * wob);
          }
          goc.closePath();
          goc.fill();
        }
        goc.restore();
      }
      goc.restore();
    }
    // Patch breakup. Halved in both count and strength: at 420 blobs of 0.3
    // alpha the field read as staining rather than as growth variation, and the
    // dry stop was the same ochre that was already flattening the hue.
    for (let i = 0; i < 240; i++) {
      const x = gr() * 1536;
      const y = gr() * 1536;
      const r = 34 + gr() * 220;
      const g = goc.createRadialGradient(x, y, 0, x, y, r);
      const dry = gr() > 0.58;
      g.addColorStop(0, dry ? 'rgba(146,142,74,0.17)' : 'rgba(44,80,32,0.19)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      goc.fillStyle = g;
      goc.beginPath();
      goc.arc(x, y, r, 0, Math.PI * 2);
      goc.fill();
    }
    /*
     * Desire lines and dirt wear.
     *
     * Grass does not survive being walked on. Every fence line, gate, kerb
     * entrance and bench run in a real park carries a band of bare compacted
     * earth, and their absence is a large part of why the lawn read as paint
     * rather than as ground. These are painted straight into the site overlay
     * so they land on exact world coordinates.
     */
    const wear = (pts, width, alpha) => {
      goc.save();
      goc.lineCap = 'round';
      goc.lineJoin = 'round';
      for (const [w, a] of [[width * 1.9, alpha * 0.35], [width, alpha]]) {
        goc.strokeStyle = `rgba(112,94,66,${a})`;
        goc.lineWidth = w * M;
        goc.beginPath();
        for (let i = 0; i < pts.length; i++) {
          const [px, pz] = pts[i];
          const jx = (px + OVR) * M;
          const jz = (pz + OVR) * M;
          if (i === 0) goc.moveTo(jx, jz);
          else goc.lineTo(jx, jz);
        }
        goc.stroke();
      }
      goc.restore();
    };
    // Court enclosure perimeter, its gate, and the skate pad kerb line.
    wear([[64, 4], [126, 4], [126, 48], [64, 48], [64, 4]], 1.3, 0.30);
    wear([[58, 26], [64, 26], [70, 26]], 2.6, 0.42);
    wear([[-125, -1], [-25, -1]], 1.5, 0.26);
    wear([[-125, 76], [-25, 76]], 1.5, 0.22);
    wear([[-25, 0], [-25, 75]], 1.4, 0.24);
    // Cut-through desire lines: plaza to skate pad, plaza to courts, plaza to
    // the pool, and the shortcut everybody takes off the avenue.
    wear([[0, 120], [-18, 100], [-48, 86], [-80, 79]], 1.8, 0.26);
    wear([[0, 118], [26, 96], [58, 66], [82, 50]], 1.7, 0.24);
    wear([[6, 122], [26, 116], [44, 112]], 1.6, 0.22);
    wear([[-10, 126], [-30, 106], [-44, 84], [-52, 40], [-54, -20], [-52, -56]], 1.5, 0.20);
    wear([[104, -52], [96, -30], [96, 0], [100, 6]], 1.5, 0.20);
    // Trampled apron in front of each bleacher run.
    for (const [bx, bz, bw] of [[-95, -12, 30], [105, -160, 42], [95, 58, 30], [-95, 87, 26]]) {
      wear([[bx - bw / 2, bz], [bx + bw / 2, bz]], 3.2, 0.24);
    }

    // The overlay is CLAMPED, not repeated. Anything left in the border row is
    // extrapolated outward across the backdrop skirt, so clear a thin margin.
    goc.clearRect(0, 0, 1536, 8);
    goc.clearRect(0, 1528, 1536, 8);
    goc.clearRect(0, 0, 8, 1536);
    goc.clearRect(1528, 0, 8, 1536);
    const grassOverlay = this._tex(gOv, { srgb: true, key: 'grass.overlay' });
    grassOverlay.wrapS = grassOverlay.wrapT = THREE.ClampToEdgeWrapping;
    // flattenFar only touches the tangent NORMAL - flat normals past 150 m are
    // correct. The macro/dry/cloud terms below are world-space and deliberately
    // run at full strength to the horizon, which is what stops the mid- and
    // far-ground from collapsing into a single lit gradient.
    this._applyOverlay(this._materials.get('grass.field'), grassOverlay, {
      flattenFar: 150,
      macro: 1.0,
      dry: 0.34,
      clouds: 1.0,
      desat: 1.0,
    });

    /* ---------------- snow ---------------- */
    await this._breathe();
    const sA = makeCanvas(512, 512);
    // Corduroy at ~50 cm across a 4 m tile. The old 28 cycles/tile put the ribs
    // at 14 cm, which is below one screen pixel past 25 m - all the authored
    // detail existed but nothing survived to the camera.
    const CORD = 8;
    paintPixels(sA, (u, v, out) => {
      const drift = fbm(u, v, 6, 4, 51);
      const grain = fbm(u, v, 44, 3, 55);
      const cord = 0.5 + 0.5 * Math.sin(u * Math.PI * 2 * CORD);
      // Raised back toward a real snowpack albedo (~0.85 linear). With the lawn
      // pulled down 26% and the concrete unchanged, the mound at the old value
      // sat within a few percent of both the skate pad AND the sky's horizon
      // band, so its silhouette dissolved into whatever was behind it. It has
      // to be the brightest thing in the frame or it is not snow.
      const l = 206 + drift * 22 + cord * 12 + grain * 9;
      out[0] = Math.min(255, l * 0.965);
      out[1] = Math.min(255, l * 0.985);
      out[2] = Math.min(255, l * 1.01 + 8);
    });
    const sH = makeCanvas(512, 512);
    paintPixels(sH, (u, v, out) => {
      const cord = 0.5 + 0.5 * Math.sin(u * Math.PI * 2 * CORD);
      const g = cord * 165 + fbm(u, v, 30, 3, 53) * 90;
      out[0] = out[1] = out[2] = g;
    });
    const sR = makeCanvas(256, 256);
    paintPixels(sR, (u, v, out) => {
      /*
       * This map used to be a BINARY threshold on a 96-octave field - 28 or 158
       * with nothing in between - which is a per-texel step function. No mip
       * chain can average a step honestly, so the whole mound rendered as grey
       * salt-and-pepper static and read as a broken texture rather than as
       * snow. A smooth remap into 0.55-0.82 keeps the crystalline break-up but
       * filters correctly at every distance.
       */
      const sparkle = fbm(u, v, 40, 3, 59);
      const g = 140 + smoothstep(0.42, 0.86, sparkle) * 70 + (fbm(u, v, 9, 2, 61) - 0.5) * 22;
      out[0] = out[1] = out[2] = g;
    });
    // Slope UVs are metres/4; 1 tile per 4 m keeps the corduroy ribs at the
    // ~50 cm the albedo was authored for instead of a 12 cm shimmer.
    this._pbr('snow.piste', sA, sH, sR, {
      repeat: 1,
      repeatY: 1,
      roughness: 0.78,
      // 0.45, down from 1.4. At a 1.2 m mesh resolution the corduroy normal is
      // sub-texel past ~60 m and was contributing nothing but crawl.
      normalScale: 0.45,
      bump: 1.5,
      // The sky probe was flooding the snow back to key value and killing the
      // terminator on the one landform that most needs one.
      envMapIntensity: 0.6,
    });
    {
      const sm = this._materials.get('snow.piste');
      // 0.45, not 2. The UV is metres/4, so repeat 2 put the corduroy rib at
      // 25 cm - sub-pixel from anywhere the mountain is actually seen from, so
      // all of the authored grooming resolved as crawl and none of it as form.
      // 0.45 lands the rib at ~1.1 m, which is the largest scale that still
      // reads as a groomer track and the smallest that survives to 250 m.
      sm.normalMap.repeat.set(0.45, 0.45);
      // Vertex colours carry the baked curvature/AO term and the scree blend at
      // the snow line, so the mound has form before a single shadow lands.
      sm.vertexColors = true;
      /*
       * The mound was an untextured white cone across 300 px of frame: one flat
       * value with only the geometric ridge shading breaking it up. Its albedo
       * is a 4 m tile, so past ~120 m the mip chain has averaged every drift,
       * every grain and the whole corduroy into a single number - exactly the
       * failure the lawn already had solved. The world-space macro term has no
       * tile period at all and therefore survives every mip level.
       *
       * The RAMP is snow-specific: a blue-shadowed wind drift at the cool end
       * and a scoured warm grey at the hot end. The lawn's default ramp is a
       * green one and would have painted algae up the piste.
       */
      this._flattenFar(sm, 120, {
        clouds: 0.45,
        desat: 0.8,
        macro: 0.55,
        macroCool: [0.885, 0.925, 1.005],
        macroWarm: [1.055, 1.045, 1.015],
      });
    }

    /* ---------------- rubber running track ---------------- */
    const paintRubber = (canvas) =>
      paintPixels(canvas, (u, v, out) => {
        // Two grit scales plus a very low-frequency wear band. A cast
        // polyurethane track is not one flat colour: the sprayed EPDM top
        // layer mottles, and the inside lanes are visibly more polished.
        // 112, not 40. The canvas covers 9.76 m across the lanes by 8 m along
        // them, so a lattice of 40 puts the "grit" at 24 cm - the size of a
        // paving brick, which is exactly what the oval read as. Sprayed EPDM
        // granules are 1-3 mm; 112 lands the visible clumping at ~9 cm, which
        // is the largest scale that still reads as a surface rather than as
        // masonry.
        const grit = fbm(u, v, 112, 3, 71);
        const fleck = fbm(u, v, 240, 2, 77);
        const wear = fbm(u, v, 6, 2, 79);
        const l = 0.92 + wear * 0.16;
        out[0] = (162 + grit * 30 + fleck * 16) * l;
        out[1] = (58 + grit * 20 + fleck * 12) * l;
        out[2] = (46 + grit * 16 + fleck * 10) * l;
      });
    // Lane-less variant for the long-jump runway: the runway shares the track's
    // product but not its markings, and stretching the 8-lane albedo across a
    // 35 m runway drew nine phantom lane lines straight across it.
    await this._breathe();
    const tP = makeCanvas(512, 256);
    paintRubber(tP);
    const tA = makeCanvas(512, 256);
    const tc = tA.getContext('2d');
    paintRubber(tA);
    for (let i = 0; i <= TRACK.lanes; i++) {
      const x = (i / TRACK.lanes) * 512;
      // Paint feathers: a 5 cm line on a porous rubber surface never has a
      // one-texel edge, and a hard edge is what makes markings read as decals.
      for (const [w, a] of [[9, 0.16], [7, 0.34], [5, 0.95]]) {
        tc.strokeStyle = `rgba(244,246,242,${a})`;
        tc.lineWidth = w;
        tc.beginPath();
        tc.moveTo(x, 0);
        tc.lineTo(x, 256);
        tc.stroke();
      }
    }
    const tH = makeCanvas(256, 256);
    paintPixels(tH, (u, v, out) => {
      // Shallow and fine. A full 0..255 swing at a 15 cm lattice gave the
      // track a corrugated normal that moired into basketweave from 60 m out.
      const g = 96 + fbm(u, v, 130, 2, 71) * 90 + fbm(u, v, 34, 2, 75) * 34;
      out[0] = out[1] = out[2] = g;
    });
    const tR = makeCanvas(128, 128);
    paintPixels(tR, (u, v, out) => {
      const g = 200 + (fbm(u, v, 20, 2, 73) - 0.5) * 50;
      out[0] = out[1] = out[2] = g;
    });
    this._pbr('rubber.track', tA, tH, tR, { roughness: 0.92, normalScale: 0.35, bump: 0.9, envMapIntensity: 0.4 });
    this._flattenFar(this._materials.get('rubber.track'), 90, { clouds: 0.7, desat: 0.9 });
    // U runs *across* the lanes and is exactly 0..1, so clamping is what keeps
    // the outer lane line on the outer edge; V tiles freely along the lap.
    this._materials.get('rubber.track').map.wrapS = THREE.ClampToEdgeWrapping;
    this._pbr('rubber.plain', tP, tH, tR, { repeat: 4, roughness: 0.92, normalScale: 0.35, bump: 0.9, envMapIntensity: 0.4 });
    this._flattenFar(this._materials.get('rubber.plain'), 90, { clouds: 0.7, desat: 0.9 });

    /* ---- lane numerals, as one 8-cell atlas ---- */
    const lnW = 1024;
    const ln = makeCanvas(lnW, 128);
    const lnc = ln.getContext('2d');
    lnc.fillStyle = '#000000';
    lnc.fillRect(0, 0, lnW, 128);
    lnc.fillStyle = '#ffffff';
    lnc.textAlign = 'center';
    lnc.textBaseline = 'middle';
    lnc.font = '800 96px system-ui, sans-serif';
    for (let i = 0; i < 8; i++) lnc.fillText(String(i + 1), i * 128 + 64, 68);
    const lnMap = this._tex(ln, { srgb: true, repeat: 1, key: 'lane.num.map' });
    lnMap.wrapS = lnMap.wrapT = THREE.ClampToEdgeWrapping;
    const lnAlpha = this._tex(ln, { srgb: false, repeat: 1, key: 'lane.num.alpha' });
    lnAlpha.wrapS = lnAlpha.wrapT = THREE.ClampToEdgeWrapping;
    this._mat(
      'paint.lane',
      new THREE.MeshStandardMaterial({
        map: lnMap,
        alphaMap: lnAlpha,
        alphaTest: 0.45,
        alphaToCoverage: true,
        roughness: 0.86,
        envMapIntensity: 0.3,
      })
    );

    /* ---------------- court surfaces ---------------- */
    await this._buildCourtTextures();

    /* ---------------- pool ---------------- */
    const pA = makeCanvas(256, 256);
    paintPixels(pA, (u, v, out) => {
      const gx = (u * 8) % 1;
      const gy = (v * 8) % 1;
      const grout = gx < 0.055 || gy < 0.055 || gx > 0.945 || gy > 0.945;
      const shade = fbm(u, v, 16, 3, 83);
      if (grout) {
        out[0] = 206; out[1] = 210; out[2] = 208;
      } else {
        out[0] = 30 + shade * 40;
        out[1] = 140 + shade * 60;
        out[2] = 176 + shade * 50;
      }
    });
    const pH = makeCanvas(256, 256);
    paintPixels(pH, (u, v, out) => {
      const gx = (u * 8) % 1;
      const gy = (v * 8) % 1;
      const grout = gx < 0.055 || gy < 0.055 || gx > 0.945 || gy > 0.945;
      out[0] = out[1] = out[2] = grout ? 30 : 205 + fbm(u, v, 40, 2, 87) * 40;
    });
    this._pbr('tile.pool', pA, pH, null, {
      repeat: 6,
      roughness: 0.22,
      metalness: 0.02,
      normalScale: 0.75,
      bump: 2.4,
      envMapIntensity: 1.2,
    });

    /*
     * Deck concrete - the material under every apron, kerb, plinth and pool
     * surround, and the one that was aliasing to salt-and-pepper.
     *
     * The old build ran a 48-cycle noise inside a 256 px canvas (~5 texels per
     * cycle) at repeat 12, which over a 62 m court apron put the noise period
     * well under one screen pixel. It resolved as random per-pixel white
     * speckle that shimmered under camera motion instead of reading as
     * concrete. Three changes: 4x the canvas, a quarter of the base frequency
     * so the noise has real texel support, and a quarter of the repeat so the
     * saw-cut grid gives a ~1.3 m paver rather than a 33 cm one. The base value
     * also comes down from 196 - it was brighter than the sunlit snow.
     */
    await this._breathe();
    const dA = makeCanvas(512, 512);
    paintPixels(dA, (u, v, out) => {
      const gx = (u * 4) % 1;
      const gy = (v * 4) % 1;
      const joint = gx < 0.012 || gy < 0.012;
      const agg = fbm(u, v, 12, 4, 89);
      const patch = fbm(u, v, 3, 2, 93);
      const g = 142 + agg * 30 + (patch - 0.5) * 22 - (joint ? 34 : 0);
      out[0] = g;
      out[1] = g * 0.985;
      out[2] = g * 0.94;
    });
    const dH = makeCanvas(512, 512);
    paintPixels(dH, (u, v, out) => {
      const gx = (u * 4) % 1;
      const gy = (v * 4) % 1;
      const joint = gx < 0.012 || gy < 0.012;
      out[0] = out[1] = out[2] = joint ? 20 : 140 + fbm(u, v, 16, 3, 89) * 100;
    });
    const dR = makeCanvas(256, 256);
    paintPixels(dR, (u, v, out) => {
      const g = 190 + (fbm(u, v, 5, 3, 97) - 0.5) * 96;
      out[0] = out[1] = out[2] = clamp(g, 110, 240);
    });
    this._pbr('concrete.deck', dA, dH, dR, {
      repeat: 3,
      roughness: 0.88,
      normalScale: 0.9,
      bump: 1.1,
      envMapIntensity: 0.4,
    });
    // Detail normal at ~2.7x the albedo rate. The albedo tile is 1.3 m, which
    // is a paver module, not an aggregate scale: at 60 m the material was
    // contributing no surface incident at all and the deck read as grey
    // plastic. 8 tiles per UV unit puts the aggregate at ~0.5 m, which is the
    // largest scale that still reads as concrete rather than as paving.
    this._materials.get('concrete.deck').normalMap.repeat.set(8, 8);
    {
      const dm = this._materials.get('concrete.deck');
      for (const t of [dm.map, dm.normalMap, dm.roughnessMap]) {
        if (!t) continue;
        t.generateMipmaps = true;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.needsUpdate = true;
      }
      // Cloud shadow and aerial desaturation on the concrete too - if only the
      // lawn carried them the paving would sit at a different exposure to the
      // grass it is surrounded by, which is a worse tell than having neither.
      this._flattenFar(dm, 70, {
        macro: 0.40,
        macroCool: [0.895, 0.915, 0.945],
        macroWarm: [1.085, 1.060, 1.015],
        clouds: 0.85,
        desat: 0.9,
      });
    }

    /* ---------------- paving / paths ---------------- */
    const vA = makeCanvas(256, 256);
    paintPixels(vA, (u, v, out) => {
      const g = 150 + fbm(u, v, 44, 4, 101) * 62 + fbm(u, v, 7, 2, 103) * 24;
      out[0] = g * 1.02;
      out[1] = g * 0.99;
      out[2] = g * 0.93;
    });
    const vH = makeCanvas(256, 256);
    paintPixels(vH, (u, v, out) => {
      const g = fbm(u, v, 52, 4, 101) * 255;
      out[0] = out[1] = out[2] = g;
    });
    /*
     * The shoulder was the brightest object in the lower half of every wide
     * shot: a strip of high-contrast white popcorn with a countable repeat,
     * sitting ABOVE sunlit concrete in value, which is physically wrong for
     * compacted limestone (albedo ~0.28 against a poured deck's ~0.35).
     *
     * Three separate faults, three fixes. (1) The tint goes from 0xc7c2b6 to
     * 0x9d988c so it sits below the deck. (2) `bump: 2.6` with `normalScale: 1`
     * on a 1.5 m tile generates per-stone normals at sub-pixel scale - that is
     * the shimmer, and it is a shading-frequency problem no AA touches, so the
     * amplitude comes down by better than half. (3) A roughness map: the third
     * argument used to be `null`, which left roughness constant at 0.95 and
     * gave the whole run one uniform sheen instead of a broken one.
     */
    const vR = makeCanvas(256, 256);
    paintPixels(vR, (u, v, out) => {
      // 0.82-1.0. Wet-compacted fines between the stones stay a touch glossier
      // than the exposed aggregate, which is the only specular event a gravel
      // verge should ever have.
      const g = 232 + (fbm(u, v, 30, 3, 107) - 0.5) * 46;
      out[0] = out[1] = out[2] = clamp(g, 209, 255);
    });
    this._pbr('path.gravel', vA, vH, vR, {
      repeat: 1, roughness: 1, normalScale: 0.6, bump: 1.2, envMapIntensity: 0.34, color: 0x9d988c,
    });

    /* ---- tarmac footpath + its worn verge ---- */
    const kA = makeCanvas(256, 256);
    paintPixels(kA, (u, v, out) => {
      const agg = fbm(u, v, 96, 3, 151);
      const patch = fbm(u, v, 5, 3, 157);
      // Bitumen with a bleached, gritty wear lane down the middle. u runs
      // across the ribbon width, v along its length.
      const wear = 1 - Math.abs(u - 0.5) * 1.4;
      const g = 92 + agg * 54 + (patch - 0.5) * 26 + wear * 16;
      out[0] = g * 1.02;
      out[1] = g;
      out[2] = g * 0.99;
    });
    const kH = makeCanvas(256, 256);
    paintPixels(kH, (u, v, out) => {
      const g = fbm(u, v, 110, 3, 151) * 210 + fbm(u, v, 14, 2, 157) * 45;
      out[0] = out[1] = out[2] = g;
    });
    this._pbr('path.tarmac', kA, kH, null, {
      repeat: 1,
      repeatY: 1,
      roughness: 0.9,
      normalScale: 1.15,
      bump: 2.0,
      envMapIntensity: 0.42,
    });
    this._materials.get('path.tarmac').normalMap.repeat.set(3, 3);
    this._flattenFar(this._materials.get('path.tarmac'), 70, { clouds: 0.85, desat: 0.9 });
    // 140, not 70. The gravel shoulder runs diagonally across the foreground of
    // the skatepark wide, so killing its normal response at 70 m flattened it
    // to a single-value ribbon in exactly the band where it needed to catch the
    // low sun. A macro term breaks its 1.5 m tile repeat at the same time.
    // 95, not 140: the per-stone normal has to be gone BEFORE it goes
    // sub-pixel, and at this stone size that happens around 90 m. The macro
    // term doubles to 0.7 to take over the break-up job the normal was doing.
    this._flattenFar(this._materials.get('path.gravel'), 95, {
      macro: 0.70, clouds: 0.85, desat: 0.9, detile: true,
    });

    // Verge: scuffed earth showing through thin grass. Alpha-tested at the
    // outer edge so tarmac never meets mown lawn on a razor line.
    const eA = makeCanvas(256, 256);
    const eAl = makeCanvas(256, 256);
    paintPixels(eA, (u, v, out) => {
      const g = fbm(u, v, 40, 4, 163);
      const dirt = clamp01(1 - Math.abs(u - 0.5) * 2.2);
      out[0] = lerp(96, 132, g) * lerp(0.82, 1.12, dirt);
      out[1] = lerp(100, 122, g) * lerp(0.94, 1.0, dirt);
      out[2] = lerp(62, 78, g) * lerp(0.92, 0.86, dirt);
    });
    paintPixels(eAl, (u, v, out) => {
      const edge = 1 - Math.abs(u - 0.5) * 2;
      const g = clamp01(edge * 2.4 + (fbm(u, v, 30, 3, 167) - 0.5) * 1.3) * 255;
      out[0] = out[1] = out[2] = g;
    });
    const vergeAlpha = this._tex(eAl, { srgb: false, repeat: 1, key: 'verge.alpha' });
    this._mat(
      'path.verge',
      new THREE.MeshStandardMaterial({
        map: this._tex(eA, { srgb: true, repeat: 1, key: 'verge.map' }),
        alphaMap: vergeAlpha,
        alphaTest: 0.4,
        roughness: 1,
        envMapIntensity: 0.42,
      })
    );

    /* ---------------- timber ---------------- */
    const wA = makeCanvas(256, 256);
    paintPixels(wA, (u, v, out) => {
      const rings = Math.sin((v * 26 + fbm(u, v, 8, 3, 111) * 7) * Math.PI);
      const plank = Math.floor(v * 6) % 2 === 0 ? 1.0 : 0.93;
      const g = (128 + rings * 20 + fbm(u, v, 60, 2, 113) * 28) * plank;
      out[0] = g * 1.16;
      out[1] = g * 0.86;
      out[2] = g * 0.6;
    });
    const wH = makeCanvas(256, 256);
    paintPixels(wH, (u, v, out) => {
      const gap = (v * 6) % 1 < 0.035 ? 0 : 1;
      const g = gap * (150 + Math.sin(v * 26 * Math.PI) * 40 + fbm(u, v, 64, 2, 113) * 60);
      out[0] = out[1] = out[2] = g;
    });
    this._pbr('wood.plank', wA, wH, null, { repeat: 4, roughness: 0.82, normalScale: 1, bump: 2.2, envMapIntensity: 0.5 });

    // Dark stained structural timber: same grain field, tighter planks, used
    // for the lodge roof, balustrade and deck framing. The lodge used to be a
    // flat 0x6b4a2f box, which is ~25% of the ski establishing shot.
    const bA = makeCanvas(256, 256);
    paintPixels(bA, (u, v, out) => {
      const rings = Math.sin((v * 34 + fbm(u, v, 9, 3, 121) * 8) * Math.PI);
      const plank = Math.floor(v * 9) % 2 === 0 ? 1.0 : 0.9;
      const weather = fbm(u, v, 5, 3, 127);
      const g = (86 + rings * 15 + fbm(u, v, 70, 2, 123) * 22) * plank * lerp(0.85, 1.1, weather);
      out[0] = g * 1.22;
      out[1] = g * 0.86;
      out[2] = g * 0.62;
    });
    const bH = makeCanvas(256, 256);
    paintPixels(bH, (u, v, out) => {
      const gap = (v * 9) % 1 < 0.05 ? 0 : 1;
      const g = gap * (140 + Math.sin(v * 34 * Math.PI) * 45 + fbm(u, v, 72, 2, 123) * 65);
      out[0] = out[1] = out[2] = g;
    });
    this._pbr('wood.beam', bA, bH, null, { repeat: 3, roughness: 0.88, normalScale: 1.2, bump: 2.4, envMapIntensity: 0.5 });

    /* ---- galvanised steel ---- */
    // Every mast, tower, station column and gantry in the world runs on this,
    // and it was a flat colour with no maps at all.
    const mA = makeCanvas(256, 256);
    paintPixels(mA, (u, v, out) => {
      // Spangle: the crystalline pattern hot-dip galvanising leaves behind.
      const spangle = fbm(u, v, 14, 3, 171);
      const streak = fbm(u * 0.25, v, 40, 2, 173);
      const dirt = clamp01(fbm(u, v, 6, 3, 177) * 1.4 - 0.5);
      const g = 150 + (spangle - 0.5) * 46 + (streak - 0.5) * 20 - dirt * 26;
      out[0] = g * 0.98;
      out[1] = g * 1.0;
      out[2] = g * 1.04;
    });
    const mH = makeCanvas(256, 256);
    paintPixels(mH, (u, v, out) => {
      const g = fbm(u, v, 16, 3, 171) * 190 + fbm(u, v, 64, 2, 179) * 55;
      out[0] = out[1] = out[2] = g;
    });
    const mR = makeCanvas(128, 128);
    paintPixels(mR, (u, v, out) => {
      const g = 96 + fbm(u, v, 10, 3, 181) * 120;
      out[0] = out[1] = out[2] = g;
    });
    // roughness 0.78 (was 0.52) and a much weaker probe. Galvanised bracing on
    // the bleachers was clipping to pure white on whichever bars caught the sun
    // normal exactly, while identical neighbours stayed dark - classic sub-pixel
    // specular aliasing with MSAA unavailable.
    this._pbr('metal.galv', mA, mH, mR, {
      repeat: 2,
      roughness: 0.78,
      metalness: 0.92,
      normalScale: 0.55,
      envMapIntensity: 0.85,
      bump: 1.0,
    });
    // Nearly every sub-pixel element in the world is made of this - fence rails,
    // stand bracing, masts, handrails - so it is the one material where NDF
    // filtering earns its keep.
    this._siteShader(this._materials.get('metal.galv'), { specAA: true, desat: 0.7 });

    /* ---------------- chain-link ---------------- */
    // Real 9-gauge 2-inch chain link is ~85% open area. The previous alpha map
    // drew 9 px wires on a 128 px canvas - roughly half the texel area opaque -
    // which mip-averaged above the alpha test and turned the whole enclosure
    // into a frosted panel that walled off the courts.
    const KC = 512;
    await this._breathe();
    const kc = makeCanvas(KC, KC);
    const kctx = kc.getContext('2d');
    kctx.fillStyle = '#000000';
    kctx.fillRect(0, 0, KC, KC);
    kctx.lineCap = 'butt';
    const spacing = KC / 8;
    for (let pass = 0; pass < 2; pass++) {
      // 2.4 px at 512, not 4.4. Real 9-gauge 2-inch link is ~85% open area; at
      // 4.4 px this map was ~19% opaque, which is nearly a third more wire than
      // the product has and is the number that fed the mip failure below.
      kctx.lineWidth = 2.4;
      kctx.strokeStyle = pass === 0 ? '#ffffff' : '#e2e2e2';
      for (let i = -8; i < 16; i++) {
        kctx.beginPath();
        if (pass === 0) {
          kctx.moveTo(i * spacing, 0);
          kctx.lineTo(i * spacing + KC, KC);
        } else {
          kctx.moveTo(i * spacing, KC);
          kctx.lineTo(i * spacing + KC, 0);
        }
        kctx.stroke();
      }
    }
    const linkAlpha = this._registerTex(
      'chain.alpha',
      makeCoverageMips(kc, 0.5)
    );
    linkAlpha.wrapS = linkAlpha.wrapT = THREE.RepeatWrapping;
    const chainMat = new THREE.MeshStandardMaterial({
      // Mesh tint pulled well below the galvanised posts and rails (0xdfe6ea-ish
      // on `metal.galv`). Chain link, top rail and posts all sitting at the same
      // value is what let the whole enclosure read as one flat grey panel even
      // where the weave *was* resolving.
      color: 0x585d60,
      alphaMap: linkAlpha,
      /*
       * alphaTest 0.5 with a COVERAGE-PRESERVING mip chain.
       *
       * The previous 0.14 was chosen because a box-filtered mip chain drops the
       * mean alpha of a mostly-open texture below any sensible threshold and
       * the wires vanish. But testing under the mean has the opposite failure
       * and it is much worse: by mip 3 essentially every texel is above 0.14,
       * every fragment passes, and the fence renders as a SOLID grey wall that
       * occludes the courts it exists to frame. No threshold fixes this,
       * because the defect is in the mip chain, not the test. `makeCoverageMips`
       * rescales each level so the fraction of texels passing 0.5 matches
       * mip 0, which is the Castano construction - the fence then thins out
       * with distance the way real link does instead of either disappearing or
       * turning opaque.
       */
      alphaTest: 0.5,
      transparent: false,
      depthWrite: true,
      roughness: 0.45,
      metalness: 0.9,
      side: THREE.DoubleSide,
      envMapIntensity: 1.35,
    });
    // alphaToCoverage IS on now. The note that used to sit here - "the engine
    // renders with antialias off" - described `WebGLRenderer({antialias})`,
    // which is indeed false, but the scene never reaches the default drawing
    // buffer: PostFX renders it into an HDR target carrying 4x MSAA. A2C
    // therefore has four real subsamples to write partial coverage into, which
    // is exactly what a 4 mm wire needs at 60 m.
    chainMat.alphaToCoverage = true;
    this._mat('fence.chain', chainMat);

    // The piste safety net is a different product - denser, orange, and it has
    // to stay legible at 80 m - so it gets its own coarser alpha.
    const nc = makeCanvas(256, 256);
    const nctx = nc.getContext('2d');
    nctx.fillStyle = '#000000';
    nctx.fillRect(0, 0, 256, 256);
    nctx.strokeStyle = '#ffffff';
    nctx.lineWidth = 9;
    for (let i = -4; i < 8; i++) {
      nctx.beginPath();
      nctx.moveTo(i * 64, 0);
      nctx.lineTo(i * 64 + 256, 256);
      nctx.stroke();
      nctx.beginPath();
      nctx.moveTo(i * 64, 256);
      nctx.lineTo(i * 64 + 256, 0);
      nctx.stroke();
    }
    const netAlpha = this._tex(nc, { srgb: false, repeat: 1, key: 'net.alpha' });

    /* ---------------- plain materials ---------------- */
    // Break-up map for the polished metals. A mirror-sharp lobe on a 4 cm bar
    // produces sub-pixel specular aliasing - individual bars clipping to pure
    // white while their identical neighbours stay dark - and with MSAA off
    // there is nothing downstream to catch it. A roughness map with 0.3-0.55
    // variation makes the highlight travel and break along the bar instead.
    const rgh = makeCanvas(128, 128);
    paintPixels(rgh, (u, v, out) => {
      const g = lerp(0.30, 0.55, clamp01(fbm(u, v, 7, 3, 271) * 0.7 + fbm(u, v, 26, 2, 277) * 0.3));
      out[0] = out[1] = out[2] = g * 255;
    });
    const railRough = this._tex(rgh, { srgb: false, repeat: 3, key: 'metal.rail.rough' });

    this._metal('metal.white', 0xf1f3f4, 0.45, 0.25, { envMapIntensity: 0.9 });
    this._metal('metal.anodised', 0xc9d6dc, 0.30, 1.0, { envMapIntensity: 1.2 });
    /*
     * Coping.
     *
     * `roughness: 0.26` flat over 40 m of tube produced a pure Lambert-plus-
     * uniform-specular vertical gradient with literally zero surface incident
     * along its whole length - a plastic pipe. Real pool coping is cast steel:
     * mill-scale dull on the underside, mirror-polished in the 60-degree band
     * the trucks actually grind, and sectioned every 3-4 m at a weld.
     *
     * The tube's UVs run u along the length and v around the circumference, so
     * a 128x128 map with a v-banded polish profile and a u-periodic weld ring
     * lands all three of those in one texture. Warmed off blue-grey too: a
     * bronze-ish lip is the only warm accent in the park and it is what makes
     * every transition edge in the frame legible at 60 m.
     */
    /**
     * @param {boolean} lengthIsU true for TubeGeometry (u runs along the tube,
     *   v around it); false for CylinderGeometry, which is the transpose. The
     *   two coping meshes use different primitives, and a polish band authored
     *   for one renders as a spiral on the other - so both get their own bake.
     *   They are separate meshes already, so this costs no draw call.
     */
    const copingRoughCanvas = (lengthIsU) => {
      const c = makeCanvas(256, 256);
      paintPixels(c, (u, v, out) => {
        const along = lengthIsU ? u : v;
        const round = lengthIsU ? v : u;
        // Grind band: the top-outer 60 degrees, polished to a near-mirror.
        const polish = 1 - smoothstep(0.03, 0.19, Math.abs(round - 0.30));
        // Underside: mill scale, dirt, never touched.
        const under = smoothstep(0.60, 0.90, round);
        // Weld ring every quarter tile.
        const seg = (along * 4) % 1;
        const weld = 1 - smoothstep(0.0, 0.035, Math.min(seg, 1 - seg));
        let g = lerp(0.36, 0.13, polish);
        g = lerp(g, 0.64, under);
        g = lerp(g, 0.76, weld * 0.8);
        g += (fbm(u, v, 26, 3, 281) - 0.5) * 0.10;
        out[0] = out[1] = out[2] = clamp(g, 0.08, 0.92) * 255;
      });
      return c;
    };
    {
      const rt = this._tex(copingRoughCanvas(true), { srgb: false, repeat: 1, key: 'metal.coping.rough' });
      // 6 tiles over ~90 m of bowl rim puts a weld every ~3.7 m.
      rt.repeat.set(6, 1);
      this._metal('metal.coping', 0xd6c79b, 1.0, 1.0, {
        envMapIntensity: 1.25,
        roughnessMap: rt,
      });
      const rs = this._tex(copingRoughCanvas(false), { srgb: false, repeat: 1, key: 'metal.coping.rough.straight' });
      rs.repeat.set(1, 6);
      this._metal('metal.coping.straight', 0xd6c79b, 1.0, 1.0, {
        envMapIntensity: 1.25,
        roughnessMap: rs,
      });
    }
    // roughness stays at 1 because roughnessMap *multiplies* it; the 0.30-0.55
    // range lives in the map.
    this._siteShader(
      this._metal('metal.rail', 0xdfe6ea, 1.0, 1.0, {
        envMapIntensity: 1.1,
        roughnessMap: railRough,
      }),
      { specAA: true, desat: 0.7 }
    );
    this._metal('metal.bike', 0xffffff, 1.0, 0.85, {
      envMapIntensity: 1.0,
      roughnessMap: railRough,
      vertexColors: true,
    });
    this._metal('metal.dark', 0x3c444b, 0.6, 0.85, { envMapIntensity: 0.9 });
    // vertexColors: the bleacher seats and the pool lane ropes both tint per
    // instance, and without it every setColorAt() call below is a silent no-op.
    this._mat('plastic.seat', new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.48, metalness: 0.02, vertexColors: true, envMapIntensity: 0.6,
    }));
    this._mat('plastic.net', new THREE.MeshStandardMaterial({ color: 0x1c2126, roughness: 0.72, metalness: 0.05 }));
    this._mat('plastic.netTape', new THREE.MeshStandardMaterial({ color: 0xf6f8f8, roughness: 0.55, metalness: 0.02 }));
    this._mat(
      'glass.window',
      new THREE.MeshPhysicalMaterial({
        color: 0x9fc6d8,
        roughness: 0.06,
        metalness: 0,
        transmission: 0,
        opacity: 0.42,
        transparent: true,
        envMapIntensity: 1.8,
        side: THREE.DoubleSide,
      })
    );
    this._mat('paint.court', new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 }));
    /* ---------------- foliage ---------------- */
    // Flat-shaded untextured icosahedra were the loudest "low-poly toy" tell in
    // the world. Real canopies read as clumped leaf masses: dappled colour,
    // hard self-shadow pockets and a high-frequency normal. All three come from
    // an authored albedo/height pair applied over smooth-shaded blobs.
    await this._breathe();
    const fA = makeCanvas(512, 512);
    paintPixels(fA, (u, v, out) => {
      // Three scales of clumping: sprays, leaf clusters, individual leaves.
      // Kept deliberately low-contrast - a high-contrast mask on a smooth blob
      // reads as camouflage paint, not as depth. The shadow separation between
      // sprays comes from the normal map, which survives distance far better.
      const spray = fbm(u, v, 12, 3, 601);
      const clump = fbm(u, v, 38, 3, 607);
      const leaf = fbm(u, v, 140, 2, 613);
      const shade = clamp01(0.30 + spray * 0.40 + clump * 0.34 + leaf * 0.26);
      const gap = 0.66 + 0.34 * smoothstep(0.26, 0.62, spray * 0.55 + clump * 0.45);
      // Sun-bleached tips are yellower, shaded interior leaves bluer.
      const warm = leaf * 0.4 + clump * 0.22;
      out[0] = (52 + shade * 92 + warm * 62) * gap;
      out[1] = (64 + shade * 132 + warm * 34) * gap;
      out[2] = (30 + shade * 54) * gap;
    });
    const fH = makeCanvas(256, 256);
    paintPixels(fH, (u, v, out) => {
      const g = fbm(u, v, 38, 3, 607) * 130 + fbm(u, v, 120, 2, 613) * 125;
      out[0] = out[1] = out[2] = g;
    });
    // Alpha fringe. Solid blobs are the other half of the "low-poly toy" read:
    // a real canopy is porous, and the sky holes are what break the silhouette.
    // Alpha *test* rather than blending - no sort order, and three's depth
    // material honours alphaMap so the cast shadows get the holes too.
    const fAl = makeCanvas(512, 512);
    paintPixels(fAl, (u, v, out) => {
      const spray = fbm(u, v, 12, 3, 601);
      const clump = fbm(u, v, 38, 3, 607);
      const leaf = fbm(u, v, 96, 2, 613);
      // Genuinely porous. The old window (0.30..0.46 on a field that averages
      // 0.5) discarded almost nothing, so the "alpha-tested" canopy was in
      // practice a closed surface with a hard smooth outline - a green lollipop.
      // Pulling the window up to 0.46..0.60 and mixing in a third octave takes
      // ~35% of the surface out and lets sky through the canopy interior.
      const g = smoothstep(0.46, 0.60, spray * 0.40 + clump * 0.38 + leaf * 0.22) * 255;
      out[0] = out[1] = out[2] = g;
    });

    // The icosahedron's UVs span 0..1 over the whole lobe, so at repeat 1 a 6 m
    // canopy magnifies 512 px across ~19 m of surface and reads as blocks from
    // ten metres away. The noise tiles in both axes, so repeating is free.
    const REP = 4;
    this._pbr('foliage', fA, fH, null, {
      repeat: REP,
      roughness: 0.88,
      normalScale: 1.8,
      bump: 3.6,
      envMapIntensity: 0.9,
      side: THREE.DoubleSide,
    });
    this._pbr('foliage.dark', fA, fH, null, {
      repeat: REP,
      color: 0x7d9a6e,
      roughness: 0.94,
      normalScale: 1.5,
      bump: 3.2,
      envMapIntensity: 0.8,
      side: THREE.DoubleSide,
    });
    for (const key of ['foliage', 'foliage.dark']) {
      const m = this._materials.get(key);
      // Per-tree tint arrives as instanceColor, which the fragment stage only
      // reads when USE_COLOR is defined - hence vertexColors plus a real colour
      // attribute on every geometry that uses these materials.
      m.vertexColors = true;
      m.alphaMap = this._tex(fAl, { srgb: false, repeat: REP, key: `${key}.alpha` });
      m.alphaTest = 0.5;
      m.transparent = false;
      // MSAA 4x now lives on the composer's HDR target (PostFX MSAA_SAMPLES),
      // so the hardware can resolve an alpha-test edge across four subsamples.
      // Without this a porous canopy at 60-150 m dissolves into crawling
      // single-pixel sparkle every time the camera moves.
      m.alphaToCoverage = true;
      this._wrapLight(m);
    }
    // Reduce the probe's grip on the canopies so the wrap term below is what
    // actually lights the shadow side.
    this._materials.get('foliage').envMapIntensity = 0.55;
    this._materials.get('foliage.dark').envMapIntensity = 0.5;

    /* ---------------- alpha-cut leaf cards ---------------- */
    /*
     * The blobs above give a canopy its mass. What they cannot give it is a
     * silhouette: a displaced sphere still terminates on a smooth closed arc,
     * which from 30 m reads as broccoli no matter what the albedo does. Every
     * canopy therefore also gets a shell of alpha-tested quads sampled from a
     * 2x2 leaf-cluster atlas. Each cell has a radial cut so the quad's own
     * rectangle can never show, and the cluster shapes differ per cell so the
     * repeat is not legible.
     */
    const CARD = 512;
    const cardA = makeCanvas(CARD, CARD);
    const cardAl = makeCanvas(CARD, CARD);
    const cellShape = (u, v, cell) => {
      const cu = (u * 2) % 1;
      const cv = (v * 2) % 1;
      const dx = (cu - 0.5) * 2;
      // Cells 1 and 2 are elongated sprays; 0 and 3 are rounder clusters.
      const sy = cell === 1 ? 1.35 : cell === 2 ? 0.72 : 1.0;
      const dy = (cv - 0.5) * 2 * sy;
      const r = Math.hypot(dx, dy);
      const lobes = 1 + 0.22 * Math.sin(Math.atan2(dy, dx) * (3 + cell) + cell);
      // The outer stop is FIXED at 0.88, not scaled by `lobes`. Scaling both
      // stops let the mask stay non-zero past r = 1 on the lobed directions,
      // and r = 1 is exactly the cell edge - so the quad's own straight border
      // survived the alpha test and every card showed as a hard rectangle.
      return { cu, cv, mask: 1 - smoothstep(0.46 * lobes, 0.88, r) };
    };
    paintPixels(cardAl, (u, v, out) => {
      const cell = (u < 0.5 ? 0 : 1) + (v < 0.5 ? 0 : 2);
      const { cu, cv, mask } = cellShape(u, v, cell);
      const n = fbm(cu, cv, 9, 3, 641 + cell * 17);
      const fine = fbm(cu, cv, 30, 2, 659 + cell * 11);
      // Multiplying by `mask` guarantees zero at the cell border, so no card
      // ever shows a straight edge; the noise chews holes inside the cluster.
      const g = clamp01(mask * (0.42 + (n - 0.5) * 1.9 + (fine - 0.5) * 0.7)) * 255;
      out[0] = out[1] = out[2] = g;
    });
    paintPixels(cardA, (u, v, out) => {
      const cell = (u < 0.5 ? 0 : 1) + (v < 0.5 ? 0 : 2);
      const { cu, cv, mask } = cellShape(u, v, cell);
      const leaf = fbm(cu, cv, 46, 3, 667 + cell * 13);
      const spray = fbm(cu, cv, 11, 3, 641 + cell * 17);
      // Tips catch the sun and go yellower; the cluster core stays cool.
      const tip = clamp01((1 - mask) * 1.4 + leaf * 0.5);
      const shade = 0.46 + spray * 0.42 + leaf * 0.3;
      out[0] = (44 + shade * 96 + tip * 58);
      out[1] = (58 + shade * 140 + tip * 30);
      out[2] = (28 + shade * 56);
    });
    const cardHeight = makeCanvas(256, 256);
    paintPixels(cardHeight, (u, v, out) => {
      const g = fbm(u, v, 34, 3, 667) * 140 + fbm(u, v, 110, 2, 671) * 110;
      out[0] = out[1] = out[2] = g;
    });
    /*
     * The leaf mask needs the same coverage-preserving mip chain as the fence.
     *
     * A box-filtered mask over a ~45%-opaque leaf cluster climbs above a 0.46
     * alpha test by mip 2-3, at which point the whole 512 cell passes and every
     * card in a canopy renders as its own hard RECTANGLE - the black quads
     * visible in the treeline. Rebuilding the chain so each level preserves the
     * mip-0 coverage ratio keeps the cluster porous at every distance.
     * One texture, shared by both foliage tints.
     */
    const cardAlphaTex = this._registerTex('foliage.card.alpha', makeCoverageMips(cardAl, 0.46));
    cardAlphaTex.wrapS = cardAlphaTex.wrapT = THREE.ClampToEdgeWrapping;
    for (const [key, tint, env] of [['foliage.card', 0xffffff, 0.55], ['foliage.card.dark', 0x86a276, 0.48]]) {
      this._pbr(key, cardA, cardHeight, null, {
        repeat: 1,
        color: tint,
        roughness: 0.9,
        normalScale: 1.1,
        bump: 2.4,
        envMapIntensity: env,
        side: THREE.DoubleSide,
      });
      const m = this._materials.get(key);
      m.map.wrapS = m.map.wrapT = THREE.ClampToEdgeWrapping;
      m.normalMap.wrapS = m.normalMap.wrapT = THREE.RepeatWrapping;
      m.normalMap.repeat.set(3, 3);
      m.alphaMap = cardAlphaTex;
      m.alphaTest = 0.46;
      m.transparent = false;
      m.vertexColors = true;
      m.alphaToCoverage = true;
      this._wrapLight(m);
    }

    /* ---------------- grass blade cards ---------------- */
    // A tiling albedo alone cannot make a lawn read as grass at three metres -
    // there is no geometry breaking the plane and no self-shadow. These cards
    // are what stop the foreground third of every wide shot reading as a green
    // sheet with one bollard on it.
    const BLW = 256;
    await this._breathe();
    const bl = makeCanvas(BLW, BLW);
    const blCtx = bl.getContext('2d');
    blCtx.fillStyle = '#000000';
    blCtx.fillRect(0, 0, BLW, BLW);
    const blAlbedo = makeCanvas(BLW, BLW);
    const baCtx = blAlbedo.getContext('2d');
    baCtx.fillStyle = '#2c3a1c';
    baCtx.fillRect(0, 0, BLW, BLW);
    {
      const brng = makeRng(9091);
      for (let i = 0; i < 46; i++) {
        const x0 = 8 + brng() * (BLW - 16);
        const h = BLW * (0.45 + brng() * 0.5);
        const lean = (brng() - 0.5) * 46;
        const w = 3.4 + brng() * 4.2;
        const shade = 0.5 + brng() * 0.5;
        const draw = (ctx, style) => {
          ctx.fillStyle = style;
          ctx.beginPath();
          ctx.moveTo(x0 - w / 2, BLW);
          ctx.quadraticCurveTo(x0 - w / 4 + lean * 0.4, BLW - h * 0.55, x0 + lean, BLW - h);
          ctx.quadraticCurveTo(x0 + w / 4 + lean * 0.4, BLW - h * 0.55, x0 + w / 2, BLW);
          ctx.closePath();
          ctx.fill();
        };
        draw(blCtx, '#ffffff');
        // Tips are yellower and lighter, bases sit in their own shade.
        const g = baCtx.createLinearGradient(0, BLW, 0, BLW - h);
        g.addColorStop(0, `rgba(${52 * shade + 34},${70 * shade + 44},${28 * shade + 20},1)`);
        // Tip stop pulled off yellow to match the retuned turf albedo - a
        // (194,214,90) tip against a (70,112,48) sward reads as straw.
        g.addColorStop(1, `rgba(${96 * shade + 54},${146 * shade + 58},${58 * shade + 24},1)`);
        draw(baCtx, g);
      }
    }
    const bladeAlpha = this._tex(bl, { srgb: false, repeat: 1, key: 'grass.blade.alpha' });
    bladeAlpha.wrapS = bladeAlpha.wrapT = THREE.ClampToEdgeWrapping;
    this._mat(
      'grass.card',
      new THREE.MeshStandardMaterial({
        map: this._tex(blAlbedo, { srgb: true, repeat: 1, key: 'grass.blade.map' }),
        alphaMap: bladeAlpha,
        alphaTest: 0.4,
        transparent: false,
        roughness: 1,
        envMapIntensity: 0.4,
        side: THREE.DoubleSide,
        vertexColors: true,
      })
    );
    this._materials.get('grass.card').map.wrapS = THREE.ClampToEdgeWrapping;
    this._materials.get('grass.card').map.wrapT = THREE.ClampToEdgeWrapping;
    this._materials.get('grass.card').alphaToCoverage = true;
    this._wrapLight(this._materials.get('grass.card'));

    await this._breathe();
    const barkA = makeCanvas(256, 512);
    paintPixels(barkA, (u, v, out) => {
      // Vertical fissures: a stretched noise ridged with an abs() fold.
      const ridge = Math.abs(fbm(u * 3.0, v * 0.35, 24, 3, 619) - 0.5) * 2;
      const fine = fbm(u * 2, v * 0.5, 90, 2, 623);
      const g = 34 + (1 - ridge) * 58 + fine * 30;
      out[0] = g * 1.16;
      out[1] = g * 0.98;
      out[2] = g * 0.78;
    });
    const barkH = makeCanvas(256, 512);
    paintPixels(barkH, (u, v, out) => {
      const ridge = Math.abs(fbm(u * 3.0, v * 0.35, 24, 3, 619) - 0.5) * 2;
      const g = (1 - ridge) * 190 + fbm(u * 2, v * 0.5, 90, 2, 623) * 60;
      out[0] = out[1] = out[2] = g;
    });
    this._pbr('bark', barkA, barkH, null, { repeat: 2, repeatY: 1, roughness: 0.95, normalScale: 1.4, bump: 3.4, envMapIntensity: 0.4 });
    this._mat('carPaint', new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.24, metalness: 0.55, envMapIntensity: 1.2, vertexColors: true,
    }));
    this._mat('rubber.dark', new THREE.MeshStandardMaterial({ color: 0x15181b, roughness: 0.9 }));
    this._mat(
      'snow.plain',
      new THREE.MeshStandardMaterial({ color: 0xcfd9e6, roughness: 0.6, envMapIntensity: 1.1 })
    );
    // Rock and scree used to be untextured flat colours - an automatic fail at
    // the top of a 50 m landform. They borrow the gravel albedo/normal pair,
    // which is the right aggregate scale for broken stone.
    const gravelMat = this._materials.get('path.gravel');
    this._mat(
      'rock.outcrop',
      new THREE.MeshStandardMaterial({
        map: gravelMat.map,
        normalMap: gravelMat.normalMap,
        // 2.4 to compensate for the gravel height field's amplitude coming
        // down: broken stone at 50 m wants a stronger normal than a footpath.
        normalScale: new THREE.Vector2(2.4, 2.4),
        color: 0x5c5750,
        roughness: 0.95,
        envMapIntensity: 0.35,
        flatShading: true,
      })
    );
    this._mat(
      'scree',
      new THREE.MeshStandardMaterial({
        map: gravelMat.map,
        normalMap: gravelMat.normalMap,
        color: 0x8d8478,
        roughness: 1,
        envMapIntensity: 0.35,
        flatShading: true,
      })
    );
    this._mat(
      'net.safety',
      new THREE.MeshStandardMaterial({
        color: 0xff8a2b,
        alphaMap: netAlpha,
        alphaTest: 0.42,
        roughness: 0.8,
        side: THREE.DoubleSide,
      })
    );

    /* ---------------- pool water ---------------- */
    this._mat('water.pool', this._makeWaterMaterial());
  }

  /**
   * Court surfaces are drawn 1:1 into a canvas that maps onto the slab, so the
   * line work is dimensionally correct rather than "roughly tennis shaped".
   */
  async _buildCourtTextures() {
    /*
     * Textured acrylic.
     *
     * A real cushioned court is silica-loaded paint squeegeed on in overlapping
     * passes over asphalt: it has sand grain you can see from two metres, broad
     * patchiness where the mix was thicker, visible lap bands along the roll
     * direction, and a strong grazing-angle sheen that a constant roughness
     * cannot produce. The previous version was a flat RGB fill with a normal map
     * doing nothing visible, which is why it read as vertex colour.
     */
    const acrylic = (canvas, base, seed) => {
      paintPixels(canvas, (u, v, out) => {
        const sand = fbm(u, v, 120, 3, seed) - 0.5;      // aggregate speckle
        const patch = fbm(u, v, 4, 3, seed + 7) - 0.5;   // broad mix variation
        const drift = fbm(u, v, 13, 2, seed + 19) - 0.5; // mid-scale mottle
        // Squeegee lap bands, ~2% either side of unity along the roll direction.
        const lap = 0.98 + 0.02 * Math.sin(v * Math.PI * 2 * 6 + patch * 3.0);
        // Sun fade: the end nearest the open side bleaches a few percent.
        const fade = lerp(0.965, 1.02, v);
        for (let c = 0; c < 3; c++) {
          out[c] = clamp((base[c] + sand * 14 + patch * 10 + drift * 6) * lap * fade, 0, 255);
        }
      });
      return canvas.getContext('2d');
    };

    /** Feathered rect fill - paint boundaries are never one texel hard. */
    const softRect = (ctx, colour, x, y, w, h) => {
      ctx.fillStyle = colour;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = colour;
      for (const [lw, a] of [[3, 0.55], [5, 0.28], [7, 0.12]]) {
        ctx.globalAlpha = a;
        ctx.lineWidth = lw;
        ctx.strokeRect(x, y, w, h);
      }
      ctx.globalAlpha = 1;
    };

    /** Third-octave roughness so the acrylic has an anisotropic grazing sheen. */
    const acrylicRough = (seed) => {
      const c = makeCanvas(256, 256);
      paintPixels(c, (u, v, out) => {
        const broad = fbm(u, v, 5, 3, seed + 31);
        const lap = 0.5 + 0.5 * Math.sin(v * Math.PI * 2 * 6);
        // 0.35 (polished lap crown) .. 0.62 (dull sand-loaded trough).
        const r = lerp(0.35, 0.62, clamp01(broad * 0.72 + lap * 0.28));
        out[0] = out[1] = out[2] = r * 255;
      });
      return c;
    };

    /**
     * Wear pass over a finished court.
     *
     * A cushioned acrylic court that has been played on is not a vector
     * drawing: it is resurfaced in patches that never quite match, bleached
     * pale along the baselines and behind the service boxes where the feet go,
     * cut through by expansion joints on a ~3.5 m grid, and its line paint is
     * chipped rather than laser-crisp. Both hero frames read the courts as a
     * material preview precisely because none of that was present.
     *
     * @param {CanvasRenderingContext2D} ctx finished court canvas.
     * @param {number} w canvas width, px.
     * @param {number} h canvas height, px.
     * @param {number} seed
     * @param {Array<[number,number,number,number]>} spots play-wear ellipses [cx,cy,rx,ry] in px.
     * @param {number} seamPx expansion-joint pitch in px.
     */
    const courtWear = (ctx, w, h, seed, spots, seamPx) => {
      const wr = makeRng(seed);
      ctx.save();
      // (a) Resurfacing patches: broad, soft, +/-5% value, no two the same.
      for (let i = 0; i < 12; i++) {
        const x = wr() * w;
        const y = wr() * h;
        const r = Math.max(w, h) * (0.10 + wr() * 0.22);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, wr() > 0.5 ? 'rgba(255,255,255,0.055)' : 'rgba(0,0,0,0.05)');
        g.addColorStop(0.7, wr() > 0.5 ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.018)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(wr() * Math.PI);
        ctx.scale(1, 0.45 + wr() * 0.8);
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      // (b) Play wear: paler and shinier where the shoes land.
      for (const [x, y, rx, ry] of spots) {
        const rr = Math.max(rx, ry);
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rr);
        g.addColorStop(0, 'rgba(255,252,244,0.10)');
        g.addColorStop(0.6, 'rgba(255,252,244,0.04)');
        g.addColorStop(1, 'rgba(255,252,244,0)');
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(rx / rr, ry / rr);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, rr, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      // (c) Expansion joints. A slight wobble keeps them off the pixel grid.
      ctx.strokeStyle = 'rgba(18,24,22,0.22)';
      ctx.lineWidth = Math.max(1, seamPx * 0.055);
      for (let x = seamPx; x < w; x += seamPx) {
        ctx.beginPath();
        for (let y = 0; y <= h; y += 24) ctx.lineTo(x + Math.sin(y * 0.01 + x) * 1.2, y);
        ctx.stroke();
      }
      for (let y = seamPx; y < h; y += seamPx) {
        ctx.beginPath();
        for (let x = 0; x <= w; x += 24) ctx.lineTo(x, y + Math.sin(x * 0.011 + y) * 1.2);
        ctx.stroke();
      }
      // (d) Scuffs and chipped paint. Drawn over everything, so line work loses
      // 1-2% of its coverage and stops looking freshly masked.
      for (let i = 0; i < 340; i++) {
        const x = wr() * w;
        const y = wr() * h;
        ctx.fillStyle = wr() > 0.62 ? 'rgba(24,30,28,0.13)' : 'rgba(210,216,208,0.10)';
        ctx.beginPath();
        ctx.ellipse(x, y, 1.2 + wr() * 5.5, 0.8 + wr() * 2.6, wr() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    };

    /* ---- tennis: 23.77 x 10.97 doubles, on an 18.3 x 36.6 slab ---- */
    await this._breathe();
    const TW = 512;
    const TH = 1024;
    const tenA = makeCanvas(TW, TH);
    const t = acrylic(tenA, [42, 118, 92], 131);
    const pxX = TW / 18.3;
    const pxZ = TH / 36.6;
    const cxp = TW / 2;
    const czp = TH / 2;
    // Inner playing rectangle in a different acrylic shade, feathered so the
    // paint transition is not a single-texel razor.
    softRect(t, '#2f6ea8', cxp - 6.4 * pxX, czp - 15.5 * pxZ, 12.8 * pxX, 31 * pxZ);
    // Re-lay the grain over the flat fill so the inner rectangle is not a solid
    // colour block sitting inside a textured apron.
    {
      const img = t.getImageData(0, 0, TW, TH);
      const d = img.data;
      for (let y = 0; y < TH; y++) {
        for (let x = 0; x < TW; x++) {
          const u = x / TW;
          const v = y / TH;
          const sand = fbm(u, v, 120, 3, 131) - 0.5;
          const patch = fbm(u, v, 4, 3, 138) - 0.5;
          const lap = 0.985 + 0.015 * Math.sin(v * Math.PI * 2 * 6 + patch * 3);
          const i = (y * TW + x) * 4;
          for (let c = 0; c < 3; c++) {
            d[i + c] = clamp((d[i + c] + sand * 13 + patch * 9) * lap, 0, 255);
          }
        }
      }
      t.putImageData(img, 0, 0);
    }
    t.strokeStyle = '#f7f9f8';
    t.lineJoin = 'miter';
    const line = (x0, z0, x1, z1, w = 0.05) => {
      t.lineWidth = w * pxX;
      t.beginPath();
      t.moveTo(cxp + x0 * pxX, czp + z0 * pxZ);
      t.lineTo(cxp + x1 * pxX, czp + z1 * pxZ);
      t.stroke();
    };
    const HW = 10.97 / 2;
    const HS = 8.23 / 2;
    const HL = 23.77 / 2;
    line(-HW, -HL, HW, -HL, 0.1);
    line(-HW, HL, HW, HL, 0.1);
    line(-HW, -HL, -HW, HL, 0.05);
    line(HW, -HL, HW, HL, 0.05);
    line(-HS, -HL, -HS, HL, 0.05);
    line(HS, -HL, HS, HL, 0.05);
    line(-HS, -6.4, HS, -6.4, 0.05);
    line(-HS, 6.4, HS, 6.4, 0.05);
    line(0, -6.4, 0, 6.4, 0.05);
    line(0, -HL, 0, -HL + 0.1, 0.1);
    line(0, HL - 0.1, 0, HL, 0.1);
    courtWear(
      t, TW, TH, 5501,
      [
        // Baseline shuffle bands and the service-box landing zones.
        [cxp, czp - HL * pxZ + 0.9 * pxZ, 5.2 * pxX, 1.4 * pxZ],
        [cxp, czp + HL * pxZ - 0.9 * pxZ, 5.2 * pxX, 1.4 * pxZ],
        [cxp - 2.2 * pxX, czp - 4.4 * pxZ, 2.0 * pxX, 1.6 * pxZ],
        [cxp + 2.2 * pxX, czp - 4.4 * pxZ, 2.0 * pxX, 1.6 * pxZ],
        [cxp - 2.2 * pxX, czp + 4.4 * pxZ, 2.0 * pxX, 1.6 * pxZ],
        [cxp + 2.2 * pxX, czp + 4.4 * pxZ, 2.0 * pxX, 1.6 * pxZ],
      ],
      3.5 * pxX
    );
    const tenH = makeCanvas(256, 256);
    paintPixels(tenH, (u, v, out) => {
      const g = fbm(u, v, 72, 3, 131) * 255;
      out[0] = out[1] = out[2] = g;
    });
    this._pbr('court.tennis', tenA, tenH, acrylicRough(131), {
      repeat: 1,
      roughness: 1,
      normalScale: 0.5,
      bump: 1.1,
      clamp: true,
      envMapIntensity: 0.85,
    });
    {
      const m = this._materials.get('court.tennis');
      m.normalMap.wrapS = m.normalMap.wrapT = THREE.RepeatWrapping;
      // 6x12, not 18x36. One normal tile per metre against a 1.4 cm height
      // lattice put every feature below a screen pixel from 15 m out, and the
      // acrylic read as a layer of dirty static in every court shot.
      m.normalMap.repeat.set(6, 12);
      m.roughnessMap.wrapS = m.roughnessMap.wrapT = THREE.RepeatWrapping;
      m.roughnessMap.repeat.set(6, 12);
      this._flattenFar(m, 60, { clouds: 0.55, desat: 0.85 });
    }

    /* ---- pickleball: 13.41 x 6.10 on an 18.3 x 9.14 slab ---- */
    await this._breathe();
    const PW = 1024;
    const PH = 512;
    const picA = makeCanvas(PW, PH);
    const p = acrylic(picA, [150, 66, 46], 137);
    const ppX = PW / 18.3;
    const ppZ = PH / 9.14;
    const pcx = PW / 2;
    const pcz = PH / 2;
    softRect(p, '#1f6f8b', pcx - 7.6 * ppX, pcz - 3.7 * ppZ, 15.2 * ppX, 7.4 * ppZ);
    {
      const img = p.getImageData(0, 0, PW, PH);
      const d = img.data;
      for (let y = 0; y < PH; y++) {
        for (let x = 0; x < PW; x++) {
          const u = x / PW;
          const v = y / PH;
          const sand = fbm(u, v, 120, 3, 137) - 0.5;
          const patch = fbm(u, v, 4, 3, 144) - 0.5;
          const lap = 0.985 + 0.015 * Math.sin(u * Math.PI * 2 * 6 + patch * 3);
          const i = (y * PW + x) * 4;
          for (let c = 0; c < 3; c++) {
            d[i + c] = clamp((d[i + c] + sand * 13 + patch * 9) * lap, 0, 255);
          }
        }
      }
      p.putImageData(img, 0, 0);
    }
    p.strokeStyle = '#f7f9f8';
    const pline = (x0, z0, x1, z1, w = 0.05) => {
      p.lineWidth = w * ppX;
      p.beginPath();
      p.moveTo(pcx + x0 * ppX, pcz + z0 * ppZ);
      p.lineTo(pcx + x1 * ppX, pcz + z1 * ppZ);
      p.stroke();
    };
    const PL = 13.41 / 2;
    const PWd = 6.1 / 2;
    pline(-PL, -PWd, PL, -PWd, 0.05);
    pline(-PL, PWd, PL, PWd, 0.05);
    pline(-PL, -PWd, -PL, PWd, 0.05);
    pline(PL, -PWd, PL, PWd, 0.05);
    pline(-2.13, -PWd, -2.13, PWd, 0.05); // non-volley (kitchen) lines
    pline(2.13, -PWd, 2.13, PWd, 0.05);
    pline(-PL, 0, -2.13, 0, 0.05); // centre service lines
    pline(2.13, 0, PL, 0, 0.05);
    courtWear(
      p, PW, PH, 5507,
      [
        [pcx - PL * ppX + 0.8 * ppX, pcz, 1.3 * ppX, 2.6 * ppZ],
        [pcx + PL * ppX - 0.8 * ppX, pcz, 1.3 * ppX, 2.6 * ppZ],
        [pcx - 2.9 * ppX, pcz - 1.5 * ppZ, 1.5 * ppX, 1.2 * ppZ],
        [pcx + 2.9 * ppX, pcz + 1.5 * ppZ, 1.5 * ppX, 1.2 * ppZ],
      ],
      3.5 * ppX
    );
    this._pbr('court.pickle', picA, tenH, acrylicRough(137), {
      repeat: 1,
      roughness: 1,
      normalScale: 0.5,
      bump: 1.1,
      clamp: true,
      envMapIntensity: 0.85,
    });
    {
      const m = this._materials.get('court.pickle');
      m.normalMap.wrapS = m.normalMap.wrapT = THREE.RepeatWrapping;
      m.normalMap.repeat.set(6, 3);
      m.roughnessMap.wrapS = m.roughnessMap.wrapT = THREE.RepeatWrapping;
      m.roughnessMap.repeat.set(6, 3);
      this._flattenFar(m, 60, { clouds: 0.55, desat: 0.85 });
    }
  }

  /**
   * Pool surface: layered gerstner-ish ripples give the normal, a depth-tinted
   * body colour gives the volume, and a moving caustic band under the surface
   * sells refraction without a second render pass.
   */
  _makeWaterMaterial() {
    return new THREE.ShaderMaterial({
      fog: true,
      transparent: true,
      uniforms: {
        uTime: { value: 0 },
        uShallow: { value: new THREE.Color(0x39d3d0) },
        uDeep: { value: new THREE.Color(0x0a5f86) },
        uSky: { value: new THREE.Color(0xbfe0f7) },
        uSun: { value: this.environment.sunDirection.clone() },
        fogColor: { value: this.environment.fogColor.clone() },
        fogNear: { value: this.environment.fogNear },
        fogFar: { value: this.environment.fogFar },
        // The scene runs FogExp2 while this world is up; the fog chunk then
        // wants `fogDensity` instead of near/far. Declaring both keeps the
        // material correct whichever fog is bound.
        fogDensity: { value: this._fog.density },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        varying vec3 vView;
        #include <fog_pars_vertex>
        void main() {
          vec4 worldPos = modelMatrix * vec4( position, 1.0 );
          vWorld = worldPos.xyz;
          vec4 mvPosition = viewMatrix * worldPos;
          vView = -mvPosition.xyz;
          #include <fog_vertex>
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vWorld;
        varying vec3 vView;
        uniform float uTime;
        uniform vec3 uShallow, uDeep, uSky, uSun;
        #include <fog_pars_fragment>

        float wave( vec2 p, vec2 dir, float freq, float speed ) {
          return sin( dot( p, dir ) * freq + uTime * speed );
        }

        void main() {
          vec2 p = vWorld.xz;
          // Four crossing wave trains, smallest last, build the surface normal.
          float h = 0.0;
          h += wave( p, normalize( vec2( 1.0, 0.35 ) ), 1.6, 1.5 ) * 0.030;
          h += wave( p, normalize( vec2( -0.4, 1.0 ) ), 2.7, 1.9 ) * 0.018;
          h += wave( p, normalize( vec2( 0.8, -0.7 ) ), 5.3, 2.7 ) * 0.008;
          h += wave( p, normalize( vec2( -1.0, -0.2 ) ), 9.1, 3.4 ) * 0.004;

          vec2 e = vec2( 0.06, 0.0 );
          float hx = 0.0, hz = 0.0;
          hx += wave( p + e.xy, normalize( vec2( 1.0, 0.35 ) ), 1.6, 1.5 ) * 0.030;
          hx += wave( p + e.xy, normalize( vec2( -0.4, 1.0 ) ), 2.7, 1.9 ) * 0.018;
          hx += wave( p + e.xy, normalize( vec2( 0.8, -0.7 ) ), 5.3, 2.7 ) * 0.008;
          hz += wave( p + e.yx, normalize( vec2( 1.0, 0.35 ) ), 1.6, 1.5 ) * 0.030;
          hz += wave( p + e.yx, normalize( vec2( -0.4, 1.0 ) ), 2.7, 1.9 ) * 0.018;
          hz += wave( p + e.yx, normalize( vec2( 0.8, -0.7 ) ), 5.3, 2.7 ) * 0.008;
          vec3 n = normalize( vec3( ( h - hx ) / e.x, 1.0, ( h - hz ) / e.x ) );

          vec3 v = normalize( vView );
          float fres = pow( 1.0 - clamp( dot( n, v ), 0.0, 1.0 ), 4.0 );

          // Fake caustics: interfering ripples projected onto the tiled floor.
          float c = wave( p * 1.9, normalize( vec2( 1.0, 0.6 ) ), 3.1, 1.1 )
                  * wave( p * 1.9, normalize( vec2( -0.6, 1.0 ) ), 3.7, -1.3 );
          c = pow( max( c, 0.0 ), 3.0 );

          vec3 body = mix( uShallow, uDeep, smoothstep( 30.0, 58.0, vWorld.x ) );
          body += c * 0.55;

          vec3 col = mix( body, uSky, fres * 0.85 );
          // Exponent 90, not 220. A 220-power lobe on a wave field this fine is
          // narrower than a pixel: the sun band across the lanes resolved as a
          // strip of grey grit rather than as a glitter path, because whether
          // any given pixel caught the lobe was pure sampling luck. A broader,
          // dimmer lobe covers several pixels and reads as water.
          float spec = pow( max( dot( reflect( -uSun, n ), v ), 0.0 ), 90.0 );
          col += spec * 1.15;

          gl_FragColor = vec4( col, 0.86 + fres * 0.14 );
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }
      `,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Sky + image-based lighting                                        */
  /* ---------------------------------------------------------------- */

  async _buildSky() {
    // 2048x1024 on a 1200 m sphere is ~0.17 deg per texel. At the old 1024x512
    // it was 0.35 deg, which is coarse enough that the zenith gradient banded
    // visibly across the top of every wide shot.
    const W = 2048;
    const H = 1024;
    /*
     * The halo is painted ANALYTICALLY, per texel, from the angle between that
     * texel's spherical direction and the sun.
     *
     * It used to be a 1824 px `fillRect` of a radial gradient on a 2048x1024
     * canvas. Whenever the sun sat near u=0 or high in the sky (it always does
     * here) the rect was clipped by the canvas boundary, and because wrapS is
     * RepeatWrapping that clip became a hard straight great-circle line across
     * the sky in every wide shot - the diagonal seam through the top-left of
     * both hero frames. Computing it from the direction vector is wrap-correct
     * and pole-correct by construction and cannot produce an edge.
     */
    const sdir = this.environment.sunDirection;
    const c = makeCanvas(W, H);
    await paintPixelsAsync(c, (u, v, out, px, py) => {
      // v = 0 at the zenith. Deep zenith into a warm haze band at the horizon:
      // the old version topped out at 196/216/236, which is within a few
      // percent of sunlit snow and made the ski hill silhouette disappear.
      const t = clamp01(v * 2);
      const r = lerp(38, 186, Math.pow(t, 1.45));
      const g = lerp(96, 206, Math.pow(t, 1.25));
      const b = lerp(196, 228, Math.pow(t, 0.9));
      // Ordered dither at +/-1.5/255. A smooth 8-bit gradient over 90 degrees of
      // sky cannot avoid Mach banding; breaking the quantisation with a
      // sub-LSB ordered pattern removes it for free and survives mipping.
      const d = (((px & 3) * 4 + ((py & 3) ^ ((px & 3) * 2))) / 16 - 0.5) * 3.0;

      // Equirect texel -> direction, matching SphereGeometry's own convention
      // (x = -cos(2*PI*u), z = sin(2*PI*u), y = cos(PI*v)).
      const sp = Math.sin(Math.PI * v);
      const dy = Math.cos(Math.PI * v);
      const dx = -Math.cos(2 * Math.PI * u) * sp;
      const dz = Math.sin(2 * Math.PI * u) * sp;
      const ang =
        Math.acos(clamp(dx * sdir.x + dy * sdir.y + dz * sdir.z, -1, 1)) * (180 / Math.PI);
      // Four exponential lobes: the disc, the aureole, the circumsolar glow and
      // the broad forward-scattered wash. Nothing here can clip on a canvas
      // edge because it is a function of angle, not of pixel position.
      const glow = Math.min(
        1,
        0.97 * Math.exp(-ang / 0.75) +
          0.52 * Math.exp(-ang / 3.4) +
          0.17 * Math.exp(-ang / 14.0) +
          0.07 * Math.exp(-ang / 46.0)
      );

      out[0] = lerp(r + d, 255, glow);
      out[1] = lerp(g + d, 250, glow * 0.97);
      out[2] = lerp(b + d, 226, glow * 0.88);
    }, () => this._breathe());
    const ctx = c.getContext('2d');

    // Where the sun landed in canvas space - still needed so cumulus can be
    // lit from the correct side. The halo itself is no longer drawn here.
    const sd = this.environment.sunDirection;
    const sunU = ((Math.atan2(sd.z, -sd.x) / (Math.PI * 2)) + 1) % 1;
    const sx = sunU * W;

    // High cirrus band first, so cumulus reads in front of it.
    const cr = makeRng(2024);
    for (let i = 0; i < 90; i++) {
      const x = cr() * W;
      const y = 0.03 * H + Math.pow(cr(), 1.8) * 0.16 * H;
      const len = (90 + cr() * 260) * 2;
      const a = 0.06 + cr() * 0.16;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate((cr() - 0.5) * 0.5);
      const g = ctx.createLinearGradient(-len / 2, 0, len / 2, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.5, `rgba(255,255,255,${a})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(-len / 2, (-3 - cr() * 5) * 2, len, (6 + cr() * 9) * 2);
      ctx.restore();
    }

    // Fair-weather cumulus with modelled undersides. The originals were drawn
    // at alpha 0.1-0.5 as pure white, which washed the sky to a flat value and
    // gave the bloom nothing legitimate to work with.
    // Deliberately sparse: 120 overlapping cells washed the whole dome to a
    // single value, which is what left the sky with no information in it.
    // Count up, size capped. A cell at the old 26+66 ceiling subtended nearly a
    // quarter of the frame and resolved as one out-of-focus white smear with a
    // blown core; capping at ~48 px (about 8 degrees) and doubling the count
    // keeps the same sky coverage with actual internal structure.
    for (let i = 0; i < 110; i++) {
      const u = cr();
      const vv = 0.11 + Math.pow(cr(), 1.5) * 0.34;
      const size = Math.min(48, 22 + cr() * 40) * (1 - vv * 0.5) * 2;
      const x = u * W;
      const y = vv * H;
      const alpha = 0.58 + cr() * 0.34;
      /*
       * Directional cloud form.
       *
       * The previous version scattered its lit lobes with a symmetric random
       * offset, so every cloud was lit identically from every side and read as
       * a soft white blob. Real cumulus has ONE lit flank facing the sun, a
       * dark anti-sun flank, and a flat, warm-bounced base at the condensation
       * level. `sunSide` is the shortest signed direction round the equirect
       * seam toward the sun, and every pass below is biased along it.
       */
      let dxs = sx - x;
      if (dxs > W / 2) dxs -= W;
      if (dxs < -W / 2) dxs += W;
      const sunSide = dxs >= 0 ? 1 : -1;
      // Flat base: cumulus condense at one altitude, so their undersides are a
      // straight line. Clipping the shaded pass to a half-plane is what turns a
      // circle into a cloud.
      const baseY = y + size * 0.30;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x - size * 2.6, y - size * 1.8, size * 5.2, baseY - (y - size * 1.8));
      ctx.clip();
      // Shaded flank + underside, pushed AWAY from the sun.
      for (let k = 0; k < 5; k++) {
        const ox = (-sunSide * (0.15 + cr() * 0.75) + (cr() - 0.5) * 0.3) * size;
        const oy = (0.06 + cr() * 0.30) * size;
        const rr = size * (0.30 + cr() * 0.42);
        const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, rr);
        // Warm bounce off the ground on the underside, cool shadow above it.
        g.addColorStop(0, `rgba(132,146,172,${alpha * 0.62})`);
        g.addColorStop(0.55, `rgba(184,180,178,${alpha * 0.34})`);
        g.addColorStop(1, 'rgba(198,196,192,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x + ox, y + oy, rr, 0, Math.PI * 2);
        ctx.fill();
      }
      // Sunlit crown, pushed TOWARD the sun and up.
      for (let k = 0; k < 6; k++) {
        const ox = (sunSide * (0.10 + cr() * 0.70) + (cr() - 0.5) * 0.28) * size;
        const oy = -(0.05 + cr() * 0.34) * size;
        const rr = size * (0.26 + cr() * 0.40);
        const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, rr);
        g.addColorStop(0, `rgba(255,253,246,${alpha})`);
        g.addColorStop(0.5, `rgba(246,248,252,${alpha * 0.55})`);
        g.addColorStop(1, 'rgba(226,236,250,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x + ox, y + oy, rr, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      // A thin warm lip right on the flat base sells the altitude line.
      const lip = ctx.createLinearGradient(0, baseY - size * 0.18, 0, baseY);
      lip.addColorStop(0, `rgba(216,207,196,${alpha * 0.30})`);
      lip.addColorStop(1, 'rgba(216,207,196,0)');
      ctx.fillStyle = lip;
      ctx.fillRect(x - size * 1.1, baseY - size * 0.18, size * 2.2, size * 0.18);
    }

    const tex = this._tex(c, { srgb: true, key: 'sky' });
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    const skyMat = this._mat(
      'sky',
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false })
    );
    const sky = new THREE.Mesh(new THREE.SphereGeometry(1200, 48, 24), skyMat);
    sky.renderOrder = -100;
    sky.frustumCulled = false;
    sky.matrixAutoUpdate = false;
    sky.updateMatrix();

    // Bake an irradiance/reflection probe from the sky so metal, snow, water
    // and glass have something to reflect. Without this every metal reads black.
    try {
      const pmrem = new THREE.PMREMGenerator(this.engine.renderer);
      const envScene = new THREE.Scene();
      const groundDisc = new THREE.Mesh(
        new THREE.SphereGeometry(1190, 24, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x6c7a4c, side: THREE.BackSide, fog: false })
      );
      envScene.add(sky, groundDisc);
      this._envRT = pmrem.fromScene(envScene, 0.02, 1, 2000);
      this.environment.envMap = this._envRT.texture;
      envScene.remove(sky);
      groundDisc.geometry.dispose();
      groundDisc.material.dispose();
      pmrem.dispose();
    } catch (err) {
      console.warn('[SportsWorld] environment probe unavailable:', err?.message ?? err);
    }

    this._add(sky, false, false);
  }

  /* ---------------------------------------------------------------- */
  /* Ground, paths and the site boundary                               */
  /* ---------------------------------------------------------------- */

  _buildGround() {
    const S = 400;

    // The site is a displaced heightfield, not a table. Built pads are levelled
    // and feathered by parkHeight(), so every facility sits in a cut-and-fill
    // terrace with a visible bank instead of floating on a green sheet.
    const grassY = (x, z) => parkHeight(x, z) - 0.06;
    // The skate pad and the pool both cut *below* the lawn plane. Without these
    // holes the ground sheet is drawn straight across them and the bowl, half
    // pipe, snake run and swimming basin are all invisible from outside - and
    // from inside the bowl the player is under a 520 m green ceiling.
    const grass = this._heightMesh(
      grassY, -260, -260, 260, 260, 2.6, this._materials.get('grass.field'), 1 / 12, null,
      [
        [PAD.x0, PAD.z0, PAD.x1, PAD.z1],
        [POOL.x0, POOL.z0, POOL.x1, POOL.z1],
      ],
      true // arc-length UVs: the 6 m grass tile stops compressing on the hills
    );
    // Remap the overlay UVs onto the FULL +/-260 m terrain extent. Mapping them
    // to +/-200 m left the outer 60 m ring - every ridge on the horizon in a
    // wide shot - clamped to the border row of the canvas and therefore
    // completely without macro variation.
    {
      const pos = grass.geometry.getAttribute('position');
      const ov = grass.geometry.getAttribute('uvOverlay');
      for (let i = 0; i < ov.count; i++) {
        ov.setXY(i, (pos.getX(i) + 260) / 520, (pos.getZ(i) + 260) / 520);
      }
      ov.needsUpdate = true;
    }
    grass.matrixAutoUpdate = false;
    this._add(grass, false, true);

    this._buildBackdrop();

    // Collision floor as 25 m tiles so the skate bowl and the pool basin can be
    // punched straight through it - a single ground box would seal them shut.
    // Tiles that the terrain actually moves get a triangle soup instead of a
    // box, which is what lets the player walk the banks.
    const holes = [PAD, POOL];
    const T = 25;
    for (let i = 0; i < S / T; i++) {
      for (let j = 0; j < S / T; j++) {
        const x0 = -S / 2 + i * T;
        const z0 = -S / 2 + j * T;
        const blocked = holes.some(
          (h) => x0 < h.x1 && x0 + T > h.x0 && z0 < h.z1 && z0 + T > h.z0
        );
        if (blocked) continue;
        let dev = 0;
        for (let a = 0; a <= 4; a++) {
          for (let b = 0; b <= 4; b++) {
            const h = Math.abs(parkHeight(x0 + (a / 4) * T, z0 + (b / 4) * T));
            if (h > dev) dev = h;
          }
        }
        if (dev < 0.12) {
          this.track(
            this.physics.addBox(x0 + T / 2, -1, z0 + T / 2, T / 2, 1, T / 2, {
              layer: COLLISION_LAYER.WORLD,
            })
          );
        } else {
          this._addHeightCollision(parkHeight, x0, z0, x0 + T, z0 + T, T / 5, T);
        }
      }
    }

    // Invisible site boundary - the ski mound meets the world edge at height,
    // so an open edge there would be a 30 m fall.
    for (const [cx, cz, hx, hz] of [
      [0, -201, 201, 1], [0, 201, 201, 1], [-201, 0, 1, 201], [201, 0, 1, 201],
    ]) {
      this.track(this.physics.addBox(cx, 25, cz, hx, 45, hz, { layer: COLLISION_LAYER.WORLD }));
    }

    /* ---- path network ---- */
    // A readable route from the gate to every zone. The spine is a 3.6 m wide
    // tarmac avenue; the spurs are 2.4 m. Both carry a scuffed verge ribbon so
    // grass never meets a hard geometric edge, and both follow the terrain.
    const spineMat = this._materials.get('path.tarmac');
    const vergeMat = this._materials.get('path.verge');
    const routes = [
      [[[0, 176], [0, 150], [0, 120], [0, 92]], 1.8],
      [[[0, 92], [-24, 88], [-52, 82], [-78, 79], [-100, 79]], 1.8],
      // Pool spur. This used to run [22,100] -> [40,106] -> [52,110], which is
      // straight through the swimming basin: the lawn sheet is holed over the
      // pool, so with the ribbon winding fixed the tarmac appeared as a gravel
      // causeway floating across four lanes of water. It now arrives on the
      // west deck, where the deck slab at y=0.1 hides the last few metres.
      [[[0, 92], [14, 97], [24, 101], [28, 108]], 1.25],
      [[[0, 92], [34, 78], [62, 56], [84, 38], [95, 30]], 1.8],
      [[[0, 92], [-8, 62], [-14, 26], [-26, -12], [-44, -44], [-56, -64]], 1.8],
      [[[0, 92], [26, 52], [44, 10], [56, -26], [62, -52]], 1.25],
      [[[0, 160], [40, 162], [82, 164], [112, 162]], 1.25],
      [[[-100, 79], [-108, 40], [-112, 4], [-104, -34], [-84, -58]], 1.25],
      [[[95, 30], [104, 8], [108, -22], [106, -50]], 1.25],
      // Pool to car park, routed round the south side of the deck rather than
      // over the basin.
      [[[28, 108], [24, 124], [36, 133], [62, 136], [84, 140]], 1.25],
    ];
    const bollards = [];
    const lamps = [];
    // Ribbons are merged per material so the whole network is two draw calls.
    const spineGeos = [];
    const vergeGeos = [];
    for (const [route, halfW] of routes) {
      const dense = [];
      for (let i = 0; i < route.length - 1; i++) {
        const a = route[i];
        const b = route[i + 1];
        const steps = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 3));
        for (let k = 0; k < steps; k++) {
          dense.push([lerp(a[0], b[0], k / steps), lerp(a[1], b[1], k / steps)]);
        }
      }
      dense.push(route[route.length - 1]);
      vergeGeos.push(ribbon(dense, halfW + 0.8, (x, z) => parkHeight(x, z) + 0.03, false, 0.2));
      spineGeos.push(ribbon(dense, halfW, (x, z) => parkHeight(x, z) + 0.062, false, 0.22));

      // Lamp posts and bollards give the route a rhythm and a night read.
      for (let i = 6; i < dense.length; i += 6) {
        const p = dense[i];
        const q = dense[i - 1];
        const nx = -(p[1] - q[1]);
        const nz = p[0] - q[0];
        const nl = Math.hypot(nx, nz) || 1;
        const side = i % 12 === 0 ? 1 : -1;
        const lx = p[0] + (nx / nl) * (halfW + 1.1) * side;
        const lz = p[1] + (nz / nl) * (halfW + 1.1) * side;
        if (halfW > 1.5 && i % 12 === 0) lamps.push([lx, parkHeight(lx, lz), lz, 0, Math.atan2(nx, nz), 0, 1]);
        else bollards.push([lx, parkHeight(lx, lz), lz, 0, 0, 0, 1]);
      }
    }
    const vergeMesh = new THREE.Mesh(mergeGeometries(vergeGeos), vergeMat);
    vergeMesh.matrixAutoUpdate = false;
    this._add(vergeMesh, false, true);
    const spineMesh = new THREE.Mesh(mergeGeometries(spineGeos), spineMat);
    spineMesh.matrixAutoUpdate = false;
    this._add(spineMesh, false, true);

    const bollardGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.085, 0.11, 0.92, 8).translate(0, 0.46, 0),
      new THREE.CylinderGeometry(0.12, 0.12, 0.06, 8).translate(0, 0.95, 0),
    ]);
    this._instanced(bollardGeo, this._materials.get('metal.dark'), bollards);
    const lampGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.09, 0.13, 5.0, 8).translate(0, 2.5, 0),
      new THREE.BoxGeometry(0.18, 0.12, 1.0).translate(0, 4.98, 0.42),
      new THREE.BoxGeometry(0.5, 0.14, 0.72).translate(0, 4.88, 0.86),
    ]);
    this._instanced(lampGeo, this._materials.get('metal.galv'), lamps);
    for (const l of lamps) this.track(this.physics.addBox(l[0], l[1] + 2.5, l[2], 0.16, 2.5, 0.16, {}));

    /* ---- entrance plaza ---- */
    // Prop placements are gathered by every zone builder and instanced once at
    // the end, so 60 benches across the site cost a single draw call.
    // `grounding` collects [x, z, radius] triples for the contact-shadow decal
    // pass; anything that meets the ground on a hard line pushes one.
    this._props = { benches: [], bins: [], hoppers: [], bikes: [], planters: [], grounding: [] };

    const plaza = this._slab(-26, 128, 26, 178, 0.08, this._materials.get('concrete.deck'));
    this._add(plaza, false, true);
    this.track(this.physics.addBox(0, -0.42, 153, 26, 0.5, 25, { layer: COLLISION_LAYER.WORLD }));
  }

  /**
   * Three rings of low-poly hill silhouette beyond the play boundary, each
   * mixed further toward the fog colour. This is what gives the site a horizon
   * with depth cues instead of a dead-straight line and a visible plane edge.
   * Fog is off on these: the aerial perspective is baked per ring so it stays
   * readable rather than dissolving into the fog far plane.
   */
  _buildBackdrop() {
    const fog = this.environment.fogColor;
    const base = new THREE.Color(0x50664f);
    const layers = [
      // Heights are kept low enough that the ridges sit just above the horizon
      // line - a taller far ring climbs into the top of frame and reads as a
      // flat band across the sky rather than as distance.
      // Mix values pulled BACK to 0.52 / 0.74 / 0.90 now that the scene fog
      // actually reaches this far (0.0026 vs 0.0014) and the site materials
      // carry their own saturation-loss ramp. At 0.72 the first ring was almost
      // as hazed as the third, so 900 m of depth stepped from a vivid
      // mid-ground straight into a flat pale card. The whole point of three
      // rings is a monotonic ramp, and it only works if the near ring is
      // meaningfully less hazed than the far one.
      [640, 62, 112, 0.52, 11],
      [820, 76, 88, 0.74, 23],
      [1000, 92, 68, 0.90, 37],
    ];
    for (const [radius, height, segs, mix, seed] of layers) {
      const pos = new Float32Array(segs * 6 * 3);
      const col = new Float32Array(segs * 6 * 3);
      // Baked shading for the ring. A single flat colour per ring is what made
      // the far hills read as three cut-paper cards: no landform reads as a
      // form without a light side and a dark side. `tone` gives each vertex a
      // key/shade term from the ridge's own facing, a tree-cover band that
      // darkens and greens the lower flanks, and a vertical haze gradient so
      // the valley floors sit further into the aerial perspective than the
      // crests do - which is what actually happens, and it costs nothing since
      // these are unlit MeshBasicMaterial.
      const shade = new THREE.Color();
      const tone = (angle, hNorm, out3, o) => {
        // Sun is on -X: ridges facing west catch the key.
        const facing = clamp01(0.5 - Math.cos(angle) * 0.5);
        const wood = fbm(angle / (Math.PI * 2), 0.61, 9, 3, seed + 71);
        shade.copy(base);
        // Wooded flanks: greener and a stop down. Open crest: warmer and up.
        shade.lerp(_color.setRGB(0.13, 0.19, 0.12), wood * (1 - hNorm) * 0.55);
        shade.lerp(_color.setRGB(0.52, 0.55, 0.36), facing * hNorm * 0.34);
        shade.multiplyScalar(0.74 + 0.42 * hNorm + 0.16 * facing);
        shade.lerp(fog, clamp01(mix + (1 - hNorm) * 0.10));
        out3[o] = shade.r;
        out3[o + 1] = shade.g;
        out3[o + 2] = shade.b;
      };
      let p = 0;
      const ridge = (i) => {
        const t = ((i % segs) + segs) % segs / segs;
        const n = fbm(t, 0.3, 7, 4, seed);
        const peak = Math.pow(fbm(t, 0.7, 3, 2, seed + 5), 2.2);
        return height * (0.28 + 0.55 * n + 0.55 * peak);
      };
      for (let i = 0; i < segs; i++) {
        const a0 = (i / segs) * Math.PI * 2;
        const a1 = ((i + 1) / segs) * Math.PI * 2;
        const r0 = radius * (0.9 + 0.2 * fbm(i / segs, 0.1, 5, 2, seed + 9));
        const r1 = radius * (0.9 + 0.2 * fbm((i + 1) / segs, 0.1, 5, 2, seed + 9));
        const x0 = Math.cos(a0) * r0;
        const z0 = Math.sin(a0) * r0;
        const x1 = Math.cos(a1) * r1;
        const z1 = Math.sin(a1) * r1;
        const y0 = ridge(i);
        const y1 = ridge(i + 1);
        const bot = -40;
        // Two triangles, wound so the inward face is front-facing.
        const q = p;
        pos[p++] = x0; pos[p++] = bot; pos[p++] = z0;
        pos[p++] = x1; pos[p++] = bot; pos[p++] = z1;
        pos[p++] = x0; pos[p++] = y0; pos[p++] = z0;
        pos[p++] = x1; pos[p++] = bot; pos[p++] = z1;
        pos[p++] = x1; pos[p++] = y1; pos[p++] = z1;
        pos[p++] = x0; pos[p++] = y0; pos[p++] = z0;
        // hNorm is 0 on the skyline-hiding base skirt and 1 at the crest.
        tone(a0, 0, col, q);
        tone(a1, 0, col, q + 3);
        tone(a0, clamp01(y0 / height), col, q + 6);
        tone(a1, 0, col, q + 9);
        tone(a1, clamp01(y1 / height), col, q + 12);
        tone(a0, clamp01(y0 / height), col, q + 15);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
      const mat = this._mat(
        `backdrop.${radius}`,
        new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, fog: false })
      );
      const m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false;
      m.matrixAutoUpdate = false;
      m.renderOrder = -90 + mix;
      this._add(m, false, false);
    }
  }

  /**
   * Kerb + compacted shoulder + dying-grass verge around a rectangular slab.
   *
   * Every hard surface in this world used to meet the lawn on a zero-thickness
   * razor edge, which made the skate pad and the court slab read as decals
   * painted onto the grass rather than as structures built into ground. Real
   * construction has four things at that boundary and this builds all of them:
   *
   *   1. an extruded kerb with a visible vertical face and its own shadow;
   *   2. a 2 m compacted dirt/gravel shoulder outside the kerb;
   *   3. an alpha-tested verge ribbon where the shoulder dies into turf, so the
   *      grass texture fades out instead of ending on a polygon edge;
   *   4. the whole thing following the terrain, not floating at y=0.
   *
   * Returns nothing - it merges straight into the world.
   */
  _slabEdge(x0, z0, x1, z1, topY, { kerbH = 0.34, shoulder = 2.1, seg = 3, stripe = 0 } = {}) {
    const kerbMat = this._mat(
      'concrete.kerb',
      this._materials.get('concrete.kerb') ||
        new THREE.MeshStandardMaterial({
          map: this._materials.get('concrete.deck').map,
          normalMap: this._materials.get('concrete.deck').normalMap,
          color: 0xc4c2bc, // cast kerb is always lighter than a poured deck
          roughness: 0.85,
          envMapIntensity: 0.4,
        })
    );

    // Kerb ring: four boxes, mitred by simple overlap at the corners.
    const kerbs = [];
    const t = 0.32;
    const y = topY + kerbH / 2 - 0.1;
    kerbs.push(xform(new THREE.BoxGeometry(x1 - x0 + t * 2, kerbH, t), (x0 + x1) / 2, y, z0 - t / 2));
    kerbs.push(xform(new THREE.BoxGeometry(x1 - x0 + t * 2, kerbH, t), (x0 + x1) / 2, y, z1 + t / 2));
    kerbs.push(xform(new THREE.BoxGeometry(t, kerbH, z1 - z0), x0 - t / 2, y, (z0 + z1) / 2));
    kerbs.push(xform(new THREE.BoxGeometry(t, kerbH, z1 - z0), x1 + t / 2, y, (z0 + z1) / 2));
    const kerb = new THREE.Mesh(mergeGeometries(kerbs), kerbMat);
    kerb.matrixAutoUpdate = false;
    this._add(kerb, true, true);

    /*
     * Painted kerb cap.
     *
     * Every readable colour in the skatepark frame was clustered on the west
     * side; the ring that defines the pad's own footprint was grey cast
     * concrete against grey poured concrete against grey gravel. A hazard-
     * painted kerb is what every municipal facility actually has, and it draws
     * a continuous 350 m line right around the subject of the shot for the cost
     * of one merged mesh.
     */
    if (stripe) {
      const paint = this._materials.get('paint.kerb') ?? this._mat(
        'paint.kerb',
        new THREE.MeshStandardMaterial({
          color: stripe,
          roughness: 0.62,
          metalness: 0,
          envMapIntensity: 0.4,
        })
      );
      const caps = [];
      const cy = topY + kerbH - 0.098;
      const w = t + 0.03;
      caps.push(xform(new THREE.BoxGeometry(x1 - x0 + t * 2, 0.035, w), (x0 + x1) / 2, cy, z0 - t / 2));
      caps.push(xform(new THREE.BoxGeometry(x1 - x0 + t * 2, 0.035, w), (x0 + x1) / 2, cy, z1 + t / 2));
      caps.push(xform(new THREE.BoxGeometry(w, 0.035, z1 - z0), x0 - t / 2, cy, (z0 + z1) / 2));
      caps.push(xform(new THREE.BoxGeometry(w, 0.035, z1 - z0), x1 + t / 2, cy, (z0 + z1) / 2));
      const cap = new THREE.Mesh(mergeGeometries(caps), paint);
      cap.matrixAutoUpdate = false;
      this._add(cap, false, true);
    }

    // Densified rectangle path for the two ribbons.
    const ring = [];
    const push = (ax, az, bx, bz) => {
      const n = Math.max(2, Math.ceil(Math.hypot(bx - ax, bz - az) / seg));
      for (let i = 0; i < n; i++) ring.push([lerp(ax, bx, i / n), lerp(az, bz, i / n)]);
    };
    const o = t + shoulder * 0.5;
    push(x0 - o, z0 - o, x1 + o, z0 - o);
    push(x1 + o, z0 - o, x1 + o, z1 + o);
    push(x1 + o, z1 + o, x0 - o, z1 + o);
    push(x0 - o, z1 + o, x0 - o, z0 - o);

    const gy = (gx, gz) => Math.max(parkHeight(gx, gz), topY - 0.16) + 0.02;
    const sh = new THREE.Mesh(
      ribbon(ring, shoulder * 0.5, gy, true, 0.5),
      this._materials.get('path.gravel')
    );
    sh.matrixAutoUpdate = false;
    this._add(sh, false, true);
    const vg = new THREE.Mesh(
      ribbon(ring, shoulder * 0.5 + 1.1, (gx, gz) => gy(gx, gz) - 0.012, true, 0.35),
      this._materials.get('path.verge')
    );
    vg.matrixAutoUpdate = false;
    this._add(vg, false, true);
  }

  /** Axis-aligned horizontal slab with correct 0..1 UVs for a 1:1 court map. */
  _slab(x0, z0, x1, z1, y, material, tile = 0) {
    const geo = new THREE.PlaneGeometry(x1 - x0, z1 - z0, 1, 1);
    geo.rotateX(-Math.PI / 2);
    geo.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
    if (tile > 0) {
      const uv = geo.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) {
        uv.setXY(i, uv.getX(i) * (x1 - x0) * tile, uv.getY(i) * (z1 - z0) * tile);
      }
      uv.needsUpdate = true;
    }
    const m = new THREE.Mesh(geo, material);
    m.matrixAutoUpdate = false;
    m.receiveShadow = true;
    return m;
  }

  /* ---------------------------------------------------------------- */
  /* Skate park                                                        */
  /* ---------------------------------------------------------------- */

  _buildSkatePark() {
    const mat = this._materials.get('concrete.pad');

    // Baked concave occlusion. The bowl, half pipe and snake run are all cut
    // into a single slab, so without a depth-driven darkening term the
    // transitions read as painted outlines on a flat pad.
    // Baked concavity AO, hard-clamped to 0.74..1.0.
    //
    // The previous remap bottomed out near 0.4 and the pad tessellation is far
    // too coarse for per-vertex AO at that depth: the term interpolated
    // linearly across metre-scale triangles and read as dark *paint sprayed on*
    // the concrete, with visible Gouraud banding, rather than as occlusion. A
    // 26% ceiling is all a vertex term should ever be asked to carry - the rest
    // of the concavity read now comes from the raking key, the coping shadow
    // and the post chain's AO pass.
    /*
     * Three separate terms ride the pad's vertex colour, because at this
     * distance the vertex channel is the ONLY place a 100x75 m surface can get
     * value structure that a tiling albedo cannot deliver.
     *
     * 1. MATERIAL FAMILY. The apron and the transitions are not the same
     *    concrete. Flat apron is a dark power-trowelled slab; the bowl floors,
     *    the snake and the quarter-pipe deck are pale, shot-blasted, endlessly
     *    resurfaced pool concrete. Separating them by ~25% of value is what
     *    gives the park a silhouette at all - previously every feature was the
     *    same albedo as the ground it was cut into, so the bowls read only as
     *    a faint AO smudge and the snake run was invisible.
     *
     * 2. POUR BAYS. A 12 m cellular field with hard-ish borders, +/-5% value.
     *    This is the term that stops 45% of the frame being one flat grey.
     *
     * 3. CONCAVITY + COPING SHADOW. The old term was clamped to a 26% ceiling
     *    to avoid Gouraud banding, which at 0.42 m tessellation was over-
     *    cautious: the stencil below is 1.4 m wide, so the field varies over
     *    metres and interpolates cleanly. Floor pulled to 0.56, plus an
     *    explicit 35 cm dark band immediately under every lip - the coping
     *    shadow is the single strongest depth cue a concrete bowl has, and a
     *    3.4 m kidney was reading as a puddle without it.
     */
    const padColour = (x, z, y, out) => {
      const drop = PAD.base - y;
      const depth = clamp01(drop / 3.4);
      // 1.4 m epsilon rather than 0.6: a wider stencil low-passes the curvature
      // so the term varies over metres instead of spiking on single vertices.
      const e = 1.4;
      const lap =
        (padHeight(x + e, z) + padHeight(x - e, z) + padHeight(x, z + e) + padHeight(x, z - e) - 4 * y) /
        (e * e);
      const curv = clamp(lap * 0.55, -0.5, 0.7);
      let ao = clamp01(1 - depth * 0.66 - curv * 0.55);
      // Coping shadow: a hard-ish band in the first 45 cm below any lip, only
      // where the surface is genuinely concave (curv > 0) so the quarter-pipe
      // deck and the pump-track crowns never pick it up.
      const lip = smoothstep(0.03, 0.16, drop) * (1 - smoothstep(0.20, 0.55, drop));
      ao *= 1 - lip * 0.30 * clamp01(curv * 2.4 + 0.35);
      const g = 0.56 + 0.44 * clamp01(ao);

      // Material family: |deviation from the apron plane| drives the split, so
      // every carved feature AND the quarter-pipe deck read as pale pool
      // concrete against a dark apron without needing a second material.
      const dev = Math.abs(drop);
      // The break completes within the first 75 cm of the transition, directly
      // under the tile band - a slow 1.3 m ramp read as a lighting gradient
      // rather than as two different pours meeting.
      const pale = smoothstep(0.10, 0.75, dev);
      const family = lerp(0.78, 1.06, pale);

      // Pour bays: 12 m cells at +/-5%, plus a second 34 m field so the slab
      // also has a large-scale patina zoning rather than pure per-bay noise.
      const bay = 0.95 + cellValue(x, z, 12.0, 5501, 0.34) * 0.10;
      const zone = 0.97 + cellValue(x, z, 34.0, 5507, 3.0) * 0.06;

      const gg = g * family * bay * zone;
      // Fresh pool concrete is a hair cooler than a weathered apron; the tint
      // rides the same `pale` mask so the two families separate in hue as well
      // as in value.
      out[0] = gg * lerp(1.02, 0.985, pale);
      out[1] = gg;
      out[2] = gg * lerp(0.99, 1.035, pale);
    };
    // Visual surface at 0.55 m and collision at 0.8 m in 4.8 m chunks: the
    // player never notices the difference but the solver runs ~10x cheaper.
    // 0.42 m tessellation: the transition curve was visibly faceted against the
    // sky at 0.55, and the bowl lip is the single most-photographed silhouette
    // in the world. Arc-length UVs keep the concrete and the graffiti from
    // stretching down the 50-degree walls.
    const surface = this._heightMesh(
      padHeight, PAD.x0, PAD.z0, PAD.x1, PAD.z1, 0.42, mat, 1 / 8, padColour, null, true
    );
    surface.matrixAutoUpdate = false;
    this._add(surface, false, true);
    this._addHeightCollision(padHeight, PAD.x0, PAD.z0, PAD.x1, PAD.z1, 0.8, 4.8);

    const L = (u, v) => [PAD.x0 + u, PAD.z0 + v];

    /* ---- perimeter kerb, shoulder and verge ---- */
    this._slabEdge(PAD.x0, PAD.z0, PAD.x1, PAD.z1, PAD.base, {
      kerbH: 0.38, shoulder: 2.4, stripe: 0xd8a92c,
    });

    /* ---- bowl coping ---- */
    // Trace the kidney's outline by radial bisection from a seed inside both
    // discs; the union of two overlapping discs is star-shaped from there.
    const rim = [];
    for (let i = 0; i < 128; i++) {
      const a = (i / 128) * Math.PI * 2;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      let lo = 0;
      let hi = 26;
      for (let k = 0; k < 22; k++) {
        const mid = (lo + hi) / 2;
        if (bowlInset(BOWL_SEED.u + dx * mid, BOWL_SEED.v + dz * mid) > 0) lo = mid;
        else hi = mid;
      }
      const [x, z] = L(BOWL_SEED.u + dx * lo, BOWL_SEED.v + dz * lo);
      rim.push(new THREE.Vector3(x, PAD.base - 0.02, z));
    }
    const copingMat = this._materials.get('metal.coping');
    const rimCurve = new THREE.CatmullRomCurve3(rim, true, 'catmullrom', 0.5);
    const coping = new THREE.Mesh(
      new THREE.TubeGeometry(rimCurve, 320, 0.065, 8, true),
      copingMat
    );
    coping.matrixAutoUpdate = false;
    this._add(coping, true, true);

    /* ---- pool-tile band under the coping ---- */
    /*
     * The single highest-value read in a skate bowl after the coping itself.
     * A 40 cm band of glazed tile directly below the lip gives the bowl a
     * horizon line, a scale reference and a specular event where there was
     * nothing but hundreds of square metres of undifferentiated grey.
     */
    {
      const N = rim.length;
      const inner = [];
      const outer = [];
      let run = 0;
      for (let i = 0; i <= N; i++) {
        const p = rim[i % N];
        // Inward direction in plan, from the coping toward the bowl seed.
        const [sx, sz] = L(BOWL_SEED.u, BOWL_SEED.v);
        let dx = sx - p.x;
        let dz = sz - p.z;
        const dl = Math.hypot(dx, dz) || 1;
        dx /= dl;
        dz /= dl;
        const ax = p.x + dx * 0.10;
        const az = p.z + dz * 0.10;
        const bx = p.x + dx * 0.62;
        const bz = p.z + dz * 0.62;
        if (i > 0) run += Math.hypot(p.x - rim[(i - 1) % N].x, p.z - rim[(i - 1) % N].z);
        inner.push([ax, padHeight(ax, az) + 0.012, az, run]);
        outer.push([bx, padHeight(bx, bz) + 0.012, bz, run]);
      }
      const count = inner.length;
      const tp = new Float32Array(count * 2 * 3);
      const tuv = new Float32Array(count * 2 * 2);
      for (let i = 0; i < count; i++) {
        const a = inner[i];
        const b = outer[i];
        tp[i * 6] = a[0]; tp[i * 6 + 1] = a[1]; tp[i * 6 + 2] = a[2];
        tp[i * 6 + 3] = b[0]; tp[i * 6 + 4] = b[1]; tp[i * 6 + 5] = b[2];
        // ~15 cm tile: the band is 0.52 m across, so v spans 3.4 tiles.
        tuv[i * 4] = a[3] / 0.15;
        tuv[i * 4 + 1] = 0;
        tuv[i * 4 + 2] = b[3] / 0.15;
        tuv[i * 4 + 3] = 3.4;
      }
      const tidx = new Uint32Array((count - 1) * 6);
      for (let i = 0; i < count - 1; i++) {
        const a = i * 2;
        const b = (i + 1) * 2;
        tidx[i * 6] = a; tidx[i * 6 + 1] = b; tidx[i * 6 + 2] = a + 1;
        tidx[i * 6 + 3] = b; tidx[i * 6 + 4] = b + 1; tidx[i * 6 + 5] = a + 1;
      }
      const tg = new THREE.BufferGeometry();
      tg.setAttribute('position', new THREE.BufferAttribute(tp, 3));
      tg.setAttribute('uv', new THREE.BufferAttribute(tuv, 2));
      tg.setIndex(new THREE.BufferAttribute(tidx, 1));
      tg.computeVertexNormals();
      tg.computeBoundingSphere();
      const bandMat = this._mat(
        'tile.bowlband',
        new THREE.MeshStandardMaterial({
          map: this._materials.get('tile.pool').map,
          normalMap: this._materials.get('tile.pool').normalMap,
          color: 0xdfe8ea,
          roughness: 0.22,
          metalness: 0.02,
          envMapIntensity: 1.1,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        })
      );
      const band = new THREE.Mesh(tg, bandMat);
      band.matrixAutoUpdate = false;
      this._add(band, false, true);
    }

    /* ---- drain at the deep end, plus radial settlement cracks ---- */
    {
      const [dx, dz] = L(BOWL_A.u, BOWL_A.v);
      const dy = padHeight(dx, dz);
      const drain = new THREE.Mesh(
        new THREE.CylinderGeometry(0.16, 0.16, 0.03, 16),
        this._materials.get('metal.dark')
      );
      drain.position.set(dx, dy + 0.012, dz);
      this._add(drain, false, true);
      const bars = [];
      for (let i = -2; i <= 2; i++) {
        bars.push(xform(new THREE.BoxGeometry(0.02, 0.02, 0.3), dx + i * 0.05, dy + 0.026, dz));
      }
      const bm = new THREE.Mesh(mergeGeometries(bars), this._materials.get('metal.rail'));
      bm.matrixAutoUpdate = false;
      this._add(bm, false, false);
    }

    /* ---- half pipe + quarter pipe coping ---- */
    const straightCoping = [];
    for (const [u0, v0, u1, v1] of [
      [HALFPIPE.u0 + 3, HALFPIPE.vc - HALFPIPE.flat - HALFPIPE.R, HALFPIPE.u1 - 3, HALFPIPE.vc - HALFPIPE.flat - HALFPIPE.R],
      [HALFPIPE.u0 + 3, HALFPIPE.vc + HALFPIPE.flat + HALFPIPE.R, HALFPIPE.u1 - 3, HALFPIPE.vc + HALFPIPE.flat + HALFPIPE.R],
      [QP.u0 + 7, QP.v0 + QP.R, QP.u1 - 7, QP.v0 + QP.R],
    ]) {
      const [ax, az] = L(u0, v0);
      const [bx, bz] = L(u1, v1);
      const y = v0 > 60 ? PAD.base + QP.R : PAD.base;
      const g = new THREE.CylinderGeometry(0.065, 0.065, Math.hypot(bx - ax, bz - az), 10, 1);
      g.rotateZ(Math.PI / 2);
      g.rotateY(-Math.atan2(bz - az, bx - ax));
      g.translate((ax + bx) / 2, y - 0.02, (az + bz) / 2);
      straightCoping.push(g);
    }
    const sc = new THREE.Mesh(
      mergeGeometries(straightCoping),
      this._materials.get('metal.coping.straight')
    );
    sc.matrixAutoUpdate = false;
    this._add(sc, true, true);

    /* ---- floodlight masts ------------------------------------------- */
    /*
     * Four 16 m masts, and they are doing two jobs.
     *
     * SILHOUETTE: nothing in the built site broke a ~4 m vertical band, so the
     * only thing interrupting the horizon from anywhere on the pad was an
     * unreachable mountain. A player standing on the concrete now has four
     * things above eye level to navigate by.
     *
     * LIGHT: the stated raking key had almost nothing to draw with. A key is
     * only visible as the shadows it casts, and 7,500 m2 of concrete with no
     * vertical casters over it renders as flat ambient albedo no matter how the
     * rig is tuned. Their positions are chosen from the sun vector, not from
     * symmetry: light travels (+0.90, -0.36) in plan, so a caster must sit at
     * LOW x and HIGH z for its shadow to rake across the pad rather than
     * immediately off the north kerb. At 14.1 deg a 16 m mast throws 64 m, so
     * the two at u=58 put their tips past the east kerb - which is exactly the
     * dead quadrant that had no value variation in it at all.
     */
    this._buildPylons(
      [L(2.0, 26), L(2.0, 58), L(58, 30), L(58, 72)].map(([x, z]) => [x, z]),
      16,
      { aim: [PAD.x0 + 50, PAD.z0 + 37.5], baseFn: (x, z) => padHeight(x, z) }
    );

    this._buildSkateFurniture(L);
  }

  /**
   * Street section: everything with a hard edge is an oriented box, because a
   * heightfield cannot express a 40 cm vertical ledge at a usable resolution.
   */
  _buildSkateFurniture(L) {
    const conc = this._materials.get('concrete.deck');
    const rail = this._materials.get('metal.rail');
    const base = PAD.base;

    // Waxed granite: skaters wax ledges until the top 4 cm is nearly polished.
    const wax = this._mat(
      'ledge.wax',
      new THREE.MeshStandardMaterial({ color: 0x8f8d88, roughness: 0.16, metalness: 0.06, envMapIntensity: 1.3 })
    );

    const boxAt = (u0, v0, u1, v1, h, y0 = 0, mat = conc) => {
      const [x0, z0] = L(u0, v0);
      const [x1, z1] = L(u1, v1);
      const m = this._box(x1 - x0, h, z1 - z0, mat, (x0 + x1) / 2, base + y0 + h / 2, (z0 + z1) / 2);
      return this._solid(m);
    };

    /* ---- raised plaza + stair set ---- */
    boxAt(6, 3, 28, 13, 0.9);
    for (let i = 0; i < 6; i++) {
      const top = 0.9 - i * 0.15;
      boxAt(11, 13 + i * 0.5, 25, 16, top);
    }
    // Hubba: a sloped ledge riding the stair stringer.
    {
      const [ax, az] = L(25.6, 12.8);
      const [bx, bz] = L(25.6, 16.4);
      const len = Math.hypot(bx - ax, bz - az);
      const m = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.42, len), wax);
      m.position.set((ax + bx) / 2, base + 0.72, (az + bz) / 2);
      m.rotation.x = Math.atan2(0.9, 3.6);
      this._solid(m);
    }
    // Handrail down the stairs.
    {
      const [ax, az] = L(9.8, 12.6);
      const [bx, bz] = L(9.8, 16.6);
      const len = Math.hypot(bx - ax, bz - az, 0);
      const g = new THREE.CylinderGeometry(0.045, 0.045, Math.hypot(len, 0.9), 10, 1);
      const m = new THREE.Mesh(g, rail);
      m.position.set((ax + bx) / 2, base + 1.05, (az + bz) / 2);
      m.rotation.x = Math.PI / 2 - Math.atan2(0.9, len);
      this._solid(m);
      const posts = [];
      for (const t of [0.08, 0.5, 0.92]) {
        const [px, pz] = L(9.8, 12.6 + t * 4);
        posts.push(xform(new THREE.CylinderGeometry(0.04, 0.04, 1.2, 8), px, base + 0.9 - t * 0.9 + 0.15, pz));
      }
      const pm = new THREE.Mesh(mergeGeometries(posts), rail);
      pm.matrixAutoUpdate = false;
      this._add(pm);
    }

    /* ---- funbox with banked ends and a rail across the top ---- */
    boxAt(38, 4, 47, 12, 0.62);
    for (const [u, dir] of [[35.6, 1], [49.4, -1]]) {
      const [x, z] = L(u, 8);
      const m = new THREE.Mesh(new THREE.BoxGeometry(5.4, 0.24, 8), conc);
      m.position.set(x, base + 0.31, z);
      m.rotation.z = dir * Math.atan2(0.62, 5.0);
      this._solid(m);
    }
    {
      const [ax, az] = L(35, 3.4);
      const [bx, bz] = L(50, 3.4);
      const g = new THREE.CylinderGeometry(0.045, 0.045, bx - ax, 10, 1);
      g.rotateZ(Math.PI / 2);
      const m = new THREE.Mesh(g, rail);
      m.position.set((ax + bx) / 2, base + 0.34, az);
      this._solid(m);
      const posts = [];
      for (let i = 0; i <= 3; i++) {
        const [px, pz] = L(35 + i * 5, 3.4);
        posts.push(xform(new THREE.CylinderGeometry(0.04, 0.04, 0.34, 8), px, base + 0.17, pz));
      }
      const pm = new THREE.Mesh(mergeGeometries(posts), rail);
      pm.matrixAutoUpdate = false;
      this._add(pm);
    }

    /* ---- ledges and a flat bar ---- */
    const ledges = [
      [55, 2.2, 76, 3.6, 0.42],
      [55, 5.8, 68, 7.0, 0.34],
      [30, 55.5, 40, 58.5, 0.30],
    ];
    for (const [u0, v0, u1, v1, h] of ledges) {
      boxAt(u0, v0, u1, v1, h);
      const [x0, z0] = L(u0, v0);
      const [x1, z1] = L(u1, v1);
      const cap = this._box(x1 - x0 + 0.04, 0.06, z1 - z0 + 0.04, wax,
        (x0 + x1) / 2, base + h + 0.005, (z0 + z1) / 2);
      this._add(cap, false, true);
    }
    {
      const [ax, az] = L(80, 4);
      const [bx, bz] = L(92, 4);
      const g = new THREE.CylinderGeometry(0.05, 0.05, bx - ax, 12, 1);
      g.rotateZ(Math.PI / 2);
      const m = new THREE.Mesh(g, rail);
      m.position.set((ax + bx) / 2, base + 0.34, az);
      this._solid(m);
      const posts = [];
      for (let i = 0; i <= 4; i++) {
        const [px, pz] = L(80 + i * 3, 4);
        posts.push(xform(new THREE.CylinderGeometry(0.04, 0.04, 0.34, 8), px, base + 0.17, pz));
      }
      const pm = new THREE.Mesh(mergeGeometries(posts), rail);
      pm.matrixAutoUpdate = false;
      this._add(pm);
    }

    /* ---- graffiti wall on the west deck ---- */
    const wallCanvas = makeCanvas(1024, 256);
    paintPixels(wallCanvas, (u, v, out) => {
      const g = 152 + fbm(u, v, 40, 4, 211) * 46;
      out[0] = g * 1.01;
      out[1] = g;
      out[2] = g * 0.98;
    });
    const wc = wallCanvas.getContext('2d');
    const wr = makeRng(808);
    for (let s = 0; s < 5; s++) {
      const cxw = 90 + s * 200;
      const hue = [12, 190, 285, 45, 330][s];
      wc.lineCap = 'round';
      wc.lineJoin = 'round';
      for (let layer = 0; layer < 3; layer++) {
        wc.strokeStyle =
          layer === 2 ? 'rgba(18,16,22,0.95)' : `hsla(${hue + layer * 35},88%,${52 + layer * 8}%,0.95)`;
        wc.lineWidth = layer === 2 ? 4 : 20 - layer * 7;
        wc.beginPath();
        let px = cxw - 70;
        let py = 128;
        wc.moveTo(px, py);
        for (let k = 0; k < 5; k++) {
          const nx = px + 32;
          const ny = 128 + (wr() - 0.5) * 110;
          wc.bezierCurveTo(px + 12, py - 55, nx - 12, ny + 45, nx, ny);
          px = nx;
          py = ny;
        }
        wc.stroke();
      }
    }
    const wallMat = this._mat(
      'wall.graffiti',
      new THREE.MeshStandardMaterial({
        map: this._tex(wallCanvas, { srgb: true, repeat: 1, key: 'wall.graffiti.map' }),
        roughness: 0.9,
      })
    );
    {
      const [x, z] = L(3.4, 43);
      const w = this._box(0.5, 3.2, 18, wallMat, x, base + 1.6, z);
      this._solid(w);
      // Same pasted-on straight base line the lodge had. Nine spots down each
      // side of the wall give it a footing.
      for (let i = 0; i <= 8; i++) {
        const zz = z - 9 + (i / 8) * 18;
        this._props?.grounding?.push([x - 0.55, zz, 1.5], [x + 0.55, zz, 1.5]);
      }
    }

    /* ---- east street section ---------------------------------------- */
    /*
     * Everything above lives at u < 55. The eastern 45 m of the pad - which is
     * a third of every establishing frame - had one pump-track ellipse on it
     * and nothing else, so a player who walked out there found a car park.
     *
     * Six obstacles go in the two genuinely clear bands (v 23..29 between the
     * half pipe and the pump track, and v 46..54 east of the snake run), and
     * they are deliberately NOT grey: grey furniture on grey concrete is
     * invisible at 60 m, which is why the stair set at u=6 was the only thing
     * in the park that read at all. Everything here is authored as one merged
     * mesh per material, and collision goes in as plain boxes rather than
     * through `_solid`, so the whole section costs three draw calls.
     */
    {
      const conc2 = [];
      const caps = [];
      const steelY = [];
      const steelT = [];
      const solidBox = (x, y, z, hx, hy, hz) =>
        this.track(this.physics.addBox(x, y, z, hx, hy, hz, { layer: COLLISION_LAYER.WORLD }));

      /** Boxed obstacle in pad-local metres, with a waxed cap on top. */
      const ledge = (u0, v0, u1, v1, h, capMat = true) => {
        const [x0, z0] = L(u0, v0);
        const [x1, z1] = L(u1, v1);
        const cx = (x0 + x1) / 2;
        const cz = (z0 + z1) / 2;
        const w = x1 - x0;
        const d = z1 - z0;
        conc2.push(boxProjectUV(xform(new THREE.BoxGeometry(w, h, d), cx, base + h / 2, cz), 2.0));
        if (capMat) {
          caps.push(xform(new THREE.BoxGeometry(w + 0.05, 0.07, d + 0.05), cx, base + h + 0.008, cz));
        }
        solidBox(cx, base + h / 2, cz, w / 2, h / 2, d / 2);
      };

      /** Flat bar: a round tube on four stubby legs, running along +u. */
      const flatBar = (u0, u1, v, h, list) => {
        const [x0, z] = L(u0, v);
        const [x1] = L(u1, v);
        const len = x1 - x0;
        const g = new THREE.CylinderGeometry(0.05, 0.05, len, 10, 1);
        g.rotateZ(Math.PI / 2);
        g.translate((x0 + x1) / 2, base + h, z);
        list.push(g);
        const n = Math.max(2, Math.round(len / 2.5));
        for (let i = 0; i <= n; i++) {
          list.push(
            xform(new THREE.CylinderGeometry(0.042, 0.042, h, 8), x0 + (i / n) * len, base + h / 2, z)
          );
        }
        solidBox((x0 + x1) / 2, base + h / 2, z, len / 2, h / 2, 0.12);
      };

      // Three flat bars in the clear band between the half pipe and the pump.
      flatBar(58, 63, 24.6, 0.35, steelY);
      flatBar(68, 73, 26.4, 0.40, steelT);
      flatBar(76, 81, 24.0, 0.32, steelY);

      // 12 m manual pad - the classic long low box - out on the east flat.
      ledge(86, 24.0, 98, 26.6, 0.28);

      // Euro-gap: two ledges with a 1.4 m gap between them.
      ledge(56, 47.0, 62, 48.6, 0.45);
      ledge(63.4, 47.0, 69, 48.6, 0.45);

      // Hubba pair flanking a four-stair on the far east flat, plus its landing.
      ledge(90, 47.0, 97, 50.2, 0.62);
      for (let i = 0; i < 4; i++) {
        const top = 0.62 - i * 0.155;
        ledge(92.2, 50.2 + i * 0.34, 95.0, 52.4, top, false);
      }
      {
        // Sloped hubba riding the stringer, on the west side of the stair.
        const [ax, az] = L(91.7, 50.0);
        const [bx, bz] = L(91.7, 52.6);
        const len = Math.hypot(bx - ax, bz - az);
        const g = new THREE.BoxGeometry(1.0, 0.34, len);
        const m = new THREE.Mesh(g, wax);
        m.position.set((ax + bx) / 2, base + 0.46, (az + bz) / 2);
        m.rotation.x = Math.atan2(0.62, 2.6);
        this._solid(m);
      }

      if (conc2.length) {
        const cm = new THREE.Mesh(mergeGeometries(conc2), conc);
        cm.matrixAutoUpdate = false;
        this._add(cm, true, true);
      }
      if (caps.length) {
        const km = new THREE.Mesh(mergeGeometries(caps), wax);
        km.matrixAutoUpdate = false;
        this._add(km, true, true);
      }
      // Painted steel, not galvanised. Two accents, because a single hue over
      // six obstacles reads as a kit rather than as a park that grew.
      const yellow = this._metal('metal.barYellow', 0xd8b23a, 0.34, 0.9, {
        envMapIntensity: 1.0,
        roughnessMap: this._textures.get('metal.rail.rough') ?? null,
      });
      const teal = this._metal('metal.barTeal', 0x2f7f8c, 0.36, 0.9, {
        envMapIntensity: 1.0,
        roughnessMap: this._textures.get('metal.rail.rough') ?? null,
      });
      for (const [list, m] of [[steelY, yellow], [steelT, teal]]) {
        if (!list.length) continue;
        const mesh = new THREE.Mesh(mergeGeometries(list), m);
        mesh.matrixAutoUpdate = false;
        this._add(mesh, true, true);
      }
    }
  }

  /**
   * Lift a list of placements onto the terrain. Everything authored at y=0 in
   * the site plan needs this now that the ground is a heightfield; inside the
   * levelled pads parkHeight() is exactly 0, so it is a no-op there.
   */
  _groundList(list) {
    for (let i = 0; i < list.length; i++) {
      const q = list[i];
      q[1] = (q[1] ?? 0) + parkHeight(q[0], q[2]);
    }
    return list;
  }

  /**
   * Batch a repeated prop. `placements` are flat [x,y,z,rx,ry,rz,s?] tuples;
   * anything drawn more than a dozen times goes through here.
   */
  _instanced(geo, mat, placements, cast = true, receive = true) {
    const im = new THREE.InstancedMesh(geo, mat, placements.length);
    for (let i = 0; i < placements.length; i++) {
      const q = placements[i];
      _v1.set(q[0], q[1], q[2]);
      _e1.set(q[3] || 0, q[4] || 0, q[5] || 0);
      _q1.setFromEuler(_e1);
      const s = q[6] ?? 1;
      _s1.set(s, q[7] ?? s, q[8] ?? s);
      _m1.compose(_v1, _q1, _s1);
      im.setMatrixAt(i, _m1);
    }
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = cast;
    im.receiveShadow = receive;
    im.computeBoundingSphere();
    this.group.add(im);
    return im;
  }

  /* ---------------------------------------------------------------- */
  /* Ski and snow zone                                                 */
  /* ---------------------------------------------------------------- */

  _buildSkiZone() {
    const snowMat = this._materials.get('snow.piste');

    /**
     * Baked curvature/AO plus the scree blend, written into vertex colour.
     * A finite-difference Laplacian of the height field darkens gullies and
     * lifts ridges, so the mound reads as a landform even where the snow is
     * near white; below the snow line the colour ramps into wet scree so the
     * hill does not terminate on a hard arc against the lawn.
     */
    const slopeColour = (x, z, y, out) => {
      const e = 2.0;
      const lap =
        skiHeight(x + e, z) + skiHeight(x - e, z) + skiHeight(x, z + e) + skiHeight(x, z - e) - 4 * y;
      // Negative curvature = convex ridge (brighter), positive = gully (darker).
      const curv = clamp(lap * 0.10, -0.5, 0.5);
      let shade = 1 - curv * 0.36;
      // Broad valley darkening down the fall line so the whole flank has a ramp.
      shade *= lerp(0.84, 1.0, clamp01((y / SKI.top) * 1.5 + 0.15));

      // Altitude banding: grass -> scree -> rock -> dirty snow -> clean snow.
      // A white cone terminating on a green lawn is the single loudest
      // tonal-incoherence tell in the world; 40 m of vertical banding is what
      // turns the prop into a mountain. Colours are deliberately blue-green and
      // desaturated so the alpine band reads cooler than the summer valley.
      const grass = [0.30, 0.36, 0.22];
      const screeC = [0.40, 0.40, 0.37];
      const rockC = [0.27, 0.28, 0.30];
      const snowC = [0.96, 0.97, 1.0];
      const tScree = smoothstep(0.4, SCREE_LINE, y);
      const tRock = smoothstep(SCREE_LINE, ROCK_LINE, y);
      const tSnow = smoothstep(ROCK_LINE + 2, SNOW_LINE, y);
      for (let c = 0; c < 3; c++) {
        let v = lerp(grass[c], screeC[c], tScree);
        v = lerp(v, rockC[c], tRock);
        v = lerp(v, snowC[c], tSnow);
        out[c] = v * shade;
      }
      // Wind-scoured patches near the ridge keep the summit from blowing out.
      if (tSnow > 0.6) {
        // 140 m wavelength, not 60. At /60 the scour bands were close to the
        // vertex sampling rate and read as crawl rather than as wind structure.
        const scour = fbm((x + 200) / 140, (z + 240) / 140, 5, 2, 733);
        const k = 1 - clamp01((scour - 0.62) * 2.2) * 0.22;
        out[0] *= k; out[1] *= k; out[2] *= k;
      }
    };

    const slope = this._heightMesh(
      skiHeight, SKI.x0, SKI.z0, SKI.x1, SKI.z1, 1.2, snowMat, 1 / 4, slopeColour, null, true
    );
    slope.matrixAutoUpdate = false;
    this._add(slope, true, true);
    this._addHeightCollision(skiHeight, SKI.x0, SKI.z0, SKI.x1, SKI.z1, 1.5, 9);

    /* ---- rock outcrops breaking the ridge silhouette ---- */
    const rockGeo = new THREE.IcosahedronGeometry(1, 1);
    {
      const rp = rockGeo.getAttribute('position');
      for (let i = 0; i < rp.count; i++) {
        const s = 0.62 + hash2i(i * 7, i * 13, 991) * 0.75;
        rp.setXYZ(i, rp.getX(i) * s * 1.5, rp.getY(i) * s * 0.8, rp.getZ(i) * s * 1.2);
      }
      rockGeo.computeVertexNormals();
    }
    const rocks = [];
    const scree = [];
    const rrng = makeRng(9182);
    for (let i = 0; i < 400 && rocks.length < 16; i++) {
      const x = SKI.x0 + 6 + rrng() * (SKI.x1 - SKI.x0 - 12);
      const z = SKI.z0 + 4 + rrng() * 74;
      if (!this._inSite(x, z, 5)) continue;
      const y = skiHeight(x, z);
      // Cliff bands live in the rock/scree altitude window, which is where the
      // slope colour ramp says bare rock should be showing through.
      if (y < ROCK_LINE - 2 || y > SNOW_LINE + 12) continue;
      // Keep the groomed corridors clear - rocks live on the flanks and ridge.
      let onPiste = false;
      for (const c of PISTE_LANES) if (Math.abs(x - c) < 15) onPiste = true;
      if (onPiste) continue;
      // Few and large: a scatter of small dark chips reads as dirt on the lens,
      // a handful of big ones reads as a cliff band.
      rocks.push([x, y - 1.0, z, rrng() * 0.3 - 0.15, rrng() * 6.28, rrng() * 0.24 - 0.12,
        2.4 + rrng() * 2.6, 1.8 + rrng() * 2.0, 2.2 + rrng() * 2.4]);
    }
    this._instanced(rockGeo, this._materials.get('rock.outcrop'), rocks);

    // Scree boulders scattered through the snow-line band so the arc where snow
    // meets grass is a transition rather than a cut.
    // 70 boulders at 0.7-1.8 m, not 260 at 0.2-0.7 m. The comment above the
    // outcrop pass already knew the rule and the scree pass broke it: 260
    // sub-metre chips spread over a 130 m mound subtend well under a pixel from
    // any establishing camera and resolve as uniform salt-and-pepper - the
    // "grey television static" read on the whole flank. Constraining them to a
    // tight band just under the snow line also makes them signal (a scree
    // apron) instead of noise (dust on the lens).
    for (let i = 0; i < 1800 && scree.length < 70; i++) {
      const x = SKI.x0 + rrng() * (SKI.x1 - SKI.x0);
      const z = SKI.z0 + rrng() * (SKI.z1 - SKI.z0);
      if (!this._inSite(x, z, 2)) continue;
      const y = skiHeight(x, z);
      if (y < 0.35 || y > SCREE_LINE - 0.6) continue;
      scree.push([x, y - 0.22, z, rrng(), rrng() * 6.28, rrng(), 0.7 + rrng() * 1.1]);
    }
    this._instanced(rockGeo, this._materials.get('scree'), scree);

    const galv = this._materials.get('metal.galv');
    const dark = this._materials.get('metal.dark');
    const wood = this._materials.get('wood.plank');

    /* ---- piste marker poles (orange-topped, both edges) ---- */
    const poleGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.055, 0.055, 2.6, 7).translate(0, 1.3, 0),
      new THREE.CylinderGeometry(0.075, 0.075, 0.5, 7).translate(0, 2.45, 0),
    ]);
    const poleMat = this._mat(
      'pole.piste',
      new THREE.MeshStandardMaterial({ color: 0xf47a1f, roughness: 0.6 })
    );
    const poles = [];
    for (let i = 0; i < 26; i++) {
      const t = i / 25;
      const z = lerp(-88, -186, t);
      for (const side of [-1, 1]) {
        const x = -62 + side * (26 + 16 * t);
        const y = skiHeight(x, z);
        if (y < 0.3) continue;
        poles.push([x, y, z, 0, 0, 0, 1]);
      }
    }
    this._instanced(poleGeo, poleMat, poles);

    /* ---- slalom course down the fall line ---- */
    const gateGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.03, 0.035, 1.8, 6).translate(0, 0.9, 0),
      new THREE.BoxGeometry(0.5, 0.34, 0.02).translate(0, 1.55, 0),
    ]);
    const gateRed = this._mat('gate.red', new THREE.MeshStandardMaterial({ color: 0xd2262c, roughness: 0.5 }));
    const gateBlue = this._mat('gate.blue', new THREE.MeshStandardMaterial({ color: 0x1f5fd0, roughness: 0.5 }));
    const red = [];
    const blue = [];
    for (let i = 0; i < 14; i++) {
      const z = -178 + i * 7.4;
      const x = -66 + Math.sin(i * 1.05) * 11;
      const y = skiHeight(x, z);
      (i % 2 ? blue : red).push([x, y, z, 0, i * 0.4, 0, 1]);
      (i % 2 ? blue : red).push([x + 5.5, y, z, 0, i * 0.4, 0, 1]);
    }
    this._instanced(gateGeo, gateRed, red);
    this._instanced(gateGeo, gateBlue, blue);

    /* ---- safety netting along the skier's left ---- */
    const netMat = this._materials.get('net.safety');
    const netPanels = [];
    const netPosts = [];
    for (let i = 0; i < 22; i++) {
      const z0 = -180 + i * 5;
      const z1 = z0 + 5;
      const x = -26 - i * 0.55;
      const y0 = skiHeight(x, z0);
      const y1 = skiHeight(x, z1);
      if (Math.max(y0, y1) < 0.6) continue;
      const g = new THREE.PlaneGeometry(5.02, 1.9, 1, 1);
      const uv = g.getAttribute('uv');
      for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * 3.4, uv.getY(k) * 1.3);
      uv.needsUpdate = true;
      g.rotateY(Math.PI / 2);
      g.rotateX(-Math.atan2(y1 - y0, 5));
      g.translate(x, (y0 + y1) / 2 + 0.95, (z0 + z1) / 2);
      netPanels.push(g);
      netPosts.push([x, y0, z0, 0, 0, 0, 1]);
    }
    if (netPanels.length) {
      const nm = new THREE.Mesh(mergeGeometries(netPanels), netMat);
      nm.matrixAutoUpdate = false;
      this._add(nm, true, false);
      this._instanced(
        new THREE.CylinderGeometry(0.05, 0.05, 2.1, 6).translate(0, 1.05, 0),
        dark,
        netPosts
      );
    }

    /* ---- chairlift ---- */
    this._buildChairlift(galv, dark);

    /* ---- lodge ---- */
    this._buildLodge(wood, dark);

    /* ---- conifers on the upper mountain ---- */
    const trunk = new THREE.CylinderGeometry(0.16, 0.3, 3.2, 6).translate(0, 1.6, 0);
    // Cone core pulled in to ~65% so the alpha-cut branch whorls carry the
    // silhouette; the cone only has to stop daylight through the middle.
    const cone = mergeGeometries([
      new THREE.ConeGeometry(1.55, 4.4, 9).translate(0, 4.4, 0),
      new THREE.ConeGeometry(1.15, 3.6, 9).translate(0, 6.6, 0),
      new THREE.ConeGeometry(0.7, 2.6, 9).translate(0, 8.5, 0),
    ]);
    const coneCards = this._coniferCards(3311);
    // The foliage materials read vertex colour (that is how each tree gets its
    // own tint), so every mesh that uses them has to carry the attribute or the
    // default generic attribute renders it black. Skirts darken toward the
    // ground, which is where a conifer occludes itself hardest.
    {
      const cp = cone.getAttribute('position');
      const cc = new Float32Array(cp.count * 3);
      for (let i = 0; i < cp.count; i++) {
        const s = 0.5 + 0.5 * clamp01((cp.getY(i) - 2.0) / 6.0);
        cc[i * 3] = s;
        cc[i * 3 + 1] = s;
        cc[i * 3 + 2] = s * 0.96;
      }
      cone.setAttribute('color', new THREE.BufferAttribute(cc, 3));
    }
    const trunks = [];
    const rng = makeRng(551);
    for (let i = 0; i < 260; i++) {
      const x = -128 + rng() * 132;
      const z = -200 + rng() * 106;
      // The sampling window opens exactly ON bounds.min.z, so without this a
      // handful of 9m firs straddle the site border with half their crown
      // outside the playable area.
      if (!this._inSite(x, z, 3)) continue;
      const y = skiHeight(x, z);
      // Conifers belong in the band between the scree and the snow line - a
      // treeline that runs to the summit is the other half of the "snow cone
      // dropped on a lawn" read.
      if (y < SCREE_LINE - 1 || y > SNOW_LINE + 3) continue;
      if (Math.abs(x + 62) < 30 && z > -190) continue;
      if (Math.abs(x + 88) < 6) continue;
      trunks.push([x, y - 0.2, z, 0, rng() * 6.28, 0, 0.7 + rng() * 0.7]);
    }
    this._instanced(trunk, this._materials.get('bark'), trunks);
    const cones = this._instanced(cone, this._materials.get('foliage.dark'), trunks);
    const coneShell = this._instanced(coneCards, this._materials.get('foliage.card.dark'), trunks, false, true);
    // Alpine conifers are markedly cooler and darker than the valley broadleaf,
    // which is what makes the mountain read as a different altitude band rather
    // than as the same summer park tipped on its side.
    for (let i = 0; i < trunks.length; i++) {
      _color.setHSL(0.30 + hash2i(i, 3, 77) * 0.06, 0.12 + hash2i(i, 5, 79) * 0.14, 0.36 + hash2i(i, 7, 83) * 0.18);
      cones.setColorAt(i, _color);
      coneShell.setColorAt(i, _color);
    }
    if (cones.instanceColor) cones.instanceColor.needsUpdate = true;
    if (coneShell.instanceColor) coneShell.instanceColor.needsUpdate = true;
  }

  _buildChairlift(galv, dark) {
    const LX = -88;
    const zBase = -80;
    const zTop = -192;

    // Cable line: 7 m of clearance at the towers, catenary sag between them.
    const towerZ = [];
    for (let i = 0; i <= 7; i++) towerZ.push(lerp(zBase, zTop, i / 7));
    const pts = [];
    for (let i = 0; i < towerZ.length - 1; i++) {
      const za = towerZ[i];
      const zb = towerZ[i + 1];
      for (let k = 0; k < 8; k++) {
        const f = k / 8;
        const z = lerp(za, zb, f);
        const terrain = lerp(skiHeight(LX, za), skiHeight(LX, zb), f);
        pts.push(new THREE.Vector3(LX, terrain + 7.4 - Math.sin(f * Math.PI) * 1.1, z));
      }
    }
    pts.push(new THREE.Vector3(LX, skiHeight(LX, zTop) + 7.4, zTop));

    // Sampler used by update(); linear walk of the polyline, zero allocation.
    const cablePts = pts;
    this._chairPath = {
      sample(s, out) {
        const f = clamp01(s) * (cablePts.length - 1);
        const i = Math.min(cablePts.length - 2, Math.floor(f));
        const a = cablePts[i];
        const b = cablePts[i + 1];
        return out.copy(a).lerp(b, f - i);
      },
    };

    for (const off of [-1.5, 1.5]) {
      const curve = new THREE.CatmullRomCurve3(
        pts.map((p) => new THREE.Vector3(p.x + off, p.y, p.z))
      );
      const cable = new THREE.Mesh(new THREE.TubeGeometry(curve, 90, 0.05, 5, false), dark);
      cable.matrixAutoUpdate = false;
      this._add(cable, true, false);
    }

    /* towers */
    const towerParts = [];
    for (const z of towerZ) {
      const y = skiHeight(LX, z);
      const h = 7.4 - 0.2;
      towerParts.push(xform(new THREE.CylinderGeometry(0.22, 0.34, h, 10), LX, y + h / 2, z));
      towerParts.push(xform(new THREE.BoxGeometry(4.0, 0.24, 0.3), LX, y + h, z));
      towerParts.push(xform(new THREE.BoxGeometry(1.1, 0.9, 0.9), LX, y + 0.45, z));
      for (const off of [-1.5, 1.5]) {
        towerParts.push(
          xform(new THREE.CylinderGeometry(0.16, 0.16, 0.16, 10), LX + off, y + h + 0.2, z, Math.PI / 2)
        );
      }
    }
    const towers = new THREE.Mesh(mergeGeometries(towerParts), galv);
    towers.matrixAutoUpdate = false;
    this._add(towers, true, true);

    /* stations */
    for (const [z, label] of [[zBase, 'base'], [zTop, 'top']]) {
      const y = skiHeight(LX, z);
      const parts = [];
      parts.push(xform(new THREE.BoxGeometry(9, 0.4, 7), LX, y + 0.2, z));
      parts.push(xform(new THREE.BoxGeometry(9, 0.3, 7), LX, y + 6.4, z));
      for (const [ox, oz] of [[-4.1, -3.1], [4.1, -3.1], [-4.1, 3.1], [4.1, 3.1]]) {
        parts.push(xform(new THREE.CylinderGeometry(0.19, 0.19, 6.2, 8), LX + ox, y + 3.3, z + oz));
      }
      parts.push(xform(new THREE.CylinderGeometry(1.6, 1.6, 0.5, 20), LX, y + 6.0, z, Math.PI / 2));
      const st = new THREE.Mesh(mergeGeometries(parts), galv);
      st.name = `lift-${label}`;
      st.matrixAutoUpdate = false;
      this._add(st, true, true);
      this.track(this.physics.addBox(LX, y + 3.3, z, 4.5, 3.4, 3.5, { layer: COLLISION_LAYER.WORLD }));
    }

    /* chairs - four-seaters with a bubble bar, animated in update() */
    const chairGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.05, 0.05, 2.1, 6).translate(0, 1.05, 0),
      new THREE.BoxGeometry(2.3, 0.12, 0.62).translate(0, 0.0, 0),
      new THREE.BoxGeometry(2.3, 0.75, 0.1).translate(0, 0.36, -0.3),
      new THREE.BoxGeometry(2.3, 0.08, 0.1).translate(0, 0.62, 0.34),
      new THREE.BoxGeometry(0.09, 0.5, 0.09).translate(-1.1, 0.28, 0.3),
      new THREE.BoxGeometry(0.09, 0.5, 0.09).translate(1.1, 0.28, 0.3),
    ]);
    const chairMat = this._mat(
      'chair.lift',
      new THREE.MeshStandardMaterial({ color: 0xd94f2b, roughness: 0.45, metalness: 0.3, envMapIntensity: 1.2 })
    );
    this._chairCount = 16;
    this._chairs = new THREE.InstancedMesh(chairGeo, chairMat, this._chairCount);
    this._chairs.castShadow = true;
    this._chairs.frustumCulled = false;
    this._chairs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this._chairs);
    this._chairSpan = Math.abs(zTop - zBase);
  }

  /**
   * The alpine lodge, at roughly 3.5x its previous volume.
   *
   * At 17 x 4.6 x 11 this read as a single small brown box beside a 50 m
   * mountain - a shed, not a destination. A landmark building has to hold its
   * own against the landform it sits under, so: 26 x 7.2 x 16 with a full first
   * floor, a two-pitch roof with deep eaves and a ridge, a warm lit interior
   * behind the glazing (the only interior light in the world, and the thing
   * that makes it read as somewhere you could go), and a deck wide enough for
   * the piste-side crowd to actually stand on.
   */
  _buildLodge(wood, dark) {
    void dark;
    const beam = this._materials.get('wood.beam');
    const cx = -46;
    const cz = -64;
    const W = 26;
    const D = 16;
    const Hb = 7.2;

    const body = this._box(W, Hb, D, wood, cx, Hb / 2, cz);
    this._solid(body);
    // Stone plinth: the building sits on ground rather than on a line.
    this._add(this._box(W + 1.2, 0.9, D + 1.2, this._materials.get('concrete.deck'), cx, 0.45, cz), true, true);
    /*
     * Contact skirt around the whole footprint.
     *
     * The lodge met the terrain along a perfectly straight, undarkened line and
     * read as a decal pasted onto the hillside. It does cast into the far
     * cascade, but that cascade is 29 cm per texel with a 12 cm normal bias -
     * which is a metre of penumbra slop at a wall base and no contact term at
     * all. The decal pass already exists; a ring of overlapping spots around
     * the plinth gives the building the ~1 m of ambient occlusion that sells
     * "sitting in the ground" rather than "resting on it".
     */
    for (let i = 0; i < 18; i++) {
      const t = i / 18;
      const a = t * Math.PI * 2;
      const ex = (W + 2.6) / 2;
      const ez = (D + 2.6) / 2;
      // Walk the rectangle, not a circle - a building's occlusion follows its
      // own plan.
      const k = Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
      this._props?.grounding?.push([cx + (Math.cos(a) / k) * ex, cz + (Math.sin(a) / k) * ez, 3.4]);
    }

    // Steep alpine roof with deep eaves and a ridge cap.
    const roofParts = [];
    for (const dir of [-1, 1]) {
      const r = new THREE.BoxGeometry(W + 4.0, 0.42, D * 0.72);
      xform(r, cx, Hb + 2.7, cz + dir * (D * 0.21), dir * -0.55);
      roofParts.push(r);
    }
    roofParts.push(xform(new THREE.BoxGeometry(W + 4.4, 0.34, 0.9), cx, Hb + 5.0, cz));
    // Purlins under the eaves, which is what gives a chalet roof its weight.
    for (let i = 0; i <= 8; i++) {
      const px = cx - (W + 3.2) / 2 + (i / 8) * (W + 3.2);
      for (const dir of [-1, 1]) {
        roofParts.push(xform(new THREE.BoxGeometry(0.18, 0.34, 1.2), px, Hb + 1.5, cz + dir * (D * 0.42 + 0.4)));
      }
    }
    const roof = new THREE.Mesh(mergeGeometries(roofParts), beam);
    roof.matrixAutoUpdate = false;
    this._add(roof);
    // Gable infill.
    for (const dir of [-1, 1]) {
      const gable = new THREE.Mesh(new THREE.CylinderGeometry(5.4, 5.4, 0.5, 3, 1), wood);
      gable.rotation.x = Math.PI / 2;
      gable.rotation.z = Math.PI;
      gable.position.set(cx + dir * (W / 2 + 0.2), Hb + 2.6, cz);
      this._add(gable);
    }

    // Deck facing the piste, with a balustrade. Its own tiling so the boards
    // land at ~15 cm rather than the 70 cm the shared wall repeat produced.
    const deckMat = this._mat('wood.deck', wood.clone());
    deckMat.map = this._registerTex('wood.deck.map', wood.map.clone());
    deckMat.map.repeat.set(16, 6);
    deckMat.map.needsUpdate = true;
    if (wood.normalMap) {
      deckMat.normalMap = this._registerTex('wood.deck.normal', wood.normalMap.clone());
      deckMat.normalMap.repeat.set(16, 6);
      deckMat.normalMap.needsUpdate = true;
    }
    const dz = cz + D / 2 + 4.0;
    const deck = this._box(W, 0.35, 8, deckMat, cx, 0.72, dz);
    this._solid(deck);
    const rails = [];
    for (let i = 0; i <= 24; i++) {
      rails.push(xform(new THREE.BoxGeometry(0.11, 1.0, 0.11), cx - W / 2 + i * (W / 24), 1.4, dz + 3.9));
    }
    rails.push(xform(new THREE.BoxGeometry(W, 0.13, 0.18), cx, 1.94, dz + 3.9));
    rails.push(xform(new THREE.BoxGeometry(0.18, 0.13, 8), cx - W / 2, 1.94, dz));
    rails.push(xform(new THREE.BoxGeometry(0.18, 0.13, 8), cx + W / 2, 1.94, dz));
    // Steps down to the piste.
    for (let i = 0; i < 4; i++) {
      rails.push(xform(new THREE.BoxGeometry(3.2, 0.18, 0.5), cx, 0.72 - i * 0.19, dz + 4.3 + i * 0.5));
    }
    const balustrade = new THREE.Mesh(mergeGeometries(rails), beam);
    balustrade.matrixAutoUpdate = false;
    this._add(balustrade);

    /*
     * Lit interior. The lodge is the only building in the world that should
     * read as occupied, and a warm emissive pane behind cool alpine glazing is
     * what does it in one draw call - no interior geometry, no second light.
     */
    const interior = this._mat(
      'lodge.interior',
      new THREE.MeshStandardMaterial({
        color: 0x30210f,
        emissive: 0xffb257,
        emissiveIntensity: 1.5,
        roughness: 0.9,
      })
    );
    const glass = this._materials.get('glass.window');
    const winGeos = [];
    const litGeos = [];
    const fz = cz + D / 2;
    for (const ox of [-9.5, -5.7, -1.9, 1.9, 5.7, 9.5]) {
      for (const [wy, wh] of [[3.0, 2.3], [5.9, 1.7]]) {
        winGeos.push(xform(new THREE.BoxGeometry(3.0, wh, 0.12), cx + ox, wy, fz + 0.07));
        litGeos.push(xform(new THREE.BoxGeometry(2.72, wh - 0.24, 0.04), cx + ox, wy, fz - 0.02));
      }
    }
    const win = new THREE.Mesh(mergeGeometries(winGeos), glass);
    win.matrixAutoUpdate = false;
    this._add(win, false, false);
    const lit = new THREE.Mesh(mergeGeometries(litGeos), interior);
    lit.matrixAutoUpdate = false;
    this._add(lit, false, false);
    const door = this._box(2.2, 2.8, 0.16, beam, cx, 1.95, fz + 0.08);
    this._add(door, false, true);

    // Stone chimney, now scaled to the building it serves.
    const chim = this._box(2.2, 13.0, 2.2, this._materials.get('concrete.deck'), cx - W / 2 + 3.0, 6.5, cz - 4.5);
    this._solid(chim);

    // Legible signage on the gable. The piste establishing shot puts this
    // corner of the lodge in frame, and a blank stained-timber panel there
    // reads as an unfinished asset.
    const lodgeSign = this._signBoard(10.5, 2.1, 'MERIDIAN ALPINE LODGE', 0x241610, 0xffd9a0, 'SKI HIRE  •  LESSONS  •  BAR');
    lodgeSign.position.set(cx, Hb + 1.9, fz + 0.2);
    this._add(lodgeSign);
  }

  /** Triangle fan across a closed 2D outline - used for the track infield. */
  _fan(points, cx, cz, y, material) {
    const n = points.length;
    const pos = new Float32Array((n + 1) * 3);
    const uv = new Float32Array((n + 1) * 2);
    const ov = new Float32Array((n + 1) * 2);
    const nrm = new Float32Array((n + 1) * 3);
    const setV = (i, x, z) => {
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
      nrm[i * 3 + 1] = 1;
      uv[i * 2] = x / 12;
      uv[i * 2 + 1] = z / 12;
      ov[i * 2] = x / 400 + 0.5;
      ov[i * 2 + 1] = z / 400 + 0.5;
    };
    setV(0, cx, cz);
    for (let i = 0; i < n; i++) setV(i + 1, points[i][0], points[i][1]);
    const idx = new Uint32Array(n * 3);
    for (let i = 0; i < n; i++) {
      idx[i * 3] = 0;
      idx[i * 3 + 1] = i + 1;
      idx[i * 3 + 2] = ((i + 1) % n) + 1;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('uvOverlay', new THREE.BufferAttribute(ov, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    orientUp(geo);
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, material);
    m.matrixAutoUpdate = false;
    return m;
  }

  /* ---------------------------------------------------------------- */
  /* Running track                                                     */
  /* ---------------------------------------------------------------- */

  _buildTrack() {
    const half = (TRACK.lanes * TRACK.laneW) / 2;
    const mid = TRACK.inner + half;
    const centre = ovalPath(TRACK.cx, TRACK.cz, TRACK.straight, mid, 44, 16);
    const surf = new THREE.Mesh(
      // Sits just above the grass but under the walkable ground plane, so feet
      // never visibly sink into the rubber.
      ribbon(centre, half, 0.028, true, 1 / 8),
      this._materials.get('rubber.track')
    );
    surf.matrixAutoUpdate = false;
    this._add(surf, false, true);

    // Inner kerb: white raised rail that defines lane 1.
    const kerbPath = ovalPath(TRACK.cx, TRACK.cz, TRACK.straight, TRACK.inner - 0.12, 44, 16);
    const kerb = new THREE.Mesh(
      ribbon(kerbPath, 0.13, 0.12, true, 1),
      this._materials.get('metal.white')
    );
    kerb.matrixAutoUpdate = false;
    this._add(kerb, false, true);
    const kerbSide = new THREE.Mesh(
      new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3(
          kerbPath.map((p) => new THREE.Vector3(p[0], 0.06, p[1])),
          true,
          'catmullrom',
          0.5
        ),
        200,
        0.06,
        6,
        true
      ),
      this._materials.get('metal.white')
    );
    kerbSide.matrixAutoUpdate = false;
    this._add(kerbSide, true, true);

    // Mown infield with a long-jump runway and pit.
    const infield = ovalPath(TRACK.cx, TRACK.cz, TRACK.straight, TRACK.inner - 0.4, 44, 16);
    this._add(this._fan(infield, TRACK.cx, TRACK.cz, 0.0, this._materials.get('grass.field')), false, true);

    const sand = this._mat(
      'sand.pit',
      new THREE.MeshStandardMaterial({ color: 0xe0cf9e, roughness: 1 })
    );
    this._add(this._slab(TRACK.cx - 14, TRACK.cz - 22, TRACK.cx - 5, TRACK.cz - 19, 0.05, sand), false, true);
    this._add(
      this._slab(TRACK.cx - 5, TRACK.cz - 21.6, TRACK.cx + 30, TRACK.cz - 19.4, 0.055,
        this._materials.get('rubber.plain'), 0.5),
      false,
      true
    );

    /* ---- start / finish markings on the home straight ---- */
    // The home straight is the southern one (the gantry sits outside it), so
    // lane 1 runs at z = cz - inner and the outer lane at z = cz - inner - 9.76.
    const z1 = TRACK.cz - TRACK.inner;
    const paint = this._materials.get('paint.court');
    const lineGeos = [];
    // Finish line, and the eight staggered curve starts that make an oval read
    // as a *track* rather than as a red ring.
    lineGeos.push(
      xform(new THREE.BoxGeometry(0.09, 0.01, TRACK.lanes * TRACK.laneW),
        TRACK.cx, 0.034, z1 - (TRACK.lanes * TRACK.laneW) / 2)
    );
    for (let i = 0; i < TRACK.lanes; i++) {
      // Stagger: each outer lane starts further round by 2*pi*laneW per lap.
      const back = i * 2 * Math.PI * TRACK.laneW * 0.5;
      lineGeos.push(
        xform(new THREE.BoxGeometry(0.09, 0.01, TRACK.laneW),
          TRACK.cx - 30 + (back % 44), 0.034, z1 - TRACK.laneW * (i + 0.5))
      );
    }
    const lines = new THREE.Mesh(mergeGeometries(lineGeos), paint);
    lines.matrixAutoUpdate = false;
    this._add(lines, false, false);

    // Lane numerals, one quad per lane off the 8-cell atlas.
    const numGeos = [];
    for (let i = 0; i < TRACK.lanes; i++) {
      const g = new THREE.PlaneGeometry(0.92, 0.92);
      const uv = g.getAttribute('uv');
      for (let k = 0; k < uv.count; k++) uv.setXY(k, (i + uv.getX(k)) / 8, uv.getY(k));
      // rotateX(-90) lays the quad flat with its texture-up pointing at -Z;
      // the extra half turn puts it at +Z so the numeral reads right way up
      // from the home straight's grandstand side.
      g.rotateX(-Math.PI / 2);
      g.rotateY(Math.PI);
      g.translate(TRACK.cx + 2.4, 0.036, z1 - TRACK.laneW * (i + 0.5));
      numGeos.push(g);
    }
    const nums = new THREE.Mesh(mergeGeometries(numGeos), this._materials.get('paint.lane'));
    nums.matrixAutoUpdate = false;
    this._add(nums, false, false);

    // Start/finish gantry and a lane-number board.
    const galv = this._materials.get('metal.galv');
    const gz = TRACK.cz - (TRACK.inner + TRACK.lanes * TRACK.laneW) - 3.5;
    const gantry = [];
    for (const ox of [-6, 6]) {
      gantry.push(xform(new THREE.CylinderGeometry(0.13, 0.16, 5.2, 8), TRACK.cx + ox, 2.6, gz));
    }
    gantry.push(xform(new THREE.BoxGeometry(12.6, 0.26, 0.26), TRACK.cx, 5.15, gz));
    const gm = new THREE.Mesh(mergeGeometries(gantry), galv);
    this._add(gm);
    this.track(this.physics.addBox(TRACK.cx - 6, 2.6, gz, 0.2, 2.6, 0.2, {}));
    this.track(this.physics.addBox(TRACK.cx + 6, 2.6, gz, 0.2, 2.6, 0.2, {}));
    // Faces the home straight and the grandstand behind it - a scoreboard aimed
    // at the empty infield is a black rectangle from every angle a player can
    // stand in.
    const trackSign = this._add(
      this._signBoard(11.4, 1.5, 'MERIDIAN  •  400 m', 0x0f2233, 0xf4f8fb), true, true
    );
    trackSign.position.set(TRACK.cx, 4.3, gz);
    trackSign.rotation.y = Math.PI;
  }

  /**
   * Canvas-backed sign. Text is drawn into a texture rather than using any font
   * loader, which keeps the "no external assets" rule intact.
   */
  _signBoard(w, h, text, bg, fg, sub = '') {
    const cw = 1024;
    const chh = Math.max(64, Math.round((h / w) * cw));
    const c = makeCanvas(cw, chh);
    const ctx = c.getContext('2d');
    _color.set(bg);
    ctx.fillStyle = `#${_color.getHexString()}`;
    ctx.fillRect(0, 0, cw, chh);
    const grad = ctx.createLinearGradient(0, 0, 0, chh);
    grad.addColorStop(0, 'rgba(255,255,255,0.16)');
    grad.addColorStop(0.5, 'rgba(0,0,0,0.0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.22)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, cw, chh);
    _color.set(fg);
    ctx.fillStyle = `#${_color.getHexString()}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.round(chh * (sub ? 0.42 : 0.52))}px system-ui, sans-serif`;
    ctx.fillText(text, cw / 2, sub ? chh * 0.38 : chh * 0.52);
    if (sub) {
      ctx.font = `500 ${Math.round(chh * 0.2)}px system-ui, sans-serif`;
      ctx.globalAlpha = 0.8;
      ctx.fillText(sub, cw / 2, chh * 0.72);
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, cw - 6, chh - 6);
    const tex = this._tex(c, { srgb: true, repeat: 1 });
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    // Self-lit: with a 6:1 key/fill ratio a dark board in shadow crushes to
    // pure black, which is what turned the scoreboards into empty quads.
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      emissiveMap: tex,
      emissive: 0xffffff,
      emissiveIntensity: 0.45,
      roughness: 0.5,
      metalness: 0.1,
    });
    this._materials.set(`sign.${text.slice(0, 12)}.${this._materials.size}`, mat);

    /*
     * Two meshes, not one six-material box.
     *
     * A BoxGeometry with a material array renders one draw call per geometry
     * group - six per sign, five of which are the same dark frame material.
     * With eleven signs in the world that was ~66 draw calls for what is
     * visually a frame and a face, and it was the single largest avoidable
     * item in the budget. A dark box plus a face quad is two.
     */
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, 0.16), this._materials.get('metal.dark')
    );
    body.castShadow = true;
    body.receiveShadow = true;
    const face = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.99, h * 0.99), mat);
    face.position.z = 0.082;
    face.castShadow = false;
    face.receiveShadow = false;
    group.add(body, face);
    return group;
  }

  /* ---------------------------------------------------------------- */
  /* Racquet courts                                                    */
  /* ---------------------------------------------------------------- */

  _buildCourts() {
    const deck = this._materials.get('concrete.deck');

    /* ---- slabs ---- */
    const tennis = this._slab(102.85, 7.7, 121.15, 44.3, 0.07, this._materials.get('court.tennis'));
    this._add(tennis, false, true);
    this.track(this.physics.addBox(112, -0.44, 26, 9.15, 0.5, 18.3, {}));

    for (const cz of [20.5, 31.5]) {
      const pc = this._slab(68.85, cz - 4.57, 87.15, cz + 4.57, 0.07, this._materials.get('court.pickle'));
      this._add(pc, false, true);
      this.track(this.physics.addBox(78, -0.44, cz, 9.15, 0.5, 4.57, {}));
    }
    // Apron tying the three courts together, kerbed and shouldered so the slab
    // is built into the ground rather than laid on top of it.
    this._add(this._slab(64, 4, 126, 48, 0.02, deck, 0.25), false, true);
    this._slabEdge(64, 4, 126, 48, 0.02, { kerbH: 0.3, shoulder: 1.9 });

    /* ---- nets ---- */
    this._buildNet(112, 26, 12.8, true, 1.07, 0.914, 1.09);
    for (const cz of [20.5, 31.5]) this._buildNet(78, cz, 6.71, false, 0.914, 0.86, 0.93);

    /* ---- chain-link enclosure ---- */
    const fenceMat = this._materials.get('fence.chain');
    const panels = [];
    const posts = [];
    const H = 4.0;
    const corners = [[64, 4], [126, 4], [126, 48], [64, 48]];
    for (let s = 0; s < 4; s++) {
      const a = corners[s];
      const b = corners[(s + 1) % 4];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.round(len / 3);
      for (let i = 0; i < steps; i++) {
        const t0 = i / steps;
        const t1 = (i + 1) / steps;
        const x0 = lerp(a[0], b[0], t0);
        const z0 = lerp(a[1], b[1], t0);
        const x1 = lerp(a[0], b[0], t1);
        const z1 = lerp(a[1], b[1], t1);
        // Leave a gate on the west side.
        if (s === 3 && i === Math.floor(steps / 2)) continue;
        const segLen = Math.hypot(x1 - x0, z1 - z0);
        const g = new THREE.PlaneGeometry(segLen, H, 1, 1);
        const uv = g.getAttribute('uv');
        // One alpha tile per metre of panel: any denser and the wires fall
        // below a texel at gameplay range and the mesh mips into a grey sheet.
        for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * segLen, uv.getY(k) * H);
        uv.needsUpdate = true;
        g.rotateY(-Math.atan2(z1 - z0, x1 - x0));
        g.translate((x0 + x1) / 2, H / 2, (z0 + z1) / 2);
        panels.push(g);
        posts.push([x0, 0, z0, 0, 0, 0, 1]);
      }
    }
    const fence = new THREE.Mesh(mergeGeometries(panels), fenceMat);
    fence.matrixAutoUpdate = false;
    this._add(fence, true, false);
    const galv = this._materials.get('metal.galv');
    this._instanced(
      new THREE.CylinderGeometry(0.05, 0.05, H + 0.25, 8).translate(0, (H + 0.25) / 2, 0),
      galv,
      posts
    );
    // Top rail, mid tension wire and bottom tension wire. Chain link is mostly
    // invisible past 40 m, so this frame is what actually reads at distance.
    const rails = [];
    for (const [y, t] of [[H - 0.04, 0.055], [H * 0.5, 0.022], [0.12, 0.03]]) {
      for (let s = 0; s < 4; s++) {
        const a = corners[s];
        const b = corners[(s + 1) % 4];
        rails.push(strut(a[0], y, a[1], b[0], y, b[1], t));
      }
    }
    const railMesh = new THREE.Mesh(mergeGeometries(rails), galv);
    railMesh.matrixAutoUpdate = false;
    this._add(railMesh, true, false);

    /*
     * Sponsor banners on the fence runs.
     *
     * 200 m of bare grey chain link across the middle of the courts frame is a
     * hundred metres of nothing: no colour, no scale reference, no sign that
     * anyone plays here. Banner mesh on the perimeter is what every real club
     * ground has and it is the cheapest possible way to break the run - four
     * designs in one atlas, one merged draw call, and they double as the only
     * saturated accent in that half of the frame.
     */
    {
      const bc = makeCanvas(512, 512);
      const bx = bc.getContext('2d');
      const designs = [
        ['#124a86', '#f2c419', 'MERIDIAN RACQUET CLUB'],
        ['#8c2230', '#f6efe2', 'EST. 1974  •  MEMBERS & GUESTS'],
        ['#1d5c48', '#e8f2c4', 'COURT HIRE  •  COACHING  •  LEAGUES'],
        ['#2b3138', '#7fd6e8', 'MERIDIAN ATHLETIC GROUNDS'],
      ];
      for (let i = 0; i < 4; i++) {
        const [bg, fg, text] = designs[i];
        const y = i * 128;
        bx.fillStyle = bg;
        bx.fillRect(0, y, 512, 128);
        // Weathering: banners live outdoors and go chalky along their top edge.
        const wash = bx.createLinearGradient(0, y, 0, y + 128);
        wash.addColorStop(0, 'rgba(255,255,255,0.16)');
        wash.addColorStop(0.45, 'rgba(255,255,255,0.02)');
        wash.addColorStop(1, 'rgba(0,0,0,0.18)');
        bx.fillStyle = wash;
        bx.fillRect(0, y, 512, 128);
        bx.fillStyle = fg;
        bx.fillRect(0, y + 8, 512, 5);
        bx.fillRect(0, y + 115, 512, 5);
        bx.font = 'bold 30px "Chakra Petch", "Rajdhani", sans-serif';
        bx.textAlign = 'center';
        bx.textBaseline = 'middle';
        bx.fillStyle = fg;
        bx.fillText(text, 256, y + 64);
        // Eyelets along the top and bottom hems.
        bx.fillStyle = 'rgba(200,206,210,0.85)';
        for (let e = 0; e < 8; e++) {
          bx.beginPath();
          bx.arc(34 + e * 63, y + 14, 3.4, 0, Math.PI * 2);
          bx.fill();
          bx.beginPath();
          bx.arc(34 + e * 63, y + 114, 3.4, 0, Math.PI * 2);
          bx.fill();
        }
      }
      const banMat = this._mat(
        'fence.banner',
        new THREE.MeshStandardMaterial({
          map: this._tex(bc, { srgb: true, repeat: 1, key: 'fence.banner.map' }),
          roughness: 0.86,
          metalness: 0.0,
          // FrontSide, with each banner built as two back-to-back quads. A
          // single DoubleSide quad shows MIRRORED type from behind, and half of
          // every fence run is behind you from any given camera.
          side: THREE.FrontSide,
          envMapIntensity: 0.4,
        })
      );
      const banners = [];
      let bi = 0;
      for (let s = 0; s < 4; s++) {
        const a = corners[s];
        const b = corners[(s + 1) % 4];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        // 3.4 m banners with a 2.6 m gap: a continuous ribbon would be a wall
        // again, and the gaps are what let the courts read through the run.
        const steps = Math.floor(len / 6.0);
        for (let i = 0; i < steps; i++) {
          const t = (i + 0.5) / steps;
          const px = lerp(a[0], b[0], t);
          const pz = lerp(a[1], b[1], t);
          const cell = bi % 4;
          const nx = -(b[1] - a[1]) / len;
          const nz = (b[0] - a[0]) / len;
          const face = (flip) => {
            const g = new THREE.PlaneGeometry(3.4, 1.15, 1, 1);
            const uv = g.getAttribute('uv');
            for (let k = 0; k < uv.count; k++) {
              uv.setXY(k, uv.getX(k), (3 - cell) * 0.25 + uv.getY(k) * 0.25);
            }
            uv.needsUpdate = true;
            // Rotating the quad about its own Y before it is placed flips the
            // UVs with it, so the reverse face reads the right way round.
            if (flip) g.rotateY(Math.PI);
            g.rotateY(-Math.atan2(b[1] - a[1], b[0] - a[0]));
            // Sagged and tilted a touch: banner mesh zip-tied to chain link
            // never hangs flat, and a perfectly planar row reads as decals.
            g.rotateX(-0.035 + (bi % 3) * 0.02);
            const off = flip ? -0.02 : 0.06;
            g.translate(px + nx * off, 1.28, pz + nz * off);
            return g;
          };
          banners.push(face(false), face(true));
          bi++;
        }
      }
      const banMesh = new THREE.Mesh(mergeGeometries(banners), banMat);
      banMesh.matrixAutoUpdate = false;
      this._add(banMesh, true, false);
    }
    // Contact darkening at the base of every third fence post.
    for (let i = 0; i < posts.length; i += 3) {
      this._props.grounding.push([posts[i][0], posts[i][2], 1.0]);
    }
    // Physical barrier so the player cannot walk through the mesh.
    for (const [cx, cz, hx, hz] of [
      [95, 4, 31, 0.12], [95, 48, 31, 0.12], [126, 26, 0.12, 22],
      // West run is split so the gate opening in the mesh is actually walkable.
      [64, 37.75, 0.12, 10.25], [64, 14.25, 0.12, 10.25],
    ]) {
      this.track(this.physics.addBox(cx, H / 2, cz, hx, H / 2, hz, { layer: COLLISION_LAYER.WORLD }));
    }

    /* ---- floodlight pylons ---- */
    this._buildPylons([[66, 6], [124, 6], [66, 46], [124, 46]], 15);

    /* ---- scoreboards, benches, hoppers ---- */
    // Faces of the boards point into the enclosure, not out at the rough - the
    // old orientation showed the blank steel back to every camera in the world.
    const board = this._signBoard(4.6, 2.4, 'COURT 1', 0x10202c, 0x9fe8ff, 'MERIDIAN RACQUET CLUB');
    board.position.set(112, 3.0, 4.4);
    this._add(board);
    const board2 = this._signBoard(4.0, 2.0, 'PICKLEBALL', 0x2a1218, 0xffd6a6, 'BOOK AT THE CLUBHOUSE');
    board2.position.set(78, 2.6, 4.4);
    this._add(board2);
    for (const p of [[100, 26, Math.PI / 2], [124.5, 26, -Math.PI / 2], [66.5, 26, Math.PI / 2], [90, 26, -Math.PI / 2]]) {
      this._props.benches.push([p[0], 0, p[1], 0, p[2], 0, 1]);
    }
    this._props.bins.push([100, 0, 10], [66.5, 0, 42]);
    this._props.hoppers.push([104, 0, 12, 0, 0.6, 0, 1], [89.5, 0, 26, 0, -0.3, 0, 1]);
  }

  /**
   * Real net geometry: individual strands plus a headband, with the correct
   * dip at the centre. A textured plane reads as cardboard from three metres.
   */
  _buildNet(cx, cz, width, alongX, hPost, hCentre, postH) {
    const half = width / 2;
    const top = (f) => lerp(hCentre, hPost, f * f); // f = |offset| / half
    const strands = [];
    const nV = Math.round(width / 0.13);
    for (let i = 0; i <= nV; i++) {
      const o = -half + (i / nV) * width;
      const h = top(Math.abs(o) / half);
      const ax = alongX ? cx + o : cx;
      const az = alongX ? cz : cz + o;
      strands.push(strut(ax, 0.01, az, ax, h, az, 0.008));
    }
    const nH = 8;
    for (let j = 1; j <= nH; j++) {
      const f = j / (nH + 1);
      const segs = 24;
      for (let i = 0; i < segs; i++) {
        const o0 = -half + (i / segs) * width;
        const o1 = -half + ((i + 1) / segs) * width;
        const y0 = top(Math.abs(o0) / half) * f;
        const y1 = top(Math.abs(o1) / half) * f;
        const a = alongX ? [cx + o0, y0, cz] : [cx, y0, cz + o0];
        const b = alongX ? [cx + o1, y1, cz] : [cx, y1, cz + o1];
        strands.push(strut(a[0], a[1], a[2], b[0], b[1], b[2], 0.008));
      }
    }
    const net = new THREE.Mesh(mergeGeometries(strands), this._materials.get('plastic.net'));
    net.matrixAutoUpdate = false;
    this._add(net, true, false);

    // White headband along the sagging top edge.
    const tape = [];
    const segs = 24;
    for (let i = 0; i < segs; i++) {
      const o0 = -half + (i / segs) * width;
      const o1 = -half + ((i + 1) / segs) * width;
      const y0 = top(Math.abs(o0) / half);
      const y1 = top(Math.abs(o1) / half);
      const a = alongX ? [cx + o0, y0, cz] : [cx, y0, cz + o0];
      const b = alongX ? [cx + o1, y1, cz] : [cx, y1, cz + o1];
      tape.push(strut(a[0], a[1], a[2], b[0], b[1], b[2], 0.06));
    }
    const tapeMesh = new THREE.Mesh(mergeGeometries(tape), this._materials.get('plastic.netTape'));
    tapeMesh.matrixAutoUpdate = false;
    this._add(tapeMesh, true, false);

    // Posts.
    const galv = this._materials.get('metal.galv');
    for (const s of [-1, 1]) {
      const px = alongX ? cx + s * (half + 0.06) : cx;
      const pz = alongX ? cz : cz + s * (half + 0.06);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, postH, 10), galv);
      post.position.set(px, postH / 2, pz);
      this._solid(post);
    }
  }

  /**
   * Floodlight masts. Lamps are emissive-only - it is midday, they are off.
   *
   * @param {Array<[number,number]>} spots world x/z bases.
   * @param {number} height metres to the head.
   * @param {object} [opts]
   * @param {[number,number]} [opts.aim] point the heads are turned toward.
   * @param {(x:number,z:number)=>number} [opts.baseFn] ground height sampler.
   */
  _buildPylons(spots, height, opts = {}) {
    const aimX = opts.aim ? opts.aim[0] : 105;
    const aimZ = opts.aim ? opts.aim[1] : 95;
    const baseFn = opts.baseFn ?? (() => 0);
    const galv = this._materials.get('metal.galv');
    const lampMat = this._materials.get('lamp.flood') ?? this._mat(
      'lamp.flood',
      new THREE.MeshStandardMaterial({
        color: 0xd8dfe4,
        // A 0.28-rough metal lens catches a sub-pixel sun lobe and clips to
        // white through bloom, which read as "the floodlights are on at noon".
        roughness: 0.42,
        metalness: 0.5,
        emissive: 0x1a2c38,
        emissiveIntensity: 0.6,
      })
    );
    const mastParts = [];
    mastParts.push(new THREE.CylinderGeometry(0.16, 0.3, height, 10).translate(0, height / 2, 0));
    mastParts.push(new THREE.BoxGeometry(3.4, 0.16, 0.4).translate(0, height - 0.4, 0));
    for (let i = 0; i < 4; i++) {
      mastParts.push(new THREE.BoxGeometry(0.42, 0.34, 0.5).translate(-1.35 + i * 0.9, height, 0.28));
    }
    const mastGeo = mergeGeometries(mastParts);
    const lampGeo = new THREE.BoxGeometry(0.7, 0.5, 0.06);
    const lamps = [];
    const masts = [];
    for (const [x, z] of spots) {
      const ry = Math.atan2(aimZ - z, aimX - x) + Math.PI / 2;
      const by = baseFn(x, z);
      masts.push([x, by, z, 0, ry, 0, 1]);
      for (let i = 0; i < 4; i++) {
        _v1.set(-1.35 + i * 0.9, height, 0.56);
        _e1.set(0, ry, 0);
        _q1.setFromEuler(_e1);
        _v1.applyQuaternion(_q1);
        lamps.push([x + _v1.x, by + _v1.y, z + _v1.z, -0.5, ry, 0, 1]);
      }
    }
    this._instanced(mastGeo, galv, masts);
    this._instanced(lampGeo, lampMat, lamps);
    for (const [x, z] of spots) {
      const by = baseFn(x, z);
      this.track(this.physics.addBox(x, by + height / 2, z, 0.3, height / 2, 0.3, {}));
      this._props?.grounding?.push([x, z, 2.2]);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Swimming pool                                                     */
  /* ---------------------------------------------------------------- */

  _buildPool() {
    const deckMat = this._materials.get('concrete.deck');
    const tile = this._materials.get('tile.pool');
    const galv = this._materials.get('metal.galv');
    const bx0 = 32, bx1 = 60, bz0 = 103, bz1 = 119;

    /* ---- deck ---- */
    const decks = [
      [25, 100, 32, 125], [60, 100, 75, 125], [32, 100, 60, 103], [32, 119, 60, 125],
    ];
    for (const [x0, z0, x1, z1] of decks) {
      this._add(this._slab(x0, z0, x1, z1, 0.1, deckMat, 0.35), false, true);
      this.track(
        this.physics.addBox((x0 + x1) / 2, -0.4, (z0 + z1) / 2, (x1 - x0) / 2, 0.5, (z1 - z0) / 2, {})
      );
    }

    /* ---- basin ---- */
    // Sloping floor: 1.2 m at the blocks, 3.0 m under the boards.
    const floor = new THREE.Mesh(new THREE.BoxGeometry(28.06, 0.3, 16), tile);
    floor.position.set(46, -2.25, 111);
    floor.rotation.z = -Math.atan2(1.8, 28); // 1.2 m at the blocks, 3.0 m at the boards
    this._solid(floor, { castShadow: false });

    const wallSpecs = [
      [bx0 - 0.15, 111, 0.15, 8.3],
      [bx1 + 0.15, 111, 0.15, 8.3],
      [46, bz0 - 0.15, 14.3, 0.15],
      [46, bz1 + 0.15, 14.3, 0.15],
    ];
    for (const [cx, cz, hx, hz] of wallSpecs) {
      const w = this._box(hx * 2, 3.4, hz * 2, tile, cx, -1.6, cz);
      this._solid(w, { castShadow: false });
    }

    /* ---- coping ---- */
    const copingMat = this._mat(
      'tile.coping',
      new THREE.MeshStandardMaterial({ color: 0xf0f2f0, roughness: 0.35, metalness: 0.02, envMapIntensity: 1.2 })
    );
    const cop = [];
    cop.push(xform(new THREE.BoxGeometry(28.9, 0.1, 0.45), 46, 0.13, bz0 - 0.22));
    cop.push(xform(new THREE.BoxGeometry(28.9, 0.1, 0.45), 46, 0.13, bz1 + 0.22));
    cop.push(xform(new THREE.BoxGeometry(0.45, 0.1, 16.9), bx0 - 0.22, 0.13, 111));
    cop.push(xform(new THREE.BoxGeometry(0.45, 0.1, 16.9), bx1 + 0.22, 0.13, 111));
    const copMesh = new THREE.Mesh(mergeGeometries(cop), copingMat);
    copMesh.matrixAutoUpdate = false;
    this._add(copMesh, false, true);

    /* ---- water ---- */
    const waterGeo = new THREE.PlaneGeometry(bx1 - bx0, bz1 - bz0, 48, 28);
    waterGeo.rotateX(-Math.PI / 2);
    waterGeo.translate((bx0 + bx1) / 2, -0.22, (bz0 + bz1) / 2);
    this._water = new THREE.Mesh(waterGeo, this._materials.get('water.pool'));
    this._water.renderOrder = 2;
    this._water.matrixAutoUpdate = false;
    this.group.add(this._water);

    /* ---- lane ropes ---- */
    const discGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.12, 8);
    discGeo.rotateZ(Math.PI / 2);
    whiteColor(discGeo);
    const discs = [];
    for (let r = 1; r <= 7; r++) {
      const z = bz0 + r * 2;
      for (let i = 0; i < 176; i++) {
        discs.push([bx0 + 0.15 + i * 0.157, -0.17, z, 0, 0, 0, 1]);
      }
    }
    this._laneRopes = this._instanced(discGeo, this._materials.get('plastic.seat'), discs, false, false);
    // Blue / yellow / red banding marks the last five metres of each lane.
    for (let i = 0; i < discs.length; i++) {
      const idx = i % 176;
      const near = idx < 31 || idx > 144;
      _color.setHex(near ? 0xe23b2e : idx % 2 ? 0x1c4fd8 : 0xf2c419);
      this._laneRopes.setColorAt(i, _color);
    }
    if (this._laneRopes.instanceColor) this._laneRopes.instanceColor.needsUpdate = true;

    /* ---- starting blocks ---- */
    const blockGeo = mergeGeometries([
      new THREE.BoxGeometry(0.65, 0.66, 0.72).translate(0, 0.33, 0),
      new THREE.BoxGeometry(0.7, 0.06, 0.78).translate(0, 0.68, -0.02),
      new THREE.CylinderGeometry(0.03, 0.03, 0.5, 6).rotateZ(Math.PI / 2).translate(0, 0.32, 0.4),
    ]);
    const blockMat = this._mat(
      'block.start',
      new THREE.MeshStandardMaterial({ color: 0x1b6fd0, roughness: 0.42, metalness: 0.2 })
    );
    const blocks = [];
    for (let i = 0; i < 8; i++) blocks.push([bx0 - 0.75, 0.1, bz0 + 1 + i * 2, 0, 0, 0, 1]);
    this._instanced(blockGeo, blockMat, blocks);

    /* ---- diving boards ---- */
    const platform = [];
    platform.push(xform(new THREE.BoxGeometry(1.2, 3.2, 1.2), 65.5, 1.6, 111));
    platform.push(xform(new THREE.BoxGeometry(2.2, 0.16, 2.2), 65.5, 3.28, 111));
    const plat = new THREE.Mesh(mergeGeometries(platform), galv);
    this._solid(plat);
    const boardMat = this._mat(
      'board.dive',
      new THREE.MeshStandardMaterial({ color: 0xe8eef1, roughness: 0.55 })
    );
    const board3 = this._box(6.2, 0.12, 0.55, boardMat, 61.8, 3.36, 111);
    this._solid(board3);
    const springStand = this._box(0.5, 1.1, 0.5, galv, 62.6, 0.65, 114.5);
    this._solid(springStand);
    const spring = this._box(4.6, 0.1, 0.5, boardMat, 60.2, 1.25, 114.5);
    this._solid(spring);
    // Handrails on the tower.
    const hr = [];
    for (const oz of [-0.85, 0.85]) {
      hr.push(strut(65.5, 3.36, 111 + oz, 65.5, 4.3, 111 + oz, 0.06));
      hr.push(strut(64.6, 4.3, 111 + oz, 66.4, 4.3, 111 + oz, 0.06));
    }
    const hrm = new THREE.Mesh(mergeGeometries(hr), galv);
    this._add(hrm);

    /* ---- ladders + lifeguard chair ---- */
    const lad = [];
    for (const z of [106, 116]) {
      lad.push(strut(bx1 + 0.1, 0.5, z - 0.25, bx1 + 0.1, -1.4, z - 0.25, 0.05));
      lad.push(strut(bx1 + 0.1, 0.5, z + 0.25, bx1 + 0.1, -1.4, z + 0.25, 0.05));
      for (let i = 0; i < 4; i++) {
        lad.push(strut(bx1 + 0.1, 0.2 - i * 0.4, z - 0.25, bx1 + 0.1, 0.2 - i * 0.4, z + 0.25, 0.045));
      }
    }
    const ladders = new THREE.Mesh(mergeGeometries(lad), galv);
    this._add(ladders);

    const chair = [];
    chair.push(xform(new THREE.BoxGeometry(1.3, 0.12, 1.1), 30.5, 2.3, 111));
    chair.push(xform(new THREE.BoxGeometry(1.3, 1.0, 0.12), 30.5, 2.8, 110.5));
    for (const [ox, oz] of [[-0.55, -0.45], [0.55, -0.45], [-0.55, 0.45], [0.55, 0.45]]) {
      chair.push(xform(new THREE.CylinderGeometry(0.06, 0.06, 2.3), 30.5 + ox, 1.15, 111 + oz));
    }
    const lg = new THREE.Mesh(mergeGeometries(chair), this._materials.get('metal.white'));
    this._solid(lg);

    this._props.benches.push([28.5, 0.1, 104, 0, Math.PI / 2, 0, 1], [28.5, 0.1, 118, 0, Math.PI / 2, 0, 1]);
    this._props.bins.push([72, 0.1, 103], [72, 0.1, 122]);

    const poolSign = this._signBoard(6.0, 1.6, 'MERIDIAN LIDO', 0x083a4e, 0xd8f6ff, '28 m  •  8 LANES  •  NO DIVING IN THE SHALLOW END');
    poolSign.position.set(50, 2.4, 99.6);
    poolSign.rotation.y = Math.PI;
    this._add(poolSign);
  }

  /* ---------------------------------------------------------------- */
  /* Buildings, stands and the entrance                                */
  /* ---------------------------------------------------------------- */

  _buildStructures() {
    const deck = this._materials.get('concrete.deck');
    const galv = this._materials.get('metal.galv');
    const glass = this._materials.get('glass.window');

    /* ---- bleachers ---- */
    /*
     * Rebuilt as a real raked stand rather than a solid wedge.
     *
     * The previous version pushed one `BoxGeometry(width, y + 0.5, 0.85)` per
     * row from GROUND LEVEL up to that row's height, so the whole thing was a
     * filled concrete ramp with seats stuck on it: no aisle, no nosing shadow
     * between rows, no understructure, no daylight anywhere - and, because
     * BoxGeometry gives every face a 0..1 UV, a 42 m front face stretched its
     * concrete tile 42:1 into horizontal smear bands. Occupying 35-45% of the
     * courts frame, it was the single largest untextured object in the world.
     *
     * Now: 0.10 m treads on 0.45 m risers, carried on raked galvanised
     * stringers with X bracing so the underside is an open shaded void; a dark
     * 45 mm nosing strip along every tread lip (this is what gives a stand its
     * horizontal banding at 30 m); walkable aisles with handrails cut through
     * the seat grid; and every merged box run through `boxProjectUV` so texel
     * density is uniform in world metres.
     */
    const riser = this._mat(
      'concrete.riser',
      new THREE.MeshStandardMaterial({
        map: deck.map,
        normalMap: deck.normalMap,
        roughnessMap: deck.roughnessMap,
        // ~20% below the deck. At the old value the stand was the brightest
        // surface in the courts frame - brighter than the sky's lower band and
        // brighter than the seat plastics it was supposed to sit behind, which
        // inverted the whole tonal hierarchy of the shot.
        color: 0x8d8a83,
        roughness: 0.94,
        normalScale: new THREE.Vector2(0.75, 0.75),
        envMapIntensity: 0.34,
      })
    );
    this._flattenFar(riser, 80, { clouds: 0.8, desat: 0.9 });
    const nosingMat = this._mat(
      'concrete.nosing',
      new THREE.MeshStandardMaterial({ color: 0x35352f, roughness: 0.9, metalness: 0.05 })
    );

    const seatGeo = whiteColor(mergeGeometries([
      new THREE.BoxGeometry(0.46, 0.07, 0.42).translate(0, 0.4, 0),
      new THREE.BoxGeometry(0.46, 0.34, 0.06).translate(0, 0.55, -0.19),
    ]));
    const seatPlacements = [];
    const seatRows = [];
    const stands = [
      [-95, -9, 30, 7, 0],
      [105, -157, 42, 8, 0],
      [95, 55, 30, 6, Math.PI],
      [-95, 84, 26, 5, Math.PI],
    ];
    const stepGeos = [];
    const nosingGeos = [];
    const standFrame = [];
    const RISE = 0.45;
    const GOING = 0.85;
    // Where the crowd sits. Filled while the seat grid is being laid out so the
    // figures land exactly on a seat rather than being scattered near one.
    const crowdSeats = [];
    for (let si = 0; si < stands.length; si++) {
      const [cx, cz, width, rows, ry] = stands[si];
      const dir = ry === 0 ? -1 : 1;
      // Stands sit outside the levelled pads, so each one is set on the terrace
      // its own footprint sits on.
      const y0 = parkHeight(cx, cz);
      const half = width / 2;

      // Aisles roughly every 10 m, never at the ends.
      const aisleCount = Math.max(2, Math.round(width / 10) - 1);
      const aisleX = [];
      for (let a = 0; a < aisleCount; a++) {
        aisleX.push(cx - half + ((a + 1) / (aisleCount + 1)) * width);
      }
      const inAisle = (x) => {
        for (let a = 0; a < aisleX.length; a++) if (Math.abs(x - aisleX[a]) < 0.72) return true;
        return false;
      };

      for (let r = 0; r < rows; r++) {
        const y = RISE * (r + 1);
        const z = cz + dir * (r * GOING);
        const frontZ = z - dir * (GOING / 2);
        // Tread: a 10 cm slab, not a solid block down to grade.
        stepGeos.push(xform(new THREE.BoxGeometry(width, 0.10, GOING), cx, y0 + y - 0.05, z));
        // Riser: the vertical face under the tread lip.
        stepGeos.push(
          xform(new THREE.BoxGeometry(width, RISE - 0.10, 0.09), cx, y0 + y - 0.10 - (RISE - 0.10) / 2, frontZ + dir * 0.045)
        );
        // Nosing strip. 45 mm of dark, slightly proud of the riser - the single
        // detail that makes a raked stand read as tiered seating at distance.
        nosingGeos.push(
          xform(new THREE.BoxGeometry(width + 0.04, 0.05, 0.06), cx, y0 + y - 0.075, frontZ - dir * 0.015)
        );
        // Collision stays a filled block: it is invisible, it costs nothing,
        // and it keeps the player from dropping through the open deck.
        this.track(this.physics.addBox(cx, y0 + y / 2, z, half, y / 2, GOING / 2, {}));

        const seats = Math.floor(width / 0.55);
        for (let s = 0; s < seats; s++) {
          const sx = cx - half + 0.3 + s * 0.55;
          if (inAisle(sx)) continue;
          seatPlacements.push([sx, y0 + y, z - dir * 0.16, 0, ry, 0, 1]);
          seatRows.push(r);
          crowdSeats.push([sx, y0 + y, z - dir * 0.16, ry, si]);
        }
      }

      const deckTop = y0 + RISE * rows;
      const frontZ0 = cz - dir * (GOING / 2);
      const backZ = cz + dir * ((rows - 1) * GOING + GOING / 2);

      /* ---- open understructure ---- */
      const stringers = Math.max(3, Math.round(width / 7) + 1);
      const sxs = [];
      for (let i = 0; i < stringers; i++) sxs.push(cx - half + (i / (stringers - 1)) * width);
      for (let i = 0; i < stringers; i++) {
        const px = sxs[i];
        // Raked I-section under the treads, front sill to back head. Mostly
        // hidden under the deck, but it is what the side elevation reads as.
        standFrame.push(strut(px, y0 + 0.28, frontZ0, px, deckTop - 0.30, backZ, 0.22));
        // Rear leg.
        standFrame.push(
          xform(new THREE.BoxGeometry(0.18, deckTop - 0.30 - y0, 0.18), px, (y0 + deckTop - 0.30) / 2, backZ)
        );
        // X bracing between bays, so the void under the deck has structure in it
        // instead of being an empty shadow.
        if (i < stringers - 1) {
          const nx = sxs[i + 1];
          standFrame.push(strut(px, y0 + 0.3, backZ, nx, deckTop - 0.4, backZ, 0.075));
          standFrame.push(strut(nx, y0 + 0.3, backZ, px, deckTop - 0.4, backZ, 0.075));
        }
      }
      // Grounding decals along the front sill and the rear legs.
      const gN = Math.ceil(width / 3.5);
      for (let t = 0; t <= gN; t++) {
        const gx = cx - half + (t / gN) * width;
        this._props.grounding.push([gx, frontZ0 + dir * 0.35, 2.4]);
        this._props.grounding.push([gx, backZ, 1.8]);
      }

      /* ---- back wall + rail ---- */
      const back = RISE * rows;
      const bz = cz + dir * (rows * GOING);
      stepGeos.push(xform(new THREE.BoxGeometry(width + 0.6, 1.05, 0.4), cx, y0 + back - 0.5, bz));
      const posts = Math.max(2, Math.round(width / 3));
      for (let i = 0; i <= posts; i++) {
        const px = cx - half + (i / posts) * width;
        standFrame.push(xform(new THREE.BoxGeometry(0.13, 1.2, 0.13), px, y0 + back + 0.6, bz));
      }
      standFrame.push(xform(new THREE.BoxGeometry(width + 0.6, 0.11, 0.16), cx, y0 + back + 1.18, bz));
      standFrame.push(xform(new THREE.BoxGeometry(width + 0.6, 0.08, 0.12), cx, y0 + back + 0.62, bz));

      /* ---- aisle handrails ---- */
      for (const ax of aisleX) {
        for (const off of [-0.66, 0.66]) {
          const rx = ax + off;
          standFrame.push(
            strut(rx, y0 + 1.05, frontZ0, rx, deckTop + 1.05, backZ - dir * GOING * 0.5, 0.05)
          );
          for (let r = 0; r <= rows; r += 2) {
            const ry2 = y0 + RISE * r;
            const rz = cz + dir * (r * GOING - GOING / 2);
            standFrame.push(xform(new THREE.BoxGeometry(0.06, 1.08, 0.06), rx, ry2 + 0.54, rz));
          }
        }
      }
    }
    const frameMesh = new THREE.Mesh(mergeGeometries(standFrame), galv);
    frameMesh.matrixAutoUpdate = false;
    this._add(frameMesh, true, true);
    // World-metre box projection: a 2 m tile on every face regardless of how
    // long the box is. Without this the 42 m stand front carries a 42:1 stretch.
    for (const g of stepGeos) boxProjectUV(g, 2.0);
    const stepMesh = new THREE.Mesh(mergeGeometries(stepGeos), riser);
    stepMesh.matrixAutoUpdate = false;
    this._add(stepMesh, true, true);
    const nosingMesh = new THREE.Mesh(mergeGeometries(nosingGeos), nosingMat);
    nosingMesh.matrixAutoUpdate = false;
    this._add(nosingMesh, true, true);
    this._props.crowdSeats = crowdSeats;
    const seatMesh = this._instanced(seatGeo, this._materials.get('plastic.seat'), seatPlacements);
    // Colour by ROW, not by index: real stands are banded horizontally, and a
    // per-seat alternation just averages to one mush at 40 m. Per-seat value
    // jitter on top so the band is not a solid vector fill.
    const seatCols = [0x1f5fb8, 0x1f5fb8, 0xf2c419, 0x1f5fb8, 0x1f5fb8, 0xe8ecef, 0x1f5fb8, 0xf2c419];
    for (let i = 0; i < seatPlacements.length; i++) {
      _color.setHex(seatCols[seatRows[i] % seatCols.length]);
      _color.multiplyScalar(0.88 + hash2i(i, 5, 733) * 0.24);
      seatMesh.setColorAt(i, _color);
    }
    if (seatMesh.instanceColor) seatMesh.instanceColor.needsUpdate = true;

    /* ---- clubhouse ---- */
    const cx = -46;
    const cz = 138;
    this._solid(this._box(28, 7.2, 16, deck, cx, 3.6, cz));
    this._add(this._box(29.2, 0.6, 17.2, this._materials.get('metal.dark'), cx, 7.5, cz));
    // Curtain wall facing the plaza, merged into one pane set.
    const panes = [];
    for (let i = 0; i < 7; i++) {
      panes.push(xform(new THREE.BoxGeometry(3.2, 4.4, 0.1), cx - 10.5 + i * 3.5, 3.9, cz + 8.06));
    }
    for (let i = 0; i < 4; i++) {
      panes.push(xform(new THREE.BoxGeometry(0.1, 4.4, 3.0), cx + 14.06, 3.9, cz - 5 + i * 3.4));
    }
    const curtain = new THREE.Mesh(mergeGeometries(panes), glass);
    curtain.matrixAutoUpdate = false;
    this._add(curtain, false, false);
    // Entrance canopy on slender columns.
    this._add(this._box(12, 0.3, 4.4, this._materials.get('metal.white'), cx + 4, 4.4, cz + 10.2));
    for (const ox of [-1.4, 9.4]) {
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 4.3, 10), galv);
      col.position.set(cx + ox, 2.15, cz + 11.9);
      this._solid(col);
    }
    const chSign = this._signBoard(11, 1.7, 'MERIDIAN ATHLETIC GROUNDS', 0x0d2b3c, 0x8ff2ff, 'CLUBHOUSE  •  HIRE  •  CAFE');
    chSign.position.set(cx + 4, 5.9, cz + 8.2);
    this._add(chSign);

    /* ---- vending kiosks ---- */
    // Bodies keep their own tint; roofs, awnings and hatches merge across all
    // four kiosks so the set is 4 + 3 draws rather than 16.
    const kioskRoofs = [];
    const kioskAwns = [];
    const kioskHatches = [];
    for (const [kx, kz, ry, tint] of [
      [-14, 156, 0.3, 0xe8514a], [16, 152, -0.4, 0x2fb4a6], [58, 96, 1.1, 0xf0a92b],
      [-100, 88, 0.0, 0x6c7de0],
    ]) {
      const mat = new THREE.MeshStandardMaterial({ color: tint, roughness: 0.4, metalness: 0.25, envMapIntensity: 1.2 });
      this._materials.set(`kiosk.${kx}.${kz}`, mat);
      const ky = parkHeight(kx, kz);
      const body = this._box(3.4, 2.9, 2.6, mat, kx, ky + 1.45, kz, ry);
      this._solid(body);
      this._props.grounding.push([kx, kz, 4.4]);
      kioskRoofs.push(xform(new THREE.BoxGeometry(4.2, 0.22, 3.4), kx, ky + 3.0, kz, 0, ry, 0));
      kioskAwns.push(xform(new THREE.BoxGeometry(4.0, 0.1, 1.5),
        kx + Math.sin(ry) * 1.9, ky + 2.55, kz + Math.cos(ry) * 1.9, 0, ry, 0));
      kioskHatches.push(xform(new THREE.BoxGeometry(2.4, 1.2, 0.08),
        kx + Math.sin(ry) * 1.32, ky + 1.85, kz + Math.cos(ry) * 1.32, 0, ry, 0));
    }

    for (const [geos, mat, shadow] of [
      [kioskRoofs, this._materials.get('metal.white'), true],
      [kioskAwns, this._materials.get('metal.dark'), true],
      [kioskHatches, glass, false],
    ]) {
      const m = new THREE.Mesh(mergeGeometries(geos), mat);
      m.matrixAutoUpdate = false;
      this._add(m, shadow, shadow);
    }

    /* ---- entrance arch ---- */
    const archMat = this._materials.get('metal.anodised');
    for (const ox of [-15, 15]) {
      const leg = this._box(2.2, 11, 2.2, archMat, ox, 5.5, 176);
      this._solid(leg);
      const foot = this._box(3.4, 0.7, 3.4, deck, ox, 0.35, 176);
      this._add(foot, true, true);
    }
    const beam = this._box(32.2, 2.6, 2.0, archMat, 0, 12.3, 176);
    this._add(beam);
    const archSign = this._signBoard(26, 2.0, 'MERIDIAN  ATHLETIC  GROUNDS', 0x07202e, 0x7fe9ff, 'SKATE  •  SNOW  •  RACQUET  •  TRACK  •  WATER');
    archSign.position.set(0, 12.3, 175.0);
    archSign.rotation.y = Math.PI;
    this._add(archSign);
    const archSign2 = this._signBoard(26, 2.0, 'COME BACK SOON', 0x07202e, 0x7fe9ff, 'PLEASE TAKE YOUR LITTER HOME');
    archSign2.position.set(0, 12.3, 177.0);
    this._add(archSign2);

    /* ---- banners on the plaza colonnade ---- */
    const bannerColours = [0x1f6fd0, 0xe8514a, 0x2fb4a6, 0xf0a92b, 0x6c7de0, 0xe23b8c];
    const bannerPoles = [];
    for (let i = 0; i < 12; i++) {
      const side = i % 2 ? 1 : -1;
      const bz = 168 - Math.floor(i / 2) * 8;
      const bxp = side * 21;
      bannerPoles.push([bxp, 0, bz, 0, 0, 0, 1]);
      this.track(this.physics.addBox(bxp, 3.7, bz, 0.12, 3.7, 0.12, {}));
      const mat = new THREE.MeshStandardMaterial({
        color: bannerColours[i % bannerColours.length],
        roughness: 0.85,
        side: THREE.DoubleSide,
      });
      this._materials.set(`banner.${i}`, mat);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 3.4, 4, 6), mat);
      flag.position.set(bxp + side * 0.8, 4.6, bz);
      flag.rotation.y = Math.PI / 2;
      flag.userData.phase = i * 0.9;
      this._add(flag, true, false);
      this._banners.push(flag);
    }
    this._instanced(
      new THREE.CylinderGeometry(0.09, 0.11, 7.4, 8).translate(0, 3.7, 0),
      galv,
      bannerPoles
    );

    /* ---- car park (hostile patrol ground) ---- */
    const lotMap = this._materials.get('path.gravel').map.clone();
    lotMap.repeat.set(16, 12);
    lotMap.needsUpdate = true;
    const lotMat = this._mat(
      'asphalt.lot',
      new THREE.MeshStandardMaterial({ map: lotMap, color: 0x6a6d72, roughness: 0.93 })
    );
    this._add(this._slab(88, 132, 168, 192, 0.05, lotMat), false, true);
    const bayGeo = new THREE.BoxGeometry(0.12, 0.02, 5.0);
    const bays = [];
    for (let row = 0; row < 3; row++) {
      const z = 140 + row * 18;
      for (let i = 0; i <= 28; i++) bays.push([90 + i * 2.6, 0.07, z, 0, 0, 0, 1]);
    }
    this._instanced(bayGeo, this._materials.get('metal.white'), bays, false, false);

    const carGeo = whiteColor(mergeGeometries([
      new THREE.BoxGeometry(1.85, 0.72, 4.3).translate(0, 0.62, 0),
      new THREE.BoxGeometry(1.65, 0.62, 2.2).translate(0, 1.28, -0.15),
      new THREE.BoxGeometry(1.9, 0.16, 4.2).translate(0, 0.28, 0),
    ]));
    const wheelGeo = new THREE.CylinderGeometry(0.33, 0.33, 0.22, 12).rotateZ(Math.PI / 2);
    const cars = [];
    const wheels = [];
    const crng = makeRng(1717);
    for (let row = 0; row < 3; row++) {
      const z = 140 + row * 18;
      for (let i = 0; i < 28; i++) {
        if (crng() > 0.55) continue;
        const x = 91.3 + i * 2.6;
        const flip = crng() > 0.5 ? 0 : Math.PI;
        cars.push([x, 0.05, z, 0, flip, 0, 1]);
        for (const [wx, wz] of [[-0.92, -1.5], [0.92, -1.5], [-0.92, 1.5], [0.92, 1.5]]) {
          wheels.push([x + wx, 0.38, z + wz, 0, 0, 0, 1]);
        }
        this.track(this.physics.addBox(x, 0.8, z, 0.95, 0.8, 2.2, {}));
      }
    }
    const carMesh = this._instanced(carGeo, this._materials.get('carPaint'), cars);
    const carCols = [0xd8dde2, 0x1b2733, 0x8f1f28, 0x1f4f8f, 0x5a6068, 0xdcc23a, 0x2f7d55, 0xc8d0d6];
    for (let i = 0; i < cars.length; i++) {
      // Stride 3 into a 6-entry table only ever reaches indices 1 and 4, which
      // is why every car in the lot was navy or graphite: the two darkest
      // entries. Any stride coprime with the table length visits all of them.
      _color.setHex(carCols[(i * 5 + 2) % carCols.length]);
      carMesh.setColorAt(i, _color);
    }
    if (carMesh.instanceColor) carMesh.instanceColor.needsUpdate = true;
    this._instanced(wheelGeo, this._materials.get('rubber.dark'), wheels);

    const lotLampGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.12, 0.16, 8, 8).translate(0, 4, 0),
      new THREE.BoxGeometry(1.4, 0.2, 0.5).translate(0, 8.05, 0),
      new THREE.BoxGeometry(1.2, 0.1, 0.4).translate(0, 7.9, 0),
    ]);
    const lotLamps = [];
    for (const [lx, lz] of [[96, 138], [96, 174], [140, 138], [140, 174], [162, 156]]) {
      lotLamps.push([lx, 0, lz, 0, 0, 0, 1]);
      this.track(this.physics.addBox(lx, 4, lz, 0.18, 4, 0.18, {}));
    }
    this._instanced(lotLampGeo, this._materials.get('metal.dark'), lotLamps);

    /* ---- event-day dressing and the maintenance yard ---- */
    this._buildSetDressing();

    /* ---- portal plinth ---- */
    this._buildPortalPlinth();

    /* ---- the one thing you can see from everywhere ---- */
    this._buildLandmarkTower();
  }

  /**
   * Environmental storytelling: the stuff that says a session is happening.
   *
   * A 120 m skate plaza with a dozen readable props and courts with empty
   * stands reads as a facility that was built and then abandoned before opening
   * day - no vehicles, no tents, no barriers, no equipment, nothing that tells
   * you who uses this place or how big anything is. These clusters are sited
   * deliberately: an event set-up on the berm between the plaza and the skate
   * pad, and a groundskeeper's yard on the approach to the courts, both of them
   * sitting between the usual establishing viewpoints and their subjects so they
   * give those frames a foreground layer instead of an empty apron.
   *
   * Every kit here is one merged geometry drawn through one InstancedMesh.
   */
  _buildSetDressing() {
    const galv = this._materials.get('metal.galv');
    const dark = this._materials.get('metal.dark');
    const white = this._materials.get('metal.white');
    const paint = this._materials.get('carPaint');
    const G = (x, z) => parkHeight(x, z);

    /* ---- panel vans ---- */
    const vanBody = whiteColor(mergeGeometries([
      new THREE.BoxGeometry(2.02, 1.72, 3.7).translate(0, 1.52, -0.5),
      new THREE.BoxGeometry(1.98, 1.02, 1.8).translate(0, 1.02, 1.85),
      // Bonnet and a slight taper at the nose so the cab is not a second box.
      new THREE.BoxGeometry(1.9, 0.42, 0.75).translate(0, 0.78, 2.9),
    ]));
    // Sill band, bumpers and roof rail. A van is 80% flat panel, so the few
    // dark horizontals it does have are the whole read at 20 m - without them
    // it is an untextured white slab, which is exactly what a reviewer flags.
    const vanTrim = mergeGeometries([
      new THREE.BoxGeometry(2.08, 0.26, 5.4).translate(0, 0.6, -0.05),
      new THREE.BoxGeometry(2.06, 0.22, 0.22).translate(0, 0.72, 3.2),
      new THREE.BoxGeometry(2.06, 0.22, 0.22).translate(0, 0.72, -2.35),
      new THREE.BoxGeometry(1.5, 0.09, 0.09).translate(0, 2.4, -0.5),
      new THREE.BoxGeometry(0.09, 0.09, 3.4).translate(-0.7, 2.4, -0.5),
      new THREE.BoxGeometry(0.09, 0.09, 3.4).translate(0.7, 2.4, -0.5),
    ]);
    const vanGlass = mergeGeometries([
      new THREE.BoxGeometry(1.86, 0.82, 0.08).translate(0, 1.35, 2.92),
      new THREE.BoxGeometry(0.08, 0.72, 1.5).translate(1.02, 1.32, 2.0),
      new THREE.BoxGeometry(0.08, 0.72, 1.5).translate(-1.02, 1.32, 2.0),
    ]);
    const vanWheel = new THREE.CylinderGeometry(0.38, 0.38, 0.26, 12).rotateZ(Math.PI / 2);
    /*
     * Everything here is sited on GROUND THAT IS ACTUALLY LEVEL.
     *
     * A van is a rigid box with a fixed up vector, so parking one on the 12
     * degrees of grassy berm north of the skate pad drives half of it into the
     * hillside. The site's levelled terraces (`FLAT_ZONES`) are the only places
     * a vehicle or a marquee can sit without a cut-and-fill apron of its own,
     * so the event set-up runs along the pad's north edge at z ~ 77 - which is
     * inside the pad terrace, flat to within 3 cm, and reads as the natural
     * place to put a crew anyway.
     */
    const vans = [
      // Event crew along the north edge of the skate pad.
      [-78, 77, 1.62], [-64, 77.5, 1.48],
      // Deliveries at the clubhouse and the lodge.
      [-30, 149, 1.55], [-40, -58, 0.2],
    ];
    const vanPl = [];
    const vanGl = [];
    const vanWh = [];
    for (const [x, z, ry] of vans) {
      const y = G(x, z);
      vanPl.push([x, y, z, 0, ry, 0, 1]);
      vanGl.push([x, y, z, 0, ry, 0, 1]);
      for (const [wx, wz] of [[-0.95, -1.55], [0.95, -1.55], [-0.95, 1.75], [0.95, 1.75]]) {
        const c = Math.cos(ry);
        const s = Math.sin(ry);
        vanWh.push([x + wx * c + wz * s, y + 0.38, z - wx * s + wz * c, 0, ry, 0, 1]);
      }
      this.track(this.physics.addRotatedBox(
        new THREE.Vector3(x, y + 1.3, z), new THREE.Vector3(1.05, 1.3, 2.9), ry, {}
      ));
      this._props.grounding.push([x, z, 5.4]);
    }
    this._instanced(vanTrim, dark, vanPl);
    const vanMesh = this._instanced(vanBody, paint, vanPl);
    const vanCols = [0xc9ccc8, 0x2f5f9c, 0xb0472a, 0xd2d5d1, 0x46505a];
    for (let i = 0; i < vanPl.length; i++) {
      _color.setHex(vanCols[i % vanCols.length]);
      vanMesh.setColorAt(i, _color);
    }
    if (vanMesh.instanceColor) vanMesh.instanceColor.needsUpdate = true;
    this._instanced(vanGlass, this._materials.get('glass.window'), vanGl, false, false);
    this._instanced(vanWheel, this._materials.get('rubber.dark'), vanWh);

    /* ---- event marquees ---- */
    // A four-sided pyramid canopy on slender legs. Vertex-coloured so the three
    // tents are not the same tent three times.
    const tentGeos = [
      new THREE.ConeGeometry(2.95, 0.95, 4).rotateY(Math.PI / 4).translate(0, 2.85, 0),
      new THREE.BoxGeometry(4.2, 0.1, 4.2).translate(0, 2.36, 0),
    ];
    for (const [lx, lz] of [[-2.05, -2.05], [2.05, -2.05], [-2.05, 2.05], [2.05, 2.05]]) {
      tentGeos.push(new THREE.CylinderGeometry(0.045, 0.045, 2.4, 6).translate(lx, 1.2, lz));
    }
    const tentGeo = whiteColor(mergeGeometries(tentGeos));
    const tentMat = this._mat(
      'fabric.marquee',
      new THREE.MeshStandardMaterial({
        color: 0xffffff, roughness: 0.9, metalness: 0, vertexColors: true,
        side: THREE.DoubleSide, envMapIntensity: 0.4,
      })
    );
    const tents = [];
    for (const [x, z, ry] of [[-98, 77, 0.05], [-90, 77.5, -0.1], [6, 158, 0.1]]) {
      tents.push([x, G(x, z), z, 0, ry, 0, 1]);
      this._props.grounding.push([x, z, 5.6]);
    }
    const tentMesh = this._instanced(tentGeo, tentMat, tents);
    const tentCols = [0xdb4a3a, 0xf2f0e8, 0x2f8fa8, 0xf2c419];
    for (let i = 0; i < tents.length; i++) {
      _color.setHex(tentCols[i % tentCols.length]);
      tentMesh.setColorAt(i, _color);
    }
    if (tentMesh.instanceColor) tentMesh.instanceColor.needsUpdate = true;

    /* ---- folding tables under the marquees ---- */
    const tableGeo = mergeGeometries([
      new THREE.BoxGeometry(1.8, 0.06, 0.75).translate(0, 0.74, 0),
      new THREE.BoxGeometry(0.05, 0.72, 0.68).translate(-0.8, 0.37, 0),
      new THREE.BoxGeometry(0.05, 0.72, 0.68).translate(0.8, 0.37, 0),
    ]);
    const tables = [];
    for (const [x, z, ry] of [
      [-99.5, 78.4, 0.05], [-97.2, 75.9, 0.05], [-89.4, 78.8, -0.1],
      [-91.2, 76.1, -0.1], [5.4, 159.4, 0.1], [6.8, 156.6, 0.1],
    ]) {
      tables.push([x, G(x, z), z, 0, ry, 0, 1]);
    }
    this._instanced(tableGeo, white, tables);

    /* ---- stacked crash mats ---- */
    const matGeo = whiteColor(mergeGeometries([
      new THREE.BoxGeometry(2.0, 0.18, 1.2).translate(0, 0.09, 0),
      new THREE.BoxGeometry(2.0, 0.18, 1.2).translate(0.05, 0.28, 0.04),
      new THREE.BoxGeometry(2.0, 0.18, 1.2).translate(-0.03, 0.47, -0.05),
    ]));
    const matMat = this._mat(
      'foam.mat',
      new THREE.MeshStandardMaterial({
        color: 0xffffff, roughness: 0.95, vertexColors: true, envMapIntensity: 0.3,
      })
    );
    const mats = [];
    for (const [x, z, ry] of [[-84, 77, 0.6], [-70, 77.2, -0.2], [-120, 6, 0.3]]) {
      mats.push([x, G(x, z), z, 0, ry, 0, 1]);
      this._props.grounding.push([x, z, 3.0]);
    }
    const matMesh = this._instanced(matGeo, matMat, mats);
    for (let i = 0; i < mats.length; i++) {
      _color.setHex([0x2f6dbb, 0xc4463c, 0x3f8f66][i % 3]);
      matMesh.setColorAt(i, _color);
    }
    if (matMesh.instanceColor) matMesh.instanceColor.needsUpdate = true;

    /* ---- crowd-control barriers ---- */
    const barGeos = [
      new THREE.BoxGeometry(2.3, 0.05, 0.05).translate(0, 1.06, 0),
      new THREE.BoxGeometry(2.3, 0.04, 0.04).translate(0, 0.72, 0),
      new THREE.BoxGeometry(2.3, 0.04, 0.04).translate(0, 0.38, 0),
      new THREE.BoxGeometry(0.06, 1.1, 0.06).translate(-1.13, 0.55, 0),
      new THREE.BoxGeometry(0.06, 1.1, 0.06).translate(1.13, 0.55, 0),
      new THREE.BoxGeometry(0.1, 0.05, 0.6).translate(-1.13, 0.03, 0),
      new THREE.BoxGeometry(0.1, 0.05, 0.6).translate(1.13, 0.03, 0),
    ];
    const barGeo = mergeGeometries(barGeos);
    const barriers = [];
    // A run along the skate-pad viewing edge and a queue line at the marquees.
    for (let i = 0; i < 14; i++) {
      const x = -118 + i * 2.4;
      barriers.push([x, G(x, 78.6), 78.6, 0, 0, 0, 1]);
    }
    for (let i = 0; i < 7; i++) {
      const x = -70 + i * 2.4;
      barriers.push([x, G(x, 74.4), 74.4, 0, 0, 0, 1]);
    }
    for (let i = 0; i < 7; i++) {
      const x = 66 + i * 2.4;
      barriers.push([x, G(x, 50.5), 50.5, 0, 0, 0, 1]);
    }
    this._instanced(barGeo, galv, barriers);

    /* ---- the groundskeeper's yard on the courts approach ---- */
    // On the courts' own north apron, inside the enclosure: the only genuinely
    // level ground near the courts, and a maintenance store belongs behind the
    // fence anyway. It frames the left edge of the standard courts view.
    const yardX = 74;
    const yardZ = 44;
    const yardY = G(yardX, yardZ);
    const container = this._box(6.2, 2.6, 2.55, dark, yardX, yardY + 1.3, yardZ, -0.28);
    this._solid(container);
    this._props.grounding.push([yardX, yardZ, 8.0]);
    // Ribbing on the container so it is not a bare box at 20 m.
    const ribs = [];
    for (let i = 0; i < 13; i++) {
      ribs.push(xform(new THREE.BoxGeometry(0.09, 2.4, 0.06), -3.0 + i * 0.5, 0, 1.3));
      ribs.push(xform(new THREE.BoxGeometry(0.09, 2.4, 0.06), -3.0 + i * 0.5, 0, -1.3));
    }
    const ribMesh = new THREE.Mesh(mergeGeometries(ribs), galv);
    ribMesh.position.set(yardX, yardY + 1.3, yardZ);
    ribMesh.rotation.y = -0.28;
    this._add(ribMesh);
    // Stacked crates and a pallet of court paint.
    const crateGeo = whiteColor(new THREE.BoxGeometry(0.9, 0.62, 0.7));
    const crateMat = this._mat(
      'crate.plastic',
      new THREE.MeshStandardMaterial({
        color: 0xffffff, roughness: 0.62, metalness: 0.05, vertexColors: true,
      })
    );
    const crates = [];
    const crng = makeRng(4471);
    for (let i = 0; i < 16; i++) {
      const bx = yardX - 4.6 + (i % 4) * 0.95;
      const bz = yardZ + 1.9 + Math.floor(i / 8) * 0.8;
      const tier = Math.floor(i / 4) % 2;
      crates.push([bx, yardY + 0.31 + tier * 0.63, bz, 0, (crng() - 0.5) * 0.2, 0, 1]);
    }
    const crateMesh = this._instanced(crateGeo, crateMat, crates);
    for (let i = 0; i < crates.length; i++) {
      _color.setHex([0x3f6f3a, 0x2f5f8f, 0xb0562a, 0x55595e][i % 4]);
      crateMesh.setColorAt(i, _color);
    }
    if (crateMesh.instanceColor) crateMesh.instanceColor.needsUpdate = true;
    // Court roller: the one piece of kit that says "this surface gets
    // maintained" and a useful ~2 m scale reference in the courts frame.
    const roller = mergeGeometries([
      new THREE.CylinderGeometry(0.42, 0.42, 1.25, 14).rotateZ(Math.PI / 2).translate(0, 0.42, 0),
      new THREE.BoxGeometry(0.07, 0.07, 1.5).translate(-0.68, 0.62, 0.62),
      new THREE.BoxGeometry(0.07, 0.07, 1.5).translate(0.68, 0.62, 0.62),
      new THREE.BoxGeometry(1.5, 0.07, 0.07).translate(0, 0.92, 1.3),
    ]);
    const rollerMesh = new THREE.Mesh(roller, galv);
    rollerMesh.position.set(yardX + 4.8, yardY, yardZ - 1.2);
    rollerMesh.rotation.y = 0.7;
    this._add(rollerMesh);
    this._props.grounding.push([yardX + 4.8, yardZ - 1.2, 2.6]);
    // Hose reel and a stack of folded windbreak on the container's flank.
    const reel = mergeGeometries([
      new THREE.CylinderGeometry(0.55, 0.55, 0.34, 14).rotateZ(Math.PI / 2).translate(0, 0.75, 0),
      new THREE.BoxGeometry(0.08, 0.75, 0.08).translate(-0.3, 0.38, 0),
      new THREE.BoxGeometry(0.08, 0.75, 0.08).translate(0.3, 0.38, 0),
    ]);
    const reelMesh = new THREE.Mesh(reel, dark);
    reelMesh.position.set(yardX - 2.2, yardY, yardZ - 2.1);
    this._add(reelMesh);
  }

  /**
   * Meridian Tower: a 31 m lattice clock-and-scoreboard mast on the plaza axis.
   *
   * The site had exactly one landmark - the snow mound - and it sat off to one
   * side, subtended the same screen angle as a set of bleachers, and read as a
   * prop rather than as terrain. A player spawning on the plaza had no
   * silhouette anywhere in frame that said "go there". This is placed dead on
   * the north-south avenue at z = 40, roughly a hundred metres down the spine
   * from the spawn, so it is the first vertical the player sees, it stays
   * visible from the skate pad, the courts and the track, and it gives the
   * whole site an axis to orient against.
   */
  _buildLandmarkTower() {
    const galv = this._materials.get('metal.galv');
    const dark = this._materials.get('metal.dark');
    const deck = this._materials.get('concrete.deck');
    const tx = 0;
    const tz = 40;
    const ty = parkHeight(tx, tz);
    const H = 31;

    // Battered legs: 3.4 m half-span at the base closing to 1.15 m at the head.
    const legAt = (t) => lerp(3.4, 1.15, t);
    const parts = [];
    const nodes = 9;
    const corner = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (let c = 0; c < 4; c++) {
      for (let i = 0; i < nodes - 1; i++) {
        const t0 = i / (nodes - 1);
        const t1 = (i + 1) / (nodes - 1);
        const r0 = legAt(t0);
        const r1 = legAt(t1);
        parts.push(strut(
          tx + corner[c][0] * r0, ty + t0 * H, tz + corner[c][1] * r0,
          tx + corner[c][0] * r1, ty + t1 * H, tz + corner[c][1] * r1,
          0.24 - t0 * 0.09
        ));
      }
    }
    // Ring beams and diagonal bracing on every bay: the lattice is the read.
    for (let i = 0; i < nodes; i++) {
      const t = i / (nodes - 1);
      const r = legAt(t);
      for (let c = 0; c < 4; c++) {
        const a = corner[c];
        const b = corner[(c + 1) % 4];
        parts.push(strut(
          tx + a[0] * r, ty + t * H, tz + a[1] * r,
          tx + b[0] * r, ty + t * H, tz + b[1] * r,
          0.11
        ));
        if (i < nodes - 1) {
          const t1 = (i + 1) / (nodes - 1);
          const r1 = legAt(t1);
          parts.push(strut(
            tx + a[0] * r, ty + t * H, tz + a[1] * r,
            tx + b[0] * r1, ty + t1 * H, tz + b[1] * r1,
            0.075
          ));
        }
      }
    }
    const lattice = new THREE.Mesh(mergeGeometries(parts), galv);
    lattice.matrixAutoUpdate = false;
    this._add(lattice, true, true);

    // Head: a boxed gallery carrying the clock and the scoreboard, merged into
    // the one mesh so the landmark costs two draws rather than five.
    const head = new THREE.Mesh(mergeGeometries([
      xform(new THREE.BoxGeometry(6.4, 3.4, 4.4), tx, ty + H + 1.2, tz),
      xform(new THREE.BoxGeometry(7.4, 0.4, 5.4), tx, ty + H + 3.1, tz),
      xform(new THREE.BoxGeometry(7.4, 0.35, 5.4), tx, ty + H - 0.5, tz),
    ]), dark);
    head.matrixAutoUpdate = false;
    this._add(head, true, true);

    // Clock face south (toward the plaza) and the scoreboard north.
    const clock = this._signBoard(4.2, 4.2, '10:41', 0x08161f, 0xa8f0ff, 'MERIDIAN');
    clock.position.set(tx, ty + H + 1.2, tz + 2.3);
    clock.rotation.y = Math.PI;
    this._add(clock);
    const scoreboard = this._signBoard(5.6, 2.6, 'MERIDIAN', 0x08161f, 0xffd9a0, 'ATHLETIC GROUNDS  •  EST. 1974');
    scoreboard.position.set(tx, ty + H + 1.4, tz - 2.3);
    this._add(scoreboard);

    // Aircraft beacon + a flood ring, so it still reads as a silhouette when
    // the sun is behind it.
    const beacon = this._mat(
      'tower.beacon',
      new THREE.MeshStandardMaterial({
        color: 0x3a0d0d, emissive: 0xff3b28, emissiveIntensity: 3.2, roughness: 0.4,
      })
    );
    this._add(new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), beacon)
      .translateY(ty + H + 3.6), false, false);
    const heads = [];
    for (const [ox, oz] of [[-2.6, -2.0], [2.6, -2.0], [-2.6, 2.0], [2.6, 2.0]]) {
      heads.push(xform(new THREE.BoxGeometry(0.8, 0.6, 0.4), tx + ox, ty + H - 1.2, tz + oz, -0.5));
    }
    const headMesh = new THREE.Mesh(mergeGeometries(heads), this._materials.get('lamp.flood'));
    headMesh.matrixAutoUpdate = false;
    this._add(headMesh);

    // Plinth and the four leg pads.
    this._add(this._slab(tx - 5.2, tz - 5.2, tx + 5.2, tz + 5.2, ty + 0.09, deck, 0.4), false, true);
    this.track(this.physics.addBox(tx, ty - 0.4, tz, 5.2, 0.5, 5.2, { layer: COLLISION_LAYER.WORLD }));
    for (const c of corner) {
      this.track(this.physics.addBox(
        tx + c[0] * 3.0, ty + 4, tz + c[1] * 3.0, 0.4, 4, 0.4, { layer: COLLISION_LAYER.WORLD }
      ));
    }
  }

  /**
   * The return gate sits on a low plinth so the player always arrives above the
   * plaza, framed in anodised aluminium with a floodlight rig for contrast.
   */
  _buildPortalPlinth() {
    const alu = this._materials.get('metal.anodised');
    const deck = this._materials.get('concrete.deck');
    const px = 0;
    const pz = 150;

    // Kept under the player's 0.45 m step height so the gate is never a wall.
    this._solid(this._box(9.4, 0.22, 9.4, deck, px, 0.11, pz));
    this._solid(this._box(7, 0.18, 7, alu, px, 0.31, pz));

    // Aluminium surround: two uprights and a lintel, chamfered by a second box.
    for (const ox of [-3.3, 3.3]) {
      this._solid(this._box(0.55, 6.4, 1.1, alu, px + ox, 3.6, pz));
      this._add(this._box(0.7, 0.35, 1.3, this._materials.get('metal.dark'), px + ox, 6.6, pz));
    }
    this._add(this._box(7.8, 0.7, 1.1, alu, px, 7.05, pz));
    this._add(this._box(7.8, 0.18, 1.4, this._materials.get('metal.dark'), px, 7.48, pz));

    const accent = this._mat(
      'portal.accent',
      new THREE.MeshStandardMaterial({
        color: 0x0d3f4c,
        emissive: 0x2fe6ff,
        emissiveIntensity: 2.4,
        roughness: 0.3,
        metalness: 0.4,
      })
    );
    for (const ox of [-3.3, 3.3]) {
      const s = ox < 0 ? 1 : -1;
      this._add(this._box(0.1, 5.6, 0.16, accent, px + ox + s * 0.33, 3.6, pz + 0.6), false, false);
      this._add(this._box(0.1, 5.6, 0.16, accent, px + ox + s * 0.33, 3.6, pz - 0.6), false, false);
    }
    this._add(this._box(6.9, 0.12, 0.16, accent, px, 6.62, pz + 0.6), false, false);

    // Floodlights raking the frame, merged into one mesh.
    const flood = [];
    for (const [ox, oz] of [[-4.4, 3.2], [4.4, 3.2], [-4.4, -3.2], [4.4, -3.2]]) {
      flood.push(xform(new THREE.CylinderGeometry(0.09, 0.12, 1.6, 8), px + ox, 1.15, pz + oz));
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.34));
      head.position.set(px + ox, 2.0, pz + oz);
      head.lookAt(px, 4.2, pz);
      head.updateMatrix();
      flood.push(head.geometry.applyMatrix4(head.matrix));
    }
    const floodMesh = new THREE.Mesh(mergeGeometries(flood), this._materials.get('metal.dark'));
    floodMesh.matrixAutoUpdate = false;
    this._add(floodMesh);
    const light = new THREE.PointLight(0x2fe6ff, 26, 22, 2);
    light.position.set(px, 3.4, pz);
    this.group.add(light);

    const sign = this._signBoard(5.4, 1.1, 'GATE 01  →  AETHER STATION', 0x06222c, 0x8ff6ff);
    sign.position.set(px, 8.15, pz);
    sign.rotation.y = Math.PI;
    this._add(sign);
  }

  /* ---------------------------------------------------------------- */
  /* Landscaping and site furniture                                    */
  /* ---------------------------------------------------------------- */

  /** Keep planting out of the playing surfaces, the car park and the paths. */
  /**
   * One lobe of a canopy: a noise-displaced icosahedron with *sphere* normals.
   *
   * `IcosahedronGeometry` is non-indexed, so `computeVertexNormals` can only
   * produce facet normals - which is why the trees read as cut gemstones. Using
   * the normalised direction instead gives smooth shading while the displaced
   * position keeps a lumpy silhouette, so the leaf normal map is free to do the
   * high-frequency work. Vertex colour carries a cheap vertical occlusion ramp
   * so the undersides of the lobes sit in shade before any light is applied.
   */
  _leafBlob(radius, seed, detail = 2) {
    const geo = new THREE.IcosahedronGeometry(radius, detail);
    const pos = geo.getAttribute('position');
    const nrm = new Float32Array(pos.count * 3);
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const len = Math.hypot(x, y, z) || 1;
      const dx = x / len;
      const dy = y / len;
      const dz = z / len;
      // Spherical parameterisation; u wraps seamlessly because fbm tiles.
      const u = Math.atan2(dz, dx) / (Math.PI * 2) + 0.5;
      const v = Math.acos(clamp(dy, -1, 1)) / Math.PI;
      // Two octaves: the coarse one gives the lobe its lopsided mass, the fine
      // one chews the silhouette so the canopy edge is never a clean arc.
      const k = 0.68 + fbm(u, v, 4, 3, seed) * 0.52 + fbm(u, v, 14, 2, seed + 71) * 0.20;
      pos.setXYZ(i, dx * radius * k, dy * radius * k, dz * radius * k);
      nrm[i * 3] = dx;
      nrm[i * 3 + 1] = dy;
      nrm[i * 3 + 2] = dz;
      const ao = 0.52 + 0.48 * clamp01(dy * 0.5 + 0.62);
      col[i * 3] = ao;
      col[i * 3 + 1] = ao;
      col[i * 3 + 2] = ao * 0.97;
    }
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    pos.needsUpdate = true;
    return geo;
  }

  /**
   * True when (x,z) sits inside the published playable area with `inset`
   * metres to spare.
   *
   * Read straight off `this.bounds` so the scatter passes and the minimap can
   * never disagree about where the site ends. The heightfield itself runs to
   * +/-260m - 60m of headroom past the border, which is what makes the
   * horizon read as continuous - so this is a *composition* limit, not a
   * "there is no ground here" limit. Both matter: a prop past the border is
   * unreachable set dressing that still pays full draw cost, and a prop
   * straddling the border is one the player can see the far side of.
   */
  _inSite(x, z, inset = 0) {
    const b = this.bounds;
    return (
      x > b.min.x + inset && x < b.max.x - inset &&
      z > b.min.z + inset && z < b.max.z - inset
    );
  }

  _isPlantable(x, z) {
    const rects = [
      [PAD.x0 - 4, PAD.z0 - 4, PAD.x1 + 4, PAD.z1 + 6],
      [POOL.x0 - 4, POOL.z0 - 4, POOL.x1 + 4, POOL.z1 + 4],
      [60, 0, 130, 60],
      [12, -152, 198, -48],
      [-30, 125, 30, 182],
      [-66, 126, -26, 152],
      [84, 128, 172, 196],
      [SKI.x0, SKI.z0, SKI.x1, SKI.z1 + 6],
      [-104, -78, -30, -44],
      [-9, 31, 9, 49], // Meridian Tower footprint
    ];
    for (const [x0, z0, x1, z1] of rects) {
      if (x > x0 && x < x1 && z > z0 && z < z1) return false;
    }
    // Cluster centres are jittered by an unbounded gaussian before they get
    // here, so this is the test that actually holds the tree line inside the
    // site - 8m of inset covers the widest canopy in the set.
    return this._inSite(x, z, 8);
  }

  _buildLandscaping() {
    const rng = makeRng(31337);

    /* ---- broadleaf trees ---- */
    // Four distinct silhouettes in a weighted mix, seeded in clusters rather
    // than scattered uniformly. One lollipop repeated 130 times in an even ring
    // is the most obvious procedural tell in the whole world.
    /*
     * Branch armature.
     *
     * A trunk that stops at the base of the canopy is the second-oldest
     * procedural-tree tell after the lollipop: real limbs push *into* the leaf
     * mass, and the dark diagonals showing through the alpha holes are a large
     * part of what makes a canopy read as a tree rather than as green fog. Each
     * limb is a tapered cylinder aimed from a point on the trunk at a point
     * inside one of that archetype's lobes, so the armature and the foliage
     * agree by construction rather than by eye.
     */
    const limb = (ax, ay, az, bx, by, bz, r0, r1) => {
      const len = Math.hypot(bx - ax, by - ay, bz - az) || 1e-3;
      const g = new THREE.CylinderGeometry(r1, r0, len, 6, 1, true).translate(0, len / 2, 0);
      _v1.set(0, 1, 0);
      _v2.set((bx - ax) / len, (by - ay) / len, (bz - az) / len);
      _q1.setFromUnitVectors(_v1, _v2);
      _s1.set(1, 1, 1);
      _v3.set(ax, ay, az);
      _m1.compose(_v3, _q1, _s1);
      g.applyMatrix4(_m1);
      return g;
    };
    const trunkGeos = [
      // Poplar: a single column with short upswept laterals hugging the axis.
      mergeGeometries([
        new THREE.CylinderGeometry(0.11, 0.30, 7.4, 7).translate(0, 3.7, 0),
        limb(0.05, 4.3, 0, 0.62, 6.3, 0.25, 0.09, 0.03),
        limb(-0.05, 5.0, 0.05, -0.55, 7.1, -0.3, 0.08, 0.03),
        limb(0, 5.9, 0, 0.34, 8.2, 0.1, 0.07, 0.025),
      ]),
      // Oak: a short bole that forks into four heavy boughs, each subdividing
      // once more out toward the spreading lobes.
      mergeGeometries([
        new THREE.CylinderGeometry(0.30, 0.52, 3.0, 9).translate(0, 1.5, 0),
        limb(0.1, 2.7, 0, 2.3, 4.3, 0.5, 0.24, 0.10),
        limb(2.3, 4.3, 0.5, 2.9, 4.4, 1.0, 0.10, 0.04),
        limb(-0.1, 2.8, -0.1, -2.1, 4.4, -1.0, 0.23, 0.10),
        limb(-2.1, 4.4, -1.0, -2.6, 5.0, -1.6, 0.10, 0.04),
        limb(0, 3.0, 0.1, 0.5, 5.6, 1.5, 0.21, 0.09),
        limb(0, 3.1, -0.1, -0.5, 5.5, -1.8, 0.19, 0.08),
        limb(0.1, 3.4, 0, 0.25, 6.9, 0.1, 0.17, 0.06),
      ]),
      // Wind-leant: everything skewed downwind, with a bare windward side.
      mergeGeometries([
        new THREE.CylinderGeometry(0.14, 0.36, 4.6, 7).rotateZ(0.2).translate(0.44, 2.3, 0),
        limb(0.7, 3.6, 0, 2.4, 4.4, 0.5, 0.15, 0.05),
        limb(0.75, 4.1, -0.1, 1.9, 5.6, 0.7, 0.13, 0.045),
        limb(0.6, 3.2, 0.1, 0.2, 5.6, -0.6, 0.11, 0.04),
      ]),
      // Sparse / part-dead: the bare limbs *are* the silhouette, so there are
      // more of them and they reach further than the foliage does.
      mergeGeometries([
        new THREE.CylinderGeometry(0.11, 0.30, 4.4, 6).translate(0, 2.2, 0),
        limb(0.05, 2.6, 0, 1.5, 4.6, 0.2, 0.10, 0.03),
        limb(-0.05, 2.9, 0.05, -1.35, 5.0, 0.5, 0.09, 0.028),
        limb(0, 3.4, -0.05, 0.35, 5.7, -1.2, 0.08, 0.025),
        limb(1.5, 4.6, 0.2, 2.2, 5.4, -0.2, 0.03, 0.012),
        limb(-1.35, 5.0, 0.5, -1.9, 5.9, 1.0, 0.028, 0.012),
      ]),
    ];
    /*
     * Canopies are built in two layers.
     *
     *   core  - a shrunken noise-displaced blob at 62% of the lobe radius. It
     *           carries the canopy's mass and self-shadowing and is what keeps
     *           the tree from looking like a cloud of loose cards at distance.
     *   shell - alpha-tested leaf cards out at the full lobe radius. These are
     *           the silhouette: no smooth arc survives them, sky reads through
     *           the canopy edge, and the shadow map inherits the holes because
     *           three's depth material honours alphaMap.
     *
     * Three genuinely different silhouettes (columnar, spreading, leaning) plus
     * one sparse/part-dead form, not four scale variations of the same lump.
     */
    const LOBES = [
      // Poplar: tall, narrow, vertically stacked.
      [[1.5, 101, 0, 4.6, 0, 14], [1.7, 102, 0.2, 6.1, 0.1, 15],
       [1.4, 103, -0.15, 7.5, -0.15, 13], [0.95, 104, 0.1, 8.6, 0.1, 9],
       [0.8, 105, -0.55, 5.3, 0.6, 8], [0.75, 106, 0.6, 7.0, -0.5, 8]],
      // Oak: wide, low, spreading.
      [[3.0, 111, 0, 4.6, 0, 20], [2.2, 112, 2.6, 4.0, 0.6, 15],
       [2.0, 113, -2.5, 4.2, -1.1, 15], [1.8, 114, 0.5, 5.9, 1.6, 13],
       [1.6, 115, -0.6, 5.7, -2.0, 11], [1.5, 116, 1.9, 5.6, -1.5, 10],
       [1.3, 117, -1.8, 3.5, 1.9, 9], [1.2, 118, 0.2, 7.1, 0.1, 8]],
      // Asymmetric leaner.
      [[2.3, 121, 1.1, 5.0, 0, 17], [1.6, 122, 2.7, 4.2, 0.6, 12],
       [1.2, 123, 0.2, 5.9, -0.7, 9], [1.1, 124, 2.1, 6.0, 0.9, 8]],
      // Sparse: a few tufts on bare limbs, so the limbs are the silhouette.
      [[1.1, 131, 1.2, 4.5, 0.1, 9], [0.85, 132, -1.0, 4.8, 0.4, 7],
       [0.7, 133, 0.2, 5.4, -0.9, 6]],
    ];
    const canopyGeos = [];
    const cardGeos = [];
    for (const lobes of LOBES) {
      canopyGeos.push(
        mergeGeometries(
          lobes.map(([r, s, x, y, z]) =>
            this._leafBlob(r * 0.62, s, r > 1.6 ? 2 : 1).translate(x, y, z)
          )
        )
      );
      cardGeos.push(
        mergeGeometries(
          lobes.map(([r, s, x, y, z, n]) => this._leafCards(r, s + 900, n).translate(x, y, z))
        )
      );
    }

    const gauss = () =>
      Math.sqrt(-2 * Math.log(rng() + 1e-6)) * Math.cos(6.28318 * rng());
    const clusters = [];
    for (let i = 0; i < 400 && clusters.length < 20; i++) {
      const x = (rng() - 0.5) * 366;
      const z = (rng() - 0.5) * 366;
      if (!this._isPlantable(x, z)) continue;
      clusters.push([x, z]);
    }
    const buckets = [[], [], [], []];
    const shrubSeeds = [];
    let planted = 0;
    for (const [ccx, ccz] of clusters) {
      const n = 4 + ((rng() * 7) | 0);
      const sigma = 7 + rng() * 6;
      for (let k = 0; k < n && planted < 150; k++) {
        const x = ccx + gauss() * sigma;
        const z = ccz + gauss() * sigma;
        if (!this._isPlantable(x, z)) continue;
        const r = rng();
        const variant = r < 0.4 ? 1 : r < 0.7 ? 0 : r < 0.9 ? 2 : 3;
        // Non-uniform scale plus a small lean: no two present the same profile.
        const sx = 0.8 + rng() * 0.45;
        const sy = 0.7 + rng() * 0.9;
        buckets[variant].push([
          x, parkHeight(x, z) - 0.14, z,
          (rng() - 0.5) * 0.14, rng() * 6.28, (rng() - 0.5) * 0.14,
          sx, sy, sx * (0.9 + rng() * 0.2),
        ]);
        planted++;
        if (rng() > 0.45) shrubSeeds.push([x, z]);
      }
    }
    const foliage = this._materials.get('foliage');
    const foliageAlt = this._materials.get('foliage.dark');
    const cardMat = this._materials.get('foliage.card');
    const cardMatAlt = this._materials.get('foliage.card.dark');
    for (let vI = 0; vI < 4; vI++) {
      const list = buckets[vI];
      if (!list.length) continue;
      this._instanced(trunkGeos[vI], this._materials.get('bark'), list);
      const canopies = this._instanced(canopyGeos[vI], vI === 3 ? foliageAlt : foliage, list);
      // Card shells RECEIVE shadow but do not CAST it. A porous shell of 60-100
      // overlapping alpha-tested quads casts onto its own core and onto itself,
      // and with the fill starved to keep the key readable those accumulated
      // self-shadows crushed whole clusters to black - on the *sunlit* side of
      // the canopy, which reads as a rendering fault rather than as depth. The
      // blob core and the trunk still cast, so the tree's ground shadow is
      // unchanged, and the shadow pass gets ~40% cheaper for free.
      const cards = this._instanced(cardGeos[vI], vI === 3 ? cardMatAlt : cardMat, list, false, true);
      // Instance colour *multiplies* an already-green albedo, so it has to be a
      // near-neutral tint. Saturated greens here stack with the map and turn
      // every tree into the same black-green mass.
      for (let i = 0; i < list.length; i++) {
        _color.setHSL(
          0.18 + hash2i(i, vI, 7) * 0.12,
          0.10 + hash2i(i, vI, 11) * 0.24,
          0.52 + hash2i(i, vI, 13) * 0.26
        );
        canopies.setColorAt(i, _color);
        cards.setColorAt(i, _color);
      }
      if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true;
      if (cards.instanceColor) cards.instanceColor.needsUpdate = true;
      for (const t of list) this.track(this.physics.addBox(t[0], t[1] + 2, t[2], 0.34, 2, 0.34, {}));
    }

    // Understory: rough grass tufts and low scrub at the cluster edges, so the
    // trees are not standing on bare mown turf.
    const tuftGeo = mergeGeometries([
      new THREE.ConeGeometry(0.34, 0.9, 4).translate(0, 0.45, 0),
      new THREE.ConeGeometry(0.26, 0.7, 4).rotateZ(0.4).translate(0.28, 0.35, 0.1),
      new THREE.ConeGeometry(0.22, 0.6, 4).rotateZ(-0.5).translate(-0.24, 0.3, -0.12),
    ]);
    const tuftMat = this._mat(
      'grass.tuft',
      new THREE.MeshStandardMaterial({
        map: this._materials.get('foliage').map,
        normalMap: this._materials.get('foliage').normalMap,
        color: 0x93a86a,
        roughness: 0.98,
        envMapIntensity: 0.35,
      })
    );
    const tufts = [];
    for (const [sx, sz] of shrubSeeds) {
      for (let k = 0; k < 4; k++) {
        const x = sx + (rng() - 0.5) * 9;
        const z = sz + (rng() - 0.5) * 9;
        if (!this._isPlantable(x, z)) continue;
        tufts.push([x, parkHeight(x, z) - 0.06, z, 0, rng() * 6.28, 0, 0.7 + rng() * 0.9]);
      }
    }
    this._instanced(tuftGeo, tuftMat, tufts, true, true);

    /* ---- instanced ground cover ---- */
    /*
     * Three crossed alpha-tested quads per instance, ~13k instances placed in
     * bands along everywhere the player actually walks. One draw call, ~78k
     * triangles, shadow casting off (the cast shadow of a 40 cm blade is not
     * worth a second depth pass over 13k instances - the vertex occlusion ramp
     * baked into the cards does that job).
     */
    {
      const cardGeos = [];
      for (let k = 0; k < 3; k++) {
        const g = new THREE.PlaneGeometry(0.42, 0.42, 1, 1);
        g.translate(0, 0.21, 0);
        g.rotateY((k / 3) * Math.PI);
        cardGeos.push(g);
      }
      const bladeGeo = mergeGeometries(cardGeos);
      for (const g of cardGeos) g.dispose();
      {
        const pos = bladeGeo.getAttribute('position');
        const src = bladeGeo.getAttribute('normal');
        const col = new Float32Array(pos.count * 3);
        const nrm = new Float32Array(pos.count * 3);
        for (let i = 0; i < pos.count; i++) {
          // Bases sit in their own shade; tips catch the key.
          const ao = 0.55 + 0.45 * clamp01(pos.getY(i) / 0.42);
          col[i * 3] = ao;
          col[i * 3 + 1] = ao;
          col[i * 3 + 2] = ao * 0.96;
          // Same dome bias as the leaf cards: a vertical quad facing away from
          // a 16-degree sun receives nothing, and a lawn of black slivers is
          // worse than no ground cover at all.
          const nx = src.getX(i) * 0.32;
          const ny = src.getY(i) * 0.32 + 0.94;
          const nz = src.getZ(i) * 0.32;
          const nl = Math.hypot(nx, ny, nz) || 1;
          nrm[i * 3] = nx / nl;
          nrm[i * 3 + 1] = ny / nl;
          nrm[i * 3 + 2] = nz / nl;
        }
        bladeGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
        bladeGeo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      }

      // Bands, not a uniform site-wide scatter: 13k instances spread over
      // 160,000 m2 would be invisible, the same 13k over the six areas a player
      // stands in is the difference between a lawn and a green sheet.
      const bands = [
        // Counts are RAW candidates - the feather and the density field below
        // reject roughly 45% of them, so these are ~1.75x the old figures to
        // land on the same ~13k instances.
        [-40, 108, 40, 190, 4200], // plaza lawns and the avenue verges
        [-136, -14, -16, 4, 2600],  // south apron of the skate pad
        [-136, 74, -16, 96, 2600],  // north apron of the skate pad
        [52, -6, 140, 82, 4200],    // court surround, out to the south approach
        [14, 88, 88, 134, 2450],    // pool lawns
        [-118, 74, -20, 118, 2800], // the walk from the plaza to the pad
        [-70, 96, 60, 128, 2800],   // the berm crest, straight down the axis
        [40, -60, 180, -40, 2100],  // track approach
      ];
      const blades = [];
      const grng = makeRng(60613);
      for (const [x0, z0, x1, z1, n] of bands) {
        for (let i = 0; i < n; i++) {
          const x = lerp(x0, x1, grng());
          const z = lerp(z0, z1, grng());
          if (!this._isPlantable(x, z)) continue;
          /*
           * Feathered band edges.
           *
           * A hard rect reject put a dead-straight line across the foreground
           * meadow: clumps up to it, bare terrain past it. Fading density AND
           * scale over the outer 11 m turns the boundary into a thinning
           * sward, which is what the edge of a mown area actually looks like.
           */
          const edge = Math.min(x - x0, x1 - x, z - z0, z1 - z);
          const k = smoothstep(0, 11, edge);
          /*
           * Density driven by the SAME field that authors the lawn's macro
           * blotching (lattice 11, seed 887 - see the grass overlay bake).
           * Previously the density mask and the colour mask were independent
           * noise, so the dark patches had no geometry standing on them and
           * read as a low-res texture rather than as denser vegetation.
           */
          const patch = fbm((x + 260) / 520, (z + 260) / 520, 11, 2, 887);
          const density = (0.24 + 0.76 * k) * (0.55 + patch * 0.9);
          if (grng() > density) continue;
          const s = (0.7 + grng() * 0.85) * lerp(0.6, 1.0, k);
          blades.push([
            x, parkHeight(x, z) - 0.04, z,
            0, grng() * 6.28, 0,
            s, s * (0.8 + grng() * 0.7), s,
          ]);
        }
      }
      const bladeMesh = this._instanced(bladeGeo, this._materials.get('grass.card'), blades, false, true);
      bladeMesh.frustumCulled = true;
    }

    /* ---- hedges ---- */
    /*
     * The old run was `IcosahedronGeometry(0.85, 1)` instanced every 0.7 m: a
     * line of identical smooth capsules with a visible neck between each one,
     * flat-shaded in a single green with no maps. Three changes make it read as
     * a clipped hedge instead of a string of sausages:
     *   1. 0.34 m spacing with randomised scale and rotation, so the lobes
     *      overlap into a continuous mass and the necks fill in;
     *   2. the same noise displacement the tree canopies use, so no instance
     *      presents a smooth sphere arc;
     *   3. the foliage albedo/normal/alpha set on the material, so the top edge
     *      is porous and the surface has leaf-scale relief.
     */
    const hedgeMat = this._mat(
      'hedge',
      new THREE.MeshStandardMaterial({
        color: 0x7f9a63,
        map: this._materials.get('foliage').map,
        normalMap: this._materials.get('foliage').normalMap,
        normalScale: new THREE.Vector2(1.5, 1.5),
        alphaMap: this._materials.get('foliage').alphaMap,
        alphaTest: 0.34,
        roughness: 0.96,
        envMapIntensity: 0.35,
        side: THREE.DoubleSide,
        vertexColors: true,
      })
    );
    this._wrapLight(hedgeMat);
    // Three lobe shapes cycled along the run so the repeat is not readable.
    const hedgeGeos = [0, 1].map((k) => {
      // detail 1, not 2: 80 tris per lobe across ~900 instances instead of 320.
      const g = this._leafBlob(0.62, 2200 + k * 13, 1);
      g.scale(1.15, 0.92, 1.15);
      return g;
    });
    // Porous fringe on the outer shell, so the clipped top edge breaks up
    // against the sky rather than terminating on a clean arc.
    const hedgeFringe = this._leafCards(0.72, 2411, 9);
    const hedges = [[], []];
    const fringes = [];
    const hedgeRuns = [
      [-27, 130, -27, 176], [27, 130, 27, 176],
      [-26, 126, 26, 126], [62, 2, 62, 50], [128, 2, 128, 50],
      [24, 98, 76, 98], [24, 127, 76, 127],
    ];
    const hrng = makeRng(5150);
    for (const [x0, z0, x1, z1] of hedgeRuns) {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const n = Math.round(len / 0.38);
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const hx = lerp(x0, x1, t) + (hrng() - 0.5) * 0.16;
        const hz = lerp(z0, z1, t) + (hrng() - 0.5) * 0.16;
        const s = 0.8 + hrng() * 0.35;
        const hy = 0.66 + parkHeight(hx, hz) + (hrng() - 0.5) * 0.1;
        hedges[i % 2].push([hx, hy, hz, (hrng() - 0.5) * 0.3, hrng() * 6.28, (hrng() - 0.5) * 0.3, s]);
        if (i % 3 === 0) fringes.push([hx, hy + 0.16, hz, 0, hrng() * 6.28, 0, s * 0.85]);
      }
      this.track(
        this.physics.addBox((x0 + x1) / 2, 0.6, (z0 + z1) / 2,
          Math.max(0.6, Math.abs(x1 - x0) / 2), 0.6, Math.max(0.6, Math.abs(z1 - z0) / 2), {})
      );
    }
    for (let k = 0; k < 2; k++) if (hedges[k].length) this._instanced(hedgeGeos[k], hedgeMat, hedges[k]);
    this._instanced(hedgeFringe, this._materials.get('foliage.card'), fringes, false, true);
    // Mulch strip under every run so the hedge grows out of something.
    {
      const mulch = this._mat(
        'mulch',
        new THREE.MeshStandardMaterial({
          map: this._materials.get('path.gravel').map,
          color: 0x4a3a2c,
          roughness: 1,
          envMapIntensity: 0.35,
        })
      );
      const strips = [];
      for (const [x0, z0, x1, z1] of hedgeRuns) {
        const dense = [[x0, z0], [lerp(x0, x1, 0.5), lerp(z0, z1, 0.5)], [x1, z1]];
        strips.push(ribbon(dense, 0.95, (x, z) => parkHeight(x, z) + 0.02, false, 0.4));
      }
      const mm = new THREE.Mesh(mergeGeometries(strips), mulch);
      mm.matrixAutoUpdate = false;
      this._add(mm, false, true);
    }

    /* ---- benches ---- */
    const benchGeo = mergeGeometries([
      ...[0, 1, 2, 3].map((i) => new THREE.BoxGeometry(1.9, 0.07, 0.13).translate(0, 0.45, -0.24 + i * 0.16)),
      ...[0, 1, 2].map((i) => new THREE.BoxGeometry(1.9, 0.13, 0.07).translate(0, 0.62 + i * 0.16, -0.3)),
      new THREE.BoxGeometry(0.09, 0.45, 0.62).translate(-0.8, 0.22, 0),
      new THREE.BoxGeometry(0.09, 0.45, 0.62).translate(0.8, 0.22, 0),
      new THREE.BoxGeometry(0.09, 0.5, 0.09).translate(-0.8, 0.68, -0.3),
      new THREE.BoxGeometry(0.09, 0.5, 0.09).translate(0.8, 0.68, -0.3),
    ]);
    const extraBenches = [
      [-8, 0.1, 140, 0, 0, 0, 1], [8, 0.1, 140, 0, 0, 0, 1],
      [-18, 0.1, 160, 0, 0.6, 0, 1], [18, 0.1, 160, 0, -0.6, 0, 1],
      [-102, 0, 80, 0, Math.PI, 0, 1], [-88, 0, 80, 0, Math.PI, 0, 1], [-74, 0, 80, 0, Math.PI, 0, 1],
      [-36, 0, -58, 0, Math.PI, 0, 1], [-52, 0, -58, 0, Math.PI, 0, 1],
      [60, 0, -46, 0, 0, 0, 1], [76, 0, -46, 0, 0, 0, 1],
      [0, 0.1, 128, 0, Math.PI, 0, 1],
    ];
    this._instanced(
      benchGeo,
      this._materials.get('wood.plank'),
      this._groundList([...this._props.benches, ...extraBenches])
    );

    /* ---- litter bins ---- */
    const binGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.33, 0.28, 0.9, 12).translate(0, 0.45, 0),
      new THREE.CylinderGeometry(0.37, 0.37, 0.08, 12).translate(0, 0.94, 0),
    ]);
    const binMat = this._mat('bin', new THREE.MeshStandardMaterial({ color: 0x2b6b4a, roughness: 0.55, metalness: 0.3 }));
    const bins = [...this._props.bins,
      [-6, 0.1, 150], [6, 0.1, 150], [-20, 0.1, 170], [20, 0.1, 170],
      [-100, 0, 82], [-70, 0, 82], [-40, 0, -60], [64, 0, -48], [110, 0, -50],
    ];
    this._instanced(binGeo, binMat, this._groundList(bins));

    /* ---- planters ---- */
    const planterGeo = mergeGeometries([
      new THREE.BoxGeometry(1.8, 0.7, 1.8).translate(0, 0.35, 0),
      new THREE.BoxGeometry(1.55, 0.1, 1.55).translate(0, 0.72, 0),
    ]);
    const planters = [];
    const shrubs = [];
    for (let i = 0; i < 14; i++) {
      const side = i % 2 ? 1 : -1;
      const z = 132 + Math.floor(i / 2) * 6.6;
      planters.push([side * 12, 0.1, z, 0, 0, 0, 1]);
      shrubs.push([side * 12, 1.25, z, 0, i, 0, 0.9]);
    }
    this._instanced(planterGeo, this._materials.get('concrete.deck'), planters);
    // A raw icosahedron here would render black: `hedge` is a vertexColors
    // material and the generic attribute default is (0,0,0).
    this._instanced(this._leafBlob(0.7, 2600, 1), hedgeMat, shrubs);

    /* ---- bike racks and parked bikes ---- */
    const rackGeo = [];
    for (let i = 0; i < 5; i++) {
      rackGeo.push(new THREE.TorusGeometry(0.42, 0.035, 6, 14, Math.PI).translate(i * 0.85 - 1.7, 0.42, 0));
    }
    rackGeo.push(new THREE.CylinderGeometry(0.03, 0.03, 4.2, 6).rotateZ(Math.PI / 2).translate(0, 0.06, 0));
    const rack = mergeGeometries(rackGeo);
    const rackSpots = this._groundList([
      [-16, 0.1, 145, 0, 0, 0, 1], [16, 0.1, 145, 0, 0, 0, 1],
      [-104, 0, 84, 0, 0.3, 0, 1], [56, 0, 100, 0, 1.2, 0, 1],
    ]);
    this._instanced(rack, this._materials.get('metal.galv'), rackSpots);

    const bikeGeo = mergeGeometries([
      new THREE.TorusGeometry(0.34, 0.028, 6, 16).translate(-0.5, 0.34, 0),
      new THREE.TorusGeometry(0.34, 0.028, 6, 16).translate(0.5, 0.34, 0),
      strut(-0.5, 0.34, 0, 0.05, 0.62, 0, 0.045),
      strut(0.05, 0.62, 0, 0.5, 0.34, 0, 0.045),
      strut(0.05, 0.62, 0, -0.12, 0.3, 0, 0.045),
      strut(-0.12, 0.3, 0, -0.5, 0.34, 0, 0.045),
      strut(0.05, 0.62, 0, 0.02, 0.92, 0, 0.04),
      strut(-0.2, 0.86, 0, 0.2, 0.86, 0, 0.035),
      new THREE.BoxGeometry(0.24, 0.06, 0.12).translate(-0.2, 0.88, 0),
    ]);
    whiteColor(bikeGeo);
    const bikes = [];
    const brng = makeRng(88);
    for (const [rx, , rz, , rry] of rackSpots) {
      for (let i = 0; i < 5; i++) {
        if (brng() > 0.7) continue;
        const ox = i * 0.85 - 1.7;
        bikes.push([rx + Math.cos(rry) * ox, 0.1, rz - Math.sin(rry) * ox, 0, rry + Math.PI / 2, 0, 1]);
      }
    }
    const bikeMesh = this._instanced(bikeGeo, this._materials.get('metal.bike'), this._groundList(bikes), true, false);
    for (let i = 0; i < bikes.length; i++) {
      _color.setHSL((i * 0.17) % 1, 0.6, 0.45);
      bikeMesh.setColorAt(i, _color);
    }
    if (bikeMesh.instanceColor) bikeMesh.instanceColor.needsUpdate = true;

    /* ---- ball hoppers ---- */
    const hopperGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.22, 0.22, 0.62, 10, 1, true).translate(0, 0.4, 0),
      new THREE.CylinderGeometry(0.03, 0.03, 0.75, 6).translate(0, 1.05, 0),
      new THREE.BoxGeometry(0.22, 0.04, 0.06).translate(0, 1.42, 0),
    ]);
    const hopperMat = this._mat(
      'hopper',
      new THREE.MeshStandardMaterial({ color: 0xd9d9d3, roughness: 0.4, metalness: 0.6, side: THREE.DoubleSide })
    );
    if (this._props.hoppers.length) this._instanced(hopperGeo, hopperMat, this._props.hoppers);
    const ballMat = this._mat('ball.tennis', new THREE.MeshStandardMaterial({ color: 0xd7f23a, roughness: 0.85 }));
    const balls = [];
    for (const h of this._props.hoppers) {
      for (let i = 0; i < 14; i++) {
        balls.push([h[0] + (i % 3 - 1) * 0.11, 0.16 + Math.floor(i / 3) * 0.13, h[2] + ((i % 5) - 2) * 0.07, 0, 0, 0, 1]);
      }
    }
    this._instanced(new THREE.SphereGeometry(0.033, 8, 6), ballMat, balls, false, false);

    this._buildLooseProps();
    // Crowd first: every figure standing on a levelled surface contributes a
    // contact spot, and the decal pass has to see them before it bakes.
    this._buildCrowd();
    this._buildGroundDecals();
  }

  /**
   * Contact-shadow decals at every prop-to-ground junction.
   *
   * A shadow map at 3 cm per texel still cannot deliver sub-decimetre occlusion
   * at the base of a bin or a fence post, and the review was right that every
   * prop in both hero frames met the grass on a razor line and read as pasted
   * on. A multiply-blended radial gradient at ~1.3x the footprint is the
   * standard cheap stand-in for a GTAO term and costs one draw call for the
   * entire site.
   *
   * Deliberately restricted to the levelled terraces (`flatMask` near 1): on a
   * bank the decal plane would intersect the slope and show its own silhouette,
   * which is a worse artefact than the one it fixes.
   */
  _buildGroundDecals() {
    const c = makeCanvas(128, 128);
    paintPixels(c, (u, v, out) => {
      const d = Math.hypot(u - 0.5, v - 0.5) * 2;
      // Dark core, quick falloff, pure white (i.e. no change) by the rim. The
      // noise keeps the edge from reading as a drawn circle.
      const k = 1 - smoothstep(0.05, 1.0, d) * (0.62 + (fbm(u, v, 6, 2, 617) - 0.5) * 0.18);
      const g = clamp(k, 0, 1) * 255;
      out[0] = out[1] = out[2] = g;
    });
    const tex = this._tex(c, { srgb: true, repeat: 1, key: 'decal.contact' });
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    const mat = this._mat(
      'decal.contact',
      new THREE.MeshBasicMaterial({
        map: tex,
        blending: THREE.MultiplyBlending,
        transparent: true,
        // three warns (loudly, once per frame) unless this is set on a
        // multiply-blended material: the blend equation it installs is
        // (dst * src, dst * src.a), which only composites correctly if the
        // source colour has already been scaled by its own alpha.
        premultipliedAlpha: true,
        depthWrite: false,
        fog: true,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
      })
    );

    const spots = [];
    const push = (x, z, r) => {
      const onPad = x > PAD.x0 + 0.5 && x < PAD.x1 - 0.5 && z > PAD.z0 + 0.5 && z < PAD.z1 - 0.5;
      if (onPad) {
        // Only on genuinely flat apron. A planar decal laid over a bowl
        // transition shows its own silhouette, which is a worse artefact than
        // the floating it was installed to fix.
        const y = padHeight(x, z);
        if (Math.abs(y - PAD.base) > 0.12) return;
        spots.push([x, y + 0.02, z, -Math.PI / 2, 0, 0, r]);
        return;
      }
      if (flatMask(x, z) < 0.92) return;
      spots.push([x, parkHeight(x, z) + 0.035, z, -Math.PI / 2, 0, 0, r]);
    };
    for (const b of this._props.benches) push(b[0], b[2], 1.5);
    for (const b of this._props.bins) push(b[0], b[2], 0.85);
    for (const b of this._props.planters) push(b[0], b[2], 1.4);
    for (const b of this._props.bikes) push(b[0], b[2], 1.1);
    for (const g of this._props.grounding) push(g[0], g[1], g[2]);
    if (!spots.length) return;
    const geo = new THREE.PlaneGeometry(1, 1);
    const mesh = this._instanced(geo, mat, spots, false, false);
    mesh.renderOrder = 4;
  }

  /**
   * The small stuff that says a place is used rather than delivered.
   *
   * Four instanced sets keyed to the path network, the pad edges and the court
   * fence: traffic cones, kit bags, skateboards leaning on kerbs, and drink
   * bottles. Everything is one draw call per set and none of it collides -
   * these are dressing, and a player kicking through a bottle is worse than a
   * player walking over one.
   */
  _buildLooseProps() {
    const rng = makeRng(20260726);
    const L = (u, v) => [PAD.x0 + u, PAD.z0 + v];

    /* ---- traffic cones ---- */
    const coneGeo = mergeGeometries([
      new THREE.ConeGeometry(0.19, 0.62, 8).translate(0, 0.31, 0),
      new THREE.BoxGeometry(0.42, 0.045, 0.42).translate(0, 0.022, 0),
    ]);
    const coneMat = this._mat(
      'prop.cone',
      new THREE.MeshStandardMaterial({ color: 0xe25a1e, roughness: 0.62, envMapIntensity: 0.5 })
    );
    const cones = [];
    for (const [cx, cz, n, r] of [
      [-95, 62, 6, 7], [110, 26, 5, 9], [TRACK.cx - 20, TRACK.cz - 44, 7, 12],
      [0, 150, 4, 8], [46, 100, 4, 6],
    ]) {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 6.28318 + rng();
        const x = cx + Math.cos(a) * r * (0.5 + rng() * 0.6);
        const z = cz + Math.sin(a) * r * (0.5 + rng() * 0.6);
        const onPad = x > PAD.x0 && x < PAD.x1 && z > PAD.z0 && z < PAD.z1;
        cones.push([x, onPad ? padHeight(x, z) : parkHeight(x, z), z, 0, rng() * 6.28, 0, 0.9 + rng() * 0.25]);
      }
    }
    this._instanced(coneGeo, coneMat, cones);
    for (const c of cones) this._props.grounding.push([c[0], c[2], 0.62]);

    /* ---- kit bags ---- */
    const bagGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.2, 0.2, 0.66, 10).rotateZ(Math.PI / 2).translate(0, 0.2, 0),
      new THREE.BoxGeometry(0.5, 0.06, 0.1).translate(0, 0.4, 0.06),
      new THREE.BoxGeometry(0.16, 0.1, 0.14).translate(0.3, 0.2, 0),
    ]);
    whiteColor(bagGeo);
    const bagMat = this._mat(
      'prop.bag',
      new THREE.MeshStandardMaterial({
        color: 0xffffff, roughness: 0.86, vertexColors: true, envMapIntensity: 0.4,
      })
    );
    const bagCols = [0x2c3a4c, 0x6d2a2a, 0x2b4a35, 0x3d3d44, 0xa8642a, 0x1f2a35];
    const bags = [];
    const bagSpots = [
      ...L(14, 6), ...L(16, 7), ...L(31, 26), ...L(33, 27), ...L(78, 20), ...L(80, 21),
      100, 12, 102, 13, 68, 42, 30, 104, 32, 105, 62, 112,
      TRACK.cx - 14, TRACK.cz - 44, TRACK.cx - 11, TRACK.cz - 45,
      -6, 146, 8, 152, -20, 162,
    ];
    for (let i = 0; i + 1 < bagSpots.length; i += 2) {
      const x = bagSpots[i] + (rng() - 0.5) * 1.2;
      const z = bagSpots[i + 1] + (rng() - 0.5) * 1.2;
      const onPad = x > PAD.x0 && x < PAD.x1 && z > PAD.z0 && z < PAD.z1;
      bags.push([x, (onPad ? padHeight(x, z) : parkHeight(x, z)) + 0.02, z, 0, rng() * 6.28, 0, 0.85 + rng() * 0.35]);
    }
    const bagMesh = this._instanced(bagGeo, bagMat, bags);
    for (let i = 0; i < bags.length; i++) {
      _color.setHex(bagCols[i % bagCols.length]);
      bagMesh.setColorAt(i, _color);
    }
    if (bagMesh.instanceColor) bagMesh.instanceColor.needsUpdate = true;
    for (const b of bags) this._props.grounding.push([b[0], b[2], 0.9]);

    /* ---- skateboards leaning on the kerb ---- */
    const boardGeo = mergeGeometries([
      new THREE.BoxGeometry(0.21, 0.028, 0.82).translate(0, 0, 0),
      new THREE.CylinderGeometry(0.027, 0.027, 0.11, 8).rotateZ(Math.PI / 2).translate(0, -0.05, -0.24),
      new THREE.CylinderGeometry(0.027, 0.027, 0.11, 8).rotateZ(Math.PI / 2).translate(0, -0.05, 0.24),
    ]);
    whiteColor(boardGeo);
    const boardMat = this._mat(
      'prop.board',
      new THREE.MeshStandardMaterial({
        color: 0xffffff, roughness: 0.5, vertexColors: true, envMapIntensity: 0.6,
      })
    );
    const boards = [];
    for (let i = 0; i < 11; i++) {
      const u = 8 + rng() * 84;
      const v = rng() > 0.5 ? 1.2 : 73.6;
      const [x, z] = L(u, v);
      // Leaning against the kerb at ~70 degrees, tail on the ground.
      boards.push([x, padHeight(x, z) + 0.34, z, v < 40 ? 1.15 : -1.15, rng() * 0.6 - 0.3, 0, 1]);
    }
    const boardMesh = this._instanced(boardGeo, boardMat, boards);
    for (let i = 0; i < boards.length; i++) {
      _color.setHSL((i * 0.23) % 1, 0.42, 0.36);
      boardMesh.setColorAt(i, _color);
    }
    if (boardMesh.instanceColor) boardMesh.instanceColor.needsUpdate = true;

    /* ---- drink bottles ---- */
    const bottleGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.037, 0.04, 0.19, 8).translate(0, 0.095, 0),
      new THREE.CylinderGeometry(0.017, 0.024, 0.05, 8).translate(0, 0.21, 0),
    ]);
    whiteColor(bottleGeo);
    const bottleMat = this._mat(
      'prop.bottle',
      new THREE.MeshStandardMaterial({
        color: 0xffffff, roughness: 0.28, metalness: 0.1, vertexColors: true, envMapIntensity: 0.9,
      })
    );
    const bottles = [];
    for (const b of bags) bottles.push([b[0] + 0.4, b[1], b[2] + 0.25, 0, 0, 0, 1]);
    for (let i = 0; i < 14; i++) {
      const x = lerp(-30, 30, rng());
      const z = lerp(126, 180, rng());
      bottles.push([x, parkHeight(x, z), z, 0, 0, 0, 1]);
    }
    const bottleMesh = this._instanced(bottleGeo, bottleMat, bottles, true, false);
    for (let i = 0; i < bottles.length; i++) {
      _color.setHSL((i * 0.31) % 1, 0.5, 0.55);
      bottleMesh.setColorAt(i, _color);
    }
    if (bottleMesh.instanceColor) bottleMesh.instanceColor.needsUpdate = true;
  }

  /**
   * Static crowd layer.
   *
   * Six InstancedMeshes (three poses x clothing/skin) carry ~180 human-scale
   * figures. They are not animated - at these distances a silhouette with the
   * right proportions and a varied clothing colour is what sells the place as
   * inhabited, and the NPC system already provides the handful of animated
   * characters near the spawn.
   */
  _buildCrowd() {
    const rng = makeRng(70707);

    /** Build one pose as a {cloth, skin} geometry pair. */
    const figure = (pose) => {
      const cloth = [];
      const skin = [];
      const limb = (r0, r1, len) => new THREE.CylinderGeometry(r0, r1, len, 6);
      if (pose === 'crouch') {
        // Deep squat on the coping / kerb edge: the single most common
        // skatepark posture and completely absent from the previous three.
        cloth.push(limb(0.09, 0.11, 0.42).rotateX(1.25).translate(-0.11, 0.5, 0.12));
        cloth.push(limb(0.09, 0.11, 0.42).rotateX(1.25).translate(0.11, 0.5, 0.12));
        cloth.push(limb(0.075, 0.09, 0.42).rotateX(-0.35).translate(-0.11, 0.2, 0.3));
        cloth.push(limb(0.075, 0.09, 0.42).rotateX(-0.35).translate(0.11, 0.2, 0.3));
        cloth.push(limb(0.175, 0.15, 0.5).rotateX(0.28).translate(0, 0.78, -0.05));
        cloth.push(limb(0.055, 0.05, 0.46).rotateX(1.0).translate(-0.2, 0.72, 0.14));
        cloth.push(limb(0.055, 0.05, 0.46).rotateX(1.0).translate(0.2, 0.72, 0.14));
        skin.push(new THREE.SphereGeometry(0.105, 8, 6).translate(0, 1.12, -0.06));
        skin.push(limb(0.045, 0.045, 0.09).translate(0, 1.02, -0.05));
      } else if (pose === 'carry') {
        // Standing, weight on one hip, kit bag over the shoulder.
        cloth.push(limb(0.085, 0.105, 0.88).rotateZ(-0.07).translate(-0.13, 0.44, 0));
        cloth.push(limb(0.085, 0.105, 0.88).rotateZ(0.03).translate(0.1, 0.44, 0.02));
        cloth.push(limb(0.185, 0.15, 0.62).rotateZ(0.06).translate(0, 1.18, 0));
        cloth.push(limb(0.055, 0.05, 0.5).rotateZ(0.9).translate(-0.24, 1.3, 0.02));
        cloth.push(limb(0.055, 0.05, 0.58).rotateZ(-0.1).translate(0.23, 1.16, -0.01));
        cloth.push(new THREE.BoxGeometry(0.5, 0.24, 0.22).translate(-0.3, 1.02, 0.06));
        skin.push(new THREE.SphereGeometry(0.108, 8, 6).translate(0.01, 1.62, 0));
        skin.push(limb(0.046, 0.046, 0.1).translate(0.01, 1.5, 0));
      } else if (pose === 'sit') {
        // Thighs forward, shins down, torso upright.
        cloth.push(limb(0.085, 0.1, 0.44).rotateX(Math.PI / 2).translate(-0.1, 0.44, 0.2));
        cloth.push(limb(0.085, 0.1, 0.44).rotateX(Math.PI / 2).translate(0.1, 0.44, 0.2));
        cloth.push(limb(0.07, 0.085, 0.44).translate(-0.1, 0.22, 0.4));
        cloth.push(limb(0.07, 0.085, 0.44).translate(0.1, 0.22, 0.4));
        cloth.push(limb(0.17, 0.145, 0.52).translate(0, 0.72, 0.02));
        cloth.push(limb(0.055, 0.05, 0.42).rotateX(0.7).translate(-0.19, 0.66, 0.16));
        cloth.push(limb(0.055, 0.05, 0.42).rotateX(0.7).translate(0.19, 0.66, 0.16));
        skin.push(new THREE.SphereGeometry(0.105, 8, 6).translate(0, 1.06, 0));
        skin.push(limb(0.045, 0.045, 0.09).translate(0, 0.96, 0));
      } else if (pose === 'lean') {
        cloth.push(limb(0.08, 0.1, 0.86).rotateZ(0.12).translate(-0.14, 0.43, 0));
        cloth.push(limb(0.08, 0.1, 0.86).rotateZ(0.04).translate(0.09, 0.43, 0));
        cloth.push(limb(0.18, 0.15, 0.6).rotateZ(-0.14).translate(0.02, 1.16, 0));
        cloth.push(limb(0.055, 0.05, 0.56).rotateZ(0.5).translate(-0.26, 1.12, 0.02));
        cloth.push(limb(0.055, 0.05, 0.56).rotateZ(-0.2).translate(0.25, 1.1, 0.04));
        skin.push(new THREE.SphereGeometry(0.108, 8, 6).translate(0.08, 1.58, 0.02));
        skin.push(limb(0.046, 0.046, 0.1).translate(0.06, 1.46, 0.01));
      } else {
        cloth.push(limb(0.085, 0.105, 0.88).translate(-0.11, 0.44, 0));
        cloth.push(limb(0.085, 0.105, 0.88).translate(0.11, 0.44, 0.02));
        cloth.push(limb(0.185, 0.15, 0.62).translate(0, 1.18, 0));
        cloth.push(limb(0.055, 0.05, 0.58).rotateZ(0.13).translate(-0.23, 1.16, 0.01));
        cloth.push(limb(0.055, 0.05, 0.58).rotateZ(-0.13).translate(0.23, 1.16, -0.01));
        skin.push(new THREE.SphereGeometry(0.108, 8, 6).translate(0, 1.62, 0));
        skin.push(limb(0.046, 0.046, 0.1).translate(0, 1.5, 0));
      }
      return { cloth: whiteColor(mergeGeometries(cloth)), skin: whiteColor(mergeGeometries(skin)) };
    };

    /*
     * These two materials had `color: 0xffffff` and no `vertexColors`.
     *
     * InstancedMesh.setColorAt() writes an `instanceColor` attribute that the
     * fragment stage only ever reads when USE_COLOR is defined - which three
     * only does when the material asks for vertex colours. Every one of the
     * ~180 figures was therefore rendering as pure unpigmented white: not a
     * subtle palette problem, a hard bug that made the crowd read as a
     * rendering error rather than as people. With vertexColors on, the base
     * colour becomes a multiplier: white for cloth (the palette below carries
     * the whole albedo) and a light skin base the per-instance tint darkens.
     */
    const clothMat = this._mat(
      'crowd.cloth',
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.82,
        metalness: 0.02,
        vertexColors: true,
        envMapIntensity: 0.45,
      })
    );
    const skinMat = this._mat(
      'crowd.skin',
      new THREE.MeshStandardMaterial({
        color: 0xc89a7c,
        roughness: 0.65,
        metalness: 0,
        vertexColors: true,
        envMapIntensity: 0.4,
      })
    );

    // Sixteen real sportswear albedos: rust, denim, olive, mustard, charcoal,
    // teal, oxblood, sand, white. Saturated *enough* to read as clothing at
    // 30 m, mixed with grey so nothing turns into a neon dot on the concrete.
    const CLOTH = [
      0xb4553a, 0x3f5b86, 0x5f6b3c, 0xc39a3a, 0x33383d,
      0xe6e4dd, 0x2f6d70, 0x7a2f36, 0xc9bda2, 0x4e4a58,
      0x8f4f6b, 0x2a4f3a, 0xd07a3e, 0x6d7b88, 0x1f2a35, 0xa8ab9c,
    ];

    const stand = [];
    const sit = [];
    const lean = [];
    const crouch = [];
    const carry = [];

    /*
     * Seated spectators.
     *
     * Previously the bleachers only offered every third seat as a candidate and
     * then rejected 45% of those, so the nearest stand in the courts frame was
     * 100% empty and the site read as a facility that had been built and then
     * abandoned before opening day.
     *
     * A uniform probability is the wrong model anyway - it gives an even dusting
     * of isolated figures, which reads as scattered mannequins. People arrive in
     * groups and sit together, leaving whole runs empty. Seeding a handful of
     * group centres per stand and filling with probability falling off from each
     * centre produces clumps and gaps, which is what a real half-full stand
     * looks like. Total is capped so the seated crowd cannot run away with the
     * triangle budget.
     */
    const seats = this._props.crowdSeats ?? [];
    if (seats.length) {
      let standCount = 0;
      for (const s of seats) standCount = Math.max(standCount, (s[4] ?? 0) + 1);
      // Group centres, in seat-array index space, per stand.
      const centres = [];
      for (let st = 0; st < standCount; st++) {
        const idx = [];
        for (let i = 0; i < seats.length; i++) if ((seats[i][4] ?? 0) === st) idx.push(i);
        if (!idx.length) continue;
        // The two stands the hero cameras actually see get more, and denser,
        // groups than the outlying ones.
        const busy = st === 2 || st === 0;
        const groups = busy ? 6 : 3;
        for (let g = 0; g < groups; g++) {
          const anchor = seats[idx[(rng() * idx.length) | 0]];
          centres.push({
            st,
            x: anchor[0],
            y: anchor[1],
            peak: busy ? 0.92 : 0.72,
            radius: 5.0 + rng() * 4.5,
          });
        }
      }
      const SEATED_CAP = 560;
      for (let i = 0; i < seats.length && sit.length < SEATED_CAP; i++) {
        const [sx, sy, sz, ry, st] = seats[i];
        let p = 0;
        for (const c of centres) {
          if (c.st !== st) continue;
          // Distance measured along the run and up the rake, so a group is a
          // blob of neighbouring seats rather than a horizontal line.
          const d = Math.hypot(sx - c.x, (sy - c.y) * 2.4);
          if (d > c.radius) continue;
          const q = c.peak * (1 - d / c.radius);
          if (q > p) p = q;
        }
        if (rng() > p) continue;
        // The seat pan sits 0.435 m above `sy` and the sit pose's hips are at
        // 0.44 in figure space, so the figure origin belongs at the deck line.
        // The old -0.4 sank every spectator into the tread: their heads ended
        // up 6 cm BELOW the top of their own seat back, which is why a stand
        // could be 40% occupied and still photograph as completely empty.
        sit.push([sx, sy - 0.01, sz, 0, ry + (rng() - 0.5) * 0.3, 0, 0.92 + rng() * 0.18]);
      }
    }

    /**
     * Scatter n figures in a rect, dropped onto whichever surface applies.
     * Y scale varies independently of X/Z so the crowd has a height spread -
     * a row of identically-tall figures reads as a repeated asset instantly.
     */
    const scatter = (list, n, x0, z0, x1, z1, heightFn, tries = 40) => {
      for (let k = 0, guard = 0; k < n && guard < n * tries; guard++) {
        const x = lerp(x0, x1, rng());
        const z = lerp(z0, z1, rng());
        const y = heightFn(x, z);
        if (y === null) continue;
        const s = 0.9 + rng() * 0.22;
        list.push([x, y, z, 0, rng() * 6.28, 0, s, s * (0.92 + rng() * 0.16), s]);
        k++;
      }
    };

    /**
     * A knot of figures around a focal point, all roughly facing it.
     * People at a park stand in groups looking at something; a uniform rect
     * scatter is what makes a crowd read as mannequins on a diorama.
     */
    const knot = (list, n, cx, cz, spread, heightFn) => {
      for (let k = 0, guard = 0; k < n && guard < n * 30; guard++) {
        const a = rng() * 6.28318;
        const r = spread * (0.25 + rng() * 0.75);
        const x = cx + Math.cos(a) * r;
        const z = cz + Math.sin(a) * r;
        const y = heightFn(x, z);
        if (y === null) continue;
        const s = 0.9 + rng() * 0.22;
        // Face roughly inward, with enough slop that nobody is perfectly aimed.
        const ry = Math.atan2(cx - x, cz - z) + (rng() - 0.5) * 1.1;
        list.push([x, y, z, 0, ry, 0, s, s * (0.92 + rng() * 0.16), s]);
        k++;
      }
    };

    // Skaters on the pad. Clustered on the bowl lip, the stair set and the
    // half-pipe deck - the three places people actually stand in a skatepark.
    const padY = (x, z) => padHeight(x, z);
    knot(stand, 7, PAD.x0 + 30, PAD.z0 + 27, 4.5, padY);   // bowl deep-end lip
    knot(crouch, 4, PAD.x0 + 31, PAD.z0 + 28, 5.0, padY);
    knot(stand, 5, PAD.x0 + 18, PAD.z0 + 15, 4.0, padY);   // top of the stair set
    knot(lean, 4, PAD.x0 + 78, PAD.z0 + 22, 5.5, padY);    // half-pipe deck
    knot(carry, 3, PAD.x0 + 12, PAD.z0 + 6, 5.0, padY);    // arriving at the gate
    scatter(stand, 7, PAD.x0 + 6, PAD.z0 + 4, PAD.x1 - 6, PAD.z1 - 8, padY);
    scatter(lean, 5, PAD.x0 + 8, PAD.z0 + 50, PAD.x1 - 10, PAD.z1 - 6, padY);
    // Skiers on the piste - only where there is actually snow underfoot.
    scatter(stand, 20, SKI.x0 + 20, -180, SKI.x1 - 20, -86, (x, z) => {
      const y = skiHeight(x, z);
      return y > 2 ? y : null;
    }, 60);
    // Pool deck and courts, knotted at the blocks, the boards and the fence line.
    knot(stand, 6, 30, 108, 3.5, () => 0.1);
    knot(carry, 3, 29, 118, 3.0, () => 0.1);
    knot(stand, 5, 64, 112, 3.5, () => 0.1);
    scatter(stand, 4, 61, 100, 74, 124, () => 0.1);
    knot(stand, 5, 112, 8, 4.0, () => 0.07);   // court-side fence
    knot(lean, 4, 90, 26, 4.0, () => 0.07);
    scatter(stand, 5, 66, 6, 124, 46, () => 0.07);
    // Track infield and the home straight.
    scatter(stand, 9, TRACK.cx - 40, TRACK.cz - 30, TRACK.cx + 40, TRACK.cz + 30, () => 0.03);
    scatter(lean, 8, TRACK.cx - 50, TRACK.cz - 52, TRACK.cx + 50, TRACK.cz - 46, () => 0.03);
    knot(crouch, 4, TRACK.cx - 10, TRACK.cz - 44, 4.0, () => 0.03); // set on the blocks
    // Plaza and the avenue, where the player actually arrives.
    const groundY = (x, z) => parkHeight(x, z);
    knot(stand, 8, 0, 168, 6.0, groundY);      // under the entrance arch
    knot(carry, 5, -12, 148, 5.0, groundY);
    knot(lean, 6, 14, 140, 5.0, groundY);
    scatter(stand, 12, -24, 122, 24, 178, groundY);
    // The set-dressing clusters need people in them or they read as abandoned
    // kit rather than as an event in progress.
    knot(stand, 7, -94, 76.5, 5.0, groundY);   // marquee row on the pad edge
    knot(carry, 4, -86, 76, 4.5, groundY);
    knot(lean, 5, -70, 76, 4.5, groundY);      // by the crew vans
    knot(stand, 5, 7, 158, 4.0, groundY);      // plaza refreshment tent
    knot(stand, 4, 78, 41, 4.0, () => 0.07);   // grounds crew at the yard
    // Queue at the chairlift base and arrivals at the lodge door.
    knot(stand, 8, -88, -84, 5.0, groundY);
    knot(lean, 4, -44, -58, 4.5, groundY);
    // Spectators standing along the court fence and the pad viewing barrier.
    scatter(stand, 9, -116, 76, -88, 80, groundY);
    scatter(lean, 6, 68, 50, 96, 53, groundY);
    // Car park.
    scatter(stand, 6, 90, 134, 166, 190, (x, z) => parkHeight(x, z) + 0.05);
    knot(carry, 4, 112, 150, 6.0, (x, z) => parkHeight(x, z) + 0.05);

    /*
     * Every standing figure gets a contact spot.
     *
     * A human on a levelled slab is the single worst offender for the
     * pasted-on read: the shadow cascade resolves a 3 cm texel at 55 m but the
     * figures that matter are on the far side of a 100 m pad, where cascade 1's
     * 25 cm texel simply cannot draw the 30 cm penumbra under a pair of feet.
     * The decal pass already exists for bins and fence posts; feeding the crowd
     * through it costs instances, not draw calls, and it is what stops ~180
     * people reading as decals standing on a photograph.
     */
    for (const list of [stand, lean, crouch, carry]) {
      for (const q of list) {
        // Only figures actually standing on the levelled terrain. The skiers
        // are 40 m up a snow mound whose flat zone reads as levelled, so
        // without this test their decals would be baked into the hillside.
        if (Math.abs(q[1] - parkHeight(q[0], q[2])) > 0.3) continue;
        this._props.grounding.push([q[0], q[2], 0.95]);
      }
    }

    const poses = [
      ['stand', stand], ['sit', sit], ['lean', lean],
      ['crouch', crouch], ['carry', carry],
    ];
    for (const [pose, list] of poses) {
      if (!list.length) continue;
      const { cloth, skin } = figure(pose);
      const cm = this._instanced(cloth, clothMat, list);
      const sm = this._instanced(skin, skinMat, list, true, false);
      for (let i = 0; i < list.length; i++) {
        const pick = (hash2i(i, pose.length, 401) * CLOTH.length) | 0;
        _color.setHex(CLOTH[pick % CLOTH.length]);
        // +/-10% value jitter on top of the palette entry so two figures in the
        // same shirt are still not the same pixel.
        const jit = 0.9 + hash2i(i, 3, 409) * 0.2;
        _color.multiplyScalar(jit);
        cm.setColorAt(i, _color);
        // Skin: a multiplier on the light base, from pale to deep.
        const tone = 0.5 + hash2i(i, 11, 421) * 0.55;
        _color.setRGB(tone * (1.0 + hash2i(i, 7, 419) * 0.06), tone, tone * 0.94);
        sm.setColorAt(i, _color);
      }
      if (cm.instanceColor) cm.instanceColor.needsUpdate = true;
      if (sm.instanceColor) sm.instanceColor.needsUpdate = true;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Spawns, portals and the minimap floorplan                         */
  /* ---------------------------------------------------------------- */

  _buildSpawns() {
    // Arrive on the plaza looking north up the avenue, gate at your back.
    this.playerSpawn = new THREE.Vector3(0, 0.9, 145);
    this.playerSpawnYaw = 0;

    this.portalSpecs = [
      {
        position: new THREE.Vector3(0, 0.42, 150),
        rotationY: Math.PI,
        target: 'station',
        label: 'Aether Station',
        accent: 0x2fe6ff,
      },
    ];

    // Spawns and patrol nodes are authored on the site plan, so they have to be
    // lifted onto the terrain the same way every prop is.
    const P = (x, z, y = 0) => new THREE.Vector3(x, y + parkHeight(x, z), z);

    this.npcSpawns = [
      {
        position: P(-88, 12, 0.2),
        type: 'friendly',
        name: 'Marisol "Ripgrind" Vance',
        persona:
          'Skate coach who has run this bowl for nineteen years and has the scars to prove it. Speaks entirely in encouragement and bail advice, insists every fall is "just data", and will not let anyone drop in without checking their helmet strap. Refers to the deep end as "the office".',
        patrol: [P(-88, 12), P(-96, 30), P(-80, 48), P(-70, 26)],
      },
      {
        position: P(-52, -56, 0),
        type: 'friendly',
        name: 'Kjell Nordvik',
        persona:
          'Ski instructor from a mountain nobody here can pronounce. Relentlessly calm, describes terrifying things as "quite nice actually", and measures all distances in "one good schuss". Convinced the artificial snow is superior to the real thing and gets defensive if you disagree.',
        patrol: [P(-52, -56), P(-64, -72), P(-40, -78), P(-34, -60)],
      },
      {
        position: P(90, 26, 0),
        type: 'friendly',
        name: 'Deborah Quint-Halloway',
        persona:
          'Honorary Secretary of the Meridian Pickleball Club and its most feared competitor. Keeps a laminated ladder in her bag, remembers every disputed line call since 2019, and will challenge you to a game within thirty seconds of meeting. Considers tennis "a lovely hobby for people with time".',
        patrol: [P(90, 26), P(78, 14), P(78, 38), P(96, 30)],
      },
      {
        position: P(29, 110, 0.2),
        type: 'friendly',
        name: 'Tavius Okonkwo',
        persona:
          'Lifeguard who has never once needed to rescue anyone and is deeply, professionally frustrated about it. Narrates pool safety statistics unprompted, blows the whistle at seagulls, and has strong opinions about running on wet tiles. Secretly wants someone to at least pretend to struggle.',
        patrol: [P(29, 110), P(29, 120), P(66, 122), P(66, 104)],
      },
      {
        position: P(-24, 84, 0),
        type: 'friendly',
        name: 'Bernard "Bernie" Ashgrove',
        persona:
          'Groundskeeper of forty years who considers the mowing stripes his life\'s work and the skate park a personal insult. Will tell you exactly which blade height each zone gets. Carries a rake he never uses and a thermos he uses constantly. Believes weeds are a moral failing.',
        patrol: [P(-24, 84), P(-6, 92), P(10, 74), P(-14, 62)],
      },
      {
        position: P(62, -48, 0),
        type: 'friendly',
        name: 'Priya Raghunathan',
        persona:
          'Middle-distance runner permanently between intervals, so every sentence is delivered in short breathless bursts with a glance at her watch. Cheerful, hyper-specific about splits, and will absolutely start jogging on the spot while talking to you. Ninety seconds of recovery left, no more.',
        patrol: [P(62, -48), P(70, -56), P(86, -54), P(72, -42)],
      },
    ];

    // Rogue security drones work the outer perimeter and the car park - all of
    // them well over 80 m from the gate so arrival is never an ambush.
    const hostilePosts = [
      [118, 152, [[118, 152], [150, 152], [150, 182], [118, 182]]],
      [96, 168, [[96, 168], [96, 140], [128, 138], [128, 170]]],
      [156, 140, [[156, 140], [166, 168], [140, 186], [136, 148]]],
      [172, 60, [[172, 60], [176, 10], [150, -10], [168, 40]]],
      [150, 100, [[150, 100], [178, 96], [180, 130], [152, 128]]],
      [-160, 120, [[-160, 120], [-176, 60], [-150, 20], [-140, 90]]],
      [-170, -20, [[-170, -20], [-178, -70], [-150, -60], [-152, 10]]],
      [-150, 176, [[-150, 176], [-186, 168], [-184, 118], [-146, 132]]],
      [70, -176, [[70, -176], [130, -178], [150, -166], [96, -160]]],
      [176, -30, [[176, -30], [184, 30], [160, 76], [168, 10]]],
    ];
    for (const [x, z, route] of hostilePosts) {
      this.npcSpawns.push({
        position: P(x, z, 0),
        type: 'hostile',
        name: 'Rogue Security Unit',
        persona:
          'A decommissioned facility security drone still running its last patrol order. Hostile, wordless, and extremely committed to the car park.',
        patrol: route.map(([px, pz]) => P(px, pz)),
      });
    }

    /* ---- minimap floorplan ---- */
    const concrete = 'rgba(150,154,160,0.55)';
    const stroke = 'rgba(232,240,248,0.55)';
    const shapes = [
      { kind: 'rect', x: 0, z: 153, w: 52, d: 50, rotation: 0, fill: 'rgba(176,180,186,0.5)', stroke },
      { kind: 'rect', x: -75, z: 37.5, w: 100, d: 75, rotation: 0, fill: concrete, stroke },
      { kind: 'circle', x: -95, z: 40, r: 13, fill: 'rgba(90,96,104,0.75)', stroke: 'rgba(255,255,255,0.7)' },
      { kind: 'circle', x: -77, z: 34, r: 9.5, fill: 'rgba(90,96,104,0.75)', stroke: 'rgba(255,255,255,0.7)' },
      { kind: 'rect', x: -47, z: 16, w: 28, d: 13.2, rotation: 0, fill: 'rgba(104,110,118,0.7)', stroke },
      { kind: 'rect', x: -46, z: 68.5, w: 50, d: 8, rotation: 0, fill: 'rgba(104,110,118,0.7)', stroke },
      { kind: 'rect', x: -62.5, z: -136, w: 125, d: 130, rotation: 0, fill: 'rgba(236,244,252,0.55)', stroke },
      { kind: 'rect', x: 112, z: 26, w: 18.3, d: 36.6, rotation: 0, fill: 'rgba(46,120,168,0.72)', stroke },
      { kind: 'rect', x: 78, z: 20.5, w: 18.3, d: 9.14, rotation: 0, fill: 'rgba(150,66,46,0.72)', stroke },
      { kind: 'rect', x: 78, z: 31.5, w: 18.3, d: 9.14, rotation: 0, fill: 'rgba(150,66,46,0.72)', stroke },
      { kind: 'rect', x: 46, z: 111, w: 28, d: 16, rotation: 0, fill: 'rgba(38,158,196,0.8)', stroke: 'rgba(230,250,255,0.8)' },
      { kind: 'rect', x: 128, z: 162, w: 80, d: 60, rotation: 0, fill: 'rgba(72,76,82,0.5)', stroke },
      { kind: 'rect', x: -46, z: 138, w: 28, d: 16, rotation: 0, fill: 'rgba(120,126,134,0.7)', stroke },
      { kind: 'rect', x: -46, z: -64, w: 26, d: 16, rotation: 0, fill: 'rgba(122,86,54,0.75)', stroke },
      // Meridian Tower: the navigational anchor on the plaza axis.
      { kind: 'rect', x: 0, z: 40, w: 10.4, d: 10.4, rotation: 0, fill: 'rgba(255,214,140,0.85)', stroke: 'rgba(255,240,200,0.95)' },
    ];

    const trackOuter = ovalPath(TRACK.cx, TRACK.cz, TRACK.straight, TRACK.inner + TRACK.lanes * TRACK.laneW, 28, 8);
    const trackInner = ovalPath(TRACK.cx, TRACK.cz, TRACK.straight, TRACK.inner, 28, 8);
    shapes.push({ kind: 'path', points: trackOuter.map((p) => [p[0], p[1]]), stroke: 'rgba(214,86,64,0.9)', width: 3, closed: true });
    shapes.push({ kind: 'path', points: trackInner.map((p) => [p[0], p[1]]), stroke: 'rgba(214,86,64,0.75)', width: 2, closed: true });

    // Chairlift line and the main avenue read as navigation cues.
    shapes.push({ kind: 'path', points: [[-88, -80], [-88, -192]], stroke: 'rgba(255,255,255,0.65)', width: 2, closed: false });
    for (const route of [
      [[0, 176], [0, 92]],
      [[0, 92], [-100, 79]],
      [[0, 92], [52, 110]],
      [[0, 92], [95, 30]],
      [[0, 92], [-56, -64]],
      [[0, 92], [62, -52]],
      [[0, 160], [112, 162]],
    ]) {
      shapes.push({ kind: 'path', points: route, stroke: 'rgba(226,232,240,0.45)', width: 2, closed: false });
    }

    this.minimapShapes = shapes;
  }
}
