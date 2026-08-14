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

/**
 * Half-width of the playable square, metres. The vale is `2 * HALF` on a side.
 *
 * This is the ONE authored extent in the world. The terrain mesh, the
 * collision heightfield, the macro albedo, the containment walls, the distant
 * skirt, the grass zones, the water ribbon and every scatter bound derive from
 * it - none of them may write a playfield dimension as a literal, because a
 * literal is a place the world silently stops agreeing with itself. It lives
 * in this module rather than in `MedievalWorld.js` so the generation worker,
 * which cannot import `three`, reads the same number.
 *
 * 450 (900 x 900 m, 5.06x the area of the original 400 m vale).
 */
export const HALF = 450;
export const CASTLE = { x: -72, z: -58, hx: 40, hz: 33, ground: 9.6 };
export const MARKET = { x: 34, z: 18, hx: 17, hz: 15, y: 4.6 };
export const VILLAGE = { x: 44, z: 26, hx: 58, hz: 42, y: 4.6 };
export const CIRCLE = { x: 2, z: -22, r: 8.6 };
export const BRIDGE_X = 26;

/**
 * Height of the river and moat water planes, metres.
 *
 * Lives here rather than in `MedievalWorld.js` because the FORDS are authored
 * against it: "a shallow bed" is not a statement about the ground, it is a
 * statement about the ground *relative to the water surface*, and a ford bed
 * authored against a remembered 0.85 would silently become a swim the day the
 * river level moved. `MedievalWorld` imports it back, so there is still one
 * definition of where the water is.
 */
export const WATER_Y = 0.85;

/**
 * Half-width of the ORIGINAL 400 m vale, and the line this phase may not
 * cross.
 *
 * Everything inside `|x| <= INNER_KEEP && |z| <= INNER_KEEP` was authored,
 * lit, dressed and photographed against a settled village, a castle, a market
 * and a bridge. Moving the ground under any of it by so much as a float ULP
 * moves twenty-five house slabs, two church pads, the market cobbles, the
 * bridge abutments and every prop that was placed by sampling this function -
 * and none of that fails loudly. So the rule for the expansion is absolute
 * rather than approximate: **every term added below is multiplied by a factor
 * that is exactly zero throughout the inner square**, and `medievalHeight` is
 * bit-identical in there. `scripts/tests/medieval-landforms.test.mjs` pins it
 * with a digest over 295,926 samples.
 *
 * Two mechanisms deliver that, and both are checkable rather than asserted:
 *
 *   - `ringMask` is a `smoothstep` whose lower edge IS `INNER_KEEP`, over the
 *     Chebyshev radius. `smoothstep` clamps, so the mask is exactly 0 - not
 *     nearly 0 - anywhere in the square.
 *   - Every landform below returns identically zero outside its own declared
 *     AABB, and every one of those AABBs is disjoint from the inner square.
 *     No landform reaches in. That was a choice: a reach could have been
 *     argued for, but "nothing touches it" is a far stronger thing to be able
 *     to prove, and the ring is 650,000 m2 - there is no shortage of room.
 */
export const INNER_KEEP = 200;

/**
 * Where the ring mask reaches full strength.
 *
 * 68 m of ramp. Short enough that the new relief has arrived by the time the
 * player has walked out of the old vale, long enough that the transition is
 * not a visible terrace ringing the middle of the map.
 */
const RING_OUT = 268;

/**
 * How much of the outer ring a point is in: 0 inside the old vale, 1 well
 * outside it. Chebyshev rather than Euclidean radius because the thing being
 * protected is a SQUARE.
 */
export function ringMask(x, z) {
  return smoothstep(INNER_KEEP, RING_OUT, Math.max(Math.abs(x), Math.abs(z)));
}

const TAU2 = Math.PI * 2;
/** Absolute angular difference in radians, wrapped to [0, pi]. */
function angGap(a, b) {
  const d = (((a - b + Math.PI) % TAU2) + TAU2) % TAU2 - Math.PI;
  return d < 0 ? -d : d;
}

/* ------------------------------------------------------------------ */
/* Landforms - the authored relief of the outer ring                   */
/* ------------------------------------------------------------------ */

/**
 * Broad relief for the whole ring.
 *
 * The measured problem this solves: with only the base octaves, natural relief
 * across the entire 900 m map was 8.1 m and 46-54% of the new ring had a slope
 * under 5%. Four named landforms cannot fix that - they cover maybe a tenth of
 * 650,000 m2 - so the ring needs connective tissue with real amplitude, and it
 * has to be the kind of amplitude that reads as *land* rather than as louder
 * noise.
 *
 * Ridged noise (`1 - |fbm|`, squared) rather than another plain fbm octave,
 * because plain fbm is symmetric: it gives equal numbers of bumps and dents
 * and averages to a plain. Squared ridged noise gives long connected crest
 * lines with broad hollows between them, which is what a valley system looks
 * like from inside it, and it is what lets a later phase put a road in a
 * hollow and a wood on a shoulder. Three octaves at a ~370 m base wavelength:
 * the landforms below own everything finer than that.
 *
 * Gain and bias are measured, not chosen. The squared ridged term's quantiles
 * over the map are p01 0.142, p10 0.445, p50 0.767, p90 0.955; 18.5 / -10.6
 * puts p10 at -2.4 m and p90 at +7.1 m, i.e. a ~17 m swing with the median
 * 3.6 m above the old vale's ground. Deliberately not larger: the landforms
 * below are the drama, and broad relief loud enough to compete with them just
 * turns the ring back into noise - only noise with more slope on it.
 */
const BROAD_GAIN = 18.5;
const BROAD_BIAS = -10.6;
function broadRelief(x, z) {
  const r = 1 - Math.abs(fbm2(x * 0.0027 + 21.3, z * 0.0027 - 13.7, 3));
  return r * r * BROAD_GAIN + BROAD_BIAS;
}

/**
 * Ground before anything is authored onto it: the three base octaves plus the
 * ring's broad relief.
 *
 * Split out for one reason, and it is the reason the bluff, the combe and the
 * basin work at all. A landform that levels ground to an ABSOLUTE height is
 * only a landform where the surrounding ground happens to be lower: the first
 * cut of Blackmarch Bluff levelled its top to 22.5 m and the natural ground
 * 90 m south of it was already at 19.3, so the "bluff" was a 3 m step. Each
 * of the three reads this once at MODULE LOAD, at its own centre, and works
 * relative to that - so a bluff is 17 m above its own ground by construction
 * and stays that way if the noise is ever reseeded.
 *
 * Module load, not lazily on first sample: the `CHURCH_PADS` memoisation at
 * the bottom of this file mutates module state while sampling and needs a
 * re-entrancy lock to do it. One evaluation at load needs neither, and cannot
 * be re-entered because the landforms are not applied here.
 */
function baseGround(x, z, ring = ringMask(x, z)) {
  let h = 6.0 + fbm2(x * 0.0038, z * 0.0038, 5) * 11.0;
  h += fbm2(x * 0.017, z * 0.017, 3) * 1.9;
  h += perlin2(x * 0.075, z * 0.075) * 0.18;
  if (ring > 0) h += broadRelief(x, z) * ring;
  return h;
}

/**
 * GRIMSCAR EDGE - a west-facing dip slope ending in an east-facing scarp.
 *
 * A mining town needs a face to mine into and a shelf to put the workings on,
 * and neither survives being drawn as a hill: a hill is symmetric, so the only
 * thing you can do with it is walk over it. An escarpment is the asymmetric
 * landform - a long gentle back slope on one side, a 27 m drop over 46 m on
 * the other - and the drop is the resource. The bench is cut into that face
 * about 15 m below the crest, which is where a real adit-and-spoil operation
 * sits: the workings go into the scarp behind the town, and everything tipped
 * out of them rolls down the face in front of it.
 *
 * The crest is a sine plus a noise term rather than a straight line, because
 * a ruler-straight 400 m escarpment is the loudest possible tell that a
 * landscape was generated.
 */
const GRIMSCAR = {
  crestX: -372, crestAmp: 22, crestFreq: 0.0085, crestPhase: 60, crestNoise: 9,
  z0: -336, z1: 26, zFeather: 44,
  rise: 27, face: 46, backSlope: 0.055,
  benchZ: -152, benchHz: 46, benchU0: 11, benchU1: 41, benchDrop: 15.5,
  benchFeather: 14, benchGrip: 0.92,
};
/** East-west position of the scarp crest at a given z. */
function grimscarCrest(z) {
  return GRIMSCAR.crestX
    + GRIMSCAR.crestAmp * Math.sin((z + GRIMSCAR.crestPhase) * GRIMSCAR.crestFreq)
    + perlin2(z * 0.021, 7.3) * GRIMSCAR.crestNoise;
}
function grimscarLift(x, z) {
  const g = GRIMSCAR;
  // Along-crest window: 1 over [z0, z1], 0 beyond the feather either side.
  const w = z < g.z0
    ? smoothstep(g.z0 - g.zFeather, g.z0, z)
    : z > g.z1 ? smoothstep(g.z1 + g.zFeather, g.z1, z) : 1;
  if (w <= 0) return 0;
  const u = x - grimscarCrest(z);
  // `smoothstep(face, 0, u)` is exactly 1 at u <= 0 and exactly 0 at u >= face.
  let lift = g.rise * smoothstep(g.face, 0, u);
  // The dip slope: west of the crest the plateau tilts gently away.
  if (u < 0) lift += u * g.backSlope;
  /* The bench. Pulling the LIFT toward a flat value rather than pulling `h`
   * toward an absolute height keeps the base noise's texture on the shelf -
   * a dead-flat pad would read as a car park cut into a cliff. 0.92 leaves
   * 8% of the local relief showing through. */
  const bd = rectDist(
    u - (g.benchU0 + g.benchU1) * 0.5, z - g.benchZ,
    (g.benchU1 - g.benchU0) * 0.5, g.benchHz
  );
  if (bd < g.benchFeather) {
    const k = (1 - smoothstep(0, g.benchFeather, bd)) * g.benchGrip;
    lift = lerp(lift, g.rise - g.benchDrop, k);
  }
  return lift * w;
}

/**
 * BLACKMARCH BLUFF - a flat-topped spur with one walkable approach.
 *
 * What a palisade fort wants from the ground is a perimeter it does not have
 * to defend. A symmetric knoll gives it the opposite: 360 degrees of identical
 * slope, so the palisade is decoration. This is a rect-topped bluff whose
 * fall-off distance is modulated by BEARING. The top stands 17 m above its own
 * ground - measured at module load, not authored as an absolute, see
 * `baseGround` - and that drop is spent over 12.6 m of run on three sides and
 * 53 m on the west-north-west. Measured across the finished field that is a
 * 130-175% face where it is steep (a scramble, not a walk) against a 35% ramp
 * on the neck, which is the one approach a cart could take and therefore the
 * one place a gate is worth building.
 *
 * It stands north of the river looking south across it, 240 m from Harrowgate
 * Ford, which is what makes the crossing worth holding and the fort worth
 * putting here rather than on any other high ground.
 */
const BLACKMARCH = {
  x: 348, z: -204, hx: 40, hz: 30, rise: 17,
  flank: 30, neckAng: 2.80, neckGain: 1.35, neckFloor: 0.42,
};
/** Largest fall-off any bearing can produce - the landform's true reach. */
const BLACKMARCH_REACH = BLACKMARCH.flank * (BLACKMARCH.neckFloor + BLACKMARCH.neckGain);
const BLACKMARCH_SPAN_X = BLACKMARCH.hx + BLACKMARCH_REACH;
const BLACKMARCH_SPAN_Z = BLACKMARCH.hz + BLACKMARCH_REACH;
const BLACKMARCH_TOP = baseGround(BLACKMARCH.x, BLACKMARCH.z) + BLACKMARCH.rise;
function blackmarchShape(h, x, z) {
  const b = BLACKMARCH;
  const dx = x - b.x;
  if (dx <= -BLACKMARCH_SPAN_X || dx >= BLACKMARCH_SPAN_X) return h;
  const dz = z - b.z;
  if (dz <= -BLACKMARCH_SPAN_Z || dz >= BLACKMARCH_SPAN_Z) return h;
  const d = rectDist(dx, dz, b.hx, b.hz);
  if (d >= BLACKMARCH_REACH) return h;
  let fl = b.flank;
  if (d > 0) {
    const neck = 0.5 + 0.5 * Math.cos(angGap(Math.atan2(dz, dx), b.neckAng));
    fl = b.flank * (b.neckFloor + b.neckGain * neck * neck * neck);
  }
  return lerp(h, BLACKMARCH_TOP, 1 - smoothstep(0, fl, d));
}

/**
 * ST CEOLWINE'S COMBE - a valley head: a horseshoe rim around a flat floor,
 * open on one bearing only.
 *
 * An abbey wants to be found and not seen. The rim is a raised annulus with a
 * 1.15-radian gap facing back toward the vale, so the only sightline into the
 * hollow is the one a traveller arrives along; from every other direction the
 * ground rises 18 m and the buildings are simply not there. The floor is
 * pulled flat because a cloister is a rectangle and a rectangle on a slope is
 * a retaining wall problem, not an abbey.
 */
const CEOLWINE = {
  x: -300, z: 340, sink: -1.2, floorR: 40,
  rimR: 92, rimW: 44, rimH: 18, gapAng: -0.85, gapHalf: 0.58, gapSoft: 0.55,
};
const CEOLWINE_REACH = CEOLWINE.rimR + CEOLWINE.rimW * 0.8;
const CEOLWINE_FLOOR = baseGround(CEOLWINE.x, CEOLWINE.z) + CEOLWINE.sink;
function ceolwineShape(h, x, z) {
  const c = CEOLWINE;
  const dx = x - c.x;
  if (dx <= -CEOLWINE_REACH || dx >= CEOLWINE_REACH) return h;
  const dz = z - c.z;
  if (dz <= -CEOLWINE_REACH || dz >= CEOLWINE_REACH) return h;
  /* `Math.sqrt` rather than `Math.hypot`: hypot's overflow-safe scaling costs
   * roughly an order of magnitude, and these operands are map coordinates -
   * a few hundred metres, nowhere near a float's range. Over 2.36 M macro
   * samples that difference is measurable in the build time. */
  const r = Math.sqrt(dx * dx + dz * dz);
  if (r >= CEOLWINE_REACH) return h;
  // Rim: a `bump` annulus, which is exactly zero outside its two edges - an
  // exp() falloff would have made "the AABB is the support" a lie.
  const ring = bump(r, c.rimR - c.rimW * 0.8, c.rimR + c.rimW * 0.8);
  if (ring > 0) {
    const arc = smoothstep(c.gapHalf, c.gapHalf + c.gapSoft, angGap(Math.atan2(dz, dx), c.gapAng));
    h += c.rimH * ring * arc;
  }
  const inner = 1 - smoothstep(c.floorR, c.rimR * 0.92, r);
  if (inner > 0) h = lerp(h, CEOLWINE_FLOOR, inner * 0.9);
  return h;
}

/**
 * FENWICK BASIN - a shallow bowl with three gaps in its rim.
 *
 * A crossroads town is not a town that happens to have roads; it is a place
 * the ground makes roads arrive at. A bowl does that: water runs to the middle
 * of it, so the tracks that follow the dry ground do too. The rim is
 * deliberately low - 11 m - because a market has to be a place you come down
 * INTO and can still see out of, not a crater. The three gaps sit roughly on
 * the bearings of the eastern ford, the abbey combe and the south-east corner,
 * which is where the three approaches will want to run.
 */
const FENWICK = {
  x: 196, z: 344, sink: -2.4, floorR: 52,
  rimR: 94, rimW: 30, rimH: 11, gapPhase: -0.40, gapDepth: 0.70,
};
const FENWICK_REACH = FENWICK.rimR + FENWICK.rimW * 0.8;
const FENWICK_FLOOR = baseGround(FENWICK.x, FENWICK.z) + FENWICK.sink;
function fenwickShape(h, x, z) {
  const f = FENWICK;
  const dx = x - f.x;
  if (dx <= -FENWICK_REACH || dx >= FENWICK_REACH) return h;
  const dz = z - f.z;
  if (dz <= -FENWICK_REACH || dz >= FENWICK_REACH) return h;
  const r = Math.sqrt(dx * dx + dz * dz);
  if (r >= FENWICK_REACH) return h;
  const ring = bump(r, f.rimR - f.rimW * 0.8, f.rimR + f.rimW * 0.8);
  if (ring > 0) {
    // Three lobes over the circle; the troughs between them are the notches.
    const lobe = Math.cos(3 * Math.atan2(dz, dx) - f.gapPhase);
    const k = (1 - f.gapDepth) + f.gapDepth * smoothstep(-0.25, 0.75, lobe);
    h += f.rimH * ring * k;
  }
  const inner = 1 - smoothstep(f.floorR, f.rimR * 0.9, r);
  if (inner > 0) h = lerp(h, FENWICK_FLOOR, inner * 0.85);
  return h;
}

/**
 * The landform table, for the phases that place things on this ground.
 *
 * `site` is where a settlement wants to stand; `aabb` is the SUPPORT of the
 * landform - outside it the contribution is identically zero, not merely
 * small. Both halves are pinned by test: that the shape really is zero outside
 * the box, and that the box really is disjoint from the inner square.
 */
export const LANDFORMS = [
  {
    id: 'grimscar-edge',
    name: 'Grimscar Edge',
    kind: 'escarpment',
    site: { x: -361, z: -152 },
    settlement: 'Grimscar',
    aabb: { x0: -HALF, z0: -HALF, x1: -292, z1: 74 },
  },
  {
    id: 'blackmarch-bluff',
    name: 'Blackmarch Bluff',
    kind: 'bluff',
    site: { x: 348, z: -204 },
    settlement: 'Blackmarch Hold',
    aabb: {
      x0: BLACKMARCH.x - BLACKMARCH.hx - BLACKMARCH_REACH,
      z0: BLACKMARCH.z - BLACKMARCH.hz - BLACKMARCH_REACH,
      x1: BLACKMARCH.x + BLACKMARCH.hx + BLACKMARCH_REACH,
      z1: BLACKMARCH.z + BLACKMARCH.hz + BLACKMARCH_REACH,
    },
  },
  {
    id: 'ceolwine-combe',
    name: "St Ceolwine's Combe",
    kind: 'combe',
    site: { x: -300, z: 340 },
    settlement: "St Ceolwine's Abbey",
    aabb: {
      x0: CEOLWINE.x - CEOLWINE_REACH, z0: CEOLWINE.z - CEOLWINE_REACH,
      x1: CEOLWINE.x + CEOLWINE_REACH, z1: CEOLWINE.z + CEOLWINE_REACH,
    },
  },
  {
    id: 'fenwick-basin',
    name: 'Fenwick Basin',
    kind: 'basin',
    site: { x: 196, z: 344 },
    settlement: 'Fenwick Cross',
    aabb: {
      x0: FENWICK.x - FENWICK_REACH, z0: FENWICK.z - FENWICK_REACH,
      x1: FENWICK.x + FENWICK_REACH, z1: FENWICK.z + FENWICK_REACH,
    },
  },
];

/**
 * Every authored contribution to the outer ring, in one place.
 *
 * Applied BEFORE the river, so the river cuts through the landforms rather
 * than being buried under them - which is the whole reason the fords and the
 * pool land where they do rather than floating on a shelf.
 */
const RING_SHAPES = [
  { aabb: LANDFORMS[0].aabb, apply: (h, x, z, ring) => h + grimscarLift(x, z) * ring },
  { aabb: LANDFORMS[1].aabb, apply: blackmarchShape },
  { aabb: LANDFORMS[2].aabb, apply: ceolwineShape },
  { aabb: LANDFORMS[3].aabb, apply: fenwickShape },
];
function outerRing(h, x, z, ring) {
  /* The gate is the EXPORTED aabb, not a copy of it. That is what makes
   * "no landform reaches into the inner vale" a property of this loop rather
   * than of four separate early-outs that a later edit could widen one of.
   * The shapes keep their own radial reach tests underneath - those are the
   * fast path, and they are strictly tighter than the box. */
  for (let i = 0; i < RING_SHAPES.length; i++) {
    const sh = RING_SHAPES[i];
    const a = sh.aabb;
    if (x < a.x0 || x > a.x1 || z < a.z0 || z > a.z1) continue;
    h = sh.apply(h, x, z, ring);
  }
  return h;
}

/* ------------------------------------------------------------------ */
/* The river                                                           */
/* ------------------------------------------------------------------ */

/** Where the river's outer-ring variation starts and reaches full strength. */
const RIVER_VARY_X0 = INNER_KEEP;
const RIVER_VARY_X1 = 262;
/**
 * How much of the river's outer character applies at this x: 0 for
 * `|x| <= 200`, so the reach through the old vale - the bridge, the mill
 * leat, the village's whole southern edge - is bit-identical.
 *
 * Gated on `|x|` ALONE, not on the ring mask. That is what makes the
 * bit-identity argument trivial: the river's z never leaves the 40-170 band,
 * so `|x| <= 200` already implies "inside the inner square" for every point
 * the channel touches, and a mask that also depended on z would have made the
 * channel's own width a function of which bank you were standing on.
 */
function riverVary(x) {
  return smoothstep(RIVER_VARY_X0, RIVER_VARY_X1, Math.abs(x));
}

/**
 * The reaches the outer river is authored into.
 *
 * `x` is the centre of the reach and `len` its half-length, so a reach spans
 * `2 * len` metres of river and is blended in with `bump`, i.e. it is exactly
 * zero outside that span. The fields are the same five numbers the default
 * channel is built from, so a reach is a complete replacement rather than a
 * modifier - which is what lets a ford be 6 m wide and 40 cm deep sitting 60 m
 * downstream of a 52 m pool.
 *
 *   half     channel half-width, metres
 *   bedEdge  bed height at the channel edge
 *   bedAmp   how much HIGHER the mid-channel is than the edge
 *   plain    flood-plain height the valley floor is pulled to
 *   bankIn   how far from the centreline the valley wall starts climbing
 *   bar      a mid-channel gravel bar, metres of lift, offset by `barAt`
 *
 * FORDS. Two of them, both far from the single bridge at x = 26, and both
 * placed where a route actually has to cross:
 *
 *   Ashlea Ford (x = -268) is the only dry crossing between the old vale and
 *   the whole western third of the map. Grimscar stands north of the river and
 *   St Ceolwine's combe south of it; without this they are a 550 m detour
 *   apart via the bridge.
 *
 *   Harrowgate Ford (x = 296) sits directly under Blackmarch Bluff, which is
 *   the point of putting a fort on the bluff: the fort watches the crossing.
 *   Fenwick Cross is 240 m south of it, so the ford is also the northern arm
 *   of the crossroads.
 *
 * Both are authored so the water over them is 39-55 cm deep - shin height on
 * a 1.75 m player - across the full channel, with the flood plain dropped and
 * the valley wall pushed out to 26 m so the approach is a ramp rather than a
 * bank. `medieval-landforms.test.mjs` walks a player-width corridor across
 * each one and asserts every sample is wadeable.
 */
export const RIVER_FEATURES = [
  {
    id: 'greyoak-braid', name: 'Greyoak Braid', kind: 'braid', x: -404, len: 54,
    half: 22, bedEdge: -0.55, bedAmp: -0.30, plain: 2.0, bankIn: 30,
    bar: 2.35, barAt: 5.5, barHalf: 7,
  },
  {
    id: 'reedwater-pool', name: 'Reedwater Pool', kind: 'pool', x: -344, len: 62,
    half: 26, bedEdge: -0.30, bedAmp: -1.55, plain: 1.65, bankIn: 34,
  },
  {
    id: 'ashlea-ford', name: 'Ashlea Ford', kind: 'ford', x: -268, len: 25,
    half: 6.2, bedEdge: 0.30, bedAmp: 0.16, plain: 2.05, bankIn: 26,
  },
  {
    id: 'harrowgate-ford', name: 'Harrowgate Ford', kind: 'ford', x: 296, len: 24,
    half: 6.0, bedEdge: 0.32, bedAmp: 0.14, plain: 2.05, bankIn: 26,
  },
  {
    id: 'blackmarch-gorge', name: 'Blackmarch Gorge', kind: 'gorge', x: 372, len: 56,
    half: 7.2, bedEdge: -3.4, bedAmp: 0.30, plain: 4.2, bankIn: 9,
  },
];

/**
 * The channel's shape at a given x, written into `_reach` rather than returned
 * as an object.
 *
 * `medievalHeight` runs 203,401 times for the mesh and ~2.36 M times for the
 * macro paint. An object literal per call is 2.5 M allocations per build, so
 * this writes into module scratch instead - the same discipline the world
 * file's `_v1`/`_col` scratch follows. It is pure in the only sense that
 * matters: the contents depend on `x` alone, and nothing outside this file
 * reads it except through the two accessors below.
 */
const _reach = {
  half: 9.5, bedEdge: -1.7, bedAmp: 0.7, plain: 2.3, bankIn: 16, bar: 0, barAt: 0, barHalf: 1,
};
/**
 * The unvaried channel, for samples too far from the river to be able to tell.
 *
 * Past `rd = 108` the valley blend is `smoothstep(bankIn, 108, rd) === 1` for
 * every `bankIn` the table can produce (9 to 40 m), so `lerp(plain, h, 1)`
 * lands on `h` whatever `plain` is, and no channel term applies either. Using
 * the defaults out there is therefore not an approximation - it is the same
 * number - and it keeps six `Math.sin` calls off three quarters of the map.
 */
const REACH_FAR = Object.freeze({
  half: 9.5, bedEdge: -1.7, bedAmp: 0.7, plain: 2.3, bankIn: 16, bar: 0, barAt: 0, barHalf: 1,
});
/** Widest `bankIn` the feature table can produce; asserted by test. */
export const RIVER_BANK_MAX = 108;
function riverReach(x) {
  const r = _reach;
  r.half = 9.5; r.bedEdge = -1.7; r.bedAmp = 0.7;
  r.plain = 2.3; r.bankIn = 16; r.bar = 0; r.barAt = 0; r.barHalf = 1;
  const vary = riverVary(x);
  if (vary <= 0) return r;
  /* Between the named reaches the channel still has to stop being a constant.
   * Two incommensurate wavelengths - roughly 465 m and 200 m - so the widening
   * and the deepening never line up twice in the same place. */
  const s1 = Math.sin(x * 0.0135 + 0.7);
  const s2 = Math.sin(x * 0.031 - 2.1);
  const s3 = Math.sin(x * 0.0092 - 1.4);
  r.half += vary * (2.9 * s1 + 1.5 * s2);
  r.bedEdge += vary * (0.62 * s3 - 0.40 * s2);
  r.bankIn += vary * (5.5 * s2 - 3.0 * s3);
  for (let i = 0; i < RIVER_FEATURES.length; i++) {
    const f = RIVER_FEATURES[i];
    const w = bump(x, f.x - f.len, f.x + f.len) * vary;
    if (w <= 0) continue;
    r.half = lerp(r.half, f.half, w);
    r.bedEdge = lerp(r.bedEdge, f.bedEdge, w);
    r.bedAmp = lerp(r.bedAmp, f.bedAmp, w);
    r.plain = lerp(r.plain, f.plain, w);
    r.bankIn = lerp(r.bankIn, f.bankIn, w);
    if (f.bar) { r.bar = f.bar * w; r.barAt = f.barAt; r.barHalf = f.barHalf; }
  }
  return r;
}

/**
 * Channel half-width at a given x, metres.
 *
 * Exported because the water ribbon in `MedievalWorld._buildWater` has to be
 * the same width as the channel that holds it. It was a constant 11 m, which
 * was correct for a constant 9.5 m channel and would have left the 26 m
 * Reedwater pool as a river running through a field.
 */
export function riverHalfWidth(x) {
  return riverReach(x).half;
}

/** Bed height on the centreline at a given x, metres - the deepest water. */
export function riverBedY(x) {
  const r = riverReach(x);
  return r.bedEdge + r.bedAmp;
}

/**
 * Flatten pads under the two axis-aligned parish churches so their slabs sit
 * true on the hillside. Applied LAST in `medievalHeight` so nothing re-adds
 * height. `y` is lazily sampled from the un-padded terrain at the pad centre.
 */
export const CHURCH_PADS = [
  { x: -146, z: -30, hx: 7.2, hz: 10.6, blend: 5, y: null, _lock: false },
  { x: -60, z: -136, hx: 7.0, hz: 10.2, blend: 5, y: null, _lock: false },
];

/**
 * River centreline: a lazy meander running west to east across the south.
 *
 * The first two terms are the original vale's, untouched. The third is the
 * expansion's, and it exists because the original meander swings +/-27 m about
 * z = 104 - which is a river in a 54 m corridor, and over 900 m of map that
 * corridor reads as a canal. The outer term adds a 1,460 m-wavelength swing
 * worth up to 58 m more, so across the ring the river actually goes somewhere:
 * z spans roughly 45-165 rather than 78-130, and the two banks stop being
 * parallel lines. One sine and not two: the two base terms already break its
 * symmetry, and `Math.sin` is the single most expensive thing in this function
 * per unit of character it buys.
 *
 * `riverVary` is zero for `|x| <= 200`, so the reach through the old vale -
 * where the bridge, the mill and the village's southern edge are anchored to
 * this curve - is bit-identical. `smoothstep` has zero derivative at its
 * edges, so the new term joins the old one C1-continuously rather than with a
 * kink a player could see from the bridge.
 */
export function riverZ(x) {
  const z = 104 + 20 * Math.sin(x * 0.011) + 7 * Math.sin(x * 0.027 + 1.3);
  const vary = riverVary(x);
  if (vary <= 0) return z;
  return z + vary * 58 * Math.sin(x * 0.0043 - 0.9);
}

/**
 * Authoritative ground height. The terrain mesh, collision heightfield, macro
 * texture and every prop placement read this, so they cannot disagree.
 * @returns {number} world Y in metres
 */
export function medievalHeight(x, z) {
  // Broad rolling hills, a medium band, then a low-amplitude fine layer - plus,
  // in the outer ring only, the expansion's broad relief. See `baseGround`.
  const ring = ringMask(x, z);
  let h = baseGround(x, z, ring);

  /* ---- The outer ring's authored relief.
   *
   * Before the river, so the river cuts through the landforms. Exactly zero
   * inside `|x| <= 200 && |z| <= 200` - see `INNER_KEEP`. */
  if (ring > 0) h = outerRing(h, x, z, ring);

  // ---- River valley, then the incised channel.
  const rz = riverZ(x);
  const rd = Math.abs(z - rz);
  /* Reach parameters. Inside the old vale these are the five literals this
   * always used - 2.3, 16, 9.5, -1.7, 0.7 - reproduced exactly, so the whole
   * block below is the original arithmetic on the original doubles. */
  const rr = rd < RIVER_BANK_MAX ? riverReach(x) : REACH_FAR;
  const chanHalf = rr.half;
  h = lerp(rr.plain, h, smoothstep(rr.bankIn, RIVER_BANK_MAX, rd));
  if (rd < chanHalf + 8) {
    const t = smootherstep(clamp01((chanHalf + 8 - rd) / 8));
    let bed = rr.bedEdge + rr.bedAmp * Math.cos((Math.min(rd, chanHalf) / chanHalf) * Math.PI * 0.5);
    /* Mid-channel gravel bar. This is the braid: a bank of shingle proud of
     * the water splits one channel into two, which is the only honest way to
     * braid a river that is described by a single centreline. */
    if (rr.bar > 0) bed += rr.bar * bump(z - rz, rr.barAt - rr.barHalf, rr.barAt + rr.barHalf);
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
