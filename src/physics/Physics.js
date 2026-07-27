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

/**
 * A static collider. Worlds build these; physics never mutates them.
 * `type` is one of 'box' | 'sphere' | 'mesh'.
 */
export class Collider {
  constructor(type, opts = {}) {
    this.type = type;
    this.layer = opts.layer ?? COLLISION_LAYER.WORLD;
    this.userData = opts.userData ?? null;
    /** Blocks movement. Set false for pure triggers/raycast targets. */
    this.solid = opts.solid ?? true;

    if (type === 'box') {
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
}

export class Physics {
  constructor(bus) {
    this.bus = bus;
    /** @type {Collider[]} */
    this.colliders = [];
    /** Dynamic character proxies, used for character-vs-character pushout and raycasts. */
    this.characters = new Set();

    this.cellSize = 12;
    /** @type {Map<number, Collider[]>} */
    this._grid = new Map();
    this._queryCache = [];
  }

  clear() {
    this.colliders.length = 0;
    this._grid.clear();
    this.characters.clear();
  }

  _cellKey(cx, cz) {
    // Cantor-ish pack; worlds stay well inside +-2048 so 12 bits per axis is plenty.
    return ((cx + 2048) << 13) | (cz + 2048);
  }

  _insertToGrid(collider) {
    const r = collider.boundingRadius;
    const c = collider.center;
    const minX = Math.floor((c.x - r) / this.cellSize);
    const maxX = Math.floor((c.x + r) / this.cellSize);
    const minZ = Math.floor((c.z - r) / this.cellSize);
    const maxZ = Math.floor((c.z + r) / this.cellSize);
    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) {
        const key = this._cellKey(x, z);
        let list = this._grid.get(key);
        if (!list) this._grid.set(key, (list = []));
        list.push(collider);
      }
    }
  }

  /** @param {Collider} collider */
  add(collider) {
    this.colliders.push(collider);
    this._insertToGrid(collider);
    return collider;
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
    return out;
  }

  /**
   * Closest point on a collider's surface to `point`. Returns null when the
   * collider is further than `maxDist` (cheap early-out for the capsule solver).
   */
  _closestPoint(collider, point, out, maxDist) {
    if (collider.type === 'box') {
      // Transform into box local space, clamp, transform back.
      const local = _v1.copy(point).applyMatrix4(collider.inverse);
      const h = collider.halfExtents;
      local.set(
        Math.max(-h.x, Math.min(h.x, local.x)),
        Math.max(-h.y, Math.min(h.y, local.y)),
        Math.max(-h.z, Math.min(h.z, local.z))
      );
      out.copy(local).applyMatrix4(collider.matrix);
      return out;
    }
    if (collider.type === 'sphere') {
      const dir = _v1.subVectors(point, collider.center);
      const len = dir.length();
      if (len < 1e-6) return out.copy(collider.center).add(_v2.set(0, collider.radius, 0));
      return out.copy(collider.center).addScaledVector(dir, collider.radius / len);
    }
    // Triangle soup: brute-force the triangles near the query sphere.
    const pos = collider.positions;
    let bestDistSq = maxDist * maxDist;
    let found = false;
    const a = _cp1, b = _cp2, c = _cp3;
    const cp = _cp4;
    for (let i = 0; i < pos.length; i += 9) {
      a.set(pos[i], pos[i + 1], pos[i + 2]);
      b.set(pos[i + 3], pos[i + 4], pos[i + 5]);
      c.set(pos[i + 6], pos[i + 7], pos[i + 8]);
      // Cheap reject on triangle centroid.
      const cx = (a.x + b.x + c.x) / 3 - point.x;
      const cz = (a.z + b.z + c.z) / 3 - point.z;
      const cy = (a.y + b.y + c.y) / 3 - point.y;
      if (cx * cx + cy * cy + cz * cz > (maxDist + 8) * (maxDist + 8)) continue;
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
   * Resolve a capsule against the static world.
   *
   * @param {THREE.Vector3} position - feet position; mutated in place.
   * @param {number} radius
   * @param {number} height - total capsule height (feet to crown).
   * @returns {{ grounded: boolean, groundNormal: THREE.Vector3, hitCount: number }}
   */
  resolveCapsule(position, radius, height) {
    const result = { grounded: false, groundNormal: new THREE.Vector3(0, 1, 0), hitCount: 0 };
    const segA = _v3.set(position.x, position.y + radius, position.z);
    const segB = _v4.set(position.x, position.y + height - radius, position.z);
    const capsuleCenter = _v5.copy(segA).add(segB).multiplyScalar(0.5);
    const queryRadius = radius + height * 0.5 + 0.5;

    const nearby = this.query(capsuleCenter, queryRadius);
    const closest = new THREE.Vector3();
    const onSeg = new THREE.Vector3();
    const push = new THREE.Vector3();

    // A few iterations converge on concave corners without visible jitter.
    for (let iter = 0; iter < 4; iter++) {
      let moved = false;
      segA.set(position.x, position.y + radius, position.z);
      segB.set(position.x, position.y + height - radius, position.z);

      for (const collider of nearby) {
        if (!collider.solid) continue;

        // Closest point on the collider to the capsule axis. Approximated by
        // iterating: collider->axis, then axis->collider. Two passes is enough
        // for the convex shapes we use.
        const axisMid = push.copy(segA).add(segB).multiplyScalar(0.5);
        let cp = this._closestPoint(collider, axisMid, closest, queryRadius);
        if (!cp) continue;
        closestPointOnSegment(segA, segB, cp, onSeg);
        cp = this._closestPoint(collider, onSeg, closest, queryRadius);
        if (!cp) continue;
        closestPointOnSegment(segA, segB, cp, onSeg);

        const delta = push.subVectors(onSeg, cp);
        const dist = delta.length();
        if (dist >= radius) continue;

        if (dist < 1e-5) {
          // Deeply embedded: push straight up as the least-bad recovery.
          delta.set(0, 1, 0);
        } else {
          delta.multiplyScalar(1 / dist);
        }

        const depth = radius - dist;
        position.addScaledVector(delta, depth);
        moved = true;
        result.hitCount++;

        // Surfaces up to ~50 degrees count as walkable ground.
        if (delta.y > 0.64) {
          result.grounded = true;
          if (delta.y > result.groundNormal.y || !result.grounded) {
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
    const steps = Math.max(1, Math.ceil(maxDistance / this.cellSize));
    const stepLen = maxDistance / steps;
    const probe = new THREE.Vector3();
    const seen = new Set();
    const candidates = [];

    for (let i = 0; i <= steps; i++) {
      probe.copy(origin).addScaledVector(direction, i * stepLen);
      const list = this.query(probe, this.cellSize);
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

  _raycastCollider(collider, origin, direction, maxDist) {
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

    // Triangle soup: Moller-Trumbore over every triangle.
    const pos = collider.positions;
    let bestT = maxDist;
    let bestNormal = null;
    const edge1 = new THREE.Vector3(), edge2 = new THREE.Vector3();
    const h2 = new THREE.Vector3(), s = new THREE.Vector3(), q = new THREE.Vector3();
    const a = new THREE.Vector3(), b2 = new THREE.Vector3(), c2 = new THREE.Vector3();

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
      bestNormal = new THREE.Vector3().crossVectors(edge1, edge2).normalize();
      if (bestNormal.dot(direction) > 0) bestNormal.negate();
    }
    if (!bestNormal) return null;
    return {
      distance: bestT,
      point: new THREE.Vector3().copy(origin).addScaledVector(direction, bestT),
      normal: bestNormal,
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
