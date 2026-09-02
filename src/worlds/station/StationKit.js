import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
/* The editor's opt-out flag, imported rather than restated: `markRampProxy`
 * below is the only place these three properties are set together. */
import { NOT_EDITABLE } from '../../systems/mapEditable.js';

/**
 * Shared vocabulary for the Aether Nexus Station and everything bolted onto it.
 *
 * This file holds the pieces the station's own builders and the outer-zone
 * builders both need: the layout constants that keep the map coherent, the
 * deterministic noise the textures are painted from, the UV helpers that give
 * every primitive constant texel density, and `GeoBatch`, which is what lets a
 * district of forty buildings cost a handful of draw calls.
 *
 * It exists because the station stopped being one room. Once the ring grew four
 * outer zones, each big enough to be its own world, a single 9,000-line world
 * file was no longer the right shape - but the zones still have to be built out
 * of exactly the same parts as the hub, or the seams show. Moving the parts here
 * rather than copying them is the whole point: there is one `GeoBatch`, one
 * `boxGeo`, one definition of where avenue 120 runs.
 */

/* ------------------------------------------------------------------ */
/* Scratch - reused every call, never allocated in a hot path          */
/* ------------------------------------------------------------------ */

const _dummy = new THREE.Object3D();
const _v1 = new THREE.Vector3();
const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();
const _mat4 = new THREE.Matrix4();
const _scl = new THREE.Vector3(1, 1, 1);

export const DEG = Math.PI / 180;

/* ------------------------------------------------------------------ */
/* Tilted collision proxies                                            */
/* ------------------------------------------------------------------ */

/**
 * How a `StationWorld._ramp` proxy says what it is.
 *
 * Physics only rotates boxes about Y, so every pitched walking surface in the
 * station - the escalator flights, the tower stairs, the walkway's stair
 * flights, the zone ramps - is collided by an invisible, fully-transformed box
 * mesh. The audit has to be able to find those to measure them against the
 * treads drawn on top, and it used to find them by their *renderer* state:
 * "an invisible, non-instanced, direct child of `world.group`". Two things are
 * wrong with that and both have bitten:
 *
 *   `visible` is not ours. `gfx/RehearsalDraw.js forceDrawable` clears it
 *   across the whole world group for the boot shader rehearsal, and an audit
 *   run inside that window matches nothing at all.
 *
 *   "direct child" is an accident of where `_ramp` happens to parent them, and
 *   nothing stops a future builder nesting one inside its own group.
 *
 * A flag in `userData` is neither. Nothing in the renderer, the LOD banding or
 * the rehearsal touches it.
 */
export const RAMP_PROXY_FLAG = 'rampProxy';
/** Human-readable counterpart, so a proxy is identifiable in a scene dump. */
export const RAMP_PROXY_NAME = 'ramp-proxy';

/**
 * A stable, readable id for an authored thing, slugged from the name its
 * builder already gave it.
 *
 * ── Why a name may not be a measurement ───────────────────────────────────
 * The admin map editor addresses objects BY NAME: a saved document carries
 * `target: { name: '…' }` and the applier resolves it with a single
 * `getObjectByName`. A miss is skipped with reason `name` and the world builds
 * perfectly well without it, so a name that changes is a saved edit that
 * quietly stops applying.
 *
 * Tower interiors used to name themselves `tower-interior-${round(x)}-${round(z)}`,
 * which is not an identity - it is a MEASUREMENT of where the tower happened to
 * stand. Any change that shifts a tower renames it and everything under it:
 * 180 of the station's 756 catalogue names were keyed that way, 24% of the
 * whole address space, and reconciling the two `ROAD_W` values alone would have
 * moved most of them.
 *
 * Every caller already had the answer. `spec.label` is authored - "Habitat
 * Stack N1", "Refectory Block", "Block D // Handed Over" - and is what the
 * building is called in the fiction. Slugging that gives a name that survives
 * the building being moved, which is the whole point.
 *
 * Runs of anything that is not a letter or a digit collapse to one `-`, so
 * `Block D // Handed Over` is `block-d-handed-over`. Returns '' for a label
 * with nothing sluggable in it, which callers must treat as an error rather
 * than as a name: an empty id would collide with the next empty one.
 *
 * @param {string} label
 * @returns {string}
 */
export function slugLabel(label) {
  return String(label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Stamp a mesh as a ramp collision proxy: named for a scene dump, flagged for
 * `rampProxiesIn`, and withheld from the map editor's object picker.
 *
 * One function rather than three copies of two lines, for the reason the note
 * above `RAMP_PROXY_FLAG` already gives about producers and consumers - and
 * because the third property is the one a copy would forget. `RAMP_PROXY_NAME`
 * is a single string shared by every proxy in a world, so before it was
 * withheld the editor offered ONE row that resolved to whichever proxy the
 * traversal happened to reach first; moving it separated the thing you walk on
 * from the ramp you can see. Station, the yard and every ship use this, so the
 * rule is fixed in one place for all three.
 *
 * @param {any} mesh
 * @returns {any} the same mesh
 */
export function markRampProxy(mesh) {
  mesh.name = RAMP_PROXY_NAME;
  mesh.userData[RAMP_PROXY_FLAG] = true;
  mesh.userData[NOT_EDITABLE] = true;
  return mesh;
}

/**
 * Every tilted collision proxy under `root`, however it is parented.
 *
 * Exported from the kit rather than kept in the audit so the producer and the
 * consumer of the flag are written next to each other - which is the whole of
 * why the old signature was allowed to drift out of step with the renderer.
 *
 * @param {{ traverse?: Function }} root usually `world.group`
 * @returns {Array<any>} the proxy meshes, each with a computed bounding box
 */
export function rampProxiesIn(root) {
  const out = [];
  if (!root?.traverse) return out;
  root.traverse((o) => {
    if (!o.isMesh || !o.userData?.[RAMP_PROXY_FLAG]) return;
    if (!o.geometry?.boundingBox) o.geometry?.computeBoundingBox?.();
    if (!o.geometry?.boundingBox) return;
    out.push(o);
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Layout - every builder reads these so the map stays coherent        */
/* ------------------------------------------------------------------ */

export const DECK_R = 200;      // walkable hub deck radius

/**
 * How far out the avenues are actually SURFACED.
 *
 * Twelve metres short of the deck rim, so the road stops before the edge
 * rather than running off it. This used to live as a bare `DECK_R - 12` inside
 * `_buildDeck` while `StationPlan` seeded its carriageway role all the way to
 * `DECK_R` - and those twelve metres of road that nobody had ever surfaced
 * were counted as carriageway by every conflict query. All eight of the link
 * mouth conflicts, which the plan-conflicts gate had recorded as an open design
 * question ("something has to cross the avenue there"), were geometry crossing
 * a road that is not there.
 *
 * One constant, imported by both, because the answer to "how long is an
 * avenue" cannot be allowed to differ between the thing that draws it and the
 * thing that describes it.
 */
export const ROAD_R1 = DECK_R - 12;
export const HULL_R = 202;      // hub structural hull radius
export const WALL_H = 48;       // hub window / hull wall height
export const CEIL_Y = 62;       // hub overhead deck plate
export const PLAZA_R = 40;
export const ROAD_W = 18;
export const LOOP_R = 72;       // elevated walkway loop radius
export const LOOP_Y = 10;
export const PORTAL_R = 54;     // distance of the portal daises from the plaza centre
export const OCULUS_R = 34;     // glazed opening in the overhead plate, over the plaza
export const WINDOW_HALF = 55;  // hub window sector half-angle, centred on +X

/* ------------------------------------------------------------------ */
/* The elevated walkway loop                                           */
/* ------------------------------------------------------------------ */

/**
 * The loop's own numbers, and the two derivations that were previously guessed.
 *
 * `_buildWalkwayLoop` carried these inline, and the one that mattered most -
 * where a stair flight stops climbing - was `LOOP_R`, the loop's CENTRELINE.
 * The deck is `WIDTH` across, so the last half-width of every flight ran
 * underneath the walkway it was climbing to, with 1.66 m of headroom falling to
 * 0.16 m: no flight ever reached the promenade. The arrival radius is derived
 * here, beside the width it is derived FROM, so the two cannot disagree again.
 */
export const WALKWAY = {
  /** Deck width, centred on LOOP_R. */
  WIDTH: 6,
  /** Drawn grate slab: thickness, and its centre relative to LOOP_Y. */
  GRATE_T: 0.45,
  GRATE_DY: -0.22,
  /** Railings stand this far in from each deck edge. */
  RAIL_INSET: 0.15,
  /** Bearings of the four radial stair flights, in degrees. */
  STAIR_DEG: [30, 150, 210, 330],
  /**
   * Foot of a flight, on the open deck.
   *
   * ── This was 88, and 88 is what made the flights unclimbable ───────────
   * Landing the flight on the deck EDGE rather than on its centreline was the
   * right fix and is not being undone; taking the run from 16 m to 13 m to pay
   * for it was not. It put the pitch at 37.6 degrees, and it was recorded at the
   * time as "5% steeper, which is the price of landing on the deck at all".
   * That was wrong twice: it is 22% steeper, and it is not a cosmetic number.
   * Measured on the running page, a civilian steered at the head of the flight
   * at bearing 30 from open deck walks in to r = 88.07 and stops there - 22 s of
   * simulation, `avoidBrake` oscillating 0.30-0.62 with `blocked` latching, y
   * never leaving 0. The steering probe fan reads a 37.6 degree slab in front of
   * a character's shins as a wall, because at that pitch it IS one as far as a
   * horizontal raycast is concerned.
   *
   * The note also said the foot could not move outward because "the hub
   * buildings begin at r = 91 on all four of these bearings". They do not. Swept
   * on the running page at all four bearings, across the flight's full 5.2 m
   * width (+-2.6 m, which covers the stringers), the hub deck is solid at y = 0
   * with nothing standing on it and nothing overhead from r = 88 continuously
   * out to r = 94.5. The first thing in the way is an arcade soffit at bearing
   * 30 only, at r = 94 and 2.04 m up.
   *
   * So the foot goes out to 92.8: a 17 m run, 30.5 degrees, which is the
   * station's own escalator pitch (Tower.js `ESC_RISE_RUN`, 30 degrees) to
   * within half a degree, and still leaves 1.2 m of open deck outboard of the
   * bottom step to stand on before the nearest obstruction. Both halves hold -
   * the flight lands on the deck plate AND it is climbable.
   *
   * (The 17 m is the PITCHED run, 92.8 in to 75.8; the last 0.8 m from 75.8 to
   * the deck edge at 75 is a flat landing - see `STAIR_LANDING`.)
   */
  STAIR_R_OUTER: 92.8,
  /**
   * A flat landing between the top of the pitch and the deck's edge.
   *
   * ── Without it the last 0.17 m of the climb is unwalkable ──────────────
   * The ramp's top face and the deck plate are coplanar at r = 75, so on paper
   * the flight arrives flush. A capsule cannot get there. The deck collider is
   * a slab whose outer FACE is vertical, and a character climbing the ramp
   * meets that face's top edge from below: the nearest point on the slab is the
   * edge, the push is from the edge toward the capsule centre - outward and
   * only slightly up - and the character parks against it. Measured on the
   * running page, a civilian climbed the whole flight cleanly with the steering
   * never braking, arrived at r = 75.38 and y = 9.84 (0.165 m under the plate),
   * and then milled about there for 25 s at full walking speed without ever
   * getting on.
   *
   * The general problem is that a character has no step-up: the ground follower
   * pins its feet to whatever surface is under its own column, so nothing lifts
   * it over a lip the way the player's `stepHeight` does. Giving every NPC a
   * step-up is a change to how every character in the game moves; making the
   * flight arrive FLAT is a change to one flight. The pitched part now tops out
   * 0.8 m short of the deck edge and a flat landing carries the last 0.8 m at
   * plate height, so there is no upward-facing edge along the arrival at all.
   * Driven again on the running page, the same civilian finishes standing on
   * the plate at r = 74.4, y = 10.01.
   *
   * (A headless fixture does NOT reproduce the stall - a lone 20 m slab lets
   * the capsule scramble over its edge where the real deck's 36 chord segments
   * and railings did not - which is why the landing is pinned by its geometry
   * in scripts/tests/station-walkway-stairs.test.mjs and by the measurement
   * above, rather than by a headless negative that would be a lie.)
   *
   * This is the same thing `Tower.js` already does at the head of every
   * escalator - "Top landing, bridging from the flight's head to the solid
   * slab" - which is why the escalators do not have this problem.
   */
  STAIR_LANDING: 0.8,
  /**
   * How far out the hub deck stays open in front of a flight, MEASURED.
   *
   * Swept on the running page with `physics.groundHeight`, `containsPoint` and
   * an upward ray, at all four stair bearings and at seven offsets across the
   * flight's full width (+-2.6 m, which covers the stringers at +-2.5): the deck
   * is solid at y = 0, with nothing standing on it and nothing overhead, from
   * r = 88 continuously out to r = 94.5. The first obstruction is an arcade
   * soffit on bearing 30 alone, at r = 94 and 2.04 m up; bearings 150, 210 and
   * 330 are clear past 96.
   *
   * This is here so that "the bottom step has somewhere to be approached from"
   * is a checkable statement rather than a hope, and so that moving
   * `STAIR_R_OUTER` again has to come past a number somebody measured.
   */
  DECK_CLEAR_R: 94,
  /**
   * The steepest a flight may be and still be walked up.
   *
   * Not a building code - the honest reference is what this game's own
   * characters can do. `Physics.resolveCapsule` calls a surface ground at
   * `normal.y > 0.64` (50 degrees) and `Grounding.WALKABLE_NORMAL_Y` is 0.55
   * (57 degrees), but neither of those is the binding constraint: the steering
   * is, and the measurement above is the evidence. The station's escalators run
   * at exactly 30 degrees and are traversed, so the band is pinned just above
   * them rather than at a physics limit no character gets near.
   */
  STAIR_PITCH_MAX_DEG: 32,
  /** Clear width of a flight. */
  STAIR_W: 4.6,
  /**
   * Going of one step - the horizontal depth of a tread.
   *
   * The tread is drawn 0.62 m deep, so 0.5 m of going leaves a 0.12 m nosing
   * and no daylight between consecutive treads. The step COUNT is derived from
   * this and the run rather than fixed, which is the thing that was wrong with
   * the fixed 26: 26 steps over a run that changed length silently changed the
   * going with it, and a 13 m run had already stretched the riser from 0.367 to
   * 0.385 m without anybody choosing that.
   */
  STAIR_GOING: 0.5,
  /** Half the opening cut in the outer railing at each flight: clears the
   *  4.6 m flight and its stringer rails at +-2.5 with a hand's breadth. */
  STAIR_GAP_HALF: 2.7,
};

/** Top face of the drawn grate - the surface anything meeting the loop meets. */
export const WALKWAY_DECK_TOP = LOOP_Y + WALKWAY.GRATE_DY + WALKWAY.GRATE_T / 2;

/** Where a flight arrives: the deck's OUTER edge, not its centreline. */
export const WALKWAY_STAIR_R_INNER = LOOP_R + WALKWAY.WIDTH / 2;

/** Where the PITCHED part stops: one landing short of the deck edge. */
export const WALKWAY_STAIR_R_HEAD = WALKWAY_STAIR_R_INNER + WALKWAY.STAIR_LANDING;

/**
 * One flight, fully determined by the constants above.
 *
 * `rInner` is where the flight ARRIVES - the deck's outer edge - and `rHead` is
 * where it stops climbing, one landing further out. The pitch is measured over
 * the pitched part only, because a landing is not part of a slope.
 *
 * `rampSeat` is the Y of the `_ramp` proxy's centre. That proxy is 0.5 m thick
 * and pitched, so its centre has to sit `0.25 / cos(pitch)` below the walking
 * line for its top face to lie ON the line - the same relationship
 * `escalatorDeckDrop` pins for the escalators. It used to be a flat 0.24, which
 * left the collision surface 0.051 m above the treads drawn on it.
 */
export function walkwayStairFlight() {
  const rOuter = WALKWAY.STAIR_R_OUTER;
  const rInner = WALKWAY_STAIR_R_INNER;
  const rHead = WALKWAY_STAIR_R_HEAD;
  const landing = WALKWAY.STAIR_LANDING;
  const run = rOuter - rHead;
  const rise = WALKWAY_DECK_TOP;
  const pitch = Math.atan2(rise, run);
  /* Steps follow the run so the drawn stair keeps its going whatever the run
   * becomes. Rounded, then the going and the riser are read back off the
   * rounded count, so the treads land ON the run rather than near it. */
  const steps = Math.max(2, Math.round(run / WALKWAY.STAIR_GOING));
  return {
    rOuter, rInner, rHead, landing, run, rise, pitch,
    pitchDeg: pitch / DEG,
    steps,
    going: run / steps,
    riser: rise / steps,
    rampSeat: rise / 2 - 0.25 / Math.cos(pitch),
    /** Centre radius of the flat landing, and its half-depth. */
    landingR: (rInner + rHead) / 2,
    landingHalf: landing / 2,
  };
}

/**
 * The stretches of one railing piece that survive the four stair openings.
 *
 * Same shape as the ceiling's `chordRuns`: a run is an interval along the
 * piece's own long axis, and cutting it returns fewer, shorter intervals rather
 * than deciding whether to draw the whole piece at all. A segment is 12.6 m of
 * arc and an opening is 5.4 m, so "skip the segment" would leave a hole two and
 * a half times the width of the stair standing in it.
 *
 * `GeoBatch.at` maps local +X onto (-sin th, cos th) - the +theta tangent - and
 * the piece is a straight chord, so a flight at bearing `sdeg` sits exactly
 * `rr * dtheta` along it from its centre.
 *
 * @param {number} th     bearing of this piece's centre, radians
 * @param {number} rr     radius the piece is drawn at
 * @param {number} chord  its full length
 * @param {boolean} cut   false for the inner railing, which is never cut: it is
 *                        the plaza-side edge of a walkway 10 m up, nothing
 *                        crosses it, and a gap in it is a fall, not a door
 * @returns {Array<[number, number]>} surviving [from, to] offsets from centre
 */
export function walkwayRailRuns(th, rr, chord, cut) {
  let runs = [[-chord / 2, chord / 2]];
  if (!cut) return runs;
  for (const sdeg of WALKWAY.STAIR_DEG) {
    let d = sdeg * DEG - th;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const a = rr * d - WALKWAY.STAIR_GAP_HALF;
    const b = rr * d + WALKWAY.STAIR_GAP_HALF;
    const next = [];
    for (const [s, e] of runs) {
      if (b <= s || a >= e) { next.push([s, e]); continue; }
      if (a - s > 0.05) next.push([s, a]);
      if (e - b > 0.05) next.push([b, e]);
    }
    runs = next;
  }
  return runs;
}

/* ------------------------------------------------------------------ */
/* The observation promenade against the hero window                   */
/* ------------------------------------------------------------------ */

/**
 * The promenade's two flights, and the openings they need in the balustrade.
 *
 * ── The defect these constants exist for ──────────────────────────────────
 * Both flights onto the deck dead-ended against the promenade's own
 * balustrade. Arithmetic, from the authored numbers alone: a segment is
 * `174 * (96 deg in rad) / 26 + 0.6` = 11.813 m of chord laid at a spacing of
 * `158 * (96 deg / 25 rad)` = 10.589 m, so every one of the twenty-six
 * OVERLAPS its neighbour by 1.22 m across the whole +-48 degrees and the loop
 * that draws them has no skip condition anywhere. The rail collider spans
 * y 1.40 to 3.80 and a flight's head arrives at 2.00, so the last thing on the
 * way up was a 1.8 m wall - and the deck behind it (the hero-window viewpoint,
 * nine telescopes, the benches) was reachable only by mantling it.
 *
 * `walkwayRailRuns` had already solved exactly this for the walkway loop's
 * four stair openings, so this is that solution applied a second time rather
 * than a second solution: cut the opening OUT OF the piece along its own axis,
 * never skip the piece. A promenade segment is 11.8 m of arc and an opening is
 * 6.8 m, so "skip the segment" would leave a hole nearly twice the width of
 * the flight standing in it.
 *
 * `RAIL_GAP_HALF` clears the 6 m flight at +-3.0 with 0.4 m either side, the
 * same hand's breadth `WALKWAY.STAIR_GAP_HALF` leaves its 4.6 m flight.
 */
export const PROMENADE = Object.freeze({
  /** Inner (balustrade) and outer radius of the raised deck. */
  R0: 158,
  R1: 190,
  /** Bearings of the two flights, degrees. */
  RAMP_DEG: Object.freeze([-18, 18]),
  /** Clear width, horizontal run and rise of one flight. */
  RAMP_W: 6,
  RAMP_RUN: 6,
  RAMP_RISE: 2.0,
  /** Half the opening cut in the balustrade at each flight head. */
  RAIL_GAP_HALF: 3.4,
  /** Top face of the raised deck - what a flight has to arrive AT. */
  DECK_TOP: 2.0,
  /** Top of the drawn handrail cap: `3.28 + 0.09 / 2`. */
  RAIL_TOP: 3.325,
  /** Half the arc the deck spans, degrees. The builder's own extent. */
  HALF_ARC_DEG: 48,
});

/**
 * Is (x, z) standing on the promenade - its deck, or one of its two flights?
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * The promenade is 32 m of raised deck across 96 degrees at the far end of the
 * +Z commercial approach, and it was authored after the things standing where
 * it now is. Nothing on the map knew it was there. Measured on the built world:
 * the lit shopfront band that lines the approach ran four panels straight
 * THROUGH it - one across the +18 degree flight with its soffit 0.10 m over
 * the promenade's own deck height, and three standing on the deck itself.
 *
 * So this is the promenade's footprint, published once, for anything that has
 * to keep out of it. Same shape of answer `StationPlan.roleUnder` gives for a
 * carriageway; this one is geometric because the promenade is not a plan
 * region.
 *
 * The flights are included because a flight is the only walkable thing inside
 * `R0`, and a soffit over a flight is exactly as impassable as one over the
 * deck - more so, because the flight climbs INTO it.
 *
 * @param {number} x
 * @param {number} z
 * @returns {boolean}
 */
export function onPromenadeFootprint(x, z) {
  const r = Math.hypot(x, z);
  const half = PROMENADE.HALF_ARC_DEG * DEG;
  if (r >= PROMENADE.R0 && r <= PROMENADE.R1 && Math.abs(Math.atan2(z, x)) <= half) return true;
  for (const deg of PROMENADE.RAMP_DEG) {
    const th = deg * DEG;
    // Radial and tangential offsets in the flight's own frame.
    const u = x * Math.cos(th) + z * Math.sin(th);
    const v = -x * Math.sin(th) + z * Math.cos(th);
    if (u >= PROMENADE.R0 - PROMENADE.RAMP_RUN && u <= PROMENADE.R0
      && Math.abs(v) <= PROMENADE.RAMP_W / 2) return true;
  }
  return false;
}

/**
 * Does an axis-aligned footprint reach the promenade anywhere?
 *
 * The four corners are the whole test and that is exact enough to say out
 * loud: the deck is an annulus sector, and the deepest a straight 8 m chord
 * bows inside a 152 m arc is `8^2 / (8 * 152)` = 0.053 m. A rectangle whose
 * corners all miss the promenade by more than a 5 cm sagitta misses it.
 *
 * @param {number} cx   footprint centre
 * @param {number} cz
 * @param {number} hx   half-extents, world axes (the callers are yaw 0)
 * @param {number} hz
 */
export function boxOnPromenade(cx, cz, hx, hz) {
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      if (onPromenadeFootprint(cx + sx * hx, cz + sz * hz)) return true;
    }
  }
  return onPromenadeFootprint(cx, cz);
}

/**
 * Pitch of a promenade flight, and where its `_ramp` proxy centre belongs.
 *
 * Same relationship `walkwayStairFlight().rampSeat` pins: the proxy box is
 * 0.5 m thick and pitched, so its centre has to sit `0.25 / cos(pitch)` below
 * the walking line for its TOP FACE to lie on that line. Authored flat, the
 * seat was 0.85 against a drawn grate whose top face is at 1.205, so feet sank
 * 0.092 m into the visible ramp - the same defect, nearly twice the size, as
 * the 0.051 m one `rampSeat` was written for.
 *
 * `grateSeat` is the matching centre for the 0.2 m drawn pad, so the drawing
 * and the collider are two expressions of one walking line rather than two
 * numbers that happen to be close.
 */
export function promenadeFlight() {
  const pitch = Math.atan2(PROMENADE.RAMP_RISE, PROMENADE.RAMP_RUN);
  const mid = PROMENADE.RAMP_RISE / 2;
  return {
    pitch,
    pitchDeg: pitch / DEG,
    /** Y of the `_ramp` proxy centre. */
    rampSeat: mid - 0.25 / Math.cos(pitch),
    /** Y of the drawn 0.2 m grate pad's centre. */
    grateSeat: mid - 0.1 / Math.cos(pitch),
  };
}

/**
 * The stretches of one balustrade piece that survive the two flight openings.
 *
 * Identical in shape to `walkwayRailRuns`: a run is an interval along the
 * piece's own long axis and cutting it returns fewer, shorter intervals. The
 * balustrade is drawn with `ry = -th`, which puts local +Z on the +theta
 * tangent, so a flight at bearing `sdeg` sits `rr * dtheta` along the piece
 * from its centre.
 *
 * @param {number} th     bearing of this piece's centre, radians
 * @param {number} rr     radius the piece is drawn at
 * @param {number} chord  its full length
 * @returns {Array<[number, number]>} surviving [from, to] offsets from centre
 */
export function promenadeRailRuns(th, rr, chord) {
  let runs = [[-chord / 2, chord / 2]];
  for (const sdeg of PROMENADE.RAMP_DEG) {
    let d = sdeg * DEG - th;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const a = rr * d - PROMENADE.RAIL_GAP_HALF;
    const b = rr * d + PROMENADE.RAIL_GAP_HALF;
    const next = [];
    for (const [s, e] of runs) {
      if (b <= s || a >= e) { next.push([s, e]); continue; }
      if (a - s > 0.05) next.push([s, a]);
      if (e - b > 0.05) next.push([b, e]);
    }
    runs = next;
  }
  return runs;
}

/**
 * Walking surface of a gateway dais - where the approach steps arrive, where
 * the ceremonial arch stands, and where a portal's own plinth starts.
 */
export const GATEWAY_DECK_Y = 2.4;

/**
 * Offsets of the backdrop pylons from a gateway's centre, along and across its
 * axis. Chosen so a 2.6 m pylon lands wholly inside the 11 m dais.
 */
export const PYLON_OFF = { a: 8.1, b: 3.8 };

/* ------------------------------------------------------------------ */
/* The outer ring - four zones on the ends of four avenues             */
/* ------------------------------------------------------------------ */

/**
 * Length of a connecting passageway, hull face to zone rim.
 *
 * Long enough that a zone is somewhere you *travel to* rather than a room off
 * the plaza, short enough that the walk is not the content. At 96 m a jog takes
 * about twenty seconds and a hoverboard about six, and the tunnel has room for
 * the airlock rings, the two service bays and the travelator run that make it
 * worth walking rather than a loading corridor.
 */
export const LINK_LEN = 96;

/**
 * Radius of an outer zone's deck.
 *
 * Deliberately equal to `DECK_R`: each zone is the same *area* as the original
 * station, which is what makes the finished map five times the size it was.
 */
export const ZONE_R = 200;

/** Distance from the world origin to an outer zone's centre. */
export const ZONE_CENTRE_R = HULL_R + LINK_LEN + ZONE_R;   // 498

/**
 * Which avenue carries which zone.
 *
 * Avenues 0 and 60 are left alone. Avenue 0 is the axis of the great window and
 * the hero shot of the whole game; punching a corridor down it would put a
 * tunnel mouth through the glass. Avenue 60 terminates in Hangar Bay 4, which is
 * already a destination.
 *
 * The four that are extended each continue what their district was already
 * about, so the corridor reads as the district getting longer rather than as a
 * door to somewhere unrelated:
 *
 *   120 habitat        -> crew quarters, the hab stacks continued
 *   180 control tower  -> the crew athletics deck, an amenity off the admin arc
 *   240 cargo yard     -> the expansion site, plant and steel off the freight arc
 *   300 residential    -> the galley, where the people in those flats eat
 *
 * `accent` is the district emissive family the hub already uses for that
 * bearing, so the wayfinding colour a player followed out of the plaza is still
 * the colour they arrive under.
 */
export const ZONES = [
  {
    id: 'habitation',
    signCell: 28,
    deg: 120,
    label: 'HAB RING C',
    sub: 'CREW QUARTERS',
    accent: 'emCyan',
    accentHex: 0x8fe6c8,
    linkName: 'Hab Transit',
  },
  {
    id: 'gym',
    signCell: 29,
    deg: 180,
    label: 'DECK 9 ATHLETICS',
    sub: 'CREW CONDITIONING',
    accent: 'emMagenta',
    accentHex: 0xc9b0ff,
    linkName: 'Athletics Link',
  },
  {
    id: 'construction',
    signCell: 30,
    deg: 240,
    label: 'RING 8 EXPANSION',
    sub: 'HARD HAT AREA',
    accent: 'emSodium',
    accentHex: 0xff9d6a,
    linkName: 'Works Access',
  },
  {
    id: 'canteen',
    signCell: 31,
    deg: 300,
    label: 'THE LONG GALLEY',
    sub: 'MESS + PROVISIONS',
    accent: 'emAmber',
    accentHex: 0xffc98a,
    linkName: 'Galley Concourse',
  },
];

/** Outer radius of the great dome's perimeter wall. */
export const DOME_R = 720;
/** Height of the vertical glazed section before the dome roof springs. */
export const DOME_WALL_H = 70;
/** Height of the dome roof at the world origin. */
export const DOME_APEX = 170;

/**
 * The dome roof is a spherical cap through (DOME_R, DOME_WALL_H) and
 * (0, DOME_APEX). Solving for a sphere centred on the world axis at `y = c`:
 *
 *   R^2 = DOME_R^2 + (DOME_WALL_H - c)^2 = (DOME_APEX - c)^2
 *
 * which gives an enormous radius and a very shallow cap - about 100 m of rise
 * over 720 m of span. That is what a pressurised dome this wide actually looks
 * like, and it costs a couple of thousand triangles instead of a hemisphere's
 * hundred thousand.
 */
export const DOME_CENTRE_Y =
  (DOME_APEX * DOME_APEX - DOME_WALL_H * DOME_WALL_H - DOME_R * DOME_R) /
  (2 * (DOME_APEX - DOME_WALL_H));
export const DOME_SPHERE_R = DOME_APEX - DOME_CENTRE_Y;

/** Height of the dome roof directly above a point `r` from the world axis. */
export function domeHeightAt(r) {
  const k = DOME_SPHERE_R * DOME_SPHERE_R - r * r;
  if (k <= 0) return DOME_WALL_H;
  return DOME_CENTRE_Y + Math.sqrt(k);
}

/**
 * Radius of everything a player can reach, used for bounds, collision extraction
 * and the occupancy grid. The dome wall plus a little slack for its buttressing.
 */
export const WORLD_R = DOME_R + 24;

/* ------------------------------------------------------------------ */
/* Collision tuning                                                    */
/* ------------------------------------------------------------------ */

/**
 * Ceiling for geometry-derived collision.
 *
 * On the original ring the highest surface a player could stand on was 48.5 m
 * and 52 cleared it. The outer zones raised that: the hab stacks reach 46 m, the
 * expansion site's scaffold decks 52, and the gantry crane's walkway 58. This is
 * the highest standable surface anywhere on the finished map plus a metre, and
 * still below the dome roof and the canopy rigging, which nothing reaches.
 */
export const COLLIDE_CEILING = 62;

/**
 * Triangles per derived collision chunk. Measured across 8,192 / 4,096 / 2,048
 * chunk splits of the same soup: finer chunks make the capsule solver cheaper
 * and the raycaster dearer, and this is where the two curves cross.
 */
export const CHUNK_TRIS = 32;

/** Triangles per planting proxy box. See `_solidifyPlanting`. */
export const PLANTING_TRIS = 64;

/**
 * Largest a planting proxy box may be in any direction.
 *
 * `PLANTING_TRIS` alone was a size budget in disguise, and it stopped being one
 * the moment planting existed anywhere but the hub. The chunker splits on
 * triangle COUNT, so sixty scattered shrubs strung across a zone are one chunk
 * exactly as much as sixty triangles of one hedge are - and each chunk becomes a
 * single box sized to its own bounds. Measured on the finished map the moment
 * the outer ring started contributing: twelve boxes over 20 m and a worst case
 * of 300 m, one of which was a solid slab 250 by 301 m lying across the
 * habitation link at chest height. It sealed the corridor, and with it a fifth
 * of the walkable map. Nothing about that box was visible; it was a shrub.
 *
 * So the size budget is now stated rather than implied. 4 m is a little larger
 * than a real foliage lobe, which is all a proxy is ever meant to hug, and
 * narrower than the narrowest circulation route on the map - the hab arcade's
 * 5.4 m spokes - so a proxy can no longer span anything a player walks down.
 * Measured over the whole map's planting: 1,024 boxes unbounded against 1,439
 * at 4 m, and the falsely-solid volume falls from a slab the size of a district
 * to 3,803 m3 total. Below 4 the volume curve is flat (3,615 m3 at 3 m for
 * another 219 boxes), so this is the knee.
 */
export const PLANTING_SPAN = 4;

/** Cell size of the deck-occupancy grid used to keep scattered props clear. */
export const OCC_CELL = 1.5;

/**
 * Key a world position into the occupancy grid.
 *
 * The original packed a +/-512 cell index into 11 bits, which covered the 200 m
 * ring with room to spare and overflows silently at 768 m - well inside the
 * finished map, where a prop at the far rim of the galley would have aliased
 * onto a cell over the plaza. 13 bits and a +4096 bias covers +/-6 km.
 */
export const OCC_BIAS = 4096;
export const OCC_SHIFT = 13;
export function occKeyOf(x, z) {
  return ((Math.floor(x / OCC_CELL) + OCC_BIAS) << OCC_SHIFT) | (Math.floor(z / OCC_CELL) + OCC_BIAS);
}
export function occCellKey(gx, gz) {
  return ((gx + OCC_BIAS) << OCC_SHIFT) | (gz + OCC_BIAS);
}

/**
 * Material keys that never take part in collision: hoses and cable runs lying
 * across the deck, floor films, decals and sign faces. Every `em*` emissive is
 * excluded by prefix in `_collisionSoup`.
 *
 * Planting is deliberately NOT on this list - it is hedge and shrub mass at
 * chest height, which you walk into. It gets proxies rather than triangles.
 */
export const NON_SOLID_KEYS = new Set([
  'rubber',
  'wet', 'decals', 'decal', 'polish',
  'signs',
]);

/** Material keys collided as coarse boxes instead of triangles. */
export const PROXY_KEYS = new Set(['foliage', 'foliagePale', 'foliageCard']);

/* The hero anchor. The near-field dressing pass is composed against this exact
 * position and heading. */
export const SPAWN_X = -34, SPAWN_Z = 2;
export const SPAWN_YAW = -Math.PI / 2;   // faces +X, down the plaza axis

/* Signage atlas dimensions. The `SIGNS` copy table lives with the painter.
 *
 * 9 rows, not 7. The atlas was exactly full - 28 cells for 28 signs, every one
 * reserved by role so no two signs in a cluster can carry the same copy - and
 * the outer ring needs eight more: a board for each zone, the galley's stall
 * fascia, the order-point placard, and the two safety notices the gym and the
 * building site are legally the sort of places that would have. There was no
 * cell to borrow, so the sheet grows.
 *
 * The 768 x 384 cell is deliberately NOT reduced to pay for them. That size is
 * itself a fix - see the note beside the canvas allocation in StationWorld's
 * `_buildTextures` - and shrinking the cell to keep the sheet the same number
 * of pixels would undo the one thing this texture exists to do. One more row
 * (the tenth, for the maze gateway arch) costs about 4.5 MB. A sign nobody can
 * read costs more.
 *
 * 11 rows, not 10. The sheet was exactly full again - 40 cells for 40 signs -
 * and the sixth gateway needs two: its lintel placard and its approach board.
 * The precedent above is followed rather than argued with, at the same ~4.5 MB.
 * Two of the four new cells are spare; that is the cost of a row, not slack
 * anybody may borrow, because every cell here is reserved BY ROLE and a
 * wayfinding board that shares a cell with a shop fascia announces a noodle
 * bar over a door to another world. */
export const SIGN_COLS = 4;
export const SIGN_ROWS = 11;

/* ------------------------------------------------------------------ */
/* The ambient crowd's skeleton                                        */
/* ------------------------------------------------------------------ */

/**
 * Every joint the plaza crowd is built from, in one table, in body space.
 *
 * ── Why these numbers moved out of `StationWorld._crowdBodyGeo` ───────────
 *
 * They were literals inside three sibling builders (`_crowdBodyGeo`,
 * `_crowdSeatedGeo`, `_crowdHeadGeo`), which was fine while the only thing
 * that read them was the mesh they were typed into. Phase 9 adds a SECOND
 * reader: `scripts/make-crowd-glb.mjs` authors hands, hair, a collar and shoes
 * that have to land ON those joints, and it runs in Node, hours before the
 * world is built, with no access to a class method's inline constants.
 *
 * `make-ship-glb.mjs` paid for the alternative once already: asserting two of
 * a plan's fields let a 0.40 m divergence ship unnoticed. `make-beast-glb.mjs`
 * answered it by deriving its anchors from `BeastBody.PROFILES` - the same
 * table the game builds from - so a profile edit that moves a skull moves the
 * brow with it, or fails the gate. This is that answer, applied to a crowd.
 *
 * A wrist is therefore not a number anybody types twice. It is `crowdWrist()`,
 * below, computed from the arm's own pivot, length and tilt, and
 * `crowd-assets.test.mjs` asserts the authored hand actually sits there.
 *
 * ── The one asymmetry, which is deliberate and is NOT a mirror ────────────
 *
 * `FORE_R` / `FORE_L` are different numbers. The legs are offset fore and aft
 * as well as laterally so a figure reads as standing rather than as a pair of
 * pillars, and that means the two feet are NOT mirror images across x. A shoe
 * authored on one side and mirrored would be 16 cm out of place on the other -
 * the same shape of defect as the hero pass's hands bound across the
 * centreline, which cost a whole round before a screenshot found it.
 */
export const CROWD = Object.freeze({
  /* Head. The sphere is scaled non-uniformly, so a hair cap sitting on it has
   * to be scaled by the same triple or it floats off the crown at the sides. */
  HEAD_Y: 1.66, HEAD_R: 0.105, HEAD_SX: 0.94, HEAD_SY: 1.12, HEAD_SZ: 1.0,
  JAW_Y: 1.60, JAW_Z: 0.03, JAW_W: 0.13, JAW_H: 0.07, JAW_D: 0.11,
  NECK_Y: 1.535, NECK_RT: 0.055, NECK_RB: 0.07, NECK_H: 0.10,
  /* Shoulder yoke: a capsule laid along x, so its half-extent is L/2 + R. */
  YOKE_Y: 1.40, YOKE_R: 0.09, YOKE_L: 0.30,
  CHEST_Y: 1.20, CHEST_R: 0.20, CHEST_L: 0.44,
  HIP_Y: 0.95, HIP_RT: 0.215, HIP_RB: 0.185, HIP_H: 0.30,
  /* Arms. `ARM_TILT` is a rotation about z, mirrored by side. */
  ARM_X: 0.30, ARM_Y: 1.16, ARM_Z: 0.01, ARM_R: 0.062, ARM_L: 0.46, ARM_TILT: 0.14,
  /* Legs, and the stance offsets that make them not a mirror pair. */
  LEG_X: 0.16, LEG_Y: 0.50, LEG_R: 0.085, LEG_L: 0.52, LEG_TILT: 0.06,
  FORE_R: 0.09, FORE_L: -0.07,
  FOOT_Y: 0.04, FOOT_DZ: 0.04, FOOT_W: 0.12, FOOT_H: 0.07, FOOT_D: 0.26,

  /* --- The seated variant, authored around a 0.66 m bench seat ------- */
  SEAT_HEAD_DY: -0.38, SEAT_HEAD_DZ: 0.02,
  SEAT_CHEST_Y: 1.06, SEAT_CHEST_Z: 0.02, SEAT_CHEST_L: 0.38, SEAT_CHEST_RX: -0.10,
  SEAT_HIP_Y: 0.79, SEAT_HIP_RB: 0.20, SEAT_HIP_H: 0.26,
  SEAT_YOKE_Y: 1.26, SEAT_YOKE_Z: 0.01,
  SEAT_THIGH_X: 0.14, SEAT_THIGH_Y: 0.72, SEAT_THIGH_Z: -0.24, SEAT_THIGH_R: 0.085, SEAT_THIGH_L: 0.34,
  SEAT_CALF_Y: 0.36, SEAT_CALF_Z: -0.44, SEAT_CALF_R: 0.075, SEAT_CALF_L: 0.34, SEAT_CALF_RX: 0.12,
  SEAT_FOOT_Y: 0.04, SEAT_FOOT_Z: -0.50,
  /* Forearm resting on the thigh. Composed 'YXZ' with ry = 0, i.e. Rx * Rz. */
  SEAT_ARM_X: 0.26, SEAT_ARM_Y: 1.00, SEAT_ARM_Z: -0.06,
  SEAT_ARM_R: 0.06, SEAT_ARM_L: 0.30, SEAT_ARM_TILT: 0.10, SEAT_ARM_RX: 0.55,
});

/**
 * Where a standing figure's arm actually ends, derived rather than typed.
 *
 * The arm is a capsule of length `ARM_L` and radius `ARM_R` about a pivot at
 * (`side * ARM_X`, `ARM_Y`, `ARM_Z`), rotated `side * ARM_TILT` about z. Its
 * free end is therefore `ARM_L / 2 + ARM_R` down the capsule's own axis, which
 * the tilt swings outward. Get the sign of that swing wrong and both hands end
 * up inside the torso.
 *
 * @param {number} side -1 (left) or +1 (right)
 * @returns {[number, number, number]} body-space wrist centre
 */
export function crowdWrist(side) {
  const C = CROWD;
  const reach = C.ARM_L / 2 + C.ARM_R;
  const th = side * C.ARM_TILT;
  /* Rz(th) applied to (0, -reach, 0). */
  return [side * C.ARM_X + reach * Math.sin(th), C.ARM_Y - reach * Math.cos(th), C.ARM_Z];
}

/**
 * The same, for the seated variant, whose forearm is raked forward and down
 * onto the thigh by an Euler composed 'YXZ' with ry = 0 - i.e. Rx * Rz, in
 * that order. Composing it the other way puts the hands in mid-air beside the
 * hips, which reads as a shrug.
 *
 * @param {number} side -1 (left) or +1 (right)
 * @returns {[number, number, number]}
 */
export function crowdSeatedWrist(side) {
  const C = CROWD;
  const reach = C.SEAT_ARM_L / 2 + C.SEAT_ARM_R;
  const tz = side * C.SEAT_ARM_TILT;
  /* Rz first: (0, -reach, 0) -> (reach sin tz, -reach cos tz, 0). */
  const x = reach * Math.sin(tz);
  const y = -reach * Math.cos(tz);
  /* then Rx(SEAT_ARM_RX): y' = y cos - z sin, z' = y sin + z cos, with z = 0. */
  const rx = C.SEAT_ARM_RX;
  return [
    side * C.SEAT_ARM_X + x,
    C.SEAT_ARM_Y + y * Math.cos(rx),
    C.SEAT_ARM_Z + y * Math.sin(rx),
  ];
}

/**
 * The fore/aft stance offset for one side. Not a mirror - see `CROWD`.
 * @param {number} side -1 or +1
 */
export const crowdFore = (side) => (side > 0 ? CROWD.FORE_R : CROWD.FORE_L);

/* ------------------------------------------------------------------ */
/* Deterministic noise + rng                                           */
/* ------------------------------------------------------------------ */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashi(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Tileable value noise on an integer lattice of `period` cells. */
export function tnoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const m = (n) => ((n % period) + period) % period;
  const a = hashi(m(xi), m(yi), seed);
  const b = hashi(m(xi + 1), m(yi), seed);
  const c = hashi(m(xi), m(yi + 1), seed);
  const d = hashi(m(xi + 1), m(yi + 1), seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Tileable fbm; `period` is in lattice cells at the base octave. */
export function tfbm(x, y, period, seed, octaves = 4) {
  let sum = 0, amp = 0.5, f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += tnoise(x * f, y * f, period * f, seed + i * 17) * amp;
    f *= 2;
    amp *= 0.5;
  }
  return sum;
}

/* ------------------------------------------------------------------ */
/* UV + geometry helpers                                               */
/* ------------------------------------------------------------------ */

/**
 * Rescale a single-segment BoxGeometry's UVs so texel density is constant in
 * world space regardless of the box dimensions. Face order in BoxGeometry is
 * px, nx, py, ny, pz, nz - four vertices each.
 */
const _BOX_SU = [0, 0, 0, 0, 0, 0];
const _BOX_SV = [0, 0, 0, 0, 0, 0];
export function boxUV(geo, w, h, d, tile, r = 0) {
  const uv = geo.attributes.uv;
  /* 24 is a plain box (4 vertices a face), 96 a chamfered one (16). Both lay
   * their vertices out face by face in the same order, so the only thing that
   * changes is the stride. Anything else is not a box and is returned
   * untouched, which is what the old `!== 24` guard was for. */
  if (!uv || (uv.count !== 24 && uv.count !== 96)) return geo;
  const per = uv.count / 6;
  /* The chamfer's own share of the UV span, in metres of face.
   *
   * `chamferBox` inherits three's RoundedBoxGeometry parameterisation, which
   * divides each face's 0..1 into a flat centre of `s - 2r` and two chamfer
   * bands that together take `pi*r/2` - the arc length of ONE quarter round,
   * not two. So the span a face's UV actually covers is `s - 2r + pi*r/2`,
   * and scaling by plain `s` would run the texture 5% dense on a 55 cm box
   * against the unbevelled box next to it. Zero for a plain box, where the
   * span is exactly `s`. */
  const pad = r * (Math.PI / 2 - 2);
  _BOX_SU[0] = _BOX_SU[1] = d + pad; _BOX_SU[2] = _BOX_SU[3] = w + pad; _BOX_SU[4] = _BOX_SU[5] = w + pad;
  _BOX_SV[0] = _BOX_SV[1] = h + pad; _BOX_SV[2] = _BOX_SV[3] = d + pad; _BOX_SV[4] = _BOX_SV[5] = h + pad;
  for (let f = 0; f < 6; f++) {
    const su = _BOX_SU[f] / tile;
    const sv = _BOX_SV[f] / tile;
    for (let i = 0; i < per; i++) {
      const k = f * per + i;
      uv.setXY(k, uv.getX(k) * su, uv.getY(k) * sv);
    }
  }
  uv.needsUpdate = true;
  return geo;
}

export function uvScale(geo, su, sv) {
  const uv = geo.attributes.uv;
  if (!uv) return geo;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  uv.needsUpdate = true;
  return geo;
}

/**
 * Constant-texel-density UVs for a CylinderGeometry.
 *
 * `uvScale(cyl, 20, 3)` is a trap: the side wants circumference/height, the
 * caps want diameter on *both* axes, and applying one pair to all of them
 * stretches the cap into 1 x 7 m rectangles.
 *
 * CylinderGeometry emits the side first ((radial+1) * (height+1) vertices),
 * then the top cap, then the bottom cap, so the split is a simple index test.
 */
export function cylUV(geo, rTop, rBottom, height, radialSegs, tile, heightSegs = 1) {
  const uv = geo.attributes.uv;
  if (!uv) return geo;
  const rAvg = (rTop + rBottom) * 0.5;
  const sideCount = (radialSegs + 1) * (heightSegs + 1);
  const su = (Math.PI * 2 * rAvg) / tile;
  const sv = height / tile;
  const sc = (2 * rAvg) / tile;
  for (let i = 0; i < uv.count; i++) {
    if (i < sideCount) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
    // Caps are scaled about their own centre so the plate grid stays concentric.
    else uv.setXY(i, (uv.getX(i) - 0.5) * sc + 0.5, (uv.getY(i) - 0.5) * sc + 0.5);
  }
  uv.needsUpdate = true;
  return geo;
}

/** CylinderGeometry with world-correct texel density in one call. */
export function cylGeo(rTop, rBottom, height, radialSegs, tile, openEnded = false) {
  const g = new THREE.CylinderGeometry(rTop, rBottom, height, radialSegs, 1, openEnded);
  return cylUV(g, rTop, rBottom, height, radialSegs, tile ?? 2);
}

/** Remap a quad's UVs onto one cell of a cols x rows atlas. */
export function atlasUV(geo, col, row, cols, rows) {
  const uv = geo.attributes.uv;
  const iu = 1 / cols, iv = 1 / rows;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, col * iu + uv.getX(i) * iu, 1 - (row + 1) * iv + uv.getY(i) * iv);
  }
  uv.needsUpdate = true;
  return geo;
}

/** Remap a quad onto one cell of the signage atlas. */
export function signUV(geo, cell) {
  const n = SIGN_COLS * SIGN_ROWS;
  const c = ((cell % n) + n) % n;
  return atlasUV(geo, c % SIGN_COLS, Math.floor(c / SIGN_COLS), SIGN_COLS, SIGN_ROWS);
}

/* ------------------------------------------------------------------ */
/* The chamfer                                                         */
/* ------------------------------------------------------------------ */

/**
 * THE EDGE ROUND, AND WHY MOST BOXES DO NOT GET ONE.
 *
 * A hard 90-degree edge returns exactly one shade to the camera, so a prop
 * built from plain boxes has no edges in it at all - just flat panels meeting
 * at invisible seams, which is what reads as "CG" long before polygon count
 * does. A few centimetres of chamfer gives every edge a highlight on the lit
 * side and a dark line away from it, and the silhouette stops being a cut-out.
 *
 * `CitadelWorld`'s `Batch.box` has done this since the citadel shipped and the
 * numbers here are the same shape as its: a chamfered box is 108 triangles
 * against a plain one's 12. What is different is the scale it is applied at.
 * The citadel emits ~12,000 boxes; this kit is the funnel for the station
 * (30,041 `boxGeo` calls in a headless build, median smallest-dimension 16 cm),
 * the dock (10,274) and every ship interior, and the station is already the
 * heaviest world in the game at 3.47M triangles of world geometry. So the
 * threshold is not a taste decision here, it is a budget one, and it was
 * measured on a built world rather than copied - see `BEVEL_MIN`.
 *
 * `BEVEL` is the radius itself. 6 cm rather than the citadel's 7.5: station
 * props are smaller than desert architecture, and the round has to read as an
 * eased edge rather than as a soft corner.
 */
const BEVEL = 0.06;

/**
 * Smallest dimension a box must have before it is worth chamfering, in metres.
 *
 * MEASURED END TO END, on a headless `buildStationFresh()`, because the
 * obvious way to pick this number is wrong. Counting `boxGeo` calls that pass
 * a threshold and multiplying by 96 says 0.55 m costs the station +452k
 * triangles. It costs +675k. The difference is `instanced()`: a chamfered
 * prototype is authored once and drawn 1,875 times, so a threshold that catches
 * one scatter prototype charges for the whole scatter. Everything below is the
 * built world, walked mesh by mesh.
 *
 *                    world tris        collision kept      chunks    soup
 *   square           3,468,968              202,307         8,763   6.9 MB
 *   >= 0.55 m   +675,456  (+19.5%)  +86,172  (+42.6%)      12,411   9.9 MB
 *   >= 0.80 m   +448,224  (+12.9%)  +61,345  (+30.3%)      11,359   9.1 MB
 *   >= 1.00 m   +330,624   (+9.5%)  +54,773  (+27.1%)      11,203   8.8 MB
 *   >= 1.20 m   +262,944   (+7.6%)  +44,943  (+22.2%)      10,804   8.5 MB
 *   >= 1.60 m   +146,112   (+4.2%)  +26,788  (+13.2%)       9,819   7.9 MB
 *
 * THE THREE RIGHT-HAND COLUMNS ARE NO LONGER PAID, AT ANY THRESHOLD. They were
 * for one day, and they are left here because they are what the number was
 * chosen against and because they are the measurement that motivated the fix.
 * `_solidifyStructure` derives the station's collision from the DRAWN geometry,
 * so a chamfer was charged twice - to the soup, to the enclosure drop that
 * filters it, to the chunk count and to every raycast against them. It is now
 * charged once: a chamfer only ever cuts material AWAY from a box's corners, so
 * `_collisionSoup` substitutes the square box the piece was cut from for its
 * 108 triangles, and the whole row reads `202,307 / 8,763 / 6.9 MB` again with
 * the chamfer still drawn. See `squareBoxCorners` below.
 *
 * So the choice now stands on the left-hand column alone. There is no knee in
 * that curve - it is close to linear in pieces chamfered - so this is a budget
 * call and not an optimum. The station is already the heaviest world in the
 * game (framings measure 2.12M-3.41M drawn), and 1.0 m holds the geometry under
 * +10% while still chamfering 3,469 pieces. A metre in EVERY axis is also a
 * readable line: it is a mass a body could stand on - crate, kiosk body,
 * planter, pillar base, machine housing - rather than trim, sills, rails and
 * treads, which sit a hand's width from a surface that already carries the
 * highlight and would have been 1,225 more pieces at 0.8.
 *
 * 0.55 - the number `CitadelWorld` uses - is still refused, but on +19.5% of
 * the heaviest world in the game rather than on the collision column that used
 * to be the decisive argument. If that budget is ever re-opened with a GPU
 * measurement in hand, this is a one-line dial and nothing downstream of it
 * moves except drawn triangles.
 *
 * The frame-time consequence of +9.5% is NOT measured here; there is no
 * headless GPU. What is measured is the geometry, the collision and the build.
 * The build gained +2.0 s when the chamfer landed, of which the collision pass
 * was +199 ms; taking the chamfer back out of the soup returns 191 ms of that
 * (965 -> 774 ms median over ten interleaved headless builds) and the rest is
 * the cost of building 9x the vertices, which is the chamfer itself.
 *
 * -- WHAT THIS MOVES ON THE EDITOR SIDE ------------------------------------
 * Nothing, now. It moved `station-move-colliders`' table for 207 names while
 * the chamfer was in the soup, and three of them crossed `_moveColliders`' cap
 * of 200 into refuse-with-span - `plaza-props:glassWindow` 200,
 * `commercial:emAmber` 195, `commercial:panel` 184. All 207 came back with the
 * collision, and that fixture is byte-for-byte its pre-chamfer self. Worth
 * knowing anyway: raising THIS threshold never rescued those three (measured at
 * 1.6 m, which halves the churn to 104 names and loses half the chamfer, all
 * three still crossed), so the cap is what they sit against and they sit at
 * 92-100% of it on a world nobody chamfered.
 *
 * The catalogue anchors DO still move, by 2 to 26 mm across 33 names with none
 * minted or retired, because an anchor is the centre of a batch's BOUNDS and
 * that is a fact about what is drawn: a chamfer trims the corner off a box,
 * which is the extreme point of a box the batch placed at an angle. No
 * axis-aligned box changes its bounds at all - the flat centre of every face
 * still reaches `w/2`, which is also what makes `squareBoxCorners` able to read
 * the square box straight off the bounds.
 *
 * So the fixtures this obliges a re-take of are the two that measure drawn
 * bounds - `station-catalogue.json` and `dock-catalogue.json` (one name,
 * `yard:tarp`) - and not `station-move-colliders.json` or the collision line
 * pinned inline in `station-catalogue.test.mjs`.
 *
 * The rule is on the SMALLEST dimension on purpose, and that is why the tiling
 * problem mostly takes care of itself in this kit: a floor slab, a wall panel
 * and a hull plate are all thin in one axis, so none of them is ever a
 * candidate and none of them grows a groove where it meets its neighbour.
 * `bevel: false` is for pieces that are chunky AND laid end to end.
 * `InteriorKit`, whose walls are 50 cm of stone, does not get that for free -
 * see the note on its `vbox`.
 */
const BEVEL_MIN = 1.0;

/**
 * The chamfer radius for a box, or 0 when it should stay square.
 *
 * Clamped against the smallest dimension whatever the threshold said, because
 * a round wider than the piece it is rounding turns the piece inside out.
 * Under 2 cm there is nothing there to catch a highlight and the 9x is waste.
 */
function bevelRadius(w, h, d, min) {
  if (Math.min(w, h, d) < min) return 0;
  const r = Math.min(BEVEL, w * 0.22, h * 0.22, d * 0.22);
  return r > 0.02 ? r : 0;
}

/* Scratch for the chamfer loop; one box is built per call and never escapes. */
const _cbP = new THREE.Vector3();
const _cbN = new THREE.Vector3();
const _cbF = new THREE.Vector3();
const _cbT = new THREE.Vector3();

/**
 * `getUv` from three's RoundedBoxGeometry, unchanged.
 *
 * Copied rather than imported because the addon exposes only the finished
 * geometry, and the finished geometry is the one thing this kit cannot use -
 * see `chamferBox`.
 */
function chamferUV(faceDir, normal, uvAxis, projectionAxis, radius, sideLength) {
  const totArcLength = 2 * Math.PI * radius / 4;
  const centerLength = Math.max(sideLength - 2 * radius, 0);
  const halfArc = Math.PI / 4;
  _cbT.copy(normal);
  _cbT[projectionAxis] = 0;
  _cbT.normalize();
  const arcUvRatio = 0.5 * totArcLength / (totArcLength + centerLength);
  const arcAngleRatio = 1.0 - (_cbT.angleTo(faceDir) / halfArc);
  if (Math.sign(_cbT[uvAxis]) === 1) return arcAngleRatio * arcUvRatio;
  const lenUv = centerLength / (totArcLength + centerLength);
  return lenUv + arcUvRatio + arcUvRatio * (1.0 - arcAngleRatio);
}

/**
 * A chamfered box, INDEXED - three's `RoundedBoxGeometry` maths on a geometry
 * this kit can actually merge.
 *
 * -- Why not just call `new RoundedBoxGeometry(w, h, d, 1, r)` --------------
 * Two reasons, both fatal, both measured.
 *
 * It is NOT INDEXED. `RoundedBoxGeometry` builds an indexed 3x3x3 box, calls
 * `toNonIndexed()` and throws the index away. `mergeGeometries` returns null
 * the moment two of its inputs disagree about whether they have one, so one
 * rounded box in a bucket of plain ones silently drops the whole bucket - and
 * `InteriorKit.finish` merges with no normalisation at all. Where `GeoBatch`
 * does normalise, it does it by handing the geometry a trivial 0..n-1 index,
 * which keeps all 324 duplicated vertices: 11 KB a box against a plain box's
 * 840 bytes, or 52 MB across the station's candidates.
 *
 * Welding it back with `mergeVertices` reaches 92 vertices and costs 0.43 ms
 * PER BOX - 2 seconds of build time across the station, on a project that has
 * spent two rounds deleting exactly that kind of hitch.
 *
 * Building it indexed in the first place costs neither. The rounding is a pure
 * function of a vertex's position on the unit box, so the 96 vertices of an
 * INDEXED `BoxGeometry(1, 1, 1, 3, 3, 3)` transform into exactly the same 108
 * triangles the addon emits from 324 - verified vertex for vertex against
 * `new RoundedBoxGeometry(...)` rather than assumed.
 *
 * 3 segments is the fewest that leaves a flat panel between the rounds. With
 * one segment of round per edge the "arc" is a single flat facet, which is a
 * chamfer, which is what was wanted.
 */
function chamferBox(w, h, d, radius) {
  const geo = new THREE.BoxGeometry(1, 1, 1, 3, 3, 3);
  const r = Math.min(w / 2, h / 2, d / 2, radius);
  const pos = geo.attributes.position.array;
  const nrm = geo.attributes.normal.array;
  const uv = geo.attributes.uv.array;
  const perFace = pos.length / 6;
  const bx = w / 2 - r, by = h / 2 - r, bz = d / 2 - r;
  const halfSeg = 0.5 / 3;
  for (let i = 0, j = 0; i < pos.length; i += 3, j += 2) {
    _cbP.fromArray(pos, i);
    _cbN.copy(_cbP);
    _cbN.x -= Math.sign(_cbN.x) * halfSeg;
    _cbN.y -= Math.sign(_cbN.y) * halfSeg;
    _cbN.z -= Math.sign(_cbN.z) * halfSeg;
    _cbN.normalize();
    pos[i] = bx * Math.sign(_cbP.x) + _cbN.x * r;
    pos[i + 1] = by * Math.sign(_cbP.y) + _cbN.y * r;
    pos[i + 2] = bz * Math.sign(_cbP.z) + _cbN.z * r;
    nrm[i] = _cbN.x; nrm[i + 1] = _cbN.y; nrm[i + 2] = _cbN.z;
    switch (Math.floor(i / perFace)) {
      case 0: // +x
        _cbF.set(1, 0, 0);
        uv[j] = chamferUV(_cbF, _cbN, 'z', 'y', r, d);
        uv[j + 1] = 1 - chamferUV(_cbF, _cbN, 'y', 'z', r, h);
        break;
      case 1: // -x
        _cbF.set(-1, 0, 0);
        uv[j] = 1 - chamferUV(_cbF, _cbN, 'z', 'y', r, d);
        uv[j + 1] = 1 - chamferUV(_cbF, _cbN, 'y', 'z', r, h);
        break;
      case 2: // +y
        _cbF.set(0, 1, 0);
        uv[j] = 1 - chamferUV(_cbF, _cbN, 'x', 'z', r, w);
        uv[j + 1] = chamferUV(_cbF, _cbN, 'z', 'x', r, d);
        break;
      case 3: // -y
        _cbF.set(0, -1, 0);
        uv[j] = 1 - chamferUV(_cbF, _cbN, 'x', 'z', r, w);
        uv[j + 1] = 1 - chamferUV(_cbF, _cbN, 'z', 'x', r, d);
        break;
      case 4: // +z
        _cbF.set(0, 0, 1);
        uv[j] = 1 - chamferUV(_cbF, _cbN, 'x', 'y', r, w);
        uv[j + 1] = 1 - chamferUV(_cbF, _cbN, 'y', 'x', r, h);
        break;
      default: // -z
        _cbF.set(0, 0, -1);
        uv[j] = chamferUV(_cbF, _cbN, 'x', 'y', r, w);
        uv[j + 1] = 1 - chamferUV(_cbF, _cbN, 'y', 'x', r, h);
        break;
    }
  }
  geo.attributes.position.needsUpdate = true;
  geo.attributes.normal.needsUpdate = true;
  geo.attributes.uv.needsUpdate = true;
  /* THE BOX THIS WAS CUT FROM, KEPT FOR THE COLLISION PATH.
   *
   * A chamfer only ever REMOVES material from a box's corners, so the square
   * box it started as is a conservative collider for it - very slightly larger
   * than the mesh, which is the safe direction and is exactly what the player
   * already walked into before the kit learned to chamfer. `ShipKit` gets this
   * for free because it authors its colliders (`cbox` draws through `box` and
   * collides the FULL box); `StationWorld._solidifyStructure` does not, it
   * derives collision FROM THE DRAWN GEOMETRY, so it has to be told. See
   * `squareBoxCorners` and `GeoBatch.add`. */
  geo.userData.squareBox = { w, h, d };
  return geo;
}

/* Two triangles a face, over the eight corners `squareBoxCorners` emits. Bit 0
 * of a corner index is +x, bit 1 is +y, bit 2 is +z.
 *
 * READ OFF `new THREE.BoxGeometry(2, 2, 2)` rather than authored, and that is
 * the whole point of the table: this is what the collision pass would have
 * extracted from the plain box before the kit learned to chamfer, so the
 * substitution has to agree with three's SPLIT and not merely with its corners.
 * It does not, quite, if you pick the diagonals yourself - a quad cut the other
 * way has the same four corners but two different triples, and
 * `_dropEnclosedTriangles` asks about triples. Measured with a hand-authored
 * table: 3 triangles of 202,307 changed sides. Three triangles is nothing to a
 * player and everything to a pin, which has to be able to say "unchanged".
 */
export const SQUARE_BOX_TRIS = [
  7, 5, 3, 5, 1, 3,  // +x
  2, 0, 6, 0, 4, 6,  // -x
  2, 6, 3, 6, 7, 3,  // +y
  4, 0, 5, 0, 1, 5,  // -y
  6, 4, 7, 4, 5, 7,  // +z
  3, 1, 2, 1, 0, 2,  // -z
];

/**
 * The eight corners of the plain box a chamfered geometry was cut from, in the
 * geometry's own frame - or null when this is not one, or is no longer one.
 *
 * Read off the BOUNDS rather than off the recorded `w/h/d` at the origin,
 * because 48 call sites in this kit chain `.translate()` onto a `boxGeo` before
 * handing it over and the bounds move with the box where a remembered centre
 * would not. The bounds ARE the plain box while the piece is still axis-
 * aligned: `chamferBox` leaves the flat centre of every face at exactly w/2,
 * so a chamfered box measures w x h x d to the float.
 *
 * That identity is also the check. A geometry that has been rotated or scaled
 * since it was chamfered measures something else, and is refused rather than
 * given a box that would be an axis-aligned crate around a yawed piece - a
 * collider LARGER than the mesh in the one direction that is not safe. Nothing
 * in the kit rotates a `boxGeo` today (the batch does that with its own
 * matrix); the check is what makes that a fact rather than an assumption.
 */
export function squareBoxCorners(geo) {
  const box = geo.userData?.squareBox;
  if (!box) return null;
  geo.computeBoundingBox();
  const b = geo.boundingBox;
  if (
    Math.abs(b.max.x - b.min.x - box.w) > 1e-4 ||
    Math.abs(b.max.y - b.min.y - box.h) > 1e-4 ||
    Math.abs(b.max.z - b.min.z - box.d) > 1e-4
  ) return null;
  const out = new Float32Array(24);
  for (let i = 0; i < 8; i++) {
    out[i * 3] = (i & 1) ? b.max.x : b.min.x;
    out[i * 3 + 1] = (i & 2) ? b.max.y : b.min.y;
    out[i * 3 + 2] = (i & 4) ? b.max.z : b.min.z;
  }
  return out;
}

/**
 * A box, chamfered when it is big enough, with three's plain 0..1 face UVs.
 *
 * `boxGeo`'s world-scaled UVs are right for a kit whose materials tile across
 * whatever they are painted on. `InteriorKit` is the other case: it either
 * draws with an unmapped flat palette, or reprojects every UV it has after the
 * merge (`_prepGeoForWorldMat`), so `boxUV` there is work thrown away twice
 * over. Same chamfer, same 108 triangles, same index.
 */
export function bevelBox(w, h, d, min = BEVEL_MIN) {
  const r = bevelRadius(w, h, d, min);
  return r > 0 ? chamferBox(w, h, d, r) : new THREE.BoxGeometry(w, h, d);
}

/**
 * A textured box, UV-corrected, ready to be pushed into a batch.
 *
 * Chamfered when it is big enough to be worth it - see `BEVEL_MIN`.
 *
 * @param {number|boolean} [bevel] `true` for the kit default, `false` to
 *   decline the chamfer, or a threshold in metres for a kit read from a
 *   different distance (`ShipKit.ibox` passes one: a ship's interior fittings
 *   are looked at from 1 m and its hull plating from 30).
 *
 *   DECLINE IT FOR ANYTHING THAT TILES. Two chamfered boxes butted together
 *   leave a groove the width of both rounds at the joint, and a run of them
 *   turns a continuous surface into a ladder of dark lines. The smallest-
 *   dimension rule already excludes every slab, panel and plate in the kit
 *   because those are thin in one axis; `false` is for pieces that are chunky
 *   AND laid end to end.
 */
export function boxGeo(w, h, d, tile, bevel = true) {
  if (bevel === false) return boxUV(new THREE.BoxGeometry(w, h, d), w, h, d, tile ?? 2);
  const r = bevelRadius(w, h, d, bevel === true ? BEVEL_MIN : bevel);
  return r > 0
    ? boxUV(chamferBox(w, h, d, r), w, h, d, tile ?? 2, r)
    : boxUV(new THREE.BoxGeometry(w, h, d), w, h, d, tile ?? 2);
}

/* ------------------------------------------------------------------ */
/* Coplanar floor surfaces                                             */
/* ------------------------------------------------------------------ */

/**
 * Two answers to "two floor quads share a plane", and when each one applies.
 *
 * ── The problem, measured ─────────────────────────────────────────────────
 * Almost every paved surface in this world is laid as a band of tangential
 * quads that deliberately overlap their neighbours, because a chord quad on a
 * curve leaves a wedge of bare deck at each joint otherwise: `Habitation`'s
 * `band()` oversizes by 3% and a sagitta, `Canteen`'s dining rings by 40 cm,
 * `Construction`'s haul loop by 90 cm. Each of those overlaps is a strip the
 * depth buffer cannot order, and a raycast sweep of the render geometry found
 * 70 of them on a 12 m grid - a stripe of shimmer at every joint of every ring.
 *
 * ── Why not polygon offset here ───────────────────────────────────────────
 * `StationWorld` already reaches for `polygonOffset` when two DIFFERENT
 * materials share a plane (`M.plazaOnDeck`, `M.decal`, `M.route`), and the note
 * on `M.plazaOnDeck` is right that it beats a lift: it is expressed in
 * depth-buffer units, so it still holds at 150 m where a 30 mm gap is only
 * twice the depth resolution. But it cannot separate a material from ITSELF -
 * both quads take the same bias - and every case here is one surface overlapping
 * another copy of itself. `M.plazaOnDeck` z-fighting `M.plazaOnDeck` is in the
 * measurement, offset and all.
 *
 * So the fix has to be in the geometry, and there are exactly two shapes of it.
 */

/**
 * Lift for one segment of a ring of overlapping quads.
 *
 * A ring's segments only ever overlap their immediate neighbours, so two
 * levels are enough - except at the wrap joint, where an odd segment count puts
 * two even indices side by side. That case gets a third level rather than a
 * seam that is still coplanar exactly once per ring, which is precisely the
 * kind of "fixed everywhere but one place" that is worse than not fixing it.
 *
 * @param {number} i      segment index, 0-based
 * @param {number} n      segments in the ring
 * @param {number} step   metres between adjacent levels
 * @param {boolean} closed  does segment n-1 touch segment 0?
 * @returns {number} metres to add to the band's base height
 */
export function seamLift(i, n, step = 0.004, closed = true) {
  if (n <= 1) return 0;
  if (closed && n % 2 === 1 && i === n - 1) return 2 * step;
  return (i % 2) * step;
}

/**
 * Levels for a scatter of overlapping floor patches, by greedy colouring.
 *
 * A ring is a chain and two colours do it. A yard is not: `Construction`'s
 * compacted-stone aprons are ~75 rectangles of wildly different size, thrown
 * round towers, plots and bays, and which of them overlap is not something the
 * emitting loops know. Cycling a counter would leave whichever pairs happened
 * to land the same distance apart in emission order still coplanar.
 *
 * So each patch is given the lowest level that no patch it OVERLAPS is already
 * using. Overlap is tested on the circumscribed axis-aligned box, which is
 * conservative - it can spend a level on a pair that does not really touch,
 * never the other way round - and with a handful of levels that costs nothing.
 * If every level is taken (more than `levels` mutually overlapping patches) it
 * returns to level 0 rather than growing the ladder into the surfaces above.
 */
export class CoplanarLevels {
  /** @param {number} levels  how many distinct heights are available */
  constructor(levels = 5) {
    this.levels = Math.max(1, levels | 0);
    /** @type {Array<{x0:number,z0:number,x1:number,z1:number,l:number}>} */
    this.placed = [];
  }

  /**
   * @param {number} cx  patch centre X
   * @param {number} cz  patch centre Z
   * @param {number} hx  half-extent X of the circumscribed box
   * @param {number} hz  half-extent Z
   * @returns {number} level index, 0 .. levels-1
   */
  claim(cx, cz, hx, hz) {
    const x0 = cx - hx, x1 = cx + hx, z0 = cz - hz, z1 = cz + hz;
    const taken = new Set();
    for (const p of this.placed) {
      if (p.x1 <= x0 || p.x0 >= x1 || p.z1 <= z0 || p.z0 >= z1) continue;
      taken.add(p.l);
      if (taken.size >= this.levels) break;
    }
    let l = 0;
    while (l < this.levels && taken.has(l)) l++;
    if (l >= this.levels) l = 0;
    this.placed.push({ x0, z0, x1, z1, l });
    return l;
  }
}

/** Build an InstancedMesh from [x,y,z,rx,ry,rz,sx,sy,sz] tuples. */
export function instanced(geo, mat, entries, opts = {}) {
  // A zero-count InstancedMesh is legal but pointless and breaks setColorAt.
  if (!entries.length) return new THREE.Object3D();
  const im = new THREE.InstancedMesh(geo, mat, entries.length);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    _dummy.position.set(e[0], e[1], e[2]);
    _dummy.rotation.set(e[3] || 0, e[4] || 0, e[5] || 0);
    _dummy.scale.set(e[6] ?? 1, e[7] ?? 1, e[8] ?? 1);
    _dummy.updateMatrix();
    im.setMatrixAt(i, _dummy.matrix);
  }
  im.instanceMatrix.needsUpdate = true;
  im.castShadow = opts.cast ?? true;
  im.receiveShadow = opts.recv ?? true;
  /* Cull against the instances, not against the prototype.
   *
   * This used to be `frustumCulled = false`, and the reason given was that
   * instances span the whole map so culling could only ever fail. That was true
   * of a 400 m ring where every scatter covered the whole deck. It is very
   * badly untrue of a 1,440 m map with four zones half a kilometre apart: every
   * chair in the galley was submitted while the player stood in the gym.
   *
   * `InstancedMesh` carries its own `boundingSphere`, computed from the
   * instance matrices, and `Frustum.intersectsObject` prefers it over the
   * geometry's. So a zone-local scatter now gets a zone-sized sphere and is
   * rejected from every other deck, while a genuinely map-wide scatter gets a
   * map-sized sphere and behaves exactly as it did.
   *
   * Computed here, after the matrices are written. Meshes whose instances are
   * animated afterwards - the plaza crowd, the escalator treads - move by
   * centimetres within a sphere sized in tens of metres, so the sphere stays
   * valid without being recomputed. Anything that moves an instance further
   * than that must pass `cull: false`.
   */
  im.computeBoundingSphere();
  im.frustumCulled = opts.cull ?? true;
  /* The same call site a merged piece gets, for the same reason: an
   * instanced prop is addressable by mesh and index and has always been,
   * but neither of those names the LINE that scattered it. Eight of the
   * ten props left standing inside structure are instanced, and none of
   * them could be sourced until this existed. Off by default with the
   * merged half - one boolean test per instanced mesh, of which the
   * station builds a few hundred rather than 37,923. */
  if (TRACE_CALL_SITES) im.userData.site = callSite();
  return im;
}

/**
 * Collects geometry per material during generation and merges each bucket into
 * a single mesh. A district of forty buildings collapses to ~6 draw calls.
 */
/**
 * WHERE A PIECE WAS AUTHORED - off by default, and off in the game always.
 *
 * The spans give a piece an address and a build step. Neither is a CALL SITE,
 * and the difference cost a wrong edit: a barrier in a planter was matched to
 * the `barrier()` helper by shape and material - exactly the right geometry at
 * exactly the right height, only two call sites - and the change moved a
 * different prop entirely, because those two sites stand near the spawn at
 * (-34, 2) and the defect was in the plaza. Matching a piece to its author by
 * shape is a guess that looks like a deduction.
 *
 * ── Why opt-in, and not simply always on ──────────────────────────────────
 *
 * Capturing a stack costs an Error construction per authored piece, and the
 * station authors 37,923 of them. That is a price a debugging session should
 * pay and a player never should, so the game leaves it off and pays one
 * boolean test per `add`. Measured with it ON, the build cost is in the
 * commit message; measured OFF it is unchanged, because the branch is not
 * taken.
 *
 * Frames from StationKit itself are skipped - `at` and `localAt` funnel into
 * `add`, so the top frames are always this file and always useless. Up to
 * three are kept because the wrapper layers are real: a zone bench is
 * `Gym.js` -> `ZoneContext.put` -> `localAt`, and only the first of those
 * three names the bench.
 */
let TRACE_CALL_SITES = false;

/** Turn call-site capture on before building a world. Dev and tests only. */
export function setTraceCallSites(on) { TRACE_CALL_SITES = !!on; }

const SITE_RE = /\(?([^()\s]+\.js):(\d+):\d+\)?$/;

function callSite() {
  const stack = new Error().stack;
  if (!stack) return null;
  const out = [];
  for (const raw of stack.split('\n').slice(2)) {
    const m = SITE_RE.exec(raw.trim());
    if (!m) continue;
    const file = m[1].replace(/^.*[\\/]/, '');
    if (file === 'StationKit.js') continue;
    out.push(`${file}:${m[2]}`);
    if (out.length === 3) break;
  }
  return out.length ? out.join(' <- ') : null;
}

/**
 * Pack `GeoBatch` part records into the parallel-typed-array form described
 * on `flush`. Kept out of the class so the shape has one definition and the
 * readers can be pointed at it.
 */
function packParts(recs) {
  const n = recs.length;
  const owners = [null], pieces = [null], sites = [null];
  const ownerIx = new Map([[null, 0]]), pieceIx = new Map([[null, 0]]);
  const siteIx = new Map([[null, 0]]);
  const ownerOf = new Uint16Array(n), pieceOf = new Uint16Array(n), siteOf = new Uint16Array(n);
  const start = new Uint32Array(n), count = new Uint32Array(n);
  /* The square-collider side table. Only the chamfered parts carry one - 2,724
   * of the station's ~30,000 - so it is a sparse index rather than a flag: -1
   * for "collide my triangles", otherwise the row of `squares` holding my
   * plain box's eight corners. See `squareBoxCorners`. */
  let nsq = 0;
  for (let i = 0; i < n; i++) if (recs[i].square) nsq++;
  const squares = nsq ? new Float32Array(nsq * 24) : null;
  const squareAt = nsq ? new Int32Array(n).fill(-1) : null;
  let sq = 0;
  let at = 0;
  for (let i = 0; i < n; i++) {
    const r = recs[i];
    if (r.square) { squares.set(r.square, sq * 24); squareAt[i] = sq++; }
    let oi = ownerIx.get(r.owner);
    if (oi === undefined) { oi = owners.push(r.owner) - 1; ownerIx.set(r.owner, oi); }
    let pi = pieceIx.get(r.piece);
    if (pi === undefined) { pi = pieces.push(r.piece) - 1; pieceIx.set(r.piece, pi); }
    let si = siteIx.get(r.site ?? null);
    if (si === undefined) { si = sites.push(r.site) - 1; siteIx.set(r.site, si); }
    ownerOf[i] = oi;
    pieceOf[i] = pi;
    siteOf[i] = si;
    start[i] = at;
    count[i] = r.n;
    at += r.n;
  }
  return { owners, pieces, sites, ownerOf, pieceOf, siteOf, start, count, squares, squareAt, indices: at };
}

export class GeoBatch {
  /**
   * @param {{_planOwner?: string|null}|null} owner the world, read for
   *   `_planOwner` at `add` time. Optional: a batch built without one still
   *   records spans, with `owner: null` on every part.
   */
  constructor(owner = null) {
    /** @type {Map<string, THREE.BufferGeometry[]>} */
    this.buckets = new Map();
    /**
     * Per-bucket part records, index-parallel to `buckets`. One entry per
     * `add` call - which is one authored piece, because `at` and `localAt`
     * both funnel through it and nothing else in the repository calls it.
     * @type {Map<string, {owner: string|null, piece: string|null, n: number}[]>}
     */
    this.parts = new Map();
    this._owner = owner;
    /** Set by a builder around a loop to name a piece finer than the step. */
    this._piece = null;
  }

  /** @param {string} key material key @param {THREE.BufferGeometry} geo owned by the batch */
  add(key, geo, matrix) {
    /* ── THE SQUARE-COLLIDER HALF ───────────────────────────────────────
     * Read BEFORE the matrix goes on, because the check that makes it safe
     * is that the piece is still axis-aligned in its own frame, and the
     * batch's matrix is exactly what stops being true of.
     *
     * `StationWorld._solidifyStructure` derives the station's collision from
     * the DRAWN geometry, so a chamfer - which exists only to catch a
     * highlight on an edge - was being charged twice, once as triangles and
     * again as collision: 372,792 -> 551,953 triangles extracted and 26,757
     * -> 29,197 colliders for a 9.5% rise in what is drawn. A chamfer only
     * ever cuts material AWAY from a box's corners, so the square box is a
     * conservative collider for it and is what the player already walked
     * into. Recorded here, in the batch's frame, and substituted for the
     * part's 108 triangles by `_collisionSoup`. */
    const square = squareBoxCorners(geo);
    if (square && matrix) {
      for (let i = 0; i < 24; i += 3) {
        _v1.set(square[i], square[i + 1], square[i + 2]).applyMatrix4(matrix);
        square[i] = _v1.x; square[i + 1] = _v1.y; square[i + 2] = _v1.z;
      }
    }
    if (matrix) geo.applyMatrix4(matrix);
    // mergeGeometries refuses to mix indexed and non-indexed sources, and the
    // polyhedra (Octahedron/Icosahedron) arrive unindexed. Normalise here so
    // callers never have to think about it.
    if (!geo.getIndex()) {
      const n = geo.getAttribute('position').count;
      const idx = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
      for (let i = 0; i < n; i++) idx[i] = i;
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
    }
    let list = this.buckets.get(key);
    if (!list) this.buckets.set(key, (list = []));
    list.push(geo);
    /* ── THE IDENTITY HALF ──────────────────────────────────────────────
     * Recorded here rather than in `flush` because this is the only moment
     * the piece exists as itself: `flush` merges the bucket and disposes
     * every source, and after that there is nothing left to ask. That loss
     * is what defeated three separate placement instruments in one day -
     * see StationAudit's `blindSpots` note and the spec's "root cause of
     * the root causes".
     *
     * Cost is one small object per authored piece plus one read of an
     * ambient field. It is the same mechanism `_solid`/`_solidRot` already
     * use to give a COLLIDER its owner, applied to what is DRAWN. */
    let plist = this.parts.get(key);
    if (!plist) this.parts.set(key, (plist = []));
    plist.push({
      owner: this._owner?._planOwner ?? null,
      piece: this._piece,
      site: TRACE_CALL_SITES ? callSite() : null,
      n: geo.getIndex().count,
      square,
    });
    return geo;
  }

  /**
   * Place a part described in a building's local frame. Buildings are authored
   * around their own origin and then dropped onto the map, so every builder
   * works in local millimetre-free coordinates.
   */
  localAt(key, geo, ox, oy, oz, yaw, lx, ly, lz, ry2 = 0, rx = 0, rz = 0) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return this.at(key, geo, ox + lx * c + lz * s, oy + ly, oz - lx * s + lz * c, yaw + ry2, rx, rz);
  }

  /** Place a geometry with position + Y rotation, the common building case. */
  at(key, geo, x, y, z, ry = 0, rx = 0, rz = 0) {
    _euler.set(rx, ry, rz, 'YXZ');
    _quat.setFromEuler(_euler);
    _mat4.compose(_v1.set(x, y, z), _quat, _scl.set(1, 1, 1));
    return this.add(key, geo, _mat4);
  }

  /**
   * Merge every bucket, add the meshes to `parent`, and reset.
   *
   * Each mesh carries `userData.parts`: the index range every authored piece
   * occupies in the merged buffer, so a caller can still address "that
   * barrier" after the merge has taken its name away. Storage is parallel
   * typed arrays plus two string tables, because the station raises tens of
   * thousands of pieces and an object apiece is megabytes of nothing.
   *
   *   parts.start[i] / parts.count[i]   range into `geometry.index`
   *   parts.owners[parts.ownerOf[i]]    the build step, zone or link
   *   parts.pieces[parts.pieceOf[i]]    a finer label, or null
   *   parts.squareAt[i]                 -1, or the row of `parts.squares`
   *                                     holding the eight corners of the plain
   *                                     box this chamfered piece was cut from
   *
   * `squares`/`squareAt` are null on a batch that chamfered nothing, which is
   * every batch outside the station's own scale.
   *
   * Entry 0 of both string tables is `null`, so an unlabelled piece costs no
   * table row. `start` is a running sum of source index counts, which is
   * exactly what `mergeGeometries` concatenates - asserted, not assumed, by
   * `geo-batch-parts.test.mjs`.
   */
  flush(parent, materials, name, opts = {}) {
    const out = [];
    for (const [key, list] of this.buckets) {
      if (!list.length) continue;
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (!merged) {
        console.warn(`[StationWorld] merge failed for bucket "${key}" in ${name}`);
        continue;
      }
      if (list.length > 1) for (const g of list) g.dispose();
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, materials[key]);
      mesh.name = `${name}:${key}`;
      const o = opts[key] ?? opts;
      mesh.castShadow = o.cast ?? true;
      mesh.receiveShadow = o.recv ?? true;
      parent.add(mesh);
      out.push(mesh);

      const recs = this.parts.get(key);
      if (recs) mesh.userData.parts = packParts(recs);
    }
    this.buckets.clear();
    this.parts.clear();
    return out;
  }
}

/**
 * Split a world-space triangle soup into small, spatially compact chunks.
 *
 * Each chunk becomes one `mesh` collider, and a mesh collider has no internal
 * tree - a query that reaches it pays for all of it. So the split is by
 * triangle *count*, recursively at the median of whichever axis the chunk's
 * centroids are most spread across, until every leaf holds `maxTris`. A fixed
 * spatial grid cannot do this: station geometry is uneven enough that the same
 * cell size gives 20,000 triangles over the plaza and 40 over the cargo yard,
 * and it is the 20,000 that decides the frame time.
 *
 * Median splitting on the longest axis also keeps chunks roughly cubic, which
 * matters twice over: their AABBs are what both the capsule solver and the
 * raycaster reject against, and the broadphase indexes them by XZ footprint.
 *
 * @param {Float32Array} soup 9 floats per triangle, world space
 * @param {number} maxTris leaf size
 * @returns {Float32Array[]} one buffer per chunk
 */
export function chunkTriangles(soup, maxTris) {
  const count = soup.length / 9;
  if (count === 0) return [];

  const order = new Int32Array(count);
  const centroids = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    order[i] = i;
    const o = i * 9;
    centroids[i * 3] = (soup[o] + soup[o + 3] + soup[o + 6]) / 3;
    centroids[i * 3 + 1] = (soup[o + 1] + soup[o + 4] + soup[o + 7]) / 3;
    centroids[i * 3 + 2] = (soup[o + 2] + soup[o + 5] + soup[o + 8]) / 3;
  }

  const leaves = [];
  const stack = [[0, count]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    const n = hi - lo;
    if (n <= maxTris) {
      leaves.push([lo, hi]);
      continue;
    }
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = lo; i < hi; i++) {
      const c = order[i] * 3;
      const x = centroids[c], y = centroids[c + 1], z = centroids[c + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const ex = maxX - minX, ey = maxY - minY, ez = maxZ - minZ;
    // Coincident centroids - a stack of identical decals, say. No split can
    // separate them, and recursing would not terminate.
    if (Math.max(ex, ey, ez) < 1e-4) {
      leaves.push([lo, hi]);
      continue;
    }
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    const slice = Array.from(order.subarray(lo, hi));
    slice.sort((p, q) => centroids[p * 3 + axis] - centroids[q * 3 + axis]);
    for (let i = 0; i < slice.length; i++) order[lo + i] = slice[i];
    const mid = lo + (n >> 1);
    stack.push([lo, mid], [mid, hi]);
  }

  return leaves.map(([lo, hi]) => {
    const out = new Float32Array((hi - lo) * 9);
    for (let i = lo; i < hi; i++) {
      const src = order[i] * 9;
      out.set(soup.subarray(src, src + 9), (i - lo) * 9);
    }
    return out;
  });
}

/** Longest side of a chunk's axis-aligned bounds, in metres. */
export function chunkSpan(positions) {
  if (!positions.length) return 0;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity;
  let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return Math.max(x1 - x0, y1 - y0, z1 - z0);
}

/**
 * `chunkTriangles`, but bounded in metres as well as in triangles.
 *
 * The median chunker splits on triangle COUNT, which is a stand-in for size
 * only while the geometry is evenly dense. It is not, once the map is five
 * decks wide: sixty shrubs scattered over a zone are one chunk exactly as much
 * as sixty triangles of one hedge are. That matters wherever a chunk becomes a
 * BOX - see `_solidifyPlanting`, where it produced a solid slab 250 by 301 m
 * lying across a corridor - and not at all where a chunk stays triangles.
 *
 * Anything still wider than `maxSpan` goes back through the chunker with half
 * its budget, and the loop stops the moment a split stops splitting.
 *
 * That last condition is not a belt-and-braces guard, it is the termination
 * proof. Halving the budget usually makes progress because the median split
 * always makes both halves strictly smaller - but `chunkTriangles` refuses to
 * divide triangles whose CENTROIDS coincide, since no plane can separate them,
 * and hands the range back whole however small the budget. Asking it again is
 * then an infinite loop, which is what a first version of this did: `node
 * --test` on forty stacked cards simply never returned. A single triangle, or
 * a stack that cannot be told apart, is where this has to stop.
 */
export function chunkTrianglesBySpan(soup, maxTris, maxSpan) {
  const out = [];
  const pending = chunkTriangles(soup, maxTris);
  while (pending.length) {
    const positions = pending.pop();
    const n = positions.length / 9;
    if (n > 1 && chunkSpan(positions) > maxSpan) {
      const parts = chunkTriangles(positions, n >> 1);
      if (parts.length > 1) {
        for (const part of parts) pending.push(part);
        continue;
      }
    }
    out.push(positions);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Polar helpers - the whole map is laid out on radiating avenues      */
/* ------------------------------------------------------------------ */

export function roadPos(deg, r, off = 0, y = 0, out = new THREE.Vector3()) {
  const t = deg * DEG;
  const c = Math.cos(t), s = Math.sin(t);
  return out.set(c * r - s * off, y, s * r + c * off);
}

/** Yaw for a building whose facade (-Z in local space) should face the avenue. */
export function faceRoadYaw(deg, side) {
  const t = deg * DEG;
  return side > 0 ? -t : Math.PI - t;
}

/** World-space centre of an outer zone's deck. */
export function zoneCentre(deg, out = new THREE.Vector3()) {
  return roadPos(deg, ZONE_CENTRE_R, 0, 0, out);
}

/**
 * Zone-local (lx, lz) -> world, for a zone on `deg`.
 *
 * Local +Z points back down the corridor toward the hub and local +X is to the
 * right of someone walking out of it, so every zone is authored in the same
 * frame regardless of which avenue it hangs off. That is what lets the four zone
 * builders share a floor plan vocabulary - "the servery is at lz = -60" means
 * the same thing in all of them.
 */
export function zoneLocal(deg, lx, ly, lz, out = new THREE.Vector3()) {
  const t = deg * DEG;
  const c = Math.cos(t), s = Math.sin(t);
  // Outward unit vector (c, s); the corridor runs along it.
  const cx = c * ZONE_CENTRE_R, cz = s * ZONE_CENTRE_R;
  return out.set(cx - c * lz - s * lx, ly, cz - s * lz + c * lx);
}

/**
 * Yaw of a zone-local heading, for geometry placed through `GeoBatch.localAt`.
 *
 * Chosen so that `localAt(key, geo, centre.x, 0, centre.z, zoneYaw(deg), lx, ly, lz)`
 * lands on exactly the same world point as `zoneLocal(deg, lx, ly, lz)`.
 * `localAt` sends local +Z to `(sin yaw, cos yaw)` and local +X to
 * `(cos yaw, -sin yaw)`; the zone frame wants +Z pointing back down the corridor
 * at `(-cos t, -sin t)`, which is `yaw = atan2(-cos t, -sin t) = -PI/2 - t`.
 */
export function zoneYaw(deg, localYaw = 0) {
  return -Math.PI / 2 - deg * DEG + localYaw;
}

/* ------------------------------------------------------------------ */
/* The gateway ring                                                    */
/* ------------------------------------------------------------------ */

/**
 * Outer edge of an avenue's paved footprint, measured from its centreline.
 *
 * The carriageway is `ROAD_W` across and a hazard kerb 0.9 m wide is centred on
 * `ROAD_W / 2 + 0.45` down each side, so the last painted metal is at 9.9. This
 * is what every clearance below is measured to; the carriageway alone
 * understates the obstruction by nearly a metre.
 */
export const ROAD_EDGE_HALF = ROAD_W / 2 + 0.45 + 0.45;

/**
 * The avenue's inset light strip, and the legends painted inboard of it.
 *
 * These four are together because two of them have to agree and, until they
 * were derived from each other, nothing made them. The strip stood at 6.57
 * across with a 0.42 m width; the legends were centred at a flat 5.4 with a
 * 4.2 m cell, so each legend spanned 3.3-7.5 and the strip cut through it at
 * 6.36-6.78 - and 5 mm proud of it, so the strip won. Every avenue decal on
 * both sides of all six avenues had one end painted over. It read as a word
 * with its first letter missing.
 *
 * `_buildDeck` now derives the legend offset from the strip, so the two cannot
 * drift apart again: move the strip and the legends follow.
 */
export const STRIP_ACROSS = 6.57;
export const STRIP_HALF_W = 0.21;
export const DECAL_SIZE = 4.2;
/** Dark deck left between a legend's edge and the strip, so they read apart. */
export const DECAL_GAP = 0.35;

/** Bearings of the avenues. One list, so a clearance cannot be measured
 *  against a different set of roads than the one that gets built. Frozen
 *  because `StationWorld` now assigns it straight to `this.roadAngles` and a
 *  world quietly editing a module constant would move the roads for the
 *  clearance maths too, without moving the roads. */
export const ROAD_ANGLES_DEG = Object.freeze([0, 60, 120, 180, 240, 300]);

/**
 * The six gateway bearings, in degrees.
 *
 * ── Why 30 + 60k and not 0 + 60k ──────────────────────────────────────────
 * The plaza has six radiating avenues on `ROAD_ANGLES_DEG`, so six gateways at
 * 60-degree spacing have exactly two possible phases: ON the avenues, or
 * BETWEEN them. This is the second, and the choice is measured rather than
 * aesthetic.
 *
 * An avenue's paved width is 19.8 m including kerbs. Aligned with an avenue, a
 * gateway lands its 14 m approach flight and its 8.4 m service ramp squarely
 * inside that, from r = 36.5 at the bottom tread to r = 70.2 at the ramp tip -
 * thirty-four metres of road you have to climb over. That is not a hypothesis.
 * The station audit already reports avenues 0 and 180 obstructed, and `13fa912`
 * records why: "the gateway approach RAMP and its kerbs ... 8 m wide inside an
 * 18 m carriageway", for the citadel and race gateways, which are precisely the
 * two that sit on avenue bearings. Aligning all six multiplies that by three,
 * and `gatewayClearances(ROAD_ANGLES_DEG, ROAD_ANGLES_DEG)` returns a negative
 * avenue clearance for it, so the counterfactual is pinned by a test rather
 * than asserted here.
 *
 * Between the avenues nothing is spanned. `gatewayClearances()` measures it and
 * names the binding point, which is NOT the part that looks tightest: the
 * approach flight comes no closer than about 4.3 m, but the dais's square box
 * collider has corners at 15.0 m where the octagon it stands for reaches only
 * 11.4, and those corners close to 2.62 m. That 2.62 is not a cost of this
 * change - it is exactly the clearance the medieval and sports gateways have
 * had all along, because a square collider rotated onto a 60-degree phase
 * presents the same corner to the same kerb. The over-reaching collider is
 * pre-existing and is left alone here; shrinking it is a collision question,
 * not a placement one.
 *
 * The decisive evidence is that this phase is not new. Medieval (270) and
 * sports (90) already stand between avenues and are the two gateways nothing
 * has ever been reported against; citadel (180), race (0) and the maze - which
 * shipped off-axis entirely, at (-54, 128), 139 m from the plaza centre and on
 * no bearing at all - are the three that have. This generalises the arrangement
 * that already works, and it moves neither of the two that were already right.
 */
export const GATEWAY_BEARINGS_DEG = [30, 90, 150, 210, 270, 330];

/**
 * The gateway assembly's own dimensions, in its local frame.
 *
 * Local +Z points OUTWARD from the plaza centre, local -Z is the approach, and
 * local +X is tangential. That is the frame `_buildPortalDaises` was already
 * authored in - it is the sports gateway with `sign = +1` and `cz = 0` - so
 * these are transcribed from it rather than chosen, and the clearance maths
 * here and the geometry that gets built read the same numbers.
 */
export const GATEWAY = {
  /** Widest drawn radius: the dais cone's bottom rim. */
  DAIS_R: 11.4,
  /** Half-extent of the dais box collider. Square, so its corners reach 15.0. */
  COLLIDER_HALF: 10.6,
  /** Approach flight: six treads of 0.40 m, the first at local z = -11. */
  TREADS: 6,
  TREAD_RISE: 0.40,
  TREAD_PITCH: 1.3,
  TREAD_Z0: 11,
  TREAD_W0: 14,
  TREAD_TAPER: 0.75,
  /**
   * Service ramp on the far side: 8 m of run over the dais's 2.4 m.
   *
   * ── 14.6 and not 12, because at 12 the ramp climbed INSIDE the dais ─────
   * `_ramp` is 8 m long about this centre, so at 12 its head was at local
   * z = 8 and the dais collider reaches local z = `COLLIDER_HALF` = 10.6. The
   * last 5.4 m of every one of the six ramps was therefore under the dais: a
   * body climbing met the rim at 5.4 m up, where the ramp surface is
   * `2.4 * 5.4 / 8` = 1.62 m and the deck is 2.40 - a 0.78 m rise, over
   * `CONFIG.player.stepHeight` 0.45 and under `Climb.MIN_RISE_GROUND` 1.0, so
   * neither a step nor a mantle. It is worse for the thing the ramp exists
   * for: `Horse`'s own STEP_UP is 0.75 and a mount cannot mantle at all, and
   * the note on the ramp says in as many words that this is how a mount
   * reaches the dais.
   *
   * `COLLIDER_HALF + 8 / 2` puts the head exactly on the dais edge, so the
   * ramp arrives at 2.40 where the deck is 2.40. The drawn pad is 8.4 long
   * and so overlaps the dais by 0.2 m, which is the direction that leaves no
   * seam. Found by `ramp-landing-clearance.test.mjs` once it started walking
   * flights instead of only walking off their heads.
   */
  RAMP_Z: 14.6,
  RAMP_LEN: 8.4,
  RAMP_HALF_W: 4.2,
};

/** Yaw that maps the gateway's local frame onto the world at bearing `deg`. */
export function gatewayFrameYaw(deg) {
  /* `localAt` sends local +Z to (sin yaw, cos yaw). Outward at bearing `deg` is
   * (cos, sin), so yaw = 90 - deg. This is also exactly the portal spec's
   * `rotationY` for all four on-axis gateways as they shipped: sports (deg 90)
   * had 0, medieval (270) PI, race (0) PI/2, citadel (180) -PI/2. */
  return Math.PI / 2 - deg * DEG;
}

/** World (x, z) of the dais centre at bearing `deg`. */
export function gatewayCentre(deg) {
  const t = deg * DEG;
  return [Math.cos(t) * PORTAL_R, Math.sin(t) * PORTAL_R];
}

/**
 * World (x, z) of every gateway's dais centre.
 *
 * Derived from one bearing list rather than written out, because a hand-kept
 * copy is what the previous version of this constant existed to survive: the
 * maze gateway shipped off-axis and the two hardcoded four-entry position
 * arrays in `_buildCrowd` had no way to know they needed a fifth. Nothing may
 * hardcode the arity again - a seventh bearing added above has to reach every
 * consumer on its own.
 */
export const GATEWAY_CENTRES = GATEWAY_BEARINGS_DEG.map(gatewayCentre);

/**
 * The outline of one gateway assembly in its own local frame.
 *
 * Corners and rim samples only - enough to bound everything that stands on the
 * deck, which is what a clearance is measured from. Each point is labelled so a
 * failing clearance names the part that is too close instead of a coordinate.
 *
 * @returns {Array<{x:number, z:number, what:string}>}
 */
export function gatewayLocalFootprint() {
  const pts = [];
  // Dais rim, at the octagon's eight corners.
  for (let i = 0; i < 8; i++) {
    const th = (i / 8) * Math.PI * 2 + Math.PI / 8;
    pts.push({ x: Math.cos(th) * GATEWAY.DAIS_R, z: Math.sin(th) * GATEWAY.DAIS_R, what: 'dais rim' });
  }
  /* The dais collider is a square box and its corners reach 15.0 m, further
   * than the 11.4 m octagon it stands for. A player is stopped by the collider,
   * not by the drawing, so the corners are part of the footprint. */
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      pts.push({
        x: sx * GATEWAY.COLLIDER_HALF, z: sz * GATEWAY.COLLIDER_HALF,
        what: 'dais collider corner',
      });
    }
  }
  // Approach treads, widest first, marching away from the dais.
  for (let i = 0; i < GATEWAY.TREADS; i++) {
    const w = GATEWAY.TREAD_W0 - i * GATEWAY.TREAD_TAPER;
    const z = -(GATEWAY.TREAD_Z0 + i * GATEWAY.TREAD_PITCH);
    for (const sx of [-1, 1]) {
      for (const dz of [-0.7, 0.7]) {
        pts.push({ x: sx * (w / 2), z: z + dz, what: `approach tread ${i}` });
      }
    }
  }
  // Service ramp and its kerbs.
  for (const sx of [-1, 1]) {
    for (const dz of [-1, 1]) {
      pts.push({
        x: sx * GATEWAY.RAMP_HALF_W,
        z: GATEWAY.RAMP_Z + dz * (GATEWAY.RAMP_LEN / 2),
        what: 'service ramp',
      });
    }
  }
  return pts;
}

/** The same outline placed in the world at bearing `deg`. */
export function gatewayWorldFootprint(deg) {
  const yaw = gatewayFrameYaw(deg);
  const [cx, cz] = gatewayCentre(deg);
  const c = Math.cos(yaw), s = Math.sin(yaw);
  // Matches `GeoBatch.localAt` exactly: +X -> (cos, -sin), +Z -> (sin, cos).
  return gatewayLocalFootprint().map((p) => ({
    x: cx + p.x * c + p.z * s,
    z: cz - p.x * s + p.z * c,
    what: p.what,
  }));
}

/**
 * Distance from a deck point to the nearest avenue's paved edge.
 *
 * An avenue is a strip of half-width `ROAD_EDGE_HALF` running outward from
 * `PLAZA_R - 3`, so this is point-to-rectangle and not point-to-line: a point
 * inboard of the avenue's mouth is clear of it however close to the bearing it
 * lies. Negative means the point is standing on the road.
 */
export function avenueClearance(x, z, roadAngles = ROAD_ANGLES_DEG) {
  let best = Infinity;
  const r0 = PLAZA_R - 3;
  for (const deg of roadAngles) {
    const t = deg * DEG;
    const along = x * Math.cos(t) + z * Math.sin(t);
    const across = Math.abs(-x * Math.sin(t) + z * Math.cos(t));
    const dAlong = Math.max(0, r0 - along);
    const dAcross = across - ROAD_EDGE_HALF;
    const d = dAcross >= 0
      ? Math.hypot(dAlong, dAcross)
      : (dAlong > 0 ? dAlong : dAcross);
    if (d < best) best = d;
  }
  return best;
}

/** Radius of the plaza-centre monument cluster - the circle `_buildPlazaCentre`
 *  draws on the minimap for it. */
export const MONUMENT_R = 11.6;

/**
 * Every clearance the gateway ring has to satisfy, measured rather than
 * asserted. Exported so the headless test and the note on
 * `GATEWAY_BEARINGS_DEG` read one implementation.
 */
export function gatewayClearances(bearings = GATEWAY_BEARINGS_DEG, roadAngles = ROAD_ANGLES_DEG) {
  let avenue = Infinity, avenueAt = null;
  let monument = Infinity;
  let column = Infinity;
  let neighbour = Infinity;

  for (const deg of bearings) {
    for (const p of gatewayWorldFootprint(deg)) {
      const a = avenueClearance(p.x, p.z, roadAngles);
      if (a < avenue) { avenue = a; avenueAt = `${deg} deg ${p.what}`; }
      const m = Math.hypot(p.x, p.z) - MONUMENT_R;
      if (m < monument) monument = m;
      // Walkway support columns: twelve at 15 + 30k, 1.45 m at the hazard base.
      for (let i = 0; i < 12; i++) {
        const th = (i / 12) * Math.PI * 2 + 15 * DEG;
        const d = Math.hypot(p.x - Math.cos(th) * LOOP_R, p.z - Math.sin(th) * LOOP_R) - 1.45;
        if (d < column) column = d;
      }
    }
  }
  /* Collider corner to collider corner between the two closest daises. The
   * square collider is the binding shape again, not the octagon. */
  const reach = GATEWAY.COLLIDER_HALF * Math.SQRT2;
  for (let i = 0; i < bearings.length; i++) {
    for (let j = i + 1; j < bearings.length; j++) {
      const [ax, az] = gatewayCentre(bearings[i]);
      const [bx, bz] = gatewayCentre(bearings[j]);
      const d = Math.hypot(ax - bx, az - bz) - 2 * reach;
      if (d < neighbour) neighbour = d;
    }
  }
  return { avenue, avenueAt, monument, column, neighbour };
}

/* ------------------------------------------------------------------ */
/* Where derived collision applies                                     */
/* ------------------------------------------------------------------ */

/**
 * Ceiling for geometry-derived collision inside a link corridor.
 *
 * A link is a sealed 9.5 m tube: the top of its roof plate is at 9.85 m and the
 * service bays' roofs at 9.95. Nothing higher is inside the corridor at all -
 * what is up there is apron dressing and the dome, metres away to the side of
 * a band that has to be wide enough to hold the glazed bays, and none of it is
 * anywhere a player can stand. 12 clears the tube with two metres to spare.
 */
export const LINK_COLLIDE_CEILING = 12;

/**
 * Half-width of a link's collision band.
 *
 * The corridor's own walls stand at 9.7 m from the axis and its two glazed
 * service bays reach 16.7; 18 takes both with a margin, and the ceiling above
 * is what keeps the extra width from collecting anything that is not corridor.
 */
const LINK_BAND_HALF = 18;

/**
 * Four metres past the rim. The perimeter wall is drawn at `ZONE_R + 2` and is
 * 1.1 m thick, and the deck disc runs to `ZONE_R + 3`, so this is the smallest
 * radius that has a zone wholly inside its own region.
 */
const ZONE_COLLIDE_R = ZONE_R + 4;

/* Hub and zone decks: cx, cz, r^2, ceiling. Then the four links: ux, uz, tMin,
 * tMax, halfWidth^2, ceiling. Flat `Float64Array`s rather than objects because
 * `collideCeilingAt` runs once per triangle - see its note. */
const COLLIDE_DISCS = new Float64Array((1 + ZONES.length) * 4);
const COLLIDE_BANDS = new Float64Array(ZONES.length * 6);
{
  const c = new THREE.Vector3();
  COLLIDE_DISCS[2] = DECK_R * DECK_R;
  COLLIDE_DISCS[3] = COLLIDE_CEILING;
  ZONES.forEach((z, i) => {
    zoneCentre(z.deg, c);
    const d = (i + 1) * 4;
    COLLIDE_DISCS[d] = c.x;
    COLLIDE_DISCS[d + 1] = c.z;
    COLLIDE_DISCS[d + 2] = ZONE_COLLIDE_R * ZONE_COLLIDE_R;
    COLLIDE_DISCS[d + 3] = COLLIDE_CEILING;

    const t = z.deg * DEG, b = i * 6;
    COLLIDE_BANDS[b] = Math.cos(t);
    COLLIDE_BANDS[b + 1] = Math.sin(t);
    /* Starts inside the hull line and stops at the zone rim, matching the
     * corridor `buildLink` actually draws (R0 = HULL_R - 6, R1 = the rim). The
     * overlap at both ends is what keeps the three regions one connected
     * surface rather than three with seams between them. */
    COLLIDE_BANDS[b + 2] = HULL_R - 8;
    COLLIDE_BANDS[b + 3] = ZONE_CENTRE_R - ZONE_R + 2;
    COLLIDE_BANDS[b + 4] = LINK_BAND_HALF * LINK_BAND_HALF;
    COLLIDE_BANDS[b + 5] = LINK_COLLIDE_CEILING;
  });
}

/**
 * How high geometry-derived collision reaches above `(x, z)`, or `-Infinity`
 * where there is none.
 *
 * ── The defect this replaces ──────────────────────────────────────────────
 * `_collisionSoup` used to end its per-triangle filter with
 *
 *     if (cx * cx + cz * cz > DECK_R * DECK_R) continue;
 *
 * which was right while the hub was the whole world and silently wrong from the
 * day the outer ring was built. The four zones sit at `ZONE_CENTRE_R` = 498 with
 * a 200 m radius of their own, so every triangle in four fifths of the finished
 * map was thrown away before it could become a collider, and the outer ring
 * stood on nothing but the colliders its builders had remembered to write by
 * hand - 110 calls in the gym, 74 in the works, 69 in the galley, 13 in Hab
 * Ring C, against roughly eight thousand drawn objects.
 *
 * ── Why discs and a band, and not a polygon ───────────────────────────────
 * This is asked once per triangle, a quarter of a million times per build, so
 * it has to stay arithmetic. It can, because the map is exactly five discs
 * joined by four straight corridors: five squared-distance tests and four
 * projections onto a known unit vector describe it with no approximation, and
 * the first hit returns.
 *
 * The hub is tested first and its disc is untouched - same `DECK_R`, same
 * `COLLIDE_CEILING` - so nothing about the hub's collision moves. Everything
 * here is additive.
 *
 * ── Why the zones keep the hub's 62 m ceiling ─────────────────────────────
 * Because that is what it was raised for. `COLLIDE_CEILING` above is the
 * highest STANDABLE surface on the finished map plus a metre, and three of the
 * four surfaces its note names are out here: the hab stacks at 46, the
 * expansion site's scaffold decks at 52, the tower crane's walkway at 58. An
 * arcade-height ceiling was measured against the built world before being
 * rejected: a zone holds 4,786 candidate triangles between 32 and 62 m, every
 * one of them in the open court where those structures stand, and exactly none
 * under the 30 m arcade plate. Cutting the zones at the arcade would have saved
 * nothing and taken the crane.
 */
export function collideCeilingAt(x, z) {
  for (let i = 0; i < COLLIDE_DISCS.length; i += 4) {
    const dx = x - COLLIDE_DISCS[i], dz = z - COLLIDE_DISCS[i + 1];
    if (dx * dx + dz * dz <= COLLIDE_DISCS[i + 2]) return COLLIDE_DISCS[i + 3];
  }
  for (let i = 0; i < COLLIDE_BANDS.length; i += 6) {
    const ux = COLLIDE_BANDS[i], uz = COLLIDE_BANDS[i + 1];
    const t = x * ux + z * uz;
    if (t < COLLIDE_BANDS[i + 2] || t > COLLIDE_BANDS[i + 3]) continue;
    const lat = z * ux - x * uz;
    if (lat * lat <= COLLIDE_BANDS[i + 4]) return COLLIDE_BANDS[i + 5];
  }
  return -Infinity;
}
