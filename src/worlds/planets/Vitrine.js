/**
 * VITRINE - the ice world, and the cold one.
 *
 * Everything here is data. No `three`, no functions inside the record, no world
 * class: `PlanetWorld` renders this exactly as it renders Cinder, and the only
 * thing that makes this an ice sheet rather than a volcano is the numbers below.
 *
 * ==========================================================================
 *  THE MAP, in words
 * ==========================================================================
 *
 * 920 m square, `+x` east and `+z` south. Two ice sheets at two levels: the
 * ACCUMULATION zone in the north at y 58 and the ABLATION zone in the south at
 * y 46, divided by one long fault line across the middle of the map.
 *
 *   THE ABLATION FRONT   the `scarp` that divides them. A 12 m step running the
 *                        whole width of the map at z ~ 34-62, high side north.
 *                        It is the one landform on the planet whose edge is a
 *                        LINE, and it is the reason a screenshot of Vitrine has
 *                        a horizontal in it. Deliberately WALKABLE - 12 m over a
 *                        32 m run is 29 deg - because a fault that cut the map
 *                        in two would put the Shatter behind glass.
 *
 *   THE FIRN SHELF       the accumulation zone proper, centred (-140, -268): a
 *                        140 m table at y 73, clean white snow, its surface
 *                        combed into sastrugi by a `dunes` field at a 17 m
 *                        wavelength. Clathrate ice is cut here. You walk
 *                        straight onto it from any bearing - 29 deg of edge.
 *
 *   BLACKHORN            the nunatak, centred (215, 96). Rock through ice: a
 *                        132 m shield rising 54 m out of the sheet, its top
 *                        replaced by a 54 m bench at y 102 behind a 70 deg
 *                        cliff, with a 38 m horn standing off the bench at
 *                        (196, 66) to a summit of 140. It is the silhouette
 *                        from everywhere on the map and the only warm colour
 *                        on the planet. Cryolite is on the bench.
 *
 *   THE HORN ROAD        the only way onto the bench on foot. A `ramp` that
 *                        leaves the Blackhorn pad and spirals 288 deg round the
 *                        bench rim at 9.5 deg, out to the flank. It exists
 *                        because a bench you can see and cannot reach is the
 *                        exact defect this project keeps shipping, and because
 *                        cryolite is UNCOMMON - the primary pad has to reach it.
 *
 *   THE SHATTER          the crevasse field, and the planet's signature. Five
 *                        en-echelon `trench` cuts across the south, the master
 *                        one 465 m long. MEASURED at five stations along it:
 *                        28.7-30.0 m from spoil lip to floor, 24 m wide, and
 *                        the wall stands at 81 deg at every one of them. That
 *                        is the number that decides whether these read as holes
 *                        or as valleys, and 81 deg is a hole. Azurine is on the
 *                        lips.
 *
 *   THE NECK             the 60 m gate between the Vault's cliff and the
 *                        Shatter's west end. It is the only comfortable way into
 *                        the southern third of the map on foot, and it was
 *                        measured rather than hoped for.
 *
 *   THE HYALINE VAULT    the collapsed subglacial chamber at (-268, 236). A
 *                        118 m ring of upthrust ice at y 66 behind a 66 deg
 *                        cliff, and inside it a 86 m basin whose floor is a
 *                        dead-flat 18 - 48 m below the rim and 28 m below the
 *                        sheet outside. Ringed with ice columns and floored
 *                        with the fallen plates of its own roof. Hyaline is
 *                        here, and it is UNREACHABLE from the primary pad.
 *
 *   THE VAULT ROAD       the way down into it. A `ramp` from the Vaultmouth pad
 *                        spiralling 264 deg down the inner wall at 10.2 deg.
 *                        Deleting it costs the exotic tier entirely.
 *
 *   THREE MELT PONDS     supraglacial water in the ablation zone, skinned over.
 *                        See the `liquid` block for why they are here at all.
 *
 * ==========================================================================
 *  WHY THE NUMBERS ARE THESE NUMBERS
 * ==========================================================================
 *
 * RELIEF BUDGET. The swell/ripple/grain/sastrugi amplitudes total 11.5 m
 * against 122 m of authored relief (vault floor 18 to horn summit 140). The
 * noise is the last 9% and its whole job is to stop the authored shapes reading
 * as CAD - it is not what makes the planet interesting, the landforms are.
 *
 * THE TWO ROADS ARE FITTED, NOT DRAWN. A `ramp` interpolates LINEARLY in
 * arclength between its head and its toe, and the ground it crosses does not.
 * Run a constant-grade road straight down a convex flank and it leaves the
 * ground behind: the first attempt at the Horn Road was a radial line from the
 * bench out to the sheet, and at its middle it stood 26 m in the air - a 24 m
 * blend hanging a causeway across the nunatak. Both roads here are SPIRALS
 * whose radius at every vertex was chosen so the ground height at that radius
 * equals the ramp's own height at that arclength. Measured deviation: the Horn
 * Road is within 1.0 m of the ground at every vertex, the Vault Road within
 * 0.5 m. That is the difference between a road cut and a viaduct, and it is why
 * the vertex lists below look arbitrary and are not.
 *
 * WHAT WAS ACTUALLY MEASURED, against the real height field and the real
 * colliders, on a 2 m lattice with no jump and no mantle:
 *
 *   361,201 height samples      0 non-finite, range 14.79 .. 139.32 m
 *   pad flatness                firn 0.00 m, blackhorn 0.00 m, vaultmouth 0.00 m
 *   every prop and mineral      placed = requested, all eleven fields
 *
 *   seam        tier      reachable   nearest walk   from
 *   ----------  --------  ----------  -------------  ----------------------
 *   rime        common      42/42        44 m        firn
 *   clathrate   common      30/30       183 m        firn
 *   cryolite    uncommon    20/20        24 m        blackhorn (also from firn)
 *   azurine     rare        12/12       415 m        firn, through the Neck
 *   hyaline     exotic       8/8        287 m        vaultmouth ONLY
 *
 *   from firn (primary)  : hyaline 0 of 8
 *   from blackhorn       : hyaline 0 of 8
 *   from vaultmouth      : everything else 0, hyaline 8 of 8
 *
 * The last three lines are the design in one block. The exotic tier is not a
 * longer walk, it is a SECOND LANDING, and the vault is an island either way
 * round: you cannot walk out of it any more than you can walk into it.
 *
 * THE COLD IS THE POINT. Cinder is orange dust, Sirocco is orange dust with
 * more of it, Sallow is yellow overcast and Carnelian is rust. This is the one
 * planet in the system with a blue shadow on it, and every choice in `sky` and
 * `palette` below is spent on that rather than on being white. See the palette
 * docblock: an ice world is the easiest possible way to ship Cinder's "one flat
 * hue" defect again, in white instead of salmon.
 */

import { definePlanet } from './PlanetDescriptor.js';
import { ITEMS } from '../../systems/ItemDefs.js';

/**
 * Credits per cubic metre of hold, read off the item catalogue.
 *
 * The price of an element belongs to the ELEMENT and not to the ice it is
 * frozen into: a cubic metre of hyaline is worth the same whether it came off
 * Vitrine's vault floor or off the next ice moon in the registry, and the
 * vendor who buys it reads `ITEMS`. So the number lives there once and this
 * file quotes it. Throwing on a missing row rather than returning `undefined`
 * is the difference between a loud boot failure and a planet whose deposits
 * are all worth NaN.
 *
 * @param {string} id an `ITEMS` id
 * @returns {number} credits per cubic metre
 */
const ORE = (id) => {
  const def = ITEMS[id];
  if (!def) throw new Error(`[Vitrine] mineral names item "${id}", which has no ITEMS row`);
  return def.value;
};

/* ------------------------------------------------------------------ */
/* Frame of reference                                                  */
/* ------------------------------------------------------------------ */

/** Playfield half-extent. */
const HALF = 460;
/** The ABLATION sheet's nominal height - the southern, lower, dirtier ice.
 *  Everything on this planet is quoted against it. */
const SHEET = 46;

const D2R = Math.PI / 180;

/* ---- Blackhorn, the nunatak ---- */
const BX = 215;
const BZ = 96;
/** The bench: flat top of the nunatak, absolute. */
const BENCH_Y = 102;
/** Bench radius and the horizontal run of the cliff around it. 44 m of fall
 *  over 24 m is 70 deg - a wall, and the reason the Horn Road exists. */
const BENCH_R = 54;
const BENCH_EDGE = 24;

/** A point at polar (d, bearing-in-degrees) about the Blackhorn axis. */
const B = (d, deg) => [
  +(BX + d * Math.cos(deg * D2R)).toFixed(1),
  +(BZ + d * Math.sin(deg * D2R)).toFixed(1),
];

/* ---- The Hyaline Vault ---- */
const VX = -268;
const VZ = 236;
/**
 * The rim crest. 20 m above the NOMINAL sheet, and the edge that carries it is
 * 12 m - a 68.2 deg peak face. @see the plateau in the ADD layer for why 18 m
 * of edge was not a wall and 12 is.
 */
const RIM_Y = 66;
/** The vault floor. Dead flat by construction - the basin's inner 40%. */
const VAULT_Y = 18;

/** A point at polar (d, bearing-in-degrees) about the vault axis. */
const V = (d, deg) => [
  +(VX + d * Math.cos(deg * D2R)).toFixed(1),
  +(VZ + d * Math.sin(deg * D2R)).toFixed(1),
];

/* ---- The firn shelf ---- */
const SHELF_X = -140;
const SHELF_Z = -268;

/* ------------------------------------------------------------------ */
/* The lines                                                           */
/* ------------------------------------------------------------------ */

/**
 * The ablation front. A `scarp`, which is the only landform whose edge is a
 * LINE - and the boundary between two ice regimes is a boundary, not a saucer.
 * `side: -1` raises the NORTH half-plane, because accumulation is upstream.
 *
 * The polyline is extended past both ends by `PlanetHeight` before it is
 * sampled, so the raised half-plane does not stop dead at x = +/-470 and leave
 * a 12 m step hanging in mid-air off the end of it.
 */
const FRONT = [[-470, 40], [-230, 60], [10, 34], [250, 62], [470, 44]];

/** Pressure ridges: where two flow units converge and the sheet buckles.
 *  13 m over a 30 m half-width is 33 deg at the steepest - you climb them. */
const RIDGE_A = [[-430, -150], [-300, -128], [-160, -152], [-20, -126], [110, -150]];
const RIDGE_B = [[-120, 150], [10, 126], [140, 154]];
const RIDGE_C = [[-60, -210], [80, -186], [220, -212], [360, -190]];

/**
 * THE SHATTER - the master crevasse, 465 m of it.
 *
 * One polyline and not five, because a `corridor` region takes ONE polyline and
 * azurine has to live on a crevasse the descriptor can name. The other four
 * cuts below are its en-echelon companions: offset, overlapping, with intact
 * ice between their ends. That is what a shear margin actually does, and it is
 * also what makes the field something you ROUTE THROUGH rather than a wall.
 */
const SHATTER = [[-72, 300], [40, 274], [156, 288], [272, 264], [386, 280]];
const SHATTER_B = [[-140, 366], [-30, 344], [80, 358]];
const SHATTER_C = [[128, 372], [240, 350], [352, 364]];
const SHATTER_D = [[318, 244], [410, 258]];
const SHATTER_E = [[-214, 392], [-112, 406]];

/**
 * The Blackhorn landing bench, at d 30 on bearing 150 - inside the bench, well
 * clear of the horn's foot (45.5 m from it against a 26 m footprint).
 */
const HORN_PAD = B(30, 150);

/**
 * THE HORN ROAD, and why every one of these radii is what it is.
 *
 * It STARTS AT THE PAD CENTRE, and that is load-bearing rather than tidy: a
 * `ramp` with no `y0` takes its head height from the pre-level field at its
 * first point, and a `pad` with no `y` does the same thing at the same place.
 * Start the road one metre away and the two resolve to different numbers and
 * the player steps off a riser they cannot see.
 *
 * The radii climb 30 -> 60.6 -> 63.6 -> 66.7 -> 69.8 -> 73.4 -> 89 -> 138 while
 * the bearing sweeps 288 deg. They are not round numbers because they were
 * SOLVED: the bench cliff falls 44 m across the radius band 54-78 on a
 * smoothstep, so a constant-grade ramp only stays on the ground if it spends
 * its arclength in that band in proportion to the height it loses there. Five
 * of the seven legs are inside a 13 m-wide annulus for exactly that reason.
 * Measured cut/fill at the seven vertices: +0.6, +0.1, +0.7, +1.0, +0.8, +0.8,
 * 0.0 m. The radial version of the same road stood 26 m in the air.
 */
const HORN_ROAD = [
  HORN_PAD,
  B(60.6, 196.8),
  B(63.6, 241.0),
  B(66.7, 283.1),
  B(69.8, 323.3),
  B(73.4, 1.6),
  B(89, 33.6),
  B(138, 44.6),
];

/** Vaultmouth, at d 100 on bearing 305 - out on the flat rim annulus (86-118),
 *  14 m clear of the basin lip and 18 m inside the cliff. */
const VAULT_PAD = V(100, 304.8);

/**
 * THE VAULT ROAD. Same construction as the Horn Road and the same reason.
 *
 * The basin wall falls 48 m across the radius band 34-86, so the road descends
 * from d 100 to d 26 over 264 deg of bearing, and the radii were solved against
 * the wall's own smoothstep rather than spaced evenly. Measured cut/fill at the
 * six vertices: +0.5, -0.3, -0.3, +0.1, 0.0, 0.0 m. 10.2 deg of grade.
 *
 * This road is the entire exotic tier. Delete it and hyaline is 0-of-8
 * reachable from anywhere, which is the ablation this design is built around.
 */
const VAULT_ROAD = [
  VAULT_PAD,
  V(72.4, 329.4),
  V(66.0, 7.1),
  V(60.2, 48.5),
  V(54.3, 94.2),
  V(47.7, 145.3),
  V(26, 208.4),
];

/* ---- The primary pad ---- */
const FIRN_PAD = [-150, -30];

/* ------------------------------------------------------------------ */
/* The descriptor                                                      */
/* ------------------------------------------------------------------ */

export const VITRINE = definePlanet({
  id: 'vitrine',
  name: 'Vitrine',
  blurb: 'A glacier over a drowned chamber. Rime on the sheet, clathrate on the firn shelf, cryolite on the nunatak, azurine in the crevasse walls, hyaline in the vault.',

  half: HALF,
  /**
   * 288 segments over 920 m: a 3.194 m cell.
   *
   * Held near Cinder's 3.125 on purpose - the mesh and the collision
   * heightfield are the SAME grid, so this number buys both the silhouette and
   * the surface the player stands on, and a crevasse 24 m wide has to survive
   * being sampled by it. At 3.194 m the master crevasse is 7.5 cells across and
   * its floor is 2.3, which is enough for the hole to be a hole. It is 166,464
   * triangles in one mesh.
   */
  seg: 288,

  /**
      * 0.80 g, and BOTH consumers read it.
     *
     * This used to say "Phase 1 does not retune the player integrator against
     * it", which was true and honest while gravity reached only the ship. It
     * reaches the player on foot now, through the one predicate in
     * `WorldRules.worldGravity`: `Piloting._env` gives the flight model
     * `(0, -7.80, 0)`, and `Player.setWorldGravity` converts 7.80 to a ratio
     * against `CONFIG.player.gravityReference` (9.81) and walks in -17.49 m/s²
     * rather than the global -22.
     *
     * Measured here by driving the real controller: apex 0.993 m, hang
     * 0.598 s, against 0.878 m / 0.533 s on a world that publishes no
     * gravity at all. At 0.80 g the difference is meant to be felt rather than
     * played with - the variety is at the other end of the ladder, on Tessera
     * (0.17 g) and Lathe (0.19 g).
     *
     * @see ../../player/Player.js `setWorldGravity`
     */
  gravity: 7.80,

  /* ---------------------------------------------------------------- */
  terrain: {
    seed: 0x71c3ee,
    baseY: SHEET,
    /** Long ice swells - the sheet flexing over the bed underneath it.
     *  240 m wavelength: one swell per two and a half minutes' walk. */
    swell: { amp: 7.5, scale: 240, octaves: 4 },
    /** Ripples, ridged, so the flanks read as wind-packed drift and not blobs. */
    ripple: { amp: 1.6, scale: 42, octaves: 3 },
    /** Grain, at the scale of a footfall. Keeps the normals off glassy - which
     *  on a WHITE surface is the difference between snow and a blank. */
    grain: { amp: 0.28, scale: 22 },
    /** The map's edge falls away rather than walling up. */
    rim: { start: 424, drop: 26 },

    landforms: [
      /* ---- ADD ---------------------------------------------------- */
      /** The ablation front. First, because everything else stands on it. */
      { kind: 'scarp', pts: FRONT, height: 12, run: 32, side: -1 },

      /** The firn shelf. Absolute, so its top is a table and not a tilted one. */
      { kind: 'plateau', x: SHELF_X, z: SHELF_Z, r: 140, y: 73, edge: 40 },
      /**
       * Sastrugi. A transverse dune field IS what wind does to dry snow, so this
       * is the `dunes` kind used for exactly what it models, at snow scale
       * rather than sand scale: 1.1 m crests every 17 m. That is 5.3 collision
       * cells per wave, which is the shortest wavelength this grid can carry
       * without the field turning into noise. `sharpness` 0.7 puts the slip face
       * in the last fifth of each wavelength, so the shelf has a light and a
       * dark side to every crest under a 31 deg sun - which is the whole reason
       * a white surface has any form in it at all.
       */
      { kind: 'dunes', x: SHELF_X, z: SHELF_Z, r: 175, amp: 1.1, wavelength: 17, angle: 0.55, sharpness: 0.7, taper: 0.30, seed: 0x5a57 },

      /** Pressure ridges. `RIDGE_A` rides up onto the shelf's toe on purpose -
       *  a rampart at the front of an ice shelf is where one belongs. */
      { kind: 'ridge', pts: RIDGE_A, width: 30, height: 13, taper: 0.30 },
      { kind: 'ridge', pts: RIDGE_B, width: 26, height: 10, taper: 0.35 },
      { kind: 'ridge', pts: RIDGE_C, width: 24, height: 9, taper: 0.30 },

      /**
       * Blackhorn. Three records, and the ORDER of them is the shape.
       *
       * The shield first: 54 m over a 132 m radius is 35 deg at its steepest,
       * i.e. WALKABLE to the foot of the bench, so the nunatak is a hill you can
       * climb rather than a wall you cannot. Then the bench, which is a
       * `plateau` and therefore ABSOLUTE - it erases the cone's summit and
       * replaces it with a table at 102 behind a 70 deg cliff. Then the horn,
       * which is a second cone ADDED on top of the bench, so its summit is
       * 102 + 38 = 140 and it stands off-centre where it makes a silhouette
       * instead of a party hat.
       */
      { kind: 'cone', x: BX, z: BZ, r: 132, peak: 54 },
      { kind: 'plateau', x: BX, z: BZ, r: BENCH_R, y: BENCH_Y, edge: BENCH_EDGE },
      { kind: 'cone', x: 196, z: 66, r: 26, peak: 38 },

      /**
       * The vault's ring of upthrust ice, and the ONE number on this planet
       * that had to be re-solved.
       *
       * ── The edge was 18 m, and 18 m was not a wall ────────────────────────
       * `plateauAt` carries the crest down on a smoothstep, so the steepest
       * face is `1.5 * rise / edge`. The first version read that as
       * `1.5 * 20 / 18` = 59 deg and called the vault an island, and it was an
       * island against the 38 deg the reach probes flood at. It was NOT one
       * against the envelope the game actually walks, `acos(WALKABLE_NORMAL_Y)`
       * = 56.63 deg, for two compounding reasons:
       *
       *   1. The rise is not 20 m. It is `RIM_Y` minus the ground the ring
       *      lands on, and the ground west of the vault is the accumulation
       *      side of the `FRONT` scarp at y 48, not the nominal `SHEET` of 46.
       *      Measured on the built field, the climb is 18.1 m.
       *   2. `1.5 * 18.1 / 18` = 1.508, i.e. **56.31 deg** - seven tenths of a
       *      degree UNDER the ceiling, along the whole west flank.
       *
       * Traced: a body walked in from Firn Deck at (-198, 120) y 48.30 and up
       * to the rim annulus at (-236, 126) y 65.90, never exceeding 55.9 deg,
       * and from there took the Vault Road down. All eight hyaline nodes came
       * out reachable from the PRIMARY pad at 367 m, which is the exotic tier's
       * whole design deleted.
       *
       * ── 12 m, and what that buys ─────────────────────────────────────────
       * `1.5 * 18.1 / 12` = 2.263, i.e. **66.2 deg**, and the face is over
       * 56.63 deg across 6.8 m of its 12 m run. That band costs 14.1 m of rise
       * to cross, against a Vitrine jump that clears 1.45 m (0.99 m apex plus
       * the 0.45 m step) and hops 2 m of open ground. It is a wall at 38 deg,
       * at 56.63 deg, and at 56.63 deg with the jump - which is the standard
       * Lathe's rim was re-solved to and the one this file now meets.
       *
       * The crest height and the vault floor are untouched, deliberately: they
       * are what `VAULT_ROAD`'s radii were solved against and what every
       * hyaline node's height resolves from. Only the outward blend moved.
       */
      { kind: 'plateau', x: VX, z: VZ, r: 118, y: RIM_Y, edge: 12 },

      /* ---- CUT ---------------------------------------------------- */
      /**
       * The vault itself. 48 m deep inside the ring, its inner 40% dead flat at
       * 18 - which is 28 m below the ice outside the ring and 48 below the crest.
       * The wall stands at 54 deg, so the floor is unreachable without the road.
       */
      { kind: 'basin', x: VX, z: VZ, r: 86, depth: 48, flat: 0.40 },

      /**
       * THE SHATTER. Cubed walls (`trenchAt` uses `1 - t^3`), so these are
       * fissures and not valleys: the master cut's wall reaches 81 deg at the
       * lip and its floor is flat. 26 m of depth against a 12 m half-width is
       * what makes it read as a HOLE - at 13 m of depth, which is Cinder's rift,
       * the same profile reads as a gully you could scramble out of.
       *
       * `lip` is the spoil each side, and it is not decoration: it is the only
       * standable ground within 27 m of the axis and it is where azurine is.
       */
      { kind: 'trench', pts: SHATTER, width: 12, depth: 26, lip: 2.8, lipWidth: 15 },
      { kind: 'trench', pts: SHATTER_B, width: 10, depth: 21, lip: 2.4, lipWidth: 13 },
      { kind: 'trench', pts: SHATTER_C, width: 11, depth: 23, lip: 2.6, lipWidth: 14 },
      /** This one cuts the nunatak's own flank - a bergschrund, where the ice
       *  pulls away from the rock it is flowing round. */
      { kind: 'trench', pts: SHATTER_D, width: 9, depth: 18, lip: 2.2, lipWidth: 12 },
      { kind: 'trench', pts: SHATTER_E, width: 9, depth: 19, lip: 2.2, lipWidth: 12 },

      /* ---- LEVEL -------------------------------------------------- *
       * ROADS FIRST, PADS LAST. Inside this layer a later form overrides an
       * earlier one where they overlap, and Volcanic.js records what the other
       * order costs: the rim pad lost its flatness to the road leaving it, 3.00
       * m of span across a 20 m disc before and 0.00 m after. With the pads
       * last, each pad's disc wins outright and the road emerges from the pad
       * EDGE, where the pad's blend hands over to the road's own grade.        */

      { kind: 'ramp', pts: HORN_ROAD, width: 8, blend: 16 },
      /** `y1` explicit and equal to the vault floor: the road has to ARRIVE at
       *  the floor, not at whatever the basin happens to be at its last vertex. */
      { kind: 'ramp', pts: VAULT_ROAD, width: 8, blend: 15, y1: VAULT_Y },

      { kind: 'pad', x: FIRN_PAD[0], z: FIRN_PAD[1], r: 30, blend: 24 },
      { kind: 'pad', x: HORN_PAD[0], z: HORN_PAD[1], r: 20, blend: 16 },
      /**
       * Vaultmouth. `blend` is 12 and not Cinder's 18, and the number was
       * measured: the pad sits at d 100 on a rim whose cliff starts at d 118, so
       * a 20 m disc plus an 18 m blend would have reached d 138 - past the foot
       * of the cliff - and levelled a walkable ramp down it. At 12 the blend
       * dies at d 132 and the ground between d 126 and d 130 still falls at
       * 64 deg, which is what keeps the exotic tier a second landing.
       */
      { kind: 'pad', x: VAULT_PAD[0], z: VAULT_PAD[1], r: 20, blend: 12 },

      /**
       * The three melt-pond beds.
       *
       * `pad`s and not `basin`s, and the difference is measurable - Volcanic.js
       * records a lake whose bed was a basin inheriting every metre of the swell
       * underneath it and coming out TILTED TWELVE METRES around a single
       * circle. A basin is a DELTA; a pad is a LEVEL, so the bed is flat by
       * construction and the shoreline is a contour. The beach is the blend.
       */
      { kind: 'pad', x: -60, z: 196, r: 20, blend: 24, y: 43.6 },
      { kind: 'pad', x: 96, z: 84, r: 13, blend: 20, y: 44.8 },
      { kind: 'pad', x: -360, z: 60, r: 16, blend: 22, y: 43.2 },
    ],
  },

  /* ---------------------------------------------------------------- */
  palette: {
    /**
     * ══════════════════════════════════════════════════════════════════════
     *  THIS WAS `dirt.ground`, AND THE ICE WORLD RENDERED AS BROWN MOORLAND
     * ══════════════════════════════════════════════════════════════════════
     *
     * Every word of the table below was true and none of it reached the screen.
     * `PlanetWorld._buildTerrain` writes these bands as VERTEX COLOURS, and
     * vertex colours multiply into the material's albedo map. `dirt.ground`
     * bakes a measured linear R:G:B of 1.79 : 1 : 0.49 - three and a half times
     * as much red as blue - so standing on the Firn Shelf, a 140 m ice table,
     * the ground was tan dirt with dried mud cracks in it and the only ice in
     * frame was three prop crystals.
     *
     * `planet-atmosphere.test.mjs` measured this table at 176 degrees of hue
     * spread and 72 points of saturation and passed it, because the table was
     * never the defect. A numeric gate on the DESCRIPTOR cannot see what the
     * descriptor gets multiplied by. Screenshots can, and did.
     *
     * `snow.piste` is not the fix - see the note above `shadeIceSheet` for why
     * a near-white albedo is the same trap in the other direction, and why a
     * snowcat's corduroy has no business on this planet. `ice.sheet` is a
     * hue-free albedo like `rock.neutral` at 1.79x its luminance, wind-combed
     * sastrugi instead of a pebble lag, and roughness from 0.16 to 0.68 instead
     * of dirt's flat 0.94 - so what says ICE is the cold hue THIS TABLE
     * authors, plus a specular sheen along the crests that no soil has.
     */
    material: 'ice.sheet',
    /** 5.0 m a tile, tighter than Cinder's 6.0. Snow has a shorter correlation
     *  length than ash and a coarse tile on a near-white surface reads as
     *  nothing at all. Never zero: a zero tile is NaN uvs, and 19 NaN pixels
     *  blacked out 921,600 in this repo once. */
    tile: 5.0,
    /**
     * ══════════════════════════════════════════════════════════════════════
     *  THE ICE IS NOT WHITE, AND THIS TABLE IS THE ONLY THING THAT SAYS SO
     * ══════════════════════════════════════════════════════════════════════
     *
     * Cinder shipped six bands across FIVE DEGREES of hue and ZERO saturation
     * change, and a tester who landed and walked it wrote: "one flat
     * salmon-brown hue, no rock, no ash, no vents, no heat, no shadows."
     *
     * An ice world is the easiest possible way to ship that same defect in
     * white. A snowfield is a value ramp with no hue in it: author it honestly
     * as #eee -> #fff and the surface is fog with rocks in it, and no amount of
     * light will pull form out of a table that has none.
     *
     * So the value structure does what it does on Cinder - dark low, bright
     * high, so the nunatak reads as a silhouette - and every scrap of remaining
     * freedom is spent on HUE and SATURATION, both of which are free:
     *
     *   y  24   #16345f   214    62     23   compressed blue: vault floor,
     *                                        crevasse floors. The oldest ice on
     *                                        the planet and the bluest.
     *   y  38   #2c6b9c   205    56     39   the crevasse walls
     *   y  50   #6d8579   145    10     47   ABLATION ice, filthy with rock
     *                                        flour. The one green on the planet.
     *   y  62   #e6eef3   197    39     93   sun-struck sheet, near-white
     *   y  78   #bfd6e8   206    46     83   the firn shelf: clean cold snow
     *   y 108   #453e3b    20     8     25   Blackhorn: bare rock, warm-dark
     *   y 150   #93887a    38     10     53   the horn, frost-bleached
     *
     * 214 degrees of hue against Cinder's original 5, and 54 points of
     * saturation against 6. `planet-atmosphere.test.mjs` asks for 40 and 15.
     *
     * The two warm bands at the top are not an accident either. There is no
     * such thing as a cold colour on a planet with no warm one on it: the
     * nunatak's brown is what makes 205-degree ice read as ICE rather than as
     * grey, and it is also the only place the eye can rest.
     *
     * ── THE TWO NUMBERS THIS IS NOT FREE TO MOVE ──────────────────────────
     * `planet-atmosphere.test.mjs` re-derives the mean of this table every run
     * and holds the fog to being LIGHTER and no more SATURATED than it. Mean
     * lightness 52.5, mean saturation 33.0, against a fog at L 82.8 / S 25.2.
     * Both hold with margin - and note how much harder that is on a bright
     * world than on Cinder, where the ground averaged L 33: an ice haze has to
     * be brighter than snow, which is why it is nearly neutral grey.
     */
    bands: [
      { upTo: 24, color: 0x16345f },
      { upTo: 38, color: 0x2c6b9c },
      { upTo: 50, color: 0x6d8579 },
      { upTo: 62, color: 0xe6eef3 },
      { upTo: 78, color: 0xbfd6e8 },
      { upTo: 108, color: 0x453e3b },
      { upTo: 150, color: 0x93887a },
    ],
    /**
     * Dark rock and englacial grit on anything steep, and it does two jobs.
     *
     * On the nunatak and the vault rim it is what it says: bare rock under the
     * ice. On the crevasses it is the thin dark line the eye needs along every
     * lip - the height bands already make the inside of a crevasse blue, but a
     * blue trough with no edge on it reads as a VALLEY. The dark rind at 32-58
     * deg is what turns it back into a hole.
     *
     * Cool (#2f3742, hue 214) rather than the nunatak's warm brown, so the two
     * dark families separate instead of merging into one mud.
     */
    slope: { fromDeg: 32, toDeg: 58, color: 0x2f3742 },
    /**
     * Rock flour, in patches with edges. Three octaves of the height field's own
     * fbm rather than a sine - a sine is a standing wave and prints corduroy.
     *
     * 0.58 and a 62 m scale. The term is applied as `n * n * amount`, so most of
     * the sheet never gets near the ceiling and what you actually see is a few
     * broad dirty smears in otherwise clean ice, which is what an ablation zone
     * looks like from eye level. Without it the bands print as a contour map,
     * and on a low-saturation white surface a contour map is very visible.
     */
    mottle: { scale: 62, amount: 0.58, color: 0x6f8478 },
  },

  sky: {
    kind: 'alpine',
    params: {
      /**
       * THE SUN IS AT 31 DEGREES, AND EVERY DEEP THING ON THIS PLANET DEPENDS
       * ON IT.
       *
       * `alpine`'s own default is 0.90 of +Y - the sun almost overhead, which is
       * correct for a mountain at noon and catastrophic here. At that elevation
       * the vault is a bright bowl, the crevasses have no shadow in them and the
       * sastrugi have no slip face; the entire planet's form comes from
       * OCCLUSION, and occlusion needs a low sun. At 31 deg the vault's 48 m rim
       * throws an 80 m shadow across a 69 m floor - the whole flat floor is in
       * shade - and every crevasse is a black line from any distance.
       *
       * The BEARING is chosen from a landing site rather than from the origin,
       * which is the lesson Cinder paid for: a player standing on Firn Flat
       * looks east-south-east at Blackhorn, and this sun sits behind and to the
       * right of them, so the nunatak is lit and throws its shadow back toward
       * the pad rather than being a black cut-out against a bright sky.
       */
      sunDirection: [-0.62, 0.52, -0.59],
      /** Warm, and it has to be. Blue shadow is a RELATIONSHIP: the ambient
       *  below is 0x6f8fb5 and this is its complement, and neither reads as
       *  cold or warm without the other. A neutral sun over a neutral fill is
       *  a greyscale photograph of snow. */
      sunColor: 0xfff1dd,
      sunIntensity: 15,
      sunAngularSize: 0.017,
      /** Thin, clean, cold air: MORE Rayleigh than alpine's own 3.1 and LESS
       *  Mie than its 0.26. That is the whole preset in two numbers - a very
       *  deep zenith with almost nothing scattering in front of it, which is
       *  the one sky no other planet in this system has. */
      rayleigh: 3.4,
      mie: 0.20,
      mieG: 0.70,
      altitude: 3400,
      /** The bounce off the snow, and the single most physically real thing in
       *  this block. Shadows on a snowfield are not dark, they are BLUE-WHITE,
       *  because the only light in them is skylight reflected off more snow. */
      groundColor: 0xdfe9f0,
      hazeColor: 0xcfe0ee,
      /** 0.30, up from alpine's 0.22. Ice blink: the bright band a big sheet
       *  puts on its own horizon. It is real, it is free, and it gives the
       *  nunatak something to stand against. */
      horizonHaze: 0.30,
      cirrus: 0.42,
      cirrusScale: 2.6,
      cirrusSpeed: 0.0028,
    },
    background: 0x35597a,
    /**
     * ── The fog ───────────────────────────────────────────────────────────
     *
     * `half` is 460, so the playfield is 920 m square and its diagonal is
     * 1,301 m. 1430 is 1.10x that: the far corner is fully extinguished, the
     * rim at 460 m is about a third of the way in, and Blackhorn at 390 m reads
     * as a silhouette with air in front of it rather than as paint. Further out
     * and the player would see the terrain mesh stop; `CONFIG.render.far` is
     * 2000, so this also finishes well inside the clip.
     *
     * The COLOUR is the hard part on a bright world and it is not the obvious
     * one. `planet-atmosphere.test.mjs` holds fog to being lighter and no more
     * saturated than the mean of the palette bands, and this palette's mean is
     * L 52.5 / S 33.0 - four times Cinder's lightness. So the haze cannot be
     * the pretty pale blue it wants to be (#c9dced measures S 50 and fails);
     * it has to be a nearly neutral cold grey at L 83. Which is correct
     * anyway: ice haze is suspended crystal, it is achromatic, and the blue in
     * an ice photograph comes from the SHADOWS, not from the air.
     */
    fog: { color: 0xc8d4de, near: 140, far: 1430 },
    /**
     * ── The fill is blue, and that is the mechanism ───────────────────────
     *
     * 0x6f8fb5 at 0.62 against a warm key at 6.2. The ratio is 0.100, inside
     * the 0.12 ceiling `planet-atmosphere.test.mjs` sets for a world to have a
     * terminator at all - but it is higher than Cinder's 0.072 on purpose,
     * because snow really does bounce most of what lands on it and a shadow on
     * an ice sheet is bright. What makes it read as SHADOW is not that it is
     * dark, it is that it is a different HUE from the lit side. Take the blue
     * out of this one number and the whole planet goes grey.
     */
    ambient: { color: 0x6f8fb5, intensity: 0.62 },
    sun: { color: 0xfff1dd, intensity: 6.2, direction: [-0.62, 0.52, -0.59] },
    exposure: 1.10,
    /**
     * `station`, not `dock`. `GRADE_PRESETS` is keyed on WORLD id and a planet
     * is not in it, so naming one here is the only way a planet gets a
     * calibrated look - and of the four, `station` is the only one built around
     * COLD SHADOWS AND A WARM KEY over a cool balance, which is exactly the
     * split this palette is built on. Its bloom threshold is also the highest
     * in the game at 3.00, and that matters more here than anywhere: a sunlit
     * snowfield is the brightest diffuse surface in this project, and at
     * `dock`'s 2.40 the whole sheet would bloom into one white sheet of paper.
     */
    grade: 'station',
  },

  /* ---------------------------------------------------------------- */
  /**
   * MELTWATER, and the argument for having any liquid at all.
   *
   * The brief left this open. Three reasons it is in:
   *
   * 1. It is the only saturated dark thing on a bright planet. Every other
   *    answer to "the ice is not white" in this file is a hue shift inside a
   *    narrow value band; a melt pond is a black-blue hole in the middle of a
   *    white field, and it costs three records.
   * 2. The existing lava shader turns out to model exactly the right thing.
   *    `PlanetLiquid` mixes `crust` -> `color` on a noise field with cracks and
   *    open patches: on Cinder that is chilled skin over molten rock, and here
   *    it is the ICE LID over open water, which is what a supraglacial pond
   *    actually looks like in the melt season. `hot` is dialled down to a cold
   *    sheen at `emissive` 0.10 - the shader's 0.045 floor is what stops an
   *    unbroken lid rendering literally black, and a black pond is a hole.
   * 3. It is a hazard the player can see. `PlanetWorld` sets `swim: false`, so
   *    water is a wall in this engine and not a route - which is why all three
   *    are small, are in the open, and are nowhere near a road, a pad or a
   *    seam. Nothing on this planet requires entering water.
   *
   * No `glowLight`: there is nothing incandescent here, and `RIG_BUDGET.point`
   * is twelve for the whole game.
   */
  liquid: {
    name: 'meltwater',
    bodies: [
      { shape: 'disc', x: -60, z: 196, r: 22, y: 45.2 },
      { shape: 'disc', x: 96, z: 84, r: 15, y: 46.4 },
      { shape: 'disc', x: -360, z: 60, r: 18, y: 44.8 },
    ],
    /** The open water: deep, saturated, and the darkest colour on the planet. */
    color: 0x0d4a72,
    /** Read as "the colour the sheen is", not "the colour the fire is". */
    hot: 0x9fd8ee,
    /** The lid. Pale enough to be ice and blue enough not to be paper. */
    crust: 0xaecfe0,
    emissive: 0.10,
    /** 0.10. The crust drift is `uTime * flow * 0.035` over a 0.055 world
     *  scale, so at this value the lid moves about a metre a minute. Which is
     *  faster than the glacier and slower than anything else on it. */
    flow: 0.10,
    glowLight: null,
    lethal: false,
  },

  /* ---------------------------------------------------------------- */
  props: [
    {
      /**
       * SERACS - the ranks of ice towers standing between the crevasses.
       *
       * `widthInner: 36` puts them OUTSIDE the azurine band (14-34) rather than
       * in it, and that is the Cinder colonnade lesson applied before it cost
       * anything: a spire field at 7.5 m spacing leaves 3.9 m lanes, and the
       * reach probe lost a whole sulfur seam inside a field with 2.0 m lanes.
       * Ore and colliders do not share a corridor on this planet.
       */
      id: 'seracs',
      kind: 'spires',
      region: { shape: 'corridor', pts: SHATTER, width: 76, widthInner: 36, slopeMaxDeg: 30, clearOfPads: 4 },
      count: 150, spacing: 8.0,
      /* Concave-profiled, five-sided, leaning up to 0.24 rad. The lean is what
       * separates a serac field from a row of traffic cones: these are blocks
       * left standing between intersecting crevasses and none of them is plumb. */
      size: { h: [3.5, 16.0], base: [0.9, 2.4], lean: 0.24, facets: 5 },
      tint: [0xa9c6d6, 0x8fb2c6, 0xc2d9e4, 0x7699ae],
      collide: true,
    },
    {
      /**
       * CALVED PLATES on the crevasse lips - and these deliberately do NOT
       * collide.
       *
       * They sit in the same 13-34 m band azurine does. A colliding slab's box
       * is `vHalf * 0.85` tall and centred on the ground, so any plate over
       * about half a metre is a WALL to the 2 m reach lattice, not a step - and
       * a field of walls at 6 m spacing beside a 26 m hole is a maze the probe
       * cannot prove and a player would not enjoy. These are 0.3-0.9 m sheets;
       * you walk over them. Turning the collider on would buy nothing but risk.
       */
      id: 'calving',
      kind: 'slabs',
      region: { shape: 'corridor', pts: SHATTER, width: 34, widthInner: 13, slopeMaxDeg: 26 },
      count: 260, spacing: 6.0,
      size: { w: [1.6, 5.0], d: [1.4, 4.2], t: [0.3, 0.9], tilt: 0.55 },
      tint: [0xbcd6e2, 0x9db9cc, 0xd4e6ee, 0x86a4b8],
      collide: false,
    },
    {
      /**
       * THE VAULT COLUMNS. A ring of tall ice pillars standing on the floor's
       * edge, 34-46 m out from the axis.
       *
       * This is the honest half of the "subglacial vault" read. `PlanetWorld`
       * draws a HEIGHTFIELD - one Y per (x, z) - so there is no roof in this
       * engine and there is not going to be one for a prop field either. What
       * there can be is the evidence that there WAS one: columns that used to
       * hold something, standing round the edge of a floor, with the plates of
       * the roof lying on it. The annulus starts at 34 so the columns never
       * stand in the hyaline seam (r <= 30) - separate ground, separate job.
       */
      id: 'vault_columns',
      kind: 'spires',
      region: { shape: 'annulus', x: VX, z: VZ, r0: 34, r1: 46, slopeMaxDeg: 30 },
      count: 20, spacing: 9.0,
      size: { h: [10.0, 30.0], base: [1.6, 3.6], lean: 0.10, facets: 6 },
      tint: [0x6f9ec0, 0x8fbcd8, 0x59839f, 0xa6cfe2],
      collide: true,
    },
    {
      /**
       * THE FALLEN ROOF. Big plates on the vault floor, and these DO collide,
       * because that is the whole point of them - you climb over and around a
       * collapsed ceiling.
       *
       * NINE, and the number is what the floor HOLDS rather than what looked
       * generous. The first version asked for 26 at 26 m spacing and `scatter`
       * delivered 12 - a field under-delivering by more than half is a number
       * nobody can reason about, and it is the same defect Cinder's colonnade
       * had at 210-for-155. The vault's standable floor is only a 39 m disc
       * once the 22 deg filter has taken the wall off it, which is room for
       * about 19 at 17 m spacing; nine is a little under half of that, the same
       * headroom the colonnade settled on.
       *
       * The plates also came DOWN from 18x15 m to 14x12. It was not only a
       * count problem: at the old size the collider half-footprint was 7.7 m
       * against 26 m of spacing, and the reach probe lost a hyaline node inside
       * the field - one of eight, boxed in by fallen roof. 14x12 at 17 m
       * spacing leaves 5.1 m lanes and the seam comes back 8 of 8. A collapsed
       * ceiling you cannot walk into is scenery with ore behind glass.
       *
       * `tilt` 0.95 rad: nothing here landed flat.
       */
      id: 'rooffall',
      kind: 'slabs',
      region: { shape: 'disc', x: VX, z: VZ, r: 50, slopeMaxDeg: 24 },
      count: 9, spacing: 17,
      size: { w: [5.0, 14.0], d: [4.0, 12.0], t: [0.7, 2.2], tilt: 0.95 },
      tint: [0x7aa6c4, 0x5c88a6, 0x9ac2d8, 0x486d88],
      collide: true,
    },
    {
      /**
       * MORAINE. Rock the nunatak has shed, carried down-flow in a streak.
       *
       * The corridor follows the ice's own direction of travel away from
       * Blackhorn, which is why it is a line and not a disc: a moraine is a
       * conveyor belt, not a scree slope. It is also the only thing on the
       * sheet with the palette's warm hue in it at ground level, and that is
       * half of why it is here - `mottle` handles the rock flour at 60 m scale,
       * and this handles it at arm's length.
       */
      id: 'moraine',
      kind: 'boulders',
      region: { shape: 'corridor', pts: [[BX, BZ], [150, 220], [70, 330]], width: 90, slopeMaxDeg: 30, clearOfLiquid: 10, clearOfPads: 4 },
      count: 300, spacing: 7,
      size: { rMin: 0.5, rMax: 2.6 },
      tint: [0x4a423c, 0x352f2b, 0x5c534a, 0x28231f],
      collide: true,
    },
    {
      /**
       * RIME FEATHERS on the firn shelf. Wind-grown frost on anything that
       * stands up, 0.5-2.4 m, four-sided and leaning hard.
       *
       * `collide: false` because they are frost - a body walks through them, and
       * a collider on a knee-high feather is an invisible wall in the middle of
       * the clathrate seam. Their job is entirely optical: 700 tiny casters
       * across the shelf under a 31 deg sun is how a white table stops being a
       * white table.
       */
      id: 'rime_feathers',
      kind: 'spires',
      region: { shape: 'disc', x: SHELF_X, z: SHELF_Z, r: 168, slopeMaxDeg: 22, clearOfPads: 4 },
      count: 700, spacing: 5.0,
      size: { h: [0.5, 2.4], base: [0.25, 0.9], lean: 0.32, facets: 4 },
      tint: [0xe4f0f6, 0xcadfea, 0xf2f8fb, 0xb4cede],
      collide: false,
    },
  ],

  /* ---------------------------------------------------------------- *
   * MINERALS - five elements, five places, one ladder.
   *
   *   rarity     element     terrain    where, and what it costs to stand there
   *   ---------  ----------  ---------  -----------------------------------
   *   common     rime        plain      the open sheet, everywhere
   *   common     clathrate   shelf      the firn shelf, one walk north
   *   uncommon   cryolite    outcrop    the Blackhorn bench, up the Horn Road -
   *                                     or land on it
   *   rare       azurine     fissure    the Shatter's lips, through the Neck
   *   exotic     hyaline     cave       the vault floor, and UNREACHABLE from
   *                                     the primary pad at any distance
   *
   * `credits` is absent from every row on purpose - `definePlanet` computes it
   * from `unitValue * hold` and REFUSES a hand-written one.
   *
   * `size` is the node radius and ALSO the hold volume (`max(1, round(size *
   * 1.6))`), so the cheap ore is the bulky ore and that is the entire cargo
   * decision: 3 m3 of rime for 36 credits against 1 m3 of hyaline for 380. A
   * stock Kestrel holds ten cubic metres. Three lumps of rime, or the whole
   * vault.                                                                   */
  minerals: [
    {
      id: 'rime', item: 'rime', name: 'Rime Crust',
      rarity: 'common', terrain: 'plain', place: 'the open sheet',
      /* Pale, matte, and NOT white. Cinder's tephra shipped as a cream boulder
       * brighter than anything else on the plain - the cheapest ore on the
       * planet was its most conspicuous object. On a snowfield the same mistake
       * has the opposite failure: pure white ore is invisible. 0xc2d8e2 sits
       * one clear step below the sun-struck band (0xe6eef3) and above the
       * ablation band, so it reads on both. */
      color: 0xc2d8e2, glow: 0,
      unitValue: ORE('rime'), spread: 0.25,
      /* 1.70 m: three cubic metres of hold, the biggest node on the planet and
       * the least valuable. `holdUnitsFor` rounds, so anything under 1.5625
       * drops to two and the bulk-versus-value decision goes with it. */
      size: 1.70, count: 42, spacing: 20,
      /* `yMin: 30` is doing real work and is not a tidy bound: without it the
       * field scatters onto CREVASSE FLOORS and the VAULT FLOOR, both of which
       * are flat, both of which pass a slope filter, and neither of which a
       * body can walk to. Height is the cheapest possible expression of "the
       * ground the player is actually on". `yMax: 64` keeps it off the shelf,
       * the bench and the vault rim, which have their own ore. */
      region: { shape: 'field', yMin: 30, yMax: 64, slopeMaxDeg: 20, clearOfLiquid: 18, clearOfPads: 5 },
    },
    {
      id: 'clathrate', item: 'clathrate', name: 'Clathrate Ice',
      rarity: 'common', terrain: 'shelf', place: 'The Firn Shelf',
      /* Green-grey. Methane caged in water ice is dirty ice, and it is also the
       * only way to tell it from rime at ten metres on a white shelf. */
      color: 0x7ba59a, glow: 0,
      unitValue: ORE('clathrate'), spread: 0.25,
      size: 1.45, count: 30, spacing: 15,
      /* 22 deg and not 16: the sastrugi field puts crests of up to 29 deg
       * across this whole disc, and at 16 the seam was fighting the texture
       * that makes the shelf look like anything. */
      region: { shape: 'disc', x: SHELF_X, z: SHELF_Z, r: 126, slopeMaxDeg: 22, clearOfPads: 4 },
    },
    {
      id: 'cryolite', item: 'cryolite', name: 'Cryolite',
      rarity: 'uncommon', terrain: 'outcrop', place: 'Blackhorn Bench',
      /* Near-white, and it is the one place on this planet where near-white is
       * the legible choice: cryolite is the only ore standing on BARE ROCK.
       * The catalogue says it "all but vanishes in meltwater" and that miners
       * dye every load - so it is invisible where it is wet and unmissable
       * where it is dry, which is exactly where this seam is. */
      color: 0xf0f4f2, glow: 0,
      unitValue: ORE('cryolite'), spread: 0.25,
      size: 0.92, count: 20, spacing: 9,
      /* `slopeMaxDeg: 24` is what excludes the horn: its own flank stands over
       * 24 deg everywhere inside 23.7 m of its axis, so the seam is on the
       * BENCH and never on the needle. */
      region: { shape: 'disc', x: BX, z: BZ, r: 46, slopeMaxDeg: 24, clearOfPads: 3 },
    },
    {
      id: 'azurine', item: 'azurine', name: 'Azurine',
      rarity: 'rare', terrain: 'fissure', place: 'The Shatter',
      /* DEEP SATURATED COBALT, and it is a legibility decision. Azurine sits on
       * white lip ice looking down into a blue hole, so a pale blue node would
       * be the ground twice. The two rare-tier ores also have to separate from
       * each other: this is dark blue on a bright field, hyaline is bright cyan
       * in a dark hole, and each is the one that reads where it lives. */
      color: 0x2358c4, glow: 0x143c8c,
      unitValue: ORE('azurine'), spread: 0.25,
      size: 0.72, count: 12, spacing: 13,
      /* THE LIPS, AND NEITHER THE FLOOR NOR THE WALL.
       *
       * `widthInner: 13` excludes the cut itself - the trench's own half-width
       * is 12 - and this is exactly the fix Cinder's sulfur needed: a corridor
       * authored down a rift included the FLOOR of a 13 m trench with
       * near-vertical walls, and the reach probe found a seam down there that
       * nothing could walk to. This trench is twice as deep and its walls stand
       * at 81 deg, so the same mistake would be twice as expensive.
       *
       * `slopeMaxDeg: 22` then rejects whatever is left of the wall break, and
       * what survives is the 13-34 m band of spoil lip and outer shoulder,
       * which stands at 7-16 deg. Which is where the ore ACTUALLY IS: blue ice
       * is exposed where the wall meets the surface, and the lip is the only
       * place a body can stand to work it. The fix and the geology are the same
       * fix, and the flood probe confirms the band is standable rather than
       * assuming it.
       *
       * Both lips are addressed, and the south lip is only reachable through
       * the Neck - a 60 m gate between the vault's cliff and the crevasse's
       * west end. That gate is the walk this seam is priced for. */
      region: { shape: 'corridor', pts: SHATTER, width: 34, widthInner: 13, slopeMaxDeg: 22, clearOfPads: 4 },
    },
    {
      id: 'hyaline', item: 'hyaline', name: 'Hyaline',
      rarity: 'exotic', terrain: 'cave', place: 'The Hyaline Vault',
      /* Colourless glass with a bright cyan glow. Only the two rare tiers
       * declare `glow`, and `PlanetWorld` drives it at emissive 2.2 - which is
       * the whole payoff object for the trip, standing on a floor that is in
       * shadow all day under a 31 deg sun. */
      color: 0xd8f6ff, glow: 0x5ad0ee,
      unitValue: ORE('hyaline'), spread: 0.25,
      /* The smallest node on the planet and the dearest: one cubic metre, 380
       * credits. A stock Kestrel can carry all eight of them, which is the trip
       * this ore exists to make worth flying. */
      size: 0.58, count: 8, spacing: 12,
      /* r 30, which is INSIDE the basin's flat inner 34.4 m. The seam is on the
       * floor and never on the wall, the vault columns start at 34 so they
       * never box it in, and there is exactly one way down here. */
      region: { shape: 'disc', x: VX, z: VZ, r: 30, slopeMaxDeg: 18 },
    },
  ],

  /* ---------------------------------------------------------------- */
  landing: [
    {
      /** The primary. Open sheet, north of the ablation front, 112 m off the
       *  shelf's edge and clear of every pressure ridge. */
      id: 'firn', name: 'Firn Flat', x: FIRN_PAD[0], z: FIRN_PAD[1], r: 30, primary: true, yaw: 1.95,
    },
    {
      /** On the bench, facing the horn. A second approach to cryolite for a
       *  player who does not want the 288 deg of the Horn Road. */
      id: 'blackhorn', name: 'Blackhorn Bench', x: HORN_PAD[0], z: HORN_PAD[1], r: 20, yaw: 0.15,
    },
    {
      /** The second landing, and the exotic tier's entire reason to exist.
       *  Nothing walks here from Firn Flat. */
      id: 'vaultmouth', name: 'Vaultmouth', x: VAULT_PAD[0], z: VAULT_PAD[1], r: 20, yaw: -2.53,
    },
  ],

  hazards: {
    /** Spindrift. The same `Points` field Cinder uses for ash, in ice: 0.34
     *  density and a hard lateral drift, because on a sheet the snow is not
     *  falling out of the sky, it is being carried across it. */
    ashfall: { density: 0.34, drift: [1.2, -0.45] },
    ashColor: 0xdfeaf2,
  },
});

export default VITRINE;
