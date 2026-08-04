/**
 * Aldermoor Vale's ground, and the layout constants that shape it.
 *
 * Lifted out of `MedievalWorld.js` verbatim so that the generation worker can
 * import it without dragging in `three`, the interior kit and the rest of a
 * nine-thousand-line world. `MedievalWorld` imports these same symbols back, so
 * there is still exactly one definition of where the ground is - which is the
 * only property that actually matters here. The terrain mesh, the collision
 * heightfield, the macro texture and every prop placement read this function,
 * and a second copy of it in the worker would be a second thing to keep in step.
 *
 * Nothing in this file may import `three` or touch the DOM.
 */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Hermite ramp: 0 below `e0`, 1 above `e1`. */
export function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
export function smootherstep(t) {
  t = clamp01(t);
  return t * t * t * (t * (t * 6 - 15) + 10);
}
/** 0 at `a` and `b`, 1 in the middle - used for carving moats and channels. */
export function bump(x, a, b) {
  if (x <= a || x >= b) return 0;
  const t = (x - a) / (b - a);
  return smootherstep(Math.min(t, 1 - t) * 2);
}

/** Signed distance to an axis-aligned rectangle centred on the origin. */
export function rectDist(dx, dz, hx, hz) {
  const ax = Math.abs(dx) - hx;
  const az = Math.abs(dz) - hz;
  const ox = Math.max(ax, 0);
  const oz = Math.max(az, 0);
  return Math.sqrt(ox * ox + oz * oz) + Math.min(Math.max(ax, az), 0);
}

/* Gradient noise. Deterministic across reloads so collision, macro texture and
 * prop placement all agree on where the ground is. */
const _perm = new Uint8Array(512);
const _gx = new Float32Array([1, -1, 1, -1, 1, -1, 0, 0]);
const _gz = new Float32Array([1, 1, -1, -1, 0, 0, 1, -1]);
(function seedPerm() {
  const rnd = mulberry32(0x5eed10a7);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  for (let i = 0; i < 512; i++) _perm[i] = p[i & 255];
})();

function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function perlin2(x, z) {
  const fx = Math.floor(x);
  const fz = Math.floor(z);
  const X = fx & 255;
  const Z = fz & 255;
  const xf = x - fx;
  const zf = z - fz;
  const u = fade(xf);
  const v = fade(zf);
  const A = _perm[X] + Z;
  const B = _perm[X + 1] + Z;
  const h00 = _perm[A] & 7;
  const h01 = _perm[A + 1] & 7;
  const h10 = _perm[B] & 7;
  const h11 = _perm[B + 1] & 7;
  const n00 = _gx[h00] * xf + _gz[h00] * zf;
  const n10 = _gx[h10] * (xf - 1) + _gz[h10] * zf;
  const n01 = _gx[h01] * xf + _gz[h01] * (zf - 1);
  const n11 = _gx[h11] * (xf - 1) + _gz[h11] * (zf - 1);
  return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v);
}

export function fbm2(x, z, octaves, lacunarity = 2.03, gain = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x;
  let fz = z;
  for (let i = 0; i < octaves; i++) {
    sum += perlin2(fx, fz) * amp;
    norm += amp;
    amp *= gain;
    fx *= lacunarity;
    fz *= lacunarity;
  }
  return sum / norm;
}

/* ------------------------------------------------------------------ */
/* World layout - one place to change where anything lives.            */
/* ------------------------------------------------------------------ */

export const HALF = 200;
export const CASTLE = { x: -72, z: -58, hx: 40, hz: 33, ground: 9.6 };
export const MARKET = { x: 34, z: 18, hx: 17, hz: 15, y: 4.6 };
export const VILLAGE = { x: 44, z: 26, hx: 58, hz: 42, y: 4.6 };
export const CIRCLE = { x: 2, z: -22, r: 8.6 };
export const BRIDGE_X = 26;

/**
 * Flatten pads under the two axis-aligned parish churches so their slabs sit
 * true on the hillside. Applied LAST in `medievalHeight` so nothing re-adds
 * height. `y` is lazily sampled from the un-padded terrain at the pad centre.
 */
export const CHURCH_PADS = [
  { x: -146, z: -30, hx: 7.2, hz: 10.6, blend: 5, y: null, _lock: false },
  { x: -60, z: -136, hx: 7.0, hz: 10.2, blend: 5, y: null, _lock: false },
];

/** River centreline: a lazy meander running west to east across the south. */
export function riverZ(x) {
  return 104 + 20 * Math.sin(x * 0.011) + 7 * Math.sin(x * 0.027 + 1.3);
}

/**
 * Authoritative ground height. The terrain mesh, collision heightfield, macro
 * texture and every prop placement read this, so they cannot disagree.
 * @returns {number} world Y in metres
 */
export function medievalHeight(x, z) {
  // Broad rolling hills, a medium band, then a low-amplitude fine layer.
  let h = 6.0 + fbm2(x * 0.0038, z * 0.0038, 5) * 11.0;
  h += fbm2(x * 0.017, z * 0.017, 3) * 1.9;
  h += perlin2(x * 0.075, z * 0.075) * 0.18;

  // ---- River valley, then the incised channel.
  const rz = riverZ(x);
  const rd = Math.abs(z - rz);
  h = lerp(2.3, h, smoothstep(16, 108, rd));
  const chanHalf = 9.5;
  if (rd < chanHalf + 8) {
    const t = smootherstep(clamp01((chanHalf + 8 - rd) / 8));
    const bed = -1.7 + 0.7 * Math.cos((Math.min(rd, chanHalf) / chanHalf) * Math.PI * 0.5);
    h = lerp(h, bed, t);
  }

  // ---- Bridge causeway: lift the approaches out of the flood plain, but
  // never inside the channel or the bridge would have nothing to span.
  const bx = Math.abs(x - BRIDGE_X);
  if (bx < 11 && rd > 10.5 && rd < 46) {
    const w = smoothstep(11, 5, bx) * smoothstep(10.5, 15, rd) * smoothstep(46, 30, rd);
    h = lerp(h, 4.15, w);
  }

  // ---- Village terrace.
  const vd = rectDist(x - VILLAGE.x, z - VILLAGE.z, VILLAGE.hx, VILLAGE.hz);
  h = lerp(h, VILLAGE.y, 0.88 * (1 - smoothstep(0, 30, vd)));

  // ---- Market square, dead flat so the stalls sit true.
  const md = rectDist(x - MARKET.x, z - MARKET.z, MARKET.hx, MARKET.hz);
  h = lerp(h, MARKET.y, 1 - smoothstep(0, 9, md));

  // ---- Stone-circle knoll.
  const kd = Math.hypot(x - CIRCLE.x, z - CIRCLE.z);
  h += 4.4 * Math.exp(-(kd * kd) / 900);

  // ---- Castle rise, then the moat cut into its glacis.
  const cd = rectDist(x - CASTLE.x, z - CASTLE.z, CASTLE.hx, CASTLE.hz);
  h = lerp(h, CASTLE.ground, 1 - smoothstep(6, 44, cd));
  const moat = bump(cd, 3.6, 17.4);
  if (moat > 0) h = lerp(h, CASTLE.ground - 4.9, moat);

  // ---- Parish church pads (kept last so the churches sit on flat ground).
  for (const pad of CHURCH_PADS) {
    if (pad._lock) continue;
    const pd = rectDist(x - pad.x, z - pad.z, pad.hx, pad.hz);
    if (pd >= pad.blend) continue;
    if (pad.y == null) {
      pad._lock = true;
      pad.y = medievalHeight(pad.x, pad.z);
      pad._lock = false;
    }
    h = lerp(pad.y, h, smoothstep(0, pad.blend, pd));
  }

  return h;
}
