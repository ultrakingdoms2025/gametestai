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
 * Erenmark being BEHIND is deliberate and does two things at once. It means
 * everything the player flies towards is front-lit rather than a silhouette,
 * and it means that when they are lost, the way home and the brightest thing
 * in the sky are roughly the same bearing. That is navigation for free.
 *
 * -- Distances: how they were chosen ----------------------------------------
 *
 * Assumed flight envelope, which is the number this layout is pinned to and
 * the one to come back and re-derive against when the flight model lands:
 *
 *     cruise 260 m/s, boost 1600 m/s
 *
 * Cinder at 62 km is 39 s at boost, 4 min at cruise. That is a trip: long
 * enough that arriving is an event, short enough to do twice in a session.
 * Everything else is scenery this phase, so it is placed for how it LOOKS
 * from the dock rather than for how long it takes to reach.
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
 * @property {number}   spin           radians/second about the body's axis
 * @property {number[]} axis           spin axis, unit-ish
 * @property {Object}   look           palette and shader parameters
 * @property {Object|null} ring        ring geometry, gas giants only
 * @property {string}   blurb          one line, for a nav-target readout
 */

/** Metres. Reused by the layout and by anything that wants to reason in km. */
const KM = 1000;

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
 * Not landable this phase - `handoff` is 0 and `surfaceWorld` is null, which
 * is the only difference between it and Cinder. Making it landable is writing
 * a descriptor in planets/ and setting those two fields; nothing here changes
 * shape. That is the boundary working.
 */
const VITRINE = {
  id: 'vitrine',
  name: 'Vitrine',
  kind: 'ice',
  position: at([0.16, 0.10, -0.98], 155 * KM),
  radius: 15000,
  atmosphere: 15900,
  handoff: 0,
  surfaceWorld: null,
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
  blurb: 'Ice. Deep clathrate fields. No berth.',
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
  blurb: 'Gas giant. Ring system. No surface.',
};

/**
 * TESSERA - a cratered moonlet, off to starboard.
 *
 * The small one. Every other body is big; without something that stays a chip
 * of grey at 5.5 degrees no matter how long you look at it, the sky has no
 * bottom to its size range and the big ones stop reading as big.
 */
const TESSERA = {
  id: 'tessera',
  name: 'Tessera',
  kind: 'moon',
  position: at([0.94, -0.16, -0.30], 88 * KM),
  radius: 4200,
  atmosphere: 4200,
  handoff: 0,
  surfaceWorld: null,
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
  blurb: 'Airless moonlet. Platinum-group traces.',
};

/**
 * Every body in the volume, nearest first is NOT guaranteed - the render path
 * sorts per frame and nothing should depend on this order.
 * @type {SpaceBody[]}
 */
export const SPACE_BODIES = [CINDER, VITRINE, CERAUNUS, TESSERA, ERENMARK];

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
  return out;
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
