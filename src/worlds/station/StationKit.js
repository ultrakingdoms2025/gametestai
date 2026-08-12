import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Shared vocabulary for the Aether Nexus Station and everything bolted onto it.
 *
 * This file holds the pieces the station's own builders and the outer-zone
 * builders both need: the layout constants that keep the map coherent, the
 * deterministic noise the textures are painted from, the UV helpers that give
 * every primitive constant texel density, and `GeoBatch`, which is what lets a
 * district of forty buildings cost a handful of draw calls.
 *
 * It exists because the station stopped being one room. Once the ring grew four
 * outer zones, each big enough to be its own world, a single 9,000-line world
 * file was no longer the right shape - but the zones still have to be built out
 * of exactly the same parts as the hub, or the seams show. Moving the parts here
 * rather than copying them is the whole point: there is one `GeoBatch`, one
 * `boxGeo`, one definition of where avenue 120 runs.
 */

/* ------------------------------------------------------------------ */
/* Scratch - reused every call, never allocated in a hot path          */
/* ------------------------------------------------------------------ */

const _dummy = new THREE.Object3D();
const _v1 = new THREE.Vector3();
const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();
const _mat4 = new THREE.Matrix4();
const _scl = new THREE.Vector3(1, 1, 1);

export const DEG = Math.PI / 180;

/* ------------------------------------------------------------------ */
/* Layout - every builder reads these so the map stays coherent        */
/* ------------------------------------------------------------------ */

export const DECK_R = 200;      // walkable hub deck radius
export const HULL_R = 202;      // hub structural hull radius
export const WALL_H = 48;       // hub window / hull wall height
export const CEIL_Y = 62;       // hub overhead deck plate
export const PLAZA_R = 40;
export const ROAD_W = 18;
export const LOOP_R = 72;       // elevated walkway loop radius
export const LOOP_Y = 10;
export const PORTAL_R = 54;     // distance of the portal daises from the plaza centre
export const OCULUS_R = 34;     // glazed opening in the overhead plate, over the plaza
export const WINDOW_HALF = 55;  // hub window sector half-angle, centred on +X

/* ------------------------------------------------------------------ */
/* The elevated walkway loop                                           */
/* ------------------------------------------------------------------ */

/**
 * The loop's own numbers, and the two derivations that were previously guessed.
 *
 * `_buildWalkwayLoop` carried these inline, and the one that mattered most -
 * where a stair flight stops climbing - was `LOOP_R`, the loop's CENTRELINE.
 * The deck is `WIDTH` across, so the last half-width of every flight ran
 * underneath the walkway it was climbing to, with 1.66 m of headroom falling to
 * 0.16 m: no flight ever reached the promenade. The arrival radius is derived
 * here, beside the width it is derived FROM, so the two cannot disagree again.
 */
export const WALKWAY = {
  /** Deck width, centred on LOOP_R. */
  WIDTH: 6,
  /** Drawn grate slab: thickness, and its centre relative to LOOP_Y. */
  GRATE_T: 0.45,
  GRATE_DY: -0.22,
  /** Railings stand this far in from each deck edge. */
  RAIL_INSET: 0.15,
  /** Bearings of the four radial stair flights, in degrees. */
  STAIR_DEG: [30, 150, 210, 330],
  /** Foot of a flight, on the open deck. */
  STAIR_R_OUTER: 88,
  /** Clear width of a flight. */
  STAIR_W: 4.6,
  /** Half the opening cut in the outer railing at each flight: clears the
   *  4.6 m flight and its stringer rails at +-2.5 with a hand's breadth. */
  STAIR_GAP_HALF: 2.7,
};

/** Top face of the drawn grate - the surface anything meeting the loop meets. */
export const WALKWAY_DECK_TOP = LOOP_Y + WALKWAY.GRATE_DY + WALKWAY.GRATE_T / 2;

/** Where a flight arrives: the deck's OUTER edge, not its centreline. */
export const WALKWAY_STAIR_R_INNER = LOOP_R + WALKWAY.WIDTH / 2;

/**
 * One flight, fully determined by the constants above.
 *
 * `rampSeat` is the Y of the `_ramp` proxy's centre. That proxy is 0.5 m thick
 * and pitched, so its centre has to sit `0.25 / cos(pitch)` below the walking
 * line for its top face to lie ON the line - the same relationship
 * `escalatorDeckDrop` pins for the escalators. It used to be a flat 0.24, which
 * left the collision surface 0.051 m above the treads drawn on it.
 */
export function walkwayStairFlight() {
  const rOuter = WALKWAY.STAIR_R_OUTER;
  const rInner = WALKWAY_STAIR_R_INNER;
  const run = rOuter - rInner;
  const rise = WALKWAY_DECK_TOP;
  const pitch = Math.atan2(rise, run);
  return { rOuter, rInner, run, rise, pitch, rampSeat: rise / 2 - 0.25 / Math.cos(pitch) };
}

/**
 * The stretches of one railing piece that survive the four stair openings.
 *
 * Same shape as the ceiling's `chordRuns`: a run is an interval along the
 * piece's own long axis, and cutting it returns fewer, shorter intervals rather
 * than deciding whether to draw the whole piece at all. A segment is 12.6 m of
 * arc and an opening is 5.4 m, so "skip the segment" would leave a hole two and
 * a half times the width of the stair standing in it.
 *
 * `GeoBatch.at` maps local +X onto (-sin th, cos th) - the +theta tangent - and
 * the piece is a straight chord, so a flight at bearing `sdeg` sits exactly
 * `rr * dtheta` along it from its centre.
 *
 * @param {number} th     bearing of this piece's centre, radians
 * @param {number} rr     radius the piece is drawn at
 * @param {number} chord  its full length
 * @param {boolean} cut   false for the inner railing, which is never cut: it is
 *                        the plaza-side edge of a walkway 10 m up, nothing
 *                        crosses it, and a gap in it is a fall, not a door
 * @returns {Array<[number, number]>} surviving [from, to] offsets from centre
 */
export function walkwayRailRuns(th, rr, chord, cut) {
  let runs = [[-chord / 2, chord / 2]];
  if (!cut) return runs;
  for (const sdeg of WALKWAY.STAIR_DEG) {
    let d = sdeg * DEG - th;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const a = rr * d - WALKWAY.STAIR_GAP_HALF;
    const b = rr * d + WALKWAY.STAIR_GAP_HALF;
    const next = [];
    for (const [s, e] of runs) {
      if (b <= s || a >= e) { next.push([s, e]); continue; }
      if (a - s > 0.05) next.push([s, a]);
      if (e - b > 0.05) next.push([b, e]);
    }
    runs = next;
  }
  return runs;
}

/**
 * Walking surface of a gateway dais - where the approach steps arrive, where
 * the ceremonial arch stands, and where a portal's own plinth starts.
 */
export const GATEWAY_DECK_Y = 2.4;

/**
 * Offsets of the backdrop pylons from a gateway's centre, along and across its
 * axis. Chosen so a 2.6 m pylon lands wholly inside the 11 m dais.
 */
export const PYLON_OFF = { a: 8.1, b: 3.8 };

/* ------------------------------------------------------------------ */
/* The outer ring - four zones on the ends of four avenues             */
/* ------------------------------------------------------------------ */

/**
 * Length of a connecting passageway, hull face to zone rim.
 *
 * Long enough that a zone is somewhere you *travel to* rather than a room off
 * the plaza, short enough that the walk is not the content. At 96 m a jog takes
 * about twenty seconds and a hoverboard about six, and the tunnel has room for
 * the airlock rings, the two service bays and the travelator run that make it
 * worth walking rather than a loading corridor.
 */
export const LINK_LEN = 96;

/**
 * Radius of an outer zone's deck.
 *
 * Deliberately equal to `DECK_R`: each zone is the same *area* as the original
 * station, which is what makes the finished map five times the size it was.
 */
export const ZONE_R = 200;

/** Distance from the world origin to an outer zone's centre. */
export const ZONE_CENTRE_R = HULL_R + LINK_LEN + ZONE_R;   // 498

/**
 * Which avenue carries which zone.
 *
 * Avenues 0 and 60 are left alone. Avenue 0 is the axis of the great window and
 * the hero shot of the whole game; punching a corridor down it would put a
 * tunnel mouth through the glass. Avenue 60 terminates in Hangar Bay 4, which is
 * already a destination.
 *
 * The four that are extended each continue what their district was already
 * about, so the corridor reads as the district getting longer rather than as a
 * door to somewhere unrelated:
 *
 *   120 habitat        -> crew quarters, the hab stacks continued
 *   180 control tower  -> the crew athletics deck, an amenity off the admin arc
 *   240 cargo yard     -> the expansion site, plant and steel off the freight arc
 *   300 residential    -> the galley, where the people in those flats eat
 *
 * `accent` is the district emissive family the hub already uses for that
 * bearing, so the wayfinding colour a player followed out of the plaza is still
 * the colour they arrive under.
 */
export const ZONES = [
  {
    id: 'habitation',
    signCell: 28,
    deg: 120,
    label: 'HAB RING C',
    sub: 'CREW QUARTERS',
    accent: 'emCyan',
    accentHex: 0x8fe6c8,
    linkName: 'Hab Transit',
  },
  {
    id: 'gym',
    signCell: 29,
    deg: 180,
    label: 'DECK 9 ATHLETICS',
    sub: 'CREW CONDITIONING',
    accent: 'emMagenta',
    accentHex: 0xc9b0ff,
    linkName: 'Athletics Link',
  },
  {
    id: 'construction',
    signCell: 30,
    deg: 240,
    label: 'RING 8 EXPANSION',
    sub: 'HARD HAT AREA',
    accent: 'emSodium',
    accentHex: 0xff9d6a,
    linkName: 'Works Access',
  },
  {
    id: 'canteen',
    signCell: 31,
    deg: 300,
    label: 'THE LONG GALLEY',
    sub: 'MESS + PROVISIONS',
    accent: 'emAmber',
    accentHex: 0xffc98a,
    linkName: 'Galley Concourse',
  },
];

/** Outer radius of the great dome's perimeter wall. */
export const DOME_R = 720;
/** Height of the vertical glazed section before the dome roof springs. */
export const DOME_WALL_H = 70;
/** Height of the dome roof at the world origin. */
export const DOME_APEX = 170;

/**
 * The dome roof is a spherical cap through (DOME_R, DOME_WALL_H) and
 * (0, DOME_APEX). Solving for a sphere centred on the world axis at `y = c`:
 *
 *   R^2 = DOME_R^2 + (DOME_WALL_H - c)^2 = (DOME_APEX - c)^2
 *
 * which gives an enormous radius and a very shallow cap - about 100 m of rise
 * over 720 m of span. That is what a pressurised dome this wide actually looks
 * like, and it costs a couple of thousand triangles instead of a hemisphere's
 * hundred thousand.
 */
export const DOME_CENTRE_Y =
  (DOME_APEX * DOME_APEX - DOME_WALL_H * DOME_WALL_H - DOME_R * DOME_R) /
  (2 * (DOME_APEX - DOME_WALL_H));
export const DOME_SPHERE_R = DOME_APEX - DOME_CENTRE_Y;

/** Height of the dome roof directly above a point `r` from the world axis. */
export function domeHeightAt(r) {
  const k = DOME_SPHERE_R * DOME_SPHERE_R - r * r;
  if (k <= 0) return DOME_WALL_H;
  return DOME_CENTRE_Y + Math.sqrt(k);
}

/**
 * Radius of everything a player can reach, used for bounds, collision extraction
 * and the occupancy grid. The dome wall plus a little slack for its buttressing.
 */
export const WORLD_R = DOME_R + 24;

/* ------------------------------------------------------------------ */
/* Collision tuning                                                    */
/* ------------------------------------------------------------------ */

/**
 * Ceiling for geometry-derived collision.
 *
 * On the original ring the highest surface a player could stand on was 48.5 m
 * and 52 cleared it. The outer zones raised that: the hab stacks reach 46 m, the
 * expansion site's scaffold decks 52, and the gantry crane's walkway 58. This is
 * the highest standable surface anywhere on the finished map plus a metre, and
 * still below the dome roof and the canopy rigging, which nothing reaches.
 */
export const COLLIDE_CEILING = 62;

/**
 * Triangles per derived collision chunk. Measured across 8,192 / 4,096 / 2,048
 * chunk splits of the same soup: finer chunks make the capsule solver cheaper
 * and the raycaster dearer, and this is where the two curves cross.
 */
export const CHUNK_TRIS = 32;

/** Triangles per planting proxy box. See `_solidifyPlanting`. */
export const PLANTING_TRIS = 64;

/**
 * Largest a planting proxy box may be in any direction.
 *
 * `PLANTING_TRIS` alone was a size budget in disguise, and it stopped being one
 * the moment planting existed anywhere but the hub. The chunker splits on
 * triangle COUNT, so sixty scattered shrubs strung across a zone are one chunk
 * exactly as much as sixty triangles of one hedge are - and each chunk becomes a
 * single box sized to its own bounds. Measured on the finished map the moment
 * the outer ring started contributing: twelve boxes over 20 m and a worst case
 * of 300 m, one of which was a solid slab 250 by 301 m lying across the
 * habitation link at chest height. It sealed the corridor, and with it a fifth
 * of the walkable map. Nothing about that box was visible; it was a shrub.
 *
 * So the size budget is now stated rather than implied. 4 m is a little larger
 * than a real foliage lobe, which is all a proxy is ever meant to hug, and
 * narrower than the narrowest circulation route on the map - the hab arcade's
 * 5.4 m spokes - so a proxy can no longer span anything a player walks down.
 * Measured over the whole map's planting: 1,024 boxes unbounded against 1,439
 * at 4 m, and the falsely-solid volume falls from a slab the size of a district
 * to 3,803 m3 total. Below 4 the volume curve is flat (3,615 m3 at 3 m for
 * another 219 boxes), so this is the knee.
 */
export const PLANTING_SPAN = 4;

/** Cell size of the deck-occupancy grid used to keep scattered props clear. */
export const OCC_CELL = 1.5;

/**
 * Key a world position into the occupancy grid.
 *
 * The original packed a +/-512 cell index into 11 bits, which covered the 200 m
 * ring with room to spare and overflows silently at 768 m - well inside the
 * finished map, where a prop at the far rim of the galley would have aliased
 * onto a cell over the plaza. 13 bits and a +4096 bias covers +/-6 km.
 */
export const OCC_BIAS = 4096;
export const OCC_SHIFT = 13;
export function occKeyOf(x, z) {
  return ((Math.floor(x / OCC_CELL) + OCC_BIAS) << OCC_SHIFT) | (Math.floor(z / OCC_CELL) + OCC_BIAS);
}
export function occCellKey(gx, gz) {
  return ((gx + OCC_BIAS) << OCC_SHIFT) | (gz + OCC_BIAS);
}

/**
 * Material keys that never take part in collision: hoses and cable runs lying
 * across the deck, floor films, decals and sign faces. Every `em*` emissive is
 * excluded by prefix in `_collisionSoup`.
 *
 * Planting is deliberately NOT on this list - it is hedge and shrub mass at
 * chest height, which you walk into. It gets proxies rather than triangles.
 */
export const NON_SOLID_KEYS = new Set([
  'rubber',
  'wet', 'decals', 'decal', 'polish',
  'signs',
]);

/** Material keys collided as coarse boxes instead of triangles. */
export const PROXY_KEYS = new Set(['foliage', 'foliagePale', 'foliageCard']);

/* The hero anchor. The near-field dressing pass is composed against this exact
 * position and heading. */
export const SPAWN_X = -34, SPAWN_Z = 2;
export const SPAWN_YAW = -Math.PI / 2;   // faces +X, down the plaza axis

/* Signage atlas dimensions. The `SIGNS` copy table lives with the painter.
 *
 * 9 rows, not 7. The atlas was exactly full - 28 cells for 28 signs, every one
 * reserved by role so no two signs in a cluster can carry the same copy - and
 * the outer ring needs eight more: a board for each zone, the galley's stall
 * fascia, the order-point placard, and the two safety notices the gym and the
 * building site are legally the sort of places that would have. There was no
 * cell to borrow, so the sheet grows.
 *
 * The 768 x 384 cell is deliberately NOT reduced to pay for them. That size is
 * itself a fix - see the note beside the canvas allocation in StationWorld's
 * `_buildTextures` - and shrinking the cell to keep the sheet the same number
 * of pixels would undo the one thing this texture exists to do. One more row
 * (the tenth, for the maze gateway arch) costs about 4.5 MB. A sign nobody can
 * read costs more. */
export const SIGN_COLS = 4;
export const SIGN_ROWS = 10;

/* ------------------------------------------------------------------ */
/* Deterministic noise + rng                                           */
/* ------------------------------------------------------------------ */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashi(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Tileable value noise on an integer lattice of `period` cells. */
export function tnoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const m = (n) => ((n % period) + period) % period;
  const a = hashi(m(xi), m(yi), seed);
  const b = hashi(m(xi + 1), m(yi), seed);
  const c = hashi(m(xi), m(yi + 1), seed);
  const d = hashi(m(xi + 1), m(yi + 1), seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Tileable fbm; `period` is in lattice cells at the base octave. */
export function tfbm(x, y, period, seed, octaves = 4) {
  let sum = 0, amp = 0.5, f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += tnoise(x * f, y * f, period * f, seed + i * 17) * amp;
    f *= 2;
    amp *= 0.5;
  }
  return sum;
}

/* ------------------------------------------------------------------ */
/* UV + geometry helpers                                               */
/* ------------------------------------------------------------------ */

/**
 * Rescale a single-segment BoxGeometry's UVs so texel density is constant in
 * world space regardless of the box dimensions. Face order in BoxGeometry is
 * px, nx, py, ny, pz, nz - four vertices each.
 */
const _BOX_SU = [0, 0, 0, 0, 0, 0];
const _BOX_SV = [0, 0, 0, 0, 0, 0];
export function boxUV(geo, w, h, d, tile) {
  const uv = geo.attributes.uv;
  if (!uv || uv.count !== 24) return geo;
  _BOX_SU[0] = _BOX_SU[1] = d; _BOX_SU[2] = _BOX_SU[3] = w; _BOX_SU[4] = _BOX_SU[5] = w;
  _BOX_SV[0] = _BOX_SV[1] = h; _BOX_SV[2] = _BOX_SV[3] = d; _BOX_SV[4] = _BOX_SV[5] = h;
  for (let f = 0; f < 6; f++) {
    const su = _BOX_SU[f] / tile;
    const sv = _BOX_SV[f] / tile;
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, uv.getX(k) * su, uv.getY(k) * sv);
    }
  }
  uv.needsUpdate = true;
  return geo;
}

export function uvScale(geo, su, sv) {
  const uv = geo.attributes.uv;
  if (!uv) return geo;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  uv.needsUpdate = true;
  return geo;
}

/**
 * Constant-texel-density UVs for a CylinderGeometry.
 *
 * `uvScale(cyl, 20, 3)` is a trap: the side wants circumference/height, the
 * caps want diameter on *both* axes, and applying one pair to all of them
 * stretches the cap into 1 x 7 m rectangles.
 *
 * CylinderGeometry emits the side first ((radial+1) * (height+1) vertices),
 * then the top cap, then the bottom cap, so the split is a simple index test.
 */
export function cylUV(geo, rTop, rBottom, height, radialSegs, tile, heightSegs = 1) {
  const uv = geo.attributes.uv;
  if (!uv) return geo;
  const rAvg = (rTop + rBottom) * 0.5;
  const sideCount = (radialSegs + 1) * (heightSegs + 1);
  const su = (Math.PI * 2 * rAvg) / tile;
  const sv = height / tile;
  const sc = (2 * rAvg) / tile;
  for (let i = 0; i < uv.count; i++) {
    if (i < sideCount) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
    // Caps are scaled about their own centre so the plate grid stays concentric.
    else uv.setXY(i, (uv.getX(i) - 0.5) * sc + 0.5, (uv.getY(i) - 0.5) * sc + 0.5);
  }
  uv.needsUpdate = true;
  return geo;
}

/** CylinderGeometry with world-correct texel density in one call. */
export function cylGeo(rTop, rBottom, height, radialSegs, tile, openEnded = false) {
  const g = new THREE.CylinderGeometry(rTop, rBottom, height, radialSegs, 1, openEnded);
  return cylUV(g, rTop, rBottom, height, radialSegs, tile ?? 2);
}

/** Remap a quad's UVs onto one cell of a cols x rows atlas. */
export function atlasUV(geo, col, row, cols, rows) {
  const uv = geo.attributes.uv;
  const iu = 1 / cols, iv = 1 / rows;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, col * iu + uv.getX(i) * iu, 1 - (row + 1) * iv + uv.getY(i) * iv);
  }
  uv.needsUpdate = true;
  return geo;
}

/** Remap a quad onto one cell of the signage atlas. */
export function signUV(geo, cell) {
  const n = SIGN_COLS * SIGN_ROWS;
  const c = ((cell % n) + n) % n;
  return atlasUV(geo, c % SIGN_COLS, Math.floor(c / SIGN_COLS), SIGN_COLS, SIGN_ROWS);
}

/** A textured box, UV-corrected, ready to be pushed into a batch. */
export function boxGeo(w, h, d, tile) {
  return boxUV(new THREE.BoxGeometry(w, h, d), w, h, d, tile ?? 2);
}

/** Build an InstancedMesh from [x,y,z,rx,ry,rz,sx,sy,sz] tuples. */
export function instanced(geo, mat, entries, opts = {}) {
  // A zero-count InstancedMesh is legal but pointless and breaks setColorAt.
  if (!entries.length) return new THREE.Object3D();
  const im = new THREE.InstancedMesh(geo, mat, entries.length);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    _dummy.position.set(e[0], e[1], e[2]);
    _dummy.rotation.set(e[3] || 0, e[4] || 0, e[5] || 0);
    _dummy.scale.set(e[6] ?? 1, e[7] ?? 1, e[8] ?? 1);
    _dummy.updateMatrix();
    im.setMatrixAt(i, _dummy.matrix);
  }
  im.instanceMatrix.needsUpdate = true;
  im.castShadow = opts.cast ?? true;
  im.receiveShadow = opts.recv ?? true;
  /* Cull against the instances, not against the prototype.
   *
   * This used to be `frustumCulled = false`, and the reason given was that
   * instances span the whole map so culling could only ever fail. That was true
   * of a 400 m ring where every scatter covered the whole deck. It is very
   * badly untrue of a 1,440 m map with four zones half a kilometre apart: every
   * chair in the galley was submitted while the player stood in the gym.
   *
   * `InstancedMesh` carries its own `boundingSphere`, computed from the
   * instance matrices, and `Frustum.intersectsObject` prefers it over the
   * geometry's. So a zone-local scatter now gets a zone-sized sphere and is
   * rejected from every other deck, while a genuinely map-wide scatter gets a
   * map-sized sphere and behaves exactly as it did.
   *
   * Computed here, after the matrices are written. Meshes whose instances are
   * animated afterwards - the plaza crowd, the escalator treads - move by
   * centimetres within a sphere sized in tens of metres, so the sphere stays
   * valid without being recomputed. Anything that moves an instance further
   * than that must pass `cull: false`.
   */
  im.computeBoundingSphere();
  im.frustumCulled = opts.cull ?? true;
  return im;
}

/**
 * Collects geometry per material during generation and merges each bucket into
 * a single mesh. A district of forty buildings collapses to ~6 draw calls.
 */
export class GeoBatch {
  constructor() {
    /** @type {Map<string, THREE.BufferGeometry[]>} */
    this.buckets = new Map();
  }

  /** @param {string} key material key @param {THREE.BufferGeometry} geo owned by the batch */
  add(key, geo, matrix) {
    if (matrix) geo.applyMatrix4(matrix);
    // mergeGeometries refuses to mix indexed and non-indexed sources, and the
    // polyhedra (Octahedron/Icosahedron) arrive unindexed. Normalise here so
    // callers never have to think about it.
    if (!geo.getIndex()) {
      const n = geo.getAttribute('position').count;
      const idx = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
      for (let i = 0; i < n; i++) idx[i] = i;
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
    }
    let list = this.buckets.get(key);
    if (!list) this.buckets.set(key, (list = []));
    list.push(geo);
    return geo;
  }

  /**
   * Place a part described in a building's local frame. Buildings are authored
   * around their own origin and then dropped onto the map, so every builder
   * works in local millimetre-free coordinates.
   */
  localAt(key, geo, ox, oy, oz, yaw, lx, ly, lz, ry2 = 0, rx = 0, rz = 0) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return this.at(key, geo, ox + lx * c + lz * s, oy + ly, oz - lx * s + lz * c, yaw + ry2, rx, rz);
  }

  /** Place a geometry with position + Y rotation, the common building case. */
  at(key, geo, x, y, z, ry = 0, rx = 0, rz = 0) {
    _euler.set(rx, ry, rz, 'YXZ');
    _quat.setFromEuler(_euler);
    _mat4.compose(_v1.set(x, y, z), _quat, _scl.set(1, 1, 1));
    return this.add(key, geo, _mat4);
  }

  /** Merge every bucket, add the meshes to `parent`, and reset. */
  flush(parent, materials, name, opts = {}) {
    const out = [];
    for (const [key, list] of this.buckets) {
      if (!list.length) continue;
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (!merged) {
        console.warn(`[StationWorld] merge failed for bucket "${key}" in ${name}`);
        continue;
      }
      if (list.length > 1) for (const g of list) g.dispose();
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, materials[key]);
      mesh.name = `${name}:${key}`;
      const o = opts[key] ?? opts;
      mesh.castShadow = o.cast ?? true;
      mesh.receiveShadow = o.recv ?? true;
      parent.add(mesh);
      out.push(mesh);
    }
    this.buckets.clear();
    return out;
  }
}

/**
 * Split a world-space triangle soup into small, spatially compact chunks.
 *
 * Each chunk becomes one `mesh` collider, and a mesh collider has no internal
 * tree - a query that reaches it pays for all of it. So the split is by
 * triangle *count*, recursively at the median of whichever axis the chunk's
 * centroids are most spread across, until every leaf holds `maxTris`. A fixed
 * spatial grid cannot do this: station geometry is uneven enough that the same
 * cell size gives 20,000 triangles over the plaza and 40 over the cargo yard,
 * and it is the 20,000 that decides the frame time.
 *
 * Median splitting on the longest axis also keeps chunks roughly cubic, which
 * matters twice over: their AABBs are what both the capsule solver and the
 * raycaster reject against, and the broadphase indexes them by XZ footprint.
 *
 * @param {Float32Array} soup 9 floats per triangle, world space
 * @param {number} maxTris leaf size
 * @returns {Float32Array[]} one buffer per chunk
 */
export function chunkTriangles(soup, maxTris) {
  const count = soup.length / 9;
  if (count === 0) return [];

  const order = new Int32Array(count);
  const centroids = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    order[i] = i;
    const o = i * 9;
    centroids[i * 3] = (soup[o] + soup[o + 3] + soup[o + 6]) / 3;
    centroids[i * 3 + 1] = (soup[o + 1] + soup[o + 4] + soup[o + 7]) / 3;
    centroids[i * 3 + 2] = (soup[o + 2] + soup[o + 5] + soup[o + 8]) / 3;
  }

  const leaves = [];
  const stack = [[0, count]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    const n = hi - lo;
    if (n <= maxTris) {
      leaves.push([lo, hi]);
      continue;
    }
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = lo; i < hi; i++) {
      const c = order[i] * 3;
      const x = centroids[c], y = centroids[c + 1], z = centroids[c + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const ex = maxX - minX, ey = maxY - minY, ez = maxZ - minZ;
    // Coincident centroids - a stack of identical decals, say. No split can
    // separate them, and recursing would not terminate.
    if (Math.max(ex, ey, ez) < 1e-4) {
      leaves.push([lo, hi]);
      continue;
    }
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    const slice = Array.from(order.subarray(lo, hi));
    slice.sort((p, q) => centroids[p * 3 + axis] - centroids[q * 3 + axis]);
    for (let i = 0; i < slice.length; i++) order[lo + i] = slice[i];
    const mid = lo + (n >> 1);
    stack.push([lo, mid], [mid, hi]);
  }

  return leaves.map(([lo, hi]) => {
    const out = new Float32Array((hi - lo) * 9);
    for (let i = lo; i < hi; i++) {
      const src = order[i] * 9;
      out.set(soup.subarray(src, src + 9), (i - lo) * 9);
    }
    return out;
  });
}

/** Longest side of a chunk's axis-aligned bounds, in metres. */
export function chunkSpan(positions) {
  if (!positions.length) return 0;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity;
  let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return Math.max(x1 - x0, y1 - y0, z1 - z0);
}

/**
 * `chunkTriangles`, but bounded in metres as well as in triangles.
 *
 * The median chunker splits on triangle COUNT, which is a stand-in for size
 * only while the geometry is evenly dense. It is not, once the map is five
 * decks wide: sixty shrubs scattered over a zone are one chunk exactly as much
 * as sixty triangles of one hedge are. That matters wherever a chunk becomes a
 * BOX - see `_solidifyPlanting`, where it produced a solid slab 250 by 301 m
 * lying across a corridor - and not at all where a chunk stays triangles.
 *
 * Anything still wider than `maxSpan` goes back through the chunker with half
 * its budget, and the loop stops the moment a split stops splitting.
 *
 * That last condition is not a belt-and-braces guard, it is the termination
 * proof. Halving the budget usually makes progress because the median split
 * always makes both halves strictly smaller - but `chunkTriangles` refuses to
 * divide triangles whose CENTROIDS coincide, since no plane can separate them,
 * and hands the range back whole however small the budget. Asking it again is
 * then an infinite loop, which is what a first version of this did: `node
 * --test` on forty stacked cards simply never returned. A single triangle, or
 * a stack that cannot be told apart, is where this has to stop.
 */
export function chunkTrianglesBySpan(soup, maxTris, maxSpan) {
  const out = [];
  const pending = chunkTriangles(soup, maxTris);
  while (pending.length) {
    const positions = pending.pop();
    const n = positions.length / 9;
    if (n > 1 && chunkSpan(positions) > maxSpan) {
      const parts = chunkTriangles(positions, n >> 1);
      if (parts.length > 1) {
        for (const part of parts) pending.push(part);
        continue;
      }
    }
    out.push(positions);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Polar helpers - the whole map is laid out on radiating avenues      */
/* ------------------------------------------------------------------ */

export function roadPos(deg, r, off = 0, y = 0, out = new THREE.Vector3()) {
  const t = deg * DEG;
  const c = Math.cos(t), s = Math.sin(t);
  return out.set(c * r - s * off, y, s * r + c * off);
}

/** Yaw for a building whose facade (-Z in local space) should face the avenue. */
export function faceRoadYaw(deg, side) {
  const t = deg * DEG;
  return side > 0 ? -t : Math.PI - t;
}

/** World-space centre of an outer zone's deck. */
export function zoneCentre(deg, out = new THREE.Vector3()) {
  return roadPos(deg, ZONE_CENTRE_R, 0, 0, out);
}

/**
 * Zone-local (lx, lz) -> world, for a zone on `deg`.
 *
 * Local +Z points back down the corridor toward the hub and local +X is to the
 * right of someone walking out of it, so every zone is authored in the same
 * frame regardless of which avenue it hangs off. That is what lets the four zone
 * builders share a floor plan vocabulary - "the servery is at lz = -60" means
 * the same thing in all of them.
 */
export function zoneLocal(deg, lx, ly, lz, out = new THREE.Vector3()) {
  const t = deg * DEG;
  const c = Math.cos(t), s = Math.sin(t);
  // Outward unit vector (c, s); the corridor runs along it.
  const cx = c * ZONE_CENTRE_R, cz = s * ZONE_CENTRE_R;
  return out.set(cx - c * lz - s * lx, ly, cz - s * lz + c * lx);
}

/**
 * Yaw of a zone-local heading, for geometry placed through `GeoBatch.localAt`.
 *
 * Chosen so that `localAt(key, geo, centre.x, 0, centre.z, zoneYaw(deg), lx, ly, lz)`
 * lands on exactly the same world point as `zoneLocal(deg, lx, ly, lz)`.
 * `localAt` sends local +Z to `(sin yaw, cos yaw)` and local +X to
 * `(cos yaw, -sin yaw)`; the zone frame wants +Z pointing back down the corridor
 * at `(-cos t, -sin t)`, which is `yaw = atan2(-cos t, -sin t) = -PI/2 - t`.
 */
export function zoneYaw(deg, localYaw = 0) {
  return -Math.PI / 2 - deg * DEG + localYaw;
}

/* ------------------------------------------------------------------ */
/* Where derived collision applies                                     */
/* ------------------------------------------------------------------ */

/**
 * Ceiling for geometry-derived collision inside a link corridor.
 *
 * A link is a sealed 9.5 m tube: the top of its roof plate is at 9.85 m and the
 * service bays' roofs at 9.95. Nothing higher is inside the corridor at all -
 * what is up there is apron dressing and the dome, metres away to the side of
 * a band that has to be wide enough to hold the glazed bays, and none of it is
 * anywhere a player can stand. 12 clears the tube with two metres to spare.
 */
export const LINK_COLLIDE_CEILING = 12;

/**
 * Half-width of a link's collision band.
 *
 * The corridor's own walls stand at 9.7 m from the axis and its two glazed
 * service bays reach 16.7; 18 takes both with a margin, and the ceiling above
 * is what keeps the extra width from collecting anything that is not corridor.
 */
const LINK_BAND_HALF = 18;

/**
 * Four metres past the rim. The perimeter wall is drawn at `ZONE_R + 2` and is
 * 1.1 m thick, and the deck disc runs to `ZONE_R + 3`, so this is the smallest
 * radius that has a zone wholly inside its own region.
 */
const ZONE_COLLIDE_R = ZONE_R + 4;

/* Hub and zone decks: cx, cz, r^2, ceiling. Then the four links: ux, uz, tMin,
 * tMax, halfWidth^2, ceiling. Flat `Float64Array`s rather than objects because
 * `collideCeilingAt` runs once per triangle - see its note. */
const COLLIDE_DISCS = new Float64Array((1 + ZONES.length) * 4);
const COLLIDE_BANDS = new Float64Array(ZONES.length * 6);
{
  const c = new THREE.Vector3();
  COLLIDE_DISCS[2] = DECK_R * DECK_R;
  COLLIDE_DISCS[3] = COLLIDE_CEILING;
  ZONES.forEach((z, i) => {
    zoneCentre(z.deg, c);
    const d = (i + 1) * 4;
    COLLIDE_DISCS[d] = c.x;
    COLLIDE_DISCS[d + 1] = c.z;
    COLLIDE_DISCS[d + 2] = ZONE_COLLIDE_R * ZONE_COLLIDE_R;
    COLLIDE_DISCS[d + 3] = COLLIDE_CEILING;

    const t = z.deg * DEG, b = i * 6;
    COLLIDE_BANDS[b] = Math.cos(t);
    COLLIDE_BANDS[b + 1] = Math.sin(t);
    /* Starts inside the hull line and stops at the zone rim, matching the
     * corridor `buildLink` actually draws (R0 = HULL_R - 6, R1 = the rim). The
     * overlap at both ends is what keeps the three regions one connected
     * surface rather than three with seams between them. */
    COLLIDE_BANDS[b + 2] = HULL_R - 8;
    COLLIDE_BANDS[b + 3] = ZONE_CENTRE_R - ZONE_R + 2;
    COLLIDE_BANDS[b + 4] = LINK_BAND_HALF * LINK_BAND_HALF;
    COLLIDE_BANDS[b + 5] = LINK_COLLIDE_CEILING;
  });
}

/**
 * How high geometry-derived collision reaches above `(x, z)`, or `-Infinity`
 * where there is none.
 *
 * ── The defect this replaces ──────────────────────────────────────────────
 * `_collisionSoup` used to end its per-triangle filter with
 *
 *     if (cx * cx + cz * cz > DECK_R * DECK_R) continue;
 *
 * which was right while the hub was the whole world and silently wrong from the
 * day the outer ring was built. The four zones sit at `ZONE_CENTRE_R` = 498 with
 * a 200 m radius of their own, so every triangle in four fifths of the finished
 * map was thrown away before it could become a collider, and the outer ring
 * stood on nothing but the colliders its builders had remembered to write by
 * hand - 110 calls in the gym, 74 in the works, 69 in the galley, 13 in Hab
 * Ring C, against roughly eight thousand drawn objects.
 *
 * ── Why discs and a band, and not a polygon ───────────────────────────────
 * This is asked once per triangle, a quarter of a million times per build, so
 * it has to stay arithmetic. It can, because the map is exactly five discs
 * joined by four straight corridors: five squared-distance tests and four
 * projections onto a known unit vector describe it with no approximation, and
 * the first hit returns.
 *
 * The hub is tested first and its disc is untouched - same `DECK_R`, same
 * `COLLIDE_CEILING` - so nothing about the hub's collision moves. Everything
 * here is additive.
 *
 * ── Why the zones keep the hub's 62 m ceiling ─────────────────────────────
 * Because that is what it was raised for. `COLLIDE_CEILING` above is the
 * highest STANDABLE surface on the finished map plus a metre, and three of the
 * four surfaces its note names are out here: the hab stacks at 46, the
 * expansion site's scaffold decks at 52, the tower crane's walkway at 58. An
 * arcade-height ceiling was measured against the built world before being
 * rejected: a zone holds 4,786 candidate triangles between 32 and 62 m, every
 * one of them in the open court where those structures stand, and exactly none
 * under the 30 m arcade plate. Cutting the zones at the arcade would have saved
 * nothing and taken the crane.
 */
export function collideCeilingAt(x, z) {
  for (let i = 0; i < COLLIDE_DISCS.length; i += 4) {
    const dx = x - COLLIDE_DISCS[i], dz = z - COLLIDE_DISCS[i + 1];
    if (dx * dx + dz * dz <= COLLIDE_DISCS[i + 2]) return COLLIDE_DISCS[i + 3];
  }
  for (let i = 0; i < COLLIDE_BANDS.length; i += 6) {
    const ux = COLLIDE_BANDS[i], uz = COLLIDE_BANDS[i + 1];
    const t = x * ux + z * uz;
    if (t < COLLIDE_BANDS[i + 2] || t > COLLIDE_BANDS[i + 3]) continue;
    const lat = z * ux - x * uz;
    if (lat * lat <= COLLIDE_BANDS[i + 4]) return COLLIDE_BANDS[i + 5];
  }
  return -Infinity;
}
