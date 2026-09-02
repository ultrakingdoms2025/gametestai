/**
 * SHOAL - the ocean archipelago, and the only body in the system that is
 * mostly liquid.
 *
 * Everything here is data. `PlanetWorld` renders it; there is no Shoal code
 * anywhere else in the build and there must not be.
 *
 * ==========================================================================
 *  THE ONE CONSTRAINT THAT DESIGNED THIS PLANET, AND THE DAY IT LIFTED
 * ==========================================================================
 *
 * This file was written under a rule that no longer holds, and everything
 * below it is still shaped by that rule, so the rule is recorded first.
 *
 * WHAT IT WAS. `PlanetWorld` set `swim: false` for all ten planets, and the
 * liquid surface got no collider either - so water on a planet was neither
 * swimmable nor solid, an opaque sheet with nothing behind it. Every
 * reachability probe marked a lattice cell BLOCKED when the ground under it
 * was below a liquid surface, and that was the honest model. The design rule
 * for Shoal was therefore not "make the swim nice", it was:
 *
 *   THE WALKABLE WORLD IS EXACTLY THE GROUND STANDING ABOVE y = 6.6, AND
 *   EVERY DEPOSIT THE PRIMARY PAD IS SUPPOSED TO REACH MUST BE ON ONE
 *   CONNECTED PIECE OF IT.
 *
 * An archipelago whose ore is on the far island is ore behind glass. So this
 * archipelago is NOT a scatter of islands: it is ONE landmass - three islands
 * standing on one continuous emergent shelf, joined by two spits - plus one
 * deliberately severed island that exists to be a second landing.
 *
 * WHAT IT IS NOW. `liquidSwimmable` moved the decision from the WORLD to the
 * LIQUID, and this sea says yes. The rule above SURVIVES UNCHANGED as a rule
 * about ORE - every deposit is still on connected dry ground and the probes
 * still measure it that way - and it stops being a rule about the PLAYER. Two
 * things followed, and both are the substance of this file's last pass:
 *
 *   THE FENCE STOPPED WORKING AS A DESIGN. 3,122 shore posts held the exotic
 *   guarantee up on a shore nobody could cross. Take them away and Sundering
 *   Head, whose header claimed 61-degree cliffs and whose terrain built a
 *   44-degree ramp, became a walk: abyssite 0 of 7 to 7 of 7 from the primary
 *   pad. The Head is cut at `edge: 18` now and measures 70.8 degrees at the
 *   waterline, so the severance is geometry rather than furniture, and Shoal
 *   carries ZERO barrier posts. @see the SUNDERING HEAD landform.
 *
 *   THE SEA BECAME SOMEWHERE TO GO, WHICH MEANT THE BED HAD TO BE SOMEWHERE.
 *   It was empty, so two fields now stand on it, both inside a measured lung.
 *   @see `LUNG` and the two underwater prop fields.
 *
 * ==========================================================================
 *  THE MAP, in words
 * ==========================================================================
 *
 * 880 m square, `+x` east and `+z` south. Sea level is y = 6.0 and it is the
 * datum every other number on this planet is quoted against.
 *
 *   THE SHOAL          the shelf itself, and the thing the planet is named
 *                      for. Three overlapping emergent benches at a dead-flat
 *                      y = 7.25 - one metre and a quarter of freeboard - which
 *                      is what a tidal platform at low water is. It runs
 *                      north-west to south-east across two thirds of the map
 *                      and it is the floor of the whole walkable world.
 *
 *   MERIDIAN           the main island, on the north-west bench. A flat-topped
 *                      limestone island at y 17.5 carrying CORAL CROWN, a
 *                      58 m horn whose summit stands at 75.5 - 69 m above the
 *                      water and the silhouette from every pad on the planet.
 *                      A collapsed doline pocks its eastern shoulder.
 *
 *   THE GLASSFLAT      the open middle bench: 148 m of ripple-marked sand and
 *                      upended reef pavement, the primary landing on it, and
 *                      THE WRACK BAR - a 2.2 m shell ridge curving across its
 *                      northern half so the flat is not a table. Polymetallic
 *                      nodules lie out on it, and nowhere near the pad.
 *
 *   THE THREAD         107 m of spit joining Meridian's bench to the
 *                      Glassflat across 73 m of open water. Level, 30 m wide
 *                      with its blend, and it is the only way between the two
 *                      on foot. Cut it and half the planet is an island.
 *
 *   THE SOUND          the drowned basin the Thread crosses: 6 to 13 m of
 *                      water between Meridian's bench and the Glassflat, and
 *                      the one part of the sea bed the planet asks you to
 *                      swim down and look at. Kelp on it, all of it inside
 *                      one lungful.
 *
 *   BARROW             an atoll on the south-eastern corner of the shelf: a
 *                      21 m reef ring round a drowned lagoon whose floor is
 *                      6 m under the sea, with coral on it. Reached by BARROW
 *                      SPIT, 52 m, and then by getting wet.
 *
 *   SUNDERING HEAD     THE SECOND LANDING, and it is an island on purpose. A
 *                      98 m limestone stack standing 52 m out of deep water
 *                      on a face that MEASURES 70.8 degrees at its shallowest
 *                      and 75.9 at its median, with 99.5 m of sea at its
 *                      narrowest between it and the nearest ground a body can
 *                      stand on, and no spit. You fly to it or you do not go.
 *                      This line used to say "61-degree cliffs" and the
 *                      terrain built 44; see `edge` on the landform, which is
 *                      the number that had to move.
 *
 *   THE TIDE CHASM     a 42 m slot cut clean across the Head, 13 m wide, its
 *                      floor a dry 10.0 - four metres of air above the sea,
 *                      which is the whole trick: it is the one deep place on
 *                      an ocean planet that is not underwater. Abyssite lines
 *                      it. The floor is reached by THE SUNDER STAIR, a 168 m
 *                      ramp at 14 degrees off the Head's landing pad, and by
 *                      nothing else.
 *
 * ==========================================================================
 *  WHY THE NUMBERS ARE THESE NUMBERS
 * ==========================================================================
 *
 * -- The relief budget ------------------------------------------------------
 *
 * 81.5 m of authored relief (sea bed at -6 to Coral Crown at 75.5) against
 * 8.9 m of noise: swell 6.4, ripple 1.9, grain 0.26, plus a 0.30 m global
 * dune ripple. The noise is the last 10%.
 *
 * That last term is not decoration and it is the one number on this planet
 * that had to be invented. `plateau` REPLACES the height inside its radius -
 * that is what makes it a level rather than a bump - and on Shoal almost every
 * walkable surface is a plateau. So the swell, the ripple and the grain are
 * erased from every single thing the player stands on, and the first build of
 * this file had eighty-two metres of analytically smooth CAD with a sea round
 * it. The fix is a `dunes` field at r 700 covering the whole map, LAST in the
 * ADD layer so it rides everything the plateaus flattened: 0.30 m at a 19 m
 * wavelength is ripple-marked sand at eye level and 2.8 degrees of slope,
 * which no placement filter on the planet notices. The LEVEL layer still runs
 * after it, so pads and roads stay dead flat.
 *
 * -- Sea level, and the 0.6 m that decides what is walkable ----------------
 *
 * The probes mark a cell blocked when `y < body.y + 0.6`. So 6.6 is the real
 * shoreline, not 6.0, and every surface meant to be walked stands clear of it
 * by a margin that is not noise:
 *
 *     the shelf benches      7.25    +0.65   (dead flat: plateau, no noise)
 *     the two spits          7.25    +0.65   (ramps, levelled)
 *     the Tide Chasm floor  10.0     +3.4
 *     the open sea bed     -34.7 .. -0.2   drowned everywhere, MEASURED
 *
 * The sea bed's ceiling is the number that had to be checked rather than
 * assumed. On paper baseY -6 plus swell 6.4 plus ripple 1.9 plus grain 0.26
 * plus the global dunes 0.30 could reach 2.86; sampled over 490,000 points of
 * true open water it actually tops out at -0.23, which is 6.2 m of cover. A
 * sandbar poking through would be a walkable island nothing can reach, with
 * common ore placed on it - the exact "built but not reachable" defect, in the
 * one place nobody would think to look for it. The measured version of that
 * claim is stronger and it is the one the probe ran: 67,127 standable cells on
 * a 2 m lattice, and the two pads between them reach 59,830 and 7,297 - which
 * sum to 67,127 exactly. There is no orphan ground on this planet.
 *
 * -- And the FLOOR, which turned out to be two different places --------------
 *
 * "-34.7" in the table above is the honest minimum of the height field and it
 * is a misleading thing to quote as a sea bed, which is what a review of the
 * swimmable sea did quote it as: "Oxygen is 14 s, so Shoal's deepest bed (40 m)
 * is not divable." Measured over all 78,961 samples, the bed splits in two:
 *
 *     INSIDE `terrain.rim.start` (398)   deepest 16.3 m, and 98.1% of it is
 *                                        14 m or shallower. This is the sea.
 *     OUTSIDE it, the 42 m skirt          20 to 40.7 m. This is the map edge
 *                                        falling away, which is what `rim` is
 *                                        FOR, and there is nothing on it.
 *
 * So the 40 m is not unreachable content, it is the boundary of the world with
 * water over it. The sea proper is a diver's sea: 66% of the bed inside the rim
 * is within `LUNG` - four seconds of air still in hand at the bottom - and its
 * deepest single sample is 16.3 m against a 15.7 m drowning ceiling, which is
 * six tenths of a second of over-run and five damage. What WAS true is that
 * every metre of that bed was empty, including the 6 m lagoon inside Barrow
 * that this file's own map entry describes as something you look into. It is
 * not empty now. @see `LUNG`, `SOUND`, and the two underwater prop fields.
 *
 * -- Why the sea is ONE disc, and 2,700 m across --------------------------
 *
 * `liquid.bodies` are AUTHORED surfaces at AUTHORED heights. Volcanic.js
 * records what happens when a level is derived instead: a lake whose height
 * came out of a `min()` over its basin tilted TWELVE METRES across a single
 * circle. Shoal cannot afford a millimetre of that, because its shoreline is
 * 3 km long instead of 150 m.
 *
 * So the sea is one horizontal plane at y = 6.0 with `wobble: 0`, and it is
 * flat by construction rather than by tuning: there is no second body to
 * disagree with, and the shoreline is not authored at all - it is the y = 6.0
 * CONTOUR of the terrain, which is why it wanders with the swell instead of
 * reading as a circle. `discRadiusAt`'s three harmonics are what a lava lake
 * needs to stop looking like a decal; a whole ocean has no outline to wobble.
 *
 * The radius is 2,700 m and that is a horizon number, not a sea number. The
 * playfield's half-diagonal is 622 m and `CONFIG.render.far` is 2,000, so at
 * 2,700 the water's edge is beyond the far plane from EVERY point a player can
 * stand: it is clipped rather than seen, at a depth where the fog is already
 * 100%. At any radius under about 1,900 the far rim of the ocean is visible
 * from the corner of the map as a straight line with sky under it - the world
 * stopping, which is the failure `terrain.rim` exists to prevent on land and
 * which nothing on land can prevent for water. It costs 128 triangles.
 *
 * ==========================================================================
 *  WHAT `clearOfLiquid` DOES ON A PLANET THAT IS MOSTLY LIQUID
 * ==========================================================================
 *
 * It rejects the entire map, and this file therefore does not use it anywhere.
 *
 * `Placement.liquidClearance` is a HORIZONTAL distance: the minimum over every
 * body of `dist(x, z, body) - radius`. With a 2,700 m disc centred on the
 * origin that is about -2,100 everywhere inside the playfield, so
 * `clearOfLiquid: 2` is a filter that refuses all 774,400 m2 of the planet -
 * silently, as a `rejects.liquid` count nobody reads, leaving `scatter` to
 * report a shortfall of 100%.
 *
 * The correct guard is `yMin`, and it is a STRONGER one: `clearOfLiquid` asks
 * "how far is this from the water", which on a shore is the wrong question,
 * while `yMin` asks "is this above the water", which is the only question that
 * decides whether a player can pick the thing up. Every region below carries a
 * `yMin` at or above 6.75, and the probe checks node-by-node that not one
 * mineral on this planet sits under the surface.
 *
 * ==========================================================================
 *  THE LAVA CHANNELS, AND WHICH OF THEM MEAN ANYTHING FOR WATER
 * ==========================================================================
 *
 * `PlanetLiquid.createLiquidMaterial` was written for lava and this is its
 * first non-lava caller. Its fragment chunk resolves to one scalar `glow`
 * (broken-crust veins plus open molten patches) and then does exactly two
 * things with it: `mix(uCrust, uDeep, glow)` into the diffuse, and
 * `uHot * uEmissive * (glow * 0.58 + 0.045)` into the emissive. So:
 *
 *   crust  KEEPS ITS MEANING, INVERTED IN VALUE. It is the colour of the
 *          surface where the noise is quiet - for lava the chilled skin, for
 *          water the lit sea between the streaks. It is the LIGHTER of the
 *          two here, where on lava it is the darker.
 *   color  the colour the veins and patches resolve to. On lava that is
 *          molten and bright; here it is the dark trough of a wind streak.
 *          Darker than `crust`, which is the swap that makes the same shader
 *          read as water.
 *   flow   MEANS EXACTLY WHAT IT SAYS - two sheared drift rates over the
 *          noise. 0.22 against lava's 0.55: a slow swell, and the two rates
 *          being non-multiples is what keeps it from reading as a conveyor.
 *   emissive / hot   DO NOT MEAN HEAT HERE AND ARE NOT PRETENDING TO. There
 *          is no specular or fresnel channel exposed on this material, so the
 *          one thing available to suggest a lit water surface is a very small
 *          emissive lift on the same streaks the diffuse already darkens.
 *          0.16 against lava's 2.1 - about a thirteenth - tinted to the sky
 *          rather than to a flame. Set to 0 the sea renders as matte blue
 *          paint, because `roughness: 0.62, metalness: 0` is all the material
 *          gives it. This is a stand-in and it is written down as one.
 *   glowLight  NULL, and deliberately. `RIG_BUDGET.point` is twelve for the
 *          whole game and every one is compiled into every shader. Water does
 *          not emit; spending a global light slot on it would be spending it
 *          on nothing.
 *
 * `hazards` is absent for the same kind of reason: `PlanetWorld` reads exactly
 * two things out of that block - `ashfall.density`, which builds a particle
 * field, and `steamColor`, which is only ever consulted for a `vents` prop
 * field. Shoal has neither. `heatShimmer` is authored on Cinder and read by
 * nothing anywhere in the build; copying it here would be copying dead data.
 */

import { definePlanet } from './PlanetDescriptor.js';
import { ITEMS } from '../../systems/ItemDefs.js';

/**
 * Credits per cubic metre of hold, read off the item catalogue.
 *
 * The price belongs to the ELEMENT and not to the rock: the same polymetallic
 * nodule is worth the same per cubic metre whichever shelf it came off, and
 * the vendor who buys it reads `ITEMS`. Throwing on a missing row rather than
 * returning `undefined` is the difference between a loud boot failure and a
 * planet whose deposits are all worth NaN.
 *
 * @param {string} id an `ITEMS` id
 * @returns {number} credits per cubic metre
 */
const ORE = (id) => {
  const def = ITEMS[id];
  if (!def) throw new Error(`[Shoal] mineral names item "${id}", which has no ITEMS row`);
  return def.value;
};

/* ------------------------------------------------------------------ */
/* Frame of reference                                                  */
/* ------------------------------------------------------------------ */

/** Playfield half-extent. */
const HALF = 440;

/**
 * Sea level, and the datum for the whole planet.
 *
 * Authored, never derived. Everything walkable is quoted as freeboard above
 * it and everything drowned as depth below it.
 */
const SEA = 6.0;

/**
 * The emergent shelf's height: 1.25 m of freeboard.
 *
 * Not more, because the shelf has to read as barely out of the water - a
 * tidal platform, not a terrace. Not less, because the reach probes block any
 * cell under `SEA + 0.6` and 0.65 m is the whole margin between "the floor of
 * the planet" and "the far half of the map is unreachable".
 */
const SHELF = 7.25;

/** The open sea bed. Deep enough that nothing on it ever surfaces - see the header. */
const BED = -6;

/**
 * THE LUNG - the deepest bed a diver reaches and comes back from, in metres of
 * water, and the only number on this planet that is a property of the PLAYER
 * rather than of the ground.
 *
 * `Swim` gives 14 s of oxygen, 2.4 m/s down and 2.1 m/s up. Straight down and
 * straight back is `d * (1/2.4 + 1/2.1)` = 0.893 d seconds, so the absolute
 * ceiling is 15.7 m with the last breath spent arriving at the surface. That is
 * not a budget, it is a drowning. Reserve four seconds to be somewhere:
 *
 *     (14 - 4) / 0.893 = 11.2 m
 *
 * Nothing this file places under water sits below `SEA - LUNG`, and
 * `planet-dive.test.mjs` asserts it against `Swim.js`'s own constants
 * rather than against this comment, so the day somebody retunes the lung the
 * assertion moves with it and this planet goes red instead of quietly growing
 * a kelp bed nobody can reach.
 *
 * Those three constants are NOT exported (`ENTER_DEPTH` is, and is imported by
 * every probe that models a shore). The test therefore reads them out of
 * `Swim.js`'s source, which is the same thing `planet-envelope.test.mjs` does
 * to the two reach probes' slope ceilings. Exporting them would be better and
 * `Swim.js` belongs to somebody else.
 */
const LUNG = 11.2;

/* -- The three benches that make one landmass ----------------------------- */

/** Meridian's bench: the north-west lobe of the shelf. */
const MER = { x: -215, z: -140, r: 196 };
/** The Glassflat: the open middle lobe, and where the ship comes down. */
const FLAT = { x: 150, z: 62, r: 148 };

/* -- The severed island --------------------------------------------------- */

/** Sundering Head. 382 m from the Glassflat's centre and joined to nothing. */
const HEAD = { x: 300, z: -290, r: 98 };
/** The Head's flat top, and therefore the head of the Sunder Stair. */
const HEAD_Y = 52;
/** The Tide Chasm's floor: 42 m down from the Head's top, 4.0 m above the sea. */
const CHASM_Y = 10.0;

/* -- The drowned half of the map ------------------------------------------ */

/**
 * THE SOUND - the drowned basin the Thread crosses, and the one part of the sea
 * bed this planet asks you to go and look at.
 *
 * Not authored: FOUND. The bed here is the untouched noise field between
 * Meridian's bench and the Glassflat, and it was measured on a 10 m grid before
 * this record existed - 6 to 13 m of water over about a 250 m spread, with the
 * shallow end running right up under the Thread's middle legs. A disc of r 140
 * about (46, -104) is what covers the part of it inside `LUNG`, and the depth
 * window on the field does the rest of the shaping.
 */
const SOUND = { x: 46, z: -104, r: 140 };

/** Barrow's drowned lagoon: floor at 0.0, so 6.0 m of water, and 34 m across. */
const LAGOON = { x: 306, z: 288, r: 38 };

/* ------------------------------------------------------------------ */
/* The features, as polylines                                          */
/* ------------------------------------------------------------------ */

/**
 * THE THREAD - the spit from Meridian's bench to the Glassflat.
 *
 * Both endpoints sit on FLAT bench (d 179.5 from Meridian's centre against a
 * 196 m bench; d 132.5 from the Glassflat's against 148), which is why this
 * ramp carries no `y0` or `y1`: a ramp with neither takes the pre-level field
 * at its own endpoints, and the pre-level field at both of those points is
 * exactly SHELF because a `plateau` replaces rather than adds. Writing the
 * numbers in would be writing a second copy of SHELF that goes stale the day
 * the bench moves.
 *
 * The middle three legs cross 73 m of open water where the bed is 9 m down.
 * This is the only pedestrian connection between Meridian and everything else.
 */
const THREAD = [[-58, -53], [-30, -46], [0, -27], [34, -2]];

/** BARROW SPIT - the Glassflat to the atoll, 52 m, same construction. */
const SPIT = [[224, 169], [236, 192], [254, 212]];

/**
 * THE WRACK BAR - a shell ridge across the northern Glassflat.
 *
 * 2.2 m over a 30 m half-width, which is 6.3 degrees at its steepest. It
 * exists because 148 m of dead-level plateau is a table, and because a storm
 * bar is what actually stands on a tidal flat. Low enough that the nodule
 * field's own 12-degree ceiling never rejects a sample for standing on it.
 */
const WRACK = [[58, 108], [104, 136], [162, 146], [218, 124]];

/**
 * THE TIDE CHASM. Every point lies within 69 m of the Head's centre, inside
 * the 98 m flat top, so the floor it cuts is level by construction rather
 * than inheriting the bench's edge blend - the twelve-metre-tilt lesson
 * applied to a trench instead of a lake.
 */
const CHASM = [[352, -334], [330, -310], [306, -286], [280, -262], [252, -240]];

/**
 * THE SUNDER STAIR - the only way onto the chasm floor.
 *
 * IT STARTS AT THE PAD CENTRE, and that is load-bearing rather than tidy: a
 * `ramp` with no `y0` takes its head height from the pre-level field at its
 * first point, and a `pad` with no `y` takes the same field at the same place.
 * Start the road a metre away and the two resolve to different numbers and the
 * player walks off a riser they cannot see. Volcanic.js's spiral begins at its
 * rim pad for exactly this reason.
 *
 * 167.7 m for 42.0 m of fall - a 0.250 grade, 14.1 degrees MEAN. It runs out
 * to d 96 on the Head's rim before turning back, because there is no straighter
 * route on a 98 m island that keeps the mean that low.
 *
 * THE MEAN IS NOT THE MEASUREMENT. An earlier version of this comment said the
 * route "does not exceed 20 degrees", and that was a claim about the polyline
 * rather than about the ground: the steepest 2 m of the built centre line was
 * 39.6 deg, thirty-one metres from the head, because the Sunder pad holds the
 * first 20 m of it dead flat and the blend annulus has to give the grade back
 * all at once. It measures 34.4 deg now, at (391, -284) 37 m along, and the
 * fix was the pad's `blend` rather than anything here.
 * @see the Sunder Deck pad in the LEVEL layer.
 */
const STAIR = [[372, -252], [396, -292], [382, -330], [352, -352], [332, -340], [341, -322]];

/* ------------------------------------------------------------------ */
/* The descriptor                                                      */
/* ------------------------------------------------------------------ */

export const SHOAL = definePlanet({
  id: 'shoal',
  name: 'Shoal',
  blurb: 'An ocean over a shallow shelf. Brine salt and nacre on the strand, polymetallic nodules out on the flat, abyssite down a tidal chasm you have to land in.',

  half: HALF,
  /**
   * 280 segments over 880 m: a 3.143 m cell, the same order as Cinder's 3.125.
   * The mesh and the collision heightfield are the SAME grid, so this number
   * buys both the shoreline's outline and the ground the player stands on -
   * and on this planet the shoreline is a 3 km contour rather than a circle,
   * so the cell is what decides whether a beach reads as a beach.
   */
  seg: 280,

  /**
      * 0.98 g, and BOTH consumers read it.
     *
     * This used to say "Phase 1 does not retune the player integrator against
     * it", which was true and honest while gravity reached only the ship. It
     * reaches the player on foot now, through the one predicate in
     * `WorldRules.worldGravity`: `Piloting._env` gives the flight model
     * `(0, -9.60, 0)`, and `Player.setWorldGravity` converts 9.60 to a ratio
     * against `CONFIG.player.gravityReference` (9.81) and walks in -21.53 m/s²
     * rather than the global -22.
     *
     * Measured here by driving the real controller: apex 0.885 m, hang
     * 0.539 s, against 0.878 m / 0.533 s on a world that publishes no
     * gravity at all. At 0.98 g the difference is meant to be felt rather than
     * played with - the variety is at the other end of the ladder, on Tessera
     * (0.17 g) and Lathe (0.19 g).
     *
     * @see ../../player/Player.js `setWorldGravity`
     */
  gravity: 9.60,

  /* ---------------------------------------------------------------- */
  terrain: {
    seed: 0x5ea140,
    baseY: BED,
    /** Long bed swells. 205 m: about one per two minutes' swim, if there were
     *  swimming - as it is, it is what makes the shoreline wander. */
    swell: { amp: 6.4, scale: 205, octaves: 4 },
    /** Ridged, so the drowned bed has sand-wave crests rather than blobs. */
    ripple: { amp: 1.9, scale: 31, octaves: 3 },
    grain: { amp: 0.26, scale: 24 },
    /** The map's edge falls away rather than walling up. Entirely under water
     *  here, so it does no visual work at all - the SEA hides the edge on this
     *  planet (see the header) and this is belt and braces. */
    rim: { start: 398, drop: 26 },

    landforms: [
      /* ---- ADD ---------------------------------------------------- *
       * Order inside this layer is not cosmetic. `plateau` REPLACES the
       * height inside its radius, so a bench written after the island that
       * stands on it would flatten the island away. Benches first, islands on
       * top of them, horns on top of those, then the two additive forms - the
       * wrack bar and the dune ripple - last, so they ride everything.        */

      /** Meridian's bench. */
      { kind: 'plateau', x: MER.x, z: MER.z, r: MER.r, y: SHELF, edge: 70 },
      /** The Glassflat. */
      { kind: 'plateau', x: FLAT.x, z: FLAT.z, r: FLAT.r, y: SHELF, edge: 66 },

      /**
       * MERIDIAN. r 112 inside a 196 m bench, so 38 m of flat tidal platform
       * survives all the way round the island rather than being buried under
       * its own beach - which is what an `edge` wide enough to be walkable
       * costs you if the bench is not made bigger to pay for it.
       * 46 m of edge for 10.25 m of fall: 18.5 degrees at its steepest, well
       * inside the 38-degree envelope the reach probes use.
       */
      { kind: 'plateau', x: MER.x, z: MER.z, r: 112, y: 17.5, edge: 46 },

      /**
       * CORAL CROWN. Summit 75.5 - 69 m above the water, and the only thing on
       * the planet with a skyline.
       *
       * peak 58 over r 150 is a maximum flank of 58*1.7/150 = 0.657, i.e. 33.3
       * degrees. That is deliberate and it is the third number tried: at
       * r 118 the same peak gives 37.9 degrees, which is inside the probes'
       * 38-degree ceiling by a tenth of a degree - a mountain whose walkability
       * depends on rounding. Widening the cone rather than lowering it keeps
       * the silhouette and buys 5 degrees of margin.
       */
      { kind: 'cone', x: -248, z: -176, r: 150, peak: 58 },
      /** THE DOLINE - a collapsed sink on Meridian's eastern shoulder. `pit`
       *  was written for a cinder cone's summit crater; on limestone it is a
       *  doline, which is the same shape for a different reason. */
      { kind: 'cone', x: -152, z: -84, r: 52, peak: 17, pit: 0.30 },

      /**
       * BARROW. No bench under it: the atoll's outer reef is steep on purpose,
       * 24.7 degrees, so it reads as a ring standing out of deep water rather
       * than as a third tidal flat. Its walkable ground reaches d 102 and the
       * spit lands at d 92.
       */
      { kind: 'plateau', x: 306, z: 288, r: 56, y: 21, edge: 88 },

      /**
       * SUNDERING HEAD. The severed island, and the one number on this planet
       * that was a claim rather than a measurement until the sea got deep.
       *
       * ── WHAT `edge: 54` ACTUALLY BUILT ───────────────────────────────────
       *
       * This block used to say "52 m of top over a bed at -6 across 54 m of
       * edge is a maximum face of 61 degrees ... the reach lattice refuses
       * anything over 38, so there is no bearing on which a body can climb out
       * of the water onto this island". Every clause of that was wrong in a
       * different way, and the sea hid all three for as long as it was a fence.
       *
       *   THE 61 WAS THE PEAK, NOT THE FACE. `plateauAt` blends with a
       *   smoothstep, whose gradient is `1.5 * fall / edge` at the MIDDLE of
       *   the annulus and zero at both ends. 61 degrees was the middle of the
       *   fall, at y ~ 23 - forty metres above anything a swimmer can touch.
       *
       *   THE WATERLINE IS THE PART THAT MATTERS, and it sits at t ~ 0.78 down
       *   the same curve, where the gradient has already fallen to about
       *   `0.9 * fall / edge`. MEASURED on the collision heightfield: the
       *   shallowest cell in the band a swimmer can climb out into was
       *   **44.2 degrees**, the median 53.3, and 412 of the 575 cells in that
       *   band were standing room.
       *
       *   38 WAS THE WRONG CEILING. `Grounding.WALKABLE_NORMAL_Y` puts the
       *   real one at `acos(0.55)` = 56.63 degrees. 44 is a wall at 38 and a
       *   walk at 56.63, which is why ten authors read a cliff here.
       *
       * The consequence, once the sea became swimmable, was measured rather
       * than argued: abyssite from the Glassflat pad went 0 of 7 to 7 of 7 -
       * swim across, wade ashore on the west flank at (250, -162), walk the
       * ramp, walk the chasm floor. A `liquid.guard` circle held it for one
       * build; this is the terrain change that made the guard unnecessary and
       * deleted it.
       *
       * ── WHY 18, AND WHY THE AUTHORED FIGURE OVERSHOOTS ───────────────────
       *
       * The gate has to hold at REAL + jump + swim, and the number it has to
       * beat is the gradient at the WATERLINE, not the peak. Solving the
       * smoothstep at the height the sea cuts it:
       *
       *     edge 54   waterline 44.2 deg   MEASURED   412 exit cells standable
       *     edge 40   waterline 51.5 deg   MEASURED    29 exit cells standable
       *     edge 32   waterline 59.5 deg   MEASURED     0
       *     edge 18   waterline 70.8 deg   MEASURED     0, median face 75.9
       *
       * 32 is where the gate closes and 18 is where it closes with 14 degrees
       * in hand. The margin is not timidity: THE COLLIDER IS A DISCRETISED
       * HEIGHTFIELD - 880 m over 280 segments, a 3.143 m cell - so what a
       * probe can measure is rise per cell however sharp the analytic profile
       * is. Lathe's author authored a 64.3-degree flank and measured 54. Every
       * figure in the table above is read off the same bilinear sample the
       * physics heightfield hands out, at the same 2 m central difference the
       * reach lattice uses, so it is what the game has rather than what the
       * arithmetic promised.
       *
       * What 18 costs: the Head's footprint falls from r 152 to r 116, so
       * there is 36 m more open water round it and the stack reads as a stack
       * instead of a cone. What it does not cost is the inside - the Sunder
       * Deck pad sits at d 81 and the Sunder Stair turns at d 96, both inside
       * the 98 m top, so abyssite stays 7 of 7 from its own pad on every
       * envelope. Re-measured in both directions; see the header.
       */
      { kind: 'plateau', x: HEAD.x, z: HEAD.z, r: HEAD.r, y: HEAD_Y, edge: 18 },

      /** The wrack bar, on the Glassflat. */
      { kind: 'ridge', pts: WRACK, width: 30, height: 2.2, taper: 0.25 },

      /**
       * THE GLOBAL RIPPLE, and it is why this planet does not read as CAD.
       *
       * See the header: `plateau` erases the swell, the ripple and the grain
       * from every walkable surface on Shoal, so without this the islands, the
       * benches, the Head's top and the chasm floor are all analytically
       * smooth. 0.30 m at a 19 m wavelength is ripple-marked sand at eye level
       * and 2.8 degrees of slope - under every placement ceiling in this file.
       * r 700 covers the 622 m half-diagonal with the taper (5%) falling
       * entirely outside the playfield, so there is no fade-out inside the map.
       */
      { kind: 'dunes', x: 0, z: 0, r: 700, amp: 0.30, wavelength: 19, angle: 0.42, sharpness: 0.35, taper: 0.05, seed: 0x51de },
      /**
       * And a coarser set on the Glassflat only - the sand waves a tidal flat
       * actually carries, at a scale you can see across the bench. 0.55 m over
       * 26 m is 3.8 degrees, which is why the nodule field's ceiling is 12 and
       * not 8: at 8 the ripple crests were being rejected and the nodules were
       * lining up in the troughs.
       */
      { kind: 'dunes', x: FLAT.x, z: FLAT.z, r: 150, amp: 0.55, wavelength: 26, angle: 0.62, sharpness: 0.45, taper: 0.40, seed: 0x2b17 },

      /* ---- CUT ---------------------------------------------------- */

      /**
       * BARROW LAGOON. Floor at 0.0, i.e. 6 m under the sea, so the sea's own
       * plane fills it and the atoll has a lagoon without a second liquid
       * body - the plane is already there and it is already flat.
       * Inner wall 49.7 degrees: not climbable, which is correct. You look
       * into a lagoon.
       */
      { kind: 'basin', x: 306, z: 288, r: 40, depth: 21, flat: 0.42 },

      /**
       * THE TIDE CHASM. Cubed walls, so it is a fissure and not a valley.
       *
       * depth 42 from a 52 m top leaves the floor at 10.0 - FOUR METRES ABOVE
       * SEA LEVEL, and that is the whole design of this feature. Cut it one
       * metre deeper on an ocean world and the sea plane covers the floor: the
       * chasm becomes a flooded slot with an invisible bottom and the exotic
       * ore is under the water table. "Deep" on Shoal has to be measured from
       * the top down, never from the datum.
       */
      { kind: 'trench', pts: CHASM, width: 13, depth: 42, lip: 2.6, lipWidth: 15 },

      /* ---- LEVEL -------------------------------------------------- *
       * ROADS FIRST, PADS LAST. Volcanic.js measured what the other order
       * costs: a road leaving a pad centre at a 0.15 grade had already taken
       * 3.0 m off inside a 20 m disc - a landing pad with a three-metre fall
       * across it, 3.00 m of span before and 0.00 m after. The Sunder Stair
       * leaves its pad at 0.25, so the same mistake here would cost twice as
       * much.                                                                */

      /** The Thread. No `y0`/`y1`: see the const. */
      { kind: 'ramp', pts: THREAD, width: 15, blend: 32 },
      /** Barrow Spit. Its toe is on Barrow's outer reef at d 92, so `y1`
       *  defaults to the reef's own height there and the spit meets the island
       *  without a step. */
      { kind: 'ramp', pts: SPIT, width: 14, blend: 28 },
      /** The Sunder Stair. `y1` is explicit and it is the chasm floor exactly:
       *  the toe lands ON the centreline, so a defaulted `y1` would have taken
       *  the pre-level trench bottom at that point and the road would have
       *  ended in a step of whatever the lip happened to be doing. */
      { kind: 'ramp', pts: STAIR, width: 7.5, blend: 13, y1: CHASM_Y },

      /** Glassflat Deck - the primary. */
      { kind: 'pad', x: 168, z: 86, r: 30, blend: 24 },
      /** Kelphold, on Meridian under the Crown's flank. */
      { kind: 'pad', x: -206, z: -72, r: 22, blend: 18 },
      /**
       * Sunder Deck. d 81 from the Head's centre against a 98 m top, so the
       * pad's 20 m disc plus its 24 m blend runs 27 m PAST the rim and notches
       * the cliff rather than balancing on it - the same shelf-blasted-into-
       * the-headland read Volcanic.js's rim pad has, and for the same reason.
       *
       * ── THE BLEND WAS 16, AND 16 PUT A 39.6 DEG RISER ON THE DOORSTEP ────
       *
       * "Roads first, pads last" has a second face, and this is it. The Stair
       * correctly starts at this pad's CENTRE so the ramp head and the pad
       * resolve to the same height - but `pad` is a LEVEL and runs AFTER
       * `ramp`, so the disc holds the road DEAD FLAT out to r 20 and the road's
       * whole accumulated grade has to be given back inside the blend annulus
       * just outside it. The riser is `r * tan(grade)` = 20 * 0.251 = 5.0 m,
       * and at `blend` 16 it came off in one step: measured, flat at y 52.09
       * for 20 m and then down to y 42.34 over 16, with a worst 2 m segment of
       * **39.6 deg at (388, -279)** - over the 38 deg walking envelope, on the
       * one route to the exotic tier, thirty-one metres from where you land.
       *
       * The gradient the annulus produces is `grade * ((1 - w) + d * |w'|)`
       * with `|w'|` peaking at `1.5 / blend` at `d = r + blend/2`, so it is
       * `grade * (1.25 + 2r / blend)` at its worst and `blend` is the only term
       * that is free here - the grade is set by 42 m of fall on a 98 m island
       * and `r` is set by the landing site. 16 gives 38.1 deg predicted (39.6
       * measured); 24 gives 32.1 (33.4 measured), which is inside the envelope
       * with six degrees to spare and still short of the 30 m that would push
       * the blend off the far side of the Head.
       *
       * Cinder survives the identical construction untouched only because its
       * spiral is 11 deg over an r 20 pad. This planet is 14.1 over the same
       * radius, and that is the whole difference.
       */
      { kind: 'pad', x: 372, z: -252, r: 20, blend: 24 },
    ],
  },

  /* ---------------------------------------------------------------- */
  palette: {
    /* `rock.neutral`, not `dirt.ground`. Bleached shell sand is the brightest
     * thing at eye level here and the ring of it round each island is what
     * makes the shelf read at 400 m - and `dirt.ground` bakes a measured linear
     * R:G:B of 1.79 : 1 : 0.49 into its albedo, which the vertex bands multiply
     * into. The flats (`#d9cda6`) and the guano-white Crown (`#dfe4e6`) came
     * out the same olive-tan as the scrub, and the wet strand (`#3f7a6a`, the
     * only cool band under the waterline) came out warm. @see shadeRockNeutral
     * in gfx/Materials.js */
    material: 'rock.neutral',
    /** 4.5 m a tile, finer than Cinder's 6.0: this is sand and shell at the
     *  waterline rather than ash, and it is looked at from two metres up. */
    tile: 4.5,
    /**
     * Absolute-height bands.
     *
     * ── THE RULE CINDER PAID FOR ──────────────────────────────────────────
     * Cinder shipped six bands across five degrees of hue and zero saturation
     * change, and the tester who walked it wrote "one flat salmon-brown hue".
     * Value structure alone is a black-and-white photograph of a planet.
     * `planet-atmosphere.test.mjs` now puts a floor of 40 degrees of hue
     * spread and 15 points of saturation spread on the table. This one clears
     * both easily, and none of it is arbitrary - it is the things you can
     * actually stand on, in order:
     *
     *   y   5.6  #123a3e  hue 186  the drowned bed. Never seen (the sea is
     *                              opaque) but it is what the shoreline lerps
     *                              FROM, so it has to be a plausible wet dark.
     *   y   6.4  #3f7a6a  hue 164  the wet strand: weed and saturated sand.
     *   y   7.45 #a89a74  hue  44  DAMP SHELL SAND - the ripple troughs.
     *   y   8.2  #d9cda6  hue  44  the flats: bleached crest sand, and the
     *                              lightest thing at eye level anywhere on the
     *                              planet - which is what makes the ring of
     *                              shelf round each island read at 400 m.
     *   y  19    #b08a5c  hue  33  dry back-beach, warm tan.
     *   y  34    #6b7a4a  hue  76  salt scrub. The one green on the planet and
     *                              the reason the growth field is there.
     *   y  58    #8c9298  hue 208  weathered limestone, cool and nearly grey.
     *   y  92    #dfe4e6  hue 192  the Crown and the Head: sun-bleached and
     *                              guano-white, so the summit is the brightest
     *                              value in the frame and the silhouette holds
     *                              against a bright sky.
     *
     * ── WHY 7.0 AND 9.6 MOVED: THE GLASSFLAT WAS ONE FLAT GREEN ──────────
     *
     * A tester standing on the primary pad wrote that the near field was one
     * uniform green, which is the exact defect this table was built against,
     * arriving in a table with 153 degrees of hue in it. MEASURED, off the
     * same lerp `PlanetWorld._terrainColors` runs:
     *
     *   the pad's own ground is y 7.77, and the old anchors either side of it
     *   were 7.0 (#3f7a6a, a teal) and 9.6 (#d9cda6, a sand). f came out 0.30,
     *   so the pad rendered **#879980** - and the whole near field, 15,600 of
     *   the 17,000 dry samples within 160 m, sat between #598370 and #9fa78a.
     *
     * NEITHER OF THOSE IS A BAND. They are the 70/30 blend between two anchors
     * 2.6 m apart, in a place where the ground only varies by one metre, and a
     * lerp from teal to tan passes straight through mud-green. The table was
     * not lying about the flats; the flats' colour simply never appeared
     * anywhere, because no ground on this planet is at y 9.6.
     *
     * So this is a boundary nudge and not a repaint - every hex above except
     * the new #a89a74 is the one that was already there:
     *
     *   7.0 -> 6.4    the strand becomes the strand: 0.4 m of shore, which is
     *                 the same window `nacre` is scattered in (6.75..7.22) and
     *                 the last thing above the sea that is genuinely wet.
     *   NEW 7.45      damp shell sand, at the bottom of the Glassflat's own
     *                 dune range.
     *   9.6 -> 8.2    the bleached sand, at the TOP of it. The dunes run 0.85 m
     *                 (0.30 global + 0.55 on the flat), so the pair now
     *                 brackets the ripples instead of spanning three metres of
     *                 nothing: troughs read damp, crests read bleached, and
     *                 "ripple-marked sand" is a thing you can see rather than a
     *                 line in a comment. The pad itself lands at f 0.43,
     *                 **#bdb18d** - warm pale sand.
     *
     * The `mottle` is untouched and is the other half of why this works. A
     * teal stain at 0.58 over a teal base is invisible; over sand it is weed.
     *
     * ── The two numbers this is not free to move ─────────────────────────
     * The atmosphere test asserts the haze is LIGHTER and no more SATURATED
     * than the mean of this table, measured in the working (linear) space
     * `THREE.Color.getHSL` reports in. The new anchor is a mid sand, so it
     * lifts the ground mean slightly and the fog has to stay clear of it;
     * re-measured, both hold with room, and the test re-derives them from this
     * table every run rather than from a copy.
     */
    bands: [
      { upTo: 5.6, color: 0x123a3e },
      { upTo: 6.4, color: 0x3f7a6a },
      { upTo: 7.45, color: 0xa89a74 },
      { upTo: 8.2, color: 0xd9cda6 },
      { upTo: 19, color: 0xb08a5c },
      { upTo: 34, color: 0x6b7a4a },
      { upTo: 58, color: 0x8c9298 },
      { upTo: 92, color: 0xdfe4e6 },
    ],
    /** Wet undercut limestone on anything steep - the Head's cliffs, the
     *  chasm walls, the atoll's inner face. Dark and cold, so a cliff reads as
     *  a cliff against the sand above it. */
    slope: { fromDeg: 28, toDeg: 50, color: 0x33474c },
    /** Weed and algal staining, so the bands do not read as a contour map.
     *  The term is applied as `n * n * amount`, so most of the field never
     *  approaches the ceiling. */
    mottle: { scale: 44, amount: 0.58, color: 0x2c6a63 },
  },

  sky: {
    kind: 'daylight',
    params: {
      /**
       * A BLUE SKY, which is the opposite of Cinder in every parameter that
       * matters: rayleigh 2.6 against 0.12 and mie 1.1 against 4.4. Cinder is
       * dust with no air in it; this is clean marine air with a lot of water
       * vapour low down, and `altitude: 30` is not a rounding - the player
       * stands at sea level on this planet, which is the only world in the
       * system where that is literally true.
       *
       * Sun to the SOUTH-SOUTH-EAST and 31 degrees up. A planet's key light is
       * chosen from one of its landing sites and not from the origin: a player
       * on Glassflat Deck faces west-north-west to look at Coral Crown, so this
       * puts the sun behind their right shoulder and lights the Crown's
       * near flank. Behind the mountain would give a black cut-out against a
       * bright sky with an unreadable foreground, which is what Cinder's first
       * pass did.
       */
      sunDirection: [0.34, 0.52, 0.79],
      sunColor: 0xfff2dc,
      sunIntensity: 15,
      sunAngularSize: 0.019,
      rayleigh: 2.6,
      mie: 1.1,
      mieG: 0.76,
      altitude: 30,
      /** The dome's ground term. It is looking at an ocean, so it is the sea's
       *  own colour rather than a rock colour. */
      groundColor: 0x2a6a86,
      /** THE SAME NUMBER AS `fog.color`, and that is the point. The sea disc
       *  is clipped at the far plane (see the header), so the seam where the
       *  water stops and the dome starts sits at 100% fog; the two agreeing
       *  exactly is what makes that seam invisible instead of a hard line
       *  along the horizon. */
      hazeColor: 0xa8c2d2,
      horizonHaze: 0.62,
      cirrus: 0.52,
      cirrusScale: 1.6,
      cirrusSpeed: 0.0055,
    },
    background: 0x87b3cc,
    /**
     * ── The fog, and the horizon it has to build ──────────────────────────
     *
     * `half` is 440, so the playfield diagonal is 1,244 m. The atmosphere test
     * puts a FLOOR there (fog shorter than the diagonal makes the far half of
     * the map one flat colour) and a CEILING at `CONFIG.render.far` = 2,000
     * (fog longer than the far plane leaves geometry popping at the clip).
     * 300..1,900 sits between them, at 1.53x the diagonal.
     *
     * ── IT WAS 110..1,370, AND THE PLANET WAS A GREY-BLUE WASH ───────────
     *
     * A reviewer looking at the overview wrote that the islands read
     * near-monochrome from altitude and the sea washed to grey-blue. Linear
     * fog, so that is arithmetic rather than taste. `shoot-planets.mjs` puts
     * the overview camera at `[half*0.78, half*1.15, half*0.78]`, which is
     * 701 m from the middle of the map:
     *
     *                       at 490 m    at 701 m    at the 1,244 m corner
     *     110..1,370          30%         47%            90%
     *     300..1,900          12%         25%            59%
     *
     * Forty-seven per cent haze over the centre of the map is not aerial
     * perspective, it is a wash, and everything under it converges on one
     * colour - which is the same failure as Cinder's flat salmon-brown
     * arriving by a different route.
     *
     * ── WHY THIS PLANET MAY HAVE THE LONGEST FOG OF THE EIGHT WITH AIR ───
     *
     * The old comment's reason for stopping at 1.10x was "the terrain mesh
     * ends at +/-440 and fog is what hides the edge of it". THAT IS NOT TRUE
     * HERE, and this file says so twice already: `terrain.rim` drops the map
     * edge 26 m, the sea bed there is 20-34 m under the surface, and the SEA
     * runs on to 2,700 m. The edge of the land is not merely fogged on Shoal,
     * it is UNDERWATER, and the thing beyond it is more ocean. Nine planets
     * need a fog that hides where the ground stops. This one does not, and
     * paying the price of one anyway cost it its islands.
     *
     * The seam that does have to disappear is where the sea meets the dome,
     * and that is still handled: the disc is clipped at the 2,000 m far plane,
     * where 1,900 has already reached 100%, and `sky.hazeColor` is the same
     * hex as this colour so the two agree exactly at the horizon.
     *
     * `near` 300 rather than 110 for the other half of it: at 490 m - the
     * Glassflat Deck to Coral Crown sight line, the only silhouette on the
     * planet - the Crown now sits under 12% haze instead of 30%, which is air
     * rather than gauze.
     *
     * The colour is unchanged, lifted and DESATURATED off the ground, and both
     * halves are asserted against the palette's own bands rather than by eye:
     * a marine haze is lighter and greyer than the sand it hangs over, and a
     * sea-coloured fog over a sea-coloured sea would be Cinder's "big dark
     * room" repeated in blue.
     */
    fog: { color: 0xa8c2d2, near: 300, far: 1900 },
    /**
     * Ambient 0.62 - the highest on any planet so far, and it is earned rather
     * than lazy: two thirds of the visible hemisphere from anywhere on this
     * map is either a bright sky or a lit sea, and both bounce. Tinted to the
     * sky, not to the sun.
     *
     * The key still beats the fill 12:1 (0.62/7.4 = 0.084 against the
     * atmosphere test's 0.12 ceiling), because a face turned away from the sun
     * has to be a different value from one facing it or there is no terminator
     * on any slope - the defect that made Cinder's 71-degree crater wall shade
     * the same as a flat of ash.
     */
    ambient: { color: 0x9ec4d8, intensity: 0.62 },
    sun: { color: 0xfff2dc, intensity: 7.4, direction: [0.34, 0.52, 0.79] },
    exposure: 1.06,
    /**
     * `sports`, not `dock`. `GRADE_PRESETS` is keyed on WORLD id and a planet
     * is not in it, so naming one here is the only way a planet gets a
     * calibrated look - and of the five, `sports` is the one built for "bright
     * neutral daylight": a cool-blue haze term, a small split so white
     * surfaces keep separating from each other, low vignette and almost no
     * grain. `dock`'s warm highlights and 0.42 vignette are a shed's grade and
     * they would put a brown cast on 3 km of water.
     */
    grade: 'sports',
  },

  /* ---------------------------------------------------------------- */
  liquid: {
    name: 'sea water',
    /**
     * WATER, AND THEREFORE SWIMMABLE. The rule the header opens with -
     * "`PlanetWorld` sets `swim: false`. THE PLAYER CANNOT SWIM" - is no
     * longer true, and this is the field that ends it. `PlanetWorld` now asks
     * the LIQUID (`liquidSwimmable`) rather than asserting for all ten planets
     * at once, so Cinder's lava stays out of bounds and this sea does not.
     *
     * The design rule the header states - the walkable world is exactly the
     * ground above y 6.6, and the ore the primary pad should reach is all on
     * one connected piece of it - survives intact, and it was RE-MEASURED
     * rather than assumed, on every pad and every seam, at all four envelopes.
     * The one place it did not survive was Sundering Head, and that was fixed
     * in the terrain rather than fenced: see the landform, and the note below
     * about the `guard` this record no longer carries.
     */
    kind: 'water',
    /**
     * ONE BODY. See the header for why it is one, why it is 2,700 m, and why
     * its `wobble` is zero.
     *
     * The shoreline of this planet is not in this record at all: it is the
     * y = 6.0 contour of the terrain, about 3 km of it, and it wanders with
     * the 205 m bed swell because the islands' edge blends resolve against a
     * bed that is moving. That is the opposite of Volcanic.js's crater lake,
     * which needed three harmonics of authored wobble to stop reading as a
     * decal - a lake has an outline and an ocean does not.
     */
    bodies: [
      { shape: 'disc', x: 0, z: 0, r: 2700, y: SEA, wobble: 0 },
    ],
    /* Read the header before touching these four: this is the lava material's
     * first non-lava caller and two of the channels do not mean what they are
     * named. `crust` is the LIGHTER colour here and `color` the darker, which
     * is the swap that turns molten veins into wind streaks. */
    color: 0x0d3348,
    crust: 0x2f6d8a,
    hot: 0x9fd4e6,
    emissive: 0.16,
    flow: 0.22,
    /** Null on purpose - see the header. Water does not emit. */
    glowLight: null,
    lethal: false,
    /*
     * NO `guard`, AND THAT IS A CHANGE RATHER THAN AN OMISSION.
     *
     * This record carried one for a build: a declared 150 m barrier circle
     * round Sundering Head, 683 shore posts, because the Head's `plateau`
     * edge was a 44-degree ramp and not the cliff this file claimed, and the
     * exotic guarantee died the moment the sea became swimmable. Its author
     * wrote the honest version of what it was: "The guard is a wall, not a
     * fix. Steepening that `edge` and deleting the guard is the real change."
     *
     * That is what happened. `edge` is 18, the face measures 70.8 degrees at
     * its shallowest above the wading line against a 56.63-degree envelope,
     * and there is no cell anywhere round the Head that a swimmer can climb
     * out onto. The severance is geometric again, which is what the header
     * always said it was. Re-measured with the guard GONE, at REAL + jump +
     * swim: abyssite 0 of 7 from `glassflat` and from `kelphold`, 7 of 7 from
     * `sunder`, every other seam unchanged.
     *
     * AND THE GUARD HAD ALREADY STOPPED HOLDING, which is the part worth
     * keeping. Measured on the tree this change was made in, with the guard
     * still in place and the terrain still at `edge: 54`:
     *
     *     shoal/abyssite envelope (d): 7 of 7 nodes walkable from glassflat
     *     at 734 m (envelope (a) said 0)                       <<< BROKEN
     *
     * Somebody moved a barrier post - not this file - and the 150 m circle
     * silently stopped being a fence, in the one build between the guard being
     * written and this being read. That is the whole argument against holding
     * a design guarantee up with furniture: the furniture belongs to somebody
     * else, and a wall that fails fails quietly. A 70-degree cliff belongs to
     * this file and cannot be moved by anybody who is not editing it.
     *
     * So Shoal's whole 3 km of shore is now open water you swim in, with zero
     * barrier posts on it - the state `barrier-leap.test.mjs` derives rather
     * than lists, so deleting this field moved this planet from its WALLED
     * list to its OPEN one by itself.
     */
  },

  /* ---------------------------------------------------------------- *
   * PROPS
   *
   * Every region carries a `yMin` and none carries `clearOfLiquid`, for the
   * reason in the header: on a planet whose sea covers the playfield,
   * `clearOfLiquid` rejects every sample and `yMin` is both the working guard
   * and the truthful question.
   *
   * ── THE SENTENCE THAT USED TO END THAT PARAGRAPH ────────────────────────
   *
   * It read: "A boulder under the sea is not merely wasted - it is an
   * invisible collider in water the player should not be in." That was exact
   * while `PlanetWorld` set `swim: false`. It is now backwards. The last two
   * fields in this list are DELIBERATELY under water, and the rule that
   * replaces it is the depth one:
   *
   *   NOTHING GOES BELOW `SEA - LUNG`, AND NOTHING STICKS OUT OF THE WATER.
   *
   * The first half is reachability - see `LUNG`. The second half is the one
   * that has to be checked by hand, because `scatter` places a POINT and
   * `PlanetProps` picks the height off the size range afterwards, with no idea
   * how deep the water over it is: a 8 m kelp stipe on a bed 2 m down is a
   * tree standing in the sea. So each underwater field's `yMax` and its
   * tallest `h` are chosen together, and the sum is under SEA on every
   * instance. The kelp: bed at or under 0.0, tallest 5.4, top 5.4 < 6.0.
   *
   * `spires`, `growth` and `slabs` were being added to `PROP_KINDS` by another
   * agent while this file was written; they are present in
   * `PlanetDescriptor.js` and in `PlanetProps.js` as of this build and all
   * three are used here.                                                     */
  props: [
    {
      id: 'storm_blocks',
      kind: 'boulders',
      /* Reef rubble thrown up the beach. `yMin` at 6.7 keeps every one of them
       * out of the water; the 30-degree ceiling keeps them off the Head's
       * cliffs and the lagoon's inner wall, where they would be scenery inside
       * geometry nothing can walk to. */
      region: { shape: 'field', yMin: 6.7, slopeMaxDeg: 30, clearOfPads: 6 },
      count: 820, spacing: 7,
      size: { rMin: 0.55, rMax: 2.6 },
      tint: [0x8e9086, 0x76786e, 0x9ea094, 0x63665f],
      collide: true,
    },
    {
      id: 'coral_heads',
      kind: 'spires',
      /* An ANNULUS, so the coral stands on the OUTER half of the flat where
       * the water reaches it and not in the middle where the ship comes down.
       * 8 m spacing against a 1.5 m maximum base leaves lanes 5 m wide -
       * Cinder's colonnade lost a whole seam inside 2 m lanes and had to be
       * cut from 210 to 150; this is the same arithmetic done first. */
      region: { shape: 'annulus', x: FLAT.x, z: FLAT.z, r0: 84, r1: 146, yMin: 6.9, yMax: 8.4, slopeMaxDeg: 12, clearOfPads: 8 },
      count: 150, spacing: 8,
      size: { h: [2.2, 7.5], base: [0.45, 1.5], lean: 0.10, facets: 6 },
      tint: [0xd6cfb8, 0xc2bda6, 0xe0dcc6, 0xb0ab96],
      collide: true,
    },
    {
      id: 'reef_plates',
      kind: 'slabs',
      /* Upended limestone pavement. The collider a slab gets is a rotated step
       * at its own footprint rather than a box round the whole plate, so a
       * field of them at 5.5 m is something you walk over rather than a maze -
       * which is why this can be dense where the coral cannot. */
      region: { shape: 'disc', x: FLAT.x, z: FLAT.z, r: 138, yMin: 6.9, yMax: 8.6, slopeMaxDeg: 10, clearOfPads: 7 },
      count: 230, spacing: 5.5,
      size: { w: [1.5, 4.0], d: [1.3, 3.4], t: [0.22, 0.62], tilt: 0.5 },
      tint: [0x9aa09a, 0x878d88, 0xa9afa6, 0x7a807c],
      collide: true,
    },
    {
      id: 'salt_scrub',
      kind: 'growth',
      /* The only living thing on the planet, and the reason the 34 m band is
       * green. `yMin: 11` keeps it off the beach and out of the spray; the
       * canopy is wide and low and its collider is the TRUNK only, so a stand
       * is something you walk under rather than an invisible ceiling. */
      region: { shape: 'disc', x: MER.x, z: MER.z, r: 128, yMin: 11, slopeMaxDeg: 26, clearOfPads: 5 },
      count: 210, spacing: 6,
      size: { trunk: [0.10, 0.26], h: [1.7, 3.6], canopy: [1.0, 2.3], droop: 0.5 },
      tint: [0x5d7346, 0x6b8050, 0x4e6339, 0x778a58],
      trunkTint: [0x6a6155, 0x585045],
      collide: true,
    },
    {
      id: 'chimneys',
      kind: 'spires',
      /* Hydrothermal chimneys down the chasm, and they are canon rather than
       * decoration: `ITEMS.abyssite` reads "hydrothermal precipitate off the
       * wall of the tidal chasm, still faintly warm and faintly luminous".
       *
       * 16 at 7 m, and both numbers are measured rather than chosen.
       *
       * The dense version of this is the Cinder colonnade defect exactly - a
       * field a body cannot walk into with the planet's most valuable ore
       * behind it - so the SPACING comes from the lane width first: a 0.95 m
       * maximum base gives a 1.5 m collider footprint (the collider is the
       * spire's foot, not its whole height), so 7 m of spacing leaves 5.5 m of
       * lane in a slot whose walkable floor is 5.3 m wide.
       *
       * The COUNT is then what the region holds at that spacing. The first
       * version asked for 22 and the scatter saturated at 12 - a field
       * under-delivering by 45%, which is a number nobody can reason about,
       * and exactly the arithmetic that cut Cinder's colonnade from 210 to
       * 150. Measured against the real height function: 16 places 16 with 23
       * spacing rejections, and saturation is around 23. */
      region: { shape: 'corridor', pts: CHASM, width: 6.0, yMin: 8.5, slopeMaxDeg: 26 },
      count: 16, spacing: 7,
      size: { h: [1.8, 6.4], base: [0.30, 0.95], lean: 0.20, facets: 5 },
      tint: [0x27505e, 0x1e3f4c, 0x2f5f6e],
      /* Per FIELD, not per instance - `MeshStandardMaterial` multiplies the
       * instance colour into the diffuse and never the emissive. Faint: this
       * is the only light in a 42 m slot and it is meant to be a hint that
       * something is down there, not a lamp. */
      glow: 0x1ad0e8,
      glowStrength: 0.55,
      collide: true,
    },

    /* ---- UNDER THE WATER ------------------------------------------- *
     *
     * THE DEFECT THESE TWO FIELDS CLOSE, AND THE MEASUREMENT THAT SIZED THEM.
     *
     * Reported after the sea became swimmable: "Oxygen is 14 s, so Shoal's
     * deepest bed (40 m) is not divable - the deep sea bed is still content
     * nobody sees." Built and not reachable is this project's signature
     * defect, and on the ocean world it would be landing on the sea itself.
     *
     * So the bed was measured rather than argued about, over all 78,961
     * samples of the height field:
     *
     *     water depth     share of the wet map     cumulative
     *      0 -  2 m            4.9%                   4.9%
     *      2 -  5 m            6.3%                  11.2%
     *      5 -  8 m            7.9%                  19.1%
     *      8 - 11 m           28.2%                  47.3%
     *     11 - 14 m           28.8%                  76.1%
     *     14 - 18 m            4.8%                  81.0%
     *     18 - 26 m            5.6%                  86.6%
     *     26 - 40.7 m         13.4%                 100.0%
     *
     * TWO THINGS FELL OUT OF IT AND THEY POINT OPPOSITE WAYS.
     *
     *   THE 40 m IS THE MAP EDGE, NOT THE SEA BED. Every sample deeper than
     *   about 16 m is outside `terrain.rim.start` (398) - it is the skirt this
     *   file already describes as doing no visual work, the world falling away
     *   at its boundary. INSIDE the rim the deepest water on Shoal is 16.3 m
     *   and 98.1% of it is 14 m or less. There is nothing down the 40 m and
     *   there never was: it is not unreachable content, it is the edge.
     *
     *   THE REST OF THE BED WAS REACHABLE ALL ALONG AND EMPTY. 66% of the bed
     *   inside the rim is within `LUNG`, four seconds of air still in hand, and
     *   there was not one object on any of it. The lagoon at Barrow is the
     *   sharpest version: a 6 m basin inside a reef ring, reached on foot down
     *   Barrow Spit, and the header's own line about it is "You look into a
     *   lagoon." You looked into it and it was bare sand.
     *
     * THE DESIGN THAT FOLLOWS FROM THAT: the shallow shelf carries the
     * interest, and the deep water is a reason not to go there rather than a
     * place with things in it. The reason is already in the engine and was
     * nowhere in this file - `PlanetWorld` swaps the fog for `UNDER_FAR` = 26 m
     * of the liquid's own colour the moment the camera goes under, so below
     * about 12 m Shoal is a dark blue room with a clock running in it. That is
     * a good thing for an ocean to be. It is only a defect if something is
     * hidden in it, so nothing is.
     *
     * BOTH FIELDS ARE ENTIRELY INSIDE THE LUNG AND INSIDE THE 26 m SIGHT LINE,
     * and `planet-dive.test.mjs` measures both claims off `Swim.js`'s own
     * constants.                                                             */
    {
      id: 'kelp',
      kind: 'growth',
      /**
       * THE SOUND'S KELP BEDS. `growth` again, on a bed instead of a hillside,
       * and the same geometry answers both because a stipe with a frond mass
       * on it IS a trunk with a canopy - the difference is the droop, which is
       * 0.9 here against the scrub's 0.5 because kelp hangs.
       *
       * -- The depth window is doing three jobs at once ---------------------
       *
       *   yMin -5.2   is `SEA - LUNG` exactly: 11.2 m of water, the deepest a
       *               diver reaches with four seconds still in hand.
       *   yMax 0.0    is 6.0 m of water, and it is what keeps the tallest
       *               stipe (5.4 m) under the surface. Kelp poking out of the
       *               sea would be the CAD version of a forest.
       *   slope 26    keeps it off the drowned flanks, where it would be
       *               growing out of a wall.
       *
       * 200 at 5 m in a disc of r 140 places 200 - measured, 100%, against the
       * suite's 90% floor. The disc is bigger than the bed because only the
       * part of it inside the window is eligible; shrinking it to fit would
       * make the count depend on a boundary nobody can see.
       *
       * `collide: false`, and that is the one deliberate difference from every
       * other field on this planet. A kelp bed you cannot swim through is a
       * wall in the middle of the only water on the planet worth swimming in,
       * and `growth`'s collider is the TRUNK - a 10 cm stipe is not something
       * a body should be stopped by in three dimensions.
       */
      region: { shape: 'disc', x: SOUND.x, z: SOUND.z, r: SOUND.r, yMin: SEA - LUNG, yMax: 0.0, slopeMaxDeg: 26 },
      count: 200, spacing: 5,
      size: { trunk: [0.06, 0.15], h: [2.6, 5.4], canopy: [0.9, 2.4], droop: 0.9 },
      tint: [0x2f4a2c, 0x3d5a30, 0x24361f, 0x486234],
      trunkTint: [0x4a4a30, 0x3a3a26],
      collide: false,
    },
    {
      id: 'lagoon_coral',
      kind: 'spires',
      /**
       * BARROW LAGOON'S FLOOR - the one enclosed piece of water on the planet,
       * 4.7 to 6.0 m down, walked to down Barrow Spit and then swum into.
       *
       * The height ceiling is the whole record. The lagoon's floor sits at 0.0
       * and its inner wall climbs to 1.3 within the region, so a 3.4 m head on
       * the shallowest of them tops out at 4.7 - more than a metre under the
       * sea. A coral head breaking the surface here would not merely look
       * wrong, it would be a standable island in the middle of a basin the
       * reach probes have always modelled as drowned.
       *
       * ── THE PROPORTIONS ARE THE DIFFERENCE BETWEEN CORAL AND A MENHIR ────
       *
       * The first pass copied `coral_heads`' shape off the Glassflat -
       * `h [2.2, 7.5]` on a `base [0.45, 1.5]`, about 5:1 - and photographed
       * as a field of standing stones on a sea floor. That aspect is right for
       * something standing in AIR at the edge of a tidal flat, where it is a
       * silhouette; 4 m down in water whose fog is 26 m of dark blue there is
       * no silhouette, and all that is left is the mass. So this is 1.5:1:
       * squat, wide-footed bommies, with more lean so no two read as the same
       * cone.
       *
       * The SPACING is then set by the wider foot, exactly as the chimneys'
       * was: a 1.6 m maximum base gives about a 2.6 m collider footprint, so
       * 5 m of spacing leaves a 2.4 m lane and the floor stays something you
       * can swim down into rather than a reef maze. The count is what the
       * region holds at that spacing - measured, 40 places 39, and it
       * saturates around 40, which is why it asks for 40 and not the 56 that
       * fitted when the heads were spikes.
       *
       * `collide: true`, unlike the kelp: coral is rock, the collider is the
       * spire's foot, and nothing in the field is tall enough to reach the
       * waterline where the swim flood would see it.
       */
      region: { shape: 'disc', x: LAGOON.x, z: LAGOON.z, r: LAGOON.r, yMin: -0.6, yMax: 5.2, slopeMaxDeg: 34 },
      count: 40, spacing: 5,
      size: { h: [1.0, 3.4], base: [0.6, 1.6], lean: 0.24, facets: 6 },
      tint: [0xc98a6e, 0xd9a377, 0xb4705f, 0xe0c08f],
      collide: true,
    },
  ],

  /* ---------------------------------------------------------------- *
   * MINERALS - four elements, four places, one ladder.
   *
   *   rarity     element     terrain   place                 reached from
   *   ---------  ----------  --------  --------------------  ---------------
   *   common     brinesalt   shore     every tidal flat      any pad
   *   uncommon   nacre       shore     the wrackline         any pad
   *   rare       polymetal   shelf     the outer Glassflat   Glassflat, 120 m+
   *   exotic     abyssite    fissure   the Tide Chasm        SUNDER DECK ONLY
   *
   * The last row is the design in one line, and it is the shape Volcanic.js
   * proved: THE EXOTIC TIER IS A SECOND LANDING, NOT A LONGER WALK. Sundering
   * Head is 99.5 m of open water at its narrowest from the nearest ground a
   * body can stand on, and its shores measure 70.8 degrees at their shallowest
   * against a 56.63-degree envelope, so abyssite is not "far" from Glassflat
   * Deck - it is unreachable at any distance, and the probe measures that
   * rather than asserting it. It went 0 of 7 to 7 of 7 for one build when the
   * sea became swimmable and those two numbers were 91 and 44; see the
   * landform, which is where the fix is.
   *
   * `size` is the node radius AND the hold volume (`max(1, round(size*1.6))`),
   * so the cheap ore is the bulky ore: three cubic metres of brine salt for 30
   * credits against one of abyssite for 340. In a 10 m3 Kestrel that is the
   * entire cargo decision, and a planet whose nodes are all one size has
   * thrown it away.
   *
   * `credits` is absent from every row on purpose - `definePlanet` computes it
   * from `unitValue * hold` and REFUSES a hand-written one.                  */
  minerals: [
    {
      id: 'brinesalt', item: 'brinesalt', name: 'Brine Salt',
      rarity: 'common', terrain: 'shore', place: 'the tidal flats',
      /* A dull grey-white crust, and low contrast against the shell sand ON
       * PURPOSE. Cinder's lesson run the other way: there, the cheapest ore
       * was authored as a cream boulder brighter than anything else on the
       * plain, so the least valuable thing was the most conspicuous object in
       * the frame. Salt on a salt flat should take a moment to see. */
      color: 0xc2cfcb, glow: 0,
      unitValue: ORE('brinesalt'), spread: 0.25,
      /* 1.72 m. `holdUnitsFor` rounds, so anything under 1.5625 drops to two
       * cubic metres and the bulk-versus-value decision goes with it. The
       * biggest node on the planet and the least valuable, which is what
       * "bulk" has to mean if hold space is a decision. */
      size: 1.72, count: 40, spacing: 15,
      /* A `field`, bracketed to the flats and the back-beach. Allowed for a
       * common tier and correct for this one: brine salt is an evaporite and
       * every tidal flat on the planet grows it. The 14-degree ceiling is what
       * keeps it off Sundering Head - the Head's shore passes through this
       * height window inside a 70-degree cliff, and without the ceiling forty
       * nodes would scatter partly onto ground no pad can reach. */
      region: { shape: 'field', yMin: 6.9, yMax: 9.8, slopeMaxDeg: 14, clearOfPads: 7 },
    },
    {
      id: 'nacre', item: 'nacre', name: 'Nacre Plate',
      rarity: 'uncommon', terrain: 'shore', place: 'The Wrackline',
      /* Iridescent, and the glow is the cheapest way to say so: the material
       * has no view-dependent channel, so a faint violet emissive is what
       * makes a shell plate read as shell rather than as pale rock. */
      color: 0xdcd2ea, glow: 0x2a1c44,
      unitValue: ORE('nacre'), spread: 0.25,
      size: 1.15, count: 20, spacing: 14,
      /**
       * THE STRAND LINE ITSELF - a band roughly 7 m wide following about 3 km
       * of shore round every bench and both spits, and nothing else.
       *
       * The window is 0.47 m tall and that is not a guess: the benches stand
       * at 7.25 and the sea at 6.0, so 6.75..7.22 is the last half metre of
       * beach before the flat, which is where wrack piles up. On the benches'
       * own edge blends that resolves to a ring 6-7 m wide; on Sundering
       * Head's cliffs the same window is 40 cm wide and 60 degrees steep, and
       * the slope ceiling drops it - which is the point, because a nacre plate
       * on that island would be uncommon ore behind glass.
       */
      region: { shape: 'field', yMin: 6.75, yMax: 7.22, slopeMaxDeg: 20, clearOfPads: 9 },
    },
    {
      id: 'polymetal', item: 'polymetal', name: 'Polymetallic Nodule',
      rarity: 'rare', terrain: 'shelf', place: 'the outer Glassflat',
      /* Near-black, against the lightest ground on the planet. The rare thing
       * is the one that stands out here, which is the inverse of the brine
       * salt above and deliberate: at ten metres a player has to be able to
       * tell a 200 cr nodule from a 10 cr lump of salt lying next to it. */
      color: 0x2a2620, glow: 0,
      unitValue: ORE('polymetal'), spread: 0.25,
      size: 0.86, count: 12, spacing: 18,
      /**
       * AN ANNULUS CENTRED ON THE PRIMARY PAD, NOT ON THE BENCH.
       *
       * `r0: 118` is the whole record. The brief puts polymetal on the shelf
       * and the primary landing is also on the shelf, so written as a disc
       * this would be the rare tier lying underfoot at the ship - "a common
       * element with an expensive name", which is the thing `definePlanet`
       * refuses for the rarest tier and which nothing refuses for the tier
       * below it. Anchoring the region to the PAD instead of the bench makes
       * the 118 m a guarantee rather than a hope: every nodule on the planet
       * is at least that far from where the ship stands, out on the far
       * crescent of the flat, over the wrack bar and along Barrow Spit.
       *
       * The 12-degree ceiling is set by the Glassflat's own 0.55 m sand waves
       * (3.8 degrees) plus the wrack bar (6.3): at 8 the crests were rejected
       * and twelve nodules queued up in the troughs.
       */
      region: { shape: 'annulus', x: 168, z: 86, r0: 118, r1: 235, yMin: 6.9, yMax: 9.4, slopeMaxDeg: 12, clearOfPads: 12 },
    },
    {
      id: 'abyssite', item: 'abyssite', name: 'Abyssite',
      rarity: 'exotic', terrain: 'fissure', place: 'The Tide Chasm',
      /* The one cold luminous thing on the planet, at the bottom of the one
       * dark place on it. `glow` is what makes the chasm worth looking down
       * into from the Head's rim before you have found the stair. */
      color: 0x2f7f96, glow: 0x1ad0e8,
      unitValue: ORE('abyssite'), spread: 0.25,
      /* The smallest node here and the dearest: one cubic metre, 340 credits.
       * A stock Kestrel's 10 m3 carries all seven, which is the trip this ore
       * exists to make worth flying. */
      size: 0.62, count: 7, spacing: 11,
      /**
       * THE FLOOR OF THE CHASM AND THE FIRST METRE OF ITS WALLS.
       *
       * `trench` is a cubed profile - depth * (1 - t^3) with t = d/width - so
       * the wall passes 38 degrees by t = 0.34 and 68 degrees by t = 0.5. The
       * 22-degree ceiling therefore resolves to a strip 5.3 m wide about the
       * centreline, which is exactly the floor. Cinder's sulfur had the
       * opposite version of this problem - a corridor that INCLUDED the floor
       * of a 13 m trench with vertical walls, with a seam down there nothing
       * could walk to - and the fix there was `widthInner` to address the lips
       * instead. Here the floor is the reachable part, because the Sunder
       * Stair was built to it, and the lips are the 68-degree part.
       *
       * `yMin: 8.5` is the sea guard. There is no `clearOfLiquid` on this
       * planet (see the header) and the chasm floor's 10.0 is the smallest
       * freeboard anywhere ore is placed, so this is the row where the guard
       * actually has work to do.
       */
      region: { shape: 'corridor', pts: CHASM, width: 6.5, yMin: 8.5, slopeMaxDeg: 22, clearOfPads: 4 },
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
   * A world that is mostly sea gets its viewpoints on the three things that
   * stand out of it. 9.6 m/s2 - the second heaviest body a player can walk on -
   * so a 4.8 m sprint jump crosses nothing here either; all three are walked. */
  viewpoints: [
    {
      /* The cone above Kelphold: 75.2 m, the highest standable point on the
       * planet, and the only place the whole shelf is in one frame. */
      id: 'kelphold_peak', name: 'Kelphold Peak', x: -248, z: -176, r: 8,
      terrain: 'highland', place: 'the Kelphold cone',
      climb: 'North-west off Kelphold and up the south flank.',
    },
    {
      /* The south-west brow of the Sunder shelf, 52.2 m, with 39.5 m of
       * prominence - the biggest drop on Shoal - and The Tide Chasm cut into
       * the shelf behind it. */
      id: 'sunder_brow', name: 'Sunder Brow', x: 330, z: -380, r: 8,
      terrain: 'shelf', place: 'the Sunder shelf over The Tide Chasm',
      climb: 'South along the shelf from Sunder Deck to where it ends.',
    },
    {
      /* The west rim of the lagoon basin out on the Wrackline - only 21 m up,
       * but it is the rim of a 21 m hole in a flat, and the tide runs in and
       * out of it. */
      id: 'lagoon_rim', name: 'Lagoon Rim', x: 250, z: 270, r: 8,
      terrain: 'shelf', place: 'the lagoon on The Wrackline',
      climb: 'East from Glassflat Deck along the strand.',
    },
  ],

  landing: [
    /**
     * GLASSFLAT DECK - the primary, and therefore where the player arrives on
     * foot when the world is entered directly. Out on the open bench with
     * 30 m of dead-level plateau under it, `yaw` 0.99 so arrival faces
     * west-north-west down the length of the shelf with Coral Crown 490 m away
     * on the skyline and the sun over the right shoulder.
     */
    { id: 'glassflat', name: 'Glassflat Deck', x: 168, z: 86, r: 30, primary: true, yaw: 0.99 },
    /**
     * KELPHOLD - on Meridian, under the Crown's flank at y 23. Not required by
     * anything: it exists so that a player who wants the island does not have
     * to walk the Thread, and so the scrub and the doline are a destination.
     */
    { id: 'kelphold', name: 'Kelphold', x: -206, z: -72, r: 22, yaw: 0.38 },
    /**
     * SUNDER DECK - the second landing, and the only way to the exotic tier.
     * Facing 0.42, which points down the Sunder Stair rather than out to sea:
     * the first thing a player sees on arrival should be the road, because the
     * road is the reason the pad is here.
     */
    { id: 'sunder', name: 'Sunder Deck', x: 372, z: -252, r: 20, yaw: 0.42 },
  ],


  /* No `hazards`. `PlanetWorld` reads `ashfall.density` and `steamColor` out
   * of that block and nothing else, and Shoal has neither ash nor vents;
   * `heatShimmer` is authored on Cinder and consumed nowhere in the build, so
   * copying it here would be copying dead data. */
});

export default SHOAL;
