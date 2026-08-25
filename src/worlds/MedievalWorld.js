import * as THREE from 'three';
/* Lights are born HIDDEN: one frame with a world's own lights live re-links
 * every program on screen. gfx/WorldLight.js has the whole of it. */
import { pointLight, dirLight } from '../gfx/WorldLight.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { World } from './World.js';
import { InteriorKit } from './InteriorKit.js';
import { DistanceLod, SURFACE } from './lod/DistanceLod.js';
import { genPool } from '../workers/GenPool.js';
/* The ground, and the layout that shapes it, live in their own module so the
 * generation worker can import them without pulling in `three` and this entire
 * file. Imported back here rather than duplicated: one definition of the terrain
 * is the only thing keeping the mesh, the collision and every prop agreeing. */
import {
  mulberry32, clamp01, lerp, smoothstep, smootherstep, bump, rectDist,
  perlin2, fbm2, riverZ, medievalHeight, riverHalfWidth,
  HALF, CASTLE, MARKET, VILLAGE, CIRCLE, BRIDGE_X, CHURCH_PADS, WATER_Y,
  INNER_KEEP, LANDFORMS, RIVER_FEATURES,
} from './terrain/MedievalHeight.js';
/* Settlements own the plot table and the definition of trodden ground, for the
 * same reason the terrain module owns the height function: they are shared
 * with the tests and with anything that needs to know where a place is,
 * without dragging `three` and nine thousand lines of world in behind them. */
import {
  PLOTS, EXTRA_YARDS, SETTLEMENTS, settledAt, inSettlementCore,
} from './medieval/Settlements.js';
/* Who lives here, what hunts them and what is worth finding - all derived from
 * the settlement table rather than written out per town, so a settlement added
 * to `Settlements.js` is populated without this file being touched. See the
 * header of `medieval/Inhabitants.js` for why it is exactly one call. */
import { applyMedievalPopulation } from './medieval/Inhabitants.js';
import { GridIndex, segmentDistance } from './medieval/GridIndex.js';
/* The road network moved out for the same reason the settlement table did, and
 * for one more: "can you actually get there" is a graph question with a
 * headless answer, and a 900 m map with five towns on two banks can be
 * disconnected without anything looking wrong. See `medieval/RoadNet.js`. */
import { ROADS, CROSSINGS, GREYOAK_STAGE } from './medieval/RoadNet.js';
/* The five towns of the outer ring: layouts, interiors and the arithmetic that
 * says a staircase reaches the floor above it. Pure, and tested as such. */
import {
  TOWNS, REEDWATER_JETTIES, REEDWATER_DECK, GRIMSCAR_WORKINGS,
  CEOLWINE_PRECINCT, CEOLWINE_GARTH, CEOLWINE_HERBS, CEOLWINE_POND,
  BLACKMARCH_PALISADE, BLACKMARCH_YARD, BLACKMARCH_BEACON,
  FENWICK_CROSS,
  interiorPlan, groundUnder, hasChimney, plinthCourses,
  STAIR_W, DOOR_W, DOOR_H, FLOOR_T,
} from './medieval/Towns.js';
import { CAMPS, campPieces } from './medieval/Camps.js';
/* Where the trees are and how thick they stand. The counts below are derived
 * from a density and the mask's own integral rather than authored, which is
 * the bug that module exists to fix - 520 absolute trees over a map that got
 * five times bigger is not a forest. */
import {
  standAt, isWoodEdge, NAMED_WOODS, DEADFALL_PER_WOOD,
  PLAYFIELD_TREES, UNDERSTOREY, BRACKEN, TREE_BUCKET_M, standSpecies, woodMask,
} from './medieval/Woodland.js';
/* The terrain's own spatial split. Same reason as `Settlements` and
 * `GridIndex`: the tile arithmetic is the part that fails silently (a seam, a
 * crack, a bounding sphere that spans the map), and it has to be testable
 * without a renderer. */
import {
  tileGrid, buildTile, TILE_METRES, TILE_LO_STRIDE, TILE_SWAP_DISTANCE, TILE_SKIRT_DROP,
} from './medieval/TerrainTiles.js';
import { GrassResidency } from './medieval/GrassResidency.js';
import { loadBeastAssets } from './medieval/BeastAssets.js';

/**
 * ALDERMOOR VALE - the medieval world.
 *
 * A ~900x900m golden-hour landscape: a noise heightfield valley with a
 * meandering river, a castle on a rise to the north-west, a timber-framed
 * village and market on the terrace below, woodland, and a ruined stone circle
 * housing the gateway back to the station.
 *
 * Everything is procedural - textures are painted to canvases at build time and
 * geometry is generated from primitives. The key structural decision is the
 * `GeoBatch`: geometry is accumulated per material key and merged once per
 * district, so a village of twenty-five houses costs six draw calls rather than
 * a hundred. Per-object variation that would normally force a unique material
 * (plaster tint, beam stain, cloth dye) is baked into a vertex-colour attribute.
 */

/* ------------------------------------------------------------------ */
/* Module scratch - never allocate inside a loop that runs more than once. */
/* ------------------------------------------------------------------ */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _col = new THREE.Color();
const _obj = new THREE.Object3D();
const _m4 = new THREE.Matrix4();

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ */
/* World layout - one place to change where anything lives.            */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Extent.
 *
 * `HALF` is the one authored number (in `terrain/MedievalHeight.js`, so the
 * generation worker sees the same value); everything below is arithmetic on
 * it. Nothing in this file may write a playfield dimension as a literal - the
 * vale went from 400m to 900m by changing `HALF` alone, and the only reason
 * that was possible is that the terrain job, the collision heightfield, the
 * macro painter, the containment walls, the distant skirt, the grass zones and
 * every scatter bound all read it rather than remembering it.
 * ------------------------------------------------------------------ */

/** Playfield width and depth, metres. */
const SIZE = HALF * 2;
/** Vertex spacing of the terrain mesh AND of the collision heightfield. */
const TERRAIN_STEP = 2;
/** Quads per side. 2m at 900m is 450, i.e. 451^2 = 203,401 samples. */
const TERRAIN_SEG = Math.round(SIZE / TERRAIN_STEP);
/**
 * Where the distant skirt's innermost ring sits.
 *
 * It has to start INSIDE the playfield square so its inner rows are hidden
 * under terrain that is drawn on top of them - `_outerHeight` only drops them
 * 2.5cm, which is not enough to hide a ring that pokes out past the rim.
 */
const SKIRT_INNER = HALF - 12;
/**
 * Where the skirt stops.
 *
 * Absolute, NOT derived from `HALF`: this is set by the 2km camera far plane
 * (`CONFIG.render.far`), not by how big the playfield is. At 900m the sheet
 * still has to reach past the horizon line from the ramparts, and that
 * distance did not change when the vale got wider.
 */
const SKIRT_OUTER = 1928;
/**
 * Grass zone size, metres.
 *
 * The 50m cell is the number that matters, not the zone count: it is chosen
 * against `GRASS_HIDE_DISTANCE` so that a zone's bounding sphere (~35m radius)
 * can leave the 86m blade fade as a unit. Keeping it fixed and letting the
 * count grow with the map is what preserves that reasoning at 900m.
 */
const GRASS_ZONE_M = 50;
/* ------------------------------------------------------------------ *
 * Aerial perspective.
 *
 * Linear fog, so these two numbers are the whole depth cascade: haze is
 * `(d - FOG_NEAR) / (FOG_FAR - FOG_NEAR)`, clamped.
 *
 * 96 / 560 was tuned against a 400 m vale, where the far corner was 283 m and
 * the skirt began immediately behind it - saturating at 560 was correct
 * because there was nothing between 560 m and the backdrop. At 900 m the
 * playfield corner is 636 m, so that ramp put the outer THIRD of the world
 * (everything past 424 m, which is 60% of its area) at 70-100% haze: Grimscar
 * Edge, Blackmarch Bluff, the abbey combe and Fenwick Basin - four landforms
 * authored to be seen from the vale - all arrived at the same flat white.
 *
 * FOG_NEAR is solved rather than chosen. The near field did not change: the
 * keep still stands ~110 m from the village approach and was tuned to take a
 * 3.0% veil there. Holding that fixed while moving the far edge to 880 m
 * gives `(110 - n) / (880 - n) = 0.030`, i.e. n = 86.2.
 *
 * FOG_FAR = 880 m is set by the playfield, not by the backdrop: the longest
 * sightline that ends on authored ground is rim to rim across the map, 900 m,
 * so saturating just inside that means the far rim is the first thing to
 * disappear and everything nearer keeps a distinct step. The resulting
 * cascade: castle 110 m 3%, old vale rim 200 m 14%, ring landmarks 380-450 m
 * 37-46%, playfield corner 636 m 69%, skirt foothills 100%. The distant skirt
 * still saturates long before its 1,928 m outer ring, which is what keeps it
 * landing on the same colour as the sky dome's horizon band - see the
 * aerial-perspective note in the dome shader, which is the reason that
 * matters.
 * ------------------------------------------------------------------ */
const FOG_NEAR = 86;
const FOG_FAR = 880;
/**
 * Ground covered by one repeat of the tiled relief sheet, metres.
 *
 * The terrain's UVs run 0..1 across the whole playfield, so anything expressed
 * as a repeat count is secretly a function of `HALF`. These two are authored
 * in metres and converted at the point of use, which is the only way the
 * micro-shadow band and the detail octaves survive a change of extent. The
 * macro painter's colour drifts get the same treatment - a count per square
 * metre and a radius in metres, rather than a count and a radius in pixels.
 */
const RELIEF_TILE_M = 3.0;
/** Ground per repeat of the albedo detail sheet's primary octave, metres. */
const DETAIL_TILE_M = 4.2;

/**
 * Everything the playfield's size implies, derived once.
 *
 * Exported because the numbers below are the ones that go silently wrong when
 * a world is resized - a terrain job sampled at the old size, a containment
 * wall left at its old coordinate, a grass grid whose cells quietly stretched
 * - and none of them can be checked from a test without a renderer unless the
 * world publishes them. `_buildTerrain` and `_buildNature` consume this object
 * rather than recomputing any of it, so a test that reads it is reading what
 * the build actually used.
 */
export const MEDIEVAL_LAYOUT = {
  half: HALF,
  size: SIZE,
  terrainStep: TERRAIN_STEP,
  terrainSeg: TERRAIN_SEG,
  skirtInner: SKIRT_INNER,
  skirtOuter: SKIRT_OUTER,
  grassZoneMetres: GRASS_ZONE_M,
  grassZones: Math.round(SIZE / GRASS_ZONE_M),
  /** The generation job `_buildTerrain` submits, verbatim. */
  terrainJob: {
    field: 'medieval',
    originX: -HALF,
    originZ: -HALF,
    size: SIZE,
    seg: TERRAIN_SEG,
    uv: 'unit',
    normals: true,
  },
  /**
   * Invisible containment walls as `[cx, cy, cz, hx, hy, hz]`.
   *
   * One metre inside the rim, because each box is 2m thick about its centre:
   * the inner face lands exactly on +/-HALF, which is where the terrain mesh
   * and the collision heightfield both stop.
   */
  walls: [
    [-(HALF - 1), 20, 0, 2, 40, HALF],
    [HALF - 1, 20, 0, 2, 40, HALF],
    [0, 20, -(HALF - 1), HALF, 40, 2],
    [0, 20, HALF - 1, HALF, 40, 2],
  ],
};

/* `WATER_Y` moved to `terrain/MedievalHeight.js` and is imported back: the
 * fords are authored as a depth below it, so the height function has to know
 * where the water is. */
const MOAT_Y = CASTLE.ground - 2.3;
/* Curtain height.
 *
 * 6.4m is a manor's boundary wall, not a curtain, and at 110m it put the whole
 * enceinte at roughly the mass of a two-storey house - which is exactly why
 * two separate reviews described the castle as "a 3m tabletop model" and "a
 * scale model rather than a fortress". Merlons that read as toy battlements
 * are a symptom of the same thing: at 1.4m tall they were a fifth of the wall
 * they stood on. 10.6m is the low end of a real thirteenth-century curtain,
 * makes the merlons an eighth of the wall, and gives the wall-walk sentries a
 * silhouette worth having.
 */
const WALL_H = 10.6;
const WALL_TOP = CASTLE.ground + WALL_H;

/* `ROADS` moved to `medieval/RoadNet.js` and is imported back at the top of
 * this file, along with the crossings that stitch the two banks together.
 *
 * Same reason as `Settlements` and `GridIndex`, plus one that is specific to
 * roads: the property that matters about a network is whether you can get
 * anywhere on it, that is a graph question, and a graph needs no renderer. A
 * 900 m map with five towns on two banks of a river can be disconnected in a
 * way no screenshot shows - a town is simply unreachable and the only symptom
 * is a player walking into water - so `medieval-roads.test.mjs` proves
 * connectivity from the market to every town entry and every camp. It can only
 * do that if the table it reads is the table this file builds from. */


/* `PLOTS` and `EXTRA_YARDS` moved to `medieval/Settlements.js` and are
 * imported back at the top of this file. They are the membership list of two
 * of the settlements in that table, and a table that does not own its own
 * members is not a table. */

/**
 * The one authoritative sky palette.
 *
 * The dome shader, the baked IBL probe, the water reflection and the scene fog
 * all read from here. Authoring the fog separately from the sky is what let a
 * neutral grey haze sit against a peach horizon and flatten every distance cue
 * in the build.
 */
const SKY_HEX = {
  // Deeper zenith and a more saturated horizon band. The previous pair sat
  // barely a stop apart once the grade's haze lift and pedestal were applied,
  // which is why the whole upper half of every frame read as one flat lilac
  // wash instead of as a golden-hour sky.
  // Cyan-leaning zenith rather than a violet one. A pure blue zenith blended
  // against a peach horizon passes through magenta, and magenta is what the
  // whole upper half of frame was landing on; biasing the blue toward cyan
  // moves that transit through a clean slate-grey instead.
  zenith: 0x235279,
  horizon: 0xf6b273,
  ground: 0x5a4c38,
  sunTint: 0xff9330,
  sunCore: 0xfff0cf,
  cloudLit: 0xffdcaa,
  cloudDark: 0x4f5069,
};

/* Alpha-test references. These are shared between the texture generator - which
 * needs them to build a coverage-preserving mip chain - and the materials, so
 * the two can never drift apart and re-introduce the dissolving foliage. */
const LEAF_ALPHA_REF = 0.42;
const GRASS_ALPHA_REF = 0.34;
const REED_ALPHA_REF = 0.30;

/* ------------------------------------------------------------------ */
/* Foliage LOD distances                                              */
/* ------------------------------------------------------------------ */

/**
 * Distance past which a grass zone stops drawing, metres, measured to the
 * NEAREST point of the zone's bounding sphere.
 *
 * This is not a taste number - it is read straight off `windPatch`, which
 * already scales every blade's height by `1 - smoothstep(58, 86, d)` in the
 * vertex shader. At 86m the whole tuft is exactly zero height: the triangles
 * are still assembled, still transformed, still rasterised, and cover no
 * pixels at all. Nearest-point rather than centre distance is what makes that
 * provable - a 50m zone's bounding sphere has a ~35m radius, so "nearest point
 * beyond 86m" means every blade in the zone is beyond 86m, and hiding the
 * zone cannot change a single pixel.
 *
 * Measured on the seven named views: this drops 72-87% of the grass triangles
 * that survive frustum culling (528k of 736k at castle-approach, 1.24M of
 * 1.49M at hills-vista) for a screenshot that is byte-comparable.
 *
 * Dead end worth recording: the obvious move is to hide grass much earlier -
 * 40m or so, on the grounds that a 25cm blade is sub-pixel long before that.
 * It is not available. The 58-86m fade was itself tuned against a bald
 * mid-ground on the castle-approach framing (see the comment on the
 * `windPatch(grass, ...)` call), and anything below 86 undoes that tuning
 * rather than exploiting it. If the grass is to go earlier, the fade moves
 * first and this constant follows it.
 */
const GRASS_HIDE_DISTANCE = 86;

/**
 * Distance past which a tree canopy swaps to its cheap crown geometry,
 * metres, measured to the nearest point of the bucket (or, for the backdrop
 * rings, to the near edge of the ring).
 *
 * 90m rather than something braver because the swap is a tessellation change
 * on crown lumps, and the thing that gives it away is a lump's silhouette
 * turning from a circle into a hexagon. A 5m oak crown at 90m is ~38px tall
 * and each of its ~30 lumps is under 10px, which is below the size at which
 * the facet count is recoverable. Verified by A/B screenshot at hills-vista
 * and ramparts-vista.
 *
 * What this distance does NOT buy: the playfield trees are bucketed by map
 * quadrant, so a bucket's bounding sphere has a 90-143m radius and its
 * nearest point is underfoot from almost anywhere inside the map. Those
 * buckets therefore stay hi-detail nearly always, and that is correct rather
 * than disappointing - a bucket contains trees at 10m and trees at 190m, and
 * a single per-bucket decision has to serve the nearest one. Re-bucketing the
 * trees finely enough for distance LOD to bite is a much larger change than
 * this, and it would cost draw calls; it is not attempted here.
 */
const CANOPY_LO_DISTANCE = 90;

/**
 * Radius multipliers for the cheap crown lumps.
 *
 * A lower-tessellation polyhedron inscribed in the same sphere encloses less
 * volume and casts a smaller silhouette, so a naive swap thins the treeline -
 * which is exactly the "horizon quietly recedes" artefact that makes LOD
 * visible. Both numbers are the linear ratio that restores the silhouette:
 * an 80-face icosphere against a 20-face one, and a 20-face icosphere against
 * an 8-face octahedron.
 */
const LO_BLOB_INFLATE_BROADLEAF = 1.10;
const LO_BLOB_INFLATE_CONIFER = 1.16;

/* Palettes reused for vertex tinting. */
/* Round 5: these were seven values inside a 6% band between 0xde and 0xf4 -
 * a spread narrower than the noise on the sheet itself. Twenty-six houses
 * therefore rendered every daub panel in the settlement at one identical
 * near-white value, which is why three separate reviews described the render
 * as flat cream cardboard between the timbers. Real lime wash varies by who
 * mixed it, how much ox blood or ochre went in and how long ago it was last
 * limed: a 35% value spread with genuine hue movement from cool grey-buff
 * through to warm ochre. Nothing here is above 0xdc, because a lime-washed
 * panel taking a full golden-hour key at 0xf3 has nowhere left to go. */
const DAUB_TINTS = [
  0xd9c9ab, 0xc3ae8f, 0xdccbb2, 0xb6a086, 0xd0bb9a,
  0xa8967c, 0xcbb597, 0xbfae95, 0xdac6a4,
];
/* Weathered oak, not ebony. These were mid-browns already, but they were being
 * multiplied by a 0.30-floor baked AO and a 0.76-1.16 macro breaker on top of a
 * dark albedo sheet, and the product landed close enough to zero that every
 * timber in the village rendered as a solid black rectangle - including the
 * ones facing the key. A lit oak beam at golden hour cannot be #000. */
const BEAM_TINTS = [0xb08a63, 0x9a7351, 0xbd996f, 0x876647, 0xa47f5d];
const THATCH_TINTS = [0xe8c778, 0xd9b466, 0xf0d189, 0xcfa95c];
const SLATE_TINTS = [0x9aa2ad, 0x8b939e, 0xa7afba, 0x7f8792];
const SHUTTER_TINTS = [0x8a4b3c, 0x4f6b52, 0x3f5a78, 0x7a6132, 0x6b4a63];
const HERALD = [0xb02a33, 0x2a5aa8, 0xd7a63f, 0x2f2723, 0x2f7a4d, 0x7d3f8f];

/* ------------------------------------------------------------------ *
 * Shell vernaculars.
 *
 * One tint set per wall material, because the thing that separates five towns
 * at a glance is VALUE before it is form: Grimscar's rubble is sooted to a
 * quarter of the abbey's ashlar, and that difference survives 400 m of aerial
 * perspective where a difference of silhouette does not.
 * ------------------------------------------------------------------ */
const SHELL_WALL_TINTS = {
  // Lime render, as Aldermoor's - Fenwick is the same building culture.
  daub: DAUB_TINTS,
  // Sooted moorland stone. Grimscar burns coal, and every wall in it shows it.
  rubble: [0x6f6a63, 0x625d57, 0x7a736a, 0x585450, 0x6a635b],
  // Dressed limestone, kept pale: the abbey is the brightest thing in the
  // southern half of the map and it is meant to be findable from the rim.
  ashlar: [0xd6cfbc, 0xcfc7b2, 0xdcd6c4, 0xc9c1ad],
  // Oiled and weathered board - Reedwater's huts and Blackmarch's log walls.
  plank: [0x8a6f4c, 0x7c6242, 0x957a56, 0x6f5940, 0x8f7550],
};
const SHELL_ROOF_TINTS = {
  thatch: THATCH_TINTS,
  slate: SLATE_TINTS,
  // Split oak shingle: browner and much darker than slate, which is what
  // keeps Blackmarch reading as timber from the vale floor.
  shingle: [0x7b6448, 0x6a5540, 0x8a7152, 0x5f4d3a],
  flat: [0xb9b1a0, 0xaaa294],
};


/* ------------------------------------------------------------------ */
/* Canvas + texture helpers                                            */
/* ------------------------------------------------------------------ */

function newCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h ?? w;
  return c;
}

/** Fill a canvas from a per-pixel callback. Used at low res, then upscaled. */
function pixelCanvas(w, h, fn) {
  const c = newCanvas(w, h);
  const g = c.getContext('2d', { willReadFrequently: true });
  const img = g.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) fn(x, y, d, (y * w + x) * 4);
  }
  g.putImageData(img, 0, 0);
  return c;
}

/**
 * Async variant of {@link pixelCanvas} that yields the frame back every 64 rows
 * via `breathe`, so a million-pixel procedural paint no longer blocks the render
 * thread for the better part of a second during a background world build.
 */
async function pixelCanvasAsync(w, h, fn, breathe) {
  const c = newCanvas(w, h);
  const g = c.getContext('2d', { willReadFrequently: true });
  const img = g.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) fn(x, y, d, (y * w + x) * 4);
    if (breathe && (y & 63) === 0) await breathe();
  }
  g.putImageData(img, 0, 0);
  return c;
}

const _noiseCache = new Map();
function noiseTile(size, seed, contrast = 1) {
  const key = `${size}:${seed}:${contrast}`;
  let c = _noiseCache.get(key);
  if (c) return c;
  const rnd = mulberry32(seed);
  c = pixelCanvas(size, size, (x, y, d, i) => {
    const v = clamp01(0.5 + (rnd() - 0.5) * contrast) * 255;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  });
  _noiseCache.set(key, c);
  return c;
}

/** Tile a noise canvas over `ctx` with a blend mode - cheap surface grain. */
function grain(ctx, S, seed, alpha, mode = 'overlay', scale = 1) {
  const tile = noiseTile(64, seed, 1);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = mode;
  ctx.imageSmoothingEnabled = scale > 1;
  const step = 64 * scale;
  for (let y = 0; y < S; y += step) {
    for (let x = 0; x < S; x += step) ctx.drawImage(tile, x, y, step, step);
  }
  ctx.restore();
}

/** Soft blotches - moss, damp, weathering. */
function blotches(ctx, S, rnd, count, color, rMin, rMax, alpha) {
  ctx.save();
  for (let i = 0; i < count; i++) {
    const x = rnd() * S;
    const y = rnd() * S;
    const r = rMin + rnd() * (rMax - rMin);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color.replace('ALPHA', String(alpha)));
    g.addColorStop(1, color.replace('ALPHA', '0'));
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  ctx.restore();
}

/** Sobel a greyscale canvas into a tangent-space normal map. */
function normalFromHeight(canvas, strength = 2.2) {
  const w = canvas.width;
  const h = canvas.height;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const src = g.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const yn = ((y - 1 + h) % h) * w;
    const yp = ((y + 1) % h) * w;
    const yc = y * w;
    for (let x = 0; x < w; x++) {
      const xn = (x - 1 + w) % w;
      const xp = (x + 1) % w;
      const l = src[(yc + xn) * 4] / 255;
      const r = src[(yc + xp) * 4] / 255;
      const u = src[(yn + x) * 4] / 255;
      const d0 = src[(yp + x) * 4] / 255;
      let nx = (l - r) * strength;
      let ny = (u - d0) * strength;
      const nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const i = (yc + x) * 4;
      out[i] = (nx * inv * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * inv * 0.5 + 0.5) * 255;
      out[i + 2] = (nz * inv * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(out, w, h, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Remap a height canvas into a roughness map. */
function roughFromHeight(canvas, base, variance) {
  const w = canvas.width;
  const h = canvas.height;
  const src = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = clamp01(base + (0.5 - src[i * 4] / 255) * variance) * 255;
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(out, w, h, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Derive a cavity/ambient-occlusion map from the same height canvas that
 * feeds the normal and roughness maps.
 *
 * A box filter over the height field gives the local mean; anything sitting
 * below its neighbourhood is in a recess and gets darkened. That is exactly
 * the mortar joint, the chisel gouge and the gap between two thatch reeds -
 * the micro-contact shading whose absence makes procedural masonry read as a
 * printed swatch rather than as blocks with depth.
 */
function aoFromHeight(canvas, strength = 1.0, radius = 5) {
  const w = canvas.width;
  const h = canvas.height;
  const src = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const n = w * h;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = src[i * 4] / 255;

  // Separable box blur, wrapping so the tile stays seamless.
  const tmp = new Float32Array(n);
  const span = radius * 2 + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) s += lum[row + ((x + k + w) % w)];
      tmp[row + x] = s / span;
    }
  }
  const blur = new Float32Array(n);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) s += tmp[((y + k + h) % h) * w + x];
      blur[y * w + x] = s / span;
    }
  }

  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const cavity = clamp01(0.5 + (lum[i] - blur[i]) * 2.6);
    const v = clamp01(1 - (1 - cavity) * strength) * 255;
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(out, w, h, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Mip chain whose alpha is rescaled per level to preserve alpha-test coverage.
 *
 * This is the fix for foliage that dissolves into sparkling noise at distance.
 * A box filter drives the alpha channel toward its own mean, so a leaf sheet
 * that puts 68% of its texels above `alphaRef` at mip 0 is down to ~45% by mip
 * 4 and effectively nothing by mip 8. Against a *fixed* alphaTest that means
 * the number of surviving texels collapses as the crown mips down, and because
 * which texels survive is decided independently per pixel the crown does not
 * fade - it fizzes. Rescaling each level's alpha so the fraction of texels
 * above the reference stays equal to level 0 holds the silhouette mass
 * constant the whole way down the chain (Castano, 2010).
 *
 * RGB is averaged weighted by alpha, so the fully transparent texels between
 * leaves - which carry rgb 0 out of a cleared canvas - cannot bleed black
 * fringes into the leaf edges as the chain gets coarser.
 *
 * @param {HTMLCanvasElement} canvas source (level 0)
 * @param {number} alphaRef the alphaTest the material will use
 * @returns {ImageData[]} full chain down to 1x1, ready for `texture.mipmaps`
 */
function coverageMipmaps(canvas, alphaRef = 0.5) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const base = ctx.getImageData(0, 0, canvas.width, canvas.height);

  /** Fraction of texels that survive the alpha test at a given alpha gain. */
  const coverage = (d, gain) => {
    const ref = alphaRef * 255;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (Math.min(255, d[i] * gain) >= ref) n++;
    return n / (d.length >> 2);
  };
  const target = coverage(base.data, 1);
  const levels = [base];

  let src = base;
  while (src.width > 1 || src.height > 1) {
    const w = Math.max(1, src.width >> 1);
    const h = Math.max(1, src.height >> 1);
    const dst = new ImageData(w, h);
    const s = src.data;
    const d = dst.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let dy = 0; dy < 2; dy++) {
          const sy = Math.min(src.height - 1, y * 2 + dy);
          for (let dx = 0; dx < 2; dx++) {
            const sx = Math.min(src.width - 1, x * 2 + dx);
            const i = (sy * src.width + sx) * 4;
            const av = s[i + 3];
            r += s[i] * av;
            g += s[i + 1] * av;
            b += s[i + 2] * av;
            a += av;
          }
        }
        const o = (y * w + x) * 4;
        const inv = a > 0 ? 1 / a : 0;
        d[o] = r * inv;
        d[o + 1] = g * inv;
        d[o + 2] = b * inv;
        d[o + 3] = a * 0.25;
      }
    }
    // Bisect for the gain that restores level 0's coverage. The *unscaled*
    // level feeds the next reduction - rescaling before downsampling would
    // compound the correction and drive the deep mips fully opaque.
    let out = dst;
    if (target > 0.002 && target < 0.998) {
      let lo = 0;
      let hi = 16;
      for (let it = 0; it < 14; it++) {
        const mid = (lo + hi) * 0.5;
        if (coverage(d, mid) < target) lo = mid;
        else hi = mid;
      }
      const gain = (lo + hi) * 0.5;
      out = new ImageData(w, h);
      out.data.set(d);
      const od = out.data;
      for (let i = 3; i < od.length; i += 4) od[i] = Math.min(255, od[i] * gain);
    }
    levels.push(out);
    src = dst;
  }
  return levels;
}

/**
 * Hand the coverage-preserving chain to a texture. `generateMipmaps` has to go
 * off or the renderer regenerates the naive chain straight over the top.
 */
function applyCoverageMips(tex, canvas, alphaRef) {
  tex.mipmaps = coverageMipmaps(canvas, alphaRef);
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                    */
/* ------------------------------------------------------------------ */

/** Box with per-face UVs scaled to world size so textures never stretch. */
function boxGeo(w, h, d, tile = 0.5) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  const s = [d, h, d, h, w, d, w, d, w, h, w, h];
  for (let f = 0; f < 6; f++) {
    const su = s[f * 2] * tile;
    const sv = s[f * 2 + 1] * tile;
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, uv.getX(k) * su, uv.getY(k) * sv);
    }
  }
  return g;
}

/**
 * A box with vertical subdivision, so a wall panel can carry a baked gradient.
 *
 * `boxGeo` has exactly two rows of vertices, which means any vertex-colour
 * ramp applied to it runs the full height of the storey. Real render and
 * plaster is soiled hard in the bottom metre by rain splash off the ground and
 * clean above it, and that specific ramp is most of why an untextured panel
 * reads as painted card.
 */
function panelGeo(w, h, d, tile = 0.5, ySeg = 5) {
  const g = new THREE.BoxGeometry(w, h, d, 1, ySeg, 1);
  const uv = g.attributes.uv;
  const s = [d, h, d, h, w, d, w, d, w, h, w, h];
  let k = 0;
  for (let f = 0; f < 6; f++) {
    // BoxGeometry order is px, nx, py, ny, pz, nz; only the four side faces
    // carry the height subdivision.
    const n = f === 2 || f === 3 ? 4 : 2 * (ySeg + 1);
    const su = s[f * 2] * tile;
    const sv = s[f * 2 + 1] * tile;
    for (let i = 0; i < n; i++, k++) uv.setXY(k, uv.getX(k) * su, uv.getY(k) * sv);
  }
  return g;
}

/**
 * Bake a ground-up soiling gradient into a geometry's vertex colours.
 * Must run after `GeoBatch.add`, i.e. once the geometry is in world space.
 */
function grimeRamp(geo, baseY, rise = 1.5, floorK = 0.58) {
  const pos = geo?.attributes?.position;
  const col = geo?.attributes?.color;
  if (!pos || !col) return geo;
  for (let i = 0; i < pos.count; i++) {
    const k = lerp(floorK, 1, smoothstep(0, rise, pos.getY(i) - baseY));
    col.setXYZ(i, col.getX(i) * k, col.getY(i) * k, col.getZ(i) * k);
  }
  col.needsUpdate = true;
  return geo;
}

/** Multiply an sRGB hex by a scalar, clamped - per-instance timber variation. */
function shadeHex(hex, k) {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * k));
  const b = Math.min(255, Math.round((hex & 255) * k));
  return (r << 16) | (g << 8) | b;
}

function cylGeo(rTop, rBot, h, seg, tile = 0.5, open = false) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open);
  const uv = g.attributes.uv;
  const sideCount = (seg + 1) * 2;
  const circ = Math.PI * (rTop + rBot) * tile;
  const dia = Math.max(rTop, rBot) * 2 * tile;
  for (let i = 0; i < uv.count; i++) {
    if (i < sideCount) uv.setXY(i, uv.getX(i) * circ, uv.getY(i) * h * tile);
    else uv.setXY(i, uv.getX(i) * dia, uv.getY(i) * dia);
  }
  return g;
}

function coneGeo(r, h, seg, tile = 0.5) {
  const g = new THREE.ConeGeometry(r, h, seg, 1, false);
  const uv = g.attributes.uv;
  const sideCount = (seg + 1) * 2;
  const circ = Math.PI * r * tile;
  for (let i = 0; i < uv.count; i++) {
    if (i < sideCount) uv.setXY(i, uv.getX(i) * circ, uv.getY(i) * h * tile);
    else uv.setXY(i, uv.getX(i) * r * 2 * tile, uv.getY(i) * r * 2 * tile);
  }
  return g;
}

function planeGeo(w, h, tile = 0.5, wSeg = 1, hSeg = 1) {
  const g = new THREE.PlaneGeometry(w, h, wSeg, hSeg);
  if (tile > 0) {
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w * tile, uv.getY(i) * h * tile);
  }
  return g;
}

/** Give every batched geometry the same attribute set so merges never fail. */
function normaliseGeo(geo, hex) {
  for (const name of Object.keys(geo.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') geo.deleteAttribute(name);
  }
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const n = geo.attributes.position.count;
  if (!geo.attributes.uv) {
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  // `aoMap` samples UV channel 1. Every batched surface uses the same
  // world-scaled unwrap for both, so channel 1 is just a copy of channel 0 -
  // but it has to physically exist or the AO map degenerates to one texel.
  geo.setAttribute('uv1', new THREE.BufferAttribute(geo.attributes.uv.array.slice(), 2));
  const arr = new Float32Array(n * 3);
  _col.setHex(hex);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = _col.r;
    arr[i * 3 + 1] = _col.g;
    arr[i * 3 + 2] = _col.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  if (!geo.index) {
    const idx = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  return geo;
}

/* Hemisphere ray bundle for the vertex-AO bake, in tangent space (+Z = normal).
 * Six directions is the sweet spot: fewer and inside corners band, more and the
 * bake starts costing real load time across a hundred thousand vertices. */
const AO_DIRS = [
  [0, 0, 1],
  [0.72, 0, 0.69],
  [0.22, 0.69, 0.69],
  [-0.58, 0.43, 0.69],
  [-0.58, -0.43, 0.69],
  [0.22, -0.69, 0.69],
];
/** March distances in metres, and how much a hit at each distance counts. */
const AO_STEPS = [0.62, 1.25, 2.2, 3.6];
const AO_WEIGHTS = [1.0, 0.62, 0.36, 0.2];

/**
 * Collects geometry per material key and merges it into one mesh per key.
 * This is what keeps an entire castle inside ten draw calls.
 */
class GeoBatch {
  constructor() {
    this.map = new Map();
  }

  /**
   * @param {string} key material key
   * @param {THREE.BufferGeometry} geo consumed - do not reuse afterwards
   * @param {THREE.Object3D|THREE.Matrix4|null} xf transform, applied in place
   * @param {number} hex vertex tint multiplied over the albedo
   */
  add(key, geo, xf = null, hex = 0xffffff) {
    if (xf) {
      if (xf.isObject3D) {
        xf.updateMatrix();
        geo.applyMatrix4(xf.matrix);
      } else {
        geo.applyMatrix4(xf);
      }
    }
    normaliseGeo(geo, hex);
    let arr = this.map.get(key);
    if (!arr) this.map.set(key, (arr = []));
    arr.push(geo);
    return geo;
  }

  /**
   * Bake a coarse ambient-occlusion term into the vertex colours of everything
   * in this batch, before the merge.
   *
   * Screen-space AO cannot see what is off screen and dies at grazing angles,
   * which is precisely where a 6m curtain wall meets its own return. So the
   * batch is voxelised into a coarse occupancy grid - every geometry's world
   * bounding box, plus every cell that lies under the terrain - and each
   * vertex fires a short cosine-ish ray bundle into its own hemisphere. Wall
   * bases darken, inside corners crease, and props stop floating, all baked
   * once at build time for zero runtime cost.
   *
   * @param {(x:number,z:number)=>number} heightAt authoritative ground height
   * @param {{strength?:number, cell?:number, floor?:number}} [o]
   */
  bakeAO(heightAt, o = {}) {
    const strength = o.strength ?? 0.86;
    const floor = o.floor ?? 0.3;
    let cell = o.cell ?? 0.55;

    const geos = [];
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const arr of this.map.values()) {
      for (const g of arr) {
        if (!g.boundingBox) g.computeBoundingBox();
        const b = g.boundingBox;
        if (!b || !Number.isFinite(b.min.x)) continue;
        geos.push(g);
        if (b.min.x < minX) minX = b.min.x;
        if (b.min.y < minY) minY = b.min.y;
        if (b.min.z < minZ) minZ = b.min.z;
        if (b.max.x > maxX) maxX = b.max.x;
        if (b.max.y > maxY) maxY = b.max.y;
        if (b.max.z > maxZ) maxZ = b.max.z;
      }
    }
    if (!geos.length) return;

    // Pad for the ground fill below the lowest geometry, then pick a cell size
    // that keeps the grid inside a sane memory budget for very tall districts.
    minX -= 3; minZ -= 3; maxX += 3; maxZ += 3;
    minY -= 4; maxY += 2;
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    const spanZ = maxZ - minZ;
    const MAX_CELLS = 5e6;
    for (let i = 0; i < 8; i++) {
      const c = Math.ceil(spanX / cell) * Math.ceil(spanY / cell) * Math.ceil(spanZ / cell);
      if (c <= MAX_CELLS) break;
      cell *= 1.35;
    }
    const nx = Math.max(1, Math.ceil(spanX / cell));
    const ny = Math.max(1, Math.ceil(spanY / cell));
    const nz = Math.max(1, Math.ceil(spanZ / cell));
    const grid = new Uint8Array(nx * ny * nz);
    const strideZ = nx;
    const strideY = nx * nz;

    // Ground: fill every cell whose centre is under the heightfield.
    for (let iz = 0; iz < nz; iz++) {
      const wz = minZ + (iz + 0.5) * cell;
      for (let ix = 0; ix < nx; ix++) {
        const gy = heightAt(minX + (ix + 0.5) * cell, wz);
        const top = Math.min(ny, Math.ceil((gy - minY) / cell - 0.5));
        for (let iy = 0; iy < top; iy++) grid[iy * strideY + iz * strideZ + ix] = 1;
      }
    }

    // Solids: rasterise bounding boxes, marking only cells whose *centre* is
    // inside. Marking overlap instead would inflate every box by a cell and
    // every flat wall would then occlude itself.
    for (const g of geos) {
      const b = g.boundingBox;
      const x0 = Math.max(0, Math.ceil((b.min.x - minX) / cell - 0.5));
      const x1 = Math.min(nx - 1, Math.floor((b.max.x - minX) / cell - 0.5));
      const y0 = Math.max(0, Math.ceil((b.min.y - minY) / cell - 0.5));
      const y1 = Math.min(ny - 1, Math.floor((b.max.y - minY) / cell - 0.5));
      const z0 = Math.max(0, Math.ceil((b.min.z - minZ) / cell - 0.5));
      const z1 = Math.min(nz - 1, Math.floor((b.max.z - minZ) / cell - 0.5));
      for (let iy = y0; iy <= y1; iy++) {
        const oy = iy * strideY;
        for (let iz = z0; iz <= z1; iz++) {
          const oz = oy + iz * strideZ;
          for (let ix = x0; ix <= x1; ix++) grid[oz + ix] = 1;
        }
      }
    }

    const solid = (x, y, z) => {
      const ix = ((x - minX) / cell) | 0;
      if (ix < 0 || ix >= nx) return 0;
      const iy = ((y - minY) / cell) | 0;
      if (iy < 0 || iy >= ny) return 0;
      const iz = ((z - minZ) / cell) | 0;
      if (iz < 0 || iz >= nz) return 0;
      return grid[iy * strideY + iz * strideZ + ix];
    };

    const D = AO_DIRS;
    const S = AO_STEPS;
    const W = AO_WEIGHTS;
    let wSum = 0;
    for (let s = 0; s < S.length; s++) wSum += W[s];
    const norm = 1 / (D.length * wSum);

    for (const g of geos) {
      const pos = g.attributes.position;
      const nrm = g.attributes.normal;
      const col = g.attributes.color;
      if (!pos || !nrm || !col) continue;
      for (let i = 0; i < pos.count; i++) {
        const nxv = nrm.getX(i);
        const nyv = nrm.getY(i);
        const nzv = nrm.getZ(i);
        // Tangent frame around the vertex normal.
        let ax = 0, ay = 1, az = 0;
        if (Math.abs(nyv) > 0.9) { ax = 1; ay = 0; }
        let tx = ay * nzv - az * nyv;
        let ty = az * nxv - ax * nzv;
        let tz = ax * nyv - ay * nxv;
        const tl = Math.hypot(tx, ty, tz) || 1;
        tx /= tl; ty /= tl; tz /= tl;
        const bx = nyv * tz - nzv * ty;
        const by = nzv * tx - nxv * tz;
        const bz = nxv * ty - nyv * tx;

        const ox = pos.getX(i) + nxv * 0.14;
        const oy = pos.getY(i) + nyv * 0.14;
        const oz = pos.getZ(i) + nzv * 0.14;

        let hits = 0;
        for (let d = 0; d < D.length; d++) {
          const dd = D[d];
          const dx = tx * dd[0] + bx * dd[1] + nxv * dd[2];
          const dy = ty * dd[0] + by * dd[1] + nyv * dd[2];
          const dz = tz * dd[0] + bz * dd[1] + nzv * dd[2];
          for (let s = 0; s < S.length; s++) {
            const t = S[s];
            if (solid(ox + dx * t, oy + dy * t, oz + dz * t)) {
              hits += W[s];
              break;
            }
          }
        }
        const ao = Math.max(floor, 1 - strength * hits * norm);
        col.setXYZ(i, col.getX(i) * ao, col.getY(i) * ao, col.getZ(i) * ao);
      }
      col.needsUpdate = true;
    }
  }

  /** Merge and parent. Returns the created meshes. */
  build(mats, parent, opts = {}) {
    if (opts.ao) this.bakeAO(opts.ao, opts.aoOpts);
    const out = [];
    for (const [key, arr] of this.map) {
      const mat = mats[key];
      if (!mat || arr.length === 0) continue;
      let merged;
      if (arr.length === 1) merged = arr[0];
      else {
        merged = mergeGeometries(arr, false);
        for (const g of arr) g.dispose();
      }
      if (!merged) {
        console.warn(`[MedievalWorld] geometry merge failed for "${key}"`);
        continue;
      }
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = `medieval:${key}`;
      mesh.castShadow = opts.cast ?? true;
      mesh.receiveShadow = opts.receive ?? true;
      parent.add(mesh);
      out.push(mesh);
    }
    this.map.clear();
    return out;
  }
}

function yieldFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

/* ================================================================== */

export class MedievalWorld extends World {
  static id = 'medieval';
  static displayName = 'Aldermoor Vale';

  constructor(ctx) {
    super(ctx);

    /** One shared time uniform object, referenced by every animated shader. */
    this._timeU = { value: 0 };
    /** Sun direction in view space; refreshed once per frame for foliage wrap. */
    this._sunViewU = { value: new THREE.Vector3(0, 1, 0) };
    /** Ground-contact shadow discs collected while props are placed. */
    this._contacts = [];
    /** Additive light-spill cards collected while practicals are placed. */
    this._glows = [];
    /** Paved aprons, so vegetation does not grow through a cobbled yard. */
    this._pavedRects = [];
    /** Bound heightfield sampler handed to the AO baker. */
    this._heightFn = (x, z) => this._height(x, z);
    this._tex = {};
    this._mats = {};
    /** Anything holding GPU memory that dispose() must release. */
    this._owned = [];
    this._wheel = null;
    this._sails = null;
    this._birds = null;
    this._birdState = null;
    this._birdScale = null;
    /** Building footprints, so vegetation never grows through a wall. */
    this._footprints = [];
    /** Flattened road polylines for distance queries and the minimap. */
    this._roadSegs = [];
    /* Broadphase indexes over the three lists above, built on demand and
     * invalidated by identity + length. See `_roadGrid` / `_footprintGrid` /
     * `_pavedGrid`. */
    this._roadGridCache = null;
    this._footprintGridCache = null;
    this._pavedGridCache = null;
    /**
     * Distance metric handed to `GridIndex.nearest` for roads.
     *
     * Bound once here rather than created per call: `_roadDist` is asked
     * hundreds of thousands of times per build, and a fresh closure per call
     * is pure garbage.
     * @param {number} i index into `_roadSegs` @param {number} x @param {number} z
     */
    this._segDist = (i, x, z) => {
      const s = this._roadSegs;
      return segmentDistance(x, z, s[i], s[i + 1], s[i + 2], s[i + 3], s[i + 4] * 0.5);
    };
    /** Flat [x,y,z,...] chimney positions feeding the smoke particle system. */
    this._smokeOrigins = [];
    /**
     * Distance LOD for the foliage. Registered during `_buildNature` and
     * ticked from `update`, which only runs while this world is active.
     */
    this._lod = new DistanceLod();
    this._rnd = mulberry32(0xa1de3b00);

    /* ---------------------------------------------------------------- *
     * Colour script.
     *
     * The whole point of golden hour is the *split*: a warm key against a
     * cool complementary fill. Keying, filling and ambient-ing in the same
     * orange collapses every plane into one value ramp and the geometry
     * stops reading as mass. So: sun stays amber, everything indirect goes
     * dusk-blue, and the creative grade splits shadows cool / highlights
     * warm rather than pushing a global warm bias that would undo it.
     *
     * Exposure and bloom are deliberately conservative. The previous
     * threshold sat below the tonemapped luminance of lit plaster, so
     * non-emissive walls bloomed and the sun ate the centre of frame.
     * ---------------------------------------------------------------- */
    const env = this.environment;
    env.background = MedievalWorld._hazeColor();
    /* Aerial perspective.
     *
     * The keep stands ~110m from the village approach. At fogNear 90 / fogFar
     * 640 that is a 3.6% atmospheric mix, so the hero asset sat at exactly the
     * same value and contrast as a roof ten metres from the lens and the whole
     * depth cascade collapsed - the castle read as a sticker on the sky. A
     * 55/330 ramp puts ~20% haze on the keep, ~50% on the far ridge and
     * saturates the 400m skirt, which is what actually builds depth planes.
     *
     * The colour is taken off the sky's own horizon rather than authored
     * separately: a neutral grey fog against a mauve-peach horizon is the other
     * half of why the castle never separated. */
    env.fogColor = MedievalWorld._hazeColor();
    // 55/330 was putting ~20% haze on a roof forty metres away and saturating
    // everything past 300, which is not aerial perspective - it is a white
    // curtain. The village, the keep and the ridge line all landed inside one
    // narrow value band. 96/560 fixed that for a 400m vale and then became the
    // same mistake one extent later; see `FOG_NEAR` / `FOG_FAR` above for the
    // 900m retune and the arithmetic behind both numbers.
    env.fogNear = FOG_NEAR;
    env.fogFar = FOG_FAR;
    env.exposure = 0.95;
    env.ambientColor = new THREE.Color(0x415e91);
    /* Key-to-fill ratio.
     *
     * This is the single biggest reason the world read as flat. Ambient 0.86 +
     * hemi 0.95 + env 1.15 against a 2.55 key is roughly a 1.4:1 lighting
     * ratio - overcast, not golden hour - so no surface anywhere in the frame
     * could show a real terminator and every plane sat at the same value. A
     * low late sun is closer to 8:1. The fill is cut hard and the key raised to
     * compensate; the cool ambient/hemi that survives is doing the one job it
     * should, which is keeping shadow-side detail off the floor rather than
     * competing with the sun.
     *
     * Round 4 correction: 0.48/0.62 was so far the other way that every
     * shadow-side plane in the world crushed to literal zero. A 110m curtain
     * wall lit only by a key it is turned away from has *no* signal left, which
     * is exactly why three separate reviews described the keep as a black
     * cut-out. 0.62/0.82 still leaves a ~6:1 ratio - firmly golden hour - but
     * keeps albedo in the shadow instead of a hole.
     */
    env.ambientIntensity = 0.62;
    env.skyColor = new THREE.Color(0x7295cc);
    env.groundColor = new THREE.Color(0x7d6543);
    env.hemiIntensity = 0.82;
    env.sunColor = new THREE.Color(0xffbf72);
    env.sunIntensity = 3.70;
    /* ~18 degrees of elevation, and swung to rake the hero axes.
     *
     * Elevation first: shadows now run ~3x the height of whatever casts them,
     * which is what models the roofscape and the hills. At the old 28 degrees
     * they were short enough that the terrain had no form at all.
     *
     * Azimuth matters just as much and was wrong. Nearly every authored
     * sightline in this world runs toward -X/-Z (square -> market, market ->
     * castle, the castle approach), and the sun sat at -X/-Z too - so the hero
     * framings were all dead-on backlit and the castle was a flat black
     * cut-out with no modelling anywhere on it.
     *
     * Round 4: +X/-Z was still wrong, and the geometry says why. Every hero
     * vantage stands *south-east* of its subject - the castle approach at
     * (-40,55) looks north-west at a keep at (-72,-58), the market axis looks
     * north-west at the smithy row. The only faces those cameras can see are
     * the south (+Z) and east (+X) elevations. A sun at -Z lights the *north*
     * elevation, which is behind the subject in every single framing, and the
     * east face it does light is edge-on to the lens - a few pixels wide. So
     * the castle rendered exactly as the reviews described: correct lighting
     * intent, landing on faces nobody can see.
     *
     * The sun now sits east-south-east at ~17 degrees. The east curtain takes
     * a near-full key (n.l = 0.88), the south curtain a hard rake (0.42), and
     * the west and north go to fill only - a lit plane, a shading plane and a
     * terminator down the corner, which is the whole job. The dusk sky the
     * keep silhouettes against is then the *anti-sun* half of the dome, so the
     * masonry reads brighter than the sky behind it rather than dissolving
     * into it, and the long shadows still rake across frame. */
    env.sunDirection = new THREE.Vector3(0.876, 0.305, 0.418).normalize();
    /* Sky-side fill. Not a hack: at dusk the ~180 degrees of sky opposite the
     * sun is still a large, bright, cool source, and it is the only thing that
     * separates two shadow-side masonry planes from each other. */
    env.envMapIntensity = 1.00;
    env.bloom = { strength: 0.30, radius: 0.62, threshold: 1.15 };
    env.ao = 1.05;
    env.grade = {
      // PostFX's medieval preset owns bloom once it matches on world id, so
      // the override has to travel inside `grade` to actually land.
      /* Threshold, not strength, was the bug. This world's p90 lit luminance
       * is ~0.18 and its peak ~1.17, so a 2.35 high-pass sat above *everything*
       * in the scene: a village of twenty-six lit windows could not produce a
       * single blooming pixel. 0.95 clears sunlit thatch and plaster but sits
       * below the window emissive (raised to ~1.30 linear), so practicals glow
       * and nothing else does. */
      bloom: { strength: 0.30, radius: 0.62, threshold: 1.15 },
      ao: 1.05,
      contrast: 1.17,
      saturation: 1.14,
      warmth: 0.04,
      vignette: 0.30,
      // A pedestal an order of magnitude smaller than the 0.030-0.052 milk
      // filter it replaced - but 0.004 overshot the other way and crushed the
      // bottom quarter of the range flat, which is the second half of why
      // shadow-side masonry had no separation. 0.013 is a printer's black.
      lift: [0.013, 0.015, 0.024],
      shadowTint: [0.72, 0.86, 1.24],
      highlightTint: [1.14, 1.00, 0.80],
      haze: 0.010,
      hazeColor: [0.26, 0.22, 0.24],
      shafts: 0.40,
      shaftThreshold: 2.2,
    };

    /* ---------------------------------------------------------------- *
     * Authored sightlines.
     *
     * Scatter placement has no idea where the hero vantages are, so a bale or
     * a bush lands 1.5m from the lens and eats half the frame. Every corridor
     * below is a composed view axis through the settlement; nothing scattered
     * is allowed inside one, and nothing at all is allowed inside the clear
     * radius at the standing end of it.
     * ---------------------------------------------------------------- */
    this._heroSightlines = [
      { ax: 58, az: 48, bx: 28, bz: 12, hw: 3.6 },      // square -> market
      { ax: 20, az: 40, bx: 38, bz: 12, hw: 3.2 },      // street -> market
      { ax: -40, az: 55, bx: -62, bz: -22, hw: 4.6 },   // castle approach
      { ax: -72, az: 16, bx: -72, bz: -40, hw: 4.2 },   // castle gate
      { ax: 2, az: 8, bx: 2, bz: -22, hw: 3.6 },        // gate circle
      { ax: 34, az: 18, bx: -40, bz: -30, hw: 4.0 },    // market -> castle
    ];
    /* [x, z, radius] - no prop, tree or bush may stand this close to a lens.
     *
     * Round 5: these were 9-12m, and that is why the composed square framing
     * came back as "55% of the frame is a featureless olive ground plane".
     * An eleven-metre exclusion sphere around a camera pitched at the horizon
     * evacuates the entire lower half of the image - the guard against a bush
     * eating the lens had become a guard against there being any foreground at
     * all. A 3.5-5m radius still keeps a tree trunk or a hay bale off the film
     * plane while leaving the 5-25m band, which is where set dressing actually
     * builds depth, open for business. */
    this._heroEyes = [
      [58, 48, 4.5], [20, 40, 4.0], [-40, 55, 4.5], [-72, 16, 5],
      [2, 8, 4], [120, 118, 8], [34, 18, 4],
    ];

    this.bounds = new THREE.Box3(
      new THREE.Vector3(-HALF, -10, -HALF),
      new THREE.Vector3(HALF, 60, HALF)
    );

    this.playerSpawn.set(CIRCLE.x + 12, 0, CIRCLE.z + 7);
    this.playerSpawn.y = this._height(this.playerSpawn.x, this.playerSpawn.z) + 0.3;
    this.playerSpawnYaw = 145 * DEG;
  }

  /* ---------------------------------------------------------------- */
  /* Build                                                             */
  /* ---------------------------------------------------------------- */

  /** @param {(p:number,label:string)=>void} [onProgress] */
  /**
   * Cooperative yield used inside the heavy generators. It only actually gives
   * the frame back when more than `budgetMs` of synchronous work has piled up
   * since the last yield, so a hot loop can call it every iteration without
   * paying a whole rAF per call. This is what keeps the background build from
   * blocking the render thread for seconds at a time - the single ~8s
   * `_buildNature` frame becomes a run of ~6ms slices with the station still
   * rendering between them.
   * @param {number} [budgetMs]
   */
  async _breathe(budgetMs = 6) {
    const now = performance.now();
    if (now - (this._lastBreath || 0) > budgetMs) {
      await yieldFrame();
      this._lastBreath = performance.now();
    }
  }

  async build(onProgress) {
    this._lastBreath = performance.now();
    const step = async (p, label, fn) => {
      onProgress?.(p, label);
      await yieldFrame();
      this._lastBreath = performance.now();
      await fn.call(this);
    };

    /* The authored beast features, started FIRST and awaited LAST.
     *
     * They are needed by `BeastBody`, which is constructed by
     * `NPCManager.spawnForWorld` at activation - after this whole method has
     * returned - so anything that resolves before the last line is early
     * enough. Kicking the fetch off here rather than awaiting it in place lets
     * two files and a lazily-imported glTF parser download across the fifteen
     * seconds of world generation that follow instead of in front of them.
     *
     * `loadBeastAssets` never rejects: a 404 resolves to an empty map and
     * every wolf in the vale is the procedural one, which is exactly what
     * `node --test` builds and what a player on a bad connection gets. So this
     * needs no `catch` and can never fail a boot. */
    const beastAssets = loadBeastAssets();

    await step(0.02, 'Mixing pigments', this._buildTextures);
    await step(0.18, 'Tempering materials', this._buildMaterials);
    await step(0.26, 'Raising the vale', this._buildTerrain);
    await step(0.4, 'Kindling the evening sky', this._buildSky);
    await step(0.47, 'Letting the river run', this._buildWater);
    await step(0.52, 'Laying cobbles', this._buildRoads);
    await step(0.58, 'Building Aldermoor Keep', this._buildCastle);
    await step(0.7, 'Thatching the village', this._buildVillage);
    await step(0.78, 'Spanning the Aldern', this._buildRiverside);
    await step(0.82, 'Setting out the market', this._buildMarket);
    await step(0.86, 'Raising the ring towns', this._buildTowns);
    await step(0.9, 'Striking camp on the far bank', this._buildCamps);
    await step(0.94, 'Sowing the woods', this._buildNature);
    await step(0.97, 'Lighting the hearths', this._buildAtmosphere);
    await step(0.99, 'Opening the sky-gate', this._buildGateAndSpawns);
    await beastAssets;
    onProgress?.(1, 'Aldermoor Vale');
  }

  /* ---------------------------------------------------------------- */
  /* Heightfield                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Authoritative ground height. The terrain mesh, collision chunks, macro
   * texture and every prop placement read this, so they cannot disagree.
   * @returns {number} world Y in metres
   */
  _height(x, z) {
    return medievalHeight(x, z);
  }

  /**
   * Ground height on the distant skirt - the polar continuation beyond the
   * playfield that turns into foothills. Shared by the skirt mesh and by the
   * ridge tree stands, so the two can never disagree about where the hills are.
   *
   * Both ramps below are multiples of `HALF` rather than the metres they used
   * to be, and the multiples are the part that carries the reasoning:
   *
   *   - The near/far blend must be COMPLETE beyond the playfield's corner
   *     radius, `HALF * sqrt(2)` = 1.414 HALF, or the corners of the square
   *     would still be reading a half-blended height and would step against
   *     the terrain mesh. 1.6 HALF clears it with room to spare.
   *   - It must START at or before the rim, because past `HALF` along an axis
   *     the skirt is the visible surface. `HALF - 5` is inside the square, so
   *     the blend is already under way while it is still hidden.
   */
  _outerHeight(x, z) {
    const rad = Math.hypot(x, z);
    const hNear = this._height(x, z);
    const hFar =
      6.0 +
      fbm2(x * 0.0038, z * 0.0038, 4) * 11 +
      Math.max(0, fbm2(x * 0.0011, z * 0.0011, 4)) * 240 * smoothstep(HALF, HALF * 2.15, rad);
    /* Seam drop.
     *
     * The skirt is a polar sheet starting at `SKIRT_INNER`, so its inner rows
     * sit *under* the square playfield and have to be pushed down to stay
     * hidden. The drop has to be tiny, though: viewed from the ramparts the
     * playfield edge is hundreds of metres away at a ~6 degree grazing angle,
     * so every centimetre of
     * step occludes ten centimetres of ground behind it. The old 16cm drop hid
     * a metre-wide band and drew a continuous dark hairline straight across the
     * horizon in every elevated framing. 2.5cm hides about a pixel. The skirt's
     * angular resolution is raised to match, so its chords track the terrain
     * closely enough that this much clearance is still enough to bury them,
     * and its material carries a polygon offset as insurance. */
    return lerp(hNear, hFar, smoothstep(HALF - 5, HALF * 1.6, rad)) - 0.025;
  }

  /** Terrain steepness at a point: 0 = flat, 1 = cliff. */
  _slope(x, z) {
    const d = 2.5;
    const hx = this._height(x + d, z) - this._height(x - d, z);
    const hz = this._height(x, z + d) - this._height(x, z - d);
    return clamp01((Math.hypot(hx, hz) / (2 * d)) * 1.15);
  }

  /* ---------------------------------------------------------------- *
   * Spatial indexes.
   *
   * `_roadDist`, `_inFootprint`, `_isPaved` and `_isOpenGround` are asked once
   * per scatter candidate - roughly a million times across a build - and each
   * used to walk its whole feature list. That is O(candidates x features), and
   * both halves scale with world area, so a 5x wider vale did ~25x the work.
   *
   * Each index is built lazily from the array it mirrors and is invalidated by
   * that array's identity and length. `_footprints` in particular is APPENDED
   * to all through the build, interleaved with queries from the dressing
   * passes, so it is topped up incrementally rather than rebuilt: a rebuild
   * per push would put the quadratic straight back.
   * ---------------------------------------------------------------- */

  /** @returns {GridIndex} road segments, keyed by index into `_roadSegs`. */
  _roadGrid() {
    const segs = this._roadSegs;
    let c = this._roadGridCache;
    if (c && c.src === segs && c.n === segs.length) return c.grid;
    /* 24m cells.
     *
     * Measured, not chosen. The grass scatter asks `_roadDist` well over a
     * million times uniformly across 900x900m while the roads occupy a
     * 150x230m patch, so almost every probe is far from every road and the
     * cost is dominated by how quickly the ring bound closes - which is
     * `k * cellSize`, i.e. coarser cells close sooner. Against the authored
     * network over 400,000 uniform probes: 8m cells 522ms, 16m 289ms, 24m
     * 236ms, 32m 245ms, 48m 293ms, 64m 352ms, and the linear scan 297ms.
     * The curve is flat between 24 and 32; 8m is worse than doing nothing. */
    const grid = new GridIndex(24);
    for (let i = 0; i < segs.length; i += 5) {
      /* Inflated by the road's own half-width, because that is what the
       * metric subtracts. See the contract at the top of `GridIndex`. */
      const hw = segs[i + 4] * 0.5;
      const ax = segs[i];
      const az = segs[i + 1];
      const bx = segs[i + 2];
      const bz = segs[i + 3];
      grid.insert(
        i,
        Math.min(ax, bx) - hw, Math.min(az, bz) - hw,
        Math.max(ax, bx) + hw, Math.max(az, bz) + hw
      );
    }
    this._roadGridCache = { src: segs, n: segs.length, grid };
    return grid;
  }

  /** @returns {GridIndex} building footprints, keyed by index into `_footprints`. */
  _footprintGrid() {
    const fps = this._footprints;
    let c = this._footprintGridCache;
    if (!c || c.src !== fps) {
      c = { src: fps, n: 0, grid: new GridIndex(12) };
      this._footprintGridCache = c;
    }
    for (; c.n < fps.length; c.n++) {
      const f = fps[c.n];
      /* A rotated rectangle's world AABB. `margin` is applied by the query,
       * not here, because it differs per call site - so the box stored is the
       * un-margined one and the query box carries the slack instead. */
      const ca = Math.abs(Math.cos(f.r));
      const sa = Math.abs(Math.sin(f.r));
      const hx = f.hx * ca + f.hz * sa;
      const hz = f.hx * sa + f.hz * ca;
      c.grid.insert(c.n, f.x - hx, f.z - hz, f.x + hx, f.z + hz);
    }
    return c.grid;
  }

  /** @returns {GridIndex} paved yards, keyed by index into `_pavedRects`. */
  _pavedGrid() {
    const rects = this._pavedRects;
    let c = this._pavedGridCache;
    if (c && c.src === rects && c.n === rects.length) return c.grid;
    const grid = new GridIndex(8);
    for (let i = 0; i < rects.length; i++) {
      const p = rects[i];
      const ca = Math.abs(Math.cos(p.r));
      const sa = Math.abs(Math.sin(p.r));
      const hx = p.hx * ca + p.hz * sa;
      const hz = p.hx * sa + p.hz * ca;
      grid.insert(i, p.x - hx, p.z - hz, p.x + hx, p.z + hz);
    }
    this._pavedGridCache = { src: rects, n: rects.length, grid };
    return grid;
  }

  /**
   * Shortest distance from a point to any cobbled road edge.
   *
   * Exact - see the proof in `GridIndex.nearest`. It is not a "near enough"
   * answer with a cut-off, because every caller compares it against a
   * different threshold and one of them would eventually be past the cut-off.
   */
  _roadDist(x, z) {
    const segs = this._roadSegs;
    if (!segs.length) return 1e9;
    const d = this._roadGrid().nearest(x, z, this._segDist);
    return d === Infinity ? 1e9 : d;
  }

  /**
   * True when a point falls inside an authored view corridor or inside the
   * clear radius around a hero vantage.
   *
   * Anything that can occlude - barrels, bales, bushes, trees, rocks - asks
   * this before it is placed. Without it the placement RNG is free to park a
   * 1.1m hay bale 1.6m from a composed camera, which is exactly what happened.
   */
  _inHeroClear(x, z, pad = 0) {
    const eyes = this._heroEyes;
    for (let i = 0; i < eyes.length; i++) {
      const dx = x - eyes[i][0];
      const dz = z - eyes[i][1];
      const r = eyes[i][2] + pad;
      if (dx * dx + dz * dz < r * r) return true;
    }
    const lines = this._heroSightlines;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const ex = l.bx - l.ax;
      const ez = l.bz - l.az;
      const len = ex * ex + ez * ez;
      let t = len > 1e-6 ? ((x - l.ax) * ex + (z - l.az) * ez) / len : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - (l.ax + ex * t);
      const dz = z - (l.az + ez * t);
      const hw = l.hw + pad;
      if (dx * dx + dz * dz < hw * hw) return true;
    }
    return false;
  }

  /** True when a point lies inside a registered building footprint. */
  _inFootprint(x, z, margin = 0) {
    const fps = this._footprints;
    if (!fps.length) return false;
    /* A negative margin shrinks the test; the query box must not shrink with
     * it or it would start missing footprints it should have considered. And a
     * POSITIVE margin inflates the rect in its OWN rotated frame, which grows
     * its world-space box by up to `margin * sqrt(2)` - inflating the query by
     * `margin` alone would miss the corner of a rect standing at 45 degrees. */
    const m = margin > 0 ? margin * Math.SQRT2 : 0;
    const hits = this._footprintGrid().query(x - m, z - m, x + m, z + m);
    for (let i = 0; i < hits.length; i++) {
      const f = fps[hits[i]];
      const dx = x - f.x;
      const dz = z - f.z;
      const c = Math.cos(-f.r);
      const s = Math.sin(-f.r);
      if (rectDist(dx * c - dz * s, dx * s + dz * c, f.hx + margin, f.hz + margin) < 0) return true;
    }
    return false;
  }

  /**
   * True when (x,z) lies inside the playable square with `inset` metres to
   * spare.
   *
   * `this.bounds` is the published playable area and the terrain mesh, the
   * collision grid and the macro texture all stop at exactly +/-HALF. Every
   * scatter pass in this file has to ask this before it commits an instance:
   * a sample that clears the woodland mask, the slope test and the road test
   * and still lands at x = 206 is a prop standing on nothing, which is the
   * single most obvious defect a landscape can have.
   *
   * The inset exists because a sample is a *centre*: a tree half a metre
   * inside the rim has four metres of canopy hanging over it.
   */
  _inPlayfield(x, z, inset = 0) {
    const lim = HALF - inset;
    return x > -lim && x < lim && z > -lim && z < lim;
  }

  /** True when a point is clear of buildings, roads, water and the castle. */
  _isOpenGround(x, z, margin = 0) {
    // Everything downstream of this asks about roads, footprints and water and
    // then trusts the answer. Ground existing at all comes first.
    if (!this._inPlayfield(x, z, 2 + Math.max(0, margin))) return false;
    if (this._height(x, z) < WATER_Y + 0.5) return false;
    if (rectDist(x - CASTLE.x, z - CASTLE.z, CASTLE.hx, CASTLE.hz) < 22) return false;
    /* Was the literal 11.5 - "the 9.5 m channel plus two". The channel is no
     * longer 9.5 m: it runs from 6 m at the fords to 26 m at Reedwater, and a
     * fixed 11.5 would have let every scatter pass put hay bales, bushes and
     * rocks in the middle of the pool. */
    if (Math.abs(z - riverZ(x)) < riverHalfWidth(x) + 2) return false;
    if (rectDist(x - MARKET.x, z - MARKET.z, MARKET.hx, MARKET.hz) < 2) return false;
    if (this._roadDist(x, z) < 2.2 + margin) return false;
    // Was an inlined copy of `_inFootprint`, character for character. Two
    // copies of a containment test is two things to index, and the day one of
    // them gained a margin the other did not, vegetation would grow through a
    // wall in half the passes and not the other half.
    if (this._inFootprint(x, z, margin)) return false;
    return true;
  }

  /**
   * True where something can GROW: open ground that no settlement has beaten.
   *
   * `_isOpenGround` is the wrong gate for vegetation and always was. It knows
   * about roads, footprints, the river, the castle rect and the market rect,
   * which was a complete description of the vale when there was one village in
   * it - and it has no way at all to be told that St Ceolwine's precinct, or
   * Grimscar's bench, or Fenwick's market place exists. The result was eleven
   * oaks inside the abbey wall, two of them in the cloister garth, and forty
   * leaf sheets across the one view the garth is composed around.
   *
   * The distinction this draws is between things that are PUT somewhere and
   * things that grow there, which is why it is a second predicate rather than
   * a line added to the first: a barrel in a market square is right, and a
   * thicket in one is not. Trees, understorey, deadfall and bushes ask this;
   * the market dressing keeps asking `_isOpenGround`.
   */
  _isPlantable(x, z, margin = 0) {
    if (!this._isOpenGround(x, z, margin)) return false;
    return !inSettlementCore(x, z);
  }

  /* ---------------------------------------------------------------- */
  /* Collision helpers                                                 */
  /* ---------------------------------------------------------------- */

  _box(cx, cy, cz, hx, hy, hz) {
    return this.track(this.physics.addBox(cx, cy, cz, hx, hy, hz, {}));
  }

  _rbox(cx, cy, cz, hx, hy, hz, rotY) {
    return this.track(
      this.physics.addRotatedBox(_v1.set(cx, cy, cz), _v2.set(hx, hy, hz), rotY, {})
    );
  }

  /**
   * Lay the ground up to a doorway, in courses a player can walk.
   *
   * ── The defect this exists for ─────────────────────────────────────────
   * A shell sets its base to the HIGHEST corner of its own footprint so that
   * no corner floats, and drops a plinth to below the lowest. That is right,
   * and it means the door - which is on one FACE, not on a corner - can be
   * left an arbitrary distance above the ground outside it. `_shell` laid one
   * 20 cm threshold stone and stopped, so fifteen of the fifty-four enterable
   * buildings could not be entered at all: the winding house's sill stood
   * 2.03 m over the street, which is not a step, it is a wall, and the door
   * prompt never even appeared.
   *
   * ── Why courses and not a ramp ─────────────────────────────────────────
   * The player's step-up probe (`Player._move`) lifts the capsule by
   * `stepHeight`, retries the same horizontal motion, and raycasts for a
   * tread. It has no concept of a slope it can walk up that a box cannot
   * provide, so a wedge buys nothing a stack of boxes does not - and boxes are
   * what the collider set is made of anyway.
   *
   * ── Why the courses FLARE ──────────────────────────────────────────────
   * A straight flight is climbable from directly in front and is a 2 m cheek
   * from anywhere else, and the eleven buildings in the 0.30-0.45 m "marginal"
   * band failed for exactly that reason: the probe casts along the direction
   * of travel, so a diagonal approach lengthens the horizontal run without
   * shortening the rise. Each course here is `RUN` wider on each side and
   * `RUN` deeper than the one above it, so the courses are NESTED rectangles -
   * and a straight line from anywhere outside to the doorway crosses each
   * boundary exactly once, whatever its bearing. One boundary, one riser.
   *
   * ── Why the count is measured and not authored ─────────────────────────
   * `_house` had steps and they were capped at six with a rise derived from
   * the drop, so a 2.6 m drop silently produced 0.44 m risers - inside the
   * limit by a centimetre, and past it the moment the ground under the bottom
   * step was 2 cm lower than the sample that sized it. Here the courses are
   * added until the outermost one is within one riser of the LOWEST ground
   * anywhere on its own perimeter, so the flight follows the hill instead of
   * assuming it.
   *
   * @param {GeoBatch} B
   * @param {{M:THREE.Matrix4, yaw:number, hd:number, baseY:number,
   *          sill:number, doorW:number, tint?:number}} o
   *   `M` places the building; `sill` and everything else are in its own frame,
   *   with the door on +Z, exactly as `_house` and `_shell` build.
   * @returns {number} courses laid, the outermost included
   */
  _entrySteps(B, o) {
    const { M, yaw, hd, baseY, sill, doorW } = o;
    const tint = o.tint ?? 0x8e8371;
    /** Riser. 0.30 against a 0.45 step height: a third of the budget in hand. */
    const RISE = 0.30;
    /** Going. */
    const RUN = 0.62;
    /**
     * How much wider each course is than the one above it, per side.
     *
     * Any positive number makes the courses nest, which is all the "climbable
     * from any bearing" argument needs, and the number is bounded from BOTH
     * sides. Not smaller, because the flare is the side tread and a tread
     * narrower than the capsule means two risers under one foot: 0.31 m against
     * a 0.30 m riser is the same ratio the interior stairs already use, so the
     * capsule takes the cheeks one course at a time. Not larger, because the
     * flare is also what sets the flight's WIDTH, and the alehouse at Grimscar
     * needs ten courses - flared by a full going that is a 13 m stepped terrace
     * across a 10 m frontage, which reads as a monument and not as a doorstep.
     */
    const FLARE = RUN / 2;
    /** Twelve courses is 7.4 m of steps and 3.6 m of descent. Past that the
     *  building is on a cliff and the answer is to move the building. */
    const MAX = 12;
    const inner = hd - 0.05;
    const halfW = (i) => doorW / 2 + 0.62 + i * FLARE;
    const outerZ = (i) => hd + 0.24 + i * RUN;
    /** Lowest ground anywhere a walker could step onto course `i` from. */
    const perimeter = (i) => {
      const hx = halfW(i) + 0.14;
      const zo = outerZ(i) + 0.14;
      let lo = Infinity;
      for (let k = 0; k <= 6; k++) {
        _v1.set((k / 6 - 0.5) * 2 * hx, 0, zo).applyMatrix4(M);
        const h = this._height(_v1.x, _v1.z);
        if (h < lo) lo = h;
      }
      for (const sgn of [-1, 1]) {
        for (let k = 0; k <= 4; k++) {
          _v1.set(sgn * hx, 0, inner + (k / 4) * (zo - inner)).applyMatrix4(M);
          const h = this._height(_v1.x, _v1.z);
          if (h < lo) lo = h;
        }
      }
      return lo - baseY;
    };
    let n = 0;
    while (n < MAX && sill - n * RISE - perimeter(n) > RISE) n++;
    for (let i = 0; i <= n; i++) {
      const ty = sill - i * RISE;
      /* Down to below the ground it stands on, so a course on falling ground
       * is a step and not a floating slab. `+0.45` is the buried footing. */
      const by = Math.min(ty, perimeter(i)) - 0.45;
      const h = ty - by;
      const w = halfW(i) * 2;
      const d = outerZ(i) - inner;
      const cz = (inner + outerZ(i)) / 2;
      _obj.position.set(0, (ty + by) / 2, cz);
      _obj.rotation.set(0, 0, 0);
      _obj.scale.set(1, 1, 1);
      _obj.updateMatrix();
      _m4.multiplyMatrices(M, _obj.matrix);
      grimeRamp(B.add('rubble', panelGeo(w, h, d, 0.62, 2), _m4, tint), baseY + by, h, 0.5);
      _v1.set(0, 0, cz).applyMatrix4(M);
      this._rbox(_v1.x, baseY + (ty + by) / 2, _v1.z, w / 2, h / 2, d / 2, yaw);
    }
    if (n > 0) {
      _v1.set(0, 0, (inner + outerZ(n)) / 2).applyMatrix4(M);
      this._footprints.push({
        x: _v1.x, z: _v1.z, hx: halfW(n), hz: (outerZ(n) - inner) / 2 + 0.4, r: yaw,
      });
    }
    return n + 1;
  }

  /**
   * The lamp that makes an interior an interior.
   *
   * ── The defect ─────────────────────────────────────────────────────────
   * Not one of the fifty-four town interiors had a light in it. `_shell` and
   * `_shellInterior` emit additive glow CARDS - `_addGlow` quads - and emissive
   * window glass, and neither of those lights anything: a glow card is a bright
   * quad, an emissive material is a bright surface, and both are invisible to
   * every other surface in the room. Measured mean frame luminance inside the
   * five landmark interiors was 11-20 out of 255, with one frame at 0. The
   * hearth, the mantel, the bed, the choir stalls, the altar candles, the
   * weapon rack and the wool bales were all modelled and all invisible; the
   * only thing making them readable in normal play was the held weapon's
   * viewmodel light leaking into the world, which is a bug being load-bearing.
   *
   * ── Why this is affordable now, and was not once ───────────────────────
   * The comment in `_house` - "fourteen cottage lamps plus the castle
   * practicals is not a budget, it is a tax" - was written when a light in the
   * scene was a light in the shader. It is not any more. `gfx/LightRig.js`
   * owns a FIXED twelve point-light slots that are in the scene from boot and
   * never added, removed or hidden, and every other light in the game is a
   * *source*: hidden on the frame the rig first sees it, scored each frame by
   * the irradiance it actually delivers near the camera, and copied into a slot
   * only when it is one of the twelve strongest. So the light counts in
   * `getProgramCacheKey` do not move, the program set does not change, and the
   * marginal cost of a source is one `Vector3` read and two distances in
   * `LightRig._score` - about 40 ns.
   *
   * ── Why `distance` is sized off the room ───────────────────────────────
   * A point light is not occluded by the wall it is behind, so the only thing
   * bounding how far a hearth lamp spills onto the street is its own cut-off.
   * `_house` uses 20 m, which is the width of Aldermoor's high street and is
   * deliberate there. Sized to the room instead, a lamp reads at the table and
   * has fallen to nothing by the far pavement - which also stops fifty-four of
   * them fighting the street practicals for the twelve slots.
   *
   * ── Why the INTENSITY is sized off the room too ────────────────────────
   * Because a point light is inverse-square and a room is not a point. 46 was
   * tuned in a 7.4 x 6.0 m cottage, where every wall is about 4 m from the
   * lamp; in a 14 x 11.5 m hall the same lamp has to throw twice as far and
   * delivers a quarter of the light when it gets there. Measured mean frame
   * luminance out of 255, four headings each, viewmodel light neutralised:
   * The Stilthouse 26.6 and The Marcher Hall 25.9 against the Guildhall's 37.4
   * and the abbey church's 36.8 - and the two failures are not marginally
   * worse, they read as one pool of light on a black floor with the bales and
   * the weapon rack in silhouette. Both are plank-walled, which is the other
   * half of it: dark timber returns a fraction of what ashlar does, so the two
   * biggest single-lamp rooms in the world are also the two least reflective.
   *
   * The gain is the square of the room's diagonal over the cottage's, because
   * that is what inverse-square asks for, capped at 2 because past that the
   * lamp itself blows out before the far wall catches up - a room that still
   * reads dark at twice the lamp needs another lamp, not a brighter one, which
   * is what the count in `_shellInterior` is for.
   *
   * @param {THREE.Vector3} pos world position
   * @param {number} w room width @param {number} d room depth
   * @returns {THREE.PointLight} already parented; also returned so the
   *   enterable descriptor can carry it.
   */
  _interiorLight(pos, w, d) {
    const diag = Math.hypot(w, d);
    const reach = Math.min(16, Math.max(7.5, diag * 0.95));
    /** The diagonal of the cottage the 46 was tuned in: 7.4 x 6.0 m. */
    const REF = 9.5;
    const gain = Math.min(2, Math.max(1, (diag / REF) ** 2));
    const l = pointLight(0xffb26a, 46 * gain, reach, 2);
    l.position.copy(pos);
    this.group.add(l);
    return l;
  }

  /** Polygonal ring wall approximating a round tower shell. */
  _ringWall(cx, cy, cz, radius, halfH, thick, segs = 8) {
    const w = Math.tan(Math.PI / segs) * radius + thick;
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * TAU;
      this._rbox(
        cx + Math.cos(a) * radius, cy, cz + Math.sin(a) * radius,
        thick, halfH, w, -a
      );
    }
  }

  /**
   * Square platform whose top face sits at `topY`, standing in for a circular
   * floor. Deliberately one thick box: two crossed boxes each push the capsule
   * out independently and leave the player hovering, and a thin slab lands the
   * capsule exactly on the surface, which trips the solver's degenerate case.
   */
  _discSolid(cx, topY, cz, radius, thickness = 1.6) {
    const h = radius * 0.95;
    this._rbox(cx, topY - thickness, cz, h, thickness, h, 0);
  }
  /* ---------------------------------------------------------------- */
  /* Procedural texture set                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Paint one surface: albedo + a shared height canvas that becomes both the
   * normal map and the roughness map. Every material in the world gets all
   * three - flat untextured standard materials are not acceptable here.
   */
  _surface(name, S, paint, opts = {}) {
    const aC = newCanvas(S);
    const hC = newCanvas(S);
    const a = aC.getContext('2d', { willReadFrequently: true });
    const h = hC.getContext('2d', { willReadFrequently: true });
    h.fillStyle = '#7a7a7a';
    h.fillRect(0, 0, S, S);
    paint(a, h, S, mulberry32(opts.seed ?? 0x51ee7 + name.length * 977));

    const map = new THREE.CanvasTexture(aC);
    map.colorSpace = THREE.SRGBColorSpace;
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.anisotropy = this._aniso;
    // Cut-out sheets need their coverage held across the mip chain, or the
    // silhouette erodes into sparkle the moment the surface is more than a few
    // dozen pixels away.
    if (opts.alphaRef) applyCoverageMips(map, aC, opts.alphaRef);
    const normalMap = normalFromHeight(hC, opts.normalStrength ?? 2.4);
    normalMap.anisotropy = this._aniso;
    const roughnessMap = roughFromHeight(hC, opts.rough ?? 0.84, opts.roughVar ?? 0.34);
    roughnessMap.anisotropy = this._aniso;
    const aoMap = aoFromHeight(hC, opts.ao ?? 1.0, opts.aoRadius ?? Math.max(3, S >> 7));
    aoMap.anisotropy = this._aniso;

    const set = { map, normalMap, roughnessMap, aoMap };
    this._tex[name] = set;
    this._owned.push(map, normalMap, roughnessMap, aoMap);
    return set;
  }

  /** Cut-out surface (grass blades, leaves) - albedo with alpha, no height. */
  _cutout(name, S, paint, alphaRef = 0) {
    const c = newCanvas(S);
    paint(c.getContext('2d', { willReadFrequently: true }), S, mulberry32(0x9a11 + name.length * 31));
    const map = new THREE.CanvasTexture(c);
    map.colorSpace = THREE.SRGBColorSpace;
    map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
    map.anisotropy = this._aniso;
    if (alphaRef) applyCoverageMips(map, c, alphaRef);
    this._tex[name] = { map };
    this._owned.push(map);
    return map;
  }

  async _buildTextures() {
    this._aniso = this.engine.renderer.capabilities.getMaxAnisotropy();

    /* --- Coursed ashlar for the castle.
     *
     * 1024px over seven courses puts a block at roughly 0.3-0.7m at the
     * 0.45-0.5 geometry tile the walls use, which is what dressed stone
     * actually is. Value is correlated per course rather than per block, hue
     * spread is narrow, arrises are chipped, joints carry moss and the courses
     * are water-streaked - centuries-old stone, not a swatch. The joint inset
     * is wide (7px, ~8% of a course) and the height field is blurred before the
     * Sobel so the arris becomes a bevel rather than a one-texel cliff that
     * mips straight out of existence at any distance. */
    this._surface('ashlar', 1024, (a, h, S, rnd) => {
      a.fillStyle = '#332d25';
      a.fillRect(0, 0, S, S);
      h.fillStyle = '#3a3a3a';
      h.fillRect(0, 0, S, S);
      // Seven courses rather than four: at the 0.45 geometry tile the walls use
      // that lands a block at 0.3-0.7m, which is dressed stone. Four courses put
      // individual blocks near a metre across on a 1.2m parapet.
      const rows = 7;
      const rh = S / rows;
      for (let r = 0; r < rows; r++) {
        // Real ashlar is quarried and dressed course by course, so value
        // correlates along a bed joint. Randomising every block independently
        // over a 26-point lightness span produced a value checkerboard with no
        // spatial structure - the loudest "procedural" tell in the build.
        const rowL = 43 + rnd() * 9;
        const rowHue = 28 + rnd() * 8;
        let x = -rnd() * rh * 1.9;
        while (x < S) {
          const w = rh * (1.0 + rnd() * 1.3);
          const l = rowL + (rnd() - 0.5) * 5;
          const hue = rowHue + (rnd() - 0.5) * 4;
          const sat = 5 + rnd() * 9;
          a.fillStyle = `hsl(${hue}, ${sat}%, ${l}%)`;
          a.fillRect(x + 4, r * rh + 4, w - 8, rh - 8);
          // Three nested rects, not one: joint floor, chamfer, then the face.
          // A single hard step from mortar to face is one texel wide after the
          // Sobel and mips away to nothing, which is why the wall was reading
          // as a flat plane with a brick pattern painted on it.
          const hv = (176 + rnd() * 34) | 0;
          const hm = ((hv + 62) * 0.5) | 0;
          h.fillStyle = `rgb(${hm},${hm},${hm})`;
          h.fillRect(x + 4, r * rh + 4, w - 8, rh - 8);
          h.fillStyle = `rgb(${hv},${hv},${hv})`;
          h.fillRect(x + 9, r * rh + 9, w - 18, rh - 18);
          // Tooled chisel marks across the block face.
          a.strokeStyle = `hsla(${hue}, ${sat}%, ${l - 10}%, 0.32)`;
          a.lineWidth = 1.4;
          for (let k = 0; k < 9; k++) {
            const yy = r * rh + 6 + rnd() * (rh - 12);
            a.beginPath();
            a.moveTo(x + 6, yy);
            a.lineTo(x + w - 6, yy + (rnd() - 0.5) * 5);
            a.stroke();
          }
          // Chipped arrises: a few bites out of the block edges, in both maps.
          for (let k = 0; k < 3 + ((rnd() * 3) | 0); k++) {
            const ex = rnd() < 0.5 ? x + 3 : x + w - 3;
            const ey = r * rh + 3 + rnd() * (rh - 6);
            const er = 3 + rnd() * 9;
            a.fillStyle = `hsla(${hue}, ${sat}%, ${l - 16}%, 0.8)`;
            h.fillStyle = 'rgba(70,70,70,0.85)';
            for (const ctx of [a, h]) {
              ctx.beginPath();
              ctx.ellipse(ex, ey, er, er * 0.7, rnd() * TAU, 0, TAU);
              ctx.fill();
            }
          }
          // Water streaking down from the bed joint above.
          if (rnd() < 0.55) {
            const sxp = x + 8 + rnd() * (w - 16);
            const grd = a.createLinearGradient(0, r * rh, 0, r * rh + rh);
            grd.addColorStop(0, `hsla(${hue}, ${sat}%, ${l - 18}%, 0.5)`);
            grd.addColorStop(1, `hsla(${hue}, ${sat}%, ${l - 18}%, 0)`);
            a.fillStyle = grd;
            a.fillRect(sxp, r * rh + 3, 6 + rnd() * 16, rh - 6);
          }
          x += w;
        }
      }
      // Grime that sits in the joints rather than floating over the wall: draw
      // it as a dark ring inset one course, then let the block fills above it
      // stay clean. A 110px airbrushed radial blotch on a 1024 tile reads as
      // an out-of-focus smudge, never as lichen or soot.
      a.save();
      a.globalCompositeOperation = 'multiply';
      for (let r = 0; r <= rows; r++) {
        a.fillStyle = 'rgba(150,142,126,0.55)';
        a.fillRect(0, r * rh - 3, S, 6);
      }
      a.restore();
      grain(a, S, 0x31, 0.32, 'overlay');
      grain(h, S, 0x31, 0.24, 'overlay');
      // Lichen and soot, kept small and dense so it terminates at block scale.
      blotches(a, S, rnd, 90, 'rgba(112,124,72,ALPHA)', 7, 30, 0.3);
      blotches(a, S, rnd, 46, 'rgba(148,150,118,ALPHA)', 5, 18, 0.26);
      blotches(a, S, rnd, 90, 'rgba(26,22,17,ALPHA)', 9, 34, 0.22);
    }, { normalStrength: 2.1, rough: 0.88, roughVar: 0.3, ao: 1.15, aoRadius: 7 });

    /* --- Flagstone for wall-walks and paved floors: large irregular slabs
     * worn hollow in the middle. Reusing 'ashlar' here was the tell - the same
     * block pattern on the wall, the coping and the floor at three different
     * UV stretches reads as one material sprayed over everything. */
    await this._breathe();
    this._surface('flagstone', 512, (a, h, S, rnd) => {
      a.fillStyle = '#2a251d';
      a.fillRect(0, 0, S, S);
      h.fillStyle = '#3a3a3a';
      h.fillRect(0, 0, S, S);
      const cells = 3;
      const cw = S / cells;
      for (let r = -1; r <= cells; r++) {
        for (let c = -1; c <= cells; c++) {
          const jx = (rnd() - 0.5) * cw * 0.3;
          const jz = (rnd() - 0.5) * cw * 0.3;
          const x = c * cw + jx;
          const y = r * cw + jz;
          const w = cw * (0.78 + rnd() * 0.28);
          const d = cw * (0.72 + rnd() * 0.32);
          const l = 30 + rnd() * 22;
          const hue = 30 + rnd() * 20;
          a.fillStyle = `hsl(${hue}, ${4 + rnd() * 8}%, ${l}%)`;
          a.fillRect(x, y, w, d);
          // Worn centre: brighter, smoother, slightly proud in the height map.
          const g = a.createRadialGradient(x + w / 2, y + d / 2, 0, x + w / 2, y + d / 2, w * 0.6);
          g.addColorStop(0, `hsla(${hue}, 6%, ${l + 12}%, 0.55)`);
          g.addColorStop(1, `hsla(${hue}, 6%, ${l + 12}%, 0)`);
          a.fillStyle = g;
          a.fillRect(x, y, w, d);
          const hg = h.createRadialGradient(x + w / 2, y + d / 2, 0, x + w / 2, y + d / 2, w * 0.62);
          hg.addColorStop(0, 'rgba(220,220,220,1)');
          hg.addColorStop(0.72, 'rgba(180,180,180,1)');
          hg.addColorStop(1, 'rgba(56,56,56,1)');
          h.fillStyle = hg;
          h.fillRect(x, y, w, d);
        }
      }
      grain(a, S, 0x8d, 0.3, 'overlay');
      blotches(a, S, rnd, 30, 'rgba(104,116,70,ALPHA)', 8, 34, 0.3);
      blotches(a, S, rnd, 18, 'rgba(24,20,16,ALPHA)', 16, 60, 0.24);
    }, { normalStrength: 2.4, rough: 0.9, roughVar: 0.26, ao: 1.15, aoRadius: 7 });

    /* --- Rubble: undressed field stone for cottages, bridges, walls. */
    this._surface('rubble', 512, (a, h, S, rnd) => {
      a.fillStyle = '#57503f';
      a.fillRect(0, 0, S, S);
      h.fillStyle = '#4a4a4a';
      h.fillRect(0, 0, S, S);
      for (let i = 0; i < 190; i++) {
        const x = rnd() * S;
        const y = rnd() * S;
        const r = 9 + rnd() * 22;
        const sides = 5 + ((rnd() * 4) | 0);
        const rot = rnd() * TAU;
        const l = 40 + rnd() * 24;
        const hue = 30 + rnd() * 22;
        a.fillStyle = `hsl(${hue}, ${6 + rnd() * 12}%, ${l}%)`;
        const hv = (150 + rnd() * 80) | 0;
        h.fillStyle = `rgb(${hv},${hv},${hv})`;
        for (const ctx of [a, h]) {
          ctx.beginPath();
          for (let s = 0; s <= sides; s++) {
            const ang = rot + (s / sides) * TAU;
            const rr = r * (0.68 + rnd() * 0.42);
            const px = x + Math.cos(ang) * rr;
            const py = y + Math.sin(ang) * rr * 0.78;
            if (s === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.fill();
        }
      }
      grain(a, S, 0x77, 0.34, 'overlay');
      grain(h, S, 0x77, 0.3, 'overlay');
      blotches(a, S, rnd, 34, 'rgba(88,104,58,ALPHA)', 8, 40, 0.34);
    }, { normalStrength: 3.4, rough: 0.9, roughVar: 0.22 });

    /* --- Cobbles: rounded setts laid in fanned courses.
     *
     * Pitched one to two stops above the surrounding meadow so the road
     * network still reads as the navigation affordance it is - but no further.
     * Round 4 pushed the setts to 48-68% lightness on the argument that a
     * light ribbon through dark grass is cheap wayfinding, and it is, right up
     * until the apron of that same cobble runs along the base of every wall in
     * the village. Multiplied by a near-white vertex tint, a 1.3x macro
     * breaker and a horizontal surface taking the key, the result clipped, and
     * all three reviews independently reported "a blown white slab at the base
     * of every building" as the single most damaging artifact in the build.
     * Wet-laid granite setts at dusk are a mid-value grey-brown; the contrast
     * against grass comes from hue and roughness, not from luminance. */
    await this._breathe();
    this._surface('cobble', 512, (a, h, S, rnd) => {
      a.fillStyle = '#39332a';
      a.fillRect(0, 0, S, S);
      h.fillStyle = '#3c3c3c';
      h.fillRect(0, 0, S, S);
      const rows = 13;
      const rh = S / rows;
      for (let r = -1; r <= rows; r++) {
        const off = (r % 2) * rh * 0.5;
        for (let c = -1; c < rows + 1; c++) {
          const cx = c * rh + off + (rnd() - 0.5) * 2.4;
          const cy = r * rh + rh * 0.5 + (rnd() - 0.5) * 2.4;
          const rx = rh * (0.38 + rnd() * 0.12);
          const ry = rh * (0.32 + rnd() * 0.12);
          const l = 30 + rnd() * 17;
          a.fillStyle = `hsl(${28 + rnd() * 26}, ${4 + rnd() * 11}%, ${l}%)`;
          a.beginPath();
          a.ellipse(cx, cy, rx, ry, rnd() * TAU, 0, TAU);
          a.fill();
          const g = h.createRadialGradient(cx, cy, 0, cx, cy, rx);
          g.addColorStop(0, 'rgb(226,226,226)');
          g.addColorStop(0.7, 'rgb(178,178,178)');
          g.addColorStop(1, 'rgb(70,70,70)');
          h.fillStyle = g;
          h.beginPath();
          h.ellipse(cx, cy, rx, ry, 0, 0, TAU);
          h.fill();
        }
      }
      grain(a, S, 0xa3, 0.3, 'overlay');
      blotches(a, S, rnd, 20, 'rgba(120,124,74,ALPHA)', 8, 30, 0.26);
    }, { normalStrength: 2.6, rough: 0.8, roughVar: 0.36 });

    /* --- Sawn oak boarding for floors, doors, carts. */
    this._surface('plank', 512, (a, h, S, rnd) => {
      const n = 7;
      const bw = S / n;
      for (let i = 0; i < n; i++) {
        const l = 26 + rnd() * 12;
        a.fillStyle = `hsl(${28 + rnd() * 8}, ${26 + rnd() * 12}%, ${l}%)`;
        a.fillRect(i * bw, 0, bw, S);
        const hv = (168 + rnd() * 44) | 0;
        h.fillStyle = `rgb(${hv},${hv},${hv})`;
        h.fillRect(i * bw + 1.5, 0, bw - 3, S);
        // Grain lines, then a knot or two.
        for (let k = 0; k < 26; k++) {
          const gx = i * bw + 3 + rnd() * (bw - 6);
          a.strokeStyle = `hsla(26, 34%, ${l - 8 - rnd() * 8}%, ${0.2 + rnd() * 0.3})`;
          a.lineWidth = 0.6 + rnd() * 1.4;
          a.beginPath();
          a.moveTo(gx, 0);
          for (let y = 0; y <= S; y += 32) a.lineTo(gx + Math.sin(y * 0.03 + k) * 2.2, y);
          a.stroke();
        }
        if (rnd() < 0.7) {
          const kx = i * bw + bw * 0.5 + (rnd() - 0.5) * bw * 0.4;
          const ky = rnd() * S;
          for (let q = 5; q > 0; q--) {
            a.strokeStyle = `hsla(24, 40%, ${l - 14}%, 0.55)`;
            a.lineWidth = 1.2;
            a.beginPath();
            a.ellipse(kx, ky, q * 2.2, q * 3.4, 0, 0, TAU);
            a.stroke();
          }
        }
        a.fillStyle = 'rgba(18,12,8,0.75)';
        a.fillRect(i * bw, 0, 1.8, S);
      }
      grain(a, S, 0x5c, 0.22, 'overlay');
    }, { normalStrength: 1.8, rough: 0.78, roughVar: 0.28 });

    /* --- Adzed structural timber: rougher, darker, cross-grained. */
    this._surface('beam', 512, (a, h, S, rnd) => {
      a.fillStyle = '#3a2b1d';
      a.fillRect(0, 0, S, S);
      h.fillStyle = '#8a8a8a';
      h.fillRect(0, 0, S, S);
      for (let k = 0; k < 150; k++) {
        const y = rnd() * S;
        const l = 12 + rnd() * 14;
        a.strokeStyle = `hsla(${22 + rnd() * 12}, ${22 + rnd() * 16}%, ${l}%, ${0.35 + rnd() * 0.4})`;
        a.lineWidth = 1 + rnd() * 4;
        a.beginPath();
        a.moveTo(0, y);
        for (let x = 0; x <= S; x += 40) a.lineTo(x, y + Math.sin(x * 0.02 + k) * 3.5);
        a.stroke();
      }
      // Adze facets read as broad shallow scoops in the height map.
      for (let k = 0; k < 42; k++) {
        const x = rnd() * S;
        const y = rnd() * S;
        const g = h.createRadialGradient(x, y, 0, x, y, 34);
        const v = rnd() < 0.5 ? 128 : 46;
        g.addColorStop(0, `rgba(${v},${v},${v},0.6)`);
        g.addColorStop(1, `rgba(${v},${v},${v},0)`);
        h.fillStyle = g;
        h.fillRect(x - 34, y - 34, 68, 68);
      }
      grain(a, S, 0x91, 0.3, 'overlay');
      grain(h, S, 0x91, 0.3, 'overlay');
    }, { normalStrength: 2.2, rough: 0.9, roughVar: 0.2 });

    /* --- Lime-washed wattle and daub. */
    await this._breathe();
    this._surface('daub', 512, (a, h, S, rnd) => {
      /* Base value dropped from #ded2bb. A lime render that starts at 0.87
       * sRGB has one twelfth of a stop of headroom before a golden-hour key
       * takes it to paper, so every detail painted on top of it - trowel
       * streaks, straw, shrinkage cracks - was being compressed into the top
       * of the range and vanishing. #c0ad8c leaves the key somewhere to go and
       * gives the trowel work a value ramp to live in. */
      a.fillStyle = '#c0ad8c';
      a.fillRect(0, 0, S, S);
      h.fillStyle = '#8c8c8c';
      h.fillRect(0, 0, S, S);
      /* Trowel and float work. Lime render is applied by hand in overlapping
       * arcs and it dries at different rates where it is thick; that is the
       * one macro-scale feature a plaster panel has, and without it a 2.5m
       * bay between two studs has literally no information in it above the
       * grain frequency. Three passes: broad float sweeps, darker suction
       * patches where the daub drew the water out, then bright limewash
       * runs. */
      for (let k = 0; k < 26; k++) {
        const cx = rnd() * S;
        const cy = rnd() * S;
        const rr = 40 + rnd() * 120;
        const g2 = a.createRadialGradient(cx, cy, 0, cx, cy, rr);
        const dark = rnd() < 0.55;
        g2.addColorStop(0, dark ? 'rgba(126,110,86,0.34)' : 'rgba(226,214,190,0.30)');
        g2.addColorStop(1, dark ? 'rgba(126,110,86,0)' : 'rgba(226,214,190,0)');
        a.fillStyle = g2;
        a.fillRect(cx - rr, cy - rr, rr * 2, rr * 2);
      }
      blotches(a, S, rnd, 60, 'rgba(146,128,100,ALPHA)', 20, 80, 0.34);
      blotches(a, S, rnd, 30, 'rgba(232,222,200,ALPHA)', 18, 70, 0.4);
      // Straw flecks in the render.
      for (let k = 0; k < 700; k++) {
        const x = rnd() * S;
        const y = rnd() * S;
        const ang = rnd() * TAU;
        const len = 3 + rnd() * 9;
        a.strokeStyle = `hsla(${40 + rnd() * 14}, ${28 + rnd() * 20}%, ${52 + rnd() * 18}%, 0.5)`;
        a.lineWidth = 0.8;
        a.beginPath();
        a.moveTo(x, y);
        a.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
        a.stroke();
      }
      // Hairline shrinkage cracks.
      for (let k = 0; k < 22; k++) {
        let x = rnd() * S;
        let y = rnd() * S;
        a.strokeStyle = 'rgba(120,104,80,0.4)';
        h.strokeStyle = 'rgba(30,30,30,0.7)';
        a.lineWidth = 1;
        h.lineWidth = 1.6;
        a.beginPath();
        h.beginPath();
        a.moveTo(x, y);
        h.moveTo(x, y);
        for (let s = 0; s < 9; s++) {
          x += (rnd() - 0.5) * 26;
          y += (rnd() - 0.5) * 26;
          a.lineTo(x, y);
          h.lineTo(x, y);
        }
        a.stroke();
        h.stroke();
      }
      // Wattle-and-daub is hand-floated over woven staves: it undulates on a
      // 20-40cm wavelength. Without that broad relief in the height field a
      // 2.5m panel between two studs is a dead flat rectangle no matter how
      // much fine grain sits on it, which is exactly how the village gables
      // were reading. These lumps are the difference.
      blotches(h, S, rnd, 26, 'rgba(210,210,210,ALPHA)', 40, 130, 0.4);
      blotches(h, S, rnd, 22, 'rgba(60,60,60,ALPHA)', 34, 120, 0.34);
      grain(a, S, 0xd4, 0.22, 'overlay');
      grain(h, S, 0xd4, 0.4, 'overlay');
    }, { normalStrength: 2.7, rough: 0.94, roughVar: 0.16 });

    /* --- Combed wheat thatch. */
    this._surface('thatch', 512, (a, h, S, rnd) => {
      a.fillStyle = '#8a6a2c';
      a.fillRect(0, 0, S, S);
      h.fillStyle = '#606060';
      h.fillRect(0, 0, S, S);
      for (let k = 0; k < 5200; k++) {
        const x = rnd() * S;
        const y = rnd() * S;
        const len = 16 + rnd() * 40;
        const ang = Math.PI * 0.5 + (rnd() - 0.5) * 0.34;
        const l = 30 + rnd() * 36;
        a.strokeStyle = `hsl(${34 + rnd() * 16}, ${38 + rnd() * 24}%, ${l}%)`;
        a.lineWidth = 0.9 + rnd() * 1.5;
        a.beginPath();
        a.moveTo(x, y);
        a.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
        a.stroke();
        const hv = (70 + l * 2.6) | 0;
        h.strokeStyle = `rgb(${hv},${hv},${hv})`;
        h.lineWidth = 1.4 + rnd() * 1.8;
        h.beginPath();
        h.moveTo(x, y);
        h.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
        h.stroke();
      }
      blotches(a, S, rnd, 26, 'rgba(52,42,22,ALPHA)', 20, 80, 0.3);
      blotches(a, S, rnd, 12, 'rgba(96,110,58,ALPHA)', 16, 50, 0.28);
    }, { normalStrength: 3.2, rough: 0.96, roughVar: 0.1 });

    /* --- Split slate roofing in overlapping courses. */
    await this._breathe();
    this._surface('slate', 512, (a, h, S, rnd) => {
      a.fillStyle = '#2b2f35';
      a.fillRect(0, 0, S, S);
      h.fillStyle = '#4a4a4a';
      h.fillRect(0, 0, S, S);
      const rows = 11;
      const rh = S / rows;
      for (let r = 0; r < rows; r++) {
        const off = (r % 2) * rh * 0.62;
        for (let c = -1; c < rows + 1; c++) {
          const x = c * rh * 1.24 + off;
          const y = r * rh;
          const l = 24 + rnd() * 18;
          a.fillStyle = `hsl(${200 + rnd() * 32}, ${5 + rnd() * 10}%, ${l}%)`;
          a.fillRect(x, y, rh * 1.24 - 2, rh * 1.5);
          const hv = (140 + rnd() * 60) | 0;
          h.fillStyle = `rgb(${hv},${hv},${hv})`;
          h.fillRect(x + 1, y + 1, rh * 1.24 - 4, rh * 1.5 - 2);
          h.fillStyle = 'rgba(24,24,24,0.85)';
          h.fillRect(x, y + rh * 1.5 - 3, rh * 1.24, 3);
        }
      }
      grain(a, S, 0xbe, 0.26, 'overlay');
      blotches(a, S, rnd, 24, 'rgba(112,124,76,ALPHA)', 8, 34, 0.28);
    }, { normalStrength: 2.6, rough: 0.7, roughVar: 0.32 });

    /* --- Hammered wrought iron. */
    this._surface('iron', 256, (a, h, S, rnd) => {
      a.fillStyle = '#31302e';
      a.fillRect(0, 0, S, S);
      h.fillStyle = '#7e7e7e';
      h.fillRect(0, 0, S, S);
      for (let k = 0; k < 260; k++) {
        const x = rnd() * S;
        const y = rnd() * S;
        const r = 4 + rnd() * 11;
        a.fillStyle = `hsla(${20 + rnd() * 20}, ${6 + rnd() * 18}%, ${16 + rnd() * 18}%, 0.6)`;
        a.beginPath();
        a.ellipse(x, y, r, r * 0.8, rnd() * TAU, 0, TAU);
        a.fill();
        const g = h.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, 'rgba(160,160,160,0.7)');
        g.addColorStop(1, 'rgba(90,90,90,0)');
        h.fillStyle = g;
        h.fillRect(x - r, y - r, r * 2, r * 2);
      }
      blotches(a, S, rnd, 22, 'rgba(122,64,26,ALPHA)', 5, 22, 0.4);
      grain(a, S, 0x4f, 0.22, 'overlay');
    }, { normalStrength: 2.0, rough: 0.52, roughVar: 0.3 });

    /* --- Machined alloy: the portal frame, deliberately alien here. */
    this._surface('alloy', 256, (a, h, S, rnd) => {
      a.fillStyle = '#8f9aa6';
      a.fillRect(0, 0, S, S);
      h.fillStyle = '#9a9a9a';
      h.fillRect(0, 0, S, S);
      for (let k = 0; k < 420; k++) {
        const y = rnd() * S;
        a.strokeStyle = `hsla(210, ${4 + rnd() * 8}%, ${52 + rnd() * 26}%, 0.35)`;
        a.lineWidth = 0.5 + rnd();
        a.beginPath();
        a.moveTo(0, y);
        a.lineTo(S, y);
        a.stroke();
      }
      // Panel scoring plus recessed fastener rows.
      for (let k = 0; k < 6; k++) {
        const y = (k + 0.5) * (S / 6);
        h.fillStyle = 'rgba(30,30,30,0.9)';
        h.fillRect(0, y - 1.5, S, 3);
        a.fillStyle = 'rgba(38,48,58,0.55)';
        a.fillRect(0, y - 1.5, S, 3);
        for (let q = 0; q < 10; q++) {
          const x = (q + 0.5) * (S / 10);
          h.fillStyle = 'rgba(40,40,40,0.9)';
          h.beginPath();
          h.arc(x, y - 10, 3, 0, TAU);
          h.fill();
          a.fillStyle = 'rgba(60,72,84,0.6)';
          a.beginPath();
          a.arc(x, y - 10, 3, 0, TAU);
          a.fill();
        }
      }
      grain(a, S, 0x2b, 0.14, 'overlay');
    }, { normalStrength: 1.6, rough: 0.34, roughVar: 0.24 });

    /* --- Heraldic banner cloth: woven ground with a charge and a border. */
    await this._breathe();
    this._surface('banner', 256, (a, h, S, rnd) => {
      a.fillStyle = '#d8d2c6';
      a.fillRect(0, 0, S, S);
      h.fillStyle = '#8a8a8a';
      h.fillRect(0, 0, S, S);
      // Weave.
      for (let i = 0; i < S; i += 3) {
        a.fillStyle = 'rgba(255,255,255,0.13)';
        a.fillRect(i, 0, 1.5, S);
        a.fillStyle = 'rgba(0,0,0,0.10)';
        a.fillRect(0, i, S, 1.5);
        h.fillStyle = 'rgba(210,210,210,0.35)';
        h.fillRect(i, 0, 1.5, S);
        h.fillStyle = 'rgba(60,60,60,0.35)';
        h.fillRect(0, i, S, 1.5);
      }
      // Chief band and a rampant-ish charge, drawn light so the vertex tint reads.
      a.fillStyle = 'rgba(255,246,224,0.85)';
      a.fillRect(0, 0, S, S * 0.14);
      a.fillRect(0, S * 0.86, S, S * 0.14);
      a.save();
      a.translate(S * 0.5, S * 0.52);
      a.fillStyle = 'rgba(255,244,214,0.92)';
      a.beginPath();
      a.moveTo(0, -S * 0.24);
      a.lineTo(S * 0.13, -S * 0.05);
      a.lineTo(S * 0.2, S * 0.02);
      a.lineTo(S * 0.1, S * 0.02);
      a.lineTo(S * 0.14, S * 0.24);
      a.lineTo(0, S * 0.14);
      a.lineTo(-S * 0.14, S * 0.24);
      a.lineTo(-S * 0.1, S * 0.02);
      a.lineTo(-S * 0.2, S * 0.02);
      a.lineTo(-S * 0.13, -S * 0.05);
      a.closePath();
      a.fill();
      a.restore();
      // Vertical folds so the cloth catches light.
      for (let k = 0; k < 9; k++) {
        const x = (k + 0.5) * (S / 9) + (rnd() - 0.5) * 6;
        const g = h.createLinearGradient(x - 12, 0, x + 12, 0);
        g.addColorStop(0, 'rgba(50,50,50,0.5)');
        g.addColorStop(0.5, 'rgba(220,220,220,0.5)');
        g.addColorStop(1, 'rgba(50,50,50,0.5)');
        h.fillStyle = g;
        h.fillRect(x - 12, 0, 24, S);
      }
    }, { normalStrength: 1.4, rough: 0.88, roughVar: 0.18 });

    /* --- Awning stripe for market canopies. */
    this._surface('canopy', 256, (a, h, S, rnd) => {
      a.fillStyle = '#e6ded0';
      a.fillRect(0, 0, S, S);
      h.fillStyle = '#8a8a8a';
      h.fillRect(0, 0, S, S);
      const bands = 6;
      for (let i = 0; i < bands; i++) {
        if (i % 2 === 0) continue;
        a.fillStyle = 'rgba(74,64,54,0.62)';
        a.fillRect((i * S) / bands, 0, S / bands, S);
        h.fillStyle = 'rgba(120,120,120,0.5)';
        h.fillRect((i * S) / bands, 0, S / bands, S);
      }
      for (let i = 0; i < S; i += 3) {
        a.fillStyle = 'rgba(255,255,255,0.10)';
        a.fillRect(0, i, S, 1.4);
        h.fillStyle = 'rgba(180,180,180,0.3)';
        h.fillRect(0, i, S, 1.4);
      }
      blotches(a, S, rnd, 14, 'rgba(120,100,70,ALPHA)', 10, 40, 0.22);
    }, { normalStrength: 1.2, rough: 0.9, roughVar: 0.12 });

    /* --- Fissured bark. */
    await this._breathe();
    this._surface('bark', 256, (a, h, S, rnd) => {
      a.fillStyle = '#3d3022';
      a.fillRect(0, 0, S, S);
      h.fillStyle = '#7c7c7c';
      h.fillRect(0, 0, S, S);
      for (let k = 0; k < 260; k++) {
        const x = rnd() * S;
        const w = 2 + rnd() * 9;
        const l = 22 + rnd() * 40;
        a.fillStyle = `hsl(${24 + rnd() * 16}, ${16 + rnd() * 18}%, ${14 + rnd() * 20}%)`;
        a.fillRect(x, rnd() * S, w, l);
        const hv = (110 + rnd() * 120) | 0;
        h.fillStyle = `rgb(${hv},${hv},${hv})`;
        h.fillRect(x, rnd() * S, w, l);
      }
      for (let k = 0; k < 90; k++) {
        const x = rnd() * S;
        a.strokeStyle = 'rgba(12,9,6,0.6)';
        a.lineWidth = 1 + rnd() * 3;
        h.strokeStyle = 'rgba(28,28,28,0.8)';
        h.lineWidth = 2 + rnd() * 3;
        a.beginPath();
        h.beginPath();
        a.moveTo(x, 0);
        h.moveTo(x, 0);
        for (let y = 0; y <= S; y += 24) {
          const xx = x + Math.sin(y * 0.05 + k) * 5;
          a.lineTo(xx, y);
          h.lineTo(xx, y);
        }
        a.stroke();
        h.stroke();
      }
      blotches(a, S, rnd, 18, 'rgba(104,118,72,ALPHA)', 6, 26, 0.3);
    }, { normalStrength: 3.2, rough: 0.94, roughVar: 0.14 });

    /* --- Dense leaf mass for tree canopies.
     *
     * Painted onto a *transparent* canvas so the material can alpha-test: an
     * opaque leaf sheet stretched over a lumpy sphere gives a closed silhouette
     * that reads as a green boulder. Cut-out leaves let sky through the crown
     * edge, which is the entire difference between foliage and a blob. */
    this._surface('leaf', 512, (a, h, S, rnd) => {
      h.fillStyle = '#5c5c5c';
      h.fillRect(0, 0, S, S);
      // Coverage is the whole game here. 4400 ellipses closed the sheet
      // completely and the crown read as a green boulder; 1500 plus a heavy
      // erosion pass swung too far the other way and left the crown edge as
      // scattered flecks with no mass holding them together. 2600 with a
      // gentler erosion lands coverage near 0.75 - a canopy with sky through
      // it, which is what a backlit crown at fifty metres actually looks like.
      for (let k = 0; k < 1950; k++) {
        const x = rnd() * S;
        const y = rnd() * S;
        const r = 4 + rnd() * 12;
        const ang = rnd() * TAU;
        const l = 24 + rnd() * 30;
        a.fillStyle = `hsl(${68 + rnd() * 34}, ${28 + rnd() * 26}%, ${l}%)`;
        a.save();
        a.translate(x, y);
        a.rotate(ang);
        a.beginPath();
        a.ellipse(0, 0, r, r * 0.55, 0, 0, TAU);
        a.fill();
        a.restore();
        const hv = (60 + l * 3.6) | 0;
        h.fillStyle = `rgb(${hv},${hv},${hv})`;
        h.save();
        h.translate(x, y);
        h.rotate(ang);
        h.beginPath();
        h.ellipse(0, 0, r * 0.9, r * 0.5, 0, 0, TAU);
        h.fill();
        h.restore();
      }
      // Explicit alpha erosion. Cluster overlap alone still leaves broad solid
      // regions; punching soft holes back out guarantees that wherever the
      // sheet lands on a crown perimeter there is sky showing through it. This
      // is the single difference between "foliage" and "green boulder".
      a.save();
      a.globalCompositeOperation = 'destination-out';
      for (let k = 0; k < 210; k++) {
        const x = rnd() * S;
        const y = rnd() * S;
        const r = 15 + rnd() * 23;
        const g = a.createRadialGradient(x, y, r * 0.2, x, y, r);
        g.addColorStop(0, 'rgba(0,0,0,0.93)');
        g.addColorStop(0.6, 'rgba(0,0,0,0.50)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        a.fillStyle = g;
        a.fillRect(x - r, y - r, r * 2, r * 2);
      }
      a.restore();
      // Shade and autumn-tip variation, masked to the leaves themselves so the
      // gaps between them stay genuinely empty.
      a.save();
      a.globalCompositeOperation = 'source-atop';
      blotches(a, S, rnd, 40, 'rgba(8,14,6,ALPHA)', 16, 64, 0.45);
      blotches(a, S, rnd, 18, 'rgba(190,180,90,ALPHA)', 10, 40, 0.22);
      a.restore();
    }, { normalStrength: 2.6, rough: 0.88, roughVar: 0.2, ao: 0.8, alphaRef: LEAF_ALPHA_REF });

    /* --- Granite outcrop. */
    await this._breathe();
    this._surface('rock', 512, (a, h, S, rnd) => {
      a.fillStyle = '#5d5a52';
      a.fillRect(0, 0, S, S);
      h.fillStyle = '#7a7a7a';
      h.fillRect(0, 0, S, S);
      for (let k = 0; k < 3200; k++) {
        const x = rnd() * S;
        const y = rnd() * S;
        const r = 1 + rnd() * 4;
        a.fillStyle = `hsla(${34 + rnd() * 24}, ${3 + rnd() * 10}%, ${24 + rnd() * 40}%, 0.7)`;
        a.beginPath();
        a.arc(x, y, r, 0, TAU);
        a.fill();
      }
      for (let k = 0; k < 34; k++) {
        let x = rnd() * S;
        let y = rnd() * S;
        a.strokeStyle = 'rgba(22,20,18,0.55)';
        h.strokeStyle = 'rgba(30,30,30,0.9)';
        a.lineWidth = 1 + rnd() * 2.4;
        h.lineWidth = 2 + rnd() * 3;
        a.beginPath();
        h.beginPath();
        a.moveTo(x, y);
        h.moveTo(x, y);
        for (let s = 0; s < 8; s++) {
          x += (rnd() - 0.5) * 70;
          y += (rnd() - 0.5) * 70;
          a.lineTo(x, y);
          h.lineTo(x, y);
        }
        a.stroke();
        h.stroke();
      }
      grain(h, S, 0x66, 0.4, 'overlay');
      blotches(a, S, rnd, 30, 'rgba(126,140,86,ALPHA)', 10, 44, 0.32);
    }, { normalStrength: 3.0, rough: 0.92, roughVar: 0.16 });

    /* --- Baled hay / straw. */
    this._surface('hay', 256, (a, h, S, rnd) => {
      a.fillStyle = '#a58236';
      a.fillRect(0, 0, S, S);
      h.fillStyle = '#6a6a6a';
      h.fillRect(0, 0, S, S);
      for (let k = 0; k < 2400; k++) {
        const x = rnd() * S;
        const y = rnd() * S;
        const len = 8 + rnd() * 22;
        const ang = (rnd() - 0.5) * 0.5;
        const l = 36 + rnd() * 34;
        a.strokeStyle = `hsl(${40 + rnd() * 14}, ${44 + rnd() * 22}%, ${l}%)`;
        a.lineWidth = 0.8 + rnd();
        a.beginPath();
        a.moveTo(x, y);
        a.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
        a.stroke();
        const hv = (80 + l * 2.2) | 0;
        h.strokeStyle = `rgb(${hv},${hv},${hv})`;
        h.lineWidth = 1.4;
        h.beginPath();
        h.moveTo(x, y);
        h.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
        h.stroke();
      }
    }, { normalStrength: 2.4, rough: 0.95, roughVar: 0.1 });

    /* --- Leaded window glass, used with strong emissive at dusk. */
    this._surface('glass', 128, (a, h, S, rnd) => {
      a.fillStyle = '#f7d79a';
      a.fillRect(0, 0, S, S);
      h.fillStyle = '#b0b0b0';
      h.fillRect(0, 0, S, S);
      const n = 4;
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          a.fillStyle = `hsla(${34 + rnd() * 18}, ${52 + rnd() * 26}%, ${64 + rnd() * 22}%, 1)`;
          a.fillRect((x * S) / n + 2, (y * S) / n + 2, S / n - 4, S / n - 4);
        }
      }
      a.strokeStyle = 'rgba(40,34,26,0.9)';
      a.lineWidth = 2.6;
      h.strokeStyle = 'rgba(30,30,30,0.9)';
      h.lineWidth = 3.4;
      for (let i = 0; i <= n; i++) {
        for (const ctx of [a, h]) {
          ctx.beginPath();
          ctx.moveTo((i * S) / n, 0);
          ctx.lineTo((i * S) / n, S);
          ctx.moveTo(0, (i * S) / n);
          ctx.lineTo(S, (i * S) / n);
          ctx.stroke();
        }
      }
    }, { normalStrength: 1.6, rough: 0.32, roughVar: 0.2 });

    /* --- Terrain detail: a multiplier sheet over the macro map.
     *
     * Round 4 painted this as nine thousand 5-14px strokes on a flat #808080
     * field, which is a single spatial octave at roughly 2cm of ground. Tiled
     * at one repeat per metre that is the highest frequency in the entire
     * terrain, so every mip above the first averaged it back to 0.5 and the
     * ground came back as a smooth gradient from any distance at all - exactly
     * the "untextured flat colour with a soft gradient over it" all three
     * reviews reported. A detail sheet has to carry *every* octave the camera
     * can resolve, from a whole tile down to a texel, or the mip chain eats
     * it. Three passes now: broad soil/turf patches, mid-scale clump and
     * scuff structure, then the fine stroke layer. */
    await this._breathe();
    this._surface('detail', 512, (a, h, S, rnd) => {
      a.fillStyle = '#7d7d7d';
      a.fillRect(0, 0, S, S);
      h.fillStyle = '#7a7a7a';
      h.fillRect(0, 0, S, S);
      // Octave 1 - patch structure at a third to a whole tile. This is the one
      // that survives to the far mips and stops the ground being a gradient.
      for (let k = 0; k < 30; k++) {
        const cx = rnd() * S;
        const cy = rnd() * S;
        const rr = 70 + rnd() * 150;
        const up = rnd() < 0.5;
        const g2 = a.createRadialGradient(cx, cy, 0, cx, cy, rr);
        g2.addColorStop(0, up ? 'rgba(196,190,158,0.40)' : 'rgba(70,72,52,0.42)');
        g2.addColorStop(1, up ? 'rgba(196,190,158,0)' : 'rgba(70,72,52,0)');
        a.fillStyle = g2;
        a.fillRect(cx - rr, cy - rr, rr * 2, rr * 2);
      }
      // Octave 2 - turf clumps, bare scuffs and trodden earth at 6-30cm.
      for (let k = 0; k < 320; k++) {
        const cx = rnd() * S;
        const cy = rnd() * S;
        const rr = 8 + rnd() * 34;
        const bare = rnd() < 0.42;
        const g2 = a.createRadialGradient(cx, cy, 0, cx, cy, rr);
        g2.addColorStop(0, bare ? 'rgba(148,132,98,0.52)' : 'rgba(56,62,38,0.48)');
        g2.addColorStop(0.6, bare ? 'rgba(148,132,98,0.24)' : 'rgba(56,62,38,0.22)');
        g2.addColorStop(1, 'rgba(0,0,0,0)');
        a.fillStyle = g2;
        a.fillRect(cx - rr, cy - rr, rr * 2, rr * 2);
        const hv = bare ? 96 : 168;
        const g3 = h.createRadialGradient(cx, cy, 0, cx, cy, rr);
        g3.addColorStop(0, `rgba(${hv},${hv},${hv},0.55)`);
        g3.addColorStop(1, `rgba(${hv},${hv},${hv},0)`);
        h.fillStyle = g3;
        h.fillRect(cx - rr, cy - rr, rr * 2, rr * 2);
      }
      // Octave 3 - grit and pebbles: hard-edged, so they survive as albedo
      // speckle rather than blurring into the gradients above.
      for (let k = 0; k < 900; k++) {
        const cx = rnd() * S;
        const cy = rnd() * S;
        const rr = 1.2 + rnd() * 3.4;
        const l = 34 + rnd() * 46;
        a.fillStyle = `hsla(${34 + rnd() * 24}, ${6 + rnd() * 12}%, ${l}%, 0.75)`;
        a.beginPath();
        a.ellipse(cx, cy, rr, rr * (0.6 + rnd() * 0.5), rnd() * TAU, 0, TAU);
        a.fill();
        const hv = (110 + l * 1.6) | 0;
        h.fillStyle = `rgb(${hv},${hv},${hv})`;
        h.beginPath();
        h.ellipse(cx, cy, rr, rr * 0.8, 0, 0, TAU);
        h.fill();
      }
      for (let k = 0; k < 9000; k++) {
        const x = rnd() * S;
        const y = rnd() * S;
        const len = 5 + rnd() * 14;
        const ang = rnd() * TAU;
        const v = 42 + rnd() * 26;
        a.strokeStyle = `hsla(${78 + rnd() * 30}, ${10 + rnd() * 22}%, ${v}%, 0.5)`;
        a.lineWidth = 0.9 + rnd() * 1.4;
        a.beginPath();
        a.moveTo(x, y);
        a.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
        a.stroke();
        const hv = (60 + v * 2.2) | 0;
        h.strokeStyle = `rgba(${hv},${hv},${hv},0.5)`;
        h.lineWidth = 1.5;
        h.beginPath();
        h.moveTo(x, y);
        h.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
        h.stroke();
      }
      grain(a, S, 0xe1, 0.2, 'overlay');
      grain(h, S, 0xe1, 0.35, 'overlay');
    }, { normalStrength: 2.0, rough: 0.93, roughVar: 0.12 });
    // The detail albedo is a pure multiplier, so it must not be sRGB-decoded.
    this._tex.detail.map.colorSpace = THREE.NoColorSpace;
    this._tex.detail.map.needsUpdate = true;

    /* --- Cut-out sheets. */
    /* Blades at 512, not 256.
     *
     * A 0.42m tuft card standing a metre from the lens covers four to six
     * hundred screen pixels, so a 256px sheet is being *magnified* two to
     * three times - and a magnified alpha cut-out with a linear filter is
     * definitionally a smear. That is the whole of "the nearest object to
     * camera is a set of mip-blurred green smudges with no blade silhouette":
     * there was no silhouette in the source to resolve. Doubling the sheet and
     * adding a lit midrib and a darker margin to every blade gives the near
     * field real internal edges, and costs 0.75MB once.
     */
    this._cutout('blades', 512, (g, S, rnd) => {
      g.clearRect(0, 0, S, S);
      const n = 17;
      for (let i = 0; i < n; i++) {
        const bx = (i + 0.5) * (S / n) + (rnd() - 0.5) * 12;
        const bw = S / n * (0.34 + rnd() * 0.32);
        const bh = S * (0.42 + rnd() * 0.56);
        const bend = (rnd() - 0.5) * S * 0.26;
        const hue = 76 + rnd() * 28;
        const blade = (shrink, stops) => {
          const grd = g.createLinearGradient(0, S, 0, S - bh);
          grd.addColorStop(0, stops[0]);
          grd.addColorStop(0.55, stops[1]);
          grd.addColorStop(1, stops[2]);
          g.fillStyle = grd;
          g.beginPath();
          g.moveTo(bx - bw * shrink, S);
          g.quadraticCurveTo(bx - bw * 0.6 * shrink + bend * 0.5, S - bh * 0.55, bx + bend, S - bh);
          g.quadraticCurveTo(bx + bw * 0.6 * shrink + bend * 0.5, S - bh * 0.55, bx + bw * shrink, S);
          g.closePath();
          g.fill();
        };
        // Full blade, then a narrower bright midrib inside it. A grass blade
        // is a folded V - it has a lit crease and two shaded flanks - and that
        // one internal edge is what stops a tuft reading as a green triangle.
        blade(1.0, [
          `hsl(${hue}, 38%, 14%)`,
          `hsl(${hue}, 46%, 27%)`,
          `hsl(${hue + 10}, 52%, 44%)`,
        ]);
        blade(0.42, [
          `hsl(${hue - 4}, 34%, 24%)`,
          `hsl(${hue + 4}, 44%, 42%)`,
          `hsl(${hue + 16}, 56%, 62%)`,
        ]);
      }
    }, GRASS_ALPHA_REF);

    this._cutout('reed', 128, (g, S, rnd) => {
      g.clearRect(0, 0, S, S);
      for (let i = 0; i < 7; i++) {
        const bx = (i + 0.5) * (S / 7);
        const bh = S * (0.7 + rnd() * 0.3);
        g.strokeStyle = `hsl(${58 + rnd() * 22}, ${30 + rnd() * 20}%, ${34 + rnd() * 22}%)`;
        g.lineWidth = 2 + rnd() * 2;
        g.beginPath();
        g.moveTo(bx, S);
        g.quadraticCurveTo(bx + (rnd() - 0.5) * 14, S - bh * 0.6, bx + (rnd() - 0.5) * 26, S - bh);
        g.stroke();
        if (rnd() < 0.5) {
          g.fillStyle = '#6b4a28';
          g.beginPath();
          g.ellipse(bx + (rnd() - 0.5) * 26, S - bh, 3, 10, 0, 0, TAU);
          g.fill();
        }
      }
    }, REED_ALPHA_REF);

    this._cutout('spark', 64, (g, S) => {
      const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      grd.addColorStop(0, 'rgba(255,255,255,1)');
      grd.addColorStop(0.3, 'rgba(255,228,180,0.8)');
      grd.addColorStop(1, 'rgba(255,200,120,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, S, S);
    });
  }
  /* ---------------------------------------------------------------- */
  /* Materials                                                         */
  /* ---------------------------------------------------------------- */

  /** Standard PBR material from a generated texture set. */
  _std(key, opts = {}) {
    const t = this._tex[key];
    const m = new THREE.MeshStandardMaterial({
      map: t.map,
      normalMap: t.normalMap,
      roughnessMap: t.roughnessMap,
      aoMap: t.aoMap,
      aoMapIntensity: opts.aoMapIntensity ?? 1.0,
      vertexColors: true,
      ...opts,
    });
    m.name = `medieval.${key}`;
    if (opts.normalScale) m.normalScale.copy(opts.normalScale);
    this._mats[key] = m;
    this._owned.push(m);
    return m;
  }

  /**
   * Break the tiling read on a masonry material.
   *
   * A 512-1024px stone tile at a half-metre UV scale repeats twenty times
   * across a forty-metre curtain wall, and the eye finds the period instantly.
   * Multiplying in two octaves of very low-frequency world-space noise (period
   * ~85m and ~22m) changes the *macro* value from bay to bay, which destroys
   * the repeat without touching the close-up detail. This is the single
   * cheapest thing that makes procedural masonry stop looking procedural.
   *
   * @param {THREE.Material} mat
   * @param {string} key cache-key discriminator
   */
  _macroPatch(mat, key, desync = 0, panel = 0) {
    if (!mat) return;
    /* Optional tiling desync.
     *
     * The macro breaker below kills the *value* repeat but not the *pattern*
     * repeat: a cobbled apron still shows the identical stone arrangement
     * every half-metre, which on a large flat paved area is unmissable. Mixing
     * in a second sample of the same sheet at 31 degrees and 0.43x frequency
     * makes the two periods incommensurate, so no arrangement ever recurs.
     * This is the same trick the terrain already uses on its detail stack. */
    const ds = desync > 0
      ? `{
           vec2 dsUv = vec2(vMapUv.x * 0.857 - vMapUv.y * 0.515,
                            vMapUv.x * 0.515 + vMapUv.y * 0.857) * 0.43;
           vec3 dsT = texture2D( map, dsUv ).rgb;
           diffuseColor.rgb *= mix(vec3(1.0), dsT * 1.95, ${desync.toFixed(3)});
         }`
      : '';
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vMacroPos;')
        .replace(
          '#include <project_vertex>',
          '#include <project_vertex>\nvMacroPos = (modelMatrix * vec4(transformed, 1.0)).xyz;'
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           varying vec3 vMacroPos;
           float mcHash(vec2 p) {
             p = fract(p * vec2(127.31, 311.7));
             p += dot(p, p + 34.19);
             return fract(p.x * p.y);
           }
           float mcNoise(vec2 p) {
             vec2 i = floor(p), f = fract(p);
             f = f * f * (3.0 - 2.0 * f);
             return mix(mix(mcHash(i), mcHash(i + vec2(1.0, 0.0)), f.x),
                        mix(mcHash(i + vec2(0.0, 1.0)), mcHash(i + vec2(1.0, 1.0)), f.x), f.y);
           }`
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
           ${ds}
           {
             vec2 mp = vMacroPos.xz + vMacroPos.y * 0.21;
             float mLo = mcNoise(mp * 0.0118);
             float mHi = mcNoise(mp * 0.046 + 17.3);
             diffuseColor.rgb *= mix(0.76, 1.16, mLo * 0.68 + mHi * 0.32);
             ${panel > 0 ? `
             /* Bay-scale value break.
              *
              * The two octaves above run at ~85m and ~22m, which is right for
              * destroying the repeat on a curtain wall and useless on a
              * cottage: a six-metre gable samples one value of both and comes
              * back as a single unbroken tone, which is exactly what the
              * reviews described. A third octave at roughly 2.4m gives every
              * panel between two studs its own value and its own slight hue,
              * which is how a hand-limed wall actually behaves - each bay was
              * rendered on a different day out of a different bucket.
              */
             vec3 mpn = vec3(mcNoise(vMacroPos.xz * 0.42 + 41.7),
                             mcNoise(vMacroPos.zy * 0.39 + 71.2),
                             mcNoise(vMacroPos.xy * 0.44 + 13.9));
             float mPanel = dot(mpn, vec3(0.5, 0.28, 0.22));
             diffuseColor.rgb *= mix(vec3(1.0),
               vec3(0.74 + mPanel * 0.52, 0.76 + mPanel * 0.48, 0.79 + mPanel * 0.42),
               ${panel.toFixed(3)});
             ` : ''}
           }`
        );
    };
    mat.customProgramCacheKey = () => `medieval-macro-${key}-${desync}-${panel}`;
  }

  /**
   * Backlit foliage - transmitted light, not emission.
   *
   * The previous version pushed `diffuseColor * (wrapBack * 1.15 + wrapSide)`
   * tinted (1.05, 1.18, 0.52) straight into `totalEmissiveRadiance`. Three
   * things were wrong with that and together they produced a self-illuminated
   * nuclear-green mass brighter than the sunlit masonry behind it:
   *
   *  1. emissive bypasses shadowing, AO and every indirect term, so the whole
   *     crown - interior included - glowed uniformly with no terminator;
   *  2. a gain above 1.0 means the transmitted term can exceed the lit
   *     diffuse, which is physically backwards for a leaf;
   *  3. a green-yellow tint stacked on a green albedo and a green instance
   *     colour, so saturation compounded three times.
   *
   * Now it is a gated indirect-diffuse contribution: modest gain, warm-gold
   * tint (light transmitted through a leaf warms, it does not saturate), and a
   * Fresnel-style rim term so only the thin crown edge lights up rather than
   * the whole volume. `aomap_fragment` runs after this, so the baked cavity
   * map still modulates it.
   */
  _leafPatch(mat, gain = 1.0) {
    if (!mat) return;
    const sunView = this._sunViewU;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uSunView = sunView;
      /* ---- Distance LOD on the cut-out itself.
       *
       * Coverage-preserving mips stop the *statistical* erosion, but a crown
       * eighty metres out is thirty pixels across: whether any given pixel
       * lands on a leaf or on a gap is then pure sampling luck, and the crown
       * shimmers frame to frame. Ramping the alpha reference to zero across
       * 24-58m turns the far crowns into the solid lumps they should read as,
       * which is exactly the silhouette the fog then does its work on. Close
       * up nothing changes and the cut-out is still a cut-out. */
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vLeafDist;')
        .replace('#include <project_vertex>',
          '#include <project_vertex>\nvLeafDist = -mvPosition.z;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>',
          '#include <common>\nuniform vec3 uSunView;\nvarying float vLeafDist;')
        .replace(
          '#include <alphatest_fragment>',
          `#ifdef USE_ALPHATEST
             float lfRef = alphaTest * (1.0 - smoothstep(24.0, 58.0, vLeafDist));
             #ifdef ALPHA_TO_COVERAGE
               diffuseColor.a = smoothstep(lfRef, lfRef + fwidth(diffuseColor.a), diffuseColor.a);
               if ( diffuseColor.a == 0.0 ) discard;
             #else
               if ( diffuseColor.a < lfRef ) discard;
             #endif
           #endif`
        )
        .replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
           {
             vec3 lfN = geometryNormal;
             float wrapBack = pow(max(dot(-lfN, uSunView), 0.0), 2.6);
             float wrapSide = pow(max(dot(lfN, uSunView), 0.0), 1.6);
             float lfRim = pow(1.0 - abs(dot(lfN, geometryViewDir)), 1.5);
             float lfTrans = (wrapBack * 0.45 + wrapSide * 0.16) * (0.28 + 0.72 * lfRim);
             reflectedLight.indirectDiffuse += diffuseColor.rgb * lfTrans
               * vec3(1.0, 0.92, 0.55) * ${gain.toFixed(3)};
           }`
        );
    };
    mat.customProgramCacheKey = () => `medieval-leaf-translucent-${gain}`;
  }

  _buildMaterials() {
    this._std('ashlar', { roughness: 1, metalness: 0 });
    this._std('flagstone', { roughness: 1, metalness: 0 });
    this._std('rubble', { roughness: 1, metalness: 0 });
    // Wet-laid setts are the flattest surface in the world and the one that
    // covers most of the frame in a street shot. A full-strength sky probe on
    // it lifts the whole paved area toward the sky value and is half of why
    // the aprons read as a sheet of white; 0.32 keeps a hint of dusk in the
    // hollows without letting the probe wash the surface out.
    this._std('cobble', { roughness: 1, metalness: 0, envMapIntensity: 0.32 });
    this._std('plank', { roughness: 1, metalness: 0 });
    this._std('beam', { roughness: 1, metalness: 0 });
    // Panels between studs are 1.5-2.5m of bare render. Without a hard normal
    // gain the low sun finds nothing to model on them and every gable in the
    // village reads as a flat cream rectangle.
    this._std('daub', {
      roughness: 1,
      metalness: 0,
      normalScale: new THREE.Vector2(2.4, 2.4),
      // Lime render is chalk-matte and it is the largest light-value surface
      // in the village. A full sky probe on it lifts every panel toward the
      // sky value and is a quiet contributor to the "flat cream" read.
      envMapIntensity: 0.62,
    });
    this._std('thatch', { roughness: 1, metalness: 0 });
    this._std('slate', { roughness: 1, metalness: 0.04 });
    this._std('iron', { roughness: 1, metalness: 0.82 });
    this._std('alloy', { roughness: 1, metalness: 0.95, envMapIntensity: 1.6 });
    this._std('bark', { roughness: 1, metalness: 0 });
    this._std('rock', { roughness: 1, metalness: 0 });
    // Straw needs a hard normal gain or a 12-sided bale reads as a printed
    // drum: at 1.0 the height field was producing no visible lighting break at
    // all and the only silhouette information was the polygon edges.
    this._std('hay', { roughness: 1, metalness: 0, normalScale: new THREE.Vector2(1.7, 1.7) });
    this._std('leaf', {
      roughness: 1,
      metalness: 0,
      side: THREE.DoubleSide,
      alphaTest: LEAF_ALPHA_REF,
      // MSAA 4x on the composer target means the hardware can resolve the
      // cut-out edge across four sub-samples instead of one binary test per
      // pixel. Combined with the coverage-preserving mip chain this is what
      // stops a treeline at 60-150m from turning into dithered sparkle.
      alphaToCoverage: true,
      transparent: false,
      // Baked canopy occlusion already lives in the vertex colours; a full
      // strength cavity map on top would crush the crown to black.
      aoMapIntensity: 0.5,
      // A leaf has a waxy cuticle, but a *canopy* seen at 60-150m is a
      // volume, not a surface, and a sky probe on it puts a specular sheen
      // along the crown tops that reads as frost. 0.22 keeps a trace of sky in
      // the shadowed interior and nothing on the highlights.
      envMapIntensity: 0.22,
    });
    this._std('canopy', {
      roughness: 1, metalness: 0, side: THREE.DoubleSide, envMapIntensity: 0.45,
    });
    // Window emissive is deliberately under 1.0 post-tonemap: it was feeding
    // the bloom pass harder than the sun and eating its own mullions.
    this._std('glass', {
      roughness: 1,
      metalness: 0,
      emissive: new THREE.Color(0xff9c3c),
      /* Raised from 0.78, which put the pane at ~0.35 linear - a third of the
       * way to the bloom high-pass, so a whole village of lit interiors could
       * not produce one glowing pixel and every window was a hard-edged orange
       * quad. 2.4 lands at ~1.08 linear, just over the 0.95 threshold, so the
       * panes bloom softly and the halo cards around them finally have
       * something to be a halo *of*. */
      /* Round 5: 2.9 put the whole pane a long way over the 1.15 high-pass, so
       * every window clipped to a uniform blown rectangle and bloomed as a
       * solid block - which is why they read as flat quads with no interior
       * depth. 2.05 lands the pane just under the threshold and lets the
       * emissive map's bright spots be the only part that crosses it, so the
       * glow comes off the highlights in the glazing rather than off the
       * entire opening, and the new mullions have something to be dark
       * against. */
      emissiveIntensity: 2.05,
      emissiveMap: this._tex.glass.map,
    });
    // Forge coals, brazier fire, lantern panes: pure emissive, no lighting.
    const ember = new THREE.MeshStandardMaterial({
      color: 0x140a04,
      emissive: new THREE.Color(0xff6a12),
      // Forge coals and brazier fire are the brightest thing in the world and
      // must clear the bloom high-pass; at 2.1 they sat at 0.67 linear, under
      // it, so the smithy at dusk had no glow at all.
      emissiveIntensity: 4.2,
      roughness: 1,
      vertexColors: true,
    });
    this._mats.ember = ember;
    this._owned.push(ember);

    // Every tiled surface that covers more than a couple of metres needs the
    // macro breaker, not just the masonry: a hay drum showing the identical
    // dash band fifteen times up its side is the same failure as a repeating
    // curtain wall, just at prop scale.
    for (const k of ['ashlar', 'flagstone', 'rubble', 'hay', 'plank']) {
      this._macroPatch(this._mats[k], k);
    }
    // The three surfaces that cover the largest continuous areas, and so are
    // the three where the pattern period itself is visible.
    this._macroPatch(this._mats.cobble, 'cobble', 0.40);
    this._macroPatch(this._mats.thatch, 'thatch', 0.28);
    this._macroPatch(this._mats.daub, 'daub', 0.22, 0.85);
    // 1.0 was letting the transmitted term rival the lit diffuse on backlit
    // crowns, which bleached the mid-distance conifers to near-white cones.
    this._leafPatch(this._mats.leaf, 0.7);

    // Banner cloth flutters in the vertex shader; uv.x is 0 at the pole.
    const banner = this._std('banner', { roughness: 1, metalness: 0, side: THREE.DoubleSide });
    const timeU = this._timeU;
    banner.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = timeU;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           float bAnchor = clamp(uv.x, 0.0, 1.0);
           float bDrop = clamp(uv.y, 0.0, 1.0);
           float bPh = transformed.x * 0.32 + transformed.z * 0.28 + transformed.y * 0.15;
           float bAmp = bAnchor * bAnchor * 0.18;
           transformed.z += sin(uTime * 2.4 + bPh + bDrop * 3.4) * bAmp;
           transformed.x += cos(uTime * 1.9 + bPh * 1.3 + bDrop * 2.2) * bAmp * 0.55;
           transformed.y -= bAmp * 0.25;`
        );
    };
    banner.customProgramCacheKey = () => 'medieval-banner';

    // Grass and reeds: alpha-cut cards that bend with the wind. They do not
    // cast shadows - the depth material has no wind term and the mismatch
    // would read as a bug, and 20k shadow casters is not affordable anyway.
    const sunViewU = this._sunViewU;
    const windPatch = (mat, strength, trans, fade0, fade1) => {
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = timeU;
        shader.uniforms.uSunView = sunViewU;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uTime;')
          .replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
             #ifdef USE_INSTANCING
               vec3 gOrigin = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
             #else
               vec3 gOrigin = vec3(0.0);
             #endif
             float gPh = gOrigin.x * 0.28 + gOrigin.z * 0.21;
             float gGust = 0.65 + 0.35 * sin(uTime * 0.27 + gOrigin.x * 0.02 + gOrigin.z * 0.017);
             float gBend = sin(uTime * 1.7 + gPh) * 0.6 + sin(uTime * 2.9 + gPh * 1.8) * 0.28;
             float gUp = max(transformed.y, 0.0);
             float gW = gBend * gGust * gUp * gUp * ${strength.toFixed(3)};
             transformed.x += gW * 0.86;
             transformed.z += gW * 0.51;
             /* Distance fade. A 25cm blade past forty metres is a sub-pixel
              * cut-out - it cannot resolve, it can only alias, and a hillside
              * of them reads as crawling speckle. Sinking the blade back into
              * the ground over ${fade0}-${fade1}m hands the far hills to the
              * terrain macro map, which is what should be carrying them, and
              * buys back the fill rate that pays for the density up close. */
             {
               vec4 gWorld = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
               #ifdef USE_INSTANCING
                 gWorld = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
               #endif
               float gD = distance(gWorld.xyz, cameraPosition);
               transformed.y *= 1.0 - smoothstep(${fade0.toFixed(1)}, ${fade1.toFixed(1)}, gD);
             }`
          );
        // Blades are card geometry with a forced +Y normal, so without a
        // transmission term every blade facing away from the key renders as a
        // flat dark triangle sitting on lit ground. Wrapped diffuse against
        // the low sun is what makes a field glow at dusk.
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform vec3 uSunView;')
          // The geometry's normals are forced to +Y on the CPU so blades shade
          // off the ground plane, but these are two-sided cards and three flips
          // the normal on back faces - so half of every tuft ended up shading
          // against -Y and rendered as a black spike. Pin it in the fragment
          // instead, where the face direction has already been applied.
          .replace(
            '#include <normal_fragment_begin>',
            `#include <normal_fragment_begin>
             normal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);`
          )
          .replace(
            '#include <lights_fragment_end>',
            `#include <lights_fragment_end>
             {
               float gWrap = pow(max(dot(-geometryNormal, uSunView), 0.0), 1.6) * 0.5
                           + pow(max(dot(geometryNormal, uSunView), 0.0), 1.2) * 0.3;
               reflectedLight.indirectDiffuse += diffuseColor.rgb * gWrap
                 * vec3(1.0, 0.93, 0.60) * ${trans.toFixed(3)};
             }`
          );
      };
      mat.customProgramCacheKey = () => `medieval-wind-${strength}-${trans}-${fade0}`;
    };

    const grass = new THREE.MeshStandardMaterial({
      map: this._tex.blades.map,
      alphaTest: GRASS_ALPHA_REF,
      alphaToCoverage: true,
      side: THREE.DoubleSide,
      roughness: 0.94,
      metalness: 0,
      vertexColors: true,
    });
    // 46-68 left the whole mid-ground of the castle-approach framing bald -
    // a large open field carrying no vegetation at all while the foreground
    // had some, which reads as a LOD pop rather than as a meadow. The cards
    // are larger now, so they still resolve at eighty metres.
    windPatch(grass, 0.30, 0.80, 58, 86);
    this._mats.grass = grass;
    this._owned.push(grass);

    const reed = new THREE.MeshStandardMaterial({
      map: this._tex.reed.map,
      alphaTest: REED_ALPHA_REF,
      alphaToCoverage: true,
      side: THREE.DoubleSide,
      roughness: 0.9,
      metalness: 0,
      vertexColors: true,
    });
    windPatch(reed, 0.22, 0.65, 84, 118);
    this._mats.reed = reed;
    this._owned.push(reed);

    // Birds read as backlit silhouettes; the timber set gives them grain.
    const bird = new THREE.MeshStandardMaterial({
      map: this._tex.beam.map,
      color: 0x2a231c,
      roughness: 0.95,
      metalness: 0,
      side: THREE.DoubleSide,
      vertexColors: true,
    });
    this._mats.bird = bird;
    this._owned.push(bird);

    this._buildSkyMaterial();
    this._buildWaterMaterial();
    this._buildEnvMap();
  }
  /* ---------------------------------------------------------------- */
  /* Sky, water and image-based lighting                               */
  /* ---------------------------------------------------------------- */

  _skyPalette() {
    const out = {};
    for (const k of Object.keys(SKY_HEX)) out[k] = new THREE.Color(SKY_HEX[k]);
    return out;
  }

  /**
   * Scene fog / distance haze colour, derived from the sky's own horizon band
   * pulled a third of the way toward the cloud shadow so it sits fractionally
   * cooler and darker than the sky it fades into. Fog and sky can no longer
   * diverge because there is only one number to change.
   */
  static _hazeColor() {
    // Deliberately *darker* than the horizon band it sits under, and warm.
    //
    // The previous 0.30 mix landed on (200,170,152) - lighter than most of the
    // ground it was applied to - so every distant plane was lifted toward the
    // sky value and the castle, the hills and the far treeline collapsed into
    // one pale band. Real golden-hour aerial perspective desaturates and warms
    // a distant plane but keeps it clearly *below* the sky it silhouettes
    // against; that value gap is the entire depth cue.
    return new THREE.Color(SKY_HEX.horizon)
      .lerp(new THREE.Color(SKY_HEX.cloudDark), 0.46)
      .multiplyScalar(0.9);
  }

  _buildSkyMaterial() {
    const p = this._skyPalette();
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      uniforms: {
        uTime: this._timeU,
        uSunDir: { value: this.environment.sunDirection.clone() },
        uZenith: { value: p.zenith },
        uHorizon: { value: p.horizon },
        uGround: { value: p.ground },
        uSunTint: { value: p.sunTint },
        uSunCore: { value: p.sunCore },
        uCloudLit: { value: p.cloudLit },
        uCloudDark: { value: p.cloudDark },
        uHaze: { value: this.environment.fogColor.clone() },
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform vec3 uSunDir, uZenith, uHorizon, uGround, uSunTint, uSunCore, uCloudLit, uCloudDark, uHaze;
        varying vec3 vDir;

        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }
        float vnoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          float a = hash21(i);
          float b = hash21(i + vec2(1.0, 0.0));
          float c = hash21(i + vec2(0.0, 1.0));
          float d = hash21(i + vec2(1.0, 1.0));
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }
        float fbm(vec2 p) {
          float v = 0.0, a = 0.55;
          for (int i = 0; i < 5; i++) { v += a * vnoise(p); p *= 2.07; a *= 0.5; }
          return v;
        }

        void main() {
          vec3 d = normalize(vDir);
          float up = clamp(d.y, 0.0, 1.0);
          vec3 col = mix(uHorizon, uZenith, pow(up, 0.42));
          col = mix(uGround, col, smoothstep(-0.14, 0.015, d.y));

          // The sun is a small, discrete, very bright disc rather than a broad
          // glow: a wide halo is what was smearing across the whole upper frame
          // and dragging non-emissive geometry over the bloom threshold.
          float sd = max(dot(d, uSunDir), 0.0);
          col += uSunTint * pow(sd, 6.0) * 0.28 * (1.0 - up * 0.55);
          col += uSunTint * pow(sd, 60.0) * 0.70 + uSunTint * pow(sd, 900.0) * 1.5;
          col += uSunCore * smoothstep(0.99952, 0.99986, sd) * 6.0;

          if (d.y > 0.004) {
            vec2 cp = d.xz / max(d.y, 0.02);
            float horizonFade = smoothstep(0.004, 0.17, d.y);

            // Mid-deck altostratus: the layer that gives the sky structure and
            // sells the time of day.
            /* Cloud UV scale.
             *
             * This was the bug that made a sky full of authored cloud code
             * render as a bare two-colour ramp. cp is a planar projection,
             * so its magnitude runs from ~0 at the zenith to ~6 near the
             * horizon; at 0.019 the entire visible dome sampled the fbm inside
             * a 0.1-unit window, which is one smooth interpolant - a constant.
             * The deck existed, it was just being sampled at a frequency a
             * hundred times too low to have any structure in it. */
            vec2 uvM = cp * 0.62 + vec2(uTime * 0.0016, uTime * 0.0006);
            float nM = fbm(uvM * 1.5);
            float nM2 = fbm(uvM * 4.1 + nM * 0.9);
            // The deck was authored but invisible at this exposure: a 0.36-0.78
            // window on a 0-1 fbm leaves almost nothing above threshold, so the
            // sky was a featureless ramp with one focal element (the sun) and
            // no counterweight opposite the castle. A wider window and full
            // opacity give a real cumulus mass to catch the key.
            float densM = smoothstep(0.28, 0.63, nM * 0.68 + nM2 * 0.42) * horizonFade;

            // High cirrus, thinner, faster, stretched along the wind.
            // Stretched ~6:1 along the wind, which is what makes cirrus read
            // as cirrus rather than as a second layer of the same cumulus.
            vec2 uvC = cp * vec2(0.26, 1.55) + vec2(uTime * 0.0042, uTime * 0.0014);
            float nC = fbm(uvC * 2.3);
            float densC = smoothstep(0.46, 0.82, nC) * horizonFade * 0.58;

            // Sun-adjacent edges silver out; the away side stays cool violet.
            float lit = clamp(pow(sd * 0.5 + 0.5, 2.4) + nM2 * 0.35, 0.0, 1.0);
            vec3 cc = mix(uCloudDark, uCloudLit, lit);
            cc += uSunTint * pow(sd, 26.0) * 0.85;
            col = mix(col, cc * 0.94, densM);
            col = mix(col, mix(uCloudDark, uCloudLit, clamp(lit + 0.25, 0.0, 1.0)), densC);

            /* Low stratus banked on the horizon.
             *
             * Without it the bottom of the sky is a clean analytic ramp
             * meeting a clean analytic ridge, and a hard geometric horizon is
             * the loudest tell there is that a landscape was generated. This
             * band sits *behind* the far hills and breaks that line. */
            vec2 uvS = cp * vec2(0.17, 0.055) + vec2(uTime * 0.0011, 0.0);
            float nS = fbm(uvS * 1.9);
            float bandS = smoothstep(0.20, 0.035, d.y) * smoothstep(0.006, 0.030, d.y);
            float densS = smoothstep(0.34, 0.70, nS) * bandS * 0.66;
            col = mix(col, mix(uCloudDark, uCloudLit, clamp(lit * 0.8 + 0.12, 0.0, 1.0)) * 0.92, densS);
          }

          /* Aerial-perspective band.
           *
           * This has to reach *full* haze exactly at d.y = 0. Terrain past
           * fogFar is saturated to precisely uHaze, so if the dome only gets
           * 66% of the way there at the horizon line the two sit a third of the
           * fog delta apart - and because the far skirt is nearly edge-on that
           * shows up as a crisp dark hairline ruled right across the horizon in
           * every elevated framing. Landing both on the same colour is what
           * makes the distant hills dissolve into the sky instead. */
          col = mix(col, uHaze, smoothstep(0.10, 0.0, d.y));

          // Ordered-ish dither. The dome is evaluated in float but composited
          // to 8 bits, and a 40-degree gradient across 1080 lines quantises
          // into visible horizontal bands in the pink-to-mauve transition.
          col += (hash21(gl_FragCoord.xy) - 0.5) * (1.6 / 255.0);

          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    mat.name = 'medieval.sky';
    this._mats.sky = mat;
    this._owned.push(mat);
  }

  _buildWaterMaterial() {
    const p = this._skyPalette();
    const u = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]);
    u.uTime = this._timeU;
    u.uSunDir = { value: this.environment.sunDirection.clone() };
    u.uSunColor = { value: new THREE.Color(0xffd7a0) };
    u.uSkyTop = { value: p.zenith.clone() };
    u.uSkyHorizon = { value: p.horizon.clone() };
    // Looking steeply down, fresnel is near zero and the body colour is all you
    // see - at 0x14251d that was a sheet of dark mud filling the foreground of
    // the whole riverside framing.
    u.uDeep = { value: new THREE.Color(0x1c3026) };
    u.uShallow = { value: new THREE.Color(0x3b6650) };
    u.uFoam = { value: new THREE.Color(0xbcc9bd) };

    const mat = new THREE.ShaderMaterial({
      uniforms: u,
      fog: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      vertexShader: `
        #include <common>
        #include <fog_pars_vertex>
        uniform float uTime;
        varying vec3 vWorld;
        varying vec3 vWNormal;
        varying vec2 vUvW;
        void main() {
          vUvW = uv;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          float t = uTime;
          float a1 = wp.x * 0.55 + t * 1.35;
          float a2 = wp.z * 0.71 - t * 1.05 + wp.x * 0.20;
          float a3 = (wp.x + wp.z) * 1.90 + t * 2.40;
          wp.y += sin(a1) * 0.055 + sin(a2) * 0.045 + sin(a3) * 0.018;
          float dx = cos(a1) * 0.0302 + cos(a2) * 0.0090 + cos(a3) * 0.0342;
          float dz = cos(a2) * 0.0320 + cos(a3) * 0.0342;
          vWNormal = normalize(vec3(-dx, 1.0, -dz));
          vWorld = wp.xyz;
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: `
        #include <common>
        #include <fog_pars_fragment>
        uniform float uTime;
        uniform vec3 uSunDir, uSunColor, uSkyTop, uSkyHorizon, uDeep, uShallow, uFoam;
        varying vec3 vWorld;
        varying vec3 vWNormal;
        varying vec2 vUvW;
        void main() {
          /* Surface ripple.
           *
           * The previous pair of axis-aligned sines shared a common direction,
           * so the perturbation was coherent across the whole sheet and the low
           * sun's glitter resolved as hard parallel zebra bands running the
           * full width of the river. Four incommensurate wave vectors at
           * unrelated angles and speeds never line up, so the same energy
           * scatters into sparkle instead of stripes. */
          vec2 wxz = vWorld.xz;
          float r1 = sin(dot(wxz, vec2( 6.70,  2.31)) + uTime * 3.10);
          float r2 = sin(dot(wxz, vec2(-3.13,  8.87)) - uTime * 2.37);
          float r3 = sin(dot(wxz, vec2(13.70,-11.30)) + uTime * 4.73);
          float r4 = sin(dot(wxz, vec2(23.10, 19.70)) - uTime * 6.11);
          // Perturb the interpolated surface normal. Declared here because the
          // only normal in scope is the vWNormal varying - a bare ShaderMaterial
          // gets no N from a three.js shader chunk.
          vec3 N = normalize(vWNormal + vec3(
            r1 * 0.048 + r2 * 0.030 + r3 * 0.020 + r4 * 0.012, 0.0,
            r2 * 0.044 - r1 * 0.028 + r3 * 0.018 - r4 * 0.011));

          vec3 V = normalize(cameraPosition - vWorld);
          float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);
          fres = mix(0.07, 0.80, fres);

          vec3 R = reflect(-V, N);
          vec3 sky = mix(uSkyHorizon, uSkyTop, pow(clamp(R.y, 0.0, 1.0), 0.45)) * 0.58;
          float sd = max(dot(R, uSunDir), 0.0);
          // Tight glint stays; the broad 18-power lobe was a wide wash that
          // painted the banding across half the frame rather than sparkling.
          sky += uSunColor * pow(sd, 300.0) * 3.4;
          sky += uSunColor * pow(sd, 46.0) * 0.10;

          float across = abs(vUvW.x * 2.0 - 1.0);
          vec3 body = mix(uDeep, uShallow, across * across);
          body += uSunColor * max(dot(N, uSunDir), 0.0) * 0.09;

          vec3 col = mix(body, sky, fres);
          float foam = smoothstep(0.80, 0.995, across + sin(vUvW.y * 34.0 + uTime * 1.1) * 0.05);
          col = mix(col, uFoam, foam * 0.34);

          gl_FragColor = vec4(col, clamp(mix(0.86, 1.0, fres) + foam * 0.12, 0.0, 1.0));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }
      `,
    });
    mat.name = 'medieval.water';
    this._mats.water = mat;
    this._owned.push(mat);
  }

  /**
   * Bake the analytic sky into an equirectangular float texture and prefilter
   * it. Without IBL, standard materials go dead flat in the shadowed half of
   * a golden-hour scene; this is what puts warm bounce back into the stone.
   */
  /**
   * THE WIDTH IS A PROGRAM CACHE KEY, NOT A QUALITY DIAL.
   *
   * `PMREMGenerator.fromEquirectangular` sizes its cube from `image.width / 4`
   * and nothing else, and the resulting `envMapCubeUVHeight` is one of the
   * fields Three folds into every program's cache key. At the 192 this used to
   * be, medieval's prefiltered map came out 128 high while every other
   * environment in the game - `Materials.getEnvMap`, sports, the yard, all of
   * which go through `fromScene`, whose default cube is 256 - came out 1024.
   *
   * So arriving in the vale changed a cache key for every physical material on
   * screen, including the player's own avatar and viewmodels, which no world
   * warm can reach because they are not in any world's group. Measured on the
   * production bundle: 24 of the 28 programs the arrival frame linked differed
   * from an existing program in `envMapCubeUVHeight` and in nothing else.
   *
   * 1024 puts `_setSize` at 256 and the cube at the same 1024 as everything
   * else, so the key stops moving and those programs cease to exist rather
   * than being warmed around. This is the same fix as the light-slot pooling
   * in gfx/LightRig.js, for the same reason: a cache-key ingredient that
   * varies per world costs the whole program set at every crossing.
   *
   * The bake is a smooth analytic sky, so the extra resolution buys little and
   * costs a one-off pass behind the loading screen; it is here for the key.
   * The 8 MB float buffer is transient - `equirect.dispose()` is three lines
   * below the upload.
   */
  _buildEnvMap() {
    const W = 1024;
    const H = 512;
    const p = this._skyPalette();
    const sun = this.environment.sunDirection;
    const data = new Float32Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      const theta = ((y + 0.5) / H - 0.5) * Math.PI;
      const cy = Math.sin(theta);
      const cr = Math.cos(theta);
      for (let x = 0; x < W; x++) {
        const phi = ((x + 0.5) / W - 0.5) * TAU;
        const dx = cr * Math.cos(phi);
        const dz = cr * Math.sin(phi);
        const up = clamp01(cy);
        const g = Math.pow(up, 0.42);
        let r = lerp(p.horizon.r, p.zenith.r, g);
        let gg = lerp(p.horizon.g, p.zenith.g, g);
        let b = lerp(p.horizon.b, p.zenith.b, g);
        const below = 1 - smoothstep(-0.14, 0.015, cy);
        r = lerp(r, p.ground.r, below);
        gg = lerp(gg, p.ground.g, below);
        b = lerp(b, p.ground.b, below);
        const sd = Math.max(dx * sun.x + cy * sun.y + dz * sun.z, 0);
        const halo = Math.pow(sd, 5) * 0.42 + Math.pow(sd, 80) * 1.7;
        const core = sd > 0.9994 ? 9 : 0;
        r += p.sunTint.r * halo + p.sunCore.r * core;
        gg += p.sunTint.g * halo + p.sunCore.g * core;
        b += p.sunTint.b * halo + p.sunCore.b * core;
        const i = (y * W + x) * 4;
        data[i] = r;
        data[i + 1] = gg;
        data[i + 2] = b;
        data[i + 3] = 1;
      }
    }
    const equirect = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
    equirect.mapping = THREE.EquirectangularReflectionMapping;
    equirect.colorSpace = THREE.NoColorSpace;
    equirect.minFilter = THREE.LinearFilter;
    equirect.magFilter = THREE.LinearFilter;
    equirect.needsUpdate = true;

    const pmrem = new THREE.PMREMGenerator(this.engine.renderer);
    this._envRT = pmrem.fromEquirectangular(equirect);
    pmrem.dispose();
    equirect.dispose();
    this.environment.envMap = this._envRT.texture;
    this._owned.push(this._envRT);
  }
  /* ---------------------------------------------------------------- */
  /* Terrain                                                           */
  /* ---------------------------------------------------------------- */

  /** Flatten the road splines once; the macro map, props and minimap share it. */
  _buildRoadPaths() {
    this._roadPaths = [];
    const segs = [];
    for (const road of ROADS) {
      const curve = new THREE.CatmullRomCurve3(
        road.pts.map(([x, z]) => new THREE.Vector3(x, 0, z)),
        false,
        'catmullrom',
        0.5
      );
      const n = Math.max(8, Math.ceil(curve.getLength() / 2.5));
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const p = curve.getPoint(i / n);
        pts.push([p.x, p.z]);
      }
      this._roadPaths.push({ key: road.key, width: road.width, pts });
      for (let i = 0; i < pts.length - 1; i++) {
        segs.push(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], road.width);
      }
    }
    this._roadSegs = segs;
    this._buildVillageLanes(segs);
  }

  /**
   * Author the ground people actually walk on.
   *
   * Houses standing in unbroken meadow is the single loudest "props dropped on
   * a lawn" tell there is, and no amount of lighting fixes it. Every dwelling
   * gets (a) a paved yard wrapping its footprint so the doorstep has a
   * threshold, and (b) a lane from its door to the nearest existing street, so
   * the settlement reads as a circulation network rather than a scatter.
   *
   * Lanes are generated rather than hand-drawn so they can never be routed
   * through a neighbour: any candidate whose centreline enters another plot is
   * discarded outright.
   *
   * @param {number[]} segs flat road segment list, extended in place
   */
  _buildVillageLanes(segs) {
    const yards = [];
    for (const [x, z, r, w, d] of PLOTS) yards.push({ x, z, r, w, d });
    for (const e of EXTRA_YARDS) yards.push(e);

    /* `bx`/`bz` are the *building* half-extents, kept alongside the apron's
     * own. The apron builder needs them to bake a wall-proximity darkening
     * ramp into the paving's vertex colours - without knowing where the wall
     * is, the cobble runs at full value right up to the plaster and every
     * house in the village reads as pasted onto the ground. */
    this._pavedRects = yards.map((y) => ({
      x: y.x, z: y.z, r: y.r, hx: y.w / 2 + 2.1, hz: y.d / 2 + 2.1,
      bx: y.w / 2, bz: y.d / 2,
    }));

    /** Nearest point on the existing street network, or null past `maxD`. */
    const nearestRoad = (px, pz, maxD) => {
      let best = maxD * maxD;
      let bx = 0;
      let bz = 0;
      let found = false;
      for (let i = 0; i < segs.length; i += 5) {
        const ax = segs[i];
        const az = segs[i + 1];
        const ex = segs[i + 2] - ax;
        const ez = segs[i + 3] - az;
        const len = ex * ex + ez * ez;
        let t = len > 1e-6 ? ((px - ax) * ex + (pz - az) * ez) / len : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = ax + ex * t;
        const cz2 = az + ez * t;
        const dd = (px - cx) * (px - cx) + (pz - cz2) * (pz - cz2);
        if (dd < best) {
          best = dd;
          bx = cx;
          bz = cz2;
          found = true;
        }
      }
      return found ? [bx, bz, Math.sqrt(best)] : null;
    };

    const LANE_W = 3.0;
    for (let i = 0; i < yards.length; i++) {
      const y = yards[i];
      // The door is on local +Z; walk out of it before looking for a street.
      const fx = Math.sin(y.r);
      const fz = Math.cos(y.r);
      const px = y.x + fx * (y.d / 2 + 2.2);
      const pz = y.z + fz * (y.d / 2 + 2.2);
      const hit = nearestRoad(px, pz, 30);
      if (!hit || hit[2] < 2.5) continue;

      const [tx, tz, dist] = hit;
      const n = Math.max(2, Math.round(dist / 4));
      const pts = [];
      let blocked = false;
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        const lx = px + (tx - px) * t;
        const lz = pz + (tz - pz) * t;
        for (let j = 0; j < yards.length; j++) {
          if (j === i) continue;
          const o = yards[j];
          const dx = lx - o.x;
          const dz = lz - o.z;
          const c = Math.cos(o.r);
          const s = Math.sin(o.r);
          if (rectDist(dx * c - dz * s, dx * s + dz * c, o.w / 2 + 1.0, o.d / 2 + 1.0) < 0) {
            blocked = true;
            break;
          }
        }
        if (blocked) break;
        pts.push([lx, lz]);
      }
      if (blocked || pts.length < 2) continue;

      this._roadPaths.push({ key: `lane${i}`, width: LANE_W, pts, minimap: false });
      for (let k = 0; k < pts.length - 1; k++) {
        segs.push(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1], LANE_W);
      }
    }
  }

  /** True inside any paved yard - vegetation must not grow through cobbles. */
  _isPaved(x, z, margin = 0) {
    const rects = this._pavedRects;
    if (!rects.length) return false;
    // sqrt(2) for the same reason as `_inFootprint` - the margin inflates the
    // rect in its own rotated frame, not in world axes.
    const m = margin > 0 ? margin * Math.SQRT2 : 0;
    const hits = this._pavedGrid().query(x - m, z - m, x + m, z + m);
    for (let i = 0; i < hits.length; i++) {
      const p = rects[hits[i]];
      const dx = x - p.x;
      const dz = z - p.z;
      // Inverse of Matrix4.makeRotationY(r), which is what the apron mesh and
      // the house transform both use.
      const c = Math.cos(p.r);
      const s = Math.sin(p.r);
      if (rectDist(dx * c - dz * s, dx * s + dz * c, p.hx + margin, p.hz + margin) < 0) return true;
    }
    return false;
  }

  /**
   * How settled a point is: 0 = open pasture, 1 = beaten earth people stand on.
   *
   * The definition moved to `medieval/Settlements.js` and now derives from the
   * settlement table rather than from a hand-written list of plots plus a
   * hard-coded rejection box. Three things made that necessary:
   *
   *   - The box (`x < -126 || x > 122 || z < -106 || z > 96`) was measured off
   *     the settlements of the day, and was already clipping five of them: the
   *     castle-approach hamlet's yards and the northern third of the mill's
   *     were being silently zeroed. Derived bounds fix that as a side effect.
   *   - A box authored for a 400m vale cannot be right for a 900m one, and
   *     nothing would have told us it was wrong - it fails by returning 0,
   *     which looks exactly like open pasture.
   *   - A settlement added by a later phase has to get its beaten earth
   *     without anyone remembering to widen a literal here.
   *
   * Kept as a method because it is the authority every ground pass reads, and
   * `this._settled` is the name all of them already call.
   */
  _settled(x, z) {
    return settledAt(x, z);
  }

  /** Paint the 2048px macro albedo: grass, dry banks, mud, rock and verges. */
  async _paintMacro() {
    const S = 2048;
    /* Source resolution.
     *
     * 256 painted texels stretched over the vale was 0.64 texels per metre at
     * 400m: at that density the entire ground plane inside twenty metres of
     * the lens carried no albedo information whatsoever, which is why the
     * village-square frame read as a smeared out-of-focus wash. 1024 was
     * 2.56 texels/m over a 400m vale.
     *
     * This is a fixed G x G loop, so widening the world does not make it
     * slower - it makes it BLURRIER. At 900m a 1024 grid is 1.14 texels/m,
     * less than half the density the numbers above were tuned at, and the
     * roads, mud and silt stop surviving the resample to the 2048 canvas as
     * edges. 1536 puts it back to 1.71/m.
     *
     * Measured rather than guessed, over the arithmetic that dominates it
     * (`_height` for the pre-pass, then `_settled` + slope + five noise
     * octaves per pixel), on the 900m field:
     *
     *     G = 1024   0.879 m/sample   251ms heights + 239ms pixels =  489ms
     *     G = 1536   0.586 m/sample   561ms heights + 537ms pixels = 1098ms
     *
     * For reference the same G = 1024 loop over the OLD 400m vale cost 566ms -
     * MORE than it costs over 900m, because `_settled` now rejects nine tenths
     * of the field on a bounding box instead of scanning thirty-seven plots.
     * So the whole expansion pays for the resolution increase and change.
     *
     * 1.1s of background build time, sliced by `_breathe` into ~6ms pieces
     * while the station is still rendering, is worth 1.5x the ground detail.
     * If this ever needs to go further, the move is to sample it on the worker
     * - it is pure arithmetic over a height field the worker already has - not
     * to keep raising G on the main thread.
     *
     * The landform phase then made `medievalHeight` 1.29x more expensive - the
     * ring's ridged relief octaves and the varied river reach - so the heights
     * half of the G = 1536 row above is now ~724ms and the whole pass ~1.26s.
     * That is the single largest cost this expansion added, it is all
     * background build time, and this loop is where it would be paid back:
     * moving it to the worker is now worth roughly a quarter of a second more
     * than it was.
     */
    const G = 1536;
    const heights = new Float32Array(G * G);
    for (let j = 0; j < G; j++) {
      if ((j & 63) === 0) await this._breathe();
      const z = (j / (G - 1)) * SIZE - HALF;
      for (let i = 0; i < G; i++) {
        const x = (i / (G - 1)) * SIZE - HALF;
        heights[j * G + i] = this._height(x, z);
      }
    }
    const cell = SIZE / (G - 1);
    const base = await pixelCanvasAsync(G, G, (i, j, d, o) => {
      const x = (i / (G - 1)) * SIZE - HALF;
      const z = (j / (G - 1)) * SIZE - HALF;
      const h = heights[j * G + i];
      const hx = heights[j * G + Math.min(G - 1, i + 1)] - heights[j * G + Math.max(0, i - 1)];
      const hz = heights[Math.min(G - 1, j + 1) * G + i] - heights[Math.max(0, j - 1) * G + i];
      const slope = clamp01(Math.hypot(hx, hz) / (2 * cell) * 1.1);

      const patch = fbm2(x * 0.012, z * 0.012, 3);
      const meadow = fbm2(x * 0.031, z * 0.031, 2);
      // Deep pasture green through to sun-bleached olive on the uplands. The
      // whole vale must stay convincingly green - drifting toward straw makes
      // it read as desert under a warm sun.
      // Pitched a stop darker and greener than round 3. The roads have to be
      // the brightest continuous shape on the ground plane for the eye to have
      // anything to follow to the keep, and a 1.2x luminance step between a
      // pale meadow and a dry-mud track does not survive fog, exposure and a
      // 110m viewing distance. Against this the verges run at ~2.4x.
      const dry = clamp01(0.3 + patch * 0.85 + smoothstep(13, 24, h) * 0.45);
      let r = lerp(38, 88, dry) + meadow * 13;
      let g = lerp(66, 96, dry) + meadow * 12;
      let b = lerp(25, 40, dry);
      // Exposed rock on the steeps.
      const rocky = smoothstep(0.38, 0.78, slope);
      r = lerp(r, 96, rocky);
      g = lerp(g, 92, rocky);
      b = lerp(b, 82, rocky);
      // River mud and silt on the banks.
      const bank = 1 - smoothstep(0.5, 2.3, h - WATER_Y);
      r = lerp(r, 92, bank * 0.78);
      g = lerp(g, 76, bank * 0.78);
      b = lerp(b, 48, bank * 0.78);
      /* Beaten earth wherever people actually live.
       *
       * Two octaves of trample noise on top so the transition is a ragged mud
       * fringe rather than a painted disc, and so the square carries the dry
       * pale patches and damp dark ones that any trodden yard has. */
      const settle = clamp01(
        this._settled(x, z) * (0.82 + fbm2(x * 0.09, z * 0.09, 2) * 0.55)
      );
      const damp = fbm2(x * 0.21 + 40, z * 0.21, 2);
      const er = lerp(148, 108, clamp01(damp + 0.5));
      const eg = lerp(128, 90, clamp01(damp + 0.5));
      const eb = lerp(94, 66, clamp01(damp + 0.5));
      r = lerp(r, er, settle);
      g = lerp(g, eg, settle);
      b = lerp(b, eb, settle);
      const speck = perlin2(x * 0.35, z * 0.35) * 14 + perlin2(x * 1.4, z * 1.4) * 7;
      d[o] = clamp01((r + speck) / 255) * 255;
      d[o + 1] = clamp01((g + speck) / 255) * 255;
      d[o + 2] = clamp01((b + speck) / 255) * 255;
      d[o + 3] = 255;
    }, () => this._breathe());

    const c = newCanvas(S);
    const g2 = c.getContext('2d');
    g2.imageSmoothingEnabled = true;
    g2.imageSmoothingQuality = 'high';
    g2.drawImage(base, 0, 0, S, S);

    const toPx = (v) => ((v + HALF) / SIZE) * S;
    const rnd = mulberry32(0x77aa11);

    // Worn verges alongside every road, then the trodden line itself. Both
    // passes are pitched well above the meadow: the road has to be the
    // brightest continuous shape on the ground plane or the eye has nothing to
    // follow from the village to the gate.
    const strokeRoad = (road, off) => {
      g2.beginPath();
      road.pts.forEach(([x, z], i) => {
        // Lateral offset in metres, for the two wheel ruts.
        let nx = 0;
        let nz = 0;
        if (off) {
          const p = road.pts[Math.max(0, i - 1)];
          const q = road.pts[Math.min(road.pts.length - 1, i + 1)];
          const tx = q[0] - p[0];
          const tz = q[1] - p[1];
          const tl = Math.hypot(tx, tz) || 1;
          nx = (-tz / tl) * off;
          nz = (tx / tl) * off;
        }
        if (i === 0) g2.moveTo(toPx(x + nx), toPx(z + nz));
        else g2.lineTo(toPx(x + nx), toPx(z + nz));
      });
      g2.stroke();
    };
    for (const pass of [
      { w: 3.9, style: 'rgba(132,116,84,0.70)', off: 0 },
      { w: 2.1, style: 'rgba(198,180,142,0.92)', off: 0 },
      // Two darker ruts inside the pale track. A road that is one flat value is
      // a painted stripe; a road with wear inside it is a road.
      // 0.42m is a sixth of a pixel on a 1024 map over 400m - the ruts were
      // being painted below the resolution of the sheet they were painted on
      // and never appeared. Widened to something the map can actually hold,
      // and the alpha cut to compensate; the fine rut structure now comes from
      // the geometric channels cut in `_roadRibbon`, which carry their own
      // shadow line and do not depend on texel density at all.
      { w: 0, abs: 1.15, style: 'rgba(104,88,62,0.42)', off: 0.20 },
      { w: 0, abs: 1.15, style: 'rgba(104,88,62,0.42)', off: -0.20 },
      // Trodden verge: a darker, damper band where the grass has been walked
      // off the edge of the metalling, so the road has an edge instead of a
      // colour blend into the field.
      { w: 0, abs: 1.5, style: 'rgba(88,78,54,0.40)', off: 0.54 },
      { w: 0, abs: 1.5, style: 'rgba(88,78,54,0.40)', off: -0.54 },
    ]) {
      for (const road of this._roadPaths) {
        g2.strokeStyle = pass.style;
        g2.lineWidth = ((pass.abs ?? road.width * pass.w) * S) / SIZE;
        g2.lineJoin = 'round';
        g2.lineCap = 'round';
        strokeRoad(road, pass.off * road.width);
      }
    }

    /* Silt bars and a wet margin either side of the river.
     *
     * Filled band rather than a stroked centreline. A stroke has ONE width,
     * which was correct while the channel was a constant 9.5 m and is a lie
     * now that it runs from 6 m at the fords to 26 m at Reedwater - the pool
     * would have been a wide river painted as a narrow one. The band is the
     * channel's own half-width plus a 10 m wet margin, so the silt is exactly
     * as wide as the water it belongs to. */
    g2.fillStyle = 'rgba(96,84,58,0.5)';
    g2.beginPath();
    for (let x = -HALF - 20; x <= HALF + 20; x += 6) {
      const w = riverHalfWidth(x) + 10;
      const px = toPx(x);
      if (x <= -HALF - 20) g2.moveTo(px, toPx(riverZ(x) - w));
      else g2.lineTo(px, toPx(riverZ(x) - w));
    }
    for (let x = HALF + 20; x >= -HALF - 20; x -= 6) {
      const w = riverHalfWidth(x) + 10;
      g2.lineTo(toPx(x), toPx(riverZ(x) + w));
    }
    g2.closePath();
    g2.fill();

    /* Colour drifts, authored in METRES and converted here.
     *
     * These used to be 40-200 canvas pixels, which on a 2048 map over 400m was
     * 8-39m of ground. Left in pixels they would have become 18-88m at 900m -
     * the same map, the same painted shapes, twice the size on the ground -
     * and there would have been five times fewer of them per hectare. Both the
     * size and the count are per-area properties of the meadow, not properties
     * of the canvas, so both derive from the extent. */
    const mPx = S / SIZE;
    const area = SIZE * SIZE;
    blotches(g2, S, rnd, Math.round(area * 1.125e-3), 'rgba(38,62,26,ALPHA)', 7.8 * mPx, 39 * mPx, 0.34);
    blotches(g2, S, rnd, Math.round(area * 6.875e-4), 'rgba(124,124,62,ALPHA)', 5.9 * mPx, 31 * mPx, 0.24);

    /* ---- Trodden ground, and why it is painted LAST -----------------
     *
     * Two defects, one cause, and neither of them was in `settledAt`.
     *
     * Fenwick Cross's market place read as pasture and Grimscar's pithead yard
     * read as pasture, while Grimscar's street twenty metres away read
     * correctly. The obvious diagnosis - that the settlement table does not
     * cover the works - is wrong: `settledAt` measures 1.000 at the adit, the
     * headframe, the tip and the middle of Fenwick's square, exactly as it does
     * on Aldermoor's. The data was right the whole time.
     *
     * What Aldermoor had and the five new towns did not was these two passes,
     * both of which were written against the vale's `MARKET` rect and its
     * literal coordinates. Grimscar's STREET reads because a street is a road
     * and the road passes above paints it; the yard beside it is not a road,
     * and nothing else in this function knew a yard existed.
     *
     * And they ran BEFORE `blotches`, which scatters nine hundred 8-40 m
     * meadow drifts across the whole map at 0.34 alpha - including straight
     * over the one square that must not have meadow drifting over it. That is
     * the "same value paints differently" the report saw: the value was the
     * same, and then a green blotch landed on half of it.
     *
     * So both passes now derive from the settlement table, and both run after
     * the meadow. Ground people have beaten flat is the last thing painted. */
    for (const s of SETTLEMENTS) {
      for (const f of s.ground) {
        /* Squares and yards, not doorsteps. A dwelling's own beaten apron is
         * the `_pavedRects` pass below; this is for the open ground a whole
         * settlement crosses, and 300 m2 is the line between the two - above
         * it is a market place, a muster yard or a pithead, below it is one
         * house's turning circle. */
        const fw = f.shape === 'rect' ? f.hx * 2 : f.r * 2;
        const fd = f.shape === 'rect' ? f.hz * 2 : f.r * 2;
        if (fw * fd < 300) continue;
        g2.fillStyle = 'rgba(124,106,76,0.55)';
        if (f.shape === 'rect') {
          g2.fillRect(toPx(f.x - f.hx), toPx(f.z - f.hz), (f.hx * 2 * S) / SIZE, (f.hz * 2 * S) / SIZE);
        } else {
          g2.beginPath();
          g2.arc(toPx(f.x), toPx(f.z), (f.r * S) / SIZE, 0, TAU);
          g2.fill();
        }
        /* Standing water and damp shade in it.
         *
         * A packed-earth square painted at one value is the same failure as a
         * lawn painted at one value. Real trodden ground reads as a set of
         * dark damp hollows and pale dried crowns, and those large soft shapes
         * are what give the surface scale when there is nothing else in the
         * lower half of frame. The count is per unit AREA so a 6,700 m2
         * precinct is not mottled as sparsely as a 450 m2 pit yard. */
        const blobs = Math.min(140, Math.round((fw * fd) / 62));
        for (let i = 0; i < blobs; i++) {
          const ax = f.x + (rnd() - 0.5) * (fw + 12);
          const az = f.z + (rnd() - 0.5) * (fd + 12);
          if (this._settled(ax, az) < 0.35) continue;
          const rr = ((1.4 + rnd() * 4.6) * S) / SIZE;
          const px = toPx(ax);
          const pz = toPx(az);
          const dark = rnd() < 0.55;
          const gr = g2.createRadialGradient(px, pz, 0, px, pz, rr);
          gr.addColorStop(0, dark ? 'rgba(64,54,40,0.42)' : 'rgba(176,158,120,0.34)');
          gr.addColorStop(0.6, dark ? 'rgba(70,60,45,0.22)' : 'rgba(170,152,116,0.18)');
          gr.addColorStop(1, 'rgba(0,0,0,0)');
          g2.fillStyle = gr;
          g2.beginPath();
          g2.arc(px, pz, rr, 0, TAU);
          g2.fill();
        }
      }
    }

    // Beaten earth around every dwelling. Even where the cobble apron mesh
    // ends, the ground should already have stopped being meadow.
    for (const p of this._pavedRects) {
      g2.save();
      g2.translate(toPx(p.x), toPx(p.z));
      g2.rotate(-p.r);
      const w = ((p.hx + 2.6) * 2 * S) / SIZE;
      const d = ((p.hz + 2.6) * 2 * S) / SIZE;
      g2.fillStyle = 'rgba(126,108,78,0.6)';
      g2.fillRect(-w / 2, -d / 2, w, d);
      g2.fillStyle = 'rgba(104,88,62,0.45)';
      g2.fillRect(-w / 2 + w * 0.12, -d / 2 + d * 0.12, w * 0.76, d * 0.76);
      g2.restore();
    }
    grain(g2, S, 0x2f, 0.16, 'overlay', 4);

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = this._aniso;
    this._owned.push(tex);
    return tex;
  }

  async _buildTerrain() {
    this._buildRoadPaths();

    /* ---- Visual mesh: a 2m grid across the full playfield.
     *
     * The GRID SPACING is the constant, not the segment count. 2m is what the
     * collision heightfield needs to describe ground a capsule can stand on
     * without staircasing, so widening the vale multiplies the vertex count
     * rather than stretching the cells: 400m gave 201^2 = 40,401 samples, 900m
     * gives 451^2 = 203,401.
     *
     * Sampled on a worker. This is the single most expensive stretch of ground
     * arithmetic in the game - two hundred thousand evaluations of a height
     * function that is five octaves of gradient noise plus a river, a causeway
     * and five levelling pads - and none of it needs the renderer, so none of
     * it belongs on the render thread. The worker returns the finished buffers
     * as transferables, so the main thread's entire share of the job is
     * handing them to `BufferGeometry`.
     *
     * Normals come back from the worker too, computed from the height grid by
     * central differences rather than by `computeVertexNormals`, which would put
     * a second full pass over 80,000 triangles straight back where it was taken
     * from.
     *
     * The heights are reused verbatim as the collision heightfield below, so the
     * surface the player stands on is the very same set of numbers as the
     * surface they are looking at. The mesh used to be sampled at 2 m and the
     * collision at 4 m; every disagreement between them was either a player
     * floating above the ground or clipped into it. */
    const SEG = MEDIEVAL_LAYOUT.terrainSeg;
    const step = MEDIEVAL_LAYOUT.size / SEG;
    const terrain = await genPool.run('terrain', MEDIEVAL_LAYOUT.terrainJob);
    const hfHeights = terrain.heights;
    await this._breathe();

    /* ---- Macro albedo x tiled detail. One macro map cannot carry close-up
     * detail across the whole vale, and one tiled map cannot carry the roads
     * and river silt, so the shader multiplies them. */
    const macro = await this._paintMacro();
    const det = this._tex.detail;
    /* Relief tile size.
     *
     * 300 repeats put a 512px tile across 1.33m of ground - 2.6mm per texel,
     * so the largest feature the normal map could describe was about 7cm and
     * the smallest was sub-millimetre. Past four or five metres from the lens
     * every one of those features is below a pixel, the mip chain averages the
     * normal back to flat, and the whole playfield shades as a bare lambert
     * plane. A 3.0m tile puts the sheet's clump octave at 5-20cm and its patch
     * octave at 40cm-1.7m, which is the band a sun seventeen degrees up can
     * actually throw a readable micro-shadow across.
     *
     * Expressed in METRES and converted to repeats, because the terrain's UVs
     * run 0..1 across the whole playfield: the old literal 132 was "3.0m" only
     * as long as the vale was 400m wide, and at 900m the same 132 would have
     * silently become a 6.8m tile and taken the micro-shadow band with it.
     */
    const reliefRepeat = SIZE / RELIEF_TILE_M;
    det.normalMap.repeat.set(reliefRepeat, reliefRepeat);
    det.roughnessMap.repeat.set(reliefRepeat, reliefRepeat);
    const mat = new THREE.MeshStandardMaterial({
      map: macro,
      normalMap: det.normalMap,
      roughnessMap: det.roughnessMap,
      roughness: 1,
      metalness: 0,
    });
    mat.normalScale.set(1.9, 1.9);
    mat.name = 'medieval.terrain';
    const detailMap = det.map;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.tDetail = { value: detailMap };
      /* Primary detail tile: `DETAIL_TILE_M` of ground, as repeats over the
       * playfield's 0..1 UVs - so it stays 4.2m whatever `HALF` is.
       *
       * Round 4 ran this at a one-metre tile on the theory that finer is
       * sharper. The opposite is true once mipping is in play: a one-metre
       * tile whose content is all 2cm strokes has no octave left above the
       * first mip, so from three metres out the ground is a uniform grey
       * multiplier and the macro map shows through alone. That is exactly what
       * "the entire village square is a smooth olive-to-khaki gradient"
       * describes. A 4.2m tile lands the sheet's patch structure at 1.5-4m and
       * its clump structure at 15-50cm, both of which survive several mips and
       * both of which the camera resolves out to fifty metres. The near octave
       * below then runs at 1.3m for the first thirty metres and supplies the
       * grit the lens is close enough to see, and the 0.035x macro octave at
       * the bottom of the shader lands at ~120m drifts. */
      shader.uniforms.uDetail = { value: SIZE / DETAIL_TILE_M };
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform sampler2D tDetail;\nuniform float uDetail;'
        )
        .replace(
          '#include <map_fragment>',
          `#ifdef USE_MAP
             vec4 macroTexel = texture2D( map, vMapUv );
             // Detail desync: the same tile sampled again rotated 38 degrees at
             // a third the frequency, blended half and half. One repeat of a
             // 3.5m tile over 400m of ground is visible from anywhere; two
             // incommensurate repeats are not.
             vec2 rotUv = vec2(vMapUv.x * 0.788 - vMapUv.y * 0.616,
                               vMapUv.x * 0.616 + vMapUv.y * 0.788);
             vec3 dHi = texture2D( tDetail, vMapUv * uDetail ).rgb;
             vec3 dHi2 = texture2D( tDetail, rotUv * (uDetail * 0.31) ).rgb;
             vec3 dLo = texture2D( tDetail, vMapUv * (uDetail * 0.11) ).rgb;
             vec3 dMac = texture2D( tDetail, rotUv * (uDetail * 0.035) ).rgb;
             /* Gain raised from 1.62/0.94. The sheet is a multiplier centred
              * on 0.5, so a gain under ~1.9 cannot move the ground more than
              * about +/-20% and the result is a wash. At 2.05 the primary
              * octave swings roughly 0.45x to 1.55x, which is the difference
              * between bare trodden earth and lush turf - a real material
              * transition rather than a tint. */
             macroTexel.rgb *= (mix(dHi, dHi2, 0.45) * 2.05 - 0.02) * (dLo * 1.05 + 0.47);
             /* Near octave. A 31cm tile carries soil, pebble and blade-shadow
              * frequency, which is the only thing that stops the first ten
              * metres of ground from reading as a smeared depth-of-field pass.
              * It is faded out entirely by 30m, so past that it costs one
              * texture fetch that samples a fully-resolved mip and nothing
              * else - and the fetch is what keeps the branch-free. */
             float dNearK = 1.0 - smoothstep(7.0, 34.0, length(vViewPosition));
             vec3 dNear = texture2D( tDetail, rotUv * (uDetail * 3.2) ).rgb;
             macroTexel.rgb *= mix(vec3(1.0), dNear * 1.62 + 0.20, dNearK * 0.72);
             // Hundred-metre dry / lush drifts so open ground has readable
             // large shapes instead of an even speckle to the horizon.
             macroTexel.rgb *= mix(vec3(0.80, 0.84, 0.71), vec3(1.15, 1.10, 0.99),
                                   smoothstep(0.33, 0.74, dMac.g));
             diffuseColor *= macroTexel;
           #endif`
        );
    };
    mat.customProgramCacheKey = () => 'medieval-terrain';
    this._mats.terrain = mat;
    this._owned.push(mat);

    /* ---- Tiles.
     *
     * One mesh at 900 m is 405,000 triangles behind one 636 m bounding sphere,
     * which intersects the frustum from everywhere: the ground was the only
     * thing in this world that never frustum-culled, while its own grass and
     * trees were split spatially for exactly that reason. 81 tiles of 100 m,
     * each with its own sphere and its own half-resolution geometry past
     * 170 m, draw 108,000 triangles in 52 calls in the average of fourteen
     * measured framings. The size, the stride and the distance are all
     * measured - see `medieval/TerrainTiles.js`, which owns the reasoning and
     * the numbers.
     *
     * The tiles are SLICED out of `terrain.positions`, not resampled: every
     * tile vertex is a sample the worker already produced, so two tiles
     * sharing an edge share the same numbers and the hi surface is still
     * exactly the collision surface below. */
    const src = {
      positions: terrain.positions, uvs: terrain.uvs,
      normals: terrain.normals, nx: terrain.nx,
    };
    const tiles = tileGrid({ half: HALF, step: step, tile: TILE_METRES });
    for (let i = 0; i < tiles.length; i++) {
      if ((i & 7) === 0) await this._breathe();
      const t = tiles[i];
      const hi = MedievalWorld._tileGeometry(buildTile(src, t, 1, TILE_SKIRT_DROP));
      const lo = MedievalWorld._tileGeometry(buildTile(src, t, TILE_LO_STRIDE, TILE_SKIRT_DROP));
      this._owned.push(lo);
      const tile = new THREE.Mesh(hi, mat);
      tile.name = `medieval:terrain:${t.ix},${t.iz}`;
      tile.receiveShadow = true;
      tile.castShadow = false;
      this.group.add(tile);
      /* SURFACE, not CENTRE. A 100 m tile's sphere has a ~71 m radius, so a
       * centre measure would demote a tile whose near edge is still 100 m
       * inside the band the deviation budget was computed against. */
      this._lod.add(tile, { lo, swapBeyond: TILE_SWAP_DISTANCE, measure: SURFACE });
    }

    /* ---- Collision: one heightfield collider for the whole playfield.
     *
     * This was 10,000 tilted slabs - one oriented box per 4 m cell, each
     * carrying two 4x4 matrices, for about 5 MB and 40,000 extra `_height`
     * calls. That cost grows with world *area*, so it was also the single thing
     * standing between this world and being made meaningfully bigger: at four
     * times the width it is 160,000 boxes and 76 MB, and at ten times it is a
     * million boxes and half a gigabyte.
     *
     * That prediction is now the world we are in: at 900m the 2m grid is
     * 203,401 samples, which as oriented boxes would have been 200,000
     * colliders and ~95 MB. The heightfield is 814 KB, is built from samples
     * the mesh had already computed, and - because it shares the mesh's grid
     * and its 00->11 triangulation - describes exactly the surface that gets
     * drawn rather than a staircase approximation of it. */
    this.track(
      this.physics.addHeightfield({
        heights: hfHeights,
        nx: SEG + 1,
        nz: SEG + 1,
        originX: -HALF,
        originZ: -HALF,
        stepX: step,
        stepZ: step,
      })
    );
    await this._breathe();

    /* ---- Distant continuation: a polar skirt out to ~1.9km that becomes
     * foothills, so the playfield never ends in a visible cliff edge. */
    /* Angular resolution.
     *
     * 96 segments put a 12m chord across the inner rings at 400m, and a
     * straight chord across 12m of rolling ground deviates far enough from the
     * terrain mesh to punch through it. 256 cut that to under 5m, which is
     * what lets the seam clearance in `_outerHeight` be small enough to stop
     * drawing a hairline. The chord is `2 * pi * SKIRT_INNER / AR`, so the
     * segment count has to track the radius or a 900m vale would be back to a
     * 10.7m chord and the hairline with it. */
    const AR = Math.max(256, Math.round((TAU * SKIRT_INNER) / 4.8 / 32) * 32);
    const RR = 26;
    const opos = [];
    const ouv = [];
    const ocol = [];
    const oidx = [];
    // The skirt used to darken with distance, which is backwards - it fought
    // the fog and made the far hills read closer than the near ones. It now
    // lightens fractionally toward the haze so the value ramp runs the right
    // way even before the fog is applied.
    const far = new THREE.Color(0x8a8f78);
    const near = new THREE.Color(0xffffff);
    const SKIRT_ROCK = new THREE.Color(0xa39781);
    for (let ri = 0; ri <= RR; ri++) {
      if ((ri & 3) === 0) await this._breathe();
      const rt = ri / RR;
      /* Out to ~1.9km, just inside the 2km far plane - see `SKIRT_OUTER`,
       * which is absolute rather than derived from HALF for exactly that
       * reason. When the sheet stopped at a 900m radius, from any elevated
       * vantage that terminating ring projected to a hard edge a few pixels
       * above the fogged hills: the dark hairline that looked like it had been
       * ruled across the horizon in every rampart framing. This far out it
       * falls under the horizon line and the world reads as continuing rather
       * than as ending at a rim. */
      const rad = SKIRT_INNER + Math.pow(rt, 2.6) * (SKIRT_OUTER - SKIRT_INNER);
      for (let ai = 0; ai <= AR; ai++) {
        const ang = (ai / AR) * TAU;
        const x = Math.cos(ang) * rad;
        const z = Math.sin(ang) * rad;
        const oy = this._outerHeight(x, z);
        opos.push(x, oy, z);
        /* World-space UVs.
         *
         * The skirt used to inherit the playfield's own 0..1-over-the-vale UV
         * set on a sheet that reaches 1.9km, so one texture tile covered most
         * of the ring and the far hills were flat vertex colour with a clean
         * analytic silhouette - the exact tell of untextured geometry. A
         * metre-based UV tiles the detail sheet every 5m out there instead. */
        ouv.push(x / 70, z / 70);
        /* Value ramp toward the haze. The START tracks the rim - it has to,
         * or the innermost visible ring would already be part-way to the far
         * colour and the seam would show as a value step against the playfield
         * it is supposed to continue. The 560m RUN does not: that is an
         * atmospheric distance, the same one the fog is working over. */
        /* The RUN is the fog's own run, not a number of its own. It was the
         * literal 580 against a 560 m fogFar - "the same atmospheric distance
         * the fog is working over" - and that sentence was true and the number
         * was not maintained: the fog now works over 794 m. Deriving it means
         * the skirt's value ramp and the haze it is dissolving into can no
         * longer drift apart. */
        _col.copy(near).lerp(far, smoothstep(HALF + 20, HALF + (FOG_FAR - FOG_NEAR), rad));
        // Slope break-up: the crests and the steep flanks show scrub and rock
        // where the shallow ground stays grass, so the ridge shows folds.
        const d = Math.max(6, rad * 0.03);
        const sl = clamp01(
          Math.hypot(
            this._outerHeight(x + d, z) - this._outerHeight(x - d, z),
            this._outerHeight(x, z + d) - this._outerHeight(x, z - d)
          ) / (2 * d) * 1.6
        );
        const drift = 0.82 + fbm2(x * 0.0075, z * 0.0075, 3) * 0.42;
        _col.multiplyScalar(drift);
        _col.lerp(SKIRT_ROCK, smoothstep(0.24, 0.72, sl));
        ocol.push(_col.r, _col.g, _col.b);
      }
    }
    /* Winding.
     *
     * This is the bug behind "assets appear outside of land". The ring runs
     * from +X toward +Z, which is CLOCKWISE seen from above, so the obvious
     * (a, b, b+1) / (a, b+1, a+1) fans produce a face normal of -Y: the whole
     * 1.9km skirt was a front-facing surface pointing at the ground. It was
     * back-face culled from every position a player can stand in, it was
     * back-face culled from the raycaster too, and `computeVertexNormals`
     * below inherited the same inverted normals, so even the slivers that did
     * survive were lit from underneath.
     *
     * The visible result was that the world simply stopped at the playfield
     * square with sky beyond it, and the three rings of backdrop conifers -
     * which are placed on `_outerHeight`, i.e. on this sheet - hung in mid-air
     * past the border. Reversing both triangles fixes the culling and the
     * normals in one go.
     */
    for (let ri = 0; ri < RR; ri++) {
      for (let ai = 0; ai < AR; ai++) {
        const a = ri * (AR + 1) + ai;
        const b = a + AR + 1;
        oidx.push(a, b + 1, b, a, a + 1, b + 1);
      }
    }
    const og = new THREE.BufferGeometry();
    og.setAttribute('position', new THREE.Float32BufferAttribute(opos, 3));
    og.setAttribute('uv', new THREE.Float32BufferAttribute(ouv, 2));
    og.setAttribute('color', new THREE.Float32BufferAttribute(ocol, 3));
    og.setIndex(oidx);
    og.computeVertexNormals();
    /* The skirt needs its own repeat on the shared detail sheet - the terrain
     * samples that texture through a raw uniform at 400 repeats, and the far
     * hills want a 5m tile, not a 1m one. Cloning shares the `Source`, so this
     * costs one extra sampler binding and zero extra GPU memory. */
    const skirtMap = det.map.clone();
    skirtMap.wrapS = skirtMap.wrapT = THREE.RepeatWrapping;
    skirtMap.repeat.set(14, 14);
    skirtMap.anisotropy = this._aniso;
    skirtMap.needsUpdate = true;
    const skirtNrm = det.normalMap.clone();
    skirtNrm.wrapS = skirtNrm.wrapT = THREE.RepeatWrapping;
    skirtNrm.repeat.set(14, 14);
    skirtNrm.needsUpdate = true;
    this._owned.push(skirtMap, skirtNrm);
    const omat = new THREE.MeshStandardMaterial({
      map: skirtMap,
      normalMap: skirtNrm,
      color: 0x5f6b45,
      roughness: 1,
      metalness: 0,
      vertexColors: true,
      // Loses the depth fight against the playfield wherever the two sheets
      // coincide, so the 2.5cm geometric clearance never has to be enough on
      // its own.
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 4,
    });
    omat.name = 'medieval.distant';
    this._mats.distant = omat;
    this._owned.push(omat);
    const outer = new THREE.Mesh(og, omat);
    outer.receiveShadow = false;
    outer.castShadow = false;
    this.group.add(outer);

    // Keep the player on collidable ground. See `MEDIEVAL_LAYOUT.walls`.
    for (const w of MEDIEVAL_LAYOUT.walls) this._box(...w);
  }
  /* ---------------------------------------------------------------- */
  /* Sky dome, water, cobbles                                          */
  /* ---------------------------------------------------------------- */

  _buildSky() {
    const dome = new THREE.Mesh(new THREE.SphereGeometry(880, 40, 24), this._mats.sky);
    dome.name = 'medieval:sky';
    dome.frustumCulled = false;
    dome.renderOrder = -1000;
    dome.castShadow = false;
    dome.receiveShadow = false;
    this.group.add(dome);
    this._skyDome = dome;
  }

  /** One shared water material drives both the river and the castle moat. */
  _buildWater() {
    const mat = this._mats.water;

    /* River: a ribbon that follows the meander and runs off past the fog line.
     *
     * Segment count tracks the width so the meander stays as smooth as it was:
     * 150 spans over 392m was a 2.6m step, and a straight chord across a
     * curve that swings 27m either side of its mean needs about that. */
    const along = Math.max(150, Math.round((SIZE - 8) / 2.6));
    const across = 5;
    const pos = [];
    const uv = [];
    const idx = [];
    for (let i = 0; i <= along; i++) {
      // Was -240..240 on a +/-200 playfield. Past the playfield the terrain
      // skirt climbs into foothills while this plane stays dead flat at
      // WATER_Y, so the ribbon punched out through a hillside and read as a
      // floating grey slab with a hard straight edge. Ending four metres
      // INSIDE the playfield and pinching the width to nothing lets it
      // disappear into its own valley instead.
      const t0 = i / along;
      const x = -(HALF - 4) + t0 * (SIZE - 8);
      const cz = riverZ(x);
      /* Width follows the channel. `halfW` was a constant 11 - the 9.5 m
       * channel plus 1.5 - and a constant is exactly what the expansion had to
       * stop being: Reedwater's 26 m pool would have been a 22 m grey ribbon
       * running through the middle of a 52 m trench. */
      const w = (riverHalfWidth(x) + 1.5)
        * (0.12 + 0.88 * smoothstep(0, 0.09, Math.min(t0, 1 - t0)));
      for (let j = 0; j <= across; j++) {
        const t = j / across;
        pos.push(x, WATER_Y, cz + (t - 0.5) * 2 * w);
        uv.push(t, t0 * 26);
      }
    }
    for (let i = 0; i < along; i++) {
      for (let j = 0; j < across; j++) {
        const a = i * (across + 1) + j;
        const b = a + across + 1;
        idx.push(a, b, b + 1, a, b + 1, a + 1);
      }
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    rg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    rg.setIndex(idx);
    rg.computeVertexNormals();
    const river = new THREE.Mesh(rg, mat);
    river.name = 'medieval:river';
    river.renderOrder = 4;
    this.group.add(river);

    // Moat: four overlapping bands make a clean rectangular ring.
    const ox = CASTLE.hx + 16;
    const oz = CASTLE.hz + 16;
    const ix = CASTLE.hx + 5;
    const iz = CASTLE.hz + 5;
    const bands = [
      [0, -(oz + iz) / 2, ox * 2, oz - iz],
      [0, (oz + iz) / 2, ox * 2, oz - iz],
      [-(ox + ix) / 2, 0, ox - ix, iz * 2],
      [(ox + ix) / 2, 0, ox - ix, iz * 2],
    ];
    for (const [bx, bz, bw, bd] of bands) {
      const g = new THREE.PlaneGeometry(bw, bd, Math.ceil(bw / 3), Math.ceil(bd / 3));
      g.rotateX(-Math.PI / 2);
      // UV.x must run across the band so the shader's shoreline foam lands right.
      const a = g.attributes.uv;
      const p = g.attributes.position;
      for (let i = 0; i < a.count; i++) {
        const localAcross = bw > bd ? p.getZ(i) / (bd * 0.5) : p.getX(i) / (bw * 0.5);
        a.setXY(i, localAcross * 0.5 + 0.5, (bw > bd ? p.getX(i) : p.getZ(i)) * 0.12);
      }
      const m = new THREE.Mesh(g, mat);
      m.position.set(CASTLE.x + bx, MOAT_Y, CASTLE.z + bz);
      m.renderOrder = 4;
      this.group.add(m);
    }
  }

  /** Build one cobbled ribbon that hugs the terrain across its whole width. */
  _roadRibbon(pts, width) {
    // Twelve lanes rather than four. Four gives five vertices across the whole
    // carriageway, which is enough to dish it and nothing else - there is no
    // way to cut a 30cm wheel rut into a profile whose sample spacing is a
    // metre and a half. Twelve puts a vertex every ~50cm on a 6m road, which
    // resolves the ruts, and a road ribbon is a handful of triangles anyway.
    const lanes = 12;
    const pos = [];
    const uv = [];
    const idx = [];
    let run = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x, z] = pts[i];
      const p = pts[Math.max(0, i - 1)];
      const q = pts[Math.min(pts.length - 1, i + 1)];
      let tx = q[0] - p[0];
      let tz = q[1] - p[1];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      const nx = -tz;
      const nz = tx;
      if (i > 0) run += Math.hypot(x - pts[i - 1][0], z - pts[i - 1][1]);
      for (let j = 0; j <= lanes; j++) {
        const t = j / lanes - 0.5;
        const px = x + nx * t * width;
        const pz = z + nz * t * width;
        /* Dish the carriageway.
         *
         * A road that is only an albedo change disappears the moment fog and
         * exposure compress it, which is exactly what happened at 110m on the
         * castle approach - the reviews all reported an unbroken green sheet
         * where the spine of the world was supposed to be. Sinking the crown
         * 14cm below the surrounding ground gives the road its own shadow line
         * under a sun 17 degrees up, and a shadow line survives haze where a
         * texture never does. The outer lane still beds under the grass so the
         * ribbon has no visible cut edge.
         */
        const at = Math.abs(t);
        // Kept to 8cm: the terrain collision hull is not dished with it, so a
        // deeper hollow would leave the player visibly hovering over the road.
        let edge = at > 0.4
          ? -0.10
          : 0.055 - 0.135 * (1 - (at / 0.4) * (at / 0.4));
        /* Wheel ruts.
         *
         * The approach road read as "a wide uniform tan smear with no ruts,
         * no verge and no gravel" because it *had* none - it was a dished
         * plane plus an albedo change, and albedo does not survive a hundred
         * metres of aerial perspective. A pair of 6cm channels at 40% of the
         * half-width does, because under a key seventeen degrees above the
         * horizon a 6cm step throws a shadow line the full length of the road
         * and a shadow line is a geometric fact the haze cannot flatten. The
         * offset is scaled by a slow function of arc length so the two ruts
         * wander toward and away from each other the way a real cart track
         * does rather than running as two ruled parallels.
         */
        const rutAt = 0.19 + Math.sin(run * 0.055) * 0.022;
        const rd = (at - rutAt) / 0.085;
        edge -= Math.exp(-rd * rd) * 0.062;
        pos.push(px, this._height(px, pz) + edge, pz);
        uv.push((t + 0.5) * width * 0.55, run * 0.55);
      }
    }
    for (let i = 0; i < pts.length - 1; i++) {
      for (let j = 0; j < lanes; j++) {
        const a = i * (lanes + 1) + j;
        const b = a + lanes + 1;
        idx.push(a, b, b + 1, a, b + 1, a + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  /**
   * A terrain-conforming paved area with a frayed, noise-thresholded boundary.
   *
   * Quads are emitted only where `rectDist + fbm` is inside, so the outline is
   * ragged at roughly a metre - the scale a real edge of setting loses stones
   * at. The outermost surviving vertices also sink, so where the fray does end
   * it ends *under* the ground rather than on a visible lip.
   */
  _pavedField(cx, cz, hx, hz, cell = 1.1) {
    const nx = Math.ceil((hx * 2) / cell);
    const nz = Math.ceil((hz * 2) / cell);
    const pos = [];
    const uv = [];
    const idx = [];
    const vid = new Int32Array((nx + 1) * (nz + 1)).fill(-1);
    const edge = (i, j) => {
      const x = cx - hx + (i / nx) * hx * 2;
      const z = cz - hz + (j / nz) * hz * 2;
      // Positive outside. Two octaves of fray, so the boundary wanders by up
      // to ~2.4m and loses whole stones rather than shaving a clean curve.
      return (
        rectDist(x - cx, z - cz, hx - 2.6, hz - 2.6) +
        fbm2(x * 0.19, z * 0.19, 2) * 2.4 +
        fbm2(x * 0.62, z * 0.62, 2) * 0.9
      );
    };
    for (let j = 0; j <= nz; j++) {
      for (let i = 0; i <= nx; i++) {
        const e = edge(i, j);
        if (e > 0.9) continue;
        const x = cx - hx + (i / nx) * hx * 2;
        const z = cz - hz + (j / nz) * hz * 2;
        vid[j * (nx + 1) + i] = pos.length / 3;
        pos.push(x, this._height(x, z) + 0.075 - smoothstep(-1.4, 0.9, e) * 0.22, z);
        uv.push(x * 0.55, z * 0.55);
      }
    }
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const a = vid[j * (nx + 1) + i];
        const b = vid[(j + 1) * (nx + 1) + i];
        const c = vid[(j + 1) * (nx + 1) + i + 1];
        const d = vid[j * (nx + 1) + i + 1];
        if (a < 0 || b < 0 || c < 0 || d < 0) continue;
        idx.push(a, b, c, a, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  _buildRoads() {
    const mat = this._mats.cobble;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    mat.polygonOffsetUnits = -3;

    const parts = [];
    for (const road of this._roadPaths) parts.push(this._roadRibbon(road.pts, road.width));

    // Market square and the castle bailey are paved rather than surfaced.
    const square = (cx, cz, hx, hz, y) => {
      const g = new THREE.PlaneGeometry(hx * 2, hz * 2, Math.ceil(hx), Math.ceil(hz));
      g.rotateX(-Math.PI / 2);
      const p = g.attributes.position;
      const a = g.attributes.uv;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i) + cx;
        const z = p.getZ(i) + cz;
        p.setY(i, (y ?? this._height(x, z)) + 0.06);
        a.setXY(i, x * 0.55, z * 0.55);
      }
      p.needsUpdate = true;
      g.translate(cx, 0, cz);
      g.computeVertexNormals();
      return g;
    };
    /* The market square, paved as a square rather than as a rectangle of
     * cobble sitting in a lawn.
     *
     * Round 3 paved exactly `MARKET.hx x MARKET.hz` and stopped on a ruled
     * straight line, so the "village square" framing was two rows of buildings
     * facing each other across raw grass with a cobble strip hugging one wall.
     * A square is a *room*: its floor has to reach the buildings that define
     * it. The footprint is pushed out 6m all round and the boundary is
     * dissolved with an fbm threshold so the paving frays into the ground
     * instead of ending on a polygon edge. */
    parts.push(this._pavedField(MARKET.x, MARKET.z, MARKET.hx + 6, MARKET.hz + 5.5));
    parts.push(square(CASTLE.x, CASTLE.z, CASTLE.hx - 3, CASTLE.hz - 3, CASTLE.ground));

    /* A cobbled apron around every dwelling: the threshold, the yard and the
     * bit of hard standing a cart would stand on. Conforms to the terrain
     * vertex by vertex so it beds in rather than hovering on a slope. */
    /* Round 5. Two things were wrong with this and together they produced the
     * artifact every reviewer led with.
     *
     * First the rim: `smoothstep(0.66, 1.0, edge)` feathers the sink over the
     * outer sixth of the quad, which on a 12m apron is 1m - a transition short
     * enough that it reads as a ruled straight line where the paving stops.
     * Widened to start at 0.30, roughly three times the run, so the slab beds
     * into the ground rather than terminating on an edge.
     *
     * Second, and much worse: the paving ran at a single flat value from the
     * frayed rim right up to the plaster. A real yard is filthy where it meets
     * a wall - roof runoff, splashback off the plinth, moss in the angle,
     * never swept because a broom cannot get into it - and that darkening is
     * the contact occlusion the whole build was missing. Baking it into the
     * vertex colours costs nothing, works on every terrain slope because the
     * apron already conforms, and it is the reason a building looks founded
     * rather than pasted on.
     */
    const apron = (p, tint) => {
      const segX = Math.max(4, Math.ceil(p.hx * 1.6));
      const segZ = Math.max(4, Math.ceil(p.hz * 1.6));
      const g = new THREE.PlaneGeometry(p.hx * 2, p.hz * 2, segX, segZ);
      g.rotateX(-Math.PI / 2);
      g.rotateY(p.r);
      const pos = g.attributes.position;
      const a = g.attributes.uv;
      const n = pos.count;
      const shade = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = pos.getX(i) + p.x;
        const z = pos.getZ(i) + p.z;
        // Local (unrotated) offset from the yard centre, recovered from the
        // plane's own 0..1 UVs - the transform has already been applied to the
        // positions, so the UVs are the only untransformed frame left.
        const lx = (a.getX(i) - 0.5) * 2 * p.hx;
        const lz = (a.getY(i) - 0.5) * 2 * p.hz;
        // Sink the outer ring so the edge disappears into the grass.
        const edge = Math.max(Math.abs(a.getX(i) * 2 - 1), Math.abs(a.getY(i) * 2 - 1));
        // Sits marginally proud of the streets and the market square so the
        // three cobble surfaces never z-fight where they overlap.
        pos.setY(i, this._height(x, z) + 0.1 - smoothstep(0.30, 1.0, edge) * 0.235);
        a.setXY(i, x * 0.55, z * 0.55);
        // Distance out from the wall face, negative under the building.
        const d = rectDist(lx, lz, p.bx ?? 0, p.bz ?? 0);
        shade[i] = lerp(0.40, 1.0, smoothstep(0.0, 1.55, d));
      }
      pos.needsUpdate = true;
      g.translate(p.x, 0, p.z);
      g.computeVertexNormals();
      normaliseGeo(g, tint);
      const col = g.attributes.color;
      for (let i = 0; i < n; i++) {
        const k = shade[i];
        col.setXYZ(i, col.getX(i) * k, col.getY(i) * k * 0.985, col.getZ(i) * k * 0.955);
      }
      col.needsUpdate = true;
      return g;
    };

    /* Street and market tint. This was 0xffffff - a pure pass-through on an
     * albedo sheet that was already pitched high - so the cobble in the
     * village ran at the top of its range everywhere and clipped wherever the
     * macro breaker peaked. A mid-value multiplier keeps the roads legible as
     * a lighter ribbon through the meadow without letting them clip. */
    for (const g of parts) normaliseGeo(g, 0xb4ab99);
    // Yard cobble is dirtier than the swept street it joins.
    for (const p of this._pavedRects) parts.push(apron(p, 0x8a8172));

    /* Merged per 300 m cell rather than into one mesh.
     *
     * At 400 m the whole network occupied a 150x230 m patch and one merged
     * mesh was obviously right: a single bounding sphere, one draw call, and
     * it culled as a unit whenever the village was off screen. The ring
     * roads take the network from ~1.1 km of carriageway to ~5.6 km spread
     * corner to corner, and the same merge then produces one mesh with a
     * 636 m bounding sphere - which is in frustum from everywhere and
     * submits every triangle of every road in the world on every frame,
     * including the four fifths of them that are behind the camera.
     *
     * Nine cells is the smallest split that fixes that: each is ~212 m
     * across the diagonal, so a cell leaves the frustum for real, and eight
     * extra draw calls is a price worth paying once. Bucketed by CENTROID,
     * which can put a ribbon that straddles a boundary wholly in one cell -
     * that is fine and deliberate, because the alternative is splitting
     * geometry and the error it causes is a slightly larger sphere.
     */
    const ROAD_CELL = 300;
    const cellsPerSide = Math.max(1, Math.round(SIZE / ROAD_CELL));
    const cells = new Map();
    const _c = new THREE.Vector3();
    for (const g of parts) {
      g.computeBoundingBox();
      g.boundingBox.getCenter(_c);
      const cx = Math.min(cellsPerSide - 1, Math.max(0, Math.floor((_c.x + HALF) / ROAD_CELL)));
      const cz = Math.min(cellsPerSide - 1, Math.max(0, Math.floor((_c.z + HALF) / ROAD_CELL)));
      const key = cz * cellsPerSide + cx;
      let arr = cells.get(key);
      if (!arr) cells.set(key, (arr = []));
      arr.push(g);
    }
    for (const [key, arr] of cells) {
      const merged = arr.length === 1 ? arr[0] : mergeGeometries(arr, false);
      if (arr.length > 1) for (const g of arr) g.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = `medieval:cobbles${key}`;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      this.group.add(mesh);
    }

    /* ---- Loose setts straddling the boundary ------------------------- *
     * Even a frayed paved edge is still an edge of one surface meeting
     * another. What actually dissolves it is stones that have worked out of
     * the setting and now sit in the grass, and stones the grass has grown
     * over. One instanced mesh, scattered along the road verges and the market
     * fringe, and the transition stops being a line. */
    const rnd = mulberry32(0x5e77);
    const sg = new THREE.IcosahedronGeometry(0.15, 1);
    const sp = sg.attributes.position;
    for (let i = 0; i < sp.count; i++) {
      sp.setXYZ(i, sp.getX(i) * 1.25, sp.getY(i) * 0.52, sp.getZ(i) * 1.1);
    }
    sg.computeVertexNormals();
    MedievalWorld._uvScale(sg, 1.6);
    normaliseGeo(sg, 0xffffff);
    this._owned.push(sg);

    const nearRoads = this._roadPaths.filter((r) => {
      const [fx, fz] = r.pts[0];
      const [lx, lz] = r.pts[r.pts.length - 1];
      return Math.max(Math.abs(fx), Math.abs(fz), Math.abs(lx), Math.abs(lz)) <= INNER_KEEP;
    });
    const N = 420;
    const setts = new THREE.InstancedMesh(sg, this._mats.cobble, N);
    let placed = 0;
    let guard = 0;
    while (placed < N && guard++ < N * 12) {
      let x;
      let z;
      if (rnd() < 0.45) {
        // Market fringe.
        const a = rnd() * TAU;
        const ex = MARKET.hx + 4.6 + rnd() * 3.2;
        const ez = MARKET.hz + 4.2 + rnd() * 3.2;
        x = MARKET.x + Math.cos(a) * ex;
        z = MARKET.z + Math.sin(a) * ez;
      } else {
        /* Road verges - but only the vale's own, not the ring's.
         *
         * These four hundred stones exist to dissolve the edge of the
         * village's paving, which is a thing the composed street frames look
         * straight at. Picking uniformly from a road list that is now five
         * times longer would move four fifths of them onto ring roads seen
         * from two hundred metres, where a 15 cm stone is sub-pixel - and
         * would thin the village's verges to a quarter of what they were
         * tuned at, for no gain anywhere. */
        const road = nearRoads[(rnd() * nearRoads.length) | 0];
        const k = (rnd() * (road.pts.length - 1)) | 0;
        const [ax, az] = road.pts[k];
        const [bx, bz] = road.pts[k + 1];
        const t = rnd();
        const dx = bx - ax;
        const dz = bz - az;
        const l = Math.hypot(dx, dz) || 1;
        const off = (rnd() < 0.5 ? -1 : 1) * (road.width * 0.5 + rnd() * 1.3 - 0.35);
        x = ax + dx * t - (dz / l) * off;
        z = az + dz * t + (dx / l) * off;
      }
      // Roads are laid before the village is, so `_footprints` is still empty
      // here - test the authored plots directly rather than silently passing.
      let blocked = false;
      for (const p of PLOTS) {
        const dx = x - p[0];
        const dz = z - p[1];
        const c = Math.cos(-p[2]);
        const s = Math.sin(-p[2]);
        if (rectDist(dx * c - dz * s, dx * s + dz * c, p[3] / 2 + 0.4, p[4] / 2 + 0.4) < 0) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      const y = this._height(x, z);
      if (y < WATER_Y + 0.4) continue;
      const sc = 0.55 + rnd() * 1.05;
      _obj.position.set(x, y - 0.035 * sc, z);
      _obj.rotation.set((rnd() - 0.5) * 0.5, rnd() * TAU, (rnd() - 0.5) * 0.5);
      _obj.scale.set(sc, sc * (0.7 + rnd() * 0.6), sc);
      _obj.updateMatrix();
      setts.setMatrixAt(placed, _obj.matrix);
      _col.setHSL(0.09, 0.03 + rnd() * 0.06, 0.26 + rnd() * 0.2);
      setts.setColorAt(placed, _col);
      placed++;
    }
    setts.count = placed;
    setts.castShadow = true;
    setts.receiveShadow = true;
    setts.instanceMatrix.needsUpdate = true;
    if (setts.instanceColor) setts.instanceColor.needsUpdate = true;
    setts.computeBoundingSphere();
    this.group.add(setts);
  }
  /* ---------------------------------------------------------------- */
  /* Masonry helpers                                                   */
  /* ---------------------------------------------------------------- */

  /** Yaw that aligns a box's local +X with the direction (dx, dz). */
  static _yaw(dx, dz) {
    return Math.atan2(-dz, dx);
  }

  /**
   * Crenellated parapet along a line: a solid coping course with merlons and
   * embrasures on top. Collision is a single continuous box added by callers,
   * because falling through an embrasure is never what the player wanted.
   */
  _merlons(batch, key, x1, z1, x2, z2, yBase, thick, tint) {
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    if (len < 0.5) return;
    const ux = dx / len;
    const uz = dz / len;
    const yaw = MedievalWorld._yaw(ux, uz);

    // Coping course. Kept low (0.95m, embrasure floor at +0.95) so a standing
    // camera clears it: the old 1.2m course put the sill above the eyeline and
    // turned every wall-walk into a blind trench.
    _obj.position.set((x1 + x2) / 2, yBase + 0.475, (z1 + z2) / 2);
    _obj.rotation.set(0, yaw, 0);
    _obj.scale.set(1, 1, 1);
    batch.add(key, boxGeo(len, 0.95, thick, 0.46), _obj, tint);

    // Wider period and narrower merlons: the embrasures have to be big enough
    // to frame something, or the "vista" is two slots of empty sky.
    /* 3.2m gave a 1.47m merlon over a 1.73m embrasure - both far too coarse,
     * and coarse crenellation is a scale cue that works *against* you: the eye
     * sizes a battlement off the merlon, so oversized merlons make the whole
     * fortification read small. A 2.15m period lands a 1.18m merlon over a
     * 0.97m gap, which is close to the real thing and reads as masonry rather
     * than as toy blocks. */
    const period = 2.15;
    const count = Math.max(1, Math.floor(len / period));
    const spacing = len / count;
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) * spacing;
      // Adjacent merlons must not be identical - a perfectly uniform value
      // along a parapet is the giveaway that it came out of a loop.
      const nz2 = Math.sin(x1 * 12.9898 + z1 * 78.233 + i * 37.719) * 43758.5453;
      const f = nz2 - Math.floor(nz2) - 0.5;
      _col.setHex(tint).offsetHSL(f * 0.014, f * 0.06, f * 0.15);
      const jt = _col.getHex();

      // A perfectly regular crenellation ring is the single clearest blockout
      // tell in a castle. Every merlon gets a height jitter, a two-stage
      // batter so the profile is not a plain extrusion, and roughly one in
      // seven has been knocked down to a stub.
      const mx = x1 + ux * t;
      const mz = z1 + uz * t;
      const wide = spacing * 0.55;
      const ruined = (i * 5 + Math.abs(Math.round(x1 + z1))) % 7 === 3;
      _obj.rotation.set(0, yaw, 0);
      if (ruined) {
        _obj.position.set(mx, yBase + 1.22, mz);
        batch.add(key, boxGeo(wide, 0.54, thick, 0.46), _obj, jt);
        _obj.position.set(mx + ux * wide * 0.18, yBase + 1.58, mz + uz * wide * 0.18);
        _obj.rotation.set((f + 0.2) * 0.3, yaw + f * 0.5, f * 0.24);
        batch.add(key, boxGeo(wide * 0.44, 0.3, thick * 0.8, 0.46), _obj, jt);
        continue;
      }
      const mh = 1.4 * (1 + f * 0.16);
      _obj.position.set(mx, yBase + 0.95 + mh * 0.35, mz);
      batch.add(key, boxGeo(wide, mh * 0.7, thick, 0.46), _obj, jt);
      _obj.position.set(mx, yBase + 0.95 + mh * 0.85, mz);
      batch.add(key, boxGeo(wide * 0.9, mh * 0.3, thick * 0.9, 0.46), _obj, jt);
      // A chamfered cap stone that overhangs slightly reads far better in
      // silhouette than a flat-topped block.
      _obj.position.set(mx, yBase + 0.95 + mh + 0.06, mz);
      batch.add(key, boxGeo(wide * 1.04, 0.12, thick + 0.12, 0.46), _obj, jt);
      _obj.position.set(mx, yBase + 0.95 + mh + 0.17, mz);
      batch.add(key, boxGeo(wide * 0.8, 0.1, thick * 0.78, 0.46), _obj, jt);
    }
  }

  /** Voussoir arch ring in a plane; `m4` places the springing centre. */
  _archRing(batch, key, m4, radius, thick, depth, tint) {
    const n = 13;
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * (i + 0.5)) / n;
      const g = boxGeo(((Math.PI * radius) / n) * 1.2, thick, depth, 0.5);
      _obj.position.set(
        Math.cos(a) * (radius + thick * 0.5),
        Math.sin(a) * (radius + thick * 0.5),
        0
      );
      _obj.rotation.set(0, 0, a - Math.PI / 2);
      _obj.scale.set(1, 1, 1);
      _obj.updateMatrix();
      g.applyMatrix4(_obj.matrix);
      batch.add(key, g, m4, tint);
    }
  }

  /** Ring of blocks forming a round crenellated parapet on a tower head. */
  _towerCrown(batch, key, cx, cy, cz, radius, tint, segs = 16) {
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * TAU;
      const px = cx + Math.cos(a) * radius;
      const pz = cz + Math.sin(a) * radius;
      const w = (TAU * radius) / segs + 0.22;
      _obj.position.set(px, cy + 0.55, pz);
      _obj.rotation.set(0, -a, 0);
      _obj.scale.set(1, 1, 1);
      batch.add(key, boxGeo(0.72, 1.1, w, 0.55), _obj, tint);
      if (i % 2 === 0) {
        _obj.position.set(px, cy + 1.7, pz);
        batch.add(key, boxGeo(0.72, 1.2, w * 0.62, 0.55), _obj, tint);
      }
    }
  }

  /** Arrow loops punched along the outer face of a curtain wall. */
  _arrowSlits(batch, x1, z1, x2, z2, y, outX, outZ, tint) {
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    const n = Math.floor(len / 5.5);
    const ux = dx / len;
    const uz = dz / len;
    const yaw = MedievalWorld._yaw(ux, uz);
    for (let i = 0; i < n; i++) {
      const t = ((i + 0.5) / n) * len;
      const px = x1 + ux * t + outX * 0.06;
      const pz = z1 + uz * t + outZ * 0.06;
      _obj.rotation.set(0, yaw, 0);
      _obj.scale.set(1, 1, 1);
      _obj.position.set(px, y, pz);
      batch.add('iron', boxGeo(0.2, 1.5, 0.14, 1.4), _obj, 0x1a1714);
      _obj.position.set(px, y - 0.55, pz);
      batch.add('iron', boxGeo(0.75, 0.2, 0.14, 1.4), _obj, 0x1a1714);
      // Chamfered stone surround.
      _obj.position.set(px, y + 0.2, pz - 0.0);
      batch.add('ashlar', boxGeo(0.95, 2.6, 0.1, 0.7), _obj, tint);
    }
  }

  /** Flight of stone steps; each tread is its own collider so step-up works. */
  _stairs(batch, key, x, z, yaw, fromY, toY, width, tint) {
    const rise = 0.32;
    const n = Math.max(2, Math.round((toY - fromY) / rise));
    const run = 0.36;
    const ux = Math.cos(yaw);
    const uz = -Math.sin(yaw);
    for (let i = 0; i < n; i++) {
      const top = fromY + ((i + 1) * (toY - fromY)) / n;
      const h = top - (fromY - 0.6);
      const cx = x + ux * (i + 0.5) * run;
      const cz = z + uz * (i + 0.5) * run;
      _obj.position.set(cx, fromY - 0.6 + h / 2, cz);
      _obj.rotation.set(0, yaw, 0);
      _obj.scale.set(1, 1, 1);
      batch.add(key, boxGeo(run, h, width, 0.65), _obj, tint);
      this._rbox(cx, fromY - 0.6 + h / 2, cz, run / 2, h / 2, width / 2, yaw);
    }
    return { x: x + ux * n * run, z: z + uz * n * run };
  }
  /* ---------------------------------------------------------------- */
  /* The castle                                                        */
  /* ---------------------------------------------------------------- */

  _buildCastle() {
    const B = new GeoBatch();
    const CX = CASTLE.x;
    const CZ = CASTLE.z;
    const G = CASTLE.ground;
    const WT = WALL_TOP;
    // Curtain thickness. 3.4m left a wall-walk of only ~2.1m between parapet
    // and kerb, which is a corridor, not a viewpoint - you could not back off
    // the merlons far enough to frame anything through them.
    const TH = 4.6;
    // Pulled down from 0xf6f2e6 / 0xe6e0cf, which were effectively
    // pass-through multipliers: the ashlar sheet is already pitched at 43-52%
    // lightness and a 0.96 tint on top of a 1.16 macro peak left the sunlit
    // east curtain sitting on the tonemapper's shoulder with no headroom for
    // the merlon caps or the string course to read against.
    const stone = 0xd6cfbe;
    const stoneAlt = 0xc4bda9;

    const place = (x, y, z, ry = 0) => {
      _obj.position.set(x, y, z);
      _obj.rotation.set(0, ry, 0);
      _obj.scale.set(1, 1, 1);
      return _obj;
    };

    const wallN = CZ - CASTLE.hz;
    const wallS = CZ + CASTLE.hz;
    const wallW = CX - CASTLE.hx;
    const wallE = CX + CASTLE.hx;
    const gateZ = CZ;

    /* ---- Curtain walls -------------------------------------------- */
    const runs = [
      // [x1,z1,x2,z2, outward normal]
      [wallW, wallN, wallE, wallN, 0, -1],
      [wallW, wallS, wallE, wallS, 0, 1],
      [wallW, wallN, wallW, wallS, -1, 0],
      [wallE, wallN, wallE, gateZ - 6.5, 1, 0],
      [wallE, gateZ + 6.5, wallE, wallS, 1, 0],
    ];
    for (const [x1, z1, x2, z2, ox, oz] of runs) {
      const dx = x2 - x1;
      const dz = z2 - z1;
      const len = Math.hypot(dx, dz);
      const mx = (x1 + x2) / 2;
      const mz = (z1 + z2) / 2;
      const yaw = MedievalWorld._yaw(dx / len, dz / len);

      B.add('ashlar', boxGeo(len, WALL_H, TH, 0.5), place(mx, G + WALL_H / 2, mz, yaw), stone);
      /* Buttresses every eight metres.
       *
       * "A straight unmodulated crenellated line reads as extruded geometry."
       * It does, and the fix is not more texture - it is a vertical rhythm the
       * silhouette can carry. A battered pilaster every 8m breaks the run into
       * bays, throws its own shadow across the curtain under a raking key, and
       * gives the eye something to measure the wall's length against. */
      const bN = Math.max(1, Math.round(len / 8));
      for (let bi = 1; bi < bN; bi++) {
        const bt2 = bi / bN;
        const bx2 = x1 + dx * bt2 + ox * (TH / 2 + 0.42);
        const bz2 = z1 + dz * bt2 + oz * (TH / 2 + 0.42);
        B.add('ashlar', boxGeo(1.9, WALL_H - 1.1, 1.15, 0.5),
          place(bx2, G + (WALL_H - 1.1) / 2, bz2, yaw), stoneAlt);
        B.add('ashlar', boxGeo(2.3, 0.34, 1.55, 0.7),
          place(bx2, G + WALL_H - 0.9, bz2, yaw), stoneAlt);
      }
      // The walk itself is flagged, not ashlar: reusing the wall material on
      // the floor at a stretched UV was what made the whole castle read as one
      // texture sprayed over everything.
      B.add('flagstone', boxGeo(len - 0.2, 0.12, TH - 1.0, 0.55),
        place(mx, WT - 0.03, mz, yaw), 0xc3bba8);
      // Battered plinth.
      B.add('ashlar', boxGeo(len, 1.5, TH + 0.9, 0.5), place(mx, G + 0.6, mz, yaw), stoneAlt);
      // String course under the wall walk.
      B.add('ashlar', boxGeo(len, 0.28, TH + 0.55, 0.6), place(mx, WT - 0.5, mz, yaw), stoneAlt);
      this._rbox(mx, G + WALL_H / 2, mz, len / 2, WALL_H / 2, TH / 2, yaw);

      // Outer parapet with merlons; inner kerb so you cannot walk off blind.
      const px = mx + ox * (TH / 2 - 0.42);
      const pz = mz + oz * (TH / 2 - 0.42);
      this._merlons(B, 'ashlar', x1 + ox * (TH / 2 - 0.42), z1 + oz * (TH / 2 - 0.42),
        x2 + ox * (TH / 2 - 0.42), z2 + oz * (TH / 2 - 0.42), WT, 0.84, stone);
      this._rbox(px, WT + 1.4, pz, len / 2, 1.4, 0.5, yaw);
      B.add('ashlar', boxGeo(len, 0.42, 0.42, 0.6),
        place(mx - ox * (TH / 2 - 0.22), WT + 0.21, mz - oz * (TH / 2 - 0.22), yaw), stoneAlt);
      this._rbox(mx - ox * (TH / 2 - 0.22), WT + 0.6, mz - oz * (TH / 2 - 0.22), len / 2, 0.6, 0.3, yaw);

      // Machicolation corbels.
      const n = Math.floor(len / 2.2);
      for (let i = 0; i < n; i++) {
        const t = ((i + 0.5) / n) * len;
        const bx = x1 + (dx / len) * t + ox * (TH / 2 + 0.16);
        const bz = z1 + (dz / len) * t + oz * (TH / 2 + 0.16);
        B.add('ashlar', boxGeo(0.5, 0.7, 0.7, 0.8), place(bx, WT - 1.1, bz, yaw), stoneAlt);
      }
      this._arrowSlits(B, x1, z1, x2, z2, G + WALL_H - 2.6, ox * (TH / 2), oz * (TH / 2), stoneAlt);
      // A second, lower tier now that the wall is tall enough to carry one.
      this._arrowSlits(B, x1, z1, x2, z2, G + WALL_H * 0.42, ox * (TH / 2), oz * (TH / 2), stoneAlt);
    }

    /* ---- Corner towers -------------------------------------------- */
    for (const [tx, tz] of [
      [wallW, wallN], [wallE, wallN], [wallW, wallS], [wallE, wallS],
    ]) {
      B.add('ashlar', cylGeo(5.8, 6.5, WALL_H, 20, 0.45), place(tx, G + WALL_H / 2, tz), stone);
      B.add('ashlar', cylGeo(6.6, 5.9, 1.4, 20, 0.45), place(tx, G + 0.7, tz), stoneAlt);
      B.add('ashlar', cylGeo(6.5, 6.0, 0.6, 20, 0.6), place(tx, WT - 0.75, tz), stoneAlt);
      B.add('ashlar', cylGeo(5.7, 5.7, 0.45, 20, 0.6), place(tx, WT - 0.2, tz), stoneAlt);
      this._towerCrown(B, 'ashlar', tx, WT, tz, 5.35, stone, 18);

      // Open watch canopy: eight piers carrying a steep conical roof, which
      // keeps the wall walk continuous through the corner.
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU + 0.39;
        B.add('ashlar', boxGeo(0.46, 2.0, 0.46, 0.9),
          place(tx + Math.cos(a) * 4.5, WT + 2.9, tz + Math.sin(a) * 4.5, -a), stoneAlt);
      }
      B.add('ashlar', cylGeo(5.4, 5.0, 0.4, 20, 0.6), place(tx, WT + 4.1, tz), stoneAlt);
      B.add('slate', coneGeo(6.2, 5.6, 20, 0.7), place(tx, WT + 7.1, tz), 0xb9c2cc);
      B.add('iron', cylGeo(0.09, 0.09, 1.9, 6, 1.2), place(tx, WT + 10.6, tz), 0x2a2622);
      B.add('banner', planeGeo(1.5, 0.75, 0), place(tx + 0.75, WT + 11.0, tz), HERALD[0]);

      // Collision: drum shell, platform floor, parapet ring. The drum's
      // visual cylinder tapers 5.8 (top) to 6.5 (base), so the shell ring
      // sits at the mean visual radius with enough thickness to cover the
      // full batter - a 5.9 ring let players sink 0.6m inside the base.
      this._ringWall(tx, G + WALL_H / 2, tz, 6.15, WALL_H / 2, 0.9, 12);
      this._discSolid(tx, WT, tz, 5.5, 1.7);
      this._ringWall(tx, WT + 1.2, tz, 5.5, 1.2, 0.5, 12);
    }

    /* ---- Gatehouse ------------------------------------------------- */
    const gxOuter = wallE + 5.0;
    const gxInner = wallE - 4.0;
    const gxMid = (gxOuter + gxInner) / 2;
    const gDepth = gxOuter - gxInner;
    const passHalf = 2.3;
    for (const s of [-1, 1]) {
      const pz = gateZ + s * (passHalf + 2.1);
      B.add('ashlar', boxGeo(gDepth, WALL_H, 4.2, 0.5), place(gxMid, G + WALL_H / 2, pz), stone);
      B.add('ashlar', boxGeo(gDepth + 0.8, 1.6, 5.0, 0.5), place(gxMid, G + 0.7, pz), stoneAlt);
      this._rbox(gxMid, G + WALL_H / 2, pz, gDepth / 2, WALL_H / 2, 2.1, 0);
      // Flanking drums with tall conical caps.
      const dz2 = gateZ + s * 6.5;
      B.add('ashlar', cylGeo(4.2, 4.8, 19.5, 18, 0.45), place(gxMid + 0.6, G + 9.75, dz2), stone);
      B.add('ashlar', cylGeo(4.9, 4.3, 0.6, 18, 0.6), place(gxMid + 0.6, G + 19.7, dz2), stoneAlt);
      this._towerCrown(B, 'ashlar', gxMid + 0.6, G + 19.9, dz2, 3.9, stone, 14);
      B.add('slate', coneGeo(4.8, 6.4, 18, 0.7), place(gxMid + 0.6, G + 25.1, dz2), 0xb0bac6);
      B.add('iron', cylGeo(0.08, 0.08, 1.6, 6, 1.2), place(gxMid + 0.6, G + 29.1, dz2), 0x2a2622);
      this._ringWall(gxMid + 0.6, G + 9.75, dz2, 4.4, 9.75, 0.6, 8);
    }
    /* Lintel over the passage, then the masonry that carries the wall walk.
     *
     * The arch springs at G+2.5 with a 2.3m radius, so the passage head is at
     * G+4.8 and the walk deck sits at WT-0.45. With a 6.4m curtain those two
     * numbers were 1.2m apart and one lintel course spanned the gap; at 10.6m
     * there is five metres of gatehouse front between them, and leaving it
     * empty would hang the wall walk over a void. */
    B.add('ashlar', boxGeo(gDepth, 1.6, passHalf * 2 + 0.4, 0.5),
      place(gxMid, G + 5.6, gateZ), stone);
    this._box(gxMid, G + 5.6, gateZ, gDepth / 2, 0.8, passHalf + 0.2);
    {
      const fillY0 = G + 6.4;
      const fillH = Math.max(0.4, WALL_TOP - 0.9 - fillY0);
      B.add('ashlar', boxGeo(gDepth, fillH, passHalf * 2 + 0.4, 0.5),
        place(gxMid, fillY0 + fillH / 2, gateZ), stone);
      // Murder-hole gallery window, so the front is not a blank panel.
      B.add('ashlar', boxGeo(gDepth + 0.5, 0.3, passHalf * 2 + 1.6, 0.7),
        place(gxMid, fillY0 + fillH * 0.55, gateZ), stoneAlt);
    }
    for (const s of [-1, 1]) {
      const m = new THREE.Matrix4()
        .makeRotationY(s > 0 ? 0 : Math.PI)
        .setPosition(gxMid + s * (gDepth / 2 + 0.16), G + 2.5, gateZ);
      this._archRing(B, 'ashlar', m, passHalf, 0.55, 0.55, stoneAlt);
    }
    // Roof of the gate passage carries the wall walk across.
    B.add('ashlar', boxGeo(gDepth + 0.4, 0.9, passHalf * 2 + 4.4, 0.5),
      place(gxMid, WT - 0.45, gateZ), stone);
    this._box(gxMid, WT - 0.45, gateZ, (gDepth + 0.4) / 2, 0.45, passHalf + 2.2);
    this._merlons(B, 'ashlar', gxOuter - 0.42, gateZ - 6.4, gxOuter - 0.42, gateZ + 6.4, WT, 0.84, stone);
    this._box(gxOuter - 0.42, WT + 1.4, gateZ, 0.5, 1.4, 6.4);
    // Machicolated box projecting over the gate.
    B.add('ashlar', boxGeo(1.1, 2.2, passHalf * 2 + 2.2, 0.55),
      place(gxOuter + 0.5, WT - 1.6, gateZ), stoneAlt);
    for (let i = -3; i <= 3; i++) {
      B.add('ashlar', boxGeo(1.2, 0.8, 0.55, 0.9),
        place(gxOuter + 0.5, WT - 3.0, gateZ + i * 1.05), stoneAlt);
    }

    // Portcullis, half lowered, with its groove and windlass chains.
    for (let i = 0; i <= 10; i++) {
      const bz = gateZ - passHalf + (i / 10) * passHalf * 2;
      B.add('iron', boxGeo(0.13, 3.6, 0.13, 1.6),
        place(gxMid + gDepth / 2 - 0.9, G + 4.6, bz), 0x2b2723);
    }
    for (let i = 0; i < 3; i++) {
      B.add('iron', boxGeo(0.13, 0.13, passHalf * 2, 1.6),
        place(gxMid + gDepth / 2 - 0.9, G + 3.1 + i * 1.5, gateZ), 0x2b2723);
    }
    for (const s of [-1, 1]) {
      B.add('iron', cylGeo(0.05, 0.05, 3.0, 6, 1.5),
        place(gxMid + gDepth / 2 - 0.9, G + 7.2, gateZ + s * (passHalf - 0.3)), 0x37312a);
    }
    // Braced oak leaves, swung open against the passage walls.
    for (const s of [-1, 1]) {
      const doorYaw = s * 1.75;
      const hz2 = gateZ + s * passHalf;
      const cx2 = gxMid - gDepth / 2 + 1.0 + Math.cos(doorYaw) * 1.1;
      const cz2 = hz2 - s * 1.1 * Math.abs(Math.sin(doorYaw));
      B.add('plank', boxGeo(2.2, 4.4, 0.22, 0.7), place(cx2, G + 2.3, cz2, doorYaw), 0x8a6a44);
      for (let i = 0; i < 3; i++) {
        B.add('iron', boxGeo(2.3, 0.16, 0.28, 1.4),
          place(cx2, G + 0.8 + i * 1.5, cz2, doorYaw), 0x2b2723);
      }
    }

    /* ---- Drawbridge over the moat ---------------------------------- */
    const dbLen = 14.6;
    const dbCx = gxOuter + dbLen / 2;
    B.add('plank', boxGeo(dbLen, 0.34, 5.0, 0.7), place(dbCx, G - 0.14, gateZ), 0x9a7a52);
    for (let i = 0; i < 9; i++) {
      B.add('beam', boxGeo(0.34, 0.2, 5.1, 0.9),
        place(gxOuter + 0.9 + i * 1.65, G + 0.06, gateZ), 0xa08560);
    }
    for (const s of [-1, 1]) {
      B.add('beam', boxGeo(dbLen, 0.4, 0.3, 0.8), place(dbCx, G + 0.1, gateZ + s * 2.5), 0x8a6f4c);
      B.add('iron', cylGeo(0.06, 0.06, 12.5, 6, 1.2),
        place(gxOuter + 5.6, G + 6.2, gateZ + s * 2.4, 0));
    }
    this._box(dbCx, G - 0.3, gateZ, dbLen / 2, 0.3, 2.6);
    // Stone abutment on the far bank. The old single block's top stood ~2.3m
    // proud of the bank terrain with no ramp - an unpassable "strange shape"
    // at the end of the bridge. Land the deck on a flush cap, then step the
    // masonry down to the ground so the crossing is walkable both ways.
    {
      const abX = gxOuter + dbLen + 1.2;
      B.add('rubble', boxGeo(3.0, 5.6, 6.6, 0.5), place(abX, G - 2.95, gateZ), 0xb6ae9b);
      this._box(abX, G - 2.95, gateZ, 1.5, 2.8, 3.3);
      const bankY = this._height(abX + 8.0, gateZ);
      const drop = Math.max(0, G - 0.15 - bankY);
      const steps = Math.max(2, Math.ceil(drop / 0.38));
      const run = 1.15;
      for (let i = 0; i < steps; i++) {
        const sx = abX + 1.5 + run / 2 + i * run;
        const topY = G - 0.15 - ((i + 1) * drop) / steps;
        B.add('rubble', boxGeo(run + 0.08, 1.2, 5.4, 0.5),
          place(sx, topY - 0.6, gateZ), 0xb0a894);
        this._box(sx, topY - 0.6, gateZ, run / 2 + 0.04, 0.6, 2.7);
      }
    }

    /* ---- Stairs to the wall walk -----------------------------------
     *
     * Both flights climb *away* from the nearest tower. They used to climb into
     * one: the east flight ran toward the gatehouse and the west flight toward
     * the north-west turret, and a tower's ring-wall colliders stand from the
     * bailey floor to well above the wall walk. Measured on the built castle,
     * the east flight rose from 9.60 m to 14.42 m and then met a solid face
     * 14.7 m tall across the rest of its run, and the west flight reached
     * 16.67 m before a turret cut it off 3.5 m short of the walk. Neither
     * staircase could be climbed to the top, which is the only reason either
     * exists.
     *
     * The east flight also starts 2 m further from the gate than it did, so its
     * 11.9 m run finishes clear of the north-east corner rather than ending
     * underneath it. */
    this._stairs(B, 'ashlar', wallE - TH / 2 - 0.95, gateZ - 13.0, Math.PI / 2,
      G, WT, 1.9, stoneAlt);
    this._stairs(B, 'ashlar', wallW + TH / 2 + 0.95, wallN + 14.0, Math.PI / 2 + Math.PI,
      G, WT, 1.9, stoneAlt);

    this._rampartDressing(B, place, stoneAlt, wallW, wallE, wallN, wallS, TH, WT, G);
    this._castleKeep(B, place, stone, stoneAlt);
    this._castleYard(B, place, stone, stoneAlt);

    /* ---- Vertical weathering ----------------------------------------
     *
     * "A uniform-tone brown box", "one uniform tan with nothing but N.L
     * shading on it", "a single tan value" - three reviewers, three ways of
     * saying the same thing: 110m of masonry with no value structure across
     * its own height. Coursing texture cannot fix that, because at 110m the
     * ashlar sheet is below a texel. What fixes it is the gradient every real
     * fortification carries: the batter and the first two or three metres are
     * permanently wet, algal and water-stained; the parapet and the merlon
     * caps are sun-bleached and rain-washed. Baked into the vertex colours of
     * the whole district in one pass, so it costs nothing and it survives to
     * any distance the geometry does.
     *
     * The ramp is deliberately non-linear - stone darkens fast in the splash
     * zone and slowly above it - and it cools as it darkens, because standing
     * damp on limestone reads green-grey, not brown.
     */
    for (const arr of B.map.values()) {
      for (const g of arr) {
        const pos = g.attributes.position;
        const col = g.attributes.color;
        if (!pos || !col) continue;
        for (let i = 0; i < pos.count; i++) {
          const t = clamp01((pos.getY(i) - (G - 2.6)) / 26);
          const k = lerp(0.62, 1.06, Math.pow(t, 0.55));
          col.setXYZ(i,
            col.getX(i) * k,
            col.getY(i) * lerp(k * 1.015, k, t),
            col.getZ(i) * lerp(k * 1.05, k * 0.96, t));
        }
        col.needsUpdate = true;
      }
    }

    B.build(this._mats, this.group, { ao: this._heightFn });
    this._footprints.push({ x: CX, z: CZ, hx: CASTLE.hx + 18, hz: CASTLE.hz + 18, r: 0 });
  }
  /**
   * Everything that says a garrison lives here: braziers, spear racks, shields
   * hung on the parapet, stacked stores. An undressed rampart is a blockout -
   * the wall walk was the one place in the castle with nothing on it at all.
   */
  _rampartDressing(B, place, stoneAlt, wallW, wallE, wallN, wallS, TH, WT, G) {
    const rnd = mulberry32(0x5a99ce);
    const inset = TH / 2 - 1.25;
    const stations = [];
    for (let x = wallW + 12; x < wallE - 12; x += 12.5) {
      stations.push([x, wallN + inset, 0]);
      stations.push([x + 6, wallS - inset, Math.PI]);
    }
    for (let z = wallN + 14; z < wallS - 14; z += 12.5) {
      stations.push([wallW + inset, z, Math.PI / 2]);
    }

    stations.forEach(([x, z, yaw], i) => {
      const kind = i % 3;
      if (kind === 0) {
        // Iron brazier on a tripod, coals banked.
        B.add('iron', cylGeo(0.6, 0.3, 0.72, 10, 0.9), place(x, WT + 1.0, z), 0x3a332b);
        for (let k = 0; k < 3; k++) {
          const a = (k / 3) * TAU + 0.4;
          B.add('iron', boxGeo(0.09, 1.0, 0.09, 1.4),
            place(x + Math.cos(a) * 0.34, WT + 0.5, z + Math.sin(a) * 0.34), 0x332d26);
        }
        B.add('ember', cylGeo(0.52, 0.42, 0.3, 10, 1.0), place(x, WT + 1.4, z), 0xffb070);
      } else if (kind === 1) {
        // Spear rack leaning against the parapet.
        B.add('beam', boxGeo(1.9, 0.14, 0.5, 1.1), place(x, WT + 0.62, z, yaw), 0x6f5539);
        for (let k = 0; k < 6; k++) {
          _obj.position.set(x + Math.cos(yaw) * (-0.8 + k * 0.32), WT + 1.5,
            z - Math.sin(yaw) * (-0.8 + k * 0.32));
          _obj.rotation.set(Math.sin(yaw) * 0.2, yaw, Math.cos(yaw) * 0.2);
          _obj.scale.set(1, 1, 1);
          B.add('beam', boxGeo(0.06, 2.6, 0.06, 1.6), _obj, 0x8a6c4a);
          _obj.position.set(x + Math.cos(yaw) * (-0.8 + k * 0.32), WT + 2.75,
            z - Math.sin(yaw) * (-0.8 + k * 0.32));
          B.add('iron', boxGeo(0.07, 0.34, 0.07, 2.0), _obj, 0x8b8f93);
        }
      } else {
        // Stores: a barrel of bolts and a crate, plus a shield on the parapet.
        B.add('plank', cylGeo(0.4, 0.34, 0.94, 12, 1.0),
          place(x, WT + 0.55, z, rnd() * TAU), 0x8f6f47);
        B.add('iron', cylGeo(0.43, 0.43, 0.09, 12, 1.4), place(x, WT + 0.86, z), 0x35302a);
        B.add('plank', boxGeo(0.72, 0.6, 0.72, 1.3),
          place(x + Math.sin(yaw) * 0.95, WT + 0.38, z + Math.cos(yaw) * 0.95, yaw + 0.3), 0xa07f52);
      }

      // A painted shield hung on the inner face of every station's merlon run.
      _obj.position.set(x - Math.sin(yaw) * (0.95), WT + 1.55, z - Math.cos(yaw) * (0.95));
      _obj.rotation.set(0, yaw + Math.PI, 0);
      _obj.scale.set(1, 1, 1);
      B.add('banner', planeGeo(0.72, 0.9, 0), _obj, HERALD[i % HERALD.length]);
      B.add('iron', boxGeo(0.1, 0.1, 0.1, 2.0), _obj, 0x8b8f93);
    });

    // Only two of the braziers actually carry a light: the wall walk needs a
    // warm focal accent, not twenty more entries in the forward light loop.
    for (const [bx, bz] of [[wallW + 12, wallN + inset], [wallW + inset, wallN + 39]]) {
      const l = pointLight(0xff8a2e, 64, 26, 2);
      l.position.set(bx, WT + 2.1, bz);
      this.group.add(l);
      this._addGlow(bx, WT + 0.14, bz, 5.5, 0x50301a);
    }
    // Stores stacked along the inside of the north curtain, clear of both the
    // stable range on the west wall and the keep in the middle of the bailey.
    for (let i = 0; i < 9; i++) {
      const x = wallW + 22 + rnd() * 42;
      const z = wallN + 5 + rnd() * 5;
      B.add('plank', boxGeo(0.8, 0.66, 0.8, 1.3), place(x, G + 0.33, z, rnd() * TAU), 0xa07f52);
      if (rnd() < 0.5) {
        B.add('plank', boxGeo(0.7, 0.6, 0.7, 1.3), place(x + 0.1, G + 0.95, z, rnd() * TAU), 0x94734a);
      }
      this._box(x, G + 0.5, z, 0.45, 0.5, 0.45);
    }
  }

  /** The great keep: enterable hall, battlements, stair turret. */
  _castleKeep(B, place, stone, stoneAlt) {
    const KX = CASTLE.x - 6;
    const KZ = CASTLE.z + 2;
    const G = CASTLE.ground;
    const HW = 13;
    const HD = 8.5;
    const WALL = 1.5;
    const TOP = G + 19.6;
    const nZ = KZ - HD;
    const sZ = KZ + HD;
    const wX = KX - HW;
    const eX = KX + HW;

    // Shell. The east wall is split to leave a doorway onto the bailey.
    const solid = (cx, cy, cz, hx, hy, hz, tint, tile = 0.45) => {
      B.add('ashlar', boxGeo(hx * 2, hy * 2, hz * 2, tile), place(cx, cy, cz), tint);
      this._box(cx, cy, cz, hx, hy, hz);
    };
    solid(KX, G + 10.2, nZ, HW + WALL, 10.2, WALL, stone);
    solid(KX, G + 10.2, sZ, HW + WALL, 10.2, WALL, stone);
    solid(wX, G + 10.2, KZ, WALL, 10.2, HD, stone);
    const doorHalf = 1.4;
    for (const s of [-1, 1]) {
      const segHalf = (HD - doorHalf) / 2;
      solid(eX, G + 10.2, KZ + s * (doorHalf + segHalf), WALL, 10.2, segHalf, stone);
    }
    // Everything above the door head, all the way to the wall top - leaving a
    // slot open here is instantly readable as a hole in the building.
    solid(eX, G + 11.6, KZ, WALL, 8.8, doorHalf, stone);
    const m = new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(eX + WALL + 0.1, G + 1.8, KZ);
    this._archRing(B, 'ashlar', m, doorHalf, 0.4, 0.5, stoneAlt);
    // Windows on the courtyard and back faces so the ends are not blank slabs.
    for (const sx of [-1, 1]) {
      for (const y of [G + 6.6, G + 13.8]) {
        const wx = KX + sx * (HW + WALL - 0.1);
        B.add('ashlar', boxGeo(0.5, 4.4, 2.0, 0.7), place(wx, y + 0.6, KZ), stoneAlt);
        B.add('glass', planeGeo(1.25, 2.9, 0.9),
          place(wx + sx * 0.28, y + 0.4, KZ, sx > 0 ? Math.PI / 2 : -Math.PI / 2), 0xffd9a0);
        const mm = new THREE.Matrix4()
          .makeRotationY(sx > 0 ? Math.PI / 2 : -Math.PI / 2)
          .setPosition(wx + sx * 0.28, y + 1.85, KZ);
        this._archRing(B, 'ashlar', mm, 0.62, 0.26, 0.3, stoneAlt);
      }
    }

    // Battered plinth and a string course at first-floor level. The plinth
    // used to be one collider-less slab that oversailed the walls by 0.8m and
    // ran straight across the east doorway - a phantom "extra floor" you
    // could walk through and that visually cut the door arch. Build it as
    // four solid strips instead, split around the door span, each with a
    // matching collider so the batter is real.
    {
      const P = 0.8; // oversail beyond the wall face
      const py = G + 0.8;
      const phh = 0.9;
      const fx = HW + WALL; // wall face distance, x
      const fz = HD + WALL; // wall face distance, z
      const gapHalf = doorHalf + 0.7; // clear the arch + jamb ring
      const strip = (cx, cz, hx, hz) => {
        B.add('ashlar', boxGeo(hx * 2, 1.8, hz * 2, 0.45), place(cx, py, cz), stoneAlt);
        this._box(cx, py, cz, hx, phh, hz);
      };
      // North / south strips run the full width including the corners.
      strip(KX, KZ - fz - P / 2 + 0.05, fx + P, P / 2 + 0.05);
      strip(KX, KZ + fz + P / 2 - 0.05, fx + P, P / 2 + 0.05);
      // West strip between them.
      strip(KX - fx - P / 2 + 0.05, KZ, P / 2 + 0.05, fz);
      // East strip is split around the doorway.
      const segHalf = (fz - gapHalf) / 2;
      for (const s of [-1, 1]) {
        strip(KX + fx + P / 2 - 0.05, KZ + s * (gapHalf + segHalf), P / 2 + 0.05, segHalf);
      }
    }
    B.add('ashlar', boxGeo((HW + WALL) * 2 + 0.5, 0.3, (HD + WALL) * 2 + 0.5, 0.6),
      place(KX, G + 9.6, KZ), stoneAlt);

    // Clasping pilaster buttresses.
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        B.add('ashlar', boxGeo(2.4, 20.4, 2.4, 0.5),
          place(KX + sx * (HW + 0.4), G + 10.2, KZ + sz * (HD + 0.4)), stone);
      }
      for (const t of [-0.45, 0.45]) {
        B.add('ashlar', boxGeo(1.5, 20.4, 1.5, 0.5),
          place(KX + sx * HW * t * 2, G + 10.2, KZ + (HD + WALL + 0.4)), stoneAlt);
      }
    }

    // Battlements, then a steep slate roof rising inside them.
    for (const [x1, z1, x2, z2] of [
      [wX - WALL, nZ - WALL, eX + WALL, nZ - WALL],
      [wX - WALL, sZ + WALL, eX + WALL, sZ + WALL],
      [wX - WALL, nZ - WALL, wX - WALL, sZ + WALL],
      [eX + WALL, nZ - WALL, eX + WALL, sZ + WALL],
    ]) {
      this._merlons(B, 'ashlar', x1, z1, x2, z2, TOP, 0.9, stone);
    }
    /* ---- Leaded roof walk ------------------------------------------- *
     * Was a steep pitched slate roof rising 5m inside the battlements. From
     * anywhere on or above the keep that roof filled the frame as one
     * untextured black plane with a hard diagonal edge and nothing behind it -
     * the highest vantage in the world resolved as a soffit. A flat leaded
     * deck behind the parapet is both the correct thing for a Norman great
     * keep and the thing that turns the top of the castle into a place you can
     * stand, look out from and photograph. The stair turret keeps the vertical
     * accent, so the silhouette gains a flat-top/spire contrast rather than
     * losing anything. */
    const DECK = TOP + 0.34;
    B.add('flagstone', boxGeo((HW + WALL) * 2, 0.34, (HD + WALL) * 2, 0.62),
      place(KX, DECK - 0.17, KZ), 0x9aa2a8);
    this._box(KX, DECK - 0.6, KZ, HW + WALL, 0.6, HD + WALL);
    // Shallow lead rolls across the deck: a dead-flat 26x20m plane at the top
    // of the build reads as a placeholder, and the rolls catch the low sun.
    for (let i = -3; i <= 3; i++) {
      B.add('slate', boxGeo(0.28, 0.12, (HD + WALL) * 2 - 0.4, 1.1),
        place(KX + i * 3.6, DECK + 0.05, KZ), 0x8e969d);
    }
    // A gutter and two spouts, so the deck has drainage logic.
    for (const s of [-1, 1]) {
      B.add('ashlar', boxGeo(0.5, 0.34, 1.2, 0.9),
        place(KX + s * (HW + WALL - 0.2), DECK + 0.12, KZ + s * 3.4), 0xd6cdb8);
    }
    // Roof-walk dressing: a signal brazier and a hoisted standard. Both exist
    // to give the highest vantage a warm accent and a foreground element with
    // parallax rather than an empty deck.
    const bzx = KX + HW - 3.2;
    const bzz = KZ + HD - 2.4;
    B.add('iron', cylGeo(0.62, 0.32, 0.74, 12, 0.9), place(bzx, DECK + 1.05, bzz), 0x3a332b);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * TAU + 0.4;
      B.add('iron', boxGeo(0.09, 1.05, 0.09, 1.4),
        place(bzx + Math.cos(a) * 0.35, DECK + 0.52, bzz + Math.sin(a) * 0.35), 0x332d26);
    }
    B.add('ember', cylGeo(0.54, 0.44, 0.32, 12, 1.0), place(bzx, DECK + 1.46, bzz), 0xffb070);
    const roofFire = pointLight(0xff8a2e, 78, 26, 2);
    roofFire.position.set(bzx, DECK + 1.9, bzz);
    this.group.add(roofFire);
    this._addGlow(bzx, DECK + 0.06, bzz, 6.5, 0x50301a);

    const flx = KX - HW + 2.6;
    const flz = KZ - HD + 2.2;
    B.add('beam', cylGeo(0.13, 0.17, 7.2, 8, 0.9), place(flx, DECK + 3.6, flz), 0x6f5539);
    B.add('banner', planeGeo(2.2, 4.4, 0), place(flx + 1.15, DECK + 4.6, flz, 0.12), HERALD[0]);
    this._box(flx, DECK + 3.6, flz, 0.2, 3.6, 0.2);

    // Stair turret with a tall spire - the silhouette anchor of the whole vale.
    const tx = eX - 1.0;
    const tz = nZ + 1.0;
    B.add('ashlar', cylGeo(3.2, 3.6, 28.5, 16, 0.45), place(tx, G + 14.25, tz), stone);
    B.add('ashlar', cylGeo(3.7, 3.2, 0.55, 16, 0.6), place(tx, G + 28.6, tz), stoneAlt);
    this._towerCrown(B, 'ashlar', tx, G + 28.9, tz, 3.0, stone, 12);
    B.add('slate', coneGeo(3.6, 8.6, 16, 0.7), place(tx, G + 35.6, tz), 0xa4aeba);
    B.add('iron', cylGeo(0.07, 0.07, 2.2, 6, 1.2), place(tx, G + 41.0, tz), 0x2a2622);
    B.add('iron', boxGeo(1.4, 0.9, 0.05, 1.4), place(tx + 0.7, G + 41.6, tz), 0x3a332b);
    this._ringWall(tx, G + 14.25, tz, 3.4, 14.25, 0.6, 8);

    // Arched windows with leaded glass, lit from within.
    for (const sz of [-1, 1]) {
      for (let i = -1; i <= 1; i++) {
        for (const y of [G + 6.2, G + 13.4]) {
          const wx = KX + i * 7.4;
          const wz = KZ + sz * (HD + WALL - 0.1);
          B.add('ashlar', boxGeo(2.1, 4.6, 0.5, 0.7), place(wx, y + 0.6, wz), stoneAlt);
          B.add('glass', planeGeo(1.3, 3.0, 0.9), place(wx, y + 0.4, wz + sz * 0.28,
            sz > 0 ? 0 : Math.PI), 0xffd9a0);
          const mm = new THREE.Matrix4()
            .makeRotationY(sz > 0 ? 0 : Math.PI)
            .setPosition(wx, y + 1.9, wz + sz * 0.28);
          this._archRing(B, 'ashlar', mm, 0.65, 0.28, 0.3, stoneAlt);
        }
      }
    }

    /* ---- Great hall interior --------------------------------------- */
    B.add('plank', boxGeo(HW * 2, 0.3, HD * 2, 0.5), place(KX, G + 0.05, KZ), 0xb59468);
    this._box(KX, G - 0.05, KZ, HW, 0.3, HD);

    // Hammerbeam trusses.
    for (let i = -2; i <= 2; i++) {
      const x = KX + i * 5.0;
      for (const s of [-1, 1]) {
        const g = boxGeo(0.42, HD * 1.15, 0.5, 0.8);
        _obj.position.set(x, G + 15.4, KZ + s * HD * 0.5);
        _obj.rotation.set(s * -0.52, 0, 0);
        _obj.scale.set(1, 1, 1);
        B.add('beam', g, _obj, 0x8a6c4a);
        B.add('beam', boxGeo(0.4, 0.4, 3.4, 0.8), place(x, G + 12.6, KZ + s * (HD - 1.7)), 0x7a5f42);
      }
      B.add('beam', boxGeo(0.45, 0.45, HD * 2, 0.8), place(x, G + 12.4, KZ), 0x86684a);
      B.add('beam', boxGeo(0.4, 3.0, 0.4, 0.8), place(x, G + 17.0, KZ), 0x7a5f42);
    }

    // Fireplace with a hood, and a bed of embers.
    B.add('rubble', boxGeo(1.2, 7.4, 6.4, 0.5), place(wX + 1.2, G + 3.7, KZ), 0xb2a996);
    B.add('rubble', boxGeo(1.6, 1.0, 5.0, 0.6), place(wX + 1.4, G + 3.6, KZ), 0xcfc6b2);
    B.add('rubble', boxGeo(1.1, 4.0, 2.6, 0.6), place(wX + 1.3, G + 9.4, KZ), 0xd4cbb8);
    B.add('ember', boxGeo(0.7, 0.35, 3.0, 1.0), place(wX + 1.4, G + 0.35, KZ), 0xffb060);
    const hearth = pointLight(0xff8a2e, 90, 26, 2);
    hearth.position.set(wX + 2.6, CASTLE.ground + 1.6, KZ);
    this.group.add(hearth);

    // Trestle tables, benches and a dais.
    const table = (x, z, len, ry) => {
      B.add('plank', boxGeo(len, 0.14, 1.3, 0.7), place(x, G + 0.98, z, ry), 0xc3a274);
      for (const s of [-1, 1]) {
        B.add('beam', boxGeo(0.24, 0.92, 1.2, 0.9), place(
          x + Math.cos(ry) * s * (len / 2 - 0.7),
          G + 0.5,
          z - Math.sin(ry) * s * (len / 2 - 0.7), ry), 0x6f5539);
        B.add('plank', boxGeo(len * 0.92, 0.1, 0.42, 0.8), place(
          x - Math.sin(ry) * s * 1.15, G + 0.55, z - Math.cos(ry) * s * 1.15, ry), 0xb08f62);
        B.add('beam', boxGeo(0.16, 0.5, 0.4, 1.0), place(
          x - Math.sin(ry) * s * 1.15, G + 0.25, z - Math.cos(ry) * s * 1.15, ry), 0x6f5539);
      }
    };
    table(KX - 3, KZ - 4.0, 12, 0);
    table(KX - 3, KZ + 4.0, 12, 0);
    table(KX + 8.5, KZ, 9, Math.PI / 2);
    for (let i = 0; i < 5; i++) {
      B.add('iron', cylGeo(0.13, 0.16, 0.5, 8, 1.2),
        place(KX - 8 + i * 4, G + 1.3, KZ + (i % 2 ? 4 : -4)), 0x38322b);
      B.add('ember', cylGeo(0.06, 0.06, 0.34, 6, 1.4),
        place(KX - 8 + i * 4, G + 1.7, KZ + (i % 2 ? 4 : -4)), 0xffc47a);
    }
    const hallLight = pointLight(0xffb45a, 55, 30, 2);
    hallLight.position.set(KX, CASTLE.ground + 6.5, KZ);
    this.group.add(hallLight);

    // Banners down the hall walls.
    for (let i = 0; i < 4; i++) {
      for (const sz of [-1, 1]) {
        B.add('banner', planeGeo(2.0, 5.0, 0),
          place(KX - 9 + i * 6, G + 12.0, KZ + sz * (HD - 0.3), sz > 0 ? Math.PI : 0),
          HERALD[(i + (sz > 0 ? 1 : 0)) % HERALD.length]);
        B.add('beam', boxGeo(2.4, 0.16, 0.16, 1.2),
          place(KX - 9 + i * 6, G + 14.55, KZ + sz * (HD - 0.3)), 0x5f4a33);
      }
    }
  }

  /** Bailey dressing: stables, well, braziers, stores, banners. */
  _castleYard(B, place, stone, stoneAlt) {
    const G = CASTLE.ground;
    const rnd = mulberry32(0x0ca57123);

    // Lean-to stable range against the west curtain.
    const sx = CASTLE.x - CASTLE.hx + 7.5;
    for (let i = 0; i < 4; i++) {
      const z = CASTLE.z - 12 + i * 8;
      B.add('rubble', boxGeo(6.0, 3.2, 7.2, 0.5), place(sx, G + 1.6, z), 0xd6cdba);
      B.add('beam', boxGeo(6.4, 0.3, 7.6, 0.8), place(sx, G + 3.3, z), 0x7c603f);
      const g = boxGeo(6.6, 0.3, 7.8, 0.6);
      _obj.position.set(sx + 0.3, G + 4.1, z);
      _obj.rotation.set(0, 0, 0.34);
      _obj.scale.set(1, 1, 1);
      B.add('thatch', g, _obj, THATCH_TINTS[i % THATCH_TINTS.length]);
      this._box(sx, G + 1.6, z, 3.0, 1.6, 3.6);
      for (let k = 0; k < 3; k++) {
        B.add('beam', boxGeo(0.22, 2.4, 0.22, 1.0), place(sx + 3.1, G + 1.2, z - 3 + k * 3), 0x6d5438);
      }
      B.add('hay', boxGeo(2.2, 0.7, 1.6, 0.8), place(sx + 2.4, G + 0.35, z + 2.6), 0xf0d089);
    }

    // Bailey well.
    const wx = CASTLE.x + 6;
    const wz = CASTLE.z + 16;
    B.add('rubble', cylGeo(1.5, 1.6, 1.3, 16, 0.7), place(wx, G + 0.65, wz), 0xb2a996);
    B.add('rubble', cylGeo(1.7, 1.55, 0.2, 16, 0.9), place(wx, G + 1.35, wz), 0xa79f8d);
    for (const s of [-1, 1]) {
      B.add('beam', boxGeo(0.22, 2.4, 0.22, 1.0), place(wx + s * 1.3, G + 2.4, wz), 0x6d5438);
    }
    B.add('beam', cylGeo(0.16, 0.16, 2.6, 8, 1.0), place(wx, G + 3.4, wz, 0), 0x7a5e3f);
    _obj.position.set(wx, G + 3.9, wz);
    _obj.rotation.set(0, Math.PI / 2, 0);
    _obj.scale.set(1, 1, 1);
    B.add('thatch', boxGeo(3.4, 0.28, 2.6, 0.8), _obj, 0xdcbb70);
    B.add('iron', cylGeo(0.02, 0.02, 1.6, 4, 2.0), place(wx, G + 2.6, wz), 0x2f2a24);
    B.add('plank', cylGeo(0.28, 0.24, 0.36, 10, 1.2), place(wx, G + 1.9, wz), 0x9c7c50);
    this._discSolid(wx, G + 1.45, wz, 1.7, 1.4);

    // Braziers flanking the gate approach.
    for (const s of [-1, 1]) {
      const bx = CASTLE.x + CASTLE.hx - 7;
      const bz = CASTLE.z + s * 5.5;
      B.add('iron', cylGeo(0.7, 0.35, 0.9, 10, 0.9), place(bx, G + 0.95, bz), 0x3a332b);
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * TAU;
        B.add('iron', boxGeo(0.1, 1.1, 0.1, 1.4),
          place(bx + Math.cos(a) * 0.4, G + 0.5, bz + Math.sin(a) * 0.4), 0x332d26);
      }
      B.add('ember', cylGeo(0.62, 0.5, 0.35, 10, 1.0), place(bx, G + 1.5, bz), 0xffb070);
      const l = pointLight(0xff7a22, 80, 24, 2);
      l.position.set(bx, G + 2.0, bz);
      this.group.add(l);
    }

    // Stores: barrels, crates, a wood stack and a cart.
    for (let i = 0; i < 14; i++) {
      const x = CASTLE.x - 24 + rnd() * 40;
      const z = CASTLE.z + 12 + rnd() * 12;
      B.add('plank', cylGeo(0.42, 0.36, 1.0, 12, 1.0), place(x, G + 0.5, z, rnd() * TAU), 0x8f6f47);
      B.add('iron', cylGeo(0.45, 0.45, 0.1, 12, 1.4), place(x, G + 0.22, z), 0x35302a);
      B.add('iron', cylGeo(0.45, 0.45, 0.1, 12, 1.4), place(x, G + 0.82, z), 0x35302a);
      this._box(x, G + 0.5, z, 0.45, 0.5, 0.45);
    }
    for (let i = 0; i < 22; i++) {
      const x = CASTLE.x - 30 + rnd() * 8;
      const z = CASTLE.z - 26 + rnd() * 10;
      B.add('beam', cylGeo(0.12, 0.13, 1.5, 7, 1.2), place(x, G + 0.15 + (i % 4) * 0.26, z,
        Math.PI / 2), 0x86684a);
    }

    // Banners either side of the keep door and along the inner curtain.
    for (let i = 0; i < 5; i++) {
      const bz = CASTLE.z - 20 + i * 10;
      const bx = CASTLE.x + CASTLE.hx - 2.0;
      B.add('banner', planeGeo(2.2, 6.0, 0), place(bx, G + 12.6, bz, -Math.PI / 2),
        HERALD[i % HERALD.length]);
      B.add('beam', boxGeo(0.16, 0.16, 2.6, 1.2), place(bx, WALL_TOP - 0.6, bz), 0x5f4a33);
    }
  }
  /* ---------------------------------------------------------------- */
  /* Timber-framed buildings                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Build one grass zone, or return null if nothing would stand there.
   *
   * The placement below is the field's original pass, moved verbatim - same
   * clump budget, same rejection order, same jitter - with one deliberate
   * change: the RNG is seeded from the ZONE, not drawn from the world's shared
   * scatter stream. It has to be. A zone that is freed when the player walks
   * away and rebuilt when they come back must come back identical, and a
   * shared stream makes a zone's contents depend on how many zones happened to
   * be built before it.
   *
   * @param {number} key `GrassResidency` zone key
   */
  _buildGrassZone(key) {
    const R = this._grass;
    const zx = R.zoneX(key);
    const zz = R.zoneZ(key);
    const x0 = R.originX(zx);
    const z0 = R.originZ(zz);
    const span = R.span;
    /* Two odd primes, so no two zones in an 18x18 grid share a seed and
     * neighbouring zones do not share low bits either. */
    const rnd = mulberry32((0x6a55f00d ^ (zx * 73856093) ^ (zz * 19349663)) >>> 0);
    const CLUMPS = 720;
    const mat4 = [];
    const colBuf = [];
    let g2 = 0;
    let clumps = 0;
    while (clumps < CLUMPS && g2++ < CLUMPS * 4) {
      const cx = x0 + rnd() * span;
      const cz = z0 + rnd() * span;
      // Reject the clump centre once, then seed around it - one set of
      // spatial queries buys seven blades instead of one.
      // The clump radius below is 1.15m, so a centre sampled right on the
      // rim of the outermost zone throws blades past the terrain edge -
      // the classic "jitter walks off the last valid cell". Reject the
      // centre with the clump radius as the inset and the blades cannot.
      if (!this._inPlayfield(cx, cz, 1.5)) continue;
      if (this._height(cx, cz) < WATER_Y + 0.35) continue;
      const settle = this._settled(cx, cz);
      // Nothing grows on ground people cross. This is the fix for a
      // village square floored in lawn.
      if (settle > 0.34) continue;
      if (settle > 0.08 && rnd() < settle * 2.4) continue;
      const lush = fbm2(cx * 0.038, cz * 0.038, 2);
      if (lush < -0.16 && rnd() > 0.3) continue;
      const blades = 5 + ((rnd() * 5) | 0);
      for (let b = 0; b < blades; b++) {
        const a = rnd() * TAU;
        const rr = Math.sqrt(rnd()) * 1.15;
        const x = cx + Math.cos(a) * rr;
        const z = cz + Math.sin(a) * rr;
        if (!this._inPlayfield(x, z, 0.4)) continue;
        const y = this._height(x, z);
        if (y < WATER_Y + 0.3) continue;
        if (this._roadDist(x, z) < 1.2) continue;
        if (this._isPaved(x, z, 0.35)) continue;
        // Blades were growing up through floorboards and hearths because
        // nothing here ever asked whether a house was standing on the spot.
        if (this._inFootprint(x, z, 0.5)) continue;
        if (rectDist(x - CASTLE.x, z - CASTLE.z, CASTLE.hx - 4, CASTLE.hz - 4) < 0) continue;
        if (rectDist(x - MARKET.x, z - MARKET.z, MARKET.hx, MARKET.hz) < 0) continue;
        const sc = (0.72 + rnd() * 0.62) * (0.86 + clamp01(lush + 0.4) * 0.34);
        _obj.position.set(x, y - 0.05, z);
        _obj.rotation.set((rnd() - 0.5) * 0.16, rnd() * TAU, (rnd() - 0.5) * 0.16);
        _obj.scale.set(sc, sc * (0.68 + rnd() * 0.74), sc);
        _obj.updateMatrix();
        mat4.push(..._obj.matrix.elements);
        // Desaturated a quarter and dropped in value so the tufts sit in
        // the same band as the graded terrain rather than on top of it.
        _col.setHSL(0.19 + rnd() * 0.07, 0.17 + rnd() * 0.13, 0.27 + rnd() * 0.17);
        colBuf.push(_col.r, _col.g, _col.b);
      }
      clumps++;
    }
    const placed = colBuf.length / 3;
    if (!placed) {
      /* An EMPTY zone is still a RESIDENT zone.
       *
       * Some zones can never place a blade - zone 133 is almost entirely inside
       * the castle bailey's trodden ground - and this used to return without
       * recording anything, so `decide()` re-offered the same key on the next
       * frame, forever. Measured standing perfectly still: 600 build attempts
       * in 600 frames, every one returning null, costing 4.9-5.4 ms a frame at
       * three of this map's vantages.
       *
       * The wasted time was the lesser half. `decide()` sorts nearest-first and
       * truncates to ONE build per frame, so a permanently-empty zone that
       * happens to be nearest wins that slot every frame and no other zone is
       * ever built. Arriving at Ravenshaw, the world settled with one resident
       * grass zone out of about thirty - the hole in the meadow this whole
       * design exists to prevent.
       *
       * `null` rather than a mesh, so `_freeGrassZone` has nothing to dispose
       * and the release path still evicts the key normally. */
      R.resident.set(key, null);
      return null;
    }
    const mesh = new THREE.InstancedMesh(this._grassGeo, this._mats.grass, placed);
    mesh.instanceMatrix.array.set(mat4);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(colBuf), 3);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
    /* The spatial split exists so a zone can leave the frustum on its own;
     * this is the other half of the same idea, and the reason the split has to
     * survive. A zone whose nearest blade is past the height fade is drawing
     * degenerate geometry - see GRASS_HIDE_DISTANCE. */
    this._lod.add(mesh, { hideBeyond: GRASS_HIDE_DISTANCE, measure: SURFACE });
    R.resident.set(key, mesh);
    return mesh;
  }

  /** Free one resident grass zone, GPU buffers and LOD registration included. */
  _freeGrassZone(key) {
    /* `has`, not truthiness: a zone that placed no blades is resident with a
     * null mesh, and testing the value would return early WITHOUT evicting the
     * key - pinning an empty zone in the resident set for the life of the
     * world and burning one of the budget's slots. */
    if (!this._grass.resident.has(key)) return;
    const mesh = this._grass.resident.get(key);
    this._grass.resident.delete(key);
    if (!mesh) return;                      // empty zone: nothing to dispose
    /* Deregister BEFORE disposing. `DistanceLod` recomputes a world-space
     * bounding sphere for every entry every frame; an entry left pointing at a
     * disposed `InstancedMesh` is a leak and a distance test against geometry
     * the GPU no longer holds. */
    this._lod.remove(mesh);
    this.group.remove(mesh);
    // Frees instanceMatrix and instanceColor. The tuft geometry and the grass
    // material are shared across every zone and are owned by `_buildNature`.
    mesh.dispose();
  }

  /**
   * Move the grass frontier with the player. Called once per frame.
   *
   * One build per frame, deliberately. The frontier advances by roughly one
   * zone per second at a sprint, so a single build per frame is two orders of
   * magnitude more headroom than the motion needs, and it means the worst
   * frame this can cause is one zone's placement pass rather than five.
   */
  _tickGrass(x, z) {
    if (!this._grass) return;
    const { build, free } = this._grass.decide(x, z, 1);
    for (let i = 0; i < free.length; i++) this._freeGrassZone(free[i]);
    for (let i = 0; i < build.length; i++) this._buildGrassZone(build[i]);
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

  /** Scale a geometry's UVs - ShapeGeometry and friends come out at 1 unit/tile. */
  static _uvScale(geo, s) {
    const uv = geo.attributes.uv;
    if (!uv) return geo;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * s, uv.getY(i) * s);
    return geo;
  }

  /**
   * A timber-framed house. Every one is different: footprint, storey count,
   * jetty, roof covering, plaster tint, stain, shutter colour and window
   * arrangement all vary, because a village of clones reads as a tech demo.
   *
   * @param {GeoBatch} B
   * @param {{x:number,z:number,ry:number,w:number,d:number,storeys:number,
   *          roof:'thatch'|'slate',jetty:boolean,seed:number,lit?:boolean}} o
   */
  _house(B, o) {
    const rnd = mulberry32(o.seed);
    const w = o.w;
    const d = o.d;
    const hw = w / 2;
    const hd = d / 2;
    const c = Math.cos(o.ry);
    const s = Math.sin(o.ry);

    // Sit the plinth on the lowest corner so nothing floats on a slope.
    let hi = -1e9;
    let lo = 1e9;
    for (const [ox, oz] of [[-hw, -hd], [hw, -hd], [-hw, hd], [hw, hd]]) {
      const wx = o.x + ox * c + oz * s;
      const wz = o.z - ox * s + oz * c;
      const h = this._height(wx, wz);
      if (h > hi) hi = h;
      if (h < lo) lo = h;
    }
    const baseY = hi + 0.02;
    const plinth = Math.max(0.5, baseY - lo + 0.55);

    const M = new THREE.Matrix4().makeRotationY(o.ry).setPosition(o.x, baseY, o.z);
    const tmp = new THREE.Matrix4();
    const put = (key, geo, lx, ly, lz, rx, ry2, rz, tint) => {
      _obj.position.set(lx, ly, lz);
      _obj.rotation.set(rx || 0, ry2 || 0, rz || 0);
      _obj.scale.set(1, 1, 1);
      _obj.updateMatrix();
      tmp.multiplyMatrices(M, _obj.matrix);
      return B.add(key, geo, tmp, tint);
    };

    const daubTint = DAUB_TINTS[(rnd() * DAUB_TINTS.length) | 0];
    const beamTint = BEAM_TINTS[(rnd() * BEAM_TINTS.length) | 0];
    /* Per-member timber variation.
     *
     * Every post, brace and stud in a wall carried the identical tint, so a
     * timber frame rendered as one flat black lattice - no two oak members cut
     * from different trees and weathered for a century match to within 12%.
     * One call site, applied to every framing member. */
    const bt = () => shadeHex(beamTint, 0.86 + rnd() * 0.30);
    const shutTint = SHUTTER_TINTS[(rnd() * SHUTTER_TINTS.length) | 0];
    const gh = 2.75;
    const uh = 2.45;
    const jut = o.jetty && o.storeys > 1 ? 0.42 : 0;

    /* ---- Stone plinth ----------------------------------------------
     *
     * The loudest artifact in round 4, called out independently by all three
     * reviewers as "a pure-white untextured placeholder slab". Three separate
     * things were compounding:
     *
     *  1. the 0xe4dbc8 tint is 0.89 grey, so it passed the rubble albedo
     *     through essentially unattenuated onto the one horizontal-ish band
     *     in the whole facade;
     *  2. the daub panel directly above it carries a grime ramp down to 0.60,
     *     so the plinth sat as a *bright* strip under a darkened wall - the
     *     eye reads local contrast, and that band had the highest local
     *     contrast anywhere in the frame;
     *  3. at w + 0.34 it oversailed the wall by 17cm on every side, which put
     *     a lit top face all the way round the building and turned a footing
     *     course into a plinth *apron*.
     *
     * So: a mid-value dressed-stone tint, an oversail cut to 5cm (a real
     * footing course, not a shelf), and the same grime ramp the wall above it
     * gets - run harder and from the ground up, because a rubble footing is
     * the dirtiest 60cm of any building.
     */
    grimeRamp(
      put('rubble', panelGeo(w + 0.10, plinth, d + 0.10, 0.62, 3),
        0, -plinth / 2 + 0.28, 0, 0, 0, 0, 0x8b8071),
      baseY - plinth + 0.28, plinth + 0.55, 0.44
    );

    /* ---- Storeys: a solid daub core, then framing applied to its faces.
     *
     * Every panel carries a baked soiling ramp: hard in the bottom metre where
     * rain splashes ground off the plinth, clean above it. Round 3's panels
     * were one value corner to corner, which is the single loudest "this is
     * painted, not built" tell a render-plaster wall can have. */
    const storeyRects = [];
    const enter = !!o.enterable;
    const wallT = 0.42;
    const doorHW = 0.78; // doorway half-width
    const doorH2 = 2.25; // doorway clear height
    if (!enter) {
      grimeRamp(
        put('daub', panelGeo(w, gh, d, 0.5, 7), 0, gh / 2 + 0.28, 0, 0, 0, 0, daubTint),
        baseY + 0.28, 2.2, 0.42
      );
    } else {
      /* Hollow ground storey: four wall slabs with a real doorway cut into
       * the +d face so the cottage can be entered. The upper storey (if any)
       * stays a solid mass above the ceiling. */
      const wy = gh / 2 + 0.28;
      grimeRamp(
        put('daub', panelGeo(w, gh, wallT, 0.5, 7), 0, wy, -hd + wallT / 2, 0, 0, 0, daubTint),
        baseY + 0.28, 2.2, 0.42
      );
      for (const sgn of [-1, 1]) {
        grimeRamp(
          put('daub', panelGeo(wallT, gh, d - wallT * 2, 0.5, 7),
            sgn * (hw - wallT / 2), wy, 0, 0, 0, 0, daubTint),
          baseY + 0.28, 2.2, 0.42
        );
      }
      const segW = hw - doorHW;
      for (const sgn of [-1, 1]) {
        grimeRamp(
          put('daub', panelGeo(segW, gh, wallT, 0.5, 7),
            sgn * (doorHW + segW / 2), wy, hd - wallT / 2, 0, 0, 0, daubTint),
          baseY + 0.28, 2.2, 0.42
        );
      }
      // Panel above the door head up to the wall plate.
      put('daub', panelGeo(doorHW * 2, gh - doorH2, wallT, 0.5, 3),
        0, 0.28 + doorH2 + (gh - doorH2) / 2, hd - wallT / 2, 0, 0, 0, daubTint);
    }
    storeyRects.push({ y0: 0.28, h: gh, w, d });
    let top = 0.28 + gh;
    if (o.storeys > 1) {
      const w2 = w + jut * 2;
      const d2 = d + jut * 2;
      // The upper storey is soiled from its own drip line, not the ground.
      grimeRamp(
        put('daub', panelGeo(w2, uh, d2, 0.5, 7), 0, top + uh / 2, 0, 0, 0, 0,
          shadeHex(daubTint, 1.06)),
        baseY + top, 0.95, 0.68
      );
      if (jut > 0) {
        put('beam', boxGeo(w2 + 0.2, 0.34, d2 + 0.2, 0.8), 0, top + 0.17, 0, 0, 0, 0, bt());
        for (let i = -3; i <= 3; i++) {
          put('beam', boxGeo(0.2, 0.2, jut + 0.3, 1.1), (i * w) / 7.5, top - 0.14, hd + jut / 2, 0, 0, 0, bt());
          put('beam', boxGeo(0.2, 0.2, jut + 0.3, 1.1), (i * w) / 7.5, top - 0.14, -hd - jut / 2, 0, 0, 0, bt());
        }
      }
      storeyRects.push({ y0: top, h: uh, w: w2, d: d2 });
      top += uh;
    }

    // Framing on all four faces of every storey.
    for (const r of storeyRects) {
      for (let f = 0; f < 4; f++) {
        const along = f < 2 ? r.w : r.d;
        const out = (f < 2 ? r.d : r.w) / 2 + 0.055;
        const yaw = f === 0 ? 0 : f === 1 ? Math.PI : f === 2 ? Math.PI / 2 : -Math.PI / 2;
        const nx = Math.sin(yaw) * out;
        const nz = Math.cos(yaw) * out;
        const post = 0.24;
        // Corner posts, sill and top plate.
        for (const sgn of [-1, 1]) {
          put('beam', boxGeo(post, r.h, 0.16, 1.0), nx + Math.cos(yaw) * sgn * (along / 2 - post / 2),
            r.y0 + r.h / 2, nz - Math.sin(yaw) * sgn * (along / 2 - post / 2), 0, yaw, 0, bt());
        }
        put('beam', boxGeo(along, 0.28, 0.17, 1.0), nx, r.y0 + 0.14, nz, 0, yaw, 0, bt());
        put('beam', boxGeo(along, 0.3, 0.17, 1.0), nx, r.y0 + r.h - 0.15, nz, 0, yaw, 0, bt());
        // Studs.
        const studs = Math.max(2, Math.round(along / 1.35));
        for (let i = 1; i < studs; i++) {
          const t = (i / studs - 0.5) * along;
          put('beam', boxGeo(0.19, r.h - 0.3, 0.15, 1.0), nx + Math.cos(yaw) * t,
            r.y0 + r.h / 2, nz - Math.sin(yaw) * t, 0, yaw, 0, bt());
        }
        // Corner braces - the detail that makes framing read as real carpentry.
        for (const sgn of [-1, 1]) {
          const bl = Math.min(r.h * 0.95, along * 0.45);
          put('beam', boxGeo(0.19, bl, 0.15, 1.0),
            nx + Math.cos(yaw) * sgn * (along / 2 - bl * 0.32),
            r.y0 + r.h * 0.35,
            nz - Math.sin(yaw) * sgn * (along / 2 - bl * 0.32),
            0, yaw, sgn * 0.62, bt());
        }
      }
    }

    /* ---- Roof ------------------------------------------------------- */
    const isThatch = o.roof === 'thatch';
    const over = isThatch ? 0.72 : 0.45;
    const rw = (o.storeys > 1 ? w + jut * 2 : w) + over * 2;
    const rd = (o.storeys > 1 ? d + jut * 2 : d) + over * 2;
    const rh = rd * (isThatch ? 0.62 : 0.55);
    const slope = Math.atan2(rh, rd / 2);
    const slabLen = Math.hypot(rd / 2, rh) + over * 0.4;
    const thick = isThatch ? 0.55 : 0.16;
    const roofTint = isThatch
      ? THATCH_TINTS[(rnd() * THATCH_TINTS.length) | 0]
      : SLATE_TINTS[(rnd() * SLATE_TINTS.length) | 0];
    for (const sgn of [-1, 1]) {
      put(isThatch ? 'thatch' : 'slate', boxGeo(rw, thick, slabLen, isThatch ? 0.5 : 0.7),
        0, top + rh / 2 - Math.cos(slope) * thick * 0.2, (sgn * (rd / 4)) * 0.98,
        sgn * slope, 0, 0, roofTint);
    }
    if (isThatch) {
      put('thatch', cylGeo(0.42, 0.42, rw, 12, 0.7), 0, top + rh + 0.12, 0, 0, 0, Math.PI / 2, roofTint);
    } else {
      put('slate', boxGeo(rw, 0.24, 0.62, 0.9), 0, top + rh + 0.06, 0, 0, 0, 0, roofTint);
    }
    // Gable ends, framed and infilled.
    for (const sgn of [-1, 1]) {
      const sh = new THREE.Shape();
      sh.moveTo(-rd / 2 + over * 0.7, 0);
      sh.lineTo(rd / 2 - over * 0.7, 0);
      sh.lineTo(0, rh);
      sh.closePath();
      const gg = new THREE.ExtrudeGeometry(sh, { depth: 0.24, bevelEnabled: false });
      MedievalWorld._uvScale(gg, 0.5);
      put('daub', gg, sgn * (rw / 2 - over - 0.12), top, 0, 0, Math.PI / 2 * sgn, 0, daubTint);
      put('beam', boxGeo(0.2, slabLen * 0.98, 0.18, 1.0),
        sgn * (rw / 2 - over), top + rh / 2, rd / 4, slope - Math.PI / 2, 0, 0, bt());
      put('beam', boxGeo(0.2, slabLen * 0.98, 0.18, 1.0),
        sgn * (rw / 2 - over), top + rh / 2, -rd / 4, Math.PI / 2 - slope, 0, 0, bt());
      put('beam', boxGeo(0.22, rh * 0.9, 0.18, 1.0), sgn * (rw / 2 - over), top + rh * 0.45, 0, 0, 0, 0, bt());
    }

    /* ---- Chimney ---------------------------------------------------- */
    const chx = (rnd() < 0.5 ? -1 : 1) * w * 0.34;
    const chTop = top + rh + 1.7;
    put('rubble', boxGeo(1.05, chTop + plinth, 1.05, 0.6), chx, (chTop - plinth) / 2, -hd + 0.4, 0, 0, 0, 0x998d7b);
    put('rubble', boxGeo(1.32, 0.26, 1.32, 0.8), chx, chTop + 0.13, -hd + 0.4, 0, 0, 0, 0x8d8270);
    _v1.set(chx, chTop + 0.5, -hd + 0.4).applyMatrix4(M);
    this._smokeOrigins.push(_v1.x, _v1.y, _v1.z);

    /* ---- Door and windows -------------------------------------------- */
    // The frame sits on the ground-storey wall plane. It used to be pushed
    // out by `jut` on jettied houses, which left the whole door assembly
    // floating 0.4m in front of the wall under the overhang.
    const doorZ = hd + 0.08;
    if (!enter) {
      put('beam', boxGeo(1.45, 2.5, 0.2, 1.0), 0, 1.53, doorZ, 0, 0, 0, bt());
      put('plank', boxGeo(1.05, 2.15, 0.16, 0.9), 0, 1.35, doorZ + 0.1, 0, 0, 0, 0x6d4f30);
      for (let i = 0; i < 2; i++) {
        put('iron', boxGeo(1.05, 0.14, 0.2, 1.6), 0, 0.75 + i * 1.1, doorZ + 0.14, 0, 0, 0, 0x2c2722);
      }
    } else {
      // Open doorway: jamb posts and a lintel around the cut, not a slab.
      for (const sgn of [-1, 1]) {
        put('beam', boxGeo(0.2, doorH2 + 0.15, 0.5, 1.0),
          sgn * (doorHW + 0.1), 0.28 + (doorH2 + 0.15) / 2, hd - 0.2, 0, 0, 0, bt());
      }
      put('beam', boxGeo(doorHW * 2 + 0.4, 0.24, 0.5, 1.0),
        0, 0.28 + doorH2 + 0.12, hd - 0.2, 0, 0, 0, bt());
    }
    /* The threshold, and however much of the hill has to be built up to reach
     * it. See `_entrySteps`: this used to be a hand-rolled flight inside the
     * `enterable` branch alone, capped at six courses and not flared, so a
     * cottage on a slope was reachable head-on and a cheek from anywhere else
     * - and a solid one got a 22 cm stone and nothing. */
    this._entrySteps(B, { M, yaw: o.ry, hd, baseY, sill: 0.22, doorW: doorHW * 2 });
    put('beam', boxGeo(1.9, 0.22, 0.9, 1.0), 0, 2.9, doorZ + 0.3, 0, 0, 0, bt());

    const glow = o.lit ? 0xffd9a0 : 0x6f6250;
    const winRows = o.storeys > 1 ? [1.65, 0.28 + gh + 1.3] : [1.55];
    for (let ri = 0; ri < winRows.length; ri++) {
      const wy = winRows[ri];
      const outer = ri === 0 ? hd + 0.08 : hd + jut + 0.08;
      const side = ri === 0 ? hw + 0.08 : hw + jut + 0.08;
      const cols = w > 7 ? [-w * 0.3, w * 0.3] : [w * 0.3];
      for (const cx of cols) {
        for (const sgn of [1, -1]) {
          const wz = sgn * outer;
          put('beam', boxGeo(1.25, 1.15, 0.2, 1.2), cx, wy, wz, 0, 0, 0, bt());
          /* Recessed reveal.
           *
           * The pane used to sit 12cm *proud* of its own frame, so at any
           * distance the whole opening was a flat emissive rectangle stuck on
           * the outside of the wall - a decal, exactly as reported. A real
           * window is a hole: the glazing sits back behind the wall face, the
           * jamb throws a shadow across one side of it, and a mullion breaks
           * the pane. Setting the glass 8cm back and framing the mouth with
           * four thin reveals gives all three for eight boxes a window, and it
           * is what stops the practicals reading as stickers.
           */
          put('glass', planeGeo(0.92, 0.8, 1.2), cx, wy, wz - sgn * 0.08,
            0, sgn > 0 ? 0 : Math.PI, 0, glow);
          for (const rs of [-1, 1]) {
            put('beam', boxGeo(0.17, 1.15, 0.22, 1.4), cx + rs * 0.54, wy, wz + sgn * 0.05,
              0, 0, 0, shadeHex(beamTint, 0.7));
            put('beam', boxGeo(1.25, 0.16, 0.22, 1.4), cx, wy + rs * 0.5, wz + sgn * 0.05,
              0, 0, 0, shadeHex(beamTint, rs > 0 ? 0.62 : 0.78));
          }
          // Mullion and transom, sitting in front of the recessed glazing so
          // they read as a dark cross against the interior light.
          put('beam', boxGeo(0.075, 0.86, 0.09, 2.0), cx, wy, wz + sgn * 0.01,
            0, 0, 0, shadeHex(beamTint, 0.66));
          put('beam', boxGeo(0.96, 0.065, 0.09, 2.0), cx, wy - 0.06, wz + sgn * 0.01,
            0, 0, 0, shadeHex(beamTint, 0.66));
          // A warm halo bled onto the daub around the opening. Without it the
          // pane is a bright orange rectangle on a wall that is darker than
          // the sky-lit wall three metres away - a decal, not a window.
          if (o.lit) {
            _v1.set(cx, wy, wz + sgn * 0.22).applyMatrix4(M);
            this._addGlow(_v1.x, _v1.y, _v1.z, 2.5, 0x54301a,
              o.ry + (sgn > 0 ? 0 : Math.PI));
          }
          // Shutters thrown open against the wall.
          for (const ss of [-1, 1]) {
            put('plank', boxGeo(0.62, 1.0, 0.09, 1.3), cx + ss * 0.92, wy, wz + sgn * 0.2,
              0, sgn * ss * -0.42, 0, shutTint);
          }
        }
      }
      // One window on a gable end for asymmetry.
      if (ri === winRows.length - 1) {
        const sgn = rnd() < 0.5 ? -1 : 1;
        put('beam', boxGeo(0.2, 1.05, 1.15, 1.2), sgn * side, wy, 0, 0, 0, 0, bt());
        put('glass', planeGeo(0.86, 0.78, 1.2), sgn * side + sgn * 0.12, wy, 0,
          0, sgn * Math.PI / 2, 0, glow);
      }
    }

    if (o.lit) {
      // Every lit dwelling gets a pooled bounce card on its threshold - that
      // costs nothing and is what the street frames were missing. Only every
      // other one gets a real PointLight: forward rendering evaluates the
      // whole light list per fragment, and fourteen cottage lamps plus the
      // castle practicals is not a budget, it is a tax.
      if (o.light) {
        // 22/13 with inverse-square decay contributed nothing past four metres
        // at this exposure. 62/20 puts a readable pool of key on the cobbles.
        const l = pointLight(0xffa63c, 62, 20, 2);
        l.position.set(o.x, baseY + 1.9, o.z);
        this.group.add(l);
      }
      _v1.set(0, 0.09, doorZ + 0.9).applyMatrix4(M);
      this._addGlow(_v1.x, _v1.y, _v1.z, 4.6, 0x4a2a12);
    }

    if (!enter) {
      // One rotated box holds the whole mass; roofs are above head height.
      const collideY = baseY + (0.28 + gh + (o.storeys > 1 ? uh : 0)) / 2;
      this._rbox(o.x, collideY, o.z, (w + jut * 2) / 2 + 0.1,
        (0.28 + gh + (o.storeys > 1 ? uh : 0)) / 2 + plinth / 2, (d + jut * 2) / 2 + 0.1, o.ry);
    } else {
      /* ---- Enterable: per-wall colliders, interior, swinging door ---- */
      /** What lights this cottage's room, for the enterable descriptor. */
      const houseLights = [];
      const wallsTop = 0.28 + gh;
      const rcol = (lx, cy, lz, hx, hy, hz) => {
        _v1.set(lx, cy, lz).applyMatrix4(M);
        return this._rbox(_v1.x, _v1.y, _v1.z, hx, hy, hz, o.ry);
      };
      const hyW = (wallsTop + plinth) / 2;
      const cyW = (wallsTop - plinth) / 2;
      rcol(0, cyW, -hd + wallT / 2, hw + 0.06, hyW, wallT / 2 + 0.05);
      for (const sgn of [-1, 1]) {
        rcol(sgn * (hw - wallT / 2), cyW, 0, wallT / 2 + 0.05, hyW, hd + 0.06);
      }
      const segW = hw - doorHW;
      for (const sgn of [-1, 1]) {
        rcol(sgn * (doorHW + segW / 2), cyW, hd - wallT / 2, segW / 2 + 0.04, hyW, wallT / 2 + 0.05);
      }
      rcol(0, 0.28 + doorH2 + (gh - doorH2) / 2, hd - wallT / 2,
        doorHW + 0.05, (gh - doorH2) / 2 + 0.02, wallT / 2 + 0.05);
      // Interior plank floor over the plinth core, and the ceiling.
      put('plank', boxGeo(w - 0.2, 0.16, d - 0.2, 0.7), 0, 0.3, 0, 0, 0, 0, 0x97754c);
      rcol(0, 0.05, 0, hw - 0.08, 0.33, hd - 0.08);
      put('plank', boxGeo(w - 0.1, 0.14, d - 0.1, 0.7), 0, wallsTop - 0.07, 0, 0, 0, 0, 0x8a6b45);
      rcol(0, wallsTop - 0.07, 0, hw, 0.1, hd);
      // Ceiling joists so the soffit reads as carpentry, not a slab.
      for (let i = -2; i <= 2; i++) {
        put('beam', boxGeo(0.18, 0.2, d - 0.5, 1.0), (i * w) / 6, wallsTop - 0.22, 0, 0, 0, 0, bt());
      }
      if (o.storeys > 1) {
        rcol(0, wallsTop + uh / 2, 0, (w + jut * 2) / 2 + 0.1, uh / 2, (d + jut * 2) / 2 + 0.1);
      }
      /* Furnishing: table + stools by the window wall, a bed along the
       * other, a hearth on the chimney breast. All batched. */
      const fs = 0.38; // floor surface (local)
      const tX = -w * 0.22;
      const tZ = -d * 0.12;
      put('plank', boxGeo(1.6, 0.09, 0.95, 1.0), tX, fs + 0.74, tZ, 0, 0.12, 0, 0x9a7a50);
      for (const sx of [-1, 1]) {
        put('beam', boxGeo(0.14, 0.72, 0.85, 1.2), tX + sx * 0.62, fs + 0.36, tZ, 0, 0.12, 0, bt());
      }
      rcol(tX, fs + 0.4, tZ, 0.85, 0.42, 0.55);
      for (const [sx2, sz2] of [[0.95, 0.25], [-0.4, 0.85]]) {
        put('plank', cylGeo(0.24, 0.2, 0.5, 8, 1.0), tX + sx2, fs + 0.25, tZ + sz2, 0, 0, 0, 0x8f6f47);
      }
      const bX = w * 0.28;
      const bZ = -d * 0.16;
      put('beam', boxGeo(1.0, 0.42, 2.0, 1.0), bX, fs + 0.21, bZ, 0, 0, 0, bt());
      put('canopy', boxGeo(0.92, 0.18, 1.9, 2.0), bX, fs + 0.5, bZ, 0, 0, 0, 0xcfc2a4);
      put('canopy', boxGeo(0.86, 0.14, 0.5, 2.0), bX, fs + 0.62, bZ - 0.68, 0, 0, 0, 0xddd2b8);
      rcol(bX, fs + 0.35, bZ, 0.52, 0.35, 1.02);
      // Hearth proud of the chimney breast (the shaft protrudes ~0.5m into
      // the room at z = -hd + 0.4; its inner face sits near -hd + 0.93).
      rcol(chx, cyW, -hd + 0.45, 0.6, hyW, 0.55);
      put('rubble', boxGeo(1.5, 1.3, 0.3, 0.7), chx, fs + 0.65, -hd + 1.02, 0, 0, 0, 0x8d8270);
      put('ember', boxGeo(0.66, 0.3, 0.24, 2.0), chx, fs + 0.2, -hd + 1.06, 0, 0, 0, 0xffb060);
      _v1.set(chx, fs + 0.3, -hd + 1.5).applyMatrix4(M);
      this._addGlow(_v1.x, _v1.y, _v1.z, 3.4, 0x5a3416);
      /* Hearth light. Distinct from the street practical below, which only
       * every other LIT cottage gets and which exists to pool key on the
       * cobbles: this one is for the room, and every cottage you can walk into
       * has one whether or not its windows are lit from outside. Before it, a
       * player who opened a cottage door found a modelled table, bed and hearth
       * in a black box. See `_interiorLight`. */
      houseLights.push(this._interiorLight(
        new THREE.Vector3(0, fs + Math.min(2.0, gh - 0.8), -d * 0.12).applyMatrix4(M), w, d));
      /* Swinging door leaf on a hinge pivot at the left jamb. */
      const leafW = doorHW * 2 - 0.06;
      const leafGeo = boxGeo(leafW, doorH2 - 0.12, 0.09, 0.9);
      leafGeo.translate(leafW / 2, 0, 0);
      normaliseGeo(leafGeo, 0x6d4f30);
      const leaf = new THREE.Mesh(leafGeo, this._mats.plank);
      leaf.castShadow = leaf.receiveShadow = true;
      const bandGeo = boxGeo(leafW * 0.9, 0.12, 0.05, 1.6);
      bandGeo.translate(leafW / 2, 0, 0.06);
      normaliseGeo(bandGeo, 0x2c2722);
      const pivot = new THREE.Group();
      _v1.set(-doorHW + 0.02, 0.28 + (doorH2 - 0.12) / 2 + 0.04, hd - wallT / 2).applyMatrix4(M);
      pivot.position.copy(_v1);
      pivot.rotation.y = o.ry;
      pivot.add(leaf);
      for (const by of [-0.55, 0.55]) {
        const band = new THREE.Mesh(bandGeo, this._mats.iron);
        band.position.y = by;
        pivot.add(band);
      }
      this.group.add(pivot);
      _v1.set(0, 0.28 + doorH2 / 2, hd - wallT / 2).applyMatrix4(M);
      const doorCol = this._rbox(_v1.x, _v1.y, _v1.z, doorHW, doorH2 / 2, 0.12, o.ry);
      const dpos = new THREE.Vector3(0, 1.2, hd).applyMatrix4(M);
      const cpos = new THREE.Vector3(w * 0.22, fs + 0.7, d * 0.22).applyMatrix4(M);
      if (!Array.isArray(this.enterables)) this.enterables = [];
      this.enterables.push({
        label: `cottage@${o.x | 0},${o.z | 0}`,
        origin: new THREE.Vector3(o.x, baseY, o.z),
        doors: [{
          id: `cottage_${this.enterables.length}`,
          leaves: [{ pivot, closed: o.ry, open: o.ry + Math.PI * 0.58 }],
          collider: doorCol,
          position: dpos,
          open: false,
          anim: 0,
        }],
        collectibleSpots: [{ position: cpos, tier: 'common' }],
        lights: houseLights,
      });
    }
    this._footprints.push({ x: o.x, z: o.z, hx: w / 2 + 1.4, hz: d / 2 + 1.4, r: o.ry });
    return { baseY, top: baseY + top, roofTop: baseY + top + rh };
  }
  /* ---------------------------------------------------------------- */
  /* The village                                                       */
  /* ---------------------------------------------------------------- */

  _buildVillage() {
    const B = new GeoBatch();
    if (!Array.isArray(this.enterables)) this.enterables = [];
    // Auto interior rollout is disabled (it stacked shells on the solid
    // houses); enterables are authored explicitly (cottages, the tavern and
    // the parish churches below).
    this._interiorCandidates = [];
    // Hand-placed so the houses address the streets rather than scatter.
    PLOTS.forEach(([x, z, ry, w, d, st, roof, lit], i) => {
      this._house(B, {
        x, z, ry, w, d,
        storeys: st,
        roof: roof === 't' ? 'thatch' : 'slate',
        jetty: st > 1 && i % 3 !== 0,
        lit: !!lit,
        light: !!lit && i % 2 === 0,
        // ~70% of the village can be walked into; the rest stay closed so
        // the collider budget and interior dressing stay bounded.
        enterable: i % 10 < 7,
        seed: 0x4000 + i * 7919,
      });
    });

    // The tavern: bigger, jettied, with a painted sign and lanterns.
    const tav = this._house(B, {
      x: 46, z: 32, ry: -0.42, w: 13, d: 8.5, storeys: 2,
      roof: 'slate', jetty: true, lit: true, light: false, seed: 0x7a17e,
      enterable: true,
    });
    const tc = Math.cos(-0.42);
    const ts = Math.sin(-0.42);
    const tvx = 46 + 5.6 * tc;
    const tvz = 32 - 5.6 * ts;
    _obj.position.set(tvx, tav.baseY + 3.4, tvz + 4.6);
    _obj.rotation.set(0, -0.42, 0);
    _obj.scale.set(1, 1, 1);
    B.add('beam', boxGeo(2.4, 0.18, 0.18, 1.2), _obj, 0x5c4830);
    _obj.position.set(tvx + 1.0, tav.baseY + 2.5, tvz + 4.6);
    B.add('plank', boxGeo(1.5, 1.1, 0.1, 1.2), _obj, 0xc9a15a);
    for (const s of [-1, 1]) {
      _obj.position.set(tvx + 1.0 + s * 0.6, tav.baseY + 3.1, tvz + 4.6);
      B.add('iron', cylGeo(0.03, 0.03, 0.7, 4, 2), _obj, 0x2c2722);
    }
    for (const s of [-1, 1]) {
      _obj.position.set(46 + s * 5.5 * tc + 4.4 * ts, tav.baseY + 2.5, 32 - s * 5.5 * ts + 4.4 * tc);
      B.add('iron', boxGeo(0.24, 0.34, 0.24, 1.6), _obj, 0x2f2924);
      B.add('ember', boxGeo(0.14, 0.2, 0.14, 2.0), _obj, 0xffc074);
    }
    const tavLight = pointLight(0xffa64a, 78, 22, 2);
    this._buildParishChurch({
      x: -146, z: -30, halfW: 5.2, halfD: 8.6, label: 'West Parish Church',
    });
    this._buildParishChurch({
      x: -60, z: -136, halfW: 5.0, halfD: 8.2, label: 'South Parish Church',
    });

    // Benches and barrels outside the tavern door.
    const rnd = mulberry32(0xbee5);
    for (let i = 0; i < 6; i++) {
      const bx = 40 + rnd() * 12;
      const bz = 38 + rnd() * 5;
      const y = this._height(bx, bz);
      _obj.position.set(bx, y + 0.5, bz);
      _obj.rotation.set(0, rnd() * TAU, 0);
      _obj.scale.set(1, 1, 1);
      B.add('plank', cylGeo(0.42, 0.36, 1.0, 12, 1.0), _obj, 0x8f6f47);
      _obj.position.set(bx, y + 0.86, bz);
      B.add('iron', cylGeo(0.45, 0.45, 0.1, 12, 1.4), _obj, 0x35302a);
      this._box(bx, y + 0.5, bz, 0.45, 0.5, 0.45);
      // Every prop that stands on the ground needs its disc or it hovers.
      this._contacts.push(bx, y, bz, 0.62);
    }

    /* ---- Garden plots, fences, woodpiles ---------------------------- */
    const fence = (x1, z1, x2, z2) => {
      const dx = x2 - x1;
      const dz = z2 - z1;
      const len = Math.hypot(dx, dz);
      const n = Math.max(2, Math.round(len / 1.9));
      const yaw = MedievalWorld._yaw(dx / len, dz / len);
      for (let i = 0; i <= n; i++) {
        const px = x1 + (dx * i) / n;
        const pz = z1 + (dz * i) / n;
        _obj.position.set(px, this._height(px, pz) + 0.55, pz);
        _obj.rotation.set(0, yaw + 0.1, 0);
        _obj.scale.set(1, 1, 1);
        B.add('beam', boxGeo(0.14, 1.3, 0.14, 1.4), _obj, 0x7a6144);
      }
      for (const yy of [0.5, 1.0]) {
        const mx = (x1 + x2) / 2;
        const mz = (z1 + z2) / 2;
        _obj.position.set(mx, this._height(mx, mz) + yy, mz);
        _obj.rotation.set(0, yaw, 0);
        B.add('beam', boxGeo(len, 0.1, 0.06, 1.2), _obj, 0x86694a);
      }
    };
    const gardens = [
      [26, 46, 34, 52], [34, 52, 32, 58], [64, 44, 72, 48],
      [-24, 30, -16, 36], [96, 12, 104, 18], [22, -12, 30, -8],
    ];
    for (const [a, b, c2, d2] of gardens) {
      fence(a, b, c2, d2);
      fence(c2, d2, c2 + 1, d2 + 7);
      for (let i = 0; i < 26; i++) {
        const gx = a + rnd() * (c2 - a + 2);
        const gz = b + rnd() * (d2 - b + 7);
        _obj.position.set(gx, this._height(gx, gz) + 0.24, gz);
        _obj.rotation.set(0, rnd() * TAU, 0);
        _obj.scale.set(1, 1, 1);
        B.add('leaf', boxGeo(0.5, 0.45, 0.5, 5.0), _obj, 0x8fae66);
      }
    }
    for (let i = 0; i < 7; i++) {
      const px = 12 + rnd() * 80;
      const pz = 0 + rnd() * 60;
      if (!this._isOpenGround(px, pz, 1)) continue;
      const y = this._height(px, pz);
      for (let k = 0; k < 16; k++) {
        _obj.position.set(px + (k % 4) * 0.28, y + 0.14 + ((k / 4) | 0) * 0.26, pz);
        _obj.rotation.set(0, 0, Math.PI / 2);
        _obj.scale.set(1, 1, 1);
        B.add('beam', cylGeo(0.12, 0.13, 1.6, 7, 1.2), _obj, 0x8a6c4a);
      }
    }

    this._approachDressing(B, rnd);
    this._streetDressing(B, rnd);

    B.build(this._mats, this.group, { ao: this._heightFn });
    this._buildGroundSkirts();
    if (tavLight) {
      tavLight.position.set(46, tav.baseY + 3.0, 36);
      this.group.add(tavLight);
      this._addGlow(46, this._height(46, 37) + 0.1, 37, 9.5, 0x4e2d15);
    }
  }

  _buildParishChurch(spec) {
    const x = spec.x;
    const z = spec.z;
    const halfW = spec.halfW ?? 5.0;
    const halfD = spec.halfD ?? 8.0;
    const baseY = this._height(x, z) + 0.06;
    const kit = new InteriorKit(this, {
      name: `interior:church@${x},${z}`,
      // Swap the kit's flat palette for the village's baked textured
      // materials on every large surface so the church matches the houses
      // instead of reading as an untextured placeholder.
      matOverrides: {
        stone: this._mats.ashlar,
        slate: this._mats.slate,
        plank: this._mats.plank,
        beam: this._mats.beam,
        iron: this._mats.iron,
      },
    });
    kit.buildChurch({ x, z, baseY, halfW, halfD });
    kit.finish();
    const d = kit.exportDescriptors();
    d.origin = new THREE.Vector3(x, baseY, z);
    d.label = spec.label || 'Parish Church';
    /* The two parish churches came through `InteriorKit`, which builds a nave
     * and no light to see it by - the same defect as the towns, reached by a
     * different route. Two lamps down the nave, because one at the crossing of
     * a 16 m church leaves the altar and the door both dark. */
    d.lights = [-1, 1].map((s) => this._interiorLight(
      new THREE.Vector3(x, baseY + 2.3, z + s * halfD * 0.42), halfW * 2, halfD));
    this.enterables.push(d);
    this._footprints.push({ x, z, hx: halfW + 1.4, hz: halfD + 1.8, r: 0 });
    this.minimapShapes.push({
      kind: 'rect',
      x,
      z,
      w: halfW * 2 + 1.2,
      d: halfD * 2 + 1.2,
      rotation: 0,
      fill: 'rgba(132,104,78,0.45)',
      stroke: 'rgba(226,198,152,0.9)',
    });
  }


  /* ================================================================== */
  /* The outer ring: a second building vocabulary                        */
  /* ================================================================== */

  /**
   * Build one shell from a `Towns.js` descriptor.
   *
   * This is the ring's answer to `_house`, and it is a separate method rather
   * than an option on that one for a reason worth stating: `_house` is not
   * parameterised, it is AUTHORED. Every number in it - the 0.28 sill, the
   * 2.75 storey, the jetty at 0.42, the grime ramp at 0.42 - was tuned against
   * Aldermoor's composed street frames, and threading five vernaculars through
   * it would have meant changing those numbers to accept an argument. The
   * village would then have been at the mercy of every edit made for a town
   * four hundred metres away, and the failure would have been invisible: a
   * cottage two centimetres taller does not throw.
   *
   * So: two builders, one authored and untouched, one parameterised. The
   * shared parts are the geometry helpers, which is the right amount of
   * sharing.
   *
   * Everything about the interior comes from `interiorPlan`, which is pure and
   * tested - so "the stairs reach the floor above" and "you can stand up in
   * here" are properties of a function rather than of this method.
   *
   * @param {GeoBatch} B
   * @param {object} o a building from `TOWNS`, plus `seed`
   * @returns {{baseY:number, top:number, roofTop:number}}
   */
  _shell(B, o) {
    const rnd = mulberry32(o.seed);
    const plan = interiorPlan(o);
    const w = o.w;
    const d = o.d;
    const hw = w / 2;
    const hd = d / 2;
    const wt = plan.wallT;
    const enter = !!o.enterable;

    /* Ground. A stilt building's base is its DECK, which is authored: the
     * terrain under it is a river bed and "sit on the highest corner" would
     * put a fishing hut on the bottom of the pool. */
    const gu = groundUnder(o, (x, z) => this._height(x, z));
    const baseY = o.stilt ? o.deck : gu.baseY;
    const plinth = o.stilt ? 0 : Math.max(0.42, gu.relief + 0.55);

    const M = new THREE.Matrix4().makeRotationY(o.yaw).setPosition(o.x, baseY, o.z);
    const tmp = new THREE.Matrix4();
    const put = (key, geo, lx, ly, lz, rx, ry, rz, tint) => {
      _obj.position.set(lx, ly, lz);
      _obj.rotation.set(rx || 0, ry || 0, rz || 0);
      _obj.scale.set(1, 1, 1);
      _obj.updateMatrix();
      tmp.multiplyMatrices(M, _obj.matrix);
      return B.add(key, geo, tmp, tint);
    };
    /** A collider in the building's own frame. */
    const rcol = (lx, cy, lz, chx, chy, chz) => {
      _v1.set(lx, cy, lz).applyMatrix4(M);
      return this._rbox(_v1.x, _v1.y, _v1.z, chx, chy, chz, o.yaw);
    };
    /** A point in the building's own frame, in world space. */
    const at = (lx, ly, lz) => new THREE.Vector3(lx, ly, lz).applyMatrix4(M);

    const wallTints = SHELL_WALL_TINTS[o.wall] || SHELL_WALL_TINTS.daub;
    const wallTint = o.tint ?? wallTints[(rnd() * wallTints.length) | 0];
    const roofKey = o.roof === 'shingle' ? 'plank' : (o.roof === 'flat' ? 'slate' : o.roof);
    const roofTints = SHELL_ROOF_TINTS[o.roof] || SHELL_ROOF_TINTS.slate;
    const roofTint = roofTints[(rnd() * roofTints.length) | 0];
    const beamTint = BEAM_TINTS[(rnd() * BEAM_TINTS.length) | 0];
    const bt = () => shadeHex(beamTint, 0.86 + rnd() * 0.30);
    const wallKey = o.wall;
    const top = plan.roofY;
    const jut = o.jetty && o.storeys > 1 ? 0.44 : 0;

    /* ---- Foundation ------------------------------------------------- */
    if (o.stilt) {
      /* Posts down to the bed, cross-braced, plus the deck they carry. Two
       * rings of them: the outer ring is what you see from a boat, the inner
       * pair is what stops the hut reading as a table with four legs. */
      const bedY = this._height(o.x, o.z);
      for (const [px, pz] of [
        [-hw + 0.5, -hd + 0.5], [hw - 0.5, -hd + 0.5],
        [-hw + 0.5, hd - 0.5], [hw - 0.5, hd - 0.5],
        [0, -hd + 0.5], [0, hd - 0.5],
      ]) {
        const bh = baseY - bedY + 0.9;
        put('beam', cylGeo(0.20, 0.26, bh, 7, 0.9), px, -bh / 2 + 0.1, pz, 0, 0, 0, 0x6a5741);
        rcol(px, -bh / 2 + 0.1, pz, 0.26, bh / 2, 0.26);
        // Weed and wrack at the waterline.
        put('leaf', boxGeo(0.5, 0.34, 0.5, 3.0), px, WATER_Y - baseY + 0.1, pz, 0, rnd() * TAU, 0, 0x5d6b46);
      }
      for (const s of [-1, 1]) {
        put('beam', boxGeo(w - 0.6, 0.16, 0.16, 1.1), 0, -0.9, s * (hd - 0.5), 0, 0, 0, 0x6a5741);
      }
      // Deck, a little proud of the walls all round so there is somewhere to
      // stand and land a boat.
      put('plank', boxGeo(w + 1.6, 0.22, d + 1.6, 0.65), 0, -0.11, 0, 0, 0, 0, 0x9d7f56);
      rcol(0, -0.24, 0, hw + 0.8, 0.16, hd + 0.8);
    } else {
      /* A battered footing, not a slab. See `plinthCourses`: on level ground
       * this is the one course it always was, and under the shells that stand
       * on 2 m of relief it is three, each stepping out below the last. */
      for (const cs of plinthCourses(plinth)) {
        const ch = cs.y1 - cs.y0;
        grimeRamp(
          put('rubble', panelGeo(w + cs.out * 2, ch, d + cs.out * 2, 0.6, 2),
            0, -cs.y0 - ch / 2 + 0.06, 0, 0, 0, 0, shadeHex(0x84796b, 1 - cs.out * 0.28)),
          baseY - cs.y1 + 0.06, ch + 0.6, 0.46
        );
      }
    }

    /* ---- Walls ------------------------------------------------------ *
     * Hollow for the full height when the building is enterable, not just on
     * the ground storey: a two-storey shell with a solid mass above the
     * ceiling has an upper floor you can reach and nothing above it, which is
     * the one way a working staircase can still be a defect. */
    const doorHW = DOOR_W / 2;
    const doorH = DOOR_H;
    const storeyRects = [];
    for (const fl of plan.floors) {
      const s = fl.storey;
      const y0 = fl.floorY - (s === 0 ? plan.door.y : 0);
      const h = fl.ceilY + (s < plan.floors.length - 1 ? FLOOR_T : 0) - y0;
      const sw = w + (s > 0 ? jut * 2 : 0);
      const sd = d + (s > 0 ? jut * 2 : 0);
      const shw = sw / 2;
      const shd = sd / 2;
      const tint = s === 0 ? wallTint : shadeHex(wallTint, 1.05);
      storeyRects.push({ y0, h, w: sw, d: sd });
      if (!enter) {
        grimeRamp(put(wallKey, panelGeo(sw, h, sd, 0.5, 6), 0, y0 + h / 2, 0, 0, 0, 0, tint),
          baseY + y0, s === 0 ? 2.0 : 0.9, s === 0 ? 0.46 : 0.7);
        continue;
      }
      // Back wall, two side walls, and the front wall split around the door.
      grimeRamp(put(wallKey, panelGeo(sw, h, wt, 0.5, 6), 0, y0 + h / 2, -shd + wt / 2, 0, 0, 0, tint),
        baseY + y0, s === 0 ? 2.0 : 0.9, s === 0 ? 0.46 : 0.7);
      for (const sgn of [-1, 1]) {
        grimeRamp(put(wallKey, panelGeo(wt, h, sd - wt * 2, 0.5, 6),
          sgn * (shw - wt / 2), y0 + h / 2, 0, 0, 0, 0, tint),
        baseY + y0, s === 0 ? 2.0 : 0.9, s === 0 ? 0.46 : 0.7);
      }
      if (s === 0) {
        const segW = shw - doorHW;
        for (const sgn of [-1, 1]) {
          grimeRamp(put(wallKey, panelGeo(segW, h, wt, 0.5, 6),
            sgn * (doorHW + segW / 2), y0 + h / 2, shd - wt / 2, 0, 0, 0, tint),
          baseY + y0, 2.0, 0.46);
        }
        const overH = h - (doorH + plan.door.y - y0);
        if (overH > 0.05) {
          put(wallKey, panelGeo(doorHW * 2, overH, wt, 0.5, 3),
            0, y0 + (doorH + plan.door.y - y0) + overH / 2, shd - wt / 2, 0, 0, 0, tint);
        }
      } else {
        grimeRamp(put(wallKey, panelGeo(sw, h, wt, 0.5, 6), 0, y0 + h / 2, shd - wt / 2, 0, 0, 0, tint),
          baseY + y0, 0.9, 0.7);
      }
    }

    /* ---- What the walls are dressed with ---------------------------- *
     * This is the whole reason five towns look like five towns. */
    for (const r of storeyRects) {
      const rhw = r.w / 2;
      const rhd = r.d / 2;
      if (o.wall === 'daub') {
        // Timber frame, applied to the faces. Fenwick's vocabulary.
        for (let f = 0; f < 4; f++) {
          const along = f < 2 ? r.w : r.d;
          const out = (f < 2 ? r.d : r.w) / 2 + 0.06;
          const yaw = f === 0 ? 0 : f === 1 ? Math.PI : f === 2 ? Math.PI / 2 : -Math.PI / 2;
          const nx = Math.sin(yaw) * out;
          const nz = Math.cos(yaw) * out;
          for (const sgn of [-1, 1]) {
            put('beam', boxGeo(0.24, r.h, 0.16, 1.0), nx + Math.cos(yaw) * sgn * (along / 2 - 0.12),
              r.y0 + r.h / 2, nz - Math.sin(yaw) * sgn * (along / 2 - 0.12), 0, yaw, 0, bt());
          }
          put('beam', boxGeo(along, 0.26, 0.17, 1.0), nx, r.y0 + 0.13, nz, 0, yaw, 0, bt());
          put('beam', boxGeo(along, 0.30, 0.17, 1.0), nx, r.y0 + r.h - 0.15, nz, 0, yaw, 0, bt());
          const studs = Math.max(2, Math.round(along / 1.3));
          for (let i = 1; i < studs; i++) {
            const t = (i / studs - 0.5) * along;
            put('beam', boxGeo(0.18, r.h - 0.3, 0.15, 1.0), nx + Math.cos(yaw) * t,
              r.y0 + r.h / 2, nz - Math.sin(yaw) * t, 0, yaw, 0, bt());
          }
          for (const sgn of [-1, 1]) {
            const bl = Math.min(r.h * 0.9, along * 0.42);
            put('beam', boxGeo(0.18, bl, 0.15, 1.0),
              nx + Math.cos(yaw) * sgn * (along / 2 - bl * 0.32), r.y0 + r.h * 0.36,
              nz - Math.sin(yaw) * sgn * (along / 2 - bl * 0.32), 0, yaw, sgn * 0.62, bt());
          }
        }
      } else if (o.wall === 'plank') {
        /* Horizontal boarding with a corner post at each angle. Six courses,
         * each pushed out a couple of centimetres, so the low sun rakes a
         * shadow line under every one - which is what makes a boarded wall
         * read as boards at fifty metres rather than as a brown panel.
         *
         * ── Why an enterable one is a RING ─────────────────────────────
         * Each course used to be one SOLID box the size of the whole
         * building, which is invisible on a shed and catastrophic in a hall:
         * six slabs of dark boarding stacked through the room from floor to
         * wall head, filling it. Raycast straight up from the middle of The
         * Marcher Hall's ground floor and the first thing over your head was
         * plank at 1.66 m - not the ceiling at 2.85, a board 43 cm above the
         * eye - with two more above it. Every plank interior in the world was
         * a 1.6 m crawlspace with its real ceiling walled off behind three
         * slabs of the darkest material in the palette, and that is what made
         * The Stilthouse and The Marcher Hall measure 23.4 and 28.0 mean frame
         * luma against 46.8 and 46.7 in the two stone landmarks. They were
         * never short of light; they were full of boarding.
         *
         * They have no colliders, which is exactly why nothing caught it:
         * `medieval-towns.test.mjs` probes headroom with the physics boxes and
         * found 2.85 m of clear height, correctly, above a room you could not
         * see across.
         *
         * So an enterable shell gets four boards per course instead of one
         * box. `T` is the wall's own thickness, so each board's inner face
         * lands `push` INSIDE the wall panel it dresses - buried, never
         * coplanar with anything, and identical from outside. */
        const courses = Math.max(3, Math.round(r.h / 0.52));
        const T = wt;
        for (let i = 0; i < courses; i++) {
          const cy = r.y0 + (i + 0.5) * (r.h / courses);
          const push = 0.035 + (i % 2) * 0.022;
          const ch = r.h / courses - 0.04;
          const k = shadeHex(wallTint, 0.9 + (i % 3) * 0.08);
          if (!enter) {
            put('plank', boxGeo(r.w + push * 2, ch, r.d + push * 2, 0.7), 0, cy, 0, 0, 0, 0, k);
            continue;
          }
          for (const sgn of [-1, 1]) {
            put('plank', boxGeo(r.w + push * 2, ch, T, 0.7),
              0, cy, sgn * (rhd + push - T / 2), 0, 0, 0, k);
            put('plank', boxGeo(T, ch, r.d + push * 2 - T * 2, 0.7),
              sgn * (rhw + push - T / 2), cy, 0, 0, 0, 0, k);
          }
        }
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 1]) {
            put('beam', boxGeo(0.26, r.h, 0.26, 1.0), sx * rhw, r.y0 + r.h / 2, sz * rhd, 0, 0, 0, bt());
          }
        }
      } else if (o.wall === 'ashlar') {
        // Buttresses and a string course. The abbey's vocabulary.
        const n = Math.max(2, Math.round(r.w / 6.5));
        for (let i = 0; i <= n; i++) {
          const t = (i / n - 0.5) * (r.w - 1.2);
          for (const sgn of [-1, 1]) {
            put('ashlar', boxGeo(1.1, r.h * 0.9, 0.9, 0.5), t, r.y0 + r.h * 0.45,
              sgn * (rhd + 0.42), 0, 0, 0, shadeHex(wallTint, 0.94));
            put('ashlar', boxGeo(1.3, 0.26, 1.1, 0.8), t, r.y0 + r.h * 0.9,
              sgn * (rhd + 0.42), 0, 0, 0, shadeHex(wallTint, 0.88));
          }
        }
        /* The string course under the eaves. A band round the OUTSIDE, so on
         * an enterable shell it is four stones and not one slab - see the note
         * on the plank boarding above. On a single-storey range like the abbey
         * church the solid version sat 3 cm under the ceiling and across the
         * whole nave, which is a dropped ceiling nobody asked for. */
        if (enter) {
          for (const sgn of [-1, 1]) {
            put('ashlar', boxGeo(r.w + 0.34, 0.22, 0.4, 0.8),
              0, r.y0 + r.h - 0.14, sgn * (rhd + 0.17 - 0.2), 0, 0, 0, shadeHex(wallTint, 0.9));
            put('ashlar', boxGeo(0.4, 0.22, r.d + 0.34 - 0.8, 0.8),
              sgn * (rhw + 0.17 - 0.2), r.y0 + r.h - 0.14, 0, 0, 0, 0, shadeHex(wallTint, 0.9));
          }
        } else {
          put('ashlar', boxGeo(r.w + 0.34, 0.22, r.d + 0.34, 0.8), 0, r.y0 + r.h - 0.14, 0, 0, 0, 0,
            shadeHex(wallTint, 0.9));
        }
      } else {
        // Rubble: dressed quoins at the angles, and nothing else. Grimscar.
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 1]) {
            for (let i = 0; i < Math.max(2, Math.round(r.h / 0.75)); i++) {
              const cy = r.y0 + 0.3 + i * 0.75;
              if (cy > r.y0 + r.h - 0.2) break;
              const long = i % 2 === 0;
              put('ashlar', boxGeo(long ? 0.9 : 0.42, 0.34, long ? 0.42 : 0.9, 0.55),
                sx * (rhw - (long ? 0.42 : 0.18)), cy, sz * (rhd - (long ? 0.18 : 0.42)),
                0, 0, 0, shadeHex(wallTint, 1.22));
            }
          }
        }
      }
      // Jetty brackets under an oversailing upper storey.
      if (jut > 0 && r.y0 > 0.5) {
        // The bressumer, round the outside of the oversail. Solid, it was a
        // 32 cm plinth across the whole of every jettied upper room.
        if (enter) {
          for (const sgn of [-1, 1]) {
            put('beam', boxGeo(r.w + 0.2, 0.32, wt, 0.8), 0, r.y0 + 0.16,
              sgn * (rhd + 0.1 - wt / 2), 0, 0, 0, bt());
            put('beam', boxGeo(wt, 0.32, r.d + 0.2 - wt * 2, 0.8), sgn * (rhw + 0.1 - wt / 2),
              r.y0 + 0.16, 0, 0, 0, 0, bt());
          }
        } else {
          put('beam', boxGeo(r.w + 0.2, 0.32, r.d + 0.2, 0.8), 0, r.y0 + 0.16, 0, 0, 0, 0, bt());
        }
        for (let i = -3; i <= 3; i++) {
          for (const sgn of [-1, 1]) {
            put('beam', boxGeo(0.18, 0.18, jut + 0.3, 1.1), (i * w) / 7.5, r.y0 - 0.16,
              sgn * (hd + jut / 2), 0, 0, 0, bt());
          }
        }
      }
    }

    /* ---- Roof ------------------------------------------------------- */
    const flat = o.roof === 'flat' || o.roof === 'none';
    const over = o.roof === 'thatch' ? 0.7 : 0.42;
    const rw = (o.storeys > 1 ? w + jut * 2 : w) + over * 2;
    const rd = (o.storeys > 1 ? d + jut * 2 : d) + over * 2;
    const rh = flat ? 0 : rd * (o.roof === 'thatch' ? 0.6 : 0.5);
    if (flat) {
      put(roofKey, boxGeo(rw, 0.3, rd, 0.7), 0, top + 0.15, 0, 0, 0, 0, roofTint);
      // Parapet, so a flat roof reads as a walkable one.
      for (const s of [-1, 1]) {
        put(wallKey, boxGeo(rw, 0.85, 0.34, 0.7), 0, top + 0.72, s * (rd / 2 - 0.17), 0, 0, 0,
          shadeHex(wallTint, 0.95));
        put(wallKey, boxGeo(0.34, 0.85, rd - 0.68, 0.7), s * (rw / 2 - 0.17), top + 0.72, 0, 0, 0, 0,
          shadeHex(wallTint, 0.95));
      }
    } else {
      const slope = Math.atan2(rh, rd / 2);
      const slabLen = Math.hypot(rd / 2, rh) + over * 0.4;
      const thick = o.roof === 'thatch' ? 0.52 : 0.16;
      for (const sgn of [-1, 1]) {
        put(roofKey, boxGeo(rw, thick, slabLen, o.roof === 'thatch' ? 0.5 : 0.7),
          0, top + rh / 2 - Math.cos(slope) * thick * 0.2, sgn * (rd / 4) * 0.98,
          sgn * slope, 0, 0, roofTint);
      }
      if (o.roof === 'thatch') {
        put('thatch', cylGeo(0.4, 0.4, rw, 10, 0.7), 0, top + rh + 0.1, 0, 0, 0, Math.PI / 2, roofTint);
      } else {
        put(roofKey, boxGeo(rw, 0.22, 0.56, 0.9), 0, top + rh + 0.05, 0, 0, 0, 0,
          shadeHex(roofTint, 0.9));
      }
      // Gable infill and barge boards.
      for (const sgn of [-1, 1]) {
        const sh = new THREE.Shape();
        sh.moveTo(-rd / 2 + over * 0.7, 0);
        sh.lineTo(rd / 2 - over * 0.7, 0);
        sh.lineTo(0, rh);
        sh.closePath();
        const gg = new THREE.ExtrudeGeometry(sh, { depth: 0.22, bevelEnabled: false });
        MedievalWorld._uvScale(gg, 0.5);
        put(wallKey, gg, sgn * (rw / 2 - over - 0.11), top, 0, 0, (Math.PI / 2) * sgn, 0, wallTint);
        for (const zz of [rd / 4, -rd / 4]) {
          put('beam', boxGeo(0.18, slabLen * 0.98, 0.16, 1.0), sgn * (rw / 2 - over), top + rh / 2, zz,
            (zz > 0 ? 1 : -1) * (slope - Math.PI / 2) * (zz > 0 ? 1 : -1), 0, 0, bt());
        }
      }
    }

    /* ---- Chimney ---------------------------------------------------- */
    if (hasChimney(o)) {
      const chx = (rnd() < 0.5 ? -1 : 1) * w * 0.32;
      const chTop = top + rh + 1.5;
      put('rubble', boxGeo(0.95, chTop + plinth, 0.95, 0.6), chx, (chTop - plinth) / 2, -hd + 0.4,
        0, 0, 0, 0x8e8375);
      put('rubble', boxGeo(1.24, 0.24, 1.24, 0.8), chx, chTop + 0.12, -hd + 0.4, 0, 0, 0, 0x827868);
      if (o.lit) {
        const sp = at(chx, chTop + 0.5, -hd + 0.4);
        this._smokeOrigins.push(sp.x, sp.y, sp.z);
      }
    }

    /* ---- Openings --------------------------------------------------- */
    const glow = o.lit ? 0xffd9a0 : 0x6f6250;
    if (o.windows !== 'none') {
      for (const fl of plan.floors) {
        const outZ = hd + (fl.storey > 0 ? jut : 0) + 0.06;
        const cols = w > 9 ? [-w * 0.3, 0, w * 0.3] : (w > 6 ? [-w * 0.24, w * 0.24] : [0]);
        /* One row of openings at sill height, and a CLERESTORY over it when the
         * storey is tall enough to need one.
         *
         * A window row is placed off the floor, so on a domestic storey it is
         * most of the wall and this loop runs once, exactly as it always has.
         * `storeyClear` gives an ecclesiastical volume its height from its
         * span, and the abbey nave came out of that at 8.90 m - six metres of
         * blank ashlar above a row of lancets whose heads stop at 3.6, inside
         * and out. That is not a nave, it is a wall with a skirting of glass.
         *
         * 2.75 m down from the wall head rather than a fraction of it, because
         * what has to clear is the tallest OPENING (a lancet plus its head
         * drum, 2.06 m over the row's own line) and the string course under the
         * eaves, both of which are fixed sizes. The trigger is 4.6 m: above
         * that the two rows are more than 1.5 m apart and read as two rows;
         * below it they would merge into one band of glass. No domestic shell
         * in the table is anywhere near it. */
        const rows = [{ y: fl.floorY + 1.25, sill: true }];
        if (fl.clear > 4.6) rows.push({ y: fl.floorY + fl.clear - 2.75, sill: false });
        for (const { y: wy, sill } of rows) {
          for (const cx of cols) {
            for (const sgn of [1, -1]) {
              // Never a window where the door is. Only the sill row can be: the
              // clerestory is four metres over the lintel.
              if (sill && sgn > 0 && fl.storey === 0 && Math.abs(cx) < doorHW + 0.7) continue;
              const wz = sgn * outZ;
              if (o.windows === 'lancet') {
                put('ashlar', boxGeo(0.95, 2.5, 0.24, 1.1), cx, wy + 0.4, wz, 0, 0, 0,
                  shadeHex(wallTint, 0.92));
                put('glass', planeGeo(0.6, 1.9, 1.0), cx, wy + 0.4, wz - sgn * 0.07, 0,
                  sgn > 0 ? 0 : Math.PI, 0, HERALD[Math.abs((cx * 7 + fl.storey) | 0) % HERALD.length]);
                // The pointed head, as a half-round drum set into the reveal.
                put('ashlar', cylGeo(0.36, 0.36, 0.22, 10, 0.8), cx, wy + 1.7, wz, Math.PI / 2, 0, 0,
                  shadeHex(wallTint, 0.9));
              } else if (o.windows === 'slit') {
                put(wallKey, boxGeo(0.44, 1.35, 0.22, 1.2), cx, wy, wz, 0, 0, 0,
                  shadeHex(wallTint, 0.86));
                put('glass', planeGeo(0.2, 1.0, 1.0), cx, wy, wz - sgn * 0.07, 0,
                  sgn > 0 ? 0 : Math.PI, 0, glow);
              } else {
                put('beam', boxGeo(1.2, 1.1, 0.18, 1.2), cx, wy, wz, 0, 0, 0, bt());
                put('glass', planeGeo(0.88, 0.78, 1.2), cx, wy, wz - sgn * 0.07, 0,
                  sgn > 0 ? 0 : Math.PI, 0, glow);
                put('beam', boxGeo(0.07, 0.82, 0.09, 2.0), cx, wy, wz + sgn * 0.01, 0, 0, 0,
                  shadeHex(beamTint, 0.66));
                for (const ss of [-1, 1]) {
                  put('plank', boxGeo(0.58, 0.96, 0.08, 1.3), cx + ss * 0.88, wy, wz + sgn * 0.18,
                    0, sgn * ss * -0.42, 0, SHUTTER_TINTS[(rnd() * SHUTTER_TINTS.length) | 0]);
                }
              }
              /* Firelight out of a window is a GROUND floor thing, and it stays
               * one row: a second glow card per opening would double the count
               * on every church in the ring to light a window nobody can see
               * into from the street. */
              if (o.lit && fl.storey === 0 && sill) {
                const gp = at(cx, wy, wz + sgn * 0.2);
                this._addGlow(gp.x, gp.y, gp.z, 2.4, 0x54301a, o.yaw + (sgn > 0 ? 0 : Math.PI));
              }
            }
          }
        }
      }
    }

    /* ---- Door ------------------------------------------------------- */
    const doorZ = hd + 0.06;
    let doorRecord = null;
    if (!enter) {
      put('beam', boxGeo(DOOR_W + 0.4, doorH + 0.3, 0.2, 1.0), 0, plan.door.y + (doorH + 0.3) / 2,
        doorZ, 0, 0, 0, bt());
      put('plank', boxGeo(DOOR_W - 0.1, doorH - 0.1, 0.14, 0.9), 0, plan.door.y + doorH / 2,
        doorZ + 0.1, 0, 0, 0, 0x6d4f30);
      for (let i = 0; i < 2; i++) {
        put('iron', boxGeo(DOOR_W - 0.1, 0.12, 0.18, 1.6), 0, plan.door.y + 0.6 + i * 1.0,
          doorZ + 0.14, 0, 0, 0, 0x2c2722);
      }
    } else {
      for (const sgn of [-1, 1]) {
        put('beam', boxGeo(0.2, doorH + 0.14, 0.52, 1.0), sgn * (doorHW + 0.1),
          plan.door.y + (doorH + 0.14) / 2, hd - 0.2, 0, 0, 0, bt());
      }
      put('beam', boxGeo(DOOR_W + 0.4, 0.24, 0.52, 1.0), 0, plan.door.y + doorH + 0.12, hd - 0.2,
        0, 0, 0, bt());
      /* One mesh per leaf, straps included.
       *
       * `_house` gives each cottage door three meshes - a plank leaf and two
       * iron bands parented to the same pivot - which is fine at nineteen
       * doors and is not fine at fifty-four: the ring towns would have added
       * 162 draw calls of door furniture, more than the five town districts
       * they belong to put together. The straps are merged into the leaf and
       * carried as vertex colour on the plank material instead. A 12 cm iron
       * band at any distance a door is looked at is a dark line across the
       * boards; the metalness that distinguishes it is worth two thirds of
       * the draw calls in this phase, and it is not.
       */
      const leafW = DOOR_W - 0.06;
      const leafParts = [];
      {
        const g = boxGeo(leafW, doorH - 0.12, 0.09, 0.9);
        g.translate(leafW / 2, 0, 0);
        leafParts.push(normaliseGeo(g, 0x6d4f30));
      }
      for (const by of [-0.5, 0.5]) {
        const g = boxGeo(leafW * 0.9, 0.11, 0.05, 1.6);
        g.translate(leafW / 2, by, 0.06);
        leafParts.push(normaliseGeo(g, 0x2c2722));
      }
      const leafGeo = mergeGeometries(leafParts, false);
      for (const g of leafParts) g.dispose();
      const leaf = new THREE.Mesh(leafGeo, this._mats.plank);
      leaf.castShadow = leaf.receiveShadow = true;
      const pivot = new THREE.Group();
      pivot.position.copy(at(-doorHW + 0.02, plan.door.y + (doorH - 0.12) / 2 + 0.04, hd - wt / 2));
      pivot.rotation.y = o.yaw;
      pivot.add(leaf);
      this.group.add(pivot);
      this._owned.push(leafGeo);
      const dc = at(0, plan.door.y + doorH / 2, hd - wt / 2);
      const doorCol = this._rbox(dc.x, dc.y, dc.z, doorHW, doorH / 2, 0.12, o.yaw);
      doorRecord = {
        id: `${o.id}_door`,
        leaves: [{ pivot, closed: o.yaw, open: o.yaw + Math.PI * 0.58 }],
        collider: doorCol,
        position: at(0, plan.door.y + 1.0, hd + 0.2),
        open: false,
        anim: 0,
      };
    }
    /* Threshold and the ground up to it, then a hood over the door.
     *
     * This used to be one 20 cm stone, which is a threshold on flat ground and
     * nothing at all on a slope - and the shells stand on slopes, because that
     * is what an outer ring of hill towns is. `_entrySteps` measures the drop
     * and lays as many courses as it takes. On level ground it lays exactly
     * the one stone this replaces. */
    if (!o.stilt) {
      this._entrySteps(B, { M, yaw: o.yaw, hd, baseY, sill: 0.2, doorW: DOOR_W });
    } else {
      put('rubble', boxGeo(DOOR_W + 0.5, 0.2, 0.66, 0.9), 0, 0.1, doorZ + 0.38, 0, 0, 0, 0x8e8371);
    }
    put('beam', boxGeo(DOOR_W + 0.8, 0.2, 0.85, 1.0), 0, plan.door.y + doorH + 0.5, doorZ + 0.28,
      0, 0, 0, bt());

    /* ---- Colliders and interior ------------------------------------- */
    /** Every light this building's rooms own, for the enterable descriptor. */
    const interiorLights = [];
    const wallsTop = plan.roofY;
    if (!enter) {
      const cy = (plan.roofY - plinth) / 2;
      this._rbox(o.x, baseY + cy, o.z, (w + jut * 2) / 2 + 0.08,
        (plan.roofY + plinth) / 2, (d + jut * 2) / 2 + 0.08, o.yaw);
    } else {
      const hyW = (wallsTop + plinth) / 2;
      const cyW = (wallsTop - plinth) / 2;
      rcol(0, cyW, -hd + wt / 2, hw + 0.06, hyW, wt / 2 + 0.05);
      for (const sgn of [-1, 1]) rcol(sgn * (hw - wt / 2), cyW, 0, wt / 2 + 0.05, hyW, hd + 0.06);
      const segW = hw - doorHW;
      for (const sgn of [-1, 1]) {
        rcol(sgn * (doorHW + segW / 2), cyW, hd - wt / 2, segW / 2 + 0.04, hyW, wt / 2 + 0.05);
      }
      const overH = wallsTop - (plan.door.y + doorH);
      if (overH > 0.05) {
        rcol(0, plan.door.y + doorH + overH / 2, hd - wt / 2, doorHW + 0.05, overH / 2, wt / 2 + 0.05);
      }
      this._shellInterior(B, o, plan, { put, rcol, at, bt, baseY, plinth, lights: interiorLights });
    }

    /* ---- Registration ----------------------------------------------- */
    if (enter) {
      if (!Array.isArray(this.enterables)) this.enterables = [];
      const spot = at(-w * 0.2, plan.floors[0].floorY + 0.4, -d * 0.2);
      this.enterables.push({
        label: o.label || `${o.kind}@${o.x | 0},${o.z | 0}`,
        origin: new THREE.Vector3(o.x, baseY, o.z),
        doors: doorRecord ? [doorRecord] : [],
        collectibleSpots: [{ position: spot, tier: o.landmark ? 'rare' : 'common' }],
        /* What actually lights the room. Declared on the descriptor rather
         * than left implicit in the scene graph so "this interior is lit" is a
         * property something can READ - which is the whole reason fifty-four
         * unlit rooms could ship past a 1074-test suite. */
        lights: interiorLights,
      });
    }
    if (o.lit) {
      const gp = at(0, 0.08, doorZ + 0.9);
      this._addGlow(gp.x, gp.y, gp.z, 4.2, 0x4a2a12);
    }
    this._footprints.push({ x: o.x, z: o.z, hx: w / 2 + 1.3, hz: d / 2 + 1.3, r: o.yaw });
    if (o.landmark) {
      this.minimapShapes.push({
        kind: 'rect', x: o.x, z: o.z, w: w + 1.4, d: d + 1.4, rotation: o.yaw,
        fill: 'rgba(132,104,78,0.45)', stroke: 'rgba(226,198,152,0.9)',
      });
    }
    return { baseY, top: baseY + plan.roofY, roofTop: baseY + plan.roofY + rh };
  }

  /**
   * Floors, ceilings, stairs and furniture for an enterable shell.
   *
   * Split out of `_shell` because it is the half that has to be right rather
   * than the half that has to look right, and because the deck-with-a-hole
   * arithmetic is the only genuinely fiddly thing in either.
   */
  _shellInterior(B, o, plan, ctx) {
    const { put, rcol, at, bt, baseY, lights } = ctx;
    const rnd = mulberry32(o.seed ^ 0x5bd1);
    const hw = o.w / 2;
    const hd = o.d / 2;
    const wt = plan.wallT;
    const ihx = plan.inner.hx;
    const ihz = plan.inner.hz;

    /**
     * A floor deck with an optional rectangular well cut in it.
     *
     * Four boxes rather than a plane with a hole, because the deck is also the
     * collider: a player must not be able to walk over the stair well, and a
     * single box with a decorative hole in its geometry would let them.
     */
    const deck = (y, hole, tint) => {
      const parts = hole
        ? [
          [-ihx, hole.x0, -ihz, ihz],
          [hole.x1, ihx, -ihz, ihz],
          [hole.x0, hole.x1, -ihz, hole.z0],
          [hole.x0, hole.x1, hole.z1, ihz],
        ]
        : [[-ihx, ihx, -ihz, ihz]];
      for (const [x0, x1, z0, z1] of parts) {
        const pw = x1 - x0;
        const pd = z1 - z0;
        if (pw <= 0.05 || pd <= 0.05) continue;
        put('plank', boxGeo(pw, 0.16, pd, 0.7), (x0 + x1) / 2, y - 0.08, (z0 + z1) / 2, 0, 0, 0, tint);
        rcol((x0 + x1) / 2, y - 0.16, (z0 + z1) / 2, pw / 2, 0.1, pd / 2);
      }
    };

    // Ground floor sits on the plinth core, so it is one solid slab.
    const f0 = plan.floors[0];
    put('plank', boxGeo(o.w - 0.2, 0.16, o.d - 0.2, 0.7), 0, f0.floorY - 0.08, 0, 0, 0, 0, 0x97754c);
    rcol(0, f0.floorY - 0.3, 0, hw - 0.05, 0.24, hd - 0.05);

    for (let s = 0; s < plan.stairs.length; s++) {
      const st = plan.stairs[s];
      // The deck this flight arrives at, with its own well cut in it.
      deck(plan.floors[s + 1].floorY, st.well, s === 0 ? 0x8a6b45 : 0x8f7049);
      // Joists under it.
      for (let i = -2; i <= 2; i++) {
        put('beam', boxGeo(0.16, 0.18, o.d - 0.5, 1.0), (i * o.w) / 6,
          plan.floors[s + 1].floorY - 0.26, 0, 0, 0, 0, bt());
      }
      // The flight. Each step is solid from the floor below to its own tread,
      // so there is nothing to fall through and the step-up probe always has a
      // face to find.
      for (let i = 0; i < st.steps; i++) {
        const treadTop = st.fromY + (i + 1) * st.rise;
        const h = treadTop - st.fromY + 0.1;
        const cz = st.z0 + st.dir * (i + 0.5) * st.tread;
        put('plank', boxGeo(STAIR_W, h, st.tread, 0.8), st.x, treadTop - h / 2, cz, 0, 0, 0, 0x9a7a50);
        rcol(st.x, treadTop - h / 2, cz, STAIR_W / 2, h / 2, st.tread / 2);
      }
      // Newel post and a rail, so the flight reads as joinery.
      put('beam', boxGeo(0.16, st.toY - st.fromY + 1.0, 0.16, 1.2), st.x - STAIR_W / 2,
        st.fromY + (st.toY - st.fromY + 1.0) / 2, st.z0 + st.dir * st.run, 0, 0, 0, bt());
      put('beam', boxGeo(0.1, 0.1, st.run, 1.2), st.x - STAIR_W / 2,
        (st.fromY + st.toY) / 2 + 0.95, st.z0 + st.dir * st.run / 2,
        -st.dir * Math.atan2(st.toY - st.fromY, st.run), 0, 0, bt());
    }

    // The topmost ceiling.
    const topF = plan.floors[plan.floors.length - 1];
    put('plank', boxGeo(o.w - 0.1, 0.14, o.d - 0.1, 0.7), 0, topF.ceilY + 0.07, 0, 0, 0, 0, 0x8a6b45);
    rcol(0, topF.ceilY + 0.07, 0, hw, 0.1, hd);
    for (let i = -2; i <= 2; i++) {
      put('beam', boxGeo(0.17, 0.2, o.d - 0.5, 1.0), (i * o.w) / 6, topF.ceilY - 0.1, 0, 0, 0, 0, bt());
    }

    /* ---- Furnishing -------------------------------------------------
     *
     * Enough that a room is a room. The landmark buildings get their own
     * dressing on top of this from `_townDressing`, which is what makes the
     * walk worth it; everything else gets a hearth, a board and somewhere to
     * sleep, which is what stops an "enterable" building being a shed. */
    const fy = plan.floors[0].floorY;
    const tX = -o.w * 0.2;
    const tZ = -o.d * 0.1;
    put('plank', boxGeo(Math.min(2.0, ihx), 0.09, 0.9, 1.0), tX, fy + 0.74, tZ, 0, 0.1, 0, 0x9a7a50);
    for (const sx of [-1, 1]) {
      put('beam', boxGeo(0.13, 0.7, 0.8, 1.2), tX + sx * Math.min(0.8, ihx * 0.4), fy + 0.37, tZ,
        0, 0.1, 0, bt());
    }
    rcol(tX, fy + 0.4, tZ, Math.min(1.05, ihx * 0.5), 0.42, 0.55);
    for (const [sx, sz] of [[0.95, 0.3], [-0.5, 0.9]]) {
      put('plank', cylGeo(0.23, 0.19, 0.48, 8, 1.0), tX + sx, fy + 0.24, tZ + sz, 0, 0, 0, 0x8f6f47);
    }
    if (ihx > 2.2) {
      const bX = o.w * 0.24;
      const bZ = -o.d * 0.14;
      put('beam', boxGeo(0.95, 0.4, 1.9, 1.0), bX, fy + 0.2, bZ, 0, 0, 0, bt());
      put('canopy', boxGeo(0.88, 0.17, 1.8, 2.0), bX, fy + 0.48, bZ, 0, 0, 0, 0xcfc2a4);
      put('canopy', boxGeo(0.82, 0.13, 0.48, 2.0), bX, fy + 0.6, bZ - 0.64, 0, 0, 0, 0xddd2b8);
      rcol(bX, fy + 0.34, bZ, 0.5, 0.34, 0.98);
    }
    // Hearth on the back wall, under the chimney.
    put('rubble', boxGeo(1.5, 1.25, 0.3, 0.7), 0, fy + 0.62, -hd + wt + 0.16, 0, 0, 0, 0x8d8270);
    put('ember', boxGeo(0.62, 0.28, 0.22, 2.0), 0, fy + 0.17, -hd + wt + 0.2, 0, 0, 0, 0xffb060);
    const hp = at(0, fy + 0.3, -hd + wt + 0.7);
    this._addGlow(hp.x, hp.y, hp.z, 3.2, 0x5a3416);
    // A shelf, a crock and a broom - the small stuff that says lived-in.
    put('plank', boxGeo(Math.min(2.4, ihx * 1.2), 0.07, 0.32, 1.0), 0, fy + 1.55, -hd + wt + 0.2,
      0, 0, 0, 0x8f7049);
    put('rock', cylGeo(0.14, 0.17, 0.3, 8, 1.0), -0.5, fy + 1.73, -hd + wt + 0.2, 0, 0, 0, 0x9a8f7c);
    put('rock', cylGeo(0.11, 0.13, 0.24, 8, 1.0), 0.3, fy + 1.7, -hd + wt + 0.2, 0, 0, 0, 0xa6997f);
    put('beam', cylGeo(0.04, 0.04, 1.3, 5, 1.2), ihx - 0.25, fy + 0.65, ihz - 0.3, 0, 0, 0.12, 0x8a6c4a);
    if (rnd() < 0.6) {
      put('hay', boxGeo(0.7, 0.5, 0.5, 1.6), -ihx + 0.5, fy + 0.25, ihz - 0.5, 0, rnd() * 0.6, 0, 0xd8c48a);
    }

    /* ---- Light ------------------------------------------------------
     *
     * One lamp per STOREY, not one per building. A shell's upper floors are
     * where the dressing that justifies the climb lives - the solar, the great
     * chamber, the winding house's tally gallery - and a hearth lamp on the
     * ground floor is behind a solid plank deck from all of it. See
     * `_interiorLight` for why fifty-odd more point lights is now affordable
     * and what stops them spilling into the street.
     *
     * Set back from the centre toward the hearth wall so the light has a
     * direction: a lamp dead centre lights every wall equally, which is the
     * one arrangement that makes a modelled room read as a lit box. */
    for (const fl of plan.floors) {
      const ly = fl.floorY + Math.min(2.05, fl.clear - 0.75);
      /* A lamp reaches at most 16 m, and the abbey church is a 34 m nave: one
       * lamp in it lights the crossing and leaves both ends black. The count
       * follows the room, so it is right for a 5 m fisherman's hut and right
       * for the tithe barn without either being a special case.
       *
       * It followed the room's WIDTH only, and that is a measurement of a nave
       * rather than of a room: The Marcher Hall is 14 x 11.5 m, which is
       * 161 m2 - bigger in plan than eight of the ten rooms that already got
       * two lamps - and `round(14 / 12)` is one. It read at 25.9 out of 255
       * against the Guildhall's 37.4, as one pool on a black floor. So the
       * count now also follows AREA, at one lamp per 64 m2 of floor. Across all
       * fifty-four enterables that changes exactly one building, which is the
       * one the browser pass found; every other count is held by the width
       * term, so the abbey church keeps its three and the tithe barn its two.
       */
      const n = Math.max(1, Math.round(o.w / 12), Math.min(4, Math.round(Math.sqrt(o.w * o.d) / 8)));
      for (let i = 0; i < n; i++) {
        const lx = n === 1 ? 0 : ((i + 0.5) / n - 0.5) * (ihx * 2);
        lights?.push(this._interiorLight(at(lx, ly, -ihz * 0.3), o.w / n, o.d));
      }
    }
    if (o.landmark) this._landmarkInterior(o, plan, ctx, ihx, ihz);
  }

  /**
   * What makes a landmark worth the walk.
   *
   * The generic furnishing above gives every enterable building a board, a
   * bed and a hearth, which is what stops "enterable" meaning "shed". It is
   * not a destination. A player who climbs a bluff, crosses a ford or walks a
   * kilometre of abbey road has to find something inside that the cottage
   * three metres from their spawn does not have, or the landmark is a bigger
   * box.
   *
   * So each of the five gets its own set, keyed on the building's kind rather
   * than its id - a second guildhall would get guildhall furniture. The sets
   * are deliberately about WORK: a winding drum with the rope still on it, a
   * high table under banners, an altar with candles burning on it. A room
   * full of ornament reads as a museum; a room full of half-finished work
   * reads as a place someone left ten minutes ago.
   */
  _landmarkInterior(o, plan, ctx, ihx, ihz) {
    const { put, rcol, at, bt } = ctx;
    const fy = plan.floors[0].floorY;
    const up = plan.floors.length > 1 ? plan.floors[1].floorY : null;
    const rnd = mulberry32(o.seed ^ 0x9e37);
    /** A rush light or candle: an ember box plus the glow it throws. */
    const flame = (lx, ly, lz, r = 2.6) => {
      put('ember', boxGeo(0.09, 0.16, 0.09, 2.0), lx, ly, lz, 0, 0, 0, 0xffc074);
      const w = at(lx, ly, lz);
      this._addGlow(w.x, w.y - 0.2, w.z, r, 0x5a3416);
    };
    switch (o.kind) {
      case 'windinghouse': {
        /* The drum, the rope and the brake - the machine the whole town is
         * arranged around, indoors and still rigged. */
        put('beam', cylGeo(1.15, 1.15, 2.6, 14, 0.8), 0, fy + 1.5, -0.4, 0, 0, Math.PI / 2, 0x7a6144);
        for (const sx of [-1, 1]) {
          put('beam', boxGeo(0.3, 2.4, 0.3, 1.1), sx * 1.7, fy + 1.2, -0.4, 0, 0, 0, bt());
          put('iron', cylGeo(0.14, 0.14, 0.5, 8, 1.2), sx * 1.45, fy + 1.5, -0.4, 0, 0, Math.PI / 2, 0x3a3128);
        }
        rcol(0, fy + 1.2, -0.4, 1.9, 1.2, 1.3);
        // The rope, running off the drum and out through the wall to the shaft.
        put('iron', cylGeo(0.05, 0.05, ihz * 2, 5, 2.0), 0.3, fy + 2.5, 0, Math.PI / 2, 0, 0, 0x2c2722);
        // A geared spur wheel and the brake lever.
        {
          const g = new THREE.TorusGeometry(0.85, 0.1, 5, 18);
          MedievalWorld._uvScale(g, 0.6);
          put('iron', g, -2.1, fy + 1.5, -0.4, 0, Math.PI / 2, 0, 0x3a3128);
        }
        put('beam', boxGeo(0.14, 0.14, 2.2, 1.2), -2.4, fy + 1.1, 0.6, 0.5, 0, 0, bt());
        /* Ore sorting tables, with picked ore on them - along the SIDE walls.
         *
         * They ran along the front and back walls, and the front wall is the
         * one with the door in it: a 1.0 m bench 6.7 m wide stood eighty
         * centimetres inside the entrance, across the whole opening. The
         * building passed every interior test there was, because those probe
         * `interiorPlan.standing` - which is deeper into the room, past the
         * bench. You could not get to it. */
        for (const sx of [-1, 1]) {
          put('plank', boxGeo(0.8, 0.08, ihz * 1.2, 0.9), sx * (ihx - 0.7), fy + 0.86, 0, 0, 0, 0, 0x9a7a50);
          for (let i = 0; i < 6; i++) {
            put('rock', boxGeo(0.22, 0.16, 0.2, 1.4), sx * (ihx - 0.7), fy + 0.98,
              (i / 5 - 0.5) * ihz * 1.0, 0, rnd() * TAU, 0, 0x35302a);
          }
          rcol(sx * (ihx - 0.7), fy + 0.5, 0, 0.45, 0.5, ihz * 0.6);
        }
        flame(-ihx + 0.4, fy + 1.9, 0, 3.2);
        flame(ihx - 0.4, fy + 1.9, 0, 3.2);
        if (up !== null) {
          // The upper gallery: a rail overlooking the drum, and the tally desk.
          for (let i = -3; i <= 3; i++) {
            put('beam', boxGeo(0.1, 0.95, 0.1, 1.2), (i / 3) * (ihx - 0.6), up + 0.5, ihz - 1.4, 0, 0, 0, bt());
          }
          put('beam', boxGeo(ihx * 2 - 1.0, 0.1, 0.1, 1.2), 0, up + 0.98, ihz - 1.4, 0, 0, 0, bt());
          put('plank', boxGeo(1.6, 0.08, 0.75, 0.9), -ihx + 1.1, up + 0.82, -ihz + 0.9, 0, 0, 0, 0x9a7a50);
          rcol(-ihx + 1.1, up + 0.45, -ihz + 0.9, 0.85, 0.45, 0.45);
          flame(-ihx + 1.1, up + 1.05, -ihz + 0.9, 2.8);
        }
        break;
      }
      case 'abbeychurch': {
        /* A nave: two arcades of piers, choir stalls between them, an altar
         * under the east window and candles burning on it. The piers are what
         * make it a church rather than a hall - the eye reads the rhythm long
         * before it reads the altar. */
        const bays = Math.max(4, Math.round(ihx / 3.2));
        for (let i = 0; i <= bays; i++) {
          const lx = (i / bays - 0.5) * (ihx * 1.75);
          for (const sz of [-1, 1]) {
            const lz = sz * (ihz - 1.5);
            put('ashlar', cylGeo(0.36, 0.42, plan.floors[0].clear - 0.5, 10, 0.7),
              lx, fy + (plan.floors[0].clear - 0.5) / 2, lz, 0, 0, 0, 0xd6cfbc);
            put('ashlar', boxGeo(0.9, 0.28, 0.9, 0.9), lx, fy + plan.floors[0].clear - 0.35, lz, 0, 0, 0, 0xc9c1ad);
            rcol(lx, fy + 1.2, lz, 0.42, 1.2, 0.42);
          }
        }
        // Choir stalls down the middle, facing each other across the aisle.
        for (const sz of [-1, 1]) {
          put('plank', boxGeo(ihx * 1.3, 0.5, 0.55, 0.9), 0, fy + 0.25, sz * 1.5, 0, 0, 0, 0x8f7049);
          put('plank', boxGeo(ihx * 1.3, 1.3, 0.14, 1.0), 0, fy + 0.65, sz * 1.85, 0, 0, 0, 0x7c6242);
          rcol(0, fy + 0.3, sz * 1.6, ihx * 0.65, 0.3, 0.4);
        }
        // The altar, at the east end, with a step up to it.
        {
          const ax = ihx - 1.6;
          put('flagstone', boxGeo(3.2, 0.2, ihz * 1.6, 0.7), ax + 0.6, fy + 0.1, 0, 0, 0, 0, 0xb8b2a4);
          rcol(ax + 0.6, fy + 0.1, 0, 1.6, 0.12, ihz * 0.8);
          put('ashlar', boxGeo(0.7, 1.0, 2.4, 0.7), ax, fy + 0.7, 0, 0, 0, 0, 0xd6cfbc);
          put('canopy', boxGeo(0.85, 0.09, 2.6, 1.4), ax, fy + 1.24, 0, 0, 0, 0, 0xe6e0d2);
          rcol(ax, fy + 0.7, 0, 0.4, 0.7, 1.2);
          for (const sz of [-0.85, 0.85]) {
            put('beam', cylGeo(0.05, 0.08, 0.55, 6, 1.2), ax, fy + 1.55, sz, 0, 0, 0, 0xcfc4ac);
            flame(ax, fy + 1.9, sz, 3.4);
          }
          /* A rood screen, so the chancel is a room within the room.
           *
           * Capped, not derived from the storey. It used to be the clear height
           * less 1.2, which is a screen in a 2.85 m room and a cage in a nave:
           * `storeyClear` gives this church 8.90 m of it, and nine 12 cm posts
           * carried all the way to the ceiling read as a grille across the
           * building rather than as the joinery a rood screen is. A screen is
           * about head height with a beam over it, at any scale of church. */
          const screenH = Math.min(plan.floors[0].clear - 1.2, 4.2);
          for (let i = -4; i <= 4; i++) {
            put('beam', boxGeo(0.12, screenH, 0.12, 1.2),
              ax - 3.4, fy + screenH / 2, (i / 4) * (ihz - 0.9), 0, 0, 0, bt());
          }
          put('beam', boxGeo(0.2, 0.22, ihz * 2 - 1.2, 1.1), ax - 3.4, fy + screenH + 0.11, 0, 0, 0, 0, bt());
        }
        // A lectern and a bank of pricket candles by the west door.
        put('beam', cylGeo(0.14, 0.22, 1.25, 8, 1.0), -ihx + 2.4, fy + 0.62, 0, 0, 0, 0, bt());
        put('plank', boxGeo(0.6, 0.07, 0.45, 1.2), -ihx + 2.4, fy + 1.3, 0, 0.4, 0, 0, 0x8f7049);
        rcol(-ihx + 2.4, fy + 0.62, 0, 0.3, 0.62, 0.3);
        for (let i = 0; i < 5; i++) {
          const lz = (i / 4 - 0.5) * 1.6;
          put('iron', cylGeo(0.03, 0.05, 0.9 + (i % 2) * 0.2, 5, 1.4), -ihx + 1.0, fy + 0.5, lz, 0, 0, 0, 0x3a3128);
          flame(-ihx + 1.0, fy + 1.05 + (i % 2) * 0.1, lz, 2.2);
        }
        break;
      }
      case 'towerhall': {
        /* A marcher hall: a long board on trestles under the banners of
         * whoever holds it, a weapon rack by the door and a war chest. */
        put('plank', boxGeo(ihx * 1.5, 0.12, 1.1, 0.9), 0, fy + 0.82, -0.6, 0, 0, 0, 0x9a7a50);
        for (const sx of [-1, 1]) {
          put('beam', boxGeo(0.22, 0.78, 0.9, 1.1), sx * ihx * 0.55, fy + 0.4, -0.6, 0, 0, 0, bt());
        }
        rcol(0, fy + 0.45, -0.6, ihx * 0.78, 0.45, 0.62);
        for (const sz of [-1.6, 0.5]) {
          put('plank', boxGeo(ihx * 1.4, 0.14, 0.42, 0.9), 0, fy + 0.46, sz, 0, 0, 0, 0x8f6f47);
          for (let i = -2; i <= 2; i++) {
            put('beam', boxGeo(0.12, 0.44, 0.12, 1.2), (i / 2) * ihx * 0.6, fy + 0.22, sz, 0, 0, 0, bt());
          }
        }
        for (const sx of [-1, 1]) {
          put('banner', planeGeo(1.2, 2.6, 1.0), sx * (ihx - 0.12), fy + 2.0, -ihz * 0.4,
            0, sx > 0 ? -Math.PI / 2 : Math.PI / 2, 0, HERALD[(sx > 0 ? 0 : 3)]);
        }
        put('beam', boxGeo(0.18, 0.18, ihz * 1.6, 1.1), 0, fy + plan.floors[0].clear - 0.4, 0, 0, 0, 0, bt());
        // A war chest and a rack of spears.
        put('plank', boxGeo(1.3, 0.7, 0.7, 0.9), -ihx + 0.9, fy + 0.35, ihz - 0.8, 0, 0.2, 0, 0x7c6242);
        put('iron', boxGeo(1.36, 0.12, 0.76, 1.4), -ihx + 0.9, fy + 0.74, ihz - 0.8, 0, 0.2, 0, 0x3a3128);
        rcol(-ihx + 0.9, fy + 0.35, ihz - 0.8, 0.7, 0.35, 0.4);
        for (let i = 0; i < 5; i++) {
          put('beam', cylGeo(0.035, 0.045, 2.3, 5, 1.2), ihx - 0.5, fy + 1.15, (i / 4 - 0.5) * 1.4, 0, 0, 0.1, 0x8a6c4a);
          put('iron', coneGeo(0.055, 0.28, 5, 1.2), ihx - 0.38, fy + 2.28, (i / 4 - 0.5) * 1.4, 0, 0, 0, 0x4a4038);
        }
        flame(0, fy + 2.2, ihz - 0.5, 3.6);
        if (up !== null) {
          // The solar above: a bed, a chest and a brazier at the window.
          /* Left wall, not right: the right-hand column of this shell is the
           * stair well for both flights, and a bed there is a ceiling over the
           * treads a player is climbing. */
          put('beam', boxGeo(1.5, 0.45, 2.2, 1.0), -ihx + 1.2, up + 0.22, -ihz + 1.4, 0, 0, 0, bt());
          put('canopy', boxGeo(1.4, 0.2, 2.1, 1.6), -ihx + 1.2, up + 0.55, -ihz + 1.4, 0, 0, 0, 0xcfc2a4);
          rcol(-ihx + 1.2, up + 0.35, -ihz + 1.4, 0.78, 0.35, 1.15);
          put('iron', cylGeo(0.5, 0.34, 0.4, 10, 1.2), 0, up + 0.9, -ihz + 1.1, 0, 0, 0, 0x3a3128);
          for (let i = 0; i < 3; i++) {
            put('beam', cylGeo(0.05, 0.06, 0.9, 5, 1.1), Math.cos(i * 2.09) * 0.35,
              up + 0.45, -ihz + 1.1 + Math.sin(i * 2.09) * 0.35, 0, 0, 0, bt());
          }
          flame(0, up + 1.0, -ihz + 1.1, 4.0);
        }
        break;
      }
      case 'guildhall': {
        /* An undercroft of piers with the wool weighed and stacked in it, and
         * a great chamber over it. That IS a guildhall: the trade downstairs,
         * the men who tax it upstairs. */
        const bays = Math.max(3, Math.round(ihx / 3.4));
        for (let i = 0; i <= bays; i++) {
          const lx = (i / bays - 0.5) * (ihx * 1.6);
          put('ashlar', boxGeo(0.55, plan.floors[0].clear - 0.4, 0.55, 0.7), lx, fy + (plan.floors[0].clear - 0.4) / 2, 0, 0, 0, 0, 0xd6cfbc);
          rcol(lx, fy + 1.2, 0, 0.32, 1.2, 0.32);
        }
        for (let i = 0; i < 10; i++) {
          const lx = (rnd() - 0.5) * ihx * 1.5;
          const lz = (rnd() < 0.5 ? -1 : 1) * (ihz - 1.0);
          put('hay', boxGeo(1.1, 0.75, 0.85, 1.4), lx, fy + 0.38 + (i % 2) * 0.72, lz, 0, rnd() * 0.5, 0, 0xd8cdb0);
        }
        // The beam scale the wool is weighed on.
        put('beam', cylGeo(0.1, 0.14, 2.4, 8, 1.0), -ihx + 1.6, fy + 1.2, ihz - 1.6, 0, 0, 0, bt());
        put('iron', boxGeo(1.8, 0.07, 0.07, 1.6), -ihx + 1.6, fy + 2.3, ihz - 1.6, 0, 0, 0.06, 0x3a3128);
        for (const sx of [-1, 1]) {
          put('iron', cylGeo(0.32, 0.32, 0.05, 10, 1.4), -ihx + 1.6 + sx * 0.85, fy + 1.7, ihz - 1.6, 0, 0, 0, 0x3a3128);
          put('iron', cylGeo(0.02, 0.02, 0.6, 4, 2.0), -ihx + 1.6 + sx * 0.85, fy + 2.0, ihz - 1.6, 0, 0, 0, 0x2c2722);
        }
        rcol(-ihx + 1.6, fy + 1.2, ihz - 1.6, 0.3, 1.2, 0.3);
        flame(ihx - 0.5, fy + 2.0, 0, 3.4);
        if (up !== null) {
          // The great chamber: a long table, benches, banners and a charter.
          put('plank', boxGeo(ihx * 1.5, 0.12, 1.2, 0.9), 0, up + 0.84, 0, 0, 0, 0, 0x9a7a50);
          for (const sx of [-1, 1]) {
            put('beam', boxGeo(0.24, 0.8, 1.0, 1.1), sx * ihx * 0.55, up + 0.4, 0, 0, 0, 0, bt());
          }
          rcol(0, up + 0.45, 0, ihx * 0.78, 0.45, 0.66);
          for (const sz of [-1.3, 1.3]) {
            put('plank', boxGeo(ihx * 1.3, 0.13, 0.42, 0.9), 0, up + 0.46, sz, 0, 0, 0, 0x8f6f47);
          }
          for (let i = 0; i < 3; i++) {
            put('banner', planeGeo(1.0, 2.2, 1.0), (i - 1) * 2.4, up + 1.6, -ihz + 0.15, 0, 0, 0, HERALD[i]);
          }
          put('plank', boxGeo(1.1, 0.05, 0.8, 1.2), -ihx + 1.2, up + 0.92, 0, 0.12, 0, 0, 0xe6e0d2);
          flame(1.6, up + 1.1, 0, 3.0);
          flame(-1.6, up + 1.1, 0, 3.0);
        }
        break;
      }
      case 'stilthall': {
        /* A fishing headman's hall: the catch is the furniture. Nets on frames,
         * a splitting bench with the knife still in it, a salt barrel, and the
         * floor hatch every stilt house has for dropping a line through. */
        put('plank', boxGeo(2.0, 0.1, 0.9, 0.9), -ihx + 1.4, fy + 0.85, ihz - 1.0, 0, 0, 0, 0x9a7a50);
        for (const sx of [-1, 1]) {
          put('beam', boxGeo(0.14, 0.8, 0.8, 1.1), -ihx + 1.4 + sx * 0.8, fy + 0.42, ihz - 1.0, 0, 0, 0, bt());
        }
        rcol(-ihx + 1.4, fy + 0.45, ihz - 1.0, 1.05, 0.45, 0.5);
        put('iron', boxGeo(0.28, 0.04, 0.09, 1.6), -ihx + 1.4, fy + 0.94, ihz - 1.0, 0, 0.4, 0, 0x4a4038);
        for (let i = 0; i < 4; i++) {
          put('canopy', planeGeo(1.5, 1.9, 1.4), -ihx + 0.25, fy + 1.3, (i / 3 - 0.5) * (ihz * 1.4),
            0, Math.PI / 2, 0, 0x8e9a76);
        }
        for (let i = 0; i < 3; i++) {
          put('plank', cylGeo(0.34, 0.4, 0.8, 12, 1.0), ihx - 0.8, fy + 0.4, (i - 1) * 1.0, 0, 0, 0, 0x8f6f47);
          put('iron', cylGeo(0.42, 0.42, 0.06, 12, 1.4), ihx - 0.8, fy + 0.7, (i - 1) * 1.0, 0, 0, 0, 0x3a3128);
        }
        // Fish on a drying line strung across the roof.
        put('beam', cylGeo(0.02, 0.02, ihx * 2, 4, 2.0), 0, fy + 2.1, 0.6, 0, 0, Math.PI / 2, 0xbdae90);
        for (let i = 0; i < 7; i++) {
          put('hay', boxGeo(0.16, 0.5, 0.1, 1.6), (i / 6 - 0.5) * (ihx * 1.7), fy + 1.85, 0.6,
            0, 0, (rnd() - 0.5) * 0.3, 0xb8a476);
        }
        flame(ihx - 0.6, fy + 1.8, -ihz + 0.8, 3.2);
        if (up !== null) {
          put('beam', boxGeo(1.1, 0.4, 2.0, 1.0), -ihx + 1.0, up + 0.2, 0, 0, 0, 0, bt());
          put('canopy', boxGeo(1.0, 0.18, 1.9, 1.6), -ihx + 1.0, up + 0.48, 0, 0, 0, 0, 0xcfc2a4);
          rcol(-ihx + 1.0, up + 0.3, 0, 0.58, 0.3, 1.02);
          for (let i = 0; i < 4; i++) {
            put('plank', cylGeo(0.28, 0.36, 0.7, 10, 1.0), ihx - 0.9, up + 0.35, (i - 1.5) * 0.85, 0, 0, 0, 0x8f6f47);
          }
          flame(0, up + 1.4, -ihz + 0.6, 3.0);
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * Raise the five towns of the outer ring.
   *
   * One `GeoBatch` per town, merged and parented as its own district. That is
   * the established pattern in this file and it is doing two jobs here: the
   * merge collapses a town of thirty buildings to one mesh per material key,
   * and - because a district is spatially local - each town's meshes carry a
   * bounding sphere about ninety metres across and frustum-cull as a unit.
   * Five towns spread over a 900 m map means four of them are usually off
   * screen, which is worth more than the merge is.
   *
   * The AO bake runs per district for the same reason: it voxelises the batch's
   * own bounding box, so a batch that spanned the map would allocate a grid for
   * the map.
   */
  async _buildTowns() {
    for (const town of TOWNS) {
      const B = new GeoBatch();
      const rnd = mulberry32(0x7a000 + town.id.length * 7919 + (town.centre.x | 0));
      let seed = 0x51000;
      for (const b of town.buildings) {
        this._shell(B, { ...b, seed: (seed += 7919) });
        await this._breathe();
      }
      this._townDressing(B, town, rnd);
      B.build(this._mats, this.group, { ao: this._heightFn });
      await this._breathe();
    }
  }

  /** Everything a town has that is not a building. */
  _townDressing(B, town, rnd) {
    const place = (x, y, z, ry = 0, rz = 0) => {
      _obj.position.set(x, y, z);
      _obj.rotation.set(0, ry, rz);
      _obj.scale.set(1, 1, 1);
      return _obj;
    };
    const H = (x, z) => this._height(x, z);
    switch (town.id) {
      case 'reedwater': this._dressReedwater(B, place, H, rnd); break;
      case 'grimscar': this._dressGrimscar(B, place, H, rnd); break;
      case 'st-ceolwine': this._dressAbbey(B, place, H, rnd); break;
      case 'blackmarch': this._dressBlackmarch(B, place, H, rnd); break;
      case 'fenwick-cross': this._dressFenwick(B, place, H, rnd); break;
      default: break;
    }
  }

  /**
   * A boarded walkway on posts, following a centreline.
   *
   * Reedwater's whole circulation is this: there is no street over the water,
   * only jetty, and the approach to the village is the moment the ground stops
   * and the planks start. Posts go down to the bed wherever the bed is under
   * the waterline and to the ground where it is not, so the same function
   * builds the ramp up off the bank and the stage out over the pool.
   */
  _jetty(B, pts, width, deckY) {
    const hw = width / 2;
    let run = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i];
      const [bx, bz] = pts[i + 1];
      const dx = bx - ax;
      const dz = bz - az;
      const len = Math.hypot(dx, dz);
      const yaw = MedievalWorld._yaw(dx / len, dz / len);
      const n = Math.max(1, Math.round(len / 2.2));
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        const cx = ax + dx * t;
        const cz = az + dz * t;
        _obj.position.set(cx, deckY - 0.09, cz);
        _obj.rotation.set(0, yaw, 0);
        _obj.scale.set(1, 1, 1);
        B.add('plank', boxGeo(len / n + 0.06, 0.18, width, 0.7), _obj, 0x9d7f56);
        this._rbox(cx, deckY - 0.22, cz, (len / n) / 2 + 0.05, 0.14, hw, yaw);
        run += len / n;
      }
      // Bents every ~3.4 m, plus a handrail on the outer side.
      const bents = Math.max(2, Math.round(len / 3.4));
      for (let k = 0; k <= bents; k++) {
        const t = k / bents;
        const cx = ax + dx * t;
        const cz = az + dz * t;
        const g = this._height(cx, cz);
        const ph = Math.max(0.6, deckY - g + 0.9);
        for (const s of [-1, 1]) {
          const px = cx - (dz / len) * s * (hw - 0.18);
          const pz = cz + (dx / len) * s * (hw - 0.18);
          _obj.position.set(px, deckY - ph / 2 - 0.1, pz);
          _obj.rotation.set(0, yaw, 0);
          B.add('beam', cylGeo(0.13, 0.17, ph, 6, 0.9), _obj, 0x6a5741);
          if (k % 2 === 0) {
            _obj.position.set(px, deckY + 0.52, pz);
            B.add('beam', cylGeo(0.07, 0.08, 1.05, 5, 1.1), _obj, 0x7a6144);
          }
        }
      }
      for (const s of [-1, 1]) {
        const mx = (ax + bx) / 2 - (dz / len) * s * (hw - 0.18);
        const mz = (az + bz) / 2 + (dx / len) * s * (hw - 0.18);
        _obj.position.set(mx, deckY + 0.98, mz);
        _obj.rotation.set(0, yaw, 0);
        B.add('beam', boxGeo(len, 0.08, 0.06, 1.2), _obj, 0x7a6144);
      }
      this._footprints.push({
        x: (ax + bx) / 2, z: (az + bz) / 2, hx: len / 2 + 0.5, hz: hw + 0.5,
        r: -yaw,
      });
    }
    return run;
  }

  /**
   * Reedwater: jetties, drying racks, traps, nets and upturned boats.
   *
   * The brief for this village is "the approach should feel like arriving at
   * water", and that is a circulation problem before it is a prop problem: the
   * strand road stops on the bank, a ramp takes you up onto a deck, and from
   * there every door is over the pool. The props are what makes the deck read
   * as a place of work rather than a pier - a fishing village is defined by
   * the things that are DRYING in it.
   */
  _dressReedwater(B, place, H, rnd) {
    const deck = REEDWATER_DECK;
    for (const j of REEDWATER_JETTIES) this._jetty(B, j.pts, j.w, deck);
    // The ramp off the bank onto the spine.
    {
      /* The ramp lands at z = 119, not 122: the strand road runs through
       * z = 121.7 at this x, and a flight of 3.4 m timber steps laid across
       * a cobbled carriageway is a z-fight and a trip hazard. */
      const bx = -360;
      const bz = 119;
      const g = H(bx, bz);
      const steps = Math.max(2, Math.ceil((deck - g) / 0.34));
      for (let i = 0; i < steps; i++) {
        const y = g + ((i + 1) / steps) * (deck - g);
        B.add('plank', boxGeo(3.4, 0.5, 0.85, 0.7), place(bx, y - 0.25, bz - i * 0.85), 0x9d7f56);
        this._rbox(bx, y - 0.25, bz - i * 0.85, 1.7, 0.25, 0.42, 0);
      }
    }
    // The Greyoak stage: a dead-end plank walk out to the gravel bar. See the
    // note in RoadNet.js for why it is not a crossing.
    {
      const g = GREYOAK_STAGE;
      const pts = [];
      const n = 8;
      for (let i = 0; i <= n; i++) pts.push([g.x, g.fromZ + ((g.toZ - g.fromZ) * i) / n]);
      this._jetty(B, pts, g.width, g.deckY);
      for (let i = 0; i < 5; i++) {
        const x = g.x + (rnd() - 0.5) * 5;
        const z = g.toZ - 2 - rnd() * 8;
        B.add('beam', cylGeo(0.06, 0.06, 1.5, 5, 1.2), place(x, H(x, z) + 0.7, z, 0, (rnd() - 0.5) * 0.4), 0x7a6144);
      }
    }
    // Drying racks: two rows of forked posts with nets slung between them.
    for (const [rx, rz, ry] of [[-350, 126, 0.16], [-368, 130, 0.2], [-334, 118, 0.1]]) {
      const y = H(rx, rz);
      for (let i = -2; i <= 2; i++) {
        const px = rx + i * 2.1 * Math.cos(ry);
        const pz = rz + i * 2.1 * Math.sin(ry);
        B.add('beam', cylGeo(0.08, 0.10, 2.6, 5, 1.0), place(px, H(px, pz) + 1.3, pz), 0x7a6144);
      }
      for (const h of [2.35, 1.7]) {
        B.add('beam', boxGeo(8.6, 0.06, 0.06, 1.2), place(rx, y + h, rz, ry), 0x7a6144);
      }
      for (let i = 0; i < 7; i++) {
        const t = (i / 6 - 0.5) * 8.0;
        B.add('canopy', planeGeo(1.05, 1.5, 1.4),
          place(rx + t * Math.cos(ry), y + 1.55, rz + t * Math.sin(ry), ry + Math.PI / 2), 0x8e9a76);
      }
      this._contacts.push(rx, y, rz, 4.4);
    }
    // Fish traps, creels and floats stacked on the bank.
    for (let i = 0; i < 22; i++) {
      const x = -394 + rnd() * 66;
      const z = 116 + rnd() * 16;
      if (H(x, z) < WATER_Y + 0.2) continue;
      const y = H(x, z);
      const kind = rnd();
      if (kind < 0.45) {
        B.add('hay', cylGeo(0.3, 0.42, 0.85, 8, 1.2), place(x, y + 0.42, z, rnd() * TAU, (rnd() - 0.5) * 0.5), 0xbfa46c);
      } else if (kind < 0.75) {
        B.add('plank', cylGeo(0.36, 0.36, 0.6, 10, 1.0), place(x, y + 0.3, z, rnd() * TAU), 0x8f6f47);
      } else {
        B.add('canopy', boxGeo(0.9, 0.4, 0.7, 1.6), place(x, y + 0.2, z, rnd() * TAU), 0x9aa47e);
      }
      this._contacts.push(x, y, z, 0.7);
    }
    // Upturned boats on the strand.
    for (const [x, z, r] of [[-382, 122, 0.5], [-340, 114, 2.2], [-364, 136, 1.1], [-326, 120, 2.8]]) {
      const y = H(x, z);
      const hull = new THREE.SphereGeometry(1.0, 12, 6, 0, TAU, 0, Math.PI / 2);
      hull.scale(1.0, 0.52, 2.9);
      MedievalWorld._uvScale(hull, 0.6);
      B.add('plank', hull, place(x, y + 0.55, z, r, Math.PI), 0x8a6f4c);
      B.add('beam', boxGeo(0.12, 0.12, 5.4, 1.2), place(x, y + 0.6, z, r), 0x6f5940);
      this._box(x, y + 0.3, z, 1.1, 0.5, 2.9);
      this._contacts.push(x, y, z, 3.0);
      // Oars leaning on the hull.
      for (let k = 0; k < 2; k++) {
        B.add('beam', cylGeo(0.05, 0.07, 2.9, 5, 1.2),
          place(x + 1.2 + k * 0.3, y + 1.1, z, r, 0.42), 0x8a6c4a);
      }
    }
    // Floats and a coil of rope on the jetty head.
    for (let i = 0; i < 12; i++) {
      const x = -370 + (rnd() - 0.5) * 8;
      const z = 90 + (rnd() - 0.5) * 10;
      B.add('plank', cylGeo(0.18, 0.18, 0.28, 8, 1.4), place(x, deck + 0.14, z, rnd() * TAU), 0x9a7a50);
    }
  }

  /**
   * Grimscar: the headframe, the adit, the tramway and the tip.
   *
   * A mining town is a MACHINE, and the machine is what has to read from the
   * vale floor: a timber headframe on the skyline above a black tip is
   * legible at four hundred metres in a way that a street of cottages is not.
   * So the headframe is thirteen metres tall, the tip spills over the bench's
   * eastern lip where the ground already falls away, and the tramway that
   * joins them runs straight past the winding house's doors.
   */
  _dressGrimscar(B, place, H, rnd) {
    const W = GRIMSCAR_WORKINGS;
    /* ---- Headframe: two A-frames, a sheave and a shaft collar ------- */
    const hf = W.headframe;
    const gy = H(hf.x, hf.z);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const lean = 0.19;
        B.add('beam', cylGeo(0.19, 0.26, hf.h, 6, 0.9),
          place(hf.x + sx * hf.legHalf * 0.55, gy + hf.h / 2, hf.z + sz * hf.legHalf * 0.55,
            0, 0), 0x5f4c37);
        // Rake each leg outward at the foot.
        B.add('beam', cylGeo(0.14, 0.2, hf.h * 0.62, 6, 0.9),
          place(hf.x + sx * hf.legHalf, gy + hf.h * 0.31, hf.z + sz * hf.legHalf, 0,
            sx * lean), 0x5f4c37);
      }
    }
    for (let i = 1; i <= 4; i++) {
      const y = gy + (i / 5) * hf.h;
      const k = 1 - (i / 5) * 0.35;
      for (const sz of [-1, 1]) {
        B.add('beam', boxGeo(hf.legHalf * 2.2 * k, 0.14, 0.14, 1.2),
          place(hf.x, y, hf.z + sz * hf.legHalf * 0.55 * k), 0x6a5741);
      }
      for (const sx of [-1, 1]) {
        B.add('beam', boxGeo(0.14, 0.14, hf.legHalf * 1.6 * k, 1.2),
          place(hf.x + sx * hf.legHalf * 0.55 * k, y, hf.z), 0x6a5741);
      }
    }
    // Sheave wheel at the head, and the rope down the shaft.
    {
      const ring = new THREE.TorusGeometry(1.35, 0.14, 6, 20);
      MedievalWorld._uvScale(ring, 0.5);
      B.add('iron', ring, place(hf.x, gy + hf.h + 0.9, hf.z, Math.PI / 2), 0x3a3128);
      B.add('iron', cylGeo(0.16, 0.16, 1.6, 8, 1.0), place(hf.x, gy + hf.h + 0.9, hf.z, 0, Math.PI / 2), 0x3a3128);
      B.add('iron', cylGeo(0.04, 0.04, hf.h + 0.6, 4, 2.0), place(hf.x, gy + (hf.h + 0.6) / 2, hf.z), 0x2c2722);
      // Shaft collar: a timbered mouth with a windlass beside it.
      B.add('beam', boxGeo(3.0, 0.55, 3.0, 0.8), place(hf.x, gy + 0.28, hf.z), 0x6f5940);
      B.add('rock', boxGeo(2.2, 0.4, 2.2, 0.8), place(hf.x, gy + 0.02, hf.z), 0x2a2723);
      this._box(hf.x, gy + 0.28, hf.z, 1.5, 0.3, 1.5);
      B.add('beam', cylGeo(0.34, 0.34, 2.2, 10, 0.9),
        place(hf.x + 3.2, gy + 1.0, hf.z, 0, Math.PI / 2), 0x7a6144);
      for (const s of [-1, 1]) {
        B.add('beam', boxGeo(0.22, 1.9, 0.22, 1.1), place(hf.x + 3.2, gy + 0.95, hf.z + s * 1.3), 0x6a5741);
      }
      this._box(hf.x + 3.2, gy + 1.0, hf.z, 0.6, 1.0, 1.5);
      this._contacts.push(hf.x, gy, hf.z, 4.5);
    }

    /* ---- Adit: a timbered portal cut into the scarp face ------------- */
    {
      const a = W.adit;
      const ay = H(a.x, a.z);
      const hwid = a.w / 2;
      // Retaining wall either side, so the portal reads as cut rather than
      // stuck on: the face here climbs 10.7 m in 8 m, which is what makes an
      // adit believable at all.
      for (const s of [-1, 1]) {
        B.add('rubble', boxGeo(2.6, 4.4, 2.4, 0.55),
          place(a.x - 0.6, ay + 1.4, a.z + s * (hwid + 1.2)), 0x6a635b);
      }
      B.add('rubble', boxGeo(3.0, 1.5, a.w + 4.0, 0.55), place(a.x - 0.6, ay + a.h + 0.6, a.z), 0x625d57);
      // The timber sett: two legs and a cap, then a black mouth behind it.
      for (const s of [-1, 1]) {
        B.add('beam', boxGeo(0.36, a.h, 0.42, 1.0), place(a.x + 0.4, ay + a.h / 2, a.z + s * hwid), 0x5f4c37);
      }
      B.add('beam', boxGeo(0.42, 0.42, a.w + 0.9, 1.0), place(a.x + 0.4, ay + a.h + 0.2, a.z), 0x5f4c37);
      B.add('rock', boxGeo(0.4, a.h, a.w, 1.0), place(a.x - 1.4, ay + a.h / 2, a.z), 0x171512);
      this._box(a.x - 1.4, ay + a.h / 2, a.z, 0.4, a.h / 2, a.w / 2);
      // A lamp on the sett, and the drainage launder running out of the mouth.
      B.add('ember', boxGeo(0.16, 0.2, 0.16, 2.0), place(a.x + 0.5, ay + a.h - 0.4, a.z + hwid - 0.2), 0xffb060);
      this._addGlow(a.x + 1.4, ay + 1.0, a.z, 4.0, 0x4a2a12);
      /* The drainage launder, on the NORTH cheek of the mouth. It used to run
       * out of the south cheek, which is the side the tramway now leaves on -
       * a 7 m plank trough laid across the rails. Water off an adit runs
       * wherever the invert is cut, so the side is free and the track is not. */
      B.add('plank', boxGeo(7.0, 0.16, 0.5, 0.8), place(a.x + 4.0, ay + 0.12, a.z + hwid + 0.5), 0x8a6f4c);
    }

    /* ---- Tramway: sleepers, rails and standing ore carts ------------- */
    {
      const pts = W.tramway;
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, az] = pts[i];
        const [bx, bz] = pts[i + 1];
        const dx = bx - ax;
        const dz = bz - az;
        const len = Math.hypot(dx, dz);
        const yaw = MedievalWorld._yaw(dx / len, dz / len);
        const n = Math.max(2, Math.round(len / 0.9));
        for (let k = 0; k < n; k++) {
          const t = (k + 0.5) / n;
          const cx = ax + dx * t;
          const cz = az + dz * t;
          B.add('beam', boxGeo(0.5, 0.12, 1.5, 1.0), place(cx, H(cx, cz) + 0.06, cz, yaw), 0x5f4c37);
        }
        for (const s of [-1, 1]) {
          const mx = (ax + bx) / 2 - (dz / len) * s * 0.42;
          const mz = (az + bz) / 2 + (dx / len) * s * 0.42;
          B.add('iron', boxGeo(len, 0.08, 0.07, 1.6), place(mx, H(mx, mz) + 0.17, mz, yaw), 0x4a4038);
        }
      }
      /* Two carts, one loaded, one tipped on its side by the tip head.
       *
       * The loaded one stood at (-364, -192), which is 1.5 m off the winding
       * house's front wall - so once that door got the flight of steps its
       * 2.03 m sill has always needed, the cart was standing IN them, poking
       * 72 cm through a course. Moved down the tramway to the stretch between
       * the headframe and the tip, where a full cart waiting to be run out
       * belongs anyway. */
      for (const [cx, cz, tipped] of [[-353.5, -191.3, 0], [-347, -190.5, 1]]) {
        const y = H(cx, cz);
        const rz = tipped ? 1.35 : 0;
        B.add('plank', boxGeo(1.5, 0.95, 1.05, 0.8), place(cx, y + 0.62, cz, 0.1, rz), 0x7c6242);
        B.add('iron', boxGeo(1.6, 0.1, 1.15, 1.4), place(cx, y + 1.1, cz, 0.1, rz), 0x4a4038);
        if (!tipped) B.add('rock', boxGeo(1.3, 0.4, 0.9, 1.4), place(cx, y + 1.12, cz, 0.1), 0x2e2a25);
        for (const s of [-1, 1]) {
          const wheel = new THREE.TorusGeometry(0.3, 0.07, 5, 12);
          MedievalWorld._uvScale(wheel, 0.6);
          B.add('iron', wheel, place(cx, y + 0.3, cz + s * 0.56, 0.1), 0x4a4038);
        }
        this._box(cx, y + 0.6, cz, 0.9, 0.6, 0.7);
        this._contacts.push(cx, y, cz, 1.3);
      }
    }

    /* ---- Spoil ------------------------------------------------------- *
     * Cones of crushed shale, dark and angular. Placed on the bench's lip so
     * they spill over it rather than sitting on the shelf like slag hats. */
    for (const heap of [...W.heaps, { x: W.tip.x, z: W.tip.z, r: W.tip.r, h: 4.2 }]) {
      const y = H(heap.x, heap.z);
      const g = coneGeo(heap.r, heap.h, 12, 0.8);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const n = 1 + perlin2(p.getX(i) * 0.9 + heap.x, p.getZ(i) * 0.9 + heap.z) * 0.22;
        p.setXYZ(i, p.getX(i) * n, p.getY(i), p.getZ(i) * n);
      }
      g.computeVertexNormals();
      B.add('rock', g, place(heap.x, y + heap.h / 2 - 0.6, heap.z, rnd() * TAU), 0x3a352e);
      this._box(heap.x, y + heap.h * 0.3, heap.z, heap.r * 0.55, heap.h * 0.4, heap.r * 0.55);
      this._contacts.push(heap.x, y, heap.z, heap.r);
      // Loose shale skirting the foot.
      for (let i = 0; i < 10; i++) {
        const a = rnd() * TAU;
        const rr = heap.r * (0.85 + rnd() * 0.5);
        const sx = heap.x + Math.cos(a) * rr;
        const sz = heap.z + Math.sin(a) * rr;
        B.add('rock', boxGeo(0.5 + rnd() * 0.5, 0.22, 0.4 + rnd() * 0.4, 1.2),
          place(sx, H(sx, sz) + 0.08, sz, rnd() * TAU, (rnd() - 0.5) * 0.4), 0x413b33);
      }
    }
    // Pit props, stacked timber and a water butt outside the winding house.
    for (let i = 0; i < 14; i++) {
      const x = -376 + rnd() * 6;
      const z = -204 + rnd() * 8;
      B.add('beam', cylGeo(0.13, 0.15, 2.4, 6, 1.0),
        place(x, H(x, z) + 0.14 + (i % 4) * 0.28, z, 0.2 + (i % 3) * 0.1, Math.PI / 2), 0x7a6144);
    }
  }

  /**
   * St Ceolwine's: the precinct wall, the cloister arcade, the garth, the
   * herb beds and the stew pond.
   *
   * The abbey's silhouette is not its church - it is the WALL. Everything
   * else in the vale is approached across open ground; this is approached
   * along an eighty-metre blank face with one gate in it, and the cloister
   * behind it is the only enclosed outdoor room in the world.
   */
  _dressAbbey(B, place, H, rnd) {
    const P = CEOLWINE_PRECINCT;
    const G = CEOLWINE_GARTH;
    /* ---- Precinct wall ---------------------------------------------- */
    const runWall = (x0, z0, x1, z1, gap) => {
      const dx = x1 - x0;
      const dz = z1 - z0;
      const len = Math.hypot(dx, dz);
      const yaw = MedievalWorld._yaw(dx / len, dz / len);
      const n = Math.max(2, Math.round(len / 3.0));
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        const cx = x0 + dx * t;
        const cz = z0 + dz * t;
        if (gap && Math.hypot(cx - gap.x, cz - gap.z) < gap.w) continue;
        const y = H(cx, cz);
        B.add('ashlar', boxGeo(len / n + 0.05, P.wallH, P.wallT, 0.5),
          place(cx, y + P.wallH / 2, cz, yaw), 0xcfc7b2);
        B.add('slate', boxGeo(len / n + 0.05, 0.16, P.wallT + 0.24, 0.8),
          place(cx, y + P.wallH + 0.08, cz, yaw), 0x9aa4b0);
        this._rbox(cx, y + P.wallH / 2, cz, (len / n) / 2 + 0.05, P.wallH / 2, P.wallT / 2, -yaw);
      }
    };
    runWall(P.x - P.hx, P.z - P.hz, P.x + P.hx, P.z - P.hz, { x: P.gate.x, z: P.gate.z, w: 6.0 });
    runWall(P.x - P.hx, P.z + P.hz, P.x + P.hx, P.z + P.hz, null);
    runWall(P.x - P.hx, P.z - P.hz, P.x - P.hx, P.z + P.hz, null);
    runWall(P.x + P.hx, P.z - P.hz, P.x + P.hx, P.z + P.hz, null);

    /* ---- Cloister arcade -------------------------------------------- *
     * Four covered walks round the garth: a dwarf wall, paired shafts, a
     * scalloped capital and a lean-to roof back to the ranges. */
    const walk = G.walkW;
    for (let side = 0; side < 4; side++) {
      const along = side < 2 ? G.hx : G.hz;
      const outAxis = side < 2 ? G.hz : G.hx;
      const sgn = side % 2 === 0 ? 1 : -1;
      const n = Math.max(4, Math.round((along * 2) / 2.2));
      for (let i = 0; i <= n; i++) {
        const t = (i / n - 0.5) * along * 2;
        const cx = side < 2 ? G.x + t : G.x + sgn * outAxis;
        const cz = side < 2 ? G.z + sgn * outAxis : G.z + t;
        const y = H(cx, cz);
        B.add('ashlar', boxGeo(0.42, 0.66, 0.42, 0.7), place(cx, y + 0.33, cz), 0xc9c1ad);
        for (const s of [-0.13, 0.13]) {
          const px = side < 2 ? cx + s : cx;
          const pz = side < 2 ? cz : cz + s;
          B.add('ashlar', cylGeo(0.12, 0.13, 1.85, 8, 0.9), place(px, y + 1.6, pz), 0xd6cfbc);
        }
        B.add('ashlar', boxGeo(0.46, 0.24, 0.46, 0.8), place(cx, y + 2.62, cz), 0xc9c1ad);
        this._box(cx, y + 1.3, cz, 0.24, 1.3, 0.24);
      }
      // Lean-to roof over the walk.
      const ry = H(G.x, G.z) + 3.35;
      const rw2 = side < 2 ? along * 2 + walk : walk;
      const rd2 = side < 2 ? walk : along * 2 + walk;
      const cxr = side < 2 ? G.x : G.x + sgn * (outAxis + walk / 2);
      const czr = side < 2 ? G.z + sgn * (outAxis + walk / 2) : G.z;
      B.add('slate', boxGeo(rw2, 0.2, rd2, 0.7),
        place(cxr, ry, czr, 0, side < 2 ? sgn * -0.24 : 0), 0xa8b2be);
      // Flagged walk under it.
      B.add('flagstone', boxGeo(rw2 - 0.2, 0.12, rd2 - 0.2, 0.55),
        place(cxr, H(cxr, czr) + 0.09, czr), 0xb8b2a4);
    }
    /* ---- The garth: turf, a well, and a path across it --------------- */
    {
      const wy = H(G.x, G.z);
      B.add('flagstone', boxGeo(1.4, 0.9, 1.4, 0.6), place(G.x, wy + 0.45, G.z), 0xb8b2a4);
      B.add('ashlar', cylGeo(0.95, 1.0, 0.9, 12, 0.7), place(G.x, wy + 0.9, G.z), 0xcfc7b2);
      for (const s of [-1, 1]) {
        B.add('beam', boxGeo(0.16, 2.4, 0.16, 1.1), place(G.x + s * 0.9, wy + 2.1, G.z), 0x6f5940);
      }
      B.add('slate', coneGeo(1.5, 0.9, 4, 0.7), place(G.x, wy + 3.6, G.z, Math.PI / 4), 0x9aa4b0);
      B.add('beam', cylGeo(0.16, 0.16, 1.9, 8, 0.9), place(G.x, wy + 3.0, G.z, 0, Math.PI / 2), 0x7a6144);
      this._box(G.x, wy + 0.6, G.z, 1.0, 0.6, 1.0);
      this._contacts.push(G.x, wy, G.z, 1.9);
      for (const [ax, az, bx, bz] of [
        [G.x, G.z - G.hz, G.x, G.z + G.hz], [G.x - G.hx, G.z, G.x + G.hx, G.z],
      ]) {
        const n = Math.round(Math.hypot(bx - ax, bz - az) / 1.2);
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) / n;
          const cx = ax + (bx - ax) * t;
          const cz = az + (bz - az) * t;
          B.add('flagstone', boxGeo(1.25, 0.1, 1.25, 0.55), place(cx, H(cx, cz) + 0.07, cz), 0xb0aa9c);
        }
      }
    }
    /* ---- Herb beds --------------------------------------------------- */
    for (const [bx, bz, bhx, bhz] of CEOLWINE_HERBS) {
      const y = H(bx, bz);
      for (const [ox, oz, sx, sz] of [
        [0, -bhz, bhx, 0.14], [0, bhz, bhx, 0.14], [-bhx, 0, 0.14, bhz], [bhx, 0, 0.14, bhz],
      ]) {
        B.add('plank', boxGeo(sx * 2 + 0.28, 0.5, sz * 2 + 0.28, 0.8),
          place(bx + ox, y + 0.25, bz + oz), 0x7c6242);
      }
      B.add('rock', boxGeo(bhx * 2, 0.34, bhz * 2, 0.9), place(bx, y + 0.2, bz), 0x4a4034);
      const rows = Math.max(2, Math.round(bhx));
      for (let i = 0; i < rows * 3; i++) {
        const px = bx + ((i % rows) / Math.max(1, rows - 1) - 0.5) * (bhx * 1.7);
        const pz = bz + (((i / rows) | 0) / 2 - 0.5) * (bhz * 1.5);
        B.add('leaf', boxGeo(0.42, 0.38, 0.42, 5.0), place(px, y + 0.6, pz, rnd() * TAU), 0x8fae66);
      }
      this._box(bx, y + 0.25, bz, bhx + 0.15, 0.25, bhz + 0.15);
    }
    /* ---- Stew pond --------------------------------------------------- */
    {
      const p = CEOLWINE_POND;
      const y = H(p.x, p.z);
      B.add('rock', boxGeo(p.hx * 2, 0.6, p.hz * 2, 0.7), place(p.x, y - 0.5, p.z), 0x4a4438);
      /* Not the river's shader material: it carries its own attributes and its
       * own flow uniforms, and a merged batch would hand it geometry it cannot
       * read. A still stew pond wants a dark flat plane anyway. */
      B.add('slate', boxGeo(p.hx * 2 - 0.5, 0.08, p.hz * 2 - 0.5, 0.5), place(p.x, y - 0.22, p.z), 0x35414a);
      for (const [ox, oz, sx, sz] of [
        [0, -p.hz, p.hx + 0.4, 0.4], [0, p.hz, p.hx + 0.4, 0.4],
        [-p.hx, 0, 0.4, p.hz], [p.hx, 0, 0.4, p.hz],
      ]) {
        B.add('ashlar', boxGeo(sx * 2, 0.5, sz * 2, 0.6), place(p.x + ox, y + 0.05, p.z + oz), 0xc9c1ad);
        this._box(p.x + ox, y + 0.05, p.z + oz, sx, 0.25, sz);
      }
      this._footprints.push({ x: p.x, z: p.z, hx: p.hx + 1, hz: p.hz + 1, r: 0 });
    }
    /* Beehives along the west range, inside the wall.
     *
     * Inside, because the precinct's north-south extent is z = 298..386 and
     * the first cut of these stood at z = 388 - two metres outside their own
     * abbey, which is a thing no screenshot would ever have shown. */
    for (let i = 0; i < 5; i++) {
      const x = -330;
      const z = 340 + i * 3.0;
      B.add('hay', cylGeo(0.32, 0.46, 0.66, 10, 1.2), place(x, H(x, z) + 0.33, z), 0xcbb277);
      this._contacts.push(x, H(x, z), z, 0.7);
    }
  }

  /**
   * Blackmarch Hold: the palisade, its fighting walk, the gate towers over the
   * neck, the muster yard and the beacon.
   *
   * The one thing this town has to communicate is EXPOSURE. The wall is
   * therefore built as it would be: posts driven, not a fence - a continuous
   * line of split trunks with a walk behind at 2.55 m, which is head height
   * for a man on the ground outside and chest height for one behind it.
   */
  _dressBlackmarch(B, place, H, rnd) {
    const P = BLACKMARCH_PALISADE;
    const runs = [
      [P.x0, P.z0, P.x1, P.z0], [P.x0, P.z1, P.x1, P.z1],
      [P.x0, P.z0, P.x0, P.z1], [P.x1, P.z0, P.x1, P.z1],
    ];
    for (const [x0, z0, x1, z1] of runs) {
      const dx = x1 - x0;
      const dz = z1 - z0;
      const len = Math.hypot(dx, dz);
      const yaw = MedievalWorld._yaw(dx / len, dz / len);
      const n = Math.round(len / P.spacing);
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        const cx = x0 + dx * t;
        const cz = z0 + dz * t;
        // The gate: leave the opening, but keep the towers' own posts.
        if (Math.hypot(cx - P.gate.x, cz - P.gate.z) < P.gate.w / 2) continue;
        const y = H(cx, cz);
        const h = P.postH * (0.94 + ((i * 37) % 13) / 100);
        B.add('beam', cylGeo(P.postR * 0.85, P.postR, h, 6, 0.9),
          place(cx, y + h / 2 - 0.3, cz), shadeHex(0x7c6242, 0.86 + ((i * 17) % 9) / 30));
        // Sharpened head.
        B.add('beam', coneGeo(P.postR, 0.44, 6, 0.9), place(cx, y + h - 0.08, cz), 0x6f5940);
      }
      // The fighting walk and its rail, on the inside face.
      const nx = -(dz / len);
      const nz = dx / len;
      const inward = ((P.x0 + P.x1) / 2 - (x0 + x1) / 2) * nx + ((P.z0 + P.z1) / 2 - (z0 + z1) / 2) * nz;
      const s = inward >= 0 ? 1 : -1;
      const wx = (x0 + x1) / 2 + nx * s * (P.walkW / 2 + 0.3);
      const wz = (z0 + z1) / 2 + nz * s * (P.walkW / 2 + 0.3);
      const wy = H(wx, wz) + P.walkY;
      B.add('plank', boxGeo(len, 0.22, P.walkW, 0.7), place(wx, wy, wz, yaw), 0x8a6f4c);
      this._rbox(wx, wy - 0.11, wz, len / 2, 0.14, P.walkW / 2, -yaw);
      const posts = Math.max(3, Math.round(len / 2.6));
      for (let i = 0; i <= posts; i++) {
        const t = i / posts;
        const px = x0 + dx * t + nx * s * (P.walkW / 2 + 0.3);
        const pz = z0 + dz * t + nz * s * (P.walkW / 2 + 0.3);
        const py = H(px, pz);
        B.add('beam', cylGeo(0.14, 0.18, P.walkY + 0.2, 6, 0.9), place(px, py + (P.walkY + 0.2) / 2, pz), 0x6f5940);
        B.add('beam', cylGeo(0.09, 0.09, 1.05, 5, 1.1), place(px, py + P.walkY + 0.55, pz), 0x7a6144);
      }
      B.add('beam', boxGeo(len, 0.08, 0.08, 1.2), place(wx, wy + 1.05, wz, yaw), 0x7a6144);
      this._footprints.push({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, hx: len / 2 + 1, hz: 2.4, r: -yaw });
    }
    // Ladders up to the walk.
    for (const [lx, lz] of [[330, -226], [330, -178], [366, -226]]) {
      const y = H(lx, lz);
      for (const s of [-0.3, 0.3]) {
        B.add('beam', boxGeo(0.11, P.walkY + 0.5, 0.11, 1.2), place(lx + s, y + (P.walkY + 0.5) / 2, lz, 0, 0.16), 0x7a6144);
      }
      for (let i = 0; i < 6; i++) {
        B.add('beam', boxGeo(0.7, 0.07, 0.07, 1.2), place(lx, y + 0.3 + i * 0.42, lz), 0x8a6c4a);
      }
      this._box(lx, y + P.walkY / 2, lz, 0.5, P.walkY / 2, 0.5);
    }
    /* ---- Towers ------------------------------------------------------ */
    for (const t of P.towers) {
      const y = H(t.x, t.z);
      const seg = 8;
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * TAU;
        B.add('beam', cylGeo(0.2, 0.24, t.h, 6, 0.9),
          place(t.x + Math.cos(a) * t.r, y + t.h / 2, t.z + Math.sin(a) * t.r), 0x6f5940);
      }
      this._ringWall(t.x, y + t.h / 2, t.z, t.r, t.h / 2, 0.3, 8);
      B.add('plank', cylGeo(t.r + 0.7, t.r + 0.7, 0.24, 10, 0.7), place(t.x, y + t.h * 0.66, t.z), 0x8a6f4c);
      B.add('plank', coneGeo(t.r + 1.0, 1.9, 8, 0.7), place(t.x, y + t.h + 0.95, t.z), 0x6a5540);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU;
        B.add('beam', boxGeo(0.24, 0.85, 0.24, 1.1),
          place(t.x + Math.cos(a) * (t.r + 0.5), y + t.h * 0.66 + 0.55, t.z + Math.sin(a) * (t.r + 0.5)), 0x7a6144);
      }
      this._contacts.push(t.x, y, t.z, t.r + 1.2);
    }
    // The gate itself: a pair of leaves under a walk, with a banner over it.
    {
      const gx = P.gate.x;
      const gz = P.gate.z;
      const y = H(gx, gz);
      B.add('beam', boxGeo(0.9, 5.6, 0.5, 1.0), place(gx, y + 2.8, gz - P.gate.w / 2), 0x5f4c37);
      B.add('beam', boxGeo(0.9, 5.6, 0.5, 1.0), place(gx, y + 2.8, gz + P.gate.w / 2), 0x5f4c37);
      B.add('beam', boxGeo(1.1, 0.6, P.gate.w + 1.4, 1.0), place(gx, y + 5.4, gz), 0x5f4c37);
      B.add('plank', boxGeo(0.35, 4.4, P.gate.w - 0.2, 0.8), place(gx, y + 2.2, gz), 0x7c6242);
      for (const yy of [1.2, 3.2]) {
        B.add('iron', boxGeo(0.42, 0.16, P.gate.w - 0.3, 1.6), place(gx, y + yy, gz), 0x3a3128);
      }
      this._rbox(gx, y + 2.2, gz, 0.4, 2.2, P.gate.w / 2, 0);
      B.add('banner', planeGeo(1.6, 2.6, 1.0), place(gx - 0.7, y + 3.9, gz), 0x2f2723);
      this._addGlow(gx + 1.4, y + 0.1, gz, 5.0, 0x4a2a12);
      for (const s of [-1, 1]) {
        B.add('iron', boxGeo(0.22, 0.3, 0.22, 1.6), place(gx + 0.9, y + 3.0, gz + s * (P.gate.w / 2 - 0.3)), 0x2f2924);
        B.add('ember', boxGeo(0.13, 0.18, 0.13, 2.0), place(gx + 0.9, y + 3.0, gz + s * (P.gate.w / 2 - 0.3)), 0xffc074);
      }
    }
    /* ---- Muster yard ------------------------------------------------- */
    {
      const Y = BLACKMARCH_YARD;
      for (let i = 0; i < 26; i++) {
        const x = Y.x + (rnd() - 0.5) * Y.hx * 2;
        const z = Y.z + (rnd() - 0.5) * Y.hz * 2;
        B.add('rock', boxGeo(0.5 + rnd() * 0.5, 0.14, 0.4 + rnd() * 0.4, 1.2),
          place(x, H(x, z) + 0.05, z, rnd() * TAU), 0x6a6156);
      }
      // Weapon racks, pells and a quintain.
      for (const [rx, rz, ry] of [[Y.x - 7, Y.z + 6, 0.2], [Y.x + 6, Y.z - 7, 1.4]]) {
        const y = H(rx, rz);
        for (const s of [-1, 1]) {
          B.add('beam', boxGeo(0.16, 1.7, 0.16, 1.1), place(rx + s * 1.4 * Math.cos(ry), y + 0.85, rz + s * 1.4 * Math.sin(ry)), 0x6f5940);
        }
        B.add('beam', boxGeo(3.2, 0.12, 0.12, 1.2), place(rx, y + 1.55, rz, ry), 0x7a6144);
        for (let i = 0; i < 5; i++) {
          const t = (i / 4 - 0.5) * 2.6;
          B.add('beam', cylGeo(0.045, 0.05, 2.2, 5, 1.2),
            place(rx + t * Math.cos(ry), y + 1.1, rz + t * Math.sin(ry), ry, 0.12), 0x8a6c4a);
          B.add('iron', coneGeo(0.07, 0.28, 5, 1.2), place(rx + t * Math.cos(ry), y + 2.2, rz + t * Math.sin(ry)), 0x4a4038);
        }
        this._box(rx, y + 0.85, rz, 1.6, 0.85, 0.3);
        this._contacts.push(rx, y, rz, 1.8);
      }
      for (let i = 0; i < 3; i++) {
        const px = Y.x - 2 + i * 3.4;
        const pz = Y.z + 9;
        const y = H(px, pz);
        B.add('beam', cylGeo(0.2, 0.26, 2.0, 8, 0.9), place(px, y + 1.0, pz), 0x6a5540);
        B.add('iron', boxGeo(0.5, 0.5, 0.12, 1.4), place(px, y + 1.7, pz), 0x4a4038);
        this._box(px, y + 1.0, pz, 0.3, 1.0, 0.3);
        this._contacts.push(px, y, pz, 0.6);
      }
    }
    /* ---- Beacon ------------------------------------------------------ */
    {
      const b = BLACKMARCH_BEACON;
      const y = H(b.x, b.z);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * TAU + 0.4;
        B.add('beam', cylGeo(0.14, 0.2, b.h, 6, 0.9),
          place(b.x + Math.cos(a) * 0.7, y + b.h / 2, b.z + Math.sin(a) * 0.7, 0, 0.1), 0x6a5540);
      }
      B.add('iron', cylGeo(b.basketR, b.basketR * 0.7, 0.9, 10, 1.0, true), place(b.x, y + b.h + 0.4, b.z), 0x3a3128);
      B.add('ember', cylGeo(b.basketR * 0.85, b.basketR * 0.6, 0.8, 10, 1.4), place(b.x, y + b.h + 0.45, b.z), 0xff9040);
      this._addGlow(b.x, y + b.h + 1.4, b.z, 9.0, 0x6a3a12);
      this._box(b.x, y + b.h / 2, b.z, 0.9, b.h / 2, 0.9);
      this._contacts.push(b.x, y, b.z, 1.6);
      this._smokeOrigins.push(b.x, y + b.h + 1.0, b.z);
      const bl = pointLight(0xffa63c, 120, 34, 2);
      bl.position.set(b.x, y + b.h + 1.2, b.z);
      this.group.add(bl);
    }
  }

  /**
   * Fenwick Cross: the market cross, the stalls, the pillory and the well.
   *
   * The thing that makes a market town a market town is that its widest space
   * is EMPTY and everything faces into it. So the dressing here is deliberately
   * concentrated round the edges of the place - stalls against the frontages,
   * the cross and the well in the middle, and nothing between them.
   */
  _dressFenwick(B, place, H, rnd) {
    const C = FENWICK_CROSS;
    /* ---- The market cross -------------------------------------------- */
    {
      const y = H(C.x, C.z);
      for (let i = 0; i < C.steps; i++) {
        const k = C.steps - i;
        B.add('ashlar', boxGeo(k * 1.5, 0.32, k * 1.5, 0.6), place(C.x, y + 0.16 + i * 0.32, C.z), 0xcfc7b2);
        this._box(C.x, y + 0.16 + i * 0.32, C.z, (k * 1.5) / 2, 0.16, (k * 1.5) / 2);
      }
      const baseY = y + C.steps * 0.32;
      B.add('ashlar', boxGeo(0.9, 0.5, 0.9, 0.7), place(C.x, baseY + 0.25, C.z), 0xc9c1ad);
      B.add('ashlar', cylGeo(0.26, 0.34, C.h - 1.4, 8, 0.8), place(C.x, baseY + 0.5 + (C.h - 1.4) / 2, C.z), 0xd6cfbc);
      B.add('ashlar', boxGeo(0.62, 0.62, 0.62, 0.9), place(C.x, baseY + C.h - 0.7, C.z), 0xc9c1ad);
      B.add('ashlar', boxGeo(1.5, 0.22, 0.34, 1.0), place(C.x, baseY + C.h - 0.2, C.z), 0xd6cfbc);
      B.add('ashlar', boxGeo(0.34, 1.1, 0.34, 1.0), place(C.x, baseY + C.h + 0.2, C.z), 0xd6cfbc);
      this._box(C.x, baseY + C.h / 2, C.z, 0.4, C.h / 2, 0.4);
      this._contacts.push(C.x, y, C.z, 3.6);
      this.minimapShapes.push({
        kind: 'rect', x: C.x, z: C.z, w: 6, d: 6, rotation: 0,
        fill: 'rgba(160,132,96,0.5)', stroke: 'rgba(240,216,168,0.95)',
      });
    }
    /* ---- Stalls: a trestle, an awning and goods on the board --------- */
    const stalls = [
      [186, 336, 0.1], [186, 342, 0.1], [186, 348, 0.1],
      [206, 336, Math.PI], [206, 342, Math.PI], [206, 348, Math.PI],
      [190, 330, -Math.PI / 2], [200, 330, -Math.PI / 2],
      [192, 356, Math.PI / 2], [202, 356, Math.PI / 2],
    ];
    for (const [sx, sz, syaw] of stalls) {
      const y = H(sx, sz);
      B.add('plank', boxGeo(2.6, 0.1, 1.1, 0.9), place(sx, y + 0.86, sz, syaw), 0x9a7a50);
      for (const s of [-1, 1]) {
        B.add('beam', boxGeo(0.12, 0.84, 0.9, 1.2), place(sx + s * 1.1 * Math.cos(syaw), y + 0.42, sz - s * 1.1 * Math.sin(syaw), syaw), 0x7a6144);
        B.add('beam', cylGeo(0.07, 0.08, 2.3, 5, 1.1), place(sx + s * 1.2 * Math.cos(syaw), y + 1.15, sz - s * 1.2 * Math.sin(syaw), syaw), 0x7a6144);
      }
      B.add('canopy', boxGeo(3.0, 0.07, 1.7, 1.4), place(sx, y + 2.3, sz, syaw, 0.14),
        [0xb02a33, 0x2a5aa8, 0xd7a63f, 0x2f7a4d][(rnd() * 4) | 0]);
      for (let i = 0; i < 5; i++) {
        const t = (i / 4 - 0.5) * 2.1;
        B.add('hay', boxGeo(0.34, 0.24, 0.34, 1.6),
          place(sx + t * Math.cos(syaw), y + 1.02, sz - t * Math.sin(syaw), rnd() * TAU), 0xcbb277);
      }
      this._box(sx, y + 0.5, sz, 1.4, 0.5, 0.7);
      this._contacts.push(sx, y, sz, 2.0);
    }
    /* ---- Well, pillory, stocks, and a heap of fleeces ---------------- */
    {
      const wx = 202;
      const wz = 334;
      const y = H(wx, wz);
      B.add('ashlar', cylGeo(0.95, 1.05, 1.0, 12, 0.7), place(wx, y + 0.5, wz), 0xc9c1ad);
      for (const s of [-1, 1]) {
        B.add('beam', boxGeo(0.15, 2.3, 0.15, 1.1), place(wx + s * 0.9, y + 1.65, wz), 0x6f5940);
      }
      B.add('slate', boxGeo(2.5, 0.14, 1.4, 0.8), place(wx, y + 2.9, wz, 0, 0.2), 0x9aa4b0);
      B.add('beam', cylGeo(0.14, 0.14, 1.8, 8, 0.9), place(wx, y + 2.5, wz, 0, Math.PI / 2), 0x7a6144);
      this._box(wx, y + 0.5, wz, 1.0, 0.5, 1.0);
      this._contacts.push(wx, y, wz, 1.9);
    }
    {
      const px = 190;
      const pz = 352;
      const y = H(px, pz);
      B.add('beam', cylGeo(0.16, 0.2, 2.6, 8, 0.9), place(px, y + 1.3, pz), 0x6f5940);
      B.add('beam', boxGeo(1.3, 0.22, 0.2, 1.1), place(px, y + 2.2, pz, 0.3), 0x7a6144);
      B.add('iron', boxGeo(0.2, 0.2, 0.16, 1.6), place(px, y + 2.05, pz, 0.3), 0x3a3128);
      this._box(px, y + 1.3, pz, 0.3, 1.3, 0.3);
      this._contacts.push(px, y, pz, 0.8);
    }
    for (let i = 0; i < 9; i++) {
      const x = 178 + rnd() * 6;
      const z = 344 + (rnd() - 0.5) * 10;
      const y = H(x, z);
      B.add('hay', boxGeo(1.0, 0.7, 0.8, 1.4), place(x, y + 0.35 + (i % 3) * 0.6, z, rnd() * TAU), 0xd8cdb0);
      this._contacts.push(x, y, z, 1.0);
    }
    // Carts drawn up on the market fringe.
    for (const [cx, cz, cyaw] of [[212, 352, 0.6], [181, 348, 2.2], [192, 357, 1.1]]) {
      const y = H(cx, cz);
      B.add('plank', boxGeo(2.6, 0.7, 1.5, 0.8), place(cx, y + 1.0, cz, cyaw), 0x8f7550);
      B.add('beam', boxGeo(3.4, 0.14, 0.14, 1.2), place(cx, y + 0.75, cz, cyaw), 0x6f5940);
      for (const s of [-1, 1]) {
        const wheel = new THREE.TorusGeometry(0.62, 0.1, 5, 14);
        MedievalWorld._uvScale(wheel, 0.6);
        B.add('plank', wheel, place(cx - Math.sin(cyaw) * s * 0.86, y + 0.62, cz - Math.cos(cyaw) * s * 0.86, cyaw), 0x7c6242);
      }
      this._box(cx, y + 0.8, cz, 1.5, 0.8, 1.0);
      this._contacts.push(cx, y, cz, 2.2);
    }
    // Bunting between the frontages, because a market is an event.
    for (const [ax, az, bx2, bz2] of [[186, 332, 206, 332], [186, 356, 206, 356]]) {
      const n = 10;
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        const x = ax + (bx2 - ax) * t;
        const z = az + (bz2 - az) * t;
        const sag = Math.sin(t * Math.PI) * 0.55;
        B.add('banner', planeGeo(0.44, 0.5, 1.0), place(x, H(x, z) + 5.1 - sag, z, 0, 0),
          HERALD[i % HERALD.length]);
      }
    }
  }

  /* ================================================================== */
  /* Camps on the far bank                                               */
  /* ================================================================== */

  /**
   * Three camps, one district each.
   *
   * The layout is pure data in `medieval/Camps.js`; this is the part that
   * needs a renderer. Everything is merged per camp, so a camp of forty
   * pieces is four draw calls with a fifteen-metre bounding sphere - which
   * matters more here than anywhere else in the world, because a camp is a
   * small object a long way from everything else and the frustum will reject
   * it almost always.
   */
  _buildCamps() {
    for (const camp of CAMPS) {
      const B = new GeoBatch();
      const rnd = mulberry32(0x3ca000 + camp.x * 31 + camp.z);
      const H = (x, z) => this._height(x, z);
      const c = Math.cos(camp.yaw);
      const s = Math.sin(camp.yaw);
      /** Camp-local (dx, dz) to world. */
      const W = (dx, dz) => [camp.x + dx * c - dz * s, camp.z + dx * s + dz * c];
      const place = (x, y, z, ry = 0, rz = 0) => {
        _obj.position.set(x, y, z);
        _obj.rotation.set(0, ry, rz);
        _obj.scale.set(1, 1, 1);
        return _obj;
      };

      for (const t of camp.tents) {
        const [x, z] = W(t.dx, t.dz);
        const y = H(x, z);
        const yaw = camp.yaw + (t.yaw || 0);
        if (t.kind === 'bell') this._bellTent(B, place, x, y, z, yaw, t);
        else if (t.kind === 'aframe') this._aframeTent(B, place, x, y, z, yaw, t);
        else if (t.kind === 'leanto') this._leanTo(B, place, x, y, z, yaw, t);
        else this._awning(B, place, x, y, z, yaw, t);
      }
      for (const f of camp.fires) {
        const [x, z] = W(f.dx, f.dz);
        this._firepit(B, place, x, H(x, z), z, camp.yaw + (f.yaw || 0), f, rnd);
      }
      for (const p of camp.props) {
        const [x, z] = W(p.dx, p.dz);
        this._campProp(B, place, x, H(x, z), z, camp.yaw + (p.yaw || 0), p, rnd);
      }
      B.build(this._mats, this.group, { ao: this._heightFn });
      this.minimapShapes.push({
        kind: 'rect', x: camp.x, z: camp.z, w: camp.radius, d: camp.radius,
        rotation: camp.yaw, fill: 'rgba(120,96,64,0.35)', stroke: 'rgba(226,198,152,0.7)',
      });
    }
  }

  /** A conical bell tent: a ring of guys, a pole and a doorway flap. */
  _bellTent(B, place, x, y, z, yaw, t) {
    const r = t.r ?? 2.4;
    const h = t.h ?? 3.0;
    B.add('canopy', coneGeo(r, h, 14, 0.7), place(x, y + h / 2, z, yaw), t.hex ?? 0xd8cbae);
    B.add('canopy', cylGeo(r * 0.98, r, 0.55, 14, 0.9), place(x, y + 0.27, z, yaw), shadeHex(t.hex ?? 0xd8cbae, 0.82));
    B.add('beam', cylGeo(0.05, 0.06, h + 0.6, 5, 1.2), place(x, y + (h + 0.6) / 2, z), 0x7a6144);
    // Guy ropes and pegs.
    for (let i = 0; i < 8; i++) {
      const a = yaw + (i / 8) * TAU;
      const px = x + Math.cos(a) * (r + 1.0);
      const pz = z + Math.sin(a) * (r + 1.0);
      B.add('beam', cylGeo(0.02, 0.02, 1.9, 4, 2.0), place((x + px) / 2 + Math.cos(a) * 0.1, y + h * 0.42, (z + pz) / 2 + Math.sin(a) * 0.1, -a + Math.PI / 2, 0.85), 0xbdae90);
      B.add('beam', cylGeo(0.04, 0.04, 0.34, 4, 1.4), place(px, y + 0.1, pz, 0, 0.2), 0x6f5940);
    }
    // The door flap, thrown back.
    B.add('canopy', planeGeo(0.9, 1.5, 1.2), place(x + Math.sin(yaw) * (r + 0.1), y + 0.75, z + Math.cos(yaw) * (r + 0.1), yaw, 0.3), shadeHex(t.hex ?? 0xd8cbae, 0.9));
    this._box(x, y + 0.9, z, r * 0.8, 0.9, r * 0.8);
    this._contacts.push(x, y, z, r + 0.7);
  }

  /** An A-frame over a ridge rope, pegged out both sides. */
  _aframeTent(B, place, x, y, z, yaw, t) {
    const w = t.w ?? 2.2;
    const d = t.d ?? 4.0;
    const h = t.h ?? 2.0;
    const slope = Math.atan2(h, w / 2);
    const len = Math.hypot(w / 2, h) + 0.16;
    for (const s of [-1, 1]) {
      B.add('canopy', boxGeo(len, 0.06, d, 1.1), place(x + s * (w / 4) * Math.cos(yaw), y + h / 2, z - s * (w / 4) * Math.sin(yaw), yaw, s * (Math.PI / 2 - slope)), t.hex ?? 0xc9bda4);
    }
    // Gable at the back, open at the front.
    const sh = new THREE.Shape();
    sh.moveTo(-w / 2, 0);
    sh.lineTo(w / 2, 0);
    sh.lineTo(0, h);
    sh.closePath();
    const gg = new THREE.ExtrudeGeometry(sh, { depth: 0.05, bevelEnabled: false });
    MedievalWorld._uvScale(gg, 0.8);
    B.add('canopy', gg, place(x - Math.sin(yaw) * (d / 2), y, z - Math.cos(yaw) * (d / 2), yaw), shadeHex(t.hex ?? 0xc9bda4, 0.86));
    for (const s of [-1, 1]) {
      B.add('beam', cylGeo(0.04, 0.05, h + 0.3, 4, 1.4), place(x - Math.sin(yaw) * s * (d / 2 + 0.15), y + (h + 0.3) / 2, z - Math.cos(yaw) * s * (d / 2 + 0.15)), 0x7a6144);
    }
    /* The ridge rope, along the tent's depth.
     *
     * `cylGeo` is a Y-AXIS cylinder and this `place` sets rotation (0, ry, rz),
     * so the Z angle is the only one that can lay it down: with `rz = 0` the
     * ridge stood on end as a 4.7 m mast out of the apex, and turning it about
     * Y did nothing at all. Same defect, same shape, in four other props and in
     * `_timberBridge`'s handrail - see the note on that helper. */
    B.add('beam', cylGeo(0.025, 0.025, d + 0.7, 4, 2.0),
      place(x, y + h + 0.06, z, yaw + Math.PI / 2, Math.PI / 2), 0xbdae90);
    this._box(x, y + h * 0.4, z, w / 2, h * 0.4, d / 2);
    this._contacts.push(x, y, z, Math.max(w, d) * 0.6);
  }

  /** A brushwood lean-to: three poles, a sloped hide and a bracken bed. */
  _leanTo(B, place, x, y, z, yaw, t) {
    const w = t.w ?? 4.0;
    const d = t.d ?? 2.6;
    const h = t.h ?? 1.9;
    B.add('canopy', boxGeo(w, 0.07, Math.hypot(d, h) + 0.2, 1.1), place(x, y + h / 2, z, yaw, 0), shadeHex(t.hex ?? 0x8f7a56, 1.0));
    for (const s of [-1, 1]) {
      B.add('beam', cylGeo(0.06, 0.08, h + 0.2, 5, 1.1), place(x + s * (w / 2 - 0.2) * Math.cos(yaw), y + (h + 0.2) / 2, z - s * (w / 2 - 0.2) * Math.sin(yaw), 0, 0.1), 0x7a6144);
    }
    // The ridge, across the two uprights. `rz` lays it down; `ry` aims it.
    B.add('beam', cylGeo(0.05, 0.05, w, 5, 1.2), place(x, y + h + 0.06, z, yaw, Math.PI / 2), 0x7a6144);
    // The back wall, woven from brush.
    for (let i = 0; i < 7; i++) {
      const t2 = (i / 6 - 0.5) * (w - 0.3);
      B.add('leaf', boxGeo(0.42, h * 0.9, 0.3, 4.0), place(x + t2 * Math.cos(yaw) - Math.sin(yaw) * (d / 2), y + h * 0.45, z - t2 * Math.sin(yaw) - Math.cos(yaw) * (d / 2), yaw), 0x5f6b42);
    }
    B.add('hay', boxGeo(w - 0.8, 0.3, d - 0.7, 1.4), place(x, y + 0.15, z, yaw), 0xb8a476);
    this._box(x, y + h * 0.35, z, w / 2, h * 0.35, d / 2);
    this._contacts.push(x, y, z, Math.max(w, d) * 0.6);
  }

  /** A flat awning on four poles - a merchant's shade over his goods. */
  _awning(B, place, x, y, z, yaw, t) {
    const w = t.w ?? 5.0;
    const d = t.d ?? 3.2;
    const h = t.h ?? 2.4;
    B.add('canopy', boxGeo(w, 0.06, d, 1.2), place(x, y + h, z, yaw, 0.09), t.hex ?? 0xc2a878);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const px = x + (sx * (w / 2 - 0.2) * Math.cos(yaw) + sz * (d / 2 - 0.2) * Math.sin(yaw));
        const pz = z + (-sx * (w / 2 - 0.2) * Math.sin(yaw) + sz * (d / 2 - 0.2) * Math.cos(yaw));
        B.add('beam', cylGeo(0.06, 0.07, h, 5, 1.1), place(px, y + h / 2, pz), 0x7a6144);
      }
    }
    this._contacts.push(x, y, z, Math.max(w, d) * 0.6);
  }

  /**
   * A banked firepit, and everything that hangs over it.
   *
   * The bank is the detail that matters: a ring of turves and stones raised
   * about 20 cm, with the embers set BELOW the surrounding ground rather than
   * on it. A fire drawn as a glowing disc on grass reads as a decal; a fire
   * drawn as a hole with a rim reads as a fire, and it costs nine boxes.
   */
  _firepit(B, place, x, y, z, yaw, f, rnd) {
    const r = f.r ?? 1.15;
    for (let i = 0; i < 11; i++) {
      const a = yaw + (i / 11) * TAU + rnd() * 0.2;
      const px = x + Math.cos(a) * r;
      const pz = z + Math.sin(a) * r;
      B.add('rock', boxGeo(0.42 + rnd() * 0.2, 0.3, 0.34 + rnd() * 0.18, 1.1),
        place(px, y + 0.1, pz, a, (rnd() - 0.5) * 0.3), 0x7a7268);
    }
    B.add('rock', cylGeo(r * 0.86, r * 0.9, 0.22, 12, 1.0), place(x, y - 0.06, z), 0x2a2622);
    B.add('ember', cylGeo(r * 0.7, r * 0.55, 0.26, 12, 1.4), place(x, y + 0.02, z), 0xff8030);
    // Charred logs laid in.
    for (let i = 0; i < 4; i++) {
      const a = yaw + i * 1.31;
      B.add('beam', cylGeo(0.09, 0.11, r * 1.4, 5, 1.2),
        place(x + Math.cos(a) * 0.12, y + 0.16, z + Math.sin(a) * 0.12, -a + Math.PI / 2, 0.06), 0x2e261f);
    }
    this._addGlow(x, y + 0.06, z, 7.0, 0x7a4416);
    if (f.smoke !== false) this._smokeOrigins.push(x, y + 0.6, z);
    const fl = pointLight(0xff9436, 46, 16, 2);
    fl.position.set(x, y + 0.8, z);
    this.group.add(fl);
    this._contacts.push(x, y, z, r + 0.8);

    if (f.spit) {
      // Two forked uprights, a turning bar, and a carcass on it.
      for (const s of [-1, 1]) {
        const px = x + Math.cos(yaw + Math.PI / 2) * s * (r + 0.55);
        const pz = z + Math.sin(yaw + Math.PI / 2) * s * (r + 0.55);
        B.add('beam', cylGeo(0.06, 0.08, 1.5, 5, 1.1), place(px, y + 0.75, pz), 0x6f5940);
        for (const ss of [-1, 1]) {
          B.add('beam', cylGeo(0.035, 0.04, 0.42, 4, 1.4),
            place(px, y + 1.42, pz, 0, ss * 0.5), 0x6f5940);
        }
      }
      B.add('iron', cylGeo(0.035, 0.035, (r + 0.55) * 2 + 0.8, 6, 1.4),
        place(x, y + 1.5, z, yaw + Math.PI / 2, 0), 0x3a3128);
      const carcass = new THREE.SphereGeometry(0.34, 10, 7);
      carcass.scale(1.0, 0.85, 2.1);
      MedievalWorld._uvScale(carcass, 0.9);
      B.add('hay', carcass, place(x, y + 1.5, z, yaw + Math.PI / 2), 0x9c6a42);
      B.add('iron', cylGeo(0.05, 0.05, 0.34, 5, 1.4), place(x + Math.cos(yaw + Math.PI / 2) * (r + 0.9), y + 1.5, z + Math.sin(yaw + Math.PI / 2) * (r + 0.9), yaw, Math.PI / 2), 0x3a3128);
    }
    if (f.pot) {
      // A tripod with a cauldron slung under it.
      for (let i = 0; i < 3; i++) {
        const a = yaw + (i / 3) * TAU;
        B.add('beam', cylGeo(0.045, 0.055, 2.1, 5, 1.1),
          place(x + Math.cos(a) * (r * 0.75), y + 1.0, z + Math.sin(a) * (r * 0.75), -a + Math.PI / 2, 0.32), 0x6f5940);
      }
      const pot = new THREE.SphereGeometry(0.4, 12, 8, 0, TAU, 0, Math.PI * 0.62);
      MedievalWorld._uvScale(pot, 1.0);
      B.add('iron', pot, place(x, y + 0.95, z, 0, Math.PI), 0x2f2924);
      B.add('iron', cylGeo(0.02, 0.02, 0.85, 4, 2.0), place(x, y + 1.45, z), 0x2f2924);
    }
    for (let i = 0; i < (f.logs ?? 3); i++) {
      const a = yaw + 0.7 + (i / (f.logs ?? 3)) * TAU;
      const px = x + Math.cos(a) * (r + 1.5);
      const pz = z + Math.sin(a) * (r + 1.5);
      B.add('beam', cylGeo(0.24, 0.27, 1.5, 8, 1.0), place(px, this._height(px, pz) + 0.24, pz, -a, Math.PI / 2), 0x6a5741);
      this._contacts.push(px, this._height(px, pz), pz, 0.9);
    }
  }

  /** One camp prop. The vocabulary that makes three camps read as three trades. */
  _campProp(B, place, x, y, z, yaw, p, rnd) {
    const box = (key, w, h, d, dy, tint, rz = 0) =>
      B.add(key, boxGeo(w, h, d, 1.0), place(x, y + dy, z, yaw, rz), tint);
    switch (p.kind) {
      case 'bedroll':
        B.add('hay', boxGeo(0.78, 0.16, 1.95, 1.3), place(x, y + 0.08, z, yaw), 0xb8a476);
        B.add('canopy', boxGeo(0.72, 0.13, 1.75, 1.4), place(x, y + 0.22, z, yaw), 0xa89a7c);
        B.add('canopy', boxGeo(0.5, 0.16, 0.4, 1.6), place(x, y + 0.3, z - 0.8, yaw), 0xc9bda4);
        this._contacts.push(x, y, z, 1.2);
        break;
      case 'woodpile': {
        for (let i = 0; i < 16; i++) {
          const row = (i / 4) | 0;
          B.add('beam', cylGeo(0.11, 0.12, 1.45, 6, 1.1),
            place(x + ((i % 4) - 1.5) * 0.26 * Math.cos(yaw), y + 0.13 + row * 0.25, z - ((i % 4) - 1.5) * 0.26 * Math.sin(yaw), yaw + Math.PI / 2, Math.PI / 2), 0x8a6c4a);
        }
        this._box(x, y + 0.45, z, 0.75, 0.45, 0.62);
        this._contacts.push(x, y, z, 1.1);
        break;
      }
      case 'crate':
        box('plank', 0.9, p.h ?? 0.72, 0.8, (p.h ?? 0.72) / 2, 0x8f7550);
        B.add('beam', boxGeo(0.95, 0.08, 0.85, 1.4), place(x, y + (p.h ?? 0.72), z, yaw), 0x6f5940);
        this._box(x, y + 0.36, z, 0.48, 0.36, 0.42);
        this._contacts.push(x, y, z, 0.72);
        break;
      case 'barrel':
        B.add('plank', cylGeo(0.36, 0.42, 0.92, 12, 1.0), place(x, y + 0.46, z, yaw), 0x8f6f47);
        for (const hy of [0.2, 0.72]) {
          B.add('iron', cylGeo(0.44, 0.44, 0.07, 12, 1.4), place(x, y + hy, z), 0x3a3128);
        }
        this._box(x, y + 0.46, z, 0.42, 0.46, 0.42);
        this._contacts.push(x, y, z, 0.62);
        break;
      case 'sacks':
        for (let i = 0; i < 5; i++) {
          B.add('canopy', boxGeo(0.62, 0.5, 0.44, 1.4),
            place(x + (i % 3) * 0.5 - 0.5, y + 0.25 + ((i / 3) | 0) * 0.46, z + ((i % 2) * 0.3), yaw + i * 0.4), 0xd0c2a0);
        }
        this._contacts.push(x, y, z, 1.1);
        break;
      case 'cart': {
        B.add('plank', boxGeo(3.0, 0.7, 1.6, 0.8), place(x, y + 1.05, z, yaw), 0x8f7550);
        for (const s of [-1, 1]) {
          B.add('plank', boxGeo(3.0, 0.65, 0.1, 1.0), place(x + Math.sin(yaw) * s * 0.78, y + 1.7, z + Math.cos(yaw) * s * 0.78, yaw), 0x7c6242);
        }
        B.add('beam', boxGeo(3.8, 0.15, 0.15, 1.2), place(x, y + 0.72, z, yaw), 0x6f5940);
        for (const s of [-1, 1]) {
          const wheel = new THREE.TorusGeometry(0.68, 0.1, 6, 16);
          MedievalWorld._uvScale(wheel, 0.6);
          B.add('plank', wheel, place(x + Math.sin(yaw) * s * 0.92, y + 0.68, z + Math.cos(yaw) * s * 0.92, yaw), 0x7c6242);
          for (let k = 0; k < 6; k++) {
            B.add('beam', boxGeo(0.07, 1.3, 0.07, 1.4), place(x + Math.sin(yaw) * s * 0.92, y + 0.68, z + Math.cos(yaw) * s * 0.92, yaw, (k / 6) * Math.PI), 0x7c6242);
          }
        }
        // Shafts, propped on the ground.
        for (const s of [-1, 1]) {
          B.add('beam', cylGeo(0.06, 0.08, 2.6, 5, 1.1),
            place(x - Math.sin(yaw) * s * 0.5 + Math.cos(yaw) * 2.4, y + 0.55, z - Math.cos(yaw) * s * 0.5 - Math.sin(yaw) * 2.4, yaw + Math.PI / 2, 0.28), 0x6f5940);
        }
        this._box(x, y + 1.0, z, 1.7, 1.0, 1.1);
        this._contacts.push(x, y, z, 2.4);
        break;
      }
      case 'ox': {
        // A tethered beast, blocked out. Not an NPC - the population pass owns
        // those - just the silhouette that makes a caravan a caravan.
        const body = new THREE.SphereGeometry(0.8, 10, 7);
        body.scale(0.75, 0.85, 1.5);
        MedievalWorld._uvScale(body, 0.8);
        B.add('hay', body, place(x, y + 1.15, z, yaw), 0x6f5b44);
        B.add('hay', boxGeo(0.5, 0.44, 0.66, 1.2), place(x + Math.cos(yaw) * 1.3, y + 1.28, z - Math.sin(yaw) * 1.3, yaw), 0x63513c);
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 1]) {
            B.add('hay', cylGeo(0.11, 0.13, 1.0, 6, 1.0),
              place(x + Math.sin(yaw) * sx * 0.42 + Math.cos(yaw) * sz * 0.8, y + 0.5, z + Math.cos(yaw) * sx * 0.42 - Math.sin(yaw) * sz * 0.8), 0x5c4b38);
          }
        }
        this._box(x, y + 1.0, z, 0.9, 1.0, 1.5);
        this._contacts.push(x, y, z, 1.7);
        break;
      }
      case 'tether':
        B.add('beam', cylGeo(0.09, 0.12, 1.5, 6, 1.0), place(x, y + 0.75, z, 0, 0.1), 0x6f5940);
        B.add('beam', cylGeo(0.02, 0.02, 2.6, 4, 2.0), place(x + 1.3, y + 0.55, z, yaw, 1.35), 0xbdae90);
        this._contacts.push(x, y, z, 0.5);
        break;
      case 'laundry': {
        const w = p.w ?? 6.0;
        for (const s of [-1, 1]) {
          const px = x + Math.cos(yaw) * s * (w / 2);
          const pz = z - Math.sin(yaw) * s * (w / 2);
          B.add('beam', cylGeo(0.06, 0.08, 2.2, 5, 1.1), place(px, this._height(px, pz) + 1.1, pz), 0x7a6144);
        }
        // The line itself, strung between the two poles rather than stood on end.
        B.add('beam', cylGeo(0.02, 0.02, w, 4, 2.0), place(x, y + 2.05, z, yaw, Math.PI / 2), 0xbdae90);
        for (let i = 0; i < 6; i++) {
          const t = (i / 5 - 0.5) * (w - 1.0);
          B.add('canopy', planeGeo(0.7, 0.95, 1.2),
            place(x + Math.cos(yaw) * t, y + 1.55, z - Math.sin(yaw) * t, yaw + Math.PI / 2),
            [0xe6e0d2, 0xc9bda4, 0xd8cbae, 0xb9c4d0][i % 4]);
        }
        break;
      }
      case 'cross': {
        const h = p.h ?? 3.4;
        B.add('rock', boxGeo(1.0, 0.4, 1.0, 0.8), place(x, y + 0.2, z, yaw), 0x9a8f7c);
        B.add('ashlar', cylGeo(0.14, 0.19, h, 8, 0.9), place(x, y + 0.4 + h / 2, z), 0xc9c1ad);
        B.add('ashlar', boxGeo(1.05, 0.2, 0.2, 1.2), place(x, y + 0.4 + h * 0.82, z, yaw), 0xc9c1ad);
        this._box(x, y + h / 2, z, 0.3, h / 2, 0.3);
        this._contacts.push(x, y, z, 0.9);
        break;
      }
      case 'staffs':
        for (let i = 0; i < 5; i++) {
          B.add('beam', cylGeo(0.035, 0.045, 1.85, 5, 1.2),
            place(x + (i - 2) * 0.1, y + 0.9, z, yaw + i * 0.3, 0.16 + i * 0.03), 0x8a6c4a);
        }
        this._contacts.push(x, y, z, 0.5);
        break;
      case 'basket':
        B.add('hay', cylGeo(0.3, 0.24, 0.44, 10, 1.2), place(x, y + 0.22, z, yaw), 0xcbb277);
        this._contacts.push(x, y, z, 0.4);
        break;
      case 'waterpot':
        B.add('rock', cylGeo(0.18, 0.26, 0.52, 10, 1.0), place(x, y + 0.26, z, yaw), 0x8f8474);
        this._contacts.push(x, y, z, 0.35);
        break;
      case 'stool':
        B.add('plank', cylGeo(0.21, 0.18, 0.44, 8, 1.0), place(x, y + 0.22, z, yaw), 0x8f6f47);
        this._contacts.push(x, y, z, 0.32);
        break;
      case 'lantern':
        B.add('beam', cylGeo(0.05, 0.07, 1.9, 5, 1.1), place(x, y + 0.95, z), 0x7a6144);
        B.add('iron', boxGeo(0.24, 0.32, 0.24, 1.6), place(x, y + 1.9, z, yaw), 0x2f2924);
        B.add('ember', boxGeo(0.15, 0.2, 0.15, 2.0), place(x, y + 1.9, z, yaw), 0xffc074);
        this._addGlow(x, y + 0.05, z, 4.2, 0x4a2a12);
        this._contacts.push(x, y, z, 0.3);
        break;
      case 'banner': {
        B.add('beam', cylGeo(0.06, 0.08, 3.4, 5, 1.1), place(x, y + 1.7, z), 0x7a6144);
        B.add('banner', planeGeo(1.1, 1.7, 1.0), place(x + 0.55 * Math.cos(yaw), y + 2.5, z - 0.55 * Math.sin(yaw), yaw), p.hex ?? 0xb02a33);
        this._contacts.push(x, y, z, 0.4);
        break;
      }
      case 'peltrack': {
        const w = p.w ?? 4.2;
        for (const s of [-1, 1]) {
          const px = x + Math.cos(yaw) * s * (w / 2);
          const pz = z - Math.sin(yaw) * s * (w / 2);
          B.add('beam', cylGeo(0.07, 0.09, 2.0, 5, 1.1), place(px, this._height(px, pz) + 1.0, pz), 0x7a6144);
        }
        B.add('beam', cylGeo(0.05, 0.05, w, 5, 1.2), place(x, y + 1.9, z, yaw, Math.PI / 2), 0x7a6144);
        for (let i = 0; i < 4; i++) {
          const t = (i / 3 - 0.5) * (w - 1.2);
          B.add('hay', planeGeo(0.85, 1.25, 1.2), place(x + Math.cos(yaw) * t, y + 1.25, z - Math.sin(yaw) * t, yaw + Math.PI / 2),
            [0x8a6a44, 0x6f5638, 0x9c7a4e, 0x7b5f3e][i % 4]);
        }
        break;
      }
      case 'gralloch': {
        const h = p.h ?? 2.8;
        for (const s of [-1, 1]) {
          B.add('beam', cylGeo(0.08, 0.1, h, 6, 1.0), place(x + Math.cos(yaw) * s * 0.9, y + h / 2, z - Math.sin(yaw) * s * 0.9, 0, s * 0.14), 0x6f5940);
        }
        B.add('beam', cylGeo(0.06, 0.06, 2.2, 5, 1.2), place(x, y + h - 0.1, z, yaw, Math.PI / 2), 0x7a6144);
        const deer = new THREE.SphereGeometry(0.34, 10, 7);
        deer.scale(0.72, 1.5, 0.72);
        MedievalWorld._uvScale(deer, 0.9);
        B.add('hay', deer, place(x, y + h - 0.85, z, yaw), 0x7d5b3a);
        this._box(x, y + h / 2, z, 0.9, h / 2, 0.5);
        this._contacts.push(x, y, z, 1.2);
        break;
      }
      case 'traps':
        for (let i = 0; i < 5; i++) {
          B.add('iron', cylGeo(0.24, 0.24, 0.06, 10, 1.4), place(x + (i % 3) * 0.34, y + 0.06 + ((i / 3) | 0) * 0.09, z + (i % 2) * 0.28, yaw + i), 0x3a3128);
        }
        this._contacts.push(x, y, z, 0.7);
        break;
      case 'antlers':
        B.add('beam', cylGeo(0.07, 0.09, 1.6, 5, 1.1), place(x, y + 0.8, z), 0x7a6144);
        for (const s of [-1, 1]) {
          for (let i = 0; i < 3; i++) {
            B.add('rock', cylGeo(0.03, 0.045, 0.55, 4, 1.4),
              place(x + s * (0.16 + i * 0.12), y + 1.5 + i * 0.14, z, yaw, s * (0.4 + i * 0.25)), 0xcfc4ac);
          }
        }
        this._contacts.push(x, y, z, 0.4);
        break;
      case 'spears':
        for (let i = 0; i < 4; i++) {
          B.add('beam', cylGeo(0.03, 0.04, 2.3, 5, 1.2), place(x + (i - 1.5) * 0.12, y + 1.12, z, yaw + i * 0.25, 0.14), 0x8a6c4a);
          B.add('iron', coneGeo(0.055, 0.3, 5, 1.2), place(x + (i - 1.5) * 0.12 + Math.sin(0.14) * 1.15, y + 2.28, z, yaw), 0x4a4038);
        }
        this._contacts.push(x, y, z, 0.5);
        break;
      default:
        box('plank', 0.6, 0.5, 0.5, 0.25, 0x8f7550);
        this._contacts.push(x, y, z, 0.5);
        break;
    }
    void rnd;
  }

  /* ================================================================== */
  /* Crossings                                                           */
  /* ================================================================== */

  /**
   * Every bridge except the vale's own.
   *
   * The stone bridge at x = 26 stays where it is, hand-built inside
   * `_buildRiverside` against a composed frame; this builds the three the ring
   * needed. The reasoning that decided WHICH ones lives in `RoadNet.js` -
   * fords are wadeable and bridges are for the crossings that have to work in
   * February - and the abutment positions come from there too, because "the
   * bridge lands on dry ground" is a claim about the heightfield and a test
   * can check it.
   */
  _buildCrossings(B) {
    for (const c of CROSSINGS) {
      if (c.kind !== 'bridge') continue;
      if (c.id === 'aldern-bridge') continue;    // built by hand in _buildRiverside
      if (c.style === 'stone') this._stoneBridge(B, c);
      else this._timberBridge(B, c);
    }
  }

  /**
   * Build the road up to a bridge abutment.
   *
   * ── The defect ─────────────────────────────────────────────────────────
   * An abutment is sized off the DECK - it has to be, that is what it carries
   * - and the road arrives at whatever height the bank happens to be. Nothing
   * was joining the two. Harrowgate's north abutment stood 1.07 m over the
   * ground its own road runs on and Ashlea's stood 0.90 m over its, so two of
   * the five authored crossings could be looked at and not used: walking the
   * `harrowbridgeN` road, the player jammed at (307.8, 2.2, 104.8) with the
   * deck in front of their face. Both decks were always fine. You could just
   * never get onto one.
   *
   * ── Why a ramp and not steps ───────────────────────────────────────────
   * Carts. `_entrySteps` puts 0.30 m risers on a 0.62 m going at a doorway,
   * which is a stair; a bridge approach is a causeway and has to read as
   * something a waggon could be hauled over, so the going is nearly twice as
   * long for a slightly shorter riser - a fifth, not a half. It is still a
   * stack of boxes underneath, because the capsule solver has no other kind of
   * surface, but at 1.15 m of run per 0.26 m of rise the eye reads a bank.
   *
   * ── Why the first version of this did not work ─────────────────────────
   * It laid the courses as a straight stack of CONSTANT width, nested only
   * along the crossing's own axis. That is a ramp if you arrive head-on and a
   * wall if you arrive at any other angle, and no approach road in the world
   * arrives head-on: `harrowbridgeN` is `[[296,112],[304,108],[311,104]]` and
   * comes in 30 degrees off the deck's axis, straight onto the causeway's west
   * cheek - measured at 0.94 m tall against a 0.45 m step budget. The player
   * jammed at (307.8, 2.2, 104.8) before the fix and at (307.8, 2.2, 104.8)
   * after it, because the test that certified the fix walked the deck's own
   * axis and never touched a cheek.
   *
   * So the courses FLARE, exactly as `_entrySteps` nests its doorstep: each
   * course is both one going further out AND one flare wider per side than the
   * one above it, and each spans the abutment's full depth rather than starting
   * at its outer face. The result is a set of nested rectangles wrapped round
   * the abutment on three sides, and a straight line from anywhere outside
   * crosses each boundary exactly once whatever its bearing. One boundary, one
   * riser. The fourth side is the deck, and there is nothing to be done about
   * the fourth side - you cannot walk up through a bridge.
   *
   * @param {GeoBatch} B
   * @param {{x:number, width:number}} c the crossing
   * @param {{sgn:number, topY:number, fromZ:number, innerZ:number, half:number,
   *          key:string, tint:number}} o
   *   `sgn` is +1 to build outward in +Z and -1 in -Z; `fromZ` and `innerZ` are
   *   the abutment's outer and inner faces; `half` its own half-width, so the
   *   innermost course is never narrower than the block it climbs to; `key` the
   *   material, so a timber bridge gets a timber causeway.
   * @returns {number} courses laid
   */
  _crossingRamp(B, c, o) {
    const { sgn, topY, fromZ, innerZ, key, tint } = o;
    const RISE = 0.26;
    const RUN = 1.15;
    /**
     * How much wider each course is than the one above it, per side.
     *
     * Half the going, as at a doorstep. Any positive number makes the courses
     * nest, which is all the "climbable from any bearing" argument needs; half
     * gives a 0.575 m tread against a 0.26 m riser on the cheeks, which is a
     * gentler side slope than the causeway's own 23% and still narrow enough
     * that a three-course flight only widens a 5.4 m bridge to 11 m of
     * embankment - which is what a causeway looks like.
     */
    const FLARE = RUN / 2;
    const MAX = 10;
    const bx = c.x;
    const halfW = (i) => o.half + i * FLARE;
    const outerZ = (i) => fromZ + sgn * i * RUN;
    /** Lowest ground anywhere a walker could step onto course `i` from. */
    const grade = (i) => {
      const hx = halfW(i) + 0.2;
      const zo = outerZ(i) + sgn * 0.35;
      let lo = Infinity;
      for (let k = -3; k <= 3; k++) {
        const h = this._height(bx + (k / 3) * hx, zo);
        if (h < lo) lo = h;
      }
      // ...and along both cheeks, which is the half of the perimeter the
      // straight version never sampled and never built for.
      for (const s of [-1, 1]) {
        for (let k = 0; k <= 4; k++) {
          const h = this._height(bx + s * hx, innerZ + (zo - innerZ) * (k / 4));
          if (h < lo) lo = h;
        }
      }
      return lo;
    };
    let n = 0;
    while (n < MAX && topY - n * RISE - grade(n) > RISE) n++;
    for (let i = 1; i <= n; i++) {
      const ty = topY - i * RISE;
      const by = Math.min(ty, grade(i)) - 0.6;
      const z1 = outerZ(i);
      const cz = (innerZ + z1) / 2;
      const d = Math.abs(z1 - innerZ);
      const w = halfW(i) * 2;
      _obj.position.set(bx, (ty + by) / 2, cz);
      _obj.rotation.set(0, 0, 0);
      _obj.scale.set(1, 1, 1);
      _obj.updateMatrix();
      B.add(key, boxGeo(w, ty - by, d, 0.55), _obj, tint);
      this._box(bx, (ty + by) / 2, cz, w / 2, (ty - by) / 2, d / 2);
    }
    if (n > 0) {
      /* The embankment is beaten ground, not meadow: without this the scatter
       * plants oaks on the causeway, which is the same defect as the eleven
       * trunks inside the abbey precinct. */
      const z1 = outerZ(n);
      this._footprints.push({
        x: bx, z: (innerZ + z1) / 2, hx: halfW(n) + 0.4,
        hz: Math.abs(z1 - innerZ) / 2 + 0.4, r: 0,
      });
    }
    return n;
  }

  /** A two-arch masonry bridge with a mid-stream cutwater and a toll house. */
  _stoneBridge(B, c) {
    const place = (x, y, z, ry = 0) => {
      _obj.position.set(x, y, z);
      _obj.rotation.set(0, ry, 0);
      _obj.scale.set(1, 1, 1);
      return _obj;
    };
    const stone = 0xc7bfac;
    const bx = c.x;
    const z0 = c.from[1];
    const z1 = c.to[1];
    const rz = (z0 + z1) / 2;
    const deckY = c.deckY;
    const bw = c.width;
    const springY = deckY - 2.3;

    this._arch(B, 'rubble', bx, z0 + 1.2, rz - 1.3, springY, 1.8, bw, 0.8, stone);
    this._arch(B, 'rubble', bx, rz + 1.3, z1 - 1.2, springY, 1.8, bw, 0.8, stone);
    B.add('rubble', boxGeo(bw, 4.6, 2.6, 0.5), place(bx, springY - 1.0, rz), stone);
    for (const s of [-1, 1]) {
      const g = new THREE.CylinderGeometry(1.2, 1.4, 4.6, 3);
      MedievalWorld._uvScale(g, 0.5);
      B.add('rubble', g, place(bx, springY - 1.0, rz + s * 2.0, s > 0 ? 0 : Math.PI), stone);
    }
    this._box(bx, springY - 1.0, rz, bw / 2, 2.3, 2.0);
    for (const s of [-1, 1]) {
      const az = rz + s * ((z1 - z0) / 2 + 1.6);
      B.add('rubble', boxGeo(bw + 2.2, 5.4, 4.0, 0.5), place(bx, deckY - 2.9, az), stone);
      this._box(bx, deckY - 2.9, az, (bw + 2.2) / 2, 2.7, 2.0);
      // ...and the causeway that gets the road up onto it. See `_crossingRamp`.
      this._crossingRamp(B, c, {
        sgn: s, topY: deckY - 0.2, fromZ: az + s * 2.0, innerZ: az - s * 2.0,
        half: (bw + 2.2) / 2, key: 'cobble', tint: 0xbcb6a8,
      });
    }
    const span = z1 - z0 + 4;
    B.add('cobble', boxGeo(bw, 0.65, span, 0.55), place(bx, deckY - 0.33, rz), 0xbcb6a8);
    this._box(bx, deckY - 0.38, rz, bw / 2, 0.38, span / 2);
    for (const s of [-1, 1]) {
      B.add('rubble', boxGeo(0.5, 1.05, span - 1, 0.6), place(bx + s * (bw / 2 - 0.25), deckY + 0.53, rz), stone);
      B.add('rubble', boxGeo(0.7, 0.15, span - 1, 0.8), place(bx + s * (bw / 2 - 0.25), deckY + 1.12, rz), 0xb6ae9b);
      this._box(bx + s * (bw / 2 - 0.25), deckY + 0.65, rz, 0.36, 0.72, (span - 1) / 2);
    }
    // Refuges over the cutwater, where a carter stands to let a cart past.
    for (const s of [-1, 1]) {
      B.add('rubble', boxGeo(1.3, 1.05, 2.2, 0.7), place(bx + s * (bw / 2 + 0.4), deckY + 0.53, rz), stone);
    }
    /* Parapet returns across the riverward face of each abutment.
     *
     * The abutment is 1.1 m wider than the deck on each side, so its two
     * riverward corners are a 3 m drop into the channel standing OUTSIDE the
     * deck's own parapet. Nothing walled them. A player who came up the
     * causeway on its cheek - which is now a thing they can do - arrived on the
     * abutment beside the parapet rather than between them, walked straight on,
     * and went over the corner: the walkthrough that found this ended swimming,
     * stuck at (311, -0.51, 118.65). The deck's parapets were never the
     * problem; the two metres before them were. */
    {
      const inner = bw / 2 - 0.5;               // the parapet's own inboard face
      const shoulder = (bw + 2.2) / 2;          // the abutment's edge
      const rw = shoulder - inner;
      for (const s of [-1, 1]) {
        const az = rz + s * ((z1 - z0) / 2 + 1.6);
        const cz = az - s * 1.75;
        for (const sx of [-1, 1]) {
          const cx = bx + sx * (inner + rw / 2);
          B.add('rubble', boxGeo(rw, 1.05, 0.5, 0.7), place(cx, deckY + 0.33, cz), stone);
          this._box(cx, deckY + 0.33, cz, rw / 2, 0.53, 0.25);
        }
      }
    }
    /* The toll house, at the foot of the downstream approach.
     *
     * It stood at `z1 + 3.4`, which was beside the abutment and 1.2 m clear of
     * the old straight causeway. The causeway flares now - see
     * `_crossingRamp` - and at three courses it is 11 m across and reaches
     * `z1 + 7`, so the old position put a 4.4 m building astride the embankment
     * with its west third buried in the fill and its gable walling off the
     * whole eastern quadrant of the approach. Moved to the toe of the ramp,
     * which is also where a toll is actually taken: you pay before you climb,
     * not after. */
    const tz = z1 + 10;
    const ty = this._height(bx + 4.6, tz);
    B.add('rubble', boxGeo(4.4, 3.0, 4.0, 0.55), place(bx + 4.6, ty + 1.5, tz), 0xb9b1a0);
    B.add('slate', coneGeo(3.6, 2.2, 4, 0.7), place(bx + 4.6, ty + 4.1, tz, Math.PI / 4), 0x9aa4b0);
    B.add('glass', planeGeo(0.8, 0.8, 1.2), place(bx + 2.4, ty + 1.7, tz, -Math.PI / 2), 0xffd9a0);
    this._box(bx + 4.6, ty + 1.5, tz, 2.2, 1.5, 2.0);
    this._addGlow(bx + 2.2, ty + 1.7, tz, 3.4, 0x54301a, -Math.PI / 2);
    this._footprints.push({ x: bx, z: rz, hx: bw / 2 + 3, hz: span / 2 + 2, r: 0 });
    this.minimapShapes.push({
      kind: 'rect', x: bx, z: rz, w: bw, d: span, rotation: 0,
      fill: 'rgba(150,140,120,0.5)', stroke: 'rgba(226,198,152,0.9)',
    });
  }

  /** A trestle bridge: bents in the water, a plank deck, a single handrail. */
  _timberBridge(B, c) {
    /**
     * Place one part, with all three Euler angles - in `put`'s own (rx, ry, rz)
     * order, which is the convention the rest of this file writes rotations in.
     *
     * ── Why the third angle matters ────────────────────────────────────
     * It used to expose Y and Z only, and every primitive here is a Y-AXIS
     * cylinder: rotating one about Y does nothing whatever. The handrail was
     * laid with `place(..., Math.PI / 2, 0)` and so was never laid at all -
     * measured off the `medieval:beam` batch bounds, y ran -11.08 to 18.92,
     * which is `deckY + 1.0 +/- span / 2`. Two 30 m masts, one per side,
     * standing 16 m over the deck and 11 m under the riverbed, visible from
     * the far bank. The diagonal braces survived only because they happen to
     * pass a non-zero Z angle, which is what actually tilts the cylinder; the
     * Y angle they also pass has never done anything either.
     *
     * The bridge runs north-south, so laying a Y-axis cylinder along its deck
     * is a rotation about X - the one axis the helper could not say.
     */
    const place = (x, y, z, rx = 0, ry = 0, rz = 0) => {
      _obj.position.set(x, y, z);
      _obj.rotation.set(rx, ry, rz);
      _obj.scale.set(1, 1, 1);
      return _obj;
    };
    const bx = c.x;
    const z0 = c.from[1];
    const z1 = c.to[1];
    const deckY = c.deckY;
    const bw = c.width;
    const span = z1 - z0;
    const bents = Math.max(3, Math.round(span / 4.2));
    for (let i = 0; i <= bents; i++) {
      const z = z0 + (span * i) / bents;
      const g = this._height(bx, z);
      const h = Math.max(0.8, deckY - g + 0.7);
      for (const s of [-1, 1]) {
        B.add('beam', cylGeo(0.16, 0.21, h, 6, 0.9), place(bx + s * (bw / 2 - 0.2), deckY - h / 2 - 0.1, z, 0, 0, s * 0.06), 0x6a5741);
      }
      B.add('beam', boxGeo(bw + 0.3, 0.18, 0.18, 1.1), place(bx, deckY - 0.28, z), 0x6a5741);
      if (i < bents) {
        // A rake in the ZY plane, which is a rotation about X and always was.
        B.add('beam', cylGeo(0.09, 0.09, Math.hypot(span / bents, h * 0.7), 5, 1.1),
          place(bx, deckY - h * 0.5, z + span / bents / 2, Math.atan2(h * 0.7, span / bents)), 0x6a5741);
      }
    }
    // The deck, in courses so the planks read individually.
    const boards = Math.max(6, Math.round(span / 0.55));
    for (let i = 0; i < boards; i++) {
      const z = z0 + (span * (i + 0.5)) / boards;
      B.add('plank', boxGeo(bw, 0.12, span / boards - 0.03, 0.7), place(bx, deckY - 0.06, z), shadeHex(0x9d7f56, 0.9 + (i % 3) * 0.07));
    }
    this._box(bx, deckY - 0.18, (z0 + z1) / 2, bw / 2, 0.14, span / 2);
    /* ---- The handrails, and the thing that makes them rails ----------
     *
     * `_stoneBridge` walls its deck with `this._box` under each parapet.
     * This built posts and a rail with `B.add` alone, so the only collider on
     * the whole crossing was the deck slab: eight of eight lateral probes
     * walked off the planks, three of them into the river at (-252.70, 0.24,
     * 50.00), (-254.02, -0.50, 41.51) and (-253.97, -0.44, 61.27). Deck top
     * 2.88, ground outside it -0.2 to -0.6 - a 3.1-3.5 m drop from anywhere on
     * a 30 m span. See the lateral-shove test in medieval-approach. */
    const railX = bw / 2 - 0.12;
    const railTop = deckY + 1.03;                 // top of the posts, near enough
    for (const s of [-1, 1]) {
      for (let i = 0; i <= bents * 2; i++) {
        const z = z0 + (span * i) / (bents * 2);
        B.add('beam', cylGeo(0.06, 0.07, 1.05, 5, 1.1), place(bx + s * railX, deckY + 0.5, z), 0x7a6144);
      }
      B.add('beam', cylGeo(0.055, 0.055, span, 5, 1.2),
        place(bx + s * railX, deckY + 1.0, (z0 + z1) / 2, Math.PI / 2), 0x7a6144);
      const deckTop = deckY - 0.04;
      this._box(bx + s * railX, (deckTop + railTop) / 2, (z0 + z1) / 2,
        0.16, (railTop - deckTop) / 2, span / 2);
    }
    for (const s of [-1, 1]) {
      const az = s < 0 ? z0 : z1;
      const g = this._height(bx, az + s * 1.6);
      /* The abutment's top is pinned to the DECK rather than to the bank.
       * Sitting it at `g + 0.9` put Ashlea's north block 19 cm proud of the
       * planks it abuts - a kerb across the mouth of the bridge - while its
       * outer face stood 0.90 m over the road, which is the half of it that
       * made the crossing unusable. */
      const topY = deckY - 0.04;
      const h = Math.max(0.5, topY - g + 0.8);
      B.add('rubble', boxGeo(bw + 1.4, h, 2.6, 0.6), place(bx, topY - h / 2, az + s * 1.0), 0x8e8371);
      this._box(bx, topY - h / 2, az + s * 1.0, (bw + 1.4) / 2, h / 2, 1.3);
      this._crossingRamp(B, c, {
        sgn: s, topY, fromZ: az + s * 2.3, innerZ: az - s * 0.3,
        half: (bw + 1.4) / 2, key: 'rubble', tint: 0x8e8371,
      });
    }
    this._footprints.push({ x: bx, z: (z0 + z1) / 2, hx: bw / 2 + 2, hz: span / 2 + 2, r: 0 });
    this.minimapShapes.push({
      kind: 'rect', x: bx, z: (z0 + z1) / 2, w: bw, d: span, rotation: 0,
      fill: 'rgba(120,96,64,0.45)', stroke: 'rgba(200,176,132,0.8)',
    });
  }

  /**
   * Dress the facades, not the floor.
   *
   * Every prop in the round-3 village stood below waist height and was piled
   * in one corner: the 2-4m band - the band a standing human actually looks
   * through - was completely empty, and the streets read as bare walls with a
   * few barrels at the bottom. This pass runs per *facade*: a hanging trade
   * sign on a wrought bracket over the door, a bracket lantern beside it, a
   * drying line from a first-floor window to a yard pole, and a lean-to
   * woodpile plus crates against the long blank return wall.
   *
   * @param {GeoBatch} B @param {() => number} rnd
   */
  _streetDressing(B, rnd) {
    const place = (x, y, z, ry = 0, rz = 0) => {
      _obj.position.set(x, y, z);
      _obj.rotation.set(0, ry, rz);
      _obj.scale.set(1, 1, 1);
      return _obj;
    };

    /* Which plots get what. Chosen by position rather than by index so the
     * dressing lands on the plots the composed vantages actually see. */
    const TRADES = [
      [14, 4, 0xb02a33], [23, -6, 0xd7a63f], [45, -3, 0x2a5aa8],
      [11, 21, 0x2f7a4d], [33, 41, 0x7d3f8f], [58, 20, 0xb02a33],
      [52, 36, 0xd7a63f], [8, -6, 0x2f7a4d],
    ];

    for (const [px, pz, hex] of TRADES) {
      const plot = PLOTS.find((p) => p[0] === px && p[1] === pz);
      if (!plot) continue;
      const [x, z, ry, w, d] = plot;
      const c = Math.cos(ry);
      const s = Math.sin(ry);
      // Front wall plane: the house's local +Z face.
      const fx = x + s * (d / 2 + 0.1);
      const fz = z + c * (d / 2 + 0.1);
      const y = this._height(x, z);

      /* ---- Hanging trade sign --------------------------------------- *
       * Set 0.9m off the door so it breaks the wall silhouette rather than
       * sitting on the lintel, and hung on a real bracket with a real
       * gap - a sign flush to a wall is a poster. */
      const ox = c * 1.9;
      const oz = -s * 1.9;
      const sy = y + 3.05;
      B.add('iron', boxGeo(0.07, 0.07, 0.95, 1.8),
        place(fx + ox, sy, fz + oz + 0.42, ry), 0x2f2a24);
      B.add('iron', boxGeo(0.06, 0.62, 0.06, 2.0),
        place(fx + ox + s * 0.86, sy - 0.28, fz + oz + c * 0.86, ry), 0x2f2a24);
      B.add('iron', boxGeo(0.05, 0.36, 0.05, 2.2),
        place(fx + ox + s * 0.86, sy - 0.22, fz + oz + c * 0.86, ry), 0x322c26);
      B.add('plank', boxGeo(0.94, 0.74, 0.08, 1.3),
        place(fx + ox + s * 0.88, sy - 0.72, fz + oz + c * 0.88, ry), 0xc9a15a);
      B.add('banner', planeGeo(0.62, 0.44, 0),
        place(fx + ox + s * 0.98, sy - 0.72, fz + oz + c * 0.98, ry), hex);

      /* ---- Bracket lantern on the other side of the door ------------- */
      const lx = fx - c * 1.9 + s * 0.14;
      const lz = fz + s * 1.9 + c * 0.14;
      B.add('iron', boxGeo(0.05, 0.05, 0.52, 2.0), place(lx, y + 2.72, lz + 0.24, ry), 0x2f2a24);
      B.add('iron', boxGeo(0.26, 0.36, 0.26, 1.6),
        place(lx + s * 0.44, y + 2.48, lz + c * 0.44, ry), 0x332d26);
      B.add('ember', boxGeo(0.18, 0.24, 0.18, 2.0),
        place(lx + s * 0.44, y + 2.48, lz + c * 0.44, ry), 0xffb264);
      this._addGlow(lx + s * 0.62, y + 2.4, lz + c * 0.62, 2.6, 0x4a2a12, ry);
      this._addGlow(lx + s * 0.5, y + 0.09, lz + c * 0.5, 5.0, 0x40230f);

      /* ---- Drying line, window to yard pole -------------------------- *
       * The only element in the village that spans the street volume rather
       * than clinging to a wall, which is exactly what the 3-4m band needed. */
      const poleX = fx + c * (w * 0.34) + s * 4.6;
      const poleZ = fz - s * (w * 0.34) + c * 4.6;
      const py = this._height(poleX, poleZ);
      B.add('beam', cylGeo(0.07, 0.09, 3.6, 7, 1.2), place(poleX, py + 1.8, poleZ), 0x7a6144);
      const ax = fx - c * (w * 0.28);
      const az = fz + s * (w * 0.28);
      const ay = y + 3.55;
      const span = Math.hypot(poleX - ax, poleZ - az);
      const midY = (ay + py + 3.6) * 0.5 - 0.28;
      _obj.position.set((ax + poleX) / 2, midY, (az + poleZ) / 2);
      _obj.rotation.set(0, MedievalWorld._yaw(poleX - ax, poleZ - az), 0);
      _obj.scale.set(1, 1, 1);
      B.add('iron', boxGeo(span, 0.035, 0.035, 2.4), _obj, 0x6b6154);
      const sheets = 3 + ((rnd() * 3) | 0);
      for (let k = 0; k < sheets; k++) {
        const t = (k + 1) / (sheets + 1);
        const hx2 = ax + (poleX - ax) * t;
        const hz2 = az + (poleZ - az) * t;
        const hy = lerp(ay, py + 3.6, t) - 0.30 - Math.sin(t * Math.PI) * 0.18;
        _obj.position.set(hx2, hy - 0.34, hz2);
        _obj.rotation.set(0, MedievalWorld._yaw(poleX - ax, poleZ - az), 0);
        B.add('banner', planeGeo(0.62, 0.72, 0), _obj,
          [0xe8e0cc, 0xd8cbb0, 0xc9b9a0, 0xb8a98e][k % 4]);
      }

      /* ---- Crates and a woodpile against the blank return wall ------- */
      const rx = x + c * (w / 2 + 0.55);
      const rz2 = z - s * (w / 2 + 0.55);
      const ry2 = this._height(rx, rz2);
      for (let k = 0; k < 3; k++) {
        const off = (k - 1) * 0.95;
        B.add('plank', boxGeo(0.72, 0.6, 0.72, 1.3),
          place(rx + s * off, ry2 + 0.3 + (k === 1 ? 0.62 : 0), rz2 + c * off, ry + rnd() * 0.2),
          0xa07f52);
      }
      for (let row = 0; row < 3; row++) {
        for (let k = 0; k < 4; k++) {
          _obj.position.set(
            rx - s * (1.9 + k * 0.24),
            ry2 + 0.14 + row * 0.235,
            rz2 - c * (1.9 + k * 0.24)
          );
          _obj.rotation.set(0, ry, Math.PI / 2);
          _obj.scale.set(1, 1, 1);
          B.add('beam', cylGeo(0.1, 0.11, 1.3, 7, 1.2), _obj, row % 2 ? 0x8a6c4a : 0x7a5f42);
        }
      }
      this._contacts.push(rx, ry2, rz2, 1.5);
      this._contacts.push(poleX, py, poleZ, 0.5);
    }
  }

  /**
   * A soiled contact skirt around every dwelling.
   *
   * Grass and cobble met plaster on a hard line with no occlusion gradient at
   * all, so every building read as pasted onto the terrain rather than founded
   * in it. This is one multiply-blended sheet - it darkens whatever is under
   * it, so it works over cobble, mud and grass alike and it tracks the scene
   * lighting instead of stamping a fixed grey ring.
   */
  _buildGroundSkirts() {
    const rects = [];
    for (const p of PLOTS) rects.push({ x: p[0], z: p[1], r: p[2], hx: p[3] / 2, hz: p[4] / 2 });
    for (const e of EXTRA_YARDS) rects.push({ x: e.x, z: e.z, r: e.r, hx: e.w / 2, hz: e.d / 2 });

    /* Round 5. The skirt reached 1.25m past the wall while the cobbled apron
     * reaches 2.1m, so there was a bright unoccluded ring of paving between
     * where the darkening stopped and where the yard ended - which is precisely
     * the band every reviewer described as a white slab. It also topped out at
     * 40-56% darkening, which is a smudge, not an occlusion contact. A real
     * wall-to-ground junction at golden hour is close to black in the first
     * 30cm: the sky is fully occluded there and the key cannot reach it.
     *
     * OUT is now 2.45m (past the apron rim), the falloff is squared so the
     * gradient is tight against the wall instead of a broad haze, and the
     * darkening at the wall face reaches 78%. N is raised so the ramp has
     * enough vertices to resolve that tighter curve.
     */
    const N = 14;
    const OUT = 2.45;
    const pos = [];
    const nrm = [];
    const uv = [];
    const col = [];
    const idx = [];
    for (const p of rects) {
      const hx = p.hx + OUT;
      const hz = p.hz + OUT;
      const c = Math.cos(p.r);
      const s = Math.sin(p.r);
      const base = pos.length / 3;
      for (let j = 0; j <= N; j++) {
        for (let i = 0; i <= N; i++) {
          const lx = (i / N - 0.5) * 2 * hx;
          const lz = (j / N - 0.5) * 2 * hz;
          const wx = p.x + lx * c + lz * s;
          const wz = p.z - lx * s + lz * c;
          pos.push(wx, this._height(wx, wz) + 0.04, wz);
          nrm.push(0, 1, 0);
          uv.push(i / N, j / N);
          const out = Math.max(0, rectDist(lx, lz, p.hx, p.hz));
          // Squared falloff: 78% at the wall, ~40% at half a metre, gone by
          // 2.45m. A linear ramp over the same run reads as a soft grey halo;
          // the square reads as contact.
          const a = Math.pow(1 - smoothstep(0, OUT, out), 2.1);
          // Multiply blending: 1.0 is transparent, lower is darker. Blue is
          // pulled hardest so the skirt warms as well as darkens.
          col.push(1 - a * 0.68, 1 - a * 0.73, 1 - a * 0.80);
        }
      }
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const a = base + j * (N + 1) + i;
          const b = a + N + 1;
          idx.push(a, b, b + 1, a, b + 1, a + 1);
        }
      }
    }
    if (!idx.length) return;

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      blending: THREE.MultiplyBlending,
      // three installs (DST_COLOR, ZERO) for multiply blending, which is only
      // correct on premultiplied alpha - and it warns once per frame otherwise.
      premultipliedAlpha: true,
      transparent: true,
      depthWrite: false,
      fog: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -6,
    });
    mat.name = 'medieval.skirt';
    this._mats.skirt = mat;
    this._owned.push(mat, g);
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'medieval:skirts';
    mesh.renderOrder = 1;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    this.group.add(mesh);
  }

  /**
   * Author the village-to-castle approach.
   *
   * This is the band a marketing frame has to sell and it was bare terrain
   * plus scattered bush blobs: no fences, no carts, no woodpiles, no ruts, no
   * silhouettes. Scatter cannot fix that - `rnd()` never produces a composed
   * group, it produces an even sprinkle. So the corridor is laid out by hand:
   * a wattle run following the cobble edge, waymarkers at a walking rhythm, a
   * shrine at the midpoint, and six authored roadside clusters (cart load,
   * woodpile, leaning ladder, sack stack) at anchors chosen off the spline.
   *
   * @param {GeoBatch} B @param {() => number} rnd
   */
  _approachDressing(B, rnd) {
    const road = this._roadPaths.find((r) => r.key === 'castle');
    if (!road) return;
    const place = (x, y, z, ry = 0) => {
      _obj.position.set(x, y, z);
      _obj.rotation.set(0, ry, 0);
      _obj.scale.set(1, 1, 1);
      return _obj;
    };

    /* ---- Wattle fence hugging both verges --------------------------- */
    const pts = road.pts;
    const off = road.width / 2 + 1.35;
    let run = 0;
    let gate = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i];
      const [bx, bz] = pts[i + 1];
      const dx = bx - ax;
      const dz = bz - az;
      const len = Math.hypot(dx, dz) || 1;
      const ux = dx / len;
      const uz = dz / len;
      const yaw = MedievalWorld._yaw(ux, uz);
      for (let s = 0; s < len; s += 0.52) {
        run += 0.52;
        gate += 1;
        // Field gates and collapsed sections: an unbroken run of identical
        // stakes is a fence texture, not a fence.
        if (gate % 46 < 5) continue;
        if (rnd() < 0.04) continue;
        for (const side of [-1, 1]) {
          const px = ax + ux * s - uz * side * off;
          const pz = az + uz * s + ux * side * off;
          if (this._inFootprint(px, pz, 0.6) || this._isPaved(px, pz, 0.3)) continue;
          const py = this._height(px, pz);
          _obj.position.set(px, py + 0.52 + rnd() * 0.06, pz);
          _obj.rotation.set((rnd() - 0.5) * 0.1, yaw + (rnd() - 0.5) * 0.22, (rnd() - 0.5) * 0.14);
          _obj.scale.set(1, 1, 1);
          B.add('beam', boxGeo(0.075, 1.06, 0.075, 1.9), _obj, rnd() < 0.5 ? 0x7a6144 : 0x6a5238);
        }
        // Woven rails, one span in three.
        if (Math.round(run / 0.52) % 3 === 0) {
          for (const side of [-1, 1]) {
            const px = ax + ux * (s + 0.52) - uz * side * off;
            const pz = az + uz * (s + 0.52) + ux * side * off;
            const py = this._height(px, pz);
            for (const yy of [0.34, 0.78]) {
              _obj.position.set(px, py + yy, pz);
              _obj.rotation.set(0, yaw, (rnd() - 0.5) * 0.06);
              B.add('beam', boxGeo(1.6, 0.055, 0.05, 1.6), _obj, 0x86694a);
            }
          }
        }
      }
    }

    /* ---- Waymarkers, so the road has a walking rhythm ---------------- */
    for (let i = 1; i < pts.length - 1; i += 3) {
      const [px0, pz0] = pts[i];
      const px = px0 - 4.4;
      const pz = pz0 + 1.2;
      const py = this._height(px, pz);
      B.add('rock', boxGeo(0.42, 1.35, 0.34, 0.8),
        place(px, py + 0.6, pz, rnd() * 0.5), 0xcdc4ae);
      B.add('rock', boxGeo(0.5, 0.16, 0.42, 1.0), place(px, py + 1.32, pz, rnd() * 0.5), 0xbfb6a0);
    }

    /* ---- Wayside shrine at the midpoint ------------------------------ */
    {
      const [sx, sz] = pts[Math.floor(pts.length * 0.5)];
      const px = sx - 5.4;
      const pz = sz + 2.6;
      const py = this._height(px, pz);
      B.add('rubble', boxGeo(1.5, 0.5, 1.2, 0.7), place(px, py + 0.25, pz, 0.3), 0xd6cdb8);
      B.add('rubble', boxGeo(1.1, 2.3, 0.9, 0.6), place(px, py + 1.6, pz, 0.3), 0xdcd3be);
      B.add('slate', boxGeo(1.35, 0.22, 1.1, 0.9), place(px, py + 2.85, pz, 0.3), 0xa8b2be);
      B.add('beam', boxGeo(0.16, 1.1, 0.16, 1.4), place(px, py + 3.45, pz, 0.3), 0x6f5539);
      B.add('beam', boxGeo(0.7, 0.16, 0.16, 1.4), place(px, py + 3.72, pz, 0.3), 0x6f5539);
      B.add('ember', boxGeo(0.16, 0.2, 0.16, 2.0), place(px + 0.42, py + 1.9, pz, 0.3), 0xffb264);
      this._addGlow(px + 0.5, py + 0.1, pz + 0.2, 4.0, 0x412310);
      this._box(px, py + 1.4, pz, 0.7, 1.4, 0.6);
    }

    /* ---- Six authored roadside groups -------------------------------- */
    const groups = [
      [-6.5, -44, 0.5], [2.5, -27, 2.1], [8.5, -13, 0.9],
      [16, -1.5, 3.6], [26.5, 8.5, 1.4], [-11, -53, 5.0],
    ];
    groups.forEach(([gx, gz, gr], gi) => {
      const gy = this._height(gx, gz);
      const kind = gi % 3;
      if (kind === 0) {
        // Woodpile under a lean-to of stacked hurdles.
        for (let row = 0; row < 4; row++) {
          for (let k = 0; k < 5; k++) {
            _obj.position.set(gx + (k - 2) * 0.025, gy + 0.14 + row * 0.235,
              gz + (k - 2) * 0.25 + (row % 2) * 0.1);
            _obj.rotation.set(0, gr, Math.PI / 2);
            _obj.scale.set(1, 1, 1);
            B.add('beam', cylGeo(0.11, 0.12, 1.5, 7, 1.2), _obj, row % 2 ? 0x8a6c4a : 0x7a5f42);
          }
        }
        B.add('plank', boxGeo(0.78, 0.66, 0.78, 1.3),
          place(gx + 1.5, gy + 0.33, gz - 0.7, gr + 0.6), 0xa07f52);
        this._box(gx, gy + 0.55, gz, 0.9, 0.55, 0.8);
      } else if (kind === 1) {
        // Sack stack and two barrels waiting for a cart.
        for (let k = 0; k < 3; k++) {
          B.add('plank', cylGeo(0.34, 0.3, 0.94, 12, 1.0),
            place(gx + Math.cos(gr + k * 2.1) * 0.6, gy + 0.47,
              gz + Math.sin(gr + k * 2.1) * 0.6, rnd() * TAU), 0x8f6f47);
        }
        for (let k = 0; k < 4; k++) {
          const sg = new THREE.IcosahedronGeometry(0.34, 1);
          sg.scale(1.0, 1.2, 0.85);
          MedievalWorld._uvScale(sg, 1.6);
          B.add('canopy', sg, place(gx + 1.6 + (k % 2) * 0.5, gy + 0.4 + (k > 1 ? 0.6 : 0),
            gz + 1.1 + (k > 1 ? 0.1 : 0), k * 1.3), k % 2 ? 0xd8cdb0 : 0xc4b898);
        }
        this._box(gx, gy + 0.5, gz, 1.0, 0.5, 1.0);
      } else {
        // A ladder laid flat on the ground beside a trough. It used to lean
        // 0.28 rad against a stack that was never built, so it read as a
        // ladder standing unsupported in mid-air.
        const ux = Math.cos(gr);
        const uz = -Math.sin(gr);
        const px2 = Math.sin(gr);
        const pz2 = Math.cos(gr);
        for (const s of [-0.22, 0.22]) {
          _obj.position.set(gx + px2 * s, gy + 0.08, gz + pz2 * s);
          _obj.rotation.set(0, gr, 0);
          _obj.scale.set(1, 1, 1);
          B.add('beam', boxGeo(3.1, 0.08, 0.09, 1.5), _obj, 0x8a6c4a);
        }
        for (let k = 0; k < 8; k++) {
          const t = -1.33 + k * 0.38;
          _obj.position.set(gx + ux * t, gy + 0.12, gz + uz * t);
          _obj.rotation.set(0, gr, 0);
          _obj.scale.set(1, 1, 1);
          B.add('beam', boxGeo(0.06, 0.06, 0.5, 1.6), _obj, 0x7a5f42);
        }
        B.add('plank', boxGeo(1.7, 0.42, 0.6, 1.1),
          place(gx + 1.7, gy + 0.24, gz + 0.8, gr), 0x9a7a50);
        this._box(gx + 1.7, gy + 0.3, gz + 0.8, 0.9, 0.3, 0.35);
      }
      this._contacts.push(gx, gy, gz, 1.5);
    });

    /* ---- A hurdled fold of sheep on the approach --------------------- *
     * Livestock is the cheapest possible "this place is inhabited" signal at
     * hero-shot distance: eight pale blobs the size of a person, moving or
     * not, immediately establish both scale and occupancy on ground that was
     * otherwise undifferentiated olive. */
    {
      const px0 = -8;
      const pz0 = -24;
      const hw = 6.5;
      const hd = 5.5;
      for (const [ax, az, bx, bz] of [
        [px0 - hw, pz0 - hd, px0 + hw, pz0 - hd],
        [px0 + hw, pz0 - hd, px0 + hw, pz0 + hd],
        [px0 - hw, pz0 + hd, px0 + hw, pz0 + hd],
        [px0 - hw, pz0 - hd, px0 - hw, pz0 + hd],
      ]) {
        const dx = bx - ax;
        const dz = bz - az;
        const len = Math.hypot(dx, dz);
        const yaw = MedievalWorld._yaw(dx / len, dz / len);
        const n = Math.round(len / 1.8);
        for (let i = 0; i <= n; i++) {
          const qx = ax + (dx * i) / n;
          const qz = az + (dz * i) / n;
          B.add('beam', boxGeo(0.11, 1.15, 0.11, 1.6),
            place(qx, this._height(qx, qz) + 0.5, qz, yaw + (rnd() - 0.5) * 0.2), 0x7a6144);
        }
        for (const yy of [0.42, 0.86]) {
          B.add('beam', boxGeo(len, 0.07, 0.05, 1.4),
            place((ax + bx) / 2, this._height((ax + bx) / 2, (az + bz) / 2) + yy,
              (az + bz) / 2, yaw), 0x86694a);
        }
      }
      for (let i = 0; i < 9; i++) {
        const sx = px0 + (rnd() - 0.5) * (hw * 1.5);
        const sz = pz0 + (rnd() - 0.5) * (hd * 1.5);
        const sy = this._height(sx, sz);
        const sr = rnd() * TAU;
        const body = new THREE.IcosahedronGeometry(0.42, 1);
        body.scale(1.55, 0.98, 0.9);
        MedievalWorld._uvScale(body, 2.4);
        B.add('canopy', body, place(sx, sy + 0.66, sz, sr), rnd() < 0.2 ? 0x6b6157 : 0xe2dbc9);
        B.add('beam', boxGeo(0.2, 0.22, 0.2, 1.8),
          place(sx + Math.cos(sr) * 0.62, sy + 0.72, sz - Math.sin(sr) * 0.62, sr), 0x3a322a);
        for (const lx of [-0.36, 0.36]) {
          for (const lz of [-0.22, 0.22]) {
            B.add('beam', boxGeo(0.075, 0.44, 0.075, 1.8), place(
              sx + Math.cos(sr) * lx + Math.sin(sr) * lz, sy + 0.22,
              sz - Math.sin(sr) * lx + Math.cos(sr) * lz, sr), 0x3a322a);
          }
        }
        this._contacts.push(sx, sy, sz, 0.72);
      }
    }

    /* ---- Laundry strung between the jettied gables by the square ----- */
    const lines = [[[16, 8.5, 6.4], [11.5, 19.5, 6.0]], [[35.5, 42.5, 6.2], [39.5, 46.5, 6.0]]];
    for (const [[ax, az, ay], [bx, bz, by]] of lines) {
      const dx = bx - ax;
      const dz = bz - az;
      const len = Math.hypot(dx, dz);
      const yaw = MedievalWorld._yaw(dx / len, dz / len);
      const my = this._height((ax + bx) / 2, (az + bz) / 2);
      B.add('iron', boxGeo(len, 0.035, 0.035, 2.0),
        place((ax + bx) / 2, my + (ay + by) / 2 - 0.25, (az + bz) / 2, yaw), 0x2f2a24);
      for (let k = 1; k < 7; k++) {
        const t = k / 7;
        const sag = Math.sin(t * Math.PI) * 0.28;
        _obj.position.set(ax + dx * t, my + lerp(ay, by, t) - 0.42 - sag, az + dz * t);
        _obj.rotation.set(0, yaw, 0);
        _obj.scale.set(1, 1, 1);
        B.add('banner', planeGeo(0.62, 0.8 + rnd() * 0.4, 0), _obj,
          [0xe8ddc6, 0xcbd6dd, 0xd8c6a8, 0xbfc9b4][k % 4]);
      }
    }

    /* ---- The vale drove road: hedgerow and waymarkers ---------------- *
     * A road that only exists as a change of ground albedo cannot survive
     * 110m of aerial perspective. A run of vertical elements can: a hedgerow
     * and a post-and-rail line read as a continuous linear silhouette at any
     * distance the terrain itself is still visible at, which is what turns a
     * painted track into a route the eye can follow to the gatehouse. */
    const vale = this._roadPaths.find((r) => r.key === 'vale');
    if (vale) {
      const vpts = vale.pts;
      const voff = vale.width / 2 + 1.5;
      let step = 0;
      for (let i = 0; i < vpts.length - 1; i++) {
        const [ax, az] = vpts[i];
        const [bx2, bz2] = vpts[i + 1];
        const dx = bx2 - ax;
        const dz = bz2 - az;
        const len = Math.hypot(dx, dz) || 1;
        const ux = dx / len;
        const uz = dz / len;
        const yaw = MedievalWorld._yaw(ux, uz);
        for (let s = 0; s < len; s += 1.9) {
          step++;
          // Gaps for gateways and gaps where the hedge has simply died out.
          if (step % 29 < 3) continue;
          for (const side of [-1, 1]) {
            // Only one verge carries the hedge for long stretches: two
            // unbroken parallel lines read as a runway.
            if (side > 0 && step % 3 !== 0) continue;
            const px = ax + ux * s - uz * side * voff;
            const pz = az + uz * s + ux * side * voff;
            if (this._inFootprint(px, pz, 0.8)) continue;
            const py = this._height(px, pz);
            if (py < WATER_Y + 0.6) continue;
            // Post.
            _obj.position.set(px, py + 0.62, pz);
            _obj.rotation.set((rnd() - 0.5) * 0.08, yaw + (rnd() - 0.5) * 0.18, (rnd() - 0.5) * 0.1);
            _obj.scale.set(1, 1, 1);
            B.add('beam', boxGeo(0.1, 1.28, 0.1, 1.8), _obj, rnd() < 0.5 ? 0x7a6144 : 0x6a5238);
            // Two rails between posts.
            for (const yy of [0.46, 0.98]) {
              _obj.position.set(px + ux * 0.95, py + yy, pz + uz * 0.95);
              _obj.rotation.set(0, yaw, (rnd() - 0.5) * 0.05);
              B.add('beam', boxGeo(1.95, 0.075, 0.055, 1.5), _obj, 0x86694a);
            }
            // Hawthorn in the hedge line, every few posts.
            if (step % 4 === 0) {
              _obj.position.set(px - uz * side * 0.5, py + 0.42, pz + ux * side * 0.5);
              _obj.rotation.set(0, rnd() * TAU, 0);
              _obj.scale.set(1.35, 1.1, 1.35);
              B.add('leaf', new THREE.IcosahedronGeometry(0.62, 1), _obj,
                rnd() < 0.5 ? 0x5c7440 : 0x4b6236);
            }
          }
        }
      }
      // Milestones on the walk, so the route has a rhythm and a scale.
      for (let i = 1; i < vpts.length - 1; i += 2) {
        const [mx, mz] = vpts[i];
        const px = mx + 4.9;
        const pz = mz + 0.8;
        const py = this._height(px, pz);
        B.add('rock', boxGeo(0.46, 1.5, 0.36, 0.8),
          place(px, py + 0.66, pz, rnd() * 0.5), 0xcdc4ae);
        B.add('rock', boxGeo(0.56, 0.18, 0.46, 1.0),
          place(px, py + 1.5, pz, rnd() * 0.5), 0xbfb6a0);
        this._contacts.push(px, py, pz, 0.5);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Bridge, mill and church                                           */
  /* ---------------------------------------------------------------- */

  /** Segmental masonry arch in the ZY plane, springing at `ys`. */
  _arch(B, key, cx, z0, z1, ys, rise, width, thick, tint) {
    const c = Math.abs(z1 - z0);
    const R = (c * c) / 4 / (2 * rise) + rise / 2;
    const zc = (z0 + z1) / 2;
    const yc = ys + rise - R;
    const a = Math.asin(Math.min(1, c / 2 / R));
    const n = 17;
    for (let i = 0; i < n; i++) {
      const th = -a + ((i + 0.5) / n) * 2 * a;
      const rad = R + thick / 2;
      _obj.position.set(cx, yc + Math.cos(th) * rad, zc + Math.sin(th) * rad);
      _obj.rotation.set(th, 0, 0);
      _obj.scale.set(1, 1, 1);
      B.add(key, boxGeo(width, thick, ((2 * a * R) / n) * 1.18, 0.55), _obj, tint);
    }
    // Spandrel fill either side of the arch so it reads as solid masonry.
    for (const s of [-1, 1]) {
      const zz = zc + s * (c / 2 - 1.2);
      _obj.position.set(cx, ys + rise * 0.42, zz);
      _obj.rotation.set(0, 0, 0);
      B.add(key, boxGeo(width - 0.4, rise * 0.84, 2.4, 0.5), _obj, tint);
    }
  }

  _buildRiverside() {
    const B = new GeoBatch();
    const stone = 0xc7bfac;
    const place = (x, y, z, ry = 0) => {
      _obj.position.set(x, y, z);
      _obj.rotation.set(0, ry, 0);
      _obj.scale.set(1, 1, 1);
      return _obj;
    };

    /* ---- Stone bridge --------------------------------------------- */
    const bx = BRIDGE_X;
    const rz = riverZ(bx);
    const z0 = rz - 13;
    const z1 = rz + 13;
    const deckY = 4.35;
    const springY = 1.5;
    const bw = 7.0;
    const pierZ = rz;

    this._arch(B, 'rubble', bx, z0 + 0.6, pierZ - 1.4, springY, 2.2, bw, 0.85, stone);
    this._arch(B, 'rubble', bx, pierZ + 1.4, z1 - 0.6, springY, 2.2, bw, 0.85, stone);
    // Central pier with cutwaters.
    B.add('rubble', boxGeo(bw, 5.6, 2.8, 0.5), place(bx, springY - 1.2, pierZ), stone);
    for (const s of [-1, 1]) {
      const g = new THREE.CylinderGeometry(1.4, 1.6, 5.6, 3);
      MedievalWorld._uvScale(g, 0.5);
      B.add('rubble', g, place(bx, springY - 1.2, pierZ + s * 2.2, s > 0 ? 0 : Math.PI), stone);
    }
    this._box(bx, springY - 1.2, pierZ, bw / 2, 2.8, 2.2);
    // Abutments.
    for (const s of [-1, 1]) {
      B.add('rubble', boxGeo(bw + 2.4, 6.0, 4.0, 0.5), place(bx, deckY - 3.2, rz + s * 14.4), stone);
      this._box(bx, deckY - 3.2, rz + s * 14.4, (bw + 2.4) / 2, 3.0, 2.0);
    }
    // Deck and parapets.
    B.add('cobble', boxGeo(bw, 0.7, 30, 0.55), place(bx, deckY - 0.35, rz), 0xbcb6a8);
    this._box(bx, deckY - 0.4, rz, bw / 2, 0.4, 15);
    for (const s of [-1, 1]) {
      B.add('rubble', boxGeo(0.55, 1.15, 29, 0.6), place(bx + s * (bw / 2 - 0.28), deckY + 0.58, rz), stone);
      B.add('rubble', boxGeo(0.75, 0.16, 29, 0.8), place(bx + s * (bw / 2 - 0.28), deckY + 1.22, rz), 0xb6ae9b);
      this._box(bx + s * (bw / 2 - 0.28), deckY + 0.7, rz, 0.4, 0.8, 14.5);
    }
    this._footprints.push({ x: bx, z: rz, hx: 6, hz: 16, r: 0 });

    /* ---- Water mill ----------------------------------------------- */
    const mx = -13;
    const mrz = riverZ(mx);
    const mz = mrz - 11.5;
    const mill = this._house(B, {
      x: mx, z: mz, ry: 0.06, w: 11, d: 8, storeys: 2,
      roof: 'thatch', jetty: false, lit: true, light: true, seed: 0x111a,
    });
    // Undershot wheel on a merged geometry so the whole thing is one draw call.
    const wheelParts = [];
    const push = (g, x, y, z, rx, ry2, rz2) => {
      _obj.position.set(x, y, z);
      _obj.rotation.set(rx || 0, ry2 || 0, rz2 || 0);
      _obj.scale.set(1, 1, 1);
      _obj.updateMatrix();
      g.applyMatrix4(_obj.matrix);
      wheelParts.push(normaliseGeo(g, 0x9c7a4e));
    };
    push(cylGeo(0.5, 0.5, 2.6, 12, 1.0), 0, 0, 0, 0, 0, Math.PI / 2);
    for (const s of [-1, 1]) {
      const ring = new THREE.TorusGeometry(3.1, 0.16, 6, 28);
      MedievalWorld._uvScale(ring, 0.5);
      push(ring, s * 1.2, 0, 0, 0, Math.PI / 2, 0);
    }
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * TAU;
      push(boxGeo(0.16, 3.1, 0.16, 1.2), 0, Math.cos(a) * 1.55, Math.sin(a) * 1.55, a, 0, 0);
      push(boxGeo(2.5, 0.1, 0.72, 0.9), 0, Math.cos(a) * 2.9, Math.sin(a) * 2.9, a, 0, 0);
    }
    const wheelGeo = mergeGeometries(wheelParts, false);
    for (const g of wheelParts) g.dispose();
    const wheel = new THREE.Mesh(wheelGeo, this._mats.plank);
    wheel.castShadow = true;
    wheel.receiveShadow = true;
    const pivot = new THREE.Object3D();
    pivot.position.set(mx + 6.6, 3.0, mz + 5.2);
    pivot.add(wheel);
    this.group.add(pivot);
    this._wheel = pivot;
    // Axle housing, headrace flume and sacks of flour.
    B.add('beam', boxGeo(1.4, 0.5, 0.5, 1.0), place(mx + 5.6, 3.0, mz + 5.2), 0x7a5f42);
    B.add('plank', boxGeo(9, 0.22, 1.6, 0.8), place(mx + 3.0, 4.6, mz + 7.4, 0.1), 0xa08256);
    for (const s of [-1, 1]) {
      B.add('plank', boxGeo(9, 0.7, 0.18, 0.9), place(mx + 3.0, 4.9, mz + 7.4 + s * 0.7, 0.1), 0x9a7a50);
    }
    for (let i = 0; i < 5; i++) {
      B.add('canopy', boxGeo(0.8, 0.9, 0.6, 1.0),
        place(mx - 5.5 + i * 0.9, mill.baseY + 0.45, mz + 5.6, i * 0.4), 0xd8cdb0);
    }
    this._box(mx + 6.6, 1.4, mz + 5.2, 1.6, 1.4, 3.4);

    /* ---- Church of St Aldern ---------------------------------------- */
    const chx = 66;
    const chz = -8;
    const naveHW = 11;
    const naveHD = 5.5;
    const naveH = 9.5;
    const stoneC = 0xcfc9b9;
    const wall = (cx, cy, cz, hx, hy, hz, tint, tile = 0.45) => {
      B.add('ashlar', boxGeo(hx * 2, hy * 2, hz * 2, tile), place(cx, cy, cz), tint);
      this._box(cx, cy, cz, hx, hy, hz);
    };
    const gy = this._height(chx, chz);
    wall(chx, gy + naveH / 2, chz - naveHD, naveHW, naveH / 2, 0.7, stoneC);
    wall(chx, gy + naveH / 2, chz + naveHD, naveHW, naveH / 2, 0.7, stoneC);
    wall(chx + naveHW, gy + naveH / 2, chz, 0.7, naveH / 2, naveHD, stoneC);
    B.add('ashlar', boxGeo(naveHW * 2 + 2, 1.0, naveHD * 2 + 2, 0.5), place(chx, gy + 0.5, chz), 0xc0b8a4);
    // Apse.
    B.add('ashlar', cylGeo(4.6, 4.8, naveH, 16, 0.45), place(chx + naveHW + 1.6, gy + naveH / 2, chz), stoneC);
    B.add('slate', coneGeo(5.2, 3.2, 16, 0.7), place(chx + naveHW + 1.6, gy + naveH + 1.6, chz), 0xa8b2be);
    this._ringWall(chx + naveHW + 1.6, gy + naveH / 2, chz, 4.8, naveH / 2, 0.7, 8);
    // Steep slate roof over the nave.
    for (const s of [-1, 1]) {
      const g = boxGeo(naveHW * 2 + 1.6, 0.3, 8.4, 0.7);
      _obj.position.set(chx, gy + naveH + 2.6, chz + s * 3.0);
      _obj.rotation.set(s * 0.72, 0, 0);
      _obj.scale.set(1, 1, 1);
      B.add('slate', g, _obj, 0xa8b2be);
    }
    B.add('slate', boxGeo(naveHW * 2 + 1.8, 0.3, 0.6, 0.9), place(chx, gy + naveH + 5.0, chz), 0x9aa4b0);
    // Buttresses.
    for (let i = -2; i <= 2; i++) {
      for (const s of [-1, 1]) {
        B.add('ashlar', boxGeo(1.5, naveH * 0.86, 1.5, 0.55),
          place(chx + i * 5.2, gy + naveH * 0.43, chz + s * (naveHD + 0.9)), 0xc7bfac);
        B.add('ashlar', boxGeo(1.7, 0.35, 1.7, 0.8),
          place(chx + i * 5.2, gy + naveH * 0.86, chz + s * (naveHD + 0.9)), 0xb6ae9b);
      }
    }
    // Lancet windows with stained glass. The +2.6 offset centres each pane in
    // the bay east of its buttress, so the run must stop at i=1: an i=2 pane
    // would land at x=chx+13 - past the nave's east end, floating over the apse.
    for (let i = -2; i <= 1; i++) {
      for (const s of [-1, 1]) {
        const wz = chz + s * (naveHD + 0.75);
        B.add('glass', planeGeo(1.3, 3.6, 0.9), place(chx + i * 5.2 + 2.6, gy + 5.2, wz,
          s > 0 ? 0 : Math.PI), HERALD[(i + 2) % HERALD.length]);
        const m = new THREE.Matrix4().makeRotationY(s > 0 ? 0 : Math.PI)
          .setPosition(chx + i * 5.2 + 2.6, gy + 7.0, wz);
        this._archRing(B, 'ashlar', m, 0.68, 0.26, 0.28, 0xc7bfac);
      }
    }
    // Bell tower and spire.
    const tx = chx - naveHW - 3.6;
    B.add('ashlar', boxGeo(8.0, 24, 8.0, 0.4), place(tx, gy + 12, chz), stoneC);
    for (const y2 of [7.0, 13.5, 19.0]) {
      B.add('ashlar', boxGeo(8.5, 0.32, 8.5, 0.7), place(tx, gy + y2, chz), 0xb6ae9b);
    }
    this._box(tx, gy + 12, chz, 4.0, 12, 4.0);
    B.add('ashlar', boxGeo(8.8, 0.5, 8.8, 0.7), place(tx, gy + 24.3, chz), 0xb6ae9b);
    for (const s of [-1, 1]) {
      B.add('iron', boxGeo(0.16, 3.0, 2.2, 1.4), place(tx + s * 4.0, gy + 21, chz), 0x2b2723);
      B.add('iron', boxGeo(2.2, 3.0, 0.16, 1.4), place(tx, gy + 21, chz + s * 4.0), 0x2b2723);
    }
    this._merlons(B, 'ashlar', tx - 4.2, chz - 4.2, tx + 4.2, chz - 4.2, gy + 24.5, 0.6, stoneC);
    this._merlons(B, 'ashlar', tx - 4.2, chz + 4.2, tx + 4.2, chz + 4.2, gy + 24.5, 0.6, stoneC);
    this._merlons(B, 'ashlar', tx - 4.2, chz - 4.2, tx - 4.2, chz + 4.2, gy + 24.5, 0.6, stoneC);
    this._merlons(B, 'ashlar', tx + 4.2, chz - 4.2, tx + 4.2, chz + 4.2, gy + 24.5, 0.6, stoneC);
    B.add('slate', coneGeo(5.0, 12.5, 4, 0.55), place(tx, gy + 33.4, chz, Math.PI / 4), 0x9aa4b0);
    B.add('iron', cylGeo(0.09, 0.09, 2.6, 6, 1.2), place(tx, gy + 40.6, chz), 0x2a2622);
    B.add('iron', boxGeo(1.6, 0.1, 0.1, 1.4), place(tx, gy + 41.4, chz), 0x2a2622);
    B.add('iron', cylGeo(1.0, 1.25, 1.6, 12, 0.9), place(tx, gy + 20.4, chz), 0x6a5a3a);
    // West door.
    B.add('plank', boxGeo(0.2, 3.6, 2.4, 0.8), place(tx - 4.0, gy + 1.8, chz), 0x6d4f30);
    const dm = new THREE.Matrix4().makeRotationY(-Math.PI / 2).setPosition(tx - 4.1, gy + 3.6, chz);
    this._archRing(B, 'ashlar', dm, 1.2, 0.36, 0.4, 0xc7bfac);
    // Churchyard: low wall and leaning headstones.
    const yrnd = mulberry32(0xc4a7);
    for (let i = 0; i < 22; i++) {
      const px = chx - 14 + yrnd() * 30;
      const pz = chz + (yrnd() < 0.5 ? -1 : 1) * (8 + yrnd() * 7);
      B.add('rock', boxGeo(0.6, 1.0, 0.16, 1.2),
        place(px, this._height(px, pz) + 0.45, pz, yrnd() * TAU), 0xbdb6a6);
    }
    this._footprints.push({ x: chx, z: chz, hx: 20, hz: 9, r: 0 });
    this._footprints.push({ x: mx, z: mz, hx: 9, hz: 10, r: 0 });

    /* ---- The ring's crossings --------------------------------------- *
     * Built into this batch rather than their own because they belong to the
     * same subject - the river and what gets over it - and because two of the
     * three are 300 m from the nearest other geometry, so a district of their
     * own would be three meshes with nothing else in them. See RoadNet.js for
     * which crossings exist and why. */
    this._buildCrossings(B);

    B.build(this._mats, this.group, { ao: this._heightFn });
  }
  /* ---------------------------------------------------------------- */
  /* Market square                                                     */
  /* ---------------------------------------------------------------- */

  _buildMarket() {
    const B = new GeoBatch();
    const rnd = mulberry32(0x3a12c);
    const MY = MARKET.y;
    const place = (x, y, z, ry = 0) => {
      _obj.position.set(x, y, z);
      _obj.rotation.set(0, ry, 0);
      _obj.scale.set(1, 1, 1);
      return _obj;
    };
    const tmp = new THREE.Matrix4();
    const local = (M, key, geo, lx, ly, lz, rx, ry2, rz, tint) => {
      _obj.position.set(lx, ly, lz);
      _obj.rotation.set(rx || 0, ry2 || 0, rz || 0);
      _obj.scale.set(1, 1, 1);
      _obj.updateMatrix();
      tmp.multiplyMatrices(M, _obj.matrix);
      B.add(key, geo, tmp, tint);
    };

    /** A trestle stall under a sagging striped awning. */
    const stall = (x, z, ry, kind, tint) => {
      const M = new THREE.Matrix4().makeRotationY(ry).setPosition(x, MY, z);
      const W = 3.6;
      const D = 2.4;
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          local(M, 'beam', boxGeo(0.14, 2.5, 0.14, 1.2), sx * W / 2, 1.25, sz * D / 2, 0, 0, 0, 0x6f5539);
        }
      }
      local(M, 'beam', boxGeo(W + 0.3, 0.12, 0.12, 1.2), 0, 2.5, -D / 2, 0, 0, 0, 0x6f5539);
      local(M, 'beam', boxGeo(W + 0.3, 0.12, 0.12, 1.2), 0, 2.2, D / 2, 0, 0, 0, 0x6f5539);
      // Awning: a plane pushed into a catenary so it reads as cloth, not card.
      const cg = new THREE.PlaneGeometry(W + 0.7, D + 1.5, 8, 6);
      const p = cg.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const u = p.getX(i) / (W + 0.7) + 0.5;
        const v = p.getY(i) / (D + 1.5) + 0.5;
        p.setZ(i, -Math.sin(u * Math.PI) * 0.28 - v * 0.1);
      }
      cg.computeVertexNormals();
      MedievalWorld._uvScale(cg, 2.3);
      local(M, 'canopy', cg, 0, 2.5, 0.05, -1.44, 0, 0, tint);
      // Trestle table.
      local(M, 'plank', boxGeo(W, 0.1, D * 0.75, 0.8), 0, 0.95, 0, 0, 0, 0, 0xc0a074);
      for (const sx of [-1, 1]) {
        local(M, 'beam', boxGeo(0.16, 0.9, D * 0.7, 1.0), sx * (W / 2 - 0.4), 0.47, 0, 0, 0, 0, 0x6f5539);
      }
      // Goods.
      if (kind === 'produce') {
        for (let i = 0; i < 26; i++) {
          const g = new THREE.IcosahedronGeometry(0.09 + rnd() * 0.05, 1);
          MedievalWorld._uvScale(g, 2);
          // Cloth rather than the leaf sheet: the leaf material is alpha-tested
          // now, and a 9cm sphere spans too little UV to survive the cutout.
          local(M, 'canopy', g, -W / 2 + 0.3 + rnd() * (W - 0.6), 1.06 + (rnd() < 0.3 ? 0.14 : 0),
            -0.6 + rnd() * 1.2, 0, 0, 0, rnd() < 0.5 ? 0xd4622e : 0x8fbf46);
        }
        for (let i = 0; i < 3; i++) {
          local(M, 'plank', boxGeo(0.7, 0.4, 0.55, 1.2), -1.2 + i * 1.2, 0.2, -0.9, 0, 0, 0, 0x9b7a4e);
        }
      } else if (kind === 'fish') {
        local(M, 'rock', boxGeo(W * 0.8, 0.08, D * 0.5, 1.0), 0, 1.04, 0, 0, 0, 0, 0xa8b0b4);
        for (let i = 0; i < 14; i++) {
          const g = new THREE.IcosahedronGeometry(0.14, 1);
          g.scale(2.4, 0.55, 1.0);
          MedievalWorld._uvScale(g, 2);
          local(M, 'iron', g, -1.3 + rnd() * 2.6, 1.12, -0.4 + rnd() * 0.8, 0, rnd() * 0.5, 0, 0xcfd6d2);
        }
      } else if (kind === 'cloth') {
        for (let i = 0; i < 7; i++) {
          local(M, 'banner', cylGeo(0.16, 0.16, 1.1, 10, 1.0), -1.3 + i * 0.44, 1.12, -0.2,
            0, 0, Math.PI / 2, HERALD[i % HERALD.length]);
        }
        for (let i = 0; i < 4; i++) {
          local(M, 'banner', boxGeo(0.9, 0.16, 0.7, 1.2), -1.2 + i * 0.8, 1.14, 0.6, 0, 0, 0,
            HERALD[(i + 2) % HERALD.length]);
        }
      } else if (kind === 'bread') {
        for (let i = 0; i < 18; i++) {
          const g = new THREE.IcosahedronGeometry(0.15, 1);
          g.scale(1.5, 0.7, 0.9);
          MedievalWorld._uvScale(g, 2);
          local(M, 'hay', g, -1.4 + rnd() * 2.8, 1.1, -0.5 + rnd() * 1.0, 0, rnd(), 0, 0xd9a862);
        }
      }
      this._footprints.push({ x, z, hx: W / 2 + 0.6, hz: D / 2 + 0.9, r: ry });
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const px = x + Math.cos(ry) * sx * W / 2 + Math.sin(ry) * sz * D / 2;
          const pz = z - Math.sin(ry) * sx * W / 2 + Math.cos(ry) * sz * D / 2;
          this._box(px, MY + 1.2, pz, 0.12, 1.2, 0.12);
        }
      }
    };

    stall(21, 8, 0.05, 'produce', 0xd9534a);
    stall(29, 7.5, -0.06, 'bread', 0xe0b455);
    stall(37, 8, 0.04, 'fish', 0x4f83c4);
    stall(45, 10, -0.32, 'cloth', 0x6fae6a);
    stall(22, 28, Math.PI + 0.05, 'cloth', 0xc06fb0);
    stall(31, 28.5, Math.PI - 0.04, 'produce', 0xd9534a);
    stall(43, 27, Math.PI + 0.22, 'bread', 0xe0b455);
    // An east row, so the square is enclosed on three sides rather than being
    // two facing rows across a void - and so the composed framing that looks
    // west into the market has striped awning in its middle distance instead
    // of forty metres of empty paving.
    stall(49.5, 14.5, Math.PI / 2 + 0.06, 'produce', 0xd9534a);
    stall(48.2, 23.0, Math.PI / 2 - 0.05, 'fish', 0x4f83c4);

    /* ---- Smithy ---------------------------------------------------- */
    const sx0 = 47;
    const sz0 = 20;
    B.add('rubble', boxGeo(3.2, 1.5, 2.6, 0.6), place(sx0, MY + 0.75, sz0), 0xa79e8b);
    B.add('rubble', boxGeo(1.4, 5.5, 1.4, 0.7), place(sx0 - 1.0, MY + 2.75, sz0 - 0.4), 0x9e9682);
    B.add('rubble', boxGeo(1.7, 0.26, 1.7, 0.9), place(sx0 - 1.0, MY + 5.6, sz0 - 0.4), 0x958d7b);
    B.add('ember', boxGeo(1.6, 0.35, 1.4, 1.2), place(sx0 + 0.4, MY + 1.6, sz0), 0xffb268);
    B.add('beam', boxGeo(0.9, 0.7, 0.9, 1.1), place(sx0 + 2.6, MY + 0.35, sz0 + 1.4), 0x6f5539);
    B.add('iron', boxGeo(1.1, 0.34, 0.34, 1.4), place(sx0 + 2.6, MY + 0.87, sz0 + 1.4), 0x3a342c);
    B.add('iron', boxGeo(0.4, 0.24, 0.34, 1.6), place(sx0 + 3.2, MY + 1.1, sz0 + 1.4), 0x3a342c);
    for (let i = 0; i < 6; i++) {
      B.add('iron', boxGeo(0.08, 0.9, 0.08, 1.6), place(sx0 - 2.4, MY + 1.6, sz0 + 1.0 + i * 0.24), 0x38322b);
    }
    B.add('beam', boxGeo(0.16, 2.2, 3.0, 1.0), place(sx0 - 2.4, MY + 1.1, sz0 + 1.6), 0x6f5539);
    this._box(sx0, MY + 0.9, sz0, 1.8, 0.9, 1.5);
    this._box(sx0 - 1.0, MY + 2.75, sz0 - 0.4, 0.75, 2.75, 0.75);
    const forge = pointLight(0xff7418, 96, 24, 2);
    forge.position.set(sx0 + 0.4, MY + 2.2, sz0);
    this.group.add(forge);
    this._addGlow(sx0 + 0.6, MY + 0.12, sz0 + 0.4, 7.5, 0x5a2c0e);
    this._smokeOrigins.push(sx0 - 1.0, MY + 6.0, sz0 - 0.4);

    /* ---- Street lanterns -------------------------------------------- */
    // The village had no practicals of its own at all: every warm value in a
    // street frame came from a window quad, so there was no key, no pool and
    // no falloff anywhere on the ground plane. Only every third post carries a
    // real light - the rest are lit by their spill card, which costs nothing.
    const LANTERNS = [
      [21, 3.5], [45, 4.5], [19.5, 31.5], [46.5, 31],
      [34, 33.5], [53, 28], [12, 16], [26, 20.5],
    ];
    LANTERNS.forEach(([lx, lz], i) => {
      const ly = this._height(lx, lz);
      B.add('beam', cylGeo(0.11, 0.15, 3.3, 8, 1.0), place(lx, ly + 1.65, lz), 0x6b5238);
      B.add('iron', boxGeo(0.72, 0.09, 0.09, 1.6), place(lx + 0.31, ly + 3.24, lz), 0x2f2a24);
      B.add('iron', boxGeo(0.36, 0.5, 0.36, 1.5), place(lx + 0.62, ly + 2.9, lz), 0x332d26);
      B.add('ember', boxGeo(0.26, 0.36, 0.26, 2.0), place(lx + 0.62, ly + 2.9, lz), 0xffb264);
      this._box(lx, ly + 1.65, lz, 0.16, 1.65, 0.16);
      this._addGlow(lx + 0.62, ly + 0.1, lz, 6.4, 0x4c2b12);
      if (i % 3 === 0) {
        const l = pointLight(0xff9a3c, 72, 19, 2);
        l.position.set(lx + 0.62, ly + 2.9, lz);
        this.group.add(l);
      }
    });

    /* ---- Market cross and well ------------------------------------- */
    B.add('ashlar', cylGeo(1.7, 2.0, 0.9, 12, 0.6), place(MARKET.x, MY + 0.45, MARKET.z), 0xccc5b4);
    B.add('ashlar', cylGeo(1.3, 1.6, 0.4, 12, 0.7), place(MARKET.x, MY + 1.1, MARKET.z), 0xc2baa7);
    B.add('ashlar', boxGeo(0.6, 4.4, 0.6, 0.7), place(MARKET.x, MY + 3.4, MARKET.z, 0.4), 0xccc5b4);
    B.add('ashlar', boxGeo(1.4, 0.5, 1.4, 0.9), place(MARKET.x, MY + 5.8, MARKET.z, 0.4), 0xc2baa7);
    this._box(MARKET.x, MY + 1.0, MARKET.z, 1.8, 1.0, 1.8);

    const wx = MARKET.x - 11;
    const wz = MARKET.z + 9;
    B.add('rubble', cylGeo(1.5, 1.6, 1.4, 16, 0.7), place(wx, MY + 0.7, wz), 0xb2a996);
    B.add('rubble', cylGeo(1.75, 1.55, 0.2, 16, 0.9), place(wx, MY + 1.45, wz), 0xa79f8d);
    for (const s of [-1, 1]) {
      B.add('beam', boxGeo(0.22, 2.6, 0.22, 1.0), place(wx + s * 1.3, MY + 2.5, wz), 0x6d5438);
    }
    B.add('beam', cylGeo(0.16, 0.16, 2.6, 8, 1.0), place(wx, MY + 3.5, wz, 0), 0x7a5e3f);
    _obj.position.set(wx, MY + 4.05, wz);
    _obj.rotation.set(0, Math.PI / 2, 0);
    _obj.scale.set(1, 1, 1);
    B.add('thatch', boxGeo(3.4, 0.3, 2.8, 0.8), _obj, 0xdcbb70);
    B.add('iron', cylGeo(0.02, 0.02, 1.8, 4, 2.0), place(wx, MY + 2.7, wz), 0x2f2a24);
    B.add('plank', cylGeo(0.28, 0.24, 0.36, 10, 1.2), place(wx, MY + 1.95, wz), 0x9c7c50);
    this._discSolid(wx, MY + 1.55, wz, 1.7, 1.4);

    /* ---- Banner poles at the square corners ------------------------- */
    for (let i = 0; i < 4; i++) {
      const px = MARKET.x + (i % 2 ? 1 : -1) * (MARKET.hx - 2.5);
      const pz = MARKET.z + (i < 2 ? -1 : 1) * (MARKET.hz - 2.5);
      B.add('beam', cylGeo(0.16, 0.2, 8.0, 8, 0.9), place(px, MY + 4.0, pz), 0x6f5539);
      B.add('banner', planeGeo(1.8, 4.6, 0), place(px + 0.9, MY + 5.4, pz, 0.2),
        HERALD[i % HERALD.length]);
      B.add('iron', cylGeo(0.05, 0.05, 0.4, 6, 1.5), place(px, MY + 8.1, pz), 0x2f2a24);
      this._box(px, MY + 4.0, pz, 0.2, 4.0, 0.2);
    }

    /* ---- Hand carts ------------------------------------------------- */
    const cart = (x, z, ry) => {
      const y = this._height(x, z);
      const M = new THREE.Matrix4().makeRotationY(ry).setPosition(x, y, z);
      local(M, 'plank', boxGeo(2.6, 0.16, 1.5, 0.9), 0, 0.9, 0, 0, 0, 0, 0xa8865a);
      for (const s of [-1, 1]) {
        local(M, 'plank', boxGeo(2.6, 0.5, 0.12, 1.1), 0, 1.16, s * 0.72, 0, 0, 0, 0x9a7a50);
      }
      local(M, 'plank', boxGeo(0.12, 0.5, 1.5, 1.1), -1.28, 1.16, 0, 0, 0, 0, 0x9a7a50);
      for (const s of [-1, 1]) {
        const wg = new THREE.TorusGeometry(0.62, 0.09, 6, 18);
        MedievalWorld._uvScale(wg, 0.6);
        local(M, 'beam', wg, 0.3, 0.62, s * 0.85, 0, Math.PI / 2, 0, 0x7a5f42);
        for (let k = 0; k < 8; k++) {
          local(M, 'beam', boxGeo(0.08, 1.2, 0.08, 1.4), 0.3, 0.62, s * 0.85,
            0, Math.PI / 2, (k / 8) * Math.PI, 0x7a5f42);
        }
      }
      local(M, 'beam', boxGeo(2.0, 0.12, 0.12, 1.2), 2.2, 0.7, -0.4, 0, 0, -0.12, 0x6f5539);
      local(M, 'beam', boxGeo(2.0, 0.12, 0.12, 1.2), 2.2, 0.7, 0.4, 0, 0, -0.12, 0x6f5539);
      this._rbox(x, y + 0.95, z, 1.4, 0.6, 0.9, ry);
    };
    cart(26, 14, 0.6);
    cart(41, 31, 2.2);
    cart(CASTLE.x + 14, CASTLE.z + 20, 1.1);
    // Two more on the square's own approach, in the 8-16m band where the
    // composed framing had nothing at all between the lens and the tavern.
    cart(51.5, 43.0, -0.9);
    cart(44.5, 45.5, 2.6);

    this._squareDressing(B, place, local, rnd);

    B.build(this._mats, this.group, { ao: this._heightFn });
    this._buildProps();
    this._buildFolk();
  }

  /**
   * Foreground for the square.
   *
   * The composed village-square framing stands at (58, 48) and looks
   * north-west across the market. Round 4 answered it with two barrels and a
   * crate: over half the image was bare terrain and the only subject was a
   * fifteen-pixel figure at the vanishing point. The cause was structural -
   * the hero-eye exclusion radius was eleven metres, so *nothing* could stand
   * in the near half of that frame - but clearing the exclusion only makes
   * room; it does not fill it. Scatter will not fill it either, because
   * scatter produces an even sprinkle and what a frame needs is groups.
   *
   * So the 5-25m band is laid out by hand as clusters, each one a small
   * story - a delivery being unloaded, a woodpile being built, a trestle left
   * out overnight - at staggered depths so the eye steps through the space
   * rather than jumping the gap. Every anchor is tested against the live
   * footprint list, so a cluster can never end up inside a wall if a plot
   * moves.
   *
   * @param {GeoBatch} B
   * @param {(x:number,y:number,z:number,ry?:number)=>THREE.Object3D} place
   * @param {Function} local places a geometry in a parent matrix
   * @param {() => number} rnd
   */
  _squareDressing(B, place, local, rnd) {
    /* [x, z, yaw, kind]. Ordered near-to-far along the square's view axis so
     * the depth staggering is visible in the source as well as in the frame. */
    const ANCHORS = [
      [55.4, 44.6, -0.9, 'sacks'], [57.6, 40.2, 0.4, 'wood'],
      [51.2, 46.4, 2.1, 'crates'], [47.0, 47.4, -0.5, 'trestle'],
      [44.2, 41.0, 1.2, 'barrels'], [39.6, 45.8, 2.7, 'crates'],
      [58.8, 35.4, -1.4, 'wood'], [36.4, 40.4, 0.8, 'sacks'],
      [30.6, 36.2, 2.2, 'barrels'], [24.4, 33.0, -0.4, 'trestle'],
      [18.6, 24.6, 1.7, 'crates'], [16.2, 12.4, -1.1, 'sacks'],
      [40.4, 24.2, 0.5, 'barrels'], [28.2, 21.6, 2.4, 'wood'],
    ];

    for (const [x, z, yaw, kind] of ANCHORS) {
      if (this._inFootprint(x, z, 0.45)) continue;
      const y = this._height(x, z);
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      /** Local offset (along, across) resolved into world space. */
      const at = (a, b) => [x + c * a + s * b, z - s * a + c * b];

      if (kind === 'crates') {
        // A stack that is not a neat stack: three on the ground, two on top,
        // one pulled off and left at an angle. Regular stacking is the tell.
        const lay = [[0, 0, 0], [0.86, 0.06, 0.12], [0.44, 0.62, -0.06],
          [-0.82, -0.1, 0.3], [1.5, -0.05, 0.66]];
        for (let i = 0; i < lay.length; i++) {
          const [a, hy, b] = lay[i];
          const [wx, wz] = at(a, b);
          const sc = 0.66 + rnd() * 0.22;
          B.add('plank', boxGeo(sc, sc * 0.86, sc * 0.92, 1.3),
            place(wx, y + sc * 0.43 + hy, wz, yaw + (rnd() - 0.5) * 0.5),
            shadeHex(0xa07f52, 0.82 + rnd() * 0.36));
          if (i < 3) this._contacts.push(wx, y, wz, 0.5);
        }
        const [tx, tz] = at(-0.3, -0.85);
        B.add('hay', cylGeo(0.34, 0.36, 0.5, 10, 1.2), place(tx, y + 0.25, tz, yaw), 0xbb9a5e);
        this._contacts.push(tx, y, tz, 0.45);
        this._rbox(x, y + 0.5, z, 1.4, 0.5, 0.8, yaw);
      } else if (kind === 'sacks') {
        // Grain sacks: soft, slumped, leaning on each other.
        for (let i = 0; i < 6; i++) {
          const a = (i % 3) * 0.52 - 0.52;
          const b = ((i / 3) | 0) * 0.46 - 0.23;
          const [wx, wz] = at(a + (rnd() - 0.5) * 0.16, b + (rnd() - 0.5) * 0.16);
          const g = new THREE.IcosahedronGeometry(0.29, 1);
          g.scale(0.92, 1.25, 0.86);
          MedievalWorld._uvScale(g, 1.5);
          B.add('hay', g, place(wx, y + 0.34, wz, rnd() * TAU),
            shadeHex(0xc2a874, 0.78 + rnd() * 0.4));
          this._contacts.push(wx, y, wz, 0.36);
        }
        const [px, pz] = at(-1.0, 0.4);
        B.add('beam', cylGeo(0.05, 0.06, 1.7, 6, 1.4),
          place(px, y + 0.82, pz, yaw), 0x7a6144);
        B.add('iron', boxGeo(0.28, 0.06, 0.34, 1.6), place(px, y + 1.62, pz, yaw), 0x3a342c);
        this._rbox(x, y + 0.35, z, 1.0, 0.35, 0.6, yaw);
      } else if (kind === 'wood') {
        // A split-log stack under a lean-to of boards - vertical structure in
        // the 0-2m band, which is where the frame was emptiest.
        for (let row = 0; row < 5; row++) {
          for (let k = 0; k < 6; k++) {
            const [wx, wz] = at(-0.7 + k * 0.28, 0);
            _obj.position.set(wx, y + 0.14 + row * 0.235, wz);
            _obj.rotation.set(0, yaw, Math.PI / 2);
            _obj.scale.set(1, 1, 1);
            B.add('beam', cylGeo(0.1, 0.115, 1.35, 7, 1.2), _obj,
              shadeHex(row % 2 ? 0x8a6c4a : 0x775c3f, 0.86 + rnd() * 0.3));
          }
        }
        for (const sg of [-1, 1]) {
          const [wx, wz] = at(sg * 0.85, -0.5);
          B.add('beam', boxGeo(0.12, 1.9, 0.12, 1.4), place(wx, y + 0.95, wz, yaw), 0x6f5539);
        }
        const [rx, rz] = at(0, -0.28);
        _obj.position.set(rx, y + 1.86, rz);
        _obj.rotation.set(0.28, yaw, 0);
        _obj.scale.set(1, 1, 1);
        B.add('plank', boxGeo(2.1, 0.09, 1.3, 1.0), _obj, 0x8a6c4a);
        this._contacts.push(x, y, z, 1.1);
        this._rbox(x, y + 0.6, z, 1.0, 0.6, 0.5, yaw);
      } else if (kind === 'barrels') {
        for (let i = 0; i < 4; i++) {
          const a = (i % 2) * 0.9 - 0.45;
          const b = ((i / 2) | 0) * 0.88 - 0.44;
          const [wx, wz] = at(a, b);
          const down = i === 3;
          _obj.position.set(wx, y + (down ? 0.42 : 0.5), wz);
          _obj.rotation.set(down ? Math.PI / 2 : 0, yaw + rnd(), 0);
          _obj.scale.set(1, 1, 1);
          B.add('plank', cylGeo(0.42, 0.36, 1.0, 12, 1.0), _obj,
            shadeHex(0x8f6f47, 0.84 + rnd() * 0.32));
          _obj.position.set(wx, y + (down ? 0.42 : 0.86), wz);
          B.add('iron', cylGeo(0.45, 0.45, 0.1, 12, 1.4), _obj, 0x35302a);
          this._contacts.push(wx, y, wz, 0.6);
          this._rbox(wx, y + 0.5, wz, 0.45, 0.5, 0.45, 0);
        }
      } else if (kind === 'trestle') {
        // Trestle table with a cloth and a scatter of goods: the one prop that
        // puts a horizontal plane at waist height, which is what separates a
        // market from a yard.
        const M = new THREE.Matrix4().makeRotationY(yaw).setPosition(x, y, z);
        local(M, 'plank', boxGeo(2.2, 0.09, 0.86, 1.1), 0, 0.82, 0, 0, 0, 0, 0xa8865a);
        for (const sg of [-1, 1]) {
          for (const sg2 of [-1, 1]) {
            local(M, 'beam', boxGeo(0.09, 0.82, 0.09, 1.4),
              sg * 0.92, 0.41, sg2 * 0.32, 0, 0, sg * 0.06, 0x6f5539);
          }
          local(M, 'beam', boxGeo(0.08, 0.08, 0.72, 1.4), sg * 0.92, 0.5, 0, 0, 0, 0, 0x6f5539);
        }
        local(M, 'banner', boxGeo(2.3, 0.34, 0.94, 1.0), 0, 0.68, 0, 0, 0, 0,
          HERALD[(rnd() * HERALD.length) | 0]);
        for (let i = 0; i < 9; i++) {
          const g = new THREE.IcosahedronGeometry(0.11 + rnd() * 0.05, 0);
          MedievalWorld._uvScale(g, 2.2);
          local(M, 'leaf', g, -0.9 + rnd() * 1.8, 0.95, -0.28 + rnd() * 0.56,
            0, rnd() * TAU, 0, [0xb4381e, 0xc8912e, 0x7d9a3c][(rnd() * 3) | 0]);
        }
        this._contacts.push(x, y, z, 1.3);
        this._rbox(x, y + 0.45, z, 1.15, 0.45, 0.5, yaw);
      }
    }

    /* ---- Rut puddles -------------------------------------------------
     *
     * The single highest-value thing that can be done to a dusk street.
     * Standing water in a wheel rut is the only near-mirror surface in the
     * world: it takes the sky probe at roughness 0.06 and throws a hard warm
     * glint back at any camera near ground level, which is exactly the
     * specular event the ground plane was missing. One instanced disc mesh,
     * one draw call, placed in the rut lines of the streets that the composed
     * framings run down.
     */
    const PUDDLES = [
      [52.6, 44.2, 1.5], [49.4, 40.6, 1.1], [44.8, 43.2, 1.9], [39.2, 43.0, 1.3],
      [33.4, 37.6, 1.7], [27.8, 31.4, 1.2], [22.6, 25.0, 1.6], [19.0, 15.2, 1.4],
      [31.0, 12.0, 2.1], [40.0, 15.6, 1.5], [24.8, 6.6, 1.3], [45.6, 24.6, 1.1],
      [-16.2, -30.4, 2.3], [-13.0, -44.6, 1.8], [-24.6, 0.4, 2.0],
      [-31.2, 20.2, 1.6], [-37.4, 40.6, 2.2], [-42.0, 57.0, 1.7],
    ];
    const pg = new THREE.CircleGeometry(0.5, 14);
    pg.rotateX(-Math.PI / 2);
    this._owned.push(pg);
    const pmat = new THREE.MeshStandardMaterial({
      color: 0x2a2b26,
      roughness: 0.06,
      metalness: 0.0,
      envMapIntensity: 1.6,
      transparent: true,
      opacity: 0.86,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -5,
      polygonOffsetUnits: -7,
    });
    pmat.name = 'medieval.puddle';
    this._mats.puddle = pmat;
    this._owned.push(pmat);
    const pm = new THREE.InstancedMesh(pg, pmat, PUDDLES.length);
    pm.castShadow = false;
    pm.receiveShadow = false;
    pm.renderOrder = 2;
    PUDDLES.forEach(([px, pz, pr], i) => {
      _obj.position.set(px, this._height(px, pz) + 0.055, pz);
      _obj.rotation.set(0, i * 1.7, 0);
      _obj.scale.set(pr * (0.8 + rnd() * 0.5), 1, pr * (0.62 + rnd() * 0.5));
      _obj.updateMatrix();
      pm.setMatrixAt(i, _obj.matrix);
    });
    pm.instanceMatrix.needsUpdate = true;
    pm.computeBoundingSphere();
    this.group.add(pm);
  }

  /**
   * A silhouette-legible standing figure, ~1.72m, as one merged geometry.
   *
   * These are set dressing, not characters: the NPC system caps how many
   * skinned humanoids a world may spawn, and four figures spread over 400m of
   * terrain is what made three hero frames contain no human being at all. At
   * the 20-60m range where "is this place inhabited" is actually decided, what
   * reads is the silhouette - hood, shoulders, flared tunic hem, legs apart -
   * and that costs a hundred triangles, not a skeleton.
   *
   * @param {number} seed @param {number} variant 0 = arms down, 1 = arms folded
   */
  _figureGeo(seed, variant) {
    const rnd = mulberry32(seed);
    const parts = [];
    const put = (geo, hex, x, y, z, rx = 0, ry = 0, rz = 0) => {
      _obj.position.set(x, y, z);
      _obj.rotation.set(rx, ry, rz);
      _obj.scale.set(1, 1, 1);
      _obj.updateMatrix();
      geo.applyMatrix4(_obj.matrix);
      parts.push(normaliseGeo(geo, hex));
    };
    const HOSE = 0x6b5a44;
    const BOOT = 0x3f342a;
    // Legs, slightly apart and one advanced, so the stance is not symmetrical.
    for (const s of [-1, 1]) {
      put(cylGeo(0.075, 0.06, 0.82, 7, 1.2), HOSE, s * 0.105, 0.44, s * 0.035, 0.03 * s, 0, 0);
      put(cylGeo(0.085, 0.075, 0.13, 7, 1.6), BOOT, s * 0.105, 0.055, s * 0.035 + 0.04);
    }
    // Tunic: a flared skirt over a barrel chest. The flare is the silhouette.
    put(cylGeo(0.185, 0.30, 0.62, 10, 1.0), 0xffffff, 0, 1.02, 0);
    put(cylGeo(0.20, 0.185, 0.30, 10, 1.0), 0xffffff, 0, 1.46, 0);
    put(cylGeo(0.055, 0.055, 0.09, 8, 2.0), 0x4a3a28, 0, 1.30, 0.0);
    // Belt.
    const belt = new THREE.TorusGeometry(0.20, 0.028, 5, 14);
    belt.rotateX(Math.PI / 2);
    MedievalWorld._uvScale(belt, 1.6);
    put(belt, 0x4a3a28, 0, 1.31, 0);
    // Shoulders and arms.
    for (const s of [-1, 1]) {
      if (variant === 0) {
        put(cylGeo(0.062, 0.05, 0.56, 7, 1.1), 0xffffff, s * 0.215, 1.37, 0.01, 0, 0, s * 0.12);
        put(new THREE.IcosahedronGeometry(0.055, 0), 0xc9a07a, s * 0.25, 1.08, 0.02);
      } else {
        // Folded across the chest: reads instantly as "standing, waiting".
        put(cylGeo(0.058, 0.05, 0.42, 7, 1.1), 0xffffff,
          s * 0.13, 1.34, 0.14, Math.PI / 2 - 0.28, 0, s * 1.28);
        put(new THREE.IcosahedronGeometry(0.052, 0), 0xc9a07a, -s * 0.10, 1.30, 0.16);
      }
    }
    // Neck, head, and a hood or a brimmed hat - the top of the silhouette is
    // the only part of a distant figure a viewer actually resolves.
    put(cylGeo(0.05, 0.055, 0.08, 6, 1.4), 0xc9a07a, 0, 1.635, 0);
    const head = new THREE.IcosahedronGeometry(0.105, 1);
    head.scale(0.92, 1.12, 0.98);
    MedievalWorld._uvScale(head, 2.2);
    put(head, 0xc9a07a, 0, 1.745, 0.005);
    if (rnd() < 0.55) {
      put(coneGeo(0.15, 0.20, 8, 1.2), 0xffffff, 0, 1.80, -0.015, 0.16, 0, 0);
      put(cylGeo(0.12, 0.14, 0.10, 8, 1.4), 0xffffff, 0, 1.71, -0.01);
    } else {
      put(cylGeo(0.155, 0.165, 0.055, 10, 1.2), 0xffffff, 0, 1.79, 0);
      put(cylGeo(0.11, 0.115, 0.13, 8, 1.4), 0xffffff, 0, 1.845, 0);
    }
    const g = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    return g;
  }

  /**
   * Populate the settlement: villagers, wall-walk sentries, poultry and dogs.
   *
   * Everything here is instanced and shares two draw calls per archetype, and
   * everything is hand-placed on an authored vantage rather than scattered -
   * an even sprinkle of people over 400m puts nobody where the camera looks.
   */
  _buildFolk() {
    const rnd = mulberry32(0x9e0b1e);
    const WALK = WALL_TOP + 0.55;

    /* [x, z, yaw, variant, scale] - clustered on the market axis, the
     * approach road, the tavern door and the south curtain wall walk. */
    const folk = [
      // Stall keepers, stood behind their trestles.
      [21.0, 5.0, 0.05, 1, 1.00], [29.2, 4.6, -0.06, 0, 0.96],
      [37.1, 5.1, 0.04, 1, 1.03], [45.4, 7.1, -0.32, 0, 0.94],
      [22.4, 31.4, Math.PI, 1, 0.99], [31.2, 31.8, Math.PI, 0, 1.02],
      // Customers and loiterers in the square itself.
      [25.4, 11.2, 2.30, 0, 1.01], [26.6, 12.1, -0.85, 1, 0.93],
      [33.0, 14.6, 1.10, 0, 1.05], [39.5, 12.0, -2.10, 1, 0.97],
      [34.6, 22.4, 0.35, 0, 1.00], [42.0, 20.5, 3.00, 1, 0.90],
      [46.2, 16.4, -1.55, 1, 1.02], [45.8, 24.2, -1.62, 0, 0.96],
      [37.8, 27.6, 0.90, 1, 1.01], [29.0, 24.0, -2.40, 0, 0.99],
      // Tavern door and the smithy.
      [44.2, 37.6, -0.42, 1, 1.04], [47.0, 38.2, -1.10, 0, 0.98],
      [49.6, 21.4, 1.90, 0, 1.06],
      /* The square's own approach.
       *
       * Everything above sits 30-45m from the composed square vantage, which
       * is why that frame read as "one NPC at the vanishing point" - at that
       * range a 1.7m figure is fifteen pixels tall and carries no scale
       * information at all. These six stand at 7-20m, in the band where a
       * human silhouette is large enough to calibrate the buildings behind it.
       */
      [54.0, 42.2, -0.60, 0, 1.03], [52.4, 43.6, 2.10, 1, 0.95],
      [49.8, 39.4, -1.20, 1, 1.01], [45.6, 44.0, 2.60, 0, 0.98],
      [42.8, 40.2, 0.70, 1, 1.05], [38.4, 44.6, -2.20, 0, 0.94],
      // The castle approach - a road with people on it reads as a route, and
      // the three at 20/45/70m along the drove road double as the scale
      // reference the keep silhouette has never had.
      [12.2, -4.6, 2.30, 0, 1.00], [4.6, -19.4, 2.45, 1, 0.95],
      [-6.2, -44.2, 2.55, 0, 1.02],
      [-38.6, 41.0, 0.32, 1, 1.02], [-36.0, 39.2, 3.30, 0, 0.97],
      [-32.4, 22.6, 0.28, 0, 1.04], [-26.0, 2.4, 0.30, 1, 0.99],
      [-19.4, -14.8, 0.34, 0, 1.01], [-14.6, -35.2, 0.26, 1, 1.03],
      /* Wall-walk sentries. Two vertical figures on a parapet are the cheapest
       * scale reference a castle silhouette can carry.
       *
       * Three of these used to stand at x = -52 and x = -96, on a curtain wall
       * that has not existed since `CASTLE.hx` went to 40: those are interior
       * bailey coordinates, and with `f[5]` set they skip the ground contact,
       * so all three stood in clear air 10.6 m over the grass. They are on the
       * west and north curtains now - x = -111.8 and z = -91 are the centres
       * of those two decks' walkable bands, between the merlon collider and
       * the inner kerb. @see the sentry routes in `_buildInhabitants` for the
       * measurements. */
      [-111.8, -34.0, 1.55, 0, 1.05, WALK], [-111.8, -70.0, 1.60, 1, 1.03, WALK],
      [-100.0, -91.0, -1.55, 0, 1.04, WALK],
      /* Two more on the south curtain, which is the run the castle-approach
       * framing actually sees. A figure on a battlement is the cheapest and
       * most decisive scale cue a fortification can carry, and the south wall
       * had none. Set back to z = -25.9 so the two live sentries, whose beat
       * runs along z = -24.4, walk past them rather than through them. */
      [-88.0, -25.9, 1.58, 1, 1.02, WALK], [-64.0, -25.9, 1.52, 0, 1.06, WALK],
      [-72.0, -91.0, -1.58, 1, 1.04, WALK],
    ];

    // Costume palette stays inside the daub / beam / shutter range: a cool
    // blue-grey on a villager reads as a modern placeholder instantly.
    const CLOTH = [
      0x8a6f4c, 0x6f5b3e, 0xa08256, 0x7a4b3c, 0x4f6b52,
      0x8a7a5c, 0x6b4a3a, 0x94794f, 0x5c6250, 0xa88a5e,
    ];

    const figMat = new THREE.MeshStandardMaterial({
      map: this._tex.canopy.map,
      normalMap: this._tex.canopy.normalMap,
      roughnessMap: this._tex.canopy.roughnessMap,
      roughness: 1,
      metalness: 0,
      vertexColors: true,
    });
    figMat.name = 'medieval.folk';
    // Idle sway. A perfectly still figure is a statue; two centimetres of
    // weight shift at a per-instance phase is all it takes to read as alive.
    const timeU = this._timeU;
    figMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = timeU;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           #ifdef USE_INSTANCING
             float fPh = instanceMatrix[3][0] * 0.7 + instanceMatrix[3][2] * 0.53;
             float fUp = max(transformed.y, 0.0);
             transformed.x += sin(uTime * 0.62 + fPh) * fUp * fUp * 0.012;
             transformed.z += sin(uTime * 0.47 + fPh * 1.7) * fUp * fUp * 0.009;
           #endif`
        );
    };
    figMat.customProgramCacheKey = () => 'medieval-folk';
    this._mats.folk = figMat;
    this._owned.push(figMat);

    const geos = [this._figureGeo(0x1f0a, 0), this._figureGeo(0x2b7c, 1)];
    for (const g of geos) this._owned.push(g);
    for (let v = 0; v < 2; v++) {
      const rows = folk.filter((f) => f[3] === v);
      if (!rows.length) continue;
      const mesh = new THREE.InstancedMesh(geos[v], figMat, rows.length);
      rows.forEach((f, i) => {
        const y = f[5] !== undefined ? f[5] : this._height(f[0], f[1]);
        _obj.position.set(f[0], y, f[1]);
        _obj.rotation.set(0, f[2], 0);
        _obj.scale.set(f[4] * (0.97 + rnd() * 0.06), f[4], f[4] * (0.97 + rnd() * 0.06));
        _obj.updateMatrix();
        mesh.setMatrixAt(i, _obj.matrix);
        _col.setHex(CLOTH[(rnd() * CLOTH.length) | 0]);
        mesh.setColorAt(i, _col);
        // Ground contact, except on the wall walk where there is no terrain.
        if (f[5] === undefined) this._contacts.push(f[0], y, f[1], 0.42);
      });
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
    }

    /* ---- Poultry ----------------------------------------------------- *
     * Chickens in the yards do more for "lived in" per triangle than any
     * other prop in the world, because nothing else in frame moves at animal
     * scale near the ground. */
    {
      const parts = [];
      const add = (geo, hex, x, y, z, rz = 0) => {
        _obj.position.set(x, y, z);
        _obj.rotation.set(0, 0, rz);
        _obj.scale.set(1, 1, 1);
        _obj.updateMatrix();
        geo.applyMatrix4(_obj.matrix);
        parts.push(normaliseGeo(geo, hex));
      };
      const body = new THREE.IcosahedronGeometry(0.115, 1);
      body.scale(1.35, 1.0, 0.85);
      MedievalWorld._uvScale(body, 2.4);
      add(body, 0xffffff, 0, 0.155, 0);
      add(cylGeo(0.035, 0.05, 0.10, 6, 2.0), 0xffffff, 0.10, 0.235, 0, -0.35);
      const head = new THREE.IcosahedronGeometry(0.052, 0);
      MedievalWorld._uvScale(head, 3.0);
      add(head, 0xffffff, 0.128, 0.30, 0);
      add(coneGeo(0.022, 0.055, 5, 2.5), 0xd4761f, 0.168, 0.302, 0, -1.4);
      add(coneGeo(0.05, 0.13, 6, 2.0), 0xffffff, -0.135, 0.20, 0, -0.9);
      for (const s of [-1, 1]) {
        add(cylGeo(0.012, 0.012, 0.10, 4, 3.0), 0xd4761f, 0.01, 0.055, s * 0.045);
      }
      const chickGeo = mergeGeometries(parts, false);
      for (const p of parts) p.dispose();
      this._owned.push(chickGeo);

      const N = 34;
      const mesh = new THREE.InstancedMesh(chickGeo, figMat, N);
      let placed = 0;
      let guard = 0;
      while (placed < N && guard++ < N * 40) {
        const p = PLOTS[(rnd() * PLOTS.length) | 0];
        const a = rnd() * TAU;
        const r = 3.0 + rnd() * 4.5;
        const x = p[0] + Math.cos(a) * r;
        const z = p[1] + Math.sin(a) * r;
        if (this._inFootprint(x, z, 0.6)) continue;
        if (this._roadDist(x, z) < 1.0) continue;
        const y = this._height(x, z);
        if (y < WATER_Y + 0.5) continue;
        const sc = 0.86 + rnd() * 0.34;
        _obj.position.set(x, y, z);
        // A third of them pecking: the pose difference is what stops a flock
        // of identical instances reading as a decal sheet.
        _obj.rotation.set(rnd() < 0.34 ? 0.55 : 0, rnd() * TAU, 0);
        _obj.scale.setScalar(sc);
        _obj.updateMatrix();
        mesh.setMatrixAt(placed, _obj.matrix);
        _col.setHSL(0.08 + rnd() * 0.05, 0.10 + rnd() * 0.45, 0.36 + rnd() * 0.42);
        mesh.setColorAt(placed, _col);
        this._contacts.push(x, y, z, 0.2);
        placed++;
      }
      mesh.count = placed;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
    }

    /* ---- Two dogs, at the tavern and on the approach ------------------ */
    {
      const parts = [];
      const add = (geo, hex, x, y, z, rz = 0) => {
        _obj.position.set(x, y, z);
        _obj.rotation.set(0, 0, rz);
        _obj.scale.set(1, 1, 1);
        _obj.updateMatrix();
        geo.applyMatrix4(_obj.matrix);
        parts.push(normaliseGeo(geo, hex));
      };
      const body = new THREE.IcosahedronGeometry(0.19, 1);
      body.scale(1.75, 0.92, 0.86);
      MedievalWorld._uvScale(body, 2.0);
      add(body, 0xffffff, 0, 0.44, 0);
      add(cylGeo(0.075, 0.09, 0.22, 6, 1.8), 0xffffff, 0.28, 0.52, 0, -0.6);
      const head = new THREE.IcosahedronGeometry(0.10, 1);
      head.scale(1.3, 1.0, 0.9);
      MedievalWorld._uvScale(head, 2.6);
      add(head, 0xffffff, 0.40, 0.60, 0);
      add(coneGeo(0.03, 0.10, 5, 2.0), 0xffffff, -0.36, 0.52, 0, 1.1);
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          add(cylGeo(0.032, 0.03, 0.34, 5, 2.0), 0xffffff, sx * 0.20, 0.17, sz * 0.10);
        }
      }
      const dogGeo = mergeGeometries(parts, false);
      for (const p of parts) p.dispose();
      this._owned.push(dogGeo);
      const spots = [[43.0, 39.4, 1.2], [8.0, -9.0, 2.4], [27.5, 25.0, -0.6]];
      const mesh = new THREE.InstancedMesh(dogGeo, figMat, spots.length);
      spots.forEach(([x, z, ry], i) => {
        const y = this._height(x, z);
        _obj.position.set(x, y, z);
        _obj.rotation.set(0, ry, 0);
        _obj.scale.setScalar(0.9 + rnd() * 0.2);
        _obj.updateMatrix();
        mesh.setMatrixAt(i, _obj.matrix);
        _col.setHSL(0.07, 0.22 + rnd() * 0.2, 0.20 + rnd() * 0.22);
        mesh.setColorAt(i, _col);
        this._contacts.push(x, y, z, 0.44);
      });
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
    }
  }

  /** Barrels, crates and hay bales scattered world-wide as instanced meshes. */
  _buildProps() {
    const rnd = mulberry32(0x9911ab);

    // Barrel: staved lathe body plus two iron hoops, merged and tinted.
    const profile = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      profile.push(new THREE.Vector2(0.34 + Math.sin(t * Math.PI) * 0.12, t * 1.0));
    }
    const body = new THREE.LatheGeometry(profile, 14);
    MedievalWorld._uvScale(body, 0.8);
    normaliseGeo(body, 0xffffff);
    const parts = [body];
    for (const y of [0.24, 0.76]) {
      const hoop = new THREE.TorusGeometry(0.45, 0.045, 5, 16);
      hoop.rotateX(Math.PI / 2);
      hoop.translate(0, y, 0);
      MedievalWorld._uvScale(hoop, 1.4);
      parts.push(normaliseGeo(hoop, 0x35302a));
    }
    const barrelGeo = mergeGeometries(parts, false);
    for (const g of parts) g.dispose();

    // Crate: boarded box with corner framing.
    const crateBody = boxGeo(0.78, 0.66, 0.78, 1.3);
    crateBody.translate(0, 0.33, 0);
    const cparts = [normaliseGeo(crateBody, 0xffffff)];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const e = boxGeo(0.1, 0.7, 0.1, 1.6);
        e.translate(sx * 0.36, 0.33, sz * 0.36);
        cparts.push(normaliseGeo(e, 0x6a5238));
      }
    }
    for (const y of [0.08, 0.58]) {
      const r1 = boxGeo(0.82, 0.08, 0.82, 1.4);
      r1.translate(0, y, 0);
      cparts.push(normaliseGeo(r1, 0x6a5238));
    }
    const crateGeo = mergeGeometries(cparts, false);
    for (const g of cparts) g.dispose();

    /* Straw bale.
     *
     * The old version was a single 12-sided extrusion: five straight facet
     * edges in silhouette, an identical dash band repeating fifteen times up
     * the side, and nothing to give it a scale reference. It is also the prop
     * most likely to end up near a lens, so it is worth the triangles. Three
     * stacked tapered bands at 24 segments give a barrelled profile with two
     * real silhouette breaks, and the rope bindings sit in the waists.
     */
    const baleParts = [];
    const baleR = [0.46, 0.56, 0.54, 0.44];
    const bandH = 1.1 / 3;
    for (let i = 0; i < 3; i++) {
      const g = cylGeo(baleR[i + 1], baleR[i], bandH, 24, 1.0);
      g.translate(0, -0.55 + (i + 0.5) * bandH, 0);
      baleParts.push(normaliseGeo(g, 0xffffff));
    }
    for (const y of [-0.55 + bandH, -0.55 + bandH * 2]) {
      const hoop = new THREE.TorusGeometry(0.555, 0.032, 5, 20);
      hoop.rotateX(Math.PI / 2);
      hoop.translate(0, y, 0);
      MedievalWorld._uvScale(hoop, 1.8);
      baleParts.push(normaliseGeo(hoop, 0x8b7343));
    }
    const baleGeo = mergeGeometries(baleParts, false);
    for (const g of baleParts) g.dispose();
    baleGeo.rotateZ(Math.PI / 2);

    // Firewood cord: split logs stacked against a wall or gable.
    const logParts = [];
    for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 5; k++) {
        const lg = cylGeo(0.11, 0.12, 1.5, 7, 1.2);
        lg.rotateZ(Math.PI / 2);
        lg.translate((k - 2) * 0.02, 0.13 + row * 0.235, (k - 2) * 0.245 + (row % 2) * 0.1);
        logParts.push(normaliseGeo(lg, row % 2 ? 0x8a6c4a : 0x7a5f42));
      }
    }
    const logGeo = mergeGeometries(logParts, false);
    for (const g of logParts) g.dispose();

    // Sack pile: grain sacks slumped against each other.
    const sackParts = [];
    for (let k = 0; k < 4; k++) {
      const sg = new THREE.IcosahedronGeometry(0.34, 1);
      sg.scale(1.0, 1.25, 0.82);
      MedievalWorld._uvScale(sg, 1.6);
      sg.rotateY(k * 1.31);
      sg.translate((k % 2 ? 0.3 : -0.26), 0.4 + (k > 1 ? 0.62 : 0), (k > 1 ? 0.1 : -0.16));
      sackParts.push(normaliseGeo(sg, k % 2 ? 0xd8cdb0 : 0xc4b898));
    }
    const sackGeo = mergeGeometries(sackParts, false);
    for (const g of sackParts) g.dispose();

    const spots = [
      { g: barrelGeo, m: this._mats.plank, n: 46, y: 0, s: [0.85, 1.15] },
      { g: crateGeo, m: this._mats.plank, n: 40, y: 0, s: [0.8, 1.3] },
      { g: baleGeo, m: this._mats.hay, n: 26, y: 0.55, s: [0.9, 1.25] },
      { g: logGeo, m: this._mats.beam, n: 24, y: 0, s: [0.9, 1.2], r: 0.9 },
      { g: sackGeo, m: this._mats.canopy, n: 22, y: 0, s: [0.85, 1.15], r: 0.7 },
    ];
    for (const spec of spots) {
      const mesh = new THREE.InstancedMesh(spec.g, spec.m, spec.n);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      let placed = 0;
      let guard = 0;
      while (placed < spec.n && guard++ < spec.n * 60) {
        const nearMarket = rnd() < 0.55;
        const x = nearMarket ? MARKET.x + (rnd() - 0.5) * 34 : 10 + rnd() * 90;
        const z = nearMarket ? MARKET.z + (rnd() - 0.5) * 30 : rnd() * 70 - 8;
        if (!this._isOpenGround(x, z, -0.6)) continue;
        // Nothing scattered may stand in an authored view corridor. This is
        // the fix for a 1.1m bale landing 1.6m from the village-square lens
        // and taking 45% of the frame with it.
        if (this._inHeroClear(x, z, 0.9)) continue;
        const sc = spec.s[0] + rnd() * (spec.s[1] - spec.s[0]);
        _obj.position.set(x, this._height(x, z) + spec.y * sc, z);
        _obj.rotation.set(0, rnd() * TAU, 0);
        _obj.scale.setScalar(sc);
        _obj.updateMatrix();
        mesh.setMatrixAt(placed, _obj.matrix);
        _col.setHSL(0.09 + rnd() * 0.04, 0.22 + rnd() * 0.2, 0.42 + rnd() * 0.22);
        mesh.setColorAt(placed, _col);
        this._box(x, this._height(x, z) + 0.5 * sc, z, 0.45 * sc, 0.5 * sc, 0.45 * sc);
        this._contacts.push(x, this._height(x, z), z, (spec.r ?? 0.62) * sc);
        placed++;
      }
      mesh.count = placed;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
      this._owned.push(spec.g);
    }
  }
  /* ---------------------------------------------------------------- */
  /* Trees, grass, rocks, reeds                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Grow one tree archetype: a recursively branching trunk plus clustered
   * foliage masses. Returned as two merged geometries so each archetype costs
   * exactly two instanced draw calls no matter how many trees there are.
   *
   * `lod` selects the crown tessellation. Calling this twice with the same
   * archetype produces two crowns whose lumps sit in identical places at
   * identical radii - the RNG draw order does not depend on `lod`, only the
   * polyhedron each lump is built from does - which is the property that lets
   * `DistanceLod` swap between them without the crown appearing to move.
   *
   * @param {object} o archetype descriptor
   * @param {'hi'|'lo'} [lod]
   */
  _treeArchetype(o, lod = 'hi') {
    const rnd = mulberry32(o.seed);
    const wood = [];
    const leaves = [];
    const UP = new THREE.Vector3(0, 1, 0);
    const q = new THREE.Quaternion();
    const dir = new THREE.Vector3();
    const nextPos = new THREE.Vector3();

    // Canopies are built from many small overlapping lumps rather than a few
    // big ellipsoids: it is the overlap that reads as foliage instead of as a
    // flying saucer, and low-detail lumps keep the instanced triangle budget
    // sane across five hundred trees.
    /* The 0xffffff entry was the source of the "blown white speckling" and the
     * "pale desaturated highlights that look like snow" along every crown top.
     * One blob in five got an unattenuated pass-through tint on an already
     * bright leaf albedo, and because blobs are small and overlapping the
     * result was per-pixel white flecks scattered through the canopy rather
     * than a legible bright patch. Nothing here now exceeds 0xd8e8b8, and the
     * spread runs cool-shade-green to sunlit-yellow-green so the crown still
     * has internal variation - just inside a believable band. */
    const LEAF_TINTS = [0xd8e8b8, 0xc6dca2, 0xb2cc8e, 0xcfe0a8, 0xa4c081, 0x9bb87a];
    // Broadleaf crowns are the ones that end up in the near foreground of a
    // hero frame, and a 20-face icosahedron shows 30px flat facets and a
    // dead-straight silhouette edge at that distance - it reads as a boulder,
    // not a tree. Detail 1 (80 faces) rounds the lump; the cluster counts below
    // are cut to pay for it so the instanced triangle budget stays flat.
    // Conifers stay at detail 0: a pine already carries five times the blob
    // count and its silhouette is carried by the whorls, not by the lumps.
    const DETAIL = o.kind === 'conifer' ? 0 : 1;
    /* The cheap crown.
     *
     * The lump count, the lump positions and the lump radii are all held
     * fixed and only the polyhedron changes, because the crown's silhouette
     * and its internal light/dark structure are entirely carried by where the
     * lumps are - drop lumps instead and the crown visibly thins, which is
     * the one artefact a canopy LOD cannot get away with.
     *
     * Broadleaf goes 80 faces -> 20 (the same step conifers already took for
     * their own reasons above). Conifers were already at 20 and are the bulk
     * of the far-field triangle load - the three backdrop treelines alone are
     * 808k triangles that are in frustum from every vantage in the world - so
     * for them the step is 20 faces -> an 8-face octahedron. A dead end
     * before that: halving the whorl count instead got a similar saving and
     * shortened the ragged cone silhouette that the whorls exist to make, so
     * the firs read as narrower at exactly the distance where their outline
     * is all you can see.
     */
    const LO = lod === 'lo';
    const LO_CONE = LO && o.kind === 'conifer';
    const LO_R = LO
      ? (o.kind === 'conifer' ? LO_BLOB_INFLATE_CONIFER : LO_BLOB_INFLATE_BROADLEAF)
      : 1;
    const blob = (x, y, z, r, flat) => {
      const g = LO_CONE
        ? new THREE.OctahedronGeometry(r * LO_R, 0)
        : new THREE.IcosahedronGeometry(r * LO_R, LO ? 0 : DETAIL);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const n = 1 + perlin2(p.getX(i) * 1.7 + o.seed + x, p.getZ(i) * 1.7 + z) * 0.42;
        p.setXYZ(i, p.getX(i) * n, p.getY(i) * n, p.getZ(i) * n);
      }
      g.computeVertexNormals();
      // The leaf sheet is now perforated, so the UV scale controls how coarse
      // the cut-out is against the sky. 2.6 put a leaf cell at 20-40cm on a
      // hero-scale crown, which is a hole, not a leaf; 4.4 lands them at
      // 8-15cm and the crown perimeter breaks up properly.
      MedievalWorld._uvScale(g, 4.4);
      g.scale(1.15, flat, 1.15);
      g.rotateY(rnd() * TAU);
      g.translate(x, y, z);
      const lg = normaliseGeo(g, LEAF_TINTS[(rnd() * LEAF_TINTS.length) | 0]);
      // Bake interior occlusion: undersides and the heart of the crown go
      // dark, edges and tops stay bright. Without this the whole canopy is one
      // uniform mid-green and has no volume at all.
      const lp = lg.attributes.position;
      const ln = lg.attributes.normal;
      const lc = lg.attributes.color;
      const R = Math.max(1.2, o.leafR * 2.2);
      for (let i = 0; i < lp.count; i++) {
        const up = ln.getY(i) * 0.5 + 0.5;
        const rad = clamp01(Math.hypot(lp.getX(i), lp.getZ(i)) / R);
        // Was 0.42 + 0.38*up + 0.26*rad, which tops out at 1.06 - so crown
        // tops and outer edges were being *brightened* by what is supposed to
        // be an occlusion term, and that is the other half of the bleached
        // white crust along every treeline. Clamped under 1.0, and the 'up'
        // weight cut so the sun-facing top of a crown is no longer the
        // brightest thing in the frame.
        const occ = Math.min(0.95, 0.40 + 0.28 * up + 0.22 * rad);
        lc.setXYZ(i, lc.getX(i) * occ, lc.getY(i) * occ, lc.getZ(i) * occ);
      }
      leaves.push(lg);
    };

    /** A cluster of lumps around a point - the unit a canopy is built from. */
    const cluster = (x, y, z, r, count, spread, flat) => {
      for (let i = 0; i < count; i++) {
        const a = rnd() * TAU;
        const d = Math.pow(rnd(), 0.6) * spread;
        blob(
          x + Math.cos(a) * d,
          y + (rnd() - 0.5) * spread * (flat < 0.8 ? 0.55 : 1.0),
          z + Math.sin(a) * d,
          r * (0.7 + rnd() * 0.55),
          flat
        );
      }
    };

    /** Tapered limb from a point along a direction. Returns the far end. */
    const limb = (px, py, pz, dx, dy, dz, len, rad, taper, seg, tint) => {
      dir.set(dx, dy, dz).normalize();
      const g = cylGeo(rad * taper, rad, len, seg, 0.9, seg < 7);
      q.setFromUnitVectors(UP, dir);
      _obj.position.set(px + dir.x * len * 0.5, py + dir.y * len * 0.5, pz + dir.z * len * 0.5);
      _obj.quaternion.copy(q);
      _obj.rotation.setFromQuaternion(q);
      _obj.scale.set(1, 1, 1);
      _obj.updateMatrix();
      g.applyMatrix4(_obj.matrix);
      wood.push(normaliseGeo(g, tint));
      return nextPos.set(px + dir.x * len, py + dir.y * len, pz + dir.z * len).clone();
    };

    if (o.kind === 'conifer') {
      /* A conifer is a single spar carrying whorls of short laterals whose
       * radius tapers to the apex - recursion produces a bent chain, which is
       * exactly what a fir is not. */
      const H = o.trunk;
      let y = 0;
      for (let i = 0; i < 4; i++) {
        const seg = H / 4;
        limb(0, y, 0, (rnd() - 0.5) * 0.05, 1, (rnd() - 0.5) * 0.05, seg,
          o.radius * (1 - i * 0.19), 0.82, i === 0 ? 8 : 6, 0xffffff);
        y += seg;
      }
      // Ten irregular whorls rather than seven even ones, with the height and
      // radius of each jittered. Evenly spaced whorls of identical radius are
      // what made the mid-distance pines read as a stack of plates on a pole;
      // a fir's silhouette is a ragged cone, and the raggedness has to be in
      // the placement because the lumps themselves are too coarse to supply it.
      const whorls = 10;
      for (let w = 0; w < whorls; w++) {
        const t = 0.10 + (w / (whorls - 1)) * 0.88 + (rnd() - 0.5) * 0.05;
        const wy = H * t;
        const R = (o.leafR * Math.pow(1.04 - t, 0.8) + 0.28) * (0.78 + rnd() * 0.44);
        const n = 5;
        for (let k = 0; k < n; k++) {
          const a = w * 1.31 + (k / n) * TAU + rnd() * 0.5;
          const rr = R * (0.8 + rnd() * 0.4);
          const ex = Math.cos(a) * rr * 0.92;
          const ez = Math.sin(a) * rr * 0.92;
          limb(0, wy, 0, ex, -rr * 0.26, ez, Math.hypot(ex, ez, rr * 0.26),
            o.radius * 0.2 * (1.1 - t), 0.5, 4, 0xcfc3b4);
          cluster(ex * 0.6, wy - rr * 0.08, ez * 0.6, rr * 0.4, 2, rr * 0.36, 0.66);
          cluster(ex, wy - rr * 0.2, ez, rr * 0.33, 1, rr * 0.3, 0.6);
        }
      }
      cluster(0, H * 0.99, 0, o.leafR * 0.34, 3, o.leafR * 0.22, 0.95);
    } else {
      /* Broadleaf: a short bole that forks hard, so the crown is wider than the
       * tree is tall - the silhouette that reads as "oak" at 80 metres. */
      const grow = (px, py, pz, dx, dy, dz, len, rad, depth) => {
        const end = limb(px, py, pz, dx, dy, dz, len, rad, o.taper,
          depth === 0 ? 9 : 5, depth === 0 ? 0xffffff : 0xd6ccc0);
        if (depth >= o.depth) {
          /* Terminal crown mass.
           *
           * Three blobs thrown across 0.9x leafR is a spread wide enough that
           * neighbouring branch tips overlap each other's clusters, and the
           * whole crown fuses into one continuous undifferentiated lump - the
           * "cauliflower soup with no internal read" every review reported.
           * Two blobs at 0.55 spread keeps each branch tip's foliage attached
           * to *its* branch, so the crown resolves as a set of masses with
           * gaps and sky between them rather than as one arc.
           */
          cluster(end.x, end.y + o.leafR * 0.15, end.z, o.leafR * 0.95, 2, o.leafR * 0.55, 0.92);
          cluster(px + (end.x - px) * 0.6, py + (end.y - py) * 0.6, pz + (end.z - pz) * 0.6,
            o.leafR * 0.7, 1, o.leafR * 0.4, 0.92);
          return;
        }
        dir.set(dx, dy, dz).normalize();
        const n = o.branches + (rnd() < 0.45 ? 1 : 0);
        const base = rnd() * TAU;
        for (let i = 0; i < n; i++) {
          const a = base + (i / n) * TAU + (rnd() - 0.5) * 0.6;
          const sp = o.spread * (0.8 + rnd() * 0.45);
          grow(
            end.x, end.y, end.z,
            dir.x * (1 - sp) + Math.cos(a) * sp,
            dir.y * (1 - sp * o.droop) + o.rise * (1 - sp),
            dir.z * (1 - sp) + Math.sin(a) * sp,
            len * (o.shrink + rnd() * 0.1), rad * o.radShrink, depth + 1
          );
        }
      };
      grow(0, 0, 0, (rnd() - 0.5) * 0.1, 1, (rnd() - 0.5) * 0.1, o.trunk, o.radius, 0);
      // Fill the heart of the crown so you never see straight through the
      // middle. Three fat lumps, not five: interior blobs are fully enclosed by
      // their siblings and every triangle in them is invisible.
      cluster(0, o.trunk * 1.55, 0, o.leafR * 1.25, 3, o.leafR * 1.0, 0.88);
    }

    const trunkGeo = mergeGeometries(wood, false);
    for (const g of wood) g.dispose();
    const leafGeo = leaves.length ? mergeGeometries(leaves, false) : null;
    for (const g of leaves) g.dispose();
    return { trunk: trunkGeo, leaf: leafGeo };
  }

  /**
   * Two secondary landmarks out on the ridges.
   *
   * From the ramparts the world previously ended in a flat green line with one
   * tower on it: nothing anywhere in the 140-190m band gave a player a reason
   * to walk away from the castle. A working windmill to the west and a ruined
   * watchtower to the south-east both break the horizon and both read as
   * destinations rather than scenery.
   */
  _buildLandmarks() {
    const B = new GeoBatch();
    const place = (x, y, z, ry = 0) => {
      _obj.position.set(x, y, z);
      _obj.rotation.set(0, ry, 0);
      _obj.scale.set(1, 1, 1);
      return _obj;
    };

    /* ---- Windmill on the western rise ------------------------------- */
    const mx = -88;
    const mz = -150;
    const my = this._height(mx, mz);
    B.add('rubble', cylGeo(2.5, 4.2, 11.5, 16, 0.45), place(mx, my + 5.75, mz), 0xb2a996);
    B.add('rubble', cylGeo(4.6, 4.9, 1.1, 16, 0.6), place(mx, my + 0.55, mz), 0xa79f8d);
    B.add('ashlar', cylGeo(2.8, 2.6, 0.5, 16, 0.7), place(mx, my + 11.7, mz), 0xc3bba8);
    B.add('slate', coneGeo(3.1, 3.0, 16, 0.7), place(mx, my + 13.4, mz), 0xa8b2be);
    // Door, window and the stage rail around the tower.
    B.add('plank', boxGeo(1.5, 2.4, 0.22, 0.9), place(mx, my + 1.4, mz + 3.9), 0x6d4f30);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      B.add('beam', boxGeo(0.12, 1.0, 0.12, 1.4),
        place(mx + Math.cos(a) * 4.4, my + 1.6, mz + Math.sin(a) * 4.4, -a), 0x7a6144);
    }
    this._ringWall(mx, my + 5.75, mz, 3.6, 5.75, 0.8, 10);
    this._footprints.push({ x: mx, z: mz, hx: 8, hz: 8, r: 0 });

    // Sails on their own pivot so they turn: a still windmill reads as a prop.
    const sailParts = [];
    const pushSail = (g, x, y, z, rx, ry2, rz2) => {
      _obj.position.set(x, y, z);
      _obj.rotation.set(rx || 0, ry2 || 0, rz2 || 0);
      _obj.scale.set(1, 1, 1);
      _obj.updateMatrix();
      g.applyMatrix4(_obj.matrix);
      sailParts.push(normaliseGeo(g, 0x9c8156));
    };
    pushSail(cylGeo(0.3, 0.34, 1.6, 10, 1.0), 0, 0, 0, Math.PI / 2, 0, 0);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU;
      pushSail(boxGeo(0.22, 8.4, 0.22, 1.0), Math.sin(a) * 4.2, Math.cos(a) * 4.2, 0, 0, 0, a);
      for (let k = 0; k < 6; k++) {
        const t = 1.4 + k * 1.15;
        pushSail(boxGeo(1.5, 0.14, 0.14, 1.4),
          Math.sin(a) * t + Math.cos(a) * 0.7, Math.cos(a) * t - Math.sin(a) * 0.7, 0, 0, 0, a);
      }
    }
    const sailGeo = mergeGeometries(sailParts, false);
    for (const g of sailParts) g.dispose();
    const sails = new THREE.Mesh(sailGeo, this._mats.beam);
    sails.castShadow = true;
    sails.receiveShadow = true;
    const sailPivot = new THREE.Object3D();
    sailPivot.position.set(mx, my + 11.4, mz + 3.4);
    sailPivot.add(sails);
    this.group.add(sailPivot);
    this._sails = sailPivot;
    this._owned.push(sailGeo);

    /* ---- Ruined watchtower on the south-eastern ridge ---------------- */
    const tx = 160;
    const tz = -20;
    const ty = this._height(tx, tz);
    B.add('rubble', cylGeo(3.0, 3.6, 12.5, 14, 0.45), place(tx, ty + 6.25, tz), 0xcfc6b0);
    B.add('rubble', cylGeo(3.9, 4.1, 1.2, 14, 0.6), place(tx, ty + 0.6, tz), 0xc0b7a2);
    // Broken crown: half the merlon ring survives, the rest has fallen in.
    for (let i = 0; i < 12; i++) {
      if (i > 4 && i < 9) continue;
      const a = (i / 12) * TAU;
      const h = 0.7 + ((i * 7) % 5) * 0.34;
      B.add('rubble', boxGeo(0.7, h, 1.5, 0.6),
        place(tx + Math.cos(a) * 2.7, ty + 12.5 + h / 2, tz + Math.sin(a) * 2.7, -a), 0xc8bfa9);
    }
    // Collapsed masonry spilling down the slope.
    const rrnd = mulberry32(0x51a7e);
    for (let i = 0; i < 26; i++) {
      const a = rrnd() * TAU;
      const d = 4.2 + rrnd() * 9;
      const px = tx + Math.cos(a) * d;
      const pz = tz + Math.sin(a) * d;
      _obj.position.set(px, this._height(px, pz) + 0.2 + rrnd() * 0.3, pz);
      _obj.rotation.set(rrnd() * 0.7, rrnd() * TAU, rrnd() * 0.7);
      _obj.scale.set(1, 1, 1);
      B.add('rock', boxGeo(0.7 + rrnd() * 1.2, 0.5 + rrnd() * 0.7, 0.6 + rrnd() * 1.1, 0.6),
        _obj, 0xc4bba6);
    }
    this._ringWall(tx, ty + 6.25, tz, 3.2, 6.25, 0.7, 10);
    this._footprints.push({ x: tx, z: tz, hx: 9, hz: 9, r: 0 });

    B.build(this._mats, this.group, { ao: this._heightFn });
  }

  async _buildNature() {
    this._buildLandmarks();
    const rnd = mulberry32(0x7ee5);

    /* ---- Four archetypes ------------------------------------------- */
    const archetypes = [
      { name: 'oak', seed: 11, kind: 'broadleaf', trunk: 3.0, radius: 0.46, taper: 0.66,
        depth: 2, branches: 3, spread: 0.78, droop: 0.55, rise: 0.72, shrink: 0.7,
        radShrink: 0.52, leafR: 1.5, scale: [0.95, 1.5] },
      // leafR 1.0 on a 4.4m bole gave the birch a crown too small to hold
      // together: past eighty metres it stopped being a tree and became a
      // handful of dark specks around a stick.
      { name: 'birch', seed: 29, kind: 'broadleaf', trunk: 4.4, radius: 0.26, taper: 0.78,
        depth: 2, branches: 3, spread: 0.5, droop: 0.2, rise: 1.05, shrink: 0.6,
        radShrink: 0.5, leafR: 1.45, scale: [0.9, 1.3] },
      { name: 'pine', seed: 47, kind: 'conifer', trunk: 11.5, radius: 0.5, leafR: 3.6,
        scale: [0.75, 1.25] },
      { name: 'willow', seed: 83, kind: 'broadleaf', trunk: 2.4, radius: 0.56, taper: 0.62,
        depth: 2, branches: 4, spread: 0.86, droop: 1.5, rise: 0.36, shrink: 0.72,
        radShrink: 0.5, leafR: 1.35, scale: [0.9, 1.25] },
    ];
    /* Each archetype is grown twice: once at crown detail, once cheap. The
     * second pass throws its trunk away - trunks are 176-468 triangles and
     * 11% of the tree load, so a second trunk tessellation would be code and
     * memory spent on nothing. It is the crowns that are 1.51M triangles. */
    const built = archetypes.map((a) => {
      const geo = this._treeArchetype(a);
      const cheap = this._treeArchetype(a, 'lo');
      cheap.trunk.dispose();
      geo.leafLo = cheap.leaf;
      return { a, geo, list: [] };
    });

    /* ---- Placement ------------------------------------------------- *
     *
     * Two changes from the scatter this replaces, and the second is the one
     * that turns a scatter into a wood.
     *
     * The count is DERIVED. `PLAYFIELD_TREES` is a density multiplied by the
     * stand-weighted area of the map, integrated in `Woodland.js` - so the
     * 520 absolute trees that were correct for a 400 m vale and left a 900 m
     * one with 0.6 trees per hectare of "woodland" become ~1,450, and the
     * number follows the mask and the extent from now on rather than needing
     * to be remembered.
     *
     * Acceptance is PROPORTIONAL to `standAt` rather than gated on a
     * threshold. `wood > 0.02` accepted 47% of the map at uniform density: no
     * edge to arrive at, no interior to be inside, and every tree with the
     * same neighbourhood as every other. Rejection sampling against the stand
     * field puts the trees where the field is, which means density climbs
     * across a fringe, holds through an interior and drops out in the glades -
     * and it does all of that for the same one line the threshold cost.
     */
    const total = PLAYFIELD_TREES;
    const BUCKETS = Math.ceil(SIZE / TREE_BUCKET_M);
    const bucketAt = (x, z) => {
      const bx = Math.min(BUCKETS - 1, Math.max(0, Math.floor((x + HALF) / TREE_BUCKET_M)));
      const bz = Math.min(BUCKETS - 1, Math.max(0, Math.floor((z + HALF) / TREE_BUCKET_M)));
      return bz * BUCKETS + bx;
    };
    /* Each bucket is a STAND with two species in it, not a random mix of four.
     * That halves the instanced-mesh count against a naive per-species split
     * and it is also what a real wood is - see `standSpecies`. */
    const bucketSpecies = new Array(BUCKETS * BUCKETS);
    for (let bz = 0; bz < BUCKETS; bz++) {
      for (let bx = 0; bx < BUCKETS; bx++) {
        const cx = -HALF + (bx + 0.5) * TREE_BUCKET_M;
        const cz = -HALF + (bz + 0.5) * TREE_BUCKET_M;
        bucketSpecies[bz * BUCKETS + bx] = standSpecies(bx, bz, woodMask(cx, cz));
      }
    }
    /** archetype index -> Map(bucket index -> flat [x, z, r, ...]) */
    const cells = built.map(() => new Map());
    const drop = (pick, x, z, r) => {
      const bi = bucketAt(x, z);
      let arr = cells[pick].get(bi);
      if (!arr) cells[pick].set(bi, (arr = []));
      arr.push(x, z, r);
    };
    let placedTrees = 0;
    let guard = 0;
    while (placedTrees < total && guard++ < total * 40) {
      if ((guard & 511) === 0) await this._breathe();
      const x = (rnd() - 0.5) * (SIZE - 8);
      const z = (rnd() - 0.5) * (SIZE - 8);
      const rd = Math.abs(z - riverZ(x));
      // The willow band tracks the channel rather than sitting at a fixed
      // 12-24 m: at Reedwater the channel alone is 26 m wide.
      const hw = riverHalfWidth(x);
      const nearWater = rd < hw + 14.5 && rd > hw + 2.5;
      const stand = standAt(x, z);
      let pick = -1;
      if (nearWater && rnd() < 0.6) {
        pick = rnd() < 0.55 ? 3 : 0;
      } else if (stand > 0 && rnd() < stand) {
        const pair = bucketSpecies[bucketAt(x, z)];
        pick = rnd() < 0.74 ? pair[0] : pair[1];
      } else if (rnd() < 0.018) {
        // Hedgerow and field-corner strays. A landscape with trees ONLY in
        // woods reads as a map with woodland polygons stamped on it.
        pick = rnd() < 0.62 ? 0 : 1;
      }
      if (pick < 0) continue;
      if (!this._isPlantable(x, z, 2.2)) continue;
      if (this._inHeroClear(x, z, 2.6)) continue;
      if (this._slope(x, z) > 0.55) continue;
      drop(pick, x, z, rnd());
      placedTrees++;
    }

    /* ---- Authored repoussoir on the castle approach ------------------ *
     * Scatter cannot compose a frame. The castle-approach vantage had a bare
     * lower-left quadrant and an unimportant cropped cottage on the right, so
     * the eye had no dark near element to read depth against and the subject
     * had nothing holding it in the frame. These four are hand-placed to build
     * a dark overhanging mass down the left edge at 12-20m, which is the
     * classic repoussoir and the cheapest way to give a landscape frame a
     * foreground plane. They sit outside the road corridor and outside the
     * castle sightline cone, so they frame the keep rather than mask it. */
    for (const [fx, fz, fr, kind] of [
      [-51, 47, 0.92, 0], [-56, 44, 0.78, 0], [-58, 53, 0.66, 1], [-49, 62, 0.84, 0],
    ]) {
      drop(kind, fx, fz, fr);
    }

    /* ---- Instancing ------------------------------------------------- *
     *
     * A 150 m grid, not the four map quadrants this used to use.
     *
     * The quadrant split is honest about its own failure in the
     * `CANOPY_LO_DISTANCE` docstring: a quadrant's bounding sphere has a 318 m
     * radius at 900 m, its nearest point is underfoot from almost anywhere, so
     * the 90 m canopy LOD swap never fires and the bucket never frustum-culls
     * either. Both problems are the same problem - the bucket is too big to
     * say anything about.
     *
     * A 150 m cell's sphere is 106 m across the diagonal plus ~8 m of crown,
     * so its nearest point clears 90 m once the camera is ~204 m from the cell
     * centre, which on this map is true of most cells from most standpoints.
     * The swap is a 4x cut on broadleaf crowns and 2.5x on conifers, taken on
     * the two thirds of the wood where the facet count is unrecoverable.
     *
     * The bill is meshes: 36 cells against 4. `standSpecies` caps a cell at
     * two archetypes to keep that bounded, and empty cells cost nothing.
     */
    for (let ai = 0; ai < built.length; ai++) {
      const b = built[ai];
      for (const bucket of cells[ai].values()) {
        const n = bucket.length / 3;
        if (!n) continue;
        const trunkMesh = new THREE.InstancedMesh(b.geo.trunk, this._mats.bark, n);
        const leafMesh = b.geo.leaf
          ? new THREE.InstancedMesh(b.geo.leaf, this._mats.leaf, n)
          : null;
        for (let i = 0; i < n; i++) {
          const x = bucket[i * 3];
          const z = bucket[i * 3 + 1];
          const r = bucket[i * 3 + 2];
          const sc = b.a.scale[0] + r * (b.a.scale[1] - b.a.scale[0]);
          const y = this._height(x, z);
          _obj.position.set(x, y - 0.15, z);
          _obj.rotation.set((r - 0.5) * 0.08, r * TAU, (r - 0.5) * 0.08);
          _obj.scale.set(sc * (0.92 + r * 0.16), sc, sc * (0.92 + r * 0.16));
          _obj.updateMatrix();
          trunkMesh.setMatrixAt(i, _obj.matrix);
          if (leafMesh) {
            leafMesh.setMatrixAt(i, _obj.matrix);
            // The albedo sheet already supplies the colour. This multiplier
            // exists only to break identical crowns apart, so it varies value
            // and hue and stays close to neutral - a 0.34-0.54 saturation on
            // top of a green albedo on top of a green transmission tint is how
            // the canopies ended up more saturated than the dusk sky.
            // Conifers sit a good deal darker and greener than the broadleaf
            // set. They are the trees that fill the 80-160m band, and at that
            // distance a pale needle mass reads as a stack of plaster discs
            // rather than as a fir.
            if (b.a.kind === 'conifer') _col.setHSL(0.27 + r * 0.03, 0.26 + r * 0.10, 0.16 + r * 0.10);
            else _col.setHSL(0.19 + r * 0.05, 0.20 + r * 0.12, 0.30 + r * 0.16);
            leafMesh.setColorAt(i, _col);
          }
          // Trunks block movement; canopies do not.
          this._box(x, y + 1.6 * sc, z, b.a.radius * sc * 1.5, 1.8 * sc, b.a.radius * sc * 1.5);
          this._contacts.push(x, y, z, Math.min(2.3, (b.a.leafR ?? 1.4) * sc * 0.85));
        }
        for (const m of [trunkMesh, leafMesh]) {
          if (!m) continue;
          m.castShadow = true;
          m.receiveShadow = true;
          m.instanceMatrix.needsUpdate = true;
          if (m.instanceColor) m.instanceColor.needsUpdate = true;
          m.computeBoundingSphere();
          this.group.add(m);
        }
        /* Nearest-point, so a bucket only demotes once every tree in it is
         * past the threshold. At 150 m cells that is now a statement with
         * teeth - see the note above. */
        if (leafMesh && b.geo.leafLo) {
          this._lod.add(leafMesh, {
            lo: b.geo.leafLo, swapBeyond: CANOPY_LO_DISTANCE, measure: SURFACE,
          });
        }
        await this._breathe();
      }
      this._owned.push(b.geo.trunk);
      if (b.geo.leaf) this._owned.push(b.geo.leaf);
      if (b.geo.leafLo) this._owned.push(b.geo.leafLo);
    }

    /* ---- Understorey ------------------------------------------------ *
     *
     * This is what actually makes a wood a wood to be inside, and it is the
     * cheap half of the deal. A crown is 2,880-4,560 triangles and sits four
     * to eleven metres up, where it blocks the sky; a hazel thicket is SIX -
     * three crossed cards, one quad each, as built below - and stands between
     * a player's eye and a wolf's.
     *
     * Thickets and bracken share one three-card geometry and one instanced
     * mesh per map quadrant, separated only by scale - so the whole
     * understorey of the vale is four draw calls and 58,278 triangles
     * (4,571 + 5,142 instances at six), 1.6% of the 3,700,800 the trees carry
     * at the cheapest crown. `Woodland.js` quotes the same two numbers.
     */
    {
      const CARD_W = 1.15;
      const CARD_H = 1.5;
      const parts = [];
      for (let i = 0; i < 3; i++) {
        const g = planeGeo(CARD_W, CARD_H, 0);
        g.translate(0, CARD_H * 0.5, 0);
        g.rotateY((i / 3) * Math.PI);
        parts.push(normaliseGeo(g, 0xffffff));
      }
      const brushGeo = mergeGeometries(parts, false);
      for (const g of parts) g.dispose();
      {
        // Same two fixes the grass tuft gets: normals forced up so the cards
        // shade off the ground plane, and a root-to-tip ramp so a thicket
        // roots into the litter instead of ending on a hard edge.
        const nrm = brushGeo.attributes.normal;
        const pos = brushGeo.attributes.position;
        const col = brushGeo.attributes.color;
        for (let i = 0; i < nrm.count; i++) {
          nrm.setXYZ(i, 0, 1, 0);
          const t = smoothstep(0, 1, clamp01(pos.getY(i) / CARD_H));
          const k = 0.30 + 0.95 * t;
          col.setXYZ(i, k * 0.92, k, k * 0.78);
        }
        nrm.needsUpdate = true;
        col.needsUpdate = true;
      }
      this._owned.push(brushGeo);
      const want = UNDERSTOREY + BRACKEN;
      const quads = [[], [], [], []];
      let ug = 0;
      let un = 0;
      while (un < want && ug++ < want * 26) {
        if ((ug & 1023) === 0) await this._breathe();
        const x = (rnd() - 0.5) * (SIZE - 10);
        const z = (rnd() - 0.5) * (SIZE - 10);
        const stand = standAt(x, z);
        /* Thickets crowd the FRINGE - which is what a woodland edge is, a
         * belt of blackthorn you cannot walk through - and thin out under
         * closed canopy where there is no light. Bracken does the opposite.
         *
         * The fringe test is inlined against the stand value already in
         * hand rather than calling `isWoodEdge`, which would recompute the
         * same five octaves of noise: this loop runs ~50,000 times and the
         * mask is the only expensive thing in it. `isWoodEdge` is still the
         * definition - see the assertion in medieval-forest.test.mjs that
         * pins the two to the same band. */
        const edge = stand > 0.12 && stand < 0.72;
        const p = edge ? 0.95 : stand * 0.55;
        if (rnd() > p) continue;
        if (!this._isPlantable(x, z, 0.9)) continue;
        if (this._inHeroClear(x, z, 1.4)) continue;
        if (this._slope(x, z) > 0.62) continue;
        const y = this._height(x, z);
        if (y < WATER_Y + 0.4) continue;
        const thicket = un < UNDERSTOREY;
        const q = (x < 0 ? 0 : 1) + (z < 0 ? 0 : 2);
        quads[q].push(x, y, z, thicket ? 1 : 0, rnd());
        un++;
      }
      for (const q of quads) {
        const n = q.length / 5;
        if (!n) continue;
        const mesh = new THREE.InstancedMesh(brushGeo, this._mats.leaf, n);
        for (let i = 0; i < n; i++) {
          const x = q[i * 5];
          const y = q[i * 5 + 1];
          const z = q[i * 5 + 2];
          const thicket = q[i * 5 + 3] === 1;
          const r = q[i * 5 + 4];
          const sc = thicket ? 1.15 + r * 1.0 : 0.36 + r * 0.30;
          _obj.position.set(x, y - 0.08, z);
          _obj.rotation.set(0, r * TAU, 0);
          _obj.scale.set(sc * (0.85 + r * 0.4), sc * (thicket ? 1.35 : 0.85), sc * (0.85 + r * 0.4));
          _obj.updateMatrix();
          mesh.setMatrixAt(i, _obj.matrix);
          if (thicket) _col.setHSL(0.24 + r * 0.05, 0.20 + r * 0.10, 0.16 + r * 0.10);
          else _col.setHSL(0.16 + r * 0.06, 0.26 + r * 0.12, 0.22 + r * 0.14);
          mesh.setColorAt(i, _col);
        }
        mesh.count = n;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        this.group.add(mesh);
        await this._breathe();
      }
    }

    /* ---- Deadfall, per named wood ----------------------------------- *
     *
     * Fallen trunks, root plates, stumps and brash. One `GeoBatch` district
     * per wood, so a wood costs three draw calls whatever this contains - and
     * a district 70-90 m across frustum-culls as a unit, which is the whole
     * reason the deadfall is bucketed by WOOD rather than scattered globally.
     *
     * It is also the cheapest signal there is that a wood has been standing
     * for two centuries rather than being planted this morning: a forest floor
     * with nothing on it reads as a lawn with trees in it, at any tree count.
     */
    for (const wood of NAMED_WOODS) {
      const WB = new GeoBatch();
      const wr = mulberry32(0xdead00 + Math.abs(wood.x * 31 + wood.z));
      let dropped = 0;
      let dg = 0;
      while (dropped < DEADFALL_PER_WOOD && dg++ < DEADFALL_PER_WOOD * 30) {
        const a = wr() * TAU;
        const rr = Math.sqrt(wr()) * wood.r;
        const x = wood.x + Math.cos(a) * rr;
        const z = wood.z + Math.sin(a) * rr;
        if (standAt(x, z) < 0.25) continue;
        if (!this._isPlantable(x, z, 1.2)) continue;
        if (this._inHeroClear(x, z, 2.0)) continue;
        const y = this._height(x, z);
        const roll = wr();
        _obj.scale.set(1, 1, 1);
        if (roll < 0.42) {
          // A fallen trunk, half sunk into the litter, with a root plate.
          const len = 5.0 + wr() * 6.5;
          const rad = 0.28 + wr() * 0.24;
          const yaw = wr() * TAU;
          _obj.position.set(x, y + rad * 0.55, z);
          _obj.rotation.set(0, yaw, Math.PI / 2);
          _obj.updateMatrix();
          WB.add('bark', cylGeo(rad * 0.72, rad, len, 7, 0.9), _obj, 0x6a5a46);
          this._box(x, y + rad * 0.6, z, Math.abs(Math.cos(yaw)) * len / 2 + rad,
            rad, Math.abs(Math.sin(yaw)) * len / 2 + rad);
          const px = x + Math.cos(yaw) * len * 0.5;
          const pz = z - Math.sin(yaw) * len * 0.5;
          _obj.position.set(px, this._height(px, pz) + 0.7, pz);
          _obj.rotation.set(0, yaw, 0);
          _obj.updateMatrix();
          WB.add('bark', cylGeo(rad * 3.4, rad * 3.0, 0.5, 9, 0.8), _obj, 0x584a3a);
          for (let k = 0; k < 5; k++) {
            _obj.position.set(px, this._height(px, pz) + 0.9 + k * 0.18, pz);
            _obj.rotation.set(wr() * 0.9 - 0.45, wr() * TAU, wr() * 0.9 - 0.45);
            _obj.updateMatrix();
            WB.add('bark', cylGeo(0.05, 0.09, 1.2 + wr() * 0.8, 4, 1.2), _obj, 0x4f4335);
          }
          this._contacts.push(x, y, z, len * 0.4);
        } else if (roll < 0.72) {
          // A stump, cut or snapped.
          const rad = 0.35 + wr() * 0.35;
          const h = 0.5 + wr() * 0.9;
          _obj.position.set(x, y + h / 2 - 0.1, z);
          _obj.rotation.set((wr() - 0.5) * 0.18, wr() * TAU, (wr() - 0.5) * 0.18);
          _obj.updateMatrix();
          WB.add('bark', cylGeo(rad * 0.88, rad, h, 9, 0.9), _obj, 0x6f5f4a);
          _obj.position.set(x, y + h - 0.1, z);
          _obj.rotation.set(0, 0, 0);
          _obj.updateMatrix();
          WB.add('bark', cylGeo(rad * 0.86, rad * 0.86, 0.08, 9, 1.4), _obj, 0xbaa27c);
          this._box(x, y + h / 2, z, rad, h / 2, rad);
          this._contacts.push(x, y, z, rad * 1.6);
        } else {
          // A brash pile: cut branches heaped where the coppicing stopped.
          for (let k = 0; k < 7; k++) {
            _obj.position.set(x + (wr() - 0.5) * 1.6, y + 0.16 + wr() * 0.5, z + (wr() - 0.5) * 1.6);
            _obj.rotation.set((wr() - 0.5) * 0.6, wr() * TAU, Math.PI / 2 + (wr() - 0.5) * 0.5);
            _obj.updateMatrix();
            WB.add('bark', cylGeo(0.05, 0.08, 1.4 + wr() * 1.4, 4, 1.2), _obj, 0x5f5140);
          }
          this._contacts.push(x, y, z, 1.4);
        }
        dropped++;
      }
      WB.build(this._mats, this.group, { ao: this._heightFn, cast: true, receive: true });
      await this._breathe();
    }

    /* ---- Layered ridge stands -------------------------------------- *
     * Depth in a landscape frame comes from repeated silhouettes at
     * progressively stronger fog mixes, not from one distant hill. Beyond the
     * playfield there was nothing at all, so the far half of every vista was a
     * bare green ramp and the world had exactly two depth planes. Three rings
     * of conifer stands at ~230m, ~280m and ~330m sit at roughly 55%, 70% and
     * 85% atmospheric mix, which is what actually reads as a kilometre. */
    {
      const pine = built[2];
      /* Ring radii, as multiples of HALF.
       *
       * They HAVE to scale. Every sample is rejected unless it lands outside
       * the playfield square (`_inPlayfield(x, z, -6)` below), so a ring left
       * at a fixed 208-358m would sit entirely inside a 900m vale, place
       * nothing at all, and burn its whole 80x guard budget finding that out -
       * a backdrop that silently vanishes rather than one that fails loudly.
       * 1.04-1.79 HALF is where they were at 400m. */
      const rings = [
        [HALF * 1.04, HALF * 1.26], [HALF * 1.28, HALF * 1.51], [HALF * 1.53, HALF * 1.79],
      ];
      for (let ri = 0; ri < rings.length; ri++) {
        const [r0, r1] = rings[ri];
        // Many small trees, not a few big ones. Fifty-four 30m firs spread over
        // a 250m ring resolve as individually readable popcorn on the skyline;
        // a hundred 12m ones at the same ring merge into the ragged treeline
        // mass that is the whole point of the layer.
        /* Scaled to the ring's own circumference, not left absolute.
         *
         * The rings are at 1.04-1.79 HALF, so at 900 m they are 2.25x the
         * length they were at 400 m: an absolute count thins the treeline by
         * the same factor, and the ragged skyline mass the layer exists for
         * becomes a row of individually countable firs. Scaled by HALF / 250
         * rather than by the full 2.25, because these three meshes are in
         * frustum from every vantage in the world and their triangles are the
         * most expensive in it - see the LOD note below. */
        const wanted = Math.round((104 - ri * 16) * (HALF / 300));
        /* Crowns only - the rings draw no trunks at all.
         *
         * A fir trunk is 468 triangles, which is 27% of a ridge tree once the
         * canopy LOD has fired, and these three meshes are in frustum from
         * every vantage in the world: at 475 firs that was 222,000 triangles
         * submitted every single frame, permanently. They also cannot be seen.
         * The stands sit 1.5 m INTO the slope specifically so the bare lower
         * boles never show as a row of stilts (see the scale note below), the
         * crown skirt covers the rest, they cast no shadow, and the nearest of
         * them is 468 m away behind 60% atmospheric haze. Dropping them costs
         * nothing that can be photographed and is the single largest saving
         * available anywhere in the foliage.
         */
        const lm = new THREE.InstancedMesh(pine.geo.leaf, this._mats.leaf, wanted);
        let placed = 0;
        let g3 = 0;
        while (placed < wanted && g3++ < wanted * 80) {
          const ang = rnd() * TAU;
          const rad = r0 + rnd() * (r1 - r0);
          const x = Math.cos(ang) * rad;
          const z = Math.sin(ang) * rad;
          /* A circular ring crosses a square playfield.
           *
           * The playfield is a square, so its corners reach HALF * sqrt(2)
           * and the inner two rings spend most of their diagonal arc *inside*
           * the map. That put roughly 240 backdrop firs
           * on the playable terrain: no collider, no cast shadow, sized for a
           * quarter-kilometre of haze, and walkable straight through. They
           * belong strictly beyond the border, so the test is the square's,
           * not the circle's.
           */
          if (this._inPlayfield(x, z, -6)) continue;
          // Clump into stands: an even ring of trees reads as a fence.
          if (fbm2(x * 0.0055, z * 0.0055, 3) < 0.04 && rnd() > 0.16) continue;
          // Ground check. Out here the skirt, not the playfield heightfield,
          // is the surface, so `_outerHeight` is the authority - and anything
          // that lands in the water gets dropped rather than floated.
          const y = this._outerHeight(x, z);
          if (y < WATER_Y + 2) continue;
          // 1.5-3.4 put 17-39m firs on the ridge. At a quarter-kilometre the
          // lump geometry is all you can see, so an oversized one just reads as
          // a stack of pale balls. Smaller, and set a metre and a half into the
          // slope so the bare lower trunks never show as a row of stilts.
          const sc = 0.72 + rnd() * 0.58;
          _obj.position.set(x, y - 1.5 * sc, z);
          _obj.rotation.set(0, rnd() * TAU, 0);
          _obj.scale.set(sc * (0.9 + rnd() * 0.2), sc, sc * (0.9 + rnd() * 0.2));
          _obj.updateMatrix();
          lm.setMatrixAt(placed, _obj.matrix);
          // Far foliage is almost pure value: any saturation out here fights
          // the aerial perspective the fog is doing.
          // Dark enough that the fog mix, not the albedo, sets the final value.
          // At 0.22-0.32 the 30-55% haze on these rings lifted them to a pale
          // cream that read brighter than the village in front of them.
          _col.setHSL(0.22, 0.10 + rnd() * 0.06, 0.11 + rnd() * 0.07 - ri * 0.015);
          lm.setColorAt(placed, _col);
          placed++;
        }
        if (!placed) continue;
        for (const m of [lm]) {
          m.count = placed;
          // Nothing out here is inside the shadow cascade, and nothing can be
          // walked to, so both costs are simply removed.
          m.castShadow = false;
          m.receiveShadow = false;
          m.instanceMatrix.needsUpdate = true;
          if (m.instanceColor) m.instanceColor.needsUpdate = true;
          m.computeBoundingSphere();
          this.group.add(m);
        }
        /* These three meshes are 808k of the world's 1.51M canopy triangles
         * and they are in frustum from every named vantage, because a ring
         * centred on the map has a bounding sphere that covers the map. That
         * is also why they cannot use a sphere measure: nearest-point reports
         * zero from anywhere inside, centre distance reports ~0 as well, and
         * neither band would ever fire. The distance that actually matters
         * for a ring is the distance to the ring itself, so that is what is
         * measured - horizontal only, since the camera's height above the
         * valley is at most a few tens of metres against a 200m+ radius and
         * ignoring it errs toward keeping the detail. */
        const mid = (r0 + r1) * 0.5;
        const halfW = (r1 - r0) * 0.5;
        this._lod.add(lm, {
          lo: pine.geo.leafLo,
          swapBeyond: CANOPY_LO_DISTANCE,
          measure: (cam) => Math.max(0, Math.abs(Math.hypot(cam.x, cam.z) - mid) - halfW),
        });
        await this._breathe();
      }
    }

    /* ---- Grass ------------------------------------------------------ *
     * Scale first, because everything else was downstream of getting it
     * wrong. The tuft was a 0.62 x 0.72m card taken up to 2.12x horizontally
     * and 1.6x vertically by the instance transform, so the tallest blades
     * stood 2.4m - taller than the player, wider than a doorway. That is not
     * grass at any density; it is a hedge of green spikes, and it is why the
     * village square framing had chest-high cards leaning over a barrel.
     *
     * A 0.30 x 0.26m card at 0.75-1.45x lands blades between 14 and 53cm:
     * ankle to shin against a 1.75m human. Four cards instead of three, and
     * roughly five times the instance count, because once each tuft is small
     * the field only reads if there are enough of them. */
    /* Round 4: 0.30 x 0.26m at 1.16 instances/m2 was countable. Each tuft read
     * as an individual intersecting card with metres of bare macro texture
     * between it and the next one, which is worse than no grass at all because
     * it advertises the technique. 0.42 x 0.58m on three cards at 60 degrees
     * covers roughly three times the ground per instance for 25% fewer
     * triangles, and the placement below clumps rather than scatters. */
    const TUFT_W = 0.42;
    const TUFT_H = 0.58;
    const tuft = [];
    for (let i = 0; i < 3; i++) {
      const g = planeGeo(TUFT_W, TUFT_H, 0);
      g.translate(0, TUFT_H * 0.5, 0);
      g.rotateY((i / 3) * Math.PI);
      tuft.push(normaliseGeo(g, 0xffffff));
    }
    const tuftGeo = mergeGeometries(tuft, false);
    for (const g of tuft) g.dispose();
    {
      // Two fixes that turn grass cards from black spikes into lit blades.
      //
      // 1. Intersecting cards inherit sideways face normals, so half of every
      //    tuft faces away from the sun and renders as a silhouette against
      //    the ground it is growing out of. Force every normal to +Y and the
      //    blades shade off the ground plane's orientation, which is the
      //    standard foliage-card trick and the only thing that looks right.
      // 2. Darken the base vertices so each blade roots into the terrain
      //    instead of terminating on a hard edge.
      const nrm = tuftGeo.attributes.normal;
      const pos = tuftGeo.attributes.position;
      const col = tuftGeo.attributes.color;
      const gc = this.environment.groundColor;
      const gr = gc.r * 1.35 + 0.18;
      const gg = gc.g * 1.35 + 0.18;
      const gb = gc.b * 1.35 + 0.18;
      // 3. Ramp root-to-tip. A single flat value per blade is what made the
      //    tufts read as hard dark triangles; real grass is nearly black in
      //    the thatch and a stop and a half brighter and warmer at the tip.
      for (let i = 0; i < nrm.count; i++) {
        nrm.setXYZ(i, 0, 1, 0);
        // Ramp against the card's real height. The old divisor was the card
        // *width*, so the ramp ran off the top of the blade and the tips never
        // reached full value.
        const t = smoothstep(0, 1, clamp01(pos.getY(i) / TUFT_H));
        const k = 0.34 + 0.98 * t;
        /* 4. Bind the ramp to the environment's own ground colour.
         *
         * The tufts were authored against nothing and ignored the dusk grade
         * entirely, so they came out brighter and more saturated than every
         * other surface in a graded frame and read as a decal sprayed over the
         * terrain. Pulling the ramp 35% toward `env.groundColor` puts them in
         * the same value band as the macro texture they are growing out of. */
        col.setXYZ(
          i,
          lerp(k * (1 + 0.16 * t), gr * k, 0.35),
          lerp(k * (1 + 0.05 * t), gg * k, 0.35),
          lerp(k * (1 - 0.10 * t), gb * k, 0.35)
        );
      }
      nrm.needsUpdate = true;
      col.needsUpdate = true;
    }
    this._owned.push(tuftGeo);

    /* Zone size, not zone count.
     *
     * The 50m cell was chosen against `GRASS_HIDE_DISTANCE`: a 50m zone's
     * bounding sphere has a ~35m radius, so "nearest point beyond 86m" is
     * provably "every blade in this zone is past the height fade", which is
     * what makes hiding the zone free. Fixing the COUNT at 8x8 would have
     * stretched the cell to 112m at 900m and destroyed that argument, so the
     * count is derived and the cell is the constant: 18x18 = 324 zones.
     *
     * The per-zone clump budget stays at 720 for the same reason - it is a
     * DENSITY (720 clumps per 2,500 m2, ~0.29/m2), and the whole point of a
     * bigger vale is more of the same meadow, not a thinner one. The bill for
     * that is real and is recorded here rather than discovered later: ~5x the
     * grass instances, and the instance matrices are ~4.4 KB per hundred
     * blades. Every zone is still an independent InstancedMesh that both
     * frustum-culls and distance-hides on its own, so the DRAW cost is
     * unchanged - it is memory and build time that scale, and the first place
     * to look if either bites is this constant.
     */
    /* Clumped, not scattered.
     *
     * Poisson-ish clumps of 5-9 blades at ~1.1m radius are what real turf does
     * and what an even RNG scatter can never do: an evenly seeded field always
     * reads as one stamped decal repeated, because every blade has the same
     * neighbourhood statistics. Clumping also concentrates the coverage, so
     * the mat closes up at three times fewer instances than a flat scatter
     * would need.
     *
     * Placement is collected first and the InstancedMesh sized to the exact
     * count afterwards, because a 6000-instance allocation per 50m cell that
     * only ever fills a fifth of the way is 25MB of dead matrix buffer.
     */
    this._grassGeo = tuftGeo;
    /* Zones are built on demand from here on. See `medieval/GrassResidency.js`
     * for why: 324 zones at the (correct, unchanged) 50 m cell and 720-clump
     * density is 1,594,413 blades and 115.6 MB of instance buffers, of which
     * fewer than fifty zones can contribute a pixel at any instant. */
    this._grass = new GrassResidency({
      zones: MEDIEVAL_LAYOUT.grassZones,
      zoneMetres: MEDIEVAL_LAYOUT.grassZoneMetres,
      half: HALF,
    });
    /* Seeded at the player's spawn, not at the origin: the first frame after a
     * portal transition has to have grass under the lens already, and there is
     * no earlier moment to build it in than this one. */
    const seed = this.playerSpawn;
    for (const key of this._grass.initial(seed.x, seed.z)) {
      this._buildGrassZone(key);
      await this._breathe();
    }

    /* ---- Bushes ----------------------------------------------------- */
    const bushParts = [];
    for (let i = 0; i < 4; i++) {
      const g = new THREE.IcosahedronGeometry(0.62, 1);
      const p = g.attributes.position;
      for (let k = 0; k < p.count; k++) {
        const n = 1 + perlin2(p.getX(k) * 3 + i, p.getZ(k) * 3) * 0.35;
        p.setXYZ(k, p.getX(k) * n, p.getY(k) * n, p.getZ(k) * n);
      }
      g.computeVertexNormals();
      MedievalWorld._uvScale(g, 2.0);
      g.scale(1.2, 0.85, 1.2);
      g.translate((i % 2 ? 0.45 : -0.4), 0.45 + (i > 1 ? 0.35 : 0), (i > 1 ? 0.4 : -0.35));
      const bg2 = normaliseGeo(g, 0xffffff);
      // Ground the bush: undersides dark, crown bright.
      const bp2 = bg2.attributes.position;
      const bc2 = bg2.attributes.color;
      for (let k = 0; k < bp2.count; k++) {
        const occ = clamp01(0.34 + 0.66 * smoothstep(-0.1, 0.95, bp2.getY(k)));
        bc2.setXYZ(k, occ, occ, occ);
      }
      bushParts.push(bg2);
    }
    const bushGeo = mergeGeometries(bushParts, false);
    for (const g of bushParts) g.dispose();
    this._owned.push(bushGeo);
    const bushes = new THREE.InstancedMesh(bushGeo, this._mats.leaf, 420);
    let bp = 0;
    let bg = 0;
    while (bp < 420 && bg++ < 4200) {
      const x = (rnd() - 0.5) * (SIZE - 20);
      const z = (rnd() - 0.5) * (SIZE - 20);
      if (!this._isPlantable(x, z, 0.8)) continue;
      if (this._inHeroClear(x, z, 1.4)) continue;
      // The mask has ONE definition and it is in `Woodland.js`. This line
      // used to spell it out again, which is a second thing to keep in step
      // with a field that now also drives the trees, the thickets and the
      // bracken.
      if (woodMask(x, z) < -0.05 && rnd() > 0.25) continue;
      const sc = 0.7 + rnd() * 0.9;
      _obj.position.set(x, this._height(x, z) - 0.1, z);
      _obj.rotation.set(0, rnd() * TAU, 0);
      _obj.scale.setScalar(sc);
      _obj.updateMatrix();
      bushes.setMatrixAt(bp, _obj.matrix);
      _col.setHSL(0.18 + rnd() * 0.06, 0.11 + rnd() * 0.09, 0.26 + rnd() * 0.17);
      bushes.setColorAt(bp, _col);
      this._contacts.push(x, this._height(x, z), z, 1.15 * sc);
      bp++;
    }
    bushes.count = bp;
    bushes.castShadow = true;
    bushes.receiveShadow = true;
    bushes.instanceMatrix.needsUpdate = true;
    if (bushes.instanceColor) bushes.instanceColor.needsUpdate = true;
    bushes.computeBoundingSphere();
    this.group.add(bushes);
    await this._breathe();

    /* ---- Rocks and outcrops ------------------------------------------ */
    for (let variant = 0; variant < 2; variant++) {
      const g = new THREE.IcosahedronGeometry(1, variant === 0 ? 1 : 2);
      const p = g.attributes.position;
      for (let k = 0; k < p.count; k++) {
        const n = 1 + perlin2(p.getX(k) * 1.8 + variant * 9, p.getZ(k) * 1.8) * 0.42
          + perlin2(p.getX(k) * 5.1, p.getY(k) * 5.1) * 0.14;
        p.setXYZ(k, p.getX(k) * n, p.getY(k) * n * 0.72, p.getZ(k) * n);
      }
      g.computeVertexNormals();
      MedievalWorld._uvScale(g, 0.7);
      normaliseGeo(g, 0xffffff);
      this._owned.push(g);
      const count = variant === 0 ? 300 : 90;
      const mesh = new THREE.InstancedMesh(g, this._mats.rock, count);
      let rp = 0;
      let rg = 0;
      while (rp < count && rg++ < count * 24) {
        const x = (rnd() - 0.5) * (SIZE - 12);
        const z = (rnd() - 0.5) * (SIZE - 12);
        // Outcrops go up to 4m of scale, so 3m of inset is the minimum that
        // keeps one from hanging over the rim.
        if (!this._inPlayfield(x, z, 3)) continue;
        const y = this._height(x, z);
        if (y < WATER_Y - 0.6) continue;
        const slope = this._slope(x, z);
        if (variant === 1 && slope < 0.3) continue;
        if (variant === 1 && this._inHeroClear(x, z, 3)) continue;
        if (this._roadDist(x, z) < 2.2) continue;
        if (rectDist(x - CASTLE.x, z - CASTLE.z, CASTLE.hx - 2, CASTLE.hz - 2) < 0) continue;
        const sc = variant === 0 ? 0.28 + rnd() * 0.55 : 1.4 + rnd() * 2.6;
        _obj.position.set(x, y - sc * 0.3, z);
        _obj.rotation.set(rnd() * 0.5, rnd() * TAU, rnd() * 0.5);
        _obj.scale.set(sc * (0.8 + rnd() * 0.5), sc, sc * (0.8 + rnd() * 0.5));
        _obj.updateMatrix();
        mesh.setMatrixAt(rp, _obj.matrix);
        _col.setHSL(0.09, 0.05 + rnd() * 0.08, 0.42 + rnd() * 0.24);
        mesh.setColorAt(rp, _col);
        if (variant === 1) this._box(x, y + sc * 0.3, z, sc * 0.7, sc * 0.6, sc * 0.7);
        this._contacts.push(x, y, z, sc * 1.15);
        rp++;
      }
      mesh.count = rp;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
    }
    await this._breathe();

    /* ---- Reeds along the water line ---------------------------------- *
     * Same over-scale failure as the grass, and worse for being on the
     * riverbank where the camera stands: a 0.9 x 1.5m card taken to 1.9x wide
     * and 1.6x tall put 4.5m reeds - twice the height of the bridge parapet -
     * across the one framing that should sell the river. 0.34 x 0.85m at
     * 0.8-1.35x lands them at 0.5-1.6m, which is a reed bed. The count more
     * than doubles because small cards need company to read as a stand. */
    const REED_W = 0.34;
    const REED_H = 0.85;
    const reedParts = [];
    for (let i = 0; i < 3; i++) {
      const g = planeGeo(REED_W, REED_H, 0);
      g.translate(0, REED_H * 0.5, 0);
      g.rotateY((i / 3) * Math.PI);
      reedParts.push(normaliseGeo(g, 0xffffff));
    }
    const reedGeo = mergeGeometries(reedParts, false);
    for (const g of reedParts) g.dispose();
    this._owned.push(reedGeo);
    const REED_N = 5200;
    const reeds = new THREE.InstancedMesh(reedGeo, this._mats.reed, REED_N);
    let rp2 = 0;
    let rg2 = 0;
    while (rp2 < REED_N && rg2++ < REED_N * 8) {
      if ((rg2 & 1023) === 0) await this._breathe();
      // Was `* 420`, i.e. +/-210 on a +/-200 playfield: 219 reed clumps stood
      // ten metres past the rim on the distant skirt, where the river channel
      // and the water ribbon both stop. The bank has to end where the terrain
      // that carries it ends, so this derives from HALF and always has.
      const x = (rnd() - 0.5) * 2 * (HALF - 3);
      // Offset from the channel EDGE, not from the centreline: reeds grow in
      // the shallows, and where the shallows are moved with the width.
      const z = riverZ(x) + (rnd() < 0.5 ? -1 : 1) * (riverHalfWidth(x) - 1.3 + rnd() * 6.0);
      if (!this._inPlayfield(x, z, 3)) continue;
      const y = this._height(x, z);
      if (y < WATER_Y - 0.5 || y > WATER_Y + 1.4) continue;
      const sc = 0.8 + rnd() * 0.55;
      _obj.position.set(x, y - 0.08, z);
      _obj.rotation.set(0, rnd() * TAU, 0);
      _obj.scale.set(sc, sc * (0.75 + rnd() * 0.6), sc);
      _obj.updateMatrix();
      reeds.setMatrixAt(rp2, _obj.matrix);
      _col.setHSL(0.16 + rnd() * 0.08, 0.24 + rnd() * 0.18, 0.30 + rnd() * 0.2);
      reeds.setColorAt(rp2, _col);
      rp2++;
    }
    reeds.count = rp2;
    reeds.castShadow = false;
    reeds.receiveShadow = true;
    reeds.instanceMatrix.needsUpdate = true;
    if (reeds.instanceColor) reeds.instanceColor.needsUpdate = true;
    reeds.computeBoundingSphere();
    this.group.add(reeds);

    this._buildContactShadows();
  }

  /**
   * Ground-contact shading for every instanced prop, in one draw call.
   *
   * Screen-space AO at any sane radius cannot resolve the darkening under a
   * half-metre barrel, and instanced props get no baked vertex AO because
   * their geometry is shared. Without it every barrel, bush, rock and tree
   * reads as a decal pasted onto the grass. A soft alpha disc bedded 4cm above
   * the terrain fixes it for the cost of one transparent InstancedMesh.
   */
  _buildContactShadows() {
    const n = this._contacts.length / 4;
    if (!n) return;

    /* Multiply, not alpha-over.
     *
     * The disc used to be a black quad blended over the frame at 0.72 opacity,
     * which paints a fixed grey wherever it lands: it does not get darker in
     * shadow, it does not warm in the key, and on the already-dark side of a
     * building it actually *lifts* the value. Contact occlusion is a
     * multiplier - it removes light that would otherwise arrive - so the sheet
     * is authored as a colour ramp from near-black at the centre to white at
     * the rim and blended multiplicatively, exactly like the wall skirts. It
     * then tracks whatever the ground underneath is doing, cobble or grass,
     * lit or shadowed.
     */
    const S = 128;
    const c = newCanvas(S);
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grd.addColorStop(0, 'rgb(38,32,26)');
    grd.addColorStop(0.30, 'rgb(96,88,76)');
    grd.addColorStop(0.66, 'rgb(206,201,192)');
    grd.addColorStop(1, 'rgb(255,255,255)');
    g.fillStyle = 'rgb(255,255,255)';
    g.fillRect(0, 0, S, S);
    g.fillStyle = grd;
    g.fillRect(0, 0, S, S);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this._owned.push(tex);

    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      blending: THREE.MultiplyBlending,
      // See the note on medieval.skirt - multiply blending requires this or
      // three logs a warning every frame the material is drawn.
      premultipliedAlpha: true,
      transparent: true,
      depthWrite: false,
      fog: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -4,
    });
    mat.name = 'medieval.contact';
    this._mats.contact = mat;
    this._owned.push(mat);

    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    this._owned.push(geo);

    const mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 2;
    for (let i = 0; i < n; i++) {
      const r = this._contacts[i * 4 + 3];
      _obj.position.set(this._contacts[i * 4], this._contacts[i * 4 + 1] + 0.045, this._contacts[i * 4 + 2]);
      _obj.rotation.set(0, (i * 2.399) % TAU, 0);
      _obj.scale.set(r * 2.3, 1, r * 2.3);
      _obj.updateMatrix();
      mesh.setMatrixAt(i, _obj.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
    this._contacts.length = 0;
  }
  /**
   * Queue one additive light-spill card.
   *
   * @param {number} x @param {number} y @param {number} z
   * @param {number} r card diameter in metres
   * @param {number} hex spill colour, pre-multiplied by the intensity wanted
   * @param {number} [yaw] omit for a ground pool, supply for a wall halo
   */
  _addGlow(x, y, z, r, hex, yaw) {
    this._glows.push({ x, y, z, r, hex, yaw: yaw === undefined ? null : yaw });
  }

  /**
   * Light spill, in one draw call.
   *
   * Every practical in the village was a bare PointLight, so an emissive
   * window at 2.0 sat on a daub panel that stayed at absolute zero two
   * centimetres away and read as a decal cut into the wall - and the street
   * had no pooled light on the cobbles at all, just three orange rectangles in
   * a black frame. Solving that with more point lights is not affordable:
   * forward rendering evaluates every light for every fragment and the village
   * already carries twenty.
   *
   * So the falloff is faked where it is actually looked at - a soft additive
   * card on the ground under each doorway and lantern, and a second card on
   * the wall around each lit window. One InstancedMesh, no lighting cost, and
   * it gives the three-value read the street frames were missing: warm key
   * pool, sky fill on upward faces, black only in the deepest doorways.
   */
  _buildGlows() {
    const n = this._glows.length;
    if (!n) return;
    const geo = new THREE.PlaneGeometry(1, 1);
    normaliseGeo(geo, 0xffffff);
    this._owned.push(geo);

    const mat = new THREE.MeshBasicMaterial({
      map: this._tex.spark.map,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      vertexColors: true,
      side: THREE.DoubleSide,
      fog: true,
    });
    mat.name = 'medieval.glow';
    this._mats.glow = mat;
    this._owned.push(mat);

    const mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 3;
    for (let i = 0; i < n; i++) {
      const g = this._glows[i];
      _obj.position.set(g.x, g.y, g.z);
      if (g.yaw === null) _obj.rotation.set(-Math.PI / 2, 0, (i * 2.399) % TAU);
      else _obj.rotation.set(0, g.yaw, 0);
      _obj.scale.set(g.r, g.r, g.r);
      _obj.updateMatrix();
      mesh.setMatrixAt(i, _obj.matrix);
      _col.setHex(g.hex);
      mesh.setColorAt(i, _col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
    this._glows.length = 0;
  }

  /* ---------------------------------------------------------------- */
  /* Atmosphere: hearth smoke, dust motes, birds                       */
  /* ---------------------------------------------------------------- */

  _buildAtmosphere() {
    this._buildGlows();

    /* ---- Cool separation rim ---------------------------------------- *
     * The build had a key, a hemisphere and an ambient and nothing else, so
     * every shadow-side plane carried no directional information whatsoever
     * and the keep resolved as a single flat black shape with five orange
     * dots in it. A second, shadowless directional roughly opposite the sun
     * puts a cool edge on merlons, roof ridges, gable ends and tower returns -
     * the separation that makes 110m of masonry read as mass rather than as a
     * cut-out pasted on the sky.
     *
     * Round 4: it was aimed at (0.62, 0.30, 0.55) - within 20 degrees of the
     * key - so it was adding a little more light to faces that were already
     * lit and nothing at all to the ones that needed it. A separation rim has
     * to come from the *anti-sun* hemisphere or it is just a brighter key. */
    /* Round 5: still not reading. At 0.72 against a 3.70 key it is a 5%
     * contribution - inside the noise of the tonemapper - and at y = 0.20 over
     * a 320-unit throw it was arriving 11 degrees above horizontal, which is
     * high enough to wash broad shadow-side faces evenly instead of catching
     * their edges. A separation rim has to graze: dropped to y = 0.075 (4
     * degrees) and nearly doubled, so a merlon, a roof ridge or a gable end
     * picks up a cool line and the flat face beside it does not. */
    const rim = dirLight(0x8fb4e8, 1.35);
    rim.position.set(-0.82, 0.075, -0.57).normalize().multiplyScalar(320);
    rim.castShadow = false;
    this.group.add(rim);
    this.group.add(rim.target);

    /* ---- Warm ground bounce ----------------------------------------- *
     * The other half of a dusk lighting model: the sun is raking 400m of open
     * pasture and the light coming back up off it is warm, low and broad. It
     * is what keeps eaves, jetty undersides, arch soffits and the batter of a
     * curtain wall from going to a single dead value. Aimed *upward* from just
     * below the horizon on the key side, shadowless and weak. */
    const bounce = dirLight(0xffa04a, 0.60);
    bounce.position.set(0.42, -0.34, 0.20).normalize().multiplyScalar(320);
    bounce.castShadow = false;
    this.group.add(bounce);
    this.group.add(bounce.target);

    const spark = this._tex.spark.map;

    /* ---- Chimney smoke. Every particle's whole life is evaluated in the
     * vertex shader from its seed, so there is zero CPU cost per frame. */
    const stacks = this._smokeOrigins.length / 3;
    if (stacks > 0) {
      const per = 42;
      const n = stacks * per;
      const pos = new Float32Array(n * 3);
      const org = new Float32Array(n * 3);
      const seed = new Float32Array(n * 4);
      const rnd = mulberry32(0x5a0c17);
      for (let s = 0; s < stacks; s++) {
        for (let i = 0; i < per; i++) {
          const k = s * per + i;
          org[k * 3] = pos[k * 3] = this._smokeOrigins[s * 3];
          org[k * 3 + 1] = pos[k * 3 + 1] = this._smokeOrigins[s * 3 + 1];
          org[k * 3 + 2] = pos[k * 3 + 2] = this._smokeOrigins[s * 3 + 2];
          seed[k * 4] = i / per + rnd() * 0.02;
          seed[k * 4 + 1] = 0.042 + rnd() * 0.020;
          seed[k * 4 + 2] = 0.85 + rnd() * 0.5;
          seed[k * 4 + 3] = 0.78 + rnd() * 0.44;
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aOrigin', new THREE.BufferAttribute(org, 3));
      g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
      g.computeBoundingSphere();
      const u = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]);
      u.uTime = this._timeU;
      u.uMap = { value: spark };
      // The far colour was 0xd8c4a8 - near white after tonemapping - and with
      // thirty overlapping sprites per stack at 0.34 alpha and no depth write,
      // every plume saturated into an opaque cream cauliflower standing 16m
      // over the roofline. From the ramparts the whole village skyline was a
      // row of popcorn. Hearth smoke at dusk is a thin grey wisp that only
      // warms where the key catches it.
      u.uNear = { value: new THREE.Color(0x3b352d) };
      u.uFar = { value: new THREE.Color(0x8c8375) };
      const mat = new THREE.ShaderMaterial({
        uniforms: u,
        fog: true,
        transparent: true,
        depthWrite: false,
        vertexShader: `
          #include <common>
          #include <fog_pars_vertex>
          attribute vec3 aOrigin;
          attribute vec4 aSeed;
          uniform float uTime;
          varying float vLife;
          void main() {
            float life = fract(uTime * aSeed.y + aSeed.x);
            vLife = life;
            vec3 p = aOrigin;
            p.y += life * aSeed.z * 11.0;
            /* Wind shear. A plume that rises as a straight column reads as a
             * particle emitter; hearth smoke at dusk leans, stretches and
             * tears downwind, and it has to lean the same way the trees do. */
            p.x += sin(aSeed.x * 41.0 + life * 3.1) * life * 2.4 + life * 2.2 + life * life * 8.0;
            p.z += cos(aSeed.x * 33.0 + life * 2.4) * life * 2.0 + life * life * 4.4;
            vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
            // 1.2m at the stack ramping to ~6m by the top of the plume.
            gl_PointSize = aSeed.w * (1.2 + life * 4.8) * (200.0 / max(0.001, -mvPosition.z));
            gl_Position = projectionMatrix * mvPosition;
            #include <fog_vertex>
          }
        `,
        fragmentShader: `
          #include <common>
          #include <fog_pars_fragment>
          uniform sampler2D uMap;
          uniform vec3 uNear, uFar;
          varying float vLife;
          void main() {
            float a = texture2D(uMap, gl_PointCoord).a;
            // 0.12 was below the visibility floor against a bright peach sky:
            // twenty-eight chimneys were producing literally nothing, which at
            // dusk over a lit village reads as a plague town.
            a *= smoothstep(0.0, 0.08, vLife) * smoothstep(1.0, 0.30, vLife) * 0.21;
            if (a < 0.004) discard;
            gl_FragColor = vec4(mix(uNear, uFar, vLife), a);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
            #include <fog_fragment>
          }
        `,
      });
      const pts = new THREE.Points(g, mat);
      pts.frustumCulled = false;
      pts.renderOrder = 6;
      this.group.add(pts);
      this._owned.push(mat, g);
    }

    /* ---- Dust motes catching the low sun over the village and bailey. */
    {
      const n = 1400;
      const pos = new Float32Array(n * 3);
      const seed = new Float32Array(n * 3);
      const rnd = mulberry32(0xd0057);
      for (let i = 0; i < n; i++) {
        const inCastle = i % 3 === 0;
        const cx = inCastle ? CASTLE.x : MARKET.x;
        const cz = inCastle ? CASTLE.z : MARKET.z;
        pos[i * 3] = cx + (rnd() - 0.5) * 150;
        pos[i * 3 + 1] = (inCastle ? CASTLE.ground : MARKET.y) + rnd() * 22;
        pos[i * 3 + 2] = cz + (rnd() - 0.5) * 150;
        seed[i * 3] = rnd() * TAU;
        seed[i * 3 + 1] = 0.25 + rnd() * 0.7;
        seed[i * 3 + 2] = 0.22 + rnd() * 0.5;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
      g.computeBoundingSphere();
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: this._timeU,
          uMap: { value: spark },
          uColor: { value: new THREE.Color(0xffd7a0) },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: `
          attribute vec3 aSeed;
          uniform float uTime;
          varying float vFade;
          void main() {
            vec3 p = position;
            p.x += sin(uTime * 0.16 * aSeed.y + aSeed.x) * 3.4;
            p.y += sin(uTime * 0.11 + aSeed.x * 1.7) * 1.4 + mod(uTime * 0.14 * aSeed.y, 6.0);
            p.z += cos(uTime * 0.13 * aSeed.y + aSeed.x * 1.3) * 3.0;
            vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
            vFade = smoothstep(160.0, 24.0, -mvPosition.z) * (0.35 + 0.65 * abs(sin(uTime * 0.6 + aSeed.x)));
            gl_PointSize = clamp(aSeed.z * (150.0 / max(0.001, -mvPosition.z)), 0.6, 5.0);
            gl_Position = projectionMatrix * mvPosition;
          }
        `,
        fragmentShader: `
          uniform sampler2D uMap;
          uniform vec3 uColor;
          varying float vFade;
          void main() {
            float a = texture2D(uMap, gl_PointCoord).a * vFade * 0.22;
            if (a < 0.003) discard;
            gl_FragColor = vec4(uColor, a);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }
        `,
      });
      const pts = new THREE.Points(g, mat);
      pts.frustumCulled = false;
      pts.renderOrder = 7;
      this.group.add(pts);
      this._owned.push(mat, g);
    }

    /* ---- Rooks circling the keep. ------------------------------------ */
    {
      const n = 16;
      const verts = [];
      const norms = [];
      const uvs = [];
      const quad = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz) => {
        verts.push(ax, ay, az, bx, by, bz, cx, cy, cz, ax, ay, az, cx, cy, cz, dx, dy, dz);
        for (let i = 0; i < 6; i++) norms.push(0, 1, 0);
        uvs.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
      };
      quad(-0.11, 0, -0.42, 0.11, 0, -0.42, 0.07, 0, 0.5, -0.07, 0, 0.5);
      quad(-0.11, 0, -0.3, -0.11, 0, 0.26, -1.05, 0.02, 0.12, -1.05, 0.02, -0.18);
      quad(0.11, 0, -0.3, 1.05, 0.02, -0.18, 1.05, 0.02, 0.12, 0.11, 0, 0.26);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      normaliseGeo(g, 0xffffff);
      const phase = new Float32Array(n);
      const state = new Float32Array(n * 5);
      const rnd = mulberry32(0xb1249d);
      // A flock at one radius, one altitude and one scale reads as sensor
      // noise on the lens, not as life. Spread the orbit over 3x the range,
      // stagger the altitude band, and give four of them a much larger scale
      // on a tight inner orbit so there is a genuine near/far parallax read.
      for (let i = 0; i < n; i++) {
        const near = i % 4 === 0;
        phase[i] = rnd() * TAU;
        state[i * 5] = rnd() * TAU;
        state[i * 5 + 1] = near ? 9 + rnd() * 9 : 22 + rnd() * 62;
        state[i * 5 + 2] = near ? 16 + rnd() * 12 : 22 + rnd() * 34;
        state[i * 5 + 3] = (0.10 + rnd() * 0.24) * (rnd() < 0.3 ? -1 : 1);
        state[i * 5 + 4] = rnd() * TAU;
      }
      // Per-bird scale, packed alongside so `update()` stays allocation-free.
      this._birdScale = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        this._birdScale[i] = (i % 4 === 0 ? 1.25 : 0.6) + rnd() * 0.5;
      }
      g.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
      const mat = this._mats.bird;
      const timeU = this._timeU;
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = timeU;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uTime;\nattribute float aPhase;')
          .replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
             float wAng = sin(uTime * 7.5 + aPhase) * 0.85;
             float wx = abs(transformed.x);
             if (wx > 0.12) {
               float ext = wx - 0.12;
               transformed.y += ext * sin(wAng);
               transformed.x = sign(transformed.x) * (0.12 + ext * cos(wAng));
             }`
          );
      };
      mat.customProgramCacheKey = () => 'medieval-bird';
      const mesh = new THREE.InstancedMesh(g, mat, n);
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      this.group.add(mesh);
      this._birds = mesh;
      this._birdState = state;
      this._owned.push(g);
    }
  }
  /* ---------------------------------------------------------------- */
  /* Stone circle, portal, inhabitants, minimap                        */
  /* ---------------------------------------------------------------- */

  _buildGateAndSpawns() {
    const B = new GeoBatch();
    const rnd = mulberry32(0xc112c1e);
    const cx = CIRCLE.x;
    const cz = CIRCLE.z;
    const gy = this._height(cx, cz);
    const place = (x, y, z, ry = 0) => {
      _obj.position.set(x, y, z);
      _obj.rotation.set(0, ry, 0);
      _obj.scale.set(1, 1, 1);
      return _obj;
    };

    /* ---- Ruined sarsen circle -------------------------------------- */
    const N = 10;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU;
      const px = cx + Math.cos(a) * CIRCLE.r;
      const pz = cz + Math.sin(a) * CIRCLE.r;
      const y = this._height(px, pz);
      const fallen = i === 3 || i === 7;
      const h = 3.8 + rnd() * 1.6;
      const w = 1.5 + rnd() * 0.6;
      if (fallen) {
        _obj.position.set(px, y + 0.45, pz);
        _obj.rotation.set(Math.PI / 2 - 0.08, -a + rnd() * 0.4, 0.06);
        _obj.scale.set(1, 1, 1);
        B.add('rock', boxGeo(w, h, 0.85, 0.7), _obj, 0xb0a99a);
        this._rbox(px, y + 0.45, pz, w / 2 + 0.3, 0.5, h / 2, -a);
      } else {
        _obj.position.set(px, y + h / 2 - 0.3, pz);
        _obj.rotation.set((rnd() - 0.5) * 0.12, -a, (rnd() - 0.5) * 0.1);
        _obj.scale.set(1, 1, 1);
        B.add('rock', boxGeo(w, h, 0.85, 0.7), _obj, 0xb6afa0);
        this._rbox(px, y + h / 2 - 0.3, pz, w / 2, h / 2, 0.5, -a);
      }
    }
    // Three surviving trilithon lintels.
    for (const i of [0, 4, 8]) {
      const a0 = (i / N) * TAU;
      const a1 = ((i + 1) / N) * TAU;
      const mx = cx + (Math.cos(a0) + Math.cos(a1)) * 0.5 * CIRCLE.r;
      const mz = cz + (Math.sin(a0) + Math.sin(a1)) * 0.5 * CIRCLE.r;
      const y = this._height(mx, mz);
      const span = Math.hypot(
        Math.cos(a1) * CIRCLE.r - Math.cos(a0) * CIRCLE.r,
        Math.sin(a1) * CIRCLE.r - Math.sin(a0) * CIRCLE.r
      );
      B.add('rock', boxGeo(span + 1.4, 0.75, 0.9, 0.7),
        place(mx, y + 4.0, mz, -Math.atan2(
          Math.sin(a1) - Math.sin(a0), Math.cos(a1) - Math.cos(a0))), 0xd0c9ba);
    }
    // Worn earth inside the ring.
    const disc = new THREE.CircleGeometry(CIRCLE.r - 1.2, 28);
    disc.rotateX(-Math.PI / 2);
    const dp = disc.attributes.position;
    const du = disc.attributes.uv;
    for (let i = 0; i < dp.count; i++) {
      dp.setY(i, this._height(dp.getX(i) + cx, dp.getZ(i) + cz) - gy + 0.05);
      du.setXY(i, (dp.getX(i) + cx) * 0.4, (dp.getZ(i) + cz) * 0.4);
    }
    disc.computeVertexNormals();
    B.add('cobble', disc, place(cx, gy, cz), 0xcfc6b0);

    /* ---- The gate itself: alloy staging under a bronze-age ring. ----- */
    const ring = new THREE.TorusGeometry(3.7, 0.22, 10, 40);
    ring.rotateX(Math.PI / 2);
    MedievalWorld._uvScale(ring, 0.5);
    B.add('alloy', ring, place(cx, gy + 0.12, cz), 0xbfd6e4);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * TAU;
      B.add('alloy', boxGeo(0.34, 0.5, 0.34, 1.2),
        place(cx + Math.cos(a) * 3.7, gy + 0.3, cz + Math.sin(a) * 3.7, -a), 0xcadbe8);
      B.add('ember', boxGeo(0.16, 0.1, 0.16, 2.0),
        place(cx + Math.cos(a) * 3.7, gy + 0.58, cz + Math.sin(a) * 3.7, -a), 0x38e6ff);
    }
    for (const s of [-1, 1]) {
      const px = cx + Math.cos(2.36 + s * 1.45) * 3.2;
      const pz = cz + Math.sin(2.36 + s * 1.45) * 3.2;
      _obj.position.set(px, gy + 2.4, pz);
      _obj.rotation.set(0, -Math.atan2(pz - cz, px - cx), s * 0.16);
      _obj.scale.set(1, 1, 1);
      B.add('alloy', boxGeo(0.55, 4.8, 0.9, 0.7), _obj, 0xc4d8e8);
      _obj.position.set(px, gy + 4.6, pz);
      B.add('ember', boxGeo(0.14, 2.4, 0.2, 1.4), _obj, 0x3ce8ff);
      this._rbox(px, gy + 2.4, pz, 0.4, 2.4, 0.55, 0);
    }
    const gateGlow = pointLight(0x38e0ff, 45, 26, 2);
    gateGlow.position.set(cx, gy + 2.6, cz);
    this.group.add(gateGlow);

    B.build(this._mats, this.group, { ao: this._heightFn });

    this.portalSpecs = [
      {
        position: new THREE.Vector3(cx, gy, cz),
        rotationY: Math.PI * 0.78,
        target: 'station',
        label: 'Aether Station',
        accent: 0x36e0ff,
      },
    ];

    this._buildInhabitants();
    this._buildMinimap();
  }

  _buildInhabitants() {
    const at = (x, z, dy = 0) => new THREE.Vector3(x, this._height(x, z) + dy, z);

    this.npcSpawns = [
      {
        position: at(49.5, 22.5),
        type: 'friendly',
        name: 'Bram Tallow',
        persona:
          'Bram Tallow, the village blacksmith of Aldermoor: a broad, soot-streaked man who ' +
          'talks about steel the way poets talk about love, and who charges double for ' +
          'anything decorative. He has shod horses for three lords and buried two of them. ' +
          'Strangers from the sky-gate do not surprise him; he just wants to know what their ' +
          'armour is made of and whether it will take an edge.',
        patrol: [at(49.5, 22.5), at(45, 24), at(48, 18)],
      },
      {
        position: at(21.5, 10.8),
        type: 'friendly',
        name: 'Wilda Sorrel',
        persona:
          'Wilda Sorrel keeps the herb stall on the north side of the market: sharp-eyed, ' +
          'cheerfully morbid, and convinced that half of Aldermoor would be dead without her ' +
          'tinctures. She trades gossip as readily as feverfew, prices things by how much she ' +
          'likes you, and refers to gate-travellers as "the ones who arrive clean".',
        patrol: [at(21.5, 10.8), at(28, 12), at(24, 20)],
      },
      {
        position: at(-19, -55),
        type: 'friendly',
        name: 'Captain Osric Vane',
        persona:
          'Captain Osric Vane commands the gate watch of Aldermoor Keep. Weathered, precise, ' +
          'and permanently unimpressed, he speaks in short military sentences and dislikes ' +
          'anything he cannot post a guard on. He logs every arrival through the sky-gate in a ' +
          'ledger and would very much like the travellers to stop wandering onto his ramparts.',
        patrol: [at(-19, -55), at(-24, -62), at(-19, -51), at(-14, -58)],
      },
      {
        position: at(43, 37.5),
        type: 'friendly',
        name: 'Piety Lark',
        persona:
          'Piety Lark is the resident balladeer at the Gilded Boar: quick-witted, flamboyant, ' +
          'and shameless about improving a story. She is composing an epic about the sky-gate ' +
          'and will happily insert the player into it for the price of a drink. Speaks in ' +
          'rhyme when she thinks she can get away with it.',
        patrol: [at(43, 37.5), at(38, 39), at(46, 40)],
      },
      {
        position: at(-99, -54),
        type: 'friendly',
        name: 'Nell Harrow',
        persona:
          'Nell Harrow runs the keep stables. Barely twenty, blunt as a mallet, and far more ' +
          'comfortable with horses than with people. She knows every path in the vale because ' +
          'she has had to fetch a bolted pony down all of them, and she thinks the gate ' +
          'travellers smell strange to the animals.',
        patrol: [at(-99, -54), at(-99, -64), at(-92, -48)],
      },
      {
        position: at(CIRCLE.x + 7, CIRCLE.z - 4),
        type: 'friendly',
        name: 'Corvin Ash',
        persona:
          'A hooded traveller who lingers at the ruined stone circle and will not say where he ' +
          'is from. Corvin Ash speaks softly, in half-answers, about the sky-gate: he claims ' +
          'the stones were raised to watch it long before anyone built the keep, and that it ' +
          'has opened before. Unsettling, courteous, and clearly waiting for something.',
        patrol: [
          at(CIRCLE.x + 7, CIRCLE.z - 4),
          at(CIRCLE.x - 6, CIRCLE.z - 6),
          at(CIRCLE.x - 2, CIRCLE.z + 8),
        ],
      },
    ];

    /* Six more residents, placed specifically on the composed vantages.
     *
     * Three hero frames contained not one human or animal figure, which is the
     * difference between a settlement and a film set. Silhouetted movement at
     * 30-60m is what sells "inhabited" at hero-shot distance, so these are
     * clustered on the market axis, the wall walk and the approach road rather
     * than spread evenly over 400m of terrain. */

    /* ---- The wall-walk sentries -------------------------------------
     *
     * ── The defect this replaced ──────────────────────────────────────────
     * Both rounds were drawn round a castle 44 m across. The one that got
     * built is 80 m: `CASTLE.hx` is 40, so the curtains stand at x = -112 and
     * x = -32, and Hale's two north-south legs - authored at x = -52 and
     * x = -96, i.e. an enceinte of hx = 22 - ran the length of the bailey
     * 10.6 m up in clear air. Measured on the built castle with the ground
     * follower's own probe (`NPC.GROUND_PROBE_UP` + `_DROP`), 204 of the 227
     * samples along each of those two legs have nothing under them at all.
     * Pell was worse: all three of his waypoints are INSIDE the bailey and all
     * three were authored at wall-top height, so every one of them resolved
     * 11.20 m below where it was written and he did his round on the grass.
     * `_buildFolk` carried the same wrong enceinte - three of its static
     * sentries stood in mid-air over the bailey - and is corrected there.
     *
     * ── Why this is not a circuit ─────────────────────────────────────────
     * A wall walk implies walking the wall, so the obvious repair is to move
     * the two legs out onto the curtains that do exist. That does not work,
     * and the reason is in the collision rather than the plan: every corner
     * tower carries a CLOSED parapet ring (`_ringWall` at WT + 1.2, radius
     * 5.5, 12 overlapping segments) and a solid crenellated crown to match, so
     * the walk is chopped into four runs that do not join. Flood-filled at
     * 0.4 m over the built castle the deck comes out as eight components -
     * four curtain runs of ~1,020 cells and four sealed tower platforms - and
     * no two of them touch. There is no lap to be had here without rebuilding
     * four towers, and the towers are pre-expansion content.
     *
     * So each man gets the wall that does exist, which is the second of the
     * two repairs the brief allows. Both take the SOUTH curtain: it is what
     * Pell's persona says, and it is the face the castle-approach framing
     * actually sees - `_heroEyes` puts lenses at (-40, 55) and (-72, 16),
     * both looking north at this run. Their beats do not overlap, so they
     * never have to pass each other on a 2.4 m deck.
     *
     * Open rounds, deliberately: `NPC.routeAhead` reverses at the end of an
     * open route and wraps a closed one, and wrapping is what would send a
     * sentry from one end of the wall to the other across sixty metres of
     * bailey. Each of them walks his length and walks back, which is what a
     * sentry does. Their spawns sit on the middle waypoint so that
     * `FriendlyNPC._pickWanderTarget` does not see them at the head of the
     * round on the first pick and roll for free roam.
     *
     * The lane is z = -24.4. The walkable band on this deck is bounded by the
     * merlon collider at z = -23.62 and the inner kerb at z = -26.68, and
     * `_rampartDressing` stands its braziers and spear racks along z = -26.05;
     * -24.4 is clear of all three by more than a capsule radius, measured
     * every 0.5 m from x = -104 to x = -40. The run itself is passable from
     * x = -105.6 to x = -38.4 - the corner towers' rings close it at both
     * ends - so the outermost waypoint is -102.
     */
    const WALK = WALL_TOP + 0.2;
    const WALL_WALK_Z = -24.4;
    /** A point on the south curtain's wall walk. */
    const sentry = (x) => new THREE.Vector3(x, WALK, WALL_WALK_Z);
    this.npcSpawns.push(
      {
        position: at(33, 12),
        type: 'friendly',
        name: 'Goodman Alder',
        persona:
          'Alder keeps the market cross swept and considers himself its unpaid warden. ' +
          'Elderly, gossipy, and enormously proud of a village that mostly ignores him. ' +
          'He will tell a stranger the price of everything on every stall, unasked.',
        patrol: [at(33, 12), at(24, 9), at(37, 9), at(34, 20)],
      },
      {
        position: at(28, 24),
        type: 'friendly',
        name: 'Tibb Marrow',
        persona:
          'A carter who hauls fleece between Aldermoor and the keep and complains about ' +
          'the state of the road at every opportunity. Practical, foul-mouthed, and ' +
          'genuinely useful if you want to know what is over the next hill.',
        patrol: [at(28, 24), at(21, 8), at(45, 10), at(38, 26)],
      },
      {
        position: at(47.5, 17.5),
        type: 'friendly',
        name: 'Rook Danby',
        persona:
          "Bram Tallow's apprentice at the smithy: seventeen, permanently scorched, and " +
          'desperate to be taken seriously. Talks far too fast, knows more about the ' +
          'sky-gate than he should, and has theories about all of it.',
        patrol: [at(47.5, 17.5), at(51, 21), at(44, 15)],
      },
      {
        // The western beat of the south curtain, tower ring to mid-wall.
        position: sentry(-87),
        type: 'friendly',
        name: 'Serjeant Hale',
        persona:
          'A wall-walk sentry of the Aldermoor garrison. Bored, cold, and entirely ' +
          'convinced that nothing will ever happen on his watch. Will trade rumours for ' +
          'anything that breaks the monotony.',
        patrol: [sentry(-102), sentry(-87), sentry(-72)],
      },
      {
        // ...and the eastern beat, six metres clear of Hale's turning point.
        position: sentry(-54),
        type: 'friendly',
        name: 'Watchman Pell',
        persona:
          'The other half of the south curtain watch. Says almost nothing, notices ' +
          'everything, and has an unnerving habit of answering a question a full minute ' +
          'after it was asked.',
        patrol: [sentry(-66), sentry(-54), sentry(-42)],
      },
      {
        position: at(11, -6),
        type: 'friendly',
        name: 'Sister Meriet',
        persona:
          'A travelling almoner who walks the castle road between the shrine and the ' +
          'village, dispensing bread and unsolicited moral guidance in equal measure. ' +
          'Unshockable. Has already decided the sky-gate is a test of some kind.',
        patrol: [at(11, -6), at(0, -34), at(-8, -47), at(21, 4), at(34, 15)],
      }
    );

    // Marauders working the outer village, the woods and the far bank.
    const banditRoutes = [
      [[116, -54], [136, -70], [150, -44], [124, -32]],
      [[92, -78], [110, -96], [136, -102], [104, -86]],
      [[62, 148], [40, 164], [16, 152], [44, 138]],
      [[-30, 140], [-56, 152], [-72, 126], [-44, 122]],
      [[-138, 42], [-160, 18], [-142, -8], [-118, 20]],
      // Kept west of the new NW hamlet and the West Parish Church.
      [[-176, -70], [-190, -40], [-178, -10], [-164, -46]],
      [[126, 44], [148, 62], [124, 84], [104, 58]],
      [[-58, 84], [-80, 100], [-98, 74], [-72, 62]],
      [[168, 108], [146, 128], [162, 150], [182, 130]],
      // Shifted south-east so it no longer cuts through the plot at (-16,-116).
      [[24, -112], [2, -136], [-24, -150], [8, -124]],
    ];
    const names = [
      'Hollow Jack', 'Marret the Crow', 'Dunn Pike', 'Sable Ida', 'Wry Tam',
      'Bregg Ashfoot', 'Old Culley', 'Fen Marlow', 'Rook Gant', 'Thessa Bane',
    ];
    banditRoutes.forEach((route, i) => {
      const pts = route.map(([x, z]) => at(x, z));
      this.npcSpawns.push({
        position: pts[0].clone(),
        type: 'hostile',
        name: names[i],
        persona:
          'A marauder of the Aldern woods - one of the broken company that has preyed on the ' +
          'vale since the last levy. Hostile on sight.',
        patrol: pts,
      });
    });

    applyMedievalPopulation(this);
  }

  _buildMinimap() {
    const shapes = [];
    const stone = 'rgba(206,198,178,0.85)';
    const roof = 'rgba(150,110,72,0.9)';

    shapes.push({
      kind: 'rect', x: CASTLE.x, z: CASTLE.z,
      w: (CASTLE.hx + 18) * 2, d: (CASTLE.hz + 18) * 2, rotation: 0,
      fill: 'rgba(84,96,72,0.35)', stroke: 'rgba(180,196,150,0.35)',
    });
    shapes.push({
      kind: 'rect', x: CASTLE.x, z: CASTLE.z, w: CASTLE.hx * 2, d: CASTLE.hz * 2,
      rotation: 0, fill: 'rgba(198,190,170,0.4)', stroke: stone,
    });
    for (const [tx, tz] of [
      [CASTLE.x - CASTLE.hx, CASTLE.z - CASTLE.hz], [CASTLE.x + CASTLE.hx, CASTLE.z - CASTLE.hz],
      [CASTLE.x - CASTLE.hx, CASTLE.z + CASTLE.hz], [CASTLE.x + CASTLE.hx, CASTLE.z + CASTLE.hz],
    ]) {
      shapes.push({ kind: 'circle', x: tx, z: tz, r: 6, fill: stone, stroke: 'rgba(120,112,96,0.9)' });
    }
    shapes.push({
      kind: 'rect', x: CASTLE.x + CASTLE.hx + 0.5, z: CASTLE.z, w: 9, d: 13,
      rotation: 0, fill: stone, stroke: 'rgba(120,112,96,0.9)',
    });
    shapes.push({
      kind: 'rect', x: CASTLE.x - 6, z: CASTLE.z + 2, w: 29, d: 20,
      rotation: 0, fill: 'rgba(226,218,198,0.95)', stroke: 'rgba(110,102,88,0.9)',
    });

    shapes.push({
      kind: 'rect', x: MARKET.x, z: MARKET.z, w: MARKET.hx * 2, d: MARKET.hz * 2,
      rotation: 0, fill: 'rgba(176,158,124,0.55)', stroke: 'rgba(214,200,170,0.7)',
    });

    // Buildings, taken from the collision footprints so they never drift apart.
    for (const f of this._footprints) {
      if (f.hx > 11 || f.hz > 11) continue;
      const w = (f.hx - 1.4) * 2;
      const d = (f.hz - 1.4) * 2;
      if (w < 1.5 || d < 1.5) continue;
      shapes.push({
        kind: 'rect', x: f.x, z: f.z, w, d, rotation: f.r,
        fill: w > 5 ? roof : 'rgba(190,150,90,0.8)',
        stroke: 'rgba(60,44,30,0.8)',
      });
    }
    shapes.push({
      kind: 'rect', x: 66, z: -8, w: 34, d: 13, rotation: 0,
      fill: 'rgba(214,208,194,0.9)', stroke: 'rgba(90,84,74,0.9)',
    });
    shapes.push({ kind: 'circle', x: 51, z: -8, r: 4.5, fill: 'rgba(214,208,194,0.95)', stroke: '#5a544a' });

    // River, roads, bridge, stone circle.
    const river = [];
    for (let x = -HALF; x <= HALF; x += 8) river.push([x, riverZ(x)]);
    shapes.push({ kind: 'path', points: river, stroke: 'rgba(74,132,168,0.85)', width: 19, closed: false });
    for (const road of this._roadPaths) {
      // Village lanes are drawn fainter so the arterial roads still read as
      // the primary routes at a glance.
      const lane = road.minimap === false;
      shapes.push({
        kind: 'path',
        points: lane ? road.pts : road.pts.filter((_, i) => i % 2 === 0),
        stroke: lane ? 'rgba(198,180,146,0.42)' : 'rgba(206,186,148,0.7)',
        width: road.width,
        closed: false,
      });
    }
    shapes.push({
      kind: 'rect', x: BRIDGE_X, z: riverZ(BRIDGE_X), w: 7, d: 27,
      rotation: 0, fill: stone, stroke: 'rgba(110,102,88,0.9)',
    });
    shapes.push({
      kind: 'circle', x: CIRCLE.x, z: CIRCLE.z, r: CIRCLE.r + 1,
      fill: 'rgba(54,224,255,0.14)', stroke: 'rgba(54,224,255,0.75)',
    });
    shapes.push({ kind: 'circle', x: -13, z: riverZ(-13) - 11.5, r: 6, fill: roof, stroke: '#3a2c1e' });
    // Outlying landmarks: the two things worth walking to.
    shapes.push({ kind: 'circle', x: -88, z: -150, r: 5, fill: stone, stroke: 'rgba(120,112,96,0.9)' });
    shapes.push({ kind: 'circle', x: 160, z: -20, r: 4.5, fill: 'rgba(170,162,146,0.7)', stroke: 'rgba(110,102,88,0.9)' });

    this.minimapShapes = shapes;
  }

  /* ---------------------------------------------------------------- */
  /* Per-frame                                                         */
  /* ---------------------------------------------------------------- */

  /** @param {number} dt @param {number} elapsed */
  update(dt, elapsed) {
    this._timeU.value = elapsed;

    /* Foliage distance LOD. The world manager only calls `update` on the
     * active world, so this is already a no-op everywhere else; it is also a
     * no-op before `_buildNature` has registered anything. */
    this._lod.update(this.engine.camera);
    /* Grass residency. Driven off the CAMERA rather than off the player body:
     * what has to have grass under it is whatever the lens can see, and in a
     * third-person or free-look frame those are metres apart. */
    this.engine.camera.getWorldPosition(_v1);
    this._population?.update(_v1.x, _v1.z, dt);
    this._tickGrass(_v1.x, _v1.z);

    // Foliage translucency shades in view space, so the sun has to follow the
    // camera basis. One transform, no allocation.
    this._sunViewU.value
      .copy(this.environment.sunDirection)
      .transformDirection(this.engine.camera.matrixWorldInverse);

    // The sky dome rides with the camera so the gradient never parallaxes.
    if (this._skyDome) this._skyDome.position.copy(this.engine.camera.position);

    if (this._wheel) this._wheel.rotation.x -= dt * 0.55;
    if (this._sails) this._sails.rotation.z -= dt * 0.32;

    const birds = this._birds;
    if (birds) {
      const s = this._birdState;
      const kx = CASTLE.x - 6;
      const kz = CASTLE.z + 2;
      for (let i = 0; i < birds.count; i++) {
        const o = i * 5;
        s[o] += dt * s[o + 3];
        const a = s[o];
        const r = s[o + 1];
        const x = kx + Math.cos(a) * r;
        const z = kz + Math.sin(a) * r * 0.82;
        const y = CASTLE.ground + s[o + 2] + Math.sin(elapsed * 0.6 + s[o + 4]) * 1.8;
        _obj.position.set(x, y, z);
        // Face along the tangent and bank into the turn.
        _obj.rotation.set(0, -a - Math.PI / 2 * Math.sign(s[o + 3]), s[o + 3] > 0 ? -0.42 : 0.42);
        _obj.scale.setScalar(this._birdScale ? this._birdScale[i] : 1);
        _obj.updateMatrix();
        birds.setMatrixAt(i, _obj.matrix);
      }
      birds.instanceMatrix.needsUpdate = true;
    }
  }

  dispose() {
    /* Resident grass first, and through the same path the frontier uses. The
     * base class disposes GEOMETRY as it walks the group, which for a grass
     * zone is the shared tuft - the per-zone instanceMatrix and instanceColor
     * are hung off the InstancedMesh itself and only `mesh.dispose()` releases
     * them. At up to 58 resident zones that is ~20 MB that would otherwise
     * survive every world unload. */
    if (this._grass) {
      for (const key of [...this._grass.resident.keys()]) this._freeGrassZone(key);
    }
    /* Before the geometries go: put every swapped mesh back on its hi
     * geometry, so nothing is left holding a reference to a disposed one. */
    this._lod.clear();
    for (const o of this._owned) {
      if (o && typeof o.dispose === 'function') o.dispose();
    }
    this._owned.length = 0;
    this._tex = {};
    this._mats = {};
    this._grass = null;
    this._grassGeo = null;
    this._skyDome = null;
    this._wheel = null;
    this._sails = null;
    this._birds = null;
    this._birdScale = null;
    this.environment.envMap = null;
    super.dispose();
  }
}
