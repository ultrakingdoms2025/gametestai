/**
 * LODESTAR YARD - THE SHELL, AS NUMBERS, DERIVED FROM THE INTERIOR.
 *
 * ===========================================================================
 *  THE DEFECT THIS FILE EXISTS TO KILL
 * ===========================================================================
 *
 * `DockExterior.js` used to carry its own idea of the hangar:
 *
 *      MOUTH_Z = -18   MOUTH_W = 70   MOUTH_H = 30
 *      hangar slab 150 wide, 80 tall, 60 DEEP
 *
 * and `dock/YardPlan.js` - the plan the world the player actually walks in is
 * built from - says the mouth is
 *
 *      MOUTH_Z = -104  MOUTH_HW = 82 (so 164 WIDE)  MOUTH_Y1 = 23.6
 *      floor -104..+58, so the shed is 162 DEEP, roof at 26
 *
 * Every number disagreed. A player walked out of a 164 m aperture and then
 * flew back to look at a 70 m one; a 162 m hall was drawn inside a 60 m box.
 * Not "looks a bit off" - a hall that does not fit inside its own building.
 *
 * There is no reason for two tables. The two worlds are joined at exactly one
 * place, `DOCK_ANCHOR.mouth` in `space/Bodies.js`, which fixes WHERE the mouth
 * plane is in the space frame. Everything else about the building - how wide
 * the hole is, how tall, how deep the shed behind it goes, where its roof
 * stops - is the interior's business and is read from the interior.
 *
 * ===========================================================================
 *  THE TWO FRAMES, AND THE ONE NUMBER THAT JOINS THEM
 * ===========================================================================
 *
 * The yard interior and the space volume are separate scenes with separate
 * origins. The interior's datum is the surveyors' brass plate on the assembly
 * floor; the space frame's origin is the yard as a body in the volume. The
 * mouth is the same physical hole in both, so:
 *
 *      zSpace = zYard + Z_OFFSET,     Z_OFFSET = DOCK_ANCHOR.mouth.z - MOUTH_Z
 *
 * X and Y are shared outright: the keel line is x 0 in both, and the assembly
 * floor is y 0 in both, which is why a player can step through the portal at
 * the same eye height they left at.
 *
 * `Z_OFFSET` comes out at +86, and it is derived rather than typed so that
 * moving `DOCK_ANCHOR.mouth` moves the building and nothing has to be edited.
 *
 * ===========================================================================
 *  WHAT AGREEMENT ACTUALLY REQUIRES
 * ===========================================================================
 *
 * Four claims, and each one is a thing a player can catch you out on:
 *
 *  1. THE HOLE IS THE SAME HOLE. 164 x 23.6, sill on the deck. Fly at it and
 *     the clearance you measured from the apron is the clearance you get.
 *  2. THE BUILDING CONTAINS THE ROOM. 172 m of floor and 162 m of depth and
 *     26 m of headroom have to fit inside the shell, or the exterior is a
 *     smaller box than its own interior.
 *  3. THE ROOF STOPS WHERE THE ROOF STOPS. `ROOF_CUT_Z` is -34 inside: the
 *     last 70 m before the mouth has portal frames and starfield and no lid.
 *     From outside that has to be an OPEN WELL, or the interior's promise that
 *     you can see the stars through the roof is a lie told by the exterior.
 *  4. NOTHING IS PARKED IN THE DOORWAY. A ship flies through this. The
 *     aperture prism has to be empty all the way through the wall.
 *
 * All four are asserted in `scripts/tests/space-yard-exterior.test.mjs`, three
 * of them against geometry that has actually been built rather than against
 * the constants below.
 *
 * Zero imports of `three`. This is arithmetic, so the test can read it without
 * a GPU, exactly as `YardPlan.js` is arithmetic for the same reason.
 */

import {
  YARD_X, YARD_Z1, DECK_Y as YARD_DECK_Y, ROOF_Y, ROOF_CUT_Z,
  MOUTH_Z as YARD_MOUTH_Z, MOUTH_HW, MOUTH_Y1, GANTRY_Y, CRANE_Y,
} from '../dock/YardPlan.js';
import { DOCK_ANCHOR } from './Bodies.js';

/* ------------------------------------------------------------------ */
/* The join                                                            */
/* ------------------------------------------------------------------ */

/** Add to a yard-frame Z to get a space-frame Z. Derived; do not type it. */
export const Z_OFFSET = DOCK_ANCHOR.mouth[2] - YARD_MOUTH_Z;

/** Yard Z -> space Z. */
export const toSpaceZ = (zYard) => zYard + Z_OFFSET;

/* ------------------------------------------------------------------ */
/* Levels - shared outright with the interior                          */
/* ------------------------------------------------------------------ */

/** The assembly floor, and the sill of the mouth. Zero in both frames. */
export const DECK_Y = YARD_DECK_Y;
/** Perimeter catwalk height, drawn inside the mouth so the hall has a storey. */
export const HALL_GANTRY_Y = GANTRY_Y;
/** Crane runway. The bridge is drawn in the open well at this height. */
export const HALL_CRANE_Y = CRANE_Y;
/** Underside of the roof truss. */
export const HALL_ROOF_Y = ROOF_Y;

/* ------------------------------------------------------------------ */
/* The hall                                                            */
/* ------------------------------------------------------------------ */

/** Inner face of the side walls: the interior's own floor half-width. */
export const HALL_INNER_HW = YARD_X;
/**
 * Wall thickness. Four metres, which is not a taste decision: `MOUTH_HW` is
 * `YARD_X - 4` precisely so the corner returns carry the perimeter catwalk
 * round the north end, so the jamb either side of the mouth is 4 m of
 * structure and the outer skin has to be at least that far out to contain it.
 */
export const HALL_WALL_T = 4;
/** Outer face of the side walls. */
export const HALL_OUTER_HW = HALL_INNER_HW + HALL_WALL_T;

/** Roof plate thickness above the truss soffit. */
export const HALL_ROOF_T = 3;
/** Top of the roofed section's outer skin. */
export const HALL_TOP_Y = HALL_ROOF_Y + HALL_ROOF_T;

/**
 * Structural depth under the assembly floor.
 *
 * Not read from the interior, because the interior has no reason to know: the
 * deepest thing it publishes is the service trench at -2.2. A 172 x 162 m
 * floor with nothing under it is the "floating plank" the piers were already
 * criticised for, at eighty times the area. Fourteen metres of keel is what
 * gives the shed a soffit and a bottom edge you can see from below.
 */
export const HALL_KEEL_D = 14;
/** Half-width of the keel box. Inset, so the hall reads as overhanging it. */
export const HALL_KEEL_HW = HALL_OUTER_HW - 16;

/** The mouth plane. Both worlds' front wall. */
export const HALL_FRONT_Z = toSpaceZ(YARD_MOUTH_Z);
/** The apron wall at the far end of the hall. */
export const HALL_BACK_Z = toSpaceZ(YARD_Z1);
/** Where the roof plate stops and the open launch well begins. */
export const WELL_BACK_Z = toSpaceZ(ROOF_CUT_Z);

/** Interior depth, for the record and for the test. */
export const HALL_DEPTH = HALL_BACK_Z - HALL_FRONT_Z;
/** Depth of the open, unroofed launch well. */
export const WELL_DEPTH = WELL_BACK_Z - HALL_FRONT_Z;

/* ------------------------------------------------------------------ */
/* The aperture                                                        */
/* ------------------------------------------------------------------ */

/** Half-width of the hole. 82, so the hole is 164 across. */
export const MOUTH_HALF_W = MOUTH_HW;
/** Sill. The deck runs out through the hole; there is no step. */
export const MOUTH_SILL_Y = DECK_Y;
/** Head. 23.6 - the lintel under the roof plate. */
export const MOUTH_HEAD_Y = MOUTH_Y1;
/** Centre of the aperture, which is what a pilot lines up on. */
export const MOUTH_CENTRE = Object.freeze([
  DOCK_ANCHOR.mouth[0],
  (MOUTH_SILL_Y + MOUTH_HEAD_Y) / 2,
  HALL_FRONT_Z,
]);

/**
 * The BAY PITCH, and why the exterior has to know it.
 *
 * The interior is framed on 12 m bays and `ROOF_CUT_Z` is a frame line rather
 * than a number chosen for composition - "a roof that ended between two
 * rafters would be a plate with nothing holding its edge up". So the portal
 * frames the exterior draws over the open well are not decoration spaced by
 * eye: they are the SAME frames, at the same chainages, and they march
 * forward from the roof edge on the same pitch.
 */
export const BAY_PITCH = 12;

/**
 * Frame chainages over the open well, in the space frame, back to front.
 *
 * Starts at the roof edge (which is a frame line) and steps forward on the bay
 * pitch until it would foul the mouth lintel. The lintel itself is the last
 * frame and is built by the mouth, not by this list.
 */
export const WELL_FRAME_Z = Object.freeze((() => {
  const out = [];
  for (let z = WELL_BACK_Z; z > HALL_FRONT_Z + BAY_PITCH * 0.5; z -= BAY_PITCH) out.push(z);
  return out;
})());

/* ------------------------------------------------------------------ */
/* The containing sphere                                               */
/* ------------------------------------------------------------------ */

/**
 * Everything drawn has to fit inside this, and it is not a soft target.
 *
 * `Scale.js`'s far-limb cap places the yard's proxy at `FAR_SAFE / (1 + R/D)`
 * using `DOCK_ANCHOR.radius` as R. A structure that sticks out past R has its
 * far side outside the guarantee, and what a player sees is the back of the
 * station sliced off in a straight line by the far plane - the exact artefact
 * the ringed-planet note in Backdrop.js describes. `Bodies.js` is another
 * agent's file and this one cannot widen the sphere, so this one stays inside
 * it, and the build asserts it vertex by vertex rather than trusting a comment.
 */
export const BOUND_R = DOCK_ANCHOR.radius;

/**
 * The agreement, as a plain object, so a test can print it rather than
 * re-derive it. Every field is a claim the exterior makes about the interior.
 */
export function shellAgreement() {
  return {
    zOffset: Z_OFFSET,
    mouth: {
      width: MOUTH_HALF_W * 2,
      sillY: MOUTH_SILL_Y,
      headY: MOUTH_HEAD_Y,
      planeZ: HALL_FRONT_Z,
      centre: [...MOUTH_CENTRE],
    },
    hall: {
      innerWidth: HALL_INNER_HW * 2,
      outerWidth: HALL_OUTER_HW * 2,
      depth: HALL_DEPTH,
      roofY: HALL_ROOF_Y,
      frontZ: HALL_FRONT_Z,
      backZ: HALL_BACK_Z,
      keelDepth: HALL_KEEL_D,
    },
    well: { depth: WELL_DEPTH, backZ: WELL_BACK_Z, frames: WELL_FRAME_Z.length },
    boundR: BOUND_R,
  };
}
