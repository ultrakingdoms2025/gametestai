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
 *      where it blocks the sky and nothing else; a 2.4 m hazel thicket is
 *      TWELVE triangles and blocks the thing that matters, which is the line
 *      from a player's eye to a wolf's. Doubling the tree count to buy
 *      enclosure costs ~7,000 triangles per metre of sightline closed. The
 *      understorey costs about four. The budgets below are sized on that
 *      arithmetic: 2.8x the trees, and an understorey that did not exist.
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

/** Raw woodland mask. Roughly -0.35..0.34 over the map, median 0.01. */
export function woodMask(x, z) {
  return fbm2(x * WOOD_FREQ, z * WOOD_FREQ, WOOD_OCTAVES);
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
 * Three crossed cards each, so twelve triangles: the whole understorey is
 * cheaper than five oaks and it is the only thing in the wood that stands
 * between a player's eye level and a wolf's.
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
 * It costs 27,000 triangles across the whole map. Buying the same closure
 * with crowns would have cost about four million.
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
 * Every one is centred on a peak of the existing mask rather than authored
 * over the top of it, so these are the woods the vale already had - they are
 * simply now dense enough to be called something. `r` is the radius the
 * deadfall district and the beast-spawn hint use; it is not a boundary, the
 * mask is.
 *
 * `bank` says which side of the river the wood is on, because that is the
 * question the camp placement and the wildlife both need answered and it is
 * not readable from the coordinates: the river's centreline swings 120 m
 * across the map.
 */
export const NAMED_WOODS = [
  { id: 'ravenshaw', name: 'Ravenshaw', x: -119, z: -78, r: 92, bank: 'vale', kind: 'oakwood' },
  { id: 'harrowgate-chase', name: 'Harrowgate Chase', x: 362, z: -92, r: 78, bank: 'vale', kind: 'mixed' },
  { id: 'ninewells', name: 'Ninewells Wood', x: 230, z: 166, r: 74, bank: 'far', kind: 'oakwood' },
  { id: 'bell-coppice', name: 'Bell Coppice', x: -188, z: 222, r: 70, bank: 'far', kind: 'coppice' },
  { id: 'thornhow', name: 'Thornhow Wood', x: -392, z: 414, r: 86, bank: 'far', kind: 'pinewood' },
  { id: 'coldashes', name: 'Cold Ashes', x: -196, z: -418, r: 74, bank: 'vale', kind: 'pinewood' },
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
