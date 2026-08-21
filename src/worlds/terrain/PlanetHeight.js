/**
 * THE PARAMETERISED PLANET GROUND.
 *
 * One height function for every planet surface in the game. It takes no
 * closures and no `three`: it is handed a plain, structured-cloneable
 * `terrain` block out of a planet descriptor and returns the sampler for that
 * planet. `HEIGHT_FIELDS.planet` is this factory, so the generation worker
 * resolves the very same function the world, the collision and every prop
 * placement read - which is the rule this project learned by shipping a world
 * whose collision sat below its mesh across 7% of the map.
 *
 * -- Why a vocabulary and not noise ---------------------------------------
 *
 * Citadel's Drop Three expanded a playfield without authoring relief and got a
 * flat nothing; the fix was a named landform vocabulary with a measured slope
 * and relief distribution. Multiplying the amplitude of fbm does not produce
 * that. Noise has no *places* in it - every 50 m window looks like every other
 * one, so a bigger map is only a longer walk. The relief here is therefore
 * AUTHORED: a caldera is a caldera because a record says
 * `{ kind: 'volcano', rimR: 96, craterY: 46 }`, and the noise is the last few
 * per cent of the amplitude, on top, to stop the authored shapes reading as CAD.
 *
 * Every landform kind below is a pure function of (x, z) with a smooth,
 * compactly-supported mask, so the vocabulary composes: two overlapping
 * landforms blend, and one that is far away costs a distance test.
 *
 * -- Evaluation order, and why it is fixed ---------------------------------
 *
 *   1. base plain    swells + ripples + grain + the rim falloff
 *   2. ADD  layer    volcano, cone, plateau, ridge          (relief up)
 *   3. CUT  layer    basin, trench, channel                 (relief down)
 *   4. LEVEL layer   pad, ramp                              (flatten to a target)
 *
 * The level layer is last because it is the only one that makes a PROMISE. A
 * pad says "a ship can set down inside this disc" and a ramp says "a body can
 * walk from here to there"; if a cinder cone were free to be added on top of a
 * pad afterwards, the promise would be false and nothing would throw. Being
 * last makes both true by construction - and the tests then measure that the
 * construction actually held rather than assuming it.
 *
 * Nothing in here may import `three` or touch the DOM.
 */

/* ================================================================== */
/* Noise                                                               */
/* ================================================================== */

/**
 * Integer hash -> [0,1). Deterministic across runs and platforms: it is all
 * `Math.imul` and int32 arithmetic, with no float accumulation that could
 * differ between the worker and the main thread.
 */
export function hash2(ix, iz, seed) {
  let h = Math.imul(ix | 0, 374761393) + Math.imul(iz | 0, 668265263) + Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise, smoothstep-interpolated. Returns [0,1]. */
export function vnoise(x, z, seed) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

/**
 * Fractal value noise, gain 0.5 / lacunarity 2.0117. Returns roughly [0,1].
 *
 * Not exactly 2: an exact doubling lines every octave's lattice up on the same
 * integer grid and prints a visible cross-hatch at the cell scale, which on an
 * ash plain lit by a low sun is the most obvious artefact there is.
 */
export function fbm(x, z, seed, octaves) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let fx = x;
  let fz = z;
  for (let o = 0; o < octaves; o++) {
    sum += vnoise(fx, fz, seed + o * 1013) * amp;
    norm += amp;
    amp *= 0.5;
    fx *= 2.0117;
    fz *= 2.0117;
  }
  return sum / norm;
}

/** Ridged fractal noise. Sharp crests, rounded troughs - ash dune flanks. */
export function ridged(x, z, seed, octaves) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let fx = x;
  let fz = z;
  for (let o = 0; o < octaves; o++) {
    const n = vnoise(fx, fz, seed + o * 7919);
    sum += (1 - Math.abs(n * 2 - 1)) * amp;
    norm += amp;
    amp *= 0.5;
    fx *= 2.0117;
    fz *= 2.0117;
  }
  return sum / norm;
}

/* ================================================================== */
/* Shaping helpers                                                     */
/* ================================================================== */

export const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
/** Hermite ease. The only falloff used below, so every landform's edge has a
 *  continuous first derivative and no landform prints a crease. */
const smooth = (t) => { const u = clamp01(t); return u * u * (3 - 2 * u); };
/** 0 at `a`, 1 at `b`, eased. */
export const smoothstep = (a, b, x) => (a === b ? (x < a ? 0 : 1) : smooth((x - a) / (b - a)));

/**
 * Squared distance from (px,pz) to a segment, plus the parameter along it.
 * Results land in module-level scalars rather than an object: this runs tens
 * of millions of times per build and nothing in a sampler may allocate.
 */
let _segT = 0;
function segDist2(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const qx = ax + dx * t - px;
  const qz = az + dz * t - pz;
  _segT = t;
  return qx * qx + qz * qz;
}

/** Nearest point on a polyline: distance in `_polyD`, arclength fraction in `_polyS`. */
let _polyD = 0;
let _polyS = 0;
function polyNearest(px, pz, pts, cum, total) {
  let bestD2 = Infinity;
  let bestS = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const d2 = segDist2(px, pz, a[0], a[1], b[0], b[1]);
    if (d2 < bestD2) {
      bestD2 = d2;
      bestS = cum[i] + _segT * (cum[i + 1] - cum[i]);
    }
  }
  _polyD = Math.sqrt(bestD2);
  _polyS = total > 0 ? bestS / total : 0;
  return _polyD;
}

/** Arclength prefix sums for a polyline, computed once per build. */
export function arclength(pts) {
  const cum = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  return { cum, total: cum[cum.length - 1] };
}

/* ================================================================== */
/* The landform vocabulary                                             */
/* ================================================================== */

/**
 * Every kind, its parameters, and what it is FOR. A planet descriptor's
 * `terrain.landforms` is an array of these records; an unknown `kind` throws at
 * factory time rather than silently producing a flat map - which is exactly how
 * a "big empty" ships.
 *
 * Distances are metres; heights are metres of world Y.
 *
 * -- ADD layer -------------------------------------------------------------
 *
 * `volcano`  { x, z, r, peak, rimR, rimH, craterY, craterR, rimJag?, breach? }
 *   The hero. A shield rising to `peak` over radius `r`, its top replaced by a
 *   crater: a rim crest `rimH` above the flank at radius `rimR`, falling inward
 *   to a flat floor at `craterY` inside `craterR`. `breach`
 *   (`{ bearing, width, depth }`, radians / radians / 0..1) notches the rim on
 *   one bearing so a flow can leave and a body can walk in - a caldera with an
 *   unbroken rim is a room with no door.
 *
 * `cone`     { x, z, r, peak, pit?, pitR? }
 *   A parasitic cinder cone. `pit` (0..1) sinks the summit by that fraction of
 *   `peak`, which is what makes a cone read as volcanic rather than as a hill.
 *
 * `plateau`  { x, z, r, y, edge? }
 *   Flat-topped mesa at ABSOLUTE height `y`, its rim falling over `edge` metres.
 *   Absolute, not additive: a plateau is a *level*, and adding one to a swell
 *   gives a tilted table.
 *
 * `ridge`    { pts, width, height, taper? }
 *   A spatter rampart / flow levee along a polyline. Crest at `height` above the
 *   ground it stands on, falling to nothing at `width`.
 *
 * -- CUT layer -------------------------------------------------------------
 *
 * `basin`    { x, z, r, depth, flat? }
 *   A depression `depth` metres deep, its inner `flat` fraction level. Where a
 *   lava lake goes.
 *
 * `trench`   { pts, width, depth, lip?, lipWidth? }
 *   A fissure. Steep-sided, `depth` deep, with an optional raised `lip` of
 *   spoil along each edge.
 *
 * `channel`  { pts, width, depth, levee?, leveeWidth?, taper? }
 *   A lava flow: a shallow, wide cut with a raised levee each side. `taper`
 *   widens and shallows it from head to toe, because a flow spreads as it runs.
 *
 * -- LEVEL layer -----------------------------------------------------------
 *
 * `pad`      { x, z, r, blend?, y? }
 *   Level ground inside radius `r`, blending out over `blend`. `y` defaults to
 *   the field at (x,z) before any level form ran, so a pad sits *in* the terrain
 *   rather than on a stilt. This is the landing-site guarantee.
 *
 * `ramp`     { pts, width, blend?, y0?, y1? }
 *   Levels a corridor to a linear ramp from `y0` at the head to `y1` at the toe.
 *   Both default to the pre-level field at the respective endpoint, so a ramp
 *   meets the ground it starts and ends on. This is the reachability guarantee.
 */
const ADD_KINDS = new Set(['volcano', 'cone', 'plateau', 'ridge']);
const CUT_KINDS = new Set(['basin', 'trench', 'channel']);
const LEVEL_KINDS = new Set(['pad', 'ramp']);

/** Every landform kind this module understands. */
export const LANDFORM_KINDS = Object.freeze([...ADD_KINDS, ...CUT_KINDS, ...LEVEL_KINDS]);
const KNOWN = new Set(LANDFORM_KINDS);

/* ================================================================== */
/* The factory                                                         */
/* ================================================================== */

/**
 * Build the height sampler for one planet.
 *
 * @param {{
 *   seed?: number,
 *   half: number,
 *   baseY?: number,
 *   swell?: { amp: number, scale: number, octaves?: number },
 *   ripple?: { amp: number, scale: number, octaves?: number },
 *   grain?: { amp: number, scale: number },
 *   rim?: { start: number, drop: number },
 *   landforms?: object[],
 * }} params  plain data - it crosses `postMessage`
 * @returns {(x:number, z:number)=>number}
 */
export function planetHeight(params) {
  const p = params || {};
  const seed = (p.seed ?? 1) | 0;
  const half = p.half ?? 400;
  const baseY = p.baseY ?? 0;

  const swellAmp = p.swell?.amp ?? 0;
  const swellInv = 1 / (p.swell?.scale ?? 180);
  const swellOct = p.swell?.octaves ?? 4;

  const rippleAmp = p.ripple?.amp ?? 0;
  const rippleInv = 1 / (p.ripple?.scale ?? 34);
  const rippleOct = p.ripple?.octaves ?? 3;

  const grainAmp = p.grain?.amp ?? 0;
  const grainInv = 1 / (p.grain?.scale ?? 6);

  /* The playfield rim. The ground falls away past `start` so the map has an
   * edge that reads as a horizon rather than as a cut. Not a wall: containment
   * is another system's job, and terrain that RISES at the border makes every
   * world look like a bowl seen from inside. */
  const rimStart = p.rim?.start ?? half * 0.86;
  const rimDrop = p.rim?.drop ?? 0;

  const forms = Array.isArray(p.landforms) ? p.landforms : [];
  for (const f of forms) {
    if (!KNOWN.has(f.kind)) {
      throw new Error(`[PlanetHeight] unknown landform kind "${f.kind}" - known: ${LANDFORM_KINDS.join(', ')}`);
    }
  }

  /* Polyline setup, done ONCE per build rather than once per sample. Being able
   * to do this is the reason `HEIGHT_FIELDS` entries are factories at all. */
  const adds = [];
  const cuts = [];
  const levels = [];
  for (const f of forms) {
    const rec = { f, k: f.pts ? arclength(f.pts) : null };
    if (ADD_KINDS.has(f.kind)) adds.push(rec);
    else if (CUT_KINDS.has(f.kind)) cuts.push(rec);
    else levels.push(rec);
  }

  /* ---------------------------------------------------------------- */
  /* Kind evaluators                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * Shield + rim + crater, blended into the ground it stands on.
   *
   * The profile, outward from the axis:
   *   0       .. craterR   flat crater floor at `craterY`
   *   craterR .. rimR      inner wall, climbing to the crest
   *   rimR    .. r         outer flank, `peak`-scaled, falling to the plain
   *
   * The crest sits `rimH` ABOVE the flank height at `rimR`, which is what stops
   * the rim reading as a smooth cone with a hole punched in the top.
   */
  function volcanoAt(y, x, z, f) {
    const dx = x - f.x;
    const dz = z - f.z;
    const d = Math.hypot(dx, dz);
    if (d > f.r) return y;

    /* Rim relief in plan. Without it a caldera is a perfect circle, which is the
     * one thing no real one is. Angular noise on the rim radius, plus the notch. */
    const ang = Math.atan2(dz, dx);
    const lobe = vnoise(Math.cos(ang) * 2.4 + 11, Math.sin(ang) * 2.4 + 7, (f.seed ?? seed) | 0) * 2 - 1;
    const rimR = f.rimR * (1 + lobe * (f.rimJag ?? 0.07));
    const craterR = Math.min(f.craterR ?? f.rimR * 0.55, rimR * 0.92);

    // Outer flank: a shield profile, convex near the rim, flattening far out.
    const tOut = clamp01((d - rimR) / Math.max(1e-6, f.r - rimR));
    const flank = f.peak * Math.pow(1 - tOut, 1.9);

    // The breach: a notch in the crest on one bearing, so a flow can leave.
    let breach = 0;
    if (f.breach) {
      const da = Math.abs(((ang - f.breach.bearing + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      breach = 1 - smoothstep(f.breach.width * 0.35, f.breach.width, da);
    }
    const crest = f.rimH * (1 - breach * (f.breach?.depth ?? 0.92));

    let vy;
    if (d >= rimR) {
      // Outer flank, the crest bump dying out over the first 18% of it.
      vy = flank + crest * (1 - smoothstep(0, (f.r - rimR) * 0.18, d - rimR));
    } else if (d >= craterR) {
      /* Inner wall. `pow 0.62` puts most of the fall near the floor, which is
       * what a collapse scarp does - the wall is a cliff at the bottom and a
       * shoulder at the top, not a uniform ramp. */
      const t = (d - craterR) / Math.max(1e-6, rimR - craterR);
      vy = f.craterY + (f.peak + crest - f.craterY) * Math.pow(t, 0.62);
    } else {
      vy = f.craterY;
    }

    // Blend the cone into the ground it stands on, over its outer 12%.
    const w = 1 - smoothstep(f.r * 0.88, f.r, d);
    return y + (vy - y) * w;
  }

  function coneAt(x, z, f) {
    const d = Math.hypot(x - f.x, z - f.z);
    if (d > f.r) return 0;
    const h = f.peak * Math.pow(1 - d / f.r, 1.7);
    const pit = f.pit ?? 0;
    if (pit <= 0) return h;
    /* A summit pit is a LERP toward a flat floor, not a subtraction.
     *
     * Subtracting a constant inside the pit radius was the first version and it
     * left a nub: the cone profile is still falling across the pit mouth, so
     * taking the same amount off every sample leaves the axis standing 3.7 m
     * proud of the floor 4 m away from it. A cinder cone with a pimple in the
     * middle of its crater. Lerping to an absolute floor gives the flat,
     * ash-filled bottom these actually have, and makes `pit` mean what the
     * docstring says: the summit sits `pit` of `peak` below the pit rim. */
    const pr = f.pitR ?? f.r * 0.24;
    const floorH = f.peak * Math.pow(1 - pr / f.r, 1.7) - f.peak * pit;
    return h + (floorH - h) * (1 - smoothstep(pr * 0.45, pr, d));
  }

  function plateauAt(y, x, z, f) {
    const edge = f.edge ?? 22;
    const d = Math.hypot(x - f.x, z - f.z);
    if (d > f.r + edge) return y;
    return y + (f.y - y) * (1 - smoothstep(f.r, f.r + edge, d));
  }

  function ridgeAt(x, z, f, k) {
    const d = polyNearest(x, z, f.pts, k.cum, k.total);
    if (d > f.width) return 0;
    const taper = f.taper ? 1 - f.taper * _polyS : 1;
    const w = 1 - smoothstep(0, f.width, d);
    // Squared, so a crest is a crest and not a plateau with sloped sides.
    return f.height * taper * w * w;
  }

  function basinAt(x, z, f) {
    const d = Math.hypot(x - f.x, z - f.z);
    if (d > f.r) return 0;
    return f.depth * (1 - smoothstep((f.flat ?? 0.45) * f.r, f.r, d));
  }

  function trenchAt(x, z, f, k) {
    const lip = f.lip ?? 0;
    const outer = f.width + (f.lipWidth ?? f.width * 0.9);
    const d = polyNearest(x, z, f.pts, k.cum, k.total);
    if (d > outer) return 0;
    let dy = 0;
    // The lip first: spoil thrown out of the fissure, highest at its edge.
    if (lip) dy += lip * (1 - smoothstep(f.width, outer, d)) * smoothstep(f.width * 0.55, f.width, d);
    // Then the cut. Cubed, so the walls stay near-vertical and the floor flat.
    const t = clamp01(d / f.width);
    return dy - f.depth * (1 - t * t * t);
  }

  function channelAt(x, z, f, k) {
    const d = polyNearest(x, z, f.pts, k.cum, k.total);
    const spread = 1 + (f.taper ?? 0) * _polyS;
    const width = f.width * spread;
    const levee = f.levee ?? 0;
    const outer = width + (f.leveeWidth ?? width * 0.55);
    if (d > outer) return 0;
    let dy = 0;
    if (levee) {
      // Levees stand just outside the channel and die away outward.
      const t = clamp01((d - width * 0.72) / Math.max(1e-6, outer - width * 0.72));
      dy += (levee / spread) * Math.sin(Math.PI * t);
    }
    return dy - (f.depth / spread) * (1 - smoothstep(width * 0.62, width, d));
  }

  /* ---------------------------------------------------------------- */
  /* The layers                                                        */
  /* ---------------------------------------------------------------- */

  /** The base plain: swells, ripples, grain and the rim falloff. */
  function base(x, z) {
    let y = baseY;
    if (swellAmp) y += (fbm(x * swellInv, z * swellInv, seed, swellOct) - 0.5) * 2 * swellAmp;
    if (rippleAmp) y += (ridged(x * rippleInv, z * rippleInv, seed + 331, rippleOct) - 0.5) * 2 * rippleAmp;
    /* Two octaves, not one.
     *
     * A single value-noise octave sits on a square lattice, and at the 3.125 m
     * terrain cell the plain came back covered in a regular diamond dimple that
     * was clearly visible on the volcano's flank in a review screenshot. Two
     * octaves at 2.0117x break the lattice up for one extra hash. */
    if (grainAmp) y += (fbm(x * grainInv, z * grainInv, seed + 977, 2) - 0.5) * 2 * grainAmp;
    if (rimDrop) y -= rimDrop * smoothstep(rimStart, half, Math.max(Math.abs(x), Math.abs(z)));
    return y;
  }

  /** Everything except the level layer. Pads and ramps read this to find their Y. */
  function preLevel(x, z) {
    let y = base(x, z);
    for (let i = 0; i < adds.length; i++) {
      const f = adds[i].f;
      if (f.kind === 'volcano') y = volcanoAt(y, x, z, f);
      else if (f.kind === 'cone') y += coneAt(x, z, f);
      else if (f.kind === 'plateau') y = plateauAt(y, x, z, f);
      else y += ridgeAt(x, z, f, adds[i].k);
    }
    for (let i = 0; i < cuts.length; i++) {
      const f = cuts[i].f;
      if (f.kind === 'basin') y -= basinAt(x, z, f);
      else if (f.kind === 'trench') y += trenchAt(x, z, f, cuts[i].k);
      else y += channelAt(x, z, f, cuts[i].k);
    }
    return y;
  }

  /* Level-layer targets are resolved against `preLevel` NOW, once. Resolving
   * them lazily would make a pad's height depend on which sample asked first,
   * which is the point at which a heightfield stops being a function. */
  const levelled = levels.map(({ f, k }) => {
    if (f.kind === 'pad') return { f, y: f.y ?? preLevel(f.x, f.z) };
    const a = f.pts[0];
    const b = f.pts[f.pts.length - 1];
    return { f, k, y0: f.y0 ?? preLevel(a[0], a[1]), y1: f.y1 ?? preLevel(b[0], b[1]) };
  });

  return function height(x, z) {
    let y = preLevel(x, z);
    for (let i = 0; i < levelled.length; i++) {
      const s = levelled[i];
      const f = s.f;
      if (f.kind === 'pad') {
        const d = Math.hypot(x - f.x, z - f.z);
        const w = 1 - smoothstep(f.r, f.r + (f.blend ?? 12), d);
        if (w > 0) y += (s.y - y) * w;
      } else {
        const d = polyNearest(x, z, f.pts, s.k.cum, s.k.total);
        const w = 1 - smoothstep(f.width, f.width + (f.blend ?? 10), d);
        if (w > 0) y += (s.y0 + (s.y1 - s.y0) * _polyS - y) * w;
      }
    }
    return y;
  };
}
