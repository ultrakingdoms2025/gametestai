import * as THREE from 'three';
/* Lights are born HIDDEN: one frame with a world's own lights live re-links
 * every program on screen. gfx/WorldLight.js has the whole of it. */
import { pointLight } from '../../gfx/WorldLight.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../../core/Config.js';
import { RIG_BUDGET } from '../../gfx/LightRig.js';

/**
 * Caves - a kit for carving sealed, lit, walkable rock volumes into a world.
 *
 * ── What this is for ──────────────────────────────────────────────────────
 * Design 2026-08-17 §5.2 wants two kinds of underground in the Citadel ring: a
 * mine (adit -> drive -> gallery -> stope, in the Quarry & Deepworks) and a
 * natural karst cavern (a hall with a chimney out through the roof, in the
 * massif). §5.3 says they are nearly free. The part that is free is not the
 * part the design named - see "The cost, measured" below.
 *
 * ── How a cave is described ───────────────────────────────────────────────
 * A cave is a PLAN: a handful of axis-aligned AIR volumes (`cells`), a list of
 * declared holes in their surface (`mouths`), and the furniture standing in
 * them (`ledges`, `stairs`, `props`, `spots`, plus lights derived from the
 * cells). The plan is authored in the cave's own local frame at its own
 * origin and placed into the world with a yaw, so the same mine can be driven
 * into any bearing of any cliff without re-authoring a number.
 *
 * The builder does not model rock. It models AIR and then wraps it: for each
 * of a cell's six faces it takes the whole face, subtracts every neighbouring
 * cell that shares that plane and every declared mouth, and emits the
 * remainder as slabs {@link ROCK_T} thick. A cave is therefore sealed by
 * CONSTRUCTION, and the only openings it can have are the declared ones.
 *
 * That is an argument, not a proof, and this project has been caught by
 * exactly that distinction before.
 *
 * ── Emitted is not present ────────────────────────────────────────────────
 * `MazeShafts.isEnclosureSound` is the ancestor of the audit at the bottom of
 * this file, and it is NOT reusable: it works in maze cell coordinates against
 * maze constants, and its `enclosed: true` is a field on a maze collider
 * descriptor that `Physics` never reads. What transfers is the lesson. A shaft
 * that proved itself sealed against the walls it had just emitted was later
 * opened by a different pass deleting one of those walls, and the proof did
 * not notice, because the proof had never looked at the world.
 *
 * So {@link auditCave} takes a {@link SolidField} built from `physics.colliders`
 * - the FINAL collider set, after every pass in the world has run - and asks
 * it, point by point, whether the rock is there. Nothing in the audit knows
 * what the builder emitted. Run it last or it proves nothing.
 *
 * ── The properties the audit proves ───────────────────────────────────────
 *   0. GROUNDED. See the heightfield note below; every other property is
 *      vacuous if this one fails, so it runs first.
 *   1. SEALED, with exactly the intended openings. Every point on the boundary
 *      of the air volume is solid except inside a declared mouth, and every
 *      declared mouth is actually open.
 *   2. HEADROOM >= 1.8 m over every walkable square. The capsule is 1.75 m.
 *   3. STEPS are legal: every height change on a walkable route is either a
 *      walk-up (<= `stepHeight` 0.45) or a mantle (`Climb.js` MIN_RISE_GROUND
 *      1.0 to MAX_RISE 2.4). The band between them is the one the body cannot
 *      resolve, and it is asserted empty.
 *   4. REACHABLE: the walkable squares form one component containing every
 *      mouth and every collectible spot. A sealed, lit, beautifully
 *      headroomed chamber nobody can walk into is the medieval defect class
 *      over again.
 *   5. LIT, measured. {@link floorIlluminance} evaluates Three's own
 *      point-light falloff on the floor plane, through the rig's 12-slot
 *      budget, and reports the WORST square rather than the mean.
 *
 * Property 5 has a companion that is not about light at all. Three rounds of
 * lighting work on the medieval interiors chased "too dark" while headless
 * illuminance said the dark rooms were getting MORE light than the controls;
 * the cause was room-spanning boarding slabs 1.66 m over the floor. So
 * {@link auditSpans} looks for GEOMETRY that spans a chamber between its floor
 * and its ceiling, and the clearance audit reports "floor standable but head
 * blocked" as its own number, separate from "square occupied", for the same
 * reason. Neither a lux figure nor a clearance figure would have found that
 * defect; the pair does.
 *
 * ── The heightfield constraint (this one is load-bearing) ─────────────────
 * A `Physics` heightfield is solid from its surface down to `baseY`, which
 * Citadel leaves at `minY - 50`, and `Physics._closestPoint` recovers anything
 * under that surface by shoving it straight up. **So a cave cannot be dug into
 * terrain.** Drive an adit horizontally into a hillside and every metre of it
 * is under the surface of a single-valued heightfield, and the player is
 * ejected through the roof.
 *
 * The escape hatch is the one that same code names: "Below `baseY` the field
 * stops being solid, so a genuine cave or under-deck volume is not sealed."
 * Fifty metres down is not where an adit mouth goes. The workable answer is
 * the other one: the rock a cave is carved into must be BUILT GEOMETRY
 * standing above the local terrain - the same boxes Citadel's cliff ring is
 * already made of - and the cave air must sit at or above the terrain surface
 * under its own footprint. {@link auditGrounding} asserts precisely that.
 * Citadel's desert floor collider tops out at y = 0 and `terrainH` is flat 0
 * beyond r = 178, so a cave on the ring flats wants `origin.y >= 0`.
 *
 * ── The cost, measured ────────────────────────────────────────────────────
 * Lighting really is free, and the reason is worth restating: `LightRig` sets
 * every light in the game `visible = false` and copies the best
 * `RIG_BUDGET.point` of them into fixed slots, so the light counts in Three's
 * program cache key never move. Two hundred torches and eight torches compile
 * the same programs. `scripts/tests/citadel-caves.test.mjs` measures that
 * rather than repeating it.
 *
 * Rock is not free, and the heightfield constraint above is why: a cave cannot
 * be subtracted from terrain that already exists, so its host massif has to be
 * built. The numbers are in the test.
 *
 * ── Frame cost ────────────────────────────────────────────────────────────
 * Zero. There is no update path in this module and nothing registers one:
 * geometry is merged at build time, colliders are static, lights are static
 * sources the rig scores, and the collectibles stream through `Interiors`
 * (in at 46 m, out at 64 m) off the doorless descriptor {@link buildCave}
 * returns. Nothing here allocates outside a build or audit call.
 */

const P = CONFIG.player;

/** Player capsule, from `CONFIG.player`. Everything below is sized off these. */
export const CAPSULE_H = P.height;
export const CAPSULE_R = P.radius;
/** The tallest rise a walk absorbs. `Player._move`'s step probe. */
export const STEP_MAX = P.stepHeight;
/** `Climb.js` MIN_RISE_GROUND / MAX_RISE: the band a mantle can take. */
export const MANTLE_MIN = 1.0;
export const MANTLE_MAX = 2.4;
/**
 * Clear air a square needs over it to be walkable.
 *
 * 1.75 m of capsule plus five centimetres, the same number the reach suite
 * uses and for the same reason: the difference between a passage and a crawl
 * is 5 cm.
 */
export const HEADROOM = 1.8;
/** Shell thickness. Thick enough that no seal sample lands past the far side. */
export const ROCK_T = 0.9;
/** Boundary sample pitch for the seal audit. */
export const SEAL_STEP = 0.25;
/** Floor sample pitch for the clearance, reach and illuminance audits. */
export const FLOOR_STEP = 0.5;
/** Point-light slots the rig can actually deliver at once. Imported, not copied. */
export const LIGHT_SLOTS = RIG_BUDGET.point;

/** Wall sconce. Sized against `MedievalWorld._interiorLight` (46 @ 9.5 m). */
export const SCONCE = Object.freeze({
  colour: 0xffb066, intensity: 60, range: 18, height: 2.2, inset: 0.55, spacing: 5.5,
});
/**
 * Brazier, for a chamber too wide for its own walls to light.
 *
 * Measured, at the centre of the karst hall's floor (24 x 22 m), through the
 * rig's twelve slots: all FOURTEEN of its wall sconces together deliver
 * **1.10**; with the nine braziers, **20.11**. A hall lit only from its walls
 * is a black room with a rim of orange round it, and no plausible sconce
 * intensity fixes that - the falloff is `1/d^2` and the middle of the room is
 * 11 m from every wall. The grid pitch here is the number the illuminance
 * audit is really measuring.
 */
export const BRAZIER = Object.freeze({
  colour: 0xff9a44, intensity: 115, range: 26, height: 2.6, pitch: 7.5,
});
/** A cell wider than this gets braziers as well as sconces. */
export const BRAZIER_MIN_WIDTH = 9.0;

/** Material keys. Citadel's own, so `world._mat` resolves them untouched. */
export const MAT = Object.freeze({
  rock: 'stone.castle', floor: 'stone.cobble', timber: 'wood.beam',
});

const EPS = 1e-4;

/* ====================================================================== */
/* Plan geometry                                                          */
/* ====================================================================== */

/**
 * The six faces of a cell: the axis the normal runs along, which way it
 * points, and the two in-plane axes a rectangle on it is measured in.
 */
export const FACE_AXES = Object.freeze({
  '-x': Object.freeze({ n: 'x', s: -1, a: 'z', b: 'y' }),
  '+x': Object.freeze({ n: 'x', s: +1, a: 'z', b: 'y' }),
  '-z': Object.freeze({ n: 'z', s: -1, a: 'x', b: 'y' }),
  '+z': Object.freeze({ n: 'z', s: +1, a: 'x', b: 'y' }),
  '-y': Object.freeze({ n: 'y', s: -1, a: 'x', b: 'z' }),
  '+y': Object.freeze({ n: 'y', s: +1, a: 'x', b: 'z' }),
});
export const FACES = Object.freeze(Object.keys(FACE_AXES));

/** Low edge of a cell along an axis. `y` reads the floor. */
export function cellLo(c, axis) { return axis === 'x' ? c.x0 : axis === 'z' ? c.z0 : c.floor; }
/** High edge of a cell along an axis. `y` reads the ceiling. */
export function cellHi(c, axis) { return axis === 'x' ? c.x1 : axis === 'z' ? c.z1 : c.ceil; }

/** Intersect two rectangles, or null when they do not overlap with area. */
function clipRect(r, h) {
  const a0 = Math.max(r.a0, h.a0);
  const a1 = Math.min(r.a1, h.a1);
  const b0 = Math.max(r.b0, h.b0);
  const b1 = Math.min(r.b1, h.b1);
  if (a1 - a0 <= EPS || b1 - b0 <= EPS) return null;
  return { a0, a1, b0, b1 };
}

/**
 * `rect` minus `holes`, as a small set of rectangles.
 *
 * Cut the rectangle on every hole edge that falls inside it, keep the grid
 * squares no hole covers, then merge the survivors along `a` and then along
 * `b`. The merge is what keeps a wall with one doorway in it at three boxes
 * rather than a few hundred, and these are colliders, so that matters.
 *
 * @param {{a0:number,a1:number,b0:number,b1:number}} rect
 * @param {Array<{a0:number,a1:number,b0:number,b1:number}>} holes
 */
export function subtractRects(rect, holes) {
  if (!holes.length) return [{ ...rect }];
  const as = new Set([rect.a0, rect.a1]);
  const bs = new Set([rect.b0, rect.b1]);
  for (const h of holes) {
    for (const v of [h.a0, h.a1]) if (v > rect.a0 + EPS && v < rect.a1 - EPS) as.add(v);
    for (const v of [h.b0, h.b1]) if (v > rect.b0 + EPS && v < rect.b1 - EPS) bs.add(v);
  }
  const A = [...as].sort((p, q) => p - q);
  const B = [...bs].sort((p, q) => p - q);

  /** Grid rows, already merged along `a`. */
  const bands = [];
  for (let j = 0; j < B.length - 1; j++) {
    const b0 = B[j];
    const b1 = B[j + 1];
    if (b1 - b0 <= EPS) { bands.push([]); continue; }
    const bc = (b0 + b1) * 0.5;
    const row = [];
    for (let i = 0; i < A.length - 1; i++) {
      const a0 = A[i];
      const a1 = A[i + 1];
      if (a1 - a0 <= EPS) continue;
      const ac = (a0 + a1) * 0.5;
      let covered = false;
      for (const h of holes) {
        if (ac > h.a0 && ac < h.a1 && bc > h.b0 && bc < h.b1) { covered = true; break; }
      }
      if (covered) continue;
      const last = row[row.length - 1];
      if (last && Math.abs(last.a1 - a0) < EPS) last.a1 = a1;
      else row.push({ a0, a1, b0, b1 });
    }
    bands.push(row);
  }

  // Merge identical a-spans across adjacent b bands.
  const out = [];
  const carried = new Map();
  const keyOf = (r) => `${r.a0}|${r.a1}`;
  for (const row of bands) {
    const seen = new Set();
    for (const r of row) {
      const k = keyOf(r);
      seen.add(k);
      const c = carried.get(k);
      if (c && Math.abs(c.b1 - r.b0) < EPS) c.b1 = r.b1;
      else { const n = { ...r }; carried.set(k, n); out.push(n); }
    }
    for (const k of [...carried.keys()]) if (!seen.has(k)) carried.delete(k);
  }
  return out;
}

/**
 * Every opening in one face of one cell: neighbouring air on the far side of
 * the plane, plus every mouth declared on it.
 */
export function faceHoles(plan, cell, face) {
  const F = FACE_AXES[face];
  const rect = {
    a0: cellLo(cell, F.a), a1: cellHi(cell, F.a),
    b0: cellLo(cell, F.b), b1: cellHi(cell, F.b),
  };
  const plane = F.s < 0 ? cellLo(cell, F.n) : cellHi(cell, F.n);
  const holes = [];
  for (const o of plan.cells) {
    if (o === cell) continue;
    const oPlane = F.s < 0 ? cellHi(o, F.n) : cellLo(o, F.n);
    if (Math.abs(oPlane - plane) > 1e-3) continue;
    const h = clipRect(rect, {
      a0: cellLo(o, F.a), a1: cellHi(o, F.a),
      b0: cellLo(o, F.b), b1: cellHi(o, F.b),
    });
    if (h) holes.push(h);
  }
  for (const m of plan.mouths) {
    if (m.cell !== cell.id || m.face !== face) continue;
    const h = clipRect(rect, m);
    if (h) holes.push(h);
  }
  return { rect, plane, holes };
}

/** Local -> world. `makeRotationY(yaw)`, matching `physics.addRotatedBox`. */
export function toWorld(plan, lx, ly, lz, out) {
  const c = Math.cos(plan.yaw);
  const s = Math.sin(plan.yaw);
  const o = plan.origin;
  const v = out || { x: 0, y: 0, z: 0 };
  v.x = o.x + lx * c + lz * s;
  v.y = o.y + ly;
  v.z = o.z - lx * s + lz * c;
  return v;
}

/** The cell a local point sits inside, or null. */
export function cellAt(plan, lx, ly, lz, slack = 0) {
  for (const c of plan.cells) {
    if (lx < c.x0 - slack || lx > c.x1 + slack) continue;
    if (lz < c.z0 - slack || lz > c.z1 + slack) continue;
    if (ly < c.floor - slack || ly > c.ceil + slack) continue;
    return c;
  }
  return null;
}

/* ====================================================================== */
/* Authoring                                                              */
/* ====================================================================== */

/**
 * Fill in everything a plan can derive from its own cells: the light rig, the
 * mouth centres a world needs for its approach gate, and the sanity checks
 * that would otherwise become audit failures a hundred lines later.
 *
 * Two cells may share a face freely. They may NOT interpenetrate: the shell
 * builder subtracts a neighbour from a face only when the two agree on the
 * plane, so an overlap would leave a slab of rock standing inside the air.
 * That is caught here, at build time, with the cell ids in the message,
 * rather than as one more unreachable square in an audit.
 */
export function normalisePlan(plan) {
  const p = {
    id: plan.id,
    label: plan.label ?? plan.id,
    kind: plan.kind ?? 'cave',
    origin: { x: plan.origin?.x ?? 0, y: plan.origin?.y ?? 0, z: plan.origin?.z ?? 0 },
    yaw: plan.yaw ?? 0,
    cells: (plan.cells ?? []).map((c) => ({ ...c })),
    mouths: (plan.mouths ?? []).map((m) => ({ ...m })),
    ledges: (plan.ledges ?? []).map((l) => ({ ...l })),
    stairs: (plan.stairs ?? []).map((s) => ({ ...s })),
    props: (plan.props ?? []).map((s) => ({ ...s })),
    spots: (plan.spots ?? []).map((s) => ({ ...s })),
    lights: (plan.lights ?? []).map((l) => ({ ...l })),
    lit: plan.lit !== false,
  };

  const byId = new Map();
  for (const c of p.cells) {
    if (byId.has(c.id)) throw new Error(`Caves: duplicate cell id "${c.id}" in ${p.id}`);
    if (!(c.x1 > c.x0 && c.z1 > c.z0 && c.ceil > c.floor)) {
      throw new Error(`Caves: cell "${c.id}" in ${p.id} is inside out`);
    }
    if (c.ceil - c.floor < HEADROOM + 0.05) {
      throw new Error(
        `Caves: cell "${c.id}" in ${p.id} is ${(c.ceil - c.floor).toFixed(2)} m tall - `
        + `the capsule is ${CAPSULE_H} m and needs ${HEADROOM}`
      );
    }
    byId.set(c.id, c);
  }
  p.cellById = byId;

  for (let i = 0; i < p.cells.length; i++) {
    for (let j = i + 1; j < p.cells.length; j++) {
      const a = p.cells[i];
      const b = p.cells[j];
      const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      const oz = Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0);
      const oy = Math.min(a.ceil, b.ceil) - Math.max(a.floor, b.floor);
      if (ox > 1e-3 && oz > 1e-3 && oy > 1e-3) {
        throw new Error(
          `Caves: cells "${a.id}" and "${b.id}" in ${p.id} interpenetrate by `
          + `${ox.toFixed(2)} x ${oy.toFixed(2)} x ${oz.toFixed(2)} m - share a face or stay apart`
        );
      }
    }
  }

  for (const m of p.mouths) {
    const c = byId.get(m.cell);
    if (!c) throw new Error(`Caves: mouth "${m.id}" in ${p.id} names no cell "${m.cell}"`);
    if (!FACE_AXES[m.face]) throw new Error(`Caves: mouth "${m.id}" has no face "${m.face}"`);
    const F = FACE_AXES[m.face];
    m.plane = F.s < 0 ? cellLo(c, F.n) : cellHi(c, F.n);
    // Centre of the aperture, in local and in world - the point a world's
    // approach gate walks to and the point `Interiors` measures range from.
    const la = (m.a0 + m.a1) * 0.5;
    const lb = (m.b0 + m.b1) * 0.5;
    const local = { x: 0, y: 0, z: 0 };
    local[F.n] = m.plane;
    local[F.a] = la;
    local[F.b] = lb;
    m.local = local;
    m.position = toWorld(p, local.x, local.y, local.z);
    m.area = (m.a1 - m.a0) * (m.b1 - m.b0);
    if (F.n === 'y') {
      /* World Y of the lip a body steps onto coming out of the hole, and steps
       * off going in. The host world has to put its ground surface here: a
       * roof mouth whose rim is 3 m above the massif is a hole nobody can use
       * from outside, and the reach suite cannot see that from inside. */
      m.rim = p.origin.y + m.plane + (F.s > 0 ? ROCK_T : -ROCK_T);
      const narrow = Math.min(m.a1 - m.a0, m.b1 - m.b0);
      if (narrow < CAPSULE_R * 2 + 0.3) {
        throw new Error(
          `Caves: roof mouth "${m.id}" in ${p.id} is ${narrow.toFixed(2)} m across - `
          + `the capsule is ${(CAPSULE_R * 2).toFixed(2)} m wide`
        );
      }
    } else if (m.b1 - m.b0 < HEADROOM) {
      throw new Error(
        `Caves: mouth "${m.id}" in ${p.id} is ${(m.b1 - m.b0).toFixed(2)} m tall - `
        + `a body needs ${HEADROOM}`
      );
    }
  }
  if (!p.mouths.length) throw new Error(`Caves: ${p.id} has no mouth - it is a sealed box`);

  for (const s of p.spots) s.position = toWorld(p, s.x, s.y, s.z);

  if (p.lit && !p.lights.length) p.lights = planLights(p);
  for (const l of p.lights) l.position = toWorld(p, l.x, l.y, l.z);

  return p;
}

/**
 * Sconces round the walls of every cell, braziers on a grid in the wide ones.
 *
 * Sconces go on the two long walls of a passage because a passage is lit from
 * its sides; braziers go on a grid because a hall is not. Which of the two a
 * cell gets is decided by its narrow dimension against
 * {@link BRAZIER_MIN_WIDTH}, and the illuminance audit is what says the
 * threshold is in the right place.
 */
export function planLights(plan) {
  const out = [];
  for (const c of plan.cells) {
    const w = c.x1 - c.x0;
    const d = c.z1 - c.z0;
    const sconceY = c.floor + SCONCE.height;
    if (sconceY + 0.25 > c.ceil) continue; // a crawl gets its light from next door

    const along = (len, pitch) => {
      const n = Math.max(1, Math.round(len / pitch));
      const step = len / n;
      const at = [];
      for (let i = 0; i < n; i++) at.push(step * (i + 0.5));
      return at;
    };

    // Sconces on the two walls that run along the cell's long axis.
    if (w >= d) {
      for (const t of along(w, SCONCE.spacing)) {
        out.push({ kind: 'sconce', fitting: 'sconce', cell: c.id, base: c.floor, x: c.x0 + t, y: sconceY, z: c.z0 + SCONCE.inset });
        if (d > 2 * SCONCE.inset + 0.6) {
          out.push({ kind: 'sconce', fitting: 'sconce', cell: c.id, base: c.floor, x: c.x0 + t, y: sconceY, z: c.z1 - SCONCE.inset });
        }
      }
    } else {
      for (const t of along(d, SCONCE.spacing)) {
        out.push({ kind: 'sconce', fitting: 'sconce', cell: c.id, base: c.floor, x: c.x0 + SCONCE.inset, y: sconceY, z: c.z0 + t });
        if (w > 2 * SCONCE.inset + 0.6) {
          out.push({ kind: 'sconce', fitting: 'sconce', cell: c.id, base: c.floor, x: c.x1 - SCONCE.inset, y: sconceY, z: c.z0 + t });
        }
      }
    }

    if (Math.min(w, d) >= BRAZIER_MIN_WIDTH && c.floor + BRAZIER.height + 0.4 < c.ceil) {
      const nx = Math.max(1, Math.round(w / BRAZIER.pitch));
      const nz = Math.max(1, Math.round(d / BRAZIER.pitch));
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < nz; j++) {
          out.push({
            kind: 'brazier', fitting: 'pit', cell: c.id, base: c.floor,
            x: c.x0 + (w / nx) * (i + 0.5),
            y: c.floor + BRAZIER.height,
            z: c.z0 + (d / nz) * (j + 0.5),
          });
        }
      }
    }
  }
  /* A ledge nobody can see is a ledge nobody mantles.
   *
   * `fitting: null` is load-bearing, not tidiness. A sconce bracket is a
   * collider, and a collider 1.3 m over a mantle ledge takes that ledge's
   * headroom from 2.25 m to 1.1 and deletes it from the climb - the audit
   * reported the ledges as unwalkable the first time this was written with a
   * bracket on them. The light hangs with nothing under it. */
  for (const l of plan.ledges) {
    if (!l.torch) continue;
    out.push({
      kind: 'sconce', fitting: null, cell: l.cell, base: l.top,
      x: l.x, y: l.top + SCONCE.height * 0.6, z: l.z,
    });
  }
  return out;
}

/** Config of a light kind. */
function lightSpec(kind) { return kind === 'brazier' ? BRAZIER : SCONCE; }

/* ====================================================================== */
/* The two authored cave types                                            */
/* ====================================================================== */

/**
 * A mine: adit mouth -> level drive -> stepped rise -> gallery -> side stope,
 * with a second mouth high on the far side so the whole thing is a THROUGH
 * route rather than an out-and-back.
 *
 * Local frame: +x drives into the rock from the mouth, y = 0 is the adit
 * floor. Everything rises, nothing descends, because a `Physics` heightfield
 * is solid downward (see the module header) and Citadel's desert floor
 * collider tops out at y = 0 - a mine that went down would be a mine inside a
 * solid box.
 *
 * The 2.0 m rise from the drive to the gallery is a stair of five 0.40 m
 * risers, not a 2.0 m mantle, because a stair is what a body does with a
 * loaded ore cart. The stope is the other lesson: six 1.4 m mantles, every one
 * inside `Climb.js`'s 1.0 - 2.4 m band, teaching the verb that the karst
 * cavern then demands ten of.
 */
export function planMine({
  id = 'deepworks', label = 'The Deepworks', origin = { x: 0, y: 0, z: 0 }, yaw = 0,
} = {}) {
  const cells = [
    // Portal chamber, just inside the adit mouth. Wider than the drive so the
    // mouth reads as an opening rather than as the end of a tube.
    { id: 'portal', x0: 0, x1: 5, z0: -3.0, z1: 3.0, floor: 0, ceil: 3.2 },
    // The drive. Level, timbered, 2.8 m wide.
    { id: 'drive', x0: 5, x1: 27, z0: -1.4, z1: 1.4, floor: 0, ceil: 2.7 },
    // Stair bay: the drive widens where the flight begins so the steps are not
    // in the through-traffic lane.
    { id: 'stairbay', x0: 27, x1: 32, z0: -1.6, z1: 1.6, floor: 0, ceil: 4.9 },
    // Gallery, 2.0 m above the drive.
    { id: 'gallery', x0: 32, x1: 48, z0: -7.0, z1: 7.0, floor: 2.0, ceil: 6.6 },
    // Side stope off the gallery, climbing out to the day hole.
    { id: 'stope', x0: 40, x1: 48, z0: 7.0, z1: 15.0, floor: 2.0, ceil: 11.0 },
  ];
  const mouths = [
    {
      id: 'adit', cell: 'portal', face: '-x', label: 'the adit',
      a0: -1.5, a1: 1.5, b0: 0, b1: 2.6,
    },
    {
      id: 'dayhole', cell: 'stope', face: '+y', label: 'the day hole',
      a0: 42.0, a1: 46.4, b0: 9.4, b1: 12.6,
    },
  ];
  /* Five risers of 0.40 up the stair bay, and the flight runs the whole way to
   * x = 32 where the gallery floor begins. It has to: leave the last tread
   * short of the wall and there is a 0.6 m slot beside it with a 2 m drop in
   * the bottom, which is not a step, a mantle or anything else a body has a
   * verb for. */
  const stairs = [{
    cell: 'stairbay', axis: 'x', from: { x: 27.6, y: 0 }, to: { x: 32.0, y: 2.0 },
    width: 3.2, z: 0, rise: 0.4,
  }];
  /* The stope: six mantle ledges to the day hole, 1.4 m apart, ZIG-ZAGGED
   * rather than spiralled.
   *
   * The zig-zag is the whole trick, and the first draft of this got it wrong.
   * A body mantles from the square NEXT TO a ledge, so consecutive ledges have
   * to touch - a spiral of ledges with air between them is a staircase with
   * every other tread missing, and the reach audit says so. Alternating two
   * touching columns gives every ledge a neighbour 1.4 m below it and puts the
   * ledge two above it, 2.25 m of clear air over your head, on the same side.
   *
   * Both of the top two stand under the day hole, because that is the only
   * place in the stope where a ledge can have its 1.8 m with an 11 m ceiling.
   */
  const ledges = [];
  for (let i = 0; i < 6; i++) {
    ledges.push({
      cell: 'stope', x: i % 2 === 0 ? 43.1 : 45.3, z: 11.0,
      top: 3.4 + i * 1.4, hx: 1.1, hz: 1.6, thick: 0.5, torch: true,
    });
  }
  const props = [
    // Timber sets down the drive: posts against the walls, a cap across the
    // roof line. The cap sits in the last 25 cm under the ceiling on purpose -
    // it is exactly the shape of the medieval boarding defect, so the span
    // audit has something real to be right about.
    ...[9, 14, 19, 24].flatMap((x) => ([
      { kind: 'timber', x, y: 1.35, z: -1.25, hx: 0.16, hy: 1.35, hz: 0.16 },
      { kind: 'timber', x, y: 1.35, z: 1.25, hx: 0.16, hy: 1.35, hz: 0.16 },
      { kind: 'timber', x, y: 2.58, z: 0, hx: 0.16, hy: 0.12, hz: 1.4 },
    ])),
    { kind: 'crate', x: 34.5, y: 2.2, z: -5.4, hx: 0.7, hy: 0.2, hz: 0.55 },
    { kind: 'crate', x: 35.8, y: 2.2, z: -5.9, hx: 0.6, hy: 0.2, hz: 0.5 },
    { kind: 'crate', x: 45.0, y: 2.2, z: 5.6, hx: 0.8, hy: 0.2, hz: 0.6 },
  ];
  const spots = [
    { x: 34.6, y: 2.55, z: -5.4, tier: 'common' },
    { x: 46.4, y: 2.6, z: 6.2, tier: 'rare' },
    // On the top ledge. R6 in reverse: the reward for the climb is on the
    // climb, and the reach audit is what proves a body can be there.
    { x: 45.3, y: 11.0, z: 11.0, tier: 'prize' },
  ];
  return normalisePlan({ id, label, kind: 'mine', origin, yaw, cells, mouths, stairs, ledges, props, spots });
}

/**
 * A karst cavern: a walk-in throat at grade, one large hall, and a chimney of
 * mantle ledges spiralling up to a sinkhole in the roof.
 *
 * The hall is 24 x 22 x 9 m, which is the shape the illuminance audit exists
 * for: no arrangement of wall sconces lights the middle of it, and the
 * brazier grid is what does.
 *
 * The exit is deliberately vertical. §5.2 gives the massif "sustained climb,
 * stamina" as its teaching verb, and ten 1.4 m mantles is 14.0 m of ascent
 * against the 29.3 m one stamina bar sustains - hard, not impossible - and
 * the free-climb faces are all box walls, so `|n.y|` is 0 on every one of
 * them and a player out of mantles can climb instead.
 */
export function planKarst({
  id = 'sunkenhall', label = 'The Sunken Hall', origin = { x: 0, y: 0, z: 0 }, yaw = 0,
} = {}) {
  const cells = [
    { id: 'throat', x0: 0, x1: 6, z0: -2.6, z1: 2.6, floor: 0, ceil: 3.4 },
    { id: 'hall', x0: 6, x1: 30, z0: -11, z1: 11, floor: 0, ceil: 9.0 },
    // A low side chamber, out of the daylight, where the prize sits.
    { id: 'vault', x0: 30, x1: 37, z0: -4, z1: 4, floor: 0, ceil: 3.0 },
    /* The chimney: a shaft standing on the hall's roof plane, so the hall's
     * ceiling is holed under it and the shaft has no floor of its own. It is
     * marked `shaft` because half its plan is that hole - the audit reports a
     * void fraction rather than treating a shaft as a room with a defect. */
    { id: 'chimney', x0: 23.0, x1: 29.4, z0: 3.2, z1: 8.0, floor: 9.0, ceil: 15.4, shaft: true },
  ];
  const mouths = [
    { id: 'throat', cell: 'throat', face: '-x', label: 'the throat', a0: -2.0, a1: 2.0, b0: 0, b1: 2.9 },
    {
      id: 'sinkhole', cell: 'chimney', face: '+y', label: 'the sinkhole',
      a0: 24.0, a1: 28.4, b0: 4.0, b1: 7.2,
    },
  ];
  /* The chimney climb: ten ledges 1.4 m apart, zig-zagged between two touching
   * columns for the reason `planMine` sets out at length - a body mantles from
   * the square beside a ledge, so consecutive ledges must touch, and the ledge
   * directly overhead must be the one two up so there is 2.25 m of air.
   *
   * Fourteen metres of ascent in mantles. One stamina bar sustains 29.3 m of
   * free climb, and the shaft walls are box faces so `|n.y|` is 0 on all of
   * them: a player who runs out of mantle can climb, which is §5.2's whole
   * point for the massif.
   *
   * The last four are inside the shaft, above the hall's roof plane. All of
   * them stand under the aperture, so the ceiling above every one of them is
   * sky. From the top ledge at 14.0 the rim is 15.4 + ROCK_T = 16.3, a 2.3 m
   * mantle - inside `Climb.MAX_RISE` 2.4 with 10 cm to spare, which is why the
   * shaft ceiling is 15.4 and not the 15.6 the first draft had.
   */
  const ledges = [];
  for (let i = 0; i < 10; i++) {
    ledges.push({
      cell: i < 6 ? 'hall' : 'chimney', x: i % 2 === 0 ? 25.1 : 27.3, z: 5.6,
      top: 1.4 + i * 1.4, hx: 1.1, hz: 1.6, thick: 0.55, torch: true,
    });
  }
  const props = [
    { kind: 'stalagmite', x: 12.0, y: 0.55, z: -7.0, hx: 0.7, hy: 0.55, hz: 0.7 },
    { kind: 'stalagmite', x: 15.5, y: 0.95, z: -8.4, hx: 0.9, hy: 0.95, hz: 0.9 },
    { kind: 'stalagmite', x: 10.5, y: 0.7, z: 6.5, hx: 0.8, hy: 0.7, hz: 0.8 },
    { kind: 'stalagmite', x: 18.0, y: 1.1, z: -9.6, hx: 1.0, hy: 1.1, hz: 1.0 },
    { kind: 'crate', x: 34.0, y: 0.2, z: 2.4, hx: 0.7, hy: 0.2, hz: 0.55 },
  ];
  const spots = [
    { x: 13.0, y: 0.6, z: 8.5, tier: 'common' },
    { x: 34.0, y: 0.55, z: 2.4, tier: 'prize' },
    // Two thirds of the way up the chimney, on the ledge at 9.8.
    { x: 25.1, y: 10.4, z: 5.6, tier: 'rare' },
  ];
  return normalisePlan({ id, label, kind: 'karst', origin, yaw, cells, mouths, ledges, props, spots });
}

/* ====================================================================== */
/* Building                                                               */
/* ====================================================================== */

const _v = new THREE.Vector3();
const _h = new THREE.Vector3();

/**
 * A minimal geometry accumulator with `CitadelWorld`'s `Batch.box` signature.
 *
 * Used only when the host world does not hand one in. When it does, the cave
 * merges into the world's own per-material buckets and costs no extra draw
 * call at all, which is the single biggest reason to keep this interface
 * shaped exactly like the one Citadel already has.
 */
export class CaveBatch {
  constructor() {
    this.buckets = new Map();
    this._owned = [];
  }

  box(key, w, h, d, x, y, z, rotY = 0, tint = null) {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rotY) g.rotateY(rotY);
    g.translate(x, y, z);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    const c = new THREE.Color(tint === null ? 0xffffff : tint);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    let list = this.buckets.get(key);
    if (!list) this.buckets.set(key, (list = []));
    list.push(g);
  }

  /** Merge each bucket into one mesh. @returns {THREE.Mesh[]} */
  flush(group, resolve, name = 'caves') {
    const out = [];
    for (const [key, list] of this.buckets) {
      if (!list.length) continue;
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
      for (const g of list) if (g !== merged) g.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, resolve(key));
      mesh.name = `${name}:${key}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      group.add(mesh);
      out.push(mesh);
      this._owned.push(merged);
    }
    this.buckets.clear();
    return out;
  }

  dispose() {
    for (const g of this._owned) g.dispose();
    this._owned.length = 0;
  }
}

/** Triangles and attribute bytes a batch is holding. For the cost report. */
export function batchCost(batch) {
  let tris = 0;
  let bytes = 0;
  for (const list of batch.buckets.values()) {
    for (const g of list) {
      const pos = g.attributes.position;
      tris += (g.index ? g.index.count : pos.count) / 3;
      for (const a of Object.values(g.attributes)) bytes += a.array.byteLength;
      if (g.index) bytes += g.index.array.byteLength;
    }
  }
  return { triangles: tris, bytes };
}

/**
 * Build one cave into a world.
 *
 * @param {{physics:object, group:THREE.Object3D, track?:(c:any)=>any,
 *          box?:(key:string,w:number,h:number,d:number,x:number,y:number,z:number,
 *                rotY?:number,tint?:number)=>void,
 *          mat?:(key:string)=>THREE.Material}} ctx
 *   `box` is `CitadelWorld`'s `Batch.box`; pass it and the cave joins the
 *   world's merge. Omit it and a private {@link CaveBatch} is used and
 *   flushed through `mat`.
 * @param {object} plan a plan from {@link planMine} / {@link planKarst}, or
 *   anything {@link normalisePlan} accepts.
 * @returns {{plan:object, colliders:Array, lights:THREE.PointLight[],
 *            enterable:object, batch:CaveBatch|null, meshes:THREE.Mesh[]}}
 */
export function buildCave(ctx, plan) {
  const p = plan.cellById ? plan : normalisePlan(plan);
  const ownBatch = ctx.box ? null : new CaveBatch();
  const box = ctx.box ?? ownBatch.box.bind(ownBatch);
  const track = ctx.track ?? ((c) => c);
  const colliders = [];

  /** Emit one axis-aligned-in-local-space solid: visual box plus collider. */
  const solid = (key, lx0, lx1, ly0, ly1, lz0, lz1, tint) => {
    const w = lx1 - lx0;
    const h = ly1 - ly0;
    const d = lz1 - lz0;
    if (w <= EPS || h <= EPS || d <= EPS) return;
    const c = toWorld(p, (lx0 + lx1) * 0.5, (ly0 + ly1) * 0.5, (lz0 + lz1) * 0.5);
    box(key, w, h, d, c.x, c.y, c.z, p.yaw, tint);
    colliders.push(track(ctx.physics.addRotatedBox(
      _v.set(c.x, c.y, c.z), _h.set(w * 0.5, h * 0.5, d * 0.5), p.yaw
    )));
  };

  /* --- The shell: every face of every cell, minus its neighbours and mouths --- */
  for (const cell of p.cells) {
    for (const face of FACES) {
      const F = FACE_AXES[face];
      const { rect, plane, holes } = faceHoles(p, cell, face);
      const n0 = F.s < 0 ? plane - ROCK_T : plane;
      const n1 = F.s < 0 ? plane : plane + ROCK_T;
      const key = face === '-y' ? MAT.floor : MAT.rock;
      const tint = face === '-y' ? 0xb9a988 : face === '+y' ? 0x8d8172 : 0xa79a86;
      for (const r of subtractRects(rect, holes)) {
        const lo = { [F.n]: n0, [F.a]: r.a0, [F.b]: r.b0 };
        const hi = { [F.n]: n1, [F.a]: r.a1, [F.b]: r.b1 };
        solid(key, lo.x, hi.x, lo.y, hi.y, lo.z, hi.z, tint);
      }
    }
  }

  /* --- Stairs: individual risers, every one inside `stepHeight` --- */
  for (const s of p.stairs) {
    const steps = Math.max(1, Math.round((s.to.y - s.from.y) / (s.rise ?? STEP_MAX)));
    const rise = (s.to.y - s.from.y) / steps;
    const half = s.width * 0.5;
    if (s.axis === 'x') {
      const run = (s.to.x - s.from.x) / steps;
      for (let i = 0; i < steps; i++) {
        const x0 = s.from.x + run * i;
        const y1 = s.from.y + rise * (i + 1);
        // Each tread is a box from the cell floor up, so nothing is floating.
        solid(MAT.floor, x0, s.to.x, s.from.y - 0.4, y1, s.z - half, s.z + half, 0xb0a087);
      }
    } else {
      const run = (s.to.z - s.from.z) / steps;
      for (let i = 0; i < steps; i++) {
        const z0 = s.from.z + run * i;
        const y1 = s.from.y + rise * (i + 1);
        solid(MAT.floor, s.x - half, s.x + half, s.from.y - 0.4, y1, z0, s.to.z, 0xb0a087);
      }
    }
  }

  /* --- Mantle ledges --- */
  for (const l of p.ledges) {
    solid(MAT.rock, l.x - l.hx, l.x + l.hx, l.top - (l.thick ?? 0.5), l.top,
      l.z - l.hz, l.z + l.hz, 0x9d907c);
  }

  /* --- Props --- */
  for (const s of p.props) {
    const key = s.kind === 'timber' || s.kind === 'crate' ? MAT.timber : MAT.rock;
    const tint = s.kind === 'timber' ? 0x8a6a45 : s.kind === 'crate' ? 0x9a7c52 : 0xa3977f;
    solid(key, s.x - s.hx, s.x + s.hx, s.y - s.hy, s.y + s.hy, s.z - s.hz, s.z + s.hz, tint);
  }

  /* --- Lights ------------------------------------------------------------
   * Created HIDDEN by `pointLight`, and this file is where that rule was first
   * written down: the frame between creation and `LightRig`'s next walk is a
   * frame in which a light counts for Three's program cache key, and one such
   * frame is a full recompile. It is a property of the constructor now - see
   * gfx/WorldLight.js - rather than a line each of sixty-four sites had to
   * remember. */
  const lights = [];
  for (const l of p.lights) {
    const spec = lightSpec(l.kind);
    const light = pointLight(spec.colour, spec.intensity, spec.range, 2);
    light.name = `cave:${p.id}:${l.kind}`;
    light.position.set(l.position.x, l.position.y, l.position.z);
    ctx.group.add(light);
    lights.push(light);
    /* The fitting the light comes out of, and the reason there are three
     * cases. A wall bracket hangs at 1.98 m, which clears the 1.8 m a body
     * needs by 18 cm. A brazier is a fire PIT 0.4 m tall, not a stand: a stand
     * tall enough to look right tops out in the 0.45 - 1.0 m band a body has
     * no verb for, and the step audit says so. A ledge torch has no fitting at
     * all - see `planLights`. */
    if (l.fitting === 'sconce') {
      solid(MAT.timber, l.x - 0.18, l.x + 0.18, l.y - 0.22, l.y + 0.08,
        l.z - 0.18, l.z + 0.18, 0x6a5136);
    } else if (l.fitting === 'pit') {
      solid(MAT.rock, l.x - 0.45, l.x + 0.45, l.base, l.base + 0.35,
        l.z - 0.45, l.z + 0.45, 0x6d6357);
    }
  }

  let meshes = [];
  if (ownBatch) {
    const resolve = ctx.mat ?? fallbackMaterial;
    meshes = ownBatch.flush(ctx.group, resolve, `caves:${p.id}`);
  }

  /**
   * The doorless `Interiors` descriptor.
   *
   * `Interiors._onWorld` reads `e.doors || []`, `e.lifts || []` and
   * `e.collectibleSpots`, so a descriptor that is a label, an origin and a
   * list of spots is a complete one - and it buys the whole streaming path
   * for a cave with a hole in a cliff instead of a door.
   * `medieval/Treasures.js:556-606` is the precedent.
   */
  const enterable = {
    label: p.label,
    origin: new THREE.Vector3(p.origin.x, p.origin.y, p.origin.z),
    doors: [],
    collectibleSpots: p.spots.map((s) => ({
      position: new THREE.Vector3(s.position.x, s.position.y, s.position.z),
      tier: s.tier ?? 'common',
    })),
    cave: {
      id: p.id, kind: p.kind,
      mouths: p.mouths.map((m) => ({
        id: m.id, label: m.label ?? m.id, face: m.face,
        position: new THREE.Vector3(m.position.x, m.position.y, m.position.z),
      })),
    },
  };

  return { plan: p, colliders, lights, enterable, batch: ownBatch, meshes };
}

/** Build a set of caves and return everything a world has to publish. */
export function buildCaveSystem(ctx, plans) {
  const out = { caves: [], colliders: [], lights: [], enterables: [] };
  for (const plan of plans) {
    const c = buildCave(ctx, plan);
    out.caves.push(c);
    out.colliders.push(...c.colliders);
    out.lights.push(...c.lights);
    out.enterables.push(c.enterable);
  }
  return out;
}

let _fallbackMats = null;
/** Flat stand-in palette, so the kit builds with no host materials at all. */
function fallbackMaterial(key) {
  if (!_fallbackMats) {
    _fallbackMats = {
      [MAT.rock]: new THREE.MeshStandardMaterial({ color: 0x8e8676, roughness: 0.97, vertexColors: true }),
      [MAT.floor]: new THREE.MeshStandardMaterial({ color: 0x9a8f78, roughness: 0.95, vertexColors: true }),
      [MAT.timber]: new THREE.MeshStandardMaterial({ color: 0x6b5030, roughness: 0.85, vertexColors: true }),
    };
  }
  return _fallbackMats[key] ?? _fallbackMats[MAT.rock];
}

/**
 * The Citadel ring's authored caves.
 *
 * Anchors are the caller's business: §5.2 puts the Quarry & Deepworks and the
 * karst massif out in the new ring, and the world that lays those regions out
 * owns where they are. The defaults here are the sites this kit's suite found
 * by search near `CITADEL_LANDFORMS`' quarry (325, -96) and massif (-40, -326)
 * anchors, and they are a starting point, not an answer.
 *
 * **A caller must finish the placement.** Every `origin.y` here is 0, which is
 * the desert datum and NOT where these caves go: on the terrain as it stands
 * the quarry cave wants y = 26.2 and the massif cave y = 31.1. Run
 * {@link liftToClear} against the built physics to get that number, and
 * {@link auditVacancy} to confirm the space is empty, before building - in
 * that order. Skipping the lift buries the cave in the hillside; skipping the
 * vacancy check builds it around somebody else's gantries, and the first thing
 * either mistake does is pass every audit that is not looking for it.
 */
export function citadelCaves(anchors = {}) {
  const quarry = anchors.quarry ?? { x: 267, y: 0, z: -80 };
  const deepworks = anchors.deepworks ?? { x: 300, y: 0, z: -160 };
  const massif = anchors.massif ?? { x: -50, y: 0, z: -290 };
  const eyrie = anchors.eyrie ?? { x: -110, y: 0, z: -350 };
  return [
    planMine({ id: 'quarry-adit', label: 'The Quarry Adit', origin: quarry, yaw: 5.50 }),
    planMine({ id: 'deepworks', label: 'The Deepworks', origin: deepworks, yaw: -1.15 }),
    planKarst({ id: 'sunken-hall', label: 'The Sunken Hall', origin: massif, yaw: 0 }),
    planKarst({ id: 'eyrie-undercroft', label: 'The Eyrie Undercroft', origin: eyrie, yaw: 2.4 }),
  ];
}

/* ====================================================================== */
/* The audit: everything below asks the WORLD, not the builder            */
/* ====================================================================== */

/**
 * A point-in-solid oracle over a finished collider set.
 *
 * Deliberately built from `physics.colliders` and nothing else. It does not
 * know a plan exists, it has never seen the builder, and it cannot be fooled
 * by a wall that was emitted and then removed - which is the exact failure
 * `MazeShafts` shipped and the reason this class is not a convenience.
 *
 * Boxes are indexed on an XZ grid and stored with their Y-rotation read out of
 * the matrix axes rather than as a remembered angle, so a world that starts
 * composing rotations gets measured rather than mis-measured. Heightfields are
 * kept apart: they are solid from their surface down to `baseY`, they cover
 * the whole map, and putting them in the grid would put them in every cell.
 */
export class SolidField {
  /**
   * @param {Iterable<object>} colliders normally `physics.colliders`
   * @param {{cell?:number, layer?:number}} [opts]
   */
  constructor(colliders, opts = {}) {
    this.cell = opts.cell ?? 8;
    this.layerMask = opts.layer ?? 1; // COLLISION_LAYER.WORLD
    /** @type {Map<number, object[]>} */
    this.grid = new Map();
    /** @type {object[]} */
    this.boxes = [];
    /** @type {object[]} */
    this.fields = [];
    /** Colliders this index cannot represent. Assert this empty. */
    this.unhandled = [];

    for (const c of colliders) {
      if (!c || c.solid === false) continue;
      if ((c.layer & this.layerMask) === 0) continue;
      if (c.type === 'heightfield') { this.fields.push(c); continue; }
      if (c.type !== 'box') { this.unhandled.push(c); continue; }
      const m = c.matrix.elements;
      const cos = m[0];
      const sin = -m[2];
      const b = {
        col: c, x: m[12], y: m[13], z: m[14],
        hx: c.halfExtents.x, hy: c.halfExtents.y, hz: c.halfExtents.z,
        cos, sin,
        top: m[13] + c.halfExtents.y,
        bot: m[13] - c.halfExtents.y,
      };
      b.ax = Math.abs(cos) * b.hx + Math.abs(sin) * b.hz;
      b.az = Math.abs(sin) * b.hx + Math.abs(cos) * b.hz;
      this.boxes.push(b);
      this._insert(b);
    }
  }

  _key(cx, cz) { return ((cx + 8192) * 65536) + (cz + 8192); }

  _insert(b) {
    const x0 = Math.floor((b.x - b.ax) / this.cell);
    const x1 = Math.floor((b.x + b.ax) / this.cell);
    const z0 = Math.floor((b.z - b.az) / this.cell);
    const z1 = Math.floor((b.z + b.az) / this.cell);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = this._key(cx, cz);
        let list = this.grid.get(k);
        if (!list) this.grid.set(k, (list = []));
        list.push(b);
      }
    }
  }

  /** Boxes whose footprint could contain this column. */
  candidates(x, z) {
    return this.grid.get(this._key(Math.floor(x / this.cell), Math.floor(z / this.cell))) ?? EMPTY_LIST;
  }

  /** Does this box contain the point? */
  static inside(b, x, y, z) {
    if (y > b.top || y < b.bot) return false;
    const dx = x - b.x;
    const dz = z - b.z;
    const lx = dx * b.cos - dz * b.sin;
    const lz = dx * b.sin + dz * b.cos;
    return Math.abs(lx) <= b.hx && Math.abs(lz) <= b.hz;
  }

  /** Terrain surface here, or null where no heightfield reaches. */
  terrainAt(x, z) {
    let best = null;
    for (const f of this.fields) {
      if (!f.containsColumn(x, z)) continue;
      const h = f.sampleHeight(x, z);
      if (h !== null && (best === null || h > best)) best = h;
    }
    return best;
  }

  /**
   * Is this point inside anything solid? Mirrors `Physics.containsPoint`,
   * including the heightfield's "solid from the surface down to `baseY`" rule,
   * which is the rule the module header is about.
   */
  solidAt(x, y, z) {
    for (const f of this.fields) {
      if (!f.containsColumn(x, z)) continue;
      const h = f.sampleHeight(x, z);
      if (h !== null && y < h && y > f.baseY) return true;
    }
    for (const b of this.candidates(x, z)) if (SolidField.inside(b, x, y, z)) return true;
    return false;
  }

  /**
   * Every merged solid interval standing over a column, ascending.
   *
   * Merged at 2 cm, for the reason the reach suite gives: a chamber wall, its
   * floor slab and a step box overlapping by a millimetre are one solid to a
   * body and three intervals to a naive scan, and two of those three are
   * inside the masonry.
   */
  column(x, z) {
    const raw = [];
    for (const f of this.fields) {
      if (!f.containsColumn(x, z)) continue;
      const h = f.sampleHeight(x, z);
      if (h !== null) raw.push({ bot: f.baseY, top: h });
    }
    for (const b of this.candidates(x, z)) {
      const dx = x - b.x;
      const dz = z - b.z;
      const lx = dx * b.cos - dz * b.sin;
      const lz = dx * b.sin + dz * b.cos;
      if (Math.abs(lx) > b.hx || Math.abs(lz) > b.hz) continue;
      raw.push({ bot: b.bot, top: b.top });
    }
    raw.sort((a, b) => a.bot - b.bot);
    const merged = [];
    for (const iv of raw) {
      const last = merged[merged.length - 1];
      if (last && iv.bot <= last.top + 0.02) { if (iv.top > last.top) last.top = iv.top; }
      else merged.push({ bot: iv.bot, top: iv.top });
    }
    return merged;
  }
}

const EMPTY_LIST = [];

/* ---------------------------------------------------------------------- */

/** Sample centres across `[lo, hi]` at about `step`, inset half a step. */
function lattice(lo, hi, step) {
  const n = Math.max(1, Math.round((hi - lo) / step));
  const s = (hi - lo) / n;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = lo + s * (i + 0.5);
  return out;
}

/**
 * AUDIT 0 - grounded.
 *
 * A `Physics` heightfield is solid from its surface down to `baseY`, so any
 * cave air below the terrain surface is inside solid terrain and the player is
 * shoved up out of it. This is the first audit because every other one is
 * vacuous if it fails: a perfectly sealed, perfectly lit chamber buried inside
 * a hillside passes seal, clearance, steps and reach and is unenterable.
 *
 * @returns {{samples:number, buried:number, worst:number, worstAt:object|null}}
 *   `worst` is the deepest the terrain rises above a cell floor, in metres.
 */
export function auditGrounding(plan, field, step = FLOOR_STEP) {
  let samples = 0;
  let buried = 0;
  let worst = -Infinity;
  let worstAt = null;
  for (const c of plan.cells) {
    for (const lx of lattice(c.x0, c.x1, step)) {
      for (const lz of lattice(c.z0, c.z1, step)) {
        const w = toWorld(plan, lx, 0, lz);
        const h = field.terrainAt(w.x, w.z);
        samples++;
        if (h === null) continue;
        const intrusion = h - (plan.origin.y + c.floor);
        if (intrusion > worst) { worst = intrusion; worstAt = { cell: c.id, x: w.x, z: w.z }; }
        if (intrusion > 0.02) buried++;
      }
    }
  }
  return { samples, buried, worst: worst === -Infinity ? 0 : worst, worstAt };
}

/**
 * AUDIT 1 - sealed, with exactly the intended openings.
 *
 * Walks the boundary of the air volume face by face at {@link SEAL_STEP} and
 * asks the world what is on the far side. Three outcomes per sample:
 *
 *   - the far side is another cell's air: an interior face, skipped.
 *   - the sample falls inside a declared mouth: it must be OPEN, and open all
 *     the way through the shell. A mouth that got walled up is a cave with no
 *     exit, and it fails here rather than in a play session.
 *   - anything else: it must be SOLID. This is the leak test.
 *
 * The probe sits 6 cm outside the air, not in the middle of the slab, because
 * 6 cm outside is where a body would be if the slab were gone. The mouth
 * probe additionally reaches `ROCK_T + 0.3` out, because a mouth blocked by a
 * shutter 50 cm thick is not a mouth.
 *
 * @returns {{samples:number, leaks:Array, blockedMouths:Array,
 *            open:number, byMouth:Map<string,{open:number,total:number}>}}
 */
export function auditSeal(plan, field, step = SEAL_STEP) {
  const leaks = [];
  const blockedMouths = [];
  const byMouth = new Map();
  for (const m of plan.mouths) byMouth.set(m.id, { open: 0, total: 0 });
  let samples = 0;
  let open = 0;

  for (const cell of plan.cells) {
    for (const face of FACES) {
      const F = FACE_AXES[face];
      const { rect, plane } = faceHoles(plan, cell, face);
      const mouths = plan.mouths.filter((m) => m.cell === cell.id && m.face === face);
      for (const a of lattice(rect.a0, rect.a1, step)) {
        for (const b of lattice(rect.b0, rect.b1, step)) {
          // Just outside the air, along the face normal.
          const probe = {};
          probe[F.n] = plane + F.s * 0.06;
          probe[F.a] = a;
          probe[F.b] = b;
          // Shared with a neighbouring cell? Then it is not boundary at all.
          if (cellAt(plan, probe.x ?? 0, probe.y ?? 0, probe.z ?? 0, 0)) continue;
          samples++;
          const w = toWorld(plan, probe.x, probe.y, probe.z);
          const solid = field.solidAt(w.x, w.y, w.z);

          const mouth = mouths.find((m) => a > m.a0 && a < m.a1 && b > m.b0 && b < m.b1);
          if (mouth) {
            const rec = byMouth.get(mouth.id);
            rec.total++;
            const deep = {};
            deep[F.n] = plane + F.s * (ROCK_T + 0.3);
            deep[F.a] = a;
            deep[F.b] = b;
            const dw = toWorld(plan, deep.x, deep.y, deep.z);
            const through = !solid && !field.solidAt(dw.x, dw.y, dw.z);
            if (through) { rec.open++; open++; }
            else blockedMouths.push({ mouth: mouth.id, cell: cell.id, face, x: w.x, y: w.y, z: w.z });
            continue;
          }
          if (!solid) leaks.push({ cell: cell.id, face, x: w.x, y: w.y, z: w.z });
        }
      }
    }
  }
  return { samples, leaks, blockedMouths, open, byMouth };
}

/**
 * The walkable lattice, one node per (column, standable level).
 *
 * Nodes, not squares, because a cave is not a floor plan: the column under the
 * karst chimney holds the hall floor at 0 and five mantle ledges above it, and
 * a model that keeps one height per column either loses the floor or loses the
 * climb. Every interval top that (a) falls inside some cell's y range and
 * (b) has {@link HEADROOM} of clear air over it is a node.
 *
 * Everything the reach, step and illuminance audits say is said about this
 * structure, and it is derived entirely from {@link SolidField}.
 *
 * `lowhead` is the interesting by-product: a column whose CELL FLOOR is
 * standable but has less than 1.8 m over it. That is the shape of the medieval
 * boarding defect - the physics was clear, you just could not walk there - and
 * it is counted per cell rather than merged into "not walkable".
 */
export function walkGraph(plan, field, step = FLOOR_STEP) {
  const nodes = [];
  /** @type {Map<string, number[]>} column key -> node indices */
  const columns = new Map();
  const stats = new Map();
  for (const c of plan.cells) {
    stats.set(c.id, { cell: c, samples: 0, walkable: 0, lowhead: 0, blocked: 0, void: 0, covered: 0 });
  }

  // One lattice over the union, so a column shared by two cells is sampled once.
  let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
  for (const c of plan.cells) {
    minX = Math.min(minX, c.x0); maxX = Math.max(maxX, c.x1);
    minZ = Math.min(minZ, c.z0); maxZ = Math.max(maxZ, c.z1);
  }
  const xs = lattice(minX, maxX, step);
  const zs = lattice(minZ, maxZ, step);

  for (let i = 0; i < xs.length; i++) {
    for (let j = 0; j < zs.length; j++) {
      const lx = xs[i];
      const lz = zs[j];
      const here = plan.cells.filter((c) => lx > c.x0 && lx < c.x1 && lz > c.z0 && lz < c.z1);
      if (!here.length) continue;
      const w = toWorld(plan, lx, 0, lz);
      const col = field.column(w.x, w.z);
      const key = `${i}|${j}`;
      const list = [];
      for (const c of here) {
        const st = stats.get(c.id);
        st.samples++;
        const lo = plan.origin.y + c.floor - 0.05;
        const hi = plan.origin.y + c.ceil - 0.01;
        /* EVERY level in the column, not the highest one.
         *
         * The first draft took the highest and the karst chimney fell apart:
         * a column through the ledge stack holds the hall floor and five
         * ledges, and keeping only the top one leaves each ledge a private
         * island with a 7 m drop round it. The reach audit said "four
         * components" and was right. A cave is not a floor plan.
         */
        const levels = [];
        for (let k = 0; k < col.length; k++) {
          const top = col[k].top;
          if (top > hi || top < lo) continue;
          const above = col[k + 1];
          levels.push({ top, head: above ? above.bot - top : Infinity });
        }
        if (!levels.length) { st.void++; continue; }
        // The cell's own floor level is what the fractions are about: whether
        // a body can WALK the room. Ledges and crates are counted as nodes but
        // never as the room's floor.
        const ground = levels[0];
        if (ground.top > plan.origin.y + c.floor + STEP_MAX) st.blocked++;
        else if (ground.head < HEADROOM) st.lowhead++;
        else st.walkable++;
        let any = false;
        for (const lv of levels) {
          if (lv.head < HEADROOM) continue;
          any = true;
          if (list.some((n) => Math.abs(nodes[n].y - lv.top) < 0.02)) continue;
          list.push(nodes.length);
          nodes.push({
            i, j, lx, lz, x: w.x, z: w.z, y: lv.top, head: lv.head, cell: c.id,
          });
        }
        if (any) st.covered++;
      }
      if (list.length) columns.set(key, list);
    }
  }

  const out = { nodes, columns, stats, step, xs, zs };
  out.fractions = new Map();
  for (const [id, s] of stats) {
    const n = Math.max(1, s.samples);
    out.fractions.set(id, {
      /** The cell's own floor plane is standable with 1.8 m over it. */
      walkable: s.walkable / n,
      /** Standable floor, head blocked. The medieval boarding symptom. */
      lowhead: s.lowhead / n,
      /** The floor plane is occupied - a stair flight, a ledge, a fire pit. */
      blocked: s.blocked / n,
      /** No surface at all in the cell's range: a shaft over a lower room. */
      void: s.void / n,
      /** Columns with SOME walkable level. A stair bay is 0.30 walkable and
       *  1.00 covered, and `covered` is the one that means "you can be here". */
      covered: s.covered / n,
      samples: s.samples,
    });
  }
  return out;
}

/**
 * AUDIT 2 + 3 - legal steps between adjacent walkable nodes.
 *
 * An edge exists between neighbouring columns only when a body can go BOTH
 * ways: up by a walk (<= `stepHeight`) or by a mantle (`Climb` 1.0 - 2.4 m),
 * and down by the same. Anything in the 0.45 - 1.0 m band is the gap between
 * the two verbs and is reported as illegal; anything over 2.4 m is a drop, not
 * a step, and is reported as one with its height so nothing inside a cave can
 * quietly become a lethal fall.
 *
 * @returns {{edges:Array, illegal:Array, drops:Array, maxDrop:number,
 *            walk:number, mantle:number}}
 */
export function auditSteps(graph) {
  const edges = [];
  const illegal = [];
  const drops = [];
  let walk = 0;
  let mantle = 0;
  let maxDrop = 0;
  const key = (i, j) => `${i}|${j}`;
  for (const [k, list] of graph.columns) {
    const [i, j] = k.split('|').map(Number);
    for (const [di, dj] of [[1, 0], [0, 1]]) {
      const other = graph.columns.get(key(i + di, j + dj));
      if (!other) continue;
      for (const a of list) {
        for (const b of other) {
          const A = graph.nodes[a];
          const B = graph.nodes[b];
          const dy = Math.abs(A.y - B.y);
          if (dy <= STEP_MAX + 1e-6) { edges.push([a, b]); walk++; continue; }
          if (dy >= MANTLE_MIN - 1e-6 && dy <= MANTLE_MAX + 1e-6) { edges.push([a, b]); mantle++; continue; }
          if (dy < MANTLE_MIN) { illegal.push({ a: A, b: B, dy }); continue; }
          drops.push({ a: A, b: B, dy });
          if (dy > maxDrop) maxDrop = dy;
        }
      }
    }
  }
  return { edges, illegal, drops, maxDrop, walk, mantle };
}

/**
 * AUDIT 4 - one component, containing every mouth and every collectible.
 *
 * This is R6 written for a cave. The medieval expansion shipped four defects
 * that every existing test passed because every existing test asked whether a
 * thing had been built; a thing built inside a sealed room is still built.
 *
 * Each mouth is resolved to the walkable node nearest its aperture on the
 * inside, and each spot to the node nearest it in 3D. Both distances are
 * returned, because "the nearest walkable node to this prize is 6 m away and
 * 4 m below it" is a defect that a boolean would hide.
 *
 * @returns {{components:number, largest:number, mouths:Array, spots:Array,
 *            connected:boolean}}
 */
export function auditReach(plan, graph, steps) {
  const n = graph.nodes.length;
  const adj = Array.from({ length: n }, () => []);
  for (const [a, b] of steps.edges) { adj[a].push(b); adj[b].push(a); }

  const comp = new Int32Array(n).fill(-1);
  let components = 0;
  let largest = 0;
  const stack = [];
  for (let s = 0; s < n; s++) {
    if (comp[s] !== -1) continue;
    let size = 0;
    comp[s] = components;
    stack.push(s);
    while (stack.length) {
      const v = stack.pop();
      size++;
      for (const w of adj[v]) if (comp[w] === -1) { comp[w] = components; stack.push(w); }
    }
    if (size > largest) largest = size;
    components++;
  }

  const nearest = (x, y, z) => {
    let best = -1;
    let bd = Infinity;
    for (let k = 0; k < n; k++) {
      const nd = graph.nodes[k];
      const d = (nd.x - x) ** 2 + (nd.y - y) ** 2 + (nd.z - z) ** 2;
      if (d < bd) { bd = d; best = k; }
    }
    return { node: best, dist: Math.sqrt(bd) };
  };

  const mouths = plan.mouths.map((m) => {
    const F = FACE_AXES[m.face];
    // A step INSIDE the aperture, so a roof mouth resolves to the ledge under
    // it rather than to the sky above it.
    const inside = { ...m.local };
    inside[F.n] = m.plane - F.s * 0.6;
    if (F.n === 'y' && F.s > 0) inside.y = m.plane - 2.0;
    const w = toWorld(plan, inside.x, inside.y, inside.z);
    const r = nearest(w.x, w.y, w.z);
    return { id: m.id, ...r, comp: r.node >= 0 ? comp[r.node] : -1 };
  });
  const spots = plan.spots.map((s, k) => {
    const r = nearest(s.position.x, s.position.y, s.position.z);
    return { index: k, tier: s.tier, ...r, comp: r.node >= 0 ? comp[r.node] : -1 };
  });

  const ids = new Set([...mouths, ...spots].map((e) => e.comp));
  return { components, largest, mouths, spots, connected: ids.size === 1 && !ids.has(-1), comp };
}

/**
 * AUDIT 5 - illuminance on the floor plane, through the rig's slot budget.
 *
 * Three's own point-light falloff: `intensity / d^2`, windowed exactly as
 * `getDistanceAttenuation` windows it, times the cosine of incidence on a
 * horizontal plane, summed over the lights that reach the sample - but only
 * the best {@link LIGHT_SLOTS} of them, because that is how many the rig can
 * put in the scene at once and a number computed over two hundred is a number
 * about a game nobody is playing.
 *
 * ── What it is not ────────────────────────────────────────────────────────
 * It knows nothing about albedo, texture or what stands between the lamp and
 * the floor. A cave can score well here and still read as a black box; the
 * medieval interiors did exactly that, twice. {@link auditSpans} and the
 * `lowhead` count in {@link walkGraph} are the other half of the answer, and
 * neither half alone would have found that defect.
 *
 * Reported as the WORST walkable square, then the median, then the mean. The
 * mean is the number that hid the problem last time.
 *
 * @returns {{min:number, p10:number, median:number, mean:number, samples:number,
 *            worst:object|null}}
 */
export function floorIlluminance(graph, lights, opts = {}) {
  const slots = opts.slots ?? LIGHT_SLOTS;
  const vals = [];
  let worst = null;
  let min = Infinity;
  const contrib = [];
  for (const node of graph.nodes) {
    contrib.length = 0;
    for (const l of lights) {
      const dy = l.position.y - node.y;
      if (dy <= 0.05) continue; // a lamp at or below the floor lights nothing on it
      const d = Math.hypot(l.position.x - node.x, dy, l.position.z - node.z);
      if (d < 1e-3) continue;
      const dist = l.distance || 0;
      const win = dist > 0 ? Math.max(0, 1 - Math.min(1, (d / dist) ** 4)) : 1;
      const e = (l.intensity / (d * d)) * win * win * (dy / d);
      if (e > 0) contrib.push({ e, d });
    }
    // The rig ranks by what reaches the camera; standing here, that is here.
    contrib.sort((a, b) => a.d - b.d);
    let sum = 0;
    for (let k = 0; k < contrib.length && k < slots; k++) sum += contrib[k].e;
    vals.push(sum);
    if (sum < min) { min = sum; worst = node; }
  }
  if (!vals.length) return { min: 0, p10: 0, median: 0, mean: 0, samples: 0, worst: null };
  const sorted = [...vals].sort((a, b) => a - b);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return {
    min: sorted[0],
    p10: sorted[Math.floor(sorted.length * 0.1)],
    median: sorted[sorted.length >> 1],
    mean, samples: vals.length, worst,
  };
}

/**
 * AUDIT 5b - room-spanning GEOMETRY, which is not a lighting problem.
 *
 * `_shell` dressed medieval plank walls in six courses of horizontal boarding
 * and each course was one solid box the size of the building. On a shed that
 * is invisible. On a hall it is a 1.66 m crawlspace whose real ceiling is
 * walled off behind three slabs of the darkest material in the palette, and
 * every clearance test in the repo passed it because the boarding had no
 * collider. Three rounds of lighting work went into that room.
 *
 * So: anything that spans a serious share of a cell's plan and both starts and
 * stops between its floor and its ceiling is in the room with you. A roof, a
 * chimney or a wall also spans the plan and also dips below the ceiling, but
 * it carries on up and out; the test is that the slab is wholly inside.
 *
 * Measured against `SolidField`'s indexed boxes - the world's colliders - and
 * conservatively, using each box's axis-aligned footprint, which can only
 * over-report. Visual-only dressing with no collider is invisible here and is
 * the one hole in this audit; the kit emits nothing of the kind, and a world
 * that adds some has to bring its own probe.
 *
 * @returns {Array<{cell:string, coverage:number, y0:number, y1:number}>}
 */
export function auditSpans(plan, field, share = 0.4) {
  const out = [];
  const cos = Math.cos(plan.yaw);
  const sin = Math.sin(plan.yaw);
  const toLocal = (x, y, z) => {
    const dx = x - plan.origin.x;
    const dz = z - plan.origin.z;
    return { x: dx * cos - dz * sin, y: y - plan.origin.y, z: dx * sin + dz * cos };
  };
  for (const c of plan.cells) {
    const area = (c.x1 - c.x0) * (c.z1 - c.z0);
    const seen = new Set();
    for (const lx of lattice(c.x0, c.x1, 4)) {
      for (const lz of lattice(c.z0, c.z1, 4)) {
        const w = toWorld(plan, lx, 0, lz);
        for (const b of field.candidates(w.x, w.z)) {
          if (seen.has(b)) continue;
          seen.add(b);
          const lo = toLocal(b.x, b.bot, b.z);
          const hi = toLocal(b.x, b.top, b.z);
          if (lo.y <= c.floor + 0.15) continue;   // the floor, or under it
          if (lo.y >= c.ceil - 0.06) continue;    // the ceiling, or over it
          if (hi.y >= c.ceil) continue;           // goes up and out: a wall
          // Axis-aligned footprint in local space. Conservative on purpose.
          const ax = Math.abs(b.cos * cos + b.sin * sin) * b.hx
            + Math.abs(b.sin * cos - b.cos * sin) * b.hz;
          const az = Math.abs(b.sin * cos - b.cos * sin) * b.hx
            + Math.abs(b.cos * cos + b.sin * sin) * b.hz;
          const ox = Math.min(c.x1, lo.x + ax) - Math.max(c.x0, lo.x - ax);
          const oz = Math.min(c.z1, lo.z + az) - Math.max(c.z0, lo.z - az);
          if (ox <= 0 || oz <= 0) continue;
          const coverage = (ox * oz) / area;
          if (coverage < share) continue;
          out.push({ cell: c.id, coverage, y0: lo.y - c.floor, y1: hi.y - c.floor });
        }
      }
    }
  }
  return out;
}

/**
 * Run every audit against a finished world and return one report.
 *
 * Order matters: grounding first, because everything after it is meaningless
 * if the cave is buried in terrain, and the report says so rather than
 * quietly reporting five green numbers about a chamber nobody can enter.
 *
 * @param {object} plan a normalised plan
 * @param {SolidField} field built from the FINAL collider set
 * @param {THREE.PointLight[]} lights the cave's lights
 */
export function auditCave(plan, field, lights = []) {
  const grounding = auditGrounding(plan, field);
  const seal = auditSeal(plan, field);
  const graph = walkGraph(plan, field);
  const steps = auditSteps(graph);
  const reach = auditReach(plan, graph, steps);
  const light = floorIlluminance(graph, lights);
  const spans = auditSpans(plan, field);
  return {
    id: plan.id, label: plan.label, kind: plan.kind,
    grounding, seal, graph, steps, reach, light, spans,
    ok: grounding.buried === 0 && seal.leaks.length === 0
      && seal.blockedMouths.length === 0 && steps.illegal.length === 0
      && reach.connected && spans.length === 0,
  };
}

/**
 * The tuple Three pushes into `getProgramCacheKey`.
 *
 * `WebGLRenderer.projectObject` skips an object AND ITS SUBTREE when
 * `visible === false`, which `Object3D.traverse` does not, so this walk
 * reproduces the skip rather than the traverse. The counts it returns are
 * exactly the ones the GLSL preprocessor unrolls the lighting loops against:
 * hold them constant and no new program is compiled, whatever else changes.
 *
 * This is how the "200 torches cost zero new shader programs" claim gets
 * measured instead of repeated.
 */
export function lightSignature(scene) {
  const s = { dir: 0, point: 0, spot: 0, hemi: 0, ambient: 0, rectArea: 0, dirShadow: 0, pointShadow: 0, spotShadow: 0 };
  const walk = (o) => {
    if (o.visible === false) return;
    if (o.isLight) {
      if (o.isAmbientLight) s.ambient++;
      else if (o.isHemisphereLight) s.hemi++;
      else if (o.isDirectionalLight) { s.dir++; if (o.castShadow) s.dirShadow++; }
      else if (o.isPointLight) { s.point++; if (o.castShadow) s.pointShadow++; }
      else if (o.isSpotLight) { s.spot++; if (o.castShadow) s.spotShadow++; }
      else if (o.isRectAreaLight) s.rectArea++;
    }
    for (const c of o.children) walk(c);
  };
  walk(scene);
  s.key = `d${s.dir}p${s.point}s${s.spot}h${s.hemi}a${s.ambient}r${s.rectArea}`
    + `/ds${s.dirShadow}ps${s.pointShadow}ss${s.spotShadow}`;
  return s;
}

/**
 * What the terrain does under a cave's footprint.
 *
 * The one measurement a world needs before it can put a cave anywhere. `lo`
 * and `hi` are the terrain surface under the plan's own cells; `relief` is the
 * difference, and it is the number that decides whether a site is usable at
 * all - a cave floor is one plane per cell, so a site with 20 m of relief
 * under it wants a different cave, not a taller plinth.
 *
 * @returns {{lo:number, hi:number, relief:number, covered:number, samples:number}}
 *   `covered` is the share of samples any heightfield reaches at all; 0 means
 *   the site is off the terrain sheet and the answer says nothing.
 */
export function terrainProfile(plan, field, step = FLOOR_STEP) {
  let lo = Infinity;
  let hi = -Infinity;
  let covered = 0;
  let samples = 0;
  for (const c of plan.cells) {
    for (const lx of lattice(c.x0, c.x1, step)) {
      for (const lz of lattice(c.z0, c.z1, step)) {
        const w = toWorld(plan, lx, 0, lz);
        samples++;
        const h = field.terrainAt(w.x, w.z);
        if (h === null) continue;
        covered++;
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
  }
  if (!covered) return { lo: 0, hi: 0, relief: 0, covered: 0, samples };
  return { lo, hi, relief: hi - lo, covered: covered / samples, samples };
}

/**
 * Raise a plan until its lowest floor clears the terrain under all of it.
 *
 * This is the module header's heightfield rule, made usable. A cave cannot be
 * subtracted from a `Physics` heightfield - the field is solid from its
 * surface down to `baseY` and a body inside it is shoved straight up - so the
 * cave has to sit on top and the rock around it has to be built. `lift` is
 * exactly how much plinth the host world owes this cave, and it is a number
 * worth looking at: a lift of 2 m is a cave in a hillock, a lift of 20 m is a
 * cave the site cannot carry.
 *
 * Called with the FINAL field, after the world's terrain is registered.
 *
 * @returns {{plan:object, lift:number, profile:object}} a NEW normalised plan
 */
export function liftToClear(plan, field, margin = 0.10) {
  const p = plan.cellById ? plan : normalisePlan(plan);
  /* Sampled on EXACTLY the lattice `auditGrounding` uses, not a coarser one.
   * At a 1 m pitch against the audit's 0.5 m this cleared the peaks it could
   * see and left nineteen buried columns between them, on a slope the eye
   * would call flat. Two probes of the same surface have to agree by
   * construction, not by luck. */
  const profile = terrainProfile(p, field, FLOOR_STEP);
  let lowest = Infinity;
  for (const c of p.cells) lowest = Math.min(lowest, c.floor);
  const want = profile.hi + margin - (p.origin.y + lowest);
  const lift = Math.max(0, want);
  if (lift === 0) return { plan: p, lift, profile };
  return {
    plan: normalisePlan({ ...p, origin: { ...p.origin, y: p.origin.y + lift } }),
    lift, profile,
  };
}

/** How far a plinth or apron box is sunk into the ground so nothing floats. */
export const PLINTH_BURY = 1.0;
/** Tread depth of a mouth apron, metres of ground covered per riser. */
export const APRON_RUN = 1.2;
/** Hard stop on an apron, so a badly sited mouth fails loudly rather than paving. */
export const APRON_MAX = 24;
/** Overlap between consecutive treads, so no probe can land between two boxes. */
export const APRON_LAP = 0.05;

/**
 * THE ROCK THE SITE OWES, BUILT. The other half of {@link liftToClear}.
 *
 * ── The defect this exists to end ─────────────────────────────────────────
 *
 * `liftToClear` raises a rigid plan until its floor clears the HIGHEST terrain
 * under the footprint, and until now nothing built the wedge that leaves. On a
 * site with relief the result is a stone box hovering in the air. Measured on
 * the shipped Sunken Hall (`origin (-56, 32.940, -281)`, yaw 0.40):
 *
 *   terrain under the footprint   lo 28.12  hi 32.84  relief 4.72
 *   floor slab                    32.04 .. 32.94
 *   air gap under the slab        0.10 m at best, 4.82 m at worst
 *
 * 3.1 m of daylight across a 38 x 32 m footprint, with a capsule-height void a
 * player can walk into. And the `throat` - the cave's only non-`+y` entrance -
 * had its sill 4.07 m over the ground one metre outside it, against a 0.45 m
 * step. Entry meant an unadvertised free-climb of the shell's outer face.
 *
 * Every audit stayed green because each of them floors ONE side.
 * `auditGrounding` reports `buried = 0, worst -0.10`, which says the floor is
 * never BELOW the terrain and says nothing about how far above it sits; and the
 * world's mouth test resolved `nodeFor(m.position + 0.5)`, which answers the
 * terrain node under the door - i.e. it is satisfied by the fact that you can
 * stand outside.
 *
 * ── What is built ─────────────────────────────────────────────────────────
 *
 * A PLINTH per cell: the cell footprint inflated by `ROCK_T` so it sits flush
 * with the outer face of the shell, from `PLINTH_BURY` under the lowest terrain
 * beneath it up to the underside of that cell's floor slab. A cell standing on
 * another cell is skipped, and that is done by SUBTRACTION rather than by a
 * flag - the karst chimney's floor is the hall's ceiling, and a plinth column
 * dropped under it would fill the hall. `subtractRects` is the same routine the
 * shell uses to cut its doorways, so the two cannot disagree about what
 * overlaps what.
 *
 * An APRON outside every non-`+y` mouth: treads stepping outward, each at most
 * `STEP_MAX` below the last, stopping as soon as the ground outside has risen
 * to within one riser of the current tread. A mouth whose sill is ALREADY
 * within a step of the ground gets nothing at all, which is why a well-sited
 * mouth costs zero boxes. The stop rule is what makes this work on both of the
 * shipped shapes at once: at the Quarry Adit the ground FALLS away from the
 * door and the apron is one tread; at the Sunken Hall it RISES away from the
 * door, and the apron is a short causeway out to where the flank comes back up
 * to sill height.
 *
 * Nothing here is inside a frame handler; the two locals below are per-call.
 *
 * @param {{box:Function, physics:object, track?:Function}} ctx as {@link buildCave}
 * @param {object} plan a LIFTED, normalised plan
 * @param {SolidField} field the terrain field the lift was measured against
 * @param {{bury?:number, run?:number}} [opts]
 * @returns {{colliders:Array, plinths:number, treads:number, gap:number, sills:Array,
 *   steps:Array}} `steps` are the apron treads and thresholds, for the host
 *   world to publish so a reach probe can see them.
 */
export function buildPlinth(ctx, plan, field, opts = {}) {
  const p = plan.cellById ? plan : normalisePlan(plan);
  const bury = opts.bury ?? PLINTH_BURY;
  const run = opts.run ?? APRON_RUN;
  const track = ctx.track ?? ((c) => c);
  const colliders = [];
  let plinths = 0;
  let treads = 0;
  let gap = 0;
  const sills = [];
  /** Apron treads and thresholds, in the shape `CitadelWorld._steps` holds. */
  const steps = [];

  /** One local-space solid, exactly as `buildCave` emits one. */
  const solid = (lx0, lx1, ly0, ly1, lz0, lz1, tint) => {
    const w = lx1 - lx0;
    const h = ly1 - ly0;
    const d = lz1 - lz0;
    if (w <= EPS || h <= EPS || d <= EPS) return null;
    const c = toWorld(p, (lx0 + lx1) * 0.5, (ly0 + ly1) * 0.5, (lz0 + lz1) * 0.5);
    ctx.box(MAT.rock, w, h, d, c.x, c.y, c.z, p.yaw, tint ?? 0x9c9080);
    colliders.push(track(ctx.physics.addRotatedBox(
      _v.set(c.x, c.y, c.z), _h.set(w * 0.5, h * 0.5, d * 0.5), p.yaw
    )));
    return { x: c.x, y: p.origin.y + ly1, z: c.z, w, d };
  };

  /** Lowest and highest terrain under a local-space rectangle. */
  const groundUnder = (x0, x1, z0, z1) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const lx of lattice(x0, x1, FLOOR_STEP)) {
      for (const lz of lattice(z0, z1, FLOOR_STEP)) {
        const w = toWorld(p, lx, 0, lz);
        const g = field.terrainAt(w.x, w.z);
        if (g === null) continue;
        if (g < lo) lo = g;
        if (g > hi) hi = g;
      }
    }
    return lo === Infinity ? null : { lo, hi };
  };

  /* ---- the plinth ---------------------------------------------------- */
  for (const cell of p.cells) {
    const rect = {
      a0: cell.x0 - ROCK_T, a1: cell.x1 + ROCK_T,
      b0: cell.z0 - ROCK_T, b1: cell.z1 + ROCK_T,
    };
    /* Holes are the BARE footprint of every cell that sits lower, not the
     * inflated one. The rect is inflated so the plinth reaches the outer face
     * of the shell; inflating the holes as well over-cuts by `ROCK_T` on every
     * side and leaves a void under the higher cell's own wall - measured, a
     * 1.1 m notch under the Quarry gallery's west wall. A cell's INTERIOR is
     * what a plinth must never fill, and the interior is the bare rect. */
    const holes = [];
    let stacked = false;
    for (const o of p.cells) {
      if (o === cell || o.floor >= cell.floor - EPS) continue;
      holes.push({ a0: o.x0, a1: o.x1, b0: o.z0, b1: o.z1 });
      if (o.x0 < cell.x1 && o.x1 > cell.x0 && o.z0 < cell.z1 && o.z1 > cell.z0) stacked = true;
    }
    /* Topped at the FLOOR and not at the slab's underside, so the `ROCK_T`
     * collar the inflation adds is a threshold a body steps out onto rather
     * than a 0.9 m notch between the doorway and the first tread. Inside the
     * cell the collar is simply the floor slab again - two solids in the same
     * place cost nothing and disagree about nothing. */
    const top = cell.floor;
    for (const r of subtractRects(rect, holes)) {
      const g = groundUnder(r.a0, r.a1, r.b0, r.b1);
      if (!g) continue;
      /* Reported daylight is measured to the SLAB, which is what a player could
       * have seen under - and only for a cell that stands on the GROUND. The
       * karst chimney's floor is the hall's ceiling; the 12 m between it and
       * the terrain is a room, not a hole. */
      const under = p.origin.y + cell.floor - ROCK_T;
      if (!stacked && under - g.hi > gap) gap = under - g.hi;
      const bottom = Math.min(g.lo, p.origin.y + top) - bury - p.origin.y;
      if (top - bottom <= EPS) continue;
      solid(r.a0, r.a1, bottom, top, r.b0, r.b1);
      plinths++;
    }
  }

  /* ---- one apron per walk-in mouth ----------------------------------- */
  for (const m of p.mouths) {
    const F = FACE_AXES[m.face];
    if (F.n === 'y') continue;
    const cell = p.cellById.get(m.cell);
    const sill = p.origin.y + cell.floor;
    /* Wide enough to walk onto off-centre, but never wider than the doorway
     * plus a shoulder: an apron the width of the whole face is a terrace. */
    const a0 = m.a0 - CAPSULE_R;
    const a1 = m.a1 + CAPSULE_R;
    const face = m.plane + F.s * ROCK_T;
    let top = sill;
    let built = 0;
    for (let i = 0; i < APRON_MAX; i++) {
      /* Each tread overlaps the one before it - and the first overlaps the
       * plinth collar - by `APRON_LAP`. Two boxes meeting on an exact plane is
       * a plane a probe can land on and be inside neither of them; the overlap
       * is always UNDER the higher of the two, so it costs nothing. */
      const near = face + F.s * (run * i - (i > 0 ? APRON_LAP : APRON_LAP));
      const far = face + F.s * (run * (i + 1));
      const n0 = Math.min(near, far);
      const n1 = Math.max(near, far);
      const g = F.n === 'x'
        ? groundUnder(n0, n1, a0, a1)
        : groundUnder(a0, a1, n0, n1);
      if (!g) break;
      /* The ground under this strip is already within one riser of the level
       * the last tread left us at, so there is nothing left to bridge. A
       * well-sited mouth breaks here on the first pass and costs no boxes.
       *
       * `lo` and not `hi`: a strip is a tread's WIDTH as well as its depth, and
       * stopping on the highest corner of it leaves the middle of the doorway
       * with a drop nothing measured. At the Quarry Adit, stopping on `hi` left
       * a 0.56 m step on the centre line while every corner was inside 0.45. */
      if (top - g.lo <= STEP_MAX) break;
      /* Exactly one riser down, every time. `top - g.lo > STEP_MAX` is what we
       * just tested, so the descent can never be pushed below the strip's own
       * lowest ground and cannot run away into a hillside. */
      top -= STEP_MAX;
      const bottom = Math.min(g.lo, top) - bury - p.origin.y;
      const lt = top - p.origin.y;
      const emitted = F.n === 'x'
        ? solid(n0, n1, bottom, lt, a0, a1, 0xa2907a)
        : solid(a0, a1, bottom, lt, n0, n1, 0xa2907a);
      /* PUBLISHED AS A TREAD, and that is not bookkeeping.
       *
       * `ReachGraph` darts a 6 m lattice and otherwise takes its nodes from
       * what the world publishes. An apron tread is 1.2 m of run, so an
       * unpublished one is invisible to the graph - and the graph then reports
       * the mouth as unreachable, because the pad under the doorway is now the
       * apron rather than the terrain node it used to find. The world's own
       * `_steps` array exists for exactly this, for exactly this reason, over
       * the region staircases. */
      if (emitted) steps.push({ ...emitted, rot: p.yaw, mouth: m.id });
      treads++;
      built++;
    }
    /* The threshold itself: the `ROCK_T` collar just outside the doorway, at
     * sill height. Without it the chain from the ground to the sill has no node
     * at the top and `nodeFor` answers the roof. */
    {
      const t = { x: 0, z: 0 };
      t[F.n] = m.plane + F.s * ROCK_T * 0.5;
      t[F.a] = (m.a0 + m.a1) * 0.5;
      const c = toWorld(p, t.x, 0, t.z);
      steps.push({
        x: c.x, y: sill, z: c.z,
        w: ROCK_T, d: m.a1 - m.a0, rot: p.yaw, mouth: m.id,
      });
    }
    sills.push({ id: m.id, sill, treads: built, foot: top });
  }

  return { colliders, plinths, treads, gap, sills, steps };
}

/**
 * Is the space this cave wants to occupy actually empty?
 *
 * A siting check, run BEFORE the cave is built, against the world as it
 * already stands. It exists because the first site this kit's suite chose was
 * chosen on terrain relief alone, and landed inside somebody else's quarry
 * gantries: the cave built perfectly, sealed perfectly, and reported two
 * room-spanning slabs, six illegal steps and a walled-up adit mouth - all of
 * them foreign colliders standing inside the chamber and across its doorway.
 * Every one of those is a real defect and every one of them is a siting
 * mistake, not a cave defect, and telling them apart afterwards costs an hour.
 *
 * `apron` also probes OUTSIDE every mouth, because a mouth with a wall a metre
 * in front of it is sealed just as thoroughly as a mouth with no hole in it,
 * and the seal audit cannot tell those apart either.
 *
 * @returns {{samples:number, occupied:number, mouthBlocked:number, first:object|null}}
 */
export function auditVacancy(plan, field, opts = {}) {
  const p = plan.cellById ? plan : normalisePlan(plan);
  const step = opts.step ?? 1.5;
  const apron = opts.apron ?? 4.0;
  let samples = 0;
  let occupied = 0;
  let mouthBlocked = 0;
  let first = null;

  for (const c of p.cells) {
    for (const lx of lattice(c.x0, c.x1, step)) {
      for (const lz of lattice(c.z0, c.z1, step)) {
        for (const ly of lattice(c.floor, c.ceil, step)) {
          const w = toWorld(p, lx, ly, lz);
          samples++;
          if (!field.solidAt(w.x, w.y, w.z)) continue;
          occupied++;
          if (!first) first = { cell: c.id, x: w.x, y: w.y, z: w.z };
        }
      }
    }
  }

  for (const m of p.mouths) {
    const F = FACE_AXES[m.face];
    for (const a of lattice(m.a0, m.a1, step)) {
      for (const b of lattice(m.b0, m.b1, step)) {
        for (let t = 0.3; t <= apron; t += step) {
          const q = {};
          q[F.n] = m.plane + F.s * t;
          q[F.a] = a;
          q[F.b] = b;
          const w = toWorld(p, q.x, q.y, q.z);
          samples++;
          if (!field.solidAt(w.x, w.y, w.z)) continue;
          mouthBlocked++;
          if (!first) first = { mouth: m.id, x: w.x, y: w.y, z: w.z };
        }
      }
    }
  }
  return { samples, occupied, mouthBlocked, first };
}

/**
 * Is there 1.8 m of clear air over every mantle ledge?
 *
 * A targeted probe, and it exists because the general one cannot see this.
 * {@link walkGraph} samples on a {@link FLOOR_STEP} lattice, and a lattice at
 * 0.5 m cannot see an obstacle 0.36 m wide - which is exactly the width of a
 * torch bracket. Put a bracket over a ledge and the ledge's headroom drops to
 * 1.1 m, the ledge stops being walkable, the climb stops being a climb, and
 * the clearance audit reports nothing at all because no sample landed on the
 * bracket.
 *
 * So every authored ledge is probed at its own centre and its four quarter
 * points, whatever the lattice happens to do. The same limitation applies to
 * any authored feature narrower than the lattice; this covers the ledges
 * because a ledge failing silently costs a route.
 *
 * @returns {Array<{ledge:object, head:number}>} the ones with too little air
 */
export function auditLedges(plan, field, need = HEADROOM) {
  const bad = [];
  for (const l of plan.ledges) {
    let worst = Infinity;
    for (const [fx, fz] of [[0, 0], [-0.5, 0], [0.5, 0], [0, -0.5], [0, 0.5]]) {
      const w = toWorld(plan, l.x + fx * l.hx, 0, l.z + fz * l.hz);
      const col = field.column(w.x, w.z);
      const top = plan.origin.y + l.top;
      let head = Infinity;
      for (const iv of col) {
        if (iv.bot < top + 0.02) continue;
        head = iv.bot - top;
        break;
      }
      if (head < worst) worst = head;
    }
    if (worst < need) bad.push({ ledge: l, head: worst });
  }
  return bad;
}
