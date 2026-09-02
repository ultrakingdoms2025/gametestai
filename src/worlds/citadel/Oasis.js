import * as THREE from 'three';
/* THE FLAT MATERIALS IN THIS FILE GET A MICRO-SURFACE.
 *
 * A colour and a roughness scalar with no maps returns one uniform specular
 * lobe across a whole prop: the highlight slides as a light moves and never
 * breaks up, which is most of what reads as CG plastic rather than as a
 * surface. `microSurface` attaches the ONE shared detail normal baked in
 * gfx/Textures.js - fine scratches, sanding grain, a little orange peel at
 * roughly 4 cm - and varies only `normalScale` (by surface family) and
 * `repeat` (by how much world space one UV unit spans).
 *
 * ONE texture and ONE map slot on every material that takes it, deliberately:
 * a `normalMap` moves a material to a new shader-program cache key, so this
 * is a bucket MOVE rather than a permutation per prop only as long as nothing
 * here gains a SECOND slot and nothing in a converted family is left behind.
 * The families deliberately left flat are the transparent ones (a 0.05 scale
 * on glass is ~0.6 degrees of perturbation - below what an 8-bit normal
 * resolves, and it would split a bucket against materials outside this file)
 * and the emissive fittings (a normal perturbs the lit term, and those
 * surfaces are ~0.05 albedo under a 2-3x emissive: there is nothing for it to
 * do). */
import { microSurface } from '../../gfx/Textures.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { sweep, blob } from '../../gfx/Organic.js';

/**
 * THE OASIS KIT - a swimmable water hole for the empty flats between regions.
 *
 * The brief is "1 or 2 oasis areas" in the dead ground between the six new
 * regions, and an oasis is only worth the walk if you can get INTO the water.
 * Everything below follows from two measurements and one engine rule.
 *
 * ── 1. There is no hollow to put a pool in ────────────────────────────────
 *
 * Measured over the Citadel flats - 5,914 candidate centres on a 5 m lattice,
 * radius 200..430 m from the mesa, every one outside every landform AABB in
 * `CITADEL_LANDFORMS` - the DEEPEST natural bowl in the whole desert is
 * 0.192 m (at -305, -155) and the median is -0.439 m, i.e. the median "bowl"
 * is a mound. Reproduce with `citadelHeight` and a 12 m rim ring; the suite's
 * `the flats have no natural hollow to sink a pool into` re-runs it.
 *
 * There is therefore nowhere to sink a pool, and the second half of the same
 * problem is worse:
 *
 * ── 2. A Physics heightfield cannot be dug ────────────────────────────────
 *
 * `Physics` treats a heightfield as solid from its surface all the way down to
 * `baseY`, so a basin excavated into the desert is a basin full of solid sand
 * and the swimmer is shoved up out of it. This is the same rule `Caves.js`
 * encodes with {@link liftToClear}, and it applies here with the sign
 * reversed: the pool bed has to sit ON the terrain, never in it.
 *
 * `Collider` does carry a per-cell `holes` mask "so a single field can have a
 * swimming pool punched through it", and that was the first plan. It was
 * refused on a measurement: `CITADEL_LAYOUT.terrainStep` is 3.75 m, so the
 * smallest hole this world can cut is a 3.75 m square, against basin treads of
 * 0.60-0.90 m. Every shelf would have to be sized in multiples of 3.75 m or
 * the player would drop through the sliver between the hole edge and the
 * nearest built wall - and a hole is a fall into nothing, which is a worse
 * failure than anything on this page. A sunken pool also cannot be seen from
 * across the flats, and being seen from across the flats is most of what makes
 * an oasis worth walking to.
 *
 * Which forces the whole design. The bed is at grade; a swim needs
 * `Swim.ENTER_DEPTH` = 1.3 m of water over the bed; so the waterline is
 * necessarily at least 1.3 m ABOVE the surrounding desert. An oasis in this
 * engine cannot be a puddle in a dip. It has to be a TANK - which is what a
 * desert oasis actually is once anybody has built at it: a *birka*, a stepped
 * mud-brick water tank with terraced banks, palms on the rim and reeds at the
 * strand. The terraces are not a compromise, they are the only shape that is
 * simultaneously buildable on a heightfield, walkable in both directions, and
 * architecturally honest.
 *
 * ── 3. The shape of the terraces is decided by the swim controller ────────
 *
 * A floating swimmer's feet sit `Swim.FLOAT_DEPTH` = 1.47 m under the surface,
 * and swimming does not disengage until the bed is shallower than
 * `Swim.EXIT_DEPTH` = 1.0 m. So there is a band - bed depth 1.47 m down to
 * 1.0 m - where the shelf under the swimmer is ABOVE their own feet and they
 * are still in swim mode, which has no step-up. Whether the player can get out
 * of the pool is decided entirely inside that band.
 *
 * `resolveCapsule` evicts the capsule along the contact normal. Against a
 * riser whose top edge is `e` metres above the feet, the edge is `0.35 - e`
 * below the bottom sphere's centre, so the eviction is `(0.35 - e) / 0.35`
 * upward: it lifts the swimmer over a low lip and shoves them backwards off a
 * high one. At a 0.40 m riser that is 0.14 down-and-back - a wall. At 0.15 m
 * it is 0.57 up - a beach.
 *
 * So the profile runs FINE through the swim band and coarse everywhere else:
 * four 0.15 m risers from depth 1.55 to depth 0.95, which is where swimming
 * releases the player back to the walking controller and its 0.45 m step-up
 * takes over. Every riser is quoted in {@link SHELVES} against the threshold
 * that chose it, and `the pool can be swum out of by holding forward` drives
 * the real `Player` through it rather than believing any of this.
 *
 * ── 4. The tank was right and it did not look like an oasis ──────────────
 *
 * Everything above is about whether the thing WORKS, and it does: the pool is
 * swimmable, climbable out of, level, grounded, and cheap. It also shipped
 * looking like a rectangle of flat saturated blue on a stepped grey ziggurat
 * in the middle of a desert, and none of the eighteen cases in
 * `citadel-oasis.test.mjs` had a word to say about that.
 *
 * Three things were wrong and none of them was the profile.
 *
 * THE BANK WAS PAINTED AS POOL LINING. Every ring was keyed on `r.depth > 0`,
 * and `depth` on an apron course is a fiction - stated as such in the note on
 * {@link auditShoreline}, which walks the apron separately for exactly this
 * reason. The first apron course tops out 0.15 m under the waterline, so all
 * fifteen of them tested true and the whole outer bank came out in
 * `stone.cobble` in the algae tints meant for the bed. One boolean, and it is
 * most of the grey ziggurat. Keyed on `kind` now - {@link ringSurface}.
 *
 * THE POOL WAS A RECTANGLE. The colliders have to be axis-aligned rectangles;
 * the water surface does not, and neither does the shoreline. Both now come
 * off one radial function - {@link shoreRadius} - and the sand that fills what
 * the water leaves dry comes off the same one, which is the only way the two
 * can be guaranteed not to disagree.
 *
 * AND THE SAND. The terraces themselves cannot move: they are the profile, and
 * every riser in them is justified against a controller threshold. So they are
 * DRESSED - see the dressing rule below - with sand that costs no colliders,
 * no draw calls and 12 triangles a lobe, and that turns a flight of parallel
 * rectangles into a bank with drift on it. The four things the eye reads as
 * "built" are the parallel riser lines, the rectangular plan, the corners, and
 * the colour; the sand is aimed at the first three and the palette at the
 * fourth.
 *
 * The water is the world's own `water.pool`, adjusted: see
 * {@link oasisWaterMaterial} for why the library's chlorinated blue and its
 * transmission pass both had to go, and {@link waterShade} for the depth ramp
 * that replaced them.
 *
 * ── What the world gets ───────────────────────────────────────────────────
 *
 * `buildOasis` emits its solids through the host's own `Batch.box`, so the
 * terraces cost the kit ZERO draw calls of its own: only the water plane and
 * the two instanced palm fields are its meshes. What they cost the HOST depends
 * on the host, and in the Citadel it is not zero - `_buildTraffic` opens a
 * batch per oasis, so each DISTINCT MATERIAL KEY the tank paints with is one
 * more mesh there. Seven, measured, up from six before the art pass.
 * @see `cost.draws` for the whole bill and for what the sand and the repainted
 * bank cost between them when they landed.
 *
 * It publishes an `enterable` (doorless, exactly like a cave),
 * `cacheSites`, `npcSpawns` for a vendor pitch and a water carrier, and
 * `restSpots`, and it makes `Caches._findSunken` work in the Citadel for the
 * first time - that channel has always placed 0 here because the world had no
 * water at all.
 *
 * @see ../../systems/WaterVolumes.js  how the water is discovered
 * @see ../../player/Swim.js           the thresholds every depth here is against
 * @see ./Caves.js                     the same heightfield rule, sign reversed
 */

/* ====================================================================== */
/* The profile                                                            */
/* ====================================================================== */

/** Player capsule radius. `CONFIG.player.radius`, restated so this file stands alone. */
export const CAPSULE_R = 0.35;
/** Player step-up. `CONFIG.player.stepHeight`. Every dry riser must be under it. */
export const STEP_MAX = 0.45;
/** Bed depth at which `Swim` engages / releases. `Swim.ENTER_DEPTH` / `EXIT_DEPTH`. */
export const SWIM_ENTER_DEPTH = 1.3;
export const SWIM_EXIT_DEPTH = 1.0;
/** How far under the surface a resting swimmer's feet float. `Swim.FLOAT_DEPTH`. */
export const FLOAT_DEPTH = 1.47;
/** Feet must be this far under before a wade becomes a swim. `Swim.ENTER_SUBMERSION`. */
export const SWIM_ENTER_SUBMERSION = 0.55;
/** Depth a sunken cache needs. `Caches.MIN_DIVE`. The deep floor is sized for it. */
export const MIN_DIVE = 1.6;

/** Deepest water, over the floor slab. */
export const POOL_DEPTH = 2.45;
/** Dry freeboard: how far the crest promenade stands over the waterline. */
export const FREEBOARD = 0.25;
/** Half-extents of the deep floor. Rectangular, because a birka is. */
export const FLOOR_HX = 6.0;
export const FLOOR_HZ = 4.5;

/**
 * The basin, from the deep floor outward and upward.
 *
 * `rise` is the riser onto this shelf from the one inside it; `tread` is how
 * far it reaches outward. `depth` in the derived plan is `POOL_DEPTH` minus
 * the running rise, and it is the number every riser is justified against.
 *
 *   shelf  rise  tread   depth   why this riser
 *   ---------------------------------------------------------------------
 *   s1     0.45  1.00    2.00    under FLOAT_DEPTH: a floating body clears it
 *   s2     0.45  1.00    1.55    ditto, 0.08 m of clearance left
 *   b1     0.15  0.60    1.40    THE BEACH. Above the floating feet from here,
 *   b2     0.15  0.60    1.25    and still inside swim mode, so every riser is
 *   b3     0.15  0.60    1.10    small enough that `resolveCapsule` lifts the
 *   b4     0.15  0.60    0.95    capsule over it. 0.95 < EXIT_DEPTH: released.
 *   c1     0.40  0.90    0.55    walking now; under STEP_MAX
 *   c2     0.40  0.90    0.15    the strand, ankle deep. Reeds go here.
 *   crest  0.40  3.60   -0.25    dry promenade. Palms, well head, shelter.
 *
 * The crest tread is 3.60 m and not the 2.40 m it was first drawn at, and the
 * extra 1.20 m is not decoration. The well head and the shade both stand on
 * the crest, and at 2.40 m they filled it: the swim-out driver walked a player
 * out of the pool, up the beach, onto the strand, and straight into the well
 * curb, where it stayed for eighteen seconds. Furniture is now held to
 * {@link FURNITURE_HALF} either side of a line {@link FURNITURE_MARGIN} inside
 * the outer edge, which leaves a 1.30 m walkway clear all the way round -
 * enough for a 0.70 m capsule with 0.30 m either side. `the crest promenade is
 * walkable all the way round` is the ratchet on that.
 */
export const SHELVES = Object.freeze([
  Object.freeze({ id: 's1', rise: 0.45, tread: 1.00 }),
  Object.freeze({ id: 's2', rise: 0.45, tread: 1.00 }),
  Object.freeze({ id: 'b1', rise: 0.15, tread: 0.60 }),
  Object.freeze({ id: 'b2', rise: 0.15, tread: 0.60 }),
  Object.freeze({ id: 'b3', rise: 0.15, tread: 0.60 }),
  Object.freeze({ id: 'b4', rise: 0.15, tread: 0.60 }),
  Object.freeze({ id: 'c1', rise: 0.40, tread: 0.90 }),
  Object.freeze({ id: 'c2', rise: 0.40, tread: 0.90 }),
  Object.freeze({ id: 'crest', rise: 0.40, tread: 3.60 }),
]);

/**
 * Outer bank: courses stepping back down from the crest to the desert.
 *
 * TWO FLIGHTS, and the second one is not symmetry.
 *
 * The first seven courses of 0.40 m are the structural descent; they land the
 * seventh 0.02 m over the HIGHEST ground under the tank, which is fine on a
 * billiard table and nowhere else. Everything below that is the FEATHER: the
 * bank keeps stepping down past the high point so that wherever the desert is
 * lower the courses come down to meet it, and wherever it is higher they bury
 * themselves and the player simply walks onto the course above. That
 * self-levelling is what {@link MAX_RELIEF} buys, and it is why `auditGrounded`
 * counts a buried apron course as `buried` rather than as `pierced`.
 *
 * The feather rises 0.20 m and not 0.40, and that is a measured correction.
 * At a uniform 0.40 m the outermost EXPOSED course stands up to a full riser
 * over the sand beside it, plus whatever the ground does across one tread -
 * measured 0.70 m at the corner of a site with 1.36 m of relief, against a
 * 0.45 m step-up. Not a cliff, but a bank you have to jump onto is not a bank.
 * Halving the riser and shortening the tread caps that step at 0.20 m plus
 * whatever the ground does, measured 0.22 m on the built world.
 *
 * EIGHT of them, for 1.60 m of reach against a {@link MAX_RELIEF} of 1.20. The
 * 0.40 m difference is lattice slack, and it is not a round number chosen for
 * comfort: relief is an acceptance test run at `PROFILE_STEP`, and re-probed
 * at 0.4 m over the same footprints the worst under-report measured on the
 * built world is 0.238 m. A bound with no slack under it is a bound that fails
 * the day somebody changes the pitch, and the suite asserts the slack rather
 * than a constant.
 */
export const APRON_COURSES = 7;
export const APRON_RISE = 0.40;
export const APRON_TREAD = 0.90;
export const FEATHER_COURSES = 8;
export const FEATHER_RISE = 0.20;
export const FEATHER_TREAD = 0.60;

/**
 * How far the floor slab tops clear the HIGHEST terrain under the footprint.
 *
 * Small on purpose. Every centimetre here is a centimetre the whole tank rises
 * above the desert, and the outermost apron course sits `APRON_RISE * 7 -
 * (POOL_DEPTH + FREEBOARD)` below the bed, i.e. 0.10 m under it, so this is
 * also what stops that last course from being buried.
 */
export const BED_CLEAR = 0.12;
/** How far below the LOWEST terrain every solid runs, so nothing floats. */
export const BURY = 1.0;

/**
 * The lattice EVERY terrain probe in this file uses.
 *
 * One constant, shared by {@link oasisProfile}, {@link settleOasis},
 * {@link findOasisSite} and {@link auditGrounded}, because two probes of the
 * same surface have to agree by construction rather than by luck. The site
 * search originally ran at 2.5 m to save time and it approved a site that
 * measured 0.39 m of relief at 1.0 m - the coarse pass simply stepped over the
 * ridge. The saving was 55 ms on a 440 ms world build. `Caves.liftToClear`
 * carries the identical note about the identical mistake.
 */
export const PROFILE_STEP = 1.0;

/**
 * Terrain relief the site may have under the whole footprint.
 *
 * The bed is levelled to `terrainHi + BED_CLEAR` and the feather runs
 * `FEATHER_COURSES * FEATHER_RISE` = 1.60 m below the point where the seventh
 * course meets the highest ground. So a site may be 1.60 m out of level before
 * the bank stops reaching the sand on its low side, and the cap here is set
 * 0.40 m under that so a re-probe at a different lattice pitch still clears.
 *
 * Measured on the shipped terrain, sampling `settleOasis` over the whole
 * desert at a 10 m pitch: relief under a 53.8 x 50.8 m footprint has a median
 * of 7.45 m and only 49 of 924 cells come in under 0.8 m. Raising this cap
 * does not buy many more sites - the distribution is bimodal, a flat pan or a
 * dune field with nothing in between - and every metre of it is a metre of
 * plinth the player has to look at. 1.20 is where the two stop trading.
 * @see citadelOases for where the survivors are, which is not where the design
 *   expected them to be.
 */
export const MAX_RELIEF = 1.20;

/**
 * Furniture on the crest: half-width, and how far its centre line sits inside
 * the crest's outer edge. Together with the crest tread these fix the width of
 * the walkway between the water and anything built on the rim.
 */
export const FURNITURE_HALF = 1.05;
export const FURNITURE_MARGIN = 1.25;
/** What the two above leave clear between the waterline and the furniture. */
export const WALKWAY = SHELVES[SHELVES.length - 1].tread - FURNITURE_MARGIN - FURNITURE_HALF;

/** Palms per oasis, and where on the rim they may stand. */
export const PALM_COUNT = 9;
/** Reed clumps along the strand. */
export const REED_CLUMPS = 34;

/* ====================================================================== */
/* The shore, and the sand that buries the tank                           */
/* ====================================================================== */

/**
 * THE DRESSING RULE, and it is the only reason any of this is safe.
 *
 * Everything in this section is VISUAL ONLY - every box goes into the host's
 * batch with `collide: false` and registers no collider at all. That is not
 * timidity, it is the measurement in {@link COLLIDER_SEG_M} refusing to be
 * spent twice. The worst broadphase cell in the whole world is 63 and it is at
 * (-312, -96), which is the sand-mirror's WEST BANK - exactly the ground this
 * section wants to pile sand on. One collider per sand lobe out there is one
 * more collider in the worst cell in the game, and the 97 -> 63 split was
 * bought with 200 extra colliders precisely to get it down. So the dressing
 * spends none: the collider set after this change is the same 4,425 boxes it
 * was before, box for box, and the 63 stands by construction.
 *
 * The price is that a player can walk through the sand. That is BOUNDED rather
 * than hoped for. No dressing box's top may stand more than {@link GHOST_MAX}
 * above the lowest surface under its own footprint - see {@link dressFloor}
 * for what "surface" means where the plan and the desert disagree - and
 * `GHOST_MAX` is `APRON_RISE`, one course. A player climbing the bank is
 * already stepping 0.40 m up at every course, so the tallest thing they can
 * walk through is the step they were taking anyway; it reads as loose sand
 * round the ankles, which is what it is.
 *
 * {@link auditDressing} measures it, `no dressed sand stands higher than one
 * bank course` is the ratchet, and that case does NOT trust the audit on its
 * own: the audit and the emitter both call `dressFloor`, so on its own it can
 * only agree with itself. The case re-measures every lobe against the real
 * collider set and requires the two to agree, which is how a `dressFloor` that
 * returned the highest surface instead of the lowest is caught. Measured on
 * the shipped tanks, the worst ghost is 0.388 m measured against the plan and
 * 0.385 m measured against the colliders.
 *
 * Everything here is also under `BEVEL_MIN` (0.55 m) in its smallest dimension,
 * so `Batch.box` leaves it square: 12 triangles a lobe against a bevelled
 * box's 108.
 *
 * WHAT IT COSTS, and where the dial is. 230 and 227 lobes on the two shipped
 * tanks - 2,760 and 2,724 triangles - no colliders and no draw calls at all,
 * but 4.5 ms of BUILD apiece, because a
 * box through `CitadelWorld.Batch.box` costs ~17 us (the UV reprojection and
 * the per-vertex AO ramp) against 2.5 through the kit's own `OasisBatch`.
 * Measured on the shipped world, the worst owned build slice went from
 * 15.0-16.9 ms to 17.0-19.8 ms over three runs each, against C5's 24 ms
 * budget; `citadel-budgets.test.mjs` is where that is watched. If it ever
 * needs to come back, {@link BANK_LOBES} is half the boxes and
 * {@link SHORE_ARCS} is a fifth, and both are honest dials: nothing else
 * depends on their value.
 */

/** The tallest a dressing box may stand over the lowest plan surface under it. */
export const GHOST_MAX = APRON_RISE;
/** How far a lobe standing on masonry reaches below that surface. Never floats. */
export const DRESS_SINK = 0.12;
/**
 * The toe drift runs out past the footprint onto ground this file never
 * sampled, so it is sunk further and stands lower: at most {@link TOE_GHOST}
 * over the LOWEST terrain the profile found, and buried wherever the desert is
 * higher than that. `TOE_GHOST + TOE_SINK` is 0.52, still under `BEVEL_MIN`.
 */
export const TOE_GHOST = 0.22;
export const TOE_SINK = 0.30;

/**
 * How far the waterline may pull back from the crest, metres.
 *
 * BOUNDED BY WHAT THE SAND CAN FILL BEHIND IT, and that is the whole argument.
 * Wherever the water retreats it leaves shelf standing dry BELOW the plane -
 * water visibly held up by nothing, which is worse than the rectangle it
 * replaced - so the retreat is only legal as far as a sand bar can follow it
 * without breaking {@link GHOST_MAX}.
 *
 * Two shelves can. `c2` is 0.15 m under the plane and 0.90 m wide, so a bar on
 * it tops out just proud of the water at a ghost of 0.37. `c1` is 0.55 m under
 * and 0.90 m wide, and a bar on it at a ghost of exactly `GHOST_MAX` - which
 * is `APRON_RISE`, which is the `c1` to `c2` riser - tops out level with `c2`.
 * So the beach simply gets wider, at the same height, and the waterline can
 * wander across both treads. Past `c1` is `b4` at 0.95 m under, which no bar
 * inside the bound can reach, and that is where this stops.
 *
 * 1.65 rather than 1.80 leaves 0.15 m of margin against the `b4` edge for the
 * turn skew on a bar - see the note at the inner clamp. Measured on the two
 * shipped tanks, the waterline then stands 0.00-1.27 m and 0.12-1.54 m inside
 * the 24.4 x 21.4 m rectangle it used to be: it wanders 1.27 m and 1.42 m as
 * the player walks round it, against the 0.27 m a CONSTANT inset would show,
 * which is a rectangle-fit artefact at the corners rather than a shoreline.
 * `the pool is not a rectangle` measures both and separates them.
 */
export const SHORE_INSET = 1.65;
/** Harmonics in the shore function. Five gives 2-11 lobes round the rim. */
const SHORE_HARMONICS = 5;

/** Sand lobes per exposed bank course, plus one at each corner of that course. */
export const BANK_LOBES = 6;
/** Drift lobes lapping the toe of the bank, out past the footprint. */
export const TOE_LOBES = 12;
/**
 * Arcs the shoreline is dressed in. One sand bar per arc that needs one.
 *
 * FORTY, and the number was measured rather than chosen. Each bar reaches in
 * as far as the WORST inset over its own arc, so an arc longer than the
 * shortest wavelength in {@link shoreWaves} can have the water pull back
 * behind it and leave a strip of strand standing dry. Measured on the
 * standalone tank, as the fraction of the exposed strand left bare:
 *
 *   28 arcs, 3 samples each                 12.2%
 *   40 arcs, 7 samples each                  7.8%
 *   ...plus the turn-skew margin below       0.0%
 *
 * The last row is not an arc count - it is the clamp at the bar's inner edge,
 * and it was two thirds of the problem. `every metre of exposed strand is
 * sand` is the ratchet, and it runs on the shipped tanks rather than on this
 * one.
 */
export const SHORE_ARCS = 40;
/** Submerged pale shoals, which is what makes the shallows read as shallow. */
export const SHOAL_BARS = 6;
/**
 * Rocks at the strand and up the bank. Two boxes each: a base and a smaller
 * cap turned across it, which is 24 triangles for something that reads as a
 * boulder, against 108 for a single box big enough for `Batch.box` to bevel -
 * and a bevelled box at this size is still a box with 7 cm off its edges.
 */
export const SHORE_ROCKS = 8;

/**
 * Fit a bearing to a rectangle: the radius at which the ray leaves it.
 * The tank is rectangular and so is every ring of it, so every "how far out is
 * the edge at this bearing" in this file is this one function.
 */
function fitRect(ex, ez, hx, hz) {
  return 1 / Math.max(Math.abs(ex) / hx, Math.abs(ez) / hz);
}

/**
 * The harmonics of one pool's shoreline, packed flat as [k, amp, phase] x N.
 *
 * Flat because it is read once per vertex of the water plane and once per sand
 * bar, and an array of objects there is an array of pointer chases for a sum
 * of five sines.
 */
function shoreWaves(seed) {
  const rnd = mulberry32(seed);
  const w = new Float64Array(SHORE_HARMONICS * 3);
  let norm = 0;
  for (let i = 0; i < SHORE_HARMONICS; i++) {
    w[i * 3] = 2 + i * 2 + (rnd() < 0.5 ? 0 : 1);
    w[i * 3 + 1] = 1 / (1 + i * 0.85);
    w[i * 3 + 2] = rnd() * Math.PI * 2;
    norm += w[i * 3 + 1];
  }
  for (let i = 0; i < SHORE_HARMONICS; i++) w[i * 3 + 1] /= norm;
  return w;
}

/**
 * How far the water pulls back from the crest at this bearing, metres.
 *
 * In [0, {@link SHORE_INSET}] by construction: the harmonics are normalised so
 * the sine sum is in [-1, 1], and the remap below is clamped either side.
 *
 * @param {object} plan
 * @param {number} theta bearing in the plan's local frame
 */
export function shoreInset(plan, theta) {
  const w = plan.shore;
  if (!w) return 0;
  let sum = 0;
  for (let i = 0; i < w.length; i += 3) sum += w[i + 1] * Math.sin(w[i] * theta + w[i + 2]);
  /* 0.62 and not 0.5: five normalised harmonics almost never sum to +-1, so a
   * straight remap uses about three quarters of the range and the shoreline
   * comes out timid. Over-driving and clamping spends the whole of it - the
   * inset measured over 360 bearings runs 0.02..1.53 of a 1.65 cap. */
  const t = 0.5 + 0.62 * sum;
  return SHORE_INSET * (t < 0 ? 0 : t > 1 ? 1 : t);
}

/**
 * The local radius of the WATERLINE at this bearing.
 *
 * ONE function, and both the water plane and the sand that fills what it
 * leaves behind are generated from it - which is the only way the two can be
 * guaranteed to agree. Two independent "irregular" outlines would leave gaps
 * of dry shelf below the water plane wherever they disagreed, and the bound on
 * {@link SHORE_INSET} exists so that that cannot happen.
 */
export function shoreRadius(plan, theta) {
  const ex = Math.cos(theta);
  const ez = Math.sin(theta);
  return fitRect(ex, ez, plan.water.hx, plan.water.hz) - shoreInset(plan, theta);
}

/**
 * Which ring of the plan is the ground at this local point, or null outside.
 *
 * The rings are nested annuli in outward order, so the first one that contains
 * the point and is not hollow there is the surface a player stands on. Used by
 * the water plane to know its own depth and by the dressing to know what it is
 * standing on. It is the same lookup `the tank cannot be fallen into from the
 * desert` writes out inline for its own reasons; if that ever drifts from
 * this, one of the two is wrong about where the ground is.
 */
export function ringAt(plan, lx, lz) {
  const ax = Math.abs(lx);
  const az = Math.abs(lz);
  for (const r of plan.rings) {
    if (ax > r.hx || az > r.hz) continue;
    if (r.kind !== 'floor' && ax < r.ihx && az < r.ihz) continue;
    return r;
  }
  return null;
}

/** The plan surface at a local point; outside the footprint, the lowest terrain. */
export function surfaceAt(plan, lx, lz) {
  const r = ringAt(plan, lx, lz);
  return r ? r.top : plan.baseY + BURY;
}

/** Water depth over the plan surface at a local point. Negative on dry ground. */
export function depthAt(plan, lx, lz) {
  return plan.waterY - surfaceAt(plan, lx, lz);
}

/**
 * The lowest surface under a dressing box's footprint - plan or desert.
 *
 * Five probes: the four rotated corners and the centre. The MINIMUM, not the
 * mean, and that is the whole safety argument - a lobe seated on the lowest
 * ground it covers can never float over any part of its own footprint, and its
 * ghost height is measured against the worst case rather than the average one.
 * Floored at the lowest terrain the profile found, for the reason at the
 * bottom of the function.
 */
function dressFloor(plan, lx, lz, w, d, rot) {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const hw = w * 0.5;
  const hd = d * 0.5;
  let lo = surfaceAt(plan, lx, lz);
  for (let i = 0; i < 4; i++) {
    const sx = i & 1 ? hw : -hw;
    const sz = i & 2 ? hd : -hd;
    const y = surfaceAt(plan, lx + sx * c - sz * s, lz + sx * s + sz * c);
    if (y < lo) lo = y;
  }
  /* ...but never below the LOWEST terrain the profile found, because the
   * desert is there. The feather courses run down past that line on purpose -
   * that is what buries the bank - and a toe drift clipping the corner of one
   * would otherwise be seated a metre under the sand and disappear. Nine of
   * twelve were. Clamping here rather than at the one call site that needs it
   * keeps `dress` and {@link auditDressing} measuring the same thing, which is
   * the only reason the audit is worth running. */
  const floor = plan.baseY + BURY;
  return lo < floor ? floor : lo;
}

/**
 * AUDIT 3 - how far can a player walk through the sand?
 *
 * Every dressing box, against {@link dressFloor} under its own footprint. See
 * the dressing rule above: the answer has to stay inside one bank course,
 * because that is the step the player is taking anyway. And see it again for
 * why the case that runs this does not stop here - the audit and the emitter
 * share `dressFloor`, so on its own it can only agree with itself.
 *
 * @param {object} plan
 * @param {Array<{key:string,w:number,h:number,d:number,lx:number,lz:number,
 *                top:number,rot:number}>} dressing as `buildOasis` returns it
 */
export function auditDressing(plan, dressing) {
  let worstGhost = 0;
  let worstAt = null;
  let bevelled = 0;
  for (const dr of dressing) {
    const ghost = dr.top - dressFloor(plan, dr.lx, dr.lz, dr.w, dr.d, dr.rot);
    if (ghost > worstGhost) { worstGhost = ghost; worstAt = `${dr.key} at (${dr.lx.toFixed(1)}, ${dr.lz.toFixed(1)})`; }
    if (Math.min(dr.w, dr.h, dr.d) >= 0.55) bevelled++;
  }
  return {
    count: dressing.length, worstGhost, worstAt, bevelled,
    ok: worstGhost <= GHOST_MAX + 1e-6,
  };
}

/* Scratch. One set per function - see the note in physics/Physics.js. */
const _v = new THREE.Vector3();
const _h = new THREE.Vector3();
/** Segment centre for a long collider, so {@link buildOasis} allocates none. */
const _vs = new THREE.Vector3();

/**
 * The longest a single collider may be before it is emitted as a run of them.
 *
 * `Physics.cellSize` is 12 m and `Physics._gridRange` inserts a box on its
 * BOUNDING SPHERE - its own comment says the sphere bound is wrong for anything
 * that is not "roughly cube-ish", and a terrace course is the worst case there
 * is. Each ring of the tank is four boxes spanning a whole side, up to 51.4 m
 * long and 0.6 m deep, and ten concentric rings are all centred on the same
 * point: measured on the shipped world, one such bar claimed 30 broadphase
 * cells and occupied 4, the 262 oasis colliders claimed 2,819 grid entries
 * against 800 for their true XZ footprints, and the worst cell in the entire
 * world was 97 colliders at (-300, -96) - the sand-mirror - against 45 in the
 * densest street of the souk. `groundHeight` at the palm-well tank cost 7.50 us
 * a call against 0.32 in the open flats.
 *
 * Splitting the COLLIDER only - the visual box is untouched, so nothing about
 * the draw call, the merge or the triangle count changes - takes the worst cell
 * in the world from 97 back to 63, the smear from 2,819 grid entries over 800
 * true footprints to 2,206 over 1,049, and `groundHeight` at the palm-well tank
 * from 7.50 us a call to 4.4-4.9. It costs 200 colliders, 4,225 -> 4,425
 * against C4's ceiling of 20,000.
 *
 * TWENTY, and the number is swept rather than reasoned. Worst broadphase cell
 * against segment length, whole world, same build:
 *
 *      6 m   75      1,164 oasis colliders
 *      8 m   69        916
 *     12 m   64        662
 *     16 m   63        542
 *     20 m   63        462
 *     24 m   68        402
 *   no split 97        262
 *
 * The curve is flat from 12 to 20 and turns up at both ends: below the grid's
 * own 12 m resolution each extra split adds a collider whose bounding sphere
 * claims more than the smear it removed, and above 20 the bars are long enough
 * to start smearing again. 20 is the cheapest point on the flat, which also
 * keeps one tank's build under C5's 250-colliders-between-yields floor -
 * measured at 219 in 9.4 ms.
 */
const COLLIDER_SEG_M = 20;

/**
 * How far consecutive segments of a split collider overlap, metres.
 *
 * Not decoration. Segments that merely ABUT leave a zero-width seam, and
 * `citadel-oasis.test.mjs` already documents what a downward ray does at one:
 * "a downward ray on a shared face falls between both boxes and reports the
 * terrain 0.95 m below". Splitting the terrace courses without this put four
 * new seams per course into the bank and the inbound traverse read a 0.72 m
 * drop where the bank is a flight of 0.40 m risers.
 *
 * Only the INTERIOR faces are grown, so the union of the segments is exactly
 * the extent of the box they replaced - the tank does not get 4 cm wider and
 * the crest walkway is the same 1.30 m it was.
 */
const COLLIDER_SEG_OVERLAP = 0.02;
const _bm = new THREE.Matrix4();
const _bq = new THREE.Quaternion();
const _be = new THREE.Euler();
const _bs = new THREE.Vector3(1, 1, 1);

/** Deterministic PRNG, same one Citadel uses. A world regenerates identically. */
function mulberry32(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ====================================================================== */
/* The plan                                                               */
/* ====================================================================== */

/**
 * Turn a site into a full ring profile.
 *
 * Pure: no physics, no scene, no terrain. `bedY` is whatever the caller says
 * it is, which for a real placement is {@link settleOasis}'s answer and for a
 * geometry test is 0. Everything else is derived, so the profile can never
 * disagree with itself.
 *
 * @param {{id?:string,label?:string,x:number,z:number,yaw?:number,bedY?:number,
 *          baseY?:number}} site
 * @returns {object} the plan
 */
export function oasisPlan(site) {
  const bedY = site.bedY ?? 0;
  const baseY = site.baseY ?? bedY - BURY;
  const waterY = bedY + POOL_DEPTH;
  const yaw = site.yaw ?? 0;

  /** @type {Array<object>} */
  const rings = [];
  // The floor is a slab, not an annulus: there is nothing inside it.
  rings.push({
    id: 'floor', kind: 'floor',
    top: bedY, depth: POOL_DEPTH,
    ihx: 0, ihz: 0, hx: FLOOR_HX, hz: FLOOR_HZ,
    rise: 0,
  });

  let hx = FLOOR_HX;
  let hz = FLOOR_HZ;
  let top = bedY;
  for (const s of SHELVES) {
    const ihx = hx;
    const ihz = hz;
    hx += s.tread;
    hz += s.tread;
    top += s.rise;
    rings.push({
      id: s.id, kind: s.id === 'crest' ? 'crest' : 'shelf',
      top, depth: waterY - top,
      ihx, ihz, hx, hz, rise: s.rise,
    });
  }

  const crest = rings[rings.length - 1];
  const crestY = crest.top;
  // The water plane stops at the crest's INNER edge, which is `c2`'s outer
  // edge. Anything wider would put water over the dry promenade.
  const water = { hx: crest.ihx, hz: crest.ihz, y: waterY };

  // Apron: courses stepping back down and outward from the crest, the first
  // flight at full rise and the feather at half. See the note on APRON_COURSES.
  let ahx = crest.hx;
  let ahz = crest.hz;
  let atop = crestY;
  const courses = APRON_COURSES + FEATHER_COURSES;
  for (let i = 0; i < courses; i++) {
    const feather = i >= APRON_COURSES;
    const rise = feather ? FEATHER_RISE : APRON_RISE;
    const tread = feather ? FEATHER_TREAD : APRON_TREAD;
    const ihx = ahx;
    const ihz = ahz;
    ahx += tread;
    ahz += tread;
    atop -= rise;
    rings.push({
      id: `a${i + 1}`, kind: 'apron', feather,
      top: atop, depth: waterY - atop,
      ihx, ihz, hx: ahx, hz: ahz, rise,
    });
  }

  /* The shoreline travels WITH the plan, seeded off the site so the two oases
   * are two different pools and a rebuild of either is the same pool twice.
   * On the plan rather than in `buildOasis` because the water plane, the sand
   * bars that fill what it leaves dry, the reeds and the rocks all read it,
   * and a shoreline computed four times is four shorelines. */
  const id = site.id ?? 'oasis';
  // charCodeAt in a loop rather than split('').reduce(): `findOasisSite` builds
  // a plan per candidate bearing per ring - up to 512 of them for one site -
  // and the split allocates an array of single-character strings for each.
  let seed = 7;
  for (let i = 0; i < id.length; i++) seed = (seed * 131 + id.charCodeAt(i)) >>> 0;
  seed ^= Math.round(site.x * 7 + site.z * 13) >>> 0;

  return {
    id: site.id ?? 'oasis',
    label: site.label ?? 'The Oasis',
    x: site.x, z: site.z, yaw,
    bedY, baseY, waterY, crestY,
    grade: site.grade ?? null,
    rings, water, shore: shoreWaves(seed),
    /** Outer footprint half-extents, for the placement helpers. */
    hx: ahx, hz: ahz,
    /** Water area, m^2. Quoted in the cost report. */
    area: water.hx * water.hz * 4,
  };
}

/** Rotate a plan-local offset into world space. */
export function toWorld(plan, lx, lz, out = new THREE.Vector3()) {
  const c = Math.cos(plan.yaw);
  const s = Math.sin(plan.yaw);
  return out.set(plan.x + lx * c + lz * s, 0, plan.z - lx * s + lz * c);
}

/* ====================================================================== */
/* Placement: measure the terrain, then decide                            */
/* ====================================================================== */

/**
 * What the terrain does under an oasis footprint.
 *
 * The direct analogue of `Caves.terrainProfile`, and it answers the same
 * question for the same reason: an oasis is one horizontal water plane and one
 * levelled bed, so a site with more relief than the levelling allowance is a
 * site that wants a different oasis, not a taller plinth.
 *
 * Sampled over the WHOLE footprint including the apron, because the apron is
 * what has to meet the desert. Sampling only the basin was the first version
 * and it happily approved sites whose outer course was a metre in the air on
 * one side.
 *
 * @param {object} plan from {@link oasisPlan}
 * @param {{terrainAt:(x:number,z:number)=>number|null}} field
 *   normally a `Caves.SolidField` over the final colliders.
 * @param {number} [step] lattice pitch, metres
 * @returns {{lo:number,hi:number,relief:number,covered:number,samples:number,
 *            basinHi:number,rimLo:number}}
 */
export function oasisProfile(plan, field, step = PROFILE_STEP) {
  let lo = Infinity;
  let hi = -Infinity;
  let basinHi = -Infinity;
  let rimLo = Infinity;
  let covered = 0;
  let samples = 0;
  const nx = Math.max(2, Math.round((plan.hx * 2) / step));
  const nz = Math.max(2, Math.round((plan.hz * 2) / step));
  for (let i = 0; i < nx; i++) {
    const lx = -plan.hx + ((i + 0.5) / nx) * plan.hx * 2;
    for (let j = 0; j < nz; j++) {
      const lz = -plan.hz + ((j + 0.5) / nz) * plan.hz * 2;
      toWorld(plan, lx, lz, _v);
      samples++;
      const h = field.terrainAt(_v.x, _v.z);
      if (h === null) continue;
      covered++;
      if (h < lo) lo = h;
      if (h > hi) hi = h;
      // Under the water opening, which is what the bed has to clear.
      if (Math.abs(lx) <= plan.water.hx && Math.abs(lz) <= plan.water.hz) {
        if (h > basinHi) basinHi = h;
      } else if (h < rimLo) rimLo = h;
    }
  }
  if (!covered) {
    return { lo: 0, hi: 0, relief: 0, covered: 0, samples, basinHi: 0, rimLo: 0 };
  }
  return {
    lo, hi, relief: hi - lo, covered: covered / samples, samples,
    basinHi: Number.isFinite(basinHi) ? basinHi : hi,
    rimLo: Number.isFinite(rimLo) ? rimLo : lo,
  };
}

/**
 * Level a site into the terrain and say whether it is usable.
 *
 * The counterpart of `Caves.liftToClear`. A cave is a rigid box that gets
 * raised until it clears; an oasis is levelled instead - the bed is put at
 * `hi + BED_CLEAR` and every solid runs down to `lo - BURY`, so the tank sits
 * IN the ground on its low side and ON it at its high side, and nothing floats
 * at either end.
 *
 * `viable` is false with a reason rather than throwing, because the caller is
 * a search: a rejected site is data, not an error.
 *
 * @param {object} site as accepted by {@link oasisPlan}
 * @param {{terrainAt:(x:number,z:number)=>number|null}} field
 * @param {{step?:number, maxRelief?:number}} [opts]
 * @returns {{plan:object, profile:object, viable:boolean, reasons:string[],
 *            grade:number, lift:number}}
 */
export function settleOasis(site, field, opts = {}) {
  const step = opts.step ?? PROFILE_STEP;
  const maxRelief = opts.maxRelief ?? MAX_RELIEF;
  // Measured against a provisional plan at bed 0: the footprint does not
  // depend on the height, so one pass is enough.
  const probe = oasisPlan({ ...site, bedY: 0 });
  const profile = oasisProfile(probe, field, step);

  const reasons = [];
  if (profile.covered < 1) reasons.push(`off the terrain sheet (${(profile.covered * 100).toFixed(0)}% covered)`);
  if (profile.relief > maxRelief) reasons.push(`relief ${profile.relief.toFixed(2)} m > ${maxRelief.toFixed(2)}`);

  const bedY = profile.hi + BED_CLEAR;
  const baseY = profile.lo - BURY;
  const plan = oasisPlan({ ...site, bedY, baseY, grade: profile.hi });
  return {
    plan, profile, viable: reasons.length === 0, reasons,
    grade: profile.hi,
    /** How far the waterline ends up over the highest ground under the tank. */
    lift: plan.waterY - profile.hi,
  };
}

/**
 * Is the footprint empty of anything the world already built?
 *
 * The oasis levels ~1,600 m^2 of desert. Dropping that on top of a caravan
 * camp would build the tank around somebody else's tents and every audit that
 * is not looking for it would pass - which is exactly the failure
 * `Caves.auditVacancy` exists to catch, so this is the same idea at oasis
 * scale: ask the FINAL collider set, not the builder.
 *
 * @param {object} plan
 * @param {{candidates:(x:number,z:number)=>Iterable<object>}} field a SolidField
 * @param {{step?:number, headroom?:number}} [opts]
 * @returns {{occupied:number, samples:number, worstAt:{x:number,z:number}|null}}
 */
export function auditVacancy(plan, field, opts = {}) {
  const step = opts.step ?? 2.0;
  const headroom = opts.headroom ?? 4.0;
  let occupied = 0;
  let samples = 0;
  let worstAt = null;
  const nx = Math.max(2, Math.round((plan.hx * 2) / step));
  const nz = Math.max(2, Math.round((plan.hz * 2) / step));
  const y0 = plan.baseY;
  const y1 = plan.crestY + headroom;
  for (let i = 0; i < nx; i++) {
    const lx = -plan.hx + ((i + 0.5) / nx) * plan.hx * 2;
    for (let j = 0; j < nz; j++) {
      const lz = -plan.hz + ((j + 0.5) / nz) * plan.hz * 2;
      toWorld(plan, lx, lz, _v);
      samples++;
      let hit = false;
      for (const b of field.candidates(_v.x, _v.z)) {
        if (b.top < y0 || b.bot > y1) continue;
        const dx = _v.x - b.x;
        const dz = _v.z - b.z;
        const bx = dx * b.cos - dz * b.sin;
        const bz = dx * b.sin + dz * b.cos;
        if (Math.abs(bx) <= b.hx && Math.abs(bz) <= b.hz) { hit = true; break; }
      }
      if (hit) {
        occupied++;
        if (!worstAt) worstAt = { x: _v.x, z: _v.z };
      }
    }
  }
  return { occupied, samples, worstAt };
}

/**
 * The nearest level, empty, on-sheet site to an anchor.
 *
 * Rings of ascending radius, first ring that yields a site wins, flattest
 * candidate on that ring. Lifted wholesale from the reasoning in
 * `citadel-caves.test.mjs:siteFor`: ranking on relief alone puts everything
 * out on the flattest dead desert in the world, which is a true answer to the
 * wrong question. Nearest-that-works is the objective.
 *
 * @param {{terrainAt:Function, candidates?:Function}} field
 * @param {{x:number,z:number}} anchor
 * @param {{id?:string,label?:string,reach?:number,rings?:number[],bearings?:number,
 *          maxRelief?:number, avoid?:Array<{x:number,z:number,r:number}>}} [opts]
 * @returns {{plan:object,profile:object,distance:number,relief:number}|null}
 */
export function findOasisSite(field, anchor, opts = {}) {
  const reach = opts.reach ?? 90;
  /* Fine and starting close. The list used to begin at 0.3 of `reach`, which
   * at reach 120 never sampled inside 36 m of the anchor - and the flattest
   * ground near the first anchor is 20 m from it. */
  const fracs = opts.rings ?? [0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1.05, 1.2];
  const bearings = opts.bearings ?? 32;
  const avoid = opts.avoid ?? [];
  for (const f of fracs) {
    const d = reach * f;
    let best = null;
    for (let i = 0; i < bearings; i++) {
      const a = (i / bearings) * Math.PI * 2;
      const x = anchor.x + Math.cos(a) * d;
      const z = anchor.z + Math.sin(a) * d;
      let blocked = false;
      for (const av of avoid) {
        if (Math.hypot(x - av.x, z - av.z) < av.r) { blocked = true; break; }
      }
      if (blocked) continue;
      const settled = settleOasis(
        { id: opts.id, label: opts.label, x, z, yaw: a }, field,
        /* THE SAME LATTICE THE FINAL SETTLE USES, and it is not an oversight
         * that this is not coarser. It was 2.5 m, to save the 168 profiles a
         * search runs; at that pitch it approved a site that measured 0.39 m
         * of relief when the winner was re-settled at 1.0 m, because the coarse
         * pass stepped straight over the ridge. The whole saving was 55 ms.
         * @see PROFILE_STEP */
        { maxRelief: opts.maxRelief, step: opts.step ?? PROFILE_STEP }
      );
      if (!settled.viable) continue;
      if (field.candidates) {
        const vac = auditVacancy(settled.plan, field);
        if (vac.occupied) continue;
      }
      if (best && settled.profile.relief >= best.profile.relief) continue;
      best = { ...settled, distance: d, relief: settled.profile.relief };
    }
    if (best) return best;
  }
  return null;
}

/* ====================================================================== */
/* Audits: the two things that can soft-lock a player                     */
/* ====================================================================== */

/**
 * AUDIT 1 - can a swimmer get out, and can a walker get in without falling?
 *
 * Pure geometry: it reads the plan's own risers against the swim controller's
 * thresholds and the walking controller's step height. It is NOT the proof -
 * the proof is driving the real `Player` through the real colliders - but it
 * is the thing that fails first and points at the shelf that broke.
 *
 * @param {object} plan
 * @returns {{worstSwimRiser:number, worstSwimAt:string|null,
 *            worstDryRiser:number, worstDryAt:string|null,
 *            worstDrop:number, swimBand:{from:number,to:number,risers:number},
 *            liftFraction:number, ok:boolean, notes:string[]}}
 */
export function auditShoreline(plan) {
  const notes = [];
  let worstSwimRiser = 0;
  let worstSwimAt = null;
  let worstDryRiser = 0;
  let worstDryAt = null;
  let worstDryDrop = 0;
  let bandFrom = null;
  let bandTo = null;
  let bandRisers = 0;
  let liftFraction = 1;

  /* The basin, from the floor outward. An apron course is dry ground on the
   * far side of the crest and its `depth` is a fiction - it is the depth the
   * water WOULD have if the tank had no walls - so it is walked separately
   * below. Counting it as pool was the first version of this audit and it
   * reported the outer bank as a wall the swimmer could not climb. */
  const basin = plan.rings.filter((r) => r.kind !== 'apron');
  for (let i = 1; i < basin.length; i++) {
    const r = basin[i];
    const prev = basin[i - 1];
    /* Is the player still in swim mode while standing on the shelf INSIDE
     * this riser? That, and not the depth of the shelf being climbed, is what
     * decides whether they have a step-up available. */
    const swimming = prev.depth >= SWIM_EXIT_DEPTH;
    /* ...and is this shelf actually above a floating body's feet? Below them
     * the swimmer simply drifts over it and the riser is irrelevant. */
    const aboveFeet = r.depth < FLOAT_DEPTH;
    if (swimming && aboveFeet) {
      bandRisers++;
      if (bandFrom === null) bandFrom = prev.depth;
      bandTo = r.depth;
      if (r.rise > worstSwimRiser) { worstSwimRiser = r.rise; worstSwimAt = r.id; }
      /* Eviction direction. The swimmer's feet are seated on `prev`, so the
       * riser's top edge is `rise` above them and `CAPSULE_R - rise` below the
       * bottom sphere's centre; `resolveCapsule` pushes along that, i.e.
       * `(CAPSULE_R - rise) / CAPSULE_R` of the push is upward. Positive lifts
       * the swimmer out, negative drives them under. */
      const lift = (CAPSULE_R - r.rise) / CAPSULE_R;
      if (lift < liftFraction) liftFraction = lift;
    } else if (!swimming) {
      if (r.rise > worstDryRiser) { worstDryRiser = r.rise; worstDryAt = r.id; }
    }
  }
  // Every apron course, plus the crest's own outward step.
  for (const r of plan.rings) {
    if (r.kind !== 'apron') continue;
    if (r.rise > worstDryRiser) { worstDryRiser = r.rise; worstDryAt = r.id; }
  }
  // The tallest drop off any DRY surface. This is the "not a cliff" number.
  for (const r of plan.rings) {
    if (r.top <= plan.waterY) continue;
    if (r.rise > worstDryDrop) worstDryDrop = r.rise;
  }

  if (worstSwimRiser > 0.20) {
    notes.push(`swim-band riser ${worstSwimRiser.toFixed(2)} m at ${worstSwimAt}`
      + ' - eviction turns downward past 0.35 m and the swimmer is walled in');
  }
  if (worstDryRiser >= STEP_MAX) {
    notes.push(`dry riser ${worstDryRiser.toFixed(2)} m at ${worstDryAt} >= step-up ${STEP_MAX}`);
  }
  if (liftFraction <= 0.4) {
    notes.push(`weakest upward eviction in the swim band is ${(liftFraction * 100).toFixed(0)}%`);
  }
  return {
    worstSwimRiser, worstSwimAt, worstDryRiser, worstDryAt, worstDryDrop,
    swimBand: { from: bandFrom ?? 0, to: bandTo ?? 0, risers: bandRisers },
    liftFraction, ok: notes.length === 0, notes,
  };
}

/**
 * AUDIT 2 - is the tank actually standing on the ground?
 *
 * Asks the FINAL collider set whether the terrain rises through any shelf and
 * whether any shelf floats over it. A shelf the terrain pokes through is a
 * shelf the player is shoved up off; a shelf hanging in the air is a hole they
 * fall into on the way to the water.
 *
 * @param {object} plan
 * @param {{terrainAt:Function}} field
 * @param {number} [step]
 * @returns {{samples:number, pierced:number, worstPierce:number,
 *            buried:number, worstBury:number,
 *            floating:number, worstFloat:number, ok:boolean}}
 */
export function auditGrounded(plan, field, step = PROFILE_STEP) {
  let samples = 0;
  let pierced = 0;
  let worstPierce = 0;
  let buried = 0;
  let worstBury = 0;
  let floating = 0;
  let worstFloat = 0;
  for (const r of plan.rings) {
    const nx = Math.max(2, Math.round((r.hx * 2) / step));
    const nz = Math.max(2, Math.round((r.hz * 2) / step));
    for (let i = 0; i < nx; i++) {
      const lx = -r.hx + ((i + 0.5) / nx) * r.hx * 2;
      for (let j = 0; j < nz; j++) {
        const lz = -r.hz + ((j + 0.5) / nz) * r.hz * 2;
        // Annulus only: the inside belongs to a deeper ring.
        if (r.kind !== 'floor' && Math.abs(lx) < r.ihx && Math.abs(lz) < r.ihz) continue;
        toWorld(plan, lx, lz, _v);
        const h = field.terrainAt(_v.x, _v.z);
        if (h === null) continue;
        samples++;
        if (h > r.top) {
          /* An apron course under the sand is the bank doing its job - see the
           * note on APRON_COURSES. A BASIN course under the sand is the
           * heightfield rule biting, and it is the failure this audit is for. */
          if (r.kind === 'apron') {
            buried++;
            if (h - r.top > worstBury) worstBury = h - r.top;
          } else {
            pierced++;
            if (h - r.top > worstPierce) worstPierce = h - r.top;
          }
        }
        if (plan.baseY > h) {
          floating++;
          if (plan.baseY - h > worstFloat) worstFloat = plan.baseY - h;
        }
      }
    }
  }
  return {
    samples, pierced, worstPierce, buried, worstBury, floating, worstFloat,
    ok: pierced === 0 && floating === 0,
  };
}

/* ====================================================================== */
/* Geometry: the palm, and a fallback batch                               */
/* ====================================================================== */

/**
 * A date palm, built to the same recipe as `CitadelWorld._buildTrees`.
 *
 * A DELIBERATE SECOND COPY, and the comment matters more than the code. The
 * original lives inside `_buildTrees` as two local `BufferGeometry`s and is
 * not exported; that file belongs to another agent and this kit may not edit
 * it. A new palm species here would be worse than a copy - the oasis would be
 * the one place in the Citadel where the trees are a different tree.
 *
 * So the intended call is `buildOasis(ctx)` with `ctx.palm = { trunk, crown }`
 * taken from the world's own builder, which costs nothing and keeps ONE
 * geometry. This function is the standalone fallback, and the moment
 * `CitadelWorld` exports its pair, delete it and import theirs.
 *
 * @param {() => number} rnd
 * @returns {{trunk:THREE.BufferGeometry, crown:THREE.BufferGeometry}}
 */
export function palmGeometry(rnd = mulberry32(7)) {
  const TAU = Math.PI * 2;
  const H = 6.4;
  const trunkSecs = [];
  for (let i = 0; i <= 9; i++) {
    const t = i / 9;
    trunkSecs.push({
      x: Math.sin(t * 1.5) * 0.34 * t,
      y: t * H,
      z: Math.cos(t * 2.1) * 0.16 * t,
      rx: 0.30 - t * 0.11 + Math.exp(-t * 9) * 0.10,
      ry: 0.30 - t * 0.11 + Math.exp(-t * 9) * 0.10,
    });
  }
  const trunk = sweep(trunkSecs, 12, { capStart: false });
  const cx = trunkSecs[9].x;
  const cy = trunkSecs[9].y;
  const cz = trunkSecs[9].z;

  const fronds = [];
  const NF = 22;
  for (let f = 0; f < NF; f++) {
    const fa = (f / NF) * TAU + rnd() * 0.16;
    const age = (f % 2 === 0 ? f / NF : 1 - f / NF);
    const pitch = 0.95 - age * 1.75;
    const len = 3.6 + rnd() * 1.1;
    const segs = 8;
    const stations = [];
    let px = cx;
    let py = cy;
    let pz = cz;
    let ang = pitch;
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const w = (0.10 + Math.sin(Math.pow(t, 0.8) * Math.PI) * 0.15) * (1 - t * 0.55);
      stations.push({ x: px, y: py, z: pz, rx: Math.max(0.012, w), ry: 0.016 });
      if (s === segs) break;
      const segLen = len / segs;
      ang -= (0.13 + age * 0.085);
      px += Math.cos(fa) * Math.cos(ang) * segLen;
      py += Math.sin(ang) * segLen;
      pz += Math.sin(fa) * Math.cos(ang) * segLen;
    }
    fronds.push(sweep(stations, 4, { capStart: false }));
  }
  for (let d = 0; d < 3; d++) {
    const da = (d / 3) * TAU + 0.4;
    fronds.push(blob(0.26, 0.34, 0.26,
      cx + Math.cos(da) * 0.42, cy - 0.42, cz + Math.sin(da) * 0.42, 8));
  }
  const crown = mergeGeometries(fronds.map((g) => (g.index ? g.toNonIndexed() : g)), false);
  for (const g of fronds) g.dispose();
  return { trunk, crown };
}

/**
 * A minimal accumulator with `CitadelWorld`'s `Batch.box` signature.
 *
 * Only used when the host does not hand one in. When it does, the oasis merges
 * into the world's own per-material buckets and costs no extra draw call -
 * which is the single reason this interface is shaped exactly like Citadel's.
 * Identical in role to `Caves.CaveBatch`; kept separate so the oasis kit has
 * no build-order dependency on the cave kit.
 */
export class OasisBatch {
  constructor() {
    this.buckets = new Map();
    this._owned = [];
  }

  box(key, w, h, d, x, y, z, rotY = 0, tint = null) {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rotY) g.rotateY(rotY);
    g.translate(x, y, z);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    const c = new THREE.Color(tint === null ? 0xffffff : tint);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    let list = this.buckets.get(key);
    if (!list) this.buckets.set(key, (list = []));
    list.push(g);
  }

  flush(group, resolve, name = 'oasis') {
    const out = [];
    for (const [key, list] of this.buckets) {
      if (!list.length) continue;
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
      for (const g of list) if (g !== merged) g.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, resolve(key));
      mesh.name = `${name}:${key}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      out.push(mesh);
      this._owned.push(merged);
    }
    this.buckets.clear();
    return out;
  }

  dispose() {
    for (const g of this._owned) g.dispose();
    this._owned.length = 0;
  }
}

/**
 * Triangles the emitted solids will cost once the host batch has merged them.
 *
 * Counted from the DESCRIPTORS rather than from a batch, because the host's
 * `Batch.box` bevels anything whose smallest dimension reaches `bevelMin` and
 * a bevelled box is 108 triangles against a plain one's 12 - a factor of nine
 * that a private `OasisBatch` (which never bevels) would hide completely.
 * Defaults are `CitadelWorld`'s `BEVEL_MIN` and `BEVEL`.
 *
 * @param {Array<{w:number,h:number,d:number}>} solids
 * @param {{bevelMin?:number, bevel?:number}} [opts]
 * @returns {{boxes:number, bevelled:number, plain:number, triangles:number}}
 */
export function solidCost(solids, opts = {}) {
  const bevelMin = opts.bevelMin ?? 0.55;
  const bevel = opts.bevel ?? 0.075;
  let bevelled = 0;
  for (const s of solids) {
    const min = Math.min(s.w, s.h, s.d);
    const r = Math.min(bevel, s.w * 0.22, s.h * 0.22, s.d * 0.22);
    if (min >= bevelMin && r > 0.02) bevelled++;
  }
  const plain = solids.length - bevelled;
  return { boxes: solids.length, bevelled, plain, triangles: bevelled * 108 + plain * 12 };
}

/** Triangles a geometry holds. */
export function triangleCount(geo) {
  if (!geo) return 0;
  const pos = geo.attributes?.position;
  if (!pos) return 0;
  return (geo.index ? geo.index.count : pos.count) / 3;
}

/* ====================================================================== */
/* The build                                                              */
/* ====================================================================== */

/**
 * The palette, and it is the single biggest thing that was wrong here.
 *
 * Every ring used to be keyed on `r.depth > 0` - `stone.cobble` if the water
 * would reach it, `plaster.wall` if not. `depth` on an APRON course is a
 * fiction, and the file says so two hundred lines up: it is the depth the
 * water would have if the tank had no walls. The first apron course tops out
 * 0.15 m under the waterline, so `depth > 0` was true for all fifteen of them
 * and the ENTIRE OUTER BANK - the part of this thing that is dry ground on the
 * desert side of a wall - was being drawn in cobblestone, in the algae tints
 * meant for the pool lining. That is the stepped grey ziggurat in the frame,
 * and it was one boolean.
 *
 * Keyed on `kind` now, which cannot lie: apron and crest are dry sand, the
 * basin is wet sand going olive as it deepens, and the only stone left in the
 * oasis is the well curb and the fire ring - the two things somebody built.
 */
/**
 * THE DESERT'S OWN COLOUR, and the number is derived rather than picked.
 *
 * `CitadelWorld._buildTerrain` draws the whole desert with the library's
 * `dirt.ground` under `color = 0xe3d0a6`. Everything this file emits also goes
 * out as `dirt.ground`, and `CitadelWorld._mat` pre-multiplies that key by
 * `0xe0cda3` before the per-box tint reaches it. So the tint that makes a box
 * EXACTLY the colour of the sand beside it is 0xe3d0a6 / 0xe0cda3, which is
 * (1.013, 1.015, 1.018) - white, to within a rounding error.
 *
 * That is what "bury it" means here in practice. The outer bank is tinted to
 * the desert, the crest a shade paler where the sun bleaches a rim, the strand
 * darker because damp sand is darker, and the bed paler again because a pool
 * only reads turquoise when there is bright sand under it. The tank stops
 * being an object standing ON the desert and becomes a hollow IN it.
 *
 * 0xfdf7ea rather than the 0xffffff the division gives, because `Batch.box`
 * bakes an AO ramp into every piece it merges and the tint is what that ramp
 * scales: at pure white the sunward top of a lobe has nowhere left to go and
 * the sand flat-tops. One percent of headroom is enough and is invisible.
 */
const DESERT = 0xfdf7ea;
/** The bank, inner course to outer: a bleached rim washing out into the sand. */
const BANK_IN = 0xe9dcc0;
const BANK_OUT = DESERT;
/** The crest promenade, walked bare and bleached. */
const SAND = [0xf2e8d2, 0xece0c6, 0xf6eeda, 0xe6dabe];
/** The strand and the shallows: damp, a shade darker and browner. */
const WET_SAND = [0xd8ccb0, 0xcfc2a4, 0xe1d5b8, 0xc7ba9c];
/**
 * The bed. PALE, and that is not an accident either: a pool reads turquoise
 * because there is bright sand under it, and the old bed was 0x8b7f5f - a dark
 * olive that any amount of water over it resolves to near-black. The water is
 * transparent now (see {@link oasisWaterMaterial}), so what is under it is
 * most of what the player sees of it.
 */
const BED = [0xc6c0a2, 0xbcb698, 0xd0caac, 0xb2ad90];
/** Rock at the strand and on the bank. Warm grey, not the world's cold stone. */
const ROCK = [0xa89a82, 0x9c8f79, 0xb4a68c, 0x91856f];

/** Blend two packed sRGB hexes. Channel-wise, which is what a tint is. */
function mixHex(a, b, t) {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const r = ((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * k;
  const g = ((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * k;
  const bl = (a & 255) + ((b & 255) - (a & 255)) * k;
  return ((r & 255) << 16) | ((g & 255) << 8) | (bl & 255);
}

/**
 * How far out on the bank a course is, 0 at the crest and 1 at the last one.
 * The apron ids are `a1`..`a15` in outward order, which is the only ordering
 * this needs and the only one the plan guarantees.
 */
function apronFraction(r) {
  const i = Number(r.id.slice(1));
  return Number.isFinite(i) ? (i - 1) / (APRON_COURSES + FEATHER_COURSES - 1) : 0;
}

/**
 * What a ring is made of. One place, so the bank cannot silently become a pool
 * lining again the day somebody edits the profile.
 */
export function ringSurface(r) {
  const h = (r.id.charCodeAt(0) * 131 + r.id.charCodeAt(r.id.length - 1) * 7 + r.id.length) >>> 0;
  if (r.kind === 'crest') {
    return { key: 'dirt.ground', tint: SAND[h % SAND.length] };
  }
  if (r.kind === 'apron') {
    /* Washing out into the desert as it descends, with a little jitter so no
     * two courses land on the same value and the ramp does not band. */
    const j = ((h % 7) - 3) * 0.03;
    return { key: 'dirt.ground', tint: mixHex(BANK_IN, BANK_OUT, apronFraction(r) * 1.35 + j) };
  }
  if (r.kind === 'floor' || r.depth >= 1.4) {
    return { key: 'dirt.ground', tint: BED[h % BED.length] };
  }
  return { key: 'dirt.ground', tint: WET_SAND[h % WET_SAND.length] };
}

/* ====================================================================== */
/* The water surface                                                      */
/* ====================================================================== */

/** Bearings round the pool. 56 puts a vertex every 1.4 m on a 24 m pool. */
export const WATER_SEGMENTS = 56;
/**
 * Concentric rings of the water plane, as a fraction of {@link shoreRadius}.
 *
 * THREE of them and not one, and the reason is the colour rather than the
 * shape. The body colour and the alpha are per-vertex functions of the bed
 * depth under that vertex, and the depth runs 2.45 m at the centre to 0.15 m
 * at the strand - almost all of it in the outer third, where the shelves are.
 * A single fan from the centre would interpolate that whole ramp linearly
 * across 12 m and the pool would fade out as a flat wash. The rings are placed
 * where the profile actually turns.
 */
const WATER_RINGS = [0.42, 0.78, 1.0];

/**
 * Metres of pool per UV tile, for the ripple normal map.
 *
 * The library's own number for this surface: `Materials.js:1444` sets
 * `water.pool`'s `userData.tileMeters = 4`, and the authoring rule at the head
 * of that file is that the material keeps `repeat = 1` and the GEOMETRY divides
 * world metres by this. Restated rather than read off the material because
 * {@link waterGeometry} is handed a plan and never a material, and because the
 * geometry is built before {@link oasisWaterMaterial} is called.
 *
 * @see waterGeometry the `uv` attribute, and what happened when there was none
 */
export const WATER_TILE_METRES = 4;

/** Shallow water over pale sand. */
const WATER_SHALLOW = new THREE.Color(0xa9dcc4);
/** A metre down. */
const WATER_MID = new THREE.Color(0x46a793);
/** Over the deep floor. */
const WATER_DEEP = new THREE.Color(0x15544f);
/** Scratch for the ramp - see the note in physics/Physics.js. */
const _wc = new THREE.Color();

/**
 * The colour and opacity of the water over a bed this deep.
 *
 * Not a guess at "blue". A desert pool is the colour of the sand under it seen
 * through a metre or two of green water, which means the shallows are jade,
 * the middle is teal, and only the deep floor is dark - and the ALPHA has to
 * carry as much of that as the hue does, or the edge of the pool is a hard
 * line whatever colour it is painted. This is the same shallow/deep body ramp
 * the Lido's pool shader runs in `SportsWorld._makeWaterMaterial`, evaluated
 * per vertex on the CPU instead of per fragment - which costs nothing at
 * runtime, survives the world's own material clone, and needs no second
 * shader program in a build that already compiles one per material key.
 *
 * @param {number} depth metres of water over the bed at this vertex
 * @param {number[]} out [r, g, b, a], written in place
 */
export function waterShade(depth, out) {
  const d = depth < 0 ? 0 : depth;
  if (d < 1.0) {
    _wc.copy(WATER_SHALLOW).lerp(WATER_MID, d / 1.0);
  } else {
    const t = Math.min(1, (d - 1.0) / (POOL_DEPTH - 1.0));
    _wc.copy(WATER_MID).lerp(WATER_DEEP, t * t * (3 - 2 * t));
  }
  // Alpha: see-through at the strand, near-opaque over the floor.
  const a = (d - 0.05) / 1.65;
  const k = a < 0 ? 0 : a > 1 ? 1 : a;
  out[0] = _wc.r;
  out[1] = _wc.g;
  out[2] = _wc.b;
  out[3] = 0.30 + 0.60 * (k * k * (3 - 2 * k));
  return out;
}

const _ws = [0, 0, 0, 0];

/**
 * The water plane: an irregular polygon, coloured and faded by its own depth.
 *
 * THE OUTLINE. It was a `PlaneGeometry` - a rectangle of flat saturated blue,
 * which is the second half of what was wrong with this oasis. It is now a fan
 * over {@link shoreRadius}, so the waterline wanders in and out by up to
 * {@link SHORE_INSET} and no two bearings share an edge. The bound on that
 * inset is what keeps it honest: the water may retreat across the strand and
 * no further, and every metre it retreats is filled by a sand bar from the
 * same function, so the plane never ends over ground it is higher than.
 *
 * Costs 280 triangles against the old 72. The extra 208 also buy a better
 * water VOLUME: `WaterVolumes` decomposes a surface triangle by triangle onto
 * an 8 m lattice, so a finer surface traces a tighter swimmable body.
 *
 * THE `uv` IS NOT DECORATION AND IT IS NOT OPTIONAL. `PlaneGeometry` carries
 * one; a fan built by hand does not unless it is written, and the first cut of
 * this function wrote `position`, `color` and the index and stopped. The
 * material this feeds ({@link oasisWaterMaterial}) nulls the base `map` and
 * KEEPS `normalMap`, `roughnessMap` and `clearcoatNormalMap` - the whole reason
 * for reusing the library's recipe is that `MaterialLibrary._animate` scrolls
 * those two normal layers against each other. With no `uv` attribute WebGL
 * feeds the shader the constant generic attribute (0, 0), so all three maps
 * sample ONE texel and the entire 568 m2 pool carries a single normal that
 * wobbles in unison - which is precisely the "single sliding sheet" the second
 * counter-scrolling layer exists to prevent (`Materials.js:1415-1417`).
 * Measured on the built world before the fix: `oasis:palm-well:water` had
 * `[position, color, normal]` and nothing else, against `[position, normal,
 * uv]` on the `PlaneGeometry` it replaced. @see WATER_TILE_METRES
 *
 * @param {object} plan
 * @param {number} [segments]
 * @returns {THREE.BufferGeometry} local to the plan; the mesh carries the yaw
 */
export function waterGeometry(plan, segments = WATER_SEGMENTS) {
  const nr = WATER_RINGS.length;
  const count = 1 + segments * nr;
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 4);
  const uv = new Float32Array(count * 2);
  const tris = segments + segments * 2 * (nr - 1);
  const idx = new Uint16Array(tris * 3);

  waterShade(depthAt(plan, 0, 0), _ws);
  col[0] = _ws[0]; col[1] = _ws[1]; col[2] = _ws[2]; col[3] = _ws[3];
  // The centre vertex is the local origin, so its tile coordinate is (0, 0).
  uv[0] = 0; uv[1] = 0;

  for (let r = 0; r < nr; r++) {
    const f = WATER_RINGS[r];
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const rad = shoreRadius(plan, a) * f;
      const lx = Math.cos(a) * rad;
      const lz = Math.sin(a) * rad;
      const v = 1 + r * segments + i;
      pos[v * 3] = lx;
      pos[v * 3 + 2] = lz;
      /* PLANAR, off the local XZ, and not the fan's own (ring, bearing). A
       * radial parameterisation would wind the ripple round the pool like a
       * record groove and pinch every tile to nothing at the centre vertex;
       * water ripples do not care which way the shore runs. */
      uv[v * 2] = lx / WATER_TILE_METRES;
      uv[v * 2 + 1] = lz / WATER_TILE_METRES;
      waterShade(depthAt(plan, lx, lz), _ws);
      col[v * 4] = _ws[0];
      col[v * 4 + 1] = _ws[1];
      col[v * 4 + 2] = _ws[2];
      col[v * 4 + 3] = _ws[3];
    }
  }

  let k = 0;
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    idx[k++] = 0; idx[k++] = 1 + j; idx[k++] = 1 + i;
  }
  for (let r = 0; r < nr - 1; r++) {
    const a0 = 1 + r * segments;
    const b0 = 1 + (r + 1) * segments;
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      idx[k++] = a0 + i; idx[k++] = b0 + j; idx[k++] = b0 + i;
      idx[k++] = a0 + i; idx[k++] = a0 + j; idx[k++] = b0 + j;
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  // FOUR components, not three: three.js reads `color.itemSize === 4` as vertex
  // alpha, which is the whole shoreline fade. With three it renders opaque.
  g.setAttribute('color', new THREE.BufferAttribute(col, 4));
  // Without this the ripple normal map has one texel to sample. @see the note
  // at the head of this function - it is the whole point of reusing `water.pool`.
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/**
 * The pool surface material.
 *
 * IT IS THE WORLD'S OWN `water.pool`, adjusted in place, and both the choice
 * and the mutation need defending.
 *
 * The library's recipe is the Lido's pool: a physical material over a baked
 * ripple normal map that `MaterialLibrary._animate` scrolls two ways at once.
 * That animation lives on the TEXTURE, which a clone shares, so taking the
 * world's clone keeps the moving water for free - and this kit has no frame
 * hook of its own to drive one with. What the recipe is wrong about here is
 * everything else: `color: 0x2f9fc4` is chlorinated municipal blue, its baked
 * `map` is that same blue mottled, and `transmission: 0.85` puts the pool in
 * the renderer's transmission pass to buy a refraction nobody can see through
 * 2.45 m of water. Flat saturated blue is exactly what the frame shows.
 *
 * So: the map goes, the colour goes white, and the geometry's per-vertex RGBA
 * carries both body colour and opacity ({@link waterShade}). Ordinary alpha
 * blending over a pale bed is cheaper than transmission and, unlike it, fades
 * to nothing at the strand.
 *
 * WHAT STAYS BOUND, AND WHAT IT NEEDS FROM THE GEOMETRY. Only `map` is nulled.
 * `normalMap`, `roughnessMap` and `clearcoatNormalMap` are all left in place on
 * purpose - they are the ripple, and the two normal layers are the only thing
 * here that moves. All three are sampled through `uv`, which {@link
 * waterGeometry} has to write by hand: a `BufferGeometry` assembled from
 * scratch has no `uv` unless one is set, and a bound map with no `uv` samples a
 * single texel rather than failing loudly. @see WATER_TILE_METRES
 *
 * Mutating a cached material is normally somebody else's bug. It is safe here
 * for one checkable reason: `water.pool` has exactly one consumer in the
 * Citadel, this file, and `grep water.pool src` says so. Taking a private
 * clone instead would be tidier and would leak - `CitadelWorld._owned` holds
 * what `_mat` handed out, and a clone of it is not in that list.
 *
 * @param {object} ctx as {@link buildOasis} takes it
 */
export function oasisWaterMaterial(ctx) {
  const m = ctx.mat
    ? ctx.mat('water.pool', { vertexColors: true })
    : new THREE.MeshStandardMaterial({ name: 'water.pool' });
  m.vertexColors = true;
  m.color.setHex(0xffffff);
  m.map = null;
  m.transparent = true;
  m.opacity = 1;
  // A single horizontal plane per pool, and reeds and rocks stand through it:
  // writing depth would let the surface occlude the stems behind it.
  m.depthWrite = false;
  m.side = THREE.DoubleSide;
  m.metalness = 0;
  m.roughness = 0.42;
  m.envMapIntensity = 1.15;
  if ('transmission' in m) { m.transmission = 0; m.thickness = 0; }
  if ('clearcoat' in m) { m.clearcoat = 1; m.clearcoatRoughness = 0.08; }
  if (m.normalScale) m.normalScale.set(0.8, 0.8);
  m.needsUpdate = true;
  return m;
}

/**
 * Build one oasis into a world.
 *
 * @param {{physics:object, group:THREE.Object3D,
 *          box?:(key:string,w:number,h:number,d:number,x:number,y:number,z:number,
 *                rotY?:number,tint?:number)=>void,
 *          mat?:(key:string, opts?:object)=>THREE.Material,
 *          track?:(c:any)=>any,
 *          palm?:{trunk:THREE.BufferGeometry, crown:THREE.BufferGeometry},
 *          rnd?:()=>number, palms?:number, reeds?:number}} ctx
 *   `palms` and `reeds` override {@link PALM_COUNT} and {@link REED_CLUMPS};
 *   `palms: 0` builds no grove at all, which is what the ablation cases and a
 *   host on a triangle budget want. `palm` shares one trunk/crown pair with
 *   the world's own - see {@link palmGeometry}.
 *   `box` is `CitadelWorld`'s `Batch.box`; pass it and the terraces go into the
 *   host's own merge instead of a private one - which is a draw call saved only
 *   if that batch was going to be flushed anyway. The Citadel opens a fresh
 *   batch per oasis, so its terraces do cost it meshes; see the note on
 *   `cost.draws`. Omit `box` and a private {@link OasisBatch} is used and
 *   flushed through `mat`.
 * @param {object} plan from {@link settleOasis}
 * @returns {object} see the module header
 */
export function buildOasis(ctx, plan) {
  const rnd = ctx.rnd ?? mulberry32(0x0a51 ^ Math.round(plan.x * 7 + plan.z * 13));
  const ownBatch = ctx.box ? null : new OasisBatch();
  const rawBox = ctx.box ?? ownBatch.box.bind(ownBatch);
  const track = ctx.track ?? ((c) => c);
  const colliders = [];
  /** Every solid emitted, for {@link solidCost}. */
  const solids = [];

  /**
   * One solid: a visual box in the host's batch and a collider under it.
   * Local coordinates, so the whole oasis rotates with `plan.yaw`.
   */
  const solid = (key, w, h, d, lx, cy, lz, tint, { collide = true, rot = 0 } = {}) => {
    if (w <= 1e-4 || h <= 1e-4 || d <= 1e-4) return;
    toWorld(plan, lx, lz, _v);
    /* `rot` is a turn RELATIVE to the tank, and only the dressing uses it.
     * Everything structural is axis-aligned in the plan's frame because every
     * audit in this file walks nested rectangles; a rotated terrace course
     * would be a course `ringAt` could not find. */
    rawBox(key, w, h, d, _v.x, cy, _v.z, plan.yaw + rot, tint);
    solids.push({ key, w, h, d, x: _v.x, y: cy, z: _v.z });
    if (!collide) return;
    /* ONE VISUAL BOX, A RUN OF COLLIDERS. @see COLLIDER_SEG_M - a terrace
     * course is 51 m long and 0.6 m deep, and the broadphase indexes it on a
     * 25.7 m bounding sphere. The split is exact: the segments tile the long
     * local axis end to end, at the same height, under the same yaw. */
    const along = Math.max(w, d);
    const n = along > COLLIDER_SEG_M ? Math.ceil(along / COLLIDER_SEG_M) : 1;
    if (n === 1) {
      colliders.push(track(ctx.physics.addRotatedBox(
        _v.set(_v.x, cy, _v.z), _h.set(w * 0.5, h * 0.5, d * 0.5), plan.yaw
      )));
      return;
    }
    const longX = w >= d;
    const seg = along / n;
    for (let i = 0; i < n; i++) {
      /* Interior faces overlap, outer faces do not. @see COLLIDER_SEG_OVERLAP. */
      const lo = -along * 0.5 + i * seg - (i > 0 ? COLLIDER_SEG_OVERLAP : 0);
      const hi = -along * 0.5 + (i + 1) * seg + (i < n - 1 ? COLLIDER_SEG_OVERLAP : 0);
      const off = (lo + hi) * 0.5;
      const half = (hi - lo) * 0.5;
      toWorld(plan, lx + (longX ? off : 0), lz + (longX ? 0 : off), _vs);
      colliders.push(track(ctx.physics.addRotatedBox(
        _vs.set(_vs.x, cy, _vs.z),
        _h.set(longX ? half : w * 0.5, h * 0.5, longX ? d * 0.5 : half),
        plan.yaw
      )));
    }
  };

  /* ---- the tank ---------------------------------------------------- *
   * Each ring is four boxes: two spanning the full outer width in X, two
   * filling the gap between them in Z. Every one runs from its own top down
   * to `baseY`, which is below the lowest terrain under the whole footprint -
   * so no course can float and no course can be undercut by the slope.
   */
  for (const r of plan.rings) {
    const h = r.top - plan.baseY;
    const cy = plan.baseY + h * 0.5;
    const { key, tint } = ringSurface(r);
    if (r.kind === 'floor') {
      solid(key, r.hx * 2, h, r.hz * 2, 0, cy, 0, tint);
      continue;
    }
    const band = r.hz - r.ihz;
    // North and south courses: full width.
    solid(key, r.hx * 2, h, band, 0, cy, (r.ihz + r.hz) * 0.5, tint);
    solid(key, r.hx * 2, h, band, 0, cy, -(r.ihz + r.hz) * 0.5, tint);
    // East and west courses: what is left between them.
    const bandX = r.hx - r.ihx;
    solid(key, bandX, h, r.ihz * 2, (r.ihx + r.hx) * 0.5, cy, 0, tint);
    solid(key, bandX, h, r.ihz * 2, -(r.ihx + r.hx) * 0.5, cy, 0, tint);
  }

  /* ---- the crest furniture lines ------------------------------------ *
   * Everything built on the rim is held inside a band `FURNITURE_HALF` wide,
   * centred `FURNITURE_MARGIN` inside the crest's outer edge. What is left
   * between that band and the water is {@link WALKWAY} - 1.30 m - and it runs
   * unbroken all the way round, which is what a swimmer hauling themselves out
   * at an arbitrary bearing needs. See the note on the crest tread.
   */
  const crest = plan.rings.find((r) => r.id === 'crest');
  const furnX = crest.hx - FURNITURE_MARGIN;
  const furnZ = crest.hz - FURNITURE_MARGIN;

  /* ---- the well head ------------------------------------------------ *
   * On the crest at local +X. An octagonal mud-brick curb, two posts and a
   * windlass: the thing that says this water is USED rather than found.
   */
  const wellR = 0.62;
  const wellX = furnX;
  const wellY = plan.crestY;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    solid('stone.cobble', 0.56, 0.55, 0.24,
      wellX + Math.cos(a) * wellR, wellY + 0.275, Math.sin(a) * wellR, 0xb7a37c);
  }
  solid('wood.beam', 0.16, 2.1, 0.16, wellX, wellY + 1.05, -1.0, 0x8a6a45);
  solid('wood.beam', 0.16, 2.1, 0.16, wellX, wellY + 1.05, 1.0, 0x8a6a45);
  solid('wood.beam', 0.14, 0.14, 2.3, wellX, wellY + 2.05, 0, 0x8a6a45);
  solid('wood.beam', 0.22, 0.22, 1.4, wellX, wellY + 1.72, 0, 0x7d603e);
  solid('wood.plank', 0.34, 0.42, 0.34, wellX, wellY + 1.18, 0, 0x6f5535);

  /* ---- the shelter -------------------------------------------------- *
   * Doorless: four posts, a reed roof, a bench and one wall against the wind
   * off the desert, open on the other three sides. It is shade, not a
   * building, which is why it needs no `doors` - the `Interiors` descriptor
   * below is exactly the shape `buildCave` publishes.
   */
  const shX = -furnX;
  const shZ = 0;
  const shH = 2.5;
  for (const sx of [-0.85, 0.85]) {
    for (const sz of [-1.45, 1.45]) {
      solid('wood.beam', 0.18, shH, 0.18, shX + sx, plan.crestY + shH * 0.5, shZ + sz, 0x8a6a45);
    }
  }
  solid('wood.beam', 2.1, 0.16, 0.16, shX, plan.crestY + shH + 0.08, shZ - 1.45, 0x8a6a45);
  solid('wood.beam', 2.1, 0.16, 0.16, shX, plan.crestY + shH + 0.08, shZ + 1.45, 0x8a6a45);
  /* The roof overhangs the band by 0.10 m a side and that is deliberate - it
   * is 2.66 m over the crest, well clear of a 1.75 m capsule, and an eave that
   * stops dead at the posts throws no shade on the bench. */
  solid('thatch.roof', 2.5, 0.28, 3.5, shX, plan.crestY + shH + 0.3, shZ, 0xd8c08a);
  // The one wall, on the OUTER side so it never narrows the walkway.
  solid('plaster.wall', 0.22, 1.9, 3.2, shX - 1.02, plan.crestY + 0.95, shZ, 0xc9b189);
  solid('wood.plank', 1.5, 0.16, 0.5, shX + 0.1, plan.crestY + 0.42, shZ - 0.85, 0xa8875c);
  solid('wood.plank', 0.34, 0.42, 0.5, shX + 0.1, plan.crestY + 0.21, shZ - 0.85, 0xa8875c);

  /* ---- the fire ring: somewhere to rest ----------------------------- *
   * On the +Z quarter of the crest, so the three furnished bearings are the
   * three the palms skip and the fourth is left completely clear.
   */
  const fireX = 0;
  const fireZ = furnZ;
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    solid('stone.cobble', 0.32, 0.22, 0.32,
      fireX + Math.cos(a) * 0.62, plan.crestY + 0.11, fireZ + Math.sin(a) * 0.62, 0x9a8a6e);
  }

  /* ================================================================== *
   * THE SAND                                                            *
   *                                                                     *
   * Everything from here to the water plane is dressing: `collide:false`,
   * no colliders, nothing over {@link GHOST_MAX} proud of the lowest plan
   * surface under its own footprint, nothing over `BEVEL_MIN` in its
   * smallest dimension. @see the dressing rule.
   * ================================================================== */

  /** @type {Array<{key:string,w:number,h:number,d:number,lx:number,lz:number,top:number,rot:number}>} */
  const dressing = [];

  /**
   * The sand gets its OWN stream, and that is a structural choice rather than
   * a stylistic one. Everything below draws several hundred randoms, and the
   * palm grove - the only thing after it that registers colliders - draws from
   * `rnd` after it. Sharing one stream would mean that tuning a sand lobe
   * moves eight palm trunks, which moves eight colliders, which moves the
   * broadphase; and the whole argument for this section is that it does not
   * touch the broadphase. Two streams, and the sand is free to be re-tuned.
   */
  const drnd = mulberry32((0x5a4d ^ Math.round(plan.x * 31 + plan.z * 17)) >>> 0);

  /**
   * One lobe of sand. `ghost` is how far it stands proud of the ground under
   * it, `sink` how far it reaches below, so nothing floats where the ground it
   * covers steps down.
   *
   */
  const dress = (key, w, d, lx, lz, rot, ghost, tint, sink = DRESS_SINK) => {
    const g = Math.min(ghost, GHOST_MAX);
    const h = g + sink;
    if (w <= 1e-3 || d <= 1e-3 || h <= 1e-3) return;
    const top = dressFloor(plan, lx, lz, w, d, rot) + g;
    solid(key, w, h, d, lx, top - h * 0.5, lz, tint, { collide: false, rot });
    dressing.push({ key, w, h, d, lx, lz, top, rot });
  };

  /**
   * Place a lobe INSIDE one ring's annulus, working in FACE coordinates.
   *
   * The whole of this helper is one correction, and it is worth the paragraph
   * because the first draft placed everything radially and 72 of 251 lobes -
   * 29% of the sand, 864 triangles a tank - came out invisible.
   *
   * `dressFloor` seats a lobe on the LOWEST plan surface under it. That is the
   * right conservative rule: it is what stops anything floating over a step.
   * Its consequence is that a lobe which strays one course OUTBOARD drops
   * 0.40 m and ends up BELOW the tread it was drawn for. So the placement has
   * to keep each lobe inside its own annulus, and radius is the wrong
   * coordinate to do that in: a margin of `m` along a bearing is a margin of
   * `m * |cos|` against an X face, so a lobe placed 0.5 m clear of the edge at
   * a shallow bearing was 0.15 m clear of it in the direction that mattered.
   *
   * In face coordinates the margin is the margin. The lobe is offset
   * perpendicular to its own face by at least half its width plus the skew its
   * turn adds, and its run along the face is clamped so it cannot reach round
   * a corner into the next ring. `buried` on the audit is what watches this.
   *
   * @returns {{lx:number, lz:number}|null} where it went, or null if it did
   *   not fit - a ring narrower than the lobe is a ring that gets no lobe.
   */
  const onRing = (r, a, key, long, widthFrac, turn, ghost, tint, alongOff = 0) => {
    const ex = Math.cos(a);
    const ez = Math.sin(a);
    const rOut = fitRect(ex, ez, r.hx, r.hz);
    const onX = Math.abs(ex) / r.hx >= Math.abs(ez) / r.hz;
    const sgn = onX ? (ex >= 0 ? 1 : -1) : (ez >= 0 ? 1 : -1);
    const outerF = onX ? r.hx : r.hz;
    const innerF = onX ? r.ihx : r.ihz;
    const band = outerF - innerF;
    const skew = Math.abs(Math.sin(turn)) * long * 0.5;
    const room = band - 2 * skew - 0.06;
    if (room <= 0.08) return null;
    const wide = Math.min(band * widthFrac, room);
    const half = wide * 0.5 + skew + 0.03;
    const span = Math.max(0, band - 2 * half);
    const perp = sgn * (innerF + half + drnd() * span);
    const reach = (onX ? r.hz : r.hx) - 0.06 - long * 0.5;
    const start = onX ? ez * rOut : ex * rOut;
    const at = reach <= 0 ? 0 : Math.max(-reach, Math.min(reach, start + alongOff));
    const lx = onX ? perp : at;
    const lz = onX ? at : perp;
    dress(key, onX ? wide : long, onX ? long : wide, lx, lz, turn, ghost, tint);
    return { lx, lz };
  };

  /**
   * The golden angle. Every lobe bearing in this section is a multiple of it
   * off one running counter, which is the cheapest way to get a scatter that
   * never repeats a bearing and never lines two lobes up on the same radius -
   * a modular sweep put one lobe per course at exactly the same bearing and
   * drew a seam straight down the bank.
   */
  const GOLDEN = 2.39996322972865332;
  let lobe = 0;
  /** The highest ground the profile found under the tank. A bank
   * course under this is under the sand on some bearing, so it is not dressed;
   * the toe drift is what meets the desert below that line. */
  const grade = plan.grade ?? (plan.bedY - BED_CLEAR);
  /** The bank courses that are actually above the sand. Filled by the loop below. */
  const exposed = [];

  /* ---- the bank ----------------------------------------------------- *
   * The apron reads as a ziggurat because it is a flight of rectangles of
   * identical rise and the eye locks onto the parallel lines. What draws a
   * line is the RISER face, so the sand goes into the re-entrant angle at the
   * foot of each riser and along the lip above it, in runs of random length
   * with gaps between them. Courses already under the desert are skipped -
   * the feather is buried by design and dressing it would be sand inside sand.
   */
  for (const r of plan.rings) {
    if (r.kind !== 'apron') continue;
    /* Against the HIGHEST ground under the tank, not the lowest.
     *
     * A course below `grade` is under the sand somewhere on its ring and under
     * it everywhere on the flat sites, and the first draft tested against
     * `plan.baseY + BURY` - the LOWEST - which at the sand-mirror's 0.835 m of
     * relief dressed eleven courses instead of seven. Measured on the shipped
     * tank, that rule against this one: 583 boxes and 15,540 masonry triangles
     * against 494 and 14,472, for 89 lobes a player cannot see. The toe drift
     * is what meets the desert below this line. */
    if (r.top < grade - 0.10) continue;
    const bankTint = mixHex(BANK_IN, BANK_OUT, apronFraction(r) * 1.35);
    exposed.push(r);
    for (let i = 0; i < BANK_LOBES; i++) {
      const a = lobe++ * GOLDEN;
      /* A RUN, not a bar. One long box along a course is a plank; three or
       * four shorter ones laid end to end, each with its own width and its own
       * height, is a drift. They cost the same 12 triangles each and they are
       * the difference between "the step has a kerb on it" and "sand has blown
       * along the step". */
      /* TWO OR THREE segments of 2.2-5.0 m, and not the three or four of
       * 1.6-4.2 m this started at. Same metres of drift along the course for
       * a quarter fewer boxes, and a box in the host's batch is 17 us of build
       * time - measured, by building one tank through `CitadelWorld.Batch.box`
       * and through the kit's own `OasisBatch`, which costs 2.5. The sand is
       * ~256 boxes a tank and the whole of it is 4.5 ms of the build. */
      const segs = 2 + ((drnd() * 2) | 0);
      let along = -(segs * 3.4) * 0.5;
      for (let k = 0; k < segs; k++) {
        const long = 2.2 + drnd() * 2.8;
        const off = along + long * 0.5;
        along += long * (0.86 + drnd() * 0.3);
        /* WIDE and LOW. A tall narrow lobe on a 0.9 m tread is a block sitting
         * on a step; a wide shallow one is sand that has drifted along it. The
         * ghost tops out at four fifths of a riser for the same reason: what
         * has to disappear is the FOOT of the riser face, which is what draws
         * the parallel line. Burying the whole face just moves the line up. */
        onRing(r, a, 'dirt.ground', long, 0.5 + drnd() * 0.42,
          (drnd() - 0.5) * 0.14, r.rise * (0.35 + drnd() * 0.45), bankTint, off);
      }
    }
    /* The four corners, explicitly. A rectangle announces itself at its
     * corners before it does anywhere else, and a bearing sweep hits them only
     * by luck: at 45 degrees `fitRect` lands on the middle of a face, not on
     * the corner, whenever the rectangle is not square.
     *
     * These are the one thing here that {@link onRing} cannot place, because a
     * wedge laid across a corner at 45 degrees has a diagonal longer than the
     * annulus is wide and so cannot be kept inside it. They are given the FULL
     * ghost for exactly that reason: seated by `dressFloor` on the course
     * below, `GHOST_MAX` brings them back up flush with the tread they are
     * filling - a talus across the corner riser, which is what a corner wedge
     * is for - and where one does stay inside the annulus it stands a full
     * riser proud, which is also what it is for. At the runs' ghost they came
     * out 0.12 m UNDER the tread instead.
     */
    const band = r.hz - r.ihz;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        /* ALONG the corner, not across it. `solid` turns a box so its local +X
         * lands on (cos rot, -sin rot) in the plan frame, so the direction that
         * runs tangentially round a corner at (sx, sz) is (sx, -sz) and the
         * angle is `sx * sz * PI/4`. The sign was wrong in the first draft and
         * every wedge pointed radially outward across three courses. */
        dress('dirt.ground', 1.3 + drnd() * 1.9, band * 0.95,
          sx * (r.ihx + band * (0.35 + drnd() * 0.4)),
          sz * (r.ihz + band * (0.35 + drnd() * 0.4)),
          sx * sz * (Math.PI * 0.25 + (drnd() - 0.5) * 0.25),
          /* 0.97 and not 1.0: at the full riser the wedge's top is EXACTLY
           * coplanar with the tread above it, and two coplanar surfaces
           * z-fight. A centimetre and a half under tucks it inside the
           * masonry where it is hidden, and leaves it standing 0.385 m proud
           * on the course it is actually seated on, which is the side of it
           * the player sees. */
          GHOST_MAX * (0.86 + drnd() * 0.11),
          mixHex(BANK_IN, BANK_OUT, apronFraction(r) * 1.35 + 0.05));
        lobe++;
      }
    }
  }

  /* ---- the toe ------------------------------------------------------ *
   * Where the bank meets the sand the plan is a rectangle with four corners
   * and the desert is not. These drifts lap past the footprint, seated on the
   * LOWEST ground the profile found, so wherever the desert is higher than
   * that they are buried and invisible - which is most of the rim, and is the
   * point. What shows is a ragged line instead of a plinth edge.
   */
  for (let i = 0; i < TOE_LOBES; i++) {
    const a = i * GOLDEN + 0.71;
    const ex = Math.cos(a);
    const ez = Math.sin(a);
    const rOut = fitRect(ex, ez, plan.hx, plan.hz);
    /* OUTSIDE the footprint, and the first draft had this at `rOut - 1.4 +
     * rnd * 2.6`, which put eight of twelve drifts on the feather courses -
     * i.e. under the desert, where they are 96 invisible triangles. Measured
     * on the standalone tank: 4 of 12 outside before, 12 of 12 after. */
    const rad = rOut + 0.25 + drnd() * 2.1;
    const long = 3.5 + drnd() * 7.0;
    const wide = 1.4 + drnd() * 2.4;
    const onX = Math.abs(ex) / plan.hx >= Math.abs(ez) / plan.hz;
    dress('dirt.ground', onX ? wide : long, onX ? long : wide,
      ex * rad, ez * rad, (drnd() - 0.5) * 0.55,
      TOE_GHOST * (0.45 + drnd() * 0.55), DESERT, TOE_SINK);
  }

  /* ---- the strand --------------------------------------------------- *
   * Where {@link shoreRadius} pulls the water back, it leaves shelf standing
   * under the plane - a dry gutter beside the pool, which is worse than the
   * rectangle it replaced. One sand bar per arc fills exactly that gap, so the
   * two are the same function and cannot drift apart.
   *
   * Walked round the PERIMETER rather than swept by bearing, and that is not
   * style: a bar placed on a bearing near a corner is a straight box across a
   * right angle, half of it hanging over the crest or over nothing, and
   * `dressFloor` would seat the whole thing on whichever of those is lowest -
   * i.e. under the water, leaving the gutter it was there to fill.
   */
  const strand = plan.rings.find((r) => r.id === 'c2');
  const shelf = plan.rings.find((r) => r.id === 'c1');
  const perim = 4 * (strand.hx + strand.hz);
  for (const face of [0, 1, 2, 3]) {
    const alongZ = face === 0 || face === 2;
    const sgn = face < 2 ? 1 : -1;
    const half = alongZ ? strand.hz : strand.hx;
    const outer = alongZ ? strand.hx : strand.hz;
    const inner = alongZ ? strand.ihx : strand.ihz;
    const n = Math.max(2, Math.round((SHORE_ARCS * 2 * half) / perim));
    const step = (2 * half) / n;
    for (let j = 0; j < n; j++) {
      const t = -half + (j + 0.5) * step;
      /* The WORST inset anywhere across the arc, on seven samples, and the
       * seven are the fix for a 12.2% gap: three samples over a 3.27 m arc
       * step straight over a trough in the shore function and the bar came out
       * short of the water it was meant to meet. */
      let inset = 0;
      for (let k = -3; k <= 3; k++) {
        const tt = t + k * step * (1 / 6);
        const bx = alongZ ? sgn * outer : tt;
        const bz = alongZ ? tt : sgn * outer;
        const v = shoreInset(plan, Math.atan2(bz, bx));
        if (v > inset) inset = v;
      }
      if (inset < 0.06) continue;
      /* OVERLAPPING, deliberately. Bars sized to their own arc leave a seam at
       * every join, and a seam here is a strip of strand standing dry 0.15 m
       * under the plane. Measured on the standalone tank: 9.8% of the exposed
       * strand uncovered at 0.82-0.98 of the step, 7.8% at 1.0-1.14. */
      const long = step * (1.0 + drnd() * 0.14);
      const turn = (drnd() - 0.5) * 0.09;
      /* THE INNER EDGE, and the margin on it is the last 7% of that number.
       * `dressFloor` takes the LOWEST plan surface under the box, so a bar
       * whose turned corner crosses `c2`'s inner edge by a single centimetre
       * is seated on `c1` instead - 0.40 m lower - and the whole bar sinks
       * under the water it was there to meet. Measured: one bar at (6.65,
       * 10.31) with a corner 1 cm inside `c2` came out at 2.37 against a
       * waterline of 2.57. The turn moves a corner by `halfLen * sin(turn)`,
       * so that is exactly what the margin has to cover. */
      const skew = Math.abs(Math.sin(turn)) * long * 0.5;
      const lo = Math.max(inner + 0.05 + skew, outer - inset - 0.22);
      const hi = outer + 0.08;
      const wide = hi - lo;
      if (wide < 0.12) continue;
      const mid = sgn * (lo + hi) * 0.5;
      /* Proud of the water by 2 to 22 cm: a wet bar that just breaks the
       * surface at one end of the run and a dry spit at the other. `c2` is
       * 0.15 m under the plane, so the ghost is that plus the freeboard. */
      const ghost = 0.15 + 0.02 + drnd() * 0.20;
      dress('dirt.ground', alongZ ? wide : long, alongZ ? long : wide,
        alongZ ? mid : t, alongZ ? t : mid, turn,
        ghost, WET_SAND[(j + face) % WET_SAND.length]);

      /* THE SECOND TIER. Past the strand tread the water is over `c1`, and the
       * bar above has already been clamped to `c2`'s inner edge, so what is
       * left dry is filled here at a ghost of exactly one riser - which puts
       * its top level with `c2` and makes the beach one flat surface across
       * both treads. @see SHORE_INSET. */
      const over = inset - (outer - inner);
      if (over <= 0.02) continue;
      const sOuter = alongZ ? shelf.hx : shelf.hz;
      const sInner = alongZ ? shelf.ihx : shelf.ihz;
      const lo2 = Math.max(sInner + 0.05 + skew, sOuter - over - 0.22);
      /* Overlapping the tier above by the same skew its own inner clamp gave
       * away: at `sOuter + 0.06` the two bars left a 4 cm sliver of `c2` bare
       * wherever the turn was near its limit, which is 1.1% of the strand. */
      const hi2 = sOuter + 0.10 + skew;
      if (hi2 - lo2 < 0.12) continue;
      const mid2 = sgn * (lo2 + hi2) * 0.5;
      dress('dirt.ground', alongZ ? hi2 - lo2 : long, alongZ ? long : hi2 - lo2,
        alongZ ? mid2 : t, alongZ ? t : mid2, turn,
        // A centimetre and a half under the full riser, so the part of this
        // bar that laps onto `c2` is under it rather than coplanar with it.
        GHOST_MAX - 0.015, WET_SAND[(j + face + 2) % WET_SAND.length]);
    }
  }

  /* The four corners of the strand, which the face walk above cannot reach:
   * a bar on the +x face stops at z = +hz and the one on the +z face stops at
   * x = +hx, and the square between them belongs to neither. */
  const cBand = Math.min(strand.hx - strand.ihx, strand.hz - strand.ihz) * 0.9;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      /* AXIS-ALIGNED and sized to the corner square of the annulus itself. A
       * turned box here reaches past `c2` on its diagonal, `dressFloor`
       * correctly seats it on `c1` 0.40 m lower, and the corner comes out
       * under the water instead of beside it. */
      dress('dirt.ground', cBand, cBand,
        sx * (strand.hx - cBand * 0.5), sz * (strand.hz - cBand * 0.5), 0,
        0.17 + drnd() * 0.16, WET_SAND[(sx + sz + 2) % WET_SAND.length]);
    }
  }

  /* ---- shoals -------------------------------------------------------- *
   * Pale sand under the water, out on the shelves. Nothing breaks the surface
   * here; they exist so the shallows have something bright to be shallow OVER,
   * which is the other half of why a real oasis is turquoise.
   *
   * Placed ON a named shelf through {@link onRing}, not at a radius: a shoal
   * sized freely spans three 0.60 m annuli, `dressFloor` seats it on the
   * outermost and lowest of them, and all six came out under the shelf they
   * were drawn for.
   */
  const shoalRings = plan.rings.filter((r) => r.id === 'b1' || r.id === 'b2'
    || r.id === 'b3' || r.id === 'b4' || r.id === 's2');
  for (let i = 0; i < SHOAL_BARS; i++) {
    const a = i * GOLDEN + 1.93;
    const r = shoalRings[(drnd() * shoalRings.length) | 0];
    onRing(r, a, 'dirt.ground', 2.2 + drnd() * 3.2, 0.85,
      (drnd() - 0.5) * 0.12, 0.16 + drnd() * 0.22,
      WET_SAND[(i * 3) % WET_SAND.length]);
  }

  /* ---- rocks --------------------------------------------------------- *
   * Half-drowned at the strand and scattered up the bank. Small, so the eye
   * has a scale reference at the shore, and placed ON a ring so a boulder
   * straddling two shelves is not quietly sunk into the lower one - seven of
   * ten were, before {@link onRing}.
   *
   * Two boxes each, a base and a smaller cap turned across it: 24 triangles
   * for something that reads as a boulder, against 108 for one box big enough
   * for `Batch.box` to bevel - and a bevelled box at this size is still a box
   * with 7 cm off its edges. The cap is measured from the same plan surface as
   * the base, not stacked on it: the ghost bound is about the ground.
   */
  const rockRings = plan.rings.filter((r) => r.id === 'c2' || r.id === 'c1'
    || r.kind === 'crest' || (r.kind === 'apron' && exposed.includes(r)));
  for (let i = 0; i < SHORE_ROCKS; i++) {
    const a = i * GOLDEN + 3.31;
    const r = i % 3 === 2 && exposed.length
      ? exposed[(drnd() * exposed.length) | 0]
      : rockRings[(drnd() * Math.min(2, rockRings.length)) | 0];
    const long = 0.62 + drnd() * 0.55;
    const turn = drnd() * Math.PI;
    const tint = ROCK[i % ROCK.length];
    const seat = onRing(r, a, 'stone.cobble', long, 0.9, turn, 0.2 + drnd() * 0.08, tint);
    if (!seat) continue;
    dress('stone.cobble', long * 0.6, long * 0.5,
      seat.lx + (drnd() - 0.5) * 0.16, seat.lz + (drnd() - 0.5) * 0.16,
      turn + 0.5 + drnd() * 0.6, 0.3 + drnd() * 0.09, tint);
  }

  /* ---- reeds along the strand --------------------------------------- *
   * Now placed against {@link shoreRadius} rather than against the strand
   * rectangle, so they cluster in the inlets the water cuts and thin out on
   * the spits - which is what breaks the remaining straight edge at eye level.
   * Thin, so `Batch.box` leaves them square: 12 triangles a stem.
   *
   * Not in `dressing` and not bound by {@link GHOST_MAX}: a reed is grass, it
   * is 6 cm across, and every blade of `grass.field` in this world is walked
   * through. The bound is about sand you could mistake for a step.
   */
  const clumps = ctx.reeds ?? REED_CLUMPS;
  for (let i = 0; i < clumps; i++) {
    const a = i * GOLDEN + 0.37;
    const ex = Math.cos(a);
    const ez = Math.sin(a);
    // Straddling the waterline: some stems in the shallows, some on the sand.
    const rad = shoreRadius(plan, a) + (drnd() - 0.45) * 1.1;
    const px = ex * rad;
    const pz = ez * rad;
    const stems = 3 + (drnd() < 0.4 ? 1 : 0);
    for (let b = 0; b < stems; b++) {
      const sx = px + (drnd() - 0.5) * 0.55;
      const sz = pz + (drnd() - 0.5) * 0.55;
      const hgt = 0.9 + drnd() * 0.8;
      solid('grass.field', 0.06, hgt, 0.06,
        sx, surfaceAt(plan, sx, sz) + hgt * 0.5, sz,
        0xb9c47e, { collide: false });
    }
  }

  /* ---- palms -------------------------------------------------------- *
   * Instanced, two draws, and the field's bounding sphere is the crest ring -
   * about 20 m - so the frustum can reject the whole grove. The world's own
   * palm fields are 81 m spheres that never leave the frustum from anywhere;
   * this is the one thing the oasis does better than the town it borrows from.
   */
  const palmCount = ctx.palms ?? PALM_COUNT;
  const palm = ctx.palm ?? palmGeometry(mulberry32(11));
  const ownPalm = !ctx.palm;
  const palmMeshes = [];
  const palmSpots = [];
  if (palmCount > 0) {
    for (let i = 0; i < palmCount; i++) {
      // Spread round the crest, skipping the two service bearings so a palm
      // never grows through the well head or the shelter roof.
      const a = ((i + 0.5) / palmCount) * Math.PI * 2 + 0.31;
      const ex = Math.cos(a);
      const ez = Math.sin(a);
      // On the furniture line, never on the walkway.
      const k = 1 / Math.max(Math.abs(ex) / furnX, Math.abs(ez) / furnZ);
      const lx = ex * k;
      const lz = ez * k;
      if (Math.hypot(lx - wellX, lz) < 2.4) continue;
      if (Math.hypot(lx - shX, lz - shZ) < 3.0) continue;
      if (Math.hypot(lx - fireX, lz - fireZ) < 2.2) continue;
      toWorld(plan, lx, lz, _v);
      palmSpots.push({
        x: _v.x, z: _v.z, y: plan.crestY,
        k: 0.86 + rnd() * 0.3, yaw: rnd() * Math.PI * 2,
      });
    }
    if (palmSpots.length) {
      const barkMat = ctx.mat
        ? ctx.mat('bark.palm', { vertexColors: false })
        : microSurface(new THREE.MeshStandardMaterial({ name: 'bark.palm', color: 0x8a6a45, roughness: 0.9 }), 'coarse', 1);
      const leafMat = ctx.mat
        ? ctx.mat('foliage.frond', { vertexColors: false })
        : microSurface(new THREE.MeshStandardMaterial({ name: 'foliage.frond', color: 0x7d8f4e, roughness: 0.85 }), 'matte', 1);
      const bark = new THREE.InstancedMesh(palm.trunk, barkMat, palmSpots.length);
      const leaf = new THREE.InstancedMesh(palm.crown, leafMat, palmSpots.length);
      bark.name = `oasis:${plan.id}:tree.trunk`;
      leaf.name = `oasis:${plan.id}:tree.crown`;
      bark.castShadow = true;
      bark.receiveShadow = true;
      leaf.castShadow = true;
      // Crowns do not receive - self-shadowing a mass of thin fronds returns
      // acne, not shade. Same call `_buildTrees` makes, for the same reason.
      leaf.receiveShadow = false;
      for (let i = 0; i < palmSpots.length; i++) {
        const p = palmSpots[i];
        _be.set(0, p.yaw, 0);
        _bq.setFromEuler(_be);
        _v.set(p.x, p.y, p.z);
        _bs.setScalar(p.k);
        _bm.compose(_v, _bq, _bs);
        bark.setMatrixAt(i, _bm);
        leaf.setMatrixAt(i, _bm);
      }
      bark.instanceMatrix.needsUpdate = true;
      leaf.instanceMatrix.needsUpdate = true;
      // Computed here, not left to the first render: a sphere that does not
      // exist yet reads as a distance of zero to every district audit.
      bark.computeBoundingSphere();
      leaf.computeBoundingSphere();
      ctx.group.add(bark, leaf);
      palmMeshes.push(bark, leaf);
      for (const p of palmSpots) {
        colliders.push(track(ctx.physics.addBox(
          p.x, p.y + 1.6 * p.k, p.z, 0.26 * p.k, 1.6 * p.k, 0.26 * p.k
        )));
      }
    }
  }

  /* ---- the water ---------------------------------------------------- *
   * Its own mesh, and the only extra draw call the tank itself costs.
   *
   * It cannot go in the batch: `WaterVolumes` discovers water by MATERIAL NAME
   * and a merged bucket would hand it a mesh whose name is the bucket's, and
   * `Batch` bakes vertex AO into everything it merges - which would fight the
   * per-vertex depth shading the surface now carries instead of a shader.
   *
   * @see waterGeometry      the irregular outline and the depth ramp
   * @see oasisWaterMaterial why this is the world's `water.pool`, adjusted
   */
  const wgeo = waterGeometry(plan);
  const waterMat = oasisWaterMaterial(ctx);
  const water = new THREE.Mesh(wgeo, waterMat);
  water.name = `oasis:${plan.id}:water`;
  water.position.set(plan.x, plan.waterY, plan.z);
  water.rotation.y = plan.yaw;
  // Water neither casts nor receives: a shadow on a transmissive plane is a
  // grey smear, and the pool is 0.25 m below a rim that would cast onto it.
  water.castShadow = false;
  water.receiveShadow = false;
  water.updateMatrixWorld(true);
  ctx.group.add(water);

  /* ---- what the world can wire up ----------------------------------- */
  const at = (lx, lz, y) => {
    toWorld(plan, lx, lz, _v);
    return new THREE.Vector3(_v.x, y, _v.z);
  };

  /**
   * Doorless enterable, exactly the shape `Caves.buildCave` publishes, so
   * `Interiors` streams the collectibles off it with no new code. Three spots:
   * under the shelter, at the well head, and on the bed at the bottom of the
   * pool - the last one is the reason to dive.
   */
  const enterable = {
    label: plan.label,
    origin: at(0, 0, plan.crestY),
    doors: [],
    collectibleSpots: [
      { position: at(shX + 0.1, shZ - 0.85, plan.crestY + 0.75), tier: 'common' },
      { position: at(wellX, 0, plan.crestY + 0.9), tier: 'common' },
      { position: at(0, 0, plan.bedY + 0.35), tier: 'rare' },
    ],
    oasis: {
      id: plan.id,
      water: { x: plan.x, z: plan.z, y: plan.waterY, hx: plan.water.hx, hz: plan.water.hz },
      crestY: plan.crestY,
      depth: POOL_DEPTH,
    },
  };

  /** `Caches` nominates from this. The crest is the prominent surface here. */
  const cacheSites = [
    { x: at(wellX, 0, 0).x, z: at(wellX, 0, 0).z, y: plan.crestY, label: `${plan.label} well head` },
  ];

  /** Where a trader pitches and where the water carrier works. */
  const npcSpawns = [
    {
      type: 'friendly', role: 'merchant', persona: 'trader',
      name: `${plan.label} water seller`,
      position: at(shX + 0.6, shZ + 2.4, plan.crestY),
      yaw: plan.yaw + Math.PI * 0.5,
      posture: 'stand',
    },
    {
      type: 'friendly', persona: 'villager',
      name: `${plan.label} water carrier`,
      position: at(wellX - 1.3, 1.1, plan.crestY),
      yaw: plan.yaw,
      patrol: [at(wellX - 1.3, 1.1, plan.crestY), at(0, strand.hz - 0.6, strand.top)],
    },
  ];

  /** Shade and a fire: the two places a player would actually stop. */
  const restSpots = [
    { id: `${plan.id}:shade`, position: at(shX + 0.1, shZ - 0.85, plan.crestY), shaded: true },
    { id: `${plan.id}:fire`, position: at(fireX, fireZ - 1.1, plan.crestY), shaded: false },
  ];

  /**
   * An anchor the world MAY add to `world.viewpoints`. Deliberately returned
   * rather than published: `Viewpoints` treats the array as a completion set
   * with a cosmetic and a mount power at the end of it, and the Citadel's
   * five are the five hardest climbs in the world. An oasis you walk onto is
   * not one of those, and quietly making the set six would change a reward the
   * player has already been told the shape of.
   */
  const viewpoint = {
    id: `${plan.id}-crest`, name: plan.label,
    x: plan.x, y: plan.crestY, z: plan.z, r: 6,
  };

  const landmark = {
    id: plan.id, name: plan.label,
    x: plan.x, z: plan.z, y: plan.crestY, r: plan.hx,
  };

  const meshes = ownBatch ? ownBatch.flush(ctx.group, (k) => (
    ctx.mat ? ctx.mat(k) : new THREE.MeshStandardMaterial({ name: k })
  ), `oasis:${plan.id}`) : [];

  const cost = solidCost(solids);
  const dressCost = solidCost(dressing);
  return {
    plan, colliders, solids, meshes, batch: ownBatch,
    /**
     * Every visual-only sand lobe, in PLAN-LOCAL coordinates, so
     * {@link auditDressing} is a pure function of the plan and this list and
     * needs neither the scene nor the physics to check the ghost bound.
     */
    dressing,
    water: {
      mesh: water, y: plan.waterY,
      hx: plan.water.hx, hz: plan.water.hz, area: plan.area,
      triangles: triangleCount(wgeo),
    },
    palms: {
      meshes: palmMeshes, count: palmSpots.length, spots: palmSpots,
      trunk: palm.trunk, crown: palm.crown, owned: ownPalm,
      triangles: (triangleCount(palm.trunk) + triangleCount(palm.crown)) * palmSpots.length,
    },
    enterable, cacheSites, npcSpawns, restSpots, viewpoint, landmark,
    cost: {
      ...cost,
      /**
       * What the sand cost, as a slice of the whole. Broken out because it is
       * the dial anybody trimming this file will reach for first, and because
       * `dressed` being zero while the tank still builds is the signature of
       * the dressing having been skipped rather than the tank being cheap.
       */
      dressed: dressing.length,
      dressedTriangles: dressCost.triangles,
      /**
       * Draw calls this oasis adds ON ITS OWN: the water plane, the two palm
       * fields, and the private batch's meshes if it had to open one.
       *
       * IT IS NOT THE HOST'S BILL, and the module header used to imply it was
       * ("pass `ctx.box` and the terraces join the world's merge for zero extra
       * draw calls"). That is only true if `ctx.box` writes into a batch the
       * host is ALREADY going to flush. `CitadelWorld` gives each oasis a batch
       * of its own - the two sites are 210 m apart and a shared masonry mesh
       * comes back from the splitter as many more leaves than two - so the
       * masonry costs it ONE MESH PER DISTINCT MATERIAL KEY, on top of these 3.
       * `_buildTraffic` counts what its own `_emit` returned and reports that;
       * this number cannot see it, so do not read it as the total.
       *
       * Measured on the shipped tanks: SEVEN, and it was six before the art
       * pass. The seventh is `dirt.ground`, and TWO independent things in this
       * file now emit it - the repainted bank ({@link ringSurface}, 186 boxes
       * over the two tanks) and the sand dressing (431) - so removing either
       * alone leaves the bucket standing. Neither looks like a draw call: one
       * is a tint change, the other is dressing that costs no colliders. The
       * built world went from 164 scene meshes to 166 all the same, and the two
       * are `oasis:palm-well:dirt.ground` and `oasis:sand-mirror:dirt.ground`.
       * `citadel-oasis.test.mjs` asserts the key count against the world's own
       * `hostMeshes` now, because nothing did and this number cannot.
       */
      draws: 1 + (palmMeshes.length ? 2 : 0) + meshes.length,
      submitted: cost.triangles
        + triangleCount(wgeo)
        + (triangleCount(palm.trunk) + triangleCount(palm.crown)) * palmSpots.length,
    },
  };
}

/**
 * Build several oases and return one aggregate the world can spread.
 * @param {object} ctx
 * @param {object[]} plans
 */
export function buildOases(ctx, plans) {
  const out = {
    oases: [], colliders: [], enterables: [], cacheSites: [],
    npcSpawns: [], restSpots: [], viewpoints: [], landmarks: [],
    triangles: 0, draws: 0, dressed: 0,
  };
  // ONE palm pair for every oasis in the set. Two oases with two copies of the
  // same 1,700-triangle crown is 1,700 triangles of resident geometry nobody
  // needed, and the instanced fields stay separate either way so nothing is
  // lost by sharing.
  const palm = ctx.palm ?? palmGeometry(mulberry32(11));
  for (const plan of plans) {
    const o = buildOasis({ ...ctx, palm }, plan);
    out.oases.push(o);
    out.colliders.push(...o.colliders);
    out.enterables.push(o.enterable);
    out.cacheSites.push(...o.cacheSites);
    out.npcSpawns.push(...o.npcSpawns);
    out.restSpots.push(...o.restSpots);
    out.viewpoints.push(o.viewpoint);
    out.landmarks.push(o.landmark);
    out.triangles += o.cost.submitted;
    out.draws += o.cost.draws;
    out.dressed += o.cost.dressed;
  }
  out.palm = palm;
  return out;
}

/**
 * The two authored sites, as ANCHORS rather than as answers.
 *
 * Both sit in the dead ground between regions, which is where the player asked
 * for life. Every `y` is missing on purpose - run {@link findOasisSite} or
 * {@link settleOasis} against the built terrain to get it, exactly as
 * `citadelCaves` requires.
 *
 * @param {{western?:{x:number,z:number}, deepwest?:{x:number,z:number}}} [anchors]
 */
export function citadelOases(anchors = {}) {
  /* MEASURED, not reasoned, and the measurement overruled the design.
   *
   * The obvious anchors are the geometric midpoints between region sites, one
   * per corridor, spread round the ring. They do not exist. Swept over the
   * BUILT world at a 10 m pitch - `settleOasis` then `auditVacancy`, the same
   * two gates the search uses - exactly 18 of ~4,900 desert cells carry a tank
   * of this size, and ALL EIGHTEEN ARE IN THE WESTERN HALF:
   *
   *     NE 0    NW 0    SE 0    SW 18
   *
   * The reason is relief, not clutter: 647 of 924 sampled cells are completely
   * empty of geometry, but relief over a 53.8 x 50.8 m footprint runs a median
   * of 7.45 m and only 49 cells are under 0.8 m. The eastern desert between
   * the mesa and the Caravanserai dunes is a dune field, and a horizontal
   * water plane 24 m across cannot be levelled into a dune field without a
   * plinth taller than the tank.
   *
   * So both oases go west. `western` is on the walk out to the karst massif at
   * (-40, -326); `deepwest` is on the flats between Ashfall at (-362, 190) and
   * the massif. They are 210 m apart and at radius 215 and 313, which is two
   * different journeys rather than one pond seen twice.
   *
   * They are still ANCHORS. {@link findOasisSite} searches from them against
   * the terrain as built and will move off them the day somebody re-shapes the
   * ring - which is the whole reason this returns coordinates with no `y`. If
   * the ring is ever flattened east of the mesa, re-run the sweep; the search
   * will use whatever is there.
   */
  const western = anchors.western ?? { x: -100, z: -190 };
  const deepwest = anchors.deepwest ?? { x: -300, z: -90 };
  return [
    { id: 'palm-well', label: 'The Palm Well', ...western },
    { id: 'sand-mirror', label: 'The Sand Mirror', ...deepwest },
  ];
}

export default buildOasis;
