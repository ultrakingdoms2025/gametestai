/**
 * The Citadel mesa's ground, and the 900 m of reach authored around it.
 *
 * Lifted out of `CitadelWorld.js` so the generation worker can import it
 * without `three`. `CitadelWorld` imports it back, so the visible heightfield,
 * the collision under it and every prop placement still read one function -
 * which is the whole reason this shape is expressed as a function at all. It was
 * previously three separate approximations of the same slope, and where the
 * collision sat lower than the mesh the player walked *underneath* the visible
 * world across 7% of the map.
 *
 * ---- Phase 3, the Reach ----
 *
 * `HALF` went 200 -> 450 (5.06x the area). The mesa did not move: everything
 * added below is gated on `ringMask`, a clamping `smoothstep` over the
 * CHEBYSHEV radius whose lower edge IS the old playfield half-extent, so it is
 * exactly `0` - not nearly zero - throughout the original 400 m square, and
 * every landform's support is an AABB disjoint from that square. `citadelHeight`
 * is therefore `terrainH(hypot(x, z)) + ringRelief(x, z)` with `ringRelief`
 * returning literal `0` in there, and `v + 0 === v` is the whole bit-identity
 * argument. `scripts/tests/citadel-height.test.mjs` pins it with a SHA-256
 * digest over 530,421 samples, baselined from the pre-expansion file.
 *
 * ---- On noise in here, which this file used to forbid ----
 *
 * The old header read: "Deliberately free of x/z noise. Dunes are built as real
 * geometry with real colliders instead: noise in here is noise the dune boxes
 * cannot reproduce." That rule was written when the mesh carried a sine dune
 * field that NOTHING collided with. It is obsolete, and by its own reasoning:
 * `CitadelWorld._buildTerrain` now registers the very samples this function
 * produces as a `physics.addHeightfield`, so relief authored here is relief the
 * player stands on. What survives of the rule is the resolution clause - the
 * mesh is sampled on a `seg x seg` grid, so a feature narrower than about two
 * cells is invisible to the collider even though it is in this function. The
 * smallest authored horizontal scale below is 5 m (the quarry benches' risers)
 * and the smallest that carries meaning is the 12 m karst pinnacle. At the
 * `seg = 96` this world shipped with, a 900 m map is 9.375 m per cell and the
 * terraces alias away; `seg >= 240` (3.75 m) resolves every bench and
 * `seg >= 360` (2.5 m) resolves every riser. That is a number `CitadelWorld`
 * owns, not this file, and it is recorded here because this file is where the
 * requirement comes from.
 *
 * Nothing in this file may import `three` or touch the DOM.
 */

/* The generic, seeded, deterministic field helpers. Imported rather than
 * copied: a second `perlin2` in this repo is a second thing to reseed, and both
 * worlds' generation workers already load both modules through
 * `terrain/index.js`. Nothing the protected core does depends on any of them,
 * so a reseed of the shared permutation table cannot move the town - it can
 * only redraw the outer ring. */
import {
  fbm2, perlin2, smoothstep, lerp, rectDist,
} from './MedievalHeight.js';

/** Height of the plateau the town sits on, above the surrounding desert. */
export const MESA_Y = 14;
/** Where the plateau edge falls away to the approach road. */
export const MESA_R = 132;
/** Horizontal distance the shoulder takes to fall from the mesa to the desert. */
export const SHOULDER = 46;

/**
 * Playfield half-extent, metres. The map is `2 * HALF` on a side.
 *
 * 450 (900 x 900 m, 5.06x the area of the original 400 m field). Drives the
 * terrain mesh extent, the collision heightfield, `CitadelWorld.bounds` and
 * therefore how many relic sites `Relics` asks for. Content radii are NOT
 * derived from it and must not be.
 */
export const HALF = 450;

/**
 * Half-width of the ORIGINAL 400 m playfield, and the line this phase may not
 * cross.
 *
 * Everything inside `|x| <= INNER_KEEP && |z| <= INNER_KEEP` - the mesa, its
 * whole shoulder (the shoulder ends at `r = 178`, and `r >= cheb`, so it is
 * comfortably inside), the curtain wall at 118, the souk rings, 192 roofs,
 * eleven haystacks and every prop placed by sampling this function - was
 * authored against the ground as it stands. Moving it by one float ULP moves
 * all of that, and none of it fails loudly: it floats a haystack or buries a
 * doorway. So the rule is absolute rather than approximate: `ringRelief`
 * returns literal `0` in there, every landform's declared AABB is disjoint
 * from the square, and the digest test proves both.
 */
export const INNER_KEEP = 200;

/**
 * Where the ring mask reaches full strength.
 *
 * 62 m of ramp. The ground just outside the old playfield is dead-flat desert
 * at exactly `y = 0` (see `terrainH`), so unlike Aldermoor there is no natural
 * relief for a short ramp to hide behind; 62 m puts the broad relief's median
 * lift of about 6 m on a 10% grade, which reads as the basin the mesa stands
 * in rather than as a terrace ringing the middle of the map.
 *
 * WRITTEN AS THE SUM IT IS, and that is not a style preference. `262` was the
 * literal here, which does two bad things at once: the extent sweep in
 * `citadel-extent.test.mjs` hunts a bare `200` in this file and a pre-added
 * one is invisible to it, and a later move of `INNER_KEEP` would silently
 * change the ramp's LENGTH instead of carrying it. Worse, push `INNER_KEEP`
 * past the old literal and `smoothstep(edge0 > edge1)` inverts: the mask
 * becomes 1 inside the protected square and 0 outside it, which is the exact
 * opposite of R9 and would not throw. The sum cannot do any of that.
 */
const RING_RAMP = 62;
const RING_OUT = INNER_KEEP + RING_RAMP;

const TAU = Math.PI * 2;
/** Absolute angular difference in radians, wrapped to [0, pi]. */
function angGap(a, b) {
  const d = (((a - b + Math.PI) % TAU) + TAU) % TAU - Math.PI;
  return d < 0 ? -d : d;
}

/** The mesa itself, as a pure function of distance from the centre. */
export function terrainH(r) {
  if (r < MESA_R) return MESA_Y;
  const t = Math.min(1, (r - MESA_R) / SHOULDER);
  return MESA_Y * (1 - t * t * (3 - 2 * t));
}

/**
 * How much of the outer ring a point is in: 0 inside the old playfield, 1 well
 * outside it.
 *
 * Chebyshev rather than Euclidean radius because the thing being protected is
 * a SQUARE. `smoothstep` clamps, so this is exactly 0 - not nearly 0 - at and
 * inside `INNER_KEEP`.
 */
export function ringMask(x, z) {
  const ax = x < 0 ? -x : x;
  const az = z < 0 ? -z : z;
  return smoothstep(INNER_KEEP, RING_OUT, ax > az ? ax : az);
}

/* ------------------------------------------------------------------ */
/* Broad relief - the connective tissue of the ring                    */
/* ------------------------------------------------------------------ */

/**
 * Broad relief for the whole ring.
 *
 * The measured problem this solves is worse here than it was in Aldermoor.
 * `terrainH` is purely radial and returns 0 beyond `r = MESA_R + SHOULDER =
 * 178`, so before this phase the entire 650,000 m2 ring was flat sand at
 * exactly zero: 0.00 m of relief, 100% of it under a 5% slope. Five named
 * landforms cannot fix that - they cover about a fifth of it - so the ring
 * needs connective tissue with real amplitude.
 *
 * Ridged noise (`1 - |fbm|`, squared) rather than another plain fbm octave,
 * because plain fbm is symmetric: equal bumps and dents, averaging to a plain.
 * Squared ridged noise gives long connected crest lines with broad hollows
 * between them, which is what a desert basin looks like from inside it, and it
 * is what lets a later phase run a caravan road along a hollow. Three octaves
 * at a ~345 m base wavelength; the landforms own everything finer.
 *
 * Gain and bias are measured, not chosen. The squared ridged term's quantiles
 * over this ring are p01 0.452, p10 0.582, p50 0.798, p90 0.952; 19.6 / -8.6
 * puts p10 at +2.8 m, p50 at +7.0 m and p90 at +10.1 m, and the field's true
 * minimum over the whole map is -1.72 m (at -268.5, 450). That last number is
 * a hand-off, not a curiosity: `CitadelWorld.js` adds a desert floor box whose
 * top is exactly `y = 0`, so until that box goes - and C4 of the design
 * requires it to, because its 452 m bounding radius puts it in every one of
 * the broadphase's grid cells - the ring's few sub-datum hollows are floored
 * by an invisible collider 1.7 m above the mesh.
 *
 * Deliberately not larger: the mesa is 14 m tall, and broad relief loud enough
 * to compete with it turns the citadel into a hill among hills.
 */
const BROAD_GAIN = 19.6;
const BROAD_BIAS = -8.6;
function broadRelief(x, z) {
  const r = 1 - Math.abs(fbm2(x * 0.0029 + 17.9, z * 0.0029 - 5.1, 3));
  return r * r * BROAD_GAIN + BROAD_BIAS;
}

/**
 * Ground before any landform is authored onto it.
 *
 * Split out for the same reason Aldermoor split it: a landform that levels to
 * an ABSOLUTE height is only a landform where the surrounding ground happens
 * to be lower. Each shape below reads this ONCE at module load, at its own
 * centre, and works relative to that - so the quarry crown stands 22 m above
 * its own ground by construction and stays that way if the noise is ever
 * reseeded.
 */
function baseGround(x, z, ring = ringMask(x, z)) {
  const h = terrainH(Math.hypot(x, z));
  return ring > 0 ? h + broadRelief(x, z) * ring : h;
}

/* ------------------------------------------------------------------ */
/* Landforms                                                           */
/* ------------------------------------------------------------------ */

/**
 * THE UNDERCLIFF - a four-bench shelf stepping down and out from the mesa's
 * southern foot.
 *
 * The verb is descent: drops, and hay under them. Each riser is 5.0 m over
 * 6.0 m of run - a mean gradient of 0.83 and a measured peak of 1.32, against
 * a walk limit of 0.678 - so it is a drop you take rather than a slope you
 * walk, and 5.0 m is comfortably under the 7.5 m where fall damage first
 * appears. Four of them in a row is a descent you can rehearse. It is a
 * one-way descent: 1.32 is also under the 1.73 a face has to reach before
 * `Climb` will grip it, so the way back up is the approach ramp or round the
 * shelf's own angular edge, where the sector window feathers it to nothing.
 *
 * It stands ON the flats rather than being cut into the shoulder, and that is
 * forced rather than chosen: the shoulder is inside the protected square by
 * 22 m in every direction, so a terrace cut into it is a terrace cut into the
 * old town. What the shape does instead is walk UP out of the desert - the one
 * approach a cart could take, and therefore where a gate is worth building -
 * onto a 20 m shelf that then falls away outward. A lower town that looks down
 * on the caravan flats and up at the citadel.
 *
 * `ramp` is 76 m and not the 40 m it was first authored at, and the difference
 * is the whole point of measuring rather than deriving. A `smoothstep` ramp's
 * PEAK gradient is 1.5x its mean, so 20 m over 40 m is a mean of 0.50 and a
 * peak of 0.75 - and with the broad relief underneath it the probe read 0.949,
 * against a walk limit of 0.678 (`Treasures.MAX_WALK_SLOPE` 0.78, which is a
 * gradient of 0.678 once its 1.15 normalisation is undone). The one walkable
 * approach was not walkable. 64 m measured 0.642, which passes and leaves 5%
 * of margin on a number the whole district's reachability rests on; 76 m
 * measures 0.547.
 *
 * The sector is narrow (0.45 rad including feather) for a hard geometric
 * reason: the support must clear the protected square at its NEAREST corner,
 * and for a sector centred on +z that means `foot * cos(halfAngle) > 200`. At
 * 226 m and 0.45 rad the nearest support point sits at z = 203.5.
 */
const UNDERCLIFF = {
  ang: Math.PI / 2, half: 0.34, soft: 0.11,
  foot: 226, ramp: 76, bench: 26, riser: 6, steps: 4, drop: 5.0,
};
const UNDERCLIFF_SPAN = UNDERCLIFF.half + UNDERCLIFF.soft;
const UNDERCLIFF_TOP = UNDERCLIFF.steps * UNDERCLIFF.drop;
const UNDERCLIFF_R0 = UNDERCLIFF.foot + UNDERCLIFF.ramp;
const UNDERCLIFF_REACH =
  UNDERCLIFF_R0 + UNDERCLIFF.steps * (UNDERCLIFF.bench + UNDERCLIFF.riser);
function undercliffLift(x, z) {
  const u = UNDERCLIFF;
  /* `Math.sqrt` rather than `Math.hypot`: hypot's overflow-safe scaling costs
   * roughly an order of magnitude and these operands are map coordinates. The
   * one `hypot` this file keeps is the mesa's, because changing that one would
   * move the protected core by an ULP. */
  const r = Math.sqrt(x * x + z * z);
  if (r <= u.foot || r >= UNDERCLIFF_REACH) return 0;
  const w = 1 - smoothstep(u.half, UNDERCLIFF_SPAN, angGap(Math.atan2(z, x), u.ang));
  if (w <= 0) return 0;
  if (r < UNDERCLIFF_R0) {
    return UNDERCLIFF_TOP * smoothstep(u.foot, UNDERCLIFF_R0, r) * w;
  }
  let lift = UNDERCLIFF_TOP;
  for (let k = 0; k < u.steps; k++) {
    const e0 = UNDERCLIFF_R0 + k * (u.bench + u.riser) + u.bench;
    lift -= u.drop * smoothstep(e0, e0 + u.riser, r);
  }
  return lift * w;
}

/**
 * THE QUARRY AND DEEPWORKS - a stone upland with a benched pit cut into it.
 *
 * The verb is vertical DOWN, which the citadel has nowhere to teach: every
 * height in the old playfield is a roof you climb to. A pit inverts that - the
 * descent is the content and the way back out is the difficulty.
 *
 * The pit is cut into a RAISED crown rather than into the flats, and that is
 * the whole trick: 20 m of descent that never goes below the desert datum, so
 * the pit floor is real ground rather than a hole under the world. Three
 * benches, each riser 6.67 m over 5 m of run - a drop, survivable, with a
 * gantry's worth of ledge between them.
 *
 * `crown` (58 m) is wider than `pitR` (54 m), so there is a 4 m lip of solid
 * rock between the rim of the pit and the head of the outer slope. Without it
 * the rim and the slope meet at a knife edge and the mine mouths have nothing
 * to be cut into.
 */
const QUARRY = {
  x: 325, z: -96, reach: 120, crown: 58, rise: 22,
  pitR: 54, floorR: 18, depth: 20, benches: 3, benchRun: 5,
};
const QUARRY_TOP = baseGround(QUARRY.x, QUARRY.z) + QUARRY.rise;
function quarryShape(h, x, z) {
  const q = QUARRY;
  const dx = x - q.x;
  if (dx <= -q.reach || dx >= q.reach) return h;
  const dz = z - q.z;
  if (dz <= -q.reach || dz >= q.reach) return h;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d >= q.reach) return h;
  h = lerp(h, QUARRY_TOP, 1 - smoothstep(q.crown, q.reach, d));
  if (d < q.pitR) {
    const tread = (q.pitR - q.floorR) / q.benches;
    const stepDrop = q.depth / q.benches;
    let cut = 0;
    for (let k = 0; k < q.benches; k++) {
      const e = q.pitR - (k + 1) * tread;
      cut += stepDrop * smoothstep(e + q.benchRun, e, d);
    }
    h -= cut;
  }
  return h;
}

/**
 * THE KARST MASSIF AND THE EYRIE - a mountain with a monastery shelf and a
 * summit above a climb.
 *
 * The verb is sustained climb, and the number that shapes it is measured: one
 * stamina bar sustains 29.3 m of climbing. So the massif is not one face. It
 * is a walkable outer ramp up to a 16 m shelf at +18 (where the monastery's
 * lower court goes), and then ONE 26 m face to the summit at +44 - inside a
 * single bar with 3.3 m of margin, and nothing above it to strand a player who
 * arrives empty. The face measures a gradient of 2.44, which clears the 1.73
 * (60 degrees) a face needs to be gripped at all rather than walked up.
 *
 * The outer ramp's run is modulated by bearing, `cos^3`, the way Blackmarch
 * Bluff's is: 79 m of run on the bearing back toward the citadel (peak gradient
 * 0.564 against a 0.678 walk limit, so the aqueduct's far abutment has a
 * walk-up beside it) falling to 30 m elsewhere (peak 0.95 - a scramble). A
 * symmetric cone would have given 360 degrees of identical slope and made the
 * approach meaningless.
 *
 * `shelfY` is 18 and not the 32 it was first authored at, and the reason is
 * only visible in a probe: the ambient ground on the citadel-facing side is
 * still inside the ring mask's ramp, so it sits 11.7 m BELOW the massif's own
 * base. The approach therefore climbs `shelfY + 11.7`, not `shelfY`, and at 32
 * that measured 0.690 - over the walk limit while the arithmetic said 0.46.
 *
 * Five pinnacles stand on the ramp and the shelf. They are what makes it karst
 * rather than a hill, and each is `1 - smoothstep(0, r, d)`, so each is exactly
 * zero outside its own radius and the massif's AABB is still a true support.
 *
 * The APRON and the PROFILE are two separate terms, and keeping them separate
 * is a measured correction rather than a tidiness: the first cut wrote
 * `lerp(h, KARST_BASE + lift, S)` with the same `S` driving both, which makes
 * the outer ramp carry a `32 * S^2` term whose peak gradient is 1.28 rather
 * than 0.64. The gentle approach was steeper than the walk limit while the
 * arithmetic said it was half of it. Levelling first and adding the profile on
 * top gives the ramp exactly the gradient its own run implies.
 */
const KARST = {
  x: -40, z: -326, reach: 123,
  summitR: 12, summitY: 44, faceRun: 16, shelfY: 18, shelfOut: 44,
  outRun: 30, neckRun: 49, neckAng: Math.atan2(326, 40),
};
/** Pinnacles, authored as (bearing, distance from centre, radius, height). */
const KARST_PINS = [
  { a: 0.40, d: 66, r: 15, h: 14 },
  { a: 2.10, d: 58, r: 13, h: 11 },
  { a: 3.60, d: 72, r: 16, h: 16 },
  { a: 4.90, d: 60, r: 12, h: 10 },
  { a: 5.80, d: 80, r: 14, h: 12 },
].map((p) => ({ x: Math.cos(p.a) * p.d, z: Math.sin(p.a) * p.d, r: p.r, h: p.h }));
const KARST_BASE = baseGround(KARST.x, KARST.z);
function karstShape(h, x, z) {
  const k = KARST;
  const dx = x - k.x;
  if (dx <= -k.reach || dx >= k.reach) return h;
  const dz = z - k.z;
  if (dz <= -k.reach || dz >= k.reach) return h;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d >= k.reach) return h;
  const neck = 0.5 + 0.5 * Math.cos(angGap(Math.atan2(dz, dx), k.neckAng));
  const run = k.outRun + k.neckRun * neck * neck * neck;
  let lift;
  if (d >= k.shelfOut) lift = k.shelfY * smoothstep(k.shelfOut + run, k.shelfOut, d);
  else if (d >= k.summitR + k.faceRun) lift = k.shelfY;
  else if (d >= k.summitR) {
    lift = lerp(k.shelfY, k.summitY, smoothstep(k.summitR + k.faceRun, k.summitR, d));
  } else lift = k.summitY;
  for (let i = 0; i < KARST_PINS.length; i++) {
    const p = KARST_PINS[i];
    const px = dx - p.x;
    const pz = dz - p.z;
    const pd = Math.sqrt(px * px + pz * pz);
    if (pd < p.r) lift += p.h * (1 - smoothstep(0, p.r, pd));
  }
  /* Level the apron toward the massif's OWN ground first - so the summit is an
   * absolute altitude and the shelf is a level shelf rather than whatever the
   * broad relief happens to be doing underneath - and add the profile on top.
   * Both terms are clamping smoothsteps that are exactly 0 at `reach`, so the
   * AABB stays an honest support. */
  return lerp(h, KARST_BASE, smoothstep(k.reach, k.shelfOut, d)) + lift;
}

/**
 * ASHFALL - a rect-topped secondary plateau, ruined, with one approach.
 *
 * The verb is improvisation on broken geometry, so the ground has to be broken
 * before anything is built on it. Two cuts do that: a 7.5 m trench across the
 * top (a collapsed hall, or a fault - either reads) and a 9 m subsided quarter
 * in one corner. Both are gated on `d < 0`, i.e. strictly inside the rectangle,
 * so neither can leak past the plateau's own edge and neither widens the AABB.
 *
 * The fall-off is bearing-modulated like Blackmarch's: 68.0 m of run on the
 * bearing back toward the citadel (peak gradient 0.53, inside the 0.678 walk
 * limit - a cart ramp) and 14.3 m on the other three sides (peak 2.5 - a face).
 * A second citadel wants a perimeter it does not have to defend, and one ramp
 * is how the ground gives it one.
 *
 * Every one of `x`, `hx` and the reach is pinned between two hard walls: the
 * support must clear `|x| = 200` on the inside and `|x| = 450` on the outside,
 * which is 250 m of room for `hx + reach` twice over. 55 + 68 spends it
 * exactly, and that is why the ramp cannot simply be made longer again.
 */
const ASHFALL = {
  x: -325, z: 190, hx: 55, hz: 70, rise: 24,
  flank: 34, neckAng: Math.atan2(-190, 325), neckFloor: 0.42, neckGain: 1.58,
  scarX: 18, scarZ: 0, scarHx: 10, scarHz: 46, scarDrop: 7.5, scarFeather: 6,
  fallX: -22, fallZ: 40, fallHx: 20, fallHz: 18, fallDrop: 9, fallFeather: 8,
};
const ASHFALL_REACH = ASHFALL.flank * (ASHFALL.neckFloor + ASHFALL.neckGain);
const ASHFALL_TOP = baseGround(ASHFALL.x, ASHFALL.z) + ASHFALL.rise;
function ashfallShape(h, x, z) {
  const a = ASHFALL;
  const spanX = a.hx + ASHFALL_REACH;
  const dx = x - a.x;
  if (dx <= -spanX || dx >= spanX) return h;
  const spanZ = a.hz + ASHFALL_REACH;
  const dz = z - a.z;
  if (dz <= -spanZ || dz >= spanZ) return h;
  const d = rectDist(dx, dz, a.hx, a.hz);
  if (d >= ASHFALL_REACH) return h;
  let fl = a.flank;
  if (d > 0) {
    const neck = 0.5 + 0.5 * Math.cos(angGap(Math.atan2(dz, dx), a.neckAng));
    fl = a.flank * (a.neckFloor + a.neckGain * neck * neck * neck);
  }
  h = lerp(h, ASHFALL_TOP, 1 - smoothstep(0, fl, d));
  if (d < 0) {
    const sd = rectDist(dx - a.scarX, dz - a.scarZ, a.scarHx, a.scarHz);
    if (sd < a.scarFeather) h -= a.scarDrop * (1 - smoothstep(0, a.scarFeather, sd));
    const fd = rectDist(dx - a.fallX, dz - a.fallZ, a.fallHx, a.fallHz);
    if (fd < a.fallFeather) h -= a.fallDrop * (1 - smoothstep(0, a.fallFeather, fd));
  }
  return h;
}

/**
 * THE CARAVANSERAI DUNES - crest lines across the south-eastern flats, and one
 * pan flat enough to pitch on.
 *
 * Sand is the one landform that is supposed to read as a field rather than as a
 * place, so this is a wave train rather than a shape: a 78 m crest spacing
 * carried on a 214 m swell, on a bearing of 0.44 rad, with the crest lines bent
 * by a slow perlin term so they are not a corduroy of parallel ruler lines.
 * Squared rather than plain sine, because a real dune is a sharp crest between
 * broad troughs, not a sinusoid.
 *
 * Amplitude is small on purpose. 4.2 m of crest over a 5.4 m swell is scenery a
 * horse crosses without noticing, which is the lesson `CitadelWorld`'s own dune
 * boxes learned the hard way: the first pass built them nearly 6 m tall and the
 * test horse spawned against one and could not move at all.
 *
 * The window is four clamping `smoothstep`s, so the field is exactly zero at and
 * outside the declared box - an exponential falloff would have made "the AABB is
 * the support" a lie.
 *
 * `x1` and `z1` are `HALF` and are written as `HALF`. They were the literal
 * `450`, which MEANT the playfield rim and did not follow it: grow `HALF` and
 * the AABB assertion in `citadel-height.test.mjs` still passes (`a.x1 <= HALF`
 * is only tighter), while the dune field silently stops short of the new rim
 * and leaves a quarter of the map as the dead-flat `y = 0` sand this whole
 * phase exists to remove. Only the shrinking direction was ever covered.
 */
const DUNES = {
  x0: 232, z0: 150, x1: HALF, z1: HALF, feather: 42,
  ang: 0.44, wave: 78, amp: 4.2, swell: 214, swellAmp: 5.4, wander: 26,
  panX: 342, panZ: 296, panR: 30, panFeather: 16, panGrip: 0.94,
};
const DUNE_CA = Math.cos(DUNES.ang);
const DUNE_SA = Math.sin(DUNES.ang);
function duneLift(x, z) {
  const D = DUNES;
  const u = x * DUNE_CA + z * DUNE_SA + perlin2(x * 0.004, z * 0.004) * D.wander;
  const c = 0.5 + 0.5 * Math.sin(u * (TAU / D.wave));
  return c * c * D.amp + (0.5 + 0.5 * Math.sin(u * (TAU / D.swell) + 1.3)) * D.swellAmp;
}
const DUNE_PAN_Y = baseGround(DUNES.panX, DUNES.panZ) + duneLift(DUNES.panX, DUNES.panZ);
function duneShape(h, x, z) {
  const D = DUNES;
  const w = smoothstep(D.x0, D.x0 + D.feather, x) * smoothstep(D.x1, D.x1 - D.feather, x)
    * smoothstep(D.z0, D.z0 + D.feather, z) * smoothstep(D.z1, D.z1 - D.feather, z);
  if (w <= 0) return h;
  h += duneLift(x, z) * w;
  const px = x - D.panX;
  const pz = z - D.panZ;
  const pd = Math.sqrt(px * px + pz * pz);
  if (pd < D.panR + D.panFeather) {
    h = lerp(h, DUNE_PAN_Y, (1 - smoothstep(D.panR, D.panR + D.panFeather, pd)) * D.panGrip);
  }
  return h;
}

/**
 * The landform table, for the phases that place things on this ground.
 *
 * `site` is where a district wants to stand; `aabb` is the SUPPORT of the
 * landform - outside it the contribution is identically zero, not merely small.
 * Both halves are pinned by test: that the shape really is zero outside the box,
 * that the box really is disjoint from the protected square, and that
 * `outerRing` gates on THESE boxes rather than on a second copy of the numbers.
 *
 * The five supports are also pairwise disjoint, which is what makes the order
 * they are applied in irrelevant. That is asserted rather than assumed.
 */
export const CITADEL_LANDFORMS = [
  {
    id: 'undercliff-terraces',
    name: 'The Undercliff',
    kind: 'terraced-shelf',
    site: { x: 0, z: 303 },
    district: 'Undercliff lower town',
    aabb: {
      x0: -UNDERCLIFF_REACH * Math.sin(UNDERCLIFF_SPAN),
      z0: UNDERCLIFF.foot * Math.cos(UNDERCLIFF_SPAN),
      x1: UNDERCLIFF_REACH * Math.sin(UNDERCLIFF_SPAN),
      z1: UNDERCLIFF_REACH,
    },
  },
  {
    id: 'quarry-deepworks',
    name: 'The Quarry & Deepworks',
    kind: 'benched-pit',
    site: { x: 325, z: -96 },
    district: 'Deepworks',
    aabb: {
      x0: QUARRY.x - QUARRY.reach, z0: QUARRY.z - QUARRY.reach,
      x1: QUARRY.x + QUARRY.reach, z1: QUARRY.z + QUARRY.reach,
    },
  },
  {
    id: 'karst-massif',
    name: 'Karst Massif & the Eyrie',
    kind: 'massif',
    site: { x: -40, z: -326 },
    district: 'the Eyrie',
    aabb: {
      x0: KARST.x - KARST.reach, z0: KARST.z - KARST.reach,
      x1: KARST.x + KARST.reach, z1: KARST.z + KARST.reach,
    },
  },
  {
    id: 'ashfall-plateau',
    name: 'Ashfall',
    kind: 'plateau',
    site: { x: -362, z: 190 },
    district: 'Ashfall ruins',
    aabb: {
      x0: ASHFALL.x - ASHFALL.hx - ASHFALL_REACH,
      z0: ASHFALL.z - ASHFALL.hz - ASHFALL_REACH,
      x1: ASHFALL.x + ASHFALL.hx + ASHFALL_REACH,
      z1: ASHFALL.z + ASHFALL.hz + ASHFALL_REACH,
    },
  },
  {
    id: 'caravanserai-dunes',
    name: 'Caravanserai Dunes',
    kind: 'dune-field',
    site: { x: 342, z: 296 },
    district: 'Caravanserai',
    aabb: { x0: DUNES.x0, z0: DUNES.z0, x1: DUNES.x1, z1: DUNES.z1 },
  },
];

/**
 * Every authored contribution to the outer ring, in one place.
 *
 * The gate is the EXPORTED aabb, not a copy of it. That is what makes "no
 * landform reaches into the old playfield" a property of this loop rather than
 * of five separate early-outs that a later edit could widen one of. The shapes
 * keep their own radial reach tests underneath - those are the fast path, and
 * they are strictly tighter than the box.
 */
const RING_SHAPES = [
  { aabb: CITADEL_LANDFORMS[0].aabb, apply: (h, x, z) => h + undercliffLift(x, z) },
  { aabb: CITADEL_LANDFORMS[1].aabb, apply: quarryShape },
  { aabb: CITADEL_LANDFORMS[2].aabb, apply: karstShape },
  { aabb: CITADEL_LANDFORMS[3].aabb, apply: ashfallShape },
  { aabb: CITADEL_LANDFORMS[4].aabb, apply: duneShape },
];
function outerRing(h, x, z) {
  for (let i = 0; i < RING_SHAPES.length; i++) {
    const sh = RING_SHAPES[i];
    const a = sh.aabb;
    if (x < a.x0 || x > a.x1 || z < a.z0 || z > a.z1) continue;
    h = sh.apply(h, x, z);
  }
  return h;
}

/**
 * Everything this phase added, as a term to be summed onto the old ground.
 *
 * Exactly `0` - the literal, returned on its own branch - anywhere in the
 * original 400 m square, which is why `citadelHeight` is bit-identical in
 * there: `v + 0 === v` for every double this function can produce. The early
 * return is redundant with `ringMask` being exactly zero at `INNER_KEEP`, and
 * that redundancy is the point: it makes bit-identity a structural property of
 * this file rather than a numerical coincidence to be re-derived every time
 * somebody edits a landform, and it is also the fast path that keeps sampling
 * cheap - inside the square this phase costs one comparison.
 *
 * Exported so the test can assert the zero DIRECTLY, rather than inferring it
 * from a digest that would also pass if two errors cancelled.
 */
export function ringRelief(x, z) {
  const ax = x < 0 ? -x : x;
  const az = z < 0 ? -z : z;
  if ((ax > az ? ax : az) <= INNER_KEEP) return 0;
  return outerRing(broadRelief(x, z) * ringMask(x, z), x, z);
}

/** The ground, addressed the way every other world's is. */
export function citadelHeight(x, z) {
  return terrainH(Math.hypot(x, z)) + ringRelief(x, z);
}
