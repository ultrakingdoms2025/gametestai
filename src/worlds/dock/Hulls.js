import * as THREE from 'three';
import { SKIN, DECK_T, KESTREL, DRAY, PIKE, BASTION } from './HullPlan.js';
import { slidePocket } from './ShipKit.js';
import { yardSignUV, YARD_SIGN } from './YardTextures.js';
import { shipParts } from '../../ships/ShipAssets.js';

/**
 * THE FOUR HULLS OF LODESTAR YARD.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  FOUR MACHINES, NOT ONE SHAPE LANGUAGE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This file used to open by saying that every hull in the shed is a stack of
 * plated drums with a bolted flange over each joint, because a hull
 * re-assembled from sections narrow enough to walk through a gateway arch is a
 * stack of drums, and because slab sides are what the climb wants. Both halves
 * of that were true and the result was four variations on one silhouette —
 * which, from thirty metres in a dark shed, is one ship parked four times.
 *
 * The priority is inverted now: **shape for the look first, and keep the climb
 * wherever the shape affords it.** What that changed, and what it did not:
 *
 * - **Free-climbing still takes any face within 30 degrees of vertical, and a
 *   swept hull still gives the probe a different normal every 20 cm.** So the
 *   grip faces are still flat and still vertical — but only the BANDS need to
 *   be, and a band is one station on one flank. Everywhere else is lofted.
 *   {@link sec} is the compromise written as a function: vertical at the waist
 *   where a hand goes, chamfered at the quarters where the silhouette is.
 * - **Plan taper is free.** The climb reads `normal.y`; yawing a facet in plan
 *   does not change it at all. Every nose, tail and bow in this file is a loft
 *   now and not one of them cost a move.
 * - **The lore adapts.** Sections and bolted joints survive as detail on a
 *   shaped hull. A seam does not have to be a step.
 *
 * The four, measured off the built exterior in each hull's own frame by
 * `dock-hulls.test.mjs` — `parallel` is the share of the length carried at
 * full beam, which is the one number that says "drum":
 *
 * | hull    | len  | beam   | crown | slender | parallel | interior           |
 * |---------|------|--------|-------|---------|----------|--------------------|
 * | Kestrel | 14 m |  9.2 m | 6.36  | 1.52    | 0.27     | cockpit + cabin    |
 * | Dray    | 28 m | 13.4 m | 8.14  | 2.09    | 0.19     | hold, engine, cab  |
 * | Pike    | 18 m | 11.2 m | 5.80  | 1.61    | 0.12     | cockpit + gun bay  |
 * | Bastion | 44 m | 26.8 m | 9.54  | 1.64    | 0.15     | none — unfinished  |
 *
 * `beam` is the 90th percentile across 44 stations, so the Kestrel's is over
 * its pods and the Bastion's includes the engine bell standing beside her
 * cradle; the test says why. The hull beams this table used to quote — the
 * ones the plan still calls `lower.hw * 2` — are 4.6 / 10.4 / 4.7 / 16.0, and
 * three of those four are unchanged: what moved is everything hung on them.
 *
 * What each one is trying to be, in one line, because that is the thing a
 * later change can most easily undo without noticing:
 *
 * - **Kestrel, a courier.** Needle nose, raised glasshouse, V-tail, and two
 *   engine pods carried outboard on pylons. The pods are the silhouette.
 * - **Dray, an ore tender.** Bluff raked bow, open well deck, bridge castle
 *   aft, a lattice derrick over the hatch, ore hoppers to port and a radiator
 *   bank to starboard. The asymmetry is deliberate and it is the only one in
 *   the yard.
 * - **Pike, an interceptor.** A spike with two cannon running past its tip,
 *   a swept diamond wing flat over and knife under, a tapered fin.
 * - **Bastion, a dead frigate.** Half her plating is off and her frames are
 *   standing in the gaps; two empty barbettes and a conning tower on top.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE RULES EVERY BUILDER IN THIS FILE FOLLOWS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. **The shell is separate walls, never one box.** A single box the size of
 *    the section fills the interior. Segments plus a lintel per opening,
 *    exactly `InteriorKit.js:361-373`, which is what {@link plated}'s
 *    `opening` argument is for.
 * 2. **A deck plate's TOP is the ledge outside and its UNDERSIDE is the ceiling
 *    inside** — one slab, two jobs. Anything else is either a ledge with
 *    nothing under it, or a full-plan member hanging in a room under its own
 *    ceiling, which is the defect that put 251 of 407 z-fighting hits and one
 *    sealed atrium into the medieval world.
 * 3. **NO GUARD RAIL ON ANY HULL, and that is a measurement.**
 *    `Climb._probe` finds the top of the wall it grabbed by firing a ray
 *    DOWNWARD from `0.14 m` inside the far face. A rail standing on a deck edge
 *    is exactly what that ray lands on, so the "top" comes back as the handrail
 *    at `deck + 1.05` and the rise falls outside `[0.25, 2.4]` — the mantle is
 *    refused and the ledge the whole climb is banded around becomes unusable.
 *    Moving the rail inboard does not fix it either: the landing point is
 *    `0.77 m` in from the edge and the capsule is `0.35 m` in radius, so a rail
 *    anywhere inside `1.12 m` pushes the capsule more than the `0.20 m`
 *    `Climb` allows before it gives up. Hazard stripes at every deck edge
 *    instead — which is also what a hull in a fitting-out bay actually has, and
 *    the reason the yard's own gantry is railed and its ships are not. This is
 *    drop one's signal-post defect (a published viewpoint fenced across its
 *    only entrance) caught before it was built.
 * 4. **Nothing is drawn that the player can touch and not collide.**
 *    `CitadelWorld.js:1495`: "a detail the player can see and not grab would be
 *    a lie." The exceptions are named at each site and are all overhead.
 * 5. **The interior goes into a second batch** so it can be LOD-banded at 40 m
 *    on its own, and **colliders are never split** — every `cbox` registers
 *    regardless of what is drawn, so a player walking into a hold never falls
 *    through a floor that has not faded up.
 * 6. **No canopy in this yard gets a painted room quad.** The station deleted
 *    its hangar mezzanine's `paintRoomGlow` billboard rather than turning it
 *    round, because "the room behind the glass is real now and a painted one in
 *    front of it would be hiding it". The cockpit behind the glass is the
 *    feature.
 */

/* ------------------------------------------------------------------ */
/* Shared shell pieces                                                 */
/* ------------------------------------------------------------------ */

/**
 * One plated section: two flanks and two transverse caps, hollow inside.
 *
 * The flanks' OUTER faces land exactly on `hw`, which is what the climb probe
 * measures against and what `HullPlan`'s `stepIn` arithmetic assumes.
 *
 * `o.opening` is `{ side, z0, z1, top }` and turns ONE flank into segments plus
 * a lintel. It exists because a hatch cut into a flank that was already built
 * as a solid box is a hatch that opens onto plating.
 */
function plated(b, s, key = 'hull', o = {}) {
  const t = o.t ?? SKIN;
  const len = s.z1 - s.z0, cz = (s.z0 + s.z1) / 2;
  const h = s.y1 - s.y0, cy = (s.y0 + s.y1) / 2;
  for (const sg of [-1, 1]) {
    if (o.opening && o.opening.side === sg) {
      b.wallZ(key, sg * (s.hw - t / 2), s.z0, s.z1, s.y0, s.y1,
        o.opening.z0, o.opening.z1, o.opening.top - s.y0, t);
    } else {
      b.cbox(key, t, h, len, sg * (s.hw - t / 2), cy, cz, 0, 2.5);
    }
  }
  if (o.capFore !== false) b.cbox(key, (s.hw - t) * 2, h, t, 0, cy, s.z1 - t / 2, 0, 2.5);
  if (o.capAft !== false) b.cbox(key, (s.hw - t) * 2, h, t, 0, cy, s.z0 + t / 2, 0, 2.5);
}

/**
 * Cut a boarding hatch out of a flank, and tell the rest of the hull about it.
 *
 * ── Why this is one call and not two ─────────────────────────────────────
 * `plated(..., { opening })` has always taken the hole out of the PLATING, and
 * for the whole of this world's life that was the only pass that knew a hatch
 * existed. Six others did not: relief, panel lines, section ribs, two string
 * courses, their bolt rows and the berth stencil all ran straight over the
 * opening. Fired inboard from 1.6 m outside on a 9 x 9 fan, **80 of 81 samples
 * through the Kestrel's boarding aperture were stopped before they reached the
 * plating** — the doorway was a hole in one layer and solid in the next. That
 * is the player's "the entrance still has the ships side covering it", and it
 * is the medieval ore-bench defect (a building whose own furniture stood across
 * its own entrance) with a different noun.
 *
 * So the declaration and the cut are the same statement. The plan's `hatch`
 * record is the only input, `slidePocket` is the only arithmetic, and
 * `ShipBuild.clearOfAperture` / `flankRuns` are what every later pass asks.
 *
 * @param {1|-1} side which flank the hatch is in
 * @param {{lz:number,w:number,h:number}} hatch the plan's own record
 * @param {number} deckY the local height of the threshold
 */
function flankAperture(b, section, side, hatch, deckY, key = 'hull') {
  b.aperture(side, 'z',
    hatch.lz - slidePocket(hatch.w), hatch.lz + slidePocket(hatch.w),
    deckY - 0.08, deckY + hatch.h + 0.30);
  plated(b, section, key, {
    opening: {
      side,
      z0: hatch.lz - hatch.w / 2,
      z1: hatch.lz + hatch.w / 2,
      top: deckY + hatch.h,
    },
  });
}

/* ------------------------------------------------------------------ */
/* Shaped surfaces: the loft                                           */
/* ------------------------------------------------------------------ */

/**
 * ONE CROSS-SECTION OF A HULL, AS AN OCTAGON.
 *
 * The middle band of each flank is VERTICAL and lands exactly on `hw`, and the
 * chamfers are taken out of the top and the bottom. That split is the whole
 * reason a shaped hull is still a climbable one: `FreeClimb` takes any face
 * whose `|normal.y| <= 0.5` and a 45-degree chamfer reads 0.71, so a hull
 * chamfered from deck to keel is a hull with no grip anywhere. Chamfer the
 * quarters, leave the waist alone, and the fan still finds a wall at `hw`
 * while the silhouette stops being a rectangle.
 *
 * `tw`/`bw` are the deck and keel half-widths — they are what makes the
 * section a tumblehome or a flare rather than a box with its corners knocked
 * off — and `ct`/`cb` are how far up the flank those chamfers reach.
 */
function sec(hw, y0, y1, o = {}) {
  const ct = o.ct ?? 0;
  const cb = o.cb ?? 0;
  const tw = Math.max(0.01, o.tw ?? hw - ct);
  const bw = Math.max(0.01, o.bw ?? hw - cb);
  const yt = y1 - (o.cth ?? ct);
  const yb = y0 + (o.cbh ?? cb);
  return [
    [-bw, y0], [bw, y0],
    [hw, yb], [hw, yt],
    [tw, y1], [-tw, y1],
    [-hw, yt], [-hw, yb],
  ];
}

/** Linear blend of two sections with the same point count. */
function blend(a, c, t) {
  return a.map((p, i) => [p[0] + (c[i][0] - p[0]) * t, p[1] + (c[i][1] - p[1]) * t]);
}

/**
 * A LOFTED SKIN: consecutive station polygons stitched edge to edge.
 *
 * ── Why this is drawn geometry and never a collider ─────────────────────────
 * `ShipKit`'s header states the trade and this is the thing that spends it:
 * "draw whatever swept form you like, collide a stack of yawed boxes."
 * `CitadelWorld.js:71-74` is the reason a loft may not be collided directly —
 * a triangle soup hands the climb probe a different normal every facet and
 * makes ledge detection chatter along the whole flank. So every loft in this
 * file is accompanied by `solid()` boxes inscribed in it, and the two are
 * written next to each other so they cannot drift apart unnoticed.
 *
 * Built in its OWN frame — sections in XY, extruded along +Z — and placed with
 * `b.put`, which is what lets the same function draw a hull nose, an engine
 * pod and a wing panel: a wing is a loft placed at `ry = PI/2`.
 *
 * Flat-shaded on purpose. Every other surface in this yard is a box face, and
 * a smoothly-shaded hull beside a hard-edged shed reads as a different game.
 *
 * @param {{z:number, pts:[number,number][]}[]} stations increasing in z
 * @returns {THREE.BufferGeometry} position + normal + uv, non-indexed
 */
function loftGeo(stations, o = {}) {
  const tile = o.tile ?? 2;
  const n = stations[0].pts.length;
  const pos = [], nrm = [], uvs = [];
  const ax = new THREE.Vector3(), bx = new THREE.Vector3(), cx = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nn = new THREE.Vector3();
  const tri = (p, q, r, up, uq, ur) => {
    ax.set(p[0], p[1], p[2]); bx.set(q[0], q[1], q[2]); cx.set(r[0], r[1], r[2]);
    e1.subVectors(bx, ax); e2.subVectors(cx, ax);
    nn.crossVectors(e1, e2);
    // A zero-area facet is a chamfer somebody set to 0. Dropping it is what
    // lets one section function serve a boxy midships and a knife-edge nose.
    if (nn.lengthSq() < 1e-10) return;
    nn.normalize();
    pos.push(ax.x, ax.y, ax.z, bx.x, bx.y, bx.z, cx.x, cx.y, cx.z);
    for (let i = 0; i < 3; i++) nrm.push(nn.x, nn.y, nn.z);
    uvs.push(up[0], up[1], uq[0], uq[1], ur[0], ur[1]);
  };
  /* `u` is arc length round the section and `v` is distance along it, both in
   * metres over `tile` — the same constant-texel-density rule `boxUV` applies
   * to every box in this world, so a lofted nose and the plated drum behind it
   * carry the same plate size. */
  const us = stations.map((s) => {
    const acc = [0];
    for (let k = 1; k <= n; k++) {
      const p = s.pts[k - 1], q = s.pts[k % n];
      acc.push(acc[k - 1] + Math.hypot(q[0] - p[0], q[1] - p[1]));
    }
    return acc;
  });
  for (let i = 0; i < stations.length - 1; i++) {
    const s0 = stations[i], s1 = stations[i + 1];
    const v0 = s0.z / tile, v1 = s1.z / tile;
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      const a = [s0.pts[k][0], s0.pts[k][1], s0.z];
      const c = [s0.pts[k1][0], s0.pts[k1][1], s0.z];
      const d = [s1.pts[k1][0], s1.pts[k1][1], s1.z];
      const e = [s1.pts[k][0], s1.pts[k][1], s1.z];
      const ua = us[i][k] / tile, uc = us[i][k + 1] / tile;
      const ud = us[i + 1][k + 1] / tile, ue = us[i + 1][k] / tile;
      tri(a, c, d, [ua, v0], [uc, v0], [ud, v1]);
      tri(a, d, e, [ua, v0], [ud, v1], [ue, v1]);
    }
  }
  const cap = (s, fore) => {
    let mx = 0, my = 0;
    for (const p of s.pts) { mx += p[0]; my += p[1]; }
    mx /= n; my /= n;
    const c0 = [mx, my, s.z], uc0 = [mx / tile, my / tile];
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      const p = [s.pts[k][0], s.pts[k][1], s.z];
      const q = [s.pts[k1][0], s.pts[k1][1], s.z];
      const up = [s.pts[k][0] / tile, s.pts[k][1] / tile];
      const uq = [s.pts[k1][0] / tile, s.pts[k1][1] / tile];
      if (fore) tri(c0, p, q, uc0, up, uq);
      else tri(c0, q, p, uc0, uq, up);
    }
  };
  if (o.capFore) cap(stations[stations.length - 1], true);
  if (o.capAft) cap(stations[0], false);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return g;
}

/**
 * Draw a loft and collide it with boxes inscribed at each segment's waist.
 *
 * INSCRIBED, and that is the choice rather than circumscribed: a collider
 * wider than the skin is a body stopped in mid-air a hand's breadth off the
 * plating, which is the complaint `station/Tower.js:425` records; a collider
 * narrower than the skin is a body that clips the last few centimetres of a
 * fairing nobody stands on. The second is the cheaper mistake, so every
 * collider here is the box that fits INSIDE the two stations it spans.
 *
 * `o.grip` names stations whose flank must be met exactly rather than
 * inscribed — a face a climb band is aimed at. Passed as `[i, hw]` pairs.
 */
function loftSolid(b, key, stations, o = {}) {
  b.put(key, loftGeo(stations, o), 0, 0, 0);
  if (o.collide === false) return;
  const grip = o.grip ?? {};
  for (let i = 0; i < stations.length - 1; i++) {
    const s0 = stations[i], s1 = stations[i + 1];
    let hx = Infinity, y0 = -Infinity, y1 = Infinity;
    for (const s of [s0, s1]) {
      let mx = 0, lo = Infinity, hi = -Infinity;
      for (const p of s.pts) { mx = Math.max(mx, Math.abs(p[0])); lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); }
      hx = Math.min(hx, mx);
      y0 = Math.max(y0, lo); y1 = Math.min(y1, hi);
    }
    if (grip[i] != null) hx = grip[i];
    if (hx < 0.03 || y1 - y0 < 0.03) continue;
    b.solid(0, (y0 + y1) / 2, (s0.z + s1.z) / 2, hx, (y1 - y0) / 2, (s1.z - s0.z) / 2);
  }
}

/**
 * THE UNDERBODY, AND IT IS THE ONE FLAT THIS HULL WAS FREE TO SHAPE.
 *
 * ── What was measured ──────────────────────────────────────────────────────
 * The player's verdict is "spaceships do not look like spaceships, they look
 * like they are made of square blocks", and it is measurable. Taking every
 * drawn triangle whose outward normal ESCAPES the hull - i.e. the skin a player
 * can actually see, not the inside faces of boxes - and binning the
 * axis-aligned area by direction and by height band:
 *
 *              visible skin   axis-aligned   of which, the flat underside
 *   kestrel      279 m^2         65.1%        41.9 m^2  = 15.0% of the skin
 *   dray       1,227 m^2         80.4%       238.9 m^2  = 19.5%
 *   pike         385 m^2         77.5%        57.6 m^2  = 15.0%
 *
 * The underside was the single largest contiguous flat on all three, and it
 * was ONE BOX: `cbox('hull', belly.hw * 2, belly.y1 - belly.y0, ...)`. It is
 * also the only large surface on these hulls that is free to be shaped. The
 * flanks are not - `sec`'s own note records why: a room's half-beam IS the
 * flank minus `SKIN`, so any tumblehome between the sole and the deckhead eats
 * the compartment behind it - and the weather decks are not, because they are
 * walked on and `dock-reach` floods them.
 *
 * Below the sole there is nothing. So the box becomes a lofted keel:
 *
 *   - the TOP outline is untouched, `belly.hw` at every station, so the joint
 *     with the plated section above it is exactly the one the box made and
 *     nothing above the keel line has to move;
 *   - the bottom is a narrow flat of `bw`, with a chine rising outboard to the
 *     full beam - the section is a hexagon, not a rectangle;
 *   - and the keel has ROCKER: it lifts toward both ends, so the underside is
 *     a curved surface along its length rather than a plane, and the flat that
 *     survives is 0.42 of the beam over the middle third instead of the whole
 *     of it.
 *
 * `loftSolid` collides it with boxes inscribed in the skin, which is the rule
 * every other loft in this file follows, and nothing climbs a belly.
 *
 * @param {import('./ShipKit.js').ShipBuild} b
 * @param {object} H the hull plan
 * @param {{n?:number, bw?:number, rise?:number, chine?:number, tile?:number,
 *          power?:number}} [o]
 */
function keel(b, H, o = {}) {
  const B = H.belly;
  const depth = B.y1 - B.y0;
  const n = o.n ?? 9;
  /* Half-width of the flat of the keel amidships. 0.42 rather than something
   * smaller because a hull with a knife underbody sits on a cradle in this
   * world, and the saddles bear on the flat. */
  const bw = o.bw ?? B.hw * 0.42;
  /* How far the keel lifts at the ends, as a fraction of the belly's own
   * depth. Capped at 0.86 so the loft never inverts. */
  const rise = Math.min(depth * 0.86, o.rise ?? depth * 0.62);
  const chine = o.chine ?? depth * 0.74;
  /* `power` shapes the rocker: 1 is a straight V from end to end, high values
   * keep the middle run level and turn up only near the ends. 2.6 gives a flat
   * middle third, which is what the cradle wants and what a landing gear
   * would stand on. */
  const p = o.power ?? 2.6;
  const st = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const u = Math.pow(Math.abs(t * 2 - 1), p);
    const z = B.z0 + (B.z1 - B.z0) * t;
    const y0 = B.y0 + rise * u;
    const kb = Math.max(0.06, bw * (1 - 0.78 * u));
    const cb = Math.min(B.y1 - y0 - 0.02, chine * (1 - 0.45 * u));
    st.push({ z, pts: sec(B.hw, y0, B.y1, { cb, ct: 0, bw: kb, tw: B.hw }) });
  }
  loftSolid(b, 'hull', st, { tile: o.tile ?? 3, capAft: true, capFore: true });
}

/**
 * A tapered lattice member — a derrick boom, a mast, a crane jib.
 *
 * Two chords and a zig-zag of web between them, which is the cheapest thing
 * that reads as structure rather than as a pole: 24 boxes for a 12 m boom, one
 * bucket, no draw call of its own. Drawn only, and named as one of rule 4's
 * overhead exceptions — every one of these is at least 2 m over the highest
 * deck a body stands on.
 */
function lattice(b, key, x0, y0, z0, x1, y1, z1, o = {}) {
  const w = o.w ?? 0.5;
  const t = o.t ?? 0.1;
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz);
  const bays = Math.max(2, Math.round(len / (o.bay ?? 1.6)));
  const pitch = Math.atan2(dy, Math.hypot(dx, dz));
  const yaw = Math.atan2(dx, dz);
  const at = (u, s) => [
    x0 + dx * u + s * w * Math.cos(yaw),
    y0 + dy * u,
    z0 + dz * u - s * w * Math.sin(yaw),
  ];
  for (const s of [-1, 1]) {
    const m = at(0.5, s);
    b.rbox(key, t, t, len, m[0], m[1], m[2], yaw, -pitch, 0, 1);
  }
  for (let i = 0; i < bays; i++) {
    const u0 = i / bays, u1 = (i + 1) / bays;
    // The transverse tie at each bay, and one diagonal per bay alternating
    // sides — a Warren web, which is what a yard derrick actually is.
    const p = at(u0, 0);
    b.rbox(key, w * 2, t * 0.8, t * 0.8, p[0], p[1], p[2], yaw, 0, 0, 1);
    const a = at(u0, i % 2 ? 1 : -1), c = at(u1, i % 2 ? -1 : 1);
    const dl = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    b.rbox(key, t * 0.8, t * 0.8, dl,
      (a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2,
      Math.atan2(c[0] - a[0], c[2] - a[2]),
      -Math.atan2(c[1] - a[1], Math.hypot(c[0] - a[0], c[2] - a[2])), 0, 1);
  }
}

/**
 * An engine bell and its throat, on a hull's transom.
 *
 * Drawn faceted and collided as ONE block for the reason the Dray's transom
 * already records: eight boxes round a cone give the climb probe a new normal
 * every 45 degrees, so a tapering shell in this world is dressing you bump
 * into and never a face you grip.
 */
function bell(b, lx, ly, lz, r0, r1, len, o = {}) {
  const key = o.key ?? 'accent';
  b.put(key, new THREE.CylinderGeometry(r0, r1, len, o.seg ?? 10).rotateX(Math.PI / 2), lx, ly, lz);
  /* THE THROAT IS A CONE POINTING INTO THE SHIP, NOT A DISC ON THE END OF IT.
   *
   * It was a 0.14 m cylinder - which is to say a flat lit plate capping the
   * bell - and from astern, which is the ONLY angle a chase camera ever gives
   * you, that is exactly what it looked like. A tester who flew the whole
   * campaign described the Kestrel's engines as "flat magenta discs... two
   * coloured dots", and they were right: there was nothing behind the light.
   *
   * A cone with its base on the exit plane and its apex `len * 0.5` FORWARD
   * costs the same handful of triangles and gives the bell an inside. The lit
   * surface now recedes, so the eye reads depth and a throat rather than a
   * sticker, and the shading falls off round the cone instead of being one
   * flat value across a disc.
   *
   * The exit plane recorded in `nozzles` is unchanged: `ShipModel` hangs the
   * flown hull's exhaust plume off it, and the plume must still start exactly
   * where the metal ends. */
  b.put('glow',
    new THREE.ConeGeometry(r1 * 0.80, len * 0.5, o.seg ?? 10, 1, true).rotateX(Math.PI / 2),
    lx, ly, lz - len / 2 + len * 0.25);
  // The mounting ring, and four actuators round it: what makes a cone an engine.
  b.put('dark', new THREE.CylinderGeometry(r0 + 0.12, r0 + 0.12, 0.2, o.seg ?? 10).rotateX(Math.PI / 2),
    lx, ly, lz + len / 2);
  for (let i = 0; i < 4; i++) {
    const a = (i + 0.5) * (Math.PI / 2);
    b.box('trim', 0.1, 0.1, len * 0.7, lx + Math.cos(a) * (r0 + 0.1), ly + Math.sin(a) * (r0 + 0.1), lz + 0.1, 0, 1);
  }
  /* The exit plane, recorded where it is DRAWN rather than declared a second
   * time in the plan. `ShipModel` hangs the flown hull's exhaust off this. */
  b.nozzles.push({ lx, ly, lz: lz - len / 2 - 0.09, r: r1 * 0.78 });
  if (o.solid !== false) b.solid(lx, ly, lz, r1 * 0.8, r1 * 0.8, len / 2);
}

/**
 * The slab between two sections: walkable on top, the ceiling underneath.
 *
 * `holes` are `[lx, lz, half]` triples the plate is built AROUND — the Dray's
 * lift shaft and its companionway. They are cut by decomposing the plate into
 * members rather than by drawing a plate and hoping, because a lift that
 * arrives under a solid deck is a lift to nowhere.
 */
function deckSlab(b, key, y, hw, z0, z1, holes = []) {
  let bands = [[-hw, hw, z0, z1]];
  for (const [hx, hz, half] of holes) {
    const next = [];
    for (const [x0, x1, za, zb] of bands) {
      if (hx + half <= x0 || hx - half >= x1 || hz + half <= za || hz - half >= zb) {
        next.push([x0, x1, za, zb]);
        continue;
      }
      next.push([x0, x1, za, hz - half]);
      next.push([x0, x1, hz + half, zb]);
      next.push([x0, hx - half, Math.max(za, hz - half), Math.min(zb, hz + half)]);
      next.push([hx + half, x1, Math.max(za, hz - half), Math.min(zb, hz + half)]);
    }
    bands = next.filter(([x0, x1, za, zb]) => x1 - x0 > 0.02 && zb - za > 0.02);
  }
  for (const [x0, x1, za, zb] of bands) {
    b.cbox(key, x1 - x0, DECK_T, zb - za, (x0 + x1) / 2, y - DECK_T / 2, (za + zb) / 2, 0, 2);
  }
}

/**
 * A room's own deckhead, where the section slab is not already it.
 *
 * Its TOP sits exactly on `ceilY`, which is what exempts it from the full-plan
 * rule: the rule fires on a member that spans the plan and hangs BETWEEN the
 * floor and the ceiling, and the ceiling is allowed to be the ceiling.
 */
function deckhead(b, key, room, inset = 0.04) {
  /* COLLIDED, not drawn. A deckhead that is only geometry is a compartment
   * whose declared height the capsule never meets: the Pike's gun bay claims
   * 1.5 m and is crouch-only BY DESIGN, and with a drawn-only ceiling the next
   * solid thing overhead is the section slab 1.9 m up — so the bay silently
   * became a room you can stand in and the claim became decoration. */
  b.cbox(key, (room.hw - inset) * 2, 0.12, room.z1 - room.z0 - inset * 2,
    0, room.ceilY - 0.06, (room.z0 + room.z1) / 2, 0, 2);
}

/**
 * Fill a sealed volume with a collider and no geometry.
 *
 * A plated section with nothing inside it is a hollow box with a floor, a
 * ceiling and 2 m of headroom — which every walk probe in this repo correctly
 * reports as a standable surface that nothing can reach. It is invisible to a
 * player and it is a permanent false positive in the one class of test this
 * project most needs to trust, so the voids are simply not there: one box, no
 * triangles, no draw call.
 */
function fill(b, hw, y0, y1, z0, z1) {
  if (hw <= 0.02 || y1 - y0 <= 0.02 || z1 - z0 <= 0.02) return;
  b.solid(0, (y0 + y1) / 2, (z0 + z1) / 2, hw, (y1 - y0) / 2, (z1 - z0) / 2);
}

/**
 * Deck lighting for a compartment: a fitting per bay, never one down the middle.
 *
 * A single luminaire along the centreline of a 9 m hold is the same shape of
 * mistake as one string course round a whole plan — it reads as a slot rather
 * than as fittings, and it puts all the light in one place. Recessed 0.06 m
 * into the deckhead so nothing is coplanar with it.
 */
function deckLights(b, room, n, o = {}) {
  const w = o.w ?? Math.min(0.6, room.hw * 0.7);
  const x = o.x ?? 0;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const z = room.z0 + (room.z1 - room.z0) * t;
    b.ibox('warn', w, 0.06, 0.5, x, room.ceilY - 0.16, z, 0, 1);
    b.ibox('dark', w + 0.16, 0.1, 0.66, x, room.ceilY - 0.08, z, 0, 1);
  }
}

/**
 * WALL-WASH FITTINGS, AND WHY A COMPARTMENT NEEDS THEM ON TOP OF ITS DECKHEAD
 * LAMP.
 *
 * Every practical in this world used to hang on a compartment's centreline at
 * `ceilY - 0.16` looking straight down. A bulkhead is VERTICAL, so `dot(N, L)`
 * from a lamp directly overhead is ~0 and all of that fitting's output lands on
 * the deck. The rooms therefore measured well on the floor-illuminance probe
 * `dock-light` runs and rendered at 12-16 of 255 mean frame luma against the
 * brief's 40, because most of what a camera at eye height actually SEES in a
 * 4 m room is bulkhead.
 *
 * These sit 0.34 m off the lining at eye height and alternate flanks down the
 * run, so the near wall gets `dot(N, L)` around 0.8 instead of 0.05 and the far
 * one gets the grazing light that makes plating read as plating. Every one is a
 * `LightRig` SOURCE (`DockWorld._buildShips` builds them `castShadow: false`),
 * so it costs the shader cache nothing; see the budget note in
 * `DockWorld._buildLights`.
 *
 * @returns {Array<{x:number,y:number,z:number,intensity:number,distance:number,floorY:number}>}
 *   light records for the hull's own `lights:` array — the descriptor and the
 *   real light are built from the same rows, which is the "neither alone would
 *   have found the defect" rule this world is built under.
 */
function wallWash(b, room, side, o = {}) {
  const y = room.floorY + Math.min(o.y ?? 1.60, room.ceilY - room.floorY - 0.40);
  const n = o.n ?? 2;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const z = room.z0 + (room.z1 - room.z0) * t;
    /* Alternating flanks - two washers on one wall light one wall twice - and
     * the FIRST goes on the flank opposite the boarding side. A compartment
     * that gets only one washer would otherwise put it on the same flank as
     * the hatch, and with `n: 1` its z is the room's midpoint: on the Kestrel
     * that is local z -1.4 against a hatch at -1.5, i.e. the fitting stands in
     * the doorway. Measured before the flip, 14 of 180 lattice samples through
     * the aperture hit this box at 0.10 m. The far flank is also the wall a
     * player sees on the way in, which is where a wash belongs. */
    const s = i % 2 === 0 ? -side : side;
    b.ibox('dark', 0.18, 0.16, 0.54, s * (room.hw - 0.11), y + 0.16, z, 0, 1);
    b.ibox('warn', 0.05, 0.09, 0.44, s * (room.hw - 0.22), y + 0.14, z, 0, 1);
    out.push({
      x: s * (room.hw - 0.55), y, z,
      intensity: o.intensity ?? 9, distance: o.distance ?? 7, floorY: room.floorY,
    });
  }
  return out;
}

/**
 * Ribs and a cable tray inside a compartment.
 *
 * FOUR members a course, one per face, each inset — the fixed form of the
 * full-plan-box family. On the outside of a shed the broken version is
 * invisible; in a 9 m hold it is six slabs of dark boarding stacked through the
 * room, and it will not be caught by a headroom probe because these members
 * have no colliders and a headroom probe probes colliders.
 */
function innerRibs(b, room, n, key = 'dark', o = {}) {
  const h = room.ceilY - room.floorY - 0.1;
  /* `o.cut` is `{ side, z0, z1 }` — an aperture in one flank that a rib may
   * not stand in. The Kestrel's cabin takes three ribs over a 4.0 m run and
   * the middle one landed at z -1.40, dead centre of a boarding hatch at
   * -2.05..-0.95. A rib is 0.12 m of drawn boarding with no collider, so it
   * was a doorway with a post through it that the player walked through. */
  const cut = o.cut;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const z = room.z0 + (room.z1 - room.z0) * t;
    for (const s of [-1, 1]) {
      if (cut && s === cut.side && z > cut.z0 - 0.1 && z < cut.z1 + 0.1) continue;
      b.ibox(key, 0.12, h, 0.16, s * (room.hw - 0.06), (room.floorY + room.ceilY) / 2, z, 0, 1);
    }
  }
  /* The tray is ONE member down ONE face at head height, not a plate across the
   * plan, and it is hung in the corner so it is out of the walking envelope.
   * The medieval version of this mistake put plank at 1.66 m in a room with a
   * 2.85 m ceiling.
   *
   * ── And it runs down the flank the door is NOT in ──────────────────────
   * It used to be nailed to `-X`. When the berths moved onto piers `boardSide`
   * came back -1 for the Kestrel and the Pike, which put a 0.28 m cable run
   * 0.14 m inboard of the plating across the whole length of a compartment
   * whose boarding hatch is in that same flank, at head height: 24 of 156
   * samples through the Kestrel's aperture and 11 of 143 through the Pike's,
   * `ship-*-in:dark` in both cases. The ribs already take the cut; the tray
   * simply never asked which side the hole was in. */
  const far = cut ? -cut.side : -1;
  b.ibox(key, 0.28, 0.18, room.z1 - room.z0 - 0.4,
    far * (room.hw - 0.2), room.ceilY - 0.3, (room.z0 + room.z1) / 2, 0, 1);
}

/**
 * The berth stencil on both flanks — `BERTH B1 / KESTREL // COURIER` and its
 * three sisters.
 *
 * ── One function because it was four copies, and one of them flew ─────────
 * This is the yard numbering a hull it has in a cradle. It is not livery and
 * it is not part of the ship: `BERTH B2` on a hull 400 km out is the same
 * mistake as a price ticket left on a shirt. `ShipModel` builds the flown hull
 * from these very builders (that is the point of that file), so every one of
 * the four call sites shipped its stencil into deep space, lit, on both
 * flanks. Four separate reviews photographed it.
 *
 * The gate lives HERE rather than at each call site so a fifth hull cannot
 * forget it — the same reasoning `slidePocket` is exported for.
 *
 * @param {ShipBuild} b
 * @param {number} w   plane width, metres — the stencil is sized per hull
 * @param {number} h   plane height, metres
 * @param {any} sign   a `YARD_SIGN` entry
 * @param {number} hw  outer face of the flank the stencil lies on
 * @param {number} y   height in the hull frame
 * @param {number} z   station in the hull frame
 */
function berthStencil(b, w, h, sign, hw, y, z) {
  if (!b.yard) return;
  for (const s of [-1, 1]) {
    b.put('signs', yardSignUV(new THREE.PlaneGeometry(w, h), sign),
      s * (hw + 0.02), y, z, s > 0 ? Math.PI / 2 : -Math.PI / 2);
  }
}

/**
 * A boarding ramp and its landing.
 *
 * `from: 'cradle'` starts at the cradle's bearing face (ship-local y 0), which
 * the yard's own berth stair already delivers a player to and `dock-reach`
 * already proves. `from: 'deck'` starts on the shed floor at `-keelY`, which is
 * what the Dray's cargo ramp does — and its foot lands within a metre of the
 * `apron` point `shipSpecs` published in drop one, which is what that anchor
 * was for.
 *
 * ── And it is BERTH FURNITURE, so a flown hull does not get one ───────────
 * Both datums it is measured from are the berth's: the cradle bearing face and
 * the shed floor. On the flown hull `keelY` is 0 and there is no cradle, so
 * what was built was a staircase, a landing plate, two runs of hazard stripe
 * and a row of legs hanging in vacuum — 6 m past the Dray's own nose and 2.4 m
 * out to starboard of her flank. It is not load-bearing either: `Piloting.
 * disembark` teleports the pilot to a ground-resolved point beside the hull and
 * has never walked a tread, and a landed ship's keel rests `TOUCH_CLEAR * 0.5`
 * = 0.70 m above the surface, so the brow would not reach the ground anyway.
 * `DockWorld` reads the return behind an `if`, so null is the whole contract.
 *
 * @returns {{run:number, footX:number, footY:number}|null} null off a berth
 */
function boardingRamp(b, hull, side, keelY) {
  if (!b.yard) return null;
  const r = hull.ramp;
  const y0 = r.from === 'deck' ? -keelY : 0;
  const total = r.headY - y0;
  const pitch = r.from === 'deck' ? (19 * Math.PI) / 180 : (26 * Math.PI) / 180;
  const run = total / Math.tan(pitch);
  const headX = side * r.headX;
  // A landing at the head, so the last tread is not the threshold itself.
  b.cbox('deckg', 1.0, 0.12, r.width + 0.4, headX + side * 0.4, r.headY - 0.06, r.lz, 0, 1.4);
  b.flight('x', headX + side * (0.9 + run), y0, r.lz, -side * run, total, r.width, r.risers);
  // Legs under it, so the ramp is not a plank hanging in the air.
  const legs = Math.max(2, Math.round(run / 2.2));
  for (let i = 1; i <= legs; i++) {
    const t = i / (legs + 1);
    const lx = headX + side * (0.9 + run * t);
    const ly = y0 + total * (1 - t);
    for (const s of [-1, 1]) {
      b.box('dark', 0.14, Math.max(0.2, ly - y0), 0.14, lx, (y0 + ly) / 2, r.lz + s * r.width / 2, 0, 1);
    }
  }
  // Hazard stripes down both edges: the yard's answer to a rail on a ramp.
  for (const s of [-1, 1]) {
    /* Pitched to lie ON the ramp. Written as a tenth argument to `box`, which
     * put the pitch into `tile` and dropped the pitch — a stripe lying flat in
     * mid-air with uvs scaled by -0.3. The ramp runs along local X, so the
     * rotation is about local Z, exactly as `YardKit.stairTreads` does its
     * stringers. */
    b.rbox('hazard', run, 0.05, 0.18, headX + side * (0.9 + run / 2), y0 + total / 2 + 0.06,
      r.lz + s * (r.width / 2 - 0.09), 0, 0, Math.atan2(total, run) * -side, 1);
  }
  return { run, footX: headX + side * (0.9 + run), footY: y0 };
}


/**
 * Surface relief: raised plate patches, vents, blisters and pipe runs over a
 * plated flank.
 *
 * ── Why this is drawn and not collided, and why that is not rule 4 ───────
 * Rule 4 says nothing the player can TOUCH is drawn without a collider. What is
 * meant by touch is stand on, walk into or grab: a 60 mm patch on a wall is
 * none of those — the capsule's own radius is 350 mm and `FreeClimb` reaches
 * 970 mm, so a body clinging to a flank is holding the flank whether or not the
 * patch is there. Collide it and every hull grows a hundred colliders that only
 * ever catch a capsule on a seam. Anything on these hulls a player can put a
 * foot on is a `cbox`; anything under 0.14 m proud of a face they already meet
 * is relief.
 *
 * The relief is deterministic — a small integer hash rather than `Math.random`
 * — so a hull looks the same on every boot and a screenshot can be compared
 * with the last one.
 */
function relief(b, o) {
  const { hw, y0, y1, z0, z1, n = 40, key = 'trim', panel = 'hull' } = o;
  let h = (o.seed ?? 1) | 0;
  const rnd = () => {
    h = (h * 1103515245 + 12345) & 0x7fffffff;
    return h / 0x7fffffff;
  };
  for (let i = 0; i < n; i++) {
    const s = rnd() < 0.5 ? -1 : 1;
    const y = y0 + (y1 - y0) * (0.08 + rnd() * 0.84);
    const z = z0 + (z1 - z0) * (0.05 + rnd() * 0.9);
    const r = rnd();
    /* NOTHING OVER A DOORWAY, and this pass is where the player's complaint
     * actually came from. Relief is scattered by a hash over the whole flank
     * and it had never heard of the hatch: measured on the Kestrel, 80 of 81
     * rays fired inboard through the boarding aperture were stopped, and the
     * first surface on nearly all of them was one of these at local x
     * 2.32-2.52 against plating at 2.30. The die is rolled BEFORE the skip so
     * that adding a door does not reshuffle the rest of the hull. */
    if (r < 0.42) {
      // A raised plate patch: the seam of a section that was replaced.
      const w = 0.5 + rnd() * 1.4, hh = 0.3 + rnd() * 0.7;
      if (!b.clearOfAperture(s, z - w / 2, z + w / 2, y - hh / 2 - 0.05, y + hh / 2 + 0.05)) continue;
      b.box(panel, 0.06, hh, w, s * (hw + 0.03), y, z, 0, 1);
      b.box(key, 0.055, 0.05, w, s * (hw + 0.035), y + hh / 2, z, 0, 1);
      b.box(key, 0.055, 0.05, w, s * (hw + 0.035), y - hh / 2, z, 0, 1);
    } else if (r < 0.66) {
      // A louvred vent: four blades, which is what makes it read as a vent
      // rather than as a dark rectangle.
      const w = 0.36 + rnd() * 0.5;
      if (!b.clearOfAperture(s, z - w / 2 - 0.05, z + w / 2 + 0.05, y - 0.25, y + 0.25)) continue;
      b.box(key, 0.05, 0.5, w + 0.1, s * (hw + 0.025), y, z, 0, 1);
      for (let k = 0; k < 4; k++) {
        b.box('dark', 0.07, 0.06, w, s * (hw + 0.05), y - 0.18 + k * 0.12, z, 0, 1);
      }
    } else if (r < 0.82) {
      // A sensor blister.
      const rr = 0.12 + rnd() * 0.1;
      if (!b.clearOfAperture(s, z - 0.15, z + 0.15, y - 0.15, y + 0.15)) continue;
      b.put(key, new THREE.SphereGeometry(rr, 8, 5), s * (hw + 0.04), y, z);
      b.box('dark', 0.04, 0.3, 0.3, s * (hw + 0.03), y, z, 0, 1);
    } else if (r < 0.93) {
      // A conduit run down the flank, clipped in every half metre.
      const len = 1.2 + rnd() * 2.6;
      if (!b.clearOfAperture(s, z - len / 2, z + len / 2, y - 0.1, y + 0.1)) continue;
      b.put(key, new THREE.CylinderGeometry(0.055, 0.055, len, 6).rotateX(Math.PI / 2),
        s * (hw + 0.06), y, z);
      for (let k = 0; k * 0.6 < len; k++) {
        b.box('dark', 0.1, 0.16, 0.09, s * (hw + 0.05), y, z - len / 2 + 0.3 + k * 0.6, 0, 1);
      }
    } else {
      // A tie-down ring. Small, proud, and the only relief that is COLLIDED,
      // because it is the one a hand goes on.
      if (!b.clearOfAperture(s, z - 0.14, z + 0.14, y - 0.14, y + 0.14)) continue;
      b.cbox(key, 0.1, 0.22, 0.22, s * (hw + 0.05), y, z, 0, 1);
    }
  }
}


/**
 * The panel-line grid over a flank.
 *
 * The single cheapest thing that makes a slab read as a ship rather than as a
 * box: raised seams on a grid, 30 mm proud, two boxes a line. A 28 m flank
 * costs about 700 triangles and no draw call at all, because it merges into the
 * same bucket as the plating it sits on.
 */
function panelLines(b, o) {
  const { hw, y0, y1, z0, z1, pitchZ = 1.6, pitchY = 0.7, key = 'trim' } = o;
  for (const s of [-1, 1]) {
    /* Cut at every doorway, both ways. A seam is a joint between two sheets of
     * plating and there is no plating over a hatch — the Kestrel's grid put one
     * vertical at z -1.80, inside an aperture running -2.05..-0.95. */
    for (let z = z0 + pitchZ; z < z1 - 0.1; z += pitchZ) {
      if (!b.clearOfAperture(s, z - 0.03, z + 0.03, y0, y1)) continue;
      b.box(key, 0.035, y1 - y0, 0.05, s * (hw + 0.018), (y0 + y1) / 2, z, 0, 1);
    }
    for (let y = y0 + pitchY; y < y1 - 0.05; y += pitchY) {
      for (const [a, c] of b.flankRuns(s, z0, z1, y - 0.03, y + 0.03)) {
        b.box(key, 0.03, 0.045, c - a, s * (hw + 0.015), y, (a + c) / 2, 0, 1);
      }
    }
  }
}

/**
 * Deck furniture along a walkable hull surface: cleats, sockets, inspection
 * covers and a run of non-slip. All flat, all under `stepHeight`, none of it
 * something a body can be stopped by.
 */
function deckDetail(b, o) {
  const { hw, y, z0, z1, n = 14, key = 'trim', seed = 7 } = o;
  let h = seed | 0;
  const rnd = () => { h = (h * 1103515245 + 12345) & 0x7fffffff; return h / 0x7fffffff; };
  for (let i = 0; i < n; i++) {
    const s = rnd() < 0.5 ? -1 : 1;
    const x = s * hw * (0.25 + rnd() * 0.62);
    const z = z0 + (z1 - z0) * (0.06 + rnd() * 0.88);
    const r = rnd();
    if (r < 0.4) {
      b.box(key, 0.28, 0.09, 0.28, x, y + 0.045, z, 0, 1);           // socket plate
      b.box('dark', 0.16, 0.06, 0.16, x, y + 0.08, z, 0, 1);
    } else if (r < 0.7) {
      b.box(key, 0.5, 0.05, 0.7, x, y + 0.025, z, 0, 1);             // inspection cover
      for (const c of [-1, 1]) b.box('dark', 0.06, 0.03, 0.06, x + c * 0.18, y + 0.05, z, 0, 1);
    } else if (r < 0.88) {
      b.box(key, 0.12, 0.16, 0.34, x, y + 0.08, z, 0, 1);            // cleat
      b.box(key, 0.3, 0.08, 0.08, x, y + 0.14, z, 0, 1);
    } else {
      /* `deckg`, and this used to say `grate`.
       *
       * `shipMaterials` publishes `deckg: M.grate` and no key called `grate`
       * at all, so `GeoBatch.flush` built these panels with
       * `materials['grate'] === undefined` — and three.js hands an undefined
       * material to `new THREE.Mesh` by substituting a default white
       * `MeshBasicMaterial`. Unlit, ungraded, full white. Every walkable
       * surface on all four hulls therefore carried a scatter of glowing white
       * rectangles, brighter than anything else in a shed whose median frame
       * luminance is 24.5/255 — the single brightest thing on the Kestrel in
       * the framing that opens this berth. And it cost a whole mesh per hull:
       * one bucket per material key per batch, four hulls, four draws. */
      b.box('deckg', 0.8, 0.03, 1.1, x, y + 0.015, z, 0, 1);         // non-slip panel
    }
  }
}

/**
 * Landing gear: a leg, a jack and a foot per station, COLLIDED because they
 * stand on the cradle beside a route a player walks and are exactly the size of
 * thing a body meets at knee height.
 */
function gear(b, o) {
  const { hw, y0, y1, stations, key = 'dark', trim = 'trim', scale = 1 } = o;
  for (const [lx, lz] of stations) {
    b.cbox(key, 0.3 * scale, y1 - y0, 0.3 * scale, lx, (y0 + y1) / 2, lz, 0, 1);
    b.box(trim, 0.22 * scale, (y1 - y0) * 0.5, 0.22 * scale, lx, y0 + (y1 - y0) * 0.28, lz, 0, 1);
    b.cbox(key, 0.9 * scale, 0.18 * scale, 1.1 * scale, lx, y0 + 0.09 * scale, lz, 0, 1);
    /* The raking jack strut. Written as `box(..., 0, 0, roll)` for three
     * hulls, which put the ROLL in a tenth argument `box` does not have and
     * `0` in `tile` — so the strut stood upright and shipped NaN uvs. See the
     * guard on `ShipBuild.box`. */
    b.rbox(trim, 0.16 * scale, 0.9 * scale, 0.16 * scale,
      lx + (lx > 0 ? -0.35 : 0.35) * scale, y0 + (y1 - y0) * 0.6, lz,
      0, 0, lx > 0 ? -0.5 : 0.5, 1);
  }
}

/**
 * A hazard stripe along a deck edge. This is what a hull gets instead of a
 * rail — see rule 3 in the file header.
 */
function edgeStripe(b, hw, y, z0, z1) {
  for (const s of [-1, 1]) {
    b.box('hazard', 0.34, 0.04, z1 - z0, s * (hw - 0.2), y + 0.02, (z0 + z1) / 2, 0, 1);
  }
}

/**
 * A 45-degree knuckle strake along the top or bottom edge of a plated flank.
 *
 * ── Why a strake and not a chamfered section ────────────────────────────────
 * The three fitted hulls cannot chamfer their midships flanks: a room's own
 * half-beam IS the flank minus `SKIN`, so any tumblehome between the deck and
 * the sole eats the compartment behind it. What is free is the last 0.16 m at
 * the deck edge and at the turn of the bilge, which is exactly where a real
 * hull has its knuckle — so the chamfer is DRAWN as a strake over the corner
 * the plating already makes.
 *
 * Drawn, never collided, for `relief`'s reason: it stands 0.11 m proud of a
 * face the capsule already meets, and the capsule's own radius is 0.35 m.
 *
 * @param {-1|1} up  +1 for a deck edge, -1 for the turn of the bilge
 */
function knuckle(b, key, hw, y, z0, z1, up = 1, size = 0.3) {
  /* Cut at a doorway like everything else on a flank, and the Dray is why.
   * Her bilge knuckle is a 0.5 m strake centred on local y 0.97 — it spans
   * 0.72 to 1.22 — and her cargo threshold is at 1.00: a 0.22 m step across
   * the full 3 m of a cargo door, drawn and not collided, which is the whole
   * bottom row of the aperture probe. Where a hull has a shell door the
   * surround IS the strake for that length, which is also what a real one
   * does. */
  const half = size * 0.36;
  for (const s of [-1, 1]) {
    const cy = y - up * size * 0.26;
    for (const [a, c] of b.flankRuns(s, z0, z1, cy - half, cy + half)) {
      b.rbox(key, size, size * 0.42, c - a, s * (hw - size * 0.28), cy,
        (a + c) / 2, 0, 0, s * up * (Math.PI / 4), 1);
    }
  }
}

/**
 * The runs of a flank BETWEEN a list of cut-outs.
 *
 * One function so that plating, panel lines, relief, ribs and string courses
 * cannot disagree about where a hole is. They did: the first version of the
 * Bastion's stripped bays removed the plating and left everything else running
 * straight across the gap.
 */
function intactRuns(z0, z1, cuts) {
  const out = [];
  let z = z0;
  for (const c of cuts) { out.push([z, c.z0]); z = c.z1; }
  out.push([z, z1]);
  return out.filter(([a, c]) => c - a > 0.02);
}

/* ------------------------------------------------------------------ */
/* Kestrel — courier, berth B1                                         */
/* ------------------------------------------------------------------ */

/**
 * @param {import('./ShipKit.js').ShipBuild} b
 * @param {1|-1} side which local X the boarding ramp runs out along
 * @param {number} keelY the cradle's bearing height above the shed floor
 * @param {Record<string, any>} mats this hull's own material clones
 */
export function buildKestrel(b, side, keelY, mats) {
  const H = KESTREL;
  const cabin = H.rooms[0], cockpit = H.rooms[1];

  /**
   * THE AUTHORED SKIN, OR NULL — AND THIS IS THE FOURTH ATTEMPT AT ONE
   * COMPLAINT.
   *
   * "spaceships do not look like spaceships, they look like they are made of
   * square blocks", three times, and three passes of this file answered it
   * with better box arrangements. They could not have worked: this file makes
   * 197 `box()` calls because `ShipKit` is a box kit, which is right for a
   * world where buildings ARE boxes and is not negotiable into being right for
   * a hull. The last pass rejected the complaint outright — the header still
   * claims "a lofted needle with a boat-tail, raised canopy and V-tail" — and
   * a shot of this ship framed from the apron reads as a slab-sided barge with
   * a deckhouse and a mast on it. The player was right and the file was wrong.
   *
   * So the skin comes off the primitive. `scripts/make-ship-glb.mjs` evaluates
   * a parametric hull under plain Node — splined rails, swept sections,
   * averaged normals with named creases, nacelles that are tubes — and bakes
   * it to `public/assets/ship/kestrel-hull.glb`; `src/ships/ShipAssets.js`
   * loads it and hands the parts here, already keyed to this yard's own cached
   * materials so nothing new is compiled.
   *
   * `null` is not an error. It is the file missing, the fetch failing, or a
   * headless test with no `fetch` at all — and then this function builds
   * exactly the hull it built before, dressing and all. Both arms are pinned
   * by `scripts/tests/ship-assets.test.mjs`.
   */
  const skin = shipParts('kestrel', { mirrorX: side < 0 });

  /* ── Hull ──────────────────────────────────────────────────────────────
   *
   * Muted when there is an authored skin: every collider, every aperture and
   * every room below is registered exactly as it always was, and only the
   * DRAWING is suppressed. See `ShipBuild.mute` for why that is one flag
   * rather than a second copy of this function. */
  b.mute(!!skin);
  keel(b, H, { tile: 2.6 });
  flankAperture(b, H.lower, side, H.hatch, H.deck.y);
  /* The dorsal fairing, lofted rather than plated.
   *
   * It carries the third and last move of the climb, so the run from z -2.6 to
   * 0.2 is PARALLEL at `upper.hw` — `bands[2]` grips local x 1.15 at z -1.5 and
   * a face that had started tapering there would hand `FreeClimb` a normal it
   * will not take. Everything outside that run is free, and tapering it is what
   * turns a box on a deck into a faired spine. */
  loftSolid(b, 'hull', [
    { z: H.upper.z0, pts: sec(0.82, H.upper.y0, H.upper.y1 - 0.55, { ct: 0.24, cb: 0.16, tw: 0.5 }) },
    { z: -2.6, pts: sec(H.upper.hw, H.upper.y0, H.upper.y1, { ct: 0.34, cb: 0.2, tw: 0.74 }) },
    { z: 0.2, pts: sec(H.upper.hw, H.upper.y0, H.upper.y1, { ct: 0.34, cb: 0.2, tw: 0.74 }) },
    { z: H.upper.z1, pts: sec(0.95, H.upper.y0, H.upper.y1 - 0.42, { ct: 0.26, cb: 0.18, tw: 0.6 }) },
  ], { tile: 2.2, grip: { 1: H.upper.hw } });
  /* The engine space aft of the cabin, sealed. The dorsal fairing needs no
   * `fill` any more: `loftSolid` collides a loft with SOLID boxes rather than
   * with a shell, so there is no void inside it to be found. */
  fill(b, H.lower.hw - SKIN, H.lower.y0, H.ledge.y, H.lower.z0 + SKIN, -3.55);

  /* The bolted courses. Four members a course — see `ShipKit.course`. */
  b.course('trim', H.lower.hw, H.lower.z0, H.lower.z1, H.ledge.y - 0.26);
  /* `ends: false`, AND IT IS NOT COSMETIC. `ShipKit.course` draws four
   * members: one per flank, plus two transverse ends `(hw - inset) * 2 =
   * 4.28 m` wide on `lx 0`. On the two full-length courses either side of this
   * line those ends land buried in the bow and stern caps and are never seen.
   * This one is inset 3.2 m at each end, so they landed INSIDE THE CABIN — a
   * 4.28 m beam across the room's whole 4.16 m breadth at local y 1.39-1.61,
   * i.e. 0.63 m above the sole, with no collider under it. Raycast up from the
   * cabin sole on a 0.25 m grid: 42 of 256 points (16.4%) met
   * `ship-kestrel:trim` at a constant y 1.39. The aft member sat inside the
   * boarding hatch's z-span and the forward one inside the cabin/cockpit
   * archway, and `VIEWS.dock`'s `kestrel-in` framing stood 0.12 m off its face
   * — 60 of 63 rays from that camera hit it, which is the whole of why that
   * framing rendered as one flat wall at a maximum pixel of 57/255.
   *
   * `dock-hulls`' full-plan-box rule did not fire because it triggers at 50%
   * of plan and this is 7.5%; `ShipBuild.put` does not `_occupy`, so `fits()`
   * was blind to it too and the fit-out laid the bunk bedding inside the box. */
  b.course('trim', H.lower.hw, H.lower.z0 + 3.2, H.lower.z1 - 3.2, 1.5, { ends: false });
  b.course('trim', H.upper.hw, H.upper.z0, H.upper.z1, H.upper.y1 - 0.26);
  for (const s of [-1, 1]) {
    b.bolts('trim', s * (H.lower.hw + 0.05), H.ledge.y - 0.26, H.lower.z0 + 0.6, H.lower.z1 - 0.6, 14);
    b.bolts('trim', s * (H.upper.hw + 0.05), H.upper.y1 - 0.26, H.upper.z0 + 0.5, H.upper.z1 - 0.5, 10);
  }
  // Section frames standing proud of the flanks: what a climber actually grabs.
  for (let i = 0; i < 4; i++) {
    b.rib('trim', H.lower.hw, H.lower.y0, H.ledge.y - 0.36, H.lower.z0 + 1.0 + i * 1.9);
  }
  // The knuckles at the deck edge and the turn of the bilge, which is as much
  // section shape as a hull with a 4.16 m room inside a 4.60 m beam can have.
  knuckle(b, 'hull', H.lower.hw, H.ledge.y, H.lower.z0, H.lower.z1, 1, 0.3);
  knuckle(b, 'hull', H.lower.hw, H.lower.y0, H.lower.z0, H.lower.z1, -1, 0.3);
  /* ── The canopy ───────────────────────────────────────────────────────
   * A RAISED faceted glasshouse on a coaming, not a lid: this is the detail
   * that decides whether a 14 m hull reads as a courier or as a container,
   * because from the shed floor a flush canopy puts no cockpit in the
   * silhouette at all. Its underside is 0.10 m clear of the cockpit's
   * declared ceiling, so the room is never shorter than the contract says.
   * Nothing is painted behind it: rule 6, and the cockpit is real. */
  const C = H.canopy;
  loftSolid(b, 'glass', [
    { z: C.z0, pts: sec(1.90, C.y, C.top - 0.08, { ct: 0.62, cb: 0.08, tw: 1.15 }) },
    { z: C.z0 + 1.2, pts: sec(C.hw, C.y, C.top, { ct: 0.62, cb: 0.08, tw: 1.30 }) },
    { z: C.z0 + 2.2, pts: sec(1.85, C.y, C.top - 0.34, { ct: 0.52, cb: 0.08, tw: 1.15 }) },
    { z: C.z1, pts: sec(1.30, C.y, C.y + 0.16, { ct: 0.08, cb: 0.06, tw: 1.05 }) },
  ], { tile: 2.2 });
  /* The coaming and the frames over it, in trim rather than glass: a canopy
   * with no framing is a bubble, and a bubble on a working courier is the one
   * thing on this hull nobody would have to repair. */
  for (const s of [-1, 1]) {
    b.box('trim', 0.14, 0.5, C.z1 - C.z0, s * (H.lower.hw - 0.07), C.y + 0.1, (C.z0 + C.z1) / 2, 0, 1);
  }
  for (let i = 0; i <= 3; i++) {
    const t = i / 3;
    const z = C.z0 + (C.z1 - C.z0) * t;
    const hw = 1.90 + 0.15 * Math.sin(t * Math.PI) - 0.7 * t * t;
    const top = C.top - 0.5 * t * t - 0.08 * (1 - t);
    b.box('trim', hw * 2 + 0.06, 0.09, 0.09, 0, top - 0.05, z, 0, 1);
    for (const s of [-1, 1]) {
      b.rbox('trim', 0.09, 0.09, top - C.y, s * hw, (C.y + top) / 2, z, 0, 0, s * 0.22, 1);
    }
  }
  /* The back wall of the glasshouse. Collided on both arms and DRAWN only on
   * the procedural one: it is 3.6 m across and the authored dorsal is 2.7 m
   * across at that station, so on the asset arm this slab would stand 0.43 m
   * proud of the fairing it is supposed to be inside. */
  b.cbox('hull', 3.6, C.top - C.y - 0.1, 0.16, 0, (C.y + C.top) / 2, C.z0 - 0.08, 0, 2);

  /* ── The nose ─────────────────────────────────────────────────────────
   * A lofted needle with a chine and a droop: nine sections from the
   * cockpit's forward bulkhead to a 0.28 m tip four metres out. It was four
   * stepped boxes, which from the floor is a staircase lying on its side.
   * Collided by `loftSolid`'s inscribed boxes — nothing stands on it. */
  const NS = H.nose;
  const noseSt = [
    { z: NS.z0, pts: sec(2.30, 0.60, 2.92, { ct: 0.3, cb: 0.3 }) },
    { z: 4.6, pts: sec(2.18, 0.70, 2.86, { ct: 0.6, cb: 0.5, tw: 1.35 }) },
    { z: 5.4, pts: sec(1.88, 0.86, 2.70, { ct: 0.68, cb: 0.55, tw: 1.05 }) },
    { z: 6.2, pts: sec(1.44, 1.02, 2.42, { ct: 0.6, cb: 0.5, tw: 0.78 }) },
    { z: 6.9, pts: sec(0.98, 1.16, 2.10, { ct: 0.46, cb: 0.4, tw: 0.5 }) },
    { z: 7.4, pts: sec(0.58, 1.28, 1.80, { ct: 0.26, cb: 0.24, tw: 0.28 }) },
    { z: NS.z1, pts: sec(0.14, 1.42, 1.60, { ct: 0.08, cb: 0.07, tw: 0.07 }) },
  ];
  loftSolid(b, 'hull', noseSt, { tile: 2.5, capFore: true });
  /* The chine: one strake down the widest line of each flank, which is what
   * makes a taper read as a shaped hull rather than as a cone. */
  for (const s of [-1, 1]) {
    for (let i = 0; i < noseSt.length - 1; i++) {
      const a = noseSt[i], c = noseSt[i + 1];
      const ax = a.pts[2][0], cxx = c.pts[2][0];
      const ay = (a.pts[2][1] + a.pts[3][1]) / 2, cy = (c.pts[2][1] + c.pts[3][1]) / 2;
      const len = Math.hypot(cxx - ax, cy - ay, c.z - a.z);
      b.rbox('trim', 0.07, 0.11, len, s * (ax + cxx) / 2, (ay + cy) / 2, (a.z + c.z) / 2,
        Math.atan2(s * (cxx - ax), c.z - a.z), -Math.atan2(cy - ay, c.z - a.z), 0, 1);
    }
  }
  b.box('glow', 0.34, 0.09, 0.22, 0, 1.51, NS.z1 - 0.1, 0, 1);
  for (const s of [-1, 1]) b.box('glow', 0.1, 0.08, 0.5, s * 1.0, 1.95, 6.5, 0, 1);

  /* ── The boat-tail ────────────────────────────────────────────────────
   * The stern was a flat transom at z -5.6 with a plated drum in front of it.
   * It is a lofted taper now, sealed by its own inscribed colliders, and it
   * is what the V-tail is rooted on. */
  const TL = H.tail;
  loftSolid(b, 'hull', [
    { z: TL.z1, pts: sec(2.30, 0.60, 2.92, { ct: 0.3, cb: 0.3 }) },
    { z: -5.0, pts: sec(2.05, 0.76, 2.80, { ct: 0.55, cb: 0.5, tw: 1.2 }) },
    { z: -5.7, pts: sec(1.55, 0.92, 2.56, { ct: 0.5, cb: 0.45, tw: 0.9 }) },
    { z: TL.z0, pts: sec(1.05, 1.06, 2.24, { ct: 0.34, cb: 0.3, tw: 0.6 }) },
  ], { tile: 2.5, capAft: true });
  b.box('glow', 1.5, 0.1, 0.1, 0, 2.3, TL.z0 + 0.1, 0, 1);

  /* ── The V-tail ───────────────────────────────────────────────────────
   * Two fins splayed 34 degrees off vertical off the boat-tail. Drawn as
   * lofts about their own span, collided as one upright plate each — a canted
   * collider is not available (`solid` takes a yaw and nothing else) and an
   * upright box buried in the middle of the fin is the honest approximation:
   * everything a body can reach of the fin is inside it. */
  const VT = H.vtail;
  for (const s of [-1, 1]) {
    const fin = [];
    for (let i = 0; i <= 3; i++) {
      const t = i / 3;
      const ch = VT.chordRoot + (VT.chordTip - VT.chordRoot) * t;
      const th = 0.16 * (1 - 0.6 * t);
      /* `ry = +/-PI/2` sends the loft's own +X to world -Z on the starboard
       * fin, so a NEGATIVE skew is what carries the tip aft of the root. */
      const skew = -0.55 * t;
      const m = s > 0 ? 1 : -1;
      fin.push({
        z: VT.span * t,
        pts: [
          [m * (-ch / 2 - skew), 0], [m * (ch * 0.12 - skew), -th],
          [m * (ch / 2 - skew), 0], [m * (ch * 0.12 - skew), th],
        ],
      });
    }
    b.put('accent', loftGeo(fin, { tile: 1.8, capFore: true, capAft: true }),
      s * VT.rootX, VT.rootY, VT.z, s * Math.PI / 2, -(Math.PI / 2 - VT.cant), 0);
    const tipX = VT.rootX + VT.span * Math.sin(VT.cant);
    const tipY = VT.rootY + VT.span * Math.cos(VT.cant);
    b.solid(s * (VT.rootX + tipX) / 2, (VT.rootY + tipY) / 2, VT.z - 0.28,
      0.12 + (tipX - VT.rootX) / 2, (tipY - VT.rootY) / 2, VT.chordRoot / 2.6);
    b.box('glow', 0.09, 0.09, 0.4, s * (tipX - 0.14), tipY - 0.12, VT.z - 0.7, 0, 1);
  }

  /* ── Engine pods, outboard on swept pylons ────────────────────────────
   * The pods are the silhouette. See `KESTREL.nacelle` for why 3.00 is the
   * furthest out the inboard edge may go and still leave the second move of
   * the climb inside `FreeClimb`'s reach.
   *
   * The top face between `x0` and `x1` is FLAT and unobstructed over the
   * mantle station, because `Climb._probe` finds the top of the wall it
   * grabbed by firing DOWN from 0.14 m inside the far face: a cowl or a rail
   * on the outboard edge is what that ray lands on, the top comes back as the
   * rail rather than the pod, and `resolveCapsule` then reports the body
   * standing on thin air. Measured on the first version of this hull: a grab
   * rail at local x 3.86 and every Kestrel mantle failed with "not grounded".
   * The rail is inboard at 3.35 now, clear of the 3.48-4.18 m the capsule
   * occupies when it lands. */
  const N = H.nacelle;
  const nw = N.x1 - N.x0, ncx = (N.x0 + N.x1) / 2, ncz = (N.z0 + N.z1) / 2;
  const half = nw / 2;
  for (const s of [-1, 1]) {
    const podSt = [
      { z: N.z0, pts: sec(half * 0.66, 0.86, 1.42, { ct: 0.2, cb: 0.2 }) },
      { z: -6.1, pts: sec(half * 0.95, 0.72, 1.56, { ct: 0.1, cb: 0.34, tw: half * 0.95 }) },
      { z: -5.6, pts: sec(half, N.y0, N.y1, { cb: 0.34, tw: half }) },
      { z: -4.0, pts: sec(half, N.y0, N.y1, { cb: 0.34, tw: half }) },
      { z: -3.4, pts: sec(half * 0.92, 0.72, 1.52, { ct: 0.12, cb: 0.3, tw: half * 0.8 }) },
      { z: N.z1, pts: sec(half * 0.6, 0.9, 1.36, { ct: 0.18, cb: 0.18 }) },
    ];
    b.put('accent', loftGeo(podSt, { tile: 2.0, capFore: true }), s * ncx, 0, 0);
    /* Collided as three boxes, and the middle one is the mantle target: full
     * width, full height, spanning the station the band is probed at — which
     * is `bands[0].z` = -4.8, inside the parallel run -5.6..-4.0. */
    b.solid(s * ncx, (N.y0 + N.y1) / 2, -4.8, half, (N.y1 - N.y0) / 2, 0.8);
    b.solid(s * ncx, 0.78, -6.25, half * 0.8, 0.42, 0.55);
    b.solid(s * ncx, 0.78, -3.4, half * 0.72, 0.4, 0.5);
    // Intake lip forward, nozzle aft. Both on the livery's `thruster` slot.
    b.put('dark', new THREE.CylinderGeometry(half * 0.6, half * 0.52, 0.3, 8).rotateX(Math.PI / 2),
      s * ncx, 1.13, N.z1 + 0.1);
    /* The authored pod is a TUBE — a rolled lip, an intake duct running aft
     * into the dark, and a nozzle flaring to its exit plane — so there is no
     * bell to draw on that arm. The exit plane still has to be RECORDED:
     * `ShipModel` hangs the flown hull's exhaust off `b.nozzles`, and an
     * engine with no record is a ship that burns nothing under throttle. The
     * two numbers are measured off the generator's own output — the throat's
     * exit is the pod's aft face at z -6.60 and its half-height there is
     * 0.46 — and `ship-assets.test.mjs` holds them to the baked mesh. */
    if (skin) b.nozzles.push({ lx: s * ncx, ly: (N.y0 + N.y1) / 2, lz: N.z0 - 0.02, r: 0.46 });
    else bell(b, s * ncx, 1.1, N.z0 - 0.34, half * 0.62, half * 0.78, 0.66, { seg: 8, solid: false });

    /* The pylon, swept, and a drag strut aft of it. This is a 0.70 m gap over
     * a 5 m drop to the cradle, so both are COLLIDED: a player who walks off
     * the pod inboard meets the pylon rather than the floor. */
    const PY = H.pylon;
    const pyl = [];
    for (let i = 0; i <= 2; i++) {
      const t = i / 2;
      const ch = (PY.z1 - PY.z0) * (1 - 0.28 * t);
      const th = 0.2 - 0.06 * t;
      const skew = -0.34 * t;
      pyl.push({
        z: t * (N.x0 - H.lower.hw + 0.04),
        pts: [[-ch / 2 + skew, PY.y0 + 0.1 * t], [0, PY.y0 - th / 2],
          [ch / 2 + skew, PY.y1 - 0.1 * t], [0, PY.y1 + th / 2]],
      });
    }
    b.put('trim', loftGeo(pyl, { tile: 1.6, capFore: true, capAft: true }),
      s * (H.lower.hw - 0.02), 0, (PY.z0 + PY.z1) / 2, s * Math.PI / 2);
    b.solid(s * (H.lower.hw + (N.x0 - H.lower.hw) / 2), (PY.y0 + PY.y1) / 2,
      (PY.z0 + PY.z1) / 2 - 0.1, (N.x0 - H.lower.hw) / 2, (PY.y1 - PY.y0) / 2, 0.6);
    b.rbox('trim', 0.12, 0.12, 1.9, s * (H.lower.hw + 0.35), 1.16, -5.3, s * 0.42, 0, 0, 1);
  }

  /* ── The dorsal array ─────────────────────────────────────────────────
   * A MAST AND A BOOM OVER THE AFT SPINE, AND IT IS THE ONE THING ON THIS
   * HULL THAT PUTS DAYLIGHT ABOVE IT.
   *
   * Everything that makes the Kestrel a courier — the pods, the pylons, the
   * V-tail — is OUTBOARD, and outboard is invisible in profile: from the beam
   * the pods sit behind the fuselage at the same height as it, and the hull
   * reads as one unbroken lump from keel to crown. The silhouette probe says
   * so: 1.18 lit runs per column broadside, against 1.92 for the Dray once she
   * had legs and a floor of 1.24. A courier with an antenna farm on it is the
   * cheapest honest thing that breaks that line, and it is what a ship whose
   * whole job is carrying messages would actually have.
   *
   * ── The two heights are both climb numbers ────────────────────────────
   * `bands[2]` mantles from the ledge onto the spine at z -1.50 and `Climb`
   * lands the body 0.77 m inboard of the flank it gripped, at local x 0.38,
   * where it demands `MANTLE_HEADROOM` = 1.55 m of clear air. The boom is at
   * y 7.00, which is 1.84 m over a spine deck at 5.16.
   *
   * And the mast is at z -3.20, not amidships: the capsule that finishes that
   * mantle occupies z -1.85..-1.15, so a post anywhere near the middle of this
   * deck is a post the climb lands inside of. It is collided, because it
   * stands on a deck a player walks. */
  if (!skin) {
    b.cbox('trim', 0.20, 1.94, 0.20, 0, H.spine.y + 0.97, -3.20, 0, 1);
    b.box('trim', 0.16, 0.18, 2.40, 0, H.spine.y + 1.93, -3.20, 0, 1);
    for (const s of [-1, 1]) {
      b.rbox('trim', 0.08, 0.08, 1.15, 0, H.spine.y + 1.42, -3.20 + s * 0.52, 0, s * 0.72, 0, 1);
      b.put('accent', new THREE.CylinderGeometry(0.34, 0.06, 0.30, 8).rotateX(s * Math.PI / 2),
        0, H.spine.y + 1.93, -3.20 + s * 1.34);
    }
    b.box('glow', 0.1, 0.1, 0.1, 0, H.spine.y + 2.10, -3.20, 0, 1);
  }

  /* ── The shell ends here ─────────────────────────────────────────────
   * Everything below is drawn on BOTH arms, and the mute comes off. */
  b.mute(false);

  /* The authored skin, placed in the hull's own frame — which is the frame it
   * was generated in, so there is no transform and nothing to get wrong. Each
   * part rides the yard's cached material of its own name; see `ShipAssets`. */
  if (skin) {
    for (const p of skin) b.put(p.key, p.geometry, 0, 0, 0);
    /* The dorsal fin, which is what the mast used to be — and it needs the
     * collider the mast had, for the same reason: it stands where a body could
     * walk into it. Rooted AFT of the spine deck (which ends at z -3.60) so
     * nothing standing on that deck can meet it, and INSCRIBED, which is
     * `loftSolid`'s rule: the generator's fin runs y 4.86..6.46 and its
     * planform tapers from z -3.80..-5.35 at the root to -4.35..-4.97 at the
     * tip, so the box that fits inside it at mid-span is y 4.86..6.34,
     * z -5.17..-4.07. A box cut to the ROOT chord instead would have stood
     * 0.32 m proud of the fin's own leading edge. */
    b.solid(0, 5.60, -4.62, 0.09, 0.74, 0.55);
    /* And the wings, which the pylon collider does not cover. The procedural
     * pylon is a 1.3 m stub and its box spans z -4.30..-3.10; the authored
     * wing is a 1.7 m root chord running z -4.70..-3.00, so 0.4 m of aerofoil
     * at each end stood over open air between the flank and the pod — drawn
     * and not collided, which is rule 4 and is also a 0.7 m gap a body walking
     * inboard off the pod would drop through. One box per side, inscribed in
     * the wing's own plan and stopping at the pod's own collider. */
    for (const s of [-1, 1]) {
      b.solid(s * ((H.lower.hw + H.nacelle.x0) / 2), 1.25, -3.85,
        (H.nacelle.x0 - H.lower.hw) / 2, 0.27, 0.85);
    }
  }

  /* The two walkable plates, drawn on both arms. Each one's TOP is a ledge the
   * climb mantles onto and its UNDERSIDE is a compartment's ceiling — rule 2 —
   * and the authored skin closes exactly beneath each of them rather than
   * trying to be them: a surface with no thickness cannot be a deck you stand
   * on and a room's deckhead at the same time. */
  deckSlab(b, 'hull', H.ledge.y, H.ledge.outer, H.ledge.z0, H.ledge.z1);
  deckSlab(b, 'deckg', H.spine.y, H.spine.hw, H.spine.z0, H.spine.z1);
  edgeStripe(b, H.ledge.outer, H.ledge.y, H.ledge.z0 + 0.4, H.ledge.z1 - 0.4);

  /* The dead ends of the compartment, sealed: engines aft, avionics forward.
   * Drawn on both arms — the authored skin is a surface with no thickness, so
   * the cabin's aft bulkhead is the only thing between a player standing in it
   * and a back-facing triangle they would see straight through. */
  for (const z of [-3.55, 3.55]) {
    b.cbox('hull', (H.lower.hw - SKIN) * 2, H.ledge.y - H.lower.y0, SKIN,
      0, (H.lower.y0 + H.ledge.y) / 2, z, 0, 2);
  }
  /* The cockpit's own ceiling, likewise on both arms. The authored roof over
   * this compartment is at 2.90 and this slab's top is at 2.86, so it is
   * inside the skin rather than through it — the one measurement the crown
   * curve forward of z 1.00 exists to satisfy. */
  b.cbox('hull', (H.lower.hw - SKIN) * 2, 0.12, H.canopy.z1 - H.canopy.z0 + 0.3,
    0, H.canopy.y - 0.06, (H.canopy.z0 + H.canopy.z1) / 2, 0, 2);
  // The sensor boom: the last half metre of a courier is an instrument.
  b.put('trim', new THREE.CylinderGeometry(0.05, 0.02, 1.1, 6).rotateX(Math.PI / 2),
    0, 1.51, H.nose.z1 + 0.5);
  for (const s of [-1, 1]) {
    const N2 = H.nacelle, ncx2 = (N2.x0 + N2.x1) / 2;
    // The mantle target, marked. Both arms: it is a stripe on a flat pod top.
    b.box('hazard', (N2.x1 - N2.x0) - 0.6, 0.04, 1.6, s * ncx2, N2.y1 + 0.02, -4.8, 0, 1);
    // Grab rail down the pod: a handhold that is collided, so it is not a lie.
    b.cbox('trim', 0.08, 0.32, 2.0, s * (N2.x0 + 0.35), N2.y1 + 0.3, -4.8, 0, 1);
  }

  /* ── Relief and gear ────────────────────────────────────────────────
   *
   * `panelLines` and `relief` lay boxes on a flank at exactly `hw`, which is
   * what a flat plated flank is and what an authored one is not: the skin bows
   * to 2.30 at the waist and tucks to 2.19 at the sole and the deck edge, so a
   * patch pinned to 2.30 would float 11 cm off its own hull at both ends of
   * every station. Surface interest on that arm comes from the shape and from
   * the plating map, which is what the UVs in the .glb are for. */
  if (!skin) {
    panelLines(b, { hw: H.lower.hw, y0: H.lower.y0, y1: H.ledge.y, z0: H.lower.z0, z1: H.lower.z1, pitchZ: 1.3, pitchY: 0.62 });
    panelLines(b, { hw: H.upper.hw, y0: H.upper.y0, y1: H.upper.y1, z0: H.upper.z0, z1: H.upper.z1, pitchZ: 1.1, pitchY: 0.68, key: 'accent' });
    /* 76 and not 102. The plated run is 8.2 m long now rather than 10.2, and at
     * the old count the flank read as a radiator grille beside a lofted nose —
     * relief competing with the shape instead of describing it. */
    relief(b, { hw: H.lower.hw, y0: H.lower.y0 + 0.3, y1: H.ledge.y - 0.5, z0: H.lower.z0 + 0.6, z1: H.lower.z1 - 0.6, n: 76, seed: 11 });
    relief(b, { hw: H.upper.hw, y0: H.upper.y0 + 0.3, y1: H.upper.y1 - 0.4, z0: H.upper.z0 + 0.7, z1: H.upper.z1 - 0.7, n: 34, seed: 23, key: 'accent' });
  }
  deckDetail(b, { hw: H.ledge.outer - 0.5, y: H.ledge.y, z0: H.ledge.z0 + 0.8, z1: H.ledge.z1 - 0.8, n: 30, seed: 31 });
  deckDetail(b, { hw: H.spine.hw - 0.2, y: H.spine.y, z0: H.spine.z0 + 0.6, z1: H.spine.z1 - 0.6, n: 18, seed: 37, key: 'accent' });
  gear(b, { hw: H.lower.hw, y0: -0.36, y1: H.lower.y0 + 0.1, stations: [[-1.7, -4.2], [1.7, -4.2], [0, 4.0]] });
  /* Section stencil on each flank: the yard numbers everything it re-assembles.
   *
   * FORWARD of the boarding hatch, and that is a measurement rather than a
   * preference. This is a 2.2 m plane and it used to sit at z -1.0, so it
   * spanned -2.10..0.10 across an aperture running -2.58..-0.43: a decal laid
   * over the doorway, and one of the surfaces the 80-of-81 aperture probe was
   * hitting. It cannot be CUT the way a course or a panel line can — half a
   * stencil is a broken stencil — so it moves. At z 1.6 it spans 0.50..2.70
   * against plating that runs to 3.80, clear of the pocket by 0.93 m. */
  berthStencil(b, 2.2, 0.9, YARD_SIGN.berthB1, H.lower.hw, 2.1, 1.6);

  /* ── Interior ─────────────────────────────────────────────────────── */
  deckSlab(b, 'deckg', H.deck.y, H.deck.hw, H.deck.z0, H.deck.z1);
  /* Lining panels, DRAWN ONLY: the hull wall behind them is already the
   * collider, and a second collider 0.06 m inside it is a lip to catch a
   * capsule on for the length of the cabin.
   *
   * AND CUT ROUND THE HATCH, which it was not. `plated(..., { opening })`
   * takes the hole out of the PLATING and nothing else in the hull knew the
   * hatch existed, so this panel ran the full 6.7 m of the compartment and
   * sealed the doorway from the inside: 180 of 180 lattice samples through the
   * aperture were blocked, first surface `ship-kestrel-in:trim` at 0.10 m
   * inboard of the plating's inner face. It has no collider, so a player
   * boarded by walking THROUGH a drawn wall — which is worse than being
   * stopped by it, not better. `intactRuns` is the same function the plating,
   * the panel lines and the Bastion's stripped bays use, so the hole cannot
   * drift between them. */
  const lining = intactRuns(H.deck.z0 + 0.15, H.deck.z1 - 0.15,
    [{ z0: H.hatch.lz - H.hatch.w / 2 - 0.15, z1: H.hatch.lz + H.hatch.w / 2 + 0.15 }]);
  for (const s of [-1, 1]) {
    const runs = s === side ? lining : [[H.deck.z0 + 0.15, H.deck.z1 - 0.15]];
    for (const [za, zb] of runs) {
      b.ibox('trim', 0.06, 1.9, zb - za,
        s * (H.deck.hw - 0.03), (H.deck.y + cabin.ceilY) / 2, (za + zb) / 2, 0, 2);
    }
  }
  // The archway between cabin and cockpit: a frame, not a door — two rooms
  // 0.2 m apart are one room and a hatch there would be a prompt with no use.
  b.wallX('trim', H.arch.z, -H.deck.hw, H.deck.hw, H.deck.y, cabin.ceilY,
    -H.arch.hw, H.arch.hw, H.arch.h, 0.14);
  deckLights(b, cabin, 2);
  deckLights(b, cockpit, 2);
  innerRibs(b, cabin, 3, 'dark',
    { cut: { side, z0: H.hatch.lz - H.hatch.w / 2, z1: H.hatch.lz + H.hatch.w / 2 } });
  innerRibs(b, cockpit, 3);
  const wash = [
    ...wallWash(b, cabin, side, { n: 1, intensity: 5, distance: 6 }),
    ...wallWash(b, cockpit, side, { n: 1, intensity: 6, distance: 6 }),
  ];

  /* ── The fit-out, MIRRORED WITH THE DOOR ──────────────────────────────
   *
   * Every local X below is multiplied by `side`, and that is not tidiness. The
   * shell of this hull has always been side-agnostic — the plating opening,
   * the lining cut, the inner ribs and the ramp all take `side` — and its
   * FURNITURE was written for one berth and nailed to absolute coordinates.
   * The berths moved onto piers, `boardSide` came back -1 for this hull and
   * for the Pike, and the bunk that had been laid along the far flank was
   * suddenly along the near one: **91 of 156 samples through the Kestrel's
   * boarding aperture were blocked** by `ship-kestrel-in:crate` 0.26 m inboard
   * of the plating, with the mattress and the locker door behind it. A hatch
   * opening onto the side of a bed.
   *
   * Nothing here consults `ways` — `fitOut` does, the hull's own dressing does
   * not — so the only thing that keeps furniture out of a doorway is the
   * doorway and the furniture being in the same frame. `side` is that frame. */
  const sx = (v) => side * v;
  // Cockpit: a seat on the centreline, a nav station outboard, a lit coaming.
  b.ibox('dark', 0.62, 0.14, 0.66, 0, H.deck.y + 0.42, 2.4, 0, 1);
  b.ibox('crate', 0.60, 0.8, 0.16, 0, H.deck.y + 0.82, 2.06, 0, 1);
  b.ibox('trim', 2.2, 0.16, 0.66, 0, H.deck.y + 0.8, 3.9, 0, 1);
  b.ibox('glow', 1.7, 0.04, 0.3, 0, H.deck.y + 0.9, 3.86, 0, 1);
  b.ibox('crate', 0.8, 1.2, 0.5, sx(-1.5), H.deck.y + 0.6, 3.2, 0, 1);
  b.ibox('glow', 0.5, 0.03, 0.28, sx(-1.5), H.deck.y + 1.21, 3.2, 0, 1);
  // Cabin: a bunk on the far flank, a locker, a fold-down table.
  b.ibox('crate', 0.8, 0.44, 2.0, sx(-1.5), H.deck.y + 0.22, -2.0, 0, 1);
  b.ibox('tarp', 0.76, 0.14, 1.9, sx(-1.5), H.deck.y + 0.51, -2.0, 0, 1);
  b.ibox('crate', 0.7, 1.7, 0.9, sx(1.55), H.deck.y + 0.85, -2.9, 0, 1);
  b.ibox('trim', 0.06, 0.85, 0.85, sx(1.19), H.deck.y + 0.95, -2.9, 0, 1);
  b.ibox('crate', 1.0, 0.08, 0.7, sx(1.3), H.deck.y + 0.78, -0.3, 0, 1);
  /* On the fold-down table and NOT in the locker, where it was.
   * `ShipKit.fitOut` collides that locker from the sole to its head, so a
   * crouch-height column probe finds no standable surface in it at all and
   * `dock-reach` correctly reports the pickup as hanging over nothing. A
   * collectible has to sit on something a body could be beside. */
  b.spot(sx(1.3), H.deck.y + 0.9, -0.3, 'prize');
  b.spot(sx(-1.5), H.deck.y + 0.75, -2.0, 'common');

  /* ── The way in ───────────────────────────────────────────────────── */
  const ramp = boardingRamp(b, H, side, keelY);
  /* `faceOff` puts the leaves 0.075 m PROUD of the plating's outer face rather
   * than in the plane of `lx`, which is the skin's own mid-thickness: a leaf on
   * the door line would slide through the plating either side of the opening.
   * See the pocket note on `ShipKit.hatch`. The two grab posts that used to
   * stand at `hw + 0.1`, 0.75 m each side of the centreline, are gone — that is
   * exactly where a leaf now travels. */
  const door = b.hatch('dock_kestrel_hatch', {
    lx: side * (H.lower.hw - SKIN / 2), ly: H.deck.y + H.hatch.h / 2, lz: H.hatch.lz,
    w: H.hatch.w, h: H.hatch.h, plane: 'x', standY: H.deck.y,
    faceOff: SKIN / 2 + 0.075,
    mat: mats.trim,
  });

  return {
    door, ramp, rooms: H.rooms,
    lights: [
      { x: 0, y: cockpit.ceilY - 0.16, z: 2.6, intensity: 18, distance: 9, floorY: cockpit.floorY },
      { x: 0, y: cabin.ceilY - 0.16, z: -1.8, intensity: 16, distance: 9, floorY: cabin.floorY },
      ...wash,
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Dray — ore tender, berth B2                                         */
/* ------------------------------------------------------------------ */

export function buildDray(b, side, keelY, mats) {
  const H = DRAY;
  const hold = H.rooms[0], engine = H.rooms[1], cockpit = H.rooms[2];
  /* The side tank between the plating and the hold's own bulkhead. The cargo
   * door is in the FLANK and the hold is 1.85 m inboard of it, so without this
   * the door opens into a void with no floor — a hatch you step through and
   * fall out of the bottom of. */
  const tankOuter = H.lower.hw - SKIN;
  const tankInner = hold.hw + 0.24;

  /**
   * THE AUTHORED SKIN, OR NULL — the same pipeline `buildKestrel` proved, and
   * the same complaint. The Dray was the worst of the four to look at and the
   * hardest to fix, because her bulk is the point: a 28 m ore tender is
   * SUPPOSED to read heavy, and the lazy way to draw heavy is a rectangle.
   * This file drew her as one — a plated drum with a box on top of it and a
   * box on top of that, with a lattice derrick and a counter stern, which from
   * the apron is a barge with a crane on it.
   *
   * `scripts/make-ship-glb.mjs` (SHIP_GLB_HULL=dray) bakes the replacement:
   * one swept skin from the transom to the stem with a hopper knuckle carrying
   * the max beam and the plating sloping in under it, a radiused deckhouse
   * with a portal instead of a hole in its front, a raked wheelhouse whose
   * glazing follows the rake because it is the same surface, two external
   * pressure tanks on saddles and three engines with throats you can see down.
   *
   * `null` is the file missing, the fetch failing, or a headless test with no
   * `fetch` at all — and then this function builds exactly the hull it built
   * before, dressing and all. Both arms are pinned by `scripts/tests/
   * ship-dray.test.mjs`.
   */
  const skin = shipParts('dray', { mirrorX: side < 0 });

  /* ── Hull ──────────────────────────────────────────────────────────────
   *
   * Muted while there is an authored skin: every collider, every aperture and
   * every room below is registered exactly as it always was, and only the
   * DRAWING is suppressed. See `ShipBuild.mute`. */
  b.mute(!!skin);
  keel(b, H, { tile: 3.2 });
  flankAperture(b, H.lower, side, H.hatch, H.deck.y);
  /* The superstructure has no forward cap: the companionway up from the
   * foredeck comes in through the open front, which is what a bridge front is,
   * and a cap there would be a bulkhead through the middle of a stair. */
  plated(b, H.upper, 'hull', { capFore: false });
  /* The two walkable plates and their edge stripes are drawn on BOTH arms.
   * Each one's TOP is a deck the climb mantles onto and its UNDERSIDE is a
   * compartment's ceiling — rule 2 — and the authored skin closes exactly
   * beneath each of them rather than trying to be them: a surface with no
   * thickness cannot be a deck you stand on and a deckhead at the same time. */
  b.mute(false);
  deckSlab(b, 'deckg', H.ledge.y, H.ledge.outer, H.lower.z0, H.lower.z1,
    [[H.lift.lx, H.lift.lz, H.lift.half + 0.05]]);
  deckSlab(b, 'deckg', H.spine.y, H.spine.hw, H.spine.z0, H.spine.z1,
    [[H.lift.lx, H.lift.lz, H.lift.half + 0.05], [H.spineHole.lx, H.spineHole.lz, H.spineHole.half]]);
  edgeStripe(b, H.ledge.outer, H.ledge.y, H.lower.z0 + 0.5, H.lower.z1 - 0.5);
  edgeStripe(b, H.spine.hw, H.spine.y, H.spine.z0 + 0.5, H.spine.z1 - 0.5);

  /* ── Sealed volumes ───────────────────────────────────────────────────
   * Side tanks, the space forward of the cockpit and the space aft of the
   * engine room. Every one of them is a hollow box with a floor and two metres
   * of headroom, and a walk probe is right to call that standable — so it is
   * filled rather than argued with. Collider only: no triangles, no draws.
   * The side tank on the boarding flank is filled in two runs so the cargo
   * passage through it stays a passage. */
  for (const sg of [-1, 1]) {
    const cx = sg * (tankInner + tankOuter) / 2;
    const hx = (tankOuter - tankInner) / 2;
    const runs = sg === side
      ? [[H.lower.z0 + SKIN, H.hatch.lz - H.hatch.w / 2 - 0.32], [H.hatch.lz + H.hatch.w / 2 + 0.32, H.lower.z1 - SKIN]]
      : [[H.lower.z0 + SKIN, H.lower.z1 - SKIN]];
    for (const [za, zb] of runs) {
      if (zb - za < 0.05) continue;
      b.solid(cx, (H.deck.y + H.ledge.y) / 2, (za + zb) / 2, hx, (H.ledge.y - H.deck.y) / 2, (zb - za) / 2);
    }
  }
  fill(b, tankInner, H.belly.y1, H.ledge.y - DECK_T, H.rooms[2].z1, H.lower.z1 - SKIN);
  fill(b, tankInner, H.belly.y1, H.ledge.y - DECK_T, H.lower.z0 + SKIN, H.rooms[1].z0);
  // The superstructure is a shell round a stair well, not a bridge house: it
  // is filled everywhere except the run the companionway comes up through.
  fill(b, H.upper.hw - SKIN, H.upper.y0, H.upper.y1, H.upper.z0 + SKIN, H.spineHole.lz - H.spineHole.half);

  /* The plated hull's own surface interest: two string courses, their bolt
   * rows, nine section ribs and two knuckle strakes. All of it is pinned to a
   * flank at exactly `hw`, which is what a flat plated side is and what an
   * authored one is not — this skin carries its max beam at a knuckle 2.08 m
   * up and slopes 0.50 m inboard under it, so a course pinned to 5.20 would
   * float half a metre off its own hull along the bottom of every run. The
   * authored arm's equivalents are generated from the section functions
   * themselves and cannot do that. */
  b.mute(!!skin);
  b.course('trim', H.lower.hw, H.lower.z0, H.lower.z1, H.ledge.y - 0.34, { h: 0.3, proud: 0.18 });
  b.course('trim', H.lower.hw, H.lower.z0, H.lower.z1, 2.3, { h: 0.26, proud: 0.16 });
  b.course('trim', H.upper.hw, H.upper.z0, H.upper.z1, H.upper.y1 - 0.3, { h: 0.26, proud: 0.16 });
  for (const s of [-1, 1]) {
    b.bolts('trim', s * (H.lower.hw + 0.07), H.ledge.y - 0.34, H.lower.z0 + 1, H.lower.z1 - 1, 22);
    b.bolts('trim', s * (H.lower.hw + 0.07), 2.3, H.lower.z0 + 1, H.lower.z1 - 1, 22);
  }
  for (let i = 0; i < 9; i++) {
    b.rib('trim', H.lower.hw, H.lower.y0, H.ledge.y - 0.5, H.lower.z0 + 1.4 + i * 2.6, 0.24, 0.14);
  }

  // The knuckles: the turn of the bilge, and the deck edge under the sheer
  // strake. Drawn only — see `knuckle`.
  knuckle(b, 'hull', H.lower.hw, H.ledge.y, H.lower.z0, H.lower.z1, 1, 0.44);
  knuckle(b, 'hull', H.lower.hw, H.lower.y0, H.lower.z0, H.lower.z1, -1, 0.5);

  /* ── The bow ──────────────────────────────────────────────────────────
   * A raked stem with flare over a bulbous forefoot, lofted in six stations.
   * It was three stepped boxes, and three steps on a 3 m bow is a staircase
   * seen end-on — the one silhouette detail every viewer of a ship reads
   * first, spent on nothing. */
  const BC = H.bowCap;
  loftSolid(b, 'hull', [
    { z: BC.z0, pts: sec(5.20, 0.84, H.ledge.y, { ct: 0.7, cb: 1.4, bw: 4.3 }) },
    { z: 11.9, pts: sec(4.85, 1.02, 4.52, { ct: 0.9, cb: 1.5, bw: 3.5, tw: 4.1 }) },
    { z: 12.7, pts: sec(3.95, 1.28, 4.42, { ct: 1.0, cb: 1.6, bw: 2.4, tw: 3.1 }) },
    { z: 13.4, pts: sec(2.70, 1.62, 4.28, { ct: 1.0, cb: 1.5, bw: 1.3, tw: 1.9 }) },
    { z: BC.z1, pts: sec(1.20, 2.10, 4.08, { ct: 0.9, cb: 1.1, bw: 0.5, tw: 0.7 }) },
  ], { tile: 3, capFore: true });
  // The stem bar, and the anchor pocket cut into the flare below it.
  b.box('trim', 0.26, 0.26, 3.3, 0, 3.1, 12.6, 0, 1);
  for (const s of [-1, 1]) {
    b.box('dark', 0.16, 0.9, 1.3, s * 4.0, 3.3, 12.0, 0, 1);
    b.put('trim', new THREE.CylinderGeometry(0.14, 0.14, 1.1, 6).rotateZ(Math.PI / 2), s * 4.2, 3.3, 12.0);
  }

  /* ── The stern ────────────────────────────────────────────────────────
   * A cruiser counter over the transom, three bells under it. The bells are
   * drawn faceted and collided as ONE block: eight boxes round a cone give the
   * climb probe a new normal every 45 degrees, which is the chatter
   * `CitadelWorld.js:71-74` records — a tapering shell in this world is
   * dressing you bump into, never a face you grip. */
  loftSolid(b, 'hull', [
    { z: -14.0, pts: sec(3.30, 1.90, 4.10, { ct: 0.9, cb: 0.9, bw: 2.2, tw: 2.4 }) },
    { z: -13.6, pts: sec(4.30, 1.50, 4.34, { ct: 0.9, cb: 1.2, bw: 3.0, tw: 3.5 }) },
    { z: H.lower.z0, pts: sec(5.20, 0.84, H.ledge.y, { ct: 0.7, cb: 1.4, bw: 4.3 }) },
  ], { tile: 3, capAft: true });
  b.cbox('dark', 8.2, 2.2, 0.9, 0, 2.2, H.z0 + 1.4, 0, 2);
  /* THE BELLS HANG OFF THE TRANSOM, THEY ARE NOT BURIED IN IT.
   *
   * They used to sit at z -14.25..-12.75 against a hull that ends at -14.00, so
   * 0.25 m of nozzle showed and from the beam this ship's stern was a rounded
   * counter with nothing behind it — which, with a raked stem, a bulwark and a
   * derrick over the well deck, is a barge. On a mount 1.1 m proud of the
   * transom they project 1.55 m clear, and an engine you can see the back of is
   * the single cheapest thing that says a hull leaves the ground.
   *
   * `H.z0` is the hull's own aft limit and the silhouette probe clips to it, so
   * this geometry is deliberately outside the range that probe measures: it is
   * here to be looked at, not to move a number. */
  for (const s of [-1, 0, 1]) {
    // The mount each bell is carried on, so the nozzle is not floating.
    b.cbox('dark', 1.9, 1.9, 1.2, s * 3.0, 2.2, H.z0 + 0.35, 0, 2);
    bell(b, s * 3.0, 2.2, H.z0 - 0.7, 1.05, 1.45, 1.7, { seg: 10, solid: false });
  }

  /* ── The shell ends here ──────────────────────────────────────────────
   * The bow, the stern and the engines are all part of the one baked surface
   * on the authored arm; everything from here down is deck furniture, plant
   * and fit-out, and is drawn on both. */
  b.mute(false);

  /* ── The foredeck's furniture ─────────────────────────────────────────
   * Bollards, a spare-plate stack and the mooring winch. The brow lands on
   * this deck at local (-1.6, 8.0) and the companionway starts at z 4.0, so
   * everything here is outboard of |x| 2.5 — the lane between the two is the
   * route quest 55 walks. */
  for (const s of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      b.cbox('trim', 0.34, 0.5, 0.34, s * 4.3, H.ledge.y + 0.25, 3.5 + i * 1.7, 0, 1);
    }
  }
  b.cbox('crate', 2.2, 0.9, 1.6, 3.4, H.ledge.y + 0.45, 6.4, 0, 1);
  b.cbox('dark', 0.5, 1.1, 2.4, -3.3, H.ledge.y + 0.55, 4.8, 0, 1);
  b.box('hazard', 3.4, 0.05, 0.4, 0, H.ledge.y + 0.03, 2.6, 0, 1);
  // The hatch coaming amidships on the foredeck: what the derrick lowers into.
  b.cbox('trim', 4.6, 0.42, 3.0, 0, H.ledge.y + 0.21, 9.2, 0, 2);
  b.box('hazard', 4.8, 0.05, 0.3, 0, H.ledge.y + 0.44, 9.2, 0, 1);
  for (let i = 0; i < 3; i++) {
    b.box('dark', 4.2, 0.08, 0.7, 0, H.ledge.y + 0.44, 8.2 + i, 0, 1);
  }

  /* ── The bridge castle ────────────────────────────────────────────────
   * Standing on the after end of the spine deck. See `DRAY.bridge` for why it
   * is aft rather than amidships: two published routes cross this deck.
   *
   * Collided as its own shell and FILLED, because a hollow castle is a 5 x 6 m
   * room with a floor and two metres of headroom that a walk probe is right to
   * call standable and no player can ever reach. */
  const BR = H.bridge;
  const brz = (BR.z0 + BR.z1) / 2;
  b.mute(!!skin);
  loftSolid(b, 'hull', [
    { z: BR.z0, pts: sec(BR.hw, BR.y0, BR.y1 - 0.5, { ct: 0.5, cb: 0.2, tw: BR.hw - 0.4 }) },
    { z: BR.z0 + 1.2, pts: sec(BR.hw, BR.y0, BR.y1, { ct: 0.5, cb: 0.2, tw: BR.hw - 0.5 }) },
    { z: BR.z1 - 1.0, pts: sec(BR.hw, BR.y0, BR.y1, { ct: 0.5, cb: 0.2, tw: BR.hw - 0.5 }) },
    { z: BR.z1, pts: sec(BR.hw - 0.5, BR.y0, BR.y1 - 0.85, { ct: 0.4, cb: 0.2, tw: BR.hw - 0.9 }) },
  ], { tile: 3 });
  /* The wheelhouse band: glass all round the forward two thirds, which is the
   * one thing that says a ship is CREWED rather than parked. Set 0.06 m proud
   * so it is never coplanar with the plating behind it. */
  for (const s of [-1, 1]) {
    b.box('glass', 0.08, 0.86, BR.z1 - BR.z0 - 1.4, s * (BR.hw + 0.03), BR.y1 - 0.72, brz + 0.2, 0, 2);
    b.box('trim', 0.14, 0.12, BR.z1 - BR.z0 - 1.2, s * (BR.hw + 0.02), BR.y1 - 0.24, brz + 0.2, 0, 1);
    b.box('trim', 0.14, 0.12, BR.z1 - BR.z0 - 1.2, s * (BR.hw + 0.02), BR.y1 - 1.2, brz + 0.2, 0, 1);
  }
  b.box('glass', (BR.hw - 0.55) * 2, 0.86, 0.1, 0, BR.y1 - 0.9, BR.z1 - 0.04, 0, 2);
  /* And the mute comes off before the roof gear and the bridge wings, which
   * are drawn on both arms: the wings are collided platforms 2.0 m over the
   * side deck, and a collided platform nobody can see is worse than a boxy
   * one. */
  b.mute(false);
  // The bridge roof: a mast stub, a radar bar and the running lights.
  b.cbox('trim', 0.2, 1.5, 0.2, 0, BR.y1 + 0.75, brz - 0.6, 0, 1);
  b.put('trim', new THREE.CylinderGeometry(0.05, 0.05, 3.6, 6).rotateZ(Math.PI / 2), 0, BR.y1 + 1.4, brz - 0.6);
  b.box('glow', 0.24, 0.24, 0.24, 0, BR.y1 + 1.62, brz - 0.6, 0, 1);
  for (const s of [-1, 1]) {
    b.box('lamp', 0.4, 0.12, 0.3, s * (BR.hw - 0.5), BR.y1 + 0.1, BR.z1 - 0.5, 0, 1);
    // Bridge wings, cantilevered outboard. Overhead: 2.0 m over the side deck.
    b.cbox('deckg', 1.5, 0.14, 2.2, s * (BR.hw + 0.7), BR.y1 - 1.5, brz + 0.6, 0, 1.4);
    b.rbox('trim', 0.12, 0.12, 1.6, s * (BR.hw + 0.7), BR.y1 - 2.0, brz + 0.6, s * 1.1, 0, 0, 1);
  }

  /* ── Landing gear ─────────────────────────────────────────────────────
   * FOUR LEGS, AND THEY ARE THE DIFFERENCE BETWEEN A SHIP AND A BOAT.
   *
   * This hull had none. She has a raked stem, a counter stern, a bulwark, a
   * derrick and a bridge castle with wings, and every one of those is a thing
   * a SEAGOING vessel has — so from across the bay she read as a barge with a
   * crane on it, which is very close to what the player said about the yard.
   * Nothing in the silhouette said she ever leaves the ground.
   *
   * Legs say it in one glance, and they say it in the measurement too. On the
   * silhouette probe in `dock-hull-shape.test.mjs`, adding them moved her
   * broadside from `runs 1.87 / stack 1.33` to `2.00 / 1.43`, her quarter from
   * `1.69 / 1.79` to `1.81 / 1.92` and her bow from `1.79 / 1.65` to
   * `2.10 / 1.83` — daylight on both axes, which is what a machine standing on
   * legs has and a hull sitting in water does not. Neither figure was under
   * the floor beforehand: this is a hull that was passing and still read
   * wrong, which is the whole reason the player had to say it out loud.
   *
   * `scale: 1.7` against the Kestrel's, because a 28 m ore tender standing on
   * a courier's undercarriage is its own kind of wrong.
   *
   * `y0` is -0.42 rather than the shed floor: she stands on a cradle whose
   * bearing face is ship-local y 0, and legs drawn down to the apron would be
   * legs drawn through the saddles. */
  gear(b, {
    hw: H.lower.hw, y0: -0.42, y1: H.belly.y0 + 0.12, scale: 1.7,
    stations: [[-3.6, -9.2], [3.6, -9.2], [-3.6, 6.6], [3.6, 6.6]],
  });

  /* ── The ore hoppers ──────────────────────────────────────────────────
   * Two cones on the deckhouse, and they are to PORT ONLY. This is the cargo
   * geometry — an ore tender that carries nothing visible is a tug — and it is
   * on one side for two reasons that agree with each other. The second
   * asymmetry makes the hull readable from either beam, and the STARBOARD side
   * deck is where the second move of the climb lands: `DRAY.bands[1]` grips the
   * superstructure at local x 4.05 and `Climb` puts the body 0.77 m inboard of
   * it, so a hopper at +2.75 with a 1.20 m radius is standing exactly where the
   * mantle finishes. The first version of this deck did, and the band failed
   * with 0.87 m of headroom against the 1.55 the probe demands. */
  const HP = H.hoppers;
  for (const hz of HP.zs) {
    b.put('accent', new THREE.CylinderGeometry(HP.r, HP.r * 0.35, 1.5, 8), HP.x, HP.y0 + 0.75, hz);
    b.put('accent', new THREE.CylinderGeometry(HP.r, HP.r, HP.y1 - HP.y0 - 1.5, 8),
      HP.x, (HP.y0 + 1.5 + HP.y1) / 2, hz);
    b.put('trim', new THREE.CylinderGeometry(HP.r + 0.06, HP.r + 0.06, 0.16, 8), HP.x, HP.y0 + 1.55, hz);
    b.put('trim', new THREE.CylinderGeometry(HP.r * 0.55, HP.r * 0.55, 0.22, 8), HP.x, HP.y1 + 0.1, hz);
    /* `lamp` and not `warn`, and the reason is a draw call rather than a
     * colour: one mesh per material key per batch, and `warn` is a key this
     * hull's exterior batch does not otherwise use — two hopper hatch lights
     * would have cost a whole mesh out of a 140 budget that is already at
     * 138. */
    b.box('lamp', 0.3, 0.06, 0.3, HP.x, HP.y1 + 0.23, hz, 0, 1);
    b.solid(HP.x, (HP.y0 + HP.y1) / 2, hz, HP.r * 0.8, (HP.y1 - HP.y0) / 2, HP.r * 0.8);
  }
  // The conveyor gallery tying the two hoppers together.
  b.box('dark', 0.9, 0.5, HP.zs[1] - HP.zs[0], HP.x, HP.y1 - 0.5, (HP.zs[0] + HP.zs[1]) / 2, 0, 2);

  /* ── The derrick ──────────────────────────────────────────────────────
   * A mast on the forward face of the deckhouse and a lattice boom raked out
   * over the foredeck hatch. Drawn only, and named here as one of rule 4's
   * overhead exceptions: the heel is 2.5 m over the spine deck and the tip is
   * 4 m over the foredeck, so nothing on this ship is within reach of it. */
  const D = H.derrick;
  b.cbox('trim', 0.55, D.heelY - H.spine.y, 0.55, D.mastX, (H.spine.y + D.heelY) / 2, D.mastZ, 0, 1);
  lattice(b, 'trim', D.mastX, D.heelY, D.mastZ, D.mastX, D.mastTop, D.mastZ - 0.3, { w: 0.42, bay: 1.7 });
  lattice(b, 'trim', D.mastX, D.heelY, D.mastZ + 0.5, D.mastX, D.tipY, D.tipZ, { w: 0.5, bay: 1.8 });
  // The crosstree, the hoist wire and the hook block on the end of it.
  b.box('trim', 4.2, 0.16, 0.16, 0, D.mastTop - 0.9, D.mastZ - 0.3, 0, 1);
  for (const s of [-1, 1]) {
    b.box('lamp', 0.34, 0.1, 0.24, s * 1.8, D.mastTop - 1.02, D.mastZ - 0.3, 0, 1);
    b.rbox('trim', 0.07, 0.07, Math.hypot(D.mastTop - D.tipY - 0.9, D.tipZ - D.mastZ),
      s * 0.28, (D.mastTop - 0.9 + D.tipY) / 2, (D.mastZ + D.tipZ) / 2,
      0, Math.atan2(D.mastTop - 0.9 - D.tipY, D.tipZ - D.mastZ), 0, 1);
  }
  b.box('glow', 0.2, 0.2, 0.2, 0, D.mastTop + 0.2, D.mastZ - 0.3, 0, 1);
  /* ── THE GRAPPLE, AND WHY IT NO LONGER HANGS ──────────────────────────
   *
   * This was a 0.09 m wire with a 0.7 x 0.6 x 0.5 m block and a ring swinging
   * 1.7 m under the boom tip, and it is the single loudest thing on this hull:
   * a block on a wire is a statement about GRAVITY, and a ship that makes that
   * statement is a harbour tug however you shape her plating. Every review of
   * this yard has called the Dray a tug, and this is what they were reading.
   *
   * It is a ram now, not a fall: a 0.24 m square telescopic column hard under
   * the tip with the grapple head clamped on the end of it, stowed. Same
   * silhouette element in the same place, drawn with the same three material
   * keys, and no longer a plumb line. `DRAY.derrick.hookY` moves with it — the
   * plan and the drawing are the same number, as they were before. */
  const ramLen = D.tipY - D.hookY;
  b.box('trim', 0.24, ramLen, 0.24, 0, (D.tipY + D.hookY) / 2, D.tipZ - 0.1, 0, 1);
  b.box('dark', 0.7, 0.6, 0.5, 0, D.hookY, D.tipZ - 0.1, 0, 1);
  /* Rotated into the vertical plane: a grapple ring clamped under the head,
   * not a hook dangling from it. A `TorusGeometry` lies in XY by default, so
   * the untouched one was a ring lying FLAT — which reads as a hook's eye seen
   * from above, i.e. as a fall again. */
  b.put('trim', new THREE.TorusGeometry(0.28, 0.07, 5, 8).rotateX(Math.PI / 2),
    0, D.hookY - 0.36, D.tipZ - 0.1);

  /* ── The radiator bank, starboard only ────────────────────────────────
   * The asymmetry is deliberate and it is the only one in the yard: it tells
   * you which way round you are looking at this hull. `DRAY.radiator.y0` is
   * 2.04 m over the side deck, so a 1.75 m body walks under it. */
  const RD = H.radiator;
  b.cbox('dark', RD.x1 - RD.x0, 0.34, RD.z1 - RD.z0, (RD.x0 + RD.x1) / 2, RD.y1 + 0.2, (RD.z0 + RD.z1) / 2, 0, 2);
  for (let i = 0; i < RD.fins; i++) {
    const fz = RD.z0 + ((i + 0.5) * (RD.z1 - RD.z0)) / RD.fins;
    // 0.24 m fins on a 0.75 m pitch: thinner than the gap, or the bank merges
    // into one slab at 20 m and the whole point of drawing fins is lost.
    b.box('accent', RD.x1 - RD.x0, RD.y1 - RD.y0, 0.24, (RD.x0 + RD.x1) / 2, (RD.y0 + RD.y1) / 2, fz, 0, 2);
    b.box('glow', RD.x1 - RD.x0 - 0.5, 0.05, 0.12, (RD.x0 + RD.x1) / 2, RD.y0 + 0.2, fz + 0.28, 0, 1);
    b.rbox('trim', 0.1, 0.1, 1.9, RD.x1 - 0.3, RD.y0 - 0.55, fz, 0.6, 0, 0.5, 1);
  }
  b.solid((RD.x0 + RD.x1) / 2, (RD.y0 + RD.y1) / 2 + 0.15, (RD.z0 + RD.z1) / 2,
    (RD.x1 - RD.x0) / 2, (RD.y1 - RD.y0) / 2 + 0.25, (RD.z1 - RD.z0) / 2);

  /* ── The companionway from the foredeck up to the spine ───────────── */
  b.flight('z', 0, H.ledge.y, H.foreStep.lz, H.foreStep.run, H.foreStep.rise,
    H.foreStep.width, H.foreStep.risers);
  b.box('hazard', H.spineHole.half * 2 + 0.4, 0.04, 0.3, H.spineHole.lx, H.spine.y + 0.02,
    H.spineHole.lz - H.spineHole.half - 0.2, 0, 1);
  /* The masthead gear used to stand on the open spine at z -9 and -11, which
   * is inside the bridge castle now — it moved onto the castle's roof, where a
   * ship's masthead gear belongs. */

  /* The authored skin, placed in the hull's own frame — which is the frame it
   * was generated in, so there is no transform and nothing to get wrong. Each
   * part rides the yard's cached material of its own name; see `ShipAssets`. */
  if (skin) {
    for (const p of skin) b.put(p.key, p.geometry, 0, 0, 0);
    /* The two external tanks, which nothing else collides. They are drawn 2.06
     * m over the side deck — `DRAY.radiator`'s own rule, and the radiator is
     * collided for the same reason — and 0.70 m outboard of the spine deck's
     * edge, so a body walking either deck cannot reach them and a body that
     * came off the spine edge meets metal instead of falling past it.
     * INSCRIBED in the 0.90 m shell, which is `loftSolid`'s rule: 0.64 is the
     * half-side of the square that fits inside that circle. */
    for (const s of [-1, 1]) {
      b.solid(s * 5.65, 7.52, -3.10, 0.64, 0.64, 2.70);
    }
  }

  /* ── Relief and gear ──────────────────────────────────────────────── */
  if (!skin) {
    /* `panelLines` and `relief` lay boxes on a flank at exactly `hw`. On the
     * authored skin the flank is 5.20 only at the knuckle: it tumbles to 5.11
     * at the deck edge and slopes to 4.70 at the turn of the bilge, so a patch
     * pinned to 5.20 floats. Surface interest on that arm comes from the shape
     * and from the plating map, which is what the UVs in the .glb are for. */
    panelLines(b, { hw: H.lower.hw, y0: H.lower.y0, y1: H.ledge.y, z0: H.lower.z0, z1: H.lower.z1, pitchZ: 1.5, pitchY: 0.66 });
    panelLines(b, { hw: H.upper.hw, y0: H.upper.y0, y1: H.upper.y1, z0: H.upper.z0, z1: H.upper.z1, pitchZ: 1.3, pitchY: 0.6, key: 'accent' });
    relief(b, { hw: H.lower.hw, y0: H.lower.y0 + 0.4, y1: H.ledge.y - 0.6, z0: H.lower.z0 + 1, z1: H.lower.z1 - 1, n: 222, seed: 41 });
    relief(b, { hw: H.upper.hw, y0: H.upper.y0 + 0.3, y1: H.upper.y1 - 0.4, z0: H.upper.z0 + 0.6, z1: H.upper.z1 - 0.6, n: 84, seed: 53, key: 'accent' });
  }
  deckDetail(b, { hw: H.ledge.outer - 0.6, y: H.ledge.y, z0: H.foredeck.z0 + 0.5, z1: H.foredeck.z1 - 0.8, n: 48, seed: 59 });
  // Only the OPEN run of the spine deck: aft of z -6.2 is the castle's floor.
  deckDetail(b, { hw: H.spine.hw - 0.4, y: H.spine.y, z0: H.bridge.z1 + 0.3, z1: H.spine.z1 - 2.6, n: 22, seed: 61, key: 'accent' });
  /* Aft of the cargo door, not over it. A 4.0 m plane at z -2.0 spanned
   * -4.00..0.00 and the cargo aperture is -4.00..1.00; at z -8.0 it spans
   * -10.00..-6.00, on plating that runs back to -13.00. */
  berthStencil(b, 4.0, 1.6, YARD_SIGN.berthB2, H.lower.hw, 3.2, -8.0);

  /* ── Interior ─────────────────────────────────────────────────────── */
  deckSlab(b, 'deckg', H.deck.y, H.deck.hw, H.deck.z0, H.deck.z1);
  // Longitudinal bulkheads: side tanks outboard, a 6 m hold between them. The
  // boarding side is cut for the cargo passage.
  for (const s of [-1, 1]) {
    if (s === side) {
      b.wallZ('trim', s * (hold.hw + 0.12), hold.z0, hold.z1, H.deck.y, hold.ceilY,
        H.hatch.lz - H.hatch.w / 2, H.hatch.lz + H.hatch.w / 2, H.hatch.h, 0.24);
    } else {
      b.cbox('trim', 0.24, hold.ceilY - H.deck.y, hold.z1 - hold.z0,
        s * (hold.hw + 0.12), (H.deck.y + hold.ceilY) / 2, (hold.z0 + hold.z1) / 2, 0, 2);
    }
    b.cbox('trim', 0.24, engine.ceilY - H.deck.y, engine.z1 - engine.z0,
      s * (engine.hw + 0.12), (H.deck.y + engine.ceilY) / 2, (engine.z0 + engine.z1) / 2, 0, 2);
    b.cbox('trim', 0.20, cockpit.ceilY - cockpit.floorY, cockpit.z1 - cockpit.z0,
      s * (cockpit.hw + 0.10), (cockpit.floorY + cockpit.ceilY) / 2, (cockpit.z0 + cockpit.z1) / 2, 0, 2);
  }
  /* The cargo passage through the side tank. Floor, two end walls, a deckhead —
   * so the door leads somewhere rather than into the tank. */
  const passC = side * (tankInner + tankOuter) / 2;
  const passW = tankOuter - tankInner;
  b.cbox('deckg', passW, DECK_T, H.hatch.w + 0.6, passC, H.deck.y - DECK_T / 2, H.hatch.lz, 0, 2);
  for (const s of [-1, 1]) {
    b.cbox('trim', passW, H.hatch.h + 0.3, 0.2, passC, H.deck.y + (H.hatch.h + 0.3) / 2,
      H.hatch.lz + s * (H.hatch.w / 2 + 0.3), 0, 2);
  }
  b.cbox('trim', passW, 0.16, H.hatch.w + 0.6, passC, H.deck.y + H.hatch.h + 0.38, H.hatch.lz, 0, 2);
  b.ibox('warn', 0.5, 0.06, 0.4, passC, H.deck.y + H.hatch.h + 0.24, H.hatch.lz, 0, 1);

  deckhead(b, 'trim', engine, 0.06);
  // Aft bulkhead of the hold, with the engine-room hatch through it.
  b.wallX('trim', H.engineHatch.lz, -hold.hw, hold.hw, H.deck.y, hold.ceilY,
    -H.engineHatch.w / 2, H.engineHatch.w / 2, H.engineHatch.h, 0.18);
  /* `plane: 'z'`, AND IT USED TO SAY `'x'`.
   *
   * `plane` names the axis the door's NORMAL runs along, and this hatch is cut
   * through a TRANSVERSE bulkhead at local z -6.00 — the aft wall of the hold,
   * whose opening runs 1.2 m across in X. Declared as `'x'` it was built as a
   * door lying fore-and-aft on the keel line: its collider came out 0.12 m
   * thick in X and 1.2 m long in Z, so a SHUT engine hatch sealed 0.12 m of a
   * 1.20 m doorway and a body walked through the other 90% of it; and the leaf
   * was hung a full width away at z -7.20, a metre and a fifth inside the
   * engine room. Nothing caught it because the aperture probe in
   * `dock-interiors` fires along the hull's X axis at the FLANK doors, and this
   * is the only transverse door on any of the four hulls.
   *
   * `faceSign: 1` parks the leaves on the hold side, where the player is
   * standing when they work it. */
  const engineDoor = b.hatch('dock_dray_engine', {
    lx: 0, ly: H.deck.y + H.engineHatch.h / 2, lz: H.engineHatch.lz,
    w: H.engineHatch.w, h: H.engineHatch.h, plane: 'z', standY: H.deck.y,
    faceOff: 0.19, faceSign: 1,
    mat: mats.accent,
  });
  // Forward bulkhead, and the flight up to the cockpit through it.
  b.wallX('trim', H.cockpitArch.z, -hold.hw, hold.hw, H.deck.y, hold.ceilY,
    -H.cockpitArch.hw, H.cockpitArch.hw, cockpit.floorY - H.deck.y + H.cockpitArch.h, 0.18);
  b.flight('z', 0, H.deck.y, H.stair.z0, H.stair.run, H.stair.rise, H.stair.width, H.stair.risers);
  deckSlab(b, 'deckg', cockpit.floorY, cockpit.hw, H.cockpitArch.z, cockpit.z1);
  b.cbox('hull', cockpit.hw * 2 + 0.4, cockpit.ceilY - cockpit.floorY, 0.2,
    0, (cockpit.floorY + cockpit.ceilY) / 2, cockpit.z1, 0, 2);
  b.put('glass', new THREE.PlaneGeometry(2.6, 1.5), 0, 3.5, cockpit.z1 + 0.03, 0, -0.3);

  deckLights(b, hold, 4, { w: 1.4 });
  deckLights(b, engine, 2, { w: 0.9 });
  deckLights(b, cockpit, 2, { w: 0.7 });
  innerRibs(b, hold, 5, 'dark',
    { cut: { side, z0: H.hatch.lz - H.hatch.w / 2, z1: H.hatch.lz + H.hatch.w / 2 } });
  innerRibs(b, engine, 3);
  const wash = [
    ...wallWash(b, hold, side, { n: 2, intensity: 17, distance: 9 }),
    ...wallWash(b, engine, side, { n: 1, intensity: 6, distance: 6 }),
    ...wallWash(b, cockpit, side, { n: 1, intensity: 5, distance: 5, y: 1.35 }),
  ];

  // The hold, dressed: ore crates, a strapping rail, a tally board.
  for (let i = 0; i < 7; i++) {
    const z = hold.z0 + 1.1 + i * 1.15;
    b.ibox('crate', 1.5, 1.0, 1.0, (i % 2 ? -1 : 1) * 1.7, H.deck.y + 0.5, z, (i * 0.4) % 1.2, 1);
  }
  b.ibox('trim', 0.1, 0.1, hold.z1 - hold.z0 - 0.6, hold.hw - 0.2, H.deck.y + 1.3, (hold.z0 + hold.z1) / 2, 0, 1);
  b.ibox('crate', 1.2, 0.9, 0.1, -hold.hw + 0.25, H.deck.y + 1.7, hold.z1 - 1.4, 0, 1);
  b.spot(1.8, H.deck.y + 1.15, hold.z0 + 2.2, 'common');
  b.spot(-1.8, H.deck.y + 1.15, hold.z1 - 2.6, 'common');
  // The engine room: a block, pipework, a bench.
  b.ibox('dark', 2.2, 1.6, 2.6, 0, H.deck.y + 0.8, -8.6, 0, 1);
  b.ibox('glow', 1.2, 0.1, 0.3, 0, H.deck.y + 1.62, -7.3, 0, 1);
  for (let i = 0; i < 4; i++) {
    b.iput('trim', new THREE.CylinderGeometry(0.11, 0.11, 4.2, 8).rotateX(Math.PI / 2),
      -1.5 + i * 0.3, H.deck.y + 2.3, -8.5);
  }
  b.ibox('crate', 1.0, 0.85, 0.6, 1.4, H.deck.y + 0.42, -10.2, 0, 1);
  b.spot(1.4, H.deck.y + 1.0, -10.2, 'rare');
  // The cockpit: two seats, a console, a chart table.
  for (const s of [-1, 1]) {
    b.ibox('dark', 0.55, 0.12, 0.6, s * 0.55, cockpit.floorY + 0.42, 4.4, 0, 1);
    b.ibox('crate', 0.52, 0.66, 0.14, s * 0.55, cockpit.floorY + 0.78, 4.08, 0, 1);
  }
  b.ibox('trim', 2.4, 0.16, 0.7, 0, cockpit.floorY + 0.78, cockpit.z1 - 0.5, 0, 1);
  b.ibox('glow', 1.9, 0.05, 0.32, 0, cockpit.floorY + 0.88, cockpit.z1 - 0.52, 0, 1);
  b.spot(0, cockpit.floorY + 1.0, cockpit.z1 - 0.5, 'prize');

  /* ── The lift ─────────────────────────────────────────────────────── */
  const lift = b.lift('dock_dray_lift', {
    lx: H.lift.lx, lz: H.lift.lz, half: H.lift.half,
    stops: H.lift.stops, mat: mats.deckg, railMat: mats.trim,
  });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.box('trim', 0.12, H.spine.y - H.deck.y, 0.12,
        H.lift.lx + sx * (H.lift.half + 0.1), (H.deck.y + H.spine.y) / 2,
        H.lift.lz + sz * (H.lift.half + 0.1), 0, 1);
    }
  }
  b.box('hazard', (H.lift.half + 0.3) * 2, 0.04, (H.lift.half + 0.3) * 2,
    H.lift.lx, H.spine.y + 0.02, H.lift.lz, 0, 1);

  /* ── The way in ───────────────────────────────────────────────────── */
  const ramp = boardingRamp(b, H, side, keelY);
  /* Three metres of clear width, so each leaf is 1.5 m and the two of them
   * take 0.31 s to part — which is why `Sfx.doorSlide` is pitched off the
   * opening's size rather than being one sound for every door in the yard. */
  const door = b.hatch('dock_dray_hatch', {
    lx: side * (H.lower.hw - SKIN / 2), ly: H.deck.y + H.hatch.h / 2, lz: H.hatch.lz,
    w: H.hatch.w, h: H.hatch.h, plane: 'x', standY: H.deck.y,
    faceOff: SKIN / 2 + 0.075,
    mat: mats.accent,
  });

  return {
    door, engineDoor, lift, ramp, rooms: H.rooms,
    lights: [
      /* `floorY` per fitting, because a compartment's lamp is measured against
       * ITS OWN floor and the Dray's are not on one level: the cockpit sits
       * 1.30 m above the hold, so against the hold's floor its 14 cd reads 1.33
       * and against its own it reads 3.72. The first number is arithmetic about
       * the wrong room. */
      { x: 0, y: hold.ceilY - 0.16, z: -1.5, intensity: 58, distance: 14, floorY: hold.floorY },
      { x: 0, y: engine.ceilY - 0.16, z: -8.5, intensity: 18, distance: 9, floorY: engine.floorY },
      { x: 0, y: cockpit.ceilY - 0.16, z: 4.8, intensity: 16, distance: 9, floorY: cockpit.floorY },
      ...wash,
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Pike — interceptor, berth B3                                        */
/* ------------------------------------------------------------------ */

export function buildPike(b, side, keelY, mats) {
  const H = PIKE;
  const entry = H.rooms[0], cockpit = H.rooms[1], gunbay = H.rooms[2];

  /**
   * THE AUTHORED SKIN, OR NULL — AND ON THIS HULL IT IS THE WHOLE BRIEF.
   *
   * The Pike is the ship a player buys to FIGHT in, so it has one job the
   * other three do not: read as fast and hostile at a kilometre, where all
   * that survives is the outline. Built out of `ShipKit`'s boxes it could not
   * — the widest thing on it was a rectangular sponson, the canopy was a
   * 0.16 m glass plate lying flush in a deck, and the whole forebody was a
   * 4.5 m wide plated section with a six-facet cone on the front of it.
   *
   * `scripts/make-ship-glb.mjs` (`SHIP_GLB_HULL=pike`) bakes the replacement:
   * one swept skin whose widest line is a knife-edge chine 13 m long, a crown
   * that collapses from 2.28 to 0.09 over the forebody so the nose is a blade
   * standing on a strake, a dorsal that gains its 1.84 m by RAKING FORWARD
   * over the cockpit instead of standing on the deck as a house, a wing with a
   * real aerofoil under its mantle-flat top, and engines and cannon that are
   * tubes with holes down them. `src/ships/ShipAssets.js` loads it and hands
   * the parts here keyed to this yard's own cached materials, so nothing new
   * is compiled.
   *
   * `null` is not an error — a missing file, a failed fetch, or a headless
   * test with no `fetch` at all — and then this function builds exactly the
   * hull it built before. Both arms are pinned by `pike-assets.test.mjs`.
   */
  const skin = shipParts('pike', { mirrorX: side < 0 });

  /* ── Hull ──────────────────────────────────────────────────────────────
   *
   * Muted when there is an authored skin: every collider, every aperture and
   * every room below is registered exactly as it always was, and only the
   * DRAWING is suppressed. See `ShipBuild.mute`. */
  b.mute(!!skin);
  keel(b, H, { tile: 2.6 });
  flankAperture(b, H.lower, side, H.hatch, H.deck.y);
  plated(b, H.upper, 'hull', { capFore: false });
  // Sealed volumes: the tail cone, the dorsal fairing, and the space over the
  // gun bay's deckhead. None of them is a room; all of them would read as one.
  fill(b, H.lower.hw - SKIN, H.lower.y0, H.ledge.y, H.lower.z0 + SKIN, H.deck.z0);
  fill(b, H.upper.hw - SKIN, H.upper.y0, H.upper.y1, H.upper.z0, H.upper.z1);

  b.course('trim', H.lower.hw, H.lower.z0, H.lower.z1, H.ledge.y - 0.26);
  b.course('trim', H.upper.hw, H.upper.z0, H.upper.z1, H.upper.y1 - 0.24);
  for (const s of [-1, 1]) {
    b.bolts('trim', s * (H.lower.hw + 0.05), H.ledge.y - 0.26, H.lower.z0 + 0.6, H.lower.z1 - 0.6, 15);
  }
  for (let i = 0; i < 6; i++) {
    b.rib('trim', H.lower.hw, H.lower.y0, H.ledge.y - 0.36, H.lower.z0 + 1.0 + i * 1.9);
  }

  /* ── The bubble, the fairing and the nose ─────────────────────────────
   * The glazed roof sits at the ledge's own level with its underside on the
   * cockpit's declared ceiling, so the pilot is under glass and not under a
   * deck plate with glass drawn on top of it. */
  const C = H.canopy;
  b.cbox('glass', C.hw * 2, C.y - H.rooms[1].ceilY, C.z1 - C.z0,
    0, (C.y + H.rooms[1].ceilY) / 2, (C.z0 + C.z1) / 2, 0, 2);
  for (const s of [-1, 1]) {
    b.cbox('trim', 0.14, 0.16, C.z1 - C.z0, s * (C.hw - 0.07), C.y - 0.08, (C.z0 + C.z1) / 2, 0, 1);
  }
  b.box('trim', C.hw * 2, 0.1, 0.12, 0, C.y - 0.05, (C.z0 + C.z1) / 2, 0, 1);
  // The fairing over the gun bay: it stands ON the bay's own deckhead, which
  // is what keeps the bay 1.5 m and crouch-only. Lofted into the nose rather
  // than butted against it, so the dorsal line runs unbroken from the canopy
  // to the tip — which is the whole read of an interceptor.
  const F = H.fairing;
  b.cbox('hull', F.hw * 2, F.y1 - F.y0, F.z1 - F.z0, 0, (F.y0 + F.y1) / 2, (F.z0 + F.z1) / 2, 0, 2.5);
  b.box('trim', 0.7, 0.14, F.z1 - F.z0 - 0.4, 0, F.y1 + 0.05, (F.z0 + F.z1) / 2, 0, 1);

  /* ── The nose ─────────────────────────────────────────────────────────
   * A four-metre lofted spike with a hard chine, and the section is DEEPER
   * than it is wide from z 8 forward: the Kestrel's nose is round-shouldered
   * and this one is a blade, which is most of what separates the two hulls in
   * a head-on silhouette. */
  const NS = H.nose;
  const noseSt = [
    { z: NS.z0, pts: sec(2.25, NS.y0, 2.70, { ct: 0.55, cb: 0.7, tw: 1.5, bw: 1.35 }) },
    { z: 7.4, pts: sec(1.95, 0.72, 2.56, { ct: 0.62, cb: 0.8, tw: 1.1, bw: 1.0 }) },
    { z: 8.3, pts: sec(1.42, 0.92, 2.38, { ct: 0.6, cb: 0.78, tw: 0.7, bw: 0.62 }) },
    { z: 9.2, pts: sec(0.92, 1.14, 2.16, { ct: 0.48, cb: 0.6, tw: 0.4, bw: 0.36 }) },
    { z: 9.9, pts: sec(0.5, 1.34, 1.94, { ct: 0.3, cb: 0.34, tw: 0.2, bw: 0.18 }) },
    { z: NS.z1, pts: sec(0.13, 1.52, 1.72, { ct: 0.08, cb: 0.08, tw: 0.06, bw: 0.06 }) },
  ];
  /* `collide` follows the DRAWING here, which is the one place on this hull
   * the two arms may not share a collider.
   *
   * The procedural nose is 4.50 m across at its root and still 2.84 m across
   * at z 8.3, and `loftSolid` inscribes boxes in it: five of them, the widest
   * ±1.95. The authored nose is a blade — ±1.42 at z 7.6 falling to ±0.10 at
   * the tip — and a body can walk UNDER it, because its underside lifts from
   * 0.80 to 1.56 over the last four metres and the cradle top is at 0. Keeping
   * the procedural boxes would put a wall half a metre outboard of visible
   * plating at head height on the one part of this hull a player walks beneath.
   * So the authored arm inscribes its own; they are listed by half-extent in
   * `pike-assets.test.mjs` so a sixth cannot appear quietly. */
  loftSolid(b, 'hull', noseSt, { tile: 2.4, capFore: true, collide: !skin });
  if (skin) {
    /* Inscribed in the baked skin, measured off it: [z0, z1, hx, y0, y1]. */
    for (const [z0, z1, hx, y0, y1] of [
      [6.40, 7.60, 1.42, 1.11, 2.36],
      [7.60, 8.80, 0.76, 1.29, 2.16],
      [8.80, 10.50, 0.10, 1.56, 1.76],
    ]) {
      b.solid(0, (y0 + y1) / 2, (z0 + z1) / 2, hx, (y1 - y0) / 2, (z1 - z0) / 2);
    }
  }
  for (const s of [-1, 1]) {
    for (let i = 0; i < noseSt.length - 1; i++) {
      const a = noseSt[i], c = noseSt[i + 1];
      const ax = a.pts[2][0], cxx = c.pts[2][0];
      const ay = (a.pts[2][1] + a.pts[3][1]) / 2, cy = (c.pts[2][1] + c.pts[3][1]) / 2;
      b.rbox('accent', 0.07, 0.1, Math.hypot(cxx - ax, cy - ay, c.z - a.z),
        s * (ax + cxx) / 2, (ay + cy) / 2, (a.z + c.z) / 2,
        Math.atan2(s * (cxx - ax), c.z - a.z), -Math.atan2(cy - ay, c.z - a.z), 0, 1);
    }
  }
  b.box('glow', 0.2, 0.07, 0.16, 0, 1.62, NS.z1 - 0.08, 0, 1);

  /* ── The cannon ───────────────────────────────────────────────────────
   * Two barrels running six metres forward out of the gun-bay fairing, past
   * the nose tip. Guns are what this hull is FOR and nothing on the old one
   * said so from outside: the barrels were 3.2 m stubs buried at z 9. */
  const GN = H.cannon;
  for (const s of [-1, 1]) {
    b.put('dark', new THREE.CylinderGeometry(GN.r * 1.7, GN.r * 1.9, 1.5, 8).rotateX(Math.PI / 2),
      s * GN.x, GN.y, GN.z0 + 0.6);
    b.put('accent', new THREE.CylinderGeometry(GN.r, GN.r * 1.25, GN.z1 - GN.z0 - 1.0, 8).rotateX(Math.PI / 2),
      s * GN.x, GN.y, (GN.z0 + GN.z1) / 2 + 0.5);
    for (let i = 0; i < 3; i++) {
      b.put('trim', new THREE.CylinderGeometry(GN.r * 1.5, GN.r * 1.5, 0.18, 8).rotateX(Math.PI / 2),
        s * GN.x, GN.y, GN.z0 + 2.2 + i * 2.4);
    }
    b.box('glow', 0.1, 0.1, 0.12, s * GN.x, GN.y, GN.z1 - 0.06, 0, 1);
    b.solid(s * GN.x, GN.y, (GN.z0 + GN.z1) / 2, GN.r * 1.4, GN.r * 1.4, (GN.z1 - GN.z0) / 2);
  }

  /* ── The wings — a diamond planform, flat over and knife under ────────
   * See `PIKE.wing` for why the tip is at z 0.2 and why every millimetre of
   * the taper is on the underside. Drawn as a loft about the SPAN and
   * collided as three boxes across it, the outermost of which carries the
   * face `bands[0]` grips. */
  const W = H.wing;
  const ww = W.x1 - W.x0, wcx = (W.x0 + W.x1) / 2, wcz = (W.z0 + W.z1) / 2;
  for (const s of [-1, 1]) {
    const panel = [];
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      const lead = W.leadRoot + (W.leadTip - W.leadRoot) * t;
      const trail = W.trailRoot + (W.trailTip - W.trailRoot) * t;
      const yb = W.botRoot + (W.botTip - W.botRoot) * t;
      const u = (f) => -s * (lead + (trail - lead) * f);
      const p = [
        [u(0), (yb + W.y1) / 2],     // the leading edge, a wedge under the flat
        [u(0.22), yb],
        [u(1), W.y1 - 0.09],         // and a thin trailing edge
        [u(1), W.y1],
        [u(0.22), W.y1],
        [u(0), W.y1],
      ];
      panel.push({ z: t * ww, pts: s > 0 ? p : p.slice().reverse() });
    }
    b.put('accent', loftGeo(panel, { tile: 2.2, capFore: true, capAft: true }),
      s * W.x0, 0, 0, s * Math.PI / 2);
    /* Three collider boxes across the span. The mantle probe fires down from
     * 0.14 m inboard of the face it grabbed and lands 0.77 m in, so the box
     * carrying x 5.60 has to reach at least to 4.83 and be flat on top. */
    for (let i = 0; i < 3; i++) {
      const t0 = i / 3, t1 = (i + 1) / 3;
      const lead = W.leadRoot + (W.leadTip - W.leadRoot) * t1;
      const trail = W.trailRoot + (W.trailTip - W.trailRoot) * t0;
      const yb = W.botRoot + (W.botTip - W.botRoot) * t1;
      b.solid(s * (W.x0 + ww * (t0 + t1) / 2), (yb + W.y1) / 2, (lead + trail) / 2,
        (ww * (t1 - t0)) / 2, (W.y1 - yb) / 2, (lead - trail) / 2);
    }
    /* The outrigger strut, and it is structural in both senses.
     *
     * `Climb._probe` looks for a wall at 0.45, 0.95 and 1.45 m above the feet
     * before it will consider a mantle. The wing's own face starts at 1.86,
     * which is above all three — so a wing hanging in the air off a pylon is a
     * ledge with no wall under it and the mantle is refused outright. The strut
     * carries the face down to 0.54, which is what a wing that heavy would
     * need anyway. */
    b.cbox('accent', 0.40, W.y0 - H.lower.y0, 2.4, s * (W.x1 - 0.2), (H.lower.y0 + W.y0) / 2, wcz, 0, 1);
    /* The ordnance rack under the wing is INBOARD of x 4.6, and the reason is
     * a walk: the berth stair lands on the cradle top at local (5.90, 0.95)
     * and the boarding ramp foot is at (4.74, -3.9), so a body crosses under
     * this wing at x 5.2-5.9 with 0.20 m of clearance over its head. Anything
     * hung below the wing on that line is geometry the player walks through,
     * which is the same defect as geometry they cannot walk through, seen from
     * the other side. */
    b.box('dark', 2.0, 0.36, 2.6, s * 3.5, W.y0 - 0.2, wcz, 0, 1);
    for (let i = 0; i < 3; i++) {
      b.put('trim', new THREE.CylinderGeometry(0.12, 0.12, 1.4, 8).rotateX(Math.PI / 2),
        s * 3.5, W.y0 - 0.42, -1.1 + i * 1.1);
    }
    b.box('glow', 0.3, 0.06, 0.06, s * (W.x1 - 0.2), W.y1 + 0.06, 0.5, 0, 1);

    /* The ventral fins, and they hang BELOW the wingtip on purpose: a winglet
     * standing on the tip is rule 3's guard rail — `Climb._probe` fires down
     * from 0.14 m inside the face it grabbed, lands on the winglet instead of
     * the wing, and the first move of this hull's climb stops working. Under
     * the wing it is free. */
    const V = H.ventral;
    b.rbox('accent', 0.14, V.y1 - V.y0, V.z1 - V.z0, s * V.x, (V.y0 + V.y1) / 2, (V.z0 + V.z1) / 2,
      0, 0, s * V.cant, 1);
    b.solid(s * (V.x + 0.2), (V.y0 + V.y1) / 2, (V.z0 + V.z1) / 2, 0.24, (V.y1 - V.y0) / 2, (V.z1 - V.z0) / 2);
  }

  /* ── Fin and thrusters ────────────────────────────────────────────────
   * A swept, tapered fin — lofted about its own span, collided as one upright
   * plate. Nothing mantles onto a fin 0.44 m thick, so an inscribed box is
   * the honest approximation. */
  const FN = H.fin;
  const finSt = [];
  for (let i = 0; i <= 3; i++) {
    const t = i / 3;
    const za = FN.z0 + (FN.tipZ0 - FN.z0) * t;
    const zb = FN.z1 + (FN.tipZ1 - FN.z1) * t;
    const th = FN.hw * (1 - 0.62 * t);
    /* Placed with `rx = -PI/2`, which sends the loft's own +Z to world +Y and
     * its +X to world -Z. So a station's polygon is (thickness, -chord): a
     * fin lofted about its SPAN, which is the only way a swept taper and a
     * thinning section come out of one primitive. */
    finSt.push({
      z: FN.y0 + (FN.y1 - FN.y0) * t,
      pts: [[0, -za], [-th, -(za + zb) / 2], [0, -zb], [th, -(za + zb) / 2]],
    });
  }
  b.put('accent', loftGeo(finSt, { tile: 1.8, capFore: true }), 0, 0, 0, 0, -Math.PI / 2);
  b.solid(0, (FN.y0 + FN.y1) / 2, (FN.z0 + FN.z1 + FN.tipZ0 + FN.tipZ1) / 4,
    FN.hw, (FN.y1 - FN.y0) / 2, (FN.z1 - FN.z0) / 2 - 0.3);
  b.box('glow', FN.hw * 2 + 0.02, 0.08, 1.4, 0, FN.y1 - 0.3, (FN.tipZ0 + FN.tipZ1) / 2, 0, 1);
  b.cbox('dark', 3.4, 1.6, 0.9, 0, 1.5, H.z0 + 0.4, 0, 2);
  for (const s of [-1, 1]) {
    bell(b, s * 1.05, 1.5, H.z0 - 0.28, 0.62, 0.86, 1.2, { seg: 10, solid: false });
  }

  /* ── The shell ends here ─────────────────────────────────────────────
   * Everything below is drawn on BOTH arms, and the mute comes off. */
  b.mute(false);

  /* ── Relief and gear ──────────────────────────────────────────────────
   *
   * `panelLines` and `relief` lay boxes on a flank at exactly `hw`, which is
   * what a flat plated flank is and what an authored one is not: this skin's
   * widest line is a chine at y 1.90 and its deck edge tucks to 2.28, so a
   * patch pinned to 2.35 would float 7 cm off its own hull at the top of every
   * station and 1.2 m off it at the sole. Surface interest on that arm comes
   * from the shape, from the frame rings and the chine strake the generator
   * builds out of the section functions themselves, and from the plating map
   * the .glb's uvs address. */
  if (!skin) {
    panelLines(b, { hw: H.lower.hw, y0: H.lower.y0, y1: H.ledge.y, z0: H.lower.z0, z1: H.lower.z1, pitchZ: 1.2, pitchY: 0.58 });
    panelLines(b, { hw: H.upper.hw, y0: H.upper.y0, y1: H.upper.y1, z0: H.upper.z0, z1: H.upper.z1, pitchZ: 1.0, pitchY: 0.62, key: 'accent' });
    relief(b, { hw: H.lower.hw, y0: H.lower.y0 + 0.3, y1: H.ledge.y - 0.5, z0: H.lower.z0 + 0.6, z1: H.lower.z1 - 0.6, n: 120, seed: 67 });
    relief(b, { hw: H.upper.hw, y0: H.upper.y0 + 0.3, y1: H.upper.y1 - 0.4, z0: H.upper.z0 + 0.4, z1: H.upper.z1 - 0.4, n: 36, seed: 71, key: 'accent' });
  }
  deckDetail(b, { hw: H.ledge.outer - 0.5, y: H.ledge.y, z0: H.ledge.z0 + 0.8, z1: H.ledge.z1 - 0.5, n: 30, seed: 73 });
  deckDetail(b, { hw: H.wing.x1 - 0.5, y: H.wing.y1, z0: H.wing.z0 + 0.6, z1: H.wing.z1 - 0.6, n: 24, seed: 79, key: 'accent' });
  gear(b, { hw: H.lower.hw, y0: -0.34, y1: H.lower.y0 + 0.1, stations: [[-1.6, -4.6], [1.6, -4.6], [0, 3.6]] });
  /* Forward, on the flank under the gun fairing. At z -5.2 it spanned
   * -6.40..-4.00 against an aperture of -4.90..-2.90, so its forward end lay
   * over the door. Aft is no good either — the plating stops at -6.50 — and
   * amidships is inside the wing, whose root is at local x 2.20 from y 1.95.
   * z 4.6 spans 3.40..5.80 at y 1.40..2.40, which is under the fairing
   * (hw 1.60, from y 2.20) and clear of everything. */
  berthStencil(b, 2.4, 1.0, YARD_SIGN.berthB3, H.lower.hw, 1.9, 4.6);

  /* The authored skin, placed in the hull's own frame — which is the frame it
   * was generated in, so there is no transform and nothing to get wrong. Each
   * part rides the yard's cached material of its own name; see `ShipAssets`. */
  if (skin) {
    for (const p of skin) b.put(p.key, p.geometry, 0, 0, 0);
    /* THE BLISTER NEEDS THE COLLIDER THE FLAT CANOPY NEVER DID.
     *
     * `PIKE.canopy` is a 0.16 m glass plate lying in the weather deck, so on
     * the procedural arm there is nothing above y 2.76 between z 0.4 and 3.4
     * and nothing needs to be. The authored canopy stands 1.58 m over that
     * deck at its back — and a body CAN be up there: it mantles the wing at
     * 2.36, steps up 0.40 m to the deck (inside `stepHeight`) and walks
     * forward. Drawn and not collided is rule 4, and here it would also be a
     * canopy you walk through into the cockpit.
     *
     * Two boxes rather than one, and INSCRIBED, because the rake falls 1.54 m
     * over its length: a single box cut to the tall end would stand 0.7 m
     * proud of the glass at the windscreen. Measured off the baked mesh. */
    for (const [z0, z1, hx, y1] of [[0.60, 1.90, 1.25, 3.60], [1.90, 3.20, 1.19, 2.90]]) {
      b.solid(0, (2.70 + y1) / 2, (z0 + z1) / 2, hx, (y1 - 2.70) / 2, (z1 - z0) / 2);
    }
  }

  /* The two walkable plates, drawn on both arms. Each one's TOP is a ledge the
   * climb uses and its UNDERSIDE is a compartment's ceiling — rule 2 — and the
   * authored skin closes exactly beneath each of them rather than trying to be
   * them: a surface with no thickness cannot be a deck you stand on and a
   * room's deckhead at the same time. */
  deckSlab(b, 'hull', H.ledge.y, H.ledge.outer, H.ledge.z0, H.ledge.z1);
  deckSlab(b, 'deckg', H.spine.y, H.spine.hw, H.spine.z0, H.spine.z1);
  edgeStripe(b, H.ledge.outer, H.ledge.y, H.ledge.z0 + 0.4, H.ledge.z1 - 0.4);
  // A hazard stripe, not a rail: see rule 3. This is a wing you stand on, and
  // the mantle target is marked on whichever arm drew the wing under it.
  for (const s of [-1, 1]) {
    b.box('hazard', (H.wing.x1 - H.wing.x0) - 0.9, 0.04, 0.4,
      s * (H.wing.x0 + H.wing.x1) / 2, H.wing.y1 + 0.03, (H.wing.z0 + H.wing.z1) / 2, 0, 1);
  }

  /* ── Interior: a narrow trunk inside a wide hull ──────────────────── */
  const tankOuter = H.lower.hw - SKIN;
  deckSlab(b, 'deckg', H.deck.y, tankOuter, H.deck.z0, H.deck.z1);
  // Everything outboard of the trunk forward of the entry bay is structure,
  // not space: filled rather than left as a walkable strip nothing reaches.
  for (const sg of [-1, 1]) {
    b.solid(sg * (H.trunk.hw + (tankOuter - H.trunk.hw) / 2), (H.deck.y + H.ledge.y) / 2,
      (0.4 + H.deck.z1) / 2, (tankOuter - H.trunk.hw) / 2, (H.ledge.y - H.deck.y) / 2,
      (H.deck.z1 - 0.4) / 2);
  }
  for (const s of [-1, 1]) {
    if (s === side) {
      b.wallZ('trim', s * (H.trunk.hw - H.trunk.t / 2), H.deck.z0, H.deck.z1, H.deck.y, H.ledge.y - DECK_T,
        H.hatch.lz - H.hatch.w / 2, H.hatch.lz + H.hatch.w / 2, H.hatch.h, H.trunk.t);
    } else {
      b.cbox('trim', H.trunk.t, H.ledge.y - DECK_T - H.deck.y, H.deck.z1 - H.deck.z0,
        s * (H.trunk.hw - H.trunk.t / 2), (H.deck.y + H.ledge.y - DECK_T) / 2,
        (H.deck.z0 + H.deck.z1) / 2, 0, 2);
    }
  }
  // The gun bay is narrower again: its own walls inside the trunk.
  for (const s of [-1, 1]) {
    b.cbox('trim', 0.1, gunbay.ceilY - H.deck.y, gunbay.z1 - gunbay.z0,
      s * (gunbay.hw + 0.05), (H.deck.y + gunbay.ceilY) / 2, (gunbay.z0 + gunbay.z1) / 2, 0, 2);
  }
  deckhead(b, 'trim', gunbay, 0.02);
  // The crouch hole through the forward bulkhead. 1.35 m to the lintel against
  // a 1.015 m crouch capsule and a 1.75 m standing one: it is a crawl by
  // construction, and it is a crawl you can come back out of.
  b.wallX('trim', H.crouchHatch.z, -H.trunk.hw, H.trunk.hw, H.deck.y, cockpit.ceilY,
    -H.crouchHatch.hw, H.crouchHatch.hw, H.crouchHatch.h, 0.12);
  b.ibox('hazard', H.crouchHatch.hw * 2 + 0.3, 0.05, 0.1, 0, H.deck.y + 0.04, H.crouchHatch.z, 0, 1);
  b.ibox('glow', H.crouchHatch.hw * 2, 0.04, 0.04, 0, H.deck.y + H.crouchHatch.h - 0.05, H.crouchHatch.z, 0, 1);
  // Caps at both ends of the trunk, so the cockpit is a room and not a corridor.
  for (const z of [H.deck.z0, H.deck.z1]) {
    b.cbox('trim', H.trunk.hw * 2, H.ledge.y - DECK_T - H.deck.y, 0.12,
      0, (H.deck.y + H.ledge.y - DECK_T) / 2, z, 0, 2);
  }
  // Systems space outboard of the trunk: racks, drawn only under a solid deck.
  for (const s of [-1, 1]) {
    for (let i = 0; i < 5; i++) {
      const rz = H.deck.z0 + 0.9 + i * 1.2;
      /* Not across the boarding hatch. The first rack of the boarding flank
       * stood at z -4.35..-3.85 against a hatch at -4.4..-3.4, and 64 of 154
       * lattice samples through the aperture (41.6%) hit `ship-pike-in:dark`
       * 0.24 m inboard. There is no collider between local x -0.2 and 2.6 at
       * head height, so the player boarded by walking through the cabinet.
       * The threshold is the rack's own 0.25 m half-depth plus the hatch's
       * 0.5 m half-width plus 0.15 m of jamb: anything nearer is in the way. */
      if (s === side && Math.abs(rz - H.hatch.lz) < H.hatch.w / 2 + 0.40) continue;
      b.ibox('dark', 0.55, 1.2, 0.5, s * (H.trunk.hw + 0.45), H.deck.y + 0.6, rz, 0, 1);
    }
  }

  deckLights(b, entry, 3, { w: 0.5 });
  deckLights(b, cockpit, 2, { w: 0.5 });
  deckLights(b, gunbay, 3, { w: 0.4 });
  innerRibs(b, entry, 3, 'dark',
    { cut: { side, z0: H.hatch.lz - H.hatch.w / 2, z1: H.hatch.lz + H.hatch.w / 2 } });
  innerRibs(b, cockpit, 3);
  const wash = [
    ...wallWash(b, entry, side, { n: 2, intensity: 11, distance: 7 }),
    ...wallWash(b, cockpit, side, { n: 1, intensity: 6, distance: 6 }),
    /* The gun bay's clear height is 1.50 m by declaration - it is the crouch
     * space - so its washers sit at 0.95, which is eye height on the 1.015 m
     * crouch capsule and not on the 1.75 m standing one. */
    ...wallWash(b, gunbay, side, { n: 1, intensity: 5, distance: 5, y: 0.95 }),
  ];

  // The entry bay: a suit locker, a tool rack and a fold-down seat, because a
  // vestibule with nothing in it reads as a corridor the builder ran out of.
  b.ibox('crate', 0.7, 1.5, 0.8, -0.5, H.deck.y + 0.75, -4.0, 0, 1);
  b.ibox('trim', 0.06, 0.7, 0.75, -0.13, H.deck.y + 0.95, -4.0, 0, 1);
  b.ibox('dark', 0.4, 0.9, 1.8, 0.85, H.deck.y + 0.45, -2.2, 0, 1);
  b.ibox('crate', 0.9, 0.1, 0.5, -0.65, H.deck.y + 0.5, -1.4, 0, 1);
  b.spot(-0.5, H.deck.y + 1.55, -4.0, 'common');

  // Cockpit: one seat, a stick, a wraparound console.
  b.ibox('dark', 0.6, 0.14, 0.66, 0, H.deck.y + 0.42, 1.4, 0, 1);
  b.ibox('crate', 0.58, 0.8, 0.16, 0, H.deck.y + 0.82, 1.06, 0, 1);
  b.ibox('trim', 0.1, 0.34, 0.1, 0, H.deck.y + 0.62, 1.9, 0, 1);
  /* TWO consoles with a lane between them, and it used to be one 2.1 m slab.
   *
   * The gun bay's only way in is the crouch hole in this bulkhead at z 3.25,
   * and the slab ran x -1.05..1.05 at y 1.43..1.57, hard against it at z 3.20.
   * A crouch capsule is 1.015 m tall standing on a sole at 0.70, so it occupies
   * 0.70..1.72 — the console was inside it, across the full width of a 1.0 m
   * hole. Drawn and not collided, so the player crawled through the
   * instruments: 9 of 81 aperture samples, the entire middle row.
   *
   * A 1.1 m lane down the centre is what a cockpit with a crawl-through behind
   * it actually looks like, and it costs nothing — the panels are wider in
   * total than the slab was. */
  for (const s of [-1, 1]) {
    b.ibox('trim', 0.58, 0.14, 0.6, s * 0.87, H.deck.y + 0.8, 2.9, 0, 1);
    b.ibox('glow', 0.46, 0.04, 0.28, s * 0.87, H.deck.y + 0.9, 2.88, 0, 1);
  }
  b.spot(-0.87, H.deck.y + 1.0, 2.9, 'prize');
  // Gun bay: an ammunition run, a breech, a crawl mat. Everything low.
  /* Everything in here hugs ONE side. A 0.5 m ammunition run across the full
   * 1.6 m of a 1.5 m compartment covers 88% of its plan, and because it is
   * drawn and not collided that is 88% of a room the player crawls straight
   * through — the same defect as geometry they cannot walk through, seen from
   * the other side. The lane down the port side is 0.7 m clear. */
  /* Forward of the crawl hole, not behind it — and the SAME LENGTH as before.
   *
   * At z 3.80..6.00 the run's aft end stood 0.55 m past a 1.0 m hole. The hole
   * is only 1.0 m wide, so a 0.35 m capsule can only be between x -0.15 and
   * +0.15 while it is in the opening, and the run occupies x 0.11..0.73: the
   * crawler met it before they were through. It runs 4.20..6.30 now, which
   * leaves 0.95 m of bay to slide across into the 0.91 m port lane the comment
   * below is about.
   *
   * The DEPTH is 2.1 and not 1.8, and that is a measurement too. `fitGunbay`
   * stands shells in bays down this run at a 0.22 m pitch and takes 0.18 m off
   * each end, so shortening it by 0.4 m cost two bays — the compartment
   * dropped to 28 'accent' triangles against a floor of 65 and 72 'lit'
   * against 85, and `dock-interiors` correctly called the gun bay underfitted.
   * Moving a mass without keeping its size is how a fit-out quietly empties. */
  b.ibox('crate', 0.62, 0.5, 2.1, 0.42, H.deck.y + 0.25, 5.25, 0, 1);
  b.ibox('dark', 0.6, 0.5, 1.1, 0.42, H.deck.y + 0.8, 5.7, 0, 1);
  b.ibox('glow', 0.4, 0.04, 0.4, 0.42, H.deck.y + 1.06, 5.7, 0, 1);
  b.ibox('tarp', 0.7, 0.05, 1.4, -0.4, H.deck.y + 0.04, 4.2, 0, 1);
  b.spot(0.42, H.deck.y + 0.6, 4.9, 'rare');

  /* ── The way in ───────────────────────────────────────────────────── */
  const ramp = boardingRamp(b, H, side, keelY);
  const door = b.hatch('dock_pike_hatch', {
    lx: side * (H.lower.hw - SKIN / 2), ly: H.deck.y + H.hatch.h / 2, lz: H.hatch.lz,
    w: H.hatch.w, h: H.hatch.h, plane: 'x', standY: H.deck.y,
    faceOff: SKIN / 2 + 0.075,
    mat: mats.trim,
  });

  /* ── The yard's dorsal access scaffold ──────────────────────────────
   *
   * THE YARD'S, and that word is now load-bearing. Every member of this thing
   * is measured from `-keelY`, the shed floor: on the flown hull `keelY` is 0,
   * so a railed flight, a deck, four pairs of stanchions and two stringers
   * were built hanging off the Pike's belly and flown to Cinder. It was
   * photographed there. `ShipBuild.yard` gates it for the same reason it gates
   * the berth stencil and the brow. */
  if (b.yard) {
    const S = H.scaffold;
    const headY = -keelY + S.rise;
    b.flight('z', S.lx, -keelY, S.footZ, S.run, S.rise, S.width, S.risers);
    /* ONE deck from the flight head across to the spine, not a platform and a
     * bridge that overlap: two decks at the same height whose edges cross are two
     * decks whose rails cross too, and the rail across the arrival is a stair
     * that ends at a fence. */
    b.cbox('deckg', S.deckX1 - S.deckX0, 0.12, S.deckZ1 - S.deckZ0,
      (S.deckX0 + S.deckX1) / 2, headY - 0.06, (S.deckZ0 + S.deckZ1) / 2, 0, 1.4);
    /* The scaffold IS railed and the hull it serves is not: this is yard
     * structure over a five-metre drop, and nothing mantles onto it. The rails
     * guard only the narrow run between the spine and the flight head — the
     * flank the ramp arrives on is left open, because that is the way in. */
    for (const s of [-1, 1]) {
      b.rail('trim', 'glow', 'x', S.deckX0, S.lx - S.width / 2 - 0.05,
        s > 0 ? S.deckZ1 - 0.06 : S.deckZ0 + 0.06, headY);
    }
    b.rail('trim', 'glow', 'z', S.deckZ0 + 0.1, S.deckZ1 - 0.1, S.deckX1 - 0.06, headY);
    for (let i = 1; i <= 4; i++) {
      const t = i / 5;
      const lz = S.footZ + S.run * t;
      const ly = -keelY + S.rise * t;
      for (const s of [-1, 1]) {
        b.box('dark', 0.12, ly + keelY, 0.12, S.lx + s * (S.width / 2 + 0.05), (-keelY + ly) / 2, lz, 0, 1);
      }
      b.box('dark', S.width + 0.3, 0.1, 0.1, S.lx, ly - 0.4, lz, 0, 1);
    }
    const pitch = Math.atan2(S.rise, S.run);
    for (const s of [-1, 1]) {
      /* The stringer under the boarding flight, pitched to follow it. Was a
       * tenth argument to `box`, so the pitch landed in `tile` and the member
       * lay flat with uvs scaled by -0.28. */
      b.rbox('trim', 0.08, 0.08, Math.hypot(S.run, S.rise), S.lx + s * (S.width / 2 + 0.06),
        -keelY + S.rise / 2 + 1.0, S.footZ + S.run / 2, 0, -pitch, 0, 1);
    }
  }

  return {
    door, ramp, rooms: H.rooms,
    /* Two practicals for three compartments: the entry bay and the cockpit are
     * one 8 m trunk with a frame between them, and a second source 3 m from the
     * first would be two lamps lighting the same floor. Every authored point
     * light in this world is a `LightRig` source and the rig keeps twelve. */
    lights: [
      { x: 0, y: cockpit.ceilY - 0.16, z: -0.6, intensity: 32, distance: 11, floorY: cockpit.floorY },
      { x: 0, y: gunbay.ceilY - 0.16, z: 4.8, intensity: 14, distance: 7, floorY: gunbay.floorY },
      ...wash,
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Bastion — frigate hulk, berth B4                                    */
/* ------------------------------------------------------------------ */

/**
 * Dressing, climbable, and no interior at all — but a doorless descriptor, so
 * she still streams collectibles (`medieval/Treasures.js:556-566`).
 *
 * Her open frames are the only part of this yard the player walks THROUGH
 * rather than into, and the stern section stands on the shed floor rather than
 * on the cradle because that is what an unfitted section does: it waits.
 */
export function buildBastion(b, keelY, mats) {
  const H = BASTION;

  /* ── The authored skin ────────────────────────────────────────────────
   *
   * `buildKestrel`'s header records why the hulls' geometry came off the box
   * primitive at all. The Bastion is the strongest case for it in this yard,
   * and for a reason particular to her: a wreck's whole subject is the
   * STRUCTURE behind the plating, and a frame built out of `cbox` is a
   * goalpost. Two stanchions and a head beam say "scaffolding"; a rib bent to
   * the shape of a section says "this was a ship". The generator can bend one,
   * because it generates the rib from the same curves it generates the hull
   * from — see `scripts/make-ship-glb.mjs`, run with `SHIP_GLB_HULL=bastion`.
   *
   * `null` is not an error: it is the file missing, the fetch failing, or a
   * headless test with no `fetch`, and then this function builds exactly the
   * hull it built before, stripped bays and all. Both arms are pinned by
   * `scripts/tests/bastion-asset.test.mjs`.
   *
   * No mirror. She has no boarding aperture and no ramp, so unlike the Kestrel
   * there is no handed feature to flip, and both flanks are the same flank.
   *
   * Muted from here: every collider, every `fill` and every `solid` below is
   * registered exactly as it always was, and only the DRAWING is suppressed.
   * `b.mute(false)` comes on for each run that is drawn on BOTH arms — the
   * walkable plates, the barbettes, the berth signs and the yard's own litter
   * — and back off afterwards. */
  const skin = shipParts('bastion');
  b.mute(!!skin);

  keel(b, H, { tile: 3.6 });
  /* Capped at BOTH ends and filled solid. She has no interior — that is the
   * whole point of her — and an uncapped plated section is a 26 m room with a
   * floor, a ceiling and two metres of headroom that a walk probe is right to
   * call standable and a player can never get to. */
  /* ── The flanks, with two bays stripped back to frame ──────────────────
   * `plated` cannot help here: it draws a continuous shell, and what makes
   * this hull read as a WRECK rather than as the biggest of four drums is
   * plating that ISN'T there. So the lower flanks are laid out by hand, in
   * runs, and the runs `BASTION.stripped` names are drawn only above and below
   * the hole.
   *
   * The collider is NOT removed with the plating. `fill` already blocks the
   * whole section 0.22 m inboard, so a body meets the inner skin instead of
   * the outer one and the hull's outline stays solid — which is the honest
   * answer for a hole you can see into and there is nothing behind. */
  for (const sg of [-1, 1]) {
    const fx = sg * (H.lower.hw - SKIN / 2);
    const cuts = H.stripped;
    for (const [za, zb] of intactRuns(H.lower.z0, H.lower.z1, cuts)) {
      if (zb - za < 0.05) continue;
      b.cbox('hull', SKIN, H.ledge.y - H.lower.y0, zb - za, fx, (H.lower.y0 + H.ledge.y) / 2, (za + zb) / 2, 0, 2.5);
    }
    for (const c of cuts) {
      // Sill under the hole and the plating over it — a bay opened, not a hull
      // cut in half.
      b.cbox('hull', SKIN, c.y0 - H.lower.y0, c.z1 - c.z0, fx, (H.lower.y0 + c.y0) / 2, (c.z0 + c.z1) / 2, 0, 2.5);
      b.cbox('hull', SKIN, H.ledge.y - c.y1, c.z1 - c.z0, fx, (c.y1 + H.ledge.y) / 2, (c.z0 + c.z1) / 2, 0, 2.5);
      /* The frames standing in the gap, and an inner skin 0.7 m behind them so
       * the bay reads as a DEPTH rather than as a black rectangle: a hole with
       * nothing drawn inside it is a hole onto backface-culled plating, which
       * from the apron is a matt black hole in the silhouette. */
      b.box('dark', 0.1, c.y1 - c.y0, c.z1 - c.z0, sg * (H.lower.hw - 0.7), (c.y0 + c.y1) / 2, (c.z0 + c.z1) / 2, 0, 2);
      /* The frames stand 0.5 m INBOARD of the plating line, not 0.3.
       *
       * That is not styling: `dock-hulls` counts drawn vertices standing in
       * the slab the plating occupies — `hw - SKIN` to `hw` — and calls any of
       * them inside a bay a hole that has been painted back in. Frames at
       * `hw - 0.3` are 0.34 m thick, so they reached 7.87 against a plating
       * band starting at 7.84 and the bay measured as full. Set back, they
       * read as what they are: structure seen THROUGH a gap. */
      const n = Math.max(3, Math.round((c.z1 - c.z0) / 2.3));
      for (let i = 0; i <= n; i++) {
        const fz = c.z0 + ((c.z1 - c.z0) * i) / n;
        b.cbox('trim', 0.34, c.y1 - c.y0, 0.34, sg * (H.lower.hw - 0.5), (c.y0 + c.y1) / 2, fz, 0, 1);
        b.box('trim', 0.5, 0.16, 0.16, sg * (H.lower.hw - 0.55), c.y1 - 0.3, fz, 0, 1);
      }
      for (const gy of [c.y0 + 0.7, c.y1 - 0.8]) {
        b.box('trim', 0.24, 0.24, c.z1 - c.z0, sg * (H.lower.hw - 0.48), gy, (c.z0 + c.z1) / 2, 0, 1);
      }
      /* A torn lip of plating still hanging off the top edge of the hole, and
       * it hangs ABOVE the opening rather than across it. Peeled downward it
       * was the shallowest thing in the bay — 8.57 m out against an inner skin
       * at 7.36 — so it filled in most of the depth that is the whole reason
       * the bay is there. */
      b.rbox('accent', 0.12, 1.1, (c.z1 - c.z0) * 0.3, sg * (H.lower.hw + 0.35), c.y1 + 0.62,
        c.z0 + (c.z1 - c.z0) * 0.28, 0, 0, sg * 0.42, 1.6);
    }
    // Fore and aft caps of the lower section, in the plated runs.
    b.cbox('hull', (H.lower.hw - SKIN) * 2, H.ledge.y - H.lower.y0, SKIN,
      0, (H.lower.y0 + H.ledge.y) / 2, sg > 0 ? H.lower.z1 - SKIN / 2 : H.lower.z0 + SKIN / 2, 0, 2.5);
  }
  plated(b, H.upper);
  fill(b, H.lower.hw - SKIN, H.lower.y0, H.ledge.y, H.lower.z0 + SKIN, H.lower.z1 - SKIN);
  fill(b, H.upper.hw - SKIN, H.upper.y0, H.upper.y1, H.upper.z0 + SKIN, H.upper.z1 - SKIN);
  /* The authored skin, placed in the hull's own frame — which is the frame it
   * was generated in, so there is no transform and nothing to get wrong. Each
   * part rides the yard's cached material of its own name; see `ShipAssets`. */
  b.mute(false);
  if (skin) {
    for (const p of skin) b.put(p.key, p.geometry, 0, 0, 0);
    /* Three things the authored arm draws that the procedural arm does not,
     * and every one of them therefore needs the collider the thing it replaced
     * had. Rule 4: nothing is drawn that a body can walk through.
     *
     * 1. THE STERN SECTION'S FRAMES. The plan collides one 0.4 m post per
     *    frame at ±7.6, and the authored frames are U-ribs whose legs curve:
     *    the foot tucks to 0.79 of a half-beam that itself narrows aft, so at
     *    the after frame the rib stands 2.5 m inboard of the plan's post. This
     *    is the ONE part of her a player walks THROUGH, so each leg gets a box
     *    cut to its own plan; the plan's posts stay collided and undrawn,
     *    which is `fill`'s bargain and not rule 4's failure.
     *
     *    A box per leg and not a post per leg, because the leg SWEEPS: it
     *    travels from `hw * 0.79` at the heel to `hw` at the head and carries
     *    a 0.44 m web inboard of that, so the material at any height lies in
     *    `[hw * 0.79 - 0.44, hw]` and a 0.28 m post cut to one height leaves
     *    the rest of the rib walk-through. Measured against the baked mesh at
     *    y 0.60 the rib is at x 5.95 on the second frame; a post on the old
     *    linear guess sat at 5.26 and the probe walked straight past it. */
    if (skin) {
      const S = H.sternRibs;
      /* `BAS_SHW` sampled at the six frame stations, written down rather than
       * re-derived: a collider that computed its own hull would be testing its
       * own arithmetic. `bastion-asset.test.mjs` fires a ray at every rib and
       * requires a box round where it stops, which is what holds these to the
       * generator's curve. */
      const SHW = [5.100, 6.229, 6.967, 7.364, 7.535, 7.600];
      for (let i = 0; i <= S.frames; i++) {
        const z = S.z0 + ((S.z1 - S.z0) * i) / S.frames;
        const hw = SHW[i] ?? S.hw;
        const cx = hw * 0.895 - 0.22, half = hw * 0.105 + 0.22;
        for (const s of [-1, 1]) {
          b.solid(s * cx, (S.y0 + S.y1 - 1.5) / 2, z, half, (S.y1 - 1.5 - S.y0) / 2, 0.24);
        }
      }
      /* 2. THE PEELED PLATES. Each one is held along the head of a bay and
       *    rolls up and outboard from it: measured off the baked mesh the tip
       *    reaches local x 8.70 and y 4.14, which is 0.70 m outboard of the
       *    flank and 0.14 m over the ledge deck a player walks on. Boxed to
       *    the plate and no further — a collider cut to the generous number
       *    would be an invisible wall along the deck edge. */
      for (const c of H.stripped) {
        const mid = (c.z0 + c.z1) / 2, half = (c.z1 - c.z0) * 0.44;
        for (const s of [-1, 1]) b.solid(s * 8.35, c.y1 + 0.42, mid, 0.42, 0.42, half);
      }
      /* 3. THE BELL'S STAND. The plan collides a base plate 3.2 m across and
       *    two 0.3 m legs; the authored stand is a 4.1 m plinth with two
       *    curved cradle bearers over it, because a stand narrower than the
       *    bell it carries is a stand nobody would build. The bearers get
       *    their LEGS boxed and not their arch: the arch springs at local
       *    y -0.54 and crowns at 0.35, which is 3.9 m over the shed floor and
       *    is the bell's own hole to stand in. */
      const BE0 = H.bell;
      b.solid(BE0.lx, BE0.y0 + 0.225, BE0.lz, 2.05, 0.225, 2.4);
      for (const zo of [-1.5, 1.5]) {
        for (const s of [-1, 1]) b.solid(BE0.lx + s * 2.60, BE0.y0 + 1.06, BE0.lz + zo, 0.25, 0.64, 0.20);
      }
    }
  }
  deckSlab(b, 'hull', H.ledge.y, H.ledge.outer, H.lower.z0, H.lower.z1);
  deckSlab(b, 'deckg', H.spine.y, H.spine.hw, H.spine.z0, H.spine.z1);
  edgeStripe(b, H.ledge.outer, H.ledge.y, H.lower.z0 + 1, H.lower.z1 - 1);
  edgeStripe(b, H.spine.hw, H.spine.y, H.spine.z0 + 1, H.spine.z1 - 1);
  b.mute(!!skin);
  knuckle(b, 'hull', H.lower.hw, H.ledge.y, H.lower.z0, H.lower.z1, 1, 0.6);
  knuckle(b, 'hull', H.lower.hw, H.lower.y0, H.lower.z0, H.lower.z1, -1, 0.7);
  knuckle(b, 'hull', H.upper.hw, H.spine.y, H.upper.z0, H.upper.z1, 1, 0.5);

  /* ── The conning tower and the barbettes ──────────────────────────────
   * The two things that say FRIGATE rather than freighter. She was never
   * armed: the rings are empty, and the one barrel that was delivered is
   * lying on the deck between them where the yard left it. */
  const TW = H.tower;
  loftSolid(b, 'hull', [
    { z: TW.z0, pts: sec(TW.hw - 0.4, TW.y0, TW.y1 - 1.4, { ct: 0.5, cb: 0.3, tw: TW.hw - 1.1 }) },
    { z: TW.z0 + 1.1, pts: sec(TW.hw, TW.y0, TW.y1, { ct: 0.6, cb: 0.3, tw: TW.hw - 1.0 }) },
    { z: TW.z1 - 0.8, pts: sec(TW.hw, TW.y0, TW.y1, { ct: 0.6, cb: 0.3, tw: TW.hw - 1.0 }) },
    { z: TW.z1, pts: sec(TW.hw - 0.8, TW.y0, TW.y1 - 1.9, { ct: 0.4, cb: 0.3, tw: TW.hw - 1.4 }) },
  ], { tile: 3 });
  for (const s of [-1, 1]) {
    // The bridge windows, and every one of them dark. Nothing is lit in here.
    b.box('dark', 0.1, 0.7, TW.z1 - TW.z0 - 1.8, s * (TW.hw + 0.02), TW.y1 - 1.1, (TW.z0 + TW.z1) / 2, 0, 2);
    b.box('trim', 0.14, 0.1, TW.z1 - TW.z0 - 1.6, s * (TW.hw + 0.02), TW.y1 - 0.72, (TW.z0 + TW.z1) / 2, 0, 1);
  }
  /* Drawn on BOTH arms: a signal mast is a thin member, which is the one
   * thing a box kit does honestly, and it is 3.4 m of vertical articulation
   * in a silhouette that needs every centimetre of it. */
  b.mute(false);
  b.cbox('trim', 0.3, 3.4, 0.3, 0, TW.y1 + 1.7, (TW.z0 + TW.z1) / 2, 0, 1);
  b.box('trim', 3.0, 0.14, 0.14, 0, TW.y1 + 2.6, (TW.z0 + TW.z1) / 2, 0, 1);
  /* `glow` and not `danger`, for the draw-call reason the Dray's hopper lights
   * record: `danger` is a key this hull's exterior batch does not otherwise
   * use, and one masthead light is not worth a mesh. */
  b.box('glow', 0.24, 0.24, 0.24, 0, TW.y1 + 3.5, (TW.z0 + TW.z1) / 2, 0, 1);

  const BB = H.barbette;
  for (const bz of BB.zs) {
    b.put('hull', new THREE.CylinderGeometry(BB.r, BB.r + 0.2, BB.h, 12), 0, H.spine.y + BB.h / 2, bz);
    b.put('dark', new THREE.CylinderGeometry(BB.r - 0.3, BB.r - 0.3, BB.h * 0.7, 12), 0, H.spine.y + BB.h * 0.5, bz);
    b.put('trim', new THREE.TorusGeometry(BB.r - 0.1, 0.12, 5, 14).rotateX(Math.PI / 2), 0, H.spine.y + BB.h, bz);
    b.solid(0, H.spine.y + BB.h / 2, bz, BB.r * 0.8, BB.h / 2, BB.r * 0.8);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      b.box('trim', 0.24, BB.h, 0.24, Math.cos(a) * BB.r, H.spine.y + BB.h / 2, bz + Math.sin(a) * BB.r, a, 1);
    }
  }
  // The barrel that was delivered and never lifted, chocked on the deck.
  b.put('dark', new THREE.CylinderGeometry(0.44, 0.55, 9.0, 10).rotateX(Math.PI / 2), 2.4, H.spine.y + 0.55, -3.5);
  b.solid(2.4, H.spine.y + 0.5, -3.5, 0.55, 0.5, 4.5);
  for (const cz of [-7.2, 0.2]) {
    b.cbox('trim', 1.5, 0.5, 0.7, 2.4, H.spine.y + 0.25, cz, 0, 1);
  }

  /* Courses, bolt rows, ribs, relief and panel lines all pin a box to a
   * flank at exactly `hw`, and the authored skin is not that: it flares from
   * 6.90 to 8.00 over the last six metres at each end, so every one of them
   * would float up to 1.1 m off its own hull at the transom. That arm's
   * surface interest is generated from the section instead - frame rings and
   * two strakes, 3 cm proud of the skin they were taken from. */
  b.mute(!!skin);
  b.course('trim', H.lower.hw, H.lower.z0, H.lower.z1, H.ledge.y - 0.4, { h: 0.36, proud: 0.22 });
  // The middle course runs at bay height, so it is laid run by run as well.
  for (const [ra, rb] of intactRuns(H.lower.z0, H.lower.z1, H.stripped)) {
    if (rb - ra < 1.0) continue;
    b.course('trim', H.lower.hw, ra, rb, 2.2, { h: 0.3, proud: 0.18, ends: false });
  }
  b.course('trim', H.upper.hw, H.upper.z0, H.upper.z1, H.upper.y1 - 0.34, { h: 0.3, proud: 0.18 });
  for (const s of [-1, 1]) {
    b.bolts('trim', s * (H.lower.hw + 0.09), H.ledge.y - 0.4, H.lower.z0 + 1, H.lower.z1 - 1, 30);
    b.bolts('trim', s * (H.upper.hw + 0.09), H.upper.y1 - 0.34, H.upper.z0 + 1, H.upper.z1 - 1, 24);
  }
  for (let i = 0; i < 12; i++) {
    const rz = H.lower.z0 + 1.6 + i * 2.4;
    // A rib standing proud of plating that is not there is a rib in mid-air.
    if (H.stripped.some((c) => rz > c.z0 - 0.2 && rz < c.z1 + 0.2)) continue;
    b.rib('trim', H.lower.hw, H.lower.y0, H.ledge.y - 0.55, rz, 0.3, 0.16);
  }

  /* ── Relief ───────────────────────────────────────────────────────────
   * Run by run, skipping the stripped bays. Relief is drawn ON the plane of
   * the plating, so relief over a bay is a raised patch, a vent and a run of
   * conduit floating in mid-air across a hole — and, measured, it is worse
   * than merely wrong: a ray fired into the bay stopped on the panel lines at
   * 7.96 instead of on the inner skin at 7.30, so the hole read as 0.10 m deep
   * from outside. Sixty centimetres of the depth this hull's whole silhouette
   * depends on was being painted back in by its own detailing. */
  for (const [ra, rb] of intactRuns(H.lower.z0, H.lower.z1, H.stripped)) {
    if (rb - ra < 0.6) continue;
    panelLines(b, { hw: H.lower.hw, y0: H.lower.y0, y1: H.ledge.y, z0: ra, z1: rb, pitchZ: 1.7, pitchY: 0.7 });
    /* 2.2 m of margin at each end of a run, not 0.6, because `relief` places
     * an item's CENTRE inside the range it is given and its longest part — a
     * conduit run with clips every 0.6 m — is 3.8 m from end to end. At 0.6 m
     * of margin the clips marched 1.9 m past the last plating and hung in the
     * bay: measured, 88 drawn vertices standing on a plating line that had
     * been taken away. */
    if (rb - ra < 5.0) continue;
    relief(b, {
      hw: H.lower.hw, y0: H.lower.y0 + 0.5, y1: H.ledge.y - 0.8,
      z0: ra + 2.2, z1: rb - 2.2,
      /* 24 a metre. Laying relief run by run rather than over the whole flank
       * dropped this hull from 31,412 triangles to 23,488, because two of the
       * three runs are under 5 m and are skipped: the density on the run that
       * remains has to carry what the other two used to. */
      n: Math.max(8, Math.round((rb - ra) * 24)), seed: 83 + Math.round(ra),
    });
  }
  panelLines(b, { hw: H.upper.hw, y0: H.upper.y0, y1: H.upper.y1, z0: H.upper.z0, z1: H.upper.z1, pitchZ: 1.5, pitchY: 0.66, key: 'accent' });
  relief(b, { hw: H.upper.hw, y0: H.upper.y0 + 0.5, y1: H.upper.y1 - 0.6, z0: H.upper.z0 + 1, z1: H.upper.z1 - 1, n: 162, seed: 89, key: 'accent' });
  /* Deck fittings and the berth stencil are drawn on both arms: they sit on
   * the two walkable plates, which are drawn on both arms too. */
  b.mute(false);
  deckDetail(b, { hw: H.ledge.outer - 0.9, y: H.ledge.y, z0: H.lower.z0 + 2, z1: H.lower.z1 - 2, n: 54, seed: 97 });
  deckDetail(b, { hw: H.spine.hw - 0.8, y: H.spine.y, z0: H.spine.z0 + 1.5, z1: H.spine.z1 - 1.5, n: 42, seed: 101, key: 'accent' });
  berthStencil(b, 6.0, 2.4, YARD_SIGN.berthB4, H.lower.hw, 2.6, -4.0);
  b.mute(!!skin);
  /* Open access panels, with the loom hanging out of them. A hulk that was
   * never finished is a hulk somebody stopped working on halfway, and the panel
   * that is still off is what says so. */
  /* Stations chosen to miss `BASTION.stripped`: an access panel hanging off a
   * hinge in the middle of a bay whose plating was taken away entirely is a
   * door with no wall, and it was also what the bay-depth probe kept stopping
   * on — the recess sits 7.96 m out and the inner skin is at 7.30. */
  for (const [py, pz] of [[2.6, -5.5], [2.6, 1.0], [5.4, -3.0]]) {
    for (const s of [-1, 1]) {
      b.box('dark', 0.12, 1.4, 2.0, s * (H.lower.hw - 0.1), py, pz, 0, 1);
      // The panel itself, still on one hinge and hanging away from the flank.
      b.rbox('accent', 0.1, 1.5, 2.1, s * (H.lower.hw + 0.5), py + 0.3, pz + 1.4, 0, 0, s * 0.35, 1);
      for (let i = 0; i < 7; i++) {
        b.put('trim', new THREE.CylinderGeometry(0.045, 0.045, 1.6 + i * 0.1, 5).rotateZ(Math.PI / 2),
          s * (H.lower.hw + 0.35), py + 0.2 - i * 0.12, pz - 0.6 + i * 0.2, 0, 0, s * 0.2);
      }
    }
  }

  /* ── The open bow ─────────────────────────────────────────────────── */
  const OB = H.openBow;
  for (let i = 0; i <= OB.frames; i++) {
    const t = i / OB.frames;
    const z = OB.z0 + (OB.z1 - OB.z0) * t;
    const hw = OB.hw - 4.6 * t;
    // A frame is two stanchions, two knees and a head — never a plate.
    for (const s of [-1, 1]) {
      b.cbox('trim', 0.34, OB.y1 - OB.y0, 0.34, s * hw, (OB.y0 + OB.y1) / 2, z, 0, 1);
      b.rbox('trim', 1.2, 0.32, 0.32, s * (hw - 0.5), OB.y1 - 0.1, z, 0, 0, s * 0.5, 1);
    }
    b.cbox('trim', Math.max(0.4, (hw - 0.8) * 2), 0.3, 0.3, 0, OB.y1 - 0.34, z, 0, 1);
  }
  // Longitudinal stringers tying the frames together. Members, not a slab.
  for (const s of [-1, 1]) {
    for (const y of [1.4, 2.8]) {
      b.box('trim', 0.22, 0.22, OB.z1 - OB.z0, s * (OB.hw - 2.3), y, (OB.z0 + OB.z1) / 2, 0, 1);
    }
  }
  b.mute(false);
  deckSlab(b, 'deckg', OB.y1, OB.hw - 2.2, OB.z0, OB.z0 + 5.0);
  b.box('hazard', 4.0, 0.05, 0.5, 0, OB.y1 + 0.03, OB.z0 + 5.2, 0, 1);

  b.mute(!!skin);
  /* ── The stern section, standing on the shed floor ────────────────── */
  const SR = H.sternRibs;
  for (let i = 0; i <= SR.frames; i++) {
    const t = i / SR.frames;
    const z = SR.z0 + (SR.z1 - SR.z0) * t;
    for (const s of [-1, 1]) {
      b.cbox('trim', 0.4, SR.y1 - SR.y0, 0.4, s * SR.hw, (SR.y0 + SR.y1) / 2, z, 0, 1);
      b.cbox('trim', 1.6, 0.36, 0.36, s * (SR.hw - 0.8), SR.y1 - 0.4, z, 0, 1);
      b.cbox('dark', 1.0, 0.5, 1.0, s * SR.hw, SR.y0 + 0.25, z, 0, 1);
    }
    b.cbox('trim', (SR.hw - 1.5) * 2, 0.34, 0.34, 0, SR.y1 - 0.2, z, 0, 1);
  }
  for (const s of [-1, 1]) {
    for (const y of [1.2, 3.2]) {
      b.box('trim', 0.26, 0.26, SR.z1 - SR.z0, s * (SR.hw - 0.2), y, (SR.z0 + SR.z1) / 2, 0, 1);
    }
  }
  /* The tarp and the three caches are the yard's litter, not the ship. */
  b.mute(false);
  b.box('tarp', SR.hw * 1.5, 0.1, 5.0, 0, SR.y1 - 0.7, SR.z0 + 2.6, 0, 3);
  b.spot(2.4, SR.y0 + 0.7, SR.z0 + 3.0, 'common');
  b.spot(-3.2, SR.y0 + 0.7, SR.z1 - 2.4, 'common');
  b.spot(0, SR.y0 + 0.7, (SR.z0 + SR.z1) / 2, 'rare');

  b.mute(!!skin);
  /* ── The engine bell on its stand ─────────────────────────────────── */
  const BE = H.bell;
  b.cbox('dark', 3.2, 0.6, 3.2, BE.lx, BE.y0 + 0.3, BE.lz, 0, 1);
  for (const s of [-1, 1]) {
    b.cbox('trim', 0.3, 2.0, 0.3, BE.lx + s * 1.3, BE.y0 + 1.6, BE.lz, 0, 1);
  }
  b.put('accent', new THREE.CylinderGeometry(BE.r0, BE.r1, 3.4, 10), BE.lx, BE.y0 + 4.4, BE.lz);
  b.solid(BE.lx, BE.y0 + 4.4, BE.lz, BE.r1 * 0.78, 1.7, BE.r1 * 0.78);
  b.put('glow', new THREE.CylinderGeometry(BE.r1 - 0.2, BE.r1 - 0.2, 0.14, 10), BE.lx, BE.y0 + 2.75, BE.lz);
  b.cbox('trim', 1.2, 0.9, 1.2, BE.lx, BE.y0 + 6.4, BE.lz, 0, 1);

  b.mute(false);
  return { rooms: [], lights: [] };
}
