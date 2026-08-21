/**
 * CARNELIAN - the red iron highlands, and the planet whose whole design problem
 * was NOT BEING THE OTHER TWO RED ONES.
 *
 * There are already two dusty red-orange worlds in this system. Cinder is a
 * shield volcano under an orange dust sky; Sirocco is a dune sea under an
 * orange dust sky. A third would be one planet three times, so this file spends
 * its whole budget on the three axes where a red planet is still free:
 *
 *   1. THE AIR. `alpine`, not `daylight`. Thin, clean, cold: Rayleigh 3.6
 *      against Cinder's 0.12, Mie 0.20 against Cinder's 4.4. The zenith is a
 *      deep blue-violet and the horizon is a pale rose band rather than a wall
 *      of dust. `Bodies.js` states the flight consequence in as many words -
 *      "the descent is short and the ground is visible for most of it - the
 *      opposite of Sirocco, and deliberately so" - and the fog here is the
 *      ground half of that promise: distance reads as CONTRAST, not as haze.
 *
 *   2. THE SILHOUETTE. Cinder is RADIAL (a shield with a caldera). Sirocco is
 *      WAVY (transverse dunes). Carnelian is LINEAR: two fault scarps that run
 *      from one map edge to the other, a flat-topped table on the shelf between
 *      them, and one gorge cut 107 m into the top shelf. Every major edge on
 *      this planet is a straight line seen end-on, which is a shape neither of
 *      the other two has anywhere. `scarp` is the landform that exists for
 *      exactly this.
 *
 *   3. THE COLOUR. Iron oxide is not sand. Deep oxide red at the bottom of its
 *      value range, near-black plum in the gorge, pale settled dust on the
 *      scarp crests, and a near-SILVER pavement on the top shelf where
 *      specular hematite is exposed. 85 points of saturation and 74 degrees of
 *      hue across seven bands, measured - see the palette docblock.
 *
 * ==========================================================================
 *  THE MAP, in words
 * ==========================================================================
 *
 * 880 m square, `+x` east and `+z` south. The datum is the dust plain at y 20.
 * The ground rises EASTWARD in two fault steps and is then cut by one gorge.
 *
 *   THE OCHRE FLATS     the western fifth, x < -260, at y 20. Wind-graded iron
 *                       dust over deflated hardpan, with THE CUP - a degraded
 *                       impact bowl - breaking the southern skyline. `ochre`,
 *                       the common ore and the bulky one, is the ground
 *                       itself. REDGATE is here at (-300, 120); it was the
 *                       primary pad until the arrival rule moved the flag to
 *                       Anvil Deck - see the block over `landing`.
 *
 *   THE LOW SCARP       fault one. A line running the full 880 m from the
 *                       north edge to the south edge at x about -210, standing
 *                       38 m proud on its eastern side over a 24 m run - a
 *                       58 degree face. From Redgate it is the horizon.
 *
 *   THE OCHRE BENCH     the shelf above it, y 58. Open and dusty, with two
 *                       things on it: THE DUST TABLE, a flat-topped mesa at
 *                       y 84 standing 26 m over the shelf, and SUNDER, an old
 *                       crater filled nearly level with dust.
 *
 *   THE IRONWALL        fault two, 200 m further east, 44 m over a 26 m run.
 *                       Specular hematite plates weather out of the face and
 *                       litter BOTH the scree apron below it and the crest
 *                       above, which is where `hematite` is and why its
 *                       corridor is hollow: the face itself is a 59 degree
 *                       wall and nothing stands on it.
 *
 *   THE ANVIL           the top shelf, y 102 - and it is the hematite
 *                       PAVEMENT, the near-silver top band of the palette and
 *                       the brightest ground on the planet. ANVIL DECK, the
 *                       primary pad, lands on it at (130, -200); THE DIMPLE, a small crater,
 *                       breaks its southern half.
 *
 *   THE TWO STAIRS      the only two ways up this planet, and both are cut
 *                       roads: the LOW STAIR climbs the Low Scarp at 13 deg
 *                       and the HIGH STAIR climbs the Ironwall at 16 deg. A
 *                       scarp raises a HALF-PLANE - it has no ends inside the
 *                       map - so without these two ramps the Ochre Bench and
 *                       the Anvil are two sealed shelves and three quarters of
 *                       the ore on the planet is behind glass. They are the
 *                       same decision Cinder's spiral road is.
 *
 *   VERMILION GORGE     the reason to come. A compound canyon cut into the
 *                       Anvil, running from a box-canyon head at (300, -250)
 *                       south and off the map: an outer trough 224 m across
 *                       and 24 m deep whose floor is a 28 m WALL TERRACE on
 *                       each side, and out of the middle of that terrace an
 *                       inner slot 40 m across and 83 m deep - 107 m of cut,
 *                       and 103-104 m of it measured rim to floor at eight
 *                       stations. `carnelite` - banded chalcedony - is on the
 *                       terrace, in the wall. `monazite` is on the floor.
 *
 *   THE RIMWAY          the third cut road, and the one measurement forced.
 *                       The trough's wall stands at 40-62 degrees (eight
 *                       stations, median 53) where the lattice walks 38, so
 *                       the terrace CANNOT be walked down onto - the build
 *                       without this road measured the nearest carnelite at
 *                       937 m, reached the whole way round the head of the
 *                       gorge, from a rim you can see it from at 150. The
 *                       Rimway is 81 m of shelf cut into that wall, 26.7 m of
 *                       descent at 18 degrees, and it is the only way DOWN
 *                       onto the terrace from the rim. Carnelite went from 937
 *                       m away to 215. The FAR terrace has no road, and is
 *                       reachable only by the 493-1,128 m walk round the head
 *                       of the gorge - which is the difference between a ledge
 *                       and a view.
 *
 *   THE KILN            the slot widens into a 48 m chamber at (292, -215),
 *                       just below the head, and KILN DECK lands in it. It is
 *                       the second landing and the only way to the gorge
 *                       floor: the slot walls stand at 85 degrees for their
 *                       whole length, the head is a bowl of the same, and the
 *                       chamber's own apron is 81. Measured, `monazite` is
 *                       0 of 7 from Redgate and 0 of 7 from Anvil Deck.
 *
 * ==========================================================================
 *  WHY THE NUMBERS ARE THESE NUMBERS
 * ==========================================================================
 *
 * RELIEF BUDGET. 38 m of Low Scarp plus 44 m of Ironwall is 82 m of authored
 * step, the Dust Table adds 26 more on the shelf between them, and the gorge
 * cuts 107 m back down out of the top. Measured over a 1,101 x 1,101 grid the
 * field runs y -23.8 to y 109.6, a range of 133 m, and every one of the
 * 1,212,201 samples is finite. The noise - swell 6.0, ripple 1.5, grain 0.26 -
 * totals 7.76 m, which is 5.8% of that range. Same rule Cinder
 * records (11.6 m against 158 m, the last 7%): the noise's entire job is to
 * stop the authored shapes reading as CAD, and on a planet whose whole idea is
 * STRAIGHT EDGES it has to be quieter still or the edges stop being straight.
 *
 * THE GORGE IS 107 m AND NOT 80, AND THAT IS A PALETTE DECISION AS MUCH AS A
 * DRAMATIC ONE. Height bands colour by ABSOLUTE y, so a gorge cut 80 m into a
 * 102 m shelf has its floor at 22 - the same height as the Ochre Flats, and
 * therefore the same colour. The deepest, darkest, most enclosed place on the
 * planet would have rendered in the same paint as the open dust plain. At 107
 * the floor sits at -2, twenty-two metres clear of the flats' own range, and
 * gets a band of its own. The cheapest way to buy a colour is to earn it.
 *
 * WHY THE STEPS ARE 38 AND 44 AND NOT 60. A `scarp` face is `height` over
 * `run`, and the reach lattice walks 38 degrees. Anything over about 20 m of
 * height at a believable run is already a wall, so the extra metres buy
 * silhouette and cost nothing - but they DO cost the palette, because each
 * step has to fall inside a band boundary or the two shelves read as one. 38
 * and 44 put the three shelves at 20, 58 and 102, which is one band each with
 * the transition landing on the face, where `slope` overrides it anyway.
 *
 * Every ramp grade, wall angle, pad span and reach claim below was measured
 * against the real height function and the real colliders before this file was
 * reported, and three of them changed the GEOMETRY rather than the comment.
 */

import { definePlanet } from './PlanetDescriptor.js';
import { ITEMS } from '../../systems/ItemDefs.js';

/**
 * Credits per cubic metre of hold, read off the item catalogue.
 *
 * The price belongs to the ELEMENT and not to the planet it came off: the same
 * hematite is worth the same per cubic metre wherever it was cut, and the
 * vendor who buys it reads `ITEMS`. So the number lives there once and this
 * file quotes it. Throwing on a missing row rather than returning `undefined`
 * is the difference between a loud boot failure and four deposits worth NaN -
 * and NaN through the bloom pass is the failure this project has already lost
 * a day to.
 *
 * @param {string} id an `ITEMS` id
 * @returns {number} credits per cubic metre
 */
const ORE = (id) => {
  const def = ITEMS[id];
  if (!def) throw new Error(`[Carnelian] mineral names item "${id}", which has no ITEMS row`);
  return def.value;
};

/* ------------------------------------------------------------------ */
/* Frame of reference                                                  */
/* ------------------------------------------------------------------ */

/** Playfield half-extent. */
const HALF = 440;
/** The dust plain's nominal height. Every other level is quoted against it. */
const FLATS = 20;

/** The two fault throws, and the run each one falls back over. */
const LOW_H = 38;
const LOW_RUN = 24;    // 38 / 24 -> 58 deg. A face, not a hill.
const HIGH_H = 44;
const HIGH_RUN = 26;   // 44 / 26 -> 59 deg.

/** The three shelves, derived rather than typed, so they cannot disagree. */
const BENCH = FLATS + LOW_H;          // 58 - the Ochre Bench
const ANVIL = BENCH + HIGH_H;         // 102 - the Anvil, and the hematite pavement
const TABLE = BENCH + 26;             // 84 - the Dust Table, on the shelf between

/**
 * The gorge, as two coaxial cuts. See `terrain.landforms` for why it is two.
 *
 * 107 is the AUTHORED number and the slot's depth is what falls out of it, not
 * the other way round: the whole reason the gorge is this deep is that its
 * floor has to land clear of the Ochre Flats' own height band, and that is a
 * statement about the TOTAL. Written the other way, a change to the trough
 * would silently move the floor into the plain's colour.
 */
const TROUGH_D = 24;                  // the outer trough
const GORGE_D = 107;                  // total cut: floor at ANVIL - GORGE_D = -5
const SLOT_D = GORGE_D - TROUGH_D;    // 83 - the inner slot

/* ------------------------------------------------------------------ *
 * THE TWO FAULT LINES.
 *
 * Both run edge to edge, north to south, and both raise their EASTERN side.
 * `scarp` extends its polyline past both ends before sampling, so the raised
 * half-plane has no end inside the playfield and there is no walking round
 * either of them - which is the entire reason the two stairs exist.
 *
 * `side: -1` is what raises the east, and it was measured rather than reasoned
 * about: for a polyline running north to south the cross product `scarpAt`
 * reads comes back NEGATIVE on the eastern side, so +1 would have raised the
 * west and stood the flats on top of the bench. The probe sampled a point
 * either side of each line and printed which one came back high.
 *
 * The bends are 20-50 m of lateral wander over 200 m of length. Small on
 * purpose: a dead-straight fault reads as a wall somebody built, and a wiggly
 * one stops reading as a fault at all. This is about the sinuosity a real
 * normal fault trace has at this scale.                                       */

/** Fault one. From Redgate this is the horizon. */
const LOW_FAULT = [[-236, -440], [-198, -250], [-224, -60], [-186, 140], [-206, 440]];

/** Fault two, the Ironwall. Hematite weathers out of this face. */
const HIGH_FAULT = [[20, -440], [-6, -230], [44, -40], [10, 170], [52, 440]];

/* ------------------------------------------------------------------ *
 * THE GORGE AXIS.
 *
 * Head at (300, -250), INSIDE the map, and out through the southern edge at
 * z 520. The head being inside is deliberate and it is a reachability
 * decision, not a scenic one: the gorge with its trough is 224 m wide, and with
 * the head inside the map there is 39 m of open Anvil NORTH of the trough's
 * bowl to walk round by. Run it off both edges instead and the whole eastern
 * side of the planet is an island - measured, on the build that did: 26,857
 * standable lattice cells, 14% of the surface, reachable from no landing site
 * at all.
 *
 * (Round the bowl over OPEN GROUND. Not down into it - nothing walks down the
 * trough wall anywhere except the Rimway.)
 *
 * (292, -215) is a vertex rather than a point along a segment because the
 * Kiln's pad sits exactly on it, and a pad whose centre is three metres off the
 * axis cuts its chamber three metres off the axis.                            */
const GORGE = [
  [300, -250],   // the head. A box canyon.
  [292, -215],   // THE KILN
  [276, -140],
  [296, -30],
  [258, 150],
  [284, 330],
  [260, 520],    // off the southern edge
];

/** The Deep Reach: head to the first big bend. `monazite` is on its floor. */
const DEEP_REACH = [[300, -250], [292, -215], [276, -140], [296, -30]];

/**
 * The carnelite band: the axis SOUTH of the Kiln, offset 34 m WEST.
 *
 * Two measurements forced both halves of that.
 *
 * A `corridor` is symmetric about its line, and the symmetric version put a
 * third of the seam on the FAR terrace - 3 of 12 nodes, and on the layout that
 * preceded this one they were on the other side of an 83 m slot from every
 * landing site on the planet, reachable from none of them. They are reachable
 * now, at 493 to 1,128 m round the head of the gorge against 215 down the
 * Rimway, and that is still the wrong answer: a seam a quarter of which costs a
 * kilometre detour is a seam whose stated place is a lie.
 *
 * And a landing pad on a 40 m slot has to cut its chamber out of the terrace as
 * well as out of the floor, so the Kiln's own apron SEVERS the terrace at its
 * latitude - a band that crossed it scored 1 of 12. So this one starts south of
 * the Kiln, at z -134, on the 700 m stretch the Rimway serves.
 *
 * The offsets are arithmetic - 34 m along the inward normal of each segment,
 * mitred at the bend - and not eyeballed.
 */
const CARNELITE_BAND = [[242.6, -133.9], [262.0, -30.5], [224.7, 143.0]];

/* ------------------------------------------------------------------ *
 * THE THREE CUT ROADS.
 *
 * The two stairs run diagonally ACROSS their face rather than straight up it,
 * which is how a road gets up a scarp and also what keeps the grade under 20
 * degrees without a switchback: 152 m of road for 38 m of climb, and 148 m for
 * 44 m.
 *
 * None of the three declares `y0` or `y1`. A `ramp` with neither takes the
 * PRE-LEVEL field height at its first and last points, so every end meets the
 * ground it arrives on exactly, with no step, whatever the swell does there.
 * Pinning them by hand would be pinning numbers the noise seed owns.          */

/** Up the Low Scarp, from the flats to the Ochre Bench. */
const LOW_STAIR = [[-268, 8], [-232, 34], [-206, 62], [-176, 84], [-146, 96]];

/** Up the Ironwall, from the Ochre Bench to the Anvil. */
const HIGH_STAIR = [[-46, -300], [-10, -286], [20, -266], [46, -240], [66, -210]];

/**
 * THE RIMWAY - down the trough wall onto the gorge's west terrace.
 *
 * It exists because a measurement said so. `channelAt` falls over a smoothstep
 * spanning 38% of its width, whose steepest gradient is
 * `1.5 * depth / (0.38 * width)`; for a 76 m trough 24 m deep that is 1.18,
 * i.e. FIFTY DEGREES - measured at eight stations it runs 40 to 62 with a
 * median of 53 - and the reach lattice walks 38. The build without this
 * road scored carnelite 12 of 12 reachable at a minimum walk of 937 m - every
 * node reached the long way, the whole distance round the head of the gorge,
 * from a rim 150 m away from it and 23 m above it. Technically reachable and
 * functionally behind glass, which is the exact defect this project keeps
 * shipping with a passing test beside it.
 *
 * The alternative was to widen the trough until its own wall was walkable,
 * which needs `width >= 152` - a 304 m trough on an Anvil 145 m wide - and it
 * would have turned the gorge into a valley. A road is cheaper and it is the
 * better-looking answer: this planet's identity is that the ways through it are
 * CUT, and this is the third of them.
 *
 * It starts on the trough's outer LEVEE rather than at Anvil Deck, 78 m away.
 * A ramp reaching back to the pad would have had to descend across 78 m of
 * dead-level Anvil first, standing on a ten-metre embankment for most of it.
 * Beginning where the ground itself starts to fall keeps the whole road a cut
 * shelf and never a causeway - and there is no step at the head either way,
 * because a ramp with no `y0` takes the field height where it starts.
 *
 * Every vertex is at least 43 m from the gorge axis, checked and not assumed: a
 * ramp levels out to `width + blend` = 19 m either side of its line, so a
 * vertex any closer would start levelling the slot's own lip, and a levelled
 * slot lip is a staircase to the exotic tier.
 */
const RIMWAY = [[196, -150], [216, -128], [232, -108], [240, -84]];

/* ------------------------------------------------------------------ */
/* The descriptor                                                      */
/* ------------------------------------------------------------------ */

export const CARNELIAN = definePlanet({
  id: 'carnelian',
  name: 'Carnelian',
  blurb: 'High iron highlands. Two fault scarps, a hematite pavement, and one gorge cut 107 metres into the top shelf. Ochre on the flats, carnelite in the gorge wall, monazite on its floor.',

  half: HALF,
  /**
   * 280 segments over 880 m: a 3.143 m cell, the same texel-to-metre budget
   * Cinder runs at 3.125. The mesh and the collision heightfield are the SAME
   * grid, so this number buys both the skyline and the surface the player
   * stands on - and on this planet it is also what decides whether the gorge
   * floor is walkable, because the slot's floor measures 8-10 m and that is
   * three cells across.
   */
  seg: 280,

  /**
      * 0.75 g, and BOTH consumers read it.
     *
     * This used to say "Phase 1 does not retune the player integrator against
     * it", which was true and honest while gravity reached only the ship. It
     * reaches the player on foot now, through the one predicate in
     * `WorldRules.worldGravity`: `Piloting._env` gives the flight model
     * `(0, -7.40, 0)`, and `Player.setWorldGravity` converts 7.40 to a ratio
     * against `CONFIG.player.gravityReference` (9.81) and walks in -16.60 m/s²
     * rather than the global -22.
     *
     * Measured here by driving the real controller: apex 1.011 m, hang
     * 0.613 s, against 0.878 m / 0.533 s on a world that publishes no
     * gravity at all. At 0.75 g the difference is meant to be felt rather than
     * played with - the variety is at the other end of the ladder, on Tessera
     * (0.17 g) and Lathe (0.19 g).
     *
     * @see ../../player/Player.js `setWorldGravity`
     */
  gravity: 7.40,

  /* ---------------------------------------------------------------- */
  terrain: {
    seed: 0xca27e1,
    baseY: FLATS,
    /**
     * 6.0 m of swell at 240 m, and both numbers are LOWER and LONGER than
     * Cinder's 9.0 at 190.
     *
     * This planet's whole read is straight edges seen end-on. A swell big
     * enough to be interesting in its own right puts a 12 m wave through a
     * scarp crest that is supposed to be a level line, and the fault stops
     * looking like a fault. Long and shallow tilts the shelves instead of
     * corrugating them, which is what a faulted block actually does.
     */
    swell: { amp: 6.0, scale: 240, octaves: 4 },
    /** Ripple, ridged: deflation hollows and wind-scoured grain on the dust. */
    ripple: { amp: 1.5, scale: 31, octaves: 3 },
    /** Grain, at the scale of a footfall, so the normals never go glassy. */
    grain: { amp: 0.26, scale: 24 },
    /** The map edge falls away rather than walling up. */
    rim: { start: 396, drop: 26 },

    landforms: [
      /* ---- ADD ---------------------------------------------------- */

      /** FAULT ONE - the Low Scarp. */
      { kind: 'scarp', pts: LOW_FAULT, height: LOW_H, run: LOW_RUN, side: -1 },

      /** FAULT TWO - the Ironwall. Same sense, 200 m further east. */
      { kind: 'scarp', pts: HIGH_FAULT, height: HIGH_H, run: HIGH_RUN, side: -1 },

      /**
       * THE DUST TABLE - a flat-topped mesa on the Ochre Bench, at ABSOLUTE
       * y 84.
       *
       * A `plateau` and not a third scarp, and the difference is the point of
       * having both kinds. A scarp is a BOUNDARY: it raises a half-plane and
       * therefore always separates. A plateau is an ISLAND of level, so this
       * adds a fourth height to the stack without adding a fourth barrier, and
       * the eye gets a step it can also walk onto.
       *
       * It lives on the middle shelf and not on the Anvil because the Anvil is
       * only 145 m wide between the Ironwall and the gorge's trough, and a
       * table of this size on it had its eastern edge hanging over the canyon -
       * which is where the first version put it, and it made the gorge rim a
       * 132 m cliff with no approach to the trough wall at all. On the Ochre
       * Bench there is 200 m of room and it stands alone, which is what a mesa
       * should do.
       *
       * `edge: 56` rather than the 24 the scarps run at: 26 m over 56 m is 25
       * deg, which is walkable, and it has to be or the table is scenery.
       */
      { kind: 'plateau', x: -95, z: -60, r: 70, y: TABLE, edge: 56 },

      /**
       * Spoil ramparts along the Low Scarp's crest. 4.5 m of it: enough that
       * the crest line reads as a raised edge against the sky from the flats,
       * not enough to be a second obstacle on top of a 38 m one.
       */
      { kind: 'ridge', pts: [[-206, -300], [-222, -140], [-192, 40], [-208, 220]], width: 26, height: 4.5, taper: 0.3 },

      /* THERE IS NO RAMPART ALONG THE GORGE'S FAR LIP, AND THAT IS A DECISION.
       *
       * A fault-controlled canyon has an upthrown far block, and a 16 m `ridge`
       * along the far lip was built, measured and cut. The gorge axis runs
       * 140-180 m from the eastern map edge and its own trough is 112 m wide,
       * so there is no room OUTSIDE the trough for a far block: the ridge
       * landed 58 m from the axis, which is halfway UP the far wall, and it
       * took that wall from 50 to 66 degrees. A `scarp`, which is the honest
       * kind for an upthrown block, would have been worse - it raises a
       * half-plane with no ends, so it seals the entire eastern strip.
       *
       * What draws the far side instead is the `slope` override - 83 m of
       * near-vertical wall in the cool dark rock colour - and a scatter of
       * plates on the far terrace you can see across the void and never stand
       * on. For the far wall of a canyon that is the correct feeling anyway. */

      /* ---- CUT ---------------------------------------------------- */

      /**
       * THE GORGE, AS TWO CUTS ON ONE AXIS.
       *
       * This is the shape of the whole planet's economy and it is worth two
       * records. A single deep trench has near-vertical walls for its full
       * depth, which means it has no standable ground in it anywhere, which
       * means `carnelite` - which is IN THE GORGE WALL - has nowhere to be.
       * Cinder shipped that exact defect once: a corridor down a 13 m trench
       * with near-vertical walls, and the reach probe lost a whole seam on the
       * floor of it.
       *
       * So: an outer `channel`, wide and shallow with a soft profile, whose
       * flat bottom is a 28 m TERRACE on each side; and an inner `trench`,
       * narrow and deep with a cubed profile, dropped out of the middle of that
       * terrace. It is the compound profile a real canyon has - an inner gorge
       * inside an outer valley - and it is the reason there is anywhere to
       * stand between the rim and the floor.
       *
       * Outer: 76 m half-width, 24 m deep, `taper: 0.35` so it widens and
       * shallows southward the way a drainage does. Measured at eight stations
       * down the axis, its terrace sits at y 77.7-83.5 with a local slope of
       * 0.6-8.1 deg - level ground - and its WALL stands at 40-62 deg, median
       * 53. That is not walkable, which is why the Rimway is cut down it.
       * Inner: 20 m half-width, 83 m deep. Its wall is 85 deg at every one of
       * those stations and its floor is 9 m wide: you do not walk down off the
       * terrace, ever, and that is what makes the exotic tier a second landing
       * rather than a longer walk. Rim to floor, measured 135 m back from the
       * axis: 103-104 m.
       */
      { kind: 'channel', pts: GORGE, width: 76, depth: TROUGH_D, levee: 3.2, leveeWidth: 34, taper: 0.35 },
      /* `lip: 3.0` is spoil at the slot's edge, doing a legibility job as well
       * as a geological one: a 3 m lip at the brink is what stops the terrace
       * and the floor reading as one surface at distance, which on an 83 m drop
       * is worth having. */
      { kind: 'trench', pts: GORGE, width: 20, depth: SLOT_D, lip: 3.0, lipWidth: 16 },

      /**
       * SUNDER - an old crater on the Ochre Bench, 144 m across.
       *
       * Shallow (13 m in 72) and degraded, with a low 5.5 m ejecta rim: this is
       * a crater that has been filling with dust for a long time, which is the
       * only kind a planet with air and a dust cycle still has. Its job is
       * silhouette - two faults and a gorge are all LINES, and a map of nothing
       * but lines reads as a diagram. One circle fixes it.
       *
       * Placed at (-84, 290) because the Ochre Bench is only 227 m wide there
       * and a crater plus its ejecta is 216: it clears the Low Scarp by 4 m and
       * the Ironwall by 5. Any bigger and it straddles a fault, and a crater
       * that straddles a 44 m fault is a crater somebody cut in half.
       */
      { kind: 'crater', x: -84, z: 290, r: 72, depth: 13, rim: 5.5, rimWidth: 36, floor: 0.42 },

      /** THE CUP - the same thing on the flats, where it is the only relief
       *  Redgate can see to the south. Its floor at y 8 is the one place on the
       *  flats that drops into the band below them. */
      { kind: 'crater', x: -330, z: -250, r: 84, depth: 12, rim: 6.0, rimWidth: 42, floor: 0.40 },

      /** THE DIMPLE - a small one on the Anvil, so the top shelf has a shape in
       *  it too. Its ejecta laps the gorge's trough by about 13 m, which at 2 m
       *  of rim height there is a detail and not a landform. */
      { kind: 'crater', x: 90, z: 230, r: 54, depth: 11, rim: 4.5, rimWidth: 28, floor: 0.38 },

      /* ---- LEVEL -------------------------------------------------- *
       * ROADS FIRST, PADS LAST.
       *
       * Inside this layer a later form overrides an earlier one where they
       * overlap, and Volcanic.js records what the other order costs: a road
       * leaving a pad centre at grade takes its own grade off the pad, and a
       * 20 m disc with a 0.15 road through it has three metres of fall across
       * it. Measured there: 3.00 m of span before, 0.00 m after.              */

      /** The Low Stair. Measured: 152 m of road, y 21.2 to 56.6, 13.1 deg. */
      { kind: 'ramp', pts: LOW_STAIR, width: 9, blend: 14 },
      /** The High Stair. Measured: 148 m, y 59.7 to 102.4, 16.2 deg. */
      { kind: 'ramp', pts: HIGH_STAIR, width: 9, blend: 14 },
      /** The Rimway. Measured: 81 m, y 106.2 to 79.5, 18.3 deg - the steepest
       *  road on the planet and still half the wall it is cut into. Narrower
       *  than the two stairs (7 m against 9) because it is a shelf in a 53
       *  degree face and not a road over open ground, and a wider cut would eat
       *  the terrace it arrives on. */
      { kind: 'ramp', pts: RIMWAY, width: 7, blend: 12 },

      /** REDGATE. On the flats, and the largest pad on the planet because it is
       *  the one a player arrives on foot at with no idea where anything is. */
      { kind: 'pad', x: -300, z: 120, r: 30, blend: 24 },

      /** ANVIL DECK. On open Anvil, 159 m from the gorge axis - 47 m clear of
       *  the trough's outer edge, so the pad's own 44 m of disc and blend never
       *  touch the canyon - and 65 m from the High Stair's toe. */
      { kind: 'pad', x: 130, z: -200, r: 24, blend: 20 },

      /**
       * KILN DECK - the chamber on the gorge floor, and the second landing.
       *
       * No explicit `y`: it takes the pre-level field at its centre, which is
       * the slot floor, so the chamber is at whatever the floor actually is
       * rather than at a number somebody typed that the swell then disagreed
       * with. `r: 24` against a slot whose walkable floor is 8-10 m wide is
       * what makes this a CHAMBER - the pad's disc cuts the walls back to 24 m
       * on every side, and the 20 m blend outside that is an 81 degree apron
       * (measured, west of the pad between 24 and 48 m out).
       *
       * That apron is the mechanism of the whole design and it has a price: it
       * also SEVERS the terrace 24 m above it, because a 44 m disc centred on a
       * 40 m slot cannot help reaching the terrace on both sides. Placed near
       * the HEAD for that reason - up there the terrace is a stub, so the cut
       * costs 40 m of ledge instead of splitting 900 m of it in two, which is
       * exactly what a mid-gorge chamber did on the first build (carnelite fell
       * to 1 of 12 reachable).
       */
      { kind: 'pad', x: 292, z: -215, r: 24, blend: 20 },
    ],
  },

  /* ---------------------------------------------------------------- */
  palette: {
    /* `rock.neutral`, not `dirt.ground`. The library's dirt albedo measures
     * linear R:G:B = 1.79 : 1 : 0.49 - a brown filter with three and a half
     * times as much red as blue - and vertex bands MULTIPLY into it. On a red
     * planet that filter is nearly invisible and nearly fatal: it is exactly
     * what erases the cool plum gorge floor (`#2a1c26`, hue 320) and the pale
     * dust crests (`#c4a882`) that this table spends its whole budget on, and
     * leaves the "one flat salmon-brown hue" the header below is arguing
     * against. `rock.neutral` is the SAME grain at the same luminance with the
     * cast removed. @see shadeRockNeutral in gfx/Materials.js */
    material: 'rock.neutral',
    /* 4.5 m a tile against Cinder's 6.0. Iron hardpan is a finer-grained
     * surface than volcanic ash and it is lit by a smaller, harder sun, so the
     * texel density has to carry more of the detail the shadows are not
     * giving it. */
    tile: 4.5,
    /**
     * ══════════════════════════════════════════════════════════════════════
     *  THE PALETTE, AND THE TRAP IT IS AVOIDING
     * ══════════════════════════════════════════════════════════════════════
     *
     * Cinder shipped six bands across FIVE degrees of hue and ZERO points of
     * saturation change, and a tester who landed and walked it wrote: "One flat
     * salmon-brown hue, no rock, no ash, no vents, no heat, no shadows." Red
     * rock is the easiest surface in the game to repeat that on, because every
     * honest colour for it sits between 8 and 35 degrees of hue.
     *
     * The rule Volcanic.js arrived at is the one used here: KEEP THE VALUE
     * STRUCTURE, which is what makes a scarp read as a silhouette, and spend
     * everything else on hue and saturation, which cost nothing and were both
     * flat. Measured off this table with `THREE.Color.getHSL`, which is what
     * `planet-atmosphere.test.mjs` reads it with - so these are LINEAR-space
     * numbers and not the sRGB ones a colour picker shows:
     *
     *   height   colour     hue   sat  light   what it is
     *   y   2    #2a1c26    320    33     2    the gorge floor: near-black
     *                                          plum. COOL, because 103 m of
     *                                          wall means it is lit by sky and
     *                                          bounce and never by the sun
     *   y  10    #4a2a2c    357    49     5    the lowest wall, and The Cup
     *   y  22    #9a4e24     11    90    17    THE OCHRE FLATS. The most
     *                                          saturated band on the planet
     *   y  46    #c4a882     31    42    39    settled dust on the scarp
     *                                          crests and in Sunder - the
     *                                          LIGHTEST band, so the fault
     *                                          lines read as bright edges from
     *                                          below
     *   y  68    #6b3830      5    67     9    THE OCHRE BENCH: dark red-brown,
     *                                          a value dip so the two shelves
     *                                          separate
     *   y  90    #a5643c     15    79    21    the Dust Table and the gorge
     *                                          terrace: mid oxide red
     *   y 106    #bab7b3     34     4    47    THE ANVIL: specular hematite
     *                                          pavement, near-silver
     *
     * 74 degrees of hue spread and 85 points of saturation spread, against
     * `planet-atmosphere.test.mjs`'s floors of 40 and 15. The two that do the
     * work are the ends: a near-BLACK PLUM at the bottom and a near-SILVER at
     * the top are both true of iron oxide (manganese-stained shade, specular
     * hematite in the light) and neither exists anywhere on Sirocco, whose
     * whole range is one warm sand. The pale dust band at y 46 is the third: it
     * lands on the crest of each scarp, so from below the fault lines are
     * BRIGHT and the shelves behind them are dark, which is the layered read
     * the whole planet is for.
     *
     * Mean lightness 0.199, mean saturation 0.520. The fog below is held
     * against both by `planet-atmosphere.test.mjs`, which re-derives them from
     * this table every run rather than from a copy - measured, fog L 0.425
     * against a required 0.229 and fog S 0.184 against a ceiling of 0.540.
     */
    bands: [
      { upTo: 2, color: 0x2a1c26 },
      { upTo: 10, color: 0x4a2a2c },
      { upTo: 22, color: 0x9a4e24 },
      { upTo: 46, color: 0xc4a882 },
      { upTo: 68, color: 0x6b3830 },
      /* The last two boundaries are DERIVED from the surfaces they colour
       * rather than typed, because those two are the ones that would go wrong
       * quietly: move the Ironwall's throw and a hard-coded 106 leaves the
       * hematite pavement painted in the shelf below it, with nothing to say
       * so. Six metres over the Dust Table and four over the Anvil is the
       * swell's own half-amplitude, so each shelf sits inside its band even
       * where the noise lifts it. */
      { upTo: TABLE + 6, color: 0xa5643c },
      { upTo: ANVIL + 4, color: 0xbab7b3 },
    ],
    /**
     * Fresh rock on anything steep, and on this planet that is the scarp faces
     * and the gorge walls - which between them are most of what the player
     * looks AT rather than stands on.
     *
     * `fromDeg: 28` is lower than Cinder's 32 on purpose: the three roads run
     * at 14-17 deg and the shelves at 0-8, so there is a wide empty band
     * between "ground" and "wall" here that nothing else uses, and starting the
     * override early means the base of every face has a gradient in it instead
     * of a line. The colour is a cool dark purple-brown - unoxidised iron under
     * the weathering rind, which is what a fresh scarp face is.
     */
    slope: { fromDeg: 28, toDeg: 54, color: 0x3b2a2e },
    /**
     * Desert varnish: manganese-black staining in patches, which is what
     * actually happens to exposed iron rock in a dry high atmosphere over a
     * long time.
     *
     * DARK, where Cinder's is bright orange, and that is the deliberate half of
     * it. A pale mottle on a shelf whose band is already near-silver would wash
     * the Anvil out to one flat grey; a dark violet one puts BLACK PATCHES on
     * the silver and red drift on the shelves below, so the term that stops the
     * bands reading as a contour map is also the term that puts the "near-black
     * in shadow" note everywhere rather than only at the bottom of the gorge.
     * Applied as `n * n * amount`, so most of the field never gets near the
     * ceiling.
     */
    mottle: { scale: 58, amount: 0.62, color: 0x53384f },
  },

  sky: {
    kind: 'alpine',
    params: {
      /**
       * THE SINGLE BIGGEST DIFFERENCE FROM THE OTHER TWO RED PLANETS.
       *
       * Cinder is `daylight` with `rayleigh: 0.12, mie: 4.4` - an orange dust
       * sky with no blue in it at all, and Sirocco is the same trick with a
       * fatter halo. This is the opposite atmosphere: Rayleigh 3.6 against 0.12
       * and Mie 0.20 against 4.4, at 3,400 m of altitude. A deep blue-violet
       * zenith over red ground.
       *
       * That is not a flourish, it is what `Bodies.js` already says about this
       * body: thin air (1.5 km against Sirocco's 2.2), "the descent is short
       * and the ground is visible for most of it". An atmosphere you can see
       * through from orbit is one that scatters short and scatters little, and
       * the ground-level consequence is a dark sky and hard light.
       *
       * The direction is west-south-west and 40 deg up, which is BEHIND AND
       * LEFT of a player standing at Redgate looking east - so both fault
       * faces, which look west, are lit rather than silhouetted. A planet gets
       * looked at from its landing sites, so its key light is chosen from one
       * of them and not from the origin.
       */
      sunDirection: [-0.66, 0.64, 0.39],
      /* Small and near-white. `sunAngularSize` 0.016 against Cinder's 0.026:
       * thin clean air does not spread the disc, and a small hard sun is what
       * puts a crisp shadow off a scarp crest 800 m long. */
      sunColor: 0xfff2e2,
      sunIntensity: 15,
      sunAngularSize: 0.016,
      rayleigh: 3.6,
      mie: 0.20,
      mieG: 0.70,
      altitude: 3400,
      /* Bounce off the red ground into the bottom of the dome. This is the one
       * place the sky is allowed to be the colour of the planet. */
      groundColor: 0x6a3524,
      /* And a pale rose horizon band, thin: `horizonHaze` 0.30 against Cinder's
       * 0.88. The horizon is where the two skies differ most - here you can see
       * a scarp 800 m away and read its face; on Sirocco you cannot see one at
       * 300. */
      hazeColor: 0xd8b0a8,
      horizonHaze: 0.30,
      /* High thin ice, sparse and slow. There is not enough water in this air
       * for anything else, and a moving cloud deck would fight the hard shadows
       * the whole planet is lit by. */
      cirrus: 0.16,
      cirrusScale: 2.8,
      cirrusSpeed: 0.0016,
    },
    /* Deep blue-violet behind everything, so the sky reads as thin even at the
     * zenith where the dome shader is darkest. */
    background: 0x2b3050,
    /**
     * ── THE FOG, AND WHY IT IS BLUE ───────────────────────────────────────
     *
     * `half` is 440, so the playfield is 880 m square and its diagonal is
     * 1,245 m. Two hard rules from `planet-atmosphere.test.mjs`, both
     * re-derived from the palette above on every run:
     *
     *   `far` must exceed the diagonal, or the player watches the world stop.
     *   The fog must be LIGHTER and GREYER than the ground bands under it,
     *   because a fog the colour of the rock is what deleted Cinder's horizon.
     *
     * 1,450 rather than the 1.1x (1,369) the house rule suggests, and that is
     * the alpine decision made in one number: at 1,369 the far corner is fully
     * extinguished and this planet's whole claim - that distance reads as
     * CONTRAST and not as haze - is false at the map edge. 1,450 leaves the far
     * corner about 86% extinguished, so the rim still dissolves but a scarp at
     * 800 m is still a scarp with a face on it. Well under the 2,000 m far
     * plane, so nothing pops at the clip.
     *
     * `near: 260` against Cinder's 120. The first 260 m are unfogged: in thin
     * air the near field is CLEAR, and that clarity is the thing a player
     * notices in the first five seconds after landing.
     *
     * BLUE-GREY (#9fa4bc, L 0.425, S 0.184 linear) over red rock (mean L 0.199,
     * mean S 0.520). It looks wrong written down and it is right on the screen:
     * aerial perspective at altitude is Rayleigh, so distant red rock goes
     * blue, and the complementary shift is what makes 800 m of distance legible
     * with almost no density at all. It is also the cheapest way this planet
     * cannot be mistaken for Sirocco, whose haze is its own dust.
     */
    fog: { color: 0x9fa4bc, near: 260, far: 1450 },
    /**
     * ── THE LIGHT ─────────────────────────────────────────────────────────
     *
     * A COLD BLUE FILL UNDER A WARM KEY, and here the fill's colour is doing
     * structural work rather than atmospheric work. The brief asks for cooler
     * purple-browns in shadow; painting that into the bands would spend hue on
     * something that is really a lighting property, and would put purple on the
     * sunlit side too. Lighting it instead means every west-facing scarp face
     * is warm oxide and every east-facing one is a cold violet - one palette,
     * two readings, and they swap as the sun moves.
     *
     * 0.38 against 5.6 is a fill/key of 0.068, well inside the 0.12 ceiling
     * `planet-atmosphere.test.mjs` puts on a terminator, and above the 0.30
     * floor that keeps the shadow side out of pure black. Thin air genuinely
     * scatters less fill than Cinder's dust does, which is why this is 0.38
     * where Cinder is 0.46, and why the shadows here have edges.
     */
    ambient: { color: 0x5a6a8c, intensity: 0.38 },
    sun: { color: 0xffeeda, intensity: 5.6, direction: [-0.66, 0.64, 0.39] },
    exposure: 1.12,
    /**
     * `space`, not `dock`.
     *
     * `GRADE_PRESETS` is keyed on WORLD id and a planet is not in it, so naming
     * one here is the only way a planet gets a calibrated look. Cinder borrows
     * `dock` - warm world, cold shadows, 0.038 of lens haze. This one borrows
     * `space`, whose own docblock says it is "hard, clean and almost
     * ungraded... everything this preset does is subtractive - no haze, no
     * shafts", with contrast at 1.16 and the balance pushed cold. That is the
     * grade for a world whose entire pitch is that the air is not in the way,
     * and it is the third place in this file the same idea gets spent.
     *
     * Its bloom threshold is 1.60, the lowest in the game, and that is accepted
     * rather than overridden: the only emissives here are the two rare ores,
     * and a carnelite flake that flares slightly against a dark gorge wall is
     * the read this planet's economy wants.
     */
    grade: 'space',
  },

  /* ---------------------------------------------------------------- *
   * NO LIQUID.
   *
   * There is none on this planet - it is high, dry and cold, and the item
   * catalogue's own line on ochre is "iron-stained dust, red as a wound". So
   * `liquid` is null, which means `clearOfLiquid` is a filter with nothing to
   * clear and none of the regions below declares one. Said out loud because an
   * absent block reads the same as a forgotten one.                           */
  liquid: null,

  /* ---------------------------------------------------------------- */
  props: [
    {
      /**
       * THE IRONWALL PLATES - `slabs` along fault two.
       *
       * `slabs` is the kind this planet exists for. `PlanetProps` builds them
       * as tilted, yawed, jittered flat sheets with a rotated step collider,
       * and a scree of upended plates below a fault face is exactly what bedded
       * ironstone does when a scarp retreats. Cinder's colonnade is hexagonal
       * columns and Sirocco has dunes; nothing else in the system has a field
       * of tilted sheets.
       *
       * The tint range is the near-silver the top band promises, carried down
       * to eye level where the player can actually see it: two pale speculars
       * against two dark irons, so a plate catching the sun is the brightest
       * small object on the planet.
       */
      id: 'ironwall_plates',
      kind: 'slabs',
      region: { shape: 'corridor', pts: HIGH_FAULT, width: 58, slopeMaxDeg: 34, clearOfPads: 4 },
      count: 380, spacing: 5.4,
      size: { w: [1.6, 5.4], d: [1.2, 4.2], t: [0.22, 0.70], tilt: 0.85 },
      tint: [0x8a8078, 0x5c534c, 0xa39a90, 0x3d3631],
      collide: true,
    },
    {
      /** THE LOW TALUS - blocky scree below fault one. Rounder and darker than
       *  the Ironwall's plates: this face is 200 m further into the dust and
       *  everything on it has been sandblasted. */
      id: 'low_talus',
      kind: 'boulders',
      region: { shape: 'corridor', pts: LOW_FAULT, width: 54, slopeMaxDeg: 36, clearOfPads: 4 },
      count: 460, spacing: 4.8,
      size: { rMin: 0.5, rMax: 2.6 },
      tint: [0x4a2c20, 0x35201a, 0x5b3826, 0x281813],
      collide: true,
    },
    {
      /**
       * THE TERRACE PLATES - the same kind again, in the gorge, and bigger.
       *
       * The terrace is the floor of the outer trough and the roof of the inner
       * slot, so what lies on it is slabbed wall rock off both. These run up to
       * 7.6 m across against the Ironwall's 5.4 - a plate that fell 24 m is a
       * bigger plate than one that slid - and they are the cover carnelite is
       * found among.
       *
       * Left SYMMETRIC about the axis, unlike the carnelite seam, and that is
       * deliberate. The far terrace has no road down onto it: measured, it is
       * 493 to 1,128 m on foot from Anvil Deck, all of it round the head of the
       * gorge, against 232-683 m for the near one down the Rimway. So in
       * practice the plates over there are the thing you look ACROSS at. Ore at
       * the end of a kilometre detour is a lie about where the seam is; scenery
       * at the end of one is a canyon.
       */
      id: 'terrace_plates',
      kind: 'slabs',
      region: { shape: 'corridor', pts: DEEP_REACH, width: 50, widthInner: 24, slopeMaxDeg: 24, clearOfPads: 4 },
      count: 240, spacing: 6.0,
      size: { w: [2.2, 7.6], d: [1.6, 5.2], t: [0.30, 0.95], tilt: 0.62 },
      tint: [0x7a4a34, 0x9c6440, 0x4e2f22, 0xb08a6a],
      collide: true,
    },
    {
      /** DEFLATION LAG - the wind-graded stone left wherever the dust has blown
       *  off. Small and thin: this is the field that stops the open shelves
       *  reading as carpet, not a boulder field in its own right. */
      id: 'lag',
      kind: 'boulders',
      region: { shape: 'field', slopeMaxDeg: 28, clearOfPads: 6 },
      count: 900, spacing: 8.5,
      size: { rMin: 0.35, rMax: 1.9 },
      tint: [0x6b3f2a, 0x4a2b1e, 0x84573a, 0x2f1c16],
      collide: true,
    },
    {
      /**
       * SUNDER HOODOOS - `spires` on the old crater's rim.
       *
       * Wind-cut pinnacles out of the crater's own ejecta blanket, which after
       * this long is the softest rock on the shelf. A concave taper and a
       * random lean off plumb, so a field reads as grown rather than placed -
       * and it gives the Ochre Bench, which is otherwise 200 m of open dust,
       * one thing at human scale to walk through.
       */
      id: 'sunder_hoodoos',
      kind: 'spires',
      region: { shape: 'annulus', x: -84, z: 290, r0: 46, r1: 104, slopeMaxDeg: 30 },
      count: 130, spacing: 7.5,
      size: { h: [2.4, 9.5], base: [0.55, 1.9], lean: 0.22, facets: 6 },
      tint: [0x8a5230, 0xa8724a, 0x63381f, 0xc0937a],
      collide: true,
    },
  ],

  /* ---------------------------------------------------------------- *
   * MINERALS - four elements, four places, and one of them costs a second
   * landing.
   *
   *   rarity     element     terrain     where, and the MEASURED walk to it
   *   ---------  ----------  ----------  ---------------------------------
   *   common     ochre       plain       the Ochre Flats. 36 m from Redgate,
   *                                      median 240. Bulky: 3 m3 for 45 cr
   *   uncommon   hematite    highland    both aprons of the Ironwall and
   *                                      NEITHER its face. 98 m from Anvil
   *                                      Deck, median 392 over the two pads
   *   rare       carnelite   outcrop     the gorge's west terrace, 215 m from
   *                                      Anvil Deck down the Rimway (median
   *                                      344, max 453) - or 989 m from
   *                                      Redgate over both stairs first
   *   exotic     monazite    channel     the slot floor. 34 m from Kiln Deck,
   *                                      and 0 of 7 from Redgate or Anvil
   *                                      Deck at ANY distance
   *
   * Every one of those metres is flooded over a 2 m lattice against the real
   * colliders, no jump and no mantle, the same envelope
   * `planet-minerals.test.mjs` uses. Redgate and Anvil Deck each reach 149,986
   * standable cells; Kiln Deck reaches 1,005, and they are the gorge floor.
   *
   * `credits` is absent from every row on purpose: `definePlanet` computes it
   * from `unitValue * hold` and REFUSES a hand-written one. `size` is the node
   * radius AND the hold volume, so the cheap ore is the bulky ore - three cubic
   * metres of ochre for 45 credits against one of monazite for 470. In a 10 m3
   * Kestrel that is the entire decision, and here it is sharper than on Cinder
   * because the expensive end is at the bottom of a hole you have to land a
   * second time to reach.                                                     */
  minerals: [
    {
      id: 'ochre', item: 'ochre', name: 'Ochre Earth',
      rarity: 'common', terrain: 'plain', place: 'The Ochre Flats',
      /* Darker than the item's own swatch (0xb85c28) for the reason
       * Volcanic.js records beside tephra: the CHEAPEST ore on a planet must
       * not be its most conspicuous object. 0x8f4a24 sits between the lag
       * boulders and the dust it is caked to, so you find it by walking rather
       * than by looking. */
      color: 0x8f4a24, glow: 0,
      unitValue: ORE('ochre'), spread: 0.25,
      /* 1.75 m: the biggest node on the planet and the least valuable.
       * `holdUnitsFor` rounds `size * 1.6`, so this is 3 m3 a lump and a stock
       * Kestrel holds three of them. */
      size: 1.75, count: 38, spacing: 20,
      /**
       * A `rect` AND NOT A `field`, and it is the gorge that forces it.
       *
       * `field` plus `yMax` is the obvious way to say "the low ground", and on
       * this planet it is wrong: the gorge floor is at y -2, LOWER than the
       * flats, so any height window that admits the plain also admits the
       * bottom of the slot. Common ore in the one place on the map that costs a
       * second landing to stand in is the rarity ladder run backwards.
       *
       * The rect stops at x -264, which is 28 m west of the Low Fault's most
       * westerly point and 4 m clear of the toe of its 24 m run. `yMin: 5` then
       * keeps it off the dropped map rim and out of the bottom of The Cup, and
       * `yMax` - the datum plus 14, more than twice the swell's amplitude -
       * off the scarp crest.
       */
      region: { shape: 'rect', x0: -440, z0: -440, x1: -264, z1: 440, yMin: 5, yMax: FLATS + 14, slopeMaxDeg: 20, clearOfPads: 6 },
    },
    {
      id: 'hematite', item: 'hematite', name: 'Hematite',
      rarity: 'uncommon', terrain: 'highland', place: 'The Ironwall',
      /* Specular grey with a cold cast. The item's line is "held to the light
       * it is silver; held to the ground it is the same red as everything
       * else", and a cold neutral is the one hue nothing else has at eye level:
       * the ground is red-brown, the ore below it is orange, the ore below that
       * is gold. */
      color: 0x8e9298, glow: 0,
      unitValue: ORE('hematite'), spread: 0.25,
      size: 1.15, count: 20, spacing: 15,
      /**
       * THE TWO APRONS OF THE FAULT, AND NOT ITS FACE.
       *
       * `widthInner: 30` is the hollow that excludes the scarp itself. The face
       * falls 44 m over a 26 m run on the western side of the line and is
       * instantaneous on the eastern, so the whole of it lives inside 26 m of
       * the trace: a corridor without the hollow puts a seam on a 59 degree
       * wall, which is Cinder's sulfur defect with different rock.
       *
       * What is left is a 34 m band on each side - the scree apron on the Ochre
       * Bench below and the crest pavement on the Anvil above - and that is not
       * a compromise with the geology, it IS the geology: specular plates
       * weather OUT of a face and come to rest above and below it, never on it.
       * The fix and the mineralogy are the same fix.
       *
       * It also makes hematite the one ore reachable from both walkable
       * shelves, which is what an uncommon tier should be: on the way to
       * somewhere, rather than at the end of a decision.
       */
      region: { shape: 'corridor', pts: HIGH_FAULT, width: 64, widthInner: 30, slopeMaxDeg: 20, clearOfPads: 5 },
    },
    {
      id: 'carnelite', item: 'carnelite', name: 'Carnelite',
      rarity: 'rare', terrain: 'outcrop', place: 'Vermilion Gorge, the west terrace',
      /* Banded orange chalcedony, and it GLOWS - faintly, on a dark terrace,
       * under a `space` grade whose bloom threshold is 1.60. The planet is
       * named for this stone and it should be the first thing you see when you
       * come down the Rimway. */
      color: 0xe0652a, glow: 0x5a1c04,
      unitValue: ORE('carnelite'), spread: 0.25,
      size: 0.85, count: 12, spacing: 14,
      /**
       * IN THE WALL, WHICH MEANS ON THE TERRACE - AND THE TERRACE HAD TO BE
       * BUILT FOR IT.
       *
       * Cinder lost a sulfur seam by authoring a corridor that included the
       * floor of a trench with near-vertical walls. The lesson taken here is
       * one landform earlier: a gorge that is ONLY a slot has no wall a body
       * can stand on at all, so the compound profile above exists so that this
       * seam has somewhere to be. The outer trough's flat bottom is that wall
       * terrace - 28 m of near-level rock 24 m below the rim and 83 m above the
       * floor - and carnelite bands out of the slot's lip along it.
       *
       * The region is CARNELITE_BAND, the axis offset 34 m west, at a width of
       * 18: every node therefore lands between 16 and 52 m from the axis, which
       * is the terrace exactly - the slot's spoil lip dies at 36 and the
       * trough's wall starts to climb at 48, and `slopeMaxDeg: 20` rejects
       * whatever either of them left steep at the two ends of the range.
       *
       * Offset rather than hollowed for two measured reasons, both recorded on
       * CARNELITE_BAND: a symmetric corridor puts a third of the seam on the
       * FAR terrace, which has no road and costs 493-1,128 m round the head of
       * the gorge instead of 215 down the Rimway - and on the layout that
       * preceded this one it was not reachable at all. The second is that the
       * Kiln's apron severs the near terrace at its own latitude.
       */
      region: { shape: 'corridor', pts: CARNELITE_BAND, width: 18, slopeMaxDeg: 20, clearOfPads: 3 },
    },
    {
      id: 'monazite', item: 'monazite', name: 'Monazite',
      rarity: 'exotic', terrain: 'channel', place: 'the floor of the Deep Reach',
      /* Warm gold against a plum-black floor, and the only warm thing down
       * there: 107 m of wall means the floor is lit by sky and bounce, so a
       * glow is the only way an object on it reads at all. */
      color: 0xd9b256, glow: 0x7a4a08,
      unitValue: ORE('monazite'), spread: 0.25,
      /* The smallest node on the planet and the dearest. One cubic metre, 470
       * credits: a stock Kestrel can carry all seven, which is the trip this
       * ore exists to make worth flying twice. */
      size: 0.60, count: 7, spacing: 20,
      /**
       * THE FLOOR, AND ONLY THE FLOOR - WHICH IS THE WHOLE DESIGN.
       *
       * `width: 9` against a slot whose walkable floor measures 8-10 m. The
       * trench profile is cubed, so the floor is flat within about 5 m of the
       * axis and past 6 m it is already over 38 degrees; a wider corridor would
       * put nodes on the bottom of the wall, where the reach probe finds
       * nothing standing.
       *
       * `clearOfPads: 3` rather than something bigger on purpose: these are
       * MEANT to be a short walk from Kiln Deck up and down the slot. The
       * expense of this ore is not the walk, it is that you had to land twice.
       *
       * Measured: 0 of 7 from Redgate, 0 of 7 from Anvil Deck, 7 of 7 from Kiln
       * Deck. That is the row this planet is built around, and it is the shape
       * Cinder's iridite has - the rarest thing costs a DECISION, not time.
       */
      region: { shape: 'corridor', pts: DEEP_REACH, width: 9, slopeMaxDeg: 20, clearOfPads: 3 },
    },
  ],

  /* ---------------------------------------------------------------- */
  /**
   * ═════════════════════════════════════════════════════════════════════════
   *  THE PAD YOU ARRIVE AT, AND WHY IT IS NO LONGER REDGATE
   * ═════════════════════════════════════════════════════════════════════════
   *
   * The registry-wide rule, asserted for all ten planets by
   * `planet-envelope.test.mjs`: the arrival pad is the RICHEST pad that is
   * RETURNABLE and carries no EXOTIC seam. Cinder established it and
   * `planets/Volcanic.js` records what it cost to find. Carnelian was one of
   * four planets still failing it.
   *
   * Measured, a best-value 10 m3 Kestrel load off each pad's own nearest seams:
   *
   *     redgate      823 cr     ochre, and ochre alone. The common ore is the
   *                             ground the pad stands on and it is the BULKY
   *                             one - 3 m3 a lump - so the hold fills on
   *                             volume before it fills on value.
   *     anvil      2,134 cr     2.59x. Hematite at 98 m and carnelite at 163 m
   *                             down the Rimway, both worth more per cubic
   *                             metre than anything on the Flats.
   *     kiln       5,205 cr     the richest pad on the planet, and refused
   *                             twice over - see below.
   *
   * ── WHY NOT THE KILN, WHICH IS RICHER THAN BOTH TOGETHER ─────────────────
   *
   *   1. It is the EXOTIC pad. Monazite is 7 of 7 from Kiln Deck and 0 of 7
   *      from here at every envelope the game can be played in. An arrival pad
   *      that reaches the exotic seam deletes the second landing, which is what
   *      this planet is built around.
   *   2. It is ONE-WAY. `PlanetWorld._padReturn` floods the collision bed out
   *      of the disc and back: 49.8% of what a body can walk to from the Kiln
   *      can walk back. The slot walls stand at 85 degrees for their whole
   *      length and the chamber apron at 81 - you go down the Deep Reach and
   *      you do not come up it.
   *
   *      AND THE RIM PROXY WOULD HAVE ALLOWED IT. `_padDrop` reads 0 degrees
   *      on Kiln Deck, because the chamber floor is level and the 8 m sill is
   *      measured on the ground AROUND the disc rather than on the way off the
   *      planet. This is the pad in the registry where "is there a cliff behind
   *      it" and "can you get back onto it" disagree hardest, and it is why
   *      `SpaceObjectives.padIsHome` reads the flood and keeps the rim only as
   *      a fallback.
   *
   * ── WHAT WAS MEASURED BEFORE THE FLAG MOVED ──────────────────────────────
   *
   *   the exotic guarantee survives   monazite 0/7 from Anvil Deck at the
   *                                   legacy 38 deg envelope, at the real
   *                                   56.63 deg one, again with Carnelian's own
   *                                   1.02 m jump apex, and again with the swim
   *                                   envelope on top. Byte-identical to
   *                                   Redgate's own 0/7 in all four columns.
   *                                   Only the Kiln reaches it: 7/7 at 34 m.
   *   the pad is a round trip         92.2% of everything a body can walk to
   *                                   from Anvil Deck can walk back - the same
   *                                   figure Redgate reads, because the two
   *                                   stairs make the whole east of the map one
   *                                   region. Not one-way, so no hazard ring.
   *   nothing below exotic is lost    ochre 38/38, hematite 20/20, carnelite
   *                                   12/12 from Anvil Deck, at every envelope.
   *                                   What changes is the WALK: hematite goes
   *                                   341 m -> 98 and carnelite 1,087 m -> 163,
   *                                   while ochre goes 36 m -> 878. The common
   *                                   ore is now the far one, which is the
   *                                   right way round for a rarity ladder.
   *
   * ── AND THE DISC WAS MEASURED, NOT ASSUMED ───────────────────────────────
   *
   * The objection to any of these moves is that it puts a first landing on a
   * smaller disc. Anvil Deck is 24 m against Redgate's 30, and the ground
   * inside it measures 0.000 m of relief and 0.0 degrees of grade over the full
   * 24 - it is the hematite pavement, the flattest ground on the planet. 48 m
   * across holds a 14 m Kestrel or a 28 m Dray with room either side.
   *
   * Widening it is refused by the pavement itself rather than by taste: the
   * `pad` landform is r 24 with a 16 m blend, and sampled past its own rim the
   * disc starts to inherit the shelf's swell - 0.06 m of relief at r 26, 0.20
   * at r 28, 0.39 at r 30. The rim stays 0 degrees throughout, so nothing is
   * gained and the deck stops being level. 24 m is the disc the pavement has.
   *
   * ── WHAT IS LOST, SAID PLAINLY ───────────────────────────────────────────
   *
   * Redgate's first frame was the staircase: the Low Scarp as the near horizon,
   * the Dust Table over it, the Anvil's silver crest behind both. That was the
   * planet introducing itself, and arriving on the Anvil spends it. What is
   * bought is the other end of the same shape - the first frame is now 159 m of
   * silver pavement and then a 107 m hole in it - and two round trips instead
   * of five for the first ore rung. Redgate is still authored, still reachable,
   * and `SpaceObjectives.richerPad` still names Anvil Deck to a player who
   * lands there on purpose.
   */
  landing: [
    {
      /* Facing east-north-east: from here the Low Scarp is the near horizon,
       * the Dust Table stands over it and the Anvil's silver crest is the
       * skyline behind both - the staircase, end-on, which is what this planet
       * is about. It is no longer the first frame (see the block above); it is
       * the one a player who flies back down to the Flats gets. */
      id: 'redgate', name: 'Redgate', x: -300, z: 120, r: 30, yaw: -1.11,
    },
    {
      /* THE PRIMARY. Facing east-south-east, at the gorge: 159 m of open
       * pavement, then a 107 m hole with a road cut down into it. */
      id: 'anvil', name: 'Anvil Deck', x: 130, z: -200, r: 24, primary: true, yaw: -1.35,
    },
    {
      /* Facing north, up the slot at the box-canyon head 40 m away. */
      id: 'kiln', name: 'Kiln Deck', x: 292, z: -215, r: 22, yaw: -0.08,
    },
  ],

  hazards: {
    /** Fine iron dust in suspension. Thin - 0.18 against Cinder's 0.35 - and
     *  that number makes the same claim the sky does: this air does not hold
     *  much. It is here to give the light something to land on, not to hide the
     *  distance. */
    ashfall: { density: 0.18, drift: [0.85, -0.15] },
    ashColor: 0xc9a488,
  },
});

export default CARNELIAN;
