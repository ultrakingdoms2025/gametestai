import * as THREE from 'three';
import { boxGeo, cylGeo, uvScale, instanced } from '../StationKit.js';

/**
 * RING 8 EXPANSION - the half-built zone on avenue 240.
 *
 * ── What this zone is for ─────────────────────────────────────────────────
 * The other three outer zones are finished places: people live, train and eat
 * in them, and the drama has to be manufactured out of dressing. This one has
 * drama built into its premise. A building site is the only environment where
 * *vertical* activity is the normal state of affairs - the interesting thing is
 * forty metres up, somebody is standing on it, and there is a crane swinging a
 * two-tonne bundle of steel over your head while you watch. So this zone spends
 * its budget on height and on people at height, and comparatively little on
 * floor-level detail, which is the opposite of how the hub is dressed.
 *
 * ── The section, and why the site is organised the way it is ──────────────
 * `OuterRing.buildZone` hands every zone the same section: an open court under
 * the great dome inside r = 112 with 120 m of air over it, and a covered arcade
 * from there to the rim with a ceiling plate at 30 m. That is not a constraint
 * to work around here, it is the site plan:
 *
 *   r < 108     inside the hoarding. Towers, cranes, the haul road, the pour.
 *               Everything tall, everything dangerous, everything a visitor is
 *               not supposed to be able to wander into by accident.
 *   r 108-200   outside the hoarding, under the arcade roof. Site offices,
 *               welfare, the materials laydown, plant, fuel, spoil. All of it
 *               under 27 m, because the ceiling plate is at 30 and a silo
 *               through it would be a hole in the zone shell.
 *
 * A continuous hoarding line at r = 108 with four gates is what makes that read
 * as one decision rather than as two unrelated scatters. It also does real work
 * for movement: a player arriving from the link is funnelled through the main
 * gate under the SCAFFOLD ACCESS board, which is the only place in the zone
 * where the site tells you what it is before you are standing in it.
 *
 * ── Why the scaffold lifts are 2.6 m and not 2.0 m ────────────────────────
 * Real tube-and-board scaffold is boarded out every 2 m, and the first version
 * of this was. It is unusable: a 2.0 m lift with a 0.2 m deck leaves 1.8 m of
 * headroom, and the player capsule is 1.75 m plus a step allowance, so walking
 * a lift meant grinding along the underside of the boards above and snagging at
 * every transom. 2.6 m lifts give 2.4 m clear, which is the tightest spacing the
 * movement code is comfortable in. It is the one dimension on this site that is
 * not to spec, and it is deliberate.
 *
 * ── Collision, which this zone lives or dies on ───────────────────────────
 * `StationWorld._collisionSoup` only extracts triangles within `DECK_R` of the
 * WORLD origin, and this deck is 498 m out - so not one thing built here is
 * collided automatically, and `_solidifyProps` rejects the instances for the
 * same reason. Every board a worker stands on, every tread, every barrier and
 * every cabin therefore declares itself with `ctx.solid`, and the boarded lifts
 * hand their rectangles back to the actor pass, so a figure at 31 m is standing
 * on a surface that provably exists rather than on an author's arithmetic.
 */

/* Site geography. The hoarding sits 4 m inside the court edge so its gate posts
 * and the arcade's first rank of trusses are never fighting for the same metre. */
const HOARD_R = 108;
/** Radius of the haul road loop inside the site, and its width. */
const LOOP_R = 88;
const ROAD_W = 14;
/** Boarded-lift spacing. See the header - 2.6, not 2.0, and for a reason. */
const LIFT = 2.6;

/**
 * The three towers, at three stages of the same build.
 *
 * Their footprints are all inside r = 76 so nothing structural crosses the haul
 * road loop at 88, and the loop is what a truck has to be able to drive without
 * anybody having to think about it. They are ordered nearest-to-furthest from
 * the main gate as frame -> half-clad -> topping out, so the sequence a player
 * reads walking in is the sequence the building goes through.
 */
const T1 = { cx: -52, cz: 24, w: 24, d: 24, storeyH: 4.0, storeys: 12 };
const T2 = { cx: 50, cz: 30, w: 26, d: 22, storeyH: 4.0, storeys: 13, cladTo: 6 };
const T3 = { cx: -6, cz: -54, w: 30, d: 26, storeyH: 3.9, storeys: 14, cladTo: 12 };

/** Tower crane: mast position, mast height, and where the jib is slewed to. */
const CRANE = { x: 24, z: 6, mast: 58, aim: [54, -4] };
/** Crawler crane, flying a cladding cassette at tower 3. */
const CRAWLER = { x: -26, z: -18 };

export function buildConstruction(ctx) {
  const { M, rng } = ctx;

  /* ---------------------------------------------------------------- */
  /* Small deterministic helpers                                       */
  /* ---------------------------------------------------------------- */

  const rnd = (a, b) => a + rng() * (b - a);
  /** Zone-local bearing helper: a = 0 points back at the hub, +a swings to +X. */
  const bx = (a, r) => Math.sin(a) * r;
  const bz = (a, r) => Math.cos(a) * r;
  /**
   * A point in some prop's own frame, in zone coordinates.
   *
   * Exactly the mapping `GeoBatch.localAt` uses - local +X to (cos, -sin), local
   * +Z to (sin, cos) - so a part positioned with this and drawn with
   * `ctx.put(..., yaw)` cannot disagree about where it is.
   */
  const at = (ox, oz, yaw, lx, lz) => [
    ox + lx * Math.cos(yaw) + lz * Math.sin(yaw),
    oz - lx * Math.sin(yaw) + lz * Math.cos(yaw),
  ];
  /**
   * Yaw for an actor at (lx, lz) that should be looking at (tx, tz).
   * A figure's forward is its own -Z, so the heading is the negated delta.
   */
  const facing = (lx, lz, tx, tz) => Math.atan2(-(tx - lx), -(tz - lz));

  /* ---------------------------------------------------------------- */
  /* Instanced kit                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * Everything on this site that exists more than about fifteen times.
   *
   * Two rules make this safe to use from zone-local authoring code:
   *
   *  1. `instanced()` wants world-space tuples, so `sc()` is the only place the
   *     transform happens - it pushes through `ctx.P` and `ctx.yawOf`, which is
   *     what `ctx.put` does for the merged batch. A member placed with
   *     `sc(..., yaw)` therefore lands on the same metre as the same member
   *     placed with `ctx.put(..., yaw)`.
   *
   *  2. An instance carries only a Y rotation. `THREE.Object3D.rotation` is
   *     XYZ-ordered and `GeoBatch.at` is YXZ-ordered, so a tilted instance and
   *     a tilted batch member would disagree about what a pitch means. Anything
   *     not upright therefore bakes its quarter turn into the geometry (see
   *     `rebar`, `drum`) or goes into the merged batch instead (see the lattice
   *     bracing). Nothing here sets rx or rz per instance.
   *
   * Base geometries are authored at the commonest size in each family, so the
   * per-instance stretch is small where it is visible at all: a 9 cm ledger
   * scaled from 8 m to 11 m tiles its texture 37% long across a surface nine
   * centimetres wide, which is not something anybody can see.
   */
  const KIT = {
    standard: { mat: 'trim', geo: () => boxGeo(0.11, 26, 0.11, 2) },
    ledger: { mat: 'trim', geo: () => boxGeo(8, 0.09, 0.09, 1.5) },
    board: { mat: 'panelWarm', geo: () => boxGeo(8, 0.12, 1.6, 1.2) },
    toe: { mat: 'hazard', geo: () => boxGeo(8, 0.26, 0.05, 1) },
    rail: { mat: 'chrome', geo: () => boxGeo(8, 0.07, 0.07, 1) },
    netting: { mat: 'grate', geo: () => boxGeo(8, 2.6, 0.04, 1.8) },
    tread: { mat: 'grate', geo: () => boxGeo(2.4, 0.10, 0.52, 1.2) },
    column: { mat: 'beam', geo: () => boxGeo(0.7, 26, 0.7, 3) },
    girder: { mat: 'beam', geo: () => boxGeo(12, 0.85, 0.5, 3) },
    hoard: { mat: 'panel', geo: () => boxGeo(4.0, 2.4, 0.13, 2.2) },
    hoardCap: { mat: 'hazard', geo: () => boxGeo(4.0, 0.24, 0.28, 1) },
    fence: { mat: 'grate', geo: () => boxGeo(3.4, 2.0, 0.05, 1.7) },
    fencePost: { mat: 'trimDark', geo: () => boxGeo(0.1, 2.25, 0.1, 1) },
    jersey: { mat: 'hazard', geo: () => boxGeo(3.0, 0.92, 0.62, 1.3) },
    cone: { mat: 'hazard', geo: () => uvScale(new THREE.ConeGeometry(0.3, 0.78, 8), 2, 2) },
    pallet: { mat: 'panelWarm', geo: () => boxGeo(1.35, 0.15, 1.15, 1) },
    pack: { mat: 'crate', geo: () => boxGeo(1.26, 0.62, 1.04, 1.2) },
    // Rebar bundles and cable drums lie on their sides; the quarter turn is
    // baked in so the instance still only carries a yaw.
    rebar: { mat: 'trimDark', geo: () => cylGeo(0.3, 0.3, 6.4, 6, 1.6).rotateZ(Math.PI / 2) },
    drum: { mat: 'panelRust', geo: () => cylGeo(0.92, 0.92, 1.0, 12, 1.4).rotateZ(Math.PI / 2) },
    drumCable: { mat: 'rubber', geo: () => cylGeo(0.66, 0.66, 0.84, 10, 1.2).rotateZ(Math.PI / 2) },
    steel: { mat: 'beam', geo: () => boxGeo(9, 0.85, 1.5, 2.4) },
    spoil: { mat: 'panelRust', geo: () => uvScale(new THREE.ConeGeometry(1, 1, 12), 6, 3) },
    lampMast: { mat: 'trimDark', geo: () => boxGeo(0.24, 9, 0.24, 2) },
    lampHead: { mat: 'emSodium', geo: () => boxGeo(1.7, 0.24, 0.6, 1), lit: true },
    beacon: { mat: 'emRed', geo: () => boxGeo(0.34, 0.16, 0.34, 1), lit: true },
    stripe: { mat: 'hazard', geo: () => boxGeo(0.5, 0.06, 2.6, 1) },
    spark: { mat: 'emWhite', geo: () => boxGeo(0.13, 0.13, 0.13, 1), lit: true },
    // Static, because `_anim.steam` is a single world-wide slot owned by the
    // hub's dressing pass and a zone cannot claim it without taking the plaza's
    // vents down with it. These face back up the approach instead of billboarding,
    // which is the direction every player sees them from on the way in.
    puff: { mat: 'steam', geo: () => new THREE.PlaneGeometry(4.4, 4.4), lit: true },
  };

  /** @type {Map<string, number[][]>} */
  const batches = new Map();
  const sc = (name, lx, ly, lz, yaw = 0, sx = 1, sy = 1, sz = 1) => {
    const p = ctx.P(lx, ly, lz);
    let list = batches.get(name);
    if (!list) batches.set(name, (list = []));
    list.push([p.x, p.y, p.z, 0, ctx.yawOf(yaw), 0, sx, sy, sz]);
  };

  /* ---------------------------------------------------------------- */
  /* Standable surfaces                                                */
  /* ---------------------------------------------------------------- */

  /**
   * A standable surface, declared once and remembered.
   *
   * `ctx.solid` takes a centre and half-extents, which is the wrong end of the
   * problem for a scaffold: what an author knows is where the *top* is, because
   * that is the number a worker's feet and a collectable's plinth are quoted at.
   * This takes the top and hands back the rectangle, and the population pass
   * only ever puts people on a rectangle it was given - so "figure standing in
   * mid-air", the defect this zone is most exposed to, is not expressible.
   */
  const deck = (lx, top, lz, hx, hz, yaw = 0, thick = 0.22) => {
    ctx.solid(lx, top - thick / 2, lz, hx, thick / 2, hz, yaw);
    return { lx, lz, top, hx, hz, yaw };
  };

  /** Put a figure on a deck rectangle, inset far enough to keep it on the boards. */
  const crew = (rect, u, v, opts = {}) => {
    const du = u * Math.max(0, rect.hx - 0.55);
    const dv = v * Math.max(0, rect.hz - 0.55);
    const [lx, lz] = at(rect.lx, rect.lz, rect.yaw, du, dv);
    return ctx.actor(lx, rect.top, lz, { variant: 'hiviz', ...opts });
  };

  /** A figure on the deck itself. Everybody who works here wears a vest. */
  const hand = (lx, lz, opts = {}) => ctx.actor(lx, 0, lz, { variant: 'hiviz', ...opts });

  /**
   * A short external stair climbing along the local +Z of (ox, oz, yaw).
   *
   * `CONFIG.player.stepHeight` is 0.45, so a 0.39 m riser is walkable without
   * the step assist having to reach for it, and 0.55 m of going is comfortable
   * enough that a flight does not snag. Both numbers are shared by every stair
   * on the site for exactly that reason.
   */
  const stairRun = (ox, oz, yaw, lx, z0, n, width = 1.4, rise = 0.39, going = 0.55) => {
    for (let t = 0; t < n; t++) {
      const y = rise * (t + 1);
      const [ax, az] = at(ox, oz, yaw, lx, z0 + going * (t + 0.5));
      sc('tread', ax, y - 0.05, az, yaw, width / 2.4, 1, going / 0.52);
      ctx.solid(ax, y - 0.13, az, width / 2 + 0.05, 0.13, going / 2 + 0.02, yaw);
    }
    return rise * n;
  };

  /* ---------------------------------------------------------------- */
  /* Ground: the haul road and its markings                            */
  /* ---------------------------------------------------------------- */

  /**
   * The haul road.
   *
   * A site reads as organised or as a junkyard almost entirely on whether there
   * is an obvious route through it, and this one has to survive being looked at
   * from 120 m up. So it is a single legible figure: a straight run in from the
   * arrival plaza through the main gate, and one loop at r = 88 that every
   * tower, stack and machine is arranged around.
   */
  ctx.floorQuad('road', ROAD_W + 4, 48, 0, 130, 0, 0.1, 12);
  const ROAD_SEG = 40;
  for (let i = 0; i < ROAD_SEG; i++) {
    const a = (i / ROAD_SEG) * Math.PI * 2;
    // Chord plus a little overlap, so the ring never shows a seam of bare deck.
    ctx.floorQuad('road', (Math.PI * 2 * LOOP_R) / ROAD_SEG + 0.9, ROAD_W, bx(a, LOOP_R), bz(a, LOOP_R), a, 0.1, 12);
    if (i % 2 === 0) {
      for (const side of [-1, 1]) {
        const r = LOOP_R + side * (ROAD_W / 2 - 0.5);
        sc('stripe', bx(a, r), 0.13, bz(a, r), a);
      }
    }
  }
  // Spurs from the three secondary gates down to the loop.
  for (const a of [Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const rMid = (HOARD_R + LOOP_R) / 2;
    ctx.floorQuad('road', 12, HOARD_R - LOOP_R + 6, bx(a, rMid), bz(a, rMid), a, 0.1, 12);
  }
  // Centre line up the approach, in the district's own sodium.
  for (let i = 0; i < 12; i++) ctx.box('emSodium', 0.32, 0.05, 2.4, 0, 0.14, 108 + i * 3.8);
  ctx.mmPath([[0, 152], [0, 88]], 'rgba(255,170,90,0.45)', ROAD_W, false);
  ctx.mmPath(
    Array.from({ length: 33 }, (_, i) => {
      const a = (i / 32) * Math.PI * 2;
      return [bx(a, LOOP_R), bz(a, LOOP_R)];
    }),
    'rgba(255,170,90,0.35)', ROAD_W, true
  );

  /* ---------------------------------------------------------------- */
  /* The hoarding line and its gates                                   */
  /* ---------------------------------------------------------------- */

  /**
   * 2.4 m of hoarding round the whole court, with four gates.
   *
   * Colliders are merged three panels at a time rather than one per panel: at
   * 4 m centres the ring is 168 panels, and a hundred and sixty-eight boxes in
   * the broadphase to describe one smooth circle is a bad trade when a 12 m
   * chord sits within 5 cm of the same circle.
   */
  const GATES = [
    { a: 0, half: 0.085, main: true },              // the way in from the plaza
    { a: Math.PI / 2, half: 0.058, main: false },
    { a: Math.PI, half: 0.058, main: false },
    { a: -Math.PI / 2, half: 0.058, main: false },
  ];
  const inGate = (a) => GATES.some((g) => {
    let d = a - g.a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d) < g.half;
  });

  const HOARD_N = 168;
  for (let i = 0; i < HOARD_N; i++) {
    const a = ((i + 0.5) / HOARD_N) * Math.PI * 2;
    if (inGate(a)) continue;
    const x = bx(a, HOARD_R), z = bz(a, HOARD_R);
    sc('hoard', x, 1.24, z, a);
    sc('hoardCap', x, 2.56, z, a);
    if (i % 4 === 0) sc('fencePost', x, 1.3, z, a, 1.6, 1.15, 1.6);
    if (i % 12 === 3) sc('beacon', x, 2.78, z, a);
  }
  for (let i = 1; i < HOARD_N; i += 3) {
    const a = ((i + 0.5) / HOARD_N) * Math.PI * 2;
    if (inGate(a - 0.03) || inGate(a) || inGate(a + 0.03)) continue;
    ctx.solid(bx(a, HOARD_R), 1.25, bz(a, HOARD_R), 6.2, 1.25, 0.12, a);
  }
  ctx.mmCircle(0, 0, HOARD_R, null, 'rgba(255,180,110,0.5)');

  // Gate frames: two posts and a header, with the leaf swung back and pinned
  // against the line. A shut gate on the only route into the zone reads as a
  // wall, however obviously it is a gate.
  for (const g of GATES) {
    const half = Math.sin(g.half) * HOARD_R;
    const H = g.main ? 6.6 : 4.2;
    const [gx, gz] = [bx(g.a, HOARD_R), bz(g.a, HOARD_R)];
    for (const s of [-1, 1]) {
      const [px, pz] = at(gx, gz, g.a, s * half, 0);
      ctx.box('panelDark', 0.9, H, 0.9, px, H / 2, pz, g.a);
      ctx.solid(px, H / 2, pz, 0.5, H / 2, 0.5, g.a);
      ctx.box('hazard', 1.1, 1.4, 1.1, px, 0.7, pz, g.a);
      const [lx2, lz2] = at(gx, gz, g.a, s * half, half * 0.45);
      ctx.box('grate', 0.14, H - 1.6, half * 0.9, lx2, (H - 1.6) / 2 + 0.4, lz2, g.a);
      const [cx2, cz2] = at(gx, gz, g.a, s * (half + 1.4), -3);
      sc('cone', cx2, 0.39, cz2, 0);
    }
    ctx.box('panelDark', half * 2 + 1.6, 1.0, 1.1, gx, H - 0.5, gz, g.a);
    ctx.box('emSodium', half * 2, 0.14, 0.22, gx, H - 1.15, gz, g.a);
  }

  /**
   * The site's own board, over the main gate.
   *
   * Cell 35 - SCAFFOLD ACCESS / CLIP ON ABOVE 2 M. Two-sided, because a player
   * walks out under it as often as in, and it is the only notice in the zone
   * that explains why everybody in it is dressed in orange.
   */
  ctx.sign(35, 9.2, 2.3, 0, 4.9, HOARD_R, 0, { twoSided: true, accent: 'emSodium' });

  /* ---------------------------------------------------------------- */
  /* Structural frames                                                 */
  /* ---------------------------------------------------------------- */

  /**
   * Columns on a bay grid with a ring of beams at every storey.
   *
   * This is the whole of tower 1 and the top of the other two, so it is worth
   * being one function: what distinguishes the three stages of build is what is
   * *hung on* the frame, not the frame itself, and sharing one generator is what
   * stops the bare tower and the topping-out tower looking like two unrelated
   * buildings on the same site.
   */
  const steelFrame = ({ cx, cz, w, d, nx, nz, from, to, storeyH, colW = 0.7 }) => {
    const dx = w / nx, dz = d / nz;
    for (let i = 0; i <= nx; i++) {
      for (let j = 0; j <= nz; j++) {
        const lx = cx - w / 2 + i * dx, lz = cz - d / 2 + j * dz;
        sc('column', lx, (from + to) / 2, lz, 0, colW / 0.7, (to - from) / 26, colW / 0.7);
        ctx.solid(lx, (from + to) / 2, lz, colW / 2 + 0.06, (to - from) / 2, colW / 2 + 0.06);
      }
    }
    const first = Math.ceil((from + 0.01) / storeyH);
    const last = Math.floor((to + 0.01) / storeyH);
    for (let f = first; f <= last; f++) {
      const y = f * storeyH;
      for (let j = 0; j <= nz; j++) sc('girder', cx, y - 0.45, cz - d / 2 + j * dz, 0, w / 12, 1, 1);
      for (let i = 0; i <= nx; i++) sc('girder', cx - w / 2 + i * dx, y - 0.45, cz, Math.PI / 2, d / 12, 1, 1);
      // Knee braces on the outer bays only, every other storey. A frame braced
      // everywhere reads as a lattice mast; one braced nowhere reads as a card
      // model, and the truth is that only some bays are.
      if (f % 2 === 0) {
        for (const s of [-1, 1]) {
          ctx.put('trim', boxGeo(Math.hypot(dz, storeyH), 0.22, 0.22, 1.6),
            cx + s * (w / 2), y - storeyH / 2, cz - d / 2 + dz * 0.5, Math.PI / 2, 0, Math.atan2(storeyH, dz));
          ctx.put('trim', boxGeo(Math.hypot(dx, storeyH), 0.22, 0.22, 1.6),
            cx - w / 2 + dx * 0.5, y - storeyH / 2, cz + s * (d / 2), 0, 0, -Math.atan2(storeyH, dx));
        }
      }
    }
  };

  /* Face descriptors: outward normal, and the yaw that lays a board along it. */
  const FACE = [
    { nx: 0, nz: 1, yaw: 0 },
    { nx: 0, nz: -1, yaw: 0 },
    { nx: 1, nz: 0, yaw: Math.PI / 2 },
    { nx: -1, nz: 0, yaw: Math.PI / 2 },
  ];

  /**
   * Tube-and-board scaffold wrapped round a rectangular tower.
   *
   * Two rows of standards - one against the face, one outside the boards -
   * because a scaffold with a single row has nothing holding the deck up on the
   * side you can see, which is the side that is always in frame. Every boarded
   * lift gets a ledger pair, boards, a toe board and two guard rails, which is
   * both what the regulations ask for and, more usefully, four different
   * horizontal line weights per level: that is what makes thirty metres of
   * repetition read as depth rather than as a texture.
   *
   * `access` names the face the stair tower lands on, and suppresses the outer
   * rail and toe board there. Without it the only route onto the scaffold is
   * through a handrail, and a player walking through geometry at 30 m is worse
   * than a scaffold that is missing one tube.
   *
   * @returns {Array} one deck rectangle per lift per side, tagged with the lift
   *   number and the index of the side within `sides`, so the population pass
   *   can spread people over every level instead of over every other one.
   */
  const scaffoldWrap = ({ cx, cz, w, d, from, lifts, sides = [0, 1, 2, 3], net = [], access = -1 }) => {
    const OUT = 1.75;           // outer standard line, measured off the face
    const DECK_W = 1.6;
    const hw = w / 2, hd = d / 2;
    const top = from + lifts * LIFT;
    const out = [];

    sides.forEach((si, sideIdx) => {
      const f = FACE[si];
      const faceOff = f.nx ? hw : hd;
      const mid = faceOff + OUT - DECK_W / 2;          // deck centreline
      const cxm = cx + f.nx * mid, czm = cz + f.nz * mid;
      // Sides 0/1 own the corners; 2/3 stop at the tower depth, so the boards
      // are never doubled at four places on every lift.
      const half = f.nx ? hd : hw + OUT;
      const hx = f.nx ? DECK_W / 2 : half;
      const hz = f.nx ? half : DECK_W / 2;
      const open = si === access;

      // Standards, inner and outer row, at 2.5 m centres.
      const posts = Math.max(2, Math.round((half * 2) / 2.5));
      for (let i = 0; i <= posts; i++) {
        const t = -half + (half * 2 * i) / posts;
        for (const row of [-DECK_W / 2 - 0.08, DECK_W / 2 + 0.08]) {
          const px = cxm + (f.nx ? row * f.nx : t);
          const pz = czm + (f.nx ? t : row * f.nz);
          sc('standard', px, from + (top - from) / 2 + 0.4, pz, 0, 1, (top - from + 0.8) / 26, 1);
        }
      }

      for (let k = 1; k <= lifts; k++) {
        const y = from + k * LIFT;
        const len = half * 2;
        sc('board', cxm, y - 0.06, czm, f.yaw, len / 8, 1, 1);
        for (const row of [-DECK_W / 2 - 0.08, DECK_W / 2 + 0.08]) {
          const px = cxm + (f.nx ? row * f.nx : 0);
          const pz = czm + (f.nx ? 0 : row * f.nz);
          sc('ledger', px, y - 0.18, pz, f.yaw, len / 8, 1, 1);
          if (!(open && row > 0)) sc('rail', px, y + 1.05, pz, f.yaw, len / 8, 1, 1);
        }
        if (!open) {
          sc('rail', cxm + f.nx * (DECK_W / 2 + 0.08), y + 0.55, czm + f.nz * (DECK_W / 2 + 0.08), f.yaw, len / 8, 1, 1);
          sc('toe', cxm + f.nx * (DECK_W / 2 + 0.02), y + 0.13, czm + f.nz * (DECK_W / 2 + 0.02), f.yaw, len / 8, 1, 1);
        }
        const rect = deck(cxm, y, czm, hx, hz);
        rect.lift = k;
        rect.sideIdx = sideIdx;
        out.push(rect);

        // Facade bracing, every other lift. Into the merged batch, not the
        // instanced kit: a diagonal needs a roll, and an instance cannot carry
        // one without disagreeing with `GeoBatch`'s rotation order.
        if (k % 2 === 0) {
          const run = Math.min(len, 6.5);
          ctx.put('trim', boxGeo(Math.hypot(run, LIFT * 2), 0.13, 0.13, 1.4),
            cxm + f.nx * (DECK_W / 2 + 0.1), y - LIFT, czm + f.nz * (DECK_W / 2 + 0.1),
            f.yaw, 0, Math.atan2(LIFT * 2, run) * (k % 4 === 0 ? 1 : -1));
        }
      }

      // Debris netting on the faces that want it. `M.grate` is opaque, so this
      // is a perforated sheet rather than a translucent net - which is what a
      // sheeted lift actually looks like from more than ten metres anyway.
      if (net.includes(si)) {
        for (let k = 2; k <= lifts; k += 3) {
          const y = from + k * LIFT;
          sc('netting', cxm + f.nx * (DECK_W / 2 + 0.14), y + 1.3, czm + f.nz * (DECK_W / 2 + 0.14), f.yaw, (half * 2) / 8, 1, 1);
        }
      }
    });
    return out;
  };

  /**
   * A scaffold stair tower: the only way up, and therefore the piece of this
   * zone with the most carefully chosen numbers in the file.
   *
   * Dog-leg flights with a landing at each lift, laid out so a flight and the
   * flight two above it share a footprint and never a metre of air: the landings
   * alternate ends, so the 2.4 m of clear headroom over a flight is the same at
   * the bottom of it as at the top.
   *
   * @returns {Array} the landing rectangles, indexed by lift - `[0]` is the
   *   ground, `[k]` is the landing at `k * LIFT`.
   */
  const stairTower = ({ x0, cz, width, lifts }) => {
    const LEN = 8.0;            // total footprint along X
    const LAND = 1.8;           // landing at each end
    const RUN = LEN - LAND * 2;
    const TREADS = 8;
    const rise = LIFT / TREADS;         // 0.325, comfortably under stepHeight
    const going = RUN / TREADS;         // 0.55
    const hw = width / 2;
    const landings = [];

    for (const ex of [x0 + 0.2, x0 + LEN - 0.2]) {
      for (const ez of [cz - hw, cz + hw]) {
        sc('standard', ex, (lifts * LIFT) / 2, ez, 0, 1.7, (lifts * LIFT) / 26, 1.7);
      }
    }

    landings.push(deck(x0 + LAND / 2, 0.12, cz, LAND / 2, hw));
    for (let k = 1; k <= lifts; k++) {
      const up = k % 2 === 1;                    // odd flights climb toward +X
      const base = (k - 1) * LIFT;
      for (let t = 0; t < TREADS; t++) {
        const y = base + (t + 1) * rise;
        const along = up ? x0 + LAND + going * (t + 0.5) : x0 + LEN - LAND - going * (t + 0.5);
        sc('tread', along, y - 0.05, cz, Math.PI / 2, width / 2.4, 1, going / 0.52);
        ctx.solid(along, y - 0.13, cz, going / 2 + 0.02, 0.13, hw);
      }
      const lx = up ? x0 + LEN - LAND / 2 : x0 + LAND / 2;
      landings.push(deck(lx, base + LIFT, cz, LAND / 2, hw));
      for (const s of [-1, 1]) {
        ctx.put('chrome', boxGeo(LEN, 0.07, 0.07, 1), x0 + LEN / 2, base + LIFT / 2 + 1.05, cz + s * hw);
        ctx.put('chrome', boxGeo(width, 0.07, 0.07, 1), lx, base + LIFT + 1.05, cz + s * hw, Math.PI / 2);
      }
    }
    return landings;
  };

  /* ---------------------------------------------------------------- */
  /* Tower 1 - a bare frame, and the one a player can climb            */
  /* ---------------------------------------------------------------- */

  /**
   * Nothing on this tower but steel and scaffold: no floors, no cladding, no
   * services. It is the first stage of the same building the other two are
   * further through, and it is deliberately the one nearest the main gate.
   *
   * It is also the climbable one. The stair goes all the way to a crash deck at
   * 31 m - the highest surface in the zone a player can stand on - and that is
   * where the prize collectable is. The whole argument for building a climb is
   * that the top of it has to be worth arriving at.
   */
  const T1_LIFTS = 12;
  const T1_TOP = T1_LIFTS * LIFT;
  steelFrame({
    cx: T1.cx, cz: T1.cz, w: T1.w, d: T1.d, nx: 4, nz: 4,
    from: 0, to: T1.storeys * T1.storeyH, storeyH: T1.storeyH, colW: 0.7,
  });
  const t1Decks = scaffoldWrap({
    cx: T1.cx, cz: T1.cz, w: T1.w, d: T1.d, from: 0, lifts: T1_LIFTS, net: [1, 3], access: 2,
  });

  /* Crash deck: a fully boarded platform right across the frame at the top of
   * the scaffold. Structurally it is what stops a dropped spanner reaching the
   * deck; in level terms it is the summit, and it has to be a *room* rather
   * than a ledge or the climb has no payoff. */
  ctx.box('panelWarm', T1.w + 1.2, 0.2, T1.d + 1.2, T1.cx, T1_TOP - 0.1, T1.cz);
  const t1Crash = deck(T1.cx, T1_TOP, T1.cz, T1.w / 2 + 0.6, T1.d / 2 + 0.6);
  FACE.forEach((f, i) => {
    if (i === 2) return;                      // the stair arrives on this side
    const off = (f.nx ? T1.w : T1.d) / 2 + 0.6;
    const span = (f.nx ? T1.d : T1.w) + 1.2;
    ctx.box('chrome', f.nx ? 0.08 : span, 0.08, f.nx ? span : 0.08,
      T1.cx + f.nx * off, T1_TOP + 1.05, T1.cz + f.nz * off);
    ctx.box('hazard', f.nx ? 0.06 : span, 0.3, f.nx ? span : 0.06,
      T1.cx + f.nx * off, T1_TOP + 0.15, T1.cz + f.nz * off);
  });

  /* The stair tower stands just clear of the east boarded lift, and its
   * even-numbered landings sit at the near end - 15 cm off the outer edge of
   * those boards, which the capsule crosses without noticing. That is why the
   * flights alternate the way they do and why the east face is the `access`
   * one: the whole climb is stair, landing, boards, stair. */
  const t1Stair = stairTower({ x0: T1.cx + T1.w / 2 + 1.9, cz: T1.cz, width: 2.8, lifts: T1_LIFTS });
  ctx.mmRect(T1.cx, T1.cz, T1.w + 4, T1.d + 4, 0, 'rgba(120,110,90,0.5)', 'rgba(255,190,120,0.7)');

  /* ---------------------------------------------------------------- */
  /* Tower 2 - floor plates in, cladding halfway up                    */
  /* ---------------------------------------------------------------- */

  /**
   * The middle stage. Clad and glazed to storey 6, a ragged half-storey above
   * that where the crew stopped at the end of the shift, and bare plates and
   * steel from there to 52 m.
   *
   * The clad section is one solid mass rather than a floor-by-floor model: it is
   * sealed, nobody gets into it, and a coarse box round a whole tower is both
   * better collision and about eight thousand fewer triangles than the honest
   * version would be.
   */
  const T2_CLAD = T2.cladTo * T2.storeyH;
  ctx.box('panel', T2.w, T2_CLAD, T2.d, T2.cx, T2_CLAD / 2, T2.cz);
  ctx.solid(T2.cx, T2_CLAD / 2, T2.cz, T2.w / 2 + 0.1, T2_CLAD / 2, T2.d / 2 + 0.1);
  for (let f = 1; f <= T2.cladTo; f++) {
    const y = f * T2.storeyH - T2.storeyH * 0.42;
    for (const face of FACE) {
      const off = (face.nx ? T2.w : T2.d) / 2 + 0.06;
      const span = (face.nx ? T2.d : T2.w) - 3.0;
      ctx.put('glassWindow', new THREE.PlaneGeometry(span, T2.storeyH * 0.5),
        T2.cx + face.nx * off, y, T2.cz + face.nz * off, Math.atan2(face.nx, face.nz));
      ctx.box('trim', face.nx ? 0.3 : span + 1.2, 0.2, face.nx ? span + 1.2 : 0.3,
        T2.cx + face.nx * off, f * T2.storeyH, T2.cz + face.nz * off);
    }
  }
  // The ragged edge: half a storey of cladding, stopped mid-run. A tower that
  // changes from clad to bare on a dead-level line reads as two objects.
  for (let i = 0; i < 5; i++) {
    ctx.box('panelTeal', 4.6, T2.storeyH * 0.9, 0.28,
      T2.cx - T2.w / 2 + 2.6 + i * 5.2, T2_CLAD + T2.storeyH * 0.45, T2.cz + T2.d / 2 + 0.16);
  }
  for (let i = 0; i < 3; i++) {
    ctx.box('panelTeal', 0.28, T2.storeyH * 0.9, 4.4,
      T2.cx - T2.w / 2 - 0.16, T2_CLAD + T2.storeyH * 0.45, T2.cz - T2.d / 2 + 2.6 + i * 5.0);
  }
  steelFrame({
    cx: T2.cx, cz: T2.cz, w: T2.w, d: T2.d, nx: 4, nz: 4,
    from: T2_CLAD, to: T2.storeys * T2.storeyH, storeyH: T2.storeyH, colW: 0.8,
  });
  const t2Plates = [];
  for (let f = T2.cladTo + 1; f <= T2.storeys; f++) {
    const y = f * T2.storeyH;
    ctx.box('panelDark', T2.w, 0.34, T2.d, T2.cx, y - 0.17, T2.cz);
    ctx.solid(T2.cx, y - 0.17, T2.cz, T2.w / 2, 0.17, T2.d / 2);
    t2Plates.push({ lx: T2.cx, lz: T2.cz, top: y, hx: T2.w / 2, hz: T2.d / 2, yaw: 0 });
    // Edge protection round the open plates. A stack of slabs with nothing on
    // the lip is the tell that a "building" is a stack of slabs.
    for (const face of FACE) {
      const off = (face.nx ? T2.w : T2.d) / 2;
      const span = face.nx ? T2.d : T2.w;
      ctx.box('hazard', face.nx ? 0.07 : span, 0.1, face.nx ? span : 0.07,
        T2.cx + face.nx * off, y + 1.05, T2.cz + face.nz * off);
    }
  }
  ctx.mmRect(T2.cx, T2.cz, T2.w, T2.d, 0, 'rgba(110,120,110,0.55)', 'rgba(200,240,255,0.6)');

  /* Mast climber up the east face: a powered platform on a rack mast, which is
   * how cladding actually gets to storey 12 and is a completely different
   * machine silhouette from the scaffold on the other side. */
  const T2_MAST_X = T2.cx + T2.w / 2 + 1.4;
  ctx.box('trim', 0.9, 34, 0.9, T2_MAST_X, 17, T2.cz + 4);
  for (let i = 0; i < 17; i++) ctx.box('trimDark', 1.4, 0.14, 0.16, T2_MAST_X, 1 + i * 2, T2.cz + 4);
  ctx.solid(T2_MAST_X, 17, T2.cz + 4, 0.5, 17, 0.5);
  ctx.box('grate', 2.6, 0.18, 9.0, T2_MAST_X + 0.9, 21.6, T2.cz + 4);
  for (const s of [-1, 1]) {
    ctx.box('hazard', 2.6, 1.0, 0.1, T2_MAST_X + 0.9, 22.2, T2.cz + 4 + s * 4.45);
  }
  const t2Climber = deck(T2_MAST_X + 0.9, 21.7, T2.cz + 4, 1.3, 4.5);

  const t2Decks = scaffoldWrap({
    cx: T2.cx, cz: T2.cz, w: T2.w, d: T2.d, from: 0, lifts: 12, sides: [1, 3], net: [1],
  });

  /* ---------------------------------------------------------------- */
  /* Tower 3 - topping out                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Nearly finished: clad, glazed and serviced to storey 12, with the top two
   * storeys still bare steel and a top-out scaffold banded round them.
   *
   * At 55 m this is the tallest thing on the site, and it stands on the far side
   * of the court from the gate - the end of the longest sightline the zone has.
   * A band of scaffold at 44-55 m with eight people working in it is the single
   * most legible "this place is being built" statement available, precisely
   * because it is the only bright, busy thing in that part of the frame.
   */
  const T3_CLAD = T3.cladTo * T3.storeyH;
  ctx.box('panel', T3.w, T3_CLAD, T3.d, T3.cx, T3_CLAD / 2, T3.cz);
  ctx.solid(T3.cx, T3_CLAD / 2, T3.cz, T3.w / 2 + 0.1, T3_CLAD / 2, T3.d / 2 + 0.1);
  for (let f = 1; f <= T3.cladTo; f++) {
    const y = f * T3.storeyH - T3.storeyH * 0.42;
    for (const face of FACE) {
      const off = (face.nx ? T3.w : T3.d) / 2 + 0.06;
      const span = (face.nx ? T3.d : T3.w) - 3.4;
      ctx.put('glassWindow', new THREE.PlaneGeometry(span, T3.storeyH * 0.52),
        T3.cx + face.nx * off, y, T3.cz + face.nz * off, Math.atan2(face.nx, face.nz));
      ctx.box('trim', face.nx ? 0.32 : span + 1.4, 0.22, face.nx ? span + 1.4 : 0.32,
        T3.cx + face.nx * off, f * T3.storeyH, T3.cz + face.nz * off);
    }
    if (f % 4 === 0) {
      ctx.box('emSodium', T3.w - 6, 0.12, 0.2, T3.cx, f * T3.storeyH - 0.4, T3.cz + T3.d / 2 + 0.2);
    }
  }
  steelFrame({
    cx: T3.cx, cz: T3.cz, w: T3.w, d: T3.d, nx: 5, nz: 4,
    from: T3_CLAD, to: T3.storeys * T3.storeyH, storeyH: T3.storeyH, colW: 0.75,
  });
  const t3Plates = [];
  for (let f = T3.cladTo + 1; f <= T3.storeys; f++) {
    const y = f * T3.storeyH;
    ctx.box('panelDark', T3.w, 0.34, T3.d, T3.cx, y - 0.17, T3.cz);
    ctx.solid(T3.cx, y - 0.17, T3.cz, T3.w / 2, 0.17, T3.d / 2);
    t3Plates.push({ lx: T3.cx, lz: T3.cz, top: y, hx: T3.w / 2, hz: T3.d / 2, yaw: 0 });
    for (const face of FACE) {
      const off = (face.nx ? T3.w : T3.d) / 2;
      const span = face.nx ? T3.d : T3.w;
      ctx.box('hazard', face.nx ? 0.07 : span, 0.1, face.nx ? span : 0.07,
        T3.cx + face.nx * off, y + 1.05, T3.cz + face.nz * off);
    }
  }
  const t3Decks = scaffoldWrap({
    cx: T3.cx, cz: T3.cz, w: T3.w, d: T3.d, from: T3_CLAD - LIFT, lifts: 4, net: [0, 2],
  });
  ctx.mmRect(T3.cx, T3.cz, T3.w, T3.d, 0, 'rgba(100,120,140,0.55)', 'rgba(200,240,255,0.6)');

  // Goods hoist and a rubbish chute down the north face - the two things a
  // finishing trade actually needs and the two that are always left off.
  ctx.box('trim', 1.6, T3_CLAD + 8, 1.6, T3.cx + 9, (T3_CLAD + 8) / 2, T3.cz + T3.d / 2 + 1.2);
  ctx.solid(T3.cx + 9, (T3_CLAD + 8) / 2, T3.cz + T3.d / 2 + 1.2, 0.9, (T3_CLAD + 8) / 2, 0.9);
  ctx.box('panelWarm', 2.4, 2.4, 2.2, T3.cx + 9, 12, T3.cz + T3.d / 2 + 1.2);
  for (let i = 0; i < 11; i++) {
    ctx.put('trimDark', cylGeo(0.62, 0.62, 3.6, 8, 1.6), T3.cx - 11, 3 + i * 3.6, T3.cz + T3.d / 2 + 1.4);
  }
  ctx.box('crate', 3.2, 2.0, 3.2, T3.cx - 11, 1.0, T3.cz + T3.d / 2 + 1.4);
  ctx.solid(T3.cx - 11, 1.0, T3.cz + T3.d / 2 + 1.4, 1.7, 1.0, 1.7);

  /* ---------------------------------------------------------------- */
  /* The tower crane                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * A saddle-jib tower crane, slewed so its jib runs out past tower 2.
   *
   * Everything about a crane that reads at distance is in the proportions: a
   * mast far thinner than people expect, a jib far longer than the mast is
   * tall, and a counter-jib a third of the jib with a block of counterweight on
   * the end of it. Get those three right and a hundred and eighty boxes make a
   * crane; get them wrong and ten thousand make a pylon.
   *
   * The load matters as much as the machine. An empty hook is a crane at rest,
   * which nobody watches; a bundle of beams twenty-six metres up with a banksman
   * underneath looking at it is an event. The hook is deliberately *beside*
   * tower 2 rather than over it - a load hanging inside a solid building is the
   * kind of mistake that only shows up from one angle, and then always.
   */
  const HOOK = [0, 0];
  {
    const MX = CRANE.x, MZ = CRANE.z, MH = CRANE.mast;
    const dx = CRANE.aim[0] - MX, dz = CRANE.aim[1] - MZ;
    const len = Math.hypot(dx, dz);
    // `cput` sends crane-local +X to zone (cos yaw, -sin yaw), so this is the
    // yaw that lays the jib along the aim vector.
    const yaw = Math.atan2(-dz / len, dx / len);
    /** Place a part in crane coordinates: +ax out along the jib, +az to its left. */
    const cput = (key, geo, ax, ay, az, rx = 0, rz = 0, ry = 0) => {
      const [x, z] = at(MX, MZ, yaw, ax, az);
      return ctx.put(key, geo, x, ay, z, yaw + ry, rx, rz);
    };

    // Base and mast. One collider for the whole mast: it is 3 m across and the
    // only question anybody asks of it is "can I walk through the crane".
    cput('panelDark', boxGeo(9, 1.6, 9, 3), 0, 0.8, 0);
    ctx.solid(MX, 0.8, MZ, 4.5, 0.8, 4.5, yaw);
    ctx.solid(MX, MH / 2, MZ, 1.5, MH / 2, 1.5, yaw);
    ctx.contact(MX, MZ, 26);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        cput('beam', boxGeo(0.3, MH - 1.6, 0.3, 3), sx * 1.15, 1.6 + (MH - 1.6) / 2, sz * 1.15);
      }
    }
    for (let i = 0; i < Math.floor((MH - 2) / 2.4); i++) {
      const y = 2.6 + i * 2.4;
      for (const s of [-1, 1]) {
        cput('trim', boxGeo(2.5, 0.16, 0.16, 1), 0, y, s * 1.15);
        cput('trim', boxGeo(2.5, 0.16, 0.16, 1), s * 1.15, y, 0, 0, 0, Math.PI / 2);
        cput('trim', boxGeo(Math.hypot(2.3, 2.4), 0.13, 0.13, 1), 0, y + 1.2, s * 1.15, 0, i % 2 ? 0.81 : -0.81);
      }
      if (i % 5 === 2) cput('emSodium', boxGeo(0.4, 0.16, 0.4, 1), 0, y, 1.35);
    }

    // Slewing ring, machinery deck and cab.
    const JY = MH + 1.6;
    cput('panelDark', cylGeo(1.9, 1.9, 1.4, 14, 2.4), 0, MH + 0.7, 0);
    cput('trimDark', boxGeo(4.4, 1.2, 4.4, 2), 0, MH + 1.9, 0);
    cput('panelWarm', boxGeo(2.4, 2.6, 2.4, 2), 3.3, MH + 0.4, 1.9);
    cput('glassWindow', new THREE.PlaneGeometry(2.2, 2.0), 4.52, MH + 0.5, 1.9, 0, 0, Math.PI / 2);
    cput('emWhite', boxGeo(1.8, 0.12, 0.2, 1), 3.3, MH + 1.6, 0.72);

    // A-frame apex and the pendant ties. The ties are what stop a jib reading
    // as a plank: they are the only diagonals in the silhouette.
    const APEX = JY + 8.5;
    for (const s of [-1, 1]) {
      cput('trim', boxGeo(0.34, 9.4, 0.34, 2), 0, (JY + APEX) / 2, s * 1.0, 0, s * 0.11);
    }
    cput('trim', boxGeo(2.4, 0.3, 0.3, 1), 0, APEX, 0, 0, 0, Math.PI / 2);
    for (const ax of [52, 30, -18, -9]) {
      const run = Math.abs(ax);
      cput('chrome', boxGeo(Math.hypot(run, APEX - JY - 0.6), 0.11, 0.11, 1),
        ax / 2, (JY + APEX) / 2, 0, 0, -Math.atan2(APEX - JY - 0.6, run) * Math.sign(ax));
    }

    // Jib: a triangular lattice, one top chord over two bottom chords.
    const JIB = 52;
    cput('beam', boxGeo(JIB, 0.34, 0.34, 3), JIB / 2 + 2, JY + 1.5, 0);
    for (const s of [-1, 1]) cput('beam', boxGeo(JIB, 0.3, 0.3, 3), JIB / 2 + 2, JY, s * 0.95);
    for (let i = 0; i < 17; i++) {
      const ax = 2.6 + i * 3.05;
      cput('trim', boxGeo(2.1, 0.12, 0.12, 1), ax, JY, 0, 0, 0, Math.PI / 2);
      for (const s of [-1, 1]) {
        cput('trim', boxGeo(Math.hypot(3.05, 1.5), 0.11, 0.11, 1), ax + 1.5, JY + 0.75, s * 0.95, 0, i % 2 ? 0.46 : -0.46);
      }
      if (i % 5 === 0) cput('emRed', boxGeo(0.28, 0.14, 0.28, 1), ax, JY + 1.75, 0);
    }
    // Counter-jib, machinery house and the counterweight blocks.
    cput('beam', boxGeo(20, 0.42, 2.6, 3), -11, JY + 0.4, 0);
    cput('grate', boxGeo(19, 0.16, 2.2, 2), -11, JY + 0.72, 0);
    cput('panelDark', boxGeo(4.4, 2.0, 2.6, 2), -6.5, JY + 1.7, 0);
    for (let i = 0; i < 4; i++) cput('trimDark', boxGeo(0.9, 3.0, 3.4, 2), -17.4 + i * 1.0, JY + 1.9, 0);
    cput('emSodium', boxGeo(3.4, 0.14, 0.3, 1), -19.6, JY + 0.6, 0);

    /* Trolley, rope and load, 34 m out and 30 m down. */
    const TROLLEY = 34, HOOK_Y = JY - 30;
    cput('panelDark', boxGeo(2.2, 1.0, 2.4, 2), TROLLEY, JY - 0.7, 0);
    cput('trimDark', cylGeo(0.07, 0.07, 29, 4, 3), TROLLEY, HOOK_Y + 15.2, 0);
    cput('trimDark', boxGeo(1.3, 1.1, 1.3, 1.2), TROLLEY, HOOK_Y + 0.6, 0);
    cput('chrome', boxGeo(0.34, 1.2, 0.34, 1), TROLLEY, HOOK_Y - 0.3, 0);
    for (const s of [-1, 1]) {
      cput('chrome', boxGeo(0.1, 2.4, 0.1, 1), TROLLEY + s * 0.9, HOOK_Y - 1.9, 0, 0, s * 0.36);
    }
    // Six universal beams in a bundle, strapped, hanging a couple of degrees off.
    for (let i = 0; i < 6; i++) {
      cput('beam', boxGeo(11, 0.42, 0.5, 2.4), TROLLEY, HOOK_Y - 3.1 + Math.floor(i / 3) * 0.45,
        -0.6 + (i % 3) * 0.6, 0, 0.035);
    }
    for (const s of [-1, 1]) cput('hazard', boxGeo(0.24, 1.1, 2.2, 1), TROLLEY + s * 3.4, HOOK_Y - 2.9, 0);

    const [hx2, hz2] = at(MX, MZ, yaw, TROLLEY, 0);
    HOOK[0] = hx2; HOOK[1] = hz2;
    const [tx2, tz2] = at(MX, MZ, yaw, JIB, 0);
    ctx.mmCircle(MX, MZ, 5, 'rgba(255,150,60,0.4)', 'rgba(255,200,120,0.8)');
    ctx.mmPath([[MX, MZ], [tx2, tz2]], 'rgba(255,190,120,0.4)', 3, false);
  }

  /* ---------------------------------------------------------------- */
  /* The crawler crane                                                 */
  /* ---------------------------------------------------------------- */

  /**
   * A lattice-boom crawler, flying a cladding cassette toward tower 3.
   *
   * It exists mostly to be the *other* kind of crane. A site with one machine
   * silhouette repeated reads as a kit; a fixed vertical mast next to a tracked
   * machine with a raked boom reads as two trades who needed different tools -
   * the same argument as the material palette, applied to plant.
   */
  {
    const CX = CRAWLER.x, CZ = CRAWLER.z;
    const dx = T3.cx - CX, dz = T3.cz - CZ;
    const len = Math.hypot(dx, dz);
    const yaw = Math.atan2(-dz / len, dx / len);
    const cput = (key, geo, ax, ay, az, rx = 0, rz = 0, ry = 0) => {
      const [x, z] = at(CX, CZ, yaw, ax, az);
      return ctx.put(key, geo, x, ay, z, yaw + ry, rx, rz);
    };
    for (const s of [-1, 1]) {
      cput('trimDark', boxGeo(9.0, 1.5, 1.9, 2), 0, 0.75, s * 2.3);
      cput('rubber', boxGeo(9.2, 1.0, 2.05, 1.4), 0, 0.7, s * 2.3);
    }
    cput('panelWarm', boxGeo(7.2, 3.0, 4.2, 2.4), -0.6, 3.0, 0);
    cput('trimDark', boxGeo(2.4, 2.6, 3.2, 2), -4.2, 3.2, 0);
    cput('glassWindow', new THREE.PlaneGeometry(2.6, 1.8), 3.05, 3.4, 1.4, 0, 0, Math.PI / 2);
    cput('hazard', boxGeo(7.4, 0.3, 4.4, 1.6), -0.6, 4.6, 0);
    ctx.solid(CX, 2.4, CZ, 5.0, 2.4, 3.4, yaw);
    ctx.contact(CX, CZ, 24);

    // Lattice boom, raked at 58 degrees.
    const PITCH = 1.01, BOOM = 42, bx0 = 2.6, by0 = 4.4;
    for (const s of [-1, 1]) {
      cput('beam', boxGeo(BOOM, 0.26, 0.26, 3),
        bx0 + Math.cos(PITCH) * BOOM / 2, by0 + Math.sin(PITCH) * BOOM / 2, s * 0.85, 0, PITCH);
    }
    cput('beam', boxGeo(BOOM, 0.26, 0.26, 3),
      bx0 + Math.cos(PITCH) * BOOM / 2 - 0.7, by0 + Math.sin(PITCH) * BOOM / 2 + 0.5, 0, 0, PITCH);
    for (let i = 0; i < 14; i++) {
      const t = (i + 0.5) / 14;
      const ax = bx0 + Math.cos(PITCH) * BOOM * t;
      const ay = by0 + Math.sin(PITCH) * BOOM * t;
      cput('trim', boxGeo(1.9, 0.1, 0.1, 1), ax, ay, 0, 0, 0, Math.PI / 2);
      for (const s of [-1, 1]) {
        cput('trim', boxGeo(3.4, 0.09, 0.09, 1), ax, ay + 0.25, s * 0.85, 0, i % 2 ? PITCH + 1.1 : PITCH - 1.1);
      }
    }
    const hx = bx0 + Math.cos(PITCH) * BOOM, hy = by0 + Math.sin(PITCH) * BOOM;
    cput('trimDark', boxGeo(1.4, 1.0, 1.8, 1.4), hx, hy, 0);
    cput('trimDark', cylGeo(0.06, 0.06, 21, 4, 3), hx, hy - 10.5, 0);
    cput('trimDark', boxGeo(1.0, 0.9, 1.0, 1.2), hx, hy - 21.4, 0);
    // The load: a glazed cladding cassette on a spreader beam.
    cput('trim', boxGeo(5.4, 0.24, 0.24, 1), hx, hy - 22.4, 0);
    cput('panelTeal', boxGeo(5.0, 3.4, 0.24, 2), hx, hy - 24.4, 0, 0, 0.04);
    cput('glassWindow', new THREE.PlaneGeometry(4.2, 2.4), hx, hy - 24.4, 0.16, 0, 0);
    for (const s of [-1, 1]) cput('chrome', boxGeo(0.07, 1.9, 0.07, 1), hx + s * 2.4, hy - 23.3, 0, 0, s * 0.12);
    // Boom-hoist pendants back to the gantry, so the boom has something holding it.
    cput('trimDark', boxGeo(Math.hypot(BOOM * 0.7, 7), 0.09, 0.09, 1),
      bx0 + Math.cos(PITCH) * BOOM * 0.35 - 2.2, by0 + Math.sin(PITCH) * BOOM * 0.35 + 3.5, 0, 0, 0.62);
    ctx.mmRect(CX, CZ, 10, 6, yaw, 'rgba(190,140,60,0.5)', 'rgba(255,210,140,0.6)');
  }

  /* ---------------------------------------------------------------- */
  /* Plant and vehicles                                                */
  /* ---------------------------------------------------------------- */

  /**
   * The vehicle kit. All of it goes into the merged batch rather than the
   * instanced kit: there are a dozen machines on this site and no two are the
   * same object, so instancing would buy nothing and cost the ability to give
   * each one a different arrangement of the same parts.
   *
   * Every machine is authored with its length along its own local Z, so `at()`
   * places the parts and one yaw orients the whole thing.
   */
  const wheels = (lx, lz, yaw, offs, r, halfTrack) => {
    for (const a of offs) {
      for (const s of [-1, 1]) {
        const [wx, wz] = at(lx, lz, yaw, s * halfTrack, a);
        // Axle across the machine, so the quarter turn is about Z, not X.
        ctx.put('rubber', cylGeo(r, r, 0.62, 10, 1.4).rotateZ(Math.PI / 2), wx, r, wz, yaw);
      }
    }
  };

  const flatbed = (lx, lz, yaw, load) => {
    const p = (dx, dz) => at(lx, lz, yaw, dx, dz);
    ctx.put('trimDark', boxGeo(2.6, 0.7, 11.5, 2), lx, 0.95, lz, yaw);
    const [cx2, cz2] = p(0, 3.4);
    ctx.put('panelWarm', boxGeo(2.9, 2.4, 3.4, 2.2), cx2, 2.3, cz2, yaw);
    const [wx2, wz2] = p(0, 5.12);
    ctx.put('glassWindow', new THREE.PlaneGeometry(2.3, 1.2), wx2, 2.9, wz2, yaw);
    const [bx2, bz2] = p(0, -1.2);
    ctx.put('grate', boxGeo(2.7, 0.16, 8.6, 2), bx2, 1.4, bz2, yaw);
    ctx.put('hazard', boxGeo(2.8, 0.36, 0.24, 1), bx2, 1.5, bz2, yaw);
    if (load === 'steel') {
      for (let i = 0; i < 3; i++) {
        const [sx2, sz2] = p((i - 1) * 0.8, -1.6);
        ctx.put('beam', boxGeo(1.6, 0.55, 8.2, 2.4), sx2, 1.78, sz2, yaw);
      }
      const [hx2, hz2] = p(0, 1.4);
      ctx.put('hazard', boxGeo(2.6, 0.12, 0.12, 1), hx2, 2.1, hz2, yaw);
    } else {
      for (let i = 0; i < 5; i++) {
        const [px2, pz2] = p(-1.0 + (i % 3) * 1.0, -1.4);
        ctx.put('trim', cylGeo(0.42, 0.42, 8.0, 8, 2).rotateX(Math.PI / 2),
          px2, 1.86 + Math.floor(i / 3) * 0.8, pz2, yaw);
      }
    }
    wheels(lx, lz, yaw, [3.9, -2.2, -3.6], 0.66, 1.35);
    ctx.solid(lx, 1.4, lz, 1.55, 1.4, 5.9, yaw);
    ctx.contact(lx, lz, 18);
    ctx.mmRect(lx, lz, 3.2, 12, yaw, 'rgba(150,130,90,0.5)', null);
  };

  const dumper = (lx, lz, yaw) => {
    const p = (dx, dz) => at(lx, lz, yaw, dx, dz);
    ctx.put('trimDark', boxGeo(3.0, 0.9, 9.0, 2), lx, 1.2, lz, yaw);
    const [cx2, cz2] = p(0, 2.6);
    ctx.put('panelWarm', boxGeo(3.2, 2.6, 3.6, 2.4), cx2, 2.4, cz2, yaw);
    const [wx2, wz2] = p(0, 4.4);
    ctx.put('glassWindow', new THREE.PlaneGeometry(2.4, 1.3), wx2, 3.1, wz2, yaw);
    // Skip raised a few degrees: a level body reads as a lorry, a tipped one
    // reads as a machine that has just done something.
    const [sx2, sz2] = p(0, -2.6);
    ctx.put('panelRust', boxGeo(3.6, 2.2, 6.6, 2.6), sx2, 3.3, sz2, yaw, 0.09);
    const [tx2, tz2] = p(0, -5.6);
    ctx.put('hazard', boxGeo(3.7, 0.3, 0.3, 1), tx2, 4.2, tz2, yaw);
    wheels(lx, lz, yaw, [3.0, -1.6, -3.6], 1.05, 1.7);
    ctx.solid(lx, 2.0, lz, 1.9, 2.0, 5.6, yaw);
    ctx.contact(lx, lz, 20);
  };

  const telehandler = (lx, lz, yaw) => {
    const p = (dx, dz) => at(lx, lz, yaw, dx, dz);
    ctx.put('panelWarm', boxGeo(2.4, 1.9, 5.4, 2.2), lx, 1.5, lz, yaw);
    const [cx2, cz2] = p(-1.0, 1.2);
    ctx.put('trimDark', boxGeo(1.9, 1.9, 2.0, 2), cx2, 2.6, cz2, yaw);
    const [wx2, wz2] = p(-1.96, 1.2);
    ctx.put('glassWindow', new THREE.PlaneGeometry(1.7, 1.5), wx2, 2.7, wz2, yaw - Math.PI / 2);
    // Telescopic boom, part-extended and raked up at 26 degrees.
    const [b1x, b1z] = p(0.7, 1.6);
    ctx.put('panelDark', boxGeo(1.0, 0.9, 7.0, 2), b1x, 3.3, b1z, yaw, -0.45);
    const [b2x, b2z] = p(0.7, 5.4);
    ctx.put('trim', boxGeo(0.8, 0.7, 5.0, 2), b2x, 5.0, b2z, yaw, -0.45);
    const [fx2, fz2] = p(0.7, 7.6);
    ctx.put('trimDark', boxGeo(1.3, 0.9, 0.3, 1.2), fx2, 6.3, fz2, yaw);
    for (const s of [-1, 1]) {
      const [tx2, tz2] = p(0.7 + s * 0.45, 8.3);
      ctx.put('trim', boxGeo(0.16, 0.14, 1.4, 1), tx2, 5.9, tz2, yaw);
    }
    const [lx2, lz2] = p(0.7, 8.4);
    sc('pallet', lx2, 6.0, lz2, yaw);
    sc('pack', lx2, 6.4, lz2, yaw);
    wheels(lx, lz, yaw, [1.8, -1.9], 0.78, 1.15);
    ctx.solid(lx, 1.6, lz, 1.4, 1.6, 3.0, yaw);
    ctx.contact(lx, lz, 14);
  };

  const mixer = (lx, lz, yaw) => {
    const p = (dx, dz) => at(lx, lz, yaw, dx, dz);
    ctx.put('trimDark', boxGeo(2.7, 0.8, 10.0, 2), lx, 1.1, lz, yaw);
    const [cx2, cz2] = p(0, 3.6);
    ctx.put('panelWarm', boxGeo(2.9, 2.5, 3.2, 2.2), cx2, 2.4, cz2, yaw);
    // The drum is the whole silhouette: a fat cylinder raked 15 degrees, with a
    // tapering nose, and nothing else on this site is round.
    const [dx2, dz2] = p(0, -0.4);
    ctx.put('panelTeal', cylGeo(1.55, 1.85, 5.4, 14, 2.6), dx2, 3.2, dz2, yaw, Math.PI / 2 - 0.26, 0);
    const [nx2, nz2] = p(0, -3.6);
    ctx.put('trim', cylGeo(0.7, 1.5, 1.6, 12, 2), nx2, 4.0, nz2, yaw, Math.PI / 2 - 0.26, 0);
    // Chute, swung out to one side and dropping to the pour.
    const [ch1, ch2] = p(1.2, -5.6);
    ctx.put('grate', boxGeo(0.9, 0.3, 3.4, 1.4), ch1, 2.0, ch2, yaw + 0.7, 0.5);
    wheels(lx, lz, yaw, [3.4, -2.0, -3.4], 0.7, 1.3);
    ctx.solid(lx, 2.2, lz, 1.6, 2.2, 5.2, yaw);
    ctx.contact(lx, lz, 18);
  };

  const bowser = (lx, lz, yaw, key) => {
    const p = (dx, dz) => at(lx, lz, yaw, dx, dz);
    ctx.put('trimDark', boxGeo(2.2, 0.5, 4.6, 2), lx, 0.4, lz, yaw);
    ctx.put(key, cylGeo(1.05, 1.05, 4.2, 14, 2.2), lx, 1.6, lz, yaw, Math.PI / 2, 0);
    const [dx2, dz2] = p(1.2, 0);
    ctx.put('panelDark', boxGeo(0.9, 1.0, 0.7, 1.2), dx2, 1.0, dz2, yaw);
    ctx.put('rubber', cylGeo(0.06, 0.06, 2.2, 5, 1.6), dx2, 0.7, dz2, yaw, 0, 1.3);
    const [hx2, hz2] = p(0, 2.16);
    ctx.put('hazard', boxGeo(1.4, 0.6, 0.1, 1), hx2, 1.6, hz2, yaw);
    ctx.solid(lx, 1.4, lz, 1.2, 1.4, 2.4, yaw);
    ctx.contact(lx, lz, 9);
  };

  const genset = (lx, lz, yaw) => {
    const p = (dx, dz) => at(lx, lz, yaw, dx, dz);
    ctx.put('panelTeal', boxGeo(3.0, 2.4, 7.0, 2.4), lx, 1.4, lz, yaw);
    ctx.put('trimDark', boxGeo(3.2, 0.3, 7.2, 2), lx, 0.15, lz, yaw);
    const [gx2, gz2] = p(0, -2.3);
    ctx.put('grate', boxGeo(3.05, 1.2, 2.0, 1.6), gx2, 1.5, gz2, yaw);
    const [ex2, ez2] = p(1.2, 0);
    ctx.put('trim', cylGeo(0.24, 0.24, 3.2, 8, 2), ex2, 4.0, ez2, yaw);
    const [lx2, lz2] = p(0, 3.55);
    ctx.put('emSodium', boxGeo(0.5, 0.14, 0.2, 1), lx2, 2.7, lz2, yaw);
    for (let i = 0; i < 3; i++) {
      const [cx2, cz2] = p(-(1.7 + i * 0.24), -1.0);
      ctx.put('rubber', cylGeo(0.09, 0.09, 5.5, 5, 2).rotateX(Math.PI / 2), cx2, 0.1, cz2, yaw);
    }
    ctx.solid(lx, 1.4, lz, 1.6, 1.4, 3.6, yaw);
    ctx.contact(lx, lz, 14);
  };

  /**
   * A site cabin, and the stacks they build.
   *
   * The cabins are the only orthodox architecture in the zone and they are doing
   * a job the towers cannot: giving the eye something at 3 m with doors and
   * windows in it, so there is a human-scale reference against which a 55 m
   * frame reads as 55 m rather than just as "tall".
   *
   * @returns {number} the top of the cabin, for stacking or for a roof deck.
   */
  const cabin = (ox, oz, yaw, lx, ly, lz, w = 8.4, d = 3.2, key = 'panelWarm') => {
    const H = 2.9;
    const p = (dx, dz) => at(ox, oz, yaw, lx + dx, lz + dz);
    const [x, z] = p(0, 0);
    ctx.put(key, boxGeo(w, H, d, 2), x, ly + H / 2, z, yaw);
    ctx.put('trimDark', boxGeo(w + 0.3, 0.24, d + 0.3, 1.6), x, ly + H + 0.1, z, yaw);
    ctx.put('trimDark', boxGeo(w + 0.3, 0.22, d + 0.3, 1.6), x, ly + 0.1, z, yaw);
    for (let i = 0; i < 3; i++) {
      const [wx, wz] = p(-w / 2 + 1.9 + i * 2.3, d / 2 + 0.02);
      ctx.put('glassWindow', new THREE.PlaneGeometry(1.7, 1.0), wx, ly + 1.85, wz, yaw);
    }
    const [dx2, dz2] = p(w / 2 - 1.2, d / 2 + 0.07);
    ctx.put('panelDark', boxGeo(1.0, 2.1, 0.12, 1.2), dx2, ly + 1.05, dz2, yaw);
    ctx.put('emWhite', boxGeo(1.3, 0.1, 0.2, 1), dx2, ly + 2.35, dz2, yaw);
    ctx.solid(x, ly + H / 2, z, w / 2, H / 2 + 0.15, d / 2, yaw);
    return ly + H + 0.22;
  };

  /* ---------------------------------------------------------------- */
  /* The compound, outside the hoarding by the main gate               */
  /* ---------------------------------------------------------------- */

  /**
   * Offices, welfare and the muster point, in the arcade either side of the
   * approach. This is where a player arrives, so it is deliberately the most
   * *populated* part of the zone rather than the most detailed - the towers can
   * carry the spectacle, the compound has to carry the sense that people work
   * here and then go home.
   */
  const OFFICE = { x: -34, z: 132, yaw: -0.14 };
  const WELFARE = { x: 36, z: 128, yaw: 0.2 };
  let officeBalcony;
  {
    const { x, z, yaw } = OFFICE;
    for (let i = 0; i < 3; i++) cabin(x, z, yaw, 0, 0, (i - 1) * 3.6, 8.4, 3.2, 'panelWarm');
    for (let i = 0; i < 2; i++) cabin(x, z, yaw, 0, 3.12, (i - 0.5) * 3.6, 8.4, 3.2, 'panelTeal');
    // Balcony walkway along the front of the upper tier, with the stair to it.
    const [wx, wz] = at(x, z, yaw, 0, 3.2);
    ctx.put('grate', boxGeo(9.6, 0.18, 1.8, 1.6), wx, 3.05, wz, yaw);
    officeBalcony = deck(wx, 3.14, wz, 4.8, 0.9, yaw);
    for (const s of [-1, 1]) {
      const [rx2, rz2] = at(x, z, yaw, 0, 3.2 + s * 0.85);
      ctx.put('chrome', boxGeo(9.6, 0.07, 0.07, 1), rx2, 4.2, rz2, yaw);
    }
    stairRun(x, z, yaw, 3.6, -2.2, 8);
    // Roof kit. The roof itself is *not* published as reachable - there is no
    // second flight up to it, and a roof a player cannot stand on is a spot the
    // relic placer would eventually put something on that nobody can collect.
    const [rfx, rfz] = at(x, z, yaw, 0, 0);
    ctx.put('panelDark', boxGeo(9.0, 0.24, 11.4, 2), rfx, 6.24, rfz, yaw);
    const [px2, pz2] = at(x, z, yaw, -2.0, 3.0);
    ctx.put('panelDark', boxGeo(2.2, 1.1, 1.8, 1.6), px2, 6.9, pz2, yaw);
    const [ax2, az2] = at(x, z, yaw, 3.0, -3.4);
    ctx.put('trim', cylGeo(0.09, 0.14, 4.4, 6, 2), ax2, 8.5, az2, yaw);
    ctx.put('emRed', new THREE.SphereGeometry(0.18, 8, 6), ax2, 10.8, az2, yaw);
    ctx.contact(x, z, 26);
    ctx.mmRect(x, z, 9.6, 11.5, yaw, 'rgba(150,140,110,0.6)', 'rgba(255,220,160,0.6)');
  }
  {
    const { x, z, yaw } = WELFARE;
    cabin(x, z, yaw, 0, 0, 0, 10.4, 3.6, 'panelWarm');
    cabin(x, z, yaw, 0, 0, -4.4, 10.4, 3.6, 'panelTeal');
    cabin(x, z, yaw + Math.PI / 2, -7.2, 0, -2.2, 6.4, 3.0, 'panelRust');
    cabin(x, z, yaw, 0, 3.12, -2.2, 10.4, 3.6, 'panelWarm');
    const [rx2, rz2] = at(x, z, yaw, 0, -2.2);
    ctx.put('panelDark', boxGeo(11.0, 0.24, 4.2, 2), rx2, 6.24, rz2, yaw);
    ctx.put('trim', cylGeo(0.08, 0.12, 3.0, 6, 2), rx2 + 3, 7.8, rz2, yaw);
    // Benches outside the canteen cabin, and a rack of hard hats by the door.
    for (let i = 0; i < 3; i++) {
      const [bx2, bz2] = at(x, z, yaw, -2.6 + i * 2.6, 3.6);
      ctx.put('panelWarm', boxGeo(2.2, 0.16, 0.55, 1.2), bx2, 0.48, bz2, yaw);
      for (const s of [-1, 1]) {
        const [lx3, lz3] = at(x, z, yaw, -2.6 + i * 2.6 + s * 0.9, 3.6);
        ctx.put('trimDark', boxGeo(0.14, 0.46, 0.5, 1), lx3, 0.24, lz3, yaw);
      }
      ctx.solid(bx2, 0.42, bz2, 1.1, 0.24, 0.32, yaw);
    }
    ctx.contact(x, z, 28);
    ctx.mmRect(x, z - 2, 11, 12, yaw, 'rgba(150,140,110,0.6)', 'rgba(255,220,160,0.6)');
  }

  /* Muster point: a painted square, a board and a head-count post. Every site
   * has one and every site's is empty, which is exactly why it earns its place -
   * it is a piece of the fiction that costs four boxes. Sited clear of the
   * arrival plaza rectangle, which belongs to the zone shell, not to this. */
  ctx.floorQuad('plaza', 14, 14, 30, 148, 0, 0.11, 6);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    ctx.box('emGreen', 13.6, 0.08, 0.4, 30 + bx(a, 6.8), 0.15, 148 + bz(a, 6.8), a);
  }
  ctx.box('panelDark', 0.6, 3.4, 0.6, 30, 1.7, 154);
  ctx.solid(30, 1.7, 154, 0.35, 1.7, 0.35);
  ctx.sign(23, 3.6, 1.5, 30, 3.9, 154, 0, { twoSided: true, accent: 'emGreen' });

  /* ---------------------------------------------------------------- */
  /* Laydown, plant compound and spoil - the arcade band               */
  /* ---------------------------------------------------------------- */

  /**
   * Everything a site consumes, arranged in bays round the outside of the
   * hoarding.
   *
   * The scatter is rejected against `ctx.onDeck` rather than against its own
   * arithmetic, because the arcade band is the one place in a zone where a
   * sloppy radius puts a pallet of cladding in vacuum - and against the arrival
   * plaza rectangle, because the one thing a player must never arrive to is a
   * stack of steel where the concourse should be.
   */
  const clearOfPlaza = (lx, lz) => !(lx > -30 && lx < 30 && lz > 146);
  const yardSpot = (a0, a1, r0, r1, pad = 6) => {
    for (let tries = 0; tries < 24; tries++) {
      const a = rnd(a0, a1), r = rnd(r0, r1);
      const lx = bx(a, r), lz = bz(a, r);
      if (!ctx.onDeck(lx, lz, pad) || !clearOfPlaza(lx, lz)) continue;
      return [lx, lz, a];
    }
    return null;
  };

  // Steel stacks on timber bearers, in ranks - the one place on the site where
  // repetition is the point, because a laydown yard is a filing system.
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 4; col++) {
      const a = 0.42 + col * 0.13, r = 122 + row * 9;
      const lx = bx(a, r), lz = bz(a, r);
      if (!ctx.onDeck(lx, lz, 8) || !clearOfPlaza(lx, lz)) continue;
      const n = 1 + Math.floor(rng() * 3);
      for (let s = 0; s < n; s++) sc('steel', lx, 0.5 + s * 0.95, lz, a + rnd(-0.05, 0.05));
      ctx.solid(lx, (n * 0.95) / 2, lz, 4.6, (n * 0.95) / 2, 0.8, a);
      if (row % 2 === 0) ctx.contact(lx, lz, 12);
    }
  }
  for (let i = 0; i < 26; i++) {
    const spot = yardSpot(4.25, 5.05, 120, 168, 7);
    if (!spot) continue;
    const [lx, lz, a] = spot;
    const yaw = a + rnd(-0.2, 0.2);
    sc('pallet', lx, 0.08, lz, yaw);
    const n = 1 + Math.floor(rng() * 3);
    for (let s = 0; s < n; s++) sc('pack', lx, 0.46 + s * 0.64, lz, yaw + rnd(-0.03, 0.03));
    ctx.solid(lx, (0.15 + n * 0.64) / 2, lz, 0.75, (0.15 + n * 0.64) / 2, 0.62, yaw);
    ctx.contact(lx, lz, 4);
  }
  for (let i = 0; i < 20; i++) {
    const spot = yardSpot(0.95, 1.55, 118, 158, 7);
    if (!spot) continue;
    const [lx, lz, a] = spot;
    const yaw = a + rnd(-0.3, 0.3);
    for (let s = 0; s < 3; s++) sc('rebar', lx, 0.32 + s * 0.55, lz + (s % 2) * 0.2, yaw);
    ctx.solid(lx, 0.7, lz, 3.3, 0.7, 0.5, yaw);
  }
  for (let i = 0; i < 14; i++) {
    const spot = yardSpot(4.3, 5.0, 128, 166, 7);
    if (!spot) continue;
    const [lx, lz, a] = spot;
    const yaw = a + rnd(-0.5, 0.5);
    sc('drum', lx, 0.92, lz, yaw);
    sc('drumCable', lx, 0.92, lz, yaw);
    ctx.solid(lx, 0.9, lz, 0.7, 0.9, 0.95, yaw);
    ctx.contact(lx, lz, 4);
  }

  const SPOIL = [];
  for (let i = 0; i < 7; i++) {
    const spot = yardSpot(2.95, 3.85, 124, 168, 14);
    if (!spot) continue;
    const [lx, lz] = spot;
    const h = rnd(3.2, 6.2), r = h * rnd(1.9, 2.6);
    sc('spoil', lx, h / 2, lz, rng() * 3, r, h, r);
    /* A cone collided as a box at 70% of its radius: the capsule then walks up
     * the flank instead of stopping dead against a vertical wall of dirt, which
     * is the difference between a heap and a bollard. */
    ctx.solid(lx, h / 2 - 0.4, lz, r * 0.7, h / 2, r * 0.7);
    ctx.contact(lx, lz, r * 2.6);
    ctx.mmCircle(lx, lz, r, 'rgba(120,90,70,0.5)', null);
    SPOIL.push({ lx, lz, h, r });
  }
  /* One heap gets a haul ramp, which is the cheapest extra vertical route on
   * the map: a spoil heap is already a slope, it just needs a collider that
   * agrees with it. `_ramp` tilts its local +Z end UP, so the yaw has to point
   * local +Z at the summit - backwards builds a ramp that descends into the
   * thing it is meant to climb. */
  let spoilTop = null;
  if (SPOIL.length) {
    const s0 = SPOIL.reduce((a, b) => (b.h > a.h ? b : a));
    const d = Math.hypot(s0.lx, s0.lz) || 1;
    const run = s0.r + 7;
    const fx = s0.lx * (1 + run / d), fz = s0.lz * (1 + run / d);
    const rise = s0.h * 0.8;
    const pitch = Math.atan2(rise, run);
    const yaw = Math.atan2(s0.lx - fx, s0.lz - fz);
    ctx.ramp((fx + s0.lx) / 2, rise / 2 - 0.25 / Math.cos(pitch), (fz + s0.lz) / 2, 6, run, rise, yaw);
    ctx.put('road', boxGeo(6, 0.3, run + 0.4, 2), (fx + s0.lx) / 2, rise / 2, (fz + s0.lz) / 2, yaw, -pitch);
    deck(s0.lx, rise, s0.lz, 2.4, 2.4);
    spoilTop = { lx: s0.lx, lz: s0.lz, top: rise, hx: 2.4, hz: 2.4, yaw: 0 };
  }

  genset(bx(1.75, 138), bz(1.75, 138), 1.75);
  genset(bx(1.9, 146), bz(1.9, 146), 1.9);
  bowser(bx(1.62, 148), bz(1.62, 148), 1.62, 'panelRust');
  bowser(bx(1.7, 154), bz(1.7, 154), 1.7, 'panelTeal');
  telehandler(bx(1.35, 128), bz(1.35, 128), 1.35 + 1.2);
  dumper(bx(3.35, 122), bz(3.35, 122), 3.35 + 0.4);
  flatbed(bx(0.62, 132), bz(0.62, 132), 0.62 + 1.55, 'steel');
  flatbed(bx(5.35, 134), bz(5.35, 134), 5.35 - 1.55, 'pipe');
  flatbed(14, 122, 0.06, 'steel');
  mixer(30, -34, 0.9);
  dumper(bx(0.35, LOOP_R), bz(0.35, LOOP_R), 0.35 + 1.6);
  telehandler(-30, 66, 2.4);
  bowser(-16, 96, 0.5, 'panelRust');

  /**
   * The batching plant.
   *
   * Twenty-two metres of silo, aggregate bins and a mixing house in the arcade
   * band, which is five metres under the ceiling plate and about as tall as
   * anything this side of the hoarding is allowed to be. It is out here rather
   * than in the court for two reasons: it is the one piece of the site that
   * will still be running when the towers are finished, and a fat vertical mass
   * gives the arcade something to be about other than storage.
   *
   * Its access stair runs the full 12 m to the gantry, so this is the second
   * climb in the zone and the one a player finds without being told.
   */
  const BP = { x: bx(2.42, 142), z: bz(2.42, 142), yaw: 2.42 };
  let bpGantry;
  {
    const { x, z, yaw } = BP;
    const H = 22;
    for (let i = 0; i < 3; i++) {
      const [sx2, sz2] = at(x, z, yaw, (i - 1) * 6.2, 0);
      ctx.put('shell', cylGeo(2.5, 2.5, H - 7, 16, 3.2), sx2, 7 + (H - 7) / 2, sz2);
      ctx.put('panelDark', cylGeo(2.5, 1.1, 3.4, 16, 2.6), sx2, 5.4, sz2);
      ctx.put('trim', cylGeo(2.7, 2.7, 0.5, 16, 1.6), sx2, H - 1.4, sz2);
      ctx.put('panelDark', cylGeo(1.4, 2.0, 1.8, 14, 2), sx2, H + 0.6, sz2);
      for (const s of [-1, 1]) {
        const [lx3, lz3] = at(x, z, yaw, (i - 1) * 6.2, s * 2.2);
        ctx.put('trim', boxGeo(0.34, 4.4, 0.34, 2), lx3, 2.2, lz3);
      }
      ctx.solid(sx2, H / 2, sz2, 2.7, H / 2, 2.7);
    }
    // Aggregate bins, conveyor and the mixing house.
    const [bnx, bnz] = at(x, z, yaw, 0, -8.4);
    ctx.put('panelRust', boxGeo(18, 4.6, 6.0, 3), bnx, 2.5, bnz, yaw);
    ctx.solid(bnx, 2.5, bnz, 9, 2.5, 3.0, yaw);
    for (let i = 0; i < 4; i++) {
      const [dvx, dvz] = at(x, z, yaw, -9 + i * 6, -8.4);
      ctx.put('hazard', boxGeo(0.24, 4.7, 6.1, 1.4), dvx, 2.5, dvz, yaw);
    }
    const [cvx, cvz] = at(x, z, yaw, 0, -6.0);
    ctx.put('panelDark', boxGeo(2.6, 1.0, 19.4, 2), cvx, 7.0, cvz, yaw, -0.52);
    ctx.put('grate', boxGeo(2.2, 0.4, 19, 2), cvx, 7.6, cvz, yaw, -0.52);
    const [mhx, mhz] = at(x, z, yaw, 0, 7.2);
    ctx.put('panelWarm', boxGeo(7.0, 4.0, 5.0, 2.4), mhx, 16.5, mhz, yaw);
    const [mwx, mwz] = at(x, z, yaw, 0, 9.72);
    ctx.put('glassWindow', new THREE.PlaneGeometry(5.4, 1.6), mwx, 17.2, mwz, yaw);
    ctx.put('emSodium', boxGeo(6.4, 0.14, 0.24, 1), mwx, 14.8, mwz, yaw);
    ctx.solid(mhx, 16.5, mhz, 3.5, 2.0, 2.5, yaw);

    /* Access gantry at 12 m, in front of the silos rather than through them,
     * and an external stair up to it clear of the aggregate bins. */
    const [gx2, gz2] = at(x, z, yaw, 0, 3.4);
    ctx.put('grate', boxGeo(21.2, 0.2, 2.0, 1.8), gx2, 12, gz2, yaw);
    bpGantry = deck(gx2, 12.1, gz2, 10.6, 1.0, yaw);
    for (const s of [-1, 1]) {
      const [rx3, rz3] = at(x, z, yaw, 0, 3.4 + s * 0.95);
      ctx.put('chrome', boxGeo(21.2, 0.07, 0.07, 1), rx3, 13.05, rz3, yaw);
      ctx.put('trimDark', boxGeo(21.2, 0.3, 0.06, 1), rx3, 12.25, rz3, yaw);
    }
    for (let i = 0; i < 4; i++) {
      const [sxp, szp] = at(x, z, yaw, -9 + i * 6, 3.4);
      ctx.put('trim', boxGeo(0.3, 12, 0.3, 2), sxp, 6, szp, yaw);
      ctx.solid(sxp, 6, szp, 0.2, 6, 0.2, yaw);
    }
    stairRun(x, z, yaw, 9.8, -14.0, 31);
    ctx.contact(x, z, 44);
    ctx.mmRect(x, z, 22, 22, yaw, 'rgba(130,120,100,0.55)', 'rgba(255,210,150,0.6)');
  }

  /* ---------------------------------------------------------------- */
  /* Barriers, fencing and small dressing                              */
  /* ---------------------------------------------------------------- */

  /* Mesh fence round the laydown bays: a second, lighter boundary inside the
   * hoarding's heavier one, so the site has two grades of edge rather than one
   * repeated at two radii. */
  for (const [a0, a1, r] of [[0.36, 1.10, 116], [1.28, 2.00, 116], [4.20, 5.10, 116], [2.30, 2.62, 118]]) {
    const n = Math.max(2, Math.round(((a1 - a0) * r) / 3.4));
    for (let i = 0; i < n; i++) {
      const a = a0 + ((a1 - a0) * (i + 0.5)) / n;
      const lx = bx(a, r), lz = bz(a, r);
      if (!ctx.onDeck(lx, lz, 6)) continue;
      sc('fence', lx, 1.1, lz, a);
      const [px2, pz2] = at(lx, lz, a, 1.7, 0);
      sc('fencePost', px2, 1.12, pz2, a);
      if (i % 3 === 0) ctx.solid(lx, 1.1, lz, 5.2, 1.1, 0.1, a);
    }
  }

  /* Jersey barriers channelling the haul road through the main gate and round
   * the crane base - the two places where a vehicle route and a walking route
   * have to be kept apart, and the only two where a hard edge does work. */
  for (let i = 0; i < 14; i++) {
    for (const s of [-1, 1]) {
      const lz = 96 + i * 3.1;
      sc('jersey', s * (ROAD_W / 2 + 1.6), 0.46, lz, 0);
      if (i % 2 === 0) ctx.solid(s * (ROAD_W / 2 + 1.6), 0.46, lz, 3.1, 0.46, 0.31);
      if (i % 4 === 1) sc('cone', s * (ROAD_W / 2 - 0.4), 0.39, lz, 0);
    }
  }
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const lx = CRANE.x + bx(a, 8.6), lz = CRANE.z + bz(a, 8.6);
    sc('jersey', lx, 0.46, lz, a + Math.PI / 2);
    if (i % 2 === 0) ctx.solid(lx, 0.46, lz, 1.5, 0.46, 0.31, a + Math.PI / 2);
  }
  // Exclusion zone painted under the hook, ringed with cones. The one piece of
  // floor marking in the zone that a player can work out the meaning of by
  // looking up.
  ctx.floorQuad('hazard', 15, 15, HOOK[0], HOOK[1], 0.4, 0.12, 5);
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    sc('cone', HOOK[0] + bx(a, 8.4), 0.39, HOOK[1] + bz(a, 8.4), a);
  }
  // Cones scattered along the loop, so the road looks used rather than laid out.
  for (let i = 0; i < 46; i++) {
    const a = rng() * Math.PI * 2;
    const r = LOOP_R + rnd(-ROAD_W / 2 - 3, ROAD_W / 2 + 3);
    const lx = bx(a, r), lz = bz(a, r);
    if (!ctx.onDeck(lx, lz, 6)) continue;
    sc('cone', lx, 0.39, lz, rng() * 3);
  }

  /* Floodlight masts ringing the court: nine metres of column with a sodium
   * head on it. They are why the site reads as *lit* from outside the hoarding,
   * and they are what the practicals below hang on, so the source of the light
   * is always visible in the same frame as the light. */
  const MASTS = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.39;
    const lx = bx(a, 99), lz = bz(a, 99);
    sc('lampMast', lx, 4.5, lz, a);
    sc('lampHead', lx, 9.1, lz, a);
    ctx.solid(lx, 4.5, lz, 0.2, 4.5, 0.2, a);
    ctx.contact(lx, lz, 4);
    MASTS.push([lx, lz]);
  }

  /* ---------------------------------------------------------------- */
  /* Steam, dust and sparks                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Three sources, each for a different reason: cutting sparks where the steel
   * is being worked, dust off the spoil where the dumper tips, and wet steam at
   * the batching plant. All static, and all facing back up the approach - see
   * the note in the kit on why this zone cannot use the animated system.
   */
  const WELD = [[-38, 12], [58, 14], [-14, -38]];
  for (const [wx, wz] of WELD) {
    for (let i = 0; i < 7; i++) {
      sc('spark', wx + rnd(-1.1, 1.1), rnd(0.5, 2.4), wz + rnd(-1.1, 1.1), rng() * 3,
        rnd(0.5, 1.6), rnd(0.5, 1.6), rnd(0.5, 1.6));
    }
    sc('puff', wx, 2.4, wz, 0, 0.5, 0.5, 1);
  }
  for (const s of SPOIL) {
    for (let i = 0; i < 3; i++) {
      sc('puff', s.lx + rnd(-s.r, s.r), s.h + rnd(0.5, 3), s.lz + rnd(-2, 2), 0, rnd(0.9, 1.9), rnd(0.9, 1.9), 1);
    }
  }
  for (let i = 0; i < 6; i++) {
    sc('puff', BP.x + rnd(-6, 6), rnd(6, 15), BP.z + rnd(-6, 6), 0, rnd(1.0, 2.2), rnd(1.0, 2.2), 1);
  }
  for (let i = 0; i < 5; i++) {
    sc('puff', 24 + i * 2.2, rnd(1.5, 3.4), -34 + rnd(-3, 3), 0, rnd(0.7, 1.4), rnd(0.7, 1.4), 1);
  }

  /* ---------------------------------------------------------------- */
  /* Practicals                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * `gfx/LightRig.js` scores every point light in the world by delivered energy
   * near the camera and hands the best eight a fixed slot, so the shader cache
   * key never moves however many are authored. That makes it correct to light
   * this zone from the fixtures that are actually in it rather than from a
   * smaller number of cheats: a flood mast with no light under it is the tell
   * that a set is lit from somewhere off camera.
   */
  const lamp = (lx, ly, lz, hex, power, dist) => {
    const l = new THREE.PointLight(hex, power, dist, 2);
    l.position.copy(ctx.P(lx, ly, lz));
    l.castShadow = false;
    ctx.group.add(l);
  };
  for (const [lx, lz] of MASTS) lamp(lx, 8.6, lz, 0xffa860, 2000, 74);
  lamp(0, 7.0, HOARD_R - 2, 0xffd0a0, 1500, 46);
  lamp(OFFICE.x, 4.2, OFFICE.z + 4, 0xd8e6ff, 900, 32);
  lamp(WELFARE.x, 4.2, WELFARE.z + 3, 0xffd8a8, 900, 32);
  lamp(BP.x, 13.5, BP.z, 0xffb070, 1600, 54);
  lamp(CRANE.x + 2, CRANE.mast, CRANE.z, 0xfff0d8, 1400, 70);
  lamp(HOOK[0], 24, HOOK[1], 0xffb070, 1300, 60);
  lamp(T1.cx, T1_TOP + 1.5, T1.cz, 0xffc890, 1500, 58);
  lamp(T2.cx - 12, 30, T2.cz, 0xffc890, 1400, 58);
  lamp(T3.cx, 50, T3.cz, 0xffc890, 1500, 62);
  for (const [wx, wz] of WELD) lamp(wx, 1.9, wz, 0xbfe0ff, 700, 22);

  /* ---------------------------------------------------------------- */
  /* Population                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * The crew.
   *
   * Every figure here is `variant: 'hiviz'`. `StationActors` deliberately breaks
   * its own desaturation rule for exactly one garment, and this is the zone it
   * broke it for: a hard-hat area whose workforce wears the ambient palette is
   * not a hard-hat area, it is some commuters standing near a crane. The vest is
   * confined to the torso mesh, so a worker still reads as a muted person
   * wearing something bright rather than as a person made of traffic cone.
   *
   * Phases are handed out explicitly wherever two figures are within a few
   * metres of each other. A boarded lift where six people hammer in unison is
   * worse than one where six people stand still: unison is a machine, and the
   * eye reads it as one object rather than as six people.
   */
  let phase = 0;
  const nextPhase = () => (phase = (phase + 1.317) % (Math.PI * 2));

  /* Checkerboard across lift number and side, so every level of every scaffold
   * has somebody on it. Selecting on lift parity alone put the whole crew on
   * the odd lifts and left six empty levels between them. */
  const populate = (rects, fn) => {
    for (const d of rects) if ((d.lift + d.sideIdx) % 2 === 0) fn(d);
  };

  populate(t1Decks, (d) => {
    const acts = ['hammer', 'carry', 'lift', 'hammer', 'stand'];
    crew(d, rnd(-0.85, 0.85), rnd(-0.6, 0.6), {
      activity: acts[d.lift % acts.length], phase: nextPhase(), speed: rnd(0.85, 1.2),
      localYaw: rnd(-Math.PI, Math.PI),
    });
    if (d.lift % 3 === 0) {
      crew(d, rnd(-0.85, 0.85), rnd(-0.6, 0.6), {
        activity: 'hammer', phase: nextPhase(), speed: rnd(0.8, 1.25),
        localYaw: rnd(-Math.PI, Math.PI),
      });
    }
  });
  for (const k of [3, 7, 11]) {
    crew(t1Stair[k], 0, 0, { activity: 'walk', phase: nextPhase(), speed: rnd(0.8, 1.1), localYaw: rnd(-3, 3) });
  }
  // The crash deck gang: a pair setting out from a drawing, a bolter, and a
  // banksman on the rail watching the hook come up.
  crew(t1Crash, -0.5, 0.4, { activity: 'talk', phase: 0.2, localYaw: facing(T1.cx - 5, T1.cz + 4, T1.cx - 1, T1.cz + 5) });
  crew(t1Crash, -0.4, 0.5, { activity: 'talk', phase: 3.4, localYaw: facing(T1.cx - 4, T1.cz + 5, T1.cx - 6, T1.cz + 4) });
  crew(t1Crash, 0.6, -0.5, { activity: 'hammer', phase: nextPhase(), speed: 1.05 });
  crew(t1Crash, 0.75, 0.7, { activity: 'stand', phase: nextPhase(), localYaw: facing(T1.cx + 9, T1.cz + 9, CRANE.x, CRANE.z) });

  populate(t2Decks, (d) => {
    crew(d, rnd(-0.85, 0.85), rnd(-0.6, 0.6), {
      activity: d.lift % 3 === 0 ? 'carry' : 'hammer', phase: nextPhase(), speed: rnd(0.85, 1.2),
      localYaw: rnd(-Math.PI, Math.PI),
    });
  });
  t2Plates.forEach((p, i) => {
    /* On the open plates people work at the *edge*: that is where the cladding
     * is going on, and a figure in the middle of a 26 m slab is invisible from
     * the ground, which is the only place anybody will ever see it from. */
    const edge = i % 2 ? -1 : 1;
    crew(p, edge * 0.94, rnd(-0.7, 0.7), {
      activity: i % 3 === 0 ? 'lift' : 'hammer', phase: nextPhase(), speed: rnd(0.85, 1.15),
      localYaw: edge > 0 ? Math.PI / 2 : -Math.PI / 2,
    });
    if (i % 2 === 0) {
      crew(p, rnd(-0.7, 0.7), 0.94, { activity: 'carry', phase: nextPhase(), speed: rnd(0.8, 1.1), localYaw: Math.PI });
    }
  });
  crew(t2Climber, 0, -0.6, { activity: 'stand', phase: nextPhase(), localYaw: Math.PI / 2 });
  crew(t2Climber, 0, 0.6, { activity: 'lift', phase: nextPhase(), speed: 0.9 });

  populate(t3Decks, (d) => {
    crew(d, rnd(-0.85, 0.85), rnd(-0.6, 0.6), {
      activity: d.lift % 3 === 2 ? 'stand' : 'hammer', phase: nextPhase(), speed: rnd(0.9, 1.25),
      localYaw: rnd(-Math.PI, Math.PI),
    });
  });
  t3Plates.forEach((p, i) => {
    crew(p, (i % 2 ? -1 : 1) * 0.92, rnd(-0.6, 0.6), {
      activity: 'hammer', phase: nextPhase(), speed: rnd(0.9, 1.2),
      localYaw: (i % 2 ? -1 : 1) * Math.PI / 2,
    });
    crew(p, rnd(-0.6, 0.6), -0.92, { activity: 'carry', phase: nextPhase(), speed: rnd(0.8, 1.1) });
  });

  crew(bpGantry, -0.6, 0, { activity: 'stand', phase: nextPhase(), localYaw: Math.PI / 2 });
  crew(bpGantry, 0.5, 0, { activity: 'hammer', phase: nextPhase(), speed: 0.9 });
  crew(officeBalcony, -0.6, 0, { activity: 'talk', phase: 0.9, localYaw: 1.2 });
  crew(officeBalcony, -0.35, 0, { activity: 'talk', phase: 4.1, localYaw: -1.9 });
  if (spoilTop) crew(spoilTop, 0.2, 0.2, { activity: 'stand', phase: nextPhase(), localYaw: rnd(-3, 3) });

  /* The banksman is the one figure on the site whose position is an argument.
   * He stands clear of the exclusion ring, faces the load, and everything the
   * crane is doing becomes legible through where he is looking. */
  hand(HOOK[0] - 11, HOOK[1] + 6, {
    activity: 'stand', phase: nextPhase(), localYaw: facing(HOOK[0] - 11, HOOK[1] + 6, HOOK[0], HOOK[1]),
  });
  hand(HOOK[0] - 14, HOOK[1] + 2, {
    activity: 'talk', phase: 1.1, localYaw: facing(HOOK[0] - 14, HOOK[1] + 2, HOOK[0] - 11, HOOK[1] + 6),
  });
  // Two gaffers over a drawing on the tailgate of the flatbed inside the gate.
  hand(17, 124, { activity: 'talk', phase: 0.4, localYaw: facing(17, 124, 13, 126) });
  hand(13, 126, { activity: 'talk', phase: 3.9, localYaw: facing(13, 126, 17, 124) });
  hand(15, 129, { activity: 'stand', phase: nextPhase(), localYaw: facing(15, 129, 14, 122) });

  WELD.forEach(([wx, wz], i) => {
    hand(wx + 0.9, wz + 0.4, { activity: 'hammer', phase: nextPhase(), speed: 1.15, localYaw: facing(wx + 0.9, wz + 0.4, wx, wz) });
    hand(wx - 1.2, wz - 0.8, { activity: 'lift', phase: nextPhase(), speed: 0.7, localYaw: facing(wx - 1.2, wz - 0.8, wx, wz) });
    if (i < 2) hand(wx + 2.6, wz - 2.2, { activity: 'stand', phase: nextPhase(), localYaw: facing(wx + 2.6, wz - 2.2, wx, wz) });
  });

  // The pour: a gang round the mixer chute.
  for (let i = 0; i < 4; i++) {
    const a = 2.1 + i * 0.5;
    const lx = 30 + bx(a, 7.5), lz = -34 + bz(a, 7.5);
    hand(lx, lz, {
      activity: i === 1 ? 'stand' : 'lift', phase: nextPhase(), speed: rnd(0.7, 1.0),
      localYaw: facing(lx, lz, 30, -34),
    });
  }
  // Steel fixers on the rebar bank, a pallet gang in the laydown, and the crew
  // stripping the flatbed in the steel yard.
  for (const [a0, step, r0, rStep, n, acts] of [
    [1.05, 0.11, 126, 6, 4, ['hammer', 'lift']],
    [4.40, 0.12, 132, 7, 5, ['lift', 'carry']],
    [0.46, 0.09, 124, 8, 4, ['carry', 'stand']],
  ]) {
    for (let i = 0; i < n; i++) {
      const a = a0 + i * step, r = r0 + (i % 2) * rStep;
      const lx = bx(a, r), lz = bz(a, r);
      if (!ctx.onDeck(lx, lz, 6)) continue;
      hand(lx, lz, {
        activity: acts[i % acts.length], phase: nextPhase(), speed: rnd(0.75, 1.1), localYaw: a + 2.6,
      });
    }
  }
  // Traffic: people walking the loop and the approach in both directions.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.2;
    const r = LOOP_R + (i % 2 ? 4.5 : -4.5);
    hand(bx(a, r), bz(a, r), {
      activity: 'walk', phase: nextPhase(), speed: rnd(0.85, 1.1),
      localYaw: a + (i % 2 ? Math.PI / 2 : -Math.PI / 2),
    });
  }
  for (let i = 0; i < 6; i++) {
    hand(rnd(-6, 6), 100 + i * 8, { activity: 'walk', phase: nextPhase(), speed: rnd(0.85, 1.15), localYaw: i % 2 ? 0 : Math.PI });
  }
  // The welfare queue, and people on their break outside it.
  for (let i = 0; i < 5; i++) {
    const [qx, qz] = at(WELFARE.x, WELFARE.z, WELFARE.yaw, -4.6, 5.6 + i * 0.9);
    hand(qx, qz, { activity: 'queue', phase: nextPhase(), localYaw: WELFARE.yaw + Math.PI });
  }
  for (let i = 0; i < 3; i++) {
    const [sx2, sz2] = at(WELFARE.x, WELFARE.z, WELFARE.yaw, -2.6 + i * 2.6, 3.6);
    ctx.actor(sx2, 0, sz2, {
      variant: 'hiviz', activity: i === 1 ? 'eat' : 'sit', amount: 0.48,
      phase: nextPhase(), speed: 0.9, localYaw: WELFARE.yaw,
    });
  }
  hand(OFFICE.x + 4.4, OFFICE.z - 3.2, { activity: 'stand', phase: nextPhase(), localYaw: 1.4 });
  hand(OFFICE.x + 5.6, OFFICE.z + 2.0, { activity: 'talk', phase: 2.2, localYaw: -1.1 });
  hand(30, 146, { activity: 'stand', phase: nextPhase(), localYaw: facing(30, 146, 30, 154) });
  // The gate: somebody signing people in, and two coming off shift.
  hand(6.5, HOARD_R - 2.5, { activity: 'stand', phase: nextPhase(), localYaw: facing(6.5, HOARD_R - 2.5, 0, HOARD_R) });
  hand(-2.5, HOARD_R + 3.5, { activity: 'walk', phase: nextPhase(), speed: 0.95, localYaw: Math.PI });
  hand(2.5, HOARD_R + 6.5, { activity: 'walk', phase: nextPhase(), speed: 1.0, localYaw: Math.PI });
  // Plant operators and a fitter working on the crawler.
  hand(-31, 70, { activity: 'stand', phase: nextPhase(), localYaw: 2.4 });
  hand(CRAWLER.x + 4, CRAWLER.z + 4, { activity: 'hammer', phase: nextPhase(), speed: 0.95, localYaw: facing(CRAWLER.x + 4, CRAWLER.z + 4, CRAWLER.x, CRAWLER.z) });
  hand(CRAWLER.x - 4, CRAWLER.z - 4, { activity: 'stand', phase: nextPhase(), localYaw: facing(CRAWLER.x - 4, CRAWLER.z - 4, T3.cx, T3.cz) });
  hand(bx(3.3, 118), bz(3.3, 118), { activity: 'carry', phase: nextPhase(), speed: 0.9, localYaw: 3.3 });
  hand(bx(1.8, 142), bz(1.8, 142), { activity: 'stand', phase: nextPhase(), localYaw: 1.8 + 2.0 });

  /* ---------------------------------------------------------------- */
  /* Named NPCs                                                        */
  /* ---------------------------------------------------------------- */

  ctx.npc(4, 96, {
    name: 'Dov Aleksy',
    persona:
      'Site foreman for the Ring 8 expansion, running a fifty-year build on a nineteen-month programme and entirely unbothered by either number. He talks in lift heights and pour dates, calls everybody "chief", and will break off mid-sentence to bawl at somebody unclipped forty metres up. He is proud of this site in a way he would deny under questioning.',
    patrol: [[4, 96], [-16, 72], [12, 46], [-4, 84]],
  });

  ctx.npc(28, 14, {
    name: 'Yeva Strand',
    persona:
      'Tower crane operator, eleven hours a shift in a two-metre cab and perfectly content there. She describes the zone the way you would describe a map - who is skiving, which stack is short, where the draught comes off the dome - and finds ground level unnervingly crowded. She has never dropped a load, and mentions it about twice an hour.',
    patrol: [[28, 14], [38, 2], [16, 12], [26, -6]],
  });

  /**
   * Hostiles.
   *
   * A half-built sector with no permanent power, no finished bulkheads and a
   * fence where a hull should be is the most plausible place on the map for
   * security units to be running corrupted patrol routes, and this zone is
   * deliberately the one that carries the ring's combat. All three work the
   * outer laydown rather than the court, so nobody is dropped into a firefight
   * on a scaffold thirty metres up with nowhere to break line of sight.
   */
  const HOSTILE =
    'A hijacked station security drone running corrupted enforcement code. It does not negotiate.';
  for (const [a, r, a2, r2, a3, r3] of [
    [1.2, 98, 1.7, 124, 0.8, 130],
    [4.1, 100, 4.6, 132, 3.6, 126],
    [2.8, 128, 3.4, 156, 2.3, 150],
  ]) {
    ctx.npc(bx(a, r), bz(a, r), {
      type: 'hostile', name: 'Rogue Security Unit', persona: HOSTILE,
      patrol: [[bx(a, r), bz(a, r)], [bx(a2, r2), bz(a2, r2)], [bx(a3, r3), bz(a3, r3)]],
    });
  }

  /* ---------------------------------------------------------------- */
  /* Collectables and reachable surfaces                               */
  /* ---------------------------------------------------------------- */

  /**
   * Fourteen spots, weighted hard toward height.
   *
   * The whole argument for building a climbable tower is that the climb has to
   * pay, so the prize is on the crash deck at 31 m - the highest surface in the
   * zone anybody can stand on - and the rares are on the lifts most of the way
   * up it. The ground-level ones are commons, placed where a player who never
   * works out that the stair exists will still find something: a zone that
   * gives nothing to somebody who walks round it teaches them not to walk round
   * the next one.
   */
  const onRect = (r, u, v, tier) => {
    const [lx, lz] = at(r.lx, r.lz, r.yaw, u * (r.hx - 0.5), v * (r.hz - 0.5));
    ctx.relic(lx, r.top + 0.4, lz, tier);
  };
  onRect(t1Crash, -0.5, 0.4, 'prize');
  onRect(t1Crash, 0.6, -0.5, 'rare');
  onRect(t1Decks[t1Decks.length - 1], 0.5, 0, 'rare');
  onRect(t1Decks[t1Decks.length - 4], -0.5, 0, 'rare');
  onRect(t1Decks[7], 0.3, 0, 'common');
  onRect(t1Decks[2], -0.3, 0, 'common');
  onRect(t1Stair[6], 0, 0, 'common');
  onRect(bpGantry, 0.6, 0, 'rare');
  onRect(officeBalcony, 0.7, 0, 'common');
  if (spoilTop) onRect(spoilTop, 0, 0, 'common');
  ctx.relic(bx(4.7, 150), 0.6, bz(4.7, 150), 'common');
  ctx.relic(bx(1.35, 152), 0.6, bz(1.35, 152), 'common');
  ctx.relic(T3.cx + 11, 1.4, T3.cz + 15, 'common');
  ctx.relic(HOOK[0] - 6, 0.6, HOOK[1] - 7, 'common');

  /* Reachable surfaces, published for the relic placer - and only reachable
   * ones. A roof nobody can stand on is a spot the placer will eventually put
   * something on that nobody can ever collect. */
  ctx.roof(t1Crash.lx, t1Crash.top, t1Crash.lz);
  ctx.roof(t1Stair[T1_LIFTS].lx, t1Stair[T1_LIFTS].top, t1Stair[T1_LIFTS].lz);
  for (const i of [3, 8, 14, 20]) ctx.roof(t1Decks[i].lx, t1Decks[i].top, t1Decks[i].lz);
  ctx.roof(officeBalcony.lx, officeBalcony.top, officeBalcony.lz);
  ctx.roof(bpGantry.lx, bpGantry.top, bpGantry.lz);
  if (spoilTop) ctx.roof(spoilTop.lx, spoilTop.top, spoilTop.lz);

  /* ---------------------------------------------------------------- */
  /* Flush the instanced kit                                           */
  /* ---------------------------------------------------------------- */

  for (const [name, list] of batches) {
    const def = KIT[name];
    if (!def || !list.length) continue;
    const mesh = instanced(def.geo(), M[def.mat], list, { cast: !def.lit, recv: !def.lit });
    mesh.name = `zone:construction:${name}`;
    // The additive families draw after the opaque pass, or they punch a hole in
    // whatever is behind them.
    if (def.mat === 'steam') mesh.renderOrder = 7;
    ctx.group.add(mesh);
  }
}
