/**
 * THE BODY LAYOUT, and the interface the planet system consumes.
 *
 * ===========================================================================
 *  WHAT THIS FILE IS FOR
 * ===========================================================================
 *
 * Two jobs, and they are the same job seen from two sides.
 *
 * 1. It is the SKY. Where every body sits, how big it is, what colour it is.
 *    `SpaceWorld` reads this and builds meshes from it.
 *
 * 2. It is the CONTRACT with the planet system. A descent needs to know where
 *    a body is, how big it is, where its air starts and at what radius space
 *    stops being in charge. Those four numbers are `position`, `radius`,
 *    `atmosphere` and `handoff`, and they live here so there is exactly one
 *    copy of them. `approachState()` below is the whole of the interface: a
 *    caller passes a ship position and gets back which body it is falling
 *    towards and how far into the fall it is.
 *
 * WHAT IS DELIBERATELY *NOT* HERE, and this is the important part.
 *
 * Planet surfaces are ONE parameterised world, not a world per planet, and the
 * parameters live in `src/worlds/planets/PlanetDescriptor.js` - terrain,
 * palette, gravity, sky, liquid, props, minerals, landing pads. None of that
 * is repeated here. A body in this file carries only the four numbers that are
 * facts about the SKY rather than about the ground:
 *
 *       position   radius   atmosphere   handoff
 *
 * plus `surfaceWorld`, which is a world id and nothing more. The temptation
 * was to copy gravity and the mineral list up here so a nav readout could show
 * them without loading the planet; that is how you get two mineral tables that
 * disagree, and the readout can ask the descriptor.
 *
 * Nothing here imports three. The descriptors are plain data so they can cross
 * a `postMessage` boundary intact, which is the constraint
 * terrain/index.js and PlanetDescriptor.js are both written under. Positions
 * are `[x,y,z]` arrays, not Vector3, for the same reason.
 *
 * ===========================================================================
 *  THE FRAME
 * ===========================================================================
 *
 *   Origin      the mouth of Lodestar Yard's hangar. The dock is at 0,0,0 and
 *               the player arrives there.
 *   -Z          OUTBOUND. The direction the hangar mouth faces and the piers
 *               point. A player who launches and holds course goes -Z.
 *   +Y          up, as everywhere else in the game.
 *   +X          right, when standing at the mouth looking out.
 *
 * ===========================================================================
 *  THE LAYOUT, AND WHY EACH ONE IS WHERE IT IS
 * ===========================================================================
 *
 * The player asked for direction variety in as many words: "some of the
 * planets i would fly out and down to reach, others to the right or left or
 * straight ahead or out and up". So the layout is built from the DIRECTIONS
 * first and the distances second, and every one of those five directions is
 * spoken for:
 *
 *   OUT AND DOWN     Cinder          the volcanic planet. LANDABLE.
 *   STRAIGHT AHEAD   Vitrine         an ice world
 *   OUT AND UP       Ceraunus        the ringed gas giant
 *   RIGHT            Tessera         a small cratered moonlet
 *   LEFT             Halberd Reach   the asteroid belt (see Belt.js)
 *   BEHIND AND UP    Erenmark        the star, over the dock's shoulder
 *
 * Phase 2 added seven more and made Vitrine and Tessera landable; the full
 * twelve-body table, and the constraint solve that placed them, are in the
 * "PHASE 2 - the rest of the system" block further down.
 *
 * Erenmark being BEHIND is deliberate and does two things at once. It means
 * everything the player flies towards is front-lit rather than a silhouette,
 * and it means that when they are lost, the way home and the brightest thing
 * in the sky are roughly the same bearing. That is navigation for free.
 *
 * -- Distances: how they were chosen ----------------------------------------
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THIS SECTION WAS WRONG FOR A WHOLE PHASE. READ THE CORRECTION.           │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * It used to say the layout was pinned to an assumed envelope of
 * "cruise 260 m/s, boost 1600 m/s", and to come back and re-derive it when the
 * flight model landed. The flight model landed and nobody came back.
 *
 * What actually shipped (`src/ships/Flight.js`):
 *
 *     cruise  `thrust / drag` = 78 / 0.65   =  120 m/s * powerMul
 *     cap     `FLIGHT.hardCap`              =  260 m/s * powerMul, boost only
 *     boost   `boostEnergy / boostDrain`    =  3.33 SECONDS of it
 *
 * So the claim above that "Cinder at 62 km is 39 s at boost, 4 min at cruise"
 * was out by an order of magnitude: at a sustained 120 m/s it is **517 seconds
 * - eight and a half minutes of holding one key in a straight line**, and that
 * was true of the only landable body in the game for the whole of Phase 1.
 *
 * The distances are NOT the thing that was wrong, and shrinking them is not the
 * fix - the radii and ranges below are what give the sky depth, and collapsing
 * them turns a solar system into a diorama. The ship was wrong. See the transit
 * drive in `Flight.js`, whose top speed is governed by altitude above the
 * nearest body, which makes the volume crossable AND decelerates a ship
 * automatically as it closes so it arrives at a sane speed.
 *
 * The lesson worth keeping: a layout pinned to an ASSUMED number needs a test
 * that fails when the assumption does. `ship-transit.test.mjs` now flies the
 * real integrator from the dock to Cinder's handoff and asserts the duration,
 * so this cannot rot silently a second time.
 *
 * -- Sizes: how they were chosen --------------------------------------------
 *
 * Measured with `Scale.screenFraction` at the game's 75 degree vertical FOV.
 * `screen` below is the fraction of screen HEIGHT the body fills from the
 * dock; the second number is from 20 km out.
 *
 *   body       dist km   radius m   screen @dock   screen @20km
 *   Cinder        62       9,000       0.22           0.71
 *   Vitrine      155      15,000       0.15           -
 *   Ceraunus     245      38,000       0.24 (0.55 incl. rings)
 *   Tessera       88       4,200       0.07           -
 *   Erenmark     640      15,500       0.04           -
 *
 * Every Phase 2 body clears the same 0.02 floor; the smallest is Cathedra at
 * 0.036 and Lathe was sized UP to 5.2 km to clear it. See that block below.
 *
 * 0.22 is a hand's breadth at arm's length: unmistakably a world, clearly not
 * reachable by reaching. 0.71 at 20 km is the moment the approach stops being
 * navigation and starts being a landing. At the handoff radius the disc is
 * 1.82 screen heights - it is the sky.
 *
 * Cinder is 9 km in radius, which is small for a planet and exactly right for
 * a game: 56 km around the equator, a couple of minutes of level flight. Any
 * bigger and "fly round to the other side" stops being something a player
 * does casually, and a world you cannot circle does not feel like a world,
 * it feels like a wall.
 */

/** Unit-length a direction given as a loose [x,y,z], and scale it to `dist`. */
function at(dir, dist) {
  const [x, y, z] = dir;
  const len = Math.hypot(x, y, z);
  if (!(len > 0)) throw new Error('[space/Bodies] direction must be non-zero');
  return [(x / len) * dist, (y / len) * dist, (z / len) * dist];
}

/**
 * @typedef {Object} SpaceBody
 * @property {string}   id
 * @property {string}   name           what the HUD and the lore call it
 * @property {'rock'|'ice'|'gas'|'moon'|'star'} kind  which shader builds it
 * @property {number[]} position       true metres, [x,y,z], dock at origin
 * @property {number}   radius         surface radius, metres
 * @property {number}   atmosphere     radius where air begins; equals `radius`
 *                                     when the body is airless
 * @property {number}   handoff        radius at which SpaceWorld stops being
 *                                     in charge and the surface world takes
 *                                     the ship. 0 when the body is not
 *                                     landable in this phase.
 * @property {string|null} surfaceWorld  world id to activate on handoff, in
 *                                     `planet:<id>` form. The descriptor for
 *                                     that id owns everything about the
 *                                     ground; this file owns nothing about it.
 * @property {number}   [hull]         PRESSURE HULL: metres from the centre a
 *                                     ship cannot pass. 0 or absent for a body
 *                                     whose `handoff` takes the ship first.
 *                                     See the block on THE PRESSURE HULL below.
 * @property {string}   [hullNote]     what the pilot is told when they reach it.
 * @property {number}   spin           radians/second about the body's axis
 * @property {number[]} axis           spin axis, unit-ish
 * @property {Object}   look           palette and shader parameters
 * @property {Object|null} ring        ring geometry, gas giants only
 * @property {string}   blurb          one line, for a nav-target readout
 */

/** Metres. Reused by the layout and by anything that wants to reason in km. */
const KM = 1000;

/**
 * ===========================================================================
 *  THE PRESSURE HULL - what stops you at a body you cannot land on
 * ===========================================================================
 *
 * A body with `handoff: 0` has nothing that takes the ship off `SpaceWorld`,
 * and until this field existed that meant it had nothing at all. Flown and
 * measured in a real boot: a Kestrel held nose-on to Ceraunus from 20 km
 * passed the cloud tops without a sound and reached **24 metres from the
 * centre of a 38 km body** with integrity 100, no collision, no seam and no
 * message. The readout said `Ceraunus · ALT 0 m · ATMOSPHERE` for four
 * minutes while the screen showed empty black and stars, because the camera
 * was inside the sphere looking at its back faces.
 *
 * That is the worst kind of nothing: the HUD says APPROACH, the objective line
 * says "fly in until the readout says APPROACH, then descend", and the largest
 * object in the sky turns out to be a hologram.
 *
 * So a body with no surface world publishes the radius its hull stops at. It
 * is a POSITION CLAMP rather than a raycast - every step that ends inside the
 * radius is put back on it and the inward half of the velocity is removed,
 * which cannot tunnel however large the step is, and which leaves the
 * tangential half alone so a ship skims the cloud deck instead of being nailed
 * to it. The altitude law in `Flight.transitSpeedLimit` has already brought
 * any drive down to a few hundred m/s by the time the hull is reached
 * (`altitude` there is measured from `radius`, and the hull sits just above
 * it), so there is no arrival speed this has to absorb that a hull would not.
 *
 * WHY NOT DAMAGE INSTEAD. It was the other option and it is worse for the same
 * reason the take-off crash loop was: a wall you can lean on teaches you where
 * the edge is in one second, and a damage field teaches you the same thing by
 * taking your run away. Ceraunus is scenery you are meant to go and look at.
 *
 * ── WHERE THE WALL GOES, AND IT WAS MEASURED WITH A CAMERA ────────────────
 *
 * The first attempt put Ceraunus's wall at 1.04 radii, hard against the cloud
 * deck, on the reasoning that a hull should stop where the planet is. Shot in
 * the built page on the approach a player actually flies - straight out from
 * the yard - that is a BLACK SCREEN. The yard-facing hemisphere is 129 degrees
 * from the sub-solar point, so the near side of the giant is night, and at
 * 1.04 radii it subtends 147 degrees against a 75 degree field: the plate is
 * entirely unlit cloud. Frame luminance by stand-off, same approach, same
 * camera, `mean` over the whole plate:
 *
 *      1.04 radii  ( 39.5 km)   mean  2.8    black
 *      1.35 radii  ( 51.3 km)   mean  5.7    black with a hint of ring
 *      1.70 radii  ( 64.6 km)   mean 20.8    the ring system sweeps the frame
 *      2.10 radii  ( 79.8 km)   mean 31.4    rings and the lit crescent
 *      3.20 radii  (121.6 km)   mean 24.0    the giant is receding again
 *
 * (`.probe/tk/cershots.mjs` takes that table; `.probe/tk/lanes.mjs` derives
 * the lane separations `SpaceWorld._fillEncounters` cites.)
 *
 * `.probe/shoot-planets.mjs` calls anything under mean 12 "not an image at
 * all", and it is right: stopping the player against an invisible black wall
 * is the same defect as letting them fly through an invisible black nothing,
 * with a message on it. The wall goes where the player can SEE what stopped
 * them, which is 1.70 radii - far enough out that the ring system is across
 * the whole plate and the lit limb is above it, close enough that the giant
 * still dominates rather than receding into scenery.
 *
 *   Ceraunus  64,600 m = 1.70 radii. Inside the ring system (1.42 to 2.28
 *             radii), which is the thing the pilot can see holding them off,
 *             and 26.6 km clear of the cloud deck.
 *   Erenmark  43,400 m = 2.80 radii, INSIDE the drawn corona (`coronaScale`
 *             is 3.4 radii), so again the thing that stops you is the thing
 *             filling the screen rather than an invisible sphere in front of
 *             it.
 *
 * ── AND EVERY WALL IS BOUNDED FROM ABOVE, WHICH THE FIRST DRAFT WAS NOT ───
 *
 * `SpaceObjectives.surveyRange` fires a survey when a body fills half the
 * screen height, which for a 15.5 km star is 48,220 m from its centre. A wall
 * outside that radius makes the body impossible to survey - built, not
 * reachable, this project's signature defect - and `space-objectives.test.mjs`
 * caught a 52,700 m first attempt at Erenmark's on the spot. Every hull must
 * sit INSIDE its own body's survey sphere; 43,400 leaves 4.8 km of margin and
 * Ceraunus's 64,600 sits inside a 118,214 m sphere.
 */
const CERAUNUS_HULL = 64600;
const ERENMARK_HULL = 43400;

/**
 * ERENMARK - the primary.
 *
 * 15.5 km radius at 640 km is 2.78 degrees across: about five times the
 * angular size of Earth's sun, which is what a close orange dwarf looks like
 * and what makes the light hard and the shadows black. Its direction is also
 * `environment.sunDirection`, and the two must not be edited apart - the whole
 * point of drawing a star is that the terminator on every planet agrees with
 * it. `SpaceWorld` derives the light direction FROM this entry so they cannot.
 */
const ERENMARK = {
  id: 'erenmark',
  name: 'Erenmark',
  kind: 'star',
  position: at([0.58, 0.47, 0.67], 640 * KM),
  radius: 15500,
  atmosphere: 15500,
  handoff: 0,
  surfaceWorld: null,
  /* "Do not approach" was a blurb; this is the sentence being true. */
  hull: ERENMARK_HULL,
  hullNote: 'The corona of Erenmark. The hull comes no closer.',
  spin: 0.0,
  axis: [0, 1, 0],
  look: {
    core: 0xfff2d8,
    edge: 0xff9c3a,
    corona: 0xff7a1e,
    /** Granulation cell size, in units of the body radius. */
    grain: 5.5,
    coronaScale: 3.4,
  },
  ring: null,
  blurb: 'Primary. Orange dwarf. Do not approach.',
};

/**
 * CINDER - the volcanic planet, and the only landable body in Phase 1.
 *
 * Out and DOWN, because that is the first direction the player named and
 * because a descent that starts by pitching down reads as a descent. Slightly
 * to port as well, so that holding a dead-straight -Z course out of the
 * hangar does NOT arrive: the player has to aim at it, which is the smallest
 * possible amount of navigation and worth having.
 *
 * The atmosphere is 1,600 m deep and the handoff is 900 m above the surface,
 * so the ship flies 700 m of visible air BEFORE the planet world takes it.
 * Those two numbers must not be equal, and the first version of this file had
 * them equal - `atmosphere` and `handoff` both 9,700. The consequence is not a
 * crash: `approachState` simply never returns `phase: 'atmosphere'`, because
 * the handoff test fires on the same frame the air does. An entire phase of
 * the descent existed in the enum, was handled by callers, and could not be
 * entered. That is the signature defect of this project - content that is
 * BUILT but cannot be REACHED - and it was caught by a test that walks a
 * descent through every phase in order rather than by one that checks the
 * fields are present.
 *
 * 700 m of air at a sane entry speed is a few seconds of glow and buffet,
 * which is a transition; 5 km would be a chore.
 */
const CINDER = {
  id: 'cinder',
  name: 'Cinder',
  kind: 'rock',
  position: at([-0.22, -0.40, -0.89], 62 * KM),
  radius: 9000,
  atmosphere: 10600,
  handoff: 9900,
  surfaceWorld: 'planet:cinder',
  spin: 0.0009,
  axis: [0.08, 1, 0.14],
  look: {
    /* Basalt that is nearly black, with the fissure network doing all the
     * work. Emissive fissures are why this planet is recognisable at 62 km:
     * the NIGHT side is not black, it is veined with orange, and that is the
     * single detail that says "volcanic" from a distance no texture could. */
    base: 0x241a18,
    high: 0x4a3a34,
    low: 0x120b0a,
    fissure: 0xff5a14,
    fissureHot: 0xffd07a,
    /** Fraction of the surface the fissure network covers. Measured by eye. */
    fissureCover: 0.19,
    atmosphere: 0xd6552a,
    atmoStrength: 0.85,
    /** Drawn radius of the halo shell, in body radii. NOT the same thing as
     *  `atmosphere`, which is a gameplay radius - see SpaceWorld._buildBodies. */
    haloScale: 1.05,
    detail: 2.6,
  },
  ring: null,
  blurb: 'Volcanic. Landable. Obsidian, sulphur, ferrite.',
};

/**
 * VITRINE - an ice world, straight ahead.
 *
 * Straight ahead so that the very first thing a player sees on leaving the
 * hangar is a destination, before they have turned at all. Far enough (155 km)
 * that it is plainly further than Cinder, which is how the sky teaches depth:
 * two discs of similar size at obviously different distances.
 *
 * LANDABLE AS OF PHASE 2, and the boundary is what made it cheap: making it
 * landable was writing a descriptor in planets/ and setting `handoff` and
 * `surfaceWorld`. Nothing else in this file changed shape, and no renderer,
 * height function or world class was added. That is exactly the claim the
 * Phase 1 docblock made about this exact body, now collected.
 */
const VITRINE = {
  id: 'vitrine',
  name: 'Vitrine',
  kind: 'ice',
  position: at([0.16, 0.10, -0.98], 155 * KM),
  radius: 15000,
  /* 1,800 m of air, and the handoff 1,000 m up.
   *
   * The Phase 1 numbers were 900 m of air and no handoff at all, because
   * Vitrine was scenery. Landing it needed the air DEEPENED rather than the
   * handoff lowered: `space-scale.test.mjs` holds every landable body to at
   * least 300 m of air flown in space AND to no more than half its air being
   * flown there, and 900 m of air cannot satisfy both. */
  atmosphere: 16800,
  handoff: 16000,
  surfaceWorld: 'planet:vitrine',
  spin: 0.0004,
  axis: [-0.22, 1, 0.05],
  look: {
    base: 0xcfe2ee,
    high: 0xffffff,
    low: 0x6d93ad,
    fissure: 0x2f6f96,
    fissureHot: 0x2f6f96,
    fissureCover: 0.30,
    atmosphere: 0x9fd0f2,
    /* 0.9 and not 1.1. The halo shader peaks at strength * 1.4 where the limb
     * faces the star, and at 1.1 that is 1.54 linear - which, added to the sky
     * behind it, crosses the space grade's 1.60 bloom threshold. Backlit, the
     * rim stopped reading as an atmosphere and started reading as a lens
     * flare parked next to the planet. At 0.9 the peak is 1.26 and the rim
     * stays a rim. Cinder's 0.85 is under for the same reason. */
    atmoStrength: 0.9,
    haloScale: 1.04,
    detail: 1.7,
  },
  ring: null,
  blurb: 'Ice. Crevasse fields and a subglacial vault. Landable.',
};

/**
 * CERAUNUS - the ringed gas giant, out and up.
 *
 * The largest thing in the sky that is not the star, and the reason the sky
 * has an up. 38 km radius at 245 km puts the globe at 0.24 screen heights and
 * the ring system at 0.55, which means it reads at a glance from anywhere in
 * the volume and gives a player who is lost an unambiguous bearing.
 *
 * Ring radii are quoted as multiples of the body radius because that is how
 * ring systems are actually shaped and it keeps the proportion right if the
 * body is ever resized. 1.42 to 2.28 with a division at 1.94 - a Cassini gap,
 * because an unbroken annulus reads as a hoop and a divided one reads as
 * rings.
 */
const CERAUNUS = {
  id: 'ceraunus',
  name: 'Ceraunus',
  kind: 'gas',
  position: at([-0.30, 0.62, -0.72], 245 * KM),
  radius: 38000,
  atmosphere: 38000,
  handoff: 0,
  surfaceWorld: null,
  /* No ground, and now something that says so. See THE PRESSURE HULL above. */
  hull: CERAUNUS_HULL,
  hullNote: 'Ceraunus has no surface - and the ring system is as close as a hull comes.',
  spin: 0.0022,
  axis: [0.12, 1, -0.19],
  look: {
    base: 0xc8a276,
    high: 0xf0dcc0,
    low: 0x7a5638,
    fissure: 0xe8d0a8,
    fissureHot: 0xffffff,
    fissureCover: 0.0,
    /** Number of latitudinal bands across the visible hemisphere. */
    bands: 11,
    /** How far the bands are dragged sideways by turbulence, in radians. */
    churn: 0.34,
    storm: 0xa8542c,
    atmosphere: 0xe6c79a,
    atmoStrength: 0.9,
    detail: 3.1,
  },
  ring: {
    inner: 1.42,
    outer: 2.28,
    gap: [1.90, 1.98],
    tint: 0xd8c4a2,
    /** Opacity at normal incidence. Rings are mostly gap. */
    density: 0.62,
  },
  blurb: 'Gas giant. Ring system. No surface - but Lathe rides its outer edge.',
};

/**
 * TESSERA - a cratered moonlet, off to starboard.
 *
 * The small one. Every other body is big; without something that stays a chip
 * of grey at 5.5 degrees no matter how long you look at it, the sky has no
 * bottom to its size range and the big ones stop reading as big.
 *
 * Landable as of Phase 2, and the FIRST AIRLESS one - see the note on its
 * `atmosphere` field. Vacuum is the whole point of going: no fog, no haze, a
 * black sky at noon, shadows with nothing filling them at all, and a sixth of
 * a g. Every other world in the system is a place with weather.
 */
const TESSERA = {
  id: 'tessera',
  name: 'Tessera',
  kind: 'moon',
  position: at([0.94, -0.16, -0.30], 88 * KM),
  radius: 4200,
  /* AIRLESS AND LANDABLE, which is a category that did not exist in Phase 1.
   *
   * `atmosphere === radius`, so `approachState` can never return
   * `phase: 'atmosphere'` and the descent runs cruise -> approach -> handoff
   * with `atmoDepth` flat at 0 the whole way. That is CORRECT for a body with
   * no air, and it is a different thing from the defect Cinder shipped with,
   * where a body that HAD air could not be flown through any of it.
   *
   * `space-scale.test.mjs` used to require air of every landable body. It now
   * splits the two cases and asserts each: a body that claims air must let you
   * fly at least 300 m of it, and a body that claims none must skip the phase
   * cleanly rather than report a negative depth. */
  atmosphere: 4200,
  handoff: 4900,
  surfaceWorld: 'planet:tessera',
  spin: 0.00035,
  axis: [0.4, 0.9, 0.1],
  look: {
    base: 0x6e6e74,
    high: 0x9a9aa2,
    low: 0x3a3a40,
    fissure: 0x2c2c32,
    fissureHot: 0x2c2c32,
    fissureCover: 0.42,
    atmosphere: 0x000000,
    atmoStrength: 0.0,
    detail: 4.2,
  },
  ring: null,
  blurb: 'Airless moonlet. Sixth of a g. Platinum-group and helion. Landable.',
};

/* ==================================================================== *
 * PHASE 2 - the rest of the system                                     *
 * ====================================================================
 *
 * Seven new bodies, and Vitrine and Tessera promoted from scenery to
 * destinations above. Ten landable worlds in total.
 *
 * -- The four constraints every one of these satisfies at once ---------
 *
 * 1. A DISC, NOT A STAR. `screenFraction(radius, dist, 75deg) >= 0.02` from
 *    the dock - 21 pixels at 1080p, unambiguously a shape with an edge. This
 *    is what sets the minimum radius at each distance, and it is why Lathe is
 *    5.2 km rather than the 2.6 km a shepherd moon would really be: at 185 km
 *    a 2.6 km moon subtends nine pixels, which is a star.
 *
 * 2. SURFACES KILOMETRES APART. `sep > 2 * (rA + rB)` for every pair, because
 *    the painter ordering the far-limb cap forces (`depthTest: false`, see
 *    Scale.js) is exact only while no two bodies interpenetrate. Lathe against
 *    Ceraunus is the tight pair by design and clears it by 21.9 km.
 *
 * 3. FRONT-LIT. `dot(bearing, STAR_DIRECTION) < 0.35`, so nothing the player
 *    flies toward is a silhouette. Verdigris at +0.03 is nearest the limit and
 *    is deliberately the one near-half-phase body in the sky - a sky of full
 *    discs and nothing else is a sticker album.
 *
 * 4. AIR YOU CAN FLY, OR NONE AT ALL. For a body that claims air:
 *    `atmosphere - handoff >= 300` (a transition rather than a cut) and
 *    `<= (atmosphere - radius) * 0.5` (the planet gets most of its own sky).
 *    Tessera and Lathe claim none and skip the phase - see Tessera.
 *
 * -- Direction, and why the layout is built from bearings first --------
 *
 * The player asked for direction variety in as many words. Phase 1 spent five
 * bearings; Phase 2 fills the gaps between them so no two destinations share a
 * heading and a player told "down and to port" cannot arrive at the wrong
 * planet:
 *
 *     out & down       Cinder      62 km    volcanic
 *     right            Tessera     88 km    airless moonlet
 *     down & right     Sirocco    118 km    desert
 *     down & left      Shoal      142 km    ocean
 *     straight ahead   Vitrine    155 km    ice
 *     up & right       Verdigris  176 km    biotic
 *     far up           Lathe      185 km    ring shepherd (Ceraunus's moon)
 *     starboard, low   Carnelian  205 km    red iron
 *     straight down    Sallow     232 km    toxic
 *     out & up         Ceraunus   245 km    gas giant, no surface
 *     ahead & to port  Cathedra   288 km    crystal
 *     behind & up      Erenmark   640 km    the star
 *
 * -- These bearings were SOLVED, not chosen, and here is the constraint --
 *
 * `harness-framings.test.mjs` holds every pair of bodies more than 25 degrees
 * apart in the sky, on the grounds that two framings closer than that show the
 * same thing - and, more to the point, that a player told "down and to port"
 * cannot then arrive at the wrong planet.
 *
 * The first Phase 2 draft failed it three times over: Vitrine/Cathedra at 15.4
 * degrees, Tessera/Carnelian at 16.6, Cinder/Shoal at 23.8. That is not a test
 * being fussy. Ten landable bodies in the forward hemisphere is close to the
 * packing limit - 2*pi steradians over ten bodies is about 26 degrees a body -
 * so the bearings have to be solved rather than picked, and they were: a search
 * over the free six, holding Cinder, Vitrine, Ceraunus, Tessera and the star at
 * their Phase 1 bearings, subject to
 *
 *     separation >= 25 deg     dot(bearing, STAR_DIRECTION) < 0.35
 *     forward component >= 0.30 (so the hangar mouth has sky worth looking at)
 *
 * The achieved minimum is 27.7 degrees (Vitrine/Verdigris and Cinder/Shoal).
 *
 * CARNELIAN IS WHY THE TABLE SAYS "starboard, low" RATHER THAN "hard right".
 * The obvious hard-right bearing is 25 degrees from Tessera, and every bearing
 * that fixes THAT tips the body up toward Erenmark and back-lights it: at
 * [0.883, 0.321, -0.342] its star dot was 0.433 and it read as a silhouette.
 * The two constraints have no common solution at "hard right", so the identity
 * moved rather than the rule. A planet you cannot see is worse than a planet
 * that needs two words to describe.
 *
 * THE ONE PAIR UNDER 25 DEGREES IS CERAUNUS AND LATHE, at 24.4, and that is
 * what a MOON IS. Lathe declares `orbits: 'ceraunus'` and the test exempts a
 * satellite from its primary, because the framing that shows both of them
 * together is the framing you want - it is the whole point of going.
 *
 * -- And the distances are now crossable, which they were not ----------
 *
 * This layout was pinned to an ASSUMED "cruise 260 m/s, boost 1600 m/s". The
 * shipped flight model cruises at 120 m/s (`thrust / drag` = 78 / 0.65) and
 * caps at 260, with 3.33 seconds of boost - so Cinder at 62 km was an EIGHT AND
 * A HALF MINUTE flight and Cathedra at 288 km would have been forty. The
 * distances were never the thing that was wrong; the ship was. See the transit
 * drive in `src/ships/Flight.js`, whose speed is governed by altitude above
 * the nearest body, so closing on a planet decelerates you automatically.
 */

/**
 * SIROCCO - the desert world, down and to starboard.
 *
 * Dune seas, salt pans and one slot canyon. The first body in the system with
 * deep air (2.2 km), which is what a dust world needs: the descent is long, the
 * air is opaque and orange most of the way down, and the ground arrives late.
 * Cinder's descent is 700 m of glow; this one is 1,000 m of nothing followed by
 * a horizon.
 */
const SIROCCO = {
  id: 'sirocco',
  name: 'Sirocco',
  kind: 'rock',
  position: at([0.470, -0.671, -0.574], 118 * KM),
  radius: 11000,
  atmosphere: 13200,
  handoff: 12200,
  surfaceWorld: 'planet:sirocco',
  spin: 0.0011,
  axis: [0.21, 1, 0.06],
  look: {
    base: 0xc79a5e,
    high: 0xe8cd9a,
    low: 0x8a6234,
    /* Almost no vein network. What makes Sirocco recognisable at range is the
     * DUST BAND instead: a wide, bright, low-contrast limb no other body has. */
    fissure: 0xb08a52,
    fissureHot: 0xb08a52,
    fissureCover: 0.06,
    atmosphere: 0xe0a860,
    /* 0.95 is the fattest halo in the system and still under the 1.1 that put
     * Vitrine's rim over the space grade's 1.60 bloom threshold. A dust planet
     * SHOULD have the fattest halo; it just may not flare. */
    atmoStrength: 0.95,
    haloScale: 1.09,
    detail: 2.1,
  },
  ring: null,
  blurb: 'Desert. Dune seas, salt pans, a slot canyon. Landable.',
};

/**
 * SHOAL - the ocean world, down and to port.
 *
 * The only body that is mostly liquid, and the only one whose albedo swings
 * hard within a hemisphere - which is what makes it read as water rather than
 * as a blue rock. `fissureCover` 0.55 with a bright `fissure` colour is the
 * vein channel doing archipelago-and-shallows duty.
 */
const SHOAL = {
  id: 'shoal',
  name: 'Shoal',
  kind: 'rock',
  position: at([-0.628, -0.439, -0.643], 142 * KM),
  radius: 12500,
  atmosphere: 14900,
  handoff: 13900,
  surfaceWorld: 'planet:shoal',
  spin: 0.0013,
  axis: [-0.16, 1, 0.22],
  look: {
    base: 0x1c5a86,
    high: 0x6fd0d8,
    low: 0x0b2e4a,
    fissure: 0xdcecf2,
    fissureHot: 0xffffff,
    fissureCover: 0.55,
    atmosphere: 0x8fd6f0,
    atmoStrength: 0.88,
    haloScale: 1.06,
    detail: 1.9,
  },
  ring: null,
  blurb: 'Ocean. Island chains over a shallow shelf, and one tidal chasm. Landable.',
};

/**
 * VERDIGRIS - the biotic world, up and to starboard.
 *
 * The one near-half-phase body in the sky. Its bearing dots the star direction
 * at +0.03: inside the 0.35 front-lighting limit with room, but far enough
 * round that the terminator crosses the visible disc. So from the dock
 * Verdigris is a lit crescent against a dark limb while everything else is a
 * full disc, and it is the body that stops the sky being a sticker album.
 */
const VERDIGRIS = {
  id: 'verdigris',
  name: 'Verdigris',
  kind: 'rock',
  position: at([0.310, 0.516, -0.799], 176 * KM),
  radius: 10200,
  atmosphere: 12800,
  handoff: 11600,
  surfaceWorld: 'planet:verdigris',
  spin: 0.0008,
  axis: [0.05, 1, -0.28],
  look: {
    base: 0x2f6b46,
    high: 0x86c47a,
    low: 0x14331f,
    fissure: 0x8fd8b0,
    fissureHot: 0xd8f4e0,
    /* The rivers. 0.24 is enough that the drainage network reads from orbit as
     * a pale tracery and not so much that the planet reads as cracked - which
     * is what the same channel does on Cinder at 0.19 with a hot colour instead
     * of a cold one. Same shader, opposite reading. */
    fissureCover: 0.24,
    atmosphere: 0xa8e0b8,
    atmoStrength: 0.9,
    haloScale: 1.07,
    detail: 2.4,
  },
  ring: null,
  blurb: 'Biotic. Canopy mesas over river gorges. Landable.',
};

/**
 * LATHE - Ceraunus's shepherd moon, and the answer to a dead end.
 *
 * Ceraunus is the biggest thing in the sky and it has no surface, so a player
 * who flew the two hundred and forty-five kilometres out to it in Phase 1
 * arrived at a wall. Lathe is what is actually out there: a small moon riding
 * just outside the outer ring edge, carrying the richest ore in the system.
 *
 * -- The orbit, and the three numbers that set it ----------------------
 *
 * Placed at 2.85 body radii from Ceraunus - 108,300 m - along the vector that
 * is (a) in the RING PLANE, i.e. perpendicular to Ceraunus's spin axis, and
 * (b) projected back toward the dock, so the moon is on the near side and the
 * trip is 185 km rather than 353. The rings run 1.42 to 2.28 radii (54-87 km),
 * so 2.85 puts Lathe 21.7 km clear of the outer edge: outside the rings,
 * shepherding them, which is what a shepherd moon does.
 *
 * 2.85 rather than the 2.35 the first draft used, and the reason is the
 * separation rule rather than the astronomy. Surfaces must be more than
 * `2 * (rA + rB)` apart or the painter ordering the far-limb cap forces stops
 * being exact: 2.35 radii is 89.3 km against a required 86.4 km, under three
 * kilometres of margin. 2.85 clears it by 21.9 km.
 *
 * 5.2 km of radius rather than 2.6, and that is a legibility decision that
 * overrules the physics. At 185 km a 2.6 km moon subtends 0.010 of screen
 * height - nine pixels at 1080p, which is a star, and this system has a rule
 * that every body is a disc. 5.2 km reads at 0.037.
 *
 * AIRLESS, like Tessera, so the descent skips the atmosphere phase.
 *
 * The payoff is on the ground rather than in this file: the surface descriptor
 * hangs Ceraunus and its rings in Lathe's sky by way of the `space` sky's
 * `planetDirection` and `planetAngularRadius` params. That view is what the
 * whole trip is for.
 *
 * The position is COMPUTED from Ceraunus rather than typed, so the day the gas
 * giant moves its moon goes with it. A hand-copied position is two copies of
 * one fact and the second one goes stale.
 */
const LATHE = (() => {
  const c = CERAUNUS.position;
  /* The ring plane is perpendicular to the spin axis. */
  const ax = CERAUNUS.axis;
  const al = Math.hypot(ax[0], ax[1], ax[2]);
  const a = [ax[0] / al, ax[1] / al, ax[2] / al];
  /* Back toward the dock at the origin, projected into that plane. */
  const cl = Math.hypot(c[0], c[1], c[2]);
  const home = [-c[0] / cl, -c[1] / cl, -c[2] / cl];
  const d = home[0] * a[0] + home[1] * a[1] + home[2] * a[2];
  const inPlane = [home[0] - d * a[0], home[1] - d * a[1], home[2] - d * a[2]];
  const pl = Math.hypot(inPlane[0], inPlane[1], inPlane[2]);
  if (!(pl > 1e-6)) throw new Error('[space/Bodies] Lathe: the way home is along the ring axis');
  const ORBIT = CERAUNUS.radius * 2.85;
  return {
    id: 'lathe',
    name: 'Lathe',
    kind: 'moon',
    position: [
      c[0] + (inPlane[0] / pl) * ORBIT,
      c[1] + (inPlane[1] / pl) * ORBIT,
      c[2] + (inPlane[2] / pl) * ORBIT,
    ],
    radius: 5200,
    atmosphere: 5200,
    handoff: 5900,
    surfaceWorld: 'planet:lathe',
    /** The body this one is a satellite of. The ONLY use of this field is the
     *  sky-separation rule: a moon sits close to its primary because that is
     *  what a moon is, so the pair is exempt from the 25-degree floor every
     *  other pair is held to. Anything else that wants to know about orbits
     *  should get a real orbital model rather than borrow this. */
    orbits: 'ceraunus',
    spin: 0.00022,
    axis: [0.12, 1, -0.19],
    look: {
      base: 0x8e8878,
      high: 0xcfc8b4,
      low: 0x4a463c,
      fissure: 0x36322a,
      fissureHot: 0x36322a,
      fissureCover: 0.38,
      atmosphere: 0x000000,
      atmoStrength: 0.0,
      detail: 3.8,
    },
    ring: null,
    blurb: 'Ring shepherd. Airless. Aurichalc under a sky full of rings. Landable.',
  };
})();

/**
 * CARNELIAN - the red iron world, hard to starboard.
 *
 * The one body whose bearing is dominated by a single axis other than -Z: 0.90
 * of +X. A player told "hard right and hold it" arrives, which is worth having
 * in a system where every other heading needs two components.
 *
 * Thin air (1.5 km) over a high, dry, oxidised highland. The descent is short
 * and the ground is visible for most of it - the opposite of Sirocco, and
 * deliberately so. Two dusty red planets that fly the same way are one planet
 * twice.
 */
const CARNELIAN = {
  id: 'carnelian',
  name: 'Carnelian',
  kind: 'rock',
  position: at([0.669, -0.230, -0.707], 205 * KM),
  radius: 8400,
  atmosphere: 9900,
  handoff: 9250,
  surfaceWorld: 'planet:carnelian',
  spin: 0.0010,
  axis: [0.30, 1, 0.11],
  look: {
    base: 0x8e3a1e,
    high: 0xd2764a,
    low: 0x4a1a0c,
    /* Dark, not hot. The same vein channel Cinder uses for incandescent
     * fissures draws Carnelian's gorge system as SHADOW - a cold
     * `fissureHot` is the whole difference, and it is why one planet reads
     * as alight and the other as cut. */
    fissure: 0x2a0e06,
    fissureHot: 0x6a2a12,
    fissureCover: 0.28,
    atmosphere: 0xe08050,
    atmoStrength: 0.72,
    haloScale: 1.04,
    detail: 2.8,
  },
  ring: null,
  blurb: 'Iron highlands. Scarps, dust and one very deep gorge. Landable.',
};

/**
 * SALLOW - the toxic world, straight down.
 *
 * The only near-axial bearing other than Vitrine's: 0.82 of -Y. "Straight down
 * from the yard" is a direction nothing else occupies, and it is the one
 * heading a player can hold with the nose on the deck.
 *
 * Fully back-lit at dot -0.83, so from the dock Sallow is the dimmest disc in
 * the sky and stays that way until you are on top of it. That is correct for
 * the planet: a sulfur world under permanent yellow overcast should look like
 * somewhere you have to decide to go.
 */
const SALLOW = {
  id: 'sallow',
  name: 'Sallow',
  kind: 'rock',
  position: at([-0.031, -0.882, -0.469], 232 * KM),
  radius: 7600,
  atmosphere: 9600,
  handoff: 8700,
  surfaceWorld: 'planet:sallow',
  spin: 0.0006,
  axis: [-0.24, 1, 0.08],
  look: {
    base: 0xb8a038,
    high: 0xe8dc76,
    low: 0x6a5610,
    fissure: 0xff9a2a,
    fissureHot: 0xffe08a,
    /* Hot veins again, but sparse - 0.11 against Cinder's 0.19. Sallow's heat
     * is in its vent fields rather than in a fissure network, so what shows
     * from orbit is a scatter of bright points rather than a web. */
    fissureCover: 0.11,
    atmosphere: 0xd8c840,
    atmoStrength: 0.93,
    haloScale: 1.08,
    detail: 2.2,
  },
  ring: null,
  blurb: 'Toxic. Acid lakes and fumarole fields under yellow overcast. Landable.',
};

/**
 * CATHEDRA - the crystal world, ahead and up, and the far edge of the system.
 *
 * 288 km, the longest leg there is and about ninety seconds under the transit
 * drive. Being furthest is its whole identity: the dearest ore that is not on
 * Lathe, and the smallest disc from the dock at 0.031 of screen height - just
 * over the 0.02 floor, so it reads as a real destination a long way off rather
 * than as a body that happens to be small.
 */
const CATHEDRA = {
  id: 'cathedra',
  name: 'Cathedra',
  kind: 'rock',
  position: at([-0.317, 0.128, -0.940], 288 * KM),
  radius: 6800,
  atmosphere: 8200,
  handoff: 7600,
  surfaceWorld: 'planet:cathedra',
  spin: 0.0015,
  axis: [0.44, 1, 0.30],
  look: {
    base: 0x6a6e8c,
    high: 0xd8dcf4,
    low: 0x2a2c42,
    /* The one body where the vein channel is BRIGHTER than the high band. The
     * shattered plate boundaries catch the star and throw it back, so from
     * orbit Cathedra is a dark blue-grey sphere webbed in white - the only
     * body in the sky legible by its cracks rather than by its disc. */
    fissure: 0xeaf0ff,
    fissureHot: 0xffffff,
    fissureCover: 0.34,
    atmosphere: 0xb8c4f0,
    atmoStrength: 0.8,
    haloScale: 1.05,
    detail: 3.4,
  },
  ring: null,
  blurb: 'Crystal. Shattered plates, spire fields and a hollow vault. Landable.',
};

/**
 * Every body in the volume, nearest first is NOT guaranteed - the render path
 * sorts per frame and nothing should depend on this order.
 * @type {SpaceBody[]}
 */
export const SPACE_BODIES = [
  /* CINDER STAYS FIRST and new bodies are APPENDED, never prepended:
   * `scripts/tests/space-scale.test.mjs` pins `landableBodies()[0].id` to
   * 'cinder' as the ablation guard on this ordering. */
  CINDER, VITRINE, CERAUNUS, TESSERA, ERENMARK,
  SIROCCO, SHOAL, VERDIGRIS, LATHE, CARNELIAN, SALLOW, CATHEDRA,
];

/** @type {Record<string, SpaceBody>} */
export const BODY_BY_ID = Object.fromEntries(SPACE_BODIES.map((b) => [b.id, b]));

/** The star, which is also the light. One place, so they cannot disagree. */
export const PRIMARY = ERENMARK;

/**
 * Unit vector pointing FROM the origin TOWARDS the star - which is the
 * convention `environment.sunDirection` uses everywhere else in the game
 * (main.js places the shadow-casting sun at `player + sunDirection * 90`).
 *
 * Space is small enough relative to 640 km that treating the star as
 * directional everywhere is correct to within 0.05 degrees at the far edge of
 * the volume. It is NOT correct near the star, and there is nothing near the
 * star.
 */
export const STAR_DIRECTION = (() => {
  const [x, y, z] = PRIMARY.position;
  const len = Math.hypot(x, y, z);
  return [x / len, y / len, z / len];
})();

/**
 * WHERE THE DOCK IS, and everything a caller needs to point at it.
 *
 * Published rather than buried in SpaceWorld because three different things
 * need it and none of them should be reading a private constant: the exterior
 * geometry, the return portal, and the HUD's home marker.
 *
 * `mouth` is the centre of the hangar opening, `mouthNormal` the direction it
 * faces. `berths` are the pier ends, in the order the yard numbers them, with
 * the heading a ship parked there points.
 */
export const DOCK_ANCHOR = {
  id: 'dock',
  name: 'Lodestar Yard',
  position: [0, 0, 0],
  /** Radius of a sphere that contains the whole structure - measured against
   *  the geometry in DockExterior.js, whose furthest point is the spine cap at
   *  (0, 96, 250). Used for the far-limb cap and for framing. */
  radius: 285,
  mouth: [0, 0, -18],
  mouthNormal: [0, 0, -1],
  /**
   * Where a body arriving from the yard's launch portal stands.
   *
   * Published here rather than typed into `SpaceWorld._fillSpawns` because it
   * is the origin of the yard's REACHABILITY claim, and a probe that floods
   * the deck from a hand-copied coordinate is a probe of somewhere else the
   * day the spawn moves. `space-yard-reach.test.mjs` floods from this exact
   * point; `SpaceWorld` places the player on it.
   */
  apronSpawn: [0, 0.4, -38],
  /** Radius inside which the yard's traffic control takes the ship. */
  handoff: 130,
  berths: [
    { id: 'berth-1', position: [-104, 0, -196], heading: [0, 0, -1] },
    { id: 'berth-2', position: [-38, 0, -232], heading: [0, 0, -1] },
    { id: 'berth-3', position: [38, 0, -232], heading: [0, 0, -1] },
    { id: 'berth-4', position: [104, 0, -196], heading: [0, 0, -1] },
  ],
  blurb: 'Lodestar Yard. Home berth.',
};

/**
 * HALBERD REACH - the asteroid belt, to port.
 *
 * Not a `SpaceBody`: it has no surface, no handoff and no sphere, and forcing
 * it into that shape would put four null fields in every planet. Belt.js
 * builds the rocks from this.
 *
 * Close in (26 km centre, 5.5 km across) because it is the one piece of
 * scenery in Phase 1 that the player is meant to fly INTO rather than at, and
 * a hazard 200 km away is scenery nobody visits.
 */
export const BELT = {
  id: 'halberd-reach',
  name: 'Halberd Reach',
  position: at([-0.90, 0.06, -0.43], 26 * KM),
  /** Ellipsoidal shell half-extents. Flattened in Y so it reads as a belt. */
  extent: [5500, 1400, 5500],
  /** Inner void, as a fraction of `extent`. Rocks cluster in a shell. */
  hollow: 0.34,
  count: 260,
  rockRadius: [18, 340],
  tint: 0x5d564e,
  blurb: 'Halberd Reach. Debris field. Ferrite and ice.',
};

/* ------------------------------------------------------------------ */
/* The approach interface                                              */
/* ------------------------------------------------------------------ */

/**
 * Phases of an approach, in order. A caller can compare these as strings; the
 * numeric ranks are here so a caller can also ask "am I at least in
 * `approach`" without a lookup table of its own.
 */
export const APPROACH_PHASE = {
  cruise: 0,
  approach: 1,
  atmosphere: 2,
  handoff: 3,
};

/**
 * Distance, as a multiple of the body's radius, at which an approach stops
 * being cruise. Chosen so `approach` begins where the body first fills more
 * than a fifth of the screen - the point at which a pilot stops steering by
 * the nav marker and starts steering by the planet.
 */
const APPROACH_AT_RADII = 6;

/** Reused result object. `approachState` is called every frame; it allocates
 *  nothing, so the caller must not hold on to the object across frames. */
const _approach = {
  body: null,
  /** Metres from the ship to the body CENTRE. */
  distance: Infinity,
  /** Metres from the ship to the body SURFACE. Negative means inside. */
  altitude: Infinity,
  /** 'cruise' | 'approach' | 'atmosphere' | 'handoff' */
  phase: 'cruise',
  /** 0 at the top of the atmosphere, 1 at the surface. 0 outside the air. */
  atmoDepth: 0,
  /** True on the frame the surface world should be activated. */
  shouldHandoff: false,
  /**
   * Metres the ship is INSIDE this body's pressure hull, 0 when it is not and
   * 0 for every body that has one of its own to land on. Positive means the
   * caller must put the ship back - see THE PRESSURE HULL at the top.
   */
  hullDepth: 0,
  /** Metres to the hull, +ve outside. `Infinity` when the body has no hull. */
  hullClear: Infinity,
};

/**
 * WHICH BODY IS THE SHIP FALLING TOWARDS, AND HOW FAR INTO THE FALL.
 *
 * The single call the planet system needs. Give it a ship position in the true
 * frame and it returns the nearest body by SURFACE distance (not centre
 * distance - a gas giant 100 km away is not "nearer" than a moonlet you are
 * skimming), plus the phase of the approach.
 *
 * `shouldHandoff` is the one the caller acts on: when it goes true, activate
 * the world named by `body.surfaceWorld`. The arrival vector the ship came in
 * on is `(shipPos - body.position)` normalised - the planet world decides
 * which of its landing pads that maps to, because pads are its data, not
 * this file's.
 *
 * A body with `handoff === 0` never sets `shouldHandoff`, so a player who
 * flies into Ceraunus this phase gets `phase: 'atmosphere'` and whatever the
 * flight model does about a wall - which is the flight model's call, not this
 * file's.
 *
 * @param {{x:number,y:number,z:number}} shipPos true-frame position
 * @param {typeof _approach} [out] reused; pass your own to keep a snapshot
 * @returns {typeof _approach}
 */
export function approachState(shipPos, out = _approach) {
  out.body = null;
  out.distance = Infinity;
  out.altitude = Infinity;
  out.phase = 'cruise';
  out.atmoDepth = 0;
  out.shouldHandoff = false;

  for (let i = 0; i < SPACE_BODIES.length; i++) {
    const b = SPACE_BODIES[i];
    const p = b.position;
    const dx = shipPos.x - p[0];
    const dy = shipPos.y - p[1];
    const dz = shipPos.z - p[2];
    const D = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const alt = D - b.radius;
    if (alt < out.altitude) {
      out.altitude = alt;
      out.distance = D;
      out.body = b;
    }
  }

  const b = out.body;
  if (!b) return out;

  if (out.distance <= b.handoff && b.handoff > 0) {
    out.phase = 'handoff';
    out.shouldHandoff = true;
  } else if (out.distance <= b.atmosphere) {
    out.phase = 'atmosphere';
  } else if (out.distance <= b.radius * APPROACH_AT_RADII) {
    out.phase = 'approach';
  }

  const air = b.atmosphere - b.radius;
  if (air > 0 && out.altitude < air) {
    const t = 1 - out.altitude / air;
    out.atmoDepth = t < 0 ? 0 : t > 1 ? 1 : t;
  }

  /* The hull, measured here rather than by the caller: it is the same
   * centre-distance the phases above are cut from, and a second subtraction
   * one file over is a second thing to keep in step with `hull`. */
  if (b.hull > 0) {
    out.hullClear = out.distance - b.hull;
    out.hullDepth = out.hullClear < 0 ? -out.hullClear : 0;
  }
  return out;
}

/**
 * How far out the "there is nothing to land on here" warning starts, as a
 * multiple of the hull radius.
 *
 * 1.45 on Ceraunus is 93,670 m from the centre - just outside the ring
 * system's outer edge (2.28 radii, 86,640 m), so the sentence arrives as the
 * rings come into frame and 29 km before the wall. It is also where a live
 * transit drive is cut (`Piloting._transitBreak`), which is what stops a ship
 * arriving on the wall at 5,000 m/s: the altitude law allows that speed out
 * here because the nearest SURFACE is 55 km below, and there is no surface.
 * A pilot who is told at the last kilometre has been told nothing; one who is
 * told from 6 body radii out has been nagged.
 */
export const HULL_WARN_BAND = 1.45;

/** Bodies that stop a ship instead of taking it. Data, so a test can sweep them. */
export function hulledBodies() {
  return SPACE_BODIES.filter((b) => b.hull > 0);
}

/** Bodies a ship can actually land on this phase. */
export function landableBodies() {
  return SPACE_BODIES.filter((b) => b.handoff > 0 && b.surfaceWorld);
}

/**
 * Everything worth drawing a marker for, dock included, as flat data. The HUD
 * agent should read this rather than reaching into SpaceWorld.
 * @returns {Array<{id:string,name:string,position:number[],radius:number,blurb:string,kind:string}>}
 */
export function navTargets() {
  const out = [
    {
      id: DOCK_ANCHOR.id,
      name: DOCK_ANCHOR.name,
      position: DOCK_ANCHOR.position,
      radius: DOCK_ANCHOR.radius,
      blurb: DOCK_ANCHOR.blurb,
      kind: 'dock',
    },
    {
      id: BELT.id,
      name: BELT.name,
      position: BELT.position,
      radius: BELT.extent[0],
      blurb: BELT.blurb,
      kind: 'field',
    },
  ];
  for (const b of SPACE_BODIES) {
    out.push({
      id: b.id,
      name: b.name,
      position: b.position,
      radius: b.radius,
      blurb: b.blurb,
      kind: b.kind,
    });
  }
  return out;
}
