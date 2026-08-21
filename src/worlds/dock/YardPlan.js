/**
 * LODESTAR YARD — the plan, as numbers.
 *
 * Zero imports, `three` included. Everything in this file is arithmetic, and
 * everything the yard is dimensioned off lives here so there is exactly one
 * place a measurement can be changed. The precedent is
 * `medieval/Settlements.js` and `station/StationKit.js`'s constant block: the
 * failures these numbers cause are silent (a catwalk that does not reach its
 * stair, a berth anchor that lands inside a cradle, a rail gap in the wrong
 * run) and none of them needs a renderer to catch, so the tests read this file
 * rather than re-deriving it.
 *
 * ── The datum ─────────────────────────────────────────────────────────────
 * The surveyors' brass benchmark is at world (0, 0, 0) and every number below
 * is referred to it, which is what a datum is and why the plate is still
 * bolted to the floor. `DATUM_ISLAND_HZ` is the one place the service trench
 * was cut around rather than through: the benchmark is bolted to virgin slab.
 */

import { SPACE_BODIES } from '../space/Bodies.js';
import { CONFIG } from '../../core/Config.js';

/** The player's own numbers, for the one dimension that is about their legs.
 *  @see MOUTH_SCREEN_H */
const PLAYER = CONFIG.player;

/* ------------------------------------------------------------------ */
/* Levels                                                              */
/* ------------------------------------------------------------------ */

/** Assembly floor. The brass plate is at (0, DECK_Y, 0). */
export const DECK_Y = 0;
/** Perimeter catwalk. Every hull spine is authored to mantle onto this. */
export const GANTRY_Y = 8.0;
/**
 * Crane rail. Visual only — the RAIL is not walkable; the cab platform at the
 * same height is, and is reached by the caged run off the north crossing.
 * A viewpoint nobody can stand on is unreachable content, which is this
 * project's signature defect; see `CRANE_CAB`.
 */
export const CRANE_Y = 15.4;
/** Underside of the roof truss, and the height of the collided roof plate. */
export const ROOF_Y = 26.0;
/** Service trench floor. 2.2 m down: no fall damage (7.5 m), no ladder needed. */
export const TRENCH_Y = -2.2;

/* ------------------------------------------------------------------ */
/* Extent                                                              */
/* ------------------------------------------------------------------ */

/** Floor half-width. The inner face of the side walls. */
export const YARD_X = 86;
/** Blast-door end of the floor. */
export const YARD_Z0 = -104;
/** Apron end of the floor — the gateway arrives here. */
export const YARD_Z1 = 58;

/** Walkable width of every catwalk run and every crossing. */
export const WALK_W = 2.4;
/** Inner (guarded) edge of the perimeter catwalk, per axis. */
export const GANTRY_X = YARD_X - WALK_W;      // 83.6
export const GANTRY_Z0 = YARD_Z0 + WALK_W;    // -101.6
export const GANTRY_Z1 = YARD_Z1 - WALK_W;    // 55.6

/** Painted keel line: half-width of the chalk-and-brass strip. */
export const KEEL_HW = 2.0;

/* ------------------------------------------------------------------ */
/* Portals                                                             */
/* ------------------------------------------------------------------ */

/**
 * The gateway home, on the apron.
 *
 * `rotationY: Math.PI`, for exactly the reason SurveyWorld recorded before it:
 * `WorldManager.arrivalFor` stands an arriving player 2.6 m along the portal's
 * own normal `(sin rotY, cos rotY)` and turns them to face further along it.
 * At 0 the normal is +Z and the player arrives at z 54.6 looking at the apron
 * wall with the whole yard behind them. At PI the normal is -Z: they arrive at
 * z 49.4 facing down the keel line, with the berths either side and the blast
 * door closing the view.
 */
export const PORTAL_STATION_Z = 52;
/**
 * The launch portal, ON THE OPEN PIER — Berth Zero's docking cradle.
 *
 * It used to stand on the deck in front of a sealed blast door, which is the
 * arrangement the whole world has just stopped being. The bay is open now and
 * the keel line runs straight out of it onto the one empty pier, so the point
 * you leave from and the point you come home to is the vacant cradle at the
 * end of that pier: `arrivalFor` looks the return portal up BY TARGET and
 * takes the first match (`WorldManager.js:427`), so the outbound and the
 * inbound leg are one spec and there is exactly one of them.
 *
 * NOT in a cockpit, for the reason that has not changed: a launch portal
 * authored inside a 3 m cockpit puts the returning pilot 2.6 m along its own
 * normal, through the far bulkhead. The seat still launches you — it calls
 * `portals.enterById('dock->space')`, the same record.
 *
 * `rotationY: 0` — the normal is +Z, back down the pier, so a pilot coming
 * home steps out facing the bay mouth with the whole yard framed in it.
 */
export const PORTAL_SPACE_Z = -158;

/* ------------------------------------------------------------------ */
/* The service trench                                                  */
/* ------------------------------------------------------------------ */

/** Half-width of the trench slot. */
export const TRENCH_HW = 1.5;
/** Half-length of the solid island the datum plate is bolted to. */
export const DATUM_ISLAND_HZ = 3.0;
/** Trench runs, `[zSouth, zNorth]`, cut either side of the datum island. */
export const TRENCH_RUNS = Object.freeze([
  Object.freeze([DATUM_ISLAND_HZ, 14]),     // +3 .. +14, the short run by B1
  Object.freeze([-70, -DATUM_ISLAND_HZ]),   // -70 .. -3, the long run to B4
]);

/**
 * Open bays. Each is a 6 m gap in the grating whose northern 5.6 m is a ramp
 * from the trench floor to the deck, so every bay is an entrance AND an exit.
 *
 * Three, not the one the brief asked for. One exit from a 2.2 m slot 84 m long
 * is a walk of up to 84 m to leave a corridor you can see out of the top of;
 * three costs two extra ramp proxies and makes the trench a route rather than
 * a pit. `up` is the direction the ramp climbs in Z.
 */
export const TRENCH_BAYS = Object.freeze([
  Object.freeze({ id: 'bay-s', z0: 8, z1: 14, up: 1 }),
  Object.freeze({ id: 'bay-m', z0: -9, z1: -3, up: 1 }),
  Object.freeze({ id: 'bay-n', z0: -70, z1: -64, up: -1 }),
]);
/** Run of every trench ramp; rise is `-TRENCH_Y`, so the pitch is 21.4 deg. */
export const TRENCH_RAMP_RUN = 5.6;

/* ------------------------------------------------------------------ */
/* The test-fire butts                                                 */
/* ------------------------------------------------------------------ */

/**
 * A shooting range in the covered length of the service trench.
 *
 * -- Why it is HERE and not on the floor -----------------------------------
 * `TRENCH_RUNS[1]` runs -70 .. -3 and `TRENCH_BAYS` cuts it open at -9..-3 and
 * -70..-64, so everything between -64 and -9 is grated over: 55 m of enclosed,
 * roofed, 3 m-wide corridor 2.2 m under the assembly floor. It is already
 * described in this world as "the only place in the yard you cannot see the
 * roof from", which is the same sentence as "the only place in the yard you
 * can safely fire down".
 *
 * -- Why the plates do not block the trench --------------------------------
 * They cannot be allowed to. The trench is the route to the northern bay, the
 * -42 and -58 collectible spots and the bay-n ramp out, and a stop butt across
 * a 3 m corridor would seal all of it - content BUILT and unREACHable, which
 * is the defect this world's whole test strategy exists to catch.
 *
 * So every plate hangs off a wall with its OUTER edge on the wall face and
 * shrinks inboard as the range lengthens:
 *
 *     rank    z     half-extent   inner edge   clear lane
 *     near   -24       0.34          0.79        1.58 m
 *     mid    -32       0.26          0.95        1.90 m
 *     far    -40       0.20          1.07        2.14 m
 *
 * The narrowest lane is 1.58 m against a `CONFIG.player.radius` of 0.35, so
 * the corridor stays walkable at every rank with 0.44 m to spare either side,
 * and `dock-reach.test.mjs`'s trench march still runs end to end. It is also
 * the difficulty curve: the far plates are the small ones.
 *
 * Plate centres sit at `TRENCH_Y + PLATE_Y`, chest height on the trench floor,
 * which keeps their column's headroom under the walk graph's 1.9 m either side
 * of them - the plates are an obstruction to a HEAD, never to a route.
 */
export const BUTTS_FIRE_Z = -14;
/** Wall face the plates hang from, per side: the trench slot's own side. */
export const BUTTS_WALL_X = TRENCH_HW - 0.03;
/** Plate centre height above the trench floor. */
export const BUTTS_PLATE_Y = 1.10;
/** Plate half-thickness. Thin enough that one rank is one grid row. */
export const BUTTS_PLATE_T = 0.06;

/**
 * The three ranks. `half` is the plate's half-width AND half-height - the
 * plates are square, so one number is the whole target size.
 */
export const BUTTS_RANKS = Object.freeze([
  Object.freeze({ id: 'near', z: -24, half: 0.34 }),
  Object.freeze({ id: 'mid', z: -32, half: 0.26 }),
  Object.freeze({ id: 'far', z: -40, half: 0.20 }),
]);

/**
 * Every plate, resolved: two per rank, one on each wall, outer edge on the
 * wall face. Built here rather than in `DockWorld` so the geometry, the
 * colliders and the venue's `config.targets` are one list and cannot drift -
 * a target the game scores that the world never drew, or a plate the world
 * drew that the game does not score, are the same bug from either end.
 */
export const BUTTS_PLATES = Object.freeze(BUTTS_RANKS.flatMap((r, ri) =>
  [-1, 1].map((side) => Object.freeze({
    id: `${r.id}-${side < 0 ? 'port' : 'stbd'}`,
    rank: ri,
    x: side * (BUTTS_WALL_X - r.half),
    y: TRENCH_Y + BUTTS_PLATE_Y,
    z: r.z,
    hx: r.half,
    hy: r.half,
    hz: BUTTS_PLATE_T,
  }))
));

/** Laser cells the range burns to light the plates for one run. */
export const BUTTS_CELL_COST = 8;
/** Seconds allowed to put all six plates down. */
export const BUTTS_SECONDS = 45;
/** Credits a clear run pays. */
export const BUTTS_REWARD = 120;

/* ------------------------------------------------------------------ */
/* Gantry access                                                       */
/* ------------------------------------------------------------------ */

/**
 * Stair geometry. 20 risers of 0.40 m over an 11.42 m run is 35.0 deg.
 *
 * The riser is under `CONFIG.player.stepHeight` (0.45) but that is not what
 * makes the flight walkable — the capsule solver resolves slopes and does NOT
 * step up (`station/Tower.js:527`), so the treads are drawn and the collision
 * is ONE hidden `_ramp` proxy under them. A stack of 0.40 m boxes looks right
 * and stops the player dead at the first riser.
 */
export const STAIR_RISERS = 20;
export const STAIR_RISE = GANTRY_Y / STAIR_RISERS;              // 0.40
export const STAIR_RUN = GANTRY_Y / Math.tan((35 * Math.PI) / 180); // 11.4252
export const STAIR_W = WALK_W;

/**
 * The two stair flights, both on the port wall, both running in +X→-X so the
 * head lands square on the catwalk's inner edge and the rail gap is a cut in
 * ONE run (`x0`) rather than a whole run dropped. `z` is the flight centreline.
 */
export const STAIRS = Object.freeze([
  Object.freeze({ id: 'stair-apron', z: 42, footX: -GANTRY_X + STAIR_RUN, headX: -GANTRY_X }),
  Object.freeze({ id: 'stair-blast', z: -88, footX: -GANTRY_X + STAIR_RUN, headX: -GANTRY_X }),
]);

/** The two catwalk crossings over the keel line, at y GANTRY_Y. */
export const CROSSINGS = Object.freeze([10, -46]);
/**
 * Crossing support columns. Kept out of |x| <= 12 so the keel corridor, the
 * trench bays and the merchant row are never blocked by a post.
 */
export const CROSSING_COLUMN_X = Object.freeze([-74, -48, -20, 20, 48, 74]);

/* ------------------------------------------------------------------ */
/* Berths — the anchors the ships plug into                            */
/* ------------------------------------------------------------------ */

/**
 * Four berths. THREE OF THEM ARE ON PIERS, OUTSIDE THE BAY, IN VACUUM.
 *
 * ── What changed, and why ─────────────────────────────────────────────────
 * The first yard stood four hulls on cradles inside a sealed shed and the
 * verdict on it was "it looks overall just like a big dark room". What was
 * asked for instead, in the player's own words, is "a hangar bay with space
 * piers stretching from the hangar into space, at the end of each pier is a
 * spaceship that i can then pilot the ship into space". So the north wall is
 * an open mouth now, five piers run out through it, and the three flyable
 * hulls sit at the ends of three of them with their noses pointing out at the
 * stars. `yaw: Math.PI` is that sentence as a number: a ship's local +Z is its
 * nose, local +Z maps to world `(sin yaw, cos yaw)`, and at PI that is -Z —
 * straight out of the bay.
 *
 * The BASTION does not move. She is a hulk with her frames open, she has
 * never flown and is not going to, and a hulk under repair belongs on a
 * cradle on the shop floor — where she is now the one big silhouette between
 * the player and the open mouth, which is worth more than a fourth pier.
 *
 * ── What did not change ───────────────────────────────────────────────────
 * Every field below means exactly what it meant before, and `cradleTop`,
 * `hw`, `hd` and `side` are the SAME NUMBERS: the hulls are authored in their
 * own frames off `cradleTop`, so moving a berth 150 m north and turning it
 * through 160 degrees costs the hull builders nothing at all. That is the
 * whole reason the berth anchor exists.
 *
 * `x, z` is the CRADLE CENTRE on the floor and the origin of the ship's own
 * local frame; `yaw` is the world yaw of that frame (a ship's local +Z is its
 * nose). `cradleTop` is the height of the cradle's bearing face — the keel
 * point, i.e. ship-local y 0. `hw`/`hd` are the half-extents of the berth
 * FOOTPRINT (cradle plus working clearance) which the ship stage publishes to
 * `_collisionSoup` so the derived pass leaves the hull alone; `apron` is the
 * point on the keel-line side of the berth a boarding ramp foot lands on, and
 * is what the reach probe marches to.
 *
 * These are published on the world as `shipSpecs` and are the entire contract
 * between this drop and the next one. Nothing here draws a ship.
 */
export const BERTHS = Object.freeze([
  Object.freeze({
    /* 20, not the 14 this shipped with. The Kestrel was re-proportioned from
     * a 3.04 : 1 fineness (a van) to 4.35 : 1 (a courier) by adding LENGTH at
     * an unchanged 4.60 m beam, because 'lean' is a ratio and the 4.16 m walk-in
     * cabin was not up for negotiation. This field's only consumer is
     * `DockWorld._buildBerths`' saddle count, `max(3, round(length / 6))`, which
     * is 3 at either value - so nothing rendered differently and nothing failed,
     * which is exactly why a stale number here could sit unnoticed. */
    id: 'kestrel', berth: 'B1', side: -1, klass: 'courier', length: 20,
    pier: 'P1', x: -68, z: -143, yaw: Math.PI, cradleTop: 1.2, hw: 9, hd: 12,
    apron: Object.freeze({ x: -60, z: -143 }),
  }),
  /**
   * `stairZ` is the one berth field that is not the same number it was, and it
   * is arithmetic rather than taste.
   *
   * The cradle's service stair climbs from the pad to the cradle top on the
   * BOARDING side, because that is the only strip of cradle a body can stand
   * on — the hull's belly covers the middle. The Dray is also the one hull
   * whose own cargo ramp comes down to the deck rather than onto the cradle
   * (`HullPlan.DRAY.ramp.from === 'deck'`), and it lands on the same side, at
   * local z -1.5. Struck at the berth centre the two flights overlapped by
   * 0.8 m of width and passed within 0.06 m of each other in height: the two
   * ramp proxies merged into one column, and `dock-reach` reported the Dray's
   * hold as somewhere you could get INTO and not back out of.
   *
   * -6 m puts the service stair at local z 6.0, seven and a half metres
   * forward of the cargo ramp and still well inside the cradle, which spans
   * local -11.9 to 11.9.
   */
  /**
   * The Dray's apron is at x 47.6 and her `side` is -1, and both are the
   * consequence of ONE rule: `boardSide` must come out the same as it did on
   * the shop floor.
   *
   * `HullPlan.boardSide` derives the local X the ramp runs out along from the
   * published apron, and the hull builders mirror the cargo door, the ramp,
   * the deck plate and the fit-out about it. Turning the ship through 160
   * degrees and leaving the apron inboard flipped that sign, which mirrored
   * the whole hold: `dock-hulls` found four square metres of the Dray's own
   * deck plate that had been beside the door and was now behind the engine
   * casing, standable and on no route. So the apron moved to the OUTBOARD side
   * of Pier Three instead, `boardSide` comes out -1 exactly as it always did,
   * and not one line of the hull changed.
   *
   * 47.6 is not chosen either — it is where the ramp foot actually lands
   * (`ShipBuild` puts it at local x 13.6 for a 2.6 m rise off the deck), and
   * the apron anchor has to BE the ramp foot or the two disagree about where a
   * body boards. `PIERS.P3` is 19 m in the half-width to hold it with 5.4 m of
   * pad to spare, which is also why it is the widest of the five.
   *
   * `stairZ` is the second consequence. The cradle's service stair climbs on
   * the boarding side, because the hull's belly covers the middle of the
   * cradle and the flanks are the only strip of it a body can stand on; the
   * Dray is also the one hull whose ramp comes down to the DECK rather than
   * onto the cradle (`DRAY.ramp.from === 'deck'`), on the same side. Struck at
   * the berth centre the two flights overlapped by 0.8 m of width and passed
   * within 0.06 m of each other in height: the two ramp proxies merged into
   * one column and `dock-reach` reported the hold as somewhere you could get
   * into and not back out of. -6 m puts the service stair at local z 6.0,
   * seven and a half metres clear, and still well inside a cradle that spans
   * local -11.9 to 11.9.
   */
  Object.freeze({
    id: 'dray', berth: 'B2', side: -1, klass: 'ore tender', length: 28,
    pier: 'P3', x: 34, z: -154, yaw: Math.PI, cradleTop: 1.6, hw: 12, hd: 18,
    apron: Object.freeze({ x: 47.6, z: -154 }), stairZ: -160,
  }),
  Object.freeze({
    id: 'pike', berth: 'B3', side: -1, klass: 'interceptor', length: 18,
    pier: 'P2', x: -34, z: -155, yaw: Math.PI, cradleTop: 1.2, hw: 10, hd: 14,
    apron: Object.freeze({ x: -26, z: -155 }),
  }),
  /* The hulk, still on the shop floor, still yawed off the world axes because
   * she was pinned back together where she stopped rather than where a jig
   * wanted her. She is 40 m short of the mouth and 44 m long, which is what
   * puts her ribs across the stars in every framing that looks north. */
  Object.freeze({
    id: 'bastion', berth: 'B4', side: 1, klass: 'frigate hulk', length: 44,
    pier: null, x: 40, z: -64, yaw: -0.12, cradleTop: 2.2, hw: 15, hd: 26,
    apron: Object.freeze({ x: 23.5, z: -64 }),
  }),
]);

/* ------------------------------------------------------------------ */
/* The section jigs                                                    */
/* ------------------------------------------------------------------ */

/**
 * Hull sections in jigs, standing where berths one, two and three used to be.
 *
 * Moving three hulls out onto the piers left three empty rectangles of painted
 * floor in the middle of the bay, and an empty rectangle of painted floor is
 * not neutral — it reads as a berth whose ship failed to load. Measured on the
 * `yard-wide` framing: the whole southern half of the bay was apron, chalk grid
 * and nothing at 60 m from the eye.
 *
 * What goes there is what this yard does. Lodestar re-assembles hulls from
 * sections narrow enough to come through a gateway, so a working bay has
 * sections in jigs waiting to be pinned to something — which is also the one
 * piece of set dressing in this world that explains the ships on the piers.
 *
 * `r` is the section's outer radius, `len` its length along the jig axis, and
 * `yaw` the jig's own. The ring frames are drawn; only the jig cradle and the
 * section itself are collided, because those are the two things a body can
 * walk into.
 */
export const SECTIONS = Object.freeze([
  Object.freeze({ id: 'sec-b1', x: -30, z: 22, yaw: -0.28, r: 3.1, len: 11, frames: 5 }),
  Object.freeze({ id: 'sec-b2', x: 34, z: -2, yaw: 0.20, r: 4.4, len: 16, frames: 6 }),
  Object.freeze({ id: 'sec-b3', x: -34, z: -34, yaw: 0.16, r: 3.4, len: 13, frames: 5 }),
]);

/* ------------------------------------------------------------------ */
/* The chandlery row                                                   */
/* ------------------------------------------------------------------ */

/**
 * Three counters, port side of the keel corridor.
 *
 * The brief put this row "under the port catwalk", which is x -84: eighty
 * metres off the only route through the yard, against a `VENDOR_RANGE` of 7 m
 * (`Marketplace.js:23`). A counter you cannot see from the line you walk is a
 * shop nobody opens. They stand at x -9.5 instead — one step off the keel
 * strip, inside the pool of the first crossing's worklights, and still clear
 * of the trench bays at |x| <= 1.9.
 *
 * `vendorCategories` between the three cover the whole catalogue including the
 * new `ships` tab; a category no counter stocks is an item nobody in the world
 * can buy (`Marketplace.refreshCatalog :280-282`).
 */
export const COUNTER_X = -9.5;
export const COUNTERS = Object.freeze([
  Object.freeze({ id: 'chandler', z: 20 }),
  Object.freeze({ id: 'fitter', z: 6 }),
  Object.freeze({ id: 'paint', z: -8 }),
]);

/* ------------------------------------------------------------------ */
/* Named places                                                        */
/* ------------------------------------------------------------------ */

/**
 * The apron kerb: where the poured concrete pad at the gateway end begins.
 *
 * A published number rather than a local one because it is a GROUND BOUNDARY,
 * not a decoration. The pad is a real 0.12 m slab, so every floor marking in
 * the yard belongs to the deck south of this line and to the apron north of
 * it; struck once at deck level, the keel line, the chalk grid and the
 * chainage ticks were 55-90 mm inside the concrete for the whole 27 m the
 * player walks on arriving. 37 is the value that separates berth one's painted
 * bay outline (which reaches z 36.56 at its yawed corner) from the site office
 * (whose south wall stands at 37.5), so that nothing straddles it.
 */
export const APRON_Z = 37;

/**
 * The site office on the apron: the drop's one real enterable interior.
 *
 * `z` is 41 and not the 40 first drafted, and the metre is the apron kerb
 * rather than composition. The pad has to start north of berth one's painted
 * bay outline — whose yawed corner reaches z 36.56 — and south of this hut, or
 * one of the two straddles it: a marking half buried under 120 mm of concrete,
 * or a building with half its plinth on the pad and half on the deck. A kerb
 * at 37 with the office south wall at 37.5 separates them with 440 mm to
 * spare, and that is what lets every marking in this world belong to exactly
 * one ground.
 */
export const OFFICE = Object.freeze({
  x: -58, z: 41, yaw: Math.PI / 2,
  w: 9.0, d: 7.0, h: 3.2,
  /** Door centre in world space; its threshold is the deck, so `dy` is 0. */
  doorX: -53.5, doorZ: 41,
});

/**
 * Crane cab platform — walkable, unlike the rail it hangs off.
 *
 * Parked at the PORT end of its bridge and clear of both crossings, which is
 * where a gantry crane's cab actually lives and, more to the point, is what
 * makes the leap of faith honest: straight down off the cab is 13.1 m of clear
 * air onto the tarped spares pile, with no catwalk in between to land on
 * instead.
 */
export const CRANE_CAB = Object.freeze({ x: -70, y: CRANE_Y, z: -24 });
/**
 * The caged run from the port catwalk up to the crane runway walkway.
 *
 * It climbs INBOARD, cantilevered out over the bay, rather than along the
 * catwalk: a flight that rises in the catwalk's own footprint puts its
 * underside through the walkway underneath it and blocks the perimeter loop
 * for the two metres where the headroom goes to zero.
 */
export const CRANE_RUN = Object.freeze({
  run: 9.6, rise: CRANE_Y - GANTRY_Y, width: 1.6, z: -32,
  footX: -84.8, headX: -75.2,
});
/** The runway walkway between the flight head and the cab, at CRANE_Y. */
export const CRANE_WALK = Object.freeze({ x: -74.4, z0: -32, z1: -24, w: 2.4 });
/**
 * Signal post beside the blast door, off the north catwalk.
 *
 * `z` is -94.5 and not the -99 first drafted, and the reason is arithmetic
 * rather than composition: the north catwalk's inboard edge is at
 * `GANTRY_Z0` = -101.6, the post stands 3.2 m above the catwalk, and a flight
 * that gains 3.2 m needs about 6 m of run at a walkable pitch. A post at -99
 * left 0.9 m between the catwalk edge and the platform, so the flight ran
 * UNDER the platform for its whole length and the reach probe reported the
 * viewpoint as unreachable.
 */
export const SIGNAL_POST = Object.freeze({ x: 26, y: 11.2, z: -94.5 });
/** Half-depth of the signal-post platform, and the run of the flight to it. */
export const SIGNAL_POST_HD = 1.7;
export const SIGNAL_RUN = Object.freeze({ z0: -102.2, z1: -96.0 });
/**
 * Tarp-covered spares pile, under the crane bridge and under the cab.
 *
 * `y` is the TOP of the stack, which is what `Parkour._softLandingAt` measures
 * a landing against. `x` is 4.1 m from the cab's launch point and not the 6.6
 * first drafted: the catch radius is 6.5, so at 6.6 the leap of faith landed
 * one decimetre outside the only thing in the yard that would have caught it.
 * The test that found it quotes both numbers, because "close enough" is how a
 * 13 m drop becomes a death.
 */
export const SPARES_PILE = Object.freeze({ x: -64.5, y: 2.3, z: -24, r: 6.5 });

/* ------------------------------------------------------------------ */
/* THE BAY MOUTH                                                       */
/* ------------------------------------------------------------------ */

/**
 * The whole north end is a hole now.
 *
 * There WAS a blast door here — two leaves, sealed, `LAUNCHES: 000` over the
 * top of it. It is gone, and it is the single largest change in this world,
 * because it is the one the verdict was actually about. A shed with a shut
 * door at the end of it is a room; a bay whose end wall is 164 m of open
 * vacuum with piers running out through it and a planet hanging off the port
 * bow is a place you can see out of. That also fixes the darkness complaint
 * from the other side: contrast needs something bright in frame, and a lit
 * void behind a dark structure gives every silhouette in the bay an edge that
 * no amount of extra worklight can buy.
 *
 * `MOUTH_HW` is 4 m inside the side walls so the corner returns still carry
 * the perimeter catwalk and the crane runway round the north end.
 * `MOUTH_Y1` leaves a 2.2 m lintel under the roof plate for the header truss
 * and the field coils.
 */
export const MOUTH_Z = YARD_Z0;              // -104
export const MOUTH_HW = YARD_X - 4;          // 82
export const MOUTH_Y1 = ROOF_Y - 2.4;        // 23.6

/**
 * Where the roof plate stops and the LAUNCH WELL begins.
 *
 * North of this line the bay has structure and no lid: portal frames,
 * rafters, purlins and the crane runway all carry on, and between them there
 * is starfield. It is on the 12 m bay pitch (`-34` is the frame line between
 * chainage -30 and -42), because a roof that ended between two rafters would
 * be a plate with nothing holding its edge up.
 *
 * 70 m of open well against 138 m of shed: enough that the aperture reads as
 * tall from the apron and that the walk north has a moment where the ceiling
 * runs out, and not so much that the yard stops being a shed.
 */
export const ROOF_CUT_Z = -34;

/**
 * The threshold balustrade, and why it is a real collider.
 *
 * Past `MOUTH_Z` there is no ground except the piers. A player who walks north
 * between two piers walks off a 164 m ledge into hard vacuum — `Unstuck`
 * rescues them below `bounds.min.y`, but a world that relies on the rescue
 * system as its edge treatment is a world with a hole in it. So the mouth
 * threshold carries a solid balustrade for its whole width with a GATE at each
 * pier: over `CONFIG.player.stepHeight` 0.45 so it cannot be walked over, and
 * glazed above head height so it does not wall the view it exists to guard.
 *
 * ── 1.15 m WAS NOT A BARRIER, AND ONLY A WALK EVER TESTED IT ─────────────
 * Measured in a real boot, ten x positions 16 m inside the bay:
 *
 *   walk          stopped at z -103.2 at every one of them.        correct
 *   jump          stopped at every one of them.                    correct
 *   sprint+jump   OVER, at ten of ten, landing at y -30 in the void.
 *
 * The arithmetic nobody had done: `Player#jumpApex` on a world that publishes
 * no gravity is 0.931 m, `Parkour.LEAP_LIFT` is 1.12, and a leap's apex is the
 * standing apex times the SQUARE of that — 1.168 m. Against a 1.15 m rail the
 * gate was 2 centimetres, in the wrong direction. The comment here used to say
 * 1.15 was "under the 1.55 m a mantle needs"; `Climb.MIN_RISE_GROUND` is 1.0
 * and `MAX_RISE` is 2.4, so 1.15 was inside the mantle band as well.
 *
 * So the height is DERIVED now and no longer typed. The screen has to clear the
 * running leap AND the mantle reach, and the solid part below it stays at 1.15
 * because that is the part that reads as a kerb from the apron.
 *
 * `CONFIG` is the second import this file has ever taken, and it is the same
 * kind as the first: a number the yard is dimensioned off that is authored
 * somewhere else. Typing 2.7 here instead is how the rail and the player's legs
 * get out of step again the day the jump is retuned.
 */
export const MOUTH_KERB_H = 1.15;
/** `Parkour.LEAP_LIFT`. @see MOUTH_SCREEN_H */
const LEAP_LIFT = 1.12;
/** `Climb.MAX_RISE` — how far a pair of arms reaches. Does not scale. */
const MANTLE_MAX = 2.4;
/** The standing apex on a world that publishes no gravity, which the yard is. */
const STAND_APEX = (PLAYER.jumpVelocity * PLAYER.jumpVelocity) / (2 * -PLAYER.gravity);
/** The running leap's apex: the standing apex times LEAP_LIFT squared. */
export const MOUTH_LEAP_APEX = STAND_APEX * LEAP_LIFT * LEAP_LIFT;
/**
 * Top of the glazed screen over the balustrade, above `DECK_Y`.
 *
 * ── THE TWO REACHES ADD, and that is the number ──────────────────────────
 * The first version of this took the LARGER of "leap plus head room" and "mantle
 * plus head room" — 2.70 m — and driving it held at twelve inputs out of twelve,
 * including nine seconds of held-Space free climbing. It held for a reason that
 * is not in this file: the mouth collider is 0.5 m deep, and there is nowhere on
 * top of half a metre of rail to put a body.
 *
 * The same 2.70 m rule applied to Shoal's shore, whose posts are 2.2 m square
 * and therefore have standable tops, was crossed on six bearings out of eight —
 * and the trajectories show the body's peak was the POST TOP plus one standing
 * jump. `Player` offers the mantle on the JUMP PRESS and `Climb._probe` measures
 * the rise from the FEET, so a body that jumps first mantles a ledge one apex
 * higher. Jump, press jump again at the top of the arc, and the real reach is
 *
 *      leap apex  +  MAX_RISE
 *
 * So this is that sum plus head room — 3.90 m — rather than the 2.70 m that
 * happened to survive because this particular rail is thin. A barrier that holds
 * for a reason recorded in another file's constant is a barrier waiting for that
 * constant to move.
 *
 * 1.15 m of solid kerb and 2.75 m of glass, in a 23.6 m aperture: 16% of the
 * opening, and you see the piers, the ships and the starfield through all of it.
 */
export const MOUTH_SCREEN_H = MOUTH_LEAP_APEX + MANTLE_MAX + 0.35;

/* ------------------------------------------------------------------ */
/* THE PIERS                                                           */
/* ------------------------------------------------------------------ */

/**
 * Five piers, running out of the mouth into the void.
 *
 * ── Anatomy ───────────────────────────────────────────────────────────────
 * Each one is a SPINE and a HEAD. The spine is a narrow walkway — 6.8 m wide,
 * railed both sides, nothing under it — that runs `spine` metres from the
 * mouth threshold out into the dark; that is the "walking a gangway over
 * nothing" the brief asks for, and it is narrow on purpose. The head is the
 * pad at the far end that the ship actually sits on: `hw` x `hd`, wide enough
 * to hold a cradle, a boarding apron, the ramp foot and a service stack.
 *
 * ── Why the lengths are staggered ─────────────────────────────────────────
 * Five piers of one length is a comb. Staggered tips give the mouth a
 * silhouette that reads as depth from inside the bay, which is the only cue
 * for distance the player gets out there — there is no fog in vacuum and no
 * ground plane to measure against.
 *
 * ── Berth Zero ────────────────────────────────────────────────────────────
 * `dock: true`, at x 0, the longest of the five and the only empty one. The
 * keel line has run down the middle of this world since it was a survey pad;
 * it now runs straight out of the mouth and down this pier to a vacant
 * docking cradle with the launch portal standing on it. Coming home has a
 * destination, and from the apron 200 m away the thing the whole yard points
 * at is an empty berth with the stars behind it.
 *
 * @typedef {{ id:string, name:string, x:number, spine:number, hw:number,
 *             hd:number, ship:(string|null), dock?:boolean, works?:boolean }}
 */
export const PIERS = Object.freeze([
  Object.freeze({ id: 'P1', name: 'PIER ONE', x: -68, spine: 26, hw: 11, hd: 13, ship: 'kestrel' }),
  Object.freeze({ id: 'P2', name: 'PIER TWO', x: -34, spine: 36, hw: 12, hd: 15, ship: 'pike' }),
  Object.freeze({ id: 'P0', name: 'BERTH ZERO', x: 0, spine: 46, hw: 15, hd: 15, ship: null, dock: true }),
  /* Nineteen metres in the half-width, the widest of the five, because the
   * Dray boards off a ramp that comes down to the deck: her ramp foot lands
   * 13.6 m out along her own local X and the pad has to hold it with room to
   * stand behind it. See `BERTHS`' note on her apron. */
  Object.freeze({ id: 'P3', name: 'PIER THREE', x: 34, spine: 32, hw: 19, hd: 18, ship: 'dray' }),
  Object.freeze({ id: 'P4', name: 'PIER FOUR', x: 68, spine: 22, hw: 12, hd: 12, ship: null, works: true }),
]);

/** Half-width of a pier spine walkway. 3.4: two abreast, and no more. */
export const PIER_HW = 3.4;
/** Structural depth of a pier deck, drawn under it so a pier has a soffit. */
export const PIER_T = 1.1;
/**
 * Gate half-width in the mouth balustrade, per pier — NARROWER than the pier.
 *
 * It was `PIER_HW + 0.3`, on the reasoning that a gate wants a little clearance
 * either side of the thing it opens onto. What that actually produced was a
 * 0.3 m slot of open lip on each side of all five gates: the balustrade
 * stopped at 3.7 and the pier deck stopped at 3.4, so thirty centimetres of
 * every gate opened onto vacuum. `dock-reach`'s lip march found twenty such
 * stations at 0.25 m spacing.
 *
 * 3.3 overlaps the pier deck by 100 mm at each jamb, so the balustrade dies
 * into the pier's own side rail with no gap between them at all.
 */
export const PIER_GATE_HW = PIER_HW - 0.1;

/** Head-pad centre Z of a pier: the mouth, less the spine, less half the pad. */
export function pierHeadZ(p) {
  return MOUTH_Z - p.spine - p.hd;
}
/** The pad's near (bay-side) and far edges. */
export function pierPad(p) {
  const c = pierHeadZ(p);
  return { z0: c + p.hd, z1: c - p.hd, cz: c };
}
/** Pier by id, and the pier a berth stands on. */
export function pierOf(id) {
  return PIERS.find((p) => p.id === id) ?? null;
}

/* ------------------------------------------------------------------ */
/* The void the piers stand in                                         */
/* ------------------------------------------------------------------ */

/**
 * THE VOID BEYOND THE MOUTH, AND IT IS THE SAME SKY AS THE ONE OUTSIDE.
 *
 * ── What was wrong ─────────────────────────────────────────────────────────
 * This table used to be three invented bodies - EMBER, CALDER and LODESTONE -
 * placed by eye so that the volcanic world sat prettily inside the aperture.
 * `space/Bodies.js` has five real ones, in different directions, with
 * different names. Measured from the two tables, outbound = -Z, right = +X:
 *
 *                 yard sky (invented)          space sky (one second later)
 *   volcanic      EMBER      20.0 left, 1.8 up   Cinder     13.9 left, 23.6 DOWN
 *   ringed giant  CALDER     23.1 RIGHT, 10.4 up Ceraunus   22.6 LEFT, 38.5 up
 *   third body    LODESTONE, a grey moon         Vitrine, an ice planet
 *   -             (nothing)                      Tessera, 72.3 right
 *   star          (absent)                       Erenmark, 139 behind
 *
 * So a player who lined the nose up on the red planet above the horizon to
 * port, flew through the mouth, and found it 25 degrees BELOW the horizon -
 * with the ringed giant teleported 46 degrees across the sky, the moon turned
 * into an ice world, a second moon appeared to starboard and a sun appeared
 * behind them. And it was renamed.
 *
 * ── What it is now ─────────────────────────────────────────────────────────
 * One derivation, so the two cannot drift. Each body keeps its TRUE BEARING
 * from the yard - the position vector is simply contracted toward the origin -
 * and its TRUE ANGULAR SIZE, because contracting position and radius by the
 * same factor `k` is exactly what `space/Scale.js` does per frame. Ranked by
 * true distance, the nearest body gets the nearest shell, so the painter order
 * the yard draws them in is the order they really are in.
 *
 * `k` is `d / D`, and it is BOTH the position scale and the model scale - the
 * whole system is uniformly shrunk per body, which is what makes the angular
 * size come out right without a second calculation to keep in step.
 *
 * The consequence is honest and it is worth stating: Cinder is 23.6 degrees
 * below the outbound axis, so it is NOT visible from the apron through a
 * 164 m mouth whose lower edge is the deck. You see it from a pier head, where
 * there is sky under your feet. That is the layout `space-scale.test.mjs`
 * pins - "out and down (Cinder)" is one of the five directions the player
 * asked for by name - and a hangar that lied about it was the bug.
 */

/**
 * The furthest a player can get from the origin in this world.
 *
 * The floor is x +/-86 by z -104..+58 and the piers run out to z -180, so the
 * corner of the reachable set is about 214 m from the origin; 260 is that with
 * a margin, and it is the number every shell below is sized against.
 */
export const VOID_REACH = 260;

/**
 * The starfield shell.
 *
 * 1500 and NOT 2200. `CONFIG.render.far` is 2000, so every point on a 2,200 m
 * shell was between 1,940 and 2,460 m from the player: the whole starfield sat
 * behind the far plane and NOT ONE STAR OF IT WAS EVER DRAWN. That is
 * arithmetic rather than a screenshot, which is how it survived three visual
 * reviews of a world whose own header calls the field "4,200 points on a
 * 2,200 m shell".
 *
 * At 1500 the furthest point is 1,760 m and all of it renders.
 */
export const STAR_SHELL = 1500;

/**
 * Proxy shells the bodies hang on, nearest TRUE body first.
 *
 * 1300 at the far end and not further, because a body is drawn wider than its
 * own sphere: Ceraunus' ring reaches 2.28 radii, so at 1,200 m its outer edge
 * is 1,624 m out and 1,884 m from a player standing at the far end of Berth
 * Zero. A ring whose far half is cut off in a perfect straight line is the
 * failure `space/Scale.js` calls out by name, and it is the one this band is
 * sized to avoid. `dock-sky.test.mjs` asserts the whole extent of every body,
 * ring and corona included.
 */
export const VOID_NEAR = 900;
export const VOID_FAR = 1300;

/**
 * THE YARD'S MESH CEILING, DERIVED FROM THE SKY IT DRAWS.
 *
 * `BODIES` below hangs EVERY entry of `SPACE_BODIES` on a proxy shell — it does
 * not pick a subset — so the yard's draw-call count is a function of how many
 * bodies the solar system has. Phase 1 had five and the ceiling was hand-set to
 * 156; Phase 2 has twelve, which measured 165, and the hand-set number became a
 * failure with nothing to say which of the two was wrong.
 *
 * It lives HERE, in production source, rather than in a test, because two tests
 * were each carrying their own copy of it: `dock-hulls.test.mjs` asserted 156
 * and `dock-interiors.test.mjs` asserted 156 again with a comment saying it
 * "tracks dock-hulls' own ceiling". Two copies of one fact is the defect this
 * project keeps writing down, and the second copy is always the one that goes
 * stale. One source, two readers.
 *
 * The arithmetic, all measured:
 *   BASE      the yard with no bodies at all       150 − 5 × 2.1 = 139.5
 *   PER_BODY  one sphere, plus a limb halo where    2.1
 *             there is air (6 of the 12 bodies)
 *   MARGIN    the same slack the hand-set 156       6
 *             carried over its measured 150
 *
 * `PER_BODY` is the number that must stay honest: if a body ever costs more
 * than a sphere and a halo the ceiling stops tracking reality, and the tests
 * that read this will fail — which is what they are for.
 *
 * @returns {number} the most meshes `world.group` may hold
 */
export function meshCeiling() {
  const BASE = 150 - 5 * 2.1;
  const PER_BODY = 2.1;
  const MARGIN = 6;
  return Math.ceil(BASE + PER_BODY * BODIES.length + MARGIN);
}

/**
 * The absolute frame budget, which no number of planets may exceed.
 *
 * 220 draws with the portal system, the NPCs and the HUD still to pay for. 22
 * of the yard's meshes are the flights' hidden ramp proxies, which
 * `projectObject` never pushes, so the comparison is `meshes - 22`.
 */
export const FRAME_DRAW_BUDGET = 220;
export const HIDDEN_RAMP_PROXIES = 22;

export const BODIES = Object.freeze(
  SPACE_BODIES
    .map((body) => ({ body, D: Math.hypot(body.position[0], body.position[1], body.position[2]) }))
    .sort((a, c) => a.D - c.D)
    .map((row, i, all) => {
      const t = all.length > 1 ? i / (all.length - 1) : 0;
      const d = VOID_NEAR + (VOID_FAR - VOID_NEAR) * t;
      const k = d / row.D;
      return Object.freeze({
        /** The `space/Bodies.js` descriptor, verbatim - shaders read it. */
        body: row.body,
        id: row.body.id,
        name: row.body.name,
        kind: row.body.kind,
        /** Proxy centre: the true position contracted by `k`. */
        x: row.body.position[0] * k,
        y: row.body.position[1] * k,
        z: row.body.position[2] * k,
        /** Drawn radius, and the uniform scale that produces it. */
        r: row.body.radius * k,
        scale: k,
        /** Rank by true distance. Nearest paints last. */
        rank: i,
        trueRange: row.D,
      });
    })
);

/* ------------------------------------------------------------------ */
/* Derived helpers                                                     */
/* ------------------------------------------------------------------ */

/** Is this XZ inside the trench slot (i.e. over open air or over grating)? */
export function overTrench(x, z) {
  if (Math.abs(x) > TRENCH_HW) return false;
  for (const [z0, z1] of TRENCH_RUNS) if (z >= z0 && z <= z1) return true;
  return false;
}

/** Is this XZ inside one of the open bays (no grating overhead)? */
export function inTrenchBay(x, z) {
  if (Math.abs(x) > TRENCH_HW) return false;
  for (const b of TRENCH_BAYS) if (z >= b.z0 && z <= b.z1) return true;
  return false;
}

/** Berth anchor by ship id. */
export function berthOf(id) {
  return BERTHS.find((b) => b.id === id) ?? null;
}

/** Total floor area, m². Quoted in the build log so a resize is visible. */
export const FLOOR_AREA = YARD_X * 2 * (YARD_Z1 - YARD_Z0);
