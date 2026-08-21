/**
 * TESSERA - the airless cratered moonlet, and the first landable vacuum in the
 * game.
 *
 * Everything here is data. Cinder is a shield volcano and this is a moonlet,
 * and the difference cost no world class, no height function and no prop kind:
 * it is a different set of landform records, a different palette and a
 * different sky. The one thing this planet needed that Cinder did not is the
 * `crater` landform, which was added to `PlanetHeight.js` for exactly this file
 * - a raised annular ejecta rim, so that a bowl is a crater and not a dent.
 *
 * ==========================================================================
 *  THE MAP, in words
 * ==========================================================================
 *
 * 700 m square, `+x` east and `+z` south. The regolith datum - the height
 * everything else is quoted against - is y = 22.
 *
 *   CROWN OF RAYS       the young crater, centred (-120, -60). 296 m across,
 *                       54 m deep, its ejecta rim crest standing 17 m above the
 *                       plain at r = 148 and dying away 60 m outside it. Its
 *                       inner wall MEASURES 39 deg median, 53 at p95 and 64 at
 *                       worst - a scarp and not a slope. You cannot walk into
 *                       this crater, and that is the point of the road below.
 *                       Its floor is THE MELT SHEET, a dead-level pond of
 *                       frozen impact melt with sperrylite shocked out of the
 *                       bedrock into it.
 *
 *   THE SLUMP ROAD      the only way down into Crown of Rays on foot. A `ramp`
 *                       from the Raysedge landing pad, 401 m long round the
 *                       inner wall through 192 deg of bearing at a measured
 *                       10.1 deg mean (30.3 worst over any 2 m), from the rim
 *                       to the melt sheet's edge. Delete it and sperrylite goes
 *                       from 12 nodes to 0 from every pad on the planet -
 *                       measured by ablation, not asserted. It exists because a
 *                       crater whose floor you can see and cannot reach is the
 *                       exact defect this project keeps shipping.
 *
 *   THE GHOST RING      the ancient crater, centred (150, 95). Bigger than
 *                       Crown of Rays at 316 m across and a fifth as deep - 14
 *                       m, with a 4.5 m lip where a rim used to be, and a wall
 *                       that measures 19 deg: you walk into this one from
 *                       anywhere, which is the whole contrast. Half its rim is
 *                       gone. THE SURVIVING ARC still stands 13.5 m proud from
 *                       bearing -100 round to +5; from +27 to +87 there is no
 *                       rim at all because the Cold Well punched out through
 *                       it. Two ages of crater in one silhouette is what makes
 *                       a moonlet read as a moonlet rather than as a golf ball.
 *
 *   THE PAVEMENT        what is left of the Ghost Ring's floor, which is a
 *                       CRESCENT and not a disc - the Cold Well took the middle
 *                       of it. 355 upended plates of shattered bedrock, tilted
 *                       and yawed, and the thing the moon is named for:
 *                       `tessera` is a mosaic tile. Every point in the field
 *                       that qualifies for a plate is walkable (1010 of 1010,
 *                       measured); the crescent is a place, not a view.
 *
 *   THE COLD WELL       the young deep one, centred (196, 166) - through the
 *                       Ghost Ring's floor, past its axis and out through its
 *                       south-east rim. 192 m across and 52 m deep with a wall
 *                       that measures 52 deg median and 62 at p95: NOTHING
 *                       walks into this and nothing walks out. Its floor is
 *                       permanently shadowed and helion ice survives on it.
 *                       It has its own landing pad, and that pad is the whole
 *                       design of the exotic tier.
 *
 *   THE PALE BENCH      a block of highland anorthosite at (-90, 200), 104 m
 *                       across and standing 26 m above the plain with a 28 m
 *                       edge. Bright cream against grey; it is the one thing on
 *                       the surface that is not a hole or the rubble from one.
 *
 *   THE BENCH STAIR     62 m of `ramp` up the bench's west face at 22.7 deg,
 *                       and the reason it exists is in its own comment: the
 *                       first version of this planet had a 54 deg edge all
 *                       round and 0 of 22 anorthite nodes reachable from any
 *                       pad. An `outcrop` keeps its edge and gets a route.
 *
 *   MOSAIC FLAT         the open-ground landing, (-250, 200), out on the open
 *                       regolith with Crown of Rays' rim on the skyline dead
 *                       ahead at 143 m. The nearest regolith is 46 m from the
 *                       ramp and the nearest anorthite 125 m up the Stair.
 *
 *   THE RAYS            two bright ejecta streaks thrown out of Crown of Rays,
 *                       one north-east for 346 m and one south for 287 m. See
 *                       the note on `ray_ne` - the vocabulary has no radial
 *                       palette term, so a ray system is PROPS here, which is
 *                       also what a ray system physically is.
 *
 *   AND SEVEN MORE      Splinter A and B overlap each other in the north; the
 *                       Notch sits tangent on Crown of Rays' rim and is itself
 *                       overlapped by a pock further north. Ten craters in all,
 *                       four of them cutting or lapping another's rim, and
 *                       every one of the seven small ones has a floor a body
 *                       can walk down into and back out of (measured, 384 to
 *                       854 m from Mosaic Flat).
 *
 * ==========================================================================
 *  WHY THE NUMBERS ARE THESE NUMBERS
 * ==========================================================================
 *
 * ── The relief budget ────────────────────────────────────────────────────
 * Measured over the built field at 1 m: the surface runs y -44.71 to y +48.54,
 * a 93.2 m span, from the Cold Well's floor to the Pale Bench's table. The
 * swell, ripple and grain amplitudes below total 5.6 m, which
 * is the last 6% and its whole job is to stop the authored shapes reading as
 * CAD. That is a SMALLER noise fraction than Cinder's 7%, and deliberately:
 * there is no wind and no water here, so there is nothing that makes
 * broad-scale relief on this body EXCEPT impacts. The undulation that is left
 * is regolith drape and slumped ejecta, and it should not look like dunes.
 *
 * ── A sixth of a g, and what it now does ─────────────────────────────────
 * `gravity: 1.62` is published on the world and BOTH consumers read it, through
 * the one predicate in `WorldRules.worldGravity`. `Piloting._env` hands the
 * flight model `(0, -1.62, 0)` with `dragMul: 1.35`, so a hull settles onto this
 * moon at a sixth of the weight it settles onto Cinder with - and the pilot who
 * steps out of it now does too. `Player.setWorldGravity` converts 1.62 to a
 * ratio against `CONFIG.player.gravityReference` (9.81) and walks in -3.633
 * m/s², not the global -22.
 *
 * MEASURED here by driving the real controller, against a world that publishes
 * no gravity at all:
 *
 *     jump apex             1.668 m    (0.878 m)
 *     hang time             1.883 s    (0.533 s)
 *     20 m fall            12.00 m/s, 0 damage    (29.70 m/s, 49 damage)
 *     first drop that hurts 45.26 m    (7.49 m)
 *     first drop that kills 242.68 m   (40.06 m)
 *
 * The rule behind those numbers is that AIRTIME GROWS AS THE SQUARE OF JUMP
 * HEIGHT - 1.90x the apex for 3.53x the airtime - and that the mid-air Δv one
 * jump buys is held invariant, so a floaty jump here is a COMMITTED one and not
 * an easier one. Everything else that falls follows: a dive steepens by 0.727x
 * this moon's gravity rather than 4.4x it, the mantle will not take a ledge
 * under 1.823 m because a hop clears it, and the wildlife falls at -3.633
 * alongside the player. @see ../../player/Player.js `setWorldGravity`
 *
 * ── Why the crater walls are the numbers they are ────────────────────────
 * `scripts/tests/planet-minerals.test.mjs` floods the real colliders on a 2 m
 * lattice with a 38 deg ceiling, no jump and no mantle, and EXACTLY TWO of the
 * ten craters here are meant to beat it. Measured off the built collision
 * heightfield, sampling every wall on 72 bearings and excluding the ground a
 * younger crater or a road cut owns:
 *
 *   crater             median   p95    max    role
 *   Crown of Rays       39.0    53.4   63.6   gate; the Slump Road is the way in
 *   The Cold Well       51.6    62.0   64.6   gate; the second landing, only
 *   The Ghost Ring      19.0    38.3   44.0   walk in from anywhere
 *   Splinter A          20.8    32.0   35.9   texture
 *   Splinter B          19.1    29.9   33.4   texture
 *   The Notch           25.0    39.6   43.2   texture, but see below
 *   pock (-40,-300)     24.4    34.7   43.9   texture
 *   pock (215,-140)     18.5    31.9   37.0   texture
 *   pock (288,-68)      21.5    37.1   42.8   texture
 *   pock (55,268)       17.1    30.3   40.2   texture
 *
 * The wall angle is the SUM of two smoothstep derivatives - `craterAt` raises
 * the crest while it digs the bowl - so it is much steeper than
 * `depth * 1.5 / run` alone, and both terms have to be in the arithmetic. The
 * first version of this file used only the bowl term, authored the seven small
 * craters at depth/diameter 0.14, and measured 44-53 deg: seven traps. They are
 * now 0.10 with `floor: 0.18`, which is also the truthful shape - a simple
 * crater on a low-gravity body slumps, and a 100 m dent that has been gardened
 * for four billion years is a saucer.
 *
 * The three "texture" craters with a p95 or max over 38 are steep on ONE arc
 * each, where they sit on another feature's flank and the two gradients add;
 * the flood proves every one of their floors is walkable in and out anyway
 * (384-854 m from Mosaic Flat). They are still not gates. Nothing is placed
 * in any of them that has to be reached.
 *
 * ── Fog, on a world with no air ──────────────────────────────────────────
 * See `sky.fog`. The rule the other planets follow (fog LIGHTER and GREYER
 * than the ground, `far` about 1.1x the diagonal) is a rule about HAZE, and
 * there is none here. This world inverts it deliberately and says why.
 *
 * ── What was measured, on the built world ────────────────────────────────
 * Not a claim in this file is an estimate. Off the real `PlanetWorld` build,
 * the real collision heightfield and the real prop colliders:
 *
 *   finiteness      491,401 height samples at 1 m: 0 non-finite. The collider
 *                   heightfield: 0. Every mesh attribute and instance matrix in
 *                   the world: 0. This is the check that costs a day when it is
 *                   skipped - 19 NaN pixels once blacked out 921,600.
 *   placement       every seam and every prop field delivers 100% of what it
 *                   asks for. `scatter` reports a shortfall rather than padding,
 *                   and the pavement was cut from 380 to 355 because 380 was
 *                   asking for something the crescent could not hold.
 *   pad flatness    0.00 m of span across all three landing discs. The melt
 *                   sheet, which is a pad and not a landing site, is 0.03.
 *   reach           81 of 81 mineral nodes reachable from some pad; helion
 *                   reachable from exactly one of the three.
 *   standing room   91,715 of 123,201 lattice cells. The 26% that is not is the
 *                   two gate walls, the seven small crater walls and the rim
 *                   falloff - which is what a crater field is.
 *   census          131,212 triangles, 20 draw calls, 1,158 colliders.
 */

import { definePlanet } from './PlanetDescriptor.js';
import { ITEMS } from '../../systems/ItemDefs.js';
import { BODY_BY_ID } from '../space/Bodies.js';

/**
 * Credits per cubic metre of hold, read off the item catalogue.
 *
 * The price of an element belongs to the ELEMENT, not to the rock it is lying
 * in: a cubic metre of sperrylite is worth the same whether it came off this
 * moon or the next platinum-group body in the registry, and the vendor who
 * buys it reads `ITEMS`. Throwing on a missing row rather than returning
 * `undefined` is the difference between a loud boot failure and a planet whose
 * deposits are all worth NaN.
 *
 * @param {string} id an `ITEMS` id
 * @returns {number} credits per cubic metre
 */
const ORE = (id) => {
  const def = ITEMS[id];
  if (!def) throw new Error(`[Tessera] mineral names item "${id}", which has no ITEMS row`);
  return def.value;
};

/* ------------------------------------------------------------------ */
/* Frame of reference                                                  */
/* ------------------------------------------------------------------ */

/** Playfield half-extent. 700 m square. */
const HALF = 350;
/** The regolith datum. Everything is quoted against it. */
const PLAIN = 22;

const D2R = Math.PI / 180;

/* ---- Crown of Rays, and the polar frame its two routes live in ---- */
const CX = -120;
const CZ = -60;
/** Crater radius: the rim crest stands exactly here. */
const CROWN_R = 148;
/** Depth below the ground outside, and therefore the melt sheet's level. */
const CROWN_DEPTH = 54;
const MELT_Y = PLAIN - CROWN_DEPTH;   // -32
/** Ejecta crest above the plain, and how far outside `CROWN_R` it dies away. */
const CROWN_RIM = 17;
const CROWN_RIMW = 60;

/** A point at polar (d, bearing-in-degrees) about Crown of Rays' axis. */
const C = (d, deg) => [
  +(CX + d * Math.cos(deg * D2R)).toFixed(2),
  +(CZ + d * Math.sin(deg * D2R)).toFixed(2),
];

/* ---- The Ghost Ring ---------------------------------------------- */
const GX = 150;
const GZ = 95;
const GHOST_R = 158;

/** A point on the Ghost Ring's rim circle, at bearing `deg`. */
const G = (deg) => [
  +(GX + GHOST_R * Math.cos(deg * D2R)).toFixed(2),
  +(GZ + GHOST_R * Math.sin(deg * D2R)).toFixed(2),
];

/* ---- The Cold Well ------------------------------------------------ */
const WX = 196;
const WZ = 166;

/* ---- The Pale Bench ----------------------------------------------- */
const BX = -90;
const BZ = 200;
const BENCH_R = 52;
const BENCH_Y = PLAIN + 26;           // 48

/* ------------------------------------------------------------------ */
/* The two routes, and the one that is a decision                      */
/* ------------------------------------------------------------------ */

/**
 * Raysedge. Sits at d 160 on bearing 108, i.e. 12 m OUTSIDE the rim crest, so
 * its 20 m disc plus 18 m blend notches the crest rather than balancing on it.
 * Bearing 108 because that is the bearing Mosaic Flat lies on: a player who
 * walks rather than flies arrives at this point on the rim, and the road has to
 * start where they arrive.
 */
const RIM_PAD = C(160, 108);

/**
 * The Slump Road down the inner wall.
 *
 * It STARTS AT THE PAD CENTRE, and that is load-bearing rather than tidy. A
 * `ramp` with no explicit `y0` takes its head height from the pre-level field
 * at its first point - which is exactly the height the pad levels itself to,
 * because a `pad` with no explicit `y` does the same thing at the same place.
 * Start the road one metre away and the two resolve to different numbers and
 * the player steps off a riser they cannot see. (Cinder's `SPIRAL` records the
 * same reason; this is the second planet to depend on it.)
 *
 * 108 deg round to 300 deg - 192 deg, one partial turn, so no two legs share a
 * bearing and the turns cannot merge into a flattened cone. It descends 69.2 m
 * over 401 m of polyline. Measured on the built collision heightfield that is
 * 10.1 deg mean and 30.3 deg at its worst over any 2 m - comfortably inside the
 * 38 deg reach ceiling, on a wall whose own median is 39.
 *
 * It also swings toward the LIT half. The sun sits at bearing 208 in this
 * frame, so the inner wall at 108 (where the pad is) faces away from it and the
 * wall at 288 faces into it. The first third of the descent is therefore in the
 * near wall's shadow and the last third is in full sun, which is a thing to
 * look at as well as a route. The road SURFACE is near-horizontal the whole
 * way, so it takes the same grazing light as the plain wherever it is and never
 * goes black under the player's feet.
 */
const SLUMP = [
  RIM_PAD,
  C(150, 132),
  C(140, 158),
  C(128, 186),
  C(114, 214),
  C(98, 242),
  C(80, 270),
  C(52, 300),
];

/**
 * The surviving arc of the Ghost Ring's rim, bearing -100 to +5.
 *
 * A `ridge` and not a bigger `rim` on the crater record, because the whole
 * point is that the ring is HALF gone: the crater's own `rim` of 4.5 m is the
 * degraded lip that survives all the way round, and this adds 9 m more on the
 * northern and eastern third only. Bearing +5 is where it stops because at +27
 * the Cold Well's ejecta begins and by +57 the Cold Well's bowl has eaten the
 * rim circle outright - the arc would be authoring a crest through the middle
 * of a younger crater.
 */
const GHOST_ARC = [G(-100), G(-70), G(-45), G(-20), G(5)];

/**
 * THE BENCH STAIR, and it exists because the first version of this planet
 * shipped the exact defect this project keeps shipping.
 *
 * The Pale Bench is a 26 m plateau with a 28 m edge, which is a 54 deg face on
 * every bearing. Measured with the reach probe before this ramp existed:
 * anorthite 0 of 22 nodes reachable, from any of the three pads. An entire
 * rarity tier standing on a table with no way up - built, visible from Mosaic
 * Flat, and behind glass. The edge is not a mistake (an `outcrop` is
 * high ground WITH an edge, and a 68 m skirt gentle enough to walk from any
 * bearing would have made it a swell), so the fix is a route and not a softer
 * shape: Cinder's colonnade solved the same problem with a switchback up its
 * east face.
 *
 * 62 m of polyline for 26 m of rise - 22.7 deg, against a 38 deg ceiling. It
 * comes up the WEST face because that is the face Mosaic Flat is on, and it
 * stops at d 46 from the bench's axis, which is the outer edge of the anorthite
 * disc: far enough onto the table that there is no step at the top, not so far
 * that the road runs through the middle of the seam.
 */
const BENCH_STAIR = [[-196, 216], [-162, 206], [-136, 200]];

/* ------------------------------------------------------------------ */
/* The rays                                                            */
/* ------------------------------------------------------------------ */

/* Both start ON the rim crest of Crown of Rays - `C(CROWN_R, bearing)` - and
 * run outward, because a ray that does not start at the crater it came out of
 * is a streak of gravel. */
const RAY_NE = [C(CROWN_R, -20), [140, -152], [258, -196], [341, -228]];
const RAY_S = [C(CROWN_R, 66), [10, 190], [70, 330]];

/**
 * THE RAY CORRIDORS, DECLARED ONCE AND USED TWICE.
 *
 * These two records are the region the bright chips are scattered in AND the
 * region the ground under them is painted in - the same object, not a copy.
 * That is the entire reason `palette.patch` takes a region record rather than a
 * shape of its own: a ray is one place, and a streak of albedo whose corridor
 * had drifted four metres from the corridor the debris was in would be a bright
 * band with gravel alongside it.
 *
 * `clearOfPads` is honoured by the scatter and ignored by the palette, and that
 * asymmetry is deliberate and stated in the schema: nothing should be DROPPED
 * where a ship comes down, but a ray that stopped short of the pad it runs past
 * would have a hole punched in it.
 */
const RAY_NE_REGION = { shape: 'corridor', pts: RAY_NE, width: 22, slopeMaxDeg: 26, clearOfPads: 4 };
const RAY_S_REGION = { shape: 'corridor', pts: RAY_S, width: 20, slopeMaxDeg: 26, clearOfPads: 4 };

/* ------------------------------------------------------------------ */
/* The sky, derived rather than typed                                  */
/* ------------------------------------------------------------------ */

/**
 * Angular RADIUS of a body seen from Tessera, radians.
 *
 * Two copies of one fact is one copy too many, and the second goes stale the
 * day a body moves. `Bodies.js` imports no `three` and holds nothing but plain
 * data, so reading it here is safe and it is the only way these numbers cannot
 * drift from the sky the player just flew through.
 *
 * (Only the SIZE is derivable. A planet surface is a local tangent patch with
 * no authored orientation against the system frame, so the DIRECTIONS below are
 * chosen, not computed, and are stated as choices.)
 */
const angularRadius = (id) => {
  const a = BODY_BY_ID.tessera;
  const b = BODY_BY_ID[id];
  if (!a || !b) throw new Error(`[Tessera] sky wants body "${id}", which is not in Bodies.js`);
  const d = Math.hypot(
    a.position[0] - b.position[0],
    a.position[1] - b.position[1],
    a.position[2] - b.position[2]
  );
  return Math.asin(b.radius / d);
};

/** Erenmark from here: 622 km, 15.5 km radius -> 1.43 deg of radius. */
const ERENMARK_ANG = +angularRadius('erenmark').toFixed(6);
/** Ceraunus from here: 274 km, 38 km radius -> 7.98 deg of radius, 16 across. */
const CERAUNUS_ANG = +angularRadius('ceraunus').toFixed(6);

/**
 * The key light's direction, and the elevation is the whole look of the world.
 *
 * 18.5 degrees up. Chosen against three things at once and it is the only
 * number here that all three pull on:
 *
 *  1. THE HERO FRAMING. Its horizontal component is (-0.84, 0.45), which is
 *     behind and to the left of a player standing on Mosaic Flat looking at
 *     Crown of Rays (dot -0.78). Cinder learned this the expensive way: the
 *     first pass put the sun behind the mountain and the hero silhouette was a
 *     black cut-out. A planet is looked at from its landing sites.
 *  2. THE COLD WELL STAYS COLD. 63 m of relief from the Cold Well's crest to
 *     its floor casts 63/tan(18.5) = 188 m of shadow across a 192 m floor -
 *     98% of it, at any hour, which is what "permanently shadowed" has to mean
 *     geometrically. See `helion` for what the RENDERER actually does about it,
 *     which is not the same thing.
 *  3. THE PLAIN IS NOT A DARK ROOM. Flat ground takes sin(18.5) = 0.317 of the
 *     key, so 0.317 * 7.6 + 0.11 ambient = 2.52 against Cinder's 3.98 - but
 *     this regolith's mid band is L 48% against Cinder's L 33%, so the plain
 *     resolves about where Cinder's does. Any lower and the 0.317 collapses and
 *     the whole moon goes to the "big dark room" this project has been rejected
 *     for once already.
 */
const SUN_DIR = [-0.84, 0.32, 0.45];

/* ------------------------------------------------------------------ */
/* The descriptor                                                      */
/* ------------------------------------------------------------------ */

export const TESSERA = definePlanet({
  id: 'tessera',
  name: 'Tessera',
  blurb: 'An airless moonlet in a crater field. Black sky at noon, shadows with nothing in them, and helion ice on a floor the sun has never reached.',

  half: HALF,
  /**
   * 224 segments over 700 m: a 3.125 m cell, the same cell size as Cinder.
   *
   * The mesh and the collision heightfield are the SAME grid, so this number
   * buys both the silhouette and the surface the player stands on. It is also
   * the resolution a 53 deg crater wall is expressed at, and the reach probe
   * measures slope over the collision cell rather than analytically for exactly
   * that reason - a wall that exists only between two samples is a wall the
   * capsule solver has never heard of.
   */
  seg: 224,

  /** 0.165 g. Consumed by the SHIP and not by the player - see the header. */
  gravity: 1.62,

  /* ---------------------------------------------------------------- */
  terrain: {
    seed: 0x7e55e4,
    baseY: PLAIN,
    /** Regolith drape. 155 m wavelength and only 4.2 m of it: this is the
     *  gardened surface between craters, not a landscape in its own right. */
    swell: { amp: 4.2, scale: 155, octaves: 4 },
    /** Slumped ejecta at the scale of a hundred metres' walk. Ridged, so the
     *  micro-relief has crests rather than blobs - but a THIRD of Cinder's
     *  amplitude, because there is no wind here to build a dune. */
    ripple: { amp: 1.1, scale: 27, octaves: 3 },
    /** Grain, at the scale of a footfall. Keeps the normals off glassy. */
    grain: { amp: 0.26, scale: 19 },
    /**
     * THE EDGE OF THE MAP, and on this planet it is doing the work fog does
     * everywhere else.
     *
     * 30 m over the last 50 m. There is no haze to hide the mesh's edge with
     * (see `sky.fog`), so the ground has to fall out from under the horizon
     * instead: past 300 m the surface drops away and what fills the gap is the
     * star dome, which is exactly what standing near the limb of a 4.2 km
     * moonlet should look like.
     */
    rim: { start: 300, drop: 30 },

    landforms: [
      /* ---- ADD ---------------------------------------------------- */
      /**
       * The Pale Bench. Absolute, so its top is a table and not a swell -
       * `plateau` is a LEVEL in disguise and adding one to a 4.2 m swell would
       * give a tilted table with anorthite sliding off it.
       *
       * Sited at 262 m from Crown of Rays' axis and 262 m from the Ghost
       * Ring's, which are the two smallest numbers that keep its 80 m outer
       * edge clear of both bowls (148 + 80 and 158 + 80). Inside either one and
       * the CUT layer would dig 54 m out of the middle of the plateau
       * afterwards and leave a shelf hanging on a crater wall.
       */
      { kind: 'plateau', x: BX, z: BZ, r: BENCH_R, y: BENCH_Y, edge: 28 },

      /** The Ghost Ring's surviving arc. Height 9 on top of the crater's own
       *  4.5 m lip, so the east crest stands 13.5 and the west stands 4.5. */
      { kind: 'ridge', pts: GHOST_ARC, width: 30, height: 9, taper: 0.30 },

      /* ---- CUT ---------------------------------------------------- *
       * Ten craters. `crater` is not a subtraction - `craterAt` returns
       * rim-minus-bowl as one signed delta and the pass ADDS it - so where two
       * of these overlap, the younger one's bowl eats the older one's crest in
       * the same pass that raises its own. That is the only reason a crater
       * field composes at all, and it is why four of the ten are deliberately
       * placed to cut or lap another.                                        */

      /** CROWN OF RAYS. The young one, and the silhouette from Mosaic Flat.
       *
       * `floor: 0.40` puts the flat bottom at r 59 and leaves 89 m of wall for
       * 54 m of drop. Measured against both smoothstep terms that peaks at 52
       * deg near d 110, which is a scarp - the Slump Road is the only way in
       * and the reach probe is what proves it. */
      {
        kind: 'crater',
        x: CX, z: CZ, r: CROWN_R,
        depth: CROWN_DEPTH, floor: 0.40,
        rim: CROWN_RIM, rimWidth: CROWN_RIMW,
      },

      /** THE GHOST RING. Bigger, a fifth as deep, and old.
       *
       * `depth: 14` over a 71 m wall is 22 deg at its peak: you walk into this
       * one from any bearing, which is the whole contrast with Crown of Rays.
       * `rim: 4.5` is a lip and not a crest - the crest that survives is the
       * `ridge` above, on one third of the circle. */
      {
        kind: 'crater',
        x: GX, z: GZ, r: GHOST_R,
        depth: 14, floor: 0.55,
        rim: 4.5, rimWidth: 66,
      },

      /** THE COLD WELL. Young, deep, small, and inside the old one.
       *
       * Centred 85 m from the Ghost Ring's axis, so its 130 m outer edge
       * reaches 215 m out - 57 m past the Ghost Ring's own rim circle. That is
       * what destroys the old rim from bearing +27 to +87 and it is the
       * clearest statement of relative age on the map.
       *
       * 52 m of depth over a 60 m wall measures 52 deg median and 62 at p95 on
       * the built heightfield, on every one of 72 bearings, with nothing under
       * 38 anywhere on it. Nothing walks in and
       * nothing walks out, at any bearing, and that is not a side effect: it is
       * the mechanism that makes the exotic tier a second LANDING rather than a
       * longer walk. */
      {
        kind: 'crater',
        x: WX, z: WZ, r: 96,
        depth: 52, floor: 0.38,
        rim: 11, rimWidth: 34,
      },

      /* ---- and seven degraded ones -------------------------------- *
       * EVERY ONE OF THESE IS DELIBERATELY SHALLOW, and the first version of
       * this file got it wrong. They were authored at a depth/diameter of 0.14
       * with `floor: 0.34`, which reads as a reasonable crater and measures as
       * a 44-53 deg wall - seven traps. `craterAt`'s wall angle is the SUM of
       * two smoothstep derivatives (the crest rises while the bowl digs), so it
       * is far steeper than `depth * 1.5 / run` alone, and a short `floor`
       * fraction shortens the run that has to absorb both.
       *
       * They are now depth/diameter 0.10 with `floor: 0.18` - a long run, a
       * shallow bowl - which measures at 30-31 deg and walks. That is also the
       * truthful shape: a simple crater on a low-gravity body slumps, and after
       * four billion years of gardening a 100 m dent is a saucer. Exactly TWO
       * craters on this planet are gates, and both of them are young.        */

      /** SPLINTER A and B. Two mediums 82 m apart with radii 60 and 42, so
       *  their bowls overlap by 20 m and B is plainly the younger. */
      { kind: 'crater', x: 75, z: -215, r: 60, depth: 12, floor: 0.18, rim: 4.5, rimWidth: 33 },
      { kind: 'crater', x: 138, z: -268, r: 42, depth: 8, floor: 0.18, rim: 3.0, rimWidth: 23 },

      /** THE NOTCH, tangent on Crown of Rays' rim at 192 m from its axis
       *  (148 + 44 exactly), so its ejecta laps 20 m over the older crest
       *  without cutting the bowl - a rim on a rim, and no new way in. */
      { kind: 'crater', x: -30, z: -230, r: 44, depth: 9, floor: 0.18, rim: 3.2, rimWidth: 24 },

      /** And four more, for a field rather than four landmarks. The first
       *  overlaps the Notch by 19 m; the rest are texture. */
      { kind: 'crater', x: -40, z: -300, r: 46, depth: 9, floor: 0.18, rim: 3.2, rimWidth: 25 },
      { kind: 'crater', x: 215, z: -140, r: 54, depth: 11, floor: 0.18, rim: 4.0, rimWidth: 30 },
      { kind: 'crater', x: 288, z: -68, r: 46, depth: 9, floor: 0.18, rim: 3.2, rimWidth: 25 },
      { kind: 'crater', x: 55, z: 268, r: 50, depth: 10, floor: 0.18, rim: 3.6, rimWidth: 27 },

      /* ---- LEVEL -------------------------------------------------- *
       * ROADS FIRST, PADS LAST. Cinder measured what the other order costs:
       * the road leaves the pad centre descending, so inside a 20 m disc it has
       * already taken metres off, and the "landing pad" has a fall across it.
       * With the pad last its disc wins outright and the road emerges from the
       * pad EDGE, where the pad's blend hands over to the road's own grade with
       * no step. Cinder's rim pad: 3.00 m of span before, 0.00 m after.       */

      /** The Slump Road. `y1` is the melt sheet's own level, not the noisy
       *  floor beside it, so the road's toe and the pad it runs onto resolve to
       *  the same number by construction rather than by luck. */
      { kind: 'ramp', pts: SLUMP, width: 8, blend: 15, y1: MELT_Y },

      /** The Bench Stair. `y1` is the plateau's own absolute height, for the
       *  same reason: the plateau is a LEVEL and the road has to end at the
       *  number the level holds, not at the number the noise happens to give
       *  under the last point. */
      { kind: 'ramp', pts: BENCH_STAIR, width: 7, blend: 12, y1: BENCH_Y },

      /**
       * THE MELT SHEET. A `pad`, not a `basin`, and the difference is the same
       * one Cinder recorded for its lakes: a basin is a DELTA and inherits
       * every metre of the swell underneath it, and a pad is a LEVEL and is
       * flat by construction. An impact melt pond froze level. The floor
       * OUTSIDE it did not, and the 26 m blend is where the one becomes the
       * other.
       *
       * r 52 against the crater's own 59 m flat bottom, so the pond sits inside
       * the floor rather than climbing the wall.
       */
      { kind: 'pad', x: CX, z: CZ, r: 52, blend: 26, y: MELT_Y },

      /* The three landing pads, last of all.
       *
       * EACH ONE IS 4 m WIDER THAN THE LANDING SITE IT CARRIES, and that is a
       * measurement rather than a margin of comfort. `definePlanet` requires
       * `pad.r >= site.r` and equality satisfies it, but the collision
       * heightfield samples on a 3.125 m grid and interpolates between samples:
       * with the two radii equal, the cells just outside the disc are already
       * on the blend, and bilinear interpolation drags the rim of the landing
       * circle down with them. Measured at equal radii: 0.02 m of span on
       * Mosaic Flat, 0.08 on the Cold Well and 0.13 on Raysedge. One cell of
       * slack puts all three at 0.00. */
      { kind: 'pad', x: -250, z: 200, r: 34, blend: 24 },
      { kind: 'pad', x: RIM_PAD[0], z: RIM_PAD[1], r: 24, blend: 18 },
      { kind: 'pad', x: WX, z: WZ, r: 22, blend: 10 },
    ],
  },

  /* ---------------------------------------------------------------- */
  palette: {
    /** Regolith is powdered rock, and every other ground material in the
     *  library (`concrete.road`, `stone.cobble`, `asphalt.court`) prints a
     *  man-made regularity, of which there is none on this moon. That argument
     *  chose `dirt.ground` and stopped one step short: `dirt.ground` is not
     *  neutral powdered rock, it is powdered rock through a measured linear
     *  R:G:B of 1.79 : 1 : 0.49, and vertex bands multiply into that. The three
     *  materials the note below says are underfoot here - warm nanophase iron,
     *  COOL blue-grey bedrock, CREAM anorthosite - were being run through a
     *  brown filter that erases exactly the two cold ones. `rock.neutral` is
     *  the identical grain (same noise walk, bit-identical normals) with the
     *  albedo replaced by its own luminance. @see shadeRockNeutral. */
    material: 'rock.neutral',
    /** 4.5 m a tile against Cinder's 6.0. Finer grain, because this surface is
     *  flour and that one is clinker. */
    tile: 4.5,
    /**
     * ══════════════════════════════════════════════════════════════════════
     *  A GREY WORLD IS THE HARDEST CASE OF THE RULE, NOT AN EXEMPTION FROM IT
     * ══════════════════════════════════════════════════════════════════════
     *
     * Cinder shipped six bands across FIVE degrees of hue and zero saturation
     * change, and the tester's verdict was "one flat salmon-brown hue". A grey
     * moon is where that failure is easiest to repeat and hardest to notice,
     * because grey is what it is supposed to be.
     *
     * It is also not what a real airless surface is. Three separate materials
     * are underfoot here and none of them is neutral:
     *
     *   - space-weathered fill: nanophase iron, and it is WARM BROWN.
     *   - fresh bedrock and crater wall: unweathered, and it is COOL BLUE-GREY.
     *   - highland feldspar: anorthosite, and it is CREAM.
     *
     * So the table keeps a monotonic value structure (dark low, bright high,
     * which is what makes the Pale Bench and the rim crests read as silhouettes
     * from the flat) and spends everything else on ALTERNATING hue:
     *
     *   height   colour     hue    sat    lightness   what it is
     *   y -30    #272d38    219     18      19        the shadowed deep floors
     *   y  -6    #4b3f33     30     19      25        weathered basin fill
     *   y  14    #596270    217     11      39        the low flats
     *   y  26    #8d8069     38     15      48        the regolith plain
     *   y  40    #a8a6a4     30      1      65        fresh rim material
     *   y  62    #d9d3c0     46     25      80        the anorthosite bench
     *
     * 219 degrees of hue against Cinder's five, and 24 points of saturation
     * against zero. The cool bands are what make the warm ones read as DUST
     * rather than as grey, and the near-neutral band at y 40 is what makes both
     * of its neighbours read as coloured at all.
     */
    bands: [
      { upTo: -30, color: 0x272d38 },
      { upTo: -6, color: 0x4b3f33 },
      { upTo: 14, color: 0x596270 },
      { upTo: 26, color: 0x8d8069 },
      { upTo: 40, color: 0xa8a6a4 },
      { upTo: 62, color: 0xd9d3c0 },
    ],
    /** Bare bedrock on anything steep. On this planet that is precisely the two
     *  walls nothing can walk - Crown of Rays at 40-52 and the Cold Well at 56
     *  - so the colour is also the warning. Cold and dark: unweathered rock has
     *  not had four billion years of solar wind to redden it. */
    slope: { fromDeg: 30, toDeg: 52, color: 0x353a44 },
    /** Mare-and-highland patchiness, so the bands do not print as a contour
     *  map. 88 m: a couple of these across the walk from Mosaic Flat to the
     *  Pale Bench. Cool, so it fights the warm plain band rather than tinting
     *  it - the term is applied as `n * n * amount`, so most of the field never
     *  gets near the ceiling. */
    mottle: { scale: 88, amount: 0.58, color: 0x5a6270 },
    /**
     * ══════════════════════════════════════════════════════════════════════
     *  THE RAYS, AS ALBEDO - which is the thing the crater is named for
     * ══════════════════════════════════════════════════════════════════════
     *
     * Crown of Rays had rays made of gravel and no rays made of light, because
     * until `palette.patch` existed there was no way to say "this streak is
     * brighter" without saying it about every contour at the same height on the
     * map. From the crater rim the two streaks now run away to the north-east
     * and to the south across the plain, which is the ONE view this feature is
     * named for and the one it did not have.
     *
     * The regions are `RAY_NE_REGION` and `RAY_S_REGION`, the same objects the
     * chip fields are scattered in - see the note where they are declared.
     *
     * FOUR RECORDS FOR TWO RAYS. A real ray fades along its length: a blaze at
     * the crater, a smudge at the tip. Patches accumulate in declaration order,
     * so each ray is its full corridor at moderate strength with a narrower,
     * brighter inner section laid over it - a fade built out of the vocabulary
     * rather than a gradient term bolted onto it.
     *
     * The colours are the chip tints (0xc9c6bc .. 0xe6e2d4) pulled slightly
     * toward the ground, so the plates still read as plates lying ON the streak
     * rather than as the streak itself.
     *
     * MEASURED OFF THE BUILT MESH, in linear luma, sampled on the corridor and
     * 60 m to the side of it: the north-east ray reads about 0.50 against 0.29
     * and the south ray 0.52 against 0.13.
     *
     * THE CEILING IS THE ANORTHOSITE BAND, 0xd9d3c0 at 0.651, and no patch
     * colour here goes over it. The Pale Bench is supposed to stay the one
     * thing on this surface that is not a hole or the rubble from one, and a
     * ray painted brighter than the brightest rock on the moon would take that
     * away. The fade from tip to crater is therefore bought with STRENGTH -
     * 0.52 over the full corridor, 0.62 over the inner half - rather than by
     * reaching for a brighter colour the table does not have.
     *
     * `grain` is high (0.42-0.52) on every one of them. A ray is thrown
     * material and it lands in blotches; a corridor filled evenly with one
     * colour reads as a painted road, which is the failure mode this term has
     * and the reason the breakup is not optional here.
     */
    patch: [
      /**
       * THE CONTINUOUS EJECTA BLANKET, and it is here because of what the
       * screenshots showed rather than because the brief asked for it.
       *
       * The two rays came out measurably brighter than the ground - 0.50 of
       * linear luma against 0.29 on the built mesh - and still read weakly from
       * a standing eye, for a reason that is nothing to do with the palette:
       * this world's key is 7.6 at 18.6 degrees of elevation with an ambient of
       * 0.11, so flat ground receives sin(18.6) = 0.32 of it and every albedo
       * difference is scaled by that before it reaches the eye. Two 22 m lanes
       * cannot carry a crater on their own at that light level.
       *
       * What a young crater actually has, and what this adds, is the thing the
       * rays are the outliers OF: a bright apron of fines all the way round,
       * from the rim crest out. It is a wash at strength 0.34 with heavy
       * breakup - loud enough to make the crater read as a bright feature from
       * Mosaic Flat, quiet enough that the two rays are still the streaks.
       *
       * It stops at y 34, BELOW the 39 m rim crest, so it lies on the plain
       * outside the crest rather than painting the crest and the Raysedge pad
       * on top of it - which is where a continuous blanket is anyway. And its
       * outer edge at 250 m clears the Pale Bench (262 m away) and the Ghost
       * Ring (311 m), so it laps neither.
       */
      {
        id: 'crown_blanket',
        region: { shape: 'annulus', x: CX, z: CZ, r0: 146, r1: 250, slopeMaxDeg: 30, yMax: 34 },
        color: 0xb8b4a6, strength: 0.34, feather: 34, grain: 0.55, grainScale: 42,
      },
      {
        id: 'ray_ne_albedo',
        region: RAY_NE_REGION,
        color: 0xcdc9ba, strength: 0.52, feather: 13, grain: 0.44, grainScale: 27,
      },
      {
        /* The inner 3 of 4 stations - 200 m of the 346. Narrower as well as
         * brighter, because the debris lane tightens toward the crater. */
        id: 'ray_ne_core',
        region: { shape: 'corridor', pts: RAY_NE.slice(0, 3), width: 14, slopeMaxDeg: 26 },
        color: 0xd2cec0, strength: 0.62, feather: 9, grain: 0.36, grainScale: 18,
      },
      {
        id: 'ray_s_albedo',
        region: RAY_S_REGION,
        color: 0xcdc9ba, strength: 0.52, feather: 12, grain: 0.44, grainScale: 27,
      },
      {
        id: 'ray_s_core',
        region: { shape: 'corridor', pts: RAY_S.slice(0, 2), width: 13, slopeMaxDeg: 26 },
        color: 0xd2cec0, strength: 0.60, feather: 9, grain: 0.36, grainScale: 18,
      },
    ],
  },

  sky: {
    kind: 'space',
    params: {
      /**
       * A BLACK SKY AT NOON. This is the entire reason to fly here, and it is
       * the `space` dome doing it rather than any parameter: the same starfield
       * shader the player crossed to arrive, standing over their head while
       * their own shadow is on the ground in front of them.
       */
      sunDirection: SUN_DIR,
      /** Erenmark is an orange dwarf (`Bodies.js` gives its core 0xfff2d8 and
       *  its limb 0xff9c3a) and there is no air to redden or dim it further. */
      sunColor: 0xffeeda,
      /** DERIVED. 0.0249 rad = 1.43 deg of radius, 2.9 deg across - about
       *  eleven times the sun Earth has, because Erenmark is close. This is the
       *  DISC in the sky; the directional light below is a point source and
       *  this number does not soften its terminator. */
      sunSize: ERENMARK_ANG,
      /** The stars have to survive the daylight, which on this world means
       *  surviving the tone map rather than surviving any air. */
      starBrightness: 1.35,
      /* Enough nebula to give the black some structure and not enough to make
       * it a poster. The point of this sky is that it is EMPTY. */
      nebulaA: 0x1b1430,
      nebulaB: 0x0b2a3e,
      nebulaC: 0x4a1c3c,
      nebulaDensity: 0.30,
      galaxyAxis: [0.31, 0.90, -0.30],
      galaxyStrength: 0.14,
      /**
       * CERAUNUS, and it is 16 degrees across from here.
       *
       * `planetAngularRadius` is DERIVED from `Bodies.js` (274 km away, 38 km
       * radius). The direction is not derivable - a planet surface is a local
       * tangent patch with no authored orientation against the system frame -
       * so it is chosen, and it is chosen opposite the sun so the gas giant
       * hangs over the player's shoulder rather than competing with the star.
       *
       * WHAT IS NOT DRAWN: the ring system. `Sky.js`'s space shader has no ring
       * geometry, so `Bodies.js`'s 1.42-2.28 annulus with its Cassini gap is
       * simply absent up there. The globe reads; the rings do not. Lathe is the
       * planet that has to solve that, and it is not this one.
       */
      planetDirection: [-0.45, 0.38, 0.81],
      planetAngularRadius: CERAUNUS_ANG,
      planetLand: 0xc8a276,
      planetOcean: 0x7a5638,
      planetAtmosphere: 0xe6c79a,
      planetSpinSpeed: 0.0022,
      /**
       * NO SECOND MOON, and this is an off switch rather than an oversight.
       *
       * `Sky.js`'s `moon()` opens with `if (dot(dir, md) <= 0.0 || ang <= 0.0)
       * return vec3(0.0)`, so zero here is a checked early-out and never
       * reaches the `sin(ang)` below it. Left at the preset's 0.055 there would
       * be an unexplained grey moonlet in the sky that corresponds to no body
       * in `Bodies.js`, and the shader draws that moonlet off-white with no
       * colour uniform - which is right for a body like Tessera itself and
       * wrong for Cinder, Vitrine or anything else actually in this system.
       */
      moonDirection: [0.28, 0.46, -0.84],
      moonAngularRadius: 0,
      exposure: 1.0,
    },
    background: 0x03040a,
    /**
     * ── FOG IN A VACUUM: the exception, stated ────────────────────────────
     *
     * The rule every other planet follows is that fog is LIGHTER and GREYER
     * than the ground under it and `far` is about 1.1x the playfield diagonal.
     * That rule is about HAZE - a medium between the eye and the rock - and it
     * exists because Cinder's first fog was darker and more saturated than its
     * basalt and deleted the horizon.
     *
     * There is no medium here. Distant ground on an airless body is not paler,
     * not bluer and not softer; it is exactly as sharp as near ground, right up
     * to the limb. So:
     *
     *   colour   0x05070e, which is the sky, not the rock. Greyer than the
     *            ground (S 30% at L 4%) and far DARKER, which inverts half the
     *            rule on purpose: what the extinction is standing in for is not
     *            air, it is the ground running out.
     *   near 420 The playfield's half-width is 350, so nothing in the middle
     *            distance is touched at all. Walk to the far corner (990 m) and
     *            the fog factor is 0.16 - a sixth of the way to black at the
     *            very edge and nothing anywhere else.
     *   far 3960 About 4x the 990 m diagonal. It is deliberately past
     *            `CONFIG.render.far` (2000), which is the one place this planet
     *            breaks a number `planet-atmosphere.test.mjs` asserts for
     *            Cinder. That ceiling exists so terrain does not pop at the
     *            clip plane; here the furthest ground from any legal camera
     *            position is about 1,024 m, so the clip is twice as far away as
     *            anything drawn and the defect the ceiling guards against
     *            cannot occur. `SpaceWorld` makes the same call for the same
     *            reason and parks its fog at 6,000..60,000.
     *
     * The map's edge is hidden by `terrain.rim` instead - the ground falls 30 m
     * away over the last 50 m and the star dome fills the gap. The world
     * dissolves into the starfield rather than into soup.
     */
    fog: { color: 0x05070e, near: 420, far: 3960 },
    /**
     * ── AMBIENT 0.11, AND THAT IS THE WHOLE PLANET ────────────────────────
     *
     * Cinder runs 0.46 of warm fill and defends it: bounce off a lava lake is
     * real. There is no lake here, no sky to scatter and no air to fill a
     * shadow with, and the only fill in vacuum is starlight and the light the
     * regolith bounces off itself. 0.11, cool, and it exists so that a face
     * turned away from the sun is a SHAPE rather than a hole - a true zero
     * would be more accurate and would render the unlit half of every boulder
     * as a black cut-out with no silhouette inside it.
     *
     * The difference went into the key, and the arithmetic is the point:
     *
     *   world     ambient   key    lit face   unlit face   ratio
     *   Cinder      0.46     6.4      6.86        0.46       15:1
     *   Tessera     0.11     7.6      7.71        0.11       70:1
     *
     * The total on a face turned TO the sun barely moves, which is what keeps
     * the exposure sane. The face turned AWAY becomes a different value by a
     * factor of four and a half against Cinder, and THAT difference is what a
     * terminator is.
     *
     * The key is also 19% higher than Cinder's, and it is not a taste call:
     * Tessera sits 622 km from Erenmark and Cinder 697 km, so this moon takes
     * (697/622)^2 = 1.254x the irradiance before any atmospheric extinction is
     * counted. Both distances come out of the same two `Bodies.js` entries
     * `sunSize` above is derived from.
     */
    ambient: { color: 0x2b3444, intensity: 0.11 },
    sun: { color: 0xffeeda, intensity: 7.6, direction: SUN_DIR },
    /** No air to scatter and no dust to lift the black, so the frame's mean
     *  luminance is carried by the lit ground alone. 1.0 rather than Cinder's
     *  1.22: this regolith is a mid-grey and that basalt is nearly black. */
    exposure: 1.0,
    /**
     * The environment map on this world is a black starfield, so its
     * contribution is near zero already; 0.35 makes sure that stays true rather
     * than relying on it. An IBL term that quietly fills shadows is the same
     * defect as an ambient that does, one indirection further away.
     */
    envMapIntensity: 0.35,
    /**
     * The SPACE grade, not the dock's. It is the one preset in `GRADE_PRESETS`
     * calibrated against a black field: cold shadow tint (0.74, 0.88, 1.18), a
     * 1.60 bloom threshold low enough that the star disc and the helion glow
     * bloom while lit regolith at ~2.5 does not, and `haze: 0.0`, which is the
     * only preset that does not add a depth wash this planet must not have.
     */
    grade: 'space',
  },

  /* ---------------------------------------------------------------- *
   * NO `liquid` BLOCK. There is nothing on this moon that is liquid at any
   * temperature it ever reaches, and the helion is ICE - held in a crater floor
   * that has not seen the sun since the crater was made, which is exactly why
   * it is still there. `PlanetWorld` takes `liquid: null` and skips the whole
   * surface, skirt and glow-light path, so this is one fewer draw call and one
   * fewer of the twelve point lights in `RIG_BUDGET`.                        */

  /* ---------------------------------------------------------------- */
  props: [
    {
      /* The ejecta blanket: the whole moon is one. Dark, half-buried and
       * everywhere, so the plain has a scale to it at every distance. */
      id: 'ejecta',
      kind: 'boulders',
      region: { shape: 'field', slopeMaxDeg: 30, clearOfPads: 5 },
      count: 620, spacing: 8,
      size: { rMin: 0.5, rMax: 2.8 },
      tint: [0x4a4a52, 0x3a3a40, 0x565a62, 0x2e2e34],
      collide: true,
    },
    {
      /* Rim blocks: the big, bright, unweathered stuff thrown up on the crest
       * of the young crater. Brighter than the ejecta field because it is
       * FRESH - four billion years of solar wind is what makes the rest dark,
       * and this has not had it.
       *
       * spacing 8 against a 3.4 m maximum radius, NOT 6. `boulders` scales to
       * `r * 1.3` on its widest axis, so at 6 m two neighbours at full size
       * leave 0.8 m between their collider faces - which is the Cinder
       * colonnade defect exactly, a field with ore behind glass in it. 8 m
       * leaves 3.6 m of lane at the worst case and 6-7 m typically. */
      id: 'rimblocks',
      kind: 'boulders',
      region: { shape: 'annulus', x: CX, z: CZ, r0: 140, r1: 204, slopeMaxDeg: 26, clearOfPads: 4 },
      count: 170, spacing: 8,
      size: { rMin: 0.8, rMax: 3.4 },
      tint: [0x9a968e, 0x87847e, 0xaba79c, 0x6f6d68],
      collide: true,
    },
    {
      /* THE PAVEMENT, and the reason the moon has the name it has. A `tessera`
       * is a mosaic tile, and the Ghost Ring's floor is a plain of them:
       * bedrock plates levered up and tipped by the impact that made the ring
       * and never touched since by anything that could lay them flat again.
       *
       * `slabs` is a BOX, and honestly so - the "made of square blocks"
       * rejection is about organic and crystalline forms, and a shattered plate
       * genuinely is a flat sheet. What stops a field of them reading as a
       * floor is the per-instance tilt, yaw and thickness plus the jittered
       * corners `PlanetProps` builds into the geometry.
       *
       * `yMin: -4` keeps it out of the Cold Well, whose floor is at -44: the
       * disc reaches over the young crater and the pavement must not, because
       * a plate field is what an OLD surface looks like. */
      id: 'pavement',
      kind: 'slabs',
      region: { shape: 'disc', x: GX, z: GZ, r: 122, yMin: -4, yMax: 26, slopeMaxDeg: 14, clearOfPads: 4 },
      count: 355, spacing: 6,
      size: { w: [1.0, 3.0], d: [0.8, 2.6], t: [0.20, 0.60], tilt: 0.50 },
      tint: [0x6d7480, 0x5b616c, 0x7d8390, 0x4c515a],
      collide: true,
    },
    {
      /**
       * A RAY IS PROPS *AND* ALBEDO, AND IT USED TO BE ONLY THE FIRST.
       *
       * A ray system has essentially no relief: it is a streak of bright
       * pulverised rock lying on top of darker weathered ground. Faking the
       * brightness with a `ridge` would author a metre of height that is not
       * there, and `mottle` is isotropic, so for as long as `palette` was
       * height plus slope plus one global noise the only honest thing to build
       * was the debris itself - bright chips, thin, at a shallow tilt, in a
       * corridor that starts ON the rim crest.
       *
       * That was right and it was half the feature. The other half - the ALBEDO
       * STREAK, which is what a ray actually reads as from the rim - is now
       * `palette.patch`, and it uses `RAY_NE_REGION` and `RAY_S_REGION`: the
       * SAME two records these fields are scattered in. Chips on bright ground,
       * one corridor each.
       *
       * `collide: false` stands - they are centimetres of plate and a body
       * walks over them, and 360 more colliders across the two main walking
       * routes would be a tax for nothing.
       */
      id: 'ray_ne',
      kind: 'slabs',
      region: RAY_NE_REGION,
      count: 200, spacing: 6,
      size: { w: [0.8, 2.4], d: [0.6, 2.0], t: [0.15, 0.45], tilt: 0.35 },
      tint: [0xc9c6bc, 0xdcd8cc, 0xb4b1a8, 0xe6e2d4],
      collide: false,
    },
    {
      /* The south ray, threading the corridor between the Pale Bench and the
       * Ghost Ring so it crosses neither: 96 m clear of the bench's edge and
       * 11 m outside the ring's bowl at the nearest station. Two rays and not
       * six, because five prop families is already the draw-call budget Cinder
       * set and a ray you cannot see the crater at the end of is a gravel path. */
      id: 'ray_s',
      kind: 'slabs',
      region: RAY_S_REGION,
      count: 160, spacing: 6,
      size: { w: [0.8, 2.4], d: [0.6, 2.0], t: [0.15, 0.45], tilt: 0.35 },
      tint: [0xc9c6bc, 0xdcd8cc, 0xb4b1a8, 0xe6e2d4],
      collide: false,
    },
  ],

  /* ---------------------------------------------------------------- *
   * MINERALS - four elements, four places, one ladder.
   *
   * Every metre below is MEASURED - flooded from each pad over a 2 m lattice
   * against the real colliders, no jump and no mantle - and not asserted:
   *
   *   rarity    element     terrain  nearest / median / furthest walk, and from where
   *   --------  ----------  -------  --------------------------------------------
   *   common    regolith    plain     46 /  539 /  848 m from Mosaic Flat
   *   uncommon  anorthite   outcrop  125 /  174 /  214 m from Mosaic Flat, up the Stair
   *   rare      sperrylite  crater   428 /  480 /  544 m from Raysedge, down the road
   *                                  (496 / 548 / 611 m the long way from Mosaic Flat)
   *   exotic    helion      crater    26 /   32 /   38 m from the Cold Well's own pad,
   *                                  and 0 of 7 from EITHER other pad at any distance
   *
   * The last row is the design in one line. The Cold Well's wall measures 52
   * deg median and 62 at p95 on every bearing; there is no long way round, no
   * clever line and no chute. The only way to stand on that floor is to land on
   * it, which is what makes
   * "which pad do I set down on" a decision rather than a convenience - the
   * Cinder pattern, and the reason the top of a rarity ladder means anything.
   *
   * `credits` is absent from every row on purpose - `definePlanet` computes it
   * from `unitValue * hold` and REFUSES a hand-written one. `size` is the node
   * radius AND the hold volume (`max(1, round(size * 1.6))`), so the ladder
   * runs the other way in bulk and the cheap ore is the bulky ore:
   *
   *   ore          size   hold m3   cr/m3   credits a node
   *   regolith     1.58      3         7        21
   *   anorthite    1.15      2        22        44
   *   sperrylite   0.82      1       140       140
   *   helion       0.66      1       240       240
   *
   * A stock Kestrel holds 10 m3. That is three lumps of regolith for 63 credits
   * or ten flakes of helion for 2,400, and the whole cargo decision is in those
   * two numbers.                                                              */
  minerals: [
    {
      id: 'regolith', item: 'regolith', name: 'Regolith Fines',
      rarity: 'common', terrain: 'plain', place: 'the open flats',
      /* Dull, and darker than the plain it sits on. Cinder shipped its
       * cheapest ore as a cream boulder brighter than anything else on the
       * planet - the least valuable thing was the most conspicuous object and
       * it was indistinguishable from an ore worth ten times more. 0x585449 is
       * a shade under the plain band (0x8d8069) and warmer than the ejecta
       * blocks, so it reads as a lump of caked dust, which is what it is. */
      color: 0x585449, glow: 0,
      unitValue: ORE('regolith'), spread: 0.25,
      /* 1.58 m is the smallest radius that still costs THREE cubic metres of
       * hold - `holdUnitsFor` rounds, so anything under 1.5625 drops to two and
       * the bulk-versus-value decision goes with it. */
      size: 1.58, count: 40, spacing: 20,
      /* `yMin: 0` is the important filter and it is a design one, not a
       * geological one: it keeps the commonest ore off the two deep floors
       * where the rare and exotic tiers live. An exotic seam with the common
       * one lying next to it is an exotic seam nobody had to travel for.
       * `yMax: 34` keeps it off the Pale Bench (48) and off the top of the rim
       * crests, so the uncommon tier has its own ground too. */
      region: { shape: 'field', yMin: 0, yMax: 34, slopeMaxDeg: 16, clearOfPads: 5 },
    },
    {
      id: 'anorthite', item: 'anorthite', name: 'Anorthite',
      rarity: 'uncommon', terrain: 'outcrop', place: 'The Pale Bench',
      /* COOL WHITE ON A WARM CREAM BENCH, and it is a legibility decision.
       * The bench's own band is 0xd9d3c0 - hue 46, a warm cream - and an ore
       * the same hue on it would be invisible at ten metres however bright it
       * was. 0xe6e9ee is hue 214: brighter AND the other side of neutral, so it
       * separates by hue rather than by value alone. No glow: feldspar is matte
       * and the one glowing thing on this planet should stay the one that is
       * worth 240 a cubic metre. */
      color: 0xe6e9ee, glow: 0,
      unitValue: ORE('anorthite'), spread: 0.25,
      size: 1.15, count: 22, spacing: 10,
      /* r 46 against the bench's own 52 m flat top, so every node is on the
       * table and none is on its 28 m edge. */
      region: { shape: 'disc', x: BX, z: BZ, r: 46, slopeMaxDeg: 14, clearOfPads: 3 },
    },
    {
      id: 'sperrylite', item: 'sperrylite', name: 'Sperrylite',
      rarity: 'rare', terrain: 'crater', place: 'the melt sheet in Crown of Rays',
      /* Platinum arsenide in tin-bright cubes. A hard blue-white with a real
       * cold glint, on the darkest band on the planet (0x272d38) - the seam is
       * meant to be the thing you see when you come round the last leg of the
       * Slump Road and the floor opens out. */
      color: 0xbfd0e4, glow: 0x4f7fb0,
      unitValue: ORE('sperrylite'), spread: 0.25,
      size: 0.82, count: 12, spacing: 12,
      /* The melt sheet, and nothing but. r 56 against the pad's 52 m disc plus
       * the first four metres of its blend, with a 12 deg ceiling that rejects
       * the wall outright - shocked minerals are IN the melt, not on the slope
       * above it, so the fix and the geology are the same fix. */
      region: { shape: 'disc', x: CX, z: CZ, r: 56, slopeMaxDeg: 12 },
    },
    {
      id: 'helion', item: 'helion', name: 'Helion Ice',
      rarity: 'exotic', terrain: 'crater', place: 'the shadowed floor of The Cold Well',
      /* Pale ice blue and the ONLY emissive on the planet, in the only place
       * the sun does not reach. It is the whole payoff of the second landing
       * and it should be visible from the pad the moment the ramp comes down. */
      color: 0xa8dcef, glow: 0x2f7f9e,
      unitValue: ORE('helion'), spread: 0.25,
      /* The smallest node here and the dearest: one cubic metre, 240 credits.
       * A stock Kestrel can lift all seven, which is the trip this ore exists
       * to make worth flying. */
      size: 0.66, count: 7, spacing: 7,
      /**
       * AN ANNULUS, BECAUSE THE PAD IS IN THE MIDDLE OF THE FLOOR.
       *
       * The Cold Well's flat bottom is only 36.5 m in radius and the landing
       * disc is 18 of it, so a `disc` region would put half the seam under the
       * ship. r0 24 clears the levelled pad (22 m) outright; r1 34 stops short
       * of the wall.
       *
       * ── "Permanently shadowed", and what actually renders ────────────────
       * Geometrically it is true and it is why the ice is here at all: 63 m
       * from crest to floor at an 18.5 deg sun casts 188 m of shadow over a 192
       * m floor. What the RENDERER does is a different question and the honest
       * answer is that it does not cast it - `PlanetWorld._buildTerrain` sets
       * `ground.castShadow = false`, so the terrain shadow-maps nothing onto
       * itself. What darkens this floor is the two things that do not need a
       * shadow map: a horizontal surface takes sin(18.5) = 0.317 of the key
       * where a sun-facing slope takes ~1.0, and at y -44 the floor is on the
       * darkest band in the palette. Measured as illumination that is 1.86
       * against 7.71 on a lit face - a quarter - under the darkest rock on the
       * planet. It reads as a pit. It is not a shadow, and calling it one in a
       * comment would be the "assess art by reading code" error.
       */
      region: { shape: 'annulus', x: WX, z: WZ, r0: 24, r1: 34, slopeMaxDeg: 22, clearOfPads: 2 },
    },
  ],

  /* ---------------------------------------------------------------- *
   * LANDING SITES. Three, one primary, and every one of them has a matching
   * `pad` landform above at the same coordinates - `definePlanet` throws if one
   * does not, because a landing site that is only an assertion is how "built
   * but not reachable" gets shipped.
   *
   * `yaw` is the arrival facing. `Player` runs forward as
   * `(-sin(yaw), 0, -cos(yaw))`, so each of these is `atan2(-dx, -dz)` toward
   * the thing the site exists to look at, computed once here rather than
   * guessed - a landing site whose first frame faces a blank plain has wasted
   * the one moment the player is guaranteed to be looking.                    */
  /**
   * ═════════════════════════════════════════════════════════════════════════
   *  THE PAD YOU ARRIVE AT, AND WHY IT IS NO LONGER MOSAIC FLAT
   * ═════════════════════════════════════════════════════════════════════════
   *
   * The registry-wide rule, asserted for all ten planets by
   * `planet-envelope.test.mjs`: the arrival pad is the RICHEST pad that is
   * RETURNABLE and carries no EXOTIC seam. Cinder established it and
   * `planets/Volcanic.js` records what it cost to find.
   *
   * Measured, a best-value 10 m3 Kestrel load off each pad's own nearest seams:
   *
   *     mosaic       245 cr     regolith, and regolith alone - the common tier,
   *                             3 m3 a lump, so the hold is full of the
   *                             cheapest thing on the planet before it holds
   *                             anything else.
   *     raysedge   1,756 cr     7.17x. Sperrylite is RARE and 0.82 m of node,
   *                             and the Slump Road puts the melt sheet 167 m
   *                             from this disc instead of 343.
   *     coldwell   1,757 cr     the exotic pad. One credit richer and refused
   *                             anyway - see below.
   *
   * ── WHY NOT THE COLD WELL, WHICH MEASURES ONE CREDIT MORE ────────────────
   *
   * Because it is the EXOTIC pad, and on this planet that is the ONLY refusal
   * available - which makes Tessera the world that proves the exotic half of
   * the rule is not redundant with the returnable half. The Cold Well reads 0
   * degrees of rim and returns 100% of what it reaches; it is the safest disc
   * in the registry. It is also the only ground helion sits on: 7 of 7 from
   * this pad at 26 m, 0 of 7 from either other pad at any distance, at every
   * envelope. The Well's wall measures 52 deg median and 62 at p95 on every
   * bearing - there is no long way round. Arriving there would hand a new pilot
   * the top of the rarity ladder in the first forty seconds and delete the
   * second landing this planet is built around.
   *
   * (The 1,757 against 1,756 is not the reason and must not be read as one. If
   * the mineral table were re-cut tomorrow and the Well came out at double,
   * the answer would be the same answer.)
   *
   * ── WHAT HID THIS ONE: THE RIM PROXY, READ BACKWARDS ─────────────────────
   *
   * Raysedge reads 300 degrees of horizon falling away over 51.0 m, the second
   * highest in the registry, so every instrument that asked the CLIFF question
   * refused it. The cliff is real - the pad is notched 12 m outside a rim crest
   * over a 296 m bowl - and it is not the question being asked.
   * `PlanetWorld._padReturn` floods the collision bed out of the disc and back:
   * 98.2% of everything a body can walk to from here can walk back, the same
   * figure Mosaic Flat reads, because the Slump Road descends 69.2 m over 401 m
   * of polyline at 10.1 degrees mean and walks both ways. This pad and
   * Vitrine's Blackhorn Bench are the two the proxy was silently refusing, and
   * they are the two richest returnable pads on their planets.
   * @see `SpaceObjectives.padIsHome`
   *
   * ── WHAT WAS MEASURED BEFORE THE FLAG MOVED ──────────────────────────────
   *
   *   the exotic guarantee survives   helion 0/7 from Raysedge at the legacy 38
   *                                   deg envelope, at the real 56.63 deg one,
   *                                   again with Tessera's 1.70 m jump apex -
   *                                   the BIGGEST in the system, off the
   *                                   lightest gravity in it, and the one most
   *                                   likely to open a gate that a walk cannot
   *                                   - and again with the swim envelope.
   *                                   Identical to Mosaic Flat's own 0/7 in all
   *                                   four columns.
   *   the pad is a round trip         98.2% home, not one-way, so no hazard
   *                                   ring.
   *   nothing below exotic is lost    regolith 40/40, anorthite 22/22,
   *                                   sperrylite 12/12 from Raysedge, at every
   *                                   envelope. The walk improves at both ends
   *                                   of the ladder that matters: sperrylite
   *                                   343 m -> 167 and anorthite 121 -> 125,
   *                                   against regolith 46 -> 78.
   *
   * ── AND THE DISC WAS MEASURED, NOT ASSUMED ───────────────────────────────
   *
   * 20 m against Mosaic Flat's 30, and the ground inside it measures 0.000 m of
   * relief and 0.0 degrees of grade over the full 20. The `pad` landform under
   * it is r 24 with an 18 m blend - deliberately larger than the landing disc,
   * so the notch swallows the crest rather than balancing on it - and the
   * ground stays dead level all the way out to that 24.
   *
   * Widening is still refused, by the bowl rather than by the deck:
   *
   *     r 20   0.00 m relief    0.0 deg    rim 300
   *     r 24   0.00 m           0.0 deg    rim 315   (the pad landform's edge)
   *     r 26   0.41 m          14.5 deg    rim 315
   *     r 28   1.55 m          31.5 deg    rim 315
   *     r 30   3.47 m          42.7 deg    rim 315
   *
   * Past r 24 the disc starts eating the inner wall. 20 m is the disc, and the
   * four spare metres of `pad` are the notch it sits in.
   */
  landing: [
    {
      /* Out on the open regolith, 143 m from Crown of Rays' rim crest and 160 m
       * from the Pale Bench, with the crater's rim on the skyline dead ahead.
       * It was the primary; see the block above for why it is not. */
      id: 'mosaic', name: 'Mosaic Flat', x: -250, z: 200, r: 30, yaw: -0.46,
    },
    {
      /* THE PRIMARY. Notched into the rim crest, at the head of the Slump Road.
       * Facing the crater's axis, so the first frame is the lit far wall across
       * a 296 m bowl with the melt sheet at the bottom of it - which is the best
       * first frame on the planet and now the one every arrival gets. */
      id: 'raysedge', name: 'Raysedge', x: RIM_PAD[0], z: RIM_PAD[1], r: 20, primary: true, yaw: -0.31,
    },
    {
      /* On the floor of the Cold Well, 52 m below its own rim, and the only way
       * a body ever stands here. Facing bearing -28 from the axis, which is the
       * one arc of wall the low sun reaches - everything else in frame is
       * black, which is the point of coming. */
      id: 'coldwell', name: 'The Cold Well', x: WX, z: WZ, r: 18, yaw: -1.08,
    },
  ],

  /* No `hazards` block. The schema's hazards are weather - falling ash, heat
   * shimmer over lava, steam - and vacuum has none of them. A world with no
   * air has no hazard that this system can express, and inventing one to fill
   * the field would be authoring a number nobody applied. */
});

export default TESSERA;
