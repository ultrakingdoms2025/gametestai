import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { boxGeo, cylGeo, uvScale, instanced, seamLift } from '../StationKit.js';
import { buildZoneTower } from '../Tower.js';

/**
 * HAB RING C - where the station's whole crew actually sleeps.
 *
 * ── The two scales, and why there are two ─────────────────────────────────
 * "Crew sleeping apartments and beds that in turn can be explored inside each
 * cabin" is two different buildings pretending to be one. A tower gives you the
 * silhouette and the seven storeys; it cannot give you four hundred berths you
 * can walk up to, because four hundred furnished rooms with doors is more
 * geometry than the rest of the map put together.
 *
 * So the zone is built at both scales and each does the thing it is good at:
 *
 *   the court (r < 112)   five hab stacks, 7 to 9 storeys, fully enterable -
 *                         lift, escalators, floor plates, cabins on every level.
 *                         These are the landmark and the vertical play. Low-rise
 *                         terraces fill the ground between them.
 *   the arcade (r > 112)  eight concentric terrace rows under the 30 m roof:
 *                         cabin pods, capsule racks, open dormitories, washroom
 *                         and drying blocks, and the yards between them. This is
 *                         the *density* - a residential district reads as one
 *                         because there are hundreds of front doors, not because
 *                         there are five tall buildings.
 *
 * ── Why the deck is laid out as rows, spokes and a ring ───────────────────
 * A 200 m disc filled edge to edge with sleeping accommodation is a maze. The
 * plan is therefore a street plan first and a building second: a ring corridor
 * inside the arcade's mouth, eight radial spokes out to the rim, and terrace
 * rows in pairs that share a walkway between their front doors. Every module is
 * placed into a CELL of that grid and nothing is ever placed into circulation,
 * so however dense the terraces get you can always walk the ring, cut a spoke,
 * reach the plaza, and find the front door of all five stacks.
 *
 * ── Why almost everything repeats through `instanced()` ───────────────────
 * The zone carries more than seven hundred berths. A bunk drawn as unique
 * geometry seven hundred times is seven hundred merges and about as many
 * megabytes; the same bunk as one `InstancedMesh` is one draw call. So the rule
 * here is absolute: anything that appears more than ten times is a PROP KIND
 * with one prototype geometry, and the only geometry authored per-object is the
 * shell it stands in. `makeProps` is that registry, and it registers each
 * instance's collider through `ctx.solid` as it goes - a bunk you can walk
 * through is worse than no bunk at all.
 *
 * The pods deliberately have no door leaves. A door on each of two hundred pods
 * is two hundred more colliders, two hundred more pivots and two hundred more
 * things for the Interiors prompt to fight over, and it buys nothing: an open
 * doorway with a lit interior behind it reads as somewhere you can go, which is
 * the whole point, and a closed one reads as scenery.
 */

/** Storey height of the hab stacks. Matches Tower.js. */
const FLOOR_H = 3.9;

/** Depth of every terrace row, court and arcade alike. */
const ROW_D = 6.0;
/** Height of a single-storey pod shell. */
const POD_H = 3.2;
/** Thickness of a pod's party walls and back. */
const WALL_T = 0.22;
/** Clear width of a radial spoke. */
const SPOKE_W = 5.4;

/**
 * Terrace rows under the arcade, as centre radii. They run in pairs whose backs
 * meet, so each pair's two frontages open onto a walkway of its own rather than
 * each row needing one on both sides.
 */
const ARCADE_ROWS = [
  { r: 127.5, out: false }, { r: 133.6, out: true },
  { r: 145.6, out: false }, { r: 151.7, out: true },
  { r: 163.7, out: false }, { r: 169.8, out: true },
  { r: 181.8, out: false }, { r: 187.9, out: true },
];

/** Paved circulation bands, inner radius to outer. */
const ARCADE_WALKS = [
  [109.2, 124.4],   // the ring corridor, run right up to the first frontage
  [136.7, 142.5],
  [154.8, 160.6],
  [172.9, 178.7],
  [190.9, 196.0],
];

/** Terrace rows in the court. `gap` rows only build between the hab stacks. */
const COURT_ROWS = [
  { r: 48.0, out: false, gap: false },
  { r: 54.2, out: true, gap: false },
  { r: 71.0, out: false, gap: true },
  { r: 77.2, out: true, gap: true },
  { r: 100.0, out: false, gap: false },
  { r: 106.2, out: true, gap: false },
];

const COURT_WALKS = [
  [0, 12], [12, 24], [24, 36],      // the garden, paved in three rings
  [36, 45], [57.2, 68.0], [80.2, 96.9],
];

/** Bearings of the eight arcade spokes and the five court spokes. */
const ARCADE_SPOKES = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => (k * Math.PI) / 4);
const COURT_SPOKES = [0, 1, 2, 3, 4].map((k) => (k * Math.PI * 2) / 5);

/**
 * Points the two named residents stand on or walk through. Terraces leave a
 * courtyard around each, so a warden on patrol never has to path through a
 * building that was not there when her route was written.
 */
const NPC_ANCHORS = [
  [-18, 74], [10, 84], [-38, 22], [-8, 116],
  [36, 148], [52, 132], [22, 160], [44, 118],
];

/**
 * Programme of a terrace cell. Roughly seven cells in ten are a yard - a paved
 * court between blocks with planting, drying lines and kit racks - because a
 * residential deck built solid from the ring corridor to the rim has nowhere to
 * stand and nothing to look at from a doorway.
 */
const CELL_MIX = [
  'pods', 'yard', 'yard', 'svc', 'pods', 'yard', 'yard', 'caps',
  'pods', 'yard', 'yard', 'com', 'pods', 'yard', 'yard', 'svc',
  'pods', 'yard', 'yard', 'dorm', 'yard', 'yard', 'com', 'yard',
  'pods', 'yard', 'yard', 'caps', 'yard', 'yard', 'svc', 'yard',
  'yard', 'com', 'yard', 'dorm', 'yard', 'yard', 'yard', 'yard',
];

/** Cabin plans, walked in order along each terrace. */
const POD_PLANS = [
  { w: 5.2, kind: 'single' },
  { w: 5.2, kind: 'twin' },
  { w: 5.2, kind: 'single' },
  { w: 7.4, kind: 'quad' },
  { w: 5.2, kind: 'twin' },
  { w: 6.4, kind: 'officer' },
  { w: 5.2, kind: 'single' },
  { w: 5.2, kind: 'twin' },
];

export function buildHabitation(ctx) {
  const props = makeProps(ctx);

  habStacks(ctx);
  paving(ctx);
  arcadeTerraces(ctx, props);
  courtTerraces(ctx, props);
  rimServices(ctx, props);
  commons(ctx, props);
  props.flush();
  population(ctx);
  relics(ctx);

  /* Named residents. Two only - the game caps authored friendlies at eight
   * across all five decks and the other three zones need theirs. */
  ctx.npc(-18, 74, {
    name: 'Yara Bess',
    persona:
      'Deck warden for Hab Ring C, which she runs like a ship and describes like a village. She knows whose recycler is broken, whose shift patterns clash and exactly who has been keeping a cat in a supposedly sealed pod, and she will tell you all of it while walking somewhere else.',
    // The third leg used to be (-40, 62), which is inside Hab Stack G's
    // footprint - it always was, and the terraces only made it obvious.
    patrol: [[-18, 74], [10, 84], [-38, 22], [-8, 116]],
  });
  ctx.npc(36, 148, {
    name: 'Petr Oyelaran',
    persona:
      'Night-shift welder three weeks off rotation and visibly unsure what to do with daylight hours. Speaks slowly, laughs at the end of his own sentences, and has strong opinions about which of the galley\'s four soups is a lie.',
    patrol: [[36, 148], [52, 132], [22, 160], [44, 118]],
  });
}

/* ------------------------------------------------------------------ */
/* Frames and guards                                                   */
/* ------------------------------------------------------------------ */

/** Zone-local point at polar (bearing, radius). */
function pol(a, r) {
  return [Math.sin(a) * r, Math.cos(a) * r];
}

/**
 * Everything authored in a module's own frame - origin at its centre, doorway
 * on local -Z - and this does the one transform into zone coordinates. Placing
 * even one part directly with `ctx.box` puts it at the zone centre instead of at
 * the module, which is a mistake that is invisible until two hundred pod walls
 * pile up on the same square metre.
 */
function frameAt(ctx, props, ox, oz, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const X = (px, pz) => ox + px * c + pz * s;
  const Z = (px, pz) => oz - px * s + pz * c;
  return {
    X, Z, yaw,
    put: (key, geo, px, py, pz, extra = 0) =>
      ctx.put(key, geo, X(px, pz), py, Z(px, pz), yaw + extra),
    box: (key, w, h, d, px, py, pz, extra = 0) =>
      ctx.box(key, w, h, d, X(px, pz), py, Z(px, pz), yaw + extra),
    quad: (key, w, d, px, pz, y = 0.08, extra = 0) =>
      ctx.floorQuad(key, w, d, X(px, pz), Z(px, pz), yaw + extra, y),
    sol: (px, py, pz, hx, hy, hz, extra = 0) =>
      ctx.solid(X(px, pz), py, Z(px, pz), hx, hy, hz, yaw + extra),
    prop: (kind, px, py, pz, extra = 0) =>
      props.add(kind, X(px, pz), py, Z(px, pz), yaw + extra),
    actor: (px, py, pz, o = {}) =>
      addActor(ctx, X(px, pz), py, Z(px, pz), { ...o, localYaw: yaw + (o.localYaw ?? 0) }),
  };
}

/** True if a point is inside the arrival plaza, its approach, or an NPC court. */
function reserved(lx, lz, pad = 0) {
  if (lz > 134 - pad && Math.abs(lx) < 34 + pad) return true;
  for (const [ax, az] of NPC_ANCHORS) {
    if (Math.hypot(lx - ax, lz - az) < 7 + pad) return true;
  }
  return false;
}

/** True if a bearing falls inside one of a set of radial spokes at radius `r`. */
function inSpoke(a, r, bearings, w = SPOKE_W) {
  const half = (w / 2 + 0.6) / r;
  for (const b of bearings) {
    let d = a - b;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    if (Math.abs(d) < half) return true;
  }
  return false;
}

/**
 * True if a court point is clear of the five hab stacks AND of the approach to
 * their front doors, which all face the zone centre. A terrace across a stack's
 * door would close the only way into the one building in the zone you can climb.
 */
function stackClear(lx, lz, pad = 0) {
  const r = Math.hypot(lx, lz);
  const a = Math.atan2(lx, lz);
  for (let i = 0; i < 5; i++) {
    const sa = (i / 5) * Math.PI * 2 + Math.PI * 0.2;
    let d = a - sa;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const lat = Math.abs(Math.sin(d)) * r;
    const along = Math.cos(d) * r;
    if (along > 60 && along < 96 && lat < 16 + pad) return false;   // the stack itself
    if (along > 28 && along <= 60 && lat < 9 + pad) return false;   // its front approach
  }
  return true;
}

/** One actor, rejected if it would stand off the deck. */
function addActor(ctx, lx, ly, lz, o) {
  if (!ctx.onDeck(lx, lz, 3.5)) return false;
  ctx.actor(lx, ly, lz, { phase: ctx.rng() * 6.283, ...o });
  return true;
}

/* ------------------------------------------------------------------ */
/* Instanced prop vocabulary                                           */
/* ------------------------------------------------------------------ */

/** A single berth: base, mattress, pillow. Mattress top at 0.62. */
function bunkGeo() {
  return mergeGeometries([
    boxGeo(1.0, 0.44, 2.06, 1.5).translate(0, 0.22, 0),
    boxGeo(0.92, 0.18, 1.94, 1.5).translate(0, 0.53, 0),
    boxGeo(0.7, 0.14, 0.34, 1).translate(0, 0.69, -0.78),
  ], false);
}

/** Two berths stacked, on end frames. Lower mattress top at 0.68. */
function bunkBedGeo() {
  return mergeGeometries([
    boxGeo(1.0, 0.16, 2.06, 1.5).translate(0, 0.52, 0),
    boxGeo(0.92, 0.16, 1.94, 1.5).translate(0, 0.68, 0),
    boxGeo(1.0, 0.16, 2.06, 1.5).translate(0, 1.54, 0),
    boxGeo(0.92, 0.16, 1.94, 1.5).translate(0, 1.70, 0),
    boxGeo(1.04, 1.94, 0.1, 1.5).translate(0, 0.97, -1.02),
    boxGeo(1.04, 1.94, 0.1, 1.5).translate(0, 0.97, 1.02),
  ], false);
}

/** A sleep capsule shell. The mouth is a separate prop so it can be dark. */
function capsuleGeo() {
  return boxGeo(1.24, 1.12, 2.5, 1.5).translate(0, 0.56, 0);
}
function capsuleMouthGeo() {
  return boxGeo(1.02, 0.88, 0.16, 1).translate(0, 0.54, -1.22);
}

function lockerGeo() {
  return mergeGeometries([
    boxGeo(0.9, 2.0, 0.62, 1.5).translate(0, 1.0, 0),
    boxGeo(0.05, 1.84, 0.05, 1).translate(0, 1.0, -0.32),
  ], false);
}

function footlockerGeo() { return boxGeo(0.9, 0.42, 0.5, 1).translate(0, 0.21, 0); }
function kitbagGeo() { return boxGeo(0.46, 0.34, 0.76, 1).translate(0, 0.17, 0); }

function chairGeo() {
  return mergeGeometries([
    boxGeo(0.46, 0.08, 0.46, 1).translate(0, 0.44, 0),
    boxGeo(0.46, 0.5, 0.07, 1).translate(0, 0.71, 0.2),
    boxGeo(0.14, 0.44, 0.14, 1).translate(0, 0.22, 0),
  ], false);
}

function deskGeo() {
  return mergeGeometries([
    boxGeo(1.5, 0.08, 0.62, 1).translate(0, 0.74, 0),
    boxGeo(1.4, 0.72, 0.08, 1).translate(0, 0.38, 0.25),
  ], false);
}

/** A shelf of personal effects, hung on a cabin wall. */
function shelfGeo() {
  return mergeGeometries([
    boxGeo(1.2, 0.06, 0.26, 1),
    boxGeo(0.62, 0.24, 0.2, 1).translate(-0.16, 0.15, 0),
  ], false);
}

function bootRackGeo() {
  return mergeGeometries([
    boxGeo(1.1, 0.1, 0.44, 1).translate(0, 0.16, 0),
    boxGeo(1.1, 0.06, 0.06, 1).translate(0, 0.34, -0.17),
  ], false);
}

/** An open kit rack: a shelf over a hanging rail, with a bag on it. */
function kitRackGeo() {
  return mergeGeometries([
    boxGeo(1.2, 0.08, 0.5, 1).translate(0, 1.9, 0),
    boxGeo(0.9, 1.0, 0.44, 1).translate(0, 1.36, 0),
  ], false);
}

function trolleyGeo() {
  return mergeGeometries([
    boxGeo(0.76, 0.72, 1.1, 1).translate(0, 0.5, 0),
    boxGeo(0.08, 0.5, 0.08, 1).translate(0, 1.1, -0.5),
  ], false);
}

/** A stack of folded laundry. */
function laundryGeo() {
  return mergeGeometries([
    boxGeo(0.76, 0.34, 0.56, 1).translate(0, 0.17, 0),
    boxGeo(0.66, 0.26, 0.48, 1).translate(0, 0.47, 0),
  ], false);
}

function waterPointGeo() {
  return mergeGeometries([
    boxGeo(0.5, 0.94, 0.4, 1).translate(0, 0.47, 0),
    boxGeo(0.56, 0.12, 0.46, 1).translate(0, 1.0, 0),
  ], false);
}

function nightLightGeo() { return boxGeo(0.34, 0.09, 0.09, 1); }
function bulkheadLampGeo() { return boxGeo(0.5, 0.14, 0.16, 1); }
function noticeGeo() { return boxGeo(0.9, 0.62, 0.04, 1); }
function screenGeo() { return boxGeo(1.2, 0.9, 0.04, 1); }
function bushGeo() { return boxGeo(1.1, 0.8, 1.1, 1).translate(0, 0.4, 0); }

function ladderGeo() {
  return mergeGeometries([
    boxGeo(0.42, 3.6, 0.06, 1).translate(0, 1.8, 0),
    boxGeo(0.3, 3.5, 0.05, 1).translate(0, 1.8, 0.12),
  ], false);
}

function basinGeo() {
  return mergeGeometries([
    boxGeo(0.9, 0.16, 0.5, 1).translate(0, 0.86, 0),
    boxGeo(0.8, 0.72, 0.4, 1).translate(0, 0.42, 0.04),
  ], false);
}

/** A shower cubicle: back, one flank, and a curtain rail. */
function showerGeo() {
  return mergeGeometries([
    boxGeo(1.1, 2.1, 0.1, 1.5).translate(0, 1.05, 0.5),
    boxGeo(0.1, 2.1, 1.1, 1.5).translate(-0.5, 1.05, 0),
    boxGeo(1.1, 0.08, 0.08, 1).translate(0, 2.05, -0.5),
  ], false);
}

/** A comms booth: a half-height carrel with a screen in it. */
function boothGeo() {
  return mergeGeometries([
    boxGeo(1.2, 2.2, 0.12, 1.5).translate(0, 1.1, 0.55),
    boxGeo(0.12, 2.2, 1.2, 1.5).translate(-0.6, 1.1, 0),
  ], false);
}

function benchGeo() {
  return mergeGeometries([
    boxGeo(2.2, 0.14, 0.56, 1.5).translate(0, 0.44, 0),
    boxGeo(2.2, 0.42, 0.1, 1).translate(0, 0.72, 0.24),
  ], false);
}

function tableGeo() {
  return mergeGeometries([
    boxGeo(1.4, 0.1, 1.4, 1.5).translate(0, 0.74, 0),
    boxGeo(0.3, 0.72, 0.3, 1).translate(0, 0.36, 0),
  ], false);
}

/** A drying rack, hung with a shift's worth of coveralls. */
function dryRackGeo() {
  return mergeGeometries([
    boxGeo(1.8, 0.08, 0.5, 1).translate(0, 1.86, 0),
    boxGeo(1.6, 1.0, 0.34, 1).translate(0, 1.3, 0),
  ], false);
}

/**
 * Every repeated object in the zone. `solid` is the half-extent of the collider
 * registered at each instance, measured from the prop's own base - which is why
 * every prototype above is authored standing on y = 0.
 */
const PROP_KINDS = {
  bunk: { geo: bunkGeo, mat: 'panelWarm', cast: false, berths: 1, solid: [0.5, 0.31, 1.03] },
  bunkBed: { geo: bunkBedGeo, mat: 'panelWarm', cast: true, berths: 2, solid: [0.52, 0.35, 1.03] },
  capsule: { geo: capsuleGeo, mat: 'shell', cast: true, berths: 1, solid: [0.62, 0.56, 1.25] },
  capsuleMouth: { geo: capsuleMouthGeo, mat: 'panelDark', cast: false },
  locker: { geo: lockerGeo, mat: 'panelDark', cast: true, solid: [0.45, 1.0, 0.31] },
  footlocker: { geo: footlockerGeo, mat: 'crate', cast: false, solid: [0.45, 0.21, 0.25] },
  kitbag: { geo: kitbagGeo, mat: 'crate', cast: false },
  chair: { geo: chairGeo, mat: 'trimDark', cast: false, solid: [0.25, 0.24, 0.25] },
  desk: { geo: deskGeo, mat: 'panelWarm', cast: false, solid: [0.75, 0.39, 0.31] },
  shelf: { geo: shelfGeo, mat: 'trim', cast: false },
  bootRack: { geo: bootRackGeo, mat: 'trimDark', cast: false, solid: [0.55, 0.2, 0.22] },
  kitRack: { geo: kitRackGeo, mat: 'trim', cast: true, solid: [0.6, 0.99, 0.25] },
  trolley: { geo: trolleyGeo, mat: 'chrome', cast: false, solid: [0.38, 0.43, 0.55] },
  laundry: { geo: laundryGeo, mat: 'crate', cast: false, solid: [0.38, 0.3, 0.28] },
  waterPoint: { geo: waterPointGeo, mat: 'chrome', cast: false, solid: [0.28, 0.53, 0.23] },
  nightLight: { geo: nightLightGeo, mat: 'emDim', cast: false },
  bulkheadLamp: { geo: bulkheadLampGeo, mat: 'emWhite', cast: false },
  notice: { geo: noticeGeo, mat: 'holo', cast: false },
  screen: { geo: screenGeo, mat: 'glassWindow', cast: false },
  bush: { geo: bushGeo, mat: 'foliage', cast: false },
  ladder: { geo: ladderGeo, mat: 'trim', cast: false },
  basin: { geo: basinGeo, mat: 'chrome', cast: false, solid: [0.45, 0.45, 0.25] },
  shower: { geo: showerGeo, mat: 'panelDark', cast: true, solid: [0.55, 1.05, 0.55] },
  booth: { geo: boothGeo, mat: 'panelDark', cast: true, solid: [0.6, 1.1, 0.6] },
  bench: { geo: benchGeo, mat: 'panelWarm', cast: false, solid: [1.1, 0.25, 0.3] },
  table: { geo: tableGeo, mat: 'panelWarm', cast: false, solid: [0.7, 0.39, 0.7] },
  dryRack: { geo: dryRackGeo, mat: 'trim', cast: false, solid: [0.9, 0.95, 0.25] },
};

/**
 * The prop registry. Collects one entry per instance, registers its collider as
 * it goes, and builds one `InstancedMesh` per kind at the end of the build.
 */
function makeProps(ctx) {
  const kinds = new Map();
  let berths = 0;
  return {
    add(kind, lx, ly, lz, localYaw = 0) {
      const k = PROP_KINDS[kind];
      let list = kinds.get(kind);
      if (!list) kinds.set(kind, (list = []));
      const p = ctx.P(lx, ly, lz);
      list.push([p.x, p.y, p.z, 0, ctx.yawOf(localYaw), 0, 1, 1, 1]);
      if (k.berths) berths += k.berths;
      if (k.solid) ctx.solid(lx, ly + k.solid[1], lz, k.solid[0], k.solid[1], k.solid[2], localYaw);
      return list.length;
    },
    get berths() { return berths; },
    flush() {
      for (const [kind, list] of kinds) {
        const k = PROP_KINDS[kind];
        ctx.group.add(instanced(k.geo(), ctx.M[k.mat], list, { cast: !!k.cast, recv: true }));
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Circulation                                                         */
/* ------------------------------------------------------------------ */

/**
 * The street plan: ring corridor, terrace walkways, radial spokes.
 *
 * Laid as tangential quads rather than as one `RingGeometry` because a ring is a
 * single fan of triangles that nothing can be cut out of, while a band of quads
 * costs two triangles apiece, tiles its paving texture straight, and is the same
 * primitive the terrace aprons use - so the whole floor reads as one surface.
 */
function paving(ctx) {
  /* Where the paving sits, and why it is a ladder rather than a height.
   *
   * A band oversizes every quad in it - by 3% tangentially and by a sagitta
   * radially, both so the band shows no bare deck at a joint - so each quad
   * overlaps its two neighbours, and the court's rings ([0,12], [12,24],
   * [24,36], [36,45]) overlap the ring on either side of them as well. Laid at
   * one height that is a lattice of surfaces the depth buffer cannot order:
   * the floor sweep found 13 coincident hits in this zone on a 12 m grid, and
   * `M.plazaOnDeck`'s polygon offset does not help because both quads are
   * `M.plazaOnDeck` and take the same bias.
   *
   * So a quad's height comes from `seamLift` (which of its two neighbours in
   * the ring it must beat) and its band's parity (the ring inside and outside
   * it). Four levels, and they are written out rather than computed because
   * the window they have to fit in is fixed at both ends: the contact patches
   * under the terraces are at 0.055 and the spokes that cross every band are at
   * 0.075, and 4.7 mm apart is the most this can give each joint without
   * pushing either of those out of the way. Segment counts are forced even so
   * `seamLift` never needs its third level for a wrap joint - a ring of 15 is
   * a ring of 16 as far as anything anybody looks at is concerned.
   */
  const LEVELS = [0.0580, 0.0627, 0.0673, 0.0720];
  const bandY = (bandIdx, i, n) =>
    LEVELS[((bandIdx % 2) * 2 + Math.round(seamLift(i, n, 1))) % LEVELS.length];

  const band = (r0, r1, segs0, key, bandIdx) => {
    const segs = segs0 + (segs0 % 2);
    // A band that reaches the middle has no annulus to divide - segmenting it
    // stacks `segs` coplanar quads on the centre and they z-fight each other.
    if (r0 < 0.1) { ctx.floorQuad(key, r1 * 2, r1 * 2, 0, 0, 0, bandY(bandIdx, 0, 1), 5); return; }
    const rm = (r0 + r1) / 2;
    const half = Math.PI / segs;
    // Oversize each quad by the sagitta so the band has no gaps on its outer arc.
    const w = 2 * rm * Math.tan(half) * 1.03;
    const d = (r1 - r0) + rm * (1 - Math.cos(half)) * 2 + 0.2;
    for (let i = 0; i < segs; i++) {
      const a = ((i + 0.5) / segs) * Math.PI * 2;
      const [lx, lz] = pol(a, rm);
      ctx.floorQuad(key, w, d, lx, lz, a, bandY(bandIdx, i, segs), 5);
    }
  };

  ARCADE_WALKS.forEach(([r0, r1], bi) => band(r0, r1, 56, 'plazaOnDeck', bi));
  COURT_WALKS.forEach(([r0, r1], bi) => {
    if (r1 <= 12) { band(r0, r1, 10, 'plazaOnDeck', bi); return; }
    band(r0, r1, Math.max(12, Math.round(r1 / 3)), 'plazaOnDeck', bi);
  });

  /* Radial spokes. Eight through the arcade, five through the court on the
   * bearings that fall BETWEEN the hab stacks - a spoke every 45 degrees in the
   * court would drive two of them straight through a building. */
  for (const a of ARCADE_SPOKES) {
    const [lx, lz] = pol(a, 154);
    ctx.floorQuad('plazaOnDeck', SPOKE_W, 86, lx, lz, a, 0.075, 5);
    for (let i = 0; i < 5; i++) {
      const [px, pz] = pol(a, 118 + i * 18);
      ctx.floorQuad('route', 1.1, 6, px, pz, a, 0.085, 3);
    }
  }
  for (const a of COURT_SPOKES) {
    const [lx, lz] = pol(a, 74);
    ctx.floorQuad('plazaOnDeck', SPOKE_W, 78, lx, lz, a, 0.075, 5);
  }

  ctx.mmCircle(0, 0, 190, 'rgba(50,90,80,0.22)', 'rgba(120,220,190,0.35)');
  ctx.mmCircle(0, 0, 116, 'rgba(40,80,72,0.0)', 'rgba(140,255,215,0.45)');
}

/* ------------------------------------------------------------------ */
/* The arcade terraces                                                 */
/* ------------------------------------------------------------------ */

/**
 * Eight rows, eight sectors, and a programme per cell.
 *
 * The sector boundaries ARE the spokes, so a module can never be authored into
 * one; and each sector-row is cut into cells about 24 m long, which is the
 * length at which a terrace of four cabins, a capsule rack or a washroom block
 * all read as one building rather than as a run of them.
 */
function arcadeTerraces(ctx, props) {
  for (let ri = 0; ri < ARCADE_ROWS.length; ri++) {
    const row = ARCADE_ROWS[ri];
    for (let s = 0; s < 8; s++) {
      const step = (Math.PI * 2) / 8;
      const half = (SPOKE_W / 2 + 1.2) / row.r;
      const a0 = s * step + half, a1 = (s + 1) * step - half;
      const cells = Math.max(1, Math.round(((a1 - a0) * row.r) / 24));
      for (let c = 0; c < cells; c++) {
        const ca0 = a0 + ((a1 - a0) * c) / cells;
        const ca1 = a0 + ((a1 - a0) * (c + 1)) / cells;
        buildCell(ctx, props, {
          kind: CELL_MIX[(ri * 17 + s * 11 + c * 29) % CELL_MIX.length],
          r: row.r, out: row.out, a0: ca0, a1: ca1,
          seed: ri * 7 + s * 3 + c, court: false,
        });
      }
    }
  }
}

/** Dispatch one terrace cell to the builder for its programme. */
function buildCell(ctx, props, o) {
  const inset = 1.1 / o.r;
  const c = { ...o, a0: o.a0 + inset, a1: o.a1 - inset };
  if ((c.a1 - c.a0) * c.r < 7) return;
  switch (c.kind) {
    case 'pods': podTerrace(ctx, props, c); break;
    case 'caps': capsuleRack(ctx, props, c); break;
    case 'dorm': dormHall(ctx, props, c); break;
    case 'svc': serviceBlock(ctx, props, c); break;
    case 'com': commonBay(ctx, props, c); break;
    default: yardBay(ctx, props, c); break;
  }
}

/** True if a module centred here may be built at all. */
function siteClear(ctx, lx, lz, court) {
  if (reserved(lx, lz, 3.5)) return false;
  if (!ctx.onDeck(lx, lz, 6)) return false;
  if (court && !stackClear(lx, lz, 2)) return false;
  const a = Math.atan2(lx, lz), r = Math.hypot(lx, lz);
  if (inSpoke(a, r, court ? COURT_SPOKES : ARCADE_SPOKES)) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* Cabin terraces                                                      */
/* ------------------------------------------------------------------ */

/**
 * A run of cabin pods along an arc, sharing party walls.
 *
 * The slots are laid out first and built second, so a pod knows whether its
 * right-hand neighbour exists and can close its own flank if not. Built in one
 * pass instead, every terrace either grew a double wall between every pair of
 * cabins or ended in an open section you could see the mattresses through.
 */
function podTerrace(ctx, props, o) {
  const { r, out, a0, a1, seed, court } = o;
  const slots = [];
  let a = a0, i = 0;
  while (a < a1) {
    const plan = POD_PLANS[(seed + i * 3) % POD_PLANS.length];
    const dw = plan.w / r;
    if (a + dw > a1) break;
    const ac = a + dw / 2;
    const [lx, lz] = pol(ac, r);
    slots.push({ ac, plan, lx, lz, ok: siteClear(ctx, lx, lz, court) });
    a += dw; i++;
  }
  let built = 0;
  for (let k = 0; k < slots.length; k++) {
    const s = slots[k];
    if (!s.ok) continue;
    buildPod(ctx, props, s, r, out, k === slots.length - 1 || !slots[k + 1].ok, seed + k);
    built++;
  }
  if (!built) return;
  const am = (a0 + a1) / 2;
  const [mx, mz] = pol(am, r);
  const len = (a1 - a0) * r;
  ctx.contact(mx, mz, Math.max(len, ROW_D) + 4);
  ctx.mmRect(mx, mz, len, ROW_D, am, 'rgba(70,120,110,0.5)', 'rgba(140,255,215,0.4)');
  if (seed % 3 === 0) ctx.roof(mx, POD_H + 0.4, mz);
}

/**
 * One cabin: a three-walled shell with a lit interior, and a fit-out that says
 * how many people live in it.
 *
 * Party wall on -X only. The +X wall is its neighbour's, which halves the wall
 * count along a terrace and is also how a terrace is actually built.
 */
function buildPod(ctx, props, s, r, out, closeRight, seed) {
  const { plan, lx, lz, ac } = s;
  const yaw = out ? ac + Math.PI : ac;
  const W = plan.w, D = ROW_D, H = POD_H;
  const f = frameAt(ctx, props, lx, lz, yaw);
  const accent = ctx.spec.accent;
  const rng = ctx.rng;

  // Back, party wall, roof, and the lintel over the doorway.
  f.put('panel', boxGeo(W, H, WALL_T, 2), 0, H / 2, D / 2 - WALL_T / 2);
  f.sol(0, H / 2, D / 2 - WALL_T / 2, W / 2, H / 2, WALL_T / 2);
  f.put('panelDark', boxGeo(WALL_T, H, D, 2), -W / 2, H / 2, 0);
  f.sol(-W / 2, H / 2, 0, WALL_T / 2, H / 2, D / 2);
  if (closeRight) {
    f.put('panelDark', boxGeo(WALL_T, H, D, 2), W / 2, H / 2, 0);
    f.sol(W / 2, H / 2, 0, WALL_T / 2, H / 2, D / 2);
  }
  f.put('panelDark', boxGeo(W + 0.16, 0.26, D + 0.16, 2), 0, H + 0.13, 0);
  f.sol(0, H + 0.13, 0, (W + 0.16) / 2, 0.13, (D + 0.16) / 2);
  f.put('panel', boxGeo(W, H - 2.3, WALL_T, 2), 0, 2.3 + (H - 2.3) / 2, -D / 2 + WALL_T / 2);
  f.sol(0, 2.3 + (H - 2.3) / 2, -D / 2 + WALL_T / 2, W / 2, (H - 2.3) / 2, WALL_T / 2);

  // Threshold plate, the strip over the door, and the light that makes the
  // inside visible from the walkway - an unlit interior reads as a wall.
  f.box('grate', W - 0.3, 0.12, D - 0.5, 0, 0.06, 0.1);
  f.put(accent, new THREE.PlaneGeometry(W - 1.3, 0.13), 0, 2.44, -D / 2 - 0.04, Math.PI);
  f.put('emDim', new THREE.PlaneGeometry(W - 1.2, 0.22), 0, H - 0.44, D / 2 - WALL_T - 0.05, Math.PI);

  const L = -W / 2 + 0.75, R = W / 2 - 0.75;
  const kind = plan.kind;
  if (kind === 'single') {
    f.prop('bunk', L, 0, 1.4);
    f.prop('locker', R, 0, D / 2 - 0.55);
    f.prop('footlocker', R, 0, -1.4);
    f.prop('shelf', L + 0.1, 1.55, D / 2 - 0.45);
    if (seed % 5 === 0) f.prop('kitbag', R - 0.6, 0, -0.4, 0.4);
  } else if (kind === 'twin') {
    f.prop('bunkBed', L, 0, 1.4);
    f.prop('locker', R, 0, D / 2 - 0.55);
    f.prop('locker', R - 0.95, 0, D / 2 - 0.55);
    f.prop('footlocker', R, 0, -1.4);
    f.prop('bootRack', L + 0.1, 0, -1.9, Math.PI / 2);
  } else if (kind === 'quad') {
    f.prop('bunkBed', L, 0, 1.4);
    f.prop('bunkBed', R, 0, 1.4);
    for (let i = 0; i < 4; i++) f.prop('locker', -1.5 + i, 0, D / 2 - 0.55);
    f.prop('footlocker', L, 0, -1.5);
    f.prop('footlocker', R, 0, -1.5);
    f.prop('kitRack', 0, 0, -D / 2 + 0.9);
  } else {
    f.prop('bunk', L, 0, 1.4);
    f.prop('desk', R - 0.2, 0, 0.9, -Math.PI / 2);
    f.prop('chair', R - 1.2, 0, 0.9, -Math.PI / 2);
    f.prop('locker', 0.4, 0, D / 2 - 0.55);
    f.prop('shelf', L + 0.1, 1.55, D / 2 - 0.45);
  }
  if (seed % 2 === 0) f.prop('nightLight', -W / 2 + 0.25, 0.42, -D / 2 + 0.6);

  // Somebody at home. Sitting on the edge of a berth or standing in the doorway
  // watching the walkway, which is what a doorway on a terrace is for.
  const roll = rng();
  if (roll < 0.13) {
    f.actor(L + 0.55, 0, 0.9, { activity: 'sit', amount: kind === 'twin' || kind === 'quad' ? 0.68 : 0.62, localYaw: Math.PI / 2 });
  } else if (roll < 0.22) {
    f.actor(0, 0, -D / 2 + 0.7, { activity: rng() > 0.5 ? 'stand' : 'talk', localYaw: Math.PI });
  }
}

/* ------------------------------------------------------------------ */
/* Capsule racks                                                       */
/* ------------------------------------------------------------------ */

/**
 * A bank of sleep capsules two and three high.
 *
 * The cheapest berth on the station and by far the densest thing in the zone:
 * one divider, one floor plate and three capsules per 1.36 m of frontage. Where
 * a cabin terrace spends thirty-odd square metres on one crew member, this puts
 * three in under two, which is exactly the trade a station actually makes for
 * transiting crews - and it is what lets the deck carry a whole watch.
 */
function capsuleRack(ctx, props, o) {
  const { r, out, a0, a1, seed, court } = o;
  const BAY = 1.36, D = ROW_D, H = 4.1;
  const accent = ctx.spec.accent;
  const maxBays = 6;
  const span = Math.min((a1 - a0) * r, maxBays * BAY);
  const am = (a0 + a1) / 2;
  const b0 = am - span / (2 * r);
  const bays = Math.floor(span / BAY);
  if (bays < 4) return;

  let built = 0;
  for (let k = 0; k < bays; k++) {
    const ac = b0 + ((k + 0.5) * BAY) / r;
    const [lx, lz] = pol(ac, r);
    if (!siteClear(ctx, lx, lz, court)) continue;
    const yaw = out ? ac + Math.PI : ac;
    const f = frameAt(ctx, props, lx, lz, yaw);
    const tiers = (seed + k) % 3 === 0 ? 2 : 3;

    // Divider between bays, the rack's back, and the gangway plate in front.
    f.put('panelDark', boxGeo(0.12, H, D - 0.6, 2), -BAY / 2, H / 2, 0.3);
    f.sol(-BAY / 2, H / 2, 0.3, 0.06, H / 2, (D - 0.6) / 2);
    f.put('panel', boxGeo(BAY, H, 0.2, 2), 0, H / 2, D / 2 - 0.1);
    f.sol(0, H / 2, D / 2 - 0.1, BAY / 2, H / 2, 0.1);
    f.box('grate', BAY, 0.12, D - 0.4, 0, 0.06, 0.1);
    f.put('panelDark', boxGeo(BAY + 0.06, 0.22, D + 0.1, 2), 0, H + 0.11, 0);
    f.sol(0, H + 0.11, 0, (BAY + 0.06) / 2, 0.11, (D + 0.1) / 2);

    for (let t = 0; t < tiers; t++) {
      const y = 0.30 + t * 1.24;
      f.prop('capsule', 0, y, 0.72);
      f.prop('capsuleMouth', 0, y, 0.72);
      f.put(accent, new THREE.PlaneGeometry(1.1, 0.08), 0, y + 1.06, -0.56, Math.PI);
      if ((seed + k + t) % 5 === 0) f.prop('screen', 0, y + 0.5, -0.62, Math.PI);
    }
    // Ladder up the divider, a locker for whoever is in the stack, a night-light.
    if (k % 2 === 0) f.prop('ladder', -BAY / 2 + 0.28, 0, -0.62);
    if (k % 2 === 1) f.prop('footlocker', 0, 0, -2.2);
    if (k % 3 === 0) f.prop('nightLight', -BAY / 2 + 0.2, 0.5, -2.6);
    built++;
  }
  if (!built) return;

  const [mx, mz] = pol(am, r);
  const mYaw = out ? am + Math.PI : am;
  const g = frameAt(ctx, props, mx, mz, mYaw);
  g.quad('plazaOnDeck', span + 1.0, 3.0, 0, -D / 2 - 1.4, 0.08);
  g.put(accent, boxGeo(span, 0.16, 0.24, 1), 0, H + 0.5, -D / 2 - 0.1);
  ctx.sign(28, Math.min(span * 0.5, 7), 1.4, g.X(0, -D / 2 - 0.2), 3.1, g.Z(0, -D / 2 - 0.2), mYaw + Math.PI, { accent });
  for (let i = -1; i <= 1; i += 2) {
    g.prop('bulkheadLamp', (i * span) / 3, 3.5, -D / 2 + 0.2, Math.PI);
  }
  g.prop('waterPoint', span / 2 - 0.6, 0, -D / 2 - 1.1, Math.PI);
  g.actor(-span / 4, 0, -D / 2 - 1.6, { activity: 'talk', localYaw: Math.PI });
  g.actor(span / 4, 0, -D / 2 - 1.6, { activity: 'carry', localYaw: Math.PI * 0.6 });
  ctx.contact(mx, mz, span + 6);
  ctx.mmRect(mx, mz, span, ROW_D, am, 'rgba(60,110,120,0.55)', 'rgba(150,230,255,0.45)');
  ctx.roof(mx, H + 0.6, mz);
}

/* ------------------------------------------------------------------ */
/* Open dormitories                                                    */
/* ------------------------------------------------------------------ */

/**
 * A hall of bunk beds under the arcade: floor plate, back wall, a canopy on
 * posts, and rows of berths with a footlocker and a curtain rail apiece.
 *
 * No front wall. A dormitory you can see into from the walkway is the one piece
 * of sleeping accommodation on the deck that shows you what it is without your
 * having to walk into it, which is why there is one in every other sector.
 */
function dormHall(ctx, props, o) {
  const { r, out, a0, a1, seed, court } = o;
  const am = (a0 + a1) / 2;
  const [mx, mz] = pol(am, r);
  if (!siteClear(ctx, mx, mz, court)) return;
  const len = Math.min((a1 - a0) * r - 1.4, 28);
  if (len < 11) return;

  const D = ROW_D, H = 3.5;
  const yaw = out ? am + Math.PI : am;
  const f = frameAt(ctx, props, mx, mz, yaw);
  const accent = ctx.spec.accent;

  f.box('grate', len, 0.12, D - 0.3, 0, 0.06, 0.1);
  f.put('panel', boxGeo(len, H, WALL_T, 2), 0, H / 2, D / 2 - WALL_T / 2);
  f.sol(0, H / 2, D / 2 - WALL_T / 2, len / 2, H / 2, WALL_T / 2);
  f.put('panelDark', boxGeo(len + 0.3, 0.26, D + 0.3, 2), 0, H + 0.13, 0);
  f.sol(0, H + 0.13, 0, (len + 0.3) / 2, 0.13, (D + 0.3) / 2);
  f.put('emDim', new THREE.PlaneGeometry(len - 1.5, 0.3), 0, H - 0.45, D / 2 - WALL_T - 0.06, Math.PI);
  f.put(accent, boxGeo(len, 0.14, 0.22, 1), 0, H + 0.42, -D / 2 - 0.06);

  const bays = Math.max(3, Math.round(len / 5.4));
  for (let i = 0; i <= bays; i++) {
    const px = -len / 2 + (len * i) / bays;
    f.put('trim', boxGeo(0.22, H, 0.22, 1), px, H / 2, -D / 2 + 0.14);
    f.sol(px, H / 2, -D / 2 + 0.14, 0.11, H / 2, 0.11);
    // Curtain rail between every pair of berths, which is the only privacy a
    // dormitory has and the thing that stops it reading as a warehouse.
    if (i < bays) {
      f.put('trimDark', boxGeo(0.08, 0.08, D - 1.2, 1), px + len / (2 * bays), H - 0.5, 0.3);
    }
  }
  for (let i = 0; i < bays; i++) {
    const px = -len / 2 + ((i + 0.5) * len) / bays;
    for (const dx of [-0.75, 0.75]) {
      f.prop('bunkBed', px + dx, 0, 1.35);
      f.prop('footlocker', px + dx, 0, -0.55);
    }
    if (i % 3 === 0) f.prop('kitRack', px, 0, D / 2 - 0.65);
    if (i % 3 === 1) f.prop('bootRack', px + 1.5, 0, -2.1, Math.PI / 2);
    if (i % 2 === 0) f.prop('nightLight', px, 0.35, -D / 2 + 0.5);
    if (ctx.rng() < 0.25) {
      f.actor(px - 0.75, 0, 0.35, { activity: 'sit', amount: 0.68, localYaw: Math.PI });
    }
  }
  f.prop('waterPoint', -len / 2 + 0.8, 0, -D / 2 - 1.2, Math.PI);
  f.prop('trolley', len / 2 - 1.2, 0, -D / 2 - 1.3, Math.PI / 2);
  f.prop('notice', -len / 2 + 2.0, 1.6, D / 2 - WALL_T - 0.1, Math.PI);
  f.quad('plazaOnDeck', len + 1.0, 3.0, 0, -D / 2 - 1.4, 0.08);
  f.actor(len / 4, 0, -D / 2 - 1.7, { activity: 'walk', localYaw: Math.PI / 2, speed: 0.85 });
  ctx.sign(28, Math.min(len * 0.4, 6), 1.3, f.X(0, -D / 2 - 0.16), 3.0, f.Z(0, -D / 2 - 0.16), yaw + Math.PI, { accent });
  ctx.contact(mx, mz, len + 6);
  ctx.mmRect(mx, mz, len, ROW_D, am, 'rgba(90,120,100,0.5)', 'rgba(180,255,200,0.45)');
  ctx.roof(mx, H + 0.5, mz);
}

/* ------------------------------------------------------------------ */
/* Washrooms, drying rooms, linen stores                               */
/* ------------------------------------------------------------------ */

/**
 * The rooms a pod does not have space for. One in six cells, so no berth on the
 * deck is more than about forty metres from a shower.
 */
function serviceBlock(ctx, props, o) {
  const { r, out, a0, a1, seed, court } = o;
  const am = (a0 + a1) / 2;
  const [mx, mz] = pol(am, r);
  if (!siteClear(ctx, mx, mz, court)) return;
  const len = Math.min((a1 - a0) * r - 1.4, 24);
  if (len < 10) return;

  const D = ROW_D, H = 3.8;
  const yaw = out ? am + Math.PI : am;
  const f = frameAt(ctx, props, mx, mz, yaw);
  const accent = ctx.spec.accent;
  const use = ['washroom', 'drying', 'linen'][seed % 3];

  f.box('grate', len - 0.4, 0.14, D - 0.4, 0, 0.07, 0);
  f.put('panel', boxGeo(len, H, WALL_T, 2), 0, H / 2, D / 2 - WALL_T / 2);
  f.sol(0, H / 2, D / 2 - WALL_T / 2, len / 2, H / 2, WALL_T / 2);
  for (const s of [-1, 1]) {
    f.put('panelDark', boxGeo(WALL_T, H, D, 2), s * (len / 2), H / 2, 0);
    f.sol(s * (len / 2), H / 2, 0, WALL_T / 2, H / 2, D / 2);
  }
  f.put('panelDark', boxGeo(len + 0.3, 0.3, D + 0.3, 2), 0, H + 0.15, 0);
  f.sol(0, H + 0.15, 0, (len + 0.3) / 2, 0.15, (D + 0.3) / 2);
  // Front wall, split around two door openings.
  const pier = (len - 2 * 2.2) / 3;
  for (let i = 0; i < 3; i++) {
    const px = -len / 2 + pier / 2 + i * (pier + 2.2);
    f.put('panel', boxGeo(pier, H, WALL_T, 2), px, H / 2, -D / 2 + WALL_T / 2);
    f.sol(px, H / 2, -D / 2 + WALL_T / 2, pier / 2, H / 2, WALL_T / 2);
  }
  f.put('panel', boxGeo(len, H - 2.4, WALL_T, 2), 0, 2.4 + (H - 2.4) / 2, -D / 2 + WALL_T / 2);
  f.sol(0, 2.4 + (H - 2.4) / 2, -D / 2 + WALL_T / 2, len / 2, (H - 2.4) / 2, WALL_T / 2);
  f.put(accent, boxGeo(len - 1.5, 0.14, 0.2, 1), 0, 2.55, -D / 2 - 0.06);
  f.put('emDim', new THREE.PlaneGeometry(len - 2.0, 0.28), 0, H - 0.5, D / 2 - WALL_T - 0.06, Math.PI);

  const n = Math.max(3, Math.floor((len - 2) / 2.4));
  for (let i = 0; i < n; i++) {
    const px = -len / 2 + 1.2 + (i * (len - 2.4)) / (n - 1 || 1);
    if (use === 'washroom') {
      f.prop('shower', px, 0, 1.5);
      if (i % 2 === 0) f.prop('basin', px, 0, -1.6, Math.PI);
    } else if (use === 'drying') {
      f.prop('dryRack', px, 0, 1.3);
      if (i % 2 === 0) f.prop('bootRack', px, 0, -1.7, Math.PI);
    } else {
      f.prop('laundry', px, 0, 1.6);
      f.prop('laundry', px, 0.6, 1.6);
      if (i % 2 === 0) f.prop('trolley', px, 0, -1.5, Math.PI);
    }
    if (i % 4 === 0) f.prop('bulkheadLamp', px, 3.1, D / 2 - 0.35, Math.PI);
  }
  f.prop('waterPoint', -len / 2 + 1.0, 0, -D / 2 - 1.2, Math.PI);
  f.prop('notice', len / 2 - 1.6, 1.7, -D / 2 - 0.16, Math.PI);
  f.quad('plazaOnDeck', len + 1.0, 3.2, 0, -D / 2 - 1.5, 0.08);
  f.actor(-len / 4, 0, -D / 2 - 1.8, { activity: 'carry', localYaw: Math.PI * 0.4, speed: 0.9 });
  f.actor(len / 5, 0, -D / 2 - 1.6, { activity: 'stand', localYaw: Math.PI });
  ctx.sign(28, Math.min(len * 0.4, 5.5), 1.3, f.X(0, -D / 2 - 0.18), 3.1, f.Z(0, -D / 2 - 0.18), yaw + Math.PI, { accent });
  ctx.contact(mx, mz, len + 6);
  ctx.mmRect(mx, mz, len, ROW_D, am, 'rgba(70,110,130,0.55)', 'rgba(160,220,255,0.45)');
  if (seed % 2 === 0) ctx.roof(mx, H + 0.6, mz);
}

/* ------------------------------------------------------------------ */
/* Common bays and terrace yards                                       */
/* ------------------------------------------------------------------ */

/** A mess corner, a reading nook and a bank of comms booths between terraces. */
function commonBay(ctx, props, o) {
  const { r, out, a0, a1, seed, court } = o;
  const am = (a0 + a1) / 2;
  const [mx, mz] = pol(am, r);
  if (!siteClear(ctx, mx, mz, court)) return;
  const len = Math.min((a1 - a0) * r - 1.4, 26);
  if (len < 9) return;

  const yaw = out ? am + Math.PI : am;
  const f = frameAt(ctx, props, mx, mz, yaw);
  const accent = ctx.spec.accent;

  f.quad('plazaOnDeck', len, ROW_D + 2.2, 0, -0.4, 0.08);
  // A low screen wall along the back so the bay has a room's edge to it.
  f.put('panelWarm', boxGeo(len, 2.4, WALL_T, 2), 0, 1.2, ROW_D / 2 - WALL_T / 2);
  f.sol(0, 1.2, ROW_D / 2 - WALL_T / 2, len / 2, 1.2, WALL_T / 2);
  f.put(accent, boxGeo(len - 1.0, 0.12, 0.18, 1), 0, 2.5, ROW_D / 2 - 0.2);

  const n = Math.max(2, Math.floor(len / 6));
  for (let i = 0; i < n; i++) {
    const px = -len / 2 + ((i + 0.5) * len) / n;
    if ((seed + i) % 3 === 0) {
      f.prop('booth', px, 0, 1.5);
      f.prop('booth', px + 1.4, 0, 1.5);
      f.prop('notice', px + 0.7, 1.7, ROW_D / 2 - 0.3, Math.PI);
    } else if ((seed + i) % 3 === 1) {
      f.prop('table', px, 0, 0.9);
      f.prop('chair', px - 1.1, 0, 0.9, Math.PI / 2);
      f.prop('chair', px + 1.1, 0, 0.9, -Math.PI / 2);
      f.actor(px - 1.1, 0, 0.9, { activity: 'sit', amount: 0.52, localYaw: Math.PI / 2 });
    } else {
      f.prop('bench', px, 0, 1.2, Math.PI);
      f.prop('bush', px + 1.6, 0, 1.4);
      f.actor(px - 0.4, 0, 1.2, { activity: ctx.rng() > 0.5 ? 'sit' : 'talk', amount: 0.58, localYaw: Math.PI });
    }
    if (i % 2 === 0) f.prop('bulkheadLamp', px, 2.7, ROW_D / 2 - 0.3, Math.PI);
  }
  f.actor(0, 0, -2.4, { activity: 'talk', localYaw: 0.4 });
  ctx.contact(mx, mz, len + 5);
  ctx.mmRect(mx, mz, len, ROW_D, am, 'rgba(110,120,80,0.45)', 'rgba(230,255,180,0.4)');
}

/**
 * The gap between two blocks: paved apron on the walkway side, planting beds and
 * drying lines behind. Seven cells in ten are one of these, and they are the
 * reason a deck with seven hundred berths on it still has somewhere to stand.
 */
function yardBay(ctx, props, o) {
  const { r, out, a0, a1, seed, court } = o;
  const am = (a0 + a1) / 2;
  const [mx, mz] = pol(am, r);
  if (!siteClear(ctx, mx, mz, court)) return;
  const len = (a1 - a0) * r - 1.2;
  if (len < 6) return;

  const yaw = out ? am + Math.PI : am;
  const f = frameAt(ctx, props, mx, mz, yaw);
  f.quad('plazaOnDeck', len, 4.4, 0, -0.8, 0.08);

  const beds = Math.max(1, Math.floor(len / 7));
  for (let i = 0; i < beds; i++) {
    const bw = len / beds - 1.4;
    const px = -len / 2 + (i + 0.5) * (len / beds);
    f.box('panelDark', bw, 0.5, 1.9, px, 0.25, ROW_D / 2 - 1.2);
    f.sol(px, 0.25, ROW_D / 2 - 1.2, bw / 2, 0.25, 0.95);
    // One planting box per bed. Foliage is the cheapest prop in the zone and by
    // far the most numerous, which is exactly how a triangle budget disappears.
    f.prop('bush', px, 0.5, ROW_D / 2 - 1.2);
    if ((seed + i) % 3 === 0) f.prop('dryRack', px, 0, ROW_D / 2 - 2.9, Math.PI);
    else if ((seed + i) % 3 === 1) f.prop('kitRack', px, 0, ROW_D / 2 - 2.9, Math.PI);
    if ((seed + i) % 3 === 2) f.prop('bench', px, 0, -1.6, Math.PI);
    if ((seed + i) % 5 === 0) f.prop('bootRack', px + 1.4, 0, -2.0, Math.PI);
  }
  if (seed % 3 === 0) f.prop('waterPoint', len / 2 - 0.8, 0, -1.8, Math.PI);
  if (seed % 5 === 0) f.prop('trolley', -len / 2 + 1.0, 0, -1.6, Math.PI / 2);
  if (ctx.rng() < 0.22) {
    f.actor(-len / 5, 0, -1.4, { activity: ctx.rng() > 0.5 ? 'talk' : 'stand', localYaw: Math.PI });
  }
  if (ctx.rng() < 0.14) {
    f.actor(len / 5, 0, -2.2, { activity: 'walk', localYaw: Math.PI / 2, speed: 0.85 });
  }
  ctx.contact(mx, mz, len + 4);
}

/* ------------------------------------------------------------------ */
/* The court                                                           */
/* ------------------------------------------------------------------ */

/**
 * Low-rise terraces on the ground between the five hab stacks.
 *
 * Everything here is under 4 m, because the court's job is to show you five
 * towers and a dome and anything taller in it competes with them. The rows on
 * the 71 and 77 m rings only build in the gaps BETWEEN the stacks - `stackClear`
 * keeps both the buildings and the approaches to their front doors open.
 */
function courtTerraces(ctx, props) {
  for (let ri = 0; ri < COURT_ROWS.length; ri++) {
    const row = COURT_ROWS[ri];
    const sectors = row.gap ? 5 : 6;
    for (let s = 0; s < sectors; s++) {
      const step = (Math.PI * 2) / sectors;
      const off = row.gap ? Math.PI * 0.2 + step / 2 : 0;
      const half = (SPOKE_W / 2 + 1.2) / row.r;
      const a0 = s * step + off + half, a1 = (s + 1) * step + off - half;
      const cells = Math.max(1, Math.round(((a1 - a0) * row.r) / 22));
      for (let c = 0; c < cells; c++) {
        const ca0 = a0 + ((a1 - a0) * c) / cells;
        const ca1 = a0 + ((a1 - a0) * (c + 1)) / cells;
        buildCell(ctx, props, {
          kind: CELL_MIX[(ri * 23 + s * 13 + c * 7 + 5) % CELL_MIX.length],
          r: row.r, out: row.out, a0: ca0, a1: ca1,
          seed: ri * 5 + s * 3 + c + 2, court: true,
        });
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* The rim                                                             */
/* ------------------------------------------------------------------ */

/**
 * The last four metres before the perimeter wall: boot racks, water points,
 * night-lights and quiet-zone notices, hung off the wall rather than built
 * against it. Nothing here is taller than 3 m, which keeps the arcade's 27 m
 * ceiling clear by a very wide margin.
 */
function rimServices(ctx, props) {
  const R = 193.6;
  const N = 44;
  for (let i = 0; i < N; i++) {
    const a = ((i + 0.5) / N) * Math.PI * 2;
    const [lx, lz] = pol(a, R);
    if (reserved(lx, lz, 3)) continue;
    if (inSpoke(a, R, ARCADE_SPOKES)) continue;
    const f = frameAt(ctx, props, lx, lz, a + Math.PI);
    switch (i % 6) {
      case 0:
        f.prop('bootRack', 0, 0, -1.4, Math.PI);
        f.prop('kitbag', 0.9, 0, -1.5, 0.5);
        break;
      case 1:
        f.prop('waterPoint', 0, 0, -1.5, Math.PI);
        break;
      case 2:
        f.prop('dryRack', 0, 0, -1.4, Math.PI);
        break;
      case 3:
        f.prop('locker', -0.6, 0, -1.5, Math.PI);
        f.prop('locker', 0.4, 0, -1.5, Math.PI);
        break;
      case 4:
        f.prop('notice', 0, 1.8, -1.2, Math.PI);
        f.prop('bench', 0, 0, -2.4, Math.PI);
        break;
      default:
        f.prop('trolley', 0, 0, -1.6, Math.PI / 2);
        f.prop('laundry', 0.9, 0, -1.6);
        break;
    }
    if (i % 2 === 0) f.prop('bulkheadLamp', 0, 2.9, -1.0, Math.PI);
    if (i % 9 === 0) f.actor(0, 0, -3.2, { activity: 'stand', localYaw: Math.PI });
  }
}

/* ------------------------------------------------------------------ */
/* Communal                                                            */
/* ------------------------------------------------------------------ */

function commons(ctx, props) {
  const { rng, spec } = ctx;
  const accent = spec.accent;

  /* A garden in the middle of the court, under the dome. Planting is the one
   * thing a residential deck in vacuum would actually fight for, and it gives
   * the court a centre that is not another building. */
  const ring = new THREE.CircleGeometry(30, 48);
  ring.rotateX(-Math.PI / 2);
  uvScale(ring, 6, 6);
  ctx.put('plazaOnDeck', ring, 0, 0.11, 0);
  for (let i = 0; i < 22; i++) {
    const a = (i / 22) * Math.PI * 2;
    const rr = 12 + (i % 3) * 7;
    const lx = Math.cos(a) * rr, lz = Math.sin(a) * rr;
    ctx.put('panelDark', cylGeo(2.2, 2.5, 1.1, 10, 3), lx, 0.55, lz);
    ctx.solid(lx, 0.55, lz, 2.3, 0.55, 2.3);
    ctx.put('foliage', new THREE.SphereGeometry(1.9 + rng() * 0.6, 8, 6), lx, 2.0, lz);
    if (i % 4 === 0) {
      ctx.put('trim', cylGeo(0.12, 0.12, 4.2, 6, 2), lx + 3.0, 2.1, lz);
      ctx.put('emWhite', cylGeo(0.34, 0.34, 0.3, 8, 1), lx + 3.0, 4.3, lz);
    }
  }
  // Benches round the garden, which is where the seated actors go.
  const benches = [];
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + 0.2;
    const lx = Math.cos(a) * 34, lz = Math.sin(a) * 34;
    ctx.put('panelWarm', boxGeo(3.2, 0.4, 0.9, 2), lx, 0.48, lz, -a);
    ctx.put('trimDark', boxGeo(3.2, 0.7, 0.16, 1), lx, 0.9, lz, -a);
    ctx.solid(lx, 0.34, lz, 1.6, 0.34, 0.45, -a);
    ctx.contact(lx, lz, 5);
    benches.push({ lx, lz, a });
  }
  ctx._benches = benches;

  /* The laundry and the rec lounge, under the arcade either side of the
   * entrance - the two rooms a residential deck needs that a terrace block
   * cannot absorb. */
  for (const [side, label] of [[-1, 'laundry'], [1, 'lounge']]) {
    const lx = side * 58, lz = 132;
    const W = 22, D = 16, H = 5.2;
    ctx.box('panel', W, H, 0.3, lx, H / 2, lz + D / 2);
    ctx.solid(lx, H / 2, lz + D / 2, W / 2, H / 2, 0.15);
    for (const s of [-1, 1]) {
      ctx.box('panelDark', 0.3, H, D, lx + s * (W / 2), H / 2, lz);
      ctx.solid(lx + s * (W / 2), H / 2, lz, 0.15, H / 2, D / 2);
    }
    ctx.box('panelDark', W + 0.6, 0.4, D + 0.6, lx, H + 0.2, lz);
    ctx.solid(lx, H + 0.2, lz, (W + 0.6) / 2, 0.2, (D + 0.6) / 2);
    for (const s of [-1, 1]) {
      ctx.box('panel', 6, H, 0.3, lx + s * 8, H / 2, lz - D / 2);
      ctx.solid(lx + s * 8, H / 2, lz - D / 2, 3, H / 2, 0.15);
    }
    ctx.box('panel', 10, H - 3.2, 0.3, lx, 3.2 + (H - 3.2) / 2, lz - D / 2);
    ctx.solid(lx, 3.2 + (H - 3.2) / 2, lz - D / 2, 5, (H - 3.2) / 2, 0.15);
    ctx.put(accent, boxGeo(9, 0.14, 0.2, 1), lx, 3.3, lz - D / 2 - 0.2);
    ctx.box('grate', W - 0.8, 0.12, D - 0.8, lx, 0.06, lz);
    ctx.floorQuad('plazaOnDeck', W + 4, 5, lx, lz - D / 2 - 3.0, 0, 0.08);

    if (label === 'laundry') {
      for (let i = 0; i < 8; i++) {
        const dx = -8 + (i % 4) * 5.2, dz = i < 4 ? 5 : -1;
        ctx.put('shell', boxGeo(2.2, 2.0, 1.8, 1.5), lx + dx, 1.0, lz + dz);
        ctx.put('glassWindow', new THREE.PlaneGeometry(1.1, 1.1), lx + dx, 1.3, lz + dz - 0.92, Math.PI);
        ctx.solid(lx + dx, 1.0, lz + dz, 1.1, 1.0, 0.9);
        props.add('laundry', lx + dx, 2.0, lz + dz);
        if (i % 2 === 0) props.add('trolley', lx + dx + 2.2, 0, lz + dz - 2.4);
      }
    } else {
      for (let i = 0; i < 5; i++) {
        const dx = -8 + i * 4;
        ctx.put('panelWarm', boxGeo(3.0, 0.45, 1.6, 1.5), lx + dx, 0.5, lz + 4);
        ctx.put('trimDark', boxGeo(3.0, 0.8, 0.2, 1), lx + dx, 1.0, lz + 4.8);
        ctx.solid(lx + dx, 0.4, lz + 4, 1.5, 0.4, 0.8);
        props.add('table', lx + dx, 0, lz + 1.0);
        props.add('chair', lx + dx - 1.2, 0, lz + 1.0, Math.PI / 2);
        addActor(ctx, lx + dx, 0, lz + 4, { activity: 'sit', amount: 0.72, localYaw: Math.PI });
      }
      ctx.put('holo', boxGeo(7, 3.4, 0.06, 1), lx, 2.6, lz + D / 2 - 0.4);
    }
    for (let i = 0; i < 4; i++) props.add('booth', lx - 9 + i * 2.2, 0, lz - D / 2 + 1.6);
    ctx.mmRect(lx, lz, W, D, 0, 'rgba(80,120,110,0.5)', 'rgba(150,240,210,0.45)');
    ctx.contact(lx, lz, Math.max(W, D) + 4);
    ctx.roof(lx, H + 0.6, lz);
  }

  ctx.sign(28, 9, 2.3, 0, 8.5, 118, 0, { twoSided: true, accent });
  ctx.sign(28, 6, 1.6, 0, 5.2, 45, Math.PI, { twoSided: true, accent });
}

/* ------------------------------------------------------------------ */
/* Rewards                                                             */
/* ------------------------------------------------------------------ */

/**
 * Authored collectables. A fixed list rather than one per terrace: the deck
 * carries hundreds of near-identical modules and a relic in every ninth of them
 * is not a hunt, it is a tax on walking in a straight line.
 */
function relics(ctx) {
  const spots = [
    [0, 1.2, 20, 'common'], [-26, 1.2, 22, 'common'], [30, 1.2, -18, 'common'],
    [-44, 0.8, 40, 'common'], [52, 0.8, 34, 'common'], [-8, 0.8, -52, 'rare'],
    [62, 0.8, 62, 'common'], [-70, 0.8, -30, 'common'], [12, 0.8, -96, 'rare'],
    [-96, 0.8, 40, 'common'], [88, 0.8, -66, 'common'], [-34, 0.8, 108, 'common'],
    [126, 0.8, 26, 'common'], [-118, 0.8, 44, 'rare'], [60, 0.8, -128, 'common'],
    [-140, 0.8, -58, 'common'], [148, 0.8, 62, 'rare'], [-72, 0.8, 156, 'common'],
    [24, 0.8, 178, 'common'], [-168, 0.8, 70, 'common'], [96, 0.8, -158, 'prize'],
  ];
  for (const [lx, ly, lz, tier] of spots) ctx.relic(lx, ly, lz, tier);
}

/* ------------------------------------------------------------------ */
/* Population                                                          */
/* ------------------------------------------------------------------ */

function population(ctx) {
  const { rng } = ctx;

  // Residents on the garden benches - talking in pairs, which is what a bench
  // outside a block of flats is for.
  for (const b of ctx._benches ?? []) {
    const seats = 1 + Math.floor(rng() * 2);
    for (let i = 0; i < seats; i++) {
      const off = (i - (seats - 1) / 2) * 1.1;
      addActor(
        ctx, b.lx + Math.cos(-b.a) * off, 0, b.lz - Math.sin(-b.a) * off,
        { activity: rng() > 0.45 ? 'talk' : 'sit', amount: 0.68, localYaw: -b.a + Math.PI / 2 }
      );
    }
  }

  // On the walkways: one band per paved ring, so the crowd follows the street
  // plan rather than being sprinkled over the buildings.
  const walks = [
    [116, 26], [122, 18], [139.6, 22], [157.7, 22], [175.8, 22], [193, 12],
    [40.5, 12], [62, 14], [88, 20],
  ];
  for (const [r, count] of walks) {
    for (let i = 0; i < count; i++) {
      const a = ((i + 0.5) / count) * Math.PI * 2 + rng() * 0.12;
      const rr = r + (rng() - 0.5) * 3.4;
      const [lx, lz] = pol(a, rr);
      if (lz > 138 && Math.abs(lx) < 32) continue;
      const roll = rng();
      addActor(ctx, lx, 0, lz, {
        activity: roll < 0.3 ? 'stand' : roll < 0.56 ? 'talk' : roll < 0.84 ? 'walk' : 'carry',
        localYaw: a + (rng() - 0.5),
        speed: 0.8 + rng() * 0.5,
      });
    }
  }

  // Crossing the court and the arrival plaza.
  for (let i = 0; i < 30; i++) {
    const a = rng() * Math.PI * 2;
    const rr = 34 + rng() * 70;
    const [lx, lz] = pol(a, rr);
    if (!stackClear(lx, lz, -6)) continue;
    addActor(ctx, lx, 0, lz, {
      activity: rng() > 0.3 ? 'walk' : 'talk',
      localYaw: rng() * Math.PI * 2,
      speed: 0.9 + rng() * 0.4,
    });
  }
  for (let i = 0; i < 12; i++) {
    addActor(ctx, -22 + rng() * 44, 0, 146 + rng() * 30, {
      activity: rng() > 0.5 ? 'walk' : 'stand',
      localYaw: rng() * Math.PI * 2,
      speed: 0.9 + rng() * 0.4,
    });
  }
}

/* ------------------------------------------------------------------ */
/* The hab stacks                                                      */
/* ------------------------------------------------------------------ */

function habStacks(ctx) {
  const { spec } = ctx;
  const accent = spec.accent;

  /* Five stacks on a 78 m ring, rotated to face the court so every entrance is
   * visible from the middle. An even ring rather than a grid because the court
   * is a circle and a grid in a circle wastes the corners - and because five
   * towers at 72 degrees leaves a clean sightline between each pair out to the
   * dome. */
  const RING = 78;
  const stacks = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + Math.PI * 0.2;
    const lx = Math.sin(a) * RING;
    const lz = Math.cos(a) * RING;
    // 7, 8 or 9 storeys. Seven is the floor the brief asks for; the variation
    // is what stops five identical towers reading as a placed asset.
    const floors = 7 + (i % 3);
    const w = 24, d = 22;

    /* Face the court: the entrance is tower-local -Z, so the tower's yaw is
     * the heading it stands on, NOT that heading reversed.
     *
     * The comment here has always said "front at the zone centre" and the code
     * under it said `yawOf(a + Math.PI)`, which does the opposite.
     * `GeoBatch.localAt` and `buildTower`'s own `P` both send tower-local +Z to
     * the heading they are given, so `a + PI` - the direction from the stack
     * back to the middle of the court - points the tower's BACK at the court
     * and its door at the rim. Measured: with `a + PI` the door of stack C
     * lands 89.5 m from the zone centre while the building itself stands at
     * 78; with `a` it lands at 66.5, which is what the comment meant.
     *
     * The zone already contained the evidence. The entrance practical below is
     * placed at `lx - sin(a) * 14`, fourteen metres INWARD of the stack - it
     * has always been lighting the side the door was supposed to be on, and
     * for five towers it has been lighting a blank wall.
     *
     * `buildZoneTower` now owns the frame, the `_selfCollided` registration,
     * the rooftop and the minimap footprint, so the other three zones get the
     * same building without the same four things to remember.
     */
    const { roofY } = buildZoneTower(ctx, {
      bearing: a, r: RING, w, d, floors,
      label: `Hab Stack ${String.fromCharCode(67 + i)}`,
      body: i % 2 ? 'panelWarm' : 'panel',
      fit: 'hab',
    });
    stacks.push({ lx, lz, a, floors, roofY, w, d });

    // A practical at the entrance, so the door is legible from across the court.
    const lp = ctx.P(lx - Math.sin(a) * 14, 6, lz - Math.cos(a) * 14);
    const light = new THREE.PointLight(spec.accentHex, 1500, 46, 2);
    light.position.copy(lp);
    light.castShadow = false;
    ctx.group.add(light);
  }

  /* Skybridges between neighbouring stacks.
   *
   * Deck height comes from the SHORTER of the two towers, at a floor plate that
   * still leaves the bridge's own section under that tower's roof slab. The hub
   * has exactly this bug on record - a bridge landing 1.1 m below the short
   * tower's roof, connecting to no floor at all - and the arithmetic here is
   * the fix from that, reused. */
  for (let i = 0; i < 5; i++) {
    const a = stacks[i], b = stacks[(i + 1) % 5];
    const shorter = Math.min(a.floors, b.floors);
    const floor = Math.max(2, shorter - 3);
    const y = floor * FLOOR_H;
    const mx = (a.lx + b.lx) / 2, mz = (a.lz + b.lz) / 2;
    const len = Math.hypot(b.lx - a.lx, b.lz - a.lz) - a.d;
    if (len < 6) continue;
    const bYaw = Math.atan2(b.lx - a.lx, b.lz - a.lz);

    ctx.put('grate', boxGeo(3.4, 0.4, len, 2), mx, y, mz, bYaw);
    ctx.put('panelDark', boxGeo(4.0, 0.7, len, 2), mx, y - 0.55, mz, bYaw);
    ctx.solid(mx, y - 0.2, mz, 1.7, 0.3, len / 2, bYaw);
    for (const s of [-1.75, 1.75]) {
      const ox = Math.cos(bYaw) * s, oz = -Math.sin(bYaw) * s;
      ctx.put('glassWindow', new THREE.PlaneGeometry(len, 2.0), mx + ox, y + 1.2, mz + oz, bYaw + (s > 0 ? -Math.PI / 2 : Math.PI / 2));
      ctx.put('trim', boxGeo(0.14, 0.14, len, 1), mx + ox, y + 2.3, mz + oz, bYaw);
      ctx.put(accent, boxGeo(0.08, 0.08, len, 1), mx + ox, y + 2.4, mz + oz, bYaw);
      ctx.solid(mx + ox, y + 1.2, mz + oz, 0.12, 1.2, len / 2, bYaw);
    }
    ctx.put('trim', boxGeo(4.2, 0.25, len, 2), mx, y + 2.65, mz, bYaw);
    ctx.mmPath([[a.lx, a.lz], [b.lx, b.lz]], 'rgba(140,255,215,0.35)', 3, false);
    // A bridge is the best vantage in the zone, so it is worth something.
    if (i % 2 === 0) ctx.relic(mx, y + 0.7, mz, 'rare');
  }
}



