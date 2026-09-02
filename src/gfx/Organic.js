import * as THREE from 'three';

/**
 * Smooth swept surfaces, for the parts of a creature that are not boxes.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * The mounts in this game were assembled from boxes, and no amount of rounding
 * the edges fixes that: an animal is one continuous surface whose cross-section
 * changes along its length, and a stack of separate primitives is always going
 * to read as a stack of separate primitives. Rounding the corners of a bench
 * gives you a rounded bench.
 *
 * What is actually wanted is a *generalised cylinder*: a path through space with
 * an ellipse swept along it, the ellipse changing size as it goes. That single
 * primitive is the correct description of a horse's barrel, its neck, its skull,
 * every one of its legs, its tail, an eagle's body, and a wing bone. Built that
 * way the surface is genuinely continuous, smooth-shaded, and as dense as the
 * segment counts asked for - which is the difference between low-poly and high-
 * poly in the sense that matters here.
 *
 * ── The frame problem ─────────────────────────────────────────────────────
 *
 * Sweeping an ellipse along a path needs a coordinate frame at every station,
 * and the naive choice - cross the tangent with world up - flips over when the
 * path turns vertical, which is exactly what a horse's neck and every one of its
 * legs do. This uses **parallel transport**: the first frame is chosen once, and
 * each subsequent one is the previous frame rotated by the minimum amount that
 * lines it up with the new tangent. The result never flips and never twists, at
 * the cost of one quaternion per station.
 *
 * ── Why the mesh is indexed ───────────────────────────────────────────────
 *
 * This used to emit six independent vertices per quad and then call
 * `computeVertexNormals()`. That combination cannot produce a smooth surface:
 * on NON-indexed geometry three takes the "unconnected triangle soup" branch
 * and assigns one FACE normal to all three vertices of every triangle, so the
 * whole point of the exercise - a continuous surface as dense as `radial` asks
 * for - was thrown away at the last line of the function and every swept part
 * in the game shaded as a faceted prism. It now builds an indexed
 * (n x radial+1) grid and computes normals analytically from the frame, which
 * is both exact and free. Callers that merge geometries still guard with
 * `g.index ? g.toNonIndexed() : g`, and `toNonIndexed()` copies the normal
 * attribute, so the smoothing survives that path.
 */

const _t = new THREE.Vector3();
const _n = new THREE.Vector3();
const _b = new THREE.Vector3();
const _prevT = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _du = new THREE.Vector3();   // lengthwise surface tangent at a grid point
const _n0 = new THREE.Vector3();   // cross-section (ellipse) normal, in-plane
const _nv = new THREE.Vector3();   // the surface normal the two of them imply

/**
 * One cross-section of a swept surface.
 * @typedef {object} Section
 * @property {number} [x] centre, defaults to 0
 * @property {number} y   centre
 * @property {number} z   centre
 * @property {number} rx  half-width of the ellipse
 * @property {number} ry  half-height of the ellipse
 */

/**
 * Sweep an ellipse along the path through `sections`.
 *
 * Ends are closed by collapsing the final ring to its centre point rather than
 * by a flat cap, so a limb finishes as a dome and not as a cut pipe. Where a
 * part genuinely does end flat - a severed join hidden inside a parent mass -
 * pass the relevant cap as false and let the parent cover it.
 *
 * @param {Section[]} sections at least two, ordered along the sweep
 * @param {number} [radial] vertices around the ellipse; 16 is smooth at arm's
 *   length, 10 is enough for something the size of a cannon bone
 * @param {{capStart?:boolean, capEnd?:boolean}} [opts]
 * @returns {THREE.BufferGeometry} indexed, with exact smooth vertex normals
 */
export function sweep(sections, radial = 16, { capStart = true, capEnd = true } = {}) {
  const n = sections.length;
  if (n < 2) throw new Error('sweep needs at least two sections');

  /* ---- centres ---- */
  const centres = sections.map((s) => new THREE.Vector3(s.x ?? 0, s.y, s.z));

  /* ---- parallel-transported frames ---- */
  const rights = [];
  const ups = [];
  // The tangent is kept per station now, not just used and discarded: the
  // analytic normals tilt against it and the caps point their poles down it.
  const tangents = [];
  for (let i = 0; i < n; i++) {
    // Tangent by central difference, so interior stations follow the curve
    // rather than the segment that happens to precede them.
    if (i === 0) _t.subVectors(centres[1], centres[0]);
    else if (i === n - 1) _t.subVectors(centres[n - 1], centres[n - 2]);
    else _t.subVectors(centres[i + 1], centres[i - 1]);
    if (_t.lengthSq() < 1e-12) _t.set(0, 0, 1);
    _t.normalize();

    if (i === 0) {
      // Seed the frame from whichever world axis is least parallel to the
      // tangent, so the first ring is never degenerate.
      _n.set(0, 1, 0);
      if (Math.abs(_t.dot(_n)) > 0.92) _n.set(0, 0, 1);
      _b.crossVectors(_n, _t).normalize();
      _n.crossVectors(_t, _b).normalize();
    } else {
      /* Rotate the previous frame onto the new tangent by the shortest arc.
       * This is the whole point: no reference to world up, so nothing flips
       * when the path stands vertical. */
      _b.copy(rights[i - 1]);
      _n.copy(ups[i - 1]);
      _axis.crossVectors(_prevT, _t);
      const sin = _axis.length();
      const cos = _prevT.dot(_t);
      if (sin > 1e-6) {
        _axis.divideScalar(sin);
        _q.setFromAxisAngle(_axis, Math.atan2(sin, cos));
        _b.applyQuaternion(_q);
        _n.applyQuaternion(_q);
      }
      // Re-orthogonalise against drift accumulated over many stations.
      _b.addScaledVector(_t, -_b.dot(_t)).normalize();
      _n.crossVectors(_t, _b).normalize();
    }
    rights.push(_b.clone());
    ups.push(_n.clone());
    tangents.push(_t.clone());
    _prevT.copy(_t);
  }

  /* ---- ring vertices ---- */
  const rings = [];
  for (let i = 0; i < n; i++) {
    const s = sections[i];
    const ring = [];
    for (let k = 0; k < radial; k++) {
      const a = (k / radial) * Math.PI * 2;
      const c = Math.cos(a) * s.rx;
      const d = Math.sin(a) * s.ry;
      ring.push(new THREE.Vector3(
        centres[i].x + rights[i].x * c + ups[i].x * d,
        centres[i].y + rights[i].y * c + ups[i].y * d,
        centres[i].z + rights[i].z * c + ups[i].z * d
      ));
    }
    rings.push(ring);
  }

  /* ---- grid vertices ----
   *
   * One vertex per grid point instead of six per quad. The seam column (k ===
   * radial) is the same POSITION as column 0 written twice, so u can run 0..1
   * continuously across the sheet without the last quad's texture running
   * backwards. It reads its position and its normal from column 0's own
   * numbers rather than recomputing them from an angle of 2*PI, so the pair is
   * bit-identical and the duplicate costs a vertex and not a shading seam.
   */
  const cols = radial + 1;
  const vcount = n * cols + (capStart ? 1 : 0) + (capEnd ? 1 : 0);
  const pos = new Float32Array(vcount * 3);
  const nrm = new Float32Array(vcount * 3);
  const uv = new Float32Array(vcount * 2);

  for (let i = 0; i < n; i++) {
    const s = sections[i];
    const ring = rings[i];
    // Neighbouring rings, clamped at the ends: a central difference between
    // them is the surface's LENGTHWISE tangent, which on anything that tapers
    // - which is every limb, frond and feather here - is not the path tangent.
    const prev = rings[i === 0 ? 0 : i - 1];
    const next = rings[i === n - 1 ? n - 1 : i + 1];
    const tan = tangents[i];
    const vRow = i / (n - 1);
    for (let k = 0; k < cols; k++) {
      const kk = k === radial ? 0 : k;
      const j = i * cols + k;
      const p = ring[kk];
      pos[j * 3] = p.x; pos[j * 3 + 1] = p.y; pos[j * 3 + 2] = p.z;
      uv[j * 2] = k / radial; uv[j * 2 + 1] = vRow;

      /* Normal, analytically.
       *
       * The ellipse (x/rx)^2 + (y/ry)^2 = 1 has gradient (ry*cos a, rx*sin a)
       * at parameter a. The radii SWAP - that is not a typo, and it is what
       * makes a blade's broad faces shade as broad faces instead of rolling
       * round like a squashed cylinder. It is the exact normal of the
       * cross-section: perpendicular to the ring, but not yet to the surface. */
      const a = (kk / radial) * Math.PI * 2;
      _n0.set(0, 0, 0)
        .addScaledVector(rights[i], s.ry * Math.cos(a))
        .addScaledVector(ups[i], s.rx * Math.sin(a));
      // A section with no extent on the axis that matters (a needle tip, or
      // the two ends of a zero-width blade) has no ellipse gradient at all.
      // Fall back to the direction of the point itself, which is the limit the
      // gradient approaches as the radius closes.
      if (_n0.lengthSq() < 1e-20) {
        _n0.set(0, 0, 0)
          .addScaledVector(rights[i], Math.cos(a))
          .addScaledVector(ups[i], Math.sin(a));
      }
      _n0.normalize();

      /* Tilt it into the surface. The true normal is the one direction
       * perpendicular to BOTH the ring (_n0) and the lengthwise tangent (_du),
       * and since the frame tangent is already perpendicular to the ring, that
       * direction is _n0*(t.du) - t*(_n0.du). Skip this and a tapering limb
       * shades like a stack of cylinders instead of a cone. */
      _du.subVectors(next[kk], prev[kk]);
      const tdu = tan.dot(_du);
      _nv.copy(_n0).multiplyScalar(tdu).addScaledVector(tan, -_n0.dot(_du));
      // tdu <= 0 means the path folds back on itself, and a zero length means
      // two coincident sections: in both cases the cross-section normal is the
      // best answer left, and it is never zero after the fallback above.
      if (tdu <= 0 || _nv.lengthSq() < 1e-20) _nv.copy(_n0);
      _nv.normalize();
      nrm[j * 3] = _nv.x; nrm[j * 3 + 1] = _nv.y; nrm[j * 3 + 2] = _nv.z;
    }
  }

  /* ---- indices ----
   *
   * Two triangles per quad, wound so the OUTSIDE of the tube is the front
   * face. The old six-vertex stitch wound the body the other way round, and
   * only the body: on a straight +Z sweep all 48 body triangles faced inward
   * while both cap fans faced outward, and an uncapped horse leg measured a
   * signed volume of -5.19e-3 where the same solid now measures +5.19e-3 -
   * equal and opposite, which is what "inside out" means numerically. Every
   * caller uses a FrontSide material, so each swept part was drawing the
   * inside of its own far wall: silhouette right, lighting mirrored, depth
   * a whole diameter too deep. The caps were always right; the body now
   * agrees with them. To put the old facing back, this is the only line that
   * has to change - (a, b, c, a, c, d).
   */
  const idx = [];
  for (let i = 0; i < n - 1; i++) {
    const row = i * cols;
    const nextRow = row + cols;
    for (let k = 0; k < radial; k++) {
      const a = row + k;
      const d = row + k + 1;
      const b = nextRow + k;
      const c = nextRow + k + 1;
      idx.push(a, c, b, a, d, c);
    }
  }

  /* Collapse the ends to a point - a dome, not a cut pipe.
   *
   * The fan reuses the ring's own vertices, so the cap cannot part company
   * with the body: same position, same normal, one vertex. The pole takes the
   * axis as its normal, and the fan interpolates from the tube's silhouette
   * round to it - which is what makes a geometrically flat disc read as a
   * dome, and what a per-face normal could never do. */
  let cap = n * cols;
  if (capStart) {
    const apex = cap++;
    _p.copy(centres[0]);
    pos[apex * 3] = _p.x; pos[apex * 3 + 1] = _p.y; pos[apex * 3 + 2] = _p.z;
    nrm[apex * 3] = -tangents[0].x;
    nrm[apex * 3 + 1] = -tangents[0].y;
    nrm[apex * 3 + 2] = -tangents[0].z;
    uv[apex * 2] = 0.5; uv[apex * 2 + 1] = 0;
    for (let k = 0; k < radial; k++) idx.push(apex, k + 1, k);
  }
  if (capEnd) {
    const apex = cap++;
    const base = (n - 1) * cols;
    _p.copy(centres[n - 1]);
    pos[apex * 3] = _p.x; pos[apex * 3 + 1] = _p.y; pos[apex * 3 + 2] = _p.z;
    nrm[apex * 3] = tangents[n - 1].x;
    nrm[apex * 3 + 1] = tangents[n - 1].y;
    nrm[apex * 3 + 2] = tangents[n - 1].z;
    uv[apex * 2] = 0.5; uv[apex * 2 + 1] = 1;
    for (let k = 0; k < radial; k++) idx.push(apex, base + k, base + k + 1);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

/**
 * An ellipsoid, for masses that are lumps rather than lengths - a cheek, a
 * shoulder, the crown of a skull.
 *
 * @param {number} rx @param {number} ry @param {number} rz
 * @param {number} x @param {number} y @param {number} z
 * @param {number} [seg]
 */
export function blob(rx, ry, rz, x, y, z, seg = 14) {
  const g = new THREE.SphereGeometry(1, seg, Math.max(6, seg >> 1));
  g.scale(rx, ry, rz);
  g.translate(x, y, z);
  return g;
}

/**
 * Feathers, fur tufts, manes: a flat blade that tapers and can curve.
 *
 * Built as a sweep with a very flat ellipse, which keeps it a single smooth
 * surface with real thickness rather than a zero-width plane that vanishes
 * edge-on and cannot cast a shadow.
 *
 * @param {number} len @param {number} baseW @param {number} tipW
 * @param {number} thick @param {number} curve radians of droop over the length
 * @param {number} [segs]
 */
export function blade(len, baseW, tipW, thick, curve, segs = 5) {
  const sections = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const ang = curve * t * t;          // curves harder toward the tip
    sections.push({
      x: 0,
      y: -Math.sin(ang) * len * t * 0.5,
      z: -Math.cos(ang) * len * t,
      rx: THREE.MathUtils.lerp(baseW, tipW, t) * 0.5,
      ry: thick * 0.5 * (1 - t * 0.4),
    });
  }
  return sweep(sections, 6);
}
