import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { fbm01, clamp01, smoothstep, worley2D, WORLEY } from '../gfx/Textures.js';
import { ParticlePool, SpeedLines, standardFromBake, makeGlowTexture } from './Hoverboard.js';

/**
 * The rideable dragon.
 *
 * The creature is a bone hierarchy, not a mesh: torso, six neck segments, nine
 * tail segments, two three-stage wings and four legs, all articulated. Every
 * piece is lofted from an elliptical sweep so the silhouette is continuous -
 * stacked primitives read as a toy, and at this size the player is looking at
 * the animal for minutes at a time.
 *
 * The wing membrane is the one piece of per-frame geometry work: five bilinear
 * panels are re-solved each frame from the current joint positions, with a sag
 * term driven by flap velocity so the skin billows on the downstroke. It is
 * ~250 vertices for both wings, which is far cheaper than skinning and gives
 * the fold-and-spread the rig needs.
 *
 * Flight is deliberately arcade: heading chases the look direction at a limited
 * rate, pitch follows the look angle, and lift is implied rather than
 * simulated. A flight-sim stall model is not what "fly the dragon over the map"
 * means, and it would make the mount unusable indoors.
 *
 * Dragon space: -Z forward, +Y up, +X right (house convention).
 */

/* ---- module scratch, one private block per function ---- */
const _br1 = new THREE.Vector3(); // _emitBreath
const _bq1 = new THREE.Quaternion(); // _aura billboard
const _bq2 = new THREE.Quaternion();
const _cap1 = new THREE.Vector3(); // makeCap
const _capQ = new THREE.Quaternion();
const _capUp = new THREE.Vector3(0, 1, 0);
const _dc1 = new THREE.Vector3(); // _resolveCollision
const _dc2 = new THREE.Vector3();
const _ds1 = new THREE.Vector3(); // getSeat / dismountPoint
const _wm1 = new THREE.Vector3(); // _updateMembrane
const _wm2 = new THREE.Vector3();
const _wm3 = new THREE.Vector3();
const _wm4 = new THREE.Vector3();
const _wmMat = new THREE.Matrix4();
const _wmPts = [];
for (let i = 0; i < 8; i++) _wmPts.push(new THREE.Vector3());
const _lf1 = new THREE.Vector3(); // loftGeometry
const _lf2 = new THREE.Vector3();
const _lf3 = new THREE.Vector3();
const _lf4 = new THREE.Vector3();
const _rn1 = new THREE.Vector3(); // _updateReins
const _rn2 = new THREE.Vector3();
const _rn3 = new THREE.Vector3();
const _rn4 = new THREE.Vector3();
const _rn5 = new THREE.Vector3();
const _rnMat = new THREE.Matrix4();
const _hw1 = new THREE.Vector3(); // harness build scratch
const _hw2 = new THREE.Vector3();
const _hw3 = new THREE.Vector3();

const damp = THREE.MathUtils.damp;
const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;

const CRUISE_SPEED = 17;
const BOOST_SPEED = 30;
const CLIMB_RATE = 8.5;
/** Body-centre to belly. Landing seats the belly, not the origin. */
const BELLY_DROP = 1.05;
const LEG_REACH = 1.15;
/** Capsule that keeps the dragon out of walls. */
const RIDE_RADIUS = 1.5;
const RIDE_HEIGHT = 3.2;

/**
 * Third-person framing while ridden. `scale` multiplies the on-foot boom and
 * `lift` raises the pivot, so the silhouette reads and the ground stays visible
 * under the animal instead of the camera sitting between its shoulder blades.
 */
const DRAGON_CAMERA = { scale: 3.4, lift: 2.5 };

/** Grab-handle grip point, in body space. Shared by the bar and the IK marker. */
const GRIP = { x: 0.22, y: 1.42, z: -1.50 };

/* ================================================================== */
/* Geometry helpers                                                    */
/* ================================================================== */

/**
 * Sweep an elliptical cross-section along a polyline.
 *
 * Frames are built from the local tangent with a fixed world up, flipping to a
 * secondary reference when the tangent approaches vertical - a proper parallel
 * transport frame is overkill for limbs that never loop.
 *
 * @param {Array<{p:number[], rx:number, ry:number, yOff?:number}>} sections
 * @param {number} radial ring resolution
 * @param {{capStart?:boolean, capEnd?:boolean, uvScale?:number}} [opts]
 */
function loftGeometry(sections, radial = 10, opts = {}) {
  const n = sections.length;
  const verts = n * (radial + 1);
  const positions = new Float32Array(verts * 3);
  const uvs = new Float32Array(verts * 2);
  const indices = [];
  const uvScale = opts.uvScale ?? 1;

  let vi = 0;
  let uvi = 0;
  for (let s = 0; s < n; s++) {
    const cur = sections[s];
    const prev = sections[Math.max(0, s - 1)];
    const next = sections[Math.min(n - 1, s + 1)];
    _lf1.set(cur.p[0], cur.p[1], cur.p[2]);
    _lf2.set(next.p[0] - prev.p[0], next.p[1] - prev.p[1], next.p[2] - prev.p[2]);
    if (_lf2.lengthSq() < 1e-9) _lf2.set(0, 0, -1);
    _lf2.normalize();
    // Reference up: swap axes when the tangent is close to vertical.
    if (Math.abs(_lf2.y) > 0.94) _lf3.set(0, 0, -1);
    else _lf3.set(0, 1, 0);
    _lf4.crossVectors(_lf2, _lf3).normalize(); // right
    _lf3.crossVectors(_lf4, _lf2).normalize(); // corrected up

    const v = s / (n - 1);
    for (let r = 0; r <= radial; r++) {
      const a = (r / radial) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const x = _lf1.x + _lf4.x * ca * cur.rx + _lf3.x * sa * cur.ry;
      const y = _lf1.y + _lf4.y * ca * cur.rx + _lf3.y * sa * cur.ry;
      const z = _lf1.z + _lf4.z * ca * cur.rx + _lf3.z * sa * cur.ry;
      positions[vi++] = x;
      positions[vi++] = y;
      positions[vi++] = z;
      uvs[uvi++] = (r / radial) * uvScale;
      uvs[uvi++] = v * uvScale * 2;
    }
  }

  for (let s = 0; s < n - 1; s++) {
    const row = s * (radial + 1);
    const nextRow = (s + 1) * (radial + 1);
    for (let r = 0; r < radial; r++) {
      indices.push(row + r, nextRow + r, row + r + 1);
      indices.push(row + r + 1, nextRow + r, nextRow + r + 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);

  const caps = [];
  if (opts.capStart !== false) caps.push(makeCap(sections[0], sections[1], radial));
  if (opts.capEnd !== false) caps.push(makeCap(sections[n - 1], sections[n - 2], radial));
  geo.computeVertexNormals();
  if (caps.length) {
    const merged = mergeGeometries([geo, ...caps], false);
    geo.dispose();
    for (const c of caps) c.dispose();
    merged.computeVertexNormals();
    return merged;
  }
  return geo;
}

/**
 * A hemispherical cap so lofted limbs are closed solids, not open tubes. The
 * dome is aimed along the outward axis of the end section, which is why the
 * neighbouring section has to come in: bones run along +X, spines along +Y and
 * the torso along -Z, and a cap pinned to one of those would be wrong on the
 * other two.
 */
function makeCap(section, neighbour, radial) {
  const r = (section.rx + section.ry) * 0.5;
  const g = new THREE.SphereGeometry(r, radial, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  g.scale(1, 0.78, 1);
  _cap1
    .set(
      section.p[0] - neighbour.p[0],
      section.p[1] - neighbour.p[1],
      section.p[2] - neighbour.p[2]
    )
    .normalize();
  if (_cap1.lengthSq() < 0.5) _cap1.set(0, 1, 0);
  _capQ.setFromUnitVectors(_capUp, _cap1);
  g.applyQuaternion(_capQ);
  g.translate(section.p[0], section.p[1], section.p[2]);
  return g;
}

/** Straight tapered bone along +X, used for wing arms and legs. */
function boneGeometry(length, r0, r1, radial = 8, bulge = 1.0) {
  const sections = [];
  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const r = lerp(r0, r1, t) * (1 + Math.sin(t * Math.PI) * (bulge - 1));
    sections.push({ p: [t * length, 0, 0], rx: r, ry: r * 0.86 });
  }
  return loftGeometry(sections, radial, { uvScale: 1.5 });
}

/** A curving horn/claw: tapered sweep bent through `curve` radians. */
function hornGeometry(length, r0, curve, radial = 7, twist = 0) {
  const sections = [];
  const steps = 7;
  let x = 0;
  let y = 0;
  let z = 0;
  let ang = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    sections.push({ p: [x, y, z], rx: r0 * (1 - t) ** 0.8 + 0.004, ry: r0 * (1 - t) ** 0.8 + 0.004 });
    ang += curve / steps;
    const seg = length / steps;
    x += Math.cos(ang) * seg;
    y += Math.sin(ang) * seg;
    z += Math.sin(t * Math.PI) * twist * seg;
  }
  return loftGeometry(sections, radial, { capStart: false });
}

/**
 * Dorsal spike: a flattened, backswept blade. Thin across the spine and deep
 * fore-aft, which is the profile that reads as a crest rather than a fin.
 * (In this frame the ring's `rx` runs across -X and `ry` along -Z.)
 */
function spikeGeometry(height, base, sweep = 0.35) {
  const sections = [
    { p: [0, 0, 0], rx: base * 0.34, ry: base },
    { p: [0, height * 0.45, sweep * height * 0.35], rx: base * 0.22, ry: base * 0.66 },
    { p: [0, height * 0.8, sweep * height * 0.75], rx: base * 0.12, ry: base * 0.34 },
    { p: [0, height, sweep * height], rx: 0.005, ry: 0.008 },
  ];
  return loftGeometry(sections, 6, { capStart: true, capEnd: false });
}

/* ------------------------------------------------------------------ */
/* Harness geometry                                                    */
/* ------------------------------------------------------------------ */

/**
 * The torso loft's cross-sections, duplicated as data.
 *
 * The harness has to sit *on* the animal, not near it, so every strap is
 * derived from the same numbers the body mesh is lofted from. Duplicating the
 * table is deliberate: `loftGeometry` consumes and forgets its sections, and a
 * harness that guesses the barrel radius is a harness that floats.
 * Entries are `[z, centreY, halfWidth, halfHeight]`, front (-z) last.
 */
const TORSO_PROFILE = [
  [2.25, 0.05, 0.30, 0.32],
  [1.75, 0.05, 0.55, 0.60],
  [1.0, 0.02, 0.86, 0.88],
  [0.2, 0.0, 1.02, 1.0],
  [-0.6, 0.02, 1.0, 1.06],
  [-1.35, 0.06, 0.78, 0.86],
  [-1.95, 0.14, 0.5, 0.55],
  [-2.25, 0.2, 0.34, 0.36],
];

/** Interpolated body cross-section at a given z. @returns {{cy:number, rx:number, ry:number}} */
const _sec = { cy: 0, rx: 0, ry: 0 };
function torsoAt(z) {
  const P = TORSO_PROFILE;
  if (z >= P[0][0]) return Object.assign(_sec, { cy: P[0][1], rx: P[0][2], ry: P[0][3] });
  for (let i = 1; i < P.length; i++) {
    if (z >= P[i][0]) {
      const a = P[i - 1];
      const b = P[i];
      const t = (a[0] - z) / (a[0] - b[0]);
      _sec.cy = lerp(a[1], b[1], t);
      _sec.rx = lerp(a[2], b[2], t);
      _sec.ry = lerp(a[3], b[3], t);
      return _sec;
    }
  }
  const l = P[P.length - 1];
  return Object.assign(_sec, { cy: l[1], rx: l[2], ry: l[3] });
}

/**
 * A flat strap wrapped around an elliptical cross-section in the XY plane.
 *
 * Four vertices per ring (outer front/back, inner front/back) swept round the
 * ellipse, so the result is a belt with real width and thickness rather than a
 * torus that reads as rope. Offsetting outward along the ellipse *gradient*
 * rather than the radius is what keeps the strap standing proud of the hide by
 * the same few millimetres all the way round a non-circular barrel.
 */
function strapBand({
  rx, ry, cy = 0, cx = 0, z = 0,
  halfWidth = 0.09, thick = 0.022, lift = 0.02,
  a0 = 0, a1 = Math.PI * 2, seg = 44, uvRepeat = 5,
}) {
  const rings = seg + 1;
  const positions = new Float32Array(rings * 4 * 3);
  const uvs = new Float32Array(rings * 4 * 2);
  const idx = [];
  for (let i = 0; i < rings; i++) {
    const t = i / seg;
    const a = a0 + (a1 - a0) * t;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    let nx = ca / rx;
    let ny = sa / ry;
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl;
    ny /= nl;
    const px = cx + rx * ca + nx * lift;
    const py = cy + ry * sa + ny * lift;
    const base = i * 4;
    const put = (k, x, y, zz, uu, vv) => {
      positions[(base + k) * 3] = x;
      positions[(base + k) * 3 + 1] = y;
      positions[(base + k) * 3 + 2] = zz;
      uvs[(base + k) * 2] = uu;
      uvs[(base + k) * 2 + 1] = vv;
    };
    put(0, px + nx * thick, py + ny * thick, z - halfWidth, t * uvRepeat, 0);
    put(1, px + nx * thick, py + ny * thick, z + halfWidth, t * uvRepeat, 0.34);
    put(2, px, py, z + halfWidth, t * uvRepeat, 0.68);
    put(3, px, py, z - halfWidth, t * uvRepeat, 1);
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 4;
    const b = (i + 1) * 4;
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      idx.push(a + k, b + k, a + k2, a + k2, b + k, b + k2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * A straight flat strap between two points, with an explicit side axis.
 *
 * `loftGeometry` cannot be used for these: its frames come from the tangent and
 * world up, which degenerates for the near-vertical runs (stirrup leathers,
 * breast-collar tugs) that make up most of the harness. Naming the side axis
 * removes the degeneracy and also lets a strap lie flat against the flank.
 */
function flatStrap(a, b, halfWidth, thick, side, uvRepeat = 2) {
  _hw1.subVectors(b, a);
  const len = _hw1.length() || 1e-4;
  _hw1.multiplyScalar(1 / len);
  _hw2.copy(side).addScaledVector(_hw1, -_hw1.dot(side));
  if (_hw2.lengthSq() < 1e-8) _hw2.set(1, 0, 0).addScaledVector(_hw1, -_hw1.x);
  _hw2.normalize().multiplyScalar(halfWidth);
  _hw3.crossVectors(_hw1, _hw2).normalize().multiplyScalar(thick);

  const pos = new Float32Array(8 * 3);
  const uv = new Float32Array(8 * 2);
  let k = 0;
  let m = 0;
  for (let e = 0; e < 2; e++) {
    const p = e === 0 ? a : b;
    for (let c = 0; c < 4; c++) {
      const sw = c === 0 || c === 3 ? 1 : -1;
      const tw = c < 2 ? 1 : -1;
      pos[k++] = p.x + _hw2.x * sw + _hw3.x * tw;
      pos[k++] = p.y + _hw2.y * sw + _hw3.y * tw;
      pos[k++] = p.z + _hw2.z * sw + _hw3.z * tw;
      uv[m++] = c * 0.25;
      uv[m++] = e * uvRepeat;
    }
  }
  const idx = [];
  for (let c = 0; c < 4; c++) {
    const c2 = (c + 1) % 4;
    idx.push(c, 4 + c, c2, c2, 4 + c, 4 + c2);
  }
  idx.push(0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A tapered metal bar between two points - handle uprights and grab rails. */
function barBetween(ax, ay, az, bx, by, bz, r0, r1, radial = 8) {
  _hw1.set(bx - ax, by - ay, bz - az);
  const len = _hw1.length() || 1e-4;
  _hw1.multiplyScalar(1 / len);
  const g = new THREE.CylinderGeometry(r1, r0, len, radial, 1);
  const q = new THREE.Quaternion().setFromUnitVectors(_capUp, _hw1);
  const m = new THREE.Matrix4().makeRotationFromQuaternion(q);
  m.setPosition((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
  g.applyMatrix4(m);
  return g;
}

/**
 * A stirrup iron: a wrought arch in the XY plane with a flat tread and an eye
 * at the crown for the leather. The plane matters - the rider's foot passes
 * through it along -Z, so the ring has to open fore-and-aft, not sideways.
 */
function stirrupGeometry(radius = 0.115) {
  const arch = new THREE.TorusGeometry(radius, 0.021, 7, 20, Math.PI * 1.2);
  arch.rotateZ(Math.PI * 0.9);
  const tread = new THREE.BoxGeometry(radius * 1.6, 0.024, 0.10);
  tread.translate(0, -radius + 0.006, 0);
  const eye = new THREE.TorusGeometry(0.030, 0.012, 6, 12);
  eye.rotateY(Math.PI / 2);
  eye.translate(0, radius + 0.018, 0);
  const g = mergeGeometries([arch, tread, eye], false);
  arch.dispose();
  tread.dispose();
  eye.dispose();
  return g;
}

/** A roller buckle: rectangular frame, centre bar and tongue. */
function buckleGeometry(w = 0.13, h = 0.095) {
  const t = 0.016;
  const parts = [];
  const bar = (sx, sy, x, y) => {
    const b = new THREE.BoxGeometry(sx, sy, t);
    b.translate(x, y, 0);
    parts.push(b);
  };
  bar(w, t, 0, h * 0.5);
  bar(w, t, 0, -h * 0.5);
  bar(t, h, -w * 0.5, 0);
  bar(t, h, w * 0.5, 0);
  bar(t * 0.8, h * 0.86, 0, 0);
  const tongue = new THREE.BoxGeometry(w * 0.62, t * 0.7, t * 0.7);
  tongue.translate(w * 0.28, 0, 0);
  parts.push(tongue);
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return g;
}

/* ================================================================== */
/* Materials                                                           */
/* ================================================================== */

/** Overlapping scale rows with a warm crevice glow under a cold hide. */
function shadeScales(u, v, out) {
  const rows = 30;
  const cols = 22;
  const fy = v * rows;
  const iy = Math.floor(fy);
  const ty = fy - iy;
  const fx = u * cols + (iy & 1) * 0.5;
  const ix = Math.floor(fx);
  const tx = fx - ix;

  const dx = (tx - 0.5) * 2;
  const dy = (ty - 0.5) * 2;
  // Teardrop metric: scales are wider than they are tall and taper downward.
  const d = Math.sqrt(dx * dx * 0.9 + dy * dy * 1.35 * (1 + dy * 0.25));
  const inside = clamp01(1 - d);
  const dome = Math.sqrt(Math.max(0, 1 - d * d * 0.85));

  const patch = fbm01(u, v, 7, 7, 3, 21);
  const grain = fbm01(u, v, 90, 90, 2, 63);
  const tone = 0.5 + patch * 0.5;

  // Deep basalt green-black with an iron sheen; crevices go warm.
  const base = 0.035 + dome * 0.10 * tone + grain * 0.012;
  out.r = base * (0.72 + patch * 0.5) + (1 - inside) * 0.020;
  out.g = base * (1.0 + patch * 0.18) + (1 - inside) * 0.012;
  out.b = base * (0.95 - patch * 0.28) + (1 - inside) * 0.006;
  out.h = 0.25 + dome * 0.75 * (0.75 + patch * 0.35);
  out.rough = 0.72 - dome * 0.30 + grain * 0.08;
  out.metal = 0.12 + dome * 0.16;
  out.ao = 0.55 + inside * 0.45;
}

/** Belly plates: broad horizontal bands of keratin. */
function shadeBelly(u, v, out) {
  const bands = 16;
  const fy = v * bands;
  const iy = Math.floor(fy);
  const ty = fy - iy;
  const edge = smoothstep(0, 0.09, ty) * (1 - smoothstep(0.9, 1, ty));
  const grain = fbm01(u * 2, v, 60, 18, 3, 9);
  const wear = fbm01(u, v, 9, 5, 3, 44);
  const base = 0.16 + edge * 0.16 + grain * 0.05 + wear * 0.06;
  out.r = base * 1.18;
  out.g = base * 1.02;
  out.b = base * 0.74;
  out.h = 0.3 + edge * 0.7;
  out.rough = 0.62 + grain * 0.2;
  out.metal = 0.04;
  out.ao = 0.62 + edge * 0.38;
}

/** Wing membrane: thin skin over a branching vein network. */
function shadeMembrane(u, v, out) {
  worley2D(u, v, 5, 5, 3, 1);
  const cell = WORLEY[0];
  // Cell borders make believable capillary branching for almost nothing.
  const vein = 1 - smoothstep(0.0, 0.085, cell);
  const fine = 1 - smoothstep(0.0, 0.03, cell);
  const mottle = fbm01(u, v, 12, 12, 4, 77);
  const base = 0.09 + mottle * 0.07;
  out.r = base * 2.1 + vein * 0.16;
  out.g = base * 0.95 + vein * 0.05;
  out.b = base * 0.86 + vein * 0.05;
  out.h = 0.5 + vein * 0.4 + fine * 0.1;
  out.rough = 0.55 + mottle * 0.3;
  out.metal = 0;
  out.ao = 0.8 + (1 - vein) * 0.2;
  // A faint warm bleed reads as light passing through the skin.
  out.er = vein * 0.10 + base * 0.16;
  out.eg = vein * 0.028 + base * 0.05;
  out.eb = vein * 0.02 + base * 0.04;
}

/** Keratin: horn, claw and tooth. */
function shadeHorn(u, v, out) {
  const rings = 26;
  const ring = Math.abs(((v * rings) % 1) - 0.5) * 2;
  const grain = fbm01(u, v * 0.4, 40, 160, 3, 13);
  const base = 0.30 + grain * 0.22 - ring * 0.06;
  out.r = base * 1.0;
  out.g = base * 0.95;
  out.b = base * 0.86;
  out.h = 0.4 + (1 - ring) * 0.4 + grain * 0.2;
  out.rough = 0.42 + ring * 0.22 + grain * 0.15;
  out.metal = 0.05;
  out.ao = 0.72 + (1 - ring) * 0.28;
}

/**
 * Saddle leather: quilted diamond panels with sunken seams, a stitch line
 * riding each seam, and a pebbled grain over the whole hide.
 *
 * The quilt is authored in UV space rather than as geometry because every part
 * of the harness is a swept band - a seam modelled as a crease would have to be
 * re-lofted per part, and at this scale the normal map carries it perfectly.
 */
function shadeLeather(u, v, out) {
  worley2D(u, v, 30, 30, 2, 3);
  const pebble = smoothstep(0.0, 0.07, WORLEY[0]);
  const grain = fbm01(u, v, 130, 130, 3, 31);
  const blotch = fbm01(u, v, 6, 6, 3, 7);

  // Two crossed seam families give diamond quilting; `puff` is the distance to
  // the nearest seam, which is what makes the panel dome between them.
  const q = 7;
  const d1 = Math.abs((((u * q + v * q * 1.6) % 1) + 1) % 1 - 0.5) * 2;
  const d2 = Math.abs((((u * q - v * q * 1.6) % 1) + 1) % 1 - 0.5) * 2;
  const seam = Math.max(1 - smoothstep(0.05, 0.2, d1), 1 - smoothstep(0.05, 0.2, d2));
  const puff = Math.min(1, Math.min(d1, d2) * 1.6);

  // Stitches: dashes running along whichever seam is nearest.
  const along = ((u + v) * q * 22) % 1;
  const stitch = seam > 0.62 && along < 0.42 ? 1 : 0;

  const base = 0.052 + blotch * 0.042 + grain * 0.013 + pebble * 0.011;
  out.r = base * 1.62 + stitch * 0.085;
  out.g = base * 1.06 + stitch * 0.072;
  out.b = base * 0.70 + stitch * 0.050;
  out.h = 0.30 + puff * 0.46 - seam * 0.28 + pebble * 0.14 + stitch * 0.16;
  out.rough = 0.80 - puff * 0.14 + grain * 0.12 - stitch * 0.12;
  out.metal = 0.02;
  out.ao = 0.58 + puff * 0.42 - seam * 0.18;
}

/** Tack hardware: blackened wrought iron rubbed back to brass on the wear faces. */
function shadeTack(u, v, out) {
  const grain = fbm01(u, v, 64, 64, 3, 5);
  const wear = fbm01(u, v, 7, 7, 4, 61);
  const brass = smoothstep(0.58, 0.84, wear);
  const pit = fbm01(u, v, 210, 210, 2, 17);
  const base = 0.085 + grain * 0.055 + pit * 0.025;
  out.r = base * (1 + brass * 3.4);
  out.g = base * (1 + brass * 2.4);
  out.b = base * (1 + brass * 0.8);
  out.h = 0.42 + grain * 0.34 - pit * 0.24;
  out.rough = 0.50 - brass * 0.24 + pit * 0.2;
  out.metal = 0.85 + brass * 0.13;
  out.ao = 0.7 + grain * 0.3;
}

function ensureMaterials(materials) {
  if (!materials.has('dragon.leather')) {
    const m = standardFromBake(512, shadeLeather, 2.4, {
      name: 'dragon.leather',
      repeat: 1,
      // Bands are swept surfaces whose winding is generated, not authored; a
      // one-sided material on a mis-wound strap renders as a hole.
      side: THREE.DoubleSide,
    });
    m.envMapIntensity = 0.9;
    materials.register('dragon.leather', m);
  }
  if (!materials.has('dragon.tack')) {
    const m = standardFromBake(256, shadeTack, 1.6, { name: 'dragon.tack', repeat: 1 });
    m.envMapIntensity = 1.35;
    materials.register('dragon.tack', m);
  }
  if (!materials.has('dragon.hide')) {
    const m = standardFromBake(512, shadeScales, 2.0, { name: 'dragon.hide', repeat: 2 });
    m.envMapIntensity = 1.1;
    materials.register('dragon.hide', m);
  }
  if (!materials.has('dragon.belly')) {
    materials.register(
      'dragon.belly',
      standardFromBake(256, shadeBelly, 1.4, { name: 'dragon.belly', repeat: 2 })
    );
  }
  if (!materials.has('dragon.membrane')) {
    const m = standardFromBake(512, shadeMembrane, 1.2, {
      name: 'dragon.membrane',
      emissive: 0xff7a4a,
      emissiveIntensity: 0.55,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.93,
    });
    m.roughness = 1;
    materials.register('dragon.membrane', m);
  }
  if (!materials.has('dragon.horn')) {
    materials.register(
      'dragon.horn',
      standardFromBake(256, shadeHorn, 1.3, { name: 'dragon.horn', repeat: 1 })
    );
  }
}

/* ================================================================== */
/* Dragon                                                              */
/* ================================================================== */

export class Dragon {
  /**
   * @param {{scene:THREE.Scene, engine:any, physics:any, bus:any, materials:any,
   *          camera:THREE.PerspectiveCamera}} ctx
   */
  constructor({ scene, engine, physics, bus, materials, camera }) {
    this.id = 'dragon';
    this.displayName = 'DRAGON';
    this.scene = scene;
    this.engine = engine;
    this.physics = physics;
    this.bus = bus;
    this.materials = materials;
    this.camera = camera;

    ensureMaterials(materials);

    /* ---- flight state ---- */
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.heading = 0;
    this.speed = 0;
    this.state = 'flying'; // 'flying' | 'landing' | 'grounded' | 'takeoff'
    this._pitch = 0;
    this._roll = 0;
    this._pitchTarget = 0;
    this._rollTarget = 0;
    this._turnRate = 0;
    this._vy = 0;
    this._boost = 0;
    this._boostActive = false;
    this._groundY = 0;
    /** True when the collision solver is holding us up - i.e. we are resting */
    /** on something the terrain probe cannot see, like a roof or a tree. */
    this._supported = false;
    this._flapPhase = 0;
    this._flapRate = 1.6;
    this._flapAmp = 1;
    this._legTuck = 1;
    this._ridden = false;
    this._spawnT = 1;
    this._despawnT = -1;
    this._alive = false;
    this._roar = 0;
    this._headYaw = 0;
    this._headPitch = 0;
    /** Hip height of whoever is in the saddle; refined by `setRiderDrop`. */
    this._riderDrop = 1.0;

    this._geos = [];
    this._buildModel();

    this._embers = new ParticlePool(scene, 72, { color: 0xff9a3c, drag: 0.9, gravity: 1.4 });
    this._dust = new ParticlePool(scene, 64, { color: 0xd8c9a8, drag: 2.4, gravity: -1.2 });
    this._speedLines = new SpeedLines(scene, 48, 0xffd9b8);
    this.setVisible(false);
  }

  /* ---------------------------------------------------------------- */
  /* Model construction                                                */
  /* ---------------------------------------------------------------- */

  _track(geo) {
    this._geos.push(geo);
    return geo;
  }

  _buildModel() {
    const M = this.materials;
    const hide = M.get('dragon.hide');
    const belly = M.get('dragon.belly');
    const horn = M.get('dragon.horn');
    const membrane = M.get('dragon.membrane');

    this.root = new THREE.Group();
    this.root.name = 'dragon';
    this.bank = new THREE.Group(); // pitch + roll
    this.body = new THREE.Group(); // breathing / flap recoil
    this.root.add(this.bank);
    this.bank.add(this.body);

    /* ---- torso ---- */
    const torso = this._track(
      loftGeometry(
        [
          { p: [0, 0.05, 2.25], rx: 0.30, ry: 0.32 },
          { p: [0, 0.05, 1.75], rx: 0.55, ry: 0.60 },
          { p: [0, 0.02, 1.0], rx: 0.86, ry: 0.88 },
          { p: [0, 0.0, 0.2], rx: 1.02, ry: 1.0 },
          { p: [0, 0.02, -0.6], rx: 1.0, ry: 1.06 },
          { p: [0, 0.06, -1.35], rx: 0.78, ry: 0.86 },
          { p: [0, 0.14, -1.95], rx: 0.5, ry: 0.55 },
          { p: [0, 0.2, -2.25], rx: 0.34, ry: 0.36 },
        ],
        16,
        { uvScale: 2 }
      )
    );
    const torsoMesh = new THREE.Mesh(torso, hide);
    torsoMesh.castShadow = true;
    torsoMesh.receiveShadow = true;
    this.body.add(torsoMesh);

    // Belly plating: a flattened shell under the torso in a warmer material.
    const bellyGeo = this._track(
      loftGeometry(
        [
          { p: [0, -0.5, 1.6], rx: 0.36, ry: 0.16 },
          { p: [0, -0.72, 0.9], rx: 0.62, ry: 0.22 },
          { p: [0, -0.82, 0.1], rx: 0.7, ry: 0.24 },
          { p: [0, -0.8, -0.7], rx: 0.66, ry: 0.24 },
          { p: [0, -0.66, -1.4], rx: 0.44, ry: 0.18 },
        ],
        12,
        { uvScale: 2 }
      )
    );
    const bellyMesh = new THREE.Mesh(bellyGeo, belly);
    bellyMesh.castShadow = false;
    bellyMesh.receiveShadow = true;
    this.body.add(bellyMesh);

    /* ---- dorsal spikes along the back ---- */
    const spike = this._track(spikeGeometry(0.3, 0.075, 0.5));
    const spineCount = 9;
    const spines = new THREE.InstancedMesh(spike, horn, spineCount);
    spines.castShadow = true;
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sv = new THREE.Vector3();
    const pv = new THREE.Vector3();
    for (let i = 0; i < spineCount; i++) {
      const t = i / (spineCount - 1);
      // The crest starts behind the cantle: a dorsal spike inside the seat is
      // a spike through the rider, and trimming the crest under tack is what a
      // working harness would do anyway.
      const z = lerp(-0.42, 2.0, t);
      const y = lerp(1.02, 0.34, smoothstep(0, 1, t) * 0.85 + t * 0.15);
      const s = 1 - Math.abs(t - 0.3) * 0.55;
      pv.set(0, y, z);
      q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.12);
      sv.set(s, s * (1.1 - t * 0.5), s);
      m4.compose(pv, q, sv);
      spines.setMatrixAt(i, m4);
    }
    spines.instanceMatrix.needsUpdate = true;
    this.body.add(spines);

    /* ---- neck ---- */
    this.neck = [];
    this.neckRoot = new THREE.Object3D();
    this.neckRoot.position.set(0, 0.28, -2.15);
    this.body.add(this.neckRoot);
    let parent = this.neckRoot;
    const NECK = 6;
    for (let i = 0; i < NECK; i++) {
      const t = i / (NECK - 1);
      const len = 0.44;
      const r0 = lerp(0.36, 0.19, t);
      const r1 = lerp(0.36, 0.19, (i + 1) / (NECK - 1));
      const seg = new THREE.Object3D();
      const geo = this._track(
        loftGeometry(
          [
            { p: [0, 0, 0], rx: r0, ry: r0 * 1.06 },
            { p: [0, 0.01, -len * 0.5], rx: (r0 + r1) * 0.5, ry: (r0 + r1) * 0.55 },
            { p: [0, 0.01, -len], rx: r1, ry: r1 * 1.06 },
          ],
          12,
          { uvScale: 1.4 }
        )
      );
      const mesh = new THREE.Mesh(geo, hide);
      mesh.castShadow = true;
      seg.add(mesh);

      // A frill spike per vertebra, in horn, so the neck has a crest.
      const frill = this._track(spikeGeometry(0.2 - t * 0.07, 0.045, 0.6));
      const frillMesh = new THREE.Mesh(frill, horn);
      frillMesh.position.set(0, r0 * 0.92, -len * 0.4);
      frillMesh.castShadow = true;
      seg.add(frillMesh);

      seg.position.z = i === 0 ? 0 : -0.44;
      parent.add(seg);
      parent = seg;
      this.neck.push(seg);
    }

    /* ---- head ---- */
    this.head = new THREE.Object3D();
    this.head.position.z = -0.44;
    parent.add(this.head);
    this._buildHead(hide, horn, membrane);

    /* ---- tail ---- */
    this.tail = [];
    this.tailRoot = new THREE.Object3D();
    this.tailRoot.position.set(0, 0.08, 2.3);
    this.body.add(this.tailRoot);
    parent = this.tailRoot;
    const TAIL = 9;
    for (let i = 0; i < TAIL; i++) {
      const t = i / TAIL;
      const t1 = (i + 1) / TAIL;
      const len = 0.5;
      const r0 = lerp(0.3, 0.045, t ** 0.85);
      const r1 = lerp(0.3, 0.045, t1 ** 0.85);
      const seg = new THREE.Object3D();
      const geo = this._track(
        loftGeometry(
          [
            { p: [0, 0, 0], rx: r0, ry: r0 * 1.05 },
            { p: [0, 0, len], rx: r1, ry: r1 * 1.05 },
          ],
          10,
          { uvScale: 1.2 }
        )
      );
      const mesh = new THREE.Mesh(geo, hide);
      mesh.castShadow = true;
      seg.add(mesh);
      if (i < TAIL - 2) {
        const sp = this._track(spikeGeometry(0.15 - t * 0.08, 0.035, 0.8));
        const spm = new THREE.Mesh(sp, horn);
        spm.position.set(0, r0 * 0.9, len * 0.4);
        seg.add(spm);
      }
      seg.position.z = i === 0 ? 0 : 0.5;
      parent.add(seg);
      parent = seg;
      this.tail.push(seg);
    }
    // Tail fin: two membrane blades at the tip.
    for (const side of [-1, 1]) {
      const fin = this._track(this._bladeGeometry(0.75, 0.34));
      const fm = new THREE.Mesh(fin, membrane);
      fm.position.set(0, 0.02, 0.1);
      fm.rotation.set(0, 0, side * 0.5);
      fm.scale.set(side, 1, 1);
      parent.add(fm);
    }

    /* ---- wings ---- */
    this.wings = [];
    for (const side of [1, -1]) {
      const wing = this._buildWing(side, hide, membrane, horn);
      this.wings.push(wing);
    }

    /* ---- legs ---- */
    this.legs = [];
    this.legs.push(this._buildLeg(1, true, hide, horn));
    this.legs.push(this._buildLeg(-1, true, hide, horn));
    this.legs.push(this._buildLeg(1, false, hide, horn));
    this.legs.push(this._buildLeg(-1, false, hide, horn));

    /* ---- riding harness in the shoulder pocket ahead of the wings ---- */
    this._buildHarness(M);

    /* ---- throat glow ---- */
    this._maw = new THREE.PointLight(0xff7a26, 0, 9, 2);
    this._maw.position.set(0, -0.06, -0.5);
    this.head.add(this._maw);
    this._auraTex = makeGlowTexture(128, 2.4);
    this._auraMat = new THREE.MeshBasicMaterial({
      map: this._auraTex,
      color: 0xff8a3a,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const auraGeo = this._track(new THREE.PlaneGeometry(1.4, 1.4));
    this._aura = new THREE.Mesh(auraGeo, this._auraMat);
    this._aura.position.set(0, -0.05, -0.72);
    this._aura.renderOrder = 6;
    this.head.add(this._aura);
  }

  /** A flat, tapered membrane blade (tail fin, ear frill). */
  _bladeGeometry(length, width) {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.quadraticCurveTo(width * 0.9, length * 0.35, width * 0.55, length * 0.95);
    shape.quadraticCurveTo(width * 0.3, length * 0.6, 0, length * 0.55);
    shape.lineTo(0, 0);
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: 0.012,
      bevelEnabled: false,
      curveSegments: 8,
    });
    geo.rotateY(Math.PI / 2);
    return geo;
  }

  _buildHead(hide, horn, membrane) {
    // Skull: brow ridge, cheek, tapering muzzle.
    const skull = this._track(
      loftGeometry(
        [
          { p: [0, 0.02, 0.16], rx: 0.19, ry: 0.20 },
          { p: [0, 0.06, 0.0], rx: 0.24, ry: 0.25 },
          { p: [0, 0.06, -0.22], rx: 0.26, ry: 0.23 },
          { p: [0, 0.03, -0.46], rx: 0.19, ry: 0.15 },
          { p: [0, 0.0, -0.7], rx: 0.14, ry: 0.11 },
          { p: [0, -0.01, -0.86], rx: 0.115, ry: 0.09 },
        ],
        14,
        { uvScale: 1.2 }
      )
    );
    const skullMesh = new THREE.Mesh(skull, hide);
    skullMesh.castShadow = true;
    this.head.add(skullMesh);

    // Jaw on a hinge behind the cheek.
    this.jaw = new THREE.Object3D();
    this.jaw.position.set(0, -0.05, -0.08);
    this.head.add(this.jaw);
    const jaw = this._track(
      loftGeometry(
        [
          { p: [0, 0, 0.02], rx: 0.16, ry: 0.09 },
          { p: [0, -0.02, -0.3], rx: 0.14, ry: 0.075 },
          { p: [0, -0.03, -0.58], rx: 0.10, ry: 0.055 },
          { p: [0, -0.035, -0.76], rx: 0.075, ry: 0.04 },
        ],
        10,
        { uvScale: 1.2 }
      )
    );
    const jawMesh = new THREE.Mesh(jaw, hide);
    jawMesh.castShadow = true;
    this.jaw.add(jawMesh);

    /* ---- horns, brow spikes and teeth, merged per material ---- */
    const hornParts = [];
    const addHorn = (geo, x, y, z, rx, ry, rz, scale = 1) => {
      const g = geo.clone();
      if (scale !== 1) g.scale(scale, scale, scale);
      const m = new THREE.Matrix4();
      m.makeRotationFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ'));
      m.setPosition(x, y, z);
      g.applyMatrix4(m);
      hornParts.push(g);
    };
    const mainHorn = hornGeometry(0.62, 0.055, -0.55, 7, 0.12);
    const browHorn = hornGeometry(0.2, 0.03, -0.35, 6);
    const cheekSpike = hornGeometry(0.16, 0.026, -0.2, 5);
    for (const side of [1, -1]) {
      // Main horns sweep up and back off the crown.
      addHorn(mainHorn, side * 0.13, 0.2, 0.02, -0.5, side * 0.42, side * -0.25);
      addHorn(browHorn, side * 0.17, 0.11, -0.3, -0.15, side * 0.55, side * -0.35);
      addHorn(cheekSpike, side * 0.2, -0.02, -0.06, 0.2, side * 1.1, side * -0.5);
      // Upper teeth.
      for (let i = 0; i < 4; i++) {
        const z = -0.34 - i * 0.15;
        addHorn(
          cheekSpike,
          side * (0.115 - i * 0.012),
          -0.09 + i * 0.012,
          z,
          Math.PI,
          0,
          side * 0.12,
          0.34 - i * 0.04
        );
      }
    }
    mainHorn.dispose();
    browHorn.dispose();
    cheekSpike.dispose();
    const hornGeo = this._track(mergeGeometries(hornParts, false));
    for (const g of hornParts) g.dispose();
    const hornMesh = new THREE.Mesh(hornGeo, horn);
    hornMesh.castShadow = true;
    this.head.add(hornMesh);

    // Lower teeth ride the jaw.
    const lowerParts = [];
    const tooth = hornGeometry(0.14, 0.022, -0.15, 5);
    for (const side of [1, -1]) {
      for (let i = 0; i < 4; i++) {
        const g = tooth.clone();
        g.scale(0.3, 0.3, 0.3);
        const m = new THREE.Matrix4();
        m.makeRotationFromEuler(new THREE.Euler(0, 0, side * -0.1, 'XYZ'));
        m.setPosition(side * (0.1 - i * 0.01), 0.02, -0.3 - i * 0.14);
        g.applyMatrix4(m);
        lowerParts.push(g);
      }
    }
    tooth.dispose();
    const lowerGeo = this._track(mergeGeometries(lowerParts, false));
    for (const g of lowerParts) g.dispose();
    this.jaw.add(new THREE.Mesh(lowerGeo, horn));

    /* ---- eyes ---- */
    this._eyeMat = new THREE.MeshStandardMaterial({
      color: 0x2a1600,
      emissive: new THREE.Color(0xffb14a),
      emissiveIntensity: 3.6,
      roughness: 0.25,
      metalness: 0,
      toneMapped: true,
    });
    const eyeGeo = this._track(new THREE.SphereGeometry(0.052, 14, 10));
    for (const side of [1, -1]) {
      const eye = new THREE.Mesh(eyeGeo, this._eyeMat);
      eye.position.set(side * 0.185, 0.075, -0.19);
      eye.scale.set(0.85, 1, 1.1);
      this.head.add(eye);
      // A hooded brow over each eye keeps it from reading as a stuck-on bead.
      const brow = this._track(
        loftGeometry(
          [
            { p: [side * 0.1, 0.16, -0.02], rx: 0.045, ry: 0.03 },
            { p: [side * 0.2, 0.15, -0.2], rx: 0.055, ry: 0.035 },
            { p: [side * 0.19, 0.09, -0.36], rx: 0.03, ry: 0.02 },
          ],
          8,
          { uvScale: 1 }
        )
      );
      const browMesh = new THREE.Mesh(brow, hide);
      browMesh.castShadow = true;
      this.head.add(browMesh);
    }

    // Ear frills.
    for (const side of [1, -1]) {
      const frill = this._track(this._bladeGeometry(0.42, 0.22));
      const fm = new THREE.Mesh(frill, membrane);
      fm.position.set(side * 0.2, 0.1, 0.08);
      fm.rotation.set(0.4, side * 0.5, side * 1.1);
      fm.scale.set(side, 1, 1);
      this.head.add(fm);
    }
  }

  /**
   * One wing: humerus, forearm, four finger struts and a membrane rebuilt from
   * the live joint positions. The left wing is the same rig mirrored with a
   * negative X scale - three flips the winding for a negative determinant, so
   * the geometry stays correct without a second build path.
   */
  _buildWing(side, hide, membrane, horn) {
    const rootObj = new THREE.Object3D();
    // Mirror by position AND scale: the scale flips the rig, the position puts
    // it on the correct flank (scale never moves a node's own origin).
    rootObj.position.set(0.62 * side, 0.5, -0.45);
    rootObj.scale.x = side;
    this.body.add(rootObj);

    const shoulder = new THREE.Object3D();
    rootObj.add(shoulder);
    const humerusLen = 1.25;
    const humerus = new THREE.Mesh(this._track(boneGeometry(humerusLen, 0.24, 0.15, 9, 1.15)), hide);
    humerus.castShadow = true;
    shoulder.add(humerus);

    const elbow = new THREE.Object3D();
    elbow.position.x = humerusLen;
    shoulder.add(elbow);
    const foreLen = 1.35;
    const forearm = new THREE.Mesh(this._track(boneGeometry(foreLen, 0.14, 0.095, 8, 1.05)), hide);
    forearm.castShadow = true;
    elbow.add(forearm);

    const wrist = new THREE.Object3D();
    wrist.position.x = foreLen;
    elbow.add(wrist);

    // Thumb claw at the wrist - the recognisable bat/dragon wing detail.
    const claw = new THREE.Mesh(this._track(hornGeometry(0.34, 0.045, -0.6, 6)), horn);
    claw.rotation.set(0, -0.4, 0.9);
    claw.castShadow = true;
    wrist.add(claw);

    // Finger struts fan backward from the wrist.
    const fingerSpec = [
      { len: 2.75, yaw: -0.16, pitch: 0.06, r: 0.075 },
      { len: 2.62, yaw: 0.28, pitch: 0.02, r: 0.066 },
      { len: 2.3, yaw: 0.72, pitch: -0.03, r: 0.058 },
      { len: 1.78, yaw: 1.16, pitch: -0.08, r: 0.05 },
    ];
    const fingers = [];
    for (const f of fingerSpec) {
      const obj = new THREE.Object3D();
      obj.rotation.set(0, f.yaw, f.pitch);
      wrist.add(obj);
      const mesh = new THREE.Mesh(this._track(boneGeometry(f.len, f.r, 0.014, 6, 1.0)), hide);
      mesh.castShadow = true;
      obj.add(mesh);
      const tip = new THREE.Object3D();
      tip.position.x = f.len;
      obj.add(tip);
      fingers.push({ obj, tip, baseYaw: f.yaw, len: f.len });
    }

    // Body anchor: where the trailing edge meets the flank.
    const anchor = new THREE.Object3D();
    anchor.position.set(-0.35, -0.55, 1.35);
    rootObj.add(anchor);

    /* ---- membrane: 5 bilinear panels ---- */
    const PANELS = 5;
    const GRID = 4; // quads per side
    const perPanel = (GRID + 1) * (GRID + 1);
    const positions = new Float32Array(PANELS * perPanel * 3);
    const uvs = new Float32Array(PANELS * perPanel * 2);
    const index = [];
    for (let p = 0; p < PANELS; p++) {
      const base = p * perPanel;
      for (let i = 0; i <= GRID; i++) {
        for (let j = 0; j <= GRID; j++) {
          const k = base + i * (GRID + 1) + j;
          uvs[k * 2] = (p + j / GRID) * 0.5;
          uvs[k * 2 + 1] = (i / GRID) * 0.9;
        }
      }
      for (let i = 0; i < GRID; i++) {
        for (let j = 0; j < GRID; j++) {
          const a = base + i * (GRID + 1) + j;
          const b = a + 1;
          const c = a + (GRID + 1);
          const d = c + 1;
          index.push(a, c, b, b, c, d);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(PANELS * perPanel * 3), 3));
    geo.setIndex(index);
    geo.getAttribute('position').setUsage(THREE.DynamicDrawUsage);
    this._track(geo);

    const mesh = new THREE.Mesh(geo, membrane);
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    rootObj.add(mesh);

    return {
      side, rootObj, shoulder, elbow, wrist, fingers, anchor, mesh, geo,
      grid: GRID, perPanel, panels: PANELS,
      humerusLen, foreLen,
      sag: 0,
    };
  }

  /** Front or rear leg: two segments, a foot and three claws. */
  _buildLeg(side, front, hide, horn) {
    const rootObj = new THREE.Object3D();
    rootObj.position.set(
      (front ? 0.55 : 0.62) * side,
      front ? -0.42 : -0.4,
      front ? -0.85 : 1.25
    );
    rootObj.scale.x = side;
    this.body.add(rootObj);

    const hip = new THREE.Object3D();
    rootObj.add(hip);
    const upperLen = front ? 0.62 : 0.82;
    const upper = new THREE.Mesh(
      this._track(boneGeometry(upperLen, front ? 0.21 : 0.28, 0.13, 8, 1.2)),
      hide
    );
    upper.castShadow = true;
    hip.add(upper);

    const knee = new THREE.Object3D();
    knee.position.x = upperLen;
    hip.add(knee);
    const lowerLen = front ? 0.5 : 0.7;
    const lower = new THREE.Mesh(this._track(boneGeometry(lowerLen, 0.12, 0.085, 7, 1.05)), hide);
    lower.castShadow = true;
    knee.add(lower);

    const ankle = new THREE.Object3D();
    ankle.position.x = lowerLen;
    knee.add(ankle);

    const footParts = [];
    const pad = new THREE.SphereGeometry(0.13, 10, 8);
    pad.scale(1.1, 0.6, 1.25);
    pad.translate(0.06, -0.02, 0);
    footParts.push(pad);
    const footGeo = this._track(mergeGeometries(footParts, false));
    const foot = new THREE.Mesh(footGeo, hide);
    foot.castShadow = true;
    ankle.add(foot);

    const clawParts = [];
    const clawGeo = hornGeometry(0.24, 0.035, -0.7, 6);
    for (let i = -1; i <= 1; i++) {
      const g = clawGeo.clone();
      const m = new THREE.Matrix4();
      m.makeRotationFromEuler(new THREE.Euler(0, i * 0.45, -0.25, 'XYZ'));
      m.setPosition(0.12, -0.03, i * 0.09);
      g.applyMatrix4(m);
      clawParts.push(g);
    }
    clawGeo.dispose();
    const clawsGeo = this._track(mergeGeometries(clawParts, false));
    for (const g of clawParts) g.dispose();
    const claws = new THREE.Mesh(clawsGeo, horn);
    claws.castShadow = true;
    ankle.add(claws);

    return { side, front, rootObj, hip, knee, ankle, upperLen, lowerLen };
  }

  /**
   * The riding harness.
   *
   * Everything hangs off `this.body`, so it breathes, banks and recoils with
   * the animal for free. Every contact height is read back from `torsoAt` - the
   * same cross-sections the torso is lofted from - so the tack sits *in* the
   * hide rather than hovering a hand's width above it, and the girths pass
   * under the saddle pad instead of through it.
   *
   * Static leather and static hardware are merged into one mesh each. The only
   * live geometry is the pair of reins, which are re-solved per frame from the
   * neck's actual joint positions (see `_updateReins`) because the neck flexes
   * through more than a metre between a climb and a dive and a rigid rein would
   * saw straight through it.
   */
  _buildHarness(M) {
    const leatherMat = M.get('dragon.leather');
    const tackMat = M.get('dragon.tack');

    this.harness = new THREE.Group();
    this.harness.name = 'dragon.harness';
    this.body.add(this.harness);

    const leather = [];
    const tack = [];
    const v = (x, y, z) => new THREE.Vector3(x, y, z);
    const Z = v(0, 0, 1);
    const put = (list, geo, mat) => {
      if (mat) geo.applyMatrix4(mat);
      list.push(geo);
    };

    /* ---- saddle pad: follows the back contour from withers to loin ---- */
    leather.push(
      loftGeometry(
        [
          { p: [0, 0.67, -1.95], rx: 0.22, ry: 0.10 },
          { p: [0, 0.83, -1.80], rx: 0.30, ry: 0.11 },
          { p: [0, 0.81, -1.60], rx: 0.36, ry: 0.115 },
          { p: [0, 0.90, -1.35], rx: 0.40, ry: 0.12 },
          { p: [0, 0.96, -1.10], rx: 0.42, ry: 0.12 },
          { p: [0, 1.01, -0.85], rx: 0.43, ry: 0.12 },
          { p: [0, 1.055, -0.62], rx: 0.42, ry: 0.12 },
          { p: [0, 1.05, -0.50], rx: 0.32, ry: 0.09 },
        ],
        14,
        { uvScale: 3.6 }
      )
    );

    /* ---- pommel (front swell) and cantle (rear support) ---- */
    leather.push(
      loftGeometry(
        [
          { p: [0, 0.82, -1.66], rx: 0.26, ry: 0.11 },
          { p: [0, 0.98, -1.68], rx: 0.22, ry: 0.10 },
          { p: [0, 1.10, -1.71], rx: 0.17, ry: 0.085 },
          { p: [0, 1.18, -1.74], rx: 0.09, ry: 0.055 },
        ],
        12,
        { uvScale: 1.6 }
      )
    );
    leather.push(
      loftGeometry(
        [
          { p: [0, 1.06, -0.62], rx: 0.30, ry: 0.12 },
          { p: [0, 1.21, -0.60], rx: 0.27, ry: 0.115 },
          { p: [0, 1.33, -0.57], rx: 0.20, ry: 0.095 },
          { p: [0, 1.41, -0.55], rx: 0.10, ry: 0.06 },
        ],
        12,
        { uvScale: 1.6 }
      )
    );

    /* ---- girths: two belts round the barrel, tucked under the pad ---- */
    const girths = [-1.70, -0.72];
    for (const gz of girths) {
      const s = torsoAt(gz);
      leather.push(
        strapBand({
          rx: s.rx, ry: s.ry, cy: s.cy, z: gz,
          halfWidth: 0.105, thick: 0.026, lift: 0.03, seg: 48, uvRepeat: 14,
        })
      );
    }

    /* ---- breast collar round the base of the neck, tugged to the pommel ---- */
    const cz = -2.02;
    const cs = torsoAt(cz);
    leather.push(
      strapBand({
        rx: cs.rx, ry: cs.ry, cy: cs.cy, z: cz,
        halfWidth: 0.085, thick: 0.024, lift: 0.032, seg: 40, uvRepeat: 9,
      })
    );
    for (const side of [1, -1]) {
      leather.push(flatStrap(v(0.44 * side, 0.34, -2.00), v(0.50 * side, 0.62, -1.86), 0.042, 0.014, Z, 3));
      leather.push(flatStrap(v(0.50 * side, 0.62, -1.86), v(0.30 * side, 1.00, -1.72), 0.042, 0.014, Z, 3));
      // Stirrup leather: from a D-ring under the pad skirt to the iron's eye.
      leather.push(
        flatStrap(v(0.34 * side, 1.06, -1.62), v(0.545 * side, 0.848, -1.52), 0.042, 0.013, Z, 3)
      );
    }

    /* ---- hardware ---- */
    const buckle = buckleGeometry();
    const dring = new THREE.TorusGeometry(0.042, 0.011, 7, 14);
    const iron = stirrupGeometry();
    const basis = (nx, ny, nz, ax, ay, az, px, py, pz) => {
      const zAx = v(nx, ny, nz).normalize();
      const xAx = v(ax, ay, az).normalize();
      const yAx = new THREE.Vector3().crossVectors(zAx, xAx).normalize();
      xAx.crossVectors(yAx, zAx).normalize();
      const m = new THREE.Matrix4().makeBasis(xAx, yAx, zAx);
      m.setPosition(px, py, pz);
      return m;
    };

    for (const side of [1, -1]) {
      // Girth buckles ride the widest point of each belt, facing out.
      for (const gz of girths) {
        const s = torsoAt(gz);
        put(tack, buckle.clone(), basis(side, 0, 0, 0, 1, 0, side * (s.rx + 0.055), s.cy, gz));
      }
      // Breast-collar buckle where the tug meets the collar.
      put(tack, buckle.clone(), basis(side, 0.2, 0, 0, 1, 0.3, side * 0.47, 0.42, -1.97));
      // D-rings: stirrup hanger, and a rein ring on the pommel.
      put(tack, dring.clone(), basis(side, 0, 0, 0, 1, 0, side * 0.345, 1.055, -1.62));
      put(tack, dring.clone(), basis(side, 0.3, 0, 0, 1, 0, side * 0.155, 1.135, -1.755));
      // Stirrup iron. The centre is set from the tread, not the eye: the ankle
      // marker the rider IKs to has to end up a boot-sole above the tread bar,
      // and getting that backwards buries the foot through the iron.
      put(tack, iron.clone(), basis(0, 0, 1, 1, 0, 0, side * 0.55, 0.712, -1.50));
      // Grab-handle upright.
      tack.push(barBetween(side * 0.16, 1.12, -1.70, side * 0.28, GRIP.y, GRIP.z, 0.017, 0.014));
    }
    // Grab handle cross-bar the rider's hands close around. Its height is tuned
    // against the rider's actual reach: the seated figure pitches forward at
    // speed, which swings the shoulders down *past* a low bar and pulls the arms
    // straight, so the bar sits high enough to stay inside the arm's envelope
    // through the whole lean.
    tack.push(barBetween(-0.30, GRIP.y, GRIP.z, 0.30, GRIP.y, GRIP.z, 0.016, 0.016, 10));
    for (const side of [1, -1]) {
      const wrap = new THREE.CylinderGeometry(0.027, 0.027, 0.115, 10, 1);
      wrap.rotateZ(Math.PI / 2);
      wrap.translate(side * GRIP.x, GRIP.y, GRIP.z);
      leather.push(wrap);
    }

    buckle.dispose();
    dring.dispose();
    iron.dispose();

    const leatherGeo = this._track(mergeGeometries(leather, false));
    for (const g of leather) g.dispose();
    const leatherMesh = new THREE.Mesh(leatherGeo, leatherMat);
    leatherMesh.castShadow = true;
    leatherMesh.receiveShadow = true;
    this.harness.add(leatherMesh);

    const tackGeo = this._track(mergeGeometries(tack, false));
    for (const g of tack) g.dispose();
    const tackMesh = new THREE.Mesh(tackGeo, tackMat);
    tackMesh.castShadow = true;
    this.harness.add(tackMesh);

    /* ---- rivets: instanced, along the pad edge and the girths ---- */
    const rivetGeo = this._track(new THREE.SphereGeometry(0.016, 8, 6));
    rivetGeo.scale(1, 0.55, 1);
    const RIVETS = 44;
    const rivets = new THREE.InstancedMesh(rivetGeo, tackMat, RIVETS);
    rivets.castShadow = true;
    const rm = new THREE.Matrix4();
    const rq = new THREE.Quaternion();
    const rp = new THREE.Vector3();
    const rs = new THREE.Vector3(1, 1, 1);
    let ri = 0;
    for (const side of [1, -1]) {
      for (let i = 0; i < 11; i++) {
        const t = i / 10;
        const z = lerp(-1.86, -0.58, t);
        const w = 0.24 + Math.sin(t * Math.PI) * 0.2;
        const y = lerp(0.76, 1.10, t) + Math.sin(t * Math.PI) * 0.02;
        rp.set(side * w, y, z);
        rq.setFromAxisAngle(_capUp, 0);
        rm.compose(rp, rq, rs);
        rivets.setMatrixAt(ri++, rm);
      }
      for (const gz of girths) {
        const s = torsoAt(gz);
        for (let i = 0; i < 5; i++) {
          const a = (-0.35 - i * 0.22) * side + (side > 0 ? 0 : Math.PI);
          rp.set(s.rx * Math.cos(a) * 1.04, s.cy + s.ry * Math.sin(a) * 1.04, gz);
          rq.setFromUnitVectors(_capUp, _hw1.set(Math.cos(a), Math.sin(a), 0));
          rm.compose(rp, rq, rs);
          rivets.setMatrixAt(ri++, rm);
        }
      }
    }
    for (; ri < RIVETS; ri++) {
      rm.makeScale(0, 0, 0);
      rivets.setMatrixAt(ri, rm);
    }
    rivets.instanceMatrix.needsUpdate = true;
    this.harness.add(rivets);

    /* ---- neck harness: a collar on the third vertebra, with rein rings ---- */
    const neckSeg = this.neck[2] ?? this.neck[this.neck.length - 1];
    const neckParts = [
      strapBand({ rx: 0.30, ry: 0.318, z: -0.22, halfWidth: 0.06, thick: 0.018, lift: 0.012, seg: 28, uvRepeat: 3 }),
    ];
    const collarGeo = this._track(mergeGeometries(neckParts, false));
    for (const g of neckParts) g.dispose();
    const collarMesh = new THREE.Mesh(collarGeo, leatherMat);
    collarMesh.castShadow = true;
    neckSeg.add(collarMesh);

    const ringGeo = this._track(new THREE.TorusGeometry(0.04, 0.011, 7, 14));
    this._reinFront = [];
    for (const side of [1, -1]) {
      const ring = new THREE.Mesh(ringGeo, tackMat);
      ring.position.set(side * 0.315, 0.02, -0.22);
      ring.rotation.y = Math.PI / 2;
      neckSeg.add(ring);
      const anchor = new THREE.Object3D();
      anchor.position.set(side * 0.35, 0.02, -0.22);
      neckSeg.add(anchor);
      this._reinFront.push(anchor);
    }

    /* ---- reins: solved per frame between pommel rings and neck rings ---- */
    this._reinBack = [];
    for (const side of [1, -1]) {
      const a = new THREE.Object3D();
      a.position.set(side * 0.155, 1.135, -1.755);
      this.harness.add(a);
      this._reinBack.push(a);
    }
    this._reins = this._buildReins(leatherMat);

    /* ---- rider mount points ---- */
    this.riderAnchor = new THREE.Object3D();
    this.riderAnchor.position.set(0, 1.17, -1.15);
    this.harness.add(this.riderAnchor);

    /** Ankle rest points inside the stirrup irons; the rider IKs its feet here. */
    this.stirrups = [];
    /** Grip points on the handle bar; the rider IKs its hands here. */
    this.grips = [];
    for (const side of [1, -1]) {
      const st = new THREE.Object3D();
      st.position.set(side * 0.55, 0.69, -1.50);
      this.harness.add(st);
      this.stirrups.push(st);

      const gp = new THREE.Object3D();
      gp.position.set(side * GRIP.x, GRIP.y, GRIP.z);
      this.harness.add(gp);
      this.grips.push(gp);
    }
  }

  /** Allocate the two rein strands as one dynamic tube pair. */
  _buildReins(mat) {
    const STRANDS = 2;
    const SEG = 10; // samples along each rein
    const RAD = 5; // cross-section resolution
    const perStrand = (SEG + 1) * RAD;
    const positions = new Float32Array(STRANDS * perStrand * 3);
    const uvs = new Float32Array(STRANDS * perStrand * 2);
    const index = [];
    for (let s = 0; s < STRANDS; s++) {
      const base = s * perStrand;
      for (let i = 0; i <= SEG; i++) {
        for (let r = 0; r < RAD; r++) {
          const k = base + i * RAD + r;
          uvs[k * 2] = r / RAD;
          uvs[k * 2 + 1] = (i / SEG) * 5;
        }
      }
      for (let i = 0; i < SEG; i++) {
        for (let r = 0; r < RAD; r++) {
          const r2 = (r + 1) % RAD;
          const a = base + i * RAD + r;
          const b = base + i * RAD + r2;
          const c = base + (i + 1) * RAD + r;
          const d = base + (i + 1) * RAD + r2;
          index.push(a, c, b, b, c, d);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(STRANDS * perStrand * 3), 3));
    geo.setIndex(index);
    geo.getAttribute('position').setUsage(THREE.DynamicDrawUsage);
    this._track(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    this.harness.add(mesh);
    return { mesh, geo, strands: STRANDS, seg: SEG, radial: RAD, perStrand };
  }

  /**
   * Re-solve the reins from the live pommel and neck-ring positions.
   *
   * Both endpoints are read in world space and brought back into the harness's
   * frame, so the rein tracks the neck through its full range without the two
   * ends ever having to know about each other's parent.
   */
  _updateReins() {
    const R = this._reins;
    if (!R) return;
    this.harness.updateWorldMatrix(true, false);
    _rnMat.copy(this.harness.matrixWorld).invert();

    const pos = R.geo.getAttribute('position');
    const arr = pos.array;
    const SEG = R.seg;
    const RAD = R.radial;
    const tubeR = 0.014;

    for (let s = 0; s < R.strands; s++) {
      const back = this._reinBack[s];
      const front = this._reinFront[s];
      back.updateWorldMatrix(true, false);
      front.updateWorldMatrix(true, false);
      _rn1.setFromMatrixPosition(back.matrixWorld).applyMatrix4(_rnMat);
      _rn2.setFromMatrixPosition(front.matrixWorld).applyMatrix4(_rnMat);
      // Control point: the midpoint, dropped by a fraction of the span so the
      // rein hangs in a believable catenary rather than a taut wire.
      _rn3.addVectors(_rn1, _rn2).multiplyScalar(0.5);
      _rn3.y -= _rn1.distanceTo(_rn2) * 0.075 + 0.02;

      const base = s * R.perStrand;
      for (let i = 0; i <= SEG; i++) {
        const t = i / SEG;
        const it = 1 - t;
        // Quadratic Bezier through the sagged control point.
        _rn4.set(
          it * it * _rn1.x + 2 * it * t * _rn3.x + t * t * _rn2.x,
          it * it * _rn1.y + 2 * it * t * _rn3.y + t * t * _rn2.y,
          it * it * _rn1.z + 2 * it * t * _rn3.z + t * t * _rn2.z
        );
        // Tangent, for a stable cross-section frame.
        _rn5.set(
          2 * it * (_rn3.x - _rn1.x) + 2 * t * (_rn2.x - _rn3.x),
          2 * it * (_rn3.y - _rn1.y) + 2 * t * (_rn2.y - _rn3.y),
          2 * it * (_rn3.z - _rn1.z) + 2 * t * (_rn2.z - _rn3.z)
        );
        if (_rn5.lengthSq() < 1e-9) _rn5.set(0, 0, -1);
        _rn5.normalize();
        _hw1.set(0, 1, 0);
        _hw2.crossVectors(_rn5, _hw1);
        if (_hw2.lengthSq() < 1e-8) _hw2.set(1, 0, 0);
        _hw2.normalize();
        _hw3.crossVectors(_hw2, _rn5).normalize();
        for (let r = 0; r < RAD; r++) {
          const a = (r / RAD) * Math.PI * 2;
          const ca = Math.cos(a) * tubeR;
          const sa = Math.sin(a) * tubeR * 0.55; // straps are flat, not round
          const k = (base + i * RAD + r) * 3;
          arr[k] = _rn4.x + _hw2.x * ca + _hw3.x * sa;
          arr[k + 1] = _rn4.y + _hw2.y * ca + _hw3.y * sa;
          arr[k + 2] = _rn4.z + _hw2.z * ca + _hw3.z * sa;
        }
      }
    }
    pos.needsUpdate = true;
    R.geo.computeVertexNormals();
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  get alive() {
    return this._alive;
  }

  setVisible(v) {
    this.root.visible = v;
    this._embers.setVisible(v);
    this._dust.setVisible(v);
  }

  /** Land the dragon in front of the player, then let them climb aboard. */
  spawn(position, yaw) {
    // Local probe, not a cast from the sky: overhead geometry would otherwise
    // land the dragon on a roof instead of beside the player.
    const probe = this.physics.groundHeight(position.x, position.z, position.y + 2, 14);
    const g = probe === null ? position.y : probe;
    this._groundY = g;
    this.position.set(position.x, g + BELLY_DROP + LEG_REACH * 0.85, position.z);
    this.heading = yaw;
    this.velocity.set(0, 0, 0);
    this.speed = 0;
    this._vy = 0;
    this._pitch = 0;
    this._roll = 0;
    this._boost = 0;
    this._legTuck = 0;
    this.state = 'grounded';
    this._spawnT = 0;
    this._despawnT = -1;
    this._alive = true;
    this._roar = 1;
    this.root.position.copy(this.position);
    this.root.rotation.y = yaw;
    if (!this.root.parent) this.scene.add(this.root);
    this.setVisible(true);
    this._embers.clear();
    this._dust.clear();

    // Arrival: a ring of dust off the ground plus embers from the maw.
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      const r = 1.8 + Math.random() * 1.2;
      this._dust.spawn(
        this.position.x + Math.cos(a) * r,
        g + 0.15,
        this.position.z + Math.sin(a) * r,
        Math.cos(a) * 3.4, 1.6 + Math.random() * 1.8, Math.sin(a) * 3.4,
        0.9 + Math.random() * 0.5, 0.7, 0.85, 0.78, 0.62
      );
    }
  }

  despawn() {
    if (!this._alive || this._despawnT >= 0) return;
    this._despawnT = 0;
    for (let i = 0; i < 30; i++) {
      const a = Math.random() * Math.PI * 2;
      this._embers.spawn(
        this.position.x + (Math.random() - 0.5) * 2.4,
        this.position.y + (Math.random() - 0.5) * 1.6,
        this.position.z + (Math.random() - 0.5) * 3.4,
        Math.cos(a) * 1.2, 2.4 + Math.random() * 2.2, Math.sin(a) * 1.2,
        0.8, 0.3, 1, 0.55, 0.18
      );
    }
  }

  /** Remove immediately, no animation. Used when the world changes under us. */
  kill() {
    this._alive = false;
    this._ridden = false;
    this._despawnT = -1;
    this._spawnT = 1;
    this.root.scale.setScalar(1);
    this.setVisible(false);
    this._embers.clear();
    this._dust.clear();
    this._speedLines.update(0.016, this.camera, 0);
    this.root.removeFromParent();
  }

  onMount() {
    this._ridden = true;
    this._roar = 1;
  }

  onDismount() {
    this._ridden = false;
    this._boost = 0;
    this._boostActive = false;
  }

  /** Ask the dragon to come down. Used by `F` while airborne. */
  requestLanding() {
    if (this.state === 'flying' || this.state === 'takeoff') this.state = 'landing';
  }

  get isGrounded() {
    return this.state === 'grounded';
  }

  canDismount() {
    return this.state === 'grounded' || this.altitude < 2.6 || this._supported === true;
  }

  get altitude() {
    return this.position.y - BELLY_DROP - LEG_REACH * 0.85 - this._groundY;
  }

  /* ---------------------------------------------------------------- */
  /* Flight                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * @param {number} dt
   * @param {number} elapsed
   * @param {{throttle:number, strafe:number, yaw:number, pitch:number,
   *          up:number, boost:boolean}|null} ctrl null while parked
   */
  fixedUpdate(dt, elapsed, ctrl) {
    if (!this._alive) return;
    const ridden = !!ctrl;

    if (!ridden && this.state === 'flying') this.requestLanding();

    const throttle = ridden ? ctrl.throttle : 0;
    const strafe = ridden ? ctrl.strafe : 0;
    const up = ridden ? ctrl.up : 0;
    const boost = ridden && !!ctrl.boost && throttle > 0;
    this._boost = damp(this._boost, boost ? 1 : 0, 3.2, dt);
    this._boostActive = boost;

    /* ---- takeoff ---- */
    // A landing dragon aborts back into the air the moment the rider asks for
    // power; waiting for touchdown first would feel like a stuck control.
    if ((this.state === 'grounded' || this.state === 'landing') && ridden && (up > 0 || throttle > 0)) {
      this.state = 'takeoff';
      this._takeoffT = 0;
      this._roar = 1;
      this._kickDust(20, 3.5);
    }
    if (this.state === 'takeoff') {
      this._takeoffT += dt;
      // Two heavy beats that shove the animal clear of whatever it was standing
      // on - a shorter hop leaves it clipping the trees it launched from.
      this._vy = 11;
      if (this._takeoffT > 0.9) this.state = 'flying';
    }

    /* ---- heading ---- */
    if (ridden && this.state !== 'grounded') {
      const carve = -strafe * 0.5;
      const target = ctrl.yaw + carve;
      let diff = ((target - this.heading + Math.PI) % (Math.PI * 2)) - Math.PI;
      if (diff < -Math.PI) diff += Math.PI * 2;
      const maxRate = 1.55 - clamp01(this.speed / BOOST_SPEED) * 0.55;
      const rate = clamp(diff * 2.6, -maxRate, maxRate);
      this.heading += rate * dt;
      this._turnRate = damp(this._turnRate, rate, 5, dt);
    } else {
      this._turnRate = damp(this._turnRate, 0, 4, dt);
    }

    /* ---- speed and attitude ---- */
    if (this.state === 'grounded') {
      this.speed = damp(this.speed, 0, 6, dt);
      this._pitchTarget = 0;
      this._rollTarget = 0;
    } else {
      let targetSpeed = 0;
      if (throttle > 0) targetSpeed = lerp(CRUISE_SPEED, BOOST_SPEED, this._boost);
      else if (throttle < 0) targetSpeed = 4;
      else targetSpeed = 6.5; // a dragon does not hover for free; it drifts
      if (this.state === 'landing') targetSpeed = Math.min(targetSpeed, 5);
      this.speed = damp(this.speed, targetSpeed, 1.7 + this._boost * 1.6, dt);

      const lookPitch = ridden ? clamp(ctrl.pitch, -1.15, 1.15) : 0;
      this._pitchTarget =
        this.state === 'landing' ? -0.12 : clamp(lookPitch * 0.85 + up * 0.22, -1.0, 1.0);
      // Roll INTO the turn: heading increases when turning left, and for a body
      // facing -Z a positive Z rotation lifts the right flank. Getting this
      // backwards is instantly readable as wrong, so it is spelled out.
      this._rollTarget = clamp(this._turnRate * 1.15 - strafe * 0.12, -0.85, 0.85);
    }
    this._pitch = damp(this._pitch, this._pitchTarget, 3.4, dt);
    this._roll = damp(this._roll, this._rollTarget, 3.0, dt);

    /* ---- integrate ---- */
    const cp = Math.cos(this._pitch);
    const fx = -Math.sin(this.heading) * cp;
    const fz = -Math.cos(this.heading) * cp;
    const fy = Math.sin(this._pitch);

    let vy = fy * this.speed;
    if (this.state === 'landing') {
      const drop = clamp(this.altitude * 0.9, 1.4, 9);
      vy = -drop;
      // `_supported` covers landing on a roof, a rock or a tree: the terrain
      // ground height under those is metres below, so an altitude test alone
      // leaves the animal hovering forever on top of them.
      if (this.altitude < 0.12 || this._supported) {
        this.state = 'grounded';
        this._kickDust(16, 2.6);
      }
    } else if (this.state === 'grounded') {
      vy = 0;
    } else {
      // Space/Ctrl add authority on top of the pitch vector so the player can
      // climb even while looking level.
      vy += up * CLIMB_RATE;
      // Slow flight bleeds altitude: it keeps the mount honest without a stall.
      if (this.speed < CRUISE_SPEED * 0.55 && up <= 0) vy -= 2.4;
    }
    this._vy = damp(this._vy, vy, 6, dt);
    if (this.state === 'takeoff') this._vy = 9.5;

    this.velocity.set(fx * this.speed, this._vy, fz * this.speed);
    this.position.addScaledVector(this.velocity, dt);

    /* ---- ground and walls ---- */
    // Probing at 20 Hz, not 60: a long downward ray marches the broadphase grid
    // and a creature this size cannot outrun 50 ms of terrain lag.
    this._probeTick = ((this._probeTick ?? 0) + 1) % 3;
    if (this._probeTick === 0) {
      const g = this.physics.groundHeight(this.position.x, this.position.z, this.position.y + 3, 220);
      if (g !== null) this._groundY = g;
    }
    const minY = this._groundY + BELLY_DROP + LEG_REACH * (this.state === 'grounded' ? 0.85 : 0.95);
    if (this.position.y < minY) {
      this.position.y = minY;
      if (this._vy < 0) this._vy = 0;
      if (this.state === 'flying' && this.speed < 3) this.state = 'grounded';
    }
    // Ceiling of 260 m over the terrain keeps the player inside the skybox.
    const maxY = this._groundY + 260;
    if (this.position.y > maxY) {
      this.position.y = maxY;
      if (this._vy > 0) this._vy = 0;
    }
    this._resolveCollision();

    /* ---- animation drivers ---- */
    const sp01 = clamp01(this.speed / BOOST_SPEED);
    const climbing = clamp01(this._vy / 6);
    if (this.state === 'grounded') {
      this._flapRate = damp(this._flapRate, 0.25, 3, dt);
      this._flapAmp = damp(this._flapAmp, 0.12, 3, dt);
      this._legTuck = damp(this._legTuck, 0, 4, dt);
    } else if (this.state === 'landing') {
      this._flapRate = damp(this._flapRate, 1.9, 3, dt);
      this._flapAmp = damp(this._flapAmp, 1.15, 3, dt);
      this._legTuck = damp(this._legTuck, clamp01(this.altitude / 6), 2.5, dt);
    } else {
      // Fast flight stretches the beat into a glide; climbing shortens it.
      const rate = lerp(2.1, 0.42, sp01) + climbing * 1.2 + this._boost * 0.5;
      const amp = lerp(1.0, 0.28, sp01 * 0.85) + climbing * 0.25;
      this._flapRate = damp(this._flapRate, rate, 2.5, dt);
      this._flapAmp = damp(this._flapAmp, amp, 2.5, dt);
      this._legTuck = damp(this._legTuck, 1, 2, dt);
    }
    this._flapPhase += this._flapRate * Math.PI * 2 * dt;
    if (this._flapPhase > Math.PI * 2) this._flapPhase -= Math.PI * 2;
  }

  /** Keep the body out of walls; the wings are allowed to overlap geometry. */
  _resolveCollision() {
    _dc1.set(this.position.x, this.position.y - RIDE_HEIGHT * 0.5, this.position.z);
    _dc2.copy(_dc1);
    this.physics.resolveCapsule(_dc1, RIDE_RADIUS, RIDE_HEIGHT);
    const dx = _dc1.x - _dc2.x;
    const dz = _dc1.z - _dc2.z;
    const lenSq = dx * dx + dz * dz;
    if (lenSq > 1e-8) {
      const len = Math.sqrt(lenSq);
      const nx = dx / len;
      const nz = dz / len;
      const into = this.velocity.x * nx + this.velocity.z * nz;
      if (into < 0) {
        this.velocity.x -= nx * into;
        this.velocity.z -= nz * into;
        this.speed *= 0.8;
      }
      this.position.x += dx;
      this.position.z += dz;
    }
    const dy = _dc1.y - _dc2.y;
    this._supported = dy > 0.001;
    if (this._supported) {
      this.position.y += dy;
      if (this._vy < 0) this._vy = 0;
    }
  }

  _kickDust(count, spread) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 1.2 + Math.random() * spread;
      this._dust.spawn(
        this.position.x + Math.cos(a) * r,
        this._groundY + 0.2,
        this.position.z + Math.sin(a) * r,
        Math.cos(a) * 3, 1.4 + Math.random() * 1.6, Math.sin(a) * 3,
        0.8 + Math.random() * 0.4, 0.75, 0.82, 0.76, 0.64
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Presentation                                                      */
  /* ---------------------------------------------------------------- */

  update(dt, elapsed) {
    if (!this._alive) {
      this._embers.update(dt, this.camera);
      this._dust.update(dt, this.camera);
      this._speedLines.update(dt, this.camera, 0);
      return;
    }

    if (this._spawnT < 1) this._spawnT = Math.min(1, this._spawnT + dt * 1.4);
    if (this._despawnT >= 0) {
      this._despawnT += dt * 1.6;
      if (this._despawnT >= 1) {
        this._alive = false;
        this.setVisible(false);
        this.root.removeFromParent();
        return;
      }
    }
    const materialise = this._despawnT >= 0 ? 1 - this._despawnT : this._spawnT;
    const ease = materialise * materialise * (3 - 2 * materialise);

    this.root.position.copy(this.position);
    this.root.rotation.y = this.heading;
    this.bank.rotation.set(this._pitch * 0.8, 0, this._roll);
    // Only the dismissal scales: a spawn scale would carry the rider with it,
    // since the saddle anchor has to live inside the animated hierarchy.
    this.root.scale.setScalar(this._despawnT >= 0 ? 0.3 + ease * 0.7 : 1);

    const sp01 = clamp01(this.speed / BOOST_SPEED);
    const flap = Math.sin(this._flapPhase);
    const flapVel = Math.cos(this._flapPhase) * this._flapRate;

    /* ---- body: breathe, and recoil against the downstroke ---- */
    const breathe = Math.sin(elapsed * 1.4) * 0.02;
    this.body.position.y = flap * this._flapAmp * -0.16 + breathe - (1 - ease) * 0.5;
    this.body.rotation.x = flap * this._flapAmp * 0.045 + breathe * 0.4;

    /* ---- wings ---- */
    for (const w of this.wings) {
      this._animateWing(w, flap, flapVel, dt, sp01);
      this._updateMembrane(w);
    }

    /* ---- neck: counter-sway, and lead into turns ---- */
    const lead = clamp(-this._turnRate * 0.9, -0.6, 0.6);
    for (let i = 0; i < this.neck.length; i++) {
      const t = i / (this.neck.length - 1);
      const seg = this.neck[i];
      // Base S-curve: up out of the shoulders, level at the head.
      const base = lerp(0.34, -0.30, t);
      const wave = Math.sin(elapsed * 1.6 - t * 2.1) * 0.035 * (0.4 + t);
      const flapCounter = -flap * this._flapAmp * 0.05 * (1 - t);
      seg.rotation.x = damp(seg.rotation.x, base + wave + flapCounter - this._pitch * 0.12 * (1 - t), 9, dt);
      seg.rotation.y = damp(seg.rotation.y, lead * (0.25 + t * 0.55) + Math.sin(elapsed * 0.9 - t * 1.4) * 0.03, 7, dt);
      seg.rotation.z = damp(seg.rotation.z, -this._roll * 0.16, 6, dt);
    }
    // Head levels itself against the neck arch - animals stabilise their gaze.
    this._headPitch = damp(this._headPitch, this._pitch * 0.35 + 0.12, 5, dt);
    this._headYaw = damp(this._headYaw, lead * 0.5, 5, dt);
    this.head.rotation.set(this._headPitch, this._headYaw, -this._roll * 0.2);

    /* ---- jaw and throat ---- */
    this._roar = Math.max(0, this._roar - dt * 1.1);
    const open = this._roar * 0.55 + Math.max(0, Math.sin(elapsed * 0.7) - 0.93) * 1.2;
    this.jaw.rotation.x = damp(this.jaw.rotation.x, -open, 9, dt);
    this._maw.intensity = (this._roar * 14 + 1.2 + this._boost * 5) * ease;
    this._auraMat.opacity = (this._roar * 0.75 + 0.12 + this._boost * 0.3) * ease;
    this._aura.scale.setScalar(0.6 + this._roar * 0.9 + this._boost * 0.4);
    // Billboard in the head's frame: copying the camera quaternion straight
    // into a child of a rotating parent would tilt with the neck.
    this.head.getWorldQuaternion(_bq1);
    this._aura.quaternion.copy(_bq1.invert()).multiply(_bq2.copy(this.camera.quaternion));
    this._eyeMat.emissiveIntensity = 2.8 + this._boost * 3 + this._roar * 3;

    if (this._roar > 0.05 || this._boost > 0.4) this._emitBreath(dt);

    /* ---- tail: travelling wave, heavier at the base ---- */
    for (let i = 0; i < this.tail.length; i++) {
      const t = i / (this.tail.length - 1);
      const seg = this.tail[i];
      const amp = 0.05 + t * 0.16;
      const swing = Math.sin(elapsed * 1.9 - t * 2.6) * amp;
      const counterTurn = clamp(this._turnRate * 0.55, -0.4, 0.4) * (0.3 + t);
      seg.rotation.y = damp(seg.rotation.y, swing + counterTurn, 8, dt);
      seg.rotation.x = damp(
        seg.rotation.x,
        (this.state === 'grounded' ? 0.06 : -0.04) + Math.sin(elapsed * 1.3 - t * 2) * 0.03 + this._pitch * 0.06,
        7, dt
      );
      seg.rotation.z = damp(seg.rotation.z, -this._roll * 0.06, 6, dt);
    }

    /* ---- legs: tucked in flight, planted on the ground ---- */
    for (const leg of this.legs) {
      const tuck = this._legTuck;
      const hipX = leg.front ? lerp(0.15, 0.55, tuck) : lerp(0.1, 0.5, tuck);
      // Rest: legs point down (+X rotated to -Y). Tucked: folded up and back.
      const hipZ = lerp(-1.45, -2.25, tuck);
      const kneeZ = lerp(0.55, 2.3, tuck);
      leg.hip.rotation.z = damp(leg.hip.rotation.z, hipZ, 6, dt);
      leg.hip.rotation.y = damp(leg.hip.rotation.y, hipX * 0.35, 6, dt);
      leg.knee.rotation.z = damp(leg.knee.rotation.z, kneeZ, 6, dt);
      leg.ankle.rotation.z = damp(leg.ankle.rotation.z, lerp(0.9, -0.3, tuck), 6, dt);
    }

    /* ---- harness: reins track the live neck pose ---- */
    this._updateReins();

    /* ---- VFX ---- */
    this._embers.update(dt, this.camera);
    this._dust.update(dt, this.camera);
    const rush = this._ridden ? clamp01((this.speed - CRUISE_SPEED * 0.8) / (BOOST_SPEED - CRUISE_SPEED * 0.8)) : 0;
    this._speedLines.update(dt, this.camera, rush * (0.3 + this._boost * 0.7));
  }

  /**
   * Drive one wing's joints from the flap phase. The elbow and fingers lag the
   * shoulder, which is what produces the whip along the trailing edge instead
   * of a rigid flat paddle.
   */
  _animateWing(w, flap, flapVel, dt, sp01) {
    const amp = this._flapAmp;
    const lagPhase = this._flapPhase - 0.55;
    const flapLag = Math.sin(lagPhase);
    const fold = this.state === 'grounded' ? 1 : 0;
    w.fold = damp(w.fold ?? fold, fold, 3, dt);
    const f = w.fold;

    // Shoulder: main stroke, biased upward so the wing sits above the back.
    const stroke = flap * amp * 0.85 + 0.12;
    w.shoulder.rotation.z = damp(w.shoulder.rotation.z, stroke * (1 - f) + f * 0.9, 12, dt);
    w.shoulder.rotation.y = damp(
      w.shoulder.rotation.y,
      (-0.12 + flapLag * amp * 0.16) * (1 - f) + f * 1.15,
      10, dt
    );
    w.shoulder.rotation.x = damp(w.shoulder.rotation.x, flapLag * amp * 0.22, 10, dt);

    // Elbow: sweeps forward on the downstroke, folds hard when perched.
    const elbowFold = -0.28 + flapLag * amp * 0.3 + sp01 * 0.1;
    w.elbow.rotation.y = damp(w.elbow.rotation.y, elbowFold * (1 - f) - f * 2.4, 10, dt);
    w.elbow.rotation.z = damp(w.elbow.rotation.z, flapLag * amp * 0.2 * (1 - f) + f * 0.5, 10, dt);

    // Wrist and fingers: spread on the downstroke, rake back at speed.
    const spread = (0.85 + flapLag * amp * 0.18 - sp01 * 0.12) * (1 - f) + f * 0.16;
    w.wrist.rotation.y = damp(w.wrist.rotation.y, (-0.1 + flapLag * amp * 0.2) * (1 - f) + f * 2.5, 10, dt);
    for (const fg of w.fingers) {
      fg.obj.rotation.y = damp(fg.obj.rotation.y, fg.baseYaw * spread, 9, dt);
      fg.obj.rotation.z = damp(fg.obj.rotation.z, -0.06 + flapLag * amp * 0.12, 9, dt);
    }

    // Membrane billow trails the stroke velocity.
    w.sag = damp(w.sag, clamp(-flapVel * 0.06, -0.35, 0.35) + 0.06, 8, dt);
  }

  /**
   * Re-solve the five membrane panels from the live joint positions.
   *
   * Everything is computed in the wing root's local space, so the panels can be
   * written straight into the buffer without a per-vertex world transform.
   */
  _updateMembrane(w) {
    w.rootObj.updateMatrixWorld(true);
    _wmMat.copy(w.rootObj.matrixWorld).invert();

    const P = _wmPts;
    // 0 shoulder, 1 elbow, 2 wrist, 3..6 finger tips, 7 body anchor
    P[0].set(0, 0, 0);
    P[1].setFromMatrixPosition(w.elbow.matrixWorld).applyMatrix4(_wmMat);
    P[2].setFromMatrixPosition(w.wrist.matrixWorld).applyMatrix4(_wmMat);
    for (let i = 0; i < 4; i++) {
      P[3 + i].setFromMatrixPosition(w.fingers[i].tip.matrixWorld).applyMatrix4(_wmMat);
    }
    P[7].setFromMatrixPosition(w.anchor.matrixWorld).applyMatrix4(_wmMat);

    const pos = w.geo.getAttribute('position');
    const G = w.grid;
    const per = w.perPanel;
    const sag = w.sag;

    // Panels 0..2: between consecutive finger struts, hinged at the wrist.
    for (let p = 0; p < 3; p++) {
      this._writePanel(pos, p * per, G, P[2], P[3 + p], P[2], P[4 + p], sag, 1);
    }
    // Panel 3: hand to body - the big trailing sheet.
    this._writePanel(pos, 3 * per, G, P[2], P[6], P[7], P[7], sag * 1.35, 1.1);
    // Panel 4: arm panel from the shoulder along the leading edge.
    this._writePanel(pos, 4 * per, G, P[0], P[1], P[7], P[2], sag * 0.6, 0.5);

    pos.needsUpdate = true;
    w.geo.computeVertexNormals();
  }

  /**
   * Bilinear patch with a sag term, written in place.
   * Corners: (a=u0v0, b=u1v0, c=u0v1, d=u1v1).
   */
  _writePanel(attr, offset, G, a, b, c, d, sag, sagScale) {
    const arr = attr.array;
    for (let i = 0; i <= G; i++) {
      const v = i / G;
      // Top edge a->b, bottom edge c->d.
      for (let j = 0; j <= G; j++) {
        const u = j / G;
        _wm1.lerpVectors(a, b, u);
        _wm2.lerpVectors(c, d, u);
        _wm3.lerpVectors(_wm1, _wm2, v);
        // Sag: a smooth bulge peaking in the middle of the panel, along -Y in
        // wing space, which is "under" the wing at any stroke angle.
        const s = Math.sin(Math.PI * u) * Math.sin(Math.PI * Math.min(1, v * 1.25)) * sag * sagScale;
        const k = (offset + i * (G + 1) + j) * 3;
        arr[k] = _wm3.x;
        arr[k + 1] = _wm3.y + s;
        arr[k + 2] = _wm3.z;
      }
    }
    void _wm4;
  }

  _emitBreath(dt) {
    this.head.updateMatrixWorld(true);
    _br1.setFromMatrixPosition(this.head.matrixWorld);
    const fx = -Math.sin(this.heading);
    const fz = -Math.cos(this.heading);
    const n = this._roar > 0.05 ? 3 : 1;
    for (let i = 0; i < n; i++) {
      this._embers.spawn(
        _br1.x + fx * 0.7 + (Math.random() - 0.5) * 0.3,
        _br1.y + (Math.random() - 0.5) * 0.25,
        _br1.z + fz * 0.7 + (Math.random() - 0.5) * 0.3,
        fx * (3 + this._roar * 8) + (Math.random() - 0.5) * 1.6,
        0.8 + Math.random() * 1.4,
        fz * (3 + this._roar * 8) + (Math.random() - 0.5) * 1.6,
        0.5 + Math.random() * 0.5,
        0.22 + Math.random() * 0.2,
        1, 0.5 + Math.random() * 0.3, 0.16
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Queries                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Feet position for the rider.
   *
   * `riderAnchor` is the *seat* - where the rider's pelvis rests on the saddle -
   * so the player capsule (which is positioned by its feet) is dropped by the
   * rider's hip height. `MountManager` measures that off the actual character it
   * built and hands it back through `setRiderDrop`, so a taller rider does not
   * end up with the camera in its own chest.
   */
  getSeat(out) {
    this.root.position.copy(this.position);
    this.root.rotation.y = this.heading;
    this.bank.rotation.set(this._pitch * 0.8, 0, this._roll);
    this.root.updateMatrixWorld(true);
    out.setFromMatrixPosition(this.riderAnchor.matrixWorld);
    out.y -= this._riderDrop;
    return out;
  }

  /**
   * Hip height of the figure actually sitting in the saddle, in metres.
   * @param {number} d
   */
  setRiderDrop(d) {
    if (Number.isFinite(d) && d > 0.2 && d < 1.6) this._riderDrop = d;
  }

  /**
   * World position of a stirrup's ankle rest.
   * @param {number} side +1 right, -1 left
   * @param {THREE.Vector3} out
   */
  getStirrupWorld(side, out) {
    const o = this.stirrups?.[side > 0 ? 0 : 1];
    if (!o) return null;
    o.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(o.matrixWorld);
  }

  /**
   * World position of a grab-handle grip.
   * @param {number} side +1 right, -1 left
   * @param {THREE.Vector3} out
   */
  getGripWorld(side, out) {
    const o = this.grips?.[side > 0 ? 0 : 1];
    if (!o) return null;
    o.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(o.matrixWorld);
  }

  /** Signed wingbeat, -1..1. The rider absorbs this through the spine. */
  get flap01() {
    return Math.sin(this._flapPhase) * this._flapAmp;
  }

  /** Current bank angle in radians (positive lifts the right flank). */
  get bankRoll() {
    return this._roll;
  }

  /** Current pitch in radians. */
  get bankPitch() {
    return this._pitch;
  }

  /**
   * Third-person framing this mount wants. A dragon is ten metres of animal;
   * the on-foot boom puts the player inside its own shoulder blades.
   */
  get cameraHint() {
    return DRAGON_CAMERA;
  }

  get fovKick() {
    return this._boost * 8 + clamp01(this.speed / BOOST_SPEED) * 3;
  }

  get boostActive() {
    return this._boostActive;
  }

  get speed01() {
    return clamp01(this.speed / BOOST_SPEED);
  }

  get boost01() {
    return this._boost;
  }

  get groundY() {
    return this._groundY;
  }

  /** Where to put the player when they climb down. */
  dismountPoint(out) {
    const rx = Math.cos(this.heading);
    const rz = -Math.sin(this.heading);
    _ds1.set(this.position.x + rx * 2.2, 0, this.position.z + rz * 2.2);
    const g = this.physics.groundHeight(_ds1.x, _ds1.z, this.position.y, 30);
    return out.set(_ds1.x, (g === null ? this._groundY : g) + 0.05, _ds1.z);
  }

  dispose() {
    this.root.removeFromParent();
    for (const g of this._geos) g.dispose();
    this._geos.length = 0;
    this._eyeMat.dispose();
    this._auraMat.dispose();
    this._auraTex.dispose();
    this._embers.dispose();
    this._dust.dispose();
    this._speedLines.dispose();
  }
}
