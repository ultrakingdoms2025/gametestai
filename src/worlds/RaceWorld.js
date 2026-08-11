import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { sweep, blob } from '../gfx/Organic.js';
import { World } from './World.js';
import { DistanceLod, SURFACE } from './lod/DistanceLod.js';
import { Collider } from '../physics/Physics.js';
import {
  RaceCourse, Lattice, slabMatrix, mulberry32,
  clamp, clamp01, lerp, smoothstep, TAU,
} from './RaceTrack.js';
import {
  HALF, SEG, QUAD, CITY, CIRCUITS, CourseSet, baseTerrain, worldControls, circuitById,
} from './RaceCircuits.js';

/**
 * RACE - three circuits on one 1.3 km map.
 *
 * "Vellum Ridge" is the 2 km original: it climbs out of a coastal plain, runs a
 * ridge line through open hill country, drops back down and threads a city
 * block on its way to the start/finish straight. "Cinder Gorge" is a tight
 * quarry circuit in the south-west with two chicanes and a hairpin; "Aurora
 * Rise" is a highland circuit in the north-east with a vertical loop on it.
 * All three are generous in the Mario-Kart sense - 16 to 23 m of tarmac, wide
 * run-off, barriers everywhere - but built and lit like the rest of this game
 * rather than as a cartoon.
 *
 * The circuits themselves are data: see RaceCircuits.js, which also holds the
 * rules an author has to obey to add another. Everything in this file builds
 * whatever it is handed.
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
 * ── Vellum Ridge, in racing order ─────────────────────────────────────────
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
 *
 * ── One world, three contracts ────────────────────────────────────────────
 *
 * `trackPath` / `checkpoints` / `startGrid` are the contract RaceManager reads,
 * and it reads exactly one circuit's worth. Each circuit therefore builds its
 * own set into a record of its own and {@link RaceWorld#selectTrack} points the
 * published fields at whichever is selected. Nothing is rebuilt when the player
 * changes track: all three roads are standing in the world at once, because
 * they are 500 m apart and you can drive between them.
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

/* ------------------------------------------------------------------ */
/* Distance LOD                                                        */
/* ------------------------------------------------------------------ */

/**
 * Distance past which a scenery tile swaps to its cheap geometry, metres,
 * measured to the NEAREST POINT of the tile's bounding sphere.
 *
 * The measure is what makes one number defensible for 2 400 trees at once.
 * `_instance` splits scenery into 300 m tiles (see its docstring - that split
 * is what gives the frustum culler something to reject, and none of it is
 * touched here), so a tile's sphere has a ~195 m radius and "surface distance
 * past 170" means *every* tree in that tile is at least 170 m away and the
 * median one is past 350. The quoted distance is therefore a floor, not an
 * average.
 *
 * 170 m rather than something braver because that floor is what has to survive
 * inspection. A 9.5 m conifer at 170 m is ~85 px tall in a 720 p frame and its
 * widest skirt is ~26 px across; the swap turns that skirt from a 9-sided
 * sweep into a 5-sided one, so a facet goes from ~9 px to ~16 px of silhouette
 * arc. Measured by A/B screenshot at 120/170/240 m - see the ladder in the
 * commit message - 120 m is where the pentagonal skirt starts to read on the
 * nearest tree in a demoted tile and 170 m is comfortably clear of it.
 *
 * Unlike Medieval's quadrant buckets, these tiles are small relative to their
 * map: 300 m tiles on a 1 320 m playfield with 760 m of fog means a vantage
 * sees tiles at every distance from underfoot to a kilometre, and 75-96% of
 * the crown triangles in frustum sit past this line at five of the six
 * framings. The exception is cinder-gorge, where the four visible tiles are
 * all within 89 m and nothing demotes at all - correctly, since the gorge is
 * a close-quarters framing with the trees right beside the road.
 */
const CONIFER_LO_DISTANCE = 170;

/**
 * Same, for rock outcrops.
 *
 * Further out than the trees, which is the opposite of what the face counts
 * suggest and is the result of measuring instead of assuming. A rock goes from
 * a 180-face icosphere to an 80-face one - a 21 degree face against a 32
 * degree one, both apparently inside the bandwidth of a displacement whose
 * shortest feature is ~60 degrees. Cast 4 096 rays at the pair, though, and
 * the two surfaces differ by up to 22% of the local radius (mean absolute 4%,
 * mean signed -0.6% to -3%): the deviation is two-sided, so there is no scale
 * factor that fixes it the way {@link CONIFER_LO_INFLATE} fixes the crown, and
 * the only lever left is distance.
 *
 * 200 m puts the widest rock in the world (an 11.7 m boulder) at 32 px and its
 * worst-case outline wobble at 2 px, with the median rock nearer 12 px. The
 * band is doing less work than the trees' - rocks are 5-8% of the world's
 * triangles against the trees' 55% - so buying the margin costs little.
 */
const ROCK_LO_DISTANCE = 200;

/**
 * Radius multiplier for the cheap conifer skirt.
 *
 * A lower-tessellation ring inscribed in the same circle casts a narrower
 * silhouette, so a naive swap shrinks every crown in the far field at exactly
 * the distance where the outline is all there is to see - the "treeline
 * quietly recedes" artefact that makes an LOD visible. This is the correction.
 *
 * It is 1.1%, not the 6.7% the obvious arithmetic gives, and the difference is
 * worth spelling out because getting it wrong is an artefact in the other
 * direction. The silhouette half width of a ring of N vertices seen from yaw
 * `t` is `r * max_k |sin(2*pi*k/N - t)|`, and |sin| has period pi - so when N
 * is ODD the N vertices fold onto 2N directions spaced pi/N apart, not N
 * spaced 2pi/N. Both 9 and 5 are odd. The worst yaw therefore misses a vertex
 * by 10 degrees at N = 9 (0.985 r) and by 18 degrees at N = 5 (0.951 r), and
 * the ratio of the yaw-averaged widths is 0.989, not the 0.905/0.970 an even-N
 * reading of the same formula predicts.
 *
 * Measured rather than trusted: over 72 yaws the cheap crown at this
 * multiplier is 3.0% narrower to 2.6% wider than the expensive one, mean
 * +0.0%. At 1.07 it was 2.7% to 8.6% wider at every yaw - a treeline that
 * visibly THICKENS as it demotes, which is the same tell as one that thins.
 *
 * Not applied to the trunk. Its correction would be a fifth of a pixel on a
 * ~2 px silhouette at {@link CONIFER_LO_DISTANCE}, and the trunk spends all
 * but its bottom 1.8 m inside the skirts, where widening it can only push it
 * through them.
 */
const CONIFER_LO_INFLATE = 1.011;

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

/* ================================================================== */

export class RaceWorld extends World {
  static id = 'race';
  /* The *place*, not a circuit.
   *
   * This used to be "Vellum Ridge Circuit", which was the same thing when there
   * was one circuit on it. With three, the HUD anchor read "VELLUM RIDGE
   * CIRCUIT" while the player stood on the grid at Aurora Rise with the prompt
   * under it saying so - two names for where you are, on screen at once. The
   * world is the estate; the circuits on it have their own names, and the race
   * UI is what shows them. */
  static displayName = 'Vellum Ridge';

  constructor(ctx) {
    super(ctx);
    this.rnd = mulberry32(0x9a17ce);

    /* ---- the published contract; see the class header ---- *
     * These point at the *selected* circuit's arrays. `selectTrack` repoints
     * them; nothing copies, so a race is always driving the same objects the
     * geometry was built from. */
    /** @type {Array<{x:number,y:number,z:number,width:number}>} */
    this.trackPath = [];
    /** @type {Array<{x:number,y:number,z:number,yaw:number}>} */
    this.startGrid = [];
    /** @type {Array<{x:number,y:number,z:number,radius:number}>} */
    this.checkpoints = [];
    this.lapCount = 3;

    /* ---- the circuits ---- */
    /** Built records, one per entry in CIRCUITS. @type {Array<object>} */
    this.circuits = [];
    /** What the picker shows. @type {Array<{id:string,name:string,kicker:string,blurb:string,length:number,corners:number,hasLoop:boolean,accent:number}>} */
    this.tracks = [];
    /** @type {string} */
    this.activeTrackId = CIRCUITS[0].id;
    /** Every circuit's course, presented as one height function. */
    this.courseSet = null;
    /* Every loop in the world, not just the selected circuit's.
     *
     * Published flat, and read by the race systems whatever is armed, because a
     * loop is part of the *road*: driving up to one with no race running has to
     * take you round it, or the ramp is scenery a car passes through. */
    /** @type {Array<object>} */
    this.loops = [];
    /* Difficulty changes the circuit, not just the opposition.
     *
     * A world is generated once and never rebuilt, so for a while the three
     * names only selected an AI performance band - the track itself was
     * identical and the difficulty of the *track* was, honestly, advertised
     * rather than delivered.
     *
     * Rebuilding six seconds of geometry every time someone changes a dropdown
     * is the wrong answer. Instead the circuit carries its harder furniture all
     * the time and switches it in and out: `Collider.solid` is read live by
     * `resolveCapsule`, so a chicane can be made real or unreal in a single
     * pass over a list, with its mesh hidden to match. Easy also opens the
     * corners the standard layout pinches, and the lap count moves with it.
     *
     * See {@link setDifficulty}. */
    this.difficulties = ['easy', 'standard', 'expert'];
    this.variant = 'standard';
    /** Furniture that only exists on some difficulties. @type {Array<{mesh:THREE.Object3D, colliders:any[], from:string}>} */
    this._variantFurniture = [];
    /** Lap count per difficulty, for the selected circuit. Set by `selectTrack`. */
    this._variantLaps = { ...CIRCUITS[0].laps };
    /** Selected circuit length in metres. */
    this.trackLength = 0;

    this._owned = [];
    this._time = 0;
    /**
     * Distance LOD for the scenery tiles. Registrations are added by
     * `_instance`; nothing else in this world moves far enough from the camera
     * for a band to be worth the sphere transform.
     */
    this._lod = new DistanceLod();
    /** The selected circuit's course. Prefer `courseSet` for anything global. */
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

    /* ---- survey every circuit before anything is built -----------------
     *
     * The terrain is cut from all three at once, so all three splines have to
     * exist before the first vertex is written. Surveying is cheap - a few
     * thousand samples and a spatial hash each - next to the 110 000 probes
     * that follow. */
    await report(0.02, 'Surveying the circuits');
    for (const def of CIRCUITS) {
      const course = new RaceCourse(worldControls(def), {
        spacing: 2,
        verge: 11,
        baseHeight: baseTerrain,
        maxBankDeg: 5,
        cornerWiden: 0.2,
      });
      this.circuits.push({
        def,
        course,
        id: def.id,
        name: def.name,
        trackPath: [],
        checkpoints: [],
        startGrid: [],
        laps: { ...def.laps },
        loop: null,
        startLights: null,
        origin: def.origin ?? { x: 0, z: 0 },
      });
      console.info(
        `[RaceWorld] ${def.name}: ${course.length.toFixed(0)} m, ` +
        `${course.count} samples, tightest radius ${course.minRadius.toFixed(1)} m, ` +
        `steepest grade ${(course.maxGrade * 100).toFixed(1)}%`
      );
    }
    this.courseSet = new CourseSet(this.circuits.map((c) => c.course), baseTerrain);

    await report(0.06, 'Hanging the sky');
    this._buildSky();

    await report(0.12, 'Cutting the terrain');
    this._buildTerrain();

    /* Each circuit end to end, rather than each *stage* across all three: the
     * loading line then names a place the player recognises, and a failure in
     * one circuit's furniture leaves the other two whole. */
    const span = 0.44 / this.circuits.length;
    for (let i = 0; i < this.circuits.length; i++) {
      const cir = this.circuits[i];
      const at = 0.40 + i * span;
      await report(at, `Laying ${cir.name}`);
      this._buildTrackSurface(cir);
      this._buildBarriers(cir);
      await report(at + span * 0.5, `Dressing ${cir.name}`);
      this._buildPaddock(cir);
      if (cir.def.loop) this._buildLoop(cir);
      this._fillCircuit(cir);
    }

    await report(0.86, 'Raising the city');
    this._buildCity();

    await report(0.92, 'Planting the hills');
    this._buildScenery();

    await report(0.97, 'Painting the grid');
    this._finishWorld();

    this.group.matrixAutoUpdate = false;
    this.group.updateMatrixWorld(true);
    this.group.visible = this.active;
    await report(1, 'Circuits ready');
  }

  /* ================================================================== */
  /* Track selection                                                     */
  /* ================================================================== */

  /**
   * Point the published contract at one of the circuits.
   *
   * Nothing is built or torn down here - every circuit is already standing -
   * so this is three array assignments and a lap count, which is what makes it
   * safe to call from a menu button. The caller is responsible for re-arming
   * the race afterwards; RaceManager does that in its own `selectTrack`.
   *
   * @param {string} id
   * @returns {boolean} true if the selection changed
   */
  selectTrack(id) {
    const cir = this.circuits.find((c) => c.id === id) ?? this.circuits[0];
    if (!cir) return false;
    const changed = this.activeTrackId !== cir.id;
    this.activeTrackId = cir.id;
    this.course = cir.course;
    this.trackPath = cir.trackPath;
    this.checkpoints = cir.checkpoints;
    this.startGrid = cir.startGrid;
    this.trackLength = cir.course.length;
    this._variantLaps = cir.laps;
    this.lapCount = cir.laps[this.variant] ?? cir.laps.standard ?? 3;
    // `displayName` is deliberately left alone: it is the *world*'s name and
    // the HUD anchor label, and it is also a getter off the class, so writing
    // it here would throw. The circuit's own name is the race UI's business.
    return changed;
  }

  /** The selected circuit's record. */
  get activeCircuit() {
    return this.circuits.find((c) => c.id === this.activeTrackId) ?? this.circuits[0] ?? null;
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
    const course = this.courseSet;
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

    /* ---- collision ------------------------------------------------ *
     *
     * The height samples the mesh was just built from, handed to physics as a
     * single heightfield collider.
     *
     * This replaces an adaptive quadtree of tilted slabs - one fitted plane per
     * 5.2 m cell, subdivided wherever a plane could not follow the ground, and
     * raised until it dominated every sample beneath it. That machinery existed
     * entirely because a *plane* cannot describe curved ground: it cost roughly
     * 10,000 box colliders, and the lift needed to stop the ground poking
     * through its own collider is what left a walker hovering by up to 2.59 m on
     * a slope. A heightfield has no such limitation - it is the same triangles
     * the mesh draws, so there is nothing to fit, nothing to raise and nothing
     * to hover over.
     *
     * Cells under the ribbon are no longer skipped. The road's own slabs still
     * own that surface (the terrain is cut 10 cm below it, so a downward ray
     * always finds the ribbon first), but the terrain now continues underneath
     * rather than leaving a hole that depends on ribbon coverage being perfect.
     */
    this.track(
      this.physics.addHeightfield({
        heights: H,
        nx: N,
        nz: N,
        originX: -HALF,
        originZ: -HALF,
        stepX: QUAD,
        stepZ: QUAD,
      })
    );

    /* A floor far below everything, so a fall through a seam that should not
     * exist lands on something rather than falling forever. It can never be the
     * answer to a ground query where terrain exists, because `raycast` returns
     * the nearest hit and the terrain is above it. */
    this.track(this.physics.addBox(0, -60, 0, HALF * 1.5, 8, HALF * 1.5));

    this._terrainColliders = 1;
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
  _buildTrackSurface(cir) {
    const co = cir.course;
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
      mesh.name = `race:${cir.id}.track.${st.key}`;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      this.group.add(mesh);
      this._owned.push(g);
    }

    this._buildTrackCollision(cir);
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
  _buildTrackCollision(cir) {
    const co = cir.course;
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
          this._roadPoint(co, i, u0 * WA, wA, new THREE.Vector3()),
          this._roadPoint(co, i, u1 * WA, wA, new THREE.Vector3()),
          this._roadPoint(co, j, u0 * WB, wB, new THREE.Vector3()),
          this._roadPoint(co, j, u1 * WB, wB, new THREE.Vector3()),
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
    this._trackColliders = (this._trackColliders ?? 0) + count;
    console.info(`[RaceWorld] ${cir.name} road collision: ${count} solid slabs at the true surface`);
  }

  /** Road surface point at sample `i` of `co`, lateral offset `lat`. */
  _roadPoint(co, i, lat, w, out) {
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
  _buildBarriers(cir) {
    const co = cir.course;
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
    /* Where there are spectators. Fencing everywhere would be alpha-tested fill
     * across the whole frame for scenery nobody is standing behind, so each
     * circuit states its own sections - in *its own* local coordinates, which is
     * the only frame an author can reason about once a circuit has been offset
     * half a kilometre from the origin. */
    const ox = cir.origin.x;
    const oz = cir.origin.z;
    const rule = cir.def.fenced;
    const fenced = (i) => (rule ? rule(co.x[i] - ox, co.z[i] - oz) : false);

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
      mesh.name = `race:${cir.id}.barrier.wall`;
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
        this._roadPoint(co, i, lat, w, _v1);
        this._roadPoint(co, j, lat, w, _v2);
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
    this._barrierColliders = (this._barrierColliders ?? 0) + count;

    /* ---- tyre stacks on the outside of the fast corners ----------- */
    const B = new Batch({ ao: 0.4, sky: 0.32, grime: 0.5, span: 1.2 });
    for (let i = 0; i < N; i += 3) {
      const k = co.curv[i];
      if (Math.abs(k) < 1 / 90) continue;
      const w = co.w[i];
      const W = co.W[i];
      // Outside of the corner is opposite the direction of turn.
      const lat = -Math.sign(k) * (W - 1.25);
      this._roadPoint(co, i, lat, w, _v1);
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
    B.flush(this.group, (k) => this._mat(k), `tyres.${cir.id}`);
    B.dispose();

    this._buildVariantFurniture(cir);
  }

  /**
   * Chicanes that only exist on the harder difficulties.
   *
   * Placed at the fastest corners - the ones the AI and the player both take
   * flat - because narrowing a slow hairpin changes nothing about how hard a
   * lap is, while pinching a fast sweeper changes the line through it and the
   * speed you dare carry in.
   *
   * Each block is a mesh plus its colliders, tagged with the lowest difficulty
   * that keeps it. `setDifficulty` walks the list once and flips both. They are
   * built once, at world build time, so switching costs a visibility write and
   * a boolean per block rather than six seconds of geometry.
   */
  _buildVariantFurniture(cir) {
    const co = cir.course;
    const N = co.count;
    const B = new Batch({ ao: 0.4, sky: 0.32, grime: 0.5, span: 1.2 });
    const marks = [];

    // Rank the corners by how fast they are: high curvature is slow, so the
    // interesting ones are the shallow bends taken at speed.
    for (let i = 0; i < N; i += 4) {
      const k = Math.abs(co.curv[i]);
      if (k < 1 / 260 || k > 1 / 95) continue;
      marks.push({ i, k });
    }
    marks.sort((a, b2) => a.k - b2.k);
    // Six pinch points: the four fastest get one on standard, all six on expert.
    const chosen = marks.slice(0, 6);

    for (let c = 0; c < chosen.length; c++) {
      const { i } = chosen[c];
      const from = c < 4 ? 'standard' : 'expert';
      const w = co.w[i];
      const W = co.W[i];
      const k = co.curv[i];
      // Inside of the corner, so it tightens the natural line rather than
      // pushing the car towards the barrier on the outside.
      const side = Math.sign(k) || 1;
      const group = new THREE.Group();
      group.name = `chicane:${cir.id}:${from}:${i}`;
      this.group.add(group);
      const colliders = [];

      for (let seg = 0; seg < 3; seg++) {
        const at = (i + seg * 2) % N;
        const lat = side * (W - 2.2 - seg * 0.9);
        this._roadPoint(co, at, lat, w, _v1);
        const yaw = Math.atan2(co.rx[at], co.rz[at]);
        // A block of stacked kerb-blocks, not tyres: it must read at 30 m/s as
        // "do not go there" rather than as a soft barrier you might brush.
        for (let t = 0; t < 2; t++) {
          B.box('paint.enamel', 1.5, 0.55, 1.5, _v1.x, _v1.y + 0.28 + t * 0.55, _v1.z,
            yaw, t === 0 ? 0xe8452c : 0xf2f2ee);
        }
        colliders.push(this._orientedBox(
          _v1.clone().setY(_v1.y + 0.55), _n1.set(0, 1, 0),
          _a1.set(co.dx[at], 0, co.dz[at]), 0.78, 0.55, 0.78
        ));
      }
      const meshes = B.flush(group, (key) => this._mat(key), `chicane.${cir.id}.${c}`);
      void meshes;
      this._variantFurniture.push({ mesh: group, colliders, from });
    }
    B.dispose();

    this._buildTrackObstacles(cir);

    // Apply whatever the world was built as, so the default state is coherent.
    // Cheap and idempotent, so running it once per circuit is fine and means a
    // circuit is never left in a half-configured state mid-build.
    this.setDifficulty(this.variant);
  }

  /**
   * Hazards standing *in* the road, as opposed to the chicanes that pinch its
   * edges.
   *
   * The chicanes change the line you take; these change whether you can hold
   * it. They sit at a lateral offset drawn across the width rather than at the
   * kerb, so on the harder layouts the fast way through a corner is no longer a
   * clean arc and has to be threaded.
   *
   * Two rules keep them fair rather than annoying:
   *   - never within 60 m of the start line, so a standing start is not an
   *     immediate collision,
   *   - never more than one across the same part of the track, so there is
   *     always a way past. They are hazards, not a wall.
   *
   * Like the chicanes they are built once and switched by `setDifficulty`.
   */
  _buildTrackObstacles(cir) {
    const co = cir.course;
    const N = co.count;
    const rnd = this.rnd;
    const B = new Batch({ ao: 0.42, sky: 0.3, grime: 0.55, span: 1.0 });
    // Standard gets the first pass, expert gets both, easy gets a clear road.
    const passes = [
      { from: 'standard', step: 37, phase: 11 },
      { from: 'expert', step: 29, phase: 24 },
    ];

    let made = 0;
    for (const pass of passes) {
      for (let i = pass.phase; i < N; i += pass.step) {
        // Clear of the grid and the run to the first corner.
        const along = (i / N) * co.length;
        if (along < 60 || along > co.length - 25) continue;
        const w = co.w[i];
        const W = co.W[i];
        // Somewhere across the road, but never hard against either barrier -
        // an obstacle you cannot get round is a wall.
        const lat = (rnd() * 1.3 - 0.65) * W;
        this._roadPoint(co, i, lat, w, _v1);
        const yaw = Math.atan2(co.rx[i], co.rz[i]) + rnd() * 0.6;
        const group = new THREE.Group();
        group.name = `hazard:${cir.id}:${pass.from}:${i}`;
        this.group.add(group);
        const colliders = [];

        if (rnd() < 0.5) {
          // Oil drum: tall enough to see from a distance, narrow enough to miss.
          B.box('metal.iron', 0.86, 1.15, 0.86, _v1.x, _v1.y + 0.58, _v1.z, yaw, 0xb8471f);
          B.box('paint.enamel', 0.92, 0.16, 0.92, _v1.x, _v1.y + 0.86, _v1.z, yaw, 0xf0efe8);
          colliders.push(this._orientedBox(
            _v1.clone().setY(_v1.y + 0.58), _n1.set(0, 1, 0),
            _a1.set(co.dx[i], 0, co.dz[i]), 0.44, 0.58, 0.44
          ));
        } else {
          // A short barrier section, angled across the line.
          B.box('paint.enamel', 3.1, 0.78, 0.42, _v1.x, _v1.y + 0.39, _v1.z, yaw, 0xe8452c);
          B.box('paint.enamel', 3.1, 0.2, 0.46, _v1.x, _v1.y + 0.68, _v1.z, yaw, 0xf2f2ee);
          colliders.push(this._orientedBox(
            _v1.clone().setY(_v1.y + 0.39), _n1.set(0, 1, 0),
            _a1.set(Math.cos(yaw), 0, -Math.sin(yaw)), 1.55, 0.39, 0.24
          ));
        }
        B.flush(group, (key) => this._mat(key), `hazard.${cir.id}.${made}`);
        this._variantFurniture.push({ mesh: group, colliders, from: pass.from });
        made++;
      }
    }
    B.dispose();
    this._trackObstacles = (this._trackObstacles ?? 0) + made;
  }

  /**
   * Switch the circuit between its three layouts.
   *
   * Safe to call before or after the race systems exist, and safe to call with
   * a name that is not a difficulty - it falls back to standard rather than
   * leaving the track in a half-configured state.
   *
   * @param {string} name one of {@link difficulties}
   * @returns {string} the difficulty actually applied
   */
  setDifficulty(name) {
    const v = this.difficulties.includes(name) ? name : 'standard';
    this.variant = v;
    // Per circuit: the gorge and the highland run a lap shorter than Vellum on
    // easy and a lap longer on the rest, because they are 500 m shorter.
    this.lapCount = this._variantLaps?.[v] ?? 3;

    const rank = { easy: 0, standard: 1, expert: 2 };
    for (const f of this._variantFurniture) {
      const on = rank[v] >= rank[f.from];
      f.mesh.visible = on;
      // `Collider.solid` is read live by resolveCapsule, so this is the whole
      // of making a chicane real or unreal.
      for (const c of f.colliders) if (c) c.solid = on;
    }
    return v;
  }

  /**
   * The five columns of start lights, as one instanced mesh.
   *
   * Two lenses per column, ten instances, one draw call. Colour is per-instance
   * so `setStartLights` is a buffer write rather than a material swap - a swap
   * would key a fresh shader program on every change and stall the frame the
   * lights come on, which is the worst possible frame to stall.
   *
   * `MeshBasicMaterial` deliberately: a lens that is lit should be lit
   * regardless of where the sun is, and an unlit one should read as dark glass
   * rather than as a surface waiting for a light to reach it.
   */
  _buildStartLights(cir, g, yaw, fx, fz) {
    const geo = new THREE.BoxGeometry(0.78, 0.78, 0.26);
    const mat = new THREE.MeshBasicMaterial({ toneMapped: false });
    const mesh = new THREE.InstancedMesh(geo, mat, 10);
    mesh.name = `race:${cir.id}.startlights`;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0));
    const one = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3();
    for (let c = 0; c < 5; c++) {
      const lx = (c / 4 - 0.5) * 9;
      for (let r = 0; r < 2; r++) {
        p.set(
          g.x + Math.cos(yaw) * lx + fx * 1.05,
          g.y + 10.9 - r * 0.85,
          g.z - Math.sin(yaw) * lx + fz * 1.05
        );
        m4.compose(p, q, one);
        mesh.setMatrixAt(c * 2 + r, m4);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
    cir.startLights = mesh;
    this._lightColor ??= new THREE.Color();
    this._owned?.push?.(geo, mat);
    this._writeStartLights(mesh, 0, false);
  }

  /**
   * Light the first `lit` columns of the start gantry.
   *
   * @param {number} lit 0..5. Zero is the resting state *and* the go signal —
   *   in an F1 start those are the same picture, which is why the sequence has
   *   to be watched rather than glanced at.
   * @param {boolean} [go] true to hold the lenses dark-green for a moment after
   *   the off, so a driver who blinked can still tell "not yet" from "gone".
   */
  setStartLights(lit, go = false) {
    // Only the selected circuit's gantry: the other two are 500 m away with
    // nobody on their grid, and lighting them would be three sequences running
    // for one race.
    this._writeStartLights(this.activeCircuit?.startLights, lit, go);
  }

  /** @param {THREE.InstancedMesh|null|undefined} mesh */
  _writeStartLights(mesh, lit, go) {
    if (!mesh) return;
    this._lightColor ??= new THREE.Color();
    const n = Math.max(0, Math.min(5, lit | 0));
    for (let c = 0; c < 5; c++) {
      const on = c < n;
      // Unlit lenses are a very dark red rather than black: an extinguished
      // bulb still has a lens in front of it, and pure black reads as a hole
      // in the gantry.
      if (go) this._lightColor.setHex(0x1d6b2a);
      else this._lightColor.setHex(on ? 0xff2410 : 0x2a0c08);
      for (let r = 0; r < 2; r++) mesh.setColorAt(c * 2 + r, this._lightColor);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
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
  /* The loop                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * A vertical loop standing on the road.
   *
   * ── Why this is not part of the height function ──────────────────────────
   *
   * Everything else in this world is a surface over (x, z): one height per
   * position, which is what lets the terrain, the collision and the road all be
   * generated from the same probe and never disagree. A loop is the one shape
   * that cannot be: over the point below the apex there are two surfaces, the
   * tarmac and the loop 30 m above it, and a height function has to pick one.
   *
   * So the loop is not ground. It is a *rail*: a parametric curve with an
   * orientation attached, carrying whatever enters it around and putting it
   * down again facing the way it came in. The road underneath is untouched -
   * still one height, still solid, still the thing the terrain blends to - and
   * the loop has no collision at all, because nothing is ever left free to
   * collide with it. RaceLoops.js owns the traversal for both the player and
   * the AI; this method owns the shape and hands over the numbers.
   *
   * ── The shape ────────────────────────────────────────────────────────────
   *
   * A true circular loop returns to its own entry point, which reads on screen
   * as the car teleporting backwards. This one advances `advance` metres along
   * the road while it goes round, so entry and exit are 34 m apart and the
   * whole thing leans forward like every loop ever built out of scaffolding:
   *
   *     P(u) = lerp(entry, exit, u) + up * R * (1 - cos θ) + F * R * sin θ
   *
   * with θ = 2πu. The car's *orientation* comes from θ directly rather than
   * from the tangent of that curve - the tangent at the apex is horizontal,
   * which would drive the car over the top the right way up, and the entire
   * point of a loop is that it does not.
   *
   * @param {object} cir
   */
  _buildLoop(cir) {
    const def = cir.def.loop;
    const co = cir.course;
    const ax = (def.anchor?.x ?? 0) + cir.origin.x;
    const az = (def.anchor?.z ?? 0) + cir.origin.z;
    const near = co.nearest(ax, az);
    if (!near) {
      console.warn(`[RaceWorld] ${cir.name}: loop anchor is nowhere near the circuit; skipped`);
      return;
    }

    const R = def.radius;
    const advance = def.advance;
    const hw = def.width * 0.5;
    const sIn = near.s;
    const sOut = sIn + advance;
    const a = co.pointAt(((sIn % co.length) + co.length) % co.length, 0);
    const b = co.pointAt(((sOut % co.length) + co.length) % co.length, 0);
    const entry = new THREE.Vector3(a.x, a.y, a.z);
    const exit = new THREE.Vector3(b.x, b.y, b.z);
    // Forward is the chord entry->exit, flattened: the loop is planar even if
    // the road under it drifts, which is what stops it corkscrewing.
    const F = new THREE.Vector3(exit.x - entry.x, 0, exit.z - entry.z);
    if (F.lengthSq() < 1e-6) F.set(a.dx, 0, a.dz);
    F.normalize();
    const UP = new THREE.Vector3(0, 1, 0);
    const RIGHT = new THREE.Vector3().crossVectors(F, UP).normalize();

    /** Rail point and surface normal at u in 0..1. */
    const at = (u, outPos, outNrm) => {
      const th = u * TAU;
      const sin = Math.sin(th);
      const cos = Math.cos(th);
      outPos.copy(entry).lerp(exit, u);
      outPos.x += F.x * (R * sin);
      outPos.z += F.z * (R * sin);
      outPos.y += R * (1 - cos);
      // Toward the centre of the circle, which is the side the car is on.
      if (outNrm) outNrm.set(F.x * -sin, cos, F.z * -sin).normalize();
      return outPos;
    };

    const apex = at(0.5, new THREE.Vector3(), null);

    /* ---- the ribbon ------------------------------------------------- *
     *
     * Two strips, not one, and the reason is material rather than geometry: a
     * vertex colour *multiplies* the material's texture, so painting the rails
     * white on an asphalt shader gives pale asphalt, not paint. The first
     * version was a single closed tube in `asphalt.court` and every rail and
     * stripe on it came out black.
     *
     * So the driving surface is tarmac and the shell around it is enamel, and
     * the two profiles are the two halves of one closed cross-section traversed
     * the same way round - surface left-to-right, shell back right-to-left over
     * the top - which is what keeps their windings consistent with each other.
     */
    const SURFACE = [];
    for (let c = 0; c <= 6; c++) SURFACE.push([lerp(-hw, hw, c / 6), 0]);
    const SHELL = [
      [hw, 0], [hw, 0.5], [hw + 0.55, 0.5], [hw + 0.55, -1.15],
      [-hw - 0.55, -1.15], [-hw - 0.55, 0.5], [-hw, 0.5], [-hw, 0],
    ];
    const ROWS = 132;
    const pos = new THREE.Vector3();
    const nrm = new THREE.Vector3();

    /* Arc length first, in its own pass: the strip's v coordinate has to be the
     * distance travelled *so far*, and computing it in the same loop that
     * writes the rows means every row is textured against the total length as
     * it stood when that row was written - which stretches the texture along
     * the loop by a factor of two from bottom to top. */
    let length3d = 0;
    const arc = new Float64Array(ROWS + 1);
    const prev = new THREE.Vector3();
    for (let r = 0; r <= ROWS; r++) {
      at(r / ROWS, pos, null);
      if (r > 0) length3d += pos.distanceTo(prev);
      prev.copy(pos);
      arc[r] = length3d;
    }

    const strip = (profile, key, colourOf) => {
      const cols = profile.length;
      const lat = new Lattice(cols);
      const row = [];
      for (let c = 0; c < cols; c++) row.push({ x: 0, y: 0, z: 0, u: 0, r: 1, g: 1, b: 1 });
      const tile = TILE_METRES(key) || 4;
      for (let r = 0; r <= ROWS; r++) {
        const u = r / ROWS;
        at(u, pos, nrm);
        for (let c = 0; c < cols; c++) {
          const [l, off] = profile[c];
          const v = row[c];
          v.x = pos.x + RIGHT.x * l + nrm.x * off;
          v.y = pos.y + RIGHT.y * l + nrm.y * off;
          v.z = pos.z + RIGHT.z * l + nrm.z * off;
          v.u = l / tile;
          _color.set(colourOf(c, r));
          v.r = _color.r; v.g = _color.g; v.b = _color.b;
        }
        lat.addRow(row, arc[r] / tile);
      }
      // Open, not closed: the last row sits on the first one at the entry, and
      // stitching them would put a fold across the ramp.
      const g = lat.build(false, true);
      if (!g) return;
      const mesh = new THREE.Mesh(g, this._mat(key));
      mesh.name = `race:${cir.id}.loop.${key}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this._owned.push(g);
    };

    // Tarmac, darkening toward the edges the way a used surface does.
    strip(SURFACE, 'asphalt.court', (c) => (c === 0 || c === 6 ? 0xc8ccce : 0xeceef0));
    // Enamel: hazard stripes every ~4 m of travel, so the loop reads as
    // something that was built rather than as a grey pipe.
    strip(SHELL, 'paint.enamel', (c, r) => {
      const stripe = Math.floor(r / 4) % 2 === 0;
      // The undersides stay plain; only the rails either side are striped.
      const rail = c <= 2 || c >= 5;
      return rail && stripe ? 0xe8452c : 0xf2f2ee;
    });

    /* ---- what holds it up ------------------------------------------- *
     * Two A-frames either side, braced back to the ground. Without them the
     * loop reads as floating, which is the one thing that makes a set piece
     * look like a placeholder. */
    const B = new Batch({ ao: 0.34, sky: 0.3, grime: 0.45, span: 4 });
    const yaw = Math.atan2(-RIGHT.x, -RIGHT.z);
    for (const sgn of [-1, 1]) {
      for (const u of [0.25, 0.5, 0.75]) {
        at(u, pos, nrm);
        const px = pos.x + RIGHT.x * sgn * (hw + 1.5);
        const pz = pos.z + RIGHT.z * sgn * (hw + 1.5);
        const gy = this.courseSet.surfaceHeight(px, pz);
        const h = Math.max(1, pos.y - gy);
        B.box('metal.rail', 0.85, h, 0.85, px, gy + h * 0.5, pz, yaw, 0xb9c0c6);
        this.track(this.physics.addBox(px, gy + h * 0.5, pz, 0.45, h * 0.5, 0.45));
      }
      // A diagonal from the foot of the apex leg back to the ground behind.
      at(0.5, pos, nrm);
      const bx = pos.x + RIGHT.x * sgn * (hw + 1.5) - F.x * 16;
      const bz = pos.z + RIGHT.z * sgn * (hw + 1.5) - F.z * 16;
      const by = this.courseSet.surfaceHeight(bx, bz);
      const mid = new THREE.Vector3((bx + pos.x + RIGHT.x * sgn * (hw + 1.5)) * 0.5,
        (by + pos.y) * 0.5, (bz + pos.z + RIGHT.z * sgn * (hw + 1.5)) * 0.5);
      const span = Math.hypot(pos.x + RIGHT.x * sgn * (hw + 1.5) - bx,
        pos.y - by, pos.z + RIGHT.z * sgn * (hw + 1.5) - bz);
      _a1.set(pos.x + RIGHT.x * sgn * (hw + 1.5) - bx, pos.y - by,
        pos.z + RIGHT.z * sgn * (hw + 1.5) - bz).normalize();
      _n1.set(0, 1, 0).addScaledVector(_a1, -_a1.y).normalize();
      if (_n1.lengthSq() < 1e-6) _n1.set(0, 1, 0);
      this._orientedBox(mid, _n1, _a1, 0.4, 0.4, span * 0.5);
      B.boxOriented('metal.trim', 0.8, 0.8, span,
        slabMatrix(mid, _n1, _a1, 0, new THREE.Matrix4()), 0xa8b0b6);
    }
    // A sign on the approach, because a 30 m wall of scaffolding at 30 m/s
    // deserves a metre of warning.
    {
      const sgnPoint = co.pointAt(((sIn - 60) % co.length + co.length) % co.length, -(co.W[0] + 2));
      const syaw = acrossYaw(sgnPoint.dx, sgnPoint.dz);
      B.box('metal.rail', 0.3, 4.2, 0.3, sgnPoint.x, sgnPoint.y + 2.1, sgnPoint.z, syaw, 0x8f979d);
      B.box('paint.enamel', 4.6, 1.6, 0.18, sgnPoint.x, sgnPoint.y + 4.4, sgnPoint.z, syaw,
        cir.def.accent ?? 0x9d7dff);
      B.box('hazard.stripe', 4.2, 0.35, 0.22, sgnPoint.x, sgnPoint.y + 3.5, sgnPoint.z, syaw, 0xffdd44);
    }
    B.flush(this.group, (k) => this._mat(k), `loop.${cir.id}`);
    B.dispose();

    /* ---- the numbers the race systems need --------------------------- *
     * Plain data, deliberately: RaceLoops evaluates the rail itself rather than
     * calling back into the world, so a race is never one dead reference away
     * from dropping a car through the floor at 30 m/s. */
    cir.loop = {
      trackId: cir.id,
      sIn,
      sOut,
      sMid: sIn + advance * 0.5,
      radius: R,
      advance,
      width: def.width,
      length3d,
      entry: { x: entry.x, y: entry.y, z: entry.z },
      exit: { x: exit.x, y: exit.y, z: exit.z },
      forward: { x: F.x, z: F.z },
      apex: { x: apex.x, y: apex.y, z: apex.z },
      /* Below this, going round is not a loop, it is a fall. The car cruises at
       * 22 m/s and boosts to 34, and an AI on easy runs about 20, so nothing
       * that reaches the entry under power is ever refused - the floor exists so
       * a car that crawled in from a spin is carried round at a speed that looks
       * like a loop instead of pouring off the top. */
      minSpeed: 19,
    };
    if (!Array.isArray(this.loops)) this.loops = [];
    this.loops.push(cir.loop);
    console.info(
      `[RaceWorld] ${cir.name}: loop at ${sIn.toFixed(0)} m, ` +
      `R ${R} m, apex ${apex.y.toFixed(1)} m, rail ${length3d.toFixed(0)} m`
    );
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
    /* Vellum Ridge's circuit for the street furniture that follows its
     * corridor, but the *whole* height function for clearance: a building is
     * dropped if it would stand on any road, not merely on this one. The other
     * two circuits are half a kilometre away, so nothing is ever rejected for
     * their sake - it is stated this way so it stays true if a circuit moves. */
    const co = this.circuits[0].course;
    const clear = this.courseSet;
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
          const p = clear.probe(px, pz);
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
   *
   * Only Vellum Ridge gets the full kit. Sixteen garages, three of them
   * enterable, and fifteen bays of roofed grandstand with twelve hundred
   * spectators in them is most of a minute of build time and a good slice of
   * the world's collider budget; paying it three times over for two circuits
   * the player reaches by driving there would be spending the cold-boot cost of
   * the whole game on car parks. The other two get {@link _buildLitePaddock}:
   * a timing box, an open stand and a pit wall, which is what a club circuit
   * has anyway.
   *
   * The gantry, the start lights and the painted line are built for all three -
   * they are what a start *is*.
   */
  _buildPaddock(cir) {
    const B = new Batch({ ao: 0.36, sky: 0.34, grime: 0.45, span: 3.5 });
    const co = cir.course;

    if (cir.def.paddock) this._buildFullPaddock(cir, B);
    else this._buildLitePaddock(cir, B);

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
      /* The crossbeam had no collider of its own - only its two legs did - so
       * the beam and the trim capping it were both scenery you could stand
       * inside. Sized to the *trim*, which is the wider of the two by 0.45 m a
       * side, so nothing visible overhangs what is solid. */
      this.track(this.physics.addRotatedBox(
        _v1.set(g.x, g.y + 11.05, g.z),
        _v2.set(wHalf + 1.2, 1.4, 1.2), yaw));
      /* Light panel: five columns of start lights, facing *back* down the
       * straight, because that is where the grid is.
       *
       * Not batched with the rest of the gantry. The whole point of an F1 start
       * is that the columns come on one at a time and then all go out together,
       * and geometry merged into a shared buffer cannot be addressed
       * individually. Ten instances of one box is a single draw call and every
       * lens is independently coloured, which is what the sequence needs.
       *
       * A backing plate goes in the batch, though - it never changes. */
      const fx = -g.dx;
      const fz = -g.dz;
      B.box('metal.trim', 11.2, 2.4, 0.22, g.x + fx * 0.88, g.y + 10.48, g.z + fz * 0.88, yaw, 0x14171a);
      this._buildStartLights(cir, g, yaw, fx, fz);
      // Banner across the front of the gantry, in the circuit's own colour -
      // from the grid it is the one piece of the world that says which of the
      // three you are about to drive.
      B.box('paint.enamel', wHalf * 2 - 4, 1.5, 0.2, g.x + fx * 1.0, g.y + 9.4, g.z + fz * 1.0,
        yaw, cir.def.accent ?? 0x1d3a66);
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

    B.flush(this.group, (k) => this._mat(k), `paddock.${cir.id}`);
    B.dispose();
  }

  /**
   * The club-circuit kit: a pit wall, four open bays, a timing box and one
   * uncovered stand.
   *
   * Deliberately not a smaller copy of the full paddock. A half-scale version
   * of sixteen garages reads as a paddock somebody could not afford to finish;
   * an open awning over four bays and a scaffold stand reads as a circuit that
   * was never meant to hold a hundred thousand people. Same reason the crowd is
   * a third the size and spread thin - a packed grandstand at a quarry is a lie
   * the eye catches immediately.
   *
   * @param {object} cir
   * @param {Batch} B
   */
  _buildLitePaddock(cir, B) {
    const co = cir.course;
    const rnd = this.rnd;
    const W = co.W[0];
    const wrap = (s) => ((s % co.length) + co.length) % co.length;
    const accent = cir.def.accent ?? 0xd0453a;

    /* ---- pit wall ---- */
    for (let k = -4; k <= 5; k++) {
      const g = co.pointAt(wrap(k * 11), -(W + 2.4));
      const yaw = alongYaw(g.dx, g.dz);
      B.box('concrete.wall', 11, 1.1, 0.5, g.x, g.y + 0.55, g.z, yaw, 0xf0f0ee);
      this.track(this.physics.addRotatedBox(
        _v1.set(g.x, g.y + 0.55, g.z), _v2.set(5.5, 0.55, 0.3), yaw));
    }

    /* ---- four open bays under one awning, infield side ---- */
    for (let k = -2; k <= 1; k++) {
      const g = co.pointAt(wrap(k * 12 + 6), -(W + 12));
      const yaw = alongYaw(g.dx, g.dz);
      // Toward the circuit is +lat, which is the right-hand normal.
      const tx = -g.dz;
      const tz = g.dx;
      // Back wall, two posts, a roof: an open-fronted bay you can see into.
      B.box('concrete.wall', 11, 3.6, 0.4, g.x - tx * 3.4, g.y + 1.8, g.z - tz * 3.4, yaw, 0xdedcd6);
      this.track(this.physics.addRotatedBox(
        _v1.set(g.x - tx * 3.4, g.y + 1.8, g.z - tz * 3.4), _v2.set(5.5, 1.8, 0.25), yaw));
      for (const sgn of [-1, 1]) {
        B.box('metal.rail', 0.32, 3.9, 0.32,
          g.x + Math.cos(yaw) * sgn * 5.2 + tx * 3.2, g.y + 1.95,
          g.z - Math.sin(yaw) * sgn * 5.2 + tz * 3.2, yaw, 0x99a1a6);
        this.track(this.physics.addRotatedBox(
          _v1.set(g.x + Math.cos(yaw) * sgn * 5.2 + tx * 3.2, g.y + 1.95,
            g.z - Math.sin(yaw) * sgn * 5.2 + tz * 3.2),
          _v2.set(0.16, 1.95, 0.16), yaw));
      }
      B.box('metal.panel', 11.6, 0.3, 7.6, g.x, g.y + 4.05, g.z, yaw, 0xb2b8bc);
      this.track(this.physics.addRotatedBox(
        _v1.set(g.x, g.y + 4.05, g.z), _v2.set(5.8, 0.15, 3.8), yaw));
      B.box('paint.enamel', 11.6, 0.42, 0.3, g.x + tx * 3.7, g.y + 4.35, g.z + tz * 3.7, yaw, accent);
      B.box('concrete.road', 11, 0.14, 7, g.x, g.y + 0.07, g.z, yaw, 0xd6d5cf);
      // A tyre stack and a trolley, so a bay is never an empty box.
      for (let t = 0; t < 3; t++) {
        B.box('metal.iron', 1.0, 0.4, 1.0,
          g.x + Math.cos(yaw) * -3.6 - tx * 1.8, g.y + 0.2 + t * 0.4,
          g.z - Math.sin(yaw) * -3.6 - tz * 1.8, yaw + rnd() * 0.4, 0x2b2e31);
      }
      B.box('metal.panel', 1.9, 0.75, 1.0, g.x + Math.cos(yaw) * 3.4 - tx * 1.4,
        g.y + 0.5, g.z - Math.sin(yaw) * 3.4 - tz * 1.4, yaw + 0.15, 0x8d969c);
    }

    /* ---- timing box, on the pit wall by the line ---- */
    {
      const g = co.pointAt(wrap(14), -(W + 6.5));
      const yaw = alongYaw(g.dx, g.dz);
      const tx = -g.dz;
      const tz = g.dx;
      B.box('concrete.wall', 7.4, 3.2, 4.4, g.x, g.y + 1.6, g.z, yaw, 0xe4e2dc);
      this.track(this.physics.addRotatedBox(
        _v1.set(g.x, g.y + 1.6, g.z), _v2.set(3.7, 1.6, 2.2), yaw));
      B.box('glass.window', 6.6, 1.35, 0.28, g.x + tx * 2.3, g.y + 2.35, g.z + tz * 2.3, yaw, 0x9fc4d8);
      B.box('metal.panel', 8.0, 0.3, 5.0, g.x, g.y + 3.35, g.z, yaw, 0xa8b0b6);
      this.track(this.physics.addRotatedBox(
        _v1.set(g.x, g.y + 3.35, g.z), _v2.set(4.0, 0.15, 2.5), yaw));
      B.box('paint.enamel', 6.2, 0.5, 0.22, g.x + tx * 2.45, g.y + 3.15, g.z + tz * 2.45, yaw, accent);
    }

    /* ---- one open stand, outside the straight ---- */
    const crowd = [];
    for (let k = -2; k <= 3; k++) {
      const base = co.pointAt(wrap(k * 13 + 8), W + 3);
      const yaw = alongYaw(base.dx, base.dz);
      // Terraces step away from the circuit, which is +lat on this side.
      const ox = -base.dz;
      const oz = base.dx;
      for (let r = 0; r < 6; r++) {
        const off = 3.4 + r * 1.5;
        const y = base.y + 1.0 + r * 1.0;
        const px = base.x + ox * off;
        const pz = base.z + oz * off;
        B.box('concrete.skatepark', 12.6, 1.0, 1.6, px, y - 0.5, pz, yaw, 0xd2d2ce);
        B.box('paint.enamel', 12.2, 0.4, 0.5, px, y + 0.2, pz, yaw, r % 2 ? accent : 0xc8ccd0);
        for (let c = 0; c < 7; c++) {
          // Thinner than Vellum's: a club meeting, not a grand prix.
          if (rnd() < 0.62) continue;
          const lx = (c / 6 - 0.5) * 11;
          crowd.push({
            x: px + Math.cos(yaw) * lx,
            y: y + 0.4,
            z: pz - Math.sin(yaw) * lx,
            yaw: yaw + (rnd() - 0.5) * 0.5,
            c: rnd(),
          });
        }
      }
      // Scaffold under the deck, and a rail along the front.
      this.track(this.physics.addRotatedBox(
        _v1.set(base.x + ox * 7.6, base.y + 3.2, base.z + oz * 7.6),
        _v2.set(6.4, 3.2, 5.2), yaw));
      B.box('metal.rail', 12.4, 0.16, 0.16, base.x + ox * 2.6, base.y + 1.1, base.z + oz * 2.6,
        yaw, 0x99a1a6);
    }
    this._spawnCrowd(crowd);
  }

  /**
   * Vellum Ridge's pit lane, garages and grandstand. See {@link _buildPaddock}.
   * @param {object} cir
   * @param {Batch} B
   */
  _buildFullPaddock(cir, B) {
    const co = cir.course;
    const rnd = this.rnd;
    const W = co.W[0];

    /* ---- pit lane and garages, infield side (negative lat) ---- */
    const wrap = (s) => ((s % co.length) + co.length) % co.length;
    const enterableGarages = new Map([
      [-4, 'North Tyre Garage'],
      [0, 'Race Control Bay'],
      [4, 'Prototype Paddock Garage'],
    ]);
    for (let k = -7; k <= 8; k++) {
      const g = co.pointAt(wrap(k * 11), -(W + 14));
      const yaw = alongYaw(g.dx, g.dz);
      // Toward the circuit is +lat, which is the right-hand normal.
      const tx = -g.dz;
      const tz = g.dx;
      const enterable = enterableGarages.has(k);
      const doorPaint = pick(rnd, [0x3f6fa8, 0xb8452f, 0x2f8a5a, 0xd0a02a, 0x7a4a9a]);
      if (!enterable) {
        B.box('concrete.wall', 10.4, 5.4, 9, g.x, g.y + 2.7, g.z, yaw, 0xe6e6e2);
        this.track(this.physics.addRotatedBox(
          _v1.set(g.x, g.y + 2.7, g.z), _v2.set(5.2, 2.7, 4.5), yaw));
        // Roller door, facing the pit lane.
        B.box('metal.panel', 7.4, 3.9, 0.3, g.x + tx * 4.6, g.y + 1.95, g.z + tz * 4.6, yaw,
          doorPaint);
      } else {
        const w = 10.4;
        const h = 5.4;
        const d = 9;
        const hw = w * 0.5;
        const hd = d * 0.5;
        const wallT = 0.42;
        const doorHW = 3.25;
        const doorH = 3.55;
        const M = new THREE.Matrix4().makeRotationY(yaw).setPosition(g.x, g.y, g.z);
        const rcol = (lx, cy, lz, hx, hy, hz) => {
          _v1.set(lx, cy, lz).applyMatrix4(M);
          return this.track(this.physics.addRotatedBox(_v1, _v2.set(hx, hy, hz), yaw));
        };
        const segW = hw - doorHW;
        B.box('concrete.wall', w, h, wallT, g.x - tx * (hd - wallT * 0.5), g.y + h * 0.5,
          g.z - tz * (hd - wallT * 0.5), yaw, 0xe6e6e2);
        rcol(0, h * 0.5, -hd + wallT * 0.5, hw, h * 0.5, wallT * 0.5 + 0.04);
        for (const sgn of [-1, 1]) {
          B.box('concrete.wall', wallT, h, d - wallT * 2,
            g.x + Math.cos(yaw) * sgn * (hw - wallT * 0.5), g.y + h * 0.5,
            g.z - Math.sin(yaw) * sgn * (hw - wallT * 0.5), yaw, 0xe6e6e2);
          rcol(sgn * (hw - wallT * 0.5), h * 0.5, 0, wallT * 0.5 + 0.04, h * 0.5, hd);
          B.box('concrete.wall', segW, h, wallT,
            g.x + Math.cos(yaw) * sgn * (doorHW + segW * 0.5) + tx * (hd - wallT * 0.5),
            g.y + h * 0.5,
            g.z - Math.sin(yaw) * sgn * (doorHW + segW * 0.5) + tz * (hd - wallT * 0.5),
            yaw, 0xe6e6e2);
          rcol(sgn * (doorHW + segW * 0.5), h * 0.5, hd - wallT * 0.5,
            segW * 0.5, h * 0.5, wallT * 0.5 + 0.04);
        }
        B.box('concrete.wall', doorHW * 2, h - doorH, wallT, g.x + tx * (hd - wallT * 0.5),
          g.y + doorH + (h - doorH) * 0.5, g.z + tz * (hd - wallT * 0.5), yaw, 0xe6e6e2);
        rcol(0, doorH + (h - doorH) * 0.5, hd - wallT * 0.5,
          doorHW, (h - doorH) * 0.5, wallT * 0.5 + 0.04);
        B.box('concrete.road', w - 0.25, 0.16, d - 0.25, g.x, g.y + 0.08, g.z, yaw, 0xd9d8d2);
        rcol(0, 0.04, 0, hw - 0.12, 0.08, hd - 0.12);
        B.box('metal.panel', w - 0.1, 0.16, d - 0.1, g.x, g.y + h - 0.08, g.z, yaw, 0xaeb5ba);
        rcol(0, h - 0.08, 0, hw - 0.05, 0.1, hd - 0.05);
        B.box('metal.trim', doorHW * 2 + 0.55, 0.35, 0.34, g.x + tx * (hd + 0.08),
          g.y + doorH + 0.18, g.z + tz * (hd + 0.08), yaw, 0x8d969c);
        B.box('metal.panel', 2.1, 0.82, 1.1, g.x + Math.cos(yaw) * -2.1 + tx * -0.7,
          g.y + 0.58, g.z - Math.sin(yaw) * -2.1 + tz * -0.7, yaw + 0.1, doorPaint);
        rcol(-2.1, 0.58, -0.7, 1.15, 0.65, 0.7);
        B.box('rubber.track', 1.35, 0.42, 1.35, g.x + Math.cos(yaw) * 1.9 + tx * -0.95,
          g.y + 0.24, g.z - Math.sin(yaw) * 1.9 + tz * -0.95, yaw, 0x1d1d1d);
        rcol(1.9, 0.28, -0.95, 0.75, 0.35, 0.75);

        const makeLeaf = (hingeX, dir, openSign) => {
          const leafW = doorHW - 0.06;
          const geo = prepDynamicGeo(new THREE.BoxGeometry(leafW, doorH - 0.14, 0.11), 'metal.panel', doorPaint);
          geo.translate(dir * leafW * 0.5, 0, 0);
          const leaf = new THREE.Mesh(geo, this._mat('metal.panel'));
          leaf.castShadow = leaf.receiveShadow = true;
          this._owned.push(geo);
          const pivot = new THREE.Group();
          _v1.set(hingeX, doorH * 0.5, hd - wallT * 0.5).applyMatrix4(M);
          pivot.position.copy(_v1);
          pivot.rotation.y = yaw;
          pivot.add(leaf);
          this.group.add(pivot);
          return { pivot, closed: yaw, open: yaw + openSign * Math.PI * 0.58 };
        };
        _v1.set(0, doorH * 0.5, hd - wallT * 0.5).applyMatrix4(M);
        const doorCol = this.track(this.physics.addRotatedBox(_v1, _v2.set(doorHW, doorH * 0.5, 0.13), yaw));
        const dpos = new THREE.Vector3(0, 1.2, hd).applyMatrix4(M);
        const lootPos = new THREE.Vector3(-2.1, 1.2, -0.7).applyMatrix4(M);
        if (!Array.isArray(this.enterables)) this.enterables = [];
        const n = this.enterables.length;
        this.enterables.push({
          label: enterableGarages.get(k),
          origin: new THREE.Vector3(g.x, g.y, g.z),
          doors: [{
            id: `race_pit_${n}`,
            leaves: [
              makeLeaf(-doorHW + 0.03, +1, -1),
              makeLeaf(doorHW - 0.03, -1, +1),
            ],
            collider: doorCol,
            position: dpos,
            open: false,
            anim: 0,
          }],
          collectibleSpots: [{ position: lootPos, tier: 'common' }],
        });
      }
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
  /**
   * The one conifer every tree in this world is an instance of, at a chosen
   * tessellation.
   *
   * Everything that decides the tree's *shape* - trunk height and lean, four
   * skirts at 2.1 m spacing, the taper `r(1-u)(1-0.2u)` - is identical in both
   * lods, and only the resolution the shape is sampled at changes. That is the
   * property that lets `DistanceLod` swap between them mid-frame: the two
   * geometries occupy the same volume about the same axis, so the swap has no
   * position to give it away, only a facet count.
   *
   * The two knobs, and what each is worth per tree (432 triangles of crown,
   * 104 of trunk at 'hi'):
   *
   *   radial   9 -> 5 on the skirts, 8 -> 4 on the trunk. This is the one that
   *            can be seen, and {@link CONIFER_LO_INFLATE} exists to pay for
   *            the silhouette it costs.
   *   stations 6 -> 3 along each skirt, 6 -> 3 along the trunk. This one is
   *            close to free: the taper is nearly linear (a 3-station chord
   *            deviates from the 6-station curve by under 1.3% of the skirt
   *            radius, ~5 cm on the widest one), so the profile is preserved
   *            and the saving is real.
   *
   * Together: 432 -> 120 triangles of crown and 104 -> 28 of trunk, a 72%
   * cut on each, for a tree whose nearest instance is 170 m away.
   *
   * A dead end worth recording: dropping a skirt (4 tiers -> 3) saves about as
   * much again and is not available. The tiers are what makes the silhouette
   * read as a conifer rather than a party hat - the comment below has said so
   * since the tree was built - and a treeline that loses a quarter of its
   * ragged edge at 170 m is the exact artefact this is trying not to have.
   *
   * @param {'hi'|'lo'} [lod]
   * @returns {{trunk: THREE.BufferGeometry, canopy: THREE.BufferGeometry}}
   */
  _conifer(lod = 'hi') {
    const LO = lod === 'lo';
    const STATIONS = LO ? 3 : 6;
    const R = LO ? CONIFER_LO_INFLATE : 1;

    const trunkSecs = [];
    for (let i = 0; i <= STATIONS; i++) {
      const t = i / STATIONS;
      trunkSecs.push({
        x: Math.sin(t * 1.1) * 0.14 * t,
        y: t * 9.5,
        z: Math.cos(t * 1.7) * 0.08 * t,
        rx: 0.34 - t * 0.24 + Math.exp(-t * 8) * 0.1,
        ry: 0.34 - t * 0.24 + Math.exp(-t * 8) * 0.1,
      });
    }
    const trunk = sweep(trunkSecs, LO ? 4 : 8, { capStart: false });
    // Four overlapping skirts, each widest at its own base. A single cone is a
    // party hat; the tiers are what make the silhouette read as a conifer.
    const tiers = [];
    for (let t = 0; t < 4; t++) {
      const y0 = 1.8 + t * 2.1;
      const r = 3.1 - t * 0.62;
      const secs = [];
      const n = LO ? 2 : 5;
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        secs.push({
          y: y0 + u * 3.4,
          z: 0,
          rx: Math.max(0.05, r * (1 - u) * (1 - u * 0.2) * R),
          ry: Math.max(0.05, r * (1 - u) * (1 - u * 0.2) * R),
        });
      }
      tiers.push(sweep(secs, LO ? 5 : 9));
    }
    const canopy = mergeGeometries(tiers.map((g) => (g.index ? g.toNonIndexed() : g)), false);
    for (const g of tiers) g.dispose();
    return { trunk, canopy };
  }

  _buildScenery() {
    const rnd = this.rnd;
    const co = this.courseSet;

    /* ---- one conifer, instanced, at two tessellations ---- */
    const { trunk, canopy } = this._conifer('hi');
    const { trunk: trunkLo, canopy: canopyLo } = this._conifer('lo');

    /* Scaled to area, not copied across.
     *
     * 700 trees over the old 520 m map was one every 390 m^2; the same density
     * over 1 320 m is 4 500, which is four and a half thousand instances of a
     * fourteen-tier conifer for middle distance. 2 400 thins it to one every
     * 730 m^2 - still a wooded country from a car, and half the instance
     * buffer. Rejected candidates (road corridor, city, cliff, apron) come off
     * that number, so the standing count is lower again. */
    const trees = [];
    for (let i = 0; i < 2400; i++) {
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
    this._instance(trunk, 'bark.palm', trees, 'race:tree.trunk', 0x9a7a52, true, true,
      { lo: trunkLo, swapBeyond: CONIFER_LO_DISTANCE });
    // Crowns cast but do not receive: self-shadowing a mass of thin needles
    // costs a shadow lookup per tier and returns acne rather than shade.
    this._instance(canopy, 'foliage.frond', trees, 'race:tree.crown', 0x4e7a3c, true, false,
      { lo: canopyLo, swapBeyond: CONIFER_LO_DISTANCE });
    for (const t of trees) {
      if (rnd() < 0.35) {
        this.track(this.physics.addBox(t.x, t.y + 3 * t.k, t.z, 0.3 * t.k, 3 * t.k, 0.3 * t.k));
      }
    }

    /* ---- rock outcrops ---- */
    const rockGeos = [];
    const rockLoGeos = [];
    /* Detail 2 is 180 faces (an icosahedron's edges cut in three) and detail 1
     * is 80 (cut in two): a 21 degree face against a 32 degree one, for 56% of
     * the triangles. What it is NOT is a free swap - see {@link
     * ROCK_LO_DISTANCE} for the ray cast that says so - and that is why the
     * rock band sits further out than the tree band rather than nearer.
     */
    const rockAt = (v, detail) => {
      const g = new THREE.IcosahedronGeometry(1, detail);
      const p = g.attributes.position;
      /* Displaced by a smooth function of the vertex *direction*, not by a
       * fresh random number per vertex.
       *
       * `IcosahedronGeometry` is non-indexed, so every triangle carries its own
       * copy of each corner. Jittering them independently pulls those copies
       * apart and the rock comes out as a heap of disconnected shards - which
       * is exactly what the first pass rendered. A function of direction gives
       * every copy of a corner the same answer, so the surface stays closed.
       *
       * It is also what makes the two tessellations agree: the displacement
       * depends on nothing but the direction, so a detail-1 vertex and the
       * detail-2 vertex in the same place get the same radius and the cheap
       * rock sits inside the expensive one's skin rather than beside it. */
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
      return g;
    };
    for (let v = 0; v < 3; v++) {
      rockGeos.push(rockAt(v, 2));
      rockLoGeos.push(rockAt(v, 1));
    }
    const rocks = [[], [], []];
    for (let i = 0; i < 900; i++) {
      const x = -HALF + rnd() * HALF * 2;
      const z = -HALF + rnd() * HALF * 2;
      const p = co.probe(x, z);
      if (p.d < p.W + 7) continue;
      if (x > CITY.x0 - 8 && x < CITY.x1 + 8 && z > CITY.z0 - 8 && z < CITY.z1 + 8) continue;
      const k = 1.1 + rnd() * 3.4;
      rocks[(rnd() * 3) | 0].push({ x, y: p.h - k * 0.3, z, k, yaw: rnd() * TAU });
    }
    for (let v = 0; v < 3; v++) {
      this._instance(rockGeos[v], 'concrete.wall', rocks[v], `race:rock${v}`, 0x9a958a, true, true,
        { lo: rockLoGeos[v], swapBeyond: ROCK_LO_DISTANCE });
      for (const r of rocks[v]) {
        if (r.k > 2.2) {
          this.track(this.physics.addBox(r.x, r.y + r.k * 0.3, r.z, r.k * 1.1, r.k * 0.5, r.k));
        }
      }
    }

    /* ---- marshal posts and sponsor boards, per circuit ---- */
    for (const cir of this.circuits) this._buildTrackside(cir);
  }

  /**
   * What stands beside one circuit: marshal posts, sponsor boards, and whatever
   * the circuit's theme puts against its barrier.
   *
   * The theme is one pass rather than three separate builders because the
   * placement rule is identical in each case - walk the samples, offset past
   * the sealed surface, drop a thing - and only the thing changes. A gorge gets
   * cliff blocks, a highland gets pylons and wind masts, the coast gets nothing
   * extra because it already has a city.
   *
   * @param {object} cir
   */
  _buildTrackside(cir) {
    const co = cir.course;
    const rnd = this.rnd;
    const B = new Batch({ ao: 0.34, sky: 0.32, grime: 0.4, span: 2.4 });
    const N = co.count;
    const postEvery = Math.max(1, Math.round(150 / co.step));
    for (let i = 0; i < N; i += postEvery) {
      const w = co.w[i];
      const W = co.W[i];
      const lat = (i / postEvery) % 2 === 0 ? -(W + 3.5) : W + 3.5;
      this._roadPoint(co, i, lat, w, _v1);
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
      this._roadPoint(co, i, lat, w, _v1);
      const yaw = Math.atan2(co.rx[i], co.rz[i]);
      B.box('paint.enamel', 10.2, 1.0, 0.14, _v1.x, _v1.y + 1.55, _v1.z, yaw,
        BOARDS[(i / 5 | 0) % BOARDS.length]);
    }

    if (cir.def.dressing === 'gorge') {
      /* Cut rock, stacked against the outside of the barrier where the run-off
       * is narrow. Blocks rather than a wall: the quarry was cut in benches and
       * a bench reads at speed, where a smooth face reads as a tunnel. */
      const step = Math.max(1, Math.round(9 / co.step));
      for (let i = 0; i < N; i += step) {
        if (co.vg[i] > 7.5) continue;                 // only the gorge sections
        const w = co.w[i];
        const W = co.W[i];
        const k = co.curv[i];
        // Outside of the corner, where a car that lost it would arrive.
        const side = -Math.sign(k || 1);
        const yaw = Math.atan2(co.rx[i], co.rz[i]);
        for (let b = 0; b < 3; b++) {
          const lat = side * (W + 1.4 + b * 1.9);
          this._roadPoint(co, i, lat, w, _v1);
          const h = 3.4 + b * 2.6 + rnd() * 1.8;
          B.box('dirt.ground', 4.2, h, 3.0 + rnd() * 1.4,
            _v1.x, _v1.y + h * 0.5 - 0.6, _v1.z, yaw + rnd() * 0.25,
            b === 0 ? 0xa89684 : 0x9c8b78);
        }
        const lat = side * (W + 1.4);
        this._roadPoint(co, i, lat, w, _v1);
        this.track(this.physics.addRotatedBox(
          _v2.set(_v1.x, _v1.y + 2.4, _v1.z), _v3.set(2.1, 3.0, 1.6), yaw));
      }
    } else if (cir.def.dressing === 'highland') {
      /* Pylons and wind masts on the ridge line: this circuit's middle distance
       * is sky, and sky needs something standing in it to have any scale. */
      const step = Math.max(1, Math.round(78 / co.step));
      for (let i = 0; i < N; i += step) {
        const w = co.w[i];
        const W = co.W[i];
        const side = (i / step) % 2 === 0 ? 1 : -1;
        const lat = side * (W + 26 + rnd() * 14);
        this._roadPoint(co, i, lat, w, _v1);
        const gy = this.courseSet.surfaceHeight(_v1.x, _v1.z);
        const yaw = Math.atan2(co.rx[i], co.rz[i]) + rnd();
        if ((i / step) % 3 === 0) {
          // Wind mast: a tower and three blades, as flat boxes. It is 200 m away.
          const h = 26 + rnd() * 10;
          B.box('metal.rail', 1.5, h, 1.5, _v1.x, gy + h * 0.5, _v1.z, yaw, 0xdfe3e6);
          B.box('metal.panel', 2.6, 2.2, 2.6, _v1.x, gy + h + 0.8, _v1.z, yaw, 0xc8ced2);
          for (let bl = 0; bl < 3; bl++) {
            const a = yaw + (bl / 3) * TAU;
            B.box('paint.white', 1.3, 14, 0.5,
              _v1.x + Math.cos(a) * 7, gy + h + 0.8 + Math.sin(a) * 7, _v1.z, a, 0xf2f4f6);
          }
          this.track(this.physics.addBox(_v1.x, gy + h * 0.5, _v1.z, 0.9, h * 0.5, 0.9));
        } else {
          // Lattice pylon: two legs, a waist and two crossarms.
          const h = 20 + rnd() * 7;
          for (const sgn of [-1, 1]) {
            B.box('metal.trim', 0.7, h, 0.7,
              _v1.x + Math.cos(yaw) * sgn * 2.6, gy + h * 0.5,
              _v1.z - Math.sin(yaw) * sgn * 2.6, yaw, 0x8f989e);
          }
          B.box('metal.trim', 6.4, 0.6, 0.6, _v1.x, gy + h * 0.62, _v1.z, yaw, 0x8f989e);
          B.box('metal.trim', 13.5, 0.55, 0.55, _v1.x, gy + h - 1.5, _v1.z, yaw, 0x99a1a6);
          B.box('metal.trim', 10.5, 0.55, 0.55, _v1.x, gy + h - 5.5, _v1.z, yaw, 0x99a1a6);
          this.track(this.physics.addBox(_v1.x, gy + h * 0.5, _v1.z, 3.2, h * 0.5, 1.0));
        }
      }
    }

    B.flush(this.group, (k) => this._mat(k), `trackside.${cir.id}`);
    B.dispose();
  }

  /**
   * InstancedMeshes from a prototype geometry and a placement list, split into
   * a grid of tiles.
   *
   * ── Why this is not one mesh ─────────────────────────────────────────────
   *
   * An InstancedMesh is culled as a *unit*: one bounding sphere around every
   * instance in it. Spread 2 400 conifers over a 1 320 m map in a single mesh
   * and that sphere covers the world, so the whole forest - about 2.9 million
   * triangles - is submitted on every frame from every camera angle, including
   * the ones pointing at an empty quarry. There is no per-instance culling in
   * Three and adding one costs more CPU than it saves.
   *
   * Tiling by position gives the culler something to work with: at 300 m a
   * camera with 760 m of fog sees four or five tiles out of twenty-five, and
   * the rest are rejected by a sphere test each. The cost is a draw call per
   * occupied tile, which is the trade this world can afford - it was already
   * running about 1 200 and the terrain is only two of them.
   *
   * ── Why the tiles are also the LOD unit ──────────────────────────────────
   *
   * The same split pays twice. A tile is the smallest thing the culler can
   * reject, and it is also the smallest thing a distance band can demote - so
   * `lo`/`swapBeyond` ride on the structure that already exists rather than
   * needing a second one. The band is measured to the nearest point of the
   * tile's sphere, which is the only measure a "nothing closer than D changed"
   * claim can be made from; see {@link CONIFER_LO_DISTANCE}.
   *
   * @param {{lo?:THREE.BufferGeometry, swapBeyond?:number}} [lod] cheap
   *   geometry for the far field. Must be interchangeable with `geo` - same
   *   origin, same axis, same overall silhouette - because the swap happens
   *   under a moving camera with nothing to cover it.
   * @returns {THREE.InstancedMesh[]} one per occupied tile
   */
  _instance(geo, key, list, name, tint = 0xffffff, cast = true, recv = true, lod = null) {
    if (!list.length) return [];
    const mat = this._mat(key, { vertexColors: false }).clone();
    mat.color = new THREE.Color(tint);
    this._owned.push(mat);

    const TILE = 300;
    const cols = Math.max(1, Math.ceil((HALF * 2) / TILE));
    /** @type {Map<number, Array<object>>} */
    const tiles = new Map();
    for (const p of list) {
      const cx = clamp(Math.floor((p.x + HALF) / TILE), 0, cols - 1);
      const cz = clamp(Math.floor((p.z + HALF) / TILE), 0, cols - 1);
      const k = cz * cols + cx;
      let bucket = tiles.get(k);
      if (!bucket) tiles.set(k, (bucket = []));
      bucket.push(p);
    }

    const out = [];
    for (const [k, bucket] of tiles) {
      const mesh = new THREE.InstancedMesh(geo, mat, bucket.length);
      mesh.name = `${name}.${k}`;
      mesh.castShadow = cast;
      mesh.receiveShadow = recv;
      for (let i = 0; i < bucket.length; i++) {
        const p = bucket[i];
        _e1.set(0, p.yaw, 0);
        _q1.setFromEuler(_e1);
        _v1.set(p.x, p.y, p.z);
        _v2.setScalar(p.k);
        _m1.compose(_v1, _q1, _v2);
        mesh.setMatrixAt(i, _m1);
      }
      mesh.instanceMatrix.needsUpdate = true;
      // Three computes an InstancedMesh's bounding sphere from the instance
      // matrices, but only when it is asked; without this the mesh keeps the
      // prototype geometry's sphere at the origin and every tile but the middle
      // one is culled away.
      mesh.computeBoundingSphere();
      this.group.add(mesh);
      /* Registered per tile, not per prototype: each tile is at its own
       * distance and makes its own decision, and `DistanceLod` only ever
       * writes `mesh.geometry`, so the two prototypes stay shared across
       * however many tiles are wearing them. */
      if (lod?.lo) {
        this._lod.add(mesh, {
          lo: lod.lo, swapBeyond: lod.swapBeyond ?? Infinity, measure: SURFACE,
        });
      }
      out.push(mesh);
    }
    this._owned.push(geo);
    if (lod?.lo) this._owned.push(lod.lo);
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* The published contract                                              */
  /* ------------------------------------------------------------------ */

  /**
   * One circuit's share of the contract: centreline, checkpoints, grid.
   *
   * Written into the circuit's own record rather than onto the world, because
   * three circuits cannot share one `trackPath`. {@link selectTrack} is what
   * puts one of them on the published fields.
   *
   * @param {object} cir
   */
  _fillCircuit(cir) {
    const co = cir.course;
    const N = co.count;

    /* ---- centreline, decimated to ~6 m ---- */
    const stride = Math.max(1, Math.round(6 / co.step));
    for (let i = 0; i < N; i += stride) {
      cir.trackPath.push({ x: co.x[i], y: co.y[i], z: co.z[i], width: co.w[i] });
    }

    /* ---- checkpoints, evenly spaced by arc length ---- */
    const CP = 18;
    for (let k = 0; k < CP; k++) {
      const i = co.indexAt((k / CP) * co.length);
      cir.checkpoints.push({
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

    /* ---- the loop's checkpoint ----------------------------------------
     *
     * The loop is mandatory, and this is what makes it so rather than a sign
     * saying it is. The apex checkpoint sits 2R above the road with a tight
     * vertical gate, so the only way to validate it is to have been over the
     * top: a car on the tarmac underneath is 30 m below the gate and the swept
     * test rejects it however many times it drives through.
     *
     * Inserted in arc-length order so the cursor still walks the lap in
     * sequence - see RaceManager's header on why a lap is an ordered sequence
     * and not a line crossing. */
    if (cir.loop) {
      const apex = cir.loop.apex;
      const at = cir.loop.sMid;
      let insert = cir.checkpoints.length;
      for (let k = 0; k < cir.checkpoints.length; k++) {
        const s = co.nearest(cir.checkpoints[k].x, cir.checkpoints[k].z)?.s ?? 0;
        if (s > at) { insert = k; break; }
      }
      cir.checkpoints.splice(insert, 0, {
        x: apex.x, y: apex.y, z: apex.z,
        radius: Math.max(9, cir.loop.width * 0.9),
        yGate: cir.loop.radius * 0.7,
        loop: true,
      });
    }

    /* ---- start grid: ten rows of two, staggered ----
     * Twenty slots so the hard field (20 cars) has a real grid to line up on;
     * easy and medium simply use the front of it. */
    for (let k = 0; k < 20; k++) {
      const rowIdx = k >> 1;
      const col = k & 1;
      // Behind the line, and behind the gantry legs.
      const s = co.length - (16 + rowIdx * 9 + col * 4.5);
      const lat = col === 0 ? -4.8 : 4.8;
      const g = co.pointAt(((s % co.length) + co.length) % co.length, lat);
      cir.startGrid.push({
        x: g.x, y: g.y, z: g.z,
        // Characters and mounts look down -Z at yaw 0.
        yaw: Math.atan2(-g.dx, -g.dz),
      });
    }
    // Painted boxes under each slot.
    const B = new Batch({ ao: 0.2, sky: 0.2, grime: 0.2, span: 1 });
    for (const slot of cir.startGrid) {
      for (const [ox, oz, w, d] of [[0, -2.6, 3.6, 0.22], [0, 2.6, 3.6, 0.22],
        [-1.8, 0, 0.22, 5.4], [1.8, 0, 0.22, 5.4]]) {
        const cs = Math.cos(slot.yaw);
        const sn = Math.sin(slot.yaw);
        B.box('paint.white', w, 0.05, d,
          slot.x + cs * ox + sn * oz, slot.y + 0.03, slot.z - sn * ox + cs * oz,
          slot.yaw, 0xf4f4f2);
      }
    }
    B.flush(this.group, (k) => this._mat(k), `grid.${cir.id}`);
    B.dispose();

    /* ---- what the picker shows ----
     *
     * Length, climb and corner count are *measured*, never authored. A number
     * typed into a blurb is right on the day the layout is written and wrong
     * the first time a control point moves half a metre, and a picker that
     * quietly lies about how long a circuit is is worse than one that says
     * nothing. The theme word is the only text a human writes. */
    const corners = this._cornersOf(co);
    this.tracks.push({
      id: cir.id,
      name: cir.name,
      kicker: `${cir.def.kicker} · ${(co.length / 1000).toFixed(1)} km · ${corners} corners`,
      blurb: cir.def.blurb,
      corners,
      length: co.length,
      laps: { ...cir.laps },
      minRadius: co.minRadius,
      climb: this._climbOf(co),
      hasLoop: !!cir.loop,
      accent: cir.def.accent ?? 0x52e9ff,
    });

    console.info(
      `[RaceWorld] ${cir.name}: ${cir.trackPath.length} path samples, ` +
      `${cir.checkpoints.length} checkpoints, ${cir.startGrid.length} grid slots` +
      (cir.loop ? ', 1 loop' : '')
    );
  }

  /**
   * How many corners a circuit has.
   *
   * A corner is a run of samples whose curvature stays above a threshold and
   * keeps its sign - so a long constant-radius sweeper counts once, and an esse
   * counts twice because the sign flips between them, which is how a driver
   * counts them too. The threshold is a 220 m radius, which at this car's grip
   * budget is the point where a corner stops being a kink you can ignore.
   */
  _cornersOf(co) {
    const MIN_K = 1 / 220;
    let n = 0;
    let sign = 0;
    let run = 0;
    // Enough samples that a single noisy one cannot open or close a corner.
    const NEED = Math.max(2, Math.round(8 / co.step));
    for (let i = 0; i < co.count; i++) {
      const k = co.curv[i];
      const s = Math.abs(k) > MIN_K ? Math.sign(k) : 0;
      if (s !== 0 && s === sign) {
        run++;
        if (run === NEED) n++;
      } else {
        sign = s;
        run = s === 0 ? 0 : 1;
      }
    }
    return n;
  }

  /** Metres between the lowest and highest point of a circuit. */
  _climbOf(co) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < co.count; i++) {
      if (co.y[i] < lo) lo = co.y[i];
      if (co.y[i] > hi) hi = co.y[i];
    }
    return hi - lo;
  }

  /**
   * Everything that belongs to the world rather than to one circuit: where the
   * player arrives, the portal home, who is standing about, and the baked
   * minimap.
   */
  _finishWorld() {
    // The player arrives at Vellum Ridge, which is where the portal is and the
    // only circuit with a paddock to arrive into. The other two are reached by
    // driving, or by starting a race on them - `start` puts you on their grid.
    const home = this.circuits[0];
    const co = home.course;
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

    const F = (c, name, persona, s, lat) => {
      const cc = c.course;
      const g = cc.pointAt(((s % cc.length) + cc.length) % cc.length, lat);
      return {
        position: new THREE.Vector3(g.x, g.y + 0.2, g.z),
        type: 'friendly',
        name,
        persona,
      };
    };
    this.npcSpawns.push(
      F(home, 'Marek Vaisey', 'Chief scrutineer at Vellum Ridge; has timed every lap run here for thirty years.', co.length - 60, -(W + 20)),
      F(home, 'Ines Okonjo', 'Runs the tyre bay in garage four; reads a set of worn fronts like a paragraph.', co.length - 20, -(W + 22)),
      F(home, 'Devrim Aslan', 'Track marshal, ridge sector; knows exactly where the circuit bites.', co.length * 0.42, -(W + 6)),
      F(home, 'Halla Brandt', 'Timekeeper in the gantry; speaks in tenths and does not exaggerate.', 30, W + 8)
    );
    /* One voice at each of the other two, so arriving at a circuit by driving
     * there is not arriving somewhere abandoned. */
    const gorge = this.circuits.find((c) => c.id === 'cinder');
    const rise = this.circuits.find((c) => c.id === 'aurora');
    if (gorge) {
      this.npcSpawns.push(F(gorge, 'Petra Halvorsen',
        'Runs Cinder Gorge out of a timing box the size of a shed; blasted half the quarry herself and knows which bench moves.',
        gorge.course.length - 30, -(gorge.course.W[0] + 9)));
    }
    if (rise) {
      this.npcSpawns.push(F(rise, 'Tobias Renn',
        'Loop marshal at Aurora Rise; has watched four thousand cars go over the top and can tell from the engine note who will not make it.',
        rise.loop ? rise.loop.sIn - 25 : 40, -(rise.course.W[0] + 9)));
    }

    /* ---- minimap ----
     *
     * Deliberately no circuit outline here. `minimapShapes` is rasterised once
     * into a baked floorplan, and the race systems draw `trackPath` live on top
     * of it - so baking the same loop underneath would double-stroke it, at two
     * slightly different widths, for the whole race. What is baked is only what
     * nothing else draws: the ground, the city block, and a dot at each start
     * line so the two circuits you are not racing are still findable. */
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
    for (const cir of this.circuits) {
      this.minimapShapes.push(
        { kind: 'circle', x: cir.course.x[0], z: cir.course.z[0], r: 9, fill: 0xf0f0ee }
      );
    }

    /* Publish one. Until this runs, `trackPath` is the empty array the
     * constructor made and `RaceManager.arm` correctly reads "no circuit
     * here" - which is the state the world must never be left in. */
    this.selectTrack(this.activeTrackId);

    console.info(
      `[RaceWorld] ${this.circuits.length} circuits, colliders: ${this._terrainColliders} terrain / ` +
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
    /* The *nearest* circuit, not the selected one.
     *
     * Every caller of this is asking a question about the ground under a
     * position - how far off the road is it, which way does the road run here -
     * and answering with a circuit 600 m away would be worse than answering
     * nothing. A racer is on its own circuit by construction, so the two agree
     * during a race and only differ when somebody is driving between them. */
    const co = this.courseSet?.courseAt(x, z) ?? this.course;
    const nr = co?.nearest(x, z);
    if (!nr) return null;
    return {
      index: nr.i,
      distance: nr.d,
      lateral: nr.lat,
      width: nr.w,
      surface: co.crossFall(nr),
      arcLength: nr.s,
    };
  }

  /** Ground height from the same function every collider was built from. */
  surfaceAt(x, z) {
    return this.courseSet ? this.courseSet.surfaceHeight(x, z) : 0;
  }

  /* ------------------------------------------------------------------ */
  /* Frame                                                               */
  /* ------------------------------------------------------------------ */

  update(dt) {
    this._time += dt;
    /* Only runs while this world is active - `WorldManager` does not update a
     * backgrounded world - so a built-but-parked Race costs nothing. */
    this._lod.update(this.engine.camera);
  }

  dispose() {
    /* Before the geometries go: `clear` puts every registration back on its hi
     * geometry, so nothing is left holding a reference to a lo buffer that is
     * about to be disposed. */
    this._lod.clear();
    for (const g of this._owned) g.dispose?.();
    this._owned.length = 0;
    for (const cir of this.circuits) {
      cir.trackPath.length = 0;
      cir.startGrid.length = 0;
      cir.checkpoints.length = 0;
      cir.course = null;
      cir.startLights = null;
    }
    this.circuits.length = 0;
    this.tracks.length = 0;
    // These alias a circuit's arrays, which have just been emptied; drop the
    // references too so a stale contract cannot be read off a disposed world.
    this.trackPath = [];
    this.startGrid = [];
    this.checkpoints = [];
    this._matCache?.clear();
    this.courseSet = null;
    this.course = null;
    super.dispose();
  }
}

export default RaceWorld;
