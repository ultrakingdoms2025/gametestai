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
 */

const _t = new THREE.Vector3();
const _n = new THREE.Vector3();
const _b = new THREE.Vector3();
const _prevT = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();

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
 * @returns {THREE.BufferGeometry} non-indexed, with smooth vertex normals
 */
export function sweep(sections, radial = 16, { capStart = true, capEnd = true } = {}) {
  const n = sections.length;
  if (n < 2) throw new Error('sweep needs at least two sections');

  /* ---- centres ---- */
  const centres = sections.map((s) => new THREE.Vector3(s.x ?? 0, s.y, s.z));

  /* ---- parallel-transported frames ---- */
  const rights = [];
  const ups = [];
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

  /* ---- stitch ---- */
  const pos = [];
  const uv = [];
  const push = (v, u, w) => { pos.push(v.x, v.y, v.z); uv.push(u, w); };

  for (let i = 0; i < n - 1; i++) {
    const a = rings[i];
    const b = rings[i + 1];
    const v0 = i / (n - 1);
    const v1 = (i + 1) / (n - 1);
    for (let k = 0; k < radial; k++) {
      const k2 = (k + 1) % radial;
      const u0 = k / radial;
      const u1 = (k + 1) / radial;
      push(a[k], u0, v0); push(b[k], u0, v1); push(b[k2], u1, v1);
      push(a[k], u0, v0); push(b[k2], u1, v1); push(a[k2], u1, v0);
    }
  }

  // Collapse the ends to a point - a dome, not a cut pipe.
  if (capStart) {
    _p.copy(centres[0]);
    const r = rings[0];
    for (let k = 0; k < radial; k++) {
      const k2 = (k + 1) % radial;
      push(_p, 0.5, 0); push(r[k2], (k + 1) / radial, 0); push(r[k], k / radial, 0);
    }
  }
  if (capEnd) {
    _p.copy(centres[n - 1]);
    const r = rings[n - 1];
    for (let k = 0; k < radial; k++) {
      const k2 = (k + 1) % radial;
      push(_p, 0.5, 1); push(r[k], k / radial, 1); push(r[k2], (k + 1) / radial, 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
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
