import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { sweep, blob } from '../gfx/Organic.js';
import { World } from './World.js';
import { Collider } from '../physics/Physics.js';
import {
  RaceCourse, Lattice, slabMatrix, mulberry32,
  clamp, clamp01, lerp, smoothstep, TAU,
} from './RaceTrack.js';

/**
 * RACE - "Vellum Ridge Circuit".
 *
 * A 2 km closed circuit that climbs out of a coastal plain, runs a ridge line
 * through open hill country, drops back down and threads a city block on its
 * way to the start/finish straight. Generous in the Mario-Kart sense - 20 to
 * 26 m of tarmac, wide run-off, barriers everywhere, nothing that punishes a
 * clumsy line - but built and lit like the rest of this game rather than as a
 * cartoon.
 *
 * ── The one thing that decides whether this world works ────────────────────
 *
 * A car reads the ground four times a frame, once per wheel, and averages the
 * four to decide its ride height and its pitch and roll. That makes it a far
 * harsher test of terrain than a player on foot: a walking player notices a
 * hole when they fall in one, and a car notices a two-centimetre step at every
 * segment seam because it arrives fifteen times a second. Two rules follow, and
 * everything in this file is downstream of them.
 *
 * 1. **One height function.** `RaceCourse.probe` is the only description of the
 *    ground in this world. The terrain mesh is built from it, the terrain
 *    colliders are built from the same array of samples the mesh uses, the road
 *    ribbon is built from it, and so are the barriers, the grid boxes and every
 *    prop. CitadelWorld had three descriptions of one slope and the player
 *    walked around underneath the visible world where they disagreed; there is
 *    nothing here for them to disagree *with*.
 *
 * 2. **The terrain is tilted slabs, not level boxes.** `Physics.addRotatedBox`
 *    only rotates about Y, which is right for a town and useless for ground
 *    that climbs 30 m - a level box under a slope is a staircase, and the car
 *    feels every step. `Collider` takes an arbitrary matrix, so every terrain
 *    collider here is a slab whose top face is a plane fitted to the block of
 *    heightfield it covers and then raised until it is at or above every sample
 *    inside it. Fitted rather than flat makes the error a few centimetres
 *    instead of a couple of metres; "raised until above" makes the error
 *    signed, so collision can float a little over the ground and can never sink
 *    beneath it.
 *
 * 3. **The road carries its solid collision 28 cm below what is drawn.** That
 *    is the one place in this world where collision and geometry deliberately
 *    disagree, and it is not a shortcut: `Car` sinks its hull capsules into the
 *    ground on purpose, and `_resolveCollision` then reads the *tilted* normal
 *    of any sloping surface as a wall and scrubs 45% of the car's speed per
 *    frame - measured, the car settled at 0.5 m/s and could not climb a 1.2%
 *    rise. The wheels ride a second, non-solid layer at the true surface, so
 *    nothing the player can see is affected. `_buildTrackCollision` has the
 *    full account, including what would remove the need for it.
 *
 * `addTriangleMesh` is not used anywhere. One collider holding 60 000 triangles
 * behind a single bounding sphere is a broadphase that never rejects anything,
 * and a chunked one only moves the seams it was meant to remove.
 *
 * ── Layout, in racing order ───────────────────────────────────────────────
 *
 *   start/finish straight (south, 200 m, pit wall and grandstand)
 *   T1  long left sweeper onto the east straight, climbing
 *   T3  fast right kink, then the climb into the hills
 *   the Ridge - crest, downhill esse, second crest at 21 m
 *   Ridge Loop - long banked left, the slowest corner on the lap bar one
 *   the Descent - 8% downhill run back to sea level
 *   Foundry Corner - hard 33 m left into the city
 *   Foundry Road / Grand Avenue - two city blocks, buildings either side
 *   the final sweeper back onto the straight
 */

/* ------------------------------------------------------------------ */
/* Module scratch - never allocate inside a loop.                       */
/* ------------------------------------------------------------------ */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _n1 = new THREE.Vector3();
const _a1 = new THREE.Vector3();
const _m1 = new THREE.Matrix4();
const _q1 = new THREE.Quaternion();
const _e1 = new THREE.Euler();
const _color = new THREE.Color();

/** Playfield half-extent. */
const HALF = 260;
/** Terrain mesh quads across the playfield, and the metres each one covers. */
const SEG = 200;
const QUAD = (HALF * 2) / SEG;
/** Terrain collider cell, in quads. */
const CELL_Q = 2;

/* The road's collision used to be built twice: a raycast layer at the true
 * surface and a solid "character" layer 0.28 m below it, because `Car` could
 * not climb any gradient without the road pushing it to a standstill. That was
 * a workaround for a bug in `Car._resolveCollision`, which read only the
 * horizontal part of the collision pushout and, because it normalised it,
 * could not tell two millimetres of slope from a head-on barrier.
 *
 * That is fixed at source now - the car ignores a pushout that is mostly
 * vertical, which is the floor holding it up rather than something in its way -
 * so the road is one solid layer at the height it is drawn, and a player on
 * foot no longer stands 0.28 m inside the tarmac. */

/**
 * Control points of the circuit, in the racing direction.
 * `y` is the road surface height, `w` the drivable half-width, `v` the run-off
 * carried either side of it.
 *
 * Corner radius is set by how close consecutive points are, not by any explicit
 * radius: Catmull-Rom through widely spaced points is a sweeper and through
 * tight ones is a hairpin. The numbers that matter are measured at build time
 * and logged - the car's lateral grip budget caps its yaw rate at `13.5 / v`,
 * so a 25 m corner has to be taken at 18 m/s and a 45 m one at 25, against
 * 22 m/s of cruise and 34 of boost. That spread is the lap.
 *
 * `v` is what turns the west of the circuit into a street section. Everywhere
 * else it is 11 m of kerb, tarmac apron, gravel and grass; from Foundry Corner
 * to the exit of Wharf Street it collapses to 3.5, which puts the barrier three
 * metres off the racing line and lets the buildings stand where they would
 * really stand. Nothing else about those corners changes - the difficulty comes
 * entirely from having nowhere to put a mistake.
 */
const CONTROLS = [
  { x: 30, z: 203, y: 0.0, w: 11.5 },    //  0  start/finish line
  { x: 90, z: 199, y: 0.5, w: 11.5 },
  { x: 140, z: 189, y: 1.3, w: 11.0 },
  { x: 180, z: 174, y: 2.6, w: 10.0 },   //  3  T1, long left onto the east straight
  { x: 214, z: 142, y: 4.2, w: 9.5 },
  { x: 224, z: 100, y: 5.8, w: 9.5 },
  { x: 216, z: 54, y: 7.2, w: 10.0 },    //  6  east straight, climbing
  { x: 213, z: 2, y: 9.0, w: 10.0 },
  { x: 229, z: -48, y: 11.6, w: 9.5 },   //  8  right kink
  { x: 212, z: -98, y: 14.4, w: 9.0 },
  { x: 176, z: -142, y: 17.2, w: 9.0 },
  { x: 130, z: -170, y: 19.6, w: 9.0 },  // 11  first crest
  { x: 86, z: -160, y: 20.6, w: 8.5 },
  { x: 56, z: -124, y: 18.2, w: 8.5 },   // 13  esse left
  { x: 20, z: -142, y: 19.6, w: 8.5 },   // 14  esse right
  { x: -16, z: -188, y: 21.8, w: 9.0 },  // 15  ridge top
  { x: -72, z: -204, y: 21.6, w: 8.5 },  // 16  Ridge Loop entry
  { x: -122, z: -192, y: 20.4, w: 8.0 },
  { x: -148, z: -162, y: 18.8, w: 8.0 }, // 18  Ridge Loop apex
  { x: -144, z: -128, y: 16.6, w: 8.5 },
  { x: -114, z: -100, y: 12.8, w: 9.5 }, // 20  the Descent
  { x: -86, z: -68, y: 8.4, w: 10.0 },
  { x: -80, z: -36, y: 4.6, w: 10.0, v: 8 },
  { x: -82, z: -12, y: 2.2, w: 9.0, v: 4.5 },   // 23  Foundry Corner entry
  { x: -96, z: 6, y: 0.9, w: 8.0, v: 3.5 },     // 24  apex
  { x: -120, z: 14, y: 0.2, w: 9.0, v: 3.5 },
  { x: -162, z: 12, y: 0.0, w: 10.0, v: 3.5 },  // 26  Foundry Road
  { x: -200, z: 14, y: 0.0, w: 9.0, v: 3.5 },
  { x: -216, z: 32, y: 0.0, w: 8.0, v: 3.5 },   // 28  Dock Turn apex
  { x: -218, z: 58, y: 0.0, w: 9.0, v: 3.5 },
  { x: -216, z: 100, y: 0.0, w: 9.5, v: 3.5 },  // 30  Grand Avenue
  { x: -208, z: 128, y: 0.0, w: 8.5, v: 3.5 },
  { x: -186, z: 140, y: 0.0, w: 8.0, v: 3.5 },  // 32  Cargo Turn
  { x: -152, z: 142, y: 0.0, w: 9.0, v: 3.5 },  // 33  Wharf Street
  { x: -118, z: 150, y: 0.0, w: 9.0, v: 4.5 },
  { x: -92, z: 168, y: 0.0, w: 9.5, v: 7 },     // 35  out of the city
  { x: -74, z: 194, y: 0.0, w: 10.5 },
  { x: -40, z: 203, y: 0.0, w: 11.5 },          // 37  onto the main straight
  { x: -6, z: 204, y: 0.0, w: 11.5 },
];

/**
 * Hills, as explicit masses rather than noise.
 *
 * Noise in a height function is noise the collision has to reproduce, and the
 * only way to reproduce it is to sample it at the same resolution - which is
 * why this world's terrain is a small number of named, hand-placed landforms
 * plus a couple of long wavelengths. Every one of them is smooth over tens of
 * metres, so a 5 m collider slab fitted to it is accurate to a few centimetres.
 * @type {Array<[number, number, number, number]>} x, z, radius, height
 */
const HILLS = [
  [186, -80, 132, 28],
  [244, -172, 112, 24],
  [112, -226, 136, 34],
  [-40, -246, 132, 30],
  [-182, -152, 130, 20],
  [52, -70, 104, 16],
  [146, 74, 112, 12],
  [4, 44, 142, 7],
  [250, 34, 92, 14],
  [244, 126, 96, 17],
];

/** Flat plates: the city block and the paddock plain. cx, cz, hx, hz, fade */
const PLATES = [
  [-155, 70, 104, 128, 66],
  [40, 220, 236, 50, 58],
];

/**
 * Natural ground, before the circuit is cut into it.
 * A pure function of position, deliberately free of anything sharper than the
 * collider resolution can follow.
 */
function baseTerrain(x, z) {
  let h = 0;
  for (let i = 0; i < HILLS.length; i++) {
    const hx = HILLS[i][0];
    const hz = HILLS[i][1];
    const r = HILLS[i][2];
    const d = Math.hypot(x - hx, z - hz);
    if (d < r) {
      const t = 1 - d / r;
      h += HILLS[i][3] * t * t * (3 - 2 * t);
    }
  }
  h += Math.sin(x * 0.0165 + 1.2) * Math.cos(z * 0.0138 - 0.4) * 2.7;
  h += Math.sin((x + z) * 0.0292 + 2.1) * 1.15;
  h += Math.sin(x * 0.0505 - 0.7) * 0.5 + Math.cos(z * 0.0447 + 1.7) * 0.45;

  for (let i = 0; i < PLATES.length; i++) {
    const [cx, cz, hxE, hzE, fade] = PLATES[i];
    const wx = 1 - smoothstep(hxE, hxE + fade, Math.abs(x - cx));
    const wz = 1 - smoothstep(hzE, hzE + fade, Math.abs(z - cz));
    h = lerp(h, 0, wx * wz);
  }
  return h;
}

/** The city block, in world coordinates. Buildings only spawn inside it. */
const CITY = { x0: -244, x1: -64, z0: -46, z1: 178 };

/**
 * Metres of world covered by one texture tile, per material family.
 *
 * These are the values each surface in the shared library was authored for.
 * Batched boxes get their UVs re-projected against them (see `Batch.add`) and
 * the strip mesher divides its world-space u/v by them, so a 40 m wide run-off
 * and a 20 cm kerb come out at the same texel density - which is the whole
 * reason any of the PBR detail is visible at all.
 */
const TILE_METRES = (key) => {
  switch (key.split(':')[0]) {
    case 'asphalt.court': return 5;
    case 'concrete.road': return 6;
    case 'concrete.wall': return 4;
    case 'concrete.skatepark': return 5;
    case 'metal.hull': return 4;
    case 'metal.panel': return 3;
    case 'metal.rail': return 2;
    case 'metal.trim': return 1.5;
    case 'metal.iron': return 1.2;
    case 'glass.window': return 3;
    case 'hazard.stripe': return 2;
    case 'paint.enamel': return 0.6;
    case 'paint.white': return 2;
    case 'rubber.track': return 2.5;
    case 'dirt.ground': return 5;
    case 'grass.field': return 4;
    case 'stone.cobble': return 2;
    case 'wood.plank': return 2.5;
    case 'fence.chain': return 2;
    // Printed cloth carries a pattern rather than a grain; re-projecting it
    // would slide the pattern across the banner.
    case 'fabric.banner': return 0;
    default: return 0;
  }
};

/** City concrete, sampled toward the cool end so the tarmac reads warm against it. */
const CITY_WASH = [
  0xb9bcbe, 0xa9adb2, 0xc4c6c4, 0x9fa4a8, 0xcdcac2,
  0xb2aca4, 0x99a0a6, 0xc8c4b8, 0xa4a8ac, 0xbdb6ac,
];

/**
 * Two rotations, because a box beside a road and a box across a road are not
 * the same box rotated differently - they are different conventions, and
 * mixing them is how a grandstand ends up facing the countryside.
 *
 * `Batch.box(w, h, d, ..., rotY)` builds the box in local axes and then turns
 * it about Y, so local +X ends up along (cos rotY, -sin rotY) and local +Z
 * along (sin rotY, cos rotY).
 *
 * `alongYaw`  puts the box's width along the racing direction - garages, pit
 *             wall, grandstand terraces, sponsor boards.
 * `acrossYaw` puts the box's width across it - the gantry, the start line, the
 *             grid boxes. It also happens to be the yaw a *character* needs,
 *             since characters look down -Z at yaw 0.
 */
const alongYaw = (dx, dz) => Math.atan2(-dz, dx);
const acrossYaw = (dx, dz) => Math.atan2(-dx, -dz);

/** One of `list`, with a small per-pick lightness jitter. */
function pick(rnd, list) {
  const base = list[(rnd() * list.length) | 0];
  const f = 0.9 + rnd() * 0.2;
  return (
    (Math.min(255, ((base >> 16) & 255) * f) | 0) << 16 |
    (Math.min(255, ((base >> 8) & 255) * f) | 0) << 8 |
    (Math.min(255, (base & 255) * f) | 0)
  );
}

/** Edge round applied to batched boxes, and the size below which it is skipped. */
const BEVEL = 0.07;
const BEVEL_MIN = 0.6;

/**
 * Geometry accumulator: collects transformed geometries per material key and
 * merges each bucket into one mesh.
 *
 * The city alone is ~2 400 boxes. Drawn one at a time that is 2 400 draw calls
 * for scenery nobody stops to look at, so everything sharing a material becomes
 * a single mesh per district.
 */
class Batch {
  /**
   * @param {{ao?:number, sky?:number, grime?:number, span?:number}} [shade]
   *   Baked vertex shading: `ao` darkens the foot of a piece, `sky` darkens
   *   downward-facing faces, `grime` cools the dark end, `span` is the height
   *   the AO ramp runs over.
   * @param {(key:string)=>number} [tiles]
   */
  constructor(shade = null, tiles = TILE_METRES) {
    /** @type {Map<string, THREE.BufferGeometry[]>} */
    this.buckets = new Map();
    this._owned = [];
    this.shade = shade;
    this.tiles = tiles;
  }

  /**
   * @param {string} key @param {THREE.BufferGeometry} geo consumed
   * @param {THREE.Matrix4} matrix @param {number} [tint]
   */
  add(key, geo, matrix, tint = null) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    // mergeGeometries returns null the moment two inputs disagree about which
    // attributes exist, so anything unexpected has to go.
    for (const k of Object.keys(g.attributes)) {
      if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    }
    g.applyMatrix4(matrix);

    /* Re-project the UVs into world space.
     *
     * A BoxGeometry's UVs run 0..1 across each face whatever the face measures,
     * so one tile of concrete is stretched across a 40 m tower while the same
     * tile is crammed onto a 20 cm sill. The material cannot fix it with
     * `repeat` because these boxes are merged into one mesh and every one of
     * them is a different size - the scale has to live in the geometry. Planar
     * projection onto whichever axis each face points along, divided by the
     * metres one tile was authored for. */
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
        if (ny >= nx && ny >= nz) { u = x; v = z; }
        else if (nx >= nz) { u = z; v = y; }
        else { u = x; v = y; }
        uv[i * 2] = u * inv;
        uv[i * 2 + 1] = v * inv;
      }
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    }

    /* The colour attribute is always written, white when no tint was asked for:
     * a missing attribute both breaks the merge and reads as *zero* under
     * `vertexColors`, which renders black rather than untinted. */
    _color.set(tint === null ? 0xffffff : tint);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
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
      let minY = Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < n; i++) {
        const y = posA.getY(i);
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      // Never run the ramp over more than the piece is tall, or anything thin
      // sits entirely inside the dark end of it and comes out a silhouette.
      const span = Math.min(sh.span ?? 2.4, Math.max(maxY - minY, 0.02));
      for (let i = 0; i < n; i++) {
        const t = clamp01((posA.getY(i) - minY) / span);
        const rise = t * t * (3 - 2 * t);
        let f = 1 - ao * (1 - rise);
        if (nrmA) f *= 1 - sky * (1 - (nrmA.getY(i) * 0.5 + 0.5));
        const d = (1 - f) * grime;
        col[i * 3] = _color.r * f * (1 - d * 0.14);
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
   * Axis-aligned (or Y-rotated) box, bevelled where it is big enough for the
   * bevel to read. A hard 90 degree edge returns exactly one shade to the
   * camera, which is what "blocky" actually describes; a few centimetres of
   * round gives every edge a highlight and a dark line. Below the threshold it
   * is trim nobody can see, and a bevelled box costs 108 triangles against 12.
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

  /** Box with an arbitrary basis - used for anything following the road. */
  boxOriented(key, w, h, d, matrix, tint = null) {
    this.add(key, new THREE.BoxGeometry(w, h, d), matrix, tint);
  }

  flush(group, resolve, name, { cast = true, recv = true } = {}) {
    const out = [];
    for (const [key, list] of this.buckets) {
      if (!list.length) continue;
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) {
        console.warn(`[RaceWorld] merge failed for "${key}" in ${name}`);
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

/* ================================================================== */

export class RaceWorld extends World {
  static id = 'race';
  static displayName = 'Vellum Ridge Circuit';

  constructor(ctx) {
    super(ctx);
    this.rnd = mulberry32(0x9a17ce);

    /* ---- the published contract; see the class header ---- */
    /** @type {Array<{x:number,y:number,z:number,width:number}>} */
    this.trackPath = [];
    /** @type {Array<{x:number,y:number,z:number,yaw:number}>} */
    this.startGrid = [];
    /** @type {Array<{x:number,y:number,z:number,radius:number}>} */
    this.checkpoints = [];
    this.lapCount = 3;
    /* Difficulty is a property of the field, not of the circuit.
     *
     * A world is generated once by WorldManager and never rebuilt, so a variant
     * that changed the width of the tarmac could only ever be advertised, not
     * delivered. What the three names actually select is the AI performance
     * band in the race systems, which needs no geometry at all - so all three
     * are real, and `build()` still accepts a variant so a future caller that
     * *can* rebuild is not locked out. */
    this.difficulties = ['easy', 'standard', 'expert'];
    this.variant = 'standard';
    /** Circuit length in metres. */
    this.trackLength = 0;

    this._owned = [];
    this._time = 0;
    this.course = null;
    this._configureEnvironment();
  }

  /* ================================================================== */
  /* Environment                                                         */
  /* ================================================================== */

  _configureEnvironment() {
    const env = this.environment;
    // Mid-morning, sun over the sea to the south-east. High enough that the
    // road is evenly lit end to end - a low sun on a circuit puts half the lap
    // in silhouette - but off-axis enough that the hills keep their form.
    env.background = null;
    env.fogColor = new THREE.Color(0xbfd4e4);
    env.fogNear = 140;
    env.fogFar = 760;
    env.exposure = 1.0;
    env.ambientColor = new THREE.Color(0x8fa2b4);
    env.ambientIntensity = 0.55;
    env.skyColor = new THREE.Color(0x9dc4ec);
    // Grass and tarmac bouncing up: green-grey, not the desert tan the citadel
    // needed. Getting this wrong is what turns shadows purple.
    env.groundColor = new THREE.Color(0x6f7a58);
    env.hemiIntensity = 1.1;
    env.sunColor = new THREE.Color(0xfff2d8);
    env.sunIntensity = 5.4;
    env.sunDirection = new THREE.Vector3(0.42, 0.72, 0.55).normalize();
    env.envMapIntensity = 1.0;
    env.bloom = { strength: 0.38, radius: 0.5, threshold: 0.94 };
    env.envMap = this.materials?.getEnvMap?.('daylight') ?? undefined;
  }

  /* ================================================================== */
  /* Build                                                               */
  /* ================================================================== */

  /**
   * @param {(p:number,label:string)=>any} [onProgress]
   * @param {string} [variant] one of {@link difficulties}. Recorded and
   *   published; the geometry is identical for all three, because the circuit
   *   is built once per session and the difficulty is the field you race, not
   *   the road you race on.
   */
  async build(onProgress, variant = 'standard') {
    const report = onProgress ?? (() => {});
    if (this.difficulties.includes(variant)) this.variant = variant;

    await report(0.02, 'Surveying the circuit');
    this.course = new RaceCourse(CONTROLS, {
      spacing: 2,
      verge: 11,
      baseHeight: baseTerrain,
      maxBankDeg: 5,
      cornerWiden: 0.2,
    });
    this.trackLength = this.course.length;
    console.info(
      `[RaceWorld] circuit ${this.course.length.toFixed(0)} m, ` +
      `${this.course.count} samples, tightest radius ${this.course.minRadius.toFixed(1)} m, ` +
      `steepest grade ${(this.course.maxGrade * 100).toFixed(1)}%`
    );

    await report(0.06, 'Hanging the sky');
    this._buildSky();

    await report(0.12, 'Cutting the terrain');
    this._buildTerrain();

    await report(0.42, 'Laying the tarmac');
    this._buildTrackSurface();

    await report(0.58, 'Bolting the barriers');
    this._buildBarriers();

    await report(0.70, 'Raising the city');
    this._buildCity();

    await report(0.80, 'Building the paddock');
    this._buildPaddock();

    await report(0.90, 'Planting the hills');
    this._buildScenery();

    await report(0.96, 'Painting the grid');
    this._fillSpawns();

    this.group.matrixAutoUpdate = false;
    this.group.updateMatrixWorld(true);
    this.group.visible = this.active;
    await report(1, 'Circuit ready');
  }

  /**
   * A shared-library material, cloned so this world can tint it and switch
   * `vertexColors` on without touching the instance the other four worlds draw
   * with. Clones share texture storage, so the cost is one shader program per
   * key. Without `vertexColors` every per-piece colour written into the
   * geometry is silently discarded and the whole city comes out identical.
   *
   * @param {string} key
   * @param {{vertexColors?:boolean}} [opts] pass `false` for instanced meshes,
   *   which carry no colour attribute - a material expecting one renders black.
   */
  _mat(key, opts = {}) {
    const vc = opts.vertexColors !== false;
    this._matCache ??= new Map();
    const cacheKey = vc ? key : `${key}|novc`;
    const hit = this._matCache.get(cacheKey);
    if (hit) return hit;

    const m = this.materials.get(key).clone();
    m.name = `race.${key}`;
    m.vertexColors = vc;
    /* Near-white shifts, not colours. These multiply the per-piece vertex
     * colour, and two mid-tones multiplied give a third much darker than
     * either - the trap that rendered CitadelWorld's palms black. */
    const TINT = {
      'asphalt.court': 0xe4e6e8,
      'concrete.road': 0xeceae4,
      'concrete.wall': 0xf2f0ea,
      'grass.field': 0xdcecc0,
      'dirt.ground': 0xefe4cc,
      'metal.rail': 0xf4f6f8,
      'metal.panel': 0xeef0f2,
      'paint.white': 0xffffff,
      'paint.enamel': 0xffffff,
      'foliage.frond': 0xcfe6b4,
      'bark.palm': 0xe8dcc8,
      'stone.cobble': 0xe6e2d8,
    };
    const t = TINT[key.split(':')[0]];
    if (t !== undefined) m.color = new THREE.Color(t);
    this._matCache.set(cacheKey, m);
    this._owned.push(m);
    return m;
  }

  /* ------------------------------------------------------------------ */
  /* Collision helpers                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * A slab whose *top face* is the plane through `origin` with normal `n`.
   *
   * Ground collision in this world is all of this shape. The caller is
   * responsible for having already raised `origin` until the plane is at or
   * above every mesh vertex the slab covers - that ordering is the rule that
   * keeps collision from ever sitting below what is drawn.
   */
  _slab(origin, n, along, halfAcross, halfAlong, thickness = 2.2, opts = {}) {
    slabMatrix(origin, n, along, thickness, _m1);
    return this.track(this.physics.add(new Collider('box', {
      halfExtents: _v4.set(halfAcross, thickness, halfAlong),
      matrix: _m1,
      ...opts,
    })));
  }

  /** A box centred on `c`, oriented by an up vector and a long axis. */
  _orientedBox(c, n, along, hx, hy, hz) {
    slabMatrix(c, n, along, 0, _m1);
    _m1.setPosition(c.x, c.y, c.z);
    return this.track(this.physics.add(new Collider('box', {
      halfExtents: _v4.set(hx, hy, hz),
      matrix: _m1,
    })));
  }

  /* ------------------------------------------------------------------ */
  /* Sky                                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Painted equirectangular dome.
   *
   * A flat background colour reads as a void behind a skyline rather than as
   * air, and a circuit is looked *along* more than any other world here - the
   * horizon is in shot for the whole lap. A sphere's UVs are already
   * equirectangular, so a 2-D canvas costs the same one draw call as a vertical
   * ramp and buys a sun where the light actually comes from, plus cloud banding
   * for the eye to measure distance against.
   */
  _buildSky() {
    const W = 1024;
    const H = 512;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const c = cv.getContext('2d');

    const grd = c.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0.0, '#1f4f9c');
    grd.addColorStop(0.30, '#5b93d4');
    grd.addColorStop(0.56, '#9dc2e2');
    grd.addColorStop(0.75, '#cfdeea');
    grd.addColorStop(1.0, '#dfe6e6');
    c.fillStyle = grd;
    c.fillRect(0, 0, W, H);

    // The disc is derived from `sunDirection`, so the glow in the sky and the
    // shadows on the ground can never point in different directions.
    const sd = this.environment.sunDirection;
    const su = ((Math.atan2(-sd.x, -sd.z) / TAU) + 0.75) % 1;
    const sv = clamp01(0.5 - Math.asin(clamp01(sd.y)) / Math.PI);
    const sx = su * W;
    const sy = sv * H;
    for (const ox of [-W, 0, W]) {
      const glow = c.createRadialGradient(sx + ox, sy, 0, sx + ox, sy, W * 0.26);
      glow.addColorStop(0.00, 'rgba(255,250,236,0.85)');
      glow.addColorStop(0.08, 'rgba(255,244,214,0.42)');
      glow.addColorStop(0.26, 'rgba(255,238,200,0.14)');
      glow.addColorStop(1.00, 'rgba(255,236,196,0)');
      c.fillStyle = glow;
      c.fillRect(sx + ox - W * 0.26, sy - W * 0.26, W * 0.52, W * 0.52);
      const disc = c.createRadialGradient(sx + ox, sy, 0, sx + ox, sy, W * 0.015);
      disc.addColorStop(0, 'rgba(255,255,252,1)');
      disc.addColorStop(1, 'rgba(255,250,232,0)');
      c.fillStyle = disc;
      c.fillRect(sx + ox - W * 0.02, sy - W * 0.02, W * 0.04, W * 0.04);
    }

    /* A deck of fair-weather cumulus, held to the middle of the map.
     *
     * Near v = 0 an equirectangular row *is* the pole, where the whole canvas
     * width collapses to a point - a cloud painted up there wraps into a streak
     * across the zenith. Dividing the horizontal radius by sin(pi t) undoes the
     * remaining compression, so they read round overhead and foreshortened
     * toward the horizon like a real deck. */
    const rnd = this.rnd;
    for (let i = 0; i < 44; i++) {
      const t = 0.19 + Math.pow(rnd(), 1.4) * 0.27;
      const y = t * H;
      const x = rnd() * W;
      const stretch = 1 / Math.max(0.55, Math.sin(Math.PI * t));
      const rx = (22 + rnd() * 58) * stretch;
      const ry = (rx * (0.16 + rnd() * 0.13)) / stretch;
      const a = (0.20 + rnd() * 0.30) * (1 - clamp01((t - 0.39) / 0.07));
      if (a <= 0.005) continue;
      // Shadowed base first, lit body offset above it: one soft blob is a
      // smudge, and the offset between two is what gives a cloud weight. Each
      // gradient is created inside the transform it is filled under, or its
      // centre lands somewhere else entirely and the shape fills with the
      // transparent tail.
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
      puff(x, y + ry * 0.5, [
        [0.0, `rgba(132,146,166,${a * 0.5})`],
        [0.6, `rgba(150,162,180,${a * 0.2})`],
        [1.0, 'rgba(150,162,180,0)'],
      ]);
      puff(x, y - ry * 0.35, [
        [0.00, `rgba(255,255,255,${a})`],
        [0.44, `rgba(250,251,253,${a * 0.7})`],
        [0.80, `rgba(244,248,252,${a * 0.24})`],
        [1.00, 'rgba(242,246,252,0)'],
      ]);
    }

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    tex.needsUpdate = true;

    const geo = new THREE.SphereGeometry(1100, 48, 32);
    const mat = new THREE.MeshBasicMaterial({
      map: tex, side: THREE.BackSide, fog: false, depthWrite: false,
    });
    const dome = new THREE.Mesh(geo, mat);
    dome.name = 'race:sky';
    dome.frustumCulled = false;
    dome.renderOrder = -100;
    dome.castShadow = false;
    dome.receiveShadow = false;
    this.group.add(dome);
    this._owned.push(geo, mat, tex);
  }

  /* ------------------------------------------------------------------ */
  /* Terrain                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * The heightfield, and the collision that backs it.
   *
   * Both are built from one array of samples. The mesh interpolates it
   * linearly between vertices; each collider slab is a plane fitted to a 5 m
   * block of it and then raised until it is at or above *every* sample inside
   * that block - and a linear function that dominates a piecewise-linear one at
   * all its vertices dominates it everywhere, so the slab provably cannot sit
   * below the triangle it covers. That is the whole argument, and it is why the
   * verification sweep comes back with zero points where the ground is below
   * what is drawn.
   *
   * Quads and cells that lie entirely under the road ribbon are dropped from
   * both: the ribbon is a better surface than any grid approximation of it, and
   * leaving the terrain there would z-fight with the tarmac as well as fight it
   * for which one the wheel probe finds.
   */
  _buildTerrain() {
    const N = SEG + 1;
    const course = this.course;
    const H = new Float32Array(N * N);
    const D = new Float32Array(N * N);
    const WS = new Float32Array(N * N);

    for (let j = 0; j < N; j++) {
      const z = -HALF + j * QUAD;
      for (let i = 0; i < N; i++) {
        const x = -HALF + i * QUAD;
        const p = course.probe(x, z);
        const k = j * N + i;
        D[k] = p.d;
        WS[k] = p.W;
        /* Sink the ground slightly under the sealed surface.
         *
         * The terrain and the ribbon are the same height by construction inside
         * the corridor, which means they are coplanar, which means they z-fight
         * across the whole road. A 10 cm cut that fades out by the outer edge of
         * the run-off separates them without putting a step anywhere a car can
         * reach - and since the colliders under the ribbon are dropped
         * entirely, nothing downstream ever sees the cut. */
        const cut = p.d < p.W + 5 ? 0.10 * (1 - smoothstep(p.W - 2, p.W + 5, p.d)) : 0;
        H[k] = p.h - cut;
      }
    }
    this._terrainH = H;

    /* ---- mesh ---------------------------------------------------- */
    const pos = new Float32Array(N * N * 3);
    const uv = new Float32Array(N * N * 2);
    const col = new Float32Array(N * N * 3);
    const rnd = this.rnd;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        const x = -HALF + i * QUAD;
        const z = -HALF + j * QUAD;
        pos[k * 3] = x;
        pos[k * 3 + 1] = H[k];
        pos[k * 3 + 2] = z;
        uv[k * 2] = x / 4;
        uv[k * 2 + 1] = z / 4;
        // Slope from a central difference, so steep faces go rockier and dry,
        // and the flats stay green. Cheap, and it is most of what stops one
        // material covering 190 000 square metres reading as a carpet.
        const hx = H[j * N + Math.min(N - 1, i + 1)] - H[j * N + Math.max(0, i - 1)];
        const hz = H[Math.min(N - 1, j + 1) * N + i] - H[Math.max(0, j - 1) * N + i];
        const slope = Math.hypot(hx, hz) / (2 * QUAD);
        const dry = smoothstep(0.22, 0.62, slope);
        const near = 1 - smoothstep(WS[k], WS[k] + 26, D[k]);
        const v = 0.90 + rnd() * 0.16;
        _color.setRGB(
          Math.min(1, lerp(0.84, 1.0, dry) * v),
          Math.min(1, lerp(0.98, 0.88, dry) * v * lerp(1, 0.95, near)),
          Math.min(1, lerp(0.76, 0.78, dry) * v * lerp(1, 0.9, near))
        );
        col[k * 3] = _color.r;
        col[k * 3 + 1] = _color.g;
        col[k * 3 + 2] = _color.b;
      }
    }

    const grassIdx = [];
    const rockIdx = [];
    for (let j = 0; j < SEG; j++) {
      for (let i = 0; i < SEG; i++) {
        const a = j * N + i;
        const b = a + 1;
        const c = a + N;
        const d = c + 1;
        // Under the ribbon: no mesh at all.
        if (D[a] < WS[a] - 2 && D[b] < WS[b] - 2 && D[c] < WS[c] - 2 && D[d] < WS[d] - 2) continue;
        const hmax = Math.max(H[a], H[b], H[c], H[d]);
        const hmin = Math.min(H[a], H[b], H[c], H[d]);
        // Two index buffers over one vertex array: rock and grass become
        // separate meshes with no overlap, so there is no decal to z-fight and
        // no lift to put the drawn surface above the collision.
        const target = (hmax - hmin) / QUAD > 0.46 ? rockIdx : grassIdx;
        target.push(a, c, d, a, d, b);
      }
    }

    const makeTerrain = (idx, key, name) => {
      if (!idx.length) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, this._mat(key));
      mesh.name = name;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      this.group.add(mesh);
      this._owned.push(g);
    };
    makeTerrain(grassIdx, 'grass.field', 'race:terrain.grass');
    makeTerrain(rockIdx, 'dirt.ground', 'race:terrain.rock');

    /* ---- collision ------------------------------------------------ */
    const cell = QUAD * CELL_Q;
    const cells = SEG / CELL_Q;
    let count = 0;
    for (let cj = 0; cj < cells; cj++) {
      for (let ci = 0; ci < cells; ci++) {
        const i0 = ci * CELL_Q;
        const j0 = cj * CELL_Q;
        // Fully under the ribbon: the ribbon slabs own it.
        let covered = true;
        for (let b = 0; b <= CELL_Q && covered; b++) {
          for (let a = 0; a <= CELL_Q; a++) {
            const k = (j0 + b) * N + (i0 + a);
            if (D[k] >= WS[k] - 2) { covered = false; break; }
          }
        }
        if (covered) continue;

        const k00 = j0 * N + i0;
        const k10 = j0 * N + (i0 + CELL_Q);
        const k01 = (j0 + CELL_Q) * N + i0;
        const k11 = (j0 + CELL_Q) * N + (i0 + CELL_Q);
        const gx = ((H[k10] + H[k11]) - (H[k00] + H[k01])) / (2 * cell);
        const gz = ((H[k01] + H[k11]) - (H[k00] + H[k10])) / (2 * cell);
        let hc = (H[k00] + H[k10] + H[k01] + H[k11]) * 0.25;
        const cx = -HALF + (i0 + CELL_Q * 0.5) * QUAD;
        const cz = -HALF + (j0 + CELL_Q * 0.5) * QUAD;

        // Raise the plane until it dominates every sample in the block.
        let dev = 0;
        for (let b = 0; b <= CELL_Q; b++) {
          for (let a = 0; a <= CELL_Q; a++) {
            const k = (j0 + b) * N + (i0 + a);
            const px = -HALF + (i0 + a) * QUAD - cx;
            const pz = -HALF + (j0 + b) * QUAD - cz;
            const d = H[k] - (hc + gx * px + gz * pz);
            if (d > dev) dev = d;
          }
        }
        hc += dev + 0.01;

        _n1.set(-gx, 1, -gz).normalize();
        _a1.set(0, 0, 1);
        _v3.set(cx, hc, cz);
        // The slab is tilted, so its footprint has to be stretched by the
        // secant of the tilt to still cover the cell - plus 12% of overlap so
        // neighbours meet rather than leaving a seam.
        const sec = Math.sqrt(1 + gx * gx + gz * gz);
        const half = cell * 0.5 * sec * 1.12;
        this._slab(_v3, _n1, _a1, half, half, 2.6);
        count++;
      }
    }

    /* A floor far below everything, so a fall through a seam that should not
     * exist lands on something rather than falling forever. It can never be the
     * answer to a ground query where terrain exists, because `raycast` returns
     * the nearest hit and the terrain is above it. */
    this.track(this.physics.addBox(0, -60, 0, HALF * 1.5, 8, HALF * 1.5));

    this._terrainColliders = count;
    this.bounds = new THREE.Box3(
      new THREE.Vector3(-HALF, -30, -HALF),
      new THREE.Vector3(HALF, 140, HALF)
    );
  }

  /* ------------------------------------------------------------------ */
  /* Track surface                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * The road: tarmac, edge lines, kerbs, gravel and grass run-off, as five
   * continuous strips extruded along the centreline, plus the slabs that make
   * them solid.
   *
   * Continuous is the operative word. A road built as a chain of boxes has a
   * seam every few metres, and each seam is a step the size of the sagitta -
   * small on a straight, centimetres in a corner - which a car crossing at
   * 30 m/s reads as a bump fifteen times a second. Extruding one surface has no
   * seams in it at all, and the collision slabs underneath are planes fitted to
   * that same surface rather than an independent approximation of it.
   */
  _buildTrackSurface() {
    const co = this.course;
    const N = co.count;

    /* Cross-section, as lateral offsets and heights above the road plane.
     * `f` returns the lateral offset for column u in 0..1 given the local
     * half-width; `dy` lifts paint and kerbs clear of the tarmac they sit on. */
    const strips = [];
    /* `flip` is `side > 0`, everywhere. A profile written as `s * (w + ...)`
     * runs outward on the right of the road and *inward* on the left, so the
     * two sides are wound opposite ways round; see Lattice.build. */
    const addStrip = (key, cols, f, dy, shade, tintOf = null, flip = true) => {
      strips.push({ key, lat: new Lattice(cols), cols, f, dy, shade, tintOf, flip });
    };
    const tile = (k) => TILE_METRES(k) || 4;

    // Tarmac. Lighter toward the edges where nothing runs, darker down the
    // middle where everything does.
    addStrip('asphalt.court', 12,
      (u, w) => lerp(-(w - 0.62), w - 0.62, u),
      () => 0,
      (u) => 0.88 + 0.14 * smoothstep(0.28, 0.5, Math.abs(u - 0.5)));
    // Edge lines, both sides.
    for (const s of [-1, 1]) {
      addStrip('paint.white', 2,
        (u, w) => s * lerp(w - 0.62, w, u),
        () => 0.014,
        () => 1, null, s > 0);
    }
    /* Run-off bands, as fractions of whatever run-off there is at that point.
     *
     * The circuit carries 11 m of it through the hills and 3.5 through the
     * city, so the profile cannot be written as fixed offsets - a gravel trap
     * authored at 5.1 m wide lands 1.6 m *inside* a city kerb and the strips
     * turn inside out. Written as widths that collapse in order - grass first,
     * then gravel - a street section keeps its kerb and its pavement and
     * simply has no grass verge, which is exactly right. */
    const kerbW = (V) => clamp(V * 0.3, 0.7, 1.9);
    const grassW = (V) => clamp(V - 6, 0, 3.5);
    const gravelW = (V) => clamp(V - 3, 0, 4.5);
    const pavedW = (V) => Math.max(0, V - kerbW(V) - gravelW(V) - grassW(V));

    // Kerbs: a raised rumble strip that ramps back down to the run-off.
    for (const s of [-1, 1]) {
      addStrip('paint.enamel', 4,
        (u, w, W) => s * (w + u * kerbW(W - w)),
        (u) => [0.02, 0.10, 0.10, 0.0][Math.round(u * 3)],
        () => 1,
        (i) => {
          /* Red/white blocks in the corners, plain grey kerb on the straights.
           * The stripe is a corner marker - a driver reads it at a distance and
           * knows to brake - and painting it round the whole lap throws away
           * the only piece of information it carries. */
          const tight = smoothstep(1 / 260, 1 / 70, Math.abs(co.curv[i]));
          const on = Math.floor((i * co.step) / 1.8) % 2 === 0;
          _v1.set(0.72, 0.74, 0.75);                                  // plain kerb
          _v2.set(on ? 0.78 : 0.95, on ? 0.21 : 0.95, on ? 0.17 : 0.94);
          _v1.lerp(_v2, tight);
          return (Math.round(_v1.x * 255) << 16) |
            (Math.round(_v1.y * 255) << 8) | Math.round(_v1.z * 255);
        },
        s > 0);
    }
    // Paved apron just off the kerb - a modern circuit's first run-off, and a
    // city street's pavement, depending on how much room there is.
    for (const s of [-1, 1]) {
      addStrip('concrete.road', 3,
        (u, w, W) => {
          const V = W - w;
          const a = w + kerbW(V);
          return s * (a + u * pavedW(V));
        },
        () => -0.02,
        (u) => 0.9 + 0.12 * u, null, s > 0);
    }
    // Gravel trap.
    for (const s of [-1, 1]) {
      addStrip('dirt.ground', 4,
        (u, w, W) => {
          const V = W - w;
          const a = w + kerbW(V) + pavedW(V);
          return s * (a + u * gravelW(V));
        },
        () => -0.03,
        (u) => 0.94 + 0.1 * u, null, s > 0);
    }
    // Grass verge out to the barrier line.
    for (const s of [-1, 1]) {
      addStrip('grass.field', 3,
        (u, w, W) => s * lerp(W - grassW(W - w), W, u),
        () => 0,
        (u) => 0.9 + 0.16 * u, null, s > 0);
    }

    const row = [];
    for (let c = 0; c < 16; c++) row.push({ x: 0, y: 0, z: 0, u: 0, r: 1, g: 1, b: 1 });

    for (let i = 0; i < N; i++) {
      const cx = co.x[i];
      const cz = co.z[i];
      const rx = co.rx[i];
      const rz = co.rz[i];
      const w = co.w[i];
      const W = co.W[i];
      const bank = co.bank[i];
      const s = i * co.step;
      for (const st of strips) {
        const t = tile(st.key);
        const tint = st.tintOf ? st.tintOf(i) : 0xffffff;
        _color.set(tint);
        for (let c = 0; c < st.cols; c++) {
          const u = st.cols === 1 ? 0 : c / (st.cols - 1);
          const lat = st.f(u, w, W);
          const y = co.y[i] + bank * clamp(lat, -w, w) + st.dy(u);
          const sh = st.shade(u);
          const v = row[c];
          v.x = cx + rx * lat;
          v.y = y;
          v.z = cz + rz * lat;
          v.u = lat / t;
          v.r = _color.r * sh;
          v.g = _color.g * sh;
          v.b = _color.b * sh;
        }
        st.lat.addRow(row, s / t);
      }
    }

    for (const st of strips) {
      const g = st.lat.build(true, st.flip);
      if (!g) continue;
      const mesh = new THREE.Mesh(g, this._mat(st.key));
      mesh.name = `race:track.${st.key}`;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      this.group.add(mesh);
      this._owned.push(g);
    }

    this._buildTrackCollision();
  }

  /**
   * The sealed surface, as two layers of oriented slabs at different heights.
   *
   * ── The measurement that forced this ─────────────────────────────────────
   *
   * The first version was one layer of oriented slabs at the road surface, and
   * by the obvious measure it was right: 276 of 300 sampled points on the
   * racing line had collision within five centimetres of the drawn tarmac and
   * not one of them below it. The car still crawled the lap at 0.86 m/s, and so
   * did every replacement - chunked triangle meshes, one closed triangle mesh,
   * more overlap, fewer seams. Instrumenting `Car._resolveCollision` collider by
   * collider is what finally explained it, and the cause is not the seams.
   *
   * The car stands three hull capsules of radius 0.76 on the local ground plus
   * a 0.16 m lift, which puts the bottom of each capsule 0.21 m *below* the
   * surface: the hull is meant to interpenetrate so kerbs and ramp lips are
   * driven over rather than climbed. `resolveCapsule` therefore pushes it back
   * out along the surface normal - and on a road with a gradient, the surface
   * normal is not vertical. `_resolveCollision` keeps only the horizontal part
   * of that pushout and then applies
   *
   *     square = clamp01(-into / |speed|);   speed *= 1 - 0.45 * square;
   *
   * where `into` is the velocity projected on the *normalised* horizontal
   * pushout. The size of the pushout never enters it. On the 1.2% rise out of
   * the start/finish line the pushout is 2 mm, `square` comes out at 1, and the
   * car loses 45% of its speed every single frame - it settles at exactly the
   * 0.5 m/s where that loss balances the throttle. The tolerance below which
   * `_resolveCollision` gives up is 1e-8 m^2, so the car cannot climb a gradient
   * of more than about 0.05% against solid ground of any shape.
   *
   * No other world has ever exposed this, because no other world has a tilted
   * ground collider in it: every floor, plaza, street and mesa in this game is
   * an axis-aligned box with a dead level top, and a level top returns an
   * exactly vertical normal with no horizontal part to keep. This is the first
   * world whose ground actually slopes.
   *
   * ── How it was worked around, and how it is actually fixed ───────────────
   *
   * This world first shipped the road as two layers - a raycast layer at the
   * true surface that `resolveCapsule` skipped, and a solid layer 0.28 m below
   * it that the car's capsules could never touch. It worked, and it cost a
   * player on foot standing 0.28 m inside the tarmac.
   *
   * The bug is fixed at source now. `Car._resolveCollision` reads the vertical
   * part of the pushout and ignores any contact that is mostly vertical - that
   * is the floor holding the car up, not something in its way - so the road is
   * a single solid layer at exactly the height it is drawn, nobody sinks into
   * it, and the collider count halves.
   *
   * The slabs are oriented rather than level boxes for the usual reason: a
   * level box under a road that climbs 21 m is a staircase.
   */
  _buildTrackCollision() {
    const co = this.course;
    const N = co.count;
    const STEP = 2;            // samples per slab, ~4 m
    const LANES = 4;           // lateral splits, so a slab does not chord a corner
    let count = 0;

    for (let i = 0; i < N; i += STEP) {
      const j = Math.min(i + STEP, N) % N;
      const wA = co.w[i];
      const wB = co.w[j];
      const WA = co.W[i];
      const WB = co.W[j];
      for (let l = 0; l < LANES; l++) {
        const u0 = -1 + (2 * l) / LANES;
        const u1 = -1 + (2 * (l + 1)) / LANES;
        const p = [
          this._roadPoint(i, u0 * WA, wA, new THREE.Vector3()),
          this._roadPoint(i, u1 * WA, wA, new THREE.Vector3()),
          this._roadPoint(j, u0 * WB, wB, new THREE.Vector3()),
          this._roadPoint(j, u1 * WB, wB, new THREE.Vector3()),
        ];
        const centre = new THREE.Vector3()
          .add(p[0]).add(p[1]).add(p[2]).add(p[3]).multiplyScalar(0.25);
        const along = new THREE.Vector3()
          .add(p[2]).add(p[3]).sub(p[0]).sub(p[1]).multiplyScalar(0.5);
        const across = new THREE.Vector3()
          .add(p[1]).add(p[3]).sub(p[0]).sub(p[2]).multiplyScalar(0.5);
        const n = new THREE.Vector3().crossVectors(across, along).normalize();
        if (n.y < 0) n.negate();
        // Raise the plane past the highest of the four corners it interpolates,
        // so the raycast layer is never below the tarmac that is drawn.
        let dev = 0;
        for (const q of p) {
          const d = _n1.copy(q).sub(centre).dot(n);
          if (d > dev) dev = d;
        }
        centre.addScaledVector(n, dev + 0.005);
        // 15% of overlap: neighbours meeting exactly leave a seam the width of
        // a rounding error, and a wheel probe that lands in one reports a
        // two-and-a-half metre drop.
        const halfAcross = across.length() * 0.5 * 1.15;
        const halfAlong = along.length() * 0.5 * 1.15;
        this._slab(centre, n, along, halfAcross, halfAlong, 1.8);
        count += 1;
      }
    }
    this._trackColliders = count;
    console.info(`[RaceWorld] road collision: ${count} solid slabs at the true surface`);
  }

  /** Road surface point at sample `i`, lateral offset `lat`. */
  _roadPoint(i, lat, w, out) {
    const co = this.course;
    return out.set(
      co.x[i] + co.rx[i] * lat,
      co.y[i] + co.bank[i] * clamp(lat, -w, w),
      co.z[i] + co.rz[i] * lat
    );
  }

  /* ------------------------------------------------------------------ */
  /* Barriers                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * A continuous concrete barrier on both sides of the whole circuit, striped
   * on top, with catch fencing where there are people behind it and tyre stacks
   * on the outside of the quick corners.
   *
   * Both sides, all the way round, deliberately. The brief asks for something
   * that keeps ten cars roughly on course; run-off alone does that for a
   * competent driver and does nothing at all for one who has spun, and an AI
   * pack that can leave the circuit is an AI pack that has to be rescued. It
   * is set 11 m back from the tarmac, so it is a backstop rather than a
   * corridor - going off is a mistake, not a crash.
   */
  _buildBarriers() {
    const co = this.course;
    const N = co.count;
    const rnd = this.rnd;
    const wallStrips = [];
    const fenceStrips = [];
    for (const s of [-1, 1]) {
      wallStrips.push({ s, lat: new Lattice(6), flip: s > 0 });
      fenceStrips.push({ s, lat: new Lattice(2), rows: 0 });
    }
    const row = [];
    for (let c = 0; c < 6; c++) row.push({ x: 0, y: 0, z: 0, u: 0, r: 1, g: 1, b: 1 });

    const tileW = TILE_METRES('concrete.wall');
    const tileF = TILE_METRES('fence.chain');
    // Where there are spectators: the main straight, the city, and the two
    // grandstand corners. Fencing everywhere would be alpha-tested fill across
    // the whole frame for scenery nobody is standing behind.
    const fenced = (i) => {
      const x = co.x[i];
      const z = co.z[i];
      return z > 150 || (x < -120 && z > -10) || (x > 150 && z > 60);
    };

    for (let i = 0; i < N; i++) {
      const w = co.w[i];
      const W = co.W[i];
      const s = i * co.step;
      // Stripe blocks every ~6 m, in the national racing colours of nowhere in
      // particular. It is a rhythm along the barrier, which is what tells the
      // eye how fast it is going past.
      const on = Math.floor(s / 6) % 2 === 0;
      for (const st of wallStrips) {
        const li = st.s * (W - 0.86);
        const lo = st.s * (W - 0.42);
        const yb = co.y[i] + co.bank[i] * clamp(li, -w, w);
        // Inner face, striped top band, cap, outer face. The shade column is
        // baked contact darkening at the foot - a barrier that meets the
        // ground with no shadow line floats above it.
        const prof = [
          [li, -0.35, 0.70],
          [li, 0.74, 0.94],
          [li, 1.00, 1.0],
          [lo, 1.04, 1.0],
          [lo, 0.74, 0.92],
          [lo, -0.35, 0.68],
        ];
        for (let c = 0; c < 6; c++) {
          const lat = prof[c][0];
          const v = row[c];
          v.x = co.x[i] + co.rx[i] * lat;
          v.y = yb + prof[c][1];
          v.z = co.z[i] + co.rz[i] * lat;
          v.u = (prof[c][1] + Math.abs(lat)) / tileW;
          const stripe = c >= 2 && c <= 3 && on;
          const sh = prof[c][2];
          _color.set(stripe ? 0xd8453a : 0xf4f4f2);
          v.r = _color.r * sh;
          v.g = _color.g * sh;
          v.b = _color.b * sh;
        }
        st.lat.addRow(row, s / tileW);
      }

      if (fenced(i)) {
        for (const st of fenceStrips) {
          const li = st.s * (W - 0.55);
          const yb = co.y[i] + co.bank[i] * clamp(li, -w, w);
          for (let c = 0; c < 2; c++) {
            const v = row[c];
            v.x = co.x[i] + co.rx[i] * li;
            v.y = yb + (c === 0 ? 1.02 : 4.0);
            v.z = co.z[i] + co.rz[i] * li;
            v.u = c === 0 ? 0 : 3 / tileF;
            v.r = 0.82; v.g = 0.86; v.b = 0.9;
          }
          st.lat.addRow(row, s / tileF);
          st.rows++;
        }
      } else {
        // A gap has to break the strip, or the mesher stitches across it and
        // hangs a sheet of fence over the countryside.
        for (const st of fenceStrips) {
          if (st.rows > 2) this._flushFence(st);
          st.rows = 0;
          st.lat = new Lattice(2);
        }
      }
    }

    for (const st of wallStrips) {
      const g = st.lat.build(true, st.flip);
      if (!g) continue;
      const mesh = new THREE.Mesh(g, this._mat('concrete.wall'));
      mesh.name = 'race:barrier.wall';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this._owned.push(g);
    }
    for (const st of fenceStrips) if (st.rows > 2) this._flushFence(st);

    /* ---- collision: one box per 4 m per side ---------------------- */
    let count = 0;
    for (let i = 0; i < N; i += 2) {
      const j = (i + 2) % N;
      const w = co.w[i];
      const W = co.W[i];
      for (const s of [-1, 1]) {
        const lat = s * (W - 0.64);
        this._roadPoint(i, lat, w, _v1);
        this._roadPoint(j, lat, w, _v2);
        _v3.copy(_v1).add(_v2).multiplyScalar(0.5);
        _a1.copy(_v2).sub(_v1);
        const halfLen = _a1.length() * 0.5 + 0.15;
        _a1.normalize();
        _n1.set(0, 1, 0);
        // Matched to the drawn wall: cap at +1.04, foot buried. A collider
        // taller than the barrier is an invisible wall, and a barrier is
        // exactly the thing a driver expects to be able to see the top of.
        _v3.y += 0.32;
        this._orientedBox(_v3, _n1, _a1, 0.3, 0.75, halfLen);
        count++;
      }
    }
    this._barrierColliders = count;

    /* ---- tyre stacks on the outside of the fast corners ----------- */
    const B = new Batch({ ao: 0.4, sky: 0.32, grime: 0.5, span: 1.2 });
    for (let i = 0; i < N; i += 3) {
      const k = co.curv[i];
      if (Math.abs(k) < 1 / 90) continue;
      const w = co.w[i];
      const W = co.W[i];
      // Outside of the corner is opposite the direction of turn.
      const lat = -Math.sign(k) * (W - 1.25);
      this._roadPoint(i, lat, w, _v1);
      const yaw = Math.atan2(co.rx[i], co.rz[i]);
      for (let t = 0; t < 3; t++) {
        B.box('metal.iron', 1.1, 0.42, 1.1, _v1.x, _v1.y + 0.21 + t * 0.42, _v1.z,
          yaw + rnd() * 0.3, t === 2 ? 0x3a3d40 : 0x2b2e31);
      }
      // A painted band on the top tyre, so a wall of black rubber still reads.
      B.box('paint.enamel', 1.16, 0.12, 1.16, _v1.x, _v1.y + 1.32, _v1.z, yaw,
        rnd() < 0.5 ? 0xe8452c : 0xf0f0ee);
      this._orientedBox(_v1.clone().setY(_v1.y + 0.63), _n1.set(0, 1, 0),
        _a1.set(co.dx[i], 0, co.dz[i]), 0.62, 0.63, 0.62);
    }
    B.flush(this.group, (k) => this._mat(k), 'tyres');
    B.dispose();
  }

  _flushFence(st) {
    const g = st.lat.build(false);
    if (!g) return;
    const mesh = new THREE.Mesh(g, this._mat('fence.chain'));
    mesh.name = 'race:barrier.fence';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    this.group.add(mesh);
    this._owned.push(g);
  }

  /* ------------------------------------------------------------------ */
  /* City                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Two city blocks the circuit runs straight through.
   *
   * The streets are not authored: buildings are laid on a grid and any that
   * would stand on the circuit is dropped, so the road cuts its own corridor
   * through the block and the corner at Foundry always has its inside cleared
   * no matter how the spline moves. Authoring the streets to match the track
   * would only stay true until the next time a control point moved.
   */
  _buildCity() {
    const B = new Batch({ ao: 0.34, sky: 0.36, grime: 0.5, span: 4.5 });
    const G = new Batch({ ao: 0.2, sky: 0.3, grime: 0.3, span: 3 });
    const rnd = this.rnd;
    const co = this.course;
    const BLOCK = 26;
    const STREET = 10;
    const pitch = BLOCK + STREET;

    const nx = Math.max(1, Math.round((CITY.x1 - CITY.x0) / pitch));
    const nz = Math.max(1, Math.round((CITY.z1 - CITY.z0) / pitch));
    const buildings = [];

    /* Each block is either one big plot or a two-by-two of small ones.
     *
     * Scattering N random footprints inside a block and rejecting overlaps
     * sounds equivalent and is not: at these sizes almost every second draw
     * collides with the first, so the rejection test quietly reduced a
     * thirty-block district to sixteen buildings and the "city section" was a
     * road through a field. Subdividing places them by construction, and
     * mixing the two subdivisions is what gives the district a grain - a tower
     * on its own plot next to a terrace of four. */
    for (let bj = 0; bj < nz; bj++) {
      for (let bi = 0; bi < nx; bi++) {
        const bx = CITY.x0 + STREET + bi * pitch + BLOCK * 0.5;
        const bz = CITY.z0 + STREET + bj * pitch + BLOCK * 0.5;
        const sub = rnd() < 0.45 ? 1 : 2;
        const plot = BLOCK / sub;
        for (let k = 0; k < sub * sub; k++) {
          if (sub === 2 && rnd() < 0.16) continue;
          const w = plot - 3 - rnd() * 2.5;
          const d = plot - 3 - rnd() * 2.5;
          const px = bx + ((k % sub) - (sub - 1) * 0.5) * plot;
          const pz = bz + (((k / sub) | 0) - (sub - 1) * 0.5) * plot;
          const p = co.probe(px, pz);
          /* Clear of the circuit, its run-off and its barrier - and only just.
           * Two metres past the barrier is what makes a street section feel
           * like one; pushed back to a safe-looking distance the buildings stop
           * being walls of the corridor and the whole point of routing the
           * circuit through a city is lost. */
          if (p.d < p.W + 2.5 + Math.max(w, d) * 0.5) continue;
          if (px < -HALF + 14 || px > HALF - 14 || pz < -HALF + 14 || pz > HALF - 14) continue;
          // Taller toward the middle of the district.
          const mid = 1 - clamp01(Math.hypot(px + 155, pz - 70) / 150);
          // Big plots carry the towers; the small ones stay low, so the
          // skyline steps rather than bristles.
          const h = (sub === 1 ? 16 + mid * 34 : 10 + mid * 13) + rnd() * 12;
          buildings.push({ x: px, z: pz, w, d, h, y: p.h });
        }
      }
    }

    for (const b of buildings) {
      const tint = pick(rnd, CITY_WASH);
      const y0 = b.y;
      B.box('concrete.wall', b.w, b.h, b.d, b.x, y0 + b.h * 0.5, b.z, 0, tint);
      /* Sized to the parapet, not to the core. Everything hung on the facade -
       * window bands, spandrels, the roof coping - stands proud of the wall it
       * is attached to, so a collider matched to the core leaves a 40 cm ledge
       * of visible building with no collision in it, and a roof you can see
       * over but fall through. */
      const bh = b.h + 0.85;
      this.track(this.physics.addBox(b.x, y0 + bh * 0.5, b.z,
        (b.w + 0.6) * 0.5, bh * 0.5, (b.d + 0.6) * 0.5));

      /* Window bands, banded on rather than cut.
       *
       * There is no CSG here, so each floor is a glass band standing a hand's
       * width *proud* of the wall with a spandrel course proud of that again -
       * the spandrel then throws a horizontal shadow over the glass and the
       * facade reads as a curtain wall. Set inside the core instead, which is
       * the intuitive way round, the glass is simply buried and the tower comes
       * out a blank prism. Two boxes per floor against a boolean per building. */
      const floors = Math.max(2, Math.floor((b.h - 3.5) / 3.6));
      for (let f = 0; f < floors; f++) {
        const fy = y0 + 4.6 + f * 3.6;
        if (fy > y0 + b.h - 1.6) break;
        G.box('glass.window', b.w + 0.10, 1.9, b.d + 0.10, b.x, fy, b.z, 0, 0x9fc0d4);
        B.box('concrete.wall', b.w + 0.26, 0.46, b.d + 0.26, b.x, fy + 1.34, b.z, 0, 0xdcdedc);
      }
      // Parapet and roof plant, so the skyline is not a row of flat cuts.
      B.box('concrete.wall', b.w + 0.6, 0.85, b.d + 0.6, b.x, y0 + b.h + 0.4, b.z, 0, 0xcfd2d0);
      const pw = Math.min(b.w, b.d) * 0.4;
      B.box('metal.panel', pw, 1.6, pw, b.x + (rnd() - 0.5) * b.w * 0.3,
        y0 + b.h + 1.6, b.z + (rnd() - 0.5) * b.d * 0.3, rnd() * TAU, 0x9aa2a8);
      if (rnd() < 0.4) {
        B.box('metal.trim', 0.3, 4 + rnd() * 5, 0.3, b.x + b.w * 0.3, y0 + b.h + 3.5, b.z - b.d * 0.3,
          0, 0xb8bec4);
      }
      // Ground floor: a dark glazed shopfront under a canopy.
      G.box('glass.window', b.w + 0.08, 2.6, b.d + 0.08, b.x, y0 + 1.8, b.z, 0, 0x5a6a74);
      B.box('metal.panel', b.w + 0.9, 0.32, b.d + 0.9, b.x, y0 + 3.25, b.z, 0, 0x8e959a);
    }

    /* ---- pavements and street furniture ---------------------------- */
    for (const b of buildings) {
      B.box('stone.cobble', b.w + 5, 0.16, b.d + 5, b.x, b.y + 0.08, b.z, 0, 0xc8c6c0);
    }
    /* Street lights leaning out over the circuit, which is most of what makes a
     * street section read as a street rather than as a road with towers beside
     * it. Placed by probing outward from the barrier line rather than by
     * authored coordinates, so they follow the corridor wherever it goes. */
    const co2 = co;
    for (let i = 0; i < co2.count; i += Math.max(1, Math.round(26 / co2.step))) {
      const x0 = co2.x[i];
      const z0 = co2.z[i];
      if (x0 < CITY.x0 - 6 || x0 > CITY.x1 + 6 || z0 < CITY.z0 - 6 || z0 > CITY.z1 + 6) continue;
      const side = (i & 2) ? 1 : -1;
      const W = co2.W[i] + 2.4;
      const px = x0 + co2.rx[i] * side * W;
      const pz = z0 + co2.rz[i] * side * W;
      const h = co2.surfaceHeight(px, pz);
      // Column, then an arm reaching back in toward the road, then the lamp.
      const inx = -co2.rx[i] * side;
      const inz = -co2.rz[i] * side;
      const yaw = alongYaw(co2.dx[i], co2.dz[i]);
      B.box('metal.rail', 0.26, 7.4, 0.26, px, h + 3.7, pz, yaw, 0x8f979d);
      B.box('metal.rail', 3.4, 0.2, 0.2, px + inx * 1.7, h + 7.3, pz + inz * 1.7,
        acrossYaw(co2.dx[i], co2.dz[i]), 0x8f979d);
      B.box('emissive.white', 1.2, 0.18, 0.5, px + inx * 3.3, h + 7.16, pz + inz * 3.3,
        acrossYaw(co2.dx[i], co2.dz[i]));
      this.track(this.physics.addBox(px, h + 3.7, pz, 0.16, 3.7, 0.16));
    }

    B.flush(this.group, (k) => this._mat(k), 'city');
    G.flush(this.group, (k) => this._mat(k), 'city.glass', { cast: false });
    B.dispose();
    G.dispose();
    this._buildings = buildings;
  }

  /* ------------------------------------------------------------------ */
  /* Paddock                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Pit garages on the infield, a grandstand opposite, and the gantry over the
   * start/finish line.
   *
   * All of it is placed from the course frame rather than from literal
   * coordinates, so it stays attached to the start line if the spline ever
   * moves - the mistake CitadelWorld made by hand-authoring NPC positions into
   * a generated town and then finding them inside walls twice.
   */
  _buildPaddock() {
    const B = new Batch({ ao: 0.36, sky: 0.34, grime: 0.45, span: 3.5 });
    const co = this.course;
    const rnd = this.rnd;
    const W = co.W[0];

    /* ---- pit lane and garages, infield side (negative lat) ---- */
    const wrap = (s) => ((s % co.length) + co.length) % co.length;
    for (let k = -7; k <= 8; k++) {
      const g = co.pointAt(wrap(k * 11), -(W + 14));
      const yaw = alongYaw(g.dx, g.dz);
      // Toward the circuit is +lat, which is the right-hand normal.
      const tx = -g.dz;
      const tz = g.dx;
      B.box('concrete.wall', 10.4, 5.4, 9, g.x, g.y + 2.7, g.z, yaw, 0xe6e6e2);
      this.track(this.physics.addRotatedBox(
        _v1.set(g.x, g.y + 2.7, g.z), _v2.set(5.2, 2.7, 4.5), yaw));
      // Roller door, facing the pit lane.
      B.box('metal.panel', 7.4, 3.9, 0.3, g.x + tx * 4.6, g.y + 1.95, g.z + tz * 4.6, yaw,
        pick(rnd, [0x3f6fa8, 0xb8452f, 0x2f8a5a, 0xd0a02a, 0x7a4a9a]));
      B.box('metal.trim', 10.8, 0.5, 9.6, g.x, g.y + 5.6, g.z, yaw, 0xb6bcc0);
      // Upper hospitality deck with a glazed front.
      B.box('concrete.wall', 10.4, 3.2, 8, g.x, g.y + 7.5, g.z, yaw, 0xdedfdc);
      B.box('glass.window', 9.6, 2.0, 0.3, g.x + tx * 4.1, g.y + 7.7, g.z + tz * 4.1, yaw, 0x9fc4d8);
      B.box('metal.panel', 11.4, 0.35, 9.2, g.x, g.y + 9.3, g.z, yaw, 0xa8b0b6);
    }
    // Pit wall.
    for (let k = -7; k <= 8; k++) {
      const g = co.pointAt(wrap(k * 11), -(W + 2.4));
      const yaw = alongYaw(g.dx, g.dz);
      B.box('concrete.wall', 11, 1.1, 0.5, g.x, g.y + 0.55, g.z, yaw, 0xf0f0ee);
      this.track(this.physics.addRotatedBox(
        _v1.set(g.x, g.y + 0.55, g.z), _v2.set(5.5, 0.55, 0.3), yaw));
    }

    /* ---- grandstand, outside the straight ---- */
    const crowd = [];
    for (let k = -6; k <= 8; k++) {
      const base = co.pointAt(wrap(k * 13), W + 3);
      const yaw = alongYaw(base.dx, base.dz);
      // Terraces step *away* from the circuit, which is +lat on this side.
      const ox = -base.dz;
      const oz = base.dx;
      // Terraces stepping back and up: 9 rows of seats on a raked deck.
      for (let r = 0; r < 9; r++) {
        const off = 4 + r * 1.5;
        const y = base.y + 1.2 + r * 1.05;
        const px = base.x + ox * off;
        const pz = base.z + oz * off;
        B.box('concrete.skatepark', 12.6, 1.05, 1.6, px, y - 0.52, pz, yaw, 0xd8d8d4);
        B.box('paint.enamel', 12.2, 0.42, 0.5, px, y + 0.2, pz, yaw,
          r % 2 ? 0x2f5f9a : 0xc8ccd0);
        for (let c = 0; c < 7; c++) {
          if (rnd() < 0.34) continue;
          const lx = (c / 6 - 0.5) * 11;
          crowd.push({
            x: px + Math.cos(yaw) * lx,
            y: y + 0.42,
            z: pz - Math.sin(yaw) * lx,
            yaw: yaw + (rnd() - 0.5) * 0.5,
            c: rnd(),
          });
        }
      }
      // Roof on posts.
      const rx = base.x + ox * 12;
      const rz = base.z + oz * 12;
      B.box('metal.panel', 13, 0.4, 14, rx - ox * 3, base.y + 11.6, rz - oz * 3, yaw, 0xb0b6ba);
      for (const sgn of [-1, 1]) {
        B.box('metal.rail', 0.4, 11.5, 0.4,
          rx + Math.cos(yaw) * sgn * 6, base.y + 5.8, rz - Math.sin(yaw) * sgn * 6, yaw, 0x99a1a6);
      }
      // The raked deck, and the roof over it - the roof gets its own collider
      // because it is 13 m across and the deck box does not reach it.
      this.track(this.physics.addRotatedBox(
        _v1.set(base.x + ox * 10, base.y + 5.0, base.z + oz * 10),
        _v2.set(6.4, 5.0, 7.0), yaw));
      this.track(this.physics.addRotatedBox(
        _v1.set(rx - ox * 3, base.y + 11.6, rz - oz * 3),
        _v2.set(6.5, 0.2, 7), yaw));
    }
    this._spawnCrowd(crowd);

    /* ---- start/finish gantry ---- */
    {
      const g = co.pointAt(0, 0);
      const yaw = acrossYaw(g.dx, g.dz);
      const wHalf = co.W[0] - 1.5;
      for (const sgn of [-1, 1]) {
        const px = g.x + co.rx[0] * sgn * wHalf;
        const pz = g.z + co.rz[0] * sgn * wHalf;
        B.box('metal.hull', 1.5, 9.6, 1.5, px, g.y + 4.8, pz, yaw, 0xc4c8cc);
        this.track(this.physics.addRotatedBox(
          _v1.set(px, g.y + 4.8, pz), _v2.set(0.75, 4.8, 0.75), yaw));
      }
      B.box('metal.hull', wHalf * 2 + 1.5, 2.2, 1.9, g.x, g.y + 10.6, g.z, yaw, 0xd4d8dc);
      B.box('metal.trim', wHalf * 2 + 2.4, 0.5, 2.4, g.x, g.y + 11.9, g.z, yaw, 0xa8b0b6);
      // Light panel: five columns of start lights, facing *back* down the
      // straight, because that is where the grid is.
      const fx = -g.dx;
      const fz = -g.dz;
      for (let c = 0; c < 5; c++) {
        const lx = (c / 4 - 0.5) * 9;
        for (let r = 0; r < 2; r++) {
          B.box('emissive.red', 0.7, 0.7, 0.25,
            g.x + Math.cos(yaw) * lx + fx * 1.05,
            g.y + 10.9 - r * 0.85,
            g.z - Math.sin(yaw) * lx + fz * 1.05, yaw);
        }
      }
      // Banner across the front of the gantry.
      B.box('paint.enamel', wHalf * 2 - 4, 1.5, 0.2, g.x + fx * 1.0, g.y + 9.4, g.z + fz * 1.0,
        yaw, 0x1d3a66);
    }

    /* ---- start/finish line and grid boxes ---- */
    {
      // The line: a checker band across the tarmac, painted on rather than
      // extruded so it lies exactly on the surface it belongs to.
      const nCol = 26;
      for (let c = 0; c < nCol; c++) {
        const lat = lerp(-co.w[0], co.w[0], (c + 0.5) / nCol);
        const g = co.pointAt(0, lat);
        const yaw = acrossYaw(g.dx, g.dz);
        for (let r = 0; r < 2; r++) {
          const s = (r - 0.5) * 0.85;
          B.box('paint.white', (co.w[0] * 2) / nCol, 0.05, 0.85,
            g.x - g.dx * s, g.y + 0.03, g.z - g.dz * s, yaw,
            (c + r) % 2 ? 0x16191c : 0xf6f6f4);
        }
      }
    }

    B.flush(this.group, (k) => this._mat(k), 'paddock');
    B.dispose();
  }

  /**
   * Spectators, instanced.
   *
   * Two draw calls for the whole grandstand. They do not move and never will:
   * at this distance a silhouette with the right proportions and a different
   * shirt is everything the eye reads, and animating twelve hundred of them
   * would cost real frame time for something nobody looks at twice.
   */
  _spawnCrowd(list) {
    if (!list.length) return;
    const body = sweep([
      { y: 0, z: 0, rx: 0.20, ry: 0.13 },
      { y: 0.42, z: 0, rx: 0.24, ry: 0.16 },
      { y: 0.78, z: 0, rx: 0.20, ry: 0.14 },
      { y: 0.94, z: 0, rx: 0.11, ry: 0.09 },
    ], 8);
    const head = blob(0.12, 0.14, 0.12, 0, 1.08, 0, 8);
    // `sweep` already returns non-indexed and `blob` does not; asking either
    // for a conversion it does not need logs a warning per build.
    const nonIdx = (g) => (g.index ? g.toNonIndexed() : g);
    const geo = mergeGeometries([nonIdx(body), nonIdx(head)], false);
    body.dispose();
    head.dispose();
    const mat = this._mat('paint.enamel', { vertexColors: false });
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    mesh.name = 'race:crowd';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    const SHIRTS = [0xd0453a, 0x3f6fa8, 0xe8c34a, 0x4a9a5a, 0xdcdcd8, 0x8a4a9a, 0xe08a3a, 0x2a3540];
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      _e1.set(0, p.yaw, 0);
      _q1.setFromEuler(_e1);
      _v1.set(p.x, p.y, p.z);
      _v2.setScalar(0.9 + p.c * 0.25);
      _m1.compose(_v1, _q1, _v2);
      mesh.setMatrixAt(i, _m1);
      mesh.setColorAt(i, _color.set(SHIRTS[(p.c * SHIRTS.length) | 0]));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.group.add(mesh);
    this._owned.push(geo);
  }

  /* ------------------------------------------------------------------ */
  /* Scenery                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Conifers, rock outcrops, marshal posts and trackside boards.
   *
   * The circuit was structurally finished long before it was anywhere: from the
   * ridge the hills read as a hundred hectares of green, because everything
   * built to that point was either road or barrier. None of this is raced past
   * at any speed that lets it be examined - it exists so the middle distance
   * has something in it, which is the difference between a track and a place.
   */
  _buildScenery() {
    const rnd = this.rnd;
    const co = this.course;

    /* ---- one conifer, instanced ---- */
    const trunkSecs = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      trunkSecs.push({
        x: Math.sin(t * 1.1) * 0.14 * t,
        y: t * 9.5,
        z: Math.cos(t * 1.7) * 0.08 * t,
        rx: 0.34 - t * 0.24 + Math.exp(-t * 8) * 0.1,
        ry: 0.34 - t * 0.24 + Math.exp(-t * 8) * 0.1,
      });
    }
    const trunk = sweep(trunkSecs, 8, { capStart: false });
    // Four overlapping skirts, each widest at its own base. A single cone is a
    // party hat; the tiers are what make the silhouette read as a conifer.
    const tiers = [];
    for (let t = 0; t < 4; t++) {
      const y0 = 1.8 + t * 2.1;
      const r = 3.1 - t * 0.62;
      const secs = [];
      for (let i = 0; i <= 5; i++) {
        const u = i / 5;
        secs.push({
          y: y0 + u * 3.4,
          z: 0,
          rx: Math.max(0.05, r * (1 - u) * (1 - u * 0.2)),
          ry: Math.max(0.05, r * (1 - u) * (1 - u * 0.2)),
        });
      }
      tiers.push(sweep(secs, 9));
    }
    const canopy = mergeGeometries(tiers.map((g) => (g.index ? g.toNonIndexed() : g)), false);
    for (const g of tiers) g.dispose();

    const trees = [];
    for (let i = 0; i < 700; i++) {
      const x = -HALF + rnd() * HALF * 2;
      const z = -HALF + rnd() * HALF * 2;
      if (x > CITY.x0 - 12 && x < CITY.x1 + 12 && z > CITY.z0 - 12 && z < CITY.z1 + 12) continue;
      const p = co.probe(x, z);
      if (p.d < p.W + 9) continue;
      // Nothing on the steepest rock, and nothing on the paddock apron.
      const g0 = baseTerrain(x + 2, z) - baseTerrain(x - 2, z);
      const g1 = baseTerrain(x, z + 2) - baseTerrain(x, z - 2);
      if (Math.hypot(g0, g1) / 4 > 0.55) continue;
      if (Math.abs(z - 185) < 40 && x > -80) continue;
      trees.push({ x, y: p.h, z, k: 0.7 + rnd() * 0.75, yaw: rnd() * TAU });
    }
    this._instance(trunk, 'bark.palm', trees, 'race:tree.trunk', 0x9a7a52);
    // Crowns cast but do not receive: self-shadowing a mass of thin needles
    // costs a shadow lookup per tier and returns acne rather than shade.
    this._instance(canopy, 'foliage.frond', trees, 'race:tree.crown', 0x4e7a3c, true, false);
    for (const t of trees) {
      if (rnd() < 0.35) {
        this.track(this.physics.addBox(t.x, t.y + 3 * t.k, t.z, 0.3 * t.k, 3 * t.k, 0.3 * t.k));
      }
    }

    /* ---- rock outcrops ---- */
    const rockGeos = [];
    for (let v = 0; v < 3; v++) {
      const g = new THREE.IcosahedronGeometry(1, 2);
      const p = g.attributes.position;
      /* Displaced by a smooth function of the vertex *direction*, not by a
       * fresh random number per vertex.
       *
       * `IcosahedronGeometry` is non-indexed, so every triangle carries its own
       * copy of each corner. Jittering them independently pulls those copies
       * apart and the rock comes out as a heap of disconnected shards - which
       * is exactly what the first pass rendered. A function of direction gives
       * every copy of a corner the same answer, so the surface stays closed. */
      const a = 2.3 + v * 1.7;
      const b = 3.1 + v * 0.9;
      const c = 4.3 - v * 0.8;
      for (let i = 0; i < p.count; i++) {
        _v1.set(p.getX(i), p.getY(i), p.getZ(i)).normalize();
        const r = 1
          + 0.26 * Math.sin(a * _v1.x + 1.3) * Math.cos(b * _v1.z - 0.7)
          + 0.17 * Math.sin(c * _v1.y + 2.1)
          + 0.09 * Math.cos((a + b) * _v1.x * _v1.z);
        p.setXYZ(i, _v1.x * r * 1.3, _v1.y * r * 0.66, _v1.z * r * 1.15);
      }
      g.computeVertexNormals();
      rockGeos.push(g);
    }
    const rocks = [[], [], []];
    for (let i = 0; i < 260; i++) {
      const x = -HALF + rnd() * HALF * 2;
      const z = -HALF + rnd() * HALF * 2;
      const p = co.probe(x, z);
      if (p.d < p.W + 7) continue;
      if (x > CITY.x0 - 8 && x < CITY.x1 + 8 && z > CITY.z0 - 8 && z < CITY.z1 + 8) continue;
      const k = 1.1 + rnd() * 3.4;
      rocks[(rnd() * 3) | 0].push({ x, y: p.h - k * 0.3, z, k, yaw: rnd() * TAU });
    }
    for (let v = 0; v < 3; v++) {
      this._instance(rockGeos[v], 'concrete.wall', rocks[v], `race:rock${v}`, 0x9a958a);
      for (const r of rocks[v]) {
        if (r.k > 2.2) {
          this.track(this.physics.addBox(r.x, r.y + r.k * 0.3, r.z, r.k * 1.1, r.k * 0.5, r.k));
        }
      }
    }

    /* ---- marshal posts and sponsor boards ---- */
    const B = new Batch({ ao: 0.34, sky: 0.32, grime: 0.4, span: 2.4 });
    const N = co.count;
    const postEvery = Math.max(1, Math.round(150 / co.step));
    for (let i = 0; i < N; i += postEvery) {
      const w = co.w[i];
      const W = co.W[i];
      const lat = (i / postEvery) % 2 === 0 ? -(W + 3.5) : W + 3.5;
      this._roadPoint(i, lat, w, _v1);
      const yaw = Math.atan2(co.rx[i], co.rz[i]);
      B.box('metal.panel', 3.2, 2.6, 2.6, _v1.x, _v1.y + 1.3, _v1.z, yaw, 0xe8e4d8);
      B.box('metal.trim', 3.6, 0.3, 3.0, _v1.x, _v1.y + 2.75, _v1.z, yaw, 0xb0b6ba);
      B.box('hazard.stripe', 3.3, 0.5, 0.2, _v1.x, _v1.y + 2.3, _v1.z, yaw, 0xffdd44);
      this.track(this.physics.addRotatedBox(
        _v2.set(_v1.x, _v1.y + 1.3, _v1.z), _v3.set(1.6, 1.3, 1.3), yaw));
    }
    // Sponsor boards stood against the outside of the barrier.
    const BOARDS = [0xd0362c, 0x1f4f9c, 0xe8b52a, 0x2f8a5a, 0xf0f0ee, 0x8a3a9a];
    for (let i = 0; i < N; i += 5) {
      const w = co.w[i];
      const W = co.W[i];
      const k = co.curv[i];
      const lat = -Math.sign(k || 1) * (W - 0.2);
      if (Math.abs(k) < 1 / 200 && (i % 20)) continue;
      this._roadPoint(i, lat, w, _v1);
      const yaw = Math.atan2(co.rx[i], co.rz[i]);
      B.box('paint.enamel', 10.2, 1.0, 0.14, _v1.x, _v1.y + 1.55, _v1.z, yaw,
        BOARDS[(i / 5 | 0) % BOARDS.length]);
    }
    B.flush(this.group, (k) => this._mat(k), 'trackside');
    B.dispose();
  }

  /** One InstancedMesh from a prototype geometry and a placement list. */
  _instance(geo, key, list, name, tint = 0xffffff, cast = true, recv = true) {
    if (!list.length) return null;
    const mat = this._mat(key, { vertexColors: false }).clone();
    mat.color = new THREE.Color(tint);
    this._owned.push(mat);
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    mesh.name = name;
    mesh.castShadow = cast;
    mesh.receiveShadow = recv;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      _e1.set(0, p.yaw, 0);
      _q1.setFromEuler(_e1);
      _v1.set(p.x, p.y, p.z);
      _v2.setScalar(p.k);
      _m1.compose(_v1, _q1, _v2);
      mesh.setMatrixAt(i, _m1);
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
    this._owned.push(geo);
    return mesh;
  }

  /* ------------------------------------------------------------------ */
  /* The published contract                                              */
  /* ------------------------------------------------------------------ */

  _fillSpawns() {
    const co = this.course;
    const N = co.count;

    /* ---- centreline, decimated to ~6 m ---- */
    const stride = Math.max(1, Math.round(6 / co.step));
    for (let i = 0; i < N; i += stride) {
      this.trackPath.push({ x: co.x[i], y: co.y[i], z: co.z[i], width: co.w[i] });
    }

    /* ---- checkpoints, evenly spaced by arc length ---- */
    const CP = 18;
    for (let k = 0; k < CP; k++) {
      const i = co.indexAt((k / CP) * co.length);
      this.checkpoints.push({
        x: co.x[i], y: co.y[i], z: co.z[i],
        /* A little wider than the tarmac, and no wider.
         *
         * Sized to the whole sealed surface it reached 26 m on an 11 m road,
         * which validates a lap taken entirely down the gravel trap. Sized to
         * the tarmac plus three metres, a car has to have been on or beside the
         * road - and since the order still has to be right, running wide at one
         * corner costs nothing. */
        radius: co.w[i] + 3,
      });
    }

    /* ---- start grid: five rows of two, staggered ---- */
    for (let k = 0; k < 10; k++) {
      const rowIdx = k >> 1;
      const col = k & 1;
      // Behind the line, and behind the gantry legs.
      const s = co.length - (16 + rowIdx * 9 + col * 4.5);
      const lat = col === 0 ? -4.8 : 4.8;
      const g = co.pointAt(s % co.length, lat);
      this.startGrid.push({
        x: g.x, y: g.y, z: g.z,
        // Characters and mounts look down -Z at yaw 0.
        yaw: Math.atan2(-g.dx, -g.dz),
      });
    }
    // Painted boxes under each slot.
    const B = new Batch({ ao: 0.2, sky: 0.2, grime: 0.2, span: 1 });
    for (const slot of this.startGrid) {
      for (const [ox, oz, w, d] of [[0, -2.6, 3.6, 0.22], [0, 2.6, 3.6, 0.22],
        [-1.8, 0, 0.22, 5.4], [1.8, 0, 0.22, 5.4]]) {
        const cs = Math.cos(slot.yaw);
        const sn = Math.sin(slot.yaw);
        B.box('paint.white', w, 0.05, d,
          slot.x + cs * ox + sn * oz, slot.y + 0.03, slot.z - sn * ox + cs * oz,
          slot.yaw, 0xf4f4f2);
      }
    }
    B.flush(this.group, (k) => this._mat(k), 'grid');
    B.dispose();

    /* ---- player spawn, portal, NPCs ---- */
    const W = co.W[0];
    const paddock = co.pointAt(co.length - 40, -(W + 30));
    this.playerSpawn.set(paddock.x, paddock.y + 0.3, paddock.z);
    // Facing the circuit: the paddock is on the driver's left, so looking back
    // across it means looking along +lat, which is +Z on this straight.
    this.playerSpawnYaw = Math.PI;

    const portal = co.pointAt(co.length - 40, -(W + 40));
    this.portalSpecs.push({
      position: new THREE.Vector3(portal.x, portal.y + 0.3, portal.z),
      rotationY: 0,
      target: 'station',
      label: 'Aether Station',
      accent: 0x4de3ff,
    });

    const F = (name, persona, s, lat) => {
      const g = co.pointAt(((s % co.length) + co.length) % co.length, lat);
      return {
        position: new THREE.Vector3(g.x, g.y + 0.2, g.z),
        type: 'friendly',
        name,
        persona,
      };
    };
    this.npcSpawns.push(
      F('Marek Vaisey', 'Chief scrutineer at Vellum Ridge; has timed every lap run here for thirty years.', co.length - 60, -(W + 20)),
      F('Ines Okonjo', 'Runs the tyre bay in garage four; reads a set of worn fronts like a paragraph.', co.length - 20, -(W + 22)),
      F('Devrim Aslan', 'Track marshal, ridge sector; knows exactly where the circuit bites.', co.length * 0.42, -(W + 6)),
      F('Halla Brandt', 'Timekeeper in the gantry; speaks in tenths and does not exaggerate.', 30, W + 8)
    );

    /* ---- minimap ----
     *
     * Deliberately no circuit outline here. `minimapShapes` is rasterised once
     * into a baked floorplan, and the race systems draw `trackPath` live on top
     * of it - so baking the same loop underneath would double-stroke it, at two
     * slightly different widths, for the whole race. What is baked is only what
     * nothing else draws: the ground, the city block and the start line. */
    this.minimapShapes.push(
      { kind: 'rect', x: 0, z: 0, w: HALF * 2, d: HALF * 2, fill: 0x2d3a26 },
      {
        kind: 'rect',
        x: (CITY.x0 + CITY.x1) * 0.5, z: (CITY.z0 + CITY.z1) * 0.5,
        w: CITY.x1 - CITY.x0, d: CITY.z1 - CITY.z0, fill: 0x3a3f42,
      }
    );
    for (const b of this._buildings ?? []) {
      this.minimapShapes.push({ kind: 'rect', x: b.x, z: b.z, w: b.w, d: b.d, fill: 0x5b6167 });
    }
    this.minimapShapes.push(
      { kind: 'circle', x: co.x[0], z: co.z[0], r: 7, fill: 0xf0f0ee }
    );

    console.info(
      `[RaceWorld] ${this.trackPath.length} path samples, ${this.checkpoints.length} checkpoints, ` +
      `${this.startGrid.length} grid slots, colliders: ${this._terrainColliders} terrain / ` +
      `${this._trackColliders} track / ${this._barrierColliders} barrier`
    );
  }

  /* ------------------------------------------------------------------ */
  /* Public helpers for the race systems                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Where a world position sits relative to the circuit. Handed to the race
   * systems so an AI racer, a lap validator or a "you are going the wrong way"
   * check never has to re-derive the centreline from `trackPath` and get a
   * slightly different answer than the geometry was built from.
   *
   * @returns {null | { index:number, distance:number, lateral:number,
   *                    width:number, surface:number, arcLength:number }}
   */
  trackNearest(x, z) {
    const nr = this.course?.nearest(x, z);
    if (!nr) return null;
    return {
      index: nr.i,
      distance: nr.d,
      lateral: nr.lat,
      width: nr.w,
      surface: this.course.crossFall(nr),
      arcLength: nr.s,
    };
  }

  /** Ground height from the same function every collider was built from. */
  surfaceAt(x, z) {
    return this.course ? this.course.surfaceHeight(x, z) : 0;
  }

  /* ------------------------------------------------------------------ */
  /* Frame                                                               */
  /* ------------------------------------------------------------------ */

  update(dt) {
    this._time += dt;
  }

  dispose() {
    for (const g of this._owned) g.dispose?.();
    this._owned.length = 0;
    this.trackPath.length = 0;
    this.startGrid.length = 0;
    this.checkpoints.length = 0;
    this._matCache?.clear();
    this.course = null;
    super.dispose();
  }
}

export default RaceWorld;
