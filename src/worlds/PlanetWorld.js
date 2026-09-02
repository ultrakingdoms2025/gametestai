import * as THREE from 'three';
/* Lights are born HIDDEN: one frame with a world's own lights live re-links
 * every program on screen. gfx/WorldLight.js has the whole of it. */
import { pointLight } from '../gfx/WorldLight.js';
import { World } from './World.js';
import { makeRules, worldGravityRatio } from './WorldRules.js';
import { genPool } from '../workers/GenPool.js';
import { createSky } from '../gfx/Sky.js';
import { HEIGHT_FIELDS } from './terrain/index.js';
import { fbm } from './terrain/PlanetHeight.js';
import { scatter, regionDepth } from './planets/Placement.js';
import { buildPropField, buildPlumes } from './planets/PlanetProps.js';
import { loadPlanetAssets, blockGeometry } from './planets/PlanetAssets.js';
import {
  createLiquidMaterial, createSkirtMaterial, bodyGeometry,
  liquidCellMask, liquidContour, liquidWalls, liquidDepth, liquidKind, bodySurfaceAt,
  liquidSurfaceAt, liquidSubstance, liquidSwimmable, liquidHazard, liquidWallMask,
  liquidGuards,
} from './planets/PlanetLiquid.js';
import { hazardSpec, makeHazardSampler, makeHazardSample } from './planets/PlanetHazard.js';
import { COLLISION_LAYER } from '../physics/Physics.js';

/**
 * THE SHORE WALL: a run of square posts standing ON the waterline.
 *
 * ── Why posts, and why none of them is rotated ───────────────────────────
 * EVERY REACH PROBE IN THIS REPO MODELS A COLLIDER BY ITS AXIS-ALIGNED BOUNDS.
 * `planet-minerals.test.mjs`'s `boxIndex` is the pattern and the others copy
 * it. That was exact while every planet collider was cell-aligned, and it is a
 * gross over-estimate for anything turned: a 13 m wall panel following a
 * shoreline at 76 degrees has a 14 x 6 m bounding box, so a probe sees three
 * metres of blocked bank on each side of a wall that is three metres thick in
 * total. Measured on Verdigris: oriented panels placed correctly IN the water
 * still cost eleven of twenty malachite nodes when flooded, because the flood
 * could not see them as anything but their bounds.
 *
 * A square, axis-aligned post IS its own bounding box. The measurement and the
 * engine agree by construction, which is the same principle the terrain mesh
 * and its collider are built on one grid for.
 *
 * ── AND A POST IS 0.50 m DEEP, WHICH IS THE WHOLE OF WHY IT HOLDS ────────
 *
 * `FreeClimb` grabs any vertical face with Space held and every planet
 * publishes `climb: true`, so NO HEIGHT closes this wall. That is deliberate -
 * it is the mechanic the citadel is built around - and it is not the end of
 * the argument, because a free climb does not end by itself. It tops out at
 * the lip and hands to `Climb.tryStart`, and `Climb._probe` step 4 completes a
 * hoist only onto REAL STANDING ROOM: it seats a test capsule `P.radius +
 * LAND_INSET` = 0.77 m inboard of the face it climbed and requires the solver
 * to report it grounded there, within 0.2 m of where it was put. A guard
 * thinner than that reach has no top for the capsule to sit on, the mantle is
 * refused, and the climber hangs at the lip until they let go.
 *
 * THAT is what holds the yard's mouth screen: 0.5 m deep, crossed 0 of 6 with
 * Space held for nine seconds, at 2.70 m and again at 3.92 m. And the shore
 * posts were the counter-example that proved it, because they were 2.2 m square
 * and DID have standable tops - the one shape in the game a sustained climb
 * still got over.
 *
 * 0.50 m is not a guess and not a copy. `.probe/mantle-depth.mjs` sweeps the
 * box depth through the real `Physics.resolveCapsule` with the real player
 * constants and finds the knee exactly:
 *
 *     depth 0.60 m   not grounded            the hoist is refused
 *     depth 0.65 m   grounded, moved 0.003   the hoist completes
 *
 * The knee is at 0.63 rather than at 0.77 because the capsule's lower sphere
 * centre sits 0.32 m above the top face and can still catch the far top EDGE of
 * a box narrower than the reach. 0.50 clears the measured knee by 0.13 m, which
 * is margin against the solver rather than against the arithmetic.
 *
 * ── SO WHY IS THE POST STILL 2.2 m? BECAUSE THE OTHER HALF OF IT IS. ─────
 *
 * The first version of this fix simply shrank the post to 0.50 m square and
 * tightened the span to keep consecutive posts overlapping. It closed the climb
 * and it opened something worse, and `planet-liquid`'s own walled-shore march
 * caught it immediately: **21 of 136 approaches ended under the lava, worst
 * 1.45 m**. That march steps a capsule 0.5 m at a time - 30 m/s at 60 fps,
 * twice anything the game can produce, which is what a gate has to be tested at
 * - and `resolveCapsule` ejects a capsule to whichever side of a box's CENTRE
 * it is on. So the thickness of a box is its tunnelling margin, and the
 * arithmetic is exact:
 *
 *     a capsule resting against the landward face sits at `centre - 1.45`
 *     one 0.5 m step puts it at `centre - 0.95`, still landward: it is pushed
 *     back. At 0.50 m square the same capsule starts INSIDE the post (the face
 *     stands `WALL_BIAS` onto the bank and the march's start points are cell
 *     centres, which can be anywhere) and one step carries it past the centre,
 *     where depenetration finishes the job and puts it in the lake.
 *
 * A post has to be at least 1.7 m thick for its centre to stay half a metre
 * seaward of any dry start, and no more than 0.63 m thick for its top to refuse
 * a mantle. Those do not intersect. ONE BOX CANNOT DO BOTH.
 *
 * ── A PLINTH AND A CAP, AND THE CAP IS FLUSH WITH THE CLIMBED FACE ───────
 *
 * They are not the same requirement at the same HEIGHT, which is what makes
 * this soluble. Thickness is needed where a body walks - feet on the ground,
 * head 1.75 m up. Thinness is needed at the top, four metres up, which is the
 * only place a free climb tops out. So:
 *
 *   PLINTH  `POST_HALF` 1.1 m, exactly the box that used to be the whole post,
 *           from the same bottom up to `stand + PLINTH_HEAD`. Same footprint,
 *           same axis alignment, same bounding box - so every reach probe in
 *           the repo sees precisely what it saw before this change, which is
 *           the property that makes it safe to make at all.
 *   CAP     `CAP_HALF` 0.25 m, from the plinth's top to the full gate height,
 *           FLUSH WITH THE PLINTH'S LANDWARD FACE. Flush is load-bearing:
 *           `Climb._probe` step 1 takes the first vertical face in front of the
 *           body, and the two members share that plane, so a climber is always
 *           climbing the cap and the landing test is always run 0.77 m inboard
 *           of the cap - which is 0.62 m past its back, over a plinth top two
 *           metres below. Nothing to stand on, so no hoist.
 *
 * The plinth's top is `PLINTH_HEAD` above the highest ground within reach, so a
 * body walking at the wall is inside the thick part for its whole height and
 * never meets the cap at all - which also keeps the two members from
 * disagreeing about which way to push, the failure mode a full-height cap
 * would have had.
 *
 * ── The numbers ──────────────────────────────────────────────────────────
 * `POST_HALF` 1.1 m, dropped along the waterline every `POST_SPAN` 1.3 m so
 * consecutive plinths always overlap (any spacing under 2 x POST_HALF does, in
 * any direction). Each post is pushed `POST_HALF - WALL_BIAS` INTO the water,
 * so it reaches only `WALL_BIAS` onto the bank - and the bank is where
 * `terrain: 'channel'` and `terrain: 'shore'` ore is deliberately placed.
 *
 * The CAPS do not overlap - 0.5 m squares 1.3 m apart leave 0.8 m gaps - and
 * that is stated rather than overlooked. The only place a body can be at cap
 * height is standing on the plinth top, and the plinth top is 1.9 m up with a
 * mantle onto it refused from the land side, so the only approach to those gaps
 * is from the water: they leak OUT of the liquid, never in. Every walled shore
 * in the game is lethal liquid nothing swims in, and closing them would cost a
 * cap every 0.45 m - 2.9x the collider count - to fence a direction the barrier
 * does not exist to fence.
 *
 * `WALL_BIAS` also absorbs the contour's own error: `liquidWalls` lets the true
 * waterline wander 0.35 m from the straight run that replaces it, so a face
 * placed exactly on the run would leave a band that wide where a body could
 * stand inside the drawn liquid. Measured on Cinder before the bias existed:
 * one approach in 136 ended 1.06 m under the lava at the lake rim.
 *
 * `WALL_SUB` subdivides each terrain cell when the contour is marched. 2 puts
 * the waterline within about 0.8 m of the truth on a 3.1 m cell for four times
 * the field evaluations; 1 was visibly coarse on a river 20 m wide.
 */
const POST_HALF = 1.1;
const POST_SPAN = 1.3;
const WALL_BIAS = 0.35;
const WALL_SUB = 2;
/**
 * Half-depth of the cap that carries the top of the wall.
 *
 * 0.25 - a cap 0.50 m deep, the same depth as the yard's mouth screen, which is
 * the guard this whole property was measured on. `.probe/mantle-depth.mjs`
 * sweeps a box depth through the real solver and the real player constants and
 * finds the knee: at 0.60 m the hoist is refused, at 0.65 m it completes. The
 * knee sits at 0.63 rather than at the 0.77 m landing reach because the test
 * capsule's lower sphere centre is 0.32 m above the top face and can still
 * catch the far top EDGE of a box narrower than the reach. 0.50 clears the
 * MEASURED knee by 0.13 m, which is margin against the solver rather than
 * against arithmetic.
 */
const CAP_HALF = 0.25;
/**
 * How far the plinth's top stands above the highest ground within reach of it.
 *
 * The plinth exists to be thick where a body IS, so it has to cover a standing
 * capsule for its whole height: `CONFIG.player.height` is 1.75 and this is 1.9.
 * Above that the wall is the cap and nothing walks into it.
 */
const PLINTH_HEAD = 1.9;
/**
 * The shortest a cap may be, in metres, and therefore a ceiling on the plinth.
 *
 * Two jobs, and they are the same number by coincidence rather than by
 * derivation, so both are written down:
 *
 *  - `planet-liquid` asserts every barrier collider is over 2 m tall on the
 *    grounds that "nothing is stopped by that". A cap is `clearance -
 *    PLINTH_HEAD`, and `clearance` is smaller on a heavy world, so without a
 *    floor the cap eventually falls under it.
 *  - the plinth's top must clear the CROWN of a standing capsule, not just its
 *    segment: `P.height` 1.75. If the cap's base dropped to the capsule's crown
 *    the two members would both be in contact at walking height and would push
 *    a marching body opposite ways, which is the failure the plinth exists to
 *    prevent.
 *
 * At Cinder's and Sallow's measured 3.98 m of clearance this does not bind -
 * the cap is 2.08 m and the plinth top is the full `PLINTH_HEAD` up.
 */
const CAP_MIN_H = 2.1;
/**
 * The playfield-edge wall's half-thickness, and it is NOT `POST_HALF`.
 *
 * These are four long boxes standing on the world boundary in open water, and
 * they answer a different question from the shore fence. Nothing is on the far
 * side of them to climb onto, so the mantle argument above does not apply; what
 * DOES apply is that a swimmer meets them at speed, and `planet-liquid`'s own
 * crossing test marches a capsule at them in 0.5 m steps. A half-metre wall
 * against a half-metre step is a wall a body can end up past the midplane of,
 * and depenetration then pushes it out the FAR side. Thickness here is the
 * tunnelling margin, so it stays where it was.
 */
const EDGE_HALF = 1.1;

/* ══════════════════════════════════════════════════════════════════════════
 *  HOW TALL THE SHORE WALL HAS TO BE, AND WHAT IT IS MEASURED FROM
 * ══════════════════════════════════════════════════════════════════════════
 *
 * THE DATUM WAS WRONG. The parapet was `run.surf + parapet` - measured from the
 * WATER - and the player does not stand on the water, they stand on the bank
 * beside it. Measured on Shoal in a real boot: sea level 6.0, the bank at the
 * waterline 7.3-7.4, a parapet of 2.0 m putting the post top at 8.0, and a
 * running leap whose apex is 1.18 m. 7.4 + 1.18 = 8.6 against a top of 8.0, so
 * the effective gate was NEGATIVE. Seven of eight bearings out of the Glassflat
 * pad went straight over it into 14 m of water; walking held on all eight,
 * which is exactly why 2,500 green tests could not see it.
 *
 * THE HEIGHT WAS WRONG TWICE OVER, and the second one nobody had measured at
 * all: at 2.0 m above the ground a post top is a LEDGE. `Climb.MAX_RISE` is
 * 2.4 m and `_minRiseGround` is at most 2.0, so a 2.0 m wall standing on ground
 * level with the water sits inside the mantle band and can simply be climbed.
 *
 * ── AND THE TWO NUMBERS ADD UP, WHICH IS THE PART THAT WAS MEASURED LAST ──
 * The first fix here sized the wall at `max(leapApex + 0.9, MAX_RISE + 0.3)` -
 * 2.70 m - and driving it in a browser still crossed six of eight bearings out
 * of Shoal's Glassflat pad. The trajectories say why, and they are unambiguous:
 * the body's peak y on every crossing is the POST TOP plus exactly one standing
 * jump. It never went over the wall. It got ON it.
 *
 * `Player` offers the mantle ON THE JUMP PRESS, and the press does not have to
 * come from the ground: `Climb._probe` measures the rise from the FEET, and feet
 * that are one leap up are one leap closer to the lip. So the two reaches
 * COMPOSE - jump, press jump again at the top of the arc, mantle - and the real
 * reach of a body at a wall is
 *
 *      leap apex  +  MAX_RISE
 *
 * Measured on Shoal: ground 6.78, post top 9.48, standing rise 2.70 - refused,
 * over MAX_RISE. Jump to 7.72 and the rise is 1.76, inside the 1.0-2.4 band, and
 * the mantle fires. That is not an exotic input; it is holding sprint and
 * tapping jump twice.
 *
 * So the wall is sized from the ground a body could LEAP FROM, and it has to
 * out-top the sum:
 *
 *   leap apex   `Player#jumpApex` times {@link LEAP_LIFT} squared. The apex
 *               scales as `ratio^(-1/3)` because `Player.setWorldGravity` scales
 *               the take-off velocity as `ratio^(1/3)` - a low-gravity world
 *               gets a bigger jump, not the same one in slow motion. The OLD
 *               expression used the unscaled 6.4 m/s against the scaled gravity,
 *               which is not any jump the player has: on Tessera it over-stated
 *               the apex by 3.3x and on Shoal it under-stated the LEAP by 19%.
 *   mantle      `Climb.MAX_RISE`, which does not scale - it is how far a pair of
 *               arms reaches, not how hard the world pulls.
 *
 * ── AND THE HEIGHT IS NO LONGER THE ONLY THING HOLDING IT ────────────────
 * This paragraph used to read "the posts are 2.2 m square, so their tops ARE
 * standing room and the mantle has somewhere to land", and it was the honest
 * description of a hole. A wall sized against `leap + mantle` stops a body that
 * runs at it; it does not stop a body that holds Space and climbs the face,
 * and 2 of 8 bearings at a shore went over that way. The posts are 0.50 m deep
 * now and there is nowhere on top of one to put a body, which is the property
 * the yard's guards have held by all along.
 *
 * The height stays exactly as it was. Depth answers the sustained climb; height
 * answers the running leap, which is the input the game actually teaches, and a
 * wall that could be hurdled would be a hurdle whatever its top was like.
 * @see the block above POST_HALF for the measured depth knee
 *
 * @see ../player/Player.js `setWorldGravity`, and the mantle offered on `jumpEdge`
 * @see ../player/Parkour.js `LEAP_LIFT`
 * @see ../player/Climb.js `MAX_RISE`
 */
/** `Parkour.LEAP_LIFT`: the multiplier a running leap puts on take-off speed.
 *  Duplicated rather than imported because `Parkour` exports it to nobody;
 *  `planet-liquid.test.mjs` reads both files and asserts they agree. */
const LEAP_LIFT = 1.12;
/** `Climb.MAX_RISE`: the tallest ledge a mantle can take. Does not scale. */
const MANTLE_MAX = 2.4;
/** Head-room over the leap-plus-mantle reach. A gate held by centimetres is not
 *  a gate, and this one is held over ten planets whose apexes span 1.16-1.26 m. */
const GATE_MARGIN = 0.35;
/**
 * How far from a post the wall looks for the ground a body would leap FROM, in
 * metres.
 *
 * A running leap reaches its apex about 3 m into the jump at walking-to-sprint
 * speeds, so ground further out than this is ground the player is already
 * descending from by the time they reach the wall. Sampling 8 m inland instead
 * would wall off every beach that has a dune behind it.
 *
 * ── ALL EIGHT BEARINGS, NOT JUST THE LANDWARD NORMAL ──────────────────────
 * The first version marched only along `-n`, the run's averaged inward normal.
 * That is the correct DIRECTION and it is not the only one: `n` is averaged over
 * a run up to 14 m long, so at a concave corner of the shoreline the higher
 * ground beside a post sits on a different bearing entirely. Measured on
 * Cinder, at (-235, -188): the landward march found a bank at 24.4 m, a ring
 * march found 25.1 m seven-tenths of a metre away, and the gate there was 1.97 m
 * - clear of the 1.23 m leap and INSIDE the 2.4 m mantle band. One post, and it
 * is a post you can climb.
 *
 * So the whole ring is sampled. On the water side this finds the bed, which is
 * lower and changes nothing; it only bites in a channel narrow enough that the
 * far bank is within reach, where a taller post is the right answer anyway.
 */
const LAND_PROBE = [1.4, 2.8, 4.2, 5.4];
const LAND_BEARINGS = 8;
/**
 * Ceiling on how far a post may stand above the water, in metres.
 *
 * A backstop and not a design number. The bank is sampled within 5.4 m of the
 * waterline, so this can only bind where the ground goes near-vertical straight
 * out of the sea, and a post that answered a 100 m sea cliff literally would be
 * a 100 m invisible column standing in open water.
 *
 * The first value tried was 14, and it bound on 97 of Shoal's 3,122 posts and
 * took the worst gate on the planet down to 1.24 m - inside the mantle band,
 * which is the same class of hole this whole change is closing. At 30 nothing
 * clamps anywhere: the tallest post on any of the five liquid planets stands
 * 15.5 m over its water (Shoal), and every one of the 6,029 posts in the system
 * carries the full 2.7 m gate. `clampedPosts` in the census is how that stays
 * true - a planet whose shores get steeper reports it rather than quietly
 * shipping a hurdle.
 */
const WALL_MAX = 30;

/* Scratch for the per-frame submersion test. See `_underwater`. */
const _underEye = new THREE.Vector3();
/* Its own, not `_underEye`'s. `_breatheAsh` and `_underwater` both run inside
 * one `update` and today they run in an order that would make sharing safe -
 * which is exactly the kind of safety that stops being true the first time
 * somebody reorders two lines. */
const _hazEye = new THREE.Vector3();

/* ══════════════════════════════════════════════════════════════════════════
 *  THE FLOOR OF THE WORLD
 * ══════════════════════════════════════════════════════════════════════════
 *
 * A body that gets under the terrain heightfield used to fall for ever, and it
 * is far easier to get under it than anyone had looked for. MEASURED on Shoal,
 * dropping a player capsule at the deepest sea-bed sample (-431, 440):
 *
 *     resolveCapsule pushes it OUT of the field at z = 440.33 - 33 cm past the
 *     footprint's own edge - and from there `sampleHeight` is null, nothing
 *     else is under it, and it falls: -60, -200, -400, with no floor at any
 *     depth. The playthrough that reported "hp 0 at -33.9 and the body kept
 *     falling to -116.7" is this, and the void catch never fired because the
 *     3.2 s respawn beat it there.
 *
 * The push-out is not a bug in the solver - at the edge of a height field the
 * nearest point on the last triangle IS outside it, so the correction has a
 * horizontal component and there is nowhere for it to point but off. Every one
 * of the ten planets has a `rim` that falls away at its edge, so every one of
 * them ends in a lip a body can be nudged over.
 *
 * ONE FLAT HEIGHTFIELD, under everything, wider than the field it backs.
 *
 * A BOX WAS THE WRONG SHAPE, and for a reason that only shows up at this size:
 * `Physics._insertToGrid` buckets every box over the broadphase cells it
 * covers, and the grid is 12 m. Shoal's slab is 1,280 m square, so a box would
 * have put itself into 11,449 buckets - one entry in every cell of the world -
 * and been handed to the solver by every query for the rest of the session.
 * Heightfields live outside that grid entirely (see the note on
 * `Physics.heightfields`) and are matched by footprint, so the same slab costs
 * one entry and nothing else.
 *
 * It is also strictly cheaper to reject. `_closestPoint`'s heightfield branch
 * opens with `point.y - maxY > maxDist`, so a body standing anywhere on the
 * real ground is out in one subtraction; the box path would have run the
 * bounding-sphere test (radius 905 m, so it always passes) and then two matrix
 * transforms, on every resolve, for ever.
 *
 * The header on `_buildLiquidBarrier` argues the opposite way - BOXES, not a
 * heightfield - and both are right, because they want opposite things. A
 * heightfield is solid from its surface DOWN and recovers anything underneath
 * by pushing it straight up. At a waterline that makes the fence a staircase.
 * At the bottom of the world it is the entire specification.
 *
 * `FLOOR_DROP` is how far below the terrain's own minimum the slab's top sits.
 * 6 m: deep enough that no ground query, no probe lattice and no
 * `boxIndex` can ever mistake it for standing room (every one of them tests
 * `top <= groundY + stepHeight`, and 6 m clears 0.45 m by more than a decimal
 * order), shallow enough that it catches a body long before the void does. On
 * Shoal that is a floor at -40.7 against a void catch that used to wait for
 * -85 and a corpse that reached -116.7.
 *
 * `FLOOR_MARGIN` is how far past the playfield the slab reaches. 200 m covers
 * the 33 cm push-out with four orders of margin and, more usefully, covers a
 * swimmer who leaves the map: Shoal's sea is drawn out to 2,700 m and the
 * ground stops at 440.
 */
const FLOOR_DROP = 6;
const FLOOR_MARGIN = 200;

/**
 * How far below the floor the world's own lower bound is set.
 *
 * `bounds.min.y` is the datum `UnstuckSystem._isOutOfWorld` measures from -
 * `position.y < bounds.min.y - 25` is "out of the world" - and it was a
 * hard-coded -60 on every planet regardless of how deep that planet went. The
 * ordering that has to hold is FLOOR above BOUND above VOID, so that a falling
 * body meets the floor first and the void catch is what it was always meant to
 * be: the thing that fires when the floor has failed.
 */
const BOUND_BELOW_FLOOR = 6;

/**
 * The look from under a swimmable surface.
 *
 * A playthrough that got past the shore barrier reported "a dry, dusty grey
 * plain to the horizon under an open sky, while the minimap is solid blue with
 * you in the middle of it", and both halves of that are the same bug: the
 * liquid surface is a one-sided fan wound to face UP, so from below it is
 * backface-culled and simply is not there.
 *
 * Two things fix it and both are needed. The material goes `DoubleSide`, so
 * the surface reads as a surface from underneath - and then the world under
 * water is still the world above water with a ceiling on it, so the fog is
 * replaced while the eye is submerged. `UNDER_FAR` is short on purpose: 26 m
 * of visibility is what makes a sea read as a sea rather than as a tinted
 * room, and it is also what hides the sea bed's own horizon.
 */
const UNDER_NEAR = 0.4;
const UNDER_FAR = 26;

/**
 * PLANET SURFACES - one world class, any number of planets.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE BOUNDARY THIS FILE EXISTS TO HOLD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * There is no planet in this file. No volcano, no ice, no `if (planet.id ===
 * 'cinder')`, and there must never be one. Everything that distinguishes one
 * world from another arrives as a descriptor: its height field's parameters,
 * its palette, its sky, its liquid, its props, its minerals, its landing sites
 * and its gravity. Ten planets cost ten descriptors.
 *
 * That is not a stylistic preference. The alternative - `VolcanicWorld.js`,
 * then `IceWorld.js`, then `JungleWorld.js` - is how this project ends up with
 * `CitadelWorld.js` at 2,937 lines nine times over, and the ninth one gets the
 * bug the third one fixed. The precedent for doing it the other way is already
 * here: `HEIGHT_FIELDS` is a registry of pure height functions the generation
 * worker samples BY NAME, and Citadel authored six distinct regions out of one
 * landform vocabulary. This is that pattern taken up one level.
 *
 * ── The seam with the worker ──────────────────────────────────────────────
 * `descriptor.terrain` is handed to `genPool.run('terrain', { field: 'planet',
 * params })` and crosses `postMessage` verbatim. It therefore contains no
 * functions, no class instances and no `three` types - `definePlanet` refuses
 * a descriptor that does, because the failure mode is silent: a closure clones
 * to `undefined` and the planet comes back flat with nothing in the console.
 *
 * ── The mesh and the collider are the same grid ───────────────────────────
 * One `sampleTerrain` job produces both the drawn positions and the collision
 * heights, from one evaluation of one function. This is not an optimisation. It
 * is the fix for the defect that shaped Citadel: three separate approximations
 * of one slope were allowed to disagree, and where the collision sat below the
 * mesh the player walked *underneath* the visible world across 7% of the map.
 *
 * ── What a planet publishes ───────────────────────────────────────────────
 *   `this.planet`        the descriptor, frozen
 *   `this.groundAt(x,z)` the one height function, for anything that needs it
 *   `this.landingSites`  [{ id, name, position, radius, yaw, primary }]
 *   `this.mineralNodes`  [{ id, type, name, position, credits, size }]
 *   `this.gravity`       m/s^2, for the flight model when it lands
 * These are the contract with the flight, mining and HUD systems, and they are
 * the same shape for every planet by construction.
 */

/* Module-level scratch. Nothing below allocates inside a loop or a frame. */
const _v = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
/* A second quaternion, because an ore crystal composes two rotations - a yaw in
 * its own frame and an outward lean - and `q.multiply(q)` cannot read and write
 * the same object. See the note in physics/Physics.js on shared scratch. */
const _qB = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _col = new THREE.Color();
const _colB = new THREE.Color();

/** `0xrrggbb` -> `[r, g, b]` sRGB bytes. @see PlanetWorld._rgba */
const rgb8 = (hex) => [((hex ?? 0) >> 16) & 255, ((hex ?? 0) >> 8) & 255, (hex ?? 0) & 255];
/** Linear blend of two sRGB byte triples. */
const mix8 = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

/**
 * THE BRIGHTEST AN ORE SWATCH IS ALLOWED TO BE, AS AN sRGB CHANNEL.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────
 * A Sulfur Crust node was reported as "a flat, unshaded, fully saturated yellow
 * polyhedron with no shading variation at all... untextured placeholder
 * geometry", sitting in a scene that was otherwise correctly lit. It was neither
 * unshaded nor untextured: it was BLEACHED. Cinder's sun is a directional at
 * intensity 6.4 and the frame is graded through ACES at exposure 1.22, and
 * sulfur's swatch (`0xd9c341`, brightest channel 0.851) puts every facet of the
 * node so far up the tone curve's shoulder that a facet at full incidence and
 * one at half incidence resolve to the same pixel.
 *
 * ── MEASURED, WITH A CONTROL ───────────────────────────────────────────────
 * `.probe/mineral-sweep.mjs` stands at a real node, masks the ore's exact
 * pixels by hiding the mesh and differencing the frame, and reports the ratio
 * of the 75th to the 25th percentile of luminance across them - "how much
 * lighter is a lit facet than a shaded one", which is precisely the complaint.
 * TEPHRA IS THE CONTROL: it is the ore in the same screenshot that already read
 * as a lit solid, and it measures x1.55.
 *
 *      ore          shipped            with this ceiling
 *      sulfur       x1.22  sat 0.61    x1.50  sat 0.73     <- the report
 *      rheniite     x1.09  sat 0.04    x1.15  sat 0.20     <- was rendering WHITE
 *      iridite      x1.26  sat 0.56    x1.29  sat 0.61
 *      tephra       x1.55  sat 0.46    x1.55  sat 0.46     <- untouched
 *      obsidian     x1.20  sat 0.65    x1.19  sat 0.65     <- untouched
 *      ferrobasalt  x2.25  sat 0.18    x2.23  sat 0.18     <- untouched
 *
 * 0.48 is the value at which the reported ore's facet spread reaches the ore
 * that already worked. It is not a guess and it is not a taste: it is one
 * measurement against one control.
 *
 * ── WHY A CEILING AND NOT A MULTIPLY ───────────────────────────────────────
 * Because three of the six swatches are already dark. Tephra's brightest
 * channel is 0.29 and obsidian's is 0.125; a blanket multiply would take the
 * one ore that reads correctly and the one that is deliberately near-black and
 * push both into mud. A ceiling is a no-op on everything below it - which is
 * exactly the three rows above that do not move - and only pulls down the
 * swatches that were never going to survive the grade.
 *
 * ── THE PER-ORE COLOURS STILL DO THEIR JOB. BETTER, IN FACT. ───────────────
 * Scaling all three channels by one factor leaves the hue and the channel
 * ratios untouched, so an ore is still identified by its colour - and because
 * ACES desaturates as it clips toward white, taking the value DOWN takes the
 * chroma UP: sulfur's measured saturation goes 0.61 -> 0.73 and rheniite's, the
 * one that was rendering as a white blob with no hue at all, goes 0.04 -> 0.20.
 * The rendered node ends up NEARER the swatch the descriptor wrote, not further
 * from it. `spec.color` and `spec.glow` are read exactly as before and the
 * emissive is untouched, so the glow tiers still glow.
 */
const ORE_ALBEDO_CEIL = 0.48;

/**
 * A mineral swatch, capped for the grade. @see ORE_ALBEDO_CEIL
 *
 * The scale is applied in sRGB, which is the space the descriptor's hex was
 * written in, so "half as bright" means what an author looking at the swatch
 * would expect it to mean.
 *
 * @param {number} hex the descriptor's `0xrrggbb`
 * @returns {THREE.Color} a colour in the renderer's working space
 */
function oreAlbedo(hex) {
  const [r, g, b] = rgb8(hex).map((v) => v / 255);
  const mx = Math.max(r, g, b);
  /* `mx > 0` guards a pure-black swatch: 0/0 is NaN, and a NaN albedo is the
   * failure this project has already paid for once - 19 NaN pixels through the
   * bloom pass blacked out a whole frame. */
  const k = mx > ORE_ALBEDO_CEIL ? ORE_ALBEDO_CEIL / mx : 1;
  return new THREE.Color().setRGB(r * k, g * k, b * k, THREE.SRGBColorSpace);
}

/* ══════════════════════════════════════════════════════════════════════════
 *  WHAT AN ORE NODE IS SHAPED LIKE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── THE DEFECT, REPORTED TWICE ────────────────────────────────────────────
 * Every ore on every planet was `IcosahedronGeometry(1, 0)` at a near-uniform
 * scale: one twenty-sided lump, ten planets, thirty-odd seams. A previous pass
 * fixed the SHADING of it (`ORE_ALBEDO_CEIL`) and left the form, so what
 * shipped was a correctly-lit potato. The method's own header has said "a small
 * cluster of faceted crystals" the whole time.
 *
 * ── THE HOUSE RULE, AND WHICH WAY ROUND IT CUTS ───────────────────────────
 * THE PRIMITIVE IS THE PROBLEM. This project shipped spacecraft assembled from
 * 197 stacked boxes and had them rejected three times, and the rule that came
 * out of it is in `planets/PlanetProps.js`: an organic or crystalline form is a
 * lathed, tapered or faceted primitive with per-instance non-uniform scale and
 * rotation - NEVER a stack of cuboids. So the answer to "these are not
 * crystals" is not a pile of little boxes arranged in a crystal shape. It is
 * the primitive being the shape, which for a mineral really is a low-order
 * prism with a termination on it.
 *
 * `PlanetProps`' `spires` kind already solved exactly this for ice pinnacles
 * and this is built on its three findings:
 *
 *   1. A near-zero but NOT zero tip. A true point is a vertex the light never
 *      catches. A chipped tip reads as broken crystal and costs `facets`
 *      triangles.
 *   2. Four to seven sides, so the silhouette is a polygon rather than a
 *      circle. A crystal IS a low-order prism.
 *   3. A PER-COLUMN RADIUS JITTER baked into the geometry, so the cross-section
 *      is irregular and a per-instance yaw actually changes the silhouette
 *      instead of rotating a symmetry.
 *
 * ── WHY THE HABIT COMES FROM THE RARITY ───────────────────────────────────
 * One geometry per seam is free - the seam already builds its own mesh and its
 * own material, and the draw-call budget counts MESHES. So the habit is
 * authored per tier, because the descriptor's own tiers already say what these
 * things are: "Tephra Nodules" and "Sulfur Crust" are chunky broken stuff and
 * "Rheniite" and "Iridite" are the crystals a player flew 62 km for. A common
 * ore gets a squat prism with a blunt truncated termination; an exotic one gets
 * a tall five-sided shaft that comes to a chip. That is one number moving in
 * four rows of a table, and it is the difference between "the ore" and "an
 * ore".
 *
 * `taper` is where the shaft stops and the termination starts, as a fraction of
 * height; `tip` is the top radius. Both are fractions of the widest radius, so
 * the instance matrix still owns the size.
 */
const ORE_HABIT = {
  common: { facets: 7, taper: 0.62, tip: 0.34, tall: [1.5, 0.9] },
  uncommon: { facets: 6, taper: 0.66, tip: 0.24, tall: [1.9, 1.2] },
  rare: { facets: 6, taper: 0.70, tip: 0.13, tall: [2.4, 1.6] },
  exotic: { facets: 5, taper: 0.74, tip: 0.08, tall: [2.7, 1.8] },
};

/** A deterministic 0..1 from one integer. `PlanetProps.hash1`'s job, locally. */
function oreHash(i) {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * One seam's crystal, at unit height with its FOOT at y = 0 and its widest
 * radius at 1.
 *
 * Foot at the origin rather than centred, so the instance loop can bury a
 * measured fraction of it and a crystal grows out of the rock instead of
 * hovering with its lower half inside it. The widest ring is a third of the way
 * up - a prism that is widest at its base looks poured, and one that is widest
 * at its shoulder looks grown.
 *
 * @param {string} rarity one of {@link ORE_HABIT}'s keys
 * @param {number} seed   per-seam, so two seams on one planet are not one
 *                        crystal drawn twice
 */
function oreCrystal(rarity, seed) {
  const h = ORE_HABIT[rarity] ?? ORE_HABIT.common;
  const facets = h.facets;
  /* Three height segments put a ring exactly at the shoulder and one at the
   * taper, which is what makes the termination a termination rather than a
   * cone: rings at t = 0, 1/3, 2/3, 1. */
  const g = new THREE.CylinderGeometry(1, 1, 1, facets, 3, false);
  const pos = g.attributes.position;
  const TAU = Math.PI * 2;
  /** The profile: radius as a fraction of the widest, at height fraction `t`. */
  const profile = (t) => {
    if (t <= 1 / 3) return 0.84 + t * 3 * 0.16;          // foot -> shoulder
    if (t <= h.taper) return 1 - ((t - 1 / 3) / (h.taper - 1 / 3)) * 0.06;
    return 1 - 0.06 - ((t - h.taper) / (1 - h.taper)) * (1 - 0.06 - h.tip);
  };
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const rad = Math.hypot(x, z);
    if (rad < 1e-6) continue;  // cap centres: no angle to jitter along
    const col = Math.round((Math.atan2(z, x) / TAU) * facets);
    const j = 1 + 0.26 * (oreHash(col + seed * 13) - 0.5);
    const f = profile(y + 0.5) * j;
    pos.setXYZ(i, x * f, y, z * f);
  }
  g.translate(0, 0.5, 0);
  /* Non-indexed so the normals are per-face for real. The material sets
   * `flatShading` as well, which would fake it in the shader, but a geometry
   * whose stored normals disagree with its own faces is a trap for anything
   * that ever reads them. */
  const flat = g.toNonIndexed();
  g.dispose();
  flat.computeVertexNormals();
  return flat;
}

/** Ash motes drifting past the camera. One `Points`, animated in the shader. */
const ASH_VERT = /* glsl */`
  uniform float uTime;
  uniform vec3 uEye;
  uniform float uBox;
  uniform vec2 uDrift;
  uniform float uSize;
  attribute float aSeed;
  varying float vA;
  void main() {
    /* Every mote lives in a box that follows the camera and wraps with mod(),
     * so a few thousand of them cover an 800 m map without a single one being
     * respawned on the CPU. Fall speed and drift come off the seed. */
    float fall = 1.6 + aSeed * 3.4;
    vec3 p = position;
    p.x = mod(p.x + uTime * uDrift.x - uEye.x + uBox * 0.5, uBox) + uEye.x - uBox * 0.5;
    p.z = mod(p.z + uTime * uDrift.y - uEye.z + uBox * 0.5, uBox) + uEye.z - uBox * 0.5;
    p.y = mod(p.y - uTime * fall - uEye.y + uBox * 0.5, uBox) + uEye.y - uBox * 0.5;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float d = length(mv.xyz);
    vA = clamp(1.0 - d / (uBox * 0.5), 0.0, 1.0);
    gl_PointSize = uSize * (300.0 / max(d, 1.0));
    gl_Position = projectionMatrix * mv;
  }
`;
const ASH_FRAG = /* glsl */`
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vA;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float a = clamp(1.0 - dot(d, d) * 4.0, 0.0, 1.0);
    a *= a * vA * uOpacity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

/* ══════════════════════════════════════════════════════════════════════════
 *  CAN YOU WALK BACK TO YOUR SHIP?
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `_padDrop` measures how much of the horizon around a disc FALLS AWAY within
 * 46 m. That is a cliff test, and it is the right instrument for the question a
 * PILOT asks on final - "is the thing I am about to sit on a clearing or a
 * shelf" - which is why `Piloting` and `SpaceObjectives` read it and why it is
 * left exactly as it is.
 *
 * It is the wrong instrument for the question a WALKER asks, which is the one
 * the amber rim blocks were put there to answer: "if I step off here, can I get
 * back to my ship". MEASURED on all ten planets (`.probe/pad-frac.mjs`), the
 * two questions do not even correlate:
 *
 *     pad                cliff test     can walk home
 *     tessera raysedge   300 deg        98.2%      painted, and perfectly safe
 *     shoal   sunder     263 deg        99.9%      painted, and perfectly safe
 *     lathe   highwall   233 deg       100.0%      painted, and perfectly safe
 *     verdigris crown      0 deg         6.7%      SILENT, and a one-way trip
 *     cathedra  gallery    0 deg        24.9%      SILENT, and a one-way trip
 *     carnelian kiln       0 deg        49.8%      SILENT, and a one-way trip
 *
 * ── AND THE ANSWER IS NOT PER-BEARING ─────────────────────────────────────
 * The obvious repair - march each bearing until it leaves the return set, and
 * paint the ones that do - was built and measured first (`.probe/pad-return.mjs`)
 * and it does not discriminate. On a 900 m world nearly every bearing off
 * nearly every pad eventually reaches ground that cannot walk back, and the
 * distance at which it happens says nothing either: Rimhold, which is 2.7%
 * returnable, commits you at 48 m, and Ashfall, which is 95.2% returnable,
 * commits you at 50 m. What separates them is HOW MUCH of the ground below is
 * one-way, and that is a property of the pad rather than of a compass point.
 *
 * So the marking is a property of the pad: a COMPLETE ring of hazard blocks, or
 * none at all. One ring means exactly one thing - *most of the ground you can
 * reach on foot from this disc cannot walk back to it* - and a player who
 * learns it once on Rimhold reads it correctly on the Crown.
 *
 * ── THE TWO FLOODS ────────────────────────────────────────────────────────
 * Both run over the COLLISION BED - `_bed.heights`, the same samples the
 * heightfield collider was registered with - so this measures the surface the
 * capsule actually stands on rather than a re-evaluation of the height
 * function. The bed's own grid is the lattice, which is why this costs no
 * height evaluations at all.
 *
 *   end-up   where a body can arrive, having left the pad: a walk, plus the one
 *            edge a fall adds - downhill is ALWAYS available, over any face and
 *            any distance, because stepping off a shelf is something a player
 *            can always do. This is why flooding forwards alone found no trap
 *            anywhere: a walk cannot cross a 60 degree face, and a body can.
 *   return   where a walk gets BACK from: the forward rule, reversed, so a
 *            ledge you dropped off is not an edge you can climb.
 *
 * `returnPct` is the share of the first that is in the second.
 *
 * ── THE NUMBERS ARE THE PLAYER'S OWN ──────────────────────────────────────
 * `RETURN_SLOPE_TAN` is `Physics`' walkable-slope limit, `RETURN_STEP_UP` is
 * `CONFIG.player.stepHeight` and `RETURN_DROP_MAX` is the drop `planet-reach`
 * allows a walk, all restated here because the lattice pitch is the bed's
 * (3.1 m) rather than the probe's (2 m) and the rise per step has to be derived
 * from whichever it is. Measured both ways: the verdicts are the same on all
 * thirty pads, and the worst disagreement in the fraction is 5 points on a pad
 * that is 97% returnable either way.
 */
/** tan of the steepest face a walk crosses. `Physics` resolves 38 degrees. */
const RETURN_SLOPE_TAN = Math.tan((38 * Math.PI) / 180);
/** `CONFIG.player.stepHeight`: the rise a walk absorbs however short the run. */
const RETURN_STEP_UP = 0.45;
/** The tallest drop a route may use. `planet-reach`'s number: a route that costs
 *  health is not a route. */
const RETURN_DROP_MAX = 3.0;
/** Clear air a surface needs to be standing room. The capsule plus 15 cm. */
const RETURN_HEADROOM = 1.9;
/**
 * Below this share of returnable ground, the pad wears the ring.
 *
 * 70%, and it is a threshold sitting in a GAP rather than a tuned number: the
 * thirty pads measure 1.5, 2.7, 4.7, 6.7, 8.0, 17.6, 24.9, 45.1, 49.8 and then
 * nothing at all until 91.6, 95.1, 95.2, 97.2, 97.9, 98.2, 99.5, 99.9, 100.
 * Nine one-way pads on eight planets, which is the "seven of ten planets have a
 * pad you can walk off and never walk back onto" the rim marking was written
 * for, found by measurement instead of by eye.
 */
const RETURN_ONE_WAY = 70;
/** Hazard blocks in a full rim ring. 48 at 7.5 degrees apart. */
const RIM_BLOCKS = 48;

export class PlanetWorld extends World {
  static id = 'planet';
  static displayName = 'Planet Surface';
  /** The descriptor this subclass renders. Set by `PlanetWorld.of`. */
  static planet = null;

  /**
   * Stamp a registerable World subclass for one planet.
   *
   * `WorldManager` keys everything on `static id`, so a planet needs a class
   * with its own id - but it does not need its own CODE, and this is the whole
   * difference. The subclass is four static fields.
   *
   * @param {Readonly<object>} descriptor from `definePlanet`
   * @returns {typeof PlanetWorld}
   */
  static of(descriptor) {
    return class extends PlanetWorld {
      static id = descriptor.id;
      static displayName = descriptor.name;
      static planet = descriptor;
    };
  }

  constructor(ctx) {
    super(ctx);
    const P = this.constructor.planet;
    if (!P) throw new Error('[PlanetWorld] use PlanetWorld.of(descriptor) - the base class renders nothing');
    this.planet = P;
    this.gravity = P.gravity;

    /** The one height function. Everything that asks the ground a question
     *  asks this, including the generation worker (by name). */
    this.groundAt = HEIGHT_FIELDS.planet(P.terrain);
    /** Collision cell size. Slope filters are measured over it - see Placement. */
    this.cell = (P.half * 2) / P.seg;

    /** @type {Array<{id:string,name:string,position:THREE.Vector3,radius:number,yaw:number,primary:boolean}>} */
    this.landingSites = [];
    /** @type {Array<{id:string,type:string,name:string,position:THREE.Vector3,credits:number,size:number}>} */
    this.mineralNodes = [];
    /**
     * The contract `src/systems/Viewpoints.js` reads. Filled by `_publish` from
     * the descriptor's own list, with `y` measured off the built collision
     * height field. Empty on a planet that authors none, which that system
     * already treats as "this world has no viewpoints" rather than as an error.
     * @type {Array<{id:string,name:string,x:number,y:number,z:number,r:number}>}
     */
    this.viewpoints = [];
    /** Build-time census, reported by the tests and the console. */
    this.census = { props: {}, minerals: {}, colliders: 0, drawCalls: 0, triangles: 0 };

    this.rules = makeRules({
      /* A planet surface is a wilderness. Nothing that belongs to a settlement
       * belongs here, and switching them on would have the crowd system fill
       * 640,000 m2 of ash with traders. */
      merchants: false,
      quests: false,
      contracts: false,
      races: false,
      interiors: false,
      crowd: false,
      /* PER LIQUID, NOT PER WORLD - and that one word is most of this change.
       *
       * This was a flat `false` for all ten planets, and the comment on
       * `Shoal.js` that begins "THE ONE CONSTRAINT THAT DESIGNED THIS PLANET"
       * is what it cost: an ocean world whose ocean was a painted sheet with a
       * fence round it, because the same line that (correctly) refuses to let
       * anyone swim in Cinder's lava also refused Shoal's sea.
       *
       * `liquidSwimmable` asks the LIQUID. Water is swimmable; lava and acid
       * are not, and they get the hazard instead - which is what
       * `liquid.lethal` was declared for.
       * @see ./planets/PlanetLiquid.js `liquidSwimmable`, `liquidHazard` */
      swim: liquidSwimmable(P.liquid),
      /* Caches and relics OFF, and this is a look bug as much as a design one.
       * Both systems scatter their own sites without asking the world where the
       * ground, the lava or the cliffs are, and with them on a review screenshot
       * of the caldera came back with thirty amber pickups strung across the
       * flank like fairy lights. A wilderness has no supply caches and no
       * collectible relics in it: the MINERALS are what is collectible here, and
       * they are placed against the real height field. */
      caches: false,
      relics: false,
      /* Mounts off: a horse on a volcano is a joke the player did not make.
       * The ship is the mount here. */
      mounts: false,
      /* Loot stays ON: it is the drop path a mined node will use. */
    });

    this.bounds = new THREE.Box3(
      new THREE.Vector3(-P.half, -60, -P.half),
      new THREE.Vector3(P.half, 260, P.half)
    );

    const sky = P.sky ?? {};
    const sunDir = new THREE.Vector3(...(sky.sun?.direction ?? [-0.5, 0.4, -0.7])).normalize();
    this.environment = {
      ...this.environment,
      background: new THREE.Color(sky.background ?? 0x101010),
      fogColor: new THREE.Color(sky.fog?.color ?? sky.background ?? 0x101010),
      fogNear: sky.fog?.near ?? 60,
      fogFar: sky.fog?.far ?? 600,
      exposure: sky.exposure ?? 1.0,
      ambientColor: new THREE.Color(sky.ambient?.color ?? 0x404040),
      ambientIntensity: sky.ambient?.intensity ?? 0.5,
      sunColor: new THREE.Color(sky.sun?.color ?? 0xffffff),
      sunIntensity: sky.sun?.intensity ?? 2.2,
      sunDirection: sunDir,
      envMapIntensity: sky.envMapIntensity ?? 1.0,
      /* DECLARED null, filled in by `_bakeEnvMap` once the dome exists.
       *
       * The intensity above was being applied to a map these ten worlds never
       * supplied. `applyEnvironment` used to skip the assignment for a world
       * that published none, so every planet's minerals, ship hull, ice and
       * standing water were multiplied by `sky.envMapIntensity` of WHICHEVER
       * WORLD RAN LAST - Tessera's deliberate 0.35 dimmed the station's cyan
       * probe rather than its own sky - or of nothing at all on a cold
       * `?world=planet:...` boot.
       *
       * Stating the field here rather than leaving it undefined is the point:
       * `main.js` and `Portals._configurePreview` both read `env.envMap ??
       * null`, and a descriptor-driven world that has not been built yet must
       * answer "no probe" rather than "ask the scene what it is wearing". */
      envMap: null,
      bloom: sky.bloom ?? null,
      grade: sky.grade ?? null,
    };

    /** Everything this world owns and must dispose. */
    this._owned = [];
    this._sky = null;
    /** This planet's prefiltered probe. Owned here; see `_bakeEnvMap`.
     *  @type {THREE.WebGLRenderTarget|null} */
    this._envRT = null;
    this._liquidUniforms = null;
    /**
     * This world's own answer for its liquid, read by `WaterVolumes` instead of
     * a geometry scan. Built in `_buildLiquid`; null on a dry planet.
     * @see ../systems/WaterVolumes.js
     * @type {{surfaceAt:(x:number,z:number)=>number|null, swimmable:boolean,
     *         lethal:boolean, dps:number, cause:string, name:string}|null}
     */
    this.liquidField = null;
    /** True while the camera is under a liquid surface. @see `_underwater` */
    this._under = false;
    /** The colour the world is painted while submerged. Never `environment`'s
     *  own instance: assigning that to `scene.background` and then writing to
     *  it would edit the world's palette from the inside. */
    this._underColor = new THREE.Color(0x0d3348);
    this._plumes = [];
    this._ash = null;
    /**
     * The published weather rule, or null on the seven planets whose descriptors
     * do not carry the facts for one. Same shape and same contract as
     * `liquidField`. @see `_buildHazardField`
     * @type {{id:string,kind:string,name:string,cause:string,
     *         peak:{dps:number,push:number,stamina:number},
     *         at:(x:number,y:number,z:number,out:object)=>object}|null}
     */
    this.hazardField = null;
    this._hazardSpec = null;
    this._hazardSample = null;
    this._scorch = null;
    /** The terrain collision field, kept by `_buildTerrain`. @see `_publish` */
    this._terrainField = null;
    /** The ash field's authored opacity, captured before anything scales it. */
    this._ashBase = null;
    this._t = 0;
  }

  _own(x) { if (x) this._owned.push(x); return x; }

  /* ================================================================== */
  /* Build                                                              */
  /* ================================================================== */

  async build(onProgress) {
    const P = this.planet;
    onProgress?.(0.04, `Entering ${P.name}`);
    this._buildSky();

    onProgress?.(0.10, 'Sampling the surface');
    /* The authored ejecta block, alongside the terrain job rather than in front
     * of it. `loadPlanetAssets` never rejects and resolves to null when the file
     * is missing - which is the whole headless suite and any deploy without the
     * asset - so this is a settle, not a dependency, and `_buildProps` reads the
     * cache synchronously afterwards. @see planets/PlanetAssets.js. */
    await Promise.all([this._buildTerrain(), loadPlanetAssets()]);

    onProgress?.(0.52, 'Pouring the flows');
    this._buildLiquid();

    onProgress?.(0.62, 'Scattering');
    this._buildProps();

    onProgress?.(0.82, 'Seeding deposits');
    this._buildMinerals();

    onProgress?.(0.90, 'Marking the pads');
    this._buildLandingSites();

    onProgress?.(0.96, 'Air');
    this._buildAtmosphere();
    this._buildHazardField();

    this._publish();
    onProgress?.(1, P.name);

    console.info(
      `[PlanetWorld] ${P.id}: ${this.census.triangles.toLocaleString()} tris in `
      + `${this.census.drawCalls} draws, ${this.census.colliders} colliders, `
      + `${this.mineralNodes.length} mineral nodes, ${this.landingSites.length} landing sites`
      + (this.viewpoints.length
        ? `, ${this.viewpoints.length} viewpoints (${this.viewpoints.map((v) => `${v.id}@${v.y.toFixed(1)}m`).join(', ')})`
        : '')
      + (this.hazardField
        ? `, LIVE HAZARD ${this.hazardField.id} - ${this.hazardField.name}`
          + (this.hazardField.peak.dps ? ` at ${this.hazardField.peak.dps.toFixed(2)} dps` : '')
          + (this.hazardField.peak.push ? ` pushing ${this.hazardField.peak.push.toFixed(2)} m/s` : '')
          + (this.hazardField.peak.stamina ? ` draining ${this.hazardField.peak.stamina.toFixed(2)} stam/s` : '')
        : '')
      + (this.census.liquid
        ? `, ${this.census.liquid.substance} over ${this.census.liquid.wetCells}/${this.census.liquid.cells} cells `
          + (this.census.liquid.swimmable ? 'SWIMMABLE' : 'not swimmable')
          + (this.census.liquid.lethal ? ` and LETHAL at ${this.census.liquid.hazardDps} dps` : '')
          + `, walled by ${this.census.liquid.barrierPosts} posts on ${this.census.liquid.barrierRuns} runs`
          + (this.census.liquid.guards ? ` (${this.census.liquid.guards} guard)` : '')
          + (this.census.liquid.barrierPosts
            ? `, ${this.census.liquid.parapet} m over the bank (leap apex ${this.census.liquid.leapApex} m), `
              + `worst gate ${this.census.liquid.worstGate} m, tallest +${this.census.liquid.tallestAboveWater} m over the water`
            : '')
          + (this.census.liquid.clampedPosts ? `, ${this.census.liquid.clampedPosts} clamped at ${WALL_MAX} m` : '')
          + (this.census.edgeWall ? `, ${this.census.edgeWall} edge-wall boxes` : '')
        : '')
      + (this.census.floor ? `, floor at ${this.census.floor.top} m (bound ${this.bounds.min.y.toFixed(1)})` : '')
    );
  }

  /* ------------------------------------------------------------------ */

  /**
   * The dome.
   *
   * `environment.background` is a flat colour, which reads as a void behind a
   * skyline rather than as air - and a planet is looked ACROSS more than
   * anything else in this game. The dome costs one draw call and gives the
   * horizon a haze band for the caldera to stand against.
   */
  _buildSky() {
    const sky = this.planet.sky ?? {};
    const params = { ...(sky.params ?? {}) };
    if (Array.isArray(params.sunDirection)) params.sunDirection = new THREE.Vector3(...params.sunDirection);
    params.radius = params.radius ?? Math.max(1500, this.planet.half * 4);
    /* THE DOME RIDES THE CAMERA, and it could not come from the descriptor.
     *
     * `Sky.update` re-centres the dome on `params.camera` every frame - that is
     * the only thing that makes a dome read as infinitely far away - and
     * `SpaceWorld._buildSky` passes it. This one could not: `definePlanet`
     * rejects class instances, so a live `THREE.Camera` cannot be a field of a
     * frozen planet descriptor. It has to be added here, where the engine is.
     *
     * Without it the dome was pinned wherever the camera happened to be at the
     * frame `activate` resolved - which on the descent seam is the chase camera
     * hundreds of metres up and offset from the pad. Measured: moving the
     * camera 990 m moved the space dome 707.11 m and moved this one 0.00.
     * `VOLCANIC.half` is 400 so the dome is 1600 m in radius, a legal walk to
     * the corner of the playfield is 566 m, and the horizon therefore swung
     * 20.7 degrees while the player walked - with `sky.material.fog === false`
     * so nothing hid it. */
    params.camera = params.camera ?? this.engine?.camera ?? null;
    const built = createSky(sky.kind ?? 'daylight', params);
    built.mesh.name = `planet:sky:${this.planet.id}`;
    /* Before the dome joins the world group, while it is still parented
     * nowhere and still sitting at the origin `createSky` left it at - the
     * probe wants it centred, and `Sky.update` moves it onto the camera from
     * the first frame onward. */
    this._bakeEnvMap(built, params.radius);
    this.group.add(built.mesh);
    this._sky = built;
    this.census.drawCalls++;
  }

  /**
   * Prefilter THIS planet's sky into a reflection probe.
   *
   * ── Why not `Materials.getEnvMap` ─────────────────────────────────────────
   *
   * That accessor has three moods - `space`, `daylight`, `alpine` - and the
   * ten planets happen to name their dome with those same three words. Reusing
   * it would have cost nothing and would have been wrong: Sallow, Shoal,
   * Sirocco and Volcanic are all `kind: 'daylight'`, and their skies are
   * sulphur-yellow, sea-blue, amber and ember-red. One shared blue-sky probe
   * would have put a clear noon sky in the puddles of lava on Cinder, which is
   * the same "a red planet reflects a blue one" failure this change exists to
   * remove, only harder to see because it would look plausible.
   *
   * So the probe is baked from the dome the player is actually standing under,
   * exactly as `SportsWorld._buildSky` and `MedievalWorld._buildEnvMap`
   * already do. The reflection in a hull then agrees with the horizon behind
   * it, which is the whole reason to have one.
   *
   * ── The cost, and why it is one target and not ten ────────────────────────
   *
   * `fromScene` with no `size` option bakes a 256 cube, which is a 768x1024
   * half-float target: ~6 MB, and `envMapCubeUVHeight` 1024, THE SAME 1024 as
   * `Materials._generateEnvMap`, sports and the vale. That number is a program
   * cache key - see the block comment on `MedievalWorld._buildEnvMap`, where
   * getting it wrong cost 24 of one arrival's 28 linked programs - so this
   * must never be tuned as if it were a quality dial.
   *
   * One target per BUILT planet, released by `dispose` with the rest of
   * `_owned`. Ten only exist if all ten planets are resident at once, which is
   * the `?prefetch=all` diagnostic path; alongside a resident planet's
   * heightfield, bed and liquid-depth buffers, 6 MB is not the term that
   * decides whether that path fits.
   *
   * @param {{mesh: THREE.Mesh}} built the dome `createSky` just returned
   * @param {number} radius its radius, in metres
   */
  _bakeEnvMap(built, radius) {
    const renderer = this.engine?.renderer;
    /* `isWebGLRenderer` rather than a truthiness check, because the headless
     * rigs DO supply a renderer - a hand-written stub with `render`,
     * `setRenderTarget` and `capabilities` on it, and no `xr`, which is the
     * first field `PMREMGenerator.fromScene` touches. Without this the bake
     * threw into the catch below and printed a warning per planet build across
     * fifteen test files. No GL, no probe, no noise. */
    if (!renderer?.isWebGLRenderer) return;

    /* The lower hemisphere, and it is not optional: with only a dome, every
     * metal in the scene has a black underside and reads as floating in void
     * (the same note `Materials._generateEnvMap` carries on its ground disc).
     * The colour is this planet's own ground - `sky.params.groundColor` is the
     * albedo its atmosphere already scatters against, so the probe and the
     * horizon agree - falling back to the mean of the descriptor's height
     * bands for the airless planets, which declare no scattering ground. */
    const ground = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 0.99, 24, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: this._groundBounceColor(),
        side: THREE.BackSide,
        toneMapped: false,
        fog: false,
      })
    );

    const envScene = new THREE.Scene();
    let pmrem = null;
    try {
      pmrem = new THREE.PMREMGenerator(renderer);
      envScene.add(built.mesh, ground);
      /* 0.02 of extra blur, matching sports: the dome is already a smooth
       * analytic sky and PMREM's own roughness chain does the rest. `far` is
       * past the dome or the bake photographs the inside of the near plane. */
      this._envRT = pmrem.fromScene(envScene, 0.02, 1, radius * 1.5);
      this._envRT.texture.name = `planet.env.${this.planet.id}`;
      this.environment.envMap = this._envRT.texture;
      this._owned.push(this._envRT);
    } catch (err) {
      console.warn(`[PlanetWorld] ${this.planet.id} environment probe unavailable:`, err?.message ?? err);
    } finally {
      // The dome belongs to the world group, not to the bake.
      envScene.remove(built.mesh);
      ground.geometry.dispose();
      ground.material.dispose();
      pmrem?.dispose();
    }
  }

  /**
   * The colour the ground bounces into the probe.
   * @returns {THREE.Color}
   */
  _groundBounceColor() {
    const g = this.planet.sky?.params?.groundColor;
    if (g !== undefined && g !== null) return new THREE.Color(g);
    const bands = this.planet.palette?.bands ?? [];
    if (!bands.length) return new THREE.Color(0x404040);
    /* No boost. The band colours are the descriptor's own measured table of
     * what LIT ground on this planet looks like, not raw albedo, so scaling
     * them would double-count the sun - the reason `ENV_MOODS` carries a
     * `groundBoost` and `SportsWorld` does not. */
    const mean = new THREE.Color(0, 0, 0);
    const c = new THREE.Color();
    for (const b of bands) mean.add(c.set(b.color));
    return mean.multiplyScalar(1 / bands.length);
  }

  /**
   * The ground: one worker job, one mesh, one heightfield collider.
   *
   * The vertex colours are computed here rather than in the job because they
   * are the only part of the surface that needs `three` - and because the job
   * already returns everything they are derived from (heights and normals), so
   * this is a pass over buffers rather than a second evaluation of the height
   * function.
   */
  async _buildTerrain() {
    const P = this.planet;
    const N = P.seg + 1;
    const size = P.half * 2;

    const t = await genPool.run('terrain', {
      field: 'planet',
      params: P.terrain,
      originX: -P.half,
      originZ: -P.half,
      size,
      seg: P.seg,
      uv: 'unit',
      normals: true,
    });

    /* NaN propagates through bloom and blacks out the entire frame - 19 bad
     * pixels took out 921,600 in this repo once. The height function is data
     * driven, so a descriptor with a zero radius or a divide by a taper of 1
     * would reach the shader as NaN rather than as a thrown error. Checked once,
     * over the samples that actually got made. */
    if (!Number.isFinite(t.minY) || !Number.isFinite(t.maxY)) {
      throw new Error(`[PlanetWorld] ${P.id} terrain produced non-finite heights (min ${t.minY}, max ${t.maxY})`);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(t.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(t.normals, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(t.uvs, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(this._terrainColors(t, N), 3));
    geo.setIndex(new THREE.BufferAttribute(t.indices, 1));
    geo.computeBoundingSphere();
    this._own(geo);

    /* Tiled off the library's own key so texel density is the same on the
     * crater wall and the ash plain. Cloned, not shared: the terrain runs with
     * `vertexColors` on and the library material does not. */
    const tile = P.palette.tile ?? 6;
    const repeat = size / tile;
    const mat = this.materials.get(`${P.palette.material}:${repeat}`).clone();
    mat.name = `planet.${P.id}.ground`;
    mat.vertexColors = true;
    mat.color = new THREE.Color(0xffffff);
    this._own(mat);

    const ground = new THREE.Mesh(geo, mat);
    ground.name = `planet:${P.id}:terrain`;
    ground.receiveShadow = true;
    ground.castShadow = false;
    this.group.add(ground);
    this.census.drawCalls++;
    this.census.triangles += t.indices.length / 3;

    /* ONE collider for the whole surface, on the same samples the mesh drew.
     * @see the header: this is the fix for "collision below mesh", made true by
     * construction rather than by rounding upward. */
    /* KEPT, and this reference is load-bearing rather than a convenience.
     *
     * `physics.terrainHeight` takes the MAX over every registered height field,
     * and `_buildFloor` (three lines down) registers a second one that is wider
     * than the playfield. Inside the map the terrain always wins, but a query a
     * few metres outside it returns the FLOOR's depth as if it were ground -
     * silently, as a finite number. Everything that has to stand on the terrain
     * and only the terrain samples this collider by name instead.
     * @see _publish, where a viewpoint's y is measured off it. */
    this._terrainField = this.track(this.physics.addHeightfield({
      heights: t.heights,
      nx: N,
      nz: N,
      originX: -P.half,
      originZ: -P.half,
      stepX: size / P.seg,
      stepZ: size / P.seg,
    }));
    this.census.colliders++;
    this._terrainMinY = t.minY;
    this._terrainMaxY = t.maxY;

    /* THE BED, kept for the liquid.
     *
     * The same `t.heights` the mesh was drawn from and the collider registered
     * with - not a re-evaluation. Everything downstream that asks "how deep is
     * the water here" or "is this cell under the water" reads this, so the
     * shader's depth term, the shore barrier and the minimap's land are all
     * measuring the same surface the player stands on. */
    this._bed = {
      heights: t.heights,
      nx: N,
      nz: N,
      originX: -P.half,
      originZ: -P.half,
      stepX: size / P.seg,
      stepZ: size / P.seg,
    };

    this._buildFloor();
  }

  /**
   * THE FLOOR OF THE WORLD - one slab, under everything, wider than the map.
   *
   * @see the design block on FLOOR_DROP at the top of this file for the
   * measurement that forced it: a capsule resolved at Shoal's own deepest
   * sea-bed sample is pushed 33 cm past the height field's footprint and then
   * falls without limit, and a corpse doing it beat the void catch to -116.7 m
   * because the respawn timer is 3.2 s and the void waits for -85.
   *
   * This also sets `bounds.min.y`, which until now was a hard-coded -60 on
   * every planet whether its terrain bottomed out at -0.2 (Verdigris) or -44.7
   * (Tessera). The bound is the void catch's datum, so a planet that is deeper
   * than its bound is a planet whose void catch fires INSIDE the playable
   * world; one that is shallower wastes 25 m of falling. Deriving it from the
   * floor makes the three depths order themselves - floor, then bound, then
   * void - on every planet by construction.
   */
  _buildFloor() {
    const P = this.planet;
    const minY = Number.isFinite(this._terrainMinY) ? this._terrainMinY : -60;
    const top = minY - FLOOR_DROP;
    const half = P.half + FLOOR_MARGIN;
    /* Two samples on a side is the whole field: it is a plane, and
     * `sampleHeight` interpolates a constant to a constant. */
    const heights = new Float32Array(4).fill(top);
    this.track(this.physics.addHeightfield({
      heights,
      nx: 2,
      nz: 2,
      originX: -half,
      originZ: -half,
      stepX: half * 2,
      stepZ: half * 2,
      minY: top,
      maxY: top,
      /* 400 m of solid under it, so a body moving fast cannot be below the
       * base in the same step it crossed the surface. `baseY` is where a
       * heightfield stops being solid - the one way through this floor. */
      baseY: top - 400,
      /* Tagged for the same reason the shore posts are: a probe has to be able
       * to name the backstop rather than find a second height field in its
       * lattice and wonder what built it. */
      userData: { planetFloor: true },
    }));
    this.census.colliders++;
    this.census.floor = { top: Number(top.toFixed(2)), half, terrainMinY: Number(minY.toFixed(2)) };
    this.bounds.min.y = top - BOUND_BELOW_FLOOR;
  }

  /**
   * The terrain height field as a texture the liquid shader can read.
   *
   * One channel, half-float, nearest-to-linear filtered, no mipmaps. Half
   * rather than full float because linear filtering of a 32-bit texture is an
   * extension in WebGL2 and of a 16-bit one is not - and because at the
   * magnitudes a planet's terrain reaches (Shoal's bed runs -60 to 76) a half
   * float resolves better than 6 cm, which is far finer than a colour ramp can
   * show.
   *
   * NON-FINITE IS FATAL HERE, not clamped. A single NaN in this texture is a
   * NaN depth, a NaN `mix`, and 19 such pixels have already taken out a
   * 921,600-pixel frame in this project by way of the bloom pass. The terrain
   * job's own min/max check upstream would not catch it: `Math.min` with a NaN
   * argument does not necessarily propagate.
   */
  _bedTexture() {
    const bed = this._bed;
    if (!bed) return null;
    if (!(bed.stepX > 0) || !(bed.stepZ > 0)) {
      throw new Error(`[PlanetWorld] ${this.planet.id} bed step must be positive (${bed.stepX} x ${bed.stepZ})`);
    }
    const h = bed.heights;
    const data = new Uint16Array(h.length);
    for (let i = 0; i < h.length; i++) {
      const v = h[i];
      if (!Number.isFinite(v)) {
        throw new Error(`[PlanetWorld] ${this.planet.id} bed sample ${i} is ${v} - a non-finite depth reaches the shader as a NaN pixel`);
      }
      data[i] = THREE.DataUtils.toHalfFloat(v);
    }
    const tex = new THREE.DataTexture(data, bed.nx, bed.nz, THREE.RedFormat, THREE.HalfFloatType);
    tex.name = `planet.${this.planet.id}.bed`;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this._own(tex);
    return { texture: tex, ...bed };
  }

  /**
   * Per-vertex ground colour: height bands, a slope override and a mottle.
   *
   * Three terms, and each one is answering a specific way procedural terrain
   * fails to read:
   *
   *   BANDS   give the eye a height cue. Without them a 158 m caldera and a
   *           12 m plain are the same colour and the silhouette disappears
   *           into the haze.
   *   SLOPE   puts bare rock on anything steep. This is what separates a cliff
   *           from a hill at any distance, and it is free here because the job
   *           already returned the normals.
   *   MOTTLE  large-scale drift, so the bands do not print as a contour map.
   *           The one term with no physical justification and the one that does
   *           the most work.
   *   PATCH   colour SOMEWHERE IN PARTICULAR, through the same region records
   *           the props and the minerals are placed with. The three terms above
   *           are global functions of the ground and between them cannot say
   *           "this feature is a different colour" - which is why an ejecta ray,
   *           whose entire physical signature is albedo, could only be built as
   *           a corridor of bright chips, and why a young crater could not have
   *           a bright floor without giving one to every contour at that height
   *           on the map. @see `palette.patch` in `PlanetDescriptor.js`.
   */
  _terrainColors(t, N) {
    const pal = this.planet.palette;
    const bands = pal.bands;
    const out = new Float32Array(N * N * 3);
    const slope = pal.slope ?? null;
    const mottle = pal.mottle ?? null;
    const mInv = mottle ? 1 / mottle.scale : 0;
    if (mottle) _colB.setHex(mottle.color);
    const slopeFrom = slope ? Math.cos((slope.fromDeg * Math.PI) / 180) : 0;
    const slopeTo = slope ? Math.cos((slope.toDeg * Math.PI) / 180) : 0;

    /* Patches, prepared once. `definePlanet` has already filled every default
     * and frozen the list, so nothing here has to guess what an absent
     * `strength` meant. The colour is resolved per patch rather than per vertex
     * because `setHex` is the expensive part of this loop. */
    const patches = (pal.patch ?? []).map((q) => ({
      region: q.region,
      color: new THREE.Color().setHex(q.color),
      strength: q.strength,
      feather: q.feather,
      grain: q.grain,
      grainInv: 1 / q.grainScale,
      /* The region's own filters, hoisted so the inner loop is comparisons.
       * `clearOfLiquid`/`clearOfPads` are deliberately not read - see the
       * schema note; they are scatter-rejection rules and a patch that avoided
       * pads would draw a ring round every landing site. */
      yMin: q.region.yMin ?? -Infinity,
      yMax: q.region.yMax ?? Infinity,
      cosMax: q.region.slopeMaxDeg !== undefined
        ? Math.cos((q.region.slopeMaxDeg * Math.PI) / 180) : -2,
      cosMin: q.region.slopeMinDeg !== undefined
        ? Math.cos((q.region.slopeMinDeg * Math.PI) / 180) : 2,
    }));

    for (let i = 0; i < N * N; i++) {
      const y = t.heights[i];
      // Bands: find the pair this height falls between and lerp.
      let bi = 0;
      while (bi < bands.length - 1 && y > bands[bi].upTo) bi++;
      const lo = bands[Math.max(0, bi - 1)];
      const hi = bands[bi];
      const span = hi.upTo - (bi > 0 ? lo.upTo : hi.upTo - 1);
      const f = bi > 0 ? Math.max(0, Math.min(1, (y - lo.upTo) / (span || 1))) : 1;
      _col.setHex(lo.color).lerp(_colB.setHex(hi.color), f);

      if (slope) {
        const ny = t.normals[i * 3 + 1];
        // ny falls as the surface steepens: cos(from) down to cos(to).
        const s = Math.max(0, Math.min(1, (slopeFrom - ny) / Math.max(1e-6, slopeFrom - slopeTo)));
        if (s > 0) _col.lerp(_colB.setHex(slope.color), s);
      }
      if (mottle) {
        /* The SAME fbm the ground is made of, not a sine.
         *
         * The first version was `sin(x) + cos(z)`, which is a regular standing
         * wave: on an 800 m ash plain it produced a corduroy nobody could name
         * and the plain read as one flat colour anyway. Three octaves of the
         * height field's own noise gives patches with edges, which is what
         * oxidised ash looks like from eye level - and it costs one call to a
         * function that is already in the module graph. */
        const x = t.positions[i * 3];
        const z = t.positions[i * 3 + 2];
        const n = fbm(x * mInv, z * mInv, 5501, 3);
        _col.lerp(_colB.setHex(mottle.color), n * n * mottle.amount);
      }
      /* PATCHES LAST, and on purpose: an ejecta ray is fresh material lying ON
       * a weathered surface, so it covers the drift rather than being tinted by
       * it. They are applied in declaration order and accumulate, which is how
       * a ray is made brighter at the crater than at its tip - two records over
       * one polyline, not a second gradient term nobody asked for. */
      if (patches.length) {
        const x = t.positions[i * 3];
        const z = t.positions[i * 3 + 2];
        const ny = t.normals[i * 3 + 1];
        for (let k = 0; k < patches.length; k++) {
          const q = patches[k];
          if (y < q.yMin || y > q.yMax) continue;
          /* Slope from the MESH NORMAL rather than a central difference over
           * the collision step. `scatter` uses the difference because it is
           * deciding whether a capsule can stand there; this is deciding what
           * a surface looks like, and the normal is the surface. They agree to
           * within a degree on everything but a single-cell spike. */
          if (ny < q.cosMax || ny > q.cosMin) continue;
          const depth = regionDepth(q.region, x, z);
          if (!(depth > 0)) continue;
          let w = q.feather > 0 ? Math.min(1, depth / q.feather) : 1;
          /* Breakup, from the SAME fbm the mottle is made of: fresh ejecta is
           * scattered material and not paint, and a patch with a clean edge and
           * a flat interior reads as a decal. One call to a function already in
           * the module graph. */
          if (q.grain > 0) w *= 1 - q.grain * (1 - fbm(x * q.grainInv, z * q.grainInv, 7717, 3));
          if (w > 0) _col.lerp(q.color, w * q.strength);
        }
      }
      out[i * 3] = _col.r;
      out[i * 3 + 1] = _col.g;
      out[i * 3 + 2] = _col.b;
    }
    return out;
  }

  /** Lava, water, methane - whatever the descriptor pours. */
  _buildLiquid() {
    const L = this.planet.liquid;
    if (!L) return;
    const swimmable = liquidSwimmable(L);
    const hazard = liquidHazard(L);
    /* The bed texture is built only when the depth term will use it, so a lava
     * planet allocates nothing. `liquidDepth` decides; see `PlanetLiquid`. */
    const wantsDepth = liquidDepth(L).amount > 0;
    const bed = wantsDepth ? this._bedTexture() : null;
    const { material, uniforms, depth } = createLiquidMaterial(L, bed);
    this._liquidDepth = depth;
    const skirtMat = createSkirtMaterial(L);

    /* ── THE VIEW FROM UNDERNEATH ────────────────────────────────────────
     * A disc is a fan and a ribbon is a strip, both wound to face UP - which
     * `planet-relief.test.mjs` asserts, because a face-down sea is 340 m of
     * river that simply is not in the frame. The cost of getting that right is
     * that from BELOW the surface is culled, and a playthrough that got into
     * Shoal's sea reported exactly that: "a dry, dusty grey plain to the
     * horizon under an open sky, while the minimap is solid blue".
     *
     * `DoubleSide` on a swimmable liquid, and not on lava: nothing gets under
     * Cinder's crater lake, and Cinder is the calibrated reference. The
     * material is a `MeshStandardMaterial`, so the back face is lit through
     * `gl_FrontFacing` with the normal flipped - i.e. lit from below, by
     * ambient only, which is dark. That is the correct read: the underside of
     * water is dark. The apron gets it too, or the shore is a hole from
     * underneath. */
    if (swimmable) {
      material.side = THREE.DoubleSide;
      skirtMat.side = THREE.DoubleSide;
    }
    this._own(material);
    this._own(skirtMat);
    this._liquidUniforms = uniforms;

    const g = new THREE.Group();
    g.name = `planet:${this.planet.id}:liquid`;
    this.group.add(g);

    L.bodies.forEach((b, i) => {
      const { surface, skirt } = bodyGeometry(b);
      this._own(surface);
      this._own(skirt);
      const sm = new THREE.Mesh(surface, material);
      sm.name = `liquid:${i}`;
      sm.receiveShadow = false;
      sm.castShadow = false;
      g.add(sm);
      const sk = new THREE.Mesh(skirt, skirtMat);
      sk.name = `liquid:${i}:skirt`;
      sk.castShadow = false;
      sk.receiveShadow = true;
      g.add(sk);
      this.census.drawCalls += 2;
      this.census.triangles += (surface.index ? surface.index.count : surface.attributes.position.count) / 3
        + (skirt.index ? skirt.index.count : skirt.attributes.position.count) / 3;
    });

    /* ONE point light, on the body the descriptor names. `RIG_BUDGET.point` is
     * twelve for the whole game and every one of them is compiled into every
     * shader; a light per lava body would charge the entire boot for a glow the
     * emissive already provides. */
    const gl = L.glowLight;
    if (gl) {
      const b = L.bodies[gl.body ?? 0];
      const light = pointLight(gl.color ?? 0xff7a2a, gl.intensity ?? 30, gl.distance ?? 120, 1.8);
      light.castShadow = false;
      light.position.set(b.x ?? b.pts[0][0], (b.y ?? b.y0) + 6, b.z ?? b.pts[0][1]);
      light.name = 'planet:liquid:glow';
      g.add(light);
    }

    /* ── WHAT `WaterVolumes` READS ───────────────────────────────────────
     * The world answers for its own liquid rather than being scanned. See the
     * header of `WaterVolumes`: Shoal's sea is a 128-triangle fan 2,700 m
     * across, and decomposing it onto that system's 8 m lattice would build
     * roughly 450,000 `Box3` volumes for a shape `liquidSurfaceAt` answers
     * exactly, in constant memory, from the same function the mesh was built
     * from.
     *
     * Published even when the liquid is NOT swimmable, because `Swim` still
     * has to know where Cinder's lava is in order to burn anything standing in
     * it - `rules.swim` gates the swim, not the knowledge. */
    this.liquidField = {
      surfaceAt: (x, z) => liquidSurfaceAt(L, x, z),
      swimmable,
      lethal: hazard.lethal,
      dps: hazard.dps,
      cause: hazard.cause,
      name: L.name ?? hazard.kind,
    };
    this._underColor.set(L.color ?? 0x0d3348);

    this._buildLiquidBarrier(L);
    this._buildEdgeWall(L);
  }

  /**
   * THE SHORE BARRIER - the thing that makes the liquid real.
   *
   * ═══════════════════════════════════════════════════════════════════════
   *  WHAT WAS WRONG
   * ═══════════════════════════════════════════════════════════════════════
   * `_buildLiquid` drew meshes and never touched `this.physics`. `swim` is
   * false, and `WaterVolumes` never saw planet liquid either - the material
   * name `planet.liquid` misses its `WATERISH` regex, and its scan is gated on
   * `allows(world, 'swim')` anyway. So a planet's liquid was neither swimmable
   * nor solid: the shipped game let a player walk down the beach and along the
   * SEA BED, under an opaque ceiling, in full daylight.
   *
   * Every reachability probe in this repo models liquid as a wall
   * (`planet-reach.test.mjs`'s `lavaMask`, `planet-minerals.test.mjs`). The
   * renderer did not. That gap is this project's signature defect class -
   * "tested that it was BUILT, never that a player can REACH it" - running
   * backwards: the test was right and the world was wrong.
   *
   * ═══════════════════════════════════════════════════════════════════════
   *  WHAT THE FENCE IS FOR NOW, WHICH IS NOT WHAT IT WAS FOR
   * ═══════════════════════════════════════════════════════════════════════
   *
   * The block that used to stand here refused swimming, and it refused it for
   * a reason that was true when it was written: the probes model liquid as a
   * wall, and making the sea swimmable makes every reachability decision on
   * Shoal false. That is still the risk. What has changed is that the risk was
   * MEASURED rather than reasoned about, and it turns out to be one island
   * wide.
   *
   * SWIMMING IS NOW THE ANSWER FOR WATER. `liquidSwimmable` splits the six
   * liquid planets: Shoal's sea, Sirocco's brine, Vitrine's meltwater and
   * Verdigris's river are water and are entered; Cinder's lava and Sallow's
   * acid are not and are fenced. Flooding all six at the REAL envelope
   * (56.63 deg) with swim crossings, against the same flood with liquid as a
   * wall, moves exactly one seam:
   *
   *     sirocco    fulgurite 0/7 -> 0/7      (+2,610 walkable cells: the brine
   *                                           pans are 38 cm deep and were
   *                                           fenced. You wade them now.)
   *     vitrine    hyaline   0/8 -> 0/8      (+840)
   *     verdigris  verdite   0/7 -> 0/7      (+9,451: the river is 1.21 m and
   *                                           is waded, not swum)
   *     shoal      abyssite  0/7 -> 7/7      <<< BROKEN
   *
   * So the fence survives in exactly two places and both are named rather than
   * assumed:
   *
   *   LETHAL LIQUID, every metre of it. Lava and acid are things to be kept
   *   out of, and now that `liquid.lethal` is wired the wall and the burn are
   *   belt and braces on the same intent: the wall is what stops you falling
   *   in by accident, the burn is what happens when you get past it anyway.
   *
   *   A DECLARED GUARD on a swimmable shore. Shoal names one, round Sundering
   *   Head, because the Head's `plateau` edge is a 44-degree ramp rather than
   *   the "61-degree cliffs on every bearing" its own header claims, and 44 is
   *   a wall at the probes' LEGACY envelope and a walk at the REAL one. See
   *   `liquidGuards` in PlanetLiquid.js for the traced route.
   *
   * The count: 6,829 posts across the system before the swim pass, 2,150 after
   * - Cinder 819, Sallow 648, Shoal's guard 683 - and Shoal alone dropped from
   * 3,122 to 683.
   *
   * IT IS 1,467 STATIONS NOW, and the difference is not this rule: Shoal's
   * descriptor has since deleted its guard in favour of steepening the terrain
   * that made the guard necessary, so the walled shores are Cinder's lava and
   * Sallow's acid and nothing else. Each station is two colliders since the
   * plinth-and-cap change, so `census.liquid.barrierPosts` reads 1,638 on
   * Cinder against 819 stations - the two numbers are both published and they
   * are not the same number. @see the design block above POST_HALF
   *
   * A SOLID SURFACE AT THE LIQUID PLANE - the obvious reading of "make it
   * solid" - is still what the geometry refuses, and it is why the fence is a
   * fence. Fill a body from its bed up to its surface and a beach becomes a
   * ramp onto a dead-flat floor at the waterline: the player is not stopped at
   * the shore, they walk out onto the lava. Anything that stops a body at the
   * edge has to stand ABOVE it, which is a wall.
   *
   * ═══════════════════════════════════════════════════════════════════════
   *  HOW IT IS BUILT
   * ═══════════════════════════════════════════════════════════════════════
   * `liquidCellMask` marks every terrain cell whose ground sits below its
   * liquid surface plus `LIQUID_EDGE` - the SAME 0.6 m the probes use, so the
   * two agree by construction rather than by coincidence. `liquidShoreCells`
   * keeps the wet cells that touch dry ground; runs of them along a row are
   * merged into one box, which roughly halves the count on a diagonal shore.
   *
   * BOXES, not a second heightfield. A heightfield is solid from its surface
   * DOWN and `Physics._closestPoint` recovers anything under it by pushing
   * straight up, so a raised field at the waterline would launch the player on
   * top of its own parapet - the fence would be a staircase. A box projects to
   * its nearest face instead, which for a tall thin one is sideways: the player
   * is pushed back the way they came, which is what "stopped at the shore"
   * means.
   *
   * THE PARAPET SCALES WITH GRAVITY. `jumpVelocity` is 6.4 and the player's
   * gravity on a planet is `22 * (planet.gravity / 9.81)`, so the apex is
   * 0.93 m on Cinder and 5.6 m on a moon. A fixed 2 m wall would be a hurdle
   * on half of Phase 2's planets.
   */
  _buildLiquidBarrier(L) {
    const bed = this._bed;
    if (!bed || !L?.bodies?.length) return;
    const P = this.planet;
    const hazard = liquidHazard(L);
    const guards = liquidGuards(L);
    /* Built ONCE and closed over the guard list, because it is asked per
     * candidate post - 3,122 times on Shoal - and rebuilding (and
     * re-validating) the guards on each would be the whole cost of the pass. */
    const walled = liquidWallMask(L);

    const segments = liquidContour({ liquid: L, ...bed, sub: WALL_SUB });
    const runs = liquidWalls(segments);
    const mask = liquidCellMask({ liquid: L, ...bed });
    if (!runs.length) return;

    /* THE GROUND THE COLLIDER IS, not the ground the descriptor describes.
     *
     * `this.groundAt` is the analytic height field; `bed.heights` is the buffer
     * the collision heightfield was actually built from, and `liquidContour`
     * marches the waterline over exactly this interpolation. Sampling the buffer
     * keeps the wall, the contour and the surface the player stands on on one
     * set of numbers - and it is an array read rather than an fbm evaluation,
     * which matters at 32 samples on each of Shoal's 3,122 posts. */
    const bedAt = (x, z) => {
      const fx = (x - bed.originX) / bed.stepX;
      const fz = (z - bed.originZ) / bed.stepZ;
      const i = Math.max(0, Math.min(bed.nx - 2, Math.floor(fx)));
      const j = Math.max(0, Math.min(bed.nz - 2, Math.floor(fz)));
      const tx = Math.max(0, Math.min(1, fx - i));
      const tz = Math.max(0, Math.min(1, fz - j));
      const h = bed.heights;
      const a = h[j * bed.nx + i];
      const b = h[j * bed.nx + i + 1];
      const c = h[(j + 1) * bed.nx + i];
      const d = h[(j + 1) * bed.nx + i + 1];
      return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
    };

    /* THE CLEARANCE IS SIZED FROM THIS PLANET'S OWN RUNNING LEAP, and the
     * clearance is what makes the wall a gate rather than a hurdle. It is the
     * height above the ground A BODY STANDS ON, not above the water.
     * @see the design block on LEAP_LIFT at the top of this file
     * @see scripts/tests/planet-envelope.test.mjs SLOPE */
    const ratio = worldGravityRatio(P) ?? 1;
    /* `Player`'s closed form, with `Player`'s scaling: jumpVelocity scales as
     * `ratio^(1/3)` and gravity as `ratio`, so the apex goes as `ratio^(-1/3)`. */
    const apexStand = ((6.4 * 6.4) / (2 * 22)) * Math.pow(Math.max(1e-3, ratio), -1 / 3);
    const apexLeap = apexStand * LEAP_LIFT * LEAP_LIFT;
    /* THE TWO REACHES ADD. See the design block: the mantle is offered on the
     * jump press and measures its rise from the feet, so a body that jumps first
     * mantles a ledge one apex higher than a body that does not. */
    const clearance = apexLeap + MANTLE_MAX + GATE_MARGIN;
    const inset = POST_HALF - WALL_BIAS;

    /* `posts` counts COLLIDERS, not stations, and has to: `planet-liquid`
     * asserts the census against the tagged collider list, and a census that
     * counted stations while the physics held twice as many boxes would be a
     * number nobody could check. `stations` is the other one, reported beside
     * it so the two-member shape is visible from outside. */
    let posts = 0;
    let stations = 0;
    let tallest = 0;
    let clamped = 0;
    let minGate = Infinity;
    let shortestCap = Infinity;
    for (const run of runs) {
      /* Down past the ground the post stands on, so nothing steps under it,
       * and no further: on a cliff shore the bed is tens of metres down and an
       * unclamped post would be a column of invisible solid in open water. */
      const bottom = Math.max(run.surf - 40, Math.min(run.ground, run.surf) - 2.5);

      const n = Math.max(1, Math.ceil(run.len / POST_SPAN));
      for (let k = 0; k < n; k++) {
        /* Posts sit at the midpoints of `n` equal parts of the run, so the end
         * ones are half a span inside it and consecutive runs meet without a
         * post landing twice on the same join. */
        const t = (k + 0.5) / n - 0.5;
        const px = run.cx + run.ux * run.len * t + run.nx * inset;
        const pz = run.cz + run.uz * run.len * t + run.nz * inset;

        /* PER POST, not per run. A run is up to 14 m long and a guard has a
         * radius, so a run that straddles a guard's edge is half walled and
         * half open - and testing at the run's centre would round that to all
         * or nothing, which on Shoal's guard is up to 14 m of shore either
         * open when it should not be or fenced when the sea is swimmable. */
        if (!walled(px, pz)) continue;

        /* WHERE THE CAP STANDS, worked out before the bank is sampled because
         * the cap is the member whose top IS the gate, and the ground it has to
         * out-top is the ground around IT. The cap is flush with the plinth's
         * landward face, so its centre sits `POST_HALF - CAP_HALF` back along
         * the run's inward normal - 0.85 m further up the bank, where the
         * ground is higher. Sampling the ring at the plinth and hanging the cap
         * 0.85 m inland of it measured the gate in the wrong place and lost
         * 0.71 m of it on Cinder. */
        const back = POST_HALF - CAP_HALF;
        const cx = px - run.nx * back;
        const cz = pz - run.nz * back;

        /* THE LAUNCH PAD, per post rather than per run. `run.ground` is the
         * LOWEST ground the run spans AT THE CONTOUR, which is the right number
         * for the post's footing and the wrong one for its top: a 14 m run can
         * have a beach at one end and a bank two metres higher at the other, and
         * the leap comes off whichever is higher. */
        let bank = run.surf;
        for (let bi = 0; bi < LAND_BEARINGS; bi++) {
          const a = (bi / LAND_BEARINGS) * Math.PI * 2;
          const ca = Math.cos(a);
          const sa = Math.sin(a);
          for (const bk of LAND_PROBE) {
            const g = bedAt(cx + ca * bk, cz + sa * bk);
            if (Number.isFinite(g) && g > bank) bank = g;
          }
        }
        const stand = Math.max(run.surf, bank);
        const wanted = stand + clearance;
        const top = Math.min(wanted, run.surf + WALL_MAX);
        if (top < wanted - 1e-6) clamped++;
        if (!(top > bottom)) continue;
        const gate = top - stand;
        if (gate < minGate) minGate = gate;
        if (top - run.surf > tallest) tallest = top - run.surf;

        /* ── TWO MEMBERS PER STATION. See the design block at the top. ─────
         *
         * The plinth is the box this used to be, stopped at head height; the
         * cap carries the rest of the gate on a 0.50 m footprint flush with the
         * plinth's LANDWARD face, which is the face a climber meets.
         *
         * `capBase` is clamped so a cap is never shorter than `CAP_MIN_H` -
         * on a world whose gate clearance is small the plinth gives way, not
         * the cap, because the cap is the member the whole property rests on. */
        const capBase = Math.min(stand + PLINTH_HEAD, top - CAP_MIN_H);
        const plinthTop = Math.max(capBase, bottom + 0.5);
        const hy = (plinthTop - bottom) * 0.5;
        const cy = (plinthTop + bottom) * 0.5;
        this.track(this.physics.addBox(px, cy, pz, POST_HALF, hy, POST_HALF, {
          /* TAGGED, so an ablation can take the barrier out of a build without
           * rebuilding it. "The barrier costs N ore nodes" is a claim only a
           * flood with and without these boxes can make, and the first version
           * of it cost eleven of Verdigris's twenty malachite.
           * @see .probe/planet-flood.mjs
           *
           * `barrierCap` separates the member that carries the GATE from the
           * member that carries the THICKNESS. They are asserted on
           * differently and a test that measured the plinth's top against the
           * running leap would be measuring the wrong member.  */
          userData: { planetLiquidBarrier: true, barrierCap: false },
        }));
        posts++;

        const chy = (top - capBase) * 0.5;
        const ccy = (top + capBase) * 0.5;
        this.track(this.physics.addBox(cx, ccy, cz, CAP_HALF, chy, CAP_HALF, {
          userData: { planetLiquidBarrier: true, barrierCap: true },
        }));
        posts++;
        stations++;
        if (chy * 2 < shortestCap) shortestCap = chy * 2;
      }
    }

    this.census.colliders += posts;
    this.census.liquid = {
      kind: liquidKind(L),
      wetCells: mask.wetCount,
      cells: mask.cx * mask.cz,
      contourSegments: segments.length,
      barrierRuns: runs.length,
      barrierPosts: posts,
      /* `parapet` KEEPS ITS NAME AND CHANGES ITS MEANING, deliberately: it is
       * now the clearance over the ground a body leaps from rather than over the
       * water, which is the number that decides whether the wall holds. The two
       * extra rows are what the old single number hid - how far the wall stands
       * proud of the water at its tallest, and the WORST gate anywhere on it,
       * which is the one a test should assert on. */
      parapet: Number(clearance.toFixed(2)),
      /* THE SHAPE OF THE WALL, published because it is half of what makes it a
       * wall and nothing outside this file could otherwise see it. A top
       * deeper than `Climb`'s 0.77 m landing reach is a top a sustained free
       * climb can be hoisted onto, and the height then stops mattering.
       * @see the block above POST_HALF, and barrier-leap.test.mjs */
      barrierStations: stations,
      capDepth: Number((CAP_HALF * 2).toFixed(2)),
      plinthDepth: Number((POST_HALF * 2).toFixed(2)),
      shortestCap: Number.isFinite(shortestCap) ? Number(shortestCap.toFixed(2)) : null,
      leapApex: Number(apexLeap.toFixed(3)),
      tallestAboveWater: Number(tallest.toFixed(2)),
      worstGate: Number.isFinite(minGate) ? Number(minGate.toFixed(2)) : null,
      clampedPosts: clamped,
      /* `lethal` used to be reported here BECAUSE nothing read it - a false
       * nobody can see is how a flag stays dormant for another nine planets.
       * It is read now, by `Swim`, so what the census owes is the whole of what
       * the flag does: whether a body can be in this, what it costs per second
       * to be in it anyway, and how much of the shore is still walled. */
      lethal: hazard.lethal,
      substance: hazard.kind,
      swimmable: liquidSwimmable(L),
      hazardDps: hazard.dps,
      guards: guards.length,
      guardRadius: guards.map((g) => g.r),
    };
  }

  /**
   * THE EDGE OF THE PLAYFIELD, WHERE IT IS UNDER SWIMMABLE LIQUID.
   *
   * Shoal's sea is drawn as one disc 2,700 m across and the ground stops at
   * 440: MEASURED, 1,764 of 1,764 samples of the playfield boundary are under
   * water. Before this change that did not matter, because the shore fence
   * meant nobody could be in the water at all. Now a swimmer who strikes out
   * from the beach swims off the map - past the last terrain sample, over the
   * backstop floor, with `Swim` still finding a surface because the disc goes
   * on for another two kilometres.
   *
   * Four boxes, or as many as the wet stretches of the boundary merge into
   * (Verdigris's river mouth crosses it in one place and gets one). They are
   * AXIS-ALIGNED and they stand ON the boundary, so `boxIndex` in every reach
   * probe sees them exactly - the same reason the shore posts are square.
   *
   * This is the world's edge rather than the water's, so it goes up whether or
   * not the liquid is swimmable: wading off the end of Verdigris's gorge is the
   * same fall.
   */
  _buildEdgeWall(L) {
    const bed = this._bed;
    if (!bed || !L?.bodies?.length) return;
    const P = this.planet;
    const half = P.half;
    const ratio = worldGravityRatio(P) ?? 1;
    const apexStand = ((6.4 * 6.4) / (2 * 22)) * Math.pow(Math.max(1e-3, ratio), -1 / 3);
    const clearance = apexStand * LEAP_LIFT * LEAP_LIFT + MANTLE_MAX + GATE_MARGIN;
    const step = bed.stepZ;
    let boxes = 0;

    /* One pass per side. `axis` says which coordinate runs along the edge. */
    const sides = [
      { fx: (t) => -half, fz: (t) => t, alongX: false, sign: -1 },
      { fx: (t) => half, fz: (t) => t, alongX: false, sign: 1 },
      { fx: (t) => t, fz: (t) => -half, alongX: true, sign: -1 },
      { fx: (t) => t, fz: (t) => half, alongX: true, sign: 1 },
    ];
    for (const side of sides) {
      let runStart = null;
      let runSurf = -Infinity;
      let runGround = Infinity;
      const flush = (t0, t1) => {
        if (t1 <= t0) return;
        const mid = (t0 + t1) * 0.5;
        const halfLen = (t1 - t0) * 0.5 + step * 0.5;
        const top = runSurf + clearance;
        const bottom = Math.min(runGround, runSurf) - 2.5;
        if (!(top > bottom) || !Number.isFinite(top) || !Number.isFinite(bottom)) return;
        const cy = (top + bottom) * 0.5;
        const hy = (top - bottom) * 0.5;
        const cx = side.alongX ? mid : side.sign * half;
        const cz = side.alongX ? side.sign * half : mid;
        const hx = side.alongX ? halfLen : EDGE_HALF;
        const hz = side.alongX ? EDGE_HALF : halfLen;
        this.track(this.physics.addBox(cx, cy, cz, hx, hy, hz, {
          userData: { planetEdgeWall: true },
        }));
        boxes++;
      };
      for (let t = -half; t <= half + 1e-6; t += step) {
        const x = side.fx(t);
        const z = side.fz(t);
        const surf = liquidSurfaceAt(L, x, z);
        const g = this.groundAt(x, z);
        const wet = surf !== null && Number.isFinite(g) && g < surf;
        if (wet) {
          if (runStart === null) { runStart = t; runSurf = -Infinity; runGround = Infinity; }
          if (surf > runSurf) runSurf = surf;
          if (g < runGround) runGround = g;
        } else if (runStart !== null) {
          flush(runStart, t - step);
          runStart = null;
        }
      }
      if (runStart !== null) flush(runStart, half);
    }
    if (!boxes) return;
    this.census.colliders += boxes;
    this.census.edgeWall = boxes;
  }

  /** Every prop field the descriptor asks for. One draw call each. */
  _buildProps() {
    const P = this.planet;
    const rockMat = this._propMaterial();
    let seed = (P.terrain.seed ?? 1) ^ 0x7f4a;
    for (const spec of P.props) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const built = buildPropField(spec, {
        height: this.groundAt,
        half: P.half,
        slopeStep: this.cell,
        seed,
        liquid: P.liquid,
        landing: P.landing,
        material: rockMat,
        /* The authored ejecta block, or null. Read here rather than inside
         * `PlanetProps` so the prop file stays a pure function of its inputs
         * and the test can build a field both ways by handing this in. */
        authored: { boulders: blockGeometry() },
        physics: this.physics,
        group: this.group,
        track: (c) => this.track(c),
      });
      this._own(built.geo);
      /* A field with a `glow` builds its own material off the shared rock (see
       * `PlanetProps.buildPropField`); the shared one is already owned, so own
       * only the clone or the planet leaks one material per visit. */
      if (built.material !== rockMat) this._own(built.material);
      this.census.props[spec.id] = { placed: built.placed, requested: built.requested, colliders: built.colliders };
      this.census.colliders += built.colliders;
      this.census.drawCalls++;
      const idx = built.mesh.geometry.index;
      this.census.triangles += ((idx ? idx.count : built.mesh.geometry.attributes.position.count) / 3) * built.placed;

      // Vent fields get their steam. The plume field is driven off the same
      // points, so a vent without a plume is not expressible.
      if (spec.kind === 'vents' && built.points.length) {
        const plumes = buildPlumes(built.points, {
          perVent: 5,
          height: (spec.size?.plumeMax ?? 16),
          /* Grey-brown and thin. A near-white plume at 0.26 was the brightest
           * thing in the frame after the lava and the bloom pass turned each
           * puff into a hard white ball. Steam over ash is dirty. */
          color: P.hazards?.steamColor ?? 0x7d6a5e,
          opacity: 0.15,
        });
        this.group.add(plumes.mesh);
        this._plumes.push(plumes);
        this._own(plumes.geometry);
        this._own(plumes.material);
        this.census.drawCalls++;
      }
    }
  }

  /**
   * Shared rock material for every prop family. One clone, `vertexColors` on
   * for the per-instance tint.
   *
   * ── IT WAS `stone.castle`, AND THAT IS A CASTLE WALL ────────────────────
   *
   * `Materials.js` files `stone.castle` under `--- medieval ---` and
   * `shadeStoneCastle` is exactly what the name says: a 5 x 3 grid of DRESSED
   * ASHLAR BLOCKS with mortar joints, chamfered arrises, tool marks and
   * LICHEN. Every prop on every planet drew with it - 15,700 instances of
   * boulder, spire, slab, shard, column and vent across ten worlds, including
   * an ice moon, a salt pan and a lava field, all of them wearing masonry
   * courses and green lichen.
   *
   * It was invisible for the same reason the belt's squared albedo was: at
   * the distance the preset framings photograph a prop it is a few pixels,
   * and the polyhedron's spherical UVs stretched the coursing into vagueness.
   * It became unmissable the moment this pass gave the authored block honest
   * per-face UVs - the first shot came out looking like a paved terrace, and
   * the mortar lines were the tell. That screenshot is in the design doc; it
   * is the one place in this pass where a change made a thing look WORSE and
   * the worse picture was the diagnosis.
   *
   * `rock.neutral` is the fix and it is not a new idea - `Materials.js` files
   * it under `--- planet ground ---`, nine of the ten planets already use it
   * for their TERRAIN, and its own comment calls it "an honest description of
   * regolith, volcanic ash, iron hardpan, salt crust, a drained sea bed and
   * crystalline gravel alike". Identical build options to `dirt.ground`; the
   * only difference is that its albedo is hue-free, which is what lets each
   * planet's own `palette` and the per-instance tint carry the colour instead
   * of being filtered through somebody else's brown.
   *
   * ── THE REPEAT IS 1.4 AND STAYS 1.4 ────────────────────────────────────
   *
   * Deliberately unchanged. The library keys its cache on `key:repeat`, so
   * moving it would be a second variable in the same measurement; and 1.4 over
   * a prop's own UV span is a texel density that was tuned against these
   * shapes. What changed here is WHICH SURFACE, not how big it is.
   */
  _propMaterial() {
    if (this._propMat) return this._propMat;
    const m = this.materials.get('rock.neutral:1.4').clone();
    m.name = `planet.${this.planet.id}.rock`;
    m.vertexColors = true;
    m.color = new THREE.Color(0xffffff);
    this._own(m);
    this._propMat = m;
    return m;
  }

  /**
   * Mineral deposits.
   *
   * Each node is a small cluster of faceted crystals, instanced per mineral
   * type. They do NOT collide: a node is 1.3 m across and the player has to be
   * able to stand on it to work it. A box collider on a thing you are meant to
   * walk up to is the same defect as a door you cannot enter, one size smaller.
   *
   * ── HOW BIG A NODE LOOKS IS NOT HOW MUCH HOLD IT TAKES ──────────────────
   *
   * It used to be. `spec.size` drove BOTH `holdUnitsFor` and the crystal
   * scale, and the descriptor's own value gradient makes the rare ores the
   * SMALL ones - that is the whole point of them, a cubic metre of iridite is
   * 310 credits where three of tephra are 18. So the most valuable object on
   * the planet was also the least visible: iridite's main crystal came out at
   * `0.62 * 0.55 = 0.34 m`, a pebble, and a tester who flew 62 km and
   * descended to get one wrote that "iridite - the rarest element, the payoff
   * for a 60 km flight and a descent - is a plain grey-brown truncated cone.
   * A lampshade, the same colour as the ground, no glow, no glint, no aura."
   *
   * Rarity is now inversely coupled to hold cost and DIRECTLY coupled to
   * presence, which is the way round a player can act on: a rare seam is a
   * bigger, taller, brighter thing standing in the rock that happens to stow
   * small. `size` is untouched, so every hold, price and load figure in
   * `planet-minerals.test.mjs` and `SpaceObjectives` is exactly what it was.
   */
  _buildMinerals() {
    const P = this.planet;
    let seed = (P.terrain.seed ?? 1) ^ 0x1d0e;
    for (const spec of P.minerals) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const res = scatter({
        region: spec.region,
        count: spec.count,
        spacing: spec.spacing ?? 0,
        seed,
        height: this.groundAt,
        half: P.half,
        slopeStep: this.cell,
        liquid: P.liquid,
        landing: P.landing,
      });

      /* ONE GEOMETRY PER SEAM, and it is a crystal rather than a lump.
       * @see oreCrystal, and ORE_HABIT for why the habit follows the tier. */
      const geo = oreCrystal(spec.rarity, seed);
      geo.name = `planet.mineral.${spec.id}.crystal`;
      this._own(geo);
      const mat = new THREE.MeshStandardMaterial({
        name: `planet.mineral.${spec.id}`,
        color: oreAlbedo(spec.color),
        emissive: new THREE.Color(spec.glow || 0x000000),
        /* 1.6 -> 3.2 on anything that declares a glow. `GRADE_PRESETS`
         * thresholds bloom on scene-linear luminance, and at 1.6 against a
         * daylit ash plain the emissive was inside the diffuse and the ore
         * did not read as lit at all - which is what "no glow, no glint, no
         * aura" describes. Only the two rare tiers declare `glow`, so this
         * lights exactly the ore the value gradient wants found.
         *
         * ── THAT LAST SENTENCE IS NOT TRUE OF THE SHIPPED DESCRIPTORS ──────
         * Cinder alone declares `glow` on four of six: sulfur (`0x201a04`) and
         * obsidian (`0x2a1038`) as well as iridite and rheniite. So this branch
         * fires on a common ore and an uncommon one too. MEASURED before acting
         * on it (`.probe/mineral-sweep.mjs`): turning sulfur's emissive off
         * moves its facet spread from x1.22 to x1.23 - nothing - so the flat
         * sulfur node was never this line's doing, and it is left alone.
         * Obsidian is the reason it MUST be left alone: its swatch is
         * near-black and its emissive is what carries its colour, so killing it
         * drops obsidian's measured saturation from 0.65 to 0.28.
         * @see ORE_ALBEDO_CEIL for what the flat node actually was. */
        /* 1.6 -> 2.2. At 1.6, against a daylit ash plain, the emissive sat
         * inside the diffuse and the ore did not read as lit at all - which
         * is what "no glow, no glint, no aura" describes. 3.2 was the first
         * try and overshot: driven in a browser, both rare ores saturated to
         * the same cream and iridite's orange and rheniite's cold teal became
         * indistinguishable at arm's length, which throws away the legibility
         * decision `Volcanic.js` records beside rheniite's own colour. 2.2 is
         * the value at which each keeps its hue and still glows. */
        emissiveIntensity: spec.glow ? 2.2 : 0,
        roughness: spec.glow ? 0.28 : 0.66,
        metalness: 0.15,
        flatShading: true,
      });
      this._own(mat);

      /* HOW BIG IT LOOKS. See the note on this method.
       *
       * A multiplier on the DRAWN scale only. Ordered by `MINERAL_RARITY`, so
       * a descriptor that adds a tier gets a sensible default rather than a
       * silent 1.0.
       *
       * 1.0 to 1.9: enough that a tephra nodule and an iridite seam are
       * different objects at fifty metres, and not so much that the ore
       * becomes scenery. The first try ran to 2.6 and put 1.5 m crystals on
       * a rheniite FLAKE - driven in a browser, one node filled the frame
       * from three metres. At 1.9 iridite's main crystal is 0.65 m against
       * the 0.34 m it was, which is the difference between a pebble you walk
       * past and a seam you walk to. */
      const SHOW = { common: 1.0, uncommon: 1.2, rare: 1.5, exotic: 1.9 };
      const show = spec.size * (SHOW[spec.rarity] ?? 1.0);
      /* The same row `oreCrystal` built the geometry from, for the aspect
       * ratio: a habit that is a squat prism in the mesh and a tall one in the
       * instance matrix is two different decisions about one object. */
      const habit = ORE_HABIT[spec.rarity] ?? ORE_HABIT.common;

      // Four crystals per node, so a deposit is a cluster and not a pebble.
      const PER = 4;
      const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, res.points.length * PER));
      mesh.name = `planet:mineral:${spec.id}`;
      mesh.count = res.points.length * PER;
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      let k = 0;
      for (const pt of res.points) {
        const roll = pt.rnd;
        const credits = Math.round(spec.credits[0] + roll * (spec.credits[1] - spec.credits[0]));
        this.mineralNodes.push({
          id: `${spec.id}_${this.mineralNodes.length}`,
          type: spec.id,
          name: spec.name,
          position: new THREE.Vector3(pt.x, pt.y, pt.z),
          credits,
          size: spec.size,
          /* WHERE THIS NODE'S CRYSTALS LIVE IN THE INSTANCED DRAW.
           *
           * Published because a node that is mined has to STOP BEING DRAWN, and
           * a consumer holding only a world position has no way to reach four
           * matrices inside an `InstancedMesh` without re-deriving the packing
           * order from this loop - which is the kind of duplicated arithmetic
           * that silently goes wrong the day `PER` changes. `mesh` is the live
           * object and `slot`/`slotCount` are its index range.
           * @see systems/Mining.js */
          mesh,
          slot: k,
          slotCount: PER,
        });
        /* ── FOUR CRYSTALS, SPLAYED, AND NO TWO OF THEM ALIKE ──────────────
         *
         * The instance matrix is where the variety has to come from: the
         * geometry is shared by every node of the seam, so a per-instance yaw,
         * an independent width on each horizontal axis and an outward LEAN are
         * the three things that stop a cluster reading as one object stamped
         * four times.
         *
         * The lean is the part that makes it a druse rather than a bundle:
         * satellites tip AWAY from the node's centre, about the horizontal
         * axis perpendicular to their own offset, which is how crystals that
         * nucleated on one seam actually grow. The rotation that takes +Y
         * toward the outward direction `d` is about `Y x d`; the yaw is applied
         * first, in the crystal's own frame, so the lean does not undo it.
         *
         * The scale envelope is deliberately the one the icosahedron had -
         * width `sc`, full height `sc * 2.2..4.0` - so this changes the SHAPE
         * of a node and not its size, and every framing, reach probe and
         * screenshot distance that was tuned against the old one still holds.
         * `bury` takes a tenth of the height below the ground for the same
         * reason the foot is at the geometry's origin. */
        for (let c = 0; c < PER; c++) {
          const a = (roll * (7 + c * 13.7)) % 1;
          const b = (roll * (31 + c * 5.1)) % 1;
          const ang = (c / PER) * Math.PI * 2 + roll * 6.28;
          const off = c === 0 ? 0 : show * (0.35 + a * 0.5);
          const sc = show * (c === 0 ? 0.55 : 0.24 + b * 0.24);
          const hgt = sc * (habit.tall[0] + a * habit.tall[1]);
          /* The head crystal stands nearly upright; the satellites splay. */
          const lean = c === 0 ? 0.03 + a * 0.10 : 0.22 + b * 0.34;
          _v.set(Math.sin(ang), 0, -Math.cos(ang));
          _q.setFromAxisAngle(_v, lean);
          _e.set(0, b * 6.28, 0);
          _q.multiply(_qB.setFromEuler(_e));
          _v.set(pt.x + Math.cos(ang) * off, pt.y - hgt * 0.10, pt.z + Math.sin(ang) * off);
          _s.set(sc * (0.82 + a * 0.36), hgt, sc * (0.82 + b * 0.36));
          _m4.compose(_v, _q, _s);
          mesh.setMatrixAt(k++, _m4);
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
      this.census.drawCalls++;
      /* ASKED OF THE GEOMETRY, not retyped. The hard-coded 20 was the
       * icosahedron's face count and would have gone on reporting 20 for ever
       * after the crystal replaced it - a census that describes the build it
       * used to be is worse than no census. */
      this.census.triangles += (geo.getAttribute('position').count / 3) * k;
      this.census.minerals[spec.id] = { placed: res.points.length, requested: res.requested, rejects: res.rejects };
    }
  }

  /**
   * Landing sites.
   *
   * A ring on the ground, four corner markers and the published record. The
   * FLATNESS is not created here - it is created by the `pad` landform in the
   * height field, which `definePlanet` refuses to let a site exist without.
   * This is only the paint that says "here".
   */
  _buildLandingSites() {
    const P = this.planet;
    const g = new THREE.Group();
    g.name = `planet:${P.id}:landing`;
    this.group.add(g);

    /**
     * THE OUTER RING IS PAINT, AND THE INNER ONE IS THE ONLY LIGHT.
     *
     * It was one material, emissive `0x64d8ff` at 0.45, on both rings. 0.45 was
     * already a retreat from 1.5 and it was not far enough: from 190 m up the
     * two pad rings were the ONLY high-chroma objects on the whole planet -
     * whole-frame max 112, and most of that was them - and at eye level the
     * outer ring was the dominant object in shot with a visibly stair-stepped
     * inner edge. A cyan doughnut is also the wrong colour for a volcanic
     * world: it belongs to no palette this planet has.
     *
     * So there are two materials now. The outer ring is a light VALUE in the
     * world's own family - a lime-washed circle on ash, which is what a real
     * pad marking is - with no emissive at all, and it reads because it is
     * paler than the ground rather than because it glows. The inner ring keeps
     * an emissive, in the planet's amber rather than in cyan, because
     * something on a pad has to be findable at night and it is 4 m across
     * instead of 34.
     */
    const ringMat = new THREE.MeshStandardMaterial({
      name: `planet.${P.id}.padmark`,
      color: 0xb9a893,
      roughness: 0.82,
    });
    const innerMat = new THREE.MeshStandardMaterial({
      name: `planet.${P.id}.padmark.inner`,
      color: 0x140d09,
      emissive: new THREE.Color(0xffb060),
      emissiveIntensity: 0.5,
      roughness: 0.5,
    });
    const postMat = this.materials.get('metal.trim').clone();
    postMat.name = `planet.${P.id}.padpost`;
    /**
     * THE EDGE MARKING, and why a pad needs one at all.
     *
     * Measured across all ten planets: seven of them have a pad you can walk
     * off and never walk back onto. Cinder's Rimhold Shelf floods 13,000 m2 on
     * foot and a body that steps off it can end up anywhere on 468,000 m2, of
     * which 97.3% cannot walk back. That isolation is DESIGN - it is what makes
     * the exotic seam cost a second landing, and `planet-reach` asserts it - but
     * nothing on the ground said so. A player who lands on a 20 m disc notched
     * into a crater rim and walks north sees ash, then more ash, then a slope,
     * and finds out what they have done forty seconds later.
     *
     * ── THE RING MEANS ONE THING, AND IT IS NOT "CLIFF" ─────────────────
     * The first version of this painted the bearings `_padDrop` found a cliff
     * on, which is a different question and measured a different set of pads:
     * Ray's Edge wore 300 degrees of hazard block and is 98.2% returnable,
     * while the Crown wore none and is 6.7%. So the blocks are driven by
     * `_padReturn` now - a flood over the real collision bed - and they go on
     * as a COMPLETE ring or not at all, because the measurement that separates
     * these pads is a property of the pad rather than of a compass point.
     *
     * A ring says: most of the ground you can reach on foot from this disc
     * cannot walk back to it. Amber-black hazard blocks, the same language a
     * lift shaft and a pier edge use elsewhere in this project and the only one
     * available on a wilderness pad with no signage system anywhere near it. No
     * collider - the marking says what leaving costs, it does not stop you.
     *
     * The cliff number is not lost and is not painted: `drop` is still
     * published, and `Piloting` puts it on the flight HUD on final approach,
     * which is where "is that a shelf" is the question being asked.
     */
    const edgeMat = new THREE.MeshStandardMaterial({
      name: `planet.${P.id}.padedge`,
      color: 0xd8912a,
      emissive: new THREE.Color(0xff7a12),
      emissiveIntensity: 0.35,
      roughness: 0.62,
    });
    this._own(ringMat);
    this._own(innerMat);
    this._own(postMat);
    this._own(edgeMat);

    /* ONE lattice for the whole world, flooded twice per pad. @see _padReturn */
    const homeward = this._padReturn();

    for (const s of P.landing) {
      const y = this.groundAt(s.x, s.z);
      const ring = new THREE.Mesh(new THREE.RingGeometry(s.r - 1.4, s.r, 64), ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(s.x, y + 0.06, s.z);
      this._own(ring.geometry);
      g.add(ring);
      this.census.drawCalls++;

      const drop = this._padDrop(s, y);
      const back = homeward.get(s.id) ?? { oneWay: false, pct: 100, metres: 0, area: 0 };
      if (back.oneWay) {
        const blockGeo = new THREE.BoxGeometry(1.6, 0.34, 0.9);
        this._own(blockGeo);
        const blocks = new THREE.InstancedMesh(blockGeo, edgeMat, RIM_BLOCKS);
        blocks.name = `planet:${P.id}:padedge:${s.id}`;
        for (let i = 0; i < RIM_BLOCKS; i++) {
          const a = (i / RIM_BLOCKS) * Math.PI * 2;
          const bx = s.x + Math.cos(a) * (s.r - 0.7);
          const bz = s.z + Math.sin(a) * (s.r - 0.7);
          _e.set(0, -a, 0);
          _q.setFromEuler(_e);
          _v.set(bx, this.groundAt(bx, bz) + 0.17, bz);
          _s.set(1, 1, 1);
          _m4.compose(_v, _q, _s);
          blocks.setMatrixAt(i, _m4);
        }
        blocks.instanceMatrix.needsUpdate = true;
        blocks.computeBoundingSphere();
        g.add(blocks);
        this.census.drawCalls++;
        this.census.triangles += 12 * RIM_BLOCKS;
      }

      const inner = new THREE.Mesh(new THREE.RingGeometry(s.r * 0.32, s.r * 0.32 + 0.9, 48), innerMat);
      inner.rotation.x = -Math.PI / 2;
      inner.position.set(s.x, y + 0.06, s.z);
      this._own(inner.geometry);
      g.add(inner);
      this.census.drawCalls++;

      /* Four mooring posts, on the pad's own radius so they never stand in the
       * ship's way. Real colliders: they are 2.4 m of steel and a player who
       * walks through one has been told the world is not solid. */
      const postGeo = new THREE.BoxGeometry(0.5, 2.4, 0.5);
      this._own(postGeo);
      const posts = new THREE.InstancedMesh(postGeo, postMat, 4);
      posts.castShadow = true;
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        const px = s.x + Math.cos(a) * (s.r - 1.0);
        const pz = s.z + Math.sin(a) * (s.r - 1.0);
        const py = this.groundAt(px, pz);
        _m4.makeTranslation(px, py + 1.2, pz);
        posts.setMatrixAt(i, _m4);
        this.track(this.physics.addBox(px, py + 1.2, pz, 0.25, 1.2, 0.25));
        this.census.colliders++;
      }
      posts.instanceMatrix.needsUpdate = true;
      posts.computeBoundingSphere();
      g.add(posts);
      this.census.drawCalls++;

      this.landingSites.push({
        id: s.id,
        name: s.name,
        position: new THREE.Vector3(s.x, y, s.z),
        radius: s.r,
        yaw: s.yaw ?? 0,
        primary: !!s.primary,
        /* PUBLISHED, so a HUD, a test or a rescue can ask how exposed a pad is
         * without re-deriving it from the height field. `deg` is how much of the
         * horizon around the disc falls away, `metres` how far it falls. Read by
         * `Piloting._readout` and `SpaceObjectives`; this is the CLIFF, and it
         * is a pilot's question. @see _padDrop */
        drop: { deg: drop.deg, metres: Number(drop.worst.toFixed(1)) },
        /* And this is the WALKER's question, which is a different one and
         * measures a different set of pads. `oneWay` is what the rim ring is
         * painted from. @see _padReturn */
        home: {
          oneWay: !!back.oneWay,
          pct: Number(back.pct.toFixed(1)),
          metres: Number(back.metres.toFixed(1)),
          area: back.area,
        },
      });
      this.census.pads = this.census.pads ?? {};
      this.census.pads[s.id] = {
        deg: drop.deg,
        metres: Number(drop.worst.toFixed(1)),
        returnPct: Number(back.pct.toFixed(1)),
        oneWay: !!back.oneWay,
      };
    }
  }

  /**
   * HOW MUCH OF THE HORIZON AROUND A PAD FALLS AWAY, and by how far.
   *
   * Marched over the height field the player stands on, not over the
   * descriptor's intentions: 48 bearings, each stepped out to `REACH` metres
   * past the disc, keeping the lowest ground it finds. A bearing counts as a
   * drop when the ground falls more than `SILL` below the pad within that
   * distance - deeper than any authored ramp grade would take it, so a road
   * leaving the pad is not reported as a cliff.
   *
   * `SILL` is 8 m: over the 6.3 m a fall starts costing health, and well over
   * the 3 m the reach probes allow a walk to descend, so a bearing that trips it
   * is a bearing you cannot simply walk back up.
   *
   * @param {{x:number,z:number,r:number}} s the descriptor's landing record
   * @param {number} padY the pad's own height
   */
  _padDrop(s, padY) {
    const BEARINGS = 48;
    const REACH = 46;
    const STEP = 4;
    const SILL = 8;
    const bearings = [];
    let worst = 0;
    for (let i = 0; i < BEARINGS; i++) {
      const a = (i / BEARINGS) * Math.PI * 2;
      let low = padY;
      for (let d = s.r + 2; d <= s.r + REACH; d += STEP) {
        const g = this.groundAt(s.x + Math.cos(a) * d, s.z + Math.sin(a) * d);
        if (Number.isFinite(g) && g < low) low = g;
      }
      const fall = padY - low;
      if (fall > worst) worst = fall;
      if (fall > SILL) bearings.push(a);
    }
    return { bearings, worst, deg: Math.round((bearings.length / BEARINGS) * 360) };
  }

  /**
   * CAN A BODY WALK BACK TO ITS SHIP? One answer per pad, over the real bed.
   *
   * @see the design block on `RETURN_ONE_WAY` for why this exists alongside
   * `_padDrop` rather than replacing it, and why the verdict is per PAD and not
   * per bearing.
   *
   * Run once for the whole world: the lattice is the expensive part and every
   * pad floods the same one. Measured headless, the whole method costs 27-58 ms
   * on a planet whose terrain job alone costs 140-440 ms.
   *
   * @returns {Map<string, {oneWay:boolean, pct:number, metres:number, area:number}>}
   */
  _padReturn() {
    const out = new Map();
    const P = this.planet;
    const bed = this._bed;
    const sites = P.landing ?? [];
    if (!bed || !sites.length) return out;

    const { heights, nx, nz, originX, originZ, stepX, stepZ } = bed;
    /* The bed is square by construction (`_buildTerrain` builds it from one
     * `seg`), and the rise a walk absorbs over one step is derived from the
     * pitch rather than typed - at 3.1 m a 38 degree slope is 2.4 m of rise and
     * at 2 m it is 1.6, and a constant that did not know which would be wrong
     * the moment a descriptor changed `seg`. */
    const pitch = stepX;
    const maxRise = Math.max(RETURN_STEP_UP, pitch * RETURN_SLOPE_TAN);
    const N = nx * nz;

    /* ---- 1. WHAT A BODY MAY STAND ON -------------------------------- */
    const dry = new Uint8Array(N);
    const ok = new Uint8Array(N);
    const mask = liquidCellMask({ liquid: P.liquid, heights, nx, nz, originX, originZ, stepX, stepZ });
    /** A node is wet when any of the up-to-four cells around it is. */
    const wetNode = (i, j) => {
      for (let cj = j - 1; cj <= j; cj++) {
        if (cj < 0 || cj >= mask.cz) continue;
        for (let ci = i - 1; ci <= i; ci++) {
          if (ci < 0 || ci >= mask.cx) continue;
          if (mask.wet[cj * mask.cx + ci]) return true;
        }
      }
      return false;
    };
    const blocked = this._solidIndex();
    /* The border ring is left out: a central difference needs a neighbour on
     * both sides, and the outermost samples are the rim the world falls off
     * anyway. */
    for (let j = 1; j < nz - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const k = j * nx + i;
        const g = heights[k];
        if (!Number.isFinite(g)) continue;
        if (mask.wetCount && wetNode(i, j)) continue;
        dry[k] = 1;
        const dx = (heights[k + 1] - heights[k - 1]) / (2 * pitch);
        const dz = (heights[k + nx] - heights[k - nx]) / (2 * pitch);
        if (Math.hypot(dx, dz) > RETURN_SLOPE_TAN) continue;
        if (blocked(originX + i * stepX, originZ + j * stepZ, g)) continue;
        ok[k] = 1;
      }
    }

    /* ---- 2. TWO FLOODS PER PAD -------------------------------------- */
    const seen = new Uint8Array(N);
    const home = new Uint8Array(N);
    /* Every node is marked before it is pushed, so the stack can never hold
     * more than one entry per node and this is exactly big enough. */
    const stack = new Int32Array(N);
    const flood = (visit, seed, edge) => {
      visit[seed] = 1;
      let top = 0;
      stack[top++] = seed;
      while (top > 0) {
        const k = stack[--top];
        const i = k % nx;
        const j = (k - i) / nx;
        const here = heights[k];
        for (let d = 0; d < 4; d++) {
          const a = i + (d === 0 ? 1 : d === 1 ? -1 : 0);
          const b = j + (d === 2 ? 1 : d === 3 ? -1 : 0);
          if (a < 1 || b < 1 || a >= nx - 1 || b >= nz - 1) continue;
          const m = b * nx + a;
          if (visit[m]) continue;
          if (!edge(here, m)) continue;
          visit[m] = 1;
          stack[top++] = m;
        }
      }
    };

    const area = pitch * pitch;
    for (const s of sites) {
      const si = Math.round((s.x - originX) / stepX);
      const sj = Math.round((s.z - originZ) / stepZ);
      const seed = sj * nx + si;
      if (si < 1 || sj < 1 || si >= nx - 1 || sj >= nz - 1 || !ok[seed]) {
        /* A pad whose own centre sample is not standable is a pad this
         * instrument cannot speak about - a disc notched into a face, or one
         * standing in liquid. Silence, and say so, rather than a ring nobody
         * can account for. */
        out.set(s.id, { oneWay: false, pct: 100, metres: 0, area: 0, unmeasured: true });
        continue;
      }
      const padY = heights[seed];
      seen.fill(0);
      home.fill(0);
      /* WHERE A BODY CAN END UP. Downhill is always available, over any face:
       * that is what stepping off a shelf is, and it is the edge a forward walk
       * flood does not have. Uphill only where a walk could take it. */
      flood(seen, seed, (here, m) => {
        if (!dry[m]) return false;
        const d = heights[m] - here;
        if (d <= 0) return true;
        return !!ok[m] && d <= maxRise;
      });
      /* WHERE A WALK RETURNS FROM: expand u -> v when the FORWARD step v -> u
       * is legal, which is the reverse graph and not the same graph. */
      flood(home, seed, (here, m) => {
        if (!ok[m]) return false;
        const d = here - heights[m];
        return d <= maxRise && d >= -RETURN_DROP_MAX;
      });

      let total = 0;
      let back = 0;
      let worst = 0;
      for (let k = 0; k < N; k++) {
        if (!seen[k] || !ok[k]) continue;
        total++;
        if (home[k]) continue;
        const fall = padY - heights[k];
        if (fall > worst) worst = fall;
      }
      for (let k = 0; k < N; k++) if (seen[k] && ok[k] && home[k]) back++;
      const pct = total ? (100 * back) / total : 100;
      out.set(s.id, {
        oneWay: pct < RETURN_ONE_WAY,
        pct,
        metres: worst,
        area: Math.round(total * area),
      });
    }
    return out;
  }

  /**
   * EVERY SOLID BOX IN THE WORLD, ON AN XZ GRID, so the return flood can see a
   * boulder standing in a gap.
   *
   * It is not optional detail. Carnelian's Kiln Deck measures 49.8% returnable
   * WITH the props in and 98.7% with them out: what pens that pad in is the
   * talus scatter round it rather than the shape of the ground, and an
   * instrument that only read the height field would have called it open.
   *
   * Each collider is read by its AXIS-ALIGNED bounds, the way
   * `Unstuck._boxIndex` and `planet-reach` read theirs. A rotated box is
   * therefore over-estimated - which can only make a pad read as MORE penned in
   * than it is, and over-warning is the safe direction for a warning.
   *
   * The build runs against a scratch `Physics` per world (`WorldManager._runBuild`),
   * so this sees this planet's colliders and nothing else.
   */
  _solidIndex() {
    const cell = 8;
    const grid = new Map();
    const list = this.physics?.colliders ?? [];
    for (const c of list) {
      if (!c.solid || c.type !== 'box') continue;
      if (((c.layer ?? COLLISION_LAYER.WORLD) & COLLISION_LAYER.WORLD) === 0) continue;
      const m = c.matrix.elements;
      const b = {
        x: m[12], y: m[13], z: m[14],
        ax: Math.abs(m[0]) * c.halfExtents.x + Math.abs(m[4]) * c.halfExtents.y + Math.abs(m[8]) * c.halfExtents.z,
        ay: Math.abs(m[1]) * c.halfExtents.x + Math.abs(m[5]) * c.halfExtents.y + Math.abs(m[9]) * c.halfExtents.z,
        az: Math.abs(m[2]) * c.halfExtents.x + Math.abs(m[6]) * c.halfExtents.y + Math.abs(m[10]) * c.halfExtents.z,
      };
      if (!Number.isFinite(b.x) || !Number.isFinite(b.z) || !Number.isFinite(b.ax) || !Number.isFinite(b.az)) continue;
      const x0 = Math.floor((b.x - b.ax) / cell);
      const x1 = Math.floor((b.x + b.ax) / cell);
      const z0 = Math.floor((b.z - b.az) / cell);
      const z1 = Math.floor((b.z + b.az) / cell);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const k = ((cx + 4096) << 13) | (cz + 4096);
          let bucket = grid.get(k);
          if (!bucket) grid.set(k, (bucket = []));
          bucket.push(b);
        }
      }
    }
    return (x, z, groundY) => {
      const k = ((Math.floor(x / cell) + 4096) << 13) | (Math.floor(z / cell) + 4096);
      const bucket = grid.get(k);
      if (!bucket) return false;
      for (let i = 0; i < bucket.length; i++) {
        const b = bucket[i];
        if (Math.abs(x - b.x) > b.ax || Math.abs(z - b.z) > b.az) continue;
        // Under the foot, or over the head: neither is in the way.
        if (b.y + b.ay <= groundY + RETURN_STEP_UP) continue;
        if (b.y - b.ay >= groundY + RETURN_HEADROOM) continue;
        return true;
      }
      return false;
    };
  }

  /** Ash in the air. One `Points`, wrapped around the camera in the shader. */
  _buildAtmosphere() {
    const h = this.planet.hazards ?? {};
    const density = h.ashfall?.density ?? 0;
    if (density <= 0) return;
    const BOX = 220;
    const COUNT = Math.round(1800 * density);
    const pos = new Float32Array(COUNT * 3);
    const seedA = new Float32Array(COUNT);
    let s = 0x3f19 >>> 0;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < COUNT; i++) {
      pos[i * 3] = rnd() * BOX;
      pos[i * 3 + 1] = rnd() * BOX;
      pos[i * 3 + 2] = rnd() * BOX;
      seedA[i] = rnd();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seedA, 1));
    const mat = new THREE.ShaderMaterial({
      name: 'planet.ash',
      uniforms: {
        uTime: { value: 0 },
        uEye: { value: new THREE.Vector3() },
        uBox: { value: BOX },
        uDrift: { value: new THREE.Vector2(...(h.ashfall?.drift ?? [0.5, 0])) },
        uSize: { value: 1.4 },
        uColor: { value: new THREE.Color(h.ashColor ?? 0x8a7466) },
        uOpacity: { value: 0.5 },
      },
      vertexShader: ASH_VERT,
      fragmentShader: ASH_FRAG,
      transparent: true,
      depthWrite: false,
    });
    const pts = new THREE.Points(geo, mat);
    pts.name = 'planet:ash';
    pts.frustumCulled = false;
    pts.renderOrder = 9;
    this.group.add(pts);
    this._own(geo);
    this._own(mat);
    this._ash = mat;
    this.census.drawCalls++;
  }

  /**
   * THE WEATHER, MADE INTO A RULE.
   *
   * `planets/PlanetHazard.js` decides WHETHER this planet has a live hazard and
   * WHAT its numbers are, purely from the descriptor - no planet is named there
   * and none is named here. This method's whole job is to hand that module the
   * three things only a built world knows (the collision ground, the liquid
   * surface, the terrain's own floor and ceiling), publish the sampler, and
   * draw the tell.
   *
   * ── WHAT `hazardField` IS AND WHO READS IT ──────────────────────────────
   * The same arrangement `liquidField` has, deliberately: the WORLD answers for
   * its own weather and a player-side system asks. The published shape is
   *
   *   `{ id, kind, name, cause, peak: {dps, push, stamina},
   *      at(x, y, z, out) -> { intensity, dps, pushX, pushZ, stamina } }`
   *
   * `at` writes into a caller-owned record and allocates nothing, because it is
   * a fixed-step read.
   *
   * ── WHO CHARGES IT AGAINST THE BODY ────────────────────────────────────
   * `Swim.tickHazard`, called from `Player.fixedUpdate` ABOVE the death, mount
   * and climb branches. The call site matters and was measured: `Swim`'s own
   * `fixedUpdate` is never reached from the mantle or free-climb branch, and
   * thin air is exactly the hazard a CLIMBING body is in — charging it from
   * there would have left Cathedra's summit free while you climbed to it.
   *
   * The push does NOT go through `Player.applyImpulse`, and that is a measured
   * result rather than a preference. `_applyFriction` is Source-style: below
   * `STOP_SPEED` it is a CONSTANT deceleration (11 m/s², or 2.42 once the
   * impulse stagger cuts friction to 22%) against 0.854 m/s² of wind, so an
   * impulse per step settles at 0.0000 m/s of drift — and scaling it up is
   * bimodal, not gradual, because friction's floor is a step and not a slope
   * (x10 measures 3.74 m/s, 81% of walkSpeed, which breaks the guarantee that
   * a player can always walk upwind). `applyImpulse` also re-arms
   * `IMPULSE_STAGGER` on every call, which would have pinned Sirocco at
   * permanently reduced friction.
   *
   * So wind is a MOVING MEDIUM: `Player.setEnvironmentDrift` adds it to the
   * displacement `_move` integrates — swept, capsule-resolved, step-probed —
   * never to `_velocity`. Measured on the built planet: 0.8538 m/s of drift,
   * upwind walking nets 3.7462 m/s, dead upwind escape 10.7 s.
   */
  _buildHazardField() {
    const P = this.planet;
    const spec = hazardSpec(P);
    this.hazardField = null;
    this._hazardSpec = spec;
    if (!spec) return;

    const field = this._terrainField;
    const sampler = makeHazardSampler(spec, {
      /* The COLLISION field, for the same reason a viewpoint's y comes off it:
       * a hazard that decides whether you are in the lee of a dune has to ask
       * the dune the player is standing on, not the one the descriptor
       * describes. Null outside the footprint, which every branch handles. */
      groundAt: (x, z) => (field ? field.sampleHeight(x, z) : null),
      liquidSurfaceAt: this.liquidField ? this.liquidField.surfaceAt : null,
      minY: Number.isFinite(this._terrainMinY) ? this._terrainMinY : 0,
      maxY: Number.isFinite(this._terrainMaxY) ? this._terrainMaxY : 1,
    });
    if (!sampler) return;

    this.hazardField = {
      id: spec.id,
      kind: spec.kind,
      name: spec.name,
      cause: spec.cause,
      peak: spec.peak,
      at: sampler.at,
    };
    /* Scratch for this world's own per-frame read in `update`. One record for
     * the life of the world. */
    this._hazardSample = makeHazardSample();
    this.census.hazard = {
      id: spec.id,
      peakDps: Number((spec.peak.dps ?? 0).toFixed(2)),
      peakPush: Number((spec.peak.push ?? 0).toFixed(2)),
      peakStamina: Number((spec.peak.stamina ?? 0).toFixed(2)),
    };

    if (spec.kind === 'heat') this._buildHeatBand(spec);
  }

  /**
   * THE SCORCH RING: the heat band's tell, drawn at exactly its own radius.
   *
   * A hazard a player cannot see coming is worse than no hazard, and "the lava
   * is orange" is not a tell for a band that starts 24 m before the lava does.
   * So the ground inside `heatShimmer.nearLiquid` is burnt: one merged, unlit,
   * ground-hugging mesh in the descriptor's own steam colour, darkened, running
   * from each body's shore out to the exact radius `hazardField.at` stops
   * charging at. Walk off the scorch and the number is zero; that is the whole
   * contract and it is legible from thirty metres up.
   *
   * ONE MESH for every body on the planet, and no collider. It is paint - the
   * same call `_buildLandingSites` makes about a pad's rim ring, and for the
   * same reason: a marking that stopped you would be a fence, and this is a
   * warning.
   *
   * Draped on the real height field rather than laid flat, because Cinder's
   * lava sits in a trench with 3.2 m lips and a flat annulus would be buried on
   * one side and floating on the other. 0.08 m of lift is the same bias the pad
   * rings use.
   */
  _buildHeatBand(spec) {
    const P = this.planet;
    const bodies = spec.bodies ?? [];
    if (!bodies.length) return;
    const field = this._terrainField;
    if (!field) return;

    const RINGS = 4;
    const positions = [];
    const alphas = [];
    const indices = [];
    const push = (x, z, a) => {
      const y = field.sampleHeight(x, z);
      positions.push(x, Number.isFinite(y) ? y + 0.08 : 0, z);
      alphas.push(a);
      return positions.length / 3 - 1;
    };

    for (const b of bodies) {
      if (b.shape === 'disc') {
        const SEG = Math.max(24, Math.min(96, Math.round(b.r * 0.7)));
        const base = positions.length / 3;
        for (let ri = 0; ri <= RINGS; ri++) {
          const t = ri / RINGS;
          const rad = b.r + spec.reach * t;
          for (let s = 0; s < SEG; s++) {
            const a = (s / SEG) * Math.PI * 2;
            push(b.x + Math.cos(a) * rad, b.z + Math.sin(a) * rad, 1 - t);
          }
        }
        for (let ri = 0; ri < RINGS; ri++) {
          for (let s = 0; s < SEG; s++) {
            const s2 = (s + 1) % SEG;
            const a0 = base + ri * SEG + s;
            const a1 = base + ri * SEG + s2;
            const b0 = base + (ri + 1) * SEG + s;
            const b1 = base + (ri + 1) * SEG + s2;
            indices.push(a0, b0, b1, a0, b1, a1);
          }
        }
      } else {
        /* A ribbon gets two strips, one down each bank. `pts` is resampled so
         * a 110 m segment does not become one quad that misses every dip in
         * the ground between its ends. */
        const pts = [];
        for (let i = 0; i + 1 < b.pts.length; i++) {
          const [ax, az] = b.pts[i];
          const [bx, bz] = b.pts[i + 1];
          const len = Math.hypot(bx - ax, bz - az);
          const n = Math.max(1, Math.round(len / 8));
          for (let k = 0; k < n; k++) pts.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
        }
        pts.push(b.pts[b.pts.length - 1]);
        for (const side of [1, -1]) {
          const base = positions.length / 3;
          for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            const q = pts[Math.min(pts.length - 1, i + 1)];
            const r = pts[Math.max(0, i - 1)];
            const tx = q[0] - r[0];
            const tz = q[1] - r[1];
            const tl = Math.hypot(tx, tz) || 1;
            const nx = (-tz / tl) * side;
            const nz = (tx / tl) * side;
            for (let ri = 0; ri <= RINGS; ri++) {
              const t = ri / RINGS;
              const d = b.width * 0.5 + spec.reach * t;
              push(p[0] + nx * d, p[1] + nz * d, 1 - t);
            }
          }
          const stride = RINGS + 1;
          for (let i = 0; i + 1 < pts.length; i++) {
            for (let ri = 0; ri < RINGS; ri++) {
              const a0 = base + i * stride + ri;
              const a1 = a0 + 1;
              const b0 = base + (i + 1) * stride + ri;
              const b1 = b0 + 1;
              indices.push(a0, b0, b1, a0, b1, a1);
            }
          }
        }
      }
    }
    if (!indices.length) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geo.setAttribute('aHeat', new THREE.BufferAttribute(new Float32Array(alphas), 1));
    geo.setIndex(indices);
    geo.computeBoundingSphere();
    this._own(geo);

    const mat = new THREE.ShaderMaterial({
      name: `planet.${P.id}.scorch`,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(P.hazards?.steamColor ?? 0x7d6a5e) },
        uHot: { value: new THREE.Color(P.liquid?.emissive ?? P.liquid?.color ?? 0xff6a1e) },
      },
      vertexShader: `
        attribute float aHeat;
        varying float vHeat;
        void main() {
          vHeat = aHeat;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform float uTime;
        uniform vec3 uColor;
        uniform vec3 uHot;
        varying float vHeat;
        void main() {
          // Breathes, so a still frame and a moving one both read as heat
          // rather than as a decal somebody forgot to remove.
          float pulse = 0.86 + 0.14 * sin(uTime * 0.9 + vHeat * 5.0);
          vec3 c = mix(uColor * 0.35, uHot, vHeat * vHeat) * pulse;
          gl_FragColor = vec4(c, vHeat * 0.55);
        }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this._own(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `planet:${P.id}:scorch`;
    mesh.renderOrder = 3;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    this.group.add(mesh);
    this._scorch = mat;
    this.census.drawCalls++;
    this.census.triangles += indices.length / 3;
    this.census.hazard.scorchTriangles = indices.length / 3;
  }

  /** Spawn, portals, viewpoints and the minimap. */
  _publish() {
    const P = this.planet;
    const primary = this.landingSites.find((s) => s.primary) ?? this.landingSites[0];
    /* Just outside the pad's centre marker, facing the way the descriptor says.
     * 0.4 m of clearance: the capsule solver seats the feet on the heightfield,
     * and spawning exactly ON it starts the first frame in penetration. */
    this.playerSpawn.set(primary.position.x, primary.position.y + 0.4, primary.position.z + primary.radius * 0.45);
    this.playerSpawnYaw = primary.yaw;

    this._publishViewpoints();
    this._publishMinimap();
  }

  /**
   * THE VANTAGE POINTS, and the one number the descriptor is not allowed to
   * hold.
   *
   * `src/systems/Viewpoints.js` asks for `{ id, name, x, y, z, r }` and does
   * everything else itself: the reveal disc, the fast-travel anchor, the
   * credits and coin, the set prize, the minimap marker and - through
   * `viewpoints:changed` - a second `Charters` column for every planet, which
   * until now could only be counted by its seam total.
   *
   * ── WHY `y` IS MEASURED HERE AND REFUSED IN THE DESCRIPTOR ──────────────
   * The only y a fast-travel anchor may use is the y the PLAYER'S CAPSULE will
   * be resolved against, and that is the collision height field - the same
   * `t.heights` the mesh was drawn from, sampled across the same two triangles
   * `Physics.resolveCapsule` uses. It is NOT `groundAt`.
   *
   * Those two are the same function evaluated at the same grid nodes and they
   * disagree everywhere in between, because `sampleHeight` interpolates the
   * TRIANGLE and `groundAt` re-evaluates the continuous field: on a cell whose
   * corners span a crater rim the sag between them is the whole curvature of
   * the rim. `_buildLandingSites` uses `groundAt` and can, because a pad
   * landform levels its own disc flat and the two agree to the millimetre
   * there. A crater rim is the opposite case, and it is where every viewpoint
   * on this planet stands. Measured, not claimed - which is this repo's
   * standing rule and the one an earlier pass broke by metres.
   *
   * `_terrainField` rather than `physics.terrainHeight` for the reason given
   * where it is stored: the world floor is a second height field, and outside
   * the map it answers.
   */
  _publishViewpoints() {
    const P = this.planet;
    const list = P.viewpoints ?? [];
    this.viewpoints = [];
    if (!list.length) return;
    const field = this._terrainField;
    for (const v of list) {
      const y = field ? field.sampleHeight(v.x, v.z) : null;
      /* A null is an answer, and it is "do not publish this". `normaliseViewpoint`
       * would drop a non-finite y anyway, silently; saying so in the log is the
       * difference between a viewpoint that is missing and a viewpoint nobody
       * can find out is missing. */
      if (!Number.isFinite(y)) {
        console.warn(`[PlanetWorld] ${P.id}: viewpoint "${v.id}" at (${v.x}, ${v.z}) has no ground under it - dropped`);
        continue;
      }
      /* UNDER THE WATERLINE, which `definePlanet` cannot ask and this can.
       *
       * The descriptor refuses a viewpoint inside a liquid RIBBON, where a
       * column test is exact. It cannot refuse one inside a DISC: Shoal's sea
       * is a single body containing the whole playfield with a 75 m cone
       * standing out of it, and a horizontal test condemns the cone. Here the
       * ground has been measured and the liquid answers for its own surface, so
       * the question is the three-dimensional one it always was. Dropped rather
       * than clamped: a viewpoint that has to be moved is an authoring error,
       * and moving it silently is how the wrong place ends up on the map. */
      const surf = this.liquidField?.surfaceAt(v.x, v.z);
      if (Number.isFinite(surf) && y < surf) {
        console.warn(
          `[PlanetWorld] ${P.id}: viewpoint "${v.id}" at (${v.x}, ${v.z}) is ${(surf - y).toFixed(1)} m under `
          + `the ${this.liquidField.name} - dropped`
        );
        continue;
      }
      this.viewpoints.push({
        id: v.id,
        name: v.name,
        x: v.x,
        y,
        z: v.z,
        r: v.r,
        /* Carried through for the HUD and the log. `Viewpoints.normaliseViewpoint`
         * ignores anything it does not know, so extra fields cost nothing. */
        place: v.place,
        terrain: v.terrain,
        climb: v.climb,
      });
    }
    this.census.viewpoints = this.viewpoints.map((v) => ({ id: v.id, y: Number(v.y.toFixed(2)) }));
  }

  /**
   * THE FLOORPLAN.
   *
   * `Minimap._bakePlan` rasterises `minimapShapes` IN ORDER, so this method is
   * really a painter's-algorithm stack: ground, then liquid, then the pads.
   *
   * ── Three things were hard-coded to lava and wrong for water ────────────
   *
   * 1. THE LIQUID FILL was the literal string `rgba(255,110,30,0.55)`. Correct
   *    for Cinder and catastrophic for Shoal, whose sea is a single 2,700 m
   *    disc covering the entire playfield: the map came out a FULL-SCREEN
   *    ORANGE WASH with the land indistinguishable from the sea. Not merely
   *    wrong - useless. The colour now comes off the descriptor's own channels
   *    through `_liquidInk`.
   *
   * 2. A BODY BIGGER THAN THE MAP IS THE BACKGROUND, not a shape drawn over
   *    it. Painting a disc that contains all four corners of the playfield can
   *    only ever cover everything under it, so such a body becomes the base
   *    rect's fill and the LAND is drawn on top of it - as run-merged rects off
   *    the same wet/dry mask the shore barrier is built from, which is why the
   *    coastline on the map is the coastline the player is stopped at. Runs
   *    keep it cheap: Shoal's islands cost a few hundred rects, not 78,400.
   *
   * 3. THE GROUND RECT was `rgba(24,14,12,0.85)` with an orange stroke - ash,
   *    on every planet. It comes from `palette.bands` now.
   *
   * ── And one silent bug ──────────────────────────────────────────────────
   * The ribbon case emitted `points: [{x, z}, ...]` while `Minimap._bakePlan`
   * reads `p[0]`/`p[1]`, as every other world in the repo supplies. `moveTo`
   * with two `undefined`s is a NaN path segment: Cinder's 340 m outlet gorge -
   * the biggest liquid feature on the planet - HAS NEVER BEEN ON THE MINIMAP.
   * It draws now, which is a deliberate and visible change to Cinder's map.
   */
  _publishMinimap() {
    const P = this.planet;
    const bands = P.palette?.bands ?? [];
    const bodies = P.liquid?.bodies ?? [];
    const ink = P.liquid ? this._liquidInk(P.liquid) : null;

    /* THE BACKDROP IS THE WHOLE PALETTE, DARKENED.
     *
     * Not one band: `bands[mid]` picked Cinder's #45505c and turned a volcanic
     * planet's map slate blue, which is a worse answer than the ash-coloured
     * literal it replaced. The mean of every band is the planet's own colour,
     * and 0.45 of it keeps the map recessive so the liquid, the roads and the
     * pads are what the eye finds - which is what the old rgba(24,14,12,0.85)
     * was doing by hand. Cinder lands on rgb(48,42,36): the same dark warm
     * brown, a shade lighter, and a deliberate change.
     *
     * LAND drawn ON a sea is the opposite job and gets the opposite treatment:
     * the mean of the bands ABOVE the waterline, undarkened, because it has to
     * separate from the water rather than recede into it. Those are literally
     * the colours of the ground that is not underwater. */
    const mean = (list) => {
      if (!list.length) return [24, 14, 12];
      let r = 0; let g = 0; let b = 0;
      for (const c of list) { const p8 = rgb8(c.color); r += p8[0]; g += p8[1]; b += p8[2]; }
      return [Math.round(r / list.length), Math.round(g / list.length), Math.round(b / list.length)];
    };
    const all = mean(bands);
    const backdropFill = `rgba(${mix8([0, 0, 0], all, 0.45).join(',')},0.85)`;
    const groundStroke = bands.length
      ? this._rgba(bands[bands.length - 1].color, 0.7)
      : 'rgba(200,90,40,0.7)';
    /* "Covers the playfield" is asked of the drawn outline, not of the nominal
     * radius: `bodySurfaceAt` is the same wobbly shoreline the mesh has. All
     * four corners inside means nothing on the map is ever outside it. */
    const covers = bodies.filter((b) => this._coversPlayfield(b));

    this.minimapShapes.push({
      kind: 'rect', x: 0, z: 0, w: P.half * 2, d: P.half * 2, rotation: 0,
      fill: covers.length && ink ? ink.fillSolid : backdropFill,
      stroke: groundStroke,
    });

    if (covers.length && this._bed) {
      const waterline = covers[0].shape === 'disc' ? covers[0].y : Math.max(covers[0].y0, covers[0].y1);
      const above = bands.filter((b) => b.upTo > waterline);
      const landFill = `rgb(${mean(above.length ? above : bands).join(',')})`;
      for (const r of this._landRects()) {
        this.minimapShapes.push({ kind: 'rect', x: r.x, z: r.z, w: r.w, d: r.d, rotation: 0, fill: landFill });
      }
    }

    for (const b of bodies) {
      if (covers.includes(b)) continue;
      if (b.shape === 'disc') {
        this.minimapShapes.push({ kind: 'circle', x: b.x, z: b.z, r: b.r, fill: ink.fill, stroke: ink.stroke });
      } else {
        this.minimapShapes.push({
          kind: 'path', points: b.pts.map(([x, z]) => [x, z]), width: b.width, stroke: ink.stroke,
        });
      }
    }

    for (const s of this.landingSites) {
      this.minimapShapes.push({
        kind: 'circle', x: s.position.x, z: s.position.z, r: s.radius,
        fill: 'rgba(100,216,255,0.22)', stroke: '#64d8ff',
      });
    }
  }

  /**
   * `0xrrggbb` -> `rgba(r,g,b,a)`, and the mixing that feeds it, in sRGB BYTES.
   *
   * Not through `THREE.Color`, and that is the point. `setHex` converts to the
   * renderer's working colour space, so `color.r * 255` is a LINEAR value - the
   * first version of this went out at rgb(235,46,3) for a lava fill that had
   * been rgb(255,110,30), a visibly darker, more saturated orange, because the
   * conversion was never undone. The minimap is a 2D canvas: it wants sRGB, and
   * lerping in sRGB is exactly what the hard-coded literals it replaces were.
   */
  _rgba(hex, a) {
    const c = rgb8(hex);
    return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  }

  /**
   * What this liquid looks like FROM ABOVE, from the descriptor's own channels.
   *
   * The map is a plan view of the material, so it is derived the way the
   * material mixes: `crust` and `color` average to the body colour, and the
   * incandescence rides on top in proportion to `emissive`. Cinder's
   * `emissive: 2.1` saturates the weight and lands on rgb(238,113,26) against
   * the rgb(255,110,30) that was hard-coded - a deliberate, near-invisible
   * shift. Shoal's `emissive: 0.16` contributes almost nothing and its sea
   * comes out the deep blue it is.
   *
   * The stroke is the same mix pushed further toward `hot`: a molten rim on
   * lava, a surf line on water. Both are the map's brightest edge, which is
   * what a shoreline should be.
   */
  _liquidInk(L) {
    const hot = rgb8(L.hot ?? 0xff7a1c);
    const base = mix8(rgb8(L.crust ?? 0x140b0a), rgb8(L.color ?? 0x3d0a04), 0.45);
    const w = Math.min(0.92, Math.max(0, (L.emissive ?? 0) * 0.45));
    const fill = mix8(base, hot, w);
    const stroke = mix8(base, hot, Math.max(w, 0.5));
    const px = (c) => `${c[0]},${c[1]},${c[2]}`;
    return {
      fill: `rgba(${px(fill)},0.55)`,
      /* Opaque where the body IS the map: a 55% wash over a black canvas is a
       * muddy sea, and there is nothing underneath it to show through. */
      fillSolid: `rgb(${px(fill)})`,
      stroke: `rgb(${px(stroke)})`,
    };
  }

  /** True when this body's outline contains every corner of the playfield. */
  _coversPlayfield(b) {
    const h = this.planet.half;
    for (const [x, z] of [[-h, -h], [h, -h], [h, h], [-h, h]]) {
      if (bodySurfaceAt(b, x, z) === null) return false;
    }
    return true;
  }

  /**
   * The land, as horizontal runs of dry cells.
   *
   * Off the SAME mask the shore barrier stands on, so the island the map draws
   * and the island the player can stand on are one island. One rect per run
   * rather than per cell: Shoal is 280x280 cells and its coastline resolves to
   * a few hundred rects.
   */
  _landRects() {
    const bed = this._bed;
    const mask = liquidCellMask({ liquid: this.planet.liquid, ...bed });
    const { wet, cx, cz } = mask;
    const out = [];
    for (let j = 0; j < cz; j++) {
      let i = 0;
      while (i < cx) {
        if (wet[j * cx + i]) { i++; continue; }
        let i1 = i;
        while (i1 + 1 < cx && !wet[j * cx + i1 + 1]) i1++;
        const w = (i1 - i + 1) * bed.stepX;
        out.push({
          x: bed.originX + (i + i1 + 2) * 0.5 * bed.stepX,
          z: bed.originZ + (j + 0.5) * bed.stepZ,
          /* Overlapped by a quarter of a cell, which at the rasteriser's
           * 2.4 px/m is about two pixels. A 4% overlap was under a third of a
           * pixel and the canvas anti-aliased every row edge against the sea
           * behind it, so the islands came out striped. The fill is opaque, so
           * overlapping costs nothing. */
          w: w + bed.stepX * 0.25,
          d: bed.stepZ * 1.25,
        });
        i = i1 + 1;
      }
    }
    return out;
  }

  /* ================================================================== */
  /* Frame                                                              */
  /* ================================================================== */

  update(dt, elapsed) {
    this._t = elapsed;
    this._underwater();
    if (this._sky) this._sky.update(dt);
    if (this._liquidUniforms) this._liquidUniforms.uTime.value = elapsed;
    for (let i = 0; i < this._plumes.length; i++) this._plumes[i].material.uniforms.uTime.value = elapsed;
    if (this._scorch) this._scorch.uniforms.uTime.value = elapsed;
    if (this._ash) {
      this._ash.uniforms.uTime.value = elapsed;
      // Written into the existing uniform vector, never replaced: this runs
      // every frame and a new Vector3 here is 60 allocations a second.
      const cam = this.engine?.camera;
      if (cam) cam.getWorldPosition(this._ash.uniforms.uEye.value);
      this._breatheAsh();
    }
  }

  /**
   * THE HAZARD'S OWN TELL, ON THE FIELD THE DESCRIPTOR ALREADY DRAWS.
   *
   * The ash `Points` is camera-wrapped and global - one density for the whole
   * planet - which is exactly wrong for two of the three hazards, because both
   * are things you can walk out of and neither of them said so in the frame.
   *
   *   wind      the sand thickens as you climb into the exposure and thins the
   *             moment a dune is between you and it. That is the only tell the
   *             push has, and without it a player shoved sideways on a crest
   *             learns nothing about how to stop being shoved.
   *   thin_air  the diamond dust thins with altitude, because air that is too
   *             thin to scatter the sun is too thin to hold much ice. It is a
   *             second reading of the same number the stamina bar is draining
   *             on, and it is the one you can see without looking away.
   *
   * `heat` is untouched - its tell is the scorch on the ground, which is where
   * a band you have to STAND in belongs.
   *
   * Sampled at the CAMERA, not at the player, and that is deliberate: this
   * changes what the frame looks like, and `_underwater` two methods down makes
   * exactly the same call for exactly the same reason. The damage, the push and
   * the drain are read at the body by whoever consumes `hazardField`.
   *
   * `_ashBase` is captured once so a re-entry cannot compound the scaling - the
   * defect a naive `uOpacity *= x` would have every time the world reloads.
   */
  _breatheAsh() {
    const f = this.hazardField;
    if (!f || (f.kind !== 'wind' && f.kind !== 'thin_air')) return;
    const cam = this.engine?.camera;
    if (!cam) return;
    if (this._ashBase === null) this._ashBase = this._ash.uniforms.uOpacity.value;
    cam.getWorldPosition(_hazEye);
    const s = f.at(_hazEye.x, _hazEye.y, _hazEye.z, this._hazardSample);
    /* Wind: still air is thin air here too, so the floor is 45% rather than 0 -
     * a dune lee with NO sand in it would read as a bug rather than as shelter.
     * Thin air: the other way round, dense low and thin high. */
    const k = f.kind === 'wind' ? 0.45 + 0.55 * s.intensity : 1 - 0.6 * s.intensity;
    this._ash.uniforms.uOpacity.value = this._ashBase * k;
  }

  /**
   * SUBMERGED: what the world looks like from under its own water.
   *
   * ── The defect ───────────────────────────────────────────────────────────
   * A playthrough that got past the shore barrier on Shoal reported "a dry,
   * dusty grey plain to the horizon under an open sky, while the minimap is
   * solid blue with you in the middle of it". Three separate things were
   * producing that one sentence and all three are fixed here or in
   * `_buildLiquid`:
   *
   *   the surface was not there    a fan wound to face up is culled from
   *                                below. `DoubleSide` on swimmable liquid.
   *   the air was still air        the world's own fog runs to 600 m on a
   *                                planet, so the sea bed had a horizon.
   *   the sky was still the sky    `Sky` builds its dome with `fog: false` on
   *                                purpose, so no fog change could ever have
   *                                hidden it, and it is centred on the camera
   *                                so it is always in shot.
   *
   * ── Why this is per frame and not an event ──────────────────────────────
   * It is a question about the CAMERA, not the player: in third person the eye
   * can be a metre out of the water while the body is under it, and vice
   * versa, and it is the eye that decides what the frame looks like. There is
   * no event for "the camera crossed a plane".
   *
   * `scene.fog` and `scene.background` belong to `main.js`'s `applyEnvironment`,
   * which runs once per world change. Both are restored from this world's own
   * `environment` the moment the camera surfaces, and again on deactivate, so
   * the borrow is never visible outside the water.
   */
  _underwater() {
    const cam = this.engine?.camera;
    const scene = this.scene;
    const field = this.liquidField;
    let under = false;
    if (cam && scene && field) {
      cam.getWorldPosition(_underEye);
      const surf = field.surfaceAt(_underEye.x, _underEye.z);
      /* Only for liquid you can be in. A camera clipping under Cinder's lava
       * plane is a camera bug, and painting the frame black-red would hide it
       * rather than report it. */
      under = field.swimmable && Number.isFinite(surf) && _underEye.y < surf;
    }
    if (under === this._under) return;
    this._under = under;
    const env = this.environment;
    if (under) {
      if (this._sky) this._sky.mesh.visible = false;
      scene.background = this._underColor;
      if (scene.fog) {
        scene.fog.color.copy(this._underColor);
        scene.fog.near = UNDER_NEAR;
        scene.fog.far = UNDER_FAR;
      }
    } else {
      if (this._sky) this._sky.mesh.visible = true;
      scene.background = env.background ?? null;
      if (scene.fog) {
        scene.fog.color.copy(env.fogColor);
        scene.fog.near = env.fogNear;
        scene.fog.far = env.fogFar;
      }
    }
  }

  onActivate() {
    super.onActivate();
    // The dome has to ride the camera or the player walks out of the sky.
    if (this._sky && this.engine?.camera) this._sky.mesh.position.copy(this.engine.camera.position);
  }

  onDeactivate() {
    /* Leaving the world while submerged would otherwise hand the next one this
     * world's fog and a hidden sky dome. `_underwater` restores on the edge, so
     * forcing the flag and calling it is the whole of the fix. */
    if (this._under) {
      this._under = false;
      if (this._sky) this._sky.mesh.visible = true;
      const env = this.environment;
      if (this.scene) {
        this.scene.background = env.background ?? null;
        if (this.scene.fog) {
          this.scene.fog.color.copy(env.fogColor);
          this.scene.fog.near = env.fogNear;
          this.scene.fog.far = env.fogFar;
        }
      }
    }
    super.onDeactivate();
  }

  dispose() {
    for (const o of this._owned) o.dispose?.();
    this._owned.length = 0;
    this._sky?.dispose?.();
    this._sky = null;
    /* The probe goes with the dome it was baked from. `_owned` freed the
     * target on the line above; these two drop the world's last references so
     * a rebuilt planet cannot hand `applyEnvironment` a texture whose GPU
     * storage is gone. Same pair, and the same reason, as
     * `MedievalWorld.dispose`. */
    this._envRT = null;
    this.environment.envMap = null;
    this._plumes.length = 0;
    this._ash = null;
    this._propMat = null;
    /* The bed is the terrain's own height buffer and the whole liquid depth
     * texture is derived from it; a planet revisited must not keep the last
     * visit's ground alive behind the new one. */
    this._bed = null;
    this._liquidDepth = null;
    this.liquidField = null;
    this.mineralNodes.length = 0;
    this.landingSites.length = 0;
    this.viewpoints.length = 0;
    this._terrainField = null;
    /* All four together: the sampler closes over `_terrainField`, so a field
     * left behind would keep the last visit's entire height buffer alive
     * through a closure - the same leak the bed comment above is about. */
    this.hazardField = null;
    this._hazardSpec = null;
    this._hazardSample = null;
    this._scorch = null;
    this._ashBase = null;
    super.dispose();
  }
}
