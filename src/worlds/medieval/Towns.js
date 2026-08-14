/**
 * The five towns of the outer ring: what stands where, and what is inside it.
 *
 * Nothing in this file may import `three` or touch the DOM. That is not a
 * stylistic rule here, it is the whole design: a town is a list of rectangles
 * on a heightfield with a list of rooms inside each rectangle, and every way
 * that can be wrong is arithmetic.
 *
 *   - a building whose footprint straddles 3 m of relief floats or buries;
 *   - a building whose footprint overlaps its neighbour's leaves two roofs
 *     interpenetrating and no error anywhere;
 *   - a building that sits on the road leaves the road running through the
 *     parlour;
 *   - a staircase whose steps do not sum to the storey height ends 20 cm below
 *     the floor it is supposed to reach, which is invisible in a screenshot
 *     and fatal to a player;
 *   - a ground storey with 1.9 m of headroom is a room you cannot stand up in.
 *
 * None of those need a renderer to find, and `medieval-towns.test.mjs` finds
 * all of them. `MedievalWorld._buildTowns` consumes exactly this table and
 * exactly `interiorPlan` below, so the thing the tests check is the thing that
 * gets built.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT `_house`
 *
 * `_house` builds Aldermoor's vernacular - a daub box on a rubble plinth with
 * an oak frame applied to its faces and a thatch or slate gable over it - and
 * it builds it very well. It is also the ONLY thing it builds. Five towns
 * drawn with it would be five copies of Aldermoor at different coordinates,
 * which is the specific failure this phase exists to avoid: a player has to
 * know which town they are standing in from the silhouette alone.
 *
 * So `_shell` in `MedievalWorld` is a second, parameterised builder - wall
 * material, roof form, storey count, window type, whether the ground floor is
 * hollow - and the FIVE VOCABULARIES below are what make the towns different
 * from each other:
 *
 *   Reedwater   plank walls, reed roofs, and half the settlement standing on
 *               posts over open water, reached by jetty rather than by street.
 *   Grimscar    rubble stone under slate, sooted dark, stepped up a bench with
 *               a headframe and a spoil tip instead of a market.
 *   St Ceolwine ashlar under lead-grey slate, four ranges round a garth, all
 *               of it inside a wall, none of it above the combe rim.
 *   Blackmarch  horizontal log walls under split shingle, inside a palisade,
 *               on a bluff top with nothing else on it.
 *   Fenwick     two-storey jettied burgage plots with shop fronts, packed
 *               gable-end-on along three converging streets.
 *
 * `_house`'s own plots are untouched. Aldermoor still looks like Aldermoor.
 */

import { medievalHeight, riverZ, WATER_Y, rectDist } from '../terrain/MedievalHeight.js';

/* ------------------------------------------------------------------ */
/* Interior arithmetic                                                 */
/* ------------------------------------------------------------------ */

/**
 * Clear height of a DOMESTIC ground storey, floor surface to ceiling underside.
 *
 * 2.85 m rather than something tighter because the player capsule is 1.75 m
 * and the camera sits near the top of it: at 2.4 m of clear height the ceiling
 * is inside the near plane whenever you look up, which reads as a crawlspace.
 * `_house`'s cottages get away with 2.75 because their ceiling is a plank deck
 * with joists under it and the eye reads the joists as the ceiling line; the
 * shells here carry the same detail, so the same rule applies with a little
 * more room for the halls.
 *
 * Not every shell is domestic. See `storeyClear`, which is what `interiorPlan`
 * actually asks - this is the answer it gets for a house.
 */
export const GROUND_H = 2.85;
/** Clear height of an upper storey. Lower, as every real one is. */
export const UPPER_H = 2.55;
/** Thickness of a floor deck between storeys, including its joists. */
export const FLOOR_T = 0.28;
/** Interior floor surface above the shell's base, metres. */
export const FLOOR_RISE = 0.34;
/** Clear width of a doorway. */
export const DOOR_W = 1.62;
/** Clear height of a doorway. */
export const DOOR_H = 2.18;
/** Wall thickness for a hollowed ground storey. */
export const WALL_T = 0.44;

/**
 * The tallest step the player's step-up probe will climb.
 *
 * 0.45 in `Player`, so this is 0.42 with the margin on the safe side: a stair
 * that is exactly at the limit fails the moment the player is walking up it at
 * an angle, because the probe is cast along the movement direction and a
 * diagonal approach lengthens the horizontal run without shortening the rise.
 */
export const STAIR_RISE_MAX = 0.42;
/** Going of one step. 0.30 is a real medieval stair - steep, but walkable. */
export const STAIR_TREAD = 0.30;
/** Width of a stair flight, and therefore of the well it needs in the deck. */
export const STAIR_W = 1.15;

/**
 * A straight flight from `fromY` to `toY`.
 *
 * The step count is derived from the rise, never authored, and the rise is
 * then derived BACK from the count - which is the only way `n * rise` can be
 * exactly `toY - fromY`. Authoring a rise and a count independently is how a
 * staircase ends up 17 cm short of the floor it serves, and that gap is
 * invisible from anywhere except standing on it.
 *
 * @returns {{steps:number, rise:number, tread:number, run:number,
 *            fromY:number, toY:number}}
 */
export function stairFlight(fromY, toY) {
  const climb = toY - fromY;
  const steps = Math.max(1, Math.ceil(climb / STAIR_RISE_MAX));
  return {
    steps,
    rise: climb / steps,
    tread: STAIR_TREAD,
    run: steps * STAIR_TREAD,
    fromY,
    toY,
  };
}

/**
 * Everything the interior of one building is, in the building's own frame.
 *
 * Y is measured from the shell's base (the top of its plinth, which is where
 * `_shell` puts `baseY`); X and Z from the building's centre, with the door on
 * +Z. `MedievalWorld._shell` builds from this and nothing else, so a test that
 * reads it is reading the room that gets built.
 *
 * @param {{w:number,d:number,storeys:number,enterable?:boolean}} b
 */
export function interiorPlan(b) {
  const inner = { hx: b.w / 2 - WALL_T, hz: b.d / 2 - WALL_T };
  /* The flights run along one side wall, and they ALTERNATE direction.
   *
   * The first version put every flight in the same well climbing the same
   * way, which is fine in a two-storey house and wrong in a three-storey
   * tower: the second flight then sits directly over the first, and a
   * player halfway up the first one walks into the underside of the second
   * at head height. `medieval-towns.test.mjs` walks every tread with a
   * 0.9 m headroom probe, which is how that was found - it is invisible
   * otherwise, and "the stairs reach the floor above" was true of both
   * flights taken separately.
   *
   * Alternating turns the well into a dog-leg: flight 0 climbs from the
   * back wall toward the door, flight 1 climbs from the front wall back
   * again. It needs `2 * run` of depth plus a landing, which every
   * multi-storey shell here has by a wide margin - and the test asserts
   * that rather than trusting it, because a shell too shallow for the
   * dog-leg fails in exactly the same silent way.
   */
  const stairX = b.w / 2 - WALL_T - STAIR_W / 2 - 0.1;
  const floors = [];
  const stairs = [];
  let y = FLOOR_RISE;
  for (let s = 0; s < b.storeys; s++) {
    const clear = storeyClear(b, s);
    floors.push({ storey: s, floorY: y, ceilY: y + clear, clear });
    if (s < b.storeys - 1) {
      const next = y + clear + FLOOR_T;
      const f = stairFlight(y, next);
      f.storey = s;
      f.x = stairX;
      f.dir = s % 2 === 0 ? 1 : -1;
      f.z0 = f.dir > 0 ? -inner.hz : inner.hz;
      /** The well cut in the deck this flight arrives at, as a local rect. */
      f.well = {
        x0: stairX - STAIR_W / 2 - 0.12,
        x1: stairX + STAIR_W / 2 + 0.12,
        z0: f.dir > 0 ? f.z0 - 0.1 : f.z0 - f.run - 0.5,
        z1: f.dir > 0 ? f.z0 + f.run + 0.5 : f.z0 + 0.1,
      };
      stairs.push(f);
      y = next;
    }
  }
  const top = floors[floors.length - 1];
  return {
    floors,
    stairs,
    /** Local Y of the underside of the roof structure. */
    roofY: top.ceilY,
    door: { w: DOOR_W, h: DOOR_H, z: b.d / 2, y: FLOOR_RISE },
    /** Interior clear footprint, half-extents. */
    inner,
    /**
     * A point every furnishing pass must leave clear.
     *
     * Just inside the door, on the centreline. Without a declared one the
     * only way to know whether a room can be stood in is to probe it and
     * hope the probe missed the furniture - which is not a test, it is a
     * coincidence. The abbey church found this: a nave with two ranks of
     * choir stalls is completely correct and completely fills the middle of
     * the room, so an arbitrary probe lands on a bench and reports a
     * building nobody can enter.
     *
     * 0.45 of the half-depth rather than the centre, because the centre of
     * a hall is where the table goes.
     */
    standing: { x: 0, z: inner.hz * 0.45 },
    /** The first flight, for callers that only need to know where it is. */
    stairAt: stairs.length ? { x: stairs[0].x, z0: stairs[0].z0, dir: stairs[0].dir } : null,
    wallT: WALL_T,
  };
}

/**
 * Kinds that are church buildings, and therefore never carry a domestic flue.
 *
 * A nave is not heated. It has no hearth, no kitchen and nothing to burn, and
 * the one thing that reads instantly as "somebody lives here" on a roofline is
 * a rubble stack - which is why the abbey church shipped with one and why it
 * was the first thing a reviewer standing in the garth noticed. `_shell` was
 * fitting a chimney to everything that was not on stilts, flat-roofed, a barn
 * or a shed, and a 34 m ashlar church under lead is none of those.
 */
export const ECCLESIASTICAL = new Set([
  'abbeychurch', 'chapel', 'belltower', 'chapterhouse',
]);

/**
 * Whether a shell gets a chimney.
 *
 * A predicate rather than a condition inlined in `_shell`, because "which
 * buildings have a hearth" is a fact about the TABLE and it is the kind of
 * fact that is invisible in a screenshot taken from anywhere except the one
 * angle that puts the ridge against the sky.
 */
export function hasChimney(b) {
  if (b.stilt) return false;
  if (b.roof === 'flat' || b.roof === 'none') return false;
  if (b.kind === 'barn' || b.kind === 'shed') return false;
  return !ECCLESIASTICAL.has(b.kind);
}

/**
 * How much of its own clear span an ecclesiastical volume stands to.
 *
 * 0.8 is deliberately modest - a real abbey nave is one and a half to two
 * times its width to the vault - and it is what keeps St Ceolwine's ridge
 * within a couple of metres of the bell tower standing four metres off its
 * west end. Raising it further is a decision about the SKYLINE, not about the
 * room, and the tower is what pays for it.
 */
export const ECCLESIASTICAL_SPAN = 0.8;
/**
 * Ceiling on the rule above.
 *
 * Nothing in the table reaches it - the abbey nave, the widest of them, comes
 * out at 8.90 - so it costs nothing today and stops a 30 m span authored later
 * from quietly building a cathedral over a town of cottages.
 */
export const ECCLESIASTICAL_H_MAX = 9.0;

/**
 * Clear height of one storey of a shell, floor surface to ceiling underside.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 * St Ceolwine's abbey church is 34 x 12 m and took `GROUND_H` like a cottage.
 * A raycast up from the middle of the nave floor hit `medieval:plank` at
 * 3.19 m - 2.85 m of clear height under an 11.1 m span, which is a corridor
 * with a boarded ceiling and not a nave. Worse, it propagated: the arcade
 * `_landmarkInterior` builds is derived FROM the clear height, so the piers
 * came out as 2.35 m drums that met the deck almost as soon as they left the
 * floor. Nothing was wrong anywhere; the storey height of a domestic
 * vernacular was simply being applied to a building that has no domestic
 * vernacular, because `interiorPlan` had only the one number to give.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 * An ecclesiastical volume takes its height from its own SPAN. A nave is
 * proportioned rather than dimensioned, and a proportion is the one thing that
 * is right for the 11.1 m abbey nave, for the 5.5 m chapel at Blackmarch and
 * for the belfry stage of a 9 m tower without any of the three being a special
 * case in this file. `ECCLESIASTICAL` already exists to say which buildings
 * are churches - it is what stops them growing chimneys - so it is the hook
 * here too, and a chapel added to the table later is right by construction.
 *
 * ── Why only the TOP storey ────────────────────────────────────────────────
 * A tower is stacked chambers with the tall one on top, not three tall ones:
 * the ringing chamber and the room under it are rooms. That is also the half
 * of this that could break something. A flight climbs from storey s to s+1
 * through storey s's clear height, so raising a LOWER storey lengthens the
 * flight that serves it - and at 0.30 m of going per step, the 9 x 9 m bell
 * tower runs out of depth for its dog-leg long before it runs out of wall.
 * Raising only the last storey leaves every staircase in the world at exactly
 * the run it already had, which is why nothing here can strand a stair.
 *
 * @param {{kind?:string, w:number, d:number, storeys?:number}} b
 * @param {number} storey 0-based
 */
export function storeyClear(b, storey) {
  const storeys = b.storeys ?? 1;
  const domestic = storey === 0 ? GROUND_H : UPPER_H;
  if (!ECCLESIASTICAL.has(b.kind) || storey !== storeys - 1) return domestic;
  // The span the roof has to cross, inside the walls: the short axis of the
  // plan. A 34 m nave is not 34 m tall, it is as tall as it is WIDE.
  const span = Math.min(b.w, b.d) - 2 * WALL_T;
  return Math.max(domestic, Math.min(ECCLESIASTICAL_H_MAX, span * ECCLESIASTICAL_SPAN));
}

/**
 * How a plinth is broken into courses, top course first.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 * Fourteen shells carry more than 1.6 m of plinth and five carry over 2.1 m -
 * `rw-s8`'s boat shed stands on 2.63 m of it under a 6.6 m building - and they
 * read as tower bases rather than as foundations. The height itself is not
 * the error and cannot be removed: a shell sets its base to the highest corner
 * of its own footprint so no corner floats, so the masonry between the base and
 * the ground at the low corner is exactly the relief under the footprint, and
 * the only ways to have less of it are to move the building or to cut the
 * hill. The boat shed is on the edge of a pool; it is where it needs to be.
 *
 * ── What actually reads as a tower ─────────────────────────────────────────
 * A single flush face taken straight down. Every real footing on falling
 * ground is BATTERED - it steps out as it goes down, in courses, because that
 * is how you stop a wall on soft ground from rotating out - and the stepped
 * shadow line under each course is the whole difference between "the bottom of
 * a tower" and "the thing this building is standing on". So the plinth becomes
 * a stack of courses, each oversailing the one above it, and the number of
 * courses follows the height rather than being authored.
 *
 * Returned as data, and as a pure function, because "a 2.6 m plinth is broken
 * into courses" is checkable and "the plinth looks better now" is not.
 *
 * @param {number} plinth total plinth height, metres
 * @returns {Array<{y0:number, y1:number, out:number}>} `y0`/`y1` are depths
 *   BELOW the shell's base (y0 < y1, both positive), `out` the oversail per side
 */
export function plinthCourses(plinth) {
  /* One course per 0.9 m. Below that a footing has one course, which is what a
   * shell on level ground has always had and what it should keep having. */
  const n = Math.max(1, Math.min(4, Math.ceil(plinth / 0.9)));
  const h = plinth / n;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ y0: i * h, y1: (i + 1) * h, out: 0.06 + i * 0.105 });
  }
  return out;
}

/** Total height of a shell above its base, roof apex included. */
export function shellHeight(b) {
  const plan = interiorPlan(b);
  const pitch = b.roof === 'flat' || b.roof === 'none' ? 0.4 : Math.min(b.d, b.w) * 0.42;
  return plan.roofY + pitch;
}

/* ------------------------------------------------------------------ */
/* Layout helpers                                                      */
/* ------------------------------------------------------------------ */

let _uid = 0;
/** One building. Everything not given takes the vernacular's default. */
function bld(o) {
  return {
    id: o.id || `b${++_uid}`,
    kind: o.kind || 'house',
    x: o.x, z: o.z, yaw: o.yaw ?? 0,
    w: o.w, d: o.d,
    storeys: o.storeys ?? 1,
    wall: o.wall || 'daub',
    roof: o.roof || 'thatch',
    windows: o.windows || 'shutter',
    enterable: !!o.enterable,
    lit: o.lit ?? false,
    landmark: !!o.landmark,
    jetty: !!o.jetty,
    stilt: !!o.stilt,
    deck: o.deck ?? null,
    label: o.label || null,
    tint: o.tint ?? null,
  };
}

/**
 * A row of buildings along a straight street.
 *
 * `side` is +1 or -1 and sets which way the doors face, so a street is two
 * calls with the same line and opposite sides. The gap between plots is
 * authored rather than derived because burgage frontages are NOT evenly
 * spaced - the whole character of a market street is that some plots are wide
 * and some are slivers - so `jitter` walks the spacing by a repeatable amount.
 */
function row(o) {
  const out = [];
  const { x0, z0, x1, z1, n } = o;
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  const ux = dx / len;
  const uz = dz / len;
  // Street normal; the doors look back along it toward the carriageway.
  const nx = -uz * o.side;
  const nz = ux * o.side;
  const yaw = Math.atan2(nx, nz);
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const jit = o.jitter ? Math.sin(i * 2.399 + o.seed) * o.jitter : 0;
    const s = t * len + jit;
    const w = o.w + (o.wVary ? Math.sin(i * 1.7 + o.seed * 0.7) * o.wVary : 0);
    const d = o.d + (o.dVary ? Math.cos(i * 2.1 + o.seed * 0.4) * o.dVary : 0);
    const back = o.offset + d / 2;
    out.push(bld({
      id: `${o.id}${i}`,
      kind: o.kind, wall: o.wall, roof: o.roof, windows: o.windows,
      storeys: typeof o.storeys === 'function' ? o.storeys(i) : o.storeys,
      enterable: typeof o.enterable === 'function' ? o.enterable(i) : o.enterable,
      lit: typeof o.lit === 'function' ? o.lit(i) : o.lit,
      jetty: o.jetty,
      x: x0 + ux * s - nx * back,
      z: z0 + uz * s - nz * back,
      yaw,
      w, d,
    }));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 1. REEDWATER - the stilt village on the pool                        */
/* ------------------------------------------------------------------ */

/**
 * Deck height of everything Reedwater builds over water.
 *
 * One number for the whole village, because a jetty network at three different
 * levels is a set of trip hazards rather than a walkway. 2.55 m is 1.70 m
 * above the pool surface at 0.85 - a working freeboard for a fishing stage,
 * high enough that the posts read as posts and low enough to step down into a
 * boat - and it meets the south bank at z = 117, which is where the ramp is.
 */
export const REEDWATER_DECK = 2.55;

const REEDWATER_STILTS = [
  bld({ id: 'rw-hall', kind: 'stilthall', x: -368, z: 98, yaw: 0.12, w: 10.5, d: 8.4, storeys: 2, wall: 'plank', roof: 'thatch', windows: 'shutter', enterable: true, lit: true, landmark: true, stilt: true, deck: REEDWATER_DECK, label: 'The Stilthouse' }),
  bld({ id: 'rw-s1', kind: 'stilt', x: -382, z: 103, yaw: -0.18, w: 6.2, d: 5.2, wall: 'plank', roof: 'thatch', enterable: true, lit: true, stilt: true, deck: REEDWATER_DECK }),
  bld({ id: 'rw-s2', kind: 'stilt', x: -356, z: 88, yaw: 0.26, w: 5.8, d: 5.0, wall: 'plank', roof: 'thatch', stilt: true, deck: REEDWATER_DECK }),
  bld({ id: 'rw-s3', kind: 'stilt', x: -346, z: 85, yaw: -0.1, w: 6.0, d: 5.0, wall: 'plank', roof: 'thatch', enterable: true, stilt: true, deck: REEDWATER_DECK }),
  bld({ id: 'rw-s4', kind: 'stilt', x: -334, z: 79, yaw: 0.34, w: 5.4, d: 4.6, wall: 'plank', roof: 'thatch', lit: true, stilt: true, deck: REEDWATER_DECK }),
  bld({ id: 'rw-s5', kind: 'stilt', x: -392, z: 110, yaw: 0.08, w: 5.6, d: 4.8, wall: 'plank', roof: 'thatch', enterable: true, stilt: true, deck: REEDWATER_DECK }),
  bld({ id: 'rw-s6', kind: 'stilt', x: -372, z: 87, yaw: -0.3, w: 5.2, d: 4.4, wall: 'plank', roof: 'thatch', stilt: true, deck: REEDWATER_DECK }),
];

/**
 * The jetty network, as centrelines in world metres.
 *
 * `spine` runs from the bank ramp out past the Stilthouse; the spurs reach the
 * huts. Everything over water is reached along these and nothing else, which
 * is the point: arriving at Reedwater should mean stepping off the ground.
 */
export const REEDWATER_JETTIES = [
  { id: 'spine', w: 3.2, pts: [[-360, 118], [-362, 110], [-366, 103], [-368, 94], [-370, 86]] },
  { id: 'west', w: 2.4, pts: [[-366, 103], [-376, 104], [-386, 107], [-392, 111]] },
  { id: 'east', w: 2.4, pts: [[-368, 94], [-356, 91], [-346, 87], [-337, 83]] },
  { id: 'landing', w: 2.6, pts: [[-370, 86], [-374, 88], [-378, 90]] },
];

const REEDWATER_BANK = [
  // Waterside row, between the strand road and the shore.
  bld({ id: 'rw-n1', kind: 'netloft', x: -330, z: 103, yaw: 3.0, w: 7.0, d: 5.6, wall: 'plank', roof: 'thatch', enterable: true }),
  bld({ id: 'rw-n2', kind: 'house', x: -346, z: 106, yaw: 3.05, w: 7.4, d: 6.0, wall: 'plank', roof: 'thatch', enterable: true, lit: true }),
  bld({ id: 'rw-n3', kind: 'smokehouse', x: -372, z: 112, yaw: 3.1, w: 6.4, d: 5.6, wall: 'rubble', roof: 'thatch', windows: 'slit', enterable: true }),
  bld({ id: 'rw-n4', kind: 'house', x: -386, z: 118, yaw: 3.0, w: 7.0, d: 5.8, wall: 'plank', roof: 'thatch' }),
  // Landward row, above the road.
  bld({ id: 'rw-s7', kind: 'house', x: -330, z: 126, yaw: 0.1, w: 7.2, d: 6.0, wall: 'plank', roof: 'thatch', enterable: true, lit: true }),
  bld({ id: 'rw-s8', kind: 'boatshed', x: -346, z: 129, yaw: 0.14, w: 9.5, d: 6.6, wall: 'plank', roof: 'thatch', windows: 'none', enterable: true }),
  bld({ id: 'rw-s9', kind: 'house', x: -362, z: 133, yaw: 0.16, w: 7.0, d: 5.8, wall: 'plank', roof: 'thatch' }),
  bld({ id: 'rw-s10', kind: 'house', x: -378, z: 137, yaw: 0.18, w: 6.8, d: 5.6, wall: 'plank', roof: 'thatch', enterable: true }),
  bld({ id: 'rw-s11', kind: 'cooperage', x: -394, z: 140, yaw: 0.2, w: 8.0, d: 6.2, wall: 'plank', roof: 'thatch', enterable: true }),
];

/* ------------------------------------------------------------------ */
/* 2. GRIMSCAR - the mining town on the bench                          */
/* ------------------------------------------------------------------ */

/**
 * The bench is 32 m of walkable shelf between a 16 m face and a 10 m drop, so
 * Grimscar is one street and two rows, and it is organised the way a mine is:
 * the WORKING end at the south, where the adit goes into the face and the tip
 * goes over the edge, and the LIVING end at the north. The winding house
 * stands between them because that is what a winding house does.
 *
 * Doors face the street, which means the west row's doors are on world +X and
 * the east row's on world -X - so every window in the town looks either into
 * the scarp or out over a 10 m drop, and there is not one view along a street
 * to anywhere. That is the intent: a bench town is a corridor.
 */
const GRIMSCAR_WEST = row({
  id: 'gs-w', x0: -366, z0: -166, x1: -366, z1: -130, n: 4, side: -1,
  offset: 0, w: 7.6, d: 6.4, wVary: 0.5, dVary: 0.3, jitter: 0.6, seed: 3.1,
  kind: 'cottage', wall: 'rubble', roof: 'slate', windows: 'shutter',
  storeys: (i) => (i % 3 === 1 ? 2 : 1),
  enterable: (i) => i % 2 === 0,
  lit: (i) => i % 2 === 1,
});
const GRIMSCAR_EAST = row({
  id: 'gs-e', x0: -356, z0: -168, x1: -356, z1: -132, n: 4, side: 1,
  offset: 0, w: 7.4, d: 6.2, wVary: 0.5, dVary: 0.3, jitter: 1.0, seed: 5.7,
  kind: 'cottage', wall: 'rubble', roof: 'slate', windows: 'shutter',
  storeys: (i) => (i % 4 === 2 ? 2 : 1),
  enterable: (i) => i % 2 === 1,
  lit: (i) => i % 3 === 0,
});

/**
 * The working end.
 *
 * Everything here is inside z = -206..-172, and that is not a composition
 * choice - it is the only part of the bench that is flat enough. The shelf
 * falls 12 m across its 32 m width at z = -204 and 20 m at z = -212, so a
 * building put on the obvious-looking ground at the south end would stand on a
 * 38% cross-slope and need a three-metre plinth to do it. The tests bound the
 * plinth at 2.4 m of relief, which is what found this.
 */
const GRIMSCAR_WORKS = [
  bld({
    id: 'gs-winding', kind: 'windinghouse', label: 'The Winding House',
    x: -370, z: -190, yaw: Math.PI / 2, w: 12.0, d: 9.0, storeys: 2,
    wall: 'rubble', roof: 'slate', windows: 'slit',
    enterable: true, lit: true, landmark: true,
  }),
  bld({ id: 'gs-count', kind: 'counthouse', x: -352, z: -186, yaw: -Math.PI / 2, w: 8.6, d: 7.0, storeys: 2, wall: 'rubble', roof: 'slate', enterable: true, lit: true }),
  bld({ id: 'gs-smithy', kind: 'smithy', x: -352, z: -197, yaw: -Math.PI / 2, w: 8.0, d: 6.6, wall: 'rubble', roof: 'slate', windows: 'none', enterable: true, lit: true }),
  bld({ id: 'gs-sort', kind: 'shed', x: -368, z: -177, yaw: Math.PI / 2, w: 8.0, d: 6.0, wall: 'plank', roof: 'slate', windows: 'none' }),
  bld({ id: 'gs-powder', kind: 'store', x: -379, z: -176, yaw: Math.PI / 2, w: 5.0, d: 4.4, wall: 'rubble', roof: 'slate', windows: 'none' }),
  bld({ id: 'gs-alehouse', kind: 'alehouse', label: 'The Blackened Hart', x: -369, z: -116, yaw: Math.PI / 2, w: 10.0, d: 7.6, storeys: 2, wall: 'rubble', roof: 'slate', enterable: true, lit: true }),
  bld({ id: 'gs-chapel', kind: 'chapel', x: -350, z: -120, yaw: -Math.PI / 2, w: 9.0, d: 6.6, wall: 'rubble', roof: 'slate', windows: 'lancet', enterable: true }),
];

/**
 * The workings, in world metres.
 *
 * The adit goes into the scarp at x = -382 because that is where the face is:
 * the ground climbs 10.7 m between x = -389 and x = -381 at this z, so a
 * portal at -382 has real rock over it rather than being a doorway in a bank.
 * The tramway runs from the portal, past the headframe, to a tip that
 * discharges over the bench's eastern lip at x = -344 - which is exactly where
 * the ground falls away, so the spoil goes somewhere instead of piling on the
 * shelf.
 *
 * ── Why the tramway does not run straight ──────────────────────────────────
 * Because the winding house is in the way, and always was. The line used to be
 * `[[-378,-192],[-368,-192],[-359,-192],[-350,-191],[-344,-190]]` - dead
 * straight from the adit to the headframe at z = -192. The winding house stands
 * at (-370, -190) and is 12 x 9 m turned a quarter, so it occupies
 * x = -374.5..-365.5, z = -196..-184, and z = -192 is squarely inside it. Nine
 * metres of rail ran through the masonry, hidden by the walls, and then six
 * more ran through the entry apron in front of the door, where the eye COULD
 * see it: `_entrySteps` lays eight nested courses out to x = -360.3, so the
 * rails climbed into the flight, vanished, and re-appeared on the far side.
 * Measured burial along the old centreline: 1.08 m at x = -365, 0.75 m at -363,
 * 0.10 m at -361, 0.41 m at -359.
 *
 * The apron cannot give way - it is the only thing that makes a 2.03 m sill
 * reachable - and the building cannot move, because the shelf either side of it
 * is taken by the sorting shed at z = -177 and the smithy at z = -197. So the
 * line goes round the south, which is where a tramway would go anyway: it keeps
 * the winding house between the incline and the weather, and it still runs past
 * the door, three metres out from the bottom step instead of through it. The
 * dog-leg costs four metres of track and no gradient - the worst on the route
 * is still the 110% at the tip head, which is the tip.
 */
export const GRIMSCAR_WORKINGS = {
  adit: { x: -381, z: -192, yaw: Math.PI / 2, w: 3.4, h: 2.9 },
  headframe: { x: -359, z: -192, h: 13.5, legHalf: 3.1 },
  tramway: [[-378, -192], [-377, -195.5], [-373, -199.5], [-365, -200], [-360, -196.5],
    [-357.5, -192.2], [-350, -191], [-344, -190]],
  tip: { x: -343, z: -190, r: 9.5 },
  heaps: [
    { x: -344, z: -202, r: 7.0, h: 3.2 },
    { x: -342, z: -176, r: 6.0, h: 2.6 },
    { x: -346, z: -216, r: 5.4, h: 2.2 },
  ],
};

/* ------------------------------------------------------------------ */
/* 3. ST CEOLWINE'S ABBEY - the claustral plan in the combe            */
/* ------------------------------------------------------------------ */

/**
 * The precinct wall, and the one gate in it.
 *
 * A claustral plan is a diagram before it is a building: church on the north
 * of a square garth, dorter east (so the monks come down the night stair into
 * the transept), refectory south (away from the church, next to the kitchen),
 * cellarer's range west. It is worth following exactly, because the plan is
 * the thing a player recognises - a courtyard with buildings round it is a
 * farmyard; a courtyard with an arcade round it and a church on the north side
 * is an abbey.
 */
export const CEOLWINE_PRECINCT = {
  x: -300, z: 342, hx: 42, hz: 44, wallH: 2.9, wallT: 0.7,
  gate: { x: -272, z: 298, w: 4.4 },
};
export const CEOLWINE_GARTH = { x: -300, z: 348, hx: 12, hz: 12, walkW: 3.4 };

const CEOLWINE_BUILDINGS = [
  bld({
    id: 'ab-church', kind: 'abbeychurch', label: "St Ceolwine's Abbey Church",
    x: -306, z: 326, yaw: Math.PI, w: 34, d: 12, storeys: 1,
    wall: 'ashlar', roof: 'slate', windows: 'lancet',
    enterable: true, lit: true, landmark: true,
  }),
  bld({ id: 'ab-tower', kind: 'belltower', x: -330, z: 326, yaw: Math.PI, w: 9.0, d: 9.0, storeys: 3, wall: 'ashlar', roof: 'flat', windows: 'lancet', enterable: true }),
  bld({ id: 'ab-dorter', kind: 'range', label: 'The Dorter', x: -280, z: 348, yaw: -Math.PI / 2, w: 26, d: 9.5, storeys: 2, wall: 'ashlar', roof: 'slate', windows: 'lancet', enterable: true, lit: true }),
  bld({ id: 'ab-frater', kind: 'range', label: 'The Refectory', x: -300, z: 368, yaw: Math.PI, w: 22, d: 9.5, storeys: 1, wall: 'ashlar', roof: 'slate', windows: 'lancet', enterable: true, lit: true }),
  bld({ id: 'ab-cellar', kind: 'range', label: "The Cellarer's Range", x: -320, z: 348, yaw: Math.PI / 2, w: 26, d: 9.5, storeys: 1, wall: 'ashlar', roof: 'slate', windows: 'lancet', enterable: true }),
  bld({ id: 'ab-chapter', kind: 'chapterhouse', x: -267, z: 338, yaw: -Math.PI / 2, w: 9.0, d: 8.0, wall: 'ashlar', roof: 'slate', windows: 'lancet', enterable: true }),
  bld({ id: 'ab-gate', kind: 'gatehouse', label: 'The Abbey Gate', x: -272, z: 299, yaw: Math.PI, w: 10.0, d: 7.2, storeys: 2, wall: 'ashlar', roof: 'slate', windows: 'lancet', enterable: true, lit: true }),
  bld({ id: 'ab-guest', kind: 'hall', label: 'The Guest Hall', x: -264, z: 316, yaw: -Math.PI / 2, w: 13, d: 8.4, wall: 'ashlar', roof: 'slate', enterable: true, lit: true }),
  bld({ id: 'ab-infirm', kind: 'hall', label: 'The Infirmary', x: -332, z: 366, yaw: Math.PI / 2, w: 13, d: 8.4, wall: 'ashlar', roof: 'slate', windows: 'lancet', enterable: true }),
  /* Turned to face the cloister, not the precinct wall.
   *
   * At yaw 0 the door looked out across the two metres between the kitchen and
   * the south precinct wall, into the wall. It was still enterable - you walk
   * up the slot and turn - but a kitchen serves the frater, so its door has to
   * open toward the frater, and a door that opens onto a blank wall two metres
   * away is the kind of thing a plan gets right and a coordinate gets wrong.
   * The footprint is 8.4 x 8.0, so the half-turn does not move a corner. */
  bld({ id: 'ab-kitchen', kind: 'kitchen', x: -322, z: 380, yaw: Math.PI, w: 8.4, d: 8.0, wall: 'rubble', roof: 'slate', windows: 'slit', enterable: true, lit: true }),
  bld({ id: 'ab-barn', kind: 'barn', label: 'The Tithe Barn', x: -268, z: 366, yaw: -Math.PI / 2, w: 20, d: 10, wall: 'rubble', roof: 'thatch', windows: 'none', enterable: true }),
  bld({ id: 'ab-stable', kind: 'shed', x: -296, z: 310, yaw: Math.PI, w: 12, d: 7.0, wall: 'rubble', roof: 'thatch', windows: 'none' }),
  bld({ id: 'ab-dove', kind: 'dovecote', x: -337, z: 304, yaw: 0, w: 5.6, d: 5.6, storeys: 2, wall: 'rubble', roof: 'flat', windows: 'slit' }),
];

/** Raised herb beds inside the precinct, as [x, z, hx, hz]. */
export const CEOLWINE_HERBS = [
  [-296, 377, 5.0, 2.6], [-296, 383, 5.0, 2.6], [-308, 377, 4.0, 2.6],
  [-308, 383, 4.0, 2.6], [-286, 377, 3.4, 2.6], [-286, 383, 3.4, 2.6],
];
/** The stew pond the community's fish came out of. */
export const CEOLWINE_POND = { x: -320, z: 308, hx: 9.0, hz: 6.0, depth: 1.4 };

/* ------------------------------------------------------------------ */
/* 4. BLACKMARCH HOLD - the palisade fort on the bluff                 */
/* ------------------------------------------------------------------ */

/**
 * The palisade, and why it is a rectangle.
 *
 * Because the bluff top is: `blackmarchShape` levels a rect 80 x 60 m to a
 * dead-flat 29.06 m and spends the drop outside it. A palisade that followed a
 * curve would either stand on the flat with a strip of unused ground outside
 * it - which is the one thing a fort must never have - or run down the face.
 * So the wall sits just inside the level ground on three sides and hard on the
 * lip above the neck on the fourth.
 *
 * The gate is at the west because the neck is: 53 m of 41% ramp arriving at
 * (318, -198), watched from the wall for its whole length. Everything else is
 * a 130-175% face.
 */
export const BLACKMARCH_PALISADE = {
  x0: 316, z0: -232, x1: 378, z1: -172,
  postH: 4.3, walkY: 2.55, walkW: 1.5, postR: 0.28, spacing: 0.62,
  gate: { x: 316, z: -198, w: 5.0, side: 'west' },
  towers: [
    { x: 316, z: -206, r: 3.2, h: 7.4 },
    { x: 316, z: -190, r: 3.2, h: 7.4 },
    { x: 378, z: -232, r: 2.8, h: 6.2 },
    { x: 378, z: -172, r: 2.8, h: 6.2 },
    { x: 316, z: -232, r: 2.8, h: 6.2 },
    { x: 316, z: -172, r: 2.8, h: 6.2 },
  ],
};

const BLACKMARCH_BUILDINGS = [
  bld({
    id: 'bm-hall', kind: 'towerhall', label: 'The Marcher Hall',
    x: 352, z: -204, yaw: -Math.PI / 2, w: 14, d: 11.5, storeys: 3,
    wall: 'plank', roof: 'shingle', windows: 'slit',
    enterable: true, lit: true, landmark: true,
  }),
  bld({ id: 'bm-barrack1', kind: 'barrack', x: 340, z: -224, yaw: 0, w: 22, d: 8.0, wall: 'plank', roof: 'shingle', windows: 'slit', enterable: true, lit: true }),
  bld({ id: 'bm-barrack2', kind: 'barrack', x: 344, z: -182, yaw: Math.PI, w: 22, d: 8.0, wall: 'plank', roof: 'shingle', windows: 'slit', enterable: true }),
  bld({ id: 'bm-stable', kind: 'shed', x: 370, z: -224, yaw: 0, w: 13, d: 8.0, wall: 'plank', roof: 'shingle', windows: 'none' }),
  bld({ id: 'bm-smithy', kind: 'smithy', x: 370, z: -182, yaw: Math.PI, w: 9.5, d: 7.4, wall: 'rubble', roof: 'shingle', windows: 'none', enterable: true, lit: true }),
  bld({ id: 'bm-store', kind: 'store', x: 368, z: -204, yaw: -Math.PI / 2, w: 11, d: 7.0, wall: 'plank', roof: 'shingle', windows: 'none', enterable: true }),
  bld({ id: 'bm-guard', kind: 'guardhouse', x: 326, z: -212, yaw: Math.PI / 2, w: 8.0, d: 6.4, storeys: 2, wall: 'plank', roof: 'shingle', windows: 'slit', enterable: true, lit: true }),
  bld({ id: 'bm-chapel', kind: 'chapel', x: 325, z: -186, yaw: Math.PI, w: 8.0, d: 6.4, wall: 'rubble', roof: 'shingle', windows: 'lancet', enterable: true }),
];

/** The muster yard - gravel, kept clear, and the reason the fort reads as one. */
export const BLACKMARCH_YARD = { x: 336, z: -204, hx: 10, hz: 10 };
/** The beacon on the east point, which is what the vale sees at night. */
export const BLACKMARCH_BEACON = { x: 375, z: -202, h: 6.4, basketR: 1.1 };

/* ------------------------------------------------------------------ */
/* 5. FENWICK CROSS - the market town in the basin                     */
/* ------------------------------------------------------------------ */

/**
 * Three streets, three notches, one market place.
 *
 * The basin's rim is 11 m with three breaks in it, and the breaks are why a
 * town is here: water runs to the middle of a bowl and so do tracks. The
 * bearings of the three lowest points on the rim were measured off the
 * finished ground - (196, 250) north, (105, 344) west, (214, 436) south - and
 * the three streets run from them to a market cross in the middle.
 *
 * Burgage plots, not cottages: narrow frontage, deep plot, gable end to the
 * street, two storeys with the upper jettied out over the pavement. That
 * silhouette - a sawtooth of gables with the first floors leaning in over a
 * street four metres wide - is the single thing that says "town" rather than
 * "village", and it is why Fenwick can be read from the rim.
 */
export const FENWICK_CENTRE = { x: 196, z: 344 };
export const FENWICK_MARKET = { x: 196, z: 344, hx: 16, hz: 14 };
export const FENWICK_CROSS = { x: 196, z: 344, h: 6.2, steps: 4 };

const FENWICK_NORTH_W = row({
  id: 'fn-w', x0: 196, z0: 298, x1: 196, z1: 328, n: 3, side: -1,
  offset: 4.5, w: 7.2, d: 11.0, wVary: 0.8, dVary: 1.0, jitter: 1.0, seed: 1.3,
  kind: 'burgage', wall: 'daub', roof: 'slate', storeys: 2, jetty: true,
  enterable: (i) => i % 2 === 0, lit: (i) => i % 2 === 1,
});
const FENWICK_NORTH_E = row({
  id: 'fn-e', x0: 196, z0: 298, x1: 196, z1: 328, n: 3, side: 1,
  offset: 4.5, w: 7.0, d: 11.0, wVary: 0.7, dVary: 0.9, jitter: 1.2, seed: 4.2,
  kind: 'burgage', wall: 'daub', roof: 'slate', storeys: 2, jetty: true,
  enterable: (i) => i % 2 === 1, lit: (i) => i % 3 === 0,
});
const FENWICK_WEST_N = row({
  id: 'fw-n', x0: 120, z0: 344, x1: 152, z1: 344, n: 4, side: 1,
  offset: 4.5, w: 7.0, d: 10.5, wVary: 0.6, dVary: 0.9, jitter: 0.6, seed: 2.6,
  kind: 'burgage', wall: 'daub', roof: 'thatch', storeys: 2, jetty: true,
  enterable: (i) => i % 2 === 0, lit: (i) => i % 2 === 0,
});
const FENWICK_WEST_S = row({
  id: 'fw-s', x0: 120, z0: 344, x1: 152, z1: 344, n: 4, side: -1,
  offset: 4.5, w: 7.0, d: 10.5, wVary: 0.7, dVary: 0.9, jitter: 0.9, seed: 6.8,
  kind: 'burgage', wall: 'daub', roof: 'thatch', storeys: (i) => (i === 2 ? 1 : 2), jetty: true,
  enterable: (i) => i % 3 === 1, lit: (i) => i % 3 === 2,
});
const FENWICK_SOUTH_W = row({
  id: 'fs-w', x0: 200, z0: 368, x1: 210, z1: 406, n: 4, side: -1,
  offset: 4.5, w: 6.8, d: 10.5, wVary: 0.6, dVary: 0.8, jitter: 1.0, seed: 3.9,
  kind: 'burgage', wall: 'daub', roof: 'thatch', storeys: 2, jetty: true,
  enterable: (i) => i % 2 === 0, lit: (i) => i % 2 === 1,
});
const FENWICK_SOUTH_E = row({
  id: 'fs-e', x0: 200, z0: 368, x1: 210, z1: 406, n: 4, side: 1,
  offset: 4.5, w: 7.0, d: 10.5, wVary: 0.6, dVary: 0.8, jitter: 1.2, seed: 8.1,
  kind: 'burgage', wall: 'daub', roof: 'slate', storeys: 2, jetty: true,
  enterable: (i) => i % 2 === 1, lit: (i) => i % 3 === 1,
});

const FENWICK_CIVIC = [
  bld({
    id: 'fx-guild', kind: 'guildhall', label: 'The Guildhall of the Staple',
    x: 222, z: 342, yaw: -Math.PI / 2, w: 21, d: 14, storeys: 2,
    wall: 'ashlar', roof: 'slate', windows: 'shutter',
    enterable: true, lit: true, landmark: true,
  }),
  bld({ id: 'fx-bell', kind: 'inn', label: 'The Bell', x: 169, z: 330, yaw: 0.30, w: 12.5, d: 10.0, storeys: 2, wall: 'daub', roof: 'slate', jetty: true, enterable: true, lit: true }),
  bld({ id: 'fx-woolpack', kind: 'inn', label: 'The Woolpack', x: 172, z: 360, yaw: -0.30, w: 12.5, d: 10.0, storeys: 2, wall: 'daub', roof: 'thatch', jetty: true, enterable: true, lit: true }),
  bld({ id: 'fx-toll', kind: 'tollbooth', x: 204, z: 356, yaw: Math.PI, w: 6.4, d: 5.4, storeys: 2, wall: 'ashlar', roof: 'slate', enterable: true, lit: true }),
  bld({ id: 'fx-barn', kind: 'barn', label: 'The Wool Barn', x: 154, z: 372, yaw: Math.PI, w: 20, d: 10.0, wall: 'rubble', roof: 'thatch', windows: 'none', enterable: true }),
  bld({ id: 'fx-chapel', kind: 'chapel', label: 'St Nicholas Chapel', x: 228, z: 374, yaw: -Math.PI / 2, w: 12, d: 8.0, wall: 'ashlar', roof: 'slate', windows: 'lancet', enterable: true }),
  bld({ id: 'fx-shambles', kind: 'shed', x: 186, z: 356, yaw: Math.PI / 2, w: 10, d: 5.4, wall: 'plank', roof: 'thatch', windows: 'none' }),
];

/* ------------------------------------------------------------------ */
/* The table                                                           */
/* ------------------------------------------------------------------ */

/**
 * @typedef {{id:string, displayName:string, kind:string, centre:{x:number,z:number},
 *            radius:number, landmark:string, buildings:object[],
 *            ground:object[]}} Town
 */

/** @type {Town[]} */
export const TOWNS = [
  {
    id: 'reedwater',
    displayName: 'Reedwater',
    kind: 'village',
    centre: { x: -358, z: 112 },
    radius: 74,
    /* Where the road actually delivers you. Not the centre: the centre of
     * Reedwater is over water, and "is the town reachable" is a question about
     * the point a traveller arrives at, not about the centroid of its
     * buildings. Every town declares one and the reachability test uses it. */
    entry: { x: -352, z: 120 },
    landmark: 'rw-hall',
    vernacular: 'stilt',
    buildings: [...REEDWATER_STILTS, ...REEDWATER_BANK],
    /* Beaten earth on the bank only. The deck is planks and the pool is water,
     * so painting trodden ground under either would put mud on a jetty and
     * mud in a river - `settledAt` has no idea what it is standing on. */
    ground: [
      { shape: 'rect', x: -362, z: 124, hx: 40, hz: 15, feather: 10 },
      { shape: 'disc', x: -330, z: 114, r: 12, feather: 8 },
      { shape: 'disc', x: -392, z: 132, r: 12, feather: 8 },
    ],
  },
  {
    id: 'grimscar',
    displayName: 'Grimscar',
    kind: 'town',
    centre: { x: -361, z: -158 },
    radius: 88,
    entry: { x: -362, z: -152 },
    landmark: 'gs-winding',
    vernacular: 'sooted stone',
    buildings: [...GRIMSCAR_WEST, ...GRIMSCAR_EAST, ...GRIMSCAR_WORKS],
    ground: [
      { shape: 'rect', x: -361, z: -152, hx: 16, hz: 40, feather: 11 },
      { shape: 'rect', x: -362, z: -196, hx: 22, hz: 22, feather: 11 },
      { shape: 'disc', x: -344, z: -190, r: 12, feather: 9 },
    ],
  },
  {
    id: 'st-ceolwine',
    displayName: "St Ceolwine's Abbey",
    kind: 'abbey',
    centre: { x: -300, z: 340 },
    radius: 96,
    entry: { x: -272, z: 294 },
    landmark: 'ab-church',
    vernacular: 'ashlar',
    buildings: CEOLWINE_BUILDINGS,
    ground: [
      { shape: 'rect', x: -300, z: 340, hx: 42, hz: 40, feather: 12 },
      { shape: 'rect', x: -272, z: 296, hx: 9, hz: 8, feather: 8 },
    ],
  },
  {
    id: 'blackmarch',
    displayName: 'Blackmarch Hold',
    kind: 'fort',
    centre: { x: 347, z: -202 },
    /* Reaches past the neck's beaten earth, not just past the wall: the
     * approach ramp is the fort's, and a radius that stopped at the palisade
     * would let a later phase drop something else on top of it. */
    radius: 104,
    entry: { x: 320, z: -197 },
    landmark: 'bm-hall',
    vernacular: 'log and shingle',
    buildings: BLACKMARCH_BUILDINGS,
    ground: [
      { shape: 'rect', x: 347, z: -202, hx: 32, hz: 31, feather: 11 },
      /* The neck. A fort's approach is the most trodden ground it owns and it
       * is the one piece of beaten earth here that is not inside the wall. */
      { shape: 'rect', x: 292, z: -192, hx: 26, hz: 8, feather: 10 },
    ],
  },
  {
    id: 'fenwick-cross',
    displayName: 'Fenwick Cross',
    kind: 'town',
    centre: { x: 192, z: 350 },
    radius: 108,
    entry: { x: 196, z: 340 },
    landmark: 'fx-guild',
    vernacular: 'burgage',
    buildings: [
      ...FENWICK_NORTH_W, ...FENWICK_NORTH_E,
      ...FENWICK_WEST_N, ...FENWICK_WEST_S,
      ...FENWICK_SOUTH_W, ...FENWICK_SOUTH_E,
      ...FENWICK_CIVIC,
    ],
    ground: [
      { shape: 'rect', x: 196, z: 344, hx: 22, hz: 20, feather: 12 },
      { shape: 'rect', x: 196, z: 316, hx: 15, hz: 20, feather: 10 },
      { shape: 'rect', x: 158, z: 344, hx: 30, hz: 15, feather: 10 },
      { shape: 'rect', x: 206, z: 382, hx: 15, hz: 26, feather: 10 },
      { shape: 'disc', x: 218, z: 342, r: 16, feather: 9 },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Derived                                                             */
/* ------------------------------------------------------------------ */

/** Every building in every town, tagged with the town that owns it. */
export function allBuildings() {
  const out = [];
  for (const t of TOWNS) for (const b of t.buildings) out.push({ ...b, town: t.id });
  return out;
}

/** The named landmark of a town. */
export function landmarkOf(town) {
  return town.buildings.find((b) => b.id === town.landmark) || null;
}

/**
 * The four corners of a building's footprint, in world metres.
 *
 * `pad` inflates the rectangle in the building's OWN frame, which is what a
 * clearance test wants - a rectangle at 45 degrees inflated in world axes is
 * inflated by sqrt(2) too much along its diagonal and not at all along its
 * faces.
 */
export function footprintCorners(b, pad = 0) {
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  const hw = b.w / 2 + pad;
  const hd = b.d / 2 + pad;
  const out = [];
  for (const [ox, oz] of [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]) {
    out.push([b.x + ox * c + oz * s, b.z - ox * s + oz * c]);
  }
  return out;
}

/** Signed distance from (x, z) to a building's footprint, negative inside. */
export function footprintDistance(b, x, z, pad = 0) {
  const dx = x - b.x;
  const dz = z - b.z;
  const c = Math.cos(-b.yaw);
  const s = Math.sin(-b.yaw);
  return rectDist(dx * c - dz * s, dx * s + dz * c, b.w / 2 + pad, b.d / 2 + pad);
}

/**
 * True when two footprints overlap, each inflated by `pad`.
 *
 * Separating-axis over the four face normals. The normals are at MINUS the
 * building's yaw, and that sign is the whole test: `footprintCorners` uses the
 * same `x + ox*c + oz*s, z - ox*s + oz*c` transform `_house` and `_shell` do,
 * whose local +X lands at world angle `-yaw`. Testing against `+yaw` instead
 * gives a function that is correct for every axis-aligned pair and quietly
 * wrong for every rotated one - which is exactly the set a market street of
 * jettied burgage plots is made of.
 */
export function footprintsOverlap(a, b, pad = 0) {
  const axes = [-a.yaw, -a.yaw + Math.PI / 2, -b.yaw, -b.yaw + Math.PI / 2];
  const ca = footprintCorners(a, pad);
  const cb = footprintCorners(b, pad);
  for (const th of axes) {
    const ax = Math.cos(th);
    const az = Math.sin(th);
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [x, z] of ca) { const p = x * ax + z * az; if (p < a0) a0 = p; if (p > a1) a1 = p; }
    for (const [x, z] of cb) { const p = x * ax + z * az; if (p < b0) b0 = p; if (p > b1) b1 = p; }
    if (a1 <= b0 || b1 <= a0) return false;
  }
  return true;
}

/**
 * The ground a shell will sit on: highest and lowest corner, and the plinth
 * that has to bridge them.
 *
 * `_shell` sets its base to the HIGHEST corner and drops a plinth to below the
 * lowest, exactly as `_house` does, so relief under a footprint turns into
 * masonry rather than into a floating corner. That works, and it stops working
 * somewhere: a 3 m plinth under a 7 m cottage is a tower block. The tests bound
 * it rather than trusting it.
 */
export function groundUnder(b, height = medievalHeight) {
  let hi = -Infinity;
  let lo = Infinity;
  for (const [x, z] of footprintCorners(b)) {
    const h = height(x, z);
    if (h > hi) hi = h;
    if (h < lo) lo = h;
  }
  // The centre too: a saddle can sit below all four corners.
  const hc = height(b.x, b.z);
  if (hc > hi) hi = hc;
  if (hc < lo) lo = hc;
  return { hi, lo, relief: hi - lo, baseY: hi + 0.02 };
}

/** True when a building stands over open water rather than on the ground. */
export function isOverWater(b, height = medievalHeight) {
  return height(b.x, b.z) < WATER_Y;
}

/** Which bank of the river a town is on. Computed, never declared. */
export function townBank(town) {
  return town.centre.z > riverZ(town.centre.x) ? 'far' : 'vale';
}

/** Total enterable buildings, per town id. */
export function enterableCounts() {
  const out = {};
  for (const t of TOWNS) out[t.id] = t.buildings.filter((b) => b.enterable).length;
  return out;
}
