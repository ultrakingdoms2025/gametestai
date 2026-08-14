/**
 * Aldermoor Vale's settlements - the named places, and the ground they wear.
 *
 * Before this file the vale had no settlements. It had a flat `PLOTS` array of
 * house coordinates and a hard-coded rejection box in `_settled()`, and the
 * only thing that made "the village" a village was that twenty-five of those
 * coordinates happened to cluster. Nothing had a name, a centre or a radius,
 * so nothing downstream could ask "which settlement is this?" or "is there
 * already a settlement here?" - which is exactly what a bigger vale needs to
 * ask before it can put a second village in it.
 *
 * Lifted out of `MedievalWorld.js` for the same reason `MedievalHeight.js`
 * was: the plot table is now shared between the world, the settled-ground
 * function and the tests, and a second copy would be a second thing to keep
 * in step. `MedievalWorld` imports `PLOTS` and `EXTRA_YARDS` straight back, so
 * there is still exactly one definition of where every house stands.
 *
 * Nothing in this file may import `three` or touch the DOM.
 *
 * ---------------------------------------------------------------------------
 * WHAT A SETTLEMENT OWNS
 *
 *   id            stable key, safe to persist
 *   displayName   shown to a player
 *   kind          'village' | 'hamlet' | 'castle' | 'church' | 'mill' | 'ruin'
 *   centre {x,z}  where the place is, for naming, spacing and map labels
 *   radius        how far it reaches, metres - the spacing radius a later
 *                 phase uses to refuse to drop a second settlement on top
 *   plots         [first, end) index range into PLOTS, or null
 *   ground        beaten-earth features, in world metres. This is the ONLY
 *                 input to `settledAt`, and may be empty: a settlement with no
 *                 ground features is a named place that does not (yet) trample
 *                 the meadow around it.
 *
 * A ground feature is one of
 *   { shape: 'disc', x, z, r, feather }
 *   { shape: 'rect', x, z, hx, hz, feather }
 * and contributes `1 - smoothstep(0, feather, signedDistance)`. The result of
 * `settledAt` is the MAXIMUM over every feature of every settlement, which is
 * what the hand-written version computed too - it just could not say so.
 */

import { MARKET, CASTLE, VILLAGE, rectDist, smoothstep } from '../terrain/MedievalHeight.js';

/**
 * Village plots: [x, z, yaw, width, depth, storeys, roof, lit].
 *
 * Hoisted to module scope because the road builder needs them: every house
 * gets a paved yard and a lane back to the nearest street, and those have to
 * exist before the macro terrain map is painted.
 *
 * Indices 0..24 are Aldermoor itself; 25..34 are the castle-approach hamlet
 * arc. `SETTLEMENTS` below slices this array by those ranges, so moving a
 * house between the two means moving it across the boundary here rather than
 * editing a coordinate in two places.
 */
export const PLOTS = [
  [14, 4, -0.55, 8.5, 6.5, 2, 't', 1], [11, 21, 1.62, 7.5, 6, 1, 't', 1],
  [15, 35, 2.9, 9, 6.5, 2, 's', 0], [33, 41, 3.14, 8, 6, 1, 't', 1],
  [52, 36, 2.35, 9.5, 7, 2, 's', 1], [56, 11, -1.75, 8, 6, 1, 't', 0],
  [45, -3, 0.12, 9, 6.5, 2, 't', 1], [23, -6, 0.25, 7.5, 6, 1, 's', 0],
  [58, 20, -0.42, 8.5, 6.5, 2, 't', 1], [69, 26, -0.42, 7.5, 6, 1, 't', 0],
  [80, 33, -0.42, 9, 6.5, 2, 's', 1], [92, 44, -0.5, 8, 6, 1, 't', 0],
  [63, 38, 2.7, 8.5, 6.5, 1, 't', 1], [75, 45, 2.7, 7.5, 6, 2, 's', 0],
  [88, 53, 2.62, 8, 6, 1, 't', 1],
  [37, 46, -0.14, 8, 6.5, 2, 't', 1], [19, 53, 1.5, 7.5, 6, 1, 't', 0],
  [35, 64, -0.1, 9, 6.5, 1, 's', 1], [17, 70, 1.48, 8, 6, 2, 't', 0],
  [47, 9, 0.75, 7.5, 6, 1, 't', 1], [59, 1, 0.62, 8, 6.5, 2, 's', 0],
  // Moved off (-31, 33) in round 4. Sat 18m from the castle-approach lens and
  // 9.5m wide, so it filled the right third of that framing, cropped by the
  // frame edge, brighter and higher-contrast than the hero asset it was
  // supposed to be a supporting element for.
  [101, 9, 0.4, 10, 7.5, 1, 't', 0], [68, 56, 1.1, 9.5, 7, 1, 't', 1],
  [85, 76, 2.2, 9, 7, 1, 't', 0], [-47, 12, -0.9, 8.5, 6.5, 1, 's', 0],
  // Plot (8,-6) removed: it sat directly over the Quest Manager spawn at
  // (10, -9), whose ground snap raycast landed on the thatch and left the
  // NPC waist-deep in the roof.
  // Expanded hamlets around the castle outer approaches (kept clear of the
  // moat AND of the two parish-church footprints).
  [-166, -22, 0.42, 9.5, 7.2, 2, 's', 1], [-154, -44, 0.55, 8.8, 6.8, 1, 't', 0],
  [-148, -66, 0.62, 9.2, 7.0, 2, 's', 1], [-138, -84, 0.74, 8.4, 6.5, 1, 't', 0],
  [-132, -104, 0.86, 9.0, 7.0, 2, 's', 1], [-108, -118, 1.0, 9.6, 7.4, 2, 's', 1],
  [-88, -124, 1.18, 9.0, 7.0, 1, 't', 0], [-80, -142, 1.32, 9.4, 7.2, 2, 's', 1],
  [-40, -124, 1.44, 8.6, 6.7, 1, 't', 0], [-16, -116, 1.58, 9.1, 7.0, 2, 's', 1],
];

/** Index range of Aldermoor's own plots within `PLOTS`: [first, end). */
export const ALDERMOOR_PLOTS = [0, 25];
/** Index range of the castle-approach hamlet arc within `PLOTS`: [first, end). */
export const APPROACH_PLOTS = [25, 35];

/** The tavern and the mill are hand-placed, but they still want a yard. */
export const EXTRA_YARDS = [
  { x: 46, z: 32, r: -0.42, w: 13, d: 8.5 },
  { x: -13, z: 95.35, r: 0.06, w: 11, d: 8 },
];

/* ------------------------------------------------------------------ */
/* Ground features                                                     */
/* ------------------------------------------------------------------ */

/**
 * The yard and desire line a single dwelling drags with it. The radius is the
 * plot's own size plus the width of a cart turn; the feather is the fringe of
 * scuffed grass beyond that.
 */
const plotYard = (p) => ({
  shape: 'disc', x: p[0], z: p[1], r: Math.max(p[3], p[4]) * 0.5 + 3.2, feather: 6.5,
});

/** Same, for the two hand-placed yards that have no plot entry. */
const extraYard = (e) => ({
  shape: 'disc', x: e.x, z: e.z, r: Math.max(e.w, e.d) * 0.5 + 3.0, feather: 6.0,
});

const plotRange = ([a, b]) => PLOTS.slice(a, b).map(plotYard);

/* ------------------------------------------------------------------ */
/* The table                                                           */
/* ------------------------------------------------------------------ */

/**
 * @typedef {{ shape:'disc', x:number, z:number, r:number, feather:number }
 *         | { shape:'rect', x:number, z:number, hx:number, hz:number, feather:number }} GroundFeature
 * @typedef {{ id:string, displayName:string, kind:string,
 *             centre:{x:number,z:number}, radius:number,
 *             plots:[number,number]|null, ground:GroundFeature[],
 *             groundBounds:{minX:number,minZ:number,maxX:number,maxZ:number}|null }} Settlement
 */

/** @type {Settlement[]} */
export const SETTLEMENTS = [
  {
    id: 'aldermoor',
    displayName: 'Aldermoor',
    kind: 'village',
    centre: { x: VILLAGE.x, z: VILLAGE.z },
    /* Far enough to reach the OUTER EDGE of the outermost yard, not just its
     * centre - the radius is what a later phase spaces new settlements
     * against, and a radius that stops short of a house's own beaten earth
     * would let the next village be dropped on top of it. The lone plot at
     * (-47, 12) is the outlier that sets it: 92m out, plus its 14m yard. */
    radius: 108,
    plots: ALDERMOOR_PLOTS,
    ground: [
      // The market and its aprons: fully trodden, feathered over 8m.
      { shape: 'rect', x: MARKET.x, z: MARKET.z, hx: MARKET.hx + 3, hz: MARKET.hz + 3, feather: 8 },
      ...plotRange(ALDERMOOR_PLOTS),
      extraYard(EXTRA_YARDS[0]),          // the tavern yard
    ],
  },
  {
    id: 'keep-approach',
    displayName: 'The Keep Approach',
    kind: 'hamlet',
    // Centroid of the arc, which curls anticlockwise from west to south-east
    // around the castle's outer glacis.
    centre: { x: -105, z: -94 },
    // Set by the two ends of the arc, at (-166, -22) and (-16, -116).
    radius: 110,
    plots: APPROACH_PLOTS,
    ground: plotRange(APPROACH_PLOTS),
  },
  {
    id: 'aldermoor-keep',
    displayName: 'Aldermoor Keep',
    kind: 'castle',
    centre: { x: CASTLE.x, z: CASTLE.z },
    // The bailey rect plus its 9m glacis feather, corner to corner.
    radius: 64,
    plots: null,
    // The castle bailey and its glacis.
    ground: [
      { shape: 'rect', x: CASTLE.x, z: CASTLE.z, hx: CASTLE.hx - 2, hz: CASTLE.hz - 2, feather: 9 },
    ],
  },
  /* ---------------------------------------------------------------- *
   * Everything below is a named place with NO ground features.
   *
   * That is deliberate and it is not an oversight: none of these six have
   * ever had beaten earth painted around them, and giving them a yard here
   * would change the ground under six existing buildings in a phase whose
   * whole job is to make the vale bigger without moving anything in it.
   * They are registered so the table is the complete list of places, so a
   * later phase can attach `ground` to any of them in one line, and so
   * settlement placement in a later phase has something to space against.
   * ---------------------------------------------------------------- */
  {
    id: 'st-aldern',
    displayName: 'Church of St Aldern',
    kind: 'church',
    centre: { x: 66, z: -8 },
    radius: 24,
    plots: null,
    ground: [],
  },
  {
    id: 'west-parish',
    displayName: 'West Parish Church',
    kind: 'church',
    centre: { x: -146, z: -30 },
    radius: 16,
    plots: null,
    ground: [],
  },
  {
    id: 'south-parish',
    displayName: 'South Parish Church',
    kind: 'church',
    centre: { x: -60, z: -136 },
    radius: 16,
    plots: null,
    ground: [],
  },
  {
    id: 'aldern-mill',
    displayName: 'Aldern Mill',
    kind: 'mill',
    centre: { x: EXTRA_YARDS[1].x, z: EXTRA_YARDS[1].z },
    radius: 18,
    plots: null,
    ground: [extraYard(EXTRA_YARDS[1])],
  },
  {
    id: 'windmill',
    displayName: 'The Windmill',
    kind: 'mill',
    centre: { x: -88, z: -150 },
    radius: 14,
    plots: null,
    ground: [],
  },
  {
    id: 'watchtower',
    displayName: 'The Ruined Watchtower',
    kind: 'ruin',
    centre: { x: 160, z: -20 },
    radius: 16,
    plots: null,
    ground: [],
  },
];

/* ------------------------------------------------------------------ */
/* Derived bounds - the cheap reject `settledAt` used to hard-code      */
/* ------------------------------------------------------------------ */

/** Axis-aligned support of one ground feature, feather included. */
function featureBounds(f) {
  const hx = f.shape === 'rect' ? f.hx + f.feather : f.r + f.feather;
  const hz = f.shape === 'rect' ? f.hz + f.feather : f.r + f.feather;
  return { minX: f.x - hx, minZ: f.z - hz, maxX: f.x + hx, maxZ: f.z + hz };
}

function unionInto(acc, b) {
  if (!acc) return { ...b };
  if (b.minX < acc.minX) acc.minX = b.minX;
  if (b.minZ < acc.minZ) acc.minZ = b.minZ;
  if (b.maxX > acc.maxX) acc.maxX = b.maxX;
  if (b.maxZ > acc.maxZ) acc.maxZ = b.maxZ;
  return acc;
}

/**
 * Every settlement's ground support, and the union of all of them.
 *
 * This replaces the literal `if (x < -126 || x > 122 || z < -106 || z > 96)`
 * that used to open `_settled`. That box was measured off the settlements of
 * the day and was already wrong for five of them - it clipped the yards of the
 * castle-approach hamlet and the northern third of the mill's - and it could
 * not possibly be right for a settlement added later. Derived per settlement,
 * the reject is both tighter (most samples now fail one small box instead of
 * scanning thirty-seven plots) and correct by construction.
 */
let ALL_GROUND_BOUNDS = null;
for (const s of SETTLEMENTS) {
  let b = null;
  for (const f of s.ground) b = unionInto(b, featureBounds(f));
  s.groundBounds = b;
  if (b) ALL_GROUND_BOUNDS = unionInto(ALL_GROUND_BOUNDS, b);
}
export const GROUND_BOUNDS = ALL_GROUND_BOUNDS ?? { minX: 0, minZ: 0, maxX: 0, maxZ: 0 };

/* ------------------------------------------------------------------ */
/* The one authority for trodden ground                                */
/* ------------------------------------------------------------------ */

/**
 * How settled a point is: 0 = open pasture, 1 = beaten earth people stand on.
 *
 * The single most damaging read in the round-3 build was a "village square"
 * whose floor was continuous lawn - houses parked on grass, with sparse
 * over-scaled tufts scattered across ground that four hundred people and
 * their carts cross every day. Grass does not grow there, and no amount of
 * lighting or tuft density fixes a ground *type* error.
 *
 * This is the authority for that: the macro painter uses it to lay packed
 * earth, the road setts use it, and the vegetation scatter uses it to refuse
 * to seed. One function, so the painted ground and the planted ground can
 * never disagree - and now one *table*, so a settlement added in a later phase
 * gets its beaten earth without anyone remembering to come back here.
 *
 * @returns {number} 0..1
 */
export function settledAt(x, z) {
  // Cheap reject. The macro painter calls this a million times, and at 900m
  // nine tenths of the vale is nowhere near a building.
  const g = GROUND_BOUNDS;
  if (x < g.minX || x > g.maxX || z < g.minZ || z > g.maxZ) return 0;
  let w = 0;
  for (let i = 0; i < SETTLEMENTS.length; i++) {
    const s = SETTLEMENTS[i];
    const b = s.groundBounds;
    if (!b || x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
    const ground = s.ground;
    for (let k = 0; k < ground.length; k++) {
      const f = ground[k];
      const d = f.shape === 'rect'
        ? rectDist(x - f.x, z - f.z, f.hx, f.hz)
        : Math.hypot(x - f.x, z - f.z) - f.r;
      if (d >= f.feather) continue;
      // `smoothstep` clamps, so a negative distance - inside the feature -
      // lands on exactly 1 without a separate max(0, d).
      const t = 1 - smoothstep(0, f.feather, d);
      if (t > w) w = t;
      if (w >= 1) return 1;
    }
  }
  return w;
}

/** The settlement whose `radius` contains (x, z), nearest first, or null. */
export function settlementAt(x, z) {
  let best = null;
  let bestD = Infinity;
  for (const s of SETTLEMENTS) {
    const d = Math.hypot(x - s.centre.x, z - s.centre.z);
    if (d <= s.radius && d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}
