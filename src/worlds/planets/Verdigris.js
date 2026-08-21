/**
 * VERDIGRIS - the biotic world, and the only living surface in the system.
 *
 * ==========================================================================
 *  THE MAP, in words
 * ==========================================================================
 *
 * 860 m square, `+x` east and `+z` south. The world is TWO LEVELS and the gap
 * between them is the planet: a forested upland at y 74, and a river gorge cut
 * 55-68 m into it whose rims are LINES rather than slopes. You land on top or
 * you land in the bottom, and they are different places with different ore.
 *
 *   THE GREENSPAN      the upland, and the primary landing. A bench of open
 *                      sward and standing growth east of the gorge, y 74 with
 *                      about 8 m of swell on it. Humic nodules lie in the open
 *                      ground; the resinwood canopy starts a hundred metres
 *                      south of the pad. THE HORN, a 46 m forested knoll at
 *                      (-20, -320), is the landmark you steer by from anywhere
 *                      on the bench - it is the only thing on the Greenspan
 *                      taller than a tree.
 *
 *   THE GREEN CUT      the river gorge, running the full height of the map
 *                      near x -190. A 92 m corridor between two fault scarps,
 *                      with a 46 m channel cut down the middle of it: rim at
 *                      74, floor from 20.3 in the north to 5.7 in the south,
 *                      and a 20 m river down the middle of a 52 m floor. That
 *                      leaves 16 m of dry bank each side, and the east bank is
 *                      where malachite is. SUMPHEAD, the second landing, is a
 *                      40 m shelf blasted into the east wall AT RIVER LEVEL
 *                      (-140, 300) - the only flat ground down there wide
 *                      enough to set a hull on.
 *
 *   THE STAIRGILL      the only walking route between the two levels. A side
 *                      gully leaving the primary pad's own centre, cutting 30 m
 *                      into the bench over 180 m, then running down the inside
 *                      of the east wall to the gorge floor. 313 m of polyline
 *                      at a measured 12.2 deg, which floods at 387 walking
 *                      metres from the pad to the water. Delete it and the
 *                      whole lower half of the planet needs a second landing.
 *
 *   THE UNDERCROFT     a 16 m slot driven 125 m east off the gorge floor into
 *                      the massif under the Greenspan, floor 7.3 falling to
 *                      2.6, walls 67-71 m on both sides, ending in a 36 m
 *                      chamber. Sporecryst grows in it and pale fungal spires
 *                      light it. It is NOT roofed - see the note at the head of
 *                      the sporecryst row; a `PlanetWorld` planet is a
 *                      single-valued heightfield and cannot be.
 *
 *   SHELFWOOD          the low canopy mesa, (190, 205), 250 m across, top at
 *                      104 with a face measured at 50.7-68.2 deg on every
 *                      bearing. Standing growth on top - a canopy you walk out
 *                      on to - and THE SHELF ROAD, a 409 m cut-and-fill road
 *                      that wraps 168 deg of the face at 4.2 deg, so a player
 *                      who arrived on foot has a way up.
 *
 *   THE CROWN          the high canopy mesa, (210, -230), 200 m across, top at
 *                      146 with a face measured at 75.6-76.5 deg on all 64
 *                      bearings sampled, and NO ground route at all. Its
 *                      canopy is taller and paler than Shelfwood's, it holds a
 *                      rain-catch tarn at (156, -282), and the verdite is up
 *                      there. It is the skyline from everywhere on the bench
 *                      and it is a SECOND LANDING, not a longer walk.
 *
 * ==========================================================================
 *  WHY THE NUMBERS ARE THESE NUMBERS
 * ==========================================================================
 *
 * -- The relief budget --------------------------------------------------
 *
 * Measured over a 741,321-sample grid at 1 m: y runs -0.19 to 152.50, a range
 * of 152.7 m, and not one sample is non-finite. The low is a map corner where
 * the rim falloff bites; the high is the Crown's north spine. Against that, the
 * noise budget is 8.2 m - swell 6.0 + ripple 1.9 + grain 0.26 - which is the
 * last 5.4%, and its only job is to stop the authored shapes reading as CAD.
 * Every metre of the other 144 is a named place above.
 *
 * -- Why the rim is a scarp pair and not a wide channel ------------------
 *
 * The identity of this planet is that the mesa top and the gorge floor are the
 * SAME feature seen from two sides, and that only reads if the boundary between
 * them is a LINE. A `channel` on its own gives a V with a rounded lip: the
 * ground eases into the cut and there is no moment at which you are on the rim.
 * So the gorge is built as three records, not one:
 *
 *   two `scarp`s at +/-46 m from the river, facing outward, 26 m in 9 m (71
 *   deg), which raises the whole bench and leaves a 92 m corridor at base
 *   level with a hard edge down each side;
 *   one `channel` 46 m wide and 38 m deep down the middle of that corridor,
 *   whose own cut vanishes exactly at 46 m - i.e. exactly at the scarp lines.
 *
 * The two therefore meet with no overlap and no gap, and the rim crest is the
 * scarp's own top edge: flat ground, then the whole wall in sixteen metres.
 * Measured across the east wall at z -100, in metres from the river centreline:
 *
 *   d 56  y 77.5    d 46  y 76.6    d 42  y 61.7    d 37  y 27.0    d 30  y 14.2
 *
 * i.e. dead flat to d 46, then 62.4 m of fall in the next sixteen metres. That
 * is the line, and it is why you can stand on the rim and look down rather than
 * finding yourself already on the slope.
 *
 * `scarp` extends its polyline far past both ends before sampling (see
 * `PlanetHeight.extendPolyline`), so the raised half-plane cannot stop dead
 * inside the playfield. That is why the river polyline runs from z -470 to
 * z +470 on a map that ends at +/-430: the gorge leaves the world at both ends
 * rather than terminating in it.
 *
 * -- Why the gorge floor is a `ramp` and not just the channel's floor ----
 *
 * Volcanic.js records that a lake whose level came out of the terrain under it
 * tilted twelve metres across a single circle. The same applies to a river: the
 * `channel` cuts a CONSTANT 38 m out of whatever it lands on, so its floor
 * inherits every metre of the 175 m swell and the river would run uphill in
 * places. A `ramp` down the river's own polyline is a LEVEL, so the floor is a
 * dead-linear 21.0 -> 5.0 over 962 m of arclength - a 1.7% grade, which is a
 * river grade - and the water ribbon above it interpolates over the SAME
 * arclength, so a constant 1.1 m offset keeps the river the same depth
 * everywhere. That constant offset is the same trick Cinder's outlet flow uses
 * and it is the only choice that does.
 *
 * -- The two landings that are not the primary --------------------------
 *
 * Sumphead's `y` is authored at 7.9 and MUST be: a pad with no `y` takes the
 * pre-level field at its centre, and its centre is 46 m east of the river,
 * i.e. on the rim, at 74. Defaulted, "the river landing" would have been a disc
 * of tarmac on the clifftop. Authored, it is a shelf notched 66 m down into the
 * east wall with the river along its west edge, which is what a river landing
 * looks like.
 *
 * The Crown pad has no such problem - the mesa top is absolute - and no road
 * off it either, which is the design and not an oversight. See the verdite row.
 *
 * -- gravity: 10.10, and what it does ------------------------------------
 *
 * The highest in the system, and it is not decoration: `PlanetWorld` publishes
 * it as `world.gravity`, and `Piloting._env` reads exactly that field and hands
 * `(0, -10.10, 0)` plus `dragMul: 1.35` to `Flight.step`. So the SHIP genuinely
 * weighs more here than anywhere else that has a surface - it takes more thrust
 * to hold a hover over Sumphead than over Cinder's Ashfall Flat, and longer to
 * arrest a descent onto the Crown.
 *
 * It touches the player on foot too, now. `Player.setWorldGravity` converts
 * 10.10 to a ratio against `CONFIG.player.gravityReference` (9.81) and walks in
 * -22.650 m/s², the heaviest surface in the game. It is a shade over the -22
 * every hand-built world uses and reads as one: apex 0.868 m against 0.878,
 * hang 0.533 s against 0.533, a 20 m fall costing 51 damage against 49, and the
 * drop that first hurts moving from 7.49 m to 7.10. Walking Verdigris is meant
 * to feel like walking Cinder with a little more weight on it, and 1.03 g is
 * exactly what that should buy - the variety is at the other end of the ladder,
 * on Tessera and Lathe. @see ../../player/Player.js `setWorldGravity`
 */

import { definePlanet } from './PlanetDescriptor.js';
import { ITEMS } from '../../systems/ItemDefs.js';

/**
 * Credits per cubic metre of hold, read off the item catalogue.
 *
 * The price belongs to the ELEMENT and not to the planet it came off, so the
 * number lives in `ITEMS` once and this file quotes it. Throwing on a missing
 * row rather than returning `undefined` is the difference between a loud boot
 * failure and a planet whose deposits are all worth NaN.
 *
 * @param {string} id an `ITEMS` id
 * @returns {number} credits per cubic metre
 */
const ORE = (id) => {
  const def = ITEMS[id];
  if (!def) throw new Error(`[Verdigris] mineral names item "${id}", which has no ITEMS row`);
  return def.value;
};

/* ------------------------------------------------------------------ */
/* Frame of reference                                                  */
/* ------------------------------------------------------------------ */

/** Playfield half-extent. 860 m square. */
const HALF = 430;

/**
 * The base plain, which on this world is NOT the ground the player walks on.
 *
 * It is the level of the 92 m corridor between the two rim scarps, before the
 * channel is cut out of it. Everything else is quoted against it: the bench is
 * `BASE + SCARP_H`, the gorge floor is the river ramp's own authored numbers.
 */
const BASE = 48;

/** Rim scarp: how far the bench stands above the corridor, and over what run. */
const SCARP_H = 26;
const SCARP_RUN = 9;
/** The bench, i.e. the ground the primary pad sits on. Derived, never typed twice. */
const BENCH = BASE + SCARP_H;

/** Half-width of the gorge, and therefore where the rim lines go. */
const CUT_W = 46;
/** How deep the channel cuts below the corridor. */
const CUT_D = 38;

/** The river floor's head and toe heights, in the ramp's own arclength. */
const FLOOR_Y0 = 21.0;
const FLOOR_Y1 = 5.0;
/** How far the water surface stands above the floor, everywhere. See the header. */
const RIVER_DEPTH = 1.1;

const D2R = Math.PI / 180;

/**
 * A polyline offset sideways by `m` metres (+ve = right of the direction of
 * travel, which for these southward lines is EAST).
 *
 * Used for the two rim scarps and for the malachite band on the east bank, and
 * used rather than three hand-typed polylines because the rim and the bank are
 * DERIVED FACTS about the river. Three copies of one curve is three copies, and
 * the day the river moves two of them go stale silently - the rim would leave
 * the canyon and the ore would end up in the water.
 *
 * The normal is taken from the chord through the neighbouring points rather
 * than from one segment, which under-offsets slightly at corners. That is the
 * safe direction to be wrong in: an over-mitred offset self-intersects, and a
 * self-intersecting scarp line is a half-plane with no well-defined side.
 */
const OFFSET = (pts, m) => pts.map((p, i) => {
  const a = pts[Math.max(0, i - 1)];
  const b = pts[Math.min(pts.length - 1, i + 1)];
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const L = Math.hypot(dx, dz) || 1;
  return [+(p[0] + (dz / L) * m).toFixed(2), +(p[1] - (dx / L) * m).toFixed(2)];
});

/* ------------------------------------------------------------------ */
/* The river, and the three lines derived from it                      */
/* ------------------------------------------------------------------ */

/**
 * THE GREEN CUT's centreline, north to south, running off the map at both ends.
 *
 * The meander is deliberately gentle - about 30 m of lateral wander per 140 m
 * of run, so roughly 24 degrees of direction change per vertex. That is not a
 * style choice: the rim scarps are this line offset 46 m, and an offset curve
 * self-intersects wherever the offset exceeds the radius of curvature. At these
 * bearings the radius is over 200 m and 46 is nowhere near it.
 */
const RIVER = [
  [-208, -470],
  [-186, -330],
  [-214, -190],
  [-180, -50],
  [-206, 90],
  [-172, 230],
  [-198, 360],
  [-166, 470],
];

/**
 * The two rim lines, at exactly `CUT_W` from the river - i.e. exactly where the
 * channel's own cut reaches zero. See the header for why they coincide.
 *
 * `side` on each scarp is derived from `scarpAt`'s sign convention rather than
 * guessed: `_polyC` for a southward segment is `-(len) * (px - ax)`, so a point
 * EAST of the line gives a negative cross product. To raise the east side of
 * EAST_RIM the sign product must come out positive, so `side: -1`; the west
 * scarp is the mirror and takes `side: +1`.
 */
const EAST_RIM = OFFSET(RIVER, CUT_W);
const WEST_RIM = OFFSET(RIVER, -CUT_W);

/**
 * The malachite band: the river line pushed 18 m east, i.e. down the middle of
 * the east bank.
 *
 * A plain `corridor` on the river would be symmetric and would put half the
 * seam on the WEST bank, which nothing can reach: the Stairgill lands on the
 * east side and the river is 20 m wide. Offsetting the centreline is how a
 * corridor addresses one bank, the same way `widthInner` is how one addresses a
 * fissure's lips and not its floor.
 */
const EAST_BANK = OFFSET(RIVER, 18);

/* ------------------------------------------------------------------ */
/* The routes                                                          */
/* ------------------------------------------------------------------ */

/** The primary pad's centre. Quoted, not typed twice - the Stair starts on it. */
const GREENSPAN = [-40, 150];

/**
 * THE STAIRGILL - the only way between the two levels on foot.
 *
 * It STARTS AT THE PAD CENTRE, and that is load-bearing rather than tidy: a
 * `ramp` with no `y0` takes its head height from the pre-level field at its
 * first point, which is precisely the height a `pad` with no `y` levels itself
 * to at the same place. Start it a metre away and the two resolve to different
 * numbers and the player steps off a riser they cannot see. Cinder's spiral
 * begins at its rim pad for exactly this reason.
 *
 * The first 180 m cut a gully across the bench - 17 m deep at the first bend,
 * 30 m at the third - and that is the feature, not a side effect. A trail into
 * a canyon follows a side drainage, because a side drainage is the only place
 * the wall is not a wall.
 *
 * ── 313 m, AND THE 276 m VERSION WAS SEVERED AT ITS OWN HEAD ─────────────
 *
 * The first draft ran 276 m for the same 67.7 m of fall - 13.8 deg, well under
 * the flood lattice's 38 deg ceiling, and MEASURED AT 0-OF-20 MALACHITE AND
 * 0-OF-11 SPORECRYST FROM THE PRIMARY PAD. The trail was fine; the join was
 * not, and the failure was 40 m long and invisible in every profile taken along
 * the trail itself.
 *
 * What breaks is the pad's blend fighting the road's grade. `pad` is applied
 * after `ramp`, so inside the blend annulus the ground is
 * `ramp(d) + (padY - ramp(d)) * w(d)`, and differentiating that gives a term
 * the road's own grade never appears in: `(padY - rampY) * w'`. At the middle
 * of a 22 m blend on an r 30 pad that is `g * 41 * 1.5 / 22`, which is 2.8
 * TIMES the road's grade. At g 0.245 the lip measured 40.5 deg over two metres,
 * every lattice cell across the trail head was rejected, and the entire lower
 * half of the planet went unreachable from the place the player lands.
 *
 * Two changes, both aimed at that one term: the grade came down to 0.216 (313 m
 * rather than 276) and the pad blend went out to 34 m rather than 22, which
 * halves `w'`. Predicted lip 29.4 deg; see the probe table for what it measures.
 *
 * The general form is worth keeping: a road leaving a pad is limited by the
 * PAD's blend, not by the road's own grade, and the two are not independent
 * numbers.
 */
const STAIR = [
  GREENSPAN,
  [-64, 100],
  [-92, 62],
  [-124, 44],
  [-152, 72],
  [-160, 130],
  [-152, 205],
];

/**
 * THE UNDERCROFT - the slot, driven east off the east bank into the massif.
 *
 * Its head sits 16 m east of the river, on the dry bank, so it opens ONTO the
 * gorge floor rather than into the water. `y0` is authored at 7.3, which is
 * what the river floor ramp resolves to at that arclength; the two therefore
 * agree at the mouth by construction instead of by luck.
 */
const UNDERCROFT = [
  [-176, 336],
  [-140, 352],
  [-96, 344],
  [-58, 360],
];
/** The chamber at the end of it. Also the deepest floor on the planet. */
const CHAMBER = [-58, 360];

/** Shelfwood's axis, and the polar frame the Shelf Road is laid out in. */
const SX = 190;
const SZ = 205;
/** A point at polar (d, bearing-in-degrees) about Shelfwood's axis. */
const S = (d, deg) => [
  +(SX + d * Math.cos(deg * D2R)).toFixed(2),
  +(SZ + d * Math.sin(deg * D2R)).toFixed(2),
];

/**
 * THE SHELF ROAD - 180 degrees round Shelfwood's face, bench to mesa top.
 *
 * A switchback was tried first and does not fit: the face is the annulus
 * between r 125 and r 155, thirty metres wide, and a ramp of width 9 with a
 * 15 m blend occupies 48 m of it. Two legs cannot pass each other in there
 * without merging into one flattened apron, which is the same defect as a
 * spiral road whose turns share a bearing.
 *
 * So it wraps instead: r 172 down on the bench at bearing 212, round to r 100
 * on the top at bearing 20. 409 m for 30 m of rise - 4.2 deg, a cart road. The
 * radius closes as the bearing turns so no two legs ever share a distance from
 * the axis, which is what stops the ring reading as a terrace.
 *
 * Bearing 212 for the head rather than the 200 the first draft used: at 200 the
 * road's first point stood 70 m from the primary pad's centre, and once that
 * pad's blend went out to 34 m (see STAIR) the two overlapped. A road head
 * inside a pad's apron is the same argument as the one that severed the
 * Stairgill, and it is cheaper to move the road than to argue with it. 212 puts
 * the head 92 m out, clear of the pad's 64 m reach with the road's own 24 m of
 * influence on top.
 */
const SHELF_ROAD = [
  S(172, 212),
  S(152, 238),
  S(144, 266),
  S(140, 296),
  S(134, 328),
  S(120, 356),
  S(100, 20),
];

/* ------------------------------------------------------------------ */
/* The two canopy fields, and the ore that shares their region         */
/* ------------------------------------------------------------------ */

/**
 * THE RESINWOOD, as ONE region object used by BOTH the growth field and the
 * resin seam.
 *
 * Amber resin is sap on standing growth. If the trees and the sap were placed
 * by two independent region records they would drift the first time either was
 * adjusted, and the seam would end up in open ground with the forest a hundred
 * metres away - the small version of the defect that put fifteen unenterable
 * buildings behind a green suite. `Placement.scatter` is shared by props and
 * minerals precisely so this can be one declaration; Volcanic.js does the same
 * thing with its rift vents and the sulfur that crusts on them.
 *
 * `yMin: 66` keeps it out of the gorge and `slopeMaxDeg: 20` keeps it off the
 * rim scarp - trees do not grow on a 71 degree face, and neither the reach
 * probe nor the player would forgive a seam that did.
 */
const RESINWOOD = {
  shape: 'disc',
  x: 130, z: 150, r: 265,
  yMin: 66, yMax: 120,
  slopeMaxDeg: 20,
  clearOfLiquid: 14,
  clearOfPads: 9,
};

/** The Crown's own canopy. Verdite grows inside it; see the mineral row. */
const CROWNWOOD = {
  shape: 'disc',
  x: 210, z: -230, r: 92,
  slopeMaxDeg: 12,
  clearOfLiquid: 9,
  clearOfPads: 5,
};

/* ------------------------------------------------------------------ */
/* The descriptor                                                      */
/* ------------------------------------------------------------------ */

export const VERDIGRIS = definePlanet({
  id: 'verdigris',
  name: 'Verdigris',
  blurb: 'The one living world. Canopy mesas over river gorges: humic on the bench, malachite on the banks, resin in the resinwood, sporecryst down the Undercroft, verdite on the Crown.',

  half: HALF,
  /**
   * 272 segments over 860 m: a 3.162 m cell, the same order as Cinder's 3.125.
   *
   * The mesh and the collision heightfield are the SAME grid, so this number
   * buys both the silhouette and the surface the player stands on. It matters
   * more here than on Cinder because the two rim scarps are 71 degree faces
   * nine metres wide: at a 6 m cell the rim would be one triangle and the
   * "line" the whole planet is built around would be a bevel.
   */
  seg: 272,

  /** 1.03 g - the heaviest surface in the system. See the header for exactly
   *  what consumes it (the ship's integrator) and what does not (the player's). */
  gravity: 10.10,

  /* ---------------------------------------------------------------- */
  terrain: {
    seed: 0x0e5d16,
    baseY: BASE,
    /** Broad upland swells. 175 m: one swell per two minutes' walk. */
    swell: { amp: 6.0, scale: 175, octaves: 4 },
    /** Ripples, ridged, so the bench has hummocks rather than blobs. */
    ripple: { amp: 1.9, scale: 31, octaves: 3 },
    /** Grain at the scale of a footfall. Keeps the normals off glass. */
    grain: { amp: 0.26, scale: 24 },
    /** The map's edge falls away rather than walling up. */
    rim: { start: 396, drop: 22 },

    landforms: [
      /* ---- ADD ---------------------------------------------------- *
       * Order inside this layer matters for the plateaus: `plateauAt` sets an
       * ABSOLUTE height, so anything listed BEFORE one is erased inside its
       * radius and anything listed AFTER it rides on top. The scarps are first
       * because they define the bench the mesas stand out of; the cones and
       * ridges are last because their whole job is to stop the two mesa tops
       * being dead-flat discs.                                                */

      /** The east rim of the Green Cut. `side: -1` raises the east - see the
       *  note on EAST_RIM for where that sign comes from. */
      { kind: 'scarp', pts: EAST_RIM, height: SCARP_H, run: SCARP_RUN, side: -1 },
      /** The west rim, the mirror of it. */
      { kind: 'scarp', pts: WEST_RIM, height: SCARP_H, run: SCARP_RUN, side: 1 },

      /**
       * THE CROWN. 72 m of face in 26 m of edge - 70 degrees, and that number
       * is the exotic tier's whole design. The flood lattice walks a 2 m
       * lattice at up to 38 degrees with a 0.45 m step-up, and across the
       * steepest two metres of this face the ground moves 8.2 m. There is no
       * bearing on which it is climbable, which is what makes the pad on top a
       * DECISION rather than a shortcut.
       */
      { kind: 'plateau', x: 210, z: -230, r: 100, y: 146, edge: 26 },
      /**
       * SHELFWOOD. 30 m of face in 30 m - 45 degrees, still unwalkable (3.0 m
       * across the steepest two metres against a 1.56 m ceiling), which is what
       * makes the Shelf Road a road and not a decoration.
       */
      { kind: 'plateau', x: 190, z: 205, r: 125, y: 104, edge: 30 },

      /** THE HORN: the bench's one landmark. 46 m over 96 m, so the flanks run
       *  16-17 deg and only the top ten metres are steep - a knoll you can walk
       *  up, which is the point of having one. */
      { kind: 'cone', x: -20, z: -320, r: 96, peak: 46 },
      /** A knoll on Shelfwood's top, so the mesa reads as ground and not as a
       *  table. 13 m over 48. */
      { kind: 'cone', x: 232, z: 176, r: 48, peak: 13 },

      /** Two low spines across the Crown's top. A `plateau` is exactly level by
       *  construction and 200 m of exactly level is the CAD look the noise
       *  budget exists to prevent - but noise is added BEFORE the plateau and
       *  erased by it, so the relief up there has to be authored after. */
      { kind: 'ridge', pts: [[160, -182], [212, -198], [264, -178]], width: 26, height: 6.5, taper: 0.30 },
      { kind: 'ridge', pts: [[196, -296], [254, -278]], width: 22, height: 5.0, taper: 0.40 },
      /** The same for Shelfwood. */
      { kind: 'ridge', pts: [[136, 168], [196, 196], [252, 244]], width: 30, height: 7.0, taper: 0.25 },
      /** Two wooded spurs on the bench, so the Greenspan has form of its own
       *  rather than only the swell. */
      { kind: 'ridge', pts: [[-56, -282], [16, -186], [62, -64]], width: 34, height: 9.0, taper: 0.20 },
      { kind: 'ridge', pts: [[96, 332], [188, 388], [282, 412]], width: 30, height: 7.5, taper: 0.30 },

      /* ---- CUT ---------------------------------------------------- */
      /**
       * THE GREEN CUT itself.
       *
       * No `levee` and no `taper`, both on purpose. A levee is what a lava flow
       * throws up beside itself; a river gorge has spoil nowhere, and a levee
       * here would put a berm along the inside of a cliff. `taper` widens as it
       * shallows, and the width is what the rim lines are pinned to - a taper
       * would walk the cut out past the scarps downstream and dissolve the one
       * edge this planet is built around.
       *
       * `channelAt` returns 0 beyond `width`, so this reaches exactly as far as
       * the scarp lines and no further.
       */
      { kind: 'channel', pts: RIVER, width: CUT_W, depth: CUT_D },

      /* ---- LEVEL -------------------------------------------------- *
       * ROADS FIRST, PADS LAST, and Volcanic.js records the measurement that
       * settled it: with the pad first, a road leaving the pad centre at a 0.15
       * grade had already taken 3.0 m off inside a 20 m disc - a landing pad
       * with a three-metre fall across it, 3.00 m of span before and 0.00 m
       * after. With the pad last the disc wins outright and the road emerges
       * from the pad EDGE, where the pad's blend hands over to the road's own
       * grade with no step.
       *
       * Within the roads the order is chosen too: the Stairgill is cut BEFORE
       * the river floor, so where the two meet on the gorge floor the RIVER
       * wins and the floor stays a river floor. The Undercroft is cut AFTER it,
       * because a slot driven out of the floor has to override the floor.      */

      /** THE RIVER FLOOR. A LEVEL, not a CUT, for the reason in the header: a
       *  `channel` cuts a constant depth out of a swell and hands back a floor
       *  that tilts with it. 52 m of dead-flat bed, blending to 40 m out where
       *  it meets the toe of the wall. */
      { kind: 'ramp', pts: RIVER, width: 26, blend: 14, y0: FLOOR_Y0, y1: FLOOR_Y1 },

      /** THE UNDERCROFT. Width 8 - a 16 m floor - and blend 6, so the flare is
       *  short and the walls stand up at once. Anything wider and it is a side
       *  valley with daylight in it rather than a slot. */
      { kind: 'ramp', pts: UNDERCROFT, width: 8, blend: 6, y0: 7.3, y1: 2.6 },

      /**
       * THE STAIRGILL, and it is LAST among the roads for a measured reason.
       *
       * Cinder records the same rule from the other end: its outlet gorge is cut
       * before its spiral road, so where the two pass within forty metres of one
       * another the ROAD wins and the road stays a road. Here the trail's last
       * eighty metres run down the canyon wall between 36 and 26 m from the
       * river - which is inside the river floor's own 26-40 m blend annulus.
       * Cut first, the floor's blend wrote straight over the trail's ledge and
       * the flood measured 49-56 deg across it for forty metres: 0-of-20
       * malachite and 0-of-11 sporecryst from the primary pad, with a trail that
       * profiled at a clean 12.2 deg along its own centreline the whole way.
       *
       * A grade measured ALONG a trail says nothing about whether a body can
       * stand on it. The lattice rejects on the full gradient, and the gradient
       * that killed this one was ACROSS.
       *
       * `y1` is authored at 9.6 rather than defaulted, because the default would
       * be the pre-level canyon wall at its toe - 25 m up a cliff - and the
       * trail would end in mid-air. 9.6 is what the river floor above resolves
       * to at that same arclength, so the ledge and the floor meet flush and the
       * override in the last fifteen metres is worth six centimetres.
       */
      { kind: 'ramp', pts: STAIR, width: 7.5, blend: 13, y1: 9.6 },

      /** THE SHELF ROAD. Both ends defaulted on purpose: the head takes the
       *  bench it leaves and the toe takes the mesa top it arrives on, so the
       *  road cannot disagree with either. */
      { kind: 'ramp', pts: SHELF_ROAD, width: 9, blend: 15 },

      /** The Greenspan. `blend: 34` and not the 22 the first draft had - see
       *  the note on STAIR for the measurement. A 22 m blend against a road
       *  leaving the pad centre at a 0.245 grade printed a 40.5 deg lip round
       *  the whole clearing and cut the trail off at its head. */
      { kind: 'pad', x: GREENSPAN[0], z: GREENSPAN[1], r: 30, blend: 34 },
      /** The Crown deck. The mesa top is absolute, so this needs no `y`. */
      { kind: 'pad', x: 210, z: -230, r: 22, blend: 16 },
      /** SUMPHEAD. `y` authored - see the header. Its centre is 46 m east of
       *  the river, i.e. ON the rim, and the default would have put the river
       *  landing on the clifftop 66 m above the water. */
      { kind: 'pad', x: -140, z: 300, r: 20, blend: 12, y: 7.9 },
      /** The Undercroft chamber, at the slot's own toe height so the two are
       *  one floor. Its 10 m blend is the wall that closes the far end. */
      { kind: 'pad', x: CHAMBER[0], z: CHAMBER[1], r: 18, blend: 10, y: 2.6 },
      /**
       * The Crown tarn's bed.
       *
       * A `pad` and not a `basin`, and the difference is the one Volcanic.js
       * measured: a basin is a DELTA, so a pool in one inherits whatever is
       * under it and its shoreline runs round a single circle at two different
       * heights. A pad is a LEVEL, so the bed is flat by construction, the
       * shoreline is a contour and the 12 m blend is the beach.
       */
      { kind: 'pad', x: 156, z: -282, r: 18, blend: 12, y: 140.6 },
    ],
  },

  /* ---------------------------------------------------------------- */
  palette: {
    /**
     * NOT `grass.field`, on a jungle planet, deliberately - and NOT
     * `dirt.ground` either, which is the half of this argument that was wrong
     * for nine planets.
     *
     * `PlanetWorld._buildTerrain` clones the library material, forces its
     * `color` to white and turns on `vertexColors` - but the library's ALBEDO
     * MAP survives, and vertex colours multiply into it. `shadeGrass` bakes a
     * saturated green into that map (`g = lush * 2.20` against `b = lush * 0.70`
     * in `Materials.js`), so every band below would come out multiplied by
     * green: the blue-grey wet rock at the bottom of the gorge, the brown
     * earth of the wall and the pale bleached crown would all collapse toward
     * one hue. That diagnosis was right and it stands.
     *
     * What it missed is that it applies to `shadeDirt` too. "Neutral soil" was
     * the belief; the measurement is a linear R:G:B of 1.79 : 1 : 0.49 - three
     * and a half times as much red as blue, a brown filter of very nearly the
     * same strength as the green one this comment refused. It cost the ice
     * world its ice. Here it was quietly pulling the wet gorge rock
     * (`#3f4b52`, hue 202) and the bleached crown toward the same ochre as the
     * canopy floor, which is the collapse-to-one-hue the paragraph above
     * exists to prevent, arrived at from the third direction.
     *
     * `rock.neutral` is `shadeDirt`'s grain - the same noise walk, so height,
     * roughness, AO and normals are bit-identical - with the albedo replaced by
     * its own luminance. Same brightness, no cast, bands mean what they say.
     *
     * The grass READ comes from the growth fields and the band colours, which
     * is where it belongs - on a world whose ground is 30% canopy shadow, a
     * blade-scale normal map is invisible under the trees and wrong everywhere
     * else.
     */
    material: 'rock.neutral',
    tile: 5.0,
    /**
     * Absolute-height bands.
     *
     * ══════════════════════════════════════════════════════════════════════
     *  THE GREEN TRAP, WHICH IS THE SALMON-BROWN TRAP IN A DIFFERENT COLOUR
     * ══════════════════════════════════════════════════════════════════════
     *
     * Cinder shipped six bands across FIVE degrees of hue and ZERO points of
     * saturation change, and the tester who walked it wrote "one flat
     * salmon-brown hue, no rock, no ash, no vents, no heat, no shadows." A
     * jungle is the easiest place in the game to repeat that, because "green"
     * feels like a decision when it is only a channel: a green value ramp is a
     * smear, and it is a smear that reads as moss on plastic.
     *
     * Real vegetated ground is not one green. It is yellow-green where the
     * light hits it, blue-green in shade and under canopy, BROWN wherever the
     * soil shows, and GREY wherever the rock is exposed - and on a world whose
     * defining feature is a 64 m cliff, the rock is exposed over a large
     * fraction of what you can see. So four of the six bands below are not
     * green at all:
     *
     *   y   6   #22333a   198  26  18   the gorge sump: wet rock, never lit
     *   y  22   #4d5a3a    84  22  29   river silt, olive drab
     *   y  48   #6b4a2c    29  42  30   the wall: bare earth and root mat
     *   y  76   #577a35    90  39  34   the Greenspan: living yellow-green
     *   y 108   #2f6b56   159  39  30   Shelfwood canopy level: blue-green shade
     *   y 150   #b9c48a    71  33  66   the Crown: sun-bleached upper canopy
     *
     * 169 degrees of hue between the extremes against Cinder's 5, and 20 points
     * of saturation against Cinder's 0. `planet-atmosphere.test.mjs` floors
     * those at 40 and 15 respectively.
     *
     * The VALUE structure is doing the same work it does on Cinder and is
     * unchanged in kind: dark at the bottom of the gorge (L 18), a rise through
     * the wall and the bench, a DIP at the canopy level where the trees shade
     * their own ground, and the brightest thing on the planet at the top. That
     * dip is what makes the Crown read as a lit table floating over a dark
     * middle distance, which is the silhouette this world has instead of a
     * caldera.
     *
     * The HSL figures above are sRGB, which is what a colour picker shows. The
     * atmosphere test reads `THREE.Color.getHSL`, which reports LINEAR space
     * because `ColorManagement` converts on `setHex` - so the numbers it works
     * with are different, and they are the ones the fog has to beat. Measured
     * on this table: hue spread 180 deg against a floor of 40, saturation
     * spread 34 points against a floor of 15, mean L 0.132, mean S 0.552.
     */
    bands: [
      { upTo: 6, color: 0x22333a },
      { upTo: 22, color: 0x4d5a3a },
      { upTo: 48, color: 0x6b4a2c },
      { upTo: 76, color: 0x577a35 },
      { upTo: 108, color: 0x2f6b56 },
      { upTo: 150, color: 0xb9c48a },
    ],
    /**
     * Exposed rock on anything steep, and on this planet that is a lot of
     * ground: both rim scarps, both mesa faces, both walls of the Undercroft.
     *
     * A neutral grey-green, and it is doing the single most important job in
     * the table. Without it the 71 degree rim face would be painted with the
     * brown band it passes through and the cliff would read as a mud slope; the
     * whole "the edge is a LINE" claim is visual as much as geometric, and a
     * grey face under a green rim is what makes the line visible from the
     * bench. From 30 deg so the Horn's flanks stay grassy, fully by 50 so the
     * cliffs are stone.
     */
    slope: { fromDeg: 30, toDeg: 50, color: 0x77786c },
    /**
     * Soil showing through, so the bands do not read as a contour map.
     *
     * The term is applied as `n * n * amount`, so most of the field never
     * approaches the ceiling. A warm ochre, because the one colour a green
     * world cannot have too much of is its complement: it is what stops the
     * canopy shade band and the bench band - 69 degrees apart in hue but both
     * green - from merging into one another at distance.
     */
    mottle: { scale: 52, amount: 0.66, color: 0x9a6a28 },
  },

  sky: {
    kind: 'daylight',
    params: {
      /**
       * THE ONE BLUE SKY IN THE SYSTEM, and that is a legibility decision
       * before it is a physical one.
       *
       * Cinder is `daylight` at rayleigh 0.12 / mie 4.4 and is an orange dust
       * sky; Sirocco will be another. A screenshot has to be unmistakable, and
       * the fastest way to make a green surface unmistakable is to put a real
       * Rayleigh sky over it - green ground under blue air is a combination
       * nothing else in the build can produce. 2.4 is above the daylight
       * preset's own 1.9 because there is water vapour here and the zenith
       * should be deep.
       *
       * Mie at 2.2 against the preset's 1.5: this is a humid world with a river
       * in a canyon and a canopy transpiring into still air, so the horizon is
       * milky even though the zenith is not.
       */
      /* Sun to the WEST-SOUTH-WEST and 44 degrees up. Chosen from a landing
       * site, not from the origin: standing on the Greenspan pad the player is
       * looking north-east at the Crown, so this puts the key behind their left
       * shoulder and front-lights the mesa. Cinder's first pass had the sun
       * behind its hero silhouette and the entire foreground went unreadable. */
      sunDirection: [-0.50, 0.70, 0.50],
      sunColor: 0xfff2d0,
      sunIntensity: 12,
      sunAngularSize: 0.022,
      rayleigh: 2.4,
      mie: 2.2,
      mieG: 0.76,
      /* Low: this is thick air at the bottom of a gravity well, not a peak. */
      altitude: 90,
      /* What the ground bounces back into the dome. The canopy, seen from
       * above - and it has to be the canopy rather than the soil, because 60%
       * of what is under the sky here has leaves on it. */
      groundColor: 0x2c3a24,
      hazeColor: 0xbfd8c4,
      horizonHaze: 0.72,
      cirrus: 0.62,
      cirrusScale: 1.3,
      cirrusSpeed: 0.005,
    },
    background: 0x6d94a8,
    /**
     * ── The fog, and the two numbers it is not free to move ───────────────
     *
     * `half` is 430, so the playfield is 860 m square and its diagonal is
     * 1,216 m. `far: 1340` is 1.10x that: the far corner is fully extinguished
     * so the player never sees the world stop, and it is not so far that the
     * rim shows through. `CONFIG.render.far` is 2000, so nothing pops at the
     * clip either.
     *
     * The colour is a pale green-grey mist and both halves of that matter.
     * `planet-atmosphere.test.mjs` re-derives the ground's mean out of the band
     * table above every run and asserts the fog is LIGHTER and no more
     * SATURATED than it. Cinder's first fog was darker AND more saturated than
     * the basalt it hung over, and the whole planet lived inside a 9-luma band
     * with no horizon in it. Measured in the linear space the test works in,
     * this is L 0.333 / S 0.175 against ground bands averaging L 0.132 /
     * S 0.552 - lighter by 0.201 against a floor of 0.03, and greyer by 0.376.
     * A humid haze is water in the air, and water in the air is pale and nearly
     * grey however green the leaves under it are.
     *
     * `near: 90` rather than Cinder's 120: the gorge is 92 m across and the
     * whole read of it depends on the far wall sitting BEHIND some air. At 120
     * both walls were in the same crisp plane and the slot looked painted.
     */
    fog: { color: 0x8fa896, near: 90, far: 1340 },
    /**
     * Fill 0.52 against a key of 6.0 - a ratio of 0.087, under the 0.12 that
     * `planet-atmosphere.test.mjs` floors at, so a face turned away from the
     * sun is genuinely a different value from one facing it.
     *
     * High for a single-sun world, and the reason is real rather than
     * generous: this is the only planet in the system with a canopy, and light
     * under a canopy is almost entirely bounce. Tinted green for the same
     * reason - the fill on this world has come off leaves.
     */
    ambient: { color: 0x5a7a64, intensity: 0.52 },
    sun: { color: 0xfff2d0, intensity: 6.0, direction: [-0.50, 0.70, 0.50] },
    exposure: 1.14,
    /* `GRADE_PRESETS` is keyed on WORLD id and a planet is not in it, so naming
     * one here is the only way a planet gets a calibrated look. `dock` is the
     * warm-key / cold-shadow grade and it is already calibrated against
     * measured linear-HDR luminance; its cool shadow tint is what keeps the
     * blue-green canopy shade band from going muddy under a warm key. */
    grade: 'dock',
  },

  /* ---------------------------------------------------------------- */
  /**
   * RIVER WATER, through the lava material.
   *
   * `PlanetLiquid` builds one surface shader for every planet and it is written
   * as lava: `uCrust` is the chilled skin, `uDeep` shows through where the skin
   * has torn, and `uHot * uEmissive` is added on top of both. Nothing about
   * that is specific to rock, and pointing the same three colours at water
   * gives a moving surface with two shearing noise layers and bright threads
   * where they pull apart - which is what a river looks like from the rim.
   *
   * The numbers that make it water rather than lava:
   *   `emissive` 0.16 against Cinder's 2.1 - the term becomes a specular sheen
   *   rather than a light source, and it is not zero because at zero the
   *   unbroken surface is literally black and a black river is a hole.
   *   `hot` a pale sky-blue rather than orange, so the threads read as light
   *   ON the water and not as heat IN it.
   *   `flow` 1.05 against 0.55 - this is moving water, not a crust drifting.
   *   `glowLight: null` - `RIG_BUDGET.point` is 12 for the whole game and every
   *   one of them is compiled into every shader. A river does not glow.
   */
  liquid: {
    name: 'river water',
    bodies: [
      /**
       * The river. 20 m wide down a 52 m floor, which leaves 16 m of dry bank
       * on each side - and that width is the whole reason the malachite band
       * fits and the gorge is walkable end to end.
       *
       * `y0`/`y1` are the floor ramp's own numbers plus a CONSTANT 1.1 m, held
       * to a constant offset rather than to convenient round numbers at each
       * end. The ribbon and the ramp interpolate over the same arclength, so a
       * constant offset is the only choice that keeps the river the same depth
       * everywhere; Cinder's outlet flow records what happens otherwise (its
       * toe floated 8.2 m over the lake bed).
       *
       * 1.1 m deep, and that number is chosen against what the engine actually
       * does rather than against how a river looks. `PlanetWorld` sets
       * `swim: false` and `_buildLiquid` adds no collider, so a player who
       * steps in does not swim and is not stopped - they wade, on the real
       * heightfield. A 1.1 m river is a river you wade; a 6 m one would be a
       * player walking along the bottom of a lake with their head underwater.
       */
      { shape: 'ribbon', pts: RIVER, width: 20, y0: FLOOR_Y0 + RIVER_DEPTH, y1: FLOOR_Y1 + RIVER_DEPTH },
      /**
       * The Crown tarn: rain caught on a mesa top with nowhere to drain to, and
       * the reason there is a canopy 146 m above the nearest river. r 16 inside
       * an r 18 bed so the shoreline is on the pad's own flat and the beach is
       * the pad's blend.
       */
      { shape: 'disc', x: 156, z: -282, r: 16, y: 142.4 },
    ],
    color: 0x14413f,
    hot: 0xbfe4f0,
    crust: 0x2a5a4c,
    emissive: 0.16,
    flow: 1.05,
    glowLight: null,
    lethal: false,
  },

  /* ---------------------------------------------------------------- */
  props: [
    {
      /**
       * THE RESINWOOD - the forest the player walks through, and the field the
       * resin seam shares a region with.
       *
       * ── SPACING IS THE WHOLE RECORD ──────────────────────────────────────
       * Cinder's colonnade at 5.0 m against a 2.3 m column radius left 2.0 m
       * lanes and the reach probe lost an entire ferro-basalt seam inside it: a
       * forest a body cannot walk into is scenery with ore behind glass.
       *
       * Growth is the one family where the collider is NOT the instance.
       * `PlanetProps` gives it the TRUNK only, on the stated grounds that a box
       * round the canopy would be an invisible ceiling and you walk UNDER a
       * tree. So the lane arithmetic runs on the trunk, not the crown: at a
       * mean canopy of 5.3 m and a mean height of 16 m the geometry's clamped
       * canopy fraction is 0.33 and its trunk fraction 0.039, so a mean
       * instance carries a collider about 1.3 m across. Measured over all 700
       * placed instances: the minimum gap between any two trunk colliders on
       * the planet is 6.69 m, the fifth percentile is 7.00 and the median is
       * 9.17 - against Cinder's colonnade at 2.0 m, which lost a whole seam.
       *
       * The CANOPIES overlap at that spacing, which is the point: a closed
       * canopy overhead and open ground underneath is what a forest is, and it
       * is only affordable because the two are different colliders.
       */
      id: 'resinwood',
      kind: 'growth',
      region: { ...RESINWOOD },
      count: 700, spacing: 8.0,
      size: { trunk: [0.40, 0.85], h: [11, 21], canopy: [3.6, 7.0], droop: 0.42 },
      /* Four canopy greens spanning yellow-green to blue-green, for the same
       * reason the ground bands do: one green at four brightnesses is a smear,
       * and a smear over 700 instances is most of the frame. */
      tint: [0x3f7a3a, 0x2d6b4e, 0x4d8a3c, 0x27593c],
      trunkTint: [0x5a4632, 0x6b533a, 0x453626],
      collide: true,
    },
    {
      /**
       * THE CROWN CANOPY. Taller, paler and more open than the resinwood - a
       * hundred and forty-six metres up, in full sun, on thin soil over rock.
       *
       * The pale silver-greens are a legibility decision as well as a botanical
       * one: this canopy sits on the brightest band in the palette (L 66) and a
       * dark forest green up there would read as a hole in the mesa from the
       * bench. Measured over all 190 placed: minimum lane between trunk
       * colliders 5.84 m, median 6.86.
       */
      id: 'crownwood',
      kind: 'growth',
      region: { ...CROWNWOOD },
      count: 190, spacing: 7.5,
      size: { trunk: [0.55, 1.05], h: [14, 26], canopy: [4.2, 8.0], droop: 0.30 },
      tint: [0x8fb27a, 0x6f9a6b, 0xa3bd85, 0x5d8a63],
      trunkTint: [0x7d6f55, 0x8e7d61],
      collide: true,
    },
    {
      /**
       * THE SPORE SHELF - what actually lights the Undercroft.
       *
       * `collide: false`, and that is not laziness. The slot is 16 m wide and
       * carries the rare seam; anything with a collider in there closes it. A
       * spire field is the one prop family whose whole silhouette is a needle,
       * so it reads as dense from the mouth and is empty to walk through, which
       * is exactly the trade this location wants.
       *
       * `glow` is per FIELD and not per instance, because an instance colour
       * multiplies the diffuse and never the emissive. One material cloned off
       * the shared rock, still one draw call.
       */
      id: 'sporeshelf',
      kind: 'spires',
      region: { shape: 'corridor', pts: UNDERCROFT, width: 22, slopeMaxDeg: 34 },
      count: 90, spacing: 3.4,
      size: { h: [1.4, 5.2], base: [0.30, 0.95], lean: 0.22, facets: 6 },
      tint: [0xbdf0dc, 0x8fd8c0, 0xd6f8e8],
      glow: 0x1e8f6e, glowStrength: 1.6,
      collide: false,
    },
    {
      /**
       * DEADFALL - mossed-over boulders on the upland.
       *
       * `yMin: 38` keeps the whole field OUT of the gorge and out of the
       * Undercroft, and it is a reachability decision rather than a
       * geological one. A `field` region cannot exclude a named place, and at
       * 8.5 m spacing with a 2.9 m radius this would put two boulders across a
       * 16 m slot and close the only route to the rare seam. The gorge gets its
       * own field below, at a density chosen for a 16 m bank.
       */
      id: 'deadfall',
      kind: 'boulders',
      region: { shape: 'field', yMin: 38, slopeMaxDeg: 32, clearOfLiquid: 12, clearOfPads: 6 },
      count: 900, spacing: 8.5,
      size: { rMin: 0.55, rMax: 2.9 },
      tint: [0x4a5240, 0x3a4436, 0x59614a, 0x2e3a2e],
      collide: true,
    },
    {
      /**
       * SCREE - blocks off the wall, on the gorge floor.
       *
       * `widthInner: 18` puts the band at 9-22 m from the river centreline:
       * outside the 20 m ribbon and inside the 52 m floor, i.e. exactly the dry
       * bank. Without it the field would run down the middle of the water.
       *
       * 90 at 9 m rather than the 260 at 7 m the first pass asked for. The
       * bank is a 13 m band about 960 m long - roughly 12,500 m2 - and at 7 m
       * spacing the hexagonal packing limit for that is 294, so 260 was asking
       * for something the region does not hold and `scatter` reports a
       * shortfall rather than padding. It would also have left 2.6 m lanes on
       * the only bank the malachite is on, which is the colonnade defect again.
       */
      /**
       * `clearOfPads` IS OPT-IN, AND THIS FIELD DID NOT OPT IN.
       *
       * `Placement.scatter` only tests pad clearance when the region asks for
       * it (`Placement.js`, the `region.clearOfPads !== undefined` guard), so a
       * region that omits it is not "using the default", it is unfiltered. The
       * Sumphead pad sits on the gorge floor with the river running past it, so
       * this corridor crosses the pad - and on the world's own seed stream a
       * boulder landed 7.14 m INSIDE the r 20 disc, i.e. a rock in the middle
       * of the place a ship sets down and a player walks out.
       *
       * Nothing about that is visible in a review: the field asked for 90 and
       * got 90. It was found by measuring the closest placed object to every
       * pad edge on every planet - the other nine come out 2.29 to 6.16 m
       * OUTSIDE an edge, and this one came out negative.
       *
       * 4 m matches the other corridor fields in the registry, and is enough
       * for the 2.2 m maximum boulder radius here to clear the disc entirely.
       */
      id: 'scree',
      kind: 'boulders',
      region: {
        shape: 'corridor', pts: RIVER, width: 44, widthInner: 18, slopeMaxDeg: 34,
        clearOfLiquid: 1, clearOfPads: 4,
      },
      count: 90, spacing: 9,
      size: { rMin: 0.5, rMax: 2.2 },
      tint: [0x3c4640, 0x2c3630, 0x4a5248, 0x232b28],
      collide: true,
    },
    {
      /**
       * THE RIM LEDGE - caprock plates broken out along the east rim line.
       *
       * `slabs` is the one family that is honestly a box, because a shattered
       * plate IS a flat sheet. They are here for one job: the rim is the
       * planet's defining line and a line drawn only by a change of colour is a
       * line that disappears at noon. Broken plates along it give the edge a
       * silhouette and a texture from both above and below.
       *
       * A slab's collider is a rotated box at its own footprint, flattened to a
       * step - so at `t` up to 1.15 m it is a knee-high obstacle, not scenery.
       * 8 m spacing against a 4.6 m maximum plate MEASURES a minimum lane of
       * 3.51 m over the 200 placed, with a median of 6.75. That is the tightest
       * field on the planet and the plate sizes are capped for that reason
       * rather than for the look - it is the one number here with little margin
       * left in it.
       */
      id: 'rimledge',
      kind: 'slabs',
      region: { shape: 'corridor', pts: EAST_RIM, width: 30, slopeMaxDeg: 26, clearOfPads: 5 },
      count: 200, spacing: 8,
      size: { w: [1.8, 4.6], d: [1.4, 4.0], t: [0.35, 1.15], tilt: 0.45 },
      tint: [0x6b6a5e, 0x565a50, 0x7a7869, 0x44483f],
      collide: true,
    },
  ],

  /* ---------------------------------------------------------------- *
   * MINERALS - five elements, five places, one ladder.
   *
   * Every metre below is MEASURED, not asserted: a throwaway probe floods the
   * real colliders from each pad over a 2 m lattice with no jump and no mantle,
   * the same way `planet-minerals.test.mjs` does for Cinder.
   *
   *   rarity     element      terrain     reach and nearest walk, per landing
   *   ---------  -----------  ----------  -----------------------------------------
   *   common     humic        plain       40/40 Greenspan  56 m  | 40/40 Sumphead 488
   *   uncommon   malachite    channel     20/20 Greenspan 342 m  | 20/20 Sumphead  44
   *   uncommon   resin        highland    18/18 Greenspan  88 m  | 18/18 Sumphead 471
   *   rare       sporecryst   cave        11/11 Greenspan 525 m  | 11/11 Sumphead  64
   *   exotic     verdite      outcrop      0/7  Greenspan   -    |  0/7  Sumphead   -
   *                                        7/7  Crown      36 m
   *
   * The last row is the design in one line, and the third-from-last is the other
   * half of it: sporecryst IS reachable from the primary, at 525 m through a
   * gully, down a canyon wall, along a river bank and 125 m into a slot - which
   * is a long walk and is meant to be. Verdite is not reachable from the primary
   * at any distance, which is a different thing entirely.
   *
   * The two uncommon seams are 88 m and 342 m from the Greenspan, and that gap
   * is deliberate: resin is what you pick up on the way to the ship, malachite
   * is what you go down for.
   *
   * `credits` is absent from every row on purpose: `definePlanet` computes it
   * from `unitValue * hold` and REFUSES a hand-written one.
   *
   * `size` is the node radius AND the hold volume (`max(1, round(size*1.6))`),
   * so the cheap ore is the bulky ore and that is the whole cargo decision:
   *
   *   humic       1.90 m -> 3 m3 at  14 cr/m3 =  42 cr a lump
   *   malachite   1.20 m -> 2 m3 at  48 cr/m3 =  96
   *   resin       0.95 m -> 2 m3 at  62 cr/m3 = 124
   *   sporecryst  0.78 m -> 1 m3 at 240 cr/m3 = 240
   *   verdite     0.62 m -> 1 m3 at 430 cr/m3 = 430
   *
   * A stock Kestrel holds 10 m3. That is three humic nodules, or ten verdite
   * chips worth 4,300 credits - and the ten chips are all on top of a mesa you
   * cannot walk off.                                                          */
  minerals: [
    {
      id: 'humic', item: 'humic', name: 'Humic Nodules',
      rarity: 'common', terrain: 'plain', place: 'the Greenspan',
      /* Peat brown, deliberately the dullest thing on the planet. Cinder's
       * tephra shipped as a cream boulder brighter than anything else on the
       * ash plain - the CHEAPEST ore was the most conspicuous object in the
       * world, and it was indistinguishable from the second-rarest. This sits
       * between the deadfall boulders (0x2e3a2e-0x59614a) and the litter it is
       * pressed out of, and a player learns in one visit not to walk to it. */
      color: 0x4a3f28, glow: 0,
      unitValue: ORE('humic'), spread: 0.25,
      /* The biggest node on the planet and the least valuable. 1.90 m is
       * comfortably clear of the 1.5625 m below which `holdUnitsFor` rounds
       * down to two cubic metres and the bulk-versus-value decision goes with
       * it. Three cubic metres a lump; a stock Kestrel holds ten. */
      size: 1.90, count: 40, spacing: 22,
      /**
       * A `rect` and not a `field`, and the east edge of it is chosen and not
       * arbitrary: `x0: -104` is east of the east rim line at every z on the
       * map (the rim runs -168 to -120), so no humic node can land on the far
       * bank.
       *
       * That matters because the far bank is the one place on this planet a
       * body genuinely cannot get to - the Stairgill lands on the east side and
       * the river is 20 m of water on a world with `swim: false`. A `field`
       * region would have scattered a fifth of the COMMONEST ore over there,
       * and a common ore you cannot reach from the primary pad is not a common
       * ore. Cinder can afford a field for its tephra because its plain is one
       * connected surface; this one is two.
       */
      region: {
        shape: 'rect',
        x0: -104, z0: -430, x1: 430, z1: 430,
        yMin: 64, yMax: 98, slopeMaxDeg: 20, clearOfLiquid: 22, clearOfPads: 6,
      },
    },
    {
      id: 'malachite', item: 'malachite', name: 'Malachite',
      rarity: 'uncommon', terrain: 'channel', place: 'the Green Cut',
      /**
       * A VIVID BLUE-GREEN, not a leaf green, and on a jungle planet that is
       * the whole legibility problem in one row.
       *
       * Cinder's rheniite shipped at 0x8c7f6a and rendered as the same cream
       * lump as its tephra: a player had no way to tell a 190 cr flake from an
       * 18 cr nodule at ten metres. The equivalent mistake here is authoring
       * malachite at its own catalogue colour (0x2f8a56) and losing it against
       * the canopy shade band (0x2f6b56) - two colours nine points apart.
       *
       * Copper carbonate is in fact a saturated blue-green and vegetation is a
       * yellow-green, so the honest colour is also the readable one: 0x3fc9a4
       * is 30 degrees bluer and twice as light as any band or canopy tint on
       * the planet, and it sits on grey wall rock, which has no chroma at all.
       */
      color: 0x3fc9a4, glow: 0,
      unitValue: ORE('malachite'), spread: 0.25,
      size: 1.20, count: 20, spacing: 16,
      /**
       * THE EAST BANK, AND ONLY THE EAST BANK.
       *
       * The centreline is the river pushed 18 m east (see `EAST_BANK`), so a
       * width of 15 puts the band at 10.5-25.5 m from the water - outside the
       * 20 m ribbon and inside the 52 m floor. A symmetric corridor on the
       * river itself would have put half the seam on the far bank, which is
       * the same defect as Cinder's sulfur corridor including the floor of a
       * 13 m trench: the fix and the geology are the same fix, because copper
       * carbonate bands out of the wall the water is undercutting and that is
       * the wall you can stand at the foot of.
       *
       * `slopeMaxDeg: 24` keeps it off the toe of the wall where the floor ramp
       * blend starts to climb.
       */
      region: {
        shape: 'corridor', pts: EAST_BANK, width: 15,
        slopeMaxDeg: 24, clearOfLiquid: 2, clearOfPads: 5,
      },
    },
    {
      id: 'resin', item: 'resin', name: 'Amber Resin',
      rarity: 'uncommon', terrain: 'highland', place: 'the Resinwood',
      /* Amber, against a green world. The one complementary hue available, and
       * the one thing on the Greenspan that is not a shade of the ground. */
      color: 0xd98f2a, glow: 0,
      unitValue: ORE('resin'), spread: 0.25,
      size: 0.95, count: 18, spacing: 15,
      /**
       * THE SAME REGION OBJECT AS THE `resinwood` PROP FIELD, spread from one
       * `const`.
       *
       * Resin is sap on standing growth. Two independent region records would
       * agree today and drift the first time either was adjusted, and the seam
       * would end up in open ground with the forest a hundred metres away.
       * `Placement.scatter` is shared by props and minerals exactly so that a
       * field and the thing that grows on it can be one declaration - Cinder
       * does the same with its rift vents and its sulfur.
       *
       * The consequence to check is that the ore is reachable THROUGH the
       * forest and not behind it, which is a question about the growth field's
       * SPACING and is answered on that record.
       */
      region: { ...RESINWOOD },
    },
    {
      id: 'sporecryst', item: 'sporecryst', name: 'Spore Crystal',
      rarity: 'rare', terrain: 'cave', place: 'the Undercroft',
      /**
       * ── WHAT IS REAL HERE AND WHAT IS IMPLIED ────────────────────────────
       *
       * `terrain: 'cave'` is the vocabulary word the brief assigns, and it is
       * honest as a FAMILY LABEL - it is what a survey chart or a contract
       * would say about this deposit. It is not a claim that there is a roof
       * over it, because there cannot be one.
       *
       * A `PlanetWorld` planet is a single-valued heightfield plus instanced
       * props. `Physics._closestPoint` treats a heightfield as solid from its
       * surface down to `baseY` and recovers anything underneath by shoving it
       * straight up, so an adit driven horizontally into a hillside ejects the
       * player through its own roof - `citadel/Caves.js` states that constraint
       * in as many words and works around it by BUILDING the massif out of
       * boxes above the terrain. Nothing in `PlanetWorld` does that, there is
       * no cave landform in `PlanetHeight.LANDFORM_KINDS`, and this file may
       * not add one.
       *
       * So the Undercroft is a SLOT, and everything about it is chosen to buy
       * the read a roof would have given:
       *   16 m of floor between walls 67-71 m tall, which is a 1:4.3 aspect -
       *   the sun clears it for a couple of hours a day at most and the
       *   descriptor's key is at 44 degrees, so it never reaches the floor;
       *   walls painted by the palette's `slope` override, which is the
       *   greyest, least-chromatic colour on the planet;
       *   a chamber at the far end whose only opening is the 16 m slot itself;
       *   and 90 glowing spires, which are the actual light source down there.
       *
       * It is a place that goes properly dark and reads as underground. It is
       * not roofed, and if the renderer ever grows a cave volume this row is
       * the one that should move into it.
       */
      color: 0xa8f0d0, glow: 0x2fd8a8,
      unitValue: ORE('sporecryst'), spread: 0.25,
      size: 0.78, count: 11, spacing: 9,
      /* Width 15 - inside the 16 m floor with a metre to spare, so no node ends
       * up on the flare where the wall starts. `slopeMaxDeg: 16` is belt to
       * that pair of braces. `clearOfPads` is against the LANDING sites only,
       * and the chamber pad is not one, so nodes may sit in the chamber. */
      region: {
        shape: 'corridor', pts: [...UNDERCROFT], width: 15,
        slopeMaxDeg: 16, clearOfLiquid: 4, clearOfPads: 4,
      },
    },
    {
      id: 'verdite', item: 'verdite', name: 'Verdite Heartwood',
      rarity: 'exotic', terrain: 'outcrop', place: 'the Crown',
      /**
       * DARK JADE WITH A CHARTREUSE GLOW, and both halves are chosen against
       * what it will be seen on.
       *
       * The Crown's ground band is the lightest on the planet (L 66) and its
       * canopy is authored pale silver-green on purpose, so a pale mineral up
       * there would vanish twice over. A very dark, very saturated jade is the
       * only body colour with contrast against both.
       *
       * The emissive is the tell. Nothing else on Verdigris is chartreuse - the
       * ground bands top out at 90 degrees of hue with 39 points of saturation,
       * the canopies are 90-160, sporecryst is a mint 160 and resin is amber
       * 35. `PlanetWorld` runs `emissiveIntensity: 2.2` on any seam that
       * declares a glow, which is the value at which Cinder's two rare ores
       * each keep their hue instead of both saturating to cream.
       */
      color: 0x1f6b4a, glow: 0xc8f04a,
      unitValue: ORE('verdite'), spread: 0.22,
      /* The smallest node on the planet and the dearest: one cubic metre, 430
       * credits, and it glows. */
      size: 0.62, count: 7, spacing: 14,
      /**
       * ── THE EXOTIC TIER IS A SECOND LANDING, NOT A LONGER WALK ───────────
       *
       * `definePlanet` already refuses a rarest tier on `plain` or in a `field`
       * region, and that catches the cheap lie. It cannot catch the expensive
       * one, which is a seam nothing can walk to - or worse, one anything can.
       *
       * The Crown's face is 72 m over 26 m of edge. Across the steepest two
       * metres of it the ground moves 8.2 m against the flood lattice's 1.56 m
       * ceiling, on every bearing, so this seam is 0-of-7 reachable from the
       * Greenspan at any distance and reachable from the Crown deck in about
       * twenty metres. That is the shape Cinder's iridite has and it is the
       * only thing that makes "rare" cost a decision rather than time.
       *
       * ── AND WHY THERE IS NO ROAD UP IT ───────────────────────────────────
       *
       * Cinder's colonnade is reachable two ways on purpose - a pad on top and
       * a switchback up the east face - and the same pattern was drafted here.
       * It cannot coexist with the paragraph above: a walkable face makes the
       * exotic tier reachable from the primary pad, which is the one property
       * this tier is required to have. So the two halves went to two different
       * mesas. SHELFWOOD is the canopy mesa you walk up - the Shelf Road wraps
       * 180 degrees of its face at 3.9 degrees, and there is standing growth
       * and an uncommon seam on top of it, so the experience of climbing out
       * onto a canopy is in the world and costs no landing. THE CROWN is the
       * one you fly to.
       *
       * `slopeMaxDeg: 12` also does real work: the two authored spines on the
       * mesa top run to 6.5 m and this keeps the seam off their flanks and on
       * the flats between them, where a body can stand to mine.
       *
       * MEASURED: 0 of 7 from the Greenspan, 0 of 7 from Sumphead, 7 of 7 from
       * the Crown deck at 36 walking metres.
       */
      region: {
        shape: 'disc', x: 210, z: -230, r: 82,
        slopeMaxDeg: 12, clearOfPads: 5, clearOfLiquid: 10,
      },
    },
  ],

  /* ---------------------------------------------------------------- */
  landing: [
    {
      /* The Greenspan. On the bench, at the head of the Stairgill, with the
       * Crown on the skyline to the north-east and the Horn to the north-west. */
      id: 'greenspan', name: 'Greenspan Clearing', x: GREENSPAN[0], z: GREENSPAN[1], r: 30, primary: true, yaw: -1.9,
    },
    {
      /* Sumphead. River level, inside the gorge, notched into the east wall.
       * It exists so the malachite and sporecryst runs are a landing rather
       * than a 280 m descent and a 280 m climb with a full hold. */
      id: 'sumphead', name: 'Sumphead Shelf', x: -140, z: 300, r: 20, yaw: -0.6,
    },
    {
      /* The Crown deck. The exotic tier's whole cost. */
      id: 'crown', name: 'Crown Deck', x: 210, z: -230, r: 22, yaw: 2.6,
    },
  ],

  hazards: {
    /** Spore and pollen drift rather than ash. `PlanetWorld._buildAtmosphere`
     *  draws it as a camera-wrapped point field; nothing takes damage from it.
     *  Pale yellow-green, drifting with the same westerly the sun sits in. */
    ashfall: { density: 0.50, drift: [0.35, -0.15] },
    ashColor: 0xd8e8a8,
    steamColor: 0x9fbfae,
  },
});

export default VERDIGRIS;
