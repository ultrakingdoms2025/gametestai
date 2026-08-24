import * as THREE from 'three';
/* Lights are created HIDDEN. `LightRig` would hide them on its next walk
 * anyway, but the frame between construction and that walk is a frame in
 * which they count for Three's program cache key, and one such frame
 * re-links every program on screen. See gfx/WorldLight.js. */
import { pointLight } from '../../gfx/WorldLight.js';
import { boxGeo, cylGeo, uvScale, GeoBatch } from './StationKit.js';
import { CENTRE } from '../lod/DistanceLod.js';
import { drawFloorSign } from './Tower.js';

/**
 * Traffic Control - the station's tallest landmark, and now a building.
 *
 * ── What was wrong ────────────────────────────────────────────────────────
 * `StationWorld._buildControlTower` drew a 48 m tower in five closed solids -
 * a base drum, a tapered mast, a flared head, a glazed collar and a roof - and
 * collided the lot with three axis-aligned boxes. It had no door, no floor and
 * no way up. The head's `room` cylinder is the giveaway: `M.room` is the
 * unlit-interior cheat this world paints BEHIND glazing so a window has
 * something to show, and the most prominent glass in the district was showing
 * a painted picture of a room that was not there.
 *
 * The pass that made twenty-three buildings enterable left this one out and
 * said why: "The control tower is a solid cylinder needing a full re-section."
 * That is what this file is. Nothing about the exterior read changes except
 * the two things that had to: the base is now an eighteen-sided drum instead
 * of a smooth cone, because a doorway has to be cut in it and a prism wall has
 * its own reveals; and the head's painted interior is gone, because you can
 * now stand in it.
 *
 * ── The section ───────────────────────────────────────────────────────────
 *
 *      48.3  ┌────────────┐  roof disc
 *      47.1  │ ░░░░░░░░░░ │  soffit - the cab ceiling
 *            │ ░ ┌──┐ ░░░ │
 *      42.3  ├───┤L4├─────┤  OPERATIONS   floor 4, r 10.3, glazed all round
 *      37.8  └─┐ │  │ ┌───┘  flare
 *              │ │  │ │
 *      32.4  ┌─┤ │  │ ├─┐
 *      28.5  ├─┤ │L3│ ├─┤    APPROACH     floor 3, r 4.30
 *              │ │  │ │
 *      18.9  ┌─┤ │  │ ├─┐
 *      15.0  ├─┤ │L2│ ├─┤    COMMS        floor 2, r 4.70
 *              │ │  │ │
 *       6.0  ┌─┴─┤  ├─┴─┐    lobby ceiling
 *            │   │L1│   │
 *       0.0  └───┴──┴───┘    CONCOURSE    floor 1, r 11.0, door at local -Z
 *
 * ── Why a lift and not escalators ─────────────────────────────────────────
 * `Tower.js` runs two banks of 30-degree escalators up its towers and that is
 * the right answer THERE, where the plan is 24 by 22 m. It is not available
 * here. A 30-degree flight needs 6.75 m of run per 3.9 m of rise and a 3.5 m
 * lane, and the mast's usable diameter is 9.7 m at the bottom and 8.5 m at the
 * top - one flight laid across it would consume the entire plan, leave nowhere
 * to arrive, and still cover only a tenth of the 42 m climb. A single lift in
 * a walled core is both the only thing that fits and what a real control tower
 * has. The core runs the full height and is walled on all four faces with an
 * opening at each stop, so the ride is enclosed the whole way - see `coreWall`.
 *
 * ── Why the stops are where they are ──────────────────────────────────────
 * The cab floor is fixed by the shell: the glazed collar starts at 42.1 and
 * the flare's top is at 42.25, so 42.30 is the only height a floor can be
 * without either standing in the glass or hanging above the flare. Everything
 * else is spaced back down from it. Two intermediate decks rather than ten:
 * the mast is a 9 m tube, ten identical rings inside it would be ten identical
 * corridors, and the interesting part of this building is the top.
 */

/* ------------------------------------------------------------------ */
/* The shell, as numbers                                               */
/* ------------------------------------------------------------------ */

/** Inner face of the lobby drum. The lobby is 22 m across. */
export const BASE_R = 11.0;
/** Lobby drum wall thickness. */
export const BASE_WALL = 0.6;
/** Top of the lobby drum - the underside of its ceiling slab is 0.4 below. */
export const BASE_TOP = 6.0;
/** Facets in the lobby drum. Eighteen is round enough at 11 m to read as a
 *  drum and few enough that the wall is 18 drawn boxes and 18 colliders. */
export const BASE_SEGS = 18;

/** Clear half-width of the entrance. Two 1.6 m leaves, as `Tower.js`. */
export const DOOR_HW = 1.6;
export const DOOR_H = 3.0;

/** The mast is a cone. These are the numbers the exterior has always used. */
export const MAST_Y0 = 6, MAST_Y1 = 44;
export const MAST_R0 = 5.6, MAST_R1 = 4.6;

/**
 * Outer radius of the mast at height `y`.
 *
 * Every interior lining, every collider band and the lift core's own corner
 * clearance is checked against this rather than against a remembered number,
 * because the mast loses a metre of radius over its height and a lining sized
 * for its floor pokes through the skin by the time it reaches its ceiling.
 */
export function mastRadius(y) {
  const t = (Math.min(MAST_Y1, Math.max(MAST_Y0, y)) - MAST_Y0) / (MAST_Y1 - MAST_Y0);
  return MAST_R0 + (MAST_R1 - MAST_R0) * t;
}

/**
 * The lift core, in tower-local coordinates.
 *
 * Offset to +X rather than centred, and that is the whole reason the two mast
 * decks are rooms instead of catwalks. Centred, a 3.2 m core inside a 9 m tube
 * leaves a 2.8 m annulus - a corridor you shuffle round. Pushed to one side it
 * leaves a D-shaped floor 8 m wide and 5 m deep, which is a room. It also puts
 * the cab's lift door behind you as you step out, facing the plaza, which is
 * the view this building exists for: the plaza lies along local -X.
 *
 * `HALF` is 1.45 and not more because the core has to clear TWO things at the
 * mast's narrowest, and the second one is easy to forget: not the cavity but
 * the walls round it. The cavity's corner is at `hypot(X + HALF, HALF)` =
 * 3.72 m, the wall's outer corner is 0.27 m further out at 3.99 m, and the L3
 * lining's inner face is at 4.30 m. Sized against the cavity alone the core
 * stands through the wall of the room it opens onto.
 */
export const CORE_HALF = 1.45;
export const CORE_X = 1.95;
export const CORE_WALL = 0.22;
/** Clear width of a lift doorway, and its height above the landing. */
export const CORE_DOOR_HW = 1.0;
export const CORE_DOOR_H = 2.6;

/** Slab thickness, matching `Tower.js` so the two buildings agree in section. */
export const SLAB_T = 0.4;
/** Ceiling height in the two mast decks. */
export const DECK_H = 3.9;

/**
 * Every stop, bottom to top.
 *
 * `y` is the walking surface. `r` is the inner face of that level's wall - the
 * lobby drum for L1, the mast lining for L2 and L3, and the glazing line for
 * the cab. `capped` is false for the cab, whose ceiling is the roof disc's own
 * soffit at 47.1 rather than a slab of its own; adding one would have put a
 * second horizontal surface a tenth of a metre under an existing one, which is
 * the coincident-surface defect this world has just spent a session removing.
 */
export const LEVELS = Object.freeze([
  Object.freeze({ y: 0.00, r: BASE_R, name: 'Concourse', capped: true, top: BASE_TOP }),
  Object.freeze({ y: 15.00, r: 4.70, name: 'Comms', capped: true, top: 15.00 + DECK_H }),
  Object.freeze({ y: 28.50, r: 4.30, name: 'Approach', capped: true, top: 28.50 + DECK_H }),
  Object.freeze({ y: 42.30, r: 10.30, name: 'Operations', capped: false, top: 47.10 }),
]);

/** The glazed collar, from the shell: `CylinderGeometry(11.6, 10.5, 5.0)` at H+0.6. */
export const CAB_GLASS_Y0 = 42.10, CAB_GLASS_Y1 = 47.10;
export const CAB_GLASS_R0 = 10.50, CAB_GLASS_R1 = 11.60;

/**
 * How far from the tower's axis its lower interior stops being drawn.
 *
 * Measured to the CENTRE, for the reason `Tower.js` gives at the same place:
 * the object is 32 m tall, so a surface measure asks "how far is the player
 * from the nearest triangle of a 19 m sphere", which is nearly always zero and
 * tells you nothing. Measured to the centre it is "how far is the player from
 * this tower", which is the question.
 *
 * 40 m, with the default 6 m hysteresis, means it is fully drawn from 34 m
 * out. The only way to see any of it is through the doorway, and a player
 * standing in the doorway is 19.6 m from that centre - so the transition
 * happens well out on the apron, never across the threshold.
 */
export const LOW_HIDE_R = 40;
/**
 * And the cab's, which is a separate registration.
 *
 * Two batches rather than one because they are 42 m apart and the band is
 * smaller than the separation: a player in the lobby draws no cab and a player
 * in the cab draws no lobby. One batch for the whole tower would have a 24 m
 * bounding radius and would be up whenever either end was.
 *
 * 26 m covers the cab's own 11 m radius twice over and hides it from the deck
 * 42 m below.
 */
export const CAB_HIDE_R = 26;

/* ------------------------------------------------------------------ */
/* Pure geometry - checkable under Node                                */
/* ------------------------------------------------------------------ */

/**
 * A wall built as a prism: `n` chord boxes round a circle, optionally with a
 * gap cut in it for a doorway.
 *
 * The DRAWN boxes are sized so their inner corners meet exactly - width is
 * `2 * rIn * tan(halfSpan)` - which is what makes a prism wall a wall rather
 * than a picket fence. They splay apart going outwards, which is invisible
 * because the outer face is what you see from outside a solid drum.
 *
 * -- Why the COLLIDER is wider, and why that is not a detail ---------------
 * Inner corners that meet exactly leave a V-shaped notch opening outward at
 * every joint, and a capsule walked at a joint is pushed OUT THROUGH THE WALL.
 * Depenetration ejects along the shortest axis, and the shortest way out of a
 * chord box's tangential end face is a direction tilted `halfSpan` off the
 * tangent - which carries `sin(halfSpan)` of outward radial motion. Wedged in
 * the notch the capsule is handed back and forth between the two boxes and
 * ratchets outward a fifth of every push until it is outside the building.
 *
 * Measured on the first build of this tower: local -X is exactly a joint
 * bearing on a 16-facet ring, and a capsule marched from the lift along it
 * walked through the Comms deck lining, the Approach deck lining AND the cab
 * glazing, ending up standing in mid-air four metres outside the mast at all
 * three levels. Nothing about it is visible - the wall is drawn correctly and
 * looks solid from both sides.
 *
 * So `wSolid` widens the chord to where the OUTER corners meet, plus 60 mm.
 * Adjacent colliders then overlap through the full thickness, the notch does
 * not exist, and a capsule ejected out of one lands inside its neighbour and
 * is pushed back in. Colliders may overlap freely - it is DRAWN geometry the
 * audit's C2 measures - so this costs two numbers and nothing else.
 *
 * Returned as plain numbers rather than drawn, for the same reason
 * `Tower.js` returns `stringCourseRuns`: the relationship between the gap and
 * the door that stands in it is the thing that can silently be wrong, and it
 * can be checked here without a renderer.
 *
 * @param {number} n         facets across the drawn part of the ring
 * @param {number} rIn       inner face radius
 * @param {number} thick     wall thickness, outward
 * @param {number} [gapHalf] half-angle of the doorway gap, radians; 0 for a
 *                           closed ring
 * @param {number} [gapAt]   bearing the gap is centred on. PI is local -Z,
 *                           which is where every entrance in this world faces.
 * @returns {Array<{a:number, x:number, z:number, w:number, wSolid:number,
 *   d:number}>} `a` is the segment's bearing and also its Y rotation, `x`/`z`
 *   its local centre, `w` the width to DRAW, `wSolid` the width to COLLIDE,
 *   and `d` its radial thickness.
 */
export function ringSegments(n, rIn, thick, gapHalf = 0, gapAt = Math.PI) {
  const span = Math.PI * 2 - gapHalf * 2;
  const w = span / n;
  const t = Math.tan(w / 2);
  const rMid = rIn + thick / 2;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = gapAt + gapHalf + (i + 0.5) * w;
    out.push({
      a, x: Math.sin(a) * rMid, z: Math.cos(a) * rMid,
      w: 2 * rIn * t,
      wSolid: 2 * (rIn + thick + RING_SOLID_LAP) * t,
      d: thick,
    });
  }
  return out;
}

/** How far past the outer corners a collider segment reaches, per side. */
export const RING_SOLID_LAP = 0.06;

/** Half-angle a clear opening of `halfWidth` subtends at radius `r`. */
export function gapHalfAngle(halfWidth, r) {
  return Math.asin(Math.min(0.999, halfWidth / r));
}

/**
 * A round floor, decomposed into axis-aligned rectangles, with an optional
 * rectangular hole for the lift core.
 *
 * This is the COLLISION form of a floor plate; the drawn form is a real disc
 * (see `discPlate`). They are deliberately not the same shape: the rectangles
 * over-cover, running past the circle's edge into the wall that stands on it,
 * because a decomposition that under-covers leaves a crescent of floor with
 * nothing behind it at the one place a player is most likely to walk - the
 * window. Over-covering is free: the wall is solid there anyway.
 *
 * Strip boundaries always include zero and always include the hole's own
 * edges, so no strip ever straddles the axis (which would make "the edge
 * nearer the axis" meaningless) and no strip is ever half in the hole.
 *
 * @param {number} r      floor radius
 * @param {?{x0:number,x1:number,z0:number,z1:number}} hole
 * @param {number} [cuts] strips across the full diameter, before the hole's
 *                        own edges are added. Must be even so zero is a cut.
 * @returns {Array<{x0:number,x1:number,z0:number,z1:number}>}
 */
export function discStrips(r, hole = null, cuts = 4) {
  const zs = [0];
  for (let i = 0; i <= cuts; i++) zs.push(-r + (2 * r * i) / cuts);
  if (hole) zs.push(hole.z0, hole.z1);
  const uniq = [...new Set(zs.map((v) => Math.round(v * 1e6) / 1e6))]
    .filter((v) => v >= -r - 1e-9 && v <= r + 1e-9)
    .sort((a, b) => a - b);

  const out = [];
  for (let i = 0; i < uniq.length - 1; i++) {
    const z0 = uniq[i], z1 = uniq[i + 1];
    if (z1 - z0 < 0.02) continue;
    // The edge nearer the axis gives the WIDER chord: over-cover, never under.
    const zn = Math.min(Math.abs(z0), Math.abs(z1));
    const hw = Math.sqrt(Math.max(0, r * r - zn * zn));
    if (hw < 0.05) continue;
    const inHole = hole && z0 >= hole.z0 - 1e-6 && z1 <= hole.z1 + 1e-6;
    if (!inHole) { out.push({ x0: -hw, x1: hw, z0, z1 }); continue; }
    if (hole.x0 > -hw) out.push({ x0: -hw, x1: Math.min(hole.x0, hw), z0, z1 });
    if (hole.x1 < hw) out.push({ x0: Math.max(hole.x1, -hw), x1: hw, z0, z1 });
  }
  return out;
}

/** The lift core's plan rectangle, in tower-local coordinates. */
export function coreRect(pad = 0) {
  return {
    x0: CORE_X - CORE_HALF - pad, x1: CORE_X + CORE_HALF + pad,
    z0: -CORE_HALF - pad, z1: CORE_HALF + pad,
  };
}

/**
 * A round floor plate with a square hole in it, as drawn geometry.
 *
 * `ExtrudeGeometry` rather than a cylinder because the hole has to be real -
 * the lift car passes through this plate at every level, and a plate the car
 * intersects reads as a disc sawn through by a rising box.
 *
 * Shape space is (u, v); the rotation below sends +v to world -Z, so the hole
 * path is given in (x, -z).
 */
export function discPlate(r, t, hole = null, segs = 28) {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, r, 0, Math.PI * 2, false);
  if (hole) {
    const h = new THREE.Path();
    h.moveTo(hole.x0, -hole.z0);
    h.lineTo(hole.x1, -hole.z0);
    h.lineTo(hole.x1, -hole.z1);
    h.lineTo(hole.x0, -hole.z1);
    h.closePath();
    shape.holes.push(h);
  }
  const geo = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: segs });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, -t, 0);          // top face on y = 0
  geo.computeVertexNormals();
  return geo;
}

/**
 * The lift core's walls, as boxes, in tower-local coordinates.
 *
 * Three faces run the full height. The fourth - the one the doors are in, at
 * local -X - is split into the bands between openings plus a jamb either side
 * of each. That is what keeps the ride enclosed: a core open on one side for
 * its whole height would show the rider the inside of the mast, which is a
 * sealed void with nothing drawn in it and single-sided skin around it, so it
 * would show them the hull straight through the building.
 *
 * @param {number[]} stopYs   landing heights, ascending
 * @param {number} y0         bottom of the core
 * @param {number} y1         top of the core
 * @returns {Array<{x:number, y:number, z:number, w:number, h:number, d:number}>}
 */
export function coreWall(stopYs, y0, y1) {
  const out = [];
  const H = CORE_HALF, T = CORE_WALL;
  const put = (x, z, w, d, a, b) => {
    if (b - a < 0.01) return;
    out.push({ x: CORE_X + x, y: (a + b) / 2, z, w, h: b - a, d });
  };
  // +X, +Z and -Z: unbroken.
  put(H + T / 2, 0, T, (H + T) * 2, y0, y1);
  put(0, H + T / 2, (H + T) * 2, T, y0, y1);
  put(0, -(H + T / 2), (H + T) * 2, T, y0, y1);

  // -X: bands between openings, and a jamb either side of each opening.
  let cursor = y0;
  for (const sy of stopYs) {
    put(-(H + T / 2), 0, T, H * 2, cursor, sy);
    for (const s of [-1, 1]) {
      const jw = H - CORE_DOOR_HW;
      put(-(H + T / 2), s * (CORE_DOOR_HW + jw / 2), T, jw, sy, sy + CORE_DOOR_H);
    }
    cursor = sy + CORE_DOOR_H;
  }
  put(-(H + T / 2), 0, T, H * 2, cursor, y1);
  return out;
}

/* ------------------------------------------------------------------ */
/* The build                                                           */
/* ------------------------------------------------------------------ */

/**
 * @param {import('../StationWorld.js').StationWorld} world
 * @param {import('./StationKit.js').GeoBatch} B  district batch, flushed by the caller
 * @param {THREE.Group} g                          group for dynamic parts
 * @param {{x:number, z:number, yaw:number, label:string, accent?:string}} spec
 * @returns {{ enterable:object, footprint:object, height:number }}
 */
export function buildControlTower(world, B, g, spec) {
  const M = world.mat;
  const { x, z, yaw } = spec;
  const accent = spec.accent ?? 'emCyan';

  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  const P = (lx, ly, lz) => new THREE.Vector3(x + lx * cs + lz * sn, ly, z - lx * sn + lz * cs);
  const put = (key, geo, lx, ly, lz, ry = 0, rx = 0, rz = 0) =>
    B.localAt(key, geo, x, 0, z, yaw, lx, ly, lz, ry, rx, rz);
  const solid = (lx, ly, lz, hx, hy, hz, ra = 0) => {
    const p = P(lx, ly, lz);
    return world._solidRot(p.x, p.y, p.z, hx, hy, hz, yaw + ra);
  };

  /* Two interior batches. See `LOW_HIDE_R` / `CAB_HIDE_R` for why two. */
  const I = new GeoBatch();
  const ig = new THREE.Group();
  ig.name = 'control-interior-low';
  g.add(ig);
  const iput = (key, geo, lx, ly, lz, ry = 0, rx = 0, rz = 0) =>
    I.localAt(key, geo, x, 0, z, yaw, lx, ly, lz, ry, rx, rz);

  const C = new GeoBatch();
  const cg = new THREE.Group();
  cg.name = 'control-interior-cab';
  g.add(cg);
  const cput = (key, geo, lx, ly, lz, ry = 0, rx = 0, rz = 0) =>
    C.localAt(key, geo, x, 0, z, yaw, lx, ly, lz, ry, rx, rz);

  const hole = coreRect(0.02);
  const stops = LEVELS.map((l) => l.y + 0.02);

  /* ---------------------------------------------------------------- */
  /* Base drum + entrance                                              */
  /* ---------------------------------------------------------------- */

  const doorGap = gapHalfAngle(DOOR_HW, BASE_R);
  for (const s of ringSegments(BASE_SEGS, BASE_R, BASE_WALL, doorGap)) {
    put('panelDark', boxGeo(s.w, BASE_TOP, s.d, 2), s.x, BASE_TOP / 2, s.z, s.a);
    solid(s.x, BASE_TOP / 2, s.z, s.wSolid / 2, BASE_TOP / 2, s.d / 2, s.a);
  }
  // Lintel across the gap, so the doorway is a hole and not a slot.
  {
    const rMid = BASE_R + BASE_WALL / 2;
    const lw = 2 * rMid * Math.sin(doorGap);
    const lh = BASE_TOP - DOOR_H;
    put('panelDark', boxGeo(lw, lh, BASE_WALL, 2), 0, DOOR_H + lh / 2, -rMid, Math.PI);
    solid(0, DOOR_H + lh / 2, -rMid, lw / 2, lh / 2, BASE_WALL / 2, Math.PI);
  }

  /* The flared skirt, kept from the original cone so the base still splays.
   *
   * Drawn as a single open cone with the same angular gap as the wall, and
   * collided as rectangles round a doorway-shaped hole rather than as a second
   * ring - it is 0.9 m tall, nobody stands on it, and five boxes say the same
   * thing as eighteen. */
  {
    const skirt = new THREE.CylinderGeometry(11.9, 13.0, 0.9, 40, 1, true, Math.PI + doorGap, Math.PI * 2 - doorGap * 2);
    uvScale(skirt, 34, 1);
    put('panelDark', skirt, 0, 0.45, 0);
    const way = { x0: -DOOR_HW - 0.1, x1: DOOR_HW + 0.1, z0: -13.4, z1: -BASE_R };
    for (const r of discStrips(12.9, way, 4)) {
      const cw = r.x1 - r.x0, cd = r.z1 - r.z0;
      if (cw < 0.1 || cd < 0.1) continue;
      // Only the part outside the drum wall is skirt; the rest is the lobby.
      if (Math.hypot((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2) < BASE_R - 1) continue;
      solid((r.x0 + r.x1) / 2, 0.45, (r.z0 + r.z1) / 2, cw / 2, 0.45, cd / 2);
    }
  }

  /* The two bands that make the drum read from the avenue. The lower one is at
   * 1.25 and not 0.75: the skirt flares from 11.9 to 13.0 over the bottom
   * 0.9 m, so a band at 11.75 anywhere below that is inside it. */
  for (const [by, br] of [[1.25, 11.75], [5.55, 11.75]]) {
    const ring = new THREE.TorusGeometry(br, 0.3, 6, 44);
    ring.rotateX(-Math.PI / 2);
    put('emAmber', ring, 0, by, 0);
  }

  /* Entrance canopy and name band, over the door. `Tower.js` puts the same
   * three pieces over its own doors; a lit soffit is how every other entrance
   * in this station announces itself. */
  put('panelDark', boxGeo(7.0, 0.5, 2.6, 2), 0, DOOR_H + 0.9, -(BASE_R + BASE_WALL + 1.1), Math.PI);
  put(accent, boxGeo(6.0, 0.14, 1.9, 1), 0, DOOR_H + 0.62, -(BASE_R + BASE_WALL + 1.1), Math.PI);
  put(accent, boxGeo(5.0, 0.18, 0.26, 1), 0, DOOR_H + 1.35, -(BASE_R + BASE_WALL + 0.1), Math.PI);
  for (const sx of [-2.9, 2.9]) {
    put('trim', cylGeo(0.15, 0.15, DOOR_H + 0.65, 6, 2), sx, (DOOR_H + 0.65) / 2, -(BASE_R + BASE_WALL + 1.1));
  }

  // Lobby ceiling: a real slab, so the drum is a room and not a chimney.
  put('grate', discPlate(BASE_R, SLAB_T, hole), 0, BASE_TOP, 0);
  for (const r of discStrips(BASE_R, hole, 4)) {
    solid((r.x0 + r.x1) / 2, BASE_TOP - SLAB_T / 2, (r.z0 + r.z1) / 2,
      (r.x1 - r.x0) / 2, SLAB_T / 2, (r.z1 - r.z0) / 2);
  }

  /* ---------------------------------------------------------------- */
  /* Mast, flare and cab shell                                         */
  /* ---------------------------------------------------------------- */

  /**
   * The mast and the flare are drawn OPEN-ENDED, which they were not before.
   *
   * A closed cylinder has caps, and both of this one's caps - at 6.0 and at
   * 44.0 - lie across the lift core. So does the flare's top cap at 42.25. The
   * car passes through all three, and a rider would have watched a disc slice
   * through the cab they were standing in. The ends are closed instead by the
   * things that ought to close them: the lobby ceiling, the cab floor, and the
   * annular plate below.
   */
  const mast = new THREE.CylinderGeometry(MAST_R1, MAST_R0, MAST_Y1 - MAST_Y0, 20, 1, true);
  uvScale(mast, 22, (MAST_Y1 - MAST_Y0) / 3);
  put('panel', mast, 0, (MAST_Y0 + MAST_Y1) / 2, 0);
  for (let i = 0; i < 9; i++) {
    const ring = new THREE.TorusGeometry(4.9 - i * 0.09, 0.16, 6, 28);
    ring.rotateX(-Math.PI / 2);
    put(i % 3 === 0 ? accent : 'trim', ring, 0, 9 + i * 3.6, 0);
  }
  /* Maintenance ladder. It used to be pinned to a fixed world offset of 5.0 m
   * from the axis, which the mast passes on its way from 5.6 to 4.6 - so the
   * bottom third of the rungs were buried in the skin and the top two thirds
   * were floating clear of it. Following the cone puts every rung on the
   * building. */
  for (let i = 0; i < Math.floor((MAST_Y1 - 8) / 0.45); i++) {
    const ry = 7 + i * 0.45;
    put('trim', boxGeo(0.6, 0.05, 0.06, 1), 0, ry, mastRadius(ry) + 0.16);
  }

  const flare = new THREE.CylinderGeometry(10.5, 5.2, 4.5, 24, 1, true);
  uvScale(flare, 30, 2);
  put('panelDark', flare, 0, 40, 0);
  // The annulus that closes the flare's foot, minus the core it stands round.
  put('panelDark', discPlate(5.2, 0.3, hole, 24), 0, 38.05, 0);

  const headGlass = new THREE.CylinderGeometry(CAB_GLASS_R1, CAB_GLASS_R0, CAB_GLASS_Y1 - CAB_GLASS_Y0, 24, 1, true);
  put('glassWindow', headGlass, 0, (CAB_GLASS_Y0 + CAB_GLASS_Y1) / 2, 0);
  for (let i = 0; i < 12; i++) {
    const th = (i / 12) * Math.PI * 2;
    put('trim', boxGeo(0.22, 5.2, 0.5, 1), Math.sin(th) * 11.0, (CAB_GLASS_Y0 + CAB_GLASS_Y1) / 2, Math.cos(th) * 11.0, th, 0, 0.1);
  }
  const roof = new THREE.CylinderGeometry(12.4, 11.9, 1.2, 24);
  uvScale(roof, 34, 1);
  put('panelDark', roof, 0, 47.7, 0);
  const gallery = new THREE.TorusGeometry(12.6, 0.15, 6, 44);
  gallery.rotateX(-Math.PI / 2);
  put(accent, gallery, 0, 48.4, 0);
  for (const r of discStrips(11.9, null, 4)) {
    solid((r.x0 + r.x1) / 2, 47.7, (r.z0 + r.z1) / 2, (r.x1 - r.x0) / 2, 0.6, (r.z1 - r.z0) / 2);
  }

  /* Shell collision.
   *
   * This building publishes a `_selfCollided` footprint (see the return), so
   * the derived pass leaves all of it alone and every solid here is authored.
   * The mast and flare are filled BAND BY BAND rather than by one box, because
   * one box is what was here before and a solid box has no room in it for a
   * lift. Each band is the disc at its own height, decomposed round the core.
   */
  const fillBand = (y0, y1, r) => {
    for (const s of discStrips(r, hole, 4)) {
      const cw = s.x1 - s.x0, cd = s.z1 - s.z0;
      if (cw < 0.06 || cd < 0.06) continue;
      solid((s.x0 + s.x1) / 2, (y0 + y1) / 2, (s.z0 + s.z1) / 2, cw / 2, (y1 - y0) / 2, cd / 2);
    }
  };
  // Mast, between the enterable decks. Radius at the band's top: the cone
  // narrows upward, so this over-covers downward into solid material.
  for (const [a, b] of [[BASE_TOP, LEVELS[1].y], [LEVELS[1].top, LEVELS[2].y], [LEVELS[2].top, 37.75]]) {
    fillBand(a, b, mastRadius(b));
  }
  // The flare, in slices - it doubles in radius over 4.5 m and a single band
  // would either stand a metre proud of the skin or leave a metre of air.
  for (let i = 0; i < 6; i++) {
    const a = 37.75 + (i * 4.5) / 6, b = 37.75 + ((i + 1) * 4.5) / 6;
    fillBand(a, b, 5.2 + ((10.5 - 5.2) * (b - 37.75)) / 4.5);
  }

  /* ---------------------------------------------------------------- */
  /* The two mast decks                                                */
  /* ---------------------------------------------------------------- */

  for (const lv of [LEVELS[1], LEVELS[2]]) {
    // Floor.
    put('grate', discPlate(lv.r + 0.3, SLAB_T, hole, 20), 0, lv.y, 0);
    for (const s of discStrips(lv.r + 0.3, hole, 4)) {
      const cw = s.x1 - s.x0, cd = s.z1 - s.z0;
      if (cw < 0.06 || cd < 0.06) continue;
      solid((s.x0 + s.x1) / 2, lv.y - SLAB_T / 2, (s.z0 + s.z1) / 2, cw / 2, SLAB_T / 2, cd / 2);
    }
    // Ceiling.
    iput('panelDark', discPlate(lv.r + 0.3, SLAB_T, hole, 20), 0, lv.top, 0);
    for (const s of discStrips(lv.r + 0.3, hole, 4)) {
      const cw = s.x1 - s.x0, cd = s.z1 - s.z0;
      if (cw < 0.06 || cd < 0.06) continue;
      solid((s.x0 + s.x1) / 2, lv.top - SLAB_T / 2, (s.z0 + s.z1) / 2, cw / 2, SLAB_T / 2, cd / 2);
    }
    /* Lining, so the deck has walls instead of the back of the mast's skin.
     *
     * Sixteen facets and 0.22 m thick, both chosen against the cone rather than
     * for looks: a prism's CORNERS stand proud of its own inner radius by
     * `1/cos(pi/n)`, and the mast loses radius all the way up, so the number
     * that has to fit is the lining's outer corner at the room's CEILING.
     * At L3 that is 4.60 m against a skin at 4.905. */
    for (const s of ringSegments(16, lv.r, 0.22)) {
      iput('panel', boxGeo(s.w, lv.top - lv.y, s.d, 2), s.x, (lv.y + lv.top) / 2, s.z, s.a);
      solid(s.x, (lv.y + lv.top) / 2, s.z, s.wSolid / 2, (lv.top - lv.y) / 2, s.d / 2, s.a);
    }
    // Equipment racks against the lining, and a ceiling run over them.
    for (let i = 0; i < 7; i++) {
      const a = Math.PI * 0.15 + (i / 7) * Math.PI * 1.7;
      const rr = lv.r - 0.55;
      const rx = Math.sin(a) * rr, rz = Math.cos(a) * rr;
      if (rx > CORE_X - CORE_HALF - 1.2 && Math.abs(rz) < CORE_HALF + 1.0) continue;
      iput('panelDark', boxGeo(1.15, 2.2, 0.85, 1.5), rx, lv.y + 1.1, rz, a);
      iput(accent, boxGeo(0.85, 0.06, 0.06, 1), rx, lv.y + 1.9, rz - 0.0, a);
      iput('holo', boxGeo(0.7, 0.42, 0.03, 1), Math.sin(a) * (rr - 0.46), lv.y + 1.5, Math.cos(a) * (rr - 0.46), a + Math.PI);
      solid(rx, lv.y + 1.1, rz, 0.6, 1.1, 0.45, a);
    }
    iput('emWhite', boxGeo(lv.r * 1.4, 0.1, 0.22, 1), -lv.r * 0.25, lv.top - SLAB_T - 0.2, 0);
  }

  /* ---------------------------------------------------------------- */
  /* The cab                                                           */
  /* ---------------------------------------------------------------- */

  const cab = LEVELS[3];
  /* Floor, ceiling soffit and the console ring stay in the DISTRICT batch.
   *
   * `Tower.js` draws the same line and gives the reason: the slabs are what
   * you read through the glass from outside, and hiding them leaves a lit
   * shell with nothing in it. It matters more here than there, because this
   * cab is glazed for 360 degrees at 42 m and is the one interior in the
   * station that half the map can see into. The consoles are the horizon a
   * viewer from the plaza actually sees over the sill; the stools, screens and
   * signage behind them are cab-batch and hide at 26 m.
   *
   * The floor's radius is 10.5, which is exactly the flare's top radius, so
   * the flare's rim and the floor's rim meet edge to edge - no overlap to
   * order, and no 50 mm annulus of flare showing through the floor.
   */
  put('trim', discPlate(10.5, 0.5, hole, 32), 0, cab.y, 0);
  for (const s of discStrips(10.5, hole, 6)) {
    const cw = s.x1 - s.x0, cd = s.z1 - s.z0;
    if (cw < 0.06 || cd < 0.06) continue;
    solid((s.x0 + s.x1) / 2, cab.y - 0.25, (s.z0 + s.z1) / 2, cw / 2, 0.25, cd / 2);
  }
  /* Glazing collision, in two bands.
   *
   * The glass rakes outward from 10.50 at the sill to 11.55 at the head, and a
   * single vertical ring set to clear the sill would hold the player a metre
   * back from the head - so the cab would feel a metre smaller at eye level
   * than it looks. Two bands halve that to 0.25 m. `M.glassWindow` is
   * transparent and `_collisionSoup` rejects transparent materials by design,
   * so without these the cab has no walls at all and the payoff view is a
   * three-storey fall.
   */
  for (const [a, b, rr] of [[cab.y, 44.6, 10.30], [44.6, CAB_GLASS_Y1, 10.80]]) {
    for (const s of ringSegments(16, rr, 0.6)) {
      solid(s.x, (a + b) / 2, s.z, s.wSolid / 2, (b - a) / 2, s.d / 2, s.a);
    }
  }
  /* The console ring: the cab's horizon from outside, its desk from inside.
   *
   * Broken by a 5.2 m viewing bay on local -X, which is the bearing the plaza
   * lies on. A continuous ring is what a real cab has and it would have held
   * the player a metre and a quarter back from the glass all the way round -
   * so the one thing this building is climbed for would be seen over a desk.
   * The bay is the only place in the cab you can walk up to the window, which
   * is what makes it the place you go. */
  for (const s of ringSegments(12, 8.9, 1.25, gapHalfAngle(2.6, 8.9), -Math.PI / 2)) {
    const a = s.a;
    put('panelDark', boxGeo(s.w, 1.02, s.d, 1.5), s.x, cab.y + 0.51, s.z, a);
    put(accent, boxGeo(s.w * 0.86, 0.07, 0.28, 1), s.x, cab.y + 1.06, s.z - 0.0, a);
    solid(s.x, cab.y + 0.51, s.z, s.wSolid / 2, 0.51, s.d / 2, a);
    cput('holo', boxGeo(s.w * 0.6, 0.5, 0.03, 1), Math.sin(a) * 8.6, cab.y + 1.45, Math.cos(a) * 8.6, a + Math.PI, 0, -0.22);
    cput('trim', boxGeo(0.4, 0.62, 0.4, 1), Math.sin(a) * 7.4, cab.y + 0.31, Math.cos(a) * 7.4);
  }
  // Ceiling luminaires under the roof soffit, and a chart table on the core.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    cput('emWhite', boxGeo(2.6, 0.1, 0.24, 1), Math.sin(a) * 7.0, CAB_GLASS_Y1 - 0.3, Math.cos(a) * 7.0, a);
  }
  cput('panelWarm', boxGeo(1.1, 0.08, 3.0, 1.2), CORE_X - CORE_HALF - CORE_WALL - 0.65, cab.y + 0.94, 0);
  cput('trim', boxGeo(0.12, 0.94, 0.12, 1), CORE_X - CORE_HALF - CORE_WALL - 0.65, cab.y + 0.47, 0);
  cput('holo', boxGeo(0.9, 0.5, 0.03, 1), CORE_X - CORE_HALF - CORE_WALL - 0.65, cab.y + 1.4, 0, Math.PI / 2, 0, -0.3);

  /* ---------------------------------------------------------------- */
  /* Lift core, car and doors                                          */
  /* ---------------------------------------------------------------- */

  const CORE_TOP = 47.0;
  for (const wpc of coreWall(LEVELS.map((l) => l.y), 0, CORE_TOP)) {
    put('panelDark', boxGeo(wpc.w, wpc.h, wpc.d, 2), wpc.x, wpc.y, wpc.z);
    solid(wpc.x, wpc.y, wpc.z, wpc.w / 2, wpc.h / 2, wpc.d / 2);
  }
  // Lid, kept 0.1 clear of the roof soffit rather than butted to it.
  put('panelDark', boxGeo((CORE_HALF + CORE_WALL) * 2, 0.2, (CORE_HALF + CORE_WALL) * 2, 2), CORE_X, CORE_TOP - 0.1, 0);
  solid(CORE_X, CORE_TOP - 0.1, 0, CORE_HALF + CORE_WALL, 0.1, CORE_HALF + CORE_WALL);

  /* Shaft lighting: a bar on the back face of the core every 2.5 m.
   *
   * The car carries a lamp, but a lamp that travels with you lights a box that
   * never changes - the ride reads as a still image for eight seconds. Fixed
   * bars sweeping past the rider are the only thing in a walled lift that says
   * it is moving, and they are the reason a real lift shaft has them. Interior
   * batch, and `emWhite` is a key it already carries for the concourse
   * luminaires, so they merge into an existing bucket and cost no draw call.
   */
  for (let by = 3.0; by < CORE_TOP - 1.0; by += 2.5) {
    iput('emWhite', boxGeo(0.06, 0.1, CORE_HALF * 1.4, 1), CORE_X + CORE_HALF - 0.04, by, 0);
  }

  // Door surround and call plate at every landing, plus the storey number.
  for (let f = 0; f < LEVELS.length; f++) {
    const ly = LEVELS[f].y;
    const fx = CORE_X - CORE_HALF - CORE_WALL;
    const target = f === 3 ? cput : iput;
    target('trim', boxGeo(0.16, CORE_DOOR_H + 0.3, CORE_HALF * 2 + 0.5, 2), fx - 0.08, ly + (CORE_DOOR_H + 0.3) / 2, 0);
    target(accent, boxGeo(0.1, 0.13, CORE_HALF * 2, 1), fx - 0.18, ly + CORE_DOOR_H + 0.22, 0);
    target('emWhite', boxGeo(0.07, 0.28, 0.2, 1), fx - 0.2, ly + 1.45, -CORE_HALF + 0.42);
    drawFloorSign(target, f + 1, '-x', fx - 0.16, ly + 2.0, CORE_HALF - 0.38, 0.5);
  }

  const plateThick = 0.2;
  const carP = P(CORE_X, 0, 0);
  const carHalf = CORE_HALF - 0.12;
  const collider = world.track(
    world.physics.addRotatedBox(
      new THREE.Vector3(carP.x, stops[0] - plateThick / 2, carP.z),
      new THREE.Vector3(carHalf, plateThick / 2, carHalf),
      yaw,
      { solid: true }
    )
  );

  const car = new THREE.Group();
  const plate = new THREE.Mesh(boxGeo(carHalf * 2, plateThick, carHalf * 2, 2), M.grate);
  plate.position.y = -plateThick / 2;
  plate.castShadow = plate.receiveShadow = true;
  car.add(plate);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const post = new THREE.Mesh(boxGeo(0.13, 2.4, 0.13, 1), M.trim);
      post.position.set(sx * (carHalf - 0.16), 1.2, sz * (carHalf - 0.16));
      car.add(post);
    }
  }
  const canopy = new THREE.Mesh(boxGeo(carHalf * 2, 0.15, carHalf * 2, 2), M.panelDark);
  canopy.position.y = 2.48;
  car.add(canopy);
  /* The car carries its own light, and it is the difference between a lift and
   * a coffin. The core is walled on four faces so the ride is fully enclosed -
   * which is the point, it keeps the sealed mast void out of sight - and with
   * only an accent strip in it, a 42 m ride was 8 seconds in a black box. A
   * ceiling panel and one small point light travelling with the car light the
   * walls the rider is actually looking at. It casts no shadows: it is inside a
   * 3 m box and there is nothing in there to cast one. */
  const lamp = new THREE.Mesh(boxGeo(carHalf * 1.5, 0.07, carHalf * 1.5, 1), M.emWhite);
  lamp.position.y = 2.36;
  car.add(lamp);
  const trimStrip = new THREE.Mesh(boxGeo(carHalf * 1.9, 0.06, 0.1, 1), M[accent] ?? M.emWhite);
  trimStrip.position.set(0, 2.2, -(carHalf - 0.08));
  car.add(trimStrip);
  const carLight = pointLight(0xbfe4ff, 520, 9, 2);
  carLight.position.set(0, 1.9, 0);
  car.add(carLight);
  car.position.set(carP.x, stops[0], carP.z);
  car.rotation.y = yaw;
  g.add(car);

  const callP = P(CORE_X - CORE_HALF - CORE_WALL - 0.7, 0, 0);
  const lift = {
    id: `control_lift_${Math.round(x)}_${Math.round(z)}`,
    collider,
    car,
    plateThick,
    stops,
    stopIndex: 0,
    target: 0,
    pos: stops[0],
    /* 5.6 m/s. The tallest ride in the world by a factor of two - 42 m against
     * the habitat stacks' 23 - and at their 4.2 the trip from the concourse to
     * the cab is thirteen seconds of standing in a box. This makes it eight,
     * which is about as long as a lift stays interesting. */
    speed: 5.6,
    callPos: new THREE.Vector3(callP.x, stops[0], callP.z),
    footprint: { cx: carP.x, cz: carP.z, half: CORE_HALF },
  };

  /* The entrance doors. Two leaves folding back against their own jambs, as
   * `Tower.js` and `_openShop`; a single 3.2 m leaf would sweep the apron and
   * pass through the canopy stanchion at 2.9 m. */
  const doorZ = -(BASE_R + BASE_WALL + 0.08);
  const leaves = [];
  for (const s of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.copy(P(s * DOOR_HW, (DOOR_H - 0.1) / 2, doorZ));
    pivot.rotation.y = yaw;
    const leafGeo = boxGeo(DOOR_HW - 0.04, DOOR_H - 0.14, 0.14, 1.2);
    leafGeo.translate((-s * (DOOR_HW - 0.04)) / 2, 0, 0);
    const leaf = new THREE.Mesh(leafGeo, M.panelDark);
    leaf.castShadow = leaf.receiveShadow = true;
    pivot.add(leaf);
    const band = new THREE.Mesh(boxGeo((DOOR_HW - 0.04) * 0.8, 0.1, 0.18, 1), M[accent] ?? M.emCyan);
    band.position.set((-s * (DOOR_HW - 0.04)) / 2, 0.5, -0.02);
    pivot.add(band);
    g.add(pivot);
    leaves.push({ pivot, closed: yaw, open: yaw + s * Math.PI * 0.52 });
  }
  const doorCollider = world.track(
    world.physics.addRotatedBox(
      P(0, DOOR_H / 2, -(BASE_R + BASE_WALL / 2)),
      new THREE.Vector3(DOOR_HW, DOOR_H / 2, BASE_WALL / 2 + 0.06),
      yaw,
      { solid: true }
    )
  );

  /* ---------------------------------------------------------------- */
  /* Concourse fit-out                                                 */
  /* ---------------------------------------------------------------- */

  // A guide line off the threshold, so the lift is findable from the door.
  for (let i = 0; i < 7; i++) {
    iput('emAmber', boxGeo(0.9, 0.04, 0.28, 1), -0.2 + i * 0.25, 0.05, -9.4 + i * 1.55, -0.16);
  }
  // Reception desk, facing the door.
  iput('panelWarm', boxGeo(5.4, 1.02, 1.2, 1.5), -5.2, 0.51, -1.4);
  iput('trim', boxGeo(5.6, 0.09, 1.4, 1), -5.2, 1.06, -1.4);
  solid(-5.2, 0.51, -1.4, 2.7, 0.51, 0.6);
  iput('holo', boxGeo(2.4, 1.1, 0.04, 1), -5.2, 2.3, -0.7, Math.PI);
  // Benches along the drum, clear of the door and the lift.
  for (const [bx, bz, ba] of [[-7.4, 4.6, 0.5], [-1.6, 8.4, -0.3], [5.6, 6.6, -1.0]]) {
    iput('panelDark', boxGeo(3.2, 0.46, 0.9, 1.2), bx, 0.23, bz, ba);
    iput('trim', boxGeo(3.2, 0.09, 0.95, 1), bx, 0.5, bz, ba);
    solid(bx, 0.25, bz, 1.6, 0.25, 0.5, ba);
  }
  // Ceiling luminaires.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    iput('emWhite', boxGeo(4.4, 0.11, 0.26, 1), Math.sin(a) * 6.4, BASE_TOP - SLAB_T - 0.25, Math.cos(a) * 6.4, a);
  }

  /* ---------------------------------------------------------------- */
  /* Flush the interiors and hand them to the LOD                      */
  /* ---------------------------------------------------------------- */

  for (const mesh of I.flush(ig, M, `control-int-low`, { cast: false, recv: true, holo: { cast: false, recv: false } })) {
    world._lod?.add(mesh, { hideBeyond: LOW_HIDE_R, measure: CENTRE });
  }
  for (const mesh of C.flush(cg, M, `control-int-cab`, { cast: false, recv: true, holo: { cast: false, recv: false } })) {
    world._lod?.add(mesh, { hideBeyond: CAB_HIDE_R, measure: CENTRE });
  }

  const spots = LEVELS.map((lv, i) => ({
    position: P(i === 3 ? -6.4 : -(lv.r - 1.6), lv.y + 0.7, i === 3 ? -3.2 : 1.2),
    tier: i === LEVELS.length - 1 ? 'prize' : i >= 2 ? 'rare' : 'common',
  }));

  const enterable = {
    label: spec.label,
    origin: new THREE.Vector3(x, 0, z),
    doors: [{
      id: `control_door_${Math.round(x)}_${Math.round(z)}`,
      leaves,
      collider: doorCollider,
      position: P(0, 1.6, -(BASE_R + BASE_WALL + 0.55)),
      open: false,
      anim: 0,
    }],
    lifts: [lift],
    collectibleSpots: spots,
  };

  /* Publish the footprint, for the reason `Tower.js` and `_openShop` both give
   * at the same point: the door leaves are DRAWN, and they are drawn shut at
   * build time, so `_solidifyStructure` bakes a static plug across the doorway
   * and the door is welded closed whether it swings or not. Every collider
   * this building needs is authored above instead - drum, lintel, skirt,
   * slabs, linings, mast fill, glazing, core, console, roof.
   *
   * `hw`/`hd` are 13.6, which is the skirt's own radius plus a little; `top` is
   * over the roof, because the whole thing is authored. The antenna field 20 m
   * further out is untouched by this and keeps its own colliders. */
  return {
    enterable,
    height: 48.3,
    footprint: { x, z, yaw, hw: 13.6, hd: 13.6, top: 48.6 },
  };
}
