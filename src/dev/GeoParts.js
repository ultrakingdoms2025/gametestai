/**
 * READING BACK WHAT `GeoBatch` MERGED.
 *
 * `GeoBatch.flush` writes `userData.parts` on every merged mesh: the index
 * range each authored piece occupies in the merged buffer, plus the build
 * step, zone or link that raised it. This module turns those ranges back into
 * addressable objects with world-space bounds.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * Three placement instruments were built and abandoned in one day because the
 * things a player sees were not things the code could address (see the spec,
 * "the root cause of the root causes"). A barrier and the planter it stands in
 * were two slices of one `hazard` batch, and no query could separate them. The
 * spans fix that, and this is the reader.
 *
 * ── The cost, stated ──────────────────────────────────────────────────────
 *
 * `collectParts` walks every index of every merged mesh once - about a million
 * of them across the station - to fit a box per piece. That is a second or two
 * and tens of thousands of `Box3`s, which is why it is a dev/test tool called
 * deliberately and never something the game does per frame. Nothing here runs
 * in a shipped frame.
 */
import * as THREE from 'three';

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();

/**
 * Every authored piece under `root`, with world-space bounds.
 *
 * @param {THREE.Object3D} root
 * @returns {{mesh: string, index: number, owner: string|null, piece: string|null,
 *            box: THREE.Box3, tris: number}[]}
 */
export function collectParts(root) {
  root.updateMatrixWorld(true);
  const out = [];
  root.traverse((o) => {
    /* ── THE OTHER POPULATION ──────────────────────────────────────────
     * The scatter is instanced, and an instance has always been
     * addressable - mesh plus index - which is why the abandoned
     * drawn-geometry probe could enumerate 2,214 props and still see
     * nothing. Identity was never the scatter's problem; it was the
     * MERGED half it could not name. A reader that returns only one of
     * the two answers "what is standing here" with half the street, so
     * both are collected, in one list, with one address shape.
     *
     * Instances carry no owner: `instanced()` is a free function with no
     * world to read `_planOwner` from. That costs nothing here, because
     * "same thing by construction" for a scatter is same mesh and same
     * index, not same build step. Threading an owner through `instanced`
     * is a later increment, and only if a gate asks for it. */
    if (o.isInstancedMesh) {
      if (!o.visible || !o.geometry) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const gb = o.geometry.boundingBox;
      const tris = (o.geometry.index ? o.geometry.index.count : 0) / 3;
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, _m);
        const box = gb.clone().applyMatrix4(_m).applyMatrix4(o.matrixWorld);
        if (!Number.isFinite(box.min.x)) continue;
        out.push({ mesh: o.name, index: i, owner: null, piece: null, box, tris, instanced: true });
      }
      return;
    }
    if (!o.isMesh || !o.visible) return;
    const p = o.userData.parts;
    if (!p) return;
    const pos = o.geometry.getAttribute('position');
    const idx = o.geometry.index;
    if (!pos || !idx) return;
    for (let i = 0; i < p.start.length; i++) {
      const s = p.start[i], n = p.count[i];
      if (!n) continue;
      const box = new THREE.Box3();
      for (let k = s; k < s + n; k++) box.expandByPoint(_v.fromBufferAttribute(pos, idx.getX(k)));
      box.applyMatrix4(o.matrixWorld);
      out.push({
        mesh: o.name,
        index: i,
        owner: p.owners[p.ownerOf[i]],
        piece: p.pieces[p.pieceOf[i]],
        box,
        tris: n / 3,
        instanced: false,
      });
    }
  });
  return out;
}

/** An address a human can read in a report: `dressing:hazard#412`. */
export function addressOf(part) {
  return `${part.mesh}#${part.index}`;
}

/**
 * Parts whose bounds come within `r` of (x, z), nearest first.
 *
 * Horizontal only: a query is "what is standing here", and the caller almost
 * never knows the height of the thing it is asking about.
 */
export function nearby(parts, x, z, r) {
  const hits = [];
  for (const p of parts) {
    const dx = Math.max(p.box.min.x - x, 0, x - p.box.max.x);
    const dz = Math.max(p.box.min.z - z, 0, z - p.box.max.z);
    const d = Math.hypot(dx, dz);
    if (d <= r) hits.push({ ...p, d });
  }
  return hits.sort((a, b) => a.d - b.d);
}

/**
 * Pairs of parts whose boxes overlap by more than `minOverlap` metres on every
 * axis, restricted to pairs that are not the same thing seen twice.
 *
 * `sameThing` decides what "not a defect by construction" means, and it is the
 * whole difficulty of the problem: a building IS a set of overlapping boxes, so
 * a pair from one owner is usually construction rather than a defect. The
 * default treats one owner as one thing; pass a tighter predicate once pieces
 * carry finer labels.
 */
export function overlappingPairs(parts, { minOverlap = 0.05, sameThing } = {}) {
  /* Same owner AND same piece. The piece half matters as soon as any builder
   * labels: a sign carries `sign:12` and the post beside it carries null, so
   * they are two things inside one build step and can be compared. Without it
   * every label would be ignored and the reader would answer at step
   * granularity forever. */
  const same = sameThing
    ?? ((a, b) => a.owner === b.owner && a.piece === b.piece && a.owner !== null);
  /* Bucket by a 4 m XZ grid so this is not 37,923 squared. */
  const CELL = 4;
  const grid = new Map();
  const key = (ix, iz) => `${ix},${iz}`;
  parts.forEach((p, i) => {
    const x0 = Math.floor(p.box.min.x / CELL), x1 = Math.floor(p.box.max.x / CELL);
    const z0 = Math.floor(p.box.min.z / CELL), z1 = Math.floor(p.box.max.z / CELL);
    /* A piece spanning a district would be added to thousands of cells; those
     * are floors and hull plates, and they are exactly what a placement query
     * is not about. Skipped, and counted, rather than silently dropped. */
    if ((x1 - x0 + 1) * (z1 - z0 + 1) > 256) { p._huge = true; return; }
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const k = key(ix, iz);
        let b = grid.get(k);
        if (!b) grid.set(k, (b = []));
        b.push(i);
      }
    }
  });

  const seen = new Set();
  const pairs = [];
  for (const bucket of grid.values()) {
    for (let a = 0; a < bucket.length; a++) {
      for (let b = a + 1; b < bucket.length; b++) {
        const i = bucket[a], j = bucket[b];
        const pk = i < j ? `${i}:${j}` : `${j}:${i}`;
        if (seen.has(pk)) continue;
        seen.add(pk);
        const A = parts[i], B = parts[j];
        if (same(A, B)) continue;
        const ox = Math.min(A.box.max.x, B.box.max.x) - Math.max(A.box.min.x, B.box.min.x);
        const oy = Math.min(A.box.max.y, B.box.max.y) - Math.max(A.box.min.y, B.box.min.y);
        const oz = Math.min(A.box.max.z, B.box.max.z) - Math.max(A.box.min.z, B.box.min.z);
        if (ox > minOverlap && oy > minOverlap && oz > minOverlap) {
          pairs.push({ a: A, b: B, overlap: Math.min(ox, oy, oz), volume: ox * oy * oz });
        }
      }
    }
  }
  return pairs.sort((p, q) => q.volume - p.volume);
}
