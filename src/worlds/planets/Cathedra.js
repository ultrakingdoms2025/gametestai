/**
 * CATHEDRA - the crystal world, and the far edge of the system.
 *
 * 288 km out: the longest leg in the game, about ninety seconds under the
 * transit drive. Being furthest is the identity, so arriving has to feel like
 * arriving somewhere ELSE and not somewhere further. Every other body in the
 * system is built out of curves - Cinder is a shield, Sirocco is waves,
 * Verdigris is mesas. This one is built out of STRAIGHT LINES: the crust is
 * broken sheets, and where two sheets meet one stands above the other along a
 * clean fault face. From orbit `Bodies.js` already draws it as a dark blue-grey
 * disc webbed in white, legible by its cracks rather than by its shape. This
 * file is that same fact at eye level.
 *
 * ==========================================================================
 *  THE MAP, in words
 * ==========================================================================
 *
 * 800 m square, `+x` east and `+z` south. There is no liquid anywhere on this
 * planet, and no sea level; heights are quoted against THE PAVEMENT at y = 26,
 * which is both the base plain and the lowest plate you can land on.
 *
 * Three fault lines cut the map into five plates. They do not run parallel -
 * parallel faults are TERRACES, and a staircase is not a shattered pane. They
 * CROSS, at 60 to 90 degrees, which is what turns four blocks into five and
 * makes every plate a different polygon at a different height.
 *
 *   THE PAVEMENT        the low south-east plate, y 26, and the primary
 *                       landing. A dead-flat sheet 150 m across (a `plateau`,
 *                       so it is a plate top that HAPPENS to be level, not
 *                       something cut) with the rest of the block swelling
 *                       gently away from it. Quartzite is the gravel of it.
 *
 *   THE SPINE           the master fault, running the full 800 m north to
 *                       south at about x = 0, wandering +/- 25 m so it is a
 *                       fracture and not a ruled line. The west side stands
 *                       32 m proud and the face falls in 13 m - a 68 degree
 *                       cliff, and the single most legible thing on the
 *                       planet. Beryl grows in the seam along it; the
 *                       landmark spires grow out of it.
 *
 *   THE CHOIR           the mid-west plate, y 58, and the spire field. Four
 *                       hundred pinnacles, 4 to 17 m, standing on a sheet
 *                       that a `plateau` has made dead flat, so nothing about
 *                       the ground competes with the silhouette.
 *
 *   THE LECTERN         a second plate lifted 16 m out of the middle of the
 *                       Choir, 108 m across, its rim a walkable 31 degrees.
 *                       Spectrolite is on top of it, in among the spires, and
 *                       the only way onto it is THROUGH them.
 *
 *   THE CLEFT           the only route from the Pavement onto the Choir. A
 *                       `ramp` 224 m long at 8 degrees that runs out onto an
 *                       embankment, crosses the Spine, and continues as a 21 m
 *                       deep slot cut through the plate edge before it comes
 *                       out on the Choir. Delete it and the two halves of the
 *                       walkable world stop being connected - which is
 *                       measured in the reachability probe as an ablation.
 *
 *   THE GALLERY         the north-east plate, y 50, and the second landing. It
 *                       exists so the northern third of the Spine seam is
 *                       reachable at all: the Cross fault below it is 24 m in
 *                       10 m and nothing walks up that.
 *
 *   THE CROWN           the north-west plate, y 82, the highest ground and the
 *                       only plate that touches the sky on its own. Nothing
 *                       walks onto it from anywhere - it is reached by landing
 *                       on it, and that is the whole design of the exotic ore.
 *
 *   THE VAULT           a 148 m hole in the Crown, 66 m deep, its floor a
 *                       dead-flat 62 m disc at y 16 - the lowest ground on the
 *                       planet and the darkest band in the palette. Lucent
 *                       grows on that floor. The way in is THE LANTERN, a
 *                       landing shelf on the rim, and a road that spirals 297 m
 *                       down the inside wall.
 *
 *   THE SUNKEN PANE     the far south-east corner, DROPPED 14 m by the third
 *                       fault instead of lifted. It is the one fault on the
 *                       planet you can walk over (14 m in 36 m, a 22 degree
 *                       rollover), and it is where the failed sheets have piled
 *                       up: ninety upended slabs lying at every angle.
 *
 * ==========================================================================
 *  WHY THE NUMBERS ARE THESE NUMBERS
 * ==========================================================================
 *
 * -- The relief budget ------------------------------------------------------
 *
 * Authored relief runs from the vault floor at 16 to the Crown at 82: 66 m of
 * step and cut, plus a 14 m downthrow and a 16 m plateau on top of that. The
 * noise - swell 4.6, ripple 1.3, grain 0.26 - totals 6.16 m, which is 6.4% of
 * the authored range. That is deliberately even LOWER than Cinder's 7%: a
 * plate has to read as a SHEET, and the moment the swell is tall enough to
 * notice on a plate top the whole conceit turns back into hills. What the
 * noise is for here is the block INTERIORS, away from the four plateaus, where
 * its whole job is to stop the fault polygons reading as CAD.
 *
 * -- Why `scarp` and not `plateau` for the boundaries -----------------------
 *
 * `scarp` is the only landform in the vocabulary whose edge is a LINE. It
 * raises an entire half-plane, and the half-plane's boundary is the authored
 * polyline continued past both ends - so a fault runs off the map instead of
 * stopping dead. That is exactly what a plate boundary is and it is why this
 * planet was worth adding the kind for. A `plateau` cannot do it: the nearest
 * circle to a boundary is a saucer.
 *
 * The two are therefore used for two different jobs, and the split is the
 * design:
 *
 *   BOUNDARIES are scarps.  Lines, unbounded, crossing.
 *   TOPS are plateaus.      Sized to sit well INSIDE their own block, with
 *                           `y` within a metre of the block's own height, so
 *                           the plateau's circular rim is a metre of relief
 *                           over forty and is invisible. Its only job is to
 *                           take the swell OFF the plate top and leave a
 *                           sheet.
 *
 * The ADD layer runs in array order, so the plateaus are listed AFTER the
 * scarps: a `plateau` is absolute, so a scarp listed after one would add its
 * 32 m on top of the table rather than under it.
 *
 * -- Why the fault faces are the heights they are ---------------------------
 *
 * A fault face has one job beyond looking like a fault: it has to be a WALL,
 * so that "which plate am I on" is a decision the player makes at a landing
 * site rather than a thing they wander across. The walk probe accepts 38
 * degrees over a 2 m lattice, which is a gradient of 0.781. `scarpAt`'s face
 * profile is a smoothstep, so its gradient is `height * 6t(1-t) / run`,
 * peaking at `1.5 * height / run` in the middle and going to ZERO at both
 * ends - which means a face with a merely-average gradient of 0.8 is walkable
 * near its foot and near its lip and blocked only in a thin band that a 2 m
 * lattice can hop.
 *
 *   fault   authored     predicted peak   MEASURED peak 2 m gradient across
 *                        gradient         the face, over 11-14 stations
 *   ------  -----------  ---------------  ---------------------------------
 *   Spine   32 m in 13   3.69             median 3.65, max 3.70
 *   Cross   24 m in 10   3.60             median 3.57, max 3.61
 *   Shard   14 m in 36   0.58             median 0.63, max 0.79  WALKABLE
 *
 * The first two are 4.7 times the 0.781 ceiling at their steepest,
 * which is the margin the noise has to eat through before a plate boundary
 * quietly stops being one. The Shard's max of 0.79 is a hair over the ceiling
 * at one station out of eleven, which costs a step sideways and nothing else -
 * the walk probe reaches every quartzite node on the Sunken Pane from the
 * primary pad.
 *
 * -- What was measured, and what it came out at -----------------------------
 *
 * A throwaway probe built the world headless, flooded the REAL colliders from
 * every pad on a 2 m lattice at 38 degrees with no jump and no mantle, and
 * sampled the height field on a 1 m grid. What it found:
 *
 *   finiteness      0 non-finite out of 641,601 samples; y -16.35 .. 87.70
 *   minerals        36/36, 18/18, 11/11, 6/6 - no seam under-delivers
 *   props           46, 34, 380, 110, 90, 820, 460 - every field placed in full
 *   pad flatness    0.00 m, 0.00 m, 0.01 m across the three landing discs
 *   reachability    every node reachable from some pad; lucent 0 of 6 from the
 *                   primary and 6 of 6 from the Lantern
 *   the three pads  61.9% + 20.5% + 17.6% = 100.0% of all standable ground, so
 *                   there is no orphaned ground anywhere on the planet
 *   spire lanes     4.74 m at the worst pair in the Choir
 *   ablation        delete the Cleft and the Lectern is unreachable from the
 *                   primary pad - it is the only route, by measurement
 */

import { definePlanet } from './PlanetDescriptor.js';
import { ITEMS } from '../../systems/ItemDefs.js';

/**
 * Credits per cubic metre of hold, read off the item catalogue.
 *
 * Same arrangement as Volcanic.js and for the same reason: the price of an
 * element belongs to the ELEMENT. Throwing on a missing row rather than
 * returning `undefined` is the difference between a loud boot failure and a
 * planet whose deposits are all worth NaN.
 *
 * @param {string} id an `ITEMS` id
 * @returns {number} credits per cubic metre
 */
const ORE = (id) => {
  const def = ITEMS[id];
  if (!def) throw new Error(`[Cathedra] mineral names item "${id}", which has no ITEMS row`);
  return def.value;
};

/* ------------------------------------------------------------------ */
/* Frame of reference                                                  */
/* ------------------------------------------------------------------ */

/** Playfield half-extent. */
const HALF = 400;

/**
 * The Pavement's nominal height, and the base plain everything is quoted
 * against. Not a sea level - there is no liquid on this planet at all.
 */
const PLAIN = 26;

/* The five plate heights, derived rather than typed twice. A scarp is an ADD,
 * so a block that is on the high side of two faults carries both. */
const THROW_SPINE = 32;   // west of the Spine stands this much proud
const THROW_CROSS = 24;   // north of the Cross stands this much proud
const THROW_SHARD = -14;  // the far south-east corner is DROPPED this much

/** The five plates, by name, in metres of world Y. */
const PAVEMENT = PLAIN;                                // 26  low SE
const SUNKEN = PLAIN + THROW_SHARD;                    // 12  the dropped corner
const GALLERY = PLAIN + THROW_CROSS;                   // 50  NE
const CHOIR = PLAIN + THROW_SPINE;                     // 58  SW
const CROWN = PLAIN + THROW_SPINE + THROW_CROSS;       // 82  NW, the roof

/** How deep the Vault is cut into the Crown, and therefore its floor. */
const VAULT_DEPTH = 66;
const VAULT_FLOOR = CROWN - VAULT_DEPTH;               // 16, the lowest ground

/** The Lectern: a second plate lifted out of the middle of the Choir. */
const LECTERN_Y = CHOIR + 16;                          // 74

const D2R = Math.PI / 180;

/** The Vault's axis, and the polar frame the rim, the road and the pad share. */
const VX = -225;
const VZ = -255;
/** A point at polar (d, bearing-in-degrees) about the Vault axis. */
const V = (d, deg) => [
  +(VX + d * Math.cos(deg * D2R)).toFixed(2),
  +(VZ + d * Math.sin(deg * D2R)).toFixed(2),
];

/* ------------------------------------------------------------------ */
/* The three faults                                                    */
/* ------------------------------------------------------------------ */

/**
 * THE SPINE - the master fault, north to south, west side up.
 *
 * It wanders about x = 0 by up to 30 m over legs 130-170 m long. Straight
 * would be a ruled line and would read as a wall somebody built; this reads as
 * a fracture. The wander is small enough that the polyline never doubles back,
 * which matters: `scarpAt` reads the SIGN of the cross product against the
 * nearest segment, and a line that folded over itself would flip that sign in
 * mid-air and stand a 32 m step in the middle of a plate.
 *
 * `side: 1` raises the west. Worked through rather than guessed: the line runs
 * with +z, so for a sample to the east the cross product is negative, and
 * `into = sign * side * d` is therefore negative there - the falling side.
 */
const FAULT_SPINE = [[-8, -400], [16, -244], [-24, -110], [8, 26], [-30, 168], [-4, 400]];

/**
 * THE CROSS - west to east, north side up, crossing the Spine at about
 * (0, -70) at very close to a right angle.
 *
 * Crossing is the whole point. Two parallel faults give terraces; two that
 * cross give four blocks, all four of them different polygons at four
 * different heights, and that is the difference between a staircase and a
 * shattered pane.
 *
 * The first and last legs are deliberately near-horizontal. `extendPolyline`
 * continues the line past both ends along the bearing of those two legs, and a
 * steeply-angled end leg would swing the extension across a corner of the map
 * and put a fault where none was authored.
 */
const FAULT_CROSS = [[-400, -104], [-250, -120], [-58, -62], [128, -108], [304, -58], [400, -66]];

/**
 * THE SHARD - across the south-east corner, and the one fault that DROPS its
 * block rather than lifting it (`height` is negative, which `scarpAt` handles
 * without a special case: the raised half-plane is simply below the ground it
 * left).
 *
 * `run: 36` against a 14 m throw makes this the one fault face on the planet a
 * body can walk down. That is on purpose and it is a variety decision: with all
 * three faults as cliffs the map would be four sealed rooms, and a planet whose
 * every boundary is impassable teaches the player nothing about which
 * boundaries matter.
 */
const FAULT_SHARD = [[400, 40], [286, 130], [176, 216], [92, 306], [30, 400]];

/* ------------------------------------------------------------------ */
/* The two routes that make the far plates places and not postcards    */
/* ------------------------------------------------------------------ */

/**
 * THE CLEFT - the only way from the Pavement onto the Choir on foot.
 *
 * 224 m of ramp for 32 m of rise, i.e. 8.1 degrees. Its head is at (60, 46) on
 * open Pavement rather than at the primary pad: a `ramp` with no `y0` takes the
 * pre-level field height at its first point, so starting on flat ground makes
 * it meet that ground with no step at all, and the 106 m of level plate between
 * the pad and the head is a walk rather than a riser.
 *
 * What makes it read is that a linear ramp crossing a 32 m step has to be BOTH
 * an embankment and a cut. Measured against the field: it stands up to 10 m
 * proud of the Pavement on the east side and runs up to 21 m BELOW the Choir on
 * the west, so the player walks out onto a causeway, into a slot, and out onto
 * a plate. The slot's walls are the ramp's own 16 m blend against a 21 m drop -
 * 51 degrees, unwalkable, which is what keeps the Cleft the only route.
 */
const CLEFT = [[60, 46], [-10, 26], [-90, -6], [-150, -30]];

/**
 * THE LANTERN - the landing shelf on the Vault rim, at d 96 on bearing 40.
 *
 * Far enough out that its 20 m disc (76-116 m from the axis) clears the 74 m
 * mouth entirely, so the pad is apron and not overhang; close enough that the
 * road off it starts descending inside one leg.
 */
const LANTERN = V(96, 40);

/**
 * THE VAULT ROAD - 297 m of spiral down the inside of the Vault wall, for 66 m
 * of descent: 12.5 degrees.
 *
 * IT STARTS AT THE PAD CENTRE, and that is load-bearing rather than tidy - the
 * same mechanism Volcanic.js records for its spiral. A `ramp` with no explicit
 * `y0` takes its head height from the pre-level field at its first point, which
 * is precisely the height the pad levels itself to, because a `pad` with no
 * explicit `y` does the same thing at the same place. Start the road a metre
 * away and the two resolve to different numbers and the player steps off a
 * riser they cannot see.
 *
 * 40 degrees round to 316, one three-quarter turn, so no two legs share a
 * bearing and the turns cannot merge into a flattened cone. Radii fall
 * monotonically, so a spiral in one turn cannot cross itself.
 */
const VAULT_ROAD = [
  LANTERN,
  V(84, 74),
  V(72, 112),
  V(66, 152),
  V(58, 194),
  V(50, 236),
  V(40, 278),
  V(26, 316),
];

/**
 * THE VAULT RIM - a broken ring of upthrust around the mouth, radius 78-94.
 *
 * A `ridge` on a closed polyline, with the radius jittered per vertex so the
 * ring is not a circle. Without it the Vault is a dimple in a flat sheet; with
 * it, it is a roof that has fallen in. The Lantern's pad is a LEVEL and runs
 * last, so it cuts a clean notch straight through the rim - the shelf is
 * blasted through the collapse, which is what a landing site on a hole should
 * look like.
 */
const VAULT_RIM = [
  V(88, 0), V(80, 45), V(92, 90), V(78, 135),
  V(90, 180), V(84, 225), V(94, 270), V(80, 315), V(88, 360),
];

/* ------------------------------------------------------------------ */
/* The descriptor                                                      */
/* ------------------------------------------------------------------ */

export const CATHEDRA = definePlanet({
  id: 'cathedra',
  name: 'Cathedra',
  blurb: 'The far edge of the system. Shattered plates with fault faces cut like lines, spire fields growing out of the seams, and a hollow vault under the Crown where lucent grows.',

  half: HALF,
  /** 256 segments over 800 m: a 3.125 m cell, the same as Cinder's. The mesh
   *  and the collision heightfield are the SAME grid, so this number buys both
   *  the fault line's silhouette and the ground the player stands on. */
  seg: 256,

  /**
      * 0.67 g, and BOTH consumers read it.
     *
     * This used to say "Phase 1 does not retune the player integrator against
     * it", which was true and honest while gravity reached only the ship. It
     * reaches the player on foot now, through the one predicate in
     * `WorldRules.worldGravity`: `Piloting._env` gives the flight model
     * `(0, -6.60, 0)`, and `Player.setWorldGravity` converts 6.60 to a ratio
     * against `CONFIG.player.gravityReference` (9.81) and walks in -14.80 m/s²
     * rather than the global -22.
     *
     * Measured here by driving the real controller: apex 1.052 m, hang
     * 0.649 s, against 0.878 m / 0.533 s on a world that publishes no
     * gravity at all. At 0.67 g the difference is meant to be felt rather than
     * played with - the variety is at the other end of the ladder, on Tessera
     * (0.17 g) and Lathe (0.19 g).
     *
     * @see ../../player/Player.js `setWorldGravity`
     */
  gravity: 6.60,

  /* ---------------------------------------------------------------- */
  terrain: {
    seed: 0xca7ed7,
    baseY: PLAIN,
    /** Broad swells, 230 m wavelength and LOW. A sheet that undulates is not a
     *  sheet, and the four plateaus below remove this from the plate tops
     *  entirely; what is left of it lives in the block interiors. */
    swell: { amp: 4.6, scale: 230, octaves: 4 },
    /** Ripple, ridged - fracture-scale wrinkle, not dune-scale wave. */
    ripple: { amp: 1.3, scale: 52, octaves: 3 },
    /** Grain, at the scale of a footfall. Keeps the normals off glassy. */
    grain: { amp: 0.26, scale: 24 },
    /** The map's edge falls away rather than walling up. */
    rim: { start: 352, drop: 26 },

    landforms: [
      /* ---- ADD: the boundaries first ------------------------------ *
       * Order inside this layer matters and it was chosen, not inherited: a
       * `plateau` is ABSOLUTE, so a scarp listed after one would stack its
       * throw on top of the table instead of under it. Scarps, then tables,
       * then the one ridge - which has to come after the Crown's table or the
       * table would flatten it away.                                        */
      { kind: 'scarp', pts: FAULT_SPINE, height: THROW_SPINE, run: 13, side: 1 },
      { kind: 'scarp', pts: FAULT_CROSS, height: THROW_CROSS, run: 10, side: -1 },
      { kind: 'scarp', pts: FAULT_SHARD, height: THROW_SHARD, run: 36, side: -1 },

      /* ---- ADD: the plate tops ------------------------------------ *
       * Every `y` here is within a fifth of a metre of the block's own height,
       * and every `r + edge` was checked against the distance from the centre
       * to the nearest fault line. Both facts are the same fact: a table whose
       * rim reached a fault would blend the fault face away, and a table whose
       * `y` disagreed with its block would print a circle on the map.        */

      /** The Crown, and the Vault's apron. r 100 + edge 42 = 142 against 142.5
       *  to the Cross - the tightest fit on the planet, and the reason the
       *  Vault axis is at z -255 and not further south. */
      { kind: 'plateau', x: VX, z: VZ, r: 100, edge: 42, y: CROWN + 0.2 },
      /** The Choir. The spire field stands on this. */
      { kind: 'plateau', x: -215, z: 140, r: 120, edge: 56, y: CHOIR + 0.2 },
      /** The Gallery. */
      { kind: 'plateau', x: 215, z: -240, r: 96, edge: 44, y: GALLERY + 0.3 },
      /** The Pavement. The primary pad sits on this, which is the answer to
       *  "is a landing site a plate top or something cut" for two of the three
       *  sites on this planet: it is a plate top, and the pad below only takes
       *  the last few centimetres of grain out of the disc. */
      { kind: 'plateau', x: 150, z: 80, r: 76, edge: 42, y: PAVEMENT + 0.4 },
      /** THE LECTERN. Listed after the Choir so it wins where they overlap,
       *  and it overlaps entirely - its centre is 56 m from the Choir's, so
       *  the whole 108 m table stands out of dead-flat sheet.
       *
       *  `edge: 40` for a 16 m lift is a 0.4 mean gradient and a 0.6 peak,
       *  i.e. 31 degrees: a climb, and inside the 38 the walk probe allows. At
       *  the first try (`edge: 18`) the peak was 49 degrees and the whole rare
       *  seam sat on top of a wall. */
      { kind: 'plateau', x: -250, z: 96, r: 54, edge: 40, y: LECTERN_Y },

      /** The Vault's collapsed rim. */
      { kind: 'ridge', pts: VAULT_RIM, width: 16, height: 5.5 },

      /* ---- CUT ---------------------------------------------------- */
      /**
       * THE VAULT, AND WHAT IS ACTUALLY THERE.
       *
       * Say the honest thing first: THERE IS NO ROOF. `PlanetHeight` returns
       * one Y for one (x, z) and `PlanetWorld` builds a single heightfield
       * mesh out of it, so the renderer cannot make a cave, an overhang or an
       * enclosed chamber, and nothing in the vocabulary would have let this
       * file ask for one. `terrain: 'cave'` on the lucent row below is a
       * MINERAL_TERRAINS label - it is what the HUD and a future survey chart
       * read - and it is not a claim about geometry.
       *
       * What is real is a shaft: 148 m across, 66 m deep, walls that nothing
       * walks up or down, a floor that is the lowest ground on the planet by
       * 28 m, and the darkest and only violet band in the palette waiting at
       * the bottom of it. Standing on that floor, the sky is a hole overhead
       * and the horizon is gone in every direction. That is the read the brief
       * asked for, built out of what exists, and the part that is implied
       * rather than modelled is the ceiling.
       *
       * 66 m deep inside a 74 m radius with the inner 42% level, so the floor
       * is a flat 62 m disc at y 16 and the wall is 66 m of fall over 43 m of
       * run: a 57 degree mean and a 72 degree peak. That is what makes the
       * Vault a second landing rather than a longer walk - nothing walks in or
       * out of it, in either direction, and the probe measures that as 0 of 6
       * lucent nodes reachable from the primary pad.
       *
       * It is cut AFTER the Crown's plateau, because the CUT layer always runs
       * after the whole ADD layer - so the hole is punched through the table
       * rather than the table filling the hole.
       */
      { kind: 'basin', x: VX, z: VZ, r: 74, depth: VAULT_DEPTH, flat: 0.42 },

      /* ---- LEVEL -------------------------------------------------- *
       * ROADS FIRST, PADS LAST, which is the ordering Volcanic.js paid for:
       * with the pads first, a road leaving a pad centre at grade has already
       * taken metres off the landing disc before it reaches the edge. With the
       * pads last, the pad's disc wins outright and the road emerges from the
       * pad EDGE where the blends hand over with no step.                    */

      /** The Cleft, up onto the Choir. `y0`/`y1` both default, so the head
       *  meets the Pavement and the toe meets the Choir exactly. */
      { kind: 'ramp', pts: CLEFT, width: 9, blend: 16 },
      /** The Vault Road. Starts at the Lantern's centre - see `VAULT_ROAD`. */
      { kind: 'ramp', pts: VAULT_ROAD, width: 8, blend: 12 },

      { kind: 'pad', x: 150, z: 80, r: 32, blend: 24 },
      { kind: 'pad', x: 215, z: -240, r: 26, blend: 20 },
      { kind: 'pad', x: LANTERN[0], z: LANTERN[1], r: 22, blend: 16 },
    ],
  },

  /* ---------------------------------------------------------------- */
  palette: {
    /** This was `stone.castle`, on the argument that a hard blocky grain is
     *  what a fractured plate wants underfoot. What it actually put on the
     *  ground was MASONRY: `shadeStoneCastle` lays a running bond with mortar
     *  courses, and at 4.5 m a tile that is metre-wide dressed blocks. The
     *  Pavement rendered as a paved plaza on a world whose whole identity is
     *  that its crust is broken sheets nobody laid. A fault face is not a wall.
     *
     *  `rock.neutral` is what the header already says the ground here IS -
     *  "quartzite is the gravel of it" - a granular lag with shrinkage
     *  polygons, and it is hue-free by construction, so this table's 99 degrees
     *  of hue is the only thing colouring the plates. `stone.castle` was at
     *  least grey and so was not tinting the bands, which is why this planet
     *  read better than the other nine; the defect here was pattern, not
     *  colour. @see shadeRockNeutral in gfx/Materials.js */
    material: 'rock.neutral',
    /** 4.5 m a tile. Finer than Cinder's 6.0 because the fault faces are the
     *  hero surface here and they are only 10-13 m of run each - at 6.0 a
     *  whole cliff was under one texel row. NEVER zero: a zero tile is a NaN
     *  uv, and 19 NaN pixels blacked out 921,600 in this repo once. */
    tile: 4.5,
    /**
     * Absolute-height bands.
     *
     * ══════════════════════════════════════════════════════════════════════
     *  A GREY-BLUE CRYSTAL WORLD IS THE EASIEST PLACE IN THE GAME TO REPEAT
     *  CINDER'S DEFECT, AND THE NUMBERS SAY SO
     * ══════════════════════════════════════════════════════════════════════
     *
     * Cinder shipped six bands across FIVE degrees of hue and ZERO saturation
     * change, and the tester who walked it wrote "one flat salmon-brown hue,
     * no rock, no ash, no shadows". "Dark blue-grey rock, pale blue rock,
     * paler blue rock" is the same table in cool clothes and would earn the
     * same sentence.
     *
     * So the value structure is kept - dark low, bright high, which is what
     * makes a plate boundary read as a step from any distance - and every
     * remaining degree of freedom is spent on HUE and SATURATION, both of
     * which are free:
     *
     *   y   4  #1a1630  hue 255  sat 37  L 14   the Vault floor: violet-black
     *   y  20  #2f3f52  hue 208  sat 27  L 25   low rock, cold blue
     *   y  34  #53596b  hue 225  sat 13  L 37   the Pavement: near neutral
     *   y  46  #7a6f78  hue 311  sat  5  L 46   shatter aprons: WARM mauve
     *   y  62  #7f93b2  hue 216  sat 25  L 60   the Gallery and the Choir
     *   y  78  #b0bfd0  hue 212  sat 22  L 75   the Lectern and upper plate
     *   y  96  #eef2fb  hue 222  sat 62  L 96   the Crown: near-white
     *
     * Measured off this table: 99 degrees of hue spread against Cinder's 5,
     * and saturation running 5 to 62 against Cinder's flat 24. The value
     * structure is strictly monotonic, L 14 up to 96, which is what keeps a
     * plate boundary legible as a step from the far side of the map.
     *
     * The two entries that do the most work are the ones
     * that look wrong written down:
     *
     *   the VIOLET floor, because it is the only thing on the planet that is
     *   not on the blue axis, and it is at the bottom of a 66 m hole where
     *   there is nothing to compare it to except memory; and
     *
     *   the near-desaturated WARM mauve at y 46, which is the height band the
     *   rubble aprons and the lower faces live in. A cool world needs one warm
     *   note or the cold stops being a colour and becomes the absence of one.
     */
    bands: [
      { upTo: 4, color: 0x1a1630 },
      { upTo: 20, color: 0x2f3f52 },
      { upTo: 34, color: 0x53596b },
      { upTo: 46, color: 0x7a6f78 },
      { upTo: 62, color: 0x7f93b2 },
      { upTo: 78, color: 0xb0bfd0 },
      { upTo: 96, color: 0xeef2fb },
    ],
    /**
     * THE FAULT FACES, AND WHY THEY ARE THE DARKEST THING ON THE PLANET.
     *
     * Every face on this world is between 57 and 72 degrees, so this term
     * addresses exactly the fault faces, the Vault wall and the Cleft's slot
     * and nothing else - the plate tops are all under 4 degrees and the
     * Lectern's rim tops out at 31.
     *
     * Violet-black, not grey. The bands above have already put near-white on
     * the plate tops; painting the faces the same hue two stops down would
     * make the boundary a VALUE step, which is a thing the eye reads as shape.
     * Making it a hue step as well is what turns it into a LINE, which is the
     * whole identity of the planet stated in one colour.
     */
    slope: { fromDeg: 30, toDeg: 56, color: 0x2a2340 },
    /**
     * The iridescent sheen, and the term that stops a banded world reading as
     * a contour map.
     *
     * Applied as `n * n * amount`, so most of the field never gets near the
     * ceiling: at the median n of about 0.5 this is a 13% lerp and at the
     * bright end of the noise about 42%. Pale cold blue, so the patches read
     * as light CAUGHT rather than as a second rock type - which is the one
     * thing a crystal world can do that a rock world cannot.
     *
     * 0.52 and not Cinder's 0.72. The strong version washed the Vault floor
     * from violet-black to a mid blue and took the darkness with it, and the
     * Vault being dark is doing work no other part of the palette can do.
     */
    mottle: { scale: 58, amount: 0.52, color: 0x7d9cc4 },
  },

  sky: {
    kind: 'alpine',
    /**
     * THE HARDEST LIGHT IN THE SYSTEM, and that is the design brief for it.
     *
     * Sallow is overcast; Cinder is dust. This is thin, clean, cold air over a
     * crystal world, and the whole point of it is that shadows have EDGES.
     * Four numbers do that and every one of them is pushed past the alpine
     * preset's own defaults:
     */
    params: {
      /* Sun in the NORTH-EAST at 27 degrees, not the preset's 64.
       *
       * A 27 degree sun casts a shadow 1.93 times the height of what casts it,
       * so a 44 m landmark spire lays 85 m of shadow across a plate. At the
       * preset's 64 degrees the same spire lays 21 m and the field reads as
       * pins in a board.
       *
       * The bearing is chosen off the FAULTS and not off the origin. The
       * Spine's face looks east, so a north-east sun rakes straight down it;
       * the Cross's face looks south, so the same sun leaves it in full
       * shadow. One family of faults reads as a bright line and the other as
       * a dark one, from the same light, at the same moment. */
      sunDirection: [0.52, 0.46, -0.72],
      /* Warm key on a cold world. The cold is a colour only while something
       * in frame is not cold. */
      sunColor: 0xfff2dc,
      sunIntensity: 19,
      /* 0.012 against the preset's 0.017: a smaller disc is a harder
       * terminator, and this planet is the furthest from the star. */
      sunAngularSize: 0.012,
      /* Rayleigh UP and Mie almost off - the deepest zenith in the game and
       * essentially no forward scatter, i.e. no haze to soften an edge. */
      rayleigh: 4.2,
      mie: 0.10,
      mieG: 0.66,
      altitude: 5200,
      groundColor: 0x8ea0bc,
      hazeColor: 0xbdd2ee,
      /* 0.10 against the preset's 0.22. The horizon stays a line. */
      horizonHaze: 0.10,
      cirrus: 0.16,
      cirrusScale: 3.0,
      cirrusSpeed: 0.0016,
    },
    background: 0x0d1836,
    /**
     * ── The fog ───────────────────────────────────────────────────────────
     *
     * `half` is 400, so the playfield is 800 m square and its diagonal is
     * 1,131 m. 1250 is 1.10x that: the diagonal is fully extinguished and the
     * rim at 400 m is only a quarter of the way in, so the far plates read as
     * silhouettes with air in front of them and the map does not visibly stop.
     *
     * `near: 220` is unusually far out and it is the thin-air decision: on
     * Cinder the dust starts working at 120 m, and here nothing within two
     * hundred metres should be softened at all, because softening the near
     * field is precisely what would take the edges off the fault faces this
     * planet is made of.
     *
     * The colour is LIGHTER and GREYER than the ground bands beneath it,
     * which `planet-atmosphere.test.mjs` re-derives from the table above
     * rather than from a copy. Measured in the working (linear) space: the
     * bands average L 0.306 / S 0.290 and this fog is L 0.535 / S 0.258 -
     * lighter by 0.229 and greyer by 0.032, both with margin.
     */
    fog: { color: 0xa9bcd6, near: 220, far: 1250 },
    /**
     * ── And the ambient is the lowest on any lit world here ────────────────
     *
     * 0.30 against a key of 8.6 is a 29:1 ratio between a face turned to the
     * sun and a face turned away from it. Cinder runs 0.46 against 6.4, which
     * is 14:1, and Cinder is a world with a lava lake bouncing light around
     * it. There is nothing here to bounce: no liquid, no atmosphere worth the
     * name and an albedo that is high but specular rather than diffuse. What
     * that ratio buys is that a 68 degree fault face in shadow is a DIFFERENT
     * VALUE from a plate top, at every distance, which is the single fact the
     * whole planet is built on.
     *
     * The ambient's colour is deep blue on purpose. A neutral fill at this
     * intensity would read as underexposure; a blue one reads as sky.
     */
    ambient: { color: 0x3c4e86, intensity: 0.30 },
    sun: { color: 0xfff2dc, intensity: 8.6, direction: [0.52, 0.46, -0.72] },
    exposure: 1.10,
    /**
     * The STATION grade, and not the space one, which is the tempting answer.
     *
     * `space` is the hardest preset in `GRADE_PRESETS` - contrast 1.16, zero
     * haze - and on a hard-lit world that all sounds right. Its bloom
     * threshold is 1.60, which is the lowest in the game, and `Bodies.js`
     * already records what that costs: Vitrine's rim went over it. A sunlit
     * near-white plate top under a key of 8.6 is far over it, so the space
     * grade would bloom the GROUND and every fault edge would go soft, which
     * is the one thing this planet cannot afford.
     *
     * `station` is threshold 3.00 with a wide knee, so only the emissive
     * crystal flares, plus complementary split toning - shadows pushed cold
     * blue (0.70, 0.90, 1.22) and highlights pushed warm (1.14, 1.01, 0.80).
     * That is the exact tension a cold world lit by a warm sun wants, and it
     * was already calibrated against measured linear-HDR luminance.
     */
    grade: 'station',
  },

  /* ---------------------------------------------------------------- *
   * No liquid. Nothing on this planet is molten, wet or frozen enough to
   * pool - it is 6.6 m/s^2 of fractured silicate at the cold end of the
   * system. `liquid: null` is explicit rather than absent so that a reader
   * looking for the lakes finds this sentence instead of a missing key.     */
  liquid: null,

  /* ---------------------------------------------------------------- */
  props: [
    /**
     * THE LANDMARK SPIRES, growing out of the Spine.
     *
     * `spires` was added to the vocabulary largely for this planet and this is
     * the field it was added for: 20 to 44 m of faceted, tapering, leaning
     * pinnacle standing along the master fault for the full 800 m of it. From
     * the primary pad these are the skyline, and they are the reason the Spine
     * is legible from a plate you cannot see it from.
     *
     * The corridor runs 9-30 m off the fault line. The inner 9 excludes the
     * face itself, which `slopeMaxDeg: 28` would reject anyway; the outer 30
     * keeps the field a SEAM rather than a scatter, so what the player sees is
     * a line of crystal marking a line in the ground.
     *
     * 24 m spacing against a 3.9 m maximum base: the collider is the spire's
     * FOOT at 0.775 x 0.8 of the base, so the worst two neighbours can do is
     * leave a 15.7 m lane. This field is scenery you walk through, not past.
     */
    {
      id: 'spires_spine',
      kind: 'spires',
      region: { shape: 'corridor', pts: FAULT_SPINE, width: 30, widthInner: 9, slopeMaxDeg: 28, clearOfPads: 8 },
      count: 46, spacing: 24,
      /* Six facets. `PlanetProps` clamps this to 4..7 and rounds it; six is
       * the beryl habit, and it is also the one that catches two lit facets at
       * once under a raking sun instead of one. */
      size: { h: [20, 44], base: [1.8, 3.9], lean: 0.14, facets: 6 },
      tint: [0xc9d6ee, 0x9fb2d2, 0xdde8fb, 0x8595b8],
      /* EMISSIVE, AND IT IS REAL - `buildPropField` clones the shared rock
       * material for any field with a non-zero `glow` and sets its emissive,
       * so this is one extra material and still one draw call. It is a FIELD
       * property and not an instance one, because `MeshStandardMaterial`
       * multiplies the per-instance colour into the diffuse and never into the
       * emissive.
       *
       * 0.7 of a deep blue, which at this strength is not a glow: it is a
       * floor under the shadow side, so a spire in shadow is still crystal
       * rather than a black cut-out against a bright sky. That is the exact
       * defect Volcanic.js records against its own first sun placement. */
      glow: 0x1d3560, glowStrength: 0.7,
      collide: true,
    },
    /**
     * The Cross fault's spires - the second scale, and the one field with no
     * glow at all.
     *
     * Deliberately dark. Three glowing crystal fields would make the whole
     * planet self-lit and there would be nothing for the emissive ones to be
     * brighter THAN; these read as the same rock the plates are made of, which
     * is also true of most of the crystal on a real shattered world.
     */
    {
      id: 'spires_cross',
      kind: 'spires',
      region: { shape: 'corridor', pts: FAULT_CROSS, width: 28, widthInner: 8, slopeMaxDeg: 28, clearOfPads: 8 },
      count: 34, spacing: 22,
      size: { h: [11, 28], base: [1.1, 2.6], lean: 0.18, facets: 5 },
      tint: [0xa8b4c8, 0x8794ad, 0xc2cddf, 0x6f7c96],
      collide: true,
    },
    /**
     * THE CHOIR - the third scale, and the one the player has to walk INTO.
     *
     * 380 pinnacles at 4.5-17 m over a 128 m disc, which is one every 122
     * square metres, a mean spacing of 11.6 m and a floor of 7.0 m.
     *
     * 7.0 M IS THE WHOLE NUMBER AND IT IS CINDER'S LESSON PAID FORWARD. That
     * planet's colonnade ran 5.0 m spacing against a 2.3 m radius, left 2.0 m
     * lanes and the reach probe lost an entire ferro-basalt seam inside it: a
     * field a body cannot walk into is scenery with ore behind glass. Here the
     * collider is the spire's foot, so a 1.45 m maximum base gives a 1.10 m
     * half-extent and a 1.55 m half-diagonal. Measured over all 380 placed
     * instances, the worst pair on the plate leaves a 4.74 m lane. Spectrolite
     * is on the plate in the middle of this field, and the probe walks all
     * eleven nodes of it from the primary pad - 503 to 615 m, the longest walk
     * to any ore on the planet.
     *
     * `slopeMaxDeg: 22` is what keeps the Lectern's 31 degree rim BARE, so the
     * raised plate has a clean skirt and the spires stand on its top and on
     * the sheet around it but never on the climb between them.
     */
    {
      id: 'spires_choir',
      kind: 'spires',
      region: { shape: 'disc', x: -215, z: 140, r: 128, slopeMaxDeg: 22, clearOfPads: 6 },
      count: 380, spacing: 7.0,
      size: { h: [4.5, 17], base: [0.5, 1.45], lean: 0.20, facets: 5 },
      tint: [0xd6e2f6, 0xaebfdc, 0xeef4ff, 0x93a6c6],
      /* Half the strength of the landmarks. The Choir is meant to be a place
       * with an internal light in it, not a lamp. */
      glow: 0x14284a, glowStrength: 0.55,
      collide: true,
    },
    /**
     * THE FAILED SHEETS, along the Spine's talus.
     *
     * `slabs` is the other kind this planet was the reason for. A shattered
     * plate is a flat sheet and a flat sheet is a box - which is the "never
     * stack cuboids" rule read the other way round, and `PlanetProps` says so
     * where it builds them. What stops a field of them reading as a floor is
     * that every instance is tilted, yawed and a different thickness, and its
     * collider is a ROTATED step at its own footprint rather than an axis
     * aligned cube round a tilted sheet.
     *
     * The band is 38-62 m off the fault line, OUTSIDE both the spire seam
     * (9-30) and the beryl seam's inner edge. Three fields sharing one
     * corridor at three different radii is what makes the seam read as a
     * cross-section rather than as a heap.
     */
    {
      id: 'slabs_seam',
      kind: 'slabs',
      region: { shape: 'corridor', pts: FAULT_SPINE, width: 62, widthInner: 38, slopeMaxDeg: 26, clearOfPads: 8 },
      count: 110, spacing: 13,
      size: { w: [2.6, 7.5], d: [2.2, 6.0], t: [0.5, 1.5], tilt: 0.62 },
      tint: [0x4a5266, 0x3a4155, 0x5c6478, 0x2e3446],
      collide: true,
    },
    /**
     * THE SUNKEN PANE's rubble. The one place on the planet where a plate has
     * come apart rather than merely stepped, so this is the densest slab field
     * and the most steeply tilted (0.75 rad, i.e. up to 43 degrees off
     * horizontal).
     */
    {
      id: 'slabs_pane',
      kind: 'slabs',
      region: { shape: 'disc', x: 280, z: 285, r: 104, slopeMaxDeg: 24, clearOfPads: 6 },
      count: 90, spacing: 12,
      size: { w: [3.0, 9.0], d: [2.4, 7.0], t: [0.6, 1.7], tilt: 0.75 },
      tint: [0x3f4759, 0x323949, 0x515a6c, 0x272d3c],
      collide: true,
    },
    /**
     * Frost-shattered blocks, everywhere. 820 over the whole playfield is one
     * every 780 square metres - a mean spacing of 28 m, so `spacing: 8.5` is a
     * floor that almost never binds and the field never closes a route.
     */
    {
      id: 'frost_rubble',
      kind: 'boulders',
      region: { shape: 'field', slopeMaxDeg: 30, clearOfPads: 6 },
      count: 820, spacing: 8.5,
      size: { rMin: 0.5, rMax: 2.4 },
      tint: [0x40485c, 0x515a6e, 0x333a4c, 0x5f6878],
      collide: true,
    },
    /**
     * Splinters. Ankle-to-chest crystal shatter, non-colliding, scattered over
     * everything - the term that stops the plate tops being empty at eye level
     * without putting one more obstacle on them.
     *
     * A faint glow, and a low one. `shards` are the only family `PlanetProps`
     * does not cast shadows from, so at eye level these have no self-shading
     * at all; 0.8 of a cold blue emissive is what keeps them from reading as
     * flat paper triangles in the shadow of a plate.
     */
    {
      id: 'splinters',
      kind: 'shards',
      region: { shape: 'field', slopeMaxDeg: 34, clearOfPads: 5 },
      count: 460, spacing: 3.6,
      size: { hMin: 0.7, hMax: 3.2, wMin: 0.28, wMax: 1.15 },
      tint: [0x8fa6cc, 0xb8cbe8, 0x6e84aa, 0xa2b6d8],
      glow: 0x2a3a66, glowStrength: 0.8,
      collide: false,
    },
  ],

  /* ---------------------------------------------------------------- *
   * MINERALS - four elements, four plates, one ladder.
   *
   * "Go and mine rare elements" only resolves to CATHEDRA rather than to any
   * planet if the rare elements are Cathedra's, so every row names the landform
   * family it belongs to and the plate it is on, and the ladder runs with the
   * cost of standing there:
   *
   *   rarity     element      terrain   where it is, and the MEASURED walk to
   *                                     the nearest node of it, on foot
   *   ---------  -----------  --------  --------------------------------------
   *   common     quartzite    plain     the Pavement and the Sunken Pane, i.e.
   *                                     the two low plates. 42 m from the
   *                                     primary pad, median 226 m.
   *   uncommon   beryl        fissure   the Spine seam, 17-36 m off the fault
   *                                     line on BOTH sides of it - the lip and
   *                                     the foot, never the face. 132 m, and
   *                                     the seam runs across all three
   *                                     walkable regions: 11 nodes reachable
   *                                     from the Pavement, 6 from the Gallery,
   *                                     1 from the Lantern, 18 of 18 in total.
   *   rare       spectrolite  outcrop   the top of the Lectern, in the middle
   *                                     of the Choir's spire field. 503 m from
   *                                     the primary pad by way of the Cleft
   *                                     and then THROUGH the spires; median
   *                                     565 m, which is the longest median
   *                                     walk to any ore here.
   *   exotic     lucent       cave      the Vault floor. Measured 0 of 6 from
   *                                     the primary pad at any distance, and
   *                                     6 of 6 from the Lantern at 310-346 m
   *                                     down the road.
   *
   * The rare tier's nearest node is 12.0x the common tier's (503 m against
   * 42 m), against the 4x floor the mineral test holds Cinder to.
   *
   * The last row is the design in one line and it is the shape Volcanic.js
   * proved: the rarest thing costs a DECISION - which pad you set down on -
   * and not just time.
   *
   * `credits` is absent from every row on purpose: `definePlanet` computes it
   * from `unitValue * hold` and REFUSES a hand-written one. `size` is the node
   * radius AND the hold volume, so the cheap ore is the bulky ore - three cubic
   * metres of quartzite for 60 credits against one of lucent for 620. A stock
   * Kestrel holds ten cubic metres. That is the entire cargo decision, and a
   * planet whose nodes were all one size would have thrown it away.           */
  minerals: [
    {
      id: 'quartzite', item: 'quartzite', name: 'Quartzite Gravel',
      rarity: 'common', terrain: 'plain', place: 'the Pavement and the Sunken Pane',
      /* A dull warm grey, and both halves of that are legibility decisions.
       *
       * DULL, because the item row calls it "hard, dull and abundant" and
       * because Cinder shipped a cream tephra nodule that was the most
       * conspicuous object on the planet while being the cheapest thing on it.
       * WARM, because everything else here is on the blue axis: on a
       * blue-grey plate a warm grey is the one neutral that separates. */
      color: 0x8e8b83, glow: 0,
      unitValue: ORE('quartzite'), spread: 0.25,
      /* 1.60 m is the SMALLEST radius that still costs three cubic metres of
       * hold - `holdUnitsFor` rounds, so anything under 1.5625 drops to two
       * and the bulk-versus-value decision goes with it. */
      size: 1.60, count: 36, spacing: 24,
      /**
       * THE TWO LOW PLATES, AND NOT THE WHOLE MAP.
       *
       * `yMax: 44` admits the Pavement at 26 and the Sunken Pane at 12 and
       * excludes the Gallery at 50, the Choir at 58 and the Crown at 82. A
       * common ore that was on every plate would make three of the five plates
       * interchangeable, which is the opposite of what the faults are for.
       * `yMin: 4` keeps it out of the bottom of the map's rim falloff.
       *
       * The `rect` is doing one job those two cannot, and it was added after
       * measuring: the Vault floor is at y 16, which is inside the height
       * window, and the first version put three quartzite nodes down there
       * among the lucent. The commonest ore in the game's most expensive room
       * is not a bug the validator can see - it just quietly makes the second
       * landing worth less. The rectangle is the east half south of the Cross,
       * i.e. exactly the two plates this ore belongs to, and it excludes the
       * Vault by being 180 m away from it.
       */
      region: { shape: 'rect', x0: -60, z0: -60, x1: 400, z1: 400, yMin: 4, yMax: 44, slopeMaxDeg: 20, clearOfPads: 6 },
    },
    {
      id: 'beryl', item: 'beryl', name: 'Beryl Prisms',
      rarity: 'uncommon', terrain: 'fissure', place: 'the Spine Seam',
      /* Pale green. The one hue on this planet that is neither blue, violet
       * nor grey, so a beryl seam is identifiable at range without a glow
       * doing the work - which matters because there are two glowing ores
       * above it and a third would flatten the value gradient. */
      color: 0x4fc4a6, glow: 0x07271f,
      unitValue: ORE('beryl'), spread: 0.25,
      size: 1.05, count: 18, spacing: 20,
      /**
       * THE SAME POLYLINE THE FAULT IS BUILT FROM, so the ore and the landform
       * cannot drift apart - the arrangement Volcanic.js uses for its vent
       * field and the sulfur that grows on it.
       *
       * `widthInner: 17` is the fault FACE, excluded, and it is the fix Cinder
       * paid for: sulfur was authored down a corridor that included the floor
       * of a 13 m trench with near-vertical walls, and the reach probe found a
       * whole seam nothing could stand on. Here the face occupies 0-13 m on
       * the falling side, so 17 clears it with four metres of margin against
       * the noise, and what is left is the LIP on one side and the FOOT on the
       * other. Beryl grows in a seam, not on a cliff - the fix and the geology
       * are the same fix again.
       *
       * `slopeMaxDeg: 24` is the belt to that braces: anything the noise has
       * tilted past a walkable angle inside the band is rejected outright.
       */
      region: { shape: 'corridor', pts: FAULT_SPINE, width: 36, widthInner: 17, slopeMaxDeg: 24, clearOfPads: 5 },
    },
    {
      id: 'spectrolite', item: 'spectrolite', name: 'Spectrolite',
      rarity: 'rare', terrain: 'outcrop', place: 'the Lectern',
      /* A DARK stone with a BRIGHT flash, which is what labradorescence
       * actually is - "grey stone from any other angle", says the item row.
       * The diffuse is nearly the darkest thing on the planet and the emissive
       * is the brightest hue on it; `PlanetWorld` drives any ore that declares
       * a glow at emissiveIntensity 2.2, so at ten metres this reads as a
       * cyan flare on a black lump and cannot be confused with lucent's white
       * or beryl's green. That distinction is the one Cinder had to fix twice:
       * its rare rheniite and its common tephra were the same cream boulder. */
      color: 0x24346b, glow: 0x63dcff,
      unitValue: ORE('spectrolite'), spread: 0.25,
      size: 0.72, count: 11, spacing: 16,
      /* The Lectern's top, inside its 54 m table. `slopeMaxDeg: 18` keeps every
       * node off the 31 degree rim, so the climb is a climb and the seam is on
       * a floor. */
      region: { shape: 'disc', x: -250, z: 96, r: 46, slopeMaxDeg: 18, clearOfPads: 4 },
    },
    {
      id: 'lucent', item: 'lucent', name: 'Lucent',
      rarity: 'exotic', terrain: 'cave', place: 'the Vault',
      /* Near-white with a cold glow, in the only place on the planet where the
       * ground itself is violet-black. The item row says it holds light and is
       * still glowing an hour later; this is that sentence at 620 credits a
       * cubic metre. It is also the smallest node on the planet, so a stock
       * Kestrel can carry all six - which is the trip this ore exists to make
       * worth flying 288 km for. */
      color: 0xeaf4ff, glow: 0xbfe4ff,
      unitValue: ORE('lucent'), spread: 0.25,
      size: 0.60, count: 6, spacing: 9,
      /* An annulus on the Vault floor: `rInner: 15` keeps the nodes off the
       * road's toe and out of the middle of the landing approach, and `r: 29`
       * keeps every one of them inside the 31 m flat, well clear of the wall.
       * The rarest tier may use neither `terrain: 'plain'` nor a `field`
       * region, and this is a long way from either. */
      region: { shape: 'disc', x: VX, z: VZ, r: 29, rInner: 15, slopeMaxDeg: 16, clearOfPads: 3 },
    },
  ],

  /* ---------------------------------------------------------------- *
   * Three sites, and the answer to "is a pad a plate top or something cut" is
   * different for the third one:
   *
   *   THE PAVEMENT and THE GALLERY are plate tops that happen to be level. A
   *   `plateau` already made each of them a flat sheet at the block's own
   *   height, and the pad under each only takes the last few centimetres of
   *   grain out of the landing disc. Nothing was excavated; the planet simply
   *   has flat places on it, which is what a shattered crust is made of.
   *   Measured span across each disc: 0.00 m and 0.00 m.
   *
   *   THE LANTERN is CUT, and it is the only cut landing on the planet. Its
   *   disc is notched clean through the Vault's collapsed rim, which is why
   *   the rim ridge is authored before the LEVEL layer runs - the pad is a
   *   shelf blasted through a collapse, and it looks like one. Measured span:
   *   0.01 m, the one centimetre being where the rim's own crest passes under
   *   the pad's blend.
   *
   * Between them the three floods cover 100.0% of the standable ground on the
   * planet with no overlap: 61.9% from the Pavement, 20.5% from the Gallery,
   * 17.6% from the Lantern. Three plates, three sealed walkable regions, three
   * pads - so "which pad" is the only navigation decision on Cathedra, and it
   * is the whole one.                                                        */
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
   * 6.6 m/s2, apex 1.062 m, a 6.2 m sprint jump - the lightest of the seven
   * heavy worlds and still nowhere near a traversal rule. All three are walks
   * up plate edges, which is the only landform this world has.
   *
   * They are also the three THINNEST places to stand on the planet. Cathedra's
   * air is a stated fact of this descriptor rather than a new one - the fog
   * runs clear to the horizon, the sky is `alpine`, and the diamond dust below
   * only forms in air this cold and this dry - and `PlanetWorld` now drives a
   * cold-air stamina drain off the height these three stand at. The highest
   * ground is the hardest to breathe on, which is exactly where the views are.
   * @see ../PlanetWorld.js `_buildHazardField` */
  viewpoints: [
    {
      /* The south rim of the Lectern - the ring wall round the deepest basin on
       * the planet, 87.5 m with a 66 m sink inside it. */
      id: 'lectern_rim', name: 'Lectern Rim', x: -225, z: -349, r: 8,
      terrain: 'outcrop', place: 'the Lectern',
      climb: 'Anticlockwise round the outside of the Lectern from The Lantern.',
    },
    {
      /* The high side of the Spine Seam where the fault face is 32 m over 13 m
       * of run - 68 degrees, and this is the top of it. 84 m. */
      id: 'spine_head', name: 'Spine Head', x: -20, z: -80, r: 7,
      terrain: 'fissure', place: 'the Spine Seam',
      climb: 'East from The Lantern onto the upthrown block; the seam is the edge.',
    },
    {
      /* The far east end of the cross seam, 52.3 m, out past The Gallery where
       * the plate field runs to the horizon. */
      id: 'gallery_east', name: 'Gallery Easting', x: 350, z: -70, r: 8,
      terrain: 'shelf', place: 'the cross seam east of The Gallery',
      climb: 'East off The Gallery along the upthrown side of the cross seam.',
    },
  ],

  landing: [
    {
      /* Facing WNW: out across the Pavement at the Spine's landmark spires,
       * with the Choir standing 32 m above them beyond. yaw 0 looks down -Z. */
      id: 'pavement', name: 'The Pavement', x: 150, z: 80, r: 30, primary: true, yaw: 1.22,
    },
    {
      /* Facing SW, down the Cross fault's dark face and along the Spine. */
      id: 'gallery', name: 'The Gallery', x: 215, z: -240, r: 24, yaw: 2.33,
    },
    {
      /* Facing the mouth, i.e. straight down the road. */
      id: 'lantern', name: 'The Lantern', x: LANTERN[0], z: LANTERN[1], r: 20, yaw: 0.87,
    },
  ],


  hazards: {
    /**
     * Diamond dust: ice crystal fall out of a clear sky, which is a real thing
     * in air this thin and this cold and is the cheapest possible way to put
     * something in the near field that CATCHES the sun.
     *
     * 0.16 against Cinder's 0.35. Ash falls to obscure; this falls to sparkle,
     * and at Cinder's density it would be weather, which would undo the
     * horizon the fog numbers above were chosen to keep.
     */
    ashfall: { density: 0.16, drift: [0.28, -0.10] },
    ashColor: 0xdbe8ff,
  },
});

export default CATHEDRA;
