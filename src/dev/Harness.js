/**
 * Automated screenshot and measurement harness.
 *
 * Loaded only when the page is opened with ?dev=1. It gives the visual-review
 * tooling deterministic control over which world is loaded, where the camera
 * sits, and whether the HUD is composited - so a critique compares art
 * direction rather than whatever the player happened to be looking at.
 *
 * Everything here is dev-only and is tree-shaken out of a normal boot.
 *
 * ------------------------------------------------------------------------
 * MEASURING PERFORMANCE THROUGH THIS FILE - read this before trusting a number
 * ------------------------------------------------------------------------
 * Three separate measurement runs were thrown away because the harness quietly
 * measured a game that was not running. The failures, and what now stops them:
 *
 *  1. An automated browser cannot hold a pointer lock, and losing it blocks the
 *     entire gameplay update - including all NPC and world LOD. `ready()` now
 *     turns on `setGameplayDriven` by default and `stats().gameplayDriven` says
 *     so out loud. If that flag is false, every LOD figure you are looking at
 *     is the LOD-disabled worst case.
 *  2. `stats().drawCalls` was a ~1 Hz sample, so an A/B read the previous
 *     value. It is the instantaneous `renderer.info` figure now; the sampled
 *     ones live under `stats().sampled`.
 *  3. The sun's shadow camera is aimed at the PLAYER, so a camera-only framing
 *     shadowed an empty slab. `view()`/`look()` move the player too by default.
 *  4. `freezeAll(true)` twice used to capture its own stub and destroy
 *     `npcManager.fixedUpdate` for the life of the page. It is idempotent now.
 *  5. A stalled frame loop (backgrounded window) leaves the sun stranded behind
 *     the player. `stats()` reports `documentHidden`, `enginePaused` and the
 *     rAF stall count; `holdAwake()` refuses pauses.
 *  6. `renderer.info` frame totals move 10-13% between loads. `worldTriangles()`
 *     is the deterministic counterpart - see src/dev/WorldTriangles.js.
 */

import { MAZE, DIR, cellIndex, districtCoords, isOpen, connectorAt } from '../worlds/maze/MazeTopology.js';
import { cellToWorld } from '../worlds/maze/MazeColliders.js';
import { shaftColliders, connectorHoleBounds } from '../worlds/maze/MazeShafts.js';
import { setMazeSurfaceMode, mazeSurfaceMode } from '../worlds/maze/MazeMaterials.js';
import { walkWorldTriangles } from './WorldTriangles.js';
import { BERTHS } from '../worlds/dock/YardPlan.js';
import { HULLS } from '../worlds/dock/HullPlan.js';
import { SPACE_BODIES } from '../worlds/space/Bodies.js';

/* ------------------------------------------------------------------ */
/* Framings that are DERIVED rather than typed                         */
/* ------------------------------------------------------------------ */

/**
 * A point in a berthed hull's own local frame, in world coordinates.
 *
 * The same transform `ShipBuild` uses to place every box in the hull
 * (`ox + lx*cos + lz*sin`, `oz - lx*sin + lz*cos`), so a framing computed from
 * a room's declared span lands where that room actually is. All three flyable
 * berths are yawed PI, but the arithmetic is written in full because the
 * Bastion is not and the next berth added may not be either.
 *
 * @param {object} b a `YardPlan.BERTHS` row
 * @param {number} lx @param {number} ly above the cradle top @param {number} lz
 */
function berthPoint(b, lx, ly, lz) {
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  return [b.x + lx * c + lz * s, b.cradleTop + ly, b.z - lx * s + lz * c];
}

/**
 * The frame this file reasons about when it says "fills the frame".
 *
 * The canvas is whatever the reviewer's window is; 16:9 is the shape every
 * screenshot in this project has been taken at and the shape
 * `harness-framings.test.mjs` re-derives coverage against, so the two agree.
 */
export const FRAME_ASPECT = 16 / 9;

/**
 * How much of the frame a hull framing puts its subject across, on the worse
 * of the two axes.
 *
 * 0.88 rather than 1.0 so the extremities — a fin tip, the Dray's derrick head
 * — sit inside the frame with a margin instead of touching the edge, which is
 * what a photographer would do and what makes a silhouette legible. Fitted
 * against the hull's PLAN box; `harness-framings.test.mjs` then holds the
 * DRAWN hull to a floor well under it, because drawn dressing can exceed the
 * plan and a ceiling would be a false failure.
 */
const FRAME_TARGET = 0.88;

/**
 * Where a world point lands in normalised device coordinates, for a camera at
 * `eye` looking at `at`. ±1 is the edge of frame on each axis.
 *
 * Hand-rolled rather than borrowed from a `THREE.PerspectiveCamera` so that the
 * FRAMING TABLE can be computed at module load, in Node, with no renderer and
 * no DOM — which is what lets the test assert coverage on the same arithmetic
 * the harness used to choose the camera.
 *
 * @returns {[number, number, number]} x, y, and camera-space depth (negative
 *   means the point is behind the camera).
 */
function ndcOf(p, eye, at, fovDeg, aspect = FRAME_ASPECT) {
  let fx = at[0] - eye[0], fy = at[1] - eye[1], fz = at[2] - eye[2];
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl; fy /= fl; fz /= fl;
  // right = normalise(forward x worldUp); worldUp is +Y, so this collapses.
  let rx = -fz, rz = fx;
  const rl = Math.hypot(rx, rz) || 1;
  rx /= rl; rz /= rl;
  // up = right x forward
  const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
  const dx = p[0] - eye[0], dy = p[1] - eye[1], dz = p[2] - eye[2];
  const cz = dx * fx + dy * fy + dz * fz;
  if (cz <= 1e-6) return [0, 0, cz];
  const cx = dx * rx + dz * rz;
  const cy = dx * ux + dy * uy + dz * uz;
  const t = Math.tan((fovDeg * Math.PI) / 360);
  return [cx / (cz * t * aspect), cy / (cz * t), cz];
}

/**
 * How much of the frame a set of world points covers, as a fraction per axis.
 * 1.0 is edge to edge; over 1.0 is cropped.
 */
export function frameCoverage(points, eye, at, fovDeg, aspect = FRAME_ASPECT) {
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
  for (const p of points) {
    const [x, y, z] = ndcOf(p, eye, at, fovDeg, aspect);
    if (z <= 1e-6) return { w: Infinity, h: Infinity };
    if (x < mnx) mnx = x; if (x > mxx) mxx = x;
    if (y < mny) mny = y; if (y > mxy) mxy = y;
  }
  return { w: (mxx - mnx) / 2, h: (mxy - mny) / 2 };
}

/**
 * The extremities of a hull, read out of its own `HullPlan` entry.
 *
 * ── WHY THIS IS A WALK AND NOT THREE FIELD READS ─────────────────────────
 * The obvious box is `ledge.outer` by `z0..z1` by `spine.y`, and it is wrong
 * by a factor of two on two of the three hulls. The Pike's plan half-beam is
 * 2.35 and she is 5.60 across her wings; the Kestrel's is 2.30 and she is 4.73
 * across her nacelles; the Dray's crown is 6.54 and her derrick head is at
 * 12.20. A framing fitted to the narrow box walks the camera inside the ship.
 *
 * So every nested plan record is walked and every field whose NAME says which
 * axis it is on contributes. That is mechanical, so it keeps tracking the hull
 * when a hull grows a part, which is exactly the drift that put the old typed
 * framings on the shop floor. It over-includes rather than under-includes —
 * the yard's own brow and the Pike's scaffold are in these numbers and they
 * are in the shot, because this framing photographs a hull IN ITS BERTH.
 *
 * @returns {{hw:number, top:number, z0:number, z1:number}} hull-local
 */
function planExtents(H) {
  let hw = 0, top = 0, z0 = 0, z1 = 0;
  const X = ['hw', 'outer', 'x0', 'x1', 'lx', 'headX', 'mastX', 'width', 'deckX0', 'deckX1'];
  const Y = ['y', 'y0', 'y1', 'top', 'ceilY', 'headY', 'heelY', 'mastTop', 'tipY', 'rise'];
  const Z = ['z', 'z0', 'z1', 'lz', 'mastZ', 'tipZ', 'footZ', 'deckZ0', 'deckZ1'];
  const eat = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 2) return;
    for (const k in o) {
      const v = o[k];
      if (v && typeof v === 'object') { eat(v, depth + 1); continue; }
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      if (X.includes(k)) hw = Math.max(hw, Math.abs(v));
      else if (Y.includes(k)) top = Math.max(top, v);
      else if (Z.includes(k)) { z0 = Math.min(z0, v); z1 = Math.max(z1, v); }
    }
  };
  eat(H, 0);
  return { hw, top, z0, z1 };
}

/**
 * The eight corners of a hull's extremity box, in world space.
 *
 * The PLAN, not the drawn geometry: this runs at module load with no world
 * built and no renderer, which is what lets `harness-framings.test.mjs` check
 * the same arithmetic under `node --test`.
 */
function hullCorners(b, e) {
  const out = [];
  for (const lx of [-e.hw, e.hw]) {
    for (const ly of [Math.min(0, -0.6), e.top]) {
      for (const lz of [e.z0, e.z1]) out.push(berthPoint(b, lx, ly, lz));
    }
  }
  return out;
}

/**
 * Two framings for one berthed hull: a three-quarter from the apron side, and
 * one standing inside its largest compartment.
 *
 * The stand-off is measured from the BERTH BOX (`b.hw`/`b.hd`, which is what
 * the yard reserved for this hull) rather than from a guess, and the camera is
 * put on whichever flank the apron is on - the side a player actually walks
 * up. Both are the reason these are generated: the previous table had them
 * typed, the berths moved onto the piers, and every one of them ended up
 * framing empty floor.
 *
 * @param {object} b a `YardPlan.BERTHS` row
 * @param {object} H the matching `HullPlan.HULLS` entry
 */
function berthViews(b, H) {
  const out = [];
  /* Which way the apron lies from the berth centre, in world XZ. */
  const ax = b.apron.x - b.x;
  const az = b.apron.z - b.z;
  const al = Math.hypot(ax, az) || 1;
  const ux = ax / al;
  const uz = az / al;
  /* Along the hull, so the shot is a three-quarter and not a flat broadside —
   * and specifically along the hull's OWN NOSE, `berthPoint`'s +Z. Taken as a
   * 90-degree turn off the apron bearing it landed on whichever quarter that
   * happened to give, which for the Kestrel was ASTERN: the shot showed a
   * transom, two nacelles and no nose at all, and the nose is the single thing
   * in a silhouette that says "spacecraft". */
  const lx = Math.sin(b.yaw);
  const lz = Math.cos(b.yaw);
  /* ── THE LENS, AND THE CLAIM THAT WAS NOT A MEASUREMENT ─────────────────
   *
   * What stood here said, as a measured fact: "At `hw + 8`, with the camera at
   * chest height on the apron, the hull fills the frame and the sky is behind
   * it." It does not. Driven live and the hull's own bounding box projected
   * through the camera the harness actually sets:
   *
   *   kestrel   camera (-51.0, 2.9, -132.8)  fov 74  19.8 m off a 6.8 m hull
   *                                          -> 33.3% of frame width, 36.9% of height
   *   pike                                   -> 45.7% x  53.3%
   *   dray                                   -> 63.5% x 182.8%   (mast out of shot)
   *
   * The rendered kestrel row is a lamp-lit pier with a small dark lump behind
   * a gantry column, and `harness-framings.test.mjs` passed it green — because
   * its ray hit `hatchleaf:dock_kestrel_hatch` at 17 m and a hatch leaf is
   * "something". A framing that shows 30% ship is the wrong instrument for the
   * one question this drop exists to answer, and three art reviews were taken
   * through it.
   *
   * WHAT IT IS NOW. The stand-off is SOLVED rather than guessed. The hull's
   * own published box — beam, walked crown, length, from `HullPlan`, not the
   * berth reservation — is projected through the candidate camera and the
   * distance is bisected until the box covers {@link FRAME_TARGET} of the
   * frame on its worst axis. A closed-form fit was tried first and is wrong by
   * a factor of two on these subjects: at 15 m from a 15 m hull the NEAR
   * corner projects far larger than the bounding sphere predicts, and the
   * three hulls came out at 111%, 148% and 184% of frame from one constant.
   * Bisection has no such blind spot and needs no per-hull tuning, which is
   * the property that stops this table going stale the next time a hull
   * changes shape.
   *
   * The camera STAYS at chest height on the apron, which was the one good
   * instinct in the old row: the question is what a player sees walking up to
   * the ship, and a hero shot from above answers a different one.
   */
  const ext = planExtents(H);
  const FOV = 46;
  const corners = hullCorners(b, ext);
  const eyeY = b.cradleTop + 1.7;
  const at = [b.x, b.cradleTop + ext.top * 0.42, b.z];
  /* Out from the flank and along the hull, normalised, so the shot is a
   * three-quarter — the angle a silhouette is read at — not a broadside. */
  const kOut = 0.82 / Math.hypot(0.82, 0.57);
  const kAlong = 0.57 / Math.hypot(0.82, 0.57);
  const eyeAt = (d) => [b.x + (ux * kOut + lx * kAlong) * d, eyeY, b.z + (uz * kOut + lz * kAlong) * d];
  let lo = 4, hi = 240;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const c = frameCoverage(corners, eyeAt(mid), at, FOV);
    if (Math.max(c.w, c.h) > FRAME_TARGET) lo = mid; else hi = mid;
  }
  const dist = (lo + hi) / 2;
  out.push({
    name: b.id,
    pos: eyeAt(dist),
    look: at,
    fov: FOV,
    subject: dist + ext.hw,
    /* The framing's own promise, for `harness-framings.test.mjs` to hold it
     * to against the DRAWN hull rather than against this box. */
    fills: b.id,
  });
  /* Inside. The largest declared compartment, standing at eye height on its
   * own sole and looking down its own length - so the framing is bounded by
   * the room's far bulkhead however the hull is later re-fitted. */
  const rooms = H.rooms ?? [];
  let room = null;
  for (const r of rooms) {
    if (!room || (r.z1 - r.z0) * r.hw > (room.z1 - room.z0) * room.hw) room = r;
  }
  if (room) {
    const eye = room.floorY + Math.min(1.55, (room.ceilY - room.floorY) - 0.25);
    out.push({
      name: `${b.id}-in`,
      pos: berthPoint(b, 0, eye, room.z0 + 0.6),
      look: berthPoint(b, 0, eye - 0.15, room.z1 - 0.4),
      fov: 88,
      subject: (room.z1 - room.z0) + 1.5,
    });
  }
  return out;
}

/** Every flyable berth, framed twice. The Bastion keeps its two hand-placed rows. */
const DOCK_HULL_VIEWS = BERTHS
  .filter((b) => HULLS[b.id] && b.id !== 'bastion')
  .flatMap((b) => berthViews(b, HULLS[b.id]));

/**
 * One framing per real body, aimed along its BEARING from the yard.
 *
 * Not at its position: `space/Backdrop.js` re-places every distant object
 * against the camera every frame, so the only stable thing about a body out
 * here is the direction it lies in. The camera stands 300 m off the yard so
 * the structure is out of shot, and looks 1 km down the bearing.
 *
 * `subject: Infinity` because the subject IS the backdrop - the framing probe
 * would otherwise fail every one of these for finding nothing within range,
 * which is exactly what they are for.
 */
const SPACE_BEARING_VIEWS = SPACE_BODIES.map((b) => {
  const d = Math.hypot(b.position[0], b.position[1], b.position[2]) || 1;
  const u = [b.position[0] / d, b.position[1] / d, b.position[2] / d];
  /* Stand off the yard along the bearing, so the yard is behind the camera. */
  const from = [u[0] * 320, u[1] * 320, u[2] * 320];
  return {
    name: `bearing-${b.id}`,
    pos: from,
    look: [from[0] + u[0] * 1000, from[1] + u[1] * 1000, from[2] + u[2] * 1000],
    fov: 62,
    aerial: true,
    subject: Infinity,
  };
});

/**
 * Camera framings, derived from each world's actual published layout
 * (portalSpecs, minimapShapes and bounds) rather than guessed. Framings that
 * point at empty ground make a visual review worthless, so these are checked
 * against the real geometry - see the layout dump in tools/world-layout.json.
 */
const VIEWS = {
  /* The hub plaza is a r40 circle at the origin; portals sit at z = -54
   * (medieval) and z = +54 (sports); the hub deck is r200 inside a hull at 202.
   *
   * Beyond that the station is four more decks of the same size, each on the
   * end of a 96 m link off avenue 120 / 180 / 240 / 300, all under one 720 m
   * dome. Zone centres are at radius 498 on those bearings:
   *
   *     habitation  (-249,  431)      gym          (-498,   0)
   *     construction(-249, -431)      canteen      ( 249, -431)
   *
   * Each zone has an open court inside r112 and a covered arcade out to its
   * rim, so the two useful framings per zone are one from the arrival plaza
   * looking in across the court, and one inside the arcade. */
  station: [
    { name: 'plaza-wide', pos: [0, 9, 96], look: [0, 5, 0], fov: 70 },
    { name: 'plaza-centre', pos: [0, 3, 34], look: [0, 5, -30], fov: 74 },
    { name: 'portal-medieval', pos: [0, 4, -30], look: [0, 5.5, -54], fov: 60 },
    { name: 'portal-sports', pos: [0, 4, 30], look: [0, 5.5, 54], fov: 60 },
    { name: 'street-level', pos: [-34, 1.7, 2], look: [0, 4, 0], fov: 75 },
    { name: 'district-east', pos: [104, 4, 40], look: [60, 8, -10], fov: 72 },
    { name: 'hull-outward', pos: [70, 10, 0], look: [190, 30, 0], fov: 80 },
    // The apron, seen through the great window - the view the whole outer ring
    // was arranged around.
    { name: 'window-apron', pos: [150, 6, 0], look: [520, 40, 40], fov: 82 },
    { name: 'apron-wide', pos: [300, 60, 60], look: [0, 30, 0], fov: 80 },
    // Looking back at the hub from outside it, under the dome.
    { name: 'dome-inside', pos: [-360, 40, 0], look: [0, 60, 0], fov: 84 },
    // The habitat stacks on avenue 120, which are now enterable.
    { name: 'hab-stacks', pos: [-70, 6, 96], look: [-110, 20, 150], fov: 74 },
    { name: 'hab-lobby', pos: [-61, 2.0, 118], look: [-75, 3, 132], fov: 78 },
    // One link, from the hull end looking out to the zone.
    { name: 'link-galley', pos: [110, 3, -186], look: [160, 5, -272], fov: 76 },
    // The four zones: arrival, then court.
    { name: 'zone-habitation', pos: [-206, 8, 358], look: [-249, 14, 431], fov: 76 },
    { name: 'zone-habitation-court', pos: [-249, 4, 505], look: [-249, 30, 431], fov: 80 },
    { name: 'zone-gym', pos: [-414, 8, 0], look: [-498, 12, 0], fov: 76 },
    { name: 'zone-gym-court', pos: [-425, 3, 40], look: [-498, 10, -10], fov: 80 },
    { name: 'zone-construction', pos: [-206, 8, -358], look: [-249, 30, -431], fov: 76 },
    { name: 'zone-construction-court', pos: [-190, 6, -470], look: [-260, 40, -430], fov: 80 },
    { name: 'zone-canteen', pos: [206, 8, -358], look: [249, 12, -431], fov: 76 },
    { name: 'zone-canteen-court', pos: [300, 4, -470], look: [240, 12, -420], fov: 80 },
  ],
  // Castle occupies x -130..-14, z -109..-7 (centre -72,-58); village clusters
  // around (34,18); portal back to the station at (2, 9.3, -22).
  medieval: [
    { name: 'castle-approach', pos: [-40, 12, 55], look: [-72, 20, -45], fov: 70 },
    { name: 'castle-gate', pos: [-72, 8, 15], look: [-72, 16, -40], fov: 68 },
    { name: 'village-square', pos: [58, 5, 48], look: [28, 4, 12], fov: 74 },
    { name: 'village-street', pos: [20, 2.2, 40], look: [36, 3.5, 14], fov: 76 },
    { name: 'ramparts-vista', pos: [-72, 32, -58], look: [34, 6, 20], fov: 78 },
    { name: 'portal', pos: [2, 11, 6], look: [2, 10.5, -22], fov: 62 },
    { name: 'hills-vista', pos: [120, 28, 118], look: [-40, 12, -20], fov: 80 },
  ],
  // Skate park centre (-75, 38) with bowls at (-95,40) r13 and (-77,34) r10;
  // ski zone centre (-62,-136); courts at (112,26) and (78,21)/(78,32);
  // track (128,162); pool (46,111); entrance portal at (0, 0.4, 150).
  sports: [
    { name: 'skatepark-wide', pos: [-40, 11, 96], look: [-82, 0, 38], fov: 72 },
    { name: 'skatepark-bowl', pos: [-95, 5, 66], look: [-95, -3, 38], fov: 74 },
    { name: 'bowl-interior', pos: [-95, 1.6, 50], look: [-88, 1, 24], fov: 80 },
    { name: 'ski-slope', pos: [-62, 18, -45], look: [-62, 34, -150], fov: 74 },
    { name: 'courts', pos: [95, 9, 74], look: [104, 1, 26], fov: 70 },
    { name: 'track', pos: [128, 16, 232], look: [128, 2, 162], fov: 74 },
    { name: 'pool', pos: [46, 7, 142], look: [46, 0, 111], fov: 72 },
    { name: 'entrance-portal', pos: [0, 3.5, 170], look: [0, 2.5, 150], fov: 64 },
  ],
  /**
   * LODESTAR YARD, and every hull row is DERIVED rather than typed.
   *
   * The berths moved onto the piers and this table did not follow them. Raycast
   * against the real built world, the framings that survived were pointing at:
   *
   *   kestrel-in  nearest surface 38.4 m   (it claims to be inside a cabin)
   *   dray-hold                   52.2 m   (inside a 6 m hold)
   *   pike-in                     52.4 m   (inside a cabin)
   *   kestrel/dray/pike     10.8/13.9/8.8  (yard structure; hulls 120-165 m away)
   *   berth-b1/berth-b2      14.8/17.1 m   (the berths are ~170 m away)
   *   blast-door                  26.3 m   (a door that no longer exists)
   *
   * An "interior" framing whose nearest surface is 38-52 m out is standing in
   * open air, and eight of twenty-five rows of the reported luminance table
   * were therefore measuring the empty shop floor. `harness-measurement` passed
   * throughout, because nothing asserted that a framing looked AT anything.
   *
   * So the hull rows are computed from `YardPlan.BERTHS` and `HullPlan.HULLS`
   * by `berthViews` below, which cannot drift when a berth moves, and
   * `harness-framings.test.mjs` now fires a ray down every framing in this file
   * and fails when the first thing it meets is further away than the framing's
   * own declared `subject` distance.
   *
   * Fixed geometry, for the rows that are still hand-placed: floor x +/-86,
   * z -104..+58 under a roof plate at 26; the mouth is the whole north wall at
   * z -104, 164 m wide and 23.6 m tall; five piers run out from it on x -68,
   * -34, 0, +34, +68 to pad centres at z -143..-165; the gateway home is at
   * (0, 0.3, +52) with rotationY PI so the arrival stands at z 49.4; catwalk at
   * 8.0 (inner edge x +/-83.6), crane cab at (-70, 15.4, -24), trench floor at
   * -2.2 under the keel line.
   */
  dock: [
    // The first frame a player ever sees of this world, taken from the exact
    // point `arrivalFor` puts them. If this framing is not legible, nothing
    // else in the yard gets looked at.
    { name: 'apron-arrival', pos: [0, 1.7, 49.4], look: [0, 6, -70], fov: 78, clear: 260 },
    { name: 'keel-line', pos: [0, 1.7, 18], look: [0, 4, -95], fov: 76, clear: 230 },
    { name: 'datum', pos: [5.5, 1.7, 7], look: [0, 0.1, 0], fov: 68, subject: 14 },
    { name: 'chandlery', pos: [0, 1.7, 27], look: [-9.5, 1.2, 20], fov: 76, subject: 14 },
    { name: 'office-door', pos: [-48, 1.7, 40], look: [-58, 1.6, 40], fov: 74, subject: 16 },
    { name: 'office-inside', pos: [-55.5, 1.7, 40], look: [-62, 1.4, 41], fov: 82, subject: 12 },
    // The trench: the only place in the yard you cannot see the roof from.
    { name: 'trench', pos: [0, -0.7, -14], look: [0, -1.3, -62], fov: 80, subject: 60 },
    { name: 'gantry-port', pos: [-84.8, 9.6, 24], look: [-84.8, 8.6, -70], fov: 78, subject: 120 },
    { name: 'gantry-crossing', pos: [0, 9.6, 12], look: [0, 4, -70], fov: 82, subject: 120 },
    { name: 'crane-cab', pos: [-69, 16.8, -24], look: [10, 5, -40], fov: 84, aerial: true, subject: 110 },
    { name: 'signal-post', pos: [26, 12.6, -97], look: [0, 6, -60], fov: 80, aerial: true, subject: 70 },
    { name: 'yard-wide', pos: [62, 19, 44], look: [-16, 6, -64], fov: 84, aerial: true, subject: 150 },
    /* The mouth and the piers: the three framings that answer the brief -
     * "a hangar bay with space piers stretching from the hangar into space, at
     * the end of each pier is a spaceship". `blast-door` used to stand here and
     * the door it framed has been deleted. */
    { name: 'mouth-inside', pos: [0, 3.4, -60], look: [0, 11, -210], fov: 82, clear: 300 },
    { name: 'berth-zero-walk', pos: [0, 1.7, -128], look: [0, 0.4, -176], fov: 76, subject: 55 },
    { name: 'mouth-from-space', pos: [0, 16, -226], look: [0, 9, -70], fov: 80, aerial: true, subject: 220 },
    { name: 'pier-one', pos: [-68, 1.7, -112], look: [-68, 4, -150], fov: 78, subject: 50 },
    /* The hulls, derived from the berths. Two framings each and the reason is
     * the same one every time: a ship in this world is a silhouette from the
     * pier and a set of rooms from inside, and neither picture says anything
     * about the other. The `-in` framings are also where the second half of the
     * interior light measurement is taken - mean frame luma needs a real
     * renderer, so `dock-hulls.test.mjs` asserts the declared illuminance and
     * this is where the pixels come from. */
    ...DOCK_HULL_VIEWS,
    { name: 'bastion-ribs', pos: [30, 2.4, -88], look: [44, 4.0, -95], fov: 82, subject: 22 },
    { name: 'bastion-crown', pos: [26, 12.5, -50], look: [40, 9.6, -70], fov: 80, aerial: true, subject: 34 },
  ],
  /**
   * OPEN SPACE, and it is 800 km of volume rather than the 60 m platform this
   * table used to describe. Its comment named a platform, a starfield on a
   * 1,400 m shell and a portal at (0, 0.3, +22), none of which exist.
   *
   * Everything distant out here is placed by `space/Backdrop.js` RELATIVE TO
   * THE CAMERA every frame, so a framing cannot aim at a body's true
   * coordinates - it has to aim along the body's BEARING, which is what the
   * generated rows do. The bearings are recomputed from `space/Bodies.js` here
   * rather than copied, so a body that moves takes its framing with it.
   *
   * The yard is the one thing with a fixed place: it is at the origin with its
   * mouth at (0, 0, -18), and the return portal stands at (0, 0.3, -24).
   * `subject: Infinity` on the bearing rows says they are aimed at the
   * backdrop, which is the one case the framing probe must not fail.
   */
  space: [
    /* `subject: Infinity` on ALL of these, and it is not an excuse. `space`
     * registers no colliders at all - there is nothing to walk on out here, and
     * the yard itself is a `Backdrop` STRUCTURE proxy-placed against the camera
     * every frame, so a ray fired in the true frame would find it in the wrong
     * place even if it were solid. What these framings actually have to get
     * right is their BEARING, and that is asserted directly in
     * `harness-framings.test.mjs` against `space/Bodies.js`. */
    { name: 'arrival', pos: [0, 1.7, -38], look: [0, 3, -18], fov: 78, subject: Infinity },
    { name: 'portal-home', pos: [0, 2.4, -34], look: [0, 3.2, -24], fov: 66, subject: Infinity },
    { name: 'yard-astern', pos: [0, 40, -340], look: [0, 0, 0], fov: 74, aerial: true, subject: Infinity },
    ...SPACE_BEARING_VIEWS,
  ],
  /**
   * CINDER, the volcanic planet - and there was no entry for it at all, so the
   * first landable world in the game had no framings.
   *
   * The playfield is +/-400. Three landing sites: Ashfall Flat (150, 205) r30,
   * Rimhold Shelf (9.4, -185.5) r20 and Colonnade Deck (250, 40) r22. The lava
   * lake is a 25 m disc at (-52, -96) with its surface at y 59.9, feeding a
   * ribbon out to a 42 m pool at (-322, -276) at y 3.
   *
   * `groundRelative` means the `y` in `pos` is a height ABOVE THE SURFACE and
   * the harness resolves it against the built height field. A planet's terrain
   * is generated, so a hard-coded y is a camera underground the first time a
   * landform is retuned.
   */
  cinder: [
    { name: 'pad-ashfall', pos: [150, 2.0, 248], look: [150, 3, 200], fov: 76, groundRelative: true, subject: 60 },
    { name: 'ashfall-outward', pos: [150, 3.0, 205], look: [-40, 60, 20], fov: 82, groundRelative: true, subject: 400 },
    /* From the plain, looking at the massif: the camera is on the Ashfall side
     * at 9 m of ground and the rim is 128 m up 190 m away, which is the shot
     * that shows this world has relief in it. Aimed at the RIM and not at the
     * lake - the lake is inside the crater and a framing pointed at it from
     * out here is a framing pointed at the ground in front of the camera. */
    { name: 'caldera', pos: [150, 3.0, 120], look: [0, 128, 0], fov: 78, groundRelative: true, subject: 220 },
    { name: 'lava-shore', pos: [-52, 3.0, -46], look: [-52, 58, -96], fov: 76, groundRelative: true, subject: 70 },
    { name: 'rimhold', pos: [9.4, 3.0, -142], look: [9.4, 3, -186], fov: 76, groundRelative: true, subject: 55 },
    { name: 'aerial', pos: [180, 190, 260], look: [-60, 40, -80], fov: 84, aerial: true, subject: 500 },
  ],
  // Entrance forecourt centred at (1260, -10); maze grid runs from origin to 2394 m
  // on both axes; hedges 5 m tall. Levels are 9 m apart: level 0 at y=0, level 3 at y=27.
  //
  // The player spawns at a fixed entrance (district dx:10, dz:0, x=1260) and
  // residency only ever covers the districts within RESIDENCY_RADIUS (2, so
  // roughly +-240m) of wherever the player actually is - see MazeWorld.js. A
  // framing computed from anywhere else, or that moves only the camera and
  // not the player, shows geometry that was never streamed: an empty void
  // for shaft-up, bare sky for tower-top. Both views below are computed
  // dynamically per view() call, scanning ONLY the districts the maze world
  // has actually streamed in - see Harness._findResidentShaft.
  maze: [
    { name: 'forecourt', pos: [1260, 4, -16], look: [1260, 2, 20], fov: 75 },
    { name: 'corridor', pos: [1260, 1.7, 40], look: [1260, 1.7, 120], fov: 75 },
    /* keepPlayer: this one deliberately looks DOWN on level 0 from 60 m up.
     * Moving the player with the camera - which every other framing now does,
     * so the sun's shadow camera covers what is on screen - would put them at
     * level 6, and `MazeWorld` streams residency around the player: the maze
     * this view exists to show would unload out from under it. */
    { name: 'above-entrance', pos: [1260, 60, -40], look: [1260, 0, 200], fov: 70, keepPlayer: true },
    { name: 'shaft-up', computed: true },
    { name: 'lift-car', computed: true },
    { name: 'tower-top', computed: true },
  ],
  /* Sunspire Citadel, read off the built world rather than off the docstring.
   *
   * The mesa top is a flat plateau at y = 14 out to r = 132, falling to the
   * desert over a 46 m shoulder; the playfield is +-200. On it, from the
   * outside in:
   *
   *   curtain wall  r = 118, walk top y = 23, gate opening on +Z
   *   gatehouse     (0, 118), arch clear at x = 0, lintel top y = 28
   *   corner towers r = 118, eight of them, tops y = 32.2
   *   souk          seven rings at r = 34.0 / 47.1 / 59.6 / 71.2 / 82.3 /
   *                 92.9 / 103.0; roof decks y 20.5-20.7 (ring 6) up to
   *                 27.3-29.1 (ring 0)
   *   inner ward    a 60 m square slab, top y = 20
   *   keep          (0, -4), roof y = 41.4
   *   minarets      (+-14.85, +-14.85), tops y = 51.5, rope bridges between
   *                 them at y ~ 50.9, plus two 99-102 m perimeter spans out to
   *                 wall towers and their two short landfalls into the souk
   *   great tower   (0, -18), crown y = 67.6, launch beam jutting to z = -9.8
   *   player spawn  (0, 14.3, 104), yaw 0 - facing the town
   *
   * `_buildSouk` deletes every building within 0.26 rad of the gate bearing at
   * every ring, so the +Z axis is an open processional corridor from the gate
   * all the way to the ward stair. That is why three framings here sit on x = 0:
   * it is the one line through this town that is clear by construction rather
   * than by luck of the generator's PRNG.
   *
   * Every framing below was checked against the world as actually built - the
   * same headless build `scripts/tests/npc-routes.test.mjs` does, then
   * `physics.containsPoint` for the camera, `physics.groundHeight` under it,
   * and a `physics.raycast` down the view axis, and RE-checked against the
   * present build rather than inherited.
   *
   * Two candidates were once thrown out here for reasons that are no longer
   * true, and both are recorded because the repairs are worth knowing about:
   * a rampart-walk framing, because the curtain wall used to be a rosette
   * (segments rotated `mid + PI/2` in a frame where `makeRotationY(t)` puts
   * local +X at bearing `-t`, so they stood radially everywhere but the four
   * cardinals); and a haystack framing under the great tower, because every
   * viewpoint haystack was placed off `_groundAt` - pure terrain - and sat at
   * y 16.4-18.8 inside the ward slab, solid from 14 to 20. Both were fixed in
   * Drop Two: the wall rotation is `PI/2 - mid` and 354 of 360 bearings at
   * r = 118 now read stone (the six are the gate), and the haystacks are
   * placed off `_deckAt` and stand at y 22.4 on the ward. A rampart framing
   * and a hay framing are both available now; neither has been added, because
   * neither has been composed and measured, and an unmeasured framing is the
   * thing this comment block exists to prevent. */
  citadel: [
    // Outside the wall on the approach, looking through the gate arch. The
    // camera stands on a cliff-ring step: deck 14.22 at (0, 136).
    { name: 'gate-approach', pos: [0, 15.84, 136], look: [0, 22, 118], fov: 72 },
    // The player's own spawn eye, framing what this world opens on: the souk
    // stepping up ring by ring, the keep, and the great tower above it. The
    // keep occludes the tower below y ~ 43; everything above that is in shot.
    { name: 'gate-spawn', pos: [0, 15.92, 104], look: [0, 34, -14], fov: 74 },
    /* A real alley, found by probing rather than by picking a radius, and
     * RE-probed against the re-authored rings.
     *
     * The old framing stood at (112, 1.6). The souk's outermost ring is r =
     * 103.0 now, so r = 112 is open pomerium: the camera stood on bare terrain
     * at deck 14.00 and the view ray hit the town's outer face at 12.3 m of a
     * nominal 28.4 - a photograph of a wall, captioned as a street.
     *
     * This is the ring-5/ring-6 street at r = 97.95, walked from bearing 24 deg
     * to 41.2 deg: 29.3 m of unbroken line of sight at eye height (deck 14.00
     * plus 1.62), 2.9 m between the two rings' faces at the far end and opening
     * into a junction at the near one. Souk geometry is generated, so a
     * hand-picked "alley" coordinate is a coin flip; this one is measured. */
    { name: 'souk-alley', pos: [89.48, 15.62, 39.84], look: [73.7, 16.2, 64.52], fov: 78, clear: 29.2 },
    /* Standing on a real ring-5 roof deck, looking in across four more rings of
     * roofs to the tower.
     *
     * Also re-probed: ring 5's deck is y 21.31 now, not the 24.21 this comment
     * used to claim, and the old camera at y 25.80 floated 4.49 m over it. The
     * point below is that roof's `anchor` - the standing spot `_deckSpot`
     * resolved off the dome in its middle - with the camera 1.62 m above a
     * 9.7 x 7.1 m footprint. The clear line still holds: the first thing this
     * ray meets is the tower's own face, at 99.1 m of 106.1. */
    { name: 'souk-roofs', pos: [83.63, 22.93, 40.45], look: [0, 52, -18], fov: 76, clear: 99.0 },
    /* The inner ward. Its geometric centre is inside the keep, so this stands
     * on the ward deck at the head of the souk stair and looks across it: keep
     * facade, the two near minarets, and the great tower crown clear above the
     * keep's 41.4 m roof line. The ward's four corners are NOT open - ring 0
     * of the souk is at r = 34 and the 60 m square reaches r = 42 at the
     * diagonal, so houses stand on the slab there. */
    { name: 'ward-centre', pos: [0, 21.7, 28], look: [0, 40, -6], fov: 78 },
    /* The rope bridges. Square on to the +Z minaret span, minarets flanking,
     * tower behind; the ray from here to the middle of that span is clear over
     * all 31.8 m of it.
     *
     * This used to say the four minaret loops were "the only spans that got
     * built", because the perimeter span computes to 99.0 m against
     * `_buildRopeBridges`' own `span > 90` reject. The reject is 132 now and
     * the world builds eight spans: four 29.7 m loops, a 98.9 m minaret
     * perimeter and a 101.6 m great-tower perimeter out to wall towers at
     * r = 118, and their two ~11.8 m landfalls down into the outer souk ring.
     * The two long ones are what put the whole rooftop network on one
     * component; they are 35 m over the mesa and want a framing of their own,
     * which is a measurement nobody has taken yet. */
    { name: 'minaret-bridge', pos: [0, 56, 46], look: [0, 49.6, 14.85], fov: 70, aerial: true },
    { name: 'tower-top', computed: true },
    /* The mesa from outside it. Placed at bearing -40 deg, about 78 deg off
     * the sun's own bearing (`sunDirection` (0.55, 0.42, 0.72) -> 37.4 deg),
     * so the town is cross-lit and every ledge casts the line this world was
     * built to be read by. 231 m out, inside the +-200 heightfield on both
     * axes, so nothing beyond the mesh edge is in shot. */
    { name: 'desert-overview', pos: [-150, 76, 176], look: [0, 46, -10], fov: 74, aerial: true },
  ],
};

class Harness {
  constructor(game) {
    this.game = game;
    this.savedFov = game.engine.camera.fov;
    this._detach = null;
    this.hudHidden = false;
    /** Null when nothing is stubbed. `freezeAll` reads this to stay idempotent. */
    this._stubs = null;
    this._awakeHeld = false;
    this._realSetPaused = null;
    /** {pos, yaw} the player is re-asserted to every step, or null. */
    this._pin = null;
    this._pinDetach = null;
  }

  /**
   * Resolve once the first world is active and a few frames have rendered.
   *
   * `drive` defaults TRUE, and that default is the whole point: without it the
   * pointer-lock loss that every automated session suffers leaves the gameplay
   * update block switched off, which silently disables all LOD. Measuring that
   * and calling it a frame cost is the exact mistake this harness exists to
   * stop. Pass `{ drive: false }` if you specifically want the frozen game.
   *
   * @param {{ timeoutMs?: number, drive?: boolean }|number} [opts] a number is
   *   read as `timeoutMs`, which is how this used to be called.
   */
  async ready(opts = {}) {
    const { timeoutMs = 120000, drive = true } = typeof opts === 'number' ? { timeoutMs: opts } : opts;
    const t0 = performance.now();
    while (!this.game.worldManager.active) {
      if (performance.now() - t0 > timeoutMs) throw new Error('harness: world never activated');
      await frame();
    }
    this.setGameplayDriven(drive);
    for (let i = 0; i < 3; i++) await frame();
    return this.game.worldManager.active.id;
  }

  /**
   * Run the game as if it were being played, without a pointer lock.
   *
   * THE FAILURE THIS FIXES. `main.js` blocks its whole gameplay update block -
   * `cameraRig/avatar/mounts/npcManager/projectiles/loadout/portals/combat`
   * update AND `worldManager.active.update()` - whenever the pointer lock is
   * lost, and an automated browser either never gets the lock or drops it the
   * instant the window is backgrounded. The game keeps rendering, so nothing
   * looks wrong; what stops is `NPCManager._updateLOD` (every NPC pinned at
   * `distance: 0, detail: true, rate: 1` at any range - measured with a
   * character 951 m away) and every world's per-frame LOD banding. Draw-call
   * and triangle figures taken in that state are the LOD-disabled worst case.
   *
   * This does not hand-call a subset of the updaters - that list would drift
   * out of date the first time someone added a system. It clears the one
   * 'standby' block that `main.js` puts up, so the real loop runs the real
   * code path. Reversible, and reported by `stats().gameplayDriven`.
   *
   * @param {boolean} [on]
   * @returns {boolean} the state now in force
   */
  setGameplayDriven(on = true) {
    const dev = this.game.__dev;
    if (!dev?.setGameplayDriven) {
      // Only possible against a main.js without the hook. Say so loudly rather
      // than let a caller believe gameplay is running.
      console.error(
        '[harness] GAME.__dev.setGameplayDriven is missing - gameplay CANNOT be driven, ' +
        'and every LOD-dependent number from this page is the LOD-disabled worst case.'
      );
      return false;
    }
    const state = dev.setGameplayDriven(on);
    console.info(
      `[harness] gameplayDriven = ${state}` +
      (state ? '' : ' - LOD is NOT running; stats() figures are the worst case')
    );
    return state;
  }

  /** @returns {boolean} is the real gameplay update block running? */
  get gameplayDriven() {
    return this.game.__dev?.isGameplayDriven?.() ?? false;
  }

  /** Switch worlds without the portal transition. */
  async goto(worldId) {
    if (!this.game.worldManager.isBuilt?.(worldId)) {
      await this.game.worldManager.build(worldId);
    }
    await this.game.worldManager.activate(worldId);
    for (let i = 0; i < 4; i++) await frame();
    return worldId;
  }

  viewNames(worldId) {
    return (VIEWS[worldId] ?? []).map((v) => v.name);
  }

  /**
   * Park the camera at a named preset. Detaches the player controller so the
   * camera does not get overwritten on the next frame, and - unless the view
   * or the caller says otherwise - takes the player along. See `_vantage`.
   *
   * @param {string|number} name
   * @param {{ settle?: number, movePlayer?: boolean }|number} [opts] a number is
   *   read as `settle`, which is how this used to be called.
   */
  async view(name, opts = {}) {
    const worldId = this.game.worldManager.active?.id;
    const list = VIEWS[worldId] ?? [];
    const v = typeof name === 'number' ? list[name] : list.find((x) => x.name === name);
    if (!v) throw new Error(`harness: no view "${name}" in world "${worldId}"`);
    const o = typeof opts === 'number' ? { settle: opts } : opts;

    this.freezeCamera(true);

    // Handle dynamically computed views (e.g., shaft-up, tower-top). Awaited:
    // tower-top's computation teleports the player and waits for residency
    // and the canopy to follow before it can report where to look.
    let spec = v;
    if (v.computed) {
      const computed = await this._computeView(v.name, worldId);
      if (!computed) throw new Error(`harness: could not compute view "${name}"`);
      spec = computed;
    }
    /* `groundRelative` resolves `pos[1]` against the real surface under it.
     * A planet's terrain is GENERATED, so a framing with a hard-coded y is a
     * camera buried in a lava flow the first time a landform is retuned - and
     * a buried camera renders black, which reads as a lighting bug. Only the
     * camera's own height is resolved; `look` is left alone, because these
     * framings aim at things (a caldera rim, a lava lake) whose height is the
     * point of the shot. */
    if (spec.groundRelative) {
      const g = this.game.physics?.groundHeight?.(spec.pos[0], spec.pos[2], spec.pos[1] + 400, 900);
      if (g !== null && g !== undefined && Number.isFinite(g)) {
        spec = { ...spec, pos: [spec.pos[0], g + spec.pos[1], spec.pos[2]] };
      }
    }

    /* `keepPlayer` is a property of the FRAMING, not of the caller: a view that
     * placed the player itself (tower-top) or that depends on the player being
     * somewhere else (above-entrance, for maze residency) must not have that
     * undone. An explicit `movePlayer` from the caller still wins. */
    const movePlayer = o.movePlayer ?? !spec.keepPlayer;
    const moved = await this._vantage(spec.pos, spec.look, spec.fov, {
      movePlayer,
      settle: o.settle ?? 6,
    });
    return { world: worldId, view: v.name, playerMoved: moved };
  }

  /**
   * Place the camera, and by default the player with it.
   *
   * WHY THE PLAYER MOVES TOO. There is exactly one live shadow-casting light
   * (`sun`, in main.js) and its shadow camera is fitted around the PLAYER, not
   * around the render camera - a 120 m box centred on wherever the player is
   * standing. Moving only the camera therefore renders the new vantage while
   * the shadow map covers an empty slab back at spawn: the characters in shot
   * cast nothing, and the shot's character-shadow cost measures as a couple of
   * draws instead of a few hundred. That is not a saving, it is a hole in the
   * measurement, and it produced a whole afternoon of confident wrong numbers.
   *
   * The player is PINNED here rather than merely teleported: with gameplay
   * driven (as it now is by default) an aerial vantage would otherwise have the
   * player fall out of it over the next second, dragging the shadow camera down
   * with them and quietly changing the answer mid-measurement.
   *
   * @returns {Promise<boolean>} whether the player was moved
   */
  async _vantage(pos, look, fov, { movePlayer = true, settle = 6 } = {}) {
    this.freezeCamera(true);
    const cam = this.game.engine.camera;

    if (movePlayer && this.game.player) {
      // Feet under the eye, so "the player is at this vantage" means the same
      // thing it means in play: their eyeline is the camera.
      const eye = this.game.CONFIG?.player?.eyeHeight ?? 1.62;
      const yaw = Math.atan2(-(look[0] - pos[0]), -(look[2] - pos[2]));
      this.pinPlayer([pos[0], pos[1] - eye, pos[2]], yaw);
    }

    cam.position.set(pos[0], pos[1], pos[2]);
    cam.lookAt(look[0], look[1], look[2]);
    cam.fov = fov;
    cam.updateProjectionMatrix();

    // Let temporal effects (AO, grain, adaptive resolution) settle before capture.
    for (let i = 0; i < settle; i++) await frame();
    // The pin re-asserts the player every step, but `teleport` inside it also
    // writes the camera on the frames before `_harnessFrozen` is honoured, so
    // the framing is restated after the settle rather than trusted to survive.
    cam.position.set(pos[0], pos[1], pos[2]);
    cam.lookAt(look[0], look[1], look[2]);
    return movePlayer && !!this.game.player;
  }

  /**
   * Hold the player at a fixed spot for the duration of a measurement.
   *
   * Re-asserted on the fixed step because gravity integrates there: a single
   * teleport to an aerial vantage lasts about a second before the player is
   * back on the ground and the sun's shadow camera has followed them down.
   *
   * @param {number[]|null} pos world position of the player's FEET, or null to release
   * @param {number} [yaw]
   */
  pinPlayer(pos, yaw = 0) {
    const player = this.game.player;
    if (!player) return null;
    if (!pos) {
      this._pinDetach?.();
      this._pinDetach = null;
      this._pin = null;
      if (this.game.avatar) this.game.avatar.harnessShadowOnly = false;
      return null;
    }
    this._pin = { pos: [...pos], yaw, v: new this.game.THREE.Vector3(pos[0], pos[1], pos[2]) };
    // The body is standing in the lens once the player is at the camera, and
    // the harness's camera detach normally forces it visible - see
    // PlayerAvatar's `harnessShadowOnly`. Keep its shadow, drop the mannequin.
    if (this.game.avatar) this.game.avatar.harnessShadowOnly = true;
    /* Reads `this._pin` rather than closing over the position: re-pinning to a
     * new vantage reuses the already-registered updaters, and a closure over
     * the FIRST position would quietly drag the player back to it. */
    const reassert = () => {
      const p = this._pin;
      // `anchor: false` so a measurement vantage never becomes the respawn point.
      if (p) player.teleport(p.v, p.yaw, { anchor: false });
    };
    reassert();
    if (!this._pinDetach) {
      const offFixed = this.game.engine.onFixedUpdate(reassert);
      const offFrame = this.game.engine.onFrameUpdate(reassert);
      this._pinDetach = () => { offFixed(); offFrame(); };
    }
    return { pos: this._pin.pos, yaw: this._pin.yaw };
  }

  /** Release a pinned player. */
  unpinPlayer() {
    return this.pinPlayer(null);
  }

  /**
   * Find a cell carrying DIR.UP inside a district the maze world has
   * actually streamed in - never the whole 400x400 grid.
   *
   * The previous version of this scan started from (0,0) and returned
   * whichever UP cell it met first, with no regard for whether anything was
   * ever built there. The player spawns at a fixed entrance (district
   * dx:10, dz:0, world x=1260) and `MazeWorld` only ever keeps districts
   * within `RESIDENCY_RADIUS` (2 districts, ~240m) of the player resident -
   * see MazeWorld.js. A shaft found by scanning from the origin is
   * overwhelmingly likely to sit in a district nobody streamed, so the
   * "shaft-up" view used to frame empty void: not an error, just wrong,
   * which is worse for a review instrument that is supposed to catch wrong
   * things. Scanning only `w.chunks.residentKeys()` instead guarantees
   * whatever this finds is actually built.
   *
   * @param {number|null} [level] restrict the search to one level, or search
   *   every resident district regardless of level.
   * @returns {{x:number, z:number, level:number}|null}
   */
  _findResidentShaft(level = null, kind = null) {
    const w = this.game.worldManager.active;
    if (w?.id !== 'maze' || !w.cells || !w.chunks) return null;

    const D = MAZE.DISTRICT;
    for (const key of w.chunks.residentKeys()) {
      const d = districtCoords(key);
      if (level !== null && d.level !== level) continue;
      const x0 = d.dx * D, z0 = d.dz * D;
      for (let lz = 0; lz < D; lz++) {
        for (let lx = 0; lx < D; lx++) {
          const x = x0 + lx, z = z0 + lz;
          const idx = cellIndex(x, z, d.level);
          if (!isOpen(w.cells, idx, DIR.UP)) continue;
          /* Phase 2c: optionally hold out for a particular connector. Which
           * shape a link becomes is the topology array's decision, and a
           * tunnel whose fold would sever a crossing falls back to a
           * staircase - so a caller after a REAL tunnel has to check what was
           * emitted, not just what was chosen. */
          if (kind) {
            const descs = shaftColliders(w.cells, x, z, d.level);
            const emitted = descs.some((k) => k.kind === 'tunnel') ? 'tunnel'
              : descs.some((k) => k.kind === 'lift') ? 'lift' : 'stair';
            if (emitted !== kind) continue;
          }
          return { x, z, level: d.level };
        }
      }
    }
    return null;
  }

  /**
   * Frame a real, resident LIFT - the car in its shaft, seen from the level-N
   * doorway it is entered through.
   *
   * Held to the same rule the shaft view had to learn: scan only resident
   * districts and check what was actually EMITTED, so this cannot frame a
   * lift that was never built or a district nobody streamed.
   *
   * @returns {{pos:number[], look:number[], fov:number}|null}
   */
  _findLiftFraming() {
    const lift = this._findResidentShaft(null, 'lift');
    if (!lift) return null;
    const world = this.game.worldManager.active;
    const w = cellToWorld(lift.x, lift.z, lift.level);
    const idx = cellIndex(lift.x, lift.z, lift.level);

    /* Stand in the corridor the shaft actually OPENS onto, derived from the
     * topology. Placing the camera at a fixed diagonal offset put it inside a
     * hedge - the same mistake 2b's ledger records the shaft view making, and
     * a review instrument that frames the wrong thing is worse than none.
     * A shaft always has at least one open side; that is how anyone gets in. */
    const sides = [
      { dir: DIR.N, dx: 0, dz: -1 }, { dir: DIR.E, dx: 1, dz: 0 },
      { dir: DIR.S, dx: 0, dz: 1 }, { dir: DIR.W, dx: -1, dz: 0 },
    ].filter((sd) => isOpen(world.cells, idx, sd.dir));
    if (sides.length === 0) return null;
    const s = sides[0];

    /* Just under a cell out, so the camera stands in the open corridor rather
     * than in the doorway itself, at eye height, looking at the car and the
     * landing above it. The well sits in the +x/+z quadrant of the cell. */
    const pos = [w.x + s.dx * MAZE.CELL * 0.9, w.y + 1.6, w.z + s.dz * MAZE.CELL * 0.9];
    const look = [w.x + 0.9, w.y + MAZE.LEVEL_HEIGHT * 0.35, w.z + 0.9];
    return { pos, look, fov: 75 };
  }

  /**
   * Find a resident staircase cell and compute the shaft-up camera framing.
   * Returns { pos, look, fov } or null if no resident shaft is found.
   */
  _findShaftFraming() {
    const shaft = this._findResidentShaft();
    if (!shaft) return null;

    // cellToWorld already returns the cell's own CENTRE (see its docstring) -
    // not a corner to be offset by another half-cell, which is what this used
    // to do by hand (`x * MAZE.CELL + MAZE.CELL / 2`) and which put every
    // computed view a half-cell off the shaft it meant to frame.
    const w = cellToWorld(shaft.x, shaft.z, shaft.level);

    // The OPENING's centre, not the cell's. `stairWellBounds` offsets the well
    // into the cell's +x/+z quadrant, so a camera on the cell centre looking
    // straight up frames the solid slab beside the hole - the very assumption
    // that had the daylight columns lighting stone until connectorHoleBounds
    // replaced it there, surviving here in the dev camera. Asked per KIND,
    // because a lift's well and a tunnel's exit sit elsewhere in the cell
    // again, and this helper serves all three.
    const world = this.game?.worldManager?.active;
    const hole = world?.cells
      ? connectorHoleBounds(world.cells, shaft.x, shaft.z, shaft.level)
      : null;
    const cx = hole?.cx ?? w.x;
    const cz = hole?.cz ?? w.z;

    // Camera low inside the shaft, looking up past the next level.
    const pos = [cx, w.y + 0.8, cz];
    const look = [cx, w.y + MAZE.LEVEL_HEIGHT * 2, cz];
    return { pos, look, fov: 75 };
  }

  /**
   * Find a resident shaft, teleport the player onto its landing at level
   * N+1, and frame the canopy from above it.
   *
   * `tower-top` used to move only the camera, to a fixed point nowhere near
   * where the player (and therefore residency and the canopy - both driven
   * off `player.position` in `MazeWorld.update`) actually were. The camera
   * looked out over whatever level the player last stood on, which streams
   * nothing at that height and reads as bare sky. Teleporting the player is
   * what makes residency and the canopy follow to the level this view is
   * meant to show - the same fix shape as `_findShaftFraming`, applied to
   * the half of the state a camera move alone cannot reach.
   *
   * @returns {Promise<{pos:number[], look:number[], fov:number}|null>}
   */
  async _computeTowerTop() {
    // Search from wherever the player currently is (a cold load's resident
    // set, centred on the fixed entrance) rather than the destination level -
    // nothing is resident up there yet to search.
    const shaft = this._findResidentShaft(0);
    if (!shaft) return null;

    const w = cellToWorld(shaft.x, shaft.z, shaft.level);
    const landingY = w.y + MAZE.LEVEL_HEIGHT;

    // NOT the cell's own centre. `MazeColliders.stairWellBounds` offsets the
    // stair well into the cell's +x/+z quadrant (`STAIR_WELL_OFFSET`), and
    // that quadrant reaches back across the cell centre - so a teleport
    // straight to (w.x, w.z) lands the player inside the hole itself, on top
    // of a guard rail rather than on solid floor (measured in-browser: a
    // teleport to the raw centre came to rest at HEDGE_HEIGHT above the floor
    // it should have landed on). The far corner - diagonally opposite the
    // well, the same "free corner" `scripts/tests/maze-enclosure.test.mjs`
    // routes a walking capsule through - is guaranteed floor.
    const cx = w.x - 1.6;
    const cz = w.z - 1.6;

    // Hand control back to the player controller just long enough to move
    // it - mirrors Harness.teleport() - then re-freeze once residency and
    // the canopy have had frames to update at the new position.
    this.unpinPlayer();
    this.freezeCamera(false);
    this.game.player.teleport(new this.game.THREE.Vector3(cx, landingY + 0.1, cz), 0);
    for (let i = 0; i < 8; i++) await frame();
    this.freezeCamera(true);

    // High above the landing, looking down and out across the canopy this
    // level's hedge-tops become once nothing streamed is under the camera.
    const pos = [cx, landingY + 30, cz];
    const look = [cx, landingY, cz];
    /* keepPlayer: this framing IS the player's position - it put them on the
     * landing so residency and the canopy would follow. Letting the generic
     * vantage move them 30 m up to the camera would undo the whole point. */
    return { pos, look, fov: 80, keepPlayer: true };
  }

  /**
   * Frame the Citadel from over its great tower - the world's high anchor.
   *
   * COMPUTED, for a different reason than the maze's views are. Nothing here
   * streams, so this does not have to teleport anyone to make geometry appear;
   * what it cannot do is hard-code the crown. `CitadelWorld` derives the tower
   * top as `MESA_Y + wardH + th + 1.6` and the crown slab as `tw + 2.4` wide,
   * and a literal 67.6 typed into the table above would survive any change to
   * those four numbers by silently putting the camera inside the stone or
   * thirty metres over it - the failure a review instrument is least able to
   * report on itself. So the anchor is taken from the world's own published
   * `viewpoints`, and the crown's back lip is MEASURED off the collision world
   * rather than recomputed from `tw`: the maze's rule, that a computed view
   * checks what was actually emitted rather than what the generator chose.
   *
   * WHY IT LOOKS DOWN FROM ABOVE RATHER THAN STANDING ON THE CROWN. The
   * leap-of-faith beam is proud of the crown deck by 0.55 m and juts 8.5 m out
   * over the +Z lip (both measured). From a standing eye on the crown, any
   * look steeper than about 4.4 deg down is blocked by that beam, so the only
   * shot available from up there is horizon and sky - the town this view
   * exists to show would be entirely below frame. Sixteen metres up puts the
   * crown, the beam, the ward, all seven souk rings and the gate in one frame,
   * which is the same trade `_computeTowerTop` makes in the maze at 30 m.
   *
   * The player is NOT held back: `_vantage` moves them to the vantage as it
   * does for every other framing, which is what drags the sun's 120 m shadow
   * box onto the citadel instead of leaving it at spawn.
   *
   * @returns {{pos:number[], look:number[], fov:number}|null}
   */
  _findGreatTowerFraming() {
    const w = this.game.worldManager.active;
    if (w?.id !== 'citadel') return null;
    const physics = this.game.physics;
    if (!physics) return null;

    /* The world publishes its five viewpoints; the great tower is the high one
     * and the only named anchor this framing wants. Falling back to the
     * tallest entry in `_towers` rather than to a literal keeps this working
     * if the name is ever re-authored, and returning null keeps `view()`
     * throwing a clear error rather than framing sand if both are gone. */
    const vp = (w.viewpoints ?? []).find((v) => v.name === 'The Great Tower')
      ?? (w._towers ?? []).reduce((hi, t) => (!hi || t.y > hi.y ? t : hi), null);
    if (!vp) return null;

    /* Walk back along -Z until the deck stops being the crown. The probe drops
     * only 9 m from just above the crown, so a step that leaves the slab reads
     * as the ward roof 47 m below (or as null) rather than as another storey
     * of the same tower. `< vp.y - 0.35` and not `!== vp.y`: the launch beam
     * and the crown parapet are both a little PROUD of the deck, and a strict
     * equality would stop this walk on the first piece of dressing. */
    const crownAt = (x, z) => physics.groundHeight(x, z, vp.y + 4, 9);
    let back = 0;
    for (let d = 0.5; d <= 14; d += 0.5) {
      const y = crownAt(vp.x, vp.z - d);
      if (y === null || y < vp.y - 0.35) break;
      back = d;
    }

    const RISE = 16;       // above the crown - clears the beam, see above
    const STAND_OFF = 8;   // behind the measured lip, so the crown is in frame
    const REACH = 92;      // horizontal, down the gate axis (+Z)
    const DROP = 44;       // below the camera at that reach -> 25.5 deg down
    const pos = [vp.x, vp.y + RISE, vp.z - back - STAND_OFF];
    const look = [vp.x, vp.y + RISE - DROP, pos[2] + REACH];
    return { pos, look, fov: 80 };
  }

  /**
   * Compute view parameters for dynamically generated views.
   *
   * Dispatched on the world first and the name second: `tower-top` exists in
   * two worlds now and means a different computation in each.
   */
  async _computeView(name, worldId) {
    if (worldId === 'maze') {
      if (name === 'shaft-up') return this._findShaftFraming();
      if (name === 'lift-car') return this._findLiftFraming();
      if (name === 'tower-top') return this._computeTowerTop();
      return null;
    }
    if (worldId === 'citadel') {
      if (name === 'tower-top') return this._findGreatTowerFraming();
      return null;
    }
    return null;
  }

  /**
   * Free-fly to an arbitrary vantage. The player comes too, by default - see
   * `_vantage` for why measuring anything shadow-related without that is a
   * measurement of the wrong slab of world.
   *
   * @param {number[]} pos
   * @param {number[]} target
   * @param {number} [fov]
   * @param {{ settle?: number, movePlayer?: boolean }|number} [opts] a number is
   *   read as `settle`, which is how this used to be called.
   */
  async look(pos, target, fov = 70, opts = {}) {
    const o = typeof opts === 'number' ? { settle: opts } : opts;
    return this._vantage(pos, target, fov, {
      movePlayer: o.movePlayer ?? true,
      settle: o.settle ?? 6,
    });
  }

  /**
   * Freeze absolutely everything that can move a subject out of frame.
   *
   * `engine.setPaused(true)` stops the fixed/frame updaters but a mount keeps
   * driving itself, so framing a rider used to require stubbing the mount's own
   * fixedUpdate by hand. This does that centrally: pause the engine, freeze the
   * camera, and neutralise the active mount and the NPC manager.
   */
  freezeAll(on = true) {
    const G = this.game;
    const mount = G.mounts?.active;

    /* IDEMPOTENT, and it has to be. The second `freezeAll(true)` used to
     * capture the noop the FIRST call had already installed, so the matching
     * `freezeAll(false)` "restored" that noop: `npcManager.fixedUpdate` was
     * dead for the life of the page, no error, no symptom beyond a world where
     * nobody moves. Two calls to freeze is exactly what a measurement script
     * does when a helper freezes and the caller freezes again to be sure. */
    if (on && this._stubs) return { paused: true, mount: mount?.id ?? null, alreadyFrozen: true };

    // Not `engine.setPaused`: `holdAwake` may have replaced that to refuse
    // pauses, and this pause is deliberate.
    (this._realSetPaused ?? G.engine.setPaused.bind(G.engine))(on);
    this.freezeCamera(on);
    if (on) {
      this._stubs = [];
      const stub = (obj, key) => {
        if (!obj || typeof obj[key] !== 'function') return;
        this._stubs.push([obj, key, obj[key]]);
        obj[key] = () => {};
      };
      stub(mount, 'fixedUpdate');
      stub(mount, 'update');
      stub(G.npcManager, 'fixedUpdate');
    } else {
      for (const [obj, key, fn] of this._stubs ?? []) obj[key] = fn;
      this._stubs = null;
    }
    return { paused: on, mount: mount?.id ?? null, alreadyFrozen: false };
  }

  /**
   * Keep the engine running for the duration of a measurement.
   *
   * A stalled frame loop is invisible in the numbers and ruinous to them: the
   * frame updater that aims the sun at the player stops with everything else,
   * so the shadow camera is left stranded tens of metres behind and an
   * ablation that should have shown a shadow saving shows none at all.
   *
   * HONEST LIMIT: this refuses `setPaused(true)` and clears `_paused`, but it
   * cannot conjure animation frames. A backgrounded or fully occluded window
   * gets no `requestAnimationFrame` callbacks at all, and no flag here changes
   * that - `stats().documentHidden` and `stats().rafStalls` are how you find
   * out. Chrome's `--disable-features=CalculateNativeWinOcclusion` and a
   * foreground window are the actual fix.
   */
  holdAwake(on = true) {
    const engine = this.game.engine;
    if (on && !this._awakeHeld) {
      this._realSetPaused = engine.setPaused.bind(engine);
      engine.setPaused = (paused) => {
        if (paused) {
          console.warn('[harness] setPaused(true) refused - holdAwake() is in force');
          return;
        }
        this._realSetPaused(false);
      };
      this._realSetPaused(false);
      this._awakeHeld = true;
    } else if (!on && this._awakeHeld) {
      engine.setPaused = this._realSetPaused;
      this._realSetPaused = null;
      this._awakeHeld = false;
    }
    if (document.hidden) {
      console.warn('[harness] document.hidden is true: no animation frames are being delivered. Bring the window to the front before measuring.');
    }
    return { awakeHeld: this._awakeHeld, enginePaused: engine._paused, documentHidden: document.hidden };
  }

  /** Suppress the player's camera writes so harness framing sticks. */
  freezeCamera(on) {
    const player = this.game.player;
    if (!player) return;
    if (on && !this._detach) {
      this._detach = true;
      player._harnessFrozen = true;
    } else if (!on && this._detach) {
      this._detach = null;
      player._harnessFrozen = false;
      this.game.engine.camera.fov = this.savedFov;
      this.game.engine.camera.updateProjectionMatrix();
    }
  }

  /** Move the player (and camera) to a spot and hand control back. */
  async teleport(x, y, z, yaw = 0) {
    // A pin would drag them straight back; handing control back means all of it.
    this.unpinPlayer();
    this.freezeCamera(false);
    this.game.player.teleport(new this.game.THREE.Vector3(x, y, z), yaw);
    for (let i = 0; i < 4; i++) await frame();
  }

  hideHud(hide = true) {
    this.hudHidden = hide;
    const root = document.getElementById('ui-root');
    if (root) root.style.opacity = hide ? '0' : '1';
  }

  /** Skip the click-to-enter gate. */
  dismissBoot() {
    document.querySelector('.boot-screen')?.remove();
  }

  /** Collected runtime errors, for the review harness to assert against. */
  get errors() {
    return window.__HARNESS_ERRORS__ ?? [];
  }

  /**
   * Everything a measurement needs to be trusted, including the reasons it
   * might not be.
   *
   * `drawCalls`/`triangles` are read straight from `renderer.info` and are the
   * figures for the frame that just rendered. They used to come from
   * `engine.stats`, which is resampled about once a second - so an A/B that
   * flipped a setting and read back immediately got the PREVIOUS value, and
   * produced tables that contradicted themselves. The sampled values are still
   * here, under `sampled`, because the smoothed frame time is what quality
   * decisions are actually made on.
   *
   * `gameplayDriven` is first because it invalidates everything below it when
   * false: no LOD is running, so the geometry figures are the worst case.
   */
  stats() {
    const G = this.game;
    const engine = G.engine;
    const s = engine.stats;
    const render = engine.renderer.info.render;
    const cam = engine.camera;
    const player = G.player;
    return {
      /* --- is this measurement even valid? ---------------------------- */
      gameplayDriven: this.gameplayDriven,
      gameplayBlocks: G.__dev?.gameplayBlocks?.() ?? null,
      enginePaused: engine._paused,
      awakeHeld: this._awakeHeld,
      documentHidden: typeof document !== 'undefined' ? document.hidden : null,
      rafStalls: window.__HARNESS_RAF_STALLS__ ?? 0,
      frozenAll: !!this._stubs,
      /* The sun's shadow camera is fitted around the PLAYER. Non-zero here
       * means the shadow map is covering somewhere other than what you can
       * see, and every shadow figure below is about that other place. */
      cameraToPlayer: player ? Math.round(cam.position.distanceTo(player.position) * 10) / 10 : null,
      playerPinned: this._pin ? [...this._pin.pos] : null,

      /* --- instantaneous: this frame, from renderer.info --------------- */
      drawCalls: render.calls,
      triangles: render.triangles,

      /* --- smoothed: engine.stats, resampled about once a second ------- */
      sampled: {
        fps: s.fps,
        frameMs: Math.round(s.frameMs * 100) / 100,
        frameMsMedian: Math.round(s.frameMsMedian * 100) / 100,
        drawCalls: s.drawCalls,
        triangles: s.triangles,
        programs: s.programs,
      },
      fps: s.fps,
      frameMs: Math.round(s.frameMs * 100) / 100,

      /* --- what the frame is actually made of -------------------------- */
      frameCost: this.frameCost(),

      world: G.worldManager.active?.id ?? null,
      npcs: G.npcManager?.npcs?.length ?? 0,
      portals: G.portals?.portals?.length ?? 0,
    };
  }

  /**
   * The passes a frame is actually paying for.
   *
   * Written down because it was materially misunderstood, twice. There is
   * exactly ONE live shadow-casting light - `sun`, owned by main.js. The rig's
   * second directional shadow slot (`rig:dirShadow:1`) exists to keep the
   * shader program cache key constant and has `shadow.autoUpdate = false`
   * (gfx/LightRig.js), so it renders nothing and costs zero draws; counting it
   * as a second shadow pass is where a phantom 3x multiplier came from. The
   * real second full-scene pass is GTAO's depth/normal prepass, measured here
   * at 1406 draws against a 3000-draw frame - 47% of it.
   */
  frameCost() {
    const engine = this.game.engine;
    const lights = [];
    engine.scene.traverse((o) => {
      if (!o.isLight || !o.castShadow) return;
      const auto = o.shadow?.autoUpdate !== false;
      lights.push({
        name: o.name || o.type,
        intensity: Math.round((o.intensity ?? 0) * 100) / 100,
        autoUpdate: auto,
        mapSize: o.shadow?.mapSize ? [o.shadow.mapSize.x, o.shadow.mapSize.y] : null,
        // The only ones that cost a shadow pass: lit, and allowed to refresh.
        live: auto && (o.intensity ?? 0) > 0,
      });
    });
    const passes = (engine.postfx?.composer?.passes ?? []).map((p) => ({
      name: p.constructor?.name ?? '(pass)',
      enabled: p.enabled !== false,
    }));
    return {
      shadowLights: lights,
      liveShadowLights: lights.filter((l) => l.live).length,
      postfxEnabled: engine.postfx?.enabled ?? false,
      passes,
    };
  }

  /**
   * Triangles in front of the camera, counted deterministically.
   *
   * Use this, not `stats().triangles`, whenever the question is "did this
   * change what is drawn". `renderer.info` sums every pass and moved 10-13%
   * between loads of an identical framing; this walk of the active world's
   * group reproduces exactly. See src/dev/WorldTriangles.js for the full note.
   *
   * @param {{ breakdown?: boolean, top?: number }} [opts]
   */
  worldTriangles(opts = {}) {
    const { breakdown = true, top = 12 } = opts;
    const world = this.game.worldManager.active;
    const r = walkWorldTriangles(world?.group, this.game.engine.camera, { breakdown });
    return {
      world: world?.id ?? null,
      ...r,
      byMaterial: r.byMaterial.slice(0, top),
      byName: r.byName.slice(0, top),
      /* Said out loud next to the number it contradicts. */
      note: 'deterministic; renderer.info.triangles is not - it includes the shadow and GTAO passes',
      rendererInfoTriangles: this.game.engine.renderer.info.render.triangles,
    };
  }

  /**
   * The Task 9 A/B: flip the maze's principal surfaces between the authored
   * KTX2 sets and the procedural bakes, live, without a reload. No argument
   * reports the current mode. Slot presence is identical in both modes, so
   * this can never cost a shader compile - see setMazeSurfaceMode.
   * @param {'authored'|'procedural'} [mode]
   */
  mazeSurfaces(mode) {
    return mode ? setMazeSurfaceMode(mode) : mazeSurfaceMode();
  }

  /**
   * Audit the station's placement and collision, and hand back the report.
   *
   * Imported lazily rather than at the top of this file, and deliberately: the
   * audit walks the whole scene graph and the whole collider set, so it is a
   * few hundred lines and a fair amount of typed-array work that a review
   * session capturing screenshots has no use for. Nothing pays for it until
   * somebody asks.
   *
   * Pure-read - see the note at the top of src/dev/StationAudit.js. It may be
   * run repeatedly against the same page and will report the same numbers, with
   * the single exception of the escalator treads, which move and are measured
   * as a fitted line rather than sampled for exactly that reason.
   *
   * @param {{ maxFindings?: number, checks?: string[], thresholds?: object }} [opts]
   * @returns {Promise<object>} a JSON-serialisable report, or `{ error }` when
   *   the active world is not the station.
   */
  async auditStation(opts = {}) {
    const world = this.game.worldManager.active;
    if (world?.id !== 'station') {
      return {
        error: `harness.auditStation() needs the station; active world is "${world?.id ?? 'none'}". Call goto('station') first.`,
        meta: { world: world?.id ?? null },
        checks: [],
      };
    }
    const { auditStation } = await import('./StationAudit.js');
    return auditStation(this.game, opts);
  }

  /** Streaming diagnostics for the maze. Dev-only. */
  mazeStats() {
    const w = this.game.worldManager.active;
    if (w?.id !== 'maze') return { world: w?.id ?? null, note: 'not in the maze' };

    // Collect distinct levels from both chunks and canopy resident sets.
    const levels = new Set();
    for (const key of w.chunks?.residentKeys() ?? []) {
      const { level } = districtCoords(key);
      levels.add(level);
    }
    for (const key of w.canopy?.residentKeys() ?? []) {
      const { level } = districtCoords(key);
      levels.add(level);
    }

    // Player's current level based on y-position.
    const playerPos = this.game.player?.position;
    let playerLevel = null;
    if (playerPos) {
      playerLevel = Math.min(MAZE.LEVELS - 1, Math.max(0, Math.round(playerPos.y / MAZE.LEVEL_HEIGHT)));
    }

    /* Phase 2c: what the three connectors are actually doing.
     *
     * `connectors` counts what the TOPOLOGY chose, `built` counts what
     * geometry was emitted - and they differ on purpose. A tunnel whose fold
     * would sever a crossing falls back to a staircase, so most tunnel links
     * build as stairs. Reporting only the topology figure would say 25%
     * tunnels and be misleading about what is in the world. */
    const connectors = { stair: 0, tunnel: 0, lift: 0 };
    const built = { stair: 0, tunnel: 0, lift: 0 };
    if (w.cells) {
      for (const key of w.chunks?.residentKeys() ?? []) {
        const { dx, dz, level } = districtCoords(key);
        if (level + 1 >= MAZE.LEVELS) continue;
        for (let lz = 0; lz < MAZE.DISTRICT; lz++) {
          for (let lx = 0; lx < MAZE.DISTRICT; lx++) {
            const cx = dx * MAZE.DISTRICT + lx, cz = dz * MAZE.DISTRICT + lz;
            if (!isOpen(w.cells, cellIndex(cx, cz, level), DIR.UP)) continue;
            const kind = connectorAt(w.cells, cx, cz, level);
            connectors[kind]++;
            const descs = shaftColliders(w.cells, cx, cz, level);
            if (descs.some((d) => d.kind === 'tunnel')) built.tunnel++;
            else if (descs.some((d) => d.kind === 'lift')) built.lift++;
            else built.stair++;
          }
        }
      }
    }

    return {
      seed: w.seed,
      residentDistricts: w.chunks?.residentKeys().length ?? 0,
      levels: levels.size,
      canopyDistricts: w.canopy?.residentKeys().length ?? 0,
      playerLevel,
      /* Vertical connectors in the RESIDENT set - `connectors` is what the
       * topology chose, `built` is what was emitted. See the note above. */
      connectors,
      built,
      liftsResident: w.chunks?.liftCount() ?? 0,
      gatesResident: w.chunks?.gateCount() ?? 0,
      colliders: this.game.physics.colliders.length,
      programs: this.game.engine.renderer.info.programs.length,
      drawCalls: this.game.engine.renderer.info.render.calls,
    };
  }
}

/**
 * One animation frame, with a watchdog.
 *
 * A backgrounded or occluded window delivers no `requestAnimationFrame`
 * callbacks at all, so every await in this file simply stops - and the symptom
 * an agent sees is a measurement script that hangs, or worse, one that resumed
 * later and read a frame from a world that had been frozen in between. Warn
 * rather than reject: a genuine 10 s frame is possible during shader warmup,
 * and failing the boot would be worse than saying so.
 */
function frame(timeoutMs = 10000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      window.__HARNESS_RAF_STALLS__ = (window.__HARNESS_RAF_STALLS__ ?? 0) + 1;
      console.warn(
        `[harness] no animation frame for ${timeoutMs}ms - the window is very likely ` +
        'backgrounded or occluded. Nothing is updating, including the sun\'s shadow camera.'
      );
    }, timeoutMs);
    requestAnimationFrame(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

export function installHarness(game) {
  // Capture errors from the moment the harness loads so reviews can flag them.
  window.__HARNESS_ERRORS__ = window.__HARNESS_ERRORS__ ?? [];
  window.addEventListener('error', (e) => {
    window.__HARNESS_ERRORS__.push(String(e.message ?? e));
  });
  window.addEventListener('unhandledrejection', (e) => {
    window.__HARNESS_ERRORS__.push(`unhandled rejection: ${e.reason?.message ?? e.reason}`);
  });
  const origError = console.error.bind(console);
  console.error = (...args) => {
    window.__HARNESS_ERRORS__.push(args.map((a) => (a?.stack ?? String(a))).join(' '));
    origError(...args);
  };

  const harness = new Harness(game);
  window.HARNESS = harness;
  console.info('[harness] installed - window.HARNESS ready');
  return harness;
}

// `Harness` is exported for scripts/tests/harness-*.test.mjs, which drive the
// real class against stub games rather than re-deriving its logic.
export { VIEWS, Harness };
