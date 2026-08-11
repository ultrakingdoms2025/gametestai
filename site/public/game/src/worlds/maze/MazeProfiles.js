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

/* ------------------------------------------------------------------ */
/* The stair tread                                                     */
/* ------------------------------------------------------------------ */

/**
 * When a `stair` slab stops being a tread and becomes a landing, as a ratio
 * of its plan half-extent to its half-rise.
 *
 * The two shapes need opposite treatment and the descriptor does not say
 * which it is, so proportion decides. Real stair carpentry keeps a step's
 * going at no more than about twice its rise (UK regs: 220-300 mm going
 * against a 150-220 mm rise); this world's treads sit at 2.67 (a 1.0 m going
 * over a 0.375 m rise) and its landings at 3.73. Anything past ~3 no longer
 * reads as a step underfoot, and more to the point the landing's edges are
 * FLUSH with level N+1's floor - a riser setback there is a slit between two
 * surfaces that are supposed to meet seamlessly, and a nosing is a step edge
 * on what the climber must read as continuous floor. 3.2 splits the measured
 * populations with margin on both sides. Keying on absolute size (a tread is
 * exactly TREAD_HALF) was the alternative and lost: it would couple this file
 * to `MazeShafts.js` constants and silently misclassify the first connector
 * that ships a differently-sized step.
 */
export const LANDING_RATIO = 3.2;

/**
 * The carpentry of one stair tread, as pure numbers in metres.
 *
 * A real tread is a walking slab whose nosing overhangs the RISER below it -
 * the riser is what gets set back, never the slab past its box. Everything
 * here is an ABSOLUTE dimension, only clamped for degenerate extents, because
 * the whole point of Task 1's registry is that detail is authored in metres
 * and stays the size it was authored at on every instance.
 *
 * @param {{hx:number, hy:number, hz:number}} extents descriptor half-extents
 * @returns {{tread:{thickness:number}, riser:{setback:number},
 *            nosing:{radius:number}, bevel:number}}
 */
export function treadProfile({ hx, hy, hz }) {
  const plan = Math.min(hx, hz);
  if (plan > hy * LANDING_RATIO) {
    /* A landing: flat slab, a small stone-joint chamfer on its top edges and
     * nothing else. See LANDING_RATIO for why nosing and setback are exactly
     * zero here rather than merely small. */
    return {
      tread: { thickness: hy * 2 },
      riser: { setback: 0 },
      nosing: { radius: 0 },
      bevel: Math.min(0.015, plan * 0.1, hy * 0.4),
    };
  }
  /* The slab reads as a plank sitting on masonry, so it is thin against the
   * 0.375 m rise; the setback is deep enough to throw a visible shadow line
   * under the nosing at corridor light levels, and the nosing radius stays
   * inside the setback so the roll-over never leaves the box (the test named
   * in the plan holds that ordering). */
  const thickness = Math.min(0.09, hy * 0.8);
  const setback = Math.min(0.07, plan * 0.25);
  const radius = Math.min(0.03, setback, thickness * 0.45);
  const bevel = Math.min(0.02, setback * 0.5, hy * 0.2);
  return { tread: { thickness }, riser: { setback }, nosing: { radius }, bevel };
}

/**
 * The tread's cross-section as a 2D outline: bands of [inset, y] points, top
 * to bottom, where `inset` is how far the surface stands in from the box side
 * and `y` is height about the box centre.
 *
 * Bands are the unit of SMOOTHING, which is why the outline is not one flat
 * polyline: points inside a band share vertices when swept (the bulnose arc
 * shades as a curve), while a band boundary is a duplicated crease (the
 * soffit meets the riser at a hard edge, as cut timber does). The sweep in
 * `MazeMeshes.js` consumes exactly this structure.
 *
 * The same treatment faces all four sides. That is not a shortcut: a stair
 * descriptor is square in plan and carries no orientation - the spiral turns
 * 45 degrees per step - so the leading edge is genuinely unknowable here, and
 * a tread treated on every edge reads correctly from every step of the climb.
 *
 * @param {{hx:number, hy:number, hz:number}} extents descriptor half-extents
 * @param {number} [arcSegments] straight pieces approximating the bulnose
 * @returns {Array<Array<[number, number]>>}
 */
export function treadOutline(extents, arcSegments = 6) {
  const { hy } = extents;
  const { tread, riser, nosing, bevel } = treadProfile(extents);
  const r = nosing.radius;
  const s = riser.setback;
  const t = tread.thickness;
  const b = bevel;

  if (s <= 0) {
    /* Landing. A chamfer of zero would leave a degenerate band, so it falls
     * all the way back to a plain box side. */
    if (b <= 0) return [[[0, hy], [0, -hy]]];
    return [
      [[b, hy], [0, hy - b]],
      [[0, hy - b], [0, -hy]],
    ];
  }

  /* The tread. One smooth band rolls the bulnose over from the top face into
   * the slab's edge (the arc ends tangent-vertical, so continuing straight
   * down to the slab's underside needs no crease); then four creased bands:
   * the soffit under the overhang, a chamfer easing it into the riser, the
   * riser face itself, and a base chamfer so the plinth does not end in a
   * knife edge against the tread below. */
  const bulnose = [];
  for (let i = 0; i <= arcSegments; i++) {
    const a = (i / arcSegments) * (Math.PI / 2);
    bulnose.push([r - r * Math.sin(a), hy - r + r * Math.cos(a)]);
  }
  bulnose.push([0, hy - t]);
  return [
    bulnose,
    [[0, hy - t], [s - b, hy - t]],
    [[s - b, hy - t], [s, hy - t - b]],
    [[s, hy - t - b], [s, -hy + b]],
    [[s, -hy + b], [s + b, -hy]],
  ];
}

/* ------------------------------------------------------------------ */
/* The chamfer, and the contact AO bake                                */
/* ------------------------------------------------------------------ */

/**
 * The chamfer width on a bevelled box prefab, in metres.
 *
 * 4 cm, authored absolutely - the number the whole registry design exists to
 * keep absolute. Two things a box must do to stop reading as a box, and the
 * first is that real edges catch light: a corridor's worth of hedge corners
 * each throwing a thin highlight is most of what "high-poly" actually looks
 * like at walking distance. 4 cm is wide enough for that highlight to survive
 * a 1080p rasteriser at 3-4 m and narrow enough that abutting segments'
 * grooves read as clipped joints rather than as gaps; it is also, not by
 * coincidence, the width the phase plan authored its own arithmetic around.
 */
export const CHAMFER = 0.04;

/**
 * The chamfer a given box can actually afford. A 4 cm cut into a 15 cm
 * footing is fine; the same cut into anything thinner than 9 cm would leave
 * the flat face smaller than the two chamfers eating it, so the cut scales
 * away rather than the prefab inverting. 0.45 (not 0.5) keeps a strip of
 * genuine flat face on the thinnest axis, so every box still has the plane
 * its neighbours abut against.
 */
export function chamferFor({ hx, hy, hz }) {
  return Math.min(CHAMFER, 0.45 * Math.min(hx, hy, hz));
}

/**
 * The contact-AO bake, as pure numbers.
 *
 *  - `dark`: the shade at the very base, where the prefab meets the ground.
 *    0.55 is dark enough that the hedge-floor junction reads as a real
 *    contact shadow under this world's low light, and light enough that the
 *    footing's own stonework stays legible inside it. (The Task 4 gate
 *    asserts bottom < 0.8 x top; 0.55 passes with room, so the test cannot
 *    be satisfied by float noise.)
 *  - `height`: how far up the darkening reaches before fading to none. 0.55 m
 *    keeps it a BASE phenomenon - a band at eye level would read as damp, not
 *    as occlusion.
 *  - `crease`: the subtler multiplier on the chamfer facets themselves. Real
 *    AO darkens concavities, and a chamfer is convex - but a few percent in
 *    the cut reads as the dirt that gathers along an arris, and it keeps an
 *    edge legible from angles where the lighting alone goes flat. Anything
 *    stronger starts to look like an outline shader.
 */
export const CONTACT_AO = Object.freeze({ dark: 0.55, height: 0.55, crease: 0.93 });

/**
 * The AO shade for a vertex at height `y` in a prefab of half-height `hy`:
 * `dark` at the base, easing to 1 at the top of the contact band. Pure and
 * per-vertex so the bake in `MazeMeshes.js` is nothing but a loop over this.
 *
 * The band is clamped to the prefab's own half-height so a short box (a
 * footing, a floor slab) grades base-to-top rather than being uniformly dark
 * - the gradient, not the darkness, is what the eye reads as contact.
 */
export function contactShade(y, hy) {
  const band = Math.min(CONTACT_AO.height, hy);
  const t = Math.min(1, Math.max(0, (y + hy) / band));
  const eased = t * t * (3 - 2 * t);
  return CONTACT_AO.dark + (1 - CONTACT_AO.dark) * eased;
}

/* ------------------------------------------------------------------ */
/* The LOD bands                                                       */
/* ------------------------------------------------------------------ */

/**
 * How far a district may be before its prefabs drop to the mid band, in
 * metres. Within this range every chamfer, nosing and bulnose renders.
 *
 * 25 m is the number the phase plan's own budget table was authored around,
 * and it is not arbitrary: the detail the near prefabs spend their triangles
 * on is a 4 cm chamfer, and 4 cm at 25 m subtends about five arc-minutes -
 * roughly two pixels at 1080p - which is the last distance at which the edge
 * highlight is resolvable as a highlight rather than as noise. Pushing the
 * band out re-buys the 8.56 M-triangle world that Task 4 measured and
 * deferred (see BEVELLED_KINDS in MazeMeshes.js); pulling it in makes the
 * chamfer pop visible in the one place the player is close enough to watch
 * it happen.
 */
export const LOD0_RANGE = 25;

/**
 * Where the mid band ends and the far band begins, in metres. Kept even
 * though the mid and far GEOMETRY currently coincide (both are the plain
 * box - see `lodFor`), because the band structure is the plan's contract
 * and the first mid-tier that ever differs from the box slots in here
 * without moving a single call site.
 */
export const LOD1_RANGE = 80;

/**
 * Which LOD a surface at `distance` metres renders. Pure, and the ONE
 * definition - `MazeChunks.updateResidency` and the headless triangle-budget
 * test both call this, so the bands the browser renders are the bands the
 * suite priced.
 *
 * Evaluated per DISTRICT, never per instance: a district is 120 m square
 * against bands of 25 m and 80 m, so per-instance evaluation could only
 * matter inside the district the player is standing in - and there
 * everything is LOD0 anyway. One comparison per resident district per
 * residency update, instead of ~35,000 per frame.
 *
 * @param {number} distance metres from the player to the district
 * @returns {0|1|2}
 */
export function lodFor(distance) {
  if (distance <= LOD0_RANGE) return 0;
  return distance <= LOD1_RANGE ? 1 : 2;
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
