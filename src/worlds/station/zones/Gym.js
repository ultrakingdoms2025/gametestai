import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { atlasUV, boxGeo, cylGeo, instanced, uvScale } from '../StationKit.js';

/**
 * DECK 9 ATHLETICS - the station gym, on avenue 180.
 *
 * ── What this place has to be ─────────────────────────────────────────────
 * It is 500 m from the plaza. Nobody walks that unless the walk pays, so the
 * zone is built to be legible in three passes and to reward all three:
 *
 *   from the link mouth    the centrifuge drum and the climbing tower break
 *                          the 112 m court line, so the destination is visible
 *                          before the player has left the corridor
 *   from the court edge    the track ring, the combat platform and the drum's
 *                          access gantry give the middle distance a readable
 *                          plan rather than a scatter of props
 *   from arm's length      every machine has a frame, a moving element, a
 *                          console and a person using it
 *
 * ── The section, and why the equipment is where it is ────────────────────
 * `OuterRing.buildZone` fixes the shell: an open court under the dome inside
 * r = 112 with 122 m of clear height over it, and a covered arcade from there
 * to the rim with a ceiling plate at 30 m. That is not decoration, it is a
 * brief. Anything that needs height - the drum, the climbing tower, the mast -
 * goes in the court, where it is also the thing you can see from the corridor.
 * Anything that needs a ceiling to feel like a room - the machine ranks, the
 * free weights, the physio bay - goes under the arcade, where 30 m of headroom
 * over a 1.4 m dumbbell rack is already generous.
 *
 * ── Why equipment is in tight clusters with enormous gaps ─────────────────
 * The arcade band is 88 m deep and about 1,000 m round. A gym's worth of kit
 * laid out at realistic 1.4 m centres occupies a fiftieth of it, and spreading
 * it evenly to fill the space would put eleven metres between adjacent
 * treadmills - which is not a gym, it is a warehouse with treadmills in it.
 * So every rank is built at true spacing and the *ranks* are what is spread
 * out, with painted bays, water points, lockers and circulation between them.
 * That is how a concourse this size actually works, and it is the only layout
 * in which the machines still read as machines.
 *
 * ── The population ────────────────────────────────────────────────────────
 * `StationActors` grew `run`, `row`, `curl`, `press` and `lift` for this zone
 * specifically, so they are used literally rather than decoratively: every
 * treadmill has a runner standing on its belt at y = 0.28, every erg has a
 * rower whose seat slides half a metre down the rail, every rack has somebody
 * curling at it. Phases are staggered by hand in every rank - a bank of
 * fourteen treadmills bobbing in unison reads worse than fourteen statues,
 * because the eye reads the *correlation* long before it reads the pose. Rate
 * is staggered too: figures started out of phase on identical rates drift back
 * into lockstep every few seconds, which looks like a deliberate effect.
 *
 * The one gap in the verb set is supine work. There is no lying pose, so the
 * flat benches carry seated dumbbell work and every press in here happens
 * standing at a rack. A bench-press figure would have to be a mannequin lying
 * face-up under a bar, which is the one thing worse than an empty bench.
 */

/* ------------------------------------------------------------------ */
/* Frame                                                               */
/* ------------------------------------------------------------------ */

const D2R = Math.PI / 180;

/** Inner radius of the open court. Mirrors `OuterRing.ZONE_COURT_R`. */
const COURT_R = 112;

/**
 * Highest anything under the arcade may reach.
 *
 * The ceiling plate is at 30 m, the radial trusses hang 1.5 m below it and the
 * lit troughs another 2 m below that. 27 clears the troughs everywhere, which
 * is the number that matters - a banner that clears the plate but not the
 * lighting grid still intersects the one thing in that roof a player can see.
 */
const ARCADE_MAX_Y = 27;

/** Centre-line radius and half-width of the court's running track. */
const TRACK_R = 102;
const TRACK_HALF = 6;

/**
 * Zone-local point on a bearing.
 *
 * Bearing 0 is the link mouth (local +Z, back toward the hub) and increases
 * toward local +X, which is the same convention `OuterRing` walks the
 * perimeter wall on. Everything in this file is positioned in (bearing,
 * radius) because the deck is a disc: in Cartesian coordinates every bay's
 * clearance to the rim would be a separate piece of arithmetic, and the first
 * one to be got wrong would put a locker bank in vacuum.
 */
function bear(deg, r) {
  const a = deg * D2R;
  return [Math.sin(a) * r, Math.cos(a) * r];
}

/* ------------------------------------------------------------------ */
/* Prop geometry helpers                                               */
/* ------------------------------------------------------------------ */

/**
 * A UV-corrected box in a rig's own frame.
 *
 * `tile` defaults to 1.2 m rather than the kit's 2 m. Gym hardware is small - a
 * treadmill upright is 9 cm square - and at a 2 m tile a whole machine gets
 * about a twentieth of one texture repeat, which renders as a flat colour
 * swatch. At 1.2 the panel grain is still visible on parts this size.
 */
function bx(w, h, d, x, y, z, ry = 0, tile = 1.2) {
  const g = boxGeo(w, h, d, tile);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}

/**
 * A cylinder on a chosen axis, in a rig's own frame.
 *
 * The axis is spelled out rather than left to the caller because a flywheel on
 * the wrong axis is a disc lying flat inside its own machine: invisible from
 * every angle, and therefore the most expensive kind of mistake - it costs the
 * triangles and shows nothing for them.
 */
function cyl(r, h, seg, x, y, z, axis = 'y', tile = 1.2) {
  const g = cylGeo(r, r, h, seg, tile);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  else if (axis === 'z') g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

/** A single-sided quad facing local +Z. */
function quad(w, h) {
  return new THREE.PlaneGeometry(w, h);
}

function merge(list) {
  return list.length === 1 ? list[0] : mergeGeometries(list, false);
}

/* ------------------------------------------------------------------ */
/* Repeated hardware                                                   */
/* ------------------------------------------------------------------ */

/**
 * Every prop that appears more than about fifteen times, as one geometry each.
 *
 * These are the shapes `instanced()` exists for. A treadmill is six boxes; the
 * fourteen in the cardio bay are one copy of those six boxes plus fourteen
 * matrices, not eighty-four boxes merged into the zone batch. The same
 * argument applies with far more force to the forty-eight dumbbells.
 *
 * The convention every entry obeys, and the reason the actors line up with the
 * hardware without a single hand-tuned offset: **the business end of a machine
 * points along local -Z**. A `StationActors` figure faces its own -Z at yaw 0
 * (see `_calfGeo` - the toe box leads -Z), so a machine and its user placed on
 * the same yaw automatically face the same way. Get that backwards once and a
 * whole rank of runners faces the back of its own consoles.
 *
 * Geometry factories are lazy, so a shape nothing placed is never built.
 */
const PROPS = {
  /* --- Treadmill -----------------------------------------------------
   * The belt top is at exactly 0.28 m, which is the `ly` every runner in
   * this file is given. It is a property of the shape, not a measurement
   * taken afterwards: a 0.20 m base with a 0.09 m belt sitting 0.01 proud
   * of it. Change the base and fourteen runners sink into the deck. */
  treadBody: {
    key: 'trimDark',
    geo: () => merge([
      bx(1.00, 0.20, 2.20, 0, 0.10, 0),          // deck frame
      bx(0.98, 0.26, 0.44, 0, 0.15, -0.98),      // motor cowl, under the console
      bx(0.09, 1.12, 0.09, -0.44, 0.76, -0.88),  // upright, left
      bx(0.09, 1.12, 0.09, 0.44, 0.76, -0.88),   // upright, right
      bx(0.86, 0.36, 0.20, 0, 1.34, -0.86),      // console head
      bx(0.92, 0.22, 0.28, 0, 0.31, 1.02),       // rear roller cowl
    ]),
  },
  treadBelt: { key: 'rubber', geo: () => bx(0.82, 0.09, 1.80, 0, 0.235, 0.06) },
  treadRail: {
    key: 'chrome',
    geo: () => merge([
      bx(0.07, 0.07, 0.98, -0.44, 1.06, -0.36),
      bx(0.07, 0.07, 0.98, 0.44, 1.06, -0.36),
    ]),
  },
  treadScreen: { key: 'emCyan', geo: () => quad(0.66, 0.26).translate(0, 1.38, -0.755) },

  /* --- Exercise bike --------------------------------------------------
   * Saddle top at 0.94, which is the rider's `amount`. The flywheel is a
   * real disc on the real axis: it is the only part of a static bike that
   * says "this spins", and a box in its place reads as a fairing. */
  bikeBody: {
    key: 'trimDark',
    geo: () => merge([
      bx(0.34, 0.14, 1.30, 0, 0.07, 0),
      bx(0.64, 0.12, 0.18, 0, 0.06, -0.60),      // front foot
      bx(0.64, 0.12, 0.18, 0, 0.06, 0.60),       // rear foot
      bx(0.10, 0.72, 0.10, 0, 0.48, 0.28),       // seat post
      bx(0.22, 0.08, 0.44, 0, 0.90, 0.26),       // saddle
      bx(0.10, 1.02, 0.10, 0, 0.60, -0.42),      // stem
      bx(0.54, 0.06, 0.06, 0, 1.08, -0.50),      // bars
      bx(0.16, 0.10, 0.30, 0.20, 0.30, -0.12),   // crank arm
      cyl(0.30, 0.09, 8, 0, 0.62, -0.30, 'x'),   // flywheel
    ]),
  },
  bikeScreen: { key: 'emCyan', geo: () => quad(0.34, 0.20).translate(0, 1.20, -0.46) },

  /* --- Stepper --------------------------------------------------------
   * Pedal tops at 0.47. The user is on `walk` at just over half speed: a
   * stair machine is a walk that does not translate, which is precisely
   * what the gait pose already is. */
  stepBody: {
    key: 'trimDark',
    geo: () => merge([
      bx(0.72, 0.22, 1.10, 0, 0.11, 0),
      bx(0.26, 1.52, 0.26, 0, 0.86, -0.42),      // column
      bx(0.64, 0.30, 0.20, 0, 1.62, -0.42),      // console
      bx(0.06, 0.06, 0.76, -0.36, 1.06, -0.08),  // handrail, left
      bx(0.06, 0.06, 0.76, 0.36, 1.06, -0.08),   // handrail, right
      bx(0.26, 0.10, 0.64, -0.20, 0.42, 0.18),   // pedal, left
      bx(0.26, 0.10, 0.64, 0.20, 0.42, 0.18),    // pedal, right
    ]),
  },

  /* --- Rowing erg -----------------------------------------------------
   * Seat at 0.52 and the footplates 0.57 m in front of the seat's mid
   * travel, because those are the two numbers `_poseRow` solves the legs
   * against (`FOOT_Z = -0.57`, `FOOT_Y = seat - 0.17`). Building the rail
   * to suit the pose rather than posing to suit the rail is what keeps the
   * shoes on the plates through the whole stroke. */
  rowBody: {
    key: 'trimDark',
    geo: () => merge([
      bx(0.14, 0.09, 2.44, 0, 0.44, 0.10),       // monorail
      bx(0.54, 0.46, 0.38, 0, 0.23, -1.14),      // front pedestal
      bx(0.48, 0.12, 0.32, 0, 0.06, 1.24),       // rear foot
      bx(0.12, 0.36, 0.22, 0, 0.24, -0.84),      // rail knee
      bx(0.20, 0.36, 0.10, -0.17, 0.42, -1.02),  // footplate, left
      bx(0.20, 0.36, 0.10, 0.17, 0.42, -1.02),   // footplate, right
      cyl(0.34, 0.28, 10, 0, 0.62, -1.24, 'x'),  // flywheel housing
    ]),
  },
  rowSlide: {
    key: 'chrome',
    geo: () => merge([
      /* Drawn at the mid point of the travel, and made long rather than
       * seat-shaped. The seat is static geometry in a merged batch while the
       * rower slides 0.55 m over it, so a seat-sized pad would visibly leave
       * its occupant behind twice a stroke; a slide carriage the length of
       * the travel is both what the machine has and always underneath them. */
      bx(0.24, 0.06, 1.02, 0, 0.50, -0.45),
      bx(0.46, 0.05, 0.05, 0, 0.66, -0.80),      // handle, parked at the catch
    ]),
  },

  /* --- Flat bench ------------------------------------------------------ */
  benchFrame: {
    key: 'trimDark',
    geo: () => merge([
      bx(0.64, 0.10, 0.26, 0, 0.05, -0.62),
      bx(0.64, 0.10, 0.26, 0, 0.05, 0.62),
      bx(0.14, 0.36, 1.42, 0, 0.26, 0),
    ]),
  },
  benchPad: { key: 'rubber', geo: () => bx(0.36, 0.09, 1.32, 0, 0.475, 0) },

  /* --- Loose iron ------------------------------------------------------
   * A dumbbell is three boxes. At 0.42 m long it is never more than a few
   * pixels across from anywhere a player can stand, and hexagonal end
   * plates would triple its cost to say what the silhouette already says. */
  dumbbell: {
    key: 'trimDark',
    geo: () => merge([
      bx(0.05, 0.05, 0.36, 0, 0, 0),
      bx(0.18, 0.18, 0.10, 0, 0, -0.20),
      bx(0.18, 0.18, 0.10, 0, 0, 0.20),
    ]),
  },
  /* Bumper plates, on `rubber` because that is what a bumper plate is - and
   * because `rubber` is in NON_SOLID_KEYS, so three dozen discs on plate trees
   * never reach the collision extractor. Axis on local Z, so a plate loaded on
   * a bar shares the bar's yaw. */
  plate: { key: 'rubber', geo: () => cyl(0.44, 0.09, 8, 0, 0, 0, 'z') },
  barbell: {
    key: 'chrome',
    geo: () => merge([
      cyl(0.026, 2.20, 6, 0, 0, 0, 'x'),
      bx(0.42, 0.10, 0.10, -0.86, 0, 0),
      bx(0.42, 0.10, 0.10, 0.86, 0, 0),
    ]),
  },

  /* --- Locker door -----------------------------------------------------
   * The carcass behind it is one box in the zone batch; only the doors
   * repeat. `shell` rather than `panelDark`: lockers are moulded composite
   * and `shell` is the one fully dielectric material in the family, so a
   * wall of them answers the arcade practicals with a broad diffuse rolloff
   * instead of the hard metal falloff everything else in the bay has. */
  lockerDoor: { key: 'shell', geo: () => bx(0.46, 1.06, 0.06, 0, 0, 0) },

  /* --- Climbing hold ----------------------------------------------------
   * An octahedron, unsubdivided: eight triangles, no two faces parallel, an
   * irregular silhouette from every angle. A box this size reads as a pixel
   * of noise; this reads as a lump bolted to a wall. */
  hold: { key: 'panelWarm', geo: () => new THREE.OctahedronGeometry(0.15, 0) },
};

/* ------------------------------------------------------------------ */
/* Build scope                                                         */
/* ------------------------------------------------------------------ */

/**
 * A thin façade over the `ZoneContext` adding the two things this zone needs
 * everywhere: an instanced-prop sink, and a rig frame.
 *
 * The rig frame is the important half. A gym is about forty clusters, each a
 * couple of dozen parts laid out against its own origin - "the rack is 1.2 m
 * in front of the mirror, the lifter 0.9 m in front of the rack". Written
 * directly in zone coordinates every one of those offsets becomes a pair of
 * sines, and the first cluster copied to another bearing comes out mirrored.
 * `rig()` does the transform once, in exactly the form `GeoBatch.localAt`
 * already uses, and every builder below works in millimetre-free local space.
 */
function scope(ctx) {
  const bins = {};

  /** Push one instanced prop, in zone-local coordinates. */
  const prop = (name, lx, ly, lz, localYaw = 0, s = 1) => {
    const p = ctx.P(lx, ly, lz);
    (bins[name] ??= []).push([p.x, p.y, p.z, 0, ctx.yawOf(localYaw), 0, s, s, s]);
  };

  /**
   * A practical.
   *
   * `castShadow` is false on every one, without exception. `gfx/LightRig.js`
   * scores point lights by delivered energy near the camera and gives the best
   * eight a fixed slot, so the *count* authored here is free - but a
   * shadow-casting light is a render target and a second scene traversal, and
   * those are not free at any count.
   */
  const lamp = (lx, ly, lz, hex, power, dist) => {
    const l = new THREE.PointLight(hex, power, dist, 2);
    l.position.copy(ctx.P(lx, ly, lz));
    l.castShadow = false;
    ctx.group.add(l);
    return l;
  };

  /**
   * A local frame at zone-local (ox, oz) on `yaw`.
   *
   * Local -Z is the rig's front and +X is 90 degrees further round the deck.
   * The transform is the one `GeoBatch.localAt` applies, so a part placed
   * through `box` and a collider placed through `solid` cannot drift apart.
   */
  const rigXZ = (ox, oz, yaw) => {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const to = (x, z) => [ox + x * c + z * s, oz - x * s + z * c];
    return {
      ox, oz, yaw, to,
      box(key, w, h, d, x, y, z, ry = 0, tile = 1.2) {
        const [lx, lz] = to(x, z);
        return ctx.box(key, w, h, d, lx, y, lz, yaw + ry, tile);
      },
      put(key, geo, x, y, z, ry = 0, rx = 0, rz = 0) {
        const [lx, lz] = to(x, z);
        return ctx.put(key, geo, lx, y, lz, yaw + ry, rx, rz);
      },
      solid(x, y, z, hx, hy, hz, ry = 0) {
        const [lx, lz] = to(x, z);
        return ctx.solid(lx, y, lz, hx, hy, hz, yaw + ry);
      },
      /* `rise` is gained toward the rig direction (sin ry, cos ry), which for
       * ry = 0 is the rig's *back*. That falls straight out of `_ramp` - it
       * pitches the proxy's +Z end up before yawing it - and it is worth
       * stating, because a ramp built the other way up is a collider that
       * pushes the player off the bottom of the stair they are climbing. */
      ramp(x, y, z, width, run, riseTo, ry = 0) {
        const [lx, lz] = to(x, z);
        return ctx.ramp(lx, y, lz, width, run, riseTo, yaw + ry);
      },
      floor(key, w, d, x, z, ry = 0, y = 0.12, tile = 6) {
        const [lx, lz] = to(x, z);
        return ctx.floorQuad(key, w, d, lx, lz, yaw + ry, y, tile);
      },
      prop(name, x, y, z, ry = 0, sc = 1) {
        const [lx, lz] = to(x, z);
        prop(name, lx, y, lz, yaw + ry, sc);
      },
      actor(x, y, z, o = {}) {
        const [lx, lz] = to(x, z);
        return ctx.actor(lx, y, lz, { ...o, localYaw: yaw + (o.localYaw ?? 0) });
      },
      relic(x, y, z, tier) {
        const [lx, lz] = to(x, z);
        ctx.relic(lx, y, lz, tier);
      },
      roof(x, y, z) {
        const [lx, lz] = to(x, z);
        ctx.roof(lx, y, lz);
      },
      sign(cell, w, h, x, y, z, ry = 0, o = {}) {
        const [lx, lz] = to(x, z);
        ctx.sign(cell, w, h, lx, y, lz, yaw + ry, o);
      },
      contact(x, z, size) {
        const [lx, lz] = to(x, z);
        ctx.contact(lx, lz, size);
      },
      lamp(x, y, z, hex, power, dist) {
        const [lx, lz] = to(x, z);
        lamp(lx, y, lz, hex, power, dist);
      },
    };
  };

  /**
   * A rig anchored on a bearing.
   *
   * `turn = 0` points the rig's front at the court, which is the default
   * because it is what almost everything in the arcade should do: a runner
   * looking at the drum is looking at the best thing in the zone, and a runner
   * looking at the perimeter wall is looking at a wall. The free-weights bay
   * is the deliberate exception - see `buildFreeWeights`.
   */
  const rig = (deg, r, turn = 0) => {
    const [ox, oz] = bear(deg, r);
    return rigXZ(ox, oz, deg * D2R + turn);
  };

  return { ctx, bins, M: ctx.M, rng: ctx.rng, accent: ctx.accent, prop, lamp, rig, rigXZ };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export function buildGym(ctx) {
  const S = scope(ctx);

  paintDeck(S);
  buildEntrance(S);
  buildCardioBay(S);
  buildRowingTank(S);
  buildFreeWeights(S);
  buildMachineHall(S);
  buildRecovery(S);
  buildCourt(S);
  dressArcade(S);
  populateNamed(ctx);

  flushProps(S);
}

/* ------------------------------------------------------------------ */
/* Deck graphics                                                       */
/* ------------------------------------------------------------------ */

/**
 * A painted sector of the arcade floor.
 *
 * `RingGeometry` measures theta from +X toward +Y, and after the flat-lay
 * rotation that becomes +X toward -Z - the opposite hand from the bearing
 * convention everything else in this file uses. Rather than leave each caller
 * to work that out (and get it wrong once, which would put a bay on the far
 * side of the zone from the equipment standing in it), the conversion lives
 * here: bearing `a` is ring theta `a - 90`.
 */
function bay(ctx, key, deg0, deg1, r0, r1, y = 0.11, tile = 9) {
  const g = new THREE.RingGeometry(
    r0, r1, Math.max(6, Math.round((deg1 - deg0) / 3.5)), 1,
    deg0 * D2R - Math.PI / 2, (deg1 - deg0) * D2R
  );
  g.rotateX(-Math.PI / 2);
  uvScale(g, (r1 - r0) / tile, (r1 - r0) / tile);
  return ctx.put(key, g, 0, y, 0);
}

/** Which bearings and radii each bay owns. Read by the paint and the minimap. */
const BAYS = [
  [16, 56, 138, 190],     // reception
  [60, 128, 132, 188],    // cardio
  [132, 172, 134, 184],   // rowing tank
  [176, 250, 138, 192],   // free weights
  [254, 306, 130, 190],   // machines
  [310, 348, 138, 190],   // recovery
];

/**
 * Floor finishes, the accent kerb and the minimap.
 *
 * The finish carries the whole plan on its own. A gym is the one building type
 * where the flooring genuinely changes by activity - sprung rubber under free
 * weights, hard plate under cardio, mat under stretching - so painting the
 * bays is not decoration, it is the legible version of the layout. It also
 * costs almost nothing: nine ring sectors is under 250 triangles for forty
 * thousand square metres of floor.
 */
function paintDeck(S) {
  const { ctx } = S;

  /* Concourse: the full circuit at the court edge, in plaza finish, so there
   * is always an obvious way round that is not through somebody's set. */
  bay(ctx, 'plaza', 0, 359.9, COURT_R + 2, COURT_R + 16, 0.11, 12);

  /* Equipment bays in gym rubber. `rubber` is in NON_SOLID_KEYS, so nine
   * hundred square metres of floor covering generates no collision triangles
   * at all - the right answer for something lying 11 cm above a deck that is
   * already solid to its rim. */
  for (const [d0, d1, r0, r1] of BAYS) bay(ctx, 'rubber', d0, d1, r0, r1, 0.115, 7);

  /* An accent kerb along the court edge of every bay. It is the only
   * continuous line in the zone, and it is what tells a player at 150 m that
   * the arcade is one space rather than six unrelated rooms. */
  for (const [d0, d1] of BAYS) bay(ctx, ctx.accent, d0, d1, 129.6, 130.4, 0.16, 1);

  ctx.mmCircle(0, 0, COURT_R, 'rgba(90,60,120,0.22)', 'rgba(201,176,255,0.55)');
  ctx.mmPath(
    Array.from({ length: 40 }, (_, i) => bear((i / 39) * 360, TRACK_R)),
    'rgba(201,176,255,0.45)', TRACK_HALF * 2, true
  );
  for (const [d0, d1, r0, r1] of BAYS) {
    const dm = (d0 + d1) / 2, rm = (r0 + r1) / 2;
    const [mx, mz] = bear(dm, rm);
    ctx.mmRect(mx, mz, (d1 - d0) * D2R * rm, r1 - r0, dm * D2R,
      'rgba(70,80,110,0.4)', 'rgba(170,200,240,0.35)');
  }
}

/* ------------------------------------------------------------------ */
/* Reception                                                           */
/* ------------------------------------------------------------------ */

/**
 * The gate, the desk, the kit counter and the first lockers.
 *
 * The turnstiles run straight across the entrance axis at lz = 146, and they
 * are the one thing in the zone that ignores the deck's curve. The player
 * arrives down a straight 96 m corridor and over a straight-edged plaza; a
 * gate line curved to the deck at the end of that reads as a barrier laid out
 * by the floor rather than by the door, and you cannot tell at a glance which
 * gap is pointing at you. A straight line square to the approach can only be
 * read one way.
 */
function buildEntrance(S) {
  const { ctx } = S;
  const GATE_Z = 146;
  const gate = S.rigXZ(0, GATE_Z, 0);
  gate.floor('plaza', 40, 14, 0, 0, 0, 0.12, 10);

  for (let i = 0; i < 6; i++) {
    const x = (i - 2.5) * 4.6;
    for (const s of [-1, 1]) {
      gate.box('shell', 0.44, 1.02, 1.60, x + s * 0.62, 0.51, 0);
      gate.box('trim', 0.50, 0.08, 1.68, x + s * 0.62, 1.06, 0);
      gate.box(ctx.accent, 0.16, 0.06, 1.30, x + s * 0.62, 1.12, 0);
      gate.solid(x + s * 0.62, 0.55, 0, 0.24, 0.55, 0.82);
    }
    /* Glass paddle, folded open. A closed gate on a route every player has to
     * walk is a door that does not work; folded back it still reads as a
     * turnstile and nobody has to find the one lane that lets them through. */
    gate.box('glassWindow', 0.06, 0.86, 1.10, x, 0.62, -0.72);
    gate.box('emGreen', 0.30, 0.05, 0.30, x, 1.14, -0.62);
  }
  for (const x of [-16.4, 16.4]) {
    gate.box('shell', 0.44, 1.02, 1.60, x, 0.51, 0);
    gate.solid(x, 0.55, 0, 0.24, 0.55, 0.82);
  }

  /* Canopy. It is the only overhead datum between the 30 m arcade plate and
   * the deck at this end of the zone; without it the gate line has no height
   * at all - six waist-high pedestals in a 400 m room. */
  gate.box('panelDark', 38, 0.55, 5.0, 0, 4.7, 0.4);
  /* Solid, because it is stood on.
   *
   * The canopy carries a `roof()` and a relic on its upper face, and both of
   * those are promises: `roof()` offers the slab to the relic placer as a
   * reachable site, and a collectible on a surface with no collider is one the
   * player can see, climb toward, and fall straight through. Drawn geometry is
   * not collided out here - the derived pass stops at the hub deck and the
   * outer ring collides what it authors - so this has to say so.
   */
  gate.solid(0, 4.7, 0.4, 19, 0.275, 2.5);
  for (const z of [-1.4, 2.0]) gate.box('emWhite', 32, 0.14, 0.6, 0, 4.38, z);
  for (const x of [-17.4, -5.8, 5.8, 17.4]) {
    gate.box('trim', 0.42, 4.5, 0.42, x, 2.25, 2.6);
    gate.solid(x, 2.25, 2.6, 0.24, 2.25, 0.24);
  }
  gate.roof(0, 4.98, 0.4);
  ctx.relic(-14.6, 5.15, GATE_Z + 0.4, 'common');
  gate.contact(0, 0, 42);

  // Queueing, and two who have already stopped to argue about the session plan.
  for (let i = 0; i < 6; i++) {
    const x = (i - 2.5) * 4.6 + (ctx.rng() - 0.5) * 0.5;
    gate.actor(x, 0, 2.8 + (i % 3) * 1.3, { activity: 'queue', phase: i * 1.93 });
  }
  gate.actor(-9.2, 0, -3.4, { activity: 'talk', phase: 0.4, localYaw: 2.2 });
  gate.actor(-7.4, 0, -4.2, { activity: 'talk', phase: 3.6, localYaw: -0.9 });

  /* --- Reception desk --------------------------------------------------
   * Turned a quarter turn off the bay default so its front points back at
   * the gate rather than at the court. It is the one piece of furniture in
   * the zone whose job is to look at people arriving. */
  const desk = S.rig(24, 170, Math.PI / 2);
  desk.box('panelWarm', 9.0, 1.06, 1.10, 0, 0.53, 0);
  desk.box('trim', 9.4, 0.10, 1.30, 0, 1.10, 0);
  desk.box('panelDark', 9.0, 0.30, 0.90, 0, 0.16, 0.9);
  desk.box(ctx.accent, 8.4, 0.10, 0.10, 0, 0.30, -0.58);
  desk.solid(0, 0.55, 0, 4.6, 0.55, 0.7);
  desk.box('panel', 11.0, 4.2, 0.5, 0, 2.1, 3.2);
  desk.box('trim', 11.4, 0.24, 0.8, 0, 4.3, 3.2);
  desk.box('emWhite', 9.6, 0.12, 0.16, 0, 1.4, 2.92);
  desk.solid(0, 2.1, 3.2, 5.5, 2.1, 0.3);
  desk.sign(29, 6.2, 1.55, 0, 3.2, 2.80, Math.PI, { thickness: 0.16, accent: ctx.accent });
  desk.lamp(0, 3.6, -1.2, 0xd9e6ff, 900, 34);
  desk.actor(-2.2, 0, 1.1, { activity: 'stand', phase: 1.1 });
  desk.actor(1.9, 0, 1.1, { activity: 'talk', phase: 2.7 });
  desk.actor(1.6, 0, -1.5, { activity: 'talk', phase: 5.2, localYaw: Math.PI });
  desk.contact(0, 0.6, 16);

  /* --- Kit and towel counter -------------------------------------------- */
  const kit = S.rig(38, 176);
  kit.box('panelWarm', 7.0, 1.02, 1.00, 0, 0.51, 0);
  kit.box('trim', 7.4, 0.09, 1.20, 0, 1.06, 0);
  kit.solid(0, 0.55, 0, 3.6, 0.55, 0.65);
  // Shelving behind, stacked with folded kit. These are the same box twenty-one
  // times, which is well under the count at which instancing starts to pay.
  kit.box('panelDark', 7.4, 3.0, 0.7, 0, 1.5, 3.0);
  for (let s = 0; s < 3; s++) {
    kit.box('trim', 7.0, 0.08, 0.72, 0, 0.75 + s * 0.82, 2.6);
    for (let i = 0; i < 7; i++) {
      kit.box('shell', 0.62, 0.34, 0.52, (i - 3) * 0.94, 0.96 + s * 0.82, 2.6, 0, 0.8);
    }
  }
  kit.solid(0, 1.5, 3.0, 3.7, 1.5, 0.4);
  kit.box('panelDark', 8.2, 0.45, 3.2, 0, 3.55, 1.6);
  kit.box('emWhite', 6.6, 0.12, 0.5, 0, 3.28, 0.4);
  kit.roof(0, 3.78, 1.6);
  kit.relic(2.6, 2.68, 2.6, 'common');
  kit.actor(-1.4, 0, 1.2, { activity: 'stand', phase: 0.8 });
  kit.actor(0.9, 0, -1.6, { activity: 'carry', phase: 2.2, speed: 0.8 });
  kit.contact(0, 1.2, 14);
  kit.lamp(0, 3.1, 0.4, 0xffd9b0, 620, 26);

  lockerBank(S, S.rig(30, 187), 8, 'rare');
  lockerBank(S, S.rig(46, 185), 7, null);
  waterPoint(S, S.rig(19, 156), true);
  benchRow(S, S.rig(33, 158), 3);
}

/* ------------------------------------------------------------------ */
/* Cardio                                                              */
/* ------------------------------------------------------------------ */

/**
 * The cardio deck: fourteen treadmills, ten bikes and six steppers.
 *
 * Everything here faces the court, which is the whole reason the ranks are on
 * this side of the zone. A treadmill facing a wall is forty minutes of looking
 * at a wall; these look out over the concourse at the track, the drum and the
 * climbing tower - which is also, incidentally, most of the justification for
 * building the court at all.
 *
 * The two treadmill ranks are staggered by half a machine rather than aligned,
 * because a second rank directly behind the first is a grid, and a grid of
 * fourteen identical objects is the one arrangement in which the eye counts
 * them instead of reading them.
 */
function buildCardioBay(S) {
  const { ctx } = S;

  treadRank(S.rig(70, 150), 8, 0);
  treadRank(S.rig(80, 163), 6, 0.95);
  bikeRank(S.rig(92, 168), 5, 0);
  bikeRank(S.rig(100, 156), 5, 1.0);
  stepperRank(S.rig(112, 170), 6);

  waterPoint(S, S.rig(86, 143), true);
  waterPoint(S, S.rig(106, 141), false);
  lockerBank(S, S.rig(84, 185), 8, null);
  stretchMats(S, S.rig(122, 152), 3);
  benchRow(S, S.rig(75, 137), 3);

  /* A hanging lap board over the bay. It reads from the court, and it is the
   * only thing above head height in sixty degrees of arcade - which is what
   * stops the run of machines feeling like it is standing under open sky. */
  const board = S.rig(90, 133, Math.PI);
  for (const x of [-13, 13]) {
    board.box('trim', 0.5, 8.6, 0.5, x, 4.3, 0);
    board.solid(x, 4.3, 0, 0.3, 4.3, 0.3);
  }
  board.box('panelDark', 27, 3.0, 0.7, 0, 7.1, 0);
  board.box(ctx.accent, 24, 1.6, 0.12, 0, 7.1, -0.42);
  board.box('emWhite', 25, 0.14, 0.4, 0, 5.4, -0.3);
  board.lamp(0, 6.2, -2.0, 0xc9b0ff, 900, 40);
}

/** One rank of treadmills at true 1.9 m centres, all of them in use. */
function treadRank(r, n, phase0) {
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * 1.9;
    r.prop('treadBody', x, 0, 0);
    r.prop('treadBelt', x, 0, 0);
    r.prop('treadRail', x, 0, 0);
    r.prop('treadScreen', x, 0, 0);
    /* Two colliders, not one. The deck is a 0.28 m step a player can walk
     * onto and the console mast is a wall at chest height; a single
     * full-height box would turn the whole rank into an unclimbable kerb with
     * a runner standing on thin air above it. */
    r.solid(x, 0.14, 0, 0.52, 0.14, 1.12);
    r.solid(x, 0.78, -0.90, 0.52, 0.78, 0.22);
    r.actor(x, 0.28, 0.22, {
      activity: 'run',
      speed: 0.82 + (i % 5) * 0.11,
      phase: phase0 + i * 1.37,
    });
  }
  r.contact(0, 0, n * 2.2);
}

/**
 * A rank of upright bikes.
 *
 * The riders are on `sit` with the saddle height as `amount`, which is the
 * closest honest answer the verb set has: there is no pedalling pose, and
 * `sit` at least solves the legs from the floor so the shoes land near the
 * cranks instead of inside the frame. Faking it with `row` would slide the
 * whole rider half a metre off the back of the bike every three seconds.
 */
function bikeRank(r, n, phase0) {
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * 2.1;
    r.prop('bikeBody', x, 0, 0);
    r.prop('bikeScreen', x, 0, 0);
    r.solid(x, 0.36, 0, 0.4, 0.36, 0.78);
    r.actor(x, 0, 0.26, { activity: 'sit', amount: 0.94, phase: phase0 + i * 2.11 });
  }
  r.contact(0, 0, n * 2.4);
}

function stepperRank(r, n) {
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * 2.2;
    r.prop('stepBody', x, 0, 0);
    r.solid(x, 0.24, 0, 0.4, 0.24, 0.58);
    r.solid(x, 0.9, -0.42, 0.16, 0.9, 0.16);
    r.actor(x, 0.47, 0.18, { activity: 'walk', speed: 0.55 + (i % 3) * 0.09, phase: i * 1.71 });
  }
  r.contact(0, 0, n * 2.6);
}

/* ------------------------------------------------------------------ */
/* Rowing tank                                                         */
/* ------------------------------------------------------------------ */

/**
 * Twelve ergs in two ranks, and the coaching stand they are pointed at.
 *
 * Rowing is the only activity in the set that moves the whole figure, and that
 * slide is what identifies the machine from across the zone - so these ranks
 * are laid out square and dense, all on one heading, precisely so the *phase*
 * differences between twelve sliding bodies become the thing you notice. It is
 * a shot no other bay in the gym can produce.
 */
function buildRowingTank(S) {
  const { ctx } = S;

  rowRank(S.rig(141, 150), 6, 0);
  rowRank(S.rig(153, 163), 6, 1.15);

  const stand = S.rig(147, 136, Math.PI);
  stand.box('panelDark', 5.0, 0.85, 3.4, 0, 0.42, 0);
  stand.box('trim', 5.3, 0.12, 3.7, 0, 0.90, 0);
  stand.solid(0, 0.45, 0, 2.6, 0.45, 1.75);
  // Rise toward the rig's back, i.e. up onto the dais from the court side.
  stand.ramp(0, 0.20, 3.6, 3.0, 2.4, 0.85, Math.PI);
  stand.box('trim', 0.4, 3.4, 0.4, 1.9, 2.6, 0);
  stand.box('panelDark', 2.4, 1.5, 0.34, 1.9, 4.4, 0);
  stand.box(ctx.accent, 2.0, 1.1, 0.1, 1.9, 4.4, -0.22);
  stand.solid(1.9, 2.6, 0, 0.24, 2.6, 0.24);
  stand.actor(-1.0, 0.85, 0, { activity: 'stand', phase: 3.3, localYaw: Math.PI });
  stand.roof(0, 0.95, 0);
  stand.lamp(0, 5.4, -1.0, 0xc9b0ff, 800, 34);
  stand.contact(0, 0, 9);

  waterPoint(S, S.rig(163, 141), true);
  lockerBank(S, S.rig(146, 183), 7, null);
  benchRow(S, S.rig(136, 176), 3);
}

/**
 * One rank of rowing ergs.
 *
 * The rower is registered at the *mid point* of the seat's travel, 0.45 m
 * behind the footplate. `_poseRow` swings the root from -0.275 to +0.275 along
 * the actor's own Z about wherever it is placed, so registering at the catch
 * would put the finish half a metre off the back of the rail; registering at
 * the middle keeps the whole stroke inside the machine, with the catch landing
 * exactly on the footplates the legs are solved against.
 */
function rowRank(r, n, phase0) {
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * 1.85;
    r.prop('rowBody', x, 0, 0);
    r.prop('rowSlide', x, 0, 0);
    r.solid(x, 0.30, 0, 0.34, 0.30, 1.32);
    r.actor(x, 0, -0.45, {
      activity: 'row',
      amount: 0.52,
      speed: 0.88 + (i % 4) * 0.1,
      phase: phase0 + i * 1.61,
    });
  }
  r.contact(0, 0, n * 2.2);
}

/* ------------------------------------------------------------------ */
/* Shared arcade fittings                                              */
/* ------------------------------------------------------------------ */

/**
 * A bank of lockers, doors instanced and carcass in the batch.
 *
 * Splitting it that way is the whole trick: the carcass is one box whichever
 * bank it belongs to, and the doors are the part there are fifty-odd of. The
 * bank top is at 2.44 m - just out of reach, and flat, which makes it the most
 * obvious place in the zone to have left something.
 */
function lockerBank(S, r, n, relicTier) {
  const { ctx } = S;
  const W = n * 0.52;
  r.box('panelDark', W + 0.2, 2.30, 0.60, 0, 1.15, 0);
  r.box('trim', W + 0.4, 0.14, 0.74, 0, 2.36, 0);
  r.box('trimDark', W + 0.2, 0.14, 0.66, 0, 0.07, 0);
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * 0.52;
    for (const y of [0.66, 1.76]) {
      r.prop('lockerDoor', x, y, -0.32);
      r.box('trim', 0.06, 0.12, 0.06, x + 0.17, y, -0.37);
    }
  }
  r.box(ctx.accent, W, 0.07, 0.07, 0, 1.22, -0.33);
  r.solid(0, 1.2, 0, W / 2 + 0.15, 1.2, 0.35);
  r.roof(0, 2.44, 0);
  if (relicTier) r.relic((n - 2) * 0.2, 2.6, 0, relicTier);
  r.actor(-W / 2 + 0.6, 0, -1.3, { activity: 'stand', phase: ctx.rng() * 6.28, localYaw: Math.PI });
  r.contact(0, -0.4, W + 3);
}

/** A water point: a chilled column, two spouts and a bottle shelf. */
function waterPoint(S, r, occupied) {
  const { ctx } = S;
  r.box('shell', 1.30, 1.30, 0.55, 0, 0.65, 0);
  r.box('trim', 1.42, 0.10, 0.68, 0, 1.34, 0);
  r.box('panelDark', 1.30, 0.85, 0.30, 0, 1.80, 0.16);
  r.box(ctx.accent, 1.00, 0.07, 0.07, 0, 1.42, -0.30);
  for (const s of [-1, 1]) {
    r.box('chrome', 0.07, 0.07, 0.28, s * 0.34, 1.10, -0.30);
    r.box('trimDark', 0.40, 0.06, 0.34, s * 0.34, 0.96, -0.24);
  }
  r.solid(0, 0.66, 0.05, 0.68, 0.66, 0.32);
  r.contact(0, 0, 4);
  if (occupied) r.actor(0.2, 0, -1.1, { activity: 'stand', phase: ctx.rng() * 6.28, localYaw: Math.PI });
}

/** A short run of parked benches - somewhere to sit between sets. */
function benchRow(S, r, n) {
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * 2.4;
    r.prop('benchFrame', x, 0, 0, Math.PI / 2);
    r.prop('benchPad', x, 0, 0, Math.PI / 2);
    r.solid(x, 0.26, 0, 0.78, 0.26, 0.34);
    if (i === 0) r.actor(x, 0, 0, { activity: 'sit', amount: 0.52, phase: 1.9 });
  }
  r.contact(0, 0, n * 2.6);
}

/** A matted stretching area with foam rollers and people using it. */
function stretchMats(S, r, n) {
  const { ctx } = S;
  r.floor('rubber', n * 2.2 + 1.6, 5.0, 0, 0, 0, 0.14, 3);
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * 2.2;
    r.box('rubber', 1.9, 0.07, 4.4, x, 0.17, 0);
    if (i % 2 === 0) r.put('rubber', cylGeo(0.14, 0.14, 0.62, 8, 1), x, 0.28, -1.9, 0, 0, Math.PI / 2);
    if (i < n - 1) {
      // `sit` at 0.24 m folds the legs right up, which is what somebody on a
      // mat looks like; the default 0.45 would be sitting on an invisible box.
      r.actor(x, 0.21, 0.4, {
        activity: i % 2 ? 'sit' : 'stand',
        amount: 0.24,
        phase: i * 2.6 + ctx.rng(),
        localYaw: (ctx.rng() - 0.5) * 0.6,
      });
    }
  }
  r.contact(0, 0, n * 3);
}

/* ------------------------------------------------------------------ */
/* Free weights                                                        */
/* ------------------------------------------------------------------ */

/**
 * The iron: mirrors, dumbbell racks, benches, squat racks and two platforms.
 *
 * This is the one bay that faces *outward*, and every rig in it is built with
 * `turn = PI`. Lifters watch their own form and the mirror run is on the
 * perimeter, so the whole bay is turned to look at it. That also means it
 * reads differently from the concourse - backs and mirrors rather than
 * consoles - so it cannot blur into the cardio deck at distance.
 */
function buildFreeWeights(S) {
  const { ctx } = S;

  /* --- Mirror run -------------------------------------------------------
   * Panels rather than one 200 m sheet. `M.mirror` is metalness 1.0 at
   * roughness 0.09 - it returns nothing but environment, and the only
   * environment in here is a starfield - so an unbroken run of it is a band
   * of dark with no scale in it at all. Broken every 10 m by a lit stile it
   * reads as a wall of mirrors, and the stiles carry the light the mirror
   * cannot. */
  for (let i = 0; i < 22; i++) {
    const m = S.rig(180 + i * 3.1, 190, Math.PI);
    // Turned about, the rig's +Z points at the gym floor - which is the only
    // side of a mirror worth drawing, and the only side the plane must face.
    m.put('mirror', quad(10.0, 3.4), 0, 2.3, 0);
    m.box('panelDark', 10.4, 4.4, 0.5, 0, 2.2, -0.32);
    m.box('trim', 10.4, 0.22, 0.7, 0, 4.5, -0.14);
    m.box('trim', 10.4, 0.30, 0.7, 0, 0.45, -0.14);
    if (i % 3 === 0) m.box('emWhite', 0.16, 3.6, 0.14, 5.1, 2.4, 0.16);
    m.solid(0, 2.3, -0.24, 5.2, 2.3, 0.45);
  }
  /* Behind the mirrors. There is a service void between the panel backs at
   * r = 190.4 and the inner face of the perimeter wall, which is exactly the
   * kind of place a player who tries the gap deserves to find something. */
  const [mrx, mrz] = bear(207, 194.4);
  ctx.relic(mrx, 1.5, mrz, 'rare');

  /* `RACK YOUR WEIGHTS` at both ends of the run. The two boards are 200 m of
   * arc apart, well outside the cluster the atlas was reorganised to protect
   * against - and a gym that says it once is a gym that does not mean it. */
  for (const deg of [184, 240]) {
    const s = S.rig(deg, 189.6, Math.PI);
    s.sign(34, 7.0, 1.75, 0, 5.6, 0.4, 0, { thickness: 0.2, accent: ctx.accent });
    s.lamp(0, 5.0, 3.0, 0xc9b0ff, 700, 32);
  }

  for (const [deg, r] of [[188, 176], [197, 178], [207, 176], [217, 178]]) {
    dumbbellRack(S, S.rig(deg, r, Math.PI));
  }
  benchCluster(S, S.rig(192, 161, Math.PI), 4, true);
  benchCluster(S, S.rig(203, 163, Math.PI), 4, false);
  benchCluster(S, S.rig(213, 165, Math.PI), 3, true);

  squatRack(S, S.rig(223, 171, Math.PI));
  squatRack(S, S.rig(231, 173, Math.PI));
  squatRack(S, S.rig(241, 169, Math.PI));
  deadliftPlatform(S, S.rig(227, 151, Math.PI), 'common');
  deadliftPlatform(S, S.rig(235, 153, Math.PI), null);
  barbellRack(S, S.rig(200, 186, Math.PI));
  barbellRack(S, S.rig(245, 181, Math.PI));
  for (const [deg, r] of [[229, 158], [238, 160], [219, 155]]) plateTree(S.rig(deg, r, Math.PI));
  chalkStand(S.rig(221, 147));
  chalkStand(S.rig(237, 146));
  waterPoint(S, S.rig(210, 140), true);
  waterPoint(S, S.rig(247, 143), false);

  /* Practicals. This is the deepest part of the arcade and the mirrors return
   * nothing on their own, so the bay needs its own key or seventy degrees of
   * it falls to the perimeter wash and photographs as a corridor. */
  for (const deg of [190, 206, 222, 238]) {
    const [lx, lz] = bear(deg, 168);
    S.lamp(lx, 9.5, lz, 0xffe0c0, 1500, 56);
  }
}

/** A two-tier dumbbell rack, graded, with two people working off it. */
function dumbbellRack(S, r) {
  const { ctx } = S;
  r.box('trimDark', 4.6, 0.30, 0.90, 0, 0.15, 0);
  for (const [ty, tz] of [[0.62, 0.28], [1.02, -0.02]]) {
    r.box('trimDark', 4.6, 0.14, 0.36, 0, ty, tz);
    r.box('trim', 4.6, 0.08, 0.10, 0, ty + 0.12, tz - 0.2);
  }
  for (const s of [-1, 1]) r.box('trimDark', 0.22, 1.10, 0.90, s * 2.3, 0.55, 0);
  r.solid(0, 0.6, 0, 2.45, 0.6, 0.55);
  /* Twelve pairs, graded. The bar length is fixed and the plates are not,
   * which is what makes a rack read as a rack rather than as a row of
   * identical objects. Instance scale is uniform so the whole dumbbell grows -
   * accurate enough at 40 cm, and it costs nothing. */
  for (let i = 0; i < 12; i++) {
    const tier = i < 6 ? 0 : 1;
    r.prop('dumbbell', ((i % 6) - 2.5) * 0.72, tier ? 1.14 : 0.74, tier ? -0.02 : 0.28,
      Math.PI / 2, 0.72 + i * 0.055);
  }
  r.actor(-1.5, 0, -1.5, { activity: 'curl', speed: 0.9, phase: ctx.rng() * 6.28 });
  r.actor(1.7, 0, -1.7, { activity: 'curl', speed: 1.12, phase: 2.9 + ctx.rng() });
  r.contact(0, -0.4, 8);
}

/**
 * A cluster of flat benches with somebody on most of them.
 *
 * `spotted` adds a standing figure behind one bench. It is the cheapest way to
 * make a weights room read as a room full of *people* rather than a room full
 * of exercises: two figures in a fixed relationship imply a conversation the
 * animation never has to actually perform. One bench per cluster is left
 * empty for the same reason - a fully occupied gym is a stock photograph.
 */
function benchCluster(S, r, n, spotted) {
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * 2.6;
    r.prop('benchFrame', x, 0, 0);
    r.prop('benchPad', x, 0, 0);
    r.solid(x, 0.26, 0, 0.34, 0.26, 0.78);
    if (i % 3 === 2) continue;
    r.actor(x, 0, 0.1, {
      activity: i % 2 ? 'curl' : 'sit',
      amount: 0.52,
      speed: 0.85 + i * 0.08,
      phase: i * 2.27,
    });
  }
  if (spotted) r.actor(((n - 1) / 2) * 2.6, 0, 1.5, { activity: 'stand', phase: 1.4, localYaw: Math.PI });
  r.contact(0, 0, n * 3);
}

/**
 * A squat rack: uprights, safety arms, a loaded bar and a lifter.
 *
 * The bar sits in the J-hooks at 1.48 m, which is where a bar racked for
 * squats actually sits, and the lifter stands 0.75 m in front of it. That is
 * deliberately *not* under the bar: `_poseLift` squats and stands with the
 * arms down, so a figure directly beneath a racked bar would put its head
 * through the bar twice a cycle.
 */
function squatRack(S, r) {
  const { ctx } = S;
  for (const s of [-1, 1]) {
    r.box('trimDark', 0.16, 2.45, 0.16, s * 0.85, 1.22, 0);
    r.box('trimDark', 0.20, 0.18, 1.60, s * 0.85, 0.09, 0.3);
    r.box('trim', 0.14, 0.10, 0.36, s * 0.85, 1.42, -0.24);      // J-hook
    r.box('trimDark', 0.12, 0.12, 1.10, s * 0.85, 0.95, -0.6);   // safety arm
    r.solid(s * 0.85, 1.22, 0.15, 0.14, 1.22, 0.85);
  }
  r.box('trimDark', 1.86, 0.14, 0.14, 0, 2.42, 0);
  r.prop('barbell', 0, 1.48, -0.16);
  for (const s of [-1, 1]) {
    for (let k = 0; k < 2; k++) r.prop('plate', s * (0.72 + k * 0.11), 1.48, -0.16, Math.PI / 2);
  }
  r.actor(0, 0, -0.75, { activity: 'lift', amount: 1.05, speed: 0.62, phase: ctx.rng() * 6.28 });
  r.actor(1.6, 0, -1.3, { activity: 'stand', phase: 4.2, localYaw: -0.6 });
  r.contact(0, -0.2, 7);
}

/**
 * A deadlift platform.
 *
 * Raised 0.14 m on rubber inside a hazard-striped surround, which is both what
 * a real platform is and what makes it findable from the concourse: it is the
 * only floor feature in the bay that is not flat. The lifter's `ly` is the
 * platform top, not the deck - get that wrong and the best animation in the
 * zone is performed ankle-deep in the floor.
 */
function deadliftPlatform(S, r, relicTier) {
  const { ctx } = S;
  r.box('hazard', 4.6, 0.14, 3.4, 0, 0.07, 0, 0, 1.6);
  r.box('rubber', 3.4, 0.06, 3.0, 0, 0.15, 0);
  r.solid(0, 0.07, 0, 2.3, 0.07, 1.7);
  r.prop('barbell', 0, 0.60, -0.1);
  for (const s of [-1, 1]) {
    for (let k = 0; k < 3; k++) r.prop('plate', s * (0.66 + k * 0.1), 0.60, -0.1, Math.PI / 2);
  }
  r.actor(0, 0.14, -0.72, { activity: 'lift', amount: 1.25, speed: 0.5, phase: ctx.rng() * 6.28 });
  r.actor(-2.0, 0, -1.4, { activity: 'stand', phase: 0.7, localYaw: 0.9 });
  r.roof(0, 0.16, 0);
  if (relicTier) r.relic(-1.9, 0.4, 1.4, relicTier);
  r.contact(0, 0, 10);
}

/** A vertical barbell rack, with two people pressing off the end of it. */
function barbellRack(S, r) {
  const { ctx } = S;
  r.box('trimDark', 2.6, 0.24, 0.9, 0, 0.12, 0);
  r.box('trimDark', 2.6, 0.16, 0.16, 0, 1.55, 0.3);
  for (let i = 0; i < 8; i++) {
    const x = (i - 3.5) * 0.3;
    r.box('chrome', 0.05, 1.72, 0.05, x, 1.0, 0.06);
    r.box('trimDark', 0.1, 0.1, 0.1, x, 0.28, 0.06);
  }
  r.solid(0, 0.85, 0.1, 1.35, 0.85, 0.5);
  r.actor(-1.9, 0, -1.0, { activity: 'press', speed: 0.8, phase: ctx.rng() * 6.28 });
  r.actor(1.9, 0, -1.0, { activity: 'press', speed: 1.05, phase: 3.4 });
  r.contact(0, 0, 6);
}

/** A plate tree, loaded heaviest at the bottom. */
function plateTree(r) {
  r.box('trimDark', 1.0, 0.20, 1.0, 0, 0.10, 0);
  r.box('trimDark', 0.20, 1.70, 0.20, 0, 0.85, 0);
  for (let i = 0; i < 3; i++) {
    for (const s of [-1, 1]) {
      r.box('trim', 0.5, 0.09, 0.09, s * 0.32, 0.45 + i * 0.5, 0);
      for (let k = 0; k < 2; k++) {
        r.prop('plate', s * (0.34 + k * 0.12), 0.45 + i * 0.5, 0, Math.PI / 2, 0.9 - i * 0.14);
      }
    }
  }
  r.solid(0, 0.85, 0, 0.55, 0.85, 0.5);
  r.contact(0, 0, 4);
}

/** Chalk stand: a plinth, a bowl and the dust everybody spills round it. */
function chalkStand(r) {
  r.box('shell', 0.85, 0.95, 0.85, 0, 0.48, 0);
  r.box('trim', 0.95, 0.08, 0.95, 0, 0.99, 0);
  r.put('panelWarm', cylGeo(0.26, 0.26, 0.22, 10, 1), 0, 1.12, 0);
  r.solid(0, 0.5, 0, 0.45, 0.5, 0.45);
  /* The spill, as a pale quad rather than a grime patch: `M.grime` multiplies
   * against the deck and can only ever darken it, and chalk is the one mark on
   * this floor that is lighter than what it lands on. */
  r.floor('plaza', 3.2, 3.2, 0, 0, 0, 0.14, 3);
  r.contact(0, 0, 3.4);
}

/* ------------------------------------------------------------------ */
/* Machine hall                                                        */
/* ------------------------------------------------------------------ */

/**
 * Resistance machines, including the two that could not exist.
 *
 * Cable machines are the hardest thing in a gym to model cheaply, because what
 * identifies them is a *cable* - a metre and a half of 8 mm line that costs
 * more triangles than the frame holding it. So these towers are built around
 * their weight stacks and pulley heads instead, and the run between is a
 * single thin box: at any distance a player can actually stand, a straight box
 * is a straight cable, and it is the stack that says what the machine is.
 */
function buildMachineHall(S) {
  const { ctx } = S;

  for (const [deg, r] of [[258, 172], [266, 176], [287, 176], [296, 170]]) {
    cableTower(S, S.rig(deg, r));
  }
  latPulldown(S, S.rig(262, 152));
  latPulldown(S, S.rig(292, 154));
  legPress(S, S.rig(272, 161));
  legPress(S, S.rig(282, 158));
  pecDeck(S, S.rig(276, 142));
  pecDeck(S, S.rig(288, 144));

  /* --- The gravity well -------------------------------------------------
   * A magnetic-gradient rig: you stand in the ring and it pulls, so the
   * resistance has no mass and no stack. It earns its place by being the only
   * hardware in the zone with a lit interior, which is what makes an
   * otherwise grey machine hall worth walking into rather than past. */
  for (const [deg, r] of [[269, 138], [280, 136]]) {
    const w = S.rig(deg, r);
    w.box('panelDark', 3.0, 0.55, 3.0, 0, 0.27, 0);
    w.box('hazard', 3.4, 0.10, 3.4, 0, 0.06, 0, 0, 1.4);
    for (const s of [-1, 1]) {
      w.box('shell', 0.42, 3.3, 0.42, s * 1.25, 1.9, 0.9);
      w.solid(s * 1.25, 1.9, 0.9, 0.24, 1.9, 0.24);
    }
    const ring = new THREE.TorusGeometry(1.25, 0.14, 6, 24);
    ring.rotateX(-Math.PI / 2);
    uvScale(ring, 12, 1);
    w.put('trim', ring, 0, 3.4, 0.9);
    const glow = new THREE.TorusGeometry(1.25, 0.05, 5, 24);
    glow.rotateX(-Math.PI / 2);
    w.put(ctx.accent, glow, 0, 3.22, 0.9);
    w.put('holo', new THREE.CylinderGeometry(1.2, 1.2, 2.6, 16, 1, true), 0, 1.9, 0.9);
    w.solid(0, 0.28, 0, 1.6, 0.28, 1.6);
    w.actor(0, 0.55, 0.9, { activity: 'press', speed: 0.66, phase: ctx.rng() * 6.28 });
    w.lamp(0, 2.4, 0.9, 0xc9b0ff, 520, 22);
    w.contact(0, 0.4, 7);
  }

  lockerBank(S, S.rig(268, 186), 8, 'common');
  waterPoint(S, S.rig(300, 140), true);
  benchRow(S, S.rig(255, 145), 3);

  for (const deg of [262, 278, 296]) {
    const [lx, lz] = bear(deg, 162);
    S.lamp(lx, 9.5, lz, 0xd6e4ff, 1350, 52);
  }
}

function cableTower(S, r) {
  const { ctx } = S;
  r.box('trimDark', 2.9, 0.30, 1.30, 0, 0.15, 0);
  for (const s of [-1, 1]) {
    r.box('trimDark', 0.20, 3.20, 0.20, s * 1.30, 1.60, 0);
    // The stack, in its guides. Two plates showing daylight under them is what
    // says "set to 40 kg" rather than "grey box".
    r.box('panelDark', 0.46, 1.40, 0.52, s * 1.30, 0.86, 0.42);
    for (let k = 0; k < 5; k++) r.box('trim', 0.50, 0.11, 0.56, s * 1.30, 0.28 + k * 0.15, 0.42);
    r.box('trim', 0.16, 0.16, 0.16, s * 1.30, 3.05, -0.16);       // pulley head
    r.box('chrome', 0.035, 1.45, 0.035, s * 1.30, 2.30, -0.20);   // the cable
    r.box('trimDark', 0.30, 0.06, 0.06, s * 1.30, 1.56, -0.22);   // handle
    r.solid(s * 1.30, 1.6, 0.2, 0.35, 1.6, 0.45);
  }
  r.box('trimDark', 2.90, 0.18, 0.18, 0, 3.18, -0.1);
  r.box(ctx.accent, 2.20, 0.08, 0.08, 0, 3.02, -0.22);
  // One faces the stack and one faces away, which is how a dual cable station
  // is genuinely used - and it stops the pair reading as a mirrored decal.
  r.actor(-0.55, 0, -0.9, { activity: 'curl', speed: 0.95, phase: ctx.rng() * 6.28, localYaw: Math.PI });
  r.actor(0.60, 0, -0.9, { activity: 'press', speed: 0.82, phase: 2.4 + ctx.rng() });
  r.contact(0, -0.3, 7);
}

function latPulldown(S, r) {
  const { ctx } = S;
  r.box('trimDark', 1.30, 0.24, 1.90, 0, 0.12, 0);
  r.box('trimDark', 0.24, 2.30, 0.24, 0, 1.15, -0.80);
  r.box('panelDark', 0.44, 1.20, 0.48, 0, 0.76, -0.62);
  for (let k = 0; k < 4; k++) r.box('trim', 0.48, 0.11, 0.52, 0, 0.28 + k * 0.16, -0.62);
  r.box('trimDark', 1.10, 0.18, 0.18, 0, 2.28, -0.3);
  r.box('chrome', 0.035, 0.90, 0.035, 0, 1.80, 0.05);
  r.box('chrome', 0.90, 0.05, 0.05, 0, 1.36, 0.05);             // the bar
  r.box('rubber', 0.40, 0.10, 0.44, 0, 0.62, 0.30);             // seat, top 0.67
  r.box('trimDark', 0.52, 0.14, 0.20, 0, 0.95, -0.05);          // thigh pad
  r.solid(0, 0.9, -0.3, 0.7, 0.9, 1.0);
  r.actor(0, 0, 0.30, { activity: 'sit', amount: 0.67, phase: ctx.rng() * 6.28 });
  r.contact(0, 0, 5);
}

/**
 * A 45-degree leg press.
 *
 * The rails are the machine: two long boxes pitched off the deck are instantly
 * readable as a leg press and as nothing else. `rz` pitches a box about its
 * own Z (which is what tilts the *plate*, whose normal is Z) and `rx` about
 * its X (which is what tilts the *rails*, whose length is Z) - two different
 * angles for the same incline, and swapping them yields a machine folded in
 * half sideways.
 */
function legPress(S, r) {
  const { ctx } = S;
  const PITCH = 0.62;
  for (const s of [-1, 1]) {
    r.put('trimDark', boxGeo(0.16, 0.16, 3.40, 1.2), s * 0.55, 1.30, 0.35, 0, PITCH);
    r.box('trimDark', 0.20, 0.60, 0.20, s * 0.55, 0.30, 1.60);
  }
  r.box('trimDark', 1.50, 0.26, 0.90, 0, 0.13, 1.55);
  r.box('rubber', 0.56, 0.14, 1.10, 0, 0.58, 0.95);             // back pad, top 0.65
  r.box('trimDark', 0.70, 0.20, 0.60, 0, 0.34, 0.55);
  r.put('trimDark', boxGeo(1.30, 0.90, 0.24, 1.2), 0, 2.20, -0.70, 0, PITCH);
  for (let k = 0; k < 3; k++) r.prop('plate', 0, 2.25 + k * 0.02, -0.52 - k * 0.14, Math.PI / 2, 0.95);
  r.solid(0, 0.8, 0.6, 0.8, 0.8, 1.9);
  // `sit` puts the feet on the floor rather than on the sled, which is the one
  // compromise in the bay. It still reads as a person in the machine, and the
  // alternative - `lift`, a standing squat - reads as a person beside it.
  r.actor(0, 0, 0.95, { activity: 'sit', amount: 0.65, phase: ctx.rng() * 6.28 });
  r.contact(0, 0.6, 6);
}

function pecDeck(S, r) {
  const { ctx } = S;
  r.box('trimDark', 1.10, 0.22, 1.30, 0, 0.11, 0);
  r.box('trimDark', 0.24, 1.90, 0.24, 0, 0.95, 0.55);
  r.box('panelDark', 0.42, 1.00, 0.46, 0, 0.66, 0.72);
  for (let k = 0; k < 4; k++) r.box('trim', 0.46, 0.10, 0.50, 0, 0.26 + k * 0.14, 0.72);
  r.box('rubber', 0.42, 0.12, 0.44, 0, 0.60, -0.05);            // seat, top 0.66
  r.box('rubber', 0.40, 0.70, 0.14, 0, 1.15, 0.34);             // back pad
  for (const s of [-1, 1]) {
    r.box('trimDark', 0.10, 0.10, 0.86, s * 0.34, 1.55, 0.2, s * 0.5);
    r.box('rubber', 0.12, 0.34, 0.12, s * 0.66, 1.30, -0.18);   // arm pad
  }
  r.solid(0, 0.8, 0.3, 0.6, 0.8, 0.8);
  r.actor(0, 0, -0.05, { activity: 'sit', amount: 0.66, phase: ctx.rng() * 6.28 });
  r.contact(0, 0, 5);
}

/* ------------------------------------------------------------------ */
/* Recovery                                                            */
/* ------------------------------------------------------------------ */

/**
 * Physio, stretching and the rest of the lockers.
 *
 * The physio bay is the only enclosed room in the zone, and that is its point:
 * a kilometre of arcade with no walls in it has no sense of interior at all,
 * so one glazed cubicle with a lit card behind the glass gives the whole band
 * a reference for what "inside" looks like out here.
 */
function buildRecovery(S) {
  const p = S.rig(320, 174);
  const W = 13, D = 8.4, H = 3.4;

  p.box('panel', W, H, 0.45, 0, H / 2, D / 2);
  p.box('panel', 0.45, H, D, -W / 2, H / 2, 0);
  p.box('panel', 0.45, H, D, W / 2, H / 2, 0);
  p.box('panelDark', W + 0.9, 0.55, D + 0.9, 0, H + 0.27, 0);
  // Front glazing split either side of a 2.6 m opening, so the room is
  // enterable rather than a picture of a room.
  for (const s of [-1, 1]) {
    p.box('glassWindow', (W - 2.6) / 2, H - 0.5, 0.12, s * (W / 4 + 0.65), (H - 0.5) / 2 + 0.3, -D / 2);
    p.box('trim', 0.3, H, 0.4, s * 1.3, H / 2, -D / 2);
    p.solid(s * (W / 4 + 0.65), H / 2, -D / 2, (W - 2.6) / 4, H / 2, 0.2);
  }
  const card = new THREE.PlaneGeometry(W - 1.6, H - 1.2);
  atlasUV(card, 2, 1, 4, 4);
  p.put('room', card, 0, 1.9, D / 2 - 0.3, Math.PI);
  p.solid(0, H / 2, D / 2, W / 2, H / 2, 0.3);
  p.solid(-W / 2, H / 2, 0, 0.3, H / 2, D / 2);
  p.solid(W / 2, H / 2, 0, 0.3, H / 2, D / 2);
  p.solid(0, H + 0.28, 0, W / 2 + 0.45, 0.28, D / 2 + 0.45);
  p.roof(0, H + 0.56, 0);
  p.relic(4.2, H + 0.75, 1.6, 'rare');
  for (const s of [-1, 1]) {
    p.box('trimDark', 0.80, 0.55, 2.10, s * 3.4, 0.28, 1.2);
    p.box('rubber', 0.74, 0.10, 2.00, s * 3.4, 0.60, 1.2);
    p.solid(s * 3.4, 0.32, 1.2, 0.42, 0.32, 1.06);
    p.actor(s * 3.4, 0, 0.5, { activity: 'sit', amount: 0.65, phase: 1.2 + s * 2.0 });
  }
  p.actor(0, 0, 0.9, { activity: 'stand', phase: 4.4 });
  p.lamp(0, 2.9, 0, 0xe4f0ff, 700, 26);
  p.contact(0, 0, 20);

  stretchMats(S, S.rig(331, 158), 4);
  stretchMats(S, S.rig(340, 152), 3);
  lockerBank(S, S.rig(314, 186), 8, null);
  lockerBank(S, S.rig(337, 184), 7, 'common');
  waterPoint(S, S.rig(344, 148), true);
  benchRow(S, S.rig(327, 141), 3);
}

/* ------------------------------------------------------------------ */
/* The court                                                           */
/* ------------------------------------------------------------------ */

/**
 * Everything inside r = 112: the track, the centrifuge, the climbing tower and
 * the combat platform.
 *
 * This is the half of the zone that has to work at 200 m, and the rule that
 * follows is: four large objects, well separated, each with a distinct
 * silhouette. Six would be clutter and two would be a car park. The drum is
 * horizontal and round, the tower vertical and flat, the platform low and
 * octagonal, the track a line on the floor - no two are confusable at any
 * distance, which is what a plan read from the corridor mouth needs.
 */
function buildCourt(S) {
  buildTrack(S);
  buildCentrifuge(S);
  buildClimbingTower(S);
  buildCombatPlatform(S);
}

/**
 * The running track.
 *
 * At r = 102 with a 12 m surface it sits just inside the court edge, so it
 * frames the middle rather than competing with it - and the accent hoop
 * `buildZone` already lays at r = 62 stays visible as the infield marker.
 * Running the track further in would have buried that hoop under the surface.
 */
function buildTrack(S) {
  const { ctx } = S;
  const R0 = TRACK_R - TRACK_HALF, R1 = TRACK_R + TRACK_HALF;

  const surf = new THREE.RingGeometry(R0, R1, 96, 1);
  surf.rotateX(-Math.PI / 2);
  uvScale(surf, (R1 - R0) / 6, (R1 - R0) / 6);
  ctx.put('panelWarm', surf, 0, 0.30, 0);

  /* Kerbs. The inner one is what a track actually has and the outer keeps the
   * ring from bleeding into the concourse paving; both are also what stop a
   * 12 m band of flat colour reading as a decal. */
  for (const [rr, key] of [[R0, 'trim'], [R1, 'trimDark']]) {
    const k = new THREE.TorusGeometry(rr, 0.16, 5, 96);
    k.rotateX(-Math.PI / 2);
    uvScale(k, rr, 1);
    ctx.put(key, k, 0, 0.32, 0);
  }
  for (const rr of [TRACK_R - 3, TRACK_R, TRACK_R + 3]) {
    const lane = new THREE.RingGeometry(rr - 0.07, rr + 0.07, 72, 1);
    lane.rotateX(-Math.PI / 2);
    ctx.put('emDim', lane, 0, 0.34, 0);
  }
  /* The ring is a 0.30 m step. One collider per 20 degrees rather than per
   * ring segment: a 36 m chord on a 102 m circle deviates by 1.6 m, the deck
   * either side is solid at 0.02 anyway, and a broadphase list of eighteen
   * boxes is worth far more than the last centimetre of the curve. */
  for (let i = 0; i < 18; i++) {
    const deg = (i / 18) * 360 + 10;
    const [lx, lz] = bear(deg, TRACK_R);
    ctx.solid(lx, 0.15, lz, ((Math.PI * 2 * TRACK_R) / 18) * 0.52, 0.15, TRACK_HALF, deg * D2R);
  }

  /* Runners. `run` does not translate - nothing in `StationActors` does - so a
   * track full of them is a frozen field rather than a race. Spacing them
   * unevenly and giving each a different rate is what turns that from a defect
   * into a photograph: a real field is strung out, and no two runners in one
   * are ever on the same stride. */
  [0, 21, 37, 58, 81, 96, 118, 147, 178, 203, 229, 301].forEach((deg, i) => {
    const [lx, lz] = bear(deg, TRACK_R + ((i % 3) - 1) * 3);
    ctx.actor(lx, 0.32, lz, {
      activity: 'run',
      // Anticlockwise, which is the direction every track on the ring runs.
      localYaw: deg * D2R + Math.PI / 2,
      speed: 0.9 + (i % 5) * 0.14,
      phase: i * 1.43,
    });
  });

  ctx.mmCircle(0, 0, TRACK_R, null, 'rgba(214,174,131,0.5)');
}

/**
 * The centrifuge - a 30 m drum lying on its side at the centre of the court.
 *
 * The premise is spin-gravity conditioning, so crew coming off long micro-g
 * rotations can load their skeletons back up. It is the largest single object
 * in the zone and it is at the exact centre because it is what the whole court
 * is composed around: the track rings it, the tower and the platform flank it,
 * and it is what the treadmill bank 150 m away is pointed at.
 *
 * Cost is kept down by the shape doing the work rather than the detail. The
 * shell is two open-ended 24-segment cylinders - one FrontSide for the outside
 * and one BackSide for the inside, because a single-sided tube seen from
 * within is a hole in the world - and everything else is boxes.
 */
function buildCentrifuge(S) {
  const { ctx } = S;
  const AXIS_Y = 21, RAD = 15, HALF_L = 12;
  const FLOOR_Y = 7.5;
  /* Half-width of the walkable chord: sqrt(RAD^2 - (AXIS_Y - FLOOR_Y)^2),
   * rounded in. Derived rather than guessed, because a floor plate wider than
   * its own chord pokes out through the drum wall in two places nobody checks. */
  const FLOOR_HALF = 6.4;

  const d = S.rigXZ(0, 0, 0);

  /* `rz = PI/2` lays the cylinder's own Y axis onto the rig's X, which is what
   * puts the open ends where the access gantry can reach them. */
  d.put('shell', cylGeo(RAD + 0.6, RAD + 0.6, HALF_L * 2, 24, 5, true), 0, AXIS_Y, 0, 0, 0, Math.PI / 2);
  d.put('hullIn', cylGeo(RAD, RAD, HALF_L * 2 - 0.2, 24, 4, true), 0, AXIS_Y, 0, 0, 0, Math.PI / 2);

  // End rims. A RingGeometry faces its own +Z, so a quarter turn in yaw stands
  // it across the drum axis; the ends take opposite turns so each shows its
  // front face outward rather than a mirrored back.
  for (const s of [-1, 1]) {
    const rim = new THREE.RingGeometry(RAD + 0.5, RAD + 2.4, 28, 1);
    uvScale(rim, 4, 4);
    d.put('trim', rim, s * HALF_L, AXIS_Y, 0, (s * Math.PI) / 2);
    d.put('panelDark', cylGeo(RAD + 2.4, RAD + 2.4, 1.1, 28, 4, true), s * (HALF_L - 0.5), AXIS_Y, 0, 0, 0, Math.PI / 2);
  }

  /* Ribs, and a lit bead that advances as it goes round. A line that spirals
   * is the only cue available for "this rotates" without actually turning
   * fifteen hundred triangles every frame. */
  for (let i = 0; i < 10; i++) {
    const x = -HALF_L + 1.2 + i * ((HALF_L * 2 - 2.4) / 9);
    d.put('beam', cylGeo(RAD + 1.0, RAD + 1.0, 0.5, 24, 3, true), x, AXIS_Y, 0, 0, 0, Math.PI / 2);
    const a = (i / 10) * Math.PI * 2;
    d.box(ctx.accent, 0.5, 0.5, 0.5, x, AXIS_Y + Math.cos(a) * (RAD + 1.3), Math.sin(a) * (RAD + 1.3));
  }

  /* Trestles. Legs splay in Z, which is `rx` and not `rz` - `rz` would splay
   * them along the drum's own axis, where they would stand inside it. They
   * meet the shell at 45 degrees below the axis, which is where a cradle for a
   * drum this size actually goes, and they are the only part of the assembly
   * that touches the deck. */
  for (const s of [-1, 1]) {
    const x = s * (HALF_L - 1.2);
    for (const t of [-1, 1]) {
      d.put('beam', boxGeo(2.2, 11.7, 2.2, 5), x, 5.2, t * 13.3, 0, -t * 0.48, 0);
      d.solid(x, 5.2, t * 13.3, 1.3, 5.9, 1.7);
      d.put('trimDark', cylGeo(1.3, 1.3, 3.0, 10, 3), x, 10.4, t * 10.8, 0, 0, Math.PI / 2);
    }
    d.box('panelDark', 3.4, 1.2, 34, x, 0.6, 0);
    d.solid(x, 0.6, 0, 1.7, 0.6, 17);
  }
  d.box('hazard', 30, 0.12, 34, 0, 0.06, 0, 0, 2.5);

  /* --- Access -----------------------------------------------------------
   * Twenty metres of run for seven and a half of rise - about 21 degrees -
   * up to a landing level with the drum floor, then a bridge in through the
   * -X mouth. The alternative was a ladder, and a `prize` relic at the top of
   * a ladder is a relic nobody ever collects. */
  const RUN = 20, RISE = 7.5;
  const PITCH = Math.atan2(RISE, RUN);
  // Rise toward +X, which is `ry = PI/2`: `_ramp` lifts the proxy's +Z end and
  // then yaws it, so the gradient runs along (sin ry, cos ry).
  d.ramp(-27, RISE / 2 - 0.23, 0, 3.4, RUN, RISE, Math.PI / 2);
  d.put('grate', boxGeo(21.3, 0.4, 3.4, 3), -27, RISE / 2 - 0.20, 0, 0, 0, PITCH);
  for (const t of [-1, 1]) {
    for (let i = 0; i < 7; i++) {
      const x = -36 + i * 3.1;
      d.box('trim', 0.14, 1.1, 0.14, x, 0.55 + (x + 37) * (RISE / RUN), t * 1.6);
    }
    d.put('trim', boxGeo(21.3, 0.12, 0.12, 1), -27, RISE / 2 + 0.9, t * 1.6, 0, 0, PITCH);
  }
  d.box('panelDark', 6.0, 0.5, 5.0, -19.5, 7.25, 0);
  d.solid(-19.5, 7.25, 0, 3.0, 0.25, 2.5);
  d.box('trim', 0.14, 1.1, 5.0, -22.4, 8.05, 0);
  d.roof(-19.5, 7.5, 0);
  d.relic(-19.5, 7.8, 1.8, 'rare');
  for (const t of [-1, 1]) {
    d.box('beam', 1.0, 7.4, 1.0, -21.6, 3.7, t * 2.2);
    d.solid(-21.6, 3.7, t * 2.2, 0.6, 3.7, 0.6);
  }
  d.box('grate', 8.0, 0.35, 3.2, -15.6, 7.32, 0, 0, 3);
  d.solid(-15.6, 7.32, 0, 4.0, 0.18, 1.6);
  d.box('grate', HALF_L * 2 - 1.0, 0.35, FLOOR_HALF * 2, 0, 7.32, 0, 0, 4);
  d.solid(0, 7.32, 0, HALF_L - 0.5, 0.18, FLOOR_HALF);
  d.roof(0, 7.5, 0);
  d.relic(4.5, 7.9, 3.4, 'prize');
  for (const t of [-1, 1]) {
    d.box('trim', HALF_L * 2 - 1.0, 0.10, 0.10, 0, 8.5, t * (FLOOR_HALF - 0.2));
    d.box(ctx.accent, HALF_L * 2 - 1.4, 0.06, 0.06, 0, 7.62, t * (FLOOR_HALF - 0.3));
  }

  /* Four runners inside, staggered along the drum and facing alternate ways.
   * They are the reason the floor plate is 13 m wide rather than a catwalk: a
   * figure in a 30 m drum needs space around it or the drum has no scale. */
  for (let i = 0; i < 4; i++) {
    d.actor(-7.5 + i * 5, FLOOR_Y, (i % 2 ? 1 : -1) * 2.4, {
      activity: 'run',
      localYaw: (i % 2 ? 1 : -1) * (Math.PI / 2),
      speed: 0.95 + i * 0.12,
      phase: i * 1.83,
    });
  }
  for (const x of [-7, 0, 7]) d.lamp(x, FLOOR_Y + 4.5, 0, 0xc9b0ff, 900, 30);

  /* --- The mast --------------------------------------------------------
   * The one thing in this zone visible from the hub end of the link. A 44 m
   * mast off the drum crown carrying a four-face board: it is the zone's
   * landmark, it is legible at 400 m, and it costs about 200 triangles. */
  d.box('beam', 1.6, 9.0, 1.6, 0, 40.5, 0);
  d.solid(0, 40.5, 0, 0.9, 4.5, 0.9);
  for (let f = 0; f < 4; f++) {
    const ry = (f / 4) * Math.PI * 2;
    const nx = Math.sin(ry), nz = Math.cos(ry);
    d.box('panelDark', 6.4, 3.2, 0.5, nx * 1.0, 43.4, nz * 1.0, ry);
    d.put(ctx.accent, quad(5.6, 2.4), nx * 1.28, 43.4, nz * 1.28, ry);
  }
  d.box('emWhite', 5.0, 0.16, 5.0, 0, 41.4, 0);
  S.lamp(0, 38, 0, 0xc9b0ff, 2600, 90);

  ctx.mmCircle(0, 0, 17, 'rgba(150,120,200,0.4)', 'rgba(225,205,255,0.75)');
  ctx.contact(0, 0, 70);
}

/**
 * The climbing tower.
 *
 * Three leaves, each stepping further out over the deck than the one below, so
 * the silhouette from the concourse is a slab that *overhangs* rather than a
 * rectangle. That is both what a competition wall looks like and the only way
 * a flat object reads as a climbing wall from a hundred metres.
 *
 * The switchback stair up the back is not decoration. There is a `prize` relic
 * on the top platform, and a collectable a player can see but cannot reach is
 * worse than no collectable at all.
 */
function buildClimbingTower(S) {
  const { ctx } = S;
  const t = S.rig(205, 78);
  const W = 26;

  for (const [y, h, z] of [[4.4, 8.8, 0], [13.2, 8.8, -1.6], [21.6, 8.0, -3.4]]) {
    t.box('panel', W, h, 1.4, 0, y, z, 0, 3);
    t.box('trim', W + 0.5, 0.3, 1.7, 0, y + h / 2, z);
    t.solid(0, y, z, W / 2, h / 2, 0.9);
  }
  t.box('panelDark', W + 2.2, 1.0, 4.6, 0, 0.5, 0.6);
  t.solid(0, 0.5, 0.6, W / 2 + 1.1, 0.5, 2.3);
  for (const s of [-1, 1]) {
    t.box('trimDark', 1.2, 25.6, 1.6, s * (W / 2 + 0.4), 12.8, -0.8);
    t.solid(s * (W / 2 + 0.4), 12.8, -0.8, 0.6, 12.8, 0.8);
  }
  // Crash matting. `rubber` again, so 30 m of it is not also 30 m of collider.
  t.box('rubber', W + 3, 0.34, 5.0, 0, 0.22, -3.6);

  /* Holds, scattered deterministically but rejected against a 1.05 m spacing
   * and pulled toward six vertical lines. Holds placed at random have no
   * routes in them, and a route is the only thing that says "this is climbed"
   * rather than "this is textured". */
  const placed = [];
  for (let i = 0; i < 240 && placed.length < 110; i++) {
    const route = Math.floor(ctx.rng() * 6);
    const y = 1.4 + ctx.rng() * 23.4;
    const lift = y < 8.8 ? 0 : y < 17.6 ? -1.6 : -3.4;
    const x = (route - 2.5) * 4.0 + Math.sin(y * 0.7 + route) * 1.3 + (ctx.rng() - 0.5) * 0.8;
    if (Math.abs(x) > W / 2 - 0.8) continue;
    if (placed.some((p) => Math.hypot(p[0] - x, p[1] - y) < 1.05)) continue;
    placed.push([x, y]);
    t.prop('hold', x, y, lift - 0.78, ctx.rng() * 6.28, 0.7 + ctx.rng() * 0.6);
  }

  // Top-out platform, deep enough to overhang the wall face and to meet the
  // stair landing behind it.
  t.box('grate', W, 0.5, 10, 0, 25.85, 1.2, 0, 4);
  t.solid(0, 25.85, 1.2, W / 2, 0.25, 5);
  for (const s of [-1, 1]) t.box('trim', W, 0.12, 0.12, 0, 27.1, 1.2 + s * 4.9);
  t.roof(0, 26.1, 1.2);
  t.relic(9.4, 26.5, 2.6, 'prize');
  t.box(ctx.accent, W - 2, 0.12, 0.4, 0, 26.3, -3.6);

  /* Three flights of 8.7 m on a 16 m run - 29 degrees, steep but walkable -
   * alternating direction, which is also the only vertical rhythm the back of
   * the tower has. */
  const PITCH = Math.atan2(8.7, 16);
  for (let f = 0; f < 3; f++) {
    const dir = f % 2 ? -1 : 1;
    const y0 = f * 8.7;
    t.ramp(0, y0 + 4.35 - 0.23, 7.4, 3.0, 16, 8.7, (dir * Math.PI) / 2);
    t.put('grate', boxGeo(17, 0.4, 3.0, 3), 0, y0 + 4.15, 7.4, 0, 0, dir * PITCH);
    t.box('panelDark', 4.4, 0.5, 3.6, dir * 10.5, y0 + 8.7, 7.4);
    t.solid(dir * 10.5, y0 + 8.7, 7.4, 2.2, 0.25, 1.8);
    for (const s of [-1, 1]) {
      t.put('trim', boxGeo(17, 0.12, 0.12, 1), 0, y0 + 5.45, 7.4 + s * 1.6, 0, 0, dir * PITCH);
    }
    t.box('beam', 0.9, y0 + 8.7, 0.9, dir * 10.5, (y0 + 8.7) / 2, 7.4);
    t.solid(dir * 10.5, (y0 + 8.7) / 2, 7.4, 0.5, (y0 + 8.7) / 2, 0.5);
  }
  t.roof(-10.5, 8.95, 7.4);

  t.actor(-6.0, 0, -4.6, { activity: 'stand', phase: 0.6, localYaw: Math.PI });
  t.actor(1.4, 0, -5.2, { activity: 'stand', phase: 3.9, localYaw: Math.PI + 0.3 });
  t.actor(7.8, 0, -4.4, { activity: 'talk', phase: 1.7, localYaw: Math.PI - 0.4 });
  t.actor(-9.6, 0, -3.9, { activity: 'talk', phase: 5.0, localYaw: Math.PI + 0.5 });
  t.actor(-4.2, 26.1, -1.6, { activity: 'stand', phase: 2.3, localYaw: Math.PI });
  t.actor(3.6, 26.1, -1.4, { activity: 'stand', phase: 4.8, localYaw: Math.PI - 0.2 });

  t.lamp(0, 22, -8, 0xe6d0ff, 2000, 60);
  t.lamp(0, 6, -8, 0xd6e4ff, 1100, 40);
  t.contact(0, -1, 40);
  const [mx, mz] = bear(205, 78);
  ctx.mmRect(mx, mz, W, 10, 205 * D2R, 'rgba(120,130,170,0.5)', 'rgba(200,215,255,0.6)');
}

/**
 * The combat platform: a raised octagon with a mat, posts and ropes.
 *
 * `hammer` is doing duty as a strike. It was written for a rivet gun, but the
 * shape of it - a slow raise and a fast drop with the weight following the arm
 * down - is as much a punch as a hammer blow, and it is the only asymmetric,
 * percussive pose in the set. The two figures are given phases half a cycle
 * apart so they trade rather than mirror.
 */
function buildCombatPlatform(S) {
  const { ctx } = S;
  const c = S.rig(305, 66);
  const R = 7.2;

  c.put('panelDark', cylGeo(R, R + 0.4, 1.05, 8, 4), 0, 0.52, 0, Math.PI / 8);
  c.put('rubber', cylGeo(R - 0.5, R - 0.5, 0.10, 8, 3), 0, 1.10, 0, Math.PI / 8);
  c.put('trim', cylGeo(R + 0.1, R + 0.1, 0.16, 8, 2), 0, 1.06, 0, Math.PI / 8);
  c.solid(0, 0.52, 0, R, 0.52, R);
  c.box('panelDark', 3.4, 0.36, 1.2, 0, 0.18, -R - 0.6);
  c.solid(0, 0.18, -R - 0.6, 1.7, 0.18, 0.6);
  c.box('panelDark', 3.4, 0.72, 1.2, 0, 0.36, -R + 0.5);
  c.solid(0, 0.36, -R + 0.5, 1.7, 0.36, 0.6);
  c.roof(0, 1.15, 0);

  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const b = ((i + 1) / 8) * Math.PI * 2 + Math.PI / 8;
    const px = Math.sin(a) * (R - 0.35), pz = Math.cos(a) * (R - 0.35);
    const qx = Math.sin(b) * (R - 0.35), qz = Math.cos(b) * (R - 0.35);
    c.box('trimDark', 0.24, 1.45, 0.24, px, 1.82, pz, a);
    c.box(ctx.accent, 0.30, 0.10, 0.30, px, 2.58, pz, a);
    // Two rope runs. Three would be correct and would cost half again as much
    // for a line nobody can resolve past twenty metres.
    const len = Math.hypot(qx - px, qz - pz);
    const my = Math.atan2(qx - px, qz - pz);
    for (const ropeY of [1.55, 2.25]) {
      c.box('rubber', 0.09, 0.09, len, (px + qx) / 2, ropeY, (pz + qz) / 2, my);
    }
  }

  c.actor(-1.5, 1.15, 0.6, { activity: 'hammer', speed: 0.9, phase: 0, localYaw: Math.PI * 0.5 });
  c.actor(1.5, 1.15, -0.6, { activity: 'hammer', speed: 0.9, phase: Math.PI, localYaw: -Math.PI * 0.5 });
  c.relic(R - 1.1, 1.35, -R + 1.4, 'common');

  /* The crowd it draws. Nothing else in the zone has spectators, which is what
   * makes this the one place that reads as an event rather than as a facility.
   * `atan2(x, z)` turns each of them to face the rig origin: an actor at yaw
   * `phi` looks along -(sin phi, cos phi), so the sign falls out of that. */
  [[-9.6, -3.2, 0.4], [-8.4, 4.6, 2.9], [9.2, -3.8, 1.1], [8.6, 4.2, 5.3], [0.4, -10.4, 3.6]]
    .forEach(([x, z, ph], i) => {
      c.actor(x, 0, z, {
        activity: i % 3 === 0 ? 'talk' : 'stand',
        phase: ph,
        localYaw: Math.atan2(x, z),
      });
    });

  c.lamp(0, 7.2, 0, 0xffd9b0, 1400, 42);
  c.contact(0, 0, 26);
  const [mx, mz] = bear(305, 66);
  ctx.mmCircle(mx, mz, R, 'rgba(150,110,90,0.4)', 'rgba(255,205,160,0.6)');
}

/* ------------------------------------------------------------------ */
/* Arcade dressing                                                     */
/* ------------------------------------------------------------------ */

/**
 * The banners and the traffic between bays.
 *
 * A gym in which every figure is attached to a machine is a showroom. These
 * are the people between sets and between bays, and they are what makes the
 * equipment look occupied rather than allocated.
 */
function dressArcade(S) {
  const { ctx } = S;

  /* One banner mast per bay, at 44% of the band's height limit: well over head
   * height, well under the lighting grid, and the same datum in all six bays
   * so the arcade has a horizontal line running round it. */
  const MAST_H = ARCADE_MAX_Y * 0.44;
  for (const deg of [40, 96, 152, 214, 280, 330]) {
    const b = S.rig(deg, 126, Math.PI);
    b.box('trimDark', 9.0, 0.28, 0.28, 0, MAST_H, 0);
    b.box(ctx.accent, 8.0, 5.4, 0.10, 0, MAST_H - 2.8, 0);
    b.box('panelDark', 8.4, 5.8, 0.16, 0, MAST_H - 2.8, 0.14);
    for (const s of [-1, 1]) {
      b.box('trim', 0.34, MAST_H, 0.34, s * 4.4, MAST_H / 2, 0.2);
      b.solid(s * 4.4, MAST_H / 2, 0.2, 0.2, MAST_H / 2, 0.2);
    }
  }

  /* Walkers and carriers on the concourse. `walk` and `carry` do not
   * translate either, so these are spaced widely *along* the ring and turned
   * tangentially: a figure mid-stride facing down a route reads as somebody
   * passing through, where the same figure facing across it reads as somebody
   * stuck. Placed on the concourse, they also mark the route. */
  const traffic = [
    [24, 'walk'], [58, 'carry'], [88, 'walk'], [118, 'walk'], [147, 'carry'],
    [176, 'walk'], [206, 'walk'], [233, 'walk'], [263, 'carry'], [318, 'walk'],
  ];
  traffic.forEach(([deg, act], i) => {
    const [lx, lz] = bear(deg, 122 + (i % 3) * 3.4);
    ctx.actor(lx, 0, lz, {
      activity: act,
      localYaw: deg * D2R + (i % 2 ? Math.PI / 2 : -Math.PI / 2),
      speed: 0.8 + (i % 4) * 0.12,
      phase: i * 1.29,
    });
  });
}

/* ------------------------------------------------------------------ */
/* Named cast                                                          */
/* ------------------------------------------------------------------ */

/**
 * The two authored friendlies this zone is allowed.
 *
 * There is a hard cap of eight across the whole game and the canteen owns the
 * merchant, so neither of these carries `role: 'vendor'`. They are the two
 * people you would actually meet in a gym: the one who runs the floor, and the
 * one who runs the thing in the middle of it.
 */
function populateNamed(ctx) {
  const [ivoX, ivoZ] = bear(206, 168);
  ctx.npc(ivoX, ivoZ, {
    name: 'Coach Ivo Karrass',
    persona:
      'Strength and conditioning lead for Deck 9: a squat, unhurried man who has rebuilt more crew than the Ring 7 clinic has and mentions it about once a shift. He talks entirely in sets, tempo and "one more", corrects your form whether or not you asked him to, and holds a genuine, lasting grudge against anybody who leaves plates on a bar.',
    patrol: [bear(206, 168), bear(222, 158), bear(236, 166), bear(192, 172)],
  });

  const [rueX, rueZ] = bear(268, 40);
  ctx.npc(rueX, rueZ, {
    name: 'Rue Sandoval',
    persona:
      'Marshal of the centrifuge, and the only person on this deck who thinks the drum is dangerous - which she is right about and says constantly. Nineteen months on a long micro-g rotation left her with an engineer\'s respect for bone density and a very dry line in safety briefings, which she delivers whether you are booked in for a session or merely walking past the ramp.',
    patrol: [bear(268, 40), bear(250, 62), bear(285, 66), bear(272, 88)],
  });
}

/* ------------------------------------------------------------------ */
/* Flush                                                              */
/* ------------------------------------------------------------------ */

/**
 * Turn the accumulated prop entries into InstancedMeshes.
 *
 * Deferred to the very end so a shape is only built if something asked for it,
 * and so the whole zone's placements are known before any GPU buffer is sized.
 * `instanced()` already returns a bare Object3D for an empty list, but an
 * empty bin is skipped anyway - adding a node to the scene graph for a prop
 * nobody placed is a traversal cost with no drawing behind it.
 */
function flushProps(S) {
  for (const name in PROPS) {
    const entries = S.bins[name];
    if (!entries || !entries.length) continue;
    const def = PROPS[name];
    const mesh = instanced(def.geo(), S.M[def.key], entries, { cast: true, recv: true });
    mesh.name = `zone:gym:${name}`;
    S.ctx.group.add(mesh);
  }
}
