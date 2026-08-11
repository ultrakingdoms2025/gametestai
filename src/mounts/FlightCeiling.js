import { DOME_R, domeHeightAt } from '../worlds/station/StationKit.js';

/**
 * How high a flying mount may climb, world by world.
 *
 * ── What was wrong ────────────────────────────────────────────────────────
 * The station is a sealed building: a 720 m glazed drum with a shallow domed
 * roof over it, 170 m at the apex and only 70 m where the cap springs off the
 * perimeter wall. Three things claimed to keep a mount inside it and none of
 * them did the job over most of the floor area:
 *
 *   `MountManager._holdInBounds`  clamped Y at `world.bounds.max.y`, which the
 *                                 station sets to 164 - the apex less its
 *                                 clearance. FLAT. Correct on the world axis
 *                                 and up to 94 m too generous at the rim.
 *   `Dragon`                      clamps at `groundY + 260`, world-agnostic.
 *   `Eagle`                       clamps at an absolute 240, which is ABOVE
 *                                 the apex, and never calls the capsule
 *                                 solver at all.
 *
 * `OuterRing` does collide the roof in ten concentric bands, so a dragon at
 * least meets something - but a mount's collision response deliberately
 * discards downward corrections (they are read as "the solver is squeezing me
 * out of a ceiling" and would fight the hover spring), so the band pushes the
 * dragon sideways rather than down, and the eagle passes through it entirely.
 * The net effect: from about r = 500 m outward you could fly up through the
 * glass and end up over the outside of a sealed station.
 *
 * ── Why the shape lives here and not in a `rules` flag ────────────────────
 * `WorldRules` is how per-world CAPABILITY differences are expressed, and this
 * is not one: nothing here is permitted in one world and forbidden in another.
 * Every world lets you fly. What differs is the SHAPE of the roof, and a
 * boolean cannot carry a curve - a `domeCeiling: true` flag would still need a
 * second, station-specific lookup right next to it to find out which curve, so
 * the flag would be a restatement of the world lookup it gated rather than an
 * addition to it. One table keyed by world id says the whole thing once.
 *
 * The genuinely better home for this is a `flightCeilingAt` method on the
 * world itself, next to `bounds` - each world would answer for its own roof
 * and this table would not exist. That is a change to the world classes, and
 * is worth making when they are next open.
 *
 * Everything below is plain arithmetic on exported constants - no THREE, no
 * DOM, no world instance - so it is checked headlessly by
 * scripts/tests/flight-ceiling.test.mjs.
 */

/** The only world with a roof over it. */
export const STATION_WORLD_ID = 'station';

/**
 * Clearance kept under the glass.
 *
 * Not a new number: `StationWorld` already sets `bounds.max.y` to
 * `DOME_APEX - 6` and says why - "a ceiling above the roof is not a ceiling: a
 * dragon would climb to it straight through the glazing". Six metres under the
 * cap everywhere generalises that one point to the whole surface, and is a
 * comfortable margin for a mount whose body is a couple of metres deep and
 * which is resolved once per fixed step rather than swept.
 */
export const DOME_CLEARANCE = 6;

/**
 * The station's ceiling above a point, following the dome rather than cutting
 * across it.
 *
 * `domeHeightAt` is the same oracle `OuterRing` builds the roof mesh and the
 * roof collision bands from, so this agrees with the visible glass by
 * construction and cannot drift from it.
 *
 * ── Why r is capped at the dome radius ────────────────────────────────────
 * `domeHeightAt` keeps following its sphere outside the dome, and the sphere
 * comes back down: the station's bounds box is +/-744 on each axis, so a corner
 * of it is 1052 m from the axis, where the unclamped cap height is about -45.
 * Fed to a ceiling clamp that would push a mount underground. Past the
 * perimeter wall the roof simply is not overhead any more, and holding the
 * springing height is the answer that keeps a mount that has somehow got out
 * there below the glazing rather than above it.
 *
 * ── Why the hub's own ceiling is not in here ──────────────────────────────
 * The hub has an overhead plate at 62 m with a 34 m oculus punched through it
 * over the plaza. It is NOT treated as a flight ceiling, on purpose:
 *
 *   - It is interior architecture, not the shell. Flying through it does not
 *     let you leave the station; flying through the dome does, and that is the
 *     defect being fixed.
 *   - The oculus exists so that the plaza can see up into the dome. Rising
 *     through it into the cap is the best thing you can do on a dragon in this
 *     world, and a clamp that stopped you at 62 m across the whole 200 m hub
 *     disc would take that away to fix a problem nobody has.
 *   - Whether the plate itself is solid is a collision-coverage question, and
 *     the station audit's C3 is the instrument for it. A soft altitude rule
 *     that shadowed a piece of architecture would disagree with the collider
 *     somewhere - at the oculus lip, for one - and the disagreement would be
 *     invisible.
 *
 * So: one rule, one surface. Under the plate you are held up by whatever holds
 * a plate up; above it, and anywhere else in the world, by the dome.
 *
 * @param {number} x  world X
 * @param {number} z  world Z
 * @returns {number}  world Y a mount may not climb past
 */
export function stationFlightCeiling(x, z) {
  const r = Math.min(Math.hypot(x, z), DOME_R);
  return domeHeightAt(r) - DOME_CLEARANCE;
}

/**
 * The flight ceiling for a world, or `null` where the sky is open.
 *
 * `null` rather than `Infinity` so a caller that forgets to handle it fails
 * loudly instead of silently clamping a mount to nowhere, and so the five
 * roofless worlds cost one identity comparison and no arithmetic.
 *
 * @param {{id?: string}|null|undefined} world
 * @param {number} x
 * @param {number} z
 * @returns {number|null}
 */
export function flightCeilingAt(world, x, z) {
  if (world?.id !== STATION_WORLD_ID) return null;
  return stationFlightCeiling(x, z);
}
