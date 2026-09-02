/**
 * Aldermoor Vale's structured activity: viewpoints, trials and the circuit.
 *
 * ── The defect this answers ───────────────────────────────────────────────
 * Medieval is the largest and most detailed world in the game - 13,780 lines,
 * a walled town, a castle, 54 enterable doors, swimmable water, wildlife - and
 * it was the EMPTIEST on the record board. It published no `viewpoints`, no
 * `minigameVenues` and no `circuits`, so its whole charter record was one
 * 110-relic sweep, and `Retention` - which draws its dailies from unfinished
 * charter columns and authors no task table of its own - had exactly one
 * column in the vale to draw from.
 *
 * None of that was a missing engine. `Viewpoints`, `MinigameManager` and
 * `RaceManager` all run today, all three are world-agnostic, and all three ask
 * only for a descriptor. This file is the descriptors.
 *
 * ── Why it is a module and not three blocks in MedievalWorld.js ───────────
 * The same reason `RoadNet.js`, `Settlements.js` and `Wildlife.js` are:
 * **what matters about a route is not what it looks like, it is whether a body
 * can walk it**, and that is a heightfield question that needs no renderer.
 * Nothing here imports `three` or touches the DOM, so
 * `medieval-objectives.test.mjs` can walk every checkpoint against the real
 * heightfield without building a world - and it builds one anyway, because six
 * of the forty-four points published here stand on masonry rather than on soil
 * and only a collider knows where masonry is.
 *
 * ── Every Y IS DERIVED, NONE IS TYPED ─────────────────────────────────────
 * A previous pass in this world found authored geometry that disagreed with
 * its own drawn form by metres, and the survey behind this file found three
 * more: the Ruined Watchtower is a sealed ring wall with no floor and no top,
 * the windmill's "stage" is twelve rail posts and no deck, and Aldern Mill's
 * own table centre at (-13, 95.35) reads 1.18 m UNDER the waterline. So not
 * one height below is a number somebody liked:
 *
 *   - soil        -> `medievalHeight(x, z)`, the same function the terrain
 *                    mesh, the collision chunks and every prop placement read
 *   - masonry     -> the exported constant the builder itself measures from
 *                    (`CASTLE.ground`, `MARKET.y`, `REEDWATER_DECK`), plus the
 *                    offset that builder applies, written as arithmetic
 *
 * and `medieval-objectives.test.mjs` then puts all forty-four - eight
 * viewpoints and thirty-six trial checkpoints - back through the collider set
 * of a world it builds, because arithmetic that agrees with itself is not
 * evidence.
 *
 * ── Stream safety ─────────────────────────────────────────────────────────
 * Nothing here draws from any builder's seeded RNG. `medievalObjectives` is
 * called after the last builder has run and calls no `rnd()` at all, so every
 * placement in the vale - the 12 beast sites, the 88 residents, the treasure,
 * the woodland - is bit-identical to the build before this file existed. That
 * is not an aspiration: `medieval-wildlife.test.mjs` and
 * `medieval-population.test.mjs` pin those placements to the metre.
 */
import {
  medievalHeight, CASTLE, MARKET,
} from '../terrain/MedievalHeight.js';
import { REEDWATER_DECK } from './Towns.js';
import { ROADS, CROSSINGS } from './RoadNet.js';

/* ------------------------------------------------------------------ */
/* Heights                                                             */
/* ------------------------------------------------------------------ */

/**
 * The keep's leaded roof deck.
 *
 * `_castleKeep` builds it at `DECK = TOP + 0.34` over `TOP = G + 19.6`, and
 * lays the slab as four `_box(cx, DECK - 0.6, cz, px, 0.6, pz)` pieces around
 * the stair well - so the collider's TOP FACE is exactly `DECK`. 29.54 m: the
 * highest thing in the vale a player can stand on, and reachable on foot only
 * since the 48-tread newel vice was cut up the hall's north bay.
 */
export const KEEP_DECK_Y = CASTLE.ground + 19.6 + 0.34;

/**
 * The curtain wall walk.
 *
 * `WALL_H` is 10.6 in `MedievalWorld.js` and each curtain run's collider is
 * `_rbox(mx, G + WALL_H/2, mz, len/2, WALL_H/2, TH/2, yaw)`, so the allure's
 * top face is `G + WALL_H`. Restated here rather than imported because
 * `WALL_H` is a module private in a 667 KB file; the gate is what stops the
 * two drifting.
 */
export const WALL_WALK_Y = CASTLE.ground + 10.6;

/**
 * The market cross plinth.
 *
 * One collider, `_box(MARKET.x, MY + 1.0, MARKET.z, 1.8, 1.0, 1.8)` with
 * `MY = MARKET.y`, so the top face is `MARKET.y + 2.0`. The three drawn steps
 * are INSIDE that box and are not walkable; the rise from the square is
 * 1.76 m, which is over `stepHeight` and inside `Climb`'s mantle window
 * [1.0, 2.4] - so the cross is mantled, not walked up, and that is the whole
 * of the effort it asks for.
 */
export const MARKET_CROSS_Y = MARKET.y + 2.0;

/**
 * Reedwater's jetty deck.
 *
 * `_jetty` draws planks whose visual top is `REEDWATER_DECK` and registers
 * `_rbox(cx, deckY - 0.22, cz, .., 0.14, ..)`, so the collider top is 8 cm
 * lower than the plank a player appears to stand on. The 8 cm is the builder's,
 * not this file's; what matters is that the number here is the one the body
 * actually rests on.
 */
export const JETTY_DECK_Y = REEDWATER_DECK - 0.22 + 0.14;

/**
 * Fenwick's market cross, third step.
 *
 * `_dressFenwick` lays four `_box(196, y + 0.16 + i*0.32, 344, (k*1.5)/2,
 * 0.16, (k*1.5)/2)` with `k = 4 - i`, so step `i`'s top face is
 * `y + 0.32*(i+1)` and every riser is 0.32 m - inside `stepHeight` 0.45, so
 * all four are WALKED up rather than mantled.
 *
 * The third step (`i = 2`) and not the fourth: the top step is 1.5 m square
 * around a 0.8 m shaft, which leaves a 0.35 m ledge for a capsule of radius
 * 0.35. The third leaves 0.75 m all round.
 */
export const FENWICK_CROSS_Z = 344;
export const FENWICK_CROSS_X = 196;
export const FENWICK_STEP_Y = medievalHeight(FENWICK_CROSS_X, FENWICK_CROSS_Z) + 0.32 * 3;

/* ------------------------------------------------------------------ */
/* Viewpoints                                                          */
/* ------------------------------------------------------------------ */

/**
 * Eight vantage points, one per district.
 *
 * ── Why one per district and not eight on the castle ──────────────────────
 * `Viewpoints.REVEAL_R` is 70 m and the citadel's own note is explicit about
 * what happens when they cluster: "five reveal discs sharing one small cluster
 * of centres behave much more like one big disc than like five districts". The
 * castle alone offers three genuinely reachable platforms - the keep deck and
 * both ends of the wall walk - and taking all three would have spent 3/8 of
 * the world's map reveal inside one 46 m circle. So the castle gets ONE, its
 * best, and the other seven are spread over 900 m of vale: the village, the
 * east march, the south downs, the mining bench, the fishing pool, the north
 * bluff and the southern basin. Eight 70 m discs mark about 15% of an 810,000
 * m² map, which leaves the 110 relics something to be hunted for.
 *
 * ── What is NOT here, and why ─────────────────────────────────────────────
 * The obvious eight were the eight named landmarks in `Settlements.js`, and
 * five of them cannot be stood on at all. Measured against the built world:
 *
 *   The Ruined Watchtower  `_ringWall(160, .., -20, 3.2, 6.25, 0.7, 10)` and
 *                          nothing else. Ten wall boxes whose half-widths
 *                          (1.740) exceed half their own chord (1.006), so the
 *                          shell is SEALED - there is no floor, no stair and no
 *                          way inside. Published at its foot instead.
 *   The Windmill           `_ringWall` again, plus twelve rail posts drawn with
 *                          no deck between them. The "stage" is a handrail
 *                          around nothing. Published at its foot instead.
 *   Aldern Mill            its own table centre reads -1.18 m, which is 2.03 m
 *                          UNDER the waterline. Dropped.
 *   St Aldern's tower      one solid `_box(51.4, gy+12, -8, 4, 12, 4)`. Its top
 *                          face at 28.58 m is standable and there is no way up
 *                          it but a free climb. Dropped.
 *   The parish churches    no outdoor elevated surface at all; the only decks
 *                          are enclosed nave lofts. Dropped.
 *
 * Two of the eight are therefore at ground level, at the foot of a landmark
 * that has no top. That is the honest answer and it is not a lesser viewpoint:
 * what a viewpoint pays is a map reveal, a travel anchor, credits and a coin,
 * and the vale - a 900 m world with no fast travel whatsoever before this
 * file - wants anchors at its named places far more than it wants climbs.
 *
 * No `launch` and no `hay` anywhere. `normaliseViewpoint` drops a launch point
 * with no resolved haystack under it, and the vale authors no haystack: there
 * is no `_softLandingAt` surface anywhere in the world. A leap prompt with
 * nothing under it is precisely the defect that contract exists to prevent.
 */
export const VIEWPOINTS = [
  {
    id: 'keep-deck',
    name: 'The Keep Roof Deck',
    /* Clear of the stair well (x -71.9..-69.1, z -62.7..-59.9), the flagstaff
     * collider at (-88.4, -62.3) and the signal brazier at (-68.2, -49.9). The
     * keep's own wall solids top out 0.46 m above the deck all round, which is
     * over `stepHeight` - so the deck is a room, not a ledge. */
    x: -78, y: KEEP_DECK_Y, z: -53, r: 6,
  },
  {
    id: 'market-cross',
    name: 'The Aldermoor Market Cross',
    x: MARKET.x, y: MARKET_CROSS_Y, z: MARKET.z, r: 2.4,
  },
  {
    id: 'watchtower',
    name: 'The Ruined Watchtower',
    /* Six metres east of the drum, outside its 3.9 m shell and inside the 9 m
     * footprint the landmark reserves. */
    x: 166, y: medievalHeight(166, -20), z: -20, r: 4,
  },
  {
    id: 'windmill',
    name: 'The Windmill',
    /* Nine metres east of the tower, outside the 4.4 m rail ring. */
    x: -79, y: medievalHeight(-79, -150), z: -150, r: 4,
  },
  {
    id: 'grimscar-lip',
    name: 'The Grimscar Lip',
    /* The eastern edge of the mining bench, over the spoil tip 5.1 m below.
     * The bench is the one defensible piece of ground on the escarpment and
     * this is the corner of it that looks down the whole west bank. */
    x: -348, y: medievalHeight(-348, -190), z: -190, r: 5,
  },
  {
    id: 'reedwater-stage',
    name: 'The Reedwater Stage',
    /* Out on the jetty over the pool - 3.06 m over the bed, 1.62 m over the
     * water. Reached by the bank ramp at (-360, 119), whose two courses rise
     * 0.235 m each. Not at the jetty HEAD: a fishing hut stands on it, from
     * 2.55 m to 5.74 m, and a viewpoint published inside a shed is a viewpoint
     * of the inside of a shed. */
    x: -369, y: JETTY_DECK_Y, z: 90, r: 3,
  },
  {
    id: 'blackmarch-point',
    name: 'Blackmarch Point',
    /* The bluff's east point, 29.06 m of dead-flat plateau over the gorge.
     * Terrain, not masonry - the palisade's fighting walk is 2.55 m higher and
     * its three ladder posts stop 3.70 m short of the deck, so the walk is not
     * published and this is. Clear of the beacon collider at (375, -202). */
    x: 374, y: medievalHeight(374, -202), z: -202, r: 5,
  },
  {
    id: 'fenwick-cross',
    name: 'The Fenwick Cross',
    /* Third step of the four, on the diagonal so the capsule clears the shaft
     * by 0.75 m rather than 0.35 m. */
    x: 197.1, y: FENWICK_STEP_Y, z: 345.1, r: 2.4,
  },
];

/* ------------------------------------------------------------------ */
/* Trials                                                              */
/* ------------------------------------------------------------------ */

/**
 * Points that stand on masonry rather than soil, keyed `x|z`.
 *
 * Exactly two, both on the castle's east causeway and drawbridge, where the
 * moat cuts the ground to `CASTLE.ground - 4.9` and the deck spans it. Every
 * other checkpoint in this file takes `medievalHeight`.
 */
const DECKED = new Map([
  ['-14|-58', CASTLE.ground],
  ['-19.7|-58', CASTLE.ground],
]);

/** Ground height for a route point: the causeway where there is one, soil otherwise. */
export function routeY(x, z) {
  return DECKED.get(`${x}|${z}`) ?? medievalHeight(x, z);
}

/**
 * The three routes, as bare `[x, z]` chains.
 *
 * ── How they were laid out ────────────────────────────────────────────────
 * Not by eye. Every leg was routed by Dijkstra over a 4 m lattice of the real
 * heightfield, admitting a cell only when it is soil rather than a roof, dry,
 * clear of every plot in `Settlements.PLOTS` by 8 m, and under a slope of 0.5
 * (against `Treasures.MAX_WALK_SLOPE` = 0.78, so half the budget is in hand).
 * The dense path was then decimated to the spacings below. The first draft was
 * hand-placed and put four checkpoints inside buildings, one on the castle
 * parapet 14 m above the route, and three in the moat.
 *
 * ── Why the spacing is what it is ─────────────────────────────────────────
 * `RooftopTrial.climbLegs` treats ANY leg whose rise exceeds `LEAP_APEX`
 * (1.109 m) as a free climb and adds 9.0 s to every par. On rolling farmland
 * that is a heuristic firing on a hill: the hand-placed first draft of the
 * Pilgrim Road collected four of them and its gold par came out 41 s over the
 * route's own pace, on a walk that asks for no climbing at all. Routed and
 * decimated at 30 m it collects two, both real risers off the river terrace.
 * The spacing is therefore a par calibration, not a decoration - and the count
 * is a ratchet in the gate.
 *
 * ── Why these are FOOT routes and not mounted ones ────────────────────────
 * The brief allowed either. Measured, mounted does not work: `RooftopTrial`'s
 * `REF_PACE` is 6.0 chain-m/s, derived from a sprint on foot with stamina duty
 * cycle, and a horse tops out at 15.5 m/s - so every par would gold itself
 * while the rival ghost, which runs the SILVER par at ~4.5 m/s, jogged. The
 * module has no `mounted` check of its own (`TrackRace` does; this one does
 * not), so nothing would refuse the horse. They are authored, timed and gated
 * as what they are: three things to run.
 */
export const TRIAL_ROUTES = {
  /**
   * THE PILGRIM ROAD - the market cross, the three parish churches, the gate.
   *
   * 550 m and twenty stations, ending on the drawbridge over the dry moat.
   * The middle third runs the shelf south of the castle at z = -8, which is
   * the one line between the vale and the western hamlets that never enters
   * the moat's 3.6-17.4 m annulus.
   */
  pilgrim: [
    [36, 18], [45, -16], [66, -8], [37, -16], [9, -8], [-23, -8], [-55, -8],
    [-87, -8], [-119, -8], [-140, -30], [-139, -64], [-147, -92], [-127, -112],
    [-99, -112], [-67, -112], [-54, -135], [-35, -108], [-15, -88],
    [-14, -58], [-19.7, -58],
  ],
  /**
   * THE GRIMSCAR DESCENT - the shaft head to the west road, downhill.
   *
   * Sampled from `grimscarway` itself, reversed, at 42 m: the authored mining
   * road is the route, because the escarpment has exactly one walkable break
   * and this road takes it. 286 m and a 16.6 m net drop, with a 9.6 m fall in
   * the 41 m off the bench lip.
   *
   * ── What this is NOT, and why ─────────────────────────────────────────
   * It is not "the headframe to the workings floor", which is what the brief
   * asked for and what the world cannot hold. Measured: the headframe's legs,
   * braces and sheave are `B.add` calls with no colliders, so there is no
   * platform; the shaft collar is a SOLID 3x3 m box, so there is no hole; and
   * the adit at (-381, -192) is plugged by a rock-face collider filling its
   * mouth. There is no underground space in this world at all. A trial whose
   * finish line is inside solid rock is worse than no trial, so the descent is
   * the one that exists - down the incline the ore actually leaves by.
   */
  grimscar: [
    [-360, -196], [-362, -154], [-355.6, -112.6], [-330, -80],
    [-290.2, -63.5], [-260.7, -32.5], [-232.8, -0.4], [-212, 22],
  ],
  /**
   * THE POACHER'S LINE - the pilgrim path into the wood and down to the water.
   *
   * 225 m, 9.8 m of net descent, no leg that reads as a climb - and it passes
 * straight through two predator homes.
   *
   * ── The hazard is real and it is MEASURED, not asserted ───────────────
   * `Wildlife.planBeasts` does not read a table: it darts 20,000 seeded
   * samples at the playfield, keeps the legal homes, and deals twelve sites
   * nearest-a-road-first at 90 m spacing. The vale's shipped roster is
   * therefore a FUNCTION of the world, and the two this route crosses are the
   * wolf at (-131.406, 115.718) with a 34 m territory, and the bear at
   * (-160.764, 202.143) with 26 m. The straight line between checkpoints 6 and
   * 7 passes 0.4 m from the wolf's home and the line into checkpoint 4 passes
   * 1.9 m from the bear's.
   *
   * `medieval-objectives.test.mjs` recomputes `planBeasts` from the built
   * world and asserts the route still crosses two territories, because a site
   * roster derived from a seeded stream is exactly the kind of fact that
   * silently stops being true.
   *
   * ── Why a hazard and not a hunt ───────────────────────────────────────
   * `BEAST_BUDGET` is 0 and every pack streams by proximity
   * (`Residency.spawnRadius` = 175 m, `maxLiveBeasts` = 8), so a venue built
   * around killing a fixed quarry can have its quarry absent when the player
   * presses E. A hazard degrades the other way: a streamed-out pack makes the
   * route EASY, never broken. Both dens are 91 m apart, which is inside one
   * spawn radius, so a runner standing between them has both packs live and
   * 4-6 bodies of the 8-body ceiling in play.
   */
  poacher: [
    [-262, 232], [-225, 237], [-210, 236], [-177, 221], [-148, 192],
    [-145, 157], [-140, 130], [-124, 102],
  ],
};

/** `{x,y,z}` checkpoints for a named route, heights resolved. */
export function trialCheckpoints(key) {
  return TRIAL_ROUTES[key].map(([x, z]) => ({ x, y: routeY(x, z), z }));
}

/** Summed 3D length of a checkpoint chain, metres - the honest par input. */
export function chainLength(cps) {
  let n = 0;
  for (let i = 1; i < cps.length; i++) {
    n += Math.hypot(cps[i].x - cps[i - 1].x, cps[i].y - cps[i - 1].y, cps[i].z - cps[i - 1].z);
  }
  return n;
}

/**
 * Venue disc that contains a whole route.
 *
 * `RooftopTrial.venueBounds` computes exactly this and `MinigameManager` walks
 * a contest whose player leaves the disc for `LEAVE_GRACE_S` = 9 s - so a
 * venue smaller than its own route abandons every run partway round. The
 * margin is the module's own 10 m.
 */
export function venueDisc(cps, margin = 10) {
  let x0 = Infinity; let x1 = -Infinity; let z0 = Infinity; let z1 = -Infinity;
  let y0 = Infinity; let y1 = -Infinity;
  for (const c of cps) {
    x0 = Math.min(x0, c.x); x1 = Math.max(x1, c.x);
    z0 = Math.min(z0, c.z); z1 = Math.max(z1, c.z);
    y0 = Math.min(y0, c.y); y1 = Math.max(y1, c.y);
  }
  const cx = (x0 + x1) / 2; const cz = (z0 + z1) / 2;
  let r = 0;
  for (const c of cps) r = Math.max(r, Math.hypot(c.x - cx, c.z - cz));
  return {
    x: cx, y: (y0 + y1) / 2, z: cz,
    radius: Math.ceil(r + margin),
    yTolerance: (y1 - y0) / 2 + margin,
  };
}

/* ------------------------------------------------------------------ */
/* The circuit                                                         */
/* ------------------------------------------------------------------ */

/**
 * THE DRAGON LINE - the vale's one closed circuit, flown.
 *
 * ── Which loop, and why there is only one ─────────────────────────────────
 * `TrackPath` closes its sample list implicitly, so a circuit has to be a
 * genuine cycle of the road graph. `RoadNet` is a tree with two crossings, and
 * it holds exactly three cycles: a 180 m knot round Harrowgate's ford and its
 * bridge, a 1.9 km grand tour of both banks, and this one - the high road out
 * of Aldermoor, the east road to Harrowgate Ford, the Fenwick road to the
 * far-bank junction, the far-bank track home, and the Aldern Bridge. 773 m,
 * both river crossings, five of the vale's places.
 *
 * ── Why it is smoothed, and by how much ───────────────────────────────────
 * A racing line is not a road centreline. Raw, the chain's tightest corner is
 * 4.2 m of radius at the Aldermoor junction, where the bridge road arrives
 * southbound and the high road leaves east - a 103 degree turn in 6.3 m, which
 * is a village corner and not a corner any racing machine in this game can
 * take. Sixteen Chaikin passes open it to 11.2 m while pulling the line no
 * further than 6.5 m off a carriageway - and that worst case IS that corner,
 * at (38.6, 28.6), where the line cuts the inside of the turn over the edge of
 * the market the way a racing line does. Everywhere else it is inside 4 m. The
 * one exception is the Aldern Bridge, where the road ribbon genuinely stops
 * for 26 m and the masonry deck carries the line across.
 *
 * ── Why it is a DRAGON circuit and nothing else ───────────────────────────
 * This is the measurement the horse race died on, and it is worth stating
 * precisely because the brief asked for a horse.
 *
 * Best clean two-lap laps on this exact line, driven by the same optimising
 * driver `race-pace.test.mjs` uses, against the real `RacerField` at seed
 * 1234, as a ratio of the fastest rival's lap (under 1 means the player wins):
 *
 *                   ROOKIE   CONTENDER   APEX
 *     horse          1.549     2.053     2.320
 *     dragon         0.814     1.079     1.219
 *     (Vellum, dragon, for comparison)
 *                    0.810     1.055     1.180
 *
 * The dragon reproduces Vellum's shape to two decimal places - winnable on
 * ROOKIE, a fight on CONTENDER, out of reach on APEX - on a calibration that
 * is already measured and already gated. The horse loses to the EASIEST band
 * by 55%, and it is not close: it tops out at 15.5 m/s against a `REF_TOP` of
 * 33.5, and its one advantage - an 18.2 m turning radius against the car's
 * 85.6 - buys nothing here, because the rivals' own corner law already holds
 * them under their ceiling on an 11 m corner. Making it raceable needs a
 * second field calibration, a horse body in `RacerAI`, a horse footprint in
 * `Contacts` and a race-type blurb in `RaceUI` - a feature, not a descriptor -
 * so the vale publishes the race it can hold honestly and `raceTypes` says so.
 *
 * `startGrid` is deliberately empty. `RaceManager._install` derives twenty
 * slots from the installed `TrackPath`'s own frame whenever a world publishes
 * fewer, which is both the documented behaviour and a better grid than twenty
 * hand-typed coordinates could be.
 */
export const VALE_LINE = {
  id: 'vale-line',
  name: 'The Dragon Line',
  blurb: 'Aldermoor to Harrowgate Ford and home over the Aldern',
  /** `[roadKey, firstControlPoint, lastControlPoint]`, in running order. */
  legs: [
    ['high', 0, 4],
    ['eastway', 0, 8],
    ['harrowgate', 0, 5],
    ['fenwickway', 0, 6],
    ['farbank', 8, 0],
    ['bridgeS', 3, 0],
    ['bridgeN', 4, 0],
  ],
  /** Control-point spacing before smoothing, metres. */
  spacing: 6,
  /** Chaikin passes. See the note above for why sixteen. */
  smoothing: 16,
  /** Checkpoints the circuit publishes; a dragon race replaces them with rings. */
  checkpoints: 8,
  laps: 3,
};

const ROAD_BY_KEY = new Map(ROADS.map((r) => [r.key, r]));
const ALDERN = CROSSINGS.find((c) => c.id === 'aldern-bridge');

/**
 * Height for a circuit sample: the Aldern Bridge deck over its span, soil
 * everywhere else.
 *
 * The channel under that deck bottoms out at -1.37 m and the road ribbon does
 * not cross it - `bridgeN` stops at z = 103 and `bridgeS` restarts at z = 129,
 * with 26 m of masonry between. A centreline that took `medievalHeight` there
 * would dive through the riverbed, which is where the grid is derived and
 * where a car race would have been placed.
 */
export function circuitY(x, z) {
  const onDeck = Math.abs(x - ALDERN.x) < ALDERN.width * 0.5 + 3
    && z > ALDERN.from[1] - 2 && z < ALDERN.to[1] + 2;
  return onDeck ? ALDERN.deckY : medievalHeight(x, z);
}

/** One Chaikin-style averaging pass over a closed ring. */
function smoothRing(pts) {
  const n = pts.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n];
    const b = pts[i];
    const c = pts[(i + 1) % n];
    out[i] = {
      x: (a.x + 2 * b.x + c.x) / 4,
      z: (a.z + 2 * b.z + c.z) / 4,
      width: (a.width + 2 * b.width + c.width) / 4,
    };
  }
  return out;
}

/**
 * The circuit centreline: `{x, y, z, width}` samples, closed.
 *
 * Pure: the same ring for the same road table, every run, with no RNG and no
 * renderer. That is what lets `medieval-objectives.test.mjs` measure its
 * length, its tightest corner and how far it strays from a carriageway
 * without building anything.
 */
export function valeLine(def = VALE_LINE) {
  const ctrl = [];
  for (const [key, a, b] of def.legs) {
    const road = ROAD_BY_KEY.get(key);
    if (!road) continue;
    const step = a <= b ? 1 : -1;
    for (let i = a; step > 0 ? i <= b : i >= b; i += step) {
      const p = road.pts[i];
      const last = ctrl[ctrl.length - 1];
      if (last && Math.hypot(last.x - p[0], last.z - p[1]) < 0.5) continue;
      ctrl.push({ x: p[0], z: p[1], width: road.width });
    }
  }
  // Resample the closed control polygon at a uniform spacing, so the smoother
  // sees a ring of even chords rather than one dominated by the longest road.
  const dense = [];
  for (let i = 0; i < ctrl.length; i++) {
    const a = ctrl[i];
    const b = ctrl[(i + 1) % ctrl.length];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const k = Math.max(1, Math.round(len / def.spacing));
    for (let j = 0; j < k; j++) {
      const t = j / k;
      dense.push({
        x: a.x + (b.x - a.x) * t,
        z: a.z + (b.z - a.z) * t,
        width: a.width + (b.width - a.width) * t,
      });
    }
  }
  let ring = dense;
  for (let i = 0; i < def.smoothing; i++) ring = smoothRing(ring);
  return ring.map((p) => ({ x: p.x, y: circuitY(p.x, p.z), z: p.z, width: p.width }));
}

/** Evenly spaced checkpoints round a centreline, in running order. */
export function circuitCheckpoints(path, count = VALE_LINE.checkpoints) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const p = path[Math.round((i * path.length) / count) % path.length];
    out.push({ x: p.x, y: p.y, z: p.z, radius: 12 });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Publication                                                         */
/* ------------------------------------------------------------------ */

/**
 * Hang every descriptor on the world.
 *
 * Called once at the end of the build. Draws no RNG, reads no collider and
 * allocates nothing that outlives the world, so it can be called from anywhere
 * after the roads exist without disturbing a single placement.
 *
 * ── The venue catalogue is a SOURCE LITERAL and that is load-bearing ──────
 * `scripts/quest-vocab.mjs` scrapes venue ids out of SOURCE with
 * `/\.minigameVenues\s*=\s*\[/` and walks the object literals inside the
 * brackets. `CitadelWorld` learned this the expensive way: seven venues built
 * by `push({...})` inside two methods were invisible to the vocabulary, so
 * every quest step naming a citadel trial was rejected as an invented target.
 * The array below is therefore written out, in this file, which is one of the
 * medieval world's own files (`quest-vocab` walks `src/worlds/<id>` as well as
 * the world file itself). Ids are `[a-z0-9_]+` because that is the character
 * class the scraper's own regex accepts - a hyphen would be dropped silently.
 *
 * @param {object} world the built `MedievalWorld`
 */
export function medievalObjectives(world) {
  world.viewpoints = VIEWPOINTS.map((v) => ({ ...v }));

  const pilgrim = trialCheckpoints('pilgrim');
  const grimscar = trialCheckpoints('grimscar');
  const poacher = trialCheckpoints('poacher');

  /* ── The three trials ──────────────────────────────────────────────────
   *
   * `kind: 'rooftop'` because `RooftopTrial` is the checkpoint-chain engine
   * and it is not actually about roofs: it reads `config.checkpoints` and
   * `config.ringRadius`, strips per-checkpoint `yGate`, and asks nothing about
   * what is under the route. The seven citadel venues are the template.
   *
   * NO `requires: 'parkour'`. The citadel's seven all carry it and are right
   * to - they are roof crossings. These are three things to run on the ground,
   * and gating them on a movement rule they never use would only mean that a
   * world which switched parkour off would lose its footraces.
   *
   * `ringRadius` is 3.0 rather than the module's 2.6 default, and 2.6 is not a
   * general number: the citadel chose it because `RaceRings` hard-codes the
   * dragon race's 5.2 m torus and most souk roofs are narrower than that. A
   * road is wider than a roof and a checkpoint 30 m from the last one on open
   * farmland wants to be a gate rather than a keyhole.
   *
   * `routeLength` is the summed 3D chain, which is what `parTimes` divides by
   * `REF_PACE`. Passing it explicitly rather than letting the module recompute
   * it changes nothing today and pins the par to a number this file's own gate
   * measures.
   *
   * The rewards are in the LEGACY BAND (under `MINIGAME_LEGACY_BAND_MAX` = 20)
   * like every other venue in the game, so `venuePrize` scales them by
   * `MINIGAME_REWARD_SCALE` and one constant still moves every contest in the
   * Nexus together: 16 -> 192 CR, 12 -> 144, 10 -> 120. Written as 192/144/120
   * they would be taken literally and would silently stop tracking that
   * constant - and the first draft did exactly that, at 260 CR, which put a
   * medieval footrace above "The Long Water", the hardest trial in the game, on
   * a faucet the mission-architecture note calls out as already too open.
   * Ranked by what they ask: 550 m against 286 m against 225 m.
   */
  const pilgrimAt = venueDisc(pilgrim);
  const grimscarAt = venueDisc(grimscar);
  const poacherAt = venueDisc(poacher);

  world.minigameVenues = [
    {
      id: 'medieval_pilgrim_road',
      kind: 'rooftop',
      label: 'The Pilgrim Road',
      centre: { x: pilgrimAt.x, y: pilgrimAt.y, z: pilgrimAt.z },
      radius: pilgrimAt.radius,
      yTolerance: pilgrimAt.yTolerance,
      reward: 16,
      rival: { name: 'Brother Wystan' },
      config: { checkpoints: pilgrim, ringRadius: 3.0, routeLength: chainLength(pilgrim) },
    },
    {
      id: 'medieval_grimscar_descent',
      kind: 'rooftop',
      label: 'The Grimscar Descent',
      centre: { x: grimscarAt.x, y: grimscarAt.y, z: grimscarAt.z },
      radius: grimscarAt.radius,
      yTolerance: grimscarAt.yTolerance,
      reward: 12,
      rival: { name: 'Nan Corbey, pit captain' },
      config: { checkpoints: grimscar, ringRadius: 3.0, routeLength: chainLength(grimscar) },
    },
    {
      id: 'medieval_poachers_line',
      kind: 'rooftop',
      label: "The Poacher's Line",
      centre: { x: poacherAt.x, y: poacherAt.y, z: poacherAt.z },
      radius: poacherAt.radius,
      yTolerance: poacherAt.yTolerance,
      reward: 10,
      rival: { name: 'Hobb the Quiet' },
      config: { checkpoints: poacher, ringRadius: 3.0, routeLength: chainLength(poacher) },
    },
  ];

  /* ── The circuit ───────────────────────────────────────────────────────
   *
   * `circuits` AND `difficulties` both, because `Charters` learns the record
   * column as `circuits.length * difficulties.length` and would DELETE a
   * column whose denominator came out zero - so a world that published the
   * circuit alone would light nothing at all. */
  const path = valeLine();
  world.trackPath = path;
  world.checkpoints = circuitCheckpoints(path);
  world.startGrid = [];
  world.lapCount = VALE_LINE.laps;
  world.difficulties = ['easy', 'standard', 'expert'];
  world.raceTypes = ['dragon'];
  world.activeTrackId = VALE_LINE.id;
  world.circuits = [{ id: VALE_LINE.id, name: VALE_LINE.name, blurb: VALE_LINE.blurb }];
  world.tracks = [{
    id: VALE_LINE.id,
    name: VALE_LINE.name,
    blurb: VALE_LINE.blurb,
    laps: VALE_LINE.laps,
  }];
}
