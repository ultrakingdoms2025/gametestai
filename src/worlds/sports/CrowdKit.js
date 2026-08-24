/**
 * MERIDIAN ATHLETIC GROUNDS - the crowd's figure table.
 *
 * `SportsWorld._buildCrowd` built its five poses from numbers typed inline. It
 * is the only system in this world with an authored `.glb` beside it
 * (`scripts/make-sports-crowd-glb.mjs`), and the generator has to put a hand on
 * the end of an arm and a shoe on the end of a leg. Two files typing the same
 * 0.58 and the same 1.16 is the shape `make-ship-glb.mjs` used and
 * `make-beast-glb.mjs` stopped using: change a sleeve length in one and the
 * other silently puts a hand in mid-air, with nothing red anywhere.
 *
 * So the table lives here, the world builds the figure from it, and the
 * generator IMPORTS it and derives every attachment point from the same limb
 * it is attaching to. `sports-crowd-assets.test.mjs` fires the derivation at
 * the committed bytes: move a number in this file and the byte-diff goes red
 * telling you to regenerate, which is the whole point of the arrangement.
 *
 * ── The coordinate convention, which is three's and not a new one ─────────
 *
 * A limb is `CylinderGeometry(r0, r1, len, 6)` - a six-sided frustum along +Y,
 * centred on the origin, `r0` at the TOP - then `.rotateX(rx)`, then
 * `.rotateZ(rz)`, then `.translate(...at)`. That is exactly the call chain the
 * world used before this table existed, in the same order, so `limbEnd` below
 * reproduces the geometry rather than approximating it.
 *
 * Nothing here allocates: the world builds geometry from these specs and the
 * generator reads points out of them, and both run once at build time.
 */

/** Every limb is six-sided. Stated once because the generator's hand and shoe
 *  have to sit against a hexagon, not against a circle. */
export const LIMB_SEGMENTS = 6;

/**
 * Garment value bands, multiplied into the per-instance coat colour.
 *
 * Before this, every vertex of every figure carried colour 1.0, so one
 * `setColorAt` painted the whole person - shirt, sleeves and trousers - a
 * single flat value. Photographed at four metres
 * (`img/2026-08-23-art-sports/before-crowdpad-front.jpg`) that is the loudest
 * "toy" cue a figure has: a real body has a horizontal value break at the
 * waist, and a monochrome one has no landmark for the eye anywhere between the
 * shoes and the head.
 *
 * These are MULTIPLIERS on the figure's own coat colour, not independent
 * colours, because the crowd draws through one instance-tinted material and a
 * second tint would be a second material and a candidate new shader program.
 * So a figure's trousers are a dark version of its own shirt. That is a
 * constraint accepted rather than an accident, and it is the same one
 * `make-crowd-glb.mjs` accepted for the station's hair: every entry in this
 * world's sixteen-colour sportswear palette is already a muted mid-tone, so at
 * 0.52 the trousers land in a believable dark band with a faint hue of the
 * top.
 *
 * `bag` is darker still: a kit bag is not made of the same cloth as a tracksuit
 * and reading as one is what made it invisible against the hip.
 */
export const BAND = Object.freeze({
  torso: 1.0,
  arm: 0.9,
  leg: 0.52,
  bag: 0.4,
  strap: 0.34,
});

/**
 * The five poses, as data.
 *
 * `role` decides the value band and, for `arm` and `leg`, which end the
 * generator hangs a hand or a shoe on: the -Y end after rotation, always,
 * because that is the end of a limb that points away from the body.
 *
 * `side` is -1 for the figure's left (-X) and +1 for its right. It is how
 * `wristOf`/`ankleOf` find the pair, so a pose whose two arms are at different
 * angles - `carry` - still resolves both.
 *
 * `open` marks a limb whose BOTH end faces are covered by something else, so
 * the world may build it `openEnded` and save twelve triangles. It is only
 * honoured when the authored part that covers the far end has actually landed
 * (see `_buildCrowd`), because an open-ended leg with no shoe on it is a
 * hollow tube, and a graceful degradation that degrades to a hole is not one.
 */
export const POSES = Object.freeze({
  stand: {
    cloth: [
      { role: 'leg', side: -1, r0: 0.085, r1: 0.105, len: 0.88, at: [-0.11, 0.44, 0], open: true },
      { role: 'leg', side: 1, r0: 0.085, r1: 0.105, len: 0.88, at: [0.11, 0.44, 0.02], open: true },
      { role: 'torso', r0: 0.185, r1: 0.15, len: 0.62, at: [0, 1.18, 0] },
      { role: 'arm', side: -1, r0: 0.055, r1: 0.05, len: 0.58, rz: 0.13, at: [-0.23, 1.16, 0.01], open: true },
      { role: 'arm', side: 1, r0: 0.055, r1: 0.05, len: 0.58, rz: -0.13, at: [0.23, 1.16, -0.01], open: true },
    ],
    head: { r: 0.108, wseg: 8, hseg: 6, at: [0, 1.62, 0] },
    neck: { r0: 0.046, r1: 0.046, len: 0.1, at: [0, 1.5, 0] },
  },
  carry: {
    cloth: [
      { role: 'leg', side: -1, r0: 0.085, r1: 0.105, len: 0.88, rz: -0.07, at: [-0.13, 0.44, 0], open: true },
      { role: 'leg', side: 1, r0: 0.085, r1: 0.105, len: 0.88, rz: 0.03, at: [0.1, 0.44, 0.02], open: true },
      { role: 'torso', r0: 0.185, r1: 0.15, len: 0.62, rz: 0.06, at: [0, 1.18, 0] },
      /* THE SALUTE.
       *
       * This arm was `len: 0.5, rz: 0.9, at: [-0.24, 1.3, 0.02]`, and derived
       * rather than eyeballed its ends are (-0.436, 1.455) and (-0.044, 1.145).
       * The lower end is at the CENTRE OF THE CHEST and the upper end is 44 cm
       * out at shoulder height: an arm raised straight out to the side, on a
       * figure whose comment says "kit bag over the shoulder". Photographed at
       * four metres on the arrival plaza
       * (`before-crowdplaza-three-quarter.jpg`) the nineteen `carry` figures
       * are giving a salute with a plank through their hips.
       *
       * It also breaks the one invariant every other arm in this file holds -
       * that the -Y end after rotation is the HAND - which is what the
       * generator hangs a hand on. Left alone it would have put a hand in an
       * armpit.
       *
       * Now it hangs, with 0.10 rad of outward cant so the hand comes to rest
       * against the bag. The "carrying" read is the bag's job and the bag now
       * does it. */
      { role: 'arm', side: -1, r0: 0.055, r1: 0.05, len: 0.56, rz: 0.10, at: [-0.235, 1.17, 0.0], open: true },
      { role: 'arm', side: 1, r0: 0.055, r1: 0.05, len: 0.58, rz: -0.1, at: [0.23, 1.16, -0.01], open: true },
    ],
    head: { r: 0.108, wseg: 8, hseg: 6, at: [0.01, 1.62, 0] },
    neck: { r0: 0.046, r1: 0.046, len: 0.1, at: [0.01, 1.5, 0] },
    /**
     * The kit bag, and what it was.
     *
     * `BoxGeometry(0.5, 0.24, 0.22)` at (-0.3, 1.02, 0.06) - a box HALF A METRE
     * WIDE ALONG X, on a figure 0.44 m across, hung at the waist, so it stuck
     * out 33 cm past the shoulder on one side and reached the far hip on the
     * other. It is the same defect shape `art-citadel` found in its window
     * recesses - written once, never looked at, no error, no failing test -
     * except this one was not invisible, it was the largest single mass on
     * nineteen figures.
     *
     * A bag worn across the body is deep and narrow, and it needs the strap
     * that puts it there or it reads as a box balanced on a hip. Both are
     * here: a 0.22 x 0.28 x 0.15 body on the left front hip, and one strap
     * running up across the chest to the right shoulder, lying at z 0.155 so
     * it sits ON the torso surface (radius 0.168 at that height) rather than
     * inside it.
     */
    bag: {
      body: { role: 'bag', size: [0.22, 0.28, 0.15], at: [-0.26, 0.97, 0.09], rz: 0.05 },
      straps: [
        { role: 'strap', size: [0.06, 0.50, 0.028], at: [-0.055, 1.27, 0.155], rz: -0.88 },
      ],
    },
  },
  lean: {
    cloth: [
      { role: 'leg', side: -1, r0: 0.08, r1: 0.1, len: 0.86, rz: 0.12, at: [-0.14, 0.43, 0], open: true },
      { role: 'leg', side: 1, r0: 0.08, r1: 0.1, len: 0.86, rz: 0.04, at: [0.09, 0.43, 0], open: true },
      { role: 'torso', r0: 0.18, r1: 0.15, len: 0.6, rz: -0.14, at: [0.02, 1.16, 0] },
      { role: 'arm', side: -1, r0: 0.055, r1: 0.05, len: 0.56, rz: 0.5, at: [-0.26, 1.12, 0.02], open: true },
      { role: 'arm', side: 1, r0: 0.055, r1: 0.05, len: 0.56, rz: -0.2, at: [0.25, 1.1, 0.04], open: true },
    ],
    head: { r: 0.108, wseg: 8, hseg: 6, at: [0.08, 1.58, 0.02] },
    neck: { r0: 0.046, r1: 0.046, len: 0.1, at: [0.06, 1.46, 0.01] },
  },
  sit: {
    cloth: [
      { role: 'thigh', side: -1, r0: 0.085, r1: 0.1, len: 0.44, rx: Math.PI / 2, at: [-0.1, 0.44, 0.2] },
      { role: 'thigh', side: 1, r0: 0.085, r1: 0.1, len: 0.44, rx: Math.PI / 2, at: [0.1, 0.44, 0.2] },
      { role: 'leg', side: -1, r0: 0.07, r1: 0.085, len: 0.44, at: [-0.1, 0.22, 0.4], open: true },
      { role: 'leg', side: 1, r0: 0.07, r1: 0.085, len: 0.44, at: [0.1, 0.22, 0.4], open: true },
      { role: 'torso', r0: 0.17, r1: 0.145, len: 0.52, at: [0, 0.72, 0.02] },
      { role: 'arm', side: -1, r0: 0.055, r1: 0.05, len: 0.42, rx: 0.7, at: [-0.19, 0.66, 0.16] },
      { role: 'arm', side: 1, r0: 0.055, r1: 0.05, len: 0.42, rx: 0.7, at: [0.19, 0.66, 0.16] },
    ],
    head: { r: 0.105, wseg: 8, hseg: 6, at: [0, 1.06, 0] },
    neck: { r0: 0.045, r1: 0.045, len: 0.09, at: [0, 0.96, 0] },
  },
  crouch: {
    cloth: [
      { role: 'thigh', side: -1, r0: 0.09, r1: 0.11, len: 0.42, rx: 1.25, at: [-0.11, 0.5, 0.12] },
      { role: 'thigh', side: 1, r0: 0.09, r1: 0.11, len: 0.42, rx: 1.25, at: [0.11, 0.5, 0.12] },
      { role: 'leg', side: -1, r0: 0.075, r1: 0.09, len: 0.42, rx: -0.35, at: [-0.11, 0.2, 0.3] },
      { role: 'leg', side: 1, r0: 0.075, r1: 0.09, len: 0.42, rx: -0.35, at: [0.11, 0.2, 0.3] },
      { role: 'torso', r0: 0.175, r1: 0.15, len: 0.5, rx: 0.28, at: [0, 0.78, -0.05] },
      { role: 'arm', side: -1, r0: 0.055, r1: 0.05, len: 0.46, rx: 1.0, at: [-0.2, 0.72, 0.14] },
      { role: 'arm', side: 1, r0: 0.055, r1: 0.05, len: 0.46, rx: 1.0, at: [0.2, 0.72, 0.14] },
    ],
    head: { r: 0.105, wseg: 8, hseg: 6, at: [0, 1.12, -0.06] },
    neck: { r0: 0.045, r1: 0.045, len: 0.09, at: [0, 1.02, -0.05] },
  },
});

/** Every pose id, in the order the world builds them. */
export const POSE_KEYS = Object.freeze(Object.keys(POSES));

/**
 * Apply a spec's rotation and translation to a point in limb space.
 *
 * X first then Z, because that is the order `geo.rotateX(a).rotateZ(b)` applies
 * them and this function's contract is to reproduce the world's geometry, not
 * to be an independent opinion about it. Written out rather than done with a
 * `THREE.Matrix4` so the generator can import this module under plain Node
 * without pulling three in for five multiplies.
 *
 * @param {object} spec a limb or box spec carrying `at` and optional `rx`/`rz`
 * @param {number[]} p point in limb space
 * @returns {number[]} point in figure space
 */
export function place(spec, p) {
  let [x, y, z] = p;
  const rx = spec.rx ?? 0;
  const rz = spec.rz ?? 0;
  if (rx) {
    const c = Math.cos(rx);
    const s = Math.sin(rx);
    const ny = y * c - z * s;
    z = y * s + z * c;
    y = ny;
  }
  if (rz) {
    const c = Math.cos(rz);
    const s = Math.sin(rz);
    const nx = x * c - y * s;
    y = x * s + y * c;
    x = nx;
  }
  return [x + spec.at[0], y + spec.at[1], z + spec.at[2]];
}

/**
 * The centre of one end face of a limb, in figure space.
 * @param {object} spec
 * @param {1|-1} sign +1 for the `r0` end (up the body), -1 for the `r1` end
 */
export function limbEnd(spec, sign) {
  return place(spec, [0, (sign * spec.len) / 2, 0]);
}

/** The radius of that end face. */
export function limbRadius(spec, sign) {
  return sign > 0 ? spec.r0 : spec.r1;
}

/** The unit direction a limb's `-Y` end points, in figure space. */
export function limbAxis(spec) {
  const a = place(spec, [0, 0.5, 0]);
  const b = place(spec, [0, -0.5, 0]);
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return [d[0] / l, d[1] / l, d[2] / l];
}

/**
 * One limb spec by role and side, or null.
 *
 * Exported because the generator does not want a POINT, it wants the LIMB: a
 * hand is placed at `place(arm, [0, -len/2 - 0.04, 0])`, in the arm's own
 * frame, so it stays welded to the sleeve when the sleeve's angle changes. A
 * point plus a rotation would have to be recombined at the far end and is one
 * more place for the two files to disagree.
 */
export function specOf(pose, role, side) {
  return POSES[pose].cloth.find((s) => s.role === role && s.side === side) ?? null;
}

const find = specOf;

/**
 * Where a hand goes: the far end of the arm on that side, with the arm's own
 * rotation, so the hand continues the sleeve rather than hanging off it at an
 * angle.
 *
 * @param {string} pose
 * @param {1|-1} side
 * @returns {{at:number[], rx:number, rz:number, r:number}|null}
 */
export function wristOf(pose, side) {
  const arm = find(pose, 'arm', side);
  if (!arm) return null;
  return {
    at: limbEnd(arm, -1),
    rx: arm.rx ?? 0,
    rz: arm.rz ?? 0,
    r: limbRadius(arm, -1),
  };
}

/**
 * Where a shoe goes: the far end of the lower leg on that side.
 *
 * `role` is `leg` for a one-piece leg (`stand`, `lean`, `carry`) and for the
 * SHIN of the two-piece poses (`sit`, `crouch`), which is why the shin carries
 * `leg` and the upper piece carries `thigh`. One accessor then answers for all
 * five without the caller knowing which kind of leg it asked about.
 */
export function ankleOf(pose, side) {
  const leg = find(pose, 'leg', side);
  if (!leg) return null;
  return {
    at: limbEnd(leg, -1),
    rx: leg.rx ?? 0,
    rz: leg.rz ?? 0,
    r: limbRadius(leg, -1),
  };
}

/** The head sphere, which is what the hair is scaled and placed against. */
export function headOf(pose) {
  return POSES[pose].head;
}
