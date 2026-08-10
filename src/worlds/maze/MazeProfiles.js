/**
 * The pure numbers behind the maze's prefab geometry: how a descriptor's
 * half-extents are turned into the name of a shared geometry, and how many
 * such geometries the registry is ever allowed to hold.
 *
 * Pure - no THREE, no DOM - for exactly the reason `MazeFoliage.js` is: the
 * decisions here are arithmetic, and arithmetic that can be asserted under
 * `node --test` is arithmetic that stays correct. `MazeMeshes.js` is left
 * doing nothing but turning these numbers into a `BufferGeometry`.
 *
 * ## Why a quantiser exists at all
 *
 * The registry caches one geometry per (kind, extent class, LOD). Caching per
 * DESCRIPTOR instead would allocate one `BufferGeometry` per hedge segment -
 * about 20,000 at full residency - and the count would climb every time a
 * district streamed in. So descriptors have to be collapsed into classes.
 *
 * The surprise is what the quantiser is actually for. Measured across the
 * whole 20x20x4-district world, the maze emits 135 distinct (kind, extent)
 * classes and the *values* are already discrete - almost every one is a
 * multiple of 0.05 m, straight out of the MAZE constants. What is not discrete
 * is their floating-point spelling: the same 1.4 m floor slab arrives as
 * 1.3999999999999773 from one district and 1.4000000000000057 from the next,
 * because a slab's extent is the difference of two accumulated world
 * positions. Keyed on the raw number those are two geometries; keyed on the
 * class they are one. So this quantiser is a NOISE FILTER, not a coarsener,
 * and that is why the quantum can be as fine as a millimetre without the class
 * count moving at all. A coarse 1 cm quantum was the first instinct and buys
 * nothing here - the distinct sizes are 50 mm apart - while costing a full
 * centimetre of the shrink described below.
 *
 * ## Why it rounds DOWN
 *
 * A prefab must fit inside its descriptor's box. That single property is what
 * lets Phase 6 add visuals without re-running the enclosure proof, the
 * anti-ladder band scan or the containment flood fill: a visual that is a
 * SUBSET of its collider cannot create a standable surface the headless gates
 * never saw. Rounding to NEAREST would break it for real geometry in this
 * world - a stair tread's 0.1875 m half-height rounds up to 0.19 and the
 * tread then stands 2.5 mm proud of the box the physics knows about. Rounding
 * DOWN can only ever shrink, so the fit holds by construction rather than by
 * measurement, for every kind and every extent, including ones not invented
 * yet.
 *
 * The price is a gap of at most one quantum between abutting surfaces. At a
 * millimetre that is invisible at any distance a player can stand; at the
 * centimetre first considered it would have been a visible crack down every
 * corridor with the void showing through on the upper levels.
 */

/**
 * The grid a half-extent is snapped to before anything else, in metres.
 *
 * 0.1 mm - fine enough that it cannot merge two sizes this world actually
 * distinguishes, coarse enough to absorb the accumulated-subtraction noise
 * described above. Without this step `Math.floor` turns 0.09999999999999432
 * into 0.099 and loses a whole quantum to a rounding error.
 */
export const EXTENT_SNAP = 1e-4;

/** The class grid, in metres. See the module note on why down and why 1 mm. */
export const EXTENT_QUANTUM = 1e-3;

/** Snap and floor units, kept integral so no float formatting reaches the key. */
function extentUnits(h) {
  const snapped = Math.round(h / EXTENT_SNAP);
  const units = Math.floor(snapped * (EXTENT_SNAP / EXTENT_QUANTUM));
  /* A descriptor thinner than one quantum would otherwise floor to nothing and
   * render as a degenerate, invisible plane. Clamping keeps it visible at the
   * cost of standing a fraction of a millimetre proud of its box - so THE FIT
   * CONTRACT TEST IS THE TRIPWIRE for one ever appearing, and it will fail
   * loudly rather than let a sliver of unstandable surface ship. No descriptor
   * in this world is anywhere near it: the thinnest is 0.1 m. */
  return units > 0 ? units : 1;
}

/**
 * The half-extent a prefab is actually built to, in metres. Never larger than
 * the descriptor's own.
 */
export function quantiseExtent(h) {
  return extentUnits(h) * EXTENT_QUANTUM;
}

/**
 * The registry's cache name for a box of these half-extents.
 *
 * Integer millimetres rather than formatted floats, so two spellings of the
 * same size cannot produce two keys the way `String(1.4000000000000057)` and
 * `String(1.3999999999999773)` would.
 */
export function extentClass(hx, hy, hz) {
  return `${extentUnits(hx)}x${extentUnits(hy)}x${extentUnits(hz)}`;
}

/**
 * The most distinct geometries the prefab registry may ever hold.
 *
 * Derived from a measurement, not chosen. Scanning every district on every
 * level - 20x20x4 - the descriptor stream produces 113-135 distinct
 * (kind, extent class) pairs depending on seed, and it SATURATES: 16x16
 * districts yield the same 135 as 20x20, because the vocabulary of sizes
 * belongs to a single 21-cell district's layout rules and not to the size of
 * the world. Adding the dressing kinds and the forecourt takes the real cache
 * to about 150. 192 is that measurement with room for a seed unluckier than
 * the seven sampled, and it is roughly 150x below the ~20,000 a naive
 * per-descriptor cache would reach - which is the number this bound exists to
 * stay nowhere near.
 */
export const PREFAB_BUDGET = 192;
