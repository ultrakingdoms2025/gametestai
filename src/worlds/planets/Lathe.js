/**
 * LATHE - the ring shepherd, and the best view in the game.
 *
 * Ceraunus is the biggest thing in the sky and it has no surface. A player who
 * flew the two hundred and forty-five kilometres out to it in Phase 1 arrived
 * at a wall. This is what is actually out there: a 5.2 km moon riding 21.7 km
 * outside the outer ring edge, airless, a fifth of a g, and carrying `aurichalc`
 * at 700 cr/m3 - the dearest cubic metre in the system.
 *
 * The payoff of the whole trip is overhead. Everything below serves it.
 *
 * ==========================================================================
 *  THE MAP, in words
 * ==========================================================================
 *
 * 640 m square, `+x` east and `+z` south. The regolith plain is y = 24, and
 * every height below is quoted against it.
 *
 *   THE SHEPHERD        the great crater, centred (-108, 26). 256 m across, with
 *                       a rim crest at y 71 and a floor levelled dead flat at
 *                       y -22 - 93 m of relief, the whole authored budget of the
 *                       map in one landform. MEASURED: the outer flank tops out
 *                       at 66.6 deg and the inner wall at 82.8, so the floor
 *                       cannot be walked into from ANY bearing. That is what
 *                       makes the aurichalc on it a second landing rather than a
 *                       longer walk, and the reach probe says so in one line -
 *                       864 of 864 floor points from the Notch, 0 of 864 from
 *                       either other pad. See THE WALL below for why 66.6 and
 *                       not the 58 the first draft had. A broad 7 m ejecta apron runs 140 m
 *                       further out, so the crater sits in its own blanket
 *                       instead of on a plain.
 *
 *   THE WINDING         the only way down. A `ramp` leaving the Shepherd Notch
 *                       pad, 251 degrees round the inner wall, 444 m from y 49
 *                       to the floor's own level, measured at 9.1 deg over most
 *                       of its length with a 29.0 deg worst step; the walk to
 *                       the nearest aurichalc node is 445 m. Cinder's
 *                       comment is the reason it exists and it is quoted here
 *                       without apology: "a caldera you can see the floor of and
 *                       cannot get to is the exact defect this project keeps
 *                       shipping."
 *
 *   OLDWALL             the rim of a far older, far shallower basin, centred
 *                       (-186, -46) at radius 186. A 16 m crest arc across the
 *                       north and west of the map - and the Shepherd has punched
 *                       clean through 83 degrees of it, which is what makes the
 *                       two craters read as different ages rather than as two
 *                       circles. `sider` weathers out of the crest.
 *
 *   NEWFALL             the young ray crater, centred (60, -140). 124 m across
 *                       and 16 m deep to a floor at y 8, sharp-lipped, with six
 *                       ejecta rays running 200 m out over the plain and a
 *                       bright debris apron. `tychite` is on its floor, 10 of 10
 *                       nodes walkable from the primary pad at 163-230 m. The
 *                       inner wall measures 69 deg at its worst, so the way in
 *                       is THE SLUMP - a breached sector on the bearing of the
 *                       primary pad, cut as a 102 m ramp at 9 deg.
 *
 *   THE SWEEP           the leading face. Ring ice the moon shepherds and then
 *                       sweeps up, piled into transverse drifts 2.8 m tall every
 *                       30 m, centred (150, 165) over a 158 m field. The drift
 *                       bearing is not a taste decision: it is COMPUTED from the
 *                       orbit (see `DRIFT_ANGLE`) and comes out along the
 *                       east-west axis, so the crests run north-south and you
 *                       look ALONG them at Ceraunus. `rimefall` lies in the
 *                       troughs, 34 of 34 nodes walkable from the primary pad
 *                       at 86-250 m.
 *
 *   DRIFTHEAD           the primary pad, (180, -22), on open regolith just north
 *                       of the drifts. Spawn faces due south, which is where
 *                       Ceraunus is.
 *
 *   HIGHWALL            the third pad, (-108, -215), on the Oldwall crest and
 *                       placed by arithmetic rather than by eye: it is the point
 *                       on that crest from which the Shepherd lies DUE SOUTH,
 *                       so a player standing on it has the crater rim across the
 *                       bottom of the frame and the gas giant filling the top.
 *
 *   THE POCK            eleven small craters, several cutting each other, at
 *                       0.18r depth / 0.075r rim / 0.6r apron - the proportion
 *                       that keeps any of them walkable at any size. Crater
 *                       country is overlapping rims of different ages; without
 *                       them the map is three big holes in a flat.
 *
 * ==========================================================================
 *  WHY THE NUMBERS ARE THESE NUMBERS
 * ==========================================================================
 *
 * RELIEF BUDGET. Authored relief runs from the Shepherd's floor at y -22 to its
 * crest at y +65: 87 m. The noise below (swell 3.4 + ripple 1.1 + grain 0.34)
 * totals 4.84 m, which is 5.6% of it. That is lower than Cinder's 7% on purpose
 * - an airless body has no wind and no water, so between impacts it is SMOOTH
 * at every scale but the footfall one, and the grain octave is impact gardening
 * rather than weather. Measured over a 251,001-sample grid the whole map runs
 * y -27.97 to y +88.33 - 116 m of range, and every sample finite.
 *
 * SLOPES ARE THE DESIGN. Every wall in this file was solved against the reach
 * probe's own limit (38 deg over a 2 m lattice, no jump, no mantle) before it
 * was written down, because on a crater world the slope IS the level design:
 *
 *   the Shepherd's outer flank   66.6     blocks the walk to the Notch
 *   the Shepherd's inner wall    82.8     blocks the walk to the floor
 *   Newfall's inner wall           69     makes the Slump the way in
 *   the Oldwall crest            29.5     walk on and over it freely
 *   a Pock crater, any size      34.7     texture, never a trap
 *   the drift slip face          24.6     the drifts are ground, not fences
 *                              (38.4)     worst single cell, base noise included
 *   the playfield rim drop       29.6     the edge falls away and you can climb
 *                                          back out of it
 *
 * All but one of those is a measurement off the BUILT field rather than a
 * derivation, and the drift row is why the distinction is written down: the
 * wave's own slip face solves to 24.6 deg, and one cell in the field measures
 * 38.4 once the ripple and grain octaves are lying on top of it. The reach probe
 * walks it anyway - 34 of 34 rimefall nodes - which is the only proof that
 * counts.
 *
 * ==========================================================================
 *  THE WALL, AND THE NUMBER THE REACH PROBE DOES NOT USE
 * ==========================================================================
 *
 * The whole design of this planet rests on one claim - that the Shepherd's floor
 * cannot be walked into, so the aurichalc on it is a second LANDING - and that
 * claim was very nearly false in a way no test in this repository would have
 * caught.
 *
 * `planet-minerals.test.mjs` and `planet-reach.test.mjs` flood at 38 degrees.
 * The SOLVER does not: `Grounding.WALKABLE_NORMAL_Y` is 0.55, which is 56.6
 * degrees, and that is the slope a capsule will actually stand on. The probe's
 * 38 is a conservative convention, not the engine's limit, and a wall that only
 * clears 38 is not a wall.
 *
 * The first draft's rim was 34 m over a 30 m apron - 1.70 of gradient, 59.5
 * degrees at its steepest point and 58 as the field measured it. It passed the
 * 38-degree probe with everything gated correctly, and it FAILED the real one:
 * re-flooded at 56.6, all six aurichalc nodes came out reachable from Drifthead,
 * 839 walking metres away. The exotic tier was a long march after all.
 *
 * So the rim is 40 m over 26 - 2.31 of gradient, 66.6 degrees - and the gate now
 * holds at all three standards it can be asked about:
 *
 *   flood                                     drifthead  notch  highwall
 *   ----------------------------------------  ---------  -----  --------
 *   38 deg, no jump (the repo's convention)       0/6      6/6     0/6
 *   56.6 deg, no jump (the solver's own limit)    0/6      6/6     0/6
 *   56.6 deg AND a 1.61 m jump (Lathe's own)      0/6      6/6     0/6
 *
 * The third row matters because per-world player gravity landed while this file
 * was being written: at 1.90 m/s2 the jump apex is 1.61 m against 0.93 at the
 * reference, and a gate solved against a 0.93 m jump is not the same gate. It
 * makes no difference here, because 66.6 degrees is not a step you jump onto,
 * it is a face you cannot stand on.
 *
 * THE ONE PLACE TWO SLOPES FIGHT. The Oldwall crest ring crosses the Shepherd's
 * outer flank in two ~22 deg arcs, and where the two gradients oppose they
 * subtract. 2.31 less the Oldwall's 0.37 and the noise's 0.17 still leaves 1.77,
 * which is 3.5 m of rise per 2 m step against a 3.0 m ceiling even at the
 * solver's own limit. The broad shallow ejecta blanket the crater also wants is
 * a SECOND `crater` record at the same centre with `depth: 0`, so the blanket
 * and the wall are separate numbers and the wall cannot be softened by widening
 * the blanket.
 */

import { definePlanet } from './PlanetDescriptor.js';
import { ITEMS } from '../../systems/ItemDefs.js';
import { BODY_BY_ID } from '../space/Bodies.js';

/**
 * Credits per cubic metre of hold, read off the item catalogue.
 *
 * The price belongs to the ELEMENT and not to the rock it was lying in, so it
 * lives in `ITEMS` once and this file quotes it. Throwing on a missing row
 * rather than returning `undefined` is the difference between a loud boot
 * failure and a planet whose deposits are all worth NaN.
 *
 * @param {string} id an `ITEMS` id
 * @returns {number} credits per cubic metre
 */
const ORE = (id) => {
  const def = ITEMS[id];
  if (!def) throw new Error(`[Lathe] mineral names item "${id}", which has no ITEMS row`);
  return def.value;
};

/* ================================================================== */
/* THE SKY, COMPUTED                                                   */
/* ================================================================== */

/**
 * Nothing in this block is typed in. Every number in the `sky` record below is
 * derived from `BODY_BY_ID` at module load, so the day Ceraunus moves, its moon
 * moves with it (`Bodies.js` already computes Lathe's position from Ceraunus
 * for exactly this reason) AND its image in this world's sky moves too. Two
 * copies of one fact is how the second copy goes stale.
 *
 * `Bodies.js` imports no `three` and is plain data, so importing it here is
 * safe: what leaves this block is six plain finite numbers and three unit
 * vectors, all of which survive `postMessage` and none of which is a closure.
 */

const D2R = Math.PI / 180;
const _sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const _add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const _mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const _dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const _cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const _unit = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]);
  if (!(l > 1e-9)) throw new Error('[Lathe] a body direction came out degenerate');
  return [v[0] / l, v[1] / l, v[2] / l];
};
/** Round to five places so the record holds numbers, not float exhaust. */
const _fix = (v) => v.map((n) => +n.toFixed(5));

const _LATHE = BODY_BY_ID.lathe;
const _CERAUNUS = BODY_BY_ID.ceraunus;
const _ERENMARK = BODY_BY_ID.erenmark;
const _CATHEDRA = BODY_BY_ID.cathedra;

/**
 * THE ONE AUTHORED NUMBER IN THIS BLOCK: where on Lathe the playfield sits.
 *
 * Measured as an angle from the sub-Ceraunus point toward Lathe's own north
 * pole, which fixes the local zenith and therefore fixes everything else. 46
 * degrees puts Ceraunus at 41.95 deg of elevation, due south, its disc spanning
 * 20.7 to 63.2 degrees of the southern sky.
 *
 * It is a compromise and worth naming as one. At 0 the moon is at the
 * sub-Ceraunus point, the gas giant is exactly at zenith, and a player has to
 * lie on their back to see the thing they flew 185 km for. At 46 the disc's
 * lower half is in frame at a standing pitch of zero and a small look-up frames
 * all of it - and the key light, which is Ceraunus (see below), comes in at 42
 * degrees, which throws a shadow 1.1x the height of what casts it. That is the
 * elevation at which relief reads.
 */
const SITE_COLAT = 46 * D2R;

/** Lathe's spin axis, normalised. Local NORTH is defined off it. */
const _SPIN = _unit(_LATHE.axis);
/** Lathe centre -> Ceraunus centre, in the space frame. */
const _TO_CER = _unit(_sub(_CERAUNUS.position, _LATHE.position));
/** The tangent at the sub-Ceraunus point that points at Lathe's north pole. */
const _NORTH_TAN = _unit(_sub(_SPIN, _mul(_TO_CER, _dot(_SPIN, _TO_CER))));
/** The local zenith at the playfield: the sub-Ceraunus point walked north. */
const _UP = _unit(_add(_mul(_TO_CER, Math.cos(SITE_COLAT)), _mul(_NORTH_TAN, Math.sin(SITE_COLAT))));
/** The observer: standing ON the surface, not at the moon's centre. 5.2 km of
 *  radius is 5% of the 108.3 km to Ceraunus and it is worth the subtraction. */
const _EYE = _add(_LATHE.position, _mul(_UP, _LATHE.radius));
/** Local north is the moon's own north, projected into the local horizontal. */
const _NORTH = _unit(_sub(_SPIN, _mul(_UP, _dot(_SPIN, _UP))));
/** (east, up, south) is right-handed, the same as (E, N, U) with N = -south. */
const _EAST = _unit(_cross(_NORTH, _UP));

/**
 * A body's direction and angular radius as seen from the playfield, in the
 * game's own frame: `+x` east, `+y` up, `+z` south.
 */
const _look = (body) => {
  const d = _sub(body.position, _EYE);
  const dist = Math.hypot(d[0], d[1], d[2]);
  const u = _unit(d);
  return {
    dir: _fix([_dot(u, _EAST), _dot(u, _UP), -_dot(u, _NORTH)]),
    dist,
    /* asin, not atan. The shader's disc edge is where the angle from the body's
     * centre direction equals `uPlanetAngular` (it divides the tangent-plane
     * offsets by `sin(ang)` and tests r2 < 1), and the true half-angle to the
     * limb of a sphere is asin(R/d). atan(R/d) is the half-angle to the CENTRE
     * plane and is 1.1 degrees short here - a disc drawn 5% small. */
    ang: Math.asin(Math.min(1, body.radius / dist)),
  };
};

const _CER = _look(_CERAUNUS);
const _STAR = _look(_ERENMARK);
const _CATH = _look(_CATHEDRA);

/** Ceraunus, hung overhead. 0.37122 rad = 21.27 deg of angular radius, 42.5 deg
 *  across, 6.81% of the visible hemisphere. */
const CERAUNUS_DIR = _CER.dir;
const CERAUNUS_ANGULAR = +_CER.ang.toFixed(5);

/**
 * Erenmark, and the fact that decided the whole look of this world.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE STAR IS BELOW THE HORIZON, AND THAT IS NOT A CHOICE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Measured off the two body records: the angle at Lathe between Ceraunus and
 * Erenmark is 174.5 degrees. Lathe was placed on the near side of Ceraunus, back
 * toward the dock, and Erenmark sits behind the dock - so the moon lies almost
 * exactly BETWEEN the star and the gas giant. Ceraunus is at opposition from
 * here, permanently, at this epoch.
 *
 * That angle is invariant. It does not move when the moon rotates (7.9 h) and it
 * does not move when you walk. So "Ceraunus is high in the sky" and "the star is
 * up" are mutually exclusive on this world: put the gas giant at 42 degrees and
 * the star is at -37, and the only way to get the star above the horizon is to
 * drop Ceraunus onto the skyline. The brief asked for Ceraunus overhead and said
 * it was the point of the world, so the star goes under the horizon and this
 * world's daylight is PLANETSHINE.
 *
 * The generic airless rule - "the starfield and Erenmark visible in daylight" -
 * therefore holds by half. The starfield is there, black sky at noon, in a world
 * with no fog. Erenmark is not, and cannot be, without moving Lathe.
 *
 * The consolation is that a near-full gas giant 42 degrees across is a
 * spectacular light: 6.8% of the sky, an albedo around 0.5, delivering roughly
 * 7% of direct sunlight - the illuminance of a heavily overcast afternoon, which
 * is a perfectly bright place to stand and unlike anything else in the game.
 */
const STAR_DIR = _STAR.dir;

/**
 * Cathedra, in the sky shader's `moon` slot: a real body at a real bearing.
 *
 * 288 km away and 6.8 km in radius, so 0.029 rad - 2.0 degrees, four times the
 * apparent size of Earth's moon - sitting 6.6 degrees off Ceraunus's lower limb
 * in the south-south-west. It gives the gas giant a scale reference, which a
 * single disc on an empty sky does not have.
 *
 * What is drawn is not quite what is there, and the difference is 30 pixels
 * wide: `Sky.js`'s `moon()` builds a cratered grey body with mare, and Cathedra
 * is shattered blue-grey plate. At two degrees that is a texture nobody can
 * resolve; a `moonLand`/`moonOcean` pair does not exist in the shader, so this
 * is as close as the vocabulary reaches.
 */
const CATHEDRA_DIR = _CATH.dir;
const CATHEDRA_ANGULAR = +_CATH.ang.toFixed(5);

/* ================================================================== */
/* THE RINGS                                                           */
/* ================================================================== */

/**
 * Ceraunus's ring system, in this world's own frame - and it is now DRAWN.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE EDGE-ON DECISION, AND IT WAS MEASURED RATHER THAN TAKEN ON TASTE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `Bodies.js` places Lathe exactly in the ring plane, which is what a shepherd
 * moon IS, and the measured opening angle from this playfield is 2.05 degrees.
 * The obvious complaint about that is that a hoop arching overhead would be a
 * better payoff, and the obvious fix is to incline the orbit. Both were
 * considered and both were refused, for three reasons in ascending order of
 * weight:
 *
 *  1. An inclined moon does not shepherd anything, and this world is built out
 *     of that fact. THE SWEEP is ring ice the moon sweeps up on its leading
 *     face; `DRIFT_ANGLE` is COMPUTED from the orbit and comes out dead along
 *     the east-west axis precisely because the site was walked north from the
 *     sub-Ceraunus point INSIDE the plane. Tilt the orbit and the drifts point
 *     somewhere else, the `rimefall` in their troughs stops having a reason to
 *     be there, and the world's own name stops meaning anything.
 *
 *  2. It is not a cheap change. Lathe's bearing sets four things `Bodies.js`
 *     documents and three test files enforce - the 0.02-of-screen-height floor
 *     from the dock, the 2x(rA+rB) surface separation, the front-lit
 *     dot < 0.35, and the satellite exemption in `harness-framings.test.mjs`.
 *
 *  3. AND IT IS NOT ACTUALLY THIN. This is the measurement that decided it.
 *     "Edge on" sounds like a hairline, and from a distance it would be, but
 *     the observer here stands 2.76 Ceraunus-radii from the centre - INSIDE the
 *     sphere the outer ring edge sweeps. Measured off the two body records:
 *
 *       the outer edge, straight at the planet      18.0 km away
 *       the inner edge, straight at the planet      50.7 km away
 *       the outer ansa (tangent point)              58.8 km away
 *       Ceraunus's centre                          104.8 km away
 *
 *     The NEAR ARM is therefore a foreground object at a fifth of the planet's
 *     distance, and parallax opens it out: it crosses the sky 4.2 degrees below
 *     the planet's centre at its inner edge and 11.7 degrees below at its
 *     outer, so it lies across the LOWER HALF of a 42.5-degree disc as a band
 *     seven and a half degrees wide, not as a line. The far arm passes 1.1 to
 *     1.4 degrees below the centre, hidden behind the globe until it clears the
 *     limb, and runs out to ansae 31.0 to 55.8 degrees from the centre on each
 *     side - a bright thread from 22 degrees of elevation in the south-east, up
 *     through the gas giant due south at 42, and down to 22 again in the
 *     south-west. 111.6 degrees of sky, tip to tip.
 *
 *     And it is BRIGHT. The star stands 6.3 degrees above the ring plane and
 *     the line of sight only 2.0, so the slant path through the rings is 28x
 *     the normal one: an annulus that is 38% gap at normal incidence is opaque
 *     from here. The shader's mu0/(mu0+mu) term lands at 0.75, which is the
 *     whole reason this reads as a thread of light instead of a smear.
 *
 * So: edge on, and the sky was already right - it was the shader that had no
 * ring term. Everything below is read off `BODY_BY_ID.ceraunus.ring` rather
 * than typed, so the day the gas giant's rings are re-proportioned this view
 * changes with them.
 */
const _CER_RING = _CERAUNUS.ring;
if (!_CER_RING) throw new Error('[Lathe] Ceraunus carries no ring record - this world exists for that view');

/** Ceraunus's spin axis IS the ring normal: rings lie in a body's equator. */
const _CAX = _unit(_CERAUNUS.axis);
/** That axis, in the playfield's own frame - `+x` east, `+y` up, `+z` south. */
const RING_NORMAL = _fix([_dot(_CAX, _EAST), _dot(_CAX, _UP), -_dot(_CAX, _NORTH)]);

/**
 * (inner, outer, gapInner, gapOuter) in Ceraunus-radii, straight off the body.
 *
 * A ring with no division is stated as a zero-width one rather than as a null,
 * because the shader compares `gapOuter > gapInner` and a missing pair would
 * otherwise have to be spelled with an undefined that becomes a NaN uniform.
 */
const RING_RADII = [
  _CER_RING.inner,
  _CER_RING.outer,
  _CER_RING.gap ? _CER_RING.gap[0] : _CER_RING.outer,
  _CER_RING.gap ? _CER_RING.gap[1] : _CER_RING.outer,
];

/** The measured opening angle, for the record and for the test that pins it. */
export const RING_OPENING_DEG = +(Math.asin(Math.abs(_dot(CERAUNUS_DIR, RING_NORMAL))) * (180 / Math.PI)).toFixed(3);

/**
 * The drift bearing, computed from the orbit rather than chosen.
 *
 * Ring material arrives on the LEADING face, so the drifts run across the
 * direction of orbital motion. That direction is perpendicular to the radius
 * vector and lies in the ring plane, i.e. `radius x Ceraunus's spin axis`. Put
 * Put into the local frame it comes out with an elevation of 0.00 degrees and
 * lying dead along the east-west axis - `atan2` gives -3.14159 rad, i.e. due
 * WEST, and the crests therefore run north-south. The horizontal part is not a
 * coincidence and not a fit: the playfield was placed by walking north from the
 * sub-Ceraunus point, and a displacement along the meridian leaves the orbital
 * tangent in the local horizontal plane exactly.
 *
 * `dunes` takes a wave AXIS rather than a signed wind, so -pi and 0 build the
 * same field and the question of which of east and west is the leading face
 * never has to be answered - which is as well, because `Bodies.js` holds static
 * positions and names no orbital direction anywhere.
 */
const _LEAD = _unit(_cross(_unit(_sub(_CERAUNUS.position, _LATHE.position)), _unit(_CERAUNUS.axis)));
const DRIFT_ANGLE = +Math.atan2(-_dot(_LEAD, _NORTH), _dot(_LEAD, _EAST)).toFixed(5);

/* ================================================================== */
/* Frame of reference                                                  */
/* ================================================================== */

/** Playfield half-extent. 640 m square; the diagonal is 905 m. */
const HALF = 320;
/** The regolith plain. Everything is quoted against it. */
const PLAIN = 24;

/* -- THE SHEPHERD -------------------------------------------------- */
const SX = -108;
const SZ = 26;
/** Crater radius. The rim crest stands exactly here. */
const SR = 128;
const SHEPHERD_DEPTH = 46;
/** Floor, dead flat by construction - see the LEVEL layer. */
const SHEPHERD_FLOOR = PLAIN - SHEPHERD_DEPTH;

/** A point at polar (d, bearing-in-degrees) about the Shepherd's axis. */
const S = (d, deg) => [
  +(SX + d * Math.cos(deg * D2R)).toFixed(2),
  +(SZ + d * Math.sin(deg * D2R)).toFixed(2),
];

/**
 * The Shepherd Notch pad: d 136 on bearing 240, eight metres OUTSIDE the rim
 * crest, so its 24 m disc and 12 m blend cut a shelf into the flank rather than
 * balancing on the crest. Measured, the shelf levels to y 48.84 - twenty-two
 * metres below the crest above it and thirty-five above the ground outside -
 * and the flank between the two runs to 66.6 degrees. That is the whole mechanism: the
 * notch cannot be walked UP to, so the aurichalc below it cannot be walked down
 * to, so the exotic tier is a SECOND LANDING and not a longer march.
 *
 * Bearing 240 rather than the 300 the first draft used, and the reason is
 * measured rather than compositional. At 300 the pad sat 153 m from Oldwall's
 * centre, which is inside the annulus `sider` grows in, and the one-way flank
 * below the pad enclosed a pocket of that crest: five of eighteen siderite nodes
 * came out reachable ONLY by landing at the Notch. At 240 the pad sits 47 m from
 * Oldwall's centre - inside the old basin, nowhere near the crest - and the
 * count falls to three.
 */
const NOTCH = S(136, 240);

/**
 * The Winding: the road down the inner wall.
 *
 * It STARTS AT THE PAD CENTRE and that is load-bearing rather than tidy. A
 * `ramp` with no `y0` takes its head height from the pre-level field at its
 * first point, and a `pad` with no `y` does the same thing at the same place, so
 * starting here makes the two resolve to the same number. Start it a metre away
 * and the player steps off a riser they cannot see.
 *
 * 251 degrees of turn, 240 round to 491, so no two legs share a bearing and the
 * turns cannot merge into a flattened cone. 444 m for a 71 m drop, measured at
 * 9.1 degrees along most of it and 29.0 at its worst step.
 *
 * ── AND THE RADII ARE NOT EVENLY SPACED, WHICH IS THE POINT ────────────────
 *
 * The first version stepped the radius down evenly - 124, 112, 100, 88, 74, 58,
 * 44 - and it did not work: the reach probe found 0 of 864 floor points from
 * this pad, and the road was not blocked, it was WRONG. A `ramp` is linear in
 * ARCLENGTH, and `crater`'s wall is a smoothstep, which falls slowly at the top,
 * fast through the middle and slowly again at the bottom. A linear road across a
 * convex wall crosses it once and is a cut above that point and an EMBANKMENT
 * below it: measured, the old road stood 17 m proud of the wall at d 90, and
 * where the floor pad's own blend then met it the combined gradient reached 51
 * degrees and the flood stopped dead at s = 266 of 389.
 *
 * So the radii below are solved rather than spaced. The rule is one line - the
 * arclength to any radius must be the same fraction of the total that the wall's
 * drop to that radius is of the whole drop - and the answer is a spiral that
 * spends 100 degrees of its turn between d 116 and d 102, where the wall is
 * steepest, and opens out at both ends. Cut and fill against the bare wall
 * measure 0.0 m from d 120 to d 76. It was re-solved when the rim was steepened
 * from 34/30 to 40/26, because the wall the road is cut into is the same wall
 * the rim sets.
 */
const WINDING = [
  NOTCH,
  S(116, 274),
  S(112, 307),
  S(108, 339),
  S(102, 374),
  S(93, 408),
  S(84, 440),
  S(72, 474),
  S(56, 491),
];

/* -- OLDWALL ------------------------------------------------------- */
const OX = -186;
const OZ = -46;
/** Crest radius. `HIGHWALL` below is the point on this circle that puts the
 *  Shepherd due south of it, which is why its coordinates look arbitrary. */
const OR = 186;

/* -- NEWFALL ------------------------------------------------------- */
const NX = 60;
const NZ = -140;
const NR = 62;
/**
 * Newfall's floor, and it is NOT `PLAIN - depth`.
 *
 * The crater is 19 m deep, but it sits in its own ejecta and in six ray ridges,
 * and those lift the ground it is cut into. Measured as a ring mean on the built
 * field, the floor comes out at y 8.01, so the Slump's `y1` is 8 and the road
 * arrives ON the floor instead of ending in a three-metre pit at its toe.
 */
const NEWFALL_FLOOR = PLAIN - 16;

/** A point at polar (d, bearing-in-degrees) about Newfall's axis. */
const N = (d, deg) => [
  +(NX + d * Math.cos(deg * D2R)).toFixed(2),
  +(NZ + d * Math.sin(deg * D2R)).toFixed(2),
];

/**
 * The Slump: the breached sector of Newfall's rim, cut as a ramp.
 *
 * Bearing 45, which is the bearing of the primary pad from Newfall's centre, so
 * a player who walks over from Drifthead meets the way in rather than walking
 * the rim to find it. Newfall's inner wall measures 69 degrees and this is the
 * only break in it - a rare ore behind one purpose-built entrance, the same
 * shape as Cinder's outlet gorge at a fifth of the length.
 */
const SLUMP = [N(116, 45), N(92, 48), N(68, 52), N(44, 57), N(16, 62)];

/**
 * Newfall's six ejecta rays.
 *
 * Bearings chosen to miss two things: 45 degrees, which is the Slump, and the
 * 100-175 window, which is where the Shepherd is - a ray that ran into the
 * Shepherd would be wiped by its floor pad and stop dead in mid-crater.
 */
const RAY_BEARINGS = [5, 75, 185, 225, 280, 330];
const RAYS = RAY_BEARINGS.map((b) => [N(70, b), N(142, b + 4), N(215, b + 8)]);

/* -- THE SWEEP ----------------------------------------------------- */
const DRIFT_X = 150;
const DRIFT_Z = 165;
const DRIFT_R = 158;

/* -- The three pads ------------------------------------------------ */
const DRIFTHEAD = [180, -22];
/** On the Oldwall crest, at the bearing that puts the Shepherd due south.
 *  hypot(186 - 108, -46 + 215) = 186.1, i.e. the crest, to a decimetre. */
const HIGHWALL = [-108, -215];

/**
 * The Pock: eleven small craters, at ONE proportion.
 *
 * depth 0.18r, rim 0.075r, apron 0.6r, floor 0.34. Work the two gradients out of
 * those and both come out independent of r: the bowl contributes 0.409 and the
 * crest 0.284, so any Pock crater at any size tops out at 0.693 - 34.7 degrees,
 * inside the 38 the reach probe allows with 3 degrees to spare. A crater field
 * has to be texture, and texture that swallows a walking body is a trap.
 *
 * Three of them cut earlier ones on purpose. A younger rim crossing an older one
 * is the single cheapest thing that makes cratered ground read as HISTORY rather
 * than as a pattern, and it costs one extra record.
 */
const POCK = [
  [230, -250, 24], [218, -272, 16],
  [-250, 150, 34], [-236, 128, 22],
  [96, 262, 20],
  [-30, 210, 28],
  [250, 60, 26],
  [-215, -215, 40], [-192, -240, 24],
  [-10, -272, 22],
  [-286, 34, 30],
].map(([x, z, r]) => ({
  kind: 'crater',
  x, z, r,
  depth: +(r * 0.18).toFixed(2),
  rim: +(r * 0.075).toFixed(2),
  rimWidth: +(r * 0.6).toFixed(2),
  floor: 0.34,
}));

/* ================================================================== */
/* The descriptor                                                      */
/* ================================================================== */

export const LATHE = definePlanet({
  id: 'lathe',
  name: 'Lathe',
  blurb: 'Ceraunus’s shepherd moon. Airless, a fifth of a g, and the gas giant fills the southern sky. Rimefall ice on the sweep, siderite on Oldwall, tychite in Newfall - and aurichalc on the floor of the Shepherd, the dearest cubic metre in the system.',

  half: HALF,
  /**
   * 208 segments over 640 m: a 3.077 m cell, within a hair of Cinder's 3.125.
   * The mesh and the collision heightfield are the SAME grid, so this number
   * buys both the silhouette and the surface the player stands on.
   */
  seg: 208,

  /**
   * 0.19 g.
   *
   * AND IT IS WORTH SAYING EXACTLY WHO READS IT, because the answer changed
   * while this file was being written.
   *
   * `Piloting._env` takes `world.gravity` and hands it to the flight model, so a
   * ship falls at 1.90 m/s2 here and is the floatiest thing to land in the
   * system. The PLAYER ON FOOT now reads it too - `Player.setWorldGravity`
   * scales `CONFIG.player.gravity` by `1.90 / 9.81` = 0.1937 and the jump
   * impulse by the cube root of the same ratio, which puts this world at
   *
   *     player gravity  -4.26 m/s2      jump  3.70 m/s
   *     apex             1.61 m         hang  1.74 s
   *
   * against 0.93 m and 0.58 s at the reference. So Lathe is genuinely the
   * bounciest ground in the game, and every gate in this file was re-checked
   * against that jump rather than against the one it was designed with. See the
   * header block THE WALL: the Shepherd still holds at 0 of 6 from the primary
   * pad with a 1.61 m jump AND the solver's real 56.6-degree slope limit, which
   * is two standards harder than the reach probe asks for.
   */
  gravity: 1.90,

  /* ---------------------------------------------------------------- */
  terrain: {
    seed: 0x1a7e5c,
    baseY: PLAIN,
    /** Broad regolith swells. 240 m: airless ground has no wind and no water,
     *  so between impacts it is smooth, and the long wavelength is what keeps
     *  the swell from competing with the 30 m drifts. */
    swell: { amp: 3.4, scale: 240, octaves: 4 },
    /** Slump and creep at the 44 m scale. Deliberately NOT at the drift
     *  wavelength - 30 m ripple under 30 m dunes is beat frequency, not
     *  texture. */
    ripple: { amp: 1.1, scale: 44, octaves: 3 },
    /** Impact gardening, at the scale of a footfall. */
    grain: { amp: 0.34, scale: 22 },
    /**
     * The map edge falls away rather than walling up, and on an airless world it
     * has to do the work fog does everywhere else - there is no haze in vacuum
     * to hide the end of the mesh. 26 m over the last 68 m is 30 degrees: steep
     * enough to read as the ground curving off, shallow enough that a player who
     * walks over it can walk back.
     */
    rim: { start: 252, drop: 26 },

    landforms: [
      /* ---- ADD ---------------------------------------------------- *
       * Newfall's six ejecta rays. 2.2 m of relief tapering to nothing, which is
       * the only thing in the vocabulary that can make a ray. See the props
       * block and the report for what is NOT here: the bright RAYS of a young
       * crater are an ALBEDO feature, and `palette` colours by absolute height,
       * slope and one global fbm - there is no per-feature colour mask, so the
       * rays are relief plus a bright debris field and not a bright streak.   */
      ...RAYS.map((pts) => ({ kind: 'ridge', pts, width: 12, height: 2.2, taper: 0.8 })),

      /** The drifts. `angle` is COMPUTED - see `DRIFT_ANGLE`. `sharpness` 0.4
       *  gives the slip face 32% of the wavelength, which caps the steep side at
       *  25 degrees; at 0.55 and 3.6 m of amplitude it measured 37 and the ore
       *  on the crests would have been standing behind a fence. */
      {
        kind: 'dunes',
        x: DRIFT_X, z: DRIFT_Z, r: DRIFT_R,
        amp: 2.8, wavelength: 30, angle: DRIFT_ANGLE,
        sharpness: 0.40, taper: 0.28, seed: 0x5eed1,
      },

      /* ---- CUT ---------------------------------------------------- */
      /**
       * THE SHEPHERD. `rim` 40 over a `rimWidth` of only 26 is a gradient of
       * 2.31 - 66.6 degrees - and it is narrow BECAUSE it is a wall. Both halves
       * of that number are load-bearing and the header block THE WALL has the
       * measurement that set them: at 34/30 this flank was 58 degrees, which
       * passes the repo's 38-degree reach probe and fails the solver's own 56.6,
       * and the exotic tier was walkable from the primary pad at 839 m.
       */
      { kind: 'crater', x: SX, z: SZ, r: SR, depth: SHEPHERD_DEPTH, floor: 0.50, rim: 40, rimWidth: 26 },
      /** ...and the ejecta blanket the crater also wants, as its own record with
       *  `depth: 0` so it adds a broad 7 m apron 140 m out and takes nothing off
       *  the wall above. One number for the wall, one for the blanket. */
      { kind: 'crater', x: SX, z: SZ, r: SR, depth: 0, floor: 0.50, rim: 7, rimWidth: 140 },

      /** OLDWALL. Shallow, broad, and much older: a 14 m bowl under a 16 m crest
       *  that decays over 100 m. `floor` 0.42 widens the inner wall to 65 m,
       *  which is what drops the crest's inside to 21 degrees and lets a player
       *  walk over the rim anywhere it survives. */
      { kind: 'crater', x: OX, z: OZ, r: OR, depth: 14, floor: 0.42, rim: 16, rimWidth: 100 },

      /** NEWFALL. Sharp and young: a 69 degree inner wall, which is why the
       *  Slump exists. The 14.6 degree outer flank is deliberate the other way -
       *  you can walk up onto the rim and look in from anywhere. */
      { kind: 'crater', x: NX, z: NZ, r: NR, depth: 19, floor: 0.32, rim: 8, rimWidth: 46 },

      ...POCK,

      /* ---- LEVEL -------------------------------------------------- *
       * ROADS FIRST, PADS LAST, and Cinder paid for that ordering: with the pads
       * first, its spiral road left the rim pad's centre descending at 0.15 and
       * had taken 3.00 m off inside a 20 m disc - a landing pad with a
       * three-metre fall across it. Measured there: 3.00 m of span before, 0.00
       * after. The same ordering here means the Winding emerges from the Notch's
       * EDGE, where the pad's blend hands over to the road's own grade.        */

      /** The Winding, down the Shepherd's inner wall. `y1` is the floor's own
       *  level, and the floor pad below levels to the same number, so the road
       *  arrives on the floor with no step to find. */
      { kind: 'ramp', pts: WINDING, width: 8, blend: 14, y1: SHEPHERD_FLOOR },

      /** The Slump, into Newfall. */
      { kind: 'ramp', pts: SLUMP, width: 7, blend: 12, y1: NEWFALL_FLOOR },

      { kind: 'pad', x: DRIFTHEAD[0], z: DRIFTHEAD[1], r: 26, blend: 20 },
      /** 12 m of blend, not Cinder's 18. The blend is the only walkable-looking
       *  thing between the plain and this pad and it must NOT be walkable: 29 m
       *  of rise over 12 is 68 degrees, over 18 it would be 58, and the margin
       *  against the probe's 38 is the entire reason the exotic tier costs a
       *  decision. */
      { kind: 'pad', x: NOTCH[0], z: NOTCH[1], r: 24, blend: 12 },
      { kind: 'pad', x: HIGHWALL[0], z: HIGHWALL[1], r: 22, blend: 16 },

      /**
       * THE SHEPHERD'S FLOOR - and it is a `pad`, not a `basin`, for the reason
       * Cinder recorded about its lake bed.
       *
       * `crater` hands back a DELTA: the floor it digs is `depth` below whatever
       * it landed on, so it inherits everything underneath it. Measured on the
       * bare field, the natural floor here runs y -33.66 at the axis to y -26.69
       * at d 60 - a seven-metre dish, because the Shepherd was punched into the
       * middle of Oldwall's own basin and it inherited that bowl on top of the
       * 240 m swell. A `pad` is a LEVEL, so the floor is flat by construction and the
       * foot of the wall is the pad's own 26 m blend at 29 degrees - walkable,
       * which is what puts the aurichalc within reach of the road.
       *
       * It is LAST, after the Winding, and it holds the same `y` the Winding's
       * `y1` holds. Two records agreeing on one number by writing the same
       * constant, rather than by being near enough.
       */
      { kind: 'pad', x: SX, z: SZ, r: 62, blend: 26, y: SHEPHERD_FLOOR },
    ],
  },

  /* ---------------------------------------------------------------- */
  palette: {
    /* Not `snow.piste`: nine tenths of this moon is regolith and the ice is a
     * surface dusting the vertex colours carry, while `snow.piste` is a sheened
     * physical material that would put a wet gloss on 640,000 m2 of pulverised
     * rock. That still holds.
     *
     * But it was `dirt.ground`, and that was a GREY MOON RENDERED CHOCOLATE
     * BROWN. The dirt albedo measures linear R:G:B = 1.79 : 1 : 0.49 and vertex
     * bands multiply into it, so the cold violet dust (`#241f2b`), the cold
     * grey basin (`#4d5a68`, hue 209) and the rimefall drifts (`#bfd6e6`, hue
     * 205) - three of the six bands, and every cold one - were being filtered
     * warm. The table below spends 237 degrees of hue and none of it arrived.
     * `rock.neutral` is the same grain at the same luminance with no cast.
     * @see shadeRockNeutral in gfx/Materials.js */
    material: 'rock.neutral',
    tile: 5.0,
    /**
     * Absolute-height bands.
     *
     * VALUE STRUCTURE FIRST, and it is monotonic: 15, 30, 35, 50, 83, 85. Dark
     * in the deep craters where nothing has been turned over in an age, bright
     * on the crests where every impact re-exposes fresh material. That is what
     * makes the Shepherd's rim read as a silhouette from the far side of the
     * map, and it is also true of real airless ground - space weathering darkens
     * what sits still and impacts brighten what gets excavated.
     *
     * THEN THE FREEDOM SPENT ON HUE AND SATURATION, because Cinder shipped six
     * bands across five degrees of hue and zero saturation change and a tester
     * called the surface "one flat salmon-brown hue". This table:
     *
     *   height   colour     hue   sat   lightness   what it is
     *   y -18    #241f2b    265    16     15    old dust, cold and violet
     *   y   0    #6b4a31     28    38     30    iron-stained slump at the wall foot
     *   y  14    #4d5a68    209    16     35    the old basin: cold grey
     *   y  24    #8c8474     38    10     50    the plain: neutral warm regolith
     *   y  31    #bfd6e6    205    51     83    the drifts: rimefall ice
     *   y  74    #e9e0c8     45    47     85    the crests: bleached regolith
     *
     * 237 degrees of hue against Cinder's original 5, and 41 points of
     * saturation against 6. The cold bands are what make the warm ones read as
     * ROCK rather than as beige, and the two bright ones are deliberately a cold
     * white and a warm cream: on this world ice and excavated regolith are the
     * two bright things and they are not the same white.
     *
     * WHAT THIS CANNOT DO, and what `patch` below now does instead. Bands are
     * GLOBAL and keyed on absolute height: Newfall's floor is at y 8 and so is
     * any other ground at y 8, so for as long as height was the only handle a
     * young crater could not be given a bright floor without giving one to
     * every contour at that height across the whole map. That is exactly the
     * limitation `palette.patch` was added for, and the six records below are
     * what a young crater is supposed to look like.
     */
    bands: [
      { upTo: -18, color: 0x241f2b },
      { upTo: 0, color: 0x6b4a31 },
      { upTo: 14, color: 0x4d5a68 },
      { upTo: 24, color: 0x8c8474 },
      { upTo: 31, color: 0xbfd6e6 },
      { upTo: 74, color: 0xe9e0c8 },
    ],
    /** Bare rock on the crater walls. 32 rather than Cinder's 28 because this
     *  map is made of craters and at 28 half the walkable ground went bare;
     *  above 32 degrees it is genuinely a face. Dark and faintly violet, so it
     *  belongs to the same family as the deep band rather than reading as a
     *  separate grey. */
    slope: { fromDeg: 32, toDeg: 52, color: 0x39353c },
    /** Warm dust drift over the cool plain, so the bands do not print as a
     *  contour map. Applied as `n * n * amount`, so most of the field never
     *  approaches the ceiling. */
    mottle: { scale: 58, amount: 0.60, color: 0x6d5c46 },
    /**
     * ══════════════════════════════════════════════════════════════════════
     *  NEWFALL, PAINTED YOUNG
     * ══════════════════════════════════════════════════════════════════════
     *
     * A crater's age on an airless body is read off its ALBEDO before it is
     * read off its shape. Fresh material is bright because it has not had four
     * billion years of solar wind and micrometeorite gardening to darken it,
     * and it darkens from the outside in - so a young crater is a bright floor,
     * inside a bright blanket, inside bright rays. All three are here and all
     * three are the same colour family as the `rayfall` slabs scattered over
     * them (0xd8dee2 down to 0xaeb8c0), because they are the same rock.
     *
     * THE RAY CORRIDORS ARE THE SAME POLYLINES THE RIDGES ARE. `RAYS` is
     * declared once, the ADD layer lays 2.2 m of relief down it and these
     * records lay the brightness on the same line. Move a bearing and both go.
     *
     * Every record is height-gated as well as shape-gated, which is the whole
     * reason `patch` takes a REGION rather than a shape: the floor record is
     * "inside this disc AND below y 14", which no band can say and no shape can
     * say on its own. The rays stop at y 30 so they lie on the plain and do not
     * climb the Shepherd's flank or wash over the rimefall drifts, both of
     * which are already the bright end of the table.
     *
     * ── THE COLOURS ARE SET AGAINST A MEASURED BASE, NOT PICKED ──────────
     *
     * The first pass used the `rayfall` slab tints directly (0xc6d0d8 and down)
     * and produced a young crater DARKER than the ground round it. The reason
     * is in the transect, run out of Newfall's centre due south over the built
     * field, in linear luma:
     *
     *     d 0-16   the floor          0.40
     *     d 48     the inner wall     0.11   (the slope override)
     *     d 64     the rim crest      0.48
     *     d 80-192 the plain          0.55 - 0.62
     *
     * The plain around Newfall stands at y 33-38, not at the y 24 the band
     * table calls the plain, because the crater's own ejecta and six ray ridges
     * lift it - so locally the ground is already up in the rimefall-ice band. A
     * patch LERPS toward its colour, so to come out brighter than that it has
     * to BE brighter than that: 0.55 of base luma is the number every colour
     * below was chosen against, and the floor now measures about 0.70.
     *
     * The blanket is deliberately the weakest of the three (about +7% over the
     * plain). Ejecta thins outward, and a blanket as loud as the floor would
     * put a painted disc 300 m across in the middle of the map.
     */
    patch: [
      /** THE FLOOR. Newfall's bowl bottoms out at y 8 and the flat part of it
       *  is r 20; the disc is drawn wider and the height filter does the
       *  shaping, so the bright ground climbs the lower wall the way melt and
       *  slumped debris actually do. */
      {
        id: 'newfall_floor',
        region: { shape: 'disc', x: NX, z: NZ, r: 40, yMax: 14 },
        color: 0xe8eff4, strength: 0.84, feather: 12, grain: 0.24, grainScale: 26,
      },
      /** THE BLANKET. Continuous ejecta, from the rim crest out to 150 m -
       *  inside the 230 m the `rayfall` slabs cover, because the plates carry
       *  on further than the fines do. Weak, wide and heavily broken up: this
       *  is a wash, and a clean-edged one would read as a painted ring. */
      {
        id: 'newfall_apron',
        region: { shape: 'annulus', x: NX, z: NZ, r0: 58, r1: 152, slopeMaxDeg: 30, yMax: 36 },
        color: 0xd6e0e8, strength: 0.36, feather: 30, grain: 0.55, grainScale: 38,
      },
      /** THE SIX RAYS. Same polylines as the ridges in the ADD layer, 15 m
       *  either side of them. Two records over one line: the full length at
       *  half strength and the inner two thirds brighter, because a ray fades
       *  outward and one flat corridor reads as a road. */
      ...RAYS.map((pts, i) => ({
        id: `newfall_ray_${i}`,
        region: { shape: 'corridor', pts, width: 15, slopeMaxDeg: 28, yMax: 34 },
        color: 0xdfe8ef, strength: 0.52, feather: 9, grain: 0.44, grainScale: 21,
      })),
      ...RAYS.map((pts, i) => ({
        id: `newfall_ray_${i}_core`,
        region: { shape: 'corridor', pts: pts.slice(0, 2), width: 10, slopeMaxDeg: 28, yMax: 34 },
        color: 0xf2f7fa, strength: 0.46, feather: 7, grain: 0.36, grainScale: 16,
      })),
    ],
  },

  /* ---------------------------------------------------------------- */
  sky: {
    kind: 'space',
    params: {
      /* ── WHAT THE `space` SKY CAN AND CANNOT SAY ABOUT CERAUNUS ────────
       *
       * IT CAN: draw a shaded disc at a given direction and angular radius;
       * light it from `sunDirection` with a real terminator, a limb and a
       * sunset band; give it a latitudinal BANDED cloud deck (the shader's
       * cloud term samples fbm with y compressed 3.3x, which is the closest
       * thing to a gas giant in the whole file); give it two body colours; and
       * cap it in white at high latitude.
       *
       * AND IT CAN NOW DRAW THE RINGS. That paragraph used to say it could not,
       * and it was the largest single gap in this world: `uPlanetAngular` made
       * a disc and nothing else. `SPACE_FRAGMENT` now carries a ring term that
       * RAY-TRACES the real plane rather than pasting an ellipse round the
       * disc, which it has to, because from here the near arm is 18 km away and
       * the far arm is 191 - see THE RINGS above for the measurements and for
       * why the orbit stayed in the plane.
       *
       * WHAT THE RING TERM CAN SAY: the annulus with its Cassini division, at
       * its true perspective, in front of the disc on the near side and behind
       * it on the far; its opacity through the slant path, so an edge-on ring
       * goes opaque; reflected light off the lit face and transmission through
       * an unlit one; the planet's shadow lying along the rings; and the rings'
       * shadow lying across the planet.
       *
       * WHAT IT STILL CANNOT: the ring is INFINITELY THIN, so there is no
       * shading of a ring seen exactly edge-on and no self-shadowing between
       * ringlets. It has no opposition surge - the sharp brightening a real
       * ring shows within a degree of zero phase, which THIS WORLD sits at
       * (5.5 degrees off), so the rings here are if anything understated. And
       * the star is treated as a direction rather than a point, which is worth
       * a fraction of a degree in the shadow's edge over a 191 km arm.
       *
       * The two gas-giant compromises that remain, named:
       *  - The shader's "continents" are an fbm land mask over an ocean. There
       *    is no land here, so `planetLand` and `planetOcean` are set to
       *    Ceraunus's own light zone and dark belt from `Bodies.js`, and the
       *    mask reads as blotchy belt structure instead of coastlines.
       *  - Its settlement-light term fires on the NIGHT side. At 174.5 degrees
       *    of elongation the disc is 99.5% lit and `night` only rises inside the
       *    outermost half per cent of the disc radius on the anti-star limb -
       *    one or two pixels, under a cover that is already fading. Measured,
       *    not hoped: `ndl` at the disc centre is 0.9955.                      */

      /* THE STAR, and it is under the horizon - see `STAR_DIR`. It still drives
       * Ceraunus's terminator, which is the only reason it is here. */
      sunDirection: STAR_DIR,
      /**
       * DIM, AND THE REASON IS ONE TERM.
       *
       * `uSunColor` paints exactly two things: the star's own disc and bleed,
       * which on this world is 37 degrees below the horizon and never drawn, and
       * the shader's OCEAN GLINT on the planet. At near-full phase that glint
       * lands square in the middle of Ceraunus's disc - `pow(dot(N,h), 220)`
       * peaks at 0.74 and is multiplied by 2.2 - and a gas giant with a specular
       * highlight on it is simply wrong. At 0xfff3e0 it measured about 1.6 in
       * linear, over the `space` grade's 1.60 bloom threshold, i.e. a glowing
       * blob 50 px across. At 0x5a5148 the same term lands at 0.16 and reads as
       * a broad brightening of the sub-solar zone, which is what a gas giant at
       * opposition actually does.
       */
      sunColor: 0x5a5148,
      sunSize: 0.023,

      /* Ceraunus. Both numbers computed - see the block above. */
      planetDirection: CERAUNUS_DIR,
      planetAngularRadius: CERAUNUS_ANGULAR,
      /** Ceraunus's own `look.high` and `look.low` from `Bodies.js`: the light
       *  zone and the dark belt. Named here rather than imported because they
       *  are being used for something the shader calls land and ocean, and a
       *  live reference would imply an agreement that does not exist. */
      planetLand: 0xf0dcc0,
      planetOcean: 0x7a5638,
      /** The limb. Ceraunus's `look.atmosphere` is 0xe6c79a; this is that,
       *  pulled down a little, because the shader's rim term multiplies by up to
       *  1.77 on the lit limb and the full value put a cream ring round the
       *  planet bright enough to bloom. */
      planetAtmosphere: 0xc9ac82,
      /** Ceraunus's own spin is 0.0022 rad/s. The dome's term is
       *  `time * spinSpeed` in radians, so this is the real rotation rate: the
       *  bands drift, over minutes, in the direction the body actually turns. */
      planetSpinSpeed: 0.0022,

      /* Cathedra, 288 km away, in the moon slot. Both numbers computed. */
      moonDirection: CATHEDRA_DIR,
      moonAngularRadius: CATHEDRA_ANGULAR,

      /* ── THE RINGS. Every number read off Ceraunus's own record. ────────
       *
       * `ringNormal` is the gas giant's spin axis in this playfield's frame,
       * which is what a ring plane is; `ringRadii` and `ringColor` are its
       * `ring` block verbatim. Nothing here is a second copy of anything.        */
      ringNormal: RING_NORMAL,
      ringRadii: RING_RADII,
      ringColor: _CER_RING.tint,
      ringDensity: _CER_RING.density,
      /**
       * The particles' albedo, and it is set against the BLOOM THRESHOLD rather
       * than by eye.
       *
       * The `space` grade thresholds at 1.60 linear and anything over that
       * stops reading as a surface and starts reading as a lens flare - the
       * same trap that put Vitrine's `atmoStrength` at 0.9. Worked through: the
       * tint 0xd8c4a2 is 0.686 linear in red, the slant-path reflectance
       * mu0/(mu0+mu) lands at 0.754 from this site, so the brightest ring pixel
       * is 0.686 x 0.754 x this. At 1.45 that is 0.75 linear - bright enough to
       * be the brightest thing in the frame after the gas giant itself, and
       * less than half the threshold, so the rings glow rather than blooming.
       */
      ringBrightness: 1.45,

      /** Up from 1.0. There is no air and no star above the horizon, so the
       *  starfield is the only thing between the gas giant and the ground and it
       *  should be the deepest one in the game. */
      starBrightness: 1.30,
      nebulaDensity: 0.34,
      exposure: 1.0,
    },

    /** Black, with the faintest cold cast so it is not a dead channel. */
    background: 0x05060b,

    /**
     * ── VACUUM, WHICH IS THE ONE CASE THE FOG RULES DO NOT COVER ──────────
     *
     * The house rule is that fog is LIGHTER and GREYER than the ground under it
     * and reaches about 1.1x the playfield diagonal. Both halves of that assume
     * AIR. There is none here, so there is nothing to scatter, and a fog that
     * lifted the far side of the map would be painting an atmosphere onto an
     * airless moon.
     *
     * So: `near` 900 and `far` 3620, which is 4x the 905 m diagonal. At the far
     * CORNER of the playfield the fog factor is 0.002 - the world is
     * effectively unfogged, which is the point, and the colour it tends to is
     * the black sky rather than a haze.
     *
     * Two consequences worth stating rather than discovering:
     *  1. This palette's bands average L 0.50, and no fog that reads as vacuum
     *     can be lighter than that. `planet-atmosphere.test.mjs`'s
     *     "haze lighter than the ground" rule is Cinder-only today and Lathe
     *     would fail it. It needs an airless branch before it is generalised.
     *  2. `far` 3620 is past `CONFIG.render.far` (2000). That ceiling exists so
     *     terrain does not pop at the clip plane, and nothing on this world is
     *     more than 905 m from anything else, so there is nothing at the clip
     *     to pop. The same test's ceiling assertion needs the same branch.
     *
     * What actually hides the edge of the mesh is `terrain.rim` above: the
     * ground falls 26 m away over the last 68 m and the world dissolves into
     * the starfield instead of into soup.
     */
    fog: { color: 0x0b0c0f, near: 900, far: 3620 },

    /**
     * ── THE LIGHT, AND WHY THE KEY IS NOT THE STAR ────────────────────────
     *
     * The key light points at CERAUNUS. That is not a stylisation: Erenmark is
     * 37 degrees below this world's horizon (see `STAR_DIR`) and every photon
     * that reaches this ground has come off the gas giant. So `sky.params
     * .sunDirection` and `sky.sun.direction` are DIFFERENT VECTORS on this
     * planet, deliberately, and they are different objects - the star that
     * shades the disc, and the disc that lights the ground.
     *
     * Colour is Erenmark's warm white reflected off a cream gas giant: 0xf5e2c0.
     *
     * ── AND THE AMBIENT WENT DOWN, NOT UP ────────────────────────────────
     *
     * The tempting argument is that Ceraunus covers 6.8% of the sky, so the fill
     * should be huge. That argument is wrong, and it is worth writing down why:
     * a source's ANGULAR SIZE does not become fill. All 6.8% of it arrives from
     * inside one 42-degree cone, and a directional light already points down the
     * middle of that cone. What angular size actually buys is a SOFT SHADOW
     * EDGE - a penumbra 21 degrees wide - and one `THREE.DirectionalLight`
     * cannot express that at any intensity. The shadows on this world will be
     * harder-edged than they physically should be and no number in this record
     * can fix it. That is the honest gap and it is the biggest one in the file.
     *
     * What DOES justify a fill is albedo. Cinder's fill is bounce off black
     * basalt with a lava lake helping; this ground is ice and pale regolith at
     * roughly five times the reflectance, but it is lit by planetshine at about
     * 7% of direct sunlight and there is no dust in the air to scatter it
     * further. Those two very nearly cancel. So: 0.40 against a key of 6.0, a
     * fill/key of 0.067 - marginally TIGHTER than Cinder's 0.072, which is what
     * "shadows with nothing in them" has to mean on a world with no air.
     *
     * The fill is tinted cold (0x8fa0b4) because it is warm planetshine bounced
     * off blue ice, and because the `space` grade below already runs a cold
     * shadow tint - warm key, cold shadow, and the palette's warm crests against
     * its cool plain are the same decision made twice.
     */
    ambient: { color: 0x8fa0b4, intensity: 0.40 },
    sun: { color: 0xf5e2c0, intensity: 6.0, direction: CERAUNUS_DIR },
    exposure: 1.18,
    /**
     * The void's own grade, and it is the right one for the same reason it was
     * built: `haze` 0, `shafts` 0 and `toeLift` 0.004. There is no air to make a
     * god ray in and no scattering to lift a shadow out of black. `GRADE_PRESETS`
     * is keyed on WORLD id and a planet is not in it, so naming one here is the
     * only way a planet gets a calibrated look.
     */
    grade: 'space',
  },

  /* ---------------------------------------------------------------- */
  /** No liquid. At 1.9 m/s2 and no atmosphere there is nothing to hold one, and
   *  the ice here is a solid the player mines rather than a surface they stand
   *  beside. `PlanetWorld` sets `swim: false` on every planet anyway. */
  liquid: null,

  /* ---------------------------------------------------------------- */
  props: [
    {
      id: 'ejecta',
      kind: 'boulders',
      /* Everywhere, because on a crater world everything on the ground came out
       * of a crater. `slopeMaxDeg` 32 matches the palette's bare-rock threshold
       * so blocks stop exactly where the walls start - a boulder standing on a
       * 50 degree face reads as pasted on. */
      region: { shape: 'field', slopeMaxDeg: 32, clearOfPads: 5 },
      count: 950, spacing: 7,
      size: { rMin: 0.55, rMax: 2.9 },
      tint: [0x38342f, 0x2a2724, 0x45403a, 0x211e1c],
      collide: true,
    },
    {
      id: 'rayfall',
      kind: 'slabs',
      /* Newfall's debris apron: flat plates of shattered crust thrown out and
       * landed on edge. BRIGHT, and that is the point - it is the nearest this
       * vocabulary gets to a ray system (see the ADD layer's note). An annulus
       * rather than six corridors because a `region` is one shape, and six
       * records for six rays would be six scatters that could each fall short
       * independently. */
      region: { shape: 'annulus', x: NX, z: NZ, r0: 62, r1: 230, slopeMaxDeg: 26, clearOfPads: 5 },
      /* 6.5 m spacing against a 3.6 m maximum width. Cinder lost a whole seam
       * inside a colonnade at 5.0 m spacing, and the walk from Drifthead to
       * Newfall crosses this entire field. */
      count: 240, spacing: 6.5,
      size: { w: [1.1, 3.6], d: [0.9, 3.0], t: [0.12, 0.40], tilt: 0.48 },
      tint: [0xd8dee2, 0xc2ccd4, 0xe6eaee, 0xaeb8c0],
      collide: true,
    },
    {
      id: 'oldwall_plate',
      kind: 'slabs',
      /* The Oldwall crest, upended. Darker and thicker than the rayfall: this is
       * old iron-rich plate that has been sitting long enough to weather, and it
       * is what `sider` weathers out of. */
      region: { shape: 'annulus', x: OX, z: OZ, r0: 156, r1: 216, slopeMaxDeg: 28, clearOfPads: 4 },
      count: 200, spacing: 6.5,
      size: { w: [1.4, 4.2], d: [1.2, 3.4], t: [0.25, 0.80], tilt: 0.62 },
      tint: [0x4a463f, 0x5c5850, 0x36332e, 0x6a655a],
      collide: true,
    },
    {
      id: 'shepherd_spires',
      kind: 'spires',
      /* THE SHOT. A forest of pale pinnacles standing on a dead-flat floor 46 m
       * down, with a gas giant 42 degrees across overhead and a black sky behind
       * it. There is nothing else like it in the game, and it is what the player
       * gets for building a second landing.
       *
       * 7.5 m of spacing against a 2.0 m maximum base radius leaves lanes 3.5 to
       * 5.5 m wide - Cinder's colonnade measurement applied before the fact
       * rather than after. The aurichalc is inside this field and has to be
       * walkable to. */
      region: { shape: 'disc', x: SX, z: SZ, r: 58, slopeMaxDeg: 12 },
      count: 100, spacing: 7.5,
      size: { h: [4, 15], base: [0.7, 2.0], lean: 0.20, facets: 5 },
      tint: [0x9a8d6e, 0xb8a97f, 0x7d735c, 0xd2c49a],
      collide: true,
    },
  ],

  /* ---------------------------------------------------------------- *
   * MINERALS - four elements, four places, and the best cargo decision in the
   * game.
   *
   *   rarity     element    terrain    place            cr/m3   m3   cr/node
   *   ---------  ---------  ---------  ---------------  -----  ---  -------
   *   common     rimefall   plain      The Sweep           22    3       66
   *   uncommon   sider      outcrop    Oldwall             88    2      176
   *   rare       tychite    crater     Newfall            360    1      360
   *   exotic     aurichalc  crater     The Shepherd       700    1      700
   *
   * `size` is the node radius AND the hold volume, so the cheap ore is the
   * BULKY ore - and here that matters more than on any other world. A stock
   * Kestrel holds 10 m3. Filled with rimefall that is three lumps and 198
   * credits. Filled with the six aurichalc nodes on this map plus four tychite
   * it is 5,640 - twenty-eight times the same hold, and the entire reason the
   * 185 km flight exists.
   *
   * `credits` is absent from every row on purpose: `definePlanet` computes it
   * from `unitValue * hold` and REFUSES a hand-written one.
   *
   * The last row is the design in one line. Aurichalc is not a longer walk from
   * Drifthead, it is UNREACHABLE from Drifthead - the Shepherd's outer flank is
   * 66.6 degrees all the way round, measured at the SOLVER's own slope limit and
   * not only at the reach probe's - and it becomes reachable only from the Notch,
   * down the Winding, 445 walking metres away.                              */
  minerals: [
    {
      id: 'rimefall', item: 'rimefall', name: 'Rimefall Ice',
      rarity: 'common', terrain: 'plain', place: 'The Sweep',
      /* DENSE BLUE ICE, not the white of the item icon, and it is a legibility
       * decision. The drift crests are palette band 5 (0xbfd6e6) and a node at
       * the item's own 0xe4f0f8 would be a white lump on white ground - the
       * exact failure Cinder's cream tephra was. Compacted ice really is bluer
       * than frost, so the fix and the mineralogy are the same fix. */
      color: 0x8fb8d4, glow: 0,
      unitValue: ORE('rimefall'), spread: 0.25,
      /* The biggest node on the planet and the least valuable: 1.85 m of radius
       * is three cubic metres of hold (`holdUnitsFor` rounds 2.96 up to 3), and
       * a stock Kestrel carries three of them. */
      size: 1.85, count: 34, spacing: 20,
      region: { shape: 'disc', x: DRIFT_X, z: DRIFT_Z, r: 152, slopeMaxDeg: 22, clearOfPads: 5 },
    },
    {
      id: 'sider', item: 'sider', name: 'Siderite Iron',
      rarity: 'uncommon', terrain: 'outcrop', place: 'Oldwall',
      /* Cold dark grey-blue, against a crest that runs pale ice into warm cream.
       * Meteoric nickel-iron is exactly this colour and it is also the one value
       * the Oldwall crest does not already have. */
      color: 0x565a63, glow: 0,
      unitValue: ORE('sider'), spread: 0.25,
      size: 1.05, count: 18, spacing: 13,
      /* An annulus on the crest, and the `slopeMaxDeg` 26 is what makes it the
       * CREST rather than the ring: the Oldwall rim measures 29.5 degrees on its
       * inner face and 29.4 on its outer apron, so the band keeps the crown and
       * the shoulders and drops the two faces, along with anything the
       * Shepherd's ejecta has steepened.
       *
       * ── AND THREE OF THE EIGHTEEN NEED THE SECOND PAD. STATED, NOT HIDDEN ──
       *
       * Measured: 14 of 18 nodes are walkable from Drifthead or from Highwall
       * (227-574 m and 40-162 m respectively), and 4 are reachable only by
       * landing at the Shepherd Notch. They sit on an arc of crest that the
       * Shepherd's ejecta flank has fenced off from the rest of the map, and the
       * Notch's own one-way flank is the only way down into it.
       *
       * It is left as it is on purpose. Every node is reachable from SOME pad,
       * which is the floor; and an uncommon ore with a few nodes that pay a
       * player who came for the exotic tier is a small bonus rather than a
       * defect. If it should be 18 of 18 from the primary, the lever is
       * `r0`/`r1` here, not the crater - and the report says so. */
      region: { shape: 'annulus', x: OX, z: OZ, r0: 158, r1: 214, slopeMaxDeg: 26, clearOfPads: 4 },
    },
    {
      id: 'tychite', item: 'tychite', name: 'Tychite',
      rarity: 'rare', terrain: 'crater', place: 'Newfall',
      /* Teal, and the only cold-bright thing on the planet that is not ice. It
       * sits on the darkest floor outside the Shepherd, which is what makes ten
       * nodes findable in a 124 m bowl without a marker. */
      color: 0xa8e0d0, glow: 0x1e5a4e,
      unitValue: ORE('tychite'), spread: 0.25,
      size: 0.70, count: 10, spacing: 12,
      region: { shape: 'disc', x: NX, z: NZ, r: 54, slopeMaxDeg: 24, clearOfPads: 4 },
    },
    {
      id: 'aurichalc', item: 'aurichalc', name: 'Aurichalc',
      rarity: 'exotic', terrain: 'crater', place: 'the floor of The Shepherd',
      /* Gold, glowing, on the darkest band in the table (0x241f2b at y -18). The
       * dearest ore in the system is also the most visible object on the surface
       * it lies on, and that is deliberate: the walk to it is the cost, finding
       * it is not supposed to be. */
      color: 0xf0c040, glow: 0xff9c10,
      unitValue: ORE('aurichalc'), spread: 0.25,
      /* The smallest node on the planet and the dearest: one cubic metre, 700
       * credits, and all seven fit in a stock Kestrel with room for three
       * tychite on top. A Pike cannot carry a single one
       * (`SHIP_BASE_STATS.pike.hold` is 0).
       *
       * ── SEVEN, AND NOT SIX, AND THE REASON IS THE LADDER ─────────────────
       * `count` is what caps this tier's trip, not the hold: `holdUnitsFor`
       * rounds a 0.58 node to 1 m3, so a Kestrel can carry ten and the seam
       * only has this many. At six the ladder TIED at the top - the Kestrel
       * earned 237.28 cr/min on rare tychite and 236.98 on exotic aurichalc, a
       * 0.13% shortfall - because ten tychite fill the hold in 911 s and six
       * aurichalc half-fill it in 1051, so the exotic paid more per TRIP and
       * the same per MINUTE. The rarity ladder has to CLIMB in the currency the
       * player actually spends, which is time.
       *
       * A seventh node is 692 cr for one more hop and one more 0.85 s dig:
       * measured, 4,855 cr in 1,050 s = 277 cr/min against tychite's 237, and
       * the Lathe ladder now reads 14 -> 62 -> 237 -> 277 with a 20.5x spread
       * common to exotic. The alternatives were both worse: lengthening the
       * tychite march moves a number that is already the planet's design, and
       * `unitValue` is read from `ITEMS` and belongs to the economy rather than
       * to this file. */
      size: 0.58, count: 7, spacing: 16,
      /* r 56, inside the floor pad's 62, so every candidate is on ground that is
       * flat by construction. `slopeMaxDeg` 10 is belt and braces - on a levelled
       * disc the only slope left is the grain octave. */
      region: { shape: 'disc', x: SX, z: SZ, r: 56, slopeMaxDeg: 10, clearOfPads: 4 },
    },
  ],

  /* ---------------------------------------------------------------- */
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
   * 1.9 m/s2: apex 1.609 m, hang 1.74 s, an 8.0 m broad jump at a walk and
   * 14.3 m at a sprint. The second-lightest body in the system and the second
   * place where a rim notch is a step rather than a detour.
   *
   * WHAT IS DELIBERATELY NOT HERE: the crest of The Shepherd. It is the best
   * vantage on the moon - 84.9 m, 50 m of prominence, and the gas giant sitting
   * on it - and its inner rim is 40 m of wall over 13 m of run, which is 72
   * degrees. The 38-degree walk lattice cannot reach it, the player's own
   * step-up ladder gives out at 59, and the only way up is `FreeClimb` holding
   * Space against a 40 m face while `Stamina` drains. That may well work. It is
   * not PROVEN to work, and a prize whose reachability rests on a model nobody
   * has flown is this repo's oldest defect wearing a rope. It stays out until
   * somebody climbs it. */
  viewpoints: [
    {
      /* The west shoulder of Oldwall - the old degraded basin whose rim is a
       * 100 m-wide swell rather than a wall, so it is walked rather than
       * climbed. 40.5 m, 157 m out from Highwall. */
      id: 'oldwall_rim', name: 'Oldwall Shoulder', x: -260, z: -210, r: 7,
      terrain: 'outcrop', place: 'Oldwall',
      climb: 'North-west off Highwall and up the outer swell.',
    },
    {
      /* Newfall's north rim, 40.8 m, over a 19 m bowl with the ray field
       * running away north-east from it. */
      id: 'newfall_rim', name: 'Newfall North Rim', x: 60, z: -71.1, r: 6,
      terrain: 'crater', place: 'Newfall',
      climb: 'South-west from Drifthead along the ray, then up the rim.',
    },
    {
      /* Out on The Sweep at the south-east corner, 17.2 m up on a low swell -
       * the flattest ground on the moon and therefore the one place where
       * Ceraunus is the whole of the view instead of half of it. 330 m out. */
      id: 'sweep_south', name: 'Sweep Southing', x: 270, z: -270, r: 8,
      terrain: 'plain', place: 'The Sweep',
      climb: 'South-east from Drifthead across the drift, no climb at all.',
    },
  ],

  landing: [
    /** The arrival. `yaw` PI is due south, because `Player` faces -Z at yaw 0 -
     *  so the first thing a player sees when the world resolves is Ceraunus. */
    {
      id: 'drifthead', name: 'Drifthead', x: DRIFTHEAD[0], z: DRIFTHEAD[1], r: 26, primary: true, yaw: Math.PI,
    },
    /** The second landing, and the only way to the exotic tier. The pad is at
     *  bearing 240 from the crater's axis, so the crater is to the SOUTH-EAST of
     *  it and yaw -2.62 looks that way: down the Winding, across the floor, with
     *  Ceraunus a little to the right of centre and 42 degrees up. */
    {
      id: 'shepherd_notch', name: 'Shepherd Notch', x: NOTCH[0], z: NOTCH[1], r: 20, yaw: -2.62,
    },
    /** The survey shot: due south is the Shepherd's rim with the gas giant
     *  standing over it. */
    {
      id: 'highwall', name: 'Highwall', x: HIGHWALL[0], z: HIGHWALL[1], r: 22, yaw: Math.PI,
    },
  ],


  /**
   * Ring infall. This moon is inside the fringe of a ring system and sweeping it
   * up - that is where `rimefall` comes from and the item's own description says
   * it "falls slowly enough to watch". So the one hazard field on an airless
   * world is a sparse fall of ice motes: 216 of them, pale and cold.
   *
   * ONE THING IT GETS WRONG, and it is not authorable: `ASH_VERT` hard-codes the
   * fall speed at `1.6 + seed * 3.4` m/s for every world in the game. At 1.9
   * m/s2 these should drift down far slower than that, and there is no parameter
   * for it. The alternative was no infall at all, which throws away the only
   * moving thing on the surface and the reason the common ore exists.
   */
  hazards: {
    ashfall: { density: 0.12, drift: [0.22, -0.09] },
    ashColor: 0xd8e8f2,
  },
});

export default LATHE;
