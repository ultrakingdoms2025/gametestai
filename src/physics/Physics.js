import * as THREE from 'three';

/**
 * Lightweight deterministic collision world.
 *
 * Worlds register static geometry as boxes (oriented), spheres, or triangle
 * soups. Characters are capsules resolved with iterative collide-and-slide,
 * which is what shooters actually want: no jitter, reliable step-up, and no
 * dependency on a full rigid-body engine we would only use 5% of.
 *
 * Broadphase is a uniform grid over the XZ plane - worlds here are large but
 * flat-ish, so a 2D grid beats an octree for both build and query cost.
 */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const _box = new THREE.Box3();
// Private to the raycast path so it can never alias a caller-supplied ray.
const _rc1 = new THREE.Vector3();
const _rc2 = new THREE.Vector3();
const _gh1 = new THREE.Vector3();
const _gh2 = new THREE.Vector3();
// Private to closestPointOnTriangle - see the note in that function.
const _ct1 = new THREE.Vector3();
const _ct2 = new THREE.Vector3();
const _ct3 = new THREE.Vector3();
const _ct4 = new THREE.Vector3();
const _ct5 = new THREE.Vector3();
const _ct6 = new THREE.Vector3();
// Private to the mesh branch of _closestPoint, which previously allocated four
// vectors per collider per frame in the capsule hot path.
const _cp1 = new THREE.Vector3();
const _cp2 = new THREE.Vector3();
const _cp3 = new THREE.Vector3();
const _cp4 = new THREE.Vector3();
// Private to the heightfield branches, for the same aliasing reason as _cp*.
const _hf1 = new THREE.Vector3();
const _hf2 = new THREE.Vector3();
const _hf3 = new THREE.Vector3();
const _hf4 = new THREE.Vector3();
const _hfCorners = new Float64Array(12);
// Private to the heightfield raycast, which runs while _rc1/_rc2 are live.
const _hr1 = new THREE.Vector3();
const _hr2 = new THREE.Vector3();
const _hr3 = new THREE.Vector3();
/**
 * Set by `_closestPoint` when the query point was *inside* the collider, in
 * which case the surface point it returns lies outward from the query point
 * rather than inward and the caller must reverse its push. Module-scoped rather
 * than returned so the hot path stays allocation-free; every reader takes a copy
 * immediately after the call that set it.
 */
let _cpInside = false;

export const COLLISION_LAYER = {
  WORLD: 1 << 0,
  PLAYER: 1 << 1,
  NPC: 1 << 2,
  PROJECTILE: 1 << 3,
  TRIGGER: 1 << 4,
  ALL: 0xffff,
};

/** Closest point on a segment AB to point P. */
function closestPointOnSegment(a, b, p, out) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const apx = p.x - a.x, apy = p.y - a.y, apz = p.z - a.z;
  const abLenSq = abx * abx + aby * aby + abz * abz;
  let t = abLenSq > 1e-9 ? (apx * abx + apy * aby + apz * abz) / abLenSq : 0;
  t = Math.min(1, Math.max(0, t));
  return out.set(a.x + abx * t, a.y + aby * t, a.z + abz * t);
}

/** Closest point on a triangle to P (Ericson, Real-Time Collision Detection). */
function closestPointOnTriangle(a, b, c, p, out) {
  // These MUST be private to this function. It is called from deep inside
  // resolveCapsule(), which holds the capsule segment endpoints in _v3/_v4 and
  // the segment centre in _v5 across the call - reusing the general scratch
  // pool here silently corrupts the capsule mid-solve, which manifests as
  // characters sinking through triangle-mesh terrain.
  const ab = _ct1.subVectors(b, a);
  const ac = _ct2.subVectors(c, a);
  const ap = _ct3.subVectors(p, a);
  const d1 = ab.dot(ap);
  const d2 = ac.dot(ap);
  if (d1 <= 0 && d2 <= 0) return out.copy(a);

  const bp = _ct4.subVectors(p, b);
  const d3 = ab.dot(bp);
  const d4 = ac.dot(bp);
  if (d3 >= 0 && d4 <= d3) return out.copy(b);

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return out.copy(a).addScaledVector(ab, v);
  }

  const cp = _ct5.subVectors(p, c);
  const d5 = ab.dot(cp);
  const d6 = ac.dot(cp);
  if (d6 >= 0 && d5 <= d6) return out.copy(c);

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return out.copy(a).addScaledVector(ac, w);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return out.copy(b).addScaledVector(_ct6.subVectors(c, b), w);
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return out.copy(a).addScaledVector(ab, v).addScaledVector(ac, w);
}

// Private to the segment-vs-soup query and its segment-segment helper.
const _sg1 = new THREE.Vector3();
const _sg2 = new THREE.Vector3();
const _sg3 = new THREE.Vector3();
const _sg4 = new THREE.Vector3();
const _sg5 = new THREE.Vector3();
const _sg6 = new THREE.Vector3();
const _sg7 = new THREE.Vector3();
const _sg8 = new THREE.Vector3();
const _sg9 = new THREE.Vector3();

/**
 * Closest points between segments p1q1 and p2q2 (Ericson, Real-Time Collision
 * Detection 5.1.9). Returns the squared distance; `out1` and `out2` receive the
 * closest point on each segment.
 */
function closestPtSegmentSegment(p1, q1, p2, q2, out1, out2) {
  const d1 = _sg1.subVectors(q1, p1);
  const d2 = _sg2.subVectors(q2, p2);
  const r = _sg3.subVectors(p1, p2);
  const a = d1.dot(d1);
  const e = d2.dot(d2);
  const f = d2.dot(r);
  const EPS = 1e-12;
  let s, t;

  if (a <= EPS && e <= EPS) {
    s = 0;
    t = 0;
  } else if (a <= EPS) {
    s = 0;
    t = Math.min(1, Math.max(0, f / e));
  } else {
    const c = d1.dot(r);
    if (e <= EPS) {
      t = 0;
      s = Math.min(1, Math.max(0, -c / a));
    } else {
      const b = d1.dot(d2);
      const denom = a * e - b * b;
      s = denom !== 0 ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.min(1, Math.max(0, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.min(1, Math.max(0, (b - c) / a));
      }
    }
  }
  out1.copy(p1).addScaledVector(d1, s);
  out2.copy(p2).addScaledVector(d2, t);
  return out1.distanceToSquared(out2);
}

// Private to the triangle-soup branch of _raycastCollider. Chunked geometry
// offers that branch hundreds of colliders per ray, so nothing in it may
// allocate.
const _mr1 = new THREE.Vector3();
const _mr2 = new THREE.Vector3();
const _mr3 = new THREE.Vector3();
const _mr4 = new THREE.Vector3();
const _mr5 = new THREE.Vector3();
const _mr6 = new THREE.Vector3();
const _mr7 = new THREE.Vector3();
const _mr8 = new THREE.Vector3();
const _mr9 = new THREE.Vector3();

// Scratch for rayTriangle and the heightfield hit-normal, which run while the
// general pool and the raycast pool are both live.
const _rt1 = new THREE.Vector3();
const _rt2 = new THREE.Vector3();
const _rt3 = new THREE.Vector3();
const _rt4 = new THREE.Vector3();
const _rt5 = new THREE.Vector3();

/**
 * Moller-Trumbore. Returns the ray parameter of the hit, or -1 for a miss.
 * Back faces count: terrain is walked from underneath during recovery, and a
 * one-sided test there reports open sky.
 */
function rayTriangle(a, b, c, origin, direction, maxT) {
  const edge1 = _rt1.subVectors(b, a);
  const edge2 = _rt2.subVectors(c, a);
  const h = _rt3.crossVectors(direction, edge2);
  const det = edge1.dot(h);
  if (Math.abs(det) < 1e-12) return -1;
  const invDet = 1 / det;
  const s = _rt4.subVectors(origin, a);
  const u = invDet * s.dot(h);
  if (u < 0 || u > 1) return -1;
  const q = _rt5.crossVectors(s, edge1);
  const v = invDet * direction.dot(q);
  if (v < 0 || u + v > 1) return -1;
  const t = invDet * edge2.dot(q);
  return t > 1e-5 && t < maxT ? t : -1;
}

/**
 * A static collider. Worlds build these; physics never mutates them.
 * `type` is one of 'box' | 'sphere' | 'mesh' | 'heightfield'.
 */
export class Collider {
  constructor(type, opts = {}) {
    this.type = type;
    this.layer = opts.layer ?? COLLISION_LAYER.WORLD;
    this.userData = opts.userData ?? null;
    /** Blocks movement. Set false for pure triggers/raycast targets. */
    this.solid = opts.solid ?? true;

    /**
     * Which named world object this collider belongs to, or null when nothing
     * claimed it.
     *
     * ── Why a collider needs to know ─────────────────────────────────────────
     * A world's visuals and its collision are separate structures: `Physics`
     * stores baked WORLD-SPACE geometry with no back-reference to the
     * `Object3D` it came from. That is deliberate and it is what makes the
     * broadphase cheap. But the map editor has to answer "which colliders are
     * this object's?" for every move and every remove, and with no
     * back-reference it could only GUESS - by geometry.
     *
     * The two guesses it makes disagree, and both are wrong in their own
     * direction. A remove takes colliders FULLY INSIDE the object's box, so it
     * misses anything overhanging and refuses outright past 200 (`span`,
     * because a district Group's box is the union of everything in it). A move
     * takes colliders whose CENTRE is in the box, uncapped - which on the
     * station meant 236 of 744 named objects would drag more colliders than a
     * remove is even allowed to consider, and `space` would drag all 26,352 in
     * the world.
     *
     * An owner id ends the guessing where it is known. It is the NAME of the
     * nearest named ancestor - the same string the editor addresses the object
     * by, which is why the names had to be made stable first. Colliders derived
     * from drawn geometry carry it; hand-authored ones mostly do not yet, and
     * null is the honest answer there: it means "fall back to geometry", not
     * "belongs to nobody".
     *
     * Never write this after registration. The grid indexes by position, not by
     * owner, so ownership is metadata the broadphase does not read - but the
     * editor's undo does, and a collider that changed hands mid-session could
     * not be put back.
     * @type {string|null}
     */
    this.ownerId = opts.ownerId ?? null;

    if (type === 'heightfield') {
      /* A regular grid of surface heights, treated as a solid volume from the
       * surface down to `baseY`.
       *
       * This exists because the alternative - one oriented box per terrain cell -
       * grows with world *area*. A 400x400 m world at a 4 m cell is 10,000
       * colliders and about 5 MB; the same world ten times wider is a million
       * colliders and over half a gigabyte, which is simply not reachable. The
       * heightfield stores one float per sample instead: the same 400 m world is
       * 40 KB, and the ten-times-wider one is 4 MB.
       *
       * Sampling is planar-interpolated across the *same* triangulation the
       * collision and mesh use (diagonal from corner 00 to corner 11), so the
       * height reported by `sampleHeight` is exactly the height of the triangle
       * a ray or capsule will hit. That identity is the whole reason terrain and
       * collision cannot drift apart here. */
      this.heights = opts.heights;
      this.nx = opts.nx;
      this.nz = opts.nz;
      this.originX = opts.originX;
      this.originZ = opts.originZ;
      this.stepX = opts.stepX;
      this.stepZ = opts.stepZ ?? opts.stepX;
      /**
       * Optional per-*cell* mask, `(nx-1) * (nz-1)` bytes, 1 meaning "no surface
       * here". This is what lets a single field have a swimming pool or a skate
       * bowl punched through it instead of sealing them shut.
       *
       * Per cell rather than per sample deliberately: marking *samples* as holes
       * would force every cell touching the boundary to be discarded too (its
       * corner heights would be meaningless), eroding a cell-wide gap around the
       * opening that the player falls straight through.
       * @type {Uint8Array|null}
       */
      this.holes = opts.holes ?? null;

      let lo = Infinity;
      let hi = -Infinity;
      if (opts.minY == null || opts.maxY == null) {
        const h = this.heights;
        for (let i = 0; i < h.length; i++) {
          const v = h[i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      this.minY = opts.minY ?? lo;
      this.maxY = opts.maxY ?? hi;
      /* How far below the surface still counts as solid. Deep enough that a
       * character who tunnels is recovered upward rather than falling through,
       * shallow enough that it never becomes the answer to a ground query in a
       * cave or under a deck. */
      this.baseY = opts.baseY ?? this.minY - 50;

      this.sizeX = (this.nx - 1) * this.stepX;
      this.sizeZ = (this.nz - 1) * this.stepZ;
      this.center = new THREE.Vector3(
        this.originX + this.sizeX * 0.5,
        (this.minY + this.maxY) * 0.5,
        this.originZ + this.sizeZ * 0.5
      );
      this.boundingRadius =
        Math.hypot(this.sizeX, this.maxY - this.minY, this.sizeZ) * 0.5;
    } else if (type === 'box') {
      // Oriented box: half-extents + world matrix.
      this.halfExtents = opts.halfExtents.clone();
      this.matrix = opts.matrix.clone();
      this.inverse = new THREE.Matrix4().copy(this.matrix).invert();
      this.center = new THREE.Vector3().setFromMatrixPosition(this.matrix);
      const maxExtent = this.halfExtents.length();
      // Conservative bounding sphere for broadphase.
      this.boundingRadius = maxExtent;
    } else if (type === 'sphere') {
      this.center = opts.center.clone();
      this.radius = opts.radius;
      this.boundingRadius = opts.radius;
    } else if (type === 'mesh') {
      // Flat array of triangle vertices in world space: [ax,ay,az, bx,by,bz, cx,cy,cz, ...]
      this.positions = opts.positions;
      this.bounds = opts.bounds ?? new THREE.Box3().setFromArray(opts.positions);
      this.center = this.bounds.getCenter(new THREE.Vector3());
      this.boundingRadius = this.bounds.getSize(_v1).length() * 0.5;
    }
  }

  /* ---- heightfield sampling ---------------------------------------- */

  /** True when (x,z) falls inside this heightfield's footprint. */
  containsColumn(x, z) {
    return (
      x >= this.originX &&
      z >= this.originZ &&
      x <= this.originX + this.sizeX &&
      z <= this.originZ + this.sizeZ
    );
  }

  /**
   * Surface height at (x,z), or `null` outside the footprint.
   *
   * Interpolates across the same two triangles the collision uses rather than
   * doing a plain bilinear blend. Bilinear disagrees with the triangles by up to
   * half the cell's diagonal sag, and every disagreement between the height a
   * prop is placed at and the height the player collides with is a floating or
   * half-buried prop.
   */
  sampleHeight(x, z) {
    const nx = this.nx;
    const fx = (x - this.originX) / this.stepX;
    const fz = (z - this.originZ) / this.stepZ;
    if (fx < 0 || fz < 0 || fx > nx - 1 || fz > this.nz - 1) return null;

    let i = Math.floor(fx);
    let j = Math.floor(fz);
    if (i > nx - 2) i = nx - 2;
    if (j > this.nz - 2) j = this.nz - 2;
    if (this.holes !== null && this.holes[j * (nx - 1) + i]) return null;
    const tx = fx - i;
    const tz = fz - j;

    const h = this.heights;
    const r0 = j * nx + i;
    const r1 = r0 + nx;
    const h00 = h[r0];
    const h10 = h[r0 + 1];
    const h01 = h[r1];
    const h11 = h[r1 + 1];

    // Diagonal runs 00 -> 11, matching `_cellTriangle` below.
    return tz > tx
      ? h00 + (h01 - h00) * (tz - tx) + (h11 - h00) * tx
      : h00 + (h10 - h00) * (tx - tz) + (h11 - h00) * tz;
  }

  /**
   * Write the corners of cell (i,j) into a 12-float scratch array as two
   * triangles' worth of shared vertices: [x0,y00,z0, x0,y01,z1, x1,y11,z1, x1,y10,z0].
   * Triangles are (0,1,2) and (0,2,3).
   */
  cellCorners(i, j, out) {
    const nx = this.nx;
    const x0 = this.originX + i * this.stepX;
    const z0 = this.originZ + j * this.stepZ;
    const x1 = x0 + this.stepX;
    const z1 = z0 + this.stepZ;
    const r0 = j * nx + i;
    const r1 = r0 + nx;
    const h = this.heights;
    out[0] = x0; out[1] = h[r0]; out[2] = z0;
    out[3] = x0; out[4] = h[r1]; out[5] = z1;
    out[6] = x1; out[7] = h[r1 + 1]; out[8] = z1;
    out[9] = x1; out[10] = h[r0 + 1]; out[11] = z0;
    return out;
  }
}

export class Physics {
  constructor(bus) {
    this.bus = bus;
    /** @type {Collider[]} */
    this.colliders = [];
    /**
     * collider -> its index in `colliders`.
     *
     * Removal used to `indexOf` a ten-thousand-entry array, four hundred times
     * per streamed district. This makes it a map lookup and a swap. The array
     * itself stays, because `WorldManager` iterates it on every activation and
     * the broadphase relies on it.
     * @type {Map<Collider, number>}
     */
    this._index = new Map();
    /** Dynamic character proxies, used for character-vs-character pushout and raycasts. */
    this.characters = new Set();

    this.cellSize = 12;
    /** @type {Map<number, Collider[]>} */
    this._grid = new Map();
    this._queryCache = [];
    /** Separate from `_queryCache` so a containment test cannot clobber a live capsule query. */
    this._containCache = [];

    /**
     * Heightfields are held outside the broadphase grid.
     *
     * One heightfield spans an entire world, so inserting it into the grid the
     * normal way would push it into every one of the ~1,100 cells a 400 m world
     * covers - and into 110,000 cells once a world is ten times wider. It would
     * also be returned by every query with no filtering benefit whatsoever.
     * There is never more than a handful per world, so a linear XZ-overlap test
     * against this list is strictly cheaper than grid membership.
     * @type {Collider[]}
     */
    this.heightfields = [];

    /**
     * How many broadphase cells have ever been written, for the lifetime of
     * this instance.
     *
     * Wall clock on this machine has been caught reporting the same work as
     * 700 ms and as 14,700 ms, so a timing that moves is not on its own
     * evidence that the WORK moved. This counter is exact and reproducible:
     * one increment per (collider, cell) pair pushed into the grid. A change
     * that claims to stop rebuilding the broadphase has to show this number
     * falling, not just a faster frame.
     */
    this.gridWrites = 0;
  }

  clear() {
    this.colliders.length = 0;
    this._index.clear();
    this.heightfields.length = 0;
    this._grid.clear();
    this.characters.clear();
  }

  _cellKey(cx, cz) {
    // Cantor-ish pack; worlds stay well inside +-2048 so 12 bits per axis is plenty.
    return ((cx + 2048) << 13) | (cz + 2048);
  }

  /**
   * Derive a collider's broadphase cell range.
   *
   * Shared by `_insertToGrid` and `remove` so there is exactly one place that
   * knows how a collider maps to cells. If insertion and removal ever
   * computed this independently and drifted, `remove` would silently miss
   * buckets that `_insertToGrid` had written to - the collider would come out
   * of `colliders` but stay a ghost in the grid, still answering queries.
   *
   * @param {Collider} collider
   * @returns {{ minX: number, maxX: number, minZ: number, maxZ: number }}
   */
  _gridRange(collider) {
    const r = collider.boundingRadius;
    const c = collider.center;
    let loX = c.x - r, hiX = c.x + r, loZ = c.z - r, hiZ = c.z + r;

    /* Triangle chunks go in on their true XZ footprint rather than their
     * bounding sphere. The grid is indexed on XZ alone, but `boundingRadius`
     * folds in the Y extent, so a 3 m-wide column 24 m tall claims a 24 m
     * square of cells and is handed to every query inside it. Chunking the
     * geometry finely is pointless if the broadphase then smears each chunk
     * back across its neighbours. Boxes and spheres keep the sphere: they are
     * authored roughly cube-ish and the tighter bound would not pay for itself.
     */
    if (collider.type === 'mesh') {
      const b = collider.bounds;
      loX = b.min.x; hiX = b.max.x;
      loZ = b.min.z; hiZ = b.max.z;
    }

    return {
      minX: Math.floor(loX / this.cellSize),
      maxX: Math.floor(hiX / this.cellSize),
      minZ: Math.floor(loZ / this.cellSize),
      maxZ: Math.floor(hiZ / this.cellSize),
    };
  }

  _insertToGrid(collider) {
    const { minX, maxX, minZ, maxZ } = this._gridRange(collider);
    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) {
        const key = this._cellKey(x, z);
        let list = this._grid.get(key);
        if (!list) this._grid.set(key, (list = []));
        list.push(collider);
        this.gridWrites++;
      }
    }
  }

  /** @param {Collider} collider */
  add(collider) {
    /* Idempotent, because `remove` swap-pops by the `_index` entry: a collider
     * added twice has ONE index, so removing it once leaves the duplicate in
     * `colliders` with no index at all - permanently solid, unremovable, and
     * reported ABSENT by `has()`. The editor's undo rests on
     * `physics.remove(collider) === true` meaning "it was registered here", so
     * a ghost is exactly the shape of bug it cannot recover from.
     *
     * Nothing dedupes upstream: `World.track` pushes into a plain array and
     * `WorldManager._activate` re-adds every element unconditionally after
     * `physics.clear()`, so a single double-`track()` would re-create the
     * double registration on every world entry. */
    if (this._index.has(collider)) return collider;

    this.colliders.push(collider);
    this._index.set(collider, this.colliders.length - 1);
    if (collider.type === 'heightfield') this.heightfields.push(collider);
    else this._insertToGrid(collider);
    return collider;
  }

  /**
   * Whether `collider` is registered in THIS physics instance.
   *
   * O(1) on `_index`, which every `add` writes and every `remove` and `clear`
   * drops - so it is the one bookkeeping structure that always agrees with
   * `colliders`. A world's collider objects outlive a world change (the world
   * keeps them for its next visit), so "the object exists" says nothing about
   * whether it is currently solid here; this does.
   *
   * @param {Collider} collider
   * @returns {boolean}
   */
  has(collider) {
    return collider ? this._index.has(collider) : false;
  }

  /**
   * The world-space AABB of a collider, written into `out`.
   *
   * Nothing on a collider carried one before this except `mesh.bounds`: a box
   * is an OBB - half-extents plus a matrix - with only a bounding SPHERE for
   * the broadphase. The |R|·h expansion that turns it into an axis box is
   * inlined in full in Unstuck._solidIndex and PlanetWorld._solidIndex (the
   * pad-return walkability index), and as a yaw-only cos/sin variant in the
   * citadel caves. Those two `_solidIndex` sites are LEFT IN PLACE: they
   * build gridded records, not a Box3, and would gain nothing from a call
   * here. MapOverlay's remove sweep needs the exact box: "this collider's
   * own AABB lies inside that object's box" is the rule that stops a remove
   * of a house taking the fence post beside it.
   *
   * @param {Collider} collider
   * @param {THREE.Box3} [out]
   * @returns {THREE.Box3} `out`; EMPTY for null or an unknown type - and a
   *   caller that tests containment must check `isEmpty()` first, because
   *   three's `Box3.containsBox` holds an empty box inside every box. A
   *   non-finite collider yields a NaN box, which no `containsBox` accepts -
   *   the safe direction.
   */
  colliderAabb(collider, out = new THREE.Box3()) {
    out.makeEmpty();
    if (!collider) return out;
    if (collider.type === 'box') {
      const m = collider.matrix.elements;
      const h = collider.halfExtents;
      const ax = Math.abs(m[0]) * h.x + Math.abs(m[4]) * h.y + Math.abs(m[8]) * h.z;
      const ay = Math.abs(m[1]) * h.x + Math.abs(m[5]) * h.y + Math.abs(m[9]) * h.z;
      const az = Math.abs(m[2]) * h.x + Math.abs(m[6]) * h.y + Math.abs(m[10]) * h.z;
      out.min.set(m[12] - ax, m[13] - ay, m[14] - az);
      out.max.set(m[12] + ax, m[13] + ay, m[14] + az);
    } else if (collider.type === 'sphere') {
      const c = collider.center;
      const r = collider.radius;
      out.min.set(c.x - r, c.y - r, c.z - r);
      out.max.set(c.x + r, c.y + r, c.z + r);
    } else if (collider.type === 'mesh') {
      out.copy(collider.bounds);
    } else if (collider.type === 'heightfield') {
      out.min.set(collider.originX, collider.minY, collider.originZ);
      out.max.set(collider.originX + collider.sizeX, collider.maxY, collider.originZ + collider.sizeZ);
    }
    return out;
  }

  /**
   * Unregister a collider.
   *
   * The counterpart to `add`, and the thing that makes streaming possible: a
   * world that builds and tears down chunks as the player walks needs to drop
   * geometry without wiping everyone else's. Until this existed the only tool
   * was `clear()`, which takes the whole world with it.
   *
   * The broadphase cell range comes from `_gridRange`, the same helper
   * `_insertToGrid` uses, so this touches only the buckets the collider
   * actually occupies rather than scanning the grid. Emptied buckets are
   * deleted outright - a streaming world adds and removes continuously, and
   * leaving empty arrays behind grows the map without bound.
   *
   * @param {Collider} collider
   * @returns {boolean} true if it was registered and has now been removed
   */
  remove(collider) {
    if (!collider) return false;
    const at = this._index.get(collider);
    if (at === undefined) return false;
    /* Swap-remove: move the last collider into the hole rather than shifting
     * everything after it. Nothing depends on `colliders` order - the
     * broadphase grid is a separate structure and WorldManager only iterates
     * to re-register - so paying O(n) to preserve it would buy nothing. */
    const last = this.colliders.pop();
    this._index.delete(collider);
    if (last !== collider) {
      this.colliders[at] = last;
      this._index.set(last, at);
    }

    if (collider.type === 'heightfield') {
      const h = this.heightfields.indexOf(collider);
      if (h >= 0) this.heightfields.splice(h, 1);
      return true;
    }

    const { minX, maxX, minZ, maxZ } = this._gridRange(collider);
    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) {
        const key = this._cellKey(x, z);
        const list = this._grid.get(key);
        if (!list) continue;
        const i = list.indexOf(collider);
        if (i >= 0) list.splice(i, 1);
        if (list.length === 0) this._grid.delete(key);
      }
    }
    return true;
  }

  /**
   * Register a terrain heightfield: one collider for an entire ground surface.
   *
   * `heights` is row-major, `heights[j * nx + i]` being the world Y at
   * `(originX + i * stepX, originZ + j * stepZ)`.
   *
   * @param {{ heights: Float32Array, nx: number, nz: number,
   *           originX: number, originZ: number, stepX: number, stepZ?: number,
   *           minY?: number, maxY?: number, baseY?: number }} opts
   */
  addHeightfield(opts) {
    return this.add(new Collider('heightfield', opts));
  }

  /** Convenience: register an oriented box from a mesh's geometry bounds. */
  addBoxFromObject(object3D, opts = {}) {
    object3D.updateWorldMatrix(true, false);
    const geo = object3D.geometry;
    if (!geo) return null;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const size = geo.boundingBox.getSize(_v1);
    const center = geo.boundingBox.getCenter(_v2);

    // Bake the geometry-local centre offset into the collider matrix.
    _mat.makeTranslation(center.x, center.y, center.z);
    const matrix = new THREE.Matrix4().multiplyMatrices(object3D.matrixWorld, _mat);

    // Object scale is already in matrixWorld, so half-extents stay geometry-local.
    return this.add(
      new Collider('box', {
        halfExtents: new THREE.Vector3(size.x / 2, size.y / 2, size.z / 2),
        matrix,
        ...opts,
      })
    );
  }

  /** Register an axis-aligned box directly in world space. */
  addBox(centerX, centerY, centerZ, halfX, halfY, halfZ, opts = {}) {
    return this.add(
      new Collider('box', {
        halfExtents: new THREE.Vector3(halfX, halfY, halfZ),
        matrix: new THREE.Matrix4().makeTranslation(centerX, centerY, centerZ),
        ...opts,
      })
    );
  }

  /** Register a rotated box (Y rotation is the common case for buildings). */
  addRotatedBox(center, halfExtents, rotationY, opts = {}) {
    const m = new THREE.Matrix4()
      .makeRotationY(rotationY)
      .setPosition(center.x, center.y, center.z);
    return this.add(new Collider('box', { halfExtents: halfExtents.clone(), matrix: m, ...opts }));
  }

  /**
   * Register a chunk of world-space triangles directly.
   *
   * `positions` is `[ax,ay,az, bx,by,bz, cx,cy,cz, ...]` and is kept by
   * reference, so the caller must not reuse the buffer. Intended for geometry
   * derived from what a world actually drew: keep each chunk small (tens of
   * triangles, spatially compact) because a mesh collider has no internal tree
   * and the broadphase can only discriminate down to `cellSize`.
   */
  addTriangleSoup(positions, opts = {}) {
    return this.add(new Collider('mesh', { positions, ...opts }));
  }

  /** Register a triangle mesh (terrain, ramps, complex hulls) baked to world space. */
  addTriangleMesh(mesh, opts = {}) {
    mesh.updateWorldMatrix(true, false);
    const geo = mesh.geometry;
    const posAttr = geo.getAttribute('position');
    if (!posAttr) return null;
    const index = geo.getIndex();
    const count = index ? index.count : posAttr.count;
    const positions = new Float32Array(count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const vi = index ? index.getX(i) : i;
      v.fromBufferAttribute(posAttr, vi).applyMatrix4(mesh.matrixWorld);
      positions[i * 3] = v.x;
      positions[i * 3 + 1] = v.y;
      positions[i * 3 + 2] = v.z;
    }
    return this.add(new Collider('mesh', { positions, ...opts }));
  }

  /**
   * Move an existing box collider vertically in place.
   *
   * Safe for moving platforms / elevators: the broadphase grid is indexed on the
   * XZ plane only (see `_insertToGrid`), so a Y-only translation never changes
   * which cells the collider belongs to. We just refresh the world matrix's Y
   * translation, the cached centre and the inverse used by the capsule solver.
   * The player standing on the box is carried by the normal capsule pushout.
   *
   * @param {Collider} collider box collider previously registered
   * @param {number} y new world-space Y of the box centre
   */
  setBoxColliderY(collider, y) {
    if (!collider || collider.type !== 'box') return;
    // Column-major TRS: translation lives in elements 12,13,14 regardless of the
    // rotation baked into the upper 3x3, so this is correct for rotated boxes too.
    collider.matrix.elements[13] = y;
    collider.center.y = y;
    collider.inverse.copy(collider.matrix).invert();
  }

  /** Colliders whose bounding sphere may overlap a world-space sphere. */
  query(center, radius, out = this._queryCache) {
    out.length = 0;
    const minX = Math.floor((center.x - radius) / this.cellSize);
    const maxX = Math.floor((center.x + radius) / this.cellSize);
    const minZ = Math.floor((center.z - radius) / this.cellSize);
    const maxZ = Math.floor((center.z + radius) / this.cellSize);
    const seen = new Set();
    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) {
        const list = this._grid.get(this._cellKey(x, z));
        if (!list) continue;
        for (const c of list) {
          if (seen.has(c)) continue;
          seen.add(c);
          out.push(c);
        }
      }
    }
    // Heightfields live outside the grid (see the note on `this.heightfields`),
    // so they are matched by footprint instead.
    for (let i = 0; i < this.heightfields.length; i++) {
      const hf = this.heightfields[i];
      if (
        center.x + radius >= hf.originX &&
        center.x - radius <= hf.originX + hf.sizeX &&
        center.z + radius >= hf.originZ &&
        center.z - radius <= hf.originZ + hf.sizeZ
      ) {
        out.push(hf);
      }
    }
    return out;
  }

  /**
   * Surface height from the terrain heightfields alone, ignoring props and
   * buildings. `null` when no heightfield covers (x,z).
   *
   * Far cheaper than `groundHeight` - no ray, no broadphase - so world
   * generation uses it for the tens of thousands of prop placements that only
   * ever want the terrain.
   */
  terrainHeight(x, z) {
    let best = null;
    for (let i = 0; i < this.heightfields.length; i++) {
      const h = this.heightfields[i].sampleHeight(x, z);
      if (h !== null && (best === null || h > best)) best = h;
    }
    return best;
  }

  /**
   * True when `point` is inside solid static geometry - either a box or below a
   * heightfield surface. NPC placement uses this to reject spots buried in a
   * wall or in a hillside, which the cardinal raycasts cannot see because a ray
   * starting inside a convex volume reports no hit.
   */
  containsPoint(point) {
    const near = this.query(point, 0.5, this._containCache);
    for (const c of near) {
      if (!c.solid) continue;
      if (c.type === 'heightfield') {
        const h = c.sampleHeight(point.x, point.z);
        if (h !== null && point.y < h && point.y > c.baseY) return true;
      } else if (c.type === 'box') {
        const local = _hf1.copy(point).applyMatrix4(c.inverse);
        const e = c.halfExtents;
        if (
          Math.abs(local.x) <= e.x &&
          Math.abs(local.y) <= e.y &&
          Math.abs(local.z) <= e.z
        ) return true;
      }
    }
    return false;
  }

  /**
   * Closest point on a collider's surface to `point`. Returns null when the
   * collider is further than `maxDist` (cheap early-out for the capsule solver).
   */
  _closestPoint(collider, point, out, maxDist) {
    _cpInside = false;
    if (collider.type === 'heightfield') {
      // Nothing on the surface can be in range if the whole field is far below.
      if (point.y - collider.maxY > maxDist) return null;

      const surf = collider.sampleHeight(point.x, point.z);
      if (surf === null) return null;

      /* Under the surface: the way out is straight up to it. Flagged as an
       * interior hit so the solver reverses the delta and uses the real depth,
       * rather than relying on a zero-length delta and a fixed one-radius shove.
       * Below `baseY` the field stops being solid, so a genuine cave or
       * under-deck volume is not sealed. */
      if (point.y < surf) {
        if (point.y <= collider.baseY) return null;
        _cpInside = true;
        return out.set(point.x, surf, point.z);
      }

      // Above the surface: closest point on the real triangles nearby, which is
      // what makes slopes and cliff faces resolve correctly rather than
      // everything behaving like a vertical drop.
      const nx2 = collider.nx - 2;
      const nz2 = collider.nz - 2;
      let i0 = Math.floor((point.x - maxDist - collider.originX) / collider.stepX);
      let i1 = Math.floor((point.x + maxDist - collider.originX) / collider.stepX);
      let j0 = Math.floor((point.z - maxDist - collider.originZ) / collider.stepZ);
      let j1 = Math.floor((point.z + maxDist - collider.originZ) / collider.stepZ);
      if (i0 < 0) i0 = 0;
      if (j0 < 0) j0 = 0;
      if (i1 > nx2) i1 = nx2;
      if (j1 > nz2) j1 = nz2;

      let bestDistSq = maxDist * maxDist;
      let found = false;
      const holes = collider.holes;
      const cellStride = collider.nx - 1;
      const a = _hf1, b = _hf2, c = _hf3, cp = _hf4;
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          if (holes !== null && holes[j * cellStride + i]) continue;
          const k = collider.cellCorners(i, j, _hfCorners);
          a.set(k[0], k[1], k[2]);
          b.set(k[3], k[4], k[5]);
          c.set(k[6], k[7], k[8]);
          closestPointOnTriangle(a, b, c, point, cp);
          let dsq = cp.distanceToSquared(point);
          if (dsq < bestDistSq) {
            bestDistSq = dsq;
            out.copy(cp);
            found = true;
          }
          b.set(k[6], k[7], k[8]);
          c.set(k[9], k[10], k[11]);
          closestPointOnTriangle(a, b, c, point, cp);
          dsq = cp.distanceToSquared(point);
          if (dsq < bestDistSq) {
            bestDistSq = dsq;
            out.copy(cp);
            found = true;
          }
        }
      }
      return found ? out : null;
    }

    if (collider.type === 'box') {
      // Transform into box local space, clamp, transform back.
      const local = _v1.copy(point).applyMatrix4(collider.inverse);
      const h = collider.halfExtents;
      const ox = h.x - Math.abs(local.x);
      const oy = h.y - Math.abs(local.y);
      const oz = h.z - Math.abs(local.z);

      if (ox > 0 && oy > 0 && oz > 0) {
        /* The point is *inside* the box.
         *
         * Clamping is a no-op here, which used to make `_closestPoint` hand back
         * the query point itself. The solver saw a zero-length delta, took its
         * "deeply embedded" branch and pushed straight up by a full radius - per
         * collider, per iteration. Measured on a 10 m wall slab, a capsule
         * standing inside it was launched 9 m vertically to the wall top in one
         * resolve. That is the mechanism behind ending up on top of, or inside,
         * a roof after brushing a wall: the recovery direction had nothing to do
         * with the geometry it was recovering from.
         *
         * Projecting to the nearest face instead gives the shortest way out,
         * which for a wall is sideways and for a floor or roof slab is vertical.
         * `_cpInside` tells the caller the delta needs to be reversed - the
         * surface point is now *outside* the query point, not inside it. */
        _cpInside = true;
        if (ox <= oy && ox <= oz) local.x = local.x >= 0 ? h.x : -h.x;
        else if (oy <= oz) local.y = local.y >= 0 ? h.y : -h.y;
        else local.z = local.z >= 0 ? h.z : -h.z;
      } else {
        local.set(
          Math.max(-h.x, Math.min(h.x, local.x)),
          Math.max(-h.y, Math.min(h.y, local.y)),
          Math.max(-h.z, Math.min(h.z, local.z))
        );
      }
      out.copy(local).applyMatrix4(collider.matrix);
      return out;
    }
    if (collider.type === 'sphere') {
      const dir = _v1.subVectors(point, collider.center);
      const len = dir.length();
      if (len < 1e-6) return out.copy(collider.center).add(_v2.set(0, collider.radius, 0));
      return out.copy(collider.center).addScaledVector(dir, collider.radius / len);
    }
    /* Triangle soup.
     *
     * Two exact rejects wrap the per-triangle work, and both matter more than
     * they look. A mesh collider is a flat array with no internal tree, so the
     * only thing standing between a query and every triangle in it is what we
     * skip here. The broadphase cannot help: its cells are `cellSize` (12 m)
     * across, so every chunk sharing a cell with the capsule is handed to this
     * function regardless of how finely the caller chunked its geometry.
     *
     * 1. Squared distance from the query point to the collider's own AABB. One
     *    test retires a whole chunk that is in the cell but not near the
     *    capsule, which is the common case and the reason chunking pays off at
     *    all.
     * 2. Per triangle, the same test against the triangle's AABB. This replaces
     *    a centroid check with an 8 m fudge factor, which was both slower to
     *    converge and wrong at the edges: a deck slab 9 m from the capsule by
     *    its centroid but reaching to within 20 cm of it was discarded, because
     *    a centroid says nothing about a large triangle's extent. Bounds are
     *    exact, so nothing near is skipped and far more that is far is.
     */
    const bnd = collider.bounds;
    const maxDistSq = maxDist * maxDist;
    let ox = bnd.min.x - point.x; if (ox < 0) ox = Math.max(0, point.x - bnd.max.x);
    let oy = bnd.min.y - point.y; if (oy < 0) oy = Math.max(0, point.y - bnd.max.y);
    let oz = bnd.min.z - point.z; if (oz < 0) oz = Math.max(0, point.z - bnd.max.z);
    if (ox * ox + oy * oy + oz * oz > maxDistSq) return null;

    const pos = collider.positions;
    const px = point.x, py = point.y, pz = point.z;
    let bestDistSq = maxDistSq;
    let found = false;
    const a = _cp1, b = _cp2, c = _cp3;
    const cp = _cp4;
    for (let i = 0; i < pos.length; i += 9) {
      // Read raw floats for the reject so a skipped triangle never pays for
      // three Vector3 writes.
      const ax = pos[i], ay = pos[i + 1], az = pos[i + 2];
      const bx = pos[i + 3], by = pos[i + 4], bz = pos[i + 5];
      const cx = pos[i + 6], cy = pos[i + 7], cz = pos[i + 8];

      let dx = Math.min(ax, bx, cx) - px;
      if (dx < 0) dx = Math.max(0, px - Math.max(ax, bx, cx));
      let dy = Math.min(ay, by, cy) - py;
      if (dy < 0) dy = Math.max(0, py - Math.max(ay, by, cy));
      let dz = Math.min(az, bz, cz) - pz;
      if (dz < 0) dz = Math.max(0, pz - Math.max(az, bz, cz));
      if (dx * dx + dy * dy + dz * dz >= bestDistSq) continue;

      a.set(ax, ay, az);
      b.set(bx, by, bz);
      c.set(cx, cy, cz);
      closestPointOnTriangle(a, b, c, point, cp);
      const dsq = cp.distanceToSquared(point);
      if (dsq < bestDistSq) {
        bestDistSq = dsq;
        out.copy(cp);
        found = true;
      }
    }
    return found ? out : null;
  }

  /**
   * Closest point on a triangle soup to a *segment*, exactly.
   *
   * ── Why this exists rather than reusing `_closestPoint` ───────────────────
   * The capsule solver finds a collider's nearest point by iterating: nearest
   * point to the axis midpoint, project that onto the axis, nearest point to
   * *that*. Two passes converge for a box or a sphere, which is what the note
   * in `resolveCapsule` means by "the convex shapes we use" - and a triangle
   * soup is not one. Pass one picks whichever triangle is nearest the capsule's
   * middle, and if the real contact is a pipe at ankle height the second pass
   * measures from a point derived from the wrong triangle and reports a
   * distance that is too large. Measured against the station's collided
   * geometry: true distance from the axis 0.212 m, two-pass answer 0.371 m,
   * capsule radius 0.35 - so the solver walked the player through a collider it
   * was holding all along. That is not a tuning problem, it is the wrong query.
   *
   * The closest pair between a segment and a triangle lies at one of: a segment
   * endpoint against the triangle, the segment interior against one of the
   * three edges, or a crossing of the triangle's interior. All four are tested.
   *
   * Being a segment query rather than a point query also pays for itself:
   * `maxDist` here is the capsule radius, not the radius plus half the capsule
   * height that a midpoint query needs to stay conservative, so the bounds
   * rejects run five times tighter and retire far more triangles.
   *
   * @param {Collider} collider a 'mesh' collider
   * @param {THREE.Vector3} segA lower capsule sphere centre
   * @param {THREE.Vector3} segB upper capsule sphere centre
   * @param {number} maxDist ignore anything further than this from the segment
   * @param {THREE.Vector3} out receives the point on the soup
   * @returns {THREE.Vector3|null}
   */
  _closestPointOnSoup(collider, segA, segB, maxDist, out) {
    // Capsule box against the chunk box. Both are axis-aligned, so this is the
    // cheapest possible rejection and it retires most chunks outright.
    const bnd = collider.bounds;
    const loX = Math.min(segA.x, segB.x), hiX = Math.max(segA.x, segB.x);
    const loY = Math.min(segA.y, segB.y), hiY = Math.max(segA.y, segB.y);
    const loZ = Math.min(segA.z, segB.z), hiZ = Math.max(segA.z, segB.z);
    if (
      bnd.min.x - maxDist > hiX || bnd.max.x + maxDist < loX ||
      bnd.min.y - maxDist > hiY || bnd.max.y + maxDist < loY ||
      bnd.min.z - maxDist > hiZ || bnd.max.z + maxDist < loZ
    ) return null;

    const pos = collider.positions;
    let bestSq = maxDist * maxDist;
    let found = false;
    const a = _sg4, b = _sg5, c = _sg6;
    const p = _sg7, q = _sg8, n = _sg9;

    for (let i = 0; i < pos.length; i += 9) {
      const ax = pos[i], ay = pos[i + 1], az = pos[i + 2];
      const bx = pos[i + 3], by = pos[i + 4], bz = pos[i + 5];
      const cx = pos[i + 6], cy = pos[i + 7], cz = pos[i + 8];

      // Triangle box against the capsule box, tightened by the best so far.
      const reach = Math.sqrt(bestSq);
      let dx = Math.min(ax, bx, cx) - hiX;
      if (dx < 0) dx = Math.max(0, loX - Math.max(ax, bx, cx));
      if (dx >= reach) continue;
      let dy = Math.min(ay, by, cy) - hiY;
      if (dy < 0) dy = Math.max(0, loY - Math.max(ay, by, cy));
      if (dy >= reach) continue;
      let dz = Math.min(az, bz, cz) - hiZ;
      if (dz < 0) dz = Math.max(0, loZ - Math.max(az, bz, cz));
      if (dx * dx + dy * dy + dz * dz >= bestSq) continue;

      a.set(ax, ay, az);
      b.set(bx, by, bz);
      c.set(cx, cy, cz);

      /* Does the axis pass clean through the triangle? Neither the endpoint
       * tests nor the edge tests below report zero for that case - they all
       * measure to the boundary - so a capsule skewered by a surface would
       * otherwise read as comfortably clear of it. */
      n.crossVectors(_sg1.subVectors(b, a), _sg2.subVectors(c, a));
      const dA = n.dot(_sg3.subVectors(segA, a));
      const dB = n.dot(_sg3.subVectors(segB, a));
      if ((dA < 0) !== (dB < 0)) {
        const t = dA / (dA - dB);
        p.copy(segA).addScaledVector(_sg3.subVectors(segB, segA), t);
        closestPointOnTriangle(a, b, c, p, q);
        if (q.distanceToSquared(p) < 1e-8) {
          out.copy(p);
          return out;
        }
      }

      // Endpoints against the triangle face.
      closestPointOnTriangle(a, b, c, segA, q);
      let dsq = q.distanceToSquared(segA);
      if (dsq < bestSq) { bestSq = dsq; out.copy(q); found = true; }
      closestPointOnTriangle(a, b, c, segB, q);
      dsq = q.distanceToSquared(segB);
      if (dsq < bestSq) { bestSq = dsq; out.copy(q); found = true; }

      // Segment interior against each edge.
      dsq = closestPtSegmentSegment(segA, segB, a, b, p, q);
      if (dsq < bestSq) { bestSq = dsq; out.copy(q); found = true; }
      dsq = closestPtSegmentSegment(segA, segB, b, c, p, q);
      if (dsq < bestSq) { bestSq = dsq; out.copy(q); found = true; }
      dsq = closestPtSegmentSegment(segA, segB, c, a, p, q);
      if (dsq < bestSq) { bestSq = dsq; out.copy(q); found = true; }
    }
    return found ? out : null;
  }

  /**
   * Resolve a capsule against the static world.
   *
   * @param {THREE.Vector3} position - feet position; mutated in place.
   * @param {number} radius
   * @param {number} height - total capsule height (feet to crown).
   * @returns {{ grounded: boolean, groundNormal: THREE.Vector3, hitCount: number,
   *            minNormalY: number }}
   *   `minNormalY` is the shallowest push direction this resolve applied - the
   *   one furthest from "up" - and 1 when it applied none. A caller that has
   *   lost horizontal motion can ask with it whether anything it touched was
   *   something other than floor. @see ../player/Player.js `_move`
   */
  resolveCapsule(position, radius, height) {
    const result = {
      grounded: false,
      groundNormal: new THREE.Vector3(0, 1, 0),
      hitCount: 0,
      minNormalY: 1,
    };
    const segA = _v3.set(position.x, position.y + radius, position.z);
    const segB = _v4.set(position.x, position.y + height - radius, position.z);
    const capsuleCenter = _v5.copy(segA).add(segB).multiplyScalar(0.5);
    const queryRadius = radius + height * 0.5 + 0.5;

    let nearby = this.query(capsuleCenter, queryRadius);
    const closest = new THREE.Vector3();
    const onSeg = new THREE.Vector3();
    const push = new THREE.Vector3();
    /* No single correction may exceed the capsule's own height. */
    const maxPush = height;
    /* Where the broadphase set was gathered from. If depenetration carries the
     * capsule far from here the set is stale, and resolving against a stale set
     * is how a character gets pushed into geometry nobody ever tested it
     * against. Re-query rather than trust it. */
    const queriedX = capsuleCenter.x;
    const queriedZ = capsuleCenter.z;
    const restaleSq = (queryRadius * 0.5) * (queryRadius * 0.5);

    // A few iterations converge on concave corners without visible jitter.
    for (let iter = 0; iter < 4; iter++) {
      let moved = false;
      segA.set(position.x, position.y + radius, position.z);
      segB.set(position.x, position.y + height - radius, position.z);

      if (iter > 0) {
        const dx = position.x - queriedX;
        const dz = position.z - queriedZ;
        if (dx * dx + dz * dz > restaleSq) {
          capsuleCenter.copy(segA).add(segB).multiplyScalar(0.5);
          nearby = this.query(capsuleCenter, queryRadius);
        }
      }

      for (const collider of nearby) {
        if (!collider.solid) continue;

        let cp;
        let inside;
        if (collider.type !== 'mesh') {
          /* Bounding sphere against the capsule segment.
           *
           * The convex path below costs two closest-point passes, and for a box
           * each of those is a pair of matrix transforms - real work to conclude
           * "not touching", which is the answer for nearly every collider a
           * broadphase cell hands over. This is exact and conservative: the
           * bounding sphere encloses the collider, so anything it rejects could
           * not have been in contact. It earns its keep the moment a world has
           * thousands of small boxes in one district. */
          closestPointOnSegment(segA, segB, collider.center, onSeg);
          const reach = radius + collider.boundingRadius;
          if (onSeg.distanceToSquared(collider.center) > reach * reach) continue;
        }

        if (collider.type === 'mesh') {
          /* Triangle soups get an exact segment query. The two-pass iteration
           * below is a convex-shape method and silently under-reports on a
           * soup - see `_closestPointOnSoup`, which also explains why `radius`
           * is the right cutoff here where the convex path needs `queryRadius`.
           * A soup has no interior, so `inside` is never true for one. */
          cp = this._closestPointOnSoup(collider, segA, segB, radius, closest);
          if (!cp) continue;
          inside = false;
        } else {
          /* Closest point on the collider to the capsule axis, by alternating
           * projection: collider->axis, then axis->collider.
           *
           * ── Two passes is NOT enough past ~44 degrees ─────────────────────
           * This is where the walkable ceiling the game actually has comes
           * from, and it is not the one the constants say. Measured at
           * 7178224; every number below is pinned by
           * @see ../../scripts/tests/capsule-normal.test.mjs
           *
           * The pair the loop leaves is inconsistent. The re-projection after
           * this block updates `onSeg` one more time, so the `onSeg` that
           * forms the push direction belongs to a `cp` computed for the
           * PREVIOUS one. On gentle ground that costs nothing: pass 1 lands its
           * closest point at or below the bottom sphere centre, `onSeg` snaps
           * to the endpoint `segA` immediately, and pass 2 is the exact
           * perpendicular. On a steep face pass 1 lands ABOVE `segA`, `onSeg`
           * is an interior point of the axis, and the surviving pair spans a
           * chord rather than the perpendicular.
           *
           * The crossover is exact, and it is a property of the CAPSULE rather
           * than of the slope. Pass 1 stays sufficient while
           *
           *     (height/2 - radius) * sin^2 p  <=  radius * cos p
           *
           * which is 43.88 deg for the standing player (r 0.35, h 1.75), 43.77
           * for the default NPC (0.33, 1.656), 47.96 for the dismount probe
           * (0.35, 1.55) and 67.43 crouched (0.35, 1.015) - each reproduced to
           * within 0.01 deg by driving the solver at that size.
           *
           * Past it the reported normal falls away fast, and then the contact
           * is dropped outright: the chord is LONGER than the true distance, so
           * `dist >= radius` below rejects a real overlap until the capsule has
           * sunk past a dead band. Standing player, at 1 mm of perpendicular
           * penetration - identical on an oriented box and on a heightfield to
           * 1e-7, so this is the iteration and not a box artefact:
           *
           *     pitch   true n.y   reported   contact needs a sink of
           *     43.0     0.7314     0.7314          0
           *     45.0     0.7071     0.6842        0.16 mm
           *     46.5     0.6884     0.6323        0.98 mm
           *     47.0     0.6820     (none)         1.4 mm
           *     50.0     0.6428     (none)         6.4 mm
           *     55.0     0.5736     (none)          28 mm
           *     58.0     0.5299     (none)          54 mm
           *
           * So the deeper a character sinks the worse the normal it gets back,
           * and a walking capsule sinks a long way: the ground-stick bias alone
           * is 2.2 m/s, 37 mm per fixed step. That is why the DRIVEN onset (~40
           * deg) is lower than the static one, and why a sprint still fires
           * step probes on a 45 deg ramp that a walk crosses cleanly. Steep
           * OVERHEAD faces lose their normal symmetrically: -0.7071 reads
           * -0.5762 at 45 deg.
           *
           * ── Why it is still two passes ────────────────────────────────────
           * A third pass fixes it completely - `onSeg` reaches `segA` and stays
           * there, so the next `cp` is the exact perpendicular. Measured exact
           * to 1e-16 at every pitch to 60.6 deg for this capsule, with contacts
           * registering at any penetration at all, and flat ground stays
           * bit-identical (`player-speed.test.mjs` still hashes 834f9782). It
           * costs +24-27% of `resolveCapsule` (+0.33-0.40 us on 1.5 us, over
           * 4,000 resolves against a heightfield plus 600 boxes; +11% where 169
           * boxes all overlap the capsule at once).
           *
           * It was measured and NOT taken, because the wrong normal is masking
           * two other defects and correcting it alone makes the game WORSE on
           * two of the three bands it moves:
           *
           *   43.9-50.2 deg  the player walks up honestly, at exactly the
           *                  projected speed, instead of being teleported.
           *                  A real improvement. 0.45% of the medieval map.
           *   50.2-56.6 deg  a NEW dead band. `grounded` below needs n.y > 0.64
           *                  (50.2 deg) and `Player._move`'s step-up gate reads
           *                  `WALKABLE_NORMAL_Y` 0.55 (56.6 deg), so an HONEST
           *                  normal in between says both "not ground" and "not
           *                  something to step over": the player sticks, 11-14%
           *                  grounded, 0.1 m of climb in 4 s. 0.14% of the map.
           *   56.6-66 deg    the step-up ladder in `Player._move` reaches 8 deg
           *                  further than it does today and runs faster - 10.2
           *                  m/s of climb against a 6.0 m/s ground speed cap -
           *                  up escarpments the level currently closes.
           *                  Grimscar Edge is 60 deg, Blackmarch Bluff 67.
           *
           * Fixing this safely means fixing all three together: the third pass
           * here, ONE walkable threshold instead of 0.64 here and 0.55 in
           * `Grounding`, and a step-up branch that will not ladder a smooth
           * slope. That is a movement change for the player and every NPC and
           * wants its own task, not a line in this one. */
          const axisMid = push.copy(segA).add(segB).multiplyScalar(0.5);
          cp = this._closestPoint(collider, axisMid, closest, queryRadius);
          if (!cp) continue;
          closestPointOnSegment(segA, segB, cp, onSeg);
          cp = this._closestPoint(collider, onSeg, closest, queryRadius);
          if (!cp) continue;
          // `_cpInside` belongs to the call just made; read it before anything
          // else can overwrite it.
          inside = _cpInside;
        }
        closestPointOnSegment(segA, segB, cp, onSeg);

        const delta = push.subVectors(onSeg, cp);
        const dist = delta.length();
        let depth;

        if (inside) {
          /* The capsule axis is inside the collider. `cp` is the nearest point
           * on its surface, so the way out is *toward* cp, and we have to clear
           * the radius on top of the depth already sunk. */
          if (dist < 1e-6) delta.set(0, 1, 0);
          else delta.multiplyScalar(-1 / dist);
          depth = radius + dist;
        } else {
          if (dist >= radius) continue;
          if (dist < 1e-5) {
            // On the surface with no usable direction: up is the least-bad guess.
            delta.set(0, 1, 0);
          } else {
            delta.multiplyScalar(1 / dist);
          }
          depth = radius - dist;
        }

        /* Cap a single push.
         *
         * Depenetration is a correction, not a movement: a resolve that shifts a
         * character further than its own height has stopped fixing an overlap
         * and started teleporting it somewhere else. Clamping keeps a bad frame
         * to a visible nudge instead of a launch across the level, and the next
         * frame resolves the remainder. */
        if (depth > maxPush) depth = maxPush;
        position.addScaledVector(delta, depth);
        moved = true;
        result.hitCount++;

        /* Carry the correction into the capsule before the next collider is
         * tested.
         *
         * Without this the whole iteration measures every overlap against the
         * capsule as it stood at the *top* of the iteration, while the pushes
         * all land on `position` - so N colliders overlapping the same corner
         * contribute N full corrections for what is really one overlap, and the
         * capsule leaves with several times the displacement it needed.
         *
         * With a few hand-authored boxes per corner that overshoot was
         * survivable, and measurably so: re-solved over grids of 6,500-7,500
         * ground points, the four box-only worlds move by a mean of 0.1-0.5 mm
         * with and without this line. A world that collides its structure as
         * thousands of small triangle chunks is a different matter, because
         * dozens of them overlap one capsule at once - over 7,921 points on the
         * station deck the same comparison is a mean of 1 cm and a worst case of
         * 1.45 m, all of it overshoot this removes.
         *
         * Each collider now sees the capsule as the ones before it left it, and
         * the four iterations converge instead of stacking. */
        segA.set(position.x, position.y + radius, position.z);
        segB.set(position.x, position.y + height - radius, position.z);

        if (delta.y < result.minNormalY) result.minNormalY = delta.y;

        /* Surfaces up to ~50 degrees count as walkable ground.
         *
         * Two warnings on this number. It is NOT `Grounding.WALKABLE_NORMAL_Y`
         * (0.55, 56.6 deg), which is the threshold every OTHER walkability
         * question in the game is asked against - the two have simply never
         * been reconciled. And neither of them is the ceiling in effect:
         * `delta.y` is the two-pass normal, which stops being the true face
         * normal past ~44 deg and is under 0.64 on any slope a moving capsule
         * meets past ~45. See the note on the closest-point iteration above -
         * that is where the real 45 deg ceiling comes from, not from here. */
        if (delta.y > 0.64) {
          if (!result.grounded || delta.y > result.groundNormal.y) {
            result.grounded = true;
            result.groundNormal.copy(delta);
          }
        }
      }
      if (!moved) break;
    }
    return result;
  }

  /**
   * Raycast against static colliders.
   *
   * @returns {{ distance: number, point: THREE.Vector3, normal: THREE.Vector3, collider: Collider } | null}
   */
  raycast(origin, direction, maxDistance = 1000, layerMask = COLLISION_LAYER.ALL) {
    let best = null;
    let bestDist = maxDistance;

    // March the broadphase grid along the ray rather than querying one huge sphere.
    const probe = new THREE.Vector3();
    const seen = new Set();
    const candidates = [];

    /* A ray with no horizontal component stays in one column of grid cells for
     * its whole length, so marching it re-queries the identical cells once per
     * step and throws all but the first away. `groundHeight` casts straight down
     * over up to 900 m, which was 75 identical queries - each allocating its own
     * dedup Set - for every spawn probe, prop placement and NPC ground check. */
    const vertical =
      Math.abs(direction.x) * maxDistance < this.cellSize * 0.5 &&
      Math.abs(direction.z) * maxDistance < this.cellSize * 0.5;
    const steps = vertical ? 0 : Math.max(1, Math.ceil(maxDistance / this.cellSize));
    const stepLen = steps > 0 ? maxDistance / steps : 0;
    /* A vertical ray needs exactly the cell it stands in.
     *
     * `_insertToGrid` puts a collider in every cell its footprint touches, so
     * anything the column at (x,z) can hit is already listed in that one cell -
     * the cell-wide radius the marching case needs to bridge its steps is, for
     * a vertical ray, nine cells of candidates gathered to use one. That was
     * invisible while worlds were a thousand boxes and became the dominant cost
     * of a ground probe once the station started collecting its structure as
     * thousands of triangle chunks. */
    const gatherRadius = vertical ? 0 : this.cellSize;

    for (let i = 0; i <= steps; i++) {
      probe.copy(origin).addScaledVector(direction, i * stepLen);
      const list = this.query(probe, gatherRadius);
      for (const c of list) {
        if (seen.has(c)) continue;
        seen.add(c);
        candidates.push(c);
      }
    }

    for (const collider of candidates) {
      if ((collider.layer & layerMask) === 0) continue;
      const hit = this._raycastCollider(collider, origin, direction, bestDist);
      if (hit && hit.distance < bestDist) {
        bestDist = hit.distance;
        best = hit;
      }
    }
    return best;
  }

  /**
   * Ray vs terrain heightfield.
   *
   * Walks the ray across the height grid one cell at a time (2D DDA) instead of
   * testing every triangle, so cost scales with how far the ray travels rather
   * than with how big the world is. That distinction is the whole point: a
   * brute-force pass over a ten-times-wider world is 100x the triangles for the
   * same 20 m shot.
   */
  _raycastHeightfield(collider, origin, direction, maxDist) {
    const nx = collider.nx;
    const nz = collider.nz;
    const stepX = collider.stepX;
    const stepZ = collider.stepZ;
    const originX = collider.originX;
    const originZ = collider.originZ;

    // Clip against the field's slab before walking anything.
    let t0 = 0;
    let t1 = maxDist;
    // X
    if (Math.abs(direction.x) < 1e-9) {
      if (origin.x < originX || origin.x > originX + collider.sizeX) return null;
    } else {
      const inv = 1 / direction.x;
      let ta = (originX - origin.x) * inv;
      let tb = (originX + collider.sizeX - origin.x) * inv;
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) return null;
    }
    // Z
    if (Math.abs(direction.z) < 1e-9) {
      if (origin.z < originZ || origin.z > originZ + collider.sizeZ) return null;
    } else {
      const inv = 1 / direction.z;
      let ta = (originZ - origin.z) * inv;
      let tb = (originZ + collider.sizeZ - origin.z) * inv;
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) return null;
    }
    // Y band: below baseY or above maxY there is nothing to hit.
    if (Math.abs(direction.y) < 1e-9) {
      if (origin.y < collider.baseY || origin.y > collider.maxY) return null;
    } else {
      const inv = 1 / direction.y;
      let ta = (collider.baseY - origin.y) * inv;
      let tb = (collider.maxY - origin.y) * inv;
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) return null;
    }
    if (t1 <= 0 || t0 >= maxDist) return null;
    if (t0 < 0) t0 = 0;

    // Enter the grid a hair past the boundary so the starting cell is the one
    // the ray is actually inside.
    const tEnter = Math.min(t0 + 1e-4, t1);
    let i = Math.floor((origin.x + direction.x * tEnter - originX) / stepX);
    let j = Math.floor((origin.z + direction.z * tEnter - originZ) / stepZ);
    if (i < 0) i = 0; else if (i > nx - 2) i = nx - 2;
    if (j < 0) j = 0; else if (j > nz - 2) j = nz - 2;

    const stepI = direction.x > 1e-9 ? 1 : direction.x < -1e-9 ? -1 : 0;
    const stepJ = direction.z > 1e-9 ? 1 : direction.z < -1e-9 ? -1 : 0;

    let tMaxI = Infinity;
    let tDeltaI = Infinity;
    if (stepI !== 0) {
      tMaxI = (originX + (i + (stepI > 0 ? 1 : 0)) * stepX - origin.x) / direction.x;
      tDeltaI = Math.abs(stepX / direction.x);
    }
    let tMaxJ = Infinity;
    let tDeltaJ = Infinity;
    if (stepJ !== 0) {
      tMaxJ = (originZ + (j + (stepJ > 0 ? 1 : 0)) * stepZ - origin.z) / direction.z;
      tDeltaJ = Math.abs(stepZ / direction.z);
    }

    const a = _hr1, b = _hr2, c = _hr3;
    const holes = collider.holes;
    const cellStride = nx - 1;
    for (;;) {
      let t = -1;
      if (holes === null || !holes[j * cellStride + i]) {
        const k = collider.cellCorners(i, j, _hfCorners);
        // Triangles (0,1,2) and (0,2,3) - the same 00->11 diagonal `sampleHeight`
        // interpolates across.
        a.set(k[0], k[1], k[2]);
        b.set(k[3], k[4], k[5]);
        c.set(k[6], k[7], k[8]);
        t = rayTriangle(a, b, c, origin, direction, maxDist);
        if (t < 0) {
          b.set(k[6], k[7], k[8]);
          c.set(k[9], k[10], k[11]);
          t = rayTriangle(a, b, c, origin, direction, maxDist);
        }
      }
      if (t >= 0) {
        const normal = new THREE.Vector3()
          .crossVectors(_rt1.subVectors(b, a), _rt2.subVectors(c, a))
          .normalize();
        if (normal.dot(direction) > 0) normal.negate();
        return {
          distance: t,
          point: new THREE.Vector3().copy(origin).addScaledVector(direction, t),
          normal,
          collider,
        };
      }

      // A ray with no horizontal component only ever touches one cell.
      if (stepI === 0 && stepJ === 0) return null;

      if (tMaxI < tMaxJ) {
        if (tMaxI > t1) return null;
        i += stepI;
        if (i < 0 || i > nx - 2) return null;
        tMaxI += tDeltaI;
      } else {
        if (tMaxJ > t1) return null;
        j += stepJ;
        if (j < 0 || j > nz - 2) return null;
        tMaxJ += tDeltaJ;
      }
    }
  }

  _raycastCollider(collider, origin, direction, maxDist) {
    if (collider.type === 'heightfield') {
      return this._raycastHeightfield(collider, origin, direction, maxDist);
    }
    if (collider.type === 'box') {
      // Slab test in box local space. These MUST use raycast-private scratch
      // vectors: callers legitimately pass module scratch vectors as the ray,
      // and transforming into box space would otherwise mutate the caller's
      // origin/direction partway through a multi-collider query.
      const o = _rc1.copy(origin).applyMatrix4(collider.inverse);
      const d = _rc2.copy(direction).transformDirection(collider.inverse);
      const h = collider.halfExtents;
      let tmin = 0;
      let tmax = maxDist;
      let hitAxis = 0;
      let hitSign = 1;

      for (let axis = 0; axis < 3; axis++) {
        const comp = axis === 0 ? 'x' : axis === 1 ? 'y' : 'z';
        const half = axis === 0 ? h.x : axis === 1 ? h.y : h.z;
        const od = d[comp];
        const oo = o[comp];
        if (Math.abs(od) < 1e-8) {
          if (oo < -half || oo > half) return null;
          continue;
        }
        const inv = 1 / od;
        let t1 = (-half - oo) * inv;
        let t2 = (half - oo) * inv;
        let sign = -1;
        if (t1 > t2) {
          const tmp = t1;
          t1 = t2;
          t2 = tmp;
          sign = 1;
        }
        if (t1 > tmin) {
          tmin = t1;
          hitAxis = axis;
          hitSign = sign;
        }
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) return null;
      }
      if (tmin <= 0 || tmin >= maxDist) return null;

      const normal = new THREE.Vector3();
      normal[hitAxis === 0 ? 'x' : hitAxis === 1 ? 'y' : 'z'] = hitSign;
      normal.transformDirection(collider.matrix).normalize();
      return {
        distance: tmin,
        point: new THREE.Vector3().copy(origin).addScaledVector(direction, tmin),
        normal,
        collider,
      };
    }

    if (collider.type === 'sphere') {
      const oc = _rc1.subVectors(origin, collider.center);
      const b = oc.dot(direction);
      const c = oc.lengthSq() - collider.radius * collider.radius;
      const disc = b * b - c;
      if (disc < 0) return null;
      const t = -b - Math.sqrt(disc);
      if (t <= 0 || t >= maxDist) return null;
      const point = new THREE.Vector3().copy(origin).addScaledVector(direction, t);
      return {
        distance: t,
        point,
        normal: new THREE.Vector3().subVectors(point, collider.center).normalize(),
        collider,
      };
    }

    /* Triangle soup: Moller-Trumbore, behind a slab test on the chunk's AABB.
     *
     * That slab test is what makes chunked geometry survivable here. `raycast`
     * gathers candidates with a query a whole broadphase cell wide, so a ground
     * probe in a dense district is handed every chunk within 12 m - hundreds of
     * them - and each one used to pay for a full sweep of its triangles plus
     * seven `new Vector3` before it could decide the ray missed entirely.
     * Ground probes are the most-called operation in this file: every NPC casts
     * one every step.
     */
    const bnd = collider.bounds;
    let tEnter = 0;
    let tExit = maxDist;
    for (let axis = 0; axis < 3; axis++) {
      const comp = axis === 0 ? 'x' : axis === 1 ? 'y' : 'z';
      const od = direction[comp];
      const oo = origin[comp];
      const lo = bnd.min[comp];
      const hi = bnd.max[comp];
      if (Math.abs(od) < 1e-8) {
        if (oo < lo || oo > hi) return null;
        continue;
      }
      const inv = 1 / od;
      let ta = (lo - oo) * inv;
      let tb = (hi - oo) * inv;
      if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
      if (ta > tEnter) tEnter = ta;
      if (tb < tExit) tExit = tb;
      if (tEnter > tExit) return null;
    }

    const pos = collider.positions;
    let bestT = maxDist;
    let bestNormal = null;
    const edge1 = _mr1, edge2 = _mr2;
    const h2 = _mr3, s = _mr4, q = _mr5;
    const a = _mr6, b2 = _mr7, c2 = _mr8;
    let bestNx = 0, bestNy = 0, bestNz = 0;

    for (let i = 0; i < pos.length; i += 9) {
      a.set(pos[i], pos[i + 1], pos[i + 2]);
      b2.set(pos[i + 3], pos[i + 4], pos[i + 5]);
      c2.set(pos[i + 6], pos[i + 7], pos[i + 8]);
      edge1.subVectors(b2, a);
      edge2.subVectors(c2, a);
      h2.crossVectors(direction, edge2);
      const det = edge1.dot(h2);
      if (Math.abs(det) < 1e-9) continue;
      const invDet = 1 / det;
      s.subVectors(origin, a);
      const u = invDet * s.dot(h2);
      if (u < 0 || u > 1) continue;
      q.crossVectors(s, edge1);
      const v = invDet * direction.dot(q);
      if (v < 0 || u + v > 1) continue;
      const t = invDet * edge2.dot(q);
      if (t <= 1e-5 || t >= bestT) continue;
      bestT = t;
      // Keep the winning normal as three floats. Allocating a Vector3 per
      // improvement meant a ray grazing a chunk edge-on could allocate once per
      // triangle for a result that is thrown away by the next candidate.
      _mr9.crossVectors(edge1, edge2).normalize();
      bestNx = _mr9.x; bestNy = _mr9.y; bestNz = _mr9.z;
      bestNormal = true;
    }
    if (!bestNormal) return null;
    const normal = new THREE.Vector3(bestNx, bestNy, bestNz);
    if (normal.dot(direction) > 0) normal.negate();
    return {
      distance: bestT,
      point: new THREE.Vector3().copy(origin).addScaledVector(direction, bestT),
      normal,
      collider,
    };
  }

  /**
   * Drop a point to the ground below it. Used for spawn placement so nothing
   * ever spawns inside geometry or floating.
   */
  groundHeight(x, z, startY = 200, maxDrop = 400) {
    const hit = this.raycast(
      _gh1.set(x, startY, z),
      _gh2.set(0, -1, 0),
      maxDrop,
      COLLISION_LAYER.WORLD
    );
    return hit ? hit.point.y : null;
  }

  /**
   * Ground height with a guaranteed answer for spawn placement.
   *
   * Casts from high above and, if that misses entirely (a spawn point outside
   * any collider's footprint), probes a small ring around the point before
   * giving up. Spawning a character at an unresolved height drops them through
   * the world, so callers get `fallback` rather than null.
   */
  groundHeightOrFallback(x, z, fallback = 0, searchRadius = 2.5) {
    const direct = this.groundHeight(x, z, 400, 900);
    if (direct !== null) return direct;
    // Ring probe: 8 samples at two radii catches spawns nudged just off a deck.
    for (const r of [searchRadius, searchRadius * 2]) {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const h = this.groundHeight(x + Math.cos(a) * r, z + Math.sin(a) * r, 400, 900);
        if (h !== null) return h;
      }
    }
    return fallback;
  }
}
