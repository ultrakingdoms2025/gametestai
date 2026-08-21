import * as THREE from 'three';

/**
 * THE THING THAT SHOOTS AT YOU.
 *
 * ===========================================================================
 *  TWO HALVES, ONE FILE
 * ===========================================================================
 *
 * A hostile craft is a SHAPE and a MIND, and neither is much use without the
 * other, so both live here. `buildAlienModel` turns a descriptor into four
 * meshes; `AlienShip` flies one of them at the player. `SpaceCombat` owns the
 * pool, the lasers, the encounter placement and the economy - it is the only
 * caller of anything below.
 *
 * ===========================================================================
 *  THE SHAPE: WHY IT IS NOT A RECOLOURED KESTREL
 * ===========================================================================
 *
 * The player's complaint about this world, verbatim, was "spaceships do not
 * look like spaceships, they look like they are made of square blocks". An
 * enemy built the way the yard hulls are built - from `ShipBuild`'s boxes -
 * would be the same complaint wearing red paint, and worse: the player would
 * be shooting at their own silhouette.
 *
 * So nothing in the hull uses a box. It is a FACETED SPINDLE: a ring of
 * `sides` vertices swept along the nose axis through a hand-authored radius
 * profile, emitted UNINDEXED so `computeVertexNormals` gives one normal per
 * triangle and the whole thing reads as chitin plate rather than as a smooth
 * pod. NINE sides, an odd count on purpose, because odd puts a facet EDGE
 * on the centreline of one face and a facet FACE on the other - the top and
 * the bottom of the craft catch the star differently, which is most of what
 * makes it look grown rather than machined.
 *
 * Three silhouette cues do the "hostile at a glance" work, and they were
 * chosen because they are the ones that survive being 900 m away and forty
 * pixels tall:
 *
 *   FORWARD-SWEPT, DOWN-RAKED BLADES. Every friendly hull in this game sweeps
 *   its wings BACK, because that is what a thing that is running looks like.
 *   Swept forward and raked down is what a thing that is DIVING looks like -
 *   it is the shape of a stooping hawk and of a mantis's forelimbs, and the
 *   eye reads it as intent before it reads it as a spaceship.
 *
 *   ONE RED SLIT, NOT WINDOWS. The player hulls have canopies: rectangular,
 *   pale, several of them. This has a single flattened emissive octahedron at
 *   the nose. One eye is an animal; six windows is a bus.
 *
 *   NO BILATERAL TAIL. The skiff's dorsal fin is single and offset to port,
 *   and the lance's arms are at 120 degrees rather than mirrored. Perfect
 *   bilateral symmetry reads as manufactured; a broken symmetry reads as a
 *   body.
 *
 * ===========================================================================
 *  THE MIND: WHAT "WORTH FIGHTING" MEANS IN NUMBERS
 * ===========================================================================
 *
 * The brief asked for AI that "intercepts, leads their shots, breaks off,
 * comes round again. Not a straight line at you." Four states do that, and
 * each one exists because removing it produces a specific bad fight:
 *
 *   INTERCEPT  fly to a LEAD point, not to the player. Steer at where the
 *              player WILL be. Without it they fly pure pursuit, which
 *              against a faster ship is a permanent stern view.
 *   ATTACK     inside `range` and roughly on the nose: hold the firing
 *              solution and shoot. This is the only state that fires.
 *   BREAK      at the merge - inside `BREAK_RANGE` - stop turning and go.
 *              This is the state that makes the fight a fight. An AI that
 *              keeps pulling toward a target it has already passed spirals
 *              into the player's six and stays there; one that breaks off
 *              gives the player the two seconds of separation a reversal
 *              needs.
 *   REFORM     run out to a re-entry point on a DIFFERENT bearing, then
 *              intercept again. Re-entering on the same line makes every pass
 *              identical.
 *
 * -- The energy/angles trade, which is the whole balance ---------------------
 *
 * A skiff cruises at 174 m/s and turns at 1.15 rad/s: a 151 m circle. A stock
 * Kestrel cruises at 210 m/s and turns at 1.42 rad/s: a 148 m circle. So the
 * player out-turns them by a hair and out-runs them by a lot, and EVERY hull
 * in the yard has that same 148 m radius, because turn rate and top speed both
 * scale with `powerMul` and the ratio is therefore constant (see
 * `Flight.turnRadius`). The consequence is deliberate: you cannot buy your way
 * out of a knife fight, you can only buy a bigger shield and a harder gun -
 * which is exactly what the upgrade ladder sells.
 *
 * -- Leading, and why they still miss ---------------------------------------
 *
 * `_solution` runs ONE iteration of the classic intercept: time of flight to
 * where the target is now, then aim at where it will be after that time. One
 * and not three, because a third iteration converges on a perfect shot, and a
 * perfect shot is not a fight - and because the residual error of a single
 * pass is largest exactly when the target is manoeuvring hardest, which is the
 * error a player should be rewarded for creating.
 *
 * On top of that, `_aimError` widens the cone with range and with how hard the
 * target is JINKING - the rate at which its velocity direction is turning,
 * which `SpaceCombat` measures off the real flight integrator. A player who
 * flies straight gets hit; a player who rolls and pulls does not. That is the
 * skill the encounter is asking for, and it is one number.
 *
 * ===========================================================================
 *  WHAT THIS FILE DELIBERATELY DOES NOT DO
 * ===========================================================================
 *
 * It does not use `Flight`. `Flight` is the PLAYER's integrator: a virtual
 * mouse stick, four named assists, a boost budget and a velocity aligner, all
 * tuned so a human on a mouse can fly it. Driving an AI through it would mean
 * synthesising stick deflections, and every one of those assists would then be
 * quietly deciding the fight. The model below is a quaternion slerp, a thrust
 * and a drag, with the two constants (`turnRate`, `thrust`/`drag`) the balance
 * above is stated in - and `thrust/drag` is a top speed derived exactly the
 * way `Flight.cruiseTopSpeed` derives the player's, so "he is faster than me"
 * is comparable arithmetic and not two different physics.
 *
 * It does not use `systems/Projectiles.js` either. That reasoning belongs
 * next to the thing that replaces it - see the header of `SpaceCombat.js`.
 */

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

const TAU = Math.PI * 2;

/**
 * Faceted spindle: rings of `sides` vertices swept along the nose axis.
 *
 * Authored with the nose at +Z, because that is the direction it is natural to
 * write a profile in, and NEGATED on emit so the finished mesh has its nose at
 * -Z - which is `Flight`'s `FWD_LOCAL`, `Player.forward` and the three.js
 * camera convention all at once. The yard hulls carry a `NOSE_YAW` of PI to
 * reconcile exactly this mismatch; nothing that starts here needs one, and a
 * ship that flies tail-first is a class of bug this world has already paid
 * for once.
 *
 * @param {Array<{z:number,r:number,w:number,y:number}>} sections nose first
 * @param {number} sides
 * @param {number[]} out flat xyz triples, appended to
 */
function spindle(sections, sides, out) {
  const ring = (s, i) => {
    const a = (i / sides) * TAU;
    return [Math.cos(a) * s.r * (s.w ?? 1), Math.sin(a) * s.r + (s.y ?? 0), -s.z];
  };
  const tri = (a, b, c) => { out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); };

  for (let k = 0; k < sections.length - 1; k++) {
    const s0 = sections[k];
    const s1 = sections[k + 1];
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      tri(ring(s0, i), ring(s0, j), ring(s1, j));
      tri(ring(s0, i), ring(s1, j), ring(s1, i));
    }
  }
  /* Caps: a fan to the axis point rather than a flat polygon, so the nose
   * comes to a point and the tail closes without a coplanar strip that
   * z-fights the engine discs sitting on it. */
  const ends = [[sections[0], false], [sections[sections.length - 1], true]];
  for (const [s, flip] of ends) {
    const hub = [0, s.y ?? 0, -s.z];
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      const a = ring(s, i);
      const b = ring(s, j);
      if (flip) tri(hub, b, a); else tri(hub, a, b);
    }
  }
}

/**
 * A tapered blade: a triangular prism from a root triangle to a tip triangle.
 * Both are authored nose-at-+Z and negated on emit, exactly as `spindle` does.
 */
function blade(root, tip, out) {
  const P = (p) => [p[0], p[1], -p[2]];
  const A = root.map(P);
  const B = tip.map(P);
  const tri = (a, b, c) => { out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); };
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    tri(A[i], A[j], B[j]);
    tri(A[i], B[j], B[i]);
  }
  tri(A[2], A[1], A[0]);
  tri(B[0], B[1], B[2]);
}

/** Mirror a triangle across X. The winding is reversed so it still faces out. */
function mirrorX(pts) {
  return [pts[0], pts[2], pts[1]].map((p) => [-p[0], p[1], p[2]]);
}

/**
 * The two hostile classes.
 *
 * `integrity` is the only pool they have. The player gets shields AND hull
 * because the player has an upgrade ladder that sells shields; giving the
 * enemy the same two-stage bar would mean drawing two more numbers for no
 * decision. One bar, and it is visibly a different kind of thing from yours.
 */
export const ALIEN_CLASSES = Object.freeze({
  /**
   * SKIFF - the light raider, 9.6 m, and the one you meet first.
   *
   * Every number is stated against a stock Kestrel: 95 integrity is six hits
   * from a Kestrel's gun and four from a Pike's; 9 damage a bolt means two
   * skiffs need roughly thirty seconds of unanswered fire to kill you; and
   * 174 m/s means you can always leave.
   */
  skiff: Object.freeze({
    id: 'skiff',
    name: 'Sable skiff',
    integrity: 95,
    /** m/s^2 and 1/s. Top speed is thrust/drag = 174 m/s. */
    thrust: 122,
    drag: 0.70,
    /** rad/s. A hair under the player's 1.42 at cruise. */
    turnRate: 1.15,
    /** Bounding radius of the hit sphere, metres. */
    radius: 4.2,
    length: 9.6,
    damage: 9,
    boltSpeed: 1350,
    /** Seconds between bursts, bolts per burst, seconds between those bolts. */
    cadence: 1.35,
    burst: 2,
    burstGap: 0.13,
    range: 780,
    /** Radians of aim scatter before range and jink are added. */
    spread: 0.0055,
    /** Credits traffic control pays for the transponder. */
    bounty: 55,
    /** What the salvage canister is worth if you have room for it. */
    salvage: 40,
    /** Cubic metres that canister takes up. */
    salvageBulk: 4,
  }),
  /**
   * LANCE - the heavy. 17.3 m, three arms at 120 degrees.
   *
   * Turns like a barge (0.78 rad/s, a 186 m circle at its own cruise) and hits
   * for 16. The counter is written into those two numbers: out-turn it. A Pike
   * kills one in eleven hits, a Kestrel needs fifteen and has to survive the
   * difference.
   */
  lance: Object.freeze({
    id: 'lance',
    name: 'Bronze lance',
    integrity: 260,
    thrust: 96,
    drag: 0.66,
    turnRate: 0.78,
    radius: 7.4,
    length: 17.3,
    damage: 16,
    boltSpeed: 1150,
    cadence: 2.1,
    burst: 3,
    burstGap: 0.16,
    range: 900,
    spread: 0.0048,
    bounty: 180,
    salvage: 110,
    salvageBulk: 9,
  }),
});

/**
 * The skiff's profile and limbs, in metres, nose at +Z.
 *
 * NINE sections and nine sides, and both counts were raised from the five and
 * seven the first version shipped with. That build was 192 triangles, and it
 * looked it: five sections is a nose, a middle and a tail with nothing in
 * between, which is a pod rather than an animal. The extra sections buy the
 * two shapes that make it read - a NECK pinch behind the head and a FLARE at
 * the engine housing - and neither is tessellation for its own sake. Nine
 * sides rather than eight for the reason in the header: an odd count puts a
 * facet edge on one centreline and a facet face on the other, so the top and
 * the bottom of the craft catch the star differently.
 */
const SKIFF_PLAN = {
  sides: 9,
  sections: [
    { z: 5.35, r: 0.05, w: 1.00, y: -0.36 },
    { z: 4.60, r: 0.30, w: 1.50, y: -0.30 },
    { z: 3.55, r: 0.52, w: 1.70, y: -0.20 },
    { z: 2.30, r: 0.74, w: 1.90, y: -0.10 },
    { z: 0.90, r: 1.10, w: 2.00, y: 0.00 },
    { z: -0.40, r: 1.24, w: 1.95, y: 0.07 },
    /* The neck. A waist between the head and the drives is what stops the
     * silhouette being one lump, and it is the single most valuable of the
     * four sections added. */
    { z: -1.60, r: 0.86, w: 1.45, y: 0.06 },
    { z: -2.90, r: 1.02, w: 1.30, y: 0.04 },
    { z: -4.40, r: 0.52, w: 1.05, y: 0.00 },
  ],
  blades: [
    /* The forward-swept, down-raked pair - the cue that does most of the
     * "hostile" work. Root on the flank at the widest section; tip 5.4 m out,
     * 2.2 m down and 3.2 m FORWARD of the root. */
    {
      root: [[1.5, 0.42, 1.1], [1.7, -0.30, -0.9], [1.9, -0.10, 1.3]],
      tip: [[5.3, -2.05, 3.0], [5.4, -2.28, 2.5], [5.5, -2.16, 3.1]],
    },
    /* Ventral talons: short, and the reason the underside is not a smooth
     * belly. They are what you see when it passes over you. */
    {
      root: [[0.62, -0.95, 1.6], [0.98, -0.72, 0.9], [0.98, -1.05, 1.7]],
      tip: [[1.12, -1.92, 4.3], [1.22, -1.80, 4.0], [1.26, -1.96, 4.2]],
    },
    /* Rear strakes, swept BACK and up. They exist to contradict the forward
     * blades: a craft whose every limb rakes the same way reads as an arrow,
     * and two limb sets pulling opposite ways read as a body with a posture. */
    {
      root: [[1.18, 0.30, -0.5], [1.30, -0.34, -1.5], [1.42, 0.02, -0.3]],
      tip: [[2.95, 1.02, -3.2], [3.02, 0.78, -3.6], [3.10, 0.90, -3.1]],
    },
    /* Mandibles either side of the eye. Small, and only legible up close -
     * which is where the player is at the merge. */
    {
      root: [[0.50, -0.30, 3.1], [0.70, -0.62, 2.6], [0.74, -0.40, 3.2]],
      tip: [[0.92, -0.94, 5.5], [1.00, -1.02, 5.2], [1.04, -0.98, 5.5]],
    },
  ],
  /** The dorsal fin (offset to port) and two spine spikes. Not mirrored. */
  fins: [
    {
      root: [[-0.30, 1.05, -0.4], [0.34, 1.05, -0.9], [-0.10, 1.02, -3.4]],
      tip: [[-0.42, 2.35, -1.9], [-0.10, 2.35, -2.2], [-0.30, 2.30, -3.7]],
    },
    {
      root: [[-0.26, 0.98, 0.9], [0.22, 0.98, 0.6], [-0.02, 0.96, 1.5]],
      tip: [[-0.20, 1.62, 1.0], [0.04, 1.62, 0.9], [-0.08, 1.60, 1.4]],
    },
    {
      root: [[-0.22, 0.80, 2.1], [0.18, 0.80, 1.9], [-0.02, 0.78, 2.6]],
      tip: [[-0.16, 1.28, 2.2], [0.02, 1.28, 2.1], [-0.06, 1.26, 2.5]],
    },
  ],
  eye: { z: 3.95, y: -0.06, scale: [1.85, 0.36, 1.05] },
  /**
   * Emissive strips: [x, y, z, length, half-width].
   *
   * ── THESE ARE THE SILHOUETTE, NOT DECORATION ─────────────────────────────
   * A hostile on the Cinder run is 102 degrees off the star (see the material
   * note in `buildAlienModel`), so on the side you see it there is almost no
   * light to shape it with. The seams are what the eye actually reads at 300 m
   * and they are laid along the SHAPE - the spine, the flanks, and one down
   * each forward-swept blade - so that what glows is the outline of a thing
   * diving at you rather than a scatter of dots. The blade runners are the
   * important ones: they are the cue the whole design is built round, and
   * without them the wings simply are not there in the dark.
   */
  strips: [
    [0, 1.04, 0.4, 3.4, 0.16],
    [1.66, -0.60, 1.0, 2.3, 0.14],
    [-1.66, -0.60, 1.0, 2.3, 0.14],
    [1.10, 0.46, -2.4, 1.4, 0.12],
    [-1.10, 0.46, -2.4, 1.4, 0.12],
    /* Down the leading edge of each forward-swept blade. Placed at the blade's
     * own mid-span and angled by being long in Z, which is close enough to the
     * sweep that it reads as a runner rather than as a bar. */
    [3.4, -1.15, 2.1, 2.6, 0.13],
    [-3.4, -1.15, 2.1, 2.6, 0.13],
    [4.9, -1.95, 2.8, 1.0, 0.16],
    [-4.9, -1.95, 2.8, 1.0, 0.16],
  ],
  engines: [
    { x: 0.86, y: 0.10, z: -4.5, r: 0.74 },
    { x: -0.86, y: 0.10, z: -4.5, r: 0.74 },
    { x: 0, y: -0.62, z: -4.4, r: 0.44 },
  ],
  /** Where a bolt leaves. The blade roots, which is where the eye expects it. */
  muzzles: [[1.55, -0.18, 2.7], [-1.55, -0.18, 2.7]],
};

/**
 * The lance. Three arms at 120 degrees around a heavier spindle, plus three
 * shorter spurs rolled 60 degrees off them - so the cross-section is a
 * six-pointed star with two different point lengths, which is a shape nothing
 * in the yard has and nothing in nature builds by accident.
 */
const LANCE_PLAN = {
  sides: 9,
  sections: [
    { z: 9.20, r: 0.09, w: 1.00, y: -0.22 },
    { z: 7.90, r: 0.44, w: 1.20, y: -0.18 },
    { z: 6.30, r: 0.82, w: 1.30, y: -0.12 },
    { z: 4.20, r: 1.30, w: 1.45, y: -0.04 },
    { z: 1.80, r: 1.95, w: 1.55, y: 0.04 },
    { z: -0.90, r: 2.15, w: 1.60, y: 0.10 },
    { z: -3.20, r: 1.72, w: 1.40, y: 0.08 },
    { z: -5.80, r: 1.30, w: 1.20, y: 0.05 },
    { z: -8.40, r: 0.82, w: 1.00, y: 0.00 },
  ],
  /* Authored once and rolled about the nose axis at build time, which is what
   * makes them 120 degrees apart rather than mirrored. */
  arms: [0, TAU / 3, (TAU * 2) / 3],
  arm: {
    root: [[2.3, 0.55, 1.5], [2.5, -0.55, -1.4], [2.9, 0.00, 1.8]],
    tip: [[7.9, -2.9, 4.4], [8.0, -3.25, 3.6], [8.2, -3.05, 4.5]],
  },
  spurs: [TAU / 6, TAU / 2, (TAU * 5) / 6],
  spur: {
    root: [[1.9, 0.42, -1.2], [2.0, -0.42, -2.6], [2.3, 0.00, -1.0]],
    tip: [[4.4, -0.95, -5.4], [4.5, -1.20, -5.9], [4.7, -1.05, -5.3]],
  },
  blades: [],
  fins: [],
  eye: { z: 6.9, y: -0.05, scale: [2.8, 0.52, 1.45] },
  /* Three runners down the arms and two on the body - see the note on the
   * skiff's strips. The arm runners are placed at each arm's mid-span, which
   * is where a 8 m limb needs to be told apart from empty space. */
  strips: [
    [0, 2.10, -0.4, 5.6, 0.22],
    [0, -2.00, 1.6, 4.0, 0.20],
    [2.2, 0.95, 3.0, 3.0, 0.17],
    [-2.2, 0.95, 3.0, 3.0, 0.17],
    [5.1, -1.75, 1.4, 3.6, 0.20],
    [-2.0, -1.75, 1.4, 3.6, 0.20],
    [-3.1, 2.55, 1.4, 3.6, 0.20],
  ],
  engines: [
    { x: 1.5, y: 0.20, z: -8.5, r: 1.20 },
    { x: -1.5, y: 0.20, z: -8.5, r: 1.20 },
    { x: 0, y: -1.4, z: -8.5, r: 0.95 },
  ],
  muzzles: [[2.4, -0.10, 3.4], [-2.4, -0.10, 3.4], [0, 1.9, 3.4]],
};

export const ALIEN_PLANS = Object.freeze({ skiff: SKIFF_PLAN, lance: LANCE_PLAN });

const _rotM = new THREE.Matrix4();
const _rotV = new THREE.Vector3();

/** Roll a triangle about the nose axis. Used for the lance's three arms. */
function rollPts(pts, ang) {
  _rotM.makeRotationZ(ang);
  return pts.map((p) => {
    _rotV.set(p[0], p[1], 0).applyMatrix4(_rotM);
    return [_rotV.x, _rotV.y, p[2]];
  });
}

/** A box, as twelve triangles of raw positions. Only the glow buckets use it. */
function pushBox(out, cx, cy, cz, hx, hy, hz) {
  const v = [
    [cx - hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz - hz],
    [cx + hx, cy + hy, cz - hz], [cx - hx, cy + hy, cz - hz],
    [cx - hx, cy - hy, cz + hz], [cx + hx, cy - hy, cz + hz],
    [cx + hx, cy + hy, cz + hz], [cx - hx, cy + hy, cz + hz],
  ];
  const faces = [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]];
  for (const q of faces) {
    for (const [a, b, c] of [[0, 1, 2], [0, 2, 3]]) {
      for (const i of [a, b, c]) out.push(v[q[i]][0], v[q[i]][1], v[q[i]][2]);
    }
  }
}

/**
 * Build one hostile hull.
 *
 * FOUR meshes, always, whatever the class: chitin, limbs, glow and engines.
 * Not one merged mesh, because the two emissive buckets must be
 * `toneMapped:false` and well over the space grade's 1.60 bloom threshold
 * while the chitin must not be; and not more than four, because five hostiles
 * on screen at six meshes each would add thirty draw calls to a world that
 * draws 92-146.
 *
 * Geometry and materials are built ONCE per class and shared by every
 * instance - `SpaceCombat` caches what this returns. A hostile is then a
 * `Group` of four `Mesh` objects over shared buffers: four draws and no new
 * GPU memory per spawn.
 */
export function buildAlienModel(classId) {
  const def = ALIEN_CLASSES[classId];
  const plan = ALIEN_PLANS[classId];
  if (!def || !plan) throw new Error(`[AlienShip] unknown class "${classId}"`);

  const chitin = [];
  const limbs = [];
  const glow = [];
  const engines = [];

  spindle(plan.sections, plan.sides, chitin);
  for (const b of plan.blades ?? []) {
    blade(b.root, b.tip, limbs);
    blade(mirrorX(b.root), mirrorX(b.tip), limbs);
  }
  for (const f of plan.fins ?? []) blade(f.root, f.tip, limbs);
  for (const ang of plan.arms ?? []) {
    blade(rollPts(plan.arm.root, ang), rollPts(plan.arm.tip, ang), limbs);
  }
  for (const ang of plan.spurs ?? []) {
    blade(rollPts(plan.spur.root, ang), rollPts(plan.spur.tip, ang), limbs);
  }

  /* The eye: an octahedron squashed into a slit. Six vertices, eight faces,
   * and it is the single most legible thing on the craft at range. */
  const e = plan.eye;
  const [sx, sy, sz] = e.scale;
  const p = [[sx, 0, 0], [-sx, 0, 0], [0, sy, 0], [0, -sy, 0], [0, 0, sz], [0, 0, -sz]]
    .map((q) => [q[0], q[1] + e.y, -(q[2] + e.z)]);
  const octa = [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]];
  for (const f of octa) for (const i of f) glow.push(p[i][0], p[i][1], p[i][2]);
  for (const [x, y, z, len, w] of plan.strips) pushBox(glow, x, y, -z, w, w, len * 0.5);
  for (const en of plan.engines) pushBox(engines, en.x, en.y, -en.z, en.r, en.r, 0.16);

  const group = new THREE.Group();
  group.name = `alien:${classId}`;
  const owned = [];

  const mk = (arr, mat, name) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    owned.push(g);
    const m = new THREE.Mesh(g, mat);
    m.name = name;
    /* Never culled per-mesh. The group is one object and it is either the
     * thing the player is chasing or the thing chasing them, and a merged
     * bucket's bounding sphere is computed in the BUILD frame - the origin,
     * which is not where the ship is. */
    m.frustumCulled = false;
    m.castShadow = false;
    m.receiveShadow = false;
    group.add(m);
    return m;
  };

  /* ── CHITIN, AND THE LIGHTING PROBLEM IT HAS TO SURVIVE ───────────────────
   *
   * Measured in the browser, mid-fight, on the run out to Cinder: the angle
   * between the star and the line from a hostile to the camera was 102
   * degrees. That is not bad luck. Erenmark sits at (0.58, 0.47, 0.67) and
   * Cinder at (-0.22, -0.40, -0.89) - a dot product of -0.91 - so flying to
   * the only landable planet in the volume means flying almost directly away
   * from the only light in it, and everything ahead of you is edge-lit at
   * best. `Bodies.js` puts the star behind the yard on purpose, and it is
   * right to: it means the PLANETS are front-lit from the dock. A ship you are
   * chasing is the case it does not cover.
   *
   * The first version of this material was a dark violet dielectric and the
   * screenshot showed exactly what that gets you - two red glints and no
   * craft. Three things fix it and none of them is a light:
   *
   *   ENVMAP. `metalness` 0.68 against `envMapIntensity` 1.9 means the hull
   *   picks up the nebula and the galactic band, which are the brightest
   *   things in this sky and are all around it. That is real image-based
   *   lighting off an environment the world already builds, and it costs
   *   nothing per frame.
   *
   *   EMISSIVE. Raised to a real violet rather than a token one, so the
   *   unlit side is a SHAPE at 15% rather than a hole at 2%. It is under the
   *   1.60 bloom threshold on purpose: the hull must not glow, it must merely
   *   not vanish.
   *
   *   SEAMS. The emissive strips below do the rest, and they are why this
   *   reads as alive rather than as a badly-lit prop.
   */
  /* ── The values moved again, and this is why ────────────────────────────
   * Driven and photographed rather than judged: at 234 m the skiff was not
   * visible at all, and frozen at 78 m dead ahead only the amber strips read -
   * the body was black. "You will fight orange dots" was the reviewer's
   * sentence and it was accurate.
   *
   * Base and emissive are each about half a stop up. They are still well under
   * the space grade's 1.60 bloom threshold, so the hull is a shape and not a
   * lamp, and the second half of the fix is not in this file at all:
   * `SpaceWorld._buildRim` now carries a cool fill on the camera rig, which
   * lights the skiff and the player's own hull from the same direction and is
   * what stops both of them being silhouettes in the framing the whole space
   * half of the loop is spent in. */
  const chitinMat = new THREE.MeshStandardMaterial({
    color: 0x413354, roughness: 0.44, metalness: 0.68, fog: false,
    emissive: new THREE.Color(0x452a5c), emissiveIntensity: 1,
    envMapIntensity: 1.35,
  });
  /* The limbs are the same animal, slightly harder - NOT a second material.
   * They were 0.84 metal against an envMapIntensity of 2.2, and the browser
   * showed what that gets you against this world's nebula: pale gold sticks
   * that read as separate objects clipped onto a purple body. Tuned down until
   * the blades belong to the craft and the star still catches their leading
   * edges, which is the one highlight the swept-forward shape needs. */
  const limbMat = new THREE.MeshStandardMaterial({
    color: 0x4a3958, roughness: 0.44, metalness: 0.58, fog: false,
    emissive: new THREE.Color(0x3c1a46), emissiveIntensity: 1,
    envMapIntensity: 1.0,
  });
  /* Over 1.0 in red with `toneMapped:false`, exactly as `DockExterior`'s bay
   * mouth and nav lights are. That is what carries these past the space
   * grade's 1.60 bloom threshold and makes a skiff at 900 m a red spark
   * rather than four dark pixels. */
  const glowMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(4.6, 0.34, 0.18), fog: false, toneMapped: false,
  });
  const engineMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(4.2, 0.82, 0.18), fog: false, toneMapped: false,
  });

  mk(chitin, chitinMat, `${classId}:hull`);
  mk(limbs, limbMat, `${classId}:limbs`);
  mk(glow, glowMat, `${classId}:glow`);
  mk(engines, engineMat, `${classId}:engines`);

  owned.push(chitinMat, limbMat, glowMat, engineMat);

  return {
    classId,
    group,
    def,
    glowMat,
    muzzles: plan.muzzles.map((m) => new THREE.Vector3(m[0], m[1], -m[2])),
    triangles: (chitin.length + limbs.length + glow.length + engines.length) / 9,
    dispose() {
      for (const o of owned) o.dispose?.();
      group.parent?.remove(group);
      group.clear();
    },
  };
}

/* ------------------------------------------------------------------ */
/* The mind                                                            */
/* ------------------------------------------------------------------ */

/** Module-level scratch. HOUSE RULE: a frame handler allocates nothing. */
const _d = new THREE.Vector3();
const _d2 = new THREE.Vector3();
const _lead = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _side = new THREE.Vector3();
const _upRef = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _WORLD_UP = new THREE.Vector3(0, 1, 0);
const _ALT_UP = new THREE.Vector3(0, 0, 1);
const _FWD_LOCAL = new THREE.Vector3(0, 0, -1);

const clamp = THREE.MathUtils.clamp;

/** Merge distance. Inside this the pass is over and the craft breaks off. */
export const BREAK_RANGE = 130;
/** Seconds of one attack run before it is abandoned regardless of range. */
export const ATTACK_LIMIT = 7;
/** Seconds a break-off lasts. */
export const BREAK_MIN = 1.9;
export const BREAK_MAX = 3.4;
/** How far off the target a reform point is placed. */
export const REFORM_MIN = 620;
export const REFORM_MAX = 980;
/** Cone half-angle, radians, inside which a craft will pull the trigger. */
export const FIRE_CONE = 0.10;
/** Seconds of stern chase before an intercept gives up and reforms. */
export const CHASE_LIMIT = 15;

export class AlienShip {
  /**
   * @param {object} o
   * @param {string} o.classId
   * @param {{group:THREE.Group, def:object, muzzles:THREE.Vector3[]}} o.model
   * @param {() => number} [o.rnd] 0..1. Injected so a test is reproducible.
   */
  constructor({ classId, model, rnd = Math.random }) {
    this.classId = classId;
    this.def = ALIEN_CLASSES[classId];
    this.model = model;
    this.rnd = rnd;

    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();

    this.integrity = this.def.integrity;
    this.alive = false;
    /** Seconds of wreck left to tumble. Set on death, counted down after it. */
    this.dying = 0;

    this.state = 'INTERCEPT';
    this._stateT = 0;
    this._cool = 0;
    this._burst = 0;
    this._burstT = 0;
    this._breakFor = BREAK_MIN;
    /** Seconds before this craft may fire at all. See `SpaceCombat._launch`. */
    this.holdFire = 0;
    /** The zone that spawned it; the zone counts its own dead. */
    this.zone = null;

    this._breakDir = new THREE.Vector3();
    this._reform = new THREE.Vector3();
    /**
     * A per-craft phase, so a wing of three does not weave in unison. Visual
     * only: it is a few tens of metres of wander inside an attack run, and it
     * is here to stop three bodies reading as one script rather than to change
     * any number.
     */
    this._phase = 0;
    /** Damage flash, seconds remaining. Drawn by `SpaceCombat`. */
    this.flash = 0;
    this._throttle = 1;
    /** Shots fired and shots that connected, for the encounter report. */
    this.shots = 0;
    this.hits = 0;
  }

  get name() { return this.def.name; }
  get radius() { return this.def.radius; }
  get healthFrac() { return clamp(this.integrity / this.def.integrity, 0, 1); }

  /** Put a fresh craft into the world, nose already on the target. */
  spawn(position, lookAt, { holdFire = 1.6, zone = null } = {}) {
    this.position.copy(position);
    this.integrity = this.def.integrity;
    this.alive = true;
    this.dying = 0;
    this.flash = 0;
    this.zone = zone;
    this._phase = this.rnd() * TAU;
    this.holdFire = holdFire;
    this._cool = holdFire + this.rnd() * 0.6;
    this._burst = 0;
    this.shots = 0;
    this.hits = 0;
    this.state = 'INTERCEPT';
    this._stateT = 0;
    _d.copy(lookAt).sub(position);
    if (_d.lengthSq() < 1e-6) _d.set(0, 0, -1);
    _d.normalize();
    this._face(_d, Math.PI);
    /* Already moving when it arrives. A craft that spawns at a dead stop and
     * spends two seconds building speed reads as having been placed there,
     * which is precisely the "content dumped on the player" the brief warns
     * about - half cruise is a craft that was already flying. */
    this.velocity.copy(_d).multiplyScalar((this.def.thrust / this.def.drag) * 0.5);
    this.model.group.visible = true;
    this._pose();
  }

  kill() {
    this.alive = false;
    this.integrity = 0;
    this.dying = 1.4;
  }

  /**
   * Take a hit.
   * @returns {boolean} true if this hit was the killing one
   */
  damage(amount) {
    if (!this.alive) return false;
    this.integrity -= amount;
    this.flash = 0.14;
    if (this.integrity <= 0) { this.kill(); return true; }
    return false;
  }

  /** Stand down and go home - the wing was wiped or the player left. */
  retire() {
    this.alive = false;
    this.dying = 0;
    this.model.group.visible = false;
  }

  /* ---------------------------------------------------------------- */

  /**
   * One fixed step of thinking and flying.
   *
   * @param {number} dt
   * @param {number} elapsed
   * @param {{position:THREE.Vector3, velocity:THREE.Vector3, jink:number}} target
   * @param {(from:THREE.Vector3, dir:THREE.Vector3, ship:AlienShip)=>void} fire
   */
  fixedUpdate(dt, elapsed, target, fire) {
    if (!this.alive) {
      if (this.dying > 0) {
        this.dying -= dt;
        /* A wreck keeps its momentum and is not steered. It exists so a kill
         * has a body rather than a disappearance. */
        this.position.addScaledVector(this.velocity, dt);
        if (this.dying <= 0) this.model.group.visible = false;
        else this._pose();
      }
      return;
    }

    this._stateT += dt;
    this.holdFire = Math.max(0, this.holdFire - dt);
    this.flash = Math.max(0, this.flash - dt);

    const range = this.position.distanceTo(target.position);

    switch (this.state) {
      case 'INTERCEPT': this._intercept(dt, range, target); break;
      case 'ATTACK': this._attack(dt, elapsed, range, target, fire); break;
      case 'BREAK': this._break(dt, range); break;
      case 'REFORM': this._reformRun(dt, target); break;
      default: this._setState('INTERCEPT'); break;
    }

    /* Thrust along the nose, drag against the velocity. Top speed is
     * thrust/drag by construction - the same drag fixed point the player's
     * model uses. */
    this.forward(_fwd);
    this.velocity.addScaledVector(_fwd, this.def.thrust * this._throttle * dt);
    this.velocity.multiplyScalar(Math.exp(-this.def.drag * dt));
    this.position.addScaledVector(this.velocity, dt);
    this._pose();
  }

  /* ---------------------------------------------------------------- */
  /* States                                                            */
  /* ---------------------------------------------------------------- */

  _setState(s) { this.state = s; this._stateT = 0; }

  /**
   * Close on a lead point until the target is on the nose and in range.
   *
   * ── THERE WAS A FORMATION SLOT HERE, AND IT WAS MEASURED AND REMOVED ──────
   *
   * The idea was the obvious one: give each craft in a wing an offset abeam of
   * the target's velocity so three skiffs converge on three different metres
   * of sky rather than flying one line. It read well and it was wrong.
   *
   * Flown both ways from the same seed, same spawn positions, with the offsets
   * zeroed as the only difference - three skiffs, seven seconds of run-in,
   * every pairwise distance sampled every step outside a break:
   *
   *     with +-200 m slots   mean separation 452 m, closest 21 m
   *     ablated              mean separation 504 m, closest 33 m
   *
   * The ablated wing separated BETTER. The geometry of an interception is
   * already dominated by where each craft launched (a 900-1,250 m shell across
   * a 40-degree cone) and by the random break vectors, and an offset applied
   * to a lead point that is itself moving at 200 m/s is noise against both.
   *
   * So it is gone rather than tuned. A mechanism that cannot be shown to do
   * the thing it is named for is a comment that will be believed by the next
   * person to read it, which is worse than no mechanism at all.
   */
  _intercept(dt, range, target) {
    this._throttle = 1;
    this._solution(target, _lead);
    this._steer(_lead, dt);

    if (range < this.def.range && this._onNose(_lead) < 0.42) this._setState('ATTACK');
    /* An intercept that has run for fifteen seconds has been out-run. Reform
     * rather than tail-chase forever: a stern chase you cannot win is the
     * least interesting thing an AI can do, and this world's player ship is
     * faster than both hostile classes by design. */
    else if (this._stateT > CHASE_LIMIT) this._beginReform(target);
  }

  /** Hold the firing solution and shoot. The only state that fires. */
  _attack(dt, elapsed, range, target, fire) {
    this._throttle = range > 320 ? 1 : 0.72;
    this._solution(target, _lead);
    /* A small weave on a per-craft phase. Two reasons and both matter: it
     * makes the craft harder to hit, and it makes a wing read as three pilots
     * rather than as one script wearing three bodies. */
    _d2.set(
      Math.sin(elapsed * 1.7 + this._phase),
      Math.cos(elapsed * 1.3 + this._phase * 1.7),
      0,
    ).applyQuaternion(this.quaternion);
    _lead.addScaledVector(_d2, Math.min(38, range * 0.09));
    this._steer(_lead, dt);

    this._cool -= dt;
    if (this._burst > 0) {
      this._burstT -= dt;
      if (this._burstT <= 0) {
        this._burst--;
        this._burstT = this.def.burstGap;
        this._shoot(target, fire);
      }
    } else if (this._cool <= 0 && this.holdFire <= 0
      && range < this.def.range && this._onNose(_lead) < FIRE_CONE) {
      this._burst = this.def.burst;
      this._burstT = 0;
      this._cool = this.def.cadence;
    }

    if (range < BREAK_RANGE || this._stateT > ATTACK_LIMIT) this._beginBreak(target);
    else if (range > this.def.range * 1.5) this._setState('INTERCEPT');
  }

  /** The overshoot. Stop turning, go, and take the separation. */
  _break(dt, range) {
    this._throttle = 1;
    _lead.copy(this.position).addScaledVector(this._breakDir, 600);
    this._steer(_lead, dt);
    if (this._stateT > this._breakFor || range > 900) this._setState('REFORM');
  }

  /** Come round again, on a different bearing. */
  _reformRun(dt, target) {
    this._throttle = 1;
    this._steer(this._reform, dt);
    if (this.position.distanceTo(this._reform) < 160 || this._stateT > 7) {
      this._setState('INTERCEPT');
    }
    void target;
  }

  _beginBreak(target) {
    /* Break PERPENDICULAR to the closure, with a random roll and a random
     * vertical. Breaking ALONG the closure line is a head-on re-merge every
     * time; breaking across it is what puts the two craft on opposite sides of
     * a circle, which is the geometry a reversal is fought in. */
    _d.copy(this.position).sub(target.position);
    if (_d.lengthSq() < 1e-6) _d.set(0, 0, 1);
    _d.normalize();
    _d2.copy(_d).cross(_WORLD_UP);
    if (_d2.lengthSq() < 1e-4) _d2.copy(_d).cross(_ALT_UP);
    _d2.normalize();
    this._breakDir.copy(_d).multiplyScalar(0.55)
      .addScaledVector(_d2, (this.rnd() - 0.5) * 2)
      .addScaledVector(_WORLD_UP, (this.rnd() - 0.5) * 1.2)
      .normalize();
    this._breakFor = BREAK_MIN + this.rnd() * (BREAK_MAX - BREAK_MIN);
    this._setState('BREAK');
  }

  _beginReform(target) {
    const r = REFORM_MIN + this.rnd() * (REFORM_MAX - REFORM_MIN);
    _d.set(this.rnd() - 0.5, (this.rnd() - 0.5) * 0.7, this.rnd() - 0.5);
    if (_d.lengthSq() < 1e-6) _d.set(1, 0, 0);
    _d.normalize();
    /* Placed ahead of where the target is GOING rather than behind where it
     * has been: a reform point in the target's wake is another stern chase. */
    this._reform.copy(target.position)
      .addScaledVector(target.velocity, 1.6)
      .addScaledVector(_d, r);
    this._setState('REFORM');
  }

  /* ---------------------------------------------------------------- */
  /* Gunnery                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * One iteration of the intercept: where to point so that a bolt and the
   * target arrive in the same place. One and not three - see the header.
   */
  _solution(target, out) {
    const d = this.position.distanceTo(target.position);
    const t = d / this.def.boltSpeed;
    return out.copy(target.velocity).multiplyScalar(t).add(target.position);
  }

  /**
   * Aim scatter, radians. Grows with range and with how hard the target is
   * turning. This is the number a player's flying is measured against.
   */
  _aimError(target, range) {
    const rangeTerm = (range / this.def.range) * 0.011;
    const jinkTerm = clamp(target.jink ?? 0, 0, 1) * 0.021;
    return this.def.spread + rangeTerm + jinkTerm;
  }

  _shoot(target, fire) {
    const range = this.position.distanceTo(target.position);
    this._solution(target, _lead);
    _d.copy(_lead).sub(this.position);
    if (_d.lengthSq() < 1e-9) return;
    _d.normalize();

    const sigma = this._aimError(target, range);
    /* Scatter across the aim line: take any perpendicular, roll it by a random
     * angle, and tip the aim into it. Uniform in angle; the magnitude is the
     * sum of two uniforms, which is triangular rather than gaussian and costs
     * two multiplies instead of a Box-Muller. At these cone widths the
     * difference is not observable and the cost is. */
    _d2.copy(_d).cross(_WORLD_UP);
    if (_d2.lengthSq() < 1e-4) _d2.copy(_d).cross(_ALT_UP);
    _d2.normalize();
    _side.copy(_d).cross(_d2).normalize();
    const a = this.rnd() * TAU;
    const mag = sigma * ((this.rnd() + this.rnd()) - 1) * 2;
    _d.addScaledVector(_d2, Math.cos(a) * mag).addScaledVector(_side, Math.sin(a) * mag).normalize();

    const mz = this.model.muzzles;
    const m = mz[(this._burst + mz.length) % mz.length];
    _lead.copy(m).applyQuaternion(this.quaternion).add(this.position);
    this.shots++;
    fire(_lead, _d, this);
  }

  /* ---------------------------------------------------------------- */
  /* Flying                                                            */
  /* ---------------------------------------------------------------- */

  forward(out = _fwd) { return out.copy(_FWD_LOCAL).applyQuaternion(this.quaternion); }

  /** Turn toward a point at no more than `turnRate`, banking into the turn. */
  _steer(point, dt) {
    _d.copy(point).sub(this.position);
    if (_d.lengthSq() < 1e-6) return;
    _d.normalize();
    this._face(_d, this.def.turnRate * dt);
  }

  /**
   * Rotate toward a direction, capped at `maxAngle` radians.
   *
   * The bank is not decoration. A craft that changes heading without rolling
   * reads as a cursor being dragged across the sky; one that leans into the
   * turn reads as a thing with wings. The lean is derived from how far off the
   * nose the new heading is measured along the craft's OWN right vector, so it
   * always banks into the turn it is actually making.
   */
  _face(dir, maxAngle) {
    _side.set(1, 0, 0).applyQuaternion(this.quaternion);
    const bank = clamp(-_side.dot(dir) * 2.4, -1.15, 1.15);

    _upRef.copy(_WORLD_UP);
    if (Math.abs(dir.dot(_WORLD_UP)) > 0.985) _upRef.copy(_ALT_UP);
    _upRef.applyAxisAngle(dir, bank);

    /* `Matrix4.lookAt(eye, target, up)` builds a frame whose -Z points from
     * eye to target, which is the same nose convention the geometry above was
     * emitted in. The target is one metre AHEAD along `dir`. */
    _d2.copy(this.position).addScaledVector(dir, 1);
    _m.lookAt(this.position, _d2, _upRef);
    _q.setFromRotationMatrix(_m);

    const ang = this.quaternion.angleTo(_q);
    if (ang < 1e-5) { this.quaternion.copy(_q); return; }
    this.quaternion.slerp(_q, maxAngle >= ang ? 1 : maxAngle / ang);
  }

  /** Radians between the nose and a point. */
  _onNose(point) {
    _d2.copy(point).sub(this.position);
    if (_d2.lengthSq() < 1e-9) return 0;
    _d2.normalize();
    this.forward(_fwd);
    return Math.acos(clamp(_fwd.dot(_d2), -1, 1));
  }

  _pose() {
    this.model.group.position.copy(this.position);
    this.model.group.quaternion.copy(this.quaternion);
  }
}
