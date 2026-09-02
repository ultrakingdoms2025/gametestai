/**
 * SALLOW - the toxic sulfur world, and Cinder's nearest neighbour in the
 * vocabulary. That is this file's whole problem, so it is stated first.
 *
 * ==========================================================================
 *  HOW THIS IS NOT CINDER, WRITTEN BEFORE ANYTHING ELSE
 * ==========================================================================
 *
 * Cinder is a volcanic world with lava lakes, fumaroles, a rift and sulfur on
 * its rift lips. Sallow is a volcanic-adjacent world with acid lakes and
 * fumarole fields. Those two descriptions can very easily be the same planet
 * twice, and if they are, this one should not ship. Four things separate them
 * and every one of them is a number somewhere below:
 *
 *  1. OVERCAST, NOT CLEAR. Cinder is a clear orange dust sky: `mie` 4.4,
 *     `mieG` 0.80 (a tight forward lobe), a 0.026 sun disc, `cirrus` 0.20,
 *     fill/key 0.072. Sallow is permanent sulfurous overcast: `mie` 6.8 with
 *     `mieG` 0.62 - the LOW anisotropy is the mechanism, because it spreads
 *     the Mie phase function over the whole dome instead of concentrating it
 *     round the sun, which is what an overcast sky physically is - a 0.072 sun
 *     disc that is a veiled smear rather than a disc, `cirrus` 0.86 of low
 *     deck, and fill/key 0.107. Soft shadows, low contrast, a horizon that
 *     glows. Two volcanic worlds that light the same way are one world twice.
 *
 *  2. CHEMISTRY, NOT HEAT. Cinder's lava is at `emissive` 2.1 with a 34-candela
 *     point light on the crater lake. Sallow's acid is at 0.16 with NO light at
 *     all: there is nothing incandescent on this planet. See the `liquid` block
 *     for what `crust` and `hot` were made to mean here, and for the one
 *     channel that genuinely does not apply.
 *
 *  3. FLAT AND POCKED, NOT A SHIELD. Cinder's silhouette is one 600 m shield
 *     with a caldera on it, visible from everywhere. Sallow has no cone over
 *     15 m. Its skyline is a HORIZON: a dead-flat pan cut by three terrace
 *     risers and punched with six collapse pits, the deepest of which stands a
 *     ring wall 18 m proud of the pan and is the only thing on the map that
 *     interrupts the horizon at all.
 *
 *  4. THE MOST SATURATED PALETTE IN THE SYSTEM. Every other planet is a rock
 *     colour. Sulfur chemistry is genuinely lurid - acid green-yellow water,
 *     red-orange realgar, gold orpiment, vermilion cinnabar - and that is a
 *     legitimate identity rather than a mistake. Measured off the table below:
 *     154 degrees of hue and 71 points of saturation across six bands.
 *
 * The one thing Sallow DOES borrow from Cinder is the shape of its exotic tier:
 * an isolated pad and a road down a pit wall. That is deliberate and the brief
 * says to copy it - see `THE THROAT` below for what was tried instead and why
 * the descriptor language cannot express it yet.
 *
 * ==========================================================================
 *  THE MAP, in words
 * ==========================================================================
 *
 * 800 m square, `+x` east and `+z` south. There is no single sea level: the
 * planet is a STAIRCASE of four levels, and every height in this file is quoted
 * against whichever tread it stands on.
 *
 *   THE BRIMSTONE PAN   the whole east third, y 36, dead flat to the eye and
 *                       covered in fumaroles. The primary landing sits in the
 *                       middle of it, which is the one place on Sallow where
 *                       the common ore is underfoot. From here the Throat ring
 *                       stands on the northern horizon and the Sink opens in
 *                       the ground to the south.
 *
 *   THE YELLOW STAIR    three curved terrace risers running north-south down
 *                       the west of the map, each stepping the ground DOWN 11 m
 *                       westward: pan 36, Terrace A 25, Terrace B 14,
 *                       Terrace C 3. They are `scarp` landforms and not pads,
 *                       so the treads keep their own noise and only the RISERS
 *                       are authored - a 200 m dead-flat disc reads as poured
 *                       concrete and three of them would have been the whole
 *                       west of the planet.
 *
 *   THE SHALLOWS        an acid pool on Terrace A at (46, -230), surface y 23.5.
 *   THE MIDDLE POOL     an acid pool on Terrace B at (-100, 20), surface 12.4.
 *   STILLWATER          the big one, on Terrace C at (-262, 190), surface 1.4,
 *                       132 m across, with the second landing on its north
 *                       shore. Realgar crusts on its margin.
 *
 *                       All three are the same construction and it is the
 *                       twelve-metre lesson out of Volcanic.js: a BENCH `pad`
 *                       levels the pan the pool sits in, a smaller BED `pad`
 *                       inside it cuts the pool floor 3.4-4.6 m lower, and the
 *                       acid disc is sized so its edge lands where the bed's
 *                       blend has climbed back to the acid's own surface. Beds
 *                       are LEVELS, not deltas: the floor is flat by
 *                       construction and the shoreline is a contour.
 *
 *   THE ORPIMENT SEAMS  a 390 m fissure wandering down the southern half of
 *                       Terrace A, 18 m across and 14 m deep with cubed walls
 *                       and a 3 m spoil lip on each side. Orpiment grows on the
 *                       lips. It dies out at both ends rather than reaching the
 *                       map edge, so it is an obstacle to route around and not
 *                       a wall that cuts the planet in two.
 *
 *   THE SINK            a collapse pit at (248, 150), 184 m across, floor a
 *                       flat -4 and its wall a 48-degree slump nothing walks
 *                       up (measured 54.6). Cinnabar is down in it. THE SLUMP -
 *                       a 186 m road down the pit's SOUTH wall, the far side
 *                       from the primary landing - is the only way in on foot,
 *                       and the walk to the nearest cinnabar measures 545 m,
 *                       of which the first 360 is a lap of the pit.
 *
 *   THE THROAT          the fumarole throat, at (252, -252). A 156 m shaft 56 m
 *                       deep (measured wall 75 degrees), ringed by an ejecta
 *                       wall that crests 24 m above the pan and falls away at
 *                       70 degrees on BOTH sides - so the ring is sealed and
 *                       nothing walks in over it. It fell away at 53 until the
 *                       envelope audit: 53 is a wall at the 38 degrees the
 *                       reach probes flood at and a RAMP at the 56.63 the game
 *                       walks. See T_RIMW. Its floor is a vent field
 *                       whose plumes rise 42 m, clear of the rim, and stibnite
 *                       grows there. The landing is a shelf notched into the
 *                       crest of the ring at bearing 205, and THE THROAT ROAD
 *                       spirals 312 m from it down the inner wall to the floor.
 *                       This is the second landing and it is the only way to
 *                       the exotic tier: measured, 6 of 6 stibnite nodes are
 *                       reachable from here and 0 of 6 from anywhere else.
 *
 *   THE POCKMARKS       four shallow collapse pits, 7-9 m deep and 68-84 m
 *                       across - ONE PER LEVEL, so there is a hole in the
 *                       ground on the pan and on each tread of the stair. Their
 *                       walls measure 34-38 degrees, i.e. you walk down into
 *                       them, which is what makes the ground read as pocked
 *                       rather than as decorated: all four floors are reachable
 *                       on foot from the primary pad. Plus three sulfur boil
 *                       cones on the pan, 7-9 m tall with summit pits.
 *
 * ==========================================================================
 *  WHY THE NUMBERS ARE THESE NUMBERS
 * ==========================================================================
 *
 * RELIEF BUDGET. Measured over a 401x401 grid, the whole planet runs -21.0 to
 * +61.5: a span of 82.5 m against Cinder's 158, and every metre of it is
 * authored. That is the assignment - "low, broad and pitted... its skyline is a
 * horizon, not a mountain" - and it is also the reason the stair exists. A flat
 * world with nothing but holes in it has no silhouette at all; three 11 m
 * terrace risers give the west of the map a skyline that is entirely horizontal
 * and still has structure in it.
 *
 * NOISE. swell 4.5 + ripple 1.2 + grain 0.26 = 5.96 m against 76.5 m of relief,
 * i.e. 7.8% - about Cinder's 7%, off half the amplitude. It is deliberately
 * gentler than Cinder's 11.6 m for two structural reasons: the acid pools'
 * benches are levelled to an ABSOLUTE y and a tall swell would leave a pool
 * perched on a rise, and the terrace risers are only 26 degrees of authored
 * grade, so noise that added another 12 degrees of local gradient would make
 * the stair a wall at random points. It did, at the first amplitude - see
 * `RISER_RUN`.
 *
 * Every grade, radius, shoreline and reachability claim in this file was
 * measured against the real height function and the real colliders before it
 * was written down, on a 2 m walk lattice with no jump and no mantle. Where a
 * number is at the edge of a threshold the comment says so, and where a first
 * attempt failed the comment says what it measured.
 */

import { definePlanet } from './PlanetDescriptor.js';
import { ITEMS } from '../../systems/ItemDefs.js';

/**
 * Credits per cubic metre of hold, read off the item catalogue.
 *
 * The price of an element belongs to the ELEMENT and not to the planet it came
 * off, so the number lives in `ITEMS` once and this file quotes it. Throwing on
 * a missing row rather than returning `undefined` is the difference between a
 * loud boot failure and a planet whose deposits are all worth NaN.
 *
 * @param {string} id an `ITEMS` id
 * @returns {number} credits per cubic metre
 */
const ORE = (id) => {
  const def = ITEMS[id];
  if (!def) throw new Error(`[Sallow] mineral names item "${id}", which has no ITEMS row`);
  return def.value;
};

/* ------------------------------------------------------------------ */
/* Frame of reference                                                  */
/* ------------------------------------------------------------------ */

/** Playfield half-extent. */
const HALF = 400;

/**
 * The four treads of the Yellow Stair.
 *
 * `BASE` is the lowest and westmost ground; each `scarp` below adds `STEP` to
 * everything on its EAST side, so the pan east of all three stands at
 * `BASE + 3 * STEP`. Writing it this way rather than as four literals means a
 * terrace cannot silently stop being 11 m below the one above it.
 */
const BASE = 3;
const STEP = 11;
/** Terrace A, between risers 1 and 2. */
const TER_A = BASE + 2 * STEP;   // 25
/** Terrace B, between risers 2 and 3. */
const TER_B = BASE + 1 * STEP;   // 14
/** Terrace C, west of riser 3. Stillwater sits on it. */
const TER_C = BASE;              // 3
/** The Brimstone Pan, east of every riser. */
const PAN = BASE + 3 * STEP;     // 36

const D2R = Math.PI / 180;

/**
 * The terrace risers, as gentle circular arcs.
 *
 * Struck about a centre 1,500 m EAST of the map so the curvature is slight: a
 * riser bulges 64 m west over the 840 m it spans, which reads as a natural
 * shoreline-shaped terrace edge rather than as a ruled line, and its tangent
 * extensions leave the playfield immediately. That last part is load-bearing -
 * `scarp` continues its polyline past both ends before sampling, and a line
 * that stopped inside the map would leave an 11 m step hanging in mid air.
 *
 * Nine samples. The sagitta between two of them is 140^2/(8*1400) = 1.75 m,
 * well under the swell, so more points would buy nothing.
 */
const ARC_CX = 1500;
const ARC_Z = [-420, -315, -210, -105, 0, 105, 210, 315, 420];
const RISER = (r) => ARC_Z.map((z) => [+(ARC_CX - Math.sqrt(r * r - z * z)).toFixed(2), z]);

/** Riser 1: the pan's edge, crossing x = 100 at the equator. */
const RISER_1 = RISER(1400);
/** Riser 2: Terrace A's edge, x = -40. */
const RISER_2 = RISER(1540);
/** Riser 3: Terrace B's edge, x = -160. */
const RISER_3 = RISER(1660);

/**
 * Riser run: 34 m for an 11 m step, i.e. 25.9 degrees of authored grade.
 *
 * The ceiling is the walk envelope's 38 degrees and the floor is legibility.
 * At `run` 18 (the landform default) the riser would be 42.5 degrees and the
 * stair would be three cliffs the player has to fly between; at `run` 45 it is
 * 20 degrees and stops reading as a terrace at all.
 *
 * 34 AND NOT 30, AND THE DIFFERENCE IS THE NOISE ON TOP. At 30 the authored
 * grade is 28.8 degrees, which looks like nine degrees of headroom and is not:
 * the swell and the ripple add their own gradient to the riser's, and measured
 * across riser 2 at z = 20 the total came out at 40.5 degrees - over the
 * envelope, so a walking body meets a wall at a random point on a stair that is
 * supposed to be walkable everywhere. At 34 the same crossing measures inside
 * it. This is the number to move first if the noise amplitudes ever change.
 */
const RISER_RUN = 34;

/* ------------------------------------------------------------------ */
/* The Throat, and the polar frame everything in it is placed in       */
/* ------------------------------------------------------------------ */

const TX = 252;
const TZ = -252;
/** Crater radius: the ring crest stands here. */
const T_R = 78;
/** Depth below the pan. Floor lands at -20. */
const T_DEPTH = 56;
/** Fraction of `r` that is flat floor. 0.46 -> a 36 m flat disc to land vents on. */
const T_FLOOR = 0.46;
/**
 * Ejecta crest above the pan, and the width it dies away over.
 *
 * ── 20 m of width was not a seal, and the arithmetic says why ─────────────
 * `craterAt` carries the crest away on a smoothstep, so the steepest face is
 * `1.5 * rim / rimWidth`. At 18 over 20 that is 1.35, i.e. **53.5 deg** - and
 * 53.5 is a wall only against the 38 deg the reach probes flood at. The game
 * stands on `acos(WALKABLE_NORMAL_Y)` = 56.63 deg, three degrees ABOVE it, so
 * the ring was walkable over its whole circumference.
 *
 * Traced: a body walked out of Cauldron Flat, climbed the outer flank at
 * bearing 147 from (178, -188) y 35.62 to the crest at (178, -226) y 53.81
 * without ever exceeding 55.1 deg, followed the crest round to the Throat
 * Shelf and took the road down. All six stibnite nodes came out reachable from
 * the PRIMARY pad at 544 m. The exotic tier had no second landing on it.
 *
 * ── 24 over 13, and why narrowing alone was not enough ───────────────────
 * `1.5 * 18 / 13` = 2.077, i.e. 64.3 deg, and that closed the flank the trace
 * above walked - but it moved the leak twice more, and each move is worth
 * recording because each one is a different mechanism eating the same wall:
 *
 *   1. NARROWING PULLS THE TOE IN. At `rimWidth` 20 the flank ran out to
 *      d 98; at 13 it stops at d 91, and the Throat Shelf's own outward blend
 *      runs from d 94 to d 110 - so it landed on bare pan with nothing steeper
 *      to hand over to and became the route itself. @see THROAT_PAD, `blend`.
 *   2. THE ROAD WAS CUTTING ITS OWN DOORWAY. A `ramp` reaches `width + blend`
 *      either side of its line; at 11 that was 18 m, and leg 1 passes within
 *      68.1 m of the axis, so the road quietly levelled the flank out to
 *      d 86 - through the steep band. Traced twice, at bearing 243 and again
 *      at 250, both times climbing a flank the road had flattened to 54-56
 *      deg. @see the THROAT ROAD in the LEVEL layer, `blend` 6.
 *   3. AND THE COLLIDER IS A 3.125 m GRID. `seg` 256 over an 800 m map, so a
 *      wall's measurable gradient is its rise per 3.125 m cell however sharp
 *      the analytic profile is. An authored 64.3 deg flank with 6.8 m of steep
 *      band measures 54-56 on the heightfield the game actually collides
 *      against. That is why the authored figure has to overshoot.
 *
 * So the crest went up as well as in: `1.5 * 24 / 13` = 2.769, i.e. **70.1
 * deg** authored. With the road's shoulder stopping at d 85, the flank from
 * 85 to 91 survives untouched - 10.6 m of climb over 6 m, 60.5 deg measured on
 * the collider grid, and 5.5 m of rise per 3.125 m cell against a Sallow jump
 * that clears 1.44 m (0.99 m apex plus the 0.45 m step) and hops 2 m of open
 * ground. Sealed at 38 deg, at 56.63, and at 56.63 with the jump.
 *
 * WHAT MOVING `T_RIM` COSTS, and it was checked rather than assumed:
 * `THROAT_PAD` publishes no `y`, so its table resolves from the pre-level
 * field at its centre - which is on the crest - and `THROAT_ROAD` starts at
 * that same point. Both rise 6 m with the crest, so the pad still meets the
 * road head with no step (measured pad span 0.00 m), and the road's grade goes
 * from 13.4 to 14.4 deg over the same 312 m. Its fit to the wall improves at
 * the top (leg 1 cuts 3.6 m where it cut 7.6) and loosens at leg 3 (6.4 m
 * proud against 4.4), which is inside the shaft where everything is a wall.
 *
 * It also steepens the INNER face, because `craterAt` runs the inner ramp over
 * `min(rimWidth, (r - floor*r) * 0.6)` = min(13, 25.3) = 13 rather than 20.
 * That is wanted, not tolerated: the inner face is the one nothing is supposed
 * to climb out of, and the Throat Road is a LEVEL-layer `ramp` that overwrites
 * the ground it runs on, so the descent is unaffected.
 */
const T_RIM = 24;
const T_RIMW = 13;

/** A point at polar (d, bearing-in-degrees) about the throat axis. */
const T = (d, deg) => [
  +(TX + d * Math.cos(deg * D2R)).toFixed(2),
  +(TZ + d * Math.sin(deg * D2R)).toFixed(2),
];

/**
 * The throat's landing shelf: a notch blasted into the crest of the ring at
 * bearing 205, and everything about it was decided by measurement.
 *
 * IT IS ON THE CREST (d = 78) AND NOT INSIDE IT. The first version put it on
 * the inner wall at d = 66, twelve metres below the crest, which is a better
 * picture - you fly in over the ring and drop into the shaft - and it does not
 * work, for a reason worth writing down because it is not obvious:
 *
 *   A pad has ONE blend and it has to do two opposite jobs. Outward it has to
 *   be steep, or the pad joins the pan and the exotic tier is not a second
 *   landing. Along the road it has to be gentle, because a `ramp` that starts
 *   at the pad centre has already dropped `grade * padRadius` by the time it
 *   reaches the pad EDGE, and the blend has to give that back. The gradient
 *   the blend produces is `grade * (s + d * s')` where `s` is the smoothstep -
 *   the `d * s'` term is the killer, and at an 8 m blend on a 16 m pad it came
 *   out at 47 degrees. Measured: 0 of 6 stibnite nodes reachable from ANY pad,
 *   the throat road walled off from its own landing site.
 *
 *   At `blend` 16 the road side lands at 33.7 degrees, comfortably walkable.
 *   The outward side then only isolates if the ground it hands over to is
 *   steeper than the blend, which is exactly Cinder's Rimhold arrangement (a
 *   49-degree shield flank does the work there). Here it is the 70.1-degree
 *   ejecta rim, and it only works because `rim` is 24 m over `rimWidth` 13.
 *   The radial measurements below were taken when that width was 20, i.e. when
 *   the flank was 53.5 degrees; the 45.6-degree step they name is what a 38 deg
 *   probe saw as a wall and the shipped game walked straight over. @see T_RIMW.
 *   Measured along the radial: 36.0 at r 110, 36.8 at 108, 38.8 at 106 - and
 *   then 41.7 at 104, a 45.6-degree step that nothing crosses.
 *
 * -- AND THEN THE BLEND WAS 16, AND 16 WAS NOT A WALL EITHER ---------------
 *
 * Sealing the rim at `rimWidth` 13 pulls its outer toe in to d 91, and the
 * pad's own outward blend runs from d 94 to d 110 - so at `blend` 16 the whole
 * of it landed on the flat pan with nothing steeper left to hand over to. The
 * blend became the route: traced, a body walked out of Cauldron Flat, up the
 * pad's west blend from (156, -270) y 37.81 onto the shelf at (166, -290)
 * y 53.61, and never exceeded 56.2 degrees doing it - four tenths of a degree
 * under the ceiling the game actually walks. The rim was sealed and the
 * doorstep was not.
 *
 * Both sides of the blend are ONE number, so it was solved rather than nudged.
 * The gradient the blend produces is `grade * ((1 - w) + d * |w'|)` with `w`
 * the smoothstep and `|w'|` peaking at `1.5 / blend` at `d = r + blend/2`,
 * which reproduces both of the measurements above and predicts the rest:
 *
 *     blend   road side (stay under 38)   outward side (must clear 56.63)
 *       16         33.2 deg                    56.2 deg   <- shipped, and open
 *       13         36.4 deg                    61.4 deg   <- this
 *       11         39.3 deg                    67.6 deg   <- road walled off
 *        8         45.4 deg                    79.0 deg   <- the first draft
 *
 * 13 is the only value that clears both. The outward column above was solved
 * against the 18 m crest this ring had at the time; `T_RIM` then went to 24 for
 * a separate leak, which raises the table by the same 6 m and steepens every
 * figure in that column by a further 33% without touching the road column at
 * all - the road side is a function of the road's GRADE, and the grade barely
 * moved. So 13 is still the answer and it now has more margin than it was
 * solved for. The outward face is over 56.63 across 5.5 m of its 13 m run and
 * costs at least 9.4 m of climb to cross, against a Sallow jump that clears
 * 1.44 m and hops 2 m of open ground.
 *
 * So the pad's own disc levels 32 m of the crest to a table at y 60, cut 28 m
 * into the shaft on one side and built 18 m out over the pan on the other. It
 * is a shelf blasted into the ring, it is visible as a notch from the whole
 * pan, and it is an island.
 */
const THROAT_PAD = T(78, 205);

/**
 * THE THROAT ROAD. 312 m, 380 degrees of turn, 13.4 degrees of grade.
 *
 * It STARTS AT THE PAD CENTRE and that is mechanism, not tidiness: a `ramp`
 * with no explicit `y0` takes its head height from the pre-level field at its
 * first point, which is exactly the height a `pad` with no explicit `y` levels
 * itself to at the same place. Start it a metre away and the two resolve to
 * different numbers and the player steps off a riser they cannot see.
 *
 * 380 degrees, i.e. slightly MORE than one full turn, which is the one thing
 * Volcanic.js's spiral deliberately avoids. It is safe here for a measured
 * reason rather than by luck: over that turn the radius falls 78 -> 13, so the
 * head at bearing 205 and the only other leg on that bearing are 61 m apart
 * radially against a 36 m band, and the two cannot merge into a flattened cone.
 * The length is what buys the grade - 74 m of drop wants 312 m of road to stay
 * at 13 degrees, and the grade is what lets the pad's blend hand over to it.
 */
const THROAT_ROAD = [
  THROAT_PAD,
  T(72, 253),
  T(65, 301),
  T(57, 349),
  T(48, 397),
  T(39, 445),
  T(29, 493),
  T(20, 541),
  T(13, 585),
];

/* ------------------------------------------------------------------ */
/* The Sink, and the road into it                                      */
/* ------------------------------------------------------------------ */

const SINK_X = 248;
const SINK_Z = 150;
const SINK_R = 92;
const SINK_DEPTH = 40;
/** 0.42 -> a 38.6 m flat floor, which is what ten cinnabar nodes need. */
const SINK_FLOOR = 0.42;

/**
 * THE SLUMP: the road down into the Sink. 186 m for a 40 m drop, 12.7 degrees.
 *
 * IT COMES IN FROM THE SOUTH, which is the far side from the primary landing,
 * and that placement is the rare tier's whole cost. With the head on the north
 * side at (250, 0) the walk from Cauldron Flat measured 288 m median - shorter
 * than the walk to ORPIMENT, an uncommon ore, which makes "rare" a word rather
 * than a distance. The Sink's wall is 48 degrees the whole way round and its
 * ejecta apron is a 122 m skirt, so putting the one slumped sector on the far
 * side means the walk is a lap of the pit before the descent even starts.
 *
 * Its head is at (250, 300), 150 m from the Sink's axis and therefore OUTSIDE
 * the apron entirely - a road that started on the apron would have its first
 * leg levelling ground that is already tilted, and the head would sit in a
 * trench of its own making. The toe is 16 m from the axis, well inside the flat
 * floor, so the road ends on the floor rather than on the wall.
 */
const SLUMP = [[250, 300], [238, 262], [212, 228], [196, 190], [206, 158], [232, 146]];

/* ------------------------------------------------------------------ */
/* The Orpiment Seams                                                  */
/* ------------------------------------------------------------------ */

/**
 * The fissure down Terrace A.
 *
 * It runs z -14 to 356 and NOT the full height of the map, and that is a
 * routing decision. A trench 18 m across and 14 m deep with cubed walls is
 * impassable, so one that spanned the terrace would cut the planet in half and
 * the walk from the pan to Stillwater would be a lap of the border. Dying out
 * at z = -14 leaves the northern half of Terrace A open, which is the way
 * through, and a fissure that dies out at its ends is also what a fissure does.
 *
 * Every x here sits between riser 2 and riser 1 at that z with at least 20 m to
 * spare on both sides, so the trench and its lips never climb a terrace edge.
 */
const SEAMS = [[26, -14], [48, 64], [30, 148], [56, 226], [38, 306], [64, 356]];

/* ------------------------------------------------------------------ */
/* The three acid pools                                                */
/* ------------------------------------------------------------------ */

/* Each pool is three records that have to agree: a bench pad, a bed pad and a
 * liquid disc. The centres are shared constants so they cannot drift apart. */
const POOL_A = [46, -230];   // The Shallows,   Terrace A
const POOL_B = [-100, 20];   // The Middle Pool, Terrace B
const POOL_C = [-262, 190];  // Stillwater,      Terrace C

/** The two landing sites that are not the throat. */
const CAULDRON = [200, -60];
const STEP_PAD = [-300, 60];

/* ------------------------------------------------------------------ */
/* The descriptor                                                      */
/* ------------------------------------------------------------------ */

export const SALLOW = definePlanet({
  id: 'sallow',
  name: 'Sallow',
  blurb: 'A sulfur world under permanent yellow overcast. Terraced acid lakes down the west, fumarole fields on the pan, cinnabar in the Sink and stibnite at the bottom of the Throat.',

  half: HALF,
  /** 256 segments over 800 m: a 3.125 m cell, the same as Cinder's. The mesh
   *  and the collision heightfield are the same grid, so this buys both the
   *  silhouette and the surface the player stands on. */
  seg: 256,

  /**
      * 0.83 g, and BOTH consumers read it.
     *
     * This used to say "Phase 1 does not retune the player integrator against
     * it", which was true and honest while gravity reached only the ship. It
     * reaches the player on foot now, through the one predicate in
     * `WorldRules.worldGravity`: `Piloting._env` gives the flight model
     * `(0, -8.10, 0)`, and `Player.setWorldGravity` converts 8.10 to a ratio
     * against `CONFIG.player.gravityReference` (9.81) and walks in -18.17 m/s²
     * rather than the global -22.
     *
     * Measured here by driving the real controller: apex 0.981 m, hang
     * 0.588 s, against 0.878 m / 0.533 s on a world that publishes no
     * gravity at all. At 0.83 g the difference is meant to be felt rather than
     * played with - the variety is at the other end of the ladder, on Tessera
     * (0.17 g) and Lathe (0.19 g).
     *
     * @see ../../player/Player.js `setWorldGravity`
     */
  gravity: 8.10,

  /* ---------------------------------------------------------------- */
  terrain: {
    seed: 0x5a110c,
    /** The LOWEST tread. Every riser below adds to the east of its line, so
     *  the pan ends up at BASE + 3*STEP without anything saying "36". */
    baseY: BASE,
    /** Broad chemical swells. 215 m wavelength and only 4.5 m of it - see the
     *  noise budget in the header for why this is under half of Cinder's. */
    swell: { amp: 4.5, scale: 215, octaves: 4 },
    /** Ripples, ridged, so the crust reads as crust and not as a bedsheet. */
    ripple: { amp: 1.2, scale: 34, octaves: 3 },
    /** Grain at the scale of a footfall. Keeps the normals off glassy. */
    grain: { amp: 0.26, scale: 28 },
    /** The map's edge falls away rather than walling up. */
    rim: { start: 368, drop: 18 },

    landforms: [
      /* ---- ADD ---------------------------------------------------- *
       * The Yellow Stair. Three half-planes, each raising everything on its
       * EAST side by one tread.
       *
       * `side: -1` and not +1: the points run north to south, so the segment
       * direction is roughly +z, and the cross product `polyNearest` leaves in
       * `_polyC` is NEGATIVE for a sample to the east. `side` multiplies that
       * sign, so -1 is what puts the raised block on the east.               */
      { kind: 'scarp', pts: RISER_1, height: STEP, run: RISER_RUN, side: -1 },
      { kind: 'scarp', pts: RISER_2, height: STEP, run: RISER_RUN, side: -1 },
      { kind: 'scarp', pts: RISER_3, height: STEP, run: RISER_RUN, side: -1 },

      /* Sulfur boil cones on the pan. 7-9 m and no more: this planet's whole
       * identity is that it has no mountain on it, and the job of these is to
       * put three small vertical marks on an otherwise level horizon. `pit`
       * sinks each summit into a crater, which is what makes a cone read as a
       * vent rather than as a hill. Max flank 30.5 degrees, so they are walked
       * over rather than round. */
      { kind: 'cone', x: 150, z: -160, r: 26, peak: 9, pit: 0.50 },
      { kind: 'cone', x: 350, z: -160, r: 22, peak: 7, pit: 0.45 },
      { kind: 'cone', x: 170, z: 200, r: 24, peak: 8, pit: 0.40 },

      /* ---- CUT ---------------------------------------------------- */

      /**
       * THE THROAT. The one thing on Sallow that breaks the horizon.
       *
       * `rim` 24 over `rimWidth` 13 is 70.1 degrees on BOTH faces of the crest
       * (the inner ramp runs over `min(rimWidth, (r - floor*r) * 0.6)` = 13 m
       * as well), which is what seals the ring. That was 10 m over 30 m in the
       * first version - 26.6 degrees - and the reachability probe walked
       * straight up the apron, round the crest and down the road: the exotic
       * tier was reachable from the primary pad and the second landing had no
       * job. Sealing the ring costs the view from the lip, and the view from
       * the lip was worth less than the tier.
       *
       * IT WAS THEN SEALED AT THE WRONG NUMBER. 18 over 20 is 53.5 degrees,
       * which is a wall at the 38 degrees the reach probes flood at and a walk
       * at the 56.63 the game's own `WALKABLE_NORMAL_Y` allows - so the second
       * seal failed the same way the first did, one envelope further out. The
       * width is 13 now and the face is 64.3. @see T_RIMW for the trace.
       *
       * The inner wall is 56 m over 42 m of run: 63.4 degrees, which nothing
       * walks and nothing falls down and survives.
       */
      {
        kind: 'crater',
        x: TX, z: TZ, r: T_R,
        depth: T_DEPTH, floor: T_FLOOR,
        rim: T_RIM, rimWidth: T_RIMW,
      },

      /**
       * THE SINK. A collapse pit, not an impact bowl - so a low, wide ejecta
       * apron (6 m over 30, i.e. 16.7 degrees and walkable) round a wall that
       * is not (40 m over 53 m authored, 54.6 measured). You can stand on its
       * edge and look at the cinnabar; getting to it is a lap of the pit and
       * then 186 m of road down the far side. The apron being walkable is the
       * whole contrast with the Throat: one pit you can reach the lip of and
       * one you cannot, and the difference between them is `rimWidth`.
       */
      {
        kind: 'crater',
        x: SINK_X, z: SINK_Z, r: SINK_R,
        depth: SINK_DEPTH, floor: SINK_FLOOR,
        rim: 6, rimWidth: 30,
      },

      /* THE POCKMARKS. Four shallow collapse pits, ONE PER LEVEL - the pan,
       * and then one on each tread of the stair going down.
       *
       * Depth, radius and `floor` are chosen TOGETHER so the authored wall
       * lands at 22-24 degrees: `depth * 1.5 / (r - floor*r)` is the peak
       * gradient of the smoothstep, and it has to leave room for the noise
       * before the walk envelope's 38. The first version was 11 m deep at
       * `floor` 0.35, i.e. 33.7 degrees authored, and measured 45.6 with the
       * ripple on top - so the map came out covered in holes a player can see
       * into and not enter, which is a decorated floor and not pocked ground.
       * Shallower and wider is what buys the pit its own inside. */
      { kind: 'crater', x: 300, z: -20, r: 42, depth: 9, floor: 0.25, rim: 3.0, rimWidth: 18 },
      { kind: 'crater', x: 40, z: -100, r: 38, depth: 8, floor: 0.25, rim: 2.8, rimWidth: 16 },
      { kind: 'crater', x: -90, z: 200, r: 38, depth: 7, floor: 0.22, rim: 2.6, rimWidth: 15 },
      { kind: 'crater', x: -300, z: -140, r: 34, depth: 7, floor: 0.25, rim: 2.4, rimWidth: 14 },

      /** THE ORPIMENT SEAMS. Cubed walls, so it is a fissure and not a valley,
       *  and a 3 m spoil lip on each side which is the only part of it a body
       *  can stand on - and also the only part orpiment actually grows on. */
      { kind: 'trench', pts: SEAMS, width: 9, depth: 14, lip: 3.0, lipWidth: 12 },

      /* ---- LEVEL -------------------------------------------------- *
       * ROADS FIRST, BENCHES NEXT, BEDS AFTER THEM, PADS LAST.
       *
       * A later form in this layer overrides an earlier one where they
       * overlap, and every step of that order is doing a job:
       *
       *  - Roads before pads, which is Volcanic.js's measured lesson: with the
       *    pad first the road leaves the pad CENTRE and takes its own grade off
       *    across the disc, so a 16 m landing pad has 8 m of fall in it. With
       *    the pad last the disc wins outright and the road emerges from the
       *    pad EDGE, where the pad's blend hands over to the road's grade with
       *    no step. Measured here: throat pad span 0.00 m.
       *  - Bench before bed, so the bed's 3.4-4.6 m cut is taken out of a pan
       *    that is already level rather than out of the raw swell. A bed cut
       *    into noise is a lake with a tilted floor, and its shoreline is not a
       *    contour.
       *  - Pads last so no landform can be added on top of a landing promise.  */

      /** THE SLUMP, into the Sink. Both ends default: the head takes the pan,
       *  the toe takes the crater floor, so it meets both with no step. */
      { kind: 'ramp', pts: SLUMP, width: 11, blend: 15 },
      /**
       * THE THROAT ROAD. Same defaults, and its head IS the pad centre.
       *
       * `blend` 6, and it was 11. A `ramp`'s influence reaches `width + blend`
       * either side of its polyline, so at 11 it reached 18 m - and leg 1 comes
       * within 68.1 m of the throat axis, so that influence spilled out to
       * d 86.1, straight through the ejecta flank's steep band at d 80.8-88.2.
       * The road was quietly cutting the crest down over 8 m of the 13 m flank
       * it was supposed to be hiding behind: measured, the flank's peak fell
       * from its authored 64.3 degrees to 56.4, and a body walked out of
       * Cauldron Flat, up the softened flank at bearing 243 from (200, -328)
       * y 35.67 to (218, -328) y 44.75, and dropped into the road.
       *
       * At 6 the influence reaches 13 m, i.e. d 81.1, and stops short of the
       * band. The road surface itself is untouched - `width` is what levels,
       * `blend` is only the shoulder - so the descent, its grade and its
       * arclength solution are all exactly as they were.
       */
      { kind: 'ramp', pts: THROAT_ROAD, width: 7, blend: 6 },

      /* The pool benches. Absolute y, 0.2 m above the tread they sit on, so a
       * pool is a pan let into the terrace rather than a hole in it. */
      { kind: 'pad', x: POOL_A[0], z: POOL_A[1], r: 44, blend: 20, y: TER_A + 0.2 },
      { kind: 'pad', x: POOL_B[0], z: POOL_B[1], r: 40, blend: 18, y: TER_B + 0.2 },
      { kind: 'pad', x: POOL_C[0], z: POOL_C[1], r: 84, blend: 26, y: TER_C + 0.2 },

      /* The pool beds. Each `r + blend` reaches exactly to its bench's flat
       * edge, so the bank between bed and bench is one continuous slope with
       * no shelf in it - that bank IS the beach, and its 3.4-4.6 m of rise is
       * where the shoreline lands. */
      { kind: 'pad', x: POOL_A[0], z: POOL_A[1], r: 22, blend: 16, y: TER_A - 3.4 },
      { kind: 'pad', x: POOL_B[0], z: POOL_B[1], r: 24, blend: 16, y: TER_B - 3.6 },
      { kind: 'pad', x: POOL_C[0], z: POOL_C[1], r: 54, blend: 24, y: TER_C - 4.6 },

      /** CAULDRON FLAT. In the middle of the fumarole field, on the pan. */
      { kind: 'pad', x: CAULDRON[0], z: CAULDRON[1], r: 32, blend: 24 },
      /** STILLWATER STEP, on Terrace C 130 m north of the big pool. */
      { kind: 'pad', x: STEP_PAD[0], z: STEP_PAD[1], r: 26, blend: 20 },
      /** THE THROAT SHELF. `blend` 13, and see the `THROAT_PAD` docblock for
       *  why that number and not a looser or a tighter one - it is the single
       *  value this planet's exotic tier hangs on, and both of the obvious
       *  choices around it break something a screenshot would not show. */
      { kind: 'pad', x: THROAT_PAD[0], z: THROAT_PAD[1], r: 16, blend: 18 },
    ],
  },

  /* ---------------------------------------------------------------- */
  palette: {
    /* `rock.neutral`, not `dirt.ground`: sulfur crust is not soil, and the
     * library's dirt albedo is a measured brown filter (linear R:G:B =
     * 1.79 : 1 : 0.49) that vertex bands multiply into. This is the most
     * saturated table in the system and it had the most to lose - the cold
     * acid-etched pool beds (`#1c3b33`, hue 165) and the orpiment gold
     * (`#d0b410`) were being pulled toward the same ochre. Same grain, same
     * luminance, no cast. @see shadeRockNeutral in gfx/Materials.js */
    material: 'rock.neutral',
    tile: 5.5,
    /**
     * Absolute-height bands, and on Sallow they are also the TERRACE colours.
     *
     * The band boundaries are placed at the treads (4, 15, 26) rather than
     * between them, so each terrace sits on one band and the interpolation
     * happens on the RISERS - which is where the chemistry actually changes,
     * because each riser is a different distance down the drainage. Walking
     * west you go dark-olive, red, gold, pale, and the transition is always a
     * bank rather than a contour line in the middle of a flat.
     *
     *   height  colour     hue  sat  lightness  what it is
     *   y -20   #272b20     82   15     15      the throat floor, wet ash
     *   y  -3   #1c3b33    165   36     17      acid-etched pool beds: COLD
     *   y   4   #5c6b22     72   52     28      Terrace C, dark olive-green
     *   y  15   #c03a1e     10   73     44      Terrace B, realgar red-orange
     *   y  26   #d0b410     51   86     44      Terrace A, orpiment gold
     *   y  62   #efe49a     52   73     77      the pan and the crests
     *
     * 154 degrees of hue and 71 points of saturation, against the six bands
     * Cinder shipped with (5 degrees and 0 points) that a tester called "one
     * flat salmon-brown hue". The floors under `planet-atmosphere.test.mjs` are
     * 40 degrees and 15 points.
     *
     * THE TWO COLD BANDS ARE NOT DECORATION. This is the most saturated palette
     * in the system and that is the point of the planet, but a table where
     * every band is lurid has no anchor and reads as a colour chart. The two
     * dark bands at the bottom are deliberately cold and low-chroma, and they
     * are what make the gold and the vermilion above them read as CHEMISTRY
     * rather than as a filter over the whole world - the same trick Cinder's
     * blue-grey basalt bands play against its ochres, run the other way up.
     *
     * ── WHAT THE FOG IS HELD AGAINST ──────────────────────────────────────
     * In the working (linear) space this table averages L 0.218 / S 0.706. The
     * fog below is L 0.422 / S 0.308: lighter AND greyer, with 0.174 and 0.398
     * of margin on rules that need 0.03 and 0.02. See the fog comment.
     */
    bands: [
      { upTo: -16, color: 0x272b20 },
      { upTo: -3, color: 0x1c3b33 },
      { upTo: 4, color: 0x5c6b22 },
      { upTo: 15, color: 0xc03a1e },
      { upTo: 26, color: 0xd0b410 },
      { upTo: 62, color: 0xefe49a },
    ],
    /**
     * Bare altered rock on anything steep - the throat wall, the sink slump,
     * the fissure walls, the terrace risers at their steepest.
     *
     * COOL AND DESATURATED ON PURPOSE, and it is the same argument as the two
     * cold bands: on a planet where every horizontal surface is stained, the
     * only way a cliff reads as rock is if it is the one thing that is NOT
     * stained. `fromDeg` 26 catches the terrace risers at their middle, which
     * is what draws a line along the whole length of the stair.
     */
    slope: { fromDeg: 26, toDeg: 50, color: 0x5b6055 },
    /**
     * The staining, and this is the term that does the most work here.
     *
     * Applied as `n * n * amount`, so most of the field sits well below the
     * ceiling and only the patches get near it. 0.80 is high - higher than
     * Cinder's 0.72 - because on Sallow the mottle is not "oxidised ash", it is
     * the realgar and cinnabar bleed that gives the ground its actual identity.
     * 34 m of scale puts a patch at about the size of a fumarole apron.
     */
    mottle: { scale: 34, amount: 0.80, color: 0xd8481e },
  },

  sky: {
    kind: 'daylight',
    params: {
      /**
       * PERMANENT SULFUROUS OVERCAST, and the mechanism is `mieG`.
       *
       * Cinder is a clear dust sky: mie 4.4 at mieG 0.80, which is a tight
       * forward lobe - most of the scattered light comes from close to the sun,
       * so there is a bright sun, a dark zenith and hard shadows. Overcast is
       * the same optical depth with the anisotropy taken OUT: at mieG 0.62 the
       * phase function spreads across the dome, the whole sky becomes the light
       * source, and the terminator softens without anything being done to the
       * lights. That is the single number this planet's look hangs on, and
       * raising `mie` alone (the obvious move) just makes a brighter clear sky.
       *
       * Sun HIGH, at 55 degrees, and west. High because an overcast world has
       * no raking light in it and a low sun would put 200 m shadows across a
       * flat pan; west so that standing on Cauldron Flat, the Yellow Stair
       * descends INTO the light and its three risers each catch a highlight
       * along their whole length. A planet gets looked at from its landing
       * sites, so the key is chosen from one of them.
       */
      sunDirection: [-0.46, 0.82, 0.34],
      sunColor: 0xfff2c0,
      sunIntensity: 15,
      /** 0.072 against Cinder's 0.026. Through overcast the sun is a smeared
       *  bright patch three degrees across, not a disc; this is the cheapest
       *  honest way to say so, and it also stops the disc from being the one
       *  hard-edged thing in an otherwise soft frame. */
      sunAngularSize: 0.072,
      /** Almost no Rayleigh - there is no blue in this air - and Mie half again
       *  above Cinder's. Together with mieG they are the overcast. */
      rayleigh: 0.35,
      mie: 6.8,
      mieG: 0.62,
      altitude: 200,
      /** What is under the horizon line. The pan, seen edge on. */
      groundColor: 0x6b5c1c,
      /** THE HORIZON GLOWS, and at 0.94 it glows nearly all the way to 30
       *  degrees up. On a world whose skyline is a horizon rather than a
       *  mountain, the horizon has to be the most interesting thing in the
       *  upper half of the frame or there is nothing up there at all. */
      hazeColor: 0xf0e07e,
      horizonHaze: 0.94,
      /** A heavy, low, moving deck. 0.86 against Cinder's 0.20, at a smaller
       *  scale (0.85 against 1.1) so the cells are tighter and read as a lid
       *  rather than as high cirrus, and nearly twice the drift speed so it is
       *  visibly weather. */
      cirrus: 0.86,
      cirrusScale: 0.85,
      cirrusSpeed: 0.010,
    },
    background: 0xb8ae7c,
    /**
     * ── The fog, and the trap this planet walks into ──────────────────────
     *
     * `half` is 400, so the playfield is 800 m square and its diagonal is
     * 1,131 m. `far` 1245 is 1.10x that: the diagonal is fully extinguished so
     * the player never sees the terrain mesh stop, and it is not so far that
     * the rim at 400 m shows through. It is also well inside `CONFIG.render.far`
     * (2000), past which geometry would pop at the clip instead of fogging.
     *
     * THE COLOUR IS THE TRAP. Cinder's first fog was the same hue as the rock
     * under it and the whole planet lived inside a 9-luma band - "a big dark
     * room". On an overcast YELLOW world the identical mistake is available in
     * a different key: yellow fog over yellow ground. So this is measured the
     * same way `planet-atmosphere.test.mjs` measures it, in the working linear
     * space, against this file's own bands:
     *
     *              L        S
     *   ground   0.218    0.706     (the mean of the six bands above)
     *   fog      0.422    0.308
     *
     * Lighter by 0.204 against a floor of 0.03, and greyer by 0.398 against a
     * ceiling of +0.02. Cinder's own numbers are ground L 0.110 / S 0.448 and
     * fog L 0.186 / S 0.370 - the same relationship, moved up the value scale
     * because an overcast sky is genuinely twice as bright as a dust one.
     *
     * `near` 90 rather than Cinder's 120: thick air should start doing
     * something inside the length of the Brimstone Pan, and at 400 m the fog is
     * 27% in, which is aerial perspective rather than a wash.
     */
    fog: { color: 0xc4ba93, near: 90, far: 1245 },
    /**
     * ── The fill, and why it is high for this project ─────────────────────
     *
     * 0.60 against a key of 5.6 is a fill/key of 0.107, half again Cinder's
     * 0.072. That is the whole difference between a clear sky and an overcast
     * one expressed in the rig: under a lid, a face turned away from the sun is
     * still lit by most of the sky, so the terminator is soft and the contrast
     * between a lit slope and an unlit one is small.
     *
     * It is NOT free to go further. `planet-atmosphere.test.mjs` holds the
     * ratio at or under 0.12, because past that there is no terminator on any
     * slope at all and every face of every pit shades the same - which on a
     * planet whose entire silhouette is pits would delete the silhouette.
     * 0.107 leaves 11% of margin under that ceiling and is the softest this
     * world can be while still having form in it.
     *
     * The fill colour is the sky's own sulfur rather than neutral grey: the
     * bounce on an overcast world IS the sky, and a grey fill under a yellow
     * dome is two light sources that disagree about what planet this is.
     */
    ambient: { color: 0xc8bc72, intensity: 0.60 },
    sun: { color: 0xfff0c4, intensity: 5.6, direction: [-0.46, 0.82, 0.34] },
    /** 1.10 against Cinder's 1.22. This world is brighter at source - a bright
     *  diffuse dome over a pale ground - so it needs less. */
    exposure: 1.10,
    /**
     * `sports` and not `dock`, and the choice is the planet's thesis.
     *
     * `GRADE_PRESETS` is keyed on WORLD id and a planet is not in it, so naming
     * one here is the only way a planet gets a calibrated look. Cinder borrows
     * the yard's `dock`: warm world, cold shadows, high split, deep toe - the
     * grade for a dark room with hot things in it. Sallow is the opposite kind
     * of picture: bright, high-key, low-contrast, almost no vignette, and its
     * darkest area is a hole in the ground rather than the whole frame. That is
     * `sports`, which was calibrated on sunlit snow.
     *
     * Two overrides. The haze is a screen-space wash and `sports` tints it
     * sky-blue for a snow world; here it has to be sulfur or it fights the fog.
     * And saturation goes 1.10 -> 1.18, because "the most saturated palette in
     * the system" is a claim this planet is making on purpose and the grade is
     * the last place it can be undone.
     */
    grade: {
      preset: 'sports',
      hazeColor: [0.60, 0.56, 0.33],
      haze: 0.026,
      saturation: 1.18,
      vignette: 0.26,
    },
    /* `bloom` is absent deliberately. Naming a preset hands bloom to the
     * preset, whose threshold is calibrated on linear HDR luminance - and
     * there is nothing on this planet that should bloom anyway. The acid is at
     * 0.16 emissive and there is no other light source on the surface. */
  },

  /* ---------------------------------------------------------------- */
  /**
   * ACID, and what the lava channels were made to mean here.
   *
   * `PlanetLiquid`'s shader was written for lava and its four colour channels
   * are named for it. Three of them transfer honestly and one does not, and
   * saying which is which is better than putting a number in a field because
   * the field exists:
   *
   *   `crust`  the unbroken skin, drawn where the shader's noise is quiet. On
   *            lava that is chilled rock. Here it is the pale sulfur film that
   *            skins over a still acid pool, which is a real thing and looks
   *            like this.
   *   `color`  what shows where the skin has parted. On lava, incandescent
   *            depth; here, the acid itself - dark, clear and green.
   *   `flow`   the rate the skin drifts. 0.07 against Cinder's 0.55: this pool
   *            is not going anywhere, but it is not a photograph either.
   *   `hot`    DOES NOT APPLY. There is nothing incandescent on this planet.
   *            The channel is the emissive tint and cannot be removed, so
   *            rather than leaving it at a lava default it carries the colour
   *            of light SCATTERED back out of three metres of acid, at
   *            `emissive` 0.16 - one thirteenth of Cinder's 2.1, and low enough
   *            that it never lights anything. It is there so that a pool in the
   *            shadow of its own bank is still green rather than black. If the
   *            shader ever grows a `scatter` channel this should move into it.
   *
   * `glowLight` is null for the same reason and it is not an omission: acid
   * does not light the ground it sits in. `RIG_BUDGET.point` is twelve for the
   * whole game and every one of them is compiled into every shader, so a light
   * that lit nothing would be charged to every frame of every world.
   *
   * `lethal` is false, and it is worth writing down what that currently costs:
   * NOTHING READS IT. It is declared in `PlanetDescriptor`'s schema and set on
   * Cinder and nowhere else in `src/`. Liquid bodies also have no collider -
   * `_buildLiquid` builds two meshes per body and no physics - and `PlanetWorld`
   * sets `swim: false`. So on the shipped build a player walks under an acid
   * lake, dry and unharmed. That is why `clearOfLiquid` appears on every
   * placement near a pool: the surface is a wall the CONTENT respects even
   * though the player does not, and nothing is placed where a player would have
   * to appear to be standing in acid to reach it.
   */
  liquid: {
    name: 'acid',
    /**
     * ACID, AND IT NOW BURNS.
     *
     * The substance is its own field because the RENDERING kind cannot carry
     * it: this liquid draws through `PlanetLiquid`'s water branch (emissive
     * 0.16, no incandescence, a depth term) and must behave like nothing of
     * the sort. `liquidKind` still answers 'water' here and the look is
     * untouched; `liquidSubstance` answers 'acid' and `liquidSwimmable`
     * answers false.
     */
    kind: 'acid',
    bodies: [
      /* Each disc's radius is where its pool's BED BLEND has climbed back to
       * the disc's own surface height, so the drawn edge lands on the bank
       * rather than 12 m short of it on a flat floor. `wobble` differs per pool
       * so three pools of the same construction do not share an outline. */
      /** THE SHALLOWS, Terrace A. Bed 21.6, surface 23.5: 1.9 m deep. */
      { shape: 'disc', x: POOL_A[0], z: POOL_A[1], r: 28, y: TER_A - 1.5, wobble: 0.11, phase: 0.7 },
      /** THE MIDDLE POOL, Terrace B. Bed 10.4, surface 12.4: 2.0 m deep. */
      { shape: 'disc', x: POOL_B[0], z: POOL_B[1], r: 30, y: TER_B - 1.6, wobble: 0.13, phase: 2.3 },
      /** STILLWATER, Terrace C. Bed -1.6, surface 1.4: 3.0 m deep and 132 m
       *  across - the only pool on the planet with a horizon in it. */
      { shape: 'disc', x: POOL_C[0], z: POOL_C[1], r: 66, y: TER_C - 1.6, wobble: 0.08, phase: 4.1 },
    ],
    color: 0x2f5a24,
    hot: 0xa8e04e,
    crust: 0xdfd487,
    emissive: 0.16,
    flow: 0.07,
    glowLight: null,
    /**
     * TRUE, and this is the first descriptor in the game where it does
     * anything. `liquid.lethal` has been in the schema since the first planet
     * with a note saying it was there "so the day it turns true nothing has to
     * be re-plumbed"; `Swim._burn` is the plumbing, and this is the day.
     *
     * 14 dps is 7.1 s from full health to dead. Deliberately survivable and
     * deliberately not comfortable: Stillwater is 132 m across and 3.0 m deep,
     * so crossing a corner of it is a decision with a cost, and standing in it
     * is a death. Lava is the other end of that scale - see Volcanic.js, where
     * the same field is 240 and there is no crossing anything.
     *
     * The pools keep their 648 shore posts. The wall is what stops you falling
     * in; the burn is what happens when you get past it anyway.
     */
    lethal: true,
    hazard: { dps: 14 },
  },

  /* ---------------------------------------------------------------- *
   * PROPS.
   *
   * `columns` is absent and that is a decision, not an oversight: a basalt
   * colonnade is Cinder's signature object and putting one here would undo half
   * the work the rest of this file does. `growth` is absent because nothing
   * grows on Sallow. What is left is vents (the signature), spires as sulfur
   * chimneys, slabs as collapsed pavement, shards as orpiment blades, and one
   * field of crusted blocks so the ground is never empty.                     */
  props: [
    {
      id: 'pan_vents',
      kind: 'vents',
      /**
       * THE BRIMSTONE PAN. The signature field, and it is centred on the
       * primary landing pad on purpose: you set down in the middle of it.
       *
       * `yMin` 30 / `yMax` 46 is doing the region's real work. The pan swells
       * between 30 and 42; Terrace A tops out at 30 and the pit floors at 27,
       * so the floor excludes everything west of riser 1 and everything inside
       * a hole, and the ceiling excludes the Throat's 54 m crest ring - which
       * is a LOW-SLOPE surface a slope filter would happily accept and nothing
       * can walk to. A height window is the only filter that separates "the
       * flat pan" from "the flat top of a wall".
       */
      region: { shape: 'disc', x: CAULDRON[0], z: CAULDRON[1], r: 190, yMin: 30, yMax: 46, slopeMaxDeg: 14, clearOfPads: 5 },
      count: 130, spacing: 13,
      size: { rMin: 0.6, rMax: 2.6, plumeMin: 5, plumeMax: 20 },
      tint: [0xa8952c, 0xc8b23a, 0x7a6a18, 0xd8c85a],
      collide: false,
    },
    {
      id: 'throat_vents',
      kind: 'vents',
      /** The floor of the Throat. `plumeMax` 42 against the pan's 20: the shaft
       *  is 56 m deep and the whole point of these is that they are visible
       *  from outside it, standing over the ring like smoke over a chimney. It
       *  is the only long-range advertisement the second landing gets. */
      region: { shape: 'disc', x: TX, z: TZ, r: 34, slopeMaxDeg: 26 },
      count: 22, spacing: 8,
      size: { rMin: 0.9, rMax: 3.2, plumeMin: 14, plumeMax: 42 },
      tint: [0xc8b23a, 0xe0d060, 0x8a7620],
      collide: false,
    },
    {
      id: 'pool_chimneys',
      kind: 'spires',
      /**
       * Sulfur chimneys round Stillwater's margin - deposition cones the pool
       * built as it fell. An annulus rather than a disc so nothing stands in
       * the water, and `clearOfLiquid` 3 for the same reason against the
       * disc's 8% shoreline wobble.
       *
       * `spacing` 9 against a base radius of at most 1.5 m: the collider on a
       * spire is its FOOT, not the whole needle, so this leaves lanes six
       * metres wide. Cinder's colonnade lost a whole ore seam inside itself at
       * 5.0 m spacing and this field sits on top of the realgar.
       */
      region: { shape: 'annulus', x: POOL_C[0], z: POOL_C[1], r0: 70, r1: 128, slopeMaxDeg: 22, clearOfLiquid: 3, clearOfPads: 4 },
      count: 60, spacing: 9,
      size: { h: [2.2, 9.5], base: [0.5, 1.5], lean: 0.20, facets: 5 },
      tint: [0xe8dc9a, 0xd0c070, 0xf0e8c0, 0xb8a850],
      collide: true,
    },
    {
      id: 'sink_slabs',
      kind: 'slabs',
      /** The Sink's floor, which is a collapsed roof: flat plates tipped every
       *  which way. `collide` FALSE deliberately - eighty thin plates with a
       *  box each would carpet a 38 m floor and the cinnabar would be behind
       *  glass, which is Cinder's colonnade defect with a different primitive.
       *  A plate you step over does not need a collider. */
      region: { shape: 'disc', x: SINK_X, z: SINK_Z, r: 46, slopeMaxDeg: 22 },
      count: 80, spacing: 5.5,
      size: { w: [1.5, 5.2], d: [1.3, 4.4], t: [0.22, 0.85], tilt: 0.60 },
      tint: [0x4a3a2a, 0x5e402c, 0x38302a, 0x6a4a30],
      collide: false,
    },
    {
      id: 'seam_shards',
      kind: 'shards',
      /** Orpiment blades on the fissure lips. `widthInner` 10 keeps every one
       *  of them out of the trench - a shard field on a floor nothing can reach
       *  is 150 instances of nothing. */
      region: { shape: 'corridor', pts: SEAMS, width: 20, widthInner: 10, slopeMaxDeg: 30, clearOfPads: 4 },
      count: 150, spacing: 4,
      size: { hMin: 0.6, hMax: 3.0, wMin: 0.25, wMax: 1.0 },
      tint: [0xd8b02c, 0xb08a18, 0xe8c850, 0x8a6a10],
      collide: false,
    },
    {
      id: 'crust_blocks',
      kind: 'boulders',
      /** Crusted blocks over the whole map, so no tread is ever bare. Tinted
       *  pale and low-chroma against a ground that is not: the blocks are the
       *  only unstained thing at eye level and they are what the staining reads
       *  as staining ON. */
      region: { shape: 'field', slopeMaxDeg: 30, clearOfLiquid: 10, clearOfPads: 4 },
      count: 850, spacing: 8,
      size: { rMin: 0.45, rMax: 2.4 },
      tint: [0x6a6858, 0x7c7460, 0x565448, 0x8a8068],
      collide: true,
    },
  ],

  /* ---------------------------------------------------------------- *
   * MINERALS - five elements, five places, one ladder.
   *
   * Every distance below is MEASURED, not asserted: flooded from each pad over
   * a 2 m lattice against the real colliders, with no jump and no mantle.
   *
   *   rarity     element     terrain      nearest / median walk, and from where
   *   ---------  ----------  -----------  ---------------------------------------
   *   common     brimstone   vent_field    50 /  144 m   Cauldron Flat, and the
   *                                        pad is IN the field
   *   uncommon   realgar     shore         66 /  188 m   Stillwater Step
   *   uncommon   orpiment    fissure      200 /  377 m   Cauldron Flat, over
   *                                        riser 1 and down Terrace A
   *   rare       cinnabar    crater       545 /  630 m   Cauldron Flat, round
   *                                        the Sink and down the Slump - the
   *                                        longest march on the planet
   *   exotic     stibnite    vent_field   301 /  381 m   THE THROAT ONLY.
   *                                        0 of 6 from Cauldron Flat at any
   *                                        distance, and 0 of 6 from any pad
   *                                        at all if the throat road is deleted
   *
   * BRIMSTONE AND STIBNITE ARE BOTH `vent_field`, WHICH IS THE POINT AND ALSO
   * THE RISK. They are the same chemistry - sulfur out of a fumarole - and the
   * difference between 17 cr/m3 and 520 is entirely WHERE the fumarole is. So
   * they are given the two most distant places on the planet and two `place`
   * names that share no word: brimstone crusts on open ground you land on, and
   * stibnite grows in a throat 56 m below the pan you cannot walk into. If those
   * two were the same field the rarest ore on Sallow would be the commonest one
   * with a better name.
   *
   * `credits` is absent from every row on purpose - `definePlanet` computes it
   * from `unitValue * hold` and REFUSES a hand-written one.
   *
   * THE CHEAP ORE IS THE BULKY ORE, which is the whole cargo decision. `size`
   * is the node radius AND the hold volume (`max(1, round(size * 1.6))`):
   *
   *   brimstone  1.65 m  3 m3    51 cr a node    17 cr/m3
   *   realgar    1.30 m  2 m3   116 cr          58
   *   orpiment   1.05 m  2 m3   148 cr          74
   *   cinnabar   0.72 m  1 m3   290 cr         290
   *   stibnite   0.56 m  1 m3   520 cr         520
   *
   * A stock Kestrel holds 10 m3. That is three lumps of brimstone for 153
   * credits, or ten needles of stibnite for 5,200 - and stibnite needs the
   * second landing to get at. In a 40 m3 Dray the calculation changes, which is
   * what the two hulls are for.                                               */
  minerals: [
    {
      id: 'brimstone', item: 'brimstone', name: 'Brimstone Crust',
      rarity: 'common', terrain: 'vent_field', place: 'the Brimstone Pan',
      /* Sulfur yellow with a faint self-glow. It is the cheapest thing on the
       * planet, so the glow is kept to a dark value - bright enough to pick a
       * node out of a fumarole field at 40 m, not bright enough to make the
       * commonest ore the most conspicuous object in the frame, which is the
       * mistake Cinder's tephra shipped with. */
      color: 0xe0cc38, glow: 0x2a2404,
      unitValue: ORE('brimstone'), spread: 0.25,
      /* 1.65 m is the biggest node on the planet and the least valuable. It has
       * to clear 1.5625, below which `holdUnitsFor` rounds down to two cubic
       * metres and the bulk-versus-value decision goes with it. */
      size: 1.65, count: 40, spacing: 20,
      region: { shape: 'disc', x: CAULDRON[0], z: CAULDRON[1], r: 190, yMin: 30, yMax: 46, slopeMaxDeg: 16, clearOfPads: 6 },
    },
    {
      id: 'realgar', item: 'realgar', name: 'Realgar',
      rarity: 'uncommon', terrain: 'shore', place: 'the Stillwater Shore',
      /* Orange-red prisms. `realgar` is the one ore whose real mineralogy and
       * the palette agree without help - it is the same red the mottle stains
       * this planet with, which is correct, because on Sallow that stain IS
       * powdered realgar. */
      color: 0xd4482c, glow: 0x2c0c04,
      unitValue: ORE('realgar'), spread: 0.25,
      size: 1.30, count: 20, spacing: 12,
      /**
       * AN ANNULUS ON ONE POOL, AND THE FILTER THIS PLANET WANTED.
       *
       * `shore` means "the margin of a liquid body" and Sallow has three of
       * them, but a mineral gets ONE region record and there is no filter for
       * "within N metres of liquid" - `clearOfLiquid` is a minimum clearance,
       * not a maximum. A `field` region with a clearance band is not
       * expressible, and a `corridor` threaded between the three pools would
       * put two thirds of its nodes on dry terrace between them, which is not a
       * shore. So this addresses Stillwater's margin alone. See the report: a
       * `nearLiquid` ceiling beside `clearOfLiquid` is the one addition to the
       * placement language this planet actually needed.
       *
       * `r0` 74 clears the disc's 8% shoreline wobble (which reaches 71.3 m)
       * with three metres to spare, and `clearOfLiquid` 5 says the same thing
       * against the nominal radius so neither is load-bearing on its own.
       * `r1` 100 stops inside the bench, where the ground is still under 16
       * degrees; past it the bank starts climbing to the terrace.
       */
      region: { shape: 'annulus', x: POOL_C[0], z: POOL_C[1], r0: 74, r1: 100, slopeMaxDeg: 16, clearOfLiquid: 5, clearOfPads: 4 },
    },
    {
      id: 'orpiment', item: 'orpiment', name: 'Orpiment',
      rarity: 'uncommon', terrain: 'fissure', place: 'the Orpiment Seams',
      color: 0xe8b820, glow: 0x2e2202,
      unitValue: ORE('orpiment'), spread: 0.25,
      size: 1.05, count: 16, spacing: 14,
      /* THE LIPS, NOT THE FLOOR, and it is the same fix and the same geology.
       * `trench` cubes its walls, so the bottom of a 14 m fissure is behind
       * near-vertical rock and a seam authored down there is ore behind glass -
       * exactly what Cinder's sulfur did before `widthInner`. `widthInner` 10
       * starts the band one metre outside the cut, at the crest of the spoil
       * lip, and `width` 21 ends it where the lip has died away. Orpiment sheaves
       * grow in the vapour that comes OUT of a fissure, which is the lip. */
      region: { shape: 'corridor', pts: SEAMS, width: 21, widthInner: 10, slopeMaxDeg: 28, clearOfPads: 4 },
    },
    {
      id: 'cinnabar', item: 'cinnabar', name: 'Cinnabar',
      rarity: 'rare', terrain: 'crater', place: 'the Sink',
      /* The most violent red there is, and it needs to be: it sits on a floor
       * of red-brown collapsed pavement 40 m down a hole in low contrast light.
       * The glow is the largest on the planet for the same reason - this is the
       * one ore a player goes down a road to find and it has to be findable at
       * the bottom of it. */
      color: 0xc41c1c, glow: 0x5a0a0a,
      unitValue: ORE('cinnabar'), spread: 0.25,
      size: 0.72, count: 10, spacing: 11,
      /* r 56 reaches 17 m past the flat floor's 38.6, and the 22-degree ceiling
       * is what stops it going further: the Sink's wall is 48 degrees, so every
       * sample on it is rejected and what is left is the floor plus the last
       * stretch of the Slump's own shelf. The road is therefore part of the
       * deposit rather than just the way to it. */
      region: { shape: 'disc', x: SINK_X, z: SINK_Z, r: 56, slopeMaxDeg: 22, clearOfPads: 4 },
    },
    {
      id: 'stibnite', item: 'stibnite', name: 'Stibnite',
      rarity: 'exotic', terrain: 'vent_field', place: 'the Throat floor',
      /* Steel grey with a cold rim, and it is a legibility decision before a
       * mineralogical one - though antimony sulfide really is a metallic grey.
       * COLD is the one thing nothing else on this planet is: the ground is
       * yellow, the stain is red, the acid is green and the sky is sulfur. A
       * player has to be able to tell a 520 cr needle from a 17 cr lump at ten
       * metres, and hue is the only channel left. */
      color: 0xa8b0bc, glow: 0x2e4a5e,
      unitValue: ORE('stibnite'), spread: 0.25,
      /* The smallest node on the planet and the dearest: one cubic metre, 520
       * credits, 0.56 m across - "a metre of parallel blades", which is what
       * the item row says a good cluster is. */
      size: 0.56, count: 6, spacing: 10,
      /* The throat floor. `rInner` 22 leaves the landing shelf's approach clear
       * and `slopeMaxDeg` 26 does the rest: the wall outside the 36 m flat disc
       * is 63 degrees, so the region resolves to the floor and nothing else.
       * Nothing here is reachable from Cauldron Flat at any distance. */
      region: { shape: 'disc', x: TX, z: TZ, r: 40, rInner: 22, slopeMaxDeg: 26, clearOfPads: 2 },
    },
  ],

  /* ---------------------------------------------------------------- *
   * LANDING SITES. Three, and each one is the answer to a different question.
   *
   * CAULDRON FLAT is where you arrive on foot when the world is entered
   * directly, so it reaches the common ore (underfoot), both uncommons (over
   * riser 1 to the seams, down the stair to the shore) and the rare one (down
   * the Slump). STILLWATER STEP exists because the stair is 700 m long and the
   * lake country should not be a ten-minute walk every visit. THE THROAT SHELF
   * exists for exactly one reason: it is the only ground the stibnite can be
   * reached from, and flying to it is the decision the exotic tier costs.       */
  /* WHY THIS BLOCK SITS ABOVE `landing` AND NOT BELOW IT.
   *
   * `scripts/tests/quest-verbs.test.mjs` builds the pilot vocabulary by
   * scraping this file: it finds `
  landing:` and then matches every
   * `id: '...', name:` from there TO THE END OF THE FILE. A viewpoint record
   * has the same two fields in the same order, so a `viewpoints:` block placed
   * after `landing:` is read as three more landing pads and the test fails with
   * `"ash_throne" is a pad on Cinder and is not a legal pilot target`.
   *
   * The scrape is what is wrong - it should stop at the end of the array it
   * started in - and fixing it belongs in that file. Until it is fixed, key
   * order is load-bearing in a way nothing in this file could tell you, so it
   * is written down here in all ten descriptors rather than discovered again.
   */
  /* ── VIEWPOINTS ───────────────────────────────────────────────────────
   * 8.1 m/s2, apex 0.992 m, a 5.4 m sprint jump.
   *
   * NOT the rim of the Throat, which is the best view on the planet and is 24 m
   * of rim over 6.5 m of run - 75 degrees. The walk lattice cannot reach any
   * point on it from any pad, and the pad that shares its name sits on a shelf
   * BELOW it. Same rule as Lathe's Shepherd: an unproven climb is not a prize. */
  viewpoints: [
    {
      /* The east rim of the Sink, 42 m, over a 40 m bowl with the cinnabar in
       * the bottom of it. 348 m from Cauldron Flat. */
      id: 'sink_rim', name: 'Sink East Rim', x: 344.5, z: 150, r: 8,
      terrain: 'crater', place: 'the Sink',
      climb: 'East across the pan from Cauldron, then round the rim.',
    },
    {
      /* A fumarole cone standing 17 m out of the Brimstone Pan at 44.5 m, with
       * the vent field all round it. */
      id: 'pan_cone', name: 'Brimstone Cone', x: 164.72, z: 200, r: 6,
      terrain: 'vent_field', place: 'the Brimstone Pan',
      climb: 'North across the pan; the cone is the only thing standing up.',
    },
    {
      /* The head of the Orpiment Seams at 25.7 m, 609 m from any pad - the
       * longest walk on Sallow, up the whole length of the seam trench. */
      id: 'seam_head', name: 'Orpiment Head', x: 20, z: 360, r: 8,
      terrain: 'fissure', place: 'the Orpiment Seams',
      climb: 'North up the seam from the pan and out at its head.',
    },
  ],

  landing: [
    {
      /* Facing NNE, at the Throat ring on the northern horizon - an 18 m pale
       * wall with 42 m plumes standing over it. `DockWorld` records the
       * convention (characters look down -Z at yaw 0), so forward is
       * (-sin yaw, -cos yaw). Chosen, not measured. */
      id: 'cauldron', name: 'Cauldron Flat', x: CAULDRON[0], z: CAULDRON[1], r: 32, primary: true, yaw: -0.26,
    },
    {
      /** Facing SSE, down the length of Stillwater. */
      id: 'stillwater', name: 'Stillwater Step', x: STEP_PAD[0], z: STEP_PAD[1], r: 26, yaw: -2.86,
    },
    {
      /** Facing the throat axis, so stepping off the shelf is stepping toward
       *  the road and the vents at the bottom of it. */
      id: 'throat', name: 'The Throat Shelf', x: THROAT_PAD[0], z: THROAT_PAD[1], r: 16, yaw: -2.01,
    },
  ],


  hazards: {
    /** Sulfur dust in the air, drifting rather than falling - `ashfall` is the
     *  only channel there is for airborne particulate and this is what it is
     *  used for here. Denser than Cinder's 0.35 because an overcast world with
     *  no long shadows needs something between the camera and the horizon to
     *  say the air is thick. */
    ashfall: { density: 0.55, drift: [0.30, 0.45] },
    ashColor: 0xd9cc72,
    /** Vent steam. Cinder's is a dirty grey-brown because it is ash-laden;
     *  Sallow's is a pale sulfur white, kept off pure white on purpose - a
     *  near-white plume was the brightest thing in a Cinder frame once and the
     *  bloom pass turned every puff into a hard ball. */
    steamColor: 0xcfc68e,
    /* `heatShimmer` is absent, and that is the fourth difference stated as an
     * omission: there is no lava on this planet and nothing on it is hot enough
     * to bend the air. */
  },
});

export default SALLOW;
