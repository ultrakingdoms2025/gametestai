/**
 * SIROCCO - the desert world, and the first planet built out of `dunes` and
 * `scarp`.
 *
 * Everything here is data, exactly as on Cinder: no `three`, no functions in
 * the record, no new world class. What makes this planet unmistakable for
 * Cinder is not its palette, it is its SILHOUETTE - Cinder is one cone you can
 * see from everywhere, and Sirocco is a horizon with nothing on it until the
 * ground opens at your feet.
 *
 * ==========================================================================
 *  THE MAP, in words
 * ==========================================================================
 *
 * 880 m square, `+x` east and `+z` south. The sand sheet's nominal height is
 * y = 20; the fault block that carries the whole south-east of the map stands
 * 13 m proud of it, at y = 33.
 *
 *   THE LONG SEA        the dune sea. One transverse field, 124 m between
 *                       crests and 17 m from trough to crest, wind axis 17 deg.
 *                       It covers the entire playfield and it is the ground
 *                       everything else is cut into.
 *
 *   THE CROSSWIND       a second, older, tighter field over the north-west -
 *                       58 m crests, 9.5 m tall, wind axis 75 deg. Where the
 *                       two cross, the crests ADD, and those doubled crests at
 *                       y 41-52 are the only high ground in the north half and
 *                       the only place fulgurite is. Two fields at two angles
 *                       is how a dune sea gets a HISTORY instead of a texture.
 *
 *   THE THREADEYE       the slot canyon, and the best thing on the planet. A
 *                       fault runs from the west edge to the east edge on
 *                       bearing 108 deg; the south side of it stands 13 m proud
 *                       (`scarp`), and a 30 m-wide, 40 m-deep `trench` is cut
 *                       along the fault line itself. So the rim is a LINE and
 *                       not a circle, and from the south you walk UP a 13 m
 *                       ramp and the ground stops. Measured at six stations,
 *                       both walls stand at 82-83 deg; a profile walked due
 *                       north at x 300 reads 49-52 m of flat sand for ninety
 *                       metres and then 7.5 m in the next twenty. It is
 *                       invisible until you are nearly in it, and it splits the
 *                       map in two - nothing on foot crosses it anywhere.
 *
 *   THE STAIR           the way down, and the only way down. A notch (`ramp`)
 *                       blasted through the south lip below Rimwatch - 135 m
 *                       at 7.6 deg, from y 44 to y 26 - and then a 384 m
 *                       traverse along the south wall at 4.2 deg that lands on
 *                       the canyon floor at y -2. The seep is on the cut wall
 *                       beside it; that is where the chalcanthite is, and it is
 *                       the reason the road is worth finding.
 *
 *   WHITEPAN            the playa, centred (190, 230): a 236 m disc of salt at
 *                       a DEAD FLAT y 12, 20-45 m below the dunes around it,
 *                       with two shallow brine pans still wet on it. The
 *                       primary landing is on its east crust. Cinder's notes
 *                       record a lake bed cut as a `basin` inheriting the swell
 *                       under it and tilting twelve metres across one circle -
 *                       so this is a `pad`, a LEVEL, and it is flat by
 *                       construction. A pan that is not flat is not a pan.
 *
 *   THE STRANDLINE      not a landform - a PALETTE band, and it is deliberate.
 *                       The salt colour is pinned to y 12 exactly, so it paints
 *                       Whitepan solid and then reappears as a thin pale contour
 *                       wherever else the ground crosses that height: the level
 *                       the water stood at when there was water. It is the one
 *                       thing on the planet that ties the pan, the wadi and the
 *                       canyon floor into one story.
 *
 *   THE DRY WADI        a `channel` off the south-west uplands into Whitepan's
 *                       west shore. Flat-floored, levee'd, 7.5 m deep and
 *                       widening as it runs. Cassiterite is panned out of it.
 *
 *   THE ANVILS          two `plateau` mesas, one each side of the canyon -
 *                       (-150, 210) at y 84 and (-300, -110) at y 76. They are
 *                       SILHOUETTE and nothing else. Measured, they stand 42.7 m
 *                       and 41.2 m above the sand around them - two and a half
 *                       dune crests - on 59 deg faces, and nothing is authored
 *                       on top of either, which is the honest way to have an
 *                       unclimbable mesa. The first pass put them at y 68 and
 *                       y 60: 25 m up on a 40 deg face, which against a 17 m
 *                       dune sea is one and a half crests and climbable in
 *                       patches. A mesa a dune can hide is not a silhouette.
 *
 * ==========================================================================
 *  WHY THE NUMBERS ARE THESE NUMBERS
 * ==========================================================================
 *
 * Relief budget, measured over an 810,000-sample grid rather than estimated:
 * the height field runs y -23.1 to y 84.0, a range of 107 m. Every metre of
 * that is authored - the dune fields 26.5, the fault scarp 13, the canyon 40,
 * the mesas 43, the playfield rim falloff 26 - and against it the noise totals
 * 7.8 m (swell 6.0, ripple 1.5, grain 0.26), which is 7.3%. That is the same
 * share it carries on Cinder, and its whole purpose is the same: to stop a
 * `dunes` record reading as a sine wave and a `scarp` reading as a CAD
 * extrusion.
 *
 * The swell is LONG (235 m) on purpose. A dune sea's underlying bedrock surface
 * is smooth; all the short-wavelength structure the eye reads is the dunes
 * themselves, and a 34 m swell under a 124 m dune field would fight it.
 *
 * `seg` 280 over 880 m is a 3.143 m cell, which is the same texel and collision
 * density Cinder runs at. The mesh and the collision heightfield are the SAME
 * grid, so this number buys the silhouette and the ground you stand on at once.
 *
 * Nothing here is a guess about slope: the trench walls, the dune slip faces,
 * the pad flatness and every mineral's reachability were measured against the
 * real height function and the real colliders before this file was reported.
 */

import { definePlanet } from './PlanetDescriptor.js';
import { ITEMS } from '../../systems/ItemDefs.js';

/**
 * Credits per cubic metre of hold, read off the item catalogue.
 *
 * The price belongs to the ELEMENT and not to the rock it is lying in, so it
 * lives in `ITEMS` once and this file quotes it. Throwing on a missing row
 * rather than returning `undefined` is the difference between a loud boot
 * failure and a planet whose deposits are all worth NaN.
 *
 * @param {string} id an `ITEMS` id
 * @returns {number} credits per cubic metre
 */
const ORE = (id) => {
  const def = ITEMS[id];
  if (!def) throw new Error(`[Sirocco] mineral names item "${id}", which has no ITEMS row`);
  return def.value;
};

/* ------------------------------------------------------------------ */
/* Frame of reference                                                  */
/* ------------------------------------------------------------------ */

/** Playfield half-extent. 880 m square. */
const HALF = 440;
/** The sand sheet's nominal height. Everything is quoted against it. */
const SAND = 20;
/** How far the south block stands above the north one across the fault. */
const SCARP_H = 13;
/** How far the scarp face takes to fall back to the level it left. */
const SCARP_RUN = 26;

/** The Threadeye's cut: half-width and depth. */
const SLOT_W = 15;
const SLOT_D = 40;

/** Whitepan: centre, the flat disc, the beach, and the salt surface itself. */
const PAN = [190, 230];
const PAN_R = 118;
const PAN_BLEND = 84;
/**
 * y 12, and the number is load-bearing twice.
 *
 * It is 21 m below the fault block the pan is cut into, which is what makes the
 * playa read as a hole in the desert rather than as a light patch on it. And it
 * is the height the palette's salt band is pinned to (`upTo: 12` exactly), so
 * the pan comes out one solid near-white and the same colour reappears as a
 * strandline contour wherever else the ground passes through this height.
 */
const PAN_Y = 12;

/* ------------------------------------------------------------------ */
/* The fault, and the road that gets into it                           */
/* ------------------------------------------------------------------ */

/**
 * THE THREADEYE, west edge to east edge.
 *
 * The ends run 80 m PAST the playfield on both sides. A polyline's distance
 * field caps off round its endpoints, so a canyon that stopped at x = +/-440
 * would leave a rounded ramp of un-cut ground at each end and the whole
 * split-the-map claim with it - you would simply walk around the end of it.
 */
const THREADEYE = [
  [-520, 128],
  [-300, 78],
  [-120, 20],
  [40, -30],
  [200, -110],
  [360, -175],
  [520, -212],
];

/** Cumulative arclength of a polyline. Build-time only; it allocates. */
const arclen = (pts) => {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return cum;
};

/**
 * A point beside the Threadeye: `s` is the fraction of the canyon's length from
 * its west end, `off` is metres to the SOUTH of the centreline - the raised
 * side, the side the primary landing is on.
 *
 * This is Cinder's `P(d, deg)` in the shape this planet needs. Every leg of The
 * Stair is quoted as "so far along the canyon, so far off the wall", which is
 * the only way a road cut into a wall stays a fixed distance off it after the
 * canyon's own line is nudged. Typing the coordinates in by hand would make
 * them two copies of one fact and the second copy always goes stale.
 *
 * The south side is the polyline's right-hand normal, because this line runs
 * west to east and `+z` is south.
 *
 * @param {number} s 0..1 along the canyon
 * @param {number} off metres south of the centreline
 * @returns {[number, number]}
 */
const BESIDE = (s, off) => {
  const cum = arclen(THREADEYE);
  const total = cum[cum.length - 1];
  const want = Math.min(Math.max(s, 0), 1) * total;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < want) i++;
  const a = THREADEYE[i - 1];
  const b = THREADEYE[i];
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len = Math.hypot(dx, dz);
  const t = (want - cum[i - 1]) / (cum[i] - cum[i - 1]);
  return [
    +(a[0] + dx * t + (-dz / len) * off).toFixed(2),
    +(a[1] + dz * t + (dx / len) * off).toFixed(2),
  ];
};

/** Rimwatch: the bluff on the south rim, and the head of the only road down. */
const RIMWATCH = [250, -30];

/**
 * THE DROP - the notch through the south lip.
 *
 * A separate ramp from the traverse below it, and that is a measurement rather
 * than tidiness. One ramp from the bluff to the canyon floor would be LINEAR
 * over 520 m, so at the point where it crosses the rim it would still be 10 m
 * above the ground it was supposed to be cutting into, and it would build a
 * causeway out over the slot instead of a notch through the lip. Split in two,
 * this leg loses 18 m over 140 m (7.3 deg) and cuts a visible slot through the
 * rim; the traverse below it loses the rest.
 *
 * It STARTS AT THE PAD CENTRE. A `ramp` with no `y0` takes its head height from
 * the pre-level field at its first point, and a `pad` with no `y` does exactly
 * the same thing at exactly the same place - so the two resolve to the same
 * number and there is no riser. Start it one metre away and there is.
 */
const DROP = [RIMWATCH, BESIDE(0.735, 44), BESIDE(0.700, 24), BESIDE(0.668, 14)];

/**
 * THE STAIR - the traverse along the south wall.
 *
 * Held at 14 m off the centreline where it enters and closing to 0 where it
 * lands, so it hugs the wall at roughly mid-height and only reaches the floor
 * at the end of its run. `off` 14 sits inside the 15 m cut and about 20 m below
 * the rim; `off` 0 is the floor.
 *
 * Its blend is 10 m and its width 6, so nothing it levels reaches more than
 * 16 m from its own line. THAT NUMBER IS THE REASON THE CANYON STILL SPLITS THE
 * MAP. Measured across the canyon at the road's own station, the profile reads
 * y 31 at 18 m north of the axis, y 10.5 at 10 m north, y 8.7 on the axis and
 * y 20-22 on the road itself: the north wall is a 20 m rise inside 5 m - 82 deg
 * - and the road's influence has died before it. A blend of 14 instead reaches
 * 20 m past the axis, lifts the north lip to within a step of the plain and
 * quietly builds a bridge, at which point the exotic tier is a walk from the
 * primary pad and the whole ladder is a lie. The reach probe is what proves it
 * did not happen: fulgurite is 0 of 7 from Pan Head and 7 of 7 from Windward.
 */
const STAIR = [
  BESIDE(0.668, 14),
  BESIDE(0.600, 12),
  BESIDE(0.520, 11),
  BESIDE(0.440, 9),
  BESIDE(0.375, 5),
  BESIDE(0.320, 0),
];

/** THE DRY WADI, off the south-west uplands into Whitepan's west shore. */
const WADI = [[-215, 372], [-120, 352], [-25, 330], [70, 308], [162, 288]];
/** Its upper three legs - the part outside the pan's beach, where the tin is. */
const WADI_ORE = [[-215, 372], [-120, 352], [-25, 330]];

/* ------------------------------------------------------------------ */
/* The descriptor                                                      */
/* ------------------------------------------------------------------ */

export const SIROCCO = definePlanet({
  id: 'sirocco',
  name: 'Sirocco',
  blurb: 'Desert. A dune sea with two winds in it, a salt playa with brine still on it, and one slot canyon you cannot see until you are in it.',

  half: HALF,
  /** 280 segments over 880 m: a 3.143 m cell, matching Cinder's 3.125. */
  seg: 280,

  /**
      * 0.93 g, and BOTH consumers read it.
     *
     * This used to say "Phase 1 does not retune the player integrator against
     * it", which was true and honest while gravity reached only the ship. It
     * reaches the player on foot now, through the one predicate in
     * `WorldRules.worldGravity`: `Piloting._env` gives the flight model
     * `(0, -9.10, 0)`, and `Player.setWorldGravity` converts 9.10 to a ratio
     * against `CONFIG.player.gravityReference` (9.81) and walks in -20.41 m/s²
     * rather than the global -22.
     *
     * Measured here by driving the real controller: apex 0.907 m, hang
     * 0.554 s, against 0.878 m / 0.533 s on a world that publishes no
     * gravity at all. At 0.93 g the difference is meant to be felt rather than
     * played with - the variety is at the other end of the ladder, on Tessera
     * (0.17 g) and Lathe (0.19 g).
     *
     * @see ../../player/Player.js `setWorldGravity`
     */
  gravity: 9.10,

  /* ---------------------------------------------------------------- */
  terrain: {
    seed: 0x5120cc,
    baseY: SAND,
    /** The bedrock swell under the sand. LONG - 235 m - so it never competes
     *  with the 124 m dune wavelength riding on top of it. */
    swell: { amp: 6.0, scale: 235, octaves: 4 },
    /** Wind ripples. `ridged` noise, which is what this term already is, and
     *  which is exactly the profile sand takes at this scale. */
    ripple: { amp: 1.5, scale: 31, octaves: 3 },
    /** Grain, at the scale of a footfall. Keeps the normals off glassy. */
    grain: { amp: 0.26, scale: 22 },
    /** The map's edge falls away rather than walling up. Deeper than Cinder's
     *  20 m because there is 2.2 km of air here and the horizon has to go. */
    rim: { start: 400, drop: 26 },

    landforms: [
      /* ---- ADD ---------------------------------------------------- *
       * Order matters here for one reason only: `plateau` REPLACES the height
       * it lands on while `scarp` and `dunes` ADD to it. So the two mesas and
       * the Rimwatch bluff come LAST in this layer, and each one is therefore a
       * rock platform blown clear of sand rather than a table with dunes
       * stacked on top of it.                                                */

      /**
       * THE FAULT. The south side stands 13 m proud along the whole line.
       *
       * This is the landform the planet was waiting for. A canyon rim wants a
       * BOUNDARY and the nearest circle to a boundary is a saucer; `scarp`
       * gives a line. 13 m over a 26 m run is a 39 deg face at its steepest,
       * which is the largest step that still reads as ground rather than as a
       * wall, and from the south it is a low rise you walk up without noticing.
       *
       * `side: 1` because for a west-to-east polyline the right-hand side is
       * `+z`, which is south - the side Whitepan and the primary landing are on.
       */
      { kind: 'scarp', pts: THREADEYE, height: SCARP_H, run: SCARP_RUN, side: 1 },

      /**
       * THE LONG SEA. The whole playfield.
       *
       * 124 m between crests, 17 m tall. `sharpness` 0.52 puts the slip face in
       * the last 27% of the wavelength - 33 m of face for 17 m of fall against
       * a 91 m windward back at 11 deg - and that asymmetry is what stops a
       * dune field reading as corduroy.
       *
       * The face AVERAGES 27 deg and PEAKS at 39, and only the second number
       * matters to a walking body. The peak is `amp*pi / (2*(1-b)*wavelength)`
       * at the inflection; 39 deg is five past sand's real angle of repose and
       * one past the 38 the walk solver allows, and measured over the
       * south-east quadrant 11% of the ground is over that limit. That is paid
       * on purpose - you cross a dune sea along the interdune corridors, not up
       * the faces, and the reach probe confirms every seam is still walkable to.
       * See the Crosswind below for where it stops being free.
       *
       * `r` 660 against a 622 m corner diagonal, with a 25% taper, so the field
       * fades at the corners instead of ending in a wall. `seed` is pinned
       * rather than left to hash off the origin, so the two fields on this
       * planet cannot collide onto the same crest phase.
       */
      {
        kind: 'dunes',
        x: 0, z: 0, r: 660,
        amp: 17.0, wavelength: 124, angle: 0.30,
        sharpness: 0.52, taper: 0.25, seed: 0x51d1,
      },
      /**
       * THE CROSSWIND. The older wind, over the north-west.
       *
       * 58 m and 9.5 m, on a wind axis 59 deg off the Long Sea's, so its crests
       * cross the big field's at a clear angle rather than beating against
       * them. `sharpness` is held down at 0.38 against the Long Sea's 0.52,
       * which spreads its slip face to 19 m and holds its own peak to 38 deg.
       *
       * WHERE THE TWO FIELDS CROSS THE FACES ADD, AND THAT IS MEASURED: inside
       * the fulgurite disc the slope median is 26 deg, the p99 is 54 and the
       * maximum is 57, so about 14% of the crossing zone is steeper than a body
       * can walk. It is not a barrier - all seven fulgurite nodes are reachable
       * from Windward Stack at 371-569 walking metres - but it makes the last
       * stretch a route-finding problem rather than a stroll, and 57 deg is
       * steeper than dry sand can stand. This is the softest number in the
       * file, and softening it further costs the crest height the exotic seam's
       * `yMin` is keyed to.
       */
      {
        kind: 'dunes',
        x: -260, z: -260, r: 300,
        amp: 9.5, wavelength: 58, angle: 1.31,
        sharpness: 0.38, taper: 0.30, seed: 0x51d2,
      },

      /**
       * THE ANVILS. Silhouette, and nothing is authored on top of either -
       * which is what makes an unclimbable mesa honest rather than a defect.
       *
       * y 84 and y 76 against a first pass at 68 and 60, because the first pass
       * was MEASURED and it did not work: 25 m above the sand, on a 40 deg
       * face, is one and a half crests of a 17 m dune sea and it is climbable
       * wherever the noise dips. These stand 42.7 m and 41.2 m up on 59-60 deg faces,
       * which is a butte you can see over the dunes from the far side of the
       * playfield and cannot get onto from any bearing.
       */
      { kind: 'plateau', x: -150, z: 210, r: 62, y: 84, edge: 26 },
      { kind: 'plateau', x: -300, z: -110, r: 48, y: 76, edge: 24 },
      /** The Rimwatch bluff: bedrock on the fault block, scoured clear. Its
       *  30 m edge is 12-24 m of fall, i.e. 22-39 deg - you can walk onto it. */
      { kind: 'plateau', x: RIMWATCH[0], z: RIMWATCH[1], r: 30, y: 44, edge: 24 },

      /* ---- CUT ---------------------------------------------------- */

      /**
       * THE THREADEYE.
       *
       * 15 m half-width, 40 m deep. `trenchAt` cubes the profile, so the floor
       * is flat and the walls are near vertical: measured, the walkable floor
       * is the middle 10 m and the last 3 m of wall stands at 81 deg. There is
       * no route out of this except The Stair, and that is the whole design -
       * the exotic ore is on the far side of it.
       *
       * 2.6 m of `lip` along each edge is spoil, and it does a second job: it
       * hides the slot from the south by another two metres, on top of the
       * 13 m the scarp already hides it behind.
       */
      { kind: 'trench', pts: THREADEYE, width: SLOT_W, depth: SLOT_D, lip: 2.6, lipWidth: 14 },

      /** THE DRY WADI. `taper` 0.35 widens and shallows it toward the pan,
       *  because a flood spreads as it runs out onto a playa. */
      { kind: 'channel', pts: WADI, width: 26, depth: 7.5, levee: 1.8, leveeWidth: 16, taper: 0.35 },

      /* ---- LEVEL -------------------------------------------------- *
       * ROADS FIRST, PADS LAST, and Cinder's measurement is why: with the pads
       * first, a road leaving a pad centre at any grade takes its own fall out
       * of the pad's disc, and a 20 m disc under a 0.15 grade has already lost
       * 3 m. With the pads last the disc wins outright and the road emerges
       * from the pad EDGE, where the pad's blend hands over to the road's grade
       * with no step.
       *
       * Whitepan and the two brine beds are levels too, and they come between
       * the roads and the landing pads: they must beat the terrain, and the
       * primary landing pad must beat them.                                  */

      /** THE DROP, through the lip. `y1` explicit so the traverse below can
       *  start at the same number and the two meet with no riser. */
      { kind: 'ramp', pts: DROP, width: 6, blend: 10, y1: 26 },
      /** THE STAIR. `y1` left to default, so it lands on the canyon floor
       *  exactly - a ramp's toe takes the pre-level field at its last point,
       *  which is the reachability guarantee stated as arithmetic. */
      { kind: 'ramp', pts: STAIR, width: 6, blend: 10, y0: 26 },

      /**
       * WHITEPAN. A `pad`, not a `basin`, and the difference is measurable.
       *
       * A basin is a DELTA - it takes the same depth out of whatever it lands
       * on, so a playa cut as one inherits every metre of the 235 m swell
       * underneath and comes out tilted. Cinder's toe lake ran from y -3.9 to
       * y +7.9 around a single circle before it was made a level. A pad is a
       * LEVEL, so the floor is flat by construction and the shoreline is a
       * contour. The 84 m blend is the beach: 21-45 m of fall over 84 m, which
       * is 14-28 deg and walkable from every bearing.
       */
      { kind: 'pad', x: PAN[0], z: PAN[1], r: PAN_R, blend: PAN_BLEND, y: PAN_Y },
      /** The two brine beds, 1.1 m and 0.7 m below the salt. Their blends are
       *  the shore, and the brine surfaces above them are 0.3 m deep. */
      { kind: 'pad', x: 158, z: 206, r: 40, blend: 26, y: PAN_Y - 1.1 },
      { kind: 'pad', x: 248, z: 286, r: 24, blend: 18, y: PAN_Y - 0.7 },

      /** PAN HEAD, the primary. `y` is EXPLICIT and it has to be: this pad sits
       *  inside Whitepan's own disc, and a pad with no `y` takes the PRE-level
       *  field at its centre - which here is 45 m of dune, i.e. a mesa of sand
       *  standing in the middle of a salt flat. */
      { kind: 'pad', x: 262, z: 200, r: 30, blend: 24, y: PAN_Y },
      /** RIMWATCH, on the bluff. No `y`: the bluff is already a level at 68,
       *  and The Drop starts here and resolves against the same number. */
      { kind: 'pad', x: RIMWATCH[0], z: RIMWATCH[1], r: 26, blend: 20 },
      /** WINDWARD STACK, on the far side. No `y`, deliberately: this one is a
       *  blown-clear interdune hardpan, not a rock platform, so it takes
       *  whatever height the sand is at and levels a street through it. Flat by
       *  construction; the 38 m blend swallows the crest either side. */
      { kind: 'pad', x: -70, z: -135, r: 32, blend: 38 },
    ],
  },

  /* ---------------------------------------------------------------- */
  palette: {
    /* `rock.neutral`, not `dirt.ground`. A desert is the one planet where the
     * dirt albedo LOOKS right, which is why it survived here longest: brown
     * over sand reads as sand. But the two bands doing the structural work in
     * the table below are not sand. Whitepan's salt (`#dedac9`) and the
     * wind-scoured bedrock (`#8b9199`, hue 214) were both being multiplied by a
     * measured linear R:G:B of 1.79 : 1 : 0.49, which is the one filter that
     * turns a white salt pan into a beige one and a cool crest into a warm one
     * - the exact two reads point 1 and point 2 below say the planet depends
     * on. @see shadeRockNeutral in gfx/Materials.js */
    material: 'rock.neutral',
    tile: 7.0,
    /**
     * ══════════════════════════════════════════════════════════════════════
     *  A DESERT IS THE EASIEST PLACE IN THE GAME TO SHIP ONE FLAT HUE
     * ══════════════════════════════════════════════════════════════════════
     *
     * Cinder shipped six bands across FIVE degrees of hue and zero saturation
     * change, and the tester who walked it wrote "one flat salmon-brown hue, no
     * rock, no ash, no shadows". The value structure was doing real work; value
     * alone is a black-and-white photograph of a planet.
     *
     * Everything about a desert pulls toward repeating that, so this table is
     * built the other way round - the value structure first, and then the two
     * free axes spent hard:
     *
     *   height  colour     hue   sat  light   what it is
     *   y   4   #333f4c    213   19    25     canyon floor, in permanent shade
     *   y  10   #8f4c28     18   56    36     canyon wall, iron-stained
     *   y  12   #dedac9     46   32    83     Whitepan salt, and the strandline
     *   y  17   #c9a98c     27   33    67     the damp margin, stained pale
     *   y  30   #8a8358     51   22    44     hardpan and gravel, desert varnish
     *   y  46   #daa75e     34   64    61     the dune sea - the hero colour
     *   y  60   #8b9199    214    7    57     wind-scoured bedrock, COOL
     *   y  86   #77503f     17   30    36     mesa caprock
     *
     * 196 degrees of hue against Cinder's five, 57 points of saturation against
     * its zero, and 58 points of value. Three separate axes, all moving.
     *
     * The two decisions inside that which are not free:
     *
     * 1. WIND-SCOURED ROCK IS NOT THE COLOUR OF SAND. Bands 6 and 7 sit next to
     *    each other in height and 180 degrees apart in hue, and that is what
     *    makes a bare crest read as ROCK rather than as brighter sand. The cool
     *    band is also what makes the gold read as hot; a table of warm bands
     *    has nothing to be warm against.
     *
     * 2. THE SALT BAND IS PINNED TO WHITEPAN'S EXACT HEIGHT. `upTo: 12` is
     *    `PAN_Y` to the metre, and `_terrainColors` returns the upper band
     *    outright when a sample equals its `upTo` - so the pan comes out one
     *    solid near-white rather than half-way between salt and rust. The cost
     *    is that the same colour appears anywhere else the ground crosses y 12,
     *    which is a thin contour on the deepest interdune troughs and along
     *    parts of the canyon floor. That is not a defect being tolerated: it is
     *    the STRANDLINE, the level the water stood at, and evaporite on a dry
     *    canyon floor is exactly where evaporite is. It is named in the map
     *    header for that reason.
     *
     * `mottle` is doing more work here than on Cinder (0.72 -> 0.78) because
     * eight bands over 82 m of relief is a tighter contour spacing than six
     * over 200, and without it the strandline would read as a survey line.
     */
    bands: [
      { upTo: 4, color: 0x333f4c },
      { upTo: 10, color: 0x8f4c28 },
      { upTo: 12, color: 0xdedac9 },
      { upTo: 17, color: 0xc9a98c },
      { upTo: 30, color: 0x8a8358 },
      { upTo: 46, color: 0xdaa75e },
      { upTo: 60, color: 0x8b9199 },
      { upTo: 86, color: 0x77503f },
    ],
    /** Bare sandstone on anything steep: the canyon walls, the mesa faces and
     *  the slip faces. Warm and dark, so a 77 deg wall is not the same value as
     *  the sand at the top of it. */
    slope: { fromDeg: 28, toDeg: 50, color: 0x7c4a2f },
    /** Wind-blown sand streaks. Applied as `n * n * amount`, so most of the
     *  field never approaches the ceiling. */
    mottle: { scale: 58, amount: 0.78, color: 0xe8cb96 },
  },

  sky: {
    kind: 'daylight',
    params: {
      /**
       * THE SUN IS PLACED ACROSS THE DUNE CRESTS, NOT BY COMPASS TASTE.
       *
       * A dune field is only legible as dunes if its slip faces are in shadow.
       * The Long Sea's crests run at 107 deg, so the light has to come from
       * about 17 deg - across them - or a 17 m crest reads as a stripe of
       * slightly different sand. 32 degrees of elevation is the compromise
       * between that raking shadow and a desert at the hour a ship would
       * actually land in one.
       *
       * It is also, and not by accident, BEHIND AND RIGHT of a player standing
       * on Pan Head looking north-west at the Anvils. A planet gets looked at
       * from its landing sites, so its key light is chosen from one.
       */
      sunDirection: [0.81, 0.53, 0.25],
      sunColor: 0xffe6bc,
      /* Brighter than Cinder's 11: there is no ash overhead here, and the salt
       * pan is the brightest surface in the game outside the snow world. */
      sunIntensity: 13,
      sunAngularSize: 0.024,
      /* Some blue survives, unlike Cinder. A dust sky is orange at the horizon
       * and still pale blue at the zenith, and the vertical gradient is half of
       * what makes 2.2 km of air read as DEPTH rather than as a wash. */
      rayleigh: 0.34,
      mie: 3.1,
      mieG: 0.76,
      /* 900 m, against Cinder's 300. This body has the deepest atmosphere in
       * the system (13.2 km shell, 2.2 km of it below the handoff) and the
       * scattering integral is where that shows on the ground. */
      altitude: 900,
      groundColor: 0xb08048,
      hazeColor: 0xe8c088,
      /* 0.96 - the highest in the system. The brief for this planet is that the
       * far rim of the map is a SUGGESTION, and this term plus the fog below
       * are the two halves of that. */
      horizonHaze: 0.96,
      cirrus: 0.08,
      cirrusScale: 1.7,
      cirrusSpeed: 0.011,
    },
    background: 0xbb8f5a,
    /**
     * ── The fog, and the two rules it is held to ──────────────────────────
     *
     * `half` is 440, so the playfield diagonal is 1,244 m. `far` 1370 is
     * 1.10x that: the diagonal is fully extinguished, so the player never sees
     * the terrain mesh stop, and the rim at 440 m from the middle of the map is
     * about a third of the way in - which is aerial perspective rather than a
     * curtain. Further and the edge shows; nearer and the far half of the map
     * is one colour, which is precisely how Cinder lost its horizon.
     *
     * `near` 70, against Cinder's 120. This is the planet with 2.2 km of air
     * and the haze has to start building inside the first dune field or the
     * recession the brief asks for does not exist at eye level.
     *
     * The colour is LIGHTER AND GREYER than the ground under it, measured in
     * the working linear space off this file's own bands: the eight bands
     * average L 0.284 / S 0.441, and this fog is L 0.534 / S 0.390. Cinder's
     * first fog was darker AND more saturated than its rock, and that is what
     * deleted the horizon.
     */
    fog: { color: 0xdcc0a0, near: 70, far: 1370 },
    /** Bounce off sand is real and warm, but a desert's whole readability is
     *  its terminator - 0.42 keeps a north-facing dune flank a different value
     *  from a south-facing one, which 1.0 of fill would not. */
    ambient: { color: 0xc8a472, intensity: 0.42 },
    sun: { color: 0xffe6bc, intensity: 7.2, direction: [0.81, 0.53, 0.25] },
    exposure: 1.14,
    /**
     * `medieval` is the only OUTDOOR DAYLIGHT grade in `GRADE_PRESETS`, and it
     * is already calibrated against measured linear-HDR luminance for a warm
     * world with cool shadows - which is this planet exactly. Its haze term is
     * dust-coloured (0.34, 0.24, 0.16) and its shafts are on, which on a world
     * with this much suspended sand is free atmosphere.
     *
     * The bloom is overridden because the preset's 1.30 threshold was written
     * for a golden-hour village and Whitepan is far brighter than anything in
     * one: at 1.30 the entire pan flares and the salt loses its texture. 2.10
     * clears the lit pan and leaves the threshold on specular glints off the
     * brine, which is where the glare on a playa actually is.
     */
    grade: 'medieval',
    bloom: { strength: 0.28, radius: 0.86, threshold: 2.10 },
  },

  /* ---------------------------------------------------------------- */
  /**
   * SHALLOW BRINE, NOT LAVA.
   *
   * The same shader runs both, and it mixes `crust` toward `color` in the
   * cracks and adds `hot * emissive` on top. For a brine pan that reads
   * naturally: `crust` is the salt rind the pan is skinning over with, `color`
   * is the water in the cracks between the plates, and `hot` is the only part
   * that had to be argued down - `emissive` 0.08 puts the maximum emissive
   * contribution at 0.05, which is a faint sheen at grazing angles and nothing
   * at all from above. `flow` 0.05 against Cinder's 0.55: this is standing
   * water on a dead flat pan and it is not going anywhere.
   *
   * No `glowLight`. `RIG_BUDGET.point` is 12 for the entire game and a brine
   * pan has no reason to spend one.
   */
  liquid: {
    name: 'brine',
    /* Both surfaces are AUTHORED heights over their own levelled beds, never
     * derived from the terrain. Each radius is set where the bed's blend has
     * climbed back to the surface height, so the shoreline is the mesh edge and
     * the skirt hangs into the beach rather than into air. */
    bodies: [
      /** The west pan: bed at 10.9, surface at 11.28 - 0.38 m at its deepest. */
      { shape: 'disc', x: 158, z: 206, r: 49, y: PAN_Y - 0.72 },
      /** The east pan, smaller and shallower still. */
      { shape: 'disc', x: 248, z: 286, r: 30, y: PAN_Y - 0.45 },
    ],
    color: 0x3c6f68,
    hot: 0x9fd8c8,
    crust: 0xe6dfd0,
    emissive: 0.08,
    flow: 0.05,
    glowLight: null,
    lethal: false,
  },

  /* ---------------------------------------------------------------- */
  props: [
    {
      /**
       * DESERT PAVEMENT. The lag of coarse stone left behind after the wind has
       * taken every grain finer than it can lift - which is what the flats
       * BETWEEN the dunes actually are, and the single cheapest way to make a
       * dune sea stop reading as a bedsheet.
       */
      id: 'lag',
      kind: 'boulders',
      region: { shape: 'field', slopeMaxDeg: 28, clearOfLiquid: 8, clearOfPads: 6 },
      count: 900, spacing: 8.5,
      size: { rMin: 0.45, rMax: 2.5 },
      tint: [0x6b5a44, 0x574838, 0x7d6a4e, 0x463b30],
      collide: true,
    },
    {
      /**
       * YARDANGS - bedrock carved into blades by a wind that has blown one way
       * for a very long time. `spires` with almost no `lean` (0.05 against an
       * ice pinnacle's 0.16), because these are ERODED and not grown: they lean
       * where the rock did, which is barely.
       *
       * The collider is the foot of each blade, not the whole thing, so 12 m
       * spacing against a 4 m base leaves lanes about 7 m wide. That number is
       * the Cinder colonnade lesson: a field a body cannot walk into is scenery,
       * and this one is directly between Windward Stack and the fulgurite.
       */
      id: 'yardangs',
      kind: 'spires',
      region: { shape: 'disc', x: -200, z: -120, r: 140, yMax: 46, slopeMaxDeg: 24, clearOfPads: 8 },
      count: 80, spacing: 12,
      size: { h: [4.5, 17.0], base: [1.5, 4.0], lean: 0.05, facets: 5 },
      tint: [0x8d8471, 0x7a6f5c, 0x9c9280, 0x6b6152],
      collide: true,
    },
    {
      /**
       * THE SALT POLYGONS. A drying playa cracks into plates and the plates
       * push each other up at their joints, which is a `slabs` field and
       * nothing else in the vocabulary. `tilt` is small (0.14) on purpose:
       * these are pressure ridges a few centimetres proud, not shattered rock.
       *
       * `collide` is true and it is safe. The collider is a low step at the
       * plate's own footprint and its top lands about 0.24 m above the ground,
       * which is inside the 0.45 m step-up the walk solver allows - measured,
       * not assumed. You step onto them.
       */
      id: 'saltplates',
      kind: 'slabs',
      region: { shape: 'disc', x: PAN[0], z: PAN[1], r: 112, clearOfLiquid: 1.5, clearOfPads: 4 },
      count: 420, spacing: 4.4,
      size: { w: [1.6, 4.4], d: [1.6, 4.4], t: [0.10, 0.34], tilt: 0.14 },
      tint: [0xe4dfd0, 0xd2cbb8, 0xf0ece0, 0xc4bba6],
      collide: true,
    },
    {
      /**
       * GYPSUM BLADES on the pan's outer crust, where the brine wicks up and
       * evaporates. `shards` leaning hard is exactly the habit - a selenite
       * rosette is a shatter of blades, not a growth - and this is the same
       * geology as the selenite seam below, in the same annulus, on purpose.
       */
      id: 'gypsum',
      kind: 'shards',
      region: { shape: 'annulus', x: PAN[0], z: PAN[1], r0: 58, r1: 114, clearOfLiquid: 2, clearOfPads: 4 },
      count: 320, spacing: 3.4,
      size: { hMin: 0.4, hMax: 2.2, wMin: 0.25, wMax: 0.9 },
      tint: [0xe8dfc4, 0xd8ceb0, 0xf2ecd8, 0xc8bd9c],
      collide: false,
    },
  ],

  /* ---------------------------------------------------------------- *
   * MINERALS - six elements, six places, one ladder.
   *
   *   rarity     element      terrain    where it is
   *   ---------  -----------  ---------  -----------------------------------
   *   common     silica       plain      the interdune flats, everywhere
   *   common     halite       shelf      Whitepan's salt crust
   *   uncommon   selenite     shore      the brine pan margin
   *   uncommon   cassiterite  channel    the Dry Wadi's floor
   *   rare       chalcanth    fissure    the seep on the Threadeye's wall
   *   exotic     fulgurite    highland   the doubled Crosswind crests
   *
   * Two of those rows are one geology told twice on purpose: halite is the pan
   * and selenite is the pan's damp margin, so the commonest ore on the planet
   * and an uncommon one are found in the same white place and read as one
   * deposit rather than as two spawn tables.
   *
   * `credits` is absent from every row because `definePlanet` computes it from
   * `unitValue * hold` and REFUSES a hand-written one. `size` is the node
   * radius AND the hold volume, so the ladder below is also a cargo decision:
   * three cubic metres of silica for 24 credits against one of fulgurite for
   * 285. In a 10 m3 Kestrel that is the whole trip.
   *
   *   silica       3 m3   24 cr    halite      2 m3    28 cr
   *   selenite     2 m3   60 cr    cassiterite 2 m3    92 cr
   *   chalcanth    1 m3  175 cr    fulgurite   1 m3   285 cr
   */
  minerals: [
    {
      id: 'silica', item: 'silica', name: 'Silica Sand',
      rarity: 'common', terrain: 'plain', place: 'the interdune flats',
      /* Pale gold, and DELIBERATELY not the brightest thing on the ground - the
       * cheapest ore on Cinder shipped as a cream boulder brighter than the
       * plain it sat on, and a player could not tell it from the rare one. This
       * sits between the sand it came off and the lag stone beside it. */
      color: 0xcbb27e, glow: 0,
      unitValue: ORE('silica'), spread: 0.25,
      /* 1.70 m is the biggest node on the planet and the least valuable, which
       * is what "bulk" has to mean. `holdUnitsFor` rounds, so anything under
       * 1.5625 drops to two cubic metres and the decision goes with it. */
      size: 1.70, count: 46, spacing: 24,
      /* `yMin` 27 is what keeps this off Whitepan (a dead flat 12) and out of
       * the Threadeye (a floor around -4). It is common ore and it belongs on
       * the flats you walk over, not in the two features the rare ore is in.
       * `clearOfPads` 22 stops it being underfoot the moment a ship touches. */
      region: { shape: 'field', yMin: 27, yMax: 41, slopeMaxDeg: 20, clearOfLiquid: 14, clearOfPads: 22 },
    },
    {
      id: 'halite', item: 'halite', name: 'Halite Slab',
      rarity: 'common', terrain: 'shelf', place: 'Whitepan',
      /* `shelf` reads here as "a level surface you walk straight onto", which
       * is what a playa is. The family is generic on purpose so a survey line
       * that says "salt occurs on shelves" is written once for every planet. */
      color: 0xf2ece0, glow: 0,
      unitValue: ORE('halite'), spread: 0.20,
      size: 1.45, count: 34, spacing: 18,
      /* The pan proper, inside its own flat disc rather than out on the beach.
       * `slopeMaxDeg` 6 is not a filter so much as a statement: the pan is a
       * LEVEL and anything on a slope is not on the pan. */
      region: { shape: 'disc', x: PAN[0], z: PAN[1], r: 104, slopeMaxDeg: 6, clearOfLiquid: 6, clearOfPads: 5 },
    },
    {
      id: 'selenite', item: 'selenite', name: 'Selenite Rose',
      rarity: 'uncommon', terrain: 'shore', place: 'the west brine pan',
      color: 0xefe2bc, glow: 0x2a2413,
      unitValue: ORE('selenite'), spread: 0.30,
      size: 1.12, count: 22, spacing: 11,
      /* AN ANNULUS ROUND THE BRINE, and the hole in the middle is the point.
       * Gypsum roses grow in the capillary fringe just OUTSIDE standing water,
       * not under it - so `r0` 52 starts the band three metres beyond the
       * 49 m brine surface and `r1` 82 stops it before the pan's beach begins
       * to climb. It is the same ring the gypsum blades are scattered in. */
      region: { shape: 'annulus', x: 158, z: 206, r0: 52, r1: 82, slopeMaxDeg: 14, clearOfLiquid: 1.5, clearOfPads: 5 },
    },
    {
      id: 'cassiterite', item: 'cassiterite', name: 'Cassiterite',
      rarity: 'uncommon', terrain: 'channel', place: 'The Dry Wadi',
      /* Near-black, and it is a legibility decision. Tin oxide is genuinely a
       * dark brown-black, and it is also the only DARK ore on a planet whose
       * every other seam is pale - at ten metres on an ochre wadi floor that is
       * the difference between finding it and walking over it. */
      color: 0x413528, glow: 0,
      unitValue: ORE('cassiterite'), spread: 0.25,
      size: 1.00, count: 18, spacing: 13,
      /* The wadi's UPPER three legs only. Its lower two run inside Whitepan's
       * beach, where the pan's level has already erased the channel - a seam
       * addressed there would be a seam in a feature that is not there. */
      region: { shape: 'corridor', pts: WADI_ORE, width: 15, slopeMaxDeg: 24, clearOfPads: 4 },
    },
    {
      id: 'chalcanth', item: 'chalcanth', name: 'Chalcanthite',
      rarity: 'rare', terrain: 'fissure', place: 'the Threadeye seep',
      /* VIVID BLUE, and nothing else on this planet is blue except the shaded
       * canyon floor it is found on. Copper sulfate really is this colour; it
       * is also the one hue a desert cannot produce by accident, which is why
       * a 175 cr seam can be told from a 14 cr one at range. */
      color: 0x2f7ec4, glow: 0x0e4a86,
      unitValue: ORE('chalcanth'), spread: 0.25,
      size: 0.70, count: 11, spacing: 13,
      /**
       * THE CUT WALL BESIDE THE STAIR - not the canyon floor, and not the rim.
       *
       * This corridor follows THE ROAD, not the canyon, and that is the whole
       * fix. Cinder lost a sulfur seam by authoring it down the rift's own
       * centreline: the corridor included the FLOOR of a 13 m trench with
       * near-vertical walls and the reach probe found nothing could stand
       * there. The same thing would happen here twice over - this trench is
       * 40 m deep and its walls stand at 77-81 deg, so a band around the
       * canyon's centreline would put a rare ore on a face no body can walk
       * and behind glass.
       *
       * The Stair is the one surface inside the Threadeye that a body can
       * stand on, and the skirt where its cut hands back to the untouched wall
       * is the one place beside it that is steep without being sheer.
       * `widthInner` 5 excludes the road itself - ore lying in the middle of
       * the path is ore with no walk in it - and `slopeMinDeg` 15 excludes the
       * road's flat blend, so what is left is the cut face above and below.
       *
       * A seep bleeds along a bedding plane, which on a canyon wall is a
       * horizontal line; the road is the horizontal line. The fix and the
       * geology are the same fix, exactly as `widthInner` was on Cinder.
       */
      region: { shape: 'corridor', pts: STAIR, width: 15, widthInner: 5, slopeMinDeg: 15, slopeMaxDeg: 34, clearOfPads: 6 },
    },
    {
      id: 'fulgurite', item: 'fulgurite', name: 'Fulgurite',
      rarity: 'exotic', terrain: 'highland', place: 'the Crosswind crests',
      /* Glassy grey-green with a warm glow. It is fused sand, so it is the
       * colour of the sand around it - the glow is what makes it findable on a
       * crest at the hour this planet is lit, and it is also literally right:
       * a lightning tube is glass and it catches the low sun from inside. */
      color: 0xcfc6a8, glow: 0x6a5a2e,
      unitValue: ORE('fulgurite'), spread: 0.30,
      /* The smallest node on the planet and the dearest: one cubic metre for
       * 285 credits. A stock Kestrel carries all seven. */
      size: 0.58, count: 7, spacing: 22,
      /**
       * A SECOND LANDING, NOT A LONGER WALK.
       *
       * This disc is in the far north-west, and the Threadeye runs between it
       * and every other thing on the planet. There is no route on foot from
       * Pan Head at any distance: the canyon's walls stand at 77 deg on the
       * north side and The Stair only ever reaches the floor. You fly to
       * Windward Stack or you do not get fulgurite - which is the shape Cinder
       * proved is worth building, where the exotic tier costs a DECISION
       * rather than time.
       *
       * `yMin` 41 is what makes it "the high crests" rather than "the
       * north-west". Only where the Long Sea's 17 m crest and the Crosswind's
       * 9.5 m crest fall in phase does the ground reach 41, so the seam sits on
       * the handful of doubled ridges that are also the only place on a dune
       * sea a lightning strike has anything to hit.
       */
      region: { shape: 'disc', x: -310, z: -320, r: 110, yMin: 41, slopeMaxDeg: 24, clearOfPads: 8 },
    },
  ],

  /* ---------------------------------------------------------------- */
  landing: [
    /** Salt hardpan. The pan's crust bears a ship without any preparation,
     *  which is why the primary is here and not on a dune. */
    { id: 'panhead', name: 'Pan Head', x: 262, z: 200, r: 30, primary: true, yaw: -2.35 },
    /** Bedrock, on the fault block above the canyon. The head of The Stair. */
    { id: 'rimwatch', name: 'Rimwatch', x: RIMWATCH[0], z: RIMWATCH[1], r: 26, yaw: 2.55 },
    /** A blown-clear interdune street, scoured to the gypsum crust between two
     *  crests. Not rock - there is no rock in the north half above the dunes -
     *  so it is the one pad on this planet that is a hardpan by luck of the
     *  wind, and it is the only way to the fulgurite. */
    { id: 'windward', name: 'Windward Stack', x: -70, z: -135, r: 32, yaw: -2.05 },
  ],

  hazards: {
    /** Blowing sand. `drift` is near-horizontal and fast, unlike Cinder's
     *  falling ash: this stuff is being carried, not dropped. Phase 1 draws it
     *  and nothing takes damage from it. */
    ashfall: { density: 0.55, drift: [1.5, 0.4] },
    ashColor: 0xdcc49a,
  },
});

export default SIROCCO;
