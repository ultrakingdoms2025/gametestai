/**
 * Aldermoor Vale's woodland: where the trees are, how thick they stand, and
 * how the world is allowed to spend triangles on them.
 *
 * Nothing in this file may import `three` or touch the DOM.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS MODULE EXISTS TO FIX
 *
 * The scatter in `_buildNature` placed an ABSOLUTE 520 playfield trees and an
 * absolute 264 ridge conifers, gated on `fbm2(x * 0.0062, z * 0.0062, 3) >
 * 0.02`. Both numbers were tuned against a 400 m vale. The vale is now 900 m,
 * so the same 520 trees are spread over 5.06x the ground: what used to be
 * woodland is now 0.6 trees per hectare of "woodland", which is not a wood, it
 * is an orchard with the trees taken out. Nothing reported it, because a
 * sparse forest looks exactly like a forest that was authored sparse.
 *
 * So the count is derived here rather than authored: a DENSITY, multiplied by
 * the stand-weighted area of the map, integrated once at module load. Resize
 * the vale and the forest resizes with it; move the mask and the budget
 * follows. `PLAYFIELD_TREES` is the answer, not the input.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES A FOREST READ AS A FOREST
 *
 * Three things, and only one of them is trees.
 *
 *   1. A SHAPED MASK, not a threshold. `> 0.02` gives a binary field with a
 *      ragged pixel-level boundary and no interior: every tree in it has the
 *      same neighbourhood statistics as every other, so the wood has no edge
 *      to arrive at and no depth to walk into. `standAt` ramps over the mask
 *      instead, so density climbs across a 30-60 m fringe and then holds.
 *
 *   2. CLEARINGS. A wood with no gaps is a wall; a wood with gaps is a place.
 *      The glade term below is a second, ~50 m-wavelength noise that removes
 *      90% of the density where it is high, which punches irregular open
 *      ground through the interior rather than thinning it uniformly.
 *
 *   3. AN UNDERSTOREY. This is the one that actually buys enclosure, and it
 *      is the cheap one. A crown is 2,880-4,560 triangles and sits 4-11 m up,
 *      where it blocks the sky and nothing else; a 2.4 m hazel thicket is SIX
 *      triangles - three crossed cards, one quad each - and blocks the thing
 *      that matters, which is the line from a player's eye to a wolf's. The
 *      whole understorey - thickets AND bracken, which share one geometry and
 *      one mesh - is 58,278 triangles against the canopy's 3,700,800, i.e.
 *      1.6% of the forest's triangle bill for most of its cover. The budgets
 *      below are sized on that arithmetic: 2.8x the trees, and an understorey
 *      that did not exist.
 *
 *   4. AND BEING SOMEWHERE THE PLAYER GOES. The three above are about what a
 *      wood is like once you are in it; this one is about whether you ever
 *      are. The noise put no closed canopy in the starting valley at all, and
 *      because `Wildlife` gates predator homes on this very mask, that made
 *      the valley structurally incapable of holding a wolf - which is what the
 *      player reported. `AUTHORED_WOODS` below is the answer, and it is a term
 *      of the mask rather than a special case bolted beside it, so everything
 *      derived from the mask picks the new wood up for free.
 */

import { fbm2, smoothstep, clamp01, HALF } from '../terrain/MedievalHeight.js';

/* ------------------------------------------------------------------ */
/* The mask                                                            */
/* ------------------------------------------------------------------ */

/**
 * Spatial frequency of the woodland mask.
 *
 * Unchanged from the value the vale shipped with - the WOODS are in the right
 * places, it is their density and their edges that were wrong - so the named
 * woods below sit exactly where a player who has walked the old build expects
 * them. Exported so the world cannot spell it a second time.
 */
export const WOOD_FREQ = 0.0062;

/**
 * Woods that are AUTHORED into the mask rather than found in it.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS SUCH A TABLE AT ALL
 *
 * The noise put its woods where it put them, and one place it did not put one
 * is the starting valley. That is not a cosmetic gap. `Wildlife.rejectHome`
 * requires `woodMask > DEEP_WOOD` before a predator may live anywhere, so a
 * valley with no closed canopy in it is a valley with no legal wolf home in it
 * - measured, on a 4 m lattice over the original 400 m vale, at exactly ZERO -
 * and the player reported the consequence: "i do not see any wolves or bears in
 * the forest areas".
 *
 * Every other lever was tried first and each one is a safety parameter. The
 * cordons, `MARGIN` and `reach` are what keep a pack off a questmaster; the
 * road clearance is what makes a road a road. See the header of `Wildlife.js`
 * for the measurements that killed them. What was left is the honest one: if
 * the starting valley should have a wood in it, AUTHOR a wood in it.
 *
 * ---------------------------------------------------------------------------
 * WHAT AN ENTRY IS
 *
 * A bounded local lift of the mask: `amp` at the centre, zero at `r` and
 * beyond, smooth in between. It is a term of the SAME field, not a second one -
 * which is the whole point. `standAt`, `STAND_AREA`, the tree, understorey and
 * bracken budgets, the deadfall districts and the beast legality gate are all
 * functions of `woodMask`, so an entry here buys all of them at once and none
 * of them has to be told about it. Adding this wood moved `STAND_AREA` from
 * 138,985 to 142,831 m2 and the derived budgets from 1,251/4,448/5,003 trees,
 * thickets and bracken to 1,285/4,571/5,142, with nothing hand-tuned. The wood
 * itself is 3,435 m2 of closed canopy - 0.34 ha - and 5,671 m2 of ground over
 * `DEEP_WOOD`.
 *
 * ---------------------------------------------------------------------------
 * AND WHAT ELSE IT MOVED, DECLARED RATHER THAN DISCOVERED
 *
 * `Treasures.planForestCaches` also gates on this mask (`> DEEP_WOOD + 0.03`)
 * and TIERS on it (`> 0.30` prize, `> 0.23` rare), so lifting the mask moves
 * the treasure draw as well as the trees. Measured, by ablating this table and
 * re-planning:
 *
 *   the count is unchanged at 16, and so is the ORDER of every other record.
 *     The dart stream is the same stream; what changes is that one more dart is
 *     now legal. `woodcache@-112,95` is accepted fifth and `woodcache@-260,-67`
 *     falls off the end of the 16-cap - at `want: 20` the map yields 17 sites
 *     with this wood and 16 without, and the two lists agree everywhere else.
 *   the tier mix goes from 1 prize / 4 rare / 11 common to 1 / 5 / 10. The new
 *     cache reads wood 0.287, which is `rare`; nothing was promoted.
 *   relic sites are untouched - 84, identical labels - because
 *     `planRelicSites` does not consult the woodland mask at all.
 *   no cache is duplicated and every one is still reachable on foot from the
 *     spawn, which `medieval-treasure.test.mjs` already gates.
 *
 * It is deliberately NOT a change to `medievalHeight`. The terrain function
 * runs in a worker and must stay pure and cheap; the ground at Hazelbrake was
 * already suitable - `settledAt` 0 over the whole disc, no hero clearance,
 * median height 3.1 m against a 2.05 m flood line, median slope 0.084 against
 * the scatter's 0.55 limit - so what was missing was trees, and trees are this
 * module's business. The disc's southern edge does overhang the channel, and
 * nothing had to be done about that either: `_isOpenGround` refuses to plant
 * below `WATER_Y + 0.5` or within `riverHalfWidth + 2`, and `rejectHome`
 * refuses to house a beast below the flood line or within 14 m of the channel.
 *
 * ---------------------------------------------------------------------------
 * THE AMPLITUDE IS LARGE ON PURPOSE, AND THE RADIUS IS SMALL ON PURPOSE
 *
 * `amp` 0.65 against a natural mask that runs -0.35..0.34 is an override, not a
 * nudge, and it has to be: the base mask across Hazelbrake's disc runs
 * -0.260..0.268 with -0.041 at the centre, and `DEEP_WOOD` is 0.16. (The upper
 * end is 0.2681, sampled at 0.25 m; a 1 m lattice misses the peak and reads
 * 0.264.) A lift that merely grazed the threshold would produce a wood whose
 * legal ground was a handful of scattered cells, and the dart stream would miss
 * it - the pool is 20,000 darts over 810,000 m2, one dart per 40 m2.
 *
 * `r` 65 is the number that took the most measuring, and it is CAPPED rather
 * than chosen. `Wildlife.planBeasts` sorts its pool by road distance, so a pack
 * lands at the wood's LOWEST road-edge point - and to the north-west of here
 * the nearest road is `pilgrimway` or `westway`, not one of the vale's own. Two
 * measured counter-examples, both of which reproduce the exact bug this wood
 * exists to fix:
 *
 *   centre (-135, 125) amp 0.65 r 60   pack at (-157.4, 156.5), 140.6 m from
 *   centre (-130, 130) amp 0.60 r 60   the nearest core-vale road node
 *
 * Both put the pack outside the 125 m at which `NPCManager` lets a streamed
 * character APPEAR - see the note in `Wildlife.js` on why that number is 125
 * and not 135 - i.e. streamed and never drawn.
 *
 * ROW ONE is the sharper warning, because it differs from a configuration that
 * WORKS only in the AMPLITUDE. At centre (-135, 125) the mask at the bad dart
 * reads 0.1542 with amp 0.60 and 0.1687 with amp 0.65, so 0.65 lifts that one
 * cell over `DEEP_WOOD` and 0.60 does not, and lifting it is what loses the
 * wood. Row two is a different mechanism and must not be read as the same one:
 * at centre (-130, 130) the bad dart reads 0.1616 at amp 0.60 and 0.1767 at
 * 0.65, i.e. it is legal under BOTH, and what fails there is the centre.
 *
 * The bad dart's nearest road is `pilgrimway`, at 79.6 m - not `westway`, which
 * is 126.7 m from it. `westway` is the GOOD dart's own nearest road, at 84.0 m,
 * and a wolf reaches 68: which is precisely why the shipped pack watches no
 * road at all and the bad one would have watched a road no core-vale player
 * walks. A BIGGER WOOD IS A WORSE WOOD, and it fails silently.
 *
 * So the property that had to be measured is not where the pack lands - that is
 * one dart out of a stream - but where it CAN land. Every cell of a 2 m lattice
 * inside this disc that `rejectHome` accepts for either species is within
 * 119.1 m of a core-vale road node, against the 125 m appearance radius. No
 * dart, wherever the stream puts it, can be streamed-but-never-drawn.
 * `medieval-wildlife.test.mjs` asserts that over the whole wood rather than
 * over today's placement, which is the only form of it that survives a reseed.
 */
export const AUTHORED_WOODS = [
  { id: 'hazelbrake', x: -110, z: 125, amp: 0.65, r: 65 },
];

/**
 * How much the authored woods raise the mask at (x, z). Zero almost everywhere.
 *
 * `1 - smoothstep(0, 1, d / r)` rather than a cone, because the mask feeds
 * `standAt`, which ramps it over 0.15 - a cone's apex and rim would both show
 * up as a crease in the canopy density. This profile is flat at both ends, so
 * its steepest point is the middle of the fringe, which is where a real wood's
 * density changes fastest anyway. Peak gradient is `1.5 * amp / r` = 0.015 of
 * mask per metre; `medieval-forest.test.mjs` bounds what that does to the
 * canopy edge and measures it at 0.201 against a limit of 0.30.
 */
export function authoredLift(x, z) {
  let lift = 0;
  for (const a of AUTHORED_WOODS) {
    const d = Math.hypot(x - a.x, z - a.z);
    if (d >= a.r) continue;
    lift += a.amp * (1 - smoothstep(0, 1, d / a.r));
  }
  return lift;
}

/**
 * The woodland mask: fbm noise, plus the authored woods above.
 *
 * Roughly -0.35..0.34 over the map from the noise alone, median 0.01, reaching
 * 0.609 at Hazelbrake's centre where the authored term is added.
 *
 * THIS IS THE ONLY DEFINITION. `Wildlife.woodlandAt` used to spell the fbm term
 * out a second time and is now bound to this function by identity - see the
 * note there. Two copies of a mask is two woods, and the one the beasts use is
 * the one that decides whether the player ever meets anything.
 */
export function woodMask(x, z) {
  return fbm2(x * WOOD_FREQ, z * WOOD_FREQ, WOOD_OCTAVES) + authoredLift(x, z);
}
export const WOOD_OCTAVES = 3;

/**
 * Where the canopy starts and where it closes.
 *
 * Measured against the mask's own quantiles over the 900 m map (p50 0.01,
 * p75 0.12, p90 0.21): 0.07 is a little above the third quartile and 0.22 a
 * little above the ninth decile, which puts 10.8% of the map under closed
 * canopy and about a quarter of it under some canopy. The 0.15 of mask between
 * the two edges corresponds to 30-70 m of ground, which is the fringe width -
 * long enough to walk into and notice, short enough that a wood still has a
 * silhouette from across the vale.
 *
 * The old `> 0.02` threshold is the degenerate case of this with both edges
 * equal: 47% of the map at uniform density and no edge anywhere.
 */
export const EDGE_LO = 0.07;
export const EDGE_HI = 0.22;

/** Glade noise: ~50 m wavelength, offset so it does not correlate with the mask. */
export const GLADE_FREQ = 0.0195;
export const GLADE_LO = 0.10;
export const GLADE_HI = 0.24;
/** How much of the stand a full glade removes. Not 1: a clearing has strays. */
export const GLADE_CUT = 0.90;

/**
 * Stand density at a point: 0 open ground, 1 closed canopy.
 *
 * This is the ONE authority. The tree scatter accepts a candidate with
 * probability `standAt`, the understorey and bracken scatters use it as their
 * gate, the deadfall uses it to find interiors, and the tests integrate it to
 * check the budget. Two copies of a density field is two things to keep in
 * step and one of them would eventually seed bracken in a meadow.
 */
export function standAt(x, z) {
  const s = smoothstep(EDGE_LO, EDGE_HI, woodMask(x, z));
  if (s <= 0) return 0;
  const glade = smoothstep(GLADE_LO, GLADE_HI, fbm2(x * GLADE_FREQ + 11.4, z * GLADE_FREQ - 7.7, 2));
  return s * (1 - GLADE_CUT * glade);
}

/**
 * True on the readable fringe of a wood - canopy present but not closed.
 *
 * Used to put the thorn and bramble scrub where a real wood puts it. A
 * woodland edge in an unfenced landscape is not a line, it is a 10-20 m belt
 * of blackthorn that is impassable at knee height, and that belt is the single
 * clearest signal that the trees behind it are a WOOD rather than a scatter.
 */
export function isWoodEdge(x, z) {
  const s = standAt(x, z);
  return s > 0.12 && s < 0.72;
}

/* ------------------------------------------------------------------ */
/* The budget                                                          */
/* ------------------------------------------------------------------ */

/**
 * Stand-weighted area of the playfield, square metres, integrated at load.
 *
 * A 4 m grid over 900 x 900 m is 50,625 samples and about 12 ms - paid once,
 * on a module that is already imported before the loading screen finishes its
 * first frame. Coarser would be cheaper and would also stop resolving the
 * glades, which are the term this integral exists to account for.
 *
 * It is computed rather than pinned because that is the entire point: the
 * number is a FUNCTION of the mask and the extent, and the failure this module
 * exists to fix was a constant that stopped being a function of either.
 */
export const STAND_GRID = 4;
export const STAND_AREA = (() => {
  let sum = 0;
  let n = 0;
  for (let z = -HALF; z < HALF; z += STAND_GRID) {
    for (let x = -HALF; x < HALF; x += STAND_GRID) {
      sum += standAt(x, z);
      n++;
    }
  }
  return (sum / n) * (HALF * 2) * (HALF * 2);
})();

/**
 * Trees per square metre of CLOSED canopy.
 *
 * 0.0090 is a 10.5 m mean spacing under full stand. Against crowns 3-5 m across
 * for the broadleaves and 7 m for the firs, that is a canopy which touches but
 * does not merge - which is what a managed medieval wood looks like, and it is
 * as far as the triangle budget will go: a crown is 2,880-4,560 triangles, so
 * every 0.001 added here is another 140 trees and another half a million
 * triangles in the scene.
 *
 * Closing the canopy further is the understorey's job. See the note at the
 * top of this file for why that trade is the right way round.
 */
export const TREE_DENSITY = 0.0090;

/** Playfield trees, derived. ~1,450 at 900 m against the old absolute 520. */
export const PLAYFIELD_TREES = Math.round(STAND_AREA * TREE_DENSITY);

/**
 * Understorey clumps - hazel, holly and young ash, 1.8-3.2 m.
 *
 * Three crossed cards each, and a card is ONE quad - `planeGeo(w, h, 0)` with
 * the default single segment - so SIX triangles, not twelve. That number has
 * been wrong in three docstrings and right in the one place it is used:
 * `medieval-forest.test.mjs` sets `CARD_TRIS = 6`, and at twelve its own
 * assertion would fail, because (4,571 + 5,142) thickets and bracken at twelve
 * is 116,556 triangles against a limit of 74,016. At six it is 58,278.
 *
 * The whole understorey is cheaper than ten oaks and it is the only thing in
 * the wood that stands between a player's eye level and a wolf's.
 */
/*
 * 0.0320 is a 5.6 m mean spacing under full stand - four times the trees.
 *
 * Measured against the thing it is for. A 40 m sightline through closed
 * canopy sweeps ~60 m2 at a stem width of 1.5 m; at the tree density alone
 * that crosses 0.8 stems, which means a wolf standing forty metres away in
 * the middle of a wood is visible about half the time. Adding thickets at
 * this density takes it past 1.5 and the wood starts concealing things.
 *
 * The thickets cost 27,426 triangles across the whole map - 4,571 at six each -
 * and 58,278 with `BRACKEN` on the same geometry, which is how the renderer
 * actually pays for them. Buying the same closure with crowns would have cost
 * about four million: the canopy's own bill is 1,285 trees at 2,880 triangles
 * for the cheapest crown, 3,700,800.
 */
export const UNDERSTOREY_DENSITY = 0.0320;
export const UNDERSTOREY = Math.round(STAND_AREA * UNDERSTOREY_DENSITY);

/** Bracken and dog's mercury on the woodland floor. Ground cover, not cover. */
export const BRACKEN_DENSITY = 0.0360;
export const BRACKEN = Math.round(STAND_AREA * BRACKEN_DENSITY);

/**
 * Bucket size for the tree instancing grid, metres.
 *
 * The vale bucketed playfield trees by MAP QUADRANT, and the docstring on
 * `CANOPY_LO_DISTANCE` is honest about what that bought: a quadrant's bounding
 * sphere has a 318 m radius at 900 m, its nearest point is underfoot from
 * almost anywhere, and the 90 m canopy LOD swap therefore never fires. Four
 * buckets was also never going to frustum-cull - a bucket that covers a
 * quarter of the map is in view whenever you face that quarter.
 *
 * 150 m is chosen against the swap distance, not by taste. A 150 m cell's
 * bounding sphere is 106 m across the diagonal plus ~8 m of crown, so its
 * nearest point is 90 m away once the camera is ~204 m from the cell centre -
 * and on a 900 m map, from any given standpoint, most cells are. The swap
 * therefore fires for the far two thirds of the wood, which is a 4x cut on
 * broadleaf crowns exactly where the facet count is unrecoverable.
 *
 * The bill is draw calls, and it is real: 36 cells instead of 4. `STAND_SPECIES`
 * below is what keeps it bounded.
 */
export const TREE_BUCKET_M = 150;
export const TREE_BUCKETS = Math.round((HALF * 2) / TREE_BUCKET_M);

/**
 * How many archetypes a single bucket may use.
 *
 * Two, and it is a rendering constraint that happens to be good silviculture.
 * Four species x thirty-six buckets is 144 instanced meshes and 288 draw calls
 * with shadows, which is not a price worth paying for a forest. Two species
 * halves it - and a real wood IS two species: an oak-hazel wood, an ash-birch
 * wood, a pine plantation. A stand where all four grow evenly mixed is the
 * thing that reads as procedural.
 *
 * The pair a bucket gets is a pure function of its index (see `standSpecies`),
 * so it is stable across reloads and identical in the tests.
 */
export const STAND_SPECIES = 2;

/**
 * The two archetype indices a bucket is planted with.
 *
 * Indices are into `_buildNature`'s archetype table: 0 oak, 1 birch, 2 pine,
 * 3 willow. Willow is never a stand species - it is a bankside tree and is
 * placed by the riparian rule instead - so the pairs below draw from the other
 * three, with the mix chosen by the bucket's own mask value so the pine
 * plantations land on the high ground the mask already puts them on.
 *
 * @param {number} bx @param {number} bz bucket indices
 * @param {number} mask mean woodland mask over the bucket
 */
export function standSpecies(bx, bz, mask) {
  // A cheap stable hash of the bucket, so neighbouring stands differ.
  const h = ((bx * 73856093) ^ (bz * 19349663)) >>> 0;
  if (mask > 0.19) return (h & 1) ? [2, 1] : [2, 0];   // fir-dominated high ground
  if (mask > 0.13) return (h & 1) ? [0, 2] : [1, 2];   // mixed, some fir
  return (h & 1) ? [0, 1] : [1, 0];                     // oak and birch
}

/* ------------------------------------------------------------------ */
/* The named woods                                                     */
/* ------------------------------------------------------------------ */

/**
 * The woods that get a name, a deadfall district and a place on the map.
 *
 * The first six are centred on peaks of the NOISE rather than authored over the
 * top of it: those are the woods the vale already had, simply now dense enough
 * to be called something. Hazelbrake is the exception and is marked as one - it
 * is centred on an entry of `AUTHORED_WOODS`, which is a peak this module put
 * there. Both kinds have to clear the same floors, and
 * `medieval-forest.test.mjs` applies them to every row without caring which is
 * which: closed centre, mean stand over the radius, and a real closed-canopy
 * interior. An authored wood that could not pass them would be a name on a
 * field.
 *
 * `r` is the radius the deadfall district and the beast-spawn hint use; it is
 * not a boundary, the mask is. Hazelbrake's 55 is set INSIDE its 65 m authored
 * radius rather than equal to it, because the deadfall wants the part of the
 * disc that is actually wood: at 55 the district averages stand 0.44 and is
 * 33.4% closed canopy, at 65 it is 0.35 and 25.9%, and the outer ten metres are
 * the fringe the lift tapers through.
 *
 * `bank` says which side of the river the wood is on, because that is the
 * question the camp placement and the wildlife both need answered and it is
 * not readable from the coordinates: the river's centreline swings 120 m
 * across the map. Hazelbrake is `far` - the channel runs through z = 78.3 at
 * x = -110, so the wood stands about forty metres north of the water, on the
 * same bank as Bell Coppice and 124.5 m from its centre - the non-overlap rule
 * in `medieval-forest.test.mjs` wants more than (55 + 70) * 0.6 = 75.0 m, so it
 * passes with 49.5 m to spare.
 */
export const NAMED_WOODS = [
  { id: 'ravenshaw', name: 'Ravenshaw', x: -119, z: -78, r: 92, bank: 'vale', kind: 'oakwood' },
  { id: 'harrowgate-chase', name: 'Harrowgate Chase', x: 362, z: -92, r: 78, bank: 'vale', kind: 'mixed' },
  { id: 'ninewells', name: 'Ninewells Wood', x: 230, z: 166, r: 74, bank: 'far', kind: 'oakwood' },
  { id: 'bell-coppice', name: 'Bell Coppice', x: -188, z: 222, r: 70, bank: 'far', kind: 'coppice' },
  { id: 'thornhow', name: 'Thornhow Wood', x: -392, z: 414, r: 86, bank: 'far', kind: 'pinewood' },
  { id: 'coldashes', name: 'Cold Ashes', x: -196, z: -418, r: 74, bank: 'vale', kind: 'pinewood' },
  /* The vale's own wood, and the only authored one. Hazel because that is what
   * the understorey is made of and what a wood this young and this dense reads
   * as; "brake" is the Middle English for a thicket, and the word bracken comes
   * from it. See `AUTHORED_WOODS` for why it exists and why it is this size. */
  { id: 'hazelbrake', name: 'Hazelbrake', x: -110, z: 125, r: 55, bank: 'far', kind: 'oakwood', authored: true },
];

/** The named wood whose radius contains (x, z), nearest first, or null. */
export function woodAt(x, z) {
  let best = null;
  let bd = Infinity;
  for (const w of NAMED_WOODS) {
    const d = Math.hypot(x - w.x, z - w.z);
    if (d <= w.r && d < bd) { bd = d; best = w; }
  }
  return best;
}

/**
 * Deadfall pieces per named wood.
 *
 * Fallen trunks, root plates, stumps and brash piles. Merged into one district
 * per wood by `MedievalWorld`, so a wood is three draw calls whatever this
 * number is - which is why it can afford to be generous. Deadfall is the
 * cheapest possible signal that a wood has been standing for two hundred years
 * rather than being planted this morning.
 */
export const DEADFALL_PER_WOOD = 26;

/** Clamp helper re-exported so consumers do not reach past this module. */
export const woodClamp = clamp01;
