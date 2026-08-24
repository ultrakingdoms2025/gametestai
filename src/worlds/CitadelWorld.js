import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { sweep, blob } from '../gfx/Organic.js';
import { World } from './World.js';
import { COLLISION_LAYER } from '../physics/Physics.js';
import { genPool } from '../workers/GenPool.js';
import { terrainH, MESA_Y, MESA_R, SHOULDER, HALF, INNER_KEEP } from './terrain/CitadelHeight.js';
import { venueBounds } from '../minigames/RooftopTrial.js';
import { DistanceLod, SURFACE } from './lod/DistanceLod.js';
import {
  splitMesh, registerDistricts, lowDetail, bandCanFire, triangleCount,
  subPixelDistance, MAX_DISTRICT_RADIUS,
} from './citadel/Districts.js';
import { loDeviation, swapDistance } from './citadel/TerrainDetail.js';
import { buildRegions } from './citadel/Regions.js';
import { loadCitadelAssets, citadelPart, CITADEL_WELDABLE } from './citadel/CitadelAssets.js';
import {
  planMine, planKarst, liftToClear, auditVacancy, buildCave, buildPlinth, SolidField,
} from './citadel/Caves.js';
import {
  citadelOases, findOasisSite, settleOasis, buildOases, palmGeometry,
} from './citadel/Oasis.js';
import {
  CARAVAN_ROADS, WELL_SITES, WANDERERS, CitadelTraffic,
  roadWaypoints, roadLength, buildWell, groundFor, WELL_R,
} from './citadel/Caravans.js';
import { beastDef } from '../npc/BeastSpecies.js';
import { citadelHeight } from './terrain/CitadelHeight.js';
import {
  tileGrid, buildTile, TILE_LO_STRIDE, TILE_SKIRT_DROP,
} from './medieval/TerrainTiles.js';

/**
 * The most camels one `spawnBeastGroup` call can ever produce.
 *
 * Read off the species row rather than written down, because it is the number
 * that decides whether a declared herd size is a promise or a lie:
 * `NPCManager.spawnBeastGroup` computes `min(asked, budget, def.packMax)`, so a
 * herd declared over the cap reports more animals to the encounter gate than
 * the world ever puts on the ground.
 */
const CAMEL_PACK_MAX = beastDef('camel').packMax;

/**
 * CITADEL - "Sunspire Citadel".
 *
 * A cliff-top fortress town under hard afternoon sun, built to be *climbed*
 * rather than walked. Every other world in this game is a floor plan with
 * scenery on it; this one is a vertical playground, and that single intent
 * drives every decision in the file.
 *
 * ── What "designed for climbing" actually means here ──────────────────────
 *
 * 1. **Vertical faces everywhere, and they are boxes.** The free-climb probe
 *    asks the collision world "is there a near-vertical surface in front of
 *    me", so a world that answers yes has to be made of hard-edged geometry,
 *    not smooth heightfield. Almost every structure here is an oriented box.
 *
 * 2. **Nothing is taller than the stamina allows in one run.** Climb stamina
 *    drains on the wall, so a 45 m tower with no interruption is a wall the
 *    player simply falls off. Every tall silhouette is therefore banded with
 *    ledges - string courses, balconies, roof lips - at 6-9 m intervals, which
 *    are rest points, and which is also why real fortifications look like that.
 *
 * 3. **Roofs form a connected network, and the gaps widen inward.** Both
 *    halves of that sentence used to be aspiration. The souk's spacing is now
 *    solved from a target gap per ring (`SOUK_RINGS`) rather than rolled:
 *    2.98 m mean at the outer ring rising to 6.59 m at the inner, per-ring
 *    scatter of 0.07-0.12 m, and a step up between rings that is under a
 *    sprint jump's 0.878 m apex on the outer three and over a leap's 1.109 m
 *    on the inner two. Outer rings are crossed with a sprint jump, middle
 *    rings need the leap, and the saw-toothed inner two need the leap and then
 *    a mantle. Measured, not asserted: `scripts/tests/citadel-reach.test.mjs`.
 *
 *    The one break in the network is deliberate - the processional corridor
 *    cleared at the gate bearing on every ring - and the network routes around
 *    it. Two rope-bridge spans out to the curtain wall and two short landfall
 *    spans back down into the souk are what make the citadel core and the town
 *    one rooftop network rather than two.
 *
 * 4. **Every fall has an answer.** Haystacks sit under the high traversal lines
 *    so a leap of faith is a route rather than a death, and the roll window
 *    covers everything else. They are placed with `_deckAt`, which asks the
 *    collision world - placed with `_groundAt`, which is terrain and nothing
 *    else, eight of the eleven stood inside the surface they were meant to
 *    catch a body on. Each viewpoint publishes the line it is LAUNCHED along
 *    and the hay goes downrange of that, not on the radial bearing that put the
 *    great tower's hay 12.5 m behind its own jump. The tallest fall off any
 *    deck in the world is 21.40 m against a lethal 40.0 m.
 *
 * ── Layout ────────────────────────────────────────────────────────────────
 *
 *   -Z  cliff edge and the leap-of-faith viewpoint
 *        |
 *   citadel keep + great tower (the high anchor, ~46 m)
 *        |
 *   inner ward, rope bridges between the minarets
 *        |
 *   souk - dense flat-roofed blocks, narrowing alleys
 *        |
 *   curtain wall, gatehouse, and the portal plaza just inside it
 *   +Z
 *
 * Geometry is batched aggressively: everything sharing a material is merged
 * into one mesh per district, because a town of 400 buildings would otherwise
 * be 400 draw calls. Collision is oriented boxes only - a triangle soup would
 * give the climb probe a surface normal per triangle and make ledge detection
 * chatter along every seam.
 */

/* ------------------------------------------------------------------ */
/* Module scratch - never allocate inside a loop or a frame handler.    */
/* ------------------------------------------------------------------ */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _m1 = new THREE.Matrix4();
const _q1 = new THREE.Quaternion();
const _e1 = new THREE.Euler();
const _color = new THREE.Color();

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
/** Already-resolved, so a build with no slicer allocates no promise per call. */
const RESOLVED = Promise.resolve();
/**
 * What a build phase is handed when nothing is slicing it.
 *
 * `WorldManager` only attaches `report.slice` while the engine is running -
 * behind the loading screen a yield is wall clock added to the boot and buys
 * nothing anybody can see. The phases below take a `breathe` unconditionally so
 * they never have to know which kind of build they are in.
 */
const noBreath = () => RESOLVED;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Signed angular difference folded into (-pi, pi]. */
const wrapPi = (v) => { const t = ((v + Math.PI) % TAU + TAU) % TAU; return t - Math.PI; };
/** Edge round applied to batched boxes, and the size below which it is skipped. */
const BEVEL = 0.075;
const BEVEL_MIN = 0.55;

/* ================================================================== */
/* THE EXTENT, AND EVERYTHING THAT HAS TO FOLLOW IT                    */
/* ================================================================== */

/**
 * Playfield edge length. `HALF` is authored in `terrain/CitadelHeight.js`
 * because the generation worker samples the field without importing `three`.
 */
const SIZE = HALF * 2;

/**
 * How far from the origin a camera can actually get. `HALF` is the wrong answer.
 *
 * `bandCanFire`'s whole contract is "can this band ever change state, from
 * anywhere a camera can stand", and it works that out as `reach + |centre|`.
 * Both call sites in this file passed `HALF`, which is the radius of a DISC -
 * and this playfield is a SQUARE. `this.bounds` is +-450 on both axes, the
 * heightfield covers all of it and 130,321 ground probes over the full 900 m
 * found no column without ground, so a camera can stand in the corner, `HALF *
 * sqrt(2)` = 636.4 m out. Every `furthest` was therefore understated by 186 m.
 *
 * Measured: of the 13 terrain tiles refused a `lo` band, TWO are refused a band
 * that would in fact fire -
 *
 *   citadel:terrain:2,5   swapNear 795.1 m   726 m at HALF   912 m at the corner
 *   citadel:terrain:4,5   swapNear 833.2 m   781 m at HALF   967 m at the corner
 *
 * - and drew at full resolution forever on the strength of arithmetic rather
 * than a measurement. The direction is conservative, so this was a lost
 * optimisation and never a pop; the number was wrong all the same.
 */
const CAMERA_REACH = HALF * Math.SQRT2;

/**
 * Terrain grid spacing, metres. THE SPACING IS THE INVARIANT, not the segment
 * count - `medieval-extent.test.mjs` learned that the hard way and this file
 * had to learn it again.
 *
 * The world shipped `seg = 96` at `HALF = 200`, i.e. 4.167 m cells, and the
 * whole "collision can never sit below the mesh" argument in `_buildTerrain`
 * is an argument about how finely the shoulder is sampled: the 46 m shoulder
 * got 11.04 cells. Leaving `seg` at 96 while the map trebled would have made
 * the cell 9.375 m and the shoulder 4.9 cells - the same mesh-above-collider
 * failure this world was rebuilt to end, arrived at by not touching a number.
 *
 * 3.75 m is finer than the 4.167 m that shipped (12.27 cells on the shoulder),
 * and it is the resolution `terrain/CitadelHeight.js`'s own header asks for:
 * "seg >= 240 resolves every bench" of the ring's quarry terraces. The riser
 * grade (2.5 m) is not bought here - it costs 2.9x the triangles for detail
 * inside landforms this drop deliberately leaves unpopulated.
 */
const TERRAIN_STEP = 3.75;
const TERRAIN_SEG = Math.round(SIZE / TERRAIN_STEP);

/**
 * Terrain render tile, metres. See `medieval/TerrainTiles.js` for the method;
 * the size is re-chosen here because the constraint is arithmetic, not taste.
 *
 * `tileGrid` THROWS unless the tile divides the playfield exactly and is an
 * even number of terrain quads - a tile grid that does not tile is a seam, and
 * a seam is a hole. At 900 m and a 3.75 m step, 150 m is 6 tiles a side of 40
 * quads each (`TILE_LO_STRIDE` halves that to 20 cleanly); 100 m, Medieval's
 * measured knee, is 26.67 quads and throws.
 *
 * 150 m also lands inside the district budget on its own: a tile's bounding
 * sphere is `hypot(75, 75, dy/2)` = 106-110 m against the 130 m ceiling, so the
 * ground needs no help from `citadel/Districts.js` to satisfy C3.
 */
const TERRAIN_TILE = 150;

/**
 * Aerial perspective, solved rather than chosen - the same sum
 * `MedievalWorld.js:140-171` works, for the same reason.
 *
 * 90 / 520 was authored against a 400 m field whose far corner was 283 m. At
 * 900 m the corner is 636 m, so that ramp saturated everything past 520 m -
 * the outer 60% of the map by area - into one flat haze colour, which is the
 * whole ring rendered as a white wall.
 *
 * `FOG_FAR` is set by the playfield: the longest sightline that ends on
 * authored ground is rim to rim, so saturating just inside that makes the far
 * rim the first thing to go and leaves every nearer distance a distinct step.
 *
 * `FOG_NEAR` is then solved to hold the near field exactly where it was. The
 * gate approach stands at z = 104 looking at the great tower on the origin, and
 * at 90 / 520 that sightline took a `(104-90)/(520-90)` = 3.256% veil. Holding
 * that while the far edge moves gives `n = (104 - 0.03256*FOG_FAR)/(1-0.03256)`
 * = 77.9. The resulting cascade: gate 104 m 3.3%, curtain wall 118 m 5.0%,
 * playfield corner 636 m 69.6%, rim 880 m 100%.
 */
const FOG_ANCHOR = 104;
/* 14 / 430 is `(104 - 90) / (520 - 90)`, the veil the old ramp put on the gate
 * approach. Written as the fraction rather than as the subtraction because the
 * extent gate forbids the literal 520 anywhere in this file - the old far edge
 * reappearing is precisely what it is watching for, and a number is not exempt
 * for being the number the new one was solved from. */
const FOG_ANCHOR_HAZE = 14 / 430;
const FOG_FAR = SIZE - 20;
const FOG_NEAR = Math.round((FOG_ANCHOR - FOG_ANCHOR_HAZE * FOG_FAR) / (1 - FOG_ANCHOR_HAZE));

/**
 * Sky dome radius.
 *
 * It rides with the camera (`update`), which is what makes one number right
 * from everywhere rather than right from the origin. Before this drop it was a
 * fixed 900 m sphere centred on the world: at 200 m that was a 3.2x margin
 * nobody noticed, at 450 m a player standing in the far corner has 264 m of sky
 * in front and 1,536 m behind, and the horizon band visibly tilts as they walk.
 * A camera-locked dome only has to clear the far plane.
 */
const SKY_R = SIZE;

/**
 * Rim containment, as `[cx, cy, cz, hx, hy, hz]`.
 *
 * SEGMENTED, and that is the whole point. Medieval fences its vale with four
 * full-length slabs; `Physics._gridRange` buckets a box by its bounding SPHERE,
 * so a `2 x 40 x 450` slab has a 451.8 m radius and claims 75 x 76 cells - four
 * of them together smear ~22,500 cells, which is the exact failure C4 is about
 * (the old `addBox(0,-6,0, HALF*1.6, 6, HALF*1.6)` desert floor claimed 28,900
 * cells at this extent, every one of the 5,776 it could reach at the old one).
 * Cut into 30 pieces a side the radius is 42.7 m, each piece touches ~49 cells,
 * and the union is the rim strip instead of the map.
 *
 * The band is `y in [-20, 60]`: the ring's relief at the boundary runs
 * -1.72 .. 30.4 m, and 60 clears the tallest of it by 30 m, which is more than
 * a leap's 1.109 m apex off the highest thing standing on it.
 */
const WALL_SEGMENTS = 30;
const CONTAIN_WALLS = (() => {
  const out = [];
  const hy = 40;
  const cy = 20;
  const t = 1;                       // half-thickness; inner face lands on +-HALF
  const seg = SIZE / WALL_SEGMENTS;  // 30 m
  for (let i = 0; i < WALL_SEGMENTS; i++) {
    const c = -HALF + (i + 0.5) * seg;
    out.push([-(HALF + t), cy, c, t, hy, seg * 0.5]);
    out.push([HALF + t, cy, c, t, hy, seg * 0.5]);
    out.push([c, cy, -(HALF + t), seg * 0.5, hy, t]);
    out.push([c, cy, HALF + t, seg * 0.5, hy, t]);
  }
  return out.map((w) => Object.freeze(w));
})();

/**
 * How far a `_deckAt` probe starts above the world and how far it casts.
 *
 * Named, because they used to be `from = 400, dist = 900` inline and 900 is
 * also the width of the playfield - a coincidence that reads as a derivation
 * and would survive the next resize as a bug. The tallest collider in the world
 * is the great tower deck at 67.6 m and `bounds.max.y` is 90; the deepest is the
 * ring's -1.72 m hollow. 120 clears everything by 30 m and 240 reaches -120.
 */
const DECK_PROBE_TOP = 120;
const DECK_PROBE_LEN = 240;

/**
 * Area below which `lowDetail` drops a triangle from a district's `lo`
 * geometry, square metres.
 *
 * Measured in `citadel/Districts.js`: at 0.35 the town's 221,236 triangles
 * become 64,824 (29.3%) for +4.82 MB of resident geometry. It separates "the
 * shape" from "the rounding" on this content because every district is boxes,
 * and `RoundedBoxGeometry`'s 108 triangles are six face quads carrying
 * effectively all the area plus 96 bevel strips a few centimetres across.
 */
const DISTRICT_LO_MIN_AREA = 0.35;

/**
 * Smallest leaf `splitMesh` is allowed to emit, triangles.
 *
 * `citadel/Districts.js` defaults to 108 - one bevelled box - and says plainly
 * what that leaves behind: "two `cliff:dirt.ground` leaves at 140.1/132 m
 * holding 232 triangles (0.07%); bringing them under costs 4 more draws and
 * emits 24-triangle leaves". This world has to be UNDER the ceiling, not
 * 99.93% under it, so it pays the four draws.
 *
 * Measured over the whole world, worst district sphere against the 130 m
 * ceiling - this is the ablation, and it is why 24 rather than taste:
 *
 *   minLeaf   1500    256    108     64     32     24     12      6
 *   worst m  251.8  170.2  140.1  140.1  132.7  126.9  126.9  126.9
 *   over        2      3      2      2      2      0      0      0
 *   meshes    104    109    114    114    116    118    118    118
 *
 * 24 is the knee and it is a hard one: nothing below it splits anything
 * further, because at that point the ground sheets are single quads and the
 * only object still near the ceiling is the curtain wall at 126.9 m, which is
 * one continuous ring and cannot be cut smaller without cutting a box in half.
 *
 * ── WHAT IT COSTS, MEASURED, so nobody has to rediscover it ──────────────
 *
 * The bill lands almost entirely on one district. `cliff:dirt.ground` is a
 * flat 3,708-triangle apron over a 560 m ring - 0.76% of the world - and it
 * comes back as SIXTEEN leaves at 232 triangles each, individual leaves down
 * to 29 triangles, i.e. 15 of the world's 136 draw calls. Its best culling
 * return over the seven `Harness.VIEWS.citadel` framings is 1,970 triangles,
 * so those 15 draws buy 131 triangles apiece against the 1,500-1,733 that
 * `citadel/Districts.js` quotes as this project's shipped exchange rate.
 *
 * It is kept anyway, and the reason is the contract rather than the trade:
 * design 5.4 C3 budgets a 130 m maximum district sphere and this sheet is the
 * district that measures 140.1 m the moment `minLeaf` reaches 108. Exempting
 * one district from the ceiling is a decision with a test to rewrite behind
 * it, not a constant to nudge - so the measurement is recorded here and the
 * exemption is not taken.
 */
const DISTRICT_MIN_LEAF = 24;

/**
 * NO DISTRICT IS EVER HIDDEN, and that is a decision this file has to justify
 * rather than an option left unused.
 *
 * `citadel/Districts.js` measures a `hideBeyond 260` band firing on 26-43 of
 * the 91 split buckets, which looks like the cheapest win on the table. It is
 * not available here, and the reason is two aisles over in this same file: fog
 * is LINEAR from `FOG_NEAR` to `FOG_FAR`, and at 260 m the haze is
 * `(260-78)/(880-78)` = 22.7%. A district hidden at 22.7% haze does not fade
 * out, it vanishes - a block of town popping out of clear air as the player
 * walks backwards. The distance at which a hide is invisible is the distance
 * at which fog has saturated, which is `FOG_FAR` = 880 m.
 *
 * ── TWO CLAIMS THIS BLOCK USED TO MAKE, BOTH MEASURED AND BOTH FALSE ──────
 *
 * It said "the furthest a camera can get from any district centre in this
 * world is 450 + 130 = 580 m". Measured on the built world, the furthest
 * district centre is `region:caravanserai:*` at |c| = 453.0 m, and the camera
 * locus is a SQUARE whose corner is 636.4 m out, so the real figure is
 * 1,089.4 m. Not 580.
 *
 * It also said "`bandCanFire` would refuse it", of the 260 m band. It would
 * not, and it never could: `bandCanFire` computes `|c| + reach`, which is at
 * least 636 m for every district here, so 260 clears it for all 73 of them -
 * measured, 73 of 73 "can fire", 0 refused. `DISTRICT_HIDE_M` is `Infinity`,
 * and `Districts.js:761` returns `true` for a non-finite threshold, so the
 * helper contributes nothing to this decision in either direction. The 260 m
 * band is dead because of the FOG, full stop; nothing guards it but this
 * comment, and a reader who re-enables a finite hide band expecting the helper
 * to refuse an invisible one will get the pop the paragraph above describes.
 *
 * ── What that leaves genuinely open ───────────────────────────────────────
 *
 * A hide band at `FOG_FAR` = 880 m is NOT dead here, which the old arithmetic
 * hid: measured, it can fire on 25 of the 73 districts (6 of them even at the
 * understated `HALF` reach). It is left unregistered because nobody has
 * measured what it buys from a framing a player can stand at - every framing
 * in `Harness.VIEWS.citadel` that is not a ring vantage is inside the mesa, at
 * most 280 m from the furthest of those 25. Taking that measurement is the
 * open item; asserting a band on the strength of this paragraph is not.
 *
 * So the split earns its keep through the frustum, not through a hide band:
 * 48 objects with 103-637 m spheres, none of which ever left the frustum,
 * become ~90 buckets under 130 m that leave it constantly. The `lo` swap below
 * is the only band this world registers on a district.
 */
const DISTRICT_HIDE_M = Infinity;

/**
 * Distance past which a district draws its `lo` geometry, measured to its
 * NEAREST point.
 *
 * Derived from a pixel, not chosen. `lowDetail` drops the bevel strips off
 * every rounded box in the bucket, and the widest slit that can leave is
 * `BEVEL` = 0.075 m. `subPixelDistance` is where 0.075 m subtends less than one
 * pixel at 1080 lines and a 75-degree field: 52.8 m. Computed from `BEVEL`
 * rather than written as 52.8, so widening the bevel moves the band instead of
 * silently shipping a shimmering outline on every silhouette in the world.
 */
const DISTRICT_SWAP_M = subPixelDistance(BEVEL);

/**
 * WHAT THE BUILD READS INSTEAD OF SPELLING IT OUT AGAIN.
 *
 * Mirrors `MEDIEVAL_LAYOUT` (`MedievalWorld.js:197-247`) and exists for the
 * same reason: half a dozen things silently describe the extent of a world, and
 * none of them can be checked from a test without a renderer unless the world
 * publishes them. `scripts/tests/citadel-extent.test.mjs` reads this object AND
 * asserts by source regex that `_buildTerrain`, `_configureEnvironment` and
 * `_buildSky` consume it - publishing a layout the build keeps a second copy of
 * is worth exactly nothing.
 *
 * `coreHalf` is the line the ring may not cross. It is `INNER_KEEP`, imported
 * from the height field rather than repeated, because that is the number the
 * `ringMask` smoothstep is anchored on and the bit-identity digest is taken
 * against.
 */
export const CITADEL_LAYOUT = Object.freeze({
  half: HALF,
  size: SIZE,
  coreHalf: INNER_KEEP,
  terrainStep: TERRAIN_STEP,
  terrainSeg: TERRAIN_SEG,
  terrainTile: TERRAIN_TILE,
  /** The generation job `_buildTerrain` submits, verbatim. */
  terrainJob: Object.freeze({
    field: 'citadel',
    originX: -HALF,
    originZ: -HALF,
    size: SIZE,
    seg: TERRAIN_SEG,
    uv: 'unit',
    normals: true,
  }),
  walls: CONTAIN_WALLS,
  fogNear: FOG_NEAR,
  fogFar: FOG_FAR,
  skyRadius: SKY_R,
  /** Published vertical extent of `world.bounds`. */
  floorY: -10,
  ceilY: 90,
  /** C3's ceiling, re-exported so the budget test reads one number. */
  districtRadius: MAX_DISTRICT_RADIUS,
});

/* ------------------------------------------------------------------ */
/* Layout constants shared by more than one builder                    */
/* ------------------------------------------------------------------ */
/** Curtain wall: radius of its centre line, its thickness, its height. */
const WALL_R = 118;
const WALL_T = 2.6;
const WALL_H = 9;
/** Every roof in the souk overhangs its walls by this much on all four sides. */
const SOUK_LIP = 0.7;
/** Radius of the innermost souk ring. The inner ward is a 60 m square. */
const SOUK_R0 = 34;

/**
 * THE SOUK'S DIFFICULTY GRADIENT, AUTHORED.
 *
 * -- Why this table exists -------------------------------------------------
 *
 * The file header has always claimed "the gaps widen as you get closer to the
 * citadel ... that gradient is the difficulty curve". It was not true. The old
 * generator set `count = max(8, round(tau*r / 15))`, which pins tangential
 * CENTRE spacing to 14.8-15.4 m at every ring, and then let three independent
 * random terms decide the gap that actually mattered:
 *
 *   - `w = 8 + rnd()*5` and `d = 8 + rnd()*5`, so a pair of neighbours could
 *     differ by 10 m of footprint;
 *   - `a = ... + (rnd() - 0.5) * 0.06`, which at r = 103 is +/-3.1 m of
 *     tangential slop PER BUILDING, so +/-6 m on a gap;
 *   - `rotY = a` while the building was PLACED at `a`, which rotates the
 *     footprint frame at -2a relative to the ring, so the tangentially
 *     projected width was `|w cos| + |d sin|` and swung with compass bearing.
 *
 * Measured over the built world, the result was a mean tangential deck gap of
 * 2.01 m with a standard deviation of 2.03 m, 34 pairs physically OVERLAPPING,
 * a maximum of 7.99 m, and `pearson(ring, gap) = 0.1485`. Not a gradient: noise.
 *
 * -- What replaced it ------------------------------------------------------
 *
 * Three changes, in the order they matter.
 *
 * 1. **The footprint frame is now radial.** A box at `rotY = t` has its local
 *    +X at world `(cos t, -sin t)` and its local +Z at `(sin t, cos t)`. Set
 *    `t = pi/2 - a` and local +Z lands on `(cos a, sin a)` - straight out along
 *    the radius - so `w` is the building's TANGENTIAL width and `d` is its
 *    RADIAL depth, exactly and at every bearing. Every gap in the ring becomes
 *    a quantity this file can solve for instead of a quantity it discovers.
 *
 * 2. **The angular jitter is gone** and the footprint jitter is +/-0.25 m
 *    rather than +/-2.5 m. Variety comes from height, parapets, domes, awnings
 *    and colour, none of which touch the gap. A town whose difficulty is a
 *    dice roll is not a difficulty curve however pretty the dice are.
 *
 * 3. **`w` is derived from the gap, not the gap from `w`.** For two
 *    neighbours an angular pitch `D` apart on a ring of radius `r`, with roof
 *    lips `wLip` wide tangentially and `dLip` deep radially, the closest points
 *    are the two INNER corners of the facing edges and their separation is
 *
 *        gap = 2 r sin(D/2) - wLip cos(D/2) - dLip sin(D/2)
 *
 *    which inverts to the `w` computed below. Derived, then confirmed against
 *    `footprintGap`'s SAT measurement of the assembled world - the derivation
 *    is only allowed to stand because a probe agreed with it.
 *
 * -- The gradient itself ---------------------------------------------------
 *
 * Ring 0 is innermost. The budgets are the measured ones, and the margins
 * matter: a jump has to land 0.4 m inside the target lip to count, so the
 * usable reach of each budget is its flat distance minus 0.4.
 *
 *   walk    2.607 m flat, 0.878 m apex  ->  crosses up to 2.2 m
 *   sprint  4.647 m flat, 0.878 m apex  ->  crosses up to 4.25 m
 *   leap    7.569 m flat, 1.109 m apex  ->  crosses up to 7.17 m
 *
 * `deck` is the top of the roof lip above `MESA_Y`, and it is authored as
 * carefully as the gap, because a step UP taller than the apex is a wall
 * whatever the gap is:
 *
 *   rings 6,5,4  gaps 3.0-3.85 m, steps inward 0.7 m  ->  sprint clears both
 *   rings 3,2    gaps 5.1-5.7 m, steps inward 1.0 m   ->  the leap is required
 *   rings 1,0    gaps 6.2-6.6 m, steps inward >= 1.4 m and a saw-toothed ring
 *                                                     ->  leap, then a mantle
 *
 * `sawtooth` alternates the deck height of consecutive buildings by +/- that
 * much, which makes the uphill half of every inner-ring crossing a jump into a
 * wall - a grab and a mantle - while the downhill half stays a plain landing.
 * `count` is even on those two rings so the alternation closes on itself.
 */
const SOUK_RINGS = (() => {
  const spec = [
    { count: 12, gapT: 6.60, gapR: 5.4, deck: 14.2, sawtooth: 0.80, depth: 7.0 },
    { count: 18, gapT: 6.20, gapR: 4.8, deck: 12.0, sawtooth: 0.60, depth: 7.0 },
    { count: 22, gapT: 5.70, gapR: 3.9, deck: 10.0, sawtooth: 0, depth: 7.0 },
    { count: 28, gapT: 5.10, gapR: 3.4, deck: 9.0, sawtooth: 0, depth: 7.0 },
    { count: 34, gapT: 3.85, gapR: 2.9, deck: 8.0, sawtooth: 0, depth: 7.0 },
    { count: 40, gapT: 3.50, gapR: 2.4, deck: 7.3, sawtooth: 0, depth: 7.0 },
    { count: 46, gapT: 3.00, gapR: 0, deck: 6.6, sawtooth: 0, depth: 7.0 },
  ];
  let r = SOUK_R0;
  for (let k = 0; k < spec.length; k++) {
    const s = spec[k];
    s.ring = k;
    s.r = r;
    const dLip = s.depth + SOUK_LIP;
    const half = Math.PI / s.count;              // half the angular pitch
    s.w = (2 * r * Math.sin(half) - dLip * Math.sin(half) - s.gapT) / Math.cos(half) - SOUK_LIP;
    const next = spec[k + 1];
    if (next) r += s.gapR + (dLip + next.depth + SOUK_LIP) * 0.5;
  }
  return spec.map((e) => Object.freeze(e));
})();

/** Outer face of the outermost roof lip. Everything past this is the pomerium. */
const SOUK_OUTER_FACE = SOUK_RINGS[SOUK_RINGS.length - 1].r
  + (SOUK_RINGS[SOUK_RINGS.length - 1].depth + SOUK_LIP) * 0.5;
/**
 * The lane the haystacks under the rampart traversal line stand in.
 *
 * Halfway between the outer souk face and the inside of the curtain wall. It
 * used to be a literal 104, which the re-authored souk builds ON TOP of - the
 * hay would have been placed on a roof, which `_deckAt` would happily have
 * agreed with and no assertion in the world would have caught it.
 */
const RAMPART_HAY_R = (SOUK_OUTER_FACE + (WALL_R - WALL_T * 0.5)) * 0.5;

/**
 * The four houses whose interiors are built, keyed by something that survives
 * a layout change.
 *
 * They used to be keyed `${ring}:${i}` - `1:2`, `2:8`, `3:17`, `5:24` - which
 * is an index into a generated array. Change `count`, or change anything
 * upstream of the shared `rnd` stream, and `i` names a different building or
 * no building at all; `_nudgeClear`'s docstring records that this has already
 * happened TWICE, both times leaving NPCs standing inside walls. A bearing is
 * stable under every one of those changes: the nearest surviving building to a
 * compass direction is the same house whatever the ring count is.
 *
 * The bearings are the ones the old indices resolved to, so the four interiors
 * stay roughly where they have always been. None of them is near the
 * processional corridor at +Z (90 deg), which is cleared at every ring.
 */
const ENTERABLE_SITES = Object.freeze([
  Object.freeze({ ring: 1, bearing: 56 * DEG, label: 'Spice Merchants House', flipDoor: true }),
  Object.freeze({ ring: 2, bearing: 151 * DEG, label: 'Scribes Courtyard House', flipDoor: false }),
  Object.freeze({ ring: 3, bearing: 257 * DEG, label: 'Carpet Loom House', flipDoor: false }),
  Object.freeze({ ring: 5, bearing: 305 * DEG, label: 'Dyers Roof House', flipDoor: false }),
]);

/** Half-width of the processional corridor, in radians. Cleared at every ring. */
const CORRIDOR_HALF = 0.26;
/** Bearing of the gate, and so of the corridor. +Z. */
const GATE_BEARING = Math.PI * 0.5;

/* `terrainH` and the mesa constants live in `terrain/CitadelHeight.js` (imported
 * at the top of this file) so the generation worker can sample this ground
 * without importing `three` and the rest of this world. It is still the single
 * source of truth for the shape of the terrain - the visible heightfield, the
 * collision that backs it and every prop placement all read that one function.
 *
 * That mattered enough to be worth the indirection: this slope was previously
 * three separate approximations of itself, they disagreed, and where the
 * collision sat lower than the mesh the player walked *underneath* the visible
 * world across 7% of sampled positions, by as much as 13 m. */

/**
 * Limewash and mudbrick. Sampled from sun-bleached North African towns, where
 * the range is narrow in hue and wide in lightness - which is exactly what
 * stops a procedural town looking either monotone or like a paint chart.
 */
const WASH = [
  0xe8dcc0, 0xdfd0ae, 0xd6c49e, 0xcbb68d, 0xe3d2b2,
  0xd8c8a8, 0xc9b489, 0xecdfc4, 0xd2bd97, 0xdcccA6,
  0xc6ae86, 0xe6d8bb, 0xd9c9a2, 0xcfbb92,
];

/**
 * Metres of world covered by one texture tile, per material family.
 *
 * These are the values each surface was *authored* for - the shared library
 * publishes the same numbers as `userData.tileMeters` - and re-projecting the
 * batched UVs against them is what finally makes the maps visible at the right
 * size. Ashlar courses come out a hand's width tall on a wall and stay that
 * size on a cliff step forty times bigger.
 *
 * The one deliberate departure is plaster, tiled tighter than the library's
 * default: a souk house is rendered mud, and at 3 m the render reads as a
 * poured concrete panel.
 */
const TILE_METRES = (key) => {
  switch (key.split(':')[0]) {
    case 'stone.castle': return 2.4;
    case 'plaster.wall': return 1.8;
    case 'stone.cobble': return 2.0;
    case 'dirt.ground': return 5.0;
    case 'roof.tile': return 1.6;
    case 'thatch.roof': return 1.4;
    case 'wood.beam': return 1.2;
    case 'wood.plank': return 1.5;
    // Banners and awnings carry a printed pattern rather than a material
    // grain; re-projecting them would slide the pattern across the cloth.
    case 'fabric.banner': return 0;
    default: return 0;
  }
};

/**
 * One storage jar, lathed once and cloned per placement.
 *
 * Built lazily and cached at module scope because the souk places sixty or so
 * of them and the profile never changes; `Batch.add` consumes what it is given,
 * so every caller clones.
 *
 * A jar is a surface of revolution, which is the shape a swept profile is GOOD
 * at - so it is procedural here rather than authored in `citadel.glb`. That is
 * decision D4's split stated from the other side, and it is the reason the
 * `.glb` contains an arch, a pierced screen and a corbel course and does not
 * contain a pot: authoring one would have been authoring what the tooling
 * already does well.
 *
 * Eight radial segments, not sixteen. These stand on roofs, are read from a
 * rooftop or a tower, and are 0.9 m tall: eight facets on a 0.3 m radius is a
 * 5.7 cm chord, under a pixel past nine metres. Sixteen would double the
 * largest procedural line this pass adds to make a silhouette nobody resolves
 * rounder.
 */
let _jarGeo = null;
function jarGeometry() {
  if (_jarGeo) return _jarGeo;
  const profile = [
    new THREE.Vector2(0.0, 0.0),
    new THREE.Vector2(0.14, 0.0),
    new THREE.Vector2(0.22, 0.12),
    new THREE.Vector2(0.30, 0.38),
    new THREE.Vector2(0.24, 0.62),
    new THREE.Vector2(0.13, 0.78),
    new THREE.Vector2(0.16, 0.88),
    new THREE.Vector2(0.13, 0.92),
  ];
  _jarGeo = new THREE.LatheGeometry(profile, 8);
  return _jarGeo;
}

/** Weathered sandstone, for the cliff the mesa stands on. */
const CLIFF = [0xc0ad86, 0xb6a37c, 0xcab791, 0xac9a73, 0xc4b088, 0xbaa87f];

/** One of `list`, with a small per-pick lightness jitter so no two repeat exactly. */
function pick(rnd, list) {
  const base = list[(rnd() * list.length) | 0];
  const f = 0.9 + rnd() * 0.2;
  const r = Math.min(255, ((base >> 16) & 255) * f) | 0;
  const g = Math.min(255, ((base >> 8) & 255) * f) | 0;
  const b = Math.min(255, (base & 255) * f) | 0;
  return (r << 16) | (g << 8) | b;
}

/** Deterministic PRNG - a world has to regenerate identically every session. */
function mulberry32(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Geometry accumulator.
 *
 * Collects transformed geometries per material key and merges each bucket into
 * a single mesh. Worlds in this project live or die on draw-call count; the
 * souk alone is ~1400 boxes and would be unshippable one mesh at a time.
 */
class Batch {
  /**
   * @param {{ao?:number, sky?:number, grime?:number, span?:number}} [shade]
   *   Baked vertex shading applied to every geometry added to this batch.
   *   - `ao`     how dark the foot of a surface goes (0..1)
   *   - `sky`    how much a downward-facing surface loses relative to an
   *              upward-facing one - a one-line hemispheric occlusion term
   *   - `grime`  warm-to-cool shift applied with the AO, so the dark end is
   *              dirt rather than simply less light
   *   - `span`   metres over which the AO fades out from the foot
   */
  /**
   * @param {{ao?:number, sky?:number, grime?:number, span?:number}} [shade]
   * @param {(key:string)=>number} [tiles] metres one texture tile covers, per
   *   material key. Returning 0 leaves the geometry's own UVs alone.
   */
  constructor(shade = null, tiles = null) {
    /** @type {Map<string, THREE.BufferGeometry[]>} */
    this.buckets = new Map();
    this._owned = [];
    this.shade = shade;
    this.tiles = tiles;
  }

  /**
   * @param {string} key material key
   * @param {THREE.BufferGeometry} geo consumed - do not reuse after this
   * @param {THREE.Matrix4} matrix world transform
   * @param {number} [tint] optional per-vertex tint
   */
  add(key, geo, matrix, tint = null) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    // Strip anything the merge cannot reconcile: mergeGeometries returns null
    // if two inputs disagree about which attributes exist.
    for (const k of Object.keys(g.attributes)) {
      if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    }
    g.applyMatrix4(matrix);

    /* Re-project the UVs into world space.
     *
     * ── Why every surface in this world was smooth ────────────────────────
     *
     * The materials here have always carried a full PBR set - albedo, normal,
     * roughness, AO. They just could not be seen. A BoxGeometry's UVs run 0..1
     * across each face whatever the face measures, and the material tiles at
     * repeat 1, so a single tile of stone was stretched across an entire 20 m
     * wall while the same tile was crammed onto a 20 cm sill. The detail was
     * present at every scale except the one that would have made it visible,
     * and the town read as clean flat plaster.
     *
     * A shared material cannot fix this with `repeat`, because these boxes are
     * merged into one mesh and every one of them is a different size. The scale
     * has to live in the geometry, so the UVs are recomputed from world
     * position: planar projection onto whichever axis each face points along,
     * divided by the metres one tile is authored for. Texel density then comes
     * out identical on a cliff step and a window sill, which is the whole
     * point.
     */
    const tile = this.tiles?.(key) ?? 0;
    if (tile > 0) {
      const posA = g.attributes.position;
      const nrmA = g.attributes.normal;
      const n = posA.count;
      const uv = new Float32Array(n * 2);
      const inv = 1 / tile;
      for (let i = 0; i < n; i++) {
        const x = posA.getX(i);
        const y = posA.getY(i);
        const z = posA.getZ(i);
        const nx = nrmA ? Math.abs(nrmA.getX(i)) : 0;
        const ny = nrmA ? Math.abs(nrmA.getY(i)) : 1;
        const nz = nrmA ? Math.abs(nrmA.getZ(i)) : 0;
        let u; let v;
        if (ny >= nx && ny >= nz) { u = x; v = z; }        // floors and roofs
        else if (nx >= nz) { u = z; v = y; }               // walls facing X
        else { u = x; v = y; }                             // walls facing Z
        uv[i * 2] = u * inv;
        uv[i * 2 + 1] = v * inv;
      }
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    }
    /* Always written, white when no tint was asked for.
     *
     * Two reasons it cannot be conditional. `mergeGeometries` returns null the
     * moment two inputs disagree about which attributes exist, so one untinted
     * box would silently drop its whole district. And the materials here run
     * with `vertexColors` on, where a *missing* colour attribute reads as zero
     * rather than as one - the geometry would come out black rather than
     * untinted. */
    _color.set(tint === null ? 0xffffff : tint);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);

    /* Baked vertex shading.
     *
     * Everything in this world is a box, and a box lit by one sun is four flat
     * rectangles - the town reads as cardboard no matter how good the material
     * is. Two cheap per-vertex terms fix that for the whole world at once:
     *
     *   AO    darkens the foot of every surface, so buildings sit *in* the
     *         ground instead of resting on top of it, and alleys gain the
     *         contact shadow that no dynamic light will ever draw for 1400
     *         boxes.
     *   Sky   darkens downward-facing faces against upward-facing ones. It is
     *         a one-line hemispheric occlusion term, and it is what separates
     *         the underside of a lintel from its top.
     *
     * Both are free at runtime - they are just the colour attribute that had to
     * be written anyway - and they survive the merge into a single mesh, which
     * a light never could. */
    const sh = this.shade;
    if (!sh) {
      for (let i = 0; i < n; i++) {
        col[i * 3] = _color.r;
        col[i * 3 + 1] = _color.g;
        col[i * 3 + 2] = _color.b;
      }
    } else {
      const posA = g.attributes.position;
      const nrmA = g.attributes.normal;
      const ao = sh.ao ?? 0;
      const sky = sh.sky ?? 0;
      const grime = sh.grime ?? 0;
      const span = sh.span ?? 2.2;
      // Foot of *this* piece, in world space - so a roof lip is shaded from its
      // own underside, not from the ground 20 m below it.
      let minY = Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < n; i++) {
        const y = posA.getY(i);
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      /* Never run the gradient over more than the piece is tall.
     *
       * The span is chosen for walls, and a wall is metres high, so the darkest
       * part of the ramp lands at its foot and the rest is clean. Applied
       * unchanged to something thin - a palm frond is 9 cm thick - the whole
       * piece sits inside the first 4% of the ramp and comes out uniformly at
       * the *bottom* of it. The palms rendered as black silhouettes for exactly
       * this reason. Clamping the span to the piece's own height gives thin work
       * a dark underside and a lit top, which is what was wanted from it. */
      const s = Math.min(span, Math.max(maxY - minY, 0.02));

      for (let i = 0; i < n; i++) {
        const t = clamp01((posA.getY(i) - minY) / s);
        // smoothstep, so the gradient has no visible band where it ends
        const rise = t * t * (3 - 2 * t);
        let f = 1 - ao * (1 - rise);
        if (nrmA) {
          const ny = nrmA.getY(i);
          f *= 1 - sky * (1 - (ny * 0.5 + 0.5));
        }
        // Dirt is cooler as well as darker; scaling blue least would *warm* the
        // shadows, which is the opposite of how a shaded wall photographs.
        const d = (1 - f) * grime;
        col[i * 3] = _color.r * f * (1 - d * 0.15);
        col[i * 3 + 1] = _color.g * f * (1 - d * 0.06);
        col[i * 3 + 2] = _color.b * f;
      }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    let list = this.buckets.get(key);
    if (!list) this.buckets.set(key, (list = []));
    list.push(g);
  }

  /**
   * Convenience for the overwhelmingly common case: an axis-aligned box.
   *
   * Bevelled, not square. A hard 90-degree edge returns exactly one shade to
   * the camera, so a town built from plain boxes has no edges in it at all -
   * just flat panels meeting at invisible seams, which is what "blocky" really
   * describes. A few centimetres of round on every edge gives each one a
   * highlight on the sunward side and a dark line away from it, and every
   * silhouette in the world stops being a cut-out.
   *
   * Only the pieces big enough for it to read.
   *
   * A bevelled box costs 108 triangles against a plain one's 12, and this world
   * emits something like twelve thousand of them - the window trim alone is
   * nine thousand. Bevelling all of it cost three million triangles and half the
   * frame rate to round the edges of sills a few centimetres across, which
   * nobody can see. Above the threshold it is walls, roofs, towers and cliff
   * steps: the silhouettes the eye actually reads. Below it, trim stays square
   * and free.
   *
   * The radius is clamped against the smallest dimension regardless, because a
   * bevel wider than the piece it is rounding turns the piece inside out.
   */
  box(key, w, h, d, x, y, z, rotY = 0, tint = null) {
    _e1.set(0, rotY, 0);
    _q1.setFromEuler(_e1);
    _v1.set(x, y, z);
    _v2.set(1, 1, 1);
    _m1.compose(_v1, _q1, _v2);
    const min = Math.min(w, h, d);
    const r = Math.min(BEVEL, w * 0.22, h * 0.22, d * 0.22);
    const geo = min >= BEVEL_MIN && r > 0.02
      ? new RoundedBoxGeometry(w, h, d, 1, r)
      : new THREE.BoxGeometry(w, h, d);
    this.add(key, geo, _m1, tint);
  }

  /**
   * Merge every bucket into the group.
   * @param {THREE.Group} group
   * @param {(key:string) => THREE.Material} resolve
   * @param {string} name
   * @param {{cast?:boolean, recv?:boolean}} [opts]
   */
  flush(group, resolve, name, { cast = true, recv = true } = {}) {
    const out = [];
    for (const [key, list] of this.buckets) {
      if (!list.length) continue;
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) {
        console.warn(`[CitadelWorld] merge failed for "${key}" in ${name}`);
        continue;
      }
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, resolve(key));
      mesh.name = `${name}:${key}`;
      mesh.castShadow = cast;
      mesh.receiveShadow = recv;
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

function prepDynamicGeo(geo, key, tint = 0xffffff) {
  const tile = TILE_METRES(key) || 0;
  if (tile > 0) {
    const posA = geo.attributes.position;
    const nrmA = geo.attributes.normal;
    const uv = new Float32Array(posA.count * 2);
    const inv = 1 / tile;
    for (let i = 0; i < posA.count; i++) {
      const x = posA.getX(i);
      const y = posA.getY(i);
      const z = posA.getZ(i);
      const nx = nrmA ? Math.abs(nrmA.getX(i)) : 0;
      const ny = nrmA ? Math.abs(nrmA.getY(i)) : 1;
      const nz = nrmA ? Math.abs(nrmA.getZ(i)) : 0;
      let u; let v;
      if (ny >= nx && ny >= nz) { u = x; v = z; }
      else if (nx >= nz) { u = z; v = y; }
      else { u = x; v = y; }
      uv[i * 2] = u * inv;
      uv[i * 2 + 1] = v * inv;
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  _color.set(tint);
  const col = new Float32Array(geo.attributes.position.count * 3);
  for (let i = 0; i < geo.attributes.position.count; i++) {
    col[i * 3] = _color.r;
    col[i * 3 + 1] = _color.g;
    col[i * 3 + 2] = _color.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

export class CitadelWorld extends World {
  static id = 'citadel';
  static displayName = 'Sunspire Citadel';

  constructor(ctx) {
    super(ctx);
    this.rnd = mulberry32(0x5175ce);

    /** Roof platforms, so relics and rope bridges can be placed on real surfaces. */
    this._roofs = [];
    /**
     * Every stair tread in the world, published for one reason: a reachability
     * probe cannot see a flight of steps.
     *
     * `scripts/tests/citadel-reach.test.mjs` builds its terrain nodes on a 6 m
     * lattice, and a tread is 1.3 m of run - a whole flight falls between two
     * darts, and the darts that do land on one are metres of height apart, so
     * no walk edge is ever drawn along it. Before this array existed, five
     * Deepworks decks and all three of Ashfall's fallen floors measured as
     * "reachable, with no way back", and the way back was a staircase sitting
     * in the collider set that nothing was looking at. It is NOT read by
     * `Relics`: a tread is not a hiding place.
     */
    this._steps = [];
    /** Tower tops: the anchors for rope bridges and the best relic sites. */
    this._towers = [];
    /** Haystack positions - the landing sites that make a leap of faith survivable. */
    this.haystacks = [];
    /**
     * Viewpoints: high, isolated, and worth the climb.
     *
     * Each entry carries more than a label, and every field has a consumer:
     *   `id`               stable key for save data and the map reveal
     *   `x, y, z`, `r`     the platform, and how big it is
     *   `launch`           the exact point a leap of faith leaves from
     *   `bearing`          the direction it leaves on - NOT the radial bearing
     *   `hay`              the haystack that answers it, resolved during the
     *                      build to `{x, y, z, r}` on a real surface
     */
    this.viewpoints = [];
    /** Rope-bridge spans, published so nothing has to re-derive the generator. */
    this.ropeBridges = [];
    /** Trial venues; see `_publishVenues`. */
    this.minigameVenues = [];
    /**
     * High places nominated for a cache, one per outer region.
     *
     * `Caches._findHigh` is a UNIFORM DART at `contentBounds`, and a uniform
     * dart spends its budget on AREA rather than on content. Measured on this
     * world before the list existed: nine caches, SEVEN of them on the old
     * mesa and two on the aqueduct, with the Undercliff, the Deepworks,
     * Ashfall, the Eyrie and the Caravanserai holding none at all. The log read
     * "0 sunken, 9 high" and every one of the nine was a real high place - the
     * defect was invisible from inside `Caches`.
     *
     * Every coordinate below was FOUND rather than chosen: a 2 m lattice over
     * each region's own AABB, scored by `Caches._highAt` (the same predicate
     * the dart has to satisfy) and filtered to the reachable component, then
     * the clearest one taken. `Caches` re-runs that predicate against the real
     * colliders on load and refuses anything that no longer passes, so this is
     * a list of places to LOOK and never a licence to skip the test.
     *
     * The Caravanserai's entry is its mast, and that is not laziness: the
     * region is the tier-0 rest stop on the flattest ground in the world and
     * the lattice found exactly ONE point in it with a 7 m drop on five sides.
     */
    this.cacheSites = [];

    /**
     * THE TRAFFIC CONTRACT, declared empty here so a world that has not built
     * yet reads as empty rather than as undefined.
     *
     * `citadel-traffic-kit.caravanContent` reads both of these off the world
     * and scores them against five floors on ENCOUNTER; `_buildTraffic` fills
     * them. `oases` carries the two stepped tanks AND the eight wayside wells,
     * distinguished by `kind`, because what the encounter measurement means by
     * an oasis is "a static herd standing at a place with a radius" and both
     * are that - see `citadel/Caravans.js` for why the ground allows two of the
     * first and needed eight of the second.
     * @type {Array<{id:string,label:string,kind:string,x:number,y:number,z:number,r:number,herd:number}>}
     */
    this.oases = [];
    /** @type {Array<{id:string,points:Array<{x:number,y:number,z:number}>,trains:number,animals:number}>} */
    this.caravanRoutes = [];
    /**
     * The streamed cast: drovers, herd keepers, lone travellers and the oasis
     * staff. Named `_population` because that is the property
     * `npc-routes.test.mjs` audits routes off. @see CitadelTraffic
     * @type {import('./citadel/Caravans.js').CitadelTraffic|null}
     */
    this._population = null;

    this._owned = [];
    this._time = 0;
    this._banners = [];
    /** The sky dome, which rides with the camera. See `SKY_R`. */
    this._skyDome = null;
    /**
     * Distance LOD over the split districts and the terrain tiles.
     *
     * Constructed here rather than in `build` so `update` and `dispose` can
     * reference it unconditionally, and so a world that failed mid-build still
     * disposes cleanly. Nothing is registered until `_registerLod` runs, and
     * `DistanceLod.update` over an empty registry is a no-op.
     */
    this._lod = new DistanceLod();
    /** The terrain tiles, and what each one's own lo band was solved to be. */
    this._terrainTiles = [];
    this._terrainSwap = [];
    /** What `_registerLod` did, so the budget test reads it rather than a log. */
    this._lodReport = null;
    /** Split districts, in the order they were emitted. */
    this._districts = [];

    this._configureEnvironment();
  }

  /* ================================================================== */
  /* Environment                                                         */
  /* ================================================================== */

  _configureEnvironment() {
    const env = this.environment;
    // Late afternoon, raking hard across the stone. A low sun is what gives a
    // climbing world its readability: every ledge casts a line.
    env.background = new THREE.Color(0x9fb8d4);
    env.fogColor = new THREE.Color(0xc9c0a8);
    env.fogNear = CITADEL_LAYOUT.fogNear;
    env.fogFar = CITADEL_LAYOUT.fogFar;
    env.exposure = 1.0;
    /* Shadow colour is the whole difficulty of a desert scene.
     *
     * The first pass used a cool blue-grey ambient, which is what daylight
     * physically is - and over red-brown ground it rendered every shadow
     * *purple*. Real sun-baked stone bounces a great deal of warm light back
     * into its own shade, so the fill here is warm and the sky term carries the
     * cool. Shadows land brown rather than violet, and the town stops looking
     * like it is lit through a bruise. */
    env.ambientColor = new THREE.Color(0xa8977f);
    env.ambientIntensity = 0.7;
    env.skyColor = new THREE.Color(0xa8c6e6);
    env.groundColor = new THREE.Color(0xc9a173);   // hot sand bouncing upward
    env.hemiIntensity = 1.15;
    env.sunColor = new THREE.Color(0xffddA6);
    env.sunIntensity = 5.9;
    env.sunDirection = new THREE.Vector3(0.55, 0.42, 0.72).normalize();
    env.envMapIntensity = 1.0;
    env.bloom = { strength: 0.42, radius: 0.5, threshold: 0.92 };
    env.envMap = this.materials?.getEnvMap?.('daylight') ?? undefined;
  }

  /* ================================================================== */
  /* Build                                                               */
  /* ================================================================== */

  /**
   * ── Why the long phases are handed a `breathe` ─────────────────────────────
   *
   * `report` is only reachable BETWEEN phases, and this world's phases are not
   * small. `_buildSouk` alone is one ~190-iteration synchronous block emitting
   * ~5,500 boxes and ~2,500 colliders, measured at 192 ms - and Citadel is not
   * built behind the loading screen. `scheduleBackgroundBuilds` (`main.js:1297`,
   * called from `:731`) starts it AFTER the gate opens, in the player's frames,
   * so 192 ms is a 192 ms frame in live gameplay. C5's budget is 24 ms.
   *
   * `WorldManager` publishes exactly the relay for this as `report.slice`
   * (`:277`), sharing `report`'s own 24 ms clock so a phase that slices and a
   * build that steps do not each spend a budget of their own, and returning
   * immediately when `engine.running` is false - behind a loading screen every
   * yield is wall clock added to the boot for no visible gain. `StationWorld`
   * has used it through `breathe()` since its own set-dressing pass measured
   * 3.2 s; this world had never called it.
   *
   * Each phase takes its own `breathe`, closed over that phase's progress
   * fraction and label, so a phase never has to know where in the build it sits.
   */
  async build(onProgress) {
    const report = onProgress ?? (() => {});
    const slice = onProgress?.slice;
    const breathe = (f, label) => (slice ? () => slice(f, label) : noBreath);

    await report(0.02, 'Hanging the sky');
    this._buildSky();

    /* The authored architecture, started here and awaited after the terrain.
     *
     * Started rather than awaited, because the mesa is the longest phase in
     * the build and a 35 KB fetch has no business sitting in front of it. And
     * awaited rather than left to resolve whenever, because `_buildCurtainWall`
     * is the first consumer and a part that arrives one phase late is a gate
     * with no arch on it and no error anywhere.
     *
     * `loadCitadelAssets` never rejects. Under `node --test` there is no fetch
     * to a relative URL at all, so this resolves to an empty map and every
     * placement below falls back to the rectangle the world drew before this
     * pass - which is exactly what every headless budget test in the citadel
     * suite measures, and why `citadel-assets.test.mjs` installs the real
     * committed bytes and builds the world a SECOND time to price them. */
    const assets = loadCitadelAssets();

    await report(0.06, 'Raising the mesa');
    await this._buildTerrain(breathe(0.06, 'Raising the mesa'));
    await assets;

    await report(0.2, 'Laying the curtain wall');
    await this._buildCurtainWall(breathe(0.2, 'Laying the curtain wall'));

    await report(0.34, 'Building the souk');
    await this._buildSouk(breathe(0.34, 'Building the souk'));

    await report(0.54, 'Raising the citadel');
    await this._buildCitadel(breathe(0.54, 'Raising the citadel'));

    await report(0.66, 'Stringing the rope bridges');
    await this._buildRopeBridges(breathe(0.66, 'Stringing the rope bridges'));

    await report(0.74, 'Scattering the hay');
    await this._buildDressing(breathe(0.74, 'Scattering the hay'));

    await report(0.86, 'Opening the gate');
    this._fillSpawns();

    await report(0.88, 'Settling the outer ring');
    await this._buildRegions(breathe(0.88, 'Settling the outer ring'));

    /* AFTER the ring, because the floorplan has to contain it and the tower
     * dots have to include its five landmarks. See `_publishMinimap`. */
    this._publishMinimap();

    /* Split LAST, and in one pass over the whole world.
     *
     * Two reasons, both measured. `splitDistricts` costs 57-69 ms cold and its
     * ordering rule - smallest district first - is what keeps any single mesh
     * inside the slice budget, and that rule can only be applied to a set that
     * is complete. Splitting each batch as it flushed would have put the cliff,
     * the largest thing in the world, through a cold JIT first, which is the
     * 32.5 ms case rather than the 18.2 ms one. */
    await report(0.9, 'Dividing the wards');
    await this._splitDistricts(breathe(0.9, 'Dividing the wards'));
    /* World matrices BEFORE the registration. `registerDistricts` reads each
     * mesh's sphere through `sourceSphere`, which transforms the geometry's by
     * `matrixWorld` exactly as `DistanceLod.add` does - and every bucket here
     * carries world-space positions under an identity transform, so this is a
     * no-op today and a correct one the day the group is ever moved. */
    this.group.updateMatrixWorld(true);
    this._registerLod();

    this.group.matrixAutoUpdate = false;
    this.group.updateMatrixWorld(true);
    this.group.visible = this.active;
    await report(1, 'Citadel ready');
  }

  /**
   * A shared-library material, re-tinted for this world.
   *
   * Two things are going on and both are necessary.
   *
   * The library's stone is a cold northern grey, which is right for a keep in
   * the rain and wrong for a citadel baking on a mesa - dropped in unchanged
   * the whole town photographs blue. Each key therefore gets a warm base
   * colour, which costs nothing because a tint is a uniform.
   *
   * And `vertexColors` has to be switched on, or the per-building variation
   * every `Batch.box` call writes is silently discarded: the attribute is in
   * the geometry, the shader never reads it, and four hundred houses come out
   * identical. That was the first version of this world.
   *
   * Cloning is what makes both possible without touching the shared instance
   * the other three worlds are drawn with. Clones share texture storage, so the
   * only real cost is one extra shader program per key.
   */
  /**
   * @param {string} key
   * @param {{vertexColors?:boolean}} [opts] pass `vertexColors: false` for
   *   geometry that carries no colour attribute - notably the instanced trees.
   *   A material with `vertexColors` on and nothing to read renders black,
   *   which is the same trap the batched geometry hit early on.
   */
  _mat(key, opts = {}) {
    const vc = opts.vertexColors !== false;
    this._matCache ??= new Map();
    const cacheKey = vc ? key : `${key}|novc`;
    const hit = this._matCache.get(cacheKey);
    if (hit) return hit;

    const base = this.materials.get(key);
    const m = base.clone();
    m.name = `citadel.${key}`;
    m.vertexColors = vc;
    // Sun-bleached limestone and mudbrick, per surface family.
    /* These multiply the per-box vertex colour, so they have to stay near white.
     *
     * Both ends of this were authored as if they were the only one: `Batch.box`
     * callers pass the actual colour they want the piece to be, and these were
     * written as colours too. Two mid-tones multiplied give a third much darker
     * than either - wood.beam at 0xb9946a against a 0x8a6a45 trunk resolved to
     * 0x3e2712, which is why the palms and every beam in the world came out
     * nearly black. Their job is a warm shift, not a colour. */
    const TINT = {
      'stone.castle': 0xf4ecd8,
      'plaster.wall': 0xf6ecd6,
      'stone.cobble': 0xe8ddc2,
      'wood.beam': 0xf0e2cc,
      'wood.plank': 0xf2e4cc,
      'roof.tile': 0xeae2d0,
      'thatch.roof': 0xffe9a8,
      'fabric.banner': 0xffffff,
      'dirt.ground': 0xe0cda3,
      // Date palm, not meadow: the library's grass is a temperate green and a
      // desert frond is grey-olive. Same material, one tint apart.
      'grass.field': 0xdce8c0,
    };
    const t = TINT[key.split(':')[0]];
    if (t !== undefined) m.color = new THREE.Color(t);
    this._matCache.set(cacheKey, m);
    this._owned.push(m);
    return m;
  }

  /* ------------------------------------------------------------------ */
  /* Sky                                                                 */
  /* ------------------------------------------------------------------ */

  /* ================================================================== */
  /* Districts: the spatial split, and the LOD that only works after it  */
  /* ================================================================== */

  /**
   * Flush a batch into the scene and remember what came out.
   *
   * Every builder used to call `B.flush(this.group, ...)` directly and throw
   * the return value away, which meant nothing in this world knew what its own
   * districts were. They are collected here and split in one pass at the end of
   * the build - see `_splitDistricts` for why one pass and not seven.
   *
   * @param {Batch} B
   * @param {string} name
   * @param {{cast?:boolean, recv?:boolean}} [opts]
   */
  _emit(B, name, opts = {}) {
    const out = B.flush(this.group, (k) => this._mat(k), name, opts);
    for (const m of out) {
      this._districts.push(m);
      /* The world owns the merged geometry, and it did not before. `Batch` puts
       * it on its OWN `_owned` and every builder calls `B.dispose()` on the next
       * line - which fires the dispose event on a geometry that is live in the
       * scene and has not been uploaded yet, so it is a no-op that also drops
       * the only reference anything held to it. The district then survived the
       * world's own `dispose` and its buffers were never freed. */
      this._owned.push(m.geometry);
    }
    return out;
  }

  /**
   * Place one authored part into a batch, or say it is not there.
   *
   * ── Every line of this is a cost rule ────────────────────────────────────
   *
   * `citadelPart` returns null when the `.glb` did not load, which is the case
   * in every headless test that does not install it and the case for a player
   * whose download failed. The caller draws the rectangle it always drew, so a
   * missing asset is a plainer town rather than a hole in one.
   *
   * The bind is re-checked HERE as well as in the loader, against the batch
   * this call is actually adding to. The loader can only check what the
   * manifest claims; this checks the call site, and the two together are why a
   * part can never open a bucket `Batch.flush` would turn into another mesh.
   *
   * `.clone()` is not defensive tidiness: `Batch.add` converts to non-indexed,
   * deletes attributes, applies the matrix IN PLACE and disposes the original.
   * The master is cached for the session and placed a few hundred times, so
   * handing it over once would leave every arch after the first building from
   * freed buffers.
   *
   * @param {Batch} B
   * @param {string} key one of `CITADEL_PART_KEYS`
   * @param {string} batchName the name `_emit` will flush this batch under
   * @param {THREE.Matrix4} matrix world placement
   * @param {number} [tint] per-vertex tint, exactly as `Batch.box` takes one
   * @returns {boolean} false when nothing was placed
   */
  _authored(B, key, batchName, matrix, tint = null) {
    const part = citadelPart(key);
    if (!part) return false;
    if (!CITADEL_WELDABLE.includes(`${batchName}:${part.slot}`)) return false;
    B.add(part.slot, part.geometry.clone(), matrix, tint);
    /* Counted, because a placement rule that stops firing is otherwise silent.
     * A part that loads and is never used passes every cost assertion in
     * `citadel-assets.test.mjs` - zero meshes, zero materials, zero colliders -
     * and is a manifest entry pretending to be art. The test holds each key
     * against a floor rather than an exact number, because the counts follow
     * `SOUK_RINGS` and the minaret count and neither belongs to that file. */
    this._authoredCount = (this._authoredCount ?? 0) + 1;
    (this._authoredBy ??= {})[key] = (this._authoredBy[key] ?? 0) + 1;
    return true;
  }

  /**
   * One piece of rooftop life per roof, so the world's play surface is a place.
   *
   * ── THE RANDOM STREAM IS NOT TOUCHED, AND THAT IS THE WHOLE PREAMBLE ─────
   *
   * `_buildSouk` shares one `this.rnd` with the palms, the stalls, the pottery,
   * the carts and the crates. Drawing from it here would move every prop in the
   * town and, worse, would move the +-0.25 m footprint jitter of every building
   * placed after this one - and the footprint is what `SOUK_RINGS` solves the
   * gap spectrum from. The extent stage measured exactly this failure when one
   * clipping literal changed how many draws the dune loop took and the whole
   * town moved. So this takes a LOCAL `mulberry32` seeded from the building's
   * own (ring, index): deterministic, reproducible, and invisible to everything
   * outside this method.
   *
   * ── NO COLLIDERS, AND WHERE IT IS ALLOWED TO STAND ──────────────────────
   *
   * Every gap, reach, landing and route measurement in the citadel suite is
   * taken against the colliders. Art may not move a route, so nothing here has
   * a body - the same rule the parapet stubs above already live by, and for the
   * same reason: a solid on a deck is a wall across the middle of a landing.
   *
   * It is also kept off two places by construction. The roof LIP is where a
   * jump lands, so nothing goes past 62% of the half-extent; and the roof
   * CENTRE is where `_deckSpot` resolves standing spots and where
   * `_publishVenues` puts rooftop-trial points, so nothing sits inside 30%. One
   * feature per roof, in the band between.
   *
   * ── WHY ONE FEATURE AND NOT A SET ───────────────────────────────────────
   *
   * Triangles. There are ~190 roofs; at four features each this is the third
   * largest thing in the world. One feature per roof, drawn from five kinds, is
   * ~18,000 triangles across the whole souk and still gives any rooftop view
   * five different silhouettes to read a route against.
   *
   * @param {Batch} B
   * @param {number} ring
   * @param {number} idx building index on the ring
   * @param {number} px world centre
   * @param {number} pz world centre
   * @param {number} deckY top of the roof lip
   * @param {number} w tangential footprint
   * @param {number} d radial footprint
   * @param {number} rot the building's own yaw
   */
  _roofLife(B, ring, idx, px, pz, deckY, w, d, rot) {
    const rng = mulberry32(ring * 977 + idx * 31 + 17);
    const cs = Math.cos(rot);
    const sn = Math.sin(rot);
    /* Local (lx, lz) -> world, in the building's own frame. Same expression
     * `_buildProps` uses for its stalls; a detail offset by the RADIUS instead
     * lands in the air beside its own roof, which is the mistake the parapet
     * and awning comments above are both about. */
    const wx = (lx, lz) => px + cs * lx + sn * lz;
    const wz = (lx, lz) => pz - sn * lx + cs * lz;
    // The band: outside the venue/standing centre, inside the landing lip.
    const bx = (w * 0.5) * (0.30 + rng() * 0.32) * (rng() < 0.5 ? -1 : 1);
    const bz = (d * 0.5) * (0.30 + rng() * 0.32) * (rng() < 0.5 ? -1 : 1);
    const yaw = rot + rng() * TAU;

    /* The one saturated palette in a town that is otherwise nine shades of
     * sand. `desert-overview` and `tower-top` are both monochrome pictures, and
     * cloth is the only thing on a roof that has any business being a colour. */
    const CLOTH = [0xc4472e, 0x2f6ba8, 0x2f7a55, 0xb8892a, 0x8a4a7a, 0xd8d0c0];

    const kind = (rng() * 5) | 0;
    if (kind === 0) {
      /* Water jars. The one lathe in this method, and the only rooftop object
       * that is not a box: a storage jar is a surface of revolution, which is
       * the shape a swept profile is GOOD at - so it is procedural here rather
       * than authored in the `.glb`, which is decision D4's split stated the
       * other way round. */
      const n = 2 + ((rng() * 2) | 0);
      for (let j = 0; j < n; j++) {
        const jx = bx + (rng() - 0.5) * 1.1;
        const jz = bz + (rng() - 0.5) * 1.1;
        const k = 0.82 + rng() * 0.4;
        _e1.set(0, rng() * TAU, 0);
        _q1.setFromEuler(_e1);
        _v1.set(wx(jx, jz), deckY, wz(jx, jz));
        _v2.set(k, k, k);
        _m1.compose(_v1, _q1, _v2);
        B.add('plaster.wall', jarGeometry().clone(), _m1,
          pick(rng, [0xb0693a, 0x9a5c34, 0xc07a48, 0x8a5030]));
      }
    } else if (kind === 1) {
      /* A washing line between two posts. Cloth is what says somebody lives
       * here, and from the tower it is the only thing on the whole roofscape
       * with a hue. */
      const span = Math.min(w, d) * 0.5;
      for (const s of [-1, 1]) {
        B.box('wood.beam', 0.09, 1.45, 0.09,
          wx(bx + Math.cos(yaw) * span * s, bz + Math.sin(yaw) * span * s), deckY + 0.72,
          wz(bx + Math.cos(yaw) * span * s, bz + Math.sin(yaw) * span * s), rot, 0x6a4f31);
      }
      const sheets = 3;
      for (let j = 0; j < sheets; j++) {
        const t = (j + 0.5) / sheets - 0.5;
        const lx = bx + Math.cos(yaw) * span * 2 * t;
        const lz = bz + Math.sin(yaw) * span * 2 * t;
        const sh = 0.55 + rng() * 0.45;
        B.box('fabric.banner', 0.62, sh, 0.05, wx(lx, lz), deckY + 1.36 - sh * 0.5, wz(lx, lz),
          rot + yaw, pick(rng, CLOTH));
      }
    } else if (kind === 2) {
      /* A shade frame: four posts and a canopy that SAGS. Every piece of cloth
       * in this world was a 9-12 cm slab lying flat on its posts, which is what
       * makes the caravanserai read as a row of plastic tables in
       * `caravanserai-mast`. A catenary strip costs four more triangles than
       * the slab it replaces and is the difference between fabric and board. */
      const hw = Math.min(w, d) * 0.26;
      const ph = 1.9;
      for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        B.box('wood.beam', 0.1, ph, 0.1,
          wx(bx + ox * hw, bz + oz * hw), deckY + ph * 0.5, wz(bx + ox * hw, bz + oz * hw),
          rot, 0x6a4f31);
      }
      const colour = pick(rng, CLOTH);
      const SEGS = 5;
      const sag = 0.26;
      for (let j = 0; j < SEGS; j++) {
        const t0 = j / SEGS - 0.5;
        const t1 = (j + 1) / SEGS - 0.5;
        const mid = (t0 + t1) * 0.5;
        // Parabolic droop, thickest at the middle of the span.
        const dy = -sag * (1 - 4 * mid * mid);
        const lx = bx + mid * hw * 2;
        B.box('fabric.banner', (hw * 2) / SEGS + 0.02, 0.06, hw * 2 + 0.3,
          wx(lx, bz), deckY + ph + dy, wz(lx, bz), rot, colour);
      }
    } else if (kind === 3) {
      /* The stair head. Every one of these roofs is reachable from inside the
       * building in fiction and from nowhere in fact; a hooded hatch is the one
       * prop that says the roof is part of the house. */
      const hw = 0.62;
      B.box('plaster.wall', hw * 2, 1.05, hw * 1.7, wx(bx, bz), deckY + 0.52, wz(bx, bz),
        yaw, 0xe2d4b2);
      B.box('wood.plank', hw * 2.2, 0.1, hw * 1.9, wx(bx, bz), deckY + 1.08, wz(bx, bz),
        yaw, 0x7d5f3c);
      B.box('stone.castle', hw * 2.3, 0.16, 0.2,
        wx(bx + Math.cos(yaw) * hw, bz + Math.sin(yaw) * hw), deckY + 1.14,
        wz(bx + Math.cos(yaw) * hw, bz + Math.sin(yaw) * hw), yaw, 0xcdbb95);
    } else {
      /* Baskets and a rolled rug against the parapet - the cheapest kind, and
       * the one that keeps the average down so the four above can be worth
       * their triangles. */
      const n = 2 + ((rng() * 3) | 0);
      for (let j = 0; j < n; j++) {
        const s = 0.34 + rng() * 0.26;
        B.box('wood.plank', s, s * 1.1, s,
          wx(bx + (rng() - 0.5) * 1.3, bz + (rng() - 0.5) * 1.3), deckY + s * 0.55,
          wz(bx + (rng() - 0.5) * 1.3, bz + (rng() - 0.5) * 1.3), rng() * TAU,
          pick(rng, [0x8a6842, 0x7d5f3c, 0x9a784e]));
      }
      B.box('fabric.banner', 1.35, 0.3, 0.3, wx(bx, bz), deckY + 0.15, wz(bx, bz),
        yaw, pick(rng, CLOTH));
    }
  }

  /**
   * A corbel course on all four sides of a square tower, under a slab.
   *
   * Every gallery in this world is a square slab sitting proud of a square
   * shaft, so the run is the same four times with a quarter turn between them,
   * and the arithmetic is worth writing once rather than four times in three
   * places.
   *
   * `shaftHalf` is the half-width of the tower the course hangs on and
   * `slabWidth` the full width of the slab it carries; the projection is
   * derived from the two so a course can never be deeper than the overhang it
   * is pretending to hold up, which is the one way this reads as a mistake
   * rather than as architecture.
   *
   * `_corbelRing` is not called for the wall towers, and that is a triangle
   * decision recorded rather than an oversight: there are eight of them, they
   * are 8.5 m across, and their string course is a rest ledge on a climb -
   * ornamenting a handhold at the cost of 656 triangles buys nothing that
   * `desert-overview` can resolve.
   *
   * @param {Batch} B
   * @param {string} batchName the name `_emit` will flush this batch under
   * @param {number} cx tower axis
   * @param {number} topY underside of the slab the course carries
   * @param {number} cz tower axis
   * @param {number} yaw the tower's own rotation
   * @param {[number,number]} half the shaft's half-extents on its own local
   *   x and z. Two numbers and not one, because the keep is 26 x 20.8: fed one
   *   half-width its two long faces would have been dressed 2.6 m inside the
   *   building, which is a course you can only see by standing in the masonry.
   * @param {number} slabOut how far the slab overhangs the shaft
   * @param {{drop:number, project:number, tint:number}} opts
   */
  _corbelRing(B, batchName, cx, topY, cz, yaw, half, slabOut, opts) {
    const project = Math.min(opts.project, slabOut + 0.15);
    if (project <= 0.05) return;
    for (let s = 0; s < 4; s++) {
      const fa = yaw + s * Math.PI * 0.5;
      // Same radial frame the rest of this world uses: a part at `rotY = fa`
      // has its local +Z along (sin fa, cos fa), which is the outward normal
      // of the face it is dressing, and its local +X along the face.
      const nx = Math.sin(fa);
      const nz = Math.cos(fa);
      // On the local +-Z faces the standoff is the z half-extent and the run is
      // the x one; on the +-X faces they swap.
      const onZ = (s & 1) === 0;
      const standoff = onZ ? half[1] : half[0];
      const run = (onZ ? half[0] : half[1]) * 2;
      _e1.set(0, fa, 0);
      _q1.setFromEuler(_e1);
      _v1.set(cx + nx * standoff, topY, cz + nz * standoff);
      _v2.set(run, opts.drop, project);
      _m1.compose(_v1, _q1, _v2);
      this._authored(B, 'corbel', batchName, _m1, opts.tint);
    }
  }

  /**
   * Cut every merged district down to the C3 ceiling, smallest first.
   *
   * ── Why this is a loop here rather than one `splitDistricts` call ────────
   *
   * It IS `splitDistricts`, with a yield in the middle. That function is
   * synchronous and costs 57-69 ms over this world, which is three times C5's
   * 24 ms slice budget dropped into a live gameplay frame - Citadel is built by
   * `scheduleBackgroundBuilds` (`main.js:1297`, called `:731`) after the gate
   * opens, so a synchronous pass here is a stutter a player sees. The ordering
   * rule it publishes is reproduced exactly, ties broken by emission order, so
   * the partition is identical; `citadel-budgets.test.mjs` asserts that against
   * `splitDistricts` itself rather than trusting this comment.
   *
   * Ascending triangle count is load-bearing and is `citadel/Districts.js`'s
   * own measurement: cold, in world order the cliff costs 32.5 ms and the
   * terrain 21.7 ms, because the first district through pays for JIT-compiling
   * `sphereOfRange`, `select` and `buildSub`. Smallest first pays that on a
   * 96-triangle banner instead and the same two cost 18.2 and 13.2 ms.
   *
   * Ownership: `splitMesh` disposes the parent geometry and hands back leaves
   * nobody holds. `Batch` never owned them past its own `dispose`, so the
   * leaves are pushed onto `this._owned` here or the world leaks them.
   *
   * AND THE PARENT COMES OFF THE LIST, which it did not. `_emit` pushes every
   * merged district onto `this._owned`; `splitMesh` then detaches that parent
   * and calls `geometry.dispose()` on it. `dispose()` frees the GPU buffer and
   * nothing else - the position/normal/uv/colour typed arrays stay alive for as
   * long as anything holds the geometry, and `_owned` held it for the world's
   * lifetime. Measured: three parent geometries survived nothing else -
   * `cliff:stone.castle` 54,432 tris / 6.85 MB, `cliff:dirt.ground` 3,708 tris
   * / 0.47 MB, `props:roof.tile` 3,564 tris / 0.45 MB - 7.77 MB against a
   * 43.53 MB live world, i.e. C2's "51.29 MB resident" was 15% dead. The C2
   * test asserts every scene geometry is OWNED and never the converse, which is
   * the same ownership bug from the side that cannot see this one.
   *
   * @param {() => Promise<void>} breathe
   */
  async _splitDistricts(breathe) {
    const order = this._districts.map((m, i) => ({ m, i, t: triangleCount(m?.geometry) }));
    order.sort((a, b) => (a.t - b.t) || (a.i - b.i));
    const out = [];
    for (const { m } of order) {
      if (m?.frustumCulled === false) { out.push(m); continue; }
      const parent = m?.geometry ?? null;
      const parts = splitMesh(m, { maxRadius: MAX_DISTRICT_RADIUS, minLeaf: DISTRICT_MIN_LEAF });
      const split = parts.length !== 1 || parts[0] !== m;
      if (split && parent) {
        const at = this._owned.indexOf(parent);
        if (at >= 0) this._owned.splice(at, 1);
      }
      for (const part of parts) {
        if (part !== m) this._owned.push(part.geometry);
        out.push(part);
      }
      await breathe();
    }
    this._districts = out;
  }

  /**
   * Band the split districts by distance.
   *
   * ── Split first, THEN this, and the order is not a preference ────────────
   *
   * `citadel/Districts.js` measured it: over the seven positioned
   * `Harness.VIEWS.citadel` framings, a `hideBeyond 260` band on the 43 MERGED
   * districts hides zero meshes from all six framings a player can stand at,
   * under either measure, at every threshold from 200 to 450. Not a weak
   * optimisation - an inert one, because a merged district's sphere is 103-637 m
   * and never leaves the frustum. After the split the same band fires on 26-43
   * of the 91 buckets. `DistanceLod`'s own header says it "never merges or
   * re-buckets anything", which is the same statement from the other side.
   *
   * ── The two numbers ──────────────────────────────────────────────────────
   *
   * `hideBeyond` is measured to the district CENTRE and is a question about the
   * district: how far is the player from this piece of town. `swapNearest` is
   * measured to the nearest point, because the detail it drops is nearest-point
   * detail, and `registerDistricts` converts it per mesh into the equivalent
   * centre threshold rather than registering a second measure (which would
   * apply to the hide band on the same entry and break it).
   *
   * `swapNearest` is 52.8 m and that is derived, not chosen: `lowDetail` drops
   * the bevel strips of every `RoundedBoxGeometry` in a district, which leaves a
   * slit at most `BEVEL` = 0.075 m wide, and 0.075 m subtends under a pixel
   * past 52.8 m at 1080 lines and a 75-degree field. `citadel-districts.test.mjs`
   * reads `BEVEL` out of this file by regex, so widening the bevel fails loudly
   * rather than quietly shipping a shimmering outline on every silhouette.
   *
   * A band that can never fire from anywhere inside the world is refused rather
   * than registered, and the refusals are reported on `_lodReport` because a
   * dead band reads exactly like a working one from a frame counter.
   */
  _registerLod() {
    this._lodReport = registerDistricts(this._lod, this._districts, {
      hideBeyond: DISTRICT_HIDE_M,
      swapNearest: DISTRICT_SWAP_M,
      reach: CAMERA_REACH,
      lo: (geo) => lowDetail(geo, { minArea: DISTRICT_LO_MIN_AREA })?.geometry ?? null,
    });
    /* `registerDistricts` builds the `lo` geometries and hands them to
     * `DistanceLod`, which holds but does not own them. Nothing else would ever
     * free them. */
    for (const e of this._lod.entries) if (e.lo) this._owned.push(e.lo);
    return this._lodReport;
  }

  /**
   * Gradient dome.
   *
   * `environment.background` alone is a single flat colour, which reads as a
   * void behind a skyline rather than as air - and this world is looked *out*
   * from more than any other, because half of it is spent on a rooftop. A dome
   * costs one draw call and gives the horizon a haze band for the town to sit
   * against.
   *
   * Unlit, unfogged and drawn behind everything: it is a backdrop, not a
   * surface, and it must never receive the sun or it will band.
   */
  _buildSky() {
    /* Painted equirectangular, not a 1-D ramp.
     *
     * A vertical gradient is the same in every direction, which means the sky
     * has no *place* in it: turn on the spot and nothing changes, and the top
     * third of a world played on rooftops is dead pixels. A sphere's UVs are
     * already equirectangular, so a 2-D canvas costs exactly the same one draw
     * call and buys a sun, its glow, and cloud banding that gives the eye
     * something to measure the horizon against. */
    const W = 1024;
    const H = 512;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const c = cv.getContext('2d');

    const grd = c.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0.0, '#2e63ab');   // zenith
    grd.addColorStop(0.34, '#6fa0cf');
    grd.addColorStop(0.60, '#a8c4d8');
    grd.addColorStop(0.76, '#dbcfb2');  // haze
    grd.addColorStop(1.0, '#e8d6b0');   // dust at the horizon
    c.fillStyle = grd;
    c.fillRect(0, 0, W, H);

    /* The sun, placed where the light actually comes from.
     *
     * `sunDirection` is authored once in `_configureEnvironment`; deriving the
     * disc from it means the glow in the sky and the shadows on the ground can
     * never disagree, which is the sort of mismatch that reads as "wrong"
     * without a player being able to say why. */
    const sd = this.environment.sunDirection;
    const su = ((Math.atan2(-sd.x, -sd.z) / TAU) + 0.75) % 1;
    const sv = clamp01(0.5 - Math.asin(clamp01(sd.y)) / Math.PI);
    const sx = su * W;
    const sy = sv * H;
    // Wrapped: a glow near the seam has to be painted on both sides of it.
    for (const ox of [-W, 0, W]) {
      const glow = c.createRadialGradient(sx + ox, sy, 0, sx + ox, sy, W * 0.30);
      glow.addColorStop(0.00, 'rgba(255,247,225,0.95)');
      glow.addColorStop(0.06, 'rgba(255,236,190,0.55)');
      glow.addColorStop(0.22, 'rgba(255,224,170,0.20)');
      glow.addColorStop(1.00, 'rgba(255,220,165,0)');
      c.fillStyle = glow;
      c.fillRect(sx + ox - W * 0.3, sy - W * 0.3, W * 0.6, W * 0.6);
      const disc = c.createRadialGradient(sx + ox, sy, 0, sx + ox, sy, W * 0.017);
      disc.addColorStop(0, 'rgba(255,253,246,1)');
      disc.addColorStop(1, 'rgba(255,246,222,0)');
      c.fillStyle = disc;
      c.fillRect(sx + ox - W * 0.02, sy - W * 0.02, W * 0.04, W * 0.04);
    }

    /* Cloud banding.
     *
     * Stretched ellipses, squashed harder the nearer the horizon so they
     * foreshorten the way real cloud decks do, and drawn from the world's own
     * PRNG so the sky is identical every session like everything else here. */
    const rnd = this.rnd;
    c.globalCompositeOperation = 'source-over';
    /* A deck between roughly 40 degrees of elevation and the horizon.
     *
     * The band matters as much as the clouds do. On an equirectangular map the
     * rows near v = 0 are the *pole*, where the whole width of the canvas
     * collapses to a point - a cloud painted up there wraps into a hard streak
     * across the zenith, which is exactly what the first attempt produced. Held
     * to the middle of the map it stays a cloud, and dividing the horizontal
     * radius by sin(pi t) undoes what is left of the compression so they read as
     * round overhead and foreshortened toward the horizon, like a real deck. */
    /* Sparse, and spread over a wide band.
     *
     * Once the gradients actually painted, the first honest render was solid
     * overcast: 120 clouds inside a 0.22-wide band overlap into one continuous
     * ring around the sky, which reads as a lid rather than as weather. Fewer,
     * smaller, fainter, and spread nearly twice as far vertically leaves the
     * gaps that make the rest of them look like individual clouds. */
    for (let i = 0; i < 30; i++) {
      // Biased toward the top of the band, not the bottom: an exponent below 1
      // pushes the distribution *up* the range, which piled every cloud into the
      // horizon fade below and made the deck invisible.
      const t = 0.20 + Math.pow(rnd(), 1.5) * 0.26;
      const y = t * H;
      const x = rnd() * W;
      const stretch = 1 / Math.max(0.55, Math.sin(Math.PI * t));
      const rx = (20 + rnd() * 54) * stretch;
      const ry = rx * (0.15 + rnd() * 0.12) / stretch;
      // Faded out near the horizon so the deck meets the haze instead of
      // stopping at a line, but strong enough overhead to actually be weather.
      const a = (0.16 + rnd() * 0.26) * (1 - clamp01((t - 0.38) / 0.08));
      if (a <= 0.005) continue;
      /* Shadowed base first, lit body offset slightly above it.
     *
       * A cloud painted as one soft blob is a smudge; what makes it read as a
       * solid object with weight is a darker underside under a top that catches
       * the sun. Two passes, and the offset between them is the whole trick.
     *
       * Each gradient is built *inside* the transform it is painted under. A
       * canvas gradient lives in user space at fill time, so one created in page
       * coordinates and then filled after `translate`/`scale` has its centre
       * dragged somewhere else entirely and the shape comes out filled with the
       * transparent tail - which is why the first two attempts at this painted a
       * sky with no clouds in it at all. */
      const puff = (cx, cy, stops) => {
        for (const ox of [-W, 0, W]) {
          c.save();
          c.translate(cx + ox, cy);
          c.scale(1, ry / rx);
          const g2 = c.createRadialGradient(0, 0, 0, 0, 0, rx);
          for (const [at, col] of stops) g2.addColorStop(at, col);
          c.fillStyle = g2;
          c.beginPath();
          c.arc(0, 0, rx, 0, TAU);
          c.fill();
          c.restore();
        }
      };

      puff(x, y + ry * 0.55, [
        [0.0, `rgba(146,154,170,${a * 0.5})`],
        [0.6, `rgba(160,168,182,${a * 0.2})`],
        [1.0, 'rgba(160,168,182,0)'],
      ]);
      puff(x, y - ry * 0.35, [
        [0.00, `rgba(255,254,251,${a})`],
        [0.42, `rgba(251,247,240,${a * 0.72})`],
        [0.78, `rgba(246,241,232,${a * 0.26})`],
        [1.00, 'rgba(244,238,228,0)'],
      ]);
    }

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    tex.needsUpdate = true;

    // More segments than a plain ramp needed: the sun disc is a small feature
    // on a big sphere and a coarse mesh gives it visibly polygonal edges.
    const geo = new THREE.SphereGeometry(CITADEL_LAYOUT.skyRadius, 48, 32);
    const mat = new THREE.MeshBasicMaterial({
      map: tex, side: THREE.BackSide, fog: false, depthWrite: false,
    });
    const dome = new THREE.Mesh(geo, mat);
    dome.name = 'citadel:sky';
    this._skyDome = dome;
    dome.frustumCulled = false;
    dome.renderOrder = -100;
    dome.castShadow = false;
    dome.receiveShadow = false;
    this.group.add(dome);
    this._owned.push(geo, mat, tex);

    // With a dome in place the clear colour only shows through the horizon
    // haze, so match it rather than fighting it.
    this.environment.background = null;
  }

  /* ------------------------------------------------------------------ */
  /* Terrain                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * The mesa.
   *
   * A flat top with a hard rim, not a smooth hill - the rim *is* the cliff the
   * eagle launches from and the leap of faith drops down. Built as a
   * heightfield mesh for looks and a ring of oriented boxes for collision,
   * because a triangle-soup cliff would give the climb probe a different normal
   * on every triangle and make the grip chatter all the way up.
   */
  async _buildTerrain(breathe = noBreath) {
    const seg = CITADEL_LAYOUT.terrainSeg;
    const rnd = this.rnd;

    /* Sampled on a worker, as an explicit grid rather than a `PlaneGeometry`.
     *
     * `PlaneGeometry` splits each quad along the 01->10 diagonal; the collision
     * heightfield below interpolates along 00->11. Those two describe subtly
     * different surfaces, and this world exists in its current form precisely
     * because three different approximations of one slope were allowed to
     * disagree - the player ended up walking *underneath* the visible ground
     * over 7% of the map. Generating the grid from the shared height field means
     * the mesh and the collider are the same triangles, not two descriptions of
     * the same idea.
     *
     * The UVs the job produces are `PlaneGeometry`'s, so the ground material
     * tiles exactly as it did. */
    const N = seg + 1;
    const stepXZ = CITADEL_LAYOUT.terrainStep;
    const terrain = await genPool.run('terrain', CITADEL_LAYOUT.terrainJob);
    const heights = terrain.heights;

    // Its own material, not a `_mat` clone: the heightfield carries no colour
    // attribute, and a vertexColors material without one renders black.
    const groundMat = this.materials.get('dirt.ground:60').clone();
    groundMat.name = 'citadel.terrain';
    groundMat.color = new THREE.Color(0xe3d0a6);
    this._owned.push(groundMat);

    /* ---- the ground, as tiles ---------------------------------------- *
     *
     * It was ONE mesh. At 400 m that was defensible; at 900 m and a 3.75 m step
     * it is 57,600 quads behind a single 636 m bounding sphere, which
     * intersects the frustum from every position and every angle a player can
     * adopt, so it was drawn in full, always - including the far rim while
     * standing in an alley looking at a wall two metres away. That is C3's
     * "0 of 48 objects culled from every measured vantage", and the ground is
     * the largest single contributor to it.
     *
     * SLICED, NOT RESAMPLED. `medieval/TerrainTiles.js` owns the method and the
     * measurements; every tile vertex is a sample the worker already produced,
     * at exactly the coordinate it produced it for, so two tiles sharing an edge
     * share the same numbers and the drawn surface is still bit-for-bit the
     * collision surface registered below. Resampling per tile would have been a
     * second opinion about where the ground is, which is the failure this whole
     * file was rebuilt around.
     *
     * The `lo` geometry is the same slice at `TILE_LO_STRIDE`, swapped in past
     * a distance this tile earned for itself - see `citadel/TerrainDetail.js`,
     * which is where Medieval's single 170 m constant does not survive contact
     * with authored geology. The skirt is what makes the swap legal at all: a
     * half-resolution tile no longer meets its full-resolution neighbour along
     * the shared edge, and the gap between them is a hole straight through to
     * the sky.
     */
    const src = {
      positions: terrain.positions,
      uvs: terrain.uvs,
      normals: terrain.normals,
      nx: terrain.nx ?? N,
    };
    await breathe();
    const tiles = tileGrid({ half: HALF, step: stepXZ, tile: CITADEL_LAYOUT.terrainTile });
    this._terrainTiles = [];
    this._terrainSwap = [];
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      const hi = CitadelWorld._tileGeometry(buildTile(src, t, 1, TILE_SKIRT_DROP));
      this._owned.push(hi);
      const tile = new THREE.Mesh(hi, groundMat);
      tile.name = `citadel:terrain:${t.ix},${t.iz}`;
      tile.receiveShadow = true;
      tile.castShadow = false;
      this.group.add(tile);
      this._terrainTiles.push(tile);

      /* The swap band is this tile's own, measured off this tile's own ground.
       * `citadel/TerrainDetail.js` owns the reasoning and the numbers; the
       * short version is that Medieval's single 170 m constant is worth 637 m
       * on this field, i.e. further than a player can get from anything, so a
       * global constant here is either dead or visible. 23 of the 36 tiles earn
       * a band; the 13 landform tiles do not and draw at full resolution. */
      const dev = loDeviation(src, t, TILE_LO_STRIDE);
      const swapNear = swapDistance(dev);
      const sphere = hi.boundingSphere;
      const live = sphere ? bandCanFire(sphere, swapNear, SURFACE, CAMERA_REACH) : false;
      this._terrainSwap.push({ name: tile.name, deviation: dev, swapNear, live });
      await breathe();
      if (!live) continue;
      const lo = CitadelWorld._tileGeometry(buildTile(src, t, TILE_LO_STRIDE, TILE_SKIRT_DROP));
      this._owned.push(lo);
      /* SURFACE, not CENTRE, and this is the one band in this world that wants
       * it: the swap is a claim about the triangles nearest the camera, and a
       * 150 m tile's sphere has a ~106 m radius, so a centre measure would
       * demote a tile whose near edge is still well inside the deviation
       * budget. The district bands in `_registerLod` are the opposite case and
       * use CENTRE for the reasons `citadel/Districts.js` sets out. */
      this._lod.add(tile, { lo, swapBeyond: swapNear, measure: SURFACE });
    }

    /* ---- collision that can never sit below the mesh ------------------- *
     *
     * The rule for every collider below: its top is the height of the *highest*
     * point of the mesh it covers. Then the player is always standing on or a
     * little above what they can see, and never inside or underneath it. A
     * collider that splits the difference looks better on paper and puts the
     * camera under the world at the top of the slope.
     *
     * The plateau used to be a single square slab of half-extent MESA_R + 4.
     * The mesa is a *circle* of radius MESA_R, so the slab's corners projected
     * invisible floor out to r = 192 at full mesa height, while the mesh there
     * had already fallen to the desert - and the reverse gap, mesh above
     * collision, opened all the way round the shoulder. */
    /* The mesa top and its shoulder, as the same heightfield the mesh draws.
     *
     * This replaces 40 pie-slice slabs plus 768 concentric ring boxes. The rings
     * were a staircase: each was pinned to the height of its inner edge - the
     * highest ground it spanned - which is the safe direction to round in, but
     * across a 14 m fall in 16 rings it left risers of nearly 0.9 m all the way
     * down the slope. Sharing the mesh's samples removes both the staircase and
     * the 808 colliders, and makes "collision can never sit below the mesh" true
     * by construction rather than by rounding upward.
     *
     * The cliff ring, the dunes and every structure keep their box colliders:
     * boxes give the climb probe one consistent normal per face, which is what
     * stops grip chattering on the way up. */
    this.track(
      this.physics.addHeightfield({
        heights,
        nx: N,
        nz: N,
        originX: -HALF,
        originZ: -HALF,
        stepX: stepXZ,
        stepZ: stepXZ,
      })
    );

    /* The cliff ring: boxes stepped down the shoulder. Also the world's biggest
     * climbable face - the whole point of putting the town on a mesa. */
    // Long span: a cliff step is metres tall, so the gradient has to run the
    // whole height or it reads as a painted stripe near the base.
    const B = new Batch({ ao: 0.42, sky: 0.3, grime: 0.5, span: 9 }, TILE_METRES);
    const steps = 7;
    for (let s = 0; s < steps; s++) {
      // Read from the shared height function, so the visible rock and the
      // collision rings underneath it step down together instead of each
      // following its own curve.
      const rIn = MESA_R + (s / steps) * SHOULDER;
      const rOut = MESA_R + ((s + 1) / steps) * SHOULDER;
      const y = terrainH(rIn);
      const h = y - terrainH(rOut);
      if (h < 0.25) continue;
      const n = 72;
      for (let i = 0; i < n; i++) {
        if ((i & 15) === 15) await breathe();
        const a = (i / n) * TAU;
        const jitter = 1 + (rnd() - 0.5) * 0.05;
        const px = Math.cos(a) * rIn * jitter;
        const pz = Math.sin(a) * rIn * jitter;
        const w = (TAU * rIn) / n * 1.3;
        const d = (rOut - rIn) * 1.15;
        B.box('stone.castle', w, h * 1.9, d, px, y - h * 0.45, pz, a + Math.PI / 2,
          pick(rnd, CLIFF));
        this.track(this.physics.addRotatedBox(
          _v1.set(px, y - h * 0.45, pz),
          _v2.set(w * 0.5, h * 0.95, d * 0.5),
          a + Math.PI / 2
        ));
      }
    }

    /* Dunes, as geometry rather than as noise in the heightfield.
     *
     * The mesh used to carry a sine-based dune field that nothing collided
     * with, so the desert's crests were solid to the eye and empty to the
     * player. Built as real boxes they get real colliders, and the flat mesh
     * underneath them is a floor that agrees with itself. */
    /* Low and wide, in three shallow tiers.
     *
     * The first pass built these nearly 6 m tall in two steps, which in a desert
     * you cross on horseback is not scenery, it is a wall - the test horse
     * spawned against one and could not move at all. Each tier is now a step
     * about half a metre high, which a rider goes over without noticing and
     * which still breaks up a flat plain when the light rakes across it. */
    for (let i = 0; i < 70; i++) {
      if ((i & 7) === 7) await breathe();
      const a = rnd() * TAU;
      const r = MESA_R + SHOULDER + 10 + rnd() * 92;
      const px = Math.cos(a) * r;
      const pz = Math.sin(a) * r;
      /* Clipped to the PROTECTED CORE, not to the playfield.
     *
       * It was `HALF - 10`, and that made the dune field's rejection rate a
       * function of the extent - which would be harmless if the rejection were
       * free. It is not: the accepted branch draws four more values from the
       * world's shared `rnd` stream than the rejected one, so widening the map
       * changed how many draws this loop consumed and every structure built
       * after it moved. Measured: the souk's wall-grab rescues went 57 -> 63,
       * the jump graph lost a node, and 8 roof-edge samples appeared, all from
       * a heightfield change that by construction cannot touch the town.
     *
       * `INNER_KEEP` is also what these dunes MEAN. They are the mesa's own
       * apron - authored at r = 188..280 to break up the flat plain the town
       * stands on - and the ring past the core is the height field's business,
       * not theirs. The clip is content, so it belongs on the content line. */
      if (Math.abs(px) > INNER_KEEP - 10 || Math.abs(pz) > INNER_KEEP - 10) continue;
      const dw = 20 + rnd() * 34;
      const dd = 10 + rnd() * 16;
      const step = 0.42 + rnd() * 0.3;
      const da = rnd() * TAU;
      for (let k = 0; k < 3; k++) {
        const shrink = 1 - k * 0.28;
        B.box('dirt.ground', dw * shrink, step, dd * shrink,
          px, step * (k + 0.5), pz, da, k === 2 ? 0xf0dfb6 : 0xe8d5aa);
        this.track(this.physics.addRotatedBox(
          _v1.set(px, step * (k + 0.5), pz),
          _v2.set(dw * shrink * 0.5, step * 0.5, dd * shrink * 0.5), da
        ));
      }
    }

    await breathe();
    this._emit(B, 'cliff', { cast: true, recv: true });
    await breathe();
    B.dispose();

    /* ---- the rim, and the collider that is no longer here -------------- *
     *
     * There used to be one more line here: `addBox(0, -6, 0, HALF*1.6, 6,
     * HALF*1.6)`, a desert floor whose top sat exactly on the mesh's desert
     * level. It was a floor under a world that already had one - the
     * heightfield above covers the whole playfield - and it was the single
     * most expensive object in the broadphase.
     *
     * `Physics._gridRange` buckets a box by its bounding SPHERE, which for
     * half-extents (720, 6, 720) is 1,018 m, so that one collider claimed a
     * 2,036 m square of 12 m cells: 28,900 of them at this extent, and 5,776 -
     * every cell the world had - at the old one. Every capsule query, every
     * raycast and every ground probe in the world walked it. `Physics.js:418`
     * keeps heightfields outside the grid for exactly this reason and says so;
     * the heightfield above is registered that way already, so this was the one
     * object undoing it.
     *
     * What it was quietly also doing is catching a player past the heightfield
     * edge, and that job is real. It is done by `CITADEL_LAYOUT.walls` - a
     * segmented rim rather than four slabs, because a full-length slab has a
     * 451.8 m bounding sphere and four of them smear 22,500 cells, which is the
     * same failure in a different shape. */
    for (const w of CITADEL_LAYOUT.walls) {
      this.track(this.physics.addBox(w[0], w[1], w[2], w[3], w[4], w[5]));
    }

    this.bounds = new THREE.Box3(
      new THREE.Vector3(-HALF, CITADEL_LAYOUT.floorY, -HALF),
      new THREE.Vector3(HALF, CITADEL_LAYOUT.ceilY, HALF)
    );
    /**
     * The part of the playfield that has anything in it.
     *
     * Read by `Relics._onWorld` and `Caches._onWorld`, both of which budget by
     * AREA. `bounds` is 5.06x what it was and the town is exactly where it
     * always was, so budgeting either of them off `bounds` asks for 110 relics
     * and 10 high caches and then darts the surplus into open sand, where
     * `MIN_PROMINENCE` cannot be satisfied by construction. This drop authors no
     * ring content, so the content box IS the protected core - and when the ring
     * is authored this is the one number that has to grow with it.
     */
    this.contentBounds = new THREE.Box3(
      new THREE.Vector3(-INNER_KEEP, CITADEL_LAYOUT.floorY, -INNER_KEEP),
      new THREE.Vector3(INNER_KEEP, CITADEL_LAYOUT.ceilY, INNER_KEEP)
    );
  }

  /**
   * Wrap one `TerrainTiles.buildTile` result in a `BufferGeometry`.
   *
   * The bounding sphere is computed here rather than left to the first render,
   * because `DistanceLod.add` reads it at registration: a mesh registered with
   * no sphere measures its distance as zero forever, i.e. never demotes, and
   * does it silently.
   */
  static _tileGeometry(t) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(t.position, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(t.uv, 2));
    g.setAttribute('normal', new THREE.BufferAttribute(t.normal, 3));
    g.setIndex(new THREE.BufferAttribute(t.index, 1));
    g.computeBoundingSphere();
    return g;
  }

  /* ------------------------------------------------------------------ */
  /* Curtain wall                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Curtain wall with walkable battlements and corner towers.
   *
   * The rampart walk is the town's first traversal line: it circles the whole
   * souk at 9 m, so a player who climbs the gatehouse can run the entire
   * perimeter without touching the ground. The merlons are real boxes rather
   * than a texture, because they are the handholds on the way up.
   */
  async _buildCurtainWall(breathe = noBreath) {
    const B = new Batch({ ao: 0.4, sky: 0.34, grime: 0.55, span: 5 }, TILE_METRES);
    // Module constants: the souk's outer radius and the rampart haystack lane
    // are both derived from them, so a second copy here would be a second copy
    // that could drift.
    const R = WALL_R;
    const segs = 40;
    const top = MESA_Y + WALL_H;

    for (let i = 0; i < segs; i++) {
      if ((i & 7) === 7) await breathe();
      const a0 = (i / segs) * TAU;
      const a1 = ((i + 1) / segs) * TAU;
      const mid = (a0 + a1) * 0.5;
      // Leave the gate open on the +Z side, where the approach road arrives.
      if (Math.abs(((mid - GATE_BEARING + Math.PI) % TAU) - Math.PI) < 0.1) continue;

      const px = Math.cos(mid) * R;
      const pz = Math.sin(mid) * R;
      const len = (TAU * R) / segs * 1.06;
      /* THE SIGN, and it was wrong for the whole life of this world.
     *
       * `Matrix4.makeRotationY(t)` puts the local +X axis at world
       * `(cos t, -sin t)`, so the WORLD BEARING of local +X is `-t`, not `+t`.
       * A segment rotated `mid + pi/2` therefore lies along bearing
       * `-(mid + pi/2)`, which differs from the tangent by `2*mid + pi` - zero
       * only where `mid` is a multiple of pi/2. Everywhere else the segment is
       * turned off the ring, and at mid = pi/4 it is turned by a right angle
       * and lies RADIALLY.
     *
       * Measured with `deckAt` on a radial sweep, the curtain wall was a
       * rosette: solid stone reaching in to r = 111.8 at some bearings and open
       * mesa at r = 118 at others. The town was not walled. The merlon
       * positions two lines down were computed off the true tangent
       * `(cos(mid + pi/2), sin(mid + pi/2))` all along, so the blocks and the
       * wall they stand on disagreed with each other, which is the tell.
     *
       * `pi/2 - mid` is the rotation that puts local +Z on the radius and
       * local +X on the tangent, and it is the same expression `_buildSouk`
       * uses for the same reason. */
      const wallRot = Math.PI / 2 - mid;

      B.box('stone.castle', len, WALL_H, WALL_T, px, MESA_Y + WALL_H * 0.5, pz, wallRot, 0xc4b494);
      this.track(this.physics.addRotatedBox(
        _v1.set(px, MESA_Y + WALL_H * 0.5, pz),
        _v2.set(len * 0.5, WALL_H * 0.5, WALL_T * 0.5),
        wallRot
      ));

      // Merlons: alternating blocks along the parapet.
      const merlons = 5;
      for (let m = 0; m < merlons; m++) {
        if (m % 2) continue;
        const t = (m + 0.5) / merlons - 0.5;
        const mx = px + Math.cos(mid + Math.PI / 2) * len * t;
        const mz = pz + Math.sin(mid + Math.PI / 2) * len * t;
        B.box('stone.castle', len / merlons * 0.86, 1.5, WALL_T * 0.55,
          mx, top + 0.75, mz, wallRot, 0xbfae8c);
        this.track(this.physics.addRotatedBox(
          _v1.set(mx, top + 0.75, mz),
          _v2.set(len / merlons * 0.43, 0.75, WALL_T * 0.28),
          wallRot
        ));
      }
    }

    // Corner towers - taller, and each one a rest ledge on a long climb.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU + 0.39;
      const px = Math.cos(a) * R;
      const pz = Math.sin(a) * R;
      const h = 17;
      const w = 8.5;
      B.box('stone.castle', w, h, w, px, MESA_Y + h * 0.5, pz, a, 0xcbbb99);
      this.track(this.physics.addRotatedBox(
        _v1.set(px, MESA_Y + h * 0.5, pz), _v2.set(w * 0.5, h * 0.5, w * 0.5), a
      ));
      // String course at mid height: the rest ledge.
      B.box('stone.castle', w + 1.1, 0.5, w + 1.1, px, MESA_Y + h * 0.55, pz, a, 0xb2a084);
      this.track(this.physics.addRotatedBox(
        _v1.set(px, MESA_Y + h * 0.55, pz), _v2.set((w + 1.1) * 0.5, 0.25, (w + 1.1) * 0.5), a
      ));
      // Parapet ring on top.
      B.box('stone.castle', w + 1.4, 1.2, w + 1.4, px, MESA_Y + h + 0.6, pz, a, 0xc0b08e);
      this.track(this.physics.addRotatedBox(
        _v1.set(px, MESA_Y + h + 0.6, pz), _v2.set((w + 1.4) * 0.5, 0.6, (w + 1.4) * 0.5), a
      ));

      // `wall: true` so `_buildRopeBridges` can name these rather than
      // finding them by a height predicate. The old `find(t => !t.minaret &&
      // t.y < MESA_Y + 34)` matched whichever wall tower happened to be pushed
      // first, which is a layout detail wearing the costume of a choice.
      this._towers.push({ x: px, y: MESA_Y + h + 1.2, z: pz, r: w * 0.5, wall: true });
      this._roofs.push({ x: px, y: MESA_Y + h + 1.2, z: pz, w, d: w });
    }

    /* Gatehouse. Two flanking blocks and a lintel: the arch the player walks in
     * under, and the first climb the game offers - low, wide, forgiving. */
    const gz = R;
    for (const sx of [-6.5, 6.5]) {
      B.box('stone.castle', 7, 14, 9, sx, MESA_Y + 7, gz, 0, 0xcdbd9b);
      this.track(this.physics.addBox(sx, MESA_Y + 7, gz, 3.5, 7, 4.5));
      B.box('stone.castle', 8.2, 0.6, 10.2, sx, MESA_Y + 8.4, gz, 0, 0xb4a286);
      this.track(this.physics.addBox(sx, MESA_Y + 8.4, gz, 4.1, 0.3, 5.1));
    }
    B.box('stone.castle', 20, 3.2, 9, 0, MESA_Y + 12.4, gz, 0, 0xc8b896);
    this.track(this.physics.addBox(0, MESA_Y + 12.4, gz, 10, 1.6, 4.5));
    this._roofs.push({ x: 0, y: MESA_Y + 14, z: gz, w: 20, d: 9 });

    /* THE ARCH THE COMMENT ABOVE HAS ALWAYS CLAIMED.
     *
     * The gatehouse is two flanking blocks at x = +-6.5, each 7 m wide, so the
     * opening is 6.0 m across between their inner faces at x = +-3.0, and it
     * runs from the mesa deck to the underside of the lintel at MESA_Y + 10.8.
     * A rectangular hole - which is what `gate-approach` photographed, and what
     * the line four above it calls "the arch the player walks in under".
     *
     * The authored surround turns it into a pointed opening. Half-span 3.0, so
     * the rise is 3.0 * 1.41421 = 4.24 m and the springing line lands at
     * MESA_Y + 6.56: a 6.6 m vertical jamb under a 4.2 m head, which is the
     * proportion of the gates this town is dressed as.
     *
     * NO COLLIDER, and that is deliberate rather than an omission. The lintel
     * already carries the opening's ceiling collider and the flanking blocks
     * its jambs; a spandrel with a body would narrow the world's front door by
     * a metre and a half at head height, and every gap, reach and route
     * measurement in the citadel suite is taken against the colliders. Art may
     * not move a route. The crown clears the deck by 10.8 m regardless, so
     * there is nothing here a player could walk into.
     *
     * Placed twice, mirrored: the archivolt stands proud of the FRONT face
     * only (see the generator), and this opening is 9 m deep and read from
     * both sides - from the approach on the way in and from the plaza on the
     * way out. One placement would have a moulding on one side and a raw edge
     * on the other. */
    const GATE_HALF = 3.0;
    const GATE_SPRING = MESA_Y + 10.8 - GATE_HALF * Math.SQRT2;
    for (const face of [1, -1]) {
      _e1.set(0, face > 0 ? 0 : Math.PI, 0);
      _q1.setFromEuler(_e1);
      _v1.set(0, GATE_SPRING, gz + face * 4.0);
      _v2.set(GATE_HALF, GATE_HALF, 1.0);
      _m1.compose(_v1, _q1, _v2);
      this._authored(B, 'arch', 'wall', _m1, 0xcdbd9b);
    }

    /* A corbel course under each flanking block's string course, on the face
     * that looks down the approach road. The gatehouse is the first
     * architecture in the world and it had no ornament at all; a bracket
     * course under a projecting band is what says a mason built this rather
     * than a level designer. Same no-collider rule. */
    for (const sx of [-6.5, 6.5]) {
      _e1.set(0, 0, 0);
      _q1.setFromEuler(_e1);
      _v1.set(sx, MESA_Y + 8.1, gz + 4.5);
      _v2.set(6.4, 1.0, 0.62);
      _m1.compose(_v1, _q1, _v2);
      this._authored(B, 'corbel', 'wall', _m1, 0xd8c8a6);
    }

    await breathe();
    this._emit(B, 'wall');
    await breathe();
    B.dispose();
  }

  /* ------------------------------------------------------------------ */
  /* Souk                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * The lower town: flat-roofed blocks in a rough radial grid.
   *
   * Heights climb toward the citadel, and roof gaps widen with them. That is
   * the whole difficulty curve expressed as geometry: near the gate a player
   * can stroll between roofs, and by the inner ward they are committing to
   * running leaps. Every block gets a door lintel and a window course, which
   * exist to be gripped rather than looked at.
   */
  async _buildSouk(breathe = noBreath) {
    // The strongest of the set. The souk is where the player spends most of
    // their time at eye level, and alley contact shadow is most of what sells
    // a town built entirely from boxes.
    const B = new Batch({ ao: 0.46, sky: 0.34, grime: 0.65, span: 3.4 }, TILE_METRES);
    const rnd = this.rnd;

    /* Resolve the four authored interiors BEFORE anything is placed.
     *
     * `ENTERABLE_SITES` names a ring and a compass bearing; this turns each
     * into the index of the nearest surviving building on that ring, at the
     * counts this build is actually using. That is the whole re-key: the
     * authored data no longer contains an index, so changing `count` moves the
     * interior a couple of metres round the ring instead of moving it onto a
     * different house or losing it entirely. */
    const enterableAt = new Map();
    for (const site of ENTERABLE_SITES) {
      const spec = SOUK_RINGS[site.ring];
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < spec.count; i++) {
        const a = (i / spec.count) * TAU + site.ring * 0.31;
        if (this._inCorridor(a)) continue;
        const d = Math.abs(wrapPi(a - site.bearing));
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best >= 0) enterableAt.set(`${site.ring}:${best}`, site);
    }

    for (const spec of SOUK_RINGS) {
      const ring = spec.ring;
      const r = spec.r;
      const count = spec.count;
      for (let i = 0; i < count; i++) {
        /* Eight buildings between yields. The souk is ~190 iterations emitting
         * ~5,500 boxes and ~2,500 colliders for 103-192 ms depending on how warm
         * the JIT is, and it is the pass C5 is named after. `report.slice` only
         * actually yields once 24 ms have gone by, so a call that is not needed
         * costs a comparison. */
        if ((i & 7) === 7) await breathe();
        /* No angular jitter. It used to be `+ (rnd() - 0.5) * 0.06`, which is
         * +/-3.1 m of tangential slop per building at the outer ring - twice
         * the whole difference between a sprint jump and a leap - and it was
         * the single largest term in the old gap distribution. */
        const a = (i / count) * TAU + ring * 0.31;
        /* Keep the whole gate approach clear, at every ring.
         *
         * The first version only cleared the inner four, and the outer two
         * closed the corridor back up right where the player arrives - so the
         * spawn probe found a rooftop and dropped them onto it, staring at a
         * wall, in a world whose entire first impression is meant to be the
         * town rising toward the tower. A processional route has to be
         * processional the whole way in.
         *
         * It is also the one break in the roof network that is DELIBERATE.
         * Connectivity routes around it; it does not get closed to buy a
         * component. */
        if (this._inCorridor(a)) continue;

        const px = Math.cos(a) * r;
        const pz = Math.sin(a) * r;
        /* The footprint frame, and the reason the whole ring is solvable.
         *
         * `rotY = rot` puts the box's local +X on `(cos rot, -sin rot)` and its
         * local +Z on `(sin rot, cos rot)`; at `rot = pi/2 - a` that is the
         * ring TANGENT and the RADIUS respectively. So `w` is tangential width
         * and `d` is radial depth at every bearing, which is what lets
         * `SOUK_RINGS` solve `w` from a target gap. The old code passed `a`
         * itself, rotating the footprint frame at -2a relative to the ring. */
        const rot = Math.PI * 0.5 - a;
        const w = spec.w + (rnd() - 0.5) * 0.5;
        const d = spec.depth + (rnd() - 0.5) * 0.5;
        /* Deck height: the ring's authored value, saw-toothed on the inner two
         * rings, plus a little noise. The noise is +/-0.12 m and not the old
         * +/-1.75 m, because a step taller than a jump's apex is a wall and the
         * apexes are 0.878 m and 1.109 m - there is no room in that budget for
         * a metre of dice. */
        const deck = spec.deck
          + (spec.sawtooth ? (i % 2 ? -spec.sawtooth : spec.sawtooth) : 0)
          + (rnd() - 0.5) * 0.24;
        const h = deck - 0.55;                 // the roof lip is 0.55 m thick
        const y0 = MESA_Y;
        /* Per-building colour, drawn from a real palette.
         *
         * The first version subtracted a small random amount from the *red*
         * channel only, which varies four hundred houses across a range narrower
         * than the eye can see - the town came out one flat sheet of mustard.
         * A hand-picked set of limewash and mudbrick tones, varied a little in
         * lightness per building, is what makes a skyline read as a place where
         * people paint their own houses. */
        const tint = pick(rnd, WASH);
        const site = enterableAt.get(`${ring}:${i}`);
        const enterable = !!site;
        const wallT = 0.42;
        const doorHW = 0.86;
        const doorH = 2.45;
        const roomCeil = Math.min(h - 0.45, 3.65);

        if (!enterable) {
          B.box('plaster.wall', w, h, d, px, y0 + h * 0.5, pz, rot, tint);
          this.track(this.physics.addRotatedBox(
            _v1.set(px, y0 + h * 0.5, pz), _v2.set(w * 0.5, h * 0.5, d * 0.5), rot
          ));
        } else {
          // Flipped houses build their whole local frame rotated 180 deg so
          // the doorway lands on the clear alley face; the w x d footprint is
          // symmetric under that rotation so nothing else moves.
          const da = site.flipDoor ? rot + Math.PI : rot;
          const hw = w * 0.5;
          const hd = d * 0.5;
          const M = new THREE.Matrix4().makeRotationY(da).setPosition(px, y0, pz);
          const rcol = (lx, cy, lz, hx, hy, hz) => {
            _v1.set(lx, cy, lz).applyMatrix4(M);
            return this.track(this.physics.addRotatedBox(_v1, _v2.set(hx, hy, hz), da));
          };
          const segW = Math.max(0.7, hw - doorHW);
          // Hollow ground-floor shell with a real doorway in the +Z alley face.
          B.box('plaster.wall', w, h, wallT, px + Math.sin(da) * (-hd + wallT * 0.5),
            y0 + h * 0.5, pz + Math.cos(da) * (-hd + wallT * 0.5), da, tint);
          rcol(0, h * 0.5, -hd + wallT * 0.5, hw, h * 0.5, wallT * 0.5 + 0.04);
          for (const sgn of [-1, 1]) {
            const wx = px + Math.cos(da) * sgn * (hw - wallT * 0.5);
            const wz = pz - Math.sin(da) * sgn * (hw - wallT * 0.5);
            B.box('plaster.wall', wallT, h, d - wallT * 2, wx, y0 + h * 0.5, wz, da, tint);
            rcol(sgn * (hw - wallT * 0.5), h * 0.5, 0, wallT * 0.5 + 0.04, h * 0.5, hd);
            B.box('plaster.wall', segW, h, wallT,
              px + Math.cos(da) * sgn * (doorHW + segW * 0.5) + Math.sin(da) * (hd - wallT * 0.5),
              y0 + h * 0.5,
              pz - Math.sin(da) * sgn * (doorHW + segW * 0.5) + Math.cos(da) * (hd - wallT * 0.5),
              da, tint);
            rcol(sgn * (doorHW + segW * 0.5), h * 0.5, hd - wallT * 0.5,
              segW * 0.5, h * 0.5, wallT * 0.5 + 0.04);
          }
          B.box('plaster.wall', doorHW * 2, h - doorH, wallT,
            px + Math.sin(da) * (hd - wallT * 0.5),
            y0 + doorH + (h - doorH) * 0.5,
            pz + Math.cos(da) * (hd - wallT * 0.5), da, tint);
          rcol(0, doorH + (h - doorH) * 0.5, hd - wallT * 0.5,
            doorHW, (h - doorH) * 0.5, wallT * 0.5 + 0.04);

          /* The arch over the four authored front doors, placed HERE and not
             in the `fa === 0` block below, because `site.flipDoor` puts half of
             these on the opposite face from the one that block walks. This is a
             real 1.72 m opening with a swinging leaf in it, so the surround
             spans `doorHW` and springs where the head at `doorH` leaves room -
             and, exactly as at the gate, it carries NO collider: the lintel
             above it and the leaf's own box already own that airspace, and
             every reach measurement in the citadel suite is taken against the
             colliders rather than against the picture. */
          {
            _e1.set(0, da, 0);
            _q1.setFromEuler(_e1);
            _v1.set(
              px + Math.sin(da) * (hd - wallT * 0.5 + 0.03),
              y0 + doorH - doorHW * Math.SQRT2,
              pz + Math.cos(da) * (hd - wallT * 0.5 + 0.03)
            );
            _v2.set(doorHW, doorHW, 0.34);
            _m1.compose(_v1, _q1, _v2);
            this._authored(B, 'arch', 'souk', _m1, 0xc9b78f);
          }

          // Interior floor/ceiling and simple market furnishings.
          B.box('stone.cobble', w - 0.25, 0.16, d - 0.25, px, y0 + 0.08, pz, da, 0xd3c09a);
          rcol(0, 0.04, 0, hw - 0.12, 0.08, hd - 0.12);
          B.box('wood.plank', w - 0.2, 0.16, d - 0.2, px, y0 + roomCeil, pz, da, 0x8a6a44);
          rcol(0, roomCeil, 0, hw - 0.05, 0.1, hd - 0.05);
          B.box('wood.plank', 1.8, 0.16, 1.05,
            px + Math.cos(da) * -1.2 + Math.sin(da) * -0.8, y0 + 0.82,
            pz - Math.sin(da) * -1.2 + Math.cos(da) * -0.8, da + 0.08, 0x8c6840);
          rcol(-1.2, 0.75, -0.8, 1.0, 0.45, 0.65);
          for (const [lx, lz] of [[1.55, -0.7], [1.9, 0.65], [-1.7, 1.0]]) {
            B.box('wood.beam', 0.65, 0.55, 0.65,
              px + Math.cos(da) * lx + Math.sin(da) * lz, y0 + 0.28,
              pz - Math.sin(da) * lx + Math.cos(da) * lz, da, 0x6d5334);
            rcol(lx, 0.32, lz, 0.36, 0.32, 0.36);
          }

          /* ONE mesh per door leaf, not three.
           *
           * The plank and its two iron bands are rigidly attached to the same
           * pivot and never move relative to each other, so three meshes bought
           * three draw calls for 36 triangles apiece - twelve draws across the
           * four enterable houses. The bands carry their colour in the vertex
           * attribute `prepDynamicGeo` writes, so merging them onto the plank's
           * material costs the look nothing and the tint stays what it was. The
           * ring and its two caves needed the twelve back. */
          const leafW = doorHW * 2 - 0.08;
          const parts = [prepDynamicGeo(new THREE.BoxGeometry(leafW, doorH - 0.12, 0.1), 'wood.plank', 0x6b4a2e)];
          parts[0].translate(leafW * 0.5, 0, 0);
          for (const by of [-0.52, 0.52]) {
            const bandGeo = prepDynamicGeo(new THREE.BoxGeometry(leafW * 0.88, 0.12, 0.06), 'wood.plank', 0x33251a);
            bandGeo.translate(leafW * 0.5, by, 0.08);
            parts.push(bandGeo);
          }
          const leafGeo = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)), false);
          for (const g of parts) g.dispose();
          const leaf = new THREE.Mesh(leafGeo, this._mat('wood.plank'));
          leaf.castShadow = leaf.receiveShadow = true;
          this._owned.push(leafGeo);
          const pivot = new THREE.Group();
          _v1.set(-doorHW + 0.02, doorH * 0.5, hd - wallT * 0.5).applyMatrix4(M);
          pivot.position.copy(_v1);
          pivot.rotation.y = da;
          pivot.add(leaf);
          this.group.add(pivot);
          _v1.set(0, doorH * 0.5, hd - wallT * 0.5).applyMatrix4(M);
          const doorCol = this.track(this.physics.addRotatedBox(_v1, _v2.set(doorHW, doorH * 0.5, 0.13), da));
          const dpos = new THREE.Vector3(0, 1.2, hd).applyMatrix4(M);
          const lootPos = new THREE.Vector3(1.55, 0.72, -0.7).applyMatrix4(M);
          if (!Array.isArray(this.enterables)) this.enterables = [];
          const n = this.enterables.length;
          this.enterables.push({
            label: site.label,
            origin: new THREE.Vector3(px, y0, pz),
            doors: [{
              id: `citadel_souk_${n}`,
              leaves: [{ pivot, closed: da, open: da - Math.PI * 0.58 }],
              collider: doorCol,
              position: dpos,
              open: false,
              anim: 0,
            }],
            collectibleSpots: [{ position: lootPos, tier: 'common' }],
          });
        }

        // Roof lip - the ledge you actually mantle onto, and the footprint
        // every gap in `SOUK_RINGS` is measured between.
        B.box('stone.castle', w + SOUK_LIP, 0.55, d + SOUK_LIP, px, y0 + h + 0.27, pz, rot, 0xbfae8a);
        this.track(this.physics.addRotatedBox(
          _v1.set(px, y0 + h + 0.27, pz),
          _v2.set((w + SOUK_LIP) * 0.5, 0.28, (d + SOUK_LIP) * 0.5), rot
        ));
        this._roofs.push({ x: px, y: y0 + h + 0.55, z: pz, w, d, ring });

        /* Window course. Two bands of shallow boxes proud of the wall: the
         * handholds that make a plaster face climbable instead of blank. They
         * are colliders, which is the whole point - a decal would look the same
         * and grip nothing. Narrower than the roof lip, so they never become
         * the thing a jump is measured against. */
        const bands = h > 9 ? 2 : 1;
        for (let bnd = 0; bnd < bands; bnd++) {
          const by = y0 + h * (bnd === 0 ? 0.42 : 0.74);
          /* THE COLOUR, WHICH WAS THE LOUDEST THING IN `souk-alley`.
           *
           * 0x6d5334 against `wood.beam`'s 0xf0e2cc tint resolves to 0x674e31,
           * which is 20% luminance sitting on plaster at 92%. Photographed from
           * the alley these read as two hard black slabs running the length of
           * both walls, and they are the only feature on either - the shot is a
           * white corridor with black stripes in it, not a street.
           *
           * The bands themselves are right and stay: they are the handholds
           * that make a plaster face climbable, and they are colliders because
           * a detail the player can see and not grab would be a lie in a world
           * whose whole subject is that a wall is a route. What was wrong is
           * that a sun-bleached timber string course on a desert town is a
           * WARM MID-TONE, not an absence of light. 0xa8825a lands at 52%,
           * which reads as weathered cedar against limestone and still gives
           * the eye the horizontal line the climb is signposted by.
           *
           * Per-house rather than flat, because two identical bands the length
           * of a ring is most of why the alley reads as extruded rather than
           * built. Derived from `ring` and `i` and NOT from `rnd()`: this loop
           * shares one stream with the palms, stalls, pots and carts, and one
           * extra draw here moves every prop in the town - the extent stage
           * measured exactly that when one clipping literal changed how many
           * draws the dune loop took. */
          const shade = 0xc09468 + ((ring * 7 + i * 5) % 5) * 0x000806 - ((i % 3) * 0x060402);
          B.box('wood.beam', w + 0.5, 0.34, d + 0.5, px, by, pz, rot, shade);
          this.track(this.physics.addRotatedBox(
            _v1.set(px, by, pz), _v2.set((w + 0.5) * 0.5, 0.17, (d + 0.5) * 0.5), rot
          ));
        }

        /* Openings.
         *
         * Faked rather than cut: there is no CSG here, so each opening is a
         * near-black panel set a hand's width into the wall face, with a lintel
         * over it and a sill under it. The panel is what the eye reads as depth
         * and the sill is what catches the sun, and together they turn a blank
         * rectangle into a wall of a building. At any distance past a couple of
         * metres it is indistinguishable from a real recess, and it costs three
         * boxes instead of a boolean operation per house.
         *
         * The sills are colliders. Everything on this world's facades is: the
         * whole point of the citadel is that a wall is a route, so a detail the
         * player can see and not grab would be a lie. */
        /* Face directions, derived rather than guessed.
         *
         * A box at `rotY = rot` has its local +Z pointing along world
         * (sin rot, cos rot) and its local +X along (cos rot, -sin rot).
         * Offsetting by the radius instead of by the local axis puts every
         * detail out in the open air beside its own wall - that is what was
         * wrong with the parapets and awnings below, and it is the difference
         * between a facade and a cloud of loose boxes. With the radial frame,
         * `fa = 0` is the face that looks straight out down the hill. */
        const faces = [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5];
        for (const fa of faces) {
          const wa = rot + fa;
          const nx = Math.sin(wa);
          const nz = Math.cos(wa);
          const tx = Math.cos(wa);     // tangent, for spacing bays along the face
          const tz = -Math.sin(wa);
          // Depth of the wall we are punching into, and its width.
          const onZ = fa === 0 || Math.abs(fa - Math.PI) < 1e-6;
          const half = (onZ ? d : w) * 0.5;
          const along = (onZ ? w : d) * 0.5;
          const rows = h > 9 ? 2 : 1;
          for (let row = 0; row < rows; row++) {
            const wy = y0 + h * (rows === 1 ? 0.58 : row === 0 ? 0.36 : 0.68);
            // The blocks are wide and shallow now, so the threshold that
            // decides a two-bay face sits between the two: 4.2 m of half-width
            // puts two windows on every street frontage and one on the ends.
            const cols = along > 4.2 ? 2 : 1;
            for (let cidx = 0; cidx < cols; cidx++) {
              if (rnd() < 0.22) continue;                 // not every bay
              const off = cols === 1 ? 0 : (cidx - 0.5) * along * 0.95;
              const ox = px + nx * half + tx * off;
              const oz = pz + nz * half + tz * off;
              const ww = 1.05 + rnd() * 0.45;
              const wh = 1.35 + rnd() * 0.5;
              /* ── THE WINDOW THAT WAS NEVER THERE ────────────────────────
               *
               * This line used to read `ox - nx * 0.16`, under the comment
               * "pushed 0.16 in, so the wall itself shades it", and the block
               * comment above it calls the panel "what the eye reads as depth".
               *
               * The house is a SOLID box - `B.box('plaster.wall', w, h, d,
               * ...)` a few lines up, faces at +-d/2 - and `half` is exactly
               * d/2. A panel 16 cm inside a solid is inside a solid. **Every
               * window recess in Sunspire Citadel was buried in masonry and had
               * never rendered a pixel.** What `souk-alley` photographs as a
               * row of dark slots is the LINTELS, which are proud; the openings
               * themselves were not there. Two hundred houses, four faces each,
               * and the one feature that says a wall is a building.
               *
               * Invisible in source - the arithmetic reads perfectly, and the
               * comment describes what it was meant to do - and unmissable the
               * moment somebody went looking for a window to put a mashrabiya
               * in and could not find one. Same shape as `art-medieval`'s
               * framing that photographed the inside of a hill.
               *
               * Fixed by bringing the panel just PROUD of the face, 0.065 m,
               * and leaving the lintel and sill where they already were at
               * 0.17-0.22 m proud. The panel is then a dark plane a hand's
               * width behind its own trim, which is a recess - and this time
               * the geometry agrees with the sentence. No collider either way:
               * the sill below it is the grabbable part and always was. */
              B.box('stone.castle', ww, wh, 0.1, ox + nx * 0.015, wy, oz + nz * 0.015, wa, 0x2b2119);
              // Lintel above, sill below - both proud, both grabbable.
              B.box('wood.beam', ww + 0.34, 0.2, 0.24, ox + nx * 0.05, wy + wh * 0.5 + 0.1, oz + nz * 0.05, wa, 0x6a4f31);
              B.box('stone.castle', ww + 0.42, 0.16, 0.3, ox + nx * 0.07, wy - wh * 0.5 - 0.08, oz + nz * 0.07, wa, 0xcdbb95);
              this.track(this.physics.addRotatedBox(
                _v1.set(ox + nx * 0.07, wy - wh * 0.5 - 0.08, oz + nz * 0.07),
                _v2.set((ww + 0.42) * 0.5, 0.08, 0.15), wa
              ));
              /* A mashrabiya over the recess, on the street frontage only, on
               * the lower row only, on every other bay.
               *
               * Every one of those three restrictions is a triangle argument
               * and none is a taste one. The screen is 168 triangles and there
               * are of the order of 1,400 window reveals in this souk; dressing
               * all of them is a quarter of a million triangles to put tracery
               * on the back of a house nobody can reach. `fa === 0` is the face
               * that looks down the hill, `row === 0` is the band at eye height
               * from the street below, and the parity halves what is left. That
               * is where `souk-alley` is standing, and it is the only place in
               * this world a window is ever seen from three metres.
               *
               * The parity is derived from the loop indices and NOT from
               * `rnd()`, for the reason set out on the band shade above: this
               * loop shares one random stream with every prop in the town.
               *
               * Visual only. The sill under it is already the collider - the
               * grabbable part of a window in this world is its sill, and a
               * screen with a body would put a second grab surface 16 cm proud
               * of the one every reach measurement was taken against. */
              if (fa === 0 && row === 0 && ((i + cidx) & 1) === 0) {
                _e1.set(0, wa, 0);
                _q1.setFromEuler(_e1);
                /* In FRONT of the panel and behind the trim: 0.03 to 0.19 m
                 * proud, against a panel face at 0.065 and lintel and sill
                 * fronts at 0.17-0.22. That is also what a mashrabiya IS - a
                 * screen that PROJECTS from the facade rather than one set into
                 * it - so the depth that works here is the historically correct
                 * one, which is a pleasant accident rather than an argument.
                 *
                 * The first version sat 0.05 m INTO the wall, which showed five
                 * centimetres of lattice edge-on: 147 of them were placed and
                 * not one was visible from the alley they were placed for. That
                 * is the same defect as the recess above, made freshly, in the
                 * same hour, by reading the same arithmetic. */
                _v1.set(ox + nx * 0.11, wy, oz + nz * 0.11);
                _v2.set(ww * 0.94, wh * 0.94, 0.16);
                _m1.compose(_v1, _q1, _v2);
                this._authored(B, 'screen', 'souk', _m1, 0x8a6a44);
              }
            }
          }

          // A doorway on the alley-facing side only, so the ground floor is not
          // ringed with four front doors. `fa === 0` is the outward radial
          // face: every house in the souk fronts onto the street below it.
          if (fa === 0) {
            const hasDecorDoor = rnd() < 0.75;
            if (!enterable && hasDecorDoor) {
            const dw = 1.25;
            const dh = 2.3;
            B.box('stone.castle', dw, dh, 0.12, px + nx * (half - 0.14), y0 + dh * 0.5, pz + nz * (half - 0.14), wa, 0x241c15);
            B.box('wood.beam', dw + 0.4, 0.26, 0.28, px + nx * (half + 0.05), y0 + dh + 0.13, pz + nz * (half + 0.05), wa, 0x6a4f31);
            }
            /* The doorway arch, on exactly the door the branch above paints.
             *
             * The condition is `!enterable && hasDecorDoor` and not one term
             * looser, because an arch over a door that is not there is a
             * moulding floating on blank plaster - and the four authored
             * interiors carry their own, placed where their own `da` is in
             * scope, because `site.flipDoor` puts half of them on the opposite
             * face from this one. `hasDecorDoor` is drawn either way, so the
             * random stream does not move.
             *
             * The painted door is 1.25 m wide with its head at y0 + 2.3, so the
             * surround sits ON that head, spandrels filling the corners of the
             * rectangle the lintel already spans.
             *
             * This is the change `souk-alley` is about. Every street in this
             * world is walled with rectangles, and the one motif the whole
             * architecture is dressed in - the pointed arch - was absent from a
             * town of two hundred houses. Visual only, like every other facade
             * detail above the sill line. */
            if (!enterable && hasDecorDoor) {
              const DOOR_HALF = 0.78;
              _e1.set(0, wa, 0);
              _q1.setFromEuler(_e1);
              _v1.set(
                px + nx * (half - 0.02),
                y0 + 2.30 - DOOR_HALF * Math.SQRT2,
                pz + nz * (half - 0.02)
              );
              _v2.set(DOOR_HALF, DOOR_HALF, 0.30);
              _m1.compose(_v1, _q1, _v2);
              this._authored(B, 'arch', 'souk', _m1, 0xc9b78f);
            }
          }
        }

        /* Parapet stubs on some roofs, so the skyline is not a flat plane.
         * Offset along the building's own +Z, for the reason set out above -
         * this one used to displace on z only, which slid the parapet clean off
         * the roof of every building on a diagonal. Seated ON the roof plane:
         * the earlier +0.55 lift left a visible air gap under every one.
         *
         * Visual only - no collider. A parapet that stood up as a solid on the
         * deck would be a wall across the middle of every landing. */
        if (rnd() < 0.45) {
          const ph = 0.9 + rnd() * 0.6;
          B.box('plaster.wall', w * 0.9, ph, 0.5,
            px + Math.sin(rot) * d * 0.45, y0 + h + ph * 0.5 - 0.02,
            pz + Math.cos(rot) * d * 0.45, rot, tint);
        }

        /* THE ROOFSCAPE, WHICH IS THE SURFACE THIS WORLD IS PLAYED ON.
         *
         * `tower-top`, `souk-roofs`, `minaret-bridge` and `desert-overview` -
         * four of the thirteen framings, and between them every picture of what
         * this world actually IS - photograph a field of identical flat tan
         * rectangles. The souk's facades have had four rounds of art (cornices,
         * domes, window reveals, awnings, parapet stubs); its ROOFS have had a
         * lip. A game whose subject is rooftop traversal was asking the player
         * to spend its whole second act on undressed slabs, and a roof with
         * something on it is also a roof you can navigate by.
         *
         * `_roofLife` is the procedural half of decision D4: this is bulk
         * content across two hundred buildings, it is boxes and one lathe, and
         * authoring it would be authoring two hundred of the same jar. */
        this._roofLife(B, ring, i, px, pz, y0 + h + 0.55, w, d, rot);

        /* An awning over the street, and its posts: cover, and a mid-height
         * perch. It projects 1.8 m rather than the old 3.2, because the ring
         * streets are now an authored width - 3.1 m at the outer rings - and a
         * 3.2 m awning would have grown straight through the next ring's wall. */
        if (rnd() < 0.3) {
          const ax = px + Math.sin(rot) * (d * 0.5 + 0.9);
          const az = pz + Math.cos(rot) * (d * 0.5 + 0.9);
          B.box('fabric.banner', w * 0.8, 0.12, 1.8, ax, y0 + 3.4, az, rot, 0xc2543a);
          this.track(this.physics.addRotatedBox(
            _v1.set(ax, y0 + 3.4, az), _v2.set(w * 0.4, 0.06, 0.9), rot
          ));
          // Posts under the outer corners - without them the fabric slab
          // reads as a plank floating in the alley.
          const pox = px + Math.sin(rot) * (d * 0.5 + 1.7);
          const poz = pz + Math.cos(rot) * (d * 0.5 + 1.7);
          for (const sgn of [-1, 1]) {
            B.box('wood.beam', 0.16, 3.34, 0.16,
              pox + Math.cos(rot) * sgn * (w * 0.35),
              y0 + 1.67,
              poz - Math.sin(rot) * sgn * (w * 0.35), rot, 0x6a4f31);
          }
        }

        /* A cornice under the roof lip, and a domed roof on a few blocks.
         *
         * Every silhouette in the town was a rectangle with a flat top, and a
         * skyline of nothing but rectangles is most of what reads as blocky
         * however well the faces are shaded. The cornice puts a horizontal
         * shadow line under every roof, and the domes break the ridge line with
         * the one shape in the world that has no edges at all. */
        B.box('stone.castle', w + 1.15, 0.28, d + 1.15, px, y0 + h - 0.32, pz, rot,
          0xd6c6a0);

        if (rnd() < 0.3) {
          const dr = Math.min(w, d) * 0.42;
          const dome = new THREE.SphereGeometry(dr, 14, 8, 0, TAU, 0, Math.PI * 0.52);
          _e1.set(0, rot, 0);
          _q1.setFromEuler(_e1);
          // Centre sits just above the roof plane so the dome's rim (slightly
          // below its centre) tucks into the slab - the old +0.55 lift left
          // every dome hovering over its own building.
          _v1.set(px, y0 + h + 0.12, pz);
          _v2.set(1, 0.82, 1);
          _m1.compose(_v1, _q1, _v2);
          B.add('plaster.wall', dome, _m1, 0xe4d6b4);
          this.track(this.physics.addBox(px, y0 + h + 0.12 + dr * 0.32, pz,
            dr * 0.72, dr * 0.32, dr * 0.72));
          // Finial, so the dome terminates rather than just stopping.
          B.box('wood.beam', 0.16, 0.5, 0.16, px, y0 + h + 0.12 + dr * 0.82 + 0.25, pz, rot, 0x8a6a3a);
        }
      }
    }

    await breathe();
    this._emit(B, 'souk');
    await breathe();
    B.dispose();

    /* A standing spot per roof, resolved once the whole souk is standing.
     *
     * It cannot be done as each roof is pushed: the dome that would block the
     * centre is built LATER IN THE SAME ITERATION, so a probe taken at push
     * time reads the bare deck and answers the centre for every roof. This
     * pass runs after every collider in the souk exists.
     *
     * `x/y/z` are left exactly where they were - they are the footprint centre
     * and the datum every gap in this world is measured between, and moving
     * them would move the rope-bridge landfall anchors and the trial routes
     * with them. `anchor` is the separate question "where on this roof can a
     * body stand", and it is what `Relics` consumes. Without it 8 of the 30
     * citadel relics were sealed inside a dome. */
    for (const r of this._roofs) r.anchor = this._deckSpot(r);
  }

  /**
   * Is this bearing inside the processional corridor?
   *
   * The corridor is the one deliberate break in the roof network: every ring
   * deletes the buildings within `CORRIDOR_HALF` of the gate bearing, which at
   * the outer ring is a 53 m radial gap. It exists so the player arrives on a
   * street that runs the whole way in, and it is not to be closed to buy a
   * connected component - the network routes around the other side.
   */
  _inCorridor(a) {
    return Math.abs(wrapPi(a - GATE_BEARING)) < CORRIDOR_HALF;
  }

  /* ------------------------------------------------------------------ */
  /* Citadel                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * The keep, the great tower and four minarets.
   *
   * The great tower is the world's high anchor at 46 m, and it is banded every
   * 7 m for exactly the reason set out in the file header: a continuous 46 m
   * face is not a climb, it is a stamina failure with a long fall attached.
   */
  async _buildCitadel(breathe = noBreath) {
    const B = new Batch({ ao: 0.38, sky: 0.32, grime: 0.45, span: 7 }, TILE_METRES);
    const cy = MESA_Y;

    // Raised inner ward, so the citadel reads as above the town it commands.
    const wardR = 30;
    const wardH = 6;
    B.box('stone.castle', wardR * 2, wardH, wardR * 2, 0, cy + wardH * 0.5, 0, 0, 0xc7b791);
    this.track(this.physics.addBox(0, cy + wardH * 0.5, 0, wardR, wardH * 0.5, wardR));
    const wardTop = cy + wardH;

    /* Stair up from the souk. The ward has to be reachable on foot as well as
     * by climbing - a vertical world that *requires* the vertical mechanic to
     * see its centrepiece is a world that locks out anyone still learning it. */
    for (let s = 0; s < 10; s++) {
      const sy = cy + (s + 0.5) * (wardH / 10);
      const sz = wardR + 6 - s * 0.7;
      B.box('stone.cobble', 9, wardH / 10, 1.6, 0, sy, sz, 0, 0xb6a68a);
      this.track(this.physics.addBox(0, sy, sz, 4.5, wardH / 20, 0.8));
    }

    // Keep.
    const kw = 26;
    const kh = 20;
    B.box('stone.castle', kw, kh, kw * 0.8, 0, wardTop + kh * 0.5, -4, 0, 0xd0c096);
    this.track(this.physics.addBox(0, wardTop + kh * 0.5, -4, kw * 0.5, kh * 0.5, kw * 0.4));
    for (const ly of [0.34, 0.68]) {
      const by = wardTop + kh * ly;
      B.box('stone.castle', kw + 1.2, 0.6, kw * 0.8 + 1.2, 0, by, -4, 0, 0xb5a483);
      this.track(this.physics.addBox(0, by, -4, (kw + 1.2) * 0.5, 0.3, (kw * 0.8 + 1.2) * 0.5));
    }
    B.box('stone.castle', kw + 2, 1.4, kw * 0.8 + 2, 0, wardTop + kh + 0.7, -4, 0, 0xc3b28f);
    this.track(this.physics.addBox(0, wardTop + kh + 0.7, -4, (kw + 2) * 0.5, 0.7, (kw * 0.8 + 2) * 0.5));
    this._roofs.push({ x: 0, y: wardTop + kh + 1.4, z: -4, w: kw, d: kw * 0.8 });
    /* The keep's crowning cornice. `ward-centre` frames this face and nothing
     * else; it was 26 m of unbroken checkerboard ashlar under a plain slab. The
     * course runs on all four sides because the ward is walked round, and the
     * keep is the only building in the world seen from every bearing inside the
     * wall. Its shaft is 26 x 20.8 rather than square, which is exactly why
     * `_corbelRing` takes two half-extents: fed one it would have dressed the
     * two long faces 2.6 m inside the masonry. */
    this._corbelRing(B, 'citadel', 0, wardTop + kh, -4, 0, [kw * 0.5, kw * 0.4], 1.0,
      { drop: 1.2, project: 1.15, tint: 0xd6c6a2 });

    /* Great tower. The high anchor and the leap-of-faith platform. */
    const tw = 11;
    const th = 46;
    const tx = 0;
    const tz = -18;
    B.box('stone.castle', tw, th, tw, tx, wardTop + th * 0.5, tz, 0, 0xd6c69c);
    this.track(this.physics.addBox(tx, wardTop + th * 0.5, tz, tw * 0.5, th * 0.5, tw * 0.5));
    /* Rest ledges every 7 m. Load-bearing for the climb, not decoration - and
     * since Drop Two, load-bearing for the *fall* as well.
     *
     * They used to be `tw + 1.5` = 12.5 m across against a `tw + 2.4` = 13.4 m
     * crown, so the crown overhung its own galleries by 0.45 m. Measured, that
     * one number was the whole of R4's failure: a body stepping off the crown
     * cleared every ledge on the tower and hit the inner ward 47.60 m below,
     * which is past `LETHAL_SPEED`. All 25 unsurvivable roof-edge samples in
     * the world were this edge.
     *
     * `LEDGE_OUT` is now 2.2 m rather than 0.75, which puts the gallery 1.0 m
     * PROUD of the crown: the drop off the crown is caught by the top gallery
     * 5.32 m down, and 5.32 is inside the 7.5 m at which fall damage begins. It
     * is also what a machicolated tower actually looks like - the fighting
     * gallery is meant to overhang the wall it defends - so the fix reads as
     * architecture rather than as a safety rail.
     *
     * The clearance is checked against the probe, not by eye: the fall sampler
     * steps 0.45 m off the crown edge, i.e. 6.7 + 0.45 = 7.15 m from the axis,
     * and the gallery half-extent is 7.60 m. 0.45 m of margin. */
    const LEDGE_OUT = 2.2;
    for (let y = 7; y < th; y += 7) {
      B.box('stone.castle', tw + LEDGE_OUT * 2, 0.55, tw + LEDGE_OUT * 2, tx, wardTop + y, tz, 0, 0xb9a887);
      this.track(this.physics.addBox(tx, wardTop + y, tz,
        tw * 0.5 + LEDGE_OUT, 0.28, tw * 0.5 + LEDGE_OUT));
    }
    /* A corbel course under the top rest gallery, which is the one the crown
     * overhangs and the one a leap of faith is caught by. Only the top one:
     * there are six galleries up this tower, they are the same slab six times,
     * and dressing all of them would be 1,968 triangles to repeat a detail
     * nobody reads twice. The top gallery is the one in `tower-top`,
     * `minaret-bridge` and every silhouette from the ring. */
    {
      const topLedge = wardTop + Math.floor((th - 1) / 7) * 7;
      this._corbelRing(B, 'citadel', tx, topLedge - 0.28, tz, 0, [tw * 0.5, tw * 0.5], LEDGE_OUT,
        { drop: 1.4, project: 1.6, tint: 0xd8c9a4 });
    }

    // Crown and the jutting beam a leap of faith launches from.
    B.box('stone.castle', tw + 2.4, 1.6, tw + 2.4, tx, wardTop + th + 0.8, tz, 0, 0xcabb96);
    this.track(this.physics.addBox(tx, wardTop + th + 0.8, tz, (tw + 2.4) * 0.5, 0.8, (tw + 2.4) * 0.5));
    const beamHalf = 3.5;
    // 0.3 m in from the very tip: a launch point published exactly on a
    // collider's boundary is a coin toss between the beam and the air.
    const beamTipZ = tz + 5 + beamHalf - 0.3;
    const beamTopY = wardTop + th + 2.15;
    B.box('wood.beam', 1.1, 0.5, beamHalf * 2, tx, wardTop + th + 1.9, tz + 5, 0, 0x5d462c);
    this.track(this.physics.addBox(tx, wardTop + th + 1.9, tz + 5, 0.55, 0.25, beamHalf));

    const towerTopY = wardTop + th + 1.6;
    this._towers.push({ x: tx, y: towerTopY, z: tz, r: tw * 0.5, great: true });
    /* The beam points at +Z, toward the keep and the ward beyond it - and the
     * haystack rule used to offset *radially outward*, which for a tower at
     * (0, -18) is -Z. The hay landed 12.5 m behind the jump, on the wrong side
     * of the tower entirely. Every viewpoint now publishes the line it is
     * launched along, and the hay is placed on that line rather than on a
     * bearing derived from where the tower happens to stand.
     *
     * `run` is not a guess. Driven through the real integrator: a leap leaves
     * the beam at 11.64 m/s horizontal and 7.168 m/s up, clears the keep roof
     * (26.75 m down, and the arc is still at y 55.4 when it crosses the keep's
     * far parapet), and comes down on the ward 48.15 m below after 28.53 m.
     * Launched from the beam's root instead of its tip it falls 5.8 m short of
     * the keep's far edge and lands ON the keep roof, 26.75 m - damage, not
     * death. So the survivable band for a leap from anywhere along the beam is
     * z 13.6 to 19.0, and the hay sits in the middle of it with a radius that
     * covers the whole band. */
    this.viewpoints.push({
      id: 'great-tower',
      name: 'The Great Tower',
      x: tx, y: towerTopY, z: tz,
      r: (tw + 2.4) * 0.5,
      launch: { x: tx, y: beamTopY, z: beamTipZ },
      bearing: Math.PI * 0.5,
      hay: { run: 26.1, r: 3.6 },
    });

    /* Minarets: four thin towers, the rope-bridge anchors. Thin is the point -
     * they are the hardest free-climbs in the world because there is no wide
     * face to rest on, only the balcony rings. */
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + Math.PI * 0.25;
      const px = Math.cos(a) * 21;
      const pz = Math.sin(a) * 21;
      const mh = 30;
      const mw = 4.4;
      B.box('plaster.wall', mw, mh, mw, px, wardTop + mh * 0.5, pz, a, 0xe0d2ae);
      this.track(this.physics.addRotatedBox(
        _v1.set(px, wardTop + mh * 0.5, pz), _v2.set(mw * 0.5, mh * 0.5, mw * 0.5), a
      ));
      // Balcony rings.
      for (const by of [11, 21]) {
        B.box('wood.beam', mw + 2.2, 0.4, mw + 2.2, px, wardTop + by, pz, a, 0x6a5133);
        this.track(this.physics.addRotatedBox(
          _v1.set(px, wardTop + by, pz), _v2.set((mw + 2.2) * 0.5, 0.2, (mw + 2.2) * 0.5), a
        ));
        this._corbelRing(B, 'citadel', px, wardTop + by - 0.2, pz, a, [mw * 0.5, mw * 0.5], 1.1,
          { drop: 0.85, project: 1.1, tint: 0xe6d8b4 });
      }
      // Gallery under the cap - the ring a muezzin would stand on, and the last
      // rest before the top of the hardest climb in the world.
      B.box('stone.castle', mw + 2.6, 0.5, mw + 2.6, px, wardTop + mh - 0.25, pz, a, 0xd8c8a2);
      this.track(this.physics.addRotatedBox(
        _v1.set(px, wardTop + mh - 0.25, pz), _v2.set((mw + 2.6) * 0.5, 0.25, (mw + 2.6) * 0.5), a
      ));
      /* The muezzin's gallery gets the deepest course of the three. This is the
       * ring `desert-overview` and `eyrie-summit` read the minaret by from 231
       * and 312 m: below it the shaft is in shadow, above it the cap is lit, and
       * the corbels are what put a hard line between the two. */
      this._corbelRing(B, 'citadel', px, wardTop + mh - 0.5, pz, a, [mw * 0.5, mw * 0.5], 1.3,
        { drop: 0.95, project: 1.25, tint: 0xe6d8b4 });
      /* An onion dome instead of a flat slab.
     *
       * A minaret capped with a box is a chimney. This is the world's most
       * distant readable silhouette - four of them stand above everything but
       * the great tower - so it is worth the one sphere each. */
      const capR = mw * 0.92;
      const cap = new THREE.SphereGeometry(capR, 16, 10, 0, TAU, 0, Math.PI * 0.58);
      _e1.set(0, a, 0);
      _q1.setFromEuler(_e1);
      _v1.set(px, wardTop + mh + 0.1, pz);
      _v2.set(1, 1.5, 1);      // stretched tall: an onion, not a hemisphere
      _m1.compose(_v1, _q1, _v2);
      B.add('roof.tile', cap, _m1, 0xbcc8d4);
      B.box('wood.beam', 0.22, 1.5, 0.22, px, wardTop + mh + capR * 1.5 + 0.6, pz, a, 0x8a6a3a);
      this.track(this.physics.addRotatedBox(
        _v1.set(px, wardTop + mh + 0.6, pz), _v2.set(capR * 0.7, 0.9, capR * 0.7), a
      ));
      this._towers.push({ x: px, y: wardTop + mh + 1.5, z: pz, r: mw * 0.5, minaret: true });
      /* Tangential, not radial. Offsetting the hay radially outward from a
       * minaret at r = 21 puts it at r = 28.6, which is under the inner souk
       * ring's roof overhang - measured, three of the four landed on a souk
       * roof 9 to 12 m over the ward. Along the ring instead, 8 m out, every
       * one of them stands on open ward: the keep occupies x +/-14 and z -15.4
       * to +7.4 and the great tower x +/-6.7, and these four clear both.
     *
       * A minaret is not the leap-of-faith platform - the drop to the ward is
       * 31.5 m, which is damage rather than death - so this hay is the answer
       * to a missed balcony rather than to a committed jump. That is why the
       * run is 8 m and not the 23.9 m a leap from up here would carry.
     *
       * AND THAT IS WHY THERE IS NO `launch` HERE.
     *
       * `Viewpoints.normaliseViewpoint` treats `launch` + `hay` published
       * together as the declaration "this viewpoint HAS a leap of faith", and
       * raises "Leap of faith - hay 29 m below" the moment a body stands
       * within LEAP_R = 3.0 m of the launch point. The minaret launch point
       * WAS the platform centre, so syncing a minaret always raised the offer.
       * Flown through the real integrator from that point on the published
       * bearing, against the built colliders, not one of the four arrives:
     *
       *   minaret-1  leap   lands (-2.44, 18.20, 32.14)  run 24.45  16.45 m
       *                     from its hay, 40.7 m/s into the souk
       *   minaret-2  leap   BLOCKED by the ward wall at (-30.49, 25.06, -0.79)
       *   minaret-3  leap   lands on the great tower's rest gallery at y 48.28
       *   minaret-4  leap   BLOCKED by the ward wall at (30.63, 24.48, 0.93)
     *
       * A sprint jump instead runs 16.40 m off all four and lands on the ward
       * at y 20.0 - a 31.5 m fall at 38.5 m/s against SAFE_SPEED 18, still
       * 8.40 m from the hay. Only a standing walk jump (2.61 m, still on the
       * platform) or a plain step-off reaches it, which is the "missed
       * balcony" this hay was placed for.
     *
       * Withholding `launch` is the whole fix: `normaliseViewpoint`'s `paired`
       * gate drops BOTH fields, so there is no prompt. The hay is still built -
       * `_buildDressing` falls back to the viewpoint's own point, which for a
       * minaret is the identical coordinate - and syncing, revealing and fast
       * travel are untouched, because none of them reads `launch`. */
      this.viewpoints.push({
        id: `minaret-${i + 1}`,
        name: `Minaret ${i + 1}`,
        x: px, y: wardTop + mh + 1.5, z: pz,
        r: (mw + 2.6) * 0.5,
        bearing: a + Math.PI * 0.5,
        hay: { run: 8.0, r: 3.2 },
      });
    }

    await breathe();
    this._emit(B, 'citadel');
    await breathe();
    B.dispose();
  }

  /* ------------------------------------------------------------------ */
  /* Rope bridges                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Plank bridges strung between the minarets and the great tower.
   *
   * Each plank is its own collider. That is more colliders than a single long
   * box would be, but a bridge you can fall *between* is a bridge the player
   * reads as real, and the broadphase grid makes the cost of a few hundred
   * small boxes negligible.
   */
  async _buildRopeBridges(breathe = noBreath) {
    // Planks and ropes are seen from above and below in equal measure, so the
    // sky term carries this one and the ground-contact AO is nearly off.
    const B = new Batch({ ao: 0.12, sky: 0.4, grime: 0.2, span: 1.2 }, TILE_METRES);
    const minarets = this._towers.filter((t) => t.minaret);
    const walls = this._towers.filter((t) => t.wall);
    const great = this._towers.find((t) => t.great);
    if (minarets.length < 2) return;

    const links = [];
    for (let i = 0; i < minarets.length; i++) {
      links.push({ a: minarets[i], b: minarets[(i + 1) % minarets.length], id: `minaret-loop-${i}` });
    }

    /* And out to the perimeter, which is what this function has always said it
     * did and never once managed.
     *
     * The old code was three lines: find a non-minaret tower under 48 m, link
     * it to `minarets[0]`, then `if (span < 6 || span > 90) continue`. The span
     * is 99.0 m. It was rejected silently on the very next line, every build,
     * since the day it was written - so four 29.7 m loops shipped, all of them
     * inside r = 21, and the "network reaches the perimeter" comment described
     * a bridge that did not exist. The 46 m great tower had none at all.
     *
     * Three things had to change to make the intent real:
     *
     *  1. the limit. 90 -> 132, which is the diagonal of this mesa and so the
     *     longest span the world can physically want;
     *  2. the anchor pick. `find` returned whichever wall tower was pushed
     *     first; each perimeter span now names the bearing it wants to leave on
     *     and takes the wall tower nearest to it;
     *  3. **the height interpolation, which was the real bug.** `y0 = min(a.y,
     *     b.y) - 0.6` then `py = y0 + (b.y - a.y) * t` starts the deck at the
     *     LOWER anchor's height and then applies the full difference again. For
     *     the four minaret loops `a.y === b.y` so it is correct by accident;
     *     for a minaret at 51.5 m running out to a wall tower at 32.2 m it puts
     *     the first plank 19.9 m below the minaret it is tied to and the last
     *     one 19.3 m below the tower. Every unequal span this function could
     *     ever have built would have been a bridge to nowhere with a 20 m drop
     *     at each end. It lerps between the two anchors now.
     *
     * Walkability is not asserted here, it is measured: `citadel-reach`
     * detects the planks by their collider shape and walks the chain, and the
     * per-plank step is what has to stay under `NPC.GROUND_PROBE_UP` = 0.95 m.
     * The great-tower span is the steep one - 35.4 m of descent over 101.6 m of
     * span, plus the catenary - and it comes out at 0.63 m per plank.
     */
    const perimeter = [
      { from: minarets[0], out: Math.PI * 0.25, id: 'minaret-perimeter' },
      { from: great, out: -Math.PI * 0.62, id: 'great-tower-perimeter' },
    ];
    for (const spec of perimeter) {
      if (!spec.from || !walls.length) continue;
      let best = null;
      let bestD = Infinity;
      for (const t of walls) {
        const d = Math.abs(wrapPi(Math.atan2(t.z - spec.from.z, t.x - spec.from.x) - spec.out));
        if (d < bestD) { bestD = d; best = t; }
      }
      if (!best) continue;
      links.push({ a: spec.from, b: best, id: spec.id });

      /* Landfall: the same wall tower, back down into the outer souk.
     *
       * Reaching the perimeter is only half of what "so the network reaches
       * the perimeter" means. Measured with only the long span in place, the
       * citadel core and its bridges formed their own 166-node island: the
       * minarets could see the wall and the wall could see the minarets, and
       * neither could see the town. A 15 m span from the tower down onto the
       * nearest outer-ring roof is what makes the whole thing one network, and
       * it is also the route the design wants a player to find - run the souk
       * out to the wall, take the ramparts, and cross the sky to the citadel.
     *
       * Anchored on the roof's own edge rather than its centre, or the last
       * few planks hang in the air over somebody's roof. */
      let roof = null;
      let roofD = Infinity;
      const outerRing = SOUK_RINGS.length - 1;
      for (const r of this._roofs) {
        if (r.ring !== outerRing) continue;
        const d = Math.hypot(r.x - best.x, r.z - best.z);
        if (d < roofD) { roofD = d; roof = r; }
      }
      if (!roof) continue;
      const toTower = Math.atan2(best.z - roof.z, best.x - roof.x);
      const edge = Math.min(roof.w, roof.d) * 0.5 - 0.4;
      links.push({
        a: best,
        b: { x: roof.x + Math.cos(toTower) * edge, y: roof.y, z: roof.z + Math.sin(toTower) * edge },
        id: `${spec.id}-landfall`,
      });
    }

    // Published so the trials, the minimap and the viewpoint prompts can all
    // read the same spans rather than each recomputing the generator.
    this.ropeBridges.length = 0;

    for (const { a, b, id } of links) {
      /* One yield per span. Each is ~35 planks with a collider and two rail
       * posts apiece, which is the largest block of collider registrations left
       * in the build once the souk is sliced. */
      await breathe();
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const span = Math.hypot(dx, dz);
      if (span < 6 || span > 132) continue;
      const dirY = Math.atan2(dz, dx);
      /* THE SIGN AGAIN, and this is the second time in this file.
     *
       * `dirY` is the WORLD BEARING of the span and is what the lateral rail
       * offsets below are measured on. It is NOT the rotation that puts a box
       * along it: `makeRotationY(t)` (and `Batch.box`, which composes the same
       * Euler) puts local +X at world `(cos t, -sin t)`, so the world bearing
       * of local +X is `-t`. Passing `dirY` turns every plank by `2*dirY` off
       * its own span.
     *
       * The four minaret loops run at bearings 180/-90/0/90, where `2*dirY` is
       * a multiple of pi and a box is symmetric under it - so this was correct
       * by accident for the whole life of the loops and only became visible on
       * the long spans this drop adds. Measured off the collider matrices, the
       * skew was 36.0 deg on minaret-perimeter and 53.1 deg on
       * great-tower-perimeter, and a 2.2 m walkway laid herringbone develops
       * saw-tooth voids at both rails: sampling plank coverage every 5 cm at
       * lateral +-1.0 m found a longest hole of 0.90 m and 1.15 m on those two
       * spans against the authored 0.25 m plank gap on the centreline. Wide
       * enough to drop a body that drifts to the rail. */
      const rotY = -dirY;
      /* Plank count is bounded by the STEP as well as by the span. 1.4 m of
       * span per plank is right for a level bridge; on the landfall span it
       * would be 11.6 m of descent over eleven planks, a 1.05 m drop each,
       * which is over `NPC.GROUND_PROBE_UP` = 0.95 m and so is not a walk at
       * all. Capping the rise at 0.6 m per plank leaves room for the catenary
       * on top of it - the sag contributes another 0.15 m at the ends. */
      const steps = Math.max(6, Math.round(span / 1.4), Math.ceil(Math.abs(b.y - a.y) / 0.6));
      // Both ends hang 0.6 m under the deck they are tied to, and the walk
      // between them is a straight lerp with the catenary taken off it.
      const ay = a.y - 0.6;
      const by = b.y - 0.6;

      let worstStep = 0;
      let prevY = a.y;
      let mid = null;
      const midStep = Math.round(steps / 2);
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = a.x + dx * t;
        const pz = a.z + dz * t;
        // Catenary sag - a taut bridge reads as a girder, a sagging one as rope.
        const sag = Math.sin(t * Math.PI) * Math.min(3.4, span * 0.055);
        const py = ay + (by - ay) * t - sag;
        worstStep = Math.max(worstStep, Math.abs(py - prevY));
        prevY = py;
        // The lowest point of the catenary, published rather than re-derived:
        // a trial checkpoint on a rope bridge has to sit on a plank that
        // exists, and `(a.y + b.y)/2 - sag` is arithmetic, not a plank.
        if (s === midStep) mid = { x: px, y: py, z: pz };
        B.box('wood.plank', 1.15, 0.13, 2.2, px, py, pz, rotY, 0x74583a);
        this.track(this.physics.addRotatedBox(
          _v1.set(px, py, pz), _v2.set(0.6, 0.09, 1.1), rotY
        ));
        // Hand ropes either side, as thin rails. The OFFSET is a world-space
        // displacement and so is measured on `dirY`; the rail's own rotation
        // is `rotY`, for the reason recorded above.
        if (s % 2 === 0) {
          for (const side of [-1, 1]) {
            const ox = Math.cos(dirY + Math.PI / 2) * 1.05 * side;
            const oz = Math.sin(dirY + Math.PI / 2) * 1.05 * side;
            B.box('wood.beam', 1.3, 0.08, 0.08, px + ox, py + 0.95, pz + oz, rotY, 0x4f3d28);
          }
        }
      }
      worstStep = Math.max(worstStep, Math.abs(b.y - prevY));
      this.ropeBridges.push({
        id, span, planks: steps + 1, worstStep, mid,
        a: { x: a.x, y: a.y, z: a.z }, b: { x: b.x, y: b.y, z: b.z },
      });
    }

    await breathe();
    this._emit(B, 'bridges', { cast: true, recv: false });
    await breathe();
    B.dispose();
  }

  /* ------------------------------------------------------------------ */
  /* Dressing                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Haystacks, market stalls and banners.
   *
   * The haystacks are the important part and they are placed by rule, not by
   * eye: one under every viewpoint, so a leap of faith always has an answer.
   * `Player` reads `world.haystacks` to know a fall is survivable.
   */
  async _buildDressing(breathe = noBreath) {
    const B = new Batch({ ao: 0.44, sky: 0.3, grime: 0.6, span: 1.8 }, TILE_METRES);
    const rnd = this.rnd;

    /* One haystack per viewpoint, on the line that viewpoint is LAUNCHED along
     * and standing on a surface that exists.
     *
     * Both halves of that sentence are repairs. The height came from
     * `_groundAt`, which is terrain and nothing else, so all five viewpoint
     * haystacks were recorded at y 16.4 while the inner ward they stand on is
     * solid from y 14 to y 20: the thatch was invisible, its collider was
     * inside another solid, and `Parkour._softLandingAt` - which compares the
     * body's y against the hay's recorded y - could never credit any of them.
     * Three of eleven caught anything. `_deckAt` asks the collision world
     * instead, and its docstring says why `_groundAt` was not simply replaced.
     *
     * The bearing came from `atan2(vp.z, vp.x)`, the direction of the viewpoint
     * from the middle of the world, which has nothing to do with which way the
     * player is facing when they jump. Each viewpoint now publishes its own
     * `launch` point and `bearing`; see `_buildCitadel` for how each was
     * derived and what it was measured against. */
    for (const vp of this.viewpoints) {
      const spec = vp.hay;
      /* `launch ?? vp`: a viewpoint that publishes no launch point still gets
       * its haystack, laid on its own bearing from its own centre. The four
       * minarets are that case and their launch point WAS their centre, so the
       * hay lands on the identical coordinate it always did - see the comment
       * over the minaret `viewpoints.push` for why the field went away. */
      const origin = vp.launch ?? vp;
      const hx = origin.x + Math.cos(vp.bearing) * spec.run;
      const hz = origin.z + Math.sin(vp.bearing) * spec.run;
      const hy = this._deckAt(hx, hz);
      const bw = spec.r * 1.625;                 // the thatch pile around the catch radius
      B.box('thatch.roof', bw, 2.4, bw, hx, hy + 1.2, hz, rnd() * 0.4, 0xd8bd6e);
      this.track(this.physics.addBox(hx, hy + 1.0, hz, bw * 0.5, 1.0, bw * 0.5));
      const hay = { x: hx, y: hy + 2.4, z: hz, r: spec.r };
      this.haystacks.push(hay);
      vp.hay = hay;                              // resolved, for anything downstream
    }

    /* A few more in the pomerium - the open lane the souk leaves between its
     * outer ring and the curtain wall - under the rampart traversal line.
     *
     * `RAMPART_HAY_R` sits in that lane by construction: the souk's outer roof
     * face is at RING_R[6] + (dLip)/2 and the wall's inner face at 118 - 1.3,
     * and this radius is the middle of what is left. It was 104 m, which the
     * re-authored souk now builds on top of. */
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + 0.7;
      const hx = Math.cos(a) * RAMPART_HAY_R;
      const hz = Math.sin(a) * RAMPART_HAY_R;
      const hy = this._deckAt(hx, hz);
      B.box('thatch.roof', 4.6, 2.2, 4.6, hx, hy + 1.1, hz, rnd() * 0.5, 0xd2b768);
      this.track(this.physics.addBox(hx, hy + 0.95, hz, 2.3, 0.95, 2.3));
      this.haystacks.push({ x: hx, y: hy + 2.2, z: hz, r: 2.9 });
    }

    /* Market stalls in the plaza, and crates that make good first steps.
     *
     * ── THE DART IS CHECKED NOW, AND THE STREAM IS NOT TOUCHED ────────────
     *
     * This was the one prop loop in the world with no clearance test at all -
     * the palms, the stalls, the pottery and the carts all go through
     * `_openSpot` and these did not. One of the 34 landed at (23.60, 42.19),
     * inside the Spice Merchants House at (25.13, 39.84): its collider spans
     * y 14.00 to 15.00, and the house's authored `collectibleSpots` entry sits
     * at y 14.72, INSIDE it. One of the world's ten authored collectibles was
     * not visible where it was advertised, and no test asked whether an
     * authored spot stands in open air.
     *
     * The fix is a gate on the EMISSION and not on the dart, and that is
     * deliberate. `_openSpot` rejection-samples, so routing this loop through
     * it would consume a variable number of draws from `this.rnd` and move
     * every palm, stall, pot and cart placed after it - the extent stage
     * measured exactly that cost when one clipping literal changed how many
     * draws the dune loop took and the whole town moved. So every random this
     * loop ever drew is still drawn, in the same order, in every branch; only
     * the box and the collider are withheld. A crate fewer, and nothing else in
     * the world moves by a float.
     */
    for (let i = 0; i < 34; i++) {
      const a = rnd() * TAU;
      const r = 40 + rnd() * 62;
      const px = Math.cos(a) * r;
      const pz = Math.sin(a) * r;
      const py = MESA_Y;
      const w = 1.6 + rnd() * 1.2;
      const yaw = rnd() * TAU;
      /* The same two questions `_openSpot` asks, in the same order: the roof
       * list for a footprint, then the collision world for everything the roof
       * list does not know about. */
      let clear = true;
      const keepR = w * 0.5 + 0.5;
      for (const b of this._roofs) {
        const dx = px - b.x;
        const dz = pz - b.z;
        const keep = Math.max(b.w, b.d) * 0.5 + keepR;
        if (dx * dx + dz * dz < keep * keep) { clear = false; break; }
      }
      if (clear) {
        const hit = this.physics.groundHeight(px, pz, py + 14, 22);
        if (hit !== null && hit > py + 0.6) clear = false;
      }
      if (clear) {
        B.box('wood.plank', w, 1.0, w, px, py + 0.5, pz, yaw, 0x7d5f3c);
        this.track(this.physics.addBox(px, py + 0.5, pz, w * 0.5, 0.5, w * 0.5));
      }
      const canopy = rnd() < 0.5;
      if (canopy) {
        const ca = rnd() * TAU;
        const warm = rnd() < 0.5;
        if (clear) {
          B.box('fabric.banner', w + 1.4, 0.1, w + 1.4, px, py + 2.5, pz, ca,
            warm ? 0xb8452f : 0x2f6ba8);
          // Corner posts, or the canopy is a carpet hovering over the crate.
          const ph = (w + 1.4) * 0.5 - 0.18;
          const ps = Math.sin(ca), pc = Math.cos(ca);
          for (const [ux, uz] of [[-ph, -ph], [ph, -ph], [-ph, ph], [ph, ph]]) {
            B.box('wood.beam', 0.14, 2.5, 0.14,
              px + pc * ux + ps * uz, py + 1.25, pz - ps * ux + pc * uz, ca, 0x6a4f31);
          }
        }
      }
    }

    await breathe();
    this._emit(B, 'dressing');
    await breathe();
    B.dispose();

    await this._buildTrees(breathe);
    await this._buildProps(breathe);

    /* Banners on the keep - the one animated thing in the world, so the town
     * does not read as a still life. Kept to a handful of separate meshes
     * because they need their own per-frame transform. */
    const banner = this._mat('fabric.banner');
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      const geo = new THREE.PlaneGeometry(2.2, 5.4, 1, 6);
      this._owned.push(geo);
      const m = new THREE.Mesh(geo, banner);
      m.position.set(Math.cos(a) * 14, MESA_Y + 24, Math.sin(a) * 14 - 4);
      m.rotation.y = a + Math.PI / 2;
      m.castShadow = true;
      m.name = 'citadel:banner';
      this.group.add(m);
      this._banners.push({ mesh: m, phase: i * 1.7, geo });
    }
  }

  /**
   * A spot on the mesa that is not inside a building.
   *
   * Rejection sampling against the roof list, which already records every
   * block's footprint. Returns null rather than a bad spot, so a caller that
   * cannot be placed simply is not - a palm growing through a wall is worse
   * than one palm fewer.
   *
   * @returns {{x:number, z:number}|null}
   */
  _openSpot(rnd, rMin, rMax, pad = 3.2) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const a = rnd() * TAU;
      const r = rMin + rnd() * (rMax - rMin);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      let ok = true;
      for (const b of this._roofs) {
        const dx = x - b.x;
        const dz = z - b.z;
        const keep = Math.max(b.w, b.d) * 0.5 + pad;
        if (dx * dx + dz * dz < keep * keep) { ok = false; break; }
      }
      if (!ok) continue;

      /* And then ask the collision world, which knows about everything the roof
       * list does not: the curtain wall, the keep, the minarets, the gate
       * towers, the rope bridges. Checking footprints alone put palms inside the
       * curtain wall, because a wall is not a roof and never appears in that
       * list. A downward cast from head height finds anything solid standing on
       * this spot regardless of which builder made it. */
      const g = this._groundAt(x, z);
      const hit = this.physics.groundHeight(x, z, g + 14, 22);
      if (hit !== null && hit > g + 0.6) continue;

      return { x, z };
    }
    return null;
  }

  /**
   * Palms, stalls, pottery and carts.
   *
   * The town was structurally finished long before it was *inhabited*: from the
   * wall the plaza read as a hundred metres of empty brown, because everything
   * built so far is either a wall to climb or a roof to land on. None of this
   * is climbing furniture - it exists so the ground has something on it at the
   * scale a person occupies, which is the difference between a level and a
   * place. Batched into the same handful of draw calls as everything else.
   */
  /**
   * Date palms and cypresses, instanced.
   *
   * ── Why these were rebuilt ────────────────────────────────────────────────
   *
   * The first version was boxes: a stack of cuboid drums for the trunk and flat
   * slabs for the fronds, merged into the props batch and flat-tinted. It read
   * as a broken umbrella on a post, and it was the last thing in this world
   * still made of literal boxes.
   *
   * ── The two things that make a palm a palm ────────────────────────────────
   *
   * 1. **The crown is a fountain, not a disc.** Fronds leave the head at every
   *    angle from near-vertical to hanging below the horizontal, and each one
   *    *arcs* rather than sloping. A ring of straight blades at one pitch is
   *    the single most common way a procedural palm goes wrong.
   * 2. **The trunk is a lattice, not a cylinder.** What is left after old
   *    fronds are shed is a column of diamond-shaped stubs, which the bark
   *    surface carries, over a trunk that leans and bows rather than standing
   *    plumb.
   *
   * Instanced: two draw calls per species regardless of how many are planted,
   * because a desert town wants a lot of them and they are all the same tree.
   */
  async _buildTrees(breathe = noBreath) {
    const rnd = this.rnd;

    /* ---- one palm, built once ---- */
    const trunkSecs = [];
    const H = 6.4;
    for (let i = 0; i <= 9; i++) {
      const t = i / 9;
      // Bows away from vertical as it rises, the way a palm carries its head
      // slightly off centre. Straight trunks look like scaffolding poles.
      trunkSecs.push({
        x: Math.sin(t * 1.5) * 0.34 * t,
        y: t * H,
        z: Math.cos(t * 2.1) * 0.16 * t,
        // Slight swell at the base and just under the crown, as a real one has.
        rx: 0.30 - t * 0.11 + Math.exp(-t * 9) * 0.10,
        ry: 0.30 - t * 0.11 + Math.exp(-t * 9) * 0.10,
      });
    }
    const palmTrunk = sweep(trunkSecs, 12, { capStart: false });
    const crownX = trunkSecs[9].x;
    const crownY = trunkSecs[9].y;
    const crownZ = trunkSecs[9].z;

    const fronds = [];
    const NF = 22;
    for (let f = 0; f < NF; f++) {
      const fa = (f / NF) * TAU + rnd() * 0.16;
      /* Pitch runs from nearly upright on the newest fronds to below the
       * horizontal on the oldest, which is what gives the crown its fountain
       * shape. Alternating rather than sequential so the two extremes are never
       * adjacent - a crown sorted by age reads as a shuttlecock. */
      const age = (f % 2 === 0 ? f / NF : 1 - f / NF);
      const pitch = 0.95 - age * 1.75;          // +0.95 rad up .. -0.80 rad down
      const len = 3.6 + rnd() * 1.1;
      const segs = 8;
      /* One continuous sweep along the whole frond, not a chain of separate
       * ones.
     *
       * Built segment-by-segment as independent sweeps, each piece capped its
       * own ends and carried its own frame, so a frond rendered as six detached
       * paddle-shaped leaves hanging in a row - which is exactly how the first
       * crown looked. Collecting the stations first and sweeping once gives a
       * single surface with a continuous normal along its length, which is what
       * a frond is. */
      const stations = [];
      let px = crownX;
      let py = crownY;
      let pz = crownZ;
      let ang = pitch;
      for (let s = 0; s <= segs; s++) {
        const t = s / segs;
        // Narrow and long: a date frond is a spine carrying leaflets, and the
        // leaflet detail is in the surface rather than in the silhouette.
        // Widest a third of the way out, tapering to a point.
        const w = (0.10 + Math.sin(Math.pow(t, 0.8) * Math.PI) * 0.15) * (1 - t * 0.55);
        stations.push({ x: px, y: py, z: pz, rx: Math.max(0.012, w), ry: 0.016 });
        if (s === segs) break;
        const segLen = len / segs;
        // Curvature accumulates along the frond, so it arcs over instead of
        // running straight out - the arc is most of the silhouette.
        ang -= (0.13 + age * 0.085);
        px += Math.cos(fa) * Math.cos(ang) * segLen;
        py += Math.sin(ang) * segLen;
        pz += Math.sin(fa) * Math.cos(ang) * segLen;
      }
      fronds.push(sweep(stations, 4, { capStart: false }));
    }
    // Date clusters hanging under the crown.
    for (let d = 0; d < 3; d++) {
      const da = (d / 3) * TAU + 0.4;
      fronds.push(blob(0.26, 0.34, 0.26,
        crownX + Math.cos(da) * 0.42, crownY - 0.42, crownZ + Math.sin(da) * 0.42, 8));
    }
    const palmCrown = mergeGeometries(fronds.map(g => g.index ? g.toNonIndexed() : g), false);
    for (const g of fronds) g.dispose();

    /* ---- one cypress ---- */
    const cypTrunk = sweep([
      { y: 0, z: 0, rx: 0.16, ry: 0.16 },
      { y: 1.6, z: 0, rx: 0.11, ry: 0.11 },
      { y: 3.4, z: 0, rx: 0.07, ry: 0.07 },
    ], 8, { capStart: false });
    // A flame, not a cone: cypresses are widest a third up and taper to a point.
    const cypSecs = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const r = Math.sin(Math.pow(t, 0.55) * Math.PI * 0.92) * 0.92;
      cypSecs.push({ y: 0.6 + t * 6.6, z: 0, rx: Math.max(0.03, r), ry: Math.max(0.03, r) });
    }
    const cypCrown = sweep(cypSecs, 12);

    /* ---- plant them ---- */
    const specs = [
      { trunk: palmTrunk, crown: palmCrown, bark: 'bark.palm', leaf: 'foliage.frond',
        count: 46, rMin: 28, rMax: 124, pad: 4.2, scale: [0.82, 1.25] },
      { trunk: cypTrunk, crown: cypCrown, bark: 'wood.beam', leaf: 'foliage.frond',
        count: 22, rMin: 34, rMax: 118, pad: 3.4, scale: [0.75, 1.15] },
    ];
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();

    for (const sp of specs) {
      const placed = [];
      for (let i = 0; i < sp.count; i++) {
        const s = this._openSpot(rnd, sp.rMin, sp.rMax, sp.pad);
        if (!s) continue;
        const k = sp.scale[0] + rnd() * (sp.scale[1] - sp.scale[0]);
        placed.push({ x: s.x, y: this._groundAt(s.x, s.z), z: s.z, k, yaw: rnd() * TAU });
      }
      if (!placed.length) continue;
      this._owned.push(sp.trunk, sp.crown);

      /* ---- QUADRANT BUCKETS, and why an instanced field needs them -------
     *
       * The date palms were one `InstancedMesh` per surface for the whole town.
       * `citadel/Districts.js` cannot touch that - splitting an instanced field
       * means BUILDING it as several fields, which is an authoring decision in
       * the world, and it is the same answer `MedievalWorld` reached with its
       * quadrant tree buckets. Measured before this change: `citadel:tree.crown`
       * held 71,176 triangles - 22.9% of every triangle in the world - behind a
       * 160.9 m bounding sphere, i.e. the largest single object in the Citadel
       * and one that never left the frustum from anywhere. `districtStats`
       * reports instanced fields separately rather than dropping them from the
       * radius test precisely so this could not hide.
     *
       * Bucketed by quadrant the palms span r = 28..124 in one quadrant, which
       * is a 68-75 m sphere - inside the 130 m ceiling with room, four draws
       * instead of one per surface, and four spheres the frustum can actually
       * reject. The trunks come along because they share the placement.
     *
       * Placement, order and colliders are untouched: the bucket is decided by
       * the sign of x and z AFTER the spot is chosen, so the shared `rnd` stream
       * sees exactly the sequence it saw before and no palm moves.
       */
      const buckets = [[], [], [], []];
      for (const p of placed) buckets[(p.x < 0 ? 1 : 0) | (p.z < 0 ? 2 : 0)].push(p);

      for (let b = 0; b < buckets.length; b++) {
        const list = buckets[b];
        if (!list.length) continue;
        const barkMesh = new THREE.InstancedMesh(
          sp.trunk, this._mat(sp.bark, { vertexColors: false }), list.length);
        const leafMesh = new THREE.InstancedMesh(
          sp.crown, this._mat(sp.leaf, { vertexColors: false }), list.length);
        barkMesh.name = `citadel:tree.trunk:${sp.bark}:${b}`;
        leafMesh.name = `citadel:tree.crown:${sp.bark}:${b}`;
        barkMesh.castShadow = true;
        barkMesh.receiveShadow = true;
        leafMesh.castShadow = true;
        // Crowns do not receive: self-shadowing a mass of thin fronds costs a
        // shadow lookup per frond and returns acne, not shade.
        leafMesh.receiveShadow = false;
        for (let i = 0; i < list.length; i++) {
          const p = list[i];
          e.set(0, p.yaw, 0);
          q.setFromEuler(e);
          pos.set(p.x, p.y, p.z);
          scl.setScalar(p.k);
          m4.compose(pos, q, scl);
          barkMesh.setMatrixAt(i, m4);
          leafMesh.setMatrixAt(i, m4);
        }
        barkMesh.instanceMatrix.needsUpdate = true;
        leafMesh.instanceMatrix.needsUpdate = true;
        /* `districtStats` reads `object.boundingSphere` on an instanced mesh -
         * it has to be the object's, because the geometry's describes one palm
         * - and C3's per-field sphere assertion is measured off it. Computed
         * here rather than left to the first render, because a sphere that does
         * not exist yet reads as a distance of zero.
         *
         * THESE FIELDS ARE NOT REGISTERED WITH `DistanceLod`, and this comment
         * used to imply they were. They are not pushed to `this._districts` and
         * `_registerLod` is passed nothing else, so all 16 of them - 86,908
         * triangles, 17.9% of the world, every one `castShadow = true` - carry
         * no band at all. Quadrant bucketing moved their SPHERES from 160.9 m
         * to 81.5 m and left the triangle count exactly where it was.
         *
         * It is not a one-line fix, which is why it is recorded rather than
         * done: at `DISTRICT_LO_MIN_AREA` = 0.35 a palm crown's `lowDetail`
         * keeps 0 of its 1,736 triangles and returns null, so wiring them into
         * `_registerLod` unchanged would register nothing. Measured, the crown
         * only starts yielding at `minArea` 0.05, and at that threshold it
         * keeps 276 of 1,736 - a bald palm, not a distant one. The honest fix
         * is an authored low-poly crown with a swap distance derived from a
         * frond rather than from `BEVEL`, and that is an authoring job. */
        barkMesh.computeBoundingSphere();
        leafMesh.computeBoundingSphere();
        this.group.add(barkMesh, leafMesh);
      }

      /* Colliders in the original order, so a trunk box is where it always was.
       * A palm is something you take cover behind rather than walk through. */
      for (const p of placed) {
        this.track(this.physics.addBox(
          p.x, p.y + 1.6 * p.k, p.z, 0.26 * p.k, 1.6 * p.k, 0.26 * p.k));
      }
      await breathe();
    }
  }

  async _buildProps(breathe = noBreath) {
    const B = new Batch({ ao: 0.4, sky: 0.34, grime: 0.5, span: 2.2 }, TILE_METRES);
    const rnd = this.rnd;

    /* Trees moved out to _buildTrees.
     *
     * They were boxes merged into this prop batch. They are instanced now,
     * with real bark and frond surfaces, and neither the geometry nor the
     * material has any business being built alongside the crates. */

    /* ---- market stalls ---- */
    for (let i = 0; i < 22; i++) {
      const s = this._openSpot(rnd, 34, 108, 4.6);
      if (!s) continue;
      const gy = this._groundAt(s.x, s.z);
      const a = rnd() * TAU;
      const sw = 3.2 + rnd() * 1.4;
      const sd = 2.4 + rnd() * 0.9;
      const ph = 2.5;
      const cs = Math.cos(a);
      const sn = Math.sin(a);
      // Four posts at the corners, in the stall's own frame.
      for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const lx = ox * sw * 0.5;
        const lz = oz * sd * 0.5;
        const wx = s.x + cs * lx + sn * lz;
        const wz = s.z - sn * lx + cs * lz;
        B.box('wood.beam', 0.16, ph, 0.16, wx, gy + ph * 0.5, wz, a, 0x7a5a38);
      }
      /* Striped canopy: alternating bands, because a market awning is the one
       * place in a sand-coloured town where saturated colour belongs, and it is
       * what the eye picks the plaza out by from the rooftops. */
      const bands = 5;
      const c1 = rnd() < 0.5 ? 0xc4472e : 0x2f6ba8;
      const c2 = 0xe8dcc0;
      for (let b = 0; b < bands; b++) {
        const lz = (b / (bands - 1) - 0.5) * sd;
        const wx = s.x + sn * lz;
        const wz = s.z + cs * lz;
        B.box('fabric.banner', sw + 0.7, 0.09, sd / bands, wx, gy + ph + 0.12, wz, a, b % 2 ? c1 : c2);
      }
      this.track(this.physics.addRotatedBox(
        _v1.set(s.x, gy + ph + 0.12, s.z), _v2.set((sw + 0.7) * 0.5, 0.06, sd * 0.5), a
      ));
      // Counter and the goods on it.
      B.box('wood.plank', sw, 0.9, sd * 0.5, s.x, gy + 0.45, s.z, a, 0x8a6842);
      this.track(this.physics.addRotatedBox(
        _v1.set(s.x, gy + 0.45, s.z), _v2.set(sw * 0.5, 0.45, sd * 0.25), a
      ));
      for (let g = 0; g < 3; g++) {
        const lx = (g / 2 - 0.5) * sw * 0.7;
        B.box('fabric.banner', 0.5, 0.32, 0.5, s.x + cs * lx, gy + 1.06, s.z - sn * lx,
          rnd() * TAU, pick(rnd, [0xb8452f, 0xc98a2a, 0x6d8a3a, 0x8a4a7a]));
      }
    }

    /* ---- pottery and sacks against the walls ---- */
    for (let i = 0; i < 40; i++) {
      const s = this._openSpot(rnd, 28, 124, 2.4);
      if (!s) continue;
      const gy = this._groundAt(s.x, s.z);
      const n = 2 + ((rnd() * 3) | 0);
      for (let k = 0; k < n; k++) {
        const ox = (rnd() - 0.5) * 1.8;
        const oz = (rnd() - 0.5) * 1.8;
        const ph = 0.5 + rnd() * 0.5;
        const pw = 0.36 + rnd() * 0.26;
        B.box('roof.tile', pw, ph, pw, s.x + ox, gy + ph * 0.5, s.z + oz, rnd() * TAU,
          pick(rnd, [0x9a6a44, 0xb08050, 0x8a5a3a, 0xc09468]));
      }
    }

    /* ---- carts ---- */
    for (let i = 0; i < 9; i++) {
      const s = this._openSpot(rnd, 38, 112, 5);
      if (!s) continue;
      const gy = this._groundAt(s.x, s.z);
      const a = rnd() * TAU;
      const cs = Math.cos(a);
      const sn = Math.sin(a);
      B.box('wood.plank', 2.8, 0.5, 1.6, s.x, gy + 0.95, s.z, a, 0x7d5f3c);
      this.track(this.physics.addRotatedBox(
        _v1.set(s.x, gy + 0.95, s.z), _v2.set(1.4, 0.25, 0.8), a
      ));
      // Sideboards, so it is a cart and not a plank on legs.
      for (const oz of [-1, 1]) {
        B.box('wood.plank', 2.8, 0.5, 0.12, s.x + sn * oz * 0.8, gy + 1.4, s.z + cs * oz * 0.8, a, 0x6d5133);
      }
      // Wheels, and the shafts a horse would sit between.
      for (const ox of [-1, 1]) {
        const wx = s.x + cs * ox * 0.95;
        const wz = s.z - sn * ox * 0.95;
        for (const oz of [-1, 1]) {
          B.box('wood.beam', 0.14, 1.2, 1.2, wx + sn * oz * 0.86, gy + 0.6, wz + cs * oz * 0.86, a, 0x5d462c);
        }
      }
      B.box('wood.beam', 2.2, 0.12, 0.12, s.x + cs * 2.4, gy + 0.8, s.z - sn * 2.4, a, 0x6d5133);
    }

    await breathe();
    this._emit(B, 'props');
    await breathe();
    B.dispose();
  }

  /** Plateau-aware ground height, without a raycast. */
  _groundAt(x, z) {
    return terrainH(Math.hypot(x, z));
  }

  /**
   * The surface a falling body actually lands on: terrain PLUS everything
   * built on top of it.
   *
   * ── Why this is a second method and not a better `_groundAt` ─────────────
   *
   * `_groundAt` is `terrainH(hypot(x, z))` and it has to stay that way. Nine
   * call sites read it, and two of them - `_openSpot` and `_nudgeClear` - use
   * it as the *terrain datum* a physics cast is compared against:
   *
   *     const g = this._groundAt(x, z);
   *     const hit = this.physics.groundHeight(x, z, g + 12, 20);
   *     return hit !== null && hit > g + 0.6;      // is something standing here
   *
   * Make `_groundAt` a physics query and `g === hit` on every clear column, so
   * `hit > g + 0.6` can never fire and both clearance probes silently become
   * no-ops. That reintroduces the embedded-in-a-wall defect `_nudgeClear`'s own
   * docstring exists to record. `_nudgeClear` is on the path of every NPC
   * spawn, the player spawn and every portal, so the failure would be the whole
   * cast standing in masonry with a roof over their heads - which is exactly
   * what the audit found the last two times this world's PRNG stream moved.
   *
   * So: terrain-only stays terrain-only, and anything that wants the REAL deck
   * asks for it by name. `physics.groundHeight` already exists and is already
   * called during this very build, so there is no ordering problem - the only
   * requirement is that the thing being stood on has been built first, which
   * for `_buildDressing` (last but for the spawns) is everything.
   *
   * @param {number} x
   * @param {number} z
   * @param {number} [from] height the downward cast starts at
   * @param {number} [dist] how far it may travel
   * @returns {number} the top of the highest solid over this column, or the
   *   terrain height where the cast finds nothing at all.
   */
  _deckAt(x, z, from = DECK_PROBE_TOP, dist = DECK_PROBE_LEN) {
    const g = this._groundAt(x, z);
    const hit = this.physics.groundHeight(x, z, from, dist);
    return hit === null || hit < g ? g : hit;
  }

  /**
   * A standing spot on a souk roof, moved off whatever is standing in the
   * middle of it.
   *
   * 30% of souk blocks carry a dome, and a dome is a collider standing proud
   * of the deck at its own centre - `dr*0.72 x dr*0.32 x dr*0.72` about
   * `(r.x, r.z)`, where `dr = min(w, d) * 0.42`. Anything that takes a roof's
   * published centre as a place to PUT something therefore puts it inside a
   * solid for three roofs in ten. Measured on the built world, that was 8 of
   * the 30 citadel relic sites sealed inside a dome, invisible from the deck
   * and 2.49-2.62 m from the nearest place a body can stand against a 2.00 m
   * pickup radius - not collectable at all without mantling the dome.
   *
   * Asked of the collision world rather than of the dome probability: try the
   * centre, then four offsets along the building's own axes, and take the
   * first that answers with the roof's own height. Both axes matter. The
   * tangential half-width is `w/2 - 1.6` against a dome half-extent of
   * `min(w,d)*0.42*0.72 = 2.12 m`, so a ring whose solved `w` falls under
   * 7.44 m fails BOTH tangential probes - and the radial half-extent is
   * 3.85 m, so a radial probe would still clear. An earlier version of this
   * block wrote four tuples but left `oz` at zero in every one of them, which
   * made both `sin(rot)*oz` and `cos(rot)*oz` dead and left only the two
   * tangential candidates its own comment did not describe.
   *
   * `_deckAt` is the same probe the haystacks use.
   *
   * @param {{x:number,y:number,z:number,w:number,d:number}|null} r
   * @returns {{x:number,y:number,z:number}|null}
   */
  _deckSpot(r) {
    if (!r) return null;
    const rot = Math.PI * 0.5 - Math.atan2(r.z, r.x);
    const ux = Math.cos(rot);
    const uz = -Math.sin(rot);              // the building's local +X
    const out = r.w * 0.5 - 1.6;            // tangential
    const rOut = r.d * 0.5 - 1.6;           // radial
    for (const [ox, oz] of [[0, 0], [out, 0], [-out, 0], [0, rOut], [0, -rOut]]) {
      const x = r.x + ux * ox + Math.sin(rot) * oz;
      const z = r.z + uz * ox + Math.cos(rot) * oz;
      if (Math.abs(this._deckAt(x, z) - r.y) < 0.06) return { x, y: r.y, z };
    }
    return { x: r.x, y: r.y, z: r.z };
  }

  /* ------------------------------------------------------------------ */
  /* Spawns, portals, minimap                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Move a hand-placed point off whatever it landed inside.
   *
   * Every spawn in this world is authored as a literal coordinate - "the keeper
   * stands at 6, 92" - but the souk around those coordinates is generated, and
   * a generated town moves whenever anything upstream of its PRNG changes. It
   * has, twice. The result was NPCs standing inside houses: the audit found
   * Rafiq the Keeper and a sentinel embedded in walls, patrolling on the spot
   * with a roof three metres over their heads.
   *
   * Rather than re-authoring the coordinates against the current layout - which
   * would only survive until the next change - the intent is kept and the point
   * is pushed to the nearest clear ground. A spiral, so a blocked spawn ends up
   * a couple of metres away in the street rather than somewhere unrelated.
   *
   * @param {THREE.Vector3} pos mutated in place
   * @param {number} [pad] clearance wanted around the point
   */
  _nudgeClear(pos, pad = 1.6) {
    const blocked = (x, z) => {
      for (const b of this._roofs) {
        const dx = x - b.x;
        const dz = z - b.z;
        const keep = Math.max(b.w, b.d) * 0.5 + pad;
        if (dx * dx + dz * dz < keep * keep) return true;
      }
      // And anything else solid standing here - walls, towers, the keep.
      const g = this._groundAt(x, z);
      const hit = this.physics.groundHeight(x, z, g + 12, 20);
      return hit !== null && hit > g + 0.6;
    };
    if (!blocked(pos.x, pos.z)) return pos;
    // Golden-angle spiral: even coverage, and it never revisits a direction.
    for (let i = 1; i <= 96; i++) {
      const a = i * 2.399963;
      const r = 1.2 + i * 0.28;
      const x = pos.x + Math.cos(a) * r;
      const z = pos.z + Math.sin(a) * r;
      if (Math.hypot(x, z) > MESA_R - 4) continue;   // stay on the plateau
      if (!blocked(x, z)) {
        pos.x = x;
        pos.z = z;
        pos.y = this._groundAt(x, z) + 0.2;
        return pos;
      }
    }
    return pos;
  }

  _fillSpawns() {
    /* Just inside the gate, facing the citadel.
     *
     * Yaw 0, not PI: characters look down -Z at yaw 0, and the town is at -Z
     * from here. Facing PI put the player's back to the entire world and their
     * nose against the return portal, which is the exact opposite of the
     * establishing shot this spawn exists to frame - the souk stepping up ring
     * by ring to the great tower. */
    this.playerSpawn.set(0, MESA_Y + 0.3, 104);
    this.playerSpawnYaw = 0;

    this.portalSpecs.push({
      position: new THREE.Vector3(0, MESA_Y + 0.3, 112),
      rotationY: Math.PI,
      target: 'station',
      label: 'Aether Station',
      accent: 0x4de3ff,
    });

    /**
     * A named civilian. `extra` is anything `NPCManager.spawnForWorld` reads
     * off a spawn descriptor - `role`, `vendorCategories`, `vendorTitle`,
     * `signLines`, `isQuestManager` - so a counter in the citadel is authored
     * here rather than being a second kind of thing somewhere else. Copied in
     * shape from `StationWorld._fillSpawns`, which is where the convention is.
     *
     * These four carried a name and a persona and nothing else, and the cost
     * was not cosmetic. With no `role`, the only route into a citadel shop was
     * `Marketplace._isVendor`'s VENDOR_WORDS regex, which matches Hafsa's
     * "cloth stall" and misses Rafiq's archive and Bashir's stable entirely -
     * two of the three counters on the mesa could not be opened at all, and
     * `WORLD_MARKETS.citadel`'s price table had nowhere to be quoted.
     */
    const F = (name, persona, x, z, extra) => ({
      position: new THREE.Vector3(x, MESA_Y + 0.2, z),
      type: 'friendly',
      name,
      persona,
      ...extra,
    });
    /* Between them the three counters stock all six marketplace categories.
     * That is deliberate rather than tidy: there is exactly one portal off this
     * mesa, so a category nobody stocks is a category the player cannot buy in
     * this world. Split by trade, on the medieval `TRADE` pattern - an archive
     * keeps physic and ink, a dye yard keeps cloth and the tools of the dyeing,
     * and the horse lines under the wall keep the garrison's tack and its
     * spare arms on the same racks. */
    this.npcSpawns.push(
      F('Rafiq the Keeper', 'Keeper of the citadel archive; speaks in riddles about the old order.', 6, 92, {
        role: 'vendor',
        vendorCategories: ['health', 'spells'],
        vendorTitle: 'Archive & Physic',
        signLines: ['ARCHIVE & PHYSIC', 'SUNSPIRE CITADEL'],
      }),
      F('Hafsa the Dyer', 'Runs the cloth stall by the gate; knows every roof in the souk.', -12, 84, {
        role: 'vendor',
        vendorCategories: ['cosmetic', 'tools'],
        vendorTitle: 'Cloth & Colour',
        signLines: ['CLOTH & COLOUR', 'SUNSPIRE CITADEL'],
      }),
      F('Bashir the Ostler', 'Tends the horses below the wall; gruff, fond of his animals.', 20, 96, {
        role: 'vendor',
        vendorCategories: ['mounts', 'weapons'],
        vendorTitle: 'Harness & Arms',
        signLines: ['HARNESS & ARMS', 'SUNSPIRE CITADEL'],
      }),
      /* Yusra is deliberately NOT a counter and NOT a quest desk, and both
       * halves of that were measured rather than chosen.
     *
       * She is a `talk` target in three shipped quests (Q33, Q36, Q40), and
       * `HUD.js` emits `interact` rather than `talk` for a quest manager - so
       * flagging her `isQuestManager` breaks all three, which
       * scripts/tests/quest-content.test.mjs says out loud. The world already
       * has a desk: `NPCManager._spawnQuestManagers` plants Aldric Storne at
       * (8, 14.3, 88), four metres from Rafiq.
     *
       * The role is `wanderer` - which is what `spawnForWorld` was already
       * giving all four of these characters by default - and it is written
       * down rather than left implicit because it is now load-bearing: the
       * other three have been given posts, so Yusra is the only NPC in the
       * citadel carrying the role at all, and Q31 step 2 is `talk:"wanderer"`.
       */
      F('Yusra the Falconer', 'Flies the eagles from the great tower; watches everything.', -4, 40, {
        role: 'wanderer',
      }),
    );
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      this.npcSpawns.push({
        position: new THREE.Vector3(Math.cos(a) * 62, MESA_Y + 0.2, Math.sin(a) * 62),
        type: 'hostile',
      });
    }

    /* Every spawn, hand-placed or generated, gets pushed clear of the town.
     *
     * Done in one pass at the end rather than at each site so nothing can be
     * added later and quietly skip it - which is exactly how the hostile ring
     * came to be laid down on a fixed radius of 62 m straight through whatever
     * the souk had generated there. */
    for (const s of this.npcSpawns) this._nudgeClear(s.position, 1.8);
    this._nudgeClear(this.playerSpawn, 2.2);
    for (const p of this.portalSpecs) this._nudgeClear(p.position, 2.6);

    this._publishVenues();
  }

  /**
   * The baked floorplan. Published AFTER the ring, and that is the whole point.
   *
   * ── The defect this method exists to end ─────────────────────────────────
   *
   * These six shapes and the tower loop used to live at the end of
   * `_fillSpawns`, which `build()` calls BEFORE `_buildRegions`. Two silent
   * consequences, both measured on the built world:
   *
   *   - 19 shapes, furthest extent 152.0 m, ZERO shapes anywhere past r = 200,
   *     on a `bounds` of +-450. `Minimap._bakePlan` rasterises over
   *     `world.bounds`, and `Minimap.setWorld` derives the zoom-out limit from
   *     it too, so a player could zoom out over the whole 810,000 m2 map and
   *     see a 72,600 m2 disc in the middle of nothing. Six authored regions,
   *     153 decks, the aqueduct spine, the quarry pit and the karst massif
   *     contributed nothing at all.
   *   - `this._towers` held 13 when the loop ran and holds 18 after the ring.
   *     The five missing dots were the Caravan Mast, the Undercliff Watch, the
   *     Deepworks Headframe, the Ashfall Beacon and the Eyrie - i.e. exactly
   *     the landmarks the loop exists to draw.
   *
   * Nothing failed. `minimapShapes` is an optional-chained read, so an empty
   * ring is a blank canvas rather than an error - which is the C1 failure shape
   * the extent gate was built for, arrived at from the UI side.
   *
   * Region outlines come from the AABB each region already measured for
   * `contentBounds`, so there is no second copy of the ring's layout in here.
   * Painting order is background to foreground: regions, then the mesa, then
   * the towers on top.
   */
  _publishMinimap() {
    /* The ring first, and dark, so the mesa disc reads as the bright thing in
     * the middle of it rather than as one blob among seven. */
    for (const r of this.regions ?? []) {
      const a = r.aabb;
      if (!a) continue;
      this.minimapShapes.push({
        kind: 'rect',
        x: (a.min.x + a.max.x) * 0.5,
        z: (a.min.z + a.max.z) * 0.5,
        w: Math.max(1, a.max.x - a.min.x),
        d: Math.max(1, a.max.z - a.min.z),
        fill: 0x2f2a1d,
        stroke: 0x6b5f42,
        width: 2,
      });
    }

    /* The plateau, the wall ring and the citadel - enough to orient by without
     * drawing four hundred houses. */
    this.minimapShapes.push(
      { kind: 'circle', x: 0, z: 0, r: MESA_R + 20, fill: 0x2a2418 },
      { kind: 'circle', x: 0, z: 0, r: MESA_R, fill: 0x4a412c },
      { kind: 'circle', x: 0, z: 0, r: 118, stroke: 0xc8b68e, width: 3 },
      { kind: 'circle', x: 0, z: 0, r: 30, fill: 0x6b5f42 },
      { kind: 'rect', x: 0, z: -18, w: 12, d: 12, fill: 0xd6c69c },
      { kind: 'rect', x: 0, z: 118, w: 22, d: 10, fill: 0xc8b68e }
    );
    for (const t of this._towers) {
      this.minimapShapes.push({ kind: 'circle', x: t.x, z: t.z, r: 3.2, fill: 0xbfae8a });
    }

    /* THE WATER, and the caravan roads that join it up.
     *
     * Drawn last so they sit over the ring rectangles, and drawn at all because
     * they are the only content in the flats: a player who has been told the
     * desert has oases in it and cannot find one on the map has been told about
     * content, not given it. The two tanks get their water colour and their
     * real half-width; the eight wayside wells get a dot the size of the tower
     * dots, because they are landmarks of the same order.
     *
     * The roads are polylines, which is `kind: 'path'` - `Minimap._bakePlan`
     * has exactly three shapes and `path` is the one that walks a `points`
     * array, as `[x, z]` PAIRS rather than as `{x, z}` objects. Neither mistake
     * throws: the shape switch `continue`s past a kind it does not know and
     * `moveTo(undefined, undefined)` draws nothing, so the roads would simply
     * not be on the map - the same optional-chained silence the extent gate was
     * written for. */
    for (const r of this.caravanRoutes ?? []) {
      this.minimapShapes.push({
        kind: 'path',
        points: r.points.map((p) => [p.x, p.z]),
        stroke: 0x8a7a55,
        width: 2,
      });
    }
    for (const o of this.oases ?? []) {
      const tank = o.tank ?? o;
      this.minimapShapes.push(o.kind === 'oasis'
        ? { kind: 'circle', x: tank.x, z: tank.z, r: Math.max(6, tank.r), fill: 0x2f7f96, stroke: 0x8fd0e0, width: 2 }
        : { kind: 'circle', x: o.x, z: o.z, r: 3.6, fill: 0x2f7f96 });
    }
  }

  /**
   * The souk roof on `ring` whose bearing is closest to `bearing`.
   *
   * Checkpoints are taken from the built world rather than recomputed from
   * `SOUK_RINGS`, so a route point is always the exact centre of a deck that
   * exists - including the +/-0.12 m of height noise. A trial whose checkpoint
   * floats 0.12 m inside a roof is a trial the swept validator never fires.
   *
   * @param {number} ring
   * @param {number} bearing
   * @returns {{x:number,y:number,z:number,w:number,d:number,ring:number}|null}
   */
  _roofNear(ring, bearing) {
    let best = null;
    let bestD = Infinity;
    for (const r of this._roofs) {
      if (r.ring !== ring) continue;
      const d = Math.abs(wrapPi(Math.atan2(r.z, r.x) - bearing));
      if (d < bestD) { bestD = d; best = r; }
    }
    return best;
  }

  /**
   * Rooftop trial venues, published in the shape `MinigameManager._readVenue`
   * reads (`:480-512`).
   *
   * ── What is published and what is deliberately NOT ────────────────────────
   *
   * `kind: 'rooftop'` has no factory registered yet, and `MinigameManager.arm`
   * treats that as "a published slot, not an error" - the venue is inert until
   * the game module lands, which is exactly how the tennis court and the ski
   * slope shipped. So these three descriptors can go in now and light up when
   * the trial module registers `rooftop`.
   *
   * `config.checkpoints` are read out of the ASSEMBLED world by `_roofNear`,
   * not recomputed from the ring table, because the deck heights carry a small
   * per-building noise term and a checkpoint that misses its deck by 12 cm is
   * a checkpoint the swept validator never crosses.
   *
   * `config.ringRadius` is 2.6 m and it is here because the only in-world
   * waypoint marker that exists, `RaceRings`, hard-codes `DRAGON_RACE
   * .ringRadius` = 5.2 m. A 5.2 m torus is wider than most of these roofs. The
   * marker has to take the radius from the venue.
   *
   * There are NO bronze/silver/gold times. Those have to come from measured
   * route times and nothing in this file has run a route; `config.routeLength`
   * is the summed 3D length of the checkpoint chain, which IS measured, and is
   * the honest input to deriving them. Publishing a guessed par time would be
   * the fourth number in this project to be computed instead of driven.
   */
  _publishVenues() {
    /* ── THE CATALOGUE IS A SOURCE LITERAL, AND THAT IS LOAD-BEARING ─────
     *
     * These seven descriptors used to be `this.minigameVenues.push({ ... })`
     * calls inside two methods, with every field computed. That reads fine and
     * it cost this world its entire quest vocabulary:
     * `scripts/quest-vocab.mjs` scrapes venue ids out of SOURCE with
     * `/\.minigameVenues\s*=\s*\[/` and walks the object literals inside the
     * brackets, so it saw `sports` publish four and `citadel` publish NONE.
     * A quest step naming a citadel trial was rejected by
     * `quest-content.test.mjs` as an invented target - and the trials are the
     * only objective the outer ring has that a quest can name at all, because
     * the ring holds no NPC, no vendor and no portal.
     *
     * So identity is authored here as a literal and GEOMETRY is filled in
     * afterwards by {@link CitadelWorld#_fillVenue} from the assembled world.
     * The two halves cannot drift: `_pruneVenues` deletes any entry no route
     * ever filled, and `citadel-objectives.test.mjs` asserts the published
     * list is exactly this list - so a venue that stops resolving fails a test
     * rather than quietly becoming a slot the vocabulary still believes in.
     *
     * Each names its own rival, the way `SportsWorld` names all four of its:
     * `RooftopTrial` falls back to "the pacesetter" when a venue does not, and
     * seven ghosts all called the pacesetter is a rival nobody remembers losing
     * to.
     *
     * There are NO bronze/silver/gold times here. Those come from measured
     * route times (`RooftopTrial.parTimes` over `config.routeLength`, itself
     * the summed 3D length of a chain read out of the built world), and
     * publishing a guessed par would be the fourth number in this project
     * computed instead of driven.
     */
    this.minigameVenues = [
      {
        id: 'citadel_souk_dash', kind: 'rooftop', requires: 'parkour',
        label: 'Souk Rooftop Dash', reward: 10, rival: { name: 'Nadira the Swift' },
        note: 'Rings 6 and 5 only: every crossing on this route is inside a sprint jump.',
      },
      {
        id: 'citadel_ascent', kind: 'rooftop', requires: 'parkour',
        label: 'The Long Ascent', reward: 14, rival: { name: 'Idris Roof-Runner' },
        note: 'One roof per ring, gate to ward. Crosses the whole authored gradient.',
      },
      {
        id: 'citadel_skyline', kind: 'rooftop', requires: 'parkour',
        label: 'The Skyline', reward: 18, rival: { name: 'Zeynab of the Spans' },
        note: 'Great tower, the long span, the wall, and back down into the souk.',
      },
      {
        id: 'citadel_serai_circuit', kind: 'rooftop', requires: 'parkour',
        label: 'The Caravanserai Round', reward: 8, rival: { name: 'Nour the Drover' },
        note: 'Two ranges and the mast corner, on the flattest ground in the world. Every crossing is a standing walk jump: this is the one that teaches the verb.',
      },
      {
        id: 'citadel_undercliff_run', kind: 'rooftop', requires: 'parkour',
        label: 'The Undercliff Terrace', reward: 12, rival: { name: 'Sabiha of the Steps' },
        note: 'The top terrace end to end. Every crossing is a sprint jump; nothing here needs the leap.',
      },
      {
        id: 'citadel_deepworks_plunge', kind: 'rooftop', requires: 'parkour',
        label: 'The Deepworks Plunge', reward: 15, rival: { name: 'Mira Pit-Runner' },
        note: 'Rim to pit floor down the gantries. Every drop is under the 7.5 m fall-damage floor.',
      },
      {
        id: 'citadel_aqueduct_run', kind: 'rooftop', requires: 'parkour',
        label: 'The Long Water', reward: 18, rival: { name: 'Tariq Long-Stride' },
        note: 'The massif to the mesa over the spine, downhill with the water. Four broken spans, and the leap is the only budget that crosses them.',
      },
    ];
    // A checkpoint at a roof's centre is a checkpoint inside a dome for three
    // roofs in ten, and a ring the player cannot pass through is not a
    // checkpoint. `_deckSpot` is the shared answer; `_roofs[].anchor` carries
    // the same answer to everything else that puts something on a roof.
    const P = (r) => this._deckSpot(r);
    const outer = SOUK_RINGS.length - 1;

    /* The dash stays on the two outer rings, where every tangential gap is
     * 2.83-3.68 m and a sprint jump clears 4.25: it is the ring that teaches.
     * The ascent crosses every ring inward, which by construction is the whole
     * gradient - sprint, sprint, sprint, leap, leap, leap-and-mantle. */
    const dash = [];
    for (let k = 0; k < 9; k++) {
      const b = GATE_BEARING - 0.5 - (k / 8) * (TAU - 1.4);
      dash.push(P(this._roofNear(k % 2 ? outer - 1 : outer, b)));
    }
    const ascent = [];
    for (let ring = outer; ring >= 0; ring--) {
      ascent.push(P(this._roofNear(ring, GATE_BEARING + 0.85 + (outer - ring) * 0.18)));
    }
    const skyline = [];
    const great = this._towers.find((t) => t.great);
    const span = this.ropeBridges.find((b) => b.id === 'great-tower-perimeter');
    const land = this.ropeBridges.find((b) => b.id === 'great-tower-perimeter-landfall');
    if (great && span && land) {
      skyline.push({ x: great.x, y: great.y, z: great.z });
      skyline.push(span.mid);                      // a real plank, not a midpoint
      skyline.push({ x: span.b.x, y: span.b.y, z: span.b.z });
      skyline.push({ x: land.b.x, y: land.b.y, z: land.b.z });
    }

    this._fillVenue('citadel_souk_dash', dash);
    this._fillVenue('citadel_ascent', ascent);
    this._fillVenue('citadel_skyline', skyline);
  }

  /**
   * Give one catalogued venue the geometry of a route read out of the world.
   *
   * @param {string} id one of the ids authored in `_publishVenues`
   * @param {Array<{x:number,y:number,z:number}|null>} pts the checkpoint chain,
   *   nulls tolerated so a caller can hand over a partly resolved route
   * @returns {object|null} the filled venue, or null when the route is too
   *   short to be one - which `_pruneVenues` then deletes
   */
  _fillVenue(id, pts) {
    const v = this.minigameVenues.find((e) => e.id === id);
    if (!v) {
      console.warn(`[CitadelWorld] no venue "${id}" in the catalogue`);
      return null;
    }
    const checkpoints = pts.filter(Boolean);
    if (checkpoints.length < 3) return null;
    let routeLength = 0;
    for (let i = 1; i < checkpoints.length; i++) {
      routeLength += Math.hypot(
        checkpoints[i].x - checkpoints[i - 1].x,
        checkpoints[i].y - checkpoints[i - 1].y,
        checkpoints[i].z - checkpoints[i - 1].z
      );
    }
    /* The disc has to hold the WHOLE ROUTE, not the start line.
     *
     * `MinigameManager.fixedUpdate` calls `abort('left')` LEAVE_GRACE_S = 9 s
     * after the player leaves this disc. A start-line-sized disc therefore
     * abandons every contest that lasts longer than nine seconds, which is
     * all of them: measured on this world, the dash reaches 198.4 m from
     * checkpoint 0, the ascent 96.4 m, and the skyline swings 47.1 m of Dy.
     * Gold on the dash is 91.8 s, so no trial in this world could ever be
     * finished. `venueBounds` is exported by `RooftopTrial` for exactly this
     * and returns the numbers below; `SportsWorld` records the same
     * requirement twice in comments, over the ski slope and over the track.
     *
     * The START LINE does not move with it: `createRooftopTrial` refuses to
     * build unless the player is within START_RADIUS = 12 m of checkpoint 0,
     * which is the same split the ski run uses - a wide venue with a
     * module-enforced gate on where the run begins. */
    const b = venueBounds(checkpoints);
    v.centre = new THREE.Vector3(b.centre.x, b.centre.y, b.centre.z);
    v.radius = b.radius;
    v.yTolerance = b.yTolerance;
    /* `config.ringRadius` is 2.6 m and it is here because the only in-world
     * waypoint marker that exists, `RaceRings`, hard-codes
     * `DRAGON_RACE.ringRadius` = 5.2 m. A 5.2 m torus is wider than most of
     * these roofs; the marker has to take its radius from the venue. */
    v.config = { note: v.note, checkpoints, ringRadius: 2.6, routeLength };
    return v;
  }

  /**
   * Delete any catalogued venue no route ever filled.
   *
   * `MinigameManager._readVenue` refuses an entry with no centre, so an
   * unfilled one is already inert in the game - but it is NOT inert in
   * `scripts/quest-vocab.mjs`, which reads the catalogue out of source and
   * would go on offering its id to quest authors as a valid target. This is
   * the line that stops the source literal becoming a claim the runtime does
   * not honour, and it warns rather than failing silently so a route that
   * stops resolving is visible in a build log as well as in a test.
   */
  _pruneVenues() {
    for (let i = this.minigameVenues.length - 1; i >= 0; i--) {
      const v = this.minigameVenues[i];
      if (v.config && v.centre) continue;
      console.warn(`[CitadelWorld] trial "${v.id}" published no route - dropped`);
      this.minigameVenues.splice(i, 1);
    }
  }

  /* ------------------------------------------------------------------ */
  /* The outer ring                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Author the six regions, LAST, on their own PRNG.
   *
   * ── Why last, and why a second stream ────────────────────────────────────
   *
   * The mesa has to come out bit-identical, and "bit-identical" in this world
   * is not only a height digest. `_buildSouk` draws from `this.rnd` inside a
   * loop whose branch structure depends on what came before it, and the extent
   * stage learned exactly how expensive that is: one clipping literal changed
   * how many draws the dune loop consumed, and the whole town moved -
   * wall-grab rescues 57 -> 63, a jump-graph node lost, eight roof-edge samples
   * appeared, three of the five handed-over failures. So the ring gets its own
   * `mulberry32` and runs after everything that reads `this.rnd`, and the souk
   * cannot feel it at all.
   *
   * It also runs after `_fillSpawns`, which calls `_publishVenues` and clears
   * `minigameVenues` on the way in. A region venue published before that is a
   * venue thrown away, so the ring's three are appended here.
   *
   * ── One batch per region ─────────────────────────────────────────────────
   *
   * `beginRegion` / `endRegion` are the hooks `buildRegions` calls round each
   * one. The reason is the draw-call ceiling: `_splitDistricts` cuts every
   * merged mesh to a 130 m sphere, and the six regions are up to 700 m apart,
   * so one shared `stone.castle` mesh comes back as many leaves where six
   * separate ones come back as six. Measured by mutation: one shared batch
   * takes the whole world to 194 draw calls against 136, on a ceiling of 150.
   *
   * @param {() => Promise<void>} breathe
   */
  async _buildRegions(breathe = noBreath) {
    const rnd = mulberry32(0x0c17ad);
    let B = null;
    const ctx = {
      /* The ring is emitted with a longer AO span than the souk: its pieces
       * are terrace plinths and aqueduct piers eight to twenty-five metres
       * tall, and the souk's 1.8-3.4 m span puts the whole of one inside the
       * dark end of the ramp. `Batch.add` already clamps the span to the
       * piece's own height, so short work is unaffected. */
      box: (key, w, h, d, x, y, z, rotY = 0, tint = null) => B.box(key, w, h, d, x, y, z, rotY, tint),
      solid: (x, y, z, hx, hy, hz, rotY = 0) => {
        this.track(this.physics.addRotatedBox(_v1.set(x, y, z), _v2.set(hx, hy, hz), rotY));
      },
      ground: (x, z) => citadelHeight(x, z),
      rnd,
      breathe,
      roofs: this._roofs,
      towers: this._towers,
      steps: this._steps,
      haystacks: this.haystacks,
      viewpoints: this.viewpoints,
      beginRegion: () => {
        B = new Batch({ ao: 0.42, sky: 0.32, grime: 0.52, span: 6 }, TILE_METRES);
      },
      endRegion: async (spec) => {
        await breathe();
        this._emit(B, `region:${spec.id}`);
        B.dispose();
        B = null;
      },
    };

    const report = await buildRegions(ctx);
    this.regions = report.regions;

    /* THE ONE NUMBER THAT HAD TO GROW WITH THE RING.
     *
     * `Relics._onWorld` and `Caches._onWorld` both budget by AREA off
     * `contentBounds ?? bounds`, and the extent stage set it to the protected
     * core because the ring was empty: budgeting off `bounds` asked for 110
     * relics and darted the surplus into open sand where `MIN_PROMINENCE` 2.5
     * cannot be satisfied by construction. The ring now HAS content, so the box
     * is the union of the core and every region's own measured AABB - not
     * `bounds`, because the corners of this map are still sand and nothing in
     * this drop changed that.
     */
    const b = report.bounds;
    this.contentBounds = new THREE.Box3(
      new THREE.Vector3(
        Math.min(-INNER_KEEP, b.min.x), CITADEL_LAYOUT.floorY, Math.min(-INNER_KEEP, b.min.z)
      ),
      new THREE.Vector3(
        Math.max(INNER_KEEP, b.max.x), CITADEL_LAYOUT.ceilY, Math.max(INNER_KEEP, b.max.z)
      )
    );

    this._publishRegionVenues(report.routes);

    /* ONE HIGH PLACE PER REGION, NOMINATED FOR A CACHE.
     *
     * See `this.cacheSites` in the constructor for why a list exists at all
     * (nine uniform darts put seven caches on the old mesa and none in five of
     * the six regions). Each coordinate is the clearest point a 2 m lattice
     * over that region's own AABB found: scored by `Caches._highAt` - the same
     * predicate the dart loop has to satisfy - and filtered to the component
     * that contains the player spawn. `sheer` is how many of eight probes at
     * 9 m see a 7 m drop, `level` how many of six at 3 m come back flat:
     *
     *   caravanserai  (366.15,  271.85)   y 31.80   sheer 8/8   level 6/6
     *   undercliff    ( -40.40,  322.00)  y 35.78   sheer 7/8   level 6/6
     *   deepworks     ( 276.87,  -75.00)  y 33.90   sheer 5/8   level 5/6
     *   aqueduct      ( -43.09, -276.84)  y 43.04   sheer 5/8   level 6/6
     *   ashfall       (-330.00,  178.00)  y 37.60   sheer 8/8   level 6/6
     *   eyrie         ( -40.43, -326.98)  y 63.70   sheer 8/8   level 6/6
     *
     * Two of them stand on the same platform as their region's viewpoint - the
     * Caravan Mast and the Eyrie - and that is what the lattice found rather
     * than a shortcut. Those two regions contain exactly ONE point apiece with
     * a 7 m drop on five sides, because one is the flattest ground in the world
     * and the other is a peak with a monastery on it. A cache at the top of the
     * longest climb in the game is a reward stack, not a duplicate.
     *
     * The mesa is deliberately NOT nominated. Its own dart hit-rate is what the
     * area law was calibrated on and it needs no help; leaving three of the
     * nine slots unnominated is what keeps the search doing its job.
     */
    this.cacheSites = [
      { x: 366.15, z: 271.85, label: 'The Caravan Mast' },
      { x: -40.40, z: 322.00, label: 'The Undercliff terrace' },
      { x: 276.87, z: -75.00, label: 'The Deepworks rim' },
      { x: -43.09, z: -276.84, label: 'The aqueduct abutment' },
      { x: -330.00, z: 178.00, label: 'The Ashfall ward' },
      { x: -40.43, z: -326.98, label: 'The Eyrie' },
    ];

    await breathe();
    this.caves = await this._buildCaves(breathe);
    /* AFTER the caves, because the oasis kit sites itself against the FINAL
     * collider set and a cave's plinth is part of it. See `_buildTraffic`. */
    this.traffic = await this._buildTraffic(breathe);
    return report;
  }

  /**
   * The Deepworks' adit and the massif's sunken hall.
   *
   * ── Why they are built LAST, and against the finished collider set ───────
   *
   * `citadel/Caves.js` states the one thing about this world that makes caves
   * hard: `Physics` heightfields are solid from their surface all the way down
   * to `baseY`, and `_closestPoint` shoves anything under that surface straight
   * up. There is no carve operation. **A cave cannot be dug into terrain at
   * all** - an adit driven into a hillside ejects the player through the roof -
   * so the rock has to be BUILT above grade and the shell is only its inside
   * face. That is why `liftToClear` exists, and why it is not optional: the
   * kit's own first run reported 508 buried columns and a vault at 1%
   * coverage.
   *
   * The second thing is `auditVacancy`, and it is the reason this runs after
   * the six regions rather than before them. The kit's suite picked its first
   * site on terrain relief alone and landed it inside somebody else's quarry
   * gantries: the cave built perfectly, sealed perfectly, and reported two
   * room-spanning slabs and a walled-up mouth, every one of them a foreign
   * collider. Siting has to be checked against the world as it actually
   * stands, which means after everything else in it has been built.
   *
   * The order is the one the kit's header names and it is not
   * interchangeable: profile, lift, vacancy, build.
   *
   * @param {() => Promise<void>} breathe
   */
  async _buildCaves(breathe = noBreath) {
    const field = new SolidField(this.physics.colliders);
    /* ONE BATCH PER CAVE, for the reason the regions have one each: the two
     * sites are 350 m apart, and a shared `stone.castle` mesh holding both
     * comes back from `splitDistricts` as nine leaves against two. Measured, 20
     * draw calls against 8, on a budget with twelve to spare. */
    let B = null;
    const ctx = {
      physics: this.physics,
      group: this.group,
      track: (c) => this.track(c),
      box: (key, w, h, d, x, y, z, rotY = 0, tint = null) => B.box(key, w, h, d, x, y, z, rotY, tint),
    };
    const out = [];
    /* Two sites, and both are SEARCHED numbers rather than authored ones.
     *
     * `citadelCaves`' own defaults - (267, -80) yaw 5.50 and (-50, -290) yaw 0
     * - were found against a world with an EMPTY ring. Run against this one the
     * vacancy probe refuses both: the mine's gallery has 84 occupied samples
     * and three blocked mouth samples where a palm stands at (291.7, 27.3,
     * -50.2), and the hall has three where another stands at (-31.7, 30.4,
     * -284.7). Neither is a cave defect. Both were re-searched on a 3 m lattice
     * over +-30 m and four yaws each, and what is chosen is the clear site with
     * the LEAST RELIEF under it, because relief is the plinth of rock the cave
     * has to be built on top of and the plinth is the whole visible cost of
     * having no carve operation:
     *
     *   quarry-adit  (261, -104) yaw 5.20   lift 26.20   relief 1.45  (1131 clear)
     *   sunken-hall  (-56, -281) yaw 0.40   lift 32.94   relief 4.72   (952 clear)
     */
    const plans = [
      planMine({ id: 'quarry-adit', label: 'The Quarry Adit', origin: { x: 261, y: 0, z: -104 }, yaw: 5.20 }),
      planKarst({ id: 'sunken-hall', label: 'The Sunken Hall', origin: { x: -56, y: 0, z: -281 }, yaw: 0.40 }),
    ];
    if (!Array.isArray(this.enterables)) this.enterables = [];
    for (const raw of plans) {
      const { plan, lift, profile } = liftToClear(raw, field, 0.10);
      const vacancy = auditVacancy(plan, field, { step: 1.5, apron: 4.0 });
      /* A site that is not empty is REFUSED rather than built over. The whole
       * value of the vacancy probe is that it fires before the geometry exists;
       * building anyway and auditing afterwards is how an hour goes into
       * telling a cave defect apart from a siting mistake. */
      if (vacancy.occupied > 0 || vacancy.mouthBlocked > 0) {
        console.warn(`[CitadelWorld] cave "${plan.id}" refused: ${vacancy.occupied} occupied samples, `
          + `${vacancy.mouthBlocked} blocked mouth samples (first at ${JSON.stringify(vacancy.first)})`);
        out.push({ id: plan.id, built: false, lift, profile, vacancy });
        continue;
      }
      B = new Batch({ ao: 0.5, sky: 0.28, grime: 0.7, span: 3.0 }, TILE_METRES);
      const t0 = performance.now();
      const built = buildCave(ctx, plan);
      /* AND THE ROCK IT STANDS ON. `liftToClear` raises the plan until its
       * floor clears the highest terrain under the footprint and nothing built
       * the wedge that leaves: the Sunken Hall shipped with 3.1 m of daylight
       * under a 38 x 32 m slab and a doorway 4.07 m over the ground outside it.
       * `buildPlinth` owns the reasoning; note it is handed the SAME field the
       * lift was measured against, so the two cannot disagree about where the
       * ground is. */
      const base = buildPlinth(ctx, built.plan, field);
      /* The apron's treads join the world's own published tread list, which is
       * what `ReachGraph` reads. A 1.2 m tread is invisible to a 6 m lattice,
       * and an invisible apron leaves the mouth resolving to no node at all -
       * the graph looks for the pad under the doorway, finds the apron, and has
       * nothing on it. */
      for (const t of base.steps) this._steps.push({ ...t, cave: plan.id });
      const ms = performance.now() - t0;
      this._emit(B, `cave:${plan.id}`);
      B.dispose();
      B = null;
      this.enterables.push(built.enterable);
      out.push({
        id: plan.id, built: true, lift, profile, vacancy, ms,
        colliders: built.colliders.length + base.colliders.length,
        lights: built.lights.length,
        mouths: built.enterable.cave.mouths.length,
        spots: built.enterable.collectibleSpots.length,
        plan: built.plan,
        base,
        /* The objects themselves, so a suite can audit what SHIPPED rather than
         * build a second pair of caves beside them and audit those. */
        parts: {
          colliders: built.colliders, lights: built.lights, enterable: built.enterable,
        },
      });
      await breathe();
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* The traffic in the flats                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Where an oasis herd stands: on the desert OUTSIDE the tank, on the side
   * the road comes in from.
   *
   * Not on the crest, and the reason is the one `Oasis.js` spends a whole audit
   * on. The tank is a stepped bank whose crest promenade has 1.30 m of clear
   * walkway all the way round and 0.40 m risers under it; a camel is 2.85 m
   * tall with a 0.55 m capsule and a 2.83 m body, and eight of them on a 3.60 m
   * tread is a wall between the player and the water. So the herd grazes on
   * grade beside the tank, which is also where the encounter measurement
   * spreads it.
   *
   * The bearing sweep STARTS toward the world origin because the mesa is there
   * and so is every road: the animals should be met on the way in rather than
   * found round the back. Each candidate has to have ground under it and has to
   * be clear of the masonry, tested with the world's own probe rather than by
   * arithmetic on the plan, so a herd cannot be placed inside the shade shelter
   * the kit happened to build on that side.
   *
   * ── WHY THE RING COMES BACK WITH THE POINT ───────────────────────────────
   *
   * The caller publishes a herd RADIUS as well as a herd anchor, and the first
   * cut published the tank's own half-width, 26.9 m, for both. That number then
   * became `CitadelTraffic`'s `spread`, so `spawnBeastGroup` scattered the other
   * six animals up to 26.9 m from an anchor standing only `ring` metres clear
   * of the rim - onto the masonry. Measured over 30 seeds x 2 oasis herds = 420
   * bodies on the real world: 143 of them (34%) stood more than 1.5 m off their
   * own anchor's ground and 89 (21%) inside the tank footprint, the worst
   * 10.45 m up on a three-deck structure at (-73.1, -126.0). The eight wayside
   * wells, whose spread is 9.9 m, are clean by comparison.
   *
   * So the ring the sweep actually settled on is the honest radius: clear
   * ground runs from the tank rim outward, the anchor sits `ring` beyond it,
   * and a spread of `ring` reaches exactly back to the rim. The caller takes
   * 80% of it, which keeps the animals off the masonry with a margin - and it
   * publishes THE SAME number to the encounter gate, because a declared radius
   * the bodies do not fill is the medieval defect wearing a hat.
   *
   * @param {{x:number,y:number,z:number,r:number}} lm the oasis landmark
   * @returns {{pos:THREE.Vector3, ring:number}}
   */
  _oasisGrazing(lm) {
    const inward = Math.atan2(-lm.z, -lm.x);
    for (const ring of [10, 15, 21]) {
      for (let i = 0; i < 16; i++) {
        /* Alternating outward from the inward bearing, so the first acceptable
         * answer is the one nearest the road rather than the first one on an
         * arbitrary sweep. */
        const step = ((i + 1) >> 1) * (Math.PI / 8) * (i % 2 ? 1 : -1);
        const a = inward + step;
        const x = lm.x + Math.cos(a) * (lm.r + ring);
        const z = lm.z + Math.sin(a) * (lm.r + ring);
        const g = this.physics.groundHeight(x, z, lm.y + 12, 30);
        if (g === null) continue;
        _v1.set(x, g + 0.05, z);
        this.physics.resolveCapsule(_v1, 0.6, 2.9);
        if (Math.hypot(_v1.x - x, _v1.z - z) > 0.45) continue;
        return { pos: new THREE.Vector3(x, g, z), ring };
      }
    }
    /* Nothing clear anywhere round the tank is a finding, not a crash: the
     * herd goes on the crest and the audit that reads `traffic.oases` will say
     * where it ended up. */
    console.warn(`[CitadelWorld] oasis "${lm.id}" has no clear grazing ground round it`);
    return { pos: new THREE.Vector3(lm.x, lm.y, lm.z), ring: 10 };
  }

  /**
   * Two oases, eight wayside wells, three caravan roads and ten travellers.
   *
   * ── The complaint, and the measurement that answers it ──────────────────
   *
   * The player walked the finished ring and said the six new regions all work
   * and *"it desperately needs npc's in the new areas. In the large open areas
   * between objects/villages/caves we should have npc's leading wandering the
   * areas with herds of camels and maybe 1 or 2 oasis areas"*.
   *
   * `scripts/tests/citadel-traffic.test.mjs` measures exactly how empty that
   * ground is: of the 160 places this world publishes to some system or other -
   * 109 relics, 9 caches, 10 viewpoints, 7 venues, 7 region anchors, 6 region
   * centres, 10 cave mouths, the spawn and the portal - **not one stands in the
   * open flats**, 51.0% of the map is over 30 m from anything built, and the
   * longest featureless stretch on an inter-region walk has a p90 of 272 m.
   *
   * `scripts/tests/citadel-caravans.test.mjs` turns that into five floors on
   * ENCOUNTER rather than on placement, because the medieval expansion answered
   * this same complaint with ten wildlife packs, passed 29 of 29 assertions,
   * and shipped a forest the player could not find an animal in. What this
   * method builds reads, against those five floors:
   *
   *     journeys meeting a caravan      floor 40    achieved 60.7
   *     camels met per journey          floor 3.0   achieved 7.52
   *     journeys meeting a herd         floor 20    achieved 42.7
   *     spawn journeys meeting a camel  floor 60    achieved 76.3
   *     walks with no 150 m of nothing  floor 72    achieved 80.1
   *
   * ── Why it runs here ─────────────────────────────────────────────────────
   *
   * After `_buildCaves`, for the reason the caves themselves run last: the
   * oasis kit sites itself against the FINAL collider set through
   * `auditVacancy`, and a tank levelled onto ground that a region has since
   * built a gantry over is a tank built round somebody else's geometry. And
   * before `_splitDistricts`, because every box emitted here goes into
   * `this._districts` and the splitter is what keeps eight wells spread over
   * 900 m from merging into one mesh with a 900 m bounding sphere.
   *
   * @param {() => Promise<void>} breathe
   */
  async _buildTraffic(breathe = noBreath) {
    /**
     * `colliders` is every collider this method registers, and it is published
     * for one reason: an ABLATION nobody can build any other way.
     *
     * `citadel-traffic.test.mjs` measures how empty the flats are off the
     * world's own collider set, and the negative control under its five floors
     * asks "does an empty placement fail every gate". Once the oases and the
     * wells are BUILT they break up the featureless stretches by themselves,
     * and the control starts passing on masonry rather than on camels - so the
     * control needs a collider set with this drop's own content subtracted, and
     * the only honest way to get one is for the drop to say what it added.
     */
    const report = { oases: [], wells: [], roads: [], refusedOases: [], colliders: [] };
    const field = new SolidField(this.physics.colliders);
    /* SLICED HERE, and the first three yields in this method are the ones that
     * matter. Everything from the top down to the first `breathe` below used to
     * run in one synchronous block: the `SolidField` over 3,883 colliders, both
     * oasis site searches, both fine settles, and the first `buildOases`.
     * Measured over three cold processes, that block was 32.6 / 32.8 / 33.3 ms
     * - the worst slice in the whole build, ahead of the souk's - and this
     * world is built by `scheduleBackgroundBuilds` in the player's own frames,
     * so it is a 33 ms frame in live gameplay against a 24 ms budget.
     *
     * C5 could not see it. That gate counts COLLIDERS between two yields as its
     * proxy for work, calibrated at 12 colliders/ms off the souk; this block
     * registers 127 in 33 ms, which is 3.8/ms, so C5 scored a 33 ms stall as if
     * it were ten. The search is arithmetic over a collider index and emits
     * almost nothing, which is exactly the shape the proxy is blind to. */
    await breathe();
    /**
     * The oasis kit's own audit surface.
     *
     * `citadel-oasis.test.mjs` used to build its own pair of tanks on top of a
     * finished world and audit those. It cannot any more - the world ships
     * them, and `findOasisSite` correctly refuses the ground they stand on - so
     * what it audits now is what SHIPS, which is what its own header always
     * said it wanted. Everything that suite needs and cannot recover from the
     * scene graph is published here: the settled plans, the parts each oasis
     * returned, the colliders it registered (so a pre-oasis `SolidField` can be
     * reconstructed by subtraction) and what the host batch received.
     */
    const oasis = {
      sites: [], parts: [], colliders: [],
      hostBuckets: new Map(),
      baseColliders: this.physics.colliders.length,
      searchMs: 0, buildMs: 0,
      /* ONE palm pair for both tanks. Two `buildOases` calls with no `ctx.palm`
       * between them build two 1,964-triangle palms and hold both resident for
       * ever, which is 1,964 triangles of geometry nobody needed; the instanced
       * fields stay separate either way, so sharing costs nothing. */
      palm: palmGeometry(),
    };

    /* ---- the two oases ------------------------------------------------ *
     * SEARCHED, never authored. `citadelOases` returns ANCHORS with no `y` on
     * purpose and its own docstring records the sweep behind them: 18 of ~4,900
     * desert cells can carry a 53.8 x 50.8 m tank and all eighteen are in the
     * south-west, because a 24 m horizontal water plane cannot be levelled into
     * a dune field without a plinth taller than the tank.
     *
     * One batch per oasis, exactly as the caves get one each and for the same
     * measured reason: the two sites are 210 m apart, and a shared masonry mesh
     * holding both comes back from the splitter as many more leaves than two.
     */
    let B = null;
    const ctx = {
      physics: this.physics,
      group: this.group,
      track: (c) => this.track(c),
      mat: (k, o) => this._mat(k, o),
      palm: oasis.palm,
      box: (key, w, h, d, x, y, z, rotY = 0, tint = null) => {
        /* Recorded with the SAME bevel rule `Batch.box` applies below, so the
         * cost report and the geometry cannot disagree about what was drawn.
         * @see Batch#box - a box under BEVEL_MIN on its smallest side is a
         * plain 12-triangle box and everything else is a 108-triangle rounded
         * one, which is the factor of nine `solidCost` exists to price. */
        const rec = oasis.hostBuckets.get(key) ?? { boxes: 0, bevelled: 0 };
        rec.boxes++;
        const r = Math.min(BEVEL, w * 0.22, h * 0.22, d * 0.22);
        if (Math.min(w, h, d) >= BEVEL_MIN && r > 0.02) rec.bevelled++;
        oasis.hostBuckets.set(key, rec);
        B.box(key, w, h, d, x, y, z, rotY, tint);
      },
    };
    const plans = [];
    const tSearch = performance.now();
    for (const anchor of citadelOases()) {
      const found = findOasisSite(field, anchor, {
        id: anchor.id,
        label: anchor.label,
        reach: 60,
        /* Two oases 40 m apart are one oasis with a wall down the middle. The
         * kit's own suite uses the same 140 m. */
        avoid: plans.map((p) => ({ x: p.plan.x, z: p.plan.z, r: 140 })),
      });
      if (!found) {
        console.warn(`[CitadelWorld] oasis "${anchor.id}" found no viable site near (${anchor.x}, ${anchor.z})`);
        report.refusedOases.push({ id: anchor.id, reason: 'no viable site' });
        continue;
      }
      /* Re-settle the winner at the full 1 m lattice: the search runs coarser,
       * and the kit's own docstring records a site that measured 0.39 m of
       * relief at 2.5 m and 1.0 m at 1.0 m because the coarse pass stepped
       * straight over a ridge. */
      const fine = settleOasis(
        { id: anchor.id, label: anchor.label, x: found.plan.x, z: found.plan.z, yaw: found.plan.yaw },
        field, { step: 1.0 }
      );
      if (!fine.viable) {
        console.warn(`[CitadelWorld] oasis "${anchor.id}" failed the fine settle: ${fine.reasons.join('; ')}`);
        report.refusedOases.push({ id: anchor.id, reason: fine.reasons.join('; ') });
        continue;
      }
      plans.push({ plan: fine.plan, relief: fine.profile.relief, lift: fine.lift });
      oasis.sites.push({ ...fine, distance: found.distance, anchor });
      /* One site search plus one fine settle is 9-10 ms of its own. */
      await breathe();
    }
    oasis.searchMs = performance.now() - tSearch;

    if (!Array.isArray(this.enterables)) this.enterables = [];
    /** Every static herd in the world - the oasis herds and the well herds. */
    const camps = [];
    /** @type {Array<{id:string,x:number,y:number,z:number,r:number,herd:number,kind:string,label:string}>} */
    this.oases = [];
    const oasisStaff = [];
    /* Between the last search and the first build: `buildOases` is 7.5 ms a
     * tank and the search that precedes it is 9-10 ms, so without this the two
     * still land in one slice. */
    await breathe();
    for (const { plan, relief, lift } of plans) {
      B = new Batch({ ao: 0.5, sky: 0.28, grime: 0.62, span: 3.0 }, TILE_METRES);
      const t0 = performance.now();
      const kit = buildOases(ctx, [plan]);
      const ms = performance.now() - t0;
      oasis.buildMs += ms;
      oasis.parts.push(...kit.oases);
      oasis.colliders.push(...kit.colliders);
      report.colliders.push(...kit.colliders);
      /* The meshes the HOST paid for, which `kit.draws` cannot see: it counts
       * the water plane and the two palm fields, and the masonry only when the
       * kit had to open a batch of its own. This world gives each oasis a batch
       * and flushes it here, so these are real draw calls and the report has to
       * say so. One mesh per DISTINCT MATERIAL KEY the tank painted with:
       * measured 7 per oasis on top of the kit's 3, up from 6 before the art
       * pass gave the bank and the sand drifted over it a `dirt.ground` bucket
       * of their own. `citadel-oasis.test.mjs` holds the count against
       * `hostMeshes` below - a key added by accident is how this grows. */
      const emitted = this._emit(B, `oasis:${plan.id}`).length;
      B.dispose();
      B = null;
      /* THE WATER AND THE PALMS ARE MESHES THE KIT MAKES ITSELF, and the world
       * has to own them or nothing ever frees them. `_emit` only owns what came
       * through the batch; the water plane and the two instanced palm fields
       * are built by `buildOasis` directly, and the first draft of this method
       * left all six of them - two trunks, two crowns, two water planes - in
       * the scene with nothing on `_owned` pointing at them. `citadel-budgets`
       * C2 asserts that in both directions and named all six. */
      for (const o of kit.oases) {
        if (o.water?.mesh?.geometry) this._owned.push(o.water.mesh.geometry);
        /* An `InstancedMesh` draws the SOURCE geometry, so `m.geometry` is the
         * palm trunk and crown themselves - which is also why both oases share
         * one pair and this list holds each of them once however many times it
         * is pushed. */
        for (const m of o.palms?.meshes ?? []) if (m.geometry) this._owned.push(m.geometry);
      }
      /* Streamed as ENTERABLES with no doors, which is the same shape
       * `buildCave` publishes, so `Interiors` handles the collectible spots at
       * an oasis with no new code. */
      for (const e of kit.enterables) this.enterables.push(e);
      /* THE KIT'S `cacheSites` ARE DELIBERATELY NOT PUBLISHED.
       *
       * `this.cacheSites` is a list of HIGH places for `Caches` to nominate,
       * and `citadel-objectives` floors it at exactly one per outer region -
       * six, which is what the region stage measured with `Caches._highAt` on a
       * 2 m lattice. An oasis crest is 2.57 m over the desert and would be
       * refused by that predicate anyway, but the nomination is not free: the
       * authored channel is counted against `highWanted`, so two oasis
       * nominations are two regions' worth of cache budget spent on ground that
       * is not high.
       *
       * The oases pay into the cache system the other way instead, and it is
       * the better one. `Caches._findSunken`'s own comment says "Citadel has no
       * water: `_findSunken` places 0 and logs 0 sunken, 9 high" - with a 2.45 m
       * pool it now finds one per tank, which is a sunken cache in a world that
       * has never had one. */
      /* The staff are STREAMED rather than pushed onto `npcSpawns`. Two
       * permanent characters standing at a pool 200 m off every corridor is
       * exactly the flat roster `medieval/Residency.js` measured at 74.6%
       * beyond `RENDER_OUT`, and `_fillSpawns` has already run its
       * `_nudgeClear` pass over `npcSpawns`, so anything appended here would
       * skip it. */
      for (const s of kit.npcSpawns) oasisStaff.push(s);
      /* The viewpoint the kit returns is deliberately NOT published: the kit's
       * own docstring explains that `Viewpoints` treats the array as a
       * completion set with a cosmetic and a mount power at the end of it, and
       * the Citadel's five are its five hardest climbs. An oasis you walk onto
       * is not one of those. */
      const lm = kit.landmarks[0];
      /* THE HERD, which is the half of an oasis the player asked for.
       * Declaring a herd and spawning nothing would be the medieval defect in
       * miniature: a number in a contract that no body in the world answers to.
       * It stands on the ground OUTSIDE the tank, on the side the roads come in
       * from - see `_oasisGrazing` for why not on the crest. */
      const { pos: graze, ring: grazeRing } = this._oasisGrazing(lm);
      /* The ground the herd actually has, and the SAME number goes to the
       * encounter gate below. @see _oasisGrazing for the 420 bodies that were
       * measured standing on the masonry when this was `lm.r`. */
      const grazeR = grazeRing * 0.8;
      camps.push({
        id: `${lm.id}-herd`,
        label: lm.name,
        position: graze,
        /* SEVEN, not the reference placement's eight, and it is the camel row's
         * own `packMax` that decides it: `NPCManager.spawnBeastGroup` clamps
         * every group to the species cap, so a declared eight would stand seven
         * animals at the water and tell the encounter gate there were eight.
         * @see Caravans.TRAIN_ANIMALS for the same correction on the roads and
         * what it cost. */
        herd: CAMEL_PACK_MAX,
        r: grazeR,
        keeper: null,
      });
      this.oases.push({
        id: lm.id,
        label: lm.name,
        kind: 'oasis',
        /* WHERE THE ANIMALS ARE, not where the water is, and the difference is
         * 37 m at the Palm Well. `caravanContent` reads this to spread a herd
         * over `r` and count what a walk passes within recognition of; giving
         * it the tank centre would be declaring eight camels standing in a
         * 2.45 m deep pool. The pool is `tank` below, for anything that wants
         * the landmark rather than the herd. */
        x: graze.x, y: graze.y, z: graze.z,
        /* The clear grazing ring, which is both the ground the herd spreads
         * over and the `spread` `CitadelTraffic` spawns them at - one number,
         * so the animals the gate counts stand where the animals the player
         * counts stand. NOT the tank's half-width: that put a quarter of them
         * inside the masonry. @see _oasisGrazing. */
        r: grazeR,
        herd: CAMEL_PACK_MAX,
        tank: { x: lm.x, y: lm.y, z: lm.z, r: lm.r },
      });
      report.oases.push({
        id: plan.id, x: plan.x, z: plan.z, ms, relief, lift,
        colliders: kit.colliders.length,
        triangles: kit.triangles,
        /* The kit's own three plus the masonry meshes this world's batch
         * emitted for it. @see the note above and `Oasis.cost.draws`. */
        draws: kit.draws + emitted,
        kitDraws: kit.draws,
        hostMeshes: emitted,
        herdAt: { x: graze.x, y: graze.y, z: graze.z },
        herdR: grazeR,
      });
      await breathe();
    }

    /* NOTHING BUILT, NOTHING TO HANG THE PALMS ON.
     *
     * `oasis.palm` is built before the site search, because both tanks share
     * one trunk/crown pair and building it twice would hold 1,964 triangles
     * nobody needs. It reaches `_owned` only through an oasis's own
     * `palms.meshes` - an `InstancedMesh` draws the SOURCE geometry - so on the
     * two documented refusal paths above ("no viable site", "failed the fine
     * settle") both geometries would be orphaned with nothing pointing at them.
     * Never live today, because both oases build; a leak that is only latent is
     * still the reason the water planes were left in the scene in the first
     * draft of this method. */
    if (!plans.length) {
      oasis.palm.trunk?.dispose?.();
      oasis.palm.crown?.dispose?.();
      oasis.palm = null;
    }

    /* ---- the eight wayside wells --------------------------------------- *
     * ONE batch for all eight, and that is the opposite of the oasis rule for
     * a reason that is about what the splitter can do rather than about taste:
     * a well is 26 boxes, so eight of them separately would be sixteen tiny
     * meshes with sixteen draw calls, while one merge of 208 boxes goes through
     * `_splitDistricts` and comes back as leaves under the 130 m sphere ceiling
     * - the same treatment the souk and the regions get. (26 and 208, measured
     * off the build's own report: the first cut of this comment said 22 and
     * 176, which was the box count before the awning cross-beams and the two
     * crates went in.)
     */
    B = new Batch({ ao: 0.5, sky: 0.28, grime: 0.7, span: 2.4 }, TILE_METRES);
    for (const site of WELL_SITES) {
      const y = groundFor(this.physics, site.x, site.z, citadelHeight(site.x, site.z));
      if (y === null) {
        console.warn(`[CitadelWorld] well "${site.id}" has no ground at (${site.x}, ${site.z})`);
        continue;
      }
      /* Yaw from the site's own coordinates, so the awning faces the mesa and
       * two wells never read as the same prop turned the same way. */
      const yaw = Math.atan2(-site.z, -site.x);
      const built = buildWell(ctx, site, y, yaw);
      camps.push({
        id: site.id,
        label: site.label,
        position: new THREE.Vector3(site.x, y, site.z),
        herd: site.herd,
        r: WELL_R * 1.8,
        keeper: {
          position: new THREE.Vector3(built.spots[0].x, y, built.spots[0].z),
          type: 'friendly',
          role: 'wanderer',
          name: site.keeper.name,
          persona: site.keeper.persona,
          patrol: [
            new THREE.Vector3(built.spots[0].x, y, built.spots[0].z),
            new THREE.Vector3(built.spots[1].x, y, built.spots[1].z),
          ],
        },
      });
      this.oases.push({
        id: site.id,
        label: site.label,
        kind: 'well',
        x: site.x, y, z: site.z,
        r: WELL_R * 1.8,
        herd: site.herd,
        /* The measured share of the 8,384 inter-region journeys that pass
         * within the 15 m recognition distance of this site, carried through
         * from `Caravans.WELL_SITES` so a well that is moved has to be
         * re-measured rather than re-argued. */
        share: site.share,
      });
      report.wells.push({ id: site.id, x: site.x, y, z: site.z, boxes: built.boxes, colliders: built.colliders.length });
      report.colliders.push(...built.colliders);
      await breathe();
    }
    this._emit(B, 'wells');
    B.dispose();
    B = null;

    /* ---- the three roads ----------------------------------------------- *
     * The authored `y` on every waypoint is a HINT that
     * `npc-routes.test.mjs` checks against the real surface with a 2 m
     * tolerance; `roadWaypoints` is what turns it into the real surface, once,
     * so the drover's patrol, the camel homes and the published contract all
     * read one list of points.
     */
    const roads = CARAVAN_ROADS.map((road) => ({
      ...road,
      waypoints: roadWaypoints(road, this.physics),
    }));

    /**
     * THE CONTRACT the encounter measurement reads.
     *
     * `citadel-traffic-kit.caravanContent` takes `world.caravanRoutes` and
     * `world.oases` and scores them; publishing them is what lets a headless
     * gate certify the placement the game actually ships rather than a model of
     * it. `points` is the one-way road - the kit mirrors it into an
     * out-and-back cycle itself, which is exactly what `CitadelTraffic` does
     * with the same list.
     */
    this.caravanRoutes = roads.map((r) => ({
      id: r.id,
      label: r.label,
      cargo: r.cargo,
      points: r.waypoints.map((p) => ({ x: p.x, y: p.y, z: p.z })),
      trains: r.trains,
      animals: r.animals,
      length: roadLength(r.waypoints),
    }));
    for (const r of this.caravanRoutes) report.roads.push({ id: r.id, points: r.points.length, length: r.length });

    /* ---- and the people on them ---------------------------------------- */
    const wanderers = [];
    for (const w of WANDERERS) {
      const pts = [];
      let ok = true;
      for (const [x, z] of w.legs) {
        const y = groundFor(this.physics, x, z, citadelHeight(x, z));
        if (y === null) { ok = false; break; }
        pts.push(new THREE.Vector3(x, y, z));
      }
      if (!ok) {
        console.warn(`[CitadelWorld] wanderer "${w.id}" has no ground on its round`);
        continue;
      }
      wanderers.push({
        position: pts[0].clone(),
        type: 'friendly',
        role: 'wanderer',
        name: w.name,
        persona: w.persona,
        patrol: pts,
      });
    }

    /**
     * The streaming population, published as `_population`.
     *
     * The name is not incidental: `npc-routes.test.mjs` reads
     * `world._population?.people` precisely so that a streamed cast cannot
     * become a second, unchecked kind of route, which is what the vale's two
     * mid-air sentries were. Every drover's patrol IS its road, so this
     * publishes all three roads for that audit as well.
     */
    this._population = new CitadelTraffic({
      npcManager: () => (this.active ? this.ctx?.npcManager ?? null : null),
      physics: this.physics,
      roads,
      camps,
      wanderers,
      residents: oasisStaff,
    });
    if (Array.isArray(this._owned)) this._owned.push(this._population);

    report.declaredAnimals = this._population.declaredAnimals;
    report.roster = this._population.rosterSize;
    report.oasis = oasis;
    return report;
  }

  /**
   * The ring's three trials, appended to the souk's.
   *
   * One per verb the ring teaches that the mesa cannot: a descent, a long line
   * and a plunge. Each is built out of decks the region actually published, so
   * a checkpoint cannot land somewhere no collider exists - the medieval defect
   * class restated, and the reason `_publishVenues` runs everything through
   * `_deckSpot` rather than through a roof's centre.
   *
   * `venueBounds` sizes the disc to the WHOLE ROUTE and not the start line,
   * because `MinigameManager.fixedUpdate` aborts nine seconds after the player
   * leaves it and none of these runs is under nine seconds.
   */
  _publishRegionVenues(routes) {
    const pt = (d) => (d ? { x: d.x, y: d.y, z: d.z } : null);
    const add = (id, pts) => this._fillVenue(id, pts);

    /* The tier-0 round, and the only trial in the world a player can win
     * without ever leaving the walk jump.
     *
     * Two ranges and the corner between them, which is where the mast stands:
     * the checkpoint chain skips the mast, and the route through it is found
     * rather than authored - `minigame-rooftop-times.test.mjs` runs Dijkstra
     * over the world's own published decks between consecutive checkpoints, so
     * the mast's bottom storey is a stepping stone the par model discovers on
     * its own. Authoring a checkpoint on the mast would have put a ring inside
     * a tower.
     *
     * Ashfall and the Eyrie deliberately get NO trial, and the reason is
     * measured rather than aesthetic. That route graph links two decks only
     * within 26 m: Ashfall's ranges stand 28 m apart across a 9 m scar, and the
     * Eyrie's three cloister ranges are 66 m apart round a peak. Neither region
     * is a rooftop RUN - one is improvisation over broken ground and the other
     * is a sustained climb - and a timed checkpoint chain is the wrong
     * instrument for both. Their objectives are relics, a cache, a viewpoint
     * and, at the Eyrie, the longest leap of faith in the game.
     */
    const c = routes.caravanserai;
    if (c) {
      const [north, , , east] = c.rows;
      add('citadel_serai_circuit', [
        pt(north.plots[0]), pt(north.plots[2]), pt(north.plots[4]),
        pt(east.plots[0]), pt(east.plots[2]), pt(east.plots[3]),
      ]);
    }

    /* One terrace, end to end, and NOT the four-terrace descent the first cut
     * published. A terrace change here is a 10-13 m drop into hay, which is the
     * region's whole verb - and `minigame-rooftop-times.test.mjs` builds its
     * route graph out of published DECKS, where a drop onto open street has no
     * pad to land on and the leg has no path at all. A trial has to be a route
     * the validator can walk; the descent is a thing the player does. */
    const u = routes.undercliff;
    if (u) {
      const line = [];
      for (const i of [0, 2, 4, 6, 8]) line.push(pt(u.terraces[0].row.plots[i]));
      add('citadel_undercliff_run', line);
    }
    /* DOWNHILL, the way the water runs, and that is a par-model decision as
     * well as a fictional one. `RooftopTrial.climbLegs` counts a checkpoint
     * pair whose rise beats the leap's 1.109 m apex as a CLIMB and charges
     * `CLIMB_LEG_S` for it. Run massif-to-mesa the spine's own 0.46 m joints
     * are all descending and it charges none; run the other way, five
     * checkpoints 2.3 m apart each bought a climb leg, gold came out at 73.1 s
     * against a 22.6 s best line, and the trial had 69% of headroom against a
     * 45% ceiling - a gold everybody gets. */
    const a = routes.aqueduct;
    if (a) {
      const line = [];
      for (let i = a.decks.length - 1; i >= 0; i -= 5) line.push(pt(a.decks[i]));
      /* The head of the spine, ONLY if the stride did not already land on it.
       *
       * It did. `buildAqueduct` publishes 26 decks, so the loop runs 25, 20,
       * 15, 10, 5, 0 and terminates ON index 0 - and the unconditional push
       * added it a second time. Checkpoints 5 and 6 came out identical, a
       * 0.00 m leg against 6.9-71.6 m everywhere else in the world: two
       * coincident `RaceRings` tori z-fighting at the finish, both tangents
       * computed as (0,0) by `RooftopTrial.readRoute` so both fall back to
       * facing -Z on a route running +Z, "6 of 6 rings" reported for a
       * five-leg route, and `_advance`'s on-pace divisor `route.length - 1`
       * six instead of five for the whole run. */
      if ((a.decks.length - 1) % 5 !== 0) line.push(pt(a.decks[0]));
      add('citadel_aqueduct_run', line);
    }
    /* The gantries alone. The rim buildings stand on the other side of the pit
     * from the head of the chain - 90 m away, past the 26 m the route graph
     * looks in - so starting there gave the venue a first leg with no path. */
    const q = routes.deepworks;
    if (q) {
      const line = q.gantry.map(pt);
      add('citadel_deepworks_plunge', line);
    }

    this._pruneVenues();
  }

  /* ------------------------------------------------------------------ */
  /* Frame                                                               */
  /* ------------------------------------------------------------------ */

  update(dt) {
    this._time += dt;

    const cam = this.engine?.camera;
    if (cam) {
      /* Distance LOD over the split districts and the terrain tiles. The world
       * manager only calls `update` on the ACTIVE world, so this is already a
       * no-op everywhere else, and a no-op over an empty registry before the
       * build has finished. */
      this._lod.update(cam);
      /* The sky dome rides with the camera so the gradient never parallaxes.
       * It used to be a fixed 900 m sphere centred on the world origin, which
       * at a 200 m playfield was a margin nobody could see past; at 450 m the
       * far corner stands 264 m from the dome in front and 1,536 m behind it,
       * and the horizon band tilts as the player walks. */
      if (this._skyDome) this._skyDome.position.copy(cam.position);
      /* The caravans, and the herds and travellers with them.
       *
       * Driven off the CAMERA rather than off the player body, on the same
       * reasoning `MedievalWorld` gives for its grass: what has to have content
       * near it is whatever the lens can see, and in a third-person or free-look
       * frame those are metres apart.
       *
       * Every train advances every frame - nine trains of four floats, no
       * allocation - and the streaming decision behind it is throttled to
       * 0.4 s or 8 m of travel. @see CitadelTraffic#update */
      cam.getWorldPosition(_v1);
      this._population?.update(_v1.x, _v1.z, dt);
    }

    // Banners only - everything else in this world is static, and it should be:
    // a climbing surface that moves is a climbing surface that betrays you.
    for (const b of this._banners) {
      b.mesh.rotation.z = Math.sin(this._time * 1.6 + b.phase) * 0.09;
    }
  }

  dispose() {
    /* Deregister BEFORE the geometries go: `DistanceLod` holds a `lo` per entry
     * and swaps it onto the mesh, so an entry left registered over a disposed
     * geometry is a swap onto nothing on the next frame. `MedievalWorld:5952`
     * records the same ordering trap from the other direction. */
    this._lod.clear();
    for (const g of this._owned) g.dispose?.();
    this._owned.length = 0;
    this._banners.length = 0;
    this._roofs.length = 0;
    this._towers.length = 0;
    this.haystacks.length = 0;
    this.viewpoints.length = 0;
    this.ropeBridges.length = 0;
    this.minigameVenues.length = 0;
    this.cacheSites.length = 0;
    /* The caravans go with everything else. `_owned` holds the population and
     * the loop above has already called its `dispose`, which releases every
     * streamed body through the manager; this drops the roster so a rebuilt
     * world does not inherit one. */
    this._population = null;
    /* The build report holds `oasis.parts` and every geometry reference the kit
     * returned; `_owned` has already disposed the geometries themselves, and
     * this drops the last strong reference to the rest of the graph so a
     * rebuilt world does not inherit it. Every other published list below is
     * cleared for the same reason and this one was missed. */
    this.traffic = null;
    this.oases.length = 0;
    this.caravanRoutes.length = 0;
    this._terrainTiles.length = 0;
    this._terrainSwap.length = 0;
    this._districts.length = 0;
    this._lodReport = null;
    this._skyDome = null;
    this._matCache?.clear();
    super.dispose();
  }
}

export default CitadelWorld;
