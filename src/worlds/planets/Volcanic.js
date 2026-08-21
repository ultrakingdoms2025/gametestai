/**
 * CINDER - the volcanic planet, and the first instance of the descriptor.
 *
 * Everything here is data. There is no code in this file that a second planet
 * would have to copy: an ice moon is this file with different numbers, a
 * different palette and a different set of landform records, and it costs no
 * new world class, no new height function and no new prop kind unless it wants
 * a SHAPE nobody has built yet.
 *
 * ==========================================================================
 *  THE MAP, in words
 * ==========================================================================
 *
 * 800 m square, `+x` east and `+z` south. Sea level for this world is the ash
 * plain at y = 12.
 *
 *   ASH THRONE          the caldera, centred (-60, -90). A shield 600 m across
 *                       rising to y 132, its top a 208 m crater whose rim crest
 *                       stands at 158 and whose floor is a dead-flat 62. It is
 *                       the silhouette from everywhere on the map.
 *
 *   THE LAVA LAKE       30 m of incandescent lake on the crater floor, in its
 *                       own basin so the shoreline is a shoreline.
 *
 *   THE OUTLET GORGE    the lake's drain. A `ramp` cut on bearing 200 deg from
 *                       the crater floor out through the rim and 340 m down the
 *                       flank to a lake on the plain. Where it crosses the rim
 *                       it is 107 m below the crest on both sides. It was built
 *                       purely to be looked at; it is now also the only place
 *                       rheniite grows, which is what turns the longest walk on
 *                       the planet into a destination.
 *
 *   THE SPIRAL ROAD     the only way down into the crater on foot. A `ramp`
 *                       from the rim landing pad, one partial turn round the
 *                       inner wall, 310 m long at 12.5 deg. It exists because a
 *                       caldera you can see the floor of and cannot get to is
 *                       the exact defect this project keeps shipping.
 *
 *   THE RIFT            a 13 m fissure running 430 m north-south through the
 *                       east of the map, with a spoil lip along each edge and
 *                       fumaroles down its length. Sulfur grows on the lips.
 *
 *   THE COLONNADE       a 36 m basalt mesa at (250, 40), its top a forest of
 *                       hexagonal columns. Reachable two ways on purpose - a
 *                       landing pad on top, and a switchback road up the east
 *                       face for a player who came on foot.
 *
 *   THE GLASS SHELF     a low obsidian plateau at (-250, 170), 10 m above the
 *                       plain and walkable straight onto it from any bearing.
 *
 *   FIVE CINDER CONES   parasitic vents on the plain and lower flank, 21-41 m,
 *                       each with a summit pit. One of them is still alight.
 *
 * ==========================================================================
 *  WHY THE NUMBERS ARE THESE NUMBERS
 * ==========================================================================
 *
 * The relief is authored, not scaled up out of noise, for the reason Citadel's
 * Drop Three recorded: extent without authored landform gives a flat nothing.
 * The swell/ripple/grain amplitudes below total 11.6 m against 158 m of
 * authored relief - the noise is the last 7% and its whole job is to stop the
 * authored shapes reading as CAD.
 *
 * Every ramp grade, every pad radius and every lava shoreline in this file was
 * measured against the real height function and is pinned by
 * `scripts/tests/planet-relief.test.mjs` and `planet-reach.test.mjs`. If a
 * number here is edited, one of those goes red - which is the point of writing
 * a planet as data.
 */

import { definePlanet } from './PlanetDescriptor.js';
import { ITEMS } from '../../systems/ItemDefs.js';

/**
 * Credits per cubic metre of hold, read off the item catalogue.
 *
 * The price of an element belongs to the ELEMENT, not to the rock it happens
 * to be lying in: the same iridite is worth the same per cubic metre whether
 * it came off Cinder's crater floor or off the next lava world in the
 * registry, and the vendor who buys it reads `ITEMS`. So the number lives
 * there once and this file quotes it. Throwing on a missing row rather than
 * returning `undefined` is the difference between a loud boot failure and a
 * planet whose deposits are all worth NaN - and NaN is the failure mode this
 * world has already lost a day to.
 *
 * @param {string} id an `ITEMS` id
 * @returns {number} credits per cubic metre
 */
const ORE = (id) => {
  const def = ITEMS[id];
  if (!def) throw new Error(`[Cinder] mineral names item "${id}", which has no ITEMS row`);
  return def.value;
};

/* ------------------------------------------------------------------ */
/* Frame of reference                                                  */
/* ------------------------------------------------------------------ */

/** Playfield half-extent. */
const HALF = 400;
/** The ash plain's nominal height. Everything is quoted against it. */
const PLAIN = 12;

/** The caldera's axis, and the polar frame every summit feature is placed in. */
const CX = -60;
const CZ = -90;
/** Crater floor. Dead flat, by construction - see `volcanoAt`. */
const FLOOR = 62;
/** Where the shield's flank finally reaches the plain. */
const SHIELD_R = 300;
/** Rim radius and crest height above the flank there. */
const RIM_R = 104;
const RIM_H = 26;

const D2R = Math.PI / 180;
/** A point at polar (d, bearing-in-degrees) about the caldera axis. */
const P = (d, deg) => [
  +(CX + d * Math.cos(deg * D2R)).toFixed(2),
  +(CZ + d * Math.sin(deg * D2R)).toFixed(2),
];

/* ------------------------------------------------------------------ */
/* The two routes that make the summit a place and not a postcard      */
/* ------------------------------------------------------------------ */

/**
 * Rim landing pad. Sits at d 118 on bearing 306, i.e. 14 m OUTSIDE the rim
 * crest, so its 20 m disc plus 18 m blend notches the crest rather than
 * balancing on it. The notch is 27 m deep and reads as a shelf blasted into the
 * rim, which is what a landing site on a volcano should look like.
 */
const RIM_PAD = P(118, 306);

/**
 * The spiral road down the inner wall.
 *
 * It STARTS AT THE PAD CENTRE, and that is load-bearing rather than tidy. A
 * `ramp` with no explicit `y0` takes its head height from the pre-level field
 * at its first point - which is precisely the height the pad levels itself to,
 * because a `pad` with no explicit `y` does the same thing at the same place.
 * Start the road one metre away and the two resolve to different numbers, and
 * the player steps off a 25 m riser they cannot see coming.
 *
 * One partial turn, 306 deg round to 152 deg, so no two legs ever share a
 * bearing and the turns cannot merge into a flattened cone.
 */
const SPIRAL = [
  RIM_PAD,
  P(104, 340),
  P(94, 375),
  P(85, 410),
  P(76, 445),
  P(67, 480),
  P(52, 512),
];

/**
 * The outlet gorge, bearing 200 deg. Placed in the one angular window free on
 * BOTH the inner wall and the outer flank: the spiral occupies 306-512 deg
 * inside, so 152-306 is what is left, and 200 sits in the middle of it.
 */
const GORGE = [
  P(26, 200),
  P(104, 200),
  P(200, 205),
  P(272, 210),
  [-316, -262],
];

/** The rift, north to south down the east of the map. */
const RIFT = [[210, -260], [188, -150], [196, -40], [170, 60], [188, 170]];

/* ------------------------------------------------------------------ */
/* The descriptor                                                      */
/* ------------------------------------------------------------------ */

export const VOLCANIC = definePlanet({
  id: 'cinder',
  name: 'Cinder',
  blurb: 'A young shield volcano, still degassing. Sulfur on the rift, glass on the shelf, rheniite down the outlet gorge, iridite on the crater floor.',

  half: HALF,
  /**
   * 256 segments over 800 m: a 3.125 m cell.
   *
   * Finer than Citadel's 4.17 m and coarser than Medieval's 2.0 m. The mesh and
   * the collision heightfield are the SAME grid, so this number buys both the
   * silhouette and the surface the player stands on; it is 132,096 triangles in
   * one mesh, which is the largest single draw call on the planet and the first
   * thing a streaming pass would break up.
   */
  seg: 256,

  /**
   * 0.86 g, and BOTH consumers read it.
   *
   * This used to say "Phase 1 does not retune the player integrator against
   * it", which was true and honest while gravity reached only the ship. It
   * reaches the player on foot now, through the one predicate in
   * `WorldRules.worldGravity`: `Piloting._env` gives the flight model
   * `(0, -8.44, 0)`, and `Player.setWorldGravity` converts 8.44 to a ratio
   * against `CONFIG.player.gravityReference` (9.81) and walks in -18.93 m/s²
   * rather than the global -22.
   *
   * Measured here by driving the real controller: apex 0.964 m, hang 0.577 s,
   * against 0.878 m / 0.533 s on a world that publishes no gravity at all. At
   * 0.86 g the difference is meant to be felt rather than played with - the
   * variety is at the other end of the ladder, on Tessera (0.17 g) and Lathe
   * (0.19 g).
   *
   * @see ../../player/Player.js `setWorldGravity`
   */
  gravity: 8.44,

  /* ---------------------------------------------------------------- */
  terrain: {
    seed: 0x0c17de,
    baseY: PLAIN,
    /** Broad ash swells. 190 m wavelength: one swell per two minutes' walk. */
    swell: { amp: 9.0, scale: 190, octaves: 4 },
    /** Ripples, ridged so the flanks are dune-like rather than blobby. */
    ripple: { amp: 2.0, scale: 34, octaves: 3 },
    /** Grain, at the scale of a footfall. Keeps the normals from going glassy. */
    grain: { amp: 0.30, scale: 26 },
    /** The map's edge falls away rather than walling up. */
    rim: { start: 372, drop: 20 },

    landforms: [
      /* ---- ADD ---------------------------------------------------- */
      {
        kind: 'volcano',
        x: CX, z: CZ, r: SHIELD_R,
        peak: 132 - PLAIN,        // above the plain the shield stands on
        rimR: RIM_R, rimH: RIM_H, rimJag: 0.075,
        craterR: 58, craterY: FLOOR,
        /* The notch the gorge leaves through. Bearing 200 deg in radians; the
         * gorge is cut by a ramp rather than by this, but a rim that is not
         * ALSO lower here would leave the gorge running through a wall of
         * untouched crest and reading as a tunnel. */
        breach: { bearing: 200 * D2R, width: 0.42, depth: 0.85 },
        seed: 0x51a7,
      },
      { kind: 'cone', x: 120, z: -60, r: 52, peak: 34, pit: 0.35 },
      { kind: 'cone', x: -180, z: 60, r: 44, peak: 26, pit: 0.40 },
      { kind: 'cone', x: 60, z: 150, r: 38, peak: 21, pit: 0.30 },
      { kind: 'cone', x: -320, z: -40, r: 58, peak: 41, pit: 0.25 },
      { kind: 'cone', x: 300, z: -180, r: 46, peak: 29, pit: 0.38 },

      /** The colonnade mesa. Absolute, so its top is a table and not a swell. */
      { kind: 'plateau', x: 250, z: 40, r: 62, y: 48, edge: 26 },
      /** The glass shelf: 10 m up, 30 m of edge - walkable from any bearing. */
      { kind: 'plateau', x: -250, z: 170, r: 78, y: 22, edge: 30 },

      /** Spatter rampart along the rift's west lip. */
      { kind: 'ridge', pts: [[170, -200], [152, -100], [158, -10], [134, 80]], width: 20, height: 6.5, taper: 0.35 },
      /** Levee thrown out of the gorge, running parallel to it down the flank. */
      { kind: 'ridge', pts: [[-110, -160], [-190, -215], [-270, -280]], width: 22, height: 8.5, taper: 0.5 },

      /* ---- CUT ---------------------------------------------------- */
      /** The lava lake's basin, so the lake has a shore. */
      { kind: 'basin', x: -52, z: -96, r: 34, depth: 6.5, flat: 0.5 },
      /** The plain lake at the gorge's toe. */
      { kind: 'basin', x: -322, z: -276, r: 62, depth: 11.0, flat: 0.45 },
      /** The rift. Cubed walls, so it is a fissure and not a valley. */
      { kind: 'trench', pts: RIFT, width: 11, depth: 13, lip: 3.2, lipWidth: 13 },

      /* ---- LEVEL -------------------------------------------------- *
       * Order inside this layer matters: a later form overrides an earlier one
       * where they overlap, and the ordering here was chosen by measurement.
       *
       * ROADS FIRST, PADS LAST. The other way round was the first attempt and
       * it cost the rim pad its flatness: the spiral road leaves the pad centre
       * and descends at 0.15, so inside a 20 m disc it had already taken 3.0 m
       * off - a "landing pad" with a three-metre fall across it. With the pad
       * last, the pad's disc wins outright and the road emerges from the pad
       * EDGE, where the pad's 18 m blend hands over to the road's own grade
       * with no step at all. Measured: rim pad span 3.00 m before, 0.00 m after.
       *
       * The gorge is cut before the spiral for the same kind of reason - where
       * the two pass within 40 m of one another on the crater floor, the ROAD
       * wins and the road stays a road.                                       */

      /** The gorge.
       *
       * `y0` is explicit and it is BELOW the lava lake's surface (59.9), which
       * is the whole mechanism of the outflow: left to default, the head took
       * the crater floor's own 61.9 and the lake had nowhere to drain to. It is
       * also why the lake reads correctly at all - the gorge's 30 m blend
       * reaches 32.5 m into the lake basin, and at the old 61.9 it was lifting
       * the middle of the lake 1.8 m above its own surface. */
      { kind: 'ramp', pts: GORGE, width: 13, blend: 30, y0: 58.0, y1: 1.5 },
      /** The spiral road. */
      { kind: 'ramp', pts: SPIRAL, width: 7.5, blend: 13, y1: FLOOR },
      /** The switchback up the colonnade's east face. */
      { kind: 'ramp', pts: [[345, 160], [315, 120], [300, 80], [276, 58]], width: 7.0, blend: 12 },

      { kind: 'pad', x: 150, z: 205, r: 30, blend: 22 },
      { kind: 'pad', x: RIM_PAD[0], z: RIM_PAD[1], r: 20, blend: 18 },
      { kind: 'pad', x: 250, z: 40, r: 22, blend: 16 },

      /** The toe lake's bed.
       *
       * A `pad`, not a `basin`, and the difference is measurable. A basin is a
       * DELTA: it cuts the same depth out of whatever it lands on, so a lake
       * sitting in one inherits every metre of the 190 m ash swell underneath -
       * measured, the shoreline of the first version ran from y -3.9 to y +7.9
       * around a single circle, a lake tilted twelve metres. A pad is a LEVEL,
       * so the bed is flat by construction and the shoreline is a contour. The
       * beach is the pad's 28 m blend. */
      { kind: 'pad', x: -322, z: -276, r: 40, blend: 26, y: 1.5 },
    ],
  },

  /* ---------------------------------------------------------------- */
  palette: {
    /**
     * `dirt.ground`, AND IT IS THE ONLY PLANET LEFT ON IT. Do not "tidy" this
     * to `rock.neutral` for consistency.
     *
     * The other nine moved because `dirt.ground`'s albedo is not neutral: it
     * measures a linear R:G:B of 1.79 : 1 : 0.49, and `_buildTerrain` MULTIPLIES
     * the bands below into it. That brown filter is what rendered the ice world
     * as moorland and this system's grey moon as chocolate.
     *
     * Here it is doing wanted work. Cinder is oxidised basaltic ash - the one
     * ground in the system that IS the colour of the filter - and this planet's
     * look was tuned by measurement against the render it produces, so it is
     * the reference every other planet's before/after is judged against. Moving
     * it would cost the comparison and gain nothing: the bands below already
     * carry their own cool basalt at hue 214 and their own ochre at hue 26, and
     * they arrive with the sun on them.
     */
    material: 'dirt.ground',
    tile: 6.0,
    /**
     * Absolute-height bands. Dark at the bottom where the ash is fresh and
     * wet-looking, lighter at the top where the rim is bleached and dusted -
     * which is what makes the caldera read as a silhouette from the plain
     * rather than as a dark shape against a dark sky.
     *
     * ══════════════════════════════════════════════════════════════════════
     *  THEY USED TO BE SIX SHADES OF ONE COLOUR, AND THAT IS MEASURABLE
     * ══════════════════════════════════════════════════════════════════════
     *
     * A tester who landed here and walked it wrote: "Cinder from orbit is the
     * best thing in the game. Cinder's surface is the worst. One flat
     * salmon-brown hue, no rock, no ash, no vents, no heat, no shadows."
     *
     * That is not a matter of taste, and `.probe/fix/cinder-hue.mjs` samples
     * the old table the way `PlanetWorld._terrainColors` reads it:
     *
     *   height   colour     hue    sat    lightness
     *   y   4    #3a2a22    20     26     18
     *   y  12    #5b4437    22     25     29
     *   y  20    #71563f    23     24     36
     *   y  34    #86664f    25     26     42
     *
     * Across the ENTIRE walkable plain the hue moved 5 degrees and the
     * saturation did not move at all. Six bands, one hue. The value structure
     * was doing real work - that is why the caldera reads as a silhouette -
     * but value alone is a black-and-white photograph of a volcano.
     *
     * The table below keeps the value structure exactly (dark low, bright rim,
     * a dip through the flank) and spends the freedom it had left on HUE and
     * SATURATION, which cost nothing and were both flat:
     *
     *   y   4    #2c3038    214    12     20   fresh glassy basalt, cool
     *   y  16    #7d4f2c     26    48     33   the ash plain: oxidised ochre
     *   y  34    #8f7b55     41    25     45   dust shelf, warm olive-grey
     *   y  62    #45505c    210    15     32   the flank: cool grey basalt
     *   y 108    #5a4a3e     25    19     30   upper flank, warm mid
     *   y 200    #a99a86     33    17     59   the rim: bleached ash
     *
     * 214 degrees of hue against 5, and the cool bands are what make the warm
     * ones read as HOT rather than as beige.
     *
     * ── THE TWO NUMBERS THIS IS NOT FREE TO MOVE ──────────────────────────
     * `planet-atmosphere.test.mjs` asserts the dust haze is LIGHTER and no
     * more SATURATED than the mean of this table, because a fog the colour of
     * the rock is what deleted the horizon once already. Mean lightness moves
     * 33.3 -> 36.5 against a fog at 47, and mean saturation 23.7 -> 22.7
     * against a fog at 17. Both still hold, with margin, and the test
     * re-derives them from this table every run rather than from a copy.
     */
    bands: [
      { upTo: 4, color: 0x2c3038 },
      { upTo: 16, color: 0x7d4f2c },
      { upTo: 34, color: 0x8f7b55 },
      { upTo: 62, color: 0x45505c },
      { upTo: 108, color: 0x5a4a3e },
      { upTo: 200, color: 0xa99a86 },
    ],
    /** Exposed basalt on anything steep. The crater wall and the gorge. */
    slope: { fromDeg: 32, toDeg: 52, color: 0x2a2c33 },
    /* Oxidised patches, so the bands do not read as a contour map. 0.55 ->
     * 0.72: the term is applied as `n * n * amount`, so most of the field
     * never gets near the ceiling and 0.55 left the patches too faint to
     * name at eye level - which is the other half of "no rock, no ash". */
    mottle: { scale: 46, amount: 0.72, color: 0xc2621f },
  },

  sky: {
    kind: 'daylight',
    params: {
      /* A dust-loaded sky: Rayleigh down (there is no blue here), Mie way up,
       * and the haze the colour of the ash it is made of. */
      /* Sun to the SOUTH-EAST and 26 degrees up, i.e. BEHIND AND RIGHT of a
       * player standing on Ashfall Flat looking at the caldera. The first pass
       * had it behind the mountain: the hero silhouette was a black cut-out
       * against a bright sky and the entire foreground was unreadable. A planet
       * gets looked at from its landing sites, so its key light is chosen from
       * one of them, not from the origin. */
      sunDirection: [0.58, 0.55, 0.60],
      sunColor: 0xffc98f,
      sunIntensity: 11,
      sunAngularSize: 0.026,
      /* Rayleigh almost off and Mie way up: there is no blue here, only dust.
       * At 0.55 the zenith was still frankly a summer afternoon. */
      rayleigh: 0.12,
      mie: 4.4,
      mieG: 0.80,
      altitude: 300,
      groundColor: 0x4a2c1e,
      hazeColor: 0xc9673a,
      horizonHaze: 0.88,
      cirrus: 0.20,
      cirrusScale: 1.1,
      cirrusSpeed: 0.006,
    },
    background: 0x50261a,
    /**
     * ── The fog, and why the numbers moved ────────────────────────────────
     *
     * `half` is 400, so the playfield is 800 m square and its diagonal is
     * 1,131 m. At `far: 760` the far half of the map was solid fog colour, and
     * the fog colour was the SAME HUE as the ground bands under it - so there
     * was no horizon line and no aerial perspective, only a wash. Measured on
     * the whole 921,600-pixel frame from 190 m up: mean 28.7, max 112, median
     * 29, p90 38 - the entire planet living inside a 9-luma band. From orbit
     * the same world is the best-looking thing in the build (max 241, a
     * glowing fissure network), so the hero shot and the playable place looked
     * nothing alike, and "big dark room" is the exact phrase the player used
     * to reject the last world.
     *
     * 1250 and NOT further. The terrain mesh ENDS at +/-400 and fog is what
     * hides the edge of it: at 1900 the rim of the playfield would be only a
     * quarter fogged from the middle of the map and you would see the world
     * stop. At 1250 the diagonal is fully extinguished, the rim at 400 m is
     * about a quarter of the way in, and the caldera at 300 m reads as a
     * silhouette with air in front of it rather than as paint.
     *
     * The colour is lifted and DESATURATED off the basalt hue, and both halves
     * are asserted in `planet-atmosphere.test.mjs` against the palette's own
     * bands rather than by eye. In the working (linear) space the ground bands
     * average L 0.110 / S 0.448; the old fog was L 0.100 / S 0.542 - darker
     * AND more saturated than the rock it hung over, which is why there was no
     * horizon to see. This is L 0.186 / S 0.370: a dust sky is lighter and
     * greyer than the basalt it is made of.
     */
    fog: { color: 0x8a7060, near: 120, far: 1250 },
    /**
     * ── And the ambient came down, with the difference moved into the sun ──
     *
     * 1.05 of warm near-white fill flattened whatever form the fog left: every
     * slope on the planet sat within a few luma of every other, so a
     * 71-degree crater wall and a flat of ash shaded the same. Bounce off a
     * lava lake is real and it is why this is still high for a world with one
     * sun - but half the light on a body cannot come off the lake when the
     * body is 600 m from it.
     *
     * 0.46 here and 6.4 on the key: the total on a face turned TO the sun is
     * about what it was, and a face turned away from it is now a different
     * value, which is what a terminator is.
     */
    ambient: { color: 0x8a5236, intensity: 0.46 },
    sun: { color: 0xffc98f, intensity: 6.4, direction: [0.58, 0.55, 0.60] },
    exposure: 1.22,
    /* Borrowing the yard's grade: warm world, cold shadows, and it is already
     * calibrated against measured linear-HDR luminance. `GRADE_PRESETS` is
     * keyed on WORLD id and a planet is not in it, so naming one here is the
     * only way a planet gets a calibrated look. */
    grade: 'dock',
  },

  /* ---------------------------------------------------------------- */
  liquid: {
    name: 'lava',
    /**
     * Stated rather than inferred. `liquidKind` already reads 'lava' off
     * `emissive: 2.1` and the material is byte-identical either way - this
     * planet is the calibrated reference and its shader must not move - but
     * the substance now decides swimmability and lethality as well as which
     * way round the colour channels mean things, and a planet that kills you
     * should say so in one word rather than by arithmetic on a brightness.
     */
    kind: 'lava',
    /* Radii are tuned so each body's edge meets the terrain within the skirt
     * the mesh hangs below it - measured, not eyeballed, by
     * `planet-relief.test.mjs`'s shoreline case. */
    bodies: [
      /** The crater lake. */
      { shape: 'disc', x: -52, z: -96, r: 25.0, y: 59.9 },
      /** The drain, down the gorge. */
      /* Width 30 against a 26 m gorge floor, ON PURPOSE. At 19 m it left a
       * 3.5 m dry ledge down each side, and the reachability probe found it:
       * the whole caldera was walkable up the gorge and the spiral road was
       * decoration. Lava fills its channel and laps the walls, so the gorge is
       * a thing to look into and the road is the way in. The 2 m of ribbon
       * beyond the flat floor is buried in the wall on both sides. */
      /* y0/y1 are the gorge ramp's own 58.0 -> 1.5 plus 0.8 m of depth. Held
       * to a CONSTANT offset from the floor under it rather than to a
       * convenient round number at each end: the two interpolate over the same
       * arclength, so a constant offset is the only choice that keeps the flow
       * the same depth everywhere. At 5.0 the toe of the flow floated 8.2 m
       * over the lake bed, well past the apron. */
      { shape: 'ribbon', pts: GORGE, width: 30, y0: 58.8, y1: 2.3 },
      /** The plain lake at the toe. */
      { shape: 'disc', x: -322, z: -276, r: 42, y: 3.0 },
      /** One cinder cone is still alight. */
      { shape: 'disc', x: -320, z: -40, r: 4.4, y: 21.4 },
    ],
    color: 0x3d0a04,
    hot: 0xff7a1c,
    crust: 0x140b0a,
    emissive: 2.1,
    flow: 0.55,
    /** ONE light, on the crater lake. `RIG_BUDGET.point` is 12 for the whole
     *  game and every one of them is compiled into every shader. */
    glowLight: { body: 0, color: 0xff7a2a, intensity: 34, distance: 130 },
    /**
     * TRUE. Lava kills, and until now it did not: `PlanetWorld` fenced the
     * shore and reported this flag in the census precisely so that its
     * dormancy was visible. `Swim._burn` reads it.
     *
     * 240 dps against 100 hp is dead in 0.42 s. That is not a difficulty
     * number, it is the only honest one: there is no version of standing in a
     * lava lake that a player should survive, and a rate that leaves time to
     * scramble out teaches that there is. Sallow's acid is 14 for exactly the
     * opposite reason.
     *
     * The 819 shore posts stay. Between them and this, getting into the lava
     * takes a sustained free climb over a 3.4 m wall - and then it is over.
     */
    lethal: true,
    hazard: { dps: 240 },
  },

  /* ---------------------------------------------------------------- */
  props: [
    {
      id: 'colonnade',
      kind: 'columns',
      /* 210 at 6.4 m, not 260 at 5.0 m. The dense version was 2.0 m of gap
       * between column faces and the reach probe lost a ferro-basalt seam
       * inside it: a colonnade a body cannot walk into is scenery with ore
       * behind glass. 6.4 m spacing against a 2.3 m maximum radius leaves
       * lanes 2.6-4.6 m wide, which is a forest you can move through. */
      region: { shape: 'disc', x: 250, z: 40, r: 58, slopeMaxDeg: 20, clearOfPads: 3 },
      /* 150, which is what the region HOLDS. At 210 the scatter saturated at
       * 155 and the descriptor was asking for something it could not have -
       * `scatter` reports the shortfall rather than padding, and a field that
       * routinely under-delivers by a quarter is a number nobody can reason
       * about. Rejection sampling saturates well below the hexagonal packing
       * limit (299 here); 150 lands inside that with room. */
      count: 150, spacing: 6.4,
      size: { rMin: 0.9, rMax: 2.3, hMin: 3.5, hMax: 13.0, sides: 6 },
      tint: [0x2b2726, 0x232020, 0x342d2b, 0x1d1a1a],
      collide: true,
    },
    {
      id: 'glass',
      kind: 'shards',
      region: { shape: 'disc', x: -250, z: 170, r: 78, slopeMaxDeg: 26 },
      count: 340, spacing: 3.2,
      size: { hMin: 1.1, hMax: 4.6, wMin: 0.45, wMax: 1.7 },
      tint: [0x120c16, 0x1b1020, 0x0d0a10, 0x24152c],
      collide: false,
    },
    {
      id: 'ejecta',
      kind: 'boulders',
      region: { shape: 'field', slopeMaxDeg: 34, clearOfLiquid: 14, clearOfPads: 4 },
      count: 1100, spacing: 7,
      size: { rMin: 0.65, rMax: 3.3 },
      tint: [0x201b1a, 0x2a2321, 0x171313, 0x342a25],
      collide: true,
    },
    {
      id: 'rift_vents',
      kind: 'vents',
      /* `clearOfPads`: the rift's north end passes 22 m from Ashfall Flat's
       * centre, and without this a fumarole came up through the landing disc. */
      region: { shape: 'corridor', pts: RIFT, width: 34, slopeMaxDeg: 30, clearOfPads: 4 },
      count: 54, spacing: 9,
      size: { rMin: 0.8, rMax: 2.6, plumeMin: 5, plumeMax: 17 },
      tint: [0x4a3a18, 0x5d4614, 0x33280f],
      collide: false,
    },
    {
      id: 'crater_vents',
      kind: 'vents',
      region: { shape: 'disc', x: CX, z: CZ, r: 54, clearOfLiquid: 5 },
      count: 22, spacing: 9,
      size: { rMin: 1.0, rMax: 3.0, plumeMin: 8, plumeMax: 26 },
      tint: [0x4a3a18, 0x5d4614, 0x33280f],
      collide: false,
    },
  ],

  /* ---------------------------------------------------------------- *
   * MINERALS - six elements, six places, one ladder.
   *
   * "Go and mine rare elements" is only a reason to fly to CINDER rather than
   * to any planet if the rare elements are Cinder's. So every row below names
   * the terrain family it belongs to and the feature it is in, and the ladder
   * runs with the cost of standing there:
   *
   *   rarity     element       terrain       walk to the nearest node, on foot
   *   ---------  ------------  ------------  --------------------------------
   *   common     tephra        ash plain      52 m from Ashfall Flat
   *   common     sulfur        rift lips      48 m from Ashfall Flat
   *   uncommon   obsidian      glass shelf   358 m from Ashfall Flat
   *   uncommon   ferro-basalt  colonnade      20 m from Colonnade Deck
   *   rare       rheniite      outlet gorge  326 m from Rimhold at the channel
   *                                          mouth, 768 m from Ashfall out on
   *                                          the flank
   *   exotic     iridite       caldera floor 310 m from Rimhold, down the
   *                                          spiral road - and UNREACHABLE
   *                                          from Ashfall at any distance
   *
   * Every one of those metres is MEASURED, not asserted:
   * `planet-minerals.test.mjs` floods the real colliders from each pad over a
   * 2 m lattice with no jump and no mantle, and prints the table. The last row
   * is the design in one line - the exotic ore is not a longer walk, it is a
   * SECOND LANDING, and the ablation case there shows it goes to 0 of 9 the
   * moment the spiral road is deleted.
   *
   * `credits` is absent from every row on purpose - `definePlanet` computes it
   * from `unitValue * hold` and REFUSES a hand-written one. `size` is the node
   * radius and also the hold volume, so the cheap ore is the bulky ore: three
   * cubic metres of tephra for 18 credits against one of iridite for 310. In a
   * 10 m3 Kestrel that is the entire decision.                               */
  minerals: [
    {
      id: 'tephra', item: 'tephra', name: 'Tephra Nodules',
      rarity: 'common', terrain: 'plain', place: 'the ash plain',
      /* 1.60 m is the SMALLEST radius that still costs three cubic metres of
       * hold - `holdUnitsFor` rounds, so anything under 1.5625 drops to two and
       * the bulk-versus-value decision goes with it.
       *
       * Darkened from 0x6b5a4a and shrunk from 1.85 m after looking at it in
       * the browser. At the old values a tephra nodule rendered as a cream
       * boulder brighter than anything else on the plain - the CHEAPEST ore
       * on the planet was its most conspicuous object, and it was
       * indistinguishable in colour from rheniite. 0x4a3b2e sits between the
       * ejecta boulders (0x201b1a-0x342a25) and the ash it is welded out of. */
      color: 0x4a3b2e, glow: 0,
      unitValue: ORE('tephra'), spread: 0.25,
      /* The biggest node on the planet and the least valuable, which is what
       * "bulk" has to mean if hold space is going to be a decision. Three
       * cubic metres a lump, and a stock Kestrel holds ten. */
      size: 1.60, count: 34, spacing: 22,
      region: { shape: 'field', yMax: 36, slopeMaxDeg: 24, clearOfLiquid: 26, clearOfPads: 5 },
    },
    {
      id: 'sulfur', item: 'sulfur', name: 'Sulfur Crust',
      rarity: 'common', terrain: 'fissure', place: 'The Rift',
      color: 0xd9c341, glow: 0x201a04,
      unitValue: ORE('sulfur'), spread: 0.25,
      size: 1.55, count: 26, spacing: 13,
      /* `widthInner: 13` is the fissure's own floor, excluded.
       *
       * Without it the corridor included the bottom of a 13 m trench with
       * near-vertical walls, and the reach probe found a sulfur seam down there
       * that nothing could walk to. Sulfur crusts on the LIP of a fumarole
       * anyway - the fix and the geology are the same fix. */
      region: { shape: 'corridor', pts: RIFT, width: 26, widthInner: 13, slopeMaxDeg: 30, clearOfLiquid: 8, clearOfPads: 4 },
    },
    {
      id: 'obsidian', item: 'obsidian', name: 'Obsidian Glass',
      rarity: 'uncommon', terrain: 'shelf', place: 'The Glass Shelf',
      color: 0x1a1020, glow: 0x2a1038,
      unitValue: ORE('obsidian'), spread: 0.25,
      size: 1.30, count: 20, spacing: 16,
      region: { shape: 'disc', x: -250, z: 170, r: 70, slopeMaxDeg: 22 },
    },
    {
      id: 'ferrobasalt', item: 'ferrobasalt', name: 'Ferro-Basalt',
      rarity: 'uncommon', terrain: 'outcrop', place: 'The Colonnade',
      color: 0x4d5866, glow: 0,
      unitValue: ORE('ferrobasalt'), spread: 0.25,
      size: 1.05, count: 18, spacing: 13,
      region: { shape: 'disc', x: 250, z: 40, r: 54, slopeMaxDeg: 26, clearOfPads: 2 },
    },
    {
      id: 'rheniite', item: 'rheniite', name: 'Rheniite',
      rarity: 'rare', terrain: 'channel', place: 'The Outlet Gorge',
      /* METALLIC SILVER WITH A COLD RIM, and it is a legibility decision, not
       * a mineralogical one - though rhenium disulfide is in fact a steel-grey
       * metallic. At the first colour (0x8c7f6a) rheniite rendered as the same
       * cream lump as tephra: the second-rarest element on Cinder looked
       * exactly like the commonest, and a player has no way to tell a 190 cr
       * flake from an 18 cr nodule at ten metres. Cold is the one hue nothing
       * else on this planet has - the ground is red-brown, the sun is
       * 0xffc98f, sulfur is yellow and iridite is orange.
       *
       * ── AND THE FIRST COLD COLOUR WAS NOT COLD, IT WAS WHITE ────────────
       * `0xb8ccd6` is a swatch whose own HSL saturation is 0.267 and whose
       * lightness is 0.78, and both halves of that were the defect. Measured at
       * a real node with `.probe/mineral-sweep.mjs` - which masks the ore's
       * exact pixels by hiding the mesh and differencing the frame against a
       * control pair, so it cannot quietly re-pick its sample:
       *
       *     albedo    glow      luma  sat    facet spread
       *     b8ccd6    2e6a7a     185  0.26   x1.15   the shipped defect
       *     3f6478    2e6a7a     147  0.38   x1.23   albedo alone: still bright
       *     3f6478    173a44     125  0.33   x1.32   both, and this is shipped
       *
       * Tephra is the control and measures x1.56-1.62 across the same three
       * runs, so the spread column is comparable and the ore has gone from a
       * quarter of the control's facet separation to four fifths of it.
       *
       * A node at mean 185 is most of the way up the ACES shoulder, where the
       * curve desaturates toward white and a lit facet and a shaded one land on
       * the same pixel - which is the same failure `ORE_ALBEDO_CEIL` was
       * introduced for, arriving one step later. The ceiling caps the BRIGHTEST
       * CHANNEL at 0.48, so it could only ever pull this swatch down to a paler
       * version of the same hueless thing; it cannot put chroma into a colour
       * that has none.
       *
       * `0x3f6478` is authored UNDER that ceiling (its brightest channel is
       * 120 of 255 = 0.471), so what is written here is what renders and no
       * second rule is silently rescaling it. Saturation 0.31 in the swatch,
       * lightness 0.36: a steel blue-grey rather than a pale one. It is still
       * the only cold thing on the planet, it is still nothing like tephra's
       * 0x4a3b2e, and the "metallic silver" half of the sentence above is now
       * carried by the 0.28 roughness and the emissive rim rather than by an
       * albedo that tried to be silver by being nearly white.
       *
       * ── AND THE ALBEDO ALONE WAS NOT ENOUGH, WHICH THE TABLE SHOWS ─────
       * The middle row is the swatch fixed with the emissive left where it was,
       * and it is still at luma 147 with a x1.23 spread: `emissiveIntensity` is
       * 2.2 and a flat emissive adds the SAME value to every facet, so it
       * compresses the ratio between a lit facet and a shaded one no matter
       * what the albedo does. `0x173a44` is the same teal at 62% of the value.
       * The saturation goes down slightly when it comes off (0.38 -> 0.33)
       * because the emissive was carrying chroma of its own, and the facet
       * spread goes UP by more than that trade costs - which is the number the
       * original complaint was about, and the reason this is the shipped row.
       *
       * The glow is not deleted, and must not be: `PlanetWorld` only lights ore
       * that declares one, and a rare seam a player has walked 760 m for has to
       * be findable in the last thirty of them.                                */
      color: 0x3f6478, glow: 0x173a44,
      unitValue: ORE('rheniite'), spread: 0.25,
      size: 0.75, count: 12, spacing: 12,
      /* THE LIPS OF THE CHANNEL, AND NEITHER THE FLOOR NOR THE WALLS.
       *
       * The gorge is a 13 m cut filled wall to wall by a 30 m lava ribbon, so
       * `widthInner: 17` starts the band outside the flow and `clearOfLiquid`
       * keeps three metres of dry rock under every node. The `width: 40`
       * outer edge and the 24 deg ceiling are what exclude the middle third:
       * measured across the gorge at eight stations, the banks between t=0.125
       * and t=0.5 stand at 45-79 deg, and every sample there is rejected. What
       * is left is the two ends - the channel mouth on the crater floor, and
       * the last 200 m of the flank where the walls lie back to 9-24 deg.
       *
       * That is the point of the deposit and not a compromise with it. The
       * flank half is 760-950 m on foot from Ashfall Flat, the longest walk to
       * any ore on the planet; the crater half is 320-510 m from Rimhold, down
       * the spiral. Rheniite is the one element you cannot collect on one
       * landing without a long march either way, and both marches are proved
       * walkable by `planet-minerals.test.mjs`. */
      region: { shape: 'corridor', pts: GORGE, width: 40, widthInner: 17, slopeMaxDeg: 24, clearOfLiquid: 3, clearOfPads: 4 },
    },
    {
      id: 'iridite', item: 'iridite', name: 'Iridite',
      rarity: 'exotic', terrain: 'crater', place: 'the Ash Throne caldera',
      color: 0xc4623a, glow: 0xff6a18,
      unitValue: ORE('iridite'), spread: 0.25,
      /* The smallest node on the planet and the dearest: one cubic metre, 310
       * credits, and it glows. A Pike cannot carry a single one of them
       * (`SHIP_BASE_STATS.pike.hold` is 0) and a stock Kestrel can carry all
       * nine, which is the trip this ore exists to make worth flying. */
      size: 0.62, count: 9, spacing: 11,
      region: { shape: 'disc', x: CX, z: CZ, r: 52, slopeMaxDeg: 22, clearOfLiquid: 7 },
    },
  ],

  /* ---------------------------------------------------------------- */
  /**
   * ═════════════════════════════════════════════════════════════════════════
   *  THE PAD YOU ARRIVE AT, AND WHY IT IS NO LONGER ASHFALL FLAT
   * ═════════════════════════════════════════════════════════════════════════
   *
   * `primary` is not a label. `Piloting._descend` aims EVERY atmospheric entry
   * at it, `PlanetWorld._placeSpawn` puts a player who arrives on foot on it,
   * and `Unstuck` returns them to it. It is the first ground a new pilot sees
   * in this game, because Cinder is the nearest planet and the tutorial
   * destination.
   *
   * It was Ashfall Flat, which is the POOREST of the three. Measured, a
   * best-value 10 m3 Kestrel load off each pad's own nearest seams:
   *
   *     ashfall       481 cr     reaches tephra and ferrobasalt - the two
   *                              cheapest ores per cubic metre, so the hold
   *                              fills on bulk
   *     colonnade   1,059 cr     2.20x
   *     rimhold     4,154 cr     8.6x, and unusable - see below
   *
   * Walked, with `Mining.MINE_TIME` per node and the game's own ground speed,
   * that is 114 cr against 497 and 2,839, i.e. FIVE round trips to clear the
   * 500 cr first ore rung from Ashfall against two from the Colonnade. At the
   * flown 46 s out and about 90 s back, seventeen minutes against four and a
   * half - for the same objective, on the same planet, decided entirely by
   * which of these three rows carried a `primary: true`.
   *
   * ── WHY NOT RIMHOLD, WHICH IS RICHER STILL ───────────────────────────────
   *
   * Because it is the EXOTIC pad, and it is a shelf. Two separate refusals and
   * either one is enough:
   *
   *   1. The whole ten-planet mining design is "the exotic seam is a SECOND
   *      LANDING, not a longer walk" - iridite is 9-of-9 from Rimhold and
   *      0-of-9 from everywhere else, and `planet-envelope.test.mjs` asserts
   *      that registry-wide. An arrival pad that carries the exotic seam
   *      deletes the design on this planet.
   *   2. `PlanetWorld._padDrop` reads 270 degrees of horizon falling away over
   *      66.9 m. It is one of the pads a player can walk off and not climb back
   *      onto. Sending a new pilot there swaps a slow objective for a
   *      stranding.
   *
   * So the arrival pad is the RICHEST pad that is returnable and exotic-free,
   * which on Cinder is the Colonnade Deck. That rule is not typed here: it is
   * derived from the descriptor and asserted for all ten planets by
   * `planet-envelope.test.mjs`, so an eleventh planet cannot ship this defect
   * quietly.
   *
   * ── WHAT WAS MEASURED BEFORE THE FLAG MOVED ──────────────────────────────
   *
   *   the exotic guarantee survives   iridite 0/9 from Ashfall AND 0/9 from
   *                                   the Colonnade, at 38 deg, at the real
   *                                   56.63 deg envelope, and again with
   *                                   Cinder's own 1.228 m running-leap apex.
   *                                   Only Rimhold reaches it: 9/9.
   *   the road is bidirectional       the switchback up the east face floods
   *                                   433 k m2 outward and 433 k m2 BACK, and
   *                                   Ashfall is reachable from it on foot. It
   *                                   is not a one-way shelf like Rimhold.
   *   nothing below exotic is lost    tephra 34/34, sulfur 26/26, obsidian
   *                                   20/20, ferrobasalt 18/18 from either pad
   *                                   - byte-identical.
   *
   * ── AND THE DISC IS NOT WIDENED, WHICH WAS THE OTHER HALF OF THE DOUBT ───
   *
   * The objection to this move was that it puts a first landing on a 22 m mesa
   * disc instead of a 30 m disc on an open plain. Measured, both halves of that
   * are answered and the answer is to leave the disc alone:
   *
   *   - the disc is not tight. A pad in this project is not levelled by
   *     `PlanetWorld` - it is a ring drawn on whatever the landforms built - and
   *     the ground inside this one measures 0.00 m of relief and 0.0 deg of
   *     grade over the full 22 m, which is flatter than Ashfall's 0.1 deg. 44 m
   *     across holds a 14 m Kestrel or a 28 m Dray with room either side.
   *   - widening it makes it WORSE by the game's own published number.
   *     `_padDrop` marches from `r + 2` to `r + 46`, and the ground round the
   *     mesa falls away hard at about 70 m out:
   *
   *         r 20   53 deg of rim      r 26   360 deg
   *         r 22   75 deg             r 28   360 deg
   *         r 24   90 deg             r 30   360 deg
   *
   *     At r 26 the whole horizon trips the 8 m sill, which is past
   *     `SpaceObjectives.PAD_RIM_LIMIT` - so `Piloting` would read the disc out
   *     as a shelf on final approach, and `padIsHome` would refuse to recommend
   *     it on any build with no return flood to consult, the rim being all that
   *     fallback has. It is NOT what would ring the pad in hazard blocks: those
   *     are painted from `PlanetWorld._padReturn`, the measured return flood,
   *     and by that measure this pad comes home. 22 m is the disc the mesa
   *     actually has.
   *
   * What IS different from Ashfall is the surroundings - 75 degrees of rim
   * against 38 - and that is a cliff BEHIND the pad rather than a way of
   * getting stuck on it. `PlanetWorld._padReturn` asks the question that
   * matters by flooding the height field out of each disc and back to it:
   * 95.5% of everything a body can walk to from the Colonnade can walk back,
   * the same figure Ashfall reads, against 2.6% from Rimhold. That is why
   * Rimhold is the only pad on this planet ringed in amber hazard blocks and
   * the Colonnade is not - the ring means "you cannot get back on", and here
   * it would be a lie.
   *
   * The two measures disagree elsewhere in the registry and the flood is the
   * one to trust: Tessera's Raysedge reads 300 degrees of rim and comes home
   * 98.2% of the time. See `SpaceObjectives.padIsHome`.
   */
  landing: [
    {
      id: 'ashfall', name: 'Ashfall Flat', x: 150, z: 205, r: 30, yaw: -2.2,
    },
    {
      id: 'rimhold', name: 'Rimhold Shelf', x: RIM_PAD[0], z: RIM_PAD[1], r: 20, yaw: 2.1,
    },
    {
      id: 'colonnade', name: 'Colonnade Deck', x: 250, z: 40, r: 22, primary: true, yaw: 1.4,
    },
  ],

  hazards: {
    /** Ash in the air. Phase 1 draws it; nothing takes damage from it. */
    ashfall: { density: 0.35, drift: [0.6, -0.25] },
    heatShimmer: { nearLiquid: 24, strength: 0.5 },
    steamColor: 0x7d6a5e,
  },
});

export default VOLCANIC;
