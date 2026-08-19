import * as THREE from 'three';
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
 * ── What the world gets ───────────────────────────────────────────────────
 *
 * `buildOasis` emits its solids through the host's own `Batch.box`, so the
 * terraces cost ZERO extra draw calls - they merge into the buckets Citadel
 * already flushes. Only the water plane and the two instanced palm fields are
 * its own meshes. It publishes an `enterable` (doorless, exactly like a cave),
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
export const REED_CLUMPS = 30;

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

  return {
    id: site.id ?? 'oasis',
    label: site.label ?? 'The Oasis',
    x: site.x, z: site.z, yaw,
    bedY, baseY, waterY, crestY,
    grade: site.grade ?? null,
    rings, water,
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

/** Mud-brick and rammed-earth tints, so no two courses read the same. */
const BRICK = [0xc9b189, 0xbfa67e, 0xd2ba92, 0xb59b74, 0xc4ac84];
/** The bed and the wet shelves: darker, algae-stained, cooler. */
const WET = [0x8b7f5f, 0x94886a, 0x7f7455, 0x9c9074, 0x877b5c];

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
  const solid = (key, w, h, d, lx, cy, lz, tint, { collide = true } = {}) => {
    if (w <= 1e-4 || h <= 1e-4 || d <= 1e-4) return;
    toWorld(plan, lx, lz, _v);
    rawBox(key, w, h, d, _v.x, cy, _v.z, plan.yaw, tint);
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
    const wet = r.depth > 0;
    const key = wet ? 'stone.cobble' : 'plaster.wall';
    const tint = wet
      ? WET[(r.id.charCodeAt(0) + r.id.charCodeAt(1)) % WET.length]
      : BRICK[(r.id.charCodeAt(0) + r.id.charCodeAt(1)) % BRICK.length];
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

  /* ---- reeds along the strand --------------------------------------- *
   * On `c2`, the ankle-deep shelf. Thin, so `Batch.box` leaves them square -
   * 12 triangles each instead of 108 - and there are 90 of them.
   */
  const strand = plan.rings.find((r) => r.id === 'c2');
  const clumps = ctx.reeds ?? REED_CLUMPS;
  for (let i = 0; i < clumps; i++) {
    const t = (i + rnd() * 0.6) / clumps;
    const a = t * Math.PI * 2;
    // Around the rectangle, not around a circle: the strand is a rectangle.
    const ex = Math.cos(a);
    const ez = Math.sin(a);
    const k = 1 / Math.max(Math.abs(ex) / (strand.hx - 0.35), Math.abs(ez) / (strand.hz - 0.35));
    const px = ex * k;
    const pz = ez * k;
    for (let b = 0; b < 3; b++) {
      const hgt = 0.9 + rnd() * 0.7;
      solid('grass.field', 0.06, hgt, 0.06,
        px + (rnd() - 0.5) * 0.5, strand.top + hgt * 0.5, pz + (rnd() - 0.5) * 0.5,
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
        : new THREE.MeshStandardMaterial({ name: 'bark.palm', color: 0x8a6a45, roughness: 0.9 });
      const leafMat = ctx.mat
        ? ctx.mat('foliage.frond', { vertexColors: false })
        : new THREE.MeshStandardMaterial({ name: 'foliage.frond', color: 0x7d8f4e, roughness: 0.85 });
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
   * `Batch` bakes vertex AO into everything it merges, which on a transmissive
   * material reads as dirt in the water. `water.pool` is the library's animated
   * pool surface - the same one the Lido uses - so this is the world's water,
   * not a new one.
   */
  const wgeo = new THREE.PlaneGeometry(plan.water.hx * 2, plan.water.hz * 2, 6, 6);
  wgeo.rotateX(-Math.PI / 2);
  const waterMat = ctx.mat
    ? ctx.mat('water.pool', { vertexColors: false })
    : new THREE.MeshStandardMaterial({
      name: 'water.pool', color: 0x2f9fc4, transparent: true, opacity: 0.82,
      roughness: 0.12, metalness: 0, side: THREE.DoubleSide,
    });
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
  return {
    plan, colliders, solids, meshes, batch: ownBatch,
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
       * Draw calls this oasis adds ON ITS OWN: the water plane, the two palm
       * fields, and the private batch's meshes if it had to open one.
       *
       * IT IS NOT THE HOST'S BILL, and the module header used to imply it was
       * ("pass `ctx.box` and the terraces join the world's merge for zero extra
       * draw calls"). That is only true if `ctx.box` writes into a batch the
       * host is ALREADY going to flush. `CitadelWorld` gives each oasis a batch
       * of its own - the two sites are 210 m apart and a shared masonry mesh
       * comes back from the splitter as many more leaves than two - so the
       * masonry costs it a measured 6 meshes per oasis on top of these 3.
       * `_buildTraffic` counts what its own `_emit` returned and reports that;
       * this number cannot see it, so do not read it as the total.
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
    triangles: 0, draws: 0,
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
