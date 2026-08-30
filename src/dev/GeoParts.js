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
        /* An InstancedMesh is usually anonymous - `instanced()` never names
         * one - so a finding reads "(unnamed)#28" and cannot be looked up.
         * The group it hangs under is named, and that is the district. */
        const name = o.name || (o.parent?.name ? `${o.parent.name}:instanced` : '(unnamed)');
        out.push({ mesh: name, obj: o, index: i, owner: null, piece: null, site: null, box, tris, instanced: true });
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
        obj: o,
        start: s,
        count: n,
        index: i,
        owner: p.owners[p.ownerOf[i]],
        piece: p.pieces[p.pieceOf[i]],
        site: p.sites ? p.sites[p.siteOf[i]] : null,
        box,
        tris: n / 3,
        instanced: false,
      });
    }
  });
  return out;
}

/**
 * How thin a piece must be before it is paint rather than an object.
 *
 * 15 cm. A kerb is 20; a floor decal, a shadow blob, a painted bay and a
 * hazard stripe are all authored at 0 to 5 cm.
 */
export const MARKING_H = 0.15;

/**
 * Is this piece painted ON a surface rather than standing on one?
 *
 * ── The false positive this exists to kill ────────────────────────────────
 *
 * A floor decal lying on a raised planter rim is, geometrically, entirely
 * inside that rim - so an exact containment test reports it at 100% and is
 * right, and useless. Measured at the planter site the owner reported,
 * (23.6, -20.2): 29 pieces read as >= 25% inside another, and 23 of them were
 * paint. Requiring thickness left 6, and the top one was the defect - a 2.5 m
 * barrier 39% inside the rim.
 *
 * This is the SAME false positive the abandoned drawn-geometry probe had
 * already handled - its note describes rejecting "the floor decal pierced by
 * its own floor" - and that increment 3 re-introduced by not carrying the
 * lesson across. It is in the library now, and not in a probe, so the next
 * gate built on `fractionInside` inherits it.
 *
 * HEIGHT, not the smallest dimension. A sign face is a plane too, and a plane
 * standing upright is an object: `dressing:signs#4` is 4.1 x 2.6 x 3.1, so it
 * survives this test and the buried-sign gate still sees it. Only pieces that
 * are flat IN Y are paint.
 */
export function isMarking(part, minH = MARKING_H) {
  return (part.box.max.y - part.box.min.y) < minH;
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

/* ── EXACT GEOMETRY ────────────────────────────────────────────────────────
 *
 * Everything above works in bounding boxes, and boxes lie in both directions.
 * They FOUND the signs driven through the avenue pylons and could not CONFIRM
 * the fix: a sign face is a rotated plane, so its AABB overlaps the post's
 * whether or not the plane does, and the post's own AABB is 2.8 m wide because
 * it is a 2.0 m square turned 37 degrees. A station-wide box sweep of 191 sign
 * faces returned 47 "buried" candidates that cannot be called defects, because
 * a correctly flush sign on a rotated wall panel reads exactly the same way.
 *
 * This is the spec's own collider lesson one level down - "a box is a
 * conservative approximation of drawn geometry" - and the spans are what make
 * it answerable, because they can hand back the actual triangles.
 */

/** The world-space triangles of one piece. 9 floats per triangle. */
export function trianglesOf(part) {
  const o = part.obj, g = o.geometry;
  const pos = g.getAttribute('position'), idx = g.index;
  const m = _m.identity();
  if (part.instanced) {
    o.getMatrixAt(part.index, m);
    m.premultiply(o.matrixWorld);
  } else {
    m.copy(o.matrixWorld);
  }
  const from = part.instanced ? 0 : part.start;
  const to = part.instanced ? idx.count : part.start + part.count;
  const out = new Float32Array((to - from) * 3);
  let w = 0;
  for (let k = from; k < to; k++) {
    _v.fromBufferAttribute(pos, idx.getX(k)).applyMatrix4(m);
    out[w++] = _v.x; out[w++] = _v.y; out[w++] = _v.z;
  }
  return out;
}

/**
 * Is `p` inside the closed surface `tri`?
 *
 * Ray parity: count the triangles a ray from `p` crosses, odd means inside.
 * Only meaningful for a CLOSED piece - a box is closed, a sign face is a single
 * plane and nothing is ever inside it, which is the right answer. An open shell
 * gives a meaningless parity, so callers filter to pieces with enough triangles
 * to be a solid, and the limit is stated rather than hidden.
 *
 * ── Why three oblique rays and not one along +X ───────────────────────────
 *
 * The first version cast one axis-aligned ray, and it was WRONG in the way that
 * costs most: it answered "outside" for the centre of a box, so a gate built on
 * it would have reported no defects and been believed. `BoxGeometry` splits
 * every face into two triangles, and the centre of a face lies exactly on the
 * shared diagonal - so the ray hits an edge, and whether that counts as nought,
 * one or two crossings is decided by the last bit of a float. It happened to
 * pass at the origin and fail at (10, 5, -3), which is the signature of an edge
 * case rather than a formula error.
 *
 * Oblique directions make an exact edge hit vanishingly unlikely, and three of
 * them voted make it irrelevant: any single ray that lands on an edge is
 * outvoted by two that do not.
 */
const RAYS = [
  [0.7211, 0.5117, 0.4671],
  [-0.4523, 0.8117, 0.3701],
  [0.3389, -0.4517, 0.8253],
];

function crossingsAlong(tri, px, py, pz, dx, dy, dz) {
  let n = 0;
  for (let i = 0; i < tri.length; i += 9) {
    const ax = tri[i], ay = tri[i + 1], az = tri[i + 2];
    const e1x = tri[i + 3] - ax, e1y = tri[i + 4] - ay, e1z = tri[i + 5] - az;
    const e2x = tri[i + 6] - ax, e2y = tri[i + 7] - ay, e2z = tri[i + 8] - az;
    /* h = d x e2 */
    const hx = dy * e2z - dz * e2y;
    const hy = dz * e2x - dx * e2z;
    const hz = dx * e2y - dy * e2x;
    const det = e1x * hx + e1y * hy + e1z * hz;
    if (det > -1e-12 && det < 1e-12) continue;
    const inv = 1 / det;
    const sx = px - ax, sy = py - ay, sz = pz - az;
    const u = inv * (sx * hx + sy * hy + sz * hz);
    if (u < 0 || u > 1) continue;
    /* q = s x e1 */
    const qx = sy * e1z - sz * e1y;
    const qy = sz * e1x - sx * e1z;
    const qz = sx * e1y - sy * e1x;
    const v = inv * (dx * qx + dy * qy + dz * qz);
    if (v < 0 || u + v > 1) continue;
    const t = inv * (e2x * qx + e2y * qy + e2z * qz);
    if (t > 1e-9) n++;
  }
  return n;
}

export function containsPoint(tri, px, py, pz) {
  let votes = 0;
  for (const [dx, dy, dz] of RAYS) {
    if ((crossingsAlong(tri, px, py, pz, dx, dy, dz) & 1) === 1) votes++;
  }
  return votes >= 2;
}

/**
 * How much of piece `a`'s SURFACE is inside piece `b`, from 0 to 1.
 *
 * ── Why surface samples and not vertices ──────────────────────────────────
 *
 * The first version sampled `a`'s vertices and reported 0.00 for a sign
 * threaded straight through a post - correctly, and uselessly. A 5 m sign on a
 * 2 m post has all four corners outside it; the buried part is the middle, and
 * a vertex sample never looks there. Vertices are the worst possible probe for
 * "is this piece inside that one", because they are by definition its extremes.
 *
 * So each triangle is sampled at fixed interior barycentric points. Fixed, not
 * random, because a gate that returns a different number each run cannot be
 * ratcheted - and this repository has been bitten by an unseeded sampler
 * before.
 */
const BARY = [
  [1 / 3, 1 / 3, 1 / 3],
  [0.6, 0.2, 0.2], [0.2, 0.6, 0.2], [0.2, 0.2, 0.6],
  [0.5, 0.4, 0.1], [0.1, 0.5, 0.4],
];

export function fractionInside(a, b, bTris) {
  const at = trianglesOf(a);
  const tris = bTris ?? trianglesOf(b);
  /* Fewer than four triangles cannot enclose a volume, so parity is
   * meaningless and 0 is the honest answer rather than a plausible number. */
  if (tris.length < 9 * 4) return 0;

  const triCount = at.length / 9;
  /* Stride over triangles so a 5,000-triangle piece costs about the same as a
   * twelve-triangle one. Reported through the sample count, not hidden. */
  const step = Math.max(1, Math.ceil(triCount / 48));
  let inside = 0, n = 0;
  for (let t = 0; t < triCount; t += step) {
    const i = t * 9;
    const ax = at[i], ay = at[i + 1], az = at[i + 2];
    const bx = at[i + 3], by = at[i + 4], bz = at[i + 5];
    const cx = at[i + 6], cy = at[i + 7], cz = at[i + 8];
    for (const [w0, w1, w2] of BARY) {
      n++;
      if (containsPoint(tris,
        ax * w0 + bx * w1 + cx * w2,
        ay * w0 + by * w1 + cy * w2,
        az * w0 + bz * w1 + cz * w2)) inside++;
    }
  }
  return n ? inside / n : 0;
}
