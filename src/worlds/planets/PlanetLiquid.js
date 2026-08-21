import * as THREE from 'three';

/**
 * THE LIQUID SURFACE: lava here, and whatever the next planet pours.
 *
 * Two shapes, because two shapes is what a descriptor can express: a `disc`
 * (lake, pond, crater fill) and a `ribbon` (a flow following a polyline, its
 * surface interpolating linearly in arclength from `y0` to `y1` - exactly the
 * way a `ramp` landform interpolates the ground under it, so the two cannot
 * separate).
 *
 * -- Why one material and not a shader per planet -------------------------
 * The look is `onBeforeCompile` over a `MeshStandardMaterial` rather than a
 * bare `ShaderMaterial`. That is not a shortcut - it is the only way this
 * surface gets the world's fog, its tone mapping and its shadow reception for
 * free. A raw `ShaderMaterial` lava lake looks correct at 20 m and then hangs
 * in the air unfogged at 400 m, which on a planet whose fog is the atmosphere
 * is the whole illusion gone.
 *
 * -- The skirt ------------------------------------------------------------
 * Every body hangs a vertical apron below its edge, for the same reason
 * `TerrainTiles` hangs one off every terrain tile: a drawn edge that misses the
 * ground by anything at all is a strip of sky, and here it would be a strip of
 * sky under a lava lake.
 *
 * The disagreement is measured, over 128 bearings per disc and both edges of
 * every ribbon sample (`planet-relief.test.mjs`). On Cinder the worst is 5.30 m
 * and it is not noise - it is structural, and it is worth writing down because
 * the next planet will hit it too. Where a flow at a 0.19 grade runs into a
 * flat lake bed, the bed's `pad` levels the ground several metres before the
 * flow's own linear descent gets there, so the last stretch of ribbon crosses a
 * delta. Shortening the ribbon leaves a gap between it and the lake; steepening
 * the beach puts a 41-degree wall round the shore. An apron is the cheap answer
 * and it is what an apron is for.
 *
 * 8 m: 1.5x the measured worst case, and invisible - it hangs inside the bank
 * everywhere else on the planet.
 *
 * -- Lava, water, and the four channels that are named for one of them -----
 * `hot`, `crust`, `color` and `emissive` were designed around incandescence:
 * `hot` is the colour of the light coming OUT of the cracks, `crust` is the
 * chilled skin between them and `color` is the melt underneath. Shoal, the
 * first non-lava caller, documented using them as stand-ins - swapping `crust`
 * and `color` so the light one is on top - and it works, but it means the same
 * field means opposite things on two planets.
 *
 * `liquidKind` names the split instead. It is INFERRED where a descriptor does
 * not say, from the one channel whose meaning is unambiguous: a liquid with
 * `emissive >= 1` is throwing light and is lava; anything dimmer is not. That
 * keeps every existing descriptor working unchanged - and Cinder, whose look was
 * tuned by measurement, gets the identical shader it had, because the depth term
 * below defaults to OFF for lava and ON for water. A lava descriptor that wants
 * a depth cue asks for one; nothing decides on its behalf.
 */

/** How far each body's apron hangs below its surface. See the header. */
export const SKIRT = 8.0;

/**
 * How far ABOVE a liquid surface still counts as "in it" for reachability.
 *
 * THIS NUMBER IS A CONTRACT WITH THE REACH PROBES, not a taste decision.
 * `planet-reach.test.mjs`'s `lavaMask` and `planet-minerals.test.mjs` both mark
 * a lattice cell blocked at `y < surface + 0.6`, i.e. ground within 60 cm above
 * the waterline is already "you cannot stand here". The renderer now builds its
 * shore barrier on exactly the same test, so the world a probe measures and the
 * world a player walks are the same world. Change it here and those two files
 * have to change with it - `planet-liquid.test.mjs` re-derives the probe's mask
 * independently and fails if they drift.
 */
export const LIQUID_EDGE = 0.6;

/**
 * 'lava' | 'water' - what this liquid is, and therefore what its channels mean.
 * @param {object} liquid the descriptor's `liquid` block
 */
export function liquidKind(liquid) {
  if (liquid?.kind === 'lava' || liquid?.kind === 'water') return liquid.kind;
  return (liquid?.emissive ?? 0) >= 1 ? 'lava' : 'water';
}

/**
 * WHAT THE LIQUID IS, which is not the same question as what its shader is.
 *
 * `liquidKind` above answers "which way round do the four colour channels
 * mean things", and it has exactly two answers because the material has
 * exactly two behaviours. That is a RENDERING fact and it must not move:
 * Cinder's look was calibrated against it.
 *
 * What a body does to a player is a different fact with more answers. Sallow
 * pours acid, which renders through the water branch (`emissive` 0.16, no
 * incandescence) and must burn anything that steps in it. Reading swimmability
 * off `liquidKind` would therefore have made acid swimmable, and inventing a
 * third rendering kind would have re-tuned Cinder to say something about
 * Sallow. So the substance is its own axis, defaulting to the rendering kind
 * for every descriptor that does not name one.
 *
 * @param {object|null} liquid
 * @returns {'water'|'lava'|'acid'}
 */
export function liquidSubstance(liquid) {
  const k = liquid?.kind;
  if (k === 'water' || k === 'lava' || k === 'acid') return k;
  return liquidKind(liquid);
}

/**
 * Damage per second a lethal liquid does when nothing names a rate.
 *
 * Two numbers, and the gap between them is the whole point - the brief was
 * "Cinder's lava should KILL; Sallow's acid should HURT", and those are
 * different mechanics rather than different numbers on the same one.
 *
 *   lava  240 dps against 100 hp is dead in 0.42 s. There is no version of
 *         standing in a lava lake that is survivable, and a rate that leaves
 *         a player time to scramble out teaches that there is.
 *   acid   14 dps is 7.1 s from full health to dead, and Sallow's deepest pool
 *         is 3.0 m across 132 m. You can cross the shallows, you cannot
 *         loiter, and the HUD's damage flash is the whole instruction.
 */
const DEFAULT_DPS = Object.freeze({ lava: 240, acid: 14, water: 0 });

/**
 * THE HAZARD, WIRED AT LAST.
 *
 * `liquid.lethal` has been in the schema since the first planet, the
 * descriptor docs say it is there "so the day it turns true nothing has to be
 * re-plumbed", and until now NOTHING IN THE BUILD READ IT - not `PlanetWorld`,
 * not `Placement`, not a system. It was reported in the census precisely so
 * that its dormancy was visible. This is the function that ends that.
 *
 * `dps` is 0 whenever `lethal` is false, so a caller can multiply by it
 * unconditionally and a non-lethal liquid costs nothing. Every field is
 * finite by construction: a descriptor that writes `hazard: { dps: NaN }`
 * gets the default rather than a NaN reaching `applyDamage`.
 *
 * @param {object|null} liquid
 * @returns {{ kind: 'water'|'lava'|'acid', lethal: boolean, dps: number, cause: string }}
 */
export function liquidHazard(liquid) {
  const kind = liquidSubstance(liquid);
  const lethal = !!liquid?.lethal;
  const named = liquid?.hazard?.dps;
  const dps = lethal
    ? Math.max(0, Number.isFinite(named) ? named : (DEFAULT_DPS[kind] ?? 20))
    : 0;
  return { kind, lethal, dps, cause: liquid?.hazard?.cause ?? kind };
}

/**
 * CAN A PLAYER BE IN THIS?
 *
 * Per LIQUID, never per world - that distinction is the whole of this change.
 * `PlanetWorld` used to set `swim: false` for all ten planets at once, which
 * is a statement about Cinder's lava that Shoal's ocean was made to sign.
 *
 * Water you can enter and swim. Lava and acid you cannot: they are lethal, and
 * a lethal liquid you can swim in is a bath with a timer, which reads as a
 * mechanic rather than as "do not go in there".
 *
 * @param {object|null} liquid
 * @returns {boolean}
 */
export function liquidSwimmable(liquid) {
  if (!liquid?.bodies?.length) return false;
  return liquidSubstance(liquid) === 'water' && !liquid.lethal;
}

/**
 * SHORES THAT STAY WALLED EVEN THOUGH THE LIQUID IS SWIMMABLE.
 *
 * ── Why this exists, measured ────────────────────────────────────────────
 * Shoal's SUNDERING HEAD is a second landing: 91 m of sea between it and the
 * nearest walkable ground, the abyssite seam in the Tide Chasm on it, and its
 * own pad and stair as the only way in. Its header calls it "52 m out of deep
 * water with 61-degree cliffs on every bearing".
 *
 * That is not what the height field builds. The Head is a `plateau` at y 52
 * with `edge: 54`, i.e. 52 m of fall over 54 m of run - a **44-degree ramp**.
 * At the LEGACY probe envelope (38 deg) 44 is a wall, which is why ten authors
 * measured it and every one of them read a cliff. At the REAL envelope -
 * `acos(Grounding.WALKABLE_NORMAL_Y)`, 56.63 deg, which is what the game
 * stands on - it is a walk.
 *
 * Today nothing notices, because the sea is a fence and no body can ever
 * stand at the foot of that ramp. Make the sea swimmable and it can. MEASURED,
 * flooding the real world at 56.63 deg with swim crossings: abyssite from the
 * primary pad goes **0 of 7 to 7 of 7**, and the traced route is swim, wade
 * ashore on the Head's west flank at (250, -162), then walk the ramp and the
 * chasm floor to every node. The guarantee ten planets are designed around
 * dies on the spot.
 *
 * The honest fix is terrain - the Head should have the cliffs its header
 * claims - and that is not this change's to make. So the descriptor may name
 * the stretches of ITS OWN shore that stay walled, and say why. Shoal names
 * one; nothing else in the system does. With it: abyssite 0 of 7 from the two
 * mainland pads and 7 of 7 from `sunder`, which is the design, and the other
 * ~2,440 posts that used to fence the open sea are gone.
 *
 * @param {object|null} liquid
 * @returns {Array<{x:number,z:number,r:number,why:string}>}
 */
export function liquidGuards(liquid) {
  const raw = liquid?.guard;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const g of raw) {
    /* Non-finite here would be a guard that silently matches nothing (or
     * everything), i.e. a gate that is not there and a build that says it is. */
    if (!Number.isFinite(g?.x) || !Number.isFinite(g?.z) || !(g?.r > 0)) {
      throw new Error(`[PlanetLiquid] liquid.guard needs finite x, z and a positive r - got ${JSON.stringify(g)}`);
    }
    out.push({ x: g.x, z: g.z, r: g.r, why: g.why ?? '' });
  }
  return out;
}

/**
 * DOES THE SHORE AT (x, z) GET A WALL?
 *
 * TRUE for every metre of a lethal liquid's edge - that is what the barrier is
 * FOR now - and for the guarded stretches of a swimmable one. FALSE everywhere
 * else, which after this change is most of the liquid in the game: 5,362 of
 * the system's 6,829 posts stood on shores that are now open water you can
 * swim in, and 683 of the remaining ones are Shoal's single guard.
 *
 * Returned as a CLOSURE because the caller asks it once per candidate post -
 * 3,122 times on Shoal alone - and the guard list would otherwise be rebuilt
 * (and re-validated) on every one of them. The one-shot `liquidWalled` below
 * delegates to it, so a probe and the builder cannot answer differently.
 *
 * @param {object|null} liquid
 * @returns {(x:number, z:number) => boolean}
 */
export function liquidWallMask(liquid) {
  if (!liquid?.bodies?.length) return () => false;
  if (!liquidSwimmable(liquid)) return () => true;
  const guards = liquidGuards(liquid);
  if (!guards.length) return () => false;
  return (x, z) => {
    for (let i = 0; i < guards.length; i++) {
      const g = guards[i];
      if (Math.hypot(x - g.x, z - g.z) <= g.r) return true;
    }
    return false;
  };
}

/**
 * The same question asked once. @see liquidWallMask
 * @param {object|null} liquid
 * @param {number} x
 * @param {number} z
 */
export function liquidWalled(liquid, x, z) {
  return liquidWallMask(liquid)(x, z);
}

/**
 * The depth term's settings, with per-kind defaults.
 *
 * `amount` 0 removes the term from the shader entirely (see
 * `createLiquidMaterial`), which is what keeps Cinder's compiled program
 * byte-identical to the one its look was calibrated against.
 *
 * Every number that reaches a division or a `smoothstep` edge is floored here
 * rather than in GLSL: a descriptor with `depth: { scale: 0 }` would otherwise
 * put a division by zero into a fragment shader, and this repo has already lost
 * a day to 19 non-finite pixels blacking out a frame through the bloom pass.
 */
export function liquidDepth(liquid) {
  const kind = liquidKind(liquid);
  const d = liquid?.depth ?? {};
  const water = kind === 'water';
  const clamp01 = (v) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  return {
    kind,
    /** How much of the crust->deep axis depth owns, against the flow noise. */
    amount: clamp01(d.amount ?? (water ? 0.78 : 0)),
    /** e-folding depth in metres: 2 m reads shallow, 20 m reads open sea. */
    scale: Math.max(0.25, Number.isFinite(d.scale) ? d.scale : 6.0),
    /** Strength of the pale band right at the waterline. */
    surf: clamp01(d.surf ?? (water ? 0.34 : 0)),
    /** How many metres of depth that band survives. */
    surfBand: Math.max(0.05, Number.isFinite(d.surfBand) ? d.surfBand : 1.1),
    /** Depth assumed off the edge of the height field - see the shader. */
    far: Math.max(0, Number.isFinite(d.far) ? d.far : 60),
  };
}

/**
 * The surface height of ONE body at (x,z), or `null` if (x,z) is not over it.
 *
 * A disc is tested against `discRadiusAt`, i.e. the WOBBLY outline the mesh
 * actually draws rather than the nominal radius - the same reason that function
 * is exported for the shoreline test. A ribbon is tested against its polyline
 * and its surface interpolates in arclength, exactly as `ribbonGeometry` builds
 * it, so the collision and the drawn surface cannot disagree.
 */
export function bodySurfaceAt(b, x, z) {
  if (b.shape === 'disc') {
    const dx = x - b.x;
    const dz = z - b.z;
    const d = Math.hypot(dx, dz);
    if (d > b.r * (1 + Math.abs(b.wobble ?? 0.09))) return null;
    const r = discRadiusAt(b, Math.atan2(dz, dx));
    return d <= r ? b.y : null;
  }
  const pts = b.pts;
  const half = b.width * 0.5;
  /* Nearest point on the polyline, plus the arclength to it: the same walk
   * `polyDist` does, kept here because the surface height needs the parameter
   * as well as the distance and re-walking twice is the thing that goes stale. */
  let bestD = Infinity;
  let bestS = 0;
  let run = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const ax = pts[i][0]; const az = pts[i][1];
    const bx = pts[i + 1][0]; const bz = pts[i + 1][1];
    const ex = bx - ax; const ez = bz - az;
    const len2 = ex * ex + ez * ez;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / len2)) : 0;
    const px = ax + ex * t; const pz = az + ez * t;
    const d = Math.hypot(x - px, z - pz);
    const segLen = Math.sqrt(len2);
    if (d < bestD) { bestD = d; bestS = run + segLen * t; }
    run += segLen;
  }
  if (bestD > half || run <= 0) return bestD <= half ? b.y0 : null;
  const s = bestS / run;
  return b.y0 + (b.y1 - b.y0) * s;
}

/**
 * The highest liquid surface over (x,z), or `null` where there is none.
 * @param {object|null} liquid the descriptor's `liquid` block
 */
export function liquidSurfaceAt(liquid, x, z) {
  const bodies = liquid?.bodies;
  if (!bodies) return null;
  let best = null;
  for (let i = 0; i < bodies.length; i++) {
    const y = bodySurfaceAt(bodies[i], x, z);
    if (y !== null && (best === null || y > best)) best = y;
  }
  return best;
}

const LAVA_CHUNK = /* glsl */`
  float lavaHash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float lavaNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = lavaHash(i);
    float b = lavaHash(i + vec2(1.0, 0.0));
    float c = lavaHash(i + vec2(0.0, 1.0));
    float d = lavaHash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
`;

/**
 * THE LIQUID FIELD: one signed number that says "is this under the liquid".
 *
 *   f(x, z) > 0  <=>  (x,z) is INSIDE some body's outline AND the ground there
 *                     is BELOW that body's surface.
 *
 * It is the maximum over bodies of `min(how far inside the outline, how far
 * below the surface)`, both in metres, so its zero set is exactly the boundary
 * of the region a player must not be able to stand in - and that boundary has
 * two quite different halves, which is the whole reason this is ONE field
 * rather than two tests:
 *
 *   A BEACH is a TERRAIN crossing. Shoal's sea is one 2,700 m disc and its
 *   shoreline is nowhere near the rim - it is the y = 6.0 CONTOUR of the
 *   islands, 3 km of it. There `inside` is enormous and `surf - ground` is what
 *   goes to zero.
 *
 *   A BANK is an OUTLINE crossing. Verdigris's gorge floor is dead flat and
 *   sits 1.1 m below the river's surface for the full 52 m width of the canyon,
 *   so `surf - ground` is positive right across it and never crosses zero. What
 *   bounds the water there is the ribbon's own edge. Cinder's crater lake is
 *   the same: its basin is below the lava plane well outside the disc.
 *
 * Getting this wrong is not academic. The first shore barrier marked whole
 * TERRAIN CELLS wet and fenced them, which on a beach is a metre of slop and on
 * Verdigris was ruinous: every cell merely touching the ribbon counted, because
 * the floor is below the river everywhere, so the fence ate about four metres
 * of each bank - and the walkable bank there is only a few metres wide before
 * the wall. Measured by flooding from `greenspan`: 9 of 20 malachite reachable
 * with the fence, 20 of 20 without it. `malachite` is `terrain: 'channel'`; the
 * ore and the river are the same feature by design.
 */
export function liquidField(liquid, x, z, groundY) {
  const bodies = liquid?.bodies;
  if (!bodies) return -Infinity;
  let best = -Infinity;
  for (let i = 0; i < bodies.length; i++) {
    const fb = bodyField(bodies[i], x, z);
    const v = Math.min(fb.inside, fb.surf - groundY);
    if (v > best) best = v;
  }
  return best;
}

/**
 * One body's outline distance and surface height at (x,z), both UNCONDITIONAL.
 *
 * `inside` is signed: positive within the drawn outline, negative outside, in
 * metres. `surf` is the surface height the body WOULD have there, extended past
 * its own edge, because the field above has to be continuous across the outline
 * to have a usable zero crossing.
 *
 * @returns {{ inside: number, surf: number }}
 */
export function bodyField(b, x, z) {
  if (b.shape === 'disc') {
    const dx = x - b.x;
    const dz = z - b.z;
    const d = Math.hypot(dx, dz);
    return { inside: discRadiusAt(b, Math.atan2(dz, dx)) - d, surf: b.y };
  }
  const pts = b.pts;
  let bestD = Infinity;
  let bestS = 0;
  let run = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const ax = pts[i][0];
    const az = pts[i][1];
    const ex = pts[i + 1][0] - ax;
    const ez = pts[i + 1][1] - az;
    const len2 = ex * ex + ez * ez;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / len2)) : 0;
    const d = Math.hypot(x - (ax + ex * t), z - (az + ez * t));
    const segLen = Math.sqrt(len2);
    if (d < bestD) { bestD = d; bestS = run + segLen * t; }
    run += segLen;
  }
  const s = run > 0 ? bestS / run : 0;
  return { inside: b.width * 0.5 - bestD, surf: b.y0 + (b.y1 - b.y0) * s };
}

/** The surface of whichever body owns (x,z) in the field, extended past its
 *  own edge. The wall's parapet is measured from this. */
export function liquidSurfaceExtended(liquid, x, z, groundY) {
  let best = -Infinity;
  let surf = groundY;
  for (const b of liquid.bodies) {
    const fb = bodyField(b, x, z);
    const v = Math.min(fb.inside, fb.surf - groundY);
    if (v > best) { best = v; surf = fb.surf; }
  }
  return surf;
}

/**
 * THE WATERLINE, as line segments, by marching squares over `liquidField`.
 *
 * This is what the shore barrier is built on, and it is built on the liquid's
 * OWN edge rather than on a terrain cell boundary for the reason recorded on
 * `liquidField`.
 *
 * The grid is the terrain's own samples subdivided `sub` times, with the ground
 * bilinearly interpolated from the SAME height buffer the collider was built
 * from - so the contour cannot drift away from the surface the player stands on
 * without the terrain drifting too.
 *
 * Each segment carries the INWARD normal, so a caller can hang a wall that
 * starts at the waterline and extends into the water rather than straddling it.
 * Straddling is what costs bank, and half a wall's thickness of bank is still
 * bank on a river that has four metres of it.
 *
 * @param {{ liquid: object, heights: Float32Array, nx: number, nz: number,
 *           originX: number, originZ: number, stepX: number, stepZ: number,
 *           sub?: number }} o
 * @returns {Array<{x0:number,z0:number,x1:number,z1:number,nx:number,nz:number,
 *                  len:number,surf:number,ground:number}>} world-space segments
 */
export function liquidContour(o) {
  const { liquid, heights, nx, nz, originX, originZ, stepX, stepZ } = o;
  const sub = Math.max(1, Math.round(o.sub ?? 2));
  if (!liquid?.bodies?.length) return [];
  const sx = stepX / sub;
  const sz = stepZ / sub;
  const gx = (nx - 1) * sub;
  const gz = (nz - 1) * sub;

  /* Bilinear ground off the collider's own samples. Cheap enough to call
   * (gx+1)*(gz+1) times - 665k on Shoal - where re-evaluating the height
   * function would be 665k fbm chains on the main thread during a load. */
  const ground = (x, z) => {
    let fx = (x - originX) / stepX;
    let fz = (z - originZ) / stepZ;
    if (fx < 0) fx = 0; else if (fx > nx - 1) fx = nx - 1;
    if (fz < 0) fz = 0; else if (fz > nz - 1) fz = nz - 1;
    let i = Math.floor(fx); if (i > nx - 2) i = nx - 2;
    let j = Math.floor(fz); if (j > nz - 2) j = nz - 2;
    const tx = fx - i;
    const tz = fz - j;
    const r0 = j * nx + i;
    const r1 = r0 + nx;
    return heights[r0] * (1 - tx) * (1 - tz) + heights[r0 + 1] * tx * (1 - tz)
      + heights[r1] * (1 - tx) * tz + heights[r1 + 1] * tx * tz;
  };

  /* Two rows of the field at a time: the whole grid is 665k doubles on Shoal
   * and is only ever read as a 2x2 stencil. */
  let prev = new Float64Array(gx + 1);
  let cur = new Float64Array(gx + 1);
  const rowAt = (j, out) => {
    const z = originZ + j * sz;
    for (let i = 0; i <= gx; i++) {
      const x = originX + i * sx;
      out[i] = liquidField(liquid, x, z, ground(x, z));
    }
  };
  rowAt(0, prev);

  const out = [];
  /** Where f crosses zero between two samples, as a fraction of the edge. */
  const cross = (a, b) => {
    const d = a - b;
    return Math.abs(d) < 1e-9 ? 0.5 : a / d;
  };

  for (let j = 0; j < gz; j++) {
    rowAt(j + 1, cur);
    const z0 = originZ + j * sz;
    const z1 = z0 + sz;
    for (let i = 0; i < gx; i++) {
      const f00 = prev[i];
      const f10 = prev[i + 1];
      const f01 = cur[i];
      const f11 = cur[i + 1];
      let code = 0;
      if (f00 > 0) code |= 1;
      if (f10 > 0) code |= 2;
      if (f11 > 0) code |= 4;
      if (f01 > 0) code |= 8;
      if (code === 0 || code === 15) continue;
      const x0 = originX + i * sx;
      const x1 = x0 + sx;
      const bottom = () => ({ x: x0 + sx * cross(f00, f10), z: z0 });
      const right = () => ({ x: x1, z: z0 + sz * cross(f10, f11) });
      const top = () => ({ x: x0 + sx * cross(f01, f11), z: z1 });
      const left = () => ({ x: x0, z: z0 + sz * cross(f00, f01) });
      const pairs = [];
      switch (code) {
        case 1: case 14: pairs.push([left(), bottom()]); break;
        case 2: case 13: pairs.push([bottom(), right()]); break;
        case 3: case 12: pairs.push([left(), right()]); break;
        case 4: case 11: pairs.push([right(), top()]); break;
        case 6: case 9: pairs.push([bottom(), top()]); break;
        case 7: case 8: pairs.push([left(), top()]); break;
        /* Saddles. Split them rather than guessing which way the shoreline
         * joins up: two short walls in the one cell where it pinches is the
         * cheap answer and it cannot leave a gap. */
        case 5: pairs.push([left(), bottom()], [right(), top()]); break;
        case 10: pairs.push([bottom(), right()], [left(), top()]); break;
        default: break;
      }
      if (!pairs.length) continue;
      /* Inward, from the field's own gradient across the cell. */
      let gxv = (f10 + f11) - (f00 + f01);
      let gzv = (f01 + f11) - (f00 + f10);
      const gl = Math.hypot(gxv, gzv) || 1;
      gxv /= gl;
      gzv /= gl;
      for (const [a, b] of pairs) {
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const len = Math.hypot(dx, dz);
        if (len < 1e-4) continue;
        const mx = (a.x + b.x) * 0.5;
        const mz = (a.z + b.z) * 0.5;
        const gm = ground(mx, mz);
        out.push({
          x0: a.x, z0: a.z, x1: b.x, z1: b.z, len,
          nx: gxv, nz: gzv,
          ground: gm,
          surf: liquidSurfaceExtended(liquid, mx, mz, gm),
        });
      }
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return out;
}

/**
 * CHAIN THE CONTOUR INTO WALL RUNS.
 *
 * Marching squares emits one stub per grid cell - about 1.5 m each - and a wall
 * built straight from those is SHORTER THAN IT IS DEEP. That is not a tidiness
 * problem, it is a correctness one: `Physics._closestPoint` leaves a box by its
 * nearest face, so a capsule that gets past a stub's midline is ejected along
 * the stub's LONGEST axis - and for a 1.5 m stub 3 m deep, that axis runs ALONG
 * the shore, or out the far side into the water. Measured before this existed:
 * a capsule marched at Cinder's crater lake came out 37 m sideways from where
 * it went in, and six of 136 approaches ended under the lava.
 *
 * Chaining makes every run longer than it is deep, so the shortest way out of
 * one is always perpendicular to the shore - the only direction that means
 * anything here. It also cuts the collider count by roughly five.
 *
 * Endpoints are shared exactly between neighbouring cells, because both cells
 * compute the same crossing from the same two field values, so the chain is
 * built by keying on the coordinate rather than by searching.
 *
 * A run ends when the shoreline turns, or when the water level under it moves.
 * `maxDev` bounds how far the true contour may sit from the straight panel that
 * replaces it: cut a convex corner and a sliver of water is left unwalled; cut
 * a concave one and the panel juts onto the bank, which is the thing this whole
 * rewrite exists to stop.
 *
 * @param {Array} segs from `liquidContour`
 * @param {{ maxLen?: number, maxDev?: number, maxRise?: number }} [opts]
 * @returns {Array<{cx:number,cz:number,ux:number,uz:number,nx:number,nz:number,
 *                  len:number,surf:number,ground:number}>} straight wall runs
 */
export function liquidWalls(segs, opts = {}) {
  const maxLen = opts.maxLen ?? 14;
  const maxDev = opts.maxDev ?? 0.35;
  const maxRise = opts.maxRise ?? 0.75;
  const key = (x, z) => `${Math.round(x * 1000)},${Math.round(z * 1000)}`;

  /* endpoint -> the segments touching it. A shoreline is a 1-manifold almost
   * everywhere, so most entries have exactly two. */
  const ends = new Map();
  const push = (k, i) => {
    const list = ends.get(k);
    if (list) list.push(i);
    else ends.set(k, [i]);
  };
  for (let i = 0; i < segs.length; i++) {
    push(key(segs[i].x0, segs[i].z0), i);
    push(key(segs[i].x1, segs[i].z1), i);
  }

  const used = new Uint8Array(segs.length);
  /** The one unused segment sharing this endpoint, or -1 where the shoreline
   *  branches (three or more meeting) - a branch ends the run. */
  const nextAt = (k) => {
    const list = ends.get(k);
    if (!list || list.length !== 2) return -1;
    for (const i of list) if (!used[i]) return i;
    return -1;
  };

  const out = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    /* `pts` are the chain's vertices; `seg` is the segment BETWEEN pts[k] and
     * pts[k+1], so a run over pts[a..b] owns seg[a..b-1]. */
    const pts = [{ x: segs[i].x0, z: segs[i].z0 }, { x: segs[i].x1, z: segs[i].z1 }];
    const seg = [segs[i]];
    for (;;) {
      const tail = pts[pts.length - 1];
      const n = nextAt(key(tail.x, tail.z));
      if (n < 0) break;
      used[n] = 1;
      const sg = segs[n];
      const atStart = Math.abs(sg.x0 - tail.x) < 1e-3 && Math.abs(sg.z0 - tail.z) < 1e-3;
      pts.push(atStart ? { x: sg.x1, z: sg.z1 } : { x: sg.x0, z: sg.z0 });
      seg.push(sg);
    }
    for (;;) {
      const head = pts[0];
      const n = nextAt(key(head.x, head.z));
      if (n < 0) break;
      used[n] = 1;
      const sg = segs[n];
      const atStart = Math.abs(sg.x0 - head.x) < 1e-3 && Math.abs(sg.z0 - head.z) < 1e-3;
      pts.unshift(atStart ? { x: sg.x1, z: sg.z1 } : { x: sg.x0, z: sg.z0 });
      seg.unshift(sg);
    }

    let a = 0;
    while (a + 1 < pts.length) {
      let b = a + 1;
      for (let c = a + 2; c < pts.length; c++) {
        const dx = pts[c].x - pts[a].x;
        const dz = pts[c].z - pts[a].z;
        const L = Math.hypot(dx, dz);
        if (L > maxLen || L < 1e-6) break;
        let dev = 0;
        for (let m = a + 1; m < c; m++) {
          const px = pts[m].x - pts[a].x;
          const pz = pts[m].z - pts[a].z;
          dev = Math.max(dev, Math.abs((px * dz - pz * dx) / L));
        }
        if (dev > maxDev) break;
        /* And stop where the water level does. A ribbon falls 56 m over its
         * length; a run whose two ends want different parapets is a run that
         * is the wrong height at one of them. */
        let lo = Infinity;
        let hi = -Infinity;
        for (let m = a; m < c; m++) {
          if (seg[m].surf < lo) lo = seg[m].surf;
          if (seg[m].surf > hi) hi = seg[m].surf;
        }
        if (hi - lo > maxRise) break;
        b = c;
      }
      const x0 = pts[a].x; const z0 = pts[a].z;
      const x1 = pts[b].x; const z1 = pts[b].z;
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len > 1e-4) {
        let nx = 0;
        let nz = 0;
        let surf = -Infinity;
        let ground = Infinity;
        for (let m = a; m < b; m++) {
          nx += seg[m].nx;
          nz += seg[m].nz;
          if (seg[m].surf > surf) surf = seg[m].surf;
          if (seg[m].ground < ground) ground = seg[m].ground;
        }
        const nl = Math.hypot(nx, nz) || 1;
        out.push({
          cx: (x0 + x1) * 0.5,
          cz: (z0 + z1) * 0.5,
          ux: (x1 - x0) / len,
          uz: (z1 - z0) / len,
          nx: nx / nl,
          nz: nz / nl,
          len,
          /* Highest water and lowest ground the run spans, so the wall is tall
           * enough at every point of it and reaches under its own footing. */
          surf,
          ground,
        });
      }
      a = b;
    }
  }
  return out;
}

/**
 * WHICH TERRAIN CELLS ARE UNDER THE LIQUID - for the MAP, not for the fence.
 *
 * A cell is wet when `liquidField` is positive at its centre, evaluated on the
 * mean of its four corner heights (which is the bilinear value there, and the
 * point a reach lattice asks about).
 *
 * There is NO reachability margin in this. The probes' `lavaMask` blocks a
 * lattice cell at `surface + 0.6` because 60 cm of freeboard is not somewhere
 * to promise a player can stand - that is a statement about CONFIDENCE. Turned
 * into geometry it becomes a statement about where the water IS, and the water
 * is not 60 cm up the bank. Conflating the two put a wall through a Sirocco
 * selenite seam, and then through Verdigris's malachite bank.
 *
 * @param {{ liquid: object|null, heights: Float32Array, nx: number, nz: number,
 *           originX: number, originZ: number, stepX: number, stepZ: number }} o
 * @returns {{ wet: Uint8Array, surf: Float32Array, cx: number, cz: number,
 *             wetCount: number }} `(nx-1) * (nz-1)`, row-major in j.
 */
export function liquidCellMask(o) {
  const { liquid, heights, nx, nz, originX, originZ, stepX, stepZ } = o;
  const cx = nx - 1;
  const cz = nz - 1;
  const wet = new Uint8Array(cx * cz);
  const surf = new Float32Array(cx * cz);
  let wetCount = 0;
  if (!liquid?.bodies?.length) return { wet, surf, cx, cz, wetCount };

  for (let j = 0; j < cz; j++) {
    const z = originZ + (j + 0.5) * stepZ;
    for (let i = 0; i < cx; i++) {
      const x = originX + (i + 0.5) * stepX;
      const r0 = j * nx + i;
      const r1 = r0 + nx;
      const g = (heights[r0] + heights[r0 + 1] + heights[r1] + heights[r1 + 1]) * 0.25;
      if (liquidField(liquid, x, z, g) <= 0) continue;
      const k = j * cx + i;
      wet[k] = 1;
      surf[k] = liquidSurfaceExtended(liquid, x, z, g);
      wetCount++;
    }
  }
  return { wet, surf, cx, cz, wetCount };
}

/**
 * THE DEPTH TERM.
 *
 * Water 20 cm deep and water 20 m deep used to be the same colour, so a lagoon
 * you could wade read exactly like the open ocean and the shelf that IS the
 * planet gave the eye nothing. The distance from the liquid plane down to the
 * ground beneath it is the cue, and it is the cue on every real body of water.
 *
 * -- Why a texture and not a vertex attribute -----------------------------
 * The obvious fix is a per-vertex depth, and it cannot work here. A `disc` is a
 * TRIANGLE FAN: one vertex at the centre and the rest on the rim, with nothing
 * in between. Shoal's sea is a single 2,700 m disc, so a per-vertex depth would
 * be sampled at the middle of the ocean and at a rim 2,700 m out - never once
 * anywhere the player can see. Re-tessellating it into rings fine enough to
 * resolve a beach would be tens of thousands of triangles for a surface that is
 * currently 128, and it would still be radial where the shore is not.
 *
 * So the bed goes in as a texture: the SAME height samples the terrain mesh and
 * the terrain collider were built from, uploaded once as a single-channel
 * half-float, and read per fragment. It costs one texture per planet (281x281
 * on Shoal, 158 KB), no extra draw call, no extra light, and it works for a
 * ribbon as readily as for a disc.
 *
 * `vLavaW.y` is the liquid surface at the fragment - the mesh IS the plane - so
 * the depth is a subtraction with nothing to keep in sync.
 *
 * -- Every division guarded ----------------------------------------------
 * `uDepthScale`, `uSurfBand` and the bed step are floored on the JS side
 * (`liquidDepth`, and the throw in `PlanetWorld._bedTexture`). Off the edge of
 * the height field - Shoal's sea runs 2,700 m out and the field stops at 440 -
 * the sample is not clamped to the rim height, which would draw the far ocean
 * as a shallow: `inBed` switches the depth to `uDepthFar` instead.
 */
const DEPTH_UNIFORMS = /* glsl */`
  uniform sampler2D uBed;
  uniform vec2 uBedOrigin;
  uniform vec2 uBedStep;
  uniform vec2 uBedTexel;
  uniform float uDepthAmt;
  uniform float uDepthScale;
  uniform float uSurfAmt;
  uniform float uSurfBand;
  uniform float uDepthFar;
`;

const DEPTH_BODY = /* glsl */`
        vec2 bedRaw = (vLavaW.xz - uBedOrigin) / uBedStep;
        vec2 bedUv = (bedRaw + 0.5) * uBedTexel;
        float inBed = step(0.0, bedUv.x) * step(bedUv.x, 1.0)
                    * step(0.0, bedUv.y) * step(bedUv.y, 1.0);
        float bedY = texture2D(uBed, clamp(bedUv, uBedTexel * 0.5, vec2(1.0) - uBedTexel * 0.5)).r;
        float depth = mix(uDepthFar, max(0.0, vLavaW.y - bedY), inBed);
        /* 0 at the waterline, ->1 in open water. The flow noise keeps whatever
         * share of the crust->deep axis depth does not claim, so wind streaks
         * survive on a sea and a lava lake's skin is untouched at amount 0. */
        float dw = 1.0 - exp(-depth / uDepthScale);
        tone = clamp(mix(tone, dw, uDepthAmt), 0.0, 1.0);
`;

const SURF_BODY = /* glsl */`
        /* The pale band where the bed is close enough to show through. uHot
         * is the brightest channel a descriptor declares - foam on water, and
         * on lava it is the incandescence, which is why this defaults to 0
         * there rather than putting a bright rim round a lava lake. */
        diffuseColor.rgb = mix(
          diffuseColor.rgb, uHot,
          (1.0 - smoothstep(0.0, uSurfBand, depth)) * uSurfAmt
        );
`;

/**
 * The one liquid material. Cloned per world, shared across every body on it.
 *
 * @param {object} liquid the descriptor's `liquid` block
 * @param {{ texture: THREE.Texture, originX: number, originZ: number,
 *           stepX: number, stepZ: number, nx: number, nz: number }} [bed]
 *   the terrain height field this liquid is standing on. Omit it and the depth
 *   term is not compiled at all.
 * @returns {{ material: THREE.MeshStandardMaterial, uniforms: object, depth: object }}
 */
export function createLiquidMaterial(liquid, bed = null) {
  const depth = liquidDepth(liquid);
  /* The depth term is COMPILED OUT, not multiplied out, when it is not wanted.
   * `mix(a, b, 0.0)` is exactly `a`, so a zero amount would already be a no-op
   * numerically - but leaving the chunk in would change the program every
   * calibrated lava planet compiles, and "it should be identical" is not the
   * same claim as "it is the same program". */
  const useDepth = depth.amount > 0 && !!bed?.texture;

  const uniforms = {
    uTime: { value: 0 },
    uFlow: { value: liquid.flow ?? 0.5 },
    uHot: { value: new THREE.Color(liquid.hot ?? 0xff7a1c) },
    uCrust: { value: new THREE.Color(liquid.crust ?? 0x140b0a) },
    uDeep: { value: new THREE.Color(liquid.color ?? 0x3d0a04) },
    uEmissive: { value: liquid.emissive ?? 2.5 },
  };
  if (useDepth) {
    Object.assign(uniforms, {
      uBed: { value: bed.texture },
      uBedOrigin: { value: new THREE.Vector2(bed.originX, bed.originZ) },
      uBedStep: { value: new THREE.Vector2(bed.stepX, bed.stepZ) },
      uBedTexel: { value: new THREE.Vector2(1 / bed.nx, 1 / bed.nz) },
      uDepthAmt: { value: depth.amount },
      uDepthScale: { value: depth.scale },
      uSurfAmt: { value: depth.surf },
      uSurfBand: { value: depth.surfBand },
      uDepthFar: { value: depth.far },
    });
  }

  const material = new THREE.MeshStandardMaterial({
    name: 'planet.liquid',
    color: 0xffffff,
    roughness: 0.62,
    metalness: 0.0,
    emissive: new THREE.Color(0x000000),
    emissiveIntensity: 1.0,
  });

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = `varying vec3 vLavaW;\n${shader.vertexShader}`.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  vLavaW = (modelMatrix * vec4(transformed, 1.0)).xyz;'
    );

    shader.fragmentShader = `
      varying vec3 vLavaW;
      uniform float uTime;
      uniform float uFlow;
      uniform vec3 uHot;
      uniform vec3 uCrust;
      uniform vec3 uDeep;
      uniform float uEmissive;
      ${useDepth ? DEPTH_UNIFORMS : ''}
      ${LAVA_CHUNK}
      ${shader.fragmentShader}
    `.replace(
      '#include <emissivemap_fragment>',
      /* glsl */`
      #include <emissivemap_fragment>
      {
        /* Two drift rates, deliberately not multiples of one another. A crust
         * scrolling as one sheet reads as a texture on a conveyor; two layers
         * shearing past each other read as a skin tearing, which is what it is. */
        vec2 q = vLavaW.xz * 0.055;
        vec2 drift = vec2(uTime * uFlow * 0.035, uTime * uFlow * 0.014);
        float n = lavaNoise(q + drift) * 0.58
                + lavaNoise(q * 2.7 + drift * 2.1 + 13.0) * 0.29
                + lavaNoise(q * 6.3 - drift * 0.7) * 0.13;

        /* Veins where the crust has pulled apart.
         *
         * The band was 0.20 wide and the flow read as cold rock from any low
         * angle: a vein a few centimetres across is sub-pixel at 200 m and at a
         * grazing angle it is compressed to nothing, so the whole 340 m of
         * outlet gorge came back in a review screenshot looking like a road.
         * 0.26 makes the veins metres across, which is what they are on a flow
         * this size - and 0.34, which was the first correction, made the whole
         * gorge a lightbox with no crust left in it at all. */
        float band = abs(fract(n * 3.4) - 0.5) * 2.0;
        float crack = 1.0 - smoothstep(0.0, 0.26, band);
        // Broad molten patches where it has not skinned over at all. The old
        // 0.63 threshold sat above almost the whole range of a 3-octave fbm.
        float open = smoothstep(0.58, 0.80, n);
        float glow = clamp(crack * 0.9 + open, 0.0, 1.6);

        float tone = clamp(glow, 0.0, 1.0);
${useDepth ? DEPTH_BODY : ''}
        diffuseColor.rgb = mix(uCrust, uDeep, tone);
${useDepth && depth.surf > 0 ? SURF_BODY : ''}
        /* The 0.045 floor is the crust's own residual heat. Without it the
         * unbroken skin is literally black, and a black lake is a hole.
         *
         * The emissive is driven by the ORIGINAL glow, never by the depth.
         * Depth belongs to the diffuse: a deep sea is not a brighter sea, and
         * on a lava planet routing depth into the emissive would move the
         * scene-linear luminance the bloom threshold was calibrated against. */
        totalEmissiveRadiance += uHot * uEmissive * (glow * 0.58 + 0.045);
      }
      `
    );
  };
  /* Anything compiled through `onBeforeCompile` needs a cache key or three
   * hands every clone the first one's program - and the key has to name every
   * variant the function can emit, or the first planet built decides what the
   * second one looks like. Cinder still compiles `planet.liquid.v1`. */
  const key = useDepth ? `planet.liquid.v2.depth${depth.surf > 0 ? '.surf' : ''}` : 'planet.liquid.v1';
  material.customProgramCacheKey = () => key;

  return { material, uniforms, depth };
}

/**
 * The aprons' material. Never emissive: an apron that glowed would light the
 * ground it is hidden under.
 *
 * It takes the DARK channel, and which one that is depends on the substance.
 * `crust` is lava's chilled skin, the darkest thing on the planet - but Shoal
 * documented `crust` as its LIGHTER colour, because a water surface's light
 * value is on top and its dark one underneath. An apron is a vertical face
 * hanging below a waterline, so on water it wants `color` and on lava `crust`;
 * taking `crust` unconditionally hung a pale blue skirt under a sea.
 */
export function createSkirtMaterial(liquid) {
  const dark = liquidKind(liquid) === 'water'
    ? (liquid.color ?? 0x0d3348)
    : (liquid.crust ?? 0x140b0a);
  return new THREE.MeshStandardMaterial({
    name: 'planet.liquid.skirt',
    color: new THREE.Color(dark),
    roughness: 0.9,
    metalness: 0.0,
  });
}

/**
 * Surface + apron geometry for one body.
 *
 * @param {object} b a descriptor `liquid.bodies[i]` record
 * @returns {{ surface: THREE.BufferGeometry, skirt: THREE.BufferGeometry }}
 */
export function bodyGeometry(b) {
  if (b.shape === 'disc') return discGeometry(b);
  return ribbonGeometry(b);
}

/**
 * A disc body's radius on a given bearing.
 *
 * THE SHORELINE IS NOT A CIRCLE, and this is the one function that says so.
 * The first review screenshot of the crater lake came back with a geometrically
 * perfect circle of lava sitting on the crater floor: it read as a decal
 * somebody had dropped on the terrain, and no amount of shader work on the
 * surface fixed it, because the tell was the outline.
 *
 * Two low harmonics plus a third at the seed's phase - enough to make the
 * outline read as a shore and not enough to make it read as a star. `wobble`
 * defaults to 0.09, i.e. +-9% of the radius.
 *
 * Exported because the shoreline TEST has to sample the same outline the mesh
 * draws. A test that measured the nominal radius while the mesh drew a wobbly
 * one would be measuring a shore that does not exist - which is the same class
 * of error as a collider that disagrees with its mesh, one dimension down.
 */
export function discRadiusAt(b, angle) {
  const w = b.wobble ?? 0.09;
  if (w <= 0) return b.r;
  const p = (b.phase ?? 0) + (b.x + b.z) * 0.017;
  return b.r * (1 + w * (
    0.60 * Math.sin(angle * 3 + p)
    + 0.28 * Math.sin(angle * 5 - p * 1.7)
    + 0.12 * Math.sin(angle * 8 + p * 0.6)
  ));
}

function discGeometry(b) {
  const seg = Math.max(48, Math.min(128, Math.round(b.r * 2.4)));
  const pos = new Float32Array((seg + 1) * 3);
  const uv = new Float32Array((seg + 1) * 2);
  pos[0] = b.x; pos[1] = b.y; pos[2] = b.z;
  uv[0] = 0.5; uv[1] = 0.5;
  const rim = new Float32Array(seg * 2);
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const r = discRadiusAt(b, a);
    rim[i * 2] = b.x + Math.cos(a) * r;
    rim[i * 2 + 1] = b.z + Math.sin(a) * r;
    pos[(i + 1) * 3] = rim[i * 2];
    pos[(i + 1) * 3 + 1] = b.y;
    pos[(i + 1) * 3 + 2] = rim[i * 2 + 1];
    uv[(i + 1) * 2] = 0.5 + Math.cos(a) * 0.5;
    uv[(i + 1) * 2 + 1] = 0.5 + Math.sin(a) * 0.5;
  }
  /* Wound so the fan faces UP. The rim runs anticlockwise in (cos, sin), which
   * puts (centre, i, i+1) anticlockwise as seen from BELOW - i.e. face-down,
   * culled from every position a player can stand in. Swapping the last two
   * indices is the whole fix; `liquid-facing` in `planet-relief.test.mjs`
   * caught this and the ribbon's identical mistake in the same run. */
  const idx = [];
  for (let i = 0; i < seg; i++) idx.push(0, ((i + 1) % seg) + 1, i + 1);
  const surface = new THREE.BufferGeometry();
  surface.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  surface.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  surface.setIndex(idx);
  surface.computeVertexNormals();

  // The apron, hung off the same rim so it cannot part company with it.
  const sp = new Float32Array(seg * 6 * 3);
  let t = 0;
  const put = (x, y, z) => { sp[t++] = x; sp[t++] = y; sp[t++] = z; };
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    const ax = rim[i * 2]; const az = rim[i * 2 + 1];
    const bx = rim[j * 2]; const bz = rim[j * 2 + 1];
    put(ax, b.y, az); put(ax, b.y - SKIRT, az); put(bx, b.y - SKIRT, bz);
    put(ax, b.y, az); put(bx, b.y - SKIRT, bz); put(bx, b.y, bz);
  }
  const skirt = new THREE.BufferGeometry();
  skirt.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  skirt.computeVertexNormals();

  return { surface, skirt };
}

/**
 * A flow ribbon.
 *
 * Built as a strip of quads along the polyline, its Y taken from the SAME
 * linear-in-arclength interpolation the `ramp` landform under it uses. Not
 * per-segment-linear: interpolating between the two endpoints of each segment
 * separately would give a different surface wherever the segments are unequal,
 * and lava that sits 40 cm proud of its own channel is the sort of thing that
 * only shows up in a screenshot.
 */
function ribbonGeometry(b) {
  const pts = b.pts;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  const total = cum[cum.length - 1];

  // Resample so a long straight leg is not one enormous quad: the liquid
  // material's detail is per-fragment, but the fog and the vertex lighting are
  // not, and a 100 m quad fogs from its corners.
  const STEP = 6;
  const samples = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const segLen = cum[i + 1] - cum[i];
    const n = Math.max(1, Math.round(segLen / STEP));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      samples.push({
        x: pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t,
        z: pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t,
        s: (cum[i] + segLen * t) / total,
        dx: pts[i + 1][0] - pts[i][0],
        dz: pts[i + 1][1] - pts[i][1],
      });
    }
  }
  const last = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  samples.push({ x: last[0], z: last[1], s: 1, dx: last[0] - prev[0], dz: last[1] - prev[1] });

  const n = samples.length;
  const pos = new Float32Array(n * 2 * 3);
  const uv = new Float32Array(n * 2 * 2);
  const sPos = new Float32Array(n * 2 * 3);
  const half = b.width * 0.5;

  for (let i = 0; i < n; i++) {
    const p = samples[i];
    const len = Math.hypot(p.dx, p.dz) || 1;
    const nx = -p.dz / len;
    const nz = p.dx / len;
    const y = b.y0 + (b.y1 - b.y0) * p.s;
    for (const [k, sgn] of [[0, -1], [1, 1]]) {
      const idx = (i * 2 + k) * 3;
      pos[idx] = p.x + nx * half * sgn;
      pos[idx + 1] = y;
      pos[idx + 2] = p.z + nz * half * sgn;
      uv[(i * 2 + k) * 2] = k;
      uv[(i * 2 + k) * 2 + 1] = p.s * total * 0.1;
      sPos[idx] = pos[idx];
      sPos[idx + 1] = y - SKIRT;
      sPos[idx + 2] = pos[idx + 2];
    }
  }

  /* Wound so the face normals point UP.
   *
   * The first version wound them the other way and the entire outlet gorge was
   * backface-culled: 340 m of lava river simply was not in the frame, and it
   * looked exactly like a lava river that had cooled - which is why it survived
   * three review screenshots. `computeVertexNormals` cannot save this; it
   * derives the normal FROM the winding, so a face-down ribbon also gets lit
   * from underneath. `liquid-facing` in `planet-relief.test.mjs` now measures
   * it, because "is this polygon inside out" is not something a screenshot can
   * be trusted to answer.
   *
   * The left edge (k=0) is at `-n` and the right (k=1) at `+n`, where
   * `n = (-dz, dx)/len`. With travel along +x that puts the left edge at -z, so
   * (v0_i, v1_{i+1}, v0_{i+1}) is counter-clockwise seen from +y. */
  const index = [];
  for (let i = 0; i + 1 < n; i++) {
    const a = i * 2;
    index.push(a, a + 3, a + 2, a, a + 1, a + 3);
  }

  const surface = new THREE.BufferGeometry();
  surface.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  surface.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  surface.setIndex(index);
  surface.computeVertexNormals();

  /* The apron is two vertical strips, one down each edge, wound so both face
   * outward. A single skirt round the whole outline would need the ribbon's
   * boundary loop; two strips need only the edge columns already computed. */
  const skirtPos = [];
  for (let i = 0; i + 1 < n; i++) {
    for (const k of [0, 1]) {
      const a = (i * 2 + k) * 3;
      const c = ((i + 1) * 2 + k) * 3;
      const flip = k === 0;
      const t0 = [pos[a], pos[a + 1], pos[a + 2]];
      const t1 = [pos[c], pos[c + 1], pos[c + 2]];
      const b0 = [sPos[a], sPos[a + 1], sPos[a + 2]];
      const b1 = [sPos[c], sPos[c + 1], sPos[c + 2]];
      const tri = flip
        ? [t0, b0, b1, t0, b1, t1]
        : [t0, b1, b0, t0, t1, b1];
      for (const v of tri) skirtPos.push(v[0], v[1], v[2]);
    }
  }
  const skirt = new THREE.BufferGeometry();
  skirt.setAttribute('position', new THREE.BufferAttribute(new Float32Array(skirtPos), 3));
  skirt.computeVertexNormals();

  return { surface, skirt };
}
